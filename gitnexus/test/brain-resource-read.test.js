import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test } from 'node:test';
import { readResource } from '../dist/mcp/resources.js';

test('MCP resources: reads brain manifest resource payload', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-brain-resource-'));
  const storagePath = path.join(tempRoot, '.gitnexus');
  const manifestPath = path.join(storagePath, 'manifests', 'brain.json');
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });

  const manifest = {
    schemaVersion: 1,
    repoFingerprint: 'abc',
    graphVersion: '10',
    plannerPolicyVersion: 'rule-baseline-v1',
    runtimeTruthFreshness: '',
    tick: {
      reason: 'analyze',
      finishedAt: '2026-03-01T00:00:00.000Z',
      durationMs: 10,
      stepCount: 3,
      producers: { total: 1, succeeded: 1, failed: 0, skipped: 0 },
    },
    planner: {
      mode: 'query',
      intentClass: 'maintenance',
      contextShape: 'standard',
      anchorCount: 2,
      operatorCount: 3,
      requestedProbeCount: 0,
      stopConditionCount: 2,
    },
    contextCompiler: {
      packetMode: 'query',
      packetTask: 'brain-tick:analyze',
      suggestedTestCount: 0,
      unresolvedProofCount: 1,
      telemetry: {
        totalRuns: 1,
        averageUsefulRatio: 0.5,
        averageProofSufficiency: 0.5,
        lastRunAt: '2026-03-01T00:00:00.000Z',
      },
    },
    experienceGovernor: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      cardCount: 9,
      generatedCount: 5,
      retainedCount: 4,
      droppedCount: 1,
      retrievedCount: 3,
      taxonomy: { query: 5, runtime: 2, 'anti-pattern': 2 },
      stages: { anchor: 2, expand: 2, probe: 3, patch: 1, verify: 1 },
    },
    constraintGraph: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      ruleCount: 7,
      violationCount: 3,
      byFamily: {
        structural: 1,
        shape: 1,
        auth: 1,
        runtime: 1,
        dependency: 1,
        performance: 1,
        security: 1,
      },
      patchGate: {
        checked: 7,
        blocked: 1,
        warned: 1,
        requestedRuntimeProbe: 1,
        requestedTargetedTests: 1,
      },
      solver: {
        patternChecks: 7,
        finiteChecks: 4,
        cardinalityChecks: 2,
        forwardChainInferences: 5,
        contradictions: 0,
      },
    },
    evalGraph: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      storePath: '/tmp/.gitnexus/manifests/eval-graph.json',
      taskMiner: {
        mined: 1,
        total: 4,
        byFamily: {
          'bug-fix': 1,
          'feature-addition': 2,
          refactor: 0,
          'security-fix': 0,
          'performance-fix': 0,
          'dependency-decision': 1,
          'contract-migration': 0,
          'auth-closure-repair': 0,
          'cache-closure-repair': 0,
        },
      },
      goldContextMiner: {
        mined: 1,
        total: 4,
        averageGoldFiles: 2.5,
        averageRequiredConstraints: 1,
      },
      canaryHarness: {
        runCount: 4,
        lastRunAt: '2026-03-01T00:00:00.000Z',
        lastScore: 81.2,
        passRate: 0.75,
        regressionsDetected: 0,
        promotionAllowed: true,
      },
      regressionTracking: {
        openRegressions: 0,
        newRegressions: 0,
        resolvedRegressions: 1,
      },
      dashboardMetrics: {
        retrieval: {
          goldContextRecall: 0.8,
          goldContextPrecision: 0.7,
          proofSufficiency: 0.9,
          filesOpenedPerSolvedTask: 4,
          tokensPerUsefulArtifact: 520,
        },
        nonFunctional: {
          securityIssueMissRate: 0,
          perfRegressionMissRate: 0.1,
          badDependencyDecisionRate: 0.05,
        },
        learning: {
          plannerUplift: 0.2,
          memoryCardUtility: 0.73,
          operatorPromotionHitRate: 0.75,
          staleMemoryDecayCorrectness: 0.15,
        },
      },
      baselines: {
        v1MedianTokensPerUsefulArtifact: 160,
        source: 'historical-window',
        sampleCount: 12,
        windowSize: 12,
      },
    },
    distillationEngine: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      storePath: '/tmp/.gitnexus/manifests/distillation-engine.json',
      runCount: 6,
      artifacts: {
        rankers: 4,
        plannerPolicies: 3,
        testSelectors: 6,
        precedentRankers: 6,
        riskScorers: 6,
      },
      plannerBandit: {
        exploreRate: 0.4,
        winningPolicy: 'policy:implement:deep:src/core',
        expectedReward: 0.74,
        policyArms: [
          {
            id: 'policy:implement:deep:src/core',
            sampleCount: 4,
            avgReward: 0.74,
            lastReward: 0.78,
            weight: 0.62,
            updatedAt: '2026-03-01T00:00:00.000Z',
          },
        ],
      },
      testSelector: {
        candidateCount: 5,
        selected: ['test/a.test.js', 'test/b.test.js'],
        estimatedRecall: 0.5,
      },
      precedentRanker: {
        candidateCount: 4,
        topPrecedents: [
          { id: 'slice:ticket', score: 0.83 },
        ],
        confidence: 0.83,
      },
      riskScorer: {
        score: 0.28,
        level: 'low',
        drivers: ['no_material_risk_drivers'],
      },
      promotion: {
        shadowReady: true,
        canaryEligible: true,
        promoted: true,
        rollbackReady: true,
      },
    },
    toolsmith: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      storePath: '/tmp/.gitnexus/manifests/toolsmith-operators.json',
      runCount: 4,
      miner: {
        sequenceCount: 2,
        topSequences: [
          { id: 'seq:abc', operators: ['expand_slice', 'compute_gap_delta'], uses: 3 },
        ],
      },
      synthesis: {
        candidatesGenerated: 3,
        artifactsTotal: 5,
        typedOperators: 5,
        implementationKinds: {
          cypher: 2,
          pipeline: 2,
          composite: 1,
        },
      },
      sandbox: {
        profile: 'patch-safe',
        approved: 3,
        pending: 1,
        rejected: 1,
      },
      promotion: {
        eligible: 3,
        promoted: 2,
        rolledBack: 1,
        guardrails: {
          deterministicTests: true,
          evalCanary: true,
          securityPolicy: true,
          capabilitySafe: true,
          proofCarrying: true,
        },
      },
    },
    graphModelBridge: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      storePath: '/tmp/.gitnexus/manifests/bridge-packets.json',
      runCount: 5,
      packetCount: 24,
      latestPacketCount: 6,
      coverage: {
        sliceBacked: 20,
        proofBacked: 21,
        avgProofHashes: 3.5,
      },
      promotion: {
        symbolicEnabled: true,
        learnedCandidateReady: true,
      },
      learned: {
        mode: 'shadow',
        modelPath: '/tmp/.gitnexus/manifests/bridge-learned-model.json',
        modelVersion: 'shadow-v1',
        trainedAt: '2026-03-01T00:00:00.000Z',
        trainingPacketCount: 24,
        shadowPredictionCount: 4,
        averageConfidence: 0.84,
      },
    },
    runtimeTruth: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      sourceFileCount: 1,
      probeCount: 1,
      snapshot: {
        requestSpans: 2,
        dbQueries: 1,
        payloadShapes: 1,
      },
      compressed: {
        witnessCards: 3,
        observedLoops: 1,
        contradictionWitnesses: 0,
        coverageWitnesses: 1,
      },
      reconciliation: {
        supportsStaticEdge: 2,
        fillsStaticGap: 1,
        contradictsStaticExpectation: 0,
        revealsHiddenDynamicBranch: 0,
        revealsDeadStaticOnlyPath: 0,
      },
    },
    reviewRuntimeProbes: {
      generatedAt: '2026-03-01T00:05:00.000Z',
      runtimeSource: 'none',
      requestCount: 2,
      highPriorityCount: 1,
      triggers: [
        'missing-runtime-observation-snapshot',
        'no-suggested-tests-for-changed-symbols',
      ],
    },
    v2Parity: {
      generatedAt: '2026-03-01T00:00:00.000Z',
      overall: {
        ready: false,
        met: 11,
        partial: 6,
        missing: 1,
        unverified: 1,
        total: 19,
        score: 0.71,
      },
      pillars: {
        query: { met: 2, partial: 1, missing: 0, unverified: 1, total: 4, score: 0.6875 },
        review: { met: 2, partial: 1, missing: 0, unverified: 0, total: 3, score: 0.8333 },
        implement: { met: 2, partial: 1, missing: 1, unverified: 0, total: 4, score: 0.625 },
        debug: { met: 2, partial: 1, missing: 0, unverified: 0, total: 3, score: 0.8333 },
        self_feedback: { met: 3, partial: 2, missing: 0, unverified: 0, total: 5, score: 0.8 },
      },
      checks: [
        {
          id: 'implement-auto-patch-guard-before-finalize',
          pillar: 'implement',
          label: 'Patch guard runs automatically before finalizing',
          status: 'partial',
          note: 'Patch gate activity exists but finalize-time enforcement remains to be proven.',
          evidence: ['patch_gate_checked=7'],
        },
      ],
      blockers: [
        'implement-auto-patch-guard-before-finalize: Patch gate activity exists but finalize-time enforcement remains to be proven.',
      ],
    },
    activeProducerVersions: { 'core-state': '1.0.0' },
    warnings: [],
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  const backend = {
    async refreshFromRegistryIfNeeded() {},
    async refreshRepoMetaForResource() {},
    resolveRepo() {
      return {
        name: 'brain-test',
        storagePath,
      };
    },
  };

  const text = await readResource('gitnexus://repo/brain-test/brain', backend);
  assert.match(text, /planner:/);
  assert.match(text, /context_compiler:/);
  assert.match(text, /experience_governor:/);
  assert.match(text, /card_count: 9/);
  assert.match(text, /constraint_graph:/);
  assert.match(text, /rule_count: 7/);
  assert.match(text, /blocked: 1/);
  assert.match(text, /eval_graph:/);
  assert.match(text, /last_score: 81.2/);
  assert.match(text, /pass_rate: 0.75/);
  assert.match(text, /v1_median_tokens_per_useful_artifact: 160/);
  assert.match(text, /source: "historical-window"/);
  assert.match(text, /distillation_engine:/);
  assert.match(text, /run_count: 6/);
  assert.match(text, /winning_policy: "policy:implement:deep:src\/core"/);
  assert.match(text, /expected_reward: 0.74/);
  assert.match(text, /toolsmith:/);
  assert.match(text, /run_count: 4/);
  assert.match(text, /candidates_generated: 3/);
  assert.match(text, /profile: "patch-safe"/);
  assert.match(text, /graph_model_bridge:/);
  assert.match(text, /packet_count: 24/);
  assert.match(text, /learned_candidate_ready: true/);
  assert.match(text, /mode: "shadow"/);
  assert.match(text, /shadow_prediction_count: 4/);
  assert.match(text, /average_confidence: 0.84/);
  assert.match(text, /runtime_truth:/);
  assert.match(text, /witness_cards: 3/);
  assert.match(text, /review_runtime_probes:/);
  assert.match(text, /request_count: 2/);
  assert.match(text, /high_priority_count: 1/);
  assert.match(text, /missing-runtime-observation-snapshot/);
  assert.match(text, /v2_parity:/);
  assert.match(text, /ready: false/);
  assert.match(text, /total: 19/);
  assert.match(text, /self_feedback:/);
  assert.match(text, /blocker_count: 1/);
  assert.match(text, /mode: "query"/);

  await fs.rm(tempRoot, { recursive: true, force: true });
});
