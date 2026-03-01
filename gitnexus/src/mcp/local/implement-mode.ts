import path from 'path';
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

export async function runImplementMode(
  deps: ImplementModeDeps,
  repo: ImplementModeRepoHandle,
  params: ImplementModeParams,
): Promise<any> {
  const {
    actionPlan,
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

    const indexStatus = await getIndexStatus(repo);

    const normalizePath = (value: unknown): string => normalizeRepoRelativePath(String(value || ''));
    const pathLayer = (filePath: string): string => deriveLayerTag(normalizePath(filePath));
    const toPrimaryLabel = (value: any): string => {
      if (Array.isArray(value)) return String(value[0] || '').trim();
      return String(value || '').trim();
    };
    const safeNumber = (value: unknown): number => toFiniteNumber(value, 0);

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
    const precedents = (precedentsFromPlan.length > 0 ? precedentsFromPlan : precedentsFromQuery)
      .slice(0, limitPrecedents);

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
    const queryHeadProcesses = Array.isArray(queryModeResult?.query_mode?.processes)
      ? queryModeResult.query_mode.processes.slice(0, 4)
      : [];
    const actionHintFiles = Array.isArray(actionPlanResult?.files)
      ? actionPlanResult.files.slice(0, limitFiles)
      : [];

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
    let companionFiles = (rawCompanionFiles.length > 0 ? rawCompanionFiles : fallbackCompanionFiles)
      .slice(0, limitFiles);

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
    const writePlanBase = (rawWritePlan.length > 0 ? rawWritePlan : fallbackWritePlan)
      .slice(0, limitWriteOrder);

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

    let writePlan = writePlanBase.map(step => {
      const filePath = normalizePath(step?.filePath);
      const matches = rankPrecedentMatches(filePath);
      return {
        ...step,
        filePath,
        precedent_mapping: {
          matched: matches.length > 0,
          candidates: matches,
        },
      };
    });

    let companionFilesWithPrecedents = companionFiles.map(file => {
      const filePath = normalizePath(file?.filePath);
      const matches = rankPrecedentMatches(filePath);
      return {
        ...file,
        filePath,
        precedent_mapping: {
          matched: matches.length > 0,
          candidates: matches,
        },
      };
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

    const implementTarget = implementPlan?.target || {
      query_intent: queryText,
      archetype: String(queryHeadProcesses?.[0]?.summary || queryHeadProcesses?.[0]?.process_type || '').trim() || null,
      slice: null,
    };
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

    const nextActions = [
      'Open the first write-plan anchor with context() and confirm callers before editing.',
      'Apply edits in write_plan order to preserve closure semantics.',
      'Run impact() on the highest-risk write anchor before touching shared utilities.',
    ];
    if (postEditReview) {
      nextActions.push('Run review_mode(scope=unstaged) with slice-stencil and evidence spans enabled after edits.');
    }

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
      },
    };
  }
