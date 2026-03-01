import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildV2ParitySummary } from '../dist/core/brain/v2-parity.js';

const makePlanEnvelope = (overrides = {}) => ({
  mode: 'query',
  anchors: [],
  operators: [
    {
      name: 'compile_context_packet',
      reason: 'test',
      priority: 1,
    },
  ],
  proofObjectives: [],
  requestedProbes: [],
  contextShape: 'deep',
  stopConditions: [],
  state: {
    mode: 'query',
    repoFingerprint: 'test',
    intentClass: 'maintenance',
    anchorEntropy: 0.2,
    candidateSlices: 1,
    candidateContracts: 1,
    uncertaintyVector: {
      static: 0.1,
      runtime: 0.1,
      precedent: 0.1,
      memory: 0.1,
    },
    budget: {
      maxTokens: 1200,
      maxFiles: 8,
      maxOperators: 10,
    },
    priorOutcomeHints: {
      similarSuccessRate: 0.7,
      similarFailureRate: 0.2,
    },
  },
  ...overrides,
});

const makeBrainPacket = (overrides = {}) => ({
  mode: 'query',
  task: 'test',
  anchors: [],
  primarySlices: [],
  proofPack: {
    objectives: [{ id: 'proof:index-integrity', claim: 'x', required: true }],
    unresolved: [],
  },
  obligations: [],
  gaps: [],
  precedents: [],
  runtimeWitnesses: [],
  memoryCards: [],
  constraints: [],
  testPlan: {
    suggested: [],
    rationale: 'test',
  },
  riskProfile: {
    level: 'low',
    reasons: [],
  },
  editBudget: {
    maxFiles: 8,
    preferredOrder: [],
  },
  ...overrides,
});

test('V2 parity: query useful-context check falls back to historical baseline window', () => {
  const previousBaseline = process.env.GITNEXUS_V1_MEDIAN_USEFUL_CONTEXT_TOKENS;
  delete process.env.GITNEXUS_V1_MEDIAN_USEFUL_CONTEXT_TOKENS;

  try {
    const summary = buildV2ParitySummary({
      plannerPolicyVersion: 'policy:query:deep:src',
      planEnvelope: makePlanEnvelope(),
      brainPacket: makeBrainPacket(),
      contextTelemetry: {
        totalRuns: 10,
        averageUsefulRatio: 0.9,
        averageProofSufficiency: 1,
        lastRunAt: '2026-03-01T00:00:00.000Z',
      },
      evalGraph: {
        generatedAt: '2026-03-01T00:00:00.000Z',
        storePath: '/tmp/eval-graph.json',
        taskMiner: {
          mined: 1,
          total: 12,
          byFamily: {
            'bug-fix': 0,
            'feature-addition': 0,
            refactor: 0,
            'security-fix': 0,
            'performance-fix': 0,
            'dependency-decision': 0,
            'contract-migration': 12,
            'auth-closure-repair': 0,
            'cache-closure-repair': 0,
          },
        },
        goldContextMiner: {
          mined: 1,
          total: 12,
          averageGoldFiles: 6,
          averageRequiredConstraints: 0,
        },
        canaryHarness: {
          runCount: 12,
          lastRunAt: '2026-03-01T00:00:00.000Z',
          lastScore: 89,
          passRate: 1,
          regressionsDetected: 0,
          promotionAllowed: true,
        },
        regressionTracking: {
          openRegressions: 0,
          newRegressions: 0,
          resolvedRegressions: 0,
        },
        dashboardMetrics: {
          retrieval: {
            goldContextRecall: 0.9,
            goldContextPrecision: 0.9,
            proofSufficiency: 1,
            filesOpenedPerSolvedTask: 5,
            tokensPerUsefulArtifact: 60,
          },
          review: {
            gapPrecision: 1,
            gapSeverityCalibration: 1,
            missedClosureRate: 0,
            falseAlarmRate: 0,
          },
          implement: {
            companionEditRecall: 0.9,
            precedentUsefulness: 0.8,
            patchAcceptanceRate: 1,
            postReviewDeltaCount: 0,
          },
          debug: {
            brokenLoopTop1: 0.8,
            brokenLoopTop3: 0.9,
            usefulProbeRate: 0.8,
            timeToRootCause: 9,
            contradictionResolutionRate: 1,
          },
          nonFunctional: {
            securityIssueMissRate: 0,
            perfRegressionMissRate: 0,
            badDependencyDecisionRate: 0,
          },
          learning: {
            plannerUplift: 0.5,
            memoryCardUtility: 0.6,
            operatorPromotionHitRate: 1,
            staleMemoryDecayCorrectness: 0.3,
          },
        },
        baselines: {
          v1MedianTokensPerUsefulArtifact: 120,
          source: 'historical-window',
          sampleCount: 12,
          windowSize: 12,
        },
        warnings: [],
      },
    });

    const check = summary.checks.find(item => item.id === 'query-useful-context-vs-v1');
    assert.ok(check);
    assert.equal(check.status, 'met');
    assert.ok(check.evidence.includes('v1_baseline_source=historical-window'));
  } finally {
    if (previousBaseline === undefined) {
      delete process.env.GITNEXUS_V1_MEDIAN_USEFUL_CONTEXT_TOKENS;
    } else {
      process.env.GITNEXUS_V1_MEDIAN_USEFUL_CONTEXT_TOKENS = previousBaseline;
    }
  }
});

test('V2 parity: debug root-cause validation accepts targeted test evidence', () => {
  const summary = buildV2ParitySummary({
    plannerPolicyVersion: 'policy:debug:deep:src',
    planEnvelope: makePlanEnvelope({
      mode: 'debug',
      requestedProbes: [
        {
          reason: 'debug-symptom',
          anchors: ['a'],
          targetFamilies: ['http'],
          scope: {
            files: ['src/debug.ts'],
          },
          ttlMinutes: 30,
        },
      ],
    }),
    brainPacket: makeBrainPacket({
      mode: 'debug',
      testPlan: {
        suggested: ['node dist/cli/index.js runtime-ingest --print'],
        rationale: 'runtime proof needed',
      },
    }),
    constraintGraph: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      sourceFiles: ['src/debug.ts'],
      catalog: {
        totalRules: 7,
        byFamily: {
          structural: 1,
          shape: 1,
          auth: 1,
          runtime: 1,
          dependency: 1,
          performance: 1,
          security: 1,
        },
      },
      solver: {
        patternChecks: 7,
        finiteChecks: 0,
        cardinalityChecks: 1,
        forwardChainInferences: 1,
        contradictions: 0,
      },
      patchGate: {
        checked: 7,
        blocked: 0,
        warned: 0,
        requestedRuntimeProbe: 1,
        requestedTargetedTests: 1,
      },
      rules: [],
      violations: [],
      requestedProbes: [],
      requestedTests: ['node dist/cli/index.js runtime-ingest --print'],
      warnings: [],
    },
    evalGraph: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      storePath: '/tmp/eval-graph.json',
      taskMiner: {
        mined: 1,
        total: 1,
        byFamily: {
          'bug-fix': 1,
          'feature-addition': 0,
          refactor: 0,
          'security-fix': 0,
          'performance-fix': 0,
          'dependency-decision': 0,
          'contract-migration': 0,
          'auth-closure-repair': 0,
          'cache-closure-repair': 0,
        },
      },
      goldContextMiner: {
        mined: 1,
        total: 1,
        averageGoldFiles: 4,
        averageRequiredConstraints: 0,
      },
      canaryHarness: {
        runCount: 1,
        lastRunAt: '2026-03-01T00:00:00.000Z',
        lastScore: 85,
        passRate: 1,
        regressionsDetected: 0,
        promotionAllowed: true,
      },
      regressionTracking: {
        openRegressions: 0,
        newRegressions: 0,
        resolvedRegressions: 0,
      },
      dashboardMetrics: {
        retrieval: {
          goldContextRecall: 0.9,
          goldContextPrecision: 0.9,
          proofSufficiency: 1,
          filesOpenedPerSolvedTask: 4,
          tokensPerUsefulArtifact: 70,
        },
        review: {
          gapPrecision: 1,
          gapSeverityCalibration: 1,
          missedClosureRate: 0,
          falseAlarmRate: 0,
        },
        implement: {
          companionEditRecall: 0.9,
          precedentUsefulness: 0.8,
          patchAcceptanceRate: 1,
          postReviewDeltaCount: 0,
        },
        debug: {
          brokenLoopTop1: 0.8,
          brokenLoopTop3: 0.9,
          usefulProbeRate: 0.8,
          timeToRootCause: 9,
          contradictionResolutionRate: 1,
        },
        nonFunctional: {
          securityIssueMissRate: 0,
          perfRegressionMissRate: 0,
          badDependencyDecisionRate: 0,
        },
        learning: {
          plannerUplift: 0.4,
          memoryCardUtility: 0.5,
          operatorPromotionHitRate: 1,
          staleMemoryDecayCorrectness: 0.2,
        },
      },
      baselines: {
        v1MedianTokensPerUsefulArtifact: 120,
        source: 'historical-window',
        sampleCount: 12,
        windowSize: 12,
      },
      warnings: [],
    },
    runtimeTruth: {
      generatedAt: '',
      sourceFiles: [],
      probePlan: [
        {
          reason: 'debug-symptom',
          anchors: ['a'],
          targetFamilies: ['http'],
          scope: {
            files: ['src/debug.ts'],
          },
          ttlMinutes: 30,
        },
      ],
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
      warnings: [],
    },
  });

  const check = summary.checks.find(item => item.id === 'debug-root-cause-with-validating-witness');
  assert.ok(check);
  assert.equal(check.status, 'met');
  assert.ok(check.evidence.includes('validation_tests=1'));
});
