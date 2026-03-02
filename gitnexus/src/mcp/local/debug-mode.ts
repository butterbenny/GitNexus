import fs from 'fs/promises';

export interface DebugModeRepoHandle {
  id: string;
  name: string;
  repoPath: string;
  storagePath: string;
}

export interface DebugModeParams {
  query?: string;
  symptom?: string;
  task_context?: string;
  goal?: string;
  failing_tests?: string[];
  error_strings?: string[];
  path_prefixes?: string[];
  limit_candidates?: number;
  limit_hops?: number;
  include_precedents?: boolean;
  runtime_observations?: unknown;
}

type DebugModeDeps = {
  toStringArray: (value: unknown) => string[];
  query: (repo: DebugModeRepoHandle, params: any) => Promise<any>;
  actionPlan: (repo: DebugModeRepoHandle, params: any) => Promise<any>;
  precedents: (repo: DebugModeRepoHandle, params: any) => Promise<any>;
  getIndexStatus: (repo: DebugModeRepoHandle) => Promise<any>;
  parsePathPrefixes: (repoPath: string, param: unknown) => string[];
  clampInteger: (value: unknown, fallback: number, min?: number, max?: number) => number;
  toOptionalNonNegativeInteger: (value: unknown) => number | undefined;
  toOptionalFiniteNumber: (value: unknown) => number | undefined;
  toFiniteNumber: (value: unknown, fallback?: number) => number;
  parseStringList: (value: unknown) => string[];
  normalizeRepoRelativePath: (value: string) => string;
  filePathTouchesPrefixes: (filePath: string, pathPrefixes: string[]) => boolean;
  loadRuntimeObservationSnapshot: (storagePath: string, options: { repoPath: string; extraPaths: string[] }) => Promise<any>;
  resolvePathInsideRepo: (repoPath: string, rawPath: string) => { relativePath: string; absolutePath: string } | null;
  round3: (value: unknown) => number;
  normalizeConfidence: (value: unknown, fallback?: number) => number;
};

export async function runDebugMode(
  deps: DebugModeDeps,
  repo: DebugModeRepoHandle,
  params: DebugModeParams,
): Promise<any> {
  const {
    toStringArray,
    query,
    actionPlan,
    precedents,
    getIndexStatus,
    parsePathPrefixes,
    clampInteger,
    toOptionalNonNegativeInteger,
    toOptionalFiniteNumber,
    toFiniteNumber,
    parseStringList,
    normalizeRepoRelativePath,
    filePathTouchesPrefixes,
    loadRuntimeObservationSnapshot,
    resolvePathInsideRepo,
    round3,
    normalizeConfidence,
  } = deps;
    const queryText = String(params.query || '').trim();
    const symptomText = String(params.symptom || '').trim();
    const failingTests = toStringArray(params.failing_tests);
    const errorStrings = toStringArray(params.error_strings);
    const pathPrefixes = parsePathPrefixes(repo.repoPath, (params as any).path_prefixes);
    const limitCandidates = clampInteger(params.limit_candidates, 8, 1, 30);
    const limitHops = clampInteger(params.limit_hops, 6, 1, 20);
    const includePrecedents = params.include_precedents !== false;

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

    const normalizeSqlSignature = (sql: string): string => {
      const normalized = String(sql || '')
        .toLowerCase()
        .replace(/'[^']*'/g, '?')
        .replace(/"[^"]*"/g, '?')
        .replace(/\b\d+\b/g, '?')
        .replace(/\s+/g, ' ')
        .trim();
      return normalized.slice(0, 240);
    };
    const normalizeObservedRoute = (value: string): string => {
      let raw = String(value || '').trim();
      if (!raw) return '';
      if (/^https?:\/\//i.test(raw)) {
        try {
          raw = new URL(raw).pathname || raw;
        } catch {
          // keep original
        }
      }
      raw = raw.split('?')[0].split('#')[0];
      try {
        raw = decodeURIComponent(raw);
      } catch {
        // keep original
      }
      raw = raw.replace(/\/{2,}/g, '/');
      if (!raw.startsWith('/')) raw = `/${raw}`;
      return raw.replace(/\/+$/, '') || '/';
    };
    const parseLaravelEndpointReason = (reason: string): { method: string; pattern: string } | null => {
      const raw = String(reason || '').trim();
      if (!raw.toLowerCase().startsWith('laravel-endpoint:')) return null;
      const rest = raw.slice('laravel-endpoint:'.length);
      const methodSep = rest.indexOf(':');
      if (methodSep <= 0) return null;
      const method = rest.slice(0, methodSep).trim().toUpperCase();
      if (!method) return null;
      const pathAndReason = rest.slice(methodSep + 1);
      const pathSep = pathAndReason.indexOf(':');
      const rawPath = (pathSep >= 0 ? pathAndReason.slice(0, pathSep) : pathAndReason).trim();
      const pattern = normalizeObservedRoute(rawPath);
      if (!pattern) return null;
      return { method, pattern };
    };
    const parseEndpointName = (endpointName: string): { method: string; pattern: string } | null => {
      const raw = String(endpointName || '').trim();
      if (!raw.toLowerCase().startsWith('endpoint:')) return null;
      const rest = raw.slice('endpoint:'.length);
      const methodSep = rest.indexOf(':');
      if (methodSep <= 0) return null;
      const method = rest.slice(0, methodSep).trim().toUpperCase();
      const pattern = normalizeObservedRoute(rest.slice(methodSep + 1));
      if (!method || !pattern) return null;
      return { method, pattern };
    };
    const parseHttpReason = (reason: string): { method: string; pattern: string } | null => {
      const raw = String(reason || '').trim();
      const match = /^http-([a-z]+):(.*)$/i.exec(raw);
      if (!match) return null;
      const method = String(match[1] || '').trim().toUpperCase();
      const pattern = normalizeObservedRoute(String(match[2] || ''));
      if (!method || !pattern) return null;
      return { method, pattern };
    };
    const routePatternToRegex = (pattern: string): RegExp | null => {
      const normalized = normalizeObservedRoute(pattern);
      if (!normalized) return null;
      if (normalized === '/') return /^\/$/;

      const escapeRegex = (value: string): string => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const segments = normalized.replace(/^\/+/, '').split('/').filter(Boolean);
      let patternSrc = '^';
      for (const segment of segments) {
        if (segment === '*') {
          patternSrc += '/[^/]+';
          continue;
        }

        const placeholderMatch = segment.match(/^\{(.+)\}$/);
        if (!placeholderMatch) {
          patternSrc += `/${escapeRegex(segment)}`;
          continue;
        }

        let inner = String(placeholderMatch[1] || '').trim();
        let optional = false;
        let wildcard = false;
        if (inner.endsWith('?')) {
          optional = true;
          inner = inner.slice(0, -1);
        }
        if (inner.endsWith('*')) {
          wildcard = true;
          inner = inner.slice(0, -1);
        }

        const colonIdx = inner.indexOf(':');
        const constraint = colonIdx >= 0 ? inner.slice(colonIdx + 1).trim() : '';
        let partPattern = '[^/]+';
        if (wildcard) partPattern = '.+';
        else if (constraint) partPattern = constraint;

        if (optional) patternSrc += `(?:/${partPattern})?`;
        else patternSrc += `/${partPattern}`;
      }
      patternSrc += '/?$';

      try {
        return new RegExp(patternSrc);
      } catch {
        return null;
      }
    };

    const normalizeRuntimeObservations = (value: unknown): {
      request_spans: Array<{
        method?: string;
        route?: string;
        duration_ms: number;
        status?: number;
        payload_bytes?: number;
        trace_id?: string;
      }>;
      db_queries: Array<{
        sql?: string;
        route?: string;
        method?: string;
        duration_ms: number;
        rows_examined?: number;
        lock_wait_ms?: number;
        count?: number;
        explain_plan?: string;
      }>;
      payload_shapes: Array<{
        path?: string;
        item_count?: number;
        bytes?: number;
        keys?: string[];
      }>;
    } => {
      const raw = (value && typeof value === 'object') ? (value as any) : {};
      const requestSpansRaw = Array.isArray(raw.request_spans)
        ? raw.request_spans
        : Array.isArray(raw.requestSpans)
          ? raw.requestSpans
          : [];
      const dbQueriesRaw = Array.isArray(raw.db_queries)
        ? raw.db_queries
        : Array.isArray(raw.dbQueries)
          ? raw.dbQueries
          : [];
      const payloadShapesRaw = Array.isArray(raw.payload_shapes)
        ? raw.payload_shapes
        : Array.isArray(raw.payloadShapes)
          ? raw.payloadShapes
          : [];

      const request_spans = requestSpansRaw
        .map((item: any) => ({
          method: String(item?.method || '').trim().toUpperCase() || undefined,
          route: (() => {
            const normalized = normalizeObservedRoute(String(item?.route || item?.path || '').trim());
            return normalized || undefined;
          })(),
          duration_ms: normalizeNumber(item?.duration_ms ?? item?.durationMs, 0, 0, 60_000),
          status: (() => {
            const status = toOptionalNonNegativeInteger(item?.status);
            if (status === undefined) return undefined;
            return status >= 100 && status <= 599 ? status : undefined;
          })(),
          payload_bytes: toOptionalFiniteNumber(item?.payload_bytes ?? item?.payloadBytes) !== undefined
            ? normalizeNumber(item?.payload_bytes ?? item?.payloadBytes, 0, 0, 20_000_000)
            : undefined,
          trace_id: String(item?.trace_id || item?.traceId || '').trim() || undefined,
        }))
        .filter((item: any) => item.duration_ms > 0)
        .slice(0, 200);

      const db_queries = dbQueriesRaw
        .map((item: any) => ({
          sql: String(item?.sql || item?.query || '').trim() || undefined,
          route: (() => {
            const normalized = normalizeObservedRoute(String(item?.route || item?.path || '').trim());
            return normalized || undefined;
          })(),
          method: String(item?.method || '').trim().toUpperCase() || undefined,
          duration_ms: normalizeNumber(item?.duration_ms ?? item?.durationMs, 0, 0, 60_000),
          rows_examined: toOptionalFiniteNumber(item?.rows_examined ?? item?.rowsExamined) !== undefined
            ? normalizeNumber(item?.rows_examined ?? item?.rowsExamined, 0, 0, 1_000_000_000)
            : undefined,
          lock_wait_ms: toOptionalFiniteNumber(item?.lock_wait_ms ?? item?.lockWaitMs) !== undefined
            ? normalizeNumber(item?.lock_wait_ms ?? item?.lockWaitMs, 0, 0, 60_000)
            : undefined,
          count: toOptionalFiniteNumber(item?.count) !== undefined
            ? normalizeNumber(item?.count, 1, 0, 1_000_000)
            : undefined,
          explain_plan: String(item?.explain_plan || item?.explainPlan || '').trim() || undefined,
        }))
        .filter((item: any) => item.duration_ms > 0 || (item.sql && item.sql.length > 0))
        .slice(0, 500);

      const payload_shapes = payloadShapesRaw
        .map((item: any) => {
          const keys = Array.isArray(item?.keys)
            ? item.keys.map((entry: any) => String(entry || '').trim()).filter(Boolean).slice(0, 20)
            : [];
          return {
            path: (() => {
              const normalized = normalizeObservedRoute(String(item?.path || item?.route || '').trim());
              return normalized || undefined;
            })(),
            item_count: toOptionalFiniteNumber(item?.item_count ?? item?.itemCount) !== undefined
              ? normalizeNumber(item?.item_count ?? item?.itemCount, 0, 0, 5_000_000)
              : undefined,
            bytes: toOptionalFiniteNumber(item?.bytes ?? item?.payload_bytes ?? item?.payloadBytes) !== undefined
              ? normalizeNumber(item?.bytes ?? item?.payload_bytes ?? item?.payloadBytes, 0, 0, 20_000_000)
              : undefined,
            keys,
          };
        })
        .filter((item: any) => item.path || item.item_count || item.bytes)
        .slice(0, 200);

      return {
        request_spans,
        db_queries,
        payload_shapes,
      };
    };

    const mergeRuntimeObservations = (
      primary: ReturnType<typeof normalizeRuntimeObservations>,
      secondary: ReturnType<typeof normalizeRuntimeObservations>,
    ): ReturnType<typeof normalizeRuntimeObservations> => {
      const requestByKey = new Map<string, any>();
      const dbByKey = new Map<string, any>();
      const payloadByKey = new Map<string, any>();

      const addRequestSpan = (item: any) => {
        const key = `${item?.method || ''}|${item?.route || ''}|${item?.status || ''}`;
        const existing = requestByKey.get(key);
        if (!existing) {
          requestByKey.set(key, item);
          return;
        }
        requestByKey.set(key, {
          ...existing,
          duration_ms: Math.max(toFiniteNumber(existing.duration_ms, 0), toFiniteNumber(item.duration_ms, 0)),
          payload_bytes: Math.max(toFiniteNumber(existing.payload_bytes, 0), toFiniteNumber(item.payload_bytes, 0)),
          trace_id: existing.trace_id || item.trace_id,
        });
      };
      const addDbQuery = (item: any) => {
        const signature = normalizeSqlSignature(String(item?.sql || ''));
        const key = `${signature}|${String(item?.route || '')}`;
        const existing = dbByKey.get(key);
        if (!existing) {
          dbByKey.set(key, {
            ...item,
            count: Math.max(1, toFiniteNumber(item?.count, 1)),
          });
          return;
        }
        dbByKey.set(key, {
          ...existing,
          duration_ms: Math.max(toFiniteNumber(existing.duration_ms, 0), toFiniteNumber(item.duration_ms, 0)),
          lock_wait_ms: Math.max(toFiniteNumber(existing.lock_wait_ms, 0), toFiniteNumber(item.lock_wait_ms, 0)),
          rows_examined: Math.max(toFiniteNumber(existing.rows_examined, 0), toFiniteNumber(item.rows_examined, 0)),
          count: toFiniteNumber(existing.count, 1) + Math.max(1, toFiniteNumber(item.count, 1)),
          explain_plan: existing.explain_plan || item.explain_plan,
        });
      };
      const addPayloadShape = (item: any) => {
        const key = String(item?.path || '').trim();
        if (!key) return;
        const existing = payloadByKey.get(key);
        if (!existing) {
          payloadByKey.set(key, item);
          return;
        }
        payloadByKey.set(key, {
          ...existing,
          item_count: Math.max(toFiniteNumber(existing.item_count, 0), toFiniteNumber(item.item_count, 0)),
          bytes: Math.max(toFiniteNumber(existing.bytes, 0), toFiniteNumber(item.bytes, 0)),
          keys: Array.from(new Set([
            ...(Array.isArray(existing.keys) ? existing.keys : []),
            ...(Array.isArray(item.keys) ? item.keys : []),
          ])).slice(0, 20),
        });
      };

      for (const item of primary.request_spans) addRequestSpan(item);
      for (const item of secondary.request_spans) addRequestSpan(item);
      for (const item of primary.db_queries) addDbQuery(item);
      for (const item of secondary.db_queries) addDbQuery(item);
      for (const item of primary.payload_shapes) addPayloadShape(item);
      for (const item of secondary.payload_shapes) addPayloadShape(item);

      const request_spans = Array.from(requestByKey.values());
      const db_queries = Array.from(dbByKey.values());
      const payload_shapes = Array.from(payloadByKey.values());
      return {
        request_spans: request_spans.slice(0, 500),
        db_queries: db_queries.slice(0, 1000),
        payload_shapes: payload_shapes.slice(0, 500),
      };
    };

    const runtimeObservationPaths = parseStringList(process.env.GITNEXUS_RUNTIME_OBSERVATIONS_FILE || '');
    const runtimeSnapshot = await loadRuntimeObservationSnapshot(repo.storagePath, {
      repoPath: repo.repoPath,
      extraPaths: runtimeObservationPaths,
    });
    const runtimeFromParams = normalizeRuntimeObservations((params as any).runtime_observations);
    const runtimeFromSnapshot = normalizeRuntimeObservations(runtimeSnapshot);
    const runtimeObservations = mergeRuntimeObservations(runtimeFromParams, runtimeFromSnapshot);
    const hasRuntimeObservations = runtimeObservations.request_spans.length > 0
      || runtimeObservations.db_queries.length > 0
      || runtimeObservations.payload_shapes.length > 0;
    const runtimeObservationSource = runtimeFromParams.request_spans.length > 0
      || runtimeFromParams.db_queries.length > 0
      || runtimeFromParams.payload_shapes.length > 0
      ? (runtimeFromSnapshot.request_spans.length > 0 || runtimeFromSnapshot.db_queries.length > 0 || runtimeFromSnapshot.payload_shapes.length > 0
        ? 'params+snapshot'
        : 'params')
      : (runtimeFromSnapshot.request_spans.length > 0 || runtimeFromSnapshot.db_queries.length > 0 || runtimeFromSnapshot.payload_shapes.length > 0
        ? 'snapshot'
        : 'none');

    const seedQuery = queryText || symptomText || failingTests[0] || errorStrings[0] || '';
    if (!seedQuery.trim()) {
      return { error: 'Provide at least one of query, symptom, failing_tests, or error_strings.' };
    }

    const classifySymptom = (value: string): {
      family: 'auth' | 'cache' | 'shape' | 'routing' | 'event' | 'performance' | 'unknown';
      normalized: string;
      matched_tokens: string[];
      confidence: number;
      secondary_families: string[];
    } => {
      const normalized = String(value || '').trim().toLowerCase();
      const tokenMap: Array<{ family: 'auth' | 'cache' | 'shape' | 'routing' | 'event' | 'performance'; tokens: string[] }> = [
        { family: 'auth', tokens: ['403', 'forbidden', 'unauthorized', 'permission', 'authorize', 'auth', 'policy', 'can('] },
        { family: 'cache', tokens: ['stale', 'cache', 'invalidate', 'refetch', 'query key', 'setquerydata', 'missing update'] },
        { family: 'shape', tokens: ['field', 'payload', 'serialize', 'validation', 'null', 'undefined', 'wrong field'] },
        { family: 'routing', tokens: ['route', '404', 'endpoint', 'controller', 'path', 'url', 'method not allowed'] },
        { family: 'event', tokens: ['queue', 'event', 'listener', 'job', 'broadcast'] },
        { family: 'performance', tokens: ['timeout', 'timed out', 'slow', 'latency', 'performance', 'n+1', 'lock wait', 'deadlock', 'rows examined', 'explain'] },
      ];

      const scored = tokenMap
        .map(entry => ({
          family: entry.family,
          matched: entry.tokens.filter(token => normalized.includes(token)),
        }))
        .filter(entry => entry.matched.length > 0)
        .sort((left, right) => right.matched.length - left.matched.length);

      const primary = scored[0];
      if (primary) {
        const confidence = round3(normalizeConfidence(Math.min(0.98, 0.45 + (primary.matched.length * 0.09)), 0.45));
        return {
          family: primary.family,
          normalized,
          matched_tokens: primary.matched.slice(0, 8),
          confidence,
          secondary_families: scored.slice(1, 4).map(entry => entry.family),
        };
      }

      return { family: 'unknown', normalized, matched_tokens: [], confidence: 0.2, secondary_families: [] };
    };

    const symptomSignal = classifySymptom([
      symptomText,
      ...failingTests,
      ...errorStrings,
      queryText,
    ].join(' '));

    const queryResult = await query(repo, {
      query: seedQuery,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
      limit: 5,
      max_symbols: 12,
      include_content: false,
      include_slice_cards: true,
      limit_slices: 2,
      include_evidence_spans: true,
      limit_evidence: 20,
    });
    if (queryResult?.error) return queryResult;

    const actionPlanResult = await actionPlan(repo, {
      query: seedQuery,
      task_context: params.task_context,
      goal: params.goal,
      path_prefixes: pathPrefixes,
      limit_files: 12,
      limit_checks: 10,
      __skip_precedents: true,
    });
    if (actionPlanResult?.error) return actionPlanResult;

    const targetSlice = Array.isArray(queryResult?.slice_cards) ? queryResult.slice_cards[0] : null;
    let precedentPack: any = null;
    if (includePrecedents) {
      try {
        precedentPack = await precedents(repo, {
          query: seedQuery,
          ...(targetSlice?.anchor_id ? { anchor_uid: String(targetSlice.anchor_id) } : {}),
          limit: 2,
          examples: 3,
          path_prefixes: pathPrefixes,
        });
      } catch {
        precedentPack = null;
      }
    }

    const hasPrecedentResults = () => Array.isArray(precedentPack?.precedents) && precedentPack.precedents.length > 0;
    if (includePrecedents && !hasPrecedentResults()) {
      const topSymbols = Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols.slice(0, 4) : [];
      const fallbackQuery = [
        seedQuery,
        ...topSymbols.map((item: any) => String(item?.name || '').trim()).filter(Boolean),
      ].join(' ').trim();
      const fallbackAnchorUid = String(topSymbols[0]?.id || topSymbols[0]?.uid || '').trim();
      if (fallbackQuery) {
        try {
          const fallbackPack = await precedents(repo, {
            query: fallbackQuery,
            ...(fallbackAnchorUid ? { anchor_uid: fallbackAnchorUid } : {}),
            limit: 2,
            examples: 3,
            path_prefixes: pathPrefixes,
          });
          if (Array.isArray(fallbackPack?.precedents) && fallbackPack.precedents.length > 0) {
            precedentPack = fallbackPack;
          }
        } catch {
          // best-effort fallback
        }
      }
    }

    const buildFixRecipes = (findings: string[]): Array<{ id: string; action: string; rationale: string }> => {
      const catalog: Record<string, { id: string; action: string; rationale: string }> = {
        'missing-endpoint-link': {
          id: 'tighten-http-routing-signals',
          action: 'Tighten HTTP path/method extraction so endpoint wiring resolves deterministically.',
          rationale: 'Routing hops should use high-confidence endpoint links instead of fuzzy fallback edges.',
        },
        'missing-controller-link': {
          id: 'wire-endpoint-controller-edge',
          action: 'Ensure endpoint -> controller edges are emitted from route extraction.',
          rationale: 'Missing handler links block one-hop cross-stack debug flows.',
        },
        'missing-permission-closure': {
          id: 'add-auth-closure-edge',
          action: 'Emit explicit permission slug edges for controller authorization calls.',
          rationale: 'Auth symptoms require controller -> permission -> role closure in graph.',
        },
        'no-role-grants': {
          id: 'parse-role-permission-grants',
          action: 'Parse role grant sources and link roles directly to permission slugs.',
          rationale: 'Without role grant edges, auth decisions remain partially manual.',
        },
        'missing-cache-coverage': {
          id: 'expand-cache-contract',
          action: 'Add invalidate/refetch/writeback coverage for queries affected by this mutation.',
          rationale: 'Cache drift issues usually come from incomplete invalidation or writeback contracts.',
        },
        'slice-closure-gaps': {
          id: 'mirror-sibling-closure',
          action: 'Mirror required slice slots/roles from sibling precedents before editing logic.',
          rationale: 'Closure gaps often indicate missing companion files or boundary logic.',
        },
        'low-confidence-http-wiring': {
          id: 'raise-http-edge-confidence',
          action: 'Prefer exact route/path matching and skip ambiguous edges.',
          rationale: 'Debug recommendations degrade when cross-stack wiring confidence is low.',
        },
        'slow-request-path': {
          id: 'trim-request-hot-path',
          action: 'Reduce synchronous work on the request path and defer non-critical side effects.',
          rationale: 'Request-level timeout symptoms are often dominated by serialized hot-path work.',
        },
        'large-payload-shape': {
          id: 'bound-payload-cardinality',
          action: 'Chunk or page large request arrays and avoid repeated full-array scans.',
          rationale: 'Large payload cardinality amplifies O(n²) patterns and lock time windows.',
        },
        'slow-db-query': {
          id: 'improve-query-selectivity',
          action: 'Add/select better indexes and trim selected columns in slow query paths.',
          rationale: 'High query duration indicates low selectivity or over-fetching.',
        },
        'possible-n-plus-one': {
          id: 'collapse-looped-queries',
          action: 'Replace per-item queries with eager loading, batched lookups, or keyed maps.',
          rationale: 'Repeated query signatures under loops indicate likely N+1 behavior.',
        },
        'lock-contention': {
          id: 'narrow-lock-scope',
          action: 'Shorten transaction scope and acquire locks in a deterministic order.',
          rationale: 'Long lock waits point to contention across competing write paths.',
        },
        'hot-path-cost': {
          id: 'reduce-hot-path-complexity',
          action: 'Pre-index inputs by key and avoid repeated linear lookups inside loops.',
          rationale: 'High hot-path complexity drives timeout variance under larger payloads.',
        },
        'repeated-linear-lookups': {
          id: 'replace-linear-lookups',
          action: 'Build keyed maps once and use O(1) lookups in loops.',
          rationale: 'Repeated .find()/findOrFail() scans inside loops scale poorly.',
        },
        'write-amplification': {
          id: 'batch-write-path',
          action: 'Skip unchanged rows and batch persistent writes where possible.',
          rationale: 'Per-item save/update loops increase lock hold time and request latency.',
        },
        'no-op-write-churn': {
          id: 'suppress-noop-writes',
          action: 'Guard writes with diff checks so unchanged records are not persisted.',
          rationale: 'No-op writes add DB and lock pressure without state changes.',
        },
        'db-plan-risk': {
          id: 'review-explain-plan',
          action: 'Capture EXPLAIN and remove plan operators that force scans/filesort/temporary tables.',
          rationale: 'Plan regressions can dominate request latency even with small payloads.',
        },
      };

      const recipes: Array<{ id: string; action: string; rationale: string }> = [];
      const seen = new Set<string>();
      for (const finding of findings) {
        const item = catalog[finding];
        if (!item || seen.has(item.id)) continue;
        seen.add(item.id);
        recipes.push(item);
      }
      return recipes;
    };

    const candidateLoops: Array<{
      kind: 'http_loop' | 'cache_loop' | 'slice_gap' | 'runtime_loop' | 'perf_loop';
      score: number;
      symptom_fit: number;
      confidence: number;
      route_alignment?: number;
      confidence_reason: string;
      symptom_fit_reasons: string[];
      summary: string;
      findings: string[];
      fix_recipes: Array<{ id: string; action: string; rationale: string }>;
      evidence: any;
    }> = [];

    const hops = Array.isArray(actionPlanResult?.hops) ? actionPlanResult.hops.slice(0, limitHops) : [];
    type RuntimeRoutePattern = {
      method: string;
      pattern: string;
      matcher: RegExp;
      source: 'endpoint_wiring' | 'endpoint_name' | 'http_reason';
      confidence: number;
      reason: string;
      endpoint: any;
      controller: any;
    };

    const routePatternByKey = new Map<string, RuntimeRoutePattern>();
    const addRuntimeRoutePattern = (
      hop: any,
      source: RuntimeRoutePattern['source'],
      parsed: { method: string; pattern: string } | null,
      confidenceHint: unknown,
      reason: string,
    ): void => {
      if (!parsed?.method || !parsed?.pattern) return;
      const matcher = routePatternToRegex(parsed.pattern);
      if (!matcher) return;

      const method = String(parsed.method || '').trim().toUpperCase();
      const pattern = normalizeObservedRoute(parsed.pattern);
      if (!method || !pattern) return;

      const controllerUid = String(hop?.controller?.uid || '').trim();
      const endpointUid = String(hop?.endpoint?.uid || '').trim();
      const key = `${method}|${pattern}|${controllerUid}|${endpointUid}`;
      const confidence = normalizeConfidence(
        confidenceHint,
        normalizeConfidence(hop?.endpoint_wiring?.confidence ?? hop?.http?.confidence, 0.7),
      );

      const current = routePatternByKey.get(key);
      if (current && current.confidence >= confidence) return;

      routePatternByKey.set(key, {
        method,
        pattern,
        matcher,
        source,
        confidence,
        reason: String(reason || '').trim(),
        endpoint: hop?.endpoint || null,
        controller: hop?.controller || null,
      });
    };

    for (const hop of hops) {
      addRuntimeRoutePattern(
        hop,
        'endpoint_wiring',
        parseLaravelEndpointReason(String(hop?.endpoint_wiring?.reason || '')),
        hop?.endpoint_wiring?.confidence,
        String(hop?.endpoint_wiring?.reason || ''),
      );
      addRuntimeRoutePattern(
        hop,
        'endpoint_name',
        parseEndpointName(String(hop?.endpoint?.name || '')),
        hop?.endpoint_wiring?.confidence ?? hop?.http?.confidence,
        String(hop?.endpoint?.name || ''),
      );
      addRuntimeRoutePattern(
        hop,
        'http_reason',
        parseHttpReason(String(hop?.http?.reason || '')),
        hop?.http?.confidence,
        String(hop?.http?.reason || ''),
      );
    }

    const runtimeRoutePatterns = Array.from(routePatternByKey.values());
    const getRouteFirstSegment = (routeValue: string): string => {
      return normalizeObservedRoute(routeValue).replace(/^\/+/, '').split('/').find(Boolean) || '';
    };
    const runtimePatternsByMethod = new Map<string, RuntimeRoutePattern[]>();
    const runtimePatternsByMethodAndSegment = new Map<string, Map<string, RuntimeRoutePattern[]>>();
    const runtimePatternsByMethodGeneric = new Map<string, RuntimeRoutePattern[]>();
    for (const runtimePattern of runtimeRoutePatterns) {
      const methodList = runtimePatternsByMethod.get(runtimePattern.method) || [];
      methodList.push(runtimePattern);
      runtimePatternsByMethod.set(runtimePattern.method, methodList);

      const firstSegment = getRouteFirstSegment(runtimePattern.pattern);
      if (!firstSegment) {
        const genericList = runtimePatternsByMethodGeneric.get(runtimePattern.method) || [];
        genericList.push(runtimePattern);
        runtimePatternsByMethodGeneric.set(runtimePattern.method, genericList);
        continue;
      }

      const methodSegments = runtimePatternsByMethodAndSegment.get(runtimePattern.method) || new Map<string, RuntimeRoutePattern[]>();
      const segmentList = methodSegments.get(firstSegment) || [];
      segmentList.push(runtimePattern);
      methodSegments.set(firstSegment, segmentList);
      runtimePatternsByMethodAndSegment.set(runtimePattern.method, methodSegments);
    }
    const runtimeRouteMatchCache = new Map<string, RuntimeRoutePattern[]>();
    const collectRuntimeRouteCandidates = (method: string, observedRoute: string): RuntimeRoutePattern[] => {
      const firstSegment = getRouteFirstSegment(observedRoute);
      const methodSegments = runtimePatternsByMethodAndSegment.get(method);
      const segmentCandidates = firstSegment && methodSegments
        ? (methodSegments.get(firstSegment) || [])
        : [];
      const genericCandidates = runtimePatternsByMethodGeneric.get(method) || [];
      const merged = [...segmentCandidates, ...genericCandidates];
      return merged.length > 0 ? merged : (runtimePatternsByMethod.get(method) || []);
    };
    const findMatchedRuntimeRoutes = (methodHint: string, observedRoute: string): RuntimeRoutePattern[] => {
      const normalizedRoute = normalizeObservedRoute(String(observedRoute || ''));
      if (!normalizedRoute) return [];
      const normalizedMethod = String(methodHint || '').trim().toUpperCase();
      const cacheKey = `${normalizedMethod || '*'}|${normalizedRoute}`;
      const cached = runtimeRouteMatchCache.get(cacheKey);
      if (cached) return cached;

      const candidates = (() => {
        if (!normalizedMethod) return runtimeRoutePatterns;
        const byMethod = collectRuntimeRouteCandidates(normalizedMethod, normalizedRoute);
        if (normalizedMethod !== 'HEAD') return byMethod;
        const getRoutes = collectRuntimeRouteCandidates('GET', normalizedRoute);
        return [...byMethod, ...getRoutes];
      })();

      const matched = Array.from(new Map(
        candidates
          .filter(candidate => candidate.matcher.test(normalizedRoute))
          .map(candidate => {
            const controllerUid = String(candidate?.controller?.uid || '').trim();
            const endpointUid = String(candidate?.endpoint?.uid || '').trim();
            const key = `${candidate.method}|${candidate.pattern}|${controllerUid}|${endpointUid}`;
            return [key, candidate];
          }),
      ).values());

      runtimeRouteMatchCache.set(cacheKey, matched);
      return matched;
    };
    const toRuntimeRouteEvidence = (matches: RuntimeRoutePattern[]): any[] => {
      return matches.slice(0, 5).map(match => ({
        method: match.method,
        pattern: match.pattern,
        source: match.source,
        confidence: round3(normalizeConfidence(match.confidence, 0.5)),
        reason: match.reason,
        endpoint: match.endpoint ? {
          uid: match.endpoint.uid,
          name: match.endpoint.name,
          filePath: match.endpoint.filePath,
          startLine: match.endpoint.startLine,
        } : null,
        controller: match.controller ? {
          uid: match.controller.uid,
          name: match.controller.name,
          filePath: match.controller.filePath,
          startLine: match.controller.startLine,
        } : null,
      }));
    };
    const computeAverage = (values: number[]): number => {
      if (values.length === 0) return 0;
      const total = values.reduce((sum, value) => sum + value, 0);
      return total / values.length;
    };
    const buildHopRouteKey = (endpointUid: unknown, controllerUid: unknown): string => {
      const endpoint = String(endpointUid || '').trim();
      const controller = String(controllerUid || '').trim();
      return `${endpoint}|${controller}`;
    };
    type RuntimeRouteCoverage = {
      request_match_count: number;
      db_match_count: number;
      observed_routes: Set<string>;
      patterns: Set<string>;
      sources: Set<string>;
      confidence_samples: number[];
      max_request_duration_ms: number;
      max_db_duration_ms: number;
      max_lock_wait_ms: number;
    };
    const runtimeRouteCoverageByHopKey = new Map<string, RuntimeRouteCoverage>();
    const runtimeRouteMatcherStats = {
      request_spans_with_route: 0,
      request_spans_matched: 0,
      db_queries_with_route: 0,
      db_queries_matched: 0,
    };
    const recordRuntimeRouteMatch = (
      kind: 'request' | 'db',
      observedRoute: string,
      durationMs: number,
      lockWaitMs: number,
      matches: RuntimeRoutePattern[],
    ): void => {
      if (!observedRoute || matches.length === 0) return;
      for (const match of matches) {
        const endpointUid = String(match?.endpoint?.uid || '').trim();
        const controllerUid = String(match?.controller?.uid || '').trim();
        if (!endpointUid && !controllerUid) continue;
        const key = buildHopRouteKey(endpointUid, controllerUid);
        let coverage = runtimeRouteCoverageByHopKey.get(key);
        if (!coverage) {
          coverage = {
            request_match_count: 0,
            db_match_count: 0,
            observed_routes: new Set<string>(),
            patterns: new Set<string>(),
            sources: new Set<string>(),
            confidence_samples: [],
            max_request_duration_ms: 0,
            max_db_duration_ms: 0,
            max_lock_wait_ms: 0,
          };
          runtimeRouteCoverageByHopKey.set(key, coverage);
        }
        coverage.observed_routes.add(observedRoute);
        coverage.patterns.add(`${match.method} ${match.pattern}`);
        coverage.sources.add(match.source);
        coverage.confidence_samples.push(normalizeConfidence(match.confidence, 0.5));
        if (kind === 'request') {
          coverage.request_match_count += 1;
          coverage.max_request_duration_ms = Math.max(coverage.max_request_duration_ms, durationMs);
        } else {
          coverage.db_match_count += 1;
          coverage.max_db_duration_ms = Math.max(coverage.max_db_duration_ms, durationMs);
          coverage.max_lock_wait_ms = Math.max(coverage.max_lock_wait_ms, lockWaitMs);
        }
      }
    };
    const renderRuntimeRouteCoverage = (coverage: RuntimeRouteCoverage | undefined): any => {
      if (!coverage) return null;
      return {
        request_spans: coverage.request_match_count,
        db_queries: coverage.db_match_count,
        matcher_confidence: round3(normalizeConfidence(computeAverage(coverage.confidence_samples), 0.5)),
        observed_routes: Array.from(coverage.observed_routes).slice(0, 5),
        patterns: Array.from(coverage.patterns).slice(0, 5),
        sources: Array.from(coverage.sources).slice(0, 5),
        max_request_duration_ms: coverage.max_request_duration_ms || undefined,
        max_db_duration_ms: coverage.max_db_duration_ms || undefined,
        max_lock_wait_ms: coverage.max_lock_wait_ms || undefined,
      };
    };

    for (const hop of hops) {
      const findings: string[] = [];
      let score = 1;
      let symptomFit = 0;
      const symptomFitReasons: string[] = [];
      const permissions = Array.isArray(hop?.permissions) ? hop.permissions : [];

      if (!hop?.endpoint?.uid) {
        findings.push('missing-endpoint-link');
        score += 2;
      }
      if (!hop?.controller?.uid) {
        findings.push('missing-controller-link');
        score += 2;
      }

      if (permissions.length === 0) {
        findings.push('missing-permission-closure');
        score += 3;
      } else {
        const grantsWithoutRoles = permissions.filter((grant: any) => !Array.isArray(grant?.roles) || grant.roles.length === 0);
        if (grantsWithoutRoles.length > 0) {
          findings.push('no-role-grants');
          score += 3;
        }
      }

      const httpConfidence = toFiniteNumber(hop?.http?.confidence, 1);
      const wiringConfidence = toFiniteNumber(hop?.endpoint_wiring?.confidence, 1);
      if (httpConfidence < 0.9 || wiringConfidence < 0.9) {
        findings.push('low-confidence-http-wiring');
        score += 1;
      }

      if (symptomSignal.family === 'auth' && (findings.includes('missing-permission-closure') || findings.includes('no-role-grants'))) {
        symptomFit += 3;
        symptomFitReasons.push('auth-permission-closure');
      }
      if (symptomSignal.family === 'routing' && (findings.includes('missing-endpoint-link') || findings.includes('missing-controller-link'))) {
        symptomFit += 3;
        symptomFitReasons.push('routing-hop-gap');
      }
      if (symptomSignal.family === 'performance' && findings.includes('low-confidence-http-wiring')) {
        symptomFit += 1;
        symptomFitReasons.push('performance-ambiguous-routing');
      }

      const finalScore = score + symptomFit;
      candidateLoops.push({
        kind: 'http_loop',
        score: finalScore,
        symptom_fit: symptomFit,
        confidence: round3(normalizeConfidence((httpConfidence + wiringConfidence) / 2, 0.5)),
        confidence_reason: 'Derived from averaged HTTP call edge + endpoint/controller wiring confidence.',
        symptom_fit_reasons: symptomFitReasons,
        summary: `${String(hop?.http?.reason || 'http-loop')} -> ${String(hop?.controller?.name || 'unknown-controller')}`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          hop: {
            http: hop?.http || null,
            endpoint: hop?.endpoint || null,
            controller: hop?.controller || null,
            endpoint_wiring: hop?.endpoint_wiring || null,
          },
          permissions,
        },
      });
    }

    const cacheEffects = Array.isArray(actionPlanResult?.cache_effects) ? actionPlanResult.cache_effects : [];
    for (const effect of cacheEffects.slice(0, limitCandidates)) {
      const gaps = Array.isArray(effect?.coverage_gaps) ? effect.coverage_gaps : [];
      if (gaps.length === 0) continue;

      const symptomFit = symptomSignal.family === 'cache' ? 3 : 0;
      const findings = ['missing-cache-coverage'];
      candidateLoops.push({
        kind: 'cache_loop',
        score: 2 + (gaps.length * 0.5) + symptomFit,
        symptom_fit: symptomFit,
        confidence: 0.7,
        confidence_reason: 'Cache coverage gaps are inferred from query/mutation contract extraction.',
        symptom_fit_reasons: symptomFit > 0 ? ['cache-symptom-signal'] : [],
        summary: `${String(effect?.filePath || 'cache-surface')} has ${gaps.length} cache coverage gaps`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          filePath: effect?.filePath || '',
          coverage_gaps: gaps.slice(0, 8),
          summary: effect?.summary || null,
        },
      });
    }

    if (targetSlice?.gap_signals) {
      const gapSignals = targetSlice.gap_signals;
      const severeGapCount = toFiniteNumber(gapSignals?.high, 0) + toFiniteNumber(gapSignals?.deterministic, 0);
      if (severeGapCount > 0) {
        const symptomFit = symptomSignal.family === 'shape' ? 2 : 0;
        const findings = ['slice-closure-gaps'];
        candidateLoops.push({
          kind: 'slice_gap',
          score: 2 + severeGapCount + symptomFit,
          symptom_fit: symptomFit,
          confidence: 0.75,
          confidence_reason: 'Feature-slice closure gaps are high-confidence structural signals from indexed slice slots/roles.',
          symptom_fit_reasons: symptomFit > 0 ? ['shape-symptom-signal'] : [],
          summary: `Target slice ${String(targetSlice?.label || targetSlice?.uid || '')} has closure gap signals`,
          findings,
          fix_recipes: buildFixRecipes(findings),
          evidence: {
            slice: targetSlice,
            gap_signals: gapSignals,
          },
        });
      }
    }

    const dbSignatureCounts = new Map<string, number>();
    for (const query of runtimeObservations.db_queries) {
      const signature = normalizeSqlSignature(String(query.sql || ''));
      if (!signature) continue;
      dbSignatureCounts.set(signature, (dbSignatureCounts.get(signature) || 0) + Math.max(1, toFiniteNumber(query.count, 1)));
    }

    const payloadShapeByPath = new Map<string, any>();
    const payloadShapeByRoutePattern = new Map<string, any>();
    for (const item of runtimeObservations.payload_shapes) {
      const key = normalizeObservedRoute(String(item.path || ''));
      if (!key) continue;
      payloadShapeByPath.set(key, item);
      if (runtimeRoutePatterns.length === 0) continue;
      const matchedRoutes = findMatchedRuntimeRoutes('', key);
      for (const matchedRoute of matchedRoutes) {
        const matchKey = `${matchedRoute.method}|${matchedRoute.pattern}`;
        const existing = payloadShapeByRoutePattern.get(matchKey);
        if (!existing) {
          payloadShapeByRoutePattern.set(matchKey, item);
          continue;
        }
        const existingScore = toFiniteNumber(existing?.bytes, 0) + (toFiniteNumber(existing?.item_count, 0) * 1000);
        const itemScore = toFiniteNumber(item?.bytes, 0) + (toFiniteNumber(item?.item_count, 0) * 1000);
        if (itemScore > existingScore) payloadShapeByRoutePattern.set(matchKey, item);
      }
    }

    for (const requestSpan of runtimeObservations.request_spans.slice(0, Math.max(4, limitCandidates))) {
      const findings: string[] = [];
      const durationMs = normalizeNumber(requestSpan.duration_ms, 0, 0, 60_000);
      const payloadBytes = normalizeNumber(requestSpan.payload_bytes, 0, 0, 20_000_000);
      const requestMethod = String(requestSpan.method || '').trim().toUpperCase();
      const routeKey = normalizeObservedRoute(String(requestSpan.route || ''));
      const matchedRoutes = routeKey ? findMatchedRuntimeRoutes(requestMethod, routeKey) : [];
      if (routeKey) runtimeRouteMatcherStats.request_spans_with_route += 1;
      if (routeKey && matchedRoutes.length > 0) {
        runtimeRouteMatcherStats.request_spans_matched += 1;
        recordRuntimeRouteMatch('request', routeKey, durationMs, 0, matchedRoutes);
      }
      let payloadShape = routeKey ? payloadShapeByPath.get(routeKey) : null;
      if (!payloadShape && matchedRoutes.length > 0) {
        for (const matchedRoute of matchedRoutes) {
          const matchKey = `${matchedRoute.method}|${matchedRoute.pattern}`;
          const matchedPayload = payloadShapeByRoutePattern.get(matchKey);
          if (!matchedPayload) continue;
          payloadShape = matchedPayload;
          break;
        }
      }

      if (durationMs >= 350) findings.push('slow-request-path');
      if (payloadBytes >= 250_000 || toFiniteNumber(payloadShape?.item_count, 0) >= 100) findings.push('large-payload-shape');
      if (findings.length === 0) continue;

      let symptomFit = 0;
      const symptomFitReasons: string[] = [];
      if (symptomSignal.family === 'performance') {
        symptomFit += 4;
        symptomFitReasons.push('performance-latency-signal');
      }
      if (symptomSignal.family === 'routing' && routeKey) {
        if (matchedRoutes.length > 0) {
          symptomFit += 2;
          symptomFitReasons.push('routing-route-pattern-match');
        } else {
          symptomFit += 1;
          symptomFitReasons.push('routing-route-signal');
        }
      }

      const baseScore = 2 + Math.min(6, durationMs / 250) + (payloadBytes > 0 ? Math.min(2, payloadBytes / 500_000) : 0);
      const confidence = round3(normalizeConfidence(
        Math.min(0.95, 0.56 + (matchedRoutes.length > 0 ? 0.2 : routeKey ? 0.08 : 0) + (durationMs >= 500 ? 0.1 : 0)),
        0.56,
      ));
      candidateLoops.push({
        kind: 'runtime_loop',
        score: baseScore + symptomFit,
        symptom_fit: symptomFit,
        confidence,
        confidence_reason: 'Derived from observed request duration/payload metrics provided in runtime_observations.',
        symptom_fit_reasons: symptomFitReasons,
        summary: `${requestSpan.method || 'REQUEST'} ${routeKey || '(unknown-route)'} observed ${durationMs}ms`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          request_span: requestSpan,
          payload_shape: payloadShape || null,
          matched_routes: toRuntimeRouteEvidence(matchedRoutes),
        },
      });
    }

    for (const dbQuery of runtimeObservations.db_queries.slice(0, Math.max(8, limitCandidates * 2))) {
      const findings: string[] = [];
      const durationMs = normalizeNumber(dbQuery.duration_ms, 0, 0, 60_000);
      const lockWaitMs = normalizeNumber(dbQuery.lock_wait_ms, 0, 0, 60_000);
      const rowsExamined = normalizeNumber(dbQuery.rows_examined, 0, 0, 1_000_000_000);
      const queryMethod = String(dbQuery.method || '').trim().toUpperCase();
      const routeKey = normalizeObservedRoute(String((dbQuery as any).route || ''));
      const matchedRoutes = routeKey ? findMatchedRuntimeRoutes(queryMethod, routeKey) : [];
      if (routeKey) runtimeRouteMatcherStats.db_queries_with_route += 1;
      if (routeKey && matchedRoutes.length > 0) {
        runtimeRouteMatcherStats.db_queries_matched += 1;
        recordRuntimeRouteMatch('db', routeKey, durationMs, lockWaitMs, matchedRoutes);
      }
      const signature = normalizeSqlSignature(String(dbQuery.sql || ''));
      const repeatedCount = signature ? (dbSignatureCounts.get(signature) || 0) : 0;
      const explainPlan = String(dbQuery.explain_plan || '');

      if (durationMs >= 120) findings.push('slow-db-query');
      if (lockWaitMs >= 40) findings.push('lock-contention');
      if (repeatedCount >= 4) findings.push('possible-n-plus-one');
      if (/\b(using temporary|filesort|seq scan|full scan|all)\b/i.test(explainPlan)) findings.push('db-plan-risk');
      if (findings.length === 0) continue;

      let symptomFit = 0;
      const symptomFitReasons: string[] = [];
      if (symptomSignal.family === 'performance') {
        symptomFit += 4;
        symptomFitReasons.push('performance-db-latency');
      }
      if (symptomSignal.family === 'event' && findings.includes('lock-contention')) {
        symptomFit += 1;
        symptomFitReasons.push('event-lock-contention');
      }
      if (symptomSignal.family === 'routing' && routeKey) {
        if (matchedRoutes.length > 0) {
          symptomFit += 2;
          symptomFitReasons.push('routing-db-route-pattern-match');
        } else {
          symptomFit += 1;
          symptomFitReasons.push('routing-db-route-signal');
        }
      }

      const baseScore = 2
        + Math.min(5, durationMs / 200)
        + Math.min(3, lockWaitMs / 150)
        + (repeatedCount >= 4 ? Math.min(2, repeatedCount / 5) : 0)
        + (rowsExamined > 0 ? Math.min(2, rowsExamined / 50_000) : 0);
      const confidence = round3(normalizeConfidence(
        Math.min(0.95, 0.53 + (durationMs >= 200 ? 0.1 : 0) + (lockWaitMs >= 75 ? 0.12 : 0) + (signature ? 0.07 : 0) + (matchedRoutes.length > 0 ? 0.1 : 0)),
        0.53,
      ));
      candidateLoops.push({
        kind: 'runtime_loop',
        score: baseScore + symptomFit,
        symptom_fit: symptomFit,
        confidence,
        confidence_reason: 'Derived from observed query duration/lock-wait metrics and repeated SQL signature frequency.',
        symptom_fit_reasons: symptomFitReasons,
        summary: `${routeKey || 'DB path'} observed ${durationMs}ms${lockWaitMs > 0 ? ` with ${lockWaitMs}ms lock wait` : ''}`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          db_query: dbQuery,
          signature: signature || null,
          repeated_signature_count: repeatedCount,
          explain_plan: explainPlan || null,
          matched_routes: toRuntimeRouteEvidence(matchedRoutes),
        },
      });
    }

    const scanFileSet = new Set<string>();
    const addScanFile = (filePathRaw: unknown) => {
      const filePath = normalizeRepoRelativePath(String(filePathRaw || ''));
      if (!filePath) return;
      if (!filePathTouchesPrefixes(filePath, pathPrefixes)) return;
      scanFileSet.add(filePath);
    };
    for (const symbol of Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols : []) {
      addScanFile(symbol?.filePath);
    }
    for (const symbol of Array.isArray(queryResult?.definitions) ? queryResult.definitions : []) {
      addScanFile(symbol?.filePath);
    }
    for (const file of Array.isArray(actionPlanResult?.files) ? actionPlanResult.files : []) {
      addScanFile(file?.filePath);
    }
    for (const hop of hops) {
      addScanFile(hop?.ui?.filePath);
      addScanFile(hop?.endpoint?.filePath);
      addScanFile(hop?.controller?.filePath);
    }

    const scannedPerfFiles: Array<{ filePath: string; metrics: any; score: number }> = [];
    const loopLineRegex = /\b(?:for(?:each)?|while)\s*\(|\bforeach\s*\(/;
    const linearLookupRegex = /\.(?:find|findIndex|some|filter)\s*\(|->(?:find|findOrFail|firstWhere)\s*\(|\barray_filter\s*\(/;
    const queryInLoopRegex = /->where\s*\(|::where\s*\(|\bDB::(?:table|select|statement)\s*\(|->(?:load|loadMissing)\s*\(/;
    const writeInLoopRegex = /->(?:save|update|delete)\s*\(|::(?:create|update|delete|upsert|insert)\s*\(|\bDB::insert\s*\(/;
    const noOpWriteRegex = /->(?:save|update)\s*\(\s*(?:\[\s*\])?\s*\)/;

    const scanTargets = Array.from(scanFileSet).slice(0, 10);
    const scanContents = await Promise.all(
      scanTargets.map(async (filePath) => {
        const resolved = resolvePathInsideRepo(repo.repoPath, filePath);
        if (!resolved) return null;
        try {
          const content = await fs.readFile(resolved.absolutePath, 'utf-8');
          return { filePath: resolved.relativePath, content };
        } catch {
          return null;
        }
      }),
    );

    for (const scannedFile of scanContents) {
      if (!scannedFile) continue;
      const { filePath, content } = scannedFile;

      const lines = content.split('\n');
      let loopCount = 0;
      let nestedLoopCount = 0;
      let linearLookups = 0;
      let queryInLoopCount = 0;
      let writeInLoopCount = 0;
      let noOpWriteCount = 0;
      let loopWindow = 0;
      for (const line of lines) {
        const codeLine = String(line || '').replace(/\/\/.*$/g, '').trim();
        if (!codeLine) {
          if (loopWindow > 0) loopWindow -= 1;
          continue;
        }

        const isLoopLine = loopLineRegex.test(codeLine);
        if (isLoopLine) {
          loopCount += 1;
          if (loopWindow > 0) nestedLoopCount += 1;
          loopWindow = Math.max(loopWindow, 8);
        } else if (loopWindow > 0) {
          loopWindow -= 1;
        }

        if (loopWindow <= 0) continue;
        if (linearLookupRegex.test(codeLine)) linearLookups += 1;
        if (queryInLoopRegex.test(codeLine)) queryInLoopCount += 1;
        if (writeInLoopRegex.test(codeLine)) writeInLoopCount += 1;
        if (noOpWriteRegex.test(codeLine)) noOpWriteCount += 1;
      }

      const costScore = (loopCount * 0.25)
        + (nestedLoopCount * 1.3)
        + (linearLookups * 0.7)
        + (queryInLoopCount * 1.5)
        + (writeInLoopCount * 1.0)
        + (noOpWriteCount * 0.9);

      if (costScore < 2) continue;

      scannedPerfFiles.push({
        filePath,
        score: round3(costScore),
        metrics: {
          loop_count: loopCount,
          nested_loop_count: nestedLoopCount,
          linear_lookups_in_loop: linearLookups,
          query_calls_in_loop: queryInLoopCount,
          write_calls_in_loop: writeInLoopCount,
          noop_writes_in_loop: noOpWriteCount,
        },
      });
    }

    for (const perf of scannedPerfFiles.slice(0, Math.max(4, limitCandidates))) {
      const findings = ['hot-path-cost'];
      if (perf.metrics.linear_lookups_in_loop > 0) findings.push('repeated-linear-lookups');
      if (perf.metrics.query_calls_in_loop > 0) findings.push('possible-n-plus-one');
      if (perf.metrics.write_calls_in_loop > 0) findings.push('write-amplification');
      if (perf.metrics.noop_writes_in_loop > 0) findings.push('no-op-write-churn');

      let symptomFit = 0;
      const symptomFitReasons: string[] = [];
      if (symptomSignal.family === 'performance') {
        symptomFit += 3;
        symptomFitReasons.push('performance-static-hotpath');
      }
      const confidence = Number(normalizeConfidence(Math.min(
        0.9,
        0.42
        + Math.min(0.3, perf.score / 10)
        + (perf.metrics.query_calls_in_loop > 0 ? 0.08 : 0)
        + (perf.metrics.nested_loop_count > 0 ? 0.06 : 0),
      ), 0.42).toFixed(3));
      candidateLoops.push({
        kind: 'perf_loop',
        score: perf.score + symptomFit,
        symptom_fit: symptomFit,
        confidence,
        confidence_reason: 'Static hot-path heuristics over loop/query/write patterns in scoped files.',
        symptom_fit_reasons: symptomFitReasons,
        summary: `${perf.filePath} has hot-path complexity signals (score=${perf.score.toFixed(2)})`,
        findings,
        fix_recipes: buildFixRecipes(findings),
        evidence: {
          filePath: perf.filePath,
          metrics: perf.metrics,
        },
      });
    }

    const scoreRouteCoverage = (coverage: RuntimeRouteCoverage | undefined): number => {
      if (!coverage) return 0;
      const matchCount = (coverage.request_match_count || 0) + (coverage.db_match_count || 0);
      if (matchCount <= 0) return 0;
      const coverageScore = Math.min(1, matchCount / 4);
      const confidenceScore = normalizeConfidence(computeAverage(coverage.confidence_samples || []), 0.5);
      const sourceScore = Math.min(1, (coverage.sources?.size || 0) / 3);
      const latencyScore = Math.min(
        1,
        Math.max(
          (coverage.max_request_duration_ms || 0) / 1200,
          (coverage.max_db_duration_ms || 0) / 350,
          (coverage.max_lock_wait_ms || 0) / 150,
        ),
      );
      return round3(normalizeConfidence(
        (coverageScore * 0.45)
        + (confidenceScore * 0.35)
        + (sourceScore * 0.1)
        + (latencyScore * 0.1),
        0,
      ));
    };
    const scoreCandidateRouteAlignment = (candidate: any): number => {
      const hopKeys = new Set<string>();
      const addHopKey = (endpointUid: unknown, controllerUid: unknown): void => {
        const endpoint = String(endpointUid || '').trim();
        const controller = String(controllerUid || '').trim();
        if (!endpoint && !controller) return;
        hopKeys.add(buildHopRouteKey(endpoint, controller));
      };

      if (candidate?.kind === 'http_loop') {
        addHopKey(candidate?.evidence?.hop?.endpoint?.uid, candidate?.evidence?.hop?.controller?.uid);
      }

      const matchedRoutes = Array.isArray(candidate?.evidence?.matched_routes) ? candidate.evidence.matched_routes : [];
      for (const route of matchedRoutes) {
        addHopKey(route?.endpoint?.uid, route?.controller?.uid);
      }

      if (hopKeys.size === 0) return 0;
      const coverageScores = Array.from(hopKeys)
        .map(hopKey => scoreRouteCoverage(runtimeRouteCoverageByHopKey.get(hopKey)))
        .filter(score => score > 0);
      if (coverageScores.length === 0) return 0;

      const matchedRouteBoost = matchedRoutes.length > 0 ? Math.min(0.15, matchedRoutes.length * 0.03) : 0;
      return round3(normalizeConfidence(Math.min(1, Math.max(...coverageScores) + matchedRouteBoost), 0));
    };
    const rankedCandidates = Array.from(new Map(
      candidateLoops
      .map(candidate => ({
        ...candidate,
        route_alignment: scoreCandidateRouteAlignment(candidate),
      }))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.symptom_fit !== left.symptom_fit) return right.symptom_fit - left.symptom_fit;
        if (toFiniteNumber(right.route_alignment, 0) !== toFiniteNumber(left.route_alignment, 0)) {
          return toFiniteNumber(right.route_alignment, 0) - toFiniteNumber(left.route_alignment, 0);
        }
        if (right.confidence !== left.confidence) return right.confidence - left.confidence;
        return left.summary.localeCompare(right.summary);
      })
      .map(candidate => [`${String(candidate.kind || '')}|${String(candidate.summary || '')}`, candidate]),
    ).values())
      .slice(0, limitCandidates);
    const convergedCandidateCount = rankedCandidates.filter(candidate => toFiniteNumber(candidate?.route_alignment, 0) > 0).length;
    const topRankedCandidate = rankedCandidates[0] || null;
    const topConvergedCandidate = rankedCandidates.find(candidate => toFiniteNumber(candidate?.route_alignment, 0) > 0) || null;
    const buildConvergedAction = (candidate: any): string => {
      const alignment = round3(normalizeConfidence(candidate?.route_alignment, 0));
      const matchedRoutes = Array.isArray(candidate?.evidence?.matched_routes) ? candidate.evidence.matched_routes : [];
      const topMatchedRoute = matchedRoutes[0] || null;
      const controllerName = String(
        topMatchedRoute?.controller?.name
        || candidate?.evidence?.hop?.controller?.name
        || candidate?.evidence?.matched_routes?.[0]?.controller?.name
        || '',
      ).trim();
      const endpointName = String(
        topMatchedRoute?.endpoint?.name
        || candidate?.evidence?.hop?.endpoint?.name
        || candidate?.evidence?.matched_routes?.[0]?.endpoint?.name
        || '',
      ).trim();
      const targetLabel = controllerName || endpointName || String(candidate?.summary || 'top candidate').trim();
      const routeLabel = (() => {
        if (!topMatchedRoute) return '';
        const method = String(topMatchedRoute?.method || '').trim().toUpperCase();
        const pattern = String(topMatchedRoute?.pattern || '').trim();
        if (method && pattern) return `${method} ${pattern}`;
        return pattern;
      })();
      if (routeLabel) {
        return `Start with converged candidate (alignment ${alignment}): open context() for ${targetLabel}, validate ${routeLabel} runtime overlap, then patch this loop first.`;
      }
      return `Start with converged candidate (alignment ${alignment}): open context() for ${targetLabel} and patch this highest-convergence loop first.`;
    };
    const buildRankedAction = (candidate: any): string => {
      const targetLabel = String(
        candidate?.evidence?.hop?.controller?.name
        || candidate?.evidence?.hop?.endpoint?.name
        || candidate?.summary
        || 'top candidate',
      ).trim();
      return `Start with top-ranked candidate: open context() for ${targetLabel} and validate evidence before patching.`;
    };
    const buildPrioritizedCandidate = (candidate: any, source: 'converged' | 'ranked'): any => {
      if (!candidate) return null;
      const candidateIndex = rankedCandidates.findIndex((entry: any) =>
        String(entry?.kind || '') === String(candidate?.kind || '')
        && String(entry?.summary || '') === String(candidate?.summary || '')
      );
      const matchedRoutes = Array.isArray(candidate?.evidence?.matched_routes) ? candidate.evidence.matched_routes : [];
      const topMatchedRoute = matchedRoutes[0] || null;
      const hopController = candidate?.evidence?.hop?.controller || null;
      const hopEndpoint = candidate?.evidence?.hop?.endpoint || null;
      const selectedController = topMatchedRoute?.controller || hopController || null;
      const selectedEndpoint = topMatchedRoute?.endpoint || hopEndpoint || null;
      const nextAction = source === 'converged'
        ? buildConvergedAction(candidate)
        : buildRankedAction(candidate);
      return {
        source,
        candidate_index: candidateIndex >= 0 ? candidateIndex : 0,
        kind: candidate.kind,
        summary: candidate.summary,
        score: round3(toFiniteNumber(candidate.score, 0)),
        symptom_fit: round3(toFiniteNumber(candidate.symptom_fit, 0)),
        confidence: round3(normalizeConfidence(candidate.confidence, 0)),
        route_alignment: round3(normalizeConfidence(candidate.route_alignment, 0)),
        findings: Array.isArray(candidate.findings) ? candidate.findings.slice(0, 8) : [],
        fix_recipe_ids: Array.isArray(candidate.fix_recipes) ? candidate.fix_recipes.map((item: any) => String(item?.id || '').trim()).filter(Boolean).slice(0, 8) : [],
        endpoint: selectedEndpoint ? {
          uid: selectedEndpoint.uid,
          name: selectedEndpoint.name,
          filePath: selectedEndpoint.filePath,
          startLine: selectedEndpoint.startLine,
        } : null,
        controller: selectedController ? {
          uid: selectedController.uid,
          name: selectedController.name,
          filePath: selectedController.filePath,
          startLine: selectedController.startLine,
        } : null,
        route: topMatchedRoute ? {
          method: topMatchedRoute.method,
          pattern: topMatchedRoute.pattern,
          source: topMatchedRoute.source,
          confidence: round3(normalizeConfidence(topMatchedRoute.confidence, 0)),
        } : null,
        next_action: nextAction,
      };
    };
    const prioritizedCandidate = topConvergedCandidate
      ? buildPrioritizedCandidate(topConvergedCandidate, 'converged')
      : (topRankedCandidate ? buildPrioritizedCandidate(topRankedCandidate, 'ranked') : null);

    const siblingDiff = (() => {
      const precedents = Array.isArray(precedentPack?.precedents) ? precedentPack.precedents : [];
      const slicePrecedent = precedents.find((entry: any) => entry?.kind === 'slice' && entry?.anchor);
      if (!slicePrecedent || !targetSlice) return null;

      const example = Array.isArray(slicePrecedent.examples) ? slicePrecedent.examples[0] : null;
      if (!example) return null;

      const targetClosedSlots = new Set((Array.isArray(targetSlice.closed_slots) ? targetSlice.closed_slots : []).map((slot: any) => String(slot || '').trim()).filter(Boolean));
      const targetRoles = new Set((Array.isArray(targetSlice.roles) ? targetSlice.roles : []).map((role: any) => String(role || '').trim()).filter(Boolean));
      const exampleClosedSlots = (Array.isArray(example.closed_slots) ? example.closed_slots : []).map((slot: any) => String(slot || '').trim()).filter(Boolean);
      const exampleRoles = (Array.isArray(example.roles) ? example.roles : []).map((role: any) => String(role || '').trim()).filter(Boolean);

      return {
        signature: String(slicePrecedent.signature || ''),
        target_slice: {
          uid: targetSlice.uid,
          label: targetSlice.label,
          slice_type: targetSlice.slice_type,
          closure_score: targetSlice.closure_score,
        },
        precedent_anchor: slicePrecedent.anchor,
        precedent_example: example,
        slot_diff: {
          missing_from_target: exampleClosedSlots.filter((slot: string) => !targetClosedSlots.has(slot)),
        },
        role_diff: {
          missing_from_target: exampleRoles.filter((role: string) => !targetRoles.has(role)),
        },
      };
    })();

    const hypotheses: string[] = [];
    for (const candidate of rankedCandidates.slice(0, 5)) {
      if (candidate.findings.includes('no-role-grants')) {
        hypotheses.push('Permission slug resolves, but no role grant closure exists for the affected endpoint.');
      } else if (candidate.findings.includes('missing-permission-closure')) {
        hypotheses.push('Controller flow may bypass expected permission closure.');
      } else if (candidate.findings.includes('missing-cache-coverage')) {
        hypotheses.push('Mutation path appears to miss invalidation/writeback for one or more active queries.');
      } else if (candidate.findings.includes('slice-closure-gaps')) {
        hypotheses.push('Feature slice closure is below sibling expectations; missing companions likely drive symptom.');
      } else if (candidate.findings.includes('missing-endpoint-link') || candidate.findings.includes('missing-controller-link')) {
        hypotheses.push('Routing chain has a missing/ambiguous hop between UI endpoint call and backend controller.');
      } else if (candidate.findings.includes('lock-contention')) {
        hypotheses.push('Observed lock waits suggest transaction/lock scope contention on the request path.');
      } else if (candidate.findings.includes('possible-n-plus-one')) {
        hypotheses.push('Repeated query signatures or query-inside-loop patterns indicate likely N+1 amplification.');
      } else if (candidate.findings.includes('hot-path-cost')) {
        hypotheses.push('Hot-path cost model flags repeated loop scans/writes as likely timeout contributors.');
      }
    }

    const nextActions: string[] = [];
    if (prioritizedCandidate?.source === 'converged' && String(prioritizedCandidate?.next_action || '').trim()) {
      nextActions.push(String(prioritizedCandidate.next_action));
    }
    nextActions.push(
      'Open candidate evidence spans with context() on top-ranked symbols.',
      'Run impact() on the first broken-loop symbol to map direct dependents.',
      'Compare target slice vs sibling precedent before editing shared utilities.',
      'After edits, run review_mode(scope=unstaged) with include_slice_stencil=true.',
    );
    if (failingTests.length > 0) {
      nextActions.push('Re-run failing tests after applying the highest-confidence loop fix.');
    }
    if (!hasRuntimeObservations) {
      nextActions.push('Attach runtime_observations (request spans, DB timings, lock waits) for stronger root-cause ranking.');
    }
    if (!hasPrecedentResults() && includePrecedents) {
      nextActions.push('Precedent retrieval returned empty; rely on action_plan hops + context() before editing.');
    }

    const timeline = hops.slice(0, limitHops).map((hop: any, index: number) => {
      const hopRouteKey = buildHopRouteKey(hop?.endpoint?.uid, hop?.controller?.uid);
      return {
        step: index + 1,
        ui: hop?.ui ? {
          uid: hop.ui.uid,
          name: hop.ui.name,
          filePath: hop.ui.filePath,
          startLine: hop.ui.startLine,
        } : null,
        http: hop?.http ? {
          reason: hop.http.reason,
          confidence: hop.http.confidence,
        } : null,
        endpoint: hop?.endpoint ? {
          uid: hop.endpoint.uid,
          name: hop.endpoint.name,
          filePath: hop.endpoint.filePath,
          startLine: hop.endpoint.startLine,
        } : null,
        controller: hop?.controller ? {
          uid: hop.controller.uid,
          name: hop.controller.name,
          filePath: hop.controller.filePath,
          startLine: hop.controller.startLine,
        } : null,
        permissions: Array.isArray(hop?.permissions) ? hop.permissions.map((grant: any) => ({
          permission: grant?.permission || null,
          role_count: Array.isArray(grant?.roles) ? grant.roles.length : 0,
        })) : [],
        runtime_route_matches: renderRuntimeRouteCoverage(runtimeRouteCoverageByHopKey.get(hopRouteKey)),
      };
    });

    const indexStatus = await getIndexStatus(repo);
    const precedentCount = Array.isArray(precedentPack?.precedents) ? precedentPack.precedents.length : 0;
    const routeObservationsWithPath = runtimeRouteMatcherStats.request_spans_with_route + runtimeRouteMatcherStats.db_queries_with_route;
    const routeObservationsMatched = runtimeRouteMatcherStats.request_spans_matched + runtimeRouteMatcherStats.db_queries_matched;
    const runtimeRouteMatchRatio = routeObservationsWithPath > 0
      ? (routeObservationsMatched / routeObservationsWithPath)
      : 0;
    const hopRouteCoverage = hops.map((hop: any) => runtimeRouteCoverageByHopKey.get(buildHopRouteKey(hop?.endpoint?.uid, hop?.controller?.uid)));
    const hopsWithRuntimeMatches = hopRouteCoverage.filter(coverage =>
      ((coverage?.request_match_count || 0) + (coverage?.db_match_count || 0)) > 0
    ).length;
    const runtimeRouteConfidenceSamples = hopRouteCoverage.flatMap(coverage => coverage?.confidence_samples || []);
    const coverageWarnings: string[] = [];
    if (indexStatus.isStale) {
      coverageWarnings.push('Index is stale versus HEAD; refresh before trusting complete root-cause ranking.');
    }
    if (!hasRuntimeObservations) {
      coverageWarnings.push('No runtime observations provided; performance root-cause confidence is capped.');
    } else if (runtimeObservationSource === 'snapshot' || runtimeObservationSource === 'params+snapshot') {
      coverageWarnings.push('Runtime observations were auto-loaded from snapshot sidecar files.');
    }
    if (includePrecedents && precedentCount === 0) {
      coverageWarnings.push('No precedents resolved; anatomy-fit findings rely on static signals only.');
    }
    if (hasRuntimeObservations && routeObservationsWithPath > 0 && routeObservationsMatched === 0 && runtimeRoutePatterns.length > 0) {
      coverageWarnings.push('Runtime observations did not match indexed hop routes; routing confidence remains hop-edge only.');
    }
    if (hops.length === 0) {
      coverageWarnings.push('No cross-stack HTTP hops found for this anchor query; routing evidence is limited.');
    }
    if (scannedPerfFiles.length === 0) {
      coverageWarnings.push('Static hot-path scan found no strong loop/query/write signals in scanned files.');
    }

    const hopOwnershipConfidence = hops.length > 0
      ? computeAverage(hops.map((hop: any) => normalizeConfidence(hop?.http?.confidence, 0.7)))
      : 0.35;
    const runtimeOwnershipConfidence = runtimeRouteConfidenceSamples.length > 0
      ? computeAverage(runtimeRouteConfidenceSamples.map(value => normalizeConfidence(value, 0.5)))
      : hopOwnershipConfidence;
    const runtimeEvidenceWeight = routeObservationsWithPath > 0 ? Math.min(0.6, 0.2 + (runtimeRouteMatchRatio * 0.4)) : 0;
    const hopCoverageWeight = hops.length > 0 ? Math.min(0.2, (hopsWithRuntimeMatches / hops.length) * 0.2) : 0;
    const ownershipBlendWeight = Math.min(0.7, runtimeEvidenceWeight + hopCoverageWeight);
    const routeOwnershipConfidence = (hopOwnershipConfidence * (1 - ownershipBlendWeight))
      + (runtimeOwnershipConfidence * ownershipBlendWeight);
    const rootCauseConfidence = rankedCandidates.length > 0
      ? computeAverage(rankedCandidates.slice(0, 3).map(candidate => normalizeConfidence(candidate.confidence, 0)))
      : 0.3;
    const recipeCoverage = rankedCandidates.length > 0
      ? computeAverage(rankedCandidates.slice(0, 5).map(candidate => candidate.fix_recipes.length > 0 ? 1 : 0))
      : 0;
    const fixRecommendationConfidence = Math.min(0.92, 0.35 + (recipeCoverage * 0.45) + (hasRuntimeObservations ? 0.1 : 0));

    const confidenceBreakdown = {
      claims: [
        {
          claim: 'route_ownership',
          confidence: round3(normalizeConfidence(routeOwnershipConfidence, 0.35)),
          reason: routeObservationsMatched > 0
            ? 'Based on hop edge confidence blended with matched runtime route-pattern evidence.'
            : hops.length > 0
            ? 'Based on HTTP + endpoint/controller edge confidence from top hops.'
            : 'No top hops available for ownership confidence.',
        },
        {
          claim: 'root_cause_localization',
          confidence: round3(normalizeConfidence(rootCauseConfidence, 0.3)),
          reason: rankedCandidates.length > 0
            ? 'Based on weighted symptom fit and candidate evidence confidence.'
            : 'No ranked candidates available for localization confidence.',
        },
        {
          claim: 'fix_recommendation',
          confidence: round3(normalizeConfidence(fixRecommendationConfidence, 0.35)),
          reason: hasRuntimeObservations
            ? 'Based on candidate fix recipe coverage plus runtime evidence availability.'
            : 'Based on static evidence only; runtime observations were not provided.',
        },
      ],
    };

    const actionChecks = Array.isArray(actionPlanResult?.checks) ? actionPlanResult.checks : [];
    const verificationChecks = Array.from(new Set([
      ...failingTests.slice(0, 6).map(testName => `Re-run failing test: ${testName}`),
      ...actionChecks.slice(0, 4),
      'Run review_mode(scope=unstaged, include_slice_stencil=true, include_evidence_spans=true) after patch.',
    ])).slice(0, 10);

    const verificationContract = {
      checks: verificationChecks,
      post_edit_review: {
        tool: 'review_mode',
        params: {
          scope: 'unstaged',
          ...(pathPrefixes.length > 0 ? { path_prefixes: pathPrefixes } : {}),
          include_slice_stencil: true,
          include_evidence_spans: true,
        },
      },
    };

    return {
      status: 'ok',
      repo: repo.name,
      query: seedQuery,
      symptom: symptomText || undefined,
      debug: {
        classification: symptomSignal,
        anchors: {
          query_plan: queryResult?.query_plan || null,
          target_slice: targetSlice || null,
          top_processes: Array.isArray(queryResult?.processes) ? queryResult.processes.slice(0, 3) : [],
          top_symbols: [
            ...(Array.isArray(queryResult?.process_symbols) ? queryResult.process_symbols.slice(0, 12) : []),
            ...(Array.isArray(queryResult?.definitions) ? queryResult.definitions.slice(0, 6) : []),
          ],
          hops: hops.slice(0, limitHops),
          cache_effects: cacheEffects.slice(0, 5),
        },
        runtime_observations: {
          request_spans: runtimeObservations.request_spans.slice(0, 20),
          db_queries: runtimeObservations.db_queries.slice(0, 20),
          payload_shapes: runtimeObservations.payload_shapes.slice(0, 20),
          source: runtimeObservationSource,
          snapshot_generated_at: runtimeSnapshot.generatedAt || '',
          source_files: Array.isArray(runtimeSnapshot.source_files) ? runtimeSnapshot.source_files : [],
        },
        prioritized_candidate: prioritizedCandidate,
        timeline,
        candidates: rankedCandidates,
        sibling_diff: siblingDiff,
        hypotheses: Array.from(new Set(hypotheses)).slice(0, 8),
        next_actions: nextActions.slice(0, 8),
        confidence_breakdown: confidenceBreakdown,
        coverage: {
          freshness: {
            is_stale: indexStatus.isStale,
            indexed_at: indexStatus.indexedAt,
            indexed_commit: indexStatus.indexedCommit || null,
            head_commit: indexStatus.headCommit || null,
          },
          runtime_observations: hasRuntimeObservations,
          runtime_source: runtimeObservationSource,
          runtime_snapshot_generated_at: runtimeSnapshot.generatedAt || '',
          runtime_source_files: Array.isArray(runtimeSnapshot.source_files) ? runtimeSnapshot.source_files : [],
          precedents: precedentCount,
          hops: hops.length,
          route_index_patterns: runtimeRoutePatterns.length,
          hops_with_runtime_matches: hopsWithRuntimeMatches,
          converged_candidates: convergedCandidateCount,
          runtime_route_matches: {
            request_spans_with_route: runtimeRouteMatcherStats.request_spans_with_route,
            request_spans_matched: runtimeRouteMatcherStats.request_spans_matched,
            db_queries_with_route: runtimeRouteMatcherStats.db_queries_with_route,
            db_queries_matched: runtimeRouteMatcherStats.db_queries_matched,
            match_ratio: round3(runtimeRouteMatchRatio),
          },
          cache_effects: cacheEffects.length,
          static_perf_scan_files: scannedPerfFiles.length,
          warnings: coverageWarnings,
        },
        verification_contract: verificationContract,
      },
      _debug_mode: {
        knobs: {
          limit_candidates: limitCandidates,
          limit_hops: limitHops,
          include_precedents: includePrecedents,
          path_prefixes: pathPrefixes,
          runtime_observations: hasRuntimeObservations,
          runtime_source: runtimeObservationSource,
          scanned_perf_files: scannedPerfFiles.length,
          route_index_patterns: runtimeRoutePatterns.length,
          route_match_ratio: round3(runtimeRouteMatchRatio),
          route_converged_candidates: convergedCandidateCount,
        },
      },
    };

}
