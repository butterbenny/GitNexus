/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/
 */

import path from 'path';
import cliProgress from 'cli-progress';
import { runPipelineFromRepo } from '../core/ingestion/pipeline.js';
import { initKuzu, loadGraphToKuzu, getKuzuStats, executeQuery, executeWithReusedStatement, closeKuzu, createFTSIndex, deleteNodesForFiles, deleteOutgoingRelationshipsForFiles, getUpstreamFilePathsForFiles, loadSymbolDefinitionsFromKuzu } from '../core/kuzu/kuzu-adapter.js';
import { runEmbeddingPipeline, type EmbeddingPipelineSummary } from '../core/embeddings/embedding-pipeline.js';
import { disposeEmbedder } from '../core/embeddings/embedder.js';
import { resolveDefaultEmbeddingCachePath, resolveGlobalEmbeddingCachePath } from '../core/embeddings/embedding-cache.js';
import { getStoragePaths, saveMeta, loadMeta, addToGitignore, registerRepo, getGlobalRegistryPath, listRegisteredRepos } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot, getGitCommonDir, getCommittedFileChanges, getWorkingTreeFileChanges, mergeGitFileChanges } from '../storage/git.js';
import { KUZU_SCHEMA_VERSION } from '../core/kuzu/schema.js';
import { generateAIContextFiles } from './ai-context.js';
import fs from 'fs/promises';
import { registerClaudeHook } from './claude-hooks.js';
import { shouldIgnorePath } from '../config/ignore-service.js';
import { listRepositoryFiles, readRepositoryFiles } from '../core/ingestion/filesystem-walker.js';
import { createKnowledgeGraph } from '../core/graph/graph.js';
import { NodeLabel, RelationshipType } from '../core/graph/types.js';
import { createSymbolTable } from '../core/ingestion/symbol-table.js';
import { createASTCache } from '../core/ingestion/ast-cache.js';
import { processParsing } from '../core/ingestion/parsing-processor.js';
import { processImportsFromExtracted, createImportMap, createPhpUseAliasMap } from '../core/ingestion/import-processor.js';
import { processCallsFromExtracted } from '../core/ingestion/call-processor.js';
import { processHeritageFromExtracted } from '../core/ingestion/heritage-processor.js';
import { processCommunities } from '../core/ingestion/community-processor.js';
import { processProcesses } from '../core/ingestion/process-processor.js';
import { processFeatureSlices } from '../core/ingestion/feature-slice-processor.js';
import { processGaps } from '../core/ingestion/gap-processor.js';
import { processGitHistoryCochange } from '../core/ingestion/git-history-cochange-processor.js';
import { processEvidenceSpans } from '../core/ingestion/evidence-span-processor.js';
import { saveEvidenceSpanSnapshot } from '../core/ingestion/evidence-span-store.js';
import { processMicroDataflow } from '../core/ingestion/micro-dataflow-processor.js';
import { processPrecisionOverlay } from '../core/ingestion/precision-overlay-processor.js';
import { PrecisionOverlayMode, normalizePrecisionOverlayMode } from '../core/ingestion/precision-overlay-producer.js';
import { processProvenanceEdges } from '../core/ingestion/provenance-processor.js';
import { processClosureTemplates } from '../core/ingestion/closure-template-processor.js';
import { saveClosureTemplateSnapshot } from '../core/ingestion/closure-template-store.js';
import { processStructuredSummaryOverlay } from '../core/ingestion/summary-overlay-processor.js';
import { saveStructuredSummarySnapshot } from '../core/ingestion/summary-overlay-store.js';
import { processValueGraph } from '../core/ingestion/value-graph-processor.js';
import { createWorkerPool, WorkerPool } from '../core/ingestion/workers/worker-pool.js';
import { processLaravelRoutes, ROUTE_FILE_PATH_RE } from '../core/ingestion/laravel-route-processor.js';
import { processLaravelHttpWiring } from '../core/ingestion/laravel-http-processor.js';
import { processLaravelRouteNameWiring } from '../core/ingestion/laravel-route-name-processor.js';
import { processTemplateMethodCallWiring } from '../core/ingestion/template-method-call-processor.js';
import { processLaravelSemanticEdges } from '../core/ingestion/laravel-semantic-processor.js';
import { processLaravelAuthorization } from '../core/ingestion/laravel-auth-processor.js';
import { processLaravelRouteMiddlewareAuthorization } from '../core/ingestion/laravel-route-middleware-auth-processor.js';
import { processLaravelPermissionsConfig } from '../core/ingestion/laravel-permissions-config-processor.js';
import { processPhpMatchReturnEdges } from '../core/ingestion/php-match-return-processor.js';
import { processLaravelEloquentRelationships } from '../core/ingestion/laravel-eloquent-relationship-processor.js';
import { processLaravelEloquentLoadEdges } from '../core/ingestion/laravel-eloquent-load-processor.js';
import { processLaravelResourceContracts } from '../core/ingestion/laravel-resource-contract-processor.js';
import { processReactQueryKeyWiring } from '../core/ingestion/react-query-processor.js';
import {
  extractInvalidateQueryKeyExpressions,
  extractKeyFactoryName,
  extractLiteralKey,
  processContractShapes,
  processStaticTestClosures,
  ShapeTestReference,
} from '../core/ingestion/contract-shape-processor.js';
import { processLaravelViewsAndMail } from '../core/ingestion/laravel-view-mail-processor.js';
import { processLaravelEvents } from '../core/ingestion/laravel-event-processor.js';
import { processLaravelEventDispatch } from '../core/ingestion/laravel-event-dispatch-processor.js';
import { processLaravelSchedule } from '../core/ingestion/laravel-schedule-processor.js';
import { processLaravelJobDispatch } from '../core/ingestion/laravel-job-dispatch-processor.js';
import { processLaravelNotifications } from '../core/ingestion/laravel-notification-processor.js';
import { processLaravelTacticianDispatch } from '../core/ingestion/laravel-tactician-dispatch-processor.js';
import { processBladeTemplatesIncremental } from '../core/ingestion/blade-template-processor.js';
import { processMjmlIncludes } from '../core/ingestion/mjml-template-processor.js';
import { processPatternCatalogTemplates } from '../core/ingestion/pattern-catalog-processor.js';
import { processBladeAuthorization } from '../core/ingestion/blade-auth-processor.js';
import { getLanguageFromFilename } from '../core/ingestion/utils.js';
import { BrainKernel } from '../core/brain/kernel.js';

type AnalyzeProfile = 'default' | 'monorepo';

export interface AnalyzeOptions {
  force?: boolean;
  skipEmbeddings?: boolean;
  profile?: string;
  withCochange?: boolean;
  withBrain?: boolean;
  registry?: boolean;
  hooks?: boolean;
  writeContext?: boolean;
  updateGitignore?: boolean;
  incrementalMaxChanges?: number;
  incrementalRecomputeProcesses?: boolean;
  incrementalRecomputeCommunities?: boolean;
  precisionOverlay?: PrecisionOverlayMode | string;
  precisionOverlayPath?: string;
  precisionOverlayForce?: boolean;
  graphExpectationPath?: string;
  incrementalDerivedMode?: string;
}

type IncrementalDerivedMode = 'full' | 'adaptive';

const normalizeIncrementalDerivedMode = (value?: string): { mode: IncrementalDerivedMode; usedFast: boolean } => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'adaptive') return { mode: 'adaptive', usedFast: false };
  if (normalized === 'fast') return { mode: 'full', usedFast: true };
  return { mode: 'full', usedFast: false };
};

const INCREMENTAL_MAX_CHANGES_DEFAULT = 500;
const INCREMENTAL_MAX_CHANGES_CAP = 5_000;
const INCREMENTAL_MAX_CHANGES_FRACTION_OF_FILES = 0.2;
const GLOBAL_FULL_REINDEX_BASENAMES = new Set([
  'tsconfig.json',
  'jsconfig.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'composer.json',
  'composer.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
]);
const FTS_INDEX_TARGETS: Array<{ table: string; index: string; properties: string[] }> = [
  { table: 'File', index: 'file_fts', properties: ['name', 'content'] },
  { table: 'Function', index: 'function_fts', properties: ['name', 'content'] },
  { table: 'Class', index: 'class_fts', properties: ['name', 'content'] },
  { table: 'Method', index: 'method_fts', properties: ['name', 'content'] },
  { table: 'Interface', index: 'interface_fts', properties: ['name', 'content'] },
  { table: 'CodeElement', index: 'codeelement_fts', properties: ['name', 'content'] },
  { table: 'Const', index: 'const_fts', properties: ['name', 'content'] },
];

const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  shapes: 'Materializing contract shapes',
  heritage: 'Extracting inheritance',
  precision: 'Applying precision overlay',
  microflow: 'Materializing targeted micro-dataflow',
  values: 'Materializing value graph',
  provenance: 'Materializing provenance edges',
  closuretemplates: 'Materializing closure templates',
  evidence: 'Materializing evidence spans',
  summaries: 'Materializing structured summaries',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  slices: 'Materializing feature slices',
  gaps: 'Materializing gap graph',
  cochange: 'Materializing git-history cochange graph',
  complete: 'Pipeline complete',
  kuzu: 'Loading into KuzuDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

const ANALYZE_PROFILE_ENV = 'GITNEXUS_ANALYZE_PROFILE';

const parseAnalyzeProfile = (value: unknown): AnalyzeProfile | null => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return null;
  if (normalized === 'default' || normalized === 'standard') return 'default';
  if (normalized === 'monorepo') return 'monorepo';
  return null;
};

const detectMonorepoProfile = async (repoPath: string): Promise<boolean> => {
  const base = path.basename(repoPath.replace(/\/+$/, ''));
  if (base === 'monorepo') return true;

  try {
    await fs.access(path.join(repoPath, '.agents', 'review', 'pattern-catalog.md'));
    return true;
  } catch {
    return false;
  }
};

const resolveAnalyzeProfile = async (
  repoPath: string,
  options?: AnalyzeOptions,
): Promise<{ profile: AnalyzeProfile; source: string }> => {
  const fromCli = parseAnalyzeProfile((options as any)?.profile);
  if (fromCli) return { profile: fromCli, source: 'cli' };

  const fromEnv = parseAnalyzeProfile(process.env[ANALYZE_PROFILE_ENV]);
  if (fromEnv) return { profile: fromEnv, source: 'env' };

  if (await detectMonorepoProfile(repoPath)) return { profile: 'monorepo', source: 'auto-detect' };
  return { profile: 'default', source: 'default' };
};

export const analyzeCommand = async (
  inputPath?: string,
  options?: AnalyzeOptions
) => {
  console.log('\n  GitNexus Analyzer\n');

  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log('  Not inside a git repository\n');
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  if (!isGitRepo(repoPath)) {
    console.log('  Not a git repository\n');
    process.exitCode = 1;
    return;
  }

  const profileResolution = await resolveAnalyzeProfile(repoPath, options);
  const analyzeProfile = profileResolution.profile;
  const monorepoProfile = analyzeProfile === 'monorepo';
  const profileWarnings: string[] = [];

  if (monorepoProfile && options?.skipEmbeddings) {
    profileWarnings.push('Monorepo profile: ignoring --skip-embeddings (precision-first).');
  }

  const skipEmbeddingsRequested = Boolean(options?.skipEmbeddings);
  const skipEmbeddings = !monorepoProfile && skipEmbeddingsRequested;
  const skipCochange = monorepoProfile && options?.withCochange !== true;
  const runBrainTick = !monorepoProfile || options?.withBrain === true;

  if (monorepoProfile && options?.withCochange !== true) {
    profileWarnings.push('Monorepo profile: skipping git-history cochange graph (pass --with-cochange to enable).');
  }
  if (monorepoProfile && options?.withBrain !== true) {
    profileWarnings.push('Monorepo profile: skipping BrainKernel tick (pass --with-brain to enable).');
  }

  const { storagePath, kuzuPath } = getStoragePaths(repoPath);
  const repoEmbeddingCachePath = resolveDefaultEmbeddingCachePath(storagePath);
  const globalEmbeddingCachePath = resolveGlobalEmbeddingCachePath();

  const explicitEmbeddingCachePath = String(process.env.GITNEXUS_EMBEDDING_CACHE_PATH || '').trim();
  const embeddingCacheScope = String(process.env.GITNEXUS_EMBEDDING_CACHE_SCOPE || '').trim().toLowerCase();

  let embeddingCachePath = repoEmbeddingCachePath;
  if (explicitEmbeddingCachePath) {
    embeddingCachePath = explicitEmbeddingCachePath;
  } else if (embeddingCacheScope === 'repo') {
    embeddingCachePath = repoEmbeddingCachePath;
  } else if (embeddingCacheScope === 'global') {
    embeddingCachePath = globalEmbeddingCachePath;
    try {
      // Best-effort: if the user explicitly requested a global cache but it doesn't exist yet,
      // seed it from the repo cache (worktree seeding often provides this file).
      await fs.access(globalEmbeddingCachePath);
    } catch {
      try {
        await fs.access(repoEmbeddingCachePath);
        await fs.mkdir(path.dirname(globalEmbeddingCachePath), { recursive: true });
        await fs.copyFile(repoEmbeddingCachePath, globalEmbeddingCachePath);
      } catch {
        // best-effort
      }
    }
  } else if (monorepoProfile) {
    // Default (monorepo): use the global embedding cache so worktrees share embeddings.
    // Best-effort seed from the repo cache to avoid re-embedding when a worktree already has a cache.
    embeddingCachePath = globalEmbeddingCachePath;
    try {
      await fs.access(globalEmbeddingCachePath);
    } catch {
      try {
        await fs.access(repoEmbeddingCachePath);
        await fs.mkdir(path.dirname(globalEmbeddingCachePath), { recursive: true });
        await fs.copyFile(repoEmbeddingCachePath, globalEmbeddingCachePath);
      } catch {
        // best-effort
      }
    }
  } else {
    embeddingCachePath = repoEmbeddingCachePath;
  }
  const currentCommit = getCurrentCommit(repoPath);

  let seedNote: { sourceRepoPath: string; sourceCommit: string } | null = null;
  let existingMeta = await loadMeta(storagePath);
  if (!existingMeta && !options?.force && process.env.GITNEXUS_DISABLE_WORKTREE_SEED !== '1') {
    const trySeedFromRegisteredRepo = async (): Promise<{ sourceRepoPath: string; sourceCommit: string } | null> => {
      const commonDir = getGitCommonDir(repoPath);
      if (!commonDir) return null;

      const entries = await listRegisteredRepos({ validate: true });
      if (!Array.isArray(entries) || entries.length === 0) return null;

      const seedCandidates: Array<{
        repoPath: string;
        storagePath: string;
        meta: any;
        fileChangesTotal: number;
        indexedAtMs: number;
      }> = [];

      const computeSeedIncrementalMaxChanges = (indexedFileCount: number): number => {
        const explicit = options?.incrementalMaxChanges;
        if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
          return Math.floor(explicit);
        }
        const files = Number(indexedFileCount || 0) || 0;
        if (files > 0) {
          const byFraction = Math.round(files * INCREMENTAL_MAX_CHANGES_FRACTION_OF_FILES);
          return Math.max(
            INCREMENTAL_MAX_CHANGES_DEFAULT,
            Math.min(INCREMENTAL_MAX_CHANGES_CAP, byFraction),
          );
        }
        return INCREMENTAL_MAX_CHANGES_DEFAULT;
      };

      for (const entry of entries) {
        const candidateRepoPath = path.resolve(String((entry as any)?.path || '').trim());
        const candidateStoragePath = path.resolve(String((entry as any)?.storagePath || '').trim());
        if (!candidateRepoPath || !candidateStoragePath) continue;
        if (candidateRepoPath === repoPath) continue;

        const candidateCommonDir = getGitCommonDir(candidateRepoPath);
        if (!candidateCommonDir || candidateCommonDir !== commonDir) continue;

        const candidateMeta = await loadMeta(candidateStoragePath);
        if (!candidateMeta) continue;
        const candidateSchema = Number(candidateMeta?.kuzuSchemaVersion ?? 1) || 1;
        if (candidateSchema !== KUZU_SCHEMA_VERSION) continue;

        const candidateKuzuPath = path.join(candidateStoragePath, 'kuzu');
        try {
          await fs.access(candidateKuzuPath);
        } catch {
          continue;
        }

        const seedChanges = mergeGitFileChanges(
          getCommittedFileChanges(repoPath, String(candidateMeta.lastCommit || ''), currentCommit),
          getWorkingTreeFileChanges(repoPath),
        );
        const fileChangesTotal = seedChanges.changed.length + seedChanges.deleted.length;
        const seedMaxChanges = computeSeedIncrementalMaxChanges(Number(candidateMeta?.stats?.files ?? 0));
        if (fileChangesTotal > seedMaxChanges) continue;

        const seedForcesFull = [...seedChanges.changed, ...seedChanges.deleted].some(fp => {
          const base = path.posix.basename(fp);
          return GLOBAL_FULL_REINDEX_BASENAMES.has(base);
        });
        if (seedForcesFull) continue;

        const indexedAtMs = Date.parse(String(candidateMeta.indexedAt || '')) || 0;
        seedCandidates.push({
          repoPath: candidateRepoPath,
          storagePath: candidateStoragePath,
          meta: candidateMeta,
          fileChangesTotal,
          indexedAtMs,
        });
      }

      if (seedCandidates.length === 0) return null;

      seedCandidates.sort((a, b) => {
        if (a.fileChangesTotal !== b.fileChangesTotal) return a.fileChangesTotal - b.fileChangesTotal;
        if (b.indexedAtMs !== a.indexedAtMs) return b.indexedAtMs - a.indexedAtMs;
        return a.repoPath.localeCompare(b.repoPath);
      });

      const best = seedCandidates[0];
      if (!best) return null;

      try {
        await fs.rm(storagePath, { recursive: true, force: true });
      } catch {
        // best-effort
      }

      try {
        await fs.cp(best.storagePath, storagePath, { recursive: true });
      } catch {
        return null;
      }

      try {
        await saveMeta(storagePath, { ...best.meta, repoPath });
      } catch {
        // best-effort; meta rewrite failure will just fall back to full index build
      }

      // Clear stale lock artifacts that can block opening the seeded Kuzu DB.
      const kuzuFiles = [kuzuPath, `${kuzuPath}.wal`, `${kuzuPath}.lock`];
      for (const f of kuzuFiles.slice(1)) {
        try { await fs.rm(f, { recursive: true, force: true }); } catch {}
      }

      return { sourceRepoPath: best.repoPath, sourceCommit: String(best.meta.lastCommit || '') };
    };

    seedNote = await trySeedFromRegisteredRepo();
    if (seedNote) {
      existingMeta = await loadMeta(storagePath);
      if (existingMeta) {
        profileWarnings.push(`Seeded index from ${seedNote.sourceRepoPath} (commit ${seedNote.sourceCommit.slice(0, 10) || 'unknown'}).`);
      }
    }
  }

  const existingSchemaVersion = existingMeta?.kuzuSchemaVersion ?? 1;
  const schemaMismatch = existingMeta !== null && existingSchemaVersion !== KUZU_SCHEMA_VERSION;
  const ftsSchemaVersion = Number(existingMeta?.ftsSchemaVersion || 0);
  const shouldEnsureFtsIndexes = !existingMeta || schemaMismatch || ftsSchemaVersion !== KUZU_SCHEMA_VERSION;
  const precisionOverlayMode = normalizePrecisionOverlayMode(options?.precisionOverlay);
  const incrementalDerivedNormalized = normalizeIncrementalDerivedMode(
    options?.incrementalDerivedMode ?? (options as any)?.incrementalDerived,
  );
  const incrementalDerivedMode = incrementalDerivedNormalized.mode;
  const incrementalDerivedFastDeprecated = incrementalDerivedNormalized.usedFast;

  const ensureFtsIndexes = async (): Promise<string> => {
    const t0Fts = Date.now();
    try {
      for (const target of FTS_INDEX_TARGETS) {
        await createFTSIndex(target.table, target.index, target.properties);
      }
    } catch {
      // Best effort: FTS is optional for successful indexing.
    }
    return ((Date.now() - t0Fts) / 1000).toFixed(1);
  };

  const runBrainKernelTick = async (
    metaForTick: { lastCommit?: string },
    warnings: string[],
    changedPaths: string[] = [],
  ): Promise<string | null> => {
    try {
      const kernel = new BrainKernel();
      const tickResult = await kernel.tick({
        reason: 'analyze',
        repoPath,
        storagePath,
        repoFingerprint: String(metaForTick.lastCommit || currentCommit || 'HEAD'),
        graphVersion: String(KUZU_SCHEMA_VERSION),
        plannerPolicyVersion: 'rule-baseline-v1',
        changedPaths,
      });
      return tickResult.manifestPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || '');
      warnings.push(`BrainKernel tick skipped (${message.slice(0, 120)})`);
      return null;
    }
  };

  const rawChanges = existingMeta && !options?.force
    ? mergeGitFileChanges(
      getCommittedFileChanges(repoPath, existingMeta.lastCommit, currentCommit),
      getWorkingTreeFileChanges(repoPath),
    )
    : { changed: [], deleted: [] };

  const filterIndexablePaths = (paths: string[]): string[] => {
    const unique = Array.from(new Set(paths.map(p => p.replace(/\\/g, '/').trim()).filter(Boolean)));
    const allowedDotPathSegments = new Set(['.agents', '.claude']);
    const hasDisallowedDotPathSegment = (relativePath: string): boolean => {
      return relativePath
        .split('/')
        .some(part => {
          if (!part.startsWith('.')) return false;
          if (part === '.' || part === '..') return false;
          return !allowedDotPathSegments.has(part);
        });
    };
    return unique
      .filter(p => !hasDisallowedDotPathSegment(p))
      .filter(p => !shouldIgnorePath(p));
  };

  const fileChanges = {
    changed: filterIndexablePaths(rawChanges.changed),
    deleted: filterIndexablePaths(rawChanges.deleted),
  };

  const isUpToDate = existingMeta
    && !options?.force
    && !schemaMismatch
    && existingMeta.lastCommit === currentCommit
    && fileChanges.changed.length === 0
    && fileChanges.deleted.length === 0;

  if (isUpToDate) {
    console.log('  Already up to date\n');
    if (seedNote) {
      console.log(`  Seeded index from ${seedNote.sourceRepoPath} (commit ${seedNote.sourceCommit.slice(0, 10) || 'unknown'})`);
    }
    if (options?.registry !== false) {
      try {
        await registerRepo(repoPath, existingMeta);
      } catch {
        // Non-fatal: index is still usable even if we can't write global registry
      }
    }
    if (options?.hooks !== false) {
      try {
        await registerClaudeHook();
      } catch {
        // Non-fatal
      }
    }
    return;
  }

  // Single progress bar for entire pipeline
  const bar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {phase}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    barGlue: '',
    autopadding: true,
    clearOnComplete: false,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_grey);

  bar.start(100, 0, { phase: 'Initializing...' });

  const t0Global = Date.now();

  const hasAnyFileChanges = fileChanges.changed.length > 0 || fileChanges.deleted.length > 0;
  const fileChangesTotal = fileChanges.changed.length + fileChanges.deleted.length;

  const computeIncrementalMaxChanges = (): number => {
    const explicit = options?.incrementalMaxChanges;
    if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
      return Math.floor(explicit);
    }

    const indexedFileCount = Number((existingMeta as any)?.stats?.files ?? 0) || 0;
    if (indexedFileCount > 0) {
      const byFraction = Math.round(indexedFileCount * INCREMENTAL_MAX_CHANGES_FRACTION_OF_FILES);
      return Math.max(
        INCREMENTAL_MAX_CHANGES_DEFAULT,
        Math.min(INCREMENTAL_MAX_CHANGES_CAP, byFraction),
      );
    }

    return INCREMENTAL_MAX_CHANGES_DEFAULT;
  };

  const incrementalMaxChanges = computeIncrementalMaxChanges();

  const shouldForceFullDueToConfig = [...fileChanges.changed, ...fileChanges.deleted].some(fp => {
    const base = path.posix.basename(fp);
    if (GLOBAL_FULL_REINDEX_BASENAMES.has(base)) return true;
    return false;
  });

  const hasExistingIndex = existingMeta !== null;
  const canAttemptIncremental = hasExistingIndex
    && !options?.force
    && !schemaMismatch
    && hasAnyFileChanges
    && !shouldForceFullDueToConfig
    && fileChangesTotal <= incrementalMaxChanges;

  const getFilePathFromNodeId = (nodeId: string): string | null => {
    const firstColon = nodeId.indexOf(':');
    if (firstColon < 0) return null;
    const rest = nodeId.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');
    return (secondColon < 0 ? rest : rest.slice(0, secondColon)).trim() || null;
  };

  const getCount = async (label: string): Promise<number> => {
    try {
      const rows = await executeQuery(`MATCH (n:${label}) RETURN count(n) AS cnt`);
      const raw = (rows[0] as any)?.cnt ?? (rows[0] as any)?.[0] ?? 0;
      return Number(raw) || 0;
    } catch {
      return 0;
    }
  };

  const getHttpWiringSourceFiles = async (): Promise<string[]> => {
    try {
      const rows = await executeQuery(`
        MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->()
        WHERE r.reason STARTS WITH 'http-' AND a.filePath <> ''
        MATCH (f:File {filePath: a.filePath})
        RETURN DISTINCT a.filePath AS filePath
      `);
      const values = rows
        .map((row: any) => String(row.filePath ?? row[0] ?? '').trim())
        .filter(Boolean);
      return Array.from(new Set(values)).filter(p => !shouldIgnorePath(p));
    } catch {
      return [];
    }
  };

  const runIncrementalIndexing = async (): Promise<{
    kuzuWarnings: string[];
    kuzuTime: string;
    ftsTime: string;
    embeddingTime: string;
    embeddingSkipped: boolean;
    embeddingSkipReason: string;
    stats: { nodes: number; edges: number };
    fileCount: number;
    communityCount: number;
    processCount: number;
    precision?: {
      mode: PrecisionOverlayMode;
      provider: string;
      overlayFound: boolean;
      declaredRelations: number;
      emittedEdges: number;
      producer?: string;
      producerCacheHit?: boolean;
      producerSkipped?: boolean;
      producerSkipReason?: string;
    };
    microDataflow?: {
      emittedEdges: number;
      requestFieldReads: number;
      responseFieldWrites: number;
      endpointRequestClosures: number;
      endpointResponseClosures: number;
      queryInvalidationClosures: number;
      endpointEventClosures: number;
      endpointPermissionClosures: number;
    };
    valueGraph?: {
      valueCount: number;
      edgeCount: number;
      permissionValues: number;
      endpointValues: number;
      routeNameValues: number;
      cacheKeyValues: number;
      roleValues: number;
      featureFlagValues: number;
      configKeyValues: number;
      envVarValues: number;
      queueNameValues: number;
      broadcastChannelValues: number;
      eventNameValues: number;
      commandNameValues: number;
      i18nKeyValues: number;
      queryKeyFamilyValues: number;
      routeSegmentValues: number;
      tableNameValues: number;
      tableColumnValues: number;
      tailwindClassValues: number;
      componentPropValues: number;
      reactContextValues: number;
      providerSurfaceValues: number;
      skippedDuplicates: number;
      skippedMalformed: number;
    };
    provenance?: {
      emittedEdges: number;
      routeExpansionEdges: number;
      enumToSlugEdges: number;
      configDrivenEdges: number;
      compiledArtifactEdges: number;
      frameworkDerivedEdges: number;
      skippedDuplicates: number;
      skippedMalformed: number;
    };
    evidenceSpans?: {
      nodeEvidenceCount: number;
      edgeEvidenceCount: number;
      uniqueFiles: number;
      primarySpanCount: number;
      witnessSpanCount: number;
      proofSpanCount: number;
    };
    summaries?: {
      symbolCount: number;
      fileCount: number;
      sliceCount: number;
      communityCount: number;
      processCount: number;
      archetypeCount: number;
    };
    closureTemplates?: {
      totalTemplates: number;
      totalSlices: number;
      totalCoveredSlots: number;
      totalRoleExpectations: number;
    };
    embeddingSummary?: EmbeddingPipelineSummary;
    derived: {
      mode: IncrementalDerivedMode;
      skippedPasses: string[];
      adaptiveLowSignal: boolean;
      recomputed: {
        communities: boolean;
        processes: boolean;
        autoCommunities: boolean;
        autoProcesses: boolean;
      };
      timingsMs?: Record<string, number>;
    };
  }> => {
    const debugEnabled = process.env.GITNEXUS_DEBUG_INCREMENTAL === '1';
    const profileEmbeddings = process.env.GITNEXUS_PROFILE_EMBEDDINGS === '1';
    const debug = (msg: string) => {
      if (!debugEnabled) return;
      // stderr so it shows up even when stdout progress bars are suppressed
      console.error(`[gitnexus][incremental] ${msg}`);
    };

    bar.update(1, { phase: 'Incremental: scanning repo files...' });
    debug('start');
    const skippedDerivedPasses: string[] = [];
    const profileDerivedTimings = process.env.GITNEXUS_PROFILE_DERIVED === '1';
    const derivedPassTimingsMs: Record<string, number> = {};
    const markPassTiming = (passName: string, startedAtMs: number): void => {
      if (!profileDerivedTimings) return;
      derivedPassTimingsMs[passName] = Math.max(0, Date.now() - startedAtMs);
    };
    const skipDerivedPass = (passName: string): void => {
      if (!skippedDerivedPasses.includes(passName)) skippedDerivedPasses.push(passName);
    };

    // Validate index exists on disk
    try {
      debug('checking kuzu path exists');
      await fs.access(kuzuPath);
    } catch {
      throw new Error('Missing existing KuzuDB index file');
    }

    debug('listing repository files');
    const repoFilesStartedAt = Date.now();
    const allRepoFiles = await listRepositoryFiles(repoPath);
    const allRepoFileSet = new Set(allRepoFiles);
    markPassTiming('repo-files', repoFilesStartedAt);

    // Normalize + partition file changes based on current filesystem state
    const rebuildFiles: string[] = [];
    const deletedFiles = new Set<string>(fileChanges.deleted);

    for (const fp of fileChanges.changed) {
      if (!allRepoFileSet.has(fp)) {
        deletedFiles.add(fp);
        continue;
      }
      rebuildFiles.push(fp);
    }

    const rebuildFilesSet = new Set<string>(rebuildFiles);

    // Route prefixes can change without route-file edits (RouteServiceProvider),
    // which affects derived Endpoint contract nodes.
    const routeProviderTouched = rebuildFiles.some(fp => /(^|\/)app\/Providers\/RouteServiceProvider\.php$/i.test(fp));
    if (routeProviderTouched) {
      for (const fp of allRepoFiles) {
        if (!ROUTE_FILE_PATH_RE.test(fp)) continue;
        if (shouldIgnorePath(fp)) continue;
        if (rebuildFilesSet.has(fp)) continue;
        rebuildFilesSet.add(fp);
        rebuildFiles.push(fp);
      }
    }

    const PERMISSIONS_CONFIG_PATH_RE = /(^|\/)config\/permissions\.php$/i;
    const permissionsConfigPath = rebuildFiles.find(fp => PERMISSIONS_CONFIG_PATH_RE.test(fp)) || null;

    bar.update(5, { phase: `Incremental: ${rebuildFiles.length} changed, ${deletedFiles.size} deleted` });

    // Open existing KuzuDB (in-place update)
    debug('initializing kuzu (incremental open)');
    await closeKuzu();
    await initKuzu(kuzuPath);
    debug('kuzu initialized');

    const impactedFiles = Array.from(new Set([...rebuildFiles, ...Array.from(deletedFiles)]));

    bar.update(8, { phase: 'Incremental: finding affected callers...' });
    debug(`finding affected callers for ${impactedFiles.length} file(s)`);
    const upstreamFiles = await getUpstreamFilePathsForFiles(impactedFiles);
    debug(`upstream callers: ${upstreamFiles.length}`);

    const impactedSet = new Set(impactedFiles);
    const refreshEdgeFiles = new Set<string>();
    for (const fp of upstreamFiles) {
      if (impactedSet.has(fp)) continue;
      if (!allRepoFileSet.has(fp)) continue;
      if (shouldIgnorePath(fp)) continue;
      refreshEdgeFiles.add(fp);
    }

    const PATTERN_CATALOG_PATH = '.agents/review/pattern-catalog.md';
    const patternCatalogExists = allRepoFileSet.has(PATTERN_CATALOG_PATH) && !shouldIgnorePath(PATTERN_CATALOG_PATH);
    const patternCatalogTouched = rebuildFilesSet.has(PATTERN_CATALOG_PATH) || deletedFiles.has(PATTERN_CATALOG_PATH);
    let shouldRefreshPatternCatalog = patternCatalogTouched;
    if (!shouldRefreshPatternCatalog && patternCatalogExists) {
      try {
        const escapedCatalogPath = PATTERN_CATALOG_PATH.replace(/'/g, "''");
        const rows = await executeQuery(`
          MATCH (n:CodeElement)
          WHERE n.filePath = '${escapedCatalogPath}'
            AND n.id STARTS WITH 'CodeElement:pattern-catalog:'
          RETURN count(n) AS cnt
        `);
        const raw = (rows[0] as any)?.cnt ?? (rows[0] as any)?.[0] ?? 0;
        const count = Number(raw) || 0;
        if (count === 0) shouldRefreshPatternCatalog = true;
      } catch {
        // best-effort
      }
    }
    if (shouldRefreshPatternCatalog && patternCatalogExists && !impactedSet.has(PATTERN_CATALOG_PATH)) {
      refreshEdgeFiles.add(PATTERN_CATALOG_PATH);
    }

    // If permissions config changed, include the referenced Permission enums so we can
    // build role→permission edges (and slug contract edges) without forcing a full reindex.
    const permissionEnumFiles = new Set<string>();
    if (permissionsConfigPath) {
      try {
        const configContent = await fs.readFile(path.join(repoPath, permissionsConfigPath), 'utf-8');
        const baseNames = new Set<string>();
        const re = /([A-Za-z_\\][A-Za-z0-9_\\]*)\s*::/g;
        for (const match of configContent.matchAll(re)) {
          const raw = String(match[1] || '').trim().replace(/^\\+/, '');
          const parts = raw.split(/[\\/]+/).filter(Boolean);
          const baseName = parts.at(-1) || '';
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(baseName)) continue;
          if (!/Permission$/.test(baseName)) continue;
          baseNames.add(baseName);
        }

        if (baseNames.size > 0) {
          const phpFilesByBasename = new Map<string, string[]>();
          for (const fp of allRepoFiles) {
            if (!fp.endsWith('.php')) continue;
            if (shouldIgnorePath(fp)) continue;
            const base = path.posix.basename(fp);
            let list = phpFilesByBasename.get(base);
            if (!list) { list = []; phpFilesByBasename.set(base, list); }
            list.push(fp);
          }

          for (const baseName of baseNames) {
            const candidates = phpFilesByBasename.get(`${baseName}.php`) || [];
            for (const fp of candidates) {
              if (impactedSet.has(fp)) continue;
              if (!allRepoFileSet.has(fp)) continue;
              permissionEnumFiles.add(fp);
              refreshEdgeFiles.add(fp);
            }
          }
        }
      } catch {
        // best-effort
      }
    }

    // Heuristic: if routes changed, refresh all existing HTTP-wiring sources
    const routesTouched = impactedFiles.some(fp => ROUTE_FILE_PATH_RE.test(fp) || /(^|\/)app\/Providers\/RouteServiceProvider\.php$/i.test(fp));
    if (routesTouched) {
      const httpSources = await getHttpWiringSourceFiles();
      for (const fp of httpSources) {
        if (impactedSet.has(fp)) continue;
        if (!allRepoFileSet.has(fp)) continue;
        refreshEdgeFiles.add(fp);
      }

      // Defensive fallback: route changes can affect the FE→BE wiring for many callsites.
      // Don't rely solely on existing http-* edges (they may be missing due to prior partial indexes).
      for (const fp of allRepoFiles) {
        if (!/\.(ts|tsx|js|jsx)$/i.test(fp)) continue;
        if (shouldIgnorePath(fp)) continue;

        const normalized = fp.toLowerCase().replace(/\\/g, '/');
        if (!normalized.includes('/src/api/')) continue;
        if (impactedSet.has(fp)) continue;
        refreshEdgeFiles.add(fp);
      }

      // Include common HTTP client config surfaces so baseURL prefixes are available
      // when re-wiring API wrapper calls.
      for (const fp of allRepoFiles) {
        if (!/\.(ts|tsx|js|jsx)$/i.test(fp)) continue;
        if (shouldIgnorePath(fp)) continue;
        if (impactedSet.has(fp)) continue;

        const normalized = fp.toLowerCase().replace(/\\/g, '/');
        if (
          normalized.endsWith('/useconfigurehttpclient.ts') ||
          normalized.endsWith('/useconfigurehttpclient.tsx') ||
          normalized.endsWith('/configurehttpclient.ts') ||
          normalized.endsWith('/configurehttpclient.tsx')
        ) {
          refreshEdgeFiles.add(fp);
        }
      }
    }

    // If we're refreshing any TS/JS files (or routes), include Laravel route files + provider so HTTP wiring
    // can deterministically resolve controller targets (imports/use aliases + route prefixes).
    const hasFrontendOrRoutes = routesTouched || [...rebuildFiles, ...Array.from(refreshEdgeFiles)].some(fp => /\.(ts|tsx|js|jsx)$/i.test(fp));
    if (hasFrontendOrRoutes) {
      for (const fp of allRepoFiles) {
        if (ROUTE_FILE_PATH_RE.test(fp)) {
          if (!impactedSet.has(fp)) refreshEdgeFiles.add(fp);
        }
      }

      const routeProvider = allRepoFiles.find(fp => /(^|\/)app\/Providers\/RouteServiceProvider\.php$/i.test(fp));
      if (routeProvider && !impactedSet.has(routeProvider)) {
        refreshEdgeFiles.add(routeProvider);
      }
    }

    // Templates (Blade/MJML): template→PHP CALLS edges are "stringy" and get removed when PHP
    // nodes are rebuilt (DETACH DELETE). Prefer targeted refresh (upstream templates that already
    // call changed PHP) to avoid broad template rescans on every backend change.
    const hasPhpRebuild = rebuildFiles.some(fp => fp.endsWith('.php'));
    if (hasPhpRebuild) {
      const templateUpstreamFiles = upstreamFiles.filter(fp => fp.endsWith('.blade.php') || fp.endsWith('.mjml'));
      for (const fp of templateUpstreamFiles) {
        if (impactedSet.has(fp)) continue;
        if (!allRepoFileSet.has(fp)) continue;
        if (shouldIgnorePath(fp)) continue;
        refreshEdgeFiles.add(fp);
      }

      const phpTemplateRefreshMode = String(process.env.GITNEXUS_INCREMENTAL_PHP_TEMPLATE_REFRESH_MODE || 'targeted')
        .trim()
        .toLowerCase();

      // Optional fallback for compatibility/debugging.
      if (phpTemplateRefreshMode === 'broad' && templateUpstreamFiles.length === 0) {
        const templateFiles = allRepoFiles.filter(fp => fp.endsWith('.blade.php') || fp.endsWith('.mjml'));
        const MAX_TEMPLATE_REFRESH = 2000;
        if (templateFiles.length <= MAX_TEMPLATE_REFRESH) {
          debug(`fallback broad template refresh: ${templateFiles.length} template file(s)`);
          for (const fp of templateFiles) {
            if (impactedSet.has(fp)) continue;
            if (shouldIgnorePath(fp)) continue;
            refreshEdgeFiles.add(fp);
          }
        } else {
          debug(`skipping broad template fallback: too many template files (${templateFiles.length})`);
        }
      }
    }

    // Blade and MJML templates can call route('name'), but incremental route-name wiring requires
    // the route-file snippets to be present in the processed set (to build the named-route index).
    // Without this, a template-only change can drop template→controller `route-name:*` edges.
    const hasTemplateRouteNameProcessing = rebuildFiles.some(fp => fp.endsWith('.blade.php') || fp.endsWith('.mjml'))
      || Array.from(refreshEdgeFiles).some(fp => fp.endsWith('.blade.php') || fp.endsWith('.mjml'));
    if (hasTemplateRouteNameProcessing) {
      for (const fp of allRepoFiles) {
        if (!ROUTE_FILE_PATH_RE.test(fp)) continue;
        if (shouldIgnorePath(fp)) continue;
        if (impactedSet.has(fp)) continue;
        refreshEdgeFiles.add(fp);
      }

      const routeProvider = allRepoFiles.find(fp => /(^|\/)app\/Providers\/RouteServiceProvider\.php$/i.test(fp));
      if (routeProvider && !impactedSet.has(routeProvider)) {
        refreshEdgeFiles.add(routeProvider);
      }
    }

    const processedFiles = Array.from(new Set([...rebuildFiles, ...Array.from(refreshEdgeFiles)]));
    const processedSet = new Set(processedFiles);

    // Files that may receive new derived nodes even when their content did not change.
    // Keep this set small to avoid turning incremental updates into full reloads.
    const nodeInsertFiles = new Set<string>(rebuildFiles);
    if (shouldRefreshPatternCatalog && patternCatalogExists) {
      nodeInsertFiles.add(PATTERN_CATALOG_PATH);
    }

    // If permissions config changed, we may re-emit permission slug nodes that already exist
    // (e.g. ticket.view) alongside new ones (e.g. ticket.edit). Kuzu COPY with IGNORE_ERRORS
    // can still end up skipping the remainder of the file after a duplicate primary key.
    // Clear existing slug nodes for the referenced Permission enums so inserts are deterministic.
    if (permissionsConfigPath && permissionEnumFiles.size > 0) {
      bar.update(11, { phase: 'Incremental: clearing permission slug nodes...' });
      try {
        const escapedEnumPaths = Array.from(permissionEnumFiles)
          .map(fp => `'${fp.replace(/'/g, "''")}'`)
          .join(', ');

        await executeQuery(`
          MATCH (n:CodeElement)
          WHERE n.filePath IN [${escapedEnumPaths}]
            AND n.id STARTS WITH 'CodeElement:permission:'
          DETACH DELETE n
        `);
      } catch {
        // best-effort
      }
    }

    if (shouldRefreshPatternCatalog) {
      bar.update(11, { phase: 'Incremental: clearing pattern catalog nodes...' });
      try {
        const escapedCatalogPath = PATTERN_CATALOG_PATH.replace(/'/g, "''");
        await executeQuery(`
          MATCH (n:CodeElement)
          WHERE n.filePath = '${escapedCatalogPath}'
            AND n.id STARTS WITH 'CodeElement:pattern-catalog:'
          DETACH DELETE n
        `);
      } catch {
        // best-effort
      }
    }

    // Delete nodes for removed files
    if (deletedFiles.size > 0) {
      bar.update(12, { phase: 'Incremental: removing deleted files...' });
      debug(`deleteNodesForFiles (deleted) ${deletedFiles.size} file(s)`);
      await deleteNodesForFiles(Array.from(deletedFiles), { includeFileNode: true });
    }

    // Delete code/symbol nodes for changed files, but keep File nodes (preserves CONTAINS edges)
    if (rebuildFiles.length > 0) {
      bar.update(16, { phase: 'Incremental: clearing changed symbols...' });
      debug(`deleteNodesForFiles (changed) ${rebuildFiles.length} file(s)`);
      await deleteNodesForFiles(rebuildFiles, { includeFileNode: false });
    }

    // Clear outgoing edges for processed files (we will re-emit them from fresh analysis)
    bar.update(20, { phase: 'Incremental: clearing outgoing edges...' });
    const EDGE_TYPES_TO_CLEAR = ['IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS'];
    debug(`deleteOutgoingRelationshipsForFiles ${processedFiles.length} file(s)`);
    await deleteOutgoingRelationshipsForFiles(processedFiles, EDGE_TYPES_TO_CLEAR);

    // Load full symbol table from the existing index (post-delete)
    bar.update(24, { phase: 'Incremental: loading symbol table...' });
    debug('loadSymbolDefinitionsFromKuzu');
    const symbolTable = createSymbolTable();
    const existingDefs = await loadSymbolDefinitionsFromKuzu();
    debug(`loaded ${existingDefs.length} symbol defs`);
    for (const def of existingDefs) {
      symbolTable.add(def.filePath, def.name, def.nodeId, def.type);
    }

    // Read file contents for processed files (changed + edge refresh)
    bar.update(28, { phase: `Incremental: reading ${processedFiles.length} file(s)...` });
    debug(`readRepositoryFiles (${processedFiles.length})`);
    const processedEntries = await readRepositoryFiles(repoPath, processedFiles, (current, total, filePath) => {
      if (current % 50 !== 0 && current !== total) return;
      const pct = 28 + Math.round((current / Math.max(1, total)) * 14); // 28-42
      bar.update(Math.min(42, pct), { phase: `Reading ${current}/${total}: ${filePath}` });
    });
    debug(`processedEntries loaded: ${processedEntries.length}`);

    const contentByPath = new Map<string, string>();
    for (const entry of processedEntries) contentByPath.set(entry.path, entry.content);

    const JS_TS_FILE_RE = /\.(c|m)?(t|j)sx?$/i;
    const TEST_FILE_RE = /(^|\/)(__tests__|tests?|testing|spec)(\/|$)|(\.test\.|\.spec\.)|(_test\.)|(^test_)/i;
    const SHAPE_SIGNAL_RE = /\bqueryKeys\.|invalidateQueries\s*\(|refetchQueries\s*\(|setQueryData\s*\(|removeQueries\s*\(/;
    const isShapeCriticalPath = (filePath: string): boolean => {
      const normalized = filePath.replace(/\\/g, '/');
      if (normalized.includes('/Http/Requests/')) return true;
      if (normalized.includes('/Http/Resources/')) return true;
      if (normalized.includes('/Http/Controllers/')) return true;
      if (TEST_FILE_RE.test(normalized)) return true;
      if (/(^|\/)database\/migrations\/.+\.php$/i.test(normalized)) return true;
      return false;
    };
    const shapeSignalsTouched = impactedFiles.some(filePath => {
      if (isShapeCriticalPath(filePath)) return true;
      if (!JS_TS_FILE_RE.test(filePath)) return false;
      if (deletedFiles.has(filePath)) return true;
      const content = contentByPath.get(filePath) || '';
      return SHAPE_SIGNAL_RE.test(content);
    });
    const sourceSignalsTouched = impactedFiles.some(filePath => Boolean(getLanguageFromFilename(filePath)));
    let adaptiveLowSignalChangeSet = incrementalDerivedMode === 'adaptive'
      && !sourceSignalsTouched
      && !shapeSignalsTouched
      && !routeProviderTouched
      && !permissionsConfigPath
      && !hasTemplateRouteNameProcessing;
    let shouldRunAdaptiveHeavyPasses = !adaptiveLowSignalChangeSet;

    // Upsert File nodes with updated content for rebuild files (keeps existing edges)
    bar.update(43, { phase: 'Incremental: updating File nodes...' });
    const fileUpserts = rebuildFiles.map(fp => ({
      id: `File:${fp}`,
      name: path.posix.basename(fp),
      filePath: fp,
      content: contentByPath.get(fp) || '',
    }));
    if (shouldRefreshPatternCatalog && patternCatalogExists && !rebuildFilesSet.has(PATTERN_CATALOG_PATH)) {
      const catalogContent = contentByPath.get(PATTERN_CATALOG_PATH);
      if (catalogContent !== undefined) {
        fileUpserts.push({
          id: `File:${PATTERN_CATALOG_PATH}`,
          name: path.posix.basename(PATTERN_CATALOG_PATH),
          filePath: PATTERN_CATALOG_PATH,
          content: catalogContent,
        });
      }
    }
    await executeWithReusedStatement(
      `MERGE (n:File {id: $id}) SET n.name = $name, n.filePath = $filePath, n.content = $content`,
      fileUpserts,
    );

    // Build a partial graph from the processed files
    bar.update(46, { phase: 'Incremental: parsing changed files...' });
    const workGraph = createKnowledgeGraph();
    const importMap = createImportMap();
    const phpUseAliases = createPhpUseAliasMap();
    const astCache = createASTCache(Math.max(10, processedEntries.length));

    // Worker parsing — same fast path used by full pipeline
    let workerPool: WorkerPool | undefined;
    try {
      const workerUrl = new URL('../core/ingestion/workers/parse-worker.js', import.meta.url);
      workerPool = createWorkerPool(workerUrl);
    } catch {
      // Sequential fallback inside processParsing
    }

    let workerData: Awaited<ReturnType<typeof processParsing>> = null;
    try {
      workerData = await processParsing(
        workGraph,
        processedEntries,
        symbolTable,
        astCache,
        (current, total, filePath) => {
          if (current % 50 !== 0 && current !== total) return;
          const pct = 46 + Math.round((current / Math.max(1, total)) * 10); // 46-56
          bar.update(Math.min(56, pct), { phase: `Parsing ${current}/${total}: ${filePath}` });
        },
        workerPool,
      );
    } finally {
      await workerPool?.terminate();
    }

    if (!workerData) {
      throw new Error('Incremental parsing failed (no worker data)');
    }

    // Blade template nodes/edges: only emit from blade files we processed (rebuild + refresh)
    const allBladePaths = allRepoFiles.filter(fp => fp.endsWith('.blade.php'));
    const bladeRebuildPaths = new Set<string>(rebuildFiles.filter(fp => fp.endsWith('.blade.php')));
    processBladeTemplatesIncremental(
      workGraph,
      processedEntries,
      {
        allBladeTemplatePaths: allBladePaths,
        allFilePaths: allRepoFileSet,
        rebuildBladePaths: bladeRebuildPaths,
      }
    );
    processMjmlIncludes(workGraph, processedEntries, allRepoFileSet);
    if (shouldRefreshPatternCatalog && patternCatalogExists) {
      processPatternCatalogTemplates(workGraph, processedEntries, allRepoFileSet);
    }

    // Imports (fast path: uses worker-extracted imports)
    bar.update(58, { phase: 'Incremental: resolving imports...' });
    await processImportsFromExtracted(
      workGraph,
      allRepoFiles,
      workerData.imports,
      importMap,
      phpUseAliases,
      (current, total) => {
        if (current % 200 !== 0 && current !== total) return;
        const pct = 58 + Math.round((current / Math.max(1, total)) * 6); // 58-64
        bar.update(Math.min(64, pct), { phase: `Imports ${current}/${total}` });
      },
      repoPath,
    );

    // Calls + heritage from extracted data
    bar.update(65, { phase: 'Incremental: tracing calls...' });
    await processCallsFromExtracted(
      workGraph,
      workerData.calls,
      symbolTable,
      importMap,
      phpUseAliases,
      workerData.phpAssignments,
      workerData.phpTraitUses,
      (current, total) => {
        if (current % 200 !== 0 && current !== total) return;
        const pct = 65 + Math.round((current / Math.max(1, total)) * 5); // 65-70
        bar.update(Math.min(70, pct), { phase: `Calls ${current}/${total}` });
      },
    );

    bar.update(70, { phase: 'Incremental: extracting inheritance...' });
    await processHeritageFromExtracted(
      workGraph,
      workerData.heritage,
      symbolTable,
      (current, total) => {
        if (current % 200 !== 0 && current !== total) return;
        const pct = 70 + Math.round((current / Math.max(1, total)) * 3); // 70-73
        bar.update(Math.min(73, pct), { phase: `Heritage ${current}/${total}` });
      },
    );

    // Laravel wiring + semantic enrichment (only across processed files; confidence-first)
    bar.update(74, { phase: 'Incremental: Laravel wiring...' });
    const bladeStubs = allBladePaths
      .filter(fp => !processedSet.has(fp))
      .map(fp => ({ path: fp, content: '' }));
    const laravelFiles = [...processedEntries, ...bladeStubs];

    await processLaravelViewsAndMail(workGraph, laravelFiles, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelEvents(workGraph, laravelFiles, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelEventDispatch(workGraph, laravelFiles, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelSchedule(workGraph, laravelFiles, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelJobDispatch(workGraph, laravelFiles, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelTacticianDispatch(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelNotifications(workGraph, laravelFiles, astCache, symbolTable, importMap, phpUseAliases);
    processLaravelRoutes(workGraph, processedEntries, symbolTable, importMap, phpUseAliases);
    await processLaravelHttpWiring(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelRouteNameWiring(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    processTemplateMethodCallWiring(workGraph, processedEntries, symbolTable);
    await processLaravelSemanticEdges(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelEloquentRelationships(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelEloquentLoadEdges(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelResourceContracts(workGraph, processedEntries, astCache, symbolTable, importMap);
    await processLaravelPermissionsConfig(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    processLaravelRouteMiddlewareAuthorization(workGraph, processedEntries, symbolTable, importMap, phpUseAliases);
    processBladeAuthorization(workGraph, processedEntries, symbolTable);
    await processPhpMatchReturnEdges(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelAuthorization(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processReactQueryKeyWiring(workGraph, processedEntries, astCache, symbolTable, importMap);

    // Build an insertion graph: insert nodes only for rebuild files, but edges for all processed sources.
    bar.update(78, { phase: 'Incremental: preparing Kuzu load...' });
    const insertGraph = createKnowledgeGraph();

    const nodeFilePathById = new Map<string, string>();
    for (const node of workGraph.nodes) {
      const fp = String(node.properties?.filePath || '').trim();
      if (!fp) continue;
      nodeFilePathById.set(node.id, fp);
      if (nodeInsertFiles.has(fp)) {
        insertGraph.addNode(node);
        continue;
      }

      // Derived permission slugs: these nodes belong to the Permission enum filePath (not the changed config),
      // but they can be created/updated when config/permissions.php changes.
      if (node.label === 'CodeElement' && node.id.startsWith('CodeElement:permission:')) {
        insertGraph.addNode(node);
      }
    }

    const getSourceFilePathForEdge = (sourceId: string): string | null => {
      const fromGraph = nodeFilePathById.get(sourceId);
      if (fromGraph) return fromGraph;
      return getFilePathFromNodeId(sourceId);
    };

    for (const rel of workGraph.relationships) {
      const srcFilePath = getSourceFilePathForEdge(rel.sourceId);
      if (!srcFilePath) continue;

      // Only insert parsed structure edges when the source file was rebuilt (otherwise duplicates).
      if (rel.type === 'DEFINES' || rel.type === 'MEMBER_OF' || rel.type === 'CONTAINS') {
        if (!nodeInsertFiles.has(srcFilePath)) {
          // Permission slug CodeElements can be newly created even when the enum file didn't change;
          // allow DEFINES edges from the enum file to the slug nodes without re-inserting the full enum symbols.
          if (rel.type === 'DEFINES' && rel.targetId.startsWith('CodeElement:permission:') && processedSet.has(srcFilePath)) {
            // ok
          } else {
            continue;
          }
        }
      } else {
        // Only insert non-structure edges for files we explicitly refreshed.
        if (!processedSet.has(srcFilePath)) continue;
      }

      insertGraph.addRelationship(rel);
    }

    // Refine adaptive low-signal gating with observed incremental graph delta.
    // This avoids expensive derived rebuilds when source edits produce minimal graph churn.
    if (incrementalDerivedMode === 'adaptive' && shouldRunAdaptiveHeavyPasses) {
      const insertedNodeCount = insertGraph.nodes.length;
      const insertedRelationshipCount = insertGraph.relationships.length;
      let highSignalDerivedEdgeCount = 0;
      for (const rel of insertGraph.relationships) {
        const reason = String(rel.reason || '').toLowerCase();
        if (
          rel.type === 'INVALIDATES_KEY'
          || rel.type === 'VALIDATES_FIELD'
          || rel.type === 'SERIALIZES_FIELD'
          || rel.type === 'READS_FIELD'
          || rel.type === 'WRITES_FIELD'
          || rel.type === 'DERIVES_FROM'
          || rel.type === 'DERIVES_FROM_COLUMN'
          || rel.type === 'TESTS_SHAPE'
          || reason.startsWith('laravel-route')
          || reason.startsWith('laravel-endpoint:')
          || reason.startsWith('laravel-authorize:')
          || reason.startsWith('laravel-gate:')
          || reason.startsWith('laravel-can:')
          || reason.startsWith('react-query-key:')
          || reason.startsWith('micro-dataflow:')
          || reason.startsWith('route-name:')
          || reason.startsWith('precision-overlay:')
          || reason.startsWith('value-graph:')
        ) {
          highSignalDerivedEdgeCount++;
          if (highSignalDerivedEdgeCount >= 32) break;
        }
      }

      const smallChangeWindow = fileChangesTotal <= 4 && rebuildFiles.length <= 4 && deletedFiles.size === 0;
      const boundedRefreshWindow = refreshEdgeFiles.size <= 24;
      const lowStructuralDelta = insertedNodeCount <= 180 && insertedRelationshipCount <= 220;
      if (
        smallChangeWindow
        && boundedRefreshWindow
        && lowStructuralDelta
        && highSignalDerivedEdgeCount <= 10
        && !routesTouched
        && !permissionsConfigPath
        && !hasTemplateRouteNameProcessing
        && !shapeSignalsTouched
      ) {
        adaptiveLowSignalChangeSet = true;
        shouldRunAdaptiveHeavyPasses = false;
      }
    }

    const recomputeCandidateWindow = fileChangesTotal <= Math.max(8, Math.min(60, incrementalMaxChanges));
    const entrypointSignalsTouched = routesTouched || hasTemplateRouteNameProcessing || impactedFiles.some(filePath => {
      const normalized = filePath.replace(/\\/g, '/');
      return (
        /(^|\/)routes\/[^/]+\.php$/i.test(normalized)
        || normalized.includes('/Http/Controllers/')
        || normalized.includes('/src/api/')
        || /(^|\/)app\/Providers\/RouteServiceProvider\.php$/i.test(normalized)
        || /(^|\/)config\/permissions\.php$/i.test(normalized)
      );
    });
    const autoRecomputeCommunities = incrementalDerivedMode === 'adaptive'
      && shouldRunAdaptiveHeavyPasses
      && recomputeCandidateWindow
      && (entrypointSignalsTouched || shapeSignalsTouched);
    const autoRecomputeProcesses = incrementalDerivedMode === 'adaptive'
      && shouldRunAdaptiveHeavyPasses
      && recomputeCandidateWindow
      && (entrypointSignalsTouched || shapeSignalsTouched);
    const recomputeCommunities = options?.incrementalRecomputeCommunities || autoRecomputeCommunities;
    const recomputeProcesses = options?.incrementalRecomputeProcesses || autoRecomputeProcesses;

    const insertContents = new Map<string, string>();
    for (const fp of new Set([...nodeInsertFiles, ...permissionEnumFiles])) {
      insertContents.set(fp, contentByPath.get(fp) || '');
    }

    // Load partial graph into existing KuzuDB
    const t0Kuzu = Date.now();
    let kuzuMsgCount = 0;
    const kuzuResult = await loadGraphToKuzu(insertGraph, insertContents, storagePath, (msg) => {
      kuzuMsgCount++;
      const pct = 78 + Math.min(10, Math.round((kuzuMsgCount / (kuzuMsgCount + 10)) * 10)); // 78-88
      bar.update(pct, { phase: msg });
    });
    const kuzuTime = ((Date.now() - t0Kuzu) / 1000).toFixed(1);

    // Ensure FTS only when schema/metadata indicates it is missing.
    const ftsTime = shouldEnsureFtsIndexes ? await ensureFtsIndexes() : '0.0';

    const kuzuWarnings = [...kuzuResult.warnings, ...profileWarnings];
    if (incrementalDerivedFastDeprecated) {
      kuzuWarnings.push('Incremental derived mode "fast" is deprecated; running as "full".');
    }

    let precisionSummary: {
      mode: PrecisionOverlayMode;
      provider: string;
      overlayFound: boolean;
      declaredRelations: number;
      emittedEdges: number;
      producer?: string;
      producerCacheHit?: boolean;
      producerSkipped?: boolean;
      producerSkipReason?: string;
    } | undefined;
    let microDataflowSummary: {
      emittedEdges: number;
      requestFieldReads: number;
      responseFieldWrites: number;
      endpointRequestClosures: number;
      endpointResponseClosures: number;
      queryInvalidationClosures: number;
      endpointEventClosures: number;
      endpointPermissionClosures: number;
    } | undefined;
    let valueGraphSummary: {
      valueCount: number;
      edgeCount: number;
      permissionValues: number;
      endpointValues: number;
      routeNameValues: number;
      cacheKeyValues: number;
      roleValues: number;
      featureFlagValues: number;
      configKeyValues: number;
      envVarValues: number;
      queueNameValues: number;
      broadcastChannelValues: number;
      eventNameValues: number;
      commandNameValues: number;
      i18nKeyValues: number;
      queryKeyFamilyValues: number;
      routeSegmentValues: number;
      tableNameValues: number;
      tableColumnValues: number;
      tailwindClassValues: number;
      componentPropValues: number;
      reactContextValues: number;
      providerSurfaceValues: number;
      skippedDuplicates: number;
      skippedMalformed: number;
    } | undefined;
    let provenanceSummary: {
      emittedEdges: number;
      routeExpansionEdges: number;
      enumToSlugEdges: number;
      configDrivenEdges: number;
      compiledArtifactEdges: number;
      frameworkDerivedEdges: number;
      skippedDuplicates: number;
      skippedMalformed: number;
    } | undefined;
    let evidenceSpanSummary: {
      nodeEvidenceCount: number;
      edgeEvidenceCount: number;
      uniqueFiles: number;
      primarySpanCount: number;
      witnessSpanCount: number;
      proofSpanCount: number;
    } | undefined;
    let summaryOverlaySummary: {
      symbolCount: number;
      fileCount: number;
      sliceCount: number;
      communityCount: number;
      processCount: number;
      archetypeCount: number;
    } | undefined;
    let closureTemplateSummary: {
      totalTemplates: number;
      totalSlices: number;
      totalCoveredSlots: number;
      totalRoleExpectations: number;
    } | undefined;
    const flowNodeLabels = [
      'File',
      'Function',
      'Class',
      'Interface',
      'Method',
      'CodeElement',
      'Struct',
      'Enum',
      'Macro',
      'Typedef',
      'Union',
      'Namespace',
      'Trait',
      'Impl',
      'TypeAlias',
      'Const',
      'Static',
      'Property',
      'Record',
      'Delegate',
      'Annotation',
      'Constructor',
      'Template',
      'Module',
    ] as const;
    const backtickFlowNodeLabels = new Set([
      'Struct',
      'Enum',
      'Macro',
      'Typedef',
      'Union',
      'Namespace',
      'Trait',
      'Impl',
      'TypeAlias',
      'Const',
      'Static',
      'Property',
      'Record',
      'Delegate',
      'Annotation',
      'Constructor',
      'Template',
      'Module',
    ]);
    type IncrementalNodeRowVariant = 'flow' | 'value' | 'heuristic' | 'slice' | 'process';
    const incrementalNodeRows = new Map<string, any[]>();
    const flowNodeLabelsWithLineSpans = new Set<string>([
      'Function',
      'Class',
      'Interface',
      'Method',
      'CodeElement',
      'Struct',
      'Enum',
      'Macro',
      'Typedef',
      'Union',
      'Namespace',
      'Trait',
      'Impl',
      'TypeAlias',
      'Const',
      'Static',
      'Property',
      'Record',
      'Delegate',
      'Annotation',
      'Constructor',
      'Template',
      'Module',
      'TestCase',
    ]);
    const resolveCypherLabel = (label: string): string => (
      backtickFlowNodeLabels.has(label) ? `\`${label}\`` : label
    );
    const loadIncrementalNodeRows = async (label: string, variant: IncrementalNodeRowVariant): Promise<any[]> => {
      const cacheKey = `${variant}:${label}`;
      const cached = incrementalNodeRows.get(cacheKey);
      if (cached) return cached;
      const cypherLabel = resolveCypherLabel(label);
      let variantQuery = '';

      if (variant === 'flow') {
        if (flowNodeLabelsWithLineSpans.has(label)) {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.name AS name,
                   n.filePath AS filePath,
                   n.startLine AS startLine,
                   n.endLine AS endLine
          `;
        } else {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.name AS name,
                   n.filePath AS filePath
          `;
        }
      } else if (variant === 'value') {
        if (label === 'CacheKey') {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.label AS label,
                   '' AS filePath,
                   n.keyName AS keyName,
                   '' AS tableName,
                   '' AS columnName,
                   '' AS content
          `;
        } else if (label === 'DBTable') {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.label AS label,
                   n.sourceFilePath AS filePath,
                   '' AS keyName,
                   n.tableName AS tableName,
                   '' AS columnName,
                   '' AS content
          `;
        } else if (label === 'DBColumn') {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.label AS label,
                   n.sourceFilePath AS filePath,
                   '' AS keyName,
                   n.tableName AS tableName,
                   n.columnName AS columnName,
                   '' AS content
          `;
        } else if (label === 'File') {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.name AS name,
                   n.filePath AS filePath,
                   '' AS keyName,
                   '' AS tableName,
                   '' AS columnName,
                   n.content AS content
          `;
        } else {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.name AS name,
                   n.filePath AS filePath,
                   '' AS keyName,
                   '' AS tableName,
                   '' AS columnName,
                   '' AS content
          `;
        }
      } else if (variant === 'slice') {
        variantQuery = `
          MATCH (n:${cypherLabel})
          RETURN n.id AS id,
                 n.label AS name,
                 n.heuristicLabel AS heuristicLabel,
                 '' AS filePath,
                 n.sliceType AS sliceType,
                 n.closureSlots AS closureSlots,
                 n.closedSlots AS closedSlots
        `;
      } else if (variant === 'process') {
        variantQuery = `
          MATCH (n:${cypherLabel})
          RETURN n.id AS id,
                 n.label AS name,
                 n.heuristicLabel AS heuristicLabel,
                 '' AS filePath,
                 n.processType AS processType,
                 n.stepCount AS stepCount
        `;
      } else {
        if (label === 'DBTable' || label === 'DBColumn') {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.label AS name,
                   n.heuristicLabel AS heuristicLabel,
                   n.sourceFilePath AS filePath
          `;
        } else {
          variantQuery = `
            MATCH (n:${cypherLabel})
            RETURN n.id AS id,
                   n.label AS name,
                   n.heuristicLabel AS heuristicLabel,
                   '' AS filePath
          `;
        }
      }
      const rows = await executeQuery(variantQuery);
      incrementalNodeRows.set(cacheKey, rows);
      return rows;
    };
    let incrementalCoreRelationRows: any[] | null = null;
    const loadIncrementalCoreRelationRows = async (): Promise<any[]> => {
      if (incrementalCoreRelationRows) return incrementalCoreRelationRows;
      incrementalCoreRelationRows = await executeQuery(`
        MATCH (a)-[r:CodeRelation]->(b)
        WHERE r.type IN ['CALLS', 'VALIDATES_FIELD', 'SERIALIZES_FIELD', 'DEFINES', 'INVALIDATES_KEY', 'READS_FIELD', 'WRITES_FIELD']
        RETURN a.id AS sourceId,
               b.id AS targetId,
               r.type AS type,
               r.confidence AS confidence,
               r.reason AS reason
      `);
      return incrementalCoreRelationRows;
    };
    const incrementalCallHeritageRelationRowsByMinConfidence = new Map<string, any[]>();
    const loadIncrementalCallHeritageRelationRows = async (minConfidence?: number): Promise<any[]> => {
      const min = Number.isFinite(minConfidence) ? Number(minConfidence) : null;
      const cacheKey = min === null ? 'all' : `min:${min.toFixed(2)}`;
      const cached = incrementalCallHeritageRelationRowsByMinConfidence.get(cacheKey);
      if (cached) return cached;

      const confidenceClause = min !== null ? `AND r.confidence >= ${min}` : '';
      const rows = await executeQuery(`
        MATCH (a)-[r:CodeRelation]->(b)
        WHERE r.type IN ['CALLS', 'EXTENDS', 'IMPLEMENTS']
          ${confidenceClause}
        RETURN a.id AS sourceId,
               b.id AS targetId,
               r.type AS type,
               r.confidence AS confidence,
               r.reason AS reason
      `);
      incrementalCallHeritageRelationRowsByMinConfidence.set(cacheKey, rows);
      return rows;
    };
    const incrementalProcessCodeRowsByLabel = new Map<'Function' | 'Method' | 'CodeElement', any[]>();
    const loadIncrementalProcessCodeRows = async (label: 'Function' | 'Method' | 'CodeElement'): Promise<any[]> => {
      const cached = incrementalProcessCodeRowsByLabel.get(label);
      if (cached) return cached;

      let rows: any[] = [];
      if (label === 'CodeElement') {
        rows = await executeQuery(`
          MATCH (n:CodeElement)
          WHERE n.name STARTS WITH 'endpoint:'
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.isExported AS isExported
        `);
      } else {
        rows = await executeQuery(`
          MATCH (n:${label})
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.isExported AS isExported
        `);
      }
      incrementalProcessCodeRowsByLabel.set(label, rows);
      return rows;
    };

    const precisionPassStartedAt = Date.now();
    if (!shouldRunAdaptiveHeavyPasses) {
      skipDerivedPass('precision-overlay');
    } else {
      bar.update(88, { phase: 'Incremental: refreshing precision overlay...' });
      try {
        await executeQuery(`
          MATCH ()-[r:CodeRelation]->()
          WHERE r.reason STARTS WITH 'precision-overlay:'
          DELETE r
        `);

        const precisionInputGraph = createKnowledgeGraph();
        for (const label of flowNodeLabels) {
          const rows = await loadIncrementalNodeRows(String(label), 'flow');

          for (const row of rows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;
            precisionInputGraph.addNode({
              id,
              label: label as NodeLabel,
              properties: {
                name: String(row.name ?? row[1] ?? '').trim(),
                filePath: String(row.filePath ?? row[2] ?? '').trim(),
                startLine: Number(row.startLine ?? row[3] ?? 0) || undefined,
                endLine: Number(row.endLine ?? row[4] ?? 0) || undefined,
              },
            });
          }
        }

        const precisionResult = await processPrecisionOverlay(
          repoPath,
          precisionInputGraph,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(88, { phase: `Precision overlay: ${message}` });
          },
          {
            producerMode: precisionOverlayMode,
            producerForceRefresh: options?.precisionOverlayForce,
            overlayPath: options?.precisionOverlayPath,
          },
        );

        precisionSummary = {
          mode: precisionOverlayMode,
          provider: precisionResult.stats.provider,
          overlayFound: precisionResult.stats.overlayFound,
          declaredRelations: precisionResult.stats.declaredRelations,
          emittedEdges: precisionResult.stats.emittedEdges,
          producer: precisionResult.stats.producer,
          producerCacheHit: precisionResult.stats.producerCacheHit,
          producerSkipped: precisionResult.stats.producerSkipped,
          producerSkipReason: precisionResult.stats.producerSkipReason,
        };

        if (precisionResult.edges.length > 0) {
          const precisionInsertGraph = createKnowledgeGraph();
          for (const edge of precisionResult.edges) {
            precisionInsertGraph.addRelationship(edge);
          }
          await loadGraphToKuzu(precisionInsertGraph, new Map(), storagePath, (msg) => {
            bar.update(88, { phase: msg });
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to refresh precision overlay (${msg.slice(0, 120)})`);
      }
    }
    markPassTiming('precision-overlay', precisionPassStartedAt);

    const microDataflowPassStartedAt = Date.now();
    if (!shouldRunAdaptiveHeavyPasses) {
      skipDerivedPass('micro-dataflow');
    } else {
      bar.update(88, { phase: 'Incremental: refreshing targeted micro-dataflow...' });
      try {
        await executeQuery(`
          MATCH ()-[r:CodeRelation]->()
          WHERE r.reason STARTS WITH 'micro-dataflow:'
          DELETE r
        `);

        const microDataflowGraph = createKnowledgeGraph();

        for (const label of flowNodeLabels) {
          const rows = await loadIncrementalNodeRows(String(label), 'flow');

          for (const row of rows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;
            microDataflowGraph.addNode({
              id,
              label: label as NodeLabel,
              properties: {
                name: String(row.name ?? row[1] ?? '').trim(),
                filePath: String(row.filePath ?? row[2] ?? '').trim(),
                startLine: Number(row.startLine ?? row[3] ?? 0) || undefined,
                endLine: Number(row.endLine ?? row[4] ?? 0) || undefined,
              },
            });
          }
        }

        const relationshipRows = await loadIncrementalCoreRelationRows();

        for (const row of relationshipRows) {
          const sourceId = String(row.sourceId ?? row[0] ?? '').trim();
          const targetId = String(row.targetId ?? row[1] ?? '').trim();
          const type = String(row.type ?? row[2] ?? '').trim();
          if (!sourceId || !targetId || !type) continue;

          microDataflowGraph.addRelationship({
            id: `inc_micro_${type}_${sourceId}->${targetId}`,
            type: type as RelationshipType,
            sourceId,
            targetId,
            confidence: Number(row.confidence ?? row[3] ?? 0.8) || 0.8,
            reason: String(row.reason ?? row[4] ?? ''),
          });
        }

        const microDataflowResult = await processMicroDataflow(
          microDataflowGraph,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(88, { phase: `Micro-dataflow: ${message}` });
          },
        );

        microDataflowSummary = {
          emittedEdges: microDataflowResult.stats.emittedEdges,
          requestFieldReads: microDataflowResult.stats.requestFieldReads,
          responseFieldWrites: microDataflowResult.stats.responseFieldWrites,
          endpointRequestClosures: microDataflowResult.stats.endpointRequestClosures,
          endpointResponseClosures: microDataflowResult.stats.endpointResponseClosures,
          queryInvalidationClosures: microDataflowResult.stats.queryInvalidationClosures,
          endpointEventClosures: microDataflowResult.stats.endpointEventClosures,
          endpointPermissionClosures: microDataflowResult.stats.endpointPermissionClosures,
        };

        if (microDataflowResult.edges.length > 0) {
          const microInsertGraph = createKnowledgeGraph();
          for (const edge of microDataflowResult.edges) {
            microInsertGraph.addRelationship(edge);
          }
          await loadGraphToKuzu(microInsertGraph, new Map(), storagePath, (msg) => {
            bar.update(88, { phase: msg });
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to refresh targeted micro-dataflow (${msg.slice(0, 120)})`);
      }
    }
    markPassTiming('micro-dataflow', microDataflowPassStartedAt);

    // Optional: recompute derived views in incremental mode (Communities + Processes).
    // This is disabled by default because it can be expensive on large graphs.
    let recomputedMemberships: Array<{ nodeId: string; communityId: string }> | null = null;
    if (recomputeCommunities) {
      bar.update(88, { phase: 'Incremental: recomputing communities...' });
      try {
        const communityInputGraph = createKnowledgeGraph();
        const functionNodeIds = new Set<string>();
        const classNodeIds = new Set<string>();
        const methodNodeIds = new Set<string>();
        const interfaceNodeIds = new Set<string>();

        const addNodeRows = (
          label: 'Function' | 'Class' | 'Method' | 'Interface',
          rows: any[],
          idSet: Set<string>,
        ) => {
          for (const row of rows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;
            const name = String(row.name ?? row[1] ?? '').trim();
            const filePath = String(row.filePath ?? row[2] ?? '').trim();
            communityInputGraph.addNode({
              id,
              label,
              properties: {
                name,
                filePath,
              }
            });
            idSet.add(id);
          }
        };

        const addRel = (type: 'CALLS' | 'EXTENDS' | 'IMPLEMENTS', row: any) => {
          const sourceId = String(row.sourceId ?? row[0] ?? '').trim();
          const targetId = String(row.targetId ?? row[1] ?? '').trim();
          if (!sourceId || !targetId) return;
          communityInputGraph.addRelationship({
            id: `inc_comm_${type}_${communityInputGraph.relationshipCount}_${sourceId}->${targetId}`,
            type,
            sourceId,
            targetId,
            confidence: Number(row.confidence ?? row[2] ?? 1.0) || 1.0,
            reason: String(row.reason ?? row[3] ?? ''),
          });
        };

        addNodeRows('Function', await loadIncrementalNodeRows('Function', 'flow'), functionNodeIds);
        addNodeRows('Class', await loadIncrementalNodeRows('Class', 'flow'), classNodeIds);
        addNodeRows('Method', await loadIncrementalNodeRows('Method', 'flow'), methodNodeIds);
        addNodeRows('Interface', await loadIncrementalNodeRows('Interface', 'flow'), interfaceNodeIds);

        const relationRows = await loadIncrementalCallHeritageRelationRows();
        for (const row of relationRows) {
          const sourceId = String(row.sourceId ?? row[0] ?? '').trim();
          const type = String(row.type ?? row[2] ?? '').trim();
          if (!sourceId || !type) continue;
          if (type === 'CALLS') {
            if (!functionNodeIds.has(sourceId) && !methodNodeIds.has(sourceId)) continue;
            addRel('CALLS', row);
            continue;
          }
          if (type === 'EXTENDS') {
            if (!classNodeIds.has(sourceId) && !interfaceNodeIds.has(sourceId)) continue;
            addRel('EXTENDS', row);
            continue;
          }
          if (type === 'IMPLEMENTS') {
            if (!classNodeIds.has(sourceId)) continue;
            addRel('IMPLEMENTS', row);
          }
        }

        const communityResult = await processCommunities(communityInputGraph, (message, progress) => {
          if (progress % 20 !== 0 && progress !== 100) return;
          bar.update(88, { phase: `Communities: ${message}` });
        });
        recomputedMemberships = communityResult.memberships;

        await executeQuery(`MATCH (c:Community) DETACH DELETE c`);

        const communityInsertGraph = createKnowledgeGraph();
        for (const comm of communityResult.communities) {
          communityInsertGraph.addNode({
            id: comm.id,
            label: 'Community',
            properties: {
              name: comm.label,
              filePath: '',
              heuristicLabel: comm.heuristicLabel,
              cohesion: comm.cohesion,
              symbolCount: comm.symbolCount,
            }
          });
        }
        for (const membership of communityResult.memberships) {
          communityInsertGraph.addRelationship({
            id: `${membership.nodeId}_member_of_${membership.communityId}`,
            type: 'MEMBER_OF',
            sourceId: membership.nodeId,
            targetId: membership.communityId,
            confidence: 1.0,
            reason: 'leiden-algorithm',
          });
        }

        await loadGraphToKuzu(communityInsertGraph, new Map(), storagePath, (msg) => {
          bar.update(88, { phase: msg });
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to recompute communities (${msg.slice(0, 120)})`);
      }
    }

    if (recomputeProcesses) {
      bar.update(89, { phase: 'Incremental: recomputing processes...' });
      try {
        const processInputGraph = createKnowledgeGraph();
        const processFunctionIds = new Set<string>();
        const processMethodIds = new Set<string>();
        const processEndpointIds = new Set<string>();

        const addCodeRows = (
          label: 'Function' | 'Method' | 'CodeElement',
          rows: any[],
          idSet: Set<string>,
        ) => {
          for (const row of rows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;
            const name = String(row.name ?? row[1] ?? '').trim();
            const filePath = String(row.filePath ?? row[2] ?? '').trim();
            const language = getLanguageFromFilename(filePath) ?? 'javascript';
            const isExported = row.isExported === true || row.isExported === 1 || row.isExported === 'true';
            processInputGraph.addNode({
              id,
              label,
              properties: {
                name,
                filePath,
                language,
                isExported,
              }
            });
            idSet.add(id);
          }
        };

        addCodeRows('Function', await loadIncrementalProcessCodeRows('Function'), processFunctionIds);
        addCodeRows('Method', await loadIncrementalProcessCodeRows('Method'), processMethodIds);
        addCodeRows('CodeElement', await loadIncrementalProcessCodeRows('CodeElement'), processEndpointIds);

        const callRows = await loadIncrementalCallHeritageRelationRows(0.5);
        for (const row of callRows) {
          const sourceId = String(row.sourceId ?? row[0] ?? '').trim();
          const targetId = String(row.targetId ?? row[1] ?? '').trim();
          const type = String(row.type ?? row[2] ?? '').trim();
          const confidence = Number(row.confidence ?? row[3] ?? 1.0) || 1.0;
          if (type !== 'CALLS' || !sourceId || !targetId) continue;
          if (
            !processFunctionIds.has(sourceId)
            && !processMethodIds.has(sourceId)
            && !processEndpointIds.has(sourceId)
          ) {
            continue;
          }
          processInputGraph.addRelationship({
            id: `inc_proc_CALLS_${processInputGraph.relationshipCount}_${sourceId}->${targetId}`,
            type: 'CALLS',
            sourceId,
            targetId,
            confidence,
            reason: String(row.reason ?? row[4] ?? ''),
          });
        }

        const symbolCount = processInputGraph.nodes.length;
        const dynamicMaxProcesses = Math.max(20, Math.min(300, Math.round(symbolCount / 10)));

        const processResult = await processProcesses(
          processInputGraph,
          recomputedMemberships || [],
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Processes: ${message}` });
          },
          { maxProcesses: dynamicMaxProcesses, minSteps: 3 },
        );

        await executeQuery(`MATCH (p:Process) DETACH DELETE p`);

        const processInsertGraph = createKnowledgeGraph();
        for (const proc of processResult.processes) {
          processInsertGraph.addNode({
            id: proc.id,
            label: 'Process',
            properties: {
              name: proc.label,
              filePath: '',
              heuristicLabel: proc.heuristicLabel,
              processType: proc.processType,
              stepCount: proc.stepCount,
              communities: proc.communities,
              entryPointId: proc.entryPointId,
              terminalId: proc.terminalId,
            }
          });
        }
        for (const step of processResult.steps) {
          processInsertGraph.addRelationship({
            id: `${step.nodeId}_step_${step.step}_${step.processId}`,
            type: 'STEP_IN_PROCESS',
            sourceId: step.nodeId,
            targetId: step.processId,
            confidence: 1.0,
            reason: 'trace-detection',
            step: step.step,
          });
        }

        await loadGraphToKuzu(processInsertGraph, new Map(), storagePath, (msg) => {
          bar.update(89, { phase: msg });
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to recompute processes (${msg.slice(0, 120)})`);
      }
    }

    const shouldRecomputeSlicesAndGaps = shouldRunAdaptiveHeavyPasses
      || sourceSignalsTouched
      || shapeSignalsTouched
      || entrypointSignalsTouched;
    const featureSlicePassStartedAt = Date.now();
    if (!shouldRecomputeSlicesAndGaps) {
      skipDerivedPass('slices');
    } else {
      bar.update(89, { phase: 'Incremental: recomputing feature slices...' });
      try {
        const featureSliceInputGraph = createKnowledgeGraph();
        const featureSliceNodeIds = new Set<string>();
        const sliceLabels = [
          'Function',
          'Class',
          'Interface',
          'Method',
          'CodeElement',
          'Struct',
          'Enum',
          'Macro',
          'Typedef',
          'Union',
          'Namespace',
          'Trait',
          'Impl',
          'TypeAlias',
          'Const',
          'Static',
          'Property',
          'Record',
          'Delegate',
          'Annotation',
          'Constructor',
          'Template',
          'Module',
        ] as const;

        for (const label of sliceLabels) {
          const rows = await loadIncrementalNodeRows(String(label), 'flow');

          for (const row of rows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;
            const name = String(row.name ?? row[1] ?? '').trim();
            const filePath = String(row.filePath ?? row[2] ?? '').trim();
            featureSliceInputGraph.addNode({
              id,
              label,
              properties: {
                name,
                filePath,
              },
            });
            featureSliceNodeIds.add(id);
          }
        }

        const callRows = await loadIncrementalCallHeritageRelationRows(0.9);
        for (const row of callRows) {
          const sourceId = String(row.sourceId ?? row[0] ?? '').trim();
          const targetId = String(row.targetId ?? row[1] ?? '').trim();
          const type = String(row.type ?? row[2] ?? '').trim();
          const confidence = Number(row.confidence ?? row[3] ?? 1.0) || 1.0;
          if (type !== 'CALLS') continue;
          if (!sourceId || !targetId) continue;
          if (!featureSliceNodeIds.has(sourceId) || !featureSliceNodeIds.has(targetId)) continue;
          featureSliceInputGraph.addRelationship({
            id: `inc_slice_CALLS_${featureSliceInputGraph.relationshipCount}_${sourceId}->${targetId}`,
            type: 'CALLS',
            sourceId,
            targetId,
            confidence,
            reason: String(row.reason ?? row[4] ?? ''),
          });
        }

        const featureSliceResult = await processFeatureSlices(
          featureSliceInputGraph,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Feature slices: ${message}` });
          },
        );

        await executeQuery(`MATCH (s:FeatureSlice) DETACH DELETE s`);

        const featureSliceInsertGraph = createKnowledgeGraph();
        for (const slice of featureSliceResult.slices) {
          featureSliceInsertGraph.addNode({
            id: slice.id,
            label: 'FeatureSlice',
            properties: {
              name: slice.label,
              filePath: '',
              heuristicLabel: slice.heuristicLabel,
              sliceType: slice.sliceType,
              anchorId: slice.anchorId,
              anchorName: slice.anchorName,
              closureSlots: slice.closureSlots,
              closedSlots: slice.closedSlots,
              closureScore: slice.closureScore,
            },
          });
        }

        for (const membership of featureSliceResult.memberships) {
          featureSliceInsertGraph.addRelationship({
            id: `${membership.nodeId}_member_of_${membership.sliceId}`,
            type: 'MEMBER_OF',
            sourceId: membership.nodeId,
            targetId: membership.sliceId,
            confidence: 1.0,
            reason: `feature-slice:${membership.role}`,
          });
        }

        await loadGraphToKuzu(featureSliceInsertGraph, new Map(), storagePath, (msg) => {
          bar.update(89, { phase: msg });
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to recompute feature slices (${msg.slice(0, 120)})`);
      }
    }
    markPassTiming('slices', featureSlicePassStartedAt);

    const gapPassStartedAt = Date.now();
    if (!shouldRecomputeSlicesAndGaps) {
      skipDerivedPass('gaps');
    } else {
      bar.update(89, { phase: 'Incremental: recomputing gap graph...' });
      try {
        const gapInputGraph = createKnowledgeGraph();
        const memberLabels = new Set([
          'Function',
          'Class',
          'Interface',
          'Method',
          'CodeElement',
          'Struct',
          'Enum',
          'Macro',
          'Typedef',
          'Union',
          'Namespace',
          'Trait',
          'Impl',
          'TypeAlias',
          'Const',
          'Static',
          'Property',
          'Record',
          'Delegate',
          'Annotation',
          'Constructor',
          'Template',
          'Module',
        ]);

        const sliceRows = await executeQuery(`
        MATCH (s:FeatureSlice)
        RETURN
          s.id AS id,
          s.label AS label,
          s.heuristicLabel AS heuristicLabel,
          s.sliceType AS sliceType,
          s.anchorId AS anchorId,
          s.anchorName AS anchorName,
          s.closureSlots AS closureSlots,
          s.closedSlots AS closedSlots,
          s.closureScore AS closureScore
        `);

        for (const row of sliceRows) {
          const id = String(row.id ?? row[0] ?? '').trim();
          if (!id) continue;
          gapInputGraph.addNode({
            id,
            label: 'FeatureSlice',
            properties: {
              name: String(row.label ?? row[1] ?? '').trim(),
              filePath: '',
              heuristicLabel: String(row.heuristicLabel ?? row[2] ?? '').trim(),
              sliceType: String(row.sliceType ?? row[3] ?? '').trim(),
              anchorId: String(row.anchorId ?? row[4] ?? '').trim(),
              anchorName: String(row.anchorName ?? row[5] ?? '').trim(),
              closureSlots: Array.isArray(row.closureSlots) ? row.closureSlots.map((slot: any) => String(slot)) : [],
              closedSlots: Array.isArray(row.closedSlots) ? row.closedSlots.map((slot: any) => String(slot)) : [],
              closureScore: Number(row.closureScore ?? row[8] ?? 0) || 0,
            },
          });
        }

        const membershipRows = await executeQuery(`
        MATCH (src)-[r:CodeRelation {type: 'MEMBER_OF'}]->(s:FeatureSlice)
        WHERE r.reason STARTS WITH 'feature-slice:'
        RETURN
          src.id AS sourceId,
          src.name AS sourceName,
          src.filePath AS sourceFilePath,
          labels(src) AS sourceLabels,
          s.id AS sliceId,
          r.reason AS reason
        `);

        for (const row of membershipRows) {
          const sourceId = String(row.sourceId ?? row[0] ?? '').trim();
          const sliceId = String(row.sliceId ?? row[4] ?? '').trim();
          if (!sourceId || !sliceId) continue;

          const sourceLabels = Array.isArray(row.sourceLabels) ? row.sourceLabels.map((label: any) => String(label)) : [];
          const primaryLabel = sourceLabels.find(label => memberLabels.has(label)) || 'CodeElement';
          if (!memberLabels.has(primaryLabel)) continue;

          gapInputGraph.addNode({
            id: sourceId,
            label: primaryLabel as NodeLabel,
            properties: {
              name: String(row.sourceName ?? row[1] ?? '').trim(),
              filePath: String(row.sourceFilePath ?? row[2] ?? '').trim(),
            },
          });

          gapInputGraph.addRelationship({
            id: `${sourceId}_member_of_${sliceId}`,
            type: 'MEMBER_OF',
            sourceId,
            targetId: sliceId,
            confidence: 1.0,
            reason: String(row.reason ?? row[5] ?? ''),
          });
        }

        const gapResult = await processGaps(
          gapInputGraph,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Gaps: ${message}` });
          },
          {
            repoPath,
            expectationPath: options?.graphExpectationPath,
          },
        );

        await executeQuery(`MATCH (g:Gap) DETACH DELETE g`);

        const gapInsertGraph = createKnowledgeGraph();
        for (const gap of gapResult.gaps) {
          gapInsertGraph.addNode({
            id: gap.id,
            label: 'Gap',
            properties: {
              name: gap.label,
              filePath: '',
              heuristicLabel: gap.heuristicLabel,
              gapType: gap.gapType,
              absenceTier: gap.absenceTier,
              severity: gap.severity,
              sliceId: gap.sliceId,
              anchorId: gap.anchorId,
              missingSlots: gap.missingSlots,
              evidence: gap.evidence,
            },
          });
        }

        for (const link of gapResult.links) {
          gapInsertGraph.addRelationship({
            id: `${link.gapId}_member_of_${link.sliceId}`,
            type: 'MEMBER_OF',
            sourceId: link.gapId,
            targetId: link.sliceId,
            confidence: 1.0,
            reason: 'gap-membership',
          });
        }

        await loadGraphToKuzu(gapInsertGraph, new Map(), storagePath, (msg) => {
          bar.update(89, { phase: msg });
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to recompute gap graph (${msg.slice(0, 120)})`);
      }
    }
    markPassTiming('gaps', gapPassStartedAt);

    const shouldRecomputeShapeGraph = incrementalDerivedMode === 'full'
      || (incrementalDerivedMode === 'adaptive' && shapeSignalsTouched);
    if (!shouldRecomputeShapeGraph) {
      skipDerivedPass('shape-graph');
    } else {
      bar.update(89, { phase: 'Incremental: recomputing shape graph...' });
      const shapeGraphPassStartedAt = Date.now();
      try {
        const migrationsTouched = rebuildFiles.some(fp => /(^|\/)database\/migrations\/.+\.php$/i.test(fp))
          || Array.from(deletedFiles).some(fp => /(^|\/)database\/migrations\/.+\.php$/i.test(fp));
        const existingShapeCount = await getCount('ContractShape');
        const shouldForceFullShapeGraph = migrationsTouched || existingShapeCount === 0;

        const escapeCypherString = (value: string): string => value.replace(/'/g, "''");
        const chunk = <T>(items: T[], size: number): T[][] => {
          if (size <= 0) return [items];
          const chunks: T[][] = [];
          for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
          return chunks;
        };
        const toCypherStringList = (values: string[]): string => values
          .map(value => `'${escapeCypherString(value)}'`)
          .join(', ');

        if (shouldForceFullShapeGraph) {
          const shapeFilePaths = allRepoFiles.filter(filePath => {
            const normalized = filePath.replace(/\\/g, '/');
            if (normalized.includes('/Http/Requests/')) return true;
            if (normalized.includes('/Http/Resources/')) return true;
            if (normalized.includes('/Http/Controllers/')) return true;
            if (TEST_FILE_RE.test(normalized)) return true;
            if (/(^|\/)database\/migrations\/.+\.php$/i.test(normalized)) return true;
            if (JS_TS_FILE_RE.test(normalized) && !normalized.endsWith('.d.ts')) return true;
            return false;
          });

          const shapeInputGraph = createKnowledgeGraph();
          for (const filePath of shapeFilePaths) {
            shapeInputGraph.addNode({
              id: `File:${filePath}`,
              label: 'File',
              properties: {
                name: path.posix.basename(filePath),
                filePath,
              },
            });
          }

          const classRows = await executeQuery(`
            MATCH (c:Class)
            WHERE c.filePath CONTAINS '/Http/Requests/' OR c.filePath CONTAINS '/Http/Resources/'
            RETURN c.id AS id, c.name AS name, c.filePath AS filePath
          `);
          for (const row of classRows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;
            shapeInputGraph.addNode({
              id,
              label: 'Class',
              properties: {
                name: String(row.name ?? row[1] ?? '').trim(),
                filePath: String(row.filePath ?? row[2] ?? '').trim(),
              },
            });
          }

          const functionRows = await executeQuery(`
            MATCH (f:Function)
            WHERE LOWER(f.name) CONTAINS 'querykeys.'
            RETURN f.id AS id, f.name AS name, f.filePath AS filePath
          `);
          for (const row of functionRows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;
            shapeInputGraph.addNode({
              id,
              label: 'Function',
              properties: {
                name: String(row.name ?? row[1] ?? '').trim(),
                filePath: String(row.filePath ?? row[2] ?? '').trim(),
              },
            });
          }

          const methodRows = await executeQuery(`
            MATCH (m:Method)
            WHERE m.filePath CONTAINS '/Http/Controllers/'
            RETURN m.id AS id, m.name AS name, m.filePath AS filePath, m.startLine AS startLine, m.endLine AS endLine
          `);
          for (const row of methodRows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;
            shapeInputGraph.addNode({
              id,
              label: 'Method',
              properties: {
                name: String(row.name ?? row[1] ?? '').trim(),
                filePath: String(row.filePath ?? row[2] ?? '').trim(),
                startLine: Math.max(0, Math.floor(Number(row.startLine ?? row[3] ?? 0) || 0)),
                endLine: Math.max(0, Math.floor(Number(row.endLine ?? row[4] ?? 0) || 0)),
              },
            });
          }

          const shapeFiles = await readRepositoryFiles(repoPath, shapeFilePaths);
          const shapeResult = await processContractShapes(shapeInputGraph, shapeFiles, (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Shapes: ${message}` });
          });

          await executeQuery(`MATCH (f:ContractField) DETACH DELETE f`);
          await executeQuery(`MATCH (s:ContractShape) DETACH DELETE s`);
          await executeQuery(`MATCH (k:CacheKey) DETACH DELETE k`);
          await executeQuery(`MATCH (c:DBColumn) DETACH DELETE c`);
          await executeQuery(`MATCH (t:DBTable) DETACH DELETE t`);
          await executeQuery(`MATCH (t:TestCase) DETACH DELETE t`);
          await executeQuery(`MATCH (e:CodeElement) WHERE e.id STARTS WITH 'CodeElement:laravel-validation-boundary:' DETACH DELETE e`);

          const shapeInsertGraph = createKnowledgeGraph();
          for (const shape of shapeResult.shapes) {
            shapeInsertGraph.addNode({
              id: shape.id,
              label: 'ContractShape',
              properties: {
                name: shape.label,
                filePath: '',
                heuristicLabel: shape.heuristicLabel,
                shapeType: shape.shapeType,
                sourceNodeId: shape.sourceNodeId,
                sourceFilePath: shape.sourceFilePath,
              },
            });
          }

          for (const field of shapeResult.fields) {
            shapeInsertGraph.addNode({
              id: field.id,
              label: 'ContractField',
              properties: {
                name: field.label,
                filePath: '',
                heuristicLabel: field.heuristicLabel,
                fieldName: field.fieldName,
                shapeId: field.shapeId,
                shapeType: field.shapeType,
              },
            });
          }

          for (const cacheKey of shapeResult.cacheKeys) {
            shapeInsertGraph.addNode({
              id: cacheKey.id,
              label: 'CacheKey',
              properties: {
                name: cacheKey.label,
                filePath: '',
                heuristicLabel: cacheKey.heuristicLabel,
                keyName: cacheKey.keyName,
                keyType: cacheKey.keyType,
                sourceNodeId: cacheKey.sourceNodeId,
              },
            });
          }

          for (const dbTable of shapeResult.dbTables) {
            shapeInsertGraph.addNode({
              id: dbTable.id,
              label: 'DBTable',
              properties: {
                name: dbTable.label,
                filePath: dbTable.sourceFilePath,
                heuristicLabel: dbTable.heuristicLabel,
                tableName: dbTable.tableName,
                sourceFilePath: dbTable.sourceFilePath,
              },
            });
          }

          for (const dbColumn of shapeResult.dbColumns) {
            shapeInsertGraph.addNode({
              id: dbColumn.id,
              label: 'DBColumn',
              properties: {
                name: dbColumn.label,
                filePath: dbColumn.sourceFilePath,
                heuristicLabel: dbColumn.heuristicLabel,
                columnName: dbColumn.columnName,
                tableId: dbColumn.tableId,
                tableName: dbColumn.tableName,
                sourceFilePath: dbColumn.sourceFilePath,
              },
            });
          }

          for (const testCase of shapeResult.testCases) {
            shapeInsertGraph.addNode({
              id: testCase.id,
              label: 'TestCase',
              properties: {
                name: testCase.name,
                filePath: testCase.filePath,
                startLine: testCase.startLine,
                endLine: testCase.endLine,
              },
            });
          }

          for (const node of shapeResult.codeElements) {
            shapeInsertGraph.addNode(node);
          }

          for (const edge of shapeResult.edges) {
            shapeInsertGraph.addRelationship({
              id: edge.id,
              type: edge.type,
              sourceId: edge.sourceId,
              targetId: edge.targetId,
              confidence: edge.confidence,
              reason: edge.reason,
            });
          }

          await loadGraphToKuzu(shapeInsertGraph, new Map(), storagePath, (msg) => {
            bar.update(89, { phase: msg });
          });
        } else {
          const normalizeDbName = (value: string): string => {
            return String(value || '')
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9_]+/g, '_')
              .replace(/^_+|_+$/g, '');
          };

          const toSnakeCase = (value: string): string => {
            return String(value || '')
              .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
              .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
              .replace(/[^A-Za-z0-9]+/g, '_')
              .replace(/^_+|_+$/g, '')
              .toLowerCase();
          };

          const pluralizeSimple = (value: string): string => {
            const normalized = String(value || '').trim();
            if (!normalized) return '';
            if (normalized.endsWith('s')) return normalized;
            if (normalized.endsWith('y')) return `${normalized.slice(0, -1)}ies`;
            return `${normalized}s`;
          };

          const normalizeFieldKeyForColumn = (fieldName: string): string => {
            const normalized = String(fieldName || '').trim();
            if (!normalized) return '';

            const dotExpanded = normalized
              .replace(/\[/g, '.')
              .replace(/\]/g, '.')
              .replace(/\.+/g, '.')
              .replace(/^\.|\.$/g, '');

            const segments = dotExpanded
              .split('.')
              .map(segment => segment.trim())
              .filter(segment => Boolean(segment) && segment !== '*' && !/^\d+$/.test(segment));

            if (segments.length === 0) return normalizeDbName(normalized);
            return normalizeDbName(segments[segments.length - 1]);
          };

          const extractShapeTableHints = (className: string, sourceFilePath: string): string[] => {
            const candidates = new Set<string>();
            const normalizedClass = String(className || '').trim();
            const classCore = normalizedClass.replace(/(Request|Resource|Controller|Model|Policy)$/i, '').trim();
            const classSnake = normalizeDbName(toSnakeCase(classCore));
            if (classSnake) {
              candidates.add(classSnake);
              candidates.add(pluralizeSimple(classSnake));
            }

            const fileBase = String(sourceFilePath || '')
              .replace(/\\/g, '/')
              .split('/')
              .pop()
              ?.replace(/\.[^.]+$/, '')
              ?.replace(/(_request|_resource|request|resource)$/i, '') || '';
            const fileSnake = normalizeDbName(toSnakeCase(fileBase));
            if (fileSnake) {
              candidates.add(fileSnake);
              candidates.add(pluralizeSimple(fileSnake));
            }

            return Array.from(candidates).filter(Boolean);
          };

          const sanitizeIdSegment = (value: string): string => {
            return String(value || '')
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '_')
              .replace(/^_+|_+$/g, '')
              .slice(0, 120);
          };

          const isPhp = (filePath: string): boolean => filePath.toLowerCase().endsWith('.php');
          const changedControllerFiles = rebuildFiles.filter(fp => isPhp(fp) && fp.includes('/Http/Controllers/'));
          const changedRequestFiles = rebuildFiles.filter(fp => isPhp(fp) && fp.includes('/Http/Requests/'));
          const changedResourceFiles = rebuildFiles.filter(fp => isPhp(fp) && fp.includes('/Http/Resources/'));
          const phpShapeFiles = Array.from(new Set([
            ...changedControllerFiles,
            ...changedRequestFiles,
            ...changedResourceFiles,
          ]));

          const changedJsTsFiles = rebuildFiles.filter(fp => JS_TS_FILE_RE.test(fp) && !fp.toLowerCase().endsWith('.d.ts'));
          const changedTestFiles = rebuildFiles.filter(fp => TEST_FILE_RE.test(fp));

          const insertGraph = createKnowledgeGraph();

          if (phpShapeFiles.length > 0) {
            const shapeInputGraph = createKnowledgeGraph();
            const classNameById = new Map<string, string>();

            const classFilePaths = Array.from(new Set([...changedRequestFiles, ...changedResourceFiles]));
            for (const classChunk of chunk(classFilePaths, 200)) {
              const list = toCypherStringList(classChunk);
              if (!list) continue;
              const classRows = await executeQuery(`
                MATCH (c:Class)
                WHERE c.filePath IN [${list}]
                RETURN c.id AS id, c.name AS name, c.filePath AS filePath
              `);
              for (const row of classRows) {
                const id = String(row.id ?? row[0] ?? '').trim();
                if (!id) continue;
                const name = String(row.name ?? row[1] ?? '').trim();
                const filePath = String(row.filePath ?? row[2] ?? '').trim();
                classNameById.set(id, name);
                shapeInputGraph.addNode({
                  id,
                  label: 'Class',
                  properties: { name, filePath },
                });
              }
            }

            for (const methodChunk of chunk(changedControllerFiles, 200)) {
              const list = toCypherStringList(methodChunk);
              if (!list) continue;
              const methodRows = await executeQuery(`
                MATCH (m:Method)
                WHERE m.filePath IN [${list}]
                RETURN m.id AS id, m.name AS name, m.filePath AS filePath, m.startLine AS startLine, m.endLine AS endLine
              `);
              for (const row of methodRows) {
                const id = String(row.id ?? row[0] ?? '').trim();
                if (!id) continue;
                shapeInputGraph.addNode({
                  id,
                  label: 'Method',
                  properties: {
                    name: String(row.name ?? row[1] ?? '').trim(),
                    filePath: String(row.filePath ?? row[2] ?? '').trim(),
                    startLine: Math.max(0, Math.floor(Number(row.startLine ?? row[3] ?? 0) || 0)),
                    endLine: Math.max(0, Math.floor(Number(row.endLine ?? row[4] ?? 0) || 0)),
                  },
                });
              }
            }

            const shapeFiles: Array<{ path: string; content: string }> = [];
            for (const fp of phpShapeFiles) {
              let content = contentByPath.get(fp);
              if (content === undefined) {
                try {
                  content = await fs.readFile(path.join(repoPath, fp), 'utf-8');
                } catch {
                  content = '';
                }
              }
              shapeFiles.push({ path: fp, content });
            }

            const shapeResult = await processContractShapes(shapeInputGraph, shapeFiles, (message, progress) => {
              if (progress % 25 !== 0 && progress !== 100) return;
              bar.update(89, { phase: `Shapes: ${message}` });
            });

            // Remove derived nodes/edges for the changed Laravel shape sources.
            // Keep ContractShape nodes when possible to preserve TESTS_SHAPE links from unchanged tests.
            const changedShapeSourceFiles = phpShapeFiles;
            const existingShapeRows = await executeQuery(`
              MATCH (s:ContractShape)
              WHERE s.sourceFilePath IN [${toCypherStringList(changedShapeSourceFiles)}]
              RETURN s.id AS id, s.sourceFilePath AS sourceFilePath
            `);

            const existingShapeIdsByFile = new Map<string, Set<string>>();
            const existingShapeIds = new Set<string>();
            for (const row of existingShapeRows) {
              const id = String((row as any)?.id ?? row[0] ?? '').trim();
              const fp = String((row as any)?.sourceFilePath ?? row[1] ?? '').trim();
              if (!id || !fp) continue;
              const set = existingShapeIdsByFile.get(fp) || new Set<string>();
              set.add(id);
              existingShapeIdsByFile.set(fp, set);
              existingShapeIds.add(id);
            }

            const newShapeIdsByFile = new Map<string, Set<string>>();
            for (const shape of shapeResult.shapes) {
              const fp = String(shape.sourceFilePath || '').trim();
              if (!fp) continue;
              const set = newShapeIdsByFile.get(fp) || new Set<string>();
              set.add(shape.id);
              newShapeIdsByFile.set(fp, set);
            }

            const shapesToRemove: string[] = [];
            for (const fp of changedShapeSourceFiles) {
              const existingIds = existingShapeIdsByFile.get(fp) || new Set<string>();
              const newIds = newShapeIdsByFile.get(fp) || new Set<string>();
              for (const id of existingIds) {
                if (!newIds.has(id)) shapesToRemove.push(id);
              }
            }

            // Clear contract fields (and their edges) for existing shapes from these files.
            for (const idChunk of chunk(Array.from(existingShapeIds), 250)) {
              const list = toCypherStringList(idChunk);
              if (!list) continue;
              await executeQuery(`
                MATCH (f:ContractField)
                WHERE f.shapeId IN [${list}]
                DETACH DELETE f
              `);
            }

            // Clear derived Class->ContractShape DEFINES edges for the touched request/resource files to avoid duplicates.
            if (classFilePaths.length > 0) {
              for (const fileChunk of chunk(classFilePaths, 200)) {
                const list = toCypherStringList(fileChunk);
                if (!list) continue;
                await executeQuery(`
                  MATCH (c:Class)-[r:CodeRelation]->(s:ContractShape)
                  WHERE r.type = 'DEFINES' AND c.filePath IN [${list}]
                  DELETE r
                `);
              }
            }

            // Clear derived Laravel validation boundary code elements for touched controller files.
            if (changedControllerFiles.length > 0) {
              for (const fileChunk of chunk(changedControllerFiles, 200)) {
                const list = toCypherStringList(fileChunk);
                if (!list) continue;
                await executeQuery(`
                  MATCH (e:CodeElement)
                  WHERE e.id STARTS WITH 'CodeElement:laravel-validation-boundary:'
                    AND e.filePath IN [${list}]
                  DETACH DELETE e
                `);
              }
            }

            // Remove shapes that no longer exist in these source files.
            for (const idChunk of chunk(shapesToRemove, 250)) {
              const list = toCypherStringList(idChunk);
              if (!list) continue;
              await executeQuery(`
                MATCH (s:ContractShape)
                WHERE s.id IN [${list}]
                DETACH DELETE s
              `);
            }

            // Insert updated shapes/fields/boundaries for changed files.
            for (const shape of shapeResult.shapes) {
              insertGraph.addNode({
                id: shape.id,
                label: 'ContractShape',
                properties: {
                  name: shape.label,
                  filePath: '',
                  heuristicLabel: shape.heuristicLabel,
                  shapeType: shape.shapeType,
                  sourceNodeId: shape.sourceNodeId,
                  sourceFilePath: shape.sourceFilePath,
                },
              });
            }

            for (const field of shapeResult.fields) {
              insertGraph.addNode({
                id: field.id,
                label: 'ContractField',
                properties: {
                  name: field.label,
                  filePath: '',
                  heuristicLabel: field.heuristicLabel,
                  fieldName: field.fieldName,
                  shapeId: field.shapeId,
                  shapeType: field.shapeType,
                },
              });
            }

            for (const node of shapeResult.codeElements) {
              insertGraph.addNode(node);
            }

            // Derive field->column wiring using existing DBColumn nodes (avoid full migration rescans).
            const fieldColumnKeys = new Set<string>();
            for (const field of shapeResult.fields) {
              const key = normalizeFieldKeyForColumn(field.fieldName);
              if (key) fieldColumnKeys.add(key);
            }

            const dbColumnsByName = new Map<string, Array<{ id: string; tableName: string }>>();
            if (fieldColumnKeys.size > 0) {
              for (const keyChunk of chunk(Array.from(fieldColumnKeys), 250)) {
                const list = toCypherStringList(keyChunk);
                if (!list) continue;
                const columnRows = await executeQuery(`
                  MATCH (c:DBColumn)
                  WHERE c.columnName IN [${list}]
                  RETURN c.id AS id, c.columnName AS columnName, c.tableName AS tableName
                `);
                for (const row of columnRows) {
                  const id = String((row as any)?.id ?? row[0] ?? '').trim();
                  const columnName = String((row as any)?.columnName ?? row[1] ?? '').trim();
                  const tableName = String((row as any)?.tableName ?? row[2] ?? '').trim();
                  if (!id || !columnName || !tableName) continue;
                  const listForName = dbColumnsByName.get(columnName) || [];
                  listForName.push({ id, tableName });
                  dbColumnsByName.set(columnName, listForName);
                }
              }
            }

            const shapeById = new Map<string, typeof shapeResult.shapes[number]>();
            for (const shape of shapeResult.shapes) shapeById.set(shape.id, shape);

            for (const edge of shapeResult.edges) {
              insertGraph.addRelationship({
                id: edge.id,
                type: edge.type,
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                confidence: edge.confidence,
                reason: edge.reason,
              });
            }

            for (const field of shapeResult.fields) {
              const shape = shapeById.get(field.shapeId);
              if (!shape) continue;

              const columnKey = normalizeFieldKeyForColumn(field.fieldName);
              if (!columnKey) continue;

              const candidates = dbColumnsByName.get(columnKey) || [];
              if (candidates.length === 0) continue;

              let selected: { id: string; tableName: string } | null = null;
              let reason = 'db-schema:field-name-exact';
              let confidence = 0.86;

              if (candidates.length === 1) {
                selected = candidates[0];
              } else {
                const className = classNameById.get(shape.sourceNodeId) || '';
                const tableHints = extractShapeTableHints(className, shape.sourceFilePath);
                const narrowed = candidates.filter(candidate => tableHints.includes(candidate.tableName));
                if (narrowed.length === 1) {
                  selected = narrowed[0];
                  reason = 'db-schema:field-name-shape-table';
                  confidence = 0.82;
                }
              }

              if (!selected) continue;
              insertGraph.addRelationship({
                id: `DERIVES_FROM_COLUMN:${field.id}->${selected.id}`,
                type: 'DERIVES_FROM_COLUMN',
                sourceId: field.id,
                targetId: selected.id,
                confidence,
                reason,
              });
            }
          }

          // Incremental CacheKey + invalidateQueries wiring (only for changed JS/TS files)
          if (changedJsTsFiles.length > 0) {
            const functionRows = await executeQuery(`
              MATCH (f:Function)
              WHERE f.filePath IN [${toCypherStringList(changedJsTsFiles)}]
                AND LOWER(f.name) CONTAINS 'querykeys.'
              RETURN f.id AS id, f.name AS name, f.filePath AS filePath
            `);

            // Clear prior function->cacheKey edges for these files (avoid duplicates).
            for (const fileChunk of chunk(changedJsTsFiles, 200)) {
              const list = toCypherStringList(fileChunk);
              if (!list) continue;
              await executeQuery(`
                MATCH (f:Function)-[r:CodeRelation]->(k:CacheKey)
                WHERE r.type = 'DEFINES' AND f.filePath IN [${list}]
                DELETE r
              `);
            }

            const cacheKeyIdByFactoryName = new Map<string, string>();
            for (const row of functionRows) {
              const id = String((row as any)?.id ?? row[0] ?? '').trim();
              const name = String((row as any)?.name ?? row[1] ?? '').trim();
              if (!id || !name) continue;

              const sourcePart = sanitizeIdSegment(id) || 'unknown';
              const keyPart = sanitizeIdSegment(name) || 'cache_key';
              const cacheKeyId = `CacheKey:query_key_factory:${sourcePart}:${keyPart}`;
              cacheKeyIdByFactoryName.set(name, cacheKeyId);

              const label = `Cache Key: ${name}`;
              insertGraph.addNode({
                id: cacheKeyId,
                label: 'CacheKey',
                properties: {
                  name: label,
                  filePath: '',
                  heuristicLabel: label,
                  keyName: name,
                  keyType: 'query_key_factory',
                  sourceNodeId: id,
                },
              });

              insertGraph.addRelationship({
                id: `DEFINES:${id}->${cacheKeyId}`,
                type: 'DEFINES',
                sourceId: id,
                targetId: cacheKeyId,
                confidence: 0.95,
                reason: 'react-query:key-factory',
              });
            }

            const invalidateFiles = changedJsTsFiles
              .filter(fp => String(contentByPath.get(fp) || '').includes('invalidateQueries('));

            if (invalidateFiles.length > 0) {
              // Clear prior invalidation edges from these file nodes.
              for (const fileChunk of chunk(invalidateFiles, 200)) {
                const list = toCypherStringList(fileChunk);
                if (!list) continue;
                await executeQuery(`
                  MATCH (f:File)-[r:CodeRelation]->(k:CacheKey)
                  WHERE r.type = 'INVALIDATES_KEY' AND f.filePath IN [${list}]
                  DELETE r
                `);
              }

              // Clear prior literal cache keys derived from these files.
              const fileNodeIds = invalidateFiles.map(fp => `File:${fp}`);
              for (const nodeChunk of chunk(fileNodeIds, 200)) {
                const list = toCypherStringList(nodeChunk);
                if (!list) continue;
                await executeQuery(`
                  MATCH (k:CacheKey)
                  WHERE k.keyType = 'literal' AND k.sourceNodeId IN [${list}]
                  DETACH DELETE k
                `);
              }

              const exprsByFile = new Map<string, string[]>();
              const factoryNames = new Set<string>();

              for (const fp of invalidateFiles) {
                const content = String(contentByPath.get(fp) || '');
                const exprs = extractInvalidateQueryKeyExpressions(content);
                if (exprs.length === 0) continue;
                exprsByFile.set(fp, exprs);
                for (const expr of exprs) {
                  const factoryName = extractKeyFactoryName(expr);
                  if (factoryName) factoryNames.add(factoryName);
                }
              }

              const existingFactoryKeyIdByName = new Map<string, string>();
              const missingFactories = Array.from(factoryNames).filter(name => !cacheKeyIdByFactoryName.has(name));
              for (const nameChunk of chunk(missingFactories, 200)) {
                const list = toCypherStringList(nameChunk);
                if (!list) continue;
                const keyRows = await executeQuery(`
                  MATCH (k:CacheKey)
                  WHERE k.keyType = 'query_key_factory' AND k.keyName IN [${list}]
                  RETURN k.id AS id, k.keyName AS keyName
                `);
                for (const row of keyRows) {
                  const id = String((row as any)?.id ?? row[0] ?? '').trim();
                  const keyName = String((row as any)?.keyName ?? row[1] ?? '').trim();
                  if (!id || !keyName) continue;
                  existingFactoryKeyIdByName.set(keyName, id);
                }
              }

              for (const [fp, exprs] of exprsByFile) {
                const fileNodeId = `File:${fp}`;
                for (const expr of exprs) {
                  const factoryName = extractKeyFactoryName(expr);
                  if (factoryName) {
                    const cacheKeyId = cacheKeyIdByFactoryName.get(factoryName) || existingFactoryKeyIdByName.get(factoryName) || null;
                    if (cacheKeyId) {
                      insertGraph.addRelationship({
                        id: `INVALIDATES_KEY:${fileNodeId}:${cacheKeyId}`,
                        type: 'INVALIDATES_KEY',
                        sourceId: fileNodeId,
                        targetId: cacheKeyId,
                        confidence: 0.9,
                        reason: 'react-query:invalidateQueries',
                      });
                      continue;
                    }
                  }

                  const literalKey = extractLiteralKey(expr);
                  if (!literalKey) continue;

                  const sourcePart = sanitizeIdSegment(fileNodeId) || 'unknown';
                  const keyPart = sanitizeIdSegment(literalKey) || 'cache_key';
                  const cacheKeyId = `CacheKey:literal:${sourcePart}:${keyPart}`;
                  const label = `Cache Key: ${literalKey}`;

                  insertGraph.addNode({
                    id: cacheKeyId,
                    label: 'CacheKey',
                    properties: {
                      name: label,
                      filePath: '',
                      heuristicLabel: label,
                      keyName: literalKey,
                      keyType: 'literal',
                      sourceNodeId: fileNodeId,
                    },
                  });

                  insertGraph.addRelationship({
                    id: `INVALIDATES_KEY:${fileNodeId}:${cacheKeyId}`,
                    type: 'INVALIDATES_KEY',
                    sourceId: fileNodeId,
                    targetId: cacheKeyId,
                    confidence: 0.9,
                    reason: 'react-query:invalidateQueries:literal',
                  });
                }
              }
            }
          }

          if (insertGraph.nodeCount > 0 || insertGraph.relationshipCount > 0) {
            await loadGraphToKuzu(insertGraph, new Map(), storagePath, (msg) => {
              bar.update(89, { phase: msg });
            });
          }

          if (changedTestFiles.length > 0) {
            // Remove prior test-case nodes for these files, then re-link to current shapes.
            for (const fileChunk of chunk(changedTestFiles, 200)) {
              const list = toCypherStringList(fileChunk);
              if (!list) continue;
              await executeQuery(`
                MATCH (t:TestCase)
                WHERE t.filePath IN [${list}]
                DETACH DELETE t
              `);
            }

            const shapeReferenceRows = await executeQuery(`
              MATCH (s:ContractShape)
              OPTIONAL MATCH (c:Class {id: s.sourceNodeId})
              RETURN s.id AS shapeId,
                     COALESCE(c.name, '') AS className,
                     s.sourceFilePath AS sourceFilePath
            `);

            const shapeReferences: ShapeTestReference[] = [];
            for (const row of shapeReferenceRows) {
              const shapeId = String((row as any)?.shapeId ?? row[0] ?? '').trim();
              const className = String((row as any)?.className ?? row[1] ?? '').trim();
              const sourceFilePath = String((row as any)?.sourceFilePath ?? row[2] ?? '').trim();
              if (!shapeId) continue;
              const sourceFileBase = sourceFilePath
                .replace(/\\/g, '/')
                .split('/')
                .pop()
                ?.replace(/\.[^.]+$/, '') || '';

              shapeReferences.push({
                shapeId,
                className,
                sourceFileBase,
              });
            }

            const testFiles: Array<{ path: string; content: string }> = [];
            for (const fp of changedTestFiles) {
              let content = contentByPath.get(fp);
              if (content === undefined) {
                try {
                  content = await fs.readFile(path.join(repoPath, fp), 'utf-8');
                } catch {
                  content = '';
                }
              }
              testFiles.push({ path: fp, content: String(content || '') });
            }

            const testClosureResult = processStaticTestClosures(testFiles, shapeReferences);

            const testInsertGraph = createKnowledgeGraph();
            for (const testCase of testClosureResult.testCases) {
              testInsertGraph.addNode({
                id: testCase.id,
                label: 'TestCase',
                properties: {
                  name: testCase.name,
                  filePath: testCase.filePath,
                  startLine: testCase.startLine,
                  endLine: testCase.endLine,
                },
              });
            }

            for (const edge of testClosureResult.edges) {
              testInsertGraph.addRelationship({
                id: edge.id,
                type: edge.type,
                sourceId: edge.sourceId,
                targetId: edge.targetId,
                confidence: edge.confidence,
                reason: edge.reason,
              });
            }

            if (testInsertGraph.nodeCount > 0 || testInsertGraph.relationshipCount > 0) {
              await loadGraphToKuzu(testInsertGraph, new Map(), storagePath, (msg) => {
                bar.update(89, { phase: msg });
              });
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to recompute shape graph (${msg.slice(0, 120)})`);
      }
      markPassTiming('shape-graph', shapeGraphPassStartedAt);
    }

    const valueGraphPassStartedAt = Date.now();
    if (!shouldRunAdaptiveHeavyPasses) {
      skipDerivedPass('value-graph');
    } else {
      bar.update(89, { phase: 'Incremental: refreshing value graph...' });
      try {
        await executeQuery(`
          MATCH ()-[r:CodeRelation]->()
          WHERE r.reason STARTS WITH 'value-graph:'
          DELETE r
        `);
        await executeQuery(`MATCH (n:ValueNode) DETACH DELETE n`);

        const valueGraphInput = createKnowledgeGraph();
        const valueGraphNodeIds = new Set<string>();
        const valueGraphNodeLabels = Array.from(new Set([
          'File',
          ...flowNodeLabels,
          'CacheKey',
          'DBTable',
          'DBColumn',
        ]));

        for (const label of valueGraphNodeLabels) {
          const rows = await loadIncrementalNodeRows(String(label), 'value');

          for (const row of rows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;

            valueGraphInput.addNode({
              id,
              label: label as NodeLabel,
              properties: {
                name: String(row.name ?? row.label ?? row[1] ?? '').trim(),
                filePath: String(row.filePath ?? row[3] ?? '').trim(),
                keyName: String(row.keyName ?? row[4] ?? '').trim(),
                tableName: String(row.tableName ?? row[5] ?? '').trim(),
                columnName: String(row.columnName ?? row[6] ?? '').trim(),
                content: String(row.content ?? row[7] ?? ''),
              },
            });
            valueGraphNodeIds.add(id);
          }
        }

        const routeNameCallRows = await executeQuery(`
          MATCH (a)-[r:CodeRelation {type: 'CALLS'}]->(b)
          WHERE r.reason STARTS WITH 'route-name:'
          RETURN a.id AS sourceId,
                 b.id AS targetId,
                 r.confidence AS confidence,
                 r.reason AS reason
        `);

        for (const row of routeNameCallRows) {
          const sourceId = String(row.sourceId ?? row[0] ?? '').trim();
          const targetId = String(row.targetId ?? row[1] ?? '').trim();
          if (!sourceId || !targetId || !valueGraphNodeIds.has(sourceId)) continue;

          valueGraphInput.addRelationship({
            id: `inc_value_CALLS_${sourceId}->${targetId}`,
            type: 'CALLS',
            sourceId,
            targetId,
            confidence: Number(row.confidence ?? row[2] ?? 0.9) || 0.9,
            reason: String(row.reason ?? row[3] ?? ''),
          });
        }

        const valueGraphResult = await processValueGraph(
          valueGraphInput,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Value graph: ${message}` });
          },
        );

        valueGraphSummary = {
          valueCount: valueGraphResult.stats.valueCount,
          edgeCount: valueGraphResult.stats.edgeCount,
          permissionValues: valueGraphResult.stats.permissionValues,
          endpointValues: valueGraphResult.stats.endpointValues,
          routeNameValues: valueGraphResult.stats.routeNameValues,
          cacheKeyValues: valueGraphResult.stats.cacheKeyValues,
          roleValues: valueGraphResult.stats.roleValues,
          featureFlagValues: valueGraphResult.stats.featureFlagValues,
          configKeyValues: valueGraphResult.stats.configKeyValues,
          envVarValues: valueGraphResult.stats.envVarValues,
          queueNameValues: valueGraphResult.stats.queueNameValues,
          broadcastChannelValues: valueGraphResult.stats.broadcastChannelValues,
          eventNameValues: valueGraphResult.stats.eventNameValues,
          commandNameValues: valueGraphResult.stats.commandNameValues,
          i18nKeyValues: valueGraphResult.stats.i18nKeyValues,
          queryKeyFamilyValues: valueGraphResult.stats.queryKeyFamilyValues,
          routeSegmentValues: valueGraphResult.stats.routeSegmentValues,
          tableNameValues: valueGraphResult.stats.tableNameValues,
          tableColumnValues: valueGraphResult.stats.tableColumnValues,
          tailwindClassValues: valueGraphResult.stats.tailwindClassValues,
          componentPropValues: valueGraphResult.stats.componentPropValues,
          reactContextValues: valueGraphResult.stats.reactContextValues,
          providerSurfaceValues: valueGraphResult.stats.providerSurfaceValues,
          skippedDuplicates: valueGraphResult.stats.skippedDuplicates,
          skippedMalformed: valueGraphResult.stats.skippedMalformed,
        };

        if (valueGraphResult.values.length > 0 || valueGraphResult.edges.length > 0) {
          const valueGraphInsert = createKnowledgeGraph();
          for (const value of valueGraphResult.values) {
            valueGraphInsert.addNode({
              id: value.id,
              label: 'ValueNode',
              properties: {
                name: value.label,
                filePath: '',
                heuristicLabel: value.heuristicLabel,
                valueType: value.valueType,
                valueKey: value.valueKey,
                valueRaw: value.valueRaw,
              },
            });
          }

          for (const edge of valueGraphResult.edges) {
            valueGraphInsert.addRelationship(edge);
          }

          await loadGraphToKuzu(valueGraphInsert, new Map(), storagePath, (msg) => {
            bar.update(89, { phase: msg });
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to refresh value graph (${msg.slice(0, 120)})`);
      }
    }
    markPassTiming('value-graph', valueGraphPassStartedAt);

    const provenancePassStartedAt = Date.now();
    if (!shouldRunAdaptiveHeavyPasses) {
      skipDerivedPass('provenance');
    } else {
      bar.update(89, { phase: 'Incremental: refreshing provenance edges...' });
      try {
        await executeQuery(`
          MATCH ()-[r:CodeRelation]->()
          WHERE r.reason STARTS WITH 'provenance:'
          DELETE r
        `);

        const provenanceGraph = createKnowledgeGraph();
        const provenanceNodeIds = new Set<string>();
        const provenanceNodeLabels = ['File', ...flowNodeLabels, 'ValueNode', 'TestCase'] as const;

        for (const label of provenanceNodeLabels) {
          const nodeVariant: IncrementalNodeRowVariant = label === 'ValueNode' ? 'heuristic' : 'flow';
          const rows = await loadIncrementalNodeRows(String(label), nodeVariant);

          for (const row of rows) {
            const id = String(row.id ?? row[0] ?? '').trim();
            if (!id) continue;

            provenanceGraph.addNode({
              id,
              label: label as NodeLabel,
              properties: {
                name: String(row.name ?? row.label ?? row[1] ?? '').trim(),
                filePath: String(row.filePath ?? row[2] ?? '').trim(),
                startLine: Number(row.startLine ?? row[3] ?? 0) || undefined,
                endLine: Number(row.endLine ?? row[4] ?? 0) || undefined,
              },
            });
            provenanceNodeIds.add(id);
          }
        }

        const relationshipRows = (await loadIncrementalCoreRelationRows()).filter((row) => {
          const type = String(row.type ?? row[2] ?? '').trim();
          return type === 'CALLS' || type === 'DEFINES';
        });

        for (const row of relationshipRows) {
          const sourceId = String(row.sourceId ?? row[0] ?? '').trim();
          const targetId = String(row.targetId ?? row[1] ?? '').trim();
          const type = String(row.type ?? row[2] ?? '').trim();
          if (!sourceId || !targetId || !type) continue;
          if (!provenanceNodeIds.has(sourceId) && !provenanceNodeIds.has(targetId)) continue;

          provenanceGraph.addRelationship({
            id: `inc_provenance_${type}_${sourceId}->${targetId}`,
            type: type as RelationshipType,
            sourceId,
            targetId,
            confidence: Number(row.confidence ?? row[3] ?? 1.0) || 1.0,
            reason: String(row.reason ?? row[4] ?? ''),
          });
        }

        const provenanceResult = await processProvenanceEdges(
          provenanceGraph,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Provenance: ${message}` });
          },
        );

        provenanceSummary = {
          emittedEdges: provenanceResult.stats.emittedEdges,
          routeExpansionEdges: provenanceResult.stats.routeExpansionEdges,
          enumToSlugEdges: provenanceResult.stats.enumToSlugEdges,
          configDrivenEdges: provenanceResult.stats.configDrivenEdges,
          compiledArtifactEdges: provenanceResult.stats.compiledArtifactEdges,
          frameworkDerivedEdges: provenanceResult.stats.frameworkDerivedEdges,
          skippedDuplicates: provenanceResult.stats.skippedDuplicates,
          skippedMalformed: provenanceResult.stats.skippedMalformed,
        };

        if (provenanceResult.edges.length > 0) {
          const provenanceInsert = createKnowledgeGraph();
          for (const edge of provenanceResult.edges) {
            provenanceInsert.addRelationship(edge);
          }
          await loadGraphToKuzu(provenanceInsert, new Map(), storagePath, (msg) => {
            bar.update(89, { phase: msg });
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to refresh provenance edges (${msg.slice(0, 120)})`);
      }
    }
    markPassTiming('provenance', provenancePassStartedAt);

    const shouldRecomputeCochange = !skipCochange && (incrementalDerivedMode === 'full' || fileChangesTotal >= 200);
    if (skipCochange) {
      skipDerivedPass('cochange');
      const cochangePassStartedAt = Date.now();
      bar.update(89, { phase: 'Incremental: removing git-history cochange graph (profile)...' });
      try {
        await executeQuery(`MATCH ()-[r:CodeRelation {type: 'CO_CHANGES_WITH'}]->() DELETE r`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to clear cochange graph (${msg.slice(0, 120)})`);
      }
      markPassTiming('cochange', cochangePassStartedAt);
    } else if (!shouldRecomputeCochange) {
      skipDerivedPass('cochange');
    } else {
      const cochangePassStartedAt = Date.now();
      bar.update(89, { phase: 'Incremental: recomputing git-history cochange graph...' });
      try {
        const cochangeResult = await processGitHistoryCochange(repoPath, allRepoFiles, (message, progress) => {
          if (progress % 20 !== 0 && progress !== 100) return;
          bar.update(89, { phase: `Cochange: ${message}` });
        });

        await executeQuery(`MATCH ()-[r:CodeRelation {type: 'CO_CHANGES_WITH'}]->() DELETE r`);

        const cochangeInsertGraph = createKnowledgeGraph();
        for (const edge of cochangeResult.edges) {
          cochangeInsertGraph.addRelationship(edge);
        }

        await loadGraphToKuzu(cochangeInsertGraph, new Map(), storagePath, (msg) => {
          bar.update(89, { phase: msg });
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to recompute cochange graph (${msg.slice(0, 120)})`);
      }
      markPassTiming('cochange', cochangePassStartedAt);
    }

    if (!shouldRunAdaptiveHeavyPasses) {
      skipDerivedPass('evidence-spans');
      skipDerivedPass('structured-summaries');
      skipDerivedPass('closure-templates');
    } else {
      const loadPostDerivedNodeRows = async (label: string): Promise<any[]> => {
        if (label === 'FeatureSlice') return loadIncrementalNodeRows(label, 'slice');
        if (label === 'Process') return loadIncrementalNodeRows(label, 'process');
        if (label === 'Community' || label === 'Gap' || label === 'ContractShape' || label === 'ContractField' || label === 'CacheKey' || label === 'DBTable' || label === 'DBColumn' || label === 'ValueNode') {
          return loadIncrementalNodeRows(label, 'heuristic');
        }
        return loadIncrementalNodeRows(label, 'flow');
      };
      const postDerivedRelationTypes = [
        'CALLS',
        'IMPORTS',
        'EXTENDS',
        'IMPLEMENTS',
        'DEFINES',
        'MEMBER_OF',
        'STEP_IN_PROCESS',
        'VALIDATES_FIELD',
        'SERIALIZES_FIELD',
        'READS_FIELD',
        'WRITES_FIELD',
        'DERIVES_FROM',
        'DERIVES_FROM_COLUMN',
        'INVALIDATES_KEY',
        'TESTS_SHAPE',
      ];
      const postDerivedRelationTypesCypher = `[${postDerivedRelationTypes.map(type => `'${type}'`).join(', ')}]`;
      const evidenceRelationLabels = ['File', ...flowNodeLabels, 'TestCase'] as const;
      const buildNodeIdPrefixPredicate = (alias: string, labels: readonly string[]): string => (
        labels.map(label => `${alias}.id STARTS WITH '${label}:'`).join(' OR ')
      );
      const evidenceSourcePredicate = buildNodeIdPrefixPredicate('a', evidenceRelationLabels);
      const evidenceTargetPredicate = buildNodeIdPrefixPredicate('b', evidenceRelationLabels);
      let postDerivedEvidenceRelationRows: any[] | null = null;
      let postDerivedSummaryRelationRows: any[] | null = null;
      const loadPostDerivedRelationRows = async (mode: 'evidence' | 'summary'): Promise<any[]> => {
        if (mode === 'evidence') {
          if (postDerivedEvidenceRelationRows) return postDerivedEvidenceRelationRows;
          postDerivedEvidenceRelationRows = await executeQuery(`
            MATCH (a)-[r:CodeRelation]->(b)
            WHERE r.type IN ${postDerivedRelationTypesCypher}
              AND ((${evidenceSourcePredicate}) OR (${evidenceTargetPredicate}))
            RETURN a.id AS sourceId,
                   b.id AS targetId,
                   r.type AS type,
                   r.confidence AS confidence,
                   r.reason AS reason,
                   r.step AS step
          `);
          return postDerivedEvidenceRelationRows;
        }
        if (postDerivedSummaryRelationRows) return postDerivedSummaryRelationRows;

        const baseRows = await executeQuery(`
          MATCH (a)-[r:CodeRelation]->(b)
          WHERE r.type IN ${postDerivedRelationTypesCypher}
          RETURN a.id AS sourceId,
                 b.id AS targetId,
                 r.type AS type,
                 r.confidence AS confidence,
                 r.reason AS reason,
                 r.step AS step
        `);

        let cochangeRows: any[] = [];
        if (!skipCochange) {
          try {
            const cochangeLimit = Math.max(5000, Math.min(50000, allRepoFiles.length * 20));
            cochangeRows = await executeQuery(`
              MATCH (a:File)-[r:CodeRelation {type: 'CO_CHANGES_WITH'}]->(b:File)
              WHERE r.confidence >= 0.5
              RETURN a.id AS sourceId,
                     b.id AS targetId,
                     r.type AS type,
                     r.confidence AS confidence,
                     r.reason AS reason,
                     r.step AS step
              LIMIT ${cochangeLimit}
            `);
          } catch {
            cochangeRows = [];
          }
        }

        postDerivedSummaryRelationRows = [...baseRows, ...cochangeRows];
        return postDerivedSummaryRelationRows;
      };

      const evidencePassStartedAt = Date.now();
      bar.update(89, { phase: 'Incremental: refreshing evidence spans...' });
      try {
        const evidenceGraph = createKnowledgeGraph();
        const evidenceNodeIds = new Set<string>();
        const evidenceNodeLabels = ['File', ...flowNodeLabels, 'TestCase'] as const;

        for (const label of evidenceNodeLabels) {
          const rows = await loadPostDerivedNodeRows(String(label));

          for (const row of rows) {
            const id = String(row.id ?? '').trim();
            if (!id) continue;

            evidenceGraph.addNode({
              id,
              label: label as NodeLabel,
              properties: {
                name: String(row.name ?? '').trim(),
                filePath: String(row.filePath ?? '').trim(),
                startLine: Number(row.startLine ?? 0) || undefined,
                endLine: Number(row.endLine ?? 0) || undefined,
              },
            });
            evidenceNodeIds.add(id);
          }
        }

        const relationshipRows = await loadPostDerivedRelationRows('evidence');
        for (const row of relationshipRows) {
          const sourceId = String(row.sourceId ?? '').trim();
          const targetId = String(row.targetId ?? '').trim();
          const type = String(row.type ?? '').trim();
          if (!sourceId || !targetId || !type) continue;
          if (!evidenceNodeIds.has(sourceId) && !evidenceNodeIds.has(targetId)) continue;

          evidenceGraph.addRelationship({
            id: `inc_evidence_${type}_${sourceId}->${targetId}`,
            type: type as RelationshipType,
            sourceId,
            targetId,
            confidence: Number(row.confidence ?? 1.0) || 1.0,
            reason: String(row.reason ?? ''),
            step: Number(row.step ?? 0) || undefined,
          });
        }

        const evidenceSnapshot = await processEvidenceSpans(
          evidenceGraph,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Evidence spans: ${message}` });
          },
        );

        await saveEvidenceSpanSnapshot(storagePath, evidenceSnapshot);
        evidenceSpanSummary = {
          nodeEvidenceCount: evidenceSnapshot.stats.nodeEvidenceCount,
          edgeEvidenceCount: evidenceSnapshot.stats.edgeEvidenceCount,
          uniqueFiles: evidenceSnapshot.stats.uniqueFiles,
          primarySpanCount: evidenceSnapshot.stats.primarySpanCount,
          witnessSpanCount: evidenceSnapshot.stats.witnessSpanCount,
          proofSpanCount: evidenceSnapshot.stats.proofSpanCount,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to refresh evidence spans (${msg.slice(0, 120)})`);
      }
      markPassTiming('evidence-spans', evidencePassStartedAt);

      const summaryPassStartedAt = Date.now();
      bar.update(89, { phase: 'Incremental: refreshing structured summaries...' });
      try {
        const summaryGraph = createKnowledgeGraph();
        const summaryNodeIds = new Set<string>();
        const summaryNodeLabels = [
          'File',
          ...flowNodeLabels,
          'FeatureSlice',
          'Community',
          'Process',
          'Gap',
          'ContractShape',
          'ContractField',
          'CacheKey',
          'DBTable',
          'DBColumn',
          'ValueNode',
          'TestCase',
        ] as const;

        for (const label of summaryNodeLabels) {
          const rows = await loadPostDerivedNodeRows(String(label));

          for (const row of rows) {
            const id = String(row.id ?? '').trim();
            if (!id) continue;
            const processType = String(row.processType ?? '').trim();
            const normalizedProcessType = processType === 'intra_community' || processType === 'cross_community'
              ? processType
              : undefined;

            summaryGraph.addNode({
              id,
              label: label as NodeLabel,
              properties: {
                name: String(row.name ?? '').trim(),
                heuristicLabel: String(row.heuristicLabel ?? '').trim(),
                filePath: String(row.filePath ?? '').trim(),
                startLine: Number(row.startLine ?? 0) || undefined,
                endLine: Number(row.endLine ?? 0) || undefined,
                sliceType: String(row.sliceType ?? '').trim(),
                processType: normalizedProcessType,
                closureSlots: Array.isArray(row.closureSlots) ? row.closureSlots : [],
                closedSlots: Array.isArray(row.closedSlots) ? row.closedSlots : [],
                stepCount: Number(row.stepCount ?? 0) || undefined,
              },
            });
            summaryNodeIds.add(id);
          }
        }

        const relationshipRows = await loadPostDerivedRelationRows('summary');
        for (const row of relationshipRows) {
          const sourceId = String(row.sourceId ?? '').trim();
          const targetId = String(row.targetId ?? '').trim();
          const type = String(row.type ?? '').trim();
          if (!sourceId || !targetId || !type) continue;
          if (!summaryNodeIds.has(sourceId) && !summaryNodeIds.has(targetId)) continue;

          summaryGraph.addRelationship({
            id: `inc_summary_${type}_${sourceId}->${targetId}`,
            type: type as RelationshipType,
            sourceId,
            targetId,
            confidence: Number(row.confidence ?? 1.0) || 1.0,
            reason: String(row.reason ?? ''),
            step: Number(row.step ?? 0) || undefined,
          });
        }

        const summarySnapshot = await processStructuredSummaryOverlay(
          summaryGraph,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Summaries: ${message}` });
          },
        );

        await saveStructuredSummarySnapshot(storagePath, summarySnapshot);
        summaryOverlaySummary = {
          symbolCount: summarySnapshot.stats.symbolCount,
          fileCount: summarySnapshot.stats.fileCount,
          sliceCount: summarySnapshot.stats.sliceCount,
          communityCount: summarySnapshot.stats.communityCount,
          processCount: summarySnapshot.stats.processCount,
          archetypeCount: summarySnapshot.stats.archetypeCount,
        };

        const closureTemplatePassStartedAt = Date.now();
        const closureTemplateSnapshot = await processClosureTemplates(
          summaryGraph,
          (message, progress) => {
            if (progress % 20 !== 0 && progress !== 100) return;
            bar.update(89, { phase: `Closure templates: ${message}` });
          },
        );
        await saveClosureTemplateSnapshot(storagePath, closureTemplateSnapshot);
        closureTemplateSummary = {
          totalTemplates: closureTemplateSnapshot.stats.totalTemplates,
          totalSlices: closureTemplateSnapshot.stats.totalSlices,
          totalCoveredSlots: closureTemplateSnapshot.stats.totalCoveredSlots,
          totalRoleExpectations: closureTemplateSnapshot.stats.totalRoleExpectations,
        };
        markPassTiming('closure-templates', closureTemplatePassStartedAt);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        kuzuWarnings.push(`Incremental: unable to refresh structured summaries (${msg.slice(0, 120)})`);
      }
      markPassTiming('structured-summaries', summaryPassStartedAt);
    }

    // Embeddings (incremental, skip cached)
    const stats = await getKuzuStats();
    let embeddingTime = '0.0';
    let embeddingSkipped = false;
    let embeddingSkipReason = '';
    let embeddingSummary: EmbeddingPipelineSummary | null = null;

    if (skipEmbeddings) {
      embeddingSkipped = true;
      embeddingSkipReason = 'skipped (--skip-embeddings)';
    }

    if (!embeddingSkipped) {
      bar.update(90, { phase: 'Embedding new/changed nodes...' });
      const t0Emb = Date.now();
      try {
        embeddingSummary = await runEmbeddingPipeline(
          executeQuery,
          (cypher, paramsList) => executeWithReusedStatement(cypher, paramsList, { throwOnError: true }),
          (progress) => {
            const scaled = 90 + Math.round((progress.percent / 100) * 8);
            const label = progress.phase === 'loading-model' ? 'Loading embedding model...' : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
            bar.update(scaled, { phase: label });
          },
          {},
          { cachePath: embeddingCachePath },
        );
        embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        embeddingSkipped = true;
        embeddingSkipReason = `skipped (embedding pipeline error: ${msg.slice(0, 120)})`;
        kuzuWarnings.push(`Embeddings skipped (${msg.slice(0, 120)})`);
      }
    }

    const fileCount = await getCount('File');
    const communityCount = await getCount('Community');
    const processCount = await getCount('Process');

    return {
      kuzuWarnings,
      kuzuTime,
      ftsTime,
      embeddingTime,
      embeddingSkipped,
      embeddingSkipReason,
      stats,
      fileCount,
      communityCount,
      processCount,
      precision: precisionSummary,
      microDataflow: microDataflowSummary,
      valueGraph: valueGraphSummary,
      provenance: provenanceSummary,
      evidenceSpans: evidenceSpanSummary,
      summaries: summaryOverlaySummary,
      closureTemplates: closureTemplateSummary,
      ...(profileEmbeddings && embeddingSummary ? { embeddingSummary } : {}),
      derived: {
        mode: incrementalDerivedMode,
        skippedPasses: skippedDerivedPasses,
        adaptiveLowSignal: adaptiveLowSignalChangeSet,
        recomputed: {
          communities: recomputeCommunities,
          processes: recomputeProcesses,
          autoCommunities: autoRecomputeCommunities && !options?.incrementalRecomputeCommunities,
          autoProcesses: autoRecomputeProcesses && !options?.incrementalRecomputeProcesses,
        },
        timingsMs: profileDerivedTimings ? derivedPassTimingsMs : undefined,
      },
    };
  };

  // ── Fast path: if commit changed but indexable tree is identical, update meta only ──
  if (existingMeta && !options?.force && !schemaMismatch && !hasAnyFileChanges) {
    bar.update(98, { phase: 'Saving metadata...' });

    const meta = {
      ...existingMeta,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      kuzuSchemaVersion: KUZU_SCHEMA_VERSION,
      ftsSchemaVersion: KUZU_SCHEMA_VERSION,
      // No indexable files changed, so graph stats remain valid.
      stats: existingMeta.stats || undefined,
    };

    await saveMeta(storagePath, meta);
    if (options?.registry !== false) {
      try {
        await registerRepo(repoPath, meta);
      } catch {
        // Non-fatal: indexing still succeeded even if we can't write global registry
      }
    }

    const fastWarnings: string[] = [...profileWarnings];
    let brainManifestPath: string | null = null;
    if (runBrainTick) {
      bar.update(99, { phase: 'Running BrainKernel tick...' });
      brainManifestPath = await runBrainKernelTick(meta, fastWarnings, []);
    } else {
      bar.update(99, { phase: 'Skipping BrainKernel tick (profile)...' });
    }

    bar.update(100, { phase: 'Done' });
    bar.stop();
    console.log('\n  Repository already indexed (no indexable changes)\n');
    if (brainManifestPath) {
      console.log(`  Brain manifest: ${brainManifestPath}`);
    }
    if (fastWarnings.length > 0) {
      console.log(`\n  Warnings (${fastWarnings.length}):`);
      for (const warning of fastWarnings) {
        console.log(`    ${warning}`);
      }
    }
    console.log('');
    return;
  }

  // ── Attempt incremental indexing (fallback to full on failure) ─────
  if (canAttemptIncremental) {
    try {
      const inc = await runIncrementalIndexing();

      bar.update(98, { phase: 'Saving metadata...' });
      const meta = {
        repoPath,
        lastCommit: currentCommit,
        indexedAt: new Date().toISOString(),
        kuzuSchemaVersion: KUZU_SCHEMA_VERSION,
        ftsSchemaVersion: KUZU_SCHEMA_VERSION,
        stats: {
          files: inc.fileCount,
          nodes: inc.stats.nodes,
          edges: inc.stats.edges,
          communities: inc.communityCount,
          processes: inc.processCount,
        },
      };
      await saveMeta(storagePath, meta);
      if (options?.registry !== false) {
        try {
          await registerRepo(repoPath, meta);
        } catch {
          inc.kuzuWarnings.push('Unable to update global registry (non-fatal)');
        }
      }

      let hookResult = { registered: false, message: '' };
      if (options?.hooks !== false) {
        try {
          hookResult = await registerClaudeHook();
        } catch {
          inc.kuzuWarnings.push('Unable to register Claude Code hook (non-fatal)');
        }
      }

      if (options?.updateGitignore) {
        await addToGitignore(repoPath);
      }

      const projectName = path.basename(repoPath);
      const aiContext = options?.writeContext
        ? await generateAIContextFiles(repoPath, storagePath, projectName, meta.stats || {})
        : { files: [] as string[] };

      let brainManifestPath: string | null = null;
      if (runBrainTick) {
        bar.update(99, { phase: 'Running BrainKernel tick...' });
        brainManifestPath = await runBrainKernelTick(
          meta,
          inc.kuzuWarnings,
          [...fileChanges.changed, ...fileChanges.deleted],
        );
      } else {
        bar.update(99, { phase: 'Skipping BrainKernel tick (profile)...' });
      }

      await closeKuzu();
      await disposeEmbedder();

      const totalTime = ((Date.now() - t0Global) / 1000).toFixed(1);

      bar.update(100, { phase: 'Done' });
      bar.stop();

      console.log(`\n  Repository updated incrementally (${totalTime}s)\n`);
      console.log(`  ${inc.stats.nodes.toLocaleString()} nodes | ${inc.stats.edges.toLocaleString()} edges | ${inc.communityCount} clusters | ${inc.processCount} flows`);
      console.log(`  KuzuDB ${inc.kuzuTime}s | FTS ${inc.ftsTime}s | Embeddings ${inc.embeddingSkipped ? inc.embeddingSkipReason : inc.embeddingTime + 's'}`);
      if (inc.embeddingSummary) {
        const sum = inc.embeddingSummary;
        console.log(
          `  Embedding profiling: cache=${sum.cache.readMode} hits=${sum.cache.cacheHits} misses=${sum.cache.cacheMisses} writes=${sum.cache.cacheWrites} overlay_appends=${sum.cache.overlayAppends} model_loaded=${sum.model.loaded ? 'yes' : 'no'} timings_ms(query=${sum.timingsMs.queryNodes} cache=${sum.timingsMs.cacheLoad} embed=${sum.timingsMs.embedCompute} insert=${sum.timingsMs.insert} index=${sum.timingsMs.vectorIndex} save=${sum.timingsMs.cacheSave} overlay=${sum.timingsMs.overlayAppend})`,
        );
      }
      if (inc.precision) {
        const producerBits: string[] = [];
        if (inc.precision.producer) producerBits.push(inc.precision.producer);
        if (inc.precision.producerSkipped && inc.precision.producerSkipReason) {
          producerBits.push(`skipped (${inc.precision.producerSkipReason})`);
        } else if (inc.precision.producerCacheHit) {
          producerBits.push('cache-hit');
        }
        console.log(
          `  Precision ${inc.precision.mode}: ${inc.precision.emittedEdges} imported / ${inc.precision.declaredRelations} declared${producerBits.length > 0 ? ` [${producerBits.join(', ')}]` : ''}`,
        );
      }
      if (inc.microDataflow) {
        console.log(
          `  Micro-dataflow: ${inc.microDataflow.emittedEdges} derived edges (request ${inc.microDataflow.requestFieldReads}, response ${inc.microDataflow.responseFieldWrites}, invalidation ${inc.microDataflow.queryInvalidationClosures})`,
        );
      }
      if (inc.valueGraph) {
        console.log(
          `  Value graph: ${inc.valueGraph.valueCount} values / ${inc.valueGraph.edgeCount} edges (permission ${inc.valueGraph.permissionValues}, endpoint ${inc.valueGraph.endpointValues}, role ${inc.valueGraph.roleValues}, feature-flag ${inc.valueGraph.featureFlagValues}, config ${inc.valueGraph.configKeyValues}, env ${inc.valueGraph.envVarValues}, queue ${inc.valueGraph.queueNameValues}, broadcast ${inc.valueGraph.broadcastChannelValues}, event ${inc.valueGraph.eventNameValues}, command ${inc.valueGraph.commandNameValues}, i18n ${inc.valueGraph.i18nKeyValues}, route ${inc.valueGraph.routeNameValues}, route-segment ${inc.valueGraph.routeSegmentValues}, cache ${inc.valueGraph.cacheKeyValues}, query-family ${inc.valueGraph.queryKeyFamilyValues}, table ${inc.valueGraph.tableNameValues}, table-column ${inc.valueGraph.tableColumnValues}, tailwind ${inc.valueGraph.tailwindClassValues}, props ${inc.valueGraph.componentPropValues}, context ${inc.valueGraph.reactContextValues}, providers ${inc.valueGraph.providerSurfaceValues})`,
        );
      }
      if (inc.provenance) {
        console.log(
          `  Provenance: ${inc.provenance.emittedEdges} edges (route ${inc.provenance.routeExpansionEdges}, enum ${inc.provenance.enumToSlugEdges}, config ${inc.provenance.configDrivenEdges}, framework ${inc.provenance.frameworkDerivedEdges})`,
        );
      }
      if (inc.evidenceSpans) {
        console.log(
          `  Evidence spans: ${inc.evidenceSpans.nodeEvidenceCount} nodes / ${inc.evidenceSpans.edgeEvidenceCount} edges (${inc.evidenceSpans.witnessSpanCount} witness, ${inc.evidenceSpans.proofSpanCount} proof)`,
        );
      }
      if (inc.summaries) {
        console.log(
          `  Summaries: symbol ${inc.summaries.symbolCount}, file ${inc.summaries.fileCount}, slice ${inc.summaries.sliceCount}, community ${inc.summaries.communityCount}, process ${inc.summaries.processCount}, archetype ${inc.summaries.archetypeCount}`,
        );
      }
      if (inc.closureTemplates) {
        console.log(
          `  Closure templates: ${inc.closureTemplates.totalTemplates} templates from ${inc.closureTemplates.totalSlices} slices (${inc.closureTemplates.totalCoveredSlots} slot signals, ${inc.closureTemplates.totalRoleExpectations} role signals)`,
        );
      }
      console.log(`  ${repoPath}`);
      if (brainManifestPath) {
        console.log(`  Brain manifest: ${brainManifestPath}`);
      }
      const derivedParts: string[] = [];
      if (inc.derived.recomputed.communities) derivedParts.push('communities');
      if (inc.derived.recomputed.processes) derivedParts.push('processes');
      if (derivedParts.length === 0) {
        console.log(`  Incremental note: communities/processes were not recomputed (use --incremental-recompute-communities / --incremental-recompute-processes, or --force).`);
      } else if (derivedParts.length === 2) {
        console.log(`  Incremental note: communities/processes recomputed.`);
      } else {
        console.log(`  Incremental note: recomputed ${derivedParts.join(' + ')} (use the other --incremental-recompute-* flag, or --force).`);
      }
      if (inc.derived.recomputed.autoCommunities || inc.derived.recomputed.autoProcesses) {
        const autoParts: string[] = [];
        if (inc.derived.recomputed.autoCommunities) autoParts.push('communities');
        if (inc.derived.recomputed.autoProcesses) autoParts.push('processes');
        console.log(`  Incremental adaptive note: auto-recomputed ${autoParts.join(' + ')} for entrypoint-sensitive changes.`);
      }
      if (inc.derived.skippedPasses.length > 0) {
        if (inc.derived.mode === 'adaptive' && inc.derived.adaptiveLowSignal) {
          console.log(`  Incremental derived mode: adaptive (low-signal skip: ${inc.derived.skippedPasses.join(', ')})`);
        } else {
          console.log(`  Incremental derived mode: ${inc.derived.mode} (skipped ${inc.derived.skippedPasses.join(', ')})`);
        }
      } else if (inc.derived.mode !== 'full') {
        console.log(`  Incremental derived mode: ${inc.derived.mode}`);
      }
      if (inc.derived.timingsMs && Object.keys(inc.derived.timingsMs).length > 0) {
        const parts = Object.entries(inc.derived.timingsMs)
          .sort((a, b) => b[1] - a[1])
          .map(([name, ms]) => `${name}=${ms}ms`);
        console.log(`  Incremental derived timings: ${parts.join(', ')}`);
      }

      if (aiContext.files.length > 0) {
        console.log(`  Context: ${aiContext.files.join(', ')}`);
      }

      if (hookResult.registered) {
        console.log(`  Hooks: ${hookResult.message}`);
      }

      if (inc.kuzuWarnings.length > 0) {
        console.log(`\n  Warnings (${inc.kuzuWarnings.length}):`);
        for (const w of inc.kuzuWarnings) {
          console.log(`    ${w}`);
        }
      }

      try {
        await fs.access(getGlobalRegistryPath());
      } catch {
        console.log('\n  Tip: Run `gitnexus setup` to configure MCP for your editor.');
      }

      console.log('');
      return;
    } catch (err: any) {
      bar.update(0, { phase: 'Incremental failed, falling back to full...' });
      try { await closeKuzu(); } catch {}
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ─────────────────────────────────
  const t0Pipeline = Date.now();
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const scaled = Math.round(progress.percent * 0.6);
    bar.update(scaled, { phase: phaseLabel });
  }, {
    precisionOverlayMode,
    precisionOverlayPath: options?.precisionOverlayPath,
    precisionOverlayForce: options?.precisionOverlayForce,
    graphExpectationPath: options?.graphExpectationPath,
    skipCochange,
  });
  const pipelineTime = ((Date.now() - t0Pipeline) / 1000).toFixed(1);

  let fullEvidenceSpanSummary: {
    nodeEvidenceCount: number;
    edgeEvidenceCount: number;
    uniqueFiles: number;
    primarySpanCount: number;
    witnessSpanCount: number;
    proofSpanCount: number;
  } | undefined;
  let fullSummaryOverlaySummary: {
    symbolCount: number;
    fileCount: number;
    sliceCount: number;
    communityCount: number;
    processCount: number;
    archetypeCount: number;
  } | undefined;
  let fullClosureTemplateSummary: {
    totalTemplates: number;
    totalSlices: number;
    totalCoveredSlots: number;
    totalRoleExpectations: number;
  } | undefined;

  // ── Phase 2: KuzuDB (60–85%) ──────────────────────────────────────
  bar.update(60, { phase: 'Loading into KuzuDB...' });

  await closeKuzu();
  const kuzuFiles = [kuzuPath, `${kuzuPath}.wal`, `${kuzuPath}.lock`];
  for (const f of kuzuFiles) {
    try { await fs.rm(f, { recursive: true, force: true }); } catch {}
  }

  const t0Kuzu = Date.now();
  await initKuzu(kuzuPath);
  let kuzuMsgCount = 0;
  const kuzuResult = await loadGraphToKuzu(pipelineResult.graph, pipelineResult.fileContents, storagePath, (msg) => {
    kuzuMsgCount++;
    const progress = Math.min(84, 60 + Math.round((kuzuMsgCount / (kuzuMsgCount + 10)) * 24));
    bar.update(progress, { phase: msg });
  });
  const kuzuTime = ((Date.now() - t0Kuzu) / 1000).toFixed(1);
  const kuzuWarnings = [...kuzuResult.warnings, ...profileWarnings];
  if (incrementalDerivedFastDeprecated) {
    kuzuWarnings.push('Incremental derived mode "fast" is deprecated; running as "full".');
  }

  let evidenceTime = '0.0';
  try {
    bar.update(84, { phase: 'Materializing evidence spans...' });
    const t0Evidence = Date.now();
    const evidenceSnapshot = await processEvidenceSpans(
      pipelineResult.graph,
      (message, progress) => {
        if (progress % 20 !== 0 && progress !== 100) return;
        bar.update(84, { phase: `Evidence spans: ${message}` });
      },
    );
    await saveEvidenceSpanSnapshot(storagePath, evidenceSnapshot);
    evidenceTime = ((Date.now() - t0Evidence) / 1000).toFixed(1);
    fullEvidenceSpanSummary = {
      nodeEvidenceCount: evidenceSnapshot.stats.nodeEvidenceCount,
      edgeEvidenceCount: evidenceSnapshot.stats.edgeEvidenceCount,
      uniqueFiles: evidenceSnapshot.stats.uniqueFiles,
      primarySpanCount: evidenceSnapshot.stats.primarySpanCount,
      witnessSpanCount: evidenceSnapshot.stats.witnessSpanCount,
      proofSpanCount: evidenceSnapshot.stats.proofSpanCount,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    kuzuWarnings.push(`Unable to refresh evidence spans (${msg.slice(0, 120)})`);
  }

  let summariesTime = '0.0';
  try {
    bar.update(84, { phase: 'Materializing structured summaries...' });
    const t0Summaries = Date.now();
    const summarySnapshot = await processStructuredSummaryOverlay(
      pipelineResult.graph,
      (message, progress) => {
        if (progress % 20 !== 0 && progress !== 100) return;
        bar.update(84, { phase: `Summaries: ${message}` });
      },
    );
    await saveStructuredSummarySnapshot(storagePath, summarySnapshot);
    fullSummaryOverlaySummary = {
      symbolCount: summarySnapshot.stats.symbolCount,
      fileCount: summarySnapshot.stats.fileCount,
      sliceCount: summarySnapshot.stats.sliceCount,
      communityCount: summarySnapshot.stats.communityCount,
      processCount: summarySnapshot.stats.processCount,
      archetypeCount: summarySnapshot.stats.archetypeCount,
    };

    const closureTemplateSnapshot = await processClosureTemplates(
      pipelineResult.graph,
      (message, progress) => {
        if (progress % 20 !== 0 && progress !== 100) return;
        bar.update(84, { phase: `Closure templates: ${message}` });
      },
    );
    await saveClosureTemplateSnapshot(storagePath, closureTemplateSnapshot);
    fullClosureTemplateSummary = {
      totalTemplates: closureTemplateSnapshot.stats.totalTemplates,
      totalSlices: closureTemplateSnapshot.stats.totalSlices,
      totalCoveredSlots: closureTemplateSnapshot.stats.totalCoveredSlots,
      totalRoleExpectations: closureTemplateSnapshot.stats.totalRoleExpectations,
    };
    summariesTime = ((Date.now() - t0Summaries) / 1000).toFixed(1);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    kuzuWarnings.push(`Unable to refresh structured summaries (${msg.slice(0, 120)})`);
  }

  // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
  bar.update(85, { phase: 'Creating search indexes...' });

  const ftsTime = shouldEnsureFtsIndexes ? await ensureFtsIndexes() : '0.0';

  // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
  const stats = await getKuzuStats();
  let embeddingTime = '0.0';
  let embeddingSkipped = false;
  let embeddingSkipReason = '';
  const profileEmbeddings = process.env.GITNEXUS_PROFILE_EMBEDDINGS === '1';
  let embeddingSummary: EmbeddingPipelineSummary | null = null;

  if (skipEmbeddings) {
    embeddingSkipped = true;
    embeddingSkipReason = 'skipped (--skip-embeddings)';
  }

  if (!embeddingSkipped) {
    bar.update(90, { phase: 'Loading embedding model...' });
    const t0Emb = Date.now();
    try {
      embeddingSummary = await runEmbeddingPipeline(
        executeQuery,
        (cypher, paramsList) => executeWithReusedStatement(cypher, paramsList, { throwOnError: true }),
        (progress) => {
          const scaled = 90 + Math.round((progress.percent / 100) * 8);
          const label = progress.phase === 'loading-model' ? 'Loading embedding model...' : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
          bar.update(scaled, { phase: label });
        },
        {},
        { cachePath: embeddingCachePath },
      );
      embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      embeddingSkipped = true;
      embeddingSkipReason = `skipped (embedding pipeline error: ${msg.slice(0, 120)})`;
      kuzuWarnings.push(`Embeddings skipped (${msg.slice(0, 120)})`);
    }
  }

  // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
  bar.update(98, { phase: 'Saving metadata...' });

  const meta = {
    repoPath,
    lastCommit: currentCommit,
    indexedAt: new Date().toISOString(),
    kuzuSchemaVersion: KUZU_SCHEMA_VERSION,
    ftsSchemaVersion: KUZU_SCHEMA_VERSION,
    stats: {
      files: pipelineResult.fileContents.size,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: pipelineResult.communityResult?.stats.totalCommunities,
      processes: pipelineResult.processResult?.stats.totalProcesses,
    },
  };
  await saveMeta(storagePath, meta);
  if (options?.registry !== false) {
    try {
      await registerRepo(repoPath, meta);
    } catch {
      kuzuWarnings.push('Unable to update global registry (non-fatal)');
    }
  }

  let hookResult = { registered: false, message: '' };
  if (options?.hooks !== false) {
    try {
      hookResult = await registerClaudeHook();
    } catch {
      kuzuWarnings.push('Unable to register Claude Code hook (non-fatal)');
    }
  }

  const projectName = path.basename(repoPath);
  let aggregatedClusterCount = 0;
  if (pipelineResult.communityResult?.communities) {
    const groups = new Map<string, number>();
    for (const c of pipelineResult.communityResult.communities) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      groups.set(label, (groups.get(label) || 0) + c.symbolCount);
    }
    aggregatedClusterCount = Array.from(groups.values()).filter(count => count >= 5).length;
  }

  if (options?.updateGitignore) {
    await addToGitignore(repoPath);
  }

  const aiContext = options?.writeContext
    ? await generateAIContextFiles(repoPath, storagePath, projectName, {
      files: pipelineResult.fileContents.size,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: pipelineResult.communityResult?.stats.totalCommunities,
      clusters: aggregatedClusterCount,
      processes: pipelineResult.processResult?.stats.totalProcesses,
    })
    : { files: [] as string[] };

  let brainManifestPath: string | null = null;
  if (runBrainTick) {
    bar.update(99, { phase: 'Running BrainKernel tick...' });
    brainManifestPath = await runBrainKernelTick(
      meta,
      kuzuWarnings,
      [...fileChanges.changed, ...fileChanges.deleted],
    );
  } else {
    bar.update(99, { phase: 'Skipping BrainKernel tick (profile)...' });
  }

  await closeKuzu();
  await disposeEmbedder();

  const totalTime = ((Date.now() - t0Global) / 1000).toFixed(1);

  bar.update(100, { phase: 'Done' });
  bar.stop();

  // ── Summary ───────────────────────────────────────────────────────
  console.log(`\n  Repository indexed successfully (${totalTime}s)\n`);
  console.log(`  ${stats.nodes.toLocaleString()} nodes | ${stats.edges.toLocaleString()} edges | ${pipelineResult.communityResult?.stats.totalCommunities || 0} clusters | ${pipelineResult.processResult?.stats.totalProcesses || 0} flows`);
  console.log(`  KuzuDB ${kuzuTime}s | FTS ${ftsTime}s | Embeddings ${embeddingSkipped ? embeddingSkipReason : embeddingTime + 's'}`);
  if (profileEmbeddings && embeddingSummary) {
    const sum = embeddingSummary;
    console.log(
      `  Embedding profiling: cache=${sum.cache.readMode} hits=${sum.cache.cacheHits} misses=${sum.cache.cacheMisses} writes=${sum.cache.cacheWrites} overlay_appends=${sum.cache.overlayAppends} model_loaded=${sum.model.loaded ? 'yes' : 'no'} timings_ms(query=${sum.timingsMs.queryNodes} cache=${sum.timingsMs.cacheLoad} embed=${sum.timingsMs.embedCompute} insert=${sum.timingsMs.insert} index=${sum.timingsMs.vectorIndex} save=${sum.timingsMs.cacheSave} overlay=${sum.timingsMs.overlayAppend})`,
    );
  }
  console.log(`  Pipeline ${pipelineTime}s | Evidence ${evidenceTime}s | Summaries ${summariesTime}s`);
  const profilePipeline = process.env.GITNEXUS_PROFILE_PIPELINE === '1';
  if (profilePipeline && pipelineResult.timingsMs && Object.keys(pipelineResult.timingsMs).length > 0) {
    const sorted = Object.entries(pipelineResult.timingsMs)
      .filter(([name]) => name !== 'total')
      .sort((a, b) => b[1] - a[1])
    const MAX_PARTS = 20;
    const parts = sorted.slice(0, MAX_PARTS).map(([name, ms]) => `${name}=${ms}ms`);
    const omitted = Math.max(0, sorted.length - parts.length);
    const totalMs = pipelineResult.timingsMs.total;
    console.log(`  Pipeline timings: ${parts.join(', ')}${omitted > 0 ? ` (+${omitted} more)` : ''}${typeof totalMs === 'number' ? ` (total=${totalMs}ms)` : ''}`);
  }
  if (pipelineResult.precisionOverlayResult) {
    const precision = pipelineResult.precisionOverlayResult.stats;
    const producerBits: string[] = [];
    if (precision.producer) producerBits.push(precision.producer);
    if (precision.producerSkipped && precision.producerSkipReason) {
      producerBits.push(`skipped (${precision.producerSkipReason})`);
    } else if (precision.producerCacheHit) {
      producerBits.push('cache-hit');
    }
    const modeLabel = precision.producerMode || precisionOverlayMode;
    console.log(
      `  Precision ${modeLabel}: ${precision.emittedEdges} imported / ${precision.declaredRelations} declared${producerBits.length > 0 ? ` [${producerBits.join(', ')}]` : ''}`,
    );
  }
  if (pipelineResult.microDataflowResult) {
    const microflow = pipelineResult.microDataflowResult.stats;
    console.log(
      `  Micro-dataflow: ${microflow.emittedEdges} derived edges (request ${microflow.requestFieldReads}, response ${microflow.responseFieldWrites}, invalidation ${microflow.queryInvalidationClosures})`,
    );
  }
  if (pipelineResult.valueGraphResult) {
    const valueGraph = pipelineResult.valueGraphResult.stats;
    console.log(
      `  Value graph: ${valueGraph.valueCount} values / ${valueGraph.edgeCount} edges (permission ${valueGraph.permissionValues}, endpoint ${valueGraph.endpointValues}, role ${valueGraph.roleValues}, feature-flag ${valueGraph.featureFlagValues}, config ${valueGraph.configKeyValues}, env ${valueGraph.envVarValues}, queue ${valueGraph.queueNameValues}, broadcast ${valueGraph.broadcastChannelValues}, event ${valueGraph.eventNameValues}, command ${valueGraph.commandNameValues}, i18n ${valueGraph.i18nKeyValues}, route ${valueGraph.routeNameValues}, route-segment ${valueGraph.routeSegmentValues}, cache ${valueGraph.cacheKeyValues}, query-family ${valueGraph.queryKeyFamilyValues}, table ${valueGraph.tableNameValues}, table-column ${valueGraph.tableColumnValues}, tailwind ${valueGraph.tailwindClassValues}, props ${valueGraph.componentPropValues}, context ${valueGraph.reactContextValues}, providers ${valueGraph.providerSurfaceValues})`,
    );
  }
  if (pipelineResult.provenanceResult) {
    const provenance = pipelineResult.provenanceResult.stats;
    console.log(
      `  Provenance: ${provenance.emittedEdges} edges (route ${provenance.routeExpansionEdges}, enum ${provenance.enumToSlugEdges}, config ${provenance.configDrivenEdges}, framework ${provenance.frameworkDerivedEdges})`,
    );
  }
  if (fullEvidenceSpanSummary) {
    console.log(
      `  Evidence spans: ${fullEvidenceSpanSummary.nodeEvidenceCount} nodes / ${fullEvidenceSpanSummary.edgeEvidenceCount} edges (${fullEvidenceSpanSummary.witnessSpanCount} witness, ${fullEvidenceSpanSummary.proofSpanCount} proof)`,
    );
  }
  if (fullSummaryOverlaySummary) {
    console.log(
      `  Summaries: symbol ${fullSummaryOverlaySummary.symbolCount}, file ${fullSummaryOverlaySummary.fileCount}, slice ${fullSummaryOverlaySummary.sliceCount}, community ${fullSummaryOverlaySummary.communityCount}, process ${fullSummaryOverlaySummary.processCount}, archetype ${fullSummaryOverlaySummary.archetypeCount}`,
    );
  }
  if (fullClosureTemplateSummary) {
    console.log(
      `  Closure templates: ${fullClosureTemplateSummary.totalTemplates} templates from ${fullClosureTemplateSummary.totalSlices} slices (${fullClosureTemplateSummary.totalCoveredSlots} slot signals, ${fullClosureTemplateSummary.totalRoleExpectations} role signals)`,
    );
  }
  console.log(`  ${repoPath}`);
  if (brainManifestPath) {
    console.log(`  Brain manifest: ${brainManifestPath}`);
  }

  if (aiContext.files.length > 0) {
    console.log(`  Context: ${aiContext.files.join(', ')}`);
  }

  if (hookResult.registered) {
    console.log(`  Hooks: ${hookResult.message}`);
  }

  // Show warnings (missing schema pairs, etc.) after the clean output
  if (kuzuWarnings.length > 0) {
    console.log(`\n  Warnings (${kuzuWarnings.length}):`);
    for (const w of kuzuWarnings) {
      console.log(`    ${w}`);
    }
  }

  try {
    await fs.access(getGlobalRegistryPath());
  } catch {
    console.log('\n  Tip: Run `gitnexus setup` to configure MCP for your editor.');
  }

  console.log('');
};
