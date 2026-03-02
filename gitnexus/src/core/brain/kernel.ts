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

const plannerDependentSteps = [
  'runtime-truth-graph',
  'experience-governor',
  'constraint-graph',
  'context-compiler',
  'eval-graph',
  'distillation-engine',
  'toolsmith',
  'graph-model-bridge',
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

const appendPlannerUnavailableSteps = (steps: BrainStepResult[]): void => {
  for (const step of plannerDependentSteps) {
    steps.push({
      step,
      status: 'placeholder',
      detail: 'Planner output unavailable',
    });
  }
};

interface BrainStageSummary {
  status: BrainStepResult['status'];
  detail: string;
  warnings?: string[];
}

const runBrainStage = async <T>(
  step: string,
  steps: BrainStepResult[],
  warnings: string[],
  runner: () => Promise<T>,
  summarize: (value: T) => BrainStageSummary,
): Promise<T | undefined> => {
  try {
    const value = await runner();
    const summary = summarize(value);
    if (summary.warnings && summary.warnings.length > 0) warnings.push(...summary.warnings);
    steps.push({
      step,
      status: summary.status,
      detail: summary.detail,
    });
    return value;
  } catch (error) {
    const message = toErrorMessage(error);
    warnings.push(`${step}: ${message}`);
    steps.push({
      step,
      status: 'error',
      detail: message,
    });
    return undefined;
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
      const activePlan = planEnvelope;
      runtimeTruth = await runBrainStage(
        'runtime-truth-graph',
        steps,
        warnings,
        () => compileRuntimeTruthGraph(input, activePlan),
        value => ({
          status: value.compressed.witnessCards > 0 ? 'ok' : 'placeholder',
          detail: `probes=${value.probePlan.length} witnesses=${value.compressed.witnessCards}`,
          warnings: value.warnings,
        }),
      );

      experienceGovernor = await runBrainStage(
        'experience-governor',
        steps,
        warnings,
        () => runExperienceGovernor(input, activePlan, runtimeTruth),
        value => ({
          status: value.retrievedCards.length > 0 ? 'ok' : 'placeholder',
          detail: `cards=${value.totals.cards} retrieved=${value.retrievedCards.length}`,
          warnings: value.warnings,
        }),
      );

      constraintGraph = await runBrainStage(
        'constraint-graph',
        steps,
        warnings,
        () => compileConstraintGraph(input, activePlan, runtimeTruth),
        value => ({
          status: value.violations.length > 0 ? 'ok' : 'placeholder',
          detail: `violations=${value.violations.length} blocked=${value.patchGate.blocked} warned=${value.patchGate.warned}`,
          warnings: value.warnings,
        }),
      );

      const compiledContext = await runBrainStage(
        'context-compiler',
        steps,
        warnings,
        () => this.contextCompiler.compile(input, activePlan, runtimeTruth, experienceGovernor, constraintGraph),
        value => ({
          status: 'ok',
          detail: `${value.packet.mode}:${value.packet.anchors.length} anchors`,
        }),
      );
      if (compiledContext) {
        brainPacket = compiledContext.packet;
        contextTelemetry = compiledContext.telemetrySummary;
        contextTelemetryEntry = compiledContext.telemetryEntry;
      }

      evalGraph = await runBrainStage(
        'eval-graph',
        steps,
        warnings,
        () => runEvalGraph(
          input,
          activePlan,
          runtimeTruth,
          experienceGovernor,
          constraintGraph,
          brainPacket,
          contextTelemetryEntry,
          contextTelemetry,
        ),
        value => ({
          status: value.canaryHarness.runCount > 0 ? 'ok' : 'placeholder',
          detail: `score=${value.canaryHarness.lastScore} passRate=${value.canaryHarness.passRate} regressions=${value.regressionTracking.openRegressions}`,
          warnings: value.warnings,
        }),
      );

      distillationEngine = await runBrainStage(
        'distillation-engine',
        steps,
        warnings,
        () => runDistillationEngine(
          input,
          activePlan,
          runtimeTruth,
          experienceGovernor,
          constraintGraph,
          evalGraph,
          brainPacket,
          contextTelemetry,
        ),
        value => ({
          status: value.runCount > 0 ? 'ok' : 'placeholder',
          detail: `reward=${value.plannerBandit.expectedReward} promoted=${value.promotion.promoted}`,
          warnings: value.warnings,
        }),
      );

      toolsmith = await runBrainStage(
        'toolsmith',
        steps,
        warnings,
        () => runToolsmith(
          input,
          activePlan,
          evalGraph,
          constraintGraph,
          brainPacket,
        ),
        value => ({
          status: value.runCount > 0 ? 'ok' : 'placeholder',
          detail: `candidates=${value.synthesis.candidatesGenerated} promoted=${value.promotion.promoted}`,
          warnings: value.warnings,
        }),
      );

      graphModelBridge = await runBrainStage(
        'graph-model-bridge',
        steps,
        warnings,
        () => runGraphModelBridge(
          input,
          activePlan,
          brainPacket,
          constraintGraph,
        ),
        value => ({
          status: value.packetCount > 0 ? 'ok' : 'placeholder',
          detail: `packets=${value.packetCount} learnedReady=${value.promotion.learnedCandidateReady}`,
          warnings: value.warnings,
        }),
      );
    } else {
      appendPlannerUnavailableSteps(steps);
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
