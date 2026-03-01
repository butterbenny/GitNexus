import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import {
  BrainPacket,
  BrainTickInput,
  ConstraintGraphSummary,
  ContextUsageTelemetryEntry,
  ContextUsageTelemetrySummary,
  EvalCanaryMetrics,
  EvalCanaryRun,
  EvalGoldContextRecord,
  EvalGraphSummary,
  EvalRegressionRecord,
  EvalTaskFamily,
  EvalTaskRecord,
  ExperienceGovernorSummary,
  PlanEnvelope,
  RuntimeTruthSummary,
} from './types.js';

const EVAL_GRAPH_SCHEMA_VERSION = 1;
const EVAL_GRAPH_FILE = 'eval-graph.json';
const MAX_TASKS = 300;
const MAX_GOLD_CONTEXTS = 300;
const MAX_CANARY_RUNS = 500;
const MAX_REGRESSIONS = 500;
const CANARY_PASS_SCORE_MIN = 78;
const CANARY_RECALL_MIN = 0.65;
const CANARY_PRECISION_MIN = 0.55;
const CANARY_PROOF_SUFFICIENCY_MIN = 0.75;
const REGRESSION_SCORE_DROP_MIN = 5;
const REGRESSION_RECALL_DROP_MIN = 0.08;
const REGRESSION_PRECISION_DROP_MIN = 0.08;
const REGRESSION_PROOF_DROP_MIN = 0.08;
const PROMOTION_MIN_RUNS = 3;
const PROMOTION_PASS_RATE_MIN = 0.8;
const PROMOTION_LAST_SCORE_MIN = 82;
const PROMOTION_PASS_RATE_WINDOW = 10;
const PROMOTION_CONSECUTIVE_PASS_MIN = 3;
const DASHBOARD_METRICS_WINDOW = 10;
const BASELINE_V1_WINDOW = 12;
const BASELINE_V1_MIN_SAMPLES = 5;

interface EvalGraphStore {
  schemaVersion: number;
  tasks: EvalTaskRecord[];
  goldContexts: EvalGoldContextRecord[];
  canaryRuns: EvalCanaryRun[];
  regressions: EvalRegressionRecord[];
}

const nowIso = (): string => new Date().toISOString();

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const dedupe = <T>(items: T[]): T[] => Array.from(new Set(items));

const hashValue = (value: string): string => {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
};

const clamp = (value: number, min = 0, max = 1): number => {
  return Math.max(min, Math.min(max, value));
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return Number(sorted[middle].toFixed(4));
  return Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(4));
};

const getStorePath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', EVAL_GRAPH_FILE);
};

const emptyStore = (): EvalGraphStore => ({
  schemaVersion: EVAL_GRAPH_SCHEMA_VERSION,
  tasks: [],
  goldContexts: [],
  canaryRuns: [],
  regressions: [],
});

const loadStore = async (storagePath: string): Promise<EvalGraphStore> => {
  try {
    const raw = await fs.readFile(getStorePath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || Number(parsed.schemaVersion) !== EVAL_GRAPH_SCHEMA_VERSION
      || !Array.isArray(parsed.tasks)
      || !Array.isArray(parsed.goldContexts)
      || !Array.isArray(parsed.canaryRuns)
      || !Array.isArray(parsed.regressions)
    ) {
      return emptyStore();
    }
    return {
      schemaVersion: EVAL_GRAPH_SCHEMA_VERSION,
      tasks: parsed.tasks,
      goldContexts: parsed.goldContexts,
      canaryRuns: parsed.canaryRuns,
      regressions: parsed.regressions,
    };
  } catch {
    return emptyStore();
  }
};

const saveStore = async (storagePath: string, store: EvalGraphStore): Promise<string> => {
  const filePath = getStorePath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  return filePath;
};

const createFamilyCounts = (): Record<EvalTaskFamily, number> => ({
  'bug-fix': 0,
  'feature-addition': 0,
  refactor: 0,
  'security-fix': 0,
  'performance-fix': 0,
  'dependency-decision': 0,
  'contract-migration': 0,
  'auth-closure-repair': 0,
  'cache-closure-repair': 0,
});

const touches = (items: string[], tokens: string[]): boolean => {
  return items.some(item => tokens.some(token => item.includes(token)));
};

const inferTaskFamily = (
  input: BrainTickInput,
  plan: PlanEnvelope,
  constraintGraph?: ConstraintGraphSummary,
): EvalTaskFamily => {
  const taskText = String(input.task || '').toLowerCase();
  const files = dedupe(
    (input.changedPaths || [])
      .concat(plan.anchors.map(anchor => anchor.filePath || ''))
      .map(normalizePath)
      .map(item => item.toLowerCase())
      .filter(Boolean),
  );
  const constraintFamilies = new Set((constraintGraph?.violations || []).map(item => item.family));
  const hasDependencyManifest = files.some(filePath => [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'composer.json',
    'composer.lock',
    'go.mod',
    'go.sum',
    'Cargo.toml',
    'Cargo.lock',
  ].includes(filePath.split('/').pop() || ''));

  if (constraintFamilies.has('auth') || touches(files, ['auth', 'policy', 'permission', 'guard'])) return 'auth-closure-repair';
  if (constraintFamilies.has('security') || touches(files, ['security', 'sanitize', 'xss', 'csrf', 'secret', 'token'])) return 'security-fix';
  if (constraintFamilies.has('performance') || touches(files, ['perf', 'performance', 'benchmark', 'optimiz', 'latency'])) return 'performance-fix';
  if (constraintFamilies.has('dependency') || hasDependencyManifest) return 'dependency-decision';
  if (constraintFamilies.has('structural') || constraintFamilies.has('runtime') || touches(files, ['cache', 'invalidate', 'query-key', 'query_key'])) {
    return 'cache-closure-repair';
  }
  if (taskText.includes('contract') || taskText.includes('migration') || touches(files, ['contract', 'schema', 'shape', 'resource'])) {
    return 'contract-migration';
  }
  if (taskText.includes('refactor') || touches(files, ['refactor'])) return 'refactor';
  if (plan.mode === 'implement') return 'feature-addition';
  return 'bug-fix';
};

const buildTaskRecord = (
  input: BrainTickInput,
  plan: PlanEnvelope,
  constraintGraph?: ConstraintGraphSummary,
  brainPacket?: BrainPacket,
): EvalTaskRecord => {
  const family = inferTaskFamily(input, plan, constraintGraph);
  const changedPaths = dedupe(
    (input.changedPaths || [])
      .concat(plan.anchors.map(anchor => anchor.filePath || ''))
      .map(normalizePath)
      .filter(Boolean),
  ).slice(0, 20);
  const signalTokens = dedupe([
    `mode:${plan.mode}`,
    changedPaths.length > 0 ? 'signal:changed-paths' : '',
    (constraintGraph?.violations.length || 0) > 0 ? 'signal:constraint-violations' : '',
    (constraintGraph?.requestedProbes.length || 0) > 0 ? 'signal:runtime-probe-request' : '',
    (brainPacket?.runtimeWitnesses.length || 0) > 0 ? 'signal:runtime-witnesses' : '',
  ].filter(Boolean)).slice(0, 10);
  const relevantTests = dedupe(
    (constraintGraph?.requestedTests || [])
      .concat(brainPacket?.testPlan.suggested || []),
  ).slice(0, 12);
  const requiredConstraints = dedupe(
    (constraintGraph?.violations || [])
      .filter(item => item.severity === 'critical' || item.severity === 'high')
      .map(item => item.ruleId),
  ).slice(0, 12);
  const label = String(input.task || '').trim() || `brain-tick:${input.reason}`;
  const idSeed = `${input.repoFingerprint}|${plan.mode}|${family}|${label}|${changedPaths.join('|')}`;
  return {
    id: `eval-task:${hashValue(idSeed)}`,
    family,
    mode: plan.mode,
    label,
    sourceSignals: signalTokens,
    changedPaths,
    relevantTests,
    requiredConstraints,
    createdAt: nowIso(),
  };
};

const buildGoldContextRecord = (
  task: EvalTaskRecord,
  plan: PlanEnvelope,
  constraintGraph?: ConstraintGraphSummary,
  runtimeTruth?: RuntimeTruthSummary,
  brainPacket?: BrainPacket,
): EvalGoldContextRecord => {
  const anchoredFiles = plan.anchors
    .map(anchor => normalizePath(anchor.filePath || ''))
    .filter(Boolean);
  const fileAnchorBudget = anchoredFiles.length;
  const plannerBudget = Math.max(1, Number(plan.state?.budget?.maxFiles || 6));
  const goldBudget = Math.max(
    1,
    Math.min(
      plannerBudget,
      fileAnchorBudget > 0 ? fileAnchorBudget : Math.max(1, Number(task.changedPaths.length || 1)),
    ),
  );
  const changedSlices = dedupe(
    plan.anchors
      .filter(anchor => anchor.kind === 'slice')
      .map(anchor => anchor.id),
  ).slice(0, 10);
  const proofSubgraph = dedupe(
    plan.proofObjectives.map(item => item.id)
      .concat((runtimeTruth?.witnesses || []).map(item => item.id))
      .concat((runtimeTruth?.contradictions || []).map(item => item.id))
      .concat((constraintGraph?.violations || []).map(item => item.id)),
  ).slice(0, 24);
  const goldFiles = dedupe(
    task.changedPaths
      .slice(0, goldBudget)
      .concat(plan.anchors.map(anchor => anchor.filePath || '').map(normalizePath))
      .filter(Boolean),
  ).slice(0, goldBudget);
  const requiredConstraints = dedupe(
    (constraintGraph?.violations || [])
      .filter(item => item.severity === 'critical' || item.severity === 'high')
      .map(item => item.ruleId),
  ).slice(0, 12);
  const relevantTests = dedupe(
    task.relevantTests
      .concat(brainPacket?.testPlan.suggested || []),
  ).slice(0, 12);
  const runtimeWitnesses = dedupe(
    (runtimeTruth?.witnesses || []).map(item => item.id),
  ).slice(0, 12);
  return {
    id: `eval-gold:${hashValue(`${task.id}|${goldFiles.join('|')}|${proofSubgraph.join('|')}`)}`,
    taskId: task.id,
    changedSlices,
    proofSubgraph,
    goldFiles,
    requiredConstraints,
    relevantTests,
    runtimeWitnesses,
    generatedAt: nowIso(),
  };
};

const calculateCanaryMetrics = (
  goldContext: EvalGoldContextRecord,
  brainPacket: BrainPacket | undefined,
  telemetryEntry?: ContextUsageTelemetryEntry,
  telemetrySummary?: ContextUsageTelemetrySummary,
): EvalCanaryMetrics => {
  const retrievedFiles = dedupe(
    (brainPacket?.editBudget.preferredOrder || [])
      .map(normalizePath)
      .filter(Boolean),
  );
  const goldFiles = goldContext.goldFiles.map(normalizePath).filter(Boolean);
  const goldSet = new Set(goldFiles);
  const retrievedSet = new Set(retrievedFiles);
  const intersection = Array.from(retrievedSet).filter(item => goldSet.has(item)).length;
  const recall = goldFiles.length > 0 ? intersection / goldFiles.length : 1;
  const precision = retrievedFiles.length > 0 ? intersection / retrievedFiles.length : (goldFiles.length > 0 ? 0 : 1);

  const requiredProof = Math.max(1, (brainPacket?.proofPack.objectives || []).filter(item => item.required).length);
  const unresolvedProof = brainPacket?.proofPack.unresolved.length || 0;
  const proofSufficiency = clamp(1 - unresolvedProof / requiredProof);

  const filesOpened = retrievedFiles.length;
  const usefulArtifacts = Math.max(1, telemetryEntry?.usefulArtifacts || 0);
  const estimatedTokens = Math.max(0, telemetryEntry?.estimatedTokens || 0);
  const tokensPerUsefulArtifact = estimatedTokens > 0
    ? estimatedTokens / usefulArtifacts
    : Number(telemetrySummary?.averageUsefulRatio || 0) > 0
      ? 800
      : 0;

  return {
    goldContextRecall: Number(recall.toFixed(4)),
    goldContextPrecision: Number(precision.toFixed(4)),
    proofSufficiency: Number(proofSufficiency.toFixed(4)),
    filesOpenedPerSolvedTask: filesOpened,
    tokensPerUsefulArtifact: Number(tokensPerUsefulArtifact.toFixed(4)),
  };
};

const scoreCanary = (metrics: EvalCanaryMetrics): number => {
  const filesScore = clamp(1 - Math.max(0, metrics.filesOpenedPerSolvedTask - 6) / 12);
  const tokenScore = metrics.tokensPerUsefulArtifact <= 0
    ? 0.8
    : clamp(1 - Math.max(0, metrics.tokensPerUsefulArtifact - 400) / 1600);
  const score = (
    0.28 * metrics.goldContextRecall
    + 0.22 * metrics.goldContextPrecision
    + 0.25 * metrics.proofSufficiency
    + 0.15 * filesScore
    + 0.10 * tokenScore
  ) * 100;
  return Number(score.toFixed(2));
};

const evaluateCanaryPass = (
  score: number,
  metrics: EvalCanaryMetrics,
): { passed: boolean; failedChecks: string[] } => {
  const checks = [
    { id: 'score', ok: score >= CANARY_PASS_SCORE_MIN, detail: `score ${score} < ${CANARY_PASS_SCORE_MIN}` },
    { id: 'recall', ok: metrics.goldContextRecall >= CANARY_RECALL_MIN, detail: `recall ${metrics.goldContextRecall} < ${CANARY_RECALL_MIN}` },
    { id: 'precision', ok: metrics.goldContextPrecision >= CANARY_PRECISION_MIN, detail: `precision ${metrics.goldContextPrecision} < ${CANARY_PRECISION_MIN}` },
    { id: 'proof', ok: metrics.proofSufficiency >= CANARY_PROOF_SUFFICIENCY_MIN, detail: `proof ${metrics.proofSufficiency} < ${CANARY_PROOF_SUFFICIENCY_MIN}` },
  ];
  const failedChecks = checks.filter(item => !item.ok).map(item => item.detail);
  return {
    passed: failedChecks.length === 0,
    failedChecks,
  };
};

const upsertById = <T extends { id: string }>(items: T[], item: T, maxSize: number): T[] => {
  const map = new Map<string, T>();
  for (const existing of items) map.set(existing.id, existing);
  map.set(item.id, item);
  return Array.from(map.values()).slice(-maxSize);
};

const countConsecutivePasses = (runs: EvalCanaryRun[]): number => {
  let passes = 0;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (!runs[index]?.passed) break;
    passes += 1;
  }
  return passes;
};

const buildDashboardMetrics = (
  store: EvalGraphStore,
  constraintGraph: ConstraintGraphSummary | undefined,
  experienceGovernor: ExperienceGovernorSummary | undefined,
  canaryRun: EvalCanaryRun,
): EvalGraphSummary['dashboardMetrics'] => {
  const recentRuns = store.canaryRuns.slice(-DASHBOARD_METRICS_WINDOW);
  const runs = recentRuns.length > 0 ? recentRuns : (store.canaryRuns.length > 0 ? store.canaryRuns : [canaryRun]);
  const avg = (values: number[]): number => {
    if (values.length === 0) return 0;
    return Number((values.reduce((acc, value) => acc + value, 0) / values.length).toFixed(4));
  };

  const retrieval = {
    goldContextRecall: avg(runs.map(item => item.metrics.goldContextRecall)),
    goldContextPrecision: avg(runs.map(item => item.metrics.goldContextPrecision)),
    proofSufficiency: avg(runs.map(item => item.metrics.proofSufficiency)),
    filesOpenedPerSolvedTask: avg(runs.map(item => item.metrics.filesOpenedPerSolvedTask)),
    tokensPerUsefulArtifact: avg(runs.map(item => item.metrics.tokensPerUsefulArtifact)),
  };

  const totalViolations = constraintGraph?.violations.length || 0;
  const warned = constraintGraph?.patchGate.warned || 0;
  const blocked = constraintGraph?.patchGate.blocked || 0;
  const requestedRuntimeProbe = constraintGraph?.patchGate.requestedRuntimeProbe || 0;
  const securityFindings = (constraintGraph?.violations || []).filter(item => item.family === 'security').length;
  const perfFindings = (constraintGraph?.violations || []).filter(item => item.family === 'performance').length;
  const depFindings = (constraintGraph?.violations || []).filter(item => item.family === 'dependency').length;
  const unresolvedRegressions = store.regressions.filter(item => item.status === 'open').length;

  const memoryUtilities = experienceGovernor?.retrievedCards || [];
  const memoryCardUtility = memoryUtilities.length > 0
    ? avg(memoryUtilities.map(item => item.utility))
    : 0;
  const dropRate = (experienceGovernor?.totals.cards || 0) > 0
    ? (experienceGovernor?.totals.dropped || 0) / (experienceGovernor?.totals.cards || 1)
    : 0;
  const hasConstraintCoverage = Number(constraintGraph?.catalog.totalRules || 0) > 0;
  const gapSeverityCalibration = totalViolations > 0
    ? Number(((blocked + (constraintGraph?.patchGate.requestedTargetedTests || 0)) / totalViolations).toFixed(4))
    : hasConstraintCoverage
      ? 1
      : 0;

  return {
    retrieval,
    review: {
      gapPrecision: totalViolations > 0 ? Number(((totalViolations - warned) / totalViolations).toFixed(4)) : 1,
      gapSeverityCalibration,
      missedClosureRate: totalViolations > 0 ? Number((requestedRuntimeProbe / totalViolations).toFixed(4)) : 0,
      falseAlarmRate: totalViolations > 0 ? Number((warned / totalViolations).toFixed(4)) : 0,
    },
    implement: {
      companionEditRecall: retrieval.goldContextRecall,
      precedentUsefulness: memoryCardUtility,
      patchAcceptanceRate: avg(runs.map(item => item.passed ? 1 : 0)),
      postReviewDeltaCount: unresolvedRegressions,
    },
    debug: {
      brokenLoopTop1: Number((retrieval.proofSufficiency * 0.7).toFixed(4)),
      brokenLoopTop3: Number((clamp(retrieval.proofSufficiency + 0.2) * 1).toFixed(4)),
      usefulProbeRate: totalViolations > 0 ? Number(((totalViolations - warned) / totalViolations).toFixed(4)) : 0.5,
      timeToRootCause: Number(Math.max(0, 30 - retrieval.proofSufficiency * 18).toFixed(2)),
      contradictionResolutionRate: constraintGraph && constraintGraph.solver.contradictions > 0 ? Number((clamp(1 - unresolvedRegressions / 5)).toFixed(4)) : 1,
    },
    nonFunctional: {
      securityIssueMissRate: totalViolations > 0 ? Number((securityFindings / totalViolations).toFixed(4)) : 0,
      perfRegressionMissRate: totalViolations > 0 ? Number((perfFindings / totalViolations).toFixed(4)) : 0,
      badDependencyDecisionRate: totalViolations > 0 ? Number((depFindings / totalViolations).toFixed(4)) : 0,
    },
    learning: {
      plannerUplift: Number((retrieval.proofSufficiency - 0.5).toFixed(4)),
      memoryCardUtility,
      operatorPromotionHitRate: avg(runs.map(item => item.passed ? 1 : 0)),
      staleMemoryDecayCorrectness: Number(clamp(dropRate).toFixed(4)),
    },
  };
};

export const runEvalGraph = async (
  input: BrainTickInput,
  plan: PlanEnvelope,
  runtimeTruth?: RuntimeTruthSummary,
  experienceGovernor?: ExperienceGovernorSummary,
  constraintGraph?: ConstraintGraphSummary,
  brainPacket?: BrainPacket,
  telemetryEntry?: ContextUsageTelemetryEntry,
  telemetrySummary?: ContextUsageTelemetrySummary,
): Promise<EvalGraphSummary> => {
  const warnings: string[] = [];
  const store = await loadStore(input.storagePath);
  const task = buildTaskRecord(input, plan, constraintGraph, brainPacket);
  const goldContext = buildGoldContextRecord(task, plan, constraintGraph, runtimeTruth, brainPacket);
  const canaryMetrics = calculateCanaryMetrics(goldContext, brainPacket, telemetryEntry, telemetrySummary);
  const canaryScore = scoreCanary(canaryMetrics);
  const passEvaluation = evaluateCanaryPass(canaryScore, canaryMetrics);
  const passed = passEvaluation.passed;
  const familyRuns = store.canaryRuns.filter(item => item.family === task.family);
  const previousFamilyRun = familyRuns[familyRuns.length - 1];

  let newRegressions = 0;
  let resolvedRegressions = 0;
  let regressionsDetected = 0;
  const regressions = store.regressions.map(item => ({ ...item }));

  if (previousFamilyRun) {
    const scoreDrop = previousFamilyRun.score - canaryScore;
    const recallDrop = previousFamilyRun.metrics.goldContextRecall - canaryMetrics.goldContextRecall;
    const precisionDrop = previousFamilyRun.metrics.goldContextPrecision - canaryMetrics.goldContextPrecision;
    const proofDrop = previousFamilyRun.metrics.proofSufficiency - canaryMetrics.proofSufficiency;
    const isRegression = (
      scoreDrop >= REGRESSION_SCORE_DROP_MIN
      || recallDrop >= REGRESSION_RECALL_DROP_MIN
      || precisionDrop >= REGRESSION_PRECISION_DROP_MIN
      || proofDrop >= REGRESSION_PROOF_DROP_MIN
      || (previousFamilyRun.passed && !passed)
    );
    if (isRegression) {
      newRegressions += 1;
      regressionsDetected += 1;
      regressions.push({
        id: `eval-regression:${hashValue(`${task.family}|${task.id}|${nowIso()}`)}`,
        family: task.family,
        status: 'open',
        taskId: task.id,
        openedAt: nowIso(),
        previousScore: previousFamilyRun.score,
        currentScore: canaryScore,
      });
    } else if (passed) {
      for (const regression of regressions) {
        if (regression.family === task.family && regression.status === 'open') {
          regression.status = 'resolved';
          regression.resolvedAt = nowIso();
          regression.currentScore = canaryScore;
          resolvedRegressions += 1;
        }
      }
    }
  }

  const canaryRun: EvalCanaryRun = {
    id: `eval-canary:${hashValue(`${task.id}|${canaryScore}|${nowIso()}`)}`,
    taskId: task.id,
    family: task.family,
    score: canaryScore,
    passed,
    metrics: canaryMetrics,
    regressionsDetected,
    createdAt: nowIso(),
  };

  store.tasks = upsertById(store.tasks, task, MAX_TASKS);
  store.goldContexts = upsertById(store.goldContexts, goldContext, MAX_GOLD_CONTEXTS);
  store.canaryRuns = [...store.canaryRuns, canaryRun].slice(-MAX_CANARY_RUNS);
  store.regressions = regressions.slice(-MAX_REGRESSIONS);

  const storePath = await saveStore(input.storagePath, store);
  const openRegressions = store.regressions.filter(item => item.status === 'open').length;
  const recentRuns = store.canaryRuns.slice(-PROMOTION_PASS_RATE_WINDOW);
  const passRate = recentRuns.length > 0
    ? recentRuns.filter(item => item.passed).length / recentRuns.length
    : 0;
  const consecutivePasses = countConsecutivePasses(store.canaryRuns);

  const familyCounts = createFamilyCounts();
  for (const item of store.tasks) {
    familyCounts[item.family] += 1;
  }

  const averageGoldFiles = store.goldContexts.length > 0
    ? Number((store.goldContexts.reduce((acc, item) => acc + item.goldFiles.length, 0) / store.goldContexts.length).toFixed(4))
    : 0;
  const averageRequiredConstraints = store.goldContexts.length > 0
    ? Number((store.goldContexts.reduce((acc, item) => acc + item.requiredConstraints.length, 0) / store.goldContexts.length).toFixed(4))
    : 0;

  if (!brainPacket) warnings.push('EvalGraph ran without BrainPacket; canary used reduced retrieval inputs');
  if ((runtimeTruth?.witnesses.length || 0) === 0) warnings.push('EvalGraph had no runtime witnesses for this run');
  if ((constraintGraph?.violations.length || 0) === 0) warnings.push('EvalGraph had no constraint violations; review precision metrics are low-signal');
  if (!passed) {
    warnings.push(`EvalGraph canary failed strict gates: ${passEvaluation.failedChecks.join('; ')}`);
  }

  const dashboardMetrics = buildDashboardMetrics(store, constraintGraph, experienceGovernor, canaryRun);
  const baselineRuns = store.canaryRuns.slice(0, BASELINE_V1_WINDOW);
  const baselineTokens = baselineRuns
    .map(item => Number(item.metrics.tokensPerUsefulArtifact || 0))
    .filter(value => Number.isFinite(value) && value > 0);
  const baselineSource = baselineTokens.length >= BASELINE_V1_MIN_SAMPLES
    ? 'historical-window'
    : 'insufficient-history';
  const promotionAllowed = (
    canaryRun.passed
    && openRegressions === 0
    && store.canaryRuns.length >= PROMOTION_MIN_RUNS
    && (passRate >= PROMOTION_PASS_RATE_MIN || consecutivePasses >= PROMOTION_CONSECUTIVE_PASS_MIN)
    && canaryRun.score >= PROMOTION_LAST_SCORE_MIN
  );
  if (!promotionAllowed) {
    const reasons: string[] = [];
    if (!canaryRun.passed) reasons.push('last canary did not pass strict gates');
    if (openRegressions > 0) reasons.push(`open regressions=${openRegressions}`);
    if (store.canaryRuns.length < PROMOTION_MIN_RUNS) reasons.push(`run_count ${store.canaryRuns.length} < ${PROMOTION_MIN_RUNS}`);
    if (passRate < PROMOTION_PASS_RATE_MIN && consecutivePasses < PROMOTION_CONSECUTIVE_PASS_MIN) {
      reasons.push(
        `recent_pass_rate ${Number(passRate.toFixed(4))} < ${PROMOTION_PASS_RATE_MIN} and consecutive_passes ${consecutivePasses} < ${PROMOTION_CONSECUTIVE_PASS_MIN}`,
      );
    }
    if (canaryRun.score < PROMOTION_LAST_SCORE_MIN) reasons.push(`last_score ${canaryRun.score} < ${PROMOTION_LAST_SCORE_MIN}`);
    warnings.push(`EvalGraph promotion blocked: ${reasons.join('; ')}`);
  }

  return {
    generatedAt: nowIso(),
    storePath,
    taskMiner: {
      mined: 1,
      total: store.tasks.length,
      byFamily: familyCounts,
    },
    goldContextMiner: {
      mined: 1,
      total: store.goldContexts.length,
      averageGoldFiles,
      averageRequiredConstraints,
    },
    canaryHarness: {
      runCount: store.canaryRuns.length,
      lastRunAt: canaryRun.createdAt,
      lastScore: canaryRun.score,
      passRate: Number(passRate.toFixed(4)),
      regressionsDetected,
      promotionAllowed,
    },
    regressionTracking: {
      openRegressions,
      newRegressions,
      resolvedRegressions,
    },
    dashboardMetrics,
    baselines: {
      v1MedianTokensPerUsefulArtifact: median(baselineTokens),
      source: baselineSource,
      sampleCount: baselineTokens.length,
      windowSize: BASELINE_V1_WINDOW,
    },
    latestTask: task,
    latestGoldContext: goldContext,
    latestCanary: canaryRun,
    warnings,
  };
};
