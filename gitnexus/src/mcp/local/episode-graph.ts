import fs from 'fs/promises';
import path from 'path';

export type HypothesisStatus = 'accepted' | 'rejected' | 'candidate';

export interface EpisodeSymbolRef {
  symbolId: string;
  name?: string;
  kind?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  processId?: string;
}

export interface EpisodeProcessRef {
  processId: string;
  name?: string;
  signature?: string;
  stepCount?: number;
}

export interface EpisodeSpanRef {
  filePath: string;
  startLine?: number;
  endLine?: number;
  sourceSymbolId?: string;
  sourceProcessId?: string;
}

export interface EpisodePrecedentRef {
  kind?: string;
  signature?: string;
  anchorUid?: string;
  processId?: string;
}

export interface EpisodeObservation {
  tool?: string;
  targetBranch?: string;
  taskId?: string;
  openedSymbols?: EpisodeSymbolRef[];
  openedProcesses?: EpisodeProcessRef[];
  openedSpans?: EpisodeSpanRef[];
  chosenPrecedents?: EpisodePrecedentRef[];
  failingTests?: string[];
  errorStrings?: string[];
  acceptedHypotheses?: string[];
  rejectedHypotheses?: string[];
  candidateHypotheses?: string[];
  editFiles?: string[];
  witnessPaths?: string[];
}

export interface EpisodeNode {
  id: string;
  kind: string;
  label: string;
  symbolId?: string;
  processId?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
}

export interface EpisodeEdge {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
}

export interface EpisodeHypothesis {
  id: string;
  text: string;
  status: HypothesisStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
}

export interface EpisodeFactRef {
  id: string;
  value: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
}

export interface EpisodeTargetContext {
  branch?: string;
  taskId?: string;
  updatedAt?: string;
}

export interface EpisodeEvent {
  id: string;
  tool: string;
  recordedAt: string;
  openedSymbols: number;
  openedProcesses: number;
  openedSpans: number;
  editFiles: number;
}

export interface EpisodeGraphState {
  version: 1;
  updatedAt: string;
  target: EpisodeTargetContext;
  nodes: EpisodeNode[];
  edges: EpisodeEdge[];
  hypotheses: EpisodeHypothesis[];
  failingTests: EpisodeFactRef[];
  errors: EpisodeFactRef[];
  editSet: EpisodeFactRef[];
  witnessPaths: EpisodeFactRef[];
  precedents: EpisodeFactRef[];
  events: EpisodeEvent[];
}

export interface EpisodeOverlay {
  symbolBoosts: Map<string, number>;
  fileBoosts: Map<string, number>;
  target: EpisodeTargetContext;
}

const EPISODE_FILE_NAME = 'episode-graph.json';
const MAX_NODES = 1200;
const MAX_EDGES = 2000;
const MAX_HYPOTHESES = 300;
const MAX_FACTS = 600;
const MAX_EVENTS = 600;

const normalizePath = (value: string): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const clampPositiveInt = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return fallback;
  return Math.floor(n);
};

const nowIso = (): string => new Date().toISOString();

const sanitizeIdSegment = (value: string): string => {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_./-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 240);
};

const makeState = (): EpisodeGraphState => ({
  version: 1,
  updatedAt: nowIso(),
  target: {},
  nodes: [],
  edges: [],
  hypotheses: [],
  failingTests: [],
  errors: [],
  editSet: [],
  witnessPaths: [],
  precedents: [],
  events: [],
});

const parseTime = (value: string): number => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

const sortByRecent = <T extends { lastSeenAt: string }>(list: T[]): T[] => {
  return list.sort((a, b) => parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt));
};

const pruneRecent = <T extends { lastSeenAt: string }>(list: T[], max: number): T[] => {
  return sortByRecent(list).slice(0, max);
};

const sortEventsByRecent = (list: EpisodeEvent[]): EpisodeEvent[] => {
  return list.sort((a, b) => parseTime(b.recordedAt) - parseTime(a.recordedAt));
};

const pruneRecentEvents = (list: EpisodeEvent[], max: number): EpisodeEvent[] => {
  return sortEventsByRecent(list).slice(0, max);
};

const upsertFact = (
  list: EpisodeFactRef[],
  id: string,
  value: string,
  now: string,
): void => {
  if (!id || !value) return;
  const existing = list.find(item => item.id === id);
  if (existing) {
    existing.value = value;
    existing.lastSeenAt = now;
    existing.count = clampPositiveInt(existing.count, 0) + 1;
    return;
  }
  list.push({
    id,
    value,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
  });
};

const upsertNode = (state: EpisodeGraphState, node: Omit<EpisodeNode, 'firstSeenAt' | 'lastSeenAt' | 'count'>, now: string): EpisodeNode => {
  const existing = state.nodes.find(item => item.id === node.id);
  if (existing) {
    existing.label = node.label || existing.label;
    existing.kind = node.kind || existing.kind;
    existing.symbolId = node.symbolId || existing.symbolId;
    existing.processId = node.processId || existing.processId;
    existing.filePath = node.filePath || existing.filePath;
    existing.startLine = node.startLine ?? existing.startLine;
    existing.endLine = node.endLine ?? existing.endLine;
    existing.signature = node.signature || existing.signature;
    existing.lastSeenAt = now;
    existing.count = clampPositiveInt(existing.count, 0) + 1;
    return existing;
  }

  const created: EpisodeNode = {
    ...node,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
  };
  state.nodes.push(created);
  return created;
};

const upsertEdge = (state: EpisodeGraphState, edge: Omit<EpisodeEdge, 'firstSeenAt' | 'lastSeenAt' | 'count'>, now: string): void => {
  if (!edge.sourceId || !edge.targetId || !edge.type) return;
  const existing = state.edges.find(item => item.id === edge.id);
  if (existing) {
    existing.lastSeenAt = now;
    existing.count = clampPositiveInt(existing.count, 0) + 1;
    return;
  }

  state.edges.push({
    ...edge,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
  });
};

const upsertHypothesis = (
  state: EpisodeGraphState,
  text: string,
  status: HypothesisStatus,
  now: string,
): void => {
  const cleaned = String(text || '').trim();
  if (!cleaned) return;

  const id = `hyp:${sanitizeIdSegment(cleaned)}`;
  const existing = state.hypotheses.find(item => item.id === id);
  if (existing) {
    existing.status = status;
    existing.lastSeenAt = now;
    existing.count = clampPositiveInt(existing.count, 0) + 1;
    return;
  }

  state.hypotheses.push({
    id,
    text: cleaned,
    status,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
  });
};

const parseSpanToken = (token: string): EpisodeSpanRef | null => {
  const raw = String(token || '').trim();
  if (!raw) return null;

  const match = raw.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (!match) {
    const filePath = normalizePath(raw);
    if (!filePath) return null;
    return { filePath };
  }

  const filePath = normalizePath(match[1] || '');
  if (!filePath) return null;

  const startLine = clampPositiveInt(match[2], 0);
  const endLine = clampPositiveInt(match[3], 0);

  return {
    filePath,
    ...(startLine > 0 ? { startLine } : {}),
    ...(endLine > 0 ? { endLine } : {}),
  };
};

const pruneState = (state: EpisodeGraphState): EpisodeGraphState => {
  state.nodes = pruneRecent(state.nodes, MAX_NODES);
  state.edges = pruneRecent(state.edges, MAX_EDGES);
  state.hypotheses = pruneRecent(state.hypotheses, MAX_HYPOTHESES);
  state.failingTests = pruneRecent(state.failingTests, MAX_FACTS);
  state.errors = pruneRecent(state.errors, MAX_FACTS);
  state.editSet = pruneRecent(state.editSet, MAX_FACTS);
  state.witnessPaths = pruneRecent(state.witnessPaths, MAX_FACTS);
  state.precedents = pruneRecent(state.precedents, MAX_FACTS);
  state.events = pruneRecentEvents(state.events, MAX_EVENTS);
  return state;
};

export const getEpisodeGraphPath = (storagePath: string): string => {
  return path.join(storagePath, EPISODE_FILE_NAME);
};

export const loadEpisodeGraphState = async (storagePath: string): Promise<EpisodeGraphState> => {
  const filePath = getEpisodeGraphPath(storagePath);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as EpisodeGraphState;
    if (!parsed || parsed.version !== 1) return makeState();
    return pruneState({
      ...makeState(),
      ...parsed,
      target: parsed.target || {},
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses : [],
      failingTests: Array.isArray(parsed.failingTests) ? parsed.failingTests : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      editSet: Array.isArray(parsed.editSet) ? parsed.editSet : [],
      witnessPaths: Array.isArray(parsed.witnessPaths) ? parsed.witnessPaths : [],
      precedents: Array.isArray(parsed.precedents) ? parsed.precedents : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
    });
  } catch {
    return makeState();
  }
};

export const saveEpisodeGraphState = async (storagePath: string, state: EpisodeGraphState): Promise<void> => {
  await fs.mkdir(storagePath, { recursive: true });
  const filePath = getEpisodeGraphPath(storagePath);
  await fs.writeFile(filePath, JSON.stringify(pruneState(state), null, 2), 'utf-8');
};

export const clearEpisodeGraphState = async (storagePath: string): Promise<EpisodeGraphState> => {
  const state = makeState();
  await saveEpisodeGraphState(storagePath, state);
  return state;
};

export const recordEpisodeObservation = async (
  storagePath: string,
  observation: EpisodeObservation,
): Promise<EpisodeGraphState> => {
  const state = await loadEpisodeGraphState(storagePath);
  const now = nowIso();

  if (observation.targetBranch || observation.taskId) {
    state.target = {
      ...state.target,
      ...(observation.targetBranch ? { branch: String(observation.targetBranch).trim() } : {}),
      ...(observation.taskId ? { taskId: String(observation.taskId).trim() } : {}),
      updatedAt: now,
    };
  }

  const processNodeById = new Map<string, EpisodeNode>();
  const symbolNodeById = new Map<string, EpisodeNode>();

  for (const proc of observation.openedProcesses || []) {
    const processId = String(proc.processId || '').trim();
    if (!processId) continue;
    const node = upsertNode(state, {
      id: `episode:process:${processId}`,
      kind: 'opened_process',
      label: proc.name || processId,
      processId,
      signature: proc.signature,
    }, now);
    processNodeById.set(processId, node);
  }

  for (const sym of observation.openedSymbols || []) {
    const symbolId = String(sym.symbolId || '').trim();
    if (!symbolId) continue;
    const node = upsertNode(state, {
      id: `episode:symbol:${symbolId}`,
      kind: 'opened_symbol',
      label: sym.name || symbolId,
      symbolId,
      filePath: normalizePath(sym.filePath || ''),
      startLine: sym.startLine,
      endLine: sym.endLine,
    }, now);
    symbolNodeById.set(symbolId, node);

    const processId = String(sym.processId || '').trim();
    if (processId && processNodeById.has(processId)) {
      const src = processNodeById.get(processId)!;
      upsertEdge(state, {
        id: `episode:edge:opened_in_process:${src.id}->${node.id}`,
        type: 'opened_in_process',
        sourceId: src.id,
        targetId: node.id,
      }, now);
    }
  }

  for (const span of observation.openedSpans || []) {
    const filePath = normalizePath(span.filePath || '');
    if (!filePath) continue;
    const startLine = clampPositiveInt(span.startLine, 0);
    const endLine = clampPositiveInt(span.endLine, 0);
    const spanId = `episode:span:${filePath}:${startLine || 0}:${endLine || 0}`;
    const node = upsertNode(state, {
      id: spanId,
      kind: 'opened_span',
      label: `${filePath}${startLine > 0 ? `:${startLine}` : ''}${endLine > 0 ? `:${endLine}` : ''}`,
      filePath,
      ...(startLine > 0 ? { startLine } : {}),
      ...(endLine > 0 ? { endLine } : {}),
    }, now);

    const sourceSymbolId = String(span.sourceSymbolId || '').trim();
    if (sourceSymbolId && symbolNodeById.has(sourceSymbolId)) {
      const src = symbolNodeById.get(sourceSymbolId)!;
      upsertEdge(state, {
        id: `episode:edge:opened_span:${src.id}->${node.id}`,
        type: 'opened_span',
        sourceId: src.id,
        targetId: node.id,
      }, now);
      continue;
    }

    const sourceProcessId = String(span.sourceProcessId || '').trim();
    if (sourceProcessId && processNodeById.has(sourceProcessId)) {
      const src = processNodeById.get(sourceProcessId)!;
      upsertEdge(state, {
        id: `episode:edge:opened_span:${src.id}->${node.id}`,
        type: 'opened_span',
        sourceId: src.id,
        targetId: node.id,
      }, now);
    }
  }

  for (const precedent of observation.chosenPrecedents || []) {
    const signature = String(precedent.signature || '').trim();
    const processId = String(precedent.processId || '').trim();
    const anchorUid = String(precedent.anchorUid || '').trim();
    const kind = String(precedent.kind || '').trim() || 'precedent';
    const ref = signature || processId || anchorUid;
    if (!ref) continue;
    upsertFact(state.precedents, `prec:${sanitizeIdSegment(`${kind}:${ref}`)}`, `${kind}:${ref}`, now);
  }

  for (const file of observation.editFiles || []) {
    const filePath = normalizePath(file);
    if (!filePath) continue;
    upsertFact(state.editSet, `edit:${sanitizeIdSegment(filePath)}`, filePath, now);
  }

  for (const witness of observation.witnessPaths || []) {
    const text = String(witness || '').trim();
    if (!text) continue;
    upsertFact(state.witnessPaths, `witness:${sanitizeIdSegment(text)}`, text, now);
  }

  for (const testName of observation.failingTests || []) {
    const text = String(testName || '').trim();
    if (!text) continue;
    upsertFact(state.failingTests, `test:${sanitizeIdSegment(text)}`, text, now);
  }

  for (const errorText of observation.errorStrings || []) {
    const text = String(errorText || '').trim();
    if (!text) continue;
    upsertFact(state.errors, `error:${sanitizeIdSegment(text)}`, text, now);
  }

  for (const text of observation.acceptedHypotheses || []) {
    upsertHypothesis(state, text, 'accepted', now);
  }
  for (const text of observation.rejectedHypotheses || []) {
    upsertHypothesis(state, text, 'rejected', now);
  }
  for (const text of observation.candidateHypotheses || []) {
    upsertHypothesis(state, text, 'candidate', now);
  }

  const eventTool = String(observation.tool || '').trim();
  if (eventTool) {
    state.events.push({
      id: `event:${sanitizeIdSegment(`${eventTool}:${now}:${state.events.length + 1}`)}`,
      tool: eventTool,
      recordedAt: now,
      openedSymbols: (observation.openedSymbols || []).length,
      openedProcesses: (observation.openedProcesses || []).length,
      openedSpans: (observation.openedSpans || []).length,
      editFiles: (observation.editFiles || []).length,
    });
  }

  state.updatedAt = now;
  pruneState(state);
  await saveEpisodeGraphState(storagePath, state);
  return state;
};

export const parseEpisodeSpanTokens = (tokens: string[]): EpisodeSpanRef[] => {
  const out: EpisodeSpanRef[] = [];
  for (const token of tokens || []) {
    const parsed = parseSpanToken(token);
    if (!parsed) continue;
    out.push(parsed);
  }
  return out;
};

const computeRecencyBoost = (lastSeenAt: string, count: number, nowMs: number): number => {
  const seenAt = parseTime(lastSeenAt);
  if (!seenAt) return 0.01;
  const hoursAgo = Math.max(0, (nowMs - seenAt) / (60 * 60 * 1000));
  const recencyBase =
    hoursAgo <= 1 ? 0.12 :
    hoursAgo <= 24 ? 0.08 :
    hoursAgo <= 72 ? 0.05 :
    hoursAgo <= 168 ? 0.03 :
    0.015;
  const frequency = Math.min(0.06, Math.max(0, count) * 0.01);
  return Math.max(0.01, recencyBase + frequency);
};

export const buildEpisodeOverlay = (
  state: EpisodeGraphState,
  nowMs = Date.now(),
): EpisodeOverlay => {
  const symbolBoosts = new Map<string, number>();
  const fileBoosts = new Map<string, number>();

  for (const node of state.nodes) {
    if (node.kind === 'opened_symbol' && node.symbolId) {
      const boost = computeRecencyBoost(node.lastSeenAt, node.count, nowMs);
      const current = symbolBoosts.get(node.symbolId) || 0;
      symbolBoosts.set(node.symbolId, Math.max(current, boost));
    }
    if ((node.kind === 'opened_symbol' || node.kind === 'opened_span') && node.filePath) {
      const filePath = normalizePath(node.filePath);
      if (!filePath) continue;
      const boost = computeRecencyBoost(node.lastSeenAt, node.count, nowMs) * 0.6;
      const current = fileBoosts.get(filePath) || 0;
      fileBoosts.set(filePath, Math.max(current, boost));
    }
  }

  for (const edit of state.editSet) {
    const filePath = normalizePath(edit.value);
    if (!filePath) continue;
    const boost = computeRecencyBoost(edit.lastSeenAt, edit.count, nowMs) * 0.9;
    const current = fileBoosts.get(filePath) || 0;
    fileBoosts.set(filePath, Math.max(current, boost));
  }

  return {
    symbolBoosts,
    fileBoosts,
    target: state.target || {},
  };
};

export const summarizeEpisodeGraphState = (
  state: EpisodeGraphState,
  options?: {
    limit?: number;
    includeEvents?: boolean;
  },
): any => {
  const limit = Math.max(1, Math.min(100, options?.limit ?? 10));
  const includeEvents = options?.includeEvents !== false;

  const recentSymbols = sortByRecent(
    state.nodes
      .filter(node => node.kind === 'opened_symbol')
      .map(node => ({
        symbolId: node.symbolId || '',
        name: node.label,
        filePath: node.filePath || '',
        startLine: node.startLine,
        lastSeenAt: node.lastSeenAt,
        count: node.count,
      }))
      .filter(node => node.symbolId),
  ).slice(0, limit);

  const recentSpans = sortByRecent(
    state.nodes
      .filter(node => node.kind === 'opened_span')
      .map(node => ({
        filePath: node.filePath || '',
        startLine: node.startLine,
        endLine: node.endLine,
        lastSeenAt: node.lastSeenAt,
        count: node.count,
      }))
      .filter(node => node.filePath),
  ).slice(0, limit);

  return {
    version: state.version,
    updated_at: state.updatedAt,
    target: state.target,
    counts: {
      nodes: state.nodes.length,
      edges: state.edges.length,
      hypotheses: state.hypotheses.length,
      failing_tests: state.failingTests.length,
      errors: state.errors.length,
      edit_set: state.editSet.length,
      witness_paths: state.witnessPaths.length,
      precedents: state.precedents.length,
      events: state.events.length,
    },
    recent_symbols: recentSymbols,
    recent_spans: recentSpans,
    hypotheses: sortByRecent(state.hypotheses).slice(0, limit).map(item => ({
      text: item.text,
      status: item.status,
      lastSeenAt: item.lastSeenAt,
      count: item.count,
    })),
    failing_tests: sortByRecent(state.failingTests).slice(0, limit).map(item => item.value),
    errors: sortByRecent(state.errors).slice(0, limit).map(item => item.value),
    edit_set: sortByRecent(state.editSet).slice(0, limit).map(item => item.value),
    witness_paths: sortByRecent(state.witnessPaths).slice(0, limit).map(item => item.value),
    precedents: sortByRecent(state.precedents).slice(0, limit).map(item => item.value),
    ...(includeEvents ? {
      recent_events: sortEventsByRecent(state.events).slice(0, limit).map(event => ({
        tool: event.tool,
        recordedAt: event.recordedAt,
        openedSymbols: event.openedSymbols,
        openedProcesses: event.openedProcesses,
        openedSpans: event.openedSpans,
        editFiles: event.editFiles,
      })),
    } : {}),
  };
};
