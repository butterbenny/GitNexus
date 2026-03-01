/**
 * MCP Resources (Multi-Repo)
 * 
 * Provides structured on-demand data to AI agents.
 * All resources use repo-scoped URIs: gitnexus://repo/{name}/context
 */

import type { LocalBackend } from './local/local-backend.js';
import { checkStaleness } from './staleness.js';
import fs from 'fs/promises';
import path from 'path';

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * Static resources — includes per-repo resources and the global repos list
 */
export function getResourceDefinitions(): ResourceDefinition[] {
  return [
    {
      uri: 'gitnexus://repos',
      name: 'All Indexed Repositories',
      description: 'List of all indexed repos with stats. Read this first to discover available repos.',
      mimeType: 'text/yaml',
    },
    {
      uri: 'gitnexus://setup',
      name: 'GitNexus Setup Content',
      description: 'Returns AGENTS.md content for all indexed repos. Useful for setup/onboarding.',
      mimeType: 'text/markdown',
    },
  ];
}

/**
 * Dynamic resource templates
 */
export function getResourceTemplates(): ResourceTemplate[] {
  return [
    {
      uriTemplate: 'gitnexus://repo/{name}/context',
      name: 'Repo Overview',
      description: 'Codebase stats, staleness check, and available tools',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/brain',
      name: 'Brain Manifest',
      description: 'BrainKernel status manifest and producer/eval/risk summaries',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/clusters',
      name: 'Repo Modules',
      description: 'All functional areas (Leiden clusters)',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/processes',
      name: 'Repo Processes',
      description: 'All execution flows',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/archetypes',
      name: 'Repo Archetypes',
      description: 'Derived flow signatures + exemplar processes (no schema changes)',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/schema',
      name: 'Graph Schema',
      description: 'Node/edge schema for Cypher queries',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/episode',
      name: 'Episode Graph',
      description: 'Session working-memory overlay (opened spans, hypotheses, errors, edits)',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/evidence',
      name: 'Evidence Spans',
      description: 'Line-level primary/witness/proof spans for symbols and relations',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/summaries',
      name: 'Structured Summaries',
      description: 'Structured overlay summaries by symbol/file/slice/community/process/archetype',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/closure-templates',
      name: 'Closure Templates',
      description: 'Derived closure-template overlays for feature-slice families',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/cluster/{clusterName}',
      name: 'Module Detail',
      description: 'Deep dive into a specific functional area',
      mimeType: 'text/yaml',
    },
    {
      uriTemplate: 'gitnexus://repo/{name}/process/{processName}',
      name: 'Process Trace',
      description: 'Step-by-step execution trace',
      mimeType: 'text/yaml',
    },
  ];
}

/**
 * Parse a resource URI to extract the repo name and resource type.
 */
function parseUri(uri: string): { repoName?: string; resourceType: string; param?: string } {
  if (uri === 'gitnexus://repos') return { resourceType: 'repos' };
  if (uri === 'gitnexus://setup') return { resourceType: 'setup' };

  // Repo-scoped: gitnexus://repo/{name}/context
  const repoMatch = uri.match(/^gitnexus:\/\/repo\/([^/]+)\/(.+)$/);
  if (repoMatch) {
    const repoName = decodeURIComponent(repoMatch[1]);
    const rest = repoMatch[2];

    if (rest.startsWith('cluster/')) {
      return { repoName, resourceType: 'cluster', param: decodeURIComponent(rest.replace('cluster/', '')) };
    }
    if (rest.startsWith('process/')) {
      return { repoName, resourceType: 'process', param: decodeURIComponent(rest.replace('process/', '')) };
    }

    return { repoName, resourceType: rest };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}

/**
 * Read a resource and return its content
 */
export async function readResource(uri: string, backend: LocalBackend): Promise<string> {
  await backend.refreshFromRegistryIfNeeded();
  const parsed = parseUri(uri);

  // Global repos list — no repo context needed
  if (parsed.resourceType === 'repos') {
    return getReposResource(backend);
  }
  
  // Setup resource — returns AGENTS.md content for all repos
  if (parsed.resourceType === 'setup') {
    return getSetupResource(backend);
  }

  const repoName = parsed.repoName;
  if (repoName) {
    await backend.refreshRepoMetaForResource(repoName);
  }

  switch (parsed.resourceType) {
    case 'context':
      return getContextResource(backend, repoName);
    case 'brain':
      return getBrainManifestResource(backend, repoName);
    case 'clusters':
      return getClustersResource(backend, repoName);
    case 'processes':
      return getProcessesResource(backend, repoName);
    case 'archetypes':
      return getArchetypesResource(backend, repoName);
    case 'schema':
      return getSchemaResource();
    case 'episode':
      return getEpisodeResource(backend, repoName);
    case 'evidence':
      return getEvidenceResource(backend, repoName);
    case 'summaries':
      return getSummariesResource(backend, repoName);
    case 'closure-templates':
      return getClosureTemplatesResource(backend, repoName);
    case 'cluster':
      return getClusterDetailResource(parsed.param!, backend, repoName);
    case 'process':
      return getProcessDetailResource(parsed.param!, backend, repoName);
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}

// ─── Resource Implementations ─────────────────────────────────────────

/**
 * Repos resource — list all indexed repositories
 */
function getReposResource(backend: LocalBackend): string {
  const repos = backend.listRepos();

  if (repos.length === 0) {
    return 'repos: []\n# No repositories indexed. Run: gitnexus analyze';
  }

  const lines: string[] = ['repos:'];
  for (const repo of repos) {
    lines.push(`  - name: "${repo.name}"`);
    lines.push(`    path: "${repo.path}"`);
    lines.push(`    indexed: "${repo.indexedAt}"`);
    lines.push(`    commit: "${repo.lastCommit?.slice(0, 7) || 'unknown'}"`);
    if (repo.stats) {
      lines.push(`    files: ${repo.stats.files || 0}`);
      lines.push(`    symbols: ${repo.stats.nodes || 0}`);
      lines.push(`    processes: ${repo.stats.processes || 0}`);
    }
  }

  if (repos.length > 1) {
    lines.push('');
    lines.push('# Multiple repos indexed. Use repo parameter in tool calls:');
    lines.push(`# query({query: "auth", repo: "${repos[0].name}"})`);
  }

  return lines.join('\n');
}

/**
 * Context resource — codebase overview for a specific repo
 */
async function getContextResource(backend: LocalBackend, repoName?: string): Promise<string> {
  // Resolve repo
  const repo = backend.resolveRepo(repoName);
  const context = backend.getContext(repo.id) || backend.getContext();

  if (!context) {
    return 'error: No codebase loaded. Run: gitnexus analyze';
  }
  
  // Check staleness
  const repoPath = repo.repoPath;
  const lastCommit = repo.lastCommit || 'HEAD';
  const staleness = repoPath ? checkStaleness(repoPath, lastCommit) : { isStale: false, commitsBehind: 0 };
  
  const lines: string[] = [
    `project: ${context.projectName}`,
  ];
  
  if (staleness.isStale && staleness.hint) {
    lines.push('');
    lines.push(`staleness: "${staleness.hint}"`);
  }
  
  lines.push('');
  lines.push('stats:');
  lines.push(`  files: ${context.stats.fileCount}`);
  lines.push(`  symbols: ${context.stats.functionCount}`);
  lines.push(`  processes: ${context.stats.processCount}`);
  lines.push('');
  lines.push('tools_available:');
  lines.push('  - query: Process-grouped code intelligence (execution flows related to a concept)');
  lines.push('  - mode_router: Auto-router for query/implement/review/debug kernels');
  lines.push('  - query_mode: Query-head planner (top slices, symbols, precedents, action hints)');
  lines.push('  - implement_mode: Implementation planner (target slice, companions, write order, review handoff)');
  lines.push('  - archetypes: Derived flow signatures + exemplar processes (pattern heat map)');
  lines.push('  - context: 360-degree symbol view (categorized refs, process participation)');
  lines.push('  - impact: Blast radius analysis (what breaks if you change a symbol)');
  lines.push('  - detect_changes: Git-diff impact analysis (what do your changes affect)');
  lines.push('  - episode_state: Read EpisodeGraph sidecar working memory');
  lines.push('  - episode_update: Update EpisodeGraph sidecar with hypotheses/tests/errors');
  lines.push('  - evidence_spans: Read EvidenceSpan sidecar line-level proof/witness ranges');
  lines.push('  - summary_overlay: Read structured hierarchical summary overlays');
  lines.push('  - closure_templates: Read closure-template overlays for slice families');
  lines.push('  - rename: Multi-file coordinated rename with confidence tags');
  lines.push('  - cypher: Raw graph queries');
  lines.push('  - list_repos: Discover all indexed repositories');
  lines.push('');
  lines.push('re_index: Run `gitnexus analyze` (incremental by default; `--force` for full) if data is stale');
  lines.push('');
  lines.push('tips:');
  lines.push('  - If context/impact returns status=ambiguous, rerun with uid or file_path to disambiguate');
  lines.push('  - For architecture/implementation, start with archetypes to mirror an existing flow signature');
  lines.push('  - If indexing in a sandboxed environment, use `gitnexus analyze --no-registry --no-hooks` (or set `GITNEXUS_HOME`)');
  lines.push('');
  lines.push('resources_available:');
  lines.push('  - gitnexus://repos: All indexed repositories');
  lines.push(`  - gitnexus://repo/${context.projectName}/clusters: All functional areas`);
  lines.push(`  - gitnexus://repo/${context.projectName}/brain: BrainKernel manifest`);
  lines.push(`  - gitnexus://repo/${context.projectName}/processes: All execution flows`);
  lines.push(`  - gitnexus://repo/${context.projectName}/archetypes: Derived flow signatures + exemplars`);
  lines.push(`  - gitnexus://repo/${context.projectName}/schema: Graph schema for Cypher`);
  lines.push(`  - gitnexus://repo/${context.projectName}/episode: EpisodeGraph sidecar state`);
  lines.push(`  - gitnexus://repo/${context.projectName}/evidence: EvidenceSpan sidecar summary`);
  lines.push(`  - gitnexus://repo/${context.projectName}/summaries: Structured summary overlays`);
  lines.push(`  - gitnexus://repo/${context.projectName}/closure-templates: Closure-template overlays`);
  lines.push(`  - gitnexus://repo/${context.projectName}/cluster/{name}: Module details`);
  lines.push(`  - gitnexus://repo/${context.projectName}/process/{name}: Process trace`);
  
  return lines.join('\n');
}

async function getBrainManifestResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const repo = backend.resolveRepo(repoName);
    const manifestPath = path.join(repo.storagePath, 'manifests', 'brain.json');
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);
    if (!manifest || typeof manifest !== 'object') {
      return 'error: Invalid brain manifest payload';
    }

    const lines: string[] = [];
    lines.push(`repo: "${String(repo.name || '').replace(/"/g, '\\"')}"`);
    lines.push(`path: "${manifestPath.replace(/"/g, '\\"')}"`);
    lines.push(`schema_version: ${Number(manifest.schemaVersion || 0)}`);
    lines.push(`repo_fingerprint: "${String(manifest.repoFingerprint || '').replace(/"/g, '\\"')}"`);
    lines.push(`graph_version: "${String(manifest.graphVersion || '').replace(/"/g, '\\"')}"`);
    lines.push(`planner_policy_version: "${String(manifest.plannerPolicyVersion || '').replace(/"/g, '\\"')}"`);
    lines.push(`runtime_truth_freshness: "${String(manifest.runtimeTruthFreshness || '').replace(/"/g, '\\"')}"`);

    const tick = manifest.tick || {};
    lines.push('tick:');
    lines.push(`  reason: "${String(tick.reason || '').replace(/"/g, '\\"')}"`);
    lines.push(`  finished_at: "${String(tick.finishedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  duration_ms: ${Number(tick.durationMs || 0)}`);
    lines.push(`  step_count: ${Number(tick.stepCount || 0)}`);
    const producers = tick.producers || {};
    lines.push('  producers:');
    lines.push(`    total: ${Number(producers.total || 0)}`);
    lines.push(`    succeeded: ${Number(producers.succeeded || 0)}`);
    lines.push(`    failed: ${Number(producers.failed || 0)}`);
    lines.push(`    skipped: ${Number(producers.skipped || 0)}`);

    const planner = manifest.planner || {};
    lines.push('planner:');
    lines.push(`  mode: "${String(planner.mode || '').replace(/"/g, '\\"')}"`);
    lines.push(`  intent_class: "${String(planner.intentClass || '').replace(/"/g, '\\"')}"`);
    lines.push(`  context_shape: "${String(planner.contextShape || '').replace(/"/g, '\\"')}"`);
    lines.push(`  anchor_count: ${Number(planner.anchorCount || 0)}`);
    lines.push(`  operator_count: ${Number(planner.operatorCount || 0)}`);
    lines.push(`  requested_probe_count: ${Number(planner.requestedProbeCount || 0)}`);
    lines.push(`  stop_condition_count: ${Number(planner.stopConditionCount || 0)}`);

    const contextCompiler = manifest.contextCompiler || {};
    lines.push('context_compiler:');
    lines.push(`  packet_mode: "${String(contextCompiler.packetMode || '').replace(/"/g, '\\"')}"`);
    lines.push(`  packet_task: "${String(contextCompiler.packetTask || '').replace(/"/g, '\\"')}"`);
    lines.push(`  suggested_test_count: ${Number(contextCompiler.suggestedTestCount || 0)}`);
    lines.push(`  unresolved_proof_count: ${Number(contextCompiler.unresolvedProofCount || 0)}`);
    const telemetry = contextCompiler.telemetry || {};
    lines.push('  telemetry:');
    lines.push(`    total_runs: ${Number(telemetry.totalRuns || 0)}`);
    lines.push(`    average_useful_ratio: ${Number(telemetry.averageUsefulRatio || 0)}`);
    lines.push(`    average_proof_sufficiency: ${Number(telemetry.averageProofSufficiency || 0)}`);
    lines.push(`    last_run_at: "${String(telemetry.lastRunAt || '').replace(/"/g, '\\"')}"`);

    const experienceGovernor = manifest.experienceGovernor || {};
    lines.push('experience_governor:');
    lines.push(`  generated_at: "${String(experienceGovernor.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  card_count: ${Number(experienceGovernor.cardCount || 0)}`);
    lines.push(`  generated_count: ${Number(experienceGovernor.generatedCount || 0)}`);
    lines.push(`  retained_count: ${Number(experienceGovernor.retainedCount || 0)}`);
    lines.push(`  dropped_count: ${Number(experienceGovernor.droppedCount || 0)}`);
    lines.push(`  retrieved_count: ${Number(experienceGovernor.retrievedCount || 0)}`);

    const constraintGraph = manifest.constraintGraph || {};
    const constraintPatchGate = constraintGraph.patchGate || {};
    const constraintSolver = constraintGraph.solver || {};
    lines.push('constraint_graph:');
    lines.push(`  generated_at: "${String(constraintGraph.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  rule_count: ${Number(constraintGraph.ruleCount || 0)}`);
    lines.push(`  violation_count: ${Number(constraintGraph.violationCount || 0)}`);
    lines.push('  patch_gate:');
    lines.push(`    checked: ${Number(constraintPatchGate.checked || 0)}`);
    lines.push(`    blocked: ${Number(constraintPatchGate.blocked || 0)}`);
    lines.push(`    warned: ${Number(constraintPatchGate.warned || 0)}`);
    lines.push(`    requested_runtime_probe: ${Number(constraintPatchGate.requestedRuntimeProbe || 0)}`);
    lines.push(`    requested_targeted_tests: ${Number(constraintPatchGate.requestedTargetedTests || 0)}`);
    lines.push('  solver:');
    lines.push(`    pattern_checks: ${Number(constraintSolver.patternChecks || 0)}`);
    lines.push(`    finite_checks: ${Number(constraintSolver.finiteChecks || 0)}`);
    lines.push(`    cardinality_checks: ${Number(constraintSolver.cardinalityChecks || 0)}`);
    lines.push(`    forward_chain_inferences: ${Number(constraintSolver.forwardChainInferences || 0)}`);
    lines.push(`    contradictions: ${Number(constraintSolver.contradictions || 0)}`);

    const evalGraph = manifest.evalGraph || {};
    const evalTaskMiner = evalGraph.taskMiner || {};
    const evalGoldContextMiner = evalGraph.goldContextMiner || {};
    const evalCanaryHarness = evalGraph.canaryHarness || {};
    const evalRegressionTracking = evalGraph.regressionTracking || {};
    const evalMetrics = evalGraph.dashboardMetrics || {};
    const evalRetrieval = evalMetrics.retrieval || {};
    const evalNonFunctional = evalMetrics.nonFunctional || {};
    const evalLearning = evalMetrics.learning || {};
    const evalBaselines = evalGraph.baselines || {};
    lines.push('eval_graph:');
    lines.push(`  generated_at: "${String(evalGraph.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  store_path: "${String(evalGraph.storePath || '').replace(/"/g, '\\"')}"`);
    lines.push('  task_miner:');
    lines.push(`    mined: ${Number(evalTaskMiner.mined || 0)}`);
    lines.push(`    total: ${Number(evalTaskMiner.total || 0)}`);
    lines.push('  gold_context_miner:');
    lines.push(`    mined: ${Number(evalGoldContextMiner.mined || 0)}`);
    lines.push(`    total: ${Number(evalGoldContextMiner.total || 0)}`);
    lines.push(`    average_gold_files: ${Number(evalGoldContextMiner.averageGoldFiles || 0)}`);
    lines.push(`    average_required_constraints: ${Number(evalGoldContextMiner.averageRequiredConstraints || 0)}`);
    lines.push('  canary_harness:');
    lines.push(`    run_count: ${Number(evalCanaryHarness.runCount || 0)}`);
    lines.push(`    last_run_at: "${String(evalCanaryHarness.lastRunAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`    last_score: ${Number(evalCanaryHarness.lastScore || 0)}`);
    lines.push(`    pass_rate: ${Number(evalCanaryHarness.passRate || 0)}`);
    lines.push(`    regressions_detected: ${Number(evalCanaryHarness.regressionsDetected || 0)}`);
    lines.push(`    promotion_allowed: ${Boolean(evalCanaryHarness.promotionAllowed)}`);
    lines.push('  regression_tracking:');
    lines.push(`    open_regressions: ${Number(evalRegressionTracking.openRegressions || 0)}`);
    lines.push(`    new_regressions: ${Number(evalRegressionTracking.newRegressions || 0)}`);
    lines.push(`    resolved_regressions: ${Number(evalRegressionTracking.resolvedRegressions || 0)}`);
    lines.push('  dashboard_metrics:');
    lines.push('    retrieval:');
    lines.push(`      gold_context_recall: ${Number(evalRetrieval.goldContextRecall || 0)}`);
    lines.push(`      gold_context_precision: ${Number(evalRetrieval.goldContextPrecision || 0)}`);
    lines.push(`      proof_sufficiency: ${Number(evalRetrieval.proofSufficiency || 0)}`);
    lines.push(`      files_opened_per_solved_task: ${Number(evalRetrieval.filesOpenedPerSolvedTask || 0)}`);
    lines.push(`      tokens_per_useful_artifact: ${Number(evalRetrieval.tokensPerUsefulArtifact || 0)}`);
    lines.push('    non_functional:');
    lines.push(`      security_issue_miss_rate: ${Number(evalNonFunctional.securityIssueMissRate || 0)}`);
    lines.push(`      perf_regression_miss_rate: ${Number(evalNonFunctional.perfRegressionMissRate || 0)}`);
    lines.push(`      bad_dependency_decision_rate: ${Number(evalNonFunctional.badDependencyDecisionRate || 0)}`);
    lines.push('    learning:');
    lines.push(`      planner_uplift: ${Number(evalLearning.plannerUplift || 0)}`);
    lines.push(`      memory_card_utility: ${Number(evalLearning.memoryCardUtility || 0)}`);
    lines.push(`      operator_promotion_hit_rate: ${Number(evalLearning.operatorPromotionHitRate || 0)}`);
    lines.push(`      stale_memory_decay_correctness: ${Number(evalLearning.staleMemoryDecayCorrectness || 0)}`);
    lines.push('  baselines:');
    lines.push(`    v1_median_tokens_per_useful_artifact: ${Number(evalBaselines.v1MedianTokensPerUsefulArtifact || 0)}`);
    lines.push(`    source: "${String(evalBaselines.source || 'insufficient-history').replace(/"/g, '\\"')}"`);
    lines.push(`    sample_count: ${Number(evalBaselines.sampleCount || 0)}`);
    lines.push(`    window_size: ${Number(evalBaselines.windowSize || 0)}`);

    const distillation = manifest.distillationEngine || {};
    const distillationArtifacts = distillation.artifacts || {};
    const distillationBandit = distillation.plannerBandit || {};
    const distillationTestSelector = distillation.testSelector || {};
    const distillationPrecedentRanker = distillation.precedentRanker || {};
    const distillationRiskScorer = distillation.riskScorer || {};
    const distillationPromotion = distillation.promotion || {};
    lines.push('distillation_engine:');
    lines.push(`  generated_at: "${String(distillation.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  store_path: "${String(distillation.storePath || '').replace(/"/g, '\\"')}"`);
    lines.push(`  run_count: ${Number(distillation.runCount || 0)}`);
    lines.push('  artifacts:');
    lines.push(`    rankers: ${Number(distillationArtifacts.rankers || 0)}`);
    lines.push(`    planner_policies: ${Number(distillationArtifacts.plannerPolicies || 0)}`);
    lines.push(`    test_selectors: ${Number(distillationArtifacts.testSelectors || 0)}`);
    lines.push(`    precedent_rankers: ${Number(distillationArtifacts.precedentRankers || 0)}`);
    lines.push(`    risk_scorers: ${Number(distillationArtifacts.riskScorers || 0)}`);
    lines.push('  planner_bandit:');
    lines.push(`    explore_rate: ${Number(distillationBandit.exploreRate || 0)}`);
    lines.push(`    winning_policy: "${String(distillationBandit.winningPolicy || '').replace(/"/g, '\\"')}"`);
    lines.push(`    expected_reward: ${Number(distillationBandit.expectedReward || 0)}`);
    lines.push(`    policy_arm_count: ${Array.isArray(distillationBandit.policyArms) ? distillationBandit.policyArms.length : 0}`);
    lines.push('  test_selector:');
    lines.push(`    candidate_count: ${Number(distillationTestSelector.candidateCount || 0)}`);
    lines.push(`    selected_count: ${Array.isArray(distillationTestSelector.selected) ? distillationTestSelector.selected.length : 0}`);
    lines.push(`    estimated_recall: ${Number(distillationTestSelector.estimatedRecall || 0)}`);
    lines.push('  precedent_ranker:');
    lines.push(`    candidate_count: ${Number(distillationPrecedentRanker.candidateCount || 0)}`);
    lines.push(`    top_count: ${Array.isArray(distillationPrecedentRanker.topPrecedents) ? distillationPrecedentRanker.topPrecedents.length : 0}`);
    lines.push(`    confidence: ${Number(distillationPrecedentRanker.confidence || 0)}`);
    lines.push('  risk_scorer:');
    lines.push(`    score: ${Number(distillationRiskScorer.score || 0)}`);
    lines.push(`    level: "${String(distillationRiskScorer.level || '').replace(/"/g, '\\"')}"`);
    lines.push(`    driver_count: ${Array.isArray(distillationRiskScorer.drivers) ? distillationRiskScorer.drivers.length : 0}`);
    lines.push('  promotion:');
    lines.push(`    shadow_ready: ${Boolean(distillationPromotion.shadowReady)}`);
    lines.push(`    canary_eligible: ${Boolean(distillationPromotion.canaryEligible)}`);
    lines.push(`    promoted: ${Boolean(distillationPromotion.promoted)}`);
    lines.push(`    rollback_ready: ${Boolean(distillationPromotion.rollbackReady)}`);

    const toolsmith = manifest.toolsmith || {};
    const toolsmithMiner = toolsmith.miner || {};
    const toolsmithSynthesis = toolsmith.synthesis || {};
    const toolsmithImplementationKinds = toolsmithSynthesis.implementationKinds || {};
    const toolsmithSandbox = toolsmith.sandbox || {};
    const toolsmithPromotion = toolsmith.promotion || {};
    const toolsmithGuardrails = toolsmithPromotion.guardrails || {};
    lines.push('toolsmith:');
    lines.push(`  generated_at: "${String(toolsmith.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  store_path: "${String(toolsmith.storePath || '').replace(/"/g, '\\"')}"`);
    lines.push(`  run_count: ${Number(toolsmith.runCount || 0)}`);
    lines.push('  miner:');
    lines.push(`    sequence_count: ${Number(toolsmithMiner.sequenceCount || 0)}`);
    lines.push(`    top_sequence_count: ${Array.isArray(toolsmithMiner.topSequences) ? toolsmithMiner.topSequences.length : 0}`);
    lines.push('  synthesis:');
    lines.push(`    candidates_generated: ${Number(toolsmithSynthesis.candidatesGenerated || 0)}`);
    lines.push(`    artifacts_total: ${Number(toolsmithSynthesis.artifactsTotal || 0)}`);
    lines.push(`    typed_operators: ${Number(toolsmithSynthesis.typedOperators || 0)}`);
    lines.push('    implementation_kinds:');
    lines.push(`      cypher: ${Number(toolsmithImplementationKinds.cypher || 0)}`);
    lines.push(`      pipeline: ${Number(toolsmithImplementationKinds.pipeline || 0)}`);
    lines.push(`      composite: ${Number(toolsmithImplementationKinds.composite || 0)}`);
    lines.push('  sandbox:');
    lines.push(`    profile: "${String(toolsmithSandbox.profile || '').replace(/"/g, '\\"')}"`);
    lines.push(`    approved: ${Number(toolsmithSandbox.approved || 0)}`);
    lines.push(`    pending: ${Number(toolsmithSandbox.pending || 0)}`);
    lines.push(`    rejected: ${Number(toolsmithSandbox.rejected || 0)}`);
    lines.push('  promotion:');
    lines.push(`    eligible: ${Number(toolsmithPromotion.eligible || 0)}`);
    lines.push(`    promoted: ${Number(toolsmithPromotion.promoted || 0)}`);
    lines.push(`    rolled_back: ${Number(toolsmithPromotion.rolledBack || 0)}`);
    lines.push('    guardrails:');
    lines.push(`      deterministic_tests: ${Boolean(toolsmithGuardrails.deterministicTests)}`);
    lines.push(`      eval_canary: ${Boolean(toolsmithGuardrails.evalCanary)}`);
    lines.push(`      security_policy: ${Boolean(toolsmithGuardrails.securityPolicy)}`);
    lines.push(`      capability_safe: ${Boolean(toolsmithGuardrails.capabilitySafe)}`);
    lines.push(`      proof_carrying: ${Boolean(toolsmithGuardrails.proofCarrying)}`);

    const graphModelBridge = manifest.graphModelBridge || {};
    const bridgeCoverage = graphModelBridge.coverage || {};
    const bridgePromotion = graphModelBridge.promotion || {};
    const bridgeLearned = graphModelBridge.learned || {};
    lines.push('graph_model_bridge:');
    lines.push(`  generated_at: "${String(graphModelBridge.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  store_path: "${String(graphModelBridge.storePath || '').replace(/"/g, '\\"')}"`);
    lines.push(`  run_count: ${Number(graphModelBridge.runCount || 0)}`);
    lines.push(`  packet_count: ${Number(graphModelBridge.packetCount || 0)}`);
    lines.push(`  latest_packet_count: ${Number(graphModelBridge.latestPacketCount || 0)}`);
    lines.push('  coverage:');
    lines.push(`    slice_backed: ${Number(bridgeCoverage.sliceBacked || 0)}`);
    lines.push(`    proof_backed: ${Number(bridgeCoverage.proofBacked || 0)}`);
    lines.push(`    avg_proof_hashes: ${Number(bridgeCoverage.avgProofHashes || 0)}`);
    lines.push('  promotion:');
    lines.push(`    symbolic_enabled: ${Boolean(bridgePromotion.symbolicEnabled)}`);
    lines.push(`    learned_candidate_ready: ${Boolean(bridgePromotion.learnedCandidateReady)}`);
    lines.push('  learned:');
    lines.push(`    mode: "${String(bridgeLearned.mode || '').replace(/"/g, '\\"')}"`);
    lines.push(`    model_path: "${String(bridgeLearned.modelPath || '').replace(/"/g, '\\"')}"`);
    lines.push(`    model_version: "${String(bridgeLearned.modelVersion || '').replace(/"/g, '\\"')}"`);
    lines.push(`    trained_at: "${String(bridgeLearned.trainedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`    training_packet_count: ${Number(bridgeLearned.trainingPacketCount || 0)}`);
    lines.push(`    shadow_prediction_count: ${Number(bridgeLearned.shadowPredictionCount || 0)}`);
    lines.push(`    average_confidence: ${Number(bridgeLearned.averageConfidence || 0)}`);

    const runtimeTruth = manifest.runtimeTruth || {};
    const runtimeSnapshot = runtimeTruth.snapshot || {};
    const runtimeCompressed = runtimeTruth.compressed || {};
    const runtimeReconciliation = runtimeTruth.reconciliation || {};
    lines.push('runtime_truth:');
    lines.push(`  generated_at: "${String(runtimeTruth.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  source_file_count: ${Number(runtimeTruth.sourceFileCount || 0)}`);
    lines.push(`  probe_count: ${Number(runtimeTruth.probeCount || 0)}`);
    lines.push('  snapshot:');
    lines.push(`    request_spans: ${Number(runtimeSnapshot.requestSpans || 0)}`);
    lines.push(`    db_queries: ${Number(runtimeSnapshot.dbQueries || 0)}`);
    lines.push(`    payload_shapes: ${Number(runtimeSnapshot.payloadShapes || 0)}`);
    lines.push('  compressed:');
    lines.push(`    witness_cards: ${Number(runtimeCompressed.witnessCards || 0)}`);
    lines.push(`    observed_loops: ${Number(runtimeCompressed.observedLoops || 0)}`);
    lines.push(`    contradiction_witnesses: ${Number(runtimeCompressed.contradictionWitnesses || 0)}`);
    lines.push(`    coverage_witnesses: ${Number(runtimeCompressed.coverageWitnesses || 0)}`);
    lines.push('  reconciliation:');
    lines.push(`    supports_static_edge: ${Number(runtimeReconciliation.supportsStaticEdge || 0)}`);
    lines.push(`    fills_static_gap: ${Number(runtimeReconciliation.fillsStaticGap || 0)}`);
    lines.push(`    contradicts_static_expectation: ${Number(runtimeReconciliation.contradictsStaticExpectation || 0)}`);
    lines.push(`    reveals_hidden_dynamic_branch: ${Number(runtimeReconciliation.revealsHiddenDynamicBranch || 0)}`);
    lines.push(`    reveals_dead_static_only_path: ${Number(runtimeReconciliation.revealsDeadStaticOnlyPath || 0)}`);

    const reviewRuntimeProbes = manifest.reviewRuntimeProbes || {};
    const reviewRuntimeTriggers = Array.isArray(reviewRuntimeProbes.triggers) ? reviewRuntimeProbes.triggers : [];
    lines.push('review_runtime_probes:');
    lines.push(`  generated_at: "${String(reviewRuntimeProbes.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push(`  runtime_source: "${String(reviewRuntimeProbes.runtimeSource || '').replace(/"/g, '\\"')}"`);
    lines.push(`  request_count: ${Number(reviewRuntimeProbes.requestCount || 0)}`);
    lines.push(`  high_priority_count: ${Number(reviewRuntimeProbes.highPriorityCount || 0)}`);
    lines.push('  triggers:');
    if (reviewRuntimeTriggers.length === 0) {
      lines.push('    []');
    } else {
      for (const trigger of reviewRuntimeTriggers.slice(0, 12)) {
        lines.push(`    - "${String(trigger || '').replace(/"/g, '\\"')}"`);
      }
    }

    const v2Parity = manifest.v2Parity || {};
    const v2Overall = v2Parity.overall || {};
    const v2Pillars = v2Parity.pillars || {};
    const v2Blockers = Array.isArray(v2Parity.blockers) ? v2Parity.blockers : [];
    const pillarOrder = ['query', 'review', 'implement', 'debug', 'self_feedback'];
    lines.push('v2_parity:');
    lines.push(`  generated_at: "${String(v2Parity.generatedAt || '').replace(/"/g, '\\"')}"`);
    lines.push('  overall:');
    lines.push(`    ready: ${Boolean(v2Overall.ready)}`);
    lines.push(`    score: ${Number(v2Overall.score || 0)}`);
    lines.push(`    met: ${Number(v2Overall.met || 0)}`);
    lines.push(`    partial: ${Number(v2Overall.partial || 0)}`);
    lines.push(`    missing: ${Number(v2Overall.missing || 0)}`);
    lines.push(`    unverified: ${Number(v2Overall.unverified || 0)}`);
    lines.push(`    total: ${Number(v2Overall.total || 0)}`);
    lines.push('  pillars:');
    for (const pillarName of pillarOrder) {
      const pillar = (v2Pillars as any)[pillarName] || {};
      lines.push(`    ${pillarName}:`);
      lines.push(`      score: ${Number(pillar.score || 0)}`);
      lines.push(`      met: ${Number(pillar.met || 0)}`);
      lines.push(`      partial: ${Number(pillar.partial || 0)}`);
      lines.push(`      missing: ${Number(pillar.missing || 0)}`);
      lines.push(`      unverified: ${Number(pillar.unverified || 0)}`);
      lines.push(`      total: ${Number(pillar.total || 0)}`);
    }
    lines.push(`  blocker_count: ${v2Blockers.length}`);
    lines.push('  blockers:');
    if (v2Blockers.length === 0) {
      lines.push('    []');
    } else {
      for (const blocker of v2Blockers.slice(0, 12)) {
        lines.push(`    - "${String(blocker || '').replace(/"/g, '\\"')}"`);
      }
    }

    lines.push('active_producer_versions:');
    const activeProducerVersions = manifest.activeProducerVersions || {};
    for (const [producerId, version] of Object.entries(activeProducerVersions)) {
      lines.push(`  ${producerId}: "${String(version || '').replace(/"/g, '\\"')}"`);
    }
    if (Object.keys(activeProducerVersions).length === 0) {
      lines.push('  {}');
    }

    lines.push('warnings:');
    const warnings = Array.isArray(manifest.warnings) ? manifest.warnings : [];
    for (const warning of warnings.slice(0, 20)) {
      lines.push(`  - "${String(warning || '').replace(/"/g, '\\"')}"`);
    }
    if (warnings.length === 0) {
      lines.push('  []');
    }

    return lines.join('\n');
  } catch {
    return 'error: Brain manifest not found. Run: gitnexus analyze';
  }
}

async function getEpisodeResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.queryEpisodeState(repoName, { limit: 15, include_events: true });
    const episode = result?.episode || {};

    const lines: string[] = [];
    lines.push(`status: "${result?.status || 'ok'}"`);
    lines.push(`repo: "${String(result?.repo || repoName || '').replace(/"/g, '\\"')}"`);
    lines.push(`updated_at: "${String(episode.updated_at || '').replace(/"/g, '\\"')}"`);

    const target = episode.target || {};
    lines.push('target:');
    lines.push(`  branch: "${String(target.branch || '').replace(/"/g, '\\"')}"`);
    lines.push(`  taskId: "${String(target.taskId || '').replace(/"/g, '\\"')}"`);
    lines.push(`  updatedAt: "${String(target.updatedAt || '').replace(/"/g, '\\"')}"`);

    const counts = episode.counts || {};
    lines.push('counts:');
    lines.push(`  nodes: ${Number(counts.nodes || 0)}`);
    lines.push(`  edges: ${Number(counts.edges || 0)}`);
    lines.push(`  hypotheses: ${Number(counts.hypotheses || 0)}`);
    lines.push(`  failing_tests: ${Number(counts.failing_tests || 0)}`);
    lines.push(`  errors: ${Number(counts.errors || 0)}`);
    lines.push(`  edit_set: ${Number(counts.edit_set || 0)}`);
    lines.push(`  witness_paths: ${Number(counts.witness_paths || 0)}`);
    lines.push(`  precedents: ${Number(counts.precedents || 0)}`);
    lines.push(`  events: ${Number(counts.events || 0)}`);

    lines.push('recent_symbols:');
    for (const symbol of Array.isArray(episode.recent_symbols) ? episode.recent_symbols.slice(0, 15) : []) {
      lines.push(`  - symbolId: "${String(symbol.symbolId || '').replace(/"/g, '\\"')}"`);
      lines.push(`    name: "${String(symbol.name || '').replace(/"/g, '\\"')}"`);
      lines.push(`    filePath: "${String(symbol.filePath || '').replace(/"/g, '\\"')}"`);
      lines.push(`    startLine: ${Number(symbol.startLine || 0)}`);
      lines.push(`    lastSeenAt: "${String(symbol.lastSeenAt || '').replace(/"/g, '\\"')}"`);
      lines.push(`    count: ${Number(symbol.count || 0)}`);
    }

    lines.push('edit_set:');
    for (const filePath of Array.isArray(episode.edit_set) ? episode.edit_set.slice(0, 20) : []) {
      lines.push(`  - "${String(filePath || '').replace(/"/g, '\\"')}"`);
    }

    lines.push('witness_paths:');
    for (const witness of Array.isArray(episode.witness_paths) ? episode.witness_paths.slice(0, 20) : []) {
      lines.push(`  - "${String(witness || '').replace(/"/g, '\\"')}"`);
    }

    lines.push('hypotheses:');
    for (const item of Array.isArray(episode.hypotheses) ? episode.hypotheses.slice(0, 20) : []) {
      lines.push(`  - text: "${String(item.text || '').replace(/"/g, '\\"')}"`);
      lines.push(`    status: "${String(item.status || '').replace(/"/g, '\\"')}"`);
      lines.push(`    lastSeenAt: "${String(item.lastSeenAt || '').replace(/"/g, '\\"')}"`);
      lines.push(`    count: ${Number(item.count || 0)}`);
    }

    lines.push('errors:');
    for (const value of Array.isArray(episode.errors) ? episode.errors.slice(0, 20) : []) {
      lines.push(`  - "${String(value || '').replace(/"/g, '\\"')}"`);
    }

    lines.push('failing_tests:');
    for (const value of Array.isArray(episode.failing_tests) ? episode.failing_tests.slice(0, 20) : []) {
      lines.push(`  - "${String(value || '').replace(/"/g, '\\"')}"`);
    }

    return lines.join('\n');
  } catch (err: any) {
    return `error: ${String(err?.message || err || 'failed to read episode state')}`;
  }
}

async function getEvidenceResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.callTool('evidence_spans', { repo: repoName, limit: 25, include_nodes: true, include_edges: true });
    const evidence = result?.evidence || {};
    const stats = evidence?.stats || {};
    const lines: string[] = [];

    lines.push(`status: "${String(result?.status || 'ok').replace(/"/g, '\\"')}"`);
    lines.push(`repo: "${String(result?.repo || repoName || '').replace(/"/g, '\\"')}"`);
    lines.push(`updated_at: "${String(evidence?.updated_at || '').replace(/"/g, '\\"')}"`);
    lines.push('stats:');
    lines.push(`  node_evidence: ${Number(stats.nodeEvidenceCount || 0)}`);
    lines.push(`  edge_evidence: ${Number(stats.edgeEvidenceCount || 0)}`);
    lines.push(`  unique_files: ${Number(stats.uniqueFiles || 0)}`);
    lines.push(`  primary_spans: ${Number(stats.primarySpanCount || 0)}`);
    lines.push(`  witness_spans: ${Number(stats.witnessSpanCount || 0)}`);
    lines.push(`  proof_spans: ${Number(stats.proofSpanCount || 0)}`);

    lines.push('nodes:');
    for (const node of Array.isArray(evidence?.nodes) ? evidence.nodes.slice(0, 25) : []) {
      lines.push(`  - nodeId: "${String(node.nodeId || '').replace(/"/g, '\\"')}"`);
      lines.push(`    label: "${String(node.nodeLabel || '').replace(/"/g, '\\"')}"`);
      lines.push(`    name: "${String(node.nodeName || '').replace(/"/g, '\\"')}"`);
      lines.push(`    span: "${String(node?.primarySpan?.filePath || '').replace(/"/g, '\\"')}:${Number(node?.primarySpan?.startLine || 0)}:${Number(node?.primarySpan?.endLine || 0)}"`);
    }

    lines.push('edges:');
    for (const edge of Array.isArray(evidence?.edges) ? evidence.edges.slice(0, 25) : []) {
      lines.push(`  - edgeId: "${String(edge.edgeId || '').replace(/"/g, '\\"')}"`);
      lines.push(`    type: "${String(edge.relationType || '').replace(/"/g, '\\"')}"`);
      lines.push(`    sourceId: "${String(edge.sourceId || '').replace(/"/g, '\\"')}"`);
      lines.push(`    targetId: "${String(edge.targetId || '').replace(/"/g, '\\"')}"`);
      lines.push(`    witness_count: ${Array.isArray(edge.witnessSpans) ? edge.witnessSpans.length : 0}`);
      lines.push(`    proof_count: ${Array.isArray(edge.proofSpans) ? edge.proofSpans.length : 0}`);
      lines.push(`    reason: "${String(edge.reason || '').replace(/"/g, '\\"')}"`);
    }

    return lines.join('\n');
  } catch (err: any) {
    return `error: ${String(err?.message || err || 'failed to read evidence spans')}`;
  }
}

async function getSummariesResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.callTool('summary_overlay', { repo: repoName, limit: 12 });
    const summaries = result?.summaries || {};
    const stats = summaries?.stats || {};
    const levels = summaries?.levels || {};
    const lines: string[] = [];

    lines.push(`status: "${String(result?.status || 'ok').replace(/"/g, '\\"')}"`);
    lines.push(`repo: "${String(result?.repo || repoName || '').replace(/"/g, '\\"')}"`);
    lines.push(`updated_at: "${String(summaries?.updated_at || '').replace(/"/g, '\\"')}"`);
    lines.push('stats:');
    lines.push(`  symbol_count: ${Number(stats.symbolCount || 0)}`);
    lines.push(`  file_count: ${Number(stats.fileCount || 0)}`);
    lines.push(`  slice_count: ${Number(stats.sliceCount || 0)}`);
    lines.push(`  community_count: ${Number(stats.communityCount || 0)}`);
    lines.push(`  process_count: ${Number(stats.processCount || 0)}`);
    lines.push(`  archetype_count: ${Number(stats.archetypeCount || 0)}`);
    lines.push(`  truncated_symbols: ${Boolean(stats?.truncated?.symbols)}`);
    lines.push(`  truncated_files: ${Boolean(stats?.truncated?.files)}`);
    lines.push(`  truncated_slices: ${Boolean(stats?.truncated?.slices)}`);
    lines.push(`  truncated_communities: ${Boolean(stats?.truncated?.communities)}`);
    lines.push(`  truncated_processes: ${Boolean(stats?.truncated?.processes)}`);
    lines.push(`  truncated_archetypes: ${Boolean(stats?.truncated?.archetypes)}`);

    const levelNames = ['symbol', 'file', 'slice', 'community', 'process', 'archetype'];
    for (const levelName of levelNames) {
      const entries = Array.isArray(levels?.[levelName]) ? levels[levelName] : [];
      lines.push(`${levelName}s:`);
      for (const entry of entries.slice(0, 12)) {
        lines.push(`  - entityId: "${String(entry.entityId || '').replace(/"/g, '\\"')}"`);
        lines.push(`    name: "${String(entry.name || '').replace(/"/g, '\\"')}"`);
        lines.push(`    filePath: "${String(entry.filePath || '').replace(/"/g, '\\"')}"`);
        lines.push(`    responsibilities: ${Array.isArray(entry.responsibilities) ? entry.responsibilities.length : 0}`);
        lines.push(`    inbound: ${Array.isArray(entry.inboundCallers) ? entry.inboundCallers.length : 0}`);
        lines.push(`    downstream: ${Array.isArray(entry.downstreamEffects) ? entry.downstreamEffects.length : 0}`);
      }
    }

    return lines.join('\n');
  } catch (err: any) {
    return `error: ${String(err?.message || err || 'failed to read summary overlays')}`;
  }
}

async function getClosureTemplatesResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.callTool('closure_templates', { repo: repoName, limit: 20 });
    const templates = result?.templates || {};
    const stats = templates?.stats || {};
    const rows = Array.isArray(templates?.templates) ? templates.templates : [];
    const lines: string[] = [];

    lines.push(`status: "${String(result?.status || 'ok').replace(/"/g, '\\"')}"`);
    lines.push(`repo: "${String(result?.repo || repoName || '').replace(/"/g, '\\"')}"`);
    lines.push(`updated_at: "${String(templates?.updated_at || '').replace(/"/g, '\\"')}"`);
    lines.push('stats:');
    lines.push(`  total_templates: ${Number(stats.totalTemplates || 0)}`);
    lines.push(`  total_slices: ${Number(stats.totalSlices || 0)}`);
    lines.push(`  total_covered_slots: ${Number(stats.totalCoveredSlots || 0)}`);
    lines.push(`  total_role_expectations: ${Number(stats.totalRoleExpectations || 0)}`);
    lines.push('templates:');
    for (const template of rows.slice(0, 20)) {
      lines.push(`  - id: "${String(template.id || '').replace(/"/g, '\\"')}"`);
      lines.push(`    templateKey: "${String(template.templateKey || '').replace(/"/g, '\\"')}"`);
      lines.push(`    sliceType: "${String(template.sliceType || '').replace(/"/g, '\\"')}"`);
      lines.push(`    requiredSlots: ${Array.isArray(template.requiredSlots) ? template.requiredSlots.length : 0}`);
      lines.push(`    optionalSlots: ${Array.isArray(template.optionalSlots) ? template.optionalSlots.length : 0}`);
      lines.push(`    roleCoverage: ${Array.isArray(template.roleCoverage) ? template.roleCoverage.length : 0}`);
      lines.push(`    sliceCount: ${Number(template.sliceCount || 0)}`);
      lines.push(`    avgClosureScore: ${Number(template.avgClosureScore || 0)}`);
    }

    return lines.join('\n');
  } catch (err: any) {
    return `error: ${String(err?.message || err || 'failed to read closure templates')}`;
  }
}

/**
 * Clusters resource — queries graph directly via backend.queryClusters()
 */
async function getClustersResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.queryClusters(repoName, 100);

    if (!result.clusters || result.clusters.length === 0) {
      return 'modules: []\n# No functional areas detected. Run: gitnexus analyze';
    }

    const displayLimit = 20;
    const lines: string[] = ['modules:'];
    const toShow = result.clusters.slice(0, displayLimit);

    for (const cluster of toShow) {
      const label = cluster.heuristicLabel || cluster.label || cluster.id;
      lines.push(`  - name: "${label}"`);
      lines.push(`    symbols: ${cluster.symbolCount || 0}`);
      if (cluster.cohesion) {
        lines.push(`    cohesion: ${(cluster.cohesion * 100).toFixed(0)}%`);
      }
    }

    if (result.clusters.length > displayLimit) {
      lines.push(`\n# Showing top ${displayLimit} of ${result.clusters.length} modules. Use query() for deeper search.`);
    }

    return lines.join('\n');
  } catch (err: any) {
    return `error: ${err.message}`;
  }
}

/**
 * Processes resource — queries graph directly via backend.queryProcesses()
 */
async function getProcessesResource(backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.queryProcesses(repoName, 50);

    if (!result.processes || result.processes.length === 0) {
      return 'processes: []\n# No processes detected. Run: gitnexus analyze';
    }

    const displayLimit = 20;
    const lines: string[] = ['processes:'];
    const toShow = result.processes.slice(0, displayLimit);

    for (const proc of toShow) {
      const label = proc.heuristicLabel || proc.label || proc.id;
      lines.push(`  - name: "${label}"`);
      lines.push(`    type: ${proc.processType || 'unknown'}`);
      lines.push(`    steps: ${proc.stepCount || 0}`);
    }

    if (result.processes.length > displayLimit) {
      lines.push(`\n# Showing top ${displayLimit} of ${result.processes.length} processes. Use query() for deeper search.`);
    }

    return lines.join('\n');
  } catch (err: any) {
    return `error: ${err.message}`;
  }
}

/**
 * Archetypes resource — derived overview of common flow signatures.
 */
async function getArchetypesResource(backend: LocalBackend, repoName?: string): Promise<string> {
  const { report } = await backend.queryArchetypes(repoName, { limit: 20, examplesPerSignature: 1 });

  const lines: string[] = [
    `generatedAt: "${report.generatedAt}"`,
    `totalProcesses: ${report.totalProcesses}`,
    `uniqueSignatures: ${report.uniqueSignatures}`,
    'signatures:',
  ];

  for (const sig of report.signatures) {
    lines.push(`  - signature: "${sig.signature.replace(/"/g, '\\"')}"`);
    lines.push(`    count: ${sig.count}`);
    lines.push(`    crossStack: ${sig.crossStack}`);

    if (sig.topHttpRoutes.length > 0) {
      lines.push('    topHttpRoutes:');
      for (const route of sig.topHttpRoutes.slice(0, 5)) {
        lines.push(`      - route: "${String(route.route).replace(/"/g, '\\"')}"`);
        lines.push(`        count: ${route.count}`);
      }
    }

    const ex = sig.exampleProcesses[0];
    if (ex) {
      lines.push('    example:');
      lines.push(`      processId: "${String(ex.processId).replace(/"/g, '\\"')}"`);
      lines.push(`      label: "${String(ex.label).replace(/"/g, '\\"')}"`);
      lines.push(`      stepCount: ${ex.stepCount}`);
      lines.push('      entry:');
      lines.push(`        name: "${String(ex.entry.name).replace(/"/g, '\\"')}"`);
      lines.push(`        filePath: "${String(ex.entry.filePath).replace(/"/g, '\\"')}"`);
      lines.push(`        type: "${String(ex.entry.type).replace(/"/g, '\\"')}"`);
      lines.push('      terminal:');
      lines.push(`        name: "${String(ex.terminal.name).replace(/"/g, '\\"')}"`);
      lines.push(`        filePath: "${String(ex.terminal.filePath).replace(/"/g, '\\"')}"`);
      lines.push(`        type: "${String(ex.terminal.type).replace(/"/g, '\\"')}"`);

      if (ex.httpRoutes.length > 0) {
        lines.push('      httpRoutes:');
        for (const route of ex.httpRoutes.slice(0, 5)) {
          lines.push(`        - "${String(route).replace(/"/g, '\\"')}"`);
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Schema resource — graph structure for Cypher queries
 */
function getSchemaResource(): string {
  return `# GitNexus Graph Schema

nodes:
  - File: Source code files
  - Folder: Directory containers
  - Function: Functions and arrow functions
  - Class: Class definitions
  - Interface: Interface/type definitions
  - Method: Class methods
  - CodeElement: Catch-all for other code elements
  - Community: Auto-detected functional area (Leiden algorithm)
  - Process: Execution flow trace
  - FeatureSlice: Closure-oriented vertical feature capsule
  - Gap: First-class absence signal linked to FeatureSlice
  - ContractShape: Field/payload contract container
  - ContractField: Field-level contract node
  - CacheKey: Query/cache key contract node
  - DBTable: Storage table contract node
  - DBColumn: Storage column contract node
  - ValueNode: Literal/value contract node (permission/endpoint/route/cache signals)
  - TestCase: Static test case node linked to shape coverage

additional_node_types: "Multi-language: Struct, Enum, Macro, Typedef, Union, Namespace, Trait, Impl, TypeAlias, Const, Static, Property, Record, Delegate, Annotation, Constructor, Template, Module (use backticks in queries: \`Struct\`, \`Enum\`, etc.)"

relationships:
  - CONTAINS: File/Folder contains child
  - CO_CHANGES_WITH: Historical git cochange affinity between files (empirical signal)
  - DEFINES: File defines a symbol
  - CALLS: Function/method invocation
  - IMPORTS: Module imports
  - EXTENDS: Class inheritance
  - IMPLEMENTS: Interface implementation
  - MEMBER_OF: Symbol/group membership (Community, FeatureSlice, ContractShape, DBTable) and Gap nodes attach to slices
  - STEP_IN_PROCESS: Symbol is step N in process
  - VALIDATES_FIELD: Validator/source defines field validation contract
  - SERIALIZES_FIELD: Resource/source serializes a contract field
  - READS_FIELD: Consumer reads a contract field
  - WRITES_FIELD: Writer mutates a contract field
  - DERIVES_FROM: Derived/generated artifact provenance edge to source-of-truth symbol/file
  - DERIVES_FROM_COLUMN: Field derives from storage column
  - INVALIDATES_KEY: Mutation/invalidation source invalidates cache key
  - TESTS_SHAPE: Test case asserts contract shape behavior

relationship_table: "All relationships use a single CodeRelation table with a 'type' property. Properties: type (STRING), confidence (DOUBLE), reason (STRING), step (INT32), certaintyTier (STRING), provenanceFamily (STRING), absenceSemantics (STRING), witnessPathIds (STRING)"
provenance_reason_prefixes: "precision-overlay:* marks stack-graph/SCIP/LSP-derived relation overlays; value-graph:* marks literal/value graph overlays; provenance:* marks generated/derived artifact ancestry edges; native parser/framework edges keep existing reason families."
sidecars:
  - EpisodeGraph: "gitnexus://repo/{name}/episode (working-memory overlay)"
  - EvidenceSpan: "gitnexus://repo/{name}/evidence (line-level primary/witness/proof spans)"
  - SummaryOverlay: "gitnexus://repo/{name}/summaries (structured hierarchical overlays)"
  - ClosureTemplate: "gitnexus://repo/{name}/closure-templates (slice-family closure expectations)"

example_queries:
  find_callers: |
    MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
    RETURN caller.name, caller.filePath
  
  find_community_members: |
    MATCH (s)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
    WHERE c.heuristicLabel = "Auth"
    RETURN s.name, labels(s) AS type
  
  trace_process: |
    MATCH (s)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
    WHERE p.heuristicLabel = "LoginFlow"
    RETURN s.name, r.step
    ORDER BY r.step
`;
}

/**
 * Cluster detail resource — queries graph directly via backend.queryClusterDetail()
 */
async function getClusterDetailResource(name: string, backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.queryClusterDetail(name, repoName);

    if (result.error) {
      return `error: ${result.error}`;
    }

    const cluster = result.cluster;
    const members = result.members || [];

    const lines: string[] = [
      `module: "${cluster.heuristicLabel || cluster.label || cluster.id}"`,
      `symbols: ${cluster.symbolCount || members.length}`,
    ];

    if (cluster.cohesion) {
      lines.push(`cohesion: ${(cluster.cohesion * 100).toFixed(0)}%`);
    }

    if (members.length > 0) {
      lines.push('');
      lines.push('members:');
      for (const member of members.slice(0, 20)) {
        lines.push(`  - name: ${member.name}`);
        lines.push(`    type: ${member.type}`);
        lines.push(`    file: ${member.filePath}`);
      }
      if (members.length > 20) {
        lines.push(`  # ... and ${members.length - 20} more`);
      }
    }

    return lines.join('\n');
  } catch (err: any) {
    return `error: ${err.message}`;
  }
}

/**
 * Process detail resource — queries graph directly via backend.queryProcessDetail()
 */
async function getProcessDetailResource(name: string, backend: LocalBackend, repoName?: string): Promise<string> {
  try {
    const result = await backend.queryProcessDetail(name, repoName);

    if (result.error) {
      return `error: ${result.error}`;
    }

    const proc = result.process;
    const steps = result.steps || [];

    const lines: string[] = [
      `name: "${proc.heuristicLabel || proc.label || proc.id}"`,
      `type: ${proc.processType || 'unknown'}`,
      `step_count: ${proc.stepCount || steps.length}`,
    ];

    if (steps.length > 0) {
      lines.push('');
      lines.push('trace:');
      for (const step of steps) {
        lines.push(`  ${step.step}: ${step.name} (${step.filePath})`);
      }
    }

    return lines.join('\n');
  } catch (err: any) {
    return `error: ${err.message}`;
  }
}

/**
 * Setup resource — generates AGENTS.md content for all indexed repos.
 * Useful for `gitnexus setup` onboarding or dynamic content injection.
 */
async function getSetupResource(backend: LocalBackend): Promise<string> {
  const repos = backend.listRepos();
  
  if (repos.length === 0) {
    return '# GitNexus\n\nNo repositories indexed. Run: `gitnexus analyze` in a repository.';
  }
  
  const sections: string[] = [];
  
  for (const repo of repos) {
    const stats = repo.stats || {};
    const lines = [
      `# GitNexus MCP — ${repo.name}`,
      '',
      `This project is indexed by GitNexus as **${repo.name}** (${stats.nodes || 0} symbols, ${stats.edges || 0} relationships, ${stats.processes || 0} execution flows).`,
      '',
      '## Tools',
      '',
      '| Tool | What it gives you |',
      '|------|-------------------|',
      '| `query` | Process-grouped code intelligence — execution flows related to a concept |',
      '| `archetypes` | Derived flow signatures + exemplar processes (pattern heat map) |',
      '| `precedents` | Precedent/template finder — slice-first exemplars with hop/process fallback |',
      '| `context` | 360-degree symbol view — categorized refs, processes it participates in |',
      '| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |',
      '| `detect_changes` | Git-diff impact — what do your current changes affect |',
      '| `evidence_spans` | Read EvidenceSpan sidecar line-level proof/witness ranges |',
      '| `summary_overlay` | Read structured hierarchical summary overlays |',
      '| `closure_templates` | Read closure-template overlays for slice families |',
      '| `rename` | Multi-file coordinated rename with confidence-tagged edits |',
      '| `cypher` | Raw graph queries |',
      '| `list_repos` | Discover indexed repos |',
      '',
      '> Tip: If `context`/`impact` returns `status: ambiguous`, rerun with `uid` or `file_path` to disambiguate.',
      '',
      '## Resources',
      '',
      `- \`gitnexus://repo/${repo.name}/context\` — Stats, staleness check`,
      `- \`gitnexus://repo/${repo.name}/clusters\` — All functional areas`,
      `- \`gitnexus://repo/${repo.name}/brain\` — BrainKernel manifest`,
      `- \`gitnexus://repo/${repo.name}/processes\` — All execution flows`,
      `- \`gitnexus://repo/${repo.name}/archetypes\` — Derived flow signatures + exemplar processes`,
      `- \`gitnexus://repo/${repo.name}/schema\` — Graph schema for Cypher`,
      `- \`gitnexus://repo/${repo.name}/evidence\` — EvidenceSpan sidecar summary`,
      `- \`gitnexus://repo/${repo.name}/summaries\` — Structured summary overlays`,
      `- \`gitnexus://repo/${repo.name}/closure-templates\` — Closure-template overlays`,
    ];
    sections.push(lines.join('\n'));
  }
  
  return sections.join('\n\n---\n\n');
}
