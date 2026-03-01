import {
  loadRuntimeObservationSnapshot,
} from '../ingestion/runtime-observation-store.js';
import { loadReviewRuntimeProbeSnapshot } from '../ingestion/review-runtime-probe-store.js';
import { buildBrainManifest, getBrainManifestPath, loadBrainManifest, saveBrainManifest } from './manifest-store.js';
import { compileConstraintGraph } from './constraint-graph.js';
import { ContextCompiler } from './context-compiler.js';
import { runDistillationEngine } from './distillation-engine.js';
import { runEvalGraph } from './eval-graph.js';
import { runExperienceGovernor } from './experience-governor.js';
import { runGraphModelBridge } from './graph-model-bridge.js';
import { PlannerEngine } from './planner.js';
import { ProducerManager } from './producer-manager.js';
import { compileRuntimeTruthGraph } from './runtime-truth-graph.js';
import { runToolsmith } from './toolsmith.js';
import {
  BRAIN_ARTIFACT_SCHEMA_VERSION,
  BrainArtifact,
  BrainProducer,
  BrainStepResult,
  BrainTickInput,
  BrainTickResult,
  BrainPacket,
  ConstraintGraphSummary,
  ContextUsageTelemetryEntry,
  ContextUsageTelemetrySummary,
  DistillationEngineSummary,
  EvalGraphSummary,
  ExperienceGovernorSummary,
  GraphModelBridgeSummary,
  PlanEnvelope,
  ProducerContext,
  ProducerRunReport,
  RuntimeTruthSummary,
  ReviewRuntimeProbeSummary,
  ToolsmithSummary,
} from './types.js';

const DEFAULT_PLANNER_POLICY_VERSION = 'rule-baseline-v1';
const POST_IMPLEMENT_REVIEW_MANDATORY = true;
const POST_IMPLEMENT_PATCH_GUARD_MANDATORY = true;

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown error');
};

const nowIso = (): string => new Date().toISOString();

const makeCoreStateProducer = (): BrainProducer => {
  return {
    id: 'core-state',
    version: '1.0.0',
    kind: 'summary',
    async detect() {
      return true;
    },
    async produce(ctx) {
      const artifact: BrainArtifact = {
        id: `core-state:${ctx.repoFingerprint}:${Date.now()}`,
        producerId: 'core-state',
        kind: 'brain-tick-heartbeat',
        schemaVersion: BRAIN_ARTIFACT_SCHEMA_VERSION,
        createdAt: nowIso(),
        trustTier: 'deterministic',
        taint: 'trusted',
        payload: {
          reason: ctx.reason,
          repoFingerprint: ctx.repoFingerprint,
          graphVersion: ctx.graphVersion,
          changedPaths: ctx.changedPaths.length,
        },
      };
      return [artifact];
    },
    async validate(artifacts) {
      return artifacts.map(artifact => ({
        ...artifact,
        validation: {
          valid: Boolean(artifact.id && artifact.kind),
          issues: artifact.id && artifact.kind ? [] : ['missing id/kind'],
        },
      }));
    },
    async integrate() {
      return;
    },
    async score() {
      return {
        health: 1,
        utility: 1,
        latencyMs: 0,
        artifactCount: 1,
        warnings: [],
      };
    },
    async forget() {
      return;
    },
  };
};

const placeholderSteps = [
  'reconcile-graphs',
  'derive-expectations-and-gaps',
  'update-runtime-projections',
  'refresh-constraints',
  'maybe-run-canary-evals',
  'maybe-retrain-rankers',
  'maybe-promote-operators',
  'compact-and-forget',
];

const appendPlaceholderSteps = (steps: BrainStepResult[]): void => {
  for (const step of placeholderSteps) {
    steps.push({
      step,
      status: 'placeholder',
      detail: 'Phase A scaffold',
    });
  }
};

const getRuntimeTruthFreshness = async (storagePath: string, repoPath: string): Promise<string> => {
  try {
    const snapshot = await loadRuntimeObservationSnapshot(storagePath, { repoPath });
    if (snapshot.generatedAt) return snapshot.generatedAt;
  } catch {
  }
  return '';
};

const getReviewRuntimeProbeSummary = async (
  storagePath: string,
  repoPath: string,
): Promise<ReviewRuntimeProbeSummary | undefined> => {
  try {
    const snapshot = await loadReviewRuntimeProbeSnapshot(storagePath);
    const snapshotRepoPath = String(snapshot.repoPath || '').trim();
    if (snapshotRepoPath && snapshotRepoPath !== repoPath) return undefined;
    if (!snapshot.generatedAt) return undefined;
    return {
      generatedAt: snapshot.generatedAt,
      runtimeSource: snapshot.runtimeSource,
      requestCount: Number(snapshot.requestCount || 0),
      highPriorityCount: Number(snapshot.highPriorityCount || 0),
      triggers: Array.isArray(snapshot.triggers) ? snapshot.triggers : [],
    };
  } catch {
    return undefined;
  }
};

export class BrainKernel {
  private producerManager: ProducerManager;
  private plannerEngine: PlannerEngine;
  private contextCompiler: ContextCompiler;

  constructor(producers: BrainProducer[] = [makeCoreStateProducer()]) {
    this.producerManager = new ProducerManager(producers);
    this.plannerEngine = new PlannerEngine();
    this.contextCompiler = new ContextCompiler();
  }

  registerProducer(producer: BrainProducer): void {
    this.producerManager.register(producer);
  }

  listProducers(): BrainProducer[] {
    return this.producerManager.list();
  }

  private async resolvePlannerPolicyVersion(input: BrainTickInput): Promise<string> {
    const explicit = String(input.plannerPolicyVersion || '').trim();
    const fallback = explicit || DEFAULT_PLANNER_POLICY_VERSION;
    try {
      const previous = await loadBrainManifest(input.storagePath);
      const promoted = Boolean(previous?.distillationEngine?.promotion?.promoted);
      const winningPolicy = String(previous?.distillationEngine?.plannerBandit?.winningPolicy || '').trim();
      if (promoted && winningPolicy) return winningPolicy;
    } catch {
    }
    return fallback;
  }

  async tick(input: BrainTickInput): Promise<BrainTickResult> {
    const startedAt = Date.now();
    const startedAtIso = nowIso();
    const warnings: string[] = [];
    const steps: BrainStepResult[] = [];
    const activePlannerPolicyVersion = await this.resolvePlannerPolicyVersion(input);
    const normalizedChangedPaths = Array.isArray(input.changedPaths)
      ? Array.from(new Set(input.changedPaths.map(item => String(item || '').trim()).filter(Boolean)))
      : [];

    steps.push({
      step: 'detect-repo-changes',
      status: normalizedChangedPaths.length > 0 ? 'ok' : 'placeholder',
      detail: normalizedChangedPaths.length > 0 ? `${normalizedChangedPaths.length} change(s)` : 'No indexed file deltas provided',
    });

    const producerContext: ProducerContext = {
      reason: input.reason,
      repoPath: input.repoPath,
      storagePath: input.storagePath,
      repoFingerprint: input.repoFingerprint,
      graphVersion: input.graphVersion,
      plannerPolicyVersion: activePlannerPolicyVersion,
      changedPaths: normalizedChangedPaths,
      startedAt: startedAtIso,
    };

    let producerReports: ProducerRunReport[] = [];
    let planEnvelope: PlanEnvelope | undefined;
    let brainPacket: BrainPacket | undefined;
    let contextTelemetry: ContextUsageTelemetrySummary | undefined;
    let contextTelemetryEntry: ContextUsageTelemetryEntry | undefined;
    let runtimeTruth: RuntimeTruthSummary | undefined;
    let reviewRuntimeProbes: ReviewRuntimeProbeSummary | undefined;
    let experienceGovernor: ExperienceGovernorSummary | undefined;
    let constraintGraph: ConstraintGraphSummary | undefined;
    let evalGraph: EvalGraphSummary | undefined;
    let distillationEngine: DistillationEngineSummary | undefined;
    let toolsmith: ToolsmithSummary | undefined;
    let graphModelBridge: GraphModelBridgeSummary | undefined;
    try {
      producerReports = await this.producerManager.run(producerContext);
      steps.push({
        step: 'producer-manager',
        status: 'ok',
        detail: `${producerReports.length} producer(s)`,
      });
      for (const report of producerReports) {
        for (const warning of report.warnings || []) {
          warnings.push(`${report.producerId}: ${warning}`);
        }
      }
    } catch (error) {
      const message = toErrorMessage(error);
      warnings.push(`producer-manager: ${message}`);
      steps.push({
        step: 'producer-manager',
        status: 'error',
        detail: message,
      });
    }

    try {
      planEnvelope = this.plannerEngine.plan({
        ...input,
        plannerPolicyVersion: activePlannerPolicyVersion,
      });
      steps.push({
        step: 'planner-engine',
        status: 'ok',
        detail: `${planEnvelope.mode}:${planEnvelope.contextShape}:${activePlannerPolicyVersion}`,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      warnings.push(`planner-engine: ${message}`);
      steps.push({
        step: 'planner-engine',
        status: 'error',
        detail: message,
      });
    }

    if (planEnvelope) {
      try {
        runtimeTruth = await compileRuntimeTruthGraph(input, planEnvelope);
        warnings.push(...runtimeTruth.warnings);
        steps.push({
          step: 'runtime-truth-graph',
          status: runtimeTruth.compressed.witnessCards > 0 ? 'ok' : 'placeholder',
          detail: `probes=${runtimeTruth.probePlan.length} witnesses=${runtimeTruth.compressed.witnessCards}`,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        warnings.push(`runtime-truth-graph: ${message}`);
        steps.push({
          step: 'runtime-truth-graph',
          status: 'error',
          detail: message,
        });
      }

      try {
        experienceGovernor = await runExperienceGovernor(input, planEnvelope, runtimeTruth);
        warnings.push(...experienceGovernor.warnings);
        steps.push({
          step: 'experience-governor',
          status: experienceGovernor.retrievedCards.length > 0 ? 'ok' : 'placeholder',
          detail: `cards=${experienceGovernor.totals.cards} retrieved=${experienceGovernor.retrievedCards.length}`,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        warnings.push(`experience-governor: ${message}`);
        steps.push({
          step: 'experience-governor',
          status: 'error',
          detail: message,
        });
      }

      try {
        constraintGraph = await compileConstraintGraph(input, planEnvelope, runtimeTruth);
        warnings.push(...constraintGraph.warnings);
        steps.push({
          step: 'constraint-graph',
          status: constraintGraph.violations.length > 0 ? 'ok' : 'placeholder',
          detail: `violations=${constraintGraph.violations.length} blocked=${constraintGraph.patchGate.blocked} warned=${constraintGraph.patchGate.warned}`,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        warnings.push(`constraint-graph: ${message}`);
        steps.push({
          step: 'constraint-graph',
          status: 'error',
          detail: message,
        });
      }

      try {
        const compiled = await this.contextCompiler.compile(input, planEnvelope, runtimeTruth, experienceGovernor, constraintGraph);
        brainPacket = compiled.packet;
        contextTelemetry = compiled.telemetrySummary;
        contextTelemetryEntry = compiled.telemetryEntry;
        steps.push({
          step: 'context-compiler',
          status: 'ok',
          detail: `${compiled.packet.mode}:${compiled.packet.anchors.length} anchors`,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        warnings.push(`context-compiler: ${message}`);
        steps.push({
          step: 'context-compiler',
          status: 'error',
          detail: message,
        });
      }

      try {
        evalGraph = await runEvalGraph(
          input,
          planEnvelope,
          runtimeTruth,
          experienceGovernor,
          constraintGraph,
          brainPacket,
          contextTelemetryEntry,
          contextTelemetry,
        );
        warnings.push(...evalGraph.warnings);
        steps.push({
          step: 'eval-graph',
          status: evalGraph.canaryHarness.runCount > 0 ? 'ok' : 'placeholder',
          detail: `score=${evalGraph.canaryHarness.lastScore} passRate=${evalGraph.canaryHarness.passRate} regressions=${evalGraph.regressionTracking.openRegressions}`,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        warnings.push(`eval-graph: ${message}`);
        steps.push({
          step: 'eval-graph',
          status: 'error',
          detail: message,
        });
      }

      try {
        distillationEngine = await runDistillationEngine(
          input,
          planEnvelope,
          runtimeTruth,
          experienceGovernor,
          constraintGraph,
          evalGraph,
          brainPacket,
          contextTelemetry,
        );
        warnings.push(...distillationEngine.warnings);
        steps.push({
          step: 'distillation-engine',
          status: distillationEngine.runCount > 0 ? 'ok' : 'placeholder',
          detail: `reward=${distillationEngine.plannerBandit.expectedReward} promoted=${distillationEngine.promotion.promoted}`,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        warnings.push(`distillation-engine: ${message}`);
        steps.push({
          step: 'distillation-engine',
          status: 'error',
          detail: message,
        });
      }

      try {
        toolsmith = await runToolsmith(
          input,
          planEnvelope,
          evalGraph,
          constraintGraph,
          brainPacket,
        );
        warnings.push(...toolsmith.warnings);
        steps.push({
          step: 'toolsmith',
          status: toolsmith.runCount > 0 ? 'ok' : 'placeholder',
          detail: `candidates=${toolsmith.synthesis.candidatesGenerated} promoted=${toolsmith.promotion.promoted}`,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        warnings.push(`toolsmith: ${message}`);
        steps.push({
          step: 'toolsmith',
          status: 'error',
          detail: message,
        });
      }

      try {
        graphModelBridge = await runGraphModelBridge(
          input,
          planEnvelope,
          brainPacket,
          constraintGraph,
        );
        warnings.push(...graphModelBridge.warnings);
        steps.push({
          step: 'graph-model-bridge',
          status: graphModelBridge.packetCount > 0 ? 'ok' : 'placeholder',
          detail: `packets=${graphModelBridge.packetCount} learnedReady=${graphModelBridge.promotion.learnedCandidateReady}`,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        warnings.push(`graph-model-bridge: ${message}`);
        steps.push({
          step: 'graph-model-bridge',
          status: 'error',
          detail: message,
        });
      }
    } else {
      steps.push({
        step: 'runtime-truth-graph',
        status: 'placeholder',
        detail: 'Planner output unavailable',
      });
      steps.push({
        step: 'experience-governor',
        status: 'placeholder',
        detail: 'Planner output unavailable',
      });
      steps.push({
        step: 'constraint-graph',
        status: 'placeholder',
        detail: 'Planner output unavailable',
      });
      steps.push({
        step: 'context-compiler',
        status: 'placeholder',
        detail: 'Planner output unavailable',
      });
      steps.push({
        step: 'eval-graph',
        status: 'placeholder',
        detail: 'Planner output unavailable',
      });
      steps.push({
        step: 'distillation-engine',
        status: 'placeholder',
        detail: 'Planner output unavailable',
      });
      steps.push({
        step: 'toolsmith',
        status: 'placeholder',
        detail: 'Planner output unavailable',
      });
      steps.push({
        step: 'graph-model-bridge',
        status: 'placeholder',
        detail: 'Planner output unavailable',
      });
    }

    appendPlaceholderSteps(steps);

    const runtimeTruthFreshness = await getRuntimeTruthFreshness(input.storagePath, input.repoPath);
    reviewRuntimeProbes = await getReviewRuntimeProbeSummary(input.storagePath, input.repoPath);
    const manifestPath = getBrainManifestPath(input.storagePath);
    steps.push({
      step: 'publish-brain-manifest',
      status: 'ok',
      detail: manifestPath,
    });

    const manifest = buildBrainManifest({
      reason: input.reason,
      repoFingerprint: input.repoFingerprint,
      graphVersion: input.graphVersion,
      plannerPolicyVersion: activePlannerPolicyVersion,
      runtimeTruthFreshness,
      finishedAt: nowIso(),
      durationMs: Date.now() - startedAt,
      ...(planEnvelope ? { planEnvelope } : {}),
      ...(brainPacket ? { brainPacket } : {}),
      ...(contextTelemetry ? { contextTelemetry } : {}),
      ...(contextTelemetryEntry ? { contextTelemetryEntry } : {}),
      ...(runtimeTruth ? { runtimeTruth } : {}),
      ...(reviewRuntimeProbes ? { reviewRuntimeProbes } : {}),
      ...(experienceGovernor ? { experienceGovernor } : {}),
      ...(constraintGraph ? { constraintGraph } : {}),
      ...(evalGraph ? { evalGraph } : {}),
      ...(distillationEngine ? { distillationEngine } : {}),
      ...(toolsmith ? { toolsmith } : {}),
      ...(graphModelBridge ? { graphModelBridge } : {}),
      postImplementReviewMandatory: POST_IMPLEMENT_REVIEW_MANDATORY,
      postImplementPatchGuardMandatory: POST_IMPLEMENT_PATCH_GUARD_MANDATORY,
      steps,
      producerReports,
      warnings,
    });

    try {
      await saveBrainManifest(input.storagePath, manifest);
    } catch (error) {
      const message = toErrorMessage(error);
      warnings.push(`publish-brain-manifest: ${message}`);
      steps[steps.length - 1] = {
        step: 'publish-brain-manifest',
        status: 'error',
        detail: message,
      };
      throw error;
    }

    return {
      manifestPath,
      manifest,
      ...(planEnvelope ? { planEnvelope } : {}),
      ...(brainPacket ? { brainPacket } : {}),
      ...(contextTelemetry ? { contextTelemetry } : {}),
      ...(runtimeTruth ? { runtimeTruth } : {}),
      ...(reviewRuntimeProbes ? { reviewRuntimeProbes } : {}),
      ...(experienceGovernor ? { experienceGovernor } : {}),
      ...(constraintGraph ? { constraintGraph } : {}),
      ...(evalGraph ? { evalGraph } : {}),
      ...(distillationEngine ? { distillationEngine } : {}),
      ...(toolsmith ? { toolsmith } : {}),
      ...(graphModelBridge ? { graphModelBridge } : {}),
      producerReports,
      steps,
      warnings,
    };
  }
}
