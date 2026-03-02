/**
 * HTTP API Server
 * 
 * REST API for browser-based clients to query the local .gitnexus/ index.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { findRepo } from '../storage/repo-manager.js';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { initKuzu, executeQuery } from '../core/kuzu/kuzu-adapter.js';
import { NODE_TABLES } from '../core/kuzu/schema.js';
import { GraphNode, GraphRelationship } from '../core/graph/types.js';
import { enrichRelationshipMetadata, parseWitnessPathIds } from '../core/graph/edge-metadata.js';
import { searchFTSFromKuzu } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
import { semanticSearch } from '../core/embeddings/embedding-pipeline.js';
import { isEmbedderReady } from '../core/embeddings/embedder.js';
import { loadEvidenceSpanSnapshot } from '../core/ingestion/evidence-span-store.js';
import { loadClosureTemplateSnapshot } from '../core/ingestion/closure-template-store.js';
import { loadStructuredSummarySnapshot } from '../core/ingestion/summary-overlay-store.js';
import { GITNEXUS_TOOLS } from '../mcp/tools.js';

export const HTTP_API_TOOL_NAMES = Array.from(
  new Set(GITNEXUS_TOOLS.map(tool => tool.name)),
);
const HTTP_API_TOOL_NAME_SET = new Set(HTTP_API_TOOL_NAMES);
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i;
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 200;
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

export function isReadOnlyCypherQuery(query: string): boolean {
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

export const resolveRepoFilePath = (
  repoPath: string,
  rawPath: string,
): { relativePath: string; absolutePath: string } | null => {
  const normalizedInput = String(rawPath || '').trim().replace(/\\/g, '/');
  if (!normalizedInput) return null;

  const absoluteCandidate = path.isAbsolute(normalizedInput)
    ? normalizedInput
    : path.join(repoPath, normalizedInput);
  const relativePath = path.relative(repoPath, absoluteCandidate).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..')) return null;

  return {
    relativePath,
    absolutePath: path.join(repoPath, relativePath),
  };
};

export function isAllowedCorsOrigin(origin: string | undefined): boolean {
  const normalized = String(origin || '').trim();
  // Allow CLI/curl/same-origin requests that do not send Origin.
  if (!normalized) return true;
  return LOOPBACK_ORIGIN_RE.test(normalized);
}

export function normalizeSearchLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return SEARCH_LIMIT_DEFAULT;
  const normalized = Math.trunc(parsed);
  if (normalized < SEARCH_LIMIT_MIN) return SEARCH_LIMIT_MIN;
  if (normalized > SEARCH_LIMIT_MAX) return SEARCH_LIMIT_MAX;
  return normalized;
}

export async function callHttpApiTool(
  backend: LocalBackend,
  toolName: string,
  args: unknown,
  defaultRepoPath?: string,
): Promise<any> {
  const name = String(toolName || '').trim();
  if (!name) {
    throw new Error('Missing tool name');
  }
  if (!HTTP_API_TOOL_NAME_SET.has(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const payload = (args && typeof args === 'object' && !Array.isArray(args))
    ? { ...(args as Record<string, any>) }
    : {};
  if (!payload.repo && defaultRepoPath) {
    payload.repo = defaultRepoPath;
  }

  return backend.callTool(name, payload);
}

const buildGraph = async (): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      let query = '';
      if (table === 'File') {
        query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
      } else if (table === 'FeatureSlice') {
        query = `MATCH (n:FeatureSlice) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.sliceType AS sliceType, n.anchorId AS anchorId, n.anchorName AS anchorName, n.closureSlots AS closureSlots, n.closedSlots AS closedSlots, n.closureScore AS closureScore`;
      } else if (table === 'Gap') {
        query = `MATCH (n:Gap) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.gapType AS gapType, n.absenceTier AS absenceTier, n.severity AS severity, n.sliceId AS sliceId, n.anchorId AS anchorId, n.missingSlots AS missingSlots, n.evidence AS evidence`;
      } else if (table === 'ContractShape') {
        query = `MATCH (n:ContractShape) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.shapeType AS shapeType, n.sourceNodeId AS sourceNodeId, n.sourceFilePath AS sourceFilePath`;
      } else if (table === 'ContractField') {
        query = `MATCH (n:ContractField) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.fieldName AS fieldName, n.shapeId AS shapeId, n.shapeType AS shapeType`;
      } else if (table === 'CacheKey') {
        query = `MATCH (n:CacheKey) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.keyName AS keyName, n.keyType AS keyType, n.sourceNodeId AS sourceNodeId`;
      } else if (table === 'DBTable') {
        query = `MATCH (n:DBTable) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.tableName AS tableName, n.sourceFilePath AS sourceFilePath`;
      } else if (table === 'DBColumn') {
        query = `MATCH (n:DBColumn) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.columnName AS columnName, n.tableId AS tableId, n.tableName AS tableName, n.sourceFilePath AS sourceFilePath`;
      } else if (table === 'ValueNode') {
        query = `MATCH (n:ValueNode) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.valueType AS valueType, n.valueKey AS valueKey, n.valueRaw AS valueRaw`;
      } else {
        query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        nodes.push({
          id: row.id ?? row[0],
          label: table as GraphNode['label'],
          properties: {
            name: row.name ?? row.label ?? row[1],
            filePath: row.filePath ?? row[2],
            startLine: row.startLine,
            endLine: row.endLine,
            content: row.content,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
            processType: row.processType,
            stepCount: row.stepCount,
            communities: row.communities,
            entryPointId: row.entryPointId,
            terminalId: row.terminalId,
            sliceType: row.sliceType,
            anchorId: row.anchorId,
            anchorName: row.anchorName,
            closureSlots: row.closureSlots,
            closedSlots: row.closedSlots,
            closureScore: row.closureScore,
            gapType: row.gapType,
            absenceTier: row.absenceTier,
            severity: row.severity,
            sliceId: row.sliceId,
            missingSlots: row.missingSlots,
            evidence: row.evidence,
            shapeType: row.shapeType,
            sourceNodeId: row.sourceNodeId,
            sourceFilePath: row.sourceFilePath,
            fieldName: row.fieldName,
            shapeId: row.shapeId,
            keyName: row.keyName,
            keyType: row.keyType,
            tableName: row.tableName,
            columnName: row.columnName,
            tableId: row.tableId,
            valueType: row.valueType,
            valueKey: row.valueKey,
            valueRaw: row.valueRaw,
          } as GraphNode['properties'],
        });
      }
    } catch {
      // ignore empty tables
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step, r.certaintyTier AS certaintyTier, r.provenanceFamily AS provenanceFamily, r.absenceSemantics AS absenceSemantics, r.witnessPathIds AS witnessPathIds`
  );
  for (const row of relRows) {
    relationships.push(enrichRelationshipMetadata({
      id: `${row.sourceId}_${row.type}_${row.targetId}`,
      type: row.type,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
      certaintyTier: row.certaintyTier,
      provenanceFamily: row.provenanceFamily,
      absenceSemantics: row.absenceSemantics,
      witnessPathIds: parseWitnessPathIds(row.witnessPathIds),
    }));
  }

  return { nodes, relationships };
};

export const createServer = async (port: number) => {
  const app = express();
  app.use(cors({
    origin: (origin, callback) => {
      if (isAllowedCorsOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS origin not allowed'));
    },
  }));
  app.use(express.json({ limit: '10mb' }));
  const backend = new LocalBackend();
  await backend.init();

  app.get('/api/tools', async (_req, res) => {
    res.json({ tools: HTTP_API_TOOL_NAMES });
  });

  app.post('/api/tool/:name', async (req, res) => {
    const toolName = String(req.params.name || '').trim();
    if (!toolName) {
      res.status(400).json({ error: 'Missing tool name' });
      return;
    }
    try {
      const cwdRepo = await findRepo(process.cwd());
      const result = await callHttpApiTool(backend, toolName, req.body, cwdRepo?.repoPath);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: String(err?.message || err || 'Invalid tool request') });
    }
  });

  // Get repo info
  app.get('/api/repo', async (_req, res) => {
    const repo = await findRepo(process.cwd());
    if (!repo) {
      res.status(404).json({ error: 'Repository not indexed. Run: gitnexus analyze' });
      return;
    }
    res.json({
      repoPath: repo.repoPath,
      indexedAt: repo.meta.indexedAt,
      stats: repo.meta.stats || {},
    });
  });

  // Get full graph
  app.get('/api/graph', async (_req, res) => {
    const repo = await findRepo(process.cwd());
    if (!repo) {
      res.status(404).json({ error: 'Repository not indexed' });
      return;
    }
    await initKuzu(repo.kuzuPath);
    const graph = await buildGraph();
    res.json(graph);
  });

  // Execute Cypher query
  app.post('/api/query', async (req, res) => {
    const repo = await findRepo(process.cwd());
    if (!repo) {
      res.status(404).json({ error: 'Repository not indexed' });
      return;
    }
    await initKuzu(repo.kuzuPath);

    const query = String(req.body?.cypher || '').trim();
    if (!query) {
      res.status(400).json({ error: 'Missing cypher query' });
      return;
    }
    if (!isReadOnlyCypherQuery(query)) {
      res.status(400).json({ error: 'Cypher write operations are disabled for safety. Use read-only queries.' });
      return;
    }

    try {
      const result = await executeQuery(query);
      res.json({ result });
    } catch (error: any) {
      res.status(400).json({ error: String(error?.message || error || 'Query failed') });
    }
  });

  // Read evidence span sidecar
  app.get('/api/evidence', async (_req, res) => {
    const repo = await findRepo(process.cwd());
    if (!repo) {
      res.status(404).json({ error: 'Repository not indexed' });
      return;
    }

    const evidence = await loadEvidenceSpanSnapshot(repo.storagePath);
    res.json(evidence);
  });

  app.get('/api/summaries', async (_req, res) => {
    const repo = await findRepo(process.cwd());
    if (!repo) {
      res.status(404).json({ error: 'Repository not indexed' });
      return;
    }

    const summaries = await loadStructuredSummarySnapshot(repo.storagePath);
    res.json(summaries);
  });

  app.get('/api/closure-templates', async (_req, res) => {
    const repo = await findRepo(process.cwd());
    if (!repo) {
      res.status(404).json({ error: 'Repository not indexed' });
      return;
    }

    const templates = await loadClosureTemplateSnapshot(repo.storagePath);
    res.json(templates);
  });

  // Search
  app.post('/api/search', async (req, res) => {
    const repo = await findRepo(process.cwd());
    if (!repo) {
      res.status(404).json({ error: 'Repository not indexed' });
      return;
    }
    await initKuzu(repo.kuzuPath);

    const query = String(req.body?.query ?? '');
    const limit = normalizeSearchLimit(req.body?.limit);

    if (isEmbedderReady()) {
      const results = await hybridSearch(query, limit, executeQuery, semanticSearch);
      res.json({ results });
      return;
    }

    // FTS-only fallback when embeddings aren't loaded
    const results = await searchFTSFromKuzu(query, limit);
    res.json({ results });
  });

  // Read file
  app.get('/api/file', async (req, res) => {
    const repo = await findRepo(process.cwd());
    if (!repo) {
      res.status(404).json({ error: 'Repository not indexed' });
      return;
    }
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'Missing path' });
      return;
    }

    const resolved = resolveRepoFilePath(repo.repoPath, filePath);
    if (!resolved) {
      res.status(400).json({ error: 'path must resolve inside the indexed repository root' });
      return;
    }

    try {
      const content = await fs.readFile(resolved.absolutePath, 'utf-8');
      res.json({ content, filePath: resolved.relativePath });
    } catch (error: any) {
      res.status(404).json({ error: String(error?.message || error || 'Unable to read file') });
    }
  });

  const server = app.listen(port, () => {
    console.log(`GitNexus server running on http://localhost:${port}`);
    console.log('  GET  /api/tools');
    console.log('  POST /api/tool/:name');
  });

  server.on('close', () => {
    void backend.disconnect();
  });

  return server;
};
