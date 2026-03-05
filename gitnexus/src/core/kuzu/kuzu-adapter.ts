import fs from 'fs/promises';
import path from 'path';
import kuzu from 'kuzu';
import { performance } from 'node:perf_hooks';
import { KnowledgeGraph } from '../graph/types.js';
import { enrichRelationshipMetadata, serializeWitnessPathIds } from '../graph/edge-metadata.js';
import {
  NODE_TABLES,
  REL_TABLE_NAME,
  SCHEMA_QUERIES,
  EMBEDDING_TABLE_NAME,
  NodeTableName,
} from './schema.js';
import { generateAllCSVs } from './csv-generator.js';
import { acquireRefreshLock } from '../../storage/refresh-lock.js';
import type { RefreshLockLease } from '../../storage/refresh-lock.js';

let db: kuzu.Database | null = null;
let conn: kuzu.Connection | null = null;
let refreshLockLease: RefreshLockLease | null = null;
let ftsExtensionLoadAttempted = false;
let preparedStatementCache: Map<string, any> = new Map();

const REFRESH_LOCK_TIMEOUT_MS = Math.max(1_000, Number(process.env.GITNEXUS_REFRESH_LOCK_TIMEOUT_MS ?? 180_000));
const REFRESH_LOCK_POLL_MS = Math.max(100, Number(process.env.GITNEXUS_REFRESH_LOCK_POLL_MS ?? 1_000));
const isLockErrorMessage = (message: string): boolean => {
  const text = String(message || '').toLowerCase();
  return text.includes('could not set lock')
    || text.includes('database is locked')
    || text.includes('io exception')
    || text.includes(' lock ');
};

const normalizeCopyPath = (filePath: string): string => filePath.replace(/\\/g, '/');

const closeQueryResults = async (queryResult: any): Promise<void> => {
  if (!queryResult) return;
  const results = Array.isArray(queryResult) ? queryResult : [queryResult];
  for (const r of results) {
    try {
      if (r?.close) await r.close();
    } catch {}
  }
};

const queryAllRows = async (targetConn: kuzu.Connection, cypher: string): Promise<any[]> => {
  const queryResult = await targetConn.query(cypher);
  const results = Array.isArray(queryResult) ? queryResult : [queryResult];
  try {
    const result = results[0];
    const rows = await result.getAll();
    return rows;
  } finally {
    await closeQueryResults(results);
  }
};

export const initKuzu = async (dbPath: string) => {
  if (conn) return { db, conn };

  const repoPath = path.dirname(path.dirname(path.resolve(dbPath)));
  refreshLockLease = await acquireRefreshLock(repoPath, {
    timeoutMs: REFRESH_LOCK_TIMEOUT_MS,
    pollMs: REFRESH_LOCK_POLL_MS,
  });

  // kuzu v0.11 stores the database as a single file (not a directory).
  // If the path already exists, it must be a valid kuzu database file.
  // Remove stale empty directories or files from older versions.
  try {
    const stat = await fs.stat(dbPath);
    if (stat.isDirectory()) {
      // Old-style directory database or empty leftover - remove it
      const files = await fs.readdir(dbPath);
      if (files.length === 0) {
        await fs.rmdir(dbPath);
      } else {
        // Non-empty directory from older kuzu version - remove entire directory
        await fs.rm(dbPath, { recursive: true, force: true });
      }
    }
    // If it's a file, assume it's an existing kuzu database - kuzu will open it
  } catch {
    // Path doesn't exist, which is what kuzu wants for a new database
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(dbPath);
  await fs.mkdir(parentDir, { recursive: true });

  try {
    db = new kuzu.Database(dbPath);
    conn = new kuzu.Connection(db);
    preparedStatementCache.clear();

    let lockWarningLogged = false;
    for (const schemaQuery of SCHEMA_QUERIES) {
      try {
        const queryResult = await conn.query(schemaQuery);
        await closeQueryResults(queryResult);
      } catch (err) {
        // Only ignore "already exists" errors - log everything else
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
          if (isLockErrorMessage(msg)) {
            if (!lockWarningLogged) {
              console.warn(`⚠️ Schema creation warning: ${msg.slice(0, 120)}`);
              lockWarningLogged = true;
            }
            break;
          }
          console.warn(`⚠️ Schema creation warning: ${msg.slice(0, 120)}`);
        }
      }
    }

    return { db, conn };
  } catch (err) {
    try { await conn?.close(); } catch {}
    try { await db?.close(); } catch {}
    conn = null;
    db = null;
    ftsExtensionLoadAttempted = false;
    preparedStatementCache.clear();
    if (refreshLockLease) {
      try { await refreshLockLease.release(); } catch {}
      refreshLockLease = null;
    }
    throw err;
  }
};

export type KuzuProgressCallback = (message: string) => void;

export const loadGraphToKuzu = async (
  graph: KnowledgeGraph,
  fileContents: Map<string, string>,
  storagePath: string,
  onProgress?: KuzuProgressCallback
) => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }

  const log = onProgress || (() => {});

  const totalStartMs = performance.now();

  const csvGenStartMs = performance.now();
  const csvData = generateAllCSVs(graph, fileContents);
  const csvGenMs = performance.now() - csvGenStartMs;

  const csvDir = path.join(storagePath, 'csv');
  await fs.mkdir(csvDir, { recursive: true });

  log('Generating CSVs...');

  const nodeCsvWriteStartMs = performance.now();
  const nodeFiles: Array<{ table: NodeTableName; path: string; rows: number }> = [];
  const approxRowCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    approxRowCounts.set(node.label, (approxRowCounts.get(node.label) ?? 0) + 1);
  }
  for (const [tableName, csv] of csvData.nodes.entries()) {
    // CSV generator returns only the header line when there are no rows.
    // Avoid `split('\n')` — many CSVs include multi-line quoted fields (code content),
    // and splitting would be both incorrect for row counts and very expensive.
    if (!csv.includes('\n')) continue;
    const filePath = path.join(csvDir, `${tableName.toLowerCase()}.csv`);
    await fs.writeFile(filePath, csv, 'utf-8');
    nodeFiles.push({ table: tableName, path: filePath, rows: approxRowCounts.get(tableName) ?? 0 });
  }
  const nodeCsvWriteMs = performance.now() - nodeCsvWriteStartMs;

  const validTables = new Set<string>(NODE_TABLES as readonly string[]);
  const getNodeLabel = (nodeId: string): string => {
    if (nodeId.startsWith('comm_')) return 'Community';
    if (nodeId.startsWith('proc_')) return 'Process';
    return nodeId.split(':')[0];
  };
  const nodeLabelCache = new Map<string, string>();
  const getCachedNodeLabel = (nodeId: string): string => {
    const cached = nodeLabelCache.get(nodeId);
    if (cached) return cached;
    const label = getNodeLabel(nodeId);
    nodeLabelCache.set(nodeId, label);
    return label;
  };

  // Generate relationship CSV lines grouped by FROM->TO label pair.
  // This avoids building a single huge relation CSV string and then splitting/parsing it again.
  const sanitizeUTF8 = (str: string): string => {
    return str
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // Relationship CSV is intended to be strictly one-line-per-record (safe for PARALLEL COPY).
      // Normalize away newlines in metadata fields; code content never appears in edges.
      .replace(/\n/g, '\\n')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      .replace(/[\uD800-\uDFFF]/g, '')
      .replace(/[\uFFFE\uFFFF]/g, '');
  };

  const escapeCSVField = (value: string | number | undefined | null): string => {
    if (value === undefined || value === null) {
      return '""';
    }
    let str = String(value);
    if (str === '') {
      return '""';
    }
    str = sanitizeUTF8(str);
    return `"${str.replace(/"/g, '""')}"`;
  };
  const escapeCSVFieldFast = (value: string | undefined | null): string => {
    if (!value) return '""';
    return `"${value.replace(/"/g, '""')}"`;
  };

  const escapeCSVNumber = (value: number | undefined | null, defaultValue: number = -1): string => {
    if (value === undefined || value === null) {
      return String(defaultValue);
    }
    return String(value);
  };

  const relHeader = [
    'from',
    'to',
    'type',
    'confidence',
    'reason',
    'step',
    'certaintyTier',
    'provenanceFamily',
    'absenceSemantics',
    'witnessPathIds',
  ].join(',');

  const relGroupStartMs = performance.now();
  const relsByPair = new Map<string, string[]>();
  let skippedRels = 0;
  for (const rel of graph.relationships) {
    const metadata = enrichRelationshipMetadata(rel);
    const fromLabel = getCachedNodeLabel(metadata.sourceId);
    const toLabel = getCachedNodeLabel(metadata.targetId);
    if (!validTables.has(fromLabel) || !validTables.has(toLabel)) {
      skippedRels++;
      continue;
    }

    const line = [
      escapeCSVFieldFast(metadata.sourceId),
      escapeCSVFieldFast(metadata.targetId),
      escapeCSVFieldFast(metadata.type),
      escapeCSVNumber(metadata.confidence, 1.0),
      escapeCSVField(metadata.reason),
      escapeCSVNumber(metadata.step, 0),
      escapeCSVField(metadata.certaintyTier || ''),
      escapeCSVField(metadata.provenanceFamily || ''),
      escapeCSVField(metadata.absenceSemantics || ''),
      escapeCSVField(serializeWitnessPathIds(metadata.witnessPathIds)),
    ].join(',');

    const pairKey = `${fromLabel}|${toLabel}`;
    let list = relsByPair.get(pairKey);
    if (!list) { list = []; relsByPair.set(pairKey, list); }
    list.push(line);
  }
  const relGroupMs = performance.now() - relGroupStartMs;

  // Bulk COPY all node CSVs
  const totalSteps = nodeFiles.length + 1; // +1 for relationships
  let stepsDone = 0;
  const nodeCopyTimings: Array<{ table: NodeTableName; ms: number; rows: number }> = [];

  for (const { table, path: filePath, rows } of nodeFiles) {
    stepsDone++;
    log(`Loading nodes ${stepsDone}/${totalSteps}: ${table} (${rows.toLocaleString()} rows)`);

    const normalizedPath = normalizeCopyPath(filePath);
    const copyQuery = getCopyQuery(table, normalizedPath);

    const startMs = performance.now();
    try {
      const queryResult = await conn.query(copyQuery);
      await closeQueryResults(queryResult);
    } catch (err) {
      try {
        const retryQuery = copyQuery.replace('auto_detect=false)', 'auto_detect=false, IGNORE_ERRORS=true)');
        const retryResult = await conn.query(retryQuery);
        await closeQueryResults(retryResult);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(`COPY failed for ${table}: ${retryMsg.slice(0, 200)}`);
      }
    }
    const durationMs = performance.now() - startMs;
    nodeCopyTimings.push({ table, ms: durationMs, rows });
  }

  // Bulk COPY relationships — split by FROM→TO label pair (KuzuDB requires it)
  let insertedRels = 0;
  for (const lines of relsByPair.values()) insertedRels += lines.length;
  const warnings: string[] = [];
  const edgeCopyTimings: Array<{ fromLabel: string; toLabel: string; ms: number; edges: number }> = [];
  let edgeCsvWriteMs = 0;
  if (insertedRels > 0) {
    log(`Loading edges: ${insertedRels.toLocaleString()} across ${relsByPair.size} types`);

    let pairIdx = 0;
    let failedPairEdges = 0;
    const failedPairLines: string[] = [];

    const sortedPairs = Array.from(relsByPair.entries()).sort((left, right) => left[0].localeCompare(right[0]));
    for (const [pairKey, lines] of sortedPairs) {
      pairIdx++;
      const [fromLabel, toLabel] = pairKey.split('|');
      const pairCsvPath = path.join(csvDir, `rel_${fromLabel}_${toLabel}.csv`);
      const writeStartMs = performance.now();
      await fs.writeFile(pairCsvPath, relHeader + '\n' + lines.join('\n'), 'utf-8');
      edgeCsvWriteMs += Math.max(0, performance.now() - writeStartMs);
      const normalizedPath = normalizeCopyPath(pairCsvPath);
      const copyQuery = `COPY ${REL_TABLE_NAME} FROM "${normalizedPath}" (from="${fromLabel}", to="${toLabel}", HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=true, auto_detect=false)`;

      if (pairIdx % 5 === 0 || lines.length > 1000) {
        log(`Loading edges: ${pairIdx}/${relsByPair.size} types (${fromLabel} -> ${toLabel})`);
      }

      const startMs = performance.now();
      try {
        const queryResult = await conn.query(copyQuery);
        await closeQueryResults(queryResult);
      } catch (err) {
        try {
          const retryQuery = copyQuery.replace('auto_detect=false)', 'auto_detect=false, IGNORE_ERRORS=true)');
          const retryResult = await conn.query(retryQuery);
          await closeQueryResults(retryResult);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          warnings.push(`${fromLabel}->${toLabel} (${lines.length} edges): ${retryMsg.slice(0, 80)}`);
          failedPairEdges += lines.length;
          failedPairLines.push(...lines);
        }
      }
      const durationMs = performance.now() - startMs;
      edgeCopyTimings.push({ fromLabel, toLabel, ms: durationMs, edges: lines.length });
      try { await fs.unlink(pairCsvPath); } catch {}
    }

    if (failedPairLines.length > 0) {
      log(`Inserting ${failedPairEdges} edges individually (missing schema pairs)`);
      await fallbackRelationshipInserts([relHeader, ...failedPairLines], validTables, getNodeLabel);
    }
  }

  // Cleanup all CSVs
  const cleanupStartMs = performance.now();
  for (const { path: filePath } of nodeFiles) {
    try { await fs.unlink(filePath); } catch {}
  }
  try {
    const remaining = await fs.readdir(csvDir);
    for (const f of remaining) {
      try { await fs.unlink(path.join(csvDir, f)); } catch {}
    }
  } catch {}
  try { await fs.rmdir(csvDir); } catch {}
  const cleanupMs = performance.now() - cleanupStartMs;

  const totalMs = performance.now() - totalStartMs;
  const nodeCopyMs = nodeCopyTimings.reduce((sum, entry) => sum + entry.ms, 0);
  const edgeCopyMs = edgeCopyTimings.reduce((sum, entry) => sum + entry.ms, 0);

  const slowNodes = nodeCopyTimings
    .slice()
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 5);

  const slowEdges = edgeCopyTimings
    .slice()
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 5);

  return {
    success: true,
    insertedRels,
    skippedRels,
    warnings,
    timings: {
      totalMs,
      csvGenMs,
      writeNodesMs: nodeCsvWriteMs,
      groupRelsMs: relGroupMs,
      copyNodesMs: nodeCopyMs,
      copyEdgesMs: edgeCopyMs,
      cleanupMs,
      slowNodes,
      slowEdges,
      writeEdgesMs: edgeCsvWriteMs,
    },
  };
};

// KuzuDB default ESCAPE is '\' (backslash), but our CSV uses RFC 4180 escaping ("" for literal quotes).
// Source code content is full of backslashes which confuse the auto-detection.
// We MUST explicitly set ESCAPE='"' to use RFC 4180 escaping, and disable auto_detect to prevent
// KuzuDB from overriding our settings based on sample rows.
// Node CSVs replace raw newlines with U+2028 in `csv-generator.ts`, so every record stays single-line.
// This makes PARALLEL=true safe and materially faster on large repos.
const COPY_CSV_OPTS = `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=true, auto_detect=false)`;

const EXPORTED_CODE_TABLES = new Set<NodeTableName>([
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
]);

// Multi-language table names that were created with backticks in CODE_ELEMENT_BASE
// and must always be referenced with backticks in queries
const BACKTICK_TABLES = new Set([
  'Struct', 'Enum', 'Macro', 'Typedef', 'Union', 'Namespace', 'Trait', 'Impl',
  'TypeAlias', 'Const', 'Static', 'Property', 'Record', 'Delegate', 'Annotation',
  'Constructor', 'Template', 'Module',
]);

const escapeTableName = (table: string): string => {
  return BACKTICK_TABLES.has(table) ? `\`${table}\`` : table;
};

export const resetKuzuSchemaForReload = async (
  opts?: { preserveEmbeddings?: boolean },
): Promise<void> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }

  const preserveEmbeddings = opts?.preserveEmbeddings ?? false;

  // Existing DBs may have FTS indexes; Kuzu refuses to drop tables that are referenced by an index.
  // Drop all FTS indexes up-front so we can drop/recreate node tables for the reload.
  try {
    const rows = await queryAllRows(conn!, 'CALL SHOW_INDEXES() RETURN *');
    const ftsIndexes = rows
      .map((row: any) => ({
        tableName: String(row.table_name ?? row[0] ?? '').trim(),
        indexName: String(row.index_name ?? row[1] ?? '').trim(),
        indexType: String(row.index_type ?? row[2] ?? '').trim().toUpperCase(),
      }))
      .filter(idx => idx.tableName && idx.indexName && idx.indexType === 'FTS');

    if (ftsIndexes.length > 0) {
      try {
        const loadResult = await conn!.query('LOAD EXTENSION fts');
        await closeQueryResults(loadResult);
      } catch {
        // best-effort: extension may already be loaded, or unavailable in some builds
      }
    }

    for (const idx of ftsIndexes) {
      try {
        const escapedTable = idx.tableName.replace(/'/g, "''");
        const escapedIndex = idx.indexName.replace(/'/g, "''");
        const queryResult = await conn!.query(`CALL DROP_FTS_INDEX('${escapedTable}', '${escapedIndex}')`);
        await closeQueryResults(queryResult);
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }

  // Drop relationship table first (it references node tables).
  const dropTable = async (tableName: string): Promise<void> => {
    const queryResult = await conn!.query(`DROP TABLE ${tableName}`);
    await closeQueryResults(queryResult);
  };

  const tryDrop = async (tableName: string): Promise<void> => {
    try {
      await dropTable(tableName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isLockErrorMessage(msg)) throw err;
      if (msg.toLowerCase().includes('does not exist')) return;
      throw err;
    }
  };

  await tryDrop(REL_TABLE_NAME);
  for (const tableName of NODE_TABLES) {
    await tryDrop(escapeTableName(tableName));
  }
  if (!preserveEmbeddings) {
    await tryDrop(EMBEDDING_TABLE_NAME);
  }

  // Recreate schema for non-embedding tables. If we're preserving embeddings,
  // skip the embedding schema (table + index).
  for (const schemaQuery of SCHEMA_QUERIES) {
    if (preserveEmbeddings && schemaQuery.includes(`CREATE NODE TABLE ${EMBEDDING_TABLE_NAME}`)) continue;

    try {
      const queryResult = await conn!.query(schemaQuery);
      await closeQueryResults(queryResult);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) continue;
      if (isLockErrorMessage(msg)) throw err;
      throw err;
    }
  }

  preparedStatementCache.clear();
};

/** Fallback: insert relationships one-by-one if COPY fails */
const fallbackRelationshipInserts = async (
  validRelLines: string[],
  validTables: Set<string>,
  getNodeLabel: (id: string) => string
) => {
  if (!conn) return;
  const escapeLabel = (label: string): string => {
    return BACKTICK_TABLES.has(label) ? `\`${label}\`` : label;
  };

  for (let i = 1; i < validRelLines.length; i++) {
    const line = validRelLines[i];
    try {
      const match = line.match(/"([^"]*)","([^"]*)","([^"]*)",([0-9.]+),"([^"]*)",([0-9-]+),"([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
      if (!match) continue;
      const [, fromId, toId, relType, confidenceStr, reason, stepStr, certaintyTierRaw, provenanceFamilyRaw, absenceSemanticsRaw, witnessPathIdsRaw] = match;
      const fromLabel = getNodeLabel(fromId);
      const toLabel = getNodeLabel(toId);
      if (!validTables.has(fromLabel) || !validTables.has(toLabel)) continue;

      const confidence = parseFloat(confidenceStr) || 1.0;
      const step = parseInt(stepStr) || 0;
      const certaintyTier = String(certaintyTierRaw || '').replace(/'/g, "''");
      const provenanceFamily = String(provenanceFamilyRaw || '').replace(/'/g, "''");
      const absenceSemantics = String(absenceSemanticsRaw || '').replace(/'/g, "''");
      const witnessPathIds = String(witnessPathIdsRaw || '').replace(/'/g, "''");

      const queryResult = await conn.query(`
        MATCH (a:${escapeLabel(fromLabel)} {id: '${fromId.replace(/'/g, "''")}' }),
              (b:${escapeLabel(toLabel)} {id: '${toId.replace(/'/g, "''")}' })
        CREATE (a)-[:${REL_TABLE_NAME} {
          type: '${relType}',
          confidence: ${confidence},
          reason: '${reason.replace(/'/g, "''")}',
          step: ${step},
          certaintyTier: '${certaintyTier}',
          provenanceFamily: '${provenanceFamily}',
          absenceSemantics: '${absenceSemantics}',
          witnessPathIds: '${witnessPathIds}'
        }]->(b)
      `);
      await closeQueryResults(queryResult);
    } catch {
      // skip
    }
  }
};

const getCopyQuery = (table: NodeTableName, filePath: string): string => {
  const t = escapeTableName(table);
  if (table === 'File') {
    return `COPY ${t}(id, name, filePath, content) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Folder') {
    return `COPY ${t}(id, name, filePath) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Community') {
    return `COPY ${t}(id, label, heuristicLabel, keywords, description, enrichedBy, cohesion, symbolCount) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Process') {
    return `COPY ${t}(id, label, heuristicLabel, processType, stepCount, communities, entryPointId, terminalId) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'FeatureSlice') {
    return `COPY ${t}(id, label, heuristicLabel, sliceType, anchorId, anchorName, closureSlots, closedSlots, closureScore) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Gap') {
    return `COPY ${t}(id, label, heuristicLabel, gapType, absenceTier, severity, sliceId, anchorId, missingSlots, evidence) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'ContractShape') {
    return `COPY ${t}(id, label, heuristicLabel, shapeType, sourceNodeId, sourceFilePath) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'ContractField') {
    return `COPY ${t}(id, label, heuristicLabel, fieldName, shapeId, shapeType) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'CacheKey') {
    return `COPY ${t}(id, label, heuristicLabel, keyName, keyType, sourceNodeId) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'DBTable') {
    return `COPY ${t}(id, label, heuristicLabel, tableName, sourceFilePath) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'DBColumn') {
    return `COPY ${t}(id, label, heuristicLabel, columnName, tableId, tableName, sourceFilePath) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'ValueNode') {
    return `COPY ${t}(id, label, heuristicLabel, valueType, valueKey, valueRaw) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (EXPORTED_CODE_TABLES.has(table)) {
    return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  // Multi-language + Template/Module tables (no isExported column)
  return `COPY ${t}(id, name, filePath, startLine, endLine, content) FROM "${filePath}" ${COPY_CSV_OPTS}`;
};

/**
 * Insert a single node to KuzuDB
 * @param label - Node type (File, Function, Class, etc.)
 * @param properties - Node properties
 * @param dbPath - Path to KuzuDB database (optional if already initialized)
 */
export const insertNodeToKuzu = async (
  label: string,
  properties: Record<string, any>,
  dbPath?: string
): Promise<boolean> => {
  // Use provided dbPath or fall back to module-level db
  const targetDbPath = dbPath || (db ? undefined : null);
  if (!targetDbPath && !db) {
    throw new Error('KuzuDB not initialized. Provide dbPath or call initKuzu first.');
  }

  try {
    const escapeValue = (v: any): string => {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number') return String(v);
      // Escape backslashes first (for Windows paths), then single quotes
      return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
    };

    // Build INSERT query based on node type
    let query: string;
    
    if (label === 'File') {
      query = `CREATE (n:File {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, content: ${escapeValue(properties.content || '')}})`;
    } else if (label === 'Folder') {
      query = `CREATE (n:Folder {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}})`;
    } else {
      // Function, Class, Method, Interface, etc. - standard code element schema
      query = `CREATE (n:${label} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, content: ${escapeValue(properties.content || '')}})`;
    }
    
    // Use per-query connection if dbPath provided (avoids lock conflicts)
    if (targetDbPath) {
      const tempDb = new kuzu.Database(targetDbPath);
      const tempConn = new kuzu.Connection(tempDb);
      try {
        const queryResult = await tempConn.query(query);
        await closeQueryResults(queryResult);
        return true;
      } finally {
        try { await tempConn.close(); } catch {}
        try { await tempDb.close(); } catch {}
      }
    } else if (conn) {
      // Use existing persistent connection (when called from analyze)
      const queryResult = await conn.query(query);
      await closeQueryResults(queryResult);
      return true;
    }
    
    return false;
  } catch (e: any) {
    // Node may already exist or other error
    console.error(`Failed to insert ${label} node:`, e.message);
    return false;
  }
};

/**
 * Batch insert multiple nodes to KuzuDB using a single connection
 * @param nodes - Array of {label, properties} to insert
 * @param dbPath - Path to KuzuDB database
 * @returns Object with success count and error count
 */
export const batchInsertNodesToKuzu = async (
  nodes: Array<{ label: string; properties: Record<string, any> }>,
  dbPath: string
): Promise<{ inserted: number; failed: number }> => {
  if (nodes.length === 0) return { inserted: 0, failed: 0 };
  
  const escapeValue = (v: any): string => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    // Escape backslashes first (for Windows paths), then single quotes
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  };
  
  // Open a single connection for all inserts
  const tempDb = new kuzu.Database(dbPath);
  const tempConn = new kuzu.Connection(tempDb);
  
  let inserted = 0;
  let failed = 0;
  
  try {
    for (const { label, properties } of nodes) {
      try {
        let query: string;
        
        // Use MERGE instead of CREATE for upsert behavior (handles duplicates gracefully)
        if (label === 'File') {
          query = `MERGE (n:File {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.content = ${escapeValue(properties.content || '')}`;
        } else if (label === 'Folder') {
          query = `MERGE (n:Folder {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}`;
        } else {
          query = `MERGE (n:${label} {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.content = ${escapeValue(properties.content || '')}`;
        }
        
        const queryResult = await tempConn.query(query);
        await closeQueryResults(queryResult);
        inserted++;
      } catch (e: any) {
        // Don't console.error here - it corrupts MCP JSON-RPC on stderr
        failed++;
      }
    }
  } finally {
    try { await tempConn.close(); } catch {}
    try { await tempDb.close(); } catch {}
  }
  
  return { inserted, failed };
};

export const executeQuery = async (cypher: string): Promise<any[]> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }

  return queryAllRows(conn, cypher);
};

export const executeWithReusedStatement = async (
  cypher: string,
  paramsList: Array<Record<string, any>>,
  options?: { throwOnError?: boolean },
): Promise<void> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }
  if (paramsList.length === 0) return;

  const SUB_BATCH_SIZE = 200;
  const throwOnError = Boolean(options?.throwOnError);

  let stmt = preparedStatementCache.get(cypher);
  if (!stmt) {
    stmt = await conn.prepare(cypher);
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    preparedStatementCache.set(cypher, stmt);
  }

  for (let i = 0; i < paramsList.length; i += SUB_BATCH_SIZE) {
    const subBatch = paramsList.slice(i, i + SUB_BATCH_SIZE);
    for (let j = 0; j < subBatch.length; j += 1) {
      const params = subBatch[j];
      try {
        const execResult = await conn.execute(stmt, params);
        await closeQueryResults(execResult);
      } catch (e) {
        if (throwOnError) {
          const msg = e instanceof Error ? e.message : String(e || '');
          throw new Error(`Batch execution error (idx=${i + j}): ${msg}`);
        }
        // Best effort: keep going for the rest of the batch.
        console.warn('Batch execution error:', e);
      }
    }
  }
};

export const getKuzuStats = async (): Promise<{ nodes: number; edges: number }> => {
  if (!conn) return { nodes: 0, edges: 0 };

  let totalNodes = 0;
  for (const tableName of NODE_TABLES) {
    try {
      const nodeRows = await queryAllRows(conn, `MATCH (n:${tableName}) RETURN count(n) AS cnt`);
      if (nodeRows.length > 0) {
        totalNodes += Number(nodeRows[0]?.cnt ?? nodeRows[0]?.[0] ?? 0);
      }
    } catch {
      // ignore
    }
  }

  let totalEdges = 0;
  try {
    const edgeRows = await queryAllRows(conn, `MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`);
    if (edgeRows.length > 0) {
      totalEdges = Number(edgeRows[0]?.cnt ?? edgeRows[0]?.[0] ?? 0);
    }
  } catch {
    // ignore
  }

  return { nodes: totalNodes, edges: totalEdges };
};

/**
 * Load cached embeddings from KuzuDB before a rebuild.
 * Returns all embedding vectors so they can be re-inserted after the graph is reloaded,
 * avoiding expensive re-embedding of unchanged nodes.
 */
export const loadCachedEmbeddings = async (): Promise<{
  embeddingNodeIds: Set<string>;
  embeddings: Array<{ nodeId: string; embedding: number[] }>;
}> => {
  if (!conn) {
    return { embeddingNodeIds: new Set(), embeddings: [] };
  }

  const embeddingNodeIds = new Set<string>();
  const embeddings: Array<{ nodeId: string; embedding: number[] }> = [];
  try {
    const rows = await queryAllRows(conn, `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.embedding AS embedding`);
    for (const row of rows as any[]) {
      const nodeId = String(row.nodeId ?? row[0] ?? '');
      if (!nodeId) continue;
      embeddingNodeIds.add(nodeId);
      const embedding = row.embedding ?? row[1];
      if (embedding) {
        embeddings.push({
          nodeId,
          embedding: Array.isArray(embedding) ? embedding.map(Number) : Array.from(embedding as any).map(Number),
        });
      }
    }
  } catch { /* embedding table may not exist */ }

  return { embeddingNodeIds, embeddings };
};

export const closeKuzu = async (): Promise<void> => {
  if (conn) {
    try {
      await conn.close();
    } catch {}
    conn = null;
  }
  if (db) {
    try {
      await db.close();
    } catch {}
    db = null;
  }
  if (refreshLockLease) {
    try {
      await refreshLockLease.release();
    } catch {}
    refreshLockLease = null;
  }
  ftsExtensionLoadAttempted = false;
  preparedStatementCache.clear();
};

export const isKuzuReady = (): boolean => conn !== null && db !== null;

/**
 * Delete all nodes (and their relationships) for a specific file from KuzuDB
 * @param filePath - The file path to delete nodes for
 * @param dbPath - Optional path to KuzuDB for per-query connection
 * @returns Object with counts of deleted nodes
 */
export const deleteNodesForFile = async (
  filePath: string,
  opts?: { dbPath?: string; includeFileNode?: boolean },
): Promise<{ deletedNodes: number }> => {
  const dbPath = opts?.dbPath;
  const includeFileNode = opts?.includeFileNode ?? true;
  const usePerQuery = !!dbPath;
  
  // Set up connection (either use existing or create per-query)
  let tempDb: kuzu.Database | null = null;
  let tempConn: kuzu.Connection | null = null;
  let targetConn: kuzu.Connection | null = conn;
  
  if (usePerQuery) {
    tempDb = new kuzu.Database(dbPath);
    tempConn = new kuzu.Connection(tempDb);
    targetConn = tempConn;
  } else if (!conn) {
    throw new Error('KuzuDB not initialized. Provide dbPath or call initKuzu first.');
  }
  
  try {
    let deletedNodes = 0;
    const escapedPath = filePath.replace(/'/g, "''");
    
    // Delete nodes from each table that has filePath
    // DETACH DELETE removes the node and all its relationships
    for (const tableName of NODE_TABLES) {
      // Skip tables that don't have filePath
      if (tableName === 'Community' || tableName === 'Process' || tableName === 'FeatureSlice' || tableName === 'Gap' || tableName === 'ContractShape' || tableName === 'ContractField' || tableName === 'CacheKey' || tableName === 'DBTable' || tableName === 'DBColumn' || tableName === 'ValueNode') continue;
      if (!includeFileNode && tableName === 'File') continue;
      
      try {
        // Delete nodes (and implicitly their relationships via DETACH).
        // Note: we intentionally do not fetch counts here — some Kuzu builds have
        // shown instability when mixing large delete workloads with count+getAll().
        const queryResult = await targetConn!.query(
          `MATCH (n:${tableName}) WHERE n.filePath = '${escapedPath}' DETACH DELETE n`
        );
        await closeQueryResults(queryResult);
      } catch (e) {
        // Some tables may not support this query, skip
      }
    }
    
    // Also delete any embeddings for nodes in this file
    try {
      const queryResult = await targetConn!.query(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.nodeId = 'File:${escapedPath}' OR e.nodeId = 'Template:${escapedPath}' OR e.nodeId CONTAINS ':${escapedPath}:' DELETE e`
      );
      await closeQueryResults(queryResult);
    } catch {
      // Embedding table may not exist or nodeId format may differ
    }
    
    return { deletedNodes };
  } finally {
    // Close per-query connection if used
    if (tempConn) {
      try { await tempConn.close(); } catch {}
    }
    if (tempDb) {
      try { await tempDb.close(); } catch {}
    }
  }
};

const chunkArray = <T>(values: T[], size: number): T[][] => {
  if (size <= 0) return [values];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
};

export const deleteNodesForFiles = async (
  filePaths: string[],
  opts?: { dbPath?: string; includeFileNode?: boolean },
): Promise<{ deletedNodes: number }> => {
  const dbPath = opts?.dbPath;
  const includeFileNode = opts?.includeFileNode ?? true;
  const usePerQuery = !!dbPath;

  let tempDb: kuzu.Database | null = null;
  let tempConn: kuzu.Connection | null = null;
  let targetConn: kuzu.Connection | null = conn;

  if (usePerQuery) {
    tempDb = new kuzu.Database(dbPath);
    tempConn = new kuzu.Connection(tempDb);
    targetConn = tempConn;
  } else if (!conn) {
    throw new Error('KuzuDB not initialized. Provide dbPath or call initKuzu first.');
  }

  try {
    const unique = Array.from(new Set(filePaths.map(fp => fp.trim()).filter(Boolean)));
    if (unique.length === 0) return { deletedNodes: 0 };

    const filePathChunks = chunkArray(unique, 200);

    for (const tableName of NODE_TABLES) {
      // Skip tables that don't have filePath
      if (tableName === 'Community' || tableName === 'Process' || tableName === 'FeatureSlice' || tableName === 'Gap' || tableName === 'ContractShape' || tableName === 'ContractField' || tableName === 'CacheKey' || tableName === 'DBTable' || tableName === 'DBColumn' || tableName === 'ValueNode') continue;
      if (!includeFileNode && tableName === 'File') continue;

      const t = escapeTableName(tableName);
      for (const chunk of filePathChunks) {
        const escapedPaths = chunk.map(fp => `'${fp.replace(/'/g, "''")}'`).join(', ');
        if (!escapedPaths) continue;
        try {
          const queryResult = await targetConn!.query(
            `MATCH (n:${t}) WHERE n.filePath IN [${escapedPaths}] DETACH DELETE n`
          );
          await closeQueryResults(queryResult);
        } catch {
          // Some tables may not support this query, skip
        }
      }
    }

    // Also delete any embeddings for nodes in these files
    for (const chunk of chunkArray(unique, 50)) {
      const conditions = chunk
        .map(fp => {
          const escapedPath = fp.replace(/'/g, "''");
          return `(e.nodeId = 'File:${escapedPath}' OR e.nodeId = 'Template:${escapedPath}' OR e.nodeId CONTAINS ':${escapedPath}:')`;
        })
        .filter(Boolean)
        .join(' OR ');
      if (!conditions) continue;

      try {
        const queryResult = await targetConn!.query(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE ${conditions} DELETE e`
        );
        await closeQueryResults(queryResult);
      } catch {
        // Embedding table may not exist or nodeId format may differ
      }
    }

    return { deletedNodes: 0 };
  } finally {
    if (tempConn) {
      try { await tempConn.close(); } catch {}
    }
    if (tempDb) {
      try { await tempDb.close(); } catch {}
    }
  }
};

export const deleteOutgoingRelationshipsForFile = async (
  filePath: string,
  relationTypes: string[],
  opts?: { dbPath?: string },
): Promise<{ deletedEdges: number }> => {
  const dbPath = opts?.dbPath;
  const usePerQuery = !!dbPath;

  let tempDb: kuzu.Database | null = null;
  let tempConn: kuzu.Connection | null = null;
  let targetConn: kuzu.Connection | null = conn;

  if (usePerQuery) {
    tempDb = new kuzu.Database(dbPath);
    tempConn = new kuzu.Connection(tempDb);
    targetConn = tempConn;
  } else if (!conn) {
    throw new Error('KuzuDB not initialized. Provide dbPath or call initKuzu first.');
  }

  try {
    const escapedPath = filePath.replace(/'/g, "''");
    const typeList = relationTypes
      .map(t => `'${t.replace(/'/g, "''")}'`)
      .join(', ');

    const cypher = `
      MATCH (a)-[r:${REL_TABLE_NAME}]->()
      WHERE a.filePath = '${escapedPath}'${relationTypes.length > 0 ? ` AND r.type IN [${typeList}]` : ''}
      DELETE r
    `;

    const queryResult = await targetConn!.query(cypher);
    await closeQueryResults(queryResult);
    return { deletedEdges: 0 };
  } catch {
    return { deletedEdges: 0 };
  } finally {
    if (tempConn) {
      try { await tempConn.close(); } catch {}
    }
    if (tempDb) {
      try { await tempDb.close(); } catch {}
    }
  }
};

export const deleteOutgoingRelationshipsForFiles = async (
  filePaths: string[],
  relationTypes: string[],
  opts?: { dbPath?: string },
): Promise<{ deletedEdges: number }> => {
  const dbPath = opts?.dbPath;
  const usePerQuery = !!dbPath;

  let tempDb: kuzu.Database | null = null;
  let tempConn: kuzu.Connection | null = null;
  let targetConn: kuzu.Connection | null = conn;

  if (usePerQuery) {
    tempDb = new kuzu.Database(dbPath);
    tempConn = new kuzu.Connection(tempDb);
    targetConn = tempConn;
  } else if (!conn) {
    throw new Error('KuzuDB not initialized. Provide dbPath or call initKuzu first.');
  }

  try {
    const unique = Array.from(new Set(filePaths.map(fp => fp.trim()).filter(Boolean)));
    if (unique.length === 0) return { deletedEdges: 0 };

    const typeList = relationTypes
      .map(t => `'${t.replace(/'/g, "''")}'`)
      .join(', ');

    for (const chunk of chunkArray(unique, 250)) {
      const escapedPaths = chunk.map(fp => `'${fp.replace(/'/g, "''")}'`).join(', ');
      if (!escapedPaths) continue;

      const cypher = `
        MATCH (a)-[r:${REL_TABLE_NAME}]->()
        WHERE a.filePath IN [${escapedPaths}]${relationTypes.length > 0 ? ` AND r.type IN [${typeList}]` : ''}
        DELETE r
      `;

      const queryResult = await targetConn!.query(cypher);
      await closeQueryResults(queryResult);
    }

    return { deletedEdges: 0 };
  } catch {
    return { deletedEdges: 0 };
  } finally {
    if (tempConn) {
      try { await tempConn.close(); } catch {}
    }
    if (tempDb) {
      try { await tempDb.close(); } catch {}
    }
  }
};

export const getUpstreamFilePathsForFiles = async (filePaths: string[]): Promise<string[]> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }

  const unique = Array.from(new Set(filePaths.map(fp => fp.trim()).filter(Boolean)));
  if (unique.length === 0) return [];

  const escaped = unique.map(fp => `'${fp.replace(/'/g, "''")}'`).join(', ');

  const cypher = `
    MATCH (src)-[:${REL_TABLE_NAME}]->(tgt)
    WHERE tgt.filePath IN [${escaped}] AND src.filePath <> ''
    MATCH (f:File {filePath: src.filePath})
    RETURN DISTINCT src.filePath AS filePath
  `;

  try {
    const rows = await queryAllRows(conn, cypher);
    const filePathList = rows
      .map((row: any) => String(row.filePath ?? row[0] ?? '').trim())
      .filter(Boolean);
    return Array.from(new Set(filePathList));
  } catch {
    return [];
  }
};

export const loadSymbolDefinitionsFromKuzu = async (): Promise<Array<{ filePath: string; name: string; nodeId: string; type: string }>> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }

  const defs: Array<{ filePath: string; name: string; nodeId: string; type: string }> = [];

  for (const tableName of NODE_TABLES) {
    if (tableName === 'File' || tableName === 'Folder' || tableName === 'Community' || tableName === 'Process' || tableName === 'FeatureSlice' || tableName === 'Gap' || tableName === 'ContractShape' || tableName === 'ContractField' || tableName === 'CacheKey' || tableName === 'DBTable' || tableName === 'DBColumn' || tableName === 'ValueNode') continue;

    try {
      const t = escapeTableName(tableName);
      const rows = await queryAllRows(conn, `MATCH (n:${t}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`);
      for (const row of rows as any[]) {
        const nodeId = String(row.id ?? row[0] ?? '').trim();
        const name = String(row.name ?? row[1] ?? '').trim();
        const filePath = String(row.filePath ?? row[2] ?? '').trim();
        if (!nodeId || !name || !filePath) continue;
        defs.push({ nodeId, name, filePath, type: tableName });
      }
    } catch {
      // table may not exist, skip
    }
  }

  return defs;
};

export const loadEmbeddingNodeIds = async (): Promise<Set<string>> => {
  if (!conn) return new Set();
  const ids = new Set<string>();
  try {
    const rows = await queryAllRows(conn, `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`);
    for (const row of rows as any[]) {
      const nodeId = String(row.nodeId ?? row[0] ?? '').trim();
      if (nodeId) ids.add(nodeId);
    }
  } catch {
    // ignore
  }
  return ids;
};

export const getEmbeddingTableName = (): string => EMBEDDING_TABLE_NAME;

// ============================================================================
// Full-Text Search (FTS) Functions
// ============================================================================

/**
 * Load the FTS extension (required before using FTS functions)
 */
export const loadFTSExtension = async (): Promise<void> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }
  if (ftsExtensionLoadAttempted) return;
  ftsExtensionLoadAttempted = true;
  try {
    const installResult = await conn.query('INSTALL fts');
    await closeQueryResults(installResult);
  } catch {
    // Extension may already be installed
  }
  try {
    const loadResult = await conn.query('LOAD EXTENSION fts');
    await closeQueryResults(loadResult);
  } catch {
    // Extension may already be loaded
  }
};

/**
 * Create a full-text search index on a table
 * @param tableName - The node table name (e.g., 'File', 'CodeSymbol')
 * @param indexName - Name for the FTS index
 * @param properties - List of properties to index (e.g., ['name', 'code'])
 * @param stemmer - Stemming algorithm (default: 'none' for code-friendly search)
 */
export const createFTSIndex = async (
  tableName: string,
  indexName: string,
  properties: string[],
  stemmer: string = 'none'
): Promise<void> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }
  
  await loadFTSExtension();
  
  const propList = properties.map(p => `'${p}'`).join(', ');
  const query = `CALL CREATE_FTS_INDEX('${tableName}', '${indexName}', [${propList}], stemmer := '${stemmer}')`;
  
  try {
    const queryResult = await conn.query(query);
    await closeQueryResults(queryResult);
  } catch (e: any) {
    // Index may already exist
    if (!e.message?.includes('already exists')) {
      throw e;
    }
  }
};

/**
 * Query a full-text search index
 * @param tableName - The node table name
 * @param indexName - FTS index name
 * @param query - Search query string
 * @param limit - Maximum results
 * @param conjunctive - If true, all terms must match (AND); if false, any term matches (OR)
 * @returns Array of { node properties, score }
 */
export const queryFTS = async (
  tableName: string,
  indexName: string,
  query: string,
  limit: number = 20,
  conjunctive: boolean = false
): Promise<Array<{ nodeId: string; name: string; filePath: string; score: number; [key: string]: any }>> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }
  
  // Escape single quotes in query
  const escapedQuery = query.replace(/'/g, "''");
  
  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := ${conjunctive})
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;
  
  try {
    const rows = await queryAllRows(conn, cypher);
    return rows.map((row: any) => {
      const node = row.node || row[0] || {};
      const score = row.score ?? row[1] ?? 0;
      return {
        nodeId: node.nodeId || node.id || '',
        name: node.name || '',
        filePath: node.filePath || '',
        score: typeof score === 'number' ? score : parseFloat(score) || 0,
        ...node,
      };
    });
  } catch (e: any) {
    // Return empty if index doesn't exist yet
    if (e.message?.includes('does not exist')) {
      return [];
    }
    throw e;
  }
};

/**
 * Drop an FTS index
 */
export const dropFTSIndex = async (tableName: string, indexName: string): Promise<void> => {
  if (!conn) {
    throw new Error('KuzuDB not initialized. Call initKuzu first.');
  }
  
  try {
    const queryResult = await conn.query(`CALL DROP_FTS_INDEX('${tableName}', '${indexName}')`);
    await closeQueryResults(queryResult);
  } catch {
    // Index may not exist
  }
};
