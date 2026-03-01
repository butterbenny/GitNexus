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
  getEvidenceSpanLookup,
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
import { loadRuntimeObservationSnapshot } from '../../core/ingestion/runtime-observation-store.js';
import { parseWitnessPathIds } from '../../core/graph/edge-metadata.js';
import { runDetectChanges } from './detect-changes.js';
import { runImplementMode } from './implement-mode.js';
import { runQueryMode } from './query-mode.js';
import { runReviewMode } from './review-mode.js';
import { GITNEXUS_TOOLS } from '../tools.js';
// AI context generation is CLI-only (gitnexus analyze)
// import { generateAIContextFiles } from '../../cli/ai-context.js';

const MCP_TOOL_NAME_SET = new Set(GITNEXUS_TOOLS.map(tool => tool.name));
const GIT_NAME_LIST_MAX_BUFFER = 64 * 1024 * 1024; // 64MB for large working trees/monorepos
const GIT_PATCH_MAX_BUFFER = 128 * 1024 * 1024; // 128MB for large compare/all diffs
const CYPHER_WRITE_KEYWORDS = [
  'CREATE',
  'MERGE',
  'DELETE',
  'DETACH',
  'SET',
  'REMOVE',
  'DROP',
  'ALTER',
  'COPY',
  'LOAD',
  'INSTALL',
  'UNINSTALL',
  'INSERT',
  'UPDATE',
];
const buildObfuscatedKeywordPattern = (keyword: string): string => keyword.split('').join('\\s*');
const CYPHER_WRITE_KEYWORD_RE = new RegExp(
  `\\b(?:${CYPHER_WRITE_KEYWORDS.map(buildObfuscatedKeywordPattern).join('|')})\\b`,
);

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

type ToolingArtifactClassification = {
  kind: 'cache' | 'local-state';
  reason: string;
  guidance: string;
};

function classifyToolingArtifactPath(filePath: string): ToolingArtifactClassification | null {
  const normalized = String(filePath || '').trim().replace(/\\/g, '/');
  if (!normalized) return null;
  const name = normalized.split('/').pop()?.toLowerCase() || '';
  const lowerNormalized = normalized.toLowerCase();

  if (
    lowerNormalized === '.gitnexus'
    || lowerNormalized.startsWith('.gitnexus/')
  ) {
    return {
      kind: 'local-state',
      reason: 'gitnexus-local-state-artifact',
      guidance: 'Exclude `.gitnexus/` from product diffs when it is local runtime/index state (use `.git/info/exclude` or repo `.gitignore`).',
    };
  }

  if (name === '.php-cs-fixer.cache') {
    return {
      kind: 'cache',
      reason: 'php-cs-fixer-cache-artifact',
      guidance: 'Add `.php-cs-fixer.cache` to `.git/info/exclude` (local) or `.gitignore` to suppress non-product noise.',
    };
  }
  if (name === '.eslintcache' || name === '.stylelintcache' || name === '.prettiercache') {
    return {
      kind: 'cache',
      reason: 'lint-or-format-cache-artifact',
      guidance: 'Exclude local lint/format cache files from git status noise via `.git/info/exclude`.',
    };
  }
  if (name === '.ds_store' || name === 'thumbs.db') {
    return {
      kind: 'local-state',
      reason: 'os-generated-artifact',
      guidance: 'Exclude OS-generated metadata files from version control to keep review signal clean.',
    };
  }

  return null;
}

function normalizeRepoRelativePath(value: string): string {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

export function resolvePathInsideRepo(
  repoPath: string,
  rawPath: string,
): { relativePath: string; absolutePath: string } | null {
  const input = String(rawPath || '').trim();
  if (!input) return null;

  const absoluteCandidate = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(repoPath, input);
  const relativePath = path.relative(repoPath, absoluteCandidate).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) return null;

  const normalizedRelativePath = normalizeRepoRelativePath(relativePath);
  if (!normalizedRelativePath || normalizedRelativePath.startsWith('..')) return null;

  return {
    relativePath: normalizedRelativePath,
    absolutePath: path.join(repoPath, normalizedRelativePath),
  };
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
  const dedupe = (items: string[]): string[] => Array.from(new Set(
    items
      .map(item => String(item || '').trim())
      .filter(Boolean),
  ));

  if (Array.isArray(value)) {
    return dedupe(value as string[]);
  }

  const raw = String(value || '').trim();
  if (!raw) return [];

  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return dedupe(parsed as string[]);
      }
    } catch {
      const inner = raw.slice(1, -1).trim();
      if (!inner) return [];
      return dedupe(
        inner
          .split(',')
          .map(item => item.trim().replace(/^'+|'+$/g, '').replace(/^"+|"+$/g, '')),
      );
    }
  }

  return dedupe(
    raw
      .split(/[\n,;]+/g)
      .map(item => item.trim()),
  );
}

function normalizeSliceStencilToken(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/^['"`]+|['"`]+$/g, '').trim();
}

function normalizeSliceStencilTokens(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeSliceStencilToken(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function missingRequiredSlotSeverity(missingRequiredSlots: string[], deterministic: boolean, pattern: boolean): 'high' | 'medium' | 'low' {
  const missing = new Set(normalizeSliceStencilTokens(missingRequiredSlots));
  const missesCriticalSlots = missing.has('anchor') || missing.has('handler');
  if (deterministic) return missesCriticalSlots ? 'high' : 'medium';
  if (pattern) return missesCriticalSlots ? 'medium' : 'low';
  return 'low';
}

function primaryNodeLabel(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return String(value ?? '').trim();
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeConfidence(value: unknown, fallback = 1): number {
  const parsed = toFiniteNumber(value, fallback);
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function toOptionalLineNumber(value: unknown): number | undefined {
  const parsed = toOptionalFiniteNumber(value);
  if (parsed === undefined) return undefined;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? normalized : undefined;
}

function toOptionalNonNegativeInteger(value: unknown): number | undefined {
  const parsed = toOptionalFiniteNumber(value);
  if (parsed === undefined) return undefined;
  const normalized = Math.trunc(parsed);
  return normalized >= 0 ? normalized : undefined;
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = toOptionalNonNegativeInteger(value);
  return parsed === undefined ? fallback : parsed;
}

function round3(value: unknown, fallback = 0): number {
  const normalized = toFiniteNumber(value, fallback);
  return Math.round(normalized * 1000) / 1000;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.trunc(parsed);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function isReadOnlyCypherQuery(query: string): boolean {
  const stripped = String(query || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'([^'\\]|\\.|'')*'/g, "''")
    .replace(/"([^"\\]|\\.)*"/g, '""')
    .toUpperCase();

  const statements = stripped
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) return false;

  return statements.every(statement => !CYPHER_WRITE_KEYWORD_RE.test(statement));
}

/** Valid KuzuDB node labels for safe Cypher query construction */
const VALID_NODE_LABELS = new Set([
  'File', 'Folder', 'Function', 'Class', 'Interface', 'Method', 'CodeElement',
  'Community', 'Process', 'FeatureSlice', 'Gap', 'ContractShape', 'ContractField', 'CacheKey', 'DBTable', 'DBColumn', 'ValueNode', 'TestCase',
  'Struct', 'Enum', 'Macro', 'Typedef', 'Union',
  'Namespace', 'Trait', 'Impl', 'TypeAlias', 'Const', 'Static', 'Property',
  'Record', 'Delegate', 'Annotation', 'Constructor', 'Template', 'Module',
]);

type SemanticRetrievalMode = 'off' | 'shadow' | 'assist';

const DEFAULT_SEMANTIC_RETRIEVAL_MODE: SemanticRetrievalMode = 'shadow';
const SEMANTIC_MODE_OVERRIDE_ENV = 'GITNEXUS_SEMANTIC_RETRIEVAL_MODE';
const SEMANTIC_VECTOR_INDEX_CACHE_TTL_MS = 30_000;
const SEMANTIC_VECTOR_DIMS = getEmbeddingDims();
const SEMANTIC_VECTOR_PROBE = `[${Array.from({ length: SEMANTIC_VECTOR_DIMS }, () => '0').join(',')}]`;

function parseSemanticRetrievalMode(value: unknown): SemanticRetrievalMode | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'off') return 'off';
  if (normalized === 'assist') return 'assist';
  if (normalized === 'shadow') return 'shadow';
  return null;
}

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
  private semanticModeCache: Map<string, { manifestMtimeMs: number; mode: SemanticRetrievalMode; source: string }> = new Map();
  private semanticVectorIndexCache: Map<string, { checkedAtMs: number; available: boolean }> = new Map();
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

  private async getSemanticRetrievalMode(repo: RepoHandle): Promise<{ mode: SemanticRetrievalMode; source: string }> {
    const overrideMode = parseSemanticRetrievalMode(process.env[SEMANTIC_MODE_OVERRIDE_ENV]);
    if (overrideMode) {
      return { mode: overrideMode, source: 'env-override' };
    }

    const manifestPath = path.join(repo.storagePath, 'manifests', 'brain.json');
    let manifestMtimeMs = -1;
    try {
      const stat = await fs.stat(manifestPath);
      manifestMtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : -1;
    } catch {
      return { mode: DEFAULT_SEMANTIC_RETRIEVAL_MODE, source: 'default-shadow' };
    }

    const cached = this.semanticModeCache.get(repo.id);
    if (cached && cached.manifestMtimeMs === manifestMtimeMs) {
      return { mode: cached.mode, source: cached.source };
    }

    try {
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw);
      const canaryPromotionAllowed = Boolean(manifest?.evalGraph?.canaryHarness?.promotionAllowed);
      const openRegressions = toNonNegativeInteger(manifest?.evalGraph?.regressionTracking?.openRegressions, 0);
      const distillationPromoted = Boolean(manifest?.distillationEngine?.promotion?.promoted);
      const distillationRiskLevel = String(manifest?.distillationEngine?.riskScorer?.level || '').trim().toLowerCase();
      const assistEligible = canaryPromotionAllowed
        && distillationPromoted
        && openRegressions === 0
        && distillationRiskLevel !== 'high';
      const mode: SemanticRetrievalMode = assistEligible ? 'assist' : DEFAULT_SEMANTIC_RETRIEVAL_MODE;
      const source = assistEligible ? 'brain-promotion' : 'brain-shadow';
      this.semanticModeCache.set(repo.id, { manifestMtimeMs, mode, source });
      return { mode, source };
    } catch {
      return { mode: DEFAULT_SEMANTIC_RETRIEVAL_MODE, source: 'default-shadow' };
    }
  }

  private async hasSemanticVectorIndex(repo: RepoHandle): Promise<boolean> {
    const cached = this.semanticVectorIndexCache.get(repo.id);
    const now = Date.now();
    if (cached && (now - cached.checkedAtMs) < SEMANTIC_VECTOR_INDEX_CACHE_TTL_MS) {
      return cached.available;
    }

    let available = false;
    try {
      await executeQuery(repo.id, `
        CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx',
          CAST(${SEMANTIC_VECTOR_PROBE} AS FLOAT[${SEMANTIC_VECTOR_DIMS}]), 1)
        YIELD node AS emb, distance
        RETURN emb.nodeId AS nodeId, distance
        LIMIT 1
      `);
      available = true;
    } catch {
      available = false;
    }

    this.semanticVectorIndexCache.set(repo.id, { checkedAtMs: now, available });
    return available;
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
          fileCount: toNonNegativeInteger(s.files, 0),
          functionCount: toNonNegativeInteger(s.nodes, 0),
          communityCount: toNonNegativeInteger(s.communities, 0),
          processCount: toNonNegativeInteger(s.processes, 0),
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
          fileCount: toNonNegativeInteger(s.files, 0),
          functionCount: toNonNegativeInteger(s.nodes, 0),
          communityCount: toNonNegativeInteger(s.communities, 0),
          processCount: toNonNegativeInteger(s.processes, 0),
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
          fileCount: toNonNegativeInteger(s.files, 0),
          functionCount: toNonNegativeInteger(s.nodes, 0),
          communityCount: toNonNegativeInteger(s.communities, 0),
          processCount: toNonNegativeInteger(s.processes, 0),
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
      const startLine = toOptionalLineNumber(startRaw);
      const endLine = toOptionalLineNumber(endRaw);
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
        startLine: toOptionalLineNumber(item?.startLine),
        endLine: toOptionalLineNumber(item?.endLine),
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
        stepCount: toOptionalNonNegativeInteger(item?.step_count ?? item?.stepCount),
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
    const limit = clampInteger(params.limit, 10, 1, 200);
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
    const limit = clampInteger(params.limit, 10, 1, 200);
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
    const limit = clampInteger(params.limit, 20, 1, 500);
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
    const limit = clampInteger(params.limit, 20, 1, 500);
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
    const limit = clampInteger(params.limit, 20, 1, 500);
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
      limit: clampInteger(params.limit, 25, 1, 100),
      examplesPerSignature: clampInteger(params.examples, 3, 1, 10),
      minHttpConfidence: Math.max(0, Math.min(1, toFiniteNumber(params.min_http_confidence, 0.9))),
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
          label: String(row.label ?? row[1] ?? processId).trim(),
          heuristicLabel: String(row.heuristicLabel ?? row[2] ?? row.label ?? row[1] ?? processId).trim(),
          processType: String(row.processType ?? row[3] ?? '').trim(),
          stepCount: toNonNegativeInteger(row.stepCount ?? row[4], 0),
          steps: [],
        };
        processesById.set(processId, proc);
      }

      proc.steps.push({
        step: toNonNegativeInteger(row.step ?? row[9], 0),
        nodeId: String(row.nodeId ?? row[5] ?? '').trim(),
        name: String(row.name ?? row[6] ?? '').trim(),
        filePath: String(row.filePath ?? row[7] ?? '').trim(),
        type: primaryNodeLabel(row.type ?? row[8]),
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
      sourceId: String(r.sourceId ?? r[0] ?? '').trim(),
      targetId: String(r.targetId ?? r[1] ?? '').trim(),
      reason: String(r.reason ?? r[2] ?? '').trim(),
      confidence: toFiniteNumber(r.confidence ?? r[3], 1.0),
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

    const limit = clampInteger(params.limit, 2, 1, 5);
    const examplesPer = clampInteger(params.examples, 3, 1, 5);
    const minHttpConfidence = Math.max(0, Math.min(1, toFiniteNumber(params.min_http_confidence, 0.9)));
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
          closureScore: toFiniteNumber(row.closureScore ?? row[8], 0),
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

        const confidence = toFiniteNumber(row.confidence ?? row[2], 0);
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
        closure_score: round3(slice.closureScore),
        closure_slots: slice.closureSlots,
        closed_slots: slice.closedSlots,
        roles: slice.roles,
        member_count: slice.members.length,
        member_files: slice.memberFiles.slice(0, 10),
      };

      if (extra?.score !== undefined) out.score = round3(extra.score);
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
          http: { reason: String(reason), confidence: normalizeConfidence(row.confidence ?? row[13], 1.0) },
          endpoint_wiring: {
            reason: String(row.wiringReason || row[14] || ''),
            confidence: normalizeConfidence(row.wiringConfidence ?? row[15], 1.0),
          },
          ui: {
            uid: String(uiUid),
            name: String(row.uiName || row[1] || ''),
            kind: String(uiUid).split(':')[0],
            filePath: String(row.uiFilePath || row[2] || ''),
            startLine: toOptionalLineNumber(row.uiStartLine ?? row[3]),
          },
          endpoint: {
            uid: String(endpointUid),
            name: String(row.endpointName || row[5] || ''),
            kind: String(endpointUid).split(':')[0],
            filePath: String(row.endpointFilePath || row[6] || ''),
            startLine: toOptionalLineNumber(row.endpointStartLine ?? row[7]),
          },
          controller: {
            uid: String(controllerUid),
            name: String(row.controllerName || row[9] || ''),
            kind: String(controllerUid).split(':')[0],
            filePath: String(row.controllerFilePath || row[10] || ''),
            startLine: toOptionalLineNumber(row.controllerStartLine ?? row[11]),
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
              score: round3(cochange.score),
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

    const escapeCypherValue = (value: string): string => String(value || '').replace(/'/g, "''");
    const buildCypherStringList = (values: string[]): string => {
      if (values.length === 0) return '[]';
      return `[${values.map(value => `'${escapeCypherValue(value)}'`).join(', ')}]`;
    };

    const mapHopRow = (row: any): any | null => {
      const uiUid = row.uiUid || row[0];
      const endpointUid = row.endpointUid || row[4];
      const controllerUid = row.controllerUid || row[8];
      const reason = row.reason || row[12];
      if (!uiUid || !endpointUid || !controllerUid || !reason) return null;

      return {
        http: { reason: String(reason), confidence: normalizeConfidence(row.confidence ?? row[13], 1.0) },
        endpoint_wiring: {
          reason: String(row.wiringReason || row[14] || ''),
          confidence: normalizeConfidence(row.wiringConfidence ?? row[15], 1.0),
        },
        ui: {
          uid: String(uiUid),
          name: String(row.uiName || row[1] || ''),
          kind: String(uiUid).split(':')[0],
          filePath: String(row.uiFilePath || row[2] || ''),
          startLine: toOptionalLineNumber(row.uiStartLine ?? row[3]),
        },
        endpoint: {
          uid: String(endpointUid),
          name: String(row.endpointName || row[5] || ''),
          kind: String(endpointUid).split(':')[0],
          filePath: String(row.endpointFilePath || row[6] || ''),
          startLine: toOptionalLineNumber(row.endpointStartLine ?? row[7]),
        },
        controller: {
          uid: String(controllerUid),
          name: String(row.controllerName || row[9] || ''),
          kind: String(controllerUid).split(':')[0],
          filePath: String(row.controllerFilePath || row[10] || ''),
          startLine: toOptionalLineNumber(row.controllerStartLine ?? row[11]),
        },
      };
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

    const findStepNodeIdsForProcesses = async (
      processIds: string[],
      maxCountPerProcess: number,
    ): Promise<Map<string, string[]>> => {
      const ids = Array.from(new Set(processIds.map(id => String(id || '').trim()).filter(Boolean)));
      const rowsByProcess = new Map<string, string[]>();
      if (ids.length === 0) return rowsByProcess;

      let rows: any[] = [];
      const perProcessLimit = Math.max(1, Math.min(80, maxCountPerProcess));
      const totalLimit = Math.max(200, Math.min(20000, ids.length * perProcessLimit * 2));
      try {
        rows = await executeQuery(repo.id, `
          MATCH (n)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE p.id IN ${buildCypherStringList(ids)}
          RETURN p.id AS processId, n.id AS nodeId
          LIMIT ${totalLimit}
        `);
      } catch {
        return rowsByProcess;
      }
      for (const row of rows) {
        const processId = String(row.processId ?? row[0] ?? '').trim();
        const nodeId = String(row.nodeId ?? row[1] ?? '').trim();
        if (!processId || !nodeId) continue;
        const list = rowsByProcess.get(processId) || [];
        if (list.length >= perProcessLimit) {
          if (!rowsByProcess.has(processId)) rowsByProcess.set(processId, list);
          continue;
        }
        if (!list.includes(nodeId)) list.push(nodeId);
        rowsByProcess.set(processId, list);
      }
      return rowsByProcess;
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

      const uidPredicate = `(ui.id = '${escaped}' OR e.id = '${escaped}' OR c.id = '${escaped}')`;
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui)-[r:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE r.confidence >= ${minHttpConfidence} AND r.reason STARTS WITH 'http-' AND e.name STARTS WITH 'endpoint:'
          MATCH (e)-[w:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE w.confidence >= ${minHttpConfidence} AND w.reason STARTS WITH 'laravel-endpoint:'
            AND ${uidPredicate}
          RETURN r.reason AS reason, r.confidence AS confidence,
                 w.reason AS wiringReason, w.confidence AS wiringConfidence,
                 e.id AS endpointUid, e.name AS endpointName, e.filePath AS endpointFilePath, e.startLine AS endpointStartLine,
                 c.id AS controllerUid, c.name AS controllerName, c.filePath AS controllerFilePath, c.startLine AS controllerStartLine,
                 ui.id AS uiUid, ui.name AS uiName, ui.filePath AS uiFilePath, ui.startLine AS uiStartLine
          ORDER BY r.confidence DESC
          LIMIT ${Math.max(limitSql, Math.min(100, limitSql * 4))}
        `);
      } catch { /* ignore */ }
      for (const row of rows) {
        const hop = mapHopRow(row);
        if (!hop) continue;
        push(hop);
        if (out.length >= limit) break;
      }

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

      if (candidates.length === 0) return [];

      const out: any[] = [];
      const seen = new Set<string>();
      const limitSql = Math.max(1, Math.min(25, maxCount));
      const tokenWhere = candidates
        .map(token => `r.reason CONTAINS '/${escapeCypherValue(token)}'`)
        .join(' OR ');
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui)-[r:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE r.confidence >= ${minHttpConfidence}
            AND r.reason STARTS WITH 'http-'
            AND (${tokenWhere})
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
          LIMIT ${Math.max(limitSql, Math.min(150, limitSql * candidates.length * 2))}
        `);
      } catch {
        return [];
      }

      for (const row of rows) {
        const hop = mapHopRow(row);
        if (!hop) continue;
        const key = `${String(hop?.ui?.uid || '')}|${String(hop?.endpoint?.uid || '')}|${String(hop?.controller?.uid || '')}|${String(hop?.http?.reason || '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(hop);
        if (out.length >= maxCount) break;
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

    const uniqueAnchorProcessIds = Array.from(new Set(anchorProcessIds.map(pid => String(pid || '').trim()).filter(Boolean)));
    const stepNodeIdsByProcess = await findStepNodeIdsForProcesses(uniqueAnchorProcessIds.slice(0, limit * 3), 48);
    for (const pid of uniqueAnchorProcessIds.slice(0, limit * 3)) {
      const stepNodeIds = stepNodeIdsByProcess.get(pid) || [];
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

    for (const pid of uniqueAnchorProcessIds.slice(0, limit)) {
      addProcessPrecedent(pid);
    }

    const precedents = [...slicePrecedents, ...hopPrecedents, ...processPrecedents]
      .slice(0, Math.max(limit, slicePrecedents.length + hopPrecedents.length + processPrecedents.length));

    const diagnostics: any = {
      anchor_uid: anchorUid || undefined,
      anchor_processes: uniqueAnchorProcessIds.length,
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
    
    const processLimit = clampInteger(params.limit, 5, 1, 50);
    const maxSymbolsPerProcess = clampInteger(params.max_symbols, 10, 1, 200);
    const includeContent = params.include_content ?? false;
    const includeSliceCards = params.include_slice_cards !== false;
    const limitSlices = clampInteger(params.limit_slices, 2, 1, 5);
    const includeEvidenceSpans = params.include_evidence_spans !== false;
    const limitEvidence = clampInteger(params.limit_evidence, 20, 1, 100);
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
    const toPrimaryLabel = (value: any): string => {
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
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
        startLine: toOptionalLineNumber(row.startLine ?? row[4]),
        endLine: toOptionalLineNumber(row.endLine ?? row[5]),
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
    const semanticPolicy = await this.getSemanticRetrievalMode(repo);
    const semanticMode = semanticPolicy.mode;
    const semanticEligible = !looksLikeIdentifier && bm25Results.length < Math.max(5, Math.floor(searchLimit / 3));
    const semanticIndexAvailable = semanticMode !== 'off' && semanticEligible
      ? await this.hasSemanticVectorIndex(repo)
      : false;
    const shouldTrySemantic = semanticMode !== 'off' && semanticEligible && semanticIndexAvailable;

    const semanticRaw = shouldTrySemantic
      ? await this.semanticSearch(repo, searchQuery, searchLimit)
      : [];
    const semanticResults = pathPrefixes.length > 0
      ? semanticRaw.filter(r => isInScope(r?.filePath || ''))
      : semanticRaw;
    const semanticContributedResults = semanticMode === 'assist' ? semanticResults : [];
    
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

    for (let i = 0; i < semanticContributedResults.length; i++) {
      const result = semanticContributedResults[i];
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

    const escapeCypherValue = (value: string): string => String(value || '').replace(/'/g, "''");
    const buildCypherStringList = (values: string[]): string => {
      if (values.length === 0) return '[]';
      return `[${values.map(value => `'${escapeCypherValue(value)}'`).join(', ')}]`;
    };

    const mergedNodeIds = Array.from(new Set(
      merged
        .map(item => String(item?.data?.nodeId || '').trim())
        .filter(Boolean),
    ));
    const mergedNodeIdCypherList = buildCypherStringList(mergedNodeIds);

    const processRowsByNodeId = new Map<string, any[]>();
    if (mergedNodeIds.length > 0) {
      const membershipLimit = Math.max(400, Math.min(12000, mergedNodeIds.length * 30));
      try {
        const processMembershipRows = await executeQuery(repo.id, `
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE n.id IN ${mergedNodeIdCypherList}
          RETURN n.id AS nodeId,
                 p.id AS pid,
                 p.label AS label,
                 p.heuristicLabel AS heuristicLabel,
                 p.processType AS processType,
                 p.stepCount AS stepCount,
                 r.step AS step
          LIMIT ${membershipLimit}
        `);
        for (const row of processMembershipRows) {
          const nodeId = String(row?.nodeId ?? row?.[0] ?? '').trim();
          if (!nodeId) continue;
          const list = processRowsByNodeId.get(nodeId) || [];
          list.push(row);
          processRowsByNodeId.set(nodeId, list);
        }
      } catch {
        // Best-effort path. Query mode continues with standalone definitions when lookup fails.
      }
    }

    const cohesionByNodeId = new Map<string, number>();
    if (mergedNodeIds.length > 0) {
      const cohesionLimit = Math.max(200, Math.min(8000, mergedNodeIds.length * 10));
      try {
        const cohesionRows = await executeQuery(repo.id, `
          MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE n.id IN ${mergedNodeIdCypherList}
          RETURN n.id AS nodeId, max(c.cohesion) AS cohesion
          LIMIT ${cohesionLimit}
        `);
        for (const row of cohesionRows) {
          const nodeId = String(row?.nodeId ?? row?.[0] ?? '').trim();
          if (!nodeId) continue;
          const cohesionRaw = row?.cohesion ?? row?.[1] ?? 0;
          const cohesion = toFiniteNumber(cohesionRaw, 0);
          cohesionByNodeId.set(nodeId, cohesion);
        }
      } catch {
        // Keep default cohesion=0
      }
    }

    const contentByNodeId = new Map<string, string>();
    if (includeContent && mergedNodeIds.length > 0) {
      const contentLimit = Math.max(200, Math.min(8000, mergedNodeIds.length * 8));
      try {
        const contentRows = await executeQuery(repo.id, `
          MATCH (n)
          WHERE n.id IN ${mergedNodeIdCypherList}
          RETURN n.id AS nodeId, n.content AS content
          LIMIT ${contentLimit}
        `);
        for (const row of contentRows) {
          const nodeId = String(row?.nodeId ?? row?.[0] ?? '').trim();
          if (!nodeId) continue;
          const content = row?.content ?? row?.[1];
          if (typeof content === 'string' && content.length > 0) {
            contentByNodeId.set(nodeId, content);
          }
        }
      } catch {
        // Keep content unset
      }
    }

    const ensureProcess = (row: any, defaultPid: string): ProcessAgg => {
      const pid = String(row?.pid ?? row?.[1] ?? row?.[0] ?? defaultPid).trim() || defaultPid;
      if (!processMap.has(pid)) {
        processMap.set(pid, {
          id: pid,
          label: String(row?.label ?? row?.[2] ?? row?.[1] ?? ''),
          heuristicLabel: String(row?.heuristicLabel ?? row?.[3] ?? row?.[2] ?? ''),
          processType: String(row?.processType ?? row?.[4] ?? row?.[3] ?? ''),
          stepCount: toNonNegativeInteger(row?.stepCount ?? row?.[5] ?? row?.[4], 0),
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
          type: primaryNodeLabel(sym.type) || 'File',
          filePath: sym.filePath,
        });
        continue;
      }

      const nodeId = String(sym.nodeId || '').trim();
      const hitRank = item.mergedRank;
      const hitScore = item.score;

      const processRows = processRowsByNodeId.get(nodeId) || [];
      const cohesion = cohesionByNodeId.get(nodeId) || 0;
      const content = includeContent ? contentByNodeId.get(nodeId) : undefined;

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

    const testSeedIds = testSeedHits
      .map(seed => String(seed.data?.nodeId || '').trim())
      .filter(Boolean);
    const testSeedScoreById = new Map<string, { score: number; rank: number }>();
    for (const seed of testSeedHits) {
      const seedId = String(seed.data?.nodeId || '').trim();
      if (!seedId) continue;
      testSeedScoreById.set(seedId, { score: seed.score, rank: seed.mergedRank });
    }

    if (testSeedIds.length > 0) {
      let callRows: any[] = [];
      try {
        callRows = await executeQuery(repo.id, `
          MATCH (seed)-[r:CodeRelation {type: 'CALLS'}]->(m)
          WHERE seed.id IN ${buildCypherStringList(testSeedIds)}
          RETURN seed.id AS seedId,
                 m.id AS id,
                 m.name AS name,
                 m.filePath AS filePath,
                 m.startLine AS startLine,
                 m.endLine AS endLine,
                 r.confidence AS confidence,
                 r.reason AS reason
          ORDER BY r.confidence DESC
          LIMIT ${MAX_BRIDGE_TARGETS * Math.max(1, testSeedIds.length)}
        `);
      } catch { /* skip */ }

      for (const row of callRows) {
        const targetId = row.id ?? row[1];
        if (!targetId || typeof targetId !== 'string') continue;
        if (hitMeta.has(targetId)) continue;

        const filePath = row.filePath ?? row[3] ?? '';
        if (!filePath || typeof filePath !== 'string') continue;
        if (isTestFilePath(filePath)) continue;
        if (!isInScope(filePath)) continue;

        const confidenceRaw = row.confidence ?? row[6] ?? 0;
        const confidence = normalizeConfidence(confidenceRaw, 0);
        if (confidence < BRIDGE_MIN_CONFIDENCE) continue;

        const reason = row.reason ?? row[7] ?? '';
        if (typeof reason === 'string' && reason === 'fuzzy-global') continue;

        const seedId = String(row.seedId ?? row[0] ?? '').trim();
        const seedMeta = testSeedScoreById.get(seedId);
        if (!seedMeta) continue;
        const bridgeScore = seedMeta.score * 0.5 * confidence;

        const existing = bridgeTargets.get(targetId);
        if (existing && existing.score >= bridgeScore) continue;

        const labelEndIdx = targetId.indexOf(':');
        const type = labelEndIdx > 0 ? targetId.substring(0, labelEndIdx) : 'Unknown';

        bridgeTargets.set(targetId, {
          score: bridgeScore,
          seedRank: seedMeta.rank,
          data: {
            nodeId: targetId,
            name: row.name ?? row[2] ?? '',
            type,
            filePath,
            startLine: toOptionalLineNumber(row.startLine ?? row[4]),
            endLine: toOptionalLineNumber(row.endLine ?? row[5]),
          },
        });
      }
    }

    const bridgeTargetRowsByNodeId = new Map<string, any[]>();
    const bridgeTargetIds = Array.from(bridgeTargets.keys());
    if (bridgeTargetIds.length > 0) {
      const bridgeMembershipLimit = Math.max(200, Math.min(6000, bridgeTargetIds.length * 20));
      try {
        const bridgeRows = await executeQuery(repo.id, `
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE n.id IN ${buildCypherStringList(bridgeTargetIds)}
          RETURN n.id AS nodeId,
                 p.id AS pid,
                 p.label AS label,
                 p.heuristicLabel AS heuristicLabel,
                 p.processType AS processType,
                 p.stepCount AS stepCount,
                 r.step AS step
          LIMIT ${bridgeMembershipLimit}
        `);
        for (const row of bridgeRows) {
          const nodeId = String(row?.nodeId ?? row?.[0] ?? '').trim();
          if (!nodeId) continue;
          const list = bridgeTargetRowsByNodeId.get(nodeId) || [];
          list.push(row);
          bridgeTargetRowsByNodeId.set(nodeId, list);
        }
      } catch {
        // Keep fallback behavior (target ends in definitions if no process rows found).
      }
    }

    for (const target of bridgeTargets.values()) {
      const sym = target.data;
      const processRows = bridgeTargetRowsByNodeId.get(String(sym.nodeId || '').trim()) || [];

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
        hitCoverage: p.hitCount / Math.max(1, p.stepCount || 1),
        priority: p.totalScore +
          (p.cohesionBoost * 0.1) +
          (Math.min(1, p.hitCount / Math.max(1, p.stepCount || 1)) * 0.35) +
          (Number.isFinite(p.bestHitRank) ? (1 / (30 + p.bestHitRank)) : 0),
      }))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, processLimit);
    
    // Step 4: Fetch full process-step symbols (not only the direct search hits)
    const processSymbols: any[] = [];
    const symbolCountByProcess = new Map<string, number>();
    const stepRowsByProcessId = new Map<string, any[]>();
    const rankedProcessIds = rankedProcesses.map(proc => String(proc.id || '').trim()).filter(Boolean);
    if (rankedProcessIds.length > 0) {
      const contentProjection = includeContent ? ', n.content AS content' : '';
      const stepLimit = Math.max(200, Math.min(25000, rankedProcessIds.length * maxSymbolsPerProcess * 6));
      try {
        const stepRows = await executeQuery(repo.id, `
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE p.id IN ${buildCypherStringList(rankedProcessIds)}
          RETURN p.id AS processId,
                 n.id AS id,
                 n.name AS name,
                 n.filePath AS filePath,
                 n.startLine AS startLine,
                 n.endLine AS endLine${contentProjection},
                 r.step AS step
          ORDER BY p.id, r.step
          LIMIT ${stepLimit}
        `);
        for (const row of stepRows) {
          const pid = String(row?.processId ?? row?.[0] ?? '').trim();
          if (!pid) continue;
          const list = stepRowsByProcessId.get(pid) || [];
          list.push(row);
          stepRowsByProcessId.set(pid, list);
        }
      } catch {
        // Best-effort: keep empty process symbols if step extraction fails.
      }
    }

    for (const proc of rankedProcesses) {
      const stepRows = stepRowsByProcessId.get(String(proc.id || '').trim()) || [];
      const stepSymbols: any[] = [];
      for (const row of stepRows) {
        const nodeId = String(row?.id ?? row?.[1] ?? '').trim();
        if (!nodeId) continue;

        const labelEndIdx = nodeId.indexOf(':');
        const type = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';

        const stepRaw = row?.step ?? row?.[includeContent ? 7 : 6];
        const stepIndex = toOptionalNonNegativeInteger(stepRaw);

        const filePath = String(row?.filePath ?? row?.[3] ?? '').trim();
        if (!isInScope(filePath)) continue;

        stepSymbols.push({
          id: nodeId,
          name: String(row?.name ?? row?.[2] ?? ''),
          type,
          filePath,
          startLine: row?.startLine ?? row?.[4],
          endLine: row?.endLine ?? row?.[5],
          ...(includeContent ? { content: row?.content ?? row?.[6] } : {}),
          process_id: proc.id,
          step_index: stepIndex,
          ...(hitMeta.has(nodeId) ? { hit_rank: hitMeta.get(nodeId)!.rank } : {}),
        });
      }

      const selectedSteps = stepSymbols.slice(0, maxSymbolsPerProcess);
      if (selectedSteps.length < maxSymbolsPerProcess) {
        const selectedIds = new Set(selectedSteps.map(step => String(step?.id || '')));
        const rankedMandatory = stepSymbols
          .filter(step => hitMeta.has(String(step?.id || '')))
          .sort((left, right) => {
            const leftRank = toFiniteNumber(hitMeta.get(String(left?.id || ''))?.rank, Number.POSITIVE_INFINITY);
            const rightRank = toFiniteNumber(hitMeta.get(String(right?.id || ''))?.rank, Number.POSITIVE_INFINITY);
            if (leftRank !== rightRank) return leftRank - rightRank;
            const leftStep = toFiniteNumber(left?.step_index, Number.POSITIVE_INFINITY);
            const rightStep = toFiniteNumber(right?.step_index, Number.POSITIVE_INFINITY);
            return leftStep - rightStep;
          });
        for (const mandatoryStep of rankedMandatory) {
          const mandatoryId = String(mandatoryStep?.id || '');
          if (!mandatoryId || selectedIds.has(mandatoryId)) continue;
          selectedSteps.push(mandatoryStep);
          selectedIds.add(mandatoryId);
          if (selectedSteps.length >= maxSymbolsPerProcess) break;
        }
      } else {
        const selectedIds = new Set(selectedSteps.map(step => String(step?.id || '')));
        const rankedMandatory = stepSymbols
          .filter(step => hitMeta.has(String(step?.id || '')))
          .sort((left, right) => {
            const leftRank = toFiniteNumber(hitMeta.get(String(left?.id || ''))?.rank, Number.POSITIVE_INFINITY);
            const rightRank = toFiniteNumber(hitMeta.get(String(right?.id || ''))?.rank, Number.POSITIVE_INFINITY);
            if (leftRank !== rightRank) return leftRank - rightRank;
            const leftStep = toFiniteNumber(left?.step_index, Number.POSITIVE_INFINITY);
            const rightStep = toFiniteNumber(right?.step_index, Number.POSITIVE_INFINITY);
            return leftStep - rightStep;
          });
        for (const mandatoryStep of rankedMandatory) {
          const mandatoryId = String(mandatoryStep?.id || '');
          if (!mandatoryId || selectedIds.has(mandatoryId)) continue;
          let replaceIdx = -1;
          for (let i = selectedSteps.length - 1; i >= 0; i -= 1) {
            const existingId = String(selectedSteps[i]?.id || '');
            if (!hitMeta.has(existingId)) {
              replaceIdx = i;
              break;
            }
          }
          if (replaceIdx < 0) break;
          selectedIds.delete(String(selectedSteps[replaceIdx]?.id || ''));
          selectedSteps[replaceIdx] = mandatoryStep;
          selectedIds.add(mandatoryId);
        }
      }

      const limitedSteps = selectedSteps
        .sort((left, right) => {
          const leftStep = toFiniteNumber(left?.step_index, Number.POSITIVE_INFINITY);
          const rightStep = toFiniteNumber(right?.step_index, Number.POSITIVE_INFINITY);
          if (leftStep !== rightStep) return leftStep - rightStep;
          return String(left?.id || '').localeCompare(String(right?.id || ''));
        })
        .slice(0, maxSymbolsPerProcess);

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
              closureScore: toFiniteNumber(row.closureScore ?? row[6], 0),
              closureSlots: normalizeSliceStencilTokens(parseStringList(row.closureSlots)),
              closedSlots: normalizeSliceStencilTokens(parseStringList(row.closedSlots)),
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

          const startLine = toOptionalLineNumber(row.memberStartLine ?? row[13]);
          const endLine = toOptionalLineNumber(row.memberEndLine ?? row[14]);
          entry.members.set(memberId, {
            uid: memberId,
            name: memberName,
            kind: memberKind,
            filePath: memberFilePath,
            role: memberRole,
            score: memberScore,
            ...(startLine !== undefined ? { startLine } : {}),
            ...(endLine !== undefined ? { endLine } : {}),
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
                score: round3(member.score),
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
              closure_score: round3(slice.closureScore),
              closure_slots: slice.closureSlots,
              closed_slots: slice.closedSlots,
              member_count: slice.members.size,
              roles: Array.from(slice.roles).sort(),
              score: round3(slice.score),
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
        semantic_used: semanticContributedResults.length > 0,
        semantic_contributed_hits: semanticContributedResults.length,
        semantic_mode: semanticMode,
        semantic_mode_source: semanticPolicy.source,
        semantic_index_available: semanticIndexAvailable,
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
    return runQueryMode(
      {
        query: this.query.bind(this),
        precedents: this.precedents.bind(this),
        actionPlan: this.actionPlan.bind(this),
        parsePathPrefixes,
        clampInteger,
        toFiniteNumber,
      },
      repo,
      params,
    );
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
    return runImplementMode(
      {
        actionPlan: this.actionPlan.bind(this),
        queryMode: this.queryMode.bind(this),
        getIndexStatus: this.getIndexStatus.bind(this),
        parsePathPrefixes,
        clampInteger,
        normalizeRepoRelativePath,
        toFiniteNumber,
      },
      repo,
      params,
    );
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
    const scopeRaw = String(params.scope || 'unstaged').trim();
    const scope = scopeRaw.toLowerCase() as 'unstaged' | 'staged' | 'all' | 'compare';
    const allowedScopes = new Set(['unstaged', 'staged', 'all', 'compare']);
    if (!allowedScopes.has(scope)) {
      return { error: `scope must be one of unstaged|staged|all|compare (received "${scopeRaw}")` };
    }
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
      const startLine = toOptionalLineNumber(item?.startLine);
      const endLine = toOptionalLineNumber(item?.endLine);
      if (!uid && !filePath) return null;
      return {
        uid: uid || null,
        name: String(item?.name || '').trim() || '',
        kind: String(item?.kind || item?.type || '').trim() || '',
        filePath,
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
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
      const high = toFiniteNumber(gapSignals?.high, 0);
      const deterministic = toFiniteNumber(gapSignals?.deterministic, 0);
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

      const candidateScore = toFiniteNumber(candidates[0]?.score, 0);
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
    const limitFiles = clampInteger(params.limit_files, 10, 1, 50);
    const limitChecks = clampInteger(params.limit_checks, 10, 1, 20);
    const skipPrecedents = params.__skip_precedents === true;
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
    const isInScope = (filePath: string): boolean => filePathTouchesPrefixes(filePath, pathPrefixes);
    const toPrimaryLabel = (value: any): string => {
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
    };

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
      const stepIndex = toOptionalNonNegativeInteger(stepIndexRaw) ?? Number.POSITIVE_INFINITY;
      const stepWeight = Number.isFinite(stepIndex) && stepIndex >= 0 ? (1 / (1 + stepIndex)) : 0.1;

      const hitRankRaw = sym?.hit_rank;
      const hitRank = toFiniteNumber(hitRankRaw, Number.POSITIVE_INFINITY);
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
        type: toPrimaryLabel(r.type || r[2]),
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
      const seenCandidates = new Set<string>();
      for (const row of authRows) {
        const uid = row.uid || row[0];
        if (!uid || typeof uid !== 'string') continue;
        const type = toPrimaryLabel(row.type || row[2] || '');
        const edgeReason = String(row.reason || row[4] || '');
        const edgeConfidence = normalizeConfidence(row.confidence ?? row[5], 1.0);
        const candidateKey = `${uid}|${type}|${edgeReason}`;
        if (seenCandidates.has(candidateKey)) continue;
        seenCandidates.add(candidateKey);
        if (uid.startsWith('CodeElement:permission:')) {
          candidates.push({
            kind: 'permission_slug',
            uid,
            name: row.name || row[1] || '',
            type: 'CodeElement',
            filePath: row.filePath || row[3] || '',
            edge: {
              reason: edgeReason,
              confidence: edgeConfidence,
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
              reason: edgeReason,
              confidence: edgeConfidence,
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
              reason: edgeReason,
              confidence: edgeConfidence,
            },
          });
        }
      }

      const grants: any[] = [];
      const seen = new Set<string>();
      const roleRowsBySlugUid = new Map<string, any[]>();
      const slugRowsByConstUid = new Map<string, any[]>();
      const cypherStringList = (values: string[]): string => {
        if (values.length === 0) return '[]';
        return `[${values.map(value => `'${String(value || '').replace(/'/g, "''")}'`).join(', ')}]`;
      };

      const expandSlugToGrant = async (
        slugUid: string,
        evidence: { controller_edge: { reason: string; confidence: number }; via_policy?: any; },
        fallback?: { name?: string; filePath?: string },
      ): Promise<void> => {
        const slugEsc = slugUid.replace(/'/g, "''");
        let slug = String(fallback?.name || '').trim();
        let slugFilePath = String(fallback?.filePath || '').trim();
        if (!slug) {
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
          slug = String(slugRow?.name || '').trim();
          slugFilePath = String(slugRow?.filePath || '').trim();
          if (!slug) return;
        }

        const key = `${slugUid}:${slug}`;
        if (seen.has(key)) return;
        seen.add(key);

        const slugNode = await normalizeNode(slugUid, {
          id: slugUid,
          name: slug,
          type: 'CodeElement',
          filePath: slugFilePath,
        });

        let roleRows = roleRowsBySlugUid.get(slugUid);
        if (!roleRows) {
          roleRows = [];
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
          roleRowsBySlugUid.set(slugUid, roleRows);
        }

        const roles: any[] = [];
        const roleSeen = new Set<string>();
        for (const roleRow of roleRows) {
          const roleUid = roleRow.uid || roleRow[0];
          if (!roleUid || typeof roleUid !== 'string') continue;
          if (roleSeen.has(roleUid)) continue;
          roleSeen.add(roleUid);
          roles.push({
            uid: roleUid,
            name: roleRow.name || roleRow[1] || '',
            filePath: roleRow.filePath || roleRow[2] || '',
            reason: roleRow.reason || roleRow[3] || '',
            confidence: normalizeConfidence(roleRow.confidence ?? roleRow[4], 1.0),
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
            filePath: slugFilePath,
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
        let slugRows = slugRowsByConstUid.get(constUid);
        if (!slugRows) {
          slugRows = [];
          try {
            slugRows = await executeQuery(repo.id, `
              MATCH (c {id: '${constEscaped}'})-[r:CodeRelation {type: 'CALLS'}]->(s:CodeElement)
              WHERE r.reason STARTS WITH 'laravel-permission-slug:'
              RETURN s.id AS uid, s.name AS name, s.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
              ORDER BY r.confidence DESC
              LIMIT 2
            `);
          } catch {
            slugRows = [];
          }
          slugRowsByConstUid.set(constUid, slugRows);
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
            confidence: normalizeConfidence(slugRow.confidence ?? slugRow[4], 1.0),
          };

          let roleRows = roleRowsBySlugUid.get(slugUid);
          if (!roleRows) {
            roleRows = [];
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
            roleRowsBySlugUid.set(slugUid, roleRows);
          }

          const roles: any[] = [];
          const roleSeen = new Set<string>();
          for (const roleRow of roleRows) {
            const roleUid = roleRow.uid || roleRow[0];
            if (!roleUid || typeof roleUid !== 'string') continue;
            if (roleSeen.has(roleUid)) continue;
            roleSeen.add(roleUid);
            roles.push({
              uid: roleUid,
              name: roleRow.name || roleRow[1] || '',
              filePath: roleRow.filePath || roleRow[2] || '',
              reason: roleRow.reason || roleRow[3] || '',
              confidence: normalizeConfidence(roleRow.confidence ?? roleRow[4], 1.0),
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

      const constRowsByPolicyUid = new Map<string, any[]>();
      const policyCandidates = candidates.filter(candidate => candidate.kind === 'policy_method');
      if (policyCandidates.length > 0) {
        try {
          const policyIds = Array.from(new Set(policyCandidates.map(candidate => String(candidate.uid || '').trim()).filter(Boolean)));
          const policyRows = await executeQuery(repo.id, `
            MATCH (p)-[r:CodeRelation {type: 'CALLS'}]->(c:Const)
            WHERE p.id IN ${cypherStringList(policyIds)}
              AND r.confidence >= 0.9
              AND r.reason STARTS WITH 'php-match-return:'
            RETURN p.id AS policyUid, c.id AS uid, c.name AS name, c.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
            ORDER BY r.confidence DESC
            LIMIT ${Math.max(80, Math.min(4000, policyIds.length * 20))}
          `);
          for (const row of policyRows) {
            const policyUid = String(row.policyUid || row[0] || '').trim();
            if (!policyUid) continue;
            const list = constRowsByPolicyUid.get(policyUid) || [];
            list.push({
              uid: row.uid || row[1],
              name: row.name || row[2],
              filePath: row.filePath || row[3],
              reason: row.reason || row[4],
              confidence: normalizeConfidence(row.confidence ?? row[5], 1.0),
            });
            constRowsByPolicyUid.set(policyUid, list);
          }
        } catch {
          // best-effort policy expansion
        }
      }

      for (const candidate of candidates) {
        if (candidate.kind === 'permission_slug') {
          await expandSlugToGrant(candidate.uid, {
            controller_edge: candidate.edge,
          }, {
            name: candidate.name,
            filePath: candidate.filePath,
          });
          continue;
        }

        if (candidate.kind === 'enum_case') {
          await expandConstToGrant(candidate.uid, { controller_edge: candidate.edge });
          continue;
        }

        // Policy method: attempt to derive permission enum cases deterministically via match-return edges.
        const constRows = constRowsByPolicyUid.get(candidate.uid) || [];

        for (const row of constRows) {
          const constUid = row.uid || row[0];
          if (!constUid || typeof constUid !== 'string') continue;
          const matchEdge = {
            reason: String(row.reason || row[3] || ''),
            confidence: normalizeConfidence(row.confidence ?? row[4], 1.0),
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
    const endpointWiringCache = new Map<string, { reason: string; confidence: number } | null>();
    const controllerGrantCache = new Map<string, any[]>();

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

      const endpointEdgeKey = `${opts.endpointUid}|${opts.controllerUid}`;
      let endpointEdge = endpointWiringCache.get(endpointEdgeKey);
      if (endpointEdge === undefined) {
        const endpointEsc = opts.endpointUid.replace(/'/g, "''");
        const controllerEsc = opts.controllerUid.replace(/'/g, "''");
        let resolved: { reason: string; confidence: number } | null = null;
        try {
          const rows = await executeQuery(repo.id, `
            MATCH (e {id: '${endpointEsc}'})-[r:CodeRelation {type: 'CALLS'}]->(c {id: '${controllerEsc}'})
            WHERE r.reason STARTS WITH 'laravel-endpoint:'
            RETURN r.reason AS reason, r.confidence AS confidence
            ORDER BY r.confidence DESC
            LIMIT 1
          `);
          if (rows.length > 0) {
            resolved = {
              reason: rows[0].reason || rows[0][0] || '',
              confidence: normalizeConfidence(rows[0].confidence ?? rows[0][1], 1.0),
            };
          }
        } catch { /* ignore */ }
        endpointWiringCache.set(endpointEdgeKey, resolved);
        endpointEdge = resolved;
      }

      if (!controllerGrantCache.has(opts.controllerUid)) {
        controllerGrantCache.set(opts.controllerUid, await buildPermissionGrantsForController(opts.controllerUid));
      }
      const grants = controllerGrantCache.get(opts.controllerUid) || [];

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

    const hopWork: Array<() => Promise<void>> = [];

    const preloadControllerGrants = async (controllerIds: string[]): Promise<void> => {
      const uniqueControllerIds = Array.from(new Set(
        controllerIds
          .map(uid => String(uid || '').trim())
          .filter(Boolean),
      ));
      if (uniqueControllerIds.length === 0) return;
      await Promise.all(uniqueControllerIds.map(async (controllerUid) => {
        if (controllerGrantCache.has(controllerUid)) return;
        controllerGrantCache.set(controllerUid, await buildPermissionGrantsForController(controllerUid));
      }));
    };

    const buildFromController = async (controllerUid: string): Promise<void> => {
      const escaped = controllerUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui)-[rHttp:CodeRelation {type: 'CALLS'}]->(c {id: '${escaped}'})
          WHERE rHttp.confidence >= 0.9 AND rHttp.reason STARTS WITH 'http-'
          MATCH (ui)-[rEndpoint:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE rEndpoint.confidence >= 0.9
            AND rEndpoint.reason = rHttp.reason
            AND e.name STARTS WITH 'endpoint:'
          RETURN ui.id AS uiUid,
                 e.id AS endpointUid,
                 rHttp.reason AS reason,
                 CASE WHEN rHttp.confidence >= rEndpoint.confidence THEN rHttp.confidence ELSE rEndpoint.confidence END AS confidence
          ORDER BY confidence DESC
          LIMIT 10
        `);
      } catch {
        return;
      }

      for (const row of rows) {
        if (hops.length >= hopLimit) return;
        const uiUid = row.uiUid || row[0];
        const endpointUid = row.endpointUid || row[1];
        const reason = row.reason || row[2];
        const confidence = normalizeConfidence(row.confidence ?? row[3], 1.0);
        if (!uiUid || typeof uiUid !== 'string') continue;
        if (!endpointUid || typeof endpointUid !== 'string') continue;
        if (!reason || typeof reason !== 'string') continue;

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
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui)-[rHttp:CodeRelation {type: 'CALLS'}]->(e {id: '${escaped}'})
          WHERE rHttp.confidence >= 0.9 AND rHttp.reason STARTS WITH 'http-'
          MATCH (e)-[rEndpoint:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE rEndpoint.reason STARTS WITH 'laravel-endpoint:' AND rEndpoint.confidence >= 0.9
          RETURN ui.id AS uiUid,
                 c.id AS controllerUid,
                 rHttp.reason AS reason,
                 CASE WHEN rHttp.confidence >= rEndpoint.confidence THEN rHttp.confidence ELSE rEndpoint.confidence END AS confidence
          ORDER BY confidence DESC
          LIMIT 20
        `);
      } catch {
        return;
      }

      for (const row of rows) {
        if (hops.length >= hopLimit) return;
        const uiUid = row.uiUid || row[0];
        const controllerUid = row.controllerUid || row[1];
        const reason = row.reason || row[2];
        const confidence = normalizeConfidence(row.confidence ?? row[3], 1.0);
        if (!uiUid || typeof uiUid !== 'string') continue;
        if (!controllerUid || typeof controllerUid !== 'string') continue;
        if (!reason || typeof reason !== 'string') continue;

        await tryAddHop({
          uiUid,
          endpointUid,
          controllerUid,
          http: { reason, confidence },
        });
      }
    };

    const buildFromUi = async (uiUid: string): Promise<void> => {
      const escaped = uiUid.replace(/'/g, "''");
      let rows: any[] = [];
      try {
        rows = await executeQuery(repo.id, `
          MATCH (ui {id: '${escaped}'})-[rHttp:CodeRelation {type: 'CALLS'}]->(e:CodeElement)
          WHERE rHttp.confidence >= 0.9 AND rHttp.reason STARTS WITH 'http-' AND e.name STARTS WITH 'endpoint:'
          MATCH (e)-[rEndpoint:CodeRelation {type: 'CALLS'}]->(c:Method)
          WHERE rEndpoint.reason STARTS WITH 'laravel-endpoint:' AND rEndpoint.confidence >= 0.9
          RETURN e.id AS endpointUid,
                 c.id AS controllerUid,
                 rHttp.reason AS reason,
                 CASE WHEN rHttp.confidence >= rEndpoint.confidence THEN rHttp.confidence ELSE rEndpoint.confidence END AS confidence
          ORDER BY confidence DESC
          LIMIT 20
        `);
      } catch {
        return;
      }

      for (const row of rows) {
        if (hops.length >= hopLimit) return;
        const endpointUid = row.endpointUid || row[0];
        const controllerUid = row.controllerUid || row[1];
        const reason = row.reason || row[2];
        const confidence = normalizeConfidence(row.confidence ?? row[3], 1.0);
        if (!endpointUid || typeof endpointUid !== 'string') continue;
        if (!controllerUid || typeof controllerUid !== 'string') continue;
        if (!reason || typeof reason !== 'string') continue;

        await tryAddHop({
          uiUid,
          endpointUid,
          controllerUid,
          http: { reason, confidence },
        });
      }
    };

    if (controllerCandidates.length > 0) {
      await preloadControllerGrants(controllerCandidates);
      for (const controllerUid of controllerCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(() => buildFromController(controllerUid));
      }
    } else if (endpointCandidates.length > 0) {
      for (const endpointUid of endpointCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(() => buildFromEndpoint(endpointUid));
      }
    } else {
      for (const uiUid of uiCandidates) {
        if (hops.length >= hopLimit) break;
        hopWork.push(() => buildFromUi(uiUid));
      }
    }

    try {
      for (const work of hopWork) {
        if (hops.length >= hopLimit) break;
        await work();
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
        const resolved = resolvePathInsideRepo(repo.repoPath, filePath);
        if (!resolved) continue;
        let content: string;
        try {
          content = await fs.readFile(resolved.absolutePath, 'utf-8');
        } catch {
          continue;
        }

        const card = await extractUiContractCard(resolved.relativePath, content);
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
            confidence: normalizeConfidence(c?.confidence, 0.35),
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

      const nextScore = toFiniteNumber(score, 0);
      if (nextScore <= 0) return;

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
      addCompanionSignal(
        String(file?.filePath || ''),
        toFiniteNumber(file?.score, 0) + 0.1,
        'ranked-file',
      );
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
          const startLine = toOptionalLineNumber(row.startLine ?? row[4]);
          const endLine = toOptionalLineNumber(row.endLine ?? row[5]);

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
              ...(startLine !== undefined ? { startLine } : {}),
              ...(endLine !== undefined ? { endLine } : {}),
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
            const confidence = toFiniteNumber(row.confidence ?? row[1], 0);
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
            const count = toFiniteNumber(row.count ?? row[2], 0);
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
              const requiredSlots = normalizeSliceStencilTokens(parseStringList(template.requiredSlots));
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
              const requiredSlots = normalizeSliceStencilTokens(parseStringList(best.requiredSlots));
              const roleExpectations = Array.isArray(best.roleCoverage)
                ? best.roleCoverage
                  .map((item: any) => ({
                    role: String(item?.role || '').trim(),
                    coverage: toFiniteNumber(item?.coverage, 0),
                    count: toFiniteNumber(item?.count, 0),
                  }))
                  .filter((item: any) => item.role)
                : [];

              targetTemplate = {
                id: String(best.id || '').trim(),
                template_key: String(best.templateKey || '').trim(),
                slice_type: String(best.sliceType || '').trim(),
                required_slots: requiredSlots,
                optional_slots: normalizeSliceStencilTokens(parseStringList(best.optionalSlots)),
                role_expectations: roleExpectations,
                avg_closure_score: toFiniteNumber(best.avgClosureScore, 0),
                slice_count: toFiniteNumber(best.sliceCount, 0),
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
        score: round3(entry.score),
        reasons: Array.from(entry.reasons).slice(0, 6),
        anchors: entry.anchors.slice(0, 4),
      }));

    const orderedWriteSteps = writeOrder
      .sort((left, right) => {
        if (left.role_priority !== right.role_priority) return left.role_priority - right.role_priority;
        const leftStart = toFiniteNumber(left.startLine, Number.MAX_SAFE_INTEGER);
        const rightStart = toFiniteNumber(right.startLine, Number.MAX_SAFE_INTEGER);
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
      const safeLimit = clampInteger(limit, 50, 1, 500);
      const scoreMap = new Map<string, { score: number; bm25Score: number; data: any }>();
      const isSingleToken = !/\s/.test(query);
      const looksLikeIdentifier = isSingleToken && /^[A-Za-z_][$A-Za-z0-9_:/.-]*$/.test(query.trim());
      const tables: Array<{ table: string; index: string }> = [
        { table: 'Method', index: 'method_fts' },
        { table: 'Function', index: 'function_fts' },
        { table: 'Class', index: 'class_fts' },
        { table: 'Interface', index: 'interface_fts' },
        { table: 'CodeElement', index: 'codeelement_fts' },
        { table: 'Const', index: 'const_fts' },
        { table: 'File', index: 'file_fts' },
      ].filter(item => !(looksLikeIdentifier && item.table === 'File'));

      const tableRows = await Promise.all(
        tables.map(async ({ table, index }) => {
          try {
            const rows = await executeQuery(repo.id, `
              CALL QUERY_FTS_INDEX('${table}', '${index}', '${escapedQuery}', conjunctive := false)
              RETURN node, score
              ORDER BY score DESC
              LIMIT ${safeLimit}
            `);
            return { table, rows };
          } catch {
            // Index may not exist (older DB) — treat as empty.
            return { table, rows: [] as any[] };
          }
        }),
      );

      for (const { table, rows } of tableRows) {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const node = row.node || row[0] || {};
          const nodeId = node.id || node.nodeId || '';
          if (!nodeId) continue;

          const rrfScore = 1 / (60 + i + 1); // rank starts at 1
          const bm25ScoreRaw = row.score ?? row[1] ?? 0;
          const bm25Score = toFiniteNumber(bm25ScoreRaw, 0);

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
                startLine: toOptionalLineNumber(node.startLine),
                endLine: toOptionalLineNumber(node.endLine),
              }
            });
          }
        }
      }

      return Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, safeLimit)
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
      const safeLimit = clampInteger(limit, 50, 1, 500);
      const queryVec = await embedQuery(query);
      const dims = getEmbeddingDims();
      const queryVecStr = `[${queryVec.join(',')}]`;
      
      const vectorQuery = `
        CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 
          CAST(${queryVecStr} AS FLOAT[${dims}]), ${safeLimit})
        YIELD node AS emb, distance
        WITH emb, distance
        WHERE distance < 0.6
        RETURN emb.nodeId AS nodeId, distance
        ORDER BY distance
      `;
      
      const embResults = await executeQuery(repo.id, vectorQuery);
      
      if (embResults.length === 0) return [];
      
      const orderedCandidates: Array<{ nodeId: string; label: string; distance: number }> = [];
      const idsByLabel = new Map<string, Set<string>>();
      for (const embRow of embResults) {
        const nodeIdRaw = embRow.nodeId ?? embRow[0];
        const nodeId = typeof nodeIdRaw === 'string' ? nodeIdRaw : String(nodeIdRaw || '');
        if (!nodeId) continue;
        const distanceRaw = embRow.distance ?? embRow[1];
        const distance = toFiniteNumber(distanceRaw, 0);

        const labelEndIdx = nodeId.indexOf(':');
        const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
        if (!VALID_NODE_LABELS.has(label)) continue;

        orderedCandidates.push({ nodeId, label, distance });
        const ids = idsByLabel.get(label) || new Set<string>();
        ids.add(nodeId);
        idsByLabel.set(label, ids);
      }
      if (orderedCandidates.length === 0) return [];
      const toCypherStringList = (values: string[]): string => {
        const escaped = values
          .map(value => String(value || '').trim())
          .filter(Boolean)
          .map(value => `'${value.replace(/'/g, "''")}'`);
        return escaped.length > 0 ? `[${escaped.join(', ')}]` : '[]';
      };

      const rowByNodeId = new Map<string, any>();
      for (const [label, idSet] of idsByLabel.entries()) {
        const ids = Array.from(idSet);
        if (ids.length === 0) continue;
        const idList = toCypherStringList(ids);
        const labelRef = label === 'File' ? 'File' : `\`${label}\``;
        const projection = label === 'File'
          ? 'n.id AS nodeId, n.name AS name, n.filePath AS filePath'
          : 'n.id AS nodeId, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine';

        let rows: any[] = [];
        try {
          rows = await executeQuery(repo.id, `
            MATCH (n:${labelRef})
            WHERE n.id IN ${idList}
            RETURN ${projection}
          `);
        } catch {
          continue;
        }
        for (const row of rows) {
          const rowNodeId = String(row.nodeId ?? row[0] ?? '').trim();
          if (!rowNodeId) continue;
          rowByNodeId.set(rowNodeId, row);
        }
      }

      const results: any[] = [];
      const seen = new Set<string>();
      for (const candidate of orderedCandidates) {
        if (seen.has(candidate.nodeId)) continue;
        const row = rowByNodeId.get(candidate.nodeId);
        if (!row) continue;
        results.push({
          nodeId: candidate.nodeId,
          name: row.name ?? row[1] ?? '',
          type: candidate.label,
          filePath: row.filePath ?? row[2] ?? '',
          distance: candidate.distance,
          startLine: candidate.label !== 'File' ? (row.startLine ?? row[3]) : undefined,
          endLine: candidate.label !== 'File' ? (row.endLine ?? row[4]) : undefined,
        });
        seen.add(candidate.nodeId);
      }

      return results.slice(0, safeLimit);
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

    const resolvedPath = resolvePathInsideRepo(repo.repoPath, rawPath);
    if (!resolvedPath) {
      return { error: `file_path must be inside the repo (${repo.repoPath})` };
    }
    const relativePath = resolvedPath.relativePath;
    const fullPath = resolvedPath.absolutePath;

    let content: string;
    try {
      content = await fs.readFile(fullPath, 'utf-8');
    } catch (err: any) {
      return { error: `Unable to read file: ${relativePath} (${err?.message || 'unknown error'})` };
    }

    const card = await extractUiContractCard(relativePath, content);

    const includeEndpoints = params.include_endpoints !== false;
    const minHttpConfidence = normalizeConfidence(params.min_http_confidence, 0.9);
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);

    let endpoints: any[] = [];
    if (includeEndpoints) {
      await this.ensureInitialized(repo.id);

      const fileEsc = relativePath.replace(/'/g, "''");
      const conf = minHttpConfidence;

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
          http: {
            reason: row.reason ?? row[8] ?? '',
            confidence: normalizeConfidence(row.confidence ?? row[9], 1.0),
          },
          surface: {
            uid: row.surfaceId ?? row[0] ?? '',
            name: row.surfaceName ?? row[1] ?? '',
            filePath: row.surfaceFilePath ?? row[2] ?? '',
            startLine: toOptionalLineNumber(row.surfaceStartLine ?? row[3]),
          },
          http_caller: {
            uid: row.httpCallerId ?? row[4] ?? '',
            name: row.httpCallerName ?? row[5] ?? '',
            filePath: row.httpCallerFilePath ?? row[6] ?? '',
            startLine: toOptionalLineNumber(row.httpCallerStartLine ?? row[7]),
          },
          controller: {
            uid: row.controllerId ?? row[10] ?? '',
            name: (() => {
              const base = row.controllerName ?? row[11] ?? '';
              const cls = row.controllerClassName ?? row[14] ?? '';
              return cls && base ? `${cls}::${base}` : base;
            })(),
            filePath: row.controllerFilePath ?? row[12] ?? '',
            startLine: toOptionalLineNumber(row.controllerStartLine ?? row[13]),
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
    return runReviewMode(
      {
        ensureInitialized: this.ensureInitialized.bind(this),
        getIndexStatus: this.getIndexStatus.bind(this),
        uiContract: this.uiContract.bind(this),
        executeQuery,
        parseWitnessPathIds,
        loadRuntimeObservationSnapshot,
        resolvePathInsideRepo,
        isTestFilePath,
        classifyToolingArtifactPath,
        clampInteger,
        toFiniteNumber,
        toNonNegativeInteger,
        toOptionalLineNumber,
        toOptionalNonNegativeInteger,
        primaryNodeLabel,
        parseStringList,
        normalizeSliceStencilTokens,
        missingRequiredSlotSeverity,
        GIT_NAME_LIST_MAX_BUFFER,
        GIT_PATCH_MAX_BUFFER,
      },
      repo,
      params,
    );
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
    runtime_observations?: unknown;
  }): Promise<any> {
    const queryText = String(params.query || '').trim();
    const symptomText = String(params.symptom || '').trim();
    const failingTests = this.toStringArray(params.failing_tests);
    const errorStrings = this.toStringArray(params.error_strings);
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
    const limitCandidates = clampInteger(params.limit_candidates, 8, 1, 30);
    const limitHops = clampInteger(params.limit_hops, 6, 1, 20);
    const includePrecedents = params.include_precedents !== false;

    const normalizeNumber = (
      value: unknown,
      fallback = 0,
      minValue = 0,
      maxValue = Number.POSITIVE_INFINITY,
    ): number => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.max(minValue, Math.min(maxValue, parsed));
    };

    const normalizeSqlSignature = (sql: string): string => {
      const normalized = String(sql || '')
        .toLowerCase()
        .replace(/'[^']*'/g, '?')
        .replace(/"[^"]*"/g, '?')
        .replace(/\b\d+\b/g, '?')
        .replace(/\s+/g, ' ')
        .trim();
      return normalized.slice(0, 240);
    };
    const normalizeObservedRoute = (value: string): string => {
      let raw = String(value || '').trim();
      if (!raw) return '';
      if (/^https?:\/\//i.test(raw)) {
        try {
          raw = new URL(raw).pathname || raw;
        } catch {
          // keep original
        }
      }
      raw = raw.split('?')[0].split('#')[0];
      try {
        raw = decodeURIComponent(raw);
      } catch {
        // keep original
      }
      raw = raw.replace(/\/{2,}/g, '/');
      if (!raw.startsWith('/')) raw = `/${raw}`;
      return raw.replace(/\/+$/, '') || '/';
    };

    const normalizeRuntimeObservations = (value: unknown): {
      request_spans: Array<{
        method?: string;
        route?: string;
        duration_ms: number;
        status?: number;
        payload_bytes?: number;
        trace_id?: string;
      }>;
      db_queries: Array<{
        sql?: string;
        route?: string;
        method?: string;
        duration_ms: number;
        rows_examined?: number;
        lock_wait_ms?: number;
        count?: number;
        explain_plan?: string;
      }>;
      payload_shapes: Array<{
        path?: string;
        item_count?: number;
        bytes?: number;
        keys?: string[];
      }>;
    } => {
      const raw = (value && typeof value === 'object') ? (value as any) : {};
      const requestSpansRaw = Array.isArray(raw.request_spans)
        ? raw.request_spans
        : Array.isArray(raw.requestSpans)
          ? raw.requestSpans
          : [];
      const dbQueriesRaw = Array.isArray(raw.db_queries)
        ? raw.db_queries
        : Array.isArray(raw.dbQueries)
          ? raw.dbQueries
          : [];
      const payloadShapesRaw = Array.isArray(raw.payload_shapes)
        ? raw.payload_shapes
        : Array.isArray(raw.payloadShapes)
          ? raw.payloadShapes
          : [];

      const request_spans = requestSpansRaw
        .map((item: any) => ({
          method: String(item?.method || '').trim().toUpperCase() || undefined,
          route: (() => {
            const normalized = normalizeObservedRoute(String(item?.route || item?.path || '').trim());
            return normalized || undefined;
          })(),
          duration_ms: normalizeNumber(item?.duration_ms ?? item?.durationMs, 0, 0, 60_000),
          status: (() => {
            const status = toOptionalNonNegativeInteger(item?.status);
            if (status === undefined) return undefined;
            return status >= 100 && status <= 599 ? status : undefined;
          })(),
          payload_bytes: toOptionalFiniteNumber(item?.payload_bytes ?? item?.payloadBytes) !== undefined
            ? normalizeNumber(item?.payload_bytes ?? item?.payloadBytes, 0, 0, 20_000_000)
            : undefined,
          trace_id: String(item?.trace_id || item?.traceId || '').trim() || undefined,
        }))
        .filter((item: any) => item.duration_ms > 0)
        .slice(0, 200);

      const db_queries = dbQueriesRaw
        .map((item: any) => ({
          sql: String(item?.sql || item?.query || '').trim() || undefined,
          route: (() => {
            const normalized = normalizeObservedRoute(String(item?.route || item?.path || '').trim());
            return normalized || undefined;
          })(),
          method: String(item?.method || '').trim().toUpperCase() || undefined,
          duration_ms: normalizeNumber(item?.duration_ms ?? item?.durationMs, 0, 0, 60_000),
          rows_examined: toOptionalFiniteNumber(item?.rows_examined ?? item?.rowsExamined) !== undefined
            ? normalizeNumber(item?.rows_examined ?? item?.rowsExamined, 0, 0, 1_000_000_000)
            : undefined,
          lock_wait_ms: toOptionalFiniteNumber(item?.lock_wait_ms ?? item?.lockWaitMs) !== undefined
            ? normalizeNumber(item?.lock_wait_ms ?? item?.lockWaitMs, 0, 0, 60_000)
            : undefined,
          count: toOptionalFiniteNumber(item?.count) !== undefined
            ? normalizeNumber(item?.count, 1, 0, 1_000_000)
            : undefined,
          explain_plan: String(item?.explain_plan || item?.explainPlan || '').trim() || undefined,
        }))
        .filter((item: any) => item.duration_ms > 0 || (item.sql && item.sql.length > 0))
        .slice(0, 500);

      const payload_shapes = payloadShapesRaw
        .map((item: any) => {
          const keys = Array.isArray(item?.keys)
            ? item.keys.map((entry: any) => String(entry || '').trim()).filter(Boolean).slice(0, 20)
            : [];
          return {
            path: (() => {
              const normalized = normalizeObservedRoute(String(item?.path || item?.route || '').trim());
              return normalized || undefined;
            })(),
            item_count: toOptionalFiniteNumber(item?.item_count ?? item?.itemCount) !== undefined
              ? normalizeNumber(item?.item_count ?? item?.itemCount, 0, 0, 5_000_000)
              : undefined,
            bytes: toOptionalFiniteNumber(item?.bytes ?? item?.payload_bytes ?? item?.payloadBytes) !== undefined
              ? normalizeNumber(item?.bytes ?? item?.payload_bytes ?? item?.payloadBytes, 0, 0, 20_000_000)
              : undefined,
            keys,
          };
        })
        .filter((item: any) => item.path || item.item_count || item.bytes)
        .slice(0, 200);

      return {
        request_spans,
        db_queries,
        payload_shapes,
      };
    };

    const mergeRuntimeObservations = (
      primary: ReturnType<typeof normalizeRuntimeObservations>,
      secondary: ReturnType<typeof normalizeRuntimeObservations>,
    ): ReturnType<typeof normalizeRuntimeObservations> => {
      const requestByKey = new Map<string, any>();
      const dbByKey = new Map<string, any>();
      const payloadByKey = new Map<string, any>();

      const addRequestSpan = (item: any) => {
        const key = `${item?.method || ''}|${item?.route || ''}|${item?.status || ''}`;
        const existing = requestByKey.get(key);
        if (!existing) {
          requestByKey.set(key, item);
          return;
        }
        requestByKey.set(key, {
          ...existing,
          duration_ms: Math.max(toFiniteNumber(existing.duration_ms, 0), toFiniteNumber(item.duration_ms, 0)),
          payload_bytes: Math.max(toFiniteNumber(existing.payload_bytes, 0), toFiniteNumber(item.payload_bytes, 0)),
          trace_id: existing.trace_id || item.trace_id,
        });
      };
      const addDbQuery = (item: any) => {
        const signature = normalizeSqlSignature(String(item?.sql || ''));
        const key = `${signature}|${String(item?.route || '')}`;
        const existing = dbByKey.get(key);
        if (!existing) {
          dbByKey.set(key, {
            ...item,
            count: Math.max(1, toFiniteNumber(item?.count, 1)),
          });
          return;
        }
        dbByKey.set(key, {
          ...existing,
          duration_ms: Math.max(toFiniteNumber(existing.duration_ms, 0), toFiniteNumber(item.duration_ms, 0)),
          lock_wait_ms: Math.max(toFiniteNumber(existing.lock_wait_ms, 0), toFiniteNumber(item.lock_wait_ms, 0)),
          rows_examined: Math.max(toFiniteNumber(existing.rows_examined, 0), toFiniteNumber(item.rows_examined, 0)),
          count: toFiniteNumber(existing.count, 1) + Math.max(1, toFiniteNumber(item.count, 1)),
          explain_plan: existing.explain_plan || item.explain_plan,
        });
      };
      const addPayloadShape = (item: any) => {
        const key = String(item?.path || '').trim();
        if (!key) return;
        const existing = payloadByKey.get(key);
        if (!existing) {
          payloadByKey.set(key, item);
          return;
        }
        payloadByKey.set(key, {
          ...existing,
          item_count: Math.max(toFiniteNumber(existing.item_count, 0), toFiniteNumber(item.item_count, 0)),
          bytes: Math.max(toFiniteNumber(existing.bytes, 0), toFiniteNumber(item.bytes, 0)),
          keys: Array.from(new Set([
            ...(Array.isArray(existing.keys) ? existing.keys : []),
            ...(Array.isArray(item.keys) ? item.keys : []),
          ])).slice(0, 20),
        });
      };

      for (const item of primary.request_spans) addRequestSpan(item);
      for (const item of secondary.request_spans) addRequestSpan(item);
      for (const item of primary.db_queries) addDbQuery(item);
      for (const item of secondary.db_queries) addDbQuery(item);
      for (const item of primary.payload_shapes) addPayloadShape(item);
      for (const item of secondary.payload_shapes) addPayloadShape(item);

      const request_spans = Array.from(requestByKey.values());
      const db_queries = Array.from(dbByKey.values());
      const payload_shapes = Array.from(payloadByKey.values());
      return {
        request_spans: request_spans.slice(0, 500),
        db_queries: db_queries.slice(0, 1000),
        payload_shapes: payload_shapes.slice(0, 500),
      };
    };

    const runtimeObservationPaths = parseStringList(process.env.GITNEXUS_RUNTIME_OBSERVATIONS_FILE || '');
    const runtimeSnapshot = await loadRuntimeObservationSnapshot(repo.storagePath, {
      repoPath: repo.repoPath,
      extraPaths: runtimeObservationPaths,
    });
    const runtimeFromParams = normalizeRuntimeObservations((params as any).runtime_observations);
    const runtimeFromSnapshot = normalizeRuntimeObservations(runtimeSnapshot);
    const runtimeObservations = mergeRuntimeObservations(runtimeFromParams, runtimeFromSnapshot);
    const hasRuntimeObservations = runtimeObservations.request_spans.length > 0
      || runtimeObservations.db_queries.length > 0
      || runtimeObservations.payload_shapes.length > 0;
    const runtimeObservationSource = runtimeFromParams.request_spans.length > 0
      || runtimeFromParams.db_queries.length > 0
      || runtimeFromParams.payload_shapes.length > 0
      ? (runtimeFromSnapshot.request_spans.length > 0 || runtimeFromSnapshot.db_queries.length > 0 || runtimeFromSnapshot.payload_shapes.length > 0
        ? 'params+snapshot'
        : 'params')
      : (runtimeFromSnapshot.request_spans.length > 0 || runtimeFromSnapshot.db_queries.length > 0 || runtimeFromSnapshot.payload_shapes.length > 0
        ? 'snapshot'
        : 'none');

    const seedQuery = queryText || symptomText || failingTests[0] || errorStrings[0] || '';
    if (!seedQuery.trim()) {
      return { error: 'Provide at least one of query, symptom, failing_tests, or error_strings.' };
    }

    const classifySymptom = (value: string): {
      family: 'auth' | 'cache' | 'shape' | 'routing' | 'event' | 'performance' | 'unknown';
      normalized: string;
      matched_tokens: string[];
      confidence: number;
      secondary_families: string[];
    } => {
      const normalized = String(value || '').trim().toLowerCase();
      const tokenMap: Array<{ family: 'auth' | 'cache' | 'shape' | 'routing' | 'event' | 'performance'; tokens: string[] }> = [
        { family: 'auth', tokens: ['403', 'forbidden', 'unauthorized', 'permission', 'authorize', 'auth', 'policy', 'can('] },
        { family: 'cache', tokens: ['stale', 'cache', 'invalidate', 'refetch', 'query key', 'setquerydata', 'missing update'] },
        { family: 'shape', tokens: ['field', 'payload', 'serialize', 'validation', 'null', 'undefined', 'wrong field'] },
        { family: 'routing', tokens: ['route', '404', 'endpoint', 'controller', 'path', 'url', 'method not allowed'] },
        { family: 'event', tokens: ['queue', 'event', 'listener', 'job', 'broadcast'] },
        { family: 'performance', tokens: ['timeout', 'timed out', 'slow', 'latency', 'performance', 'n+1', 'lock wait', 'deadlock', 'rows examined', 'explain'] },
      ];

      const scored = tokenMap
        .map(entry => ({
          family: entry.family,
          matched: entry.tokens.filter(token => normalized.includes(token)),
        }))
        .filter(entry => entry.matched.length > 0)
        .sort((left, right) => right.matched.length - left.matched.length);

      const primary = scored[0];
      if (primary) {
        const confidence = round3(normalizeConfidence(Math.min(0.98, 0.45 + (primary.matched.length * 0.09)), 0.45));
        return {
          family: primary.family,
          normalized,
          matched_tokens: primary.matched.slice(0, 8),
          confidence,
          secondary_families: scored.slice(1, 4).map(entry => entry.family),
        };
      }

      return { family: 'unknown', normalized, matched_tokens: [], confidence: 0.2, secondary_families: [] };
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
    if (queryResult?.error) return queryResult;

    const actionPlanResult = await this.actionPlan(repo, {
      query: seedQuery,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
      limit_files: 12,
      limit_checks: 10,
      __skip_precedents: true,
    });
    if (actionPlanResult?.error) return actionPlanResult;

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

    const hasPrecedentResults = () => Array.isArray(precedentPack?.precedents) && precedentPack.precedents.length > 0;
    if (includePrecedents && !hasPrecedentResults()) {
      const topSymbols = Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols.slice(0, 4) : [];
      const fallbackQuery = [
        seedQuery,
        ...topSymbols.map((item: any) => String(item?.name || '').trim()).filter(Boolean),
      ].join(' ').trim();
      const fallbackAnchorUid = String(topSymbols[0]?.id || topSymbols[0]?.uid || '').trim();
      if (fallbackQuery) {
        try {
          const fallbackPack = await this.precedents(repo, {
            query: fallbackQuery,
            ...(fallbackAnchorUid ? { anchor_uid: fallbackAnchorUid } : {}),
            limit: 2,
            examples: 3,
            path_prefixes: pathPrefixes,
          });
          if (Array.isArray(fallbackPack?.precedents) && fallbackPack.precedents.length > 0) {
            precedentPack = fallbackPack;
          }
        } catch {
          // best-effort fallback
        }
      }
    }

    const buildFixRecipes = (findings: string[]): Array<{ id: string; action: string; rationale: string }> => {
      const catalog: Record<string, { id: string; action: string; rationale: string }> = {
        'missing-endpoint-link': {
          id: 'tighten-http-routing-signals',
          action: 'Tighten HTTP path/method extraction so endpoint wiring resolves deterministically.',
          rationale: 'Routing hops should use high-confidence endpoint links instead of fuzzy fallback edges.',
        },
        'missing-controller-link': {
          id: 'wire-endpoint-controller-edge',
          action: 'Ensure endpoint -> controller edges are emitted from route extraction.',
          rationale: 'Missing handler links block one-hop cross-stack debug flows.',
        },
        'missing-permission-closure': {
          id: 'add-auth-closure-edge',
          action: 'Emit explicit permission slug edges for controller authorization calls.',
          rationale: 'Auth symptoms require controller -> permission -> role closure in graph.',
        },
        'no-role-grants': {
          id: 'parse-role-permission-grants',
          action: 'Parse role grant sources and link roles directly to permission slugs.',
          rationale: 'Without role grant edges, auth decisions remain partially manual.',
        },
        'missing-cache-coverage': {
          id: 'expand-cache-contract',
          action: 'Add invalidate/refetch/writeback coverage for queries affected by this mutation.',
          rationale: 'Cache drift issues usually come from incomplete invalidation or writeback contracts.',
        },
        'slice-closure-gaps': {
          id: 'mirror-sibling-closure',
          action: 'Mirror required slice slots/roles from sibling precedents before editing logic.',
          rationale: 'Closure gaps often indicate missing companion files or boundary logic.',
        },
        'low-confidence-http-wiring': {
          id: 'raise-http-edge-confidence',
          action: 'Prefer exact route/path matching and skip ambiguous edges.',
          rationale: 'Debug recommendations degrade when cross-stack wiring confidence is low.',
        },
        'slow-request-path': {
          id: 'trim-request-hot-path',
          action: 'Reduce synchronous work on the request path and defer non-critical side effects.',
          rationale: 'Request-level timeout symptoms are often dominated by serialized hot-path work.',
        },
        'large-payload-shape': {
          id: 'bound-payload-cardinality',
          action: 'Chunk or page large request arrays and avoid repeated full-array scans.',
          rationale: 'Large payload cardinality amplifies O(n²) patterns and lock time windows.',
        },
        'slow-db-query': {
          id: 'improve-query-selectivity',
          action: 'Add/select better indexes and trim selected columns in slow query paths.',
          rationale: 'High query duration indicates low selectivity or over-fetching.',
        },
        'possible-n-plus-one': {
          id: 'collapse-looped-queries',
          action: 'Replace per-item queries with eager loading, batched lookups, or keyed maps.',
          rationale: 'Repeated query signatures under loops indicate likely N+1 behavior.',
        },
        'lock-contention': {
          id: 'narrow-lock-scope',
          action: 'Shorten transaction scope and acquire locks in a deterministic order.',
          rationale: 'Long lock waits point to contention across competing write paths.',
        },
        'hot-path-cost': {
          id: 'reduce-hot-path-complexity',
          action: 'Pre-index inputs by key and avoid repeated linear lookups inside loops.',
          rationale: 'High hot-path complexity drives timeout variance under larger payloads.',
        },
        'repeated-linear-lookups': {
          id: 'replace-linear-lookups',
          action: 'Build keyed maps once and use O(1) lookups in loops.',
          rationale: 'Repeated .find()/findOrFail() scans inside loops scale poorly.',
        },
        'write-amplification': {
          id: 'batch-write-path',
          action: 'Skip unchanged rows and batch persistent writes where possible.',
          rationale: 'Per-item save/update loops increase lock hold time and request latency.',
        },
        'no-op-write-churn': {
          id: 'suppress-noop-writes',
          action: 'Guard writes with diff checks so unchanged records are not persisted.',
          rationale: 'No-op writes add DB and lock pressure without state changes.',
        },
        'db-plan-risk': {
          id: 'review-explain-plan',
          action: 'Capture EXPLAIN and remove plan operators that force scans/filesort/temporary tables.',
          rationale: 'Plan regressions can dominate request latency even with small payloads.',
        },
      };

      const recipes: Array<{ id: string; action: string; rationale: string }> = [];
      const seen = new Set<string>();
      for (const finding of findings) {
        const item = catalog[finding];
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        recipes.push(item);
      }
      return recipes;
    };

    const candidateLoops: Array<{
      kind: 'http_loop' | 'cache_loop' | 'slice_gap' | 'runtime_loop' | 'perf_loop';
      score: number;
      symptom_fit: number;
      confidence: number;
      confidence_reason: string;
      symptom_fit_reasons: string[];
      summary: string;
      findings: string[];
      fix_recipes: Array<{ id: string; action: string; rationale: string }>;
      evidence: any;
    }> = [];

    const hops = Array.isArray(actionPlanResult?.hops) ? actionPlanResult.hops.slice(0, limitHops) : [];
    for (const hop of hops) {
      const findings: string[] = [];
      let score = 1;
      let symptomFit = 0;
      const symptomFitReasons: string[] = [];
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

      const httpConfidence = toFiniteNumber(hop?.http?.confidence, 1);
      const wiringConfidence = toFiniteNumber(hop?.endpoint_wiring?.confidence, 1);
      if (httpConfidence < 0.9 || wiringConfidence < 0.9) {
        findings.push('low-confidence-http-wiring');
        score += 1;
      }

      if (symptomSignal.family === 'auth' && (findings.includes('missing-permission-closure') || findings.includes('no-role-grants'))) {
        symptomFit += 3;
        symptomFitReasons.push('auth-permission-closure');
      }
      if (symptomSignal.family === 'routing' && (findings.includes('missing-endpoint-link') || findings.includes('missing-controller-link'))) {
        symptomFit += 3;
        symptomFitReasons.push('routing-hop-gap');
      }
      if (symptomSignal.family === 'performance' && findings.includes('low-confidence-http-wiring')) {
        symptomFit += 1;
        symptomFitReasons.push('performance-ambiguous-routing');
      }

      const finalScore = score + symptomFit;
      candidateLoops.push({
        kind: 'http_loop',
        score: finalScore,
        symptom_fit: symptomFit,
        confidence: round3(normalizeConfidence((httpConfidence + wiringConfidence) / 2, 0.5)),
        confidence_reason: 'Derived from averaged HTTP call edge + endpoint/controller wiring confidence.',
        symptom_fit_reasons: symptomFitReasons,
        summary: `${String(hop?.http?.reason || 'http-loop')} -> ${String(hop?.controller?.name || 'unknown-controller')}`,
        findings,
        fix_recipes: buildFixRecipes(findings),
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
      const findings = ['missing-cache-coverage'];
      candidateLoops.push({
        kind: 'cache_loop',
        score: 2 + (gaps.length * 0.5) + symptomFit,
        symptom_fit: symptomFit,
        confidence: 0.7,
        confidence_reason: 'Cache coverage gaps are inferred from query/mutation contract extraction.',
        symptom_fit_reasons: symptomFit > 0 ? ['cache-symptom-signal'] : [],
        summary: `${String(effect?.filePath || 'cache-surface')} has ${gaps.length} cache coverage gaps`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          filePath: effect?.filePath || '',
          coverage_gaps: gaps.slice(0, 8),
          summary: effect?.summary || null,
        },
      });
    }

    if (targetSlice?.gap_signals) {
      const gapSignals = targetSlice.gap_signals;
      const severeGapCount = toFiniteNumber(gapSignals?.high, 0) + toFiniteNumber(gapSignals?.deterministic, 0);
      if (severeGapCount > 0) {
        const symptomFit = symptomSignal.family === 'shape' ? 2 : 0;
        const findings = ['slice-closure-gaps'];
        candidateLoops.push({
          kind: 'slice_gap',
          score: 2 + severeGapCount + symptomFit,
          symptom_fit: symptomFit,
          confidence: 0.75,
          confidence_reason: 'Feature-slice closure gaps are high-confidence structural signals from indexed slice slots/roles.',
          symptom_fit_reasons: symptomFit > 0 ? ['shape-symptom-signal'] : [],
          summary: `Target slice ${String(targetSlice?.label || targetSlice?.uid || '')} has closure gap signals`,
          findings,
          fix_recipes: buildFixRecipes(findings),
          evidence: {
            slice: targetSlice,
            gap_signals: gapSignals,
          },
        });
      }
    }

    const dbSignatureCounts = new Map<string, number>();
    for (const query of runtimeObservations.db_queries) {
      const signature = normalizeSqlSignature(String(query.sql || ''));
      if (!signature) continue;
      dbSignatureCounts.set(signature, (dbSignatureCounts.get(signature) || 0) + Math.max(1, toFiniteNumber(query.count, 1)));
    }

    const payloadShapeByPath = new Map<string, any>();
    for (const item of runtimeObservations.payload_shapes) {
      const key = String(item.path || '').trim();
      if (!key) continue;
      payloadShapeByPath.set(key, item);
    }

    for (const requestSpan of runtimeObservations.request_spans.slice(0, Math.max(4, limitCandidates))) {
      const findings: string[] = [];
      const durationMs = normalizeNumber(requestSpan.duration_ms, 0, 0, 60_000);
      const payloadBytes = normalizeNumber(requestSpan.payload_bytes, 0, 0, 20_000_000);
      const routeKey = String(requestSpan.route || '').trim();
      const payloadShape = routeKey ? payloadShapeByPath.get(routeKey) : null;

      if (durationMs >= 350) findings.push('slow-request-path');
      if (payloadBytes >= 250_000 || toFiniteNumber(payloadShape?.item_count, 0) >= 100) findings.push('large-payload-shape');
      if (findings.length === 0) continue;

      let symptomFit = 0;
      const symptomFitReasons: string[] = [];
      if (symptomSignal.family === 'performance') {
        symptomFit += 4;
        symptomFitReasons.push('performance-latency-signal');
      }
      if (symptomSignal.family === 'routing' && routeKey) {
        symptomFit += 1;
        symptomFitReasons.push('routing-route-signal');
      }

      const baseScore = 2 + Math.min(6, durationMs / 250) + (payloadBytes > 0 ? Math.min(2, payloadBytes / 500_000) : 0);
      const confidence = round3(normalizeConfidence(Math.min(0.92, 0.58 + (routeKey ? 0.12 : 0) + (durationMs >= 500 ? 0.1 : 0)), 0.58));
      candidateLoops.push({
        kind: 'runtime_loop',
        score: baseScore + symptomFit,
        symptom_fit: symptomFit,
        confidence,
        confidence_reason: 'Derived from observed request duration/payload metrics provided in runtime_observations.',
        symptom_fit_reasons: symptomFitReasons,
        summary: `${requestSpan.method || 'REQUEST'} ${routeKey || '(unknown-route)'} observed ${durationMs}ms`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          request_span: requestSpan,
          payload_shape: payloadShape || null,
        },
      });
    }

    for (const dbQuery of runtimeObservations.db_queries.slice(0, Math.max(8, limitCandidates * 2))) {
      const findings: string[] = [];
      const durationMs = normalizeNumber(dbQuery.duration_ms, 0, 0, 60_000);
      const lockWaitMs = normalizeNumber(dbQuery.lock_wait_ms, 0, 0, 60_000);
      const rowsExamined = normalizeNumber(dbQuery.rows_examined, 0, 0, 1_000_000_000);
      const routeKey = normalizeObservedRoute(String((dbQuery as any).route || ''));
      const signature = normalizeSqlSignature(String(dbQuery.sql || ''));
      const repeatedCount = signature ? (dbSignatureCounts.get(signature) || 0) : 0;
      const explainPlan = String(dbQuery.explain_plan || '');

      if (durationMs >= 120) findings.push('slow-db-query');
      if (lockWaitMs >= 40) findings.push('lock-contention');
      if (repeatedCount >= 4) findings.push('possible-n-plus-one');
      if (/\b(using temporary|filesort|seq scan|full scan|all)\b/i.test(explainPlan)) findings.push('db-plan-risk');
      if (findings.length === 0) continue;

      let symptomFit = 0;
      const symptomFitReasons: string[] = [];
      if (symptomSignal.family === 'performance') {
        symptomFit += 4;
        symptomFitReasons.push('performance-db-latency');
      }
      if (symptomSignal.family === 'event' && findings.includes('lock-contention')) {
        symptomFit += 1;
        symptomFitReasons.push('event-lock-contention');
      }
      if (symptomSignal.family === 'routing' && routeKey) {
        symptomFit += 1;
        symptomFitReasons.push('routing-db-route-signal');
      }

      const baseScore = 2
        + Math.min(5, durationMs / 200)
        + Math.min(3, lockWaitMs / 150)
        + (repeatedCount >= 4 ? Math.min(2, repeatedCount / 5) : 0)
        + (rowsExamined > 0 ? Math.min(2, rowsExamined / 50_000) : 0);
      const confidence = round3(normalizeConfidence(Math.min(0.94, 0.55 + (durationMs >= 200 ? 0.1 : 0) + (lockWaitMs >= 75 ? 0.12 : 0) + (signature ? 0.07 : 0)), 0.55));
      candidateLoops.push({
        kind: 'runtime_loop',
        score: baseScore + symptomFit,
        symptom_fit: symptomFit,
        confidence,
        confidence_reason: 'Derived from observed query duration/lock-wait metrics and repeated SQL signature frequency.',
        symptom_fit_reasons: symptomFitReasons,
        summary: `${routeKey || 'DB path'} observed ${durationMs}ms${lockWaitMs > 0 ? ` with ${lockWaitMs}ms lock wait` : ''}`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          db_query: dbQuery,
          signature: signature || null,
          repeated_signature_count: repeatedCount,
          explain_plan: explainPlan || null,
        },
      });
    }

    const scanFileSet = new Set<string>();
    const addScanFile = (filePathRaw: unknown) => {
      const filePath = normalizeRepoRelativePath(String(filePathRaw || ''));
      if (!filePath) return;
      if (!filePathTouchesPrefixes(filePath, pathPrefixes)) return;
      scanFileSet.add(filePath);
    };
    for (const symbol of Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols : []) {
      addScanFile(symbol?.filePath);
    }
    for (const symbol of Array.isArray(queryResult?.definitions) ? queryResult.definitions : []) {
      addScanFile(symbol?.filePath);
    }
    for (const file of Array.isArray(actionPlanResult?.files) ? actionPlanResult.files : []) {
      addScanFile(file?.filePath);
    }
    for (const hop of hops) {
      addScanFile(hop?.ui?.filePath);
      addScanFile(hop?.endpoint?.filePath);
      addScanFile(hop?.controller?.filePath);
    }

    const scannedPerfFiles: Array<{ filePath: string; metrics: any; score: number }> = [];
    const loopLineRegex = /\b(?:for(?:each)?|while)\s*\(|\bforeach\s*\(/;
    const linearLookupRegex = /\.(?:find|findIndex|some|filter)\s*\(|->(?:find|findOrFail|firstWhere)\s*\(|\barray_filter\s*\(/;
    const queryInLoopRegex = /->where\s*\(|::where\s*\(|\bDB::(?:table|select|statement)\s*\(|->(?:load|loadMissing)\s*\(/;
    const writeInLoopRegex = /->(?:save|update|delete)\s*\(|::(?:create|update|delete|upsert|insert)\s*\(|\bDB::insert\s*\(/;
    const noOpWriteRegex = /->(?:save|update)\s*\(\s*(?:\[\s*\])?\s*\)/;

    const scanTargets = Array.from(scanFileSet).slice(0, 10);
    const scanContents = await Promise.all(
      scanTargets.map(async (filePath) => {
        const resolved = resolvePathInsideRepo(repo.repoPath, filePath);
        if (!resolved) return null;
        try {
          const content = await fs.readFile(resolved.absolutePath, 'utf-8');
          return { filePath: resolved.relativePath, content };
        } catch {
          return null;
        }
      }),
    );

    for (const scannedFile of scanContents) {
      if (!scannedFile) continue;
      const { filePath, content } = scannedFile;

      const lines = content.split('\n');
      let loopCount = 0;
      let nestedLoopCount = 0;
      let linearLookups = 0;
      let queryInLoopCount = 0;
      let writeInLoopCount = 0;
      let noOpWriteCount = 0;
      let loopWindow = 0;
      for (const line of lines) {
        const codeLine = String(line || '').replace(/\/\/.*$/g, '').trim();
        if (!codeLine) {
          if (loopWindow > 0) loopWindow -= 1;
          continue;
        }

        const isLoopLine = loopLineRegex.test(codeLine);
        if (isLoopLine) {
          loopCount += 1;
          if (loopWindow > 0) nestedLoopCount += 1;
          loopWindow = Math.max(loopWindow, 8);
        } else if (loopWindow > 0) {
          loopWindow -= 1;
        }

        if (loopWindow <= 0) continue;
        if (linearLookupRegex.test(codeLine)) linearLookups += 1;
        if (queryInLoopRegex.test(codeLine)) queryInLoopCount += 1;
        if (writeInLoopRegex.test(codeLine)) writeInLoopCount += 1;
        if (noOpWriteRegex.test(codeLine)) noOpWriteCount += 1;
      }

      const costScore = (loopCount * 0.25)
        + (nestedLoopCount * 1.3)
        + (linearLookups * 0.7)
        + (queryInLoopCount * 1.5)
        + (writeInLoopCount * 1.0)
        + (noOpWriteCount * 0.9);

      if (costScore < 2) continue;

      scannedPerfFiles.push({
        filePath,
        score: round3(costScore),
        metrics: {
          loop_count: loopCount,
          nested_loop_count: nestedLoopCount,
          linear_lookups_in_loop: linearLookups,
          query_calls_in_loop: queryInLoopCount,
          write_calls_in_loop: writeInLoopCount,
          noop_writes_in_loop: noOpWriteCount,
        },
      });
    }

    for (const perf of scannedPerfFiles.slice(0, Math.max(4, limitCandidates))) {
      const findings = ['hot-path-cost'];
      if (perf.metrics.linear_lookups_in_loop > 0) findings.push('repeated-linear-lookups');
      if (perf.metrics.query_calls_in_loop > 0) findings.push('possible-n-plus-one');
      if (perf.metrics.write_calls_in_loop > 0) findings.push('write-amplification');
      if (perf.metrics.noop_writes_in_loop > 0) findings.push('no-op-write-churn');

      let symptomFit = 0;
      const symptomFitReasons: string[] = [];
      if (symptomSignal.family === 'performance') {
        symptomFit += 3;
        symptomFitReasons.push('performance-static-hotpath');
      }
      const confidence = Number(normalizeConfidence(Math.min(
        0.9,
        0.42
        + Math.min(0.3, perf.score / 10)
        + (perf.metrics.query_calls_in_loop > 0 ? 0.08 : 0)
        + (perf.metrics.nested_loop_count > 0 ? 0.06 : 0),
      ), 0.42).toFixed(3));
      candidateLoops.push({
        kind: 'perf_loop',
        score: perf.score + symptomFit,
        symptom_fit: symptomFit,
        confidence,
        confidence_reason: 'Static hot-path heuristics over loop/query/write patterns in scoped files.',
        symptom_fit_reasons: symptomFitReasons,
        summary: `${perf.filePath} has hot-path complexity signals (score=${perf.score.toFixed(2)})`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          filePath: perf.filePath,
          metrics: perf.metrics,
        },
      });
    }

    const rankedCandidates = Array.from(new Map(
      candidateLoops
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.symptom_fit !== left.symptom_fit) return right.symptom_fit - left.symptom_fit;
        if (right.confidence !== left.confidence) return right.confidence - left.confidence;
        return left.summary.localeCompare(right.summary);
      })
      .map(candidate => [`${String(candidate.kind || '')}|${String(candidate.summary || '')}`, candidate]),
    ).values())
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
      } else if (candidate.findings.includes('lock-contention')) {
        hypotheses.push('Observed lock waits suggest transaction/lock scope contention on the request path.');
      } else if (candidate.findings.includes('possible-n-plus-one')) {
        hypotheses.push('Repeated query signatures or query-inside-loop patterns indicate likely N+1 amplification.');
      } else if (candidate.findings.includes('hot-path-cost')) {
        hypotheses.push('Hot-path cost model flags repeated loop scans/writes as likely timeout contributors.');
      }
    }

    const nextActions: string[] = [
      'Open candidate evidence spans with context() on top-ranked symbols.',
      'Run impact() on the first broken-loop symbol to map direct dependents.',
      'Compare target slice vs sibling precedent before editing shared utilities.',
      'After edits, run review_mode(scope=unstaged) with include_slice_stencil=true.',
    ];
    if (failingTests.length > 0) {
      nextActions.push('Re-run failing tests after applying the highest-confidence loop fix.');
    }
    if (!hasRuntimeObservations) {
      nextActions.push('Attach runtime_observations (request spans, DB timings, lock waits) for stronger root-cause ranking.');
    }
    if (!hasPrecedentResults() && includePrecedents) {
      nextActions.push('Precedent retrieval returned empty; rely on action_plan hops + context() before editing.');
    }

    const timeline = hops.slice(0, limitHops).map((hop: any, index: number) => ({
      step: index + 1,
      ui: hop?.ui ? {
        uid: hop.ui.uid,
        name: hop.ui.name,
        filePath: hop.ui.filePath,
        startLine: hop.ui.startLine,
      } : null,
      http: hop?.http ? {
        reason: hop.http.reason,
        confidence: hop.http.confidence,
      } : null,
      endpoint: hop?.endpoint ? {
        uid: hop.endpoint.uid,
        name: hop.endpoint.name,
        filePath: hop.endpoint.filePath,
        startLine: hop.endpoint.startLine,
      } : null,
      controller: hop?.controller ? {
        uid: hop.controller.uid,
        name: hop.controller.name,
        filePath: hop.controller.filePath,
        startLine: hop.controller.startLine,
      } : null,
      permissions: Array.isArray(hop?.permissions) ? hop.permissions.map((grant: any) => ({
        permission: grant?.permission || null,
        role_count: Array.isArray(grant?.roles) ? grant.roles.length : 0,
      })) : [],
    }));

    const indexStatus = await this.getIndexStatus(repo);
    const precedentCount = Array.isArray(precedentPack?.precedents) ? precedentPack.precedents.length : 0;
    const coverageWarnings: string[] = [];
    if (indexStatus.isStale) {
      coverageWarnings.push('Index is stale versus HEAD; refresh before trusting complete root-cause ranking.');
    }
    if (!hasRuntimeObservations) {
      coverageWarnings.push('No runtime observations provided; performance root-cause confidence is capped.');
    } else if (runtimeObservationSource === 'snapshot' || runtimeObservationSource === 'params+snapshot') {
      coverageWarnings.push('Runtime observations were auto-loaded from snapshot sidecar files.');
    }
    if (includePrecedents && precedentCount === 0) {
      coverageWarnings.push('No precedents resolved; anatomy-fit findings rely on static signals only.');
    }
    if (hops.length === 0) {
      coverageWarnings.push('No cross-stack HTTP hops found for this anchor query; routing evidence is limited.');
    }
    if (scannedPerfFiles.length === 0) {
      coverageWarnings.push('Static hot-path scan found no strong loop/query/write signals in scanned files.');
    }

    const average = (values: number[]): number => {
      if (values.length === 0) return 0;
      const total = values.reduce((sum, value) => sum + value, 0);
      return total / values.length;
    };
    const routeOwnershipConfidence = hops.length > 0
      ? average(hops.map((hop: any) => normalizeConfidence(hop?.http?.confidence, 0.7)))
      : 0.35;
    const rootCauseConfidence = rankedCandidates.length > 0
      ? average(rankedCandidates.slice(0, 3).map(candidate => normalizeConfidence(candidate.confidence, 0)))
      : 0.3;
    const recipeCoverage = rankedCandidates.length > 0
      ? average(rankedCandidates.slice(0, 5).map(candidate => candidate.fix_recipes.length > 0 ? 1 : 0))
      : 0;
    const fixRecommendationConfidence = Math.min(0.92, 0.35 + (recipeCoverage * 0.45) + (hasRuntimeObservations ? 0.1 : 0));

    const confidenceBreakdown = {
      claims: [
        {
          claim: 'route_ownership',
          confidence: round3(normalizeConfidence(routeOwnershipConfidence, 0.35)),
          reason: hops.length > 0
            ? 'Based on HTTP + endpoint/controller edge confidence from top hops.'
            : 'No top hops available for ownership confidence.',
        },
        {
          claim: 'root_cause_localization',
          confidence: round3(normalizeConfidence(rootCauseConfidence, 0.3)),
          reason: rankedCandidates.length > 0
            ? 'Based on weighted symptom fit and candidate evidence confidence.'
            : 'No ranked candidates available for localization confidence.',
        },
        {
          claim: 'fix_recommendation',
          confidence: round3(normalizeConfidence(fixRecommendationConfidence, 0.35)),
          reason: hasRuntimeObservations
            ? 'Based on candidate fix recipe coverage plus runtime evidence availability.'
            : 'Based on static evidence only; runtime observations were not provided.',
        },
      ],
    };

    const actionChecks = Array.isArray(actionPlanResult?.checks) ? actionPlanResult.checks : [];
    const verificationChecks = Array.from(new Set([
      ...failingTests.slice(0, 6).map(testName => `Re-run failing test: ${testName}`),
      ...actionChecks.slice(0, 4),
      'Run review_mode(scope=unstaged, include_slice_stencil=true, include_evidence_spans=true) after patch.',
    ])).slice(0, 10);

    const verificationContract = {
      checks: verificationChecks,
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
        runtime_observations: {
          request_spans: runtimeObservations.request_spans.slice(0, 20),
          db_queries: runtimeObservations.db_queries.slice(0, 20),
          payload_shapes: runtimeObservations.payload_shapes.slice(0, 20),
          source: runtimeObservationSource,
          snapshot_generated_at: runtimeSnapshot.generatedAt || '',
          source_files: Array.isArray(runtimeSnapshot.source_files) ? runtimeSnapshot.source_files : [],
        },
        timeline,
        candidates: rankedCandidates,
        sibling_diff: siblingDiff,
        hypotheses: Array.from(new Set(hypotheses)).slice(0, 8),
        next_actions: nextActions.slice(0, 8),
        confidence_breakdown: confidenceBreakdown,
        coverage: {
          freshness: {
            is_stale: indexStatus.isStale,
            indexed_at: indexStatus.indexedAt,
            indexed_commit: indexStatus.indexedCommit || null,
            head_commit: indexStatus.headCommit || null,
          },
          runtime_observations: hasRuntimeObservations,
          runtime_source: runtimeObservationSource,
          runtime_snapshot_generated_at: runtimeSnapshot.generatedAt || '',
          runtime_source_files: Array.isArray(runtimeSnapshot.source_files) ? runtimeSnapshot.source_files : [],
          precedents: precedentCount,
          hops: hops.length,
          cache_effects: cacheEffects.length,
          static_perf_scan_files: scannedPerfFiles.length,
          warnings: coverageWarnings,
        },
        verification_contract: verificationContract,
      },
      _debug_mode: {
        knobs: {
          limit_candidates: limitCandidates,
          limit_hops: limitHops,
          include_precedents: includePrecedents,
          path_prefixes: pathPrefixes,
          runtime_observations: hasRuntimeObservations,
          runtime_source: runtimeObservationSource,
          scanned_perf_files: scannedPerfFiles.length,
        },
      },
    };
  }

  private async cypher(repo: RepoHandle, params: { query: string }): Promise<any> {
    await this.ensureInitialized(repo.id);
    
    if (!isKuzuReady(repo.id)) {
      return { error: 'KuzuDB not ready. Index may be corrupted.' };
    }

    const query = String(params.query || '').trim();
    if (!query) {
      return { error: 'query parameter is required and cannot be empty.' };
    }
    if (!isReadOnlyCypherQuery(query)) {
      return {
        error: 'Cypher write operations are disabled for safety. Use read-only queries.',
      };
    }
    
    try {
      const result = await executeQuery(repo.id, query);
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
      const label = String(c.heuristicLabel ?? c.label ?? 'Unknown').trim() || 'Unknown';
      const symbols = toFiniteNumber(c.symbolCount, 0);
      const cohesion = toFiniteNumber(c.cohesion, 0);
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
    
    const limit = clampInteger(params.limit, 20, 1, 200);
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
          id: String(p.id ?? p[0] ?? '').trim(),
          label: String(p.label ?? p[1] ?? '').trim(),
          heuristicLabel: String(p.heuristicLabel ?? p[2] ?? '').trim(),
          processType: String(p.processType ?? p[3] ?? '').trim(),
          stepCount: toNonNegativeInteger(p.stepCount ?? p[4], 0),
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
          uid: String(s.id ?? s[0] ?? '').trim(),
          name: String(s.name ?? s[1] ?? '').trim(),
          kind: primaryNodeLabel(s.type ?? s[2]),
          filePath: String(s.filePath ?? s[3] ?? '').trim(),
          line: toOptionalLineNumber(s.startLine ?? s[4]),
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
        const confidence = normalizeConfidence(row.confidence ?? row[5], 1.0);
        const reasonRaw = row.reason ?? row[6];
        const reason = typeof reasonRaw === 'string' ? reasonRaw : reasonRaw !== undefined && reasonRaw !== null ? String(reasonRaw) : '';
        const entry = {
          uid: String(row.uid ?? row[1] ?? '').trim(),
          name: String(row.name ?? row[2] ?? '').trim(),
          filePath: String(row.filePath ?? row[3] ?? '').trim(),
          kind: primaryNodeLabel(row.kind ?? row[4]),
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
        uid: String(sym.id ?? sym[0] ?? '').trim(),
        name: String(sym.name ?? sym[1] ?? '').trim(),
        kind: primaryNodeLabel(sym.type ?? sym[2]),
        filePath: String(sym.filePath ?? sym[3] ?? '').trim(),
        startLine: toOptionalLineNumber(sym.startLine ?? sym[4]),
        endLine: toOptionalLineNumber(sym.endLine ?? sym[5]),
        ...(include_content && (sym.content ?? sym[6]) ? { content: sym.content ?? sym[6] } : {}),
      },
      incoming: categorize(incomingRows),
      outgoing: categorize(outgoingRows),
      processes: processRows.map((r: any) => ({
        id: String(r.pid ?? r[0] ?? '').trim(),
        name: String(r.label ?? r[1] ?? '').trim(),
        step_index: toNonNegativeInteger(r.step ?? r[2], 0),
        step_count: toNonNegativeInteger(r.stepCount ?? r[3], 0),
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
          name: String(m.name ?? m[0] ?? '').trim(),
          type: primaryNodeLabel(m.type ?? m[1]),
          filePath: String(m.filePath ?? m[2] ?? '').trim(),
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
      const escapedProcId = String(procId || '').replace(/'/g, "''");
      const steps = await executeQuery(repo.id, `
        MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: '${escapedProcId}'})
        RETURN n.name AS name, labels(n) AS type, n.filePath AS filePath, r.step AS step
        ORDER BY r.step
      `);
      
      return {
        process: {
          id: String(procId ?? '').trim(),
          label: String(proc.label ?? proc[1] ?? '').trim(),
          heuristicLabel: String(proc.heuristicLabel ?? proc[2] ?? '').trim(),
          processType: String(proc.processType ?? proc[3] ?? '').trim(),
          stepCount: toNonNegativeInteger(proc.stepCount ?? proc[4], 0),
        },
        steps: steps.map((s: any) => ({
          step: toNonNegativeInteger(s.step ?? s[3], 0),
          name: String(s.name ?? s[0] ?? '').trim(),
          type: primaryNodeLabel(s.type ?? s[1]),
          filePath: String(s.filePath ?? s[2] ?? '').trim(),
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
    return runDetectChanges(
      {
        ensureInitialized: this.ensureInitialized.bind(this),
        executeQuery,
        normalizeRepoRelativePath,
        toNonNegativeInteger,
        primaryNodeLabel,
        isTestFilePath,
        GIT_NAME_LIST_MAX_BUFFER,
      },
      repo,
      params,
    );
  }
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

    const oldNamePattern = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const makeWordRegex = (global = false): RegExp =>
      new RegExp(`\\b${oldNamePattern}\\b`, global ? 'g' : '');
    
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
        const resolved = resolvePathInsideRepo(repo.repoPath, sym.filePath);
        if (!resolved) throw new Error('symbol file path resolved outside repo');
        const content = await fs.readFile(resolved.absolutePath, 'utf-8');
        const lines = content.split('\n');
        const lineIdx = sym.startLine - 1;
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(oldName)) {
          addEdit(resolved.relativePath, sym.startLine, lines[lineIdx].trim(), lines[lineIdx].replace(makeWordRegex(true), new_name).trim(), 'graph');
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
    const graphFiles = new Set<string>();
    if (sym.filePath) {
      const resolved = resolvePathInsideRepo(repo.repoPath, sym.filePath);
      if (resolved) graphFiles.add(resolved.relativePath);
    }
    
    for (const ref of allIncoming) {
      if (!ref.filePath) continue;
      try {
        const resolved = resolvePathInsideRepo(repo.repoPath, ref.filePath);
        if (!resolved) continue;
        graphFiles.add(resolved.relativePath);
        const content = await fs.readFile(resolved.absolutePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(oldName)) {
            addEdit(resolved.relativePath, i + 1, lines[i].trim(), lines[i].replace(makeWordRegex(true), new_name).trim(), 'graph');
            graphEdits++;
            break; // one edit per file from graph refs
          }
        }
      } catch { /* skip */ }
    }
    
    // Step 3: Text search for refs the graph might have missed
    let astSearchEdits = 0;
    
    // Simple text search across the repo for the old name (in files not already covered by graph)
    try {
      const { spawnSync } = await import('child_process');
      const rgResult = spawnSync(
        'rg',
        ['-l', '--type-add', 'code:*.{ts,tsx,js,jsx,py,go,rs,java}', '-t', 'code', `\\b${oldNamePattern}\\b`, '.'],
        { cwd: repo.repoPath, encoding: 'utf-8', timeout: 5000 }
      );
      if (rgResult.error) throw rgResult.error;
      if (rgResult.status !== 0 && rgResult.status !== 1) throw new Error(String(rgResult.stderr || 'rg failed'));
      const output = String(rgResult.stdout || '');
      const files = output.trim().split('\n').filter(f => f.length > 0);
      
      for (const file of files) {
        const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
        const resolved = resolvePathInsideRepo(repo.repoPath, normalizedFile);
        if (!resolved) continue;
        if (graphFiles.has(resolved.relativePath)) continue; // already covered by graph
        
        try {
          const content = await fs.readFile(resolved.absolutePath, 'utf-8');
          const lines = content.split('\n');
          const searchRegex = makeWordRegex(false);
          for (let i = 0; i < lines.length; i++) {
            if (searchRegex.test(lines[i])) {
              addEdit(resolved.relativePath, i + 1, lines[i].trim(), lines[i].replace(makeWordRegex(true), new_name).trim(), 'text_search');
              astSearchEdits++;
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
          const resolved = resolvePathInsideRepo(repo.repoPath, change.file_path);
          if (!resolved) continue;
          let content = await fs.readFile(resolved.absolutePath, 'utf-8');
          const regex = makeWordRegex(true);
          content = content.replace(regex, new_name);
          await fs.writeFile(resolved.absolutePath, content, 'utf-8');
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
    const maxDepth = clampInteger(params.maxDepth, 3, 1, 6);
    const allowedRelationTypes = new Set(['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']);
    const relationTypes = Array.isArray(params.relationTypes) && params.relationTypes.length > 0
      ? params.relationTypes
        .map(value => String(value || '').trim().toUpperCase())
        .filter(value => allowedRelationTypes.has(value))
      : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'];
    const includeTests = params.includeTests ?? false;
    const minConfidence = Math.max(0, Math.min(1, toFiniteNumber(params.minConfidence, 0)));
    if (relationTypes.length === 0) {
      return { error: 'relationTypes must include one or more of: CALLS, IMPORTS, EXTENDS, IMPLEMENTS.' };
    }
    
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
          uid: String(s.id ?? s[0] ?? '').trim(),
          name: String(s.name ?? s[1] ?? '').trim(),
          kind: primaryNodeLabel(s.type ?? s[2]),
          filePath: String(s.filePath ?? s[3] ?? '').trim(),
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
              name: String(rel.name ?? rel[2] ?? '').trim(),
              type: primaryNodeLabel(rel.type ?? rel[3]),
              filePath,
              relationType: String(rel.relType ?? rel[5] ?? '').trim(),
              confidence: toFiniteNumber(rel.confidence ?? rel[6], 1.0),
              reason: String(rel.reason ?? rel[7] ?? ''),
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
        id: String(symId || '').trim(),
        name: String(sym.name ?? sym[1] ?? '').trim(),
        type: primaryNodeLabel(sym.type ?? sym[2]),
        filePath: String(sym.filePath ?? sym[3] ?? '').trim(),
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
    const limit = clampInteger(options?.limit, 10, 1, 200);
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
    const safeLimit = clampInteger(limit, 100, 1, 500);

    try {
      const rawLimit = Math.max(safeLimit * 5, 200);
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
      return { clusters: this.aggregateClusters(rawClusters).slice(0, safeLimit) };
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
    const safeLimit = clampInteger(limit, 50, 1, 500);

    try {
      const processes = await executeQuery(repo.id, `
        MATCH (p:Process)
        RETURN p.id AS id, p.label AS label, p.heuristicLabel AS heuristicLabel, p.processType AS processType, p.stepCount AS stepCount
        ORDER BY p.stepCount DESC
        LIMIT ${safeLimit}
      `);
      return {
        processes: processes.map((p: any) => ({
          id: String(p.id ?? p[0] ?? '').trim(),
          label: String(p.label ?? p[1] ?? '').trim(),
          heuristicLabel: String(p.heuristicLabel ?? p[2] ?? '').trim(),
          processType: String(p.processType ?? p[3] ?? '').trim(),
          stepCount: toNonNegativeInteger(p.stepCount ?? p[4], 0),
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

    const limit = clampInteger(options?.limit, 25, 1, 100);
    const examplesPerSignature = clampInteger(options?.examplesPerSignature, 3, 1, 10);
    const minHttpConfidence = Math.max(0, Math.min(1, toFiniteNumber(options?.minHttpConfidence, 0.9)));
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
          label: String(row.label ?? row[1] ?? processId).trim(),
          heuristicLabel: String(row.heuristicLabel ?? row[2] ?? row.label ?? row[1] ?? processId).trim(),
          processType: String(row.processType ?? row[3] ?? '').trim(),
          stepCount: toNonNegativeInteger(row.stepCount ?? row[4], 0),
          steps: [],
        };
        processesById.set(processId, proc);
      }

      proc.steps.push({
        step: toNonNegativeInteger(row.step ?? row[9], 0),
        nodeId: String(row.nodeId ?? row[5] ?? '').trim(),
        name: String(row.name ?? row[6] ?? '').trim(),
        filePath: String(row.filePath ?? row[7] ?? '').trim(),
        type: primaryNodeLabel(row.type ?? row[8]),
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
      sourceId: String(r.sourceId ?? r[0] ?? '').trim(),
      targetId: String(r.targetId ?? r[1] ?? '').trim(),
      reason: String(r.reason ?? r[2] ?? '').trim(),
      confidence: toFiniteNumber(r.confidence ?? r[3], 1.0),
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
        name: String(m.name ?? m[0] ?? '').trim(),
        type: primaryNodeLabel(m.type ?? m[1]),
        filePath: String(m.filePath ?? m[2] ?? '').trim(),
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
    const escapedProcId = String(procId || '').replace(/'/g, "''");
    const steps = await executeQuery(repo.id, `
      MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p {id: '${escapedProcId}'})
      RETURN n.name AS name, labels(n) AS type, n.filePath AS filePath, r.step AS step
      ORDER BY r.step
    `);

    return {
      process: {
        id: String(procId || '').trim(),
        label: String(proc.label ?? proc[1] ?? '').trim(),
        heuristicLabel: String(proc.heuristicLabel ?? proc[2] ?? '').trim(),
        processType: String(proc.processType ?? proc[3] ?? '').trim(),
        stepCount: toNonNegativeInteger(proc.stepCount ?? proc[4], 0),
      },
      steps: steps.map((s: any) => ({
        step: toNonNegativeInteger(s.step ?? s[3], 0),
        name: String(s.name ?? s[0] ?? '').trim(),
        type: primaryNodeLabel(s.type ?? s[1]),
        filePath: String(s.filePath ?? s[2] ?? '').trim(),
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

export const __reviewModeInternals = {
  parseStringList,
  normalizeSliceStencilToken,
  normalizeSliceStencilTokens,
  missingRequiredSlotSeverity,
};
