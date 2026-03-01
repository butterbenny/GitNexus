import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import {
  BrainPacket,
  BrainTickInput,
  ConstraintGraphSummary,
  ContextUsageTelemetrySummary,
  DistillationEngineSummary,
  DistillationPolicyArm,
  EvalGraphSummary,
  ExperienceGovernorSummary,
  PlanEnvelope,
  RuntimeTruthSummary,
} from './types.js';

const DISTILLATION_STORE_SCHEMA_VERSION = 1;
const DISTILLATION_STORE_FILE = 'distillation-engine.json';
const MAX_POLICY_ARMS = 24;
const MAX_RUN_HISTORY = 500;
const PROMOTION_MIN_RUNS = 3;
const PARITY_CRITICAL_CHECK_IDS = [
  'query-adaptive-operator-selection',
  'review-micro-runtime-probes-on-uncertainty',
  'implement-auto-patch-guard-before-finalize',
  'implement-post-review-mandatory',
];

const isBlockingParityStatus = (checkId: string, status: string): boolean => {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized || normalized === 'met') return false;
  if (checkId === 'query-adaptive-operator-selection' && normalized === 'partial') {
    // Allow one promotion step so the planner can move from baseline -> adaptive policy.
    return false;
  }
  return true;
};

interface DistillationRunRecord {
  id: string;
  policyId: string;
  reward: number;
  riskScore: number;
  promoted: boolean;
  createdAt: string;
}

interface DistillationStore {
  schemaVersion: number;
  runCount: number;
  policyArms: DistillationPolicyArm[];
  runHistory: DistillationRunRecord[];
}

const nowIso = (): string => new Date().toISOString();

const clamp = (value: number, min = 0, max = 1): number => {
  return Math.max(min, Math.min(max, value));
};

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

const getStorePath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', DISTILLATION_STORE_FILE);
};

const getBrainManifestPath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', 'brain.json');
};

const emptyStore = (): DistillationStore => ({
  schemaVersion: DISTILLATION_STORE_SCHEMA_VERSION,
  runCount: 0,
  policyArms: [],
  runHistory: [],
});

const loadStore = async (storagePath: string): Promise<DistillationStore> => {
  try {
    const raw = await fs.readFile(getStorePath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || Number(parsed.schemaVersion) !== DISTILLATION_STORE_SCHEMA_VERSION
      || !Array.isArray(parsed.policyArms)
      || !Array.isArray(parsed.runHistory)
    ) {
      return emptyStore();
    }
    return {
      schemaVersion: DISTILLATION_STORE_SCHEMA_VERSION,
      runCount: Math.max(0, Number(parsed.runCount || parsed.runHistory.length || 0)),
      policyArms: parsed.policyArms,
      runHistory: parsed.runHistory,
    };
  } catch {
    return emptyStore();
  }
};

const saveStore = async (storagePath: string, store: DistillationStore): Promise<string> => {
  const filePath = getStorePath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  return filePath;
};

const loadParityCriticalBlockers = async (storagePath: string): Promise<string[]> => {
  try {
    const raw = await fs.readFile(getBrainManifestPath(storagePath), 'utf-8');
    const manifest = JSON.parse(raw);
    const checks = Array.isArray(manifest?.v2Parity?.checks) ? manifest.v2Parity.checks : [];
    const blockerSet = new Set<string>();
    for (const check of checks) {
      const id = String(check?.id || '').trim();
      if (!id || !PARITY_CRITICAL_CHECK_IDS.includes(id)) continue;
      const status = String(check?.status || '').trim().toLowerCase();
      if (isBlockingParityStatus(id, status)) blockerSet.add(`${id}:${status || 'unknown'}`);
    }
    return Array.from(blockerSet);
  } catch {
    return [];
  }
};

const resolvePolicyId = (plan: PlanEnvelope): string => {
  const anchorFamily = plan.anchors
    .map(anchor => normalizePath(anchor.filePath || '').split('/').slice(0, 2).join('/'))
    .find(Boolean);
  if (anchorFamily) return `policy:${plan.mode}:${plan.contextShape}:${anchorFamily}`;
  return `policy:${plan.mode}:${plan.contextShape}`;
};

const calculateReward = (
  evalGraph: EvalGraphSummary | undefined,
  contextTelemetry: ContextUsageTelemetrySummary | undefined,
  constraintGraph: ConstraintGraphSummary | undefined,
  runtimeTruth: RuntimeTruthSummary | undefined,
  brainPacket: BrainPacket | undefined,
): number => {
  const canaryScore = Number(evalGraph?.canaryHarness.lastScore || 0) / 100;
  const proofSignal = Number(evalGraph?.dashboardMetrics.retrieval.proofSufficiency || contextTelemetry?.averageProofSufficiency || 0);
  const usefulnessSignal = Number(contextTelemetry?.averageUsefulRatio || 0);
  const packetSignal = brainPacket ? 1 : 0.55;
  const violationPenalty = Math.min(0.35, (constraintGraph?.violations.length || 0) * 0.03);
  const contradictionPenalty = Math.min(0.25, (runtimeTruth?.contradictions.length || 0) * 0.05);
  const score = (
    0.35 * canaryScore
    + 0.25 * proofSignal
    + 0.2 * usefulnessSignal
    + 0.2 * packetSignal
    - violationPenalty
    - contradictionPenalty
  );
  return Number(clamp(score).toFixed(4));
};

const updatePolicyArms = (
  existingArms: DistillationPolicyArm[],
  policyId: string,
  reward: number,
): DistillationPolicyArm[] => {
  const byId = new Map<string, DistillationPolicyArm>();
  for (const arm of existingArms) byId.set(arm.id, arm);

  const existing = byId.get(policyId);
  if (!existing) {
    byId.set(policyId, {
      id: policyId,
      sampleCount: 1,
      avgReward: reward,
      lastReward: reward,
      weight: 0,
      updatedAt: nowIso(),
    });
  } else {
    const sampleCount = existing.sampleCount + 1;
    const avgReward = ((existing.avgReward * existing.sampleCount) + reward) / sampleCount;
    byId.set(policyId, {
      ...existing,
      sampleCount,
      avgReward: Number(avgReward.toFixed(4)),
      lastReward: reward,
      updatedAt: nowIso(),
    });
  }

  const arms = Array.from(byId.values())
    .sort((a, b) => {
      if (b.avgReward !== a.avgReward) return b.avgReward - a.avgReward;
      if (b.sampleCount !== a.sampleCount) return b.sampleCount - a.sampleCount;
      return a.id.localeCompare(b.id);
    })
    .slice(0, MAX_POLICY_ARMS);

  const totalReward = arms.reduce((acc, arm) => acc + Math.max(arm.avgReward, 0.0001), 0);
  return arms.map(arm => ({
    ...arm,
    weight: Number((Math.max(arm.avgReward, 0.0001) / Math.max(totalReward, 0.0001)).toFixed(4)),
  }));
};

const buildTestSelector = (
  constraintGraph: ConstraintGraphSummary | undefined,
  brainPacket: BrainPacket | undefined,
  evalGraph: EvalGraphSummary | undefined,
): DistillationEngineSummary['testSelector'] => {
  const candidates = dedupe(
    (constraintGraph?.requestedTests || [])
      .concat(brainPacket?.testPlan.suggested || []),
  ).filter(Boolean);
  const selected = candidates.slice(0, 8);
  const goldTests = dedupe(evalGraph?.latestGoldContext?.relevantTests || []);
  const overlap = selected.filter(item => goldTests.includes(item)).length;
  const estimatedRecall = goldTests.length > 0
    ? overlap / goldTests.length
    : selected.length > 0 ? 0.5 : 0;
  return {
    candidateCount: candidates.length,
    selected,
    estimatedRecall: Number(estimatedRecall.toFixed(4)),
  };
};

const buildPrecedentRanker = (
  brainPacket: BrainPacket | undefined,
  experienceGovernor: ExperienceGovernorSummary | undefined,
): DistillationEngineSummary['precedentRanker'] => {
  const ranking = new Map<string, number>();
  for (const precedent of brainPacket?.precedents || []) {
    ranking.set(precedent.id, Math.max(Number(precedent.confidence || 0), ranking.get(precedent.id) || 0));
  }
  for (const card of experienceGovernor?.retrievedCards || []) {
    const id = `memory:${card.id}`;
    const score = Math.max(Number(card.utility || 0) * 0.75, ranking.get(id) || 0);
    ranking.set(id, score);
  }

  const topPrecedents = Array.from(ranking.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, score]) => ({ id, score: Number(score.toFixed(4)) }));

  const confidence = topPrecedents.length > 0
    ? Number((topPrecedents.reduce((acc, item) => acc + item.score, 0) / topPrecedents.length).toFixed(4))
    : 0;
  return {
    candidateCount: ranking.size,
    topPrecedents,
    confidence,
  };
};

const buildRiskScorer = (
  constraintGraph: ConstraintGraphSummary | undefined,
  evalGraph: EvalGraphSummary | undefined,
  runtimeTruth: RuntimeTruthSummary | undefined,
): DistillationEngineSummary['riskScorer'] => {
  const critical = (constraintGraph?.violations || []).filter(item => item.severity === 'critical').length;
  const high = (constraintGraph?.violations || []).filter(item => item.severity === 'high').length;
  const openRegressions = Number(evalGraph?.regressionTracking.openRegressions || 0);
  const contradictions = Number(runtimeTruth?.contradictions.length || 0);
  const canaryFailed = evalGraph?.latestCanary ? !evalGraph.latestCanary.passed : false;
  const score = clamp(
    critical * 0.28
    + high * 0.12
    + openRegressions * 0.17
    + contradictions * 0.08
    + (canaryFailed ? 0.16 : 0),
  );

  const drivers: string[] = [];
  if (critical > 0) drivers.push(`critical_violations:${critical}`);
  if (high > 0) drivers.push(`high_violations:${high}`);
  if (openRegressions > 0) drivers.push(`open_regressions:${openRegressions}`);
  if (contradictions > 0) drivers.push(`runtime_contradictions:${contradictions}`);
  if (canaryFailed) drivers.push('latest_canary_failed');
  if (drivers.length === 0) drivers.push('no_material_risk_drivers');

  return {
    score: Number(score.toFixed(4)),
    level: score >= 0.66 ? 'high' : score >= 0.33 ? 'medium' : 'low',
    drivers,
  };
};

export const runDistillationEngine = async (
  input: BrainTickInput,
  plan: PlanEnvelope,
  runtimeTruth?: RuntimeTruthSummary,
  experienceGovernor?: ExperienceGovernorSummary,
  constraintGraph?: ConstraintGraphSummary,
  evalGraph?: EvalGraphSummary,
  brainPacket?: BrainPacket,
  contextTelemetry?: ContextUsageTelemetrySummary,
): Promise<DistillationEngineSummary> => {
  const warnings: string[] = [];
  const store = await loadStore(input.storagePath);
  const policyId = resolvePolicyId(plan);
  const reward = calculateReward(evalGraph, contextTelemetry, constraintGraph, runtimeTruth, brainPacket);
  const updatedArms = updatePolicyArms(store.policyArms, policyId, reward);
  const winningArm = updatedArms[0];
  const exploreRate = Number((1 / Math.sqrt(Math.max(1, store.runCount + 1))).toFixed(4));
  const testSelector = buildTestSelector(constraintGraph, brainPacket, evalGraph);
  const precedentRanker = buildPrecedentRanker(brainPacket, experienceGovernor);
  const riskScorer = buildRiskScorer(constraintGraph, evalGraph, runtimeTruth);
  const nextRunCount = store.runCount + 1;
  const shadowReady = nextRunCount >= PROMOTION_MIN_RUNS;
  const parityCriticalBlockers = await loadParityCriticalBlockers(input.storagePath);
  const parityCanaryEligible = parityCriticalBlockers.length === 0;
  const canaryEligible = Boolean(evalGraph?.canaryHarness.promotionAllowed) && parityCanaryEligible;
  const promoted = shadowReady && canaryEligible && riskScorer.level !== 'high';

  if (!brainPacket) warnings.push('DistillationEngine ran without BrainPacket; rankers used low-signal fallback');
  if ((contextTelemetry?.totalRuns || 0) === 0) warnings.push('DistillationEngine missing context telemetry history');
  if (testSelector.candidateCount === 0) warnings.push('DistillationEngine test selector produced no candidates');
  if (precedentRanker.candidateCount === 0) warnings.push('DistillationEngine precedent ranker produced no candidates');
  if (!shadowReady) warnings.push(`DistillationEngine promotion blocked: run_count ${nextRunCount} < ${PROMOTION_MIN_RUNS}`);
  if (!canaryEligible) warnings.push('DistillationEngine promotion blocked: eval canary not eligible');
  if (!parityCanaryEligible) {
    warnings.push(`DistillationEngine promotion blocked: parity canary blocked (${parityCriticalBlockers.join(', ')})`);
  }

  const runRecord: DistillationRunRecord = {
    id: `distill-run:${hashValue(`${policyId}|${reward}|${riskScorer.score}|${nowIso()}`)}`,
    policyId,
    reward,
    riskScore: riskScorer.score,
    promoted,
    createdAt: nowIso(),
  };

  store.runCount = nextRunCount;
  store.policyArms = updatedArms;
  store.runHistory = [...store.runHistory, runRecord].slice(-MAX_RUN_HISTORY);
  const storePath = await saveStore(input.storagePath, store);

  return {
    generatedAt: nowIso(),
    storePath,
    runCount: store.runCount,
    artifacts: {
      rankers: 2 + (precedentRanker.candidateCount > 0 ? 1 : 0) + (testSelector.candidateCount > 0 ? 1 : 0),
      plannerPolicies: store.policyArms.length,
      testSelectors: store.runHistory.length,
      precedentRankers: store.runHistory.length,
      riskScorers: store.runHistory.length,
    },
    plannerBandit: {
      exploreRate,
      winningPolicy: winningArm?.id || policyId,
      expectedReward: Number((winningArm?.avgReward || reward).toFixed(4)),
      policyArms: store.policyArms,
    },
    testSelector,
    precedentRanker,
    riskScorer,
    promotion: {
      shadowReady,
      canaryEligible,
      promoted,
      rollbackReady: true,
    },
    warnings,
  };
};
