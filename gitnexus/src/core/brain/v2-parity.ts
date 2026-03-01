import {
  BrainPacket,
  ConstraintGraphSummary,
  ContextUsageTelemetrySummary,
  DistillationEngineSummary,
  EvalGraphSummary,
  ExperienceGovernorSummary,
  PlanEnvelope,
  ProducerRunReport,
  ReviewRuntimeProbeSummary,
  RuntimeTruthSummary,
  ToolsmithSummary,
  V2ParityCheck,
  V2ParityPillar,
  V2ParityStatus,
  V2ParitySummary,
} from './types.js';

export interface BuildV2ParitySummaryInput {
  generatedAt?: string;
  plannerPolicyVersion: string;
  planEnvelope?: PlanEnvelope;
  brainPacket?: BrainPacket;
  contextTelemetry?: ContextUsageTelemetrySummary;
  constraintGraph?: ConstraintGraphSummary;
  evalGraph?: EvalGraphSummary;
  distillationEngine?: DistillationEngineSummary;
  toolsmith?: ToolsmithSummary;
  runtimeTruth?: RuntimeTruthSummary;
  reviewRuntimeProbes?: ReviewRuntimeProbeSummary;
  experienceGovernor?: ExperienceGovernorSummary;
  producerReports?: ProducerRunReport[];
  postImplementReviewMandatory?: boolean;
  postImplementPatchGuardMandatory?: boolean;
}

const STATUS_WEIGHT: Record<V2ParityStatus, number> = {
  met: 1,
  partial: 0.5,
  missing: 0,
  unverified: 0.25,
};
const USEFUL_CONTEXT_TOKEN_TARGET = 80;

const round = (value: number): number => Number(value.toFixed(4));

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value);
};

const dedupe = (items: string[]): string[] => Array.from(new Set(items.filter(Boolean)));

const isRuleBaselinePolicy = (value: string): boolean => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized.startsWith('rule-baseline');
};

const scoreStatus = (status: V2ParityStatus): number => STATUS_WEIGHT[status];

const summarizePillar = (checks: V2ParityCheck[]): Record<V2ParityPillar, {
  met: number;
  partial: number;
  missing: number;
  unverified: number;
  total: number;
  score: number;
}> => {
  const createBucket = () => ({
    met: 0,
    partial: 0,
    missing: 0,
    unverified: 0,
    total: 0,
    score: 0,
  });

  const byPillar: Record<V2ParityPillar, ReturnType<typeof createBucket>> = {
    query: createBucket(),
    review: createBucket(),
    implement: createBucket(),
    debug: createBucket(),
    self_feedback: createBucket(),
  };

  for (const check of checks) {
    const bucket = byPillar[check.pillar];
    bucket.total += 1;
    bucket[check.status] += 1;
    bucket.score += scoreStatus(check.status);
  }

  for (const bucket of Object.values(byPillar)) {
    bucket.score = bucket.total > 0 ? round(bucket.score / bucket.total) : 0;
  }

  return byPillar;
};

const createCheck = (
  id: string,
  pillar: V2ParityPillar,
  label: string,
  status: V2ParityStatus,
  note: string,
  evidence: string[],
): V2ParityCheck => ({
  id,
  pillar,
  label,
  status,
  note,
  evidence,
});

export const buildV2ParitySummary = (input: BuildV2ParitySummaryInput): V2ParitySummary => {
  const checks: V2ParityCheck[] = [];
  const plannerPolicyVersion = String(input.plannerPolicyVersion || '').trim();
  const planEnvelope = input.planEnvelope;
  const brainPacket = input.brainPacket;
  const contextTelemetry = input.contextTelemetry;
  const constraintGraph = input.constraintGraph;
  const evalGraph = input.evalGraph;
  const distillationEngine = input.distillationEngine;
  const toolsmith = input.toolsmith;
  const runtimeTruth = input.runtimeTruth;
  const reviewRuntimeProbes = input.reviewRuntimeProbes;
  const experienceGovernor = input.experienceGovernor;
  const producerReports = Array.isArray(input.producerReports) ? input.producerReports : [];

  const proofObjectiveCount = Array.isArray(brainPacket?.proofPack?.objectives)
    ? brainPacket.proofPack.objectives.length
    : 0;
  const queryProofStatus: V2ParityStatus = (
    planEnvelope?.operators.some(op => op.name === 'compile_context_packet')
      && proofObjectiveCount > 0
  )
    ? 'met'
    : 'missing';
  checks.push(createCheck(
    'query-proof-carrying-default',
    'query',
    'Query returns proof-carrying slice context by default',
    queryProofStatus,
    queryProofStatus === 'met'
      ? 'BrainPacket includes proof objectives and planner emits compile_context_packet.'
      : 'Missing proof-pack compilation signal in planner/context output.',
    [
      `planner.operator_count=${planEnvelope?.operators.length || 0}`,
      `proof_objective_count=${proofObjectiveCount}`,
    ],
  ));

  const v1MedianContextEnv = Number(process.env.GITNEXUS_V1_MEDIAN_USEFUL_CONTEXT_TOKENS || '');
  const v1MedianContextHistorical = Number(evalGraph?.baselines?.v1MedianTokensPerUsefulArtifact || 0);
  const v1HistoricalSampleCount = Number(evalGraph?.baselines?.sampleCount || 0);
  const v1BaselineSource = isFiniteNumber(v1MedianContextEnv) && v1MedianContextEnv > 0
    ? 'env'
    : isFiniteNumber(v1MedianContextHistorical) && v1MedianContextHistorical > 0 && v1HistoricalSampleCount >= 5
      ? 'historical-window'
      : 'unset';
  const v1MedianContext = v1BaselineSource === 'env'
    ? v1MedianContextEnv
    : v1BaselineSource === 'historical-window'
      ? v1MedianContextHistorical
      : 0;
  const currentMedianProxy = Number(evalGraph?.dashboardMetrics?.retrieval?.tokensPerUsefulArtifact || 0);
  let queryMedianStatus: V2ParityStatus = 'unverified';
  let queryMedianNote = 'Provide V1 baseline via env var or historical window samples to verify useful-context reduction.';
  if (isFiniteNumber(v1MedianContext) && v1MedianContext > 0 && isFiniteNumber(currentMedianProxy) && currentMedianProxy > 0) {
    if (currentMedianProxy <= v1MedianContext * 0.8 || currentMedianProxy <= USEFUL_CONTEXT_TOKEN_TARGET) {
      queryMedianStatus = 'met';
      queryMedianNote = v1BaselineSource === 'env'
        ? 'Current tokens/useful-artifact is materially below configured V1 baseline or meets absolute efficiency target.'
        : 'Current tokens/useful-artifact is materially below historical pre-upgrade baseline window or meets absolute efficiency target.';
    } else if (currentMedianProxy <= v1MedianContext) {
      queryMedianStatus = 'partial';
      queryMedianNote = v1BaselineSource === 'env'
        ? 'Current tokens/useful-artifact improved versus V1 baseline but not by the target margin.'
        : 'Current tokens/useful-artifact improved versus historical baseline window but not by the target margin.';
    } else {
      queryMedianStatus = 'missing';
      queryMedianNote = 'Current tokens/useful-artifact is not below V1 baseline.';
    }
  }
  checks.push(createCheck(
    'query-useful-context-vs-v1',
    'query',
    'Median useful-context size is materially smaller than V1',
    queryMedianStatus,
    queryMedianNote,
    [
      `v1_baseline_source=${v1BaselineSource}`,
      `v1_median_tokens=${isFiniteNumber(v1MedianContext) && v1MedianContext > 0 ? v1MedianContext : 'unset'}`,
      `v1_historical_samples=${v1HistoricalSampleCount}`,
      `current_tokens_per_useful=${isFiniteNumber(currentMedianProxy) ? currentMedianProxy : 0}`,
      `absolute_token_target=${USEFUL_CONTEXT_TOKEN_TARGET}`,
    ],
  ));

  const policyArmList = Array.isArray(distillationEngine?.plannerBandit?.policyArms)
    ? distillationEngine.plannerBandit.policyArms
    : [];
  const policyArms = policyArmList.length;
  const distillationWinningPolicy = String(distillationEngine?.plannerBandit?.winningPolicy || '').trim();
  const plannerAdaptiveStatus: V2ParityStatus = !isRuleBaselinePolicy(plannerPolicyVersion)
    ? 'met'
    : policyArms > 0
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'query-adaptive-operator-selection',
    'query',
    'Planner chooses retrieval operators adaptively',
    plannerAdaptiveStatus,
    plannerAdaptiveStatus === 'met'
      ? 'Planner policy is not baseline-only.'
      : plannerAdaptiveStatus === 'partial'
        ? 'Distillation policy arms exist, but active planner policy remains baseline.'
        : 'No adaptive planner policy signal found.',
    [
      `planner_policy_version=${plannerPolicyVersion || 'unset'}`,
      `policy_arm_count=${policyArms}`,
      `winning_policy=${distillationWinningPolicy || 'unset'}`,
    ],
  ));

  const usefulRatio = Number(contextTelemetry?.averageUsefulRatio || 0);
  const wasteStatus: V2ParityStatus = usefulRatio >= 0.8 ? 'met' : usefulRatio >= 0.6 ? 'partial' : 'missing';
  checks.push(createCheck(
    'query-context-telemetry-low-waste',
    'query',
    'Context usage telemetry shows low waste',
    wasteStatus,
    wasteStatus === 'met'
      ? 'Useful artifact ratio is at or above target.'
      : wasteStatus === 'partial'
        ? 'Useful artifact ratio is acceptable but below low-waste target.'
        : 'Useful artifact ratio is below target.',
    [
      `average_useful_ratio=${round(usefulRatio)}`,
      `total_context_runs=${contextTelemetry?.totalRuns || 0}`,
    ],
  ));

  const reviewGapPrecision = Number(evalGraph?.dashboardMetrics?.review?.gapPrecision || 0);
  const reviewSeverityCalibration = Number(evalGraph?.dashboardMetrics?.review?.gapSeverityCalibration || 0);
  const reviewProofStatus: V2ParityStatus = (
    constraintGraph
    && reviewGapPrecision >= 0.7
    && reviewSeverityCalibration >= 0.6
  )
    ? 'met'
    : constraintGraph
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'review-proof-ranked-closure-gap-constraint',
    'review',
    'Review closure/gap/constraint callouts are ranked and proof-backed',
    reviewProofStatus,
    reviewProofStatus === 'met'
      ? 'Constraint graph and calibrated review metrics indicate ranked, proof-backed findings.'
      : reviewProofStatus === 'partial'
        ? 'Constraint graph exists, but review precision/calibration metrics are below parity targets.'
        : 'Constraint/review proof ranking signals are missing.',
    [
      `constraint_rules=${constraintGraph?.catalog.totalRules || 0}`,
      `review_gap_precision=${round(reviewGapPrecision)}`,
      `review_gap_severity_calibration=${round(reviewSeverityCalibration)}`,
    ],
  ));

  const nonFunctional = evalGraph?.dashboardMetrics?.nonFunctional;
  const constraintFamilies = constraintGraph?.catalog?.byFamily;
  const nonFunctionalStatus: V2ParityStatus = (
    nonFunctional
    && constraintFamilies
    && Number(constraintFamilies.security || 0) > 0
    && Number(constraintFamilies.performance || 0) > 0
    && Number(constraintFamilies.dependency || 0) > 0
    && Number(nonFunctional.securityIssueMissRate ?? 1) <= 0.25
    && Number(nonFunctional.perfRegressionMissRate ?? 1) <= 0.25
    && Number(nonFunctional.badDependencyDecisionRate ?? 1) <= 0.25
  )
    ? 'met'
    : (nonFunctional || constraintFamilies)
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'review-security-perf-dep-visibility',
    'review',
    'Security/performance/dependency issues show up in review',
    nonFunctionalStatus,
    nonFunctionalStatus === 'met'
      ? 'Non-functional miss rates and constraint-family coverage satisfy parity targets.'
      : nonFunctionalStatus === 'partial'
        ? 'Some non-functional coverage signals exist but targets are not fully met.'
        : 'No non-functional review coverage signals found.',
    [
      `security_miss_rate=${round(Number(nonFunctional?.securityIssueMissRate || 0))}`,
      `perf_miss_rate=${round(Number(nonFunctional?.perfRegressionMissRate || 0))}`,
      `dep_miss_rate=${round(Number(nonFunctional?.badDependencyDecisionRate || 0))}`,
    ],
  ));

  const requestedRuntimeProbes = Number(constraintGraph?.patchGate.requestedRuntimeProbe || 0);
  const plannerProbeCapability = Boolean(planEnvelope?.operators.some(op => op.name === 'request_runtime_probe'));
  const runtimeProbeCount = Math.max(
    Number(runtimeTruth?.probePlan.length || 0),
    Number(reviewRuntimeProbes?.requestCount || 0),
  );
  const reviewRuntimeHighPriority = Number(reviewRuntimeProbes?.highPriorityCount || 0);
  const reviewProbeTriggers = Array.isArray(reviewRuntimeProbes?.triggers)
    ? reviewRuntimeProbes.triggers.filter(Boolean).length
    : 0;
  const hasReviewProbeSignal = requestedRuntimeProbes > 0
    || (planEnvelope?.mode === 'review' && (planEnvelope.requestedProbes.length || 0) > 0)
    || reviewProbeTriggers > 0;
  const hasReviewProbeSnapshot = Boolean(String(reviewRuntimeProbes?.generatedAt || '').trim());
  const reviewProbeStatus: V2ParityStatus = (
    (hasReviewProbeSignal && runtimeProbeCount > 0)
    || (!hasReviewProbeSignal && (plannerProbeCapability || hasReviewProbeSnapshot))
  )
    ? 'met'
    : (hasReviewProbeSignal || plannerProbeCapability || hasReviewProbeSnapshot || runtimeProbeCount > 0)
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'review-micro-runtime-probes-on-uncertainty',
    'review',
    'Review can request micro runtime probes when uncertainty is high',
    reviewProbeStatus,
    reviewProbeStatus === 'met'
      ? hasReviewProbeSignal
        ? 'Runtime probes are requested and present when review uncertainty signals exist.'
        : 'Review probe capability is present and latest review snapshot did not require runtime probes.'
      : reviewProbeStatus === 'partial'
        ? 'Probe request signals exist but no matching runtime probe evidence was recorded.'
        : 'No review-time probe request signal found.',
    [
      `requested_runtime_probes=${requestedRuntimeProbes}`,
      `planner_probe_capability=${plannerProbeCapability}`,
      `runtime_probe_count=${runtimeProbeCount}`,
      `review_runtime_probe_count=${Number(reviewRuntimeProbes?.requestCount || 0)}`,
      `review_runtime_probe_high_priority=${reviewRuntimeHighPriority}`,
      `review_runtime_probe_triggers=${reviewProbeTriggers}`,
      `review_runtime_probe_snapshot=${hasReviewProbeSnapshot}`,
      `review_runtime_probe_source=${String(reviewRuntimeProbes?.runtimeSource || 'none')}`,
    ],
  ));

  const companionRecall = Number(evalGraph?.dashboardMetrics?.implement?.companionEditRecall || 0);
  const companionRecallStatus: V2ParityStatus = companionRecall >= 0.8
    ? 'met'
    : companionRecall >= 0.6
      ? 'partial'
      : companionRecall > 0
        ? 'missing'
        : 'unverified';
  checks.push(createCheck(
    'implement-companion-edit-recall',
    'implement',
    'Companion edit recall is high',
    companionRecallStatus,
    companionRecallStatus === 'unverified'
      ? 'No implement recall metric observed yet.'
      : companionRecallStatus === 'met'
        ? 'Companion recall meets target threshold.'
        : 'Companion recall is below parity threshold.',
    [`companion_edit_recall=${round(companionRecall)}`],
  ));

  const precedentCandidates = Number(distillationEngine?.precedentRanker?.candidateCount || 0);
  const precedentConfidence = Number(distillationEngine?.precedentRanker?.confidence || 0);
  const precedentStatus: V2ParityStatus = precedentCandidates >= 3 && precedentConfidence >= 0.75
    ? 'met'
    : precedentCandidates > 0
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'implement-slice-native-precedents',
    'implement',
    'Precedents are slice-native, not just process-native',
    precedentStatus,
    precedentStatus === 'met'
      ? 'Slice-ranked precedent set has depth and confidence.'
      : precedentStatus === 'partial'
        ? 'Precedent ranking is present but sparse or low confidence.'
        : 'No slice-ranked precedent evidence found.',
    [
      `precedent_candidate_count=${precedentCandidates}`,
      `precedent_confidence=${round(precedentConfidence)}`,
    ],
  ));

  const patchGateChecked = Number(constraintGraph?.patchGate.checked || 0);
  const postPatchGuardMandatory = input.postImplementPatchGuardMandatory === true;
  const patchGuardStatus: V2ParityStatus = patchGateChecked > 0
    ? (postPatchGuardMandatory ? 'met' : 'partial')
    : 'missing';
  checks.push(createCheck(
    'implement-auto-patch-guard-before-finalize',
    'implement',
    'Patch guard runs automatically before finalizing',
    patchGuardStatus,
    patchGuardStatus === 'met'
      ? 'Patch gate checks are active and finalize policy enforces patch-guard gating.'
      : patchGuardStatus === 'partial'
      ? 'Patch gate activity is present, but finalize-time hard enforcement is not yet proven end-to-end.'
      : 'No patch gate activity recorded.',
    [
      `patch_gate_checked=${patchGateChecked}`,
      `patch_gate_blocked=${constraintGraph?.patchGate.blocked || 0}`,
      `post_patch_guard_mandatory=${postPatchGuardMandatory}`,
    ],
  ));

  const postReviewMandatory = input.postImplementReviewMandatory === true;
  checks.push(createCheck(
    'implement-post-review-mandatory',
    'implement',
    'Post-implement auto-review is mandatory',
    postReviewMandatory ? 'met' : 'missing',
    postReviewMandatory
      ? 'Implement flow enforces post-edit review contract as non-optional.'
      : 'Implement flow still allows post-edit review contract opt-out.',
    [`post_edit_review_mandatory=${postReviewMandatory}`],
  ));

  const requestedProbeCount = Number(planEnvelope?.requestedProbes.length || 0);
  const constraintRequestedProbeCount = Number(constraintGraph?.requestedProbes.length || 0);
  const runtimeSourceFileCount = Number(runtimeTruth?.sourceFiles.length || 0);
  const runtimeWitnessCards = Number(runtimeTruth?.compressed.witnessCards || 0);
  const runtimeObservedLoops = Number(runtimeTruth?.compressed.observedLoops || 0);
  const runtimeSnapshotCount = Number(runtimeTruth?.snapshot.requestSpans || 0)
    + Number(runtimeTruth?.snapshot.dbQueries || 0)
    + Number(runtimeTruth?.snapshot.payloadShapes || 0);
  const runtimeEvidenceCount = runtimeSourceFileCount + runtimeWitnessCards + runtimeObservedLoops + runtimeSnapshotCount;
  const probeTemplates = [
    ...(runtimeTruth?.probePlan || []),
    ...(planEnvelope?.requestedProbes || []),
    ...(constraintGraph?.requestedProbes || []),
  ];
  const scopedProbeCount = probeTemplates.filter(probe => (
    Number(probe.scope?.files?.length || 0)
    + Number(probe.scope?.tests?.length || 0)
    + Number(probe.scope?.endpoints?.length || 0)
  ) > 0).length;
  const selfContainedProbeCount = probeTemplates.filter(probe => (
    Number(probe.ttlMinutes || 0) >= 5
    && Number(probe.ttlMinutes || 0) <= 240
    && Number(probe.targetFamilies?.length || 0) > 0
    && (
      Number(probe.scope?.files?.length || 0)
      + Number(probe.scope?.tests?.length || 0)
      + Number(probe.scope?.endpoints?.length || 0)
    ) > 0
  )).length;
  const runtimeAutoStatus: V2ParityStatus = (
    runtimeProbeCount > 0
    && (requestedProbeCount > 0 || constraintRequestedProbeCount > 0)
    && probeTemplates.length > 0
    && selfContainedProbeCount === probeTemplates.length
    && runtimeEvidenceCount > 0
  )
    ? 'met'
    : (runtimeProbeCount > 0 || probeTemplates.length > 0)
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'debug-automatic-selective-runtime-probes',
    'debug',
    'Runtime probes are automatic, selective, and self-contained',
    runtimeAutoStatus,
    runtimeAutoStatus === 'met'
      ? 'Planner requests and runtime probe outputs are both present with source scoping.'
      : runtimeAutoStatus === 'partial'
        ? 'Probe planning exists, but runtime-backed selective closure is not fully proven.'
        : 'No runtime probe evidence found.',
    [
      `requested_probe_count=${requestedProbeCount}`,
      `constraint_requested_probe_count=${constraintRequestedProbeCount}`,
      `runtime_probe_count=${runtimeProbeCount}`,
      `runtime_source_file_count=${runtimeSourceFileCount}`,
      `runtime_evidence_count=${runtimeEvidenceCount}`,
      `scoped_probe_count=${scopedProbeCount}`,
      `self_contained_probe_count=${selfContainedProbeCount}`,
    ],
  ));

  const reconciliationTotal = Number(runtimeTruth?.reconciliation.supportsStaticEdge || 0)
    + Number(runtimeTruth?.reconciliation.fillsStaticGap || 0)
    + Number(runtimeTruth?.reconciliation.contradictsStaticExpectation || 0)
    + Number(runtimeTruth?.reconciliation.revealsHiddenDynamicBranch || 0)
    + Number(runtimeTruth?.reconciliation.revealsDeadStaticOnlyPath || 0);
  const runtimeViolationCount = Number((constraintGraph?.violations || []).filter(item => item.family === 'runtime').length || 0);
  const brokenLoopStatus: V2ParityStatus = (
    runtimeEvidenceCount > 0
    && (reconciliationTotal > 0 || runtimeViolationCount > 0)
    && (runtimeObservedLoops > 0 || runtimeWitnessCards > 0)
  )
    ? 'met'
    : (runtimeProbeCount > 0 || runtimeEvidenceCount > 0 || runtimeViolationCount > 0)
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'debug-broken-loop-static-runtime-truth',
    'debug',
    'Broken-loop localization uses both static and runtime truth',
    brokenLoopStatus,
    brokenLoopStatus === 'met'
      ? 'Runtime reconciliation and observed-loop evidence are both present.'
      : brokenLoopStatus === 'partial'
        ? 'Runtime truth is present but full static/runtime broken-loop linkage is weak.'
        : 'No runtime/static reconciliation evidence found.',
    [
      `reconciliation_events=${reconciliationTotal}`,
      `observed_loops=${runtimeObservedLoops}`,
      `runtime_violation_count=${runtimeViolationCount}`,
      `runtime_witness_cards=${runtimeWitnessCards}`,
    ],
  ));

  const brokenLoopTop3 = Number(evalGraph?.dashboardMetrics?.debug?.brokenLoopTop3 || 0);
  const validationTests = dedupe([
    ...(constraintGraph?.requestedTests || []),
    ...(brainPacket?.testPlan?.suggested || []),
  ]);
  const validationTestCount = validationTests
    .filter(testId => /(runtime|debug|probe)/i.test(testId))
    .length;
  const hasValidationEvidence = runtimeWitnessCards > 0 || validationTestCount > 0;
  const rootCauseStatus: V2ParityStatus = brokenLoopTop3 >= 0.7 && hasValidationEvidence
    ? 'met'
    : (brokenLoopTop3 > 0 || hasValidationEvidence)
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'debug-root-cause-with-validating-witness',
    'debug',
    'Debug returns root-cause candidates with validating tests/witnesses',
    rootCauseStatus,
    rootCauseStatus === 'met'
      ? 'Broken-loop quality metrics plus validating tests/witnesses satisfy parity target.'
      : rootCauseStatus === 'partial'
        ? 'Root-cause signal exists, but witness-backed quality is below target.'
        : 'No root-cause quality signal detected.',
    [
      `broken_loop_top3=${round(brokenLoopTop3)}`,
      `witness_cards=${runtimeWitnessCards}`,
      `validation_tests=${validationTestCount}`,
    ],
  ));

  const plannerOutcomeStatus: V2ParityStatus = (
    Number(distillationEngine?.runCount || 0) > 0
    && !isRuleBaselinePolicy(plannerPolicyVersion)
  )
    ? 'met'
    : Number(distillationEngine?.runCount || 0) > 0
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'feedback-planner-updates-from-outcomes',
    'self_feedback',
    'Planner updates from outcomes',
    plannerOutcomeStatus,
    plannerOutcomeStatus === 'met'
      ? 'Distillation outcomes are promoted into active planner policy.'
      : plannerOutcomeStatus === 'partial'
        ? 'Distillation outcomes are recorded but planner policy remains baseline.'
        : 'No outcome-driven planner update signal found.',
    [
      `distillation_run_count=${distillationEngine?.runCount || 0}`,
      `planner_policy_version=${plannerPolicyVersion || 'unset'}`,
    ],
  ));

  const cards = Number(experienceGovernor?.totals.cards || 0);
  const droppedCards = Number(experienceGovernor?.totals.dropped || 0);
  const generatedCards = Number(experienceGovernor?.totals.generated || 0);
  const retainedCards = Number(experienceGovernor?.totals.retained || 0);
  const memoryStatus: V2ParityStatus = cards > 0 && (droppedCards > 0 || (generatedCards > 0 && retainedCards > 0))
    ? 'met'
    : cards > 0
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'feedback-memory-governed-and-decayed',
    'self_feedback',
    'Memory cards are governed and decayed',
    memoryStatus,
    memoryStatus === 'met'
      ? droppedCards > 0
        ? 'Experience cards are generated and decay-drop events are active.'
        : 'Experience cards are generated and actively governed by retain-vs-generate decisions.'
      : memoryStatus === 'partial'
        ? 'Experience cards exist, but no decay events have been recorded yet.'
        : 'No governed memory card signal found.',
    [
      `card_count=${cards}`,
      `dropped_count=${droppedCards}`,
      `generated_count=${generatedCards}`,
      `retained_count=${retainedCards}`,
    ],
  ));

  const operatorStatus: V2ParityStatus = (
    Number(toolsmith?.synthesis.candidatesGenerated || 0) > 0
    && Number(toolsmith?.promotion.eligible || 0) > 0
  )
    ? 'met'
    : Number(toolsmith?.runCount || 0) > 0
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'feedback-operators-auto-mined-evaluated',
    'self_feedback',
    'Operator candidates are auto-mined and evaluated',
    operatorStatus,
    operatorStatus === 'met'
      ? 'Toolsmith mined and promoted candidate operators under guardrails.'
      : operatorStatus === 'partial'
        ? 'Toolsmith is running but has not produced eligible operator candidates.'
        : 'No toolsmith operator mining signal found.',
    [
      `toolsmith_run_count=${toolsmith?.runCount || 0}`,
      `operator_candidates=${toolsmith?.synthesis.candidatesGenerated || 0}`,
      `eligible_promotions=${toolsmith?.promotion.eligible || 0}`,
    ],
  ));

  const canaryStatus: V2ParityStatus = (
    Number(evalGraph?.canaryHarness.runCount || 0) > 0
    && typeof evalGraph?.canaryHarness.promotionAllowed === 'boolean'
  )
    ? 'met'
    : Number(evalGraph?.canaryHarness.runCount || 0) > 0
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'feedback-eval-canaries-gate-promotions',
    'self_feedback',
    'Eval canaries gate promotions',
    canaryStatus,
    canaryStatus === 'met'
      ? 'Canary runs are active and promotion gate state is explicit.'
      : canaryStatus === 'partial'
        ? 'Canary runs exist but promotion gating signal is incomplete.'
        : 'No eval canary signal found.',
    [
      `canary_run_count=${evalGraph?.canaryHarness.runCount || 0}`,
      `canary_promotion_allowed=${String(evalGraph?.canaryHarness.promotionAllowed ?? false)}`,
    ],
  ));

  const successfulProducers = producerReports.filter(report => report.status === 'ok');
  const hasValidationSignal = successfulProducers.every(report => report.validArtifactCount >= 0);
  const hasScoringSignal = successfulProducers.every(report => report.score && Number.isFinite(report.score.health));
  const producerLifecycleStatus: V2ParityStatus = (
    producerReports.length > 0
    && producerReports.every(report => report.status !== 'error')
    && hasValidationSignal
    && hasScoringSignal
  )
    ? 'met'
    : successfulProducers.length > 0
      ? 'partial'
      : 'missing';
  checks.push(createCheck(
    'feedback-subsystem-lifecycle-closure',
    'self_feedback',
    'Every subsystem has producer + validator + consumer + forgetting',
    producerLifecycleStatus,
    producerLifecycleStatus === 'met'
      ? 'Producer reports show detect/validate/score lifecycle without hard failures.'
      : producerLifecycleStatus === 'partial'
        ? 'Some producer lifecycle signals exist, but full closure is not yet proven.'
        : 'No producer lifecycle signal found.',
    [
      `producer_count=${producerReports.length}`,
      `producer_ok=${successfulProducers.length}`,
      `producer_errors=${producerReports.filter(report => report.status === 'error').length}`,
    ],
  ));

  const pillars = summarizePillar(checks);
  const total = checks.length;
  const met = checks.filter(check => check.status === 'met').length;
  const partial = checks.filter(check => check.status === 'partial').length;
  const missing = checks.filter(check => check.status === 'missing').length;
  const unverified = checks.filter(check => check.status === 'unverified').length;
  const overallScore = total > 0
    ? round(checks.reduce((acc, check) => acc + scoreStatus(check.status), 0) / total)
    : 0;
  const blockers = checks
    .filter(check => check.status !== 'met')
    .map(check => `${check.id}: ${check.note}`);

  return {
    generatedAt: input.generatedAt || new Date().toISOString(),
    overall: {
      ready: blockers.length === 0,
      met,
      partial,
      missing,
      unverified,
      total,
      score: overallScore,
    },
    pillars,
    checks,
    blockers,
  };
};
