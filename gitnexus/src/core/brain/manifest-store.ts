import fs from 'fs/promises';
import path from 'path';
import {
  BRAIN_ARTIFACT_SCHEMA_VERSION,
  BRAIN_MANIFEST_SCHEMA_VERSION,
  BRAIN_PRODUCER_REPORT_SCHEMA_VERSION,
  BrainPacket,
  BrainEvent,
  ConstraintGraphSummary,
  ContextUsageTelemetryEntry,
  ContextUsageTelemetrySummary,
  DistillationEngineSummary,
  EvalGraphSummary,
  ExperienceGovernorSummary,
  GraphModelBridgeSummary,
  PlanEnvelope,
  ToolsmithSummary,
  RuntimeTruthSummary,
  ReviewRuntimeProbeSummary,
  V2ParitySummary,
  BrainStepResult,
  ProducerRunReport,
} from './types.js';
import { buildV2ParitySummary } from './v2-parity.js';

const MANIFESTS_DIR = 'manifests';
const BRAIN_MANIFEST_FILE = 'brain.json';

export interface BrainManifest {
  schemaVersion: number;
  artifactVersions: {
    brainManifest: number;
    producerReport: number;
    artifact: number;
  };
  repoFingerprint: string;
  graphVersion: string;
  plannerPolicyVersion: string;
  activeProducerVersions: Record<string, string>;
  runtimeTruthFreshness: string;
  memoryCardStats: {
    cards: number;
    antiPatterns: number;
    avgUtility: number;
  };
  evalStatus: {
    lastCanaryAt: string;
    regressionsOpen: number;
  };
  riskStatus: {
    securityFindingsOpen: number;
    perfFindingsOpen: number;
    depFindingsOpen: number;
  };
  tick: {
    reason: BrainEvent;
    finishedAt: string;
    durationMs: number;
    stepCount: number;
    producers: {
      total: number;
      succeeded: number;
      failed: number;
      skipped: number;
    };
  };
  planner?: {
    mode: string;
    intentClass: string;
    contextShape: string;
    anchorCount: number;
    operatorCount: number;
    requestedProbeCount: number;
    stopConditionCount: number;
  };
  contextCompiler?: {
    packetMode: string;
    packetTask: string;
    suggestedTestCount: number;
    unresolvedProofCount: number;
    telemetry?: ContextUsageTelemetrySummary;
    lastTelemetryEntry?: ContextUsageTelemetryEntry;
  };
  experienceGovernor?: {
    generatedAt: string;
    cardCount: number;
    generatedCount: number;
    retainedCount: number;
    droppedCount: number;
    retrievedCount: number;
    taxonomy: Record<string, number>;
    stages: Record<string, number>;
  };
  constraintGraph?: {
    generatedAt: string;
    ruleCount: number;
    violationCount: number;
    byFamily: Record<string, number>;
    patchGate: {
      checked: number;
      blocked: number;
      warned: number;
      requestedRuntimeProbe: number;
      requestedTargetedTests: number;
    };
    solver: {
      patternChecks: number;
      finiteChecks: number;
      cardinalityChecks: number;
      forwardChainInferences: number;
      contradictions: number;
    };
  };
  evalGraph?: {
    generatedAt: string;
    storePath: string;
    taskMiner: {
      mined: number;
      total: number;
      byFamily: Record<string, number>;
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
      retrieval: {
        goldContextRecall: number;
        goldContextPrecision: number;
        proofSufficiency: number;
        filesOpenedPerSolvedTask: number;
        tokensPerUsefulArtifact: number;
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
  };
  distillationEngine?: {
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
      policyArms: Array<{
        id: string;
        sampleCount: number;
        avgReward: number;
        lastReward: number;
        weight: number;
        updatedAt: string;
      }>;
    };
    testSelector: {
      candidateCount: number;
      selected: string[];
      estimatedRecall: number;
    };
    precedentRanker: {
      candidateCount: number;
      topPrecedents: Array<{
        id: string;
        score: number;
      }>;
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
  };
  toolsmith?: {
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
      implementationKinds: {
        cypher: number;
        pipeline: number;
        composite: number;
      };
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
  };
  graphModelBridge?: {
    generatedAt: string;
    storePath: string;
    runCount: number;
    packetCount: number;
    latestPacketCount: number;
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
      shadowPredictionCount: number;
      averageConfidence: number;
    };
  };
  runtimeTruth?: {
    generatedAt: string;
    sourceFileCount: number;
    probeCount: number;
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
  };
  reviewRuntimeProbes?: {
    generatedAt: string;
    runtimeSource: string;
    requestCount: number;
    highPriorityCount: number;
    triggers: string[];
  };
  v2Parity?: V2ParitySummary;
  steps: BrainStepResult[];
  producerReports: ProducerRunReport[];
  warnings: string[];
}

export interface BuildBrainManifestInput {
  reason: BrainEvent;
  repoFingerprint: string;
  graphVersion: string;
  plannerPolicyVersion: string;
  runtimeTruthFreshness: string;
  finishedAt: string;
  durationMs: number;
  planEnvelope?: PlanEnvelope;
  brainPacket?: BrainPacket;
  contextTelemetry?: ContextUsageTelemetrySummary;
  contextTelemetryEntry?: ContextUsageTelemetryEntry;
  experienceGovernor?: ExperienceGovernorSummary;
  constraintGraph?: ConstraintGraphSummary;
  evalGraph?: EvalGraphSummary;
  distillationEngine?: DistillationEngineSummary;
  toolsmith?: ToolsmithSummary;
  graphModelBridge?: GraphModelBridgeSummary;
  runtimeTruth?: RuntimeTruthSummary;
  reviewRuntimeProbes?: ReviewRuntimeProbeSummary;
  postImplementReviewMandatory?: boolean;
  postImplementPatchGuardMandatory?: boolean;
  steps: BrainStepResult[];
  producerReports: ProducerRunReport[];
  warnings: string[];
}

export const getBrainManifestPath = (storagePath: string): string => {
  return path.join(storagePath, MANIFESTS_DIR, BRAIN_MANIFEST_FILE);
};

export const buildBrainManifest = (input: BuildBrainManifestInput): BrainManifest => {
  const producers = input.producerReports || [];
  const succeeded = producers.filter(item => item.status === 'ok').length;
  const failed = producers.filter(item => item.status === 'error').length;
  const skipped = producers.filter(item => item.status === 'skipped').length;

  const activeProducerVersions = producers.reduce<Record<string, string>>((acc, item) => {
    if (item.status !== 'ok') return acc;
    acc[item.producerId] = item.producerVersion;
    return acc;
  }, {});

  const memoryCards = input.experienceGovernor?.retrievedCards || [];
  const avgUtility = memoryCards.length > 0
    ? Number((memoryCards.reduce((acc, card) => acc + Number(card.utility || 0), 0) / memoryCards.length).toFixed(4))
    : 0;
  const violations = input.constraintGraph?.violations || [];
  const securityFindingsOpen = violations.filter(item => item.family === 'security').length;
  const perfFindingsOpen = violations.filter(item => item.family === 'performance').length;
  const depFindingsOpen = violations.filter(item => item.family === 'dependency').length;
  const v2Parity = buildV2ParitySummary({
    generatedAt: input.finishedAt,
    plannerPolicyVersion: input.plannerPolicyVersion,
    planEnvelope: input.planEnvelope,
    brainPacket: input.brainPacket,
    contextTelemetry: input.contextTelemetry,
    constraintGraph: input.constraintGraph,
    evalGraph: input.evalGraph,
    distillationEngine: input.distillationEngine,
    toolsmith: input.toolsmith,
    runtimeTruth: input.runtimeTruth,
    reviewRuntimeProbes: input.reviewRuntimeProbes,
    experienceGovernor: input.experienceGovernor,
    producerReports: input.producerReports,
    postImplementReviewMandatory: input.postImplementReviewMandatory,
    postImplementPatchGuardMandatory: input.postImplementPatchGuardMandatory,
  });

  return {
    schemaVersion: BRAIN_MANIFEST_SCHEMA_VERSION,
    artifactVersions: {
      brainManifest: BRAIN_MANIFEST_SCHEMA_VERSION,
      producerReport: BRAIN_PRODUCER_REPORT_SCHEMA_VERSION,
      artifact: BRAIN_ARTIFACT_SCHEMA_VERSION,
    },
    repoFingerprint: input.repoFingerprint,
    graphVersion: input.graphVersion,
    plannerPolicyVersion: input.plannerPolicyVersion,
    activeProducerVersions,
    runtimeTruthFreshness: input.runtimeTruthFreshness,
    memoryCardStats: {
      cards: input.experienceGovernor?.totals.cards || 0,
      antiPatterns: input.experienceGovernor?.taxonomy?.['anti-pattern'] || 0,
      avgUtility,
    },
    evalStatus: {
      lastCanaryAt: input.evalGraph?.canaryHarness.lastRunAt || '',
      regressionsOpen: input.evalGraph?.regressionTracking.openRegressions || 0,
    },
    riskStatus: {
      securityFindingsOpen,
      perfFindingsOpen,
      depFindingsOpen,
    },
    v2Parity,
    tick: {
      reason: input.reason,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      stepCount: input.steps.length,
      producers: {
        total: producers.length,
        succeeded,
        failed,
        skipped,
      },
    },
    ...(input.planEnvelope ? {
      planner: {
        mode: input.planEnvelope.mode,
        intentClass: input.planEnvelope.state.intentClass,
        contextShape: input.planEnvelope.contextShape,
        anchorCount: input.planEnvelope.anchors.length,
        operatorCount: input.planEnvelope.operators.length,
        requestedProbeCount: input.planEnvelope.requestedProbes.length,
        stopConditionCount: input.planEnvelope.stopConditions.length,
      },
    } : {}),
    ...(input.brainPacket ? {
      contextCompiler: {
        packetMode: input.brainPacket.mode,
        packetTask: input.brainPacket.task,
        suggestedTestCount: input.brainPacket.testPlan.suggested.length,
        unresolvedProofCount: input.brainPacket.proofPack.unresolved.length,
        ...(input.contextTelemetry ? { telemetry: input.contextTelemetry } : {}),
        ...(input.contextTelemetryEntry ? { lastTelemetryEntry: input.contextTelemetryEntry } : {}),
      },
    } : {}),
    ...(input.experienceGovernor ? {
      experienceGovernor: {
        generatedAt: input.experienceGovernor.generatedAt,
        cardCount: input.experienceGovernor.totals.cards,
        generatedCount: input.experienceGovernor.totals.generated,
        retainedCount: input.experienceGovernor.totals.retained,
        droppedCount: input.experienceGovernor.totals.dropped,
        retrievedCount: input.experienceGovernor.retrievedCards.length,
        taxonomy: input.experienceGovernor.taxonomy,
        stages: input.experienceGovernor.stages,
      },
    } : {}),
    ...(input.constraintGraph ? {
      constraintGraph: {
        generatedAt: input.constraintGraph.generatedAt,
        ruleCount: input.constraintGraph.catalog.totalRules,
        violationCount: input.constraintGraph.violations.length,
        byFamily: input.constraintGraph.catalog.byFamily,
        patchGate: input.constraintGraph.patchGate,
        solver: input.constraintGraph.solver,
      },
    } : {}),
    ...(input.evalGraph ? {
      evalGraph: {
        generatedAt: input.evalGraph.generatedAt,
        storePath: input.evalGraph.storePath,
        taskMiner: input.evalGraph.taskMiner,
        goldContextMiner: input.evalGraph.goldContextMiner,
        canaryHarness: input.evalGraph.canaryHarness,
        regressionTracking: input.evalGraph.regressionTracking,
        dashboardMetrics: {
          retrieval: input.evalGraph.dashboardMetrics.retrieval,
          nonFunctional: input.evalGraph.dashboardMetrics.nonFunctional,
          learning: input.evalGraph.dashboardMetrics.learning,
        },
        baselines: input.evalGraph.baselines,
      },
    } : {}),
    ...(input.distillationEngine ? {
      distillationEngine: {
        generatedAt: input.distillationEngine.generatedAt,
        storePath: input.distillationEngine.storePath,
        runCount: input.distillationEngine.runCount,
        artifacts: input.distillationEngine.artifacts,
        plannerBandit: input.distillationEngine.plannerBandit,
        testSelector: input.distillationEngine.testSelector,
        precedentRanker: input.distillationEngine.precedentRanker,
        riskScorer: input.distillationEngine.riskScorer,
        promotion: input.distillationEngine.promotion,
      },
    } : {}),
    ...(input.toolsmith ? {
      toolsmith: {
        generatedAt: input.toolsmith.generatedAt,
        storePath: input.toolsmith.storePath,
        runCount: input.toolsmith.runCount,
        miner: input.toolsmith.miner,
        synthesis: input.toolsmith.synthesis,
        sandbox: input.toolsmith.sandbox,
        promotion: input.toolsmith.promotion,
      },
    } : {}),
    ...(input.graphModelBridge ? {
      graphModelBridge: {
        generatedAt: input.graphModelBridge.generatedAt,
        storePath: input.graphModelBridge.storePath,
        runCount: input.graphModelBridge.runCount,
        packetCount: input.graphModelBridge.packetCount,
        latestPacketCount: input.graphModelBridge.latestPackets.length,
        coverage: input.graphModelBridge.coverage,
        promotion: input.graphModelBridge.promotion,
        learned: {
          mode: input.graphModelBridge.learned.mode,
          modelPath: input.graphModelBridge.learned.modelPath,
          modelVersion: input.graphModelBridge.learned.modelVersion,
          trainedAt: input.graphModelBridge.learned.trainedAt,
          trainingPacketCount: input.graphModelBridge.learned.trainingPacketCount,
          shadowPredictionCount: input.graphModelBridge.learned.shadowPredictions.length,
          averageConfidence: input.graphModelBridge.learned.averageConfidence,
        },
      },
    } : {}),
    ...(input.runtimeTruth ? {
      runtimeTruth: {
        generatedAt: input.runtimeTruth.generatedAt,
        sourceFileCount: input.runtimeTruth.sourceFiles.length,
        probeCount: input.runtimeTruth.probePlan.length,
        snapshot: input.runtimeTruth.snapshot,
        compressed: input.runtimeTruth.compressed,
        reconciliation: input.runtimeTruth.reconciliation,
      },
    } : {}),
    ...(input.reviewRuntimeProbes ? {
      reviewRuntimeProbes: {
        generatedAt: input.reviewRuntimeProbes.generatedAt,
        runtimeSource: input.reviewRuntimeProbes.runtimeSource,
        requestCount: input.reviewRuntimeProbes.requestCount,
        highPriorityCount: input.reviewRuntimeProbes.highPriorityCount,
        triggers: input.reviewRuntimeProbes.triggers,
      },
    } : {}),
    steps: input.steps,
    producerReports: input.producerReports,
    warnings: input.warnings,
  };
};

export const loadBrainManifest = async (storagePath: string): Promise<BrainManifest | null> => {
  try {
    const filePath = getBrainManifestPath(storagePath);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || Number(parsed.schemaVersion) !== BRAIN_MANIFEST_SCHEMA_VERSION) return null;
    return parsed as BrainManifest;
  } catch {
    return null;
  }
};

export const saveBrainManifest = async (storagePath: string, manifest: BrainManifest): Promise<string> => {
  const filePath = getBrainManifestPath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
  return filePath;
};
