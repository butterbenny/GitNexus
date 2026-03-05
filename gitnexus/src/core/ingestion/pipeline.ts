import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { processParsing } from './parsing-processor.js';
import { processImports, processImportsFromExtracted, createImportMap, createPhpUseAliasMap } from './import-processor.js';
import { processCalls, processCallsFromExtracted } from './call-processor.js';
import { processLaravelRoutes } from './laravel-route-processor.js';
import { processLaravelHttpWiring } from './laravel-http-processor.js';
import { processLaravelRouteNameWiring } from './laravel-route-name-processor.js';
import { processLaravelSemanticEdges } from './laravel-semantic-processor.js';
import { processLaravelAuthorization } from './laravel-auth-processor.js';
import { processLaravelRouteMiddlewareAuthorization } from './laravel-route-middleware-auth-processor.js';
import { processLaravelPermissionsConfig } from './laravel-permissions-config-processor.js';
import { processPhpMatchReturnEdges } from './php-match-return-processor.js';
import { processLaravelEloquentRelationships } from './laravel-eloquent-relationship-processor.js';
import { processLaravelEloquentLoadEdges } from './laravel-eloquent-load-processor.js';
import { processLaravelResourceContracts } from './laravel-resource-contract-processor.js';
import { processReactQueryKeyWiring } from './react-query-processor.js';
import { processContractShapes } from './contract-shape-processor.js';
import { processLaravelViewsAndMail } from './laravel-view-mail-processor.js';
import { processLaravelEvents } from './laravel-event-processor.js';
import { processLaravelEventDispatch } from './laravel-event-dispatch-processor.js';
import { processLaravelSchedule } from './laravel-schedule-processor.js';
import { processLaravelJobDispatch } from './laravel-job-dispatch-processor.js';
import { processLaravelTacticianDispatch } from './laravel-tactician-dispatch-processor.js';
import { processLaravelNotifications } from './laravel-notification-processor.js';
import { processBladeTemplates } from './blade-template-processor.js';
import { processBladeAuthorization } from './blade-auth-processor.js';
import { processMjmlIncludes } from './mjml-template-processor.js';
import { processPatternCatalogTemplates } from './pattern-catalog-processor.js';
import { processAgentDocs } from './agent-docs-processor.js';
import { processTemplateMethodCallWiring } from './template-method-call-processor.js';
import { processHeritage, processHeritageFromExtracted } from './heritage-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { processFeatureSlices } from './feature-slice-processor.js';
import { processGaps } from './gap-processor.js';
import { processGitHistoryCochange } from './git-history-cochange-processor.js';
import { processMicroDataflow } from './micro-dataflow-processor.js';
import { processPrecisionOverlay } from './precision-overlay-processor.js';
import { processProvenanceEdges } from './provenance-processor.js';
import { processValueGraph } from './value-graph-processor.js';
import { PrecisionOverlayMode } from './precision-overlay-producer.js';
import { createSymbolTable } from './symbol-table.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepository } from './filesystem-walker.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';

const isDev = process.env.NODE_ENV === 'development';

export interface PipelineRunOptions {
  precisionOverlayMode?: PrecisionOverlayMode;
  precisionOverlayPath?: string;
  precisionOverlayForce?: boolean;
  precisionOverlayScipJson?: string;
  graphExpectationPath?: string;
  graphExpectationJson?: string;
  skipCochange?: boolean;
}

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineRunOptions,
): Promise<PipelineResult> => {
  // Always collect coarse per-stage timings. This adds negligible overhead but
  // makes full-build performance bottlenecks actionable without extra flags.
  const profilePipelineTimings = true;
  const pipelineTimingsMs: Record<string, number> = {};
  const t0Pipeline = Date.now();
  const timeStage = async <T>(stage: string, run: () => Promise<T> | T): Promise<T> => {
    if (!profilePipelineTimings) return await run();
    const t0 = Date.now();
    try {
      return await run();
    } finally {
      pipelineTimingsMs[stage] = Math.max(0, Date.now() - t0);
    }
  };

  const graph = createKnowledgeGraph();
  const fileContents = new Map<string, string>();
  const symbolTable = createSymbolTable();
  // AST cache sized after file scan — start with a placeholder, resize after we know file count
  let astCache = createASTCache(50);
  const importMap = createImportMap();
  const phpUseAliases = createPhpUseAliasMap();

  const cleanup = () => {
    astCache.clear();
    symbolTable.clear();
  };

  try {
    onProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Scanning repository...',
    });

    const files = await timeStage('scan', async () => {
      const files = await walkRepository(repoPath, (current, total, filePath) => {
        const scanProgress = Math.round((current / total) * 15);
        onProgress({
          phase: 'extracting',
          percent: scanProgress,
          message: 'Scanning repository...',
          detail: filePath,
          stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
        });
      });

      files.forEach(f => fileContents.set(f.path, f.content));
      return files;
    });

    // Resize AST cache to fit all files — avoids re-parsing in import/call/heritage phases
    astCache = createASTCache(files.length);

    onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Repository scanned successfully',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    onProgress({
      phase: 'structure',
      percent: 15,
      message: 'Analyzing project structure...',
      stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    const filePaths = files.map(f => f.path);
    const allFilePathSet = new Set<string>(filePaths);
    await timeStage('structure', async () => {
      processStructure(graph, filePaths);

      processPatternCatalogTemplates(graph, files, allFilePathSet);
      processAgentDocs(graph, files, allFilePathSet);
      processBladeTemplates(graph, files);
      processMjmlIncludes(graph, files, allFilePathSet);
    });

    onProgress({
      phase: 'structure',
      percent: 30,
      message: 'Project structure analyzed',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    onProgress({
      phase: 'parsing',
      percent: 30,
      message: 'Parsing code definitions...',
      stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    // Create worker pool for parallel parsing, with graceful fallback
    let workerData: Awaited<ReturnType<typeof processParsing>> = null;
    await timeStage('parsing', async () => {
      let workerPool: WorkerPool | undefined;
      try {
        const workerUrl = new URL('./workers/parse-worker.js', import.meta.url);
        workerPool = createWorkerPool(workerUrl);
      } catch (err) {
        // Worker pool creation failed (e.g., single core) — sequential fallback
      }

      try {
        workerData = await processParsing(graph, files, symbolTable, astCache, (current, total, filePath) => {
          const parsingProgress = 30 + ((current / total) * 40);
          onProgress({
            phase: 'parsing',
            percent: Math.round(parsingProgress),
            message: 'Parsing code definitions...',
            detail: filePath,
            stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
          });
        }, workerPool);
      } finally {
        await workerPool?.terminate();
      }
    });

    onProgress({
      phase: 'imports',
      percent: 70,
      message: 'Resolving imports...',
      stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    await timeStage('imports', async () => {
      if (workerData) {
        // Fast path: imports already extracted by workers, just resolve paths
        await processImportsFromExtracted(graph, files, workerData.imports, importMap, phpUseAliases, (current, total) => {
          const importProgress = 70 + ((current / total) * 12);
          onProgress({
            phase: 'imports',
            percent: Math.round(importProgress),
            message: 'Resolving imports...',
            stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
          });
        }, repoPath);
      } else {
        // Fallback: full parse + resolve (sequential path)
        await processImports(graph, files, astCache, importMap, phpUseAliases, (current, total) => {
          const importProgress = 70 + ((current / total) * 12);
          onProgress({
            phase: 'imports',
            percent: Math.round(importProgress),
            message: 'Resolving imports...',
            stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
          });
        }, repoPath);
      }
    });

    if (isDev) {
      const importsCount = graph.relationships.filter(r => r.type === 'IMPORTS').length;
      console.log(`📊 Pipeline: After import phase, graph has ${importsCount} IMPORTS relationships (total: ${graph.relationshipCount})`);
    }

    onProgress({
      phase: 'calls',
      percent: 82,
      message: 'Tracing function calls...',
      stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    await timeStage('calls', async () => {
      if (workerData) {
        // Fast path: calls already extracted by workers, just resolve targets
        await processCallsFromExtracted(graph, workerData.calls, symbolTable, importMap, phpUseAliases, workerData.phpAssignments, workerData.phpTraitUses, (current, total) => {
          const callProgress = 82 + ((current / total) * 10);
          onProgress({
            phase: 'calls',
            percent: Math.round(callProgress),
            message: 'Tracing function calls...',
            stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
          });
        });
      } else {
        // Fallback: full parse + resolve (sequential path)
        await processCalls(graph, files, astCache, symbolTable, importMap, phpUseAliases, (current, total) => {
          const callProgress = 82 + ((current / total) * 10);
          onProgress({
            phase: 'calls',
            percent: Math.round(callProgress),
            message: 'Tracing function calls...',
            stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
          });
        });
      }
    });

    onProgress({
      phase: 'calls',
      percent: 92,
      message: 'Detecting Laravel framework wiring...',
      stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    await timeStage('framework', async () => {
      await timeStage('framework.views_mail', async () => {
        await processLaravelViewsAndMail(graph, files, astCache, symbolTable, importMap, phpUseAliases);
      });

      await timeStage('framework.events', async () => {
        await timeStage('framework.events.providers', async () => {
          await processLaravelEvents(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        });
        await timeStage('framework.events.dispatch', async () => {
          await processLaravelEventDispatch(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        });
        await timeStage('framework.events.schedule', async () => {
          await processLaravelSchedule(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        });
        await timeStage('framework.events.jobs', async () => {
          await processLaravelJobDispatch(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        });
        await timeStage('framework.events.tactician', async () => {
          await processLaravelTacticianDispatch(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        });
        await timeStage('framework.events.notifications', async () => {
          await processLaravelNotifications(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        });
      });

      await timeStage('framework.routes', async () => {
        processLaravelRoutes(graph, files, symbolTable, importMap, phpUseAliases);
        await processLaravelHttpWiring(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        await processLaravelRouteNameWiring(graph, files, astCache, symbolTable, importMap, phpUseAliases);
      });

      await timeStage('framework.template_methods', async () => {
        processTemplateMethodCallWiring(graph, files, symbolTable);
      });

      await timeStage('framework.semantic', async () => {
        await processLaravelSemanticEdges(graph, files, astCache, symbolTable, importMap, phpUseAliases);
      });

      await timeStage('framework.eloquent', async () => {
        await processLaravelEloquentRelationships(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        await processLaravelEloquentLoadEdges(graph, files, astCache, symbolTable, importMap, phpUseAliases);
      });

      await timeStage('framework.resource_contracts', async () => {
        await processLaravelResourceContracts(graph, files, astCache, symbolTable, importMap);
      });

      await timeStage('framework.permissions', async () => {
        await processLaravelPermissionsConfig(graph, files, astCache, symbolTable, importMap, phpUseAliases);
      });

      await timeStage('framework.auth', async () => {
        await timeStage('framework.auth.route_middleware', async () => {
          processLaravelRouteMiddlewareAuthorization(graph, files, symbolTable, importMap, phpUseAliases);
        });

        await timeStage('framework.auth.blade', async () => {
          processBladeAuthorization(graph, files, symbolTable);
        });

        await timeStage('framework.auth.match_return', async () => {
          await processPhpMatchReturnEdges(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        });

        await timeStage('framework.auth.laravel', async () => {
          await processLaravelAuthorization(graph, files, astCache, symbolTable, importMap, phpUseAliases);
        });
      });

      await timeStage('framework.react_query', async () => {
        await processReactQueryKeyWiring(graph, files, astCache, symbolTable, importMap);
      });
    });

    onProgress({
      phase: 'shapes',
      percent: 93,
      message: 'Materializing contract shapes...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    await timeStage('shapes', async () => {
      const shapeResult = await processContractShapes(
        graph,
        files,
        (message) => {
          onProgress({
            phase: 'shapes',
            percent: 93,
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
      );

      shapeResult.shapes.forEach(shape => {
        graph.addNode({
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
      });

      shapeResult.fields.forEach(field => {
        graph.addNode({
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
      });

      shapeResult.cacheKeys.forEach(cacheKey => {
        graph.addNode({
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
      });

      shapeResult.dbTables.forEach(dbTable => {
        graph.addNode({
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
      });

      shapeResult.dbColumns.forEach(dbColumn => {
        graph.addNode({
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
      });

      shapeResult.testCases.forEach(testCase => {
        graph.addNode({
          id: testCase.id,
          label: 'TestCase',
          properties: {
            name: testCase.name,
            filePath: testCase.filePath,
            startLine: testCase.startLine,
            endLine: testCase.endLine,
          },
        });
      });

      shapeResult.codeElements.forEach(node => {
        graph.addNode(node);
      });

      shapeResult.edges.forEach(edge => {
        graph.addRelationship({
          id: edge.id,
          type: edge.type,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          confidence: edge.confidence,
          reason: edge.reason,
        });
      });
    });

    onProgress({
      phase: 'heritage',
      percent: 94,
      message: 'Extracting class inheritance...',
      stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    await timeStage('heritage', async () => {
      if (workerData) {
        // Fast path: heritage already extracted by workers, just resolve symbols
        await processHeritageFromExtracted(graph, workerData.heritage, symbolTable, (current, total) => {
          const heritageProgress = 94 + ((current / total) * 2);
          onProgress({
            phase: 'heritage',
            percent: Math.round(heritageProgress),
            message: 'Extracting class inheritance...',
            stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
          });
        });
      } else {
        // Fallback: full parse + resolve (sequential path)
        await processHeritage(graph, files, astCache, symbolTable, (current, total) => {
          const heritageProgress = 94 + ((current / total) * 2);
          onProgress({
            phase: 'heritage',
            percent: Math.round(heritageProgress),
            message: 'Extracting class inheritance...',
            stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
          });
        });
      }
    });

    onProgress({
      phase: 'precision',
      percent: 95,
      message: 'Applying precision overlay...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    const precisionOverlayResult = await timeStage('precision', async () => {
      const result = await processPrecisionOverlay(
        repoPath,
        graph,
        (message, progress) => {
          const precisionProgress = 95 + (progress * 0.01);
          onProgress({
            phase: 'precision',
            percent: Math.round(precisionProgress),
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
        {
          overlayPath: options?.precisionOverlayPath,
          producerMode: options?.precisionOverlayMode,
          producerForceRefresh: options?.precisionOverlayForce,
          producerScipJson: options?.precisionOverlayScipJson,
        },
      );

      result.edges.forEach(edge => {
        graph.addRelationship(edge);
      });

      return result;
    });

    onProgress({
      phase: 'microflow',
      percent: 96,
      message: 'Materializing targeted micro-dataflow...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    const microDataflowResult = await timeStage('microflow', async () => {
      const result = await processMicroDataflow(
        graph,
        (message, progress) => {
          const microflowProgress = 96 + (progress * 0.01);
          onProgress({
            phase: 'microflow',
            percent: Math.round(microflowProgress),
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
      );

      result.edges.forEach(edge => {
        graph.addRelationship(edge);
      });

      return result;
    });

    onProgress({
      phase: 'values',
      percent: 97,
      message: 'Materializing value graph...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    const valueGraphResult = await timeStage('values', async () => {
      const result = await processValueGraph(
        graph,
        (message, progress) => {
          const valueProgress = 97 + (progress * 0.005);
          onProgress({
            phase: 'values',
            percent: Math.round(valueProgress),
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
      );

      result.values.forEach(valueNode => {
        graph.addNode({
          id: valueNode.id,
          label: 'ValueNode',
          properties: {
            name: valueNode.label,
            filePath: '',
            heuristicLabel: valueNode.heuristicLabel,
            valueType: valueNode.valueType,
            valueKey: valueNode.valueKey,
            valueRaw: valueNode.valueRaw,
          },
        });
      });

      result.edges.forEach(edge => {
        graph.addRelationship(edge);
      });

      return result;
    });

    onProgress({
      phase: 'provenance',
      percent: 97,
      message: 'Materializing provenance edges...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    const provenanceResult = await timeStage('provenance', async () => {
      const result = await processProvenanceEdges(
        graph,
        (message, progress) => {
          const provenanceProgress = 97 + (progress * 0.005);
          onProgress({
            phase: 'provenance',
            percent: Math.round(provenanceProgress),
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
      );

      result.edges.forEach(edge => {
        graph.addRelationship(edge);
      });

      return result;
    });

    onProgress({
      phase: 'communities',
      percent: 97,
      message: 'Detecting code communities...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    const communityResult = await timeStage('communities', async () => (
      await processCommunities(graph, (message, progress) => {
        const communityProgress = 97 + (progress * 0.01);
        onProgress({
          phase: 'communities',
          percent: Math.round(communityProgress),
          message,
          stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
        });
      })
    ));

    if (isDev) {
      console.log(`🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`);
    }

    communityResult.communities.forEach(comm => {
      graph.addNode({
        id: comm.id,
        label: 'Community' as const,
        properties: {
          name: comm.label,
          filePath: '',
          heuristicLabel: comm.heuristicLabel,
          cohesion: comm.cohesion,
          symbolCount: comm.symbolCount,
        }
      });
    });

    communityResult.memberships.forEach(membership => {
      graph.addRelationship({
        id: `${membership.nodeId}_member_of_${membership.communityId}`,
        type: 'MEMBER_OF',
        sourceId: membership.nodeId,
        targetId: membership.communityId,
        confidence: 1.0,
        reason: 'leiden-algorithm',
      });
    });

    onProgress({
      phase: 'processes',
      percent: 98,
      message: 'Detecting execution flows...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    // Dynamic process cap based on codebase size
    const symbolCount = graph.nodes.filter(n => n.label !== 'File').length;
    const dynamicMaxProcesses = Math.max(20, Math.min(300, Math.round(symbolCount / 10)));

    const processResult = await timeStage('processes', async () => (
      await processProcesses(
        graph,
        communityResult.memberships,
        (message, progress) => {
          const processProgress = 98 + (progress * 0.01);
          onProgress({
            phase: 'processes',
            percent: Math.round(processProgress),
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
        { maxProcesses: dynamicMaxProcesses, minSteps: 3 }
      )
    ));

    if (isDev) {
      console.log(`🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`);
    }

    processResult.processes.forEach(proc => {
      graph.addNode({
        id: proc.id,
        label: 'Process' as const,
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
    });

    processResult.steps.forEach(step => {
      graph.addRelationship({
        id: `${step.nodeId}_step_${step.step}_${step.processId}`,
        type: 'STEP_IN_PROCESS',
        sourceId: step.nodeId,
        targetId: step.processId,
        confidence: 1.0,
        reason: 'trace-detection',
        step: step.step,
      });
    });

    onProgress({
      phase: 'slices',
      percent: 99,
      message: 'Materializing feature slices...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    const featureSliceResult = await timeStage('slices', async () => (
      await processFeatureSlices(
        graph,
        (message) => {
          onProgress({
            phase: 'slices',
            percent: 99,
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
      )
    ));

    featureSliceResult.slices.forEach(slice => {
      graph.addNode({
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
    });

    featureSliceResult.memberships.forEach(membership => {
      graph.addRelationship({
        id: `${membership.nodeId}_member_of_${membership.sliceId}`,
        type: 'MEMBER_OF',
        sourceId: membership.nodeId,
        targetId: membership.sliceId,
        confidence: 1.0,
        reason: `feature-slice:${membership.role}`,
      });
    });

    onProgress({
      phase: 'gaps',
      percent: 99,
      message: 'Materializing gap graph...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    const gapResult = await timeStage('gaps', async () => (
      await processGaps(
        graph,
        (message) => {
          onProgress({
            phase: 'gaps',
            percent: 99,
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
        {
          repoPath,
          expectationPath: options?.graphExpectationPath,
          expectationJson: options?.graphExpectationJson,
        },
      )
    ));

    gapResult.gaps.forEach(gap => {
      graph.addNode({
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
    });

    gapResult.links.forEach(link => {
      graph.addRelationship({
        id: `${link.gapId}_member_of_${link.sliceId}`,
        type: 'MEMBER_OF',
        sourceId: link.gapId,
        targetId: link.sliceId,
        confidence: 1.0,
        reason: 'gap-membership',
      });
    });

    onProgress({
      phase: 'cochange',
      percent: 99,
      message: 'Materializing git-history cochange graph...',
      stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
    });

    await timeStage('cochange', async () => {
      if (options?.skipCochange) {
        onProgress({
          phase: 'cochange',
          percent: 99,
          message: 'Skipping git-history cochange graph (profile)...',
          stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
        });
        return;
      }

      const cochangeResult = await processGitHistoryCochange(
        repoPath,
        filePaths,
        (message) => {
          onProgress({
            phase: 'cochange',
            percent: 99,
            message,
            stats: { filesProcessed: files.length, totalFiles: files.length, nodesCreated: graph.nodeCount },
          });
        },
      );

      cochangeResult.edges.forEach(edge => {
        graph.addRelationship(edge);
      });
    });

    onProgress({
      phase: 'complete',
      percent: 100,
      message: `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`,
      stats: {
        filesProcessed: files.length,
        totalFiles: files.length,
        nodesCreated: graph.nodeCount
      },
    });

    astCache.clear();

    return {
      graph,
      fileContents,
      timingsMs: profilePipelineTimings
        ? { ...pipelineTimingsMs, total: Math.max(0, Date.now() - t0Pipeline) }
        : undefined,
      communityResult,
      processResult,
      precisionOverlayResult,
      microDataflowResult,
      valueGraphResult,
      provenanceResult,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
};
