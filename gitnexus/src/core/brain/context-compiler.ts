import fs from 'fs/promises';
import path from 'path';
import {
  BrainPacket,
  BrainTickInput,
  ConstraintGraphSummary,
  ContextUsageTelemetryEntry,
  ContextUsageTelemetrySummary,
  ExperienceGovernorSummary,
  PlanEnvelope,
  ProofObjective,
  RuntimeTruthSummary,
} from './types.js';

const CONTEXT_TELEMETRY_SCHEMA_VERSION = 1;
const CONTEXT_TELEMETRY_FILE = 'context-telemetry.json';
const MAX_TELEMETRY_ENTRIES = 200;
const TELEMETRY_SUMMARY_WINDOW = 10;

interface ContextTelemetryStore {
  schemaVersion: number;
  entries: ContextUsageTelemetryEntry[];
}

const getTelemetryPath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', CONTEXT_TELEMETRY_FILE);
};

const createEmptyTelemetryStore = (): ContextTelemetryStore => {
  return {
    schemaVersion: CONTEXT_TELEMETRY_SCHEMA_VERSION,
    entries: [],
  };
};

const loadTelemetryStore = async (storagePath: string): Promise<ContextTelemetryStore> => {
  try {
    const raw = await fs.readFile(getTelemetryPath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || Number(parsed.schemaVersion) !== CONTEXT_TELEMETRY_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return createEmptyTelemetryStore();
    }
    return {
      schemaVersion: CONTEXT_TELEMETRY_SCHEMA_VERSION,
      entries: parsed.entries,
    };
  } catch {
    return createEmptyTelemetryStore();
  }
};

const saveTelemetryStore = async (storagePath: string, store: ContextTelemetryStore): Promise<void> => {
  const filePath = getTelemetryPath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
};

const summarizeTelemetry = (entries: ContextUsageTelemetryEntry[]): ContextUsageTelemetrySummary => {
  if (entries.length === 0) {
    return {
      totalRuns: 0,
      averageUsefulRatio: 0,
      averageProofSufficiency: 0,
      lastRunAt: '',
    };
  }

  const sample = entries.slice(-TELEMETRY_SUMMARY_WINDOW);
  const usefulRatioTotal = sample.reduce((acc, entry) => {
    if (entry.retrievedArtifacts <= 0) return acc;
    return acc + (entry.usefulArtifacts / entry.retrievedArtifacts);
  }, 0);
  const proofTotal = sample.reduce((acc, entry) => acc + entry.proofSufficiency, 0);
  return {
    totalRuns: entries.length,
    averageUsefulRatio: usefulRatioTotal / Math.max(1, sample.length),
    averageProofSufficiency: proofTotal / Math.max(1, sample.length),
    lastRunAt: entries[entries.length - 1]?.createdAt || '',
  };
};

const estimateTokens = (plan: PlanEnvelope): number => {
  const anchorCost = plan.anchors.length * 55;
  const operatorCost = plan.operators.length * 38;
  const objectiveCost = plan.proofObjectives.length * 44;
  return anchorCost + operatorCost + objectiveCost;
};

const toBoundedConfidence = (value: number, minValue = 0.05, maxValue = 0.95): number => {
  return Math.max(minValue, Math.min(maxValue, Number(value || 0)));
};

const isProofObjectiveResolved = (
  objective: ProofObjective,
  input: BrainTickInput,
  plan: PlanEnvelope,
  runtimeTruth?: RuntimeTruthSummary,
  experienceGovernor?: ExperienceGovernorSummary,
  constraintGraph?: ConstraintGraphSummary,
): boolean => {
  const changedPaths = Array.isArray(input.changedPaths)
    ? input.changedPaths.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const id = String(objective.id || '').trim().toLowerCase();
  if (!id) return true;

  if (id === 'proof:index-integrity') {
    if (changedPaths.length === 0) return true;
    const anchoredFileCount = plan.anchors
      .map(anchor => String(anchor.filePath || anchor.label || '').trim())
      .filter(Boolean)
      .length;
    return anchoredFileCount > 0;
  }

  if (id === 'proof:post-analyze-contract') {
    return Boolean(runtimeTruth || experienceGovernor || constraintGraph);
  }

  if (id.includes('runtime') || id.includes('probe') || id.includes('witness')) {
    const witnessCount = Number(runtimeTruth?.witnesses.length || 0);
    if (plan.requestedProbes.length > 0) return witnessCount > 0;
  }

  return true;
};

const buildPacket = (
  input: BrainTickInput,
  plan: PlanEnvelope,
  runtimeTruth?: RuntimeTruthSummary,
  experienceGovernor?: ExperienceGovernorSummary,
  constraintGraph?: ConstraintGraphSummary,
): BrainPacket => {
  const task = String(input.task || '').trim() || `brain-tick:${input.reason}`;
  const runtimeWitnesses = (runtimeTruth?.witnesses || []).slice(0, 12);
  const memoryCards = (experienceGovernor?.retrievedCards || []).slice(0, 5);
  const constraintFindings = (constraintGraph?.violations || []).slice(0, 10).map(item => ({
    id: item.id,
    summary: item.summary,
    severity: item.severity,
  }));
  const runtimeProofId = 'proof:runtime-witness';
  const runtimeSnapshotSignals = Number(runtimeTruth?.snapshot.requestSpans || 0)
    + Number(runtimeTruth?.snapshot.dbQueries || 0)
    + Number(runtimeTruth?.snapshot.payloadShapes || 0);
  const shouldRequireRuntimeWitnessProof = plan.requestedProbes.length > 0
    && (
      plan.mode === 'debug'
      || plan.mode === 'review'
      || runtimeSnapshotSignals > 0
    );
  const unresolvedRequiredProofIds = plan.proofObjectives
    .filter(item => item.required)
    .filter(item => !isProofObjectiveResolved(item, input, plan, runtimeTruth, experienceGovernor, constraintGraph))
    .map(item => item.id);
  if (shouldRequireRuntimeWitnessProof && runtimeWitnesses.length === 0) {
    if (!unresolvedRequiredProofIds.includes(runtimeProofId)) {
      unresolvedRequiredProofIds.push(runtimeProofId);
    }
  }

  const suggestedTests = plan.mode === 'review' || plan.mode === 'implement'
    ? ['node --test test/no-registry-refresh.test.js']
    : [];
  suggestedTests.push(...(constraintGraph?.requestedTests || []));
  if (plan.requestedProbes.length > 0 && runtimeWitnesses.length === 0) {
    suggestedTests.push('node dist/cli/index.js runtime-ingest --print');
  }
  if (memoryCards.length === 0) {
    suggestedTests.push('node --test test/brain-experience-governor.test.js');
  }

  const dedupedSuggestedTests = Array.from(new Set(suggestedTests));
  const contradictionGaps = (runtimeTruth?.contradictions || []).slice(0, 6).map(item => ({
    id: item.id,
    summary: item.reason,
    severity: item.severity === 'high' ? 'high' as const : 'medium' as const,
  }));

  const riskReasons: string[] = [];
  if (runtimeWitnesses.length === 0 && plan.requestedProbes.length > 0) {
    riskReasons.push('Runtime probes planned but no witness cards were available');
  }
  if ((runtimeTruth?.contradictions || []).length > 0) {
    riskReasons.push(`${runtimeTruth?.contradictions.length || 0} runtime contradiction witness(es) found`);
  }
  if ((constraintGraph?.patchGate.blocked || 0) > 0) {
    riskReasons.push(`${constraintGraph?.patchGate.blocked || 0} blocking constraint violation(s)`);
  }
  if ((constraintGraph?.patchGate.warned || 0) > 0) {
    riskReasons.push(`${constraintGraph?.patchGate.warned || 0} warning-level constraint violation(s)`);
  }
  if ((constraintGraph?.patchGate.requestedTargetedTests || 0) > 0) {
    riskReasons.push('Constraint patch gate requested targeted tests');
  }
  if ((constraintGraph?.patchGate.requestedRuntimeProbe || 0) > 0) {
    riskReasons.push('Constraint patch gate requested runtime probes');
  }
  if (riskReasons.length === 0) {
    riskReasons.push('Rule-baseline planner selected low-risk context');
  }
  const riskLevel = (constraintGraph?.patchGate.blocked || 0) > 0
    ? 'high'
    : (runtimeTruth?.contradictions || []).length > 0
    ? 'high'
    : ((constraintGraph?.patchGate.warned || 0) > 0 || (constraintGraph?.patchGate.requestedTargetedTests || 0) > 0)
      ? 'medium'
      : runtimeWitnesses.length === 0 && plan.requestedProbes.length > 0
      ? 'medium'
      : plan.mode === 'debug'
        ? 'medium'
        : 'low';
  const precedents = (() => {
    const byId = new Map<string, { id: string; summary: string; confidence: number }>();

    for (const anchor of plan.anchors) {
      const anchorId = String(anchor.id || '').trim();
      if (!anchorId) continue;

      const base = Number(anchor.confidence || 0.6);
      const kindBoost = anchor.kind === 'slice'
        ? 0.14
        : anchor.kind === 'symbol'
          ? 0.1
          : anchor.kind === 'file'
            ? 0.08
            : 0.05;
      const confidence = toBoundedConfidence(base + kindBoost, 0.55, 0.95);
      const summary = anchor.filePath
        ? `${anchor.kind} precedent from ${anchor.filePath}`
        : `${anchor.kind} precedent from ${anchor.label}`;

      byId.set(anchorId, {
        id: anchorId,
        summary,
        confidence: Number(confidence.toFixed(4)),
      });
    }

    for (const card of memoryCards) {
      const id = `memory:${card.id}`;
      const confidence = toBoundedConfidence(Number(card.utility || 0) * 0.9, 0.5, 0.9);
      const existing = byId.get(id);
      if (!existing || confidence > existing.confidence) {
        byId.set(id, {
          id,
          summary: `Memory precedent card ${card.id}`,
          confidence: Number(confidence.toFixed(4)),
        });
      }
    }

    return Array.from(byId.values())
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, 8);
  })();

  return {
    mode: plan.mode,
    task,
    anchors: plan.anchors,
    primarySlices: [],
    proofPack: {
      objectives: plan.proofObjectives,
      unresolved: unresolvedRequiredProofIds,
    },
    obligations: [
      ...plan.stopConditions.map(item => item.rule),
      ...(plan.requestedProbes.length > 0 ? ['Collect runtime witnesses for planned probes'] : []),
    ],
    gaps: contradictionGaps,
    precedents,
    runtimeWitnesses,
    memoryCards,
    constraints: constraintFindings,
    testPlan: {
      suggested: dedupedSuggestedTests,
      rationale: dedupedSuggestedTests.length > 0 ? 'Mode requires regression verification for changed paths' : 'No mandatory test run inferred',
    },
    riskProfile: {
      level: riskLevel,
      reasons: riskReasons,
    },
    editBudget: {
      maxFiles: plan.state.budget.maxFiles,
      preferredOrder: plan.anchors.map(anchor => anchor.filePath || anchor.label).filter(Boolean),
    },
  };
};

export class ContextCompiler {
  async compile(
    input: BrainTickInput,
    plan: PlanEnvelope,
    runtimeTruth?: RuntimeTruthSummary,
    experienceGovernor?: ExperienceGovernorSummary,
    constraintGraph?: ConstraintGraphSummary,
  ): Promise<{
      packet: BrainPacket;
      telemetryEntry: ContextUsageTelemetryEntry;
      telemetrySummary: ContextUsageTelemetrySummary;
    }> {
    const packet = buildPacket(input, plan, runtimeTruth, experienceGovernor, constraintGraph);
    const estimatedTokens = estimateTokens(plan);
    const runtimeArtifactCount = (runtimeTruth?.witnesses.length || 0) + (runtimeTruth?.observedLoops.length || 0);
    const memoryArtifactCount = (experienceGovernor?.retrievedCards.length || 0);
    const constraintArtifactCount = (constraintGraph?.violations.length || 0);
    const requiredProofCount = Math.max(1, plan.proofObjectives.filter(item => item.required).length);
    const unresolvedRequired = packet.proofPack.unresolved.length;
    const resolvedRequired = Math.max(0, requiredProofCount - unresolvedRequired);
    const retrievedArtifacts = plan.anchors.length + requiredProofCount + runtimeArtifactCount + memoryArtifactCount + constraintArtifactCount;
    const usefulArtifacts = plan.anchors.length + resolvedRequired + runtimeArtifactCount + memoryArtifactCount + constraintArtifactCount;
    const proofSufficiency = Math.max(0, 1 - unresolvedRequired / requiredProofCount);

    const telemetryEntry: ContextUsageTelemetryEntry = {
      createdAt: new Date().toISOString(),
      mode: plan.mode,
      contextShape: plan.contextShape,
      anchorCount: plan.anchors.length,
      operatorCount: plan.operators.length,
      retrievedArtifacts,
      usefulArtifacts,
      estimatedTokens,
      proofSufficiency,
    };

    const telemetryStore = await loadTelemetryStore(input.storagePath);
    telemetryStore.entries = [...telemetryStore.entries, telemetryEntry].slice(-MAX_TELEMETRY_ENTRIES);
    await saveTelemetryStore(input.storagePath, telemetryStore);

    return {
      packet,
      telemetryEntry,
      telemetrySummary: summarizeTelemetry(telemetryStore.entries),
    };
  }
}
