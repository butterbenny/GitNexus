import {
  BrainMode,
  BrainTickInput,
  PlanEnvelope,
  PlannedOperator,
  PlannerIntentClass,
  PlannerState,
  ProbeRequest,
  ProofObjective,
  RuntimeTargetFamily,
  StopCondition,
} from './types.js';

const clamp = (value: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, value));
};

const parsePolicyHint = (value: string): {
  mode: BrainMode;
  contextShape: 'thin' | 'standard' | 'deep';
  scopeHint: string;
} | null => {
  const normalized = String(value || '').trim();
  if (!normalized || !normalized.startsWith('policy:')) return null;
  const [, modeRaw, contextShapeRaw, ...scopeParts] = normalized.split(':');
  const mode = (modeRaw || '').trim() as BrainMode;
  const contextShape = (contextShapeRaw || '').trim() as 'thin' | 'standard' | 'deep';
  if (!['query', 'review', 'implement', 'debug'].includes(mode)) return null;
  if (!['thin', 'standard', 'deep'].includes(contextShape)) return null;
  return {
    mode,
    contextShape,
    scopeHint: scopeParts.join(':'),
  };
};

const inferMode = (input: BrainTickInput): BrainMode => {
  if (input.modeHint) return input.modeHint;
  if (input.reason === 'patch-validated') return 'review';
  if (input.reason === 'mode-run') return 'implement';
  if (input.reason === 'test-complete') return 'debug';
  return 'query';
};

const inferIntentClass = (input: BrainTickInput): PlannerIntentClass => {
  const task = String(input.task || '').toLowerCase();
  if (task.includes('debug') || task.includes('incident') || task.includes('symptom')) return 'symptom';
  if (task.includes('refactor')) return 'refactor';
  if (task.includes('feature')) return 'feature-request';
  if (task.includes('contract')) return 'contract';
  if (task.includes('symbol')) return 'symbol';
  return 'maintenance';
};

const buildAnchors = (input: BrainTickInput) => {
  const changedPaths = Array.isArray(input.changedPaths) ? input.changedPaths : [];
  if (changedPaths.length === 0) {
    return [
      {
        id: `repo:${input.repoFingerprint}`,
        kind: 'contract' as const,
        label: 'repo-fingerprint',
        confidence: 0.45,
      },
    ];
  }

  return changedPaths.slice(0, 8).map((filePath, index) => ({
    id: `file:${filePath}`,
    kind: 'file' as const,
    label: filePath,
    filePath,
    confidence: clamp(0.9 - index * 0.08, 0.3, 0.95),
  }));
};

const buildProofObjectives = (input: BrainTickInput): ProofObjective[] => {
  const changedPaths = Array.isArray(input.changedPaths) ? input.changedPaths : [];
  if (changedPaths.length === 0) {
    return [
      {
        id: 'proof:no-delta',
        claim: 'No indexable deltas require closure verification',
        required: false,
      },
    ];
  }

  return [
    {
      id: 'proof:index-integrity',
      claim: 'Changed paths remain indexable and included in analysis flow',
      required: true,
    },
    {
      id: 'proof:post-analyze-contract',
      claim: 'Post-analyze sidecar outputs remain readable via MCP resources',
      required: true,
    },
  ];
};

const buildStopConditions = (mode: BrainMode): StopCondition[] => {
  if (mode === 'debug') {
    return [
      { id: 'debug-top-candidate', rule: 'Stop when a root-cause candidate reaches confidence >= 0.9' },
      { id: 'debug-proof', rule: 'Stop when one validating witness is present for top candidate' },
    ];
  }

  return [
    { id: 'proof-minimum', rule: 'Stop when all required proof objectives are covered' },
    { id: 'budget-guard', rule: 'Stop when max operator budget is exhausted' },
  ];
};

const inferProbeReason = (mode: BrainMode): ProbeRequest['reason'] => {
  if (mode === 'debug') return 'debug-symptom';
  if (mode === 'implement') return 'implement-verification';
  if (mode === 'review') return 'review-uncertainty';
  return 'eval-canary';
};

const inferProbeFamilies = (mode: BrainMode, changedPaths: string[]): RuntimeTargetFamily[] => {
  const families = new Set<RuntimeTargetFamily>();
  if (mode === 'debug') {
    families.add('http');
    families.add('db');
    families.add('exception');
  }
  if (mode === 'implement' || mode === 'review') {
    families.add('shape');
    families.add('cache');
  }
  for (const changedPath of changedPaths) {
    const filePath = String(changedPath || '').toLowerCase();
    if (!filePath) continue;
    if (filePath.includes('route') || filePath.includes('controller') || filePath.includes('http')) {
      families.add('http');
      families.add('shape');
    }
    if (filePath.includes('auth') || filePath.includes('policy') || filePath.includes('permission')) {
      families.add('auth');
    }
    if (filePath.includes('cache') || filePath.includes('query')) {
      families.add('cache');
    }
    if (filePath.includes('event') || filePath.includes('queue') || filePath.includes('job')) {
      families.add('event');
    }
    if (filePath.includes('db') || filePath.includes('sql') || filePath.includes('model')) {
      families.add('db');
    }
  }
  if (families.size === 0) families.add('http');
  return Array.from(families);
};

export class PlannerEngine {
  plan(input: BrainTickInput): PlanEnvelope {
    const mode = inferMode(input);
    const intentClass = inferIntentClass(input);
    const anchors = buildAnchors(input);
    const changedCount = Array.isArray(input.changedPaths) ? input.changedPaths.length : 0;
    const baselineContextShape = changedCount === 0 ? 'thin' : changedCount > 8 ? 'deep' : 'standard';
    const policyHint = parsePolicyHint(String(input.plannerPolicyVersion || ''));
    const contextShape = (policyHint && policyHint.mode === mode)
      ? policyHint.contextShape
      : baselineContextShape;
    const uncertaintyRuntime = mode === 'debug' ? 0.65 : changedCount > 0 ? 0.5 : 0.3;
    const shouldProbe = mode === 'debug' || (changedCount > 0 && uncertaintyRuntime >= 0.45);
    const requestedProbes: ProbeRequest[] = shouldProbe
      ? [{
        reason: inferProbeReason(mode),
        anchors: anchors.map(anchor => anchor.id).slice(0, 6),
        targetFamilies: inferProbeFamilies(mode, Array.isArray(input.changedPaths) ? input.changedPaths : []),
        scope: {
          files: anchors.map(anchor => anchor.filePath || '').filter(Boolean).slice(0, 8),
        },
        ttlMinutes: mode === 'debug' ? 45 : 30,
      }]
      : [];

    const operatorNames: PlannedOperator['name'][] = ['resolve_anchor'];
    if (contextShape !== 'thin') {
      operatorNames.push('expand_slice');
    }
    if (contextShape === 'deep') {
      operatorNames.push('expand_shape', 'compute_gap_delta', 'select_precedents', 'retrieve_memory_cards');
    } else {
      operatorNames.push('compute_gap_delta');
      if (contextShape === 'standard') operatorNames.push('select_precedents');
    }
    operatorNames.push('compile_constraints', 'select_tests');
    if (requestedProbes.length > 0) operatorNames.push('request_runtime_probe');
    operatorNames.push('compile_context_packet');

    const operators = operatorNames.map((name, index) => ({
      name,
      reason: name === 'request_runtime_probe'
        ? 'runtime uncertainty requires live witness planning'
        : index === 0
          ? 'bootstrap anchors'
          : policyHint && policyHint.mode === mode
            ? `policy-adaptive:${String(input.plannerPolicyVersion || 'unknown')}`
            : 'rule-baseline plan',
      priority: index + 1,
    }));

    const state: PlannerState = {
      mode,
      repoFingerprint: input.repoFingerprint,
      intentClass,
      anchorEntropy: clamp(anchors.length * 0.11, 0.1, 1),
      candidateSlices: changedCount,
      candidateContracts: Math.max(1, Math.ceil(changedCount / 3)),
      uncertaintyVector: {
        static: changedCount === 0 ? 0.2 : 0.35,
        runtime: uncertaintyRuntime,
        precedent: 0.4,
        memory: 0.3,
      },
      budget: {
        maxTokens: contextShape === 'thin' ? 1200 : contextShape === 'deep' ? 4200 : 2600,
        maxFiles: contextShape === 'deep' ? 12 : 6,
        maxOperators: operators.length,
      },
      priorOutcomeHints: {
        similarSuccessRate: policyHint && policyHint.mode === mode ? 0.72 : 0.65,
        similarFailureRate: policyHint && policyHint.mode === mode ? 0.16 : 0.2,
      },
    };

    return {
      mode,
      anchors,
      operators,
      proofObjectives: buildProofObjectives(input),
      requestedProbes,
      contextShape,
      stopConditions: buildStopConditions(mode),
      state,
    };
  }
}
