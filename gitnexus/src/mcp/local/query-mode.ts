import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface QueryModeRepoHandle {
  name: string;
  repoPath: string;
}

export interface QueryModeParams {
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
}

type QueryModeDeps = {
  query: (repo: QueryModeRepoHandle, params: any) => Promise<any>;
  precedents: (repo: QueryModeRepoHandle, params: any) => Promise<any>;
  actionPlan: (repo: QueryModeRepoHandle, params: any) => Promise<any>;
  parsePathPrefixes: (repoPath: string, param: unknown) => string[];
  clampInteger: (value: unknown, fallback: number, min?: number, max?: number) => number;
  toFiniteNumber: (value: unknown, fallback?: number) => number;
  loadConvergenceMatrix?: (repo: QueryModeRepoHandle) => Promise<ConvergenceMatrixSnapshot | null>;
};

type ConvergenceMatrixCell = {
  cluster: string;
  signature: string;
  score: number;
  route: string;
  tokenSet: Set<string>;
  exemplarFilePaths: string[];
};

export type ConvergenceMatrixSnapshot = {
  sourcePath: string;
  loadedAt: string;
  cells: ConvergenceMatrixCell[];
};

type ConvergenceSignal = {
  score: number;
  cluster: string;
  signature: string;
  route: string;
};

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const convergenceMatrixCache = new Map<string, { mtimeMs: number; snapshot: ConvergenceMatrixSnapshot | null }>();

const normalizePathValue = (value: unknown): string => String(value || '').trim().replace(/\\/g, '/');

const toRepoRelativePath = (value: unknown, repoPath: string): string => {
  const normalized = normalizePathValue(value);
  if (!normalized) return '';

  const normalizedRepoPath = normalizePathValue(repoPath).replace(/\/+$/, '');
  if (normalizedRepoPath && normalized.startsWith(`${normalizedRepoPath}/`)) {
    return normalized.slice(normalizedRepoPath.length + 1);
  }

  return normalized.replace(/^\.\/+/, '');
};

const tokenize = (value: unknown): string[] =>
  String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(token => token.length >= 2);

const overlapCount = (left: Set<string>, right: Set<string>): number => {
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap;
};

const pathAffinity = (leftPath: string, rightPath: string): number => {
  const left = normalizePathValue(leftPath).split('/').filter(Boolean);
  const right = normalizePathValue(rightPath).split('/').filter(Boolean);
  if (left.length === 0 || right.length === 0) return 0;

  let common = 0;
  const upper = Math.min(left.length, right.length);
  while (common < upper && left[common] === right[common]) common += 1;
  if (common < 3) return 0;

  return common / Math.max(left.length, right.length);
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));
const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));
const readinessLevel = (score: number): 'high' | 'medium' | 'low' => (
  score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low'
);
const QUERY_SYMBOL_RANK_WEIGHTS = {
  readiness: 0.36,
  process_rank: 0.19,
  slice_rank: 0.11,
  lexical: 0.34,
  process_source_boost: 0.08,
  lexical_floor: 0.04,
} as const;
const QUERY_NEXT_ACTION_GATES = {
  symbol_base: 50,
  symbol_floor: 32,
  carbon_base: 55,
  carbon_floor: 36,
  process_base: 0.08,
  process_floor: 0.03,
} as const;
const QUERY_NEXT_ACTION_RANK_WEIGHTS = {
  score: 0.58,
  convergence: 0.28,
  confidence: 0.14,
} as const;

const computeAdaptiveGate = (base: number, floor: number, retrievalSignal: number): number =>
  floor + ((base - floor) * clampUnit(retrievalSignal));

const resolveConvergenceMatrixPaths = (repo: QueryModeRepoHandle): string[] => {
  const repoPattern = `${String(repo.name || '').trim() || 'repo'}-patterns`;
  const cwd = process.cwd();
  const candidates = [
    path.join(repo.repoPath, '.gitnexus', 'lamination_matrix.json'),
    path.join(repo.repoPath, '.gitnexus', 'brain', 'lamination_matrix.json'),
    path.join(MODULE_ROOT, 'reports', repoPattern, 'pass-2', 'lamination_matrix.json'),
    path.join(cwd, 'reports', repoPattern, 'pass-2', 'lamination_matrix.json'),
    path.join(cwd, '..', 'reports', repoPattern, 'pass-2', 'lamination_matrix.json'),
  ];
  return Array.from(new Set(candidates.map(candidate => path.resolve(candidate))));
};

const parseConvergenceMatrix = (raw: any, sourcePath: string): ConvergenceMatrixSnapshot | null => {
  const rawCells = Array.isArray(raw?.topCells)
    ? raw.topCells
    : (Array.isArray(raw?.matrix) ? raw.matrix : []);
  if (rawCells.length === 0) return null;

  const cells: ConvergenceMatrixCell[] = [];
  for (const item of rawCells.slice(0, 120)) {
    const score = Number(item?.carbonCopyReadyScore ?? item?.score ?? 0);
    if (!Number.isFinite(score) || score <= 0) continue;

    const cluster = String(item?.cluster || '').trim();
    const signature = String(item?.signature || '').trim();
    const route = String(item?.signatureTopRoute || '').trim();
    const exemplarRows = Array.isArray(item?.exemplarSlices) ? item.exemplarSlices : [];
    const exemplarFilePaths: string[] = Array.from(
      new Set<string>(
        exemplarRows
          .flatMap((row: any) => [
            toRepoRelativePath(row?.entryFile, ''),
            toRepoRelativePath(row?.terminalFile, ''),
          ])
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ).slice(0, 10);

    const tokenSet = new Set<string>([
      ...tokenize(cluster),
      ...tokenize(signature),
      ...tokenize(route),
      ...exemplarRows.flatMap((row: any) => tokenize(row?.label || '')),
    ]);

    cells.push({
      cluster,
      signature,
      score: Math.max(0, Math.min(100, score)),
      route,
      tokenSet,
      exemplarFilePaths,
    });
  }

  if (cells.length === 0) return null;

  return {
    sourcePath,
    loadedAt: new Date().toISOString(),
    cells,
  };
};

const loadConvergenceMatrixSnapshot = async (repo: QueryModeRepoHandle): Promise<ConvergenceMatrixSnapshot | null> => {
  const candidates = resolveConvergenceMatrixPaths(repo);
  for (const sourcePath of candidates) {
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) continue;

      const cached = convergenceMatrixCache.get(sourcePath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.snapshot;
      }

      const rawText = await fs.readFile(sourcePath, 'utf8');
      const parsed = parseConvergenceMatrix(JSON.parse(rawText), sourcePath);
      convergenceMatrixCache.set(sourcePath, { mtimeMs: stat.mtimeMs, snapshot: parsed });
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }

  return null;
};

const computeConvergenceSignal = (
  matrix: ConvergenceMatrixSnapshot,
  queryTokenSet: Set<string>,
  itemTokenSet: Set<string>,
  itemFilePaths: string[],
): ConvergenceSignal | null => {
  if (!matrix?.cells?.length) return null;
  if (itemTokenSet.size === 0 && itemFilePaths.length === 0) return null;

  let best: ConvergenceSignal | null = null;
  for (const cell of matrix.cells) {
    const normalizedCellScore = Math.max(0, Math.min(1, cell.score / 100));

    const tokenOverlap = overlapCount(itemTokenSet, cell.tokenSet);
    const tokenCoverage = tokenOverlap > 0
      ? tokenOverlap / Math.max(1, Math.min(itemTokenSet.size, 8))
      : 0;
    const queryOverlap = overlapCount(queryTokenSet, cell.tokenSet);
    const queryFactor = queryOverlap > 0 ? 1.1 : 1;
    const tokenSignal = tokenCoverage * normalizedCellScore * 0.55 * queryFactor;

    let fileSignal = 0;
    if (itemFilePaths.length > 0 && cell.exemplarFilePaths.length > 0) {
      for (const itemFilePath of itemFilePaths) {
        for (const exemplarFilePath of cell.exemplarFilePaths) {
          const affinity = pathAffinity(itemFilePath, exemplarFilePath);
          if (affinity <= 0) continue;
          fileSignal = Math.max(fileSignal, affinity * normalizedCellScore * 0.9);
        }
      }
    }

    const combined = Math.max(tokenSignal, fileSignal);
    if (!best || combined > best.score) {
      best = {
        score: round3(combined),
        cluster: cell.cluster,
        signature: cell.signature,
        route: cell.route,
      };
    }
  }

  return best;
};

export async function runQueryMode(
  deps: QueryModeDeps,
  repo: QueryModeRepoHandle,
  params: QueryModeParams,
): Promise<any> {
  const {
    query,
    precedents,
    actionPlan,
    parsePathPrefixes,
    clampInteger,
    toFiniteNumber,
  } = deps;
  const queryText = String(params.query || '').trim();
  if (!queryText) {
    return { error: 'query parameter is required and cannot be empty.' };
  }

  const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
  const limitProcesses = clampInteger(params.limit_processes, 4, 1, 10);
  const maxSymbols = clampInteger(params.max_symbols, 16, 1, 40);
  const limitSlices = clampInteger(params.limit_slices, 2, 1, 5);
  const limitPrecedents = clampInteger(params.limit_precedents, 2, 0, 5);
  const limitHops = clampInteger(params.limit_hops, 4, 0, 10);
  const includePrecedents = params.include_precedents !== false;
  const includeActionHints = params.include_action_hints !== false;
  const processFetchLimit = Math.max(limitProcesses, Math.min(15, limitProcesses * 3));
  const sliceFetchLimit = Math.max(limitSlices, 5);

  const queryResult = await query(repo, {
    query: queryText,
    task_context: params.task_context,
    goal: params.goal,
    path_prefixes: pathPrefixes,
    limit: Math.max(5, processFetchLimit),
    max_symbols: Math.max(10, maxSymbols),
    include_content: false,
    include_slice_cards: true,
    limit_slices: sliceFetchLimit,
    include_evidence_spans: true,
    limit_evidence: 30,
  });

  if (queryResult?.error) return queryResult;

  const processSymbols = Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols : [];
  const definitions = Array.isArray(queryResult?.definitions) ? queryResult.definitions : [];

  const queryTokenSet = new Set<string>([
    ...tokenize(queryText),
    ...tokenize(params.task_context || ''),
    ...tokenize(params.goal || ''),
  ]);

  const processFilesById = new Map<string, string[]>();
  const processSymbolCountById = new Map<string, number>();
  for (const symbol of processSymbols) {
    const processId = String(symbol?.process_id || '').trim();
    const filePath = toRepoRelativePath(symbol?.filePath, repo.repoPath);
    if (!processId) continue;
    processSymbolCountById.set(processId, (processSymbolCountById.get(processId) || 0) + 1);
    if (!filePath) continue;
    if (!processFilesById.has(processId)) processFilesById.set(processId, []);
    const list = processFilesById.get(processId)!;
    if (!list.includes(filePath)) list.push(filePath);
  }

  const convergenceMatrix = deps.loadConvergenceMatrix
    ? await deps.loadConvergenceMatrix(repo)
    : await loadConvergenceMatrixSnapshot(repo);

  const processCandidates = Array.isArray(queryResult?.processes)
    ? queryResult.processes.slice(0, processFetchLimit)
    : [];
  const scoredProcesses = processCandidates.map((processItem: any, index: number) => {
    const processId = String(processItem?.id || '').trim();
    const filePaths = processFilesById.get(processId) || [];
    const tokenSet = new Set<string>([
      ...tokenize(processItem?.summary || ''),
      ...tokenize(processItem?.process_type || ''),
      ...filePaths.flatMap(filePath => tokenize(filePath)),
    ]);
    const signal = convergenceMatrix
      ? computeConvergenceSignal(convergenceMatrix, queryTokenSet, tokenSet, filePaths)
      : null;
    return {
      index,
      process: processItem,
      signal,
    };
  });

  const rankedProcesses = scoredProcesses
    .slice()
    .sort((left, right) => {
      const leftScore = toFiniteNumber(left.signal?.score, 0);
      const rightScore = toFiniteNumber(right.signal?.score, 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.index - right.index;
    })
    .map(entry => entry.process);

  const sliceCandidates = Array.isArray(queryResult?.slice_cards)
    ? queryResult.slice_cards.slice(0, sliceFetchLimit)
    : [];
  const scoredSlices = sliceCandidates.map((sliceItem: any, index: number) => {
    const members = Array.isArray(sliceItem?.matched_members) ? sliceItem.matched_members : [];
    const filePaths: string[] = Array.from(new Set<string>(
      members
        .map((member: any) => toRepoRelativePath(member?.filePath, repo.repoPath))
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ));
    const tokenSet = new Set<string>([
      ...tokenize(sliceItem?.label || ''),
      ...tokenize(sliceItem?.slice_type || ''),
      ...tokenize(sliceItem?.anchor_name || ''),
      ...tokenize(sliceItem?.uid || ''),
      ...tokenize((Array.isArray(sliceItem?.roles) ? sliceItem.roles : []).join(' ')),
      ...members.flatMap((member: any) => tokenize(member?.name || '')),
      ...filePaths.flatMap(filePath => tokenize(filePath)),
    ]);
    const signal = convergenceMatrix
      ? computeConvergenceSignal(convergenceMatrix, queryTokenSet, tokenSet, filePaths)
      : null;
    return {
      index,
      slice: sliceItem,
      signal,
    };
  });

  const rankedSlices = scoredSlices
    .slice()
    .sort((left, right) => {
      const leftScore = toFiniteNumber(left.signal?.score, 0);
      const rightScore = toFiniteNumber(right.signal?.score, 0);
      if (rightScore !== leftScore) return rightScore - leftScore;
      return left.index - right.index;
    })
    .map(entry => entry.slice);

  const topSlice = rankedSlices[0] || null;

  let precedentPack: any = null;
  if (includePrecedents && limitPrecedents > 0) {
    try {
      precedentPack = await precedents(repo, {
        query: queryText,
        ...(topSlice?.anchor_id ? { anchor_uid: String(topSlice.anchor_id) } : {}),
        limit: Math.max(1, Math.min(5, limitPrecedents)),
        examples: Math.max(1, Math.min(5, Math.max(2, limitPrecedents))),
        path_prefixes: pathPrefixes,
      });
    } catch {
      precedentPack = null;
    }
  }

  let actionPlanResult: any = null;
  if (includeActionHints) {
    try {
      actionPlanResult = await actionPlan(repo, {
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
  const actionHintFiles = Array.isArray(actionPlanResult?.files) ? actionPlanResult.files.slice(0, 8) : [];
  const actionHintChecks = Array.isArray(actionPlanResult?.checks) ? actionPlanResult.checks.slice(0, 8) : [];
  const actionHintHops = Array.isArray(actionPlanResult?.hops) ? actionPlanResult.hops.slice(0, limitHops) : [];

  const hypotheses: string[] = [];
  const topGapSignals = topSlice?.gap_signals || null;
  const topGapHigh = toFiniteNumber(topGapSignals?.high, 0);
  const topGapDeterministic = toFiniteNumber(topGapSignals?.deterministic, 0);
  const exactLookupHits = toFiniteNumber(queryResult?.query_plan?.exact_lookup?.hits, 0);
  if (topGapSignals && topGapHigh > 0) {
    hypotheses.push('Top slice includes high-severity closure gaps; confirm required slot coverage before editing.');
  }
  if (topGapSignals && topGapDeterministic > 0) {
    hypotheses.push('Deterministic gap signals indicate concrete missing links in the top slice.');
  }
  if (exactLookupHits === 0) {
    hypotheses.push('No exact lookup hit; tighten the anchor (symbol/route/permission/query key) to reduce ambiguity.');
  }

  const genericNextActions = [
    'Open top-ranked symbols with context() to inspect incoming/outgoing references.',
    'Use action_plan() to confirm companion files and verification checks before edits.',
    'After edits, run review_mode(scope=unstaged) to validate semantic and closure deltas.',
  ];
  const slicePrecedentAction = topSlice?.uid
    ? 'Compare target slice with precedents() siblings before introducing a new flow shape.'
    : null;

  const topProcessSignal = scoredProcesses
    .slice()
    .sort((left, right) => toFiniteNumber(right.signal?.score, 0) - toFiniteNumber(left.signal?.score, 0))[0] || null;
  const finalProcesses = rankedProcesses.slice(0, limitProcesses);
  const finalSlices = rankedSlices.slice(0, limitSlices);

  const processReadinessById = new Map<string, {
    score: number;
    level: 'high' | 'medium' | 'low';
    reasons: string[];
    convergence: {
      score: number;
      cluster: string;
      signature: string;
      route: string;
    } | null;
    symbol_count: number;
  }>();
  for (const entry of scoredProcesses) {
    const processId = String(entry?.process?.id || '').trim();
    if (!processId) continue;
    const convergenceScore = clampUnit(toFiniteNumber(entry?.signal?.score, 0));
    const symbolCount = toFiniteNumber(processSymbolCountById.get(processId), 0);
    const symbolCoverage = clampUnit(symbolCount / 8);
    const score = clampPercent((convergenceScore * 78) + (symbolCoverage * 22));
    const reasons: string[] = [];
    if (convergenceScore > 0) reasons.push(`convergence:${Math.round(convergenceScore * 100)}`);
    if (symbolCoverage > 0) reasons.push(`symbol-coverage:${Math.round(symbolCoverage * 100)}`);
    if (entry?.signal?.cluster) reasons.push(`cluster:${String(entry.signal.cluster)}`);
    if (entry?.signal?.signature) reasons.push(`signature:${String(entry.signal.signature)}`);
    processReadinessById.set(processId, {
      score: round3(score),
      level: readinessLevel(score),
      reasons: reasons.slice(0, 5),
      convergence: entry?.signal
        ? {
            score: round3(convergenceScore),
            cluster: String(entry.signal.cluster || ''),
            signature: String(entry.signal.signature || ''),
            route: String(entry.signal.route || ''),
          }
        : null,
      symbol_count: symbolCount,
    });
  }

  const sliceReadinessByUid = new Map<string, {
    score: number;
    level: 'high' | 'medium' | 'low';
    reasons: string[];
    convergence: {
      score: number;
      cluster: string;
      signature: string;
      route: string;
    } | null;
    closure_score: number;
    member_count: number;
    gap_penalty: number;
  }>();
  for (const entry of scoredSlices) {
    const sliceUid = String(entry?.slice?.uid || '').trim();
    if (!sliceUid) continue;
    const sliceItem = entry?.slice || {};
    const convergenceScore = clampUnit(toFiniteNumber(entry?.signal?.score, 0));
    const closureScore = clampUnit(toFiniteNumber(sliceItem?.closure_score, 0));
    const memberCount = Math.max(0, toFiniteNumber(sliceItem?.member_count, 0) || (Array.isArray(sliceItem?.matched_members) ? sliceItem.matched_members.length : 0));
    const memberCoverage = clampUnit(memberCount / 5);
    const gapSignals = sliceItem?.gap_signals || {};
    const gapPenalty = clampPercent(
      (toFiniteNumber(gapSignals?.high, 0) * 14)
      + (toFiniteNumber(gapSignals?.deterministic, 0) * 9)
      + (toFiniteNumber(gapSignals?.pattern, 0) * 4)
      + (toFiniteNumber(gapSignals?.heuristic, 0) * 2),
    );
    const score = clampPercent(
      (convergenceScore * 62)
      + (closureScore * 24)
      + (memberCoverage * 20)
      - (gapPenalty * 0.5),
    );
    const reasons: string[] = [];
    if (convergenceScore > 0) reasons.push(`convergence:${Math.round(convergenceScore * 100)}`);
    if (closureScore > 0) reasons.push(`closure:${Math.round(closureScore * 100)}`);
    if (memberCoverage > 0) reasons.push(`members:${memberCount}`);
    if (gapPenalty > 0) reasons.push(`gap-penalty:${Math.round(gapPenalty)}`);
    if (entry?.signal?.cluster) reasons.push(`cluster:${String(entry.signal.cluster)}`);
    sliceReadinessByUid.set(sliceUid, {
      score: round3(score),
      level: readinessLevel(score),
      reasons: reasons.slice(0, 6),
      convergence: entry?.signal
        ? {
            score: round3(convergenceScore),
            cluster: String(entry.signal.cluster || ''),
            signature: String(entry.signal.signature || ''),
            route: String(entry.signal.route || ''),
          }
        : null,
      closure_score: round3(closureScore),
      member_count: memberCount,
      gap_penalty: round3(gapPenalty),
    });
  }

  const processesWithReadiness = finalProcesses.map((processItem: any) => {
    const processId = String(processItem?.id || '').trim();
    const readiness = processReadinessById.get(processId);
    return readiness
      ? { ...processItem, carbon_copy_ready: readiness }
      : processItem;
  });

  const slicesWithReadiness = finalSlices.map((sliceItem: any) => {
    const sliceUid = String(sliceItem?.uid || '').trim();
    const readiness = sliceReadinessByUid.get(sliceUid);
    return readiness
      ? { ...sliceItem, carbon_copy_ready: readiness }
      : sliceItem;
  });

  const processRankById = new Map<string, number>();
  for (let idx = 0; idx < processesWithReadiness.length; idx += 1) {
    const processId = String(processesWithReadiness[idx]?.id || '').trim();
    if (!processId || processRankById.has(processId)) continue;
    processRankById.set(processId, idx);
  }

  const sliceSignalByFilePath = new Map<string, {
    uid: string;
    label: string;
    rank: number;
    score: number;
    readiness: number;
    convergence: number;
  }>();
  for (let idx = 0; idx < slicesWithReadiness.length; idx += 1) {
    const sliceItem = slicesWithReadiness[idx] || {};
    const sliceUid = String(sliceItem?.uid || '').trim();
    const sliceLabel = String(sliceItem?.label || sliceUid).trim();
    const members = Array.isArray(sliceItem?.matched_members) ? sliceItem.matched_members : [];
    const rankSignal = clampUnit(
      (slicesWithReadiness.length - idx) / Math.max(1, slicesWithReadiness.length),
    );
    const readinessSignal = clampUnit(toFiniteNumber(sliceItem?.carbon_copy_ready?.score, 0) / 100);
    const convergenceSignal = clampUnit(toFiniteNumber(sliceItem?.carbon_copy_ready?.convergence?.score, 0));
    const score = clampUnit((rankSignal * 0.45) + (readinessSignal * 0.55));
    for (const member of members) {
      const filePath = toRepoRelativePath(member?.filePath, repo.repoPath);
      if (!filePath) continue;
      const existing = sliceSignalByFilePath.get(filePath);
      if (!existing || score > existing.score) {
        sliceSignalByFilePath.set(filePath, {
          uid: sliceUid,
          label: sliceLabel,
          rank: idx,
          score: round3(score),
          readiness: round3(readinessSignal),
          convergence: round3(convergenceSignal),
        });
      }
    }
  }

  const symbolCandidates = [
    ...processSymbols.map((symbol: any, sourceIndex: number) => ({ symbol, sourceIndex })),
    ...definitions.map((symbol: any, sourceIndex: number) => ({ symbol, sourceIndex: sourceIndex + processSymbols.length })),
  ];
  const symbolOrderBefore = symbolCandidates
    .slice(0, maxSymbols)
    .map((entry: any) => String(entry?.symbol?.uid || entry?.symbol?.id || `${String(entry?.symbol?.name || '')}:${entry?.sourceIndex}`));

  const scoredSymbols = symbolCandidates.map((entry: any) => {
    const symbol = entry?.symbol || {};
    const processId = String(symbol?.process_id || '').trim();
    const filePath = toRepoRelativePath(symbol?.filePath, repo.repoPath);
    const processRank = processRankById.get(processId);
    const processRankSignal = processRank === undefined
      ? 0
      : clampUnit((processesWithReadiness.length - processRank) / Math.max(1, processesWithReadiness.length));
    const processReadinessSignal = clampUnit(toFiniteNumber(processReadinessById.get(processId)?.score, 0) / 100);
    const processConvergenceSignal = clampUnit(toFiniteNumber(processReadinessById.get(processId)?.convergence?.score, 0));

    const sliceSignal = sliceSignalByFilePath.get(filePath);
    const sliceRankSignal = sliceSignal ? clampUnit((slicesWithReadiness.length - sliceSignal.rank) / Math.max(1, slicesWithReadiness.length)) : 0;
    const sliceReadinessSignal = sliceSignal ? clampUnit(sliceSignal.readiness) : 0;
    const sliceConvergenceSignal = sliceSignal ? clampUnit(sliceSignal.convergence) : 0;
    const readinessSignal = Math.max(processReadinessSignal, sliceReadinessSignal);
    const symbolTokenSet = new Set<string>([
      ...tokenize(symbol?.name || ''),
      ...tokenize(symbol?.kind || symbol?.type || ''),
      ...tokenize(filePath),
      ...tokenize(processId),
    ]);
    const lexicalOverlap = queryTokenSet.size > 0
      ? overlapCount(queryTokenSet, symbolTokenSet)
      : 0;
    const lexicalSignal = lexicalOverlap > 0
      ? clampUnit(lexicalOverlap / Math.max(1, Math.min(queryTokenSet.size, 6)))
      : 0;
    const convergenceSignal = clampUnit(Math.max(
      processConvergenceSignal,
      sliceConvergenceSignal,
      readinessSignal * 0.65,
      lexicalSignal * 0.45,
    ));
    const sourceBoost = processId ? QUERY_SYMBOL_RANK_WEIGHTS.process_source_boost : 0;
    const lexicalFloor = lexicalSignal > 0 ? QUERY_SYMBOL_RANK_WEIGHTS.lexical_floor : 0;
    const score = clampUnit(
      (readinessSignal * QUERY_SYMBOL_RANK_WEIGHTS.readiness)
      + (processRankSignal * QUERY_SYMBOL_RANK_WEIGHTS.process_rank)
      + (sliceRankSignal * QUERY_SYMBOL_RANK_WEIGHTS.slice_rank)
      + (lexicalSignal * QUERY_SYMBOL_RANK_WEIGHTS.lexical)
      + sourceBoost
      + lexicalFloor,
    );

    const reasons: string[] = [];
    if (readinessSignal > 0) reasons.push(`readiness:${Math.round(readinessSignal * 100)}`);
    if (processRank !== undefined) reasons.push(`process-rank:${processRank + 1}`);
    if (sliceSignal?.uid) reasons.push(`slice:${sliceSignal.uid}`);
    if (lexicalSignal > 0) reasons.push(`lexical:${Math.round(lexicalSignal * 100)}`);
    if (convergenceSignal > 0) reasons.push(`convergence:${Math.round(convergenceSignal * 100)}`);
    if (processId) reasons.push(`process:${processId}`);

    const hintScore = clampPercent(score * 100);
    return {
      symbol,
      sourceIndex: toFiniteNumber(entry?.sourceIndex, 0),
      score: round3(score),
      hint: {
        score: round3(hintScore),
        level: readinessLevel(hintScore),
        reasons: reasons.slice(0, 6),
        convergence: round3(convergenceSignal),
        ...(processId ? { process_id: processId } : {}),
        ...(sliceSignal?.uid ? { slice_uid: sliceSignal.uid, slice_label: sliceSignal.label } : {}),
      },
    };
  });

  const topSymbolSignal = scoredSymbols
    .slice()
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.sourceIndex - right.sourceIndex;
    })
    .find(entry => toFiniteNumber(entry?.hint?.score, 0) > 0) || null;

  const symbols = scoredSymbols
    .slice()
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.sourceIndex - right.sourceIndex;
    })
    .slice(0, maxSymbols)
    .map(entry => {
      if (!entry?.hint || toFiniteNumber(entry.hint?.score, 0) <= 0) return entry.symbol;
      return {
        ...entry.symbol,
        carbon_copy_hint: entry.hint,
      };
    });
  const symbolOrderAfter = symbols
    .map((symbol: any, index: number) => String(symbol?.uid || symbol?.id || `${String(symbol?.name || '')}:${index}`));
  const boostedSymbolCount = scoredSymbols
    .filter(entry => toFiniteNumber(entry?.hint?.score, 0) > 0)
    .length;

  const processOrderBefore = processCandidates.slice(0, limitProcesses).map((processItem: any) => String(processItem?.id || ''));
  const processOrderAfter = finalProcesses.map((processItem: any) => String(processItem?.id || ''));
  const sliceOrderBefore = sliceCandidates.slice(0, limitSlices).map((sliceItem: any) => String(sliceItem?.uid || ''));
  const sliceOrderAfter = finalSlices.map((sliceItem: any) => String(sliceItem?.uid || ''));

  const boostedProcessCount = scoredProcesses.filter(entry => toFiniteNumber(entry.signal?.score, 0) > 0).length;
  const boostedSliceCount = scoredSlices.filter(entry => toFiniteNumber(entry.signal?.score, 0) > 0).length;

  const topSliceSignal = scoredSlices
    .slice()
    .sort((left, right) => toFiniteNumber(right.signal?.score, 0) - toFiniteNumber(left.signal?.score, 0))
    .map(entry => entry.signal)
    .find(signal => toFiniteNumber(signal?.score, 0) > 0) || null;

  const topProcessCarbon = processesWithReadiness
    .map((processItem: any) => ({
      type: 'process' as const,
      id: String(processItem?.id || ''),
      label: String(processItem?.summary || processItem?.id || ''),
      readiness: processItem?.carbon_copy_ready || null,
    }))
    .filter(item => item.readiness && toFiniteNumber(item.readiness?.score, 0) > 0)
    .sort((left, right) => toFiniteNumber(right.readiness?.score, 0) - toFiniteNumber(left.readiness?.score, 0))[0] || null;
  const topSliceCarbon = slicesWithReadiness
    .map((sliceItem: any) => ({
      type: 'slice' as const,
      id: String(sliceItem?.uid || ''),
      label: String(sliceItem?.label || sliceItem?.uid || ''),
      readiness: sliceItem?.carbon_copy_ready || null,
    }))
    .filter(item => item.readiness && toFiniteNumber(item.readiness?.score, 0) > 0)
    .sort((left, right) => toFiniteNumber(right.readiness?.score, 0) - toFiniteNumber(left.readiness?.score, 0))[0] || null;
  const topCarbonCopy = [topSliceCarbon, topProcessCarbon]
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => toFiniteNumber(right.readiness?.score, 0) - toFiniteNumber(left.readiness?.score, 0))[0] || null;
  type QueryNextActionCandidate = {
    source: 'symbol' | 'carbon_anchor' | 'process';
    candidate_origin:
      | 'symbol_threshold'
      | 'carbon_threshold'
      | 'process_threshold'
      | 'action_hint_hop'
      | 'fallback_symbol'
      | 'fallback_carbon'
      | 'fallback_process';
    reason_code: string;
    label: string;
    score: number;
    convergence: number;
    confidence: number;
    rank_score: number;
    action: string;
  };
  const topActionHintHop = actionHintHops
    .slice()
    .sort((left, right) => toFiniteNumber(right?.http?.confidence, 0) - toFiniteNumber(left?.http?.confidence, 0))
    .find(hop => toFiniteNumber(hop?.http?.confidence, 0) > 0) || null;
  const topActionHintConfidence = clampUnit(toFiniteNumber(topActionHintHop?.http?.confidence, 0));
  const retrievalSignal = clampUnit(Math.max(
    toFiniteNumber(topSymbolSignal?.hint?.score, 0) / 100,
    toFiniteNumber(topCarbonCopy?.readiness?.score, 0) / 100,
    toFiniteNumber(topProcessSignal?.signal?.score, 0),
    toFiniteNumber(topSliceSignal?.score, 0),
    topActionHintConfidence,
  ));
  const symbolGateFloor = round3(computeAdaptiveGate(
    QUERY_NEXT_ACTION_GATES.symbol_base,
    QUERY_NEXT_ACTION_GATES.symbol_floor,
    retrievalSignal,
  ));
  const carbonGateFloor = round3(computeAdaptiveGate(
    QUERY_NEXT_ACTION_GATES.carbon_base,
    QUERY_NEXT_ACTION_GATES.carbon_floor,
    retrievalSignal,
  ));
  const processGateFloor = round3(computeAdaptiveGate(
    QUERY_NEXT_ACTION_GATES.process_base,
    QUERY_NEXT_ACTION_GATES.process_floor,
    retrievalSignal,
  ));
  const computeNextActionRank = (score: number, convergence: number, confidence: number): number => round3(
    (clampUnit(score) * QUERY_NEXT_ACTION_RANK_WEIGHTS.score)
    + (clampUnit(convergence) * QUERY_NEXT_ACTION_RANK_WEIGHTS.convergence)
    + (clampUnit(confidence) * QUERY_NEXT_ACTION_RANK_WEIGHTS.confidence),
  );
  const nextActionCandidates: QueryNextActionCandidate[] = [];
  const addNextActionCandidate = (candidate: Omit<QueryNextActionCandidate, 'rank_score'>): void => {
    nextActionCandidates.push({
      ...candidate,
      rank_score: computeNextActionRank(candidate.score, candidate.convergence, candidate.confidence),
    });
  };
  const topSymbolScore = clampUnit(toFiniteNumber(topSymbolSignal?.hint?.score, 0) / 100);
  const topSymbolConvergence = clampUnit(toFiniteNumber(topSymbolSignal?.hint?.convergence, 0));
  const topCarbonScore = clampUnit(toFiniteNumber(topCarbonCopy?.readiness?.score, 0) / 100);
  const topCarbonConvergence = clampUnit(toFiniteNumber(topCarbonCopy?.readiness?.convergence?.score, 0));
  const topProcessScore = clampUnit(toFiniteNumber(topProcessSignal?.signal?.score, 0));
  const topProcessConvergence = topProcessScore;
  const symbolGatePassed = Boolean(topSymbolSignal && (toFiniteNumber(topSymbolSignal?.hint?.score, 0) >= symbolGateFloor));
  const carbonGatePassed = Boolean(topCarbonCopy && (toFiniteNumber(topCarbonCopy?.readiness?.score, 0) >= carbonGateFloor));
  const processGatePassed = Boolean(topProcessSignal && (toFiniteNumber(topProcessSignal?.signal?.score, 0) >= processGateFloor));
  if (symbolGatePassed && topSymbolSignal) {
    const topSymbolName = String(topSymbolSignal?.symbol?.name || topSymbolSignal?.symbol?.uid || 'top symbol');
    const confidence = clampUnit((topSymbolScore * 0.62) + (topSymbolConvergence * 0.38));
    addNextActionCandidate({
      source: 'symbol',
      candidate_origin: 'symbol_threshold',
      reason_code: 'symbol_passed_adaptive_gate',
      label: topSymbolName,
      score: round3(topSymbolScore),
      convergence: round3(topSymbolConvergence),
      confidence: round3(confidence),
      action: `Open carbon-copy symbol "${topSymbolName}" first (score ${Math.round(toFiniteNumber(topSymbolSignal?.hint?.score, 0))}).`,
    });
  }
  if (carbonGatePassed && topCarbonCopy) {
    const confidence = clampUnit((topCarbonScore * 0.56) + (topCarbonConvergence * 0.44));
    addNextActionCandidate({
      source: 'carbon_anchor',
      candidate_origin: 'carbon_threshold',
      reason_code: 'carbon_anchor_passed_adaptive_gate',
      label: `${topCarbonCopy.type}:${topCarbonCopy.label}`,
      score: round3(topCarbonScore),
      convergence: round3(topCarbonConvergence),
      confidence: round3(confidence),
      action: `Carbon-copy anchor: ${topCarbonCopy.type} "${topCarbonCopy.label}" (score ${Math.round(toFiniteNumber(topCarbonCopy.readiness?.score, 0))}).`,
    });
  }
  if (processGatePassed && topProcessSignal) {
    const processSummary = String(topProcessSignal.process?.summary || topProcessSignal.process?.id || 'top process');
    const confidence = clampUnit((topProcessScore * 0.45) + (topProcessConvergence * 0.55));
    addNextActionCandidate({
      source: 'process',
      candidate_origin: 'process_threshold',
      reason_code: 'process_passed_adaptive_gate',
      label: processSummary,
      score: round3(topProcessScore),
      convergence: round3(topProcessConvergence),
      confidence: round3(confidence),
      action: `Start with converged process "${processSummary}" (alignment ${Math.round(topProcessScore * 100)}) to mirror strongest in-repo anatomy.`,
    });
  }
  if (topActionHintHop) {
    const hopRoute = String(topActionHintHop?.http?.reason || topActionHintHop?.endpoint?.name || '').trim();
    const hopUi = String(topActionHintHop?.ui?.name || topActionHintHop?.ui?.uid || 'ui').trim();
    const hopController = String(topActionHintHop?.controller?.name || topActionHintHop?.controller?.uid || 'controller').trim();
    const score = clampUnit((topActionHintConfidence * 0.62) + (retrievalSignal * 0.38));
    const convergence = clampUnit(Math.max(topProcessScore, topActionHintConfidence * 0.85));
    const confidence = clampUnit((topActionHintConfidence * 0.7) + (score * 0.3));
    addNextActionCandidate({
      source: 'process',
      candidate_origin: 'action_hint_hop',
      reason_code: 'action_hint_hop_available',
      label: hopRoute || `hop:${hopController}`,
      score: round3(score),
      convergence: round3(convergence),
      confidence: round3(confidence),
      action: `Follow top HTTP hop "${hopRoute || 'route'}" (${hopUi} -> ${hopController}) first (confidence ${Math.round(topActionHintConfidence * 100)}).`,
    });
  }
  let nextActionCoverageReason = 'ranked_candidate_available';
  let fallbackUsed = false;
  if (nextActionCandidates.length === 0) {
    fallbackUsed = true;
    if (topSymbolSignal) {
      const topSymbolName = String(topSymbolSignal?.symbol?.name || topSymbolSignal?.symbol?.uid || 'top symbol');
      const score = clampUnit(Math.max(topSymbolScore, 0.18));
      const convergence = clampUnit(Math.max(topSymbolConvergence, retrievalSignal * 0.45));
      const confidence = clampUnit(Math.max(0.35, (score * 0.58) + (convergence * 0.42)));
      addNextActionCandidate({
        source: 'symbol',
        candidate_origin: 'fallback_symbol',
        reason_code: 'below_adaptive_gate_fallback_symbol',
        label: topSymbolName,
        score: round3(score),
        convergence: round3(convergence),
        confidence: round3(confidence),
        action: `Open top lexical symbol "${topSymbolName}" first (fallback path).`,
      });
      nextActionCoverageReason = 'fallback_symbol';
    } else if (topCarbonCopy) {
      const score = clampUnit(Math.max(topCarbonScore, 0.2));
      const convergence = clampUnit(Math.max(topCarbonConvergence, retrievalSignal * 0.5));
      const confidence = clampUnit(Math.max(0.34, (score * 0.6) + (convergence * 0.4)));
      addNextActionCandidate({
        source: 'carbon_anchor',
        candidate_origin: 'fallback_carbon',
        reason_code: 'below_adaptive_gate_fallback_carbon',
        label: `${topCarbonCopy.type}:${topCarbonCopy.label}`,
        score: round3(score),
        convergence: round3(convergence),
        confidence: round3(confidence),
        action: `Start from top carbon-copy anchor "${topCarbonCopy.label}" (fallback path).`,
      });
      nextActionCoverageReason = 'fallback_carbon';
    } else if (topProcessSignal) {
      const processSummary = String(topProcessSignal.process?.summary || topProcessSignal.process?.id || 'top process');
      const score = clampUnit(Math.max(topProcessScore, 0.2));
      const convergence = clampUnit(Math.max(topProcessConvergence, retrievalSignal * 0.5));
      const confidence = clampUnit(Math.max(0.33, (score * 0.52) + (convergence * 0.48)));
      addNextActionCandidate({
        source: 'process',
        candidate_origin: 'fallback_process',
        reason_code: 'below_adaptive_gate_fallback_process',
        label: processSummary,
        score: round3(score),
        convergence: round3(convergence),
        confidence: round3(confidence),
        action: `Start from top process "${processSummary}" (fallback path).`,
      });
      nextActionCoverageReason = 'fallback_process';
    } else if (symbols.length > 0) {
      const firstSymbol = symbols[0] || {};
      const firstSymbolName = String(firstSymbol?.name || firstSymbol?.uid || 'top symbol');
      const score = clampUnit(Math.max(toFiniteNumber(firstSymbol?.carbon_copy_hint?.score, 0) / 100, 0.16));
      const convergence = clampUnit(Math.max(toFiniteNumber(firstSymbol?.carbon_copy_hint?.convergence, 0), 0.12));
      const confidence = clampUnit(Math.max(0.32, (score * 0.6) + (convergence * 0.4)));
      addNextActionCandidate({
        source: 'symbol',
        candidate_origin: 'fallback_symbol',
        reason_code: 'no_ranked_candidates_fallback_symbol_list',
        label: firstSymbolName,
        score: round3(score),
        convergence: round3(convergence),
        confidence: round3(confidence),
        action: `Open top returned symbol "${firstSymbolName}" first (fallback path).`,
      });
      nextActionCoverageReason = 'fallback_symbol_list';
    } else {
      nextActionCoverageReason = 'no_candidates_available';
    }
  }
  const prioritizedNextAction = nextActionCandidates
    .slice()
    .sort((left, right) => {
      if (right.rank_score !== left.rank_score) return right.rank_score - left.rank_score;
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      if (right.convergence !== left.convergence) return right.convergence - left.convergence;
      if (right.score !== left.score) return right.score - left.score;
      return left.label.localeCompare(right.label);
    })[0] || null;
  const nextActions = [
    ...(prioritizedNextAction?.action ? [prioritizedNextAction.action] : []),
    ...(slicePrecedentAction ? [slicePrecedentAction] : []),
    ...genericNextActions,
  ];

  const convergenceMeta = {
    enabled: Boolean(convergenceMatrix),
    source_path: convergenceMatrix?.sourcePath || null,
    matrix_cells: Array.isArray(convergenceMatrix?.cells) ? convergenceMatrix!.cells.length : 0,
    processes_boosted: boostedProcessCount,
    slices_boosted: boostedSliceCount,
    symbols_boosted: boostedSymbolCount,
    process_reordered: processOrderBefore.join('|') !== processOrderAfter.join('|'),
    slice_reordered: sliceOrderBefore.join('|') !== sliceOrderAfter.join('|'),
    symbol_reordered: symbolOrderBefore.join('|') !== symbolOrderAfter.join('|'),
    top_process_signal: topProcessSignal?.signal
      ? {
          score: round3(toFiniteNumber(topProcessSignal.signal.score, 0)),
          cluster: topProcessSignal.signal.cluster || '',
          signature: topProcessSignal.signal.signature || '',
          route: topProcessSignal.signal.route || '',
        }
      : null,
    top_slice_signal: topSliceSignal
      ? {
          score: round3(toFiniteNumber(topSliceSignal.score, 0)),
          cluster: topSliceSignal.cluster || '',
          signature: topSliceSignal.signature || '',
          route: topSliceSignal.route || '',
        }
      : null,
    top_symbol_signal: topSymbolSignal
      ? {
          name: String(topSymbolSignal?.symbol?.name || topSymbolSignal?.symbol?.uid || ''),
          filePath: String(topSymbolSignal?.symbol?.filePath || ''),
          score: round3(toFiniteNumber(topSymbolSignal?.hint?.score, 0)),
          level: String(topSymbolSignal?.hint?.level || readinessLevel(toFiniteNumber(topSymbolSignal?.hint?.score, 0))),
          reasons: Array.isArray(topSymbolSignal?.hint?.reasons) ? topSymbolSignal.hint.reasons.slice(0, 6) : [],
        }
      : null,
    symbol_ranking_weights: QUERY_SYMBOL_RANK_WEIGHTS,
    top_carbon_copy: topCarbonCopy
      ? {
          type: topCarbonCopy.type,
          id: topCarbonCopy.id,
          label: topCarbonCopy.label,
          score: round3(toFiniteNumber(topCarbonCopy.readiness?.score, 0)),
          level: String(topCarbonCopy.readiness?.level || readinessLevel(toFiniteNumber(topCarbonCopy.readiness?.score, 0))),
        }
      : null,
    next_action_gates: {
      retrieval_signal: round3(retrievalSignal),
      symbol_floor: round3(symbolGateFloor),
      carbon_floor: round3(carbonGateFloor),
      process_floor: round3(processGateFloor),
      symbol_passed: symbolGatePassed,
      carbon_passed: carbonGatePassed,
      process_passed: processGatePassed,
      hint_hop_available: Boolean(topActionHintHop),
    },
    first_action_coverage: {
      prioritized_action_present: Boolean(prioritizedNextAction),
      fallback_used: fallbackUsed,
      reason_code: nextActionCoverageReason,
    },
    next_action_ranking_weights: QUERY_NEXT_ACTION_RANK_WEIGHTS,
    prioritized_next_action: prioritizedNextAction
      ? {
          source: prioritizedNextAction.source,
          candidate_origin: prioritizedNextAction.candidate_origin,
          reason_code: prioritizedNextAction.reason_code,
          label: prioritizedNextAction.label,
          score: prioritizedNextAction.score,
          convergence: prioritizedNextAction.convergence,
          confidence: prioritizedNextAction.confidence,
          rank_score: prioritizedNextAction.rank_score,
          action: prioritizedNextAction.action,
        }
      : null,
  };

  return {
    status: 'ok',
    repo: repo.name,
    query: queryText,
    query_mode: {
      query_plan: queryResult?.query_plan || null,
      slices: slicesWithReadiness,
      processes: processesWithReadiness,
      symbols,
      precedents: Array.isArray(precedentPack?.precedents)
        ? precedentPack.precedents.slice(0, limitPrecedents)
        : [],
      action_hints: includeActionHints
        ? {
            files: actionHintFiles,
            checks: actionHintChecks,
            hops: actionHintHops,
          }
        : null,
      hypotheses: Array.from(new Set(hypotheses)).slice(0, 6),
      next_actions: nextActions,
      carbon_copy_ready: topCarbonCopy
        ? {
            score: round3(toFiniteNumber(topCarbonCopy.readiness?.score, 0)),
            level: String(topCarbonCopy.readiness?.level || readinessLevel(toFiniteNumber(topCarbonCopy.readiness?.score, 0))),
            anchor_type: topCarbonCopy.type,
            anchor_id: topCarbonCopy.id,
            anchor_label: topCarbonCopy.label,
            reasons: Array.isArray(topCarbonCopy.readiness?.reasons) ? topCarbonCopy.readiness.reasons.slice(0, 6) : [],
            convergence: topCarbonCopy.readiness?.convergence || null,
          }
        : null,
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
      convergence: convergenceMeta,
    },
  };
}
