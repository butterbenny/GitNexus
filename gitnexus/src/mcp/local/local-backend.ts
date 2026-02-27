/**
 * Local Backend (Multi-Repo)
 * 
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * KuzuDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { initKuzu, executeQuery, closeKuzu, isKuzuReady } from '../core/kuzu-adapter.js';
import { embedQuery, getEmbeddingDims, disposeEmbedder } from '../core/embedder.js';
import { isGitRepo, getCurrentCommit } from '../../storage/git.js';
import {
  getGlobalRegistryPath,
  listRegisteredRepos,
  type RegistryEntry,
} from '../../storage/repo-manager.js';
import { buildArchetypeReport, computeProcessArchetype, deriveLayerTag, type ArchetypeExample, type ArchetypeReport, type HttpEdgeInfo, type ProcessTraceInfo } from '../../core/derived/archetypes.js';
// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

/**
 * Quick test-file detection for filtering impact results.
 * Matches common test file patterns across all supported languages.
 */
function isTestFilePath(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    p.includes('.test.') || p.includes('.spec.') ||
    p.startsWith('__tests__/') || p.includes('/__tests__/') ||
    p.startsWith('__mocks__/') || p.includes('/__mocks__/') ||
    p.startsWith('test/') || p.includes('/test/') ||
    p.startsWith('tests/') || p.includes('/tests/') ||
    p.startsWith('testing/') || p.includes('/testing/') ||
    p.startsWith('fixtures/') || p.includes('/fixtures/') ||
    p.endsWith('_test.go') || p.endsWith('_test.py') ||
    p.includes('/test_') || p.includes('/conftest.')
  );
}

/** Valid KuzuDB node labels for safe Cypher query construction */
const VALID_NODE_LABELS = new Set([
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement',
  'Community', 'Process', 'Struct', 'Enum', 'Macro', 'Typedef', 'Union',
  'Namespace', 'Trait', 'Impl', 'TypeAlias', 'Const', 'Static', 'Property',
  'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module',
]);

export interface CodebaseContext {
  projectName: string;
  stats: {
    fileCount: number;
    functionCount: number;
    communityCount: number;
    processCount: number;
  };
}

interface RepoHandle {
  id: string;          // unique key = repo name (basename)
  name: string;
  repoPath: string;
  storagePath: string;
  kuzuPath: string;
  indexedAt: string;
  lastCommit: string;
  stats?: RegistryEntry['stats'];
}

type IndexStatus = {
  indexedAt: string;
  indexedCommit: string;
  headCommit: string | null;
  isStale: boolean;
  refreshCommand: string;
  refreshCommandForce: string;
  /**
   * Sandbox-friendly refresh command (avoids writing to ~/.gitnexus and avoids hooks).
   * Safe when HOME is read-only.
   */
  refreshCommandSandbox: string;
  refreshCommandSandboxForce: string;
};

export class LocalBackend {
  private repos: Map<string, RepoHandle> = new Map();
  private contextCache: Map<string, CodebaseContext> = new Map();
  private initializedRepos: Set<string> = new Set();
  private registryMtimeMs: number | null = null;
  private indexStatusCache: Map<string, { checkedAtMs: number; status: IndexStatus }> = new Map();
  private repoMetaMtimeMs: Map<string, number> = new Map();
  private repoMetaCheckedAtMs: Map<string, number> = new Map();
  private archetypeIndexCache: Map<string, { builtAtMs: number; minHttpConfidence: number; byProcessId: Map<string, { signature: string; example: ArchetypeExample }>; bySignature: Map<string, ArchetypeExample[]> }> = new Map();

  // ─── Initialization ──────────────────────────────────────────────

  /**
   * Initialize from the global registry.
   * Returns true if at least one repo is available.
   */
  async init(): Promise<boolean> {
    const entries = await listRegisteredRepos({ validate: true });

    this.syncFromRegistryEntries(entries);
    this.registryMtimeMs = await this.getRegistryMtimeMs();
    return this.repos.size > 0;
  }

  private async getRegistryMtimeMs(): Promise<number | null> {
    try {
      const stat = await fs.stat(getGlobalRegistryPath());
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Reload repo handles + lightweight context from the global registry.
   * Used to keep MCP tool/resources metadata consistent after `gitnexus analyze`
   * runs in a separate process.
   */
  async refreshFromRegistryIfNeeded(): Promise<void> {
    const mtimeMs = await this.getRegistryMtimeMs();
    if (mtimeMs === null) return;
    if (this.registryMtimeMs === mtimeMs) return;

    // Index was rebuilt in another process. Close Kuzu pools so subsequent
    // queries reopen against the refreshed on-disk database.
    await closeKuzu();
    this.initializedRepos.clear();

    const entries = await listRegisteredRepos({ validate: true });
    this.syncFromRegistryEntries(entries);
    this.registryMtimeMs = mtimeMs;
  }

  private syncFromRegistryEntries(entries: RegistryEntry[]): void {
    this.repos.clear();
    this.contextCache.clear();
    this.indexStatusCache.clear();
    this.repoMetaMtimeMs.clear();
    this.repoMetaCheckedAtMs.clear();
    this.archetypeIndexCache.clear();

    for (const entry of entries) {
      const id = this.repoId(entry.name, entry.path, this.repos);
      const storagePath = entry.storagePath;
      const kuzuPath = path.join(storagePath, 'kuzu');

      const handle: RepoHandle = {
        id,
        name: entry.name,
        repoPath: entry.path,
        storagePath,
        kuzuPath,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
        stats: entry.stats,
      };

      this.repos.set(id, handle);

      // Build lightweight context (no KuzuDB needed)
      const s = entry.stats || {};
      this.contextCache.set(id, {
        projectName: entry.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });
    }
  }

  /**
   * Generate a stable repo ID from name + path.
   * If names collide, append a hash of the path.
   */
  private repoId(name: string, repoPath: string, existing?: Map<string, RepoHandle>): string {
    const base = name.toLowerCase();
    const repos = existing ?? this.repos;
    // Check for name collision with a different path
    for (const [id, handle] of repos) {
      if (id === base && handle.repoPath !== path.resolve(repoPath)) {
        // Collision — use path hash
        const hash = Buffer.from(repoPath).toString('base64url').slice(0, 6);
        return `${base}-${hash}`;
      }
    }
    return base;
  }

  // ─── Repo Resolution ─────────────────────────────────────────────

  /**
   * Resolve which repo to use.
   * - If repoParam is given, match by name or path
   * - If only 1 repo, use it
   * - If 0 or multiple without param, throw with helpful message
   */
  resolveRepo(repoParam?: string): RepoHandle {
    if (this.repos.size === 0) {
      throw new Error('No indexed repositories. Run: gitnexus analyze');
    }

    if (repoParam) {
      const paramLower = repoParam.toLowerCase();
      // Match by id
      if (this.repos.has(paramLower)) return this.repos.get(paramLower)!;
      // Match by name (case-insensitive)
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase() === paramLower) return handle;
      }
      // Match by path (substring)
      const resolved = path.resolve(repoParam);
      for (const handle of this.repos.values()) {
        if (handle.repoPath === resolved) return handle;
      }
      // Match by partial name
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase().includes(paramLower)) return handle;
      }

      const names = [...this.repos.values()].map(h => h.name);
      throw new Error(`Repository "${repoParam}" not found. Available: ${names.join(', ')}`);
    }

    if (this.repos.size === 1) {
      return this.repos.values().next().value!;
    }

    const names = [...this.repos.values()].map(h => h.name);
    throw new Error(
      `Multiple repositories indexed. Specify which one with the "repo" parameter. Available: ${names.join(', ')}`
    );
  }

  // ─── Lazy KuzuDB Init ────────────────────────────────────────────

  private async ensureInitialized(repoId: string): Promise<void> {
    // Always check the actual pool — the idle timer may have evicted the connection
    if (this.initializedRepos.has(repoId) && isKuzuReady(repoId)) return;

    const handle = this.repos.get(repoId);
    if (!handle) throw new Error(`Unknown repo: ${repoId}`);

    try {
      await initKuzu(repoId, handle.kuzuPath);
      this.initializedRepos.add(repoId);
    } catch (err: any) {
      // If lock error, mark as not initialized so next call retries
      this.initializedRepos.delete(repoId);
      throw err;
    }
  }

  // ─── Public Getters ──────────────────────────────────────────────

  /**
   * Get context for a specific repo (or the single repo if only one).
   */
  getContext(repoId?: string): CodebaseContext | null {
    if (repoId && this.contextCache.has(repoId)) {
      return this.contextCache.get(repoId)!;
    }
    if (this.repos.size === 1) {
      return this.contextCache.values().next().value ?? null;
    }
    return null;
  }

  /**
   * List all registered repos with their metadata.
   */
  listRepos(): Array<{ name: string; path: string; indexedAt: string; lastCommit: string; stats?: any }> {
    return [...this.repos.values()].map(h => ({
      name: h.name,
      path: h.repoPath,
      indexedAt: h.indexedAt,
      lastCommit: h.lastCommit,
      stats: h.stats,
    }));
  }

  private getCliPath(): string {
    // local-backend.js lives at dist/mcp/local/local-backend.js in the installed package.
    // Resolve dist/cli/index.js relative to it so callers don't need npx.
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '../../cli/index.js');
  }

  private async getIndexStatus(repo: RepoHandle): Promise<IndexStatus> {
    const cached = this.indexStatusCache.get(repo.id);
    const now = Date.now();
    if (cached && now - cached.checkedAtMs < 2000) return cached.status;

    const headCommit = isGitRepo(repo.repoPath) ? (getCurrentCommit(repo.repoPath) || null) : null;
    const indexedCommit = repo.lastCommit || '';
    const isStale = !!headCommit && !!indexedCommit && headCommit !== indexedCommit;

    const cliPath = this.getCliPath();
    const refreshCommand = `node ${JSON.stringify(cliPath)} analyze ${JSON.stringify(repo.repoPath)} --skip-embeddings`;
    const refreshCommandForce = `${refreshCommand} --force`;
    const refreshCommandSandbox = `${refreshCommand} --no-registry --no-hooks`;
    const refreshCommandSandboxForce = `${refreshCommandSandbox} --force`;

    const status: IndexStatus = {
      indexedAt: repo.indexedAt,
      indexedCommit,
      headCommit,
      isStale,
      refreshCommand,
      refreshCommandForce,
      refreshCommandSandbox,
      refreshCommandSandboxForce,
    };

    this.indexStatusCache.set(repo.id, { checkedAtMs: now, status });
    return status;
  }

  /**
   * Reload a repo handle from .gitnexus/meta.json when it changes on disk,
   * even if the global registry did not change.
   *
   * This is critical for sandboxed refreshes that run:
   *   gitnexus analyze --no-registry
   *
   * because LocalBackend traditionally only refreshed when ~/.gitnexus/registry.json
   * mtime changed. With this, agents can refresh deterministically without HOME writes.
   */
  private async refreshRepoMetaIfNeeded(repo: RepoHandle): Promise<void> {
    const now = Date.now();
    const lastCheckedAt = this.repoMetaCheckedAtMs.get(repo.id) ?? 0;
    if (now - lastCheckedAt < 2000) return;
    this.repoMetaCheckedAtMs.set(repo.id, now);

    const metaPath = path.join(repo.storagePath, 'meta.json');
    let mtimeMs: number;
    try {
      const stat = await fs.stat(metaPath);
      mtimeMs = stat.mtimeMs;
    } catch {
      return;
    }

    const prev = this.repoMetaMtimeMs.get(repo.id);
    if (prev !== undefined && Math.abs(prev - mtimeMs) < 0.5) return;
    this.repoMetaMtimeMs.set(repo.id, mtimeMs);

    // Index was rebuilt in another process. Close Kuzu pools so subsequent
    // queries reopen against the refreshed on-disk database.
    await closeKuzu();
    this.initializedRepos.clear();
    this.indexStatusCache.delete(repo.id);
    this.archetypeIndexCache.delete(repo.id);

    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as any;

      repo.indexedAt = String(meta.indexedAt || repo.indexedAt || '');
      repo.lastCommit = String(meta.lastCommit || repo.lastCommit || '');
      repo.stats = meta.stats || repo.stats;

      const s = repo.stats || {};
      this.contextCache.set(repo.id, {
        projectName: repo.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });
    } catch {
      // Ignore transient parse/read errors. We'll re-check on next call.
    }
  }

  // ─── Tool Dispatch ───────────────────────────────────────────────

  async callTool(method: string, params: any): Promise<any> {
    await this.refreshFromRegistryIfNeeded();

    if (method === 'list_repos') {
      return this.listRepos();
    }

    // Resolve repo from optional param
    const repo = this.resolveRepo(params?.repo);
    await this.refreshRepoMetaIfNeeded(repo);
    const indexStatus = await this.getIndexStatus(repo);

    let result: any;
    switch (method) {
      case 'query':
        result = await this.query(repo, params);
        break;
      case 'action_plan':
        result = await this.actionPlan(repo, params);
        break;
      case 'archetypes':
        result = await this.archetypes(repo, params);
        break;
      case 'precedents':
        result = await this.precedents(repo, params);
        break;
      case 'cypher':
        result = await this.cypher(repo, params);
        break;
      case 'context':
        result = await this.context(repo, params);
        break;
      case 'impact':
        result = await this.impact(repo, params);
        break;
      case 'detect_changes':
        result = await this.detectChanges(repo, params);
        break;
      case 'rename':
        result = await this.rename(repo, params);
        break;
      // Legacy aliases for backwards compatibility
      case 'search':
        result = await this.query(repo, params);
        break;
      case 'explore':
        result = await this.context(repo, { name: params?.name, ...params });
        break;
      case 'overview':
        result = await this.overview(repo, params);
        break;
      default:
        throw new Error(`Unknown tool: ${method}`);
    }

    if (indexStatus.isStale && result && typeof result === 'object' && !Array.isArray(result)) {
      result.index_status = indexStatus;
    }

    return result;
  }

  private async archetypes(repo: RepoHandle, params: {
    limit?: number;
    examples?: number;
    min_http_confidence?: number;
    repo?: string;
  }): Promise<{ report: ArchetypeReport }> {
    return this.queryArchetypes(repo.id, {
      limit: params.limit,
      examplesPerSignature: params.examples,
      minHttpConfidence: params.min_http_confidence,
    });
  }

  private async ensureArchetypeIndex(repo: RepoHandle, minHttpConfidence = 0.9): Promise<{ byProcessId: Map<string, { signature: string; example: ArchetypeExample }>; bySignature: Map<string, ArchetypeExample[]> }> {
    const cached = this.archetypeIndexCache.get(repo.id);
    const now = Date.now();
    if (cached && cached.minHttpConfidence === minHttpConfidence && now - cached.builtAtMs < 15000) {
      return { byProcessId: cached.byProcessId, bySignature: cached.bySignature };
    }

    await this.ensureInitialized(repo.id);

    const stepRows = await executeQuery(repo.id, `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
      RETURN p.id AS processId,
             p.label AS label,
             p.heuristicLabel AS heuristicLabel,
             p.processType AS processType,
             p.stepCount AS stepCount,
             s.id AS nodeId,
             s.name AS name,
             s.filePath AS filePath,
             labels(s) AS type,
             r.step AS step
      ORDER BY processId, step
    `);

    const processesById = new Map<string, ProcessTraceInfo>();
    for (const row of stepRows) {
      const processId = row.processId || row[0];
      let proc = processesById.get(processId);
      if (!proc) {
        proc = {
          id: processId,
          label: row.label || row[1] || processId,
          heuristicLabel: row.heuristicLabel || row[2] || row.label || row[1] || processId,
          processType: row.processType || row[3] || '',
          stepCount: row.stepCount || row[4] || 0,
          steps: [],
        };
        processesById.set(processId, proc);
      }

      proc.steps.push({
        step: row.step || row[9] || 0,
        nodeId: row.nodeId || row[5],
        name: row.name || row[6] || '',
        filePath: row.filePath || row[7] || '',
        type: row.type || row[8] || '',
      });
    }

    for (const proc of processesById.values()) {
      proc.steps.sort((a, b) => a.step - b.step);
      if (!proc.stepCount) proc.stepCount = proc.steps.length;
    }

    const httpRows = await executeQuery(repo.id, `
      MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b)
      WHERE r.reason STARTS WITH 'http-' AND r.confidence >= ${minHttpConfidence}
      RETURN a.id AS sourceId, b.id AS targetId, r.reason AS reason, r.confidence AS confidence
    `);

    const httpEdges: HttpEdgeInfo[] = httpRows.map((r: any) => ({
      sourceId: r.sourceId || r[0],
      targetId: r.targetId || r[1],
      reason: r.reason || r[2],
      confidence: r.confidence || r[3] || 1.0,
    }));

    const byProcessId = new Map<string, { signature: string; example: ArchetypeExample }>();
    const bySignature = new Map<string, ArchetypeExample[]>();

    for (const proc of processesById.values()) {
      const archetype = computeProcessArchetype(proc, httpEdges, { minHttpConfidence });
      if (!archetype) continue;

      const entry = proc.steps[0];
      const terminal = proc.steps.at(-1) || proc.steps[0];
      const example: ArchetypeExample = {
        processId: proc.id,
        label: proc.heuristicLabel || proc.label || proc.id,
        stepCount: proc.stepCount || proc.steps.length,
        entry: { name: entry?.name || '', filePath: entry?.filePath || '', type: entry?.type || '' },
        terminal: { name: terminal?.name || '', filePath: terminal?.filePath || '', type: terminal?.type || '' },
        httpRoutes: archetype.httpRoutes,
      };

      byProcessId.set(proc.id, { signature: archetype.signature, example });
      const list = bySignature.get(archetype.signature) || [];
      list.push(example);
      bySignature.set(archetype.signature, list);
    }

    for (const list of bySignature.values()) {
      list.sort((a, b) => (b.stepCount || 0) - (a.stepCount || 0) || String(a.processId).localeCompare(String(b.processId)));
    }

    this.archetypeIndexCache.set(repo.id, { builtAtMs: now, minHttpConfidence, byProcessId, bySignature });
    return { byProcessId, bySignature };
  }

  private async precedents(repo: RepoHandle, params: {
    query: string;
    anchor_uid?: string;
    limit?: number;
    examples?: number;
    min_http_confidence?: number;
    repo?: string;
  }): Promise<any> {
    const queryText = String(params.query || '').trim();
    const anchorUid = String(params.anchor_uid || '').trim();
    if (!queryText && !anchorUid) {
      return { error: 'query parameter is required and cannot be empty.' };
    }

    const limit = Math.max(1, Math.min(5, params.limit ?? 2));
    const examplesPer = Math.max(1, Math.min(5, params.examples ?? 3));
    const minHttpConfidence = params.min_http_confidence ?? 0.9;

    const index = await this.ensureArchetypeIndex(repo, minHttpConfidence);

    const seenProcess = new Set<string>();
    const processPrecedents: any[] = [];

    const addProcessPrecedent = (processId: string): void => {
      if (!processId || typeof processId !== 'string') return;
      if (seenProcess.has(processId)) return;
      seenProcess.add(processId);

      const info = index.byProcessId.get(processId);
      if (!info) return;

      const signature = info.signature;
      const all = index.bySignature.get(signature) || [];
      const examples = all
        .filter(p => p.processId !== processId)
        .slice(0, examplesPer);

      processPrecedents.push({
        kind: 'process',
        signature,
        anchor: info.example,
        examples: examples.length > 0 ? examples : all.slice(0, examplesPer),
      });
    };

    const parseHttpReason = (reason: string): { verb: string; path: string } | null => {
      const trimmed = String(reason || '').trim();
      const match = /^http-([a-z]+):(.*)$/i.exec(trimmed);
      if (!match) return null;
      const verb = String(match[1] || '').toLowerCase();
      const path = String(match[2] || '');
      if (!verb || !path) return null;
      return { verb, path };
    };

    const extractLastLiteralSegment = (pathLike: string): string | null => {
      const path = String(pathLike || '').trim();
      if (!path) return null;
      const segments = path.split('/').filter(Boolean);
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (!seg) continue;
        if (seg === '*' || seg.includes('*')) continue;
        return seg.toLowerCase();
      }
      return null;
    };

    const getQueryTokens = (text: string): string[] => {
      return String(text || '')
        .toLowerCase()
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length >= 3)
        .slice(0, 12);
    };

    const reduceHopForOutput = (hop: any): any => {
      if (!hop || typeof hop !== 'object') return null;
      const out: any = {
        http: hop.http,
        ui: hop.ui,
        endpoint: hop.endpoint,
        controller: hop.controller,
      };

      if (Array.isArray(hop.permissions)) {
        out.permissions = hop.permissions.map((p: any) => ({
          permission: p?.permission,
          roles: Array.isArray(p?.roles) ? p.roles.slice(0, 5) : [],
          evidence: p?.evidence,
        }));
      }

      if (hop.endpoint_wiring) out.endpoint_wiring = hop.endpoint_wiring;
      return out;
    };

    const buildHopSignature = (hop: any): string | null => {
      const httpReason = String(hop?.http?.reason || '').trim();
      const parsed = parseHttpReason(httpReason);
      if (!parsed) return null;
      const verb = parsed.verb.toUpperCase();

      const uiTag = deriveLayerTag(String(hop?.ui?.filePath || ''));
      const controllerTag = deriveLayerTag(String(hop?.controller?.filePath || ''));
      const permSlug = String(hop?.permissions?.[0]?.permission?.slug || '').trim();

      const permToken = permSlug ? ` → Perm:${permSlug}` : '';
      return `${uiTag} → HTTP:${verb} → ${controllerTag}${permToken}`;
    };

    const rankHop = (hop: any, tokens: string[]): number => {
      if (!hop || typeof hop !== 'object') return 0;
      const reason = String(hop?.http?.reason || '').toLowerCase();
      const uiName = String(hop?.ui?.name || '').toLowerCase();
      const endpointName = String(hop?.endpoint?.name || '').toLowerCase();
      const controllerName = String(hop?.controller?.name || '').toLowerCase();
      const controllerPath = String(hop?.controller?.filePath || '').toLowerCase();
      const uiPath = String(hop?.ui?.filePath || '').toLowerCase();
      const permSlug = String(hop?.permissions?.[0]?.permission?.slug || '').toLowerCase();

      const hay = `${reason} ${uiName} ${endpointName} ${controllerName} ${controllerPath} ${uiPath} ${permSlug}`;
      let score = 0;
      for (const t of tokens) {
        if (!t) continue;
        if (hay.includes(t)) score += 1;
        if (reason.includes(t)) score += 2; // HTTP reason match is highest-signal for hop selection
        if (permSlug === t) score += 1;
      }
      return score;
    };

    const findHopExamples = async (anchorHop: any): Promise<any[]> => {
      const httpReason = String(anchorHop?.http?.reason || '').trim();
      const parsed = parseHttpReason(httpReason);
      if (!parsed) return [];

      const verbPrefix = `http-${parsed.verb.toLowerCase()}:`;
      const tail = extractLastLiteralSegment(parsed.path);

      const uiTag = deriveLayerTag(String(anchorHop?.ui?.filePath || ''));
      const uiPathClause = (() => {
        if (uiTag === 'FE:Api') return "ui.filePath CONTAINS '/src/api/'";
        if (uiTag === 'FE:Hook') return "(ui.filePath CONTAINS '/src/hooks/' OR ui.filePath CONTAINS '/src/customHooks/')";
        if (uiTag === 'FE:Page') return "ui.filePath CONTAINS '/src/pages/'";
        return "ui.filePath STARTS WITH 'apps/'";
      })();

      const reasonPrefixEsc = verbPrefix.replace(/'/g, "''");
      const tailEsc = tail ? tail.replace(/'/g, "''") : null;

      const whereParts = [
        `r.confidence >= ${minHttpConfidence}`,
        `r.reason STARTS WITH '${reasonPrefixEsc}'`,
        `e.name STARTS WITH 'endpoint:'`,
        uiPathClause,
      ];
      if (tailEsc) {
        whereParts.push(`r.reason ENDS WITH '/${tailEsc}'`);
      }

      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui)-[r:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE ${whereParts.join(' AND ')}
          MATCH (e)-[w:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE w.confidence >= ${minHttpConfidence} AND w.reason STARTS WITH 'laravel-endpoint:'
          RETURN ui.id AS uiUid, ui.name AS uiName, ui.filePath AS uiFilePath, ui.startLine AS uiStartLine,
                 e.id AS endpointUid, e.name AS endpointName, e.filePath AS endpointFilePath, e.startLine AS endpointStartLine,
                 c.id AS controllerUid, c.name AS controllerName, c.filePath AS controllerFilePath, c.startLine AS controllerStartLine,
                 r.reason AS reason, r.confidence AS confidence,
                 w.reason AS wiringReason, w.confidence AS wiringConfidence
          ORDER BY r.confidence DESC
          LIMIT 250
        `);
      } catch {
        return [];
      }

      const anchorKey = `${String(anchorHop?.ui?.uid || '')}|${String(anchorHop?.endpoint?.uid || '')}|${String(anchorHop?.controller?.uid || '')}|${httpReason}`;
      const seen = new Set<string>();
      const out: any[] = [];

      for (const row of rows) {
        const uiUid = row.uiUid || row[0];
        const endpointUid = row.endpointUid || row[4];
        const controllerUid = row.controllerUid || row[8];
        const reason = row.reason || row[12];
        if (!uiUid || !endpointUid || !controllerUid || !reason) continue;

        const key = `${uiUid}|${endpointUid}|${controllerUid}|${reason}`;
        if (key === anchorKey) continue;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          http: { reason: String(reason), confidence: Number(row.confidence ?? row[13] ?? 1.0) },
          endpoint_wiring: {
            reason: String(row.wiringReason || row[14] || ''),
            confidence: Number(row.wiringConfidence ?? row[15] ?? 1.0),
          },
          ui: {
            uid: String(uiUid),
            name: String(row.uiName || row[1] || ''),
            kind: String(uiUid).split(':')[0],
            filePath: String(row.uiFilePath || row[2] || ''),
            startLine: Number(row.uiStartLine ?? row[3] ?? 0) || undefined,
          },
          endpoint: {
            uid: String(endpointUid),
            name: String(row.endpointName || row[5] || ''),
            kind: String(endpointUid).split(':')[0],
            filePath: String(row.endpointFilePath || row[6] || ''),
            startLine: Number(row.endpointStartLine ?? row[7] ?? 0) || undefined,
          },
          controller: {
            uid: String(controllerUid),
            name: String(row.controllerName || row[9] || ''),
            kind: String(controllerUid).split(':')[0],
            filePath: String(row.controllerFilePath || row[10] || ''),
            startLine: Number(row.controllerStartLine ?? row[11] ?? 0) || undefined,
          },
        });

        if (out.length >= examplesPer) break;
      }

      return out;
    };

    const buildHopPrecedents = async (hops: any[]): Promise<any[]> => {
      const tokens = getQueryTokens(queryText);
      const ranked = hops
        .map(h => ({ h, score: rankHop(h, tokens) }))
        .sort((a, b) => b.score - a.score)
        .map(x => x.h)
        .slice(0, limit);

      const out: any[] = [];
      const seenSig = new Set<string>();

      for (const hop of ranked) {
        const signature = buildHopSignature(hop);
        if (!signature || seenSig.has(signature)) continue;
        seenSig.add(signature);

        const examples = await findHopExamples(hop);
        out.push({
          kind: 'hop',
          signature,
          anchor: reduceHopForOutput(hop),
          examples,
        });

        if (out.length >= limit) break;
      }

      return out;
    };

    const findProcessesForUid = async (uid: string, maxCount: number): Promise<string[]> => {
      const escaped = uid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (n {id: '${escaped}'})-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid
          LIMIT ${Math.max(1, Math.min(25, maxCount))}
        `);
      } catch {
        return [];
      }
      return rows.map(r => r.pid || r[0]).filter((x: any): x is string => typeof x === 'string' && x.length > 0);
    };

    const findHopsForUid = async (uid: string, maxCount: number): Promise<any[]> => {
      const escaped = uid.replace(/'/g, "''");
      const limitSql = Math.max(1, Math.min(25, maxCount));
      const out: any[] = [];
      const seen = new Set<string>();

      const push = (hop: any) => {
        const httpReason = String(hop?.http?.reason || '');
        const key = `${String(hop?.ui?.uid || '')}|${String(hop?.endpoint?.uid || '')}|${String(hop?.controller?.uid || '')}|${httpReason}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(hop);
      };

      // 1) uid is UI function/method
      try {
        const rows = await executeQuery(repo.id, `
          MATCH (ui {id: '${escaped}'})-[r:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE r.confidence >= ${minHttpConfidence} AND r.reason STARTS WITH 'http-' AND e.name STARTS WITH 'endpoint:'
          MATCH (e)-[w:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE w.confidence >= ${minHttpConfidence} AND w.reason STARTS WITH 'laravel-endpoint:'
          RETURN r.reason AS reason, r.confidence AS confidence,
                 w.reason AS wiringReason, w.confidence AS wiringConfidence,
                 e.id AS endpointUid, e.name AS endpointName, e.filePath AS endpointFilePath, e.startLine AS endpointStartLine,
                 c.id AS controllerUid, c.name AS controllerName, c.filePath AS controllerFilePath, c.startLine AS controllerStartLine,
                 ui.id AS uiUid, ui.name AS uiName, ui.filePath AS uiFilePath, ui.startLine AS uiStartLine
          ORDER BY r.confidence DESC
          LIMIT ${limitSql}
        `);

        for (const row of rows) {
          push({
            http: { reason: String(row.reason || row[0] || ''), confidence: Number(row.confidence ?? row[1] ?? 1.0) },
            endpoint_wiring: { reason: String(row.wiringReason || row[2] || ''), confidence: Number(row.wiringConfidence ?? row[3] ?? 1.0) },
            ui: { uid: String(row.uiUid || row[12] || ''), name: String(row.uiName || row[13] || ''), kind: String(row.uiUid || row[12] || '').split(':')[0], filePath: String(row.uiFilePath || row[14] || ''), startLine: row.uiStartLine ?? row[15] },
            endpoint: { uid: String(row.endpointUid || row[4] || ''), name: String(row.endpointName || row[5] || ''), kind: 'CodeElement', filePath: String(row.endpointFilePath || row[6] || ''), startLine: row.endpointStartLine ?? row[7] },
            controller: { uid: String(row.controllerUid || row[8] || ''), name: String(row.controllerName || row[9] || ''), kind: 'Method', filePath: String(row.controllerFilePath || row[10] || ''), startLine: row.controllerStartLine ?? row[11] },
          });
          if (out.length >= limit) return out;
        }
      } catch { /* ignore */ }

      // 2) uid is endpoint CodeElement
      try {
        const rows = await executeQuery(repo.id, `
          MATCH (ui)-[r:CodeRelation {type: 'CALLS'}]->(e:CodeElement {id: '${escaped}'})
          WHERE r.confidence >= ${minHttpConfidence} AND r.reason STARTS WITH 'http-' AND e.name STARTS WITH 'endpoint:'
          MATCH (e)-[w:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE w.confidence >= ${minHttpConfidence} AND w.reason STARTS WITH 'laravel-endpoint:'
          RETURN r.reason AS reason, r.confidence AS confidence,
                 w.reason AS wiringReason, w.confidence AS wiringConfidence,
                 e.id AS endpointUid, e.name AS endpointName, e.filePath AS endpointFilePath, e.startLine AS endpointStartLine,
                 c.id AS controllerUid, c.name AS controllerName, c.filePath AS controllerFilePath, c.startLine AS controllerStartLine,
                 ui.id AS uiUid, ui.name AS uiName, ui.filePath AS uiFilePath, ui.startLine AS uiStartLine
          ORDER BY r.confidence DESC
          LIMIT ${limitSql}
        `);

        for (const row of rows) {
          push({
            http: { reason: String(row.reason || row[0] || ''), confidence: Number(row.confidence ?? row[1] ?? 1.0) },
            endpoint_wiring: { reason: String(row.wiringReason || row[2] || ''), confidence: Number(row.wiringConfidence ?? row[3] ?? 1.0) },
            ui: { uid: String(row.uiUid || row[12] || ''), name: String(row.uiName || row[13] || ''), kind: String(row.uiUid || row[12] || '').split(':')[0], filePath: String(row.uiFilePath || row[14] || ''), startLine: row.uiStartLine ?? row[15] },
            endpoint: { uid: String(row.endpointUid || row[4] || ''), name: String(row.endpointName || row[5] || ''), kind: 'CodeElement', filePath: String(row.endpointFilePath || row[6] || ''), startLine: row.endpointStartLine ?? row[7] },
            controller: { uid: String(row.controllerUid || row[8] || ''), name: String(row.controllerName || row[9] || ''), kind: 'Method', filePath: String(row.controllerFilePath || row[10] || ''), startLine: row.controllerStartLine ?? row[11] },
          });
          if (out.length >= limit) return out;
        }
      } catch { /* ignore */ }

      // 3) uid is controller Method
      try {
        const rows = await executeQuery(repo.id, `
          MATCH (ui)-[r:CodeRelation {type: 'CALLS'}]->(c:Method {id: '${escaped}'})
          WHERE r.confidence >= ${minHttpConfidence} AND r.reason STARTS WITH 'http-'
          MATCH (ui)-[x:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE x.reason = r.reason AND x.confidence >= ${minHttpConfidence} AND e.name STARTS WITH 'endpoint:'
          MATCH (e)-[w:CodeRelation {type: 'CALLS'}]->(c)
          WHERE w.confidence >= ${minHttpConfidence} AND w.reason STARTS WITH 'laravel-endpoint:'
          RETURN r.reason AS reason, r.confidence AS confidence,
                 w.reason AS wiringReason, w.confidence AS wiringConfidence,
                 e.id AS endpointUid, e.name AS endpointName, e.filePath AS endpointFilePath, e.startLine AS endpointStartLine,
                 c.id AS controllerUid, c.name AS controllerName, c.filePath AS controllerFilePath, c.startLine AS controllerStartLine,
                 ui.id AS uiUid, ui.name AS uiName, ui.filePath AS uiFilePath, ui.startLine AS uiStartLine
          ORDER BY r.confidence DESC
          LIMIT ${limitSql}
        `);

        for (const row of rows) {
          push({
            http: { reason: String(row.reason || row[0] || ''), confidence: Number(row.confidence ?? row[1] ?? 1.0) },
            endpoint_wiring: { reason: String(row.wiringReason || row[2] || ''), confidence: Number(row.wiringConfidence ?? row[3] ?? 1.0) },
            ui: { uid: String(row.uiUid || row[12] || ''), name: String(row.uiName || row[13] || ''), kind: String(row.uiUid || row[12] || '').split(':')[0], filePath: String(row.uiFilePath || row[14] || ''), startLine: row.uiStartLine ?? row[15] },
            endpoint: { uid: String(row.endpointUid || row[4] || ''), name: String(row.endpointName || row[5] || ''), kind: 'CodeElement', filePath: String(row.endpointFilePath || row[6] || ''), startLine: row.endpointStartLine ?? row[7] },
            controller: { uid: String(row.controllerUid || row[8] || ''), name: String(row.controllerName || row[9] || ''), kind: 'Method', filePath: String(row.controllerFilePath || row[10] || ''), startLine: row.controllerStartLine ?? row[11] },
          });
          if (out.length >= limit) return out;
        }
      } catch { /* ignore */ }

      return out.slice(0, limit);
    };

    const discoverHopsFromQueryTokens = async (tokens: string[], maxCount: number): Promise<any[]> => {
      const stop = new Set([
        'alertdialog',
        'confirm',
        'dialog',
        'modal',
        'button',
        'component',
        'hook',
        'service',
        'controller',
        'method',
      ]);

      const candidates = tokens
        .map(t => String(t || '').toLowerCase())
        .filter(t => t.length >= 4 && t.length <= 20 && /^[a-z0-9_-]+$/.test(t) && !stop.has(t))
        .slice(0, 6);

      const out: any[] = [];
      const seen = new Set<string>();
      const limitSql = Math.max(1, Math.min(25, maxCount));

      for (const token of candidates) {
        const tokenEsc = token.replace(/'/g, "''");
        let rows: any[] = [];
        try {
          rows = await executeQuery(repo.id, `
            MATCH (ui)-[r:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
            WHERE r.confidence >= ${minHttpConfidence}
              AND r.reason STARTS WITH 'http-'
              AND r.reason CONTAINS '/${tokenEsc}'
              AND ui.filePath STARTS WITH 'apps/'
              AND e.name STARTS WITH 'endpoint:'
            MATCH (e)-[w:CodeRelation {type: 'CALLS'}]->(c:Method)
            WHERE w.confidence >= ${minHttpConfidence} AND w.reason STARTS WITH 'laravel-endpoint:'
            RETURN ui.id AS uiUid, ui.name AS uiName, ui.filePath AS uiFilePath, ui.startLine AS uiStartLine,
                   e.id AS endpointUid, e.name AS endpointName, e.filePath AS endpointFilePath, e.startLine AS endpointStartLine,
                   c.id AS controllerUid, c.name AS controllerName, c.filePath AS controllerFilePath, c.startLine AS controllerStartLine,
                   r.reason AS reason, r.confidence AS confidence,
                   w.reason AS wiringReason, w.confidence AS wiringConfidence
            ORDER BY r.confidence DESC
            LIMIT ${limitSql}
          `);
        } catch {
          continue;
        }

        for (const row of rows) {
          const uiUid = row.uiUid || row[0];
          const endpointUid = row.endpointUid || row[4];
          const controllerUid = row.controllerUid || row[8];
          const reason = row.reason || row[12];
          if (!uiUid || !endpointUid || !controllerUid || !reason) continue;

          const key = `${uiUid}|${endpointUid}|${controllerUid}|${reason}`;
          if (seen.has(key)) continue;
          seen.add(key);

          out.push({
            http: { reason: String(reason), confidence: Number(row.confidence ?? row[13] ?? 1.0) },
            endpoint_wiring: {
              reason: String(row.wiringReason || row[14] || ''),
              confidence: Number(row.wiringConfidence ?? row[15] ?? 1.0),
            },
            ui: {
              uid: String(uiUid),
              name: String(row.uiName || row[1] || ''),
              kind: String(uiUid).split(':')[0],
              filePath: String(row.uiFilePath || row[2] || ''),
              startLine: Number(row.uiStartLine ?? row[3] ?? 0) || undefined,
            },
            endpoint: {
              uid: String(endpointUid),
              name: String(row.endpointName || row[5] || ''),
              kind: String(endpointUid).split(':')[0],
              filePath: String(row.endpointFilePath || row[6] || ''),
              startLine: Number(row.endpointStartLine ?? row[7] ?? 0) || undefined,
            },
            controller: {
              uid: String(controllerUid),
              name: String(row.controllerName || row[9] || ''),
              kind: String(controllerUid).split(':')[0],
              filePath: String(row.controllerFilePath || row[10] || ''),
              startLine: Number(row.controllerStartLine ?? row[11] ?? 0) || undefined,
            },
          });

          if (out.length >= maxCount) return out;
        }

        if (out.length >= maxCount) return out;
      }

      return out;
    };

    // ─── Anchor collection ────────────────────────────────────────

    const anchorProcessIds: string[] = [];
    const anchorHops: any[] = [];

    if (anchorUid) {
      anchorProcessIds.push(...await findProcessesForUid(anchorUid, limit));
      anchorHops.push(...await findHopsForUid(anchorUid, limit * 4));
    } else {
      // Use action_plan as the anchor finder: it can find deterministic HTTP hops even
      // when a flow is not part of the (capped) Process sample.
      const ap = await this.actionPlan(repo, {
        query: queryText,
        task_context: undefined,
        goal: undefined,
        limit_files: 12,
        limit_checks: 1,
      });

      if (Array.isArray(ap?.top_processes)) {
        for (const p of ap.top_processes) {
          if (p?.id) anchorProcessIds.push(p.id);
        }
      }
      if (Array.isArray(ap?.hops)) {
        anchorHops.push(...ap.hops);
      }
    }

    if (!anchorUid && anchorHops.length === 0 && queryText) {
      anchorHops.push(...await discoverHopsFromQueryTokens(getQueryTokens(queryText), limit * 4));
    }

    // ─── Build precedents ─────────────────────────────────────────

    const hopPrecedents = await buildHopPrecedents(anchorHops);

    for (const pid of anchorProcessIds.slice(0, limit)) {
      addProcessPrecedent(pid);
    }

    const precedents = [...hopPrecedents, ...processPrecedents].slice(0, Math.max(limit, hopPrecedents.length + processPrecedents.length));

    const diagnostics: any = {
      anchor_uid: anchorUid || undefined,
      anchor_processes: anchorProcessIds.length,
      anchor_hops: anchorHops.length,
    };
    if (precedents.length === 0) {
      diagnostics.note = 'No precedents found (no anchor processes or deterministic HTTP hops matched this query).';
      diagnostics.suggestions = [
        'Try action_plan(query) first to get a concrete anchor (UI function / endpoint / controller).',
        'Then rerun precedents() with anchor_uid set to a specific symbol uid.',
        'If this is a backend-only flow, it may not be represented in the capped Process sample.',
      ];
    }

    return {
      status: 'ok',
      query: queryText || anchorUid,
      ...(anchorUid ? { anchor_uid: anchorUid } : {}),
      precedents,
      diagnostics,
    };
  }

  // ─── Tool Implementations ────────────────────────────────────────

  /**
   * Query tool — process-grouped search.
   * 
   * 1. Hybrid search (BM25 + semantic) to find matching symbols
   * 2. Trace each match to its process(es) via STEP_IN_PROCESS
   * 3. Group by process, rank by aggregate relevance + internal cluster cohesion
   * 4. Return: { processes, process_symbols, definitions }
   */
  private async query(repo: RepoHandle, params: {
    query: string;
    task_context?: string;
    goal?: string;
    limit?: number;
    max_symbols?: number;
    include_content?: boolean;
  }): Promise<any> {
    if (!params.query?.trim()) {
      return { error: 'query parameter is required and cannot be empty.' };
    }
    
    await this.ensureInitialized(repo.id);
    
    const processLimit = params.limit || 5;
    const maxSymbolsPerProcess = params.max_symbols || 10;
    const includeContent = params.include_content ?? false;
    const searchQuery = params.query.trim();
    
    // Step 1: Run hybrid search to get matching symbols
    const searchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
    const bm25Results = await this.bm25Search(repo, searchQuery, searchLimit);

    // Semantic search is expensive (model load) and requires embeddings/indexes.
    // Prefer BM25 for identifier-like queries and only fall back to semantic when BM25 is sparse.
    const isSingleToken = !/\s/.test(searchQuery);
    const looksLikeIdentifier = isSingleToken && /^[A-Za-z_][$A-Za-z0-9_:/.-]*$/.test(searchQuery);
    const shouldTrySemantic = !looksLikeIdentifier && bm25Results.length < Math.max(5, Math.floor(searchLimit / 3));

    const semanticResults = shouldTrySemantic
      ? await this.semanticSearch(repo, searchQuery, searchLimit)
      : [];
    
    // Merge via reciprocal rank fusion (RRF)
    const scoreMap = new Map<string, { score: number; data: any }>();

    for (let i = 0; i < bm25Results.length; i++) {
      const result = bm25Results[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i + 1); // rank starts at 1
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }

    for (let i = 0; i < semanticResults.length; i++) {
      const result = semanticResults[i];
      const key = result.nodeId || result.filePath;
      const rrfScore = 1 / (60 + i + 1); // rank starts at 1
      const existing = scoreMap.get(key);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(key, { score: rrfScore, data: result });
      }
    }

    const merged = Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, searchLimit)
      .map((item, idx) => ({ ...item, mergedRank: idx + 1 }));

    const hitMeta = new Map<string, { score: number; rank: number }>();
    for (const item of merged) {
      if (item.data?.nodeId) {
        hitMeta.set(item.data.nodeId, { score: item.score, rank: item.mergedRank });
      }
    }
    
    // Step 2: For each match with a nodeId, trace to process(es)
    type ProcessAgg = {
      id: string;
      label: string;
      heuristicLabel: string;
      processType: string;
      stepCount: number;
      totalScore: number;
      cohesionBoost: number;
      bestHitRank: number;
      hitCount: number;
      anchored: boolean;
    };

    const processMap = new Map<string, ProcessAgg>();
    const definitions: any[] = []; // standalone symbols not in any process

    const ensureProcess = (row: any, defaultPid: string): ProcessAgg => {
      const pid = row.pid ?? row[0] ?? defaultPid;
      if (!processMap.has(pid)) {
        processMap.set(pid, {
          id: pid,
          label: row.label ?? row[1] ?? '',
          heuristicLabel: row.heuristicLabel ?? row[2] ?? '',
          processType: row.processType ?? row[3] ?? '',
          stepCount: row.stepCount ?? row[4] ?? 0,
          totalScore: 0,
          cohesionBoost: 0,
          bestHitRank: Number.POSITIVE_INFINITY,
          hitCount: 0,
          anchored: false,
        });
      }
      return processMap.get(pid)!;
    };

    for (const item of merged) {
      const sym = item.data;
      if (!sym.nodeId) {
        definitions.push({
          name: sym.name,
          type: sym.type || 'File',
          filePath: sym.filePath,
        });
        continue;
      }

      const escaped = sym.nodeId.replace(/'/g, "''");
      const hitRank = item.mergedRank;
      const hitScore = item.score;

      // Find processes this symbol participates in
      let processRows: any[] = [];
      try {
        processRows = await executeQuery(repo.id, `
          MATCH (n {id: '${escaped}'})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `);
      } catch { /* symbol might not be in any process */ }

      // Get cluster cohesion as internal ranking signal (never exposed)
      let cohesion = 0;
      try {
        const cohesionRows = await executeQuery(repo.id, `
          MATCH (n {id: '${escaped}'})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          RETURN c.cohesion AS cohesion
          LIMIT 1
        `);
        if (cohesionRows.length > 0) {
          cohesion = (cohesionRows[0].cohesion ?? cohesionRows[0][0]) || 0;
        }
      } catch { /* no cluster info */ }

      // Optionally fetch content
      let content: string | undefined;
      if (includeContent) {
        try {
          const contentRows = await executeQuery(repo.id, `
            MATCH (n {id: '${escaped}'})
            RETURN n.content AS content
          `);
          if (contentRows.length > 0) {
            content = contentRows[0].content ?? contentRows[0][0];
          }
        } catch { /* skip */ }
      }

      const symbolEntry = {
        id: sym.nodeId,
        name: sym.name,
        type: sym.type,
        filePath: sym.filePath,
        startLine: sym.startLine,
        endLine: sym.endLine,
        ...(includeContent && content ? { content } : {}),
      };

      if (processRows.length === 0) {
        definitions.push(symbolEntry);
        continue;
      }

      for (const row of processRows) {
        const pid = row.pid ?? row[0];
        const proc = ensureProcess(row, pid);
        proc.totalScore += hitScore;
        proc.cohesionBoost = Math.max(proc.cohesionBoost, cohesion);
        proc.bestHitRank = Math.min(proc.bestHitRank, hitRank);
        proc.hitCount += 1;
        if (hitRank <= 10) proc.anchored = true;
      }
    }

    // Step 2b: If top results are tests, try to bridge to likely-under-test symbols
    // via high-confidence CALLS edges (tests are excluded as process entry points).
    const testSeedHits = merged
      .filter(item => item.data?.nodeId && item.data?.filePath && isTestFilePath(item.data.filePath))
      .filter(item => {
        const type = item.data?.type || '';
        return type !== 'File';
      })
      .slice(0, 3);

    const BRIDGE_MIN_CONFIDENCE = 0.8;
    const MAX_BRIDGE_TARGETS = 8;
    const bridgeTargets = new Map<string, { score: number; data: any; seedRank: number }>();

    for (const seed of testSeedHits) {
      const seedId = seed.data.nodeId;
      const escapedSeed = seedId.replace(/'/g, "''");

      let callRows: any[] = [];
      try {
        callRows = await executeQuery(repo.id, `
          MATCH (n {id: '${escapedSeed}'})-[r:CodeRelation {type: 'CALLS'}]->(m)
          RETURN m.id AS id, m.name AS name, m.filePath AS filePath, m.startLine AS startLine, m.endLine AS endLine,
                 r.confidence AS confidence, r.reason AS reason
          ORDER BY r.confidence DESC
          LIMIT ${MAX_BRIDGE_TARGETS}
        `);
      } catch { /* skip */ }

      for (const row of callRows) {
        const targetId = row.id ?? row[0];
        if (!targetId || typeof targetId !== 'string') continue;
        if (hitMeta.has(targetId)) continue;

        const filePath = row.filePath ?? row[2] ?? '';
        if (!filePath || typeof filePath !== 'string') continue;
        if (isTestFilePath(filePath)) continue;

        const confidenceRaw = row.confidence ?? row[5] ?? 0;
        const confidence = typeof confidenceRaw === 'number' ? confidenceRaw : parseFloat(confidenceRaw) || 0;
        if (confidence < BRIDGE_MIN_CONFIDENCE) continue;

        const reason = row.reason ?? row[6] ?? '';
        if (typeof reason === 'string' && reason === 'fuzzy-global') continue;

        const bridgeScore = seed.score * 0.5 * confidence;

        const existing = bridgeTargets.get(targetId);
        if (existing && existing.score >= bridgeScore) continue;

        const labelEndIdx = targetId.indexOf(':');
        const type = labelEndIdx > 0 ? targetId.substring(0, labelEndIdx) : 'Unknown';

        bridgeTargets.set(targetId, {
          score: bridgeScore,
          seedRank: seed.mergedRank,
          data: {
            nodeId: targetId,
            name: row.name ?? row[1] ?? '',
            type,
            filePath,
            startLine: row.startLine ?? row[3],
            endLine: row.endLine ?? row[4],
          },
        });
      }
    }

    for (const target of bridgeTargets.values()) {
      const sym = target.data;
      const escaped = sym.nodeId.replace(/'/g, "''");

      let processRows: any[] = [];
      try {
        processRows = await executeQuery(repo.id, `
          MATCH (n {id: '${escaped}'})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `);
      } catch { /* skip */ }

      if (processRows.length === 0) {
        definitions.push({
          id: sym.nodeId,
          name: sym.name,
          type: sym.type,
          filePath: sym.filePath,
          startLine: sym.startLine,
          endLine: sym.endLine,
        });
        continue;
      }

      for (const row of processRows) {
        const pid = row.pid ?? row[0];
        const proc = ensureProcess(row, pid);
        proc.totalScore += target.score;
        proc.bestHitRank = Math.min(proc.bestHitRank, target.seedRank);
        proc.hitCount += 1;
        proc.anchored = true;
      }
    }
    
    // Step 3: Rank processes by aggregate score + internal cohesion boost
    const allProcesses = Array.from(processMap.values());
    const anchored = allProcesses.filter(p => p.anchored);

    // If we have anchored processes, suppress unanchored ones to avoid noisy "process hits"
    // when the query is really about a standalone symbol (tests are a common case).
    const candidates = anchored.length > 0
      ? anchored
      : allProcesses.filter(p => p.bestHitRank <= 20 || p.hitCount >= 2);

    const rankedProcesses = candidates
      .map(p => ({
        ...p,
        priority: p.totalScore +
          (p.cohesionBoost * 0.1) +
          (Number.isFinite(p.bestHitRank) ? (1 / (30 + p.bestHitRank)) : 0),
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, processLimit);
    
    // Step 4: Fetch full process-step symbols (not only the direct search hits)
    const processSymbols: any[] = [];
    const symbolCountByProcess = new Map<string, number>();

    for (const proc of rankedProcesses) {
      const escapedPid = proc.id.replace(/'/g, "''");
      const contentProjection = includeContent ? ', n.content AS content' : '';

      let stepRows: any[] = [];
      try {
        stepRows = await executeQuery(repo.id, `
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${escapedPid}'})
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${contentProjection},
                 r.step AS step
          ORDER BY r.step
        `);
      } catch { /* skip */ }

      const stepSymbols: any[] = [];
      for (const row of stepRows) {
        const nodeId = row.id ?? row[0];
        if (!nodeId || typeof nodeId !== 'string') continue;

        const labelEndIdx = nodeId.indexOf(':');
        const type = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';

        const step = row.step ?? row[includeContent ? 6 : 5];
        const stepIndex = typeof step === 'number' ? step : parseInt(step, 10);

        stepSymbols.push({
          id: nodeId,
          name: row.name ?? row[1] ?? '',
          type,
          filePath: row.filePath ?? row[2] ?? '',
          startLine: row.startLine ?? row[3],
          endLine: row.endLine ?? row[4],
          ...(includeContent ? { content: row.content ?? row[5] } : {}),
          process_id: proc.id,
          step_index: stepIndex,
          ...(hitMeta.has(nodeId) ? { hit_rank: hitMeta.get(nodeId)!.rank } : {}),
        });
      }

      const limitedSteps = stepSymbols.slice(0, maxSymbolsPerProcess);
      symbolCountByProcess.set(proc.id, limitedSteps.length);
      processSymbols.push(...limitedSteps);
    }

    const processes = rankedProcesses.map(p => ({
      id: p.id,
      summary: p.heuristicLabel || p.label,
      priority: Math.round(p.priority * 1000) / 1000,
      symbol_count: symbolCountByProcess.get(p.id) ?? 0,
      process_type: p.processType,
      step_count: p.stepCount,
    }));

    // Deduplicate definitions by id/filePath (keep highest-ranked)
    const dedupedDefinitions: any[] = [];
    const seenDef = new Set<string>();
    for (const d of definitions) {
      const key = d.id || d.filePath;
      if (!key) continue;
      if (seenDef.has(key)) continue;
      seenDef.add(key);
      dedupedDefinitions.push(d);
    }
    
    return {
      processes,
      process_symbols: processSymbols,
      definitions: dedupedDefinitions.slice(0, 20), // cap standalone definitions
    };
  }

  private async actionPlan(repo: RepoHandle, params: {
    query: string;
    task_context?: string;
    goal?: string;
    limit_files?: number;
    limit_checks?: number;
  }): Promise<any> {
    const limitFiles = Math.max(1, Math.min(50, params.limit_files ?? 10));
    const limitChecks = Math.max(1, Math.min(20, params.limit_checks ?? 10));

    const result = await this.query(repo, {
      query: params.query,
      task_context: params.task_context,
      goal: params.goal,
      limit: 5,
      max_symbols: 12,
      include_content: false,
    });

    const symbols: any[] = Array.isArray(result?.process_symbols) ? result.process_symbols : [];
    const definitions: any[] = Array.isArray(result?.definitions) ? result.definitions : [];

    const fileAgg = new Map<string, { score: number; anchors: Array<{ w: number; a: any }> }>();

    const addAnchor = (sym: any, weight: number) => {
      const filePath = String(sym?.filePath || '').trim();
      if (!filePath) return;

      let agg = fileAgg.get(filePath);
      if (!agg) {
        agg = { score: 0, anchors: [] };
        fileAgg.set(filePath, agg);
      }
      agg.score += weight;

      agg.anchors.push({
        w: weight,
        a: {
          id: sym?.id,
          name: sym?.name,
          type: sym?.type,
          startLine: sym?.startLine,
          endLine: sym?.endLine,
        }
      });
    };

    for (const sym of symbols) {
      const stepIndexRaw = sym?.step_index;
      const stepIndex = typeof stepIndexRaw === 'number' ? stepIndexRaw : parseInt(stepIndexRaw, 10);
      const stepWeight = Number.isFinite(stepIndex) && stepIndex >= 0 ? (1 / (1 + stepIndex)) : 0.1;

      const hitRankRaw = sym?.hit_rank;
      const hitRank = typeof hitRankRaw === 'number' ? hitRankRaw : parseInt(hitRankRaw, 10);
      const hitWeight = Number.isFinite(hitRank) && hitRank > 0 ? (1 / hitRank) : 0;

      addAnchor(sym, 1.0 + stepWeight + (hitWeight * 2));
    }

    for (const def of definitions) {
      addAnchor(def, 0.25);
    }

    const files = Array.from(fileAgg.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limitFiles)
      .map(([filePath, agg]) => {
        const anchors = agg.anchors
          .sort((a, b) => b.w - a.w)
          .map(x => x.a);

        // Dedup anchors by id/name (keep highest-weight)
        const seen = new Set<string>();
        const deduped: any[] = [];
        for (const a of anchors) {
          const key = a.id || `${a.type}:${a.name}:${a.startLine}`;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          deduped.push(a);
          if (deduped.length >= 3) break;
        }

        return {
          filePath,
          score: Math.round(agg.score * 1000) / 1000,
          anchors: deduped,
        };
      });

    const filePaths = files.map(f => f.filePath.toLowerCase());
    const hasPhp = filePaths.some(p => p.endsWith('.php'));
    const hasTs = filePaths.some(p => p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') || p.endsWith('.jsx'));
    const hasBlade = filePaths.some(p => p.endsWith('.blade.php'));
    const hasSvelte = filePaths.some(p => p.endsWith('.svelte'));

    const checks: string[] = [];
    checks.push('Use context() on the top anchors, then impact() on the change point.');
    checks.push('Run the smallest targeted tests that exercise the top-ranked process.');

    if (hasTs) {
      checks.push('Frontend: run TypeScript typecheck + lint for the affected workspace.');
    }
    if (hasPhp) {
      checks.push('Backend: run relevant PHPUnit tests for the impacted handlers/services.');
    }
    if (hasBlade) {
      checks.push('Templates: verify Blade output renders as expected (emails/views).');
    }
    if (hasSvelte) {
      checks.push('Svelte: verify build/compile + integration points for the touched components.');
    }

    const isTsLikeFilePath = (filePath: string): boolean => {
      const p = filePath.toLowerCase();
      return p.endsWith('.ts') || p.endsWith('.tsx') || p.endsWith('.js') || p.endsWith('.jsx');
    };

    const symById = new Map<string, any>();
    for (const sym of [...symbols, ...definitions]) {
      const id = sym?.id;
      if (typeof id !== 'string' || !id) continue;
      symById.set(id, sym);
    }

    const nodeCache = new Map<string, any>();
    const loadNode = async (uid: string): Promise<any | null> => {
      const cached = nodeCache.get(uid) || symById.get(uid);
      if (cached) {
        nodeCache.set(uid, cached);
        return cached;
      }

      const escaped = uid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (n {id: '${escaped}'})
          RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          LIMIT 1
        `);
      } catch {
        return null;
      }

      if (rows.length === 0) return null;
      const r = rows[0];
      const loaded = {
        id: r.id || r[0],
        name: r.name || r[1],
        type: r.type || r[2],
        filePath: r.filePath || r[3],
        startLine: r.startLine ?? r[4],
        endLine: r.endLine ?? r[5],
      };
      nodeCache.set(uid, loaded);
      return loaded;
    };

    const enclosingTypeCache = new Map<string, string | null>();
    const getEnclosingTypeName = async (methodUid: string): Promise<string | null> => {
      if (enclosingTypeCache.has(methodUid)) return enclosingTypeCache.get(methodUid) ?? null;

      const escaped = methodUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (m {id: '${escaped}'})-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Class)
          RETURN c.name AS name
          LIMIT 1
        `);
      } catch {
        enclosingTypeCache.set(methodUid, null);
        return null;
      }

      const name = (rows[0]?.name || rows[0]?.[0] || null) as string | null;
      enclosingTypeCache.set(methodUid, name);
      return name;
    };

    const normalizeNode = async (uid: string, fallback?: Partial<any>): Promise<any | null> => {
      const base = (await loadNode(uid)) || null;
      const merged = { ...(base || {}), ...(fallback || {}) };
      const id = merged.id || uid;
      const name = String(merged.name || '').trim();
      const type = String(merged.type || '').trim();
      const filePath = String(merged.filePath || '').trim();
      if (!id || !type || !filePath) return base;

      if (type === 'Method') {
        const enclosing = await getEnclosingTypeName(id);
        if (enclosing) {
          return { ...merged, display_name: `${enclosing}::${name}` };
        }
      }

      return merged;
    };

    const buildPermissionGrantsForController = async (controllerUid: string): Promise<any[]> => {
      const escaped = controllerUid.replace(/'/g, "''");
      let authRows: any[] = [];
      try {
        authRows = await executeQuery(repo.id, `
          MATCH (c {id: '${escaped}'})-[r:CodeRelation {type: 'CALLS'}]->(t)
          WHERE r.confidence >= 0.9
            AND (
              r.reason STARTS WITH 'laravel-authorize:'
              OR r.reason STARTS WITH 'laravel-gate:'
              OR r.reason STARTS WITH 'laravel-can:'
            )
          RETURN t.id AS uid, t.name AS name, labels(t) AS type, t.filePath AS filePath,
                 r.reason AS reason, r.confidence AS confidence
          ORDER BY r.confidence DESC
          LIMIT 15
        `);
      } catch {
        return [];
      }

      type PermissionCandidate = {
        kind: 'enum_case' | 'policy_method';
        uid: string;
        name: string;
        type: string;
        filePath: string;
        edge: { reason: string; confidence: number };
      };

      const candidates: PermissionCandidate[] = [];
      for (const row of authRows) {
        const uid = row.uid || row[0];
        if (!uid || typeof uid !== 'string') continue;
        const type = row.type || row[2] || '';
        if (type === 'Const') {
          candidates.push({
            kind: 'enum_case',
            uid,
            name: row.name || row[1] || '',
            type,
            filePath: row.filePath || row[3] || '',
            edge: {
              reason: row.reason || row[4] || '',
              confidence: Number(row.confidence ?? row[5] ?? 1.0),
            },
          });
          continue;
        }

        if (type === 'Method') {
          candidates.push({
            kind: 'policy_method',
            uid,
            name: row.name || row[1] || '',
            type,
            filePath: row.filePath || row[3] || '',
            edge: {
              reason: row.reason || row[4] || '',
              confidence: Number(row.confidence ?? row[5] ?? 1.0),
            },
          });
        }
      }

      const grants: any[] = [];
      const seen = new Set<string>();

      const expandConstToGrant = async (
        constUid: string,
        evidence: { controller_edge: { reason: string; confidence: number }; via_policy?: any; }
      ): Promise<void> => {
        const constEscaped = constUid.replace(/'/g, "''");
        let slugRows: any[] = [];
        try {
          slugRows = await executeQuery(repo.id, `
            MATCH (c {id: '${constEscaped}'})-[r:CodeRelation {type: 'CALLS'}]->(s:CodeElement)
            WHERE r.reason STARTS WITH 'laravel-permission-slug:'
            RETURN s.id AS uid, s.name AS name, s.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
            ORDER BY r.confidence DESC
            LIMIT 2
          `);
        } catch {
          return;
        }

        for (const slugRow of slugRows) {
          const slugUid = slugRow.uid || slugRow[0];
          if (!slugUid || typeof slugUid !== 'string') continue;
          const slug = String(slugRow.name || slugRow[1] || '').trim();
          if (!slug) continue;

          const key = `${slugUid}:${slug}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const slugNode = await normalizeNode(slugUid, {
            id: slugUid,
            name: slug,
            type: 'CodeElement',
            filePath: slugRow.filePath || slugRow[2] || '',
          });

          const slugEdge = {
            reason: String(slugRow.reason || slugRow[3] || ''),
            confidence: Number(slugRow.confidence ?? slugRow[4] ?? 1.0),
          };

          let roleRows: any[] = [];
          try {
            const slugEsc = slugUid.replace(/'/g, "''");
            roleRows = await executeQuery(repo.id, `
              MATCH (role:CodeElement)-[r:CodeRelation {type: 'CALLS'}]->(s {id: '${slugEsc}'})
              WHERE r.confidence >= 0.9 AND r.reason STARTS WITH 'laravel-role-permission-slug:'
              RETURN role.id AS uid, role.name AS name, role.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
              ORDER BY role.name
              LIMIT 25
            `);
          } catch {
            roleRows = [];
          }

          const roles: any[] = [];
          for (const roleRow of roleRows) {
            const roleUid = roleRow.uid || roleRow[0];
            if (!roleUid || typeof roleUid !== 'string') continue;
            roles.push({
              uid: roleUid,
              name: roleRow.name || roleRow[1] || '',
              filePath: roleRow.filePath || roleRow[2] || '',
              reason: roleRow.reason || roleRow[3] || '',
              confidence: Number(roleRow.confidence ?? roleRow[4] ?? 1.0),
            });
          }

          grants.push({
            permission: slugNode ? {
              uid: slugNode.id,
              slug: slugNode.name,
              filePath: slugNode.filePath,
            } : {
              uid: slugUid,
              slug,
              filePath: slugRow.filePath || slugRow[2] || '',
            },
            roles,
            evidence: {
              ...evidence,
              slug_edge: slugEdge,
            },
          });
        }
      };

      for (const candidate of candidates) {
        if (candidate.kind === 'enum_case') {
          await expandConstToGrant(candidate.uid, { controller_edge: candidate.edge });
          continue;
        }

        // Policy method: attempt to derive permission enum cases deterministically via match-return edges.
        const policyEsc = candidate.uid.replace(/'/g, "''");
        let constRows: any[] = [];
        try {
          constRows = await executeQuery(repo.id, `
            MATCH (p {id: '${policyEsc}'})-[r:CodeRelation {type: 'CALLS'}]->(c:Const)
            WHERE r.confidence >= 0.9 AND r.reason STARTS WITH 'php-match-return:'
            RETURN c.id AS uid, c.name AS name, c.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
            ORDER BY r.confidence DESC
            LIMIT 10
          `);
        } catch {
          continue;
        }

        for (const row of constRows) {
          const constUid = row.uid || row[0];
          if (!constUid || typeof constUid !== 'string') continue;
          const matchEdge = {
            reason: String(row.reason || row[3] || ''),
            confidence: Number(row.confidence ?? row[4] ?? 1.0),
          };
          await expandConstToGrant(constUid, {
            controller_edge: candidate.edge,
            via_policy: {
              uid: candidate.uid,
              name: candidate.name,
              filePath: candidate.filePath,
              match_edge: matchEdge,
            },
          });
        }
      }

      return grants;
    };

    const hops: any[] = [];
    const hopLimit = Math.max(1, Math.min(25, limitFiles * 2));
    const seenHopKey = new Set<string>();

    const controllerCandidates = [...symbols, ...definitions]
      .filter(s => s?.type === 'Method' && String(s?.filePath || '').includes('/Http/Controllers/'))
      .map(s => s.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, hopLimit);

    const endpointCandidates = [...symbols, ...definitions]
      .filter(s => s?.type === 'CodeElement' && String(s?.name || '').startsWith('endpoint:'))
      .map(s => s.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, hopLimit);

    const uiCandidates = [...symbols, ...definitions]
      .filter(s => (s?.type === 'Function' || s?.type === 'Method') && isTsLikeFilePath(String(s?.filePath || '')))
      .map(s => s.id)
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, hopLimit);

    const tryAddHop = async (opts: {
      uiUid: string;
      endpointUid: string;
      controllerUid: string;
      http: { reason: string; confidence: number };
    }): Promise<void> => {
      if (hops.length >= hopLimit) return;

      const key = `${opts.uiUid}|${opts.endpointUid}|${opts.controllerUid}|${opts.http.reason}`;
      if (seenHopKey.has(key)) return;
      seenHopKey.add(key);

      const [uiNode, endpointNode, controllerNode] = await Promise.all([
        normalizeNode(opts.uiUid),
        normalizeNode(opts.endpointUid),
        normalizeNode(opts.controllerUid),
      ]);
      if (!uiNode || !endpointNode || !controllerNode) return;

      const endpointEsc = opts.endpointUid.replace(/'/g, "''");
      const controllerEsc = opts.controllerUid.replace(/'/g, "''");
      let endpointEdge: { reason: string; confidence: number } | null = null;
      try {
        const rows = await executeQuery(repo.id, `
          MATCH (e {id: '${endpointEsc}'})-[r:CodeRelation {type: 'CALLS'}]->(c {id: '${controllerEsc}'})
          WHERE r.reason STARTS WITH 'laravel-endpoint:'
          RETURN r.reason AS reason, r.confidence AS confidence
          ORDER BY r.confidence DESC
          LIMIT 1
        `);
        if (rows.length > 0) {
          endpointEdge = {
            reason: rows[0].reason || rows[0][0] || '',
            confidence: Number(rows[0].confidence ?? rows[0][1] ?? 1.0),
          };
        }
      } catch { /* ignore */ }

      const grants = await buildPermissionGrantsForController(opts.controllerUid);

      hops.push({
        http: opts.http,
        endpoint_wiring: endpointEdge,
        ui: {
          uid: uiNode.id,
          name: uiNode.display_name || uiNode.name,
          kind: uiNode.type,
          filePath: uiNode.filePath,
          startLine: uiNode.startLine,
        },
        endpoint: {
          uid: endpointNode.id,
          name: endpointNode.name,
          kind: endpointNode.type,
          filePath: endpointNode.filePath,
          startLine: endpointNode.startLine,
        },
        controller: {
          uid: controllerNode.id,
          name: controllerNode.display_name || controllerNode.name,
          kind: controllerNode.type,
          filePath: controllerNode.filePath,
          startLine: controllerNode.startLine,
        },
        permissions: grants,
      });
    };

    const hopWork: Promise<void>[] = [];

    const buildFromController = async (controllerUid: string): Promise<void> => {
      const escaped = controllerUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui)-[r:CodeRelation {type: 'CALLS'}]->(c {id: '${escaped}'})
          WHERE r.confidence >= 0.9 AND r.reason STARTS WITH 'http-'
          RETURN ui.id AS uiUid, r.reason AS reason, r.confidence AS confidence
          ORDER BY r.confidence DESC
          LIMIT 10
        `);
      } catch {
        return;
      }

      for (const row of rows) {
        if (hops.length >= hopLimit) return;
        const uiUid = row.uiUid || row[0];
        const reason = row.reason || row[1];
        const confidence = Number(row.confidence ?? row[2] ?? 1.0);
        if (!uiUid || typeof uiUid !== 'string') continue;
        if (!reason || typeof reason !== 'string') continue;

        const reasonEsc = reason.replace(/'/g, "''");
        const uiEsc = uiUid.replace(/'/g, "''");
        let endpointRows: any[] = [];
        try {
          endpointRows = await executeQuery(repo.id, `
            MATCH (ui {id: '${uiEsc}'})-[r:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
            WHERE r.reason = '${reasonEsc}' AND e.name STARTS WITH 'endpoint:'
            RETURN e.id AS uid
            LIMIT 1
          `);
        } catch {
          continue;
        }
        const endpointUid = endpointRows[0]?.uid || endpointRows[0]?.[0];
        if (!endpointUid || typeof endpointUid !== 'string') continue;

        await tryAddHop({
          uiUid,
          endpointUid,
          controllerUid,
          http: { reason, confidence },
        });
      }
    };

    const buildFromEndpoint = async (endpointUid: string): Promise<void> => {
      const escaped = endpointUid.replace(/'/g, "''");
      let controllerRows: any[] = [];
      try {
        controllerRows = await executeQuery(repo.id, `
          MATCH (e {id: '${escaped}'})-[r:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE r.reason STARTS WITH 'laravel-endpoint:' AND r.confidence >= 0.9
          RETURN c.id AS uid
          ORDER BY r.confidence DESC
          LIMIT 5
        `);
      } catch {
        return;
      }

      for (const cRow of controllerRows) {
        if (hops.length >= hopLimit) return;
        const controllerUid = cRow.uid || cRow[0];
        if (!controllerUid || typeof controllerUid !== 'string') continue;

        let httpRows: any[] = [];
        try {
          httpRows = await executeQuery(repo.id, `
            MATCH (ui)-[r:CodeRelation {type: 'CALLS'}]->(e {id: '${escaped}'})
            WHERE r.confidence >= 0.9 AND r.reason STARTS WITH 'http-'
            RETURN ui.id AS uiUid, r.reason AS reason, r.confidence AS confidence
            ORDER BY r.confidence DESC
            LIMIT 10
          `);
        } catch {
          continue;
        }

        for (const httpRow of httpRows) {
          if (hops.length >= hopLimit) return;
          const uiUid = httpRow.uiUid || httpRow[0];
          const reason = httpRow.reason || httpRow[1];
          const confidence = Number(httpRow.confidence ?? httpRow[2] ?? 1.0);
          if (!uiUid || typeof uiUid !== 'string') continue;
          if (!reason || typeof reason !== 'string') continue;

          await tryAddHop({
            uiUid,
            endpointUid,
            controllerUid,
            http: { reason, confidence },
          });
        }
      }
    };

    const buildFromUi = async (uiUid: string): Promise<void> => {
      const escaped = uiUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui {id: '${escaped}'})-[r:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE r.confidence >= 0.9 AND r.reason STARTS WITH 'http-' AND e.name STARTS WITH 'endpoint:'
          RETURN e.id AS endpointUid, r.reason AS reason, r.confidence AS confidence
          ORDER BY r.confidence DESC
          LIMIT 10
        `);
      } catch {
        return;
      }

      for (const row of rows) {
        if (hops.length >= hopLimit) return;
        const endpointUid = row.endpointUid || row[0];
        const reason = row.reason || row[1];
        const confidence = Number(row.confidence ?? row[2] ?? 1.0);
        if (!endpointUid || typeof endpointUid !== 'string') continue;
        if (!reason || typeof reason !== 'string') continue;

        const endpointEsc = endpointUid.replace(/'/g, "''");
        let controllerRows: any[] = [];
        try {
          controllerRows = await executeQuery(repo.id, `
            MATCH (e {id: '${endpointEsc}'})-[r:CodeRelation {type: 'CALLS'}]->(c:Method)
            WHERE r.reason STARTS WITH 'laravel-endpoint:' AND r.confidence >= 0.9
            RETURN c.id AS uid
            ORDER BY r.confidence DESC
            LIMIT 3
          `);
        } catch {
          continue;
        }
        const controllerUid = controllerRows[0]?.uid || controllerRows[0]?.[0];
        if (!controllerUid || typeof controllerUid !== 'string') continue;

        await tryAddHop({
          uiUid,
          endpointUid,
          controllerUid,
          http: { reason, confidence },
        });
      }
    };

    if (controllerCandidates.length > 0) {
      for (const controllerUid of controllerCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(buildFromController(controllerUid));
      }
    } else if (endpointCandidates.length > 0) {
      for (const endpointUid of endpointCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(buildFromEndpoint(endpointUid));
      }
    } else {
      for (const uiUid of uiCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(buildFromUi(uiUid));
      }
    }

    try {
      for (const work of hopWork) {
        if (hops.length >= hopLimit) break;
        await work;
      }
    } catch { /* ignore */ }

    return {
      status: 'ok',
      repo: repo.name,
      query: params.query,
      files,
      checks: checks.slice(0, limitChecks),
      top_processes: Array.isArray(result?.processes) ? result.processes.slice(0, 3) : [],
      hops,
    };
  }

  /**
   * BM25 keyword search helper - uses KuzuDB FTS for always-fresh results
   */
  private async bm25Search(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    try {
      const escapedQuery = query.replace(/'/g, "''");
      const scoreMap = new Map<string, { score: number; bm25Score: number; data: any }>();
      const tables: Array<{ table: string; index: string }> = [
        { table: 'Method', index: 'method_fts' },
        { table: 'Function', index: 'function_fts' },
        { table: 'Class', index: 'class_fts' },
        { table: 'Interface', index: 'interface_fts' },
        { table: 'CodeElement', index: 'codeelement_fts' },
        { table: 'Const', index: 'const_fts' },
        { table: 'File', index: 'file_fts' },
      ];

      for (const { table, index } of tables) {
        let rows: any[] = [];
        try {
          rows = await executeQuery(repo.id, `
            CALL QUERY_FTS_INDEX('${table}', '${index}', '${escapedQuery}', conjunctive := false)
            RETURN node, score
            ORDER BY score DESC
            LIMIT ${limit}
          `);
        } catch {
          // Index may not exist (older DB) — treat as empty.
          continue;
        }

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const node = row.node || row[0] || {};
          const nodeId = node.id || node.nodeId || '';
          if (!nodeId) continue;

          const rrfScore = 1 / (60 + i + 1); // rank starts at 1
          const bm25ScoreRaw = row.score ?? row[1] ?? 0;
          const bm25Score = typeof bm25ScoreRaw === 'number' ? bm25ScoreRaw : parseFloat(bm25ScoreRaw) || 0;

          const existing = scoreMap.get(nodeId);
          if (existing) {
            existing.score += rrfScore;
            existing.bm25Score = Math.max(existing.bm25Score, bm25Score);
          } else {
            scoreMap.set(nodeId, {
              score: rrfScore,
              bm25Score,
              data: {
                nodeId,
                name: node.name || '',
                type: table,
                filePath: node.filePath || '',
                startLine: typeof node.startLine === 'number' ? node.startLine : undefined,
                endLine: typeof node.endLine === 'number' ? node.endLine : undefined,
              }
            });
          }
        }
      }

      return Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(item => ({ ...item.data, bm25Score: item.bm25Score }));
    } catch (err: any) {
      console.error('GitNexus: BM25/FTS search failed (FTS indexes may not exist) -', err.message);
      return [];
    }
  }

  /**
   * Semantic vector search helper
   */
  private async semanticSearch(repo: RepoHandle, query: string, limit: number): Promise<any[]> {
    try {
      const queryVec = await embedQuery(query);
      const dims = getEmbeddingDims();
      const queryVecStr = `[${queryVec.join(',')}]`;
      
      const vectorQuery = `
        CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 
          CAST(${queryVecStr} AS FLOAT[${dims}]), ${limit})
        YIELD node AS emb, distance
        WITH emb, distance
        WHERE distance < 0.6
        RETURN emb.nodeId AS nodeId, distance
        ORDER BY distance
      `;
      
      const embResults = await executeQuery(repo.id, vectorQuery);
      
      if (embResults.length === 0) return [];
      
      const results: any[] = [];
      
      for (const embRow of embResults) {
        const nodeId = embRow.nodeId ?? embRow[0];
        const distance = embRow.distance ?? embRow[1];
        
        const labelEndIdx = nodeId.indexOf(':');
        const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
        
        // Validate label against known node types to prevent Cypher injection
        if (!VALID_NODE_LABELS.has(label)) continue;
        
        try {
          const escapedId = nodeId.replace(/'/g, "''");
          const nodeQuery = label === 'File'
            ? `MATCH (n:File {id: '${escapedId}'}) RETURN n.name AS name, n.filePath AS filePath`
            : `MATCH (n:\`${label}\` {id: '${escapedId}'}) RETURN n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
          
          const nodeRows = await executeQuery(repo.id, nodeQuery);
          if (nodeRows.length > 0) {
            const nodeRow = nodeRows[0];
            results.push({
              nodeId,
              name: nodeRow.name ?? nodeRow[0] ?? '',
              type: label,
              filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
              distance,
              startLine: label !== 'File' ? (nodeRow.startLine ?? nodeRow[2]) : undefined,
              endLine: label !== 'File' ? (nodeRow.endLine ?? nodeRow[3]) : undefined,
            });
          }
        } catch {}
      }
      
      return results;
    } catch (err: any) {
      console.error('GitNexus: Semantic search unavailable -', err.message);
      return [];
    }
  }

  private async cypher(repo: RepoHandle, params: { query: string }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    if (!isKuzuReady(repo.id)) {
      return { error: 'KuzuDB not ready. Index may be corrupted.' };
    }
    
    try {
      const result = await executeQuery(repo.id, params.query);
      return result;
    } catch (err: any) {
      return { error: err.message || 'Query failed' };
    }
  }

  /**
   * Aggregate same-named clusters: group by heuristicLabel, sum symbols,
   * weighted-average cohesion, filter out tiny clusters (<5 symbols).
   * Raw communities stay intact in KuzuDB for Cypher queries.
   */
  private aggregateClusters(clusters: any[]): any[] {
    const groups = new Map<string, { ids: string[]; totalSymbols: number; weightedCohesion: number; largest: any }>();

    for (const c of clusters) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      const symbols = c.symbolCount || 0;
      const cohesion = c.cohesion || 0;
      const existing = groups.get(label);

      if (!existing) {
        groups.set(label, { ids: [c.id], totalSymbols: symbols, weightedCohesion: cohesion * symbols, largest: c });
      } else {
        existing.ids.push(c.id);
        existing.totalSymbols += symbols;
        existing.weightedCohesion += cohesion * symbols;
        if (symbols > (existing.largest.symbolCount || 0)) {
          existing.largest = c;
        }
      }
    }

    return Array.from(groups.entries())
      .map(([label, g]) => ({
        id: g.largest.id,
        label,
        heuristicLabel: label,
        symbolCount: g.totalSymbols,
        cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
        subCommunities: g.ids.length,
      }))
      .filter(c => c.symbolCount >= 5)
      .sort((a, b) => b.symbolCount - a.symbolCount);
  }

  private async overview(repo: RepoHandle, params: { showClusters?: boolean; showProcesses?: boolean; limit?: number }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const limit = params.limit || 20;
    const result: any = {
      repo: repo.name,
      repoPath: repo.repoPath,
      stats: repo.stats,
      indexedAt: repo.indexedAt,
      lastCommit: repo.lastCommit,
    };
    
    if (params.showClusters !== false) {
      try {
        // Fetch more raw communities than the display limit so aggregation has enough data
        const rawLimit = Math.max(limit * 5, 200);
        const clusters = await executeQuery(repo.id, `
          MATCH (c:Community)
          RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
          ORDER BY c.symbolCount DESC
          LIMIT ${rawLimit}
        `);
        const rawClusters = clusters.map((c: any) => ({
          id: c.id || c[0],
          label: c.label || c[1],
          heuristicLabel: c.heuristicLabel || c[2],
          cohesion: c.cohesion || c[3],
          symbolCount: c.symbolCount || c[4],
        }));
        result.clusters = this.aggregateClusters(rawClusters).slice(0, limit);
      } catch {
        result.clusters = [];
      }
    }
    
    if (params.showProcesses !== false) {
      try {
        const processes = await executeQuery(repo.id, `
          MATCH (p:Process)
          RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
          ORDER BY p.stepCount DESC
          LIMIT ${limit}
        `);
        result.processes = processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        }));
      } catch {
        result.processes = [];
      }
    }
    
    return result;
  }

  /**
   * Context tool — 360-degree symbol view with categorized refs.
   * Disambiguation when multiple symbols share a name.
   * UID-based direct lookup. No cluster in output.
   */
  private async context(repo: RepoHandle, params: {
    name?: string;
    uid?: string;
    file_path?: string;
    include_content?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { name, uid, file_path, include_content } = params;
    
    if (!name && !uid) {
      return { error: 'Either "name" or "uid" parameter is required.' };
    }
    
    // Step 1: Find the symbol
    let symbols: any[];
    
    if (uid) {
      const escaped = uid.replace(/'/g, "''");
      symbols = await executeQuery(repo.id, `
        MATCH (n {id: '${escaped}'})
        RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 1
      `);
    } else {
      const escaped = name!.replace(/'/g, "''");
      const isQualified = name!.includes('/') || name!.includes(':');
      
      let whereClause: string;
      if (file_path) {
        const fpEscaped = file_path.replace(/'/g, "''");
        whereClause = `WHERE n.name = '${escaped}' AND n.filePath CONTAINS '${fpEscaped}'`;
      } else if (isQualified) {
        whereClause = `WHERE n.id = '${escaped}' OR n.name = '${escaped}'`;
      } else {
        whereClause = `WHERE n.name = '${escaped}'`;
      }
      
      symbols = await executeQuery(repo.id, `
        MATCH (n) ${whereClause}
        RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine${include_content ? ', n.content AS content' : ''}
        LIMIT 10
      `);
    }
    
    if (symbols.length === 0) {
      return { error: `Symbol '${name || uid}' not found` };
    }
    
    // Step 2: Disambiguation
    if (symbols.length > 1 && !uid) {
      return {
        status: 'ambiguous',
        message: `Found ${symbols.length} symbols matching '${name}'. Use uid or file_path to disambiguate.`,
        candidates: symbols.map((s: any) => ({
          uid: s.id || s[0],
          name: s.name || s[1],
          kind: s.type || s[2],
          filePath: s.filePath || s[3],
          line: s.startLine || s[4],
        })),
      };
    }
    
    // Step 3: Build full context
    const sym = symbols[0];
    const symId = (sym.id || sym[0]).replace(/'/g, "''");
    
    // Categorized incoming refs
    const incomingRows = await executeQuery(repo.id, `
      MATCH (caller)-[r:CodeRelation]->(n {id: '${symId}'})
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
      RETURN r.type AS relType,
             caller.id AS uid, caller.name AS name, caller.filePath AS filePath, labels(caller) AS kind,
             r.confidence AS confidence, r.reason AS reason
      ORDER BY r.confidence DESC
      LIMIT 30
    `);
    
    // Categorized outgoing refs
    const outgoingRows = await executeQuery(repo.id, `
      MATCH (n {id: '${symId}'})-[r:CodeRelation]->(target)
      WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']
      RETURN r.type AS relType,
             target.id AS uid, target.name AS name, target.filePath AS filePath, labels(target) AS kind,
             r.confidence AS confidence, r.reason AS reason
      ORDER BY r.confidence DESC
      LIMIT 30
    `);
    
    // Process participation
    let processRows: any[] = [];
    try {
      processRows = await executeQuery(repo.id, `
        MATCH (n {id: '${symId}'})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
        RETURN p.id AS pid, p.heuristicLabel AS label, r.step AS step, p.stepCount AS stepCount
      `);
    } catch { /* no process info */ }
    
    // Helper to categorize refs
    const categorize = (rows: any[]) => {
      const cats: Record<string, any[]> = {};
      for (const row of rows) {
        const relType = (row.relType || row[0] || '').toLowerCase();
        const confidenceRaw = row.confidence ?? row[5];
        const confidenceCandidate = confidenceRaw !== undefined && confidenceRaw !== null ? Number(confidenceRaw) : NaN;
        const confidence = Number.isFinite(confidenceCandidate) ? confidenceCandidate : 1.0;
        const reasonRaw = row.reason ?? row[6];
        const reason = typeof reasonRaw === 'string' ? reasonRaw : reasonRaw !== undefined && reasonRaw !== null ? String(reasonRaw) : '';
        const entry = {
          uid: row.uid || row[1],
          name: row.name || row[2],
          filePath: row.filePath || row[3],
          kind: row.kind || row[4],
          confidence,
          reason,
        };
        if (!cats[relType]) cats[relType] = [];
        cats[relType].push(entry);
      }
      return cats;
    };
    
    return {
      status: 'found',
      symbol: {
        uid: sym.id || sym[0],
        name: sym.name || sym[1],
        kind: sym.type || sym[2],
        filePath: sym.filePath || sym[3],
        startLine: sym.startLine || sym[4],
        endLine: sym.endLine || sym[5],
        ...(include_content && (sym.content || sym[6]) ? { content: sym.content || sym[6] } : {}),
      },
      incoming: categorize(incomingRows),
      outgoing: categorize(outgoingRows),
      processes: processRows.map((r: any) => ({
        id: r.pid || r[0],
        name: r.label || r[1],
        step_index: r.step || r[2],
        step_count: r.stepCount || r[3],
      })),
    };
  }

  /**
   * Legacy explore — kept for backwards compatibility with resources.ts.
   * Routes cluster/process types to direct graph queries.
   */
  private async explore(repo: RepoHandle, params: { name: string; type: 'symbol' | 'cluster' | 'process' }): Promise<any> {
    await this.ensureInitialized(repo.id);
    const { name, type } = params;
    
    if (type === 'symbol') {
      return this.context(repo, { name });
    }
    
    if (type === 'cluster') {
      const escaped = name.replace(/'/g, "''");
      const clusterQuery = `
        MATCH (c:Community)
        WHERE c.label = '${escaped}' OR c.heuristicLabel = '${escaped}'
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
      `;
      const clusters = await executeQuery(repo.id, clusterQuery);
      if (clusters.length === 0) return { error: `Cluster '${name}' not found` };
      
      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0], label: c.label || c[1], heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3], symbolCount: c.symbolCount || c[4],
      }));
      
      let totalSymbols = 0, weightedCohesion = 0;
      for (const c of rawClusters) {
        const s = c.symbolCount || 0;
        totalSymbols += s;
        weightedCohesion += (c.cohesion || 0) * s;
      }
      
      const members = await executeQuery(repo.id, `
        MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
        WHERE c.label = '${escaped}' OR c.heuristicLabel = '${escaped}'
        RETURN DISTINCT n.name AS name, labels(n) AS type, n.filePath AS filePath
        LIMIT 30
      `);
      
      return {
        cluster: {
          id: rawClusters[0].id,
          label: rawClusters[0].heuristicLabel || rawClusters[0].label,
          heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
          cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
          symbolCount: totalSymbols,
          subCommunities: rawClusters.length,
        },
        members: members.map((m: any) => ({
          name: m.name || m[0], type: m.type || m[1], filePath: m.filePath || m[2],
        })),
      };
    }
    
    if (type === 'process') {
      const processes = await executeQuery(repo.id, `
        MATCH (p:Process)
        WHERE p.label = '${name.replace(/'/g, "''")}' OR p.heuristicLabel = '${name.replace(/'/g, "''")}'
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        LIMIT 1
      `);
      if (processes.length === 0) return { error: `Process '${name}' not found` };
      
      const proc = processes[0];
      const procId = proc.id || proc[0];
      const steps = await executeQuery(repo.id, `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: '${procId}'})
        RETURN n.name AS name, labels(n) AS type, n.filePath AS filePath, r.step AS step
        ORDER BY r.step
      `);
      
      return {
        process: {
          id: procId, label: proc.label || proc[1], heuristicLabel: proc.heuristicLabel || proc[2],
          processType: proc.processType || proc[3], stepCount: proc.stepCount || proc[4],
        },
        steps: steps.map((s: any) => ({
          step: s.step || s[3], name: s.name || s[0], type: s.type || s[1], filePath: s.filePath || s[2],
        })),
      };
    }
    
    return { error: 'Invalid type. Use: symbol, cluster, or process' };
  }

  /**
   * Detect changes — git-diff based impact analysis.
   * Maps changed lines to indexed symbols, then finds affected processes.
   */
  private async detectChanges(repo: RepoHandle, params: {
    scope?: string;
    base_ref?: string;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const scope = params.scope || 'unstaged';
    const { execSync } = await import('child_process');
    
    // Build git diff command based on scope
    let diffCmd: string;
    switch (scope) {
      case 'staged':
        diffCmd = 'git diff --staged --name-only';
        break;
      case 'all':
        diffCmd = 'git diff HEAD --name-only';
        break;
      case 'compare':
        if (!params.base_ref) return { error: 'base_ref is required for "compare" scope' };
        diffCmd = `git diff ${params.base_ref} --name-only`;
        break;
      case 'unstaged':
      default:
        diffCmd = 'git diff --name-only';
        break;
    }
    
    let changedFiles: string[];
    try {
      const output = execSync(diffCmd, { cwd: repo.repoPath, encoding: 'utf-8' });
      changedFiles = output.trim().split('\n').filter(f => f.length > 0);
    } catch (err: any) {
      return { error: `Git diff failed: ${err.message}` };
    }
    
    if (changedFiles.length === 0) {
      return {
        summary: { changed_count: 0, affected_count: 0, risk_level: 'none', message: 'No changes detected.' },
        changed_symbols: [],
        affected_processes: [],
      };
    }
    
    // Map changed files to indexed symbols
    const changedSymbols: any[] = [];
    for (const file of changedFiles) {
      const escaped = file.replace(/\\/g, '/').replace(/'/g, "''");
      try {
        const symbols = await executeQuery(repo.id, `
          MATCH (n) WHERE n.filePath CONTAINS '${escaped}'
          RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath
          LIMIT 20
        `);
        for (const sym of symbols) {
          changedSymbols.push({
            id: sym.id || sym[0],
            name: sym.name || sym[1],
            type: sym.type || sym[2],
            filePath: sym.filePath || sym[3],
            change_type: 'Modified',
          });
        }
      } catch { /* skip */ }
    }
    
    // Find affected processes
    const affectedProcesses = new Map<string, any>();
    for (const sym of changedSymbols) {
      const escaped = (sym.id as string).replace(/'/g, "''");
      try {
        const procs = await executeQuery(repo.id, `
          MATCH (n {id: '${escaped}'})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.heuristicLabel AS label, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `);
        for (const proc of procs) {
          const pid = proc.pid || proc[0];
          if (!affectedProcesses.has(pid)) {
            affectedProcesses.set(pid, {
              id: pid,
              name: proc.label || proc[1],
              process_type: proc.processType || proc[2],
              step_count: proc.stepCount || proc[3],
              changed_steps: [],
            });
          }
          affectedProcesses.get(pid)!.changed_steps.push({
            symbol: sym.name,
            step: proc.step || proc[4],
          });
        }
      } catch { /* skip */ }
    }
    
    const processCount = affectedProcesses.size;
    const risk = processCount === 0 ? 'low' : processCount <= 5 ? 'medium' : processCount <= 15 ? 'high' : 'critical';
    
    return {
      summary: {
        changed_count: changedSymbols.length,
        affected_count: processCount,
        changed_files: changedFiles.length,
        risk_level: risk,
      },
      changed_symbols: changedSymbols,
      affected_processes: Array.from(affectedProcesses.values()),
    };
  }

  /**
   * Rename tool — multi-file coordinated rename using graph + text search.
   * Graph refs are tagged "graph" (high confidence).
   * Additional refs found via text search are tagged "text_search" (lower confidence).
   */
  private async rename(repo: RepoHandle, params: {
    symbol_name?: string;
    symbol_uid?: string;
    new_name: string;
    file_path?: string;
    dry_run?: boolean;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { new_name, file_path } = params;
    const dry_run = params.dry_run ?? true;
    
    if (!params.symbol_name && !params.symbol_uid) {
      return { error: 'Either symbol_name or symbol_uid is required.' };
    }
    
    // Step 1: Find the target symbol (reuse context's lookup)
    const lookupResult = await this.context(repo, {
      name: params.symbol_name,
      uid: params.symbol_uid,
      file_path,
    });
    
    if (lookupResult.status === 'ambiguous') {
      return lookupResult; // pass disambiguation through
    }
    if (lookupResult.error) {
      return lookupResult;
    }
    
    const sym = lookupResult.symbol;
    const oldName = sym.name;
    
    if (oldName === new_name) {
      return { error: 'New name is the same as the current name.' };
    }
    
    // Step 2: Collect edits from graph (high confidence)
    const changes = new Map<string, { file_path: string; edits: any[] }>();
    
    const addEdit = (filePath: string, line: number, oldText: string, newText: string, confidence: string) => {
      if (!changes.has(filePath)) {
        changes.set(filePath, { file_path: filePath, edits: [] });
      }
      changes.get(filePath)!.edits.push({ line, old_text: oldText, new_text: newText, confidence });
    };
    
    // The definition itself
    if (sym.filePath && sym.startLine) {
      try {
        const content = await fs.readFile(path.join(repo.repoPath, sym.filePath), 'utf-8');
        const lines = content.split('\n');
        const lineIdx = sym.startLine - 1;
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(oldName)) {
          addEdit(sym.filePath, sym.startLine, lines[lineIdx].trim(), lines[lineIdx].replace(oldName, new_name).trim(), 'graph');
        }
      } catch { /* skip */ }
    }
    
    // All incoming refs from graph (callers, importers, etc.)
    const allIncoming = [
      ...(lookupResult.incoming.calls || []),
      ...(lookupResult.incoming.imports || []),
      ...(lookupResult.incoming.extends || []),
      ...(lookupResult.incoming.implements || []),
    ];
    
    let graphEdits = changes.size > 0 ? 1 : 0; // count definition edit
    
    for (const ref of allIncoming) {
      if (!ref.filePath) continue;
      try {
        const content = await fs.readFile(path.join(repo.repoPath, ref.filePath), 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(oldName)) {
            addEdit(ref.filePath, i + 1, lines[i].trim(), lines[i].replace(new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), new_name).trim(), 'graph');
            graphEdits++;
            break; // one edit per file from graph refs
          }
        }
      } catch { /* skip */ }
    }
    
    // Step 3: Text search for refs the graph might have missed
    let astSearchEdits = 0;
    const graphFiles = new Set([sym.filePath, ...allIncoming.map(r => r.filePath)].filter(Boolean));
    
    // Simple text search across the repo for the old name (in files not already covered by graph)
    try {
      const { execSync } = await import('child_process');
      const rgCmd = `rg -l --type-add "code:*.{ts,tsx,js,jsx,py,go,rs,java}" -t code "\\b${oldName}\\b" .`;
      const output = execSync(rgCmd, { cwd: repo.repoPath, encoding: 'utf-8', timeout: 5000 });
      const files = output.trim().split('\n').filter(f => f.length > 0);
      
      for (const file of files) {
        const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (graphFiles.has(normalizedFile)) continue; // already covered by graph
        
        try {
          const content = await fs.readFile(path.join(repo.repoPath, normalizedFile), 'utf-8');
          const lines = content.split('\n');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              addEdit(normalizedFile, i + 1, lines[i].trim(), lines[i].replace(regex, new_name).trim(), 'text_search');
              astSearchEdits++;
              regex.lastIndex = 0; // reset regex
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* rg not available or no additional matches */ }
    
    // Step 4: Apply or preview
    const allChanges = Array.from(changes.values());
    const totalEdits = allChanges.reduce((sum, c) => sum + c.edits.length, 0);
    
    if (!dry_run) {
      // Apply edits to files
      for (const change of allChanges) {
        try {
          const fullPath = path.join(repo.repoPath, change.file_path);
          let content = await fs.readFile(fullPath, 'utf-8');
          const regex = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
          content = content.replace(regex, new_name);
          await fs.writeFile(fullPath, content, 'utf-8');
        } catch { /* skip failed files */ }
      }
    }
    
    return {
      status: 'success',
      old_name: oldName,
      new_name,
      files_affected: allChanges.length,
      total_edits: totalEdits,
      graph_edits: graphEdits,
      text_search_edits: astSearchEdits,
      changes: allChanges,
      applied: !dry_run,
    };
  }

  private async impact(repo: RepoHandle, params: {
    target?: string;
    name?: string;
    uid?: string;
    file_path?: string;
    direction: 'upstream' | 'downstream';
    maxDepth?: number;
    relationTypes?: string[];
    includeTests?: boolean;
    minConfidence?: number;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    const { direction } = params;
    const maxDepth = params.maxDepth || 3;
    const relationTypes = params.relationTypes && params.relationTypes.length > 0
      ? params.relationTypes
      : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
    const includeTests = params.includeTests ?? false;
    const minConfidence = params.minConfidence ?? 0;
    
    const relTypeFilter = relationTypes.map(t => `'${t}'`).join(', ');
    const confidenceFilter = minConfidence > 0 ? ` AND r.confidence >= ${minConfidence}` : '';
    
    const uid = params.uid?.trim();
    const name = (params.name || params.target || '').trim();
    const filePathHint = params.file_path?.trim();

    if (!uid && !name) {
      return { error: 'Either "name" (or legacy "target") or "uid" parameter is required.' };
    }

    let symbols: any[] = [];
    if (uid) {
      const escaped = uid.replace(/'/g, "''");
      symbols = await executeQuery(repo.id, `
        MATCH (n {id: '${escaped}'})
        RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath
        LIMIT 1
      `);
    } else {
      const escaped = name.replace(/'/g, "''");
      const isQualified = name.includes('/') || name.includes(':');

      let whereClause: string;
      if (filePathHint) {
        const fpEscaped = filePathHint.replace(/'/g, "''");
        whereClause = `WHERE n.name = '${escaped}' AND n.filePath CONTAINS '${fpEscaped}'`;
      } else if (isQualified) {
        whereClause = `WHERE n.id = '${escaped}' OR n.name = '${escaped}'`;
      } else {
        whereClause = `WHERE n.name = '${escaped}'`;
      }

      symbols = await executeQuery(repo.id, `
        MATCH (n) ${whereClause}
        RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath
        LIMIT 10
      `);
    }

    if (symbols.length === 0) return { error: `Target '${name || uid}' not found` };

    if (symbols.length > 1 && !uid) {
      return {
        status: 'ambiguous',
        message: `Found ${symbols.length} symbols matching '${name}'. Use uid or file_path to disambiguate.`,
        candidates: symbols.map((s: any) => ({
          uid: s.id || s[0],
          name: s.name || s[1],
          kind: s.type || s[2],
          filePath: s.filePath || s[3],
        })),
      };
    }

    const sym = symbols[0];
    const symId = sym.id || sym[0];
    
    const impacted: any[] = [];
    const visited = new Set<string>([symId]);
    let frontier = [symId];
    
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      
      // Batch frontier nodes into a single Cypher query per depth level
      const idList = frontier.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
      const query = direction === 'upstream'
        ? `MATCH (caller)-[r:CodeRelation]->(n) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, caller.id AS id, caller.name AS name, labels(caller) AS type, caller.filePath AS filePath, r.type AS relType, r.confidence AS confidence, r.reason AS reason`
        : `MATCH (n)-[r:CodeRelation]->(callee) WHERE n.id IN [${idList}] AND r.type IN [${relTypeFilter}]${confidenceFilter} RETURN n.id AS sourceId, callee.id AS id, callee.name AS name, labels(callee) AS type, callee.filePath AS filePath, r.type AS relType, r.confidence AS confidence, r.reason AS reason`;
      
      try {
        const related = await executeQuery(repo.id, query);
        
        for (const rel of related) {
          const relId = rel.id || rel[1];
          const filePath = rel.filePath || rel[4] || '';
          
          if (!includeTests && isTestFilePath(filePath)) continue;
          
          if (!visited.has(relId)) {
            visited.add(relId);
            nextFrontier.push(relId);
            impacted.push({
              depth,
              id: relId,
              name: rel.name || rel[2],
              type: rel.type || rel[3],
              filePath,
              relationType: rel.relType || rel[5],
              confidence: rel.confidence || rel[6] || 1.0,
              reason: rel.reason || rel[7] || '',
            });
          }
        }
      } catch { /* query failed for this depth level */ }
      
      frontier = nextFrontier;
    }
    
    const grouped: Record<number, any[]> = {};
    for (const item of impacted) {
      if (!grouped[item.depth]) grouped[item.depth] = [];
      grouped[item.depth].push(item);
    }
    
    return {
      target: {
        id: symId,
        name: sym.name || sym[1],
        type: sym.type || sym[2],
        filePath: sym.filePath || sym[3],
      },
      direction,
      impactedCount: impacted.length,
      byDepth: grouped,
    };
  }

  // ─── Direct Graph Queries (for resources.ts) ────────────────────

  /**
   * Query clusters (communities) directly from graph.
   * Used by getClustersResource — avoids legacy overview() dispatch.
   */
  async queryClusters(repoName?: string, limit = 100): Promise<{ clusters: any[] }> {
    const repo = this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const rawLimit = Math.max(limit * 5, 200);
      const clusters = await executeQuery(repo.id, `
        MATCH (c:Community)
        RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
        ORDER BY c.symbolCount DESC
        LIMIT ${rawLimit}
      `);
      const rawClusters = clusters.map((c: any) => ({
        id: c.id || c[0],
        label: c.label || c[1],
        heuristicLabel: c.heuristicLabel || c[2],
        cohesion: c.cohesion || c[3],
        symbolCount: c.symbolCount || c[4],
      }));
      return { clusters: this.aggregateClusters(rawClusters).slice(0, limit) };
    } catch {
      return { clusters: [] };
    }
  }

  /**
   * Query processes directly from graph.
   * Used by getProcessesResource — avoids legacy overview() dispatch.
   */
  async queryProcesses(repoName?: string, limit = 50): Promise<{ processes: any[] }> {
    const repo = this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    try {
      const processes = await executeQuery(repo.id, `
        MATCH (p:Process)
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        ORDER BY p.stepCount DESC
        LIMIT ${limit}
      `);
      return {
        processes: processes.map((p: any) => ({
          id: p.id || p[0],
          label: p.label || p[1],
          heuristicLabel: p.heuristicLabel || p[2],
          processType: p.processType || p[3],
          stepCount: p.stepCount || p[4],
        })),
      };
    } catch {
      return { processes: [] };
    }
  }

  /**
   * Query derived archetype clusters (flow signatures) from Process traces.
   * Used for “more than a map” architecture overview without changing graph schema.
   */
  async queryArchetypes(repoName?: string, options?: {
    limit?: number;
    examplesPerSignature?: number;
    minHttpConfidence?: number;
  }): Promise<{ report: ArchetypeReport }> {
    const repo = this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const limit = options?.limit ?? 25;
    const examplesPerSignature = options?.examplesPerSignature ?? 3;
    const minHttpConfidence = options?.minHttpConfidence ?? 0.9;

    const stepRows = await executeQuery(repo.id, `
      MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
      RETURN p.id AS processId,
             p.label AS label,
             p.heuristicLabel AS heuristicLabel,
             p.processType AS processType,
             p.stepCount AS stepCount,
             s.id AS nodeId,
             s.name AS name,
             s.filePath AS filePath,
             labels(s) AS type,
             r.step AS step
      ORDER BY processId, step
    `);

    const processesById = new Map<string, ProcessTraceInfo>();
    for (const row of stepRows) {
      const processId = row.processId || row[0];
      let proc = processesById.get(processId);
      if (!proc) {
        proc = {
          id: processId,
          label: row.label || row[1] || processId,
          heuristicLabel: row.heuristicLabel || row[2] || row.label || row[1] || processId,
          processType: row.processType || row[3] || '',
          stepCount: row.stepCount || row[4] || 0,
          steps: [],
        };
        processesById.set(processId, proc);
      }

      proc.steps.push({
        step: row.step || row[9] || 0,
        nodeId: row.nodeId || row[5],
        name: row.name || row[6] || '',
        filePath: row.filePath || row[7] || '',
        type: row.type || row[8] || '',
      });
    }

    for (const proc of processesById.values()) {
      proc.steps.sort((a, b) => a.step - b.step);
      if (!proc.stepCount) proc.stepCount = proc.steps.length;
    }

    const httpRows = await executeQuery(repo.id, `
      MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b)
      WHERE r.reason STARTS WITH 'http-' AND r.confidence >= ${minHttpConfidence}
      RETURN a.id AS sourceId, b.id AS targetId, r.reason AS reason, r.confidence AS confidence
    `);

    const httpEdges: HttpEdgeInfo[] = httpRows.map((r: any) => ({
      sourceId: r.sourceId || r[0],
      targetId: r.targetId || r[1],
      reason: r.reason || r[2],
      confidence: r.confidence || r[3] || 1.0,
    }));

    const report = buildArchetypeReport(Array.from(processesById.values()), httpEdges, {
      limit,
      examplesPerSignature,
      minHttpConfidence,
    });

    return { report };
  }

  /**
   * Query cluster detail (members) directly from graph.
   * Used by getClusterDetailResource.
   */
  async queryClusterDetail(name: string, repoName?: string): Promise<any> {
    const repo = this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const escaped = name.replace(/'/g, "''");
    const clusterQuery = `
      MATCH (c:Community)
      WHERE c.label = '${escaped}' OR c.heuristicLabel = '${escaped}'
      RETURN c.id AS id, c.label AS label, c.heuristicLabel AS heuristicLabel, c.cohesion AS cohesion, c.symbolCount AS symbolCount
    `;
    const clusters = await executeQuery(repo.id, clusterQuery);
    if (clusters.length === 0) return { error: `Cluster '${name}' not found` };

    const rawClusters = clusters.map((c: any) => ({
      id: c.id || c[0], label: c.label || c[1], heuristicLabel: c.heuristicLabel || c[2],
      cohesion: c.cohesion || c[3], symbolCount: c.symbolCount || c[4],
    }));

    let totalSymbols = 0, weightedCohesion = 0;
    for (const c of rawClusters) {
      const s = c.symbolCount || 0;
      totalSymbols += s;
      weightedCohesion += (c.cohesion || 0) * s;
    }

    const members = await executeQuery(repo.id, `
      MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
      WHERE c.label = '${escaped}' OR c.heuristicLabel = '${escaped}'
      RETURN DISTINCT n.name AS name, labels(n) AS type, n.filePath AS filePath
      LIMIT 30
    `);

    return {
      cluster: {
        id: rawClusters[0].id,
        label: rawClusters[0].heuristicLabel || rawClusters[0].label,
        heuristicLabel: rawClusters[0].heuristicLabel || rawClusters[0].label,
        cohesion: totalSymbols > 0 ? weightedCohesion / totalSymbols : 0,
        symbolCount: totalSymbols,
        subCommunities: rawClusters.length,
      },
      members: members.map((m: any) => ({
        name: m.name || m[0], type: m.type || m[1], filePath: m.filePath || m[2],
      })),
    };
  }

  /**
   * Query process detail (steps) directly from graph.
   * Used by getProcessDetailResource.
   */
  async queryProcessDetail(name: string, repoName?: string): Promise<any> {
    const repo = this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const escaped = name.replace(/'/g, "''");
    const processes = await executeQuery(repo.id, `
      MATCH (p:Process)
      WHERE p.label = '${escaped}' OR p.heuristicLabel = '${escaped}'
      RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
      LIMIT 1
    `);
    if (processes.length === 0) return { error: `Process '${name}' not found` };

    const proc = processes[0];
    const procId = proc.id || proc[0];
    const steps = await executeQuery(repo.id, `
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: '${procId}'})
      RETURN n.name AS name, labels(n) AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `);

    return {
      process: {
        id: procId, label: proc.label || proc[1], heuristicLabel: proc.heuristicLabel || proc[2],
        processType: proc.processType || proc[3], stepCount: proc.stepCount || proc[4],
      },
      steps: steps.map((s: any) => ({
        step: s.step || s[3], name: s.name || s[0], type: s.type || s[1], filePath: s.filePath || s[2],
      })),
    };
  }

  async disconnect(): Promise<void> {
    await closeKuzu(); // close all connections
    await disposeEmbedder();
    this.repos.clear();
    this.contextCache.clear();
    this.initializedRepos.clear();
  }
}
