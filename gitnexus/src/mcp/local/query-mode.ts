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

  const queryResult = await query(repo, {
    query: queryText,
    task_context: params.task_context,
    goal: params.goal,
    path_prefixes: pathPrefixes,
    limit: Math.max(5, limitProcesses),
    max_symbols: Math.max(10, maxSymbols),
    include_content: false,
    include_slice_cards: true,
    limit_slices: limitSlices,
    include_evidence_spans: true,
    limit_evidence: 30,
  });

  if (queryResult?.error) return queryResult;

  const topSlice = Array.isArray(queryResult?.slice_cards) ? queryResult.slice_cards[0] : null;

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

  const processSymbols = Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols : [];
  const definitions = Array.isArray(queryResult?.definitions) ? queryResult.definitions : [];
  const symbols = processSymbols.slice(0, maxSymbols);
  if (symbols.length < maxSymbols) {
    symbols.push(...definitions.slice(0, maxSymbols - symbols.length));
  }

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

  const nextActions = [
    'Open top-ranked symbols with context() to inspect incoming/outgoing references.',
    'Use action_plan() to confirm companion files and verification checks before edits.',
    'After edits, run review_mode(scope=unstaged) to validate semantic and closure deltas.',
  ];
  if (topSlice?.uid) {
    nextActions.unshift('Compare target slice with precedents() siblings before introducing a new flow shape.');
  }

  return {
    status: 'ok',
    repo: repo.name,
    query: queryText,
    query_mode: {
      query_plan: queryResult?.query_plan || null,
      slices: Array.isArray(queryResult?.slice_cards) ? queryResult.slice_cards.slice(0, limitSlices) : [],
      processes: Array.isArray(queryResult?.processes) ? queryResult.processes.slice(0, limitProcesses) : [],
      symbols,
      precedents: Array.isArray(precedentPack?.precedents)
        ? precedentPack.precedents.slice(0, limitPrecedents)
        : [],
      action_hints: includeActionHints
        ? {
            files: Array.isArray(actionPlanResult?.files) ? actionPlanResult.files.slice(0, 8) : [],
            checks: Array.isArray(actionPlanResult?.checks) ? actionPlanResult.checks.slice(0, 8) : [],
            hops: Array.isArray(actionPlanResult?.hops) ? actionPlanResult.hops.slice(0, limitHops) : [],
          }
        : null,
      hypotheses: Array.from(new Set(hypotheses)).slice(0, 6),
      next_actions: nextActions,
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
    },
  };
}
