import {
  BrainTickInput,
  ConstraintFamily,
  ConstraintGateAction,
  ConstraintGraphSummary,
  ConstraintRule,
  ConstraintSeverity,
  ConstraintViolation,
  PlanEnvelope,
  ProbeRequest,
  RuntimeTargetFamily,
  RuntimeTruthSummary,
} from './types.js';

const MAX_VIOLATIONS = 20;

const DEP_MANIFEST_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'composer.json',
  'composer.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
]);

const nowIso = (): string => new Date().toISOString();

const normalizePath = (value: unknown): string => {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
};

const dedupe = <T>(items: T[]): T[] => Array.from(new Set(items));

const RUNTIME_TARGET_FAMILY_SET = new Set<RuntimeTargetFamily>([
  'http',
  'auth',
  'cache',
  'shape',
  'event',
  'db',
  'exception',
]);

const normalizeStringList = (items: unknown): string[] => {
  if (!Array.isArray(items)) return [];
  return dedupe(
    items
      .map(item => String(item || '').trim())
      .filter(Boolean),
  ).sort((left, right) => left.localeCompare(right));
};

const normalizeTargetFamilies = (items: unknown): RuntimeTargetFamily[] => {
  const normalized = normalizeStringList(items);
  return normalized.filter((item): item is RuntimeTargetFamily => RUNTIME_TARGET_FAMILY_SET.has(item as RuntimeTargetFamily));
};

const normalizeProbeScope = (scope: ProbeRequest['scope'] | undefined): ProbeRequest['scope'] => {
  const tests = normalizeStringList(scope?.tests);
  const endpoints = normalizeStringList(scope?.endpoints);
  const files = normalizeStringList(scope?.files);
  return {
    ...(tests.length > 0 ? { tests } : {}),
    ...(endpoints.length > 0 ? { endpoints } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
};

const normalizeProbeRequest = (probe: ProbeRequest): ProbeRequest => {
  return {
    reason: probe.reason,
    anchors: normalizeStringList(probe.anchors),
    targetFamilies: normalizeTargetFamilies(probe.targetFamilies),
    scope: normalizeProbeScope(probe.scope),
    ttlMinutes: Math.max(0, Number(probe.ttlMinutes || 0)),
  };
};

const dedupeProbeRequests = (items: ProbeRequest[]): ProbeRequest[] => {
  const deduped: ProbeRequest[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const normalized = normalizeProbeRequest(item);
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
};

const toRuleCatalog = (): ConstraintRule[] => {
  return [
    {
      id: 'constraint:mutation-cache-closure',
      family: 'structural',
      severity: 'high',
      summary: 'Mutation surfaces should provide cache invalidation closure',
      dsl: 'constraint MutationCacheClosure { when mutationSurface == true require cacheClosure == true severity "high" }',
    },
    {
      id: 'constraint:validated-field-reachability',
      family: 'shape',
      severity: 'medium',
      summary: 'Validated fields should reach serializer/resource/side-effect consumers',
      dsl: 'constraint ValidatedFieldReachability { when validatedField == true require reachesAny(["ResourceField","DBColumn","SideEffect"]) severity "medium" }',
    },
    {
      id: 'constraint:admin-endpoint-auth',
      family: 'auth',
      severity: 'critical',
      summary: 'Admin endpoint edits must include permission/auth closure',
      dsl: 'constraint AdminEndpointAuth { when endpoint.pathPrefix == "/admin" require endpoint.hasPermissionClosure() severity "critical" }',
    },
    {
      id: 'constraint:runtime-mutation-invalidation',
      family: 'runtime',
      severity: 'high',
      summary: 'Runtime contradictions on mutation flows require witness/test closure',
      dsl: 'constraint RuntimeMutationInvalidation { when mutationSurface == true require runtimeInvalidationWitness == true severity "high" }',
    },
    {
      id: 'constraint:dependency-policy',
      family: 'dependency',
      severity: 'medium',
      summary: 'Dependency manifest changes require policy/remediation verification',
      dsl: 'constraint DependencyPolicy { when dependencyManifestChanged == true require policyReview == true severity "medium" }',
    },
    {
      id: 'constraint:hot-path-query-growth',
      family: 'performance',
      severity: 'high',
      summary: 'Hot path DB changes need runtime query-count evidence',
      dsl: 'constraint HotPathQueryGrowth { when hotPathDbTouch == true require runtimeQueryWitness == true severity "high" }',
    },
    {
      id: 'constraint:tainted-input-sanitization',
      family: 'security',
      severity: 'critical',
      summary: 'External input should not cross dangerous sinks without sanitization',
      dsl: 'constraint TaintedInputSanitization { when externalInputSurface == true require sanitizationClosure == true severity "critical" }',
    },
  ];
};

const createFamilyCounts = (): Record<ConstraintFamily, number> => ({
  structural: 0,
  shape: 0,
  auth: 0,
  runtime: 0,
  dependency: 0,
  performance: 0,
  security: 0,
});

const inferProbeReason = (mode: PlanEnvelope['mode']): ProbeRequest['reason'] => {
  if (mode === 'debug') return 'debug-symptom';
  if (mode === 'implement') return 'implement-verification';
  if (mode === 'review') return 'review-uncertainty';
  return 'eval-canary';
};

const familiesForConstraint = (family: ConstraintFamily): RuntimeTargetFamily[] => {
  if (family === 'runtime') return ['cache', 'shape', 'db'];
  if (family === 'auth') return ['auth', 'http'];
  if (family === 'performance') return ['db', 'cache'];
  if (family === 'security') return ['http', 'auth', 'shape'];
  return ['http', 'shape'];
};

const buildProbeRequest = (
  plan: PlanEnvelope,
  sourceFiles: string[],
  family: ConstraintFamily,
): ProbeRequest => {
  return {
    reason: inferProbeReason(plan.mode),
    anchors: plan.anchors.map(anchor => anchor.id).slice(0, 8),
    targetFamilies: familiesForConstraint(family),
    scope: {
      files: sourceFiles.slice(0, 10),
    },
    ttlMinutes: plan.mode === 'debug' ? 45 : 30,
  };
};

const touchesAny = (paths: string[], keywords: string[]): boolean => {
  return paths.some(filePath => keywords.some(keyword => filePath.includes(keyword)));
};

const hasDependencyManifestTouch = (paths: string[]): boolean => {
  return paths.some(filePath => DEP_MANIFEST_FILES.has(filePath.split('/').pop() || ''));
};

const toSeverityRank = (severity: ConstraintSeverity): number => {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
};

const makeViolation = (
  rule: ConstraintRule,
  summary: string,
  evidence: string[],
  gateAction: ConstraintGateAction,
  contradiction = false,
  overrideSeverity?: ConstraintSeverity,
): ConstraintViolation => {
  const severity = overrideSeverity || rule.severity;
  return {
    id: `${rule.id}:${gateAction}:${severity}:${evidence.join('|') || 'no-evidence'}`.slice(0, 220),
    ruleId: rule.id,
    family: rule.family,
    severity,
    summary,
    evidence,
    gateAction,
    contradiction,
  };
};

const includesAny = (items: string[], prefixes: string[]): boolean => {
  return items.some(item => prefixes.some(prefix => item.includes(prefix)));
};

interface ConstraintFacts {
  sourceFiles: string[];
  hasMutationSurface: boolean;
  hasCacheClosureTouch: boolean;
  hasEndpointSurface: boolean;
  hasAdminSurface: boolean;
  hasAuthClosureTouch: boolean;
  hasValidationTouch: boolean;
  hasShapeConsumerTouch: boolean;
  hasDependencyManifestTouch: boolean;
  hasDatabaseTouch: boolean;
  hasSanitizationTouch: boolean;
  hasSecretSurfaceTouch: boolean;
  runtimeWitnesses: number;
  runtimeContradictions: number;
  hotLoops: number;
  cacheWitnesses: number;
}

const inferFacts = (
  input: BrainTickInput,
  plan: PlanEnvelope,
  runtimeTruth?: RuntimeTruthSummary,
): ConstraintFacts => {
  const sourceFiles = dedupe(
    (input.changedPaths || [])
      .concat(plan.anchors.map(anchor => anchor.filePath || ''))
      .map(normalizePath)
      .filter(Boolean),
  ).slice(0, 24);

  const runtimeWitnesses = runtimeTruth?.witnesses.length || 0;
  const runtimeContradictions = runtimeTruth?.contradictions.length || 0;
  const hotLoops = (runtimeTruth?.observedLoops || []).filter(loop => loop.averageDurationMs >= 700 || loop.maxDurationMs >= 1500).length;
  const cacheWitnesses = (runtimeTruth?.witnesses || []).filter(witness => includesAny(witness.observedChain, ['cache', 'invalidate'])).length;

  return {
    sourceFiles,
    hasMutationSurface: touchesAny(sourceFiles, ['mutation', 'create', 'update', 'delete', 'patch', 'post']),
    hasCacheClosureTouch: touchesAny(sourceFiles, ['cache', 'query-key', 'query_key', 'invalidate', 'react-query']),
    hasEndpointSurface: touchesAny(sourceFiles, ['route', 'controller', 'http', 'endpoint', 'api']),
    hasAdminSurface: touchesAny(sourceFiles, ['admin']),
    hasAuthClosureTouch: touchesAny(sourceFiles, ['auth', 'policy', 'permission', 'guard', 'middleware']),
    hasValidationTouch: touchesAny(sourceFiles, ['validator', 'validation', 'request', 'rule', 'rules', 'form']),
    hasShapeConsumerTouch: touchesAny(sourceFiles, ['resource', 'serializer', 'shape', 'schema', 'contract', 'dto', 'field']),
    hasDependencyManifestTouch: hasDependencyManifestTouch(sourceFiles),
    hasDatabaseTouch: touchesAny(sourceFiles, ['db', 'sql', 'model', 'repository', 'query']),
    hasSanitizationTouch: touchesAny(sourceFiles, ['sanitize', 'escaped', 'escape', 'validated', 'clean']),
    hasSecretSurfaceTouch: touchesAny(sourceFiles, ['secret', 'token', 'password', 'credential', 'apikey', 'api-key']),
    runtimeWitnesses,
    runtimeContradictions,
    hotLoops,
    cacheWitnesses,
  };
};

export const compileConstraintGraph = async (
  input: BrainTickInput,
  plan: PlanEnvelope,
  runtimeTruth?: RuntimeTruthSummary,
): Promise<ConstraintGraphSummary> => {
  const generatedAt = nowIso();
  const warnings: string[] = [];
  const catalog = toRuleCatalog();
  const byFamily = createFamilyCounts();
  for (const rule of catalog) byFamily[rule.family] += 1;

  const facts = inferFacts(input, plan, runtimeTruth);
  const violations: ConstraintViolation[] = [];
  const requestedProbes: ProbeRequest[] = [];
  const requestedTests: string[] = [];
  let finiteChecks = 0;
  let cardinalityChecks = 0;

  const addViolation = (violation: ConstraintViolation): void => {
    violations.push(violation);
    if (violation.gateAction === 'request-runtime-probe') {
      requestedProbes.push(buildProbeRequest(plan, facts.sourceFiles, violation.family));
    }
    if (violation.gateAction === 'request-targeted-tests' || violation.gateAction === 'block') {
      if (violation.family === 'security') requestedTests.push('node --test test/brain-resource-read.test.js');
      if (violation.family === 'performance') requestedTests.push('node --test test/brain-runtime-truth.test.js');
      if (violation.family === 'dependency') requestedTests.push('node --test test/no-registry-refresh.test.js');
      if (violation.family === 'runtime') requestedTests.push('node dist/cli/index.js runtime-ingest --print');
      if (violation.family === 'auth' || violation.family === 'structural' || violation.family === 'shape') {
        requestedTests.push('node --test test/brain-constraint-graph.test.js');
      }
    }
  };

  const mutationCacheRule = catalog.find(rule => rule.id === 'constraint:mutation-cache-closure');
  if (mutationCacheRule && facts.hasMutationSurface) {
    finiteChecks += 1;
    if (!facts.hasCacheClosureTouch && facts.cacheWitnesses === 0) {
      addViolation(
        makeViolation(
          mutationCacheRule,
          'Mutation-adjacent edits have no cache invalidation closure evidence',
          facts.sourceFiles.slice(0, 6),
          'request-targeted-tests',
        ),
      );
    }
  }

  const shapeRule = catalog.find(rule => rule.id === 'constraint:validated-field-reachability');
  if (shapeRule && facts.hasValidationTouch) {
    finiteChecks += 1;
    if (!facts.hasShapeConsumerTouch) {
      addViolation(
        makeViolation(
          shapeRule,
          'Validation-heavy edits did not show shape/resource consumer closure',
          facts.sourceFiles.slice(0, 6),
          'warn',
        ),
      );
    }
  }

  const authRule = catalog.find(rule => rule.id === 'constraint:admin-endpoint-auth');
  if (authRule && facts.hasEndpointSurface && facts.hasAdminSurface) {
    finiteChecks += 1;
    if (!facts.hasAuthClosureTouch) {
      addViolation(
        makeViolation(
          authRule,
          'Admin endpoint edits are missing explicit auth/policy/permission closure',
          facts.sourceFiles.slice(0, 6),
          'block',
          false,
          'critical',
        ),
      );
    }
  }

  const runtimeRule = catalog.find(rule => rule.id === 'constraint:runtime-mutation-invalidation');
  if (runtimeRule && facts.hasMutationSurface) {
    cardinalityChecks += 1;
    if (facts.runtimeWitnesses === 0) {
      addViolation(
        makeViolation(
          runtimeRule,
          'Mutation surface touched without runtime witness coverage',
          facts.sourceFiles.slice(0, 6),
          'request-runtime-probe',
        ),
      );
    }
    if (facts.runtimeContradictions > 0) {
      addViolation(
        makeViolation(
          runtimeRule,
          `${facts.runtimeContradictions} runtime contradiction witness(es) detected`,
          (runtimeTruth?.contradictions || []).map(item => item.id).slice(0, 6),
          'request-targeted-tests',
          true,
        ),
      );
    }
  }

  const dependencyRule = catalog.find(rule => rule.id === 'constraint:dependency-policy');
  if (dependencyRule && facts.hasDependencyManifestTouch) {
    finiteChecks += 1;
    addViolation(
      makeViolation(
        dependencyRule,
        'Dependency manifest changes require explicit policy/remediation verification',
        facts.sourceFiles.filter(file => DEP_MANIFEST_FILES.has(file.split('/').pop() || '')).slice(0, 6),
        'request-targeted-tests',
      ),
    );
  }

  const performanceRule = catalog.find(rule => rule.id === 'constraint:hot-path-query-growth');
  if (performanceRule && facts.hasDatabaseTouch) {
    cardinalityChecks += 1;
    if (facts.hotLoops > 0) {
      addViolation(
        makeViolation(
          performanceRule,
          `Runtime hot-loop evidence (${facts.hotLoops}) intersects DB-touching edits`,
          facts.sourceFiles.slice(0, 6),
          'request-targeted-tests',
          true,
        ),
      );
    }
  }

  const securityRule = catalog.find(rule => rule.id === 'constraint:tainted-input-sanitization');
  if (securityRule && facts.hasEndpointSurface) {
    finiteChecks += 1;
    const missingSanitization = !facts.hasValidationTouch && !facts.hasSanitizationTouch;
    if (missingSanitization) {
      const elevated = facts.hasSecretSurfaceTouch || facts.hasDatabaseTouch;
      addViolation(
        makeViolation(
          securityRule,
          elevated
            ? 'Endpoint edits cross sensitive surfaces without sanitization closure'
            : 'Endpoint edits appear to lack validation/sanitization closure',
          facts.sourceFiles.slice(0, 6),
          elevated ? 'block' : 'request-targeted-tests',
          false,
          elevated ? 'critical' : 'high',
        ),
      );
    }
  }

  const dedupedProbes = dedupeProbeRequests(requestedProbes);
  const dedupedTests = dedupe(requestedTests);
  const sortedViolations = violations
    .sort((a, b) => toSeverityRank(b.severity) - toSeverityRank(a.severity))
    .slice(0, MAX_VIOLATIONS);

  if (sortedViolations.length === 0) {
    warnings.push('ConstraintGraph found no blocking/warning violations for current anchor scope');
  }

  const blocked = sortedViolations.filter(item => item.gateAction === 'block').length;
  const warned = sortedViolations.filter(item => item.gateAction === 'warn').length;
  const requestedRuntimeProbe = sortedViolations.filter(item => item.gateAction === 'request-runtime-probe').length;
  const requestedTargetedTests = sortedViolations.filter(item => item.gateAction === 'request-targeted-tests').length;
  const forwardChainInferences = [
    facts.hasMutationSurface,
    facts.hasEndpointSurface,
    facts.hasAdminSurface,
    facts.hasValidationTouch,
    facts.hasDependencyManifestTouch,
    facts.hasDatabaseTouch,
    facts.hasSanitizationTouch,
    facts.hasSecretSurfaceTouch,
    facts.runtimeContradictions > 0,
    facts.hotLoops > 0,
  ].filter(Boolean).length;

  return {
    generatedAt,
    sourceFiles: facts.sourceFiles,
    catalog: {
      totalRules: catalog.length,
      byFamily,
    },
    solver: {
      patternChecks: catalog.length,
      finiteChecks,
      cardinalityChecks,
      forwardChainInferences,
      contradictions: facts.runtimeContradictions,
    },
    patchGate: {
      checked: catalog.length,
      blocked,
      warned,
      requestedRuntimeProbe,
      requestedTargetedTests,
    },
    rules: catalog,
    violations: sortedViolations,
    requestedProbes: dedupedProbes,
    requestedTests: dedupedTests,
    warnings,
  };
};
