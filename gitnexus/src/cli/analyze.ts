/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/
 */

import path from 'path';
import cliProgress from 'cli-progress';
import { runPipelineFromRepo } from '../core/ingestion/pipeline.js';
import { initKuzu, loadGraphToKuzu, getKuzuStats, executeQuery, executeWithReusedStatement, closeKuzu, createFTSIndex, loadCachedEmbeddings, deleteNodesForFile, deleteOutgoingRelationshipsForFile, getUpstreamFilePathsForFiles, loadSymbolDefinitionsFromKuzu, loadEmbeddingNodeIds } from '../core/kuzu/kuzu-adapter.js';
import { runEmbeddingPipeline } from '../core/embeddings/embedding-pipeline.js';
import { disposeEmbedder } from '../core/embeddings/embedder.js';
import { getStoragePaths, saveMeta, loadMeta, addToGitignore, registerRepo, getGlobalRegistryPath } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot, getCommittedFileChanges, getWorkingTreeFileChanges, mergeGitFileChanges } from '../storage/git.js';
import { KUZU_SCHEMA_VERSION } from '../core/kuzu/schema.js';
import { generateAIContextFiles } from './ai-context.js';
import fs from 'fs/promises';
import { registerClaudeHook } from './claude-hooks.js';
import { shouldIgnorePath } from '../config/ignore-service.js';
import { listRepositoryFiles, readRepositoryFiles } from '../core/ingestion/filesystem-walker.js';
import { createKnowledgeGraph } from '../core/graph/graph.js';
import { createSymbolTable } from '../core/ingestion/symbol-table.js';
import { createASTCache } from '../core/ingestion/ast-cache.js';
import { processParsing } from '../core/ingestion/parsing-processor.js';
import { processImportsFromExtracted, createImportMap, createPhpUseAliasMap } from '../core/ingestion/import-processor.js';
import { processCallsFromExtracted } from '../core/ingestion/call-processor.js';
import { processHeritageFromExtracted } from '../core/ingestion/heritage-processor.js';
import { createWorkerPool, WorkerPool } from '../core/ingestion/workers/worker-pool.js';
import { processLaravelRoutes, ROUTE_FILE_PATH_RE } from '../core/ingestion/laravel-route-processor.js';
import { processLaravelHttpWiring } from '../core/ingestion/laravel-http-processor.js';
import { processLaravelRouteNameWiring } from '../core/ingestion/laravel-route-name-processor.js';
import { processLaravelSemanticEdges } from '../core/ingestion/laravel-semantic-processor.js';
import { processLaravelAuthorization } from '../core/ingestion/laravel-auth-processor.js';
import { processLaravelPermissionsConfig } from '../core/ingestion/laravel-permissions-config-processor.js';
import { processPhpMatchReturnEdges } from '../core/ingestion/php-match-return-processor.js';
import { processLaravelEloquentRelationships } from '../core/ingestion/laravel-eloquent-relationship-processor.js';
import { processLaravelEloquentLoadEdges } from '../core/ingestion/laravel-eloquent-load-processor.js';
import { processLaravelResourceContracts } from '../core/ingestion/laravel-resource-contract-processor.js';
import { processReactQueryKeyWiring } from '../core/ingestion/react-query-processor.js';
import { processLaravelViewsAndMail } from '../core/ingestion/laravel-view-mail-processor.js';
import { processLaravelEvents } from '../core/ingestion/laravel-event-processor.js';
import { processLaravelEventDispatch } from '../core/ingestion/laravel-event-dispatch-processor.js';
import { processLaravelSchedule } from '../core/ingestion/laravel-schedule-processor.js';
import { processLaravelJobDispatch } from '../core/ingestion/laravel-job-dispatch-processor.js';
import { processLaravelNotifications } from '../core/ingestion/laravel-notification-processor.js';
import { processLaravelTacticianDispatch } from '../core/ingestion/laravel-tactician-dispatch-processor.js';
import { processBladeTemplatesIncremental } from '../core/ingestion/blade-template-processor.js';

export interface AnalyzeOptions {
  force?: boolean;
  skipEmbeddings?: boolean;
  registry?: boolean;
  hooks?: boolean;
  writeContext?: boolean;
  updateGitignore?: boolean;
}

/** Threshold: auto-skip embeddings for repos with more nodes than this */
const EMBEDDING_NODE_LIMIT = 50_000;

const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  kuzu: 'Loading into KuzuDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
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

  const { storagePath, kuzuPath } = getStoragePaths(repoPath);
  const currentCommit = getCurrentCommit(repoPath);
  const existingMeta = await loadMeta(storagePath);
  const existingSchemaVersion = existingMeta?.kuzuSchemaVersion ?? 1;
  const schemaMismatch = existingMeta !== null && existingSchemaVersion !== KUZU_SCHEMA_VERSION;

  const rawChanges = existingMeta && !options?.force
    ? mergeGitFileChanges(
      getCommittedFileChanges(repoPath, existingMeta.lastCommit, currentCommit),
      getWorkingTreeFileChanges(repoPath),
    )
    : { changed: [], deleted: [] };

  const filterIndexablePaths = (paths: string[]): string[] => {
    const unique = Array.from(new Set(paths.map(p => p.replace(/\\/g, '/').trim()).filter(Boolean)));
    return unique.filter(p => !shouldIgnorePath(p));
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

  const shouldForceFullDueToConfig = [...fileChanges.changed, ...fileChanges.deleted].some(fp => {
    const base = path.posix.basename(fp);
    if (GLOBAL_FULL_REINDEX_BASENAMES.has(base)) return true;
    // Cross-file enrichment can introduce duplicate edges in incremental mode; be conservative.
    if (/(^|\/)config\/permissions\.php$/i.test(fp)) return true;
    return false;
  });

  const hasExistingIndex = existingMeta !== null;
  const canAttemptIncremental = hasExistingIndex && !options?.force && !schemaMismatch && hasAnyFileChanges && !shouldForceFullDueToConfig && fileChangesTotal <= 500;

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
  }> => {
    bar.update(1, { phase: 'Incremental: scanning repo files...' });

    // Validate index exists on disk
    try {
      await fs.access(kuzuPath);
    } catch {
      throw new Error('Missing existing KuzuDB index file');
    }

    const allRepoFiles = await listRepositoryFiles(repoPath);
    const allRepoFileSet = new Set(allRepoFiles);

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

    const rebuildSet = new Set(rebuildFiles);

    bar.update(5, { phase: `Incremental: ${rebuildFiles.length} changed, ${deletedFiles.size} deleted` });

    // Open existing KuzuDB (in-place update)
    await closeKuzu();
    await initKuzu(kuzuPath);

    const impactedFiles = Array.from(new Set([...rebuildFiles, ...Array.from(deletedFiles)]));

    bar.update(8, { phase: 'Incremental: finding affected callers...' });
    const upstreamFiles = await getUpstreamFilePathsForFiles(impactedFiles);

    const impactedSet = new Set(impactedFiles);
    const refreshEdgeFiles = new Set<string>();
    for (const fp of upstreamFiles) {
      if (impactedSet.has(fp)) continue;
      if (!allRepoFileSet.has(fp)) continue;
      if (shouldIgnorePath(fp)) continue;
      refreshEdgeFiles.add(fp);
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

    const processedFiles = Array.from(new Set([...rebuildFiles, ...Array.from(refreshEdgeFiles)]));
    const processedSet = new Set(processedFiles);

    // Delete nodes for removed files
    if (deletedFiles.size > 0) {
      bar.update(12, { phase: 'Incremental: removing deleted files...' });
      for (const fp of deletedFiles) {
        await deleteNodesForFile(fp, { includeFileNode: true });
      }
    }

    // Delete code/symbol nodes for changed files, but keep File nodes (preserves CONTAINS edges)
    if (rebuildFiles.length > 0) {
      bar.update(16, { phase: 'Incremental: clearing changed symbols...' });
      for (const fp of rebuildFiles) {
        await deleteNodesForFile(fp, { includeFileNode: false });
      }
    }

    // Clear outgoing edges for processed files (we will re-emit them from fresh analysis)
    bar.update(20, { phase: 'Incremental: clearing outgoing edges...' });
    const EDGE_TYPES_TO_CLEAR = ['IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS'];
    for (const fp of processedFiles) {
      await deleteOutgoingRelationshipsForFile(fp, EDGE_TYPES_TO_CLEAR);
    }

    // Capture embedding skip set AFTER deletions (so removed embeddings aren't treated as cached)
    const cachedEmbeddingNodeIds = await loadEmbeddingNodeIds();

    // Load full symbol table from the existing index (post-delete)
    bar.update(24, { phase: 'Incremental: loading symbol table...' });
    const symbolTable = createSymbolTable();
    const existingDefs = await loadSymbolDefinitionsFromKuzu();
    for (const def of existingDefs) {
      symbolTable.add(def.filePath, def.name, def.nodeId, def.type);
    }

    // Read file contents for processed files (changed + edge refresh)
    bar.update(28, { phase: `Incremental: reading ${processedFiles.length} file(s)...` });
    const processedEntries = await readRepositoryFiles(repoPath, processedFiles, (current, total, filePath) => {
      if (current % 50 !== 0 && current !== total) return;
      const pct = 28 + Math.round((current / Math.max(1, total)) * 14); // 28-42
      bar.update(Math.min(42, pct), { phase: `Reading ${current}/${total}: ${filePath}` });
    });

    const contentByPath = new Map<string, string>();
    for (const entry of processedEntries) contentByPath.set(entry.path, entry.content);

    // Upsert File nodes with updated content for rebuild files (keeps existing edges)
    bar.update(43, { phase: 'Incremental: updating File nodes...' });
    const fileUpserts = rebuildFiles.map(fp => ({
      id: `File:${fp}`,
      name: path.posix.basename(fp),
      filePath: fp,
      content: contentByPath.get(fp) || '',
    }));
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

    // Imports (fast path: uses worker-extracted imports)
    bar.update(58, { phase: 'Incremental: resolving imports...' });
    const allFileStubs = allRepoFiles.map(p => ({ path: p, content: '' }));
    await processImportsFromExtracted(
      workGraph,
      allFileStubs,
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
    await processLaravelSemanticEdges(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelEloquentRelationships(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelEloquentLoadEdges(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelResourceContracts(workGraph, processedEntries, astCache, symbolTable, importMap);
    await processLaravelAuthorization(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processLaravelPermissionsConfig(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processPhpMatchReturnEdges(workGraph, processedEntries, astCache, symbolTable, importMap, phpUseAliases);
    await processReactQueryKeyWiring(workGraph, processedEntries, astCache, symbolTable, importMap);

    // Build an insertion graph: insert nodes only for rebuild files, but edges for all processed sources.
    bar.update(78, { phase: 'Incremental: preparing Kuzu load...' });
    const insertGraph = createKnowledgeGraph();

    const nodeFilePathById = new Map<string, string>();
    for (const node of workGraph.nodes) {
      const fp = String(node.properties?.filePath || '').trim();
      if (!fp) continue;
      nodeFilePathById.set(node.id, fp);
      if (!rebuildSet.has(fp)) continue;
      insertGraph.addNode(node);
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
        if (!rebuildSet.has(srcFilePath)) continue;
      } else {
        // Only insert non-structure edges for files we explicitly refreshed.
        if (!processedSet.has(srcFilePath)) continue;
      }

      insertGraph.addRelationship(rel);
    }

    const rebuildContents = new Map<string, string>();
    for (const fp of rebuildFiles) {
      rebuildContents.set(fp, contentByPath.get(fp) || '');
    }

    // Load partial graph into existing KuzuDB
    const t0Kuzu = Date.now();
    let kuzuMsgCount = 0;
    const kuzuResult = await loadGraphToKuzu(insertGraph, rebuildContents, storagePath, (msg) => {
      kuzuMsgCount++;
      const pct = 78 + Math.min(10, Math.round((kuzuMsgCount / (kuzuMsgCount + 10)) * 10)); // 78-88
      bar.update(pct, { phase: msg });
    });
    const kuzuTime = ((Date.now() - t0Kuzu) / 1000).toFixed(1);

    // Best-effort: ensure FTS exists (creation is idempotent)
    const t0Fts = Date.now();
    try {
      await createFTSIndex('File', 'file_fts', ['name', 'content']);
      await createFTSIndex('Function', 'function_fts', ['name', 'content']);
      await createFTSIndex('Class', 'class_fts', ['name', 'content']);
      await createFTSIndex('Method', 'method_fts', ['name', 'content']);
      await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
      await createFTSIndex('CodeElement', 'codeelement_fts', ['name', 'content']);
      await createFTSIndex('Const', 'const_fts', ['name', 'content']);
    } catch {
      // best-effort
    }
    const ftsTime = ((Date.now() - t0Fts) / 1000).toFixed(1);

    // Embeddings (incremental, skip cached)
    const stats = await getKuzuStats();
    let embeddingTime = '0.0';
    let embeddingSkipped = false;
    let embeddingSkipReason = '';

    if (options?.skipEmbeddings) {
      embeddingSkipped = true;
      embeddingSkipReason = 'skipped (--skip-embeddings)';
    } else if (stats.nodes > EMBEDDING_NODE_LIMIT) {
      embeddingSkipped = true;
      embeddingSkipReason = `skipped (${stats.nodes.toLocaleString()} nodes > ${EMBEDDING_NODE_LIMIT.toLocaleString()} limit)`;
    }

    if (!embeddingSkipped) {
      bar.update(90, { phase: 'Embedding new/changed nodes...' });
      const t0Emb = Date.now();
      await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (progress) => {
          const scaled = 90 + Math.round((progress.percent / 100) * 8);
          const label = progress.phase === 'loading-model' ? 'Loading embedding model...' : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
          bar.update(scaled, { phase: label });
        },
        {},
        cachedEmbeddingNodeIds,
      );
      embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
    }

    // Note: communities/processes are NOT recomputed in incremental mode.
    const fileCount = await getCount('File');
    const communityCount = await getCount('Community');
    const processCount = await getCount('Process');

    return {
      kuzuWarnings: kuzuResult.warnings,
      kuzuTime,
      ftsTime,
      embeddingTime,
      embeddingSkipped,
      embeddingSkipReason,
      stats,
      fileCount,
      communityCount,
      processCount,
    };
  };

  // ── Fast path: if commit changed but tree is identical, update meta only ──
  if (existingMeta && !options?.force && !schemaMismatch && !hasAnyFileChanges) {
    bar.update(98, { phase: 'Saving metadata...' });
    const stats = await (async () => {
      try {
        await initKuzu(kuzuPath);
        return await getKuzuStats();
      } catch {
        return { nodes: 0, edges: 0 };
      } finally {
        try { await closeKuzu(); } catch {}
      }
    })();

    const meta = {
      ...existingMeta,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      kuzuSchemaVersion: KUZU_SCHEMA_VERSION,
      stats: {
        ...(existingMeta.stats || {}),
        nodes: stats.nodes,
        edges: stats.edges,
      },
    };

    await saveMeta(storagePath, meta);
    if (options?.registry !== false) {
      try {
        await registerRepo(repoPath, meta);
      } catch {
        // Non-fatal: indexing still succeeded even if we can't write global registry
      }
    }

    bar.update(100, { phase: 'Done' });
    bar.stop();
    console.log('\n  Repository already indexed (tree unchanged)\n');
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

      await closeKuzu();
      await disposeEmbedder();

      const totalTime = ((Date.now() - t0Global) / 1000).toFixed(1);

      bar.update(100, { phase: 'Done' });
      bar.stop();

      console.log(`\n  Repository updated incrementally (${totalTime}s)\n`);
      console.log(`  ${inc.stats.nodes.toLocaleString()} nodes | ${inc.stats.edges.toLocaleString()} edges | ${inc.communityCount} clusters | ${inc.processCount} flows`);
      console.log(`  KuzuDB ${inc.kuzuTime}s | FTS ${inc.ftsTime}s | Embeddings ${inc.embeddingSkipped ? inc.embeddingSkipReason : inc.embeddingTime + 's'}`);
      console.log(`  ${repoPath}`);
      console.log(`  Incremental note: communities/processes are not recomputed (run with --force for full refresh).`);

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

  // ── Cache embeddings from existing index before rebuild ────────────
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: Array<{ nodeId: string; embedding: number[] }> = [];

  if (existingMeta && !options?.force) {
    try {
      bar.update(0, { phase: 'Caching embeddings...' });
      await initKuzu(kuzuPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeKuzu();
    } catch {
      try { await closeKuzu(); } catch {}
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ─────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const scaled = Math.round(progress.percent * 0.6);
    bar.update(scaled, { phase: phaseLabel });
  });

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
  const kuzuWarnings = kuzuResult.warnings;

  // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
  bar.update(85, { phase: 'Creating search indexes...' });

  const t0Fts = Date.now();
  try {
    await createFTSIndex('File', 'file_fts', ['name', 'content']);
    await createFTSIndex('Function', 'function_fts', ['name', 'content']);
    await createFTSIndex('Class', 'class_fts', ['name', 'content']);
    await createFTSIndex('Method', 'method_fts', ['name', 'content']);
    await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
    await createFTSIndex('CodeElement', 'codeelement_fts', ['name', 'content']);
    await createFTSIndex('Const', 'const_fts', ['name', 'content']);
  } catch (e: any) {
    // Non-fatal — FTS is best-effort
  }
  const ftsTime = ((Date.now() - t0Fts) / 1000).toFixed(1);

  // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
  if (cachedEmbeddings.length > 0) {
    bar.update(88, { phase: `Restoring ${cachedEmbeddings.length} cached embeddings...` });
    const EMBED_BATCH = 200;
    for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
      const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);
      const paramsList = batch.map(e => ({ nodeId: e.nodeId, embedding: e.embedding }));
      try {
        await executeWithReusedStatement(
          `CREATE (e:CodeEmbedding {nodeId: $nodeId, embedding: $embedding})`,
          paramsList,
        );
      } catch { /* some may fail if node was removed, that's fine */ }
    }
  }

  // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
  const stats = await getKuzuStats();
  let embeddingTime = '0.0';
  let embeddingSkipped = false;
  let embeddingSkipReason = '';

  if (options?.skipEmbeddings) {
    embeddingSkipped = true;
    embeddingSkipReason = 'skipped (--skip-embeddings)';
  } else if (stats.nodes > EMBEDDING_NODE_LIMIT) {
    embeddingSkipped = true;
    embeddingSkipReason = `skipped (${stats.nodes.toLocaleString()} nodes > ${EMBEDDING_NODE_LIMIT.toLocaleString()} limit)`;
  }

  if (!embeddingSkipped) {
    bar.update(90, { phase: 'Loading embedding model...' });
    const t0Emb = Date.now();
    await runEmbeddingPipeline(
      executeQuery,
      executeWithReusedStatement,
      (progress) => {
        const scaled = 90 + Math.round((progress.percent / 100) * 8);
        const label = progress.phase === 'loading-model' ? 'Loading embedding model...' : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
        bar.update(scaled, { phase: label });
      },
      {},
      cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
    );
    embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
  }

  // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
  bar.update(98, { phase: 'Saving metadata...' });

  const meta = {
    repoPath,
    lastCommit: currentCommit,
    indexedAt: new Date().toISOString(),
    kuzuSchemaVersion: KUZU_SCHEMA_VERSION,
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

  await closeKuzu();
  await disposeEmbedder();

  const totalTime = ((Date.now() - t0Global) / 1000).toFixed(1);

  bar.update(100, { phase: 'Done' });
  bar.stop();

  // ── Summary ───────────────────────────────────────────────────────
  const embeddingsCached = cachedEmbeddings.length > 0;
  console.log(`\n  Repository indexed successfully (${totalTime}s)${embeddingsCached ? ` [${cachedEmbeddings.length} embeddings cached]` : ''}\n`);
  console.log(`  ${stats.nodes.toLocaleString()} nodes | ${stats.edges.toLocaleString()} edges | ${pipelineResult.communityResult?.stats.totalCommunities || 0} clusters | ${pipelineResult.processResult?.stats.totalProcesses || 0} flows`);
  console.log(`  KuzuDB ${kuzuTime}s | FTS ${ftsTime}s | Embeddings ${embeddingSkipped ? embeddingSkipReason : embeddingTime + 's'}`);
  console.log(`  ${repoPath}`);

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
