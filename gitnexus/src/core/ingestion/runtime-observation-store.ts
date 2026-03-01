import fs from 'fs/promises';
import path from 'path';

const RUNTIME_FILE_CANDIDATES = [
  'runtime-observations.json',
  'runtime-observations.snapshot.json',
  'runtime-observations.ndjson',
];

export type RuntimeRequestSpan = {
  method?: string;
  route?: string;
  duration_ms: number;
  status?: number;
  payload_bytes?: number;
  trace_id?: string;
  file_path_hints?: string[];
};

export type RuntimeDbQuery = {
  sql?: string;
  duration_ms: number;
  rows_examined?: number;
  lock_wait_ms?: number;
  count?: number;
  explain_plan?: string;
  route?: string;
  file_path_hints?: string[];
};

export type RuntimePayloadShape = {
  path?: string;
  item_count?: number;
  bytes?: number;
  keys?: string[];
  file_path_hints?: string[];
};

export type RuntimeObservationSnapshot = {
  version: number;
  generatedAt: string;
  source_files: string[];
  request_spans: RuntimeRequestSpan[];
  db_queries: RuntimeDbQuery[];
  payload_shapes: RuntimePayloadShape[];
};

export const emptyRuntimeObservationSnapshot = (): RuntimeObservationSnapshot => ({
  version: 1,
  generatedAt: '',
  source_files: [],
  request_spans: [],
  db_queries: [],
  payload_shapes: [],
});

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const normalizePathList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => normalizePath(item))
    .filter(Boolean)
    .slice(0, 20);
};

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

const normalizeRequestSpan = (value: any): RuntimeRequestSpan | null => {
  const durationMs = normalizeNumber(value?.duration_ms ?? value?.durationMs, 0, 0, 60_000);
  const method = String(value?.method || '').trim().toUpperCase();
  const route = String(value?.route || value?.path || '').trim();
  if (!durationMs && !method && !route) return null;

  return {
    ...(method ? { method } : {}),
    ...(route ? { route } : {}),
    duration_ms: durationMs,
    ...(Number.isFinite(Number(value?.status)) ? { status: Number(value.status) } : {}),
    ...(Number.isFinite(Number(value?.payload_bytes ?? value?.payloadBytes))
      ? { payload_bytes: Number(value?.payload_bytes ?? value?.payloadBytes) }
      : {}),
    ...(String(value?.trace_id || value?.traceId || '').trim()
      ? { trace_id: String(value?.trace_id || value?.traceId || '').trim() }
      : {}),
    ...(normalizePathList(value?.file_path_hints ?? value?.filePathHints).length > 0
      ? { file_path_hints: normalizePathList(value?.file_path_hints ?? value?.filePathHints) }
      : {}),
  };
};

const normalizeDbQuery = (value: any): RuntimeDbQuery | null => {
  const durationMs = normalizeNumber(value?.duration_ms ?? value?.durationMs, 0, 0, 60_000);
  const sql = String(value?.sql || value?.query || '').trim();
  if (!durationMs && !sql) return null;

  const route = String(value?.route || value?.path || '').trim();
  const explainPlan = String(value?.explain_plan || value?.explainPlan || '').trim();
  return {
    ...(sql ? { sql } : {}),
    duration_ms: durationMs,
    ...(Number.isFinite(Number(value?.rows_examined ?? value?.rowsExamined))
      ? { rows_examined: Number(value?.rows_examined ?? value?.rowsExamined) }
      : {}),
    ...(Number.isFinite(Number(value?.lock_wait_ms ?? value?.lockWaitMs))
      ? { lock_wait_ms: Number(value?.lock_wait_ms ?? value?.lockWaitMs) }
      : {}),
    ...(Number.isFinite(Number(value?.count)) ? { count: Number(value?.count) } : {}),
    ...(explainPlan ? { explain_plan: explainPlan } : {}),
    ...(route ? { route } : {}),
    ...(normalizePathList(value?.file_path_hints ?? value?.filePathHints).length > 0
      ? { file_path_hints: normalizePathList(value?.file_path_hints ?? value?.filePathHints) }
      : {}),
  };
};

const normalizePayloadShape = (value: any): RuntimePayloadShape | null => {
  const pathValue = String(value?.path || value?.route || '').trim();
  const itemCount = Number.isFinite(Number(value?.item_count ?? value?.itemCount))
    ? Number(value?.item_count ?? value?.itemCount)
    : undefined;
  const bytes = Number.isFinite(Number(value?.bytes ?? value?.payload_bytes ?? value?.payloadBytes))
    ? Number(value?.bytes ?? value?.payload_bytes ?? value?.payloadBytes)
    : undefined;
  const keys = Array.isArray(value?.keys)
    ? value.keys.map((item: any) => String(item || '').trim()).filter(Boolean).slice(0, 30)
    : [];

  if (!pathValue && !itemCount && !bytes && keys.length === 0) return null;

  return {
    ...(pathValue ? { path: pathValue } : {}),
    ...(itemCount !== undefined ? { item_count: itemCount } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(keys.length > 0 ? { keys } : {}),
    ...(normalizePathList(value?.file_path_hints ?? value?.filePathHints).length > 0
      ? { file_path_hints: normalizePathList(value?.file_path_hints ?? value?.filePathHints) }
      : {}),
  };
};

const parseNdjson = (raw: string): any[] => {
  return String(raw || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const sanitizeObjectPayload = (value: any): RuntimeObservationSnapshot => {
  if (!value || typeof value !== 'object') return emptyRuntimeObservationSnapshot();

  const requestSpansRaw = Array.isArray(value.request_spans)
    ? value.request_spans
    : Array.isArray(value.requestSpans)
      ? value.requestSpans
      : [];
  const dbQueriesRaw = Array.isArray(value.db_queries)
    ? value.db_queries
    : Array.isArray(value.dbQueries)
      ? value.dbQueries
      : [];
  const payloadShapesRaw = Array.isArray(value.payload_shapes)
    ? value.payload_shapes
    : Array.isArray(value.payloadShapes)
      ? value.payloadShapes
      : [];

  return {
    version: 1,
    generatedAt: String(value.generatedAt || value.generated_at || ''),
    source_files: [],
    request_spans: requestSpansRaw.map(normalizeRequestSpan).filter(Boolean) as RuntimeRequestSpan[],
    db_queries: dbQueriesRaw.map(normalizeDbQuery).filter(Boolean) as RuntimeDbQuery[],
    payload_shapes: payloadShapesRaw.map(normalizePayloadShape).filter(Boolean) as RuntimePayloadShape[],
  };
};

const sanitizeEventArrayPayload = (entries: any[]): RuntimeObservationSnapshot => {
  const request_spans: RuntimeRequestSpan[] = [];
  const db_queries: RuntimeDbQuery[] = [];
  const payload_shapes: RuntimePayloadShape[] = [];

  for (const entry of entries) {
    const kind = String(entry?.kind || entry?.type || '').trim().toLowerCase();
    if (kind === 'request_span' || kind === 'request') {
      const normalized = normalizeRequestSpan(entry);
      if (normalized) request_spans.push(normalized);
      continue;
    }
    if (kind === 'db_query' || kind === 'query') {
      const normalized = normalizeDbQuery(entry);
      if (normalized) db_queries.push(normalized);
      continue;
    }
    if (kind === 'payload_shape' || kind === 'payload') {
      const normalized = normalizePayloadShape(entry);
      if (normalized) payload_shapes.push(normalized);
    }
  }

  return {
    version: 1,
    generatedAt: '',
    source_files: [],
    request_spans,
    db_queries,
    payload_shapes,
  };
};

export const parseRuntimeObservationPayload = (value: unknown): RuntimeObservationSnapshot => {
  if (Array.isArray(value)) return sanitizeEventArrayPayload(value);
  if (value && typeof value === 'object') return sanitizeObjectPayload(value as any);
  return emptyRuntimeObservationSnapshot();
};

export const parseRuntimeObservationText = (raw: string, formatHint?: string): RuntimeObservationSnapshot => {
  const normalizedHint = String(formatHint || '').trim().toLowerCase();
  if (normalizedHint === 'ndjson') {
    return parseRuntimeObservationPayload(parseNdjson(raw));
  }

  try {
    const parsed = JSON.parse(raw);
    return parseRuntimeObservationPayload(parsed);
  } catch {
    return parseRuntimeObservationPayload(parseNdjson(raw));
  }
};

const loadSingleRuntimeFile = async (filePath: string): Promise<RuntimeObservationSnapshot> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const extension = path.extname(filePath).toLowerCase();
    const snapshot = parseRuntimeObservationText(raw, extension === '.ndjson' ? 'ndjson' : 'json');
    snapshot.source_files = [filePath];
    if (!snapshot.generatedAt) {
      try {
        const stat = await fs.stat(filePath);
        snapshot.generatedAt = new Date(stat.mtimeMs).toISOString();
      } catch {
        snapshot.generatedAt = '';
      }
    }
    return snapshot;
  } catch {
    return emptyRuntimeObservationSnapshot();
  }
};

export const mergeRuntimeObservationSnapshots = (snapshots: RuntimeObservationSnapshot[]): RuntimeObservationSnapshot => {
  if (snapshots.length === 0) return emptyRuntimeObservationSnapshot();
  const merged: RuntimeObservationSnapshot = emptyRuntimeObservationSnapshot();
  const requestSeen = new Set<string>();
  const dbSeen = new Set<string>();
  const payloadSeen = new Set<string>();

  for (const snapshot of snapshots) {
    if (!merged.generatedAt || (snapshot.generatedAt && snapshot.generatedAt > merged.generatedAt)) {
      merged.generatedAt = snapshot.generatedAt;
    }
    for (const sourceFile of snapshot.source_files) {
      if (!merged.source_files.includes(sourceFile)) merged.source_files.push(sourceFile);
    }

    for (const span of snapshot.request_spans) {
      const key = `${span.method || ''}|${span.route || ''}|${span.duration_ms}|${span.status || ''}`;
      if (requestSeen.has(key)) continue;
      requestSeen.add(key);
      merged.request_spans.push(span);
    }

    for (const query of snapshot.db_queries) {
      const key = `${query.sql || ''}|${query.duration_ms}|${query.lock_wait_ms || ''}|${query.rows_examined || ''}`;
      if (dbSeen.has(key)) continue;
      dbSeen.add(key);
      merged.db_queries.push(query);
    }

    for (const shape of snapshot.payload_shapes) {
      const key = `${shape.path || ''}|${shape.item_count || ''}|${shape.bytes || ''}|${(shape.keys || []).join(',')}`;
      if (payloadSeen.has(key)) continue;
      payloadSeen.add(key);
      merged.payload_shapes.push(shape);
    }
  }

  merged.request_spans = merged.request_spans
    .sort((a, b) => Number(b.duration_ms || 0) - Number(a.duration_ms || 0))
    .slice(0, 500);
  merged.db_queries = merged.db_queries
    .sort((a, b) => Number(b.duration_ms || 0) - Number(a.duration_ms || 0))
    .slice(0, 1000);
  merged.payload_shapes = merged.payload_shapes
    .sort((a, b) => Number(b.item_count || 0) - Number(a.item_count || 0))
    .slice(0, 500);

  return merged;
};

export const loadRuntimeObservationSnapshot = async (
  storagePath: string,
  options?: {
    repoPath?: string;
    extraPaths?: string[];
  },
): Promise<RuntimeObservationSnapshot> => {
  const candidatePaths = new Set<string>();
  for (const fileName of RUNTIME_FILE_CANDIDATES) {
    candidatePaths.add(path.join(storagePath, fileName));
    if (options?.repoPath) {
      candidatePaths.add(path.join(options.repoPath, '.gitnexus', fileName));
    }
  }
  for (const extraPath of options?.extraPaths || []) {
    const normalized = String(extraPath || '').trim();
    if (!normalized) continue;
    candidatePaths.add(normalized);
  }

  const snapshots: RuntimeObservationSnapshot[] = [];
  for (const filePath of candidatePaths) {
    const snapshot = await loadSingleRuntimeFile(filePath);
    if (
      snapshot.request_spans.length === 0
      && snapshot.db_queries.length === 0
      && snapshot.payload_shapes.length === 0
    ) {
      continue;
    }
    snapshots.push(snapshot);
  }

  return mergeRuntimeObservationSnapshots(snapshots);
};
