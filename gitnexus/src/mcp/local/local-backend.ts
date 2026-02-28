/**
 * Local Backend (Multi-Repo)
 * 
 * Provides tool implementations using local .gitnexus/ indexes.
 * Supports multiple indexed repositories via a global registry.
 * KuzuDB connections are opened lazily per repo on first query.
 */

import fs from 'fs/promises';
import path from 'path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { initKuzu, executeQuery, closeKuzu, isKuzuReady } from '../core/kuzu-adapter.js';
import { embedQuery, getEmbeddingDims, disposeEmbedder } from '../core/embedder.js';
import { isGitRepo, getCurrentCommit, getGitRoot } from '../../storage/git.js';
import {
  getGlobalRegistryPath,
  listRegisteredRepos,
  type RegistryEntry,
} from '../../storage/repo-manager.js';
import { buildArchetypeReport, computeProcessArchetype, deriveLayerTag, type ArchetypeExample, type ArchetypeReport, type HttpEdgeInfo, type ProcessTraceInfo } from '../../core/derived/archetypes.js';
import { extractUiContractCard } from '../../core/derived/ui-contract.js';
import {
  buildEpisodeOverlay,
  clearEpisodeGraphState,
  loadEpisodeGraphState,
  parseEpisodeSpanTokens,
  recordEpisodeObservation,
  summarizeEpisodeGraphState,
  type EpisodeObservation,
  type EpisodeSymbolRef,
  type EpisodeProcessRef,
  type EpisodePrecedentRef,
} from './episode-graph.js';
import {
  loadEvidenceSpanSnapshot,
  summarizeEvidenceSpanSnapshot,
} from '../../core/ingestion/evidence-span-store.js';
import {
  loadStructuredSummarySnapshot,
  summarizeStructuredSummarySnapshot,
} from '../../core/ingestion/summary-overlay-store.js';
import {
  loadClosureTemplateSnapshot,
  summarizeClosureTemplateSnapshot,
} from '../../core/ingestion/closure-template-store.js';
import { parseWitnessPathIds } from '../../core/graph/edge-metadata.js';
import { GITNEXUS_TOOLS } from '../tools.js';
// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

const MCP_TOOL_NAME_SET = new Set(GITNEXUS_TOOLS.map(tool => tool.name));

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

function normalizeRepoRelativePath(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function normalizePathPrefix(repoPath: string, value: string): string {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) return '';

  // Allow callers to provide absolute paths; normalize to repo-relative prefixes when possible.
  if (path.isAbsolute(raw)) {
    const rel = path.relative(repoPath, raw).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) return normalizeRepoRelativePath(rel);
  }

  return normalizeRepoRelativePath(raw);
}

function parsePathPrefixes(repoPath: string, param: unknown): string[] {
  const raw = Array.isArray(param)
    ? param
    : typeof param === 'string'
      ? [param]
      : [];

  return Array.from(new Set(
    raw
      .map(p => normalizePathPrefix(repoPath, String(p || '')))
      .filter(Boolean)
  ));
}

function filePathTouchesPrefixes(filePath: string, pathPrefixes: string[]): boolean {
  if (pathPrefixes.length === 0) return true;
  const fp = normalizeRepoRelativePath(filePath);
  if (!fp) return false;

  for (const prefixRaw of pathPrefixes) {
    const prefix = prefixRaw.endsWith('/') ? prefixRaw : `${prefixRaw}/`;
    if (fp === prefixRaw) return true;
    if (fp.startsWith(prefix)) return true;
  }
  return false;
}

function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item || '').trim())
      .filter(Boolean);
  }

  const raw = String(value || '').trim();
  if (!raw) return [];

  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map(item => item.trim().replace(/^'+|'+$/g, '').replace(/^"+|"+$/g, ''))
      .filter(Boolean);
  }

  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/** Valid KuzuDB node labels for safe Cypher query construction */
const VALID_NODE_LABELS = new Set([
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement',
  'Community', 'Process', 'FeatureSlice', 'Gap', 'ContractShape', 'ContractField', 'CacheKey', 'DBTable', 'DBColumn', 'ValueNode', 'TestCase',
  'Struct', 'Enum', 'Macro', 'Typedef', 'Union',
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

  private tryLoadRepoFromDisk(repoParam: string): RepoHandle | null {
    const trimmed = repoParam.trim();
    if (!trimmed) return null;

    const gitRoot = getGitRoot(trimmed);
    const resolved = gitRoot ? path.resolve(gitRoot) : (existsSync(trimmed) ? path.resolve(trimmed) : null);
    if (!resolved) return null;

    const storagePath = path.join(resolved, '.gitnexus');
    const metaPath = path.join(storagePath, 'meta.json');
    if (!existsSync(metaPath)) return null;

    try {
      const raw = readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(raw) as any;

      const name = path.basename(resolved);
      const id = this.repoId(name, resolved, this.repos);
      const kuzuPath = path.join(storagePath, 'kuzu');

      const handle: RepoHandle = {
        id,
        name,
        repoPath: resolved,
        storagePath,
        kuzuPath,
        indexedAt: String(meta?.indexedAt || ''),
        lastCommit: String(meta?.lastCommit || ''),
        stats: meta?.stats || undefined,
      };

      this.repos.set(id, handle);

      const s = handle.stats || {};
      this.contextCache.set(id, {
        projectName: handle.name,
        stats: {
          fileCount: s.files || 0,
          functionCount: s.nodes || 0,
          communityCount: s.communities || 0,
          processCount: s.processes || 0,
        },
      });

      return handle;
    } catch {
      // If meta.json is corrupt or transiently unreadable, do not create a handle.
      return null;
    }
  }

  /**
   * Resolve which repo to use.
   * - If repoParam is given, match by name or path
   * - If only 1 repo, use it
   * - If 0 or multiple without param, throw with helpful message
   */
  resolveRepo(repoParam?: string): RepoHandle {
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

      // Worktree / sandbox-friendly mode: allow resolving a repo by absolute path
      // even if it was indexed with --no-registry and therefore is not in ~/.gitnexus/registry.json.
      const loaded = this.tryLoadRepoFromDisk(repoParam);
      if (loaded) return loaded;

      // Match by partial name
      for (const handle of this.repos.values()) {
        if (handle.name.toLowerCase().includes(paramLower)) return handle;
      }

      if (this.repos.size === 0) {
        throw new Error('No indexed repositories. Run: gitnexus analyze');
      }

      const names = [...this.repos.values()].map(h => h.name);
      throw new Error(`Repository "${repoParam}" not found. Available: ${names.join(', ')}`);
    }

    if (this.repos.size === 0) {
      throw new Error('No indexed repositories. Run: gitnexus analyze');
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
   * Ensure a repo handle is refreshed from on-disk .gitnexus/meta.json if changed.
   * Used by MCP resources path to avoid stale metadata when analyze ran with --no-registry.
   */
  async refreshRepoMetaForResource(repoParam?: string): Promise<void> {
    const repo = this.resolveRepo(repoParam);
    await this.refreshRepoMetaIfNeeded(repo, true);
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
  private async refreshRepoMetaIfNeeded(repo: RepoHandle, forceCheck = false): Promise<void> {
    const now = Date.now();
    const lastCheckedAt = this.repoMetaCheckedAtMs.get(repo.id) ?? 0;
    if (!forceCheck && now - lastCheckedAt < 2000) return;
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
    await this.refreshRepoMetaIfNeeded(repo, true);
    const indexStatus = await this.getIndexStatus(repo);

    let result: any;
    switch (method) {
      case 'query':
        result = await this.query(repo, params);
        break;
      case 'query_mode':
        result = await this.queryMode(repo, params);
        break;
      case 'mode_router':
        result = await this.modeRouter(repo, params);
        break;
      case 'implement_mode':
        result = await this.implementMode(repo, params);
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
      case 'ui_contract':
        result = await this.uiContract(repo, params);
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
      case 'review_mode':
        result = await this.reviewMode(repo, params);
        break;
      case 'debug_mode':
        result = await this.debugMode(repo, params);
        break;
      case 'episode_state':
        result = await this.episodeState(repo, params);
        break;
      case 'episode_update':
        result = await this.episodeUpdate(repo, params);
        break;
      case 'evidence_spans':
        result = await this.evidenceSpans(repo, params);
        break;
      case 'summary_overlay':
        result = await this.summaryOverlay(repo, params);
        break;
      case 'closure_templates':
        result = await this.closureTemplates(repo, params);
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
        if (MCP_TOOL_NAME_SET.has(method)) {
          throw new Error(`Tool handler not implemented: ${method}`);
        }
        throw new Error(`Unknown tool: ${method}`);
    }

    try {
      if (
        method !== 'episode_state'
        && method !== 'episode_update'
        && method !== 'evidence_spans'
        && method !== 'summary_overlay'
        && method !== 'closure_templates'
      ) {
        await this.recordEpisodeFromTool(repo, method, params, result);
      }
    } catch {
      // Episode sidecar is best-effort and must never break normal tool execution.
    }

    if (indexStatus.isStale && result && typeof result === 'object' && !Array.isArray(result)) {
      result.index_status = indexStatus;
    }

    return result;
  }

  private toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .map(item => String(item || '').trim())
        .filter(Boolean);
    }
    if (typeof value === 'string') {
      const cleaned = value.trim();
      return cleaned ? [cleaned] : [];
    }
    return [];
  }

  private async recordEpisodeFromTool(
    repo: RepoHandle,
    method: string,
    params: any,
    result: any,
  ): Promise<void> {
    if (!result || typeof result !== 'object') return;

    const openedSymbols: EpisodeSymbolRef[] = [];
    const openedProcesses: EpisodeProcessRef[] = [];
    const openedSpans: Array<{ filePath: string; startLine?: number; endLine?: number; sourceSymbolId?: string; sourceProcessId?: string }> = [];
    const chosenPrecedents: EpisodePrecedentRef[] = [];
    const editFiles: string[] = [];
    const witnessPaths: string[] = [];
    const failingTests: string[] = [];
    const candidateHypotheses: string[] = [];
    const errorStrings: string[] = [];

    const addFile = (filePath: unknown) => {
      const value = String(filePath || '').trim().replace(/\\/g, '/');
      if (!value) return;
      editFiles.push(value);
    };

    const addSpan = (item: any, sourceSymbolId?: string, sourceProcessId?: string) => {
      const filePath = String(item?.filePath || '').trim().replace(/\\/g, '/');
      if (!filePath) return;
      const startRaw = item?.startLine ?? item?.line ?? item?.start_line;
      const endRaw = item?.endLine ?? item?.end_line;
      const startLine = Number.isFinite(Number(startRaw)) ? Number(startRaw) : undefined;
      const endLine = Number.isFinite(Number(endRaw)) ? Number(endRaw) : undefined;
      openedSpans.push({
        filePath,
        ...(startLine && startLine > 0 ? { startLine } : {}),
        ...(endLine && endLine > 0 ? { endLine } : {}),
        ...(sourceSymbolId ? { sourceSymbolId } : {}),
        ...(sourceProcessId ? { sourceProcessId } : {}),
      });
    };

    const addSymbol = (item: any, processId?: string) => {
      const symbolId = String(item?.id || item?.uid || '').trim();
      if (!symbolId) return;
      openedSymbols.push({
        symbolId,
        name: String(item?.name || '').trim() || undefined,
        kind: String(item?.type || item?.kind || '').trim() || undefined,
        filePath: String(item?.filePath || '').trim().replace(/\\/g, '/') || undefined,
        startLine: Number.isFinite(Number(item?.startLine)) ? Number(item.startLine) : undefined,
        endLine: Number.isFinite(Number(item?.endLine)) ? Number(item.endLine) : undefined,
        ...(processId ? { processId } : {}),
      });
      addSpan(item, symbolId, processId);
    };

    const addProcess = (item: any) => {
      const processId = String(item?.id || '').trim();
      if (!processId) return;
      openedProcesses.push({
        processId,
        name: String(item?.summary || item?.name || item?.label || '').trim() || undefined,
        stepCount: Number.isFinite(Number(item?.step_count ?? item?.stepCount))
          ? Number(item?.step_count ?? item?.stepCount)
          : undefined,
      });
    };

    if (method === 'query') {
      for (const proc of Array.isArray(result.processes) ? result.processes.slice(0, 30) : []) {
        addProcess(proc);
      }
      for (const sym of Array.isArray(result.process_symbols) ? result.process_symbols.slice(0, 120) : []) {
        const processId = String(sym?.process_id || '').trim() || undefined;
        addSymbol(sym, processId);
      }
      for (const def of Array.isArray(result.definitions) ? result.definitions.slice(0, 40) : []) {
        addSymbol(def);
      }
    }

    if (method === 'query_mode') {
      const processes = Array.isArray(result?.query_mode?.processes) ? result.query_mode.processes : [];
      const symbols = Array.isArray(result?.query_mode?.symbols) ? result.query_mode.symbols : [];
      const hops = Array.isArray(result?.query_mode?.action_hints?.hops) ? result.query_mode.action_hints.hops : [];

      for (const proc of processes.slice(0, 30)) addProcess(proc);
      for (const symbol of symbols.slice(0, 120)) addSymbol(symbol);
      for (const hop of hops.slice(0, 30)) {
        const chain = [hop?.ui?.name, hop?.endpoint?.name, hop?.controller?.name].filter(Boolean).join(' -> ');
        if (chain) witnessPaths.push(chain);
      }
    }

    if (method === 'implement_mode') {
      const symbols = Array.isArray(result?.implement_mode?.query_head?.symbols) ? result.implement_mode.query_head.symbols : [];
      const companionFiles = Array.isArray(result?.implement_mode?.companion_files) ? result.implement_mode.companion_files : [];
      const writePlan = Array.isArray(result?.implement_mode?.write_plan) ? result.implement_mode.write_plan : [];
      const checks = Array.isArray(result?.implement_mode?.action_hints?.checks) ? result.implement_mode.action_hints.checks : [];
      const hops = Array.isArray(result?.implement_mode?.action_hints?.hops) ? result.implement_mode.action_hints.hops : [];
      const hypotheses = Array.isArray(result?.implement_mode?.hypotheses) ? result.implement_mode.hypotheses : [];

      for (const symbol of symbols.slice(0, 120)) addSymbol(symbol);
      for (const file of companionFiles.slice(0, 40)) addFile(file?.filePath);
      for (const step of writePlan.slice(0, 40)) addSpan(step, String(step?.uid || '').trim() || undefined);
      for (const check of checks.slice(0, 40)) {
        const text = String(check || '').trim();
        if (text) witnessPaths.push(`check:${text}`);
      }
      for (const hop of hops.slice(0, 30)) {
        const chain = [hop?.ui?.name, hop?.endpoint?.name, hop?.controller?.name].filter(Boolean).join(' -> ');
        if (chain) witnessPaths.push(chain);
      }
      for (const hypothesis of hypotheses.slice(0, 20)) {
        const text = String(hypothesis || '').trim();
        if (text) witnessPaths.push(`hypothesis:${text}`);
      }
    }

    if (method === 'mode_router') {
      const selectedMode = String(result?.mode_router?.selected_mode || '').trim();
      const routed = result?.mode_router?.result || {};
      const routeTrace = result?.mode_router?.route_trace || {};
      const unified = result?.mode_router?.unified || {};

      if (selectedMode) witnessPaths.push(`mode:${selectedMode}`);
      if (routeTrace?.fallback_applied === true) witnessPaths.push('mode_router:fallback_applied');

      const routeCandidates = Array.isArray(routeTrace?.candidates) ? routeTrace.candidates : [];
      for (const candidate of routeCandidates.slice(0, 5)) {
        const mode = String(candidate?.mode || '').trim();
        const reasons = Array.isArray(candidate?.reasons)
          ? candidate.reasons
            .map((reason: unknown) => String(reason || '').trim())
            .filter(Boolean)
            .slice(0, 3)
          : [];
        if (mode && reasons.length > 0) witnessPaths.push(`route-candidate:${mode}:${reasons.join(' | ')}`);
      }

      const recommendedHandoff = String(unified?.recommended_handoff?.tool || '').trim();
      if (recommendedHandoff) witnessPaths.push(`handoff:${recommendedHandoff}`);

      const unifiedHypotheses = Array.isArray(unified?.hypotheses) ? unified.hypotheses : [];
      for (const hypothesis of unifiedHypotheses.slice(0, 20)) {
        const text = String(hypothesis || '').trim();
        if (!text) continue;
        candidateHypotheses.push(text);
        witnessPaths.push(`hypothesis:${text}`);
      }

      for (const testName of this.toStringArray(params?.failing_tests).slice(0, 40)) {
        failingTests.push(testName);
        witnessPaths.push(`failing-test:${testName}`);
      }
      for (const errorText of this.toStringArray(params?.error_strings).slice(0, 40)) {
        errorStrings.push(errorText);
      }

      const routedSymbols = [
        ...(Array.isArray(routed?.query_mode?.symbols) ? routed.query_mode.symbols : []),
        ...(Array.isArray(routed?.implement_mode?.query_head?.symbols) ? routed.implement_mode.query_head.symbols : []),
        ...(Array.isArray(routed?.debug?.anchors?.top_symbols) ? routed.debug.anchors.top_symbols : []),
        ...(Array.isArray(routed?.changed_symbols) ? routed.changed_symbols : []),
      ];
      for (const symbol of routedSymbols.slice(0, 100)) addSymbol(symbol);

      const routedHops = [
        ...(Array.isArray(routed?.query_mode?.action_hints?.hops) ? routed.query_mode.action_hints.hops : []),
        ...(Array.isArray(routed?.implement_mode?.action_hints?.hops) ? routed.implement_mode.action_hints.hops : []),
        ...(Array.isArray(routed?.debug?.anchors?.hops) ? routed.debug.anchors.hops : []),
      ];
      for (const hop of routedHops.slice(0, 30)) {
        const chain = [hop?.ui?.name, hop?.endpoint?.name, hop?.controller?.name].filter(Boolean).join(' -> ');
        if (chain) witnessPaths.push(chain);
      }

      const routedFiles = [
        ...(Array.isArray(routed?.implement_mode?.companion_files) ? routed.implement_mode.companion_files : []),
        ...(Array.isArray(routed?.changed_files) ? routed.changed_files : []),
      ];
      for (const file of routedFiles.slice(0, 40)) addFile(file?.filePath);
    }

    if (method === 'context' && result.status === 'found') {
      if (result.symbol) addSymbol(result.symbol);
      for (const proc of Array.isArray(result.processes) ? result.processes.slice(0, 20) : []) {
        addProcess({ id: proc.id, name: proc.name, step_count: proc.step_count });
      }
    }

    if (method === 'impact') {
      if (result.target) addSymbol(result.target);
      const byDepth = result.byDepth || {};
      for (const key of Object.keys(byDepth)) {
        const rows = Array.isArray(byDepth[key]) ? byDepth[key] : [];
        for (const row of rows.slice(0, 40)) {
          addSymbol(row);
        }
      }
    }

    if (method === 'detect_changes') {
      const changedSymbols = Array.isArray(result.changed_symbols) ? result.changed_symbols : [];
      for (const symbol of changedSymbols.slice(0, 80)) {
        addSymbol(symbol);
        addFile(symbol?.filePath);
      }
    }

    if (method === 'review_mode') {
      const changedFiles = Array.isArray(result.changed_files) ? result.changed_files : [];
      for (const file of changedFiles) addFile(file?.filePath);
      const changedSymbols = Array.isArray(result.changed_symbols) ? result.changed_symbols : [];
      for (const symbol of changedSymbols.slice(0, 100)) addSymbol(symbol);
      const suggestedTests = Array.isArray(result.suggested_tests) ? result.suggested_tests : [];
      for (const test of suggestedTests.slice(0, 30)) {
        const name = String(test?.name || test?.test || '').trim();
        if (name) witnessPaths.push(`test:${name}`);
      }
    }

    if (method === 'debug_mode') {
      const topSymbols = Array.isArray(result?.debug?.anchors?.top_symbols) ? result.debug.anchors.top_symbols : [];
      for (const symbol of topSymbols.slice(0, 60)) addSymbol(symbol);

      const hops = Array.isArray(result?.debug?.anchors?.hops) ? result.debug.anchors.hops : [];
      for (const hop of hops.slice(0, 30)) {
        const chain = [hop?.ui?.name, hop?.endpoint?.name, hop?.controller?.name].filter(Boolean).join(' -> ');
        if (chain) witnessPaths.push(chain);
      }

      const hypotheses = Array.isArray(result?.debug?.hypotheses) ? result.debug.hypotheses : [];
      for (const hypothesis of hypotheses.slice(0, 20)) {
        const text = String(hypothesis || '').trim();
        if (!text) continue;
        candidateHypotheses.push(text);
        witnessPaths.push(`hypothesis:${text}`);
      }
    }

    if (method === 'action_plan') {
      const files = Array.isArray(result.files) ? result.files : [];
      for (const file of files.slice(0, 50)) {
        addFile(file?.filePath);
        const anchors = Array.isArray(file?.anchors) ? file.anchors : [];
        for (const anchor of anchors.slice(0, 5)) addSpan(anchor);
      }
      const hops = Array.isArray(result.hops) ? result.hops : [];
      for (const hop of hops.slice(0, 30)) {
        const ui = hop?.ui;
        const endpoint = hop?.endpoint;
        const controller = hop?.controller;
        const chain = [ui?.name, endpoint?.name, controller?.name].filter(Boolean).join(' -> ');
        if (chain) witnessPaths.push(chain);
      }
    }

    if (method === 'precedents') {
      const precedents = Array.isArray(result.precedents) ? result.precedents : [];
      for (const precedent of precedents.slice(0, 40)) {
        const anchor = precedent?.anchor || {};
        const anchorUid = String(anchor?.uid || anchor?.entry?.uid || '').trim() || undefined;
        const processId = String(anchor?.processId || anchor?.id || '').trim() || undefined;
        const signature = String(precedent?.signature || '').trim() || undefined;
        chosenPrecedents.push({
          kind: String(precedent?.kind || '').trim() || undefined,
          signature,
          anchorUid,
          processId,
        });
      }
    }

    if (method === 'ui_contract') {
      const filePath = String(result?.filePath || params?.file_path || '').trim();
      if (filePath) addSpan({ filePath });
    }

    if (result.error) {
      const text = String(result.error).trim();
      if (text) errorStrings.push(text);
    }
    const targetBranch = String(params?.target_branch || '').trim() || undefined;
    const taskId = String(params?.task_id || params?.task || '').trim() || undefined;

    if (
      openedSymbols.length === 0 &&
      openedProcesses.length === 0 &&
      openedSpans.length === 0 &&
      chosenPrecedents.length === 0 &&
      editFiles.length === 0 &&
      witnessPaths.length === 0 &&
      failingTests.length === 0 &&
      candidateHypotheses.length === 0 &&
      errorStrings.length === 0 &&
      !targetBranch &&
      !taskId
    ) {
      return;
    }

    const observation: EpisodeObservation = {
      tool: method,
      ...(targetBranch ? { targetBranch } : {}),
      ...(taskId ? { taskId } : {}),
      ...(openedSymbols.length > 0 ? { openedSymbols } : {}),
      ...(openedProcesses.length > 0 ? { openedProcesses } : {}),
      ...(openedSpans.length > 0 ? { openedSpans } : {}),
      ...(chosenPrecedents.length > 0 ? { chosenPrecedents } : {}),
      ...(editFiles.length > 0 ? { editFiles } : {}),
      ...(witnessPaths.length > 0 ? { witnessPaths } : {}),
      ...(failingTests.length > 0 ? { failingTests } : {}),
      ...(candidateHypotheses.length > 0 ? { candidateHypotheses } : {}),
      ...(errorStrings.length > 0 ? { errorStrings } : {}),
    };

    await recordEpisodeObservation(repo.storagePath, observation);
  }

  private async episodeState(repo: RepoHandle, params: {
    limit?: number;
    include_events?: boolean;
  }): Promise<any> {
    const limit = Number.isFinite(Number(params.limit)) ? Number(params.limit) : 10;
    const includeEvents = params.include_events !== false;
    const state = await loadEpisodeGraphState(repo.storagePath);
    return {
      status: 'ok',
      repo: repo.name,
      episode: summarizeEpisodeGraphState(state, { limit, includeEvents }),
    };
  }

  private async episodeUpdate(repo: RepoHandle, params: {
    clear?: boolean;
    target_branch?: string;
    task_id?: string;
    accepted_hypotheses?: string[];
    rejected_hypotheses?: string[];
    candidate_hypotheses?: string[];
    failing_tests?: string[];
    error_strings?: string[];
    witness_paths?: string[];
    edit_files?: string[];
    opened_spans?: string[];
    limit?: number;
    include_events?: boolean;
  }): Promise<any> {
    const limit = Number.isFinite(Number(params.limit)) ? Number(params.limit) : 10;
    const includeEvents = params.include_events !== false;

    if (params.clear === true) {
      const cleared = await clearEpisodeGraphState(repo.storagePath);
      return {
        status: 'ok',
        repo: repo.name,
        cleared: true,
        episode: summarizeEpisodeGraphState(cleared, { limit, includeEvents }),
      };
    }

    const openedSpanTokens = this.toStringArray(params.opened_spans);
    const openedSpans = parseEpisodeSpanTokens(openedSpanTokens);

    const observation: EpisodeObservation = {
      tool: 'episode_update',
      targetBranch: String(params.target_branch || '').trim() || undefined,
      taskId: String(params.task_id || '').trim() || undefined,
      acceptedHypotheses: this.toStringArray(params.accepted_hypotheses),
      rejectedHypotheses: this.toStringArray(params.rejected_hypotheses),
      candidateHypotheses: this.toStringArray(params.candidate_hypotheses),
      failingTests: this.toStringArray(params.failing_tests),
      errorStrings: this.toStringArray(params.error_strings),
      witnessPaths: this.toStringArray(params.witness_paths),
      editFiles: this.toStringArray(params.edit_files),
      ...(openedSpans.length > 0 ? { openedSpans } : {}),
    };

    const updated = await recordEpisodeObservation(repo.storagePath, observation);
    return {
      status: 'ok',
      repo: repo.name,
      updated: true,
      episode: summarizeEpisodeGraphState(updated, { limit, includeEvents }),
    };
  }

  private async evidenceSpans(repo: RepoHandle, params: {
    limit?: number;
    symbol_id?: string;
    file_path?: string;
    include_nodes?: boolean;
    include_edges?: boolean;
  }): Promise<any> {
    const limit = Number.isFinite(Number(params.limit)) ? Number(params.limit) : 20;
    const snapshot = await loadEvidenceSpanSnapshot(repo.storagePath);
    const evidence = summarizeEvidenceSpanSnapshot(snapshot, {
      limit,
      symbolId: String(params.symbol_id || '').trim(),
      filePath: String(params.file_path || '').trim(),
      includeNodes: params.include_nodes !== false,
      includeEdges: params.include_edges !== false,
    });

    return {
      status: 'ok',
      repo: repo.name,
      evidence,
    };
  }

  private async summaryOverlay(repo: RepoHandle, params: {
    limit?: number;
    level?: string;
    entity_id?: string;
    file_path?: string;
    query?: string;
  }): Promise<any> {
    const limit = Number.isFinite(Number(params.limit)) ? Number(params.limit) : 20;
    const snapshot = await loadStructuredSummarySnapshot(repo.storagePath);
    const summaries = summarizeStructuredSummarySnapshot(snapshot, {
      limit,
      level: String(params.level || '').trim(),
      entityId: String(params.entity_id || '').trim(),
      filePath: String(params.file_path || '').trim(),
      query: String(params.query || '').trim(),
    });

    return {
      status: 'ok',
      repo: repo.name,
      summaries,
    };
  }

  private async closureTemplates(repo: RepoHandle, params: {
    limit?: number;
    slice_type?: string;
    template_key?: string;
    query?: string;
  }): Promise<any> {
    const limit = Number.isFinite(Number(params.limit)) ? Number(params.limit) : 20;
    const snapshot = await loadClosureTemplateSnapshot(repo.storagePath);
    const templates = summarizeClosureTemplateSnapshot(snapshot, {
      limit,
      sliceType: String(params.slice_type || '').trim(),
      templateKey: String(params.template_key || '').trim(),
      query: String(params.query || '').trim(),
    });

    return {
      status: 'ok',
      repo: repo.name,
      templates,
    };
  }

  private async archetypes(repo: RepoHandle, params: {
    limit?: number;
    examples?: number;
    min_http_confidence?: number;
    path_prefixes?: string[];
    repo?: string;
  }): Promise<{ report: ArchetypeReport }> {
    return this.queryArchetypes(repo.id, {
      limit: params.limit,
      examplesPerSignature: params.examples,
      minHttpConfidence: params.min_http_confidence,
      path_prefixes: params.path_prefixes,
    });
  }

  private async ensureArchetypeIndex(
    repo: RepoHandle,
    minHttpConfidence = 0.9,
    pathPrefixesParam?: unknown
  ): Promise<{ byProcessId: Map<string, { signature: string; example: ArchetypeExample }>; bySignature: Map<string, ArchetypeExample[]> }> {
    const scopePrefixes = parsePathPrefixes(repo.repoPath, pathPrefixesParam);
    const scopeKey = scopePrefixes.length > 0 ? scopePrefixes.slice().sort().join('|') : '';
    const cacheKey = `${repo.id}::${minHttpConfidence}::${scopeKey}`;

    const cached = this.archetypeIndexCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.builtAtMs < 15000) {
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
      if (scopePrefixes.length > 0 && !proc.steps.some(s => filePathTouchesPrefixes(s.filePath, scopePrefixes))) {
        continue;
      }
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

    this.archetypeIndexCache.set(cacheKey, { builtAtMs: now, minHttpConfidence, byProcessId, bySignature });
    return { byProcessId, bySignature };
  }

  private async precedents(repo: RepoHandle, params: {
    query: string;
    anchor_uid?: string;
    limit?: number;
    examples?: number;
    min_http_confidence?: number;
    path_prefixes?: string[];
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
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);

    const index = await this.ensureArchetypeIndex(repo, minHttpConfidence, pathPrefixes);

    const scopeClauseUiOrController = (() => {
      if (pathPrefixes.length === 0) return null;
      const clauses = pathPrefixes.map(p => {
        const esc = String(p || '').replace(/'/g, "''");
        const pref = esc.endsWith('/') ? esc : `${esc}/`;
        return `(ui.filePath STARTS WITH '${pref}' OR ui.filePath = '${esc}' OR c.filePath STARTS WITH '${pref}' OR c.filePath = '${esc}')`;
      });
      return `(${clauses.join(' OR ')})`;
    })();

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

    type SliceMember = {
      nodeId: string;
      nodeName: string;
      filePath: string;
      role: string;
    };

    type SliceSummary = {
      id: string;
      label: string;
      heuristicLabel: string;
      sliceType: string;
      anchorId: string;
      anchorName: string;
      closureSlots: string[];
      closedSlots: string[];
      closureScore: number;
      members: SliceMember[];
      roles: string[];
      memberFiles: string[];
      searchText: string;
    };

    const toTokenSet = (value: string): Set<string> => {
      return new Set(
        getQueryTokens(value)
          .map(t => t.toLowerCase())
          .filter(Boolean),
      );
    };

    const jaccard = (left: Iterable<string>, right: Iterable<string>): number => {
      const a = new Set(Array.from(left).map(v => String(v || '').trim()).filter(Boolean));
      const b = new Set(Array.from(right).map(v => String(v || '').trim()).filter(Boolean));
      if (a.size === 0 || b.size === 0) return 0;

      let intersection = 0;
      for (const value of a) {
        if (b.has(value)) intersection++;
      }

      const union = a.size + b.size - intersection;
      if (union <= 0) return 0;
      return intersection / union;
    };

    const extractSliceRoleFromReason = (reason: string): string => {
      const raw = String(reason || '').trim();
      if (!raw.startsWith('feature-slice:')) return '';
      return raw.slice('feature-slice:'.length).trim();
    };

    const loadSliceSummaries = async (): Promise<{
      byId: Map<string, SliceSummary>;
      byMemberNodeId: Map<string, Set<string>>;
      byAnchorNodeId: Map<string, Set<string>>;
      inScope: SliceSummary[];
    }> => {
      let sliceRows: any[] = [];
      let memberRows: any[] = [];
      try {
        sliceRows = await executeQuery(repo.id, `
          MATCH (s:FeatureSlice)
          RETURN s.id AS sliceId,
                 s.label AS label,
                 s.heuristicLabel AS heuristicLabel,
                 s.sliceType AS sliceType,
                 s.anchorId AS anchorId,
                 s.anchorName AS anchorName,
                 s.closureSlots AS closureSlots,
                 s.closedSlots AS closedSlots,
                 s.closureScore AS closureScore
          LIMIT 4000
        `);
      } catch {
        return {
          byId: new Map(),
          byMemberNodeId: new Map(),
          byAnchorNodeId: new Map(),
          inScope: [],
        };
      }

      try {
        memberRows = await executeQuery(repo.id, `
          MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
          WHERE r.reason STARTS WITH 'feature-slice:'
          RETURN s.id AS sliceId,
                 n.id AS nodeId,
                 n.name AS nodeName,
                 n.filePath AS filePath,
                 r.reason AS reason
          LIMIT 20000
        `);
      } catch {
        memberRows = [];
      }

      const byId = new Map<string, SliceSummary>();
      for (const row of sliceRows) {
        const id = String(row.sliceId || row[0] || '').trim();
        if (!id) continue;
        byId.set(id, {
          id,
          label: String(row.label || row[1] || '').trim(),
          heuristicLabel: String(row.heuristicLabel || row[2] || '').trim(),
          sliceType: String(row.sliceType || row[3] || '').trim(),
          anchorId: String(row.anchorId || row[4] || '').trim(),
          anchorName: String(row.anchorName || row[5] || '').trim(),
          closureSlots: parseStringList(row.closureSlots ?? row[6]),
          closedSlots: parseStringList(row.closedSlots ?? row[7]),
          closureScore: Number(row.closureScore ?? row[8] ?? 0) || 0,
          members: [],
          roles: [],
          memberFiles: [],
          searchText: '',
        });
      }

      const byMemberNodeId = new Map<string, Set<string>>();
      const byAnchorNodeId = new Map<string, Set<string>>();

      for (const slice of byId.values()) {
        if (!slice.anchorId) continue;
        const list = byAnchorNodeId.get(slice.anchorId) || new Set<string>();
        list.add(slice.id);
        byAnchorNodeId.set(slice.anchorId, list);
      }

      for (const row of memberRows) {
        const sliceId = String(row.sliceId || row[0] || '').trim();
        const nodeId = String(row.nodeId || row[1] || '').trim();
        if (!sliceId || !nodeId) continue;
        const slice = byId.get(sliceId);
        if (!slice) continue;

        const reason = String(row.reason || row[4] || '').trim();
        const role = extractSliceRoleFromReason(reason);
        if (!role) continue;

        const filePath = String(row.filePath || row[3] || '').trim().replace(/\\/g, '/');
        slice.members.push({
          nodeId,
          nodeName: String(row.nodeName || row[2] || '').trim(),
          filePath,
          role,
        });

        const memberSet = byMemberNodeId.get(nodeId) || new Set<string>();
        memberSet.add(sliceId);
        byMemberNodeId.set(nodeId, memberSet);
      }

      for (const slice of byId.values()) {
        const roles = new Set<string>();
        const files = new Set<string>();
        const searchTokens: string[] = [
          slice.label,
          slice.heuristicLabel,
          slice.anchorName,
          slice.anchorId,
          slice.sliceType,
        ];

        for (const member of slice.members) {
          if (member.role) roles.add(member.role);
          if (member.filePath) files.add(normalizeRepoRelativePath(member.filePath));
          if (member.nodeName) searchTokens.push(member.nodeName);
          if (member.filePath) searchTokens.push(member.filePath);
        }

        slice.roles = Array.from(roles).sort();
        slice.memberFiles = Array.from(files).sort();
        slice.searchText = searchTokens.join(' ').toLowerCase();
      }

      const inScope = Array.from(byId.values()).filter(slice => {
        if (pathPrefixes.length === 0) return true;
        return slice.memberFiles.some(filePath => filePathTouchesPrefixes(filePath, pathPrefixes));
      });

      return { byId, byMemberNodeId, byAnchorNodeId, inScope };
    };

    const loadCochangeMap = async (): Promise<Map<string, Map<string, number>>> => {
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (a:File)-[r:CodeRelation {type: 'CO_CHANGES_WITH'}]->(b:File)
          RETURN a.filePath AS sourceFilePath,
                 b.filePath AS targetFilePath,
                 r.confidence AS confidence
          LIMIT 30000
        `);
      } catch {
        return new Map();
      }

      const graph = new Map<string, Map<string, number>>();
      for (const row of rows) {
        const source = normalizeRepoRelativePath(String(row.sourceFilePath || row[0] || ''));
        const target = normalizeRepoRelativePath(String(row.targetFilePath || row[1] || ''));
        if (!source || !target) continue;

        if (pathPrefixes.length > 0) {
          const touchesScope = filePathTouchesPrefixes(source, pathPrefixes) || filePathTouchesPrefixes(target, pathPrefixes);
          if (!touchesScope) continue;
        }

        const confidence = Number(row.confidence ?? row[2] ?? 0) || 0;
        const neighbors = graph.get(source) || new Map<string, number>();
        const previous = neighbors.get(target) || 0;
        if (confidence > previous) neighbors.set(target, confidence);
        graph.set(source, neighbors);
      }

      return graph;
    };

    const cochangeScoreForSlices = (
      leftFiles: string[],
      rightFiles: string[],
      cochangeMap: Map<string, Map<string, number>>,
    ): { score: number; pairCount: number } => {
      if (leftFiles.length === 0 || rightFiles.length === 0) return { score: 0, pairCount: 0 };
      let pairCount = 0;
      let confidenceSum = 0;

      for (const leftFile of leftFiles) {
        const neighbors = cochangeMap.get(leftFile);
        if (!neighbors || neighbors.size === 0) continue;
        for (const rightFile of rightFiles) {
          const confidence = neighbors.get(rightFile);
          if (!confidence || confidence <= 0) continue;
          pairCount += 1;
          confidenceSum += confidence;
        }
      }

      if (pairCount === 0) return { score: 0, pairCount: 0 };
      return { score: Math.min(1, confidenceSum / pairCount), pairCount };
    };

    const reduceSliceForOutput = (slice: SliceSummary, extra?: { score?: number; evidence?: any }): any => {
      const out: any = {
        uid: slice.id,
        label: slice.label || slice.heuristicLabel || slice.id,
        slice_type: slice.sliceType,
        anchor_id: slice.anchorId,
        anchor_name: slice.anchorName,
        closure_score: Number(slice.closureScore.toFixed(3)),
        closure_slots: slice.closureSlots,
        closed_slots: slice.closedSlots,
        roles: slice.roles,
        member_count: slice.members.length,
        member_files: slice.memberFiles.slice(0, 10),
      };

      if (extra?.score !== undefined) out.score = Number(extra.score.toFixed(3));
      if (extra?.evidence) out.evidence = extra.evidence;
      return out;
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
          WHERE w.confidence >= ${minHttpConfidence} AND w.reason STARTS WITH 'laravel-endpoint:'${scopeClauseUiOrController ? ` AND ${scopeClauseUiOrController}` : ''}
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

    const buildSliceSignature = (slice: SliceSummary): string => {
      const slots = [...slice.closedSlots].sort();
      const roles = [...slice.roles].sort();
      const slotPart = slots.length > 0 ? slots.join('+') : 'none';
      const rolePart = roles.length > 0 ? roles.join('+') : 'none';
      return `Slice:${slice.sliceType} → Slots:${slotPart} → Roles:${rolePart}`;
    };

    const buildSlicePrecedents = (
      anchorSliceScores: Map<string, number>,
      scopedSlices: SliceSummary[],
      byId: Map<string, SliceSummary>,
      cochangeMap: Map<string, Map<string, number>>,
    ): any[] => {
      if (anchorSliceScores.size === 0) return [];

      const queryTokenSet = toTokenSet(queryText);
      const scopedByType = new Map<string, SliceSummary[]>();
      for (const slice of scopedSlices) {
        const list = scopedByType.get(slice.sliceType) || [];
        list.push(slice);
        scopedByType.set(slice.sliceType, list);
      }

      const anchorIds = Array.from(anchorSliceScores.entries())
        .sort((left, right) => {
          if (right[1] !== left[1]) return right[1] - left[1];
          return left[0].localeCompare(right[0]);
        })
        .slice(0, limit)
        .map(([sliceId]) => sliceId);

      const out: any[] = [];
      for (const anchorId of anchorIds) {
        const anchor = byId.get(anchorId);
        if (!anchor) continue;
        if (!scopedSlices.some(s => s.id === anchor.id)) continue;

        const anchorTypePeers = (scopedByType.get(anchor.sliceType) || []).filter(candidate => candidate.id !== anchor.id);
        if (anchorTypePeers.length === 0) continue;

        const anchorSlotSet = new Set(anchor.closedSlots);
        const anchorRoleSet = new Set(anchor.roles);
        const anchorTokenSet = toTokenSet(`${anchor.anchorName} ${anchor.label} ${anchor.heuristicLabel}`);
        const scoredExamples = anchorTypePeers.map(candidate => {
          const sharedSlots = anchor.closedSlots.filter(slot => candidate.closedSlots.includes(slot));
          const sharedRoles = anchor.roles.filter(role => candidate.roles.includes(role));
          const candidateTokenSet = toTokenSet(`${candidate.anchorName} ${candidate.label} ${candidate.heuristicLabel}`);
          const sharedTokens = Array.from(candidateTokenSet).filter(token => anchorTokenSet.has(token) || queryTokenSet.has(token));

          const slotScore = jaccard(anchorSlotSet, new Set(candidate.closedSlots));
          const roleScore = jaccard(anchorRoleSet, new Set(candidate.roles));
          const lexicalScore = jaccard(anchorTokenSet, candidateTokenSet);
          const closureScore = 1 - Math.min(1, Math.abs(anchor.closureScore - candidate.closureScore));
          const cochange = cochangeScoreForSlices(anchor.memberFiles, candidate.memberFiles, cochangeMap);

          const score = (slotScore * 4) + (roleScore * 3) + (lexicalScore * 2) + (closureScore * 1) + (cochange.score * 2);
          const evidence: any = {
            shared_slots: sharedSlots.slice(0, 8),
            shared_roles: sharedRoles.slice(0, 8),
            lexical_overlap: sharedTokens.slice(0, 8),
          };
          if (cochange.pairCount > 0) {
            evidence.cochange = {
              score: Number(cochange.score.toFixed(3)),
              pair_count: cochange.pairCount,
            };
          }

          return {
            candidate,
            score,
            evidence,
          };
        });

        scoredExamples.sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          if (right.candidate.closureScore !== left.candidate.closureScore) return right.candidate.closureScore - left.candidate.closureScore;
          return left.candidate.id.localeCompare(right.candidate.id);
        });

        const examples = scoredExamples
          .slice(0, examplesPer)
          .map(example => reduceSliceForOutput(example.candidate, { score: example.score, evidence: example.evidence }));

        out.push({
          kind: 'slice',
          signature: buildSliceSignature(anchor),
          anchor: reduceSliceForOutput(anchor, { score: anchorSliceScores.get(anchor.id) || 0 }),
          examples,
        });
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

    const findStepNodeIdsForProcess = async (processId: string, maxCount: number): Promise<string[]> => {
      const escaped = processId.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (n)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process {id: '${escaped}'})
          RETURN DISTINCT n.id AS nodeId
          LIMIT ${Math.max(1, Math.min(80, maxCount))}
        `);
      } catch {
        return [];
      }
      return rows
        .map(r => r.nodeId || r[0])
        .filter((value: any): value is string => typeof value === 'string' && value.length > 0);
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
            WHERE w.confidence >= ${minHttpConfidence} AND w.reason STARTS WITH 'laravel-endpoint:'${scopeClauseUiOrController ? ` AND ${scopeClauseUiOrController}` : ''}
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
    const { byId: slicesById, byMemberNodeId: slicesByMemberNodeId, byAnchorNodeId: slicesByAnchorNodeId, inScope: inScopeSlices } = await loadSliceSummaries();
    const inScopeSliceIds = new Set(inScopeSlices.map(slice => slice.id));
    const cochangeMap = await loadCochangeMap();

    const anchorSliceScores = new Map<string, number>();
    const addAnchorSlice = (sliceId: string, score: number): void => {
      if (!sliceId) return;
      if (!inScopeSliceIds.has(sliceId)) return;
      const current = anchorSliceScores.get(sliceId) || 0;
      anchorSliceScores.set(sliceId, current + Math.max(0.1, score));
    };

    const addSlicesForNode = (nodeUid: string, score: number): void => {
      const uid = String(nodeUid || '').trim();
      if (!uid) return;

      if (slicesById.has(uid)) {
        addAnchorSlice(uid, score + 2);
      }

      const memberSlices = slicesByMemberNodeId.get(uid);
      if (memberSlices) {
        for (const sliceId of memberSlices) addAnchorSlice(sliceId, score);
      }

      const anchoredSlices = slicesByAnchorNodeId.get(uid);
      if (anchoredSlices) {
        for (const sliceId of anchoredSlices) addAnchorSlice(sliceId, score + 1);
      }
    };

    if (anchorUid) {
      anchorProcessIds.push(...await findProcessesForUid(anchorUid, limit));
      anchorHops.push(...await findHopsForUid(anchorUid, limit * 4));
      addSlicesForNode(anchorUid, 8);
    } else {
      // Use action_plan as the anchor finder: it can find deterministic HTTP hops even
      // when a flow is not part of the (capped) Process sample.
      const ap = await this.actionPlan(repo, {
        query: queryText,
        task_context: undefined,
        goal: undefined,
        path_prefixes: pathPrefixes,
        limit_files: 12,
        limit_checks: 1,
        __skip_precedents: true,
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

    const inScopeHops = pathPrefixes.length > 0
      ? anchorHops.filter(h => {
        const uiPath = String(h?.ui?.filePath || '').trim();
        const controllerPath = String(h?.controller?.filePath || '').trim();
        if (filePathTouchesPrefixes(uiPath, pathPrefixes)) return true;
        if (filePathTouchesPrefixes(controllerPath, pathPrefixes)) return true;
        return false;
      })
      : anchorHops;

    const queryTokens = getQueryTokens(queryText);
    for (const hop of inScopeHops) {
      const baseScore = Math.max(1, rankHop(hop, queryTokens) + 1);
      addSlicesForNode(String(hop?.ui?.uid || ''), baseScore);
      addSlicesForNode(String(hop?.endpoint?.uid || ''), baseScore + 0.5);
      addSlicesForNode(String(hop?.controller?.uid || ''), baseScore);
    }

    for (const pid of anchorProcessIds.slice(0, limit * 3)) {
      const stepNodeIds = await findStepNodeIdsForProcess(pid, 48);
      for (const nodeId of stepNodeIds) {
        addSlicesForNode(nodeId, 0.75);
      }
    }

    if (anchorSliceScores.size === 0 && queryTokens.length > 0 && inScopeSlices.length > 0) {
      const tokenRankedSlices = inScopeSlices
        .map(slice => {
          const hay = slice.searchText;
          let score = 0;
          for (const token of queryTokens) {
            if (!token) continue;
            if (hay.includes(token)) score += 1;
            if (String(slice.anchorName || '').toLowerCase().includes(token)) score += 1;
          }
          return { sliceId: slice.id, score };
        })
        .filter(item => item.score > 0)
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return left.sliceId.localeCompare(right.sliceId);
        })
        .slice(0, Math.max(limit * 3, examplesPer * 2));

      for (const item of tokenRankedSlices) {
        addAnchorSlice(item.sliceId, item.score);
      }
    }

    const slicePrecedents = buildSlicePrecedents(anchorSliceScores, inScopeSlices, slicesById, cochangeMap);
    const hopPrecedents = await buildHopPrecedents(inScopeHops);

    for (const pid of anchorProcessIds.slice(0, limit)) {
      addProcessPrecedent(pid);
    }

    const precedents = [...slicePrecedents, ...hopPrecedents, ...processPrecedents]
      .slice(0, Math.max(limit, slicePrecedents.length + hopPrecedents.length + processPrecedents.length));

    const diagnostics: any = {
      anchor_uid: anchorUid || undefined,
      anchor_processes: anchorProcessIds.length,
      anchor_hops: anchorHops.length,
      scoped_hops: inScopeHops.length,
      anchor_slices: anchorSliceScores.size,
      scoped_slices: inScopeSlices.length,
      slice_precedents: slicePrecedents.length,
      path_prefixes: pathPrefixes,
    };
    if (precedents.length === 0) {
      diagnostics.note = 'No precedents found (no anchor slices, deterministic HTTP hops, or process matches found for this query).';
      diagnostics.suggestions = [
        'Try action_plan(query) first to get a concrete anchor (UI function / endpoint / controller).',
        'Then rerun precedents() with anchor_uid set to a specific symbol uid.',
        'If this is a backend-only flow, use a concrete symbol anchor_uid so slice/process matching can resolve deterministically.',
      ];
    }

    return {
      status: 'ok',
      query: queryText || anchorUid,
      ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
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
    path_prefixes?: string[];
    include_slice_cards?: boolean;
    limit_slices?: number;
    include_evidence_spans?: boolean;
    limit_evidence?: number;
  }): Promise<any> {
    if (!params.query?.trim()) {
      return { error: 'query parameter is required and cannot be empty.' };
    }
    
    await this.ensureInitialized(repo.id);
    
    const processLimit = params.limit || 5;
    const maxSymbolsPerProcess = params.max_symbols || 10;
    const includeContent = params.include_content ?? false;
    const includeSliceCards = params.include_slice_cards !== false;
    const limitSlices = Math.max(1, Math.min(5, params.limit_slices ?? 2));
    const includeEvidenceSpans = params.include_evidence_spans !== false;
    const limitEvidence = Math.max(1, Math.min(100, params.limit_evidence ?? 20));
    const searchQuery = params.query.trim();
    const escapedSearchQuery = searchQuery.replace(/'/g, "''");

    type QueryIntent = 'entity' | 'contract' | 'symptom' | 'concept';
    const classifyQueryIntent = (query: string): QueryIntent => {
      const value = String(query || '').trim();
      if (!value) return 'concept';

      const lower = value.toLowerCase();
      if (/\b(error|exception|failing|broken|bug|regression|403|404|500|null|undefined|timeout|stale|missing)\b/.test(lower)) {
        return 'symptom';
      }
      if (/[/.]|::|->|route|permission|query key|cache key|shape|payload|field/i.test(value)) {
        return 'contract';
      }
      if (!/\s/.test(value) && /^[A-Za-z_][$A-Za-z0-9_:/.-]*$/.test(value)) {
        return 'entity';
      }
      return 'concept';
    };
    const queryIntent = classifyQueryIntent(searchQuery);

    const normalizePath = (value: string): string => {
      return String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '');
    };

    const normalizePrefix = (value: string): string => {
      const raw = String(value || '').trim().replace(/\\/g, '/');
      if (!raw) return '';

      // Allow callers to provide absolute paths; normalize to repo-relative prefixes when possible.
      if (path.isAbsolute(raw)) {
        const rel = path.relative(repo.repoPath, raw).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..')) return normalizePath(rel);
      }

      return normalizePath(raw);
    };

    const rawPrefixes = Array.isArray(params.path_prefixes)
      ? params.path_prefixes
      : typeof (params as any).path_prefixes === 'string'
        ? [(params as any).path_prefixes]
        : [];

    const pathPrefixes = Array.from(new Set(rawPrefixes.map(p => normalizePrefix(String(p || ''))).filter(Boolean)));

    const isInScope = (filePath: string): boolean => {
      if (pathPrefixes.length === 0) return true;
      const fp = normalizePath(filePath);
      if (!fp) return false;

      for (const prefixRaw of pathPrefixes) {
        const prefix = prefixRaw.endsWith('/') ? prefixRaw : `${prefixRaw}/`;
        if (fp === prefixRaw) return true;
        if (fp.startsWith(prefix)) return true;
      }
      return false;
    };

    const parseRoleFromSliceReason = (reason: string): string => {
      const raw = String(reason || '').trim();
      if (!raw) return '';
      if (!raw.startsWith('feature-slice:')) return raw;
      return raw.slice('feature-slice:'.length).trim();
    };

    const pickPrimaryLabel = (value: any): string => {
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
    };

    let exactRaw: any[] = [];
    try {
      exactRaw = await executeQuery(repo.id, `
        MATCH (n)
        WHERE n.id = '${escapedSearchQuery}'
           OR n.name = '${escapedSearchQuery}'
           OR n.filePath = '${escapedSearchQuery}'
        RETURN n.id AS nodeId, n.name AS name, labels(n) AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
        LIMIT ${Math.max(20, processLimit * maxSymbolsPerProcess)}
      `);
    } catch {
      exactRaw = [];
    }

    const exactResultsRaw = exactRaw
      .map((row: any) => ({
        nodeId: String(row.nodeId ?? row[0] ?? '').trim(),
        name: String(row.name ?? row[1] ?? '').trim(),
        type: pickPrimaryLabel(row.type ?? row[2]),
        filePath: String(row.filePath ?? row[3] ?? '').trim(),
        startLine: Number.isFinite(Number(row.startLine ?? row[4])) ? Number(row.startLine ?? row[4]) : undefined,
        endLine: Number.isFinite(Number(row.endLine ?? row[5])) ? Number(row.endLine ?? row[5]) : undefined,
      }))
      .filter((row: any) => row.nodeId || row.filePath);

    const exactResults = pathPrefixes.length > 0
      ? exactResultsRaw.filter(r => isInScope(r?.filePath || ''))
      : exactResultsRaw;
    
    // Step 1: Run hybrid search to get matching symbols
    const baseSearchLimit = processLimit * maxSymbolsPerProcess; // fetch enough raw results
    const searchLimit = pathPrefixes.length > 0
      ? Math.min(300, Math.max(baseSearchLimit, baseSearchLimit * 5))
      : baseSearchLimit;

    const bm25Raw = await this.bm25Search(repo, searchQuery, searchLimit);
    const bm25Results = pathPrefixes.length > 0 ? bm25Raw.filter(r => isInScope(r?.filePath || '')) : bm25Raw;

    // Semantic search is expensive (model load) and requires embeddings/indexes.
    // Prefer BM25 for identifier-like queries and only fall back to semantic when BM25 is sparse.
    const isSingleToken = !/\s/.test(searchQuery);
    const looksLikeIdentifier = isSingleToken && /^[A-Za-z_][$A-Za-z0-9_:/.-]*$/.test(searchQuery);
    const shouldTrySemantic = !looksLikeIdentifier && bm25Results.length < Math.max(5, Math.floor(searchLimit / 3));

    const semanticRaw = shouldTrySemantic
      ? await this.semanticSearch(repo, searchQuery, searchLimit)
      : [];
    const semanticResults = pathPrefixes.length > 0
      ? semanticRaw.filter(r => isInScope(r?.filePath || ''))
      : semanticRaw;
    
    // Merge via reciprocal rank fusion (RRF)
    const scoreMap = new Map<string, { score: number; data: any }>();

    const exactHitNodeIds = new Set<string>();
    for (let i = 0; i < exactResults.length; i++) {
      const result = exactResults[i];
      const key = result.nodeId || result.filePath || `exact:${i}`;
      const exactScore = 1 / (5 + i + 1);
      const existing = scoreMap.get(key);
      if (result.nodeId) exactHitNodeIds.add(result.nodeId);
      if (existing) {
        existing.score += exactScore;
      } else {
        scoreMap.set(key, { score: exactScore, data: result });
      }
    }

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

    let episodeOverlayInfo: { boosted_symbols: number; boosted_files: number; target?: { branch?: string; taskId?: string } } | undefined;
    try {
      const episodeState = await loadEpisodeGraphState(repo.storagePath);
      const overlay = buildEpisodeOverlay(episodeState);

      if (overlay.symbolBoosts.size > 0 || overlay.fileBoosts.size > 0) {
        for (const item of merged) {
          const nodeId = String(item?.data?.nodeId || '').trim();
          const filePath = normalizePath(String(item?.data?.filePath || ''));
          if (nodeId && overlay.symbolBoosts.has(nodeId)) {
            item.score += overlay.symbolBoosts.get(nodeId)!;
          }
          if (filePath && overlay.fileBoosts.has(filePath)) {
            item.score += overlay.fileBoosts.get(filePath)!;
          }
        }

        merged.sort((a, b) => b.score - a.score);
        for (let i = 0; i < merged.length; i++) {
          merged[i].mergedRank = i + 1;
        }

        episodeOverlayInfo = {
          boosted_symbols: overlay.symbolBoosts.size,
          boosted_files: overlay.fileBoosts.size,
          ...(overlay.target?.branch || overlay.target?.taskId
            ? { target: { branch: overlay.target.branch, taskId: overlay.target.taskId } }
            : {}),
        };
      }
    } catch {
      // Ignore episode sidecar read errors and continue with base ranking.
    }

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
        if (!isInScope(filePath)) continue;

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

        const filePath = row.filePath ?? row[2] ?? '';
        if (!isInScope(filePath)) continue;

        stepSymbols.push({
          id: nodeId,
          name: row.name ?? row[1] ?? '',
          type,
          filePath,
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

    const processes = rankedProcesses
      .map(p => ({
        id: p.id,
        summary: p.heuristicLabel || p.label,
        priority: Math.round(p.priority * 1000) / 1000,
        symbol_count: symbolCountByProcess.get(p.id) ?? 0,
        process_type: p.processType,
        step_count: p.stepCount,
      }))
      .filter(p => pathPrefixes.length === 0 || p.symbol_count > 0);

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
    
    const inScopeDefinitions = pathPrefixes.length > 0
      ? dedupedDefinitions.filter((d: any) => isInScope(d?.filePath || ''))
      : dedupedDefinitions;

    const processSymbolIdSet = new Set(
      processSymbols
        .map(sym => String(sym?.id || '').trim())
        .filter(Boolean),
    );
    const definitionIdSet = new Set(
      inScopeDefinitions
        .map(sym => String(sym?.id || '').trim())
        .filter(Boolean),
    );

    const slice_cards: any[] = [];
    if (includeSliceCards) {
      const candidateNodeIds = Array.from(new Set(
        [
          ...merged.slice(0, Math.max(40, processLimit * maxSymbolsPerProcess)).map(item => String(item?.data?.nodeId || '').trim()),
          ...Array.from(processSymbolIdSet),
          ...Array.from(definitionIdSet),
        ].filter(Boolean),
      )).slice(0, 300);

      if (candidateNodeIds.length > 0) {
        const escapedIds = candidateNodeIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
        const candidateIdsCypher = `[${escapedIds}]`;

        let sliceRows: any[] = [];
        try {
          sliceRows = await executeQuery(repo.id, `
            MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
            WHERE n.id IN ${candidateIdsCypher}
              AND r.reason STARTS WITH 'feature-slice:'
            RETURN s.id AS sliceId,
                   s.label AS sliceLabel,
                   s.heuristicLabel AS heuristicLabel,
                   s.anchorId AS anchorId,
                   s.anchorName AS anchorName,
                   s.sliceType AS sliceType,
                   s.closureScore AS closureScore,
                   s.closureSlots AS closureSlots,
                   s.closedSlots AS closedSlots,
                   n.id AS memberId,
                   n.name AS memberName,
                   labels(n) AS memberKind,
                   n.filePath AS memberFilePath,
                   n.startLine AS memberStartLine,
                   n.endLine AS memberEndLine,
                   r.reason AS memberRoleReason
            LIMIT 2000
          `);
        } catch {
          sliceRows = [];
        }

        const bySliceId = new Map<string, {
          id: string;
          label: string;
          heuristicLabel: string;
          anchorId: string;
          anchorName: string;
          sliceType: string;
          closureScore: number;
          closureSlots: string[];
          closedSlots: string[];
          score: number;
          roles: Set<string>;
          members: Map<string, {
            uid: string;
            name: string;
            kind: string;
            filePath: string;
            role: string;
            score: number;
            startLine?: number;
            endLine?: number;
            hit_rank?: number;
          }>;
          gapSignals: {
            total: number;
            deterministic: number;
            pattern: number;
            heuristic: number;
            high: number;
            medium: number;
            low: number;
          };
        }>();

        for (const row of sliceRows) {
          const sliceId = String(row.sliceId ?? row[0] ?? '').trim();
          if (!sliceId) continue;

          const anchorId = String(row.anchorId ?? row[3] ?? '').trim();
          let entry = bySliceId.get(sliceId);
          if (!entry) {
            entry = {
              id: sliceId,
              label: String(row.sliceLabel ?? row[1] ?? '').trim(),
              heuristicLabel: String(row.heuristicLabel ?? row[2] ?? '').trim(),
              anchorId,
              anchorName: String(row.anchorName ?? row[4] ?? '').trim(),
              sliceType: String(row.sliceType ?? row[5] ?? '').trim(),
              closureScore: Number(row.closureScore ?? row[6] ?? 0) || 0,
              closureSlots: Array.isArray(row.closureSlots) ? row.closureSlots.map((item: any) => String(item || '')).filter(Boolean) : [],
              closedSlots: Array.isArray(row.closedSlots) ? row.closedSlots.map((item: any) => String(item || '')).filter(Boolean) : [],
              score: 0,
              roles: new Set<string>(),
              members: new Map(),
              gapSignals: {
                total: 0,
                deterministic: 0,
                pattern: 0,
                heuristic: 0,
                high: 0,
                medium: 0,
                low: 0,
              },
            };
            if (anchorId && exactHitNodeIds.has(anchorId)) entry.score += 1.5;
            bySliceId.set(sliceId, entry);
          }

          const memberId = String(row.memberId ?? row[9] ?? '').trim();
          if (!memberId) continue;
          const memberName = String(row.memberName ?? row[10] ?? '').trim();
          const memberFilePath = String(row.memberFilePath ?? row[12] ?? '').trim();
          const memberRole = parseRoleFromSliceReason(String(row.memberRoleReason ?? row[15] ?? '').trim());
          const memberKind = pickPrimaryLabel(row.memberKind ?? row[11]);
          const hit = hitMeta.get(memberId);

          let memberScore = 0.05;
          if (hit) memberScore += hit.score;
          if (exactHitNodeIds.has(memberId)) memberScore += 1;
          if (processSymbolIdSet.has(memberId)) memberScore += 0.15;
          if (definitionIdSet.has(memberId)) memberScore += 0.1;
          if (memberId === entry.anchorId) memberScore += 0.2;

          entry.score += memberScore;
          if (memberRole) entry.roles.add(memberRole);

          const existingMember = entry.members.get(memberId);
          if (existingMember && existingMember.score >= memberScore) continue;

          const startLine = Number(row.memberStartLine ?? row[13]);
          const endLine = Number(row.memberEndLine ?? row[14]);
          entry.members.set(memberId, {
            uid: memberId,
            name: memberName,
            kind: memberKind,
            filePath: memberFilePath,
            role: memberRole,
            score: memberScore,
            ...(Number.isFinite(startLine) ? { startLine } : {}),
            ...(Number.isFinite(endLine) ? { endLine } : {}),
            ...(hit ? { hit_rank: hit.rank } : {}),
          });
        }

        const sliceIds = Array.from(bySliceId.keys());
        if (sliceIds.length > 0) {
          const escapedSliceIds = sliceIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
          const sliceIdsCypher = `[${escapedSliceIds}]`;

          let gapRows: any[] = [];
          try {
            gapRows = await executeQuery(repo.id, `
              MATCH (g:Gap)-[:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
              WHERE s.id IN ${sliceIdsCypher}
              RETURN s.id AS sliceId, g.absenceTier AS absenceTier, g.severity AS severity
              LIMIT 2000
            `);
          } catch {
            gapRows = [];
          }

          for (const row of gapRows) {
            const sliceId = String(row.sliceId ?? row[0] ?? '').trim();
            const absenceTier = String(row.absenceTier ?? row[1] ?? '').trim();
            const severity = String(row.severity ?? row[2] ?? '').trim();
            const entry = bySliceId.get(sliceId);
            if (!entry) continue;

            entry.gapSignals.total += 1;
            if (absenceTier === 'deterministic_missing') entry.gapSignals.deterministic += 1;
            else if (absenceTier === 'pattern_missing') entry.gapSignals.pattern += 1;
            else if (absenceTier === 'heuristic_suspicion') entry.gapSignals.heuristic += 1;

            if (severity === 'high') entry.gapSignals.high += 1;
            else if (severity === 'medium') entry.gapSignals.medium += 1;
            else if (severity === 'low') entry.gapSignals.low += 1;
          }

          const rankedSlices = Array.from(bySliceId.values())
            .sort((left, right) => {
              if (right.score !== left.score) return right.score - left.score;
              if (right.closureScore !== left.closureScore) return right.closureScore - left.closureScore;
              return left.id.localeCompare(right.id);
            })
            .slice(0, limitSlices);

          let evidenceByNodeId = new Map<string, any>();
          let evidenceGeneratedAt = '';
          if (includeEvidenceSpans && rankedSlices.length > 0) {
            try {
              const evidenceSnapshot = await loadEvidenceSpanSnapshot(repo.storagePath);
              evidenceGeneratedAt = String(evidenceSnapshot.generatedAt || '');
              evidenceByNodeId = new Map(
                (Array.isArray(evidenceSnapshot.nodes) ? evidenceSnapshot.nodes : [])
                  .map(node => [String(node?.nodeId || '').trim(), node] as const)
                  .filter(([id]) => id),
              );
            } catch {
              evidenceByNodeId = new Map();
            }
          }

          let remainingEvidence = limitEvidence;
          for (const slice of rankedSlices) {
            const matchedMembers = Array.from(slice.members.values())
              .sort((left, right) => {
                if (right.score !== left.score) return right.score - left.score;
                return left.uid.localeCompare(right.uid);
              })
              .slice(0, 8)
              .map(member => ({
                uid: member.uid,
                name: member.name,
                kind: member.kind,
                filePath: member.filePath,
                role: member.role,
                score: Number(member.score.toFixed(3)),
                ...(member.startLine !== undefined ? { startLine: member.startLine } : {}),
                ...(member.endLine !== undefined ? { endLine: member.endLine } : {}),
                ...(member.hit_rank !== undefined ? { hit_rank: member.hit_rank } : {}),
              }));

            let proof_spans: any = undefined;
            if (includeEvidenceSpans) {
              const evidenceSymbols: any[] = [];
              const candidateEvidenceIds = Array.from(new Set([
                String(slice.anchorId || '').trim(),
                ...matchedMembers.map(member => String(member.uid || '').trim()),
              ].filter(Boolean)));

              for (const nodeId of candidateEvidenceIds) {
                if (remainingEvidence <= 0) break;
                const evidence = evidenceByNodeId.get(nodeId);
                if (!evidence) continue;

                evidenceSymbols.push({
                  uid: nodeId,
                  name: String(evidence.nodeName || ''),
                  kind: String(evidence.nodeLabel || ''),
                  primary_span: evidence.primarySpan || null,
                  witness_spans: Array.isArray(evidence.witnessSpans) ? evidence.witnessSpans : [],
                  proof_spans: Array.isArray(evidence.proofSpans) ? evidence.proofSpans : [],
                });
                remainingEvidence -= 1;
              }

              const witnessSpanCount = evidenceSymbols.reduce((sum, item) => sum + item.witness_spans.length, 0);
              const proofSpanCount = evidenceSymbols.reduce((sum, item) => sum + item.proof_spans.length, 0);
              proof_spans = {
                updated_at: evidenceGeneratedAt,
                summary: {
                  symbol_spans: evidenceSymbols.length,
                  witness_spans: witnessSpanCount,
                  proof_spans: proofSpanCount,
                },
                symbols: evidenceSymbols,
              };
            }

            slice_cards.push({
              uid: slice.id,
              label: slice.label || slice.heuristicLabel || slice.id,
              slice_type: slice.sliceType,
              anchor_id: slice.anchorId,
              anchor_name: slice.anchorName,
              closure_score: Number(slice.closureScore.toFixed(3)),
              closure_slots: slice.closureSlots,
              closed_slots: slice.closedSlots,
              member_count: slice.members.size,
              roles: Array.from(slice.roles).sort(),
              score: Number(slice.score.toFixed(3)),
              gap_signals: slice.gapSignals,
              matched_members: matchedMembers,
              ...(includeEvidenceSpans ? { proof_spans } : {}),
            });
          }
        }
      }
    }

    const query_plan = {
      intent: queryIntent,
      exact_lookup: {
        hits: exactResults.length,
        used: exactResults.length > 0,
      },
      retrieval: {
        bm25_hits: bm25Results.length,
        semantic_hits: semanticResults.length,
        semantic_attempted: shouldTrySemantic,
        semantic_used: semanticResults.length > 0,
        path_scoped: pathPrefixes.length > 0,
      },
      slices: {
        enabled: includeSliceCards,
        returned: slice_cards.length,
        limit: limitSlices,
        include_evidence_spans: includeEvidenceSpans,
      },
    };

    return {
      processes,
      process_symbols: processSymbols,
      definitions: inScopeDefinitions.slice(0, 20), // cap standalone definitions
      slice_cards,
      query_plan,
      ...(episodeOverlayInfo ? { episode_overlay: episodeOverlayInfo } : {}),
      _query: {
        knobs: {
          include_slice_cards: includeSliceCards,
          limit_slices: limitSlices,
          include_evidence_spans: includeEvidenceSpans,
          limit_evidence: limitEvidence,
        },
      },
    };
  }

  private async queryMode(repo: RepoHandle, params: {
    query?: string;
    task_context?: string;
    goal?: string;
    path_prefixes?: string[];
    limit_processes?: number;
    max_symbols?: number;
    limit_slices?: number;
    limit_precedents?: number;
    limit_hops?: number;
    include_precedents?: boolean;
    include_action_hints?: boolean;
  }): Promise<any> {
    const queryText = String(params.query || '').trim();
    if (!queryText) {
      return { error: 'query parameter is required and cannot be empty.' };
    }

    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
    const limitProcesses = Math.max(1, Math.min(10, params.limit_processes ?? 4));
    const maxSymbols = Math.max(1, Math.min(40, params.max_symbols ?? 16));
    const limitSlices = Math.max(1, Math.min(5, params.limit_slices ?? 2));
    const limitPrecedents = Math.max(0, Math.min(5, params.limit_precedents ?? 2));
    const limitHops = Math.max(0, Math.min(10, params.limit_hops ?? 4));
    const includePrecedents = params.include_precedents !== false;
    const includeActionHints = params.include_action_hints !== false;

    const queryResult = await this.query(repo, {
      query: queryText,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
      limit: Math.max(5, limitProcesses),
      max_symbols: Math.max(10, maxSymbols),
      include_content: false,
      include_slice_cards: true,
      limit_slices: limitSlices,
      include_evidence_spans: true,
      limit_evidence: 30,
    });

    if (queryResult?.error) return queryResult;

    const topSlice = Array.isArray(queryResult?.slice_cards) ? queryResult.slice_cards[0] : null;

    let precedentPack: any = null;
    if (includePrecedents && limitPrecedents > 0) {
      try {
        precedentPack = await this.precedents(repo, {
          query: queryText,
          ...(topSlice?.anchor_id ? { anchor_uid: String(topSlice.anchor_id) } : {}),
          limit: 2,
          examples: 3,
          path_prefixes: pathPrefixes,
        });
      } catch {
        precedentPack = null;
      }
    }

    let actionPlanResult: any = null;
    if (includeActionHints) {
      try {
        actionPlanResult = await this.actionPlan(repo, {
          query: queryText,
          task_context: params.task_context,
          goal: params.goal,
          path_prefixes: pathPrefixes,
          limit_files: 8,
          limit_checks: 8,
          __skip_precedents: true,
        });
      } catch {
        actionPlanResult = null;
      }
    }

    const processSymbols = Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols : [];
    const definitions = Array.isArray(queryResult?.definitions) ? queryResult.definitions : [];
    const symbols = processSymbols.slice(0, maxSymbols);
    if (symbols.length < maxSymbols) {
      symbols.push(...definitions.slice(0, maxSymbols - symbols.length));
    }

    const hypotheses: string[] = [];
    const topGapSignals = topSlice?.gap_signals || null;
    if (topGapSignals && Number(topGapSignals.high || 0) > 0) {
      hypotheses.push('Top slice includes high-severity closure gaps; confirm required slot coverage before editing.');
    }
    if (topGapSignals && Number(topGapSignals.deterministic || 0) > 0) {
      hypotheses.push('Deterministic gap signals indicate concrete missing links in the top slice.');
    }
    if (Number(queryResult?.query_plan?.exact_lookup?.hits || 0) === 0) {
      hypotheses.push('No exact lookup hit; tighten the anchor (symbol/route/permission/query key) to reduce ambiguity.');
    }

    const nextActions = [
      'Open top-ranked symbols with context() to inspect incoming/outgoing references.',
      'Use action_plan() to confirm companion files and verification checks before edits.',
      'After edits, run review_mode(scope=unstaged) to validate semantic and closure deltas.',
    ];
    if (topSlice?.uid) {
      nextActions.unshift('Compare target slice with precedents() siblings before introducing a new flow shape.');
    }

    return {
      status: 'ok',
      repo: repo.name,
      query: queryText,
      query_mode: {
        query_plan: queryResult?.query_plan || null,
        slices: Array.isArray(queryResult?.slice_cards) ? queryResult.slice_cards.slice(0, limitSlices) : [],
        processes: Array.isArray(queryResult?.processes) ? queryResult.processes.slice(0, limitProcesses) : [],
        symbols,
        precedents: Array.isArray(precedentPack?.precedents)
          ? precedentPack.precedents.slice(0, limitPrecedents)
          : [],
        action_hints: includeActionHints
          ? {
              files: Array.isArray(actionPlanResult?.files) ? actionPlanResult.files.slice(0, 8) : [],
              checks: Array.isArray(actionPlanResult?.checks) ? actionPlanResult.checks.slice(0, 8) : [],
              hops: Array.isArray(actionPlanResult?.hops) ? actionPlanResult.hops.slice(0, limitHops) : [],
            }
          : null,
        hypotheses: Array.from(new Set(hypotheses)).slice(0, 6),
        next_actions: nextActions,
      },
      _query_mode: {
        knobs: {
          limit_processes: limitProcesses,
          max_symbols: maxSymbols,
          limit_slices: limitSlices,
          limit_precedents: limitPrecedents,
          limit_hops: limitHops,
          include_precedents: includePrecedents,
          include_action_hints: includeActionHints,
          path_prefixes: pathPrefixes,
        },
      },
    };
  }

  private async implementMode(repo: RepoHandle, params: {
    query?: string;
    task_context?: string;
    goal?: string;
    path_prefixes?: string[];
    limit_files?: number;
    limit_checks?: number;
    limit_write_order?: number;
    limit_precedents?: number;
    include_query_head?: boolean;
    include_review_contract?: boolean;
  }): Promise<any> {
    const queryText = String(params.query || '').trim();
    if (!queryText) {
      return { error: 'query parameter is required and cannot be empty.' };
    }

    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
    const limitFiles = Math.max(1, Math.min(30, params.limit_files ?? 10));
    const limitChecks = Math.max(1, Math.min(20, params.limit_checks ?? 10));
    const limitWriteOrder = Math.max(1, Math.min(20, params.limit_write_order ?? 10));
    const limitPrecedents = Math.max(0, Math.min(5, params.limit_precedents ?? 3));
    const includeQueryHead = params.include_query_head !== false;
    const includeReviewContract = params.include_review_contract !== false;

    const actionPlanResult = await this.actionPlan(repo, {
      query: queryText,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
      limit_files: limitFiles,
      limit_checks: limitChecks,
      __skip_precedents: false,
    });

    if (actionPlanResult?.error) return actionPlanResult;

    let queryModeResult: any = null;
    if (includeQueryHead) {
      try {
        queryModeResult = await this.queryMode(repo, {
          query: queryText,
          task_context: params.task_context,
          goal: params.goal,
          path_prefixes: pathPrefixes,
          limit_processes: 4,
          max_symbols: 16,
          limit_slices: 2,
          limit_precedents: limitPrecedents,
          limit_hops: 0,
          include_precedents: true,
          include_action_hints: false,
        });
      } catch {
        queryModeResult = null;
      }
    }

    const implementPlan = actionPlanResult?.implement_plan || {};
    const companionFiles = Array.isArray(implementPlan?.companion_set?.files)
      ? implementPlan.companion_set.files.slice(0, limitFiles)
      : [];
    const writePlan = Array.isArray(implementPlan?.write_order)
      ? implementPlan.write_order.slice(0, limitWriteOrder)
      : [];

    const precedentsFromPlan = Array.isArray(implementPlan?.precedents)
      ? implementPlan.precedents
      : [];
    const precedentsFromQuery = Array.isArray(queryModeResult?.query_mode?.precedents)
      ? queryModeResult.query_mode.precedents
      : [];
    const precedents = (precedentsFromPlan.length > 0 ? precedentsFromPlan : precedentsFromQuery)
      .slice(0, limitPrecedents);

    const checks = Array.isArray(actionPlanResult?.checks)
      ? actionPlanResult.checks.slice(0, limitChecks)
      : [];
    const hops = Array.isArray(actionPlanResult?.hops)
      ? actionPlanResult.hops.slice(0, 6)
      : [];
    const cacheEffects = Array.isArray(actionPlanResult?.cache_effects)
      ? actionPlanResult.cache_effects.slice(0, 4)
      : [];

    const gapSignals = implementPlan?.gap_signals || {};
    const hypotheses: string[] = [];
    if (Number(gapSignals?.high || 0) > 0) {
      hypotheses.push('Top target slice has high-severity gaps; patch required slots before broad refactors.');
    }
    if (Number(gapSignals?.deterministic || 0) > 0) {
      hypotheses.push('Deterministic gap signals indicate concrete missing closure links in the target slice.');
    }
    if (!implementPlan?.closure_template) {
      hypotheses.push('No closure template match found; verify anatomy against sibling precedents before adding new structure.');
    }
    if (companionFiles.length === 0) {
      hypotheses.push('Companion set is sparse; expand anchor query or path scope to avoid under-editing dependent surfaces.');
    }

    const postEditReviewBase = implementPlan?.post_edit_review || {
      tool: 'review_mode',
      params: {
        scope: 'unstaged',
        ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
        include_slice_stencil: true,
        include_evidence_spans: true,
      },
    };
    const postEditReview = includeReviewContract ? postEditReviewBase : null;

    const nextActions = [
      'Open the first write-plan anchor with context() and confirm callers before editing.',
      'Apply edits in write_plan order to preserve closure semantics.',
      'Run impact() on the highest-risk write anchor before touching shared utilities.',
    ];
    if (postEditReview) {
      nextActions.push('Run review_mode(scope=unstaged) with slice-stencil and evidence spans enabled after edits.');
    }

    return {
      status: 'ok',
      repo: repo.name,
      query: queryText,
      implement_mode: {
        target: implementPlan?.target || null,
        closure_template: implementPlan?.closure_template || null,
        companion_files: companionFiles,
        write_plan: writePlan,
        precedents,
        action_hints: {
          files: Array.isArray(actionPlanResult?.files) ? actionPlanResult.files.slice(0, limitFiles) : [],
          checks,
          hops,
          cache_effects: cacheEffects,
        },
        query_head: includeQueryHead
          ? {
              query_plan: queryModeResult?.query_mode?.query_plan || null,
              slices: Array.isArray(queryModeResult?.query_mode?.slices) ? queryModeResult.query_mode.slices.slice(0, 2) : [],
              processes: Array.isArray(queryModeResult?.query_mode?.processes) ? queryModeResult.query_mode.processes.slice(0, 4) : [],
              symbols: Array.isArray(queryModeResult?.query_mode?.symbols) ? queryModeResult.query_mode.symbols.slice(0, 16) : [],
            }
          : null,
        gap_signals: gapSignals,
        hypotheses: Array.from(new Set(hypotheses)).slice(0, 6),
        next_actions: nextActions,
        post_edit_review: postEditReview,
      },
      _implement_mode: {
        knobs: {
          limit_files: limitFiles,
          limit_checks: limitChecks,
          limit_write_order: limitWriteOrder,
          limit_precedents: limitPrecedents,
          include_query_head: includeQueryHead,
          include_review_contract: includeReviewContract,
          path_prefixes: pathPrefixes,
        },
      },
    };
  }

  private async modeRouter(repo: RepoHandle, params: {
    mode?: 'auto' | 'query' | 'implement' | 'review' | 'debug';
    query?: string;
    symptom?: string;
    failing_tests?: string[];
    error_strings?: string[];
    task_context?: string;
    goal?: string;
    path_prefixes?: string[];
    scope?: 'unstaged' | 'staged' | 'all' | 'compare';
    base_ref?: string;
    include_precedents?: boolean;
  }): Promise<any> {
    const requestedMode = String(params.mode || 'auto').trim().toLowerCase();
    const queryText = String(params.query || '').trim();
    const symptomText = String(params.symptom || '').trim();
    const failingTests = this.toStringArray(params.failing_tests);
    const errorStrings = this.toStringArray(params.error_strings);
    const scope = params.scope || 'unstaged';
    const baseRef = String(params.base_ref || '').trim();
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);

    const supportedModes = new Set(['auto', 'query', 'implement', 'review', 'debug']);
    if (!supportedModes.has(requestedMode)) {
      return { error: `mode must be one of auto|query|implement|review|debug (received "${requestedMode}")` };
    }

    const implementationIntentRe = /\b(add|build|create|implement|introduce|migrate|refactor|wire|ship|rollout)\b/i;
    const combinedIntentText = [queryText, String(params.task_context || ''), String(params.goal || '')]
      .join(' ')
      .trim();
    const hasImplementationIntent = implementationIntentRe.test(combinedIntentText);
    const hasSymptomSignal = Boolean(symptomText) || failingTests.length > 0 || errorStrings.length > 0;
    const hasReviewSignal = Boolean(baseRef) || requestedMode === 'review';

    type RoutedMode = 'query' | 'implement' | 'review' | 'debug';
    const candidateByMode = new Map<RoutedMode, { mode: RoutedMode; score: number; reasons: string[] }>([
      ['query', { mode: 'query', score: 0, reasons: [] }],
      ['implement', { mode: 'implement', score: 0, reasons: [] }],
      ['review', { mode: 'review', score: 0, reasons: [] }],
      ['debug', { mode: 'debug', score: 0, reasons: [] }],
    ]);
    const addCandidateSignal = (mode: RoutedMode, score: number, reason: string) => {
      const entry = candidateByMode.get(mode);
      if (!entry) return;
      entry.score += score;
      if (reason) entry.reasons.push(reason);
    };

    if (queryText) addCandidateSignal('query', 3, 'query-anchor');
    if (hasImplementationIntent) addCandidateSignal('implement', 4, 'implementation-intent');
    if (queryText) addCandidateSignal('implement', 1, 'query-present');
    if (hasReviewSignal) addCandidateSignal('review', 5, 'review-scope-signal');
    if (!queryText && !hasSymptomSignal) addCandidateSignal('review', 2, 'no-query-fallback');
    if (hasSymptomSignal) addCandidateSignal('debug', 6, 'symptom-signal');
    if (failingTests.length > 0) addCandidateSignal('debug', 1, 'failing-tests');
    if (errorStrings.length > 0) addCandidateSignal('debug', 1, 'error-strings');

    let selectedMode: RoutedMode;
    const routingSignals: string[] = [];
    if (requestedMode !== 'auto') {
      selectedMode = requestedMode as RoutedMode;
      routingSignals.push(`explicit-mode:${selectedMode}`);
    } else if (hasSymptomSignal) {
      selectedMode = 'debug';
      routingSignals.push('symptom-signal');
    } else if (hasReviewSignal) {
      selectedMode = 'review';
      routingSignals.push('review-scope-signal');
    } else if (hasImplementationIntent) {
      selectedMode = 'implement';
      routingSignals.push('implementation-intent');
    } else {
      selectedMode = 'review';
      routingSignals.push('no-query-fallback');
    }

    const tiePriority: RoutedMode[] = ['debug', 'review', 'implement', 'query'];
    if (requestedMode === 'auto') {
      const ranked = Array.from(candidateByMode.values()).sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return tiePriority.indexOf(left.mode) - tiePriority.indexOf(right.mode);
      });
      const top = ranked[0];
      if (top && top.score > 0) {
        selectedMode = top.mode;
        if (!routingSignals.includes('symptom-signal') && selectedMode === 'debug') {
          routingSignals.push('symptom-signal');
        }
        if (!routingSignals.includes('review-scope-signal') && selectedMode === 'review' && hasReviewSignal) {
          routingSignals.push('review-scope-signal');
        }
        if (!routingSignals.includes('implementation-intent') && selectedMode === 'implement' && hasImplementationIntent) {
          routingSignals.push('implementation-intent');
        }
      }
    }

    let routedResult: any;
    if (selectedMode === 'query') {
      if (!queryText) {
        return { error: 'query is required when mode resolves to query.' };
      }
      routedResult = await this.queryMode(repo, {
        query: queryText,
        task_context: params.task_context,
        goal: params.goal,
        path_prefixes: pathPrefixes,
        include_precedents: params.include_precedents,
      });
    } else if (selectedMode === 'implement') {
      if (!queryText) {
        return { error: 'query is required when mode resolves to implement.' };
      }
      routedResult = await this.implementMode(repo, {
        query: queryText,
        task_context: params.task_context,
        goal: params.goal,
        path_prefixes: pathPrefixes,
      });
    } else if (selectedMode === 'review') {
      routedResult = await this.reviewMode(repo, {
        scope,
        ...(baseRef ? { base_ref: baseRef } : {}),
        path_prefixes: pathPrefixes,
        include_ui_contracts: true,
        include_evidence_spans: true,
        include_slice_stencil: true,
      });
    } else {
      if (!queryText && !symptomText && failingTests.length === 0 && errorStrings.length === 0) {
        return { error: 'Provide query, symptom, failing_tests, or error_strings when mode resolves to debug.' };
      }
      routedResult = await this.debugMode(repo, {
        query: queryText,
        symptom: symptomText,
        task_context: params.task_context,
        goal: params.goal,
        failing_tests: failingTests,
        error_strings: errorStrings,
        path_prefixes: pathPrefixes,
        include_precedents: params.include_precedents,
      });
    }

    if (routedResult?.error) {
      return routedResult;
    }

    const normalizeSymbol = (item: any) => {
      const uid = String(item?.uid || item?.id || '').trim();
      const filePath = String(item?.filePath || '').trim();
      if (!uid && !filePath) return null;
      return {
        uid: uid || null,
        name: String(item?.name || '').trim() || '',
        kind: String(item?.kind || item?.type || '').trim() || '',
        filePath,
        ...(Number.isFinite(Number(item?.startLine)) ? { startLine: Number(item.startLine) } : {}),
        ...(Number.isFinite(Number(item?.endLine)) ? { endLine: Number(item.endLine) } : {}),
      };
    };

    const uniqueByKey = <T>(values: T[], keyFn: (value: T) => string): T[] => {
      const out: T[] = [];
      const seen = new Set<string>();
      for (const value of values) {
        const key = keyFn(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(value);
      }
      return out;
    };

    let primarySymbols: any[] = [];
    let primaryFiles: string[] = [];
    let topFindings: string[] = [];
    let hypotheses: string[] = [];
    let nextActions: string[] = [];
    let risk: any = null;
    let recommendedHandoff: any = null;

    if (selectedMode === 'query') {
      const qm = routedResult?.query_mode || {};
      primarySymbols = [
        ...(Array.isArray(qm?.symbols) ? qm.symbols : []),
      ].map(normalizeSymbol).filter(Boolean);
      primaryFiles = [
        ...(Array.isArray(qm?.action_hints?.files) ? qm.action_hints.files.map((item: any) => String(item?.filePath || '').trim()) : []),
        ...primarySymbols.map((symbol: any) => String(symbol?.filePath || '').trim()),
      ].filter(Boolean);
      hypotheses = Array.isArray(qm?.hypotheses) ? qm.hypotheses : [];
      topFindings = hypotheses.slice(0, 6);
      nextActions = Array.isArray(qm?.next_actions) ? qm.next_actions : [];
      recommendedHandoff = queryText
        ? {
            tool: 'implement_mode',
            params: {
              query: queryText,
              ...(params.task_context ? { task_context: params.task_context } : {}),
              ...(params.goal ? { goal: params.goal } : {}),
              ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
            },
          }
        : null;
    } else if (selectedMode === 'implement') {
      const im = routedResult?.implement_mode || {};
      primarySymbols = [
        ...(Array.isArray(im?.write_plan) ? im.write_plan : []),
        ...(Array.isArray(im?.query_head?.symbols) ? im.query_head.symbols : []),
      ].map(normalizeSymbol).filter(Boolean);
      primaryFiles = [
        ...(Array.isArray(im?.companion_files) ? im.companion_files.map((item: any) => String(item?.filePath || '').trim()) : []),
        ...primarySymbols.map((symbol: any) => String(symbol?.filePath || '').trim()),
      ].filter(Boolean);
      hypotheses = Array.isArray(im?.hypotheses) ? im.hypotheses : [];
      topFindings = hypotheses.slice(0, 6);
      nextActions = Array.isArray(im?.next_actions) ? im.next_actions : [];

      const gapSignals = im?.gap_signals || {};
      const high = Number(gapSignals?.high || 0);
      const deterministic = Number(gapSignals?.deterministic || 0);
      const score = (high * 2) + deterministic;
      risk = {
        level: score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low',
        score,
      };
      recommendedHandoff = im?.post_edit_review || {
        tool: 'review_mode',
        params: {
          scope: 'unstaged',
          ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
          include_slice_stencil: true,
          include_evidence_spans: true,
        },
      };
    } else if (selectedMode === 'review') {
      const reviewKernel = routedResult?.review_kernel || null;
      primarySymbols = [
        ...(Array.isArray(routedResult?.changed_symbols) ? routedResult.changed_symbols : []),
      ].map(normalizeSymbol).filter(Boolean);
      primaryFiles = [
        ...(Array.isArray(routedResult?.changed_files) ? routedResult.changed_files.map((item: any) => String(item?.filePath || '').trim()) : []),
        ...primarySymbols.map((symbol: any) => String(symbol?.filePath || '').trim()),
      ].filter(Boolean);
      topFindings = Array.isArray(reviewKernel?.top_findings) ? reviewKernel.top_findings : [];
      hypotheses = Array.isArray(reviewKernel?.hypotheses) ? reviewKernel.hypotheses : [];
      nextActions = Array.isArray(reviewKernel?.next_actions) ? reviewKernel.next_actions : [];
      risk = reviewKernel?.risk || null;

      const firstSymbolUid = String(primarySymbols[0]?.uid || '').trim();
      recommendedHandoff = firstSymbolUid
        ? { tool: 'context', params: { uid: firstSymbolUid } }
        : null;
    } else {
      const debug = routedResult?.debug || {};
      const candidates = Array.isArray(debug?.candidates) ? debug.candidates : [];
      primarySymbols = [
        ...(Array.isArray(debug?.anchors?.top_symbols) ? debug.anchors.top_symbols : []),
      ].map(normalizeSymbol).filter(Boolean);
      primaryFiles = primarySymbols.map((symbol: any) => String(symbol?.filePath || '').trim()).filter(Boolean);
      hypotheses = Array.isArray(debug?.hypotheses) ? debug.hypotheses : [];
      topFindings = [
        ...hypotheses,
        ...candidates.slice(0, 3).map((candidate: any) => String(candidate?.summary || '').trim()).filter(Boolean),
      ];
      nextActions = Array.isArray(debug?.next_actions) ? debug.next_actions : [];

      const candidateScore = Number(candidates[0]?.score || 0);
      risk = {
        level: candidateScore >= 8 ? 'high' : candidateScore >= 4 ? 'medium' : 'low',
        score: candidateScore,
      };

      const firstSymbolUid = String(primarySymbols[0]?.uid || '').trim();
      recommendedHandoff = firstSymbolUid
        ? { tool: 'context', params: { uid: firstSymbolUid } }
        : null;
    }

    primarySymbols = uniqueByKey(primarySymbols, (symbol: any) => String(symbol?.uid || symbol?.filePath || ''))
      .slice(0, 20);
    primaryFiles = uniqueByKey(primaryFiles, (filePath: string) => String(filePath || '').trim())
      .slice(0, 20);
    topFindings = uniqueByKey(topFindings.filter(Boolean), (item: string) => String(item || ''))
      .slice(0, 10);
    hypotheses = uniqueByKey(hypotheses.filter(Boolean), (item: string) => String(item || ''))
      .slice(0, 10);
    nextActions = uniqueByKey(nextActions.filter(Boolean), (item: string) => String(item || ''))
      .slice(0, 10);

    const unified = {
      primary_symbols: primarySymbols,
      primary_files: primaryFiles,
      top_findings: topFindings,
      hypotheses,
      next_actions: nextActions,
      risk,
      recommended_handoff: recommendedHandoff,
    };

    const routeTraceCandidates = Array.from(candidateByMode.values())
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return tiePriority.indexOf(left.mode) - tiePriority.indexOf(right.mode);
      })
      .map(candidate => ({
        mode: candidate.mode,
        score: candidate.score,
        reasons: uniqueByKey(candidate.reasons, item => String(item || '')).slice(0, 6),
      }));

    const fallbackApplied = requestedMode === 'auto'
      && !queryText
      && !hasSymptomSignal
      && selectedMode === 'review'
      && !hasReviewSignal;

    const route_trace = {
      requested_mode: requestedMode,
      selected_mode: selectedMode,
      fallback_applied: fallbackApplied,
      candidates: routeTraceCandidates,
    };

    return {
      status: 'ok',
      repo: repo.name,
      mode_router: {
        selected_mode: selectedMode,
        signals: routingSignals,
        route_trace,
        unified,
        result: routedResult,
      },
      _mode_router: {
        knobs: {
          requested_mode: requestedMode,
          scope,
          base_ref: baseRef || null,
          path_prefixes: pathPrefixes,
        },
      },
    };
  }

  private async actionPlan(repo: RepoHandle, params: {
    query: string;
    task_context?: string;
    goal?: string;
    path_prefixes?: string[];
    limit_files?: number;
    limit_checks?: number;
    __skip_precedents?: boolean;
  }): Promise<any> {
    const limitFiles = Math.max(1, Math.min(50, params.limit_files ?? 10));
    const limitChecks = Math.max(1, Math.min(20, params.limit_checks ?? 10));
    const skipPrecedents = params.__skip_precedents === true;
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
    const isInScope = (filePath: string): boolean => filePathTouchesPrefixes(filePath, pathPrefixes);

    const result = await this.query(repo, {
      query: params.query,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
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
        kind: 'enum_case' | 'policy_method' | 'permission_slug';
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
        if (uid.startsWith('CodeElement:permission:')) {
          candidates.push({
            kind: 'permission_slug',
            uid,
            name: row.name || row[1] || '',
            type: 'CodeElement',
            filePath: row.filePath || row[3] || '',
            edge: {
              reason: row.reason || row[4] || '',
              confidence: Number(row.confidence ?? row[5] ?? 1.0),
            },
          });
          continue;
        }
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

      const expandSlugToGrant = async (
        slugUid: string,
        evidence: { controller_edge: { reason: string; confidence: number }; via_policy?: any; }
      ): Promise<void> => {
        const slugEsc = slugUid.replace(/'/g, "''");
        let slugRows: any[] = [];
        try {
          slugRows = await executeQuery(repo.id, `
            MATCH (s:CodeElement {id: '${slugEsc}'})
            RETURN s.id AS uid, s.name AS name, s.filePath AS filePath
            LIMIT 1
          `);
        } catch {
          return;
        }

        const slugRow = slugRows[0] || null;
        const slug = String(slugRow?.name || '').trim();
        if (!slug) return;

        const key = `${slugUid}:${slug}`;
        if (seen.has(key)) return;
        seen.add(key);

        const slugNode = await normalizeNode(slugUid, {
          id: slugUid,
          name: slug,
          type: 'CodeElement',
          filePath: slugRow?.filePath || '',
        });

        let roleRows: any[] = [];
        try {
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
            filePath: slugRow?.filePath || '',
          },
          roles,
          evidence,
        });
      };

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
        if (candidate.kind === 'permission_slug') {
          await expandSlugToGrant(candidate.uid, { controller_edge: candidate.edge });
          continue;
        }

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

    const cache_effects: any[] = [];
    try {
      const tsLikeFiles = files
        .map(f => String(f?.filePath || '').trim())
        .filter(Boolean)
        .filter(isTsLikeFilePath)
        .slice(0, 3);

      for (const filePath of tsLikeFiles) {
        const fullPath = path.join(repo.repoPath, filePath);
        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        const card = await extractUiContractCard(filePath, content);
        const cacheLinks = Array.isArray((card as any)?.cacheLinks) ? (card as any).cacheLinks : [];
        const queries = Array.isArray((card as any)?.queries) ? (card as any).queries : [];
        const cacheCoverage = Array.isArray((card as any)?.cacheCoverage) ? (card as any).cacheCoverage : [];
        if (cacheLinks.length === 0 && queries.length === 0) continue;

        const linkSummaries = cacheLinks
          .map((l: any) => ({
            operation: l?.operation || null,
            matches: Array.isArray(l?.matches) ? l.matches : [],
          }))
          .filter((l: any) => l.operation && l.operation.method && l.operation.queryKey)
          .map((l: any) => ({
            operation: {
              kind: l.operation.kind,
              method: l.operation.method,
              queryKey: l.operation.queryKey,
              line: l.operation.line,
              confidence: l.operation.confidence,
            },
            matches: l.matches.map((m: any) => ({
              hook: m.hook,
              queryKey: m.queryKey,
              match: m.match,
              line: m.line,
              confidence: m.confidence,
            })),
          }));

        const matched = linkSummaries.filter((l: any) => l.matches.length > 0);
        const refetchCount = linkSummaries.filter((l: any) => l.operation.kind === 'refetch').length;
        const writeCount = linkSummaries.filter((l: any) => l.operation.kind === 'write').length;
        const removeCount = linkSummaries.filter((l: any) => l.operation.kind === 'remove').length;

        const coverageGaps = cacheCoverage
          .filter((c: any) => Array.isArray(c?.missing_queries) && c.missing_queries.length > 0)
          .map((c: any) => ({
            interaction: c?.interaction || null,
            mutations: Array.isArray(c?.mutations) ? c.mutations.slice(0, 5) : [],
            operations: Array.isArray(c?.operations) ? c.operations.slice(0, 8) : [],
            missing_queries: Array.isArray(c?.missing_queries) ? c.missing_queries.slice(0, 8) : [],
            confidence: c?.confidence ?? 0.35,
          }))
          .slice(0, 10);

        cache_effects.push({
          filePath,
          summary: {
            queries: queries.length,
            operations: linkSummaries.length,
            matched_operations: matched.length,
            unmatched_operations: linkSummaries.length - matched.length,
            refetch_triggers: refetchCount,
            cache_writes: writeCount,
            cache_removes: removeCount,
            coverage_gaps: coverageGaps.length,
          },
          links: matched.slice(0, 25),
          coverage_gaps: coverageGaps,
        });
      }
    } catch { /* ignore */ }

    const parseSliceRole = (reason: string): string => {
      const raw = String(reason || '').trim();
      if (!raw) return '';
      if (!raw.startsWith('feature-slice:')) return raw;
      return raw.slice('feature-slice:'.length).trim();
    };

    const roleWritePriority = (role: string): number => {
      const normalized = String(role || '').trim().toLowerCase();
      if (normalized === 'anchor') return 0;
      if (normalized === 'entrypoint') return 1;
      if (normalized === 'handler') return 2;
      if (normalized === 'authorization') return 3;
      if (normalized === 'authorization_consumer') return 4;
      if (normalized === 'query_consumer') return 5;
      if (normalized === 'supporting') return 6;
      return 10;
    };

    const sliceCards: any[] = Array.isArray(result?.slice_cards) ? result.slice_cards : [];
    const targetSlice = sliceCards[0] || null;
    const queryIntent = String(result?.query_plan?.intent || '').trim() || undefined;
    const topProcesses = Array.isArray(result?.processes) ? result.processes : [];

    let precedentPack: any = null;
    if (!skipPrecedents) {
      try {
        precedentPack = await this.precedents(repo, {
          query: params.query,
          ...(targetSlice?.anchor_id ? { anchor_uid: String(targetSlice.anchor_id) } : {}),
          limit: 2,
          examples: 3,
          path_prefixes: pathPrefixes,
        });
      } catch {
        precedentPack = null;
      }
    }

    const precedentItems: any[] = Array.isArray(precedentPack?.precedents) ? precedentPack.precedents : [];
    const implementPrecedents = precedentItems.slice(0, 3).map((item: any) => ({
      kind: item?.kind,
      signature: item?.signature,
      anchor: item?.anchor,
      examples: Array.isArray(item?.examples) ? item.examples.slice(0, 3) : [],
    }));

    const companionSignals = new Map<string, {
      filePath: string;
      score: number;
      reasons: Set<string>;
      anchors: Array<{ id?: string; name?: string; type?: string; startLine?: number; endLine?: number }>;
    }>();
    const companionSources = {
      seed_files: 0,
      slice_members: 0,
      cochange_edges: 0,
      shape_edges: 0,
    };

    const addCompanionSignal = (
      filePathRaw: string,
      score: number,
      reason: string,
      anchor?: { id?: string; name?: string; type?: string; startLine?: number; endLine?: number },
    ) => {
      const filePath = normalizeRepoRelativePath(String(filePathRaw || ''));
      if (!filePath) return;
      if (!isInScope(filePath)) return;

      const nextScore = Number(score);
      if (!Number.isFinite(nextScore) || nextScore <= 0) return;

      let entry = companionSignals.get(filePath);
      if (!entry) {
        entry = { filePath, score: 0, reasons: new Set<string>(), anchors: [] };
        companionSignals.set(filePath, entry);
      }
      entry.score += nextScore;
      if (reason) entry.reasons.add(reason);
      if (anchor) entry.anchors.push(anchor);
    };

    for (const file of files.slice(0, 10)) {
      addCompanionSignal(String(file?.filePath || ''), Number(file?.score || 0) + 0.1, 'ranked-file');
      companionSources.seed_files += 1;
    }

    let targetTemplate: any = null;
    const writeOrder: any[] = [];
    let targetSliceGapSummary = {
      total: 0,
      deterministic: 0,
      pattern: 0,
      heuristic: 0,
      high: 0,
      medium: 0,
      low: 0,
    };

    if (targetSlice?.uid || targetSlice?.anchor_id) {
      const targetSliceId = String(targetSlice.uid || '').trim();
      if (targetSliceId) {
        const escapedSliceId = targetSliceId.replace(/'/g, "''");
        let memberRows: any[] = [];
        try {
          memberRows = await executeQuery(repo.id, `
            MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice {id: '${escapedSliceId}'})
            WHERE r.reason STARTS WITH 'feature-slice:'
            RETURN n.id AS uid, n.name AS name, labels(n) AS kind, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, r.reason AS roleReason
            LIMIT 5000
          `);
        } catch {
          memberRows = [];
        }

        const memberIds: string[] = [];
        const memberFiles = new Set<string>();
        const seenWrite = new Set<string>();

        for (const row of memberRows) {
          const uid = String(row.uid ?? row[0] ?? '').trim();
          const name = String(row.name ?? row[1] ?? '').trim();
          const kindValue = row.kind ?? row[2];
          const kind = Array.isArray(kindValue) ? String(kindValue[0] || '').trim() : String(kindValue || '').trim();
          const filePath = normalizeRepoRelativePath(String(row.filePath ?? row[3] ?? ''));
          const role = parseSliceRole(String(row.roleReason ?? row[6] ?? '').trim());
          const startLine = Number(row.startLine ?? row[4]);
          const endLine = Number(row.endLine ?? row[5]);

          if (!uid || !filePath) continue;
          if (!isInScope(filePath)) continue;

          memberIds.push(uid);
          memberFiles.add(filePath);

          const key = `${uid}|${role}`;
          if (!seenWrite.has(key)) {
            seenWrite.add(key);
            writeOrder.push({
              uid,
              name,
              kind,
              filePath,
              role,
              role_priority: roleWritePriority(role),
              ...(Number.isFinite(startLine) ? { startLine } : {}),
              ...(Number.isFinite(endLine) ? { endLine } : {}),
            });
          }

          addCompanionSignal(filePath, 2.5, `slice-member:${role || 'supporting'}`, {
            id: uid,
            name,
            type: kind,
            ...(Number.isFinite(startLine) ? { startLine } : {}),
            ...(Number.isFinite(endLine) ? { endLine } : {}),
          });
          companionSources.slice_members += 1;
        }

        if (memberFiles.size > 0) {
          const fileList = Array.from(memberFiles).slice(0, 80);
          const fileListCypher = `[${fileList.map(filePath => `'${filePath.replace(/'/g, "''")}'`).join(', ')}]`;

          let cochangeRows: any[] = [];
          try {
            cochangeRows = await executeQuery(repo.id, `
              MATCH (a:File)-[r:CodeRelation {type: 'CO_CHANGES_WITH'}]->(b:File)
              WHERE a.filePath IN ${fileListCypher}
              RETURN b.filePath AS filePath, MAX(r.confidence) AS confidence
              ORDER BY confidence DESC
              LIMIT 120
            `);
          } catch {
            cochangeRows = [];
          }

          for (const row of cochangeRows) {
            const filePath = String(row.filePath ?? row[0] ?? '').trim();
            const confidence = Number(row.confidence ?? row[1] ?? 0) || 0;
            if (!filePath) continue;
            if (fileList.includes(filePath)) continue;
            addCompanionSignal(filePath, Math.max(0.05, confidence), 'cochange-neighbor');
            companionSources.cochange_edges += 1;
          }
        }

        if (memberIds.length > 0) {
          const memberIdsCypher = `[${memberIds.slice(0, 150).map(uid => `'${uid.replace(/'/g, "''")}'`).join(', ')}]`;
          let shapeRows: any[] = [];
          try {
            shapeRows = await executeQuery(repo.id, `
              MATCH (n)-[r:CodeRelation]->(m)
              WHERE n.id IN ${memberIdsCypher}
                AND r.type IN ['VALIDATES_FIELD', 'SERIALIZES_FIELD', 'READS_FIELD', 'WRITES_FIELD', 'INVALIDATES_KEY', 'TESTS_SHAPE', 'DERIVES_FROM_COLUMN']
                AND m.filePath IS NOT NULL
              RETURN m.filePath AS filePath, r.type AS relType, COUNT(*) AS count
              ORDER BY count DESC
              LIMIT 200
            `);
          } catch {
            shapeRows = [];
          }

          for (const row of shapeRows) {
            const filePath = String(row.filePath ?? row[0] ?? '').trim();
            const relType = String(row.relType ?? row[1] ?? '').trim();
            const count = Number(row.count ?? row[2] ?? 0) || 0;
            if (!filePath || !relType || count <= 0) continue;
            addCompanionSignal(filePath, Math.min(3, 0.3 + (count * 0.2)), `shape-link:${relType.toLowerCase()}`);
            companionSources.shape_edges += count;
          }
        }

        try {
          const gapRows = await executeQuery(repo.id, `
            MATCH (g:Gap)-[:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice {id: '${escapedSliceId}'})
            RETURN g.absenceTier AS absenceTier, g.severity AS severity
            LIMIT 500
          `);
          for (const row of gapRows) {
            const absenceTier = String(row.absenceTier ?? row[0] ?? '').trim();
            const severity = String(row.severity ?? row[1] ?? '').trim();
            targetSliceGapSummary.total += 1;
            if (absenceTier === 'deterministic_missing') targetSliceGapSummary.deterministic += 1;
            else if (absenceTier === 'pattern_missing') targetSliceGapSummary.pattern += 1;
            else if (absenceTier === 'heuristic_suspicion') targetSliceGapSummary.heuristic += 1;

            if (severity === 'high') targetSliceGapSummary.high += 1;
            else if (severity === 'medium') targetSliceGapSummary.medium += 1;
            else if (severity === 'low') targetSliceGapSummary.low += 1;
          }
        } catch { /* ignore */ }

        try {
          const closureSnapshot = await loadClosureTemplateSnapshot(repo.storagePath);
          const templates = (Array.isArray(closureSnapshot.templates) ? closureSnapshot.templates : [])
            .filter(template => String(template?.sliceType || '').trim() === String(targetSlice.slice_type || '').trim());

          if (templates.length > 0) {
            const closedSlots = new Set(
              (Array.isArray(targetSlice.closed_slots) ? targetSlice.closed_slots : [])
                .map((slot: any) => String(slot || '').trim())
                .filter(Boolean),
            );
            const targetRoles = new Set(
              (Array.isArray(targetSlice.roles) ? targetSlice.roles : [])
                .map((role: any) => String(role || '').trim())
                .filter(Boolean),
            );

            let best: any = null;
            let bestScore = -1;
            for (const template of templates) {
              const requiredSlots = Array.isArray(template.requiredSlots) ? template.requiredSlots.map((item: any) => String(item || '').trim()).filter(Boolean) : [];
              const templateRoles = Array.isArray(template.roleCoverage)
                ? template.roleCoverage.map((item: any) => String(item?.role || '').trim()).filter(Boolean)
                : [];
              const requiredHits = requiredSlots.filter((slot: string) => closedSlots.has(slot)).length;
              const roleHits = templateRoles.filter((role: string) => targetRoles.has(role)).length;
              const requiredScore = requiredSlots.length > 0 ? (requiredHits / requiredSlots.length) : 1;
              const roleScore = templateRoles.length > 0 ? (roleHits / templateRoles.length) : 1;
              const score = (requiredScore * 0.7) + (roleScore * 0.3);
              if (score > bestScore) {
                bestScore = score;
                best = template;
              }
            }

            if (best) {
              const requiredSlots = Array.isArray(best.requiredSlots) ? best.requiredSlots.map((item: any) => String(item || '').trim()).filter(Boolean) : [];
              const roleExpectations = Array.isArray(best.roleCoverage)
                ? best.roleCoverage
                  .map((item: any) => ({
                    role: String(item?.role || '').trim(),
                    coverage: Number(item?.coverage || 0) || 0,
                    count: Number(item?.count || 0) || 0,
                  }))
                  .filter((item: any) => item.role)
                : [];

              targetTemplate = {
                id: String(best.id || '').trim(),
                template_key: String(best.templateKey || '').trim(),
                slice_type: String(best.sliceType || '').trim(),
                required_slots: requiredSlots,
                optional_slots: Array.isArray(best.optionalSlots) ? best.optionalSlots.map((item: any) => String(item || '').trim()).filter(Boolean) : [],
                role_expectations: roleExpectations,
                avg_closure_score: Number(best.avgClosureScore || 0) || 0,
                slice_count: Number(best.sliceCount || 0) || 0,
                exemplar_slice_ids: Array.isArray(best.exemplarSliceIds) ? best.exemplarSliceIds.map((item: any) => String(item || '').trim()).filter(Boolean) : [],
              };
            }
          }
        } catch { /* ignore */ }
      }
    }

    const companionFiles = Array.from(companionSignals.values())
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.filePath.localeCompare(right.filePath);
      })
      .slice(0, Math.min(limitFiles + 5, 15))
      .map(entry => ({
        filePath: entry.filePath,
        score: Number(entry.score.toFixed(3)),
        reasons: Array.from(entry.reasons).slice(0, 6),
        anchors: entry.anchors.slice(0, 4),
      }));

    const orderedWriteSteps = writeOrder
      .sort((left, right) => {
        if (left.role_priority !== right.role_priority) return left.role_priority - right.role_priority;
        const leftStart = Number(left.startLine ?? Number.MAX_SAFE_INTEGER);
        const rightStart = Number(right.startLine ?? Number.MAX_SAFE_INTEGER);
        if (leftStart !== rightStart) return leftStart - rightStart;
        if (left.filePath !== right.filePath) return String(left.filePath).localeCompare(String(right.filePath));
        return String(left.uid).localeCompare(String(right.uid));
      })
      .slice(0, 16)
      .map(step => ({
        uid: step.uid,
        name: step.name,
        kind: step.kind,
        filePath: step.filePath,
        role: step.role,
        ...(step.startLine !== undefined ? { startLine: step.startLine } : {}),
        ...(step.endLine !== undefined ? { endLine: step.endLine } : {}),
      }));

    const targetArchetype = String(
      implementPrecedents[0]?.signature
      || topProcesses[0]?.process_type
      || topProcesses[0]?.summary
      || '',
    ).trim() || null;

    const implement_plan = {
      target: {
        query_intent: queryIntent || null,
        archetype: targetArchetype,
        slice: targetSlice
          ? {
            uid: targetSlice.uid,
            label: targetSlice.label,
            slice_type: targetSlice.slice_type,
            anchor_id: targetSlice.anchor_id,
            anchor_name: targetSlice.anchor_name,
            closure_score: targetSlice.closure_score,
            closure_slots: Array.isArray(targetSlice.closure_slots) ? targetSlice.closure_slots : [],
            closed_slots: Array.isArray(targetSlice.closed_slots) ? targetSlice.closed_slots : [],
            roles: Array.isArray(targetSlice.roles) ? targetSlice.roles : [],
          }
          : null,
      },
      precedents: implementPrecedents,
      closure_template: targetTemplate,
      companion_set: {
        files: companionFiles,
        summary: {
          total_files: companionFiles.length,
          seed_files: companionSources.seed_files,
          slice_members: companionSources.slice_members,
          cochange_edges: companionSources.cochange_edges,
          shape_edges: companionSources.shape_edges,
        },
      },
      write_order: orderedWriteSteps,
      gap_signals: targetSliceGapSummary,
      post_edit_review: {
        tool: 'review_mode',
        params: {
          scope: 'unstaged',
          ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
          include_slice_stencil: true,
          include_evidence_spans: true,
        },
      },
    };

    return {
      status: 'ok',
      repo: repo.name,
      query: params.query,
      files,
      checks: checks.slice(0, limitChecks),
      top_processes: Array.isArray(result?.processes) ? result.processes.slice(0, 3) : [],
      hops,
      cache_effects,
      implement_plan,
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

  private async uiContract(repo: RepoHandle, params: {
    file_path: string;
    base_ref?: string;
    include_endpoints?: boolean;
    min_http_confidence?: number;
    path_prefixes?: string[];
  }): Promise<any> {
    const rawPath = String(params.file_path || '').trim();
    if (!rawPath) return { error: 'file_path is required and cannot be empty.' };

    const normalizedInput = rawPath.replace(/\\/g, '/');
    const absPath = path.isAbsolute(normalizedInput)
      ? normalizedInput
      : path.join(repo.repoPath, normalizedInput);

    const relativePath = path.relative(repo.repoPath, absPath).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..')) {
      return { error: `file_path must be inside the repo (${repo.repoPath})` };
    }

    const fullPath = path.join(repo.repoPath, relativePath);

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err: any) {
      return { error: `Unable to read file: ${relativePath} (${err?.message || 'unknown error'})` };
    }

    const card = await extractUiContractCard(relativePath, content);

    const includeEndpoints = params.include_endpoints !== false;
    const minHttpConfidence = params.min_http_confidence ?? 0.9;
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);

    let endpoints: any[] = [];
    if (includeEndpoints) {
      await this.ensureInitialized(repo.id);

      const fileEsc = relativePath.replace(/'/g, "''");
      const conf = Math.max(0, Math.min(1, minHttpConfidence));

      const directRows = await executeQuery(repo.id, `
        MATCH (f:File {filePath: '${fileEsc}'})-[d:CodeRelation {type: 'DEFINES'}]->(src)
        MATCH (src)-[r:CodeRelation {type: 'CALLS'}]->(target:Method)
        WHERE r.reason STARTS WITH 'http-' AND r.confidence >= ${conf}
        OPTIONAL MATCH (target)-[:CodeRelation {type: 'MEMBER_OF'}]->(container:Class)
        RETURN src.id AS surfaceId,
               src.name AS surfaceName,
               src.filePath AS surfaceFilePath,
               src.startLine AS surfaceStartLine,
               src.id AS httpCallerId,
               src.name AS httpCallerName,
               src.filePath AS httpCallerFilePath,
               src.startLine AS httpCallerStartLine,
               r.reason AS reason,
               r.confidence AS confidence,
               target.id AS controllerId,
               target.name AS controllerName,
               target.filePath AS controllerFilePath,
               target.startLine AS controllerStartLine,
               container.name AS controllerClassName
        ORDER BY confidence DESC
        LIMIT 200
      `);

      const hopRows = await executeQuery(repo.id, `
        MATCH (f:File {filePath: '${fileEsc}'})-[d:CodeRelation {type: 'DEFINES'}]->(src)
        MATCH (src)-[:CodeRelation {type: 'CALLS'}]->(mid)-[r:CodeRelation {type: 'CALLS'}]->(target:Method)
        WHERE r.reason STARTS WITH 'http-' AND r.confidence >= ${conf}
        OPTIONAL MATCH (target)-[:CodeRelation {type: 'MEMBER_OF'}]->(container:Class)
        RETURN src.id AS surfaceId,
               src.name AS surfaceName,
               src.filePath AS surfaceFilePath,
               src.startLine AS surfaceStartLine,
               mid.id AS httpCallerId,
               mid.name AS httpCallerName,
               mid.filePath AS httpCallerFilePath,
               mid.startLine AS httpCallerStartLine,
               r.reason AS reason,
               r.confidence AS confidence,
               target.id AS controllerId,
               target.name AS controllerName,
               target.filePath AS controllerFilePath,
               target.startLine AS controllerStartLine,
               container.name AS controllerClassName
        ORDER BY confidence DESC
        LIMIT 200
      `);

      const rows = [...directRows, ...hopRows];

      const seen = new Set<string>();
      endpoints = rows
        .map((row: any) => ({
          http: { reason: row.reason ?? row[8] ?? '', confidence: row.confidence ?? row[9] ?? 1.0 },
          surface: {
            uid: row.surfaceId ?? row[0] ?? '',
            name: row.surfaceName ?? row[1] ?? '',
            filePath: row.surfaceFilePath ?? row[2] ?? '',
            startLine: row.surfaceStartLine ?? row[3] ?? undefined,
          },
          http_caller: {
            uid: row.httpCallerId ?? row[4] ?? '',
            name: row.httpCallerName ?? row[5] ?? '',
            filePath: row.httpCallerFilePath ?? row[6] ?? '',
            startLine: row.httpCallerStartLine ?? row[7] ?? undefined,
          },
          controller: {
            uid: row.controllerId ?? row[10] ?? '',
            name: (() => {
              const base = row.controllerName ?? row[11] ?? '';
              const cls = row.controllerClassName ?? row[14] ?? '';
              return cls && base ? `${cls}::${base}` : base;
            })(),
            filePath: row.controllerFilePath ?? row[12] ?? '',
            startLine: row.controllerStartLine ?? row[13] ?? undefined,
            type: 'Method',
          },
        }))
        .filter((e: any) => e.http.reason)
        .filter((e: any) => {
          const key = `${e.http.reason}::${e.controller.uid}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 50);

      if (pathPrefixes.length > 0) {
        endpoints = endpoints.filter((e: any) => {
          const surfacePath = String(e?.surface?.filePath || '').trim();
          const callerPath = String(e?.http_caller?.filePath || '').trim();
          const controllerPath = String(e?.controller?.filePath || '').trim();
          if (filePathTouchesPrefixes(surfacePath, pathPrefixes)) return true;
          if (filePathTouchesPrefixes(callerPath, pathPrefixes)) return true;
          if (filePathTouchesPrefixes(controllerPath, pathPrefixes)) return true;
          return false;
        });
      }
    }

    const baseRef = String(params.base_ref || '').trim();
    if (!baseRef) {
      return {
        status: 'ok',
        file_path: relativePath,
        ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
        contract: card,
        endpoints,
      };
    }

    const readFileAtRef = async (): Promise<string | null> => {
      const { spawn } = await import('child_process');
      return await new Promise(resolve => {
        const child = spawn('git', ['-C', repo.repoPath, 'show', `${baseRef}:./${relativePath}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const stdoutChunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.on('error', () => resolve(null));
        child.on('close', code => {
          if (code !== 0) return resolve(null);
          resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
        });
      });
    };

    const baseContent = await readFileAtRef();
    if (baseContent === null) {
      return {
        status: 'ok',
        file_path: relativePath,
        ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
        contract: card,
        endpoints,
        diff: { error: `Unable to read ${relativePath} at ${baseRef} (git show failed).` },
      };
    }

    const baseCard = await extractUiContractCard(relativePath, baseContent);

    const keyControlled = (s: any): string => `${s.element}|open:${s.open}|onOpenChange:${s.onOpenChange}`;
    const keyInteraction = (i: any): string => `${i.event}|${i.element}|${i.handler?.kind || ''}|${i.handler?.name || ''}`;
    const keySmell = (s: any): string => `${s.kind}|${s.message}`;
    const keyQuery = (q: any): string => {
      const hook = q?.hook ?? '';
      const queryKey = q?.queryKey ?? '';
      const enabled = q?.enabled ?? '';
      const staleTime = q?.staleTime ?? '';
      const refetchOnMount = q?.refetchOnMount ?? '';
      const refetchOnWindowFocus = q?.refetchOnWindowFocus ?? '';
      const refetchInterval = q?.refetchInterval ?? '';
      const gcTime = q?.gcTime ?? '';
      return `${hook}|${queryKey}|enabled:${enabled}|staleTime:${staleTime}|refetchOnMount:${refetchOnMount}|refetchOnWindowFocus:${refetchOnWindowFocus}|refetchInterval:${refetchInterval}|gcTime:${gcTime}`;
    };

    const toSet = (list: any[], keyFn: (v: any) => string): Set<string> => new Set(list.map(keyFn).filter(Boolean));

    const baseControlled = toSet(baseCard.controlled, keyControlled);
    const currControlled = toSet(card.controlled, keyControlled);
    const baseInteractions = toSet(baseCard.interactions, keyInteraction);
    const currInteractions = toSet(card.interactions, keyInteraction);
    const baseSmells = toSet(baseCard.smells, keySmell);
    const currSmells = toSet(card.smells, keySmell);
    const baseQueries = toSet(baseCard.queries || [], keyQuery);
    const currQueries = toSet(card.queries || [], keyQuery);

    const effectKey = (e: any): string => `${e.kind}|${e.callee}|${e.args}`;
    const effectsByInteraction = (c: any): Map<string, Set<string>> => {
      const map = new Map<string, Set<string>>();
      for (const interaction of c?.interactions || []) {
        const key = keyInteraction(interaction);
        const set = new Set<string>();
        for (const eff of interaction.effects || []) {
          const k = effectKey(eff);
          if (k) set.add(k);
        }
        map.set(key, set);
      }
      return map;
    };

    const baseEffects = effectsByInteraction(baseCard);
    const currEffects = effectsByInteraction(card);

    const interaction_effects_diff = [...currInteractions]
      .map(key => {
        const baseSet = baseEffects.get(key) || new Set<string>();
        const currSet = currEffects.get(key) || new Set<string>();
        const added = [...currSet].filter(e => !baseSet.has(e));
        const removed = [...baseSet].filter(e => !currSet.has(e));
        if (added.length === 0 && removed.length === 0) return null;
        return { interaction: key, added: added.slice(0, 25), removed: removed.slice(0, 25) };
      })
      .filter(Boolean)
      .slice(0, 50);

    const diff = {
      base_ref: baseRef,
      controlled_added: [...currControlled].filter(k => !baseControlled.has(k)),
      controlled_removed: [...baseControlled].filter(k => !currControlled.has(k)),
      interactions_added: [...currInteractions].filter(k => !baseInteractions.has(k)),
      interactions_removed: [...baseInteractions].filter(k => !currInteractions.has(k)),
      smells_added: [...currSmells].filter(k => !baseSmells.has(k)),
      smells_removed: [...baseSmells].filter(k => !currSmells.has(k)),
      queries_added: [...currQueries].filter(k => !baseQueries.has(k)),
      queries_removed: [...baseQueries].filter(k => !currQueries.has(k)),
      interaction_effects_diff,
      effects_summary: {
        base: baseCard.effectsSummary,
        current: card.effectsSummary,
      },
    };

    return {
      status: 'ok',
      file_path: relativePath,
      ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
      contract: card,
      endpoints,
      base_contract: baseCard,
      diff,
    };
  }

  /**
   * Review mode — diff-aware summary for PRs and local changes.
   * Built on git diff + graph signals (callers/tests/routes/auth/UI contract).
   */
  private async reviewMode(repo: RepoHandle, params: {
    scope?: 'unstaged' | 'staged' | 'all' | 'compare';
    base_ref?: string;
    path_prefixes?: string[];
    limit_symbols?: number;
    limit_callers?: number;
    limit_tests?: number;
    min_confidence?: number;
    include_ui_contracts?: boolean;
    max_ui_contract_files?: number;
    include_evidence_spans?: boolean;
    limit_evidence?: number;
    include_slice_stencil?: boolean;
    limit_slice_stencil?: number;
  }): Promise<any> {
    await this.ensureInitialized(repo.id);

    const scope = params.scope || 'unstaged';
    const baseRef = String(params.base_ref || '').trim();
    const limitSymbols = Math.max(1, Math.min(500, params.limit_symbols ?? 60));
    const limitCallers = Math.max(1, Math.min(50, params.limit_callers ?? 10));
    const limitTests = Math.max(1, Math.min(50, params.limit_tests ?? 10));
    const minConfidence = Math.max(0, Math.min(1, params.min_confidence ?? 0.9));
    const includeUiContracts = params.include_ui_contracts !== false;
    const maxUiContractFiles = Math.max(0, Math.min(20, params.max_ui_contract_files ?? 5));
    const includeEvidenceSpans = params.include_evidence_spans !== false;
    const limitEvidence = Math.max(1, Math.min(200, params.limit_evidence ?? 40));
    const includeSliceStencil = params.include_slice_stencil !== false;
    const limitSliceStencil = Math.max(1, Math.min(25, params.limit_slice_stencil ?? 8));

    const normalizePath = (value: string): string => {
      return String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '');
    };

    const normalizePrefix = (value: string): string => {
      const raw = String(value || '').trim().replace(/\\/g, '/');
      if (!raw) return '';

      if (path.isAbsolute(raw)) {
        const rel = path.relative(repo.repoPath, raw).replace(/\\/g, '/');
        if (rel && !rel.startsWith('..')) return normalizePath(rel);
      }

      return normalizePath(raw);
    };

    const rawPrefixes = Array.isArray(params.path_prefixes)
      ? params.path_prefixes
      : typeof (params as any).path_prefixes === 'string'
        ? [(params as any).path_prefixes]
        : [];

    const pathPrefixes = Array.from(new Set(rawPrefixes.map(p => normalizePrefix(String(p || ''))).filter(Boolean)));
    const isInScope = (filePath: string): boolean => {
      if (pathPrefixes.length === 0) return true;
      const fp = normalizePath(filePath);
      if (!fp) return false;

      for (const prefixRaw of pathPrefixes) {
        const prefix = prefixRaw.endsWith('/') ? prefixRaw : `${prefixRaw}/`;
        if (fp === prefixRaw) return true;
        if (fp.startsWith(prefix)) return true;
      }
      return false;
    };

    type DiffHunk = { old_start: number; old_lines: number; new_start: number; new_lines: number };
    type DiffFile = {
      filePath: string;
      status: 'Modified' | 'Added' | 'Deleted' | 'Renamed' | 'Copied';
      fromPath?: string;
      hunks: DiffHunk[];
      binary?: boolean;
    };
    type SemanticFamily = 'auth' | 'shape' | 'cache' | 'test' | 'event' | 'template';

    const { execFileSync } = await import('child_process');

    const buildEmptySemanticDiffs = () => ({
      summary: {
        touched_edges: 0,
        family_count: 0,
        gap_signals: 0,
      },
      families: [] as Array<{
        family: SemanticFamily;
        edge_count: number;
        changed_symbols: number;
        incoming_edges: number;
        outgoing_edges: number;
        reasons: Array<{ reason: string; count: number }>;
        sample_edges: Array<{
          source: { uid: string; name: string; kind: string; filePath: string };
          target: { uid: string; name: string; kind: string; filePath: string };
          edge: { id: string; type: string; reason: string; confidence: number; witnessPathIds: string[] };
          direction: 'incoming' | 'outgoing' | 'internal';
        }>;
      }>,
      gap_signals: {
        total: 0,
        deterministic: 0,
        pattern: 0,
        heuristic: 0,
        high: 0,
        medium: 0,
        low: 0,
        gaps: [] as Array<{
          id: string;
          gapType: string;
          absenceTier: string;
          severity: string;
          sliceId: string;
          anchorId: string;
          missingSlots: string[];
          evidence: string[];
        }>,
      },
    });

    const buildEmptyProofPack = () => ({
      updated_at: '',
      summary: {
        symbol_spans: 0,
        edge_spans: 0,
        witness_spans: 0,
        proof_spans: 0,
      },
      symbols: [] as Array<{
        symbol: {
          uid: string;
          name: string;
          kind: string;
          filePath: string;
          startLine?: number;
          endLine?: number;
        };
        primary_span: any;
        witness_spans: any[];
        proof_spans: any[];
      }>,
      edges: [] as Array<{
        family: SemanticFamily;
        source: { uid: string; name: string; kind: string; filePath: string };
        target: { uid: string; name: string; kind: string; filePath: string };
        edge: { id: string; type: string; reason: string; confidence: number; witness_path_ids: string[] };
        witness_spans: any[];
        proof_spans: any[];
      }>,
    });

    const buildEmptySliceStencil = () => ({
      updated_at: '',
      summary: {
        changed_slices: 0,
        with_templates: 0,
        missing_required_slot_slices: 0,
        missing_role_slices: 0,
        sibling_candidates: 0,
      },
      slices: [] as Array<{
        slice: {
          id: string;
          label: string;
          heuristicLabel: string;
          sliceType: string;
          anchorId: string;
          anchorName: string;
          closureScore: number;
          closureSlots: string[];
          closedSlots: string[];
          roles: string[];
          changed_member_count: number;
        };
        changed_members: Array<{
          uid: string;
          name: string;
          kind: string;
          filePath: string;
          role: string;
          startLine?: number;
          endLine?: number;
        }>;
        template: null | {
          id: string;
          template_key: string;
          slice_type: string;
          required_slots: string[];
          optional_slots: string[];
          role_expectations: Array<{ role: string; coverage: number; count: number }>;
          avg_closure_score: number;
          slice_count: number;
        };
        stencil_delta: {
          missing_required_slots: string[];
          missing_roles: string[];
          closure_score_delta: number;
        };
        sibling_precedents: Array<{
          id: string;
          label: string;
          anchor_name: string;
          closure_score: number;
          shared_closed_slots: string[];
          shared_roles: string[];
        }>;
        gap_signals: {
          total: number;
          deterministic: number;
          pattern: number;
          heuristic: number;
          high: number;
          medium: number;
          low: number;
        };
      }>,
    });

    const buildReviewKernel = (input: {
      changed_files: number;
      changed_symbols: number;
      suggested_tests: number;
      ui_contracts: number;
      route_files: number;
      authz_controllers: number;
      semantic_diffs: ReturnType<typeof buildEmptySemanticDiffs>;
      slice_stencil: ReturnType<typeof buildEmptySliceStencil>;
      scope: string;
      path_prefixes: string[];
    }) => {
      const semanticGap = input.semantic_diffs?.gap_signals || {
        total: 0,
        deterministic: 0,
        pattern: 0,
        heuristic: 0,
        high: 0,
        medium: 0,
        low: 0,
      };
      const authFamily = (Array.isArray(input.semantic_diffs?.families) ? input.semantic_diffs.families : [])
        .find((family: any) => String(family?.family || '') === 'auth');
      const missingRequiredSlotSlices = Number(input.slice_stencil?.summary?.missing_required_slot_slices || 0);
      const missingRoleSlices = Number(input.slice_stencil?.summary?.missing_role_slices || 0);

      let riskScore = 0;
      riskScore += Math.min(4, Math.ceil(Number(input.changed_symbols || 0) / 8));
      riskScore += Math.min(6, (Number(semanticGap.high || 0) * 2) + Number(semanticGap.deterministic || 0));
      riskScore += Math.min(4, (missingRequiredSlotSlices * 2) + missingRoleSlices);
      if (Number(authFamily?.edge_count || 0) > 0 && Number(input.authz_controllers || 0) === 0) riskScore += 2;
      if (Number(input.suggested_tests || 0) === 0 && Number(input.changed_symbols || 0) > 0) riskScore += 1;

      const risk_level = riskScore >= 10 ? 'high' : riskScore >= 5 ? 'medium' : 'low';

      const top_findings: string[] = [];
      if (Number(semanticGap.high || 0) > 0) {
        top_findings.push(`High-severity gap signals detected (${Number(semanticGap.high || 0)}).`);
      }
      if (Number(semanticGap.deterministic || 0) > 0) {
        top_findings.push(`Deterministic missing links detected (${Number(semanticGap.deterministic || 0)}).`);
      }
      if (missingRequiredSlotSlices > 0) {
        top_findings.push(`Slices missing required closure slots (${missingRequiredSlotSlices}).`);
      }
      if (missingRoleSlices > 0) {
        top_findings.push(`Slices missing expected role coverage (${missingRoleSlices}).`);
      }
      if (Number(authFamily?.edge_count || 0) > 0 && Number(input.authz_controllers || 0) === 0) {
        top_findings.push('Auth-related relation deltas detected without controller auth closure checks.');
      }
      if (Number(input.route_files || 0) > 0) {
        top_findings.push(`Route files changed (${Number(input.route_files || 0)}); validate controller wiring targets.`);
      }
      if (Number(input.ui_contracts || 0) > 0) {
        top_findings.push(`UI contract diffs available (${Number(input.ui_contracts || 0)}).`);
      }
      if (top_findings.length === 0 && Number(input.changed_files || 0) === 0) {
        top_findings.push('No changed files detected for the selected review scope.');
      }

      const hypotheses: string[] = [];
      if (Number(semanticGap.high || 0) > 0 || Number(semanticGap.deterministic || 0) > 0) {
        hypotheses.push('Primary risk is incomplete closure on changed feature slices.');
      }
      if (Number(authFamily?.edge_count || 0) > 0 && Number(input.authz_controllers || 0) === 0) {
        hypotheses.push('Auth drift may exist between permission signals and runtime controller checks.');
      }
      if (Number(input.suggested_tests || 0) === 0 && Number(input.changed_symbols || 0) > 0) {
        hypotheses.push('Changed symbols may lack direct test callers in current graph coverage.');
      }
      if (hypotheses.length === 0 && Number(input.changed_files || 0) > 0) {
        hypotheses.push('Primary risk appears to be localized to changed files with bounded blast radius.');
      }

      const next_actions = [
        'Open top changed symbols with context() to confirm ownership and dependencies.',
        'Run impact() on the highest-risk changed symbol to validate direct dependents.',
      ];
      if (Number(semanticGap.total || 0) > 0 || missingRequiredSlotSlices > 0 || missingRoleSlices > 0) {
        next_actions.push('Review slice_stencil and semantic gap signals before applying follow-up edits.');
      }
      if (Number(input.route_files || 0) > 0) {
        next_actions.push('Verify route_targets controller mappings for each changed route file.');
      }
      if (Number(input.ui_contracts || 0) > 0) {
        next_actions.push('Inspect ui_contract diffs to verify mutation side-effects and cache triggers.');
      }
      if (Number(input.suggested_tests || 0) > 0) {
        next_actions.push('Run suggested tests first, then expand coverage only if failures indicate wider drift.');
      }

      return {
        risk: {
          level: risk_level,
          score: riskScore,
          signals: {
            changed_files: Number(input.changed_files || 0),
            changed_symbols: Number(input.changed_symbols || 0),
            semantic_gap_total: Number(semanticGap.total || 0),
            semantic_gap_high: Number(semanticGap.high || 0),
            missing_required_slot_slices: missingRequiredSlotSlices,
            missing_role_slices: missingRoleSlices,
          },
        },
        top_findings: top_findings.slice(0, 8),
        hypotheses: Array.from(new Set(hypotheses)).slice(0, 6),
        next_actions: next_actions.slice(0, 8),
        review_scope: {
          scope: input.scope,
          path_prefixes: input.path_prefixes,
        },
      };
    };

    const buildDiffArgs = (
      withPatch: boolean,
      scopeOverride?: 'unstaged' | 'staged' | 'all' | 'compare',
      baseRefOverride?: string,
    ): string[] => {
      const args = ['diff', '--no-color'];
      if (withPatch) args.push('-U0', '--patch');
      else args.push('--name-only');

      const effectiveScope = scopeOverride || scope;
      const effectiveBaseRef = String(baseRefOverride ?? baseRef).trim();

      switch (effectiveScope) {
        case 'staged':
          args.push('--staged');
          break;
        case 'all':
          args.push('HEAD');
          break;
        case 'compare':
          if (!effectiveBaseRef) throw new Error('base_ref is required for "compare" scope');
          // PR-style diff: merge base vs HEAD
          args.push(`${effectiveBaseRef}...HEAD`);
          break;
        case 'unstaged':
        default:
          break;
      }

      return args;
    };

    let changedFilesRaw: string[] = [];
    let effectiveScope: 'unstaged' | 'staged' | 'all' | 'compare' = scope;
    let diffSource = 'requested';
    try {
      const output = execFileSync('git', buildDiffArgs(false), { cwd: repo.repoPath, encoding: 'utf-8' });
      changedFilesRaw = String(output || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
    } catch (err: any) {
      return { error: `Git diff failed: ${err?.message || 'unknown error'}` };
    }

    // Compare scope may be empty in detached/local-only workflows while local working tree still has real changes.
    // Fallback to HEAD diff so review_mode remains useful instead of returning an empty review envelope.
    if (scope === 'compare' && changedFilesRaw.length === 0) {
      try {
        const output = execFileSync('git', buildDiffArgs(false, 'all'), { cwd: repo.repoPath, encoding: 'utf-8' });
        const fallbackFiles = String(output || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
        if (fallbackFiles.length > 0) {
          changedFilesRaw = fallbackFiles;
          effectiveScope = 'all';
          diffSource = 'compare-empty->all';
        }
      } catch {
        // keep original empty compare result if fallback also fails
      }
    }

    const changedFiles = changedFilesRaw
      .map(f => normalizePath(f))
      .filter(f => isInScope(f));

    if (changedFiles.length === 0) {
      const semantic_diffs = buildEmptySemanticDiffs();
      const proof_pack = buildEmptyProofPack();
      const slice_stencil = buildEmptySliceStencil();
      const review_kernel = buildReviewKernel({
        changed_files: 0,
        changed_symbols: 0,
        suggested_tests: 0,
        ui_contracts: 0,
        route_files: 0,
        authz_controllers: 0,
        semantic_diffs,
        slice_stencil,
        scope: effectiveScope,
        path_prefixes: pathPrefixes,
      });
      return {
        status: 'ok',
        repo: repo.name,
        scope,
        base_ref: baseRef || undefined,
        path_prefixes: pathPrefixes,
        summary: {
          changed_files: 0,
          changed_symbols: 0,
          suggested_tests: 0,
          semantic_families: semantic_diffs.summary.family_count,
          semantic_gap_signals: semantic_diffs.summary.gap_signals,
          proof_symbols: proof_pack.summary.symbol_spans,
          proof_edges: proof_pack.summary.edge_spans,
          stencil_slices: slice_stencil.summary.changed_slices,
          stencil_templates: slice_stencil.summary.with_templates,
        },
        changed_files: [],
        changed_symbols: [],
        symbols: [],
        suggested_tests: [],
        ui_contracts: [],
        route_targets: [],
        authz: [],
        semantic_diffs,
        proof_pack,
        slice_stencil,
        review_kernel,
        _review_mode: {
          diff: {
            requested_scope: scope,
            effective_scope: effectiveScope,
            fallback_applied: diffSource !== 'requested',
            source: diffSource,
          },
        },
      };
    }

    let patch = '';
    try {
      patch = execFileSync('git', buildDiffArgs(true, effectiveScope), {
        cwd: repo.repoPath,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 20, // 20MB
      });
    } catch (err: any) {
      return { error: `Git diff patch failed: ${err?.message || 'unknown error'}` };
    }

    const parsePatch = (text: string): DiffFile[] => {
      const files: DiffFile[] = [];
      let current: DiffFile | null = null;

      const pushCurrent = () => {
        if (!current) return;
        current.filePath = normalizePath(current.filePath);
        if (!current.filePath) return;
        if (!isInScope(current.filePath)) return;
        files.push(current);
      };

      for (const line of String(text || '').split('\n')) {
        if (line.startsWith('diff --git ')) {
          pushCurrent();

          const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
          if (!m) {
            current = null;
            continue;
          }

          const aPath = m[1];
          const bPath = m[2];
          const isAdded = aPath === '/dev/null';
          const isDeleted = bPath === '/dev/null';
          const filePath = isDeleted ? aPath : bPath;

          let status: DiffFile['status'] = 'Modified';
          if (isAdded) status = 'Added';
          if (isDeleted) status = 'Deleted';
          if (!isAdded && !isDeleted && aPath !== bPath) status = 'Renamed';

          current = {
            filePath,
            status,
            ...(status === 'Renamed' ? { fromPath: aPath } : {}),
            hunks: [],
          };
          continue;
        }

        if (!current) continue;

        if (line.startsWith('new file mode ')) {
          current.status = 'Added';
          continue;
        }
        if (line.startsWith('deleted file mode ')) {
          current.status = 'Deleted';
          continue;
        }

        const renameFrom = /^rename from (.+)$/.exec(line);
        if (renameFrom) {
          current.status = 'Renamed';
          current.fromPath = normalizePath(renameFrom[1] || '');
          continue;
        }
        const renameTo = /^rename to (.+)$/.exec(line);
        if (renameTo) {
          current.status = 'Renamed';
          current.filePath = normalizePath(renameTo[1] || current.filePath);
          continue;
        }

        if (line.startsWith('Binary files ')) {
          current.binary = true;
          continue;
        }

        const h = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
        if (h) {
          const oldStart = parseInt(h[1], 10);
          const oldLines = h[2] ? parseInt(h[2], 10) : 1;
          const newStart = parseInt(h[3], 10);
          const newLines = h[4] ? parseInt(h[4], 10) : 1;
          current.hunks.push({
            old_start: Number.isFinite(oldStart) ? oldStart : 0,
            old_lines: Number.isFinite(oldLines) ? oldLines : 0,
            new_start: Number.isFinite(newStart) ? newStart : 0,
            new_lines: Number.isFinite(newLines) ? newLines : 0,
          });
          continue;
        }
      }

      pushCurrent();
      return files;
    };

    const diffFiles = parsePatch(patch);

    // Fallback: if patch parsing failed (e.g., empty patch), still return name-only list.
    const changedFileObjs: DiffFile[] = diffFiles.length > 0
      ? diffFiles
      : changedFiles.map(filePath => ({ filePath, status: 'Modified', hunks: [] }));

    type ChangedSymbol = {
      uid: string;
      name: string;
      kind: string;
      filePath: string;
      startLine?: number;
      endLine?: number;
      evidence?: { hunks: Array<{ new_start: number; new_lines: number; old_start: number; old_lines: number }> };
    };

    const changedSymbolsById = new Map<string, ChangedSymbol>();
    const addChangedSymbol = (sym: ChangedSymbol) => {
      if (!sym.uid || !sym.filePath) return;
      if (!isInScope(sym.filePath)) return;

      const existing = changedSymbolsById.get(sym.uid);
      if (existing) {
        const existingHunks = existing.evidence?.hunks || [];
        const nextHunks = sym.evidence?.hunks || [];
        existing.evidence = { hunks: [...existingHunks, ...nextHunks] };
        return;
      }

      changedSymbolsById.set(sym.uid, sym);
    };

    const loadFileNode = async (filePath: string): Promise<ChangedSymbol | null> => {
      const escaped = filePath.replace(/'/g, "''");
      try {
        const rows = await executeQuery(repo.id, `
          MATCH (f:File {filePath: '${escaped}'})
          RETURN f.id AS id, f.name AS name, labels(f) AS type, f.filePath AS filePath
          LIMIT 1
        `);
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
          uid: r.id || r[0],
          name: r.name || r[1] || filePath,
          kind: r.type || r[2] || 'File',
          filePath: r.filePath || r[3] || filePath,
        };
      } catch {
        return null;
      }
    };

    for (const file of changedFileObjs) {
      const filePath = normalizePath(file.filePath);
      if (!filePath) continue;
      if (!isInScope(filePath)) continue;
      if (file.status === 'Deleted') continue;

      const hunks = Array.isArray(file.hunks) ? file.hunks : [];
      if (hunks.length === 0) {
        if (file.binary) {
          const fileNode = await loadFileNode(filePath);
          if (fileNode) addChangedSymbol(fileNode);
        }
        continue;
      }

      const ranges = hunks
        .filter(h => Number.isFinite(h?.new_start) && Number.isFinite(h?.new_lines))
        .map(h => {
          // Git diff hunk line numbers are 1-based; graph node startLine/endLine are 0-based rows.
          const start = Math.max(0, h.new_start - 1);
          const count = Math.max(1, h.new_lines);
          return { start, end: start + count - 1 };
        });
      if (ranges.length === 0) continue;

      const minStart = Math.min(...ranges.map(r => r.start));
      const maxEnd = Math.max(...ranges.map(r => r.end));

      const escaped = filePath.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (n)
          WHERE n.filePath = '${escaped}'
            AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
            AND n.startLine <= ${maxEnd} AND n.endLine >= ${minStart}
          RETURN n.id AS id, n.name AS name, labels(n) AS type, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
          LIMIT 200
        `);
      } catch {
        rows = [];
      }

      for (const row of rows) {
        const uid = row.id || row[0];
        if (!uid || typeof uid !== 'string') continue;
        const startLine = Number(row.startLine ?? row[4]);
        const endLine = Number(row.endLine ?? row[5]);
        const overlaps = ranges.some(r => {
          if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return true;
          return startLine <= r.end && endLine >= r.start;
        });
        if (!overlaps) continue;

        addChangedSymbol({
          uid,
          name: row.name || row[1] || '',
          kind: row.type || row[2] || '',
          filePath: row.filePath || row[3] || filePath,
          startLine: Number.isFinite(startLine) ? startLine : undefined,
          endLine: Number.isFinite(endLine) ? endLine : undefined,
          evidence: { hunks },
        });
      }
    }

    const changedSymbols = Array.from(changedSymbolsById.values())
      .slice(0, limitSymbols);

    const callerFetchLimit = Math.min(200, Math.max(limitCallers, limitTests) * 6);
    const changedSymbolIds = Array.from(new Set(
      changedSymbols
        .map(sym => String(sym?.uid || '').trim())
        .filter(Boolean)
    ));
    const changedSymbolIdSet = new Set(changedSymbolIds);
    const changedFilePathSet = new Set<string>();
    for (const sym of changedSymbols) {
      const fp = normalizePath(String(sym?.filePath || ''));
      if (fp) changedFilePathSet.add(fp);
    }
    for (const file of changedFileObjs) {
      if (file.status === 'Deleted') continue;
      const fp = normalizePath(String(file?.filePath || ''));
      if (fp) changedFilePathSet.add(fp);
    }

    const suggestedTestsAgg = new Map<string, { score: number; reasons: string[] }>();
    const addSuggestedTest = (filePath: string, scoreDelta: number, reason: string): void => {
      const fp = normalizePath(filePath);
      if (!fp) return;
      if (!isTestFilePath(fp)) return;
      if (pathPrefixes.length > 0 && !isInScope(fp)) return;

      const current = suggestedTestsAgg.get(fp) || { score: 0, reasons: [] as string[] };
      const safeScore = Number.isFinite(scoreDelta) ? Math.max(0.05, scoreDelta) : 0.05;
      const reasonText = String(reason || '').trim();
      const reasons = reasonText && !current.reasons.includes(reasonText)
        ? [...current.reasons, reasonText].slice(0, 5)
        : current.reasons;
      suggestedTestsAgg.set(fp, { score: current.score + safeScore, reasons });
    };

    const symbols: any[] = [];
    for (const sym of changedSymbols) {
      const escaped = String(sym.uid || '').replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(t {id: '${escaped}'})
          WHERE r.confidence >= ${minConfidence}
          RETURN caller.id AS uid, caller.name AS name, labels(caller) AS kind, caller.filePath AS filePath, caller.startLine AS startLine,
                 r.confidence AS confidence, r.reason AS reason
          ORDER BY r.confidence DESC
          LIMIT ${callerFetchLimit}
        `);
      } catch {
        rows = [];
      }

      const callersRaw = rows.map((row: any) => ({
        uid: row.uid || row[0],
        name: row.name || row[1],
        kind: row.kind || row[2],
        filePath: row.filePath || row[3],
        startLine: row.startLine ?? row[4],
        edge: {
          confidence: Number(row.confidence ?? row[5] ?? 1.0),
          reason: String(row.reason ?? row[6] ?? ''),
        },
      }));

      const callers = pathPrefixes.length > 0
        ? callersRaw.filter((c: any) => isInScope(String(c?.filePath || '')))
        : callersRaw;

      const testCallers = callers
        .filter((c: any) => isTestFilePath(String(c?.filePath || '')))
        .slice(0, limitTests);

      for (const t of testCallers) {
        const fp = String(t?.filePath || '').trim();
        if (!fp) continue;
        const confidence = Number(t?.edge?.confidence ?? 1.0);
        const reason = sym?.name ? `${sym.name} direct caller` : 'direct caller of changed symbol';
        addSuggestedTest(fp, 3 + Math.max(0, confidence), reason);
      }

      symbols.push({
        symbol: sym,
        callers: callers.slice(0, limitCallers),
        test_callers: testCallers,
      });
    }

    // Fallback tier 1: include lower-confidence test callers if no direct high-confidence hits were found.
    if (suggestedTestsAgg.size === 0 && changedSymbolIds.length > 0) {
      try {
        const changedSymbolIdsCypher = `[${changedSymbolIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;
        const fallbackRows = await executeQuery(repo.id, `
          MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(t)
          WHERE t.id IN ${changedSymbolIdsCypher}
          RETURN caller.filePath AS callerFilePath, t.name AS targetName, r.confidence AS confidence, r.reason AS reason
          ORDER BY r.confidence DESC
          LIMIT ${Math.max(limitTests * 30, 120)}
        `);
        for (const row of fallbackRows) {
          const callerFilePath = String(row.callerFilePath || row[0] || '').trim();
          if (!callerFilePath) continue;
          if (pathPrefixes.length > 0 && !isInScope(callerFilePath)) continue;
          if (!isTestFilePath(callerFilePath)) continue;
          const targetName = String(row.targetName || row[1] || '').trim();
          const confidence = Number(row.confidence ?? row[2] ?? 0);
          const reason = targetName
            ? `${targetName} low-confidence caller (confidence ${confidence.toFixed(2)})`
            : `low-confidence caller (confidence ${confidence.toFixed(2)})`;
          addSuggestedTest(callerFilePath, 1 + Math.max(0, confidence), reason);
        }
      } catch {
        // best-effort fallback
      }
    }

    // Fallback tier 2: suggest tests that import changed files, even when no CALLS edge exists.
    if (suggestedTestsAgg.size === 0 && changedFilePathSet.size > 0) {
      try {
        const changedFilesCypher = `[${Array.from(changedFilePathSet).map(filePath => `'${filePath.replace(/'/g, "''")}'`).join(', ')}]`;
        const importRows = await executeQuery(repo.id, `
          MATCH (caller)-[r:CodeRelation {type: 'IMPORTS'}]->(target)
          WHERE target.filePath IN ${changedFilesCypher}
          RETURN caller.filePath AS callerFilePath, target.filePath AS targetFilePath, r.confidence AS confidence
          ORDER BY r.confidence DESC
          LIMIT ${Math.max(limitTests * 40, 200)}
        `);
        for (const row of importRows) {
          const callerFilePath = String(row.callerFilePath || row[0] || '').trim();
          if (!callerFilePath) continue;
          if (pathPrefixes.length > 0 && !isInScope(callerFilePath)) continue;
          if (!isTestFilePath(callerFilePath)) continue;
          const targetFilePath = normalizePath(String(row.targetFilePath || row[1] || ''));
          const confidence = Number(row.confidence ?? row[2] ?? 0);
          const reason = targetFilePath
            ? `imports changed file ${targetFilePath}`
            : 'imports changed file';
          addSuggestedTest(callerFilePath, 0.8 + Math.max(0, confidence), reason);
        }
      } catch {
        // best-effort fallback
      }
    }

    // Fallback tier 3: lexical proximity from tracked tests as a last resort.
    if (suggestedTestsAgg.size === 0 && changedFilePathSet.size > 0) {
      const stopTokens = new Set([
        'apps', 'app', 'src', 'lib', 'utils', 'shared', 'common', 'components',
        'services', 'service', 'controllers', 'controller', 'index', 'test', 'tests',
        'spec', 'feature', 'unit', 'backend', 'dashboard',
      ]);
      const tokenize = (value: string): string[] => {
        return String(value || '')
          .toLowerCase()
          .split(/[^a-z0-9]+/g)
          .map(token => token.trim())
          .filter(token => token.length >= 3 && !stopTokens.has(token));
      };

      const changedTokens = new Set<string>();
      for (const fp of changedFilePathSet) {
        for (const token of tokenize(fp)) changedTokens.add(token);
        const base = path.basename(fp, path.extname(fp));
        for (const token of tokenize(base)) changedTokens.add(token);
      }
      for (const sym of changedSymbols) {
        for (const token of tokenize(String(sym?.name || ''))) changedTokens.add(token);
      }

      if (changedTokens.size > 0) {
        try {
          const output = execFileSync('git', ['ls-files'], {
            cwd: repo.repoPath,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024 * 10,
          });
          const candidates = String(output || '')
            .trim()
            .split('\n')
            .map(line => normalizePath(line))
            .filter(Boolean)
            .filter(filePath => isTestFilePath(filePath))
            .filter(filePath => pathPrefixes.length === 0 || isInScope(filePath));

          const ranked = candidates
            .map(filePath => {
              const overlap = Array.from(new Set(tokenize(filePath).filter(token => changedTokens.has(token))));
              if (overlap.length === 0) return null;
              return {
                filePath,
                score: 0.3 * overlap.length,
                reason: `filename/token proximity: ${overlap.slice(0, 4).join(', ')}`,
              };
            })
            .filter((item): item is { filePath: string; score: number; reason: string } => item !== null)
            .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
            .slice(0, limitTests);

          for (const hit of ranked) {
            addSuggestedTest(hit.filePath, hit.score, hit.reason);
          }
        } catch {
          // best-effort fallback
        }
      }
    }

    const suggested_tests = Array.from(suggestedTestsAgg.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limitTests)
      .map(([filePath, meta]) => ({
        filePath,
        score: Number(meta.score.toFixed(3)),
        reasons: meta.reasons,
      }));

    const slice_stencil = buildEmptySliceStencil();
    if (includeSliceStencil && changedSymbolIds.length > 0) {
      try {
        const changedSymbolIdsCypher = `[${changedSymbolIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;

        const sliceRows = await executeQuery(repo.id, `
          MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
          WHERE n.id IN ${changedSymbolIdsCypher}
            AND r.reason STARTS WITH 'feature-slice:'
          RETURN
            s.id AS sliceId,
            s.label AS sliceLabel,
            s.heuristicLabel AS heuristicLabel,
            s.sliceType AS sliceType,
            s.anchorId AS anchorId,
            s.anchorName AS anchorName,
            s.closureScore AS closureScore,
            s.closureSlots AS closureSlots,
            s.closedSlots AS closedSlots,
            n.id AS memberId,
            n.name AS memberName,
            labels(n) AS memberKind,
            n.filePath AS memberFilePath,
            n.startLine AS memberStartLine,
            n.endLine AS memberEndLine,
            r.reason AS memberRoleReason
          LIMIT 4000
        `);

        const parseSliceRole = (reason: string): string => {
          const raw = String(reason || '').trim();
          if (!raw) return '';
          if (!raw.startsWith('feature-slice:')) return raw;
          return raw.slice('feature-slice:'.length).trim();
        };

        const toPrimaryLabel = (value: any): string => {
          if (Array.isArray(value)) return String(value[0] || '').trim();
          return String(value || '').trim();
        };

        const changedSliceMap = new Map<string, {
          id: string;
          label: string;
          heuristicLabel: string;
          sliceType: string;
          anchorId: string;
          anchorName: string;
          closureScore: number;
          closureSlots: string[];
          closedSlots: string[];
          roles: Set<string>;
          changedMembers: Array<{
            uid: string;
            name: string;
            kind: string;
            filePath: string;
            role: string;
            startLine?: number;
            endLine?: number;
          }>;
          gapSignals: {
            total: number;
            deterministic: number;
            pattern: number;
            heuristic: number;
            high: number;
            medium: number;
            low: number;
          };
          template: null | {
            id: string;
            template_key: string;
            slice_type: string;
            required_slots: string[];
            optional_slots: string[];
            role_expectations: Array<{ role: string; coverage: number; count: number }>;
            avg_closure_score: number;
            slice_count: number;
            exemplar_slice_ids: string[];
          };
          stencilDelta: {
            missing_required_slots: string[];
            missing_roles: string[];
            closure_score_delta: number;
          };
          siblingPrecedents: Array<{
            id: string;
            label: string;
            anchor_name: string;
            closure_score: number;
            shared_closed_slots: string[];
            shared_roles: string[];
          }>;
        }>();

        for (const row of sliceRows) {
          const sliceId = String(row.sliceId ?? row[0] ?? '').trim();
          if (!sliceId) continue;

          let entry = changedSliceMap.get(sliceId);
          if (!entry) {
            entry = {
              id: sliceId,
              label: String(row.sliceLabel ?? row[1] ?? '').trim(),
              heuristicLabel: String(row.heuristicLabel ?? row[2] ?? '').trim(),
              sliceType: String(row.sliceType ?? row[3] ?? '').trim(),
              anchorId: String(row.anchorId ?? row[4] ?? '').trim(),
              anchorName: String(row.anchorName ?? row[5] ?? '').trim(),
              closureScore: Number(row.closureScore ?? row[6] ?? 0) || 0,
              closureSlots: Array.isArray(row.closureSlots) ? row.closureSlots.map((item: any) => String(item || '')).filter(Boolean) : [],
              closedSlots: Array.isArray(row.closedSlots) ? row.closedSlots.map((item: any) => String(item || '')).filter(Boolean) : [],
              roles: new Set<string>(),
              changedMembers: [],
              gapSignals: {
                total: 0,
                deterministic: 0,
                pattern: 0,
                heuristic: 0,
                high: 0,
                medium: 0,
                low: 0,
              },
              template: null,
              stencilDelta: {
                missing_required_slots: [],
                missing_roles: [],
                closure_score_delta: 0,
              },
              siblingPrecedents: [],
            };
            changedSliceMap.set(sliceId, entry);
          }

          const role = parseSliceRole(String(row.memberRoleReason ?? row[15] ?? '').trim());
          if (role) entry.roles.add(role);
          const memberId = String(row.memberId ?? row[9] ?? '').trim();
          if (!memberId) continue;
          const startLine = Number(row.memberStartLine ?? row[13]);
          const endLine = Number(row.memberEndLine ?? row[14]);

          entry.changedMembers.push({
            uid: memberId,
            name: String(row.memberName ?? row[10] ?? '').trim(),
            kind: toPrimaryLabel(row.memberKind ?? row[11]),
            filePath: String(row.memberFilePath ?? row[12] ?? '').trim(),
            role,
            ...(Number.isFinite(startLine) ? { startLine } : {}),
            ...(Number.isFinite(endLine) ? { endLine } : {}),
          });
        }

        const changedSliceIds = Array.from(changedSliceMap.keys()).slice(0, limitSliceStencil);
        if (changedSliceIds.length > 0) {
          const changedSliceIdsCypher = `[${changedSliceIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;

          const sliceRoleRows = await executeQuery(repo.id, `
            MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
            WHERE s.id IN ${changedSliceIdsCypher}
              AND r.reason STARTS WITH 'feature-slice:'
            RETURN s.id AS sliceId, n.id AS memberId, r.reason AS memberRoleReason
            LIMIT 5000
          `);

          const memberIdSets = new Map<string, Set<string>>();
          for (const row of sliceRoleRows) {
            const sliceId = String(row.sliceId ?? row[0] ?? '').trim();
            if (!sliceId) continue;
            const memberId = String(row.memberId ?? row[1] ?? '').trim();
            const role = parseSliceRole(String(row.memberRoleReason ?? row[2] ?? '').trim());
            const entry = changedSliceMap.get(sliceId);
            if (!entry) continue;
            if (role) entry.roles.add(role);
            if (!memberId) continue;
            const memberSet = memberIdSets.get(sliceId) || new Set<string>();
            memberSet.add(memberId);
            memberIdSets.set(sliceId, memberSet);
          }

          const gapRows = await executeQuery(repo.id, `
            MATCH (g:Gap)-[:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
            WHERE s.id IN ${changedSliceIdsCypher}
            RETURN s.id AS sliceId, g.absenceTier AS absenceTier, g.severity AS severity
            LIMIT 2000
          `);

          for (const row of gapRows) {
            const sliceId = String(row.sliceId ?? row[0] ?? '').trim();
            const absenceTier = String(row.absenceTier ?? row[1] ?? '').trim();
            const severity = String(row.severity ?? row[2] ?? '').trim();
            const entry = changedSliceMap.get(sliceId);
            if (!entry) continue;

            entry.gapSignals.total += 1;
            if (absenceTier === 'deterministic_missing') entry.gapSignals.deterministic += 1;
            else if (absenceTier === 'pattern_missing') entry.gapSignals.pattern += 1;
            else if (absenceTier === 'heuristic_suspicion') entry.gapSignals.heuristic += 1;

            if (severity === 'high') entry.gapSignals.high += 1;
            else if (severity === 'medium') entry.gapSignals.medium += 1;
            else if (severity === 'low') entry.gapSignals.low += 1;
          }

          const closureSnapshot = await loadClosureTemplateSnapshot(repo.storagePath);
          const templatesBySliceType = new Map<string, Array<typeof closureSnapshot.templates[number]>>();
          for (const template of Array.isArray(closureSnapshot.templates) ? closureSnapshot.templates : []) {
            const key = String(template?.sliceType || '').trim();
            if (!key) continue;
            const list = templatesBySliceType.get(key) || [];
            list.push(template);
            templatesBySliceType.set(key, list);
          }

          const candidateSiblingIds = new Set<string>();
          for (const sliceId of changedSliceIds) {
            const entry = changedSliceMap.get(sliceId);
            if (!entry) continue;

            const templates = templatesBySliceType.get(entry.sliceType) || [];
            const closedSlotSet = new Set(entry.closedSlots);
            const roleSet = new Set(Array.from(entry.roles));

            let bestTemplate: any = null;
            let bestScore = -1;
            for (const template of templates) {
              const requiredSlots = Array.isArray(template.requiredSlots) ? template.requiredSlots.map((value: any) => String(value || '').trim()).filter(Boolean) : [];
              const roleExpectations = Array.isArray(template.roleCoverage) ? template.roleCoverage : [];
              const templateRoles = roleExpectations.map((role: any) => String(role?.role || '').trim()).filter(Boolean);
              const requiredHits = requiredSlots.filter(slot => closedSlotSet.has(slot)).length;
              const roleHits = templateRoles.filter(role => roleSet.has(role)).length;

              const requiredScore = requiredSlots.length > 0 ? (requiredHits / requiredSlots.length) : 1;
              const roleScore = templateRoles.length > 0 ? (roleHits / templateRoles.length) : 1;
              const score = (requiredScore * 0.7) + (roleScore * 0.3) + ((Number(template.sliceCount || 0) || 0) * 0.0001);
              if (score > bestScore) {
                bestScore = score;
                bestTemplate = template;
              }
            }

            if (!bestTemplate) continue;

            const requiredSlots = Array.isArray(bestTemplate.requiredSlots)
              ? bestTemplate.requiredSlots.map((value: any) => String(value || '').trim()).filter(Boolean)
              : [];
            const optionalSlots = Array.isArray(bestTemplate.optionalSlots)
              ? bestTemplate.optionalSlots.map((value: any) => String(value || '').trim()).filter(Boolean)
              : [];
            const roleExpectations = Array.isArray(bestTemplate.roleCoverage)
              ? bestTemplate.roleCoverage
                .map((item: any) => ({
                  role: String(item?.role || '').trim(),
                  coverage: Number(item?.coverage || 0) || 0,
                  count: Number(item?.count || 0) || 0,
                }))
                .filter((item: any) => item.role)
              : [];
            const expectedRoles = roleExpectations
              .filter((item: any) => item.coverage >= 0.5)
              .map((item: any) => item.role);
            const exemplarSliceIds = Array.isArray(bestTemplate.exemplarSliceIds)
              ? bestTemplate.exemplarSliceIds.map((value: any) => String(value || '').trim()).filter(Boolean)
              : [];

            entry.template = {
              id: String(bestTemplate.id || '').trim(),
              template_key: String(bestTemplate.templateKey || '').trim(),
              slice_type: String(bestTemplate.sliceType || '').trim(),
              required_slots: requiredSlots,
              optional_slots: optionalSlots,
              role_expectations: roleExpectations,
              avg_closure_score: Number(bestTemplate.avgClosureScore || 0) || 0,
              slice_count: Number(bestTemplate.sliceCount || 0) || 0,
              exemplar_slice_ids: exemplarSliceIds,
            };

            entry.stencilDelta = {
              missing_required_slots: requiredSlots.filter(slot => !closedSlotSet.has(slot)),
              missing_roles: expectedRoles.filter(role => !roleSet.has(role)),
              closure_score_delta: Number(((Number(bestTemplate.avgClosureScore || 0) || 0) - entry.closureScore).toFixed(3)),
            };

            for (const siblingId of exemplarSliceIds) {
              if (!siblingId || siblingId === entry.id) continue;
              candidateSiblingIds.add(siblingId);
            }
          }

          const siblingList = Array.from(candidateSiblingIds);
          const siblingDetailsById = new Map<string, {
            id: string;
            label: string;
            heuristicLabel: string;
            anchorName: string;
            closureScore: number;
            closedSlots: string[];
            roles: Set<string>;
          }>();

          if (siblingList.length > 0) {
            const siblingIdsCypher = `[${siblingList.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;

            const siblingRows = await executeQuery(repo.id, `
              MATCH (s:FeatureSlice)
              WHERE s.id IN ${siblingIdsCypher}
              RETURN s.id AS id, s.label AS label, s.heuristicLabel AS heuristicLabel, s.anchorName AS anchorName, s.closureScore AS closureScore, s.closedSlots AS closedSlots
              LIMIT 1000
            `);

            for (const row of siblingRows) {
              const siblingId = String(row.id ?? row[0] ?? '').trim();
              if (!siblingId) continue;
              siblingDetailsById.set(siblingId, {
                id: siblingId,
                label: String(row.label ?? row[1] ?? '').trim(),
                heuristicLabel: String(row.heuristicLabel ?? row[2] ?? '').trim(),
                anchorName: String(row.anchorName ?? row[3] ?? '').trim(),
                closureScore: Number(row.closureScore ?? row[4] ?? 0) || 0,
                closedSlots: Array.isArray(row.closedSlots) ? row.closedSlots.map((item: any) => String(item || '')).filter(Boolean) : [],
                roles: new Set<string>(),
              });
            }

            const siblingRoleRows = await executeQuery(repo.id, `
              MATCH (n)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
              WHERE s.id IN ${siblingIdsCypher}
                AND r.reason STARTS WITH 'feature-slice:'
              RETURN s.id AS sliceId, r.reason AS memberRoleReason
              LIMIT 4000
            `);

            for (const row of siblingRoleRows) {
              const siblingId = String(row.sliceId ?? row[0] ?? '').trim();
              const role = parseSliceRole(String(row.memberRoleReason ?? row[1] ?? '').trim());
              const sibling = siblingDetailsById.get(siblingId);
              if (!sibling || !role) continue;
              sibling.roles.add(role);
            }
          }

          const rankedSlices = changedSliceIds
            .map(sliceId => changedSliceMap.get(sliceId))
            .filter((entry): entry is NonNullable<typeof entry> => !!entry)
            .sort((left, right) => {
              if (right.gapSignals.high !== left.gapSignals.high) return right.gapSignals.high - left.gapSignals.high;
              if (right.stencilDelta.missing_required_slots.length !== left.stencilDelta.missing_required_slots.length) {
                return right.stencilDelta.missing_required_slots.length - left.stencilDelta.missing_required_slots.length;
              }
              return left.id.localeCompare(right.id);
            })
            .slice(0, limitSliceStencil);

          for (const entry of rankedSlices) {
            const closedSlotSet = new Set(entry.closedSlots);
            const roleSet = new Set(Array.from(entry.roles));
            const siblingCandidates = entry.template
              ? entry.template.exemplar_slice_ids
              : [];

            const sibling_precedents = siblingCandidates
              .map((siblingId: string) => siblingDetailsById.get(String(siblingId || '').trim()))
              .filter((item): item is NonNullable<typeof item> => !!item)
              .map(sibling => {
                const sharedClosedSlots = sibling.closedSlots.filter(slot => closedSlotSet.has(slot));
                const siblingRoles = Array.from(sibling.roles);
                const sharedRoles = siblingRoles.filter(role => roleSet.has(role));
                return {
                  id: sibling.id,
                  label: sibling.label || sibling.heuristicLabel || sibling.id,
                  anchor_name: sibling.anchorName,
                  closure_score: Number(sibling.closureScore.toFixed(3)),
                  shared_closed_slots: sharedClosedSlots.slice(0, 8),
                  shared_roles: sharedRoles.slice(0, 8),
                  __rank: sharedClosedSlots.length + sharedRoles.length + sibling.closureScore,
                };
              })
              .sort((left, right) => right.__rank - left.__rank)
              .slice(0, 3)
              .map(({ __rank, ...rest }) => rest);

            entry.siblingPrecedents = sibling_precedents;

            slice_stencil.slices.push({
              slice: {
                id: entry.id,
                label: entry.label || entry.heuristicLabel || entry.id,
                heuristicLabel: entry.heuristicLabel,
                sliceType: entry.sliceType,
                anchorId: entry.anchorId,
                anchorName: entry.anchorName,
                closureScore: Number(entry.closureScore.toFixed(3)),
                closureSlots: entry.closureSlots,
                closedSlots: entry.closedSlots,
                roles: Array.from(entry.roles).sort(),
                changed_member_count: (memberIdSets.get(entry.id)?.size || entry.changedMembers.length),
              },
              changed_members: entry.changedMembers.slice(0, 12),
              template: entry.template,
              stencil_delta: entry.stencilDelta,
              sibling_precedents,
              gap_signals: entry.gapSignals,
            });
          }

          slice_stencil.updated_at = String(closureSnapshot.generatedAt || '');
          slice_stencil.summary = {
            changed_slices: slice_stencil.slices.length,
            with_templates: slice_stencil.slices.filter(item => !!item.template).length,
            missing_required_slot_slices: slice_stencil.slices.filter(item => item.stencil_delta.missing_required_slots.length > 0).length,
            missing_role_slices: slice_stencil.slices.filter(item => item.stencil_delta.missing_roles.length > 0).length,
            sibling_candidates: slice_stencil.slices.reduce((sum, item) => sum + item.sibling_precedents.length, 0),
          };
        }
      } catch {
        // best-effort slice stencil enrichment
      }
    }

    const semanticFamilyOrder: SemanticFamily[] = ['auth', 'shape', 'cache', 'test', 'event', 'template'];
    const semantic_diffs = buildEmptySemanticDiffs();
    let proof_pack = buildEmptyProofPack();

    if (changedSymbolIds.length > 0) {
      const pickPrimaryLabel = (value: any): string => {
        if (Array.isArray(value)) return String(value[0] || '').trim();
        return String(value || '').trim();
      };

      const classifySemanticFamily = (edge: {
        type: string;
        reason: string;
        sourceName: string;
        targetName: string;
        sourceFilePath: string;
        targetFilePath: string;
      }): SemanticFamily | null => {
        const type = String(edge.type || '').trim().toUpperCase();
        const reason = String(edge.reason || '').trim().toLowerCase();
        const sourceName = String(edge.sourceName || '').trim().toLowerCase();
        const targetName = String(edge.targetName || '').trim().toLowerCase();
        const sourceFilePath = String(edge.sourceFilePath || '').trim();
        const targetFilePath = String(edge.targetFilePath || '').trim();

        if (type === 'TESTS_SHAPE') return 'test';
        if (type === 'VALIDATES_FIELD' || type === 'SERIALIZES_FIELD' || type === 'READS_FIELD' || type === 'WRITES_FIELD' || type === 'DERIVES_FROM_COLUMN') return 'shape';
        if (type === 'INVALIDATES_KEY' || reason.startsWith('react-query-key:') || reason.startsWith('micro-dataflow:query-invalidation')) return 'cache';

        const hasPermissionSignal = (
          sourceName.startsWith('permission:')
          || targetName.startsWith('permission:')
          || reason.includes('permission')
          || reason.startsWith('laravel-authorize:')
          || reason.startsWith('laravel-gate:')
          || reason.startsWith('laravel-can:')
          || reason.startsWith('laravel-route-middleware:can:')
        );
        if (hasPermissionSignal) return 'auth';

        if (
          reason.startsWith('laravel-event')
          || reason.startsWith('laravel-job-dispatch')
          || reason.startsWith('laravel-notify')
          || reason.startsWith('laravel-tactician-dispatch')
          || reason.startsWith('laravel-tactician-pipeline')
          || reason.startsWith('micro-dataflow:event-chain')
        ) {
          return 'event';
        }

        if (
          reason.startsWith('blade-')
          || reason.startsWith('mjml-')
          || reason.startsWith('laravel-view-mail')
          || reason.startsWith('template-method-call')
        ) {
          return 'template';
        }

        if (isTestFilePath(sourceFilePath) || isTestFilePath(targetFilePath)) return 'test';
        return null;
      };

      try {
        const semanticIdsCypher = `[${changedSymbolIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')}]`;

        const semanticRows = await executeQuery(repo.id, `
          MATCH (a)-[r:CodeRelation]->(b)
          WHERE r.confidence >= ${minConfidence}
            AND (a.id IN ${semanticIdsCypher} OR b.id IN ${semanticIdsCypher})
          RETURN
            a.id AS sourceId,
            a.name AS sourceName,
            labels(a) AS sourceKind,
            a.filePath AS sourceFilePath,
            b.id AS targetId,
            b.name AS targetName,
            labels(b) AS targetKind,
            b.filePath AS targetFilePath,
            r.type AS relType,
            r.reason AS reason,
            r.confidence AS confidence,
            r.id AS edgeId,
            r.witnessPathIds AS witnessPathIds
          LIMIT 3000
        `);

        const familyStats = new Map<SemanticFamily, {
        family: SemanticFamily;
        edge_count: number;
        incoming_edges: number;
        outgoing_edges: number;
        changed_symbol_ids: Set<string>;
        reasonCounts: Map<string, number>;
        sample_edges: Array<{
          source: { uid: string; name: string; kind: string; filePath: string };
          target: { uid: string; name: string; kind: string; filePath: string };
          edge: { id: string; type: string; reason: string; confidence: number; witnessPathIds: string[] };
          direction: 'incoming' | 'outgoing' | 'internal';
        }>;
      }>();

        for (const raw of semanticRows) {
        const sourceId = String(raw.sourceId ?? raw[0] ?? '').trim();
        const targetId = String(raw.targetId ?? raw[4] ?? '').trim();
        if (!sourceId || !targetId) continue;

        const relType = String(raw.relType ?? raw[8] ?? '').trim();
        const reason = String(raw.reason ?? raw[9] ?? '').trim();
        const sourceName = String(raw.sourceName ?? raw[1] ?? '').trim();
        const targetName = String(raw.targetName ?? raw[5] ?? '').trim();
        const sourceFilePath = String(raw.sourceFilePath ?? raw[3] ?? '').trim();
        const targetFilePath = String(raw.targetFilePath ?? raw[7] ?? '').trim();
        const confidence = Number(raw.confidence ?? raw[10] ?? 1);
        const edgeId = String(raw.edgeId ?? raw[11] ?? '').trim();
        const witnessPathIds = parseWitnessPathIds(raw.witnessPathIds ?? raw[12]);

        const family = classifySemanticFamily({
          type: relType,
          reason,
          sourceName,
          targetName,
          sourceFilePath,
          targetFilePath,
        });
        if (!family) continue;

        const sourceChanged = changedSymbolIdSet.has(sourceId);
        const targetChanged = changedSymbolIdSet.has(targetId);
        const direction: 'incoming' | 'outgoing' | 'internal' = sourceChanged && targetChanged
          ? 'internal'
          : sourceChanged
            ? 'outgoing'
            : 'incoming';

        const entry = familyStats.get(family) || {
          family,
          edge_count: 0,
          incoming_edges: 0,
          outgoing_edges: 0,
          changed_symbol_ids: new Set<string>(),
          reasonCounts: new Map<string, number>(),
          sample_edges: [],
        };

        entry.edge_count++;
        if (sourceChanged) {
          entry.outgoing_edges++;
          entry.changed_symbol_ids.add(sourceId);
        }
        if (targetChanged) {
          entry.incoming_edges++;
          entry.changed_symbol_ids.add(targetId);
        }

        const reasonKey = reason || relType || 'unknown';
        entry.reasonCounts.set(reasonKey, (entry.reasonCounts.get(reasonKey) || 0) + 1);

        if (entry.sample_edges.length < 5) {
          entry.sample_edges.push({
            source: {
              uid: sourceId,
              name: sourceName,
              kind: pickPrimaryLabel(raw.sourceKind ?? raw[2]),
              filePath: sourceFilePath,
            },
            target: {
              uid: targetId,
              name: targetName,
              kind: pickPrimaryLabel(raw.targetKind ?? raw[6]),
              filePath: targetFilePath,
            },
            edge: {
              id: edgeId,
              type: relType,
              reason,
              confidence: Number.isFinite(confidence) ? confidence : 1,
              witnessPathIds,
            },
            direction,
          });
        }

          familyStats.set(family, entry);
        }

        const families = semanticFamilyOrder
          .map(family => familyStats.get(family))
          .filter((item): item is NonNullable<typeof item> => !!item)
          .map(item => ({
          family: item.family,
          edge_count: item.edge_count,
          changed_symbols: item.changed_symbol_ids.size,
          incoming_edges: item.incoming_edges,
          outgoing_edges: item.outgoing_edges,
          reasons: Array.from(item.reasonCounts.entries())
            .sort((left, right) => right[1] - left[1])
            .slice(0, 5)
            .map(([reasonValue, count]) => ({ reason: reasonValue, count })),
          sample_edges: item.sample_edges,
          }));

        const gapRows = await executeQuery(repo.id, `
          MATCH (s)-[r:CodeRelation {type: 'MEMBER_OF'}]->(slice:FeatureSlice)
          WHERE s.id IN ${semanticIdsCypher}
            AND r.reason STARTS WITH 'feature-slice:'
          MATCH (g:Gap)-[:CodeRelation {type: 'MEMBER_OF'}]->(slice)
          RETURN DISTINCT
            g.id AS id,
            g.gapType AS gapType,
            g.absenceTier AS absenceTier,
            g.severity AS severity,
            g.sliceId AS sliceId,
            g.anchorId AS anchorId,
            g.missingSlots AS missingSlots,
            g.evidence AS evidence
          LIMIT 100
        `);

        const gaps = gapRows.map((row: any) => ({
          id: String(row.id ?? row[0] ?? '').trim(),
          gapType: String(row.gapType ?? row[1] ?? '').trim(),
          absenceTier: String(row.absenceTier ?? row[2] ?? '').trim(),
          severity: String(row.severity ?? row[3] ?? '').trim(),
          sliceId: String(row.sliceId ?? row[4] ?? '').trim(),
          anchorId: String(row.anchorId ?? row[5] ?? '').trim(),
          missingSlots: Array.isArray(row.missingSlots) ? row.missingSlots.map((item: any) => String(item || '')).filter(Boolean) : [],
          evidence: Array.isArray(row.evidence) ? row.evidence.map((item: any) => String(item || '')).filter(Boolean) : [],
        })).filter(gap => gap.id && gap.gapType);

        semantic_diffs.summary.touched_edges = families.reduce((sum, family) => sum + family.edge_count, 0);
        semantic_diffs.summary.family_count = families.length;
        semantic_diffs.summary.gap_signals = gaps.length;
        semantic_diffs.families = families;
        semantic_diffs.gap_signals = {
          total: gaps.length,
          deterministic: gaps.filter(gap => gap.absenceTier === 'deterministic_missing').length,
          pattern: gaps.filter(gap => gap.absenceTier === 'pattern_missing').length,
          heuristic: gaps.filter(gap => gap.absenceTier === 'heuristic_suspicion').length,
          high: gaps.filter(gap => gap.severity === 'high').length,
          medium: gaps.filter(gap => gap.severity === 'medium').length,
          low: gaps.filter(gap => gap.severity === 'low').length,
          gaps: gaps.slice(0, 20),
        };
      } catch {
        // best-effort enrichment
      }
    }

    if (includeEvidenceSpans) {
      try {
        const snapshot = await loadEvidenceSpanSnapshot(repo.storagePath);
        const nodeEvidenceById = new Map(
          (Array.isArray(snapshot.nodes) ? snapshot.nodes : [])
            .map(node => [String(node?.nodeId || '').trim(), node] as const)
            .filter(([id]) => id),
        );
        const edgeEvidenceById = new Map(
          (Array.isArray(snapshot.edges) ? snapshot.edges : [])
            .map(edge => [String(edge?.edgeId || '').trim(), edge] as const)
            .filter(([id]) => id),
        );

        const symbols = changedSymbols
          .map(sym => {
            const uid = String(sym?.uid || '').trim();
            if (!uid) return null;
            const evidence = nodeEvidenceById.get(uid);
            if (!evidence) return null;
            return {
              symbol: {
                uid,
                name: String(sym?.name || ''),
                kind: String(sym?.kind || ''),
                filePath: String(sym?.filePath || ''),
                ...(Number.isFinite(sym?.startLine) ? { startLine: Number(sym.startLine) } : {}),
                ...(Number.isFinite(sym?.endLine) ? { endLine: Number(sym.endLine) } : {}),
              },
              primary_span: evidence.primarySpan || null,
              witness_spans: Array.isArray(evidence.witnessSpans) ? evidence.witnessSpans : [],
              proof_spans: Array.isArray(evidence.proofSpans) ? evidence.proofSpans : [],
            };
          })
          .filter((item): item is NonNullable<typeof item> => !!item)
          .slice(0, limitEvidence);

        const semanticEdgeRefs = semantic_diffs.families.flatMap(family => (
          family.sample_edges.map(sample => ({
            family: family.family,
            source: sample.source,
            target: sample.target,
            edge: sample.edge,
          }))
        ));

        const seenEdgeIds = new Set<string>();
        const edges: typeof proof_pack.edges = [];
        for (const ref of semanticEdgeRefs) {
          const edgeId = String(ref?.edge?.id || '').trim();
          if (!edgeId || seenEdgeIds.has(edgeId)) continue;
          seenEdgeIds.add(edgeId);
          const evidence = edgeEvidenceById.get(edgeId);
          if (!evidence) continue;

          edges.push({
            family: ref.family,
            source: ref.source,
            target: ref.target,
            edge: {
              id: edgeId,
              type: String(ref.edge?.type || ''),
              reason: String(ref.edge?.reason || ''),
              confidence: Number(ref.edge?.confidence ?? 1) || 1,
              witness_path_ids: Array.isArray(ref.edge?.witnessPathIds) ? ref.edge.witnessPathIds : [],
            },
            witness_spans: Array.isArray(evidence.witnessSpans) ? evidence.witnessSpans : [],
            proof_spans: Array.isArray(evidence.proofSpans) ? evidence.proofSpans : [],
          });

          if (edges.length >= limitEvidence) break;
        }

        const witnessSpans = symbols.reduce((sum, item) => sum + item.witness_spans.length, 0)
          + edges.reduce((sum, item) => sum + item.witness_spans.length, 0);
        const proofSpans = symbols.reduce((sum, item) => sum + item.proof_spans.length, 0)
          + edges.reduce((sum, item) => sum + item.proof_spans.length, 0);

        proof_pack = {
          updated_at: String(snapshot.generatedAt || ''),
          summary: {
            symbol_spans: symbols.length,
            edge_spans: edges.length,
            witness_spans: witnessSpans,
            proof_spans: proofSpans,
          },
          symbols,
          edges,
        };
      } catch {
        proof_pack = buildEmptyProofPack();
      }
    }

    const ui_contracts: any[] = [];
    if (includeUiContracts && maxUiContractFiles > 0) {
      const baseRefForUi = scope === 'compare' ? baseRef : 'HEAD';

      const isUiFile = (p: string): boolean => {
        const lower = p.toLowerCase();
        return lower.endsWith('.tsx') || lower.endsWith('.jsx') || lower.endsWith('.ts') || lower.endsWith('.js');
      };

      const rankUiFile = (p: string): number => {
        const lower = p.toLowerCase();
        if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 2;
        if (lower.endsWith('.ts') || lower.endsWith('.js')) return 1;
        return 0;
      };

      const uiFiles = changedFileObjs
        .map(f => normalizePath(f.filePath))
        .filter(Boolean)
        .filter(fp => isInScope(fp))
        .filter(fp => isUiFile(fp))
        .sort((a, b) => rankUiFile(b) - rankUiFile(a))
        .slice(0, maxUiContractFiles);

      for (const filePath of uiFiles) {
        const res = await this.uiContract(repo, {
          file_path: filePath,
          base_ref: baseRefForUi,
          include_endpoints: true,
          min_http_confidence: minConfidence,
        });

        if (res?.error) {
          ui_contracts.push({ filePath, error: res.error });
          continue;
        }

        ui_contracts.push({
          filePath: res.file_path || filePath,
          diff: res.diff || null,
          smells: Array.isArray(res?.contract?.smells) ? res.contract.smells : [],
          effects_summary: res?.contract?.effectsSummary || null,
          endpoints: Array.isArray(res?.endpoints) ? res.endpoints : [],
        });
      }
    }

    const ROUTE_FILE_PATH_RE = /(^|\/)routes\/[^/]+\.php$/i;
    const route_targets: any[] = [];
    for (const file of changedFileObjs) {
      const filePath = normalizePath(file.filePath);
      if (!filePath) continue;
      if (!isInScope(filePath)) continue;
      if (file.status === 'Deleted') continue;
      if (!ROUTE_FILE_PATH_RE.test(filePath)) continue;

      const escaped = filePath.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (f:File {filePath: '${escaped}'})-[r:CodeRelation {type: 'CALLS'}]->(m:Method)
          WHERE r.reason STARTS WITH 'laravel-route' AND r.confidence >= ${minConfidence}
          OPTIONAL MATCH (m)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Class)
          RETURN m.id AS uid, m.name AS name, m.filePath AS filePath, m.startLine AS startLine,
                 c.name AS className,
                 r.confidence AS confidence, r.reason AS reason
          ORDER BY r.confidence DESC
          LIMIT 100
        `);
      } catch {
        rows = [];
      }

      const targets = rows.map((row: any) => ({
        controller: {
          uid: row.uid || row[0],
          name: (() => {
            const base = row.name || row[1] || '';
            const cls = row.className || row[4] || '';
            return cls && base ? `${cls}::${base}` : base;
          })(),
          filePath: row.filePath || row[2] || '',
          startLine: row.startLine ?? row[3] ?? undefined,
          kind: 'Method',
        },
        edge: {
          confidence: Number(row.confidence ?? row[5] ?? 1.0),
          reason: String(row.reason ?? row[6] ?? ''),
        },
      })).filter((t: any) => t?.controller?.uid && t?.edge?.reason);

      route_targets.push({
        route_file: filePath,
        targets,
      });
    }

    const authz: any[] = [];
    for (const sym of changedSymbols) {
      const kind = String(sym?.kind || '');
      const filePath = String(sym?.filePath || '');
      if (kind !== 'Method') continue;
      if (!filePath.includes('/Http/Controllers/')) continue;
      if (!filePath.toLowerCase().endsWith('.php')) continue;

      const escaped = String(sym.uid || '').replace(/'/g, "''");
      let authRows: any[] = [];
      try {
        authRows = await executeQuery(repo.id, `
          MATCH (c {id: '${escaped}'})-[r:CodeRelation {type: 'CALLS'}]->(t)
          WHERE r.confidence >= ${minConfidence}
            AND (
              r.reason STARTS WITH 'laravel-authorize:'
              OR r.reason STARTS WITH 'laravel-gate:'
              OR r.reason STARTS WITH 'laravel-can:'
            )
          RETURN t.id AS uid, t.name AS name, labels(t) AS kind, t.filePath AS filePath,
                 r.reason AS reason, r.confidence AS confidence
          ORDER BY r.confidence DESC
          LIMIT 25
        `);
      } catch {
        authRows = [];
      }

      const checks: any[] = [];
      for (const row of authRows) {
        const targetUid = row.uid || row[0];
        if (!targetUid || typeof targetUid !== 'string') continue;
        const targetKind = row.kind || row[2] || '';
        const check: any = {
          target: {
            uid: targetUid,
            name: row.name || row[1] || '',
            kind: targetKind,
            filePath: row.filePath || row[3] || '',
          },
          edge: {
            reason: row.reason || row[4] || '',
            confidence: Number(row.confidence ?? row[5] ?? 1.0),
          },
        };

        // Expand enum const → permission slug when available
        if (targetKind === 'Const') {
          const constEscaped = targetUid.replace(/'/g, "''");
          try {
            const slugRows = await executeQuery(repo.id, `
              MATCH (c {id: '${constEscaped}'})-[r:CodeRelation {type: 'CALLS'}]->(s:CodeElement)
              WHERE r.reason STARTS WITH 'laravel-permission-slug:'
              RETURN s.name AS name, s.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
              ORDER BY r.confidence DESC
              LIMIT 3
            `);
            if (slugRows.length > 0) {
              check.permission_slugs = slugRows.map((sr: any) => ({
                name: sr.name || sr[0] || '',
                filePath: sr.filePath || sr[1] || '',
                edge: {
                  reason: sr.reason || sr[2] || '',
                  confidence: Number(sr.confidence ?? sr[3] ?? 1.0),
                },
              })).filter((s: any) => s.name);
            }
          } catch { /* ignore */ }
        }

        checks.push(check);
      }

      if (checks.length === 0) continue;
      authz.push({
        controller: sym,
        checks,
      });
    }

    const review_kernel = buildReviewKernel({
      changed_files: changedFileObjs.length,
      changed_symbols: changedSymbols.length,
      suggested_tests: suggested_tests.length,
      ui_contracts: ui_contracts.length,
      route_files: route_targets.length,
      authz_controllers: authz.length,
      semantic_diffs,
      slice_stencil,
        scope: effectiveScope,
        path_prefixes: pathPrefixes,
      });

    return {
      status: 'ok',
      repo: repo.name,
      scope,
      base_ref: baseRef || undefined,
      path_prefixes: pathPrefixes,
      summary: {
        changed_files: changedFileObjs.length,
        changed_symbols: changedSymbols.length,
        suggested_tests: suggested_tests.length,
        ui_contracts: ui_contracts.length,
        route_files: route_targets.length,
        authz_controllers: authz.length,
        semantic_families: semantic_diffs.summary.family_count,
        semantic_gap_signals: semantic_diffs.summary.gap_signals,
        proof_symbols: proof_pack.summary.symbol_spans,
        proof_edges: proof_pack.summary.edge_spans,
        stencil_slices: slice_stencil.summary.changed_slices,
        stencil_templates: slice_stencil.summary.with_templates,
      },
      changed_files: changedFileObjs.map(f => ({
        filePath: normalizePath(f.filePath),
        status: f.status,
        ...(f.fromPath ? { fromPath: normalizePath(f.fromPath) } : {}),
        hunks: f.hunks,
        ...(f.binary ? { binary: true } : {}),
      })),
      changed_symbols: changedSymbols,
      symbols,
      suggested_tests,
      ui_contracts,
      route_targets,
      authz,
      semantic_diffs,
      proof_pack,
      slice_stencil,
      review_kernel,
      _review_mode: {
        diff: {
          requested_scope: scope,
          effective_scope: effectiveScope,
          fallback_applied: diffSource !== 'requested',
          source: diffSource,
        },
        knobs: {
          limit_symbols: limitSymbols,
          limit_callers: limitCallers,
          limit_tests: limitTests,
          min_confidence: minConfidence,
          include_ui_contracts: includeUiContracts,
          max_ui_contract_files: maxUiContractFiles,
          include_evidence_spans: includeEvidenceSpans,
          limit_evidence: limitEvidence,
          include_slice_stencil: includeSliceStencil,
          limit_slice_stencil: limitSliceStencil,
        },
      },
    };
  }

  private async debugMode(repo: RepoHandle, params: {
    query?: string;
    symptom?: string;
    task_context?: string;
    goal?: string;
    failing_tests?: string[];
    error_strings?: string[];
    path_prefixes?: string[];
    limit_candidates?: number;
    limit_hops?: number;
    include_precedents?: boolean;
  }): Promise<any> {
    const queryText = String(params.query || '').trim();
    const symptomText = String(params.symptom || '').trim();
    const failingTests = this.toStringArray(params.failing_tests);
    const errorStrings = this.toStringArray(params.error_strings);
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
    const limitCandidates = Math.max(1, Math.min(30, params.limit_candidates ?? 8));
    const limitHops = Math.max(1, Math.min(20, params.limit_hops ?? 6));
    const includePrecedents = params.include_precedents !== false;

    const seedQuery = queryText || symptomText || failingTests[0] || errorStrings[0] || '';
    if (!seedQuery.trim()) {
      return { error: 'Provide at least one of query, symptom, failing_tests, or error_strings.' };
    }

    const classifySymptom = (value: string): {
      family: 'auth' | 'cache' | 'shape' | 'routing' | 'event' | 'unknown';
      normalized: string;
      matched_tokens: string[];
    } => {
      const normalized = String(value || '').trim().toLowerCase();
      const tokenMap: Array<{ family: 'auth' | 'cache' | 'shape' | 'routing' | 'event'; tokens: string[] }> = [
        { family: 'auth', tokens: ['403', 'forbidden', 'unauthorized', 'permission', 'authorize', 'auth', 'policy', 'can('] },
        { family: 'cache', tokens: ['stale', 'cache', 'invalidate', 'refetch', 'query key', 'setquerydata', 'missing update'] },
        { family: 'shape', tokens: ['field', 'payload', 'serialize', 'validation', 'null', 'undefined', 'wrong field'] },
        { family: 'routing', tokens: ['route', '404', 'endpoint', 'controller', 'path', 'url', 'method not allowed'] },
        { family: 'event', tokens: ['queue', 'event', 'listener', 'job', 'broadcast'] },
      ];

      for (const entry of tokenMap) {
        const matched = entry.tokens.filter(token => normalized.includes(token));
        if (matched.length > 0) {
          return { family: entry.family, normalized, matched_tokens: matched.slice(0, 8) };
        }
      }

      return { family: 'unknown', normalized, matched_tokens: [] };
    };

    const symptomSignal = classifySymptom([
      symptomText,
      ...failingTests,
      ...errorStrings,
      queryText,
    ].join(' '));

    const queryResult = await this.query(repo, {
      query: seedQuery,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
      limit: 5,
      max_symbols: 12,
      include_content: false,
      include_slice_cards: true,
      limit_slices: 2,
      include_evidence_spans: true,
      limit_evidence: 20,
    });

    const actionPlanResult = await this.actionPlan(repo, {
      query: seedQuery,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
      limit_files: 12,
      limit_checks: 10,
      __skip_precedents: true,
    });

    const targetSlice = Array.isArray(queryResult?.slice_cards) ? queryResult.slice_cards[0] : null;
    let precedentPack: any = null;
    if (includePrecedents) {
      try {
        precedentPack = await this.precedents(repo, {
          query: seedQuery,
          ...(targetSlice?.anchor_id ? { anchor_uid: String(targetSlice.anchor_id) } : {}),
          limit: 2,
          examples: 3,
          path_prefixes: pathPrefixes,
        });
      } catch {
        precedentPack = null;
      }
    }

    const candidateLoops: Array<{
      kind: 'http_loop' | 'cache_loop' | 'slice_gap';
      score: number;
      symptom_fit: number;
      confidence: number;
      summary: string;
      findings: string[];
      evidence: any;
    }> = [];

    const hops = Array.isArray(actionPlanResult?.hops) ? actionPlanResult.hops.slice(0, limitHops) : [];
    for (const hop of hops) {
      const findings: string[] = [];
      let score = 1;
      let symptomFit = 0;
      const permissions = Array.isArray(hop?.permissions) ? hop.permissions : [];

      if (!hop?.endpoint?.uid) {
        findings.push('missing-endpoint-link');
        score += 2;
      }
      if (!hop?.controller?.uid) {
        findings.push('missing-controller-link');
        score += 2;
      }

      if (permissions.length === 0) {
        findings.push('missing-permission-closure');
        score += 3;
      } else {
        const grantsWithoutRoles = permissions.filter((grant: any) => !Array.isArray(grant?.roles) || grant.roles.length === 0);
        if (grantsWithoutRoles.length > 0) {
          findings.push('no-role-grants');
          score += 3;
        }
      }

      const httpConfidence = Number(hop?.http?.confidence ?? 1) || 1;
      const wiringConfidence = Number(hop?.endpoint_wiring?.confidence ?? 1) || 1;
      if (httpConfidence < 0.9 || wiringConfidence < 0.9) {
        findings.push('low-confidence-http-wiring');
        score += 1;
      }

      if (symptomSignal.family === 'auth' && (findings.includes('missing-permission-closure') || findings.includes('no-role-grants'))) {
        symptomFit += 3;
      }
      if (symptomSignal.family === 'routing' && (findings.includes('missing-endpoint-link') || findings.includes('missing-controller-link'))) {
        symptomFit += 3;
      }

      const finalScore = score + symptomFit;
      candidateLoops.push({
        kind: 'http_loop',
        score: finalScore,
        symptom_fit: symptomFit,
        confidence: Number(Math.max(0, Math.min(1, (httpConfidence + wiringConfidence) / 2)).toFixed(3)),
        summary: `${String(hop?.http?.reason || 'http-loop')} -> ${String(hop?.controller?.name || 'unknown-controller')}`,
        findings,
        evidence: {
          hop: {
            http: hop?.http || null,
            endpoint: hop?.endpoint || null,
            controller: hop?.controller || null,
            endpoint_wiring: hop?.endpoint_wiring || null,
          },
          permissions,
        },
      });
    }

    const cacheEffects = Array.isArray(actionPlanResult?.cache_effects) ? actionPlanResult.cache_effects : [];
    for (const effect of cacheEffects.slice(0, limitCandidates)) {
      const gaps = Array.isArray(effect?.coverage_gaps) ? effect.coverage_gaps : [];
      if (gaps.length === 0) continue;

      const symptomFit = symptomSignal.family === 'cache' ? 3 : 0;
      candidateLoops.push({
        kind: 'cache_loop',
        score: 2 + (gaps.length * 0.5) + symptomFit,
        symptom_fit: symptomFit,
        confidence: 0.7,
        summary: `${String(effect?.filePath || 'cache-surface')} has ${gaps.length} cache coverage gaps`,
        findings: ['missing-cache-coverage'],
        evidence: {
          filePath: effect?.filePath || '',
          coverage_gaps: gaps.slice(0, 8),
          summary: effect?.summary || null,
        },
      });
    }

    if (targetSlice?.gap_signals) {
      const gapSignals = targetSlice.gap_signals;
      const severeGapCount = Number(gapSignals?.high || 0) + Number(gapSignals?.deterministic || 0);
      if (severeGapCount > 0) {
        const symptomFit = symptomSignal.family === 'shape' ? 2 : 0;
        candidateLoops.push({
          kind: 'slice_gap',
          score: 2 + severeGapCount + symptomFit,
          symptom_fit: symptomFit,
          confidence: 0.75,
          summary: `Target slice ${String(targetSlice?.label || targetSlice?.uid || '')} has closure gap signals`,
          findings: ['slice-closure-gaps'],
          evidence: {
            slice: targetSlice,
            gap_signals: gapSignals,
          },
        });
      }
    }

    const rankedCandidates = candidateLoops
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.symptom_fit !== left.symptom_fit) return right.symptom_fit - left.symptom_fit;
        return left.summary.localeCompare(right.summary);
      })
      .slice(0, limitCandidates);

    const siblingDiff = (() => {
      const precedents = Array.isArray(precedentPack?.precedents) ? precedentPack.precedents : [];
      const slicePrecedent = precedents.find((entry: any) => entry?.kind === 'slice' && entry?.anchor);
      if (!slicePrecedent || !targetSlice) return null;

      const example = Array.isArray(slicePrecedent.examples) ? slicePrecedent.examples[0] : null;
      if (!example) return null;

      const targetClosedSlots = new Set((Array.isArray(targetSlice.closed_slots) ? targetSlice.closed_slots : []).map((slot: any) => String(slot || '').trim()).filter(Boolean));
      const targetRoles = new Set((Array.isArray(targetSlice.roles) ? targetSlice.roles : []).map((role: any) => String(role || '').trim()).filter(Boolean));
      const exampleClosedSlots = (Array.isArray(example.closed_slots) ? example.closed_slots : []).map((slot: any) => String(slot || '').trim()).filter(Boolean);
      const exampleRoles = (Array.isArray(example.roles) ? example.roles : []).map((role: any) => String(role || '').trim()).filter(Boolean);

      return {
        signature: String(slicePrecedent.signature || ''),
        target_slice: {
          uid: targetSlice.uid,
          label: targetSlice.label,
          slice_type: targetSlice.slice_type,
          closure_score: targetSlice.closure_score,
        },
        precedent_anchor: slicePrecedent.anchor,
        precedent_example: example,
        slot_diff: {
          missing_from_target: exampleClosedSlots.filter((slot: string) => !targetClosedSlots.has(slot)),
        },
        role_diff: {
          missing_from_target: exampleRoles.filter((role: string) => !targetRoles.has(role)),
        },
      };
    })();

    const hypotheses: string[] = [];
    for (const candidate of rankedCandidates.slice(0, 5)) {
      if (candidate.findings.includes('no-role-grants')) {
        hypotheses.push('Permission slug resolves, but no role grant closure exists for the affected endpoint.');
      } else if (candidate.findings.includes('missing-permission-closure')) {
        hypotheses.push('Controller flow may bypass expected permission closure.');
      } else if (candidate.findings.includes('missing-cache-coverage')) {
        hypotheses.push('Mutation path appears to miss invalidation/writeback for one or more active queries.');
      } else if (candidate.findings.includes('slice-closure-gaps')) {
        hypotheses.push('Feature slice closure is below sibling expectations; missing companions likely drive symptom.');
      } else if (candidate.findings.includes('missing-endpoint-link') || candidate.findings.includes('missing-controller-link')) {
        hypotheses.push('Routing chain has a missing/ambiguous hop between UI endpoint call and backend controller.');
      }
    }

    const nextActions = [
      'Open candidate evidence spans with context() on top-ranked symbols.',
      'Run impact() on the first broken-loop symbol to map direct dependents.',
      'Compare target slice vs sibling precedent before editing shared utilities.',
      'After edits, run review_mode(scope=unstaged) with include_slice_stencil=true.',
    ];
    if (failingTests.length > 0) {
      nextActions.push('Re-run failing tests after applying the highest-confidence loop fix.');
    }

    return {
      status: 'ok',
      repo: repo.name,
      query: seedQuery,
      symptom: symptomText || undefined,
      debug: {
        classification: symptomSignal,
        anchors: {
          query_plan: queryResult?.query_plan || null,
          target_slice: targetSlice || null,
          top_processes: Array.isArray(queryResult?.processes) ? queryResult.processes.slice(0, 3) : [],
          top_symbols: [
            ...(Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols.slice(0, 12) : []),
            ...(Array.isArray(queryResult?.definitions) ? queryResult.definitions.slice(0, 6) : []),
          ],
          hops: hops.slice(0, limitHops),
          cache_effects: cacheEffects.slice(0, 5),
        },
        candidates: rankedCandidates,
        sibling_diff: siblingDiff,
        hypotheses: Array.from(new Set(hypotheses)).slice(0, 8),
        next_actions: nextActions.slice(0, 8),
      },
      _debug_mode: {
        knobs: {
          limit_candidates: limitCandidates,
          limit_hops: limitHops,
          include_precedents: includePrecedents,
          path_prefixes: pathPrefixes,
        },
      },
    };
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

  async queryEpisodeState(repoName?: string, options?: {
    limit?: number;
    include_events?: boolean;
  }): Promise<any> {
    const repo = this.resolveRepo(repoName);
    const limit = Number.isFinite(Number(options?.limit)) ? Number(options?.limit) : 10;
    const includeEvents = options?.include_events !== false;
    const state = await loadEpisodeGraphState(repo.storagePath);
    return {
      status: 'ok',
      repo: repo.name,
      episode: summarizeEpisodeGraphState(state, { limit, includeEvents }),
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
    path_prefixes?: string[];
  }): Promise<{ report: ArchetypeReport }> {
    const repo = this.resolveRepo(repoName);
    await this.ensureInitialized(repo.id);

    const limit = options?.limit ?? 25;
    const examplesPerSignature = options?.examplesPerSignature ?? 3;
    const minHttpConfidence = options?.minHttpConfidence ?? 0.9;
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (options as any)?.path_prefixes);

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

    const scopedProcesses = pathPrefixes.length > 0
      ? Array.from(processesById.values()).filter(p => p.steps.some(s => filePathTouchesPrefixes(s.filePath, pathPrefixes)))
      : Array.from(processesById.values());

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

    const report = buildArchetypeReport(scopedProcesses, httpEdges, {
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
