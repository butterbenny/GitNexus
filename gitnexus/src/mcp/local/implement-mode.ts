import path from 'node:path';
import { deriveLayerTag } from '../../core/derived/archetypes.js';

export interface ImplementModeRepoHandle {
  id: string;
  name: string;
  repoPath: string;
}

export interface ImplementModeParams {
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
}

type ImplementModeDeps = {
  actionPlan: (repo: ImplementModeRepoHandle, params: any) => Promise<any>;
  precedents: (repo: ImplementModeRepoHandle, params: any) => Promise<any>;
  queryMode: (repo: ImplementModeRepoHandle, params: any) => Promise<any>;
  getIndexStatus: (repo: ImplementModeRepoHandle) => Promise<any>;
  parsePathPrefixes: (repoPath: string, param: unknown) => string[];
  clampInteger: (value: unknown, fallback: number, min?: number, max?: number) => number;
  normalizeRepoRelativePath: (value: string) => string;
  toFiniteNumber: (value: unknown, fallback?: number) => number;
};

const toOptionalLineNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = Math.floor(parsed);
  if (normalized <= 0) return undefined;
  return normalized;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const IMPLEMENT_RANK_WEIGHTS = {
  write_plan: {
    convergence: 1,
    carbon: 1.25,
    precedent_bonus: 0.18,
  },
  companion: {
    base: 1,
    convergence: 0.95,
    carbon: 1.05,
    precedent_bonus: 0.12,
  },
  carbon: {
    convergence: 42,
    precedent: 44,
    base: 14,
  },
  plan_carbon: {
    companion_avg: 0.28,
    write_plan_avg: 0.3,
    companion_precedent_coverage: 0.16,
    write_plan_precedent_coverage: 0.16,
    query_head_signal: 0.1,
  },
} as const;
const IMPLEMENT_NEXT_ACTION_RANK_WEIGHTS = {
  rank_score: 0.62,
  convergence: 0.22,
  carbon: 0.16,
} as const;
const IMPLEMENT_DIRECT_PRECEDENT_CALIBRATION_BONUS = {
  companion: 18,
  write_plan: 4.5,
} as const;
const DIRECT_IMPLEMENT_PRECEDENT_KINDS = new Set([
  'ui-behavior',
  'backend-behavior',
  'backend-handoff',
  'pattern-catalog',
  'slice',
  'hop',
  'process',
]);
const DIRECT_IMPLEMENT_PRECEDENT_BASE_SCORES: Record<string, number> = {
  'ui-behavior': 1.08,
  'backend-handoff': 1.04,
  'backend-behavior': 1.02,
  'pattern-catalog': 0.96,
  slice: 0.9,
  hop: 0.88,
  process: 0.86,
};
const GENERIC_IMPLEMENT_TARGET_PATTERNS = [
  /^pattern-catalog:/i,
  /\bpermission\b/i,
  /\bendpoint\b/i,
  /\bcontroller\b/i,
  /\broute\b/i,
  /\bcombobox\b/i,
];

export async function runImplementMode(
  deps: ImplementModeDeps,
  repo: ImplementModeRepoHandle,
  params: ImplementModeParams,
): Promise<any> {
  const {
    actionPlan,
    precedents: loadPrecedents,
    queryMode,
    getIndexStatus,
    parsePathPrefixes,
    clampInteger,
    normalizeRepoRelativePath,
    toFiniteNumber,
  } = deps;
  const queryText = String(params.query || '').trim();
  if (!queryText) {
    return { error: 'query parameter is required and cannot be empty.' };
  }

  const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
  const limitFiles = clampInteger(params.limit_files, 10, 1, 30);
  const limitChecks = clampInteger(params.limit_checks, 10, 1, 20);
  const limitWriteOrder = clampInteger(params.limit_write_order, 10, 1, 20);
  const limitPrecedents = clampInteger(params.limit_precedents, 3, 0, 5);
  const includeQueryHead = params.include_query_head !== false;
  const includeReviewContract = params.include_review_contract !== false;

  const actionPlanResult = await actionPlan(repo, {
    query: queryText,
    task_context: params.task_context,
    goal: params.goal,
    path_prefixes: pathPrefixes,
    limit_files: limitFiles,
    limit_checks: limitChecks,
    __skip_precedents: false,
  });

  if (actionPlanResult?.error) return actionPlanResult;

  let queryModeResult: any = null;
  if (includeQueryHead) {
    const actionPlanHasPrecedents = Array.isArray(actionPlanResult?.implement_plan?.precedents)
      && actionPlanResult.implement_plan.precedents.length > 0;
    const queryHeadIncludePrecedents = !actionPlanHasPrecedents && limitPrecedents > 0;
    try {
      queryModeResult = await queryMode(repo, {
        query: queryText,
        task_context: params.task_context,
        goal: params.goal,
        path_prefixes: pathPrefixes,
        limit_processes: 4,
        max_symbols: 16,
        limit_slices: 2,
        limit_precedents: limitPrecedents,
        limit_hops: 0,
        include_precedents: queryHeadIncludePrecedents,
        include_action_hints: false,
      });
    } catch {
      queryModeResult = null;
    }
  }

  let directPrecedentResult: any = null;
  if (limitPrecedents > 0) {
    try {
      directPrecedentResult = await loadPrecedents(repo, {
        query: queryText,
        path_prefixes: pathPrefixes,
        limit: Math.max(limitPrecedents, 3),
        examples: Math.max(2, Math.min(limitFiles, 4)),
      });
    } catch {
      directPrecedentResult = null;
    }
  }

  const indexStatus = await getIndexStatus(repo);

  const normalizePath = (value: unknown): string => normalizeRepoRelativePath(String(value || ''));
  const pathLayer = (filePath: string): string => deriveLayerTag(normalizePath(filePath));
  const safeNumber = (value: unknown): number => toFiniteNumber(value, 0);
  const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));
  const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));
  const readinessLevel = (score: number): 'high' | 'medium' | 'low' => (
    score >= 75 ? 'high' : score >= 50 ? 'medium' : 'low'
  );

  const implementPlan = actionPlanResult?.implement_plan || {};
  const rawCompanionFiles = Array.isArray(implementPlan?.companion_set?.files)
    ? implementPlan.companion_set.files.slice(0, limitFiles)
    : [];
  const rawWritePlan = Array.isArray(implementPlan?.write_order)
    ? implementPlan.write_order.slice(0, limitWriteOrder)
    : [];

  const precedentsFromPlan = Array.isArray(implementPlan?.precedents)
    ? implementPlan.precedents
    : [];
  const precedentsFromQuery = Array.isArray(queryModeResult?.query_mode?.precedents)
    ? queryModeResult.query_mode.precedents
    : [];
  const directPrecedents = (
    Array.isArray(directPrecedentResult?.precedents)
      ? directPrecedentResult.precedents
      : []
  )
    .filter((precedent: any) => DIRECT_IMPLEMENT_PRECEDENT_KINDS.has(String(precedent?.kind || '').trim()))
    .slice(0, Math.max(limitPrecedents, 3));
  const precedents = Array.from(new Map(
    [
      ...directPrecedents,
      ...(precedentsFromPlan.length > 0 ? precedentsFromPlan : precedentsFromQuery),
    ].map((precedent: any) => {
      const kind = String(precedent?.kind || '').trim();
      const signature = String(precedent?.signature || '').trim();
      const anchorFilePath = normalizePath(precedent?.anchor?.filePath);
      const anchorName = String(precedent?.anchor?.title || precedent?.anchor?.name || '').trim();
      const key = `${kind}|${signature}|${anchorFilePath}|${anchorName}`;
      return [key, precedent];
    }),
  ).values()).slice(0, Math.max(limitPrecedents, directPrecedents.length || limitPrecedents));

  const docGuidanceFromPlan = Array.isArray(implementPlan?.doc_guidance)
    ? implementPlan.doc_guidance
    : [];
  const doc_guidance = docGuidanceFromPlan.slice(0, 4);

  const patternCatalogTemplateCompanions: any[] = (() => {
    const out: any[] = [];
    const seen = new Set<string>();
    const push = (filePathRaw: unknown, score: number) => {
      const filePath = normalizePath(filePathRaw);
      if (!filePath || seen.has(filePath)) return;
      seen.add(filePath);
      out.push({
        filePath,
        score,
        reasons: ['template:pattern-catalog'],
        anchors: [],
      });
    };

    for (const precedent of precedents) {
      if (String(precedent?.kind || '').trim() !== 'pattern-catalog') continue;
      const anchor = precedent?.anchor;
      if (anchor && typeof anchor === 'object') {
        push((anchor as any)?.catalog_path || (anchor as any)?.catalogPath, 0.92);
        push((anchor as any)?.filePath, 0.88);
      }
      const examples = Array.isArray(precedent?.examples) ? precedent.examples : [];
      for (const example of examples.slice(0, 4)) {
        push(example?.filePath, 0.78);
      }
      if (out.length >= 8) break;
    }

    return out.slice(0, 8);
  })();

  const rawChecks = Array.isArray(actionPlanResult?.checks)
    ? actionPlanResult.checks.slice(0, limitChecks)
    : [];
  const hops = Array.isArray(actionPlanResult?.hops)
    ? actionPlanResult.hops.slice(0, 6)
    : [];
  const cacheEffects = Array.isArray(actionPlanResult?.cache_effects)
    ? actionPlanResult.cache_effects.slice(0, 4)
    : [];

  const queryHeadSymbols = Array.isArray(queryModeResult?.query_mode?.symbols)
    ? queryModeResult.query_mode.symbols.slice(0, 16)
    : [];
  const queryHeadSlices = Array.isArray(queryModeResult?.query_mode?.slices)
    ? queryModeResult.query_mode.slices.slice(0, 4)
    : [];
  const queryHeadProcesses = Array.isArray(queryModeResult?.query_mode?.processes)
    ? queryModeResult.query_mode.processes.slice(0, 4)
    : [];
  const actionHintFiles = Array.isArray(actionPlanResult?.files)
    ? actionPlanResult.files.slice(0, limitFiles)
    : [];
  const queryHeadConvergence = (
    queryModeResult?._query_mode?.convergence
    && typeof queryModeResult._query_mode.convergence === 'object'
  )
    ? queryModeResult._query_mode.convergence
    : null;
  const convergenceEnabled = Boolean(queryHeadConvergence?.enabled);

  const processRankById = new Map<string, number>();
  for (let idx = 0; idx < queryHeadProcesses.length; idx += 1) {
    const processId = String(queryHeadProcesses[idx]?.id || '').trim();
    if (!processId || processRankById.has(processId)) continue;
    processRankById.set(processId, idx);
  }

  const processFileRank = new Map<string, number>();
  for (const symbol of queryHeadSymbols) {
    const processId = String(symbol?.process_id || '').trim();
    const filePath = normalizePath(symbol?.filePath);
    if (!processId || !filePath) continue;
    const processRank = processRankById.get(processId);
    if (processRank === undefined) continue;
    const existing = processFileRank.get(filePath);
    if (existing === undefined || processRank < existing) {
      processFileRank.set(filePath, processRank);
    }
  }

  const sliceFileRank = new Map<string, number>();
  const topSliceSeedFiles = new Set<string>();
  for (let idx = 0; idx < queryHeadSlices.length; idx += 1) {
    const members = Array.isArray(queryHeadSlices[idx]?.matched_members) ? queryHeadSlices[idx].matched_members : [];
    for (const member of members) {
      const filePath = normalizePath(member?.filePath);
      if (!filePath) continue;
      const existing = sliceFileRank.get(filePath);
      if (existing === undefined || idx < existing) {
        sliceFileRank.set(filePath, idx);
      }
      if (idx === 0) topSliceSeedFiles.add(filePath);
    }
  }

  const sharesTopSliceDirectory = (filePath: string): boolean => {
    const normalized = normalizePath(filePath);
    if (!normalized || topSliceSeedFiles.size === 0) return false;
    const dir = path.dirname(normalized);
    for (const seedPath of topSliceSeedFiles) {
      if (path.dirname(seedPath) === dir) return true;
    }
    return false;
  };

  const convergenceBoostForFile = (filePath: string): { boost: number; reasons: string[] } => {
    if (!convergenceEnabled) return { boost: 0, reasons: [] };

    const normalized = normalizePath(filePath);
    if (!normalized) return { boost: 0, reasons: [] };

    let boost = 0;
    const reasons: string[] = [];

    const sliceRank = sliceFileRank.get(normalized);
    if (sliceRank !== undefined) {
      const delta = Math.max(0, 1.4 - (sliceRank * 0.3));
      boost += delta;
      reasons.push(`slice-rank:${sliceRank + 1}`);
    }

    const processRank = processFileRank.get(normalized);
    if (processRank !== undefined) {
      const delta = Math.max(0, 1.2 - (processRank * 0.25));
      boost += delta;
      reasons.push(`process-rank:${processRank + 1}`);
    }

    if (reasons.length === 0 && sharesTopSliceDirectory(normalized)) {
      boost += 0.18;
      reasons.push('same-dir:top-slice');
    }

    return {
      boost: round3(boost),
      reasons,
    };
  };

  const fallbackCompanionFiles: any[] = [];
  const fallbackCompanionSeen = new Set<string>();
  for (const item of actionHintFiles) {
    const filePath = normalizePath(item?.filePath);
    if (!filePath || fallbackCompanionSeen.has(filePath)) continue;
    fallbackCompanionSeen.add(filePath);
    fallbackCompanionFiles.push({
      filePath,
      score: safeNumber(item?.score ?? 0.2),
      reasons: Array.isArray(item?.reasons) ? item.reasons.slice(0, 4) : ['fallback:action_plan.files'],
      anchors: Array.isArray(item?.anchors) ? item.anchors.slice(0, 4) : [],
    });
    if (fallbackCompanionFiles.length >= limitFiles) break;
  }
  if (fallbackCompanionFiles.length === 0) {
    for (const symbol of queryHeadSymbols) {
      const filePath = normalizePath(symbol?.filePath);
      if (!filePath || fallbackCompanionSeen.has(filePath)) continue;
      fallbackCompanionSeen.add(filePath);
      fallbackCompanionFiles.push({
        filePath,
        score: 0.15,
        reasons: ['fallback:query_head.symbols'],
        anchors: [{
          id: symbol?.uid || symbol?.id,
          name: symbol?.name || '',
          type: symbol?.kind || symbol?.type || '',
          startLine: symbol?.startLine,
          endLine: symbol?.endLine,
        }],
      });
      if (fallbackCompanionFiles.length >= limitFiles) break;
    }
  }
  const usedFallbackCompanion = rawCompanionFiles.length === 0 && fallbackCompanionFiles.length > 0;
  const baseCompanionFiles = rawCompanionFiles.length > 0 ? rawCompanionFiles : fallbackCompanionFiles;
  const dedupeCompanionFiles = (items: any[]): any[] => {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const filePath = normalizePath(item?.filePath);
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      out.push({ ...item, filePath });
    }
    return out;
  };

  const buildDirectPrecedentCompanionFiles = (items: any[]): any[] => {
    const out: any[] = [];
    const seen = new Set<string>();
    const pushNode = (precedent: any, node: any, source: string, scoreOffset = 0): void => {
      const kind = String(precedent?.kind || '').trim();
      const filePath = normalizePath(node?.filePath);
      if (!filePath || seen.has(filePath)) return;
      seen.add(filePath);
      const baseScore = DIRECT_IMPLEMENT_PRECEDENT_BASE_SCORES[kind] ?? 0.84;
      out.push({
        filePath,
        score: round3(baseScore + scoreOffset),
        reasons: [
          `direct-precedent:${kind || 'precedent'}`,
          source,
          ...(precedent?.signature ? [`signature:${String(precedent.signature)}`] : []),
        ].slice(0, 4),
        anchors: [{
          id: String(
            node?.id
            || node?.uid
            || precedent?.anchor?.id
            || precedent?.anchor?.uid
            || `precedent:${kind}:${filePath}`,
          ),
          name: String(node?.name || node?.title || precedent?.anchor?.name || path.basename(filePath)),
          type: String(node?.kind || node?.type || precedent?.anchor?.kind || 'File'),
          startLine: node?.startLine ?? precedent?.anchor?.startLine,
          endLine: node?.endLine ?? precedent?.anchor?.endLine,
        }],
      });
    };

    for (const precedent of items) {
      const kind = String(precedent?.kind || '').trim();
      if (!DIRECT_IMPLEMENT_PRECEDENT_KINDS.has(kind)) continue;

      pushNode(precedent, precedent?.anchor, 'anchor', 0.04);
      pushNode(precedent, precedent?.anchor?.ui, 'anchor-ui', 0.03);
      pushNode(precedent, precedent?.anchor?.endpoint, 'anchor-endpoint', 0.02);
      pushNode(precedent, precedent?.anchor?.controller, 'anchor-controller', 0.01);

      const examples = Array.isArray(precedent?.examples) ? precedent.examples : [];
      for (const example of examples.slice(0, 4)) {
        pushNode(precedent, example, 'example', -0.04);
        pushNode(precedent, example?.ui, 'example-ui', -0.05);
        pushNode(precedent, example?.endpoint, 'example-endpoint', -0.05);
        pushNode(precedent, example?.controller, 'example-controller', -0.05);
      }

      const memberFiles = Array.isArray(precedent?.member_files) ? precedent.member_files : [];
      for (const memberFilePath of memberFiles.slice(0, 6)) {
        pushNode(precedent, { filePath: memberFilePath }, 'member-file', -0.06);
      }
    }

    return out.slice(0, Math.max(limitFiles, limitWriteOrder, 6));
  };

  const directPrecedentCompanionFiles = buildDirectPrecedentCompanionFiles(directPrecedents);
  const plannerTarget = implementPlan?.target || null;
  const fallbackTarget = implementPlan?.target || {
    query_intent: queryText,
    archetype: String(queryHeadProcesses?.[0]?.summary || queryHeadProcesses?.[0]?.process_type || '').trim() || null,
    slice: null,
  };
  const targetFieldText = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return [
        obj.uid,
        obj.label,
        obj.slice_type,
        obj.anchor_name,
        obj.anchor_id,
        obj.name,
        obj.title,
      ]
        .map(part => String(part || '').trim())
        .filter(Boolean)
        .join(' ');
    }
    return String(value || '');
  };
  const directTargetPrecedent = directPrecedents.find((precedent: any) => {
    const kind = String(precedent?.kind || '').trim();
    return kind === 'ui-behavior' || kind === 'backend-behavior' || kind === 'backend-handoff' || kind === 'pattern-catalog';
  }) || null;
  const directTargetTitle = String(
    directTargetPrecedent?.anchor?.title
    || directTargetPrecedent?.anchor?.name
    || directTargetPrecedent?.signature
    || '',
  ).trim();
  const directTargetFilePath = normalizePath(
    directTargetPrecedent?.anchor?.filePath
    || directPrecedentCompanionFiles[0]?.filePath,
  );
  const plannerSeedFiles = new Set<string>([
    ...rawCompanionFiles.map((file: any) => normalizePath(file?.filePath)),
    ...rawWritePlan.map((step: any) => normalizePath(step?.filePath)),
    ...actionHintFiles.map((file: any) => normalizePath(file?.filePath)),
  ].filter(Boolean));
  const plannerTargetText = [
    targetFieldText(fallbackTarget?.archetype),
    targetFieldText(fallbackTarget?.slice),
    targetFieldText(fallbackTarget?.query_intent),
  ]
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  const plannerTargetLooksGeneric = GENERIC_IMPLEMENT_TARGET_PATTERNS.some(pattern => pattern.test(plannerTargetText));
  const directTargetOverlapsPlanner = directPrecedentCompanionFiles.some(file => plannerSeedFiles.has(file.filePath));
  const targetCalibratedFromDirectPrecedents = Boolean(
    directTargetPrecedent
    && directTargetFilePath
    && (plannerTargetLooksGeneric || !directTargetOverlapsPlanner),
  );
  const directReferenceSurface = directTargetPrecedent && directTargetFilePath
    ? {
        kind: String(directTargetPrecedent?.kind || '').trim() || 'precedent',
        title: directTargetTitle || path.basename(directTargetFilePath),
        filePath: directTargetFilePath,
        signature: String(directTargetPrecedent?.signature || '').trim() || null,
        score: round3(safeNumber(directTargetPrecedent?.score)),
        member_files: Array.isArray(directTargetPrecedent?.member_files)
          ? directTargetPrecedent.member_files.slice(0, 6)
          : [],
      }
    : null;
  const directPrecedentCalibrationFiles = new Set<string>(
    targetCalibratedFromDirectPrecedents
      ? directPrecedentCompanionFiles.map(file => normalizePath(file?.filePath)).filter(Boolean)
      : [],
  );

  let companionFiles = dedupeCompanionFiles([
    ...directPrecedentCompanionFiles,
    ...patternCatalogTemplateCompanions,
    ...baseCompanionFiles,
  ]).slice(0, limitFiles);

  const buildDirectPrecedentWritePlan = (items: any[]): any[] => {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const file of items) {
      const filePath = normalizePath(file?.filePath);
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      const anchor = Array.isArray(file?.anchors) && file.anchors.length > 0 ? file.anchors[0] : null;
      const anchorStartLine = toOptionalLineNumber(anchor?.startLine);
      const anchorEndLine = toOptionalLineNumber(anchor?.endLine);
      out.push({
        uid: String(anchor?.id || `precedent:${filePath}`),
        name: String(anchor?.name || path.basename(filePath)),
        kind: String(anchor?.type || 'File'),
        filePath,
        role: 'precedent-anchor',
        ...(anchorStartLine !== undefined ? { startLine: anchorStartLine } : {}),
        ...(anchorEndLine !== undefined ? { endLine: anchorEndLine } : {}),
      });
    }
    return out.slice(0, Math.max(limitWriteOrder, 6));
  };

  const directPrecedentWritePlan = buildDirectPrecedentWritePlan(directPrecedentCompanionFiles);

  const buildFallbackWritePlan = (): any[] => {
    const steps: any[] = [];
    for (const file of companionFiles) {
      const filePath = normalizePath(file?.filePath);
      if (!filePath) continue;
      const anchor = Array.isArray(file?.anchors) && file.anchors.length > 0 ? file.anchors[0] : null;
      const anchorStartLine = toOptionalLineNumber(anchor?.startLine);
      const anchorEndLine = toOptionalLineNumber(anchor?.endLine);
      steps.push({
        uid: String(anchor?.id || `file:${filePath}`),
        name: String(anchor?.name || path.basename(filePath)),
        kind: String(anchor?.type || 'File'),
        filePath,
        role: 'fallback-anchor',
        ...(anchorStartLine !== undefined ? { startLine: anchorStartLine } : {}),
        ...(anchorEndLine !== undefined ? { endLine: anchorEndLine } : {}),
      });
      if (steps.length >= limitWriteOrder) break;
    }

    if (steps.length === 0) {
      for (const symbol of queryHeadSymbols) {
        const filePath = normalizePath(symbol?.filePath);
        if (!filePath) continue;
        const symbolStartLine = toOptionalLineNumber(symbol?.startLine);
        const symbolEndLine = toOptionalLineNumber(symbol?.endLine);
        steps.push({
          uid: String(symbol?.uid || symbol?.id || `file:${filePath}`),
          name: String(symbol?.name || path.basename(filePath)),
          kind: String(symbol?.kind || symbol?.type || 'CodeElement'),
          filePath,
          role: 'fallback-symbol',
          ...(symbolStartLine !== undefined ? { startLine: symbolStartLine } : {}),
          ...(symbolEndLine !== undefined ? { endLine: symbolEndLine } : {}),
        });
        if (steps.length >= limitWriteOrder) break;
      }
    }

    return steps;
  };

  const fallbackWritePlan = buildFallbackWritePlan();
  const usedFallbackWritePlan = rawWritePlan.length === 0 && fallbackWritePlan.length > 0;
  const dedupeWritePlan = (items: any[]): any[] => {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const filePath = normalizePath(item?.filePath);
      const uid = String(item?.uid || '').trim();
      const key = `${uid}|${filePath}`;
      if (!filePath || seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...item,
        filePath,
      });
    }
    return out;
  };
  const writePlanBase = dedupeWritePlan([
    ...directPrecedentWritePlan,
    ...(rawWritePlan.length > 0 ? rawWritePlan : fallbackWritePlan),
  ]).slice(0, limitWriteOrder);

  const collectPrecedentCandidates = (items: any[]): Array<{
    signature: string;
    source: 'anchor' | 'example';
    filePath: string;
    symbolName: string;
    symbolKind: string;
    layer: string;
  }> => {
    const out: Array<{
      signature: string;
      source: 'anchor' | 'example';
      filePath: string;
      symbolName: string;
      symbolKind: string;
      layer: string;
    }> = [];
    const pushNode = (node: any, signature: string, source: 'anchor' | 'example') => {
      if (!node || typeof node !== 'object') return;
      const filePath = normalizePath(node?.filePath);
      if (!filePath) return;
      out.push({
        signature,
        source,
        filePath,
        symbolName: String(node?.name || '').trim(),
        symbolKind: String(node?.kind || node?.type || '').trim(),
        layer: pathLayer(filePath),
      });
    };
    for (const precedent of items) {
      const signature = String(precedent?.signature || precedent?.kind || '').trim() || 'precedent';
      const anchor = precedent?.anchor;
      if (anchor && typeof anchor === 'object') {
        pushNode(anchor, signature, 'anchor');
        pushNode(anchor?.ui, signature, 'anchor');
        pushNode(anchor?.endpoint, signature, 'anchor');
        pushNode(anchor?.controller, signature, 'anchor');
      }
      const examples = Array.isArray(precedent?.examples) ? precedent.examples : [];
      for (const example of examples) {
        pushNode(example, signature, 'example');
        pushNode(example?.ui, signature, 'example');
        pushNode(example?.endpoint, signature, 'example');
        pushNode(example?.controller, signature, 'example');
      }
    }
    return out;
  };

  const precedentCandidates = collectPrecedentCandidates(precedents);
  const rankPrecedentMatches = (filePath: string): Array<{
    signature: string;
    source: 'anchor' | 'example';
    filePath: string;
    symbol_name: string;
    symbol_kind: string;
    score: number;
    reason: string;
  }> => {
    const normalized = normalizePath(filePath);
    if (!normalized) return [];
    const layer = pathLayer(normalized);
    const ext = path.extname(normalized).toLowerCase();
    const scored = precedentCandidates.map(candidate => {
      let score = 0;
      const reasons: string[] = [];
      if (candidate.filePath === normalized) {
        score += 4;
        reasons.push('exact-file');
      }
      if (candidate.layer === layer && layer) {
        score += 2;
        reasons.push(`layer:${layer}`);
      }
      if (path.extname(candidate.filePath).toLowerCase() === ext && ext) {
        score += 1;
        reasons.push(`ext:${ext}`);
      }
      return {
        signature: candidate.signature,
        source: candidate.source,
        filePath: candidate.filePath,
        symbol_name: candidate.symbolName,
        symbol_kind: candidate.symbolKind,
        score,
        reason: reasons.join(' + ') || 'generic-precedent',
      };
    });

    return scored
      .filter(item => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.filePath.localeCompare(right.filePath);
      })
      .slice(0, 3);
  };

  const buildFileCarbonCopyReady = (
    matches: Array<{ score: number; reason: string }>,
    convergenceBoost: number,
    baseScore: number,
    fallbackTag: string | null,
  ): {
    score: number;
    level: 'high' | 'medium' | 'low';
    reasons: string[];
    signals: {
      convergence: number;
      precedent: number;
      base: number;
    };
  } => {
    const convergenceNorm = clampUnit(safeNumber(convergenceBoost) / 2.4);
    const precedentNorm = clampUnit(
      (matches.length > 0
        ? Math.max(...matches.map(item => safeNumber(item?.score)))
        : 0) / 4,
    );
    const baseNorm = clampUnit(safeNumber(baseScore));
    const score = clampPercent(
      (convergenceNorm * IMPLEMENT_RANK_WEIGHTS.carbon.convergence)
      + (precedentNorm * IMPLEMENT_RANK_WEIGHTS.carbon.precedent)
      + (baseNorm * IMPLEMENT_RANK_WEIGHTS.carbon.base),
    );
    const reasons: string[] = [];
    if (convergenceNorm > 0) reasons.push(`convergence:${Math.round(convergenceNorm * 100)}`);
    if (precedentNorm > 0) reasons.push(`precedent:${Math.round(precedentNorm * 100)}`);
    if (matches[0]?.reason) reasons.push(`precedent-match:${String(matches[0].reason)}`);
    if (fallbackTag) reasons.push(`source:${fallbackTag}`);
    return {
      score: round3(score),
      level: readinessLevel(score),
      reasons: reasons.slice(0, 6),
      signals: {
        convergence: round3(convergenceNorm),
        precedent: round3(precedentNorm),
        base: round3(baseNorm),
      },
    };
  };

  let writePlan = writePlanBase.map((step, sourceIndex) => {
    const filePath = normalizePath(step?.filePath);
    const matches = rankPrecedentMatches(filePath);
    const convergence = convergenceBoostForFile(filePath);
    const convergenceScore = convergence.boost;
    const carbonCopyReady = buildFileCarbonCopyReady(
      matches,
      convergenceScore,
      0.5,
      usedFallbackWritePlan ? 'fallback-write-plan' : null,
    );
    const carbonScore = clampUnit(safeNumber(carbonCopyReady?.score) / 100);
    const convergenceComponent = convergenceEnabled
      ? (convergenceScore * IMPLEMENT_RANK_WEIGHTS.write_plan.convergence)
      : 0;
    const carbonComponent = carbonScore * IMPLEMENT_RANK_WEIGHTS.write_plan.carbon;
    const precedentComponent = matches.length > 0
      ? IMPLEMENT_RANK_WEIGHTS.write_plan.precedent_bonus
      : 0;
    const directPrecedentCalibrationComponent = directPrecedentCalibrationFiles.has(filePath)
      ? IMPLEMENT_DIRECT_PRECEDENT_CALIBRATION_BONUS.write_plan
      : 0;
    const rankingScore = round3(
      convergenceComponent
      + carbonComponent
      + precedentComponent
      + directPrecedentCalibrationComponent,
    );
    return {
      ...step,
      filePath,
      precedent_mapping: {
        matched: matches.length > 0,
        candidates: matches,
      },
      ...(convergenceScore > 0
        ? {
            convergence: {
              boost: convergenceScore,
              reasons: convergence.reasons,
            },
          }
        : {}),
      carbon_copy_ready: carbonCopyReady,
      ranking: {
        score: rankingScore,
        components: {
          convergence: round3(convergenceComponent),
          carbon: round3(carbonComponent),
          precedent_bonus: round3(precedentComponent),
          direct_precedent_calibration: round3(directPrecedentCalibrationComponent),
        },
      },
      __rank_score: rankingScore,
      __source_index: sourceIndex,
    };
  });
  const writePlanOrderBefore = writePlan
    .map(step => String(step?.uid || step?.name || step?.filePath || ''));
  const shouldReorderWritePlan = writePlan.some(step => safeNumber(step?.__rank_score) > 0);
  if (shouldReorderWritePlan) {
    writePlan = writePlan
      .slice()
      .sort((left, right) => {
        const leftScore = safeNumber(left?.__rank_score);
        const rightScore = safeNumber(right?.__rank_score);
        if (rightScore !== leftScore) return rightScore - leftScore;
        return safeNumber(left?.__source_index) - safeNumber(right?.__source_index);
      });
  }
  const writePlanOrderAfter = writePlan
    .map(step => String(step?.uid || step?.name || step?.filePath || ''));
  const writePlanReordered = writePlanOrderBefore.join('|') !== writePlanOrderAfter.join('|');
  const writePlanConvergenceApplied = convergenceEnabled
    && writePlan.some(step => safeNumber(step?.convergence?.boost) > 0);
  writePlan = writePlan.map((step: any) => {
    const { __rank_score, __source_index, ...rest } = step || {};
    return rest;
  });

  let companionFilesWithPrecedents = companionFiles.map((file, sourceIndex) => {
    const filePath = normalizePath(file?.filePath);
    const matches = rankPrecedentMatches(filePath);
    const convergence = convergenceBoostForFile(filePath);
    const convergenceScore = convergence.boost;
    const carbonCopyReady = buildFileCarbonCopyReady(
      matches,
      convergenceScore,
      safeNumber(file?.score),
      usedFallbackCompanion ? 'fallback-companion' : null,
    );
    const carbonScore = clampUnit(safeNumber(carbonCopyReady?.score) / 100);
    const baseComponent = safeNumber(file?.score) * IMPLEMENT_RANK_WEIGHTS.companion.base;
    const convergenceComponent = convergenceEnabled
      ? (convergenceScore * IMPLEMENT_RANK_WEIGHTS.companion.convergence)
      : 0;
    const carbonComponent = carbonScore * IMPLEMENT_RANK_WEIGHTS.companion.carbon;
    const precedentComponent = matches.length > 0
      ? IMPLEMENT_RANK_WEIGHTS.companion.precedent_bonus
      : 0;
    const directPrecedentCalibrationComponent = directPrecedentCalibrationFiles.has(filePath)
      ? IMPLEMENT_DIRECT_PRECEDENT_CALIBRATION_BONUS.companion
      : 0;
    const rankingScore = round3(
      baseComponent
      + convergenceComponent
      + carbonComponent
      + precedentComponent
      + directPrecedentCalibrationComponent,
    );
    return {
      ...file,
      filePath,
      precedent_mapping: {
        matched: matches.length > 0,
        candidates: matches,
      },
      ...(convergenceScore > 0
        ? {
            convergence: {
              boost: convergenceScore,
              reasons: convergence.reasons,
            },
          }
        : {}),
      carbon_copy_ready: carbonCopyReady,
      ranking: {
        score: rankingScore,
        components: {
          base: round3(baseComponent),
          convergence: round3(convergenceComponent),
          carbon: round3(carbonComponent),
          precedent_bonus: round3(precedentComponent),
          direct_precedent_calibration: round3(directPrecedentCalibrationComponent),
        },
      },
      __rank_score: rankingScore,
      __source_index: sourceIndex,
    };
  });
  const companionOrderBefore = companionFilesWithPrecedents
    .map(file => String(file?.filePath || file?.uid || file?.name || ''));
  const shouldReorderCompanions = companionFilesWithPrecedents.some(file => safeNumber(file?.__rank_score) > safeNumber(file?.score));
  if (shouldReorderCompanions) {
    companionFilesWithPrecedents = companionFilesWithPrecedents
      .slice()
      .sort((left, right) => {
        const leftScore = safeNumber(left?.__rank_score);
        const rightScore = safeNumber(right?.__rank_score);
        if (rightScore !== leftScore) return rightScore - leftScore;
        return safeNumber(left?.__source_index) - safeNumber(right?.__source_index);
      });
  }
  const companionOrderAfter = companionFilesWithPrecedents
    .map(file => String(file?.filePath || file?.uid || file?.name || ''));
  const companionReordered = companionOrderBefore.join('|') !== companionOrderAfter.join('|');
  const companionConvergenceApplied = convergenceEnabled
    && companionFilesWithPrecedents.some(file => safeNumber(file?.convergence?.boost) > 0);
  companionFilesWithPrecedents = companionFilesWithPrecedents.map((file: any) => {
    const { __rank_score, __source_index, ...rest } = file || {};
    return rest;
  });

  if (companionFilesWithPrecedents.length === 0) {
    const placeholderPath = String(pathPrefixes[0] || '.').trim() || '.';
    companionFilesWithPrecedents = [{
      filePath: placeholderPath,
      score: 0,
      reasons: ['fallback:placeholder'],
      anchors: [],
      precedent_mapping: {
        matched: false,
        candidates: [],
      },
    }];
  }

  if (writePlan.length === 0) {
    const placeholderFilePath = String(companionFilesWithPrecedents[0]?.filePath || pathPrefixes[0] || '.').trim() || '.';
    writePlan = [{
      uid: `fallback:${placeholderFilePath}`,
      name: path.basename(placeholderFilePath) || placeholderFilePath,
      kind: 'File',
      filePath: placeholderFilePath,
      role: 'fallback-placeholder',
      precedent_mapping: {
        matched: false,
        candidates: [],
      },
    }];
  }

  const fallbackChecks = [
    'Run review_mode(scope=unstaged) and verify changed_files reflects intended edits.',
    'Verify route/auth/cache contracts for touched surfaces using context() and action_plan().',
    'Execute at least one focused test per touched backend/frontend contract boundary.',
  ].slice(0, limitChecks);
  const usedFallbackChecks = rawChecks.length === 0;
  const checks = (rawChecks.length > 0 ? rawChecks : fallbackChecks).slice(0, limitChecks);

  const implementTarget = directReferenceSurface
    ? {
        ...fallbackTarget,
        ...(targetCalibratedFromDirectPrecedents
          ? {
              archetype: `direct-precedent:${directReferenceSurface.kind}:${directReferenceSurface.title}`,
              slice: directReferenceSurface.filePath,
            }
          : {}),
        reference_surface: directReferenceSurface,
        ...(targetCalibratedFromDirectPrecedents ? { planner_target: plannerTarget } : {}),
      }
    : fallbackTarget;
  const usedFallbackTarget = !implementPlan?.target;

  const gapSignals = implementPlan?.gap_signals || {};
  const gapHigh = toFiniteNumber(gapSignals?.high, 0);
  const gapDeterministic = toFiniteNumber(gapSignals?.deterministic, 0);
  const hypotheses: string[] = [];
  if (gapHigh > 0) {
    hypotheses.push('Top target slice has high-severity gaps; patch required slots before broad refactors.');
  }
  if (gapDeterministic > 0) {
    hypotheses.push('Deterministic gap signals indicate concrete missing closure links in the target slice.');
  }
  if (!implementPlan?.closure_template) {
    hypotheses.push('No closure template match found; verify anatomy against sibling precedents before adding new structure.');
  }
  if (companionFilesWithPrecedents.length === 0) {
    hypotheses.push('Companion set is sparse; expand anchor query or path scope to avoid under-editing dependent surfaces.');
  }
  if (usedFallbackWritePlan || usedFallbackChecks || usedFallbackCompanion || usedFallbackTarget) {
    hypotheses.push('Plan used fallback synthesis for one or more required fields; confirm anchors manually before editing.');
  }
  if (targetCalibratedFromDirectPrecedents) {
    hypotheses.push('Direct precedents overrode a generic planner target; start from the shared hotspot owners before editing.');
  }

  const postEditReviewBase = implementPlan?.post_edit_review || {
    tool: 'review_mode',
    params: {
      scope: 'unstaged',
      ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
      include_slice_stencil: true,
      include_evidence_spans: true,
    },
  };
  const postEditReview = includeReviewContract
    ? {
        ...postEditReviewBase,
        verification_contract: {
          mode: 'diff-aware',
          pass_gates: [
            { id: 'changed-files-detected', path: 'summary.changed_files', condition: '> 0' },
            { id: 'suggested-tests-available', path: 'summary.suggested_tests', condition: '>= 1' },
            { id: 'risk-not-high', path: 'review_kernel.risk.level', condition: '!= high' },
          ],
          fail_gates: [
            { id: 'stale-index', path: 'coverage_banner.freshness.is_stale', condition: '=== true' },
          ],
        },
      }
    : null;

  const qualityReasons: string[] = [];
  if (usedFallbackTarget) qualityReasons.push('target synthesized from query context');
  if (usedFallbackCompanion) qualityReasons.push('companion_files synthesized from action hints');
  if (usedFallbackWritePlan) qualityReasons.push('write_plan synthesized from available anchors');
  if (usedFallbackChecks) qualityReasons.push('verification checklist synthesized');
  if (precedents.length === 0) qualityReasons.push('precedent set is empty');
  if (targetCalibratedFromDirectPrecedents) qualityReasons.push('planner target calibrated from direct precedents');

  const qualityScore = Math.max(0, Math.min(100,
    40
    + (companionFilesWithPrecedents.length > 0 ? 20 : 0)
    + (writePlan.length > 0 ? 20 : 0)
    + (checks.length > 0 ? 10 : 0)
    + (precedents.length > 0 ? 10 : 0)
    - (qualityReasons.length * 8),
  ));
  const qualityLevel = qualityScore >= 85 ? 'high' : qualityScore >= 65 ? 'medium' : 'low';
  const degraded = qualityReasons.length > 0;

  const coverageWarnings: string[] = [];
  if (indexStatus.isStale) {
    coverageWarnings.push('Index is stale versus HEAD; implement suggestions may miss recent edits.');
  }
  if (degraded) {
    coverageWarnings.push('Implement plan used synthesized fallback fields; verify write anchors before editing.');
  }
  if (precedents.length === 0) {
    coverageWarnings.push('No precedents were resolved for this query; anatomy checks are weaker.');
  }
  if (targetCalibratedFromDirectPrecedents) {
    coverageWarnings.push('Direct precedents disagreed with the initial planner target; implement_mode recalibrated the hotspot anchors.');
  }
  const coverage_banner = {
    freshness: {
      is_stale: indexStatus.isStale,
      indexed_at: indexStatus.indexedAt,
      indexed_commit: indexStatus.indexedCommit || null,
      head_commit: indexStatus.headCommit || null,
      refresh_command: indexStatus.refreshCommandSandbox,
      refresh_command_force: indexStatus.refreshCommandSandboxForce,
    },
    coverage: {
      companion_files: companionFilesWithPrecedents.length,
      write_plan_steps: writePlan.length,
      checks: checks.length,
      precedents: precedents.length,
      fallback_fields: qualityReasons.length,
    },
    warnings: coverageWarnings,
  };

  const genericNextActions = [
    'Open the first write-plan anchor with context() and confirm callers before editing.',
    'Apply edits in write_plan order to preserve closure semantics.',
    'Run impact() on the highest-risk write anchor before touching shared utilities.',
  ];

  const companionFilesBoosted = companionFilesWithPrecedents
    .filter(file => safeNumber(file?.convergence?.boost) > 0)
    .length;
  const writePlanBoosted = writePlan
    .filter(step => safeNumber(step?.convergence?.boost) > 0)
    .length;
  const companionCarbonScores = companionFilesWithPrecedents
    .map(file => safeNumber(file?.carbon_copy_ready?.score))
    .filter(score => score > 0);
  const writePlanCarbonScores = writePlan
    .map(step => safeNumber(step?.carbon_copy_ready?.score))
    .filter(score => score > 0);
  const avgCompanionCarbon = companionCarbonScores.length > 0
    ? companionCarbonScores.reduce((sum, score) => sum + score, 0) / companionCarbonScores.length
    : 0;
  const avgWritePlanCarbon = writePlanCarbonScores.length > 0
    ? writePlanCarbonScores.reduce((sum, score) => sum + score, 0) / writePlanCarbonScores.length
    : 0;
  const companionPrecedentCoverage = companionFilesWithPrecedents.length > 0
    ? companionFilesWithPrecedents.filter(file => file?.precedent_mapping?.matched).length / companionFilesWithPrecedents.length
    : 0;
  const writePlanPrecedentCoverage = writePlan.length > 0
    ? writePlan.filter(step => step?.precedent_mapping?.matched).length / writePlan.length
    : 0;
  const queryHeadTopSignal = safeNumber(queryHeadConvergence?.top_slice_signal?.score || queryHeadConvergence?.top_process_signal?.score);
  const planCarbonScore = clampPercent(
    (avgCompanionCarbon * IMPLEMENT_RANK_WEIGHTS.plan_carbon.companion_avg)
    + (avgWritePlanCarbon * IMPLEMENT_RANK_WEIGHTS.plan_carbon.write_plan_avg)
    + (clampUnit(companionPrecedentCoverage) * 100 * IMPLEMENT_RANK_WEIGHTS.plan_carbon.companion_precedent_coverage)
    + (clampUnit(writePlanPrecedentCoverage) * 100 * IMPLEMENT_RANK_WEIGHTS.plan_carbon.write_plan_precedent_coverage)
    + (clampUnit(queryHeadTopSignal) * 100 * IMPLEMENT_RANK_WEIGHTS.plan_carbon.query_head_signal),
  );
  const planCarbonReasons: string[] = [];
  if (avgCompanionCarbon > 0) planCarbonReasons.push(`companion-avg:${Math.round(avgCompanionCarbon)}`);
  if (avgWritePlanCarbon > 0) planCarbonReasons.push(`write-plan-avg:${Math.round(avgWritePlanCarbon)}`);
  if (companionPrecedentCoverage > 0) planCarbonReasons.push(`companion-precedent:${Math.round(companionPrecedentCoverage * 100)}%`);
  if (writePlanPrecedentCoverage > 0) planCarbonReasons.push(`write-precedent:${Math.round(writePlanPrecedentCoverage * 100)}%`);
  if (queryHeadTopSignal > 0) planCarbonReasons.push(`query-head-signal:${Math.round(queryHeadTopSignal * 100)}`);
  const topWriteAnchor = writePlan
    .slice()
    .sort((left, right) => safeNumber(right?.carbon_copy_ready?.score) - safeNumber(left?.carbon_copy_ready?.score))[0] || null;
  const calibratedDirectWriteAnchors = targetCalibratedFromDirectPrecedents
    ? writePlan.filter(step => directPrecedentCalibrationFiles.has(normalizePath(step?.filePath)))
    : [];
  const convergedWriteAnchors = writePlan
    .filter(step => safeNumber(step?.convergence?.boost) > 0);
  const prioritizedWriteAnchorPool = calibratedDirectWriteAnchors.length > 0
    ? calibratedDirectWriteAnchors
    : convergedWriteAnchors.length > 0
      ? convergedWriteAnchors
      : writePlan;
  const writeAnchorRankScale = Math.max(
    1,
    ...prioritizedWriteAnchorPool.map(step => safeNumber(step?.ranking?.score)),
  );
  const computeWriteAnchorActionRank = (step: any): number => {
    const rankScore = clampUnit(safeNumber(step?.ranking?.score) / writeAnchorRankScale);
    const convergenceScore = clampUnit(safeNumber(step?.carbon_copy_ready?.signals?.convergence));
    const carbonScore = clampUnit(safeNumber(step?.carbon_copy_ready?.score) / 100);
    return round3(
      (rankScore * IMPLEMENT_NEXT_ACTION_RANK_WEIGHTS.rank_score)
      + (convergenceScore * IMPLEMENT_NEXT_ACTION_RANK_WEIGHTS.convergence)
      + (carbonScore * IMPLEMENT_NEXT_ACTION_RANK_WEIGHTS.carbon),
    );
  };
  const prioritizedWriteAnchor = prioritizedWriteAnchorPool
    .slice()
    .sort((left, right) => {
      const rightActionScore = computeWriteAnchorActionRank(right);
      const leftActionScore = computeWriteAnchorActionRank(left);
      if (rightActionScore !== leftActionScore) return rightActionScore - leftActionScore;
      const rightConvergence = safeNumber(right?.carbon_copy_ready?.signals?.convergence);
      const leftConvergence = safeNumber(left?.carbon_copy_ready?.signals?.convergence);
      if (rightConvergence !== leftConvergence) return rightConvergence - leftConvergence;
      return safeNumber(right?.carbon_copy_ready?.score) - safeNumber(left?.carbon_copy_ready?.score);
    })[0] || null;
  const prioritizedWriteSource: 'calibrated-precedent' | 'converged' | 'ranked' = calibratedDirectWriteAnchors.length > 0
    ? 'calibrated-precedent'
    : convergedWriteAnchors.length > 0
      ? 'converged'
      : 'ranked';
  const prioritizedWriteAction = prioritizedWriteAnchor
    ? (
      prioritizedWriteSource === 'calibrated-precedent'
        ? `Start with calibrated precedent anchor "${String(prioritizedWriteAnchor?.name || prioritizedWriteAnchor?.uid || prioritizedWriteAnchor?.filePath || 'write-step')}" to mirror the shared hotspot anatomy.`
        : prioritizedWriteSource === 'converged'
        ? `Start with converged write anchor "${String(prioritizedWriteAnchor?.name || prioritizedWriteAnchor?.uid || prioritizedWriteAnchor?.filePath || 'write-step')}" (convergence ${Math.round(clampUnit(safeNumber(prioritizedWriteAnchor?.carbon_copy_ready?.signals?.convergence)) * 100)}).`
        : `Start with top-ranked write anchor "${String(prioritizedWriteAnchor?.name || prioritizedWriteAnchor?.uid || prioritizedWriteAnchor?.filePath || 'write-step')}" (score ${Math.round(safeNumber(prioritizedWriteAnchor?.carbon_copy_ready?.score))}).`
    )
    : null;
  const nextActions = [
    ...(prioritizedWriteAction ? [prioritizedWriteAction] : []),
    ...genericNextActions,
    ...(postEditReview
      ? ['Run review_mode(scope=unstaged) with slice-stencil and evidence spans enabled after edits.']
      : []),
  ];
  const carbonCopyReady = {
    score: round3(planCarbonScore),
    level: readinessLevel(planCarbonScore),
    reasons: planCarbonReasons.slice(0, 6),
    top_anchor: topWriteAnchor
      ? {
          uid: String(topWriteAnchor?.uid || ''),
          name: String(topWriteAnchor?.name || ''),
          filePath: String(topWriteAnchor?.filePath || ''),
          score: round3(safeNumber(topWriteAnchor?.carbon_copy_ready?.score)),
        }
      : null,
    components: {
      companion_avg: round3(avgCompanionCarbon),
      write_plan_avg: round3(avgWritePlanCarbon),
      companion_precedent_coverage: round3(companionPrecedentCoverage),
      write_plan_precedent_coverage: round3(writePlanPrecedentCoverage),
      query_head_signal: round3(queryHeadTopSignal),
    },
  };
  const convergenceMeta = {
    enabled: convergenceEnabled,
    source_path: String(queryHeadConvergence?.source_path || queryHeadConvergence?.sourcePath || '').trim() || null,
    matrix_cells: toFiniteNumber(queryHeadConvergence?.matrix_cells, 0),
    companion_files_boosted: companionFilesBoosted,
    write_plan_boosted: writePlanBoosted,
    companion_reordered: companionReordered,
    write_plan_reordered: writePlanReordered,
    companion_convergence_applied: companionConvergenceApplied,
    write_plan_convergence_applied: writePlanConvergenceApplied,
    ranking_weights: IMPLEMENT_RANK_WEIGHTS,
    next_action_ranking_weights: IMPLEMENT_NEXT_ACTION_RANK_WEIGHTS,
    write_anchor_rank_scale: round3(writeAnchorRankScale),
    prioritized_write_anchor: prioritizedWriteAnchor
      ? {
          source: prioritizedWriteSource,
          uid: String(prioritizedWriteAnchor?.uid || ''),
          name: String(prioritizedWriteAnchor?.name || ''),
          filePath: String(prioritizedWriteAnchor?.filePath || ''),
          action_rank_score: computeWriteAnchorActionRank(prioritizedWriteAnchor),
          rank_score: round3(safeNumber(prioritizedWriteAnchor?.ranking?.score)),
          carbon_score: round3(safeNumber(prioritizedWriteAnchor?.carbon_copy_ready?.score)),
          convergence_score: round3(clampUnit(safeNumber(prioritizedWriteAnchor?.carbon_copy_ready?.signals?.convergence))),
          next_action: prioritizedWriteAction,
        }
      : null,
    carbon_copy_ready: carbonCopyReady,
  };

  return {
    status: 'ok',
    repo: repo.name,
    query: queryText,
    implement_mode: {
      target: implementTarget,
      closure_template: implementPlan?.closure_template || null,
      companion_files: companionFilesWithPrecedents,
      write_plan: writePlan,
      precedents,
      doc_guidance,
      action_hints: {
        files: actionHintFiles,
        checks,
        hops,
        cache_effects: cacheEffects,
      },
      verification_checklist: checks,
      query_head: includeQueryHead
        ? {
            query_plan: queryModeResult?.query_mode?.query_plan || null,
            slices: Array.isArray(queryModeResult?.query_mode?.slices) ? queryModeResult.query_mode.slices.slice(0, 2) : [],
            processes: queryHeadProcesses,
            symbols: queryHeadSymbols,
          }
        : null,
      gap_signals: gapSignals,
      quality: {
        level: qualityLevel,
        score: qualityScore,
        degraded,
        reasons: qualityReasons,
      },
      carbon_copy_ready: carbonCopyReady,
      coverage_banner,
      hypotheses: Array.from(new Set(hypotheses)).slice(0, 6),
      next_actions: nextActions,
      post_edit_review: postEditReview,
    },
    _implement_mode: {
      knobs: {
        limit_files: limitFiles,
        limit_checks: limitChecks,
        limit_write_order: limitWriteOrder,
        limit_precedents: limitPrecedents,
        include_query_head: includeQueryHead,
        include_review_contract: includeReviewContract,
        path_prefixes: pathPrefixes,
      },
      direct_precedent_recovery: {
        resolved: directPrecedents.length,
        companion_seeds: directPrecedentCompanionFiles.length,
        write_plan_seeds: directPrecedentWritePlan.length,
        target_calibrated: targetCalibratedFromDirectPrecedents,
        top_kind: directReferenceSurface?.kind || null,
        top_file: directReferenceSurface?.filePath || null,
      },
      convergence: convergenceMeta,
    },
  };
}
