/**
 * Embedding Pipeline Module
 * 
 * Orchestrates the background embedding process:
 * 1. Query embeddable nodes from KuzuDB
 * 2. Generate text representations
 * 3. Batch embed using transformers.js
 * 4. Update KuzuDB with embeddings
 * 5. Create vector index for semantic search
 */

import { initEmbedder, embedBatchToArrays, embedText, embeddingToArray, isEmbedderReady } from './embedder.js';
import { generateBatchEmbeddingTexts } from './text-generator.js';
import { computeEmbeddingTextHash, decodeEmbeddingBase64, encodeEmbeddingBase64, loadEmbeddingCache, saveEmbeddingCache } from './embedding-cache.js';
import {
  type EmbeddingProgress,
  type EmbeddingConfig,
  type EmbeddableNode,
  type SemanticSearchResult,
  type ModelProgress,
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDABLE_LABELS,
} from './types.js';

const isDev = process.env.NODE_ENV === 'development';

/**
 * Progress callback type
 */
export type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void;

/**
 * Query all embeddable nodes from KuzuDB
 * Uses table-specific queries (File has different schema than code elements)
 */
const queryEmbeddableNodes = async (
  executeQuery: (cypher: string) => Promise<any[]>
): Promise<EmbeddableNode[]> => {
  const allNodes: EmbeddableNode[] = [];
  
  // Query each embeddable table with table-specific columns
  for (const label of EMBEDDABLE_LABELS) {
    try {
      let query: string;
      
      if (label === 'File') {
        // File nodes don't have startLine/endLine
        query = `
          MATCH (n:File)
          OPTIONAL MATCH (e:CodeEmbedding {nodeId: n.id})
          WITH n, e
          WHERE e IS NULL
          RETURN n.id AS id, n.name AS name, 'File' AS label, 
                 n.filePath AS filePath, n.content AS content
        `;
      } else {
        // Code elements have startLine/endLine
        query = `
          MATCH (n:${label})
          OPTIONAL MATCH (e:CodeEmbedding {nodeId: n.id})
          WITH n, e
          WHERE e IS NULL
          RETURN n.id AS id, n.name AS name, '${label}' AS label, 
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine
        `;
      }
      
      const rows = await executeQuery(query);
      for (const row of rows) {
        allNodes.push({
          id: row.id ?? row[0],
          name: row.name ?? row[1],
          label: row.label ?? row[2],
          filePath: row.filePath ?? row[3],
          content: row.content ?? row[4] ?? '',
          startLine: row.startLine ?? row[5],
          endLine: row.endLine ?? row[6],
        });
      }
    } catch (error) {
      // Best-effort fallback: if the embedding table isn't available yet,
      // embed everything rather than silently returning zero nodes.
      try {
        let fallbackQuery: string;

        if (label === 'File') {
          fallbackQuery = `
            MATCH (n:File)
            RETURN n.id AS id, n.name AS name, 'File' AS label, 
                   n.filePath AS filePath, n.content AS content
          `;
        } else {
          fallbackQuery = `
            MATCH (n:${label})
            RETURN n.id AS id, n.name AS name, '${label}' AS label, 
                   n.filePath AS filePath, n.content AS content,
                   n.startLine AS startLine, n.endLine AS endLine
          `;
        }

        const rows = await executeQuery(fallbackQuery);
        for (const row of rows) {
          allNodes.push({
            id: row.id ?? row[0],
            name: row.name ?? row[1],
            label: row.label ?? row[2],
            filePath: row.filePath ?? row[3],
            content: row.content ?? row[4] ?? '',
            startLine: row.startLine ?? row[5],
            endLine: row.endLine ?? row[6],
          });
        }
      } catch {
        // Table might not exist or be empty, continue
      }

      if (isDev) {
        console.warn(`Query for ${label} nodes failed:`, error);
      }
    }
  }

  return allNodes;
};

/**
 * Batch INSERT embeddings into separate CodeEmbedding table
 * Using a separate lightweight table avoids copy-on-write overhead
 * that occurs when UPDATEing nodes with large content fields
 */
const batchInsertEmbeddings = async (
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>
  ) => Promise<void>,
  updates: Array<{ id: string; embedding: number[] }>
): Promise<void> => {
  if (updates.length === 0) return;

  // Insert embeddings in batches with a single query per chunk (UNWIND).
  // This avoids 1 execute() call per row and is significantly faster on large repos.
  const cypher = `UNWIND $rows AS row CREATE (e:CodeEmbedding {nodeId: row.nodeId, embedding: row.embedding})`;
  const rowsPerQuery = 200;
  const paramsList: Array<Record<string, any>> = [];
  for (let start = 0; start < updates.length; start += rowsPerQuery) {
    const rows = updates.slice(start, start + rowsPerQuery).map(u => ({ nodeId: u.id, embedding: u.embedding }));
    paramsList.push({ rows });
  }
  await executeWithReusedStatement(cypher, paramsList);
};

/**
 * Create the vector index for semantic search
 * Now indexes the separate CodeEmbedding table
 */
const createVectorIndex = async (
  executeQuery: (cypher: string) => Promise<any[]>
): Promise<void> => {
  const cypher = `
    CALL CREATE_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 'embedding', metric := 'cosine')
  `;

  try {
    await executeQuery(cypher);
  } catch (error) {
    // Index might already exist
    if (isDev) {
      console.warn('Vector index creation warning:', error);
    }
  }
};

/**
 * Run the embedding pipeline
 * 
 * @param executeQuery - Function to execute Cypher queries against KuzuDB
 * @param executeWithReusedStatement - Function to execute with reused prepared statement
 * @param onProgress - Callback for progress updates
 * @param config - Optional configuration override
 * @param options - Optional pipeline options
 */
export const runEmbeddingPipeline = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  executeWithReusedStatement: (cypher: string, paramsList: Array<Record<string, any>>) => Promise<void>,
  onProgress: EmbeddingProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  options?: { cachePath?: string },
): Promise<void> => {
  const finalConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
  const cacheMeta = { modelId: finalConfig.modelId, dimensions: finalConfig.dimensions };
  const cachePath = String(options?.cachePath || '').trim();
  const cacheEnabledRequested = Boolean(cachePath);
  const expectedEmbeddingBase64Length = Math.ceil((Math.max(0, finalConfig.dimensions) * 4) / 3) * 4;
  let cacheEnabledForRun = cacheEnabledRequested;
  let embeddingCache = new Map<string, string>();
  let embeddingCacheVersion = 0;
  let cacheWrites = 0;

  try {
    if (isDev) {
      console.log('🔍 Querying embeddable nodes...');
    }

    // Phase 1: Query embeddable nodes (avoid loading model/cache if there's nothing to embed)
    let nodes = await queryEmbeddableNodes(executeQuery);

    const totalNodes = nodes.length;

    if (isDev) {
      console.log(`📊 Found ${totalNodes} embeddable nodes`);
    }

    if (totalNodes === 0) {
      onProgress({
        phase: 'ready',
        percent: 100,
        nodesProcessed: 0,
        totalNodes: 0,
      });
      return;
    }

    // Only load the embedding cache when we're doing a cold embedding build (no embeddings exist yet).
    // Incremental runs almost always miss the cache (content hashes changed) and paying to parse a large cache
    // file can dominate runtime on big repos.
    if (cacheEnabledRequested) {
      let hasAnyEmbeddings = false;
      try {
        const rows = await executeQuery(`MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId LIMIT 1`);
        hasAnyEmbeddings = Array.isArray(rows) && rows.length > 0;
      } catch {
        hasAnyEmbeddings = false;
      }

      if (hasAnyEmbeddings) {
        cacheEnabledForRun = false;
      } else {
        const loaded = await loadEmbeddingCache(cachePath, cacheMeta);
        embeddingCache = loaded.byHash;
        embeddingCacheVersion = loaded.loadedVersion;
      }
    }

    // Phase 2: Load embedding model only when needed.
    // Note: we intentionally avoid a full pre-scan "needsEmbeddingModel" pass here because it would
    // generate embedding texts twice (once for the scan, once per batch). We instead lazy-load the
    // model on the first cache miss encountered during batching.
    let embedderReady = false;
    const ensureEmbedderReady = async (percent: number): Promise<void> => {
      if (embedderReady) return;
      onProgress({
        phase: 'loading-model',
        percent,
        modelDownloadPercent: 0,
      });

      await initEmbedder((modelProgress: ModelProgress) => {
        const downloadPercent = modelProgress.progress ?? 0;
        onProgress({
          phase: 'loading-model',
          percent,
          modelDownloadPercent: downloadPercent,
        });
      }, finalConfig);

      onProgress({
        phase: 'loading-model',
        percent,
        modelDownloadPercent: 100,
      });
      embedderReady = true;
    };

    // Phase 3: Batch embed nodes
    // Default batch sizes can be too aggressive for some CPU/WASM environments.
    // We treat OOM-like failures as a signal to reduce batch size and retry.
    const totalBatchesForSize = (size: number): number =>
      Math.ceil(totalNodes / Math.max(1, Math.floor(size)));

    let batchSize = Math.max(1, Math.floor(finalConfig.batchSize));
    let totalBatches = totalBatchesForSize(batchSize);
    let processedNodes = 0;
    let currentBatch = 0;

    onProgress({
      phase: 'embedding',
      percent: 20,
      nodesProcessed: 0,
      totalNodes,
      currentBatch: 0,
      totalBatches,
    });

    for (let start = 0; start < totalNodes;) {
      const end = Math.min(start + batchSize, totalNodes);
      const batch = nodes.slice(start, end);

      // Generate texts for this batch
      const texts = generateBatchEmbeddingTexts(batch, finalConfig);

      const cachedUpdates: Array<{ id: string; embedding: number[] }> = [];
      const missNodes: EmbeddableNode[] = [];
      const missTexts: string[] = [];
      const missHashes: string[] = [];

      if (cacheEnabledForRun && embeddingCache.size > 0) {
        for (let i = 0; i < batch.length; i += 1) {
          const node = batch[i];
          const text = texts[i] || '';
          const hash = computeEmbeddingTextHash(text, cacheMeta);
          const base64 = String(embeddingCache.get(hash) || '');

          if (!base64 || base64.length !== expectedEmbeddingBase64Length) {
            missNodes.push(node);
            missTexts.push(text);
            missHashes.push(hash);
            continue;
          }

          const embedding = decodeEmbeddingBase64(base64, finalConfig.dimensions);
          if (!embedding) {
            missNodes.push(node);
            missTexts.push(text);
            missHashes.push(hash);
            continue;
          }

          cachedUpdates.push({ id: node.id, embedding });
        }
      } else {
        // No cache: embed all nodes in this batch.
        missNodes.push(...batch);
        missTexts.push(...texts);
        if (cacheEnabledForRun) {
          missHashes.push(...texts.map(text => computeEmbeddingTextHash(text, cacheMeta)));
        }
      }

      let embeddedUpdates: Array<{ id: string; embedding: number[] }> = [];
      if (missTexts.length > 0) {
        if (!embedderReady) {
          const loadingPercent = Math.round(20 + ((processedNodes / totalNodes) * 70));
          await ensureEmbedderReady(loadingPercent);
        }

        let embeddings: number[][];
        try {
          embeddings = await embedBatchToArrays(missTexts);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || '');
          const looksLikeOom = /out of memory|oom|allocation|memory/i.test(message);
          if (looksLikeOom && batchSize > 1) {
            batchSize = Math.max(1, Math.floor(batchSize / 2));
            totalBatches = totalBatchesForSize(batchSize);
            onProgress({
              phase: 'embedding',
              percent: Math.round(20 + ((processedNodes / totalNodes) * 70)),
              nodesProcessed: processedNodes,
              totalNodes,
              currentBatch,
              totalBatches,
            });
            continue;
          }
          throw error;
        }

        embeddedUpdates = missNodes.map((node, i) => ({
          id: node.id,
          embedding: embeddings[i],
        }));

        if (cacheEnabledForRun) {
          for (let i = 0; i < embeddedUpdates.length; i += 1) {
            const update = embeddedUpdates[i];
            const hash = missHashes[i] || computeEmbeddingTextHash(missTexts[i] || '', cacheMeta);
            const embeddingBase64 = encodeEmbeddingBase64(update.embedding);
            if (embeddingBase64.length !== expectedEmbeddingBase64Length) continue;
            const isNew = !embeddingCache.has(hash);
            embeddingCache.set(hash, embeddingBase64);
            if (isNew) cacheWrites += 1;
          }
        }
      }

      // Update KuzuDB with embeddings
      const updates = [...cachedUpdates, ...embeddedUpdates];
      await batchInsertEmbeddings(executeWithReusedStatement, updates);

      processedNodes += batch.length;
      currentBatch += 1;
      start = end;

      // Report progress (20-90% for embedding phase)
      const embeddingProgress = 20 + ((processedNodes / totalNodes) * 70);
      onProgress({
        phase: 'embedding',
        percent: Math.round(embeddingProgress),
        nodesProcessed: processedNodes,
        totalNodes,
        currentBatch,
        totalBatches,
      });
    }

    // Phase 4: Create vector index
    onProgress({
      phase: 'indexing',
      percent: 90,
      nodesProcessed: totalNodes,
      totalNodes,
    });

    if (isDev) {
      console.log('📇 Creating vector index...');
    }

    await createVectorIndex(executeQuery);

    if (cacheEnabledForRun && embeddingCache.size > 0 && (cacheWrites > 0 || embeddingCacheVersion === 1)) {
      try {
        await saveEmbeddingCache(cachePath, cacheMeta, embeddingCache);
      } catch (error) {
        // Best effort: cache writes are optional and should not fail the embedding pipeline.
        if (isDev) {
          console.warn('Embedding cache save warning:', error);
        }
      }
    }

    // Complete
    onProgress({
      phase: 'ready',
      percent: 100,
      nodesProcessed: totalNodes,
      totalNodes,
    });

    if (isDev) {
      console.log('✅ Embedding pipeline complete!');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    if (isDev) {
      console.error('❌ Embedding pipeline error:', error);
    }

    onProgress({
      phase: 'error',
      percent: 0,
      error: errorMessage,
    });

    throw error;
  }
};

/**
 * Perform semantic search using the vector index
 * 
 * Uses CodeEmbedding table and queries each node table to get metadata
 * 
 * @param executeQuery - Function to execute Cypher queries
 * @param query - Search query text
 * @param k - Number of results to return (default: 10)
 * @param maxDistance - Maximum distance threshold (default: 0.5)
 * @returns Array of search results ordered by relevance
 */
export const semanticSearch = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 10,
  maxDistance: number = 0.5
): Promise<SemanticSearchResult[]> => {
  if (!isEmbedderReady()) {
    throw new Error('Embedding model not initialized. Run embedding pipeline first.');
  }

  // Embed the query
  const queryEmbedding = await embedText(query);
  const queryVec = embeddingToArray(queryEmbedding);
  const queryVecStr = `[${queryVec.join(',')}]`;

  // Query the vector index on CodeEmbedding to get nodeIds and distances
  const vectorQuery = `
    CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 
      CAST(${queryVecStr} AS FLOAT[384]), ${k})
    YIELD node AS emb, distance
    WITH emb, distance
    WHERE distance < ${maxDistance}
    RETURN emb.nodeId AS nodeId, distance
    ORDER BY distance
  `;

  const embResults = await executeQuery(vectorQuery);
  
  if (embResults.length === 0) {
    return [];
  }

  // Get metadata for each result by querying each node table
  const results: SemanticSearchResult[] = [];
  
  for (const embRow of embResults) {
    const nodeId = embRow.nodeId ?? embRow[0];
    const distance = embRow.distance ?? embRow[1];
    
    // Extract label from node ID (format: Label:path:name)
    const labelEndIdx = nodeId.indexOf(':');
    const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
    
    // Query the specific table for this node
    // File nodes don't have startLine/endLine
    try {
      let nodeQuery: string;
      if (label === 'File') {
        nodeQuery = `
          MATCH (n:File {id: '${nodeId.replace(/'/g, "''")}'}) 
          RETURN n.name AS name, n.filePath AS filePath
        `;
      } else {
        nodeQuery = `
          MATCH (n:${label} {id: '${nodeId.replace(/'/g, "''")}'}) 
          RETURN n.name AS name, n.filePath AS filePath, 
                 n.startLine AS startLine, n.endLine AS endLine
        `;
      }
      const nodeRows = await executeQuery(nodeQuery);
      if (nodeRows.length > 0) {
        const nodeRow = nodeRows[0];
        results.push({
          nodeId,
          name: nodeRow.name ?? nodeRow[0] ?? '',
          label,
          filePath: nodeRow.filePath ?? nodeRow[1] ?? '',
          distance,
          startLine: label !== 'File' ? (nodeRow.startLine ?? nodeRow[2]) : undefined,
          endLine: label !== 'File' ? (nodeRow.endLine ?? nodeRow[3]) : undefined,
        });
      }
    } catch {
      // Table might not exist, skip
    }
  }

  return results;
};

/**
 * Semantic search with graph expansion (flattened results)
 * 
 * Note: With multi-table schema, graph traversal is simplified.
 * Returns semantic matches with their metadata.
 * For full graph traversal, use execute_vector_cypher tool directly.
 * 
 * @param executeQuery - Function to execute Cypher queries
 * @param query - Search query text
 * @param k - Number of initial semantic matches (default: 5)
 * @param _hops - Unused (kept for API compatibility).
 * @returns Semantic matches with metadata
 */
export const semanticSearchWithContext = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 5,
  _hops: number = 1
): Promise<any[]> => {
  // For multi-table schema, just return semantic search results
  // Graph traversal is complex with separate tables - use execute_vector_cypher instead
  const results = await semanticSearch(executeQuery, query, k, 0.5);
  
  return results.map(r => ({
    matchId: r.nodeId,
    matchName: r.name,
    matchLabel: r.label,
    matchPath: r.filePath,
    distance: r.distance,
    connectedId: null,
    connectedName: null,
    connectedLabel: null,
    relationType: null,
  }));
};
