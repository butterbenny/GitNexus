export const BRAIN_ARTIFACT_SCHEMA_VERSION = 1;
export const BRAIN_MANIFEST_SCHEMA_VERSION = 1;
export const BRAIN_PRODUCER_REPORT_SCHEMA_VERSION = 1;

export type BrainEvent =
  | 'analyze'
  | 'serve'
  | 'mode-run'
  | 'test-complete'
  | 'patch-validated'
  | 'repo-change'
  | 'idle';

export type BrainProducerKind =
  | 'precision'
  | 'runtime'
  | 'memory'
  | 'summary'
  | 'constraint'
  | 'eval'
  | 'toolsmith';

export type BrainTrustTier =
  | 'deterministic'
  | 'precision-overlay'
  | 'runtime-observed'
  | 'historical'
  | 'semantic'
  | 'heuristic';

export type BrainTaintLevel =
  | 'trusted'
  | 'semi-trusted'
  | 'untrusted'
  | 'quarantined';

export interface BrainArtifact {
  id: string;
  producerId: string;
  kind: string;
  schemaVersion: number;
  createdAt: string;
  payload?: Record<string, unknown>;
  confidence?: number;
  trustTier: BrainTrustTier;
  taint: BrainTaintLevel;
  ttlUntil?: string;
}

export type BrainMode = 'query' | 'review' | 'implement' | 'debug';

export type PlannerIntentClass =
  | 'symbol'
  | 'slice'
  | 'contract'
  | 'symptom'
  | 'feature-request'
  | 'refactor'
  | 'maintenance';

export type PlannerContextShape = 'thin' | 'standard' | 'deep';

export interface PlannerState {
  mode: BrainMode;
  repoFingerprint: string;
  intentClass: PlannerIntentClass;
  anchorEntropy: number;
  candidateSlices: number;
  candidateContracts: number;
  uncertaintyVector: {
    static: number;
    runtime: number;
    precedent: number;
    memory: number;
  };
  budget: {
    maxTokens: number;
    maxFiles: number;
    maxOperators: number;
  };
  priorOutcomeHints: {
    similarSuccessRate: number;
    similarFailureRate: number;
  };
}

export interface BrainAnchor {
  id: string;
  kind: 'file' | 'symbol' | 'slice' | 'contract';
  label: string;
  filePath?: string;
  confidence: number;
}

export interface PlannedOperator {
  name:
    | 'resolve_anchor'
    | 'expand_slice'
    | 'expand_shape'
    | 'compute_gap_delta'
    | 'select_precedents'
    | 'retrieve_memory_cards'
    | 'compile_constraints'
    | 'select_tests'
    | 'request_runtime_probe'
    | 'compile_context_packet';
  reason: string;
  priority: number;
}

export interface ProofObjective {
  id: string;
  claim: string;
  required: boolean;
}

export interface ProbeRequest {
  reason: 'debug-symptom' | 'review-uncertainty' | 'implement-verification' | 'eval-canary';
  anchors: string[];
  targetFamilies: RuntimeTargetFamily[];
  scope: {
    tests?: string[];
    endpoints?: string[];
    files?: string[];
  };
  ttlMinutes: number;
}

export type RuntimeTargetFamily =
  | 'http'
  | 'auth'
  | 'cache'
  | 'shape'
  | 'event'
  | 'db'
  | 'exception';

export type RuntimeReconciliationOutcome =
  | 'supports-static-edge'
  | 'fills-static-gap'
  | 'contradicts-static-expectation'
  | 'reveals-hidden-dynamic-branch'
  | 'reveals-dead-static-only-path';

export interface RuntimeWitnessEvidence {
  filePath?: string;
  summary: string;
  confidence: number;
}

export interface RuntimeWitnessCard {
  id: string;
  sliceId: string;
  claim: string;
  evidence: RuntimeWitnessEvidence[];
  observedChain: string[];
  contradictions: string[];
  freshness: string;
  confidence: number;
  reconciliation: RuntimeReconciliationOutcome;
}

export interface ObservedLoop {
  id: string;
  route: string;
  hitCount: number;
  averageDurationMs: number;
  maxDurationMs: number;
}

export interface ContradictionWitness {
  id: string;
  witnessId: string;
  reason: string;
  severity: 'high' | 'medium' | 'low';
}

export interface CoverageWitness {
  id: string;
  anchorCount: number;
  coveredAnchors: number;
  uncoveredAnchors: string[];
  coverageRatio: number;
}

export interface RuntimeTruthSummary {
  generatedAt: string;
  sourceFiles: string[];
  probePlan: ProbeRequest[];
  snapshot: {
    requestSpans: number;
    dbQueries: number;
    payloadShapes: number;
  };
  compressed: {
    witnessCards: number;
    observedLoops: number;
    contradictionWitnesses: number;
    coverageWitnesses: number;
  };
  reconciliation: {
    supportsStaticEdge: number;
    fillsStaticGap: number;
    contradictsStaticExpectation: number;
    revealsHiddenDynamicBranch: number;
    revealsDeadStaticOnlyPath: number;
  };
  witnesses: RuntimeWitnessCard[];
  observedLoops: ObservedLoop[];
  contradictions: ContradictionWitness[];
  coverage: CoverageWitness[];
  warnings: string[];
}

export type ConstraintFamily =
  | 'structural'
  | 'shape'
  | 'auth'
  | 'runtime'
  | 'dependency'
  | 'performance'
  | 'security';

export type ConstraintSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ConstraintGateAction =
  | 'block'
  | 'warn'
  | 'request-runtime-probe'
  | 'request-targeted-tests';

export interface ConstraintRule {
  id: string;
  family: ConstraintFamily;
  severity: ConstraintSeverity;
  summary: string;
  dsl: string;
}

export interface ConstraintViolation {
  id: string;
  ruleId: string;
  family: ConstraintFamily;
  severity: ConstraintSeverity;
  summary: string;
  evidence: string[];
  gateAction: ConstraintGateAction;
  contradiction: boolean;
}

export interface ConstraintGraphSummary {
  generatedAt: string;
  sourceFiles: string[];
  catalog: {
    totalRules: number;
    byFamily: Record<ConstraintFamily, number>;
  };
  solver: {
    patternChecks: number;
    finiteChecks: number;
    cardinalityChecks: number;
    forwardChainInferences: number;
    contradictions: number;
  };
  patchGate: {
    checked: number;
    blocked: number;
    warned: number;
    requestedRuntimeProbe: number;
    requestedTargetedTests: number;
  };
  rules: ConstraintRule[];
  violations: ConstraintViolation[];
  requestedProbes: ProbeRequest[];
  requestedTests: string[];
  warnings: string[];
}

export type EvalTaskFamily =
  | 'bug-fix'
  | 'feature-addition'
  | 'refactor'
  | 'security-fix'
  | 'performance-fix'
  | 'dependency-decision'
  | 'contract-migration'
  | 'auth-closure-repair'
  | 'cache-closure-repair';

export interface EvalTaskRecord {
  id: string;
  family: EvalTaskFamily;
  mode: BrainMode;
  label: string;
  sourceSignals: string[];
  changedPaths: string[];
  relevantTests: string[];
  requiredConstraints: string[];
  createdAt: string;
}

export interface EvalGoldContextRecord {
  id: string;
  taskId: string;
  changedSlices: string[];
  proofSubgraph: string[];
  goldFiles: string[];
  requiredConstraints: string[];
  relevantTests: string[];
  runtimeWitnesses: string[];
  generatedAt: string;
}

export interface EvalCanaryMetrics {
  goldContextRecall: number;
  goldContextPrecision: number;
  proofSufficiency: number;
  filesOpenedPerSolvedTask: number;
  tokensPerUsefulArtifact: number;
}

export interface EvalCanaryRun {
  id: string;
  taskId: string;
  family: EvalTaskFamily;
  score: number;
  passed: boolean;
  metrics: EvalCanaryMetrics;
  regressionsDetected: number;
  createdAt: string;
}

export interface EvalRegressionRecord {
  id: string;
  family: EvalTaskFamily;
  status: 'open' | 'resolved';
  taskId: string;
  openedAt: string;
  resolvedAt?: string;
  previousScore: number;
  currentScore: number;
}

export interface EvalGraphSummary {
  generatedAt: string;
  storePath: string;
  taskMiner: {
    mined: number;
    total: number;
    byFamily: Record<EvalTaskFamily, number>;
  };
  goldContextMiner: {
    mined: number;
    total: number;
    averageGoldFiles: number;
    averageRequiredConstraints: number;
  };
  canaryHarness: {
    runCount: number;
    lastRunAt: string;
    lastScore: number;
    passRate: number;
    regressionsDetected: number;
    promotionAllowed: boolean;
  };
  regressionTracking: {
    openRegressions: number;
    newRegressions: number;
    resolvedRegressions: number;
  };
  dashboardMetrics: {
    retrieval: EvalCanaryMetrics;
    review: {
      gapPrecision: number;
      gapSeverityCalibration: number;
      missedClosureRate: number;
      falseAlarmRate: number;
    };
    implement: {
      companionEditRecall: number;
      precedentUsefulness: number;
      patchAcceptanceRate: number;
      postReviewDeltaCount: number;
    };
    debug: {
      brokenLoopTop1: number;
      brokenLoopTop3: number;
      usefulProbeRate: number;
      timeToRootCause: number;
      contradictionResolutionRate: number;
    };
    nonFunctional: {
      securityIssueMissRate: number;
      perfRegressionMissRate: number;
      badDependencyDecisionRate: number;
    };
    learning: {
      plannerUplift: number;
      memoryCardUtility: number;
      operatorPromotionHitRate: number;
      staleMemoryDecayCorrectness: number;
    };
  };
  baselines: {
    v1MedianTokensPerUsefulArtifact: number;
    source: 'historical-window' | 'insufficient-history';
    sampleCount: number;
    windowSize: number;
  };
  latestTask?: EvalTaskRecord;
  latestGoldContext?: EvalGoldContextRecord;
  latestCanary?: EvalCanaryRun;
  warnings: string[];
}

export interface DistillationPolicyArm {
  id: string;
  sampleCount: number;
  avgReward: number;
  lastReward: number;
  weight: number;
  updatedAt: string;
}

export interface DistilledPrecedentHint {
  id: string;
  score: number;
}

export interface DistillationEngineSummary {
  generatedAt: string;
  storePath: string;
  runCount: number;
  artifacts: {
    rankers: number;
    plannerPolicies: number;
    testSelectors: number;
    precedentRankers: number;
    riskScorers: number;
  };
  plannerBandit: {
    exploreRate: number;
    winningPolicy: string;
    expectedReward: number;
    policyArms: DistillationPolicyArm[];
  };
  testSelector: {
    candidateCount: number;
    selected: string[];
    estimatedRecall: number;
  };
  precedentRanker: {
    candidateCount: number;
    topPrecedents: DistilledPrecedentHint[];
    confidence: number;
  };
  riskScorer: {
    score: number;
    level: 'low' | 'medium' | 'high';
    drivers: string[];
  };
  promotion: {
    shadowReady: boolean;
    canaryEligible: boolean;
    promoted: boolean;
    rollbackReady: boolean;
  };
  warnings: string[];
}

export type ToolsmithImplementationKind = 'cypher' | 'pipeline' | 'composite';

export type ToolsmithSafetyStatus = 'pending' | 'approved' | 'rejected';

export interface ToolsmithOperatorArtifact {
  id: string;
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  implementationKind: ToolsmithImplementationKind;
  createdFromTraceIds: string[];
  utilityGain: number;
  safetyStatus: ToolsmithSafetyStatus;
  deterministicTestsPass: boolean;
  securityPolicyApproved: boolean;
  capabilitySafe: boolean;
  proofCarrying: boolean;
  promoted: boolean;
  rollbackReady: boolean;
  lastEvaluatedAt: string;
}

export interface ToolsmithSummary {
  generatedAt: string;
  storePath: string;
  runCount: number;
  miner: {
    sequenceCount: number;
    topSequences: Array<{
      id: string;
      operators: string[];
      uses: number;
    }>;
  };
  synthesis: {
    candidatesGenerated: number;
    artifactsTotal: number;
    typedOperators: number;
    implementationKinds: Record<ToolsmithImplementationKind, number>;
  };
  sandbox: {
    profile: 'read-only' | 'patch-safe' | 'probe-safe' | 'full-local-sandbox';
    approved: number;
    pending: number;
    rejected: number;
  };
  promotion: {
    eligible: number;
    promoted: number;
    rolledBack: number;
    guardrails: {
      deterministicTests: boolean;
      evalCanary: boolean;
      securityPolicy: boolean;
      capabilitySafe: boolean;
      proofCarrying: boolean;
    };
  };
  latestOperators: ToolsmithOperatorArtifact[];
  warnings: string[];
}

export interface BridgePacket {
  id: string;
  sliceId: string;
  topologySketch: string;
  keyContracts: string[];
  gaps: string[];
  precedentHints: string[];
  proofHashes: string[];
  createdAt: string;
}

export interface GraphModelBridgeSummary {
  generatedAt: string;
  storePath: string;
  runCount: number;
  packetCount: number;
  latestPackets: BridgePacket[];
  coverage: {
    sliceBacked: number;
    proofBacked: number;
    avgProofHashes: number;
  };
  promotion: {
    symbolicEnabled: boolean;
    learnedCandidateReady: boolean;
  };
  learned: {
    mode: 'inactive' | 'shadow';
    modelPath: string;
    modelVersion: string;
    trainedAt: string;
    trainingPacketCount: number;
    shadowPredictions: Array<{
      packetId: string;
      predictedSliceId: string;
      confidence: number;
    }>;
    averageConfidence: number;
  };
  warnings: string[];
}

export type ExperienceCardStage =
  | 'anchor'
  | 'expand'
  | 'probe'
  | 'patch'
  | 'verify';

export type ExperienceCardType =
  | 'query'
  | 'review'
  | 'implement'
  | 'debug'
  | 'anti-pattern'
  | 'runtime'
  | 'constraint-exception';

export interface ExperienceCard {
  id: string;
  repoFingerprint: string;
  mode: BrainMode;
  type: ExperienceCardType;
  sliceFamily?: string;
  stage: ExperienceCardStage;
  trigger: string;
  lesson: string;
  supportingProof: string[];
  applicableWhen: string[];
  notApplicableWhen: string[];
  outcome: 'success' | 'partial' | 'failure';
  utilityScore: number;
  trustScore: number;
  freshnessScore: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceCardView {
  id: string;
  type: ExperienceCardType;
  stage: ExperienceCardStage;
  lesson: string;
  utility: number;
  outcome: 'success' | 'partial' | 'failure';
}

export interface ExperienceGovernorSummary {
  generatedAt: string;
  storePath: string;
  totals: {
    cards: number;
    generated: number;
    retained: number;
    dropped: number;
  };
  taxonomy: Record<ExperienceCardType, number>;
  stages: Record<ExperienceCardStage, number>;
  retrievedCards: ExperienceCardView[];
  warnings: string[];
}

export interface StopCondition {
  id: string;
  rule: string;
}

export interface PlanEnvelope {
  mode: BrainMode;
  anchors: BrainAnchor[];
  operators: PlannedOperator[];
  proofObjectives: ProofObjective[];
  requestedProbes: ProbeRequest[];
  contextShape: PlannerContextShape;
  stopConditions: StopCondition[];
  state: PlannerState;
}

export interface BrainPacket {
  mode: BrainMode;
  task: string;
  anchors: BrainAnchor[];
  primarySlices: Array<{ id: string; label: string; confidence: number }>;
  proofPack: {
    objectives: ProofObjective[];
    unresolved: string[];
  };
  obligations: string[];
  gaps: Array<{ id: string; summary: string; severity: 'high' | 'medium' | 'low' }>;
  precedents: Array<{ id: string; summary: string; confidence: number }>;
  runtimeWitnesses: RuntimeWitnessCard[];
  memoryCards: ExperienceCardView[];
  constraints: Array<{ id: string; summary: string; severity: 'critical' | 'high' | 'medium' | 'low' }>;
  testPlan: {
    suggested: string[];
    rationale: string;
  };
  riskProfile: {
    level: 'low' | 'medium' | 'high';
    reasons: string[];
  };
  editBudget: {
    maxFiles: number;
    preferredOrder: string[];
  };
}

export interface ContextUsageTelemetryEntry {
  createdAt: string;
  mode: BrainMode;
  contextShape: PlannerContextShape;
  anchorCount: number;
  operatorCount: number;
  retrievedArtifacts: number;
  usefulArtifacts: number;
  estimatedTokens: number;
  proofSufficiency: number;
}

export interface ContextUsageTelemetrySummary {
  totalRuns: number;
  averageUsefulRatio: number;
  averageProofSufficiency: number;
  lastRunAt: string;
}

export interface ReviewRuntimeProbeSummary {
  generatedAt: string;
  runtimeSource: string;
  requestCount: number;
  highPriorityCount: number;
  triggers: string[];
}

export type V2ParityPillar = 'query' | 'review' | 'implement' | 'debug' | 'self_feedback';

export type V2ParityStatus = 'met' | 'partial' | 'missing' | 'unverified';

export interface V2ParityCheck {
  id: string;
  pillar: V2ParityPillar;
  label: string;
  status: V2ParityStatus;
  note: string;
  evidence: string[];
}

export interface V2ParityPillarSummary {
  met: number;
  partial: number;
  missing: number;
  unverified: number;
  total: number;
  score: number;
}

export interface V2ParitySummary {
  generatedAt: string;
  overall: {
    ready: boolean;
    met: number;
    partial: number;
    missing: number;
    unverified: number;
    total: number;
    score: number;
  };
  pillars: Record<V2ParityPillar, V2ParityPillarSummary>;
  checks: V2ParityCheck[];
  blockers: string[];
}

export interface ValidatedBrainArtifact extends BrainArtifact {
  validation: {
    valid: boolean;
    issues: string[];
  };
}

export interface ProducerScore {
  health: number;
  utility: number;
  latencyMs: number;
  artifactCount: number;
  warnings: string[];
}

export interface ProducerContext {
  reason: BrainEvent;
  repoPath: string;
  storagePath: string;
  repoFingerprint: string;
  graphVersion: string;
  plannerPolicyVersion: string;
  changedPaths: string[];
  startedAt: string;
}

export interface BrainProducer {
  id: string;
  version: string;
  kind: BrainProducerKind;
  detect(ctx: ProducerContext): Promise<boolean>;
  produce(ctx: ProducerContext): Promise<BrainArtifact[]>;
  validate(artifacts: BrainArtifact[], ctx: ProducerContext): Promise<ValidatedBrainArtifact[]>;
  integrate(artifacts: ValidatedBrainArtifact[], ctx: ProducerContext): Promise<void>;
  score(ctx: ProducerContext): Promise<ProducerScore>;
  forget(ctx: ProducerContext): Promise<void>;
}

export interface ProducerRunReport {
  schemaVersion: number;
  producerId: string;
  producerVersion: string;
  kind: BrainProducerKind;
  status: 'ok' | 'skipped' | 'error';
  detected: boolean;
  artifactCount: number;
  validArtifactCount: number;
  durationMs: number;
  score?: ProducerScore;
  warnings: string[];
}

export type BrainStepStatus = 'ok' | 'placeholder' | 'error';

export interface BrainStepResult {
  step: string;
  status: BrainStepStatus;
  detail?: string;
}

export interface BrainTickInput {
  reason: BrainEvent;
  repoPath: string;
  storagePath: string;
  repoFingerprint: string;
  graphVersion: string;
  task?: string;
  modeHint?: BrainMode;
  plannerPolicyVersion?: string;
  changedPaths?: string[];
}

export interface BrainTickResult {
  manifestPath: string;
  manifest: {
    schemaVersion: number;
  };
  planEnvelope?: PlanEnvelope;
  brainPacket?: BrainPacket;
  contextTelemetry?: ContextUsageTelemetrySummary;
  runtimeTruth?: RuntimeTruthSummary;
  reviewRuntimeProbes?: ReviewRuntimeProbeSummary;
  experienceGovernor?: ExperienceGovernorSummary;
  constraintGraph?: ConstraintGraphSummary;
  evalGraph?: EvalGraphSummary;
  distillationEngine?: DistillationEngineSummary;
  toolsmith?: ToolsmithSummary;
  graphModelBridge?: GraphModelBridgeSummary;
  producerReports: ProducerRunReport[];
  steps: BrainStepResult[];
  warnings: string[];
}
