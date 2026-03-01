import {
  loadRuntimeObservationSnapshot,
  RuntimeDbQuery,
  RuntimeObservationSnapshot,
  RuntimePayloadShape,
  RuntimeRequestSpan,
} from '../ingestion/runtime-observation-store.js';
import {
  BrainTickInput,
  ContradictionWitness,
  CoverageWitness,
  ObservedLoop,
  PlanEnvelope,
  ProbeRequest,
  RuntimeReconciliationOutcome,
  RuntimeTargetFamily,
  RuntimeTruthSummary,
  RuntimeWitnessCard,
} from './types.js';

const MAX_WITNESSES = 20;
const MAX_REQUEST_WITNESSES = 8;
const MAX_DB_WITNESSES = 8;
const MAX_PAYLOAD_WITNESSES = 6;
const MAX_OBSERVED_LOOPS = 8;

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const dedupe = <T>(items: T[]): T[] => Array.from(new Set(items));

const inferProbeReason = (mode: string): ProbeRequest['reason'] => {
  if (mode === 'debug') return 'debug-symptom';
  if (mode === 'implement') return 'implement-verification';
  if (mode === 'review') return 'review-uncertainty';
  return 'eval-canary';
};

const inferProbeFamilies = (files: string[], mode: string): RuntimeTargetFamily[] => {
  const families = new Set<RuntimeTargetFamily>();
  if (mode === 'debug') {
    families.add('http');
    families.add('db');
    families.add('exception');
  }
  if (mode === 'implement' || mode === 'review') {
    families.add('shape');
    families.add('cache');
  }

  for (const filePath of files) {
    const normalized = normalizePath(filePath).toLowerCase();
    if (!normalized) continue;
    if (normalized.includes('route') || normalized.includes('controller') || normalized.includes('http')) {
      families.add('http');
      families.add('shape');
    }
    if (normalized.includes('auth') || normalized.includes('policy') || normalized.includes('permission')) {
      families.add('auth');
    }
    if (normalized.includes('cache') || normalized.includes('query-key') || normalized.includes('query_key')) {
      families.add('cache');
    }
    if (normalized.includes('event') || normalized.includes('queue') || normalized.includes('job')) {
      families.add('event');
    }
    if (normalized.includes('db') || normalized.includes('model') || normalized.includes('sql')) {
      families.add('db');
    }
  }

  if (families.size === 0) families.add('http');
  return Array.from(families);
};

const normalizeProbeRequest = (probe: ProbeRequest): ProbeRequest => {
  const targetFamilies = probe.targetFamilies.filter(Boolean).slice(0, 8);
  const scopeFiles = dedupe((probe.scope?.files || []).map(normalizePath).filter(Boolean)).slice(0, 12);
  const scopeTests = dedupe((probe.scope?.tests || []).map(item => String(item || '').trim()).filter(Boolean)).slice(0, 20);
  const scopeEndpoints = dedupe((probe.scope?.endpoints || []).map(item => String(item || '').trim()).filter(Boolean)).slice(0, 20);

  return {
    reason: probe.reason,
    anchors: dedupe((probe.anchors || []).map(item => String(item || '').trim()).filter(Boolean)).slice(0, 10),
    targetFamilies: targetFamilies.length > 0 ? targetFamilies : ['http'],
    scope: {
      ...(scopeTests.length > 0 ? { tests: scopeTests } : {}),
      ...(scopeEndpoints.length > 0 ? { endpoints: scopeEndpoints } : {}),
      ...(scopeFiles.length > 0 ? { files: scopeFiles } : {}),
    },
    ttlMinutes: Math.max(5, Math.min(240, Number(probe.ttlMinutes) || 30)),
  };
};

const buildFallbackProbePlan = (input: BrainTickInput, plan: PlanEnvelope): ProbeRequest[] => {
  const scopeFiles = dedupe(
    (plan.anchors || [])
      .map(anchor => normalizePath(anchor.filePath || ''))
      .filter(Boolean)
      .concat((input.changedPaths || []).map(normalizePath).filter(Boolean)),
  ).slice(0, 10);

  if (scopeFiles.length === 0) return [];

  return [
    {
      reason: inferProbeReason(plan.mode),
      anchors: (plan.anchors || []).slice(0, 6).map(anchor => anchor.id),
      targetFamilies: inferProbeFamilies(scopeFiles, plan.mode),
      scope: {
        files: scopeFiles,
      },
      ttlMinutes: plan.mode === 'debug' ? 45 : 30,
    },
  ];
};

export const buildProbePlan = (input: BrainTickInput, plan: PlanEnvelope): ProbeRequest[] => {
  const requested = Array.isArray(plan.requestedProbes) ? plan.requestedProbes : [];
  const source = requested.length > 0 ? requested : buildFallbackProbePlan(input, plan);
  return source.map(normalizeProbeRequest);
};

const toSqlFingerprint = (value: string): string => {
  return String(value || '')
    .toLowerCase()
    .replace(/'[^']*'/g, '?')
    .replace(/"[^"]*"/g, '?')
    .replace(/\b\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
};

const chooseReconciliation = (
  matchedAnchor: boolean,
  hintCount: number,
  contradictionSignal: boolean,
  hiddenBranchSignal: boolean,
): RuntimeReconciliationOutcome => {
  if (contradictionSignal) return 'contradicts-static-expectation';
  if (matchedAnchor) return 'supports-static-edge';
  if (hintCount > 0) return 'fills-static-gap';
  if (hiddenBranchSignal) return 'reveals-hidden-dynamic-branch';
  return 'reveals-dead-static-only-path';
};

const toEvidence = (fileHints: string[], summary: string, confidence: number) => {
  if (fileHints.length === 0) {
    return [{ summary, confidence }];
  }
  return fileHints.map(filePath => ({
    filePath,
    summary,
    confidence,
  }));
};

const buildRequestWitnesses = (
  spans: RuntimeRequestSpan[],
  freshness: string,
  anchorFiles: Set<string>,
): RuntimeWitnessCard[] => {
  const witnesses: RuntimeWitnessCard[] = [];
  for (const span of spans.slice(0, MAX_REQUEST_WITNESSES)) {
    const route = String(span.route || '').trim() || '(unknown-route)';
    const method = String(span.method || '').trim().toUpperCase() || 'REQUEST';
    const fileHints = dedupe((span.file_path_hints || []).map(normalizePath).filter(Boolean));
    const matchedAnchor = fileHints.some(file => anchorFiles.has(file));
    const contradictionSignal = Number(span.status || 0) >= 500;
    const hiddenBranchSignal = Number(span.duration_ms || 0) >= 1500 || Number(span.payload_bytes || 0) >= 200_000;
    const reconciliation = chooseReconciliation(matchedAnchor, fileHints.length, contradictionSignal, hiddenBranchSignal);
    const claim = `${method} ${route} observed at ${Number(span.duration_ms || 0)}ms`;
    const confidence = matchedAnchor ? 0.9 : contradictionSignal ? 0.88 : 0.72;

    witnesses.push({
      id: `runtime-witness:req:${method}:${route}:${Number(span.duration_ms || 0)}`,
      sliceId: matchedAnchor ? 'static-anchor' : 'runtime-discovery',
      claim,
      evidence: toEvidence(fileHints, `status=${Number(span.status || 0) || 'n/a'}`, confidence),
      observedChain: [
        `${method} ${route}`,
        `status:${Number(span.status || 0) || 'n/a'}`,
        `duration:${Number(span.duration_ms || 0)}ms`,
      ],
      contradictions: contradictionSignal ? [`HTTP ${Number(span.status || 0)} indicates runtime contradiction`] : [],
      freshness,
      confidence,
      reconciliation,
    });
  }
  return witnesses;
};

const buildDbWitnesses = (
  queries: RuntimeDbQuery[],
  freshness: string,
  anchorFiles: Set<string>,
): RuntimeWitnessCard[] => {
  const witnesses: RuntimeWitnessCard[] = [];
  for (const query of queries.slice(0, MAX_DB_WITNESSES)) {
    const fingerprint = toSqlFingerprint(String(query.sql || 'query'));
    const fileHints = dedupe((query.file_path_hints || []).map(normalizePath).filter(Boolean));
    const matchedAnchor = fileHints.some(file => anchorFiles.has(file));
    const contradictionSignal = Number(query.lock_wait_ms || 0) >= 1000;
    const hiddenBranchSignal = Number(query.duration_ms || 0) >= 900 || Number(query.rows_examined || 0) >= 10000;
    const reconciliation = chooseReconciliation(matchedAnchor, fileHints.length, contradictionSignal, hiddenBranchSignal);
    const claim = `DB ${fingerprint || '(unknown)'} observed at ${Number(query.duration_ms || 0)}ms`;
    const confidence = matchedAnchor ? 0.86 : contradictionSignal ? 0.84 : 0.7;

    witnesses.push({
      id: `runtime-witness:db:${fingerprint || 'unknown'}:${Number(query.duration_ms || 0)}`,
      sliceId: matchedAnchor ? 'static-anchor' : 'runtime-discovery',
      claim,
      evidence: toEvidence(
        fileHints,
        `rows=${Number(query.rows_examined || 0) || 'n/a'} lock_wait_ms=${Number(query.lock_wait_ms || 0) || 'n/a'}`,
        confidence,
      ),
      observedChain: [
        'db-query',
        `duration:${Number(query.duration_ms || 0)}ms`,
        `lock_wait:${Number(query.lock_wait_ms || 0) || 0}ms`,
      ],
      contradictions: contradictionSignal ? [`DB lock wait ${Number(query.lock_wait_ms || 0)}ms exceeds threshold`] : [],
      freshness,
      confidence,
      reconciliation,
    });
  }
  return witnesses;
};

const buildPayloadWitnesses = (
  shapes: RuntimePayloadShape[],
  freshness: string,
  anchorFiles: Set<string>,
): RuntimeWitnessCard[] => {
  const witnesses: RuntimeWitnessCard[] = [];
  for (const shape of shapes.slice(0, MAX_PAYLOAD_WITNESSES)) {
    const pathLabel = String(shape.path || '(unknown-path)');
    const fileHints = dedupe((shape.file_path_hints || []).map(normalizePath).filter(Boolean));
    const matchedAnchor = fileHints.some(file => anchorFiles.has(file));
    const contradictionSignal = Number(shape.item_count || 0) >= 1000 && Number(shape.bytes || 0) === 0;
    const hiddenBranchSignal = Number(shape.bytes || 0) >= 250_000 || Number(shape.item_count || 0) >= 500;
    const reconciliation = chooseReconciliation(matchedAnchor, fileHints.length, contradictionSignal, hiddenBranchSignal);
    const confidence = matchedAnchor ? 0.82 : 0.68;

    witnesses.push({
      id: `runtime-witness:payload:${pathLabel}:${Number(shape.item_count || 0)}:${Number(shape.bytes || 0)}`,
      sliceId: matchedAnchor ? 'static-anchor' : 'runtime-discovery',
      claim: `Payload shape for ${pathLabel} observed (items=${Number(shape.item_count || 0) || 0}, bytes=${Number(shape.bytes || 0) || 0})`,
      evidence: toEvidence(fileHints, `keys=${(shape.keys || []).slice(0, 6).join(',') || 'n/a'}`, confidence),
      observedChain: [
        `payload:${pathLabel}`,
        `items:${Number(shape.item_count || 0) || 0}`,
        `bytes:${Number(shape.bytes || 0) || 0}`,
      ],
      contradictions: contradictionSignal ? ['Payload item count is high while byte size is missing/zero'] : [],
      freshness,
      confidence,
      reconciliation,
    });
  }
  return witnesses;
};

const buildObservedLoops = (spans: RuntimeRequestSpan[]): ObservedLoop[] => {
  const groups = new Map<string, { count: number; total: number; max: number }>();
  for (const span of spans) {
    const route = String(span.route || '').trim();
    if (!route) continue;
    const key = `${String(span.method || '').trim().toUpperCase() || 'REQUEST'} ${route}`;
    const duration = Number(span.duration_ms || 0);
    const existing = groups.get(key) || { count: 0, total: 0, max: 0 };
    existing.count += 1;
    existing.total += duration;
    existing.max = Math.max(existing.max, duration);
    groups.set(key, existing);
  }

  return Array.from(groups.entries())
    .map(([route, stats]) => ({
      id: `observed-loop:${route}`,
      route,
      hitCount: stats.count,
      averageDurationMs: stats.count > 0 ? Number((stats.total / stats.count).toFixed(2)) : 0,
      maxDurationMs: stats.max,
    }))
    .sort((a, b) => b.maxDurationMs - a.maxDurationMs)
    .slice(0, MAX_OBSERVED_LOOPS);
};

const buildCoverageWitness = (anchorFiles: Set<string>, witnesses: RuntimeWitnessCard[]): CoverageWitness => {
  const covered = new Set<string>();
  for (const witness of witnesses) {
    for (const evidence of witness.evidence) {
      const filePath = normalizePath(evidence.filePath || '');
      if (filePath && anchorFiles.has(filePath)) covered.add(filePath);
    }
  }
  const anchorList = Array.from(anchorFiles);
  const uncoveredAnchors = anchorList.filter(file => !covered.has(file));
  const anchorCount = anchorList.length;
  const coveredAnchors = covered.size;
  const coverageRatio = anchorCount === 0 ? 0 : Number((coveredAnchors / anchorCount).toFixed(3));
  return {
    id: 'coverage-witness:anchors',
    anchorCount,
    coveredAnchors,
    uncoveredAnchors: uncoveredAnchors.slice(0, 25),
    coverageRatio,
  };
};

const buildContradictionWitnesses = (witnesses: RuntimeWitnessCard[]): ContradictionWitness[] => {
  const contradictions: ContradictionWitness[] = [];
  for (const witness of witnesses) {
    if (witness.contradictions.length === 0) continue;
    contradictions.push({
      id: `contradiction:${witness.id}`,
      witnessId: witness.id,
      reason: witness.contradictions[0],
      severity: witness.reconciliation === 'contradicts-static-expectation' ? 'high' : 'medium',
    });
  }
  return contradictions;
};

const emptyRuntimeTruthSummary = (probePlan: ProbeRequest[], warnings: string[]): RuntimeTruthSummary => ({
  generatedAt: '',
  sourceFiles: [],
  probePlan,
  snapshot: {
    requestSpans: 0,
    dbQueries: 0,
    payloadShapes: 0,
  },
  compressed: {
    witnessCards: 0,
    observedLoops: 0,
    contradictionWitnesses: 0,
    coverageWitnesses: 0,
  },
  reconciliation: {
    supportsStaticEdge: 0,
    fillsStaticGap: 0,
    contradictsStaticExpectation: 0,
    revealsHiddenDynamicBranch: 0,
    revealsDeadStaticOnlyPath: 0,
  },
  witnesses: [],
  observedLoops: [],
  contradictions: [],
  coverage: [],
  warnings,
});

const countReconciliation = (witnesses: RuntimeWitnessCard[]) => {
  const counts = {
    supportsStaticEdge: 0,
    fillsStaticGap: 0,
    contradictsStaticExpectation: 0,
    revealsHiddenDynamicBranch: 0,
    revealsDeadStaticOnlyPath: 0,
  };
  for (const witness of witnesses) {
    if (witness.reconciliation === 'supports-static-edge') counts.supportsStaticEdge += 1;
    if (witness.reconciliation === 'fills-static-gap') counts.fillsStaticGap += 1;
    if (witness.reconciliation === 'contradicts-static-expectation') counts.contradictsStaticExpectation += 1;
    if (witness.reconciliation === 'reveals-hidden-dynamic-branch') counts.revealsHiddenDynamicBranch += 1;
    if (witness.reconciliation === 'reveals-dead-static-only-path') counts.revealsDeadStaticOnlyPath += 1;
  }
  return counts;
};

export const compileRuntimeTruthGraph = async (
  input: BrainTickInput,
  plan: PlanEnvelope,
): Promise<RuntimeTruthSummary> => {
  const probePlan = buildProbePlan(input, plan);
  const warnings: string[] = [];
  let snapshot: RuntimeObservationSnapshot;
  try {
    snapshot = await loadRuntimeObservationSnapshot(input.storagePath, {
      repoPath: input.repoPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'failed to load runtime snapshot');
    return emptyRuntimeTruthSummary(probePlan, [`runtime-observation-load-failed: ${message}`]);
  }

  if (
    snapshot.request_spans.length === 0
    && snapshot.db_queries.length === 0
    && snapshot.payload_shapes.length === 0
  ) {
    warnings.push('No runtime observation snapshot found; runtime truth is static-only.');
    return emptyRuntimeTruthSummary(probePlan, warnings);
  }

  const anchorFiles = new Set(
    (plan.anchors || [])
      .map(anchor => normalizePath(anchor.filePath || ''))
      .filter(Boolean),
  );

  const requestWitnesses = buildRequestWitnesses(snapshot.request_spans, snapshot.generatedAt || '', anchorFiles);
  const dbWitnesses = buildDbWitnesses(snapshot.db_queries, snapshot.generatedAt || '', anchorFiles);
  const payloadWitnesses = buildPayloadWitnesses(snapshot.payload_shapes, snapshot.generatedAt || '', anchorFiles);
  const witnesses = [...requestWitnesses, ...dbWitnesses, ...payloadWitnesses].slice(0, MAX_WITNESSES);
  const observedLoops = buildObservedLoops(snapshot.request_spans);
  const contradictions = buildContradictionWitnesses(witnesses);
  const coverageWitness = buildCoverageWitness(anchorFiles, witnesses);
  const reconciliation = countReconciliation(witnesses);

  return {
    generatedAt: snapshot.generatedAt || '',
    sourceFiles: snapshot.source_files,
    probePlan,
    snapshot: {
      requestSpans: snapshot.request_spans.length,
      dbQueries: snapshot.db_queries.length,
      payloadShapes: snapshot.payload_shapes.length,
    },
    compressed: {
      witnessCards: witnesses.length,
      observedLoops: observedLoops.length,
      contradictionWitnesses: contradictions.length,
      coverageWitnesses: 1,
    },
    reconciliation,
    witnesses,
    observedLoops,
    contradictions,
    coverage: [coverageWitness],
    warnings,
  };
};
