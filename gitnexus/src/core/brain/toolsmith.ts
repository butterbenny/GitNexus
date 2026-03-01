import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import {
  BrainPacket,
  BrainTickInput,
  ConstraintGraphSummary,
  EvalGraphSummary,
  PlanEnvelope,
  ToolsmithImplementationKind,
  ToolsmithOperatorArtifact,
  ToolsmithSummary,
} from './types.js';

const TOOLSMITH_STORE_SCHEMA_VERSION = 1;
const TOOLSMITH_STORE_FILE = 'toolsmith-operators.json';
const MAX_OPERATOR_ARTIFACTS = 200;
const MAX_SEQUENCES = 200;
const MAX_TOP_SEQUENCES = 5;
const MAX_LATEST_OPERATORS = 8;

interface ToolsmithSequenceStat {
  id: string;
  operators: string[];
  uses: number;
  lastUsedAt: string;
}

interface ToolsmithStore {
  schemaVersion: number;
  runCount: number;
  sequences: ToolsmithSequenceStat[];
  operators: ToolsmithOperatorArtifact[];
}

const nowIso = (): string => new Date().toISOString();

const clamp = (value: number, min = 0, max = 1): number => {
  return Math.max(min, Math.min(max, value));
};

const dedupe = <T>(items: T[]): T[] => Array.from(new Set(items));

const hashValue = (value: string): string => {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
};

const getStorePath = (storagePath: string): string => {
  return path.join(storagePath, 'manifests', TOOLSMITH_STORE_FILE);
};

const emptyStore = (): ToolsmithStore => ({
  schemaVersion: TOOLSMITH_STORE_SCHEMA_VERSION,
  runCount: 0,
  sequences: [],
  operators: [],
});

const loadStore = async (storagePath: string): Promise<ToolsmithStore> => {
  try {
    const raw = await fs.readFile(getStorePath(storagePath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      !parsed
      || Number(parsed.schemaVersion) !== TOOLSMITH_STORE_SCHEMA_VERSION
      || !Array.isArray(parsed.sequences)
      || !Array.isArray(parsed.operators)
    ) {
      return emptyStore();
    }
    return {
      schemaVersion: TOOLSMITH_STORE_SCHEMA_VERSION,
      runCount: Math.max(0, Number(parsed.runCount || parsed.operators.length || 0)),
      sequences: parsed.sequences,
      operators: parsed.operators,
    };
  } catch {
    return emptyStore();
  }
};

const saveStore = async (storagePath: string, store: ToolsmithStore): Promise<string> => {
  const filePath = getStorePath(storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  return filePath;
};

const inferSandboxProfile = (plan: PlanEnvelope): ToolsmithSummary['sandbox']['profile'] => {
  if (plan.mode === 'debug') return 'probe-safe';
  if (plan.mode === 'implement' || plan.mode === 'review') return 'patch-safe';
  if ((plan.requestedProbes || []).length > 2) return 'full-local-sandbox';
  return 'read-only';
};

const inferImplementationKind = (name: string): ToolsmithImplementationKind => {
  if (name.includes('report') || name.includes('rank_')) return 'pipeline';
  if (name.includes('trace_') || name.includes('explain_')) return 'composite';
  return 'cypher';
};

const mineOperatorCandidates = (
  plan: PlanEnvelope,
  constraintGraph?: ConstraintGraphSummary,
): string[] => {
  const names = new Set<string>();
  const planned = plan.operators.map(item => item.name);

  if (planned.includes('expand_slice') && planned.includes('compute_gap_delta')) {
    names.add('compare_two_slices');
  }
  if (planned.includes('request_runtime_probe')) {
    names.add('explain_gap_with_runtime');
  }
  if (planned.includes('select_tests')) {
    names.add('select_high_value_tests');
  }
  if (planned.includes('compile_constraints')) {
    names.add('compile_patch_guard_report');
  }
  if (planned.includes('select_precedents')) {
    names.add('rank_precedents_for_shape_change');
  }
  if ((constraintGraph?.violations || []).some(item => item.family === 'runtime')) {
    names.add('trace_cache_break');
  }
  if (names.size === 0) {
    names.add(`synth_${plan.mode}_operator_pack`);
  }
  return Array.from(names);
};

const updateSequences = (
  existing: ToolsmithSequenceStat[],
  sequenceOperators: string[],
): ToolsmithSequenceStat[] => {
  if (sequenceOperators.length === 0) return existing;
  const sequenceId = `seq:${hashValue(sequenceOperators.join('|'))}`;
  const byId = new Map<string, ToolsmithSequenceStat>();
  for (const item of existing) byId.set(item.id, item);

  const current = byId.get(sequenceId);
  if (!current) {
    byId.set(sequenceId, {
      id: sequenceId,
      operators: sequenceOperators,
      uses: 1,
      lastUsedAt: nowIso(),
    });
  } else {
    byId.set(sequenceId, {
      ...current,
      uses: current.uses + 1,
      lastUsedAt: nowIso(),
    });
  }

  return Array.from(byId.values())
    .sort((a, b) => {
      if (b.uses !== a.uses) return b.uses - a.uses;
      return a.id.localeCompare(b.id);
    })
    .slice(0, MAX_SEQUENCES);
};

const buildArtifact = (
  name: string,
  plan: PlanEnvelope,
  evalGraph: EvalGraphSummary | undefined,
  constraintGraph: ConstraintGraphSummary | undefined,
  brainPacket: BrainPacket | undefined,
  sandboxProfile: ToolsmithSummary['sandbox']['profile'],
): ToolsmithOperatorArtifact => {
  const implementationKind = inferImplementationKind(name);
  const unresolvedProof = Number(brainPacket?.proofPack.unresolved.length || 0);
  const requiredProof = Math.max(1, Number(brainPacket?.proofPack.objectives.filter(item => item.required).length || 0));
  const proofCarrying = unresolvedProof <= Math.floor(requiredProof / 2);
  const deterministicTestsPass = Number(evalGraph?.canaryHarness.passRate || 0) >= 0.6;
  const securityCriticalViolations = (constraintGraph?.violations || []).filter(item => (
    item.family === 'security' && (item.severity === 'critical' || item.severity === 'high')
  )).length;
  const securityPolicyApproved = securityCriticalViolations === 0;
  const capabilitySafe = sandboxProfile !== 'full-local-sandbox';
  const utilityGain = Number(clamp(
    (Number(evalGraph?.dashboardMetrics.learning.operatorPromotionHitRate || 0) * 0.4)
    + (Number(evalGraph?.dashboardMetrics.implement.precedentUsefulness || 0) * 0.25)
    + (proofCarrying ? 0.2 : 0)
    + (deterministicTestsPass ? 0.15 : 0),
  ).toFixed(4));
  const canPromote = Boolean(evalGraph?.canaryHarness.promotionAllowed);
  const approved = deterministicTestsPass && securityPolicyApproved && capabilitySafe && proofCarrying;
  const promoted = approved && canPromote && utilityGain >= 0.55;

  const safetyStatus: ToolsmithOperatorArtifact['safetyStatus'] = !securityPolicyApproved || !capabilitySafe
    ? 'rejected'
    : approved
      ? 'approved'
      : 'pending';

  return {
    id: `tool-op:${hashValue(`${plan.mode}|${name}|${implementationKind}`)}`,
    name,
    inputSchema: {
      type: 'object',
      required: ['repo', 'anchors'],
      properties: {
        repo: { type: 'string' },
        anchors: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['query', 'review', 'implement', 'debug'] },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['summary', 'proof'],
      properties: {
        summary: { type: 'string' },
        proof: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    implementationKind,
    createdFromTraceIds: dedupe([
      `mode:${plan.mode}`,
      `shape:${plan.contextShape}`,
      ...plan.operators.map(item => `op:${item.name}`).slice(0, 8),
    ]),
    utilityGain,
    safetyStatus,
    deterministicTestsPass,
    securityPolicyApproved,
    capabilitySafe,
    proofCarrying,
    promoted,
    rollbackReady: true,
    lastEvaluatedAt: nowIso(),
  };
};

const upsertArtifacts = (
  existing: ToolsmithOperatorArtifact[],
  generated: ToolsmithOperatorArtifact[],
): { next: ToolsmithOperatorArtifact[]; rolledBack: number } => {
  const byId = new Map<string, ToolsmithOperatorArtifact>();
  let rolledBack = 0;
  for (const item of existing) byId.set(item.id, item);

  for (const item of generated) {
    const prior = byId.get(item.id);
    if (prior && prior.promoted && !item.promoted) rolledBack += 1;
    byId.set(item.id, {
      ...(prior || {}),
      ...item,
      utilityGain: Number(Math.max(Number(prior?.utilityGain || 0), item.utilityGain).toFixed(4)),
    });
  }

  const next = Array.from(byId.values())
    .sort((a, b) => {
      if (b.promoted !== a.promoted) return Number(b.promoted) - Number(a.promoted);
      if (b.utilityGain !== a.utilityGain) return b.utilityGain - a.utilityGain;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_OPERATOR_ARTIFACTS);

  return { next, rolledBack };
};

export const runToolsmith = async (
  input: BrainTickInput,
  plan: PlanEnvelope,
  evalGraph?: EvalGraphSummary,
  constraintGraph?: ConstraintGraphSummary,
  brainPacket?: BrainPacket,
): Promise<ToolsmithSummary> => {
  const warnings: string[] = [];
  const store = await loadStore(input.storagePath);
  const sandboxProfile = inferSandboxProfile(plan);
  const candidateNames = mineOperatorCandidates(plan, constraintGraph);
  const generatedArtifacts = candidateNames.map(name => buildArtifact(
    name,
    plan,
    evalGraph,
    constraintGraph,
    brainPacket,
    sandboxProfile,
  ));

  const nextSequences = updateSequences(
    store.sequences,
    plan.operators.map(item => item.name),
  );
  const { next: nextArtifacts, rolledBack } = upsertArtifacts(store.operators, generatedArtifacts);
  store.runCount += 1;
  store.sequences = nextSequences;
  store.operators = nextArtifacts;
  const storePath = await saveStore(input.storagePath, store);

  const approved = nextArtifacts.filter(item => item.safetyStatus === 'approved').length;
  const pending = nextArtifacts.filter(item => item.safetyStatus === 'pending').length;
  const rejected = nextArtifacts.filter(item => item.safetyStatus === 'rejected').length;
  const promoted = nextArtifacts.filter(item => item.promoted).length;

  const guardrails = {
    deterministicTests: generatedArtifacts.every(item => item.deterministicTestsPass),
    evalCanary: Boolean(evalGraph?.canaryHarness.promotionAllowed),
    securityPolicy: generatedArtifacts.every(item => item.securityPolicyApproved),
    capabilitySafe: generatedArtifacts.every(item => item.capabilitySafe),
    proofCarrying: generatedArtifacts.every(item => item.proofCarrying),
  };

  if (candidateNames.length === 0) warnings.push('Toolsmith mined no operator candidates');
  if (!guardrails.deterministicTests) warnings.push('Toolsmith promotion blocked: deterministic tests gate failed');
  if (!guardrails.evalCanary) warnings.push('Toolsmith promotion blocked: eval canary not eligible');
  if (!guardrails.securityPolicy) warnings.push('Toolsmith promotion blocked: security policy gate failed');
  if (!guardrails.capabilitySafe) warnings.push('Toolsmith promotion blocked: capability safety gate failed');
  if (!guardrails.proofCarrying) warnings.push('Toolsmith promotion blocked: proof-carrying gate failed');

  return {
    generatedAt: nowIso(),
    storePath,
    runCount: store.runCount,
    miner: {
      sequenceCount: nextSequences.length,
      topSequences: nextSequences.slice(0, MAX_TOP_SEQUENCES).map(item => ({
        id: item.id,
        operators: item.operators,
        uses: item.uses,
      })),
    },
    synthesis: {
      candidatesGenerated: generatedArtifacts.length,
      artifactsTotal: nextArtifacts.length,
      typedOperators: nextArtifacts.length,
      implementationKinds: {
        cypher: nextArtifacts.filter(item => item.implementationKind === 'cypher').length,
        pipeline: nextArtifacts.filter(item => item.implementationKind === 'pipeline').length,
        composite: nextArtifacts.filter(item => item.implementationKind === 'composite').length,
      },
    },
    sandbox: {
      profile: sandboxProfile,
      approved,
      pending,
      rejected,
    },
    promotion: {
      eligible: generatedArtifacts.filter(item => item.safetyStatus === 'approved').length,
      promoted,
      rolledBack: rolledBack,
      guardrails,
    },
    latestOperators: nextArtifacts.slice(0, MAX_LATEST_OPERATORS),
    warnings,
  };
};
