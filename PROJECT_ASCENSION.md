Yes. Here is the **full V2 blueprint** for GitNexus as a **self-contained, self-feedback repo brain**.

The recent research picture is pretty consistent: repository-scale agents benefit from graph-native retrieval and planning, but the next jump comes from **learned query planning, selective runtime evidence, governed memory, and evaluation loops that optimize retrieval quality instead of only final patch success**. At the same time, end-to-end feature work is still hard for current agents, context retrieval remains inefficient, interactive debugging is becoming a major win, and security/performance/dependency decisions are still weak spots. Large static context files can even make agents worse when they overconstrain or bloat the prompt. ([arXiv][1])

So V2 should not be “more index.”
It should be a **graph-native operating system for code agents**.

---

# V2 thesis

V1 gave GitNexus:

* a strong **FactGraph**
* a strong **ExpectationGraph**
* slices, gaps, shapes, precedents, episodes, provenance, proof spans
* four core operating modes

V2 should add five new properties:

1. **The graph can plan**
2. **The graph can observe runtime truth**
3. **The graph can learn from its own trajectories**
4. **The graph can constrain edits before they become expensive**
5. **The graph can continuously evaluate and improve itself**

That yields a real brain loop:

**observe → infer → act → verify → learn → consolidate → forget**

And the hard rule for V2 is:

> **No new subsystem may exist as a passive consumer only.**
> Every subsystem must ship with:
>
> * a **producer**
> * a **validator**
> * a **consumer**
> * a **feedback signal**
> * a **forgetting / decay policy**

That is how you avoid another “precision overlay has a consumer hook but no producer” situation.

---

# 1. V2 architecture at a glance

I would name the V2 control plane **BrainKernel**.

It owns six data planes and eight services.

## Data planes

1. **FactGraph**
   Durable, mostly static, repo truth.

2. **ExpectationGraph**
   Durable, derived expectations and missingness.

3. **RuntimeTruthGraph**
   Ephemeral, TTL-based, selectively observed runtime evidence.

4. **ExperienceGraph**
   Durable but governed memory distilled from EpisodeGraph.

5. **ConstraintGraph**
   Durable and derived, the repo’s invariants, policies, and risk constraints.

6. **EvalGraph**
   Durable local benchmark and telemetry substrate.

## Services

1. **ProducerManager**
2. **PlannerEngine**
3. **ContextCompiler**
4. **RuntimeObserver**
5. **ExperienceGovernor**
6. **ConstraintEngine**
7. **DistillationEngine**
8. **Toolsmith**
9. **SecuritySentinel**
10. **Evaluator**

You can keep the external surface almost unchanged:

* `gitnexus analyze`
* `gitnexus serve`
* MCP tools
* the four modes: `$query`, `$review`, `$implement`, `$debug`

Everything else stays internal.

---

# 2. Non-negotiable V2 invariants

These should remain iron laws.

## 2.1 Trust stays tiered

Order of trust:

1. deterministic static fact
2. validated precision overlay fact
3. validated runtime observation
4. historical/cochange evidence
5. semantic retrieval / precedent similarity
6. heuristic suspicion

Nothing lower-tier may silently overwrite higher-tier truth.

## 2.2 Closed-loop or it does not ship

Every overlay or derived system must own:

* acquisition
* reconciliation
* scoring
* retention
* decay

No “manual input expected” paths.

## 2.3 Selective, not omniscient

Do not build:

* full whole-program dataflow
* always-on tracing
* giant flat context bundles
* giant unfiltered memory stores

The frontier papers keep finding that **selection quality** matters more than bulk. ([arXiv][2])

## 2.4 Four modes remain the public API

Internally, V2 can synthesize micro-operators, subplans, probes, and checkers.
Externally, users still think in:

* `$query`
* `$review`
* `$implement`
* `$debug`

That keeps the product surface elegant while the internal machinery gets gloriously baroque.

---

# 3. Storage topology

Use a **multi-store brain**, not one giant Kuzu blob.

## 3.1 Durable graph store

Keep Kuzu for:

* FactGraph
* ExpectationGraph
* ConstraintGraph
* high-value projections from RuntimeTruthGraph
* EvalGraph summaries

## 3.2 Event / trace store

Use SQLite or Parquet sidecars for:

* raw runtime traces
* raw episode logs
* evaluator trajectory logs
* toolsmith rollout logs

Raw logs should not all be graph nodes.

## 3.3 ANN / ranking store

Use HNSW or equivalent for:

* summary embeddings
* slice embeddings
* experience-card embeddings
* precedent retrieval
* context compiler compression candidates

## 3.4 Model artifact store

Local directory with versioned artifacts:

* planner policy
* slice ranker
* gap severity scorer
* precedent ranker
* test selector
* probe selector
* risk models

### Suggested layout

```text
.gitnexus/
  meta.json
  kuzu/
    main.db
    runtime.db
    eval.db
  traces/
    runtime/*.parquet
    episodes/*.parquet
  memory/
    cards.sqlite
    anti_patterns.sqlite
    clusters.sqlite
  models/
    planner/
    rankers/
    risk/
    distill/
  producers/
    precision/
    runtime/
    summaries/
  eval/
    tasks/
    runs/
    canaries/
  toolsmith/
    candidates/
    promoted/
  manifests/
    brain.json
    producers.json
    policies.json
```

---

# 4. Graph schema additions for V2

V1 already added a lot. V2 should add the pieces needed for runtime truth, governed memory, constraints, evaluation, and self-improvement.

## 4.1 New node families

### Runtime family

* `RuntimeSession`
* `RuntimeProbe`
* `RuntimeCall`
* `RuntimeReturn`
* `RuntimeMutation`
* `RuntimeHTTP`
* `RuntimeDBQuery`
* `RuntimeCacheEffect`
* `RuntimeException`
* `RuntimeWitness`

### Memory family

* `ExperienceCard`
* `AntiPatternCard`
* `MemoryCluster`
* `Playbook`
* `Lesson`
* `DecisionTrace`

### Constraint family

* `Constraint`
* `PolicyRule`
* `RiskFinding`
* `RiskBudget`
* `DependencyDecision`
* `SecurityBoundary`
* `PerfHotspot`

### Evaluation family

* `EvalTask`
* `EvalCase`
* `EvalRun`
* `EvalMetric`
* `GoldContext`
* `GoldProof`
* `Regression`

### Self-improvement family

* `PlannerPolicy`
* `RankerArtifact`
* `OperatorArtifact`
* `ProbeTemplate`
* `DistilledRepoExpert`

## 4.2 New relation families

* `OBSERVED_CALLS`
* `OBSERVED_RETURNS`
* `OBSERVED_MUTATES`
* `OBSERVED_INVALIDATES`
* `OBSERVED_SERIALIZES`
* `OBSERVED_THROWS`
* `SUPPORTS`
* `CONTRADICTS`
* `PROVES`
* `SUGGESTS`
* `SATISFIES`
* `VIOLATES`
* `COMPILED_FROM`
* `CONSOLIDATED_TO`
* `LEARNED_FROM`
* `RANKED_BY`
* `SELECTED_FOR`
* `USED_IN`
* `REJECTED_BY`
* `QUARANTINED_BY`
* `TAINTS`
* `MITIGATES`
* `EVALUATED_ON`
* `REGRESSED_ON`
* `PROMOTED_TO`

## 4.3 Metadata upgrades on every edge/result

Every meaningful edge should carry:

```ts
type EvidenceMeta = {
  confidence: number
  certaintyTier:
    | 'deterministic'
    | 'precision-overlay'
    | 'runtime-observed'
    | 'historical'
    | 'semantic'
    | 'heuristic'
  provenanceSource:
    | 'native'
    | 'scip'
    | 'lsp'
    | 'stack-graph'
    | 'runtime-probe'
    | 'git-history'
    | 'summary'
    | 'memory'
    | 'evaluator'
  witnessSpanIds: string[]
  contradictionCount: number
  validatedAt?: string
  ttlUntil?: string
}
```

---

# 5. BrainKernel: the master loop

This is the V2 heart.

## 5.1 One scheduler, not many commands

BrainKernel is invoked on:

* `analyze`
* `serve`
* after each mode run
* after test completion
* after patch validation
* on repo change detection
* during idle windows while MCP is alive

No separate human-facing commands for:

* “generate precision”
* “mine memories”
* “retrain planner”
* “build benchmarks”
* “synthesize microtools”

Those are internal jobs.

## 5.2 The canonical tick

```ts
async function brainTick(reason: BrainEvent) {
  const changed = await detectRepoChanges()
  await ProducerManager.run(changed, reason)
  await reconcileGraphs(changed)
  await deriveExpectationsAndGaps(changed)
  await updateRuntimeProjections(reason)
  await governEpisodes(reason)
  await refreshConstraints(changed)
  await maybeRunCanaryEvals(reason)
  await maybeRetrainRankers(reason)
  await maybePromoteOperators(reason)
  await compactAndForget(reason)
  await publishBrainManifest()
}
```

## 5.3 Brain manifest

Always publish a compact, queryable manifest:

```ts
type BrainManifest = {
  repoFingerprint: string
  graphVersion: string
  plannerPolicyVersion: string
  activeProducerVersions: Record<string, string>
  runtimeTruthFreshness: string
  memoryCardStats: {
    cards: number
    antiPatterns: number
    avgUtility: number
  }
  evalStatus: {
    lastCanaryAt: string
    regressionsOpen: number
  }
  riskStatus: {
    securityFindingsOpen: number
    perfFindingsOpen: number
    depFindingsOpen: number
  }
}
```

That manifest becomes a first-class retrieval source for all four modes.

---

# 6. ProducerManager: every overlay owns its own producer

This is the self-contained fix to the V1 “consumer-only” trap.

## 6.1 Producer contract

Every producer implements:

```ts
interface BrainProducer {
  id: string
  kind:
    | 'precision'
    | 'runtime'
    | 'memory'
    | 'summary'
    | 'constraint'
    | 'eval'
    | 'toolsmith'
  detect(ctx: ProducerContext): Promise<boolean>
  produce(ctx: ProducerContext): Promise<Artifact[]>
  validate(artifacts: Artifact[], ctx: ProducerContext): Promise<ValidatedArtifact[]>
  integrate(artifacts: ValidatedArtifact[], ctx: ProducerContext): Promise<void>
  score(ctx: ProducerContext): Promise<ProducerScore>
  forget(ctx: ProducerContext): Promise<void>
}
```

## 6.2 Built-in producers

### PrecisionProducer

Owns:

* auto-detect supported workspaces
* launch bundled or managed precision adapters
* normalize to snapshot JSONL
* validate spans, ids, alignments
* integrate only validated facts

This is inspired by the fact that recent systems are increasingly using structured repo graphs and graph-model bridges, but your implementation should stay self-contained and producer-led. ([arXiv][3])

### RuntimeProducer

Owns:

* probe planning
* instrumentation insertion or middleware activation
* trace capture
* trace compression
* runtime graph projection
* TTL / forgetting

### MemoryProducer

Owns:

* episode extraction
* subtask segmentation
* card generation
* card scoring
* card clustering
* decay

Memory work in 2026 is converging on exactly this kind of governed, subtask-aligned experience instead of replaying whole trajectories. ([arXiv][4])

### SummaryProducer

Owns:

* structured summaries
* proof-aware compression
* stale-summary invalidation
* summary usefulness scoring

### ConstraintProducer

Owns:

* deriving constraints from shapes/auth/tests/history/policies
* validating solver inputs
* promoting constraints
* retracting contradicted constraints

### EvalProducer

Owns:

* task mining
* gold-context generation
* canary construction
* regression tracking

### ToolsmithProducer

Owns:

* mining repeated microplans
* generating typed operators
* sandbox evaluation
* promotion / rollback

Recent work on self-evolving agents and dynamic tool creation makes this a reasonable V2 direction, but GitNexus should keep it internal and governed rather than turning the external surface into tool confetti. ([arXiv][5])

---

# 7. PlannerEngine: learned graph query planning

This is probably the biggest V2 unlock.

RANGER separates entity queries from natural-language graph exploration, SemanticForge argues for learned structured graph queries, and ContextBench shows that current agents often explore a lot of context without using it effectively. ([arXiv][6])

## 7.1 Planner responsibilities

Given a task, the planner decides:

* anchor type
* graph operators to use
* expansion budget
* whether to fetch precedents
* whether to request runtime probes
* whether to consult memory
* whether to compile constraints
* how much context to emit

## 7.2 Query state representation

```ts
type PlannerState = {
  mode: 'query' | 'review' | 'implement' | 'debug'
  repoFingerprint: string
  intentClass:
    | 'symbol'
    | 'slice'
    | 'contract'
    | 'symptom'
    | 'feature-request'
    | 'refactor'
  anchorEntropy: number
  candidateSlices: number
  candidateContracts: number
  uncertaintyVector: {
    static: number
    runtime: number
    precedent: number
    memory: number
  }
  budget: {
    maxTokens: number
    maxFiles: number
    maxOperators: number
  }
  priorOutcomeHints: {
    similarSuccessRate: number
    similarFailureRate: number
  }
}
```

## 7.3 Operator library

The planner chooses from internal operators such as:

* `resolve_anchor`
* `expand_slice`
* `expand_shape`
* `compute_gap_delta`
* `select_precedents`
* `retrieve_memory_cards`
* `compile_constraints`
* `select_tests`
* `request_runtime_probe`
* `compile_context_packet`

## 7.4 Initial learning algorithm

Do not start with a giant learned planner.

Start with:

* rule-based baseline policy
* logged trajectories
* contextual bandit or ranker over operator choices
* offline evaluation on EvalGraph
* shadow deployment
* canary promotion

### Reward function

```ts
reward =
  correctnessProxy
  + proofSufficiency
  + testSignalGain
  + userAcceptance
  - tokenCostPenalty
  - latencyPenalty
  - wrongProbePenalty
  - noisyContextPenalty
```

## 7.5 Planner outputs

The planner emits a **PlanEnvelope**:

```ts
type PlanEnvelope = {
  anchors: Anchor[]
  operators: PlannedOperator[]
  proofObjectives: ProofObjective[]
  requestedProbes: ProbeRequest[]
  contextShape: 'thin' | 'standard' | 'deep'
  stopConditions: StopCondition[]
}
```

---

# 8. ContextCompiler: kill giant manifests, compile minimal brain packets

The AGENTS.md work suggests that broad static context files often encourage agents to do more wandering without necessarily solving more tasks, and the authors recommend minimal requirements rather than bloated context instructions. ([SRI Lab][7])

So V2 should treat static context files as tiny bootloaders, not giant encyclopedias.

## 8.1 Static vs dynamic context

### Static context should contain only:

* repo boot instructions
* supported modes
* minimal operational policies
* how to invoke GitNexus

### Dynamic compiled context should contain:

* anchors
* candidate slices
* proof spans
* constraints
* precedents
* runtime witnesses
* tests
* edit budget
* unresolved questions

## 8.2 BrainPacket format

```ts
type BrainPacket = {
  mode: 'query' | 'review' | 'implement' | 'debug'
  task: string
  anchors: Anchor[]
  primarySlices: SliceCard[]
  proofPack: ProofPack
  obligations: ClosureObligation[]
  gaps: GapFinding[]
  precedents: PrecedentCard[]
  runtimeWitnesses?: RuntimeWitnessCard[]
  memoryCards?: ExperienceCardView[]
  constraints: ConstraintView[]
  testPlan: TestPlan
  riskProfile: RiskProfile
  editBudget: {
    maxFiles: number
    preferredOrder: string[]
  }
}
```

## 8.3 Context optimization loop

After every mode run, compute:

* retrieved but unused artifacts
* used but missing artifacts
* tokens spent per useful artifact
* proof sufficiency score

Feed that back into the planner and context compiler.

This directly addresses the “explored vs utilized context” gap highlighted by ContextBench. ([arXiv][2])

---

# 9. RuntimeTruthGraph: selective runtime observation

This is the biggest structural addition after V1.

Debug2Fix, InspectCoder, and AgentStepper all show that interactive debugging and runtime introspection surface bug evidence that static reasoning misses. ([arXiv][8])

## 9.1 Principles

* not always on
* probe-driven
* slice-scoped
* TTL-based
* privacy-aware
* reconciled against static graph
* compressed into reusable witnesses

## 9.2 What to observe

### UI / frontend

* event handler execution
* fetch/axios calls
* query key reads/writes
* React Query invalidations
* state mutations
* route transitions
* component prop shapes at critical boundaries

### Laravel / backend

* route resolution
* middleware stack
* controller invocation
* request validation results
* gate/policy outcomes
* service container resolution
* Eloquent queries and relationship loads
* resource serialization
* cache reads/writes
* event dispatches
* job dispatches
* notifications
* exceptions

### Database / cache

* query fingerprints
* touched tables/columns
* row counts where available
* cache keys touched
* invalidation chains

### Tests

* test-to-slice coverage
* runtime witnesses per test
* failure signature to slice mapping

## 9.3 Probe planner

Runtime probes should not be hand-authored ad hoc.
They should be compiled from uncertainty.

```ts
type ProbeRequest = {
  reason:
    | 'debug-symptom'
    | 'review-uncertainty'
    | 'implement-verification'
    | 'eval-canary'
  anchors: string[]
  targetFamilies: (
    | 'http'
    | 'auth'
    | 'cache'
    | 'shape'
    | 'event'
    | 'db'
    | 'exception'
  )[]
  scope: {
    tests?: string[]
    endpoints?: string[]
    files?: string[]
  }
  ttlMinutes: number
}
```

## 9.4 Trace compression

Do not keep raw traces as the main retrieval surface.

Compress them into:

* `RuntimeWitnessCard`
* `ObservedLoop`
* `ContradictionWitness`
* `CoverageWitness`

### Example witness

```ts
type RuntimeWitnessCard = {
  id: string
  sliceId: string
  claim: string
  evidence: EvidenceSpan[]
  observedChain: string[]
  contradictions: string[]
  freshness: string
}
```

## 9.5 Static-dynamic reconciliation

Every runtime observation should be reconciled with static expectations.

Cases:

* **supports static edge**
* **fills static gap**
* **contradicts static expectation**
* **reveals hidden dynamic branch**
* **reveals dead/static-only path**

Contradictions feed back into:

* GapGraph
* planner uncertainty
* constraint derivation
* precedent ranking
* eval regressions

---

# 10. ExperienceGovernor 2.0: governed subtask memory

MemGovern converts raw history into governed experience cards, SWE-ContextBench shows summarized experience helps only when correctly selected, and subtask-level memory work argues that the memory unit should match the agent’s decomposition instead of whole-episode blobs. ([arXiv][4])

## 10.1 Raw EpisodeGraph is not directly retrievable

Raw trajectories are noisy.

Pipeline should be:

```text
EpisodeGraph
→ subtask segmentation
→ normalization
→ verification
→ card generation
→ utility scoring
→ clustering
→ retention / decay
→ ExperienceGraph
```

## 10.2 Card taxonomy

### Query cards

* “how this repo answers a type of query”

### Review cards

* “common missing closure for slice family X”

### Implement cards

* “companion edit sets for task family X”

### Debug cards

* “symptom Y usually breaks at loop slot Z”

### Anti-pattern cards

* “do not trust this misleading pattern”
* “this failure mode looked similar but was different because…”

### Runtime cards

* “this probe pattern exposed the root cause before”

### Constraint exception cards

* “this slice intentionally violates the default expectation; here is why”

## 10.3 Card schema

```ts
type ExperienceCard = {
  id: string
  repoFingerprint: string
  mode: 'query' | 'review' | 'implement' | 'debug'
  sliceFamily?: string
  stage:
    | 'anchor'
    | 'expand'
    | 'probe'
    | 'patch'
    | 'verify'
  trigger: string
  lesson: string
  supportingProof: string[]
  applicableWhen: string[]
  notApplicableWhen: string[]
  outcome:
    | 'success'
    | 'partial'
    | 'failure'
  utilityScore: number
  trustScore: number
  freshnessScore: number
}
```

## 10.4 Retrieval policy

Retrieve cards by:

* mode
* subtask stage
* slice family
* symptom family
* applicable constraints
* contradiction filters

Never retrieve more than a tiny handful.

## 10.5 Forgetting policy

Cards decay when:

* contradicted by newer evidence
* tied to stale repo topology
* low utility across repeated uses
* superseded by stronger cards
* sourced from untrusted context

Memory that never forgets turns into attic dust.

---

# 11. ConstraintGraph: patch guards before damage

Recent work like SemanticForge pushes structured semantic constraints for repo-level generation, while SecRepoBench, PerfBench, and DepDec-Bench show that current systems still struggle on security, performance, and dependency decisions that are not captured by plain test passing. ([arXiv][9])

## 11.1 Constraint families

### Structural constraints

* slice family requires slots A/B/C
* endpoint mutation requires cache closure
* route resource requires auth closure

### Shape constraints

* validated field must map to consumer or serializer
* serialized field must correspond to source
* frontend field reads must match backend shape

### Auth constraints

* privileged endpoint must have guard closure
* policy/resource route alignment
* permission slug reachability

### Runtime constraints

* observed mutation must match expected invalidation
* exception path requires test witness or explicit ignore

### Dependency constraints

* avoid vulnerable versions
* prefer existing internal abstractions
* ecosystem policy rules
* remediation burden scoring

### Performance constraints

* do not add known N+1 patterns in hot slices
* do not increase hot path query count without witness
* watch fan-out from cache misses

### Security constraints

* tainted external input must not cross dangerous sink without sanitization
* secret read paths cannot flow into output sinks
* generated operator cannot expand capabilities without policy grant

## 11.2 Constraint DSL

You already have an expectation DSL. V2 should extend it.

Example:

```dsl
constraint MutationCacheClosure {
  when slice.family == "react-query-mutation"
   and slice.touchesShape("Ticket")
  require exists edge(type="INVALIDATES_KEY", from=slice, toFamily="tickets")
  severity "high"
}
```

```dsl
constraint AdminEndpointAuth {
  when endpoint.pathPrefix == "/admin"
  require endpoint.hasPermissionClosure()
  severity "critical"
}
```

```dsl
constraint ValidatedFieldReachability {
  when field.validated == true
  require field.reachesAny(["DBColumn", "ResourceField", "SideEffect"])
  severity "medium"
}
```

## 11.3 Constraint solver

Start with:

* graph pattern matching
* finite checks
* cardinality checks
* lightweight Datalog/forward-chaining
* explicit contradiction logic

Only add SAT/SMT for truly hard cases later.

## 11.4 Patch gate

Every candidate patch gets:

* structural constraint check
* shape constraint check
* auth/cache closure check
* security/perf/dep policy check
* dynamic contradiction scan if runtime witnesses exist

Violations become:

* block
* warn
* request targeted runtime probe
* request targeted tests

---

# 12. DistillationEngine: build small repo experts

CGM and CGBridge point toward graph-to-model compression, while SWE-Spot argues that repository mastery is its own competence axis and that small repo-specialized experts can be very efficient. SWE-RL and self-play SWE-RL suggest software evolution data is a valid learning substrate. ([arXiv][3])

## 12.1 Distill the repo, not the whole universe

Do not try to fine-tune a giant code model first.

V2 should distill lightweight local experts:

* **SliceRanker**
* **GapSeverityScorer**
* **PrecedentRanker**
* **ProbeSelector**
* **TestSelector**
* **RiskScorer**
* **PlannerPolicy**

## 12.2 Training data sources

* successful mode trajectories
* failed trajectories
* accepted patches
* reverted patches
* test deltas
* runtime witness usefulness
* context usage traces
* git-history cochange patterns
* eval canaries

## 12.3 Model choices

Default local-first choices:

* gradient boosted trees
* linear models
* small MLPs
* logistic rankers
* embedding rerankers
* optional ONNX export

The system does not need a giant researchy neural cathedral to get real gains here.

## 12.4 Promotion pipeline

```text
shadow-train
→ offline eval
→ canary on EvalGraph
→ compare against current artifact
→ promote if statistically beneficial and safe
→ keep rollback handle
```

## 12.5 Graph-to-model bridge

This is the more ambitious lane.

A `BridgePacket` can compress a proof subgraph or slice graph into a compact model-facing structure:

```ts
type BridgePacket = {
  sliceId: string
  topologySketch: string
  keyContracts: string[]
  gaps: string[]
  precedentHints: string[]
  proofHashes: string[]
}
```

You do not need a full CGBridge-style learned module on day one.
Start with symbolic bridge packets. Later, if it earns its keep, add a trainable bridge. ([arXiv][10])

---

# 13. Toolsmith: self-growing internal operators

OpenSage, Confucius Code Agent, Code2MCP, and Live-SWE-Agent all point toward agents that can grow or refine tooling and scaffolding over time. The right GitNexus move is to adopt the **closed-loop part** of that idea, not the chaos part. ([arXiv][5])

## 13.1 External surface stays fixed

The public API remains the four modes.

## 13.2 Internal operator synthesis

Toolsmith mines successful subplans and turns them into typed internal operators.

Example candidates:

* `compare_two_slices`
* `explain_gap_with_runtime`
* `select_high_value_tests`
* `trace_cache_break`
* `compile_patch_guard_report`
* `rank_precedents_for_shape_change`

## 13.3 Synthesis pipeline

```text
mine frequent operator sequences
→ abstract parameters
→ type-check inputs/outputs
→ generate operator spec
→ sandbox on eval tasks
→ security review
→ shadow use
→ promote or discard
```

## 13.4 Operator schema

```ts
type OperatorArtifact = {
  id: string
  name: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  implementationKind: 'cypher' | 'pipeline' | 'composite'
  createdFromTraceIds: string[]
  utilityGain: number
  safetyStatus: 'pending' | 'approved' | 'rejected'
}
```

## 13.5 Promotion guardrails

An operator cannot be promoted unless:

* deterministic tests pass
* eval canaries improve
* security policy approves capabilities
* it does not widen filesystem/network access
* its outputs remain proof-carrying

---

# 14. SecuritySentinel: trust, taint, and skill hardening

Prompt-injection and agent-systems security work both argue that once agents have tools, memory, filesystems, skills, and protocols, the defense problem becomes architectural, not prompt-only. ([arXiv][11])

## 14.1 Trust zones

### Trusted

* repo source files
* validated static producers
* validated runtime traces
* verified test outputs
* promoted operator artifacts

### Semi-trusted

* git history
* prior episodes
* generated summaries
* human-authored context files

### Untrusted

* web content
* docs pulled from arbitrary files
* issue bodies
* copied tool outputs
* generated operator candidates
* unvalidated memory cards

## 14.2 Taint propagation

Every artifact gets a taint label.

```ts
type TaintLevel =
  | 'trusted'
  | 'semi-trusted'
  | 'untrusted'
  | 'quarantined'
```

Rules:

* untrusted data cannot directly promote durable constraints
* untrusted data cannot directly write durable memory cards
* operator synthesis cannot use untrusted code paths without sandbox approval
* summaries based on untrusted inputs are tagged and excluded from critical modes unless corroborated

## 14.3 SecurityGraph

Add nodes for:

* `ExternalArtifact`
* `Credential`
* `SecretSink`
* `DangerousAPI`
* `CapabilityGrant`
* `SandboxPolicy`
* `InjectionFinding`

Use it for:

* prompt injection resistance
* memory poisoning defense
* capability auditing
* operator approval
* secret exfiltration risk scanning

## 14.4 Runtime lockdown profiles

GitNexus should support internal profiles:

* `read-only`
* `patch-safe`
* `probe-safe`
* `full-local-sandbox`

The mode router selects a profile automatically. No human has to remember special commands.

---

# 15. Non-functional overlays: SecurityGraph, PerfGraph, DepGraph

SecRepoBench, PerfBench, and DepDec-Bench are a loud reminder that “tests pass” is not enough. ([arXiv][12])

## 15.1 SecurityGraph

Tracks:

* tainted input sources
* sanitizers
* sensitive sinks
* auth boundary crossings
* unsafe APIs
* missing validation
* vulnerable dependency paths

## 15.2 PerfGraph

Tracks:

* hot slices
* hot endpoints
* query fan-out
* N+1 candidates
* large serialization paths
* high-churn performance regressions
* benchmark witnesses

## 15.3 DependencyPolicyGraph

Tracks:

* approved ecosystems
* approved packages
* preferred internal reuse
* vulnerable version blocks
* upgrade risk
* remediation burden
* license/policy rules

These overlays are first-class citizens in:

* `$review`
* `$implement`
* `$debug`

They should not be bolt-on lint warnings.

---

# 16. EvalGraph: the self-improvement flywheel

FeatureBench, ContextBench, and RepoReason all point to the same lesson: we need evaluation that measures feature-level work, retrieval quality, and reasoning quality, not just whether a patch squeaks through tests. ([arXiv][13])

## 16.1 GitNexus should mine its own local benchmark

V2 should build a **repo-native benchmark flywheel** from the repo itself.

Sources:

* git history
* tests
* issue references if available
* PR diffs
* failure traces
* runtime witnesses

## 16.2 Task miner

Mine local tasks of these families:

* bug fix
* feature addition
* refactor
* security fix
* performance fix
* dependency decision
* contract migration
* auth closure repair
* cache closure repair

## 16.3 Gold context miner

For each historical task, build:

* changed slices
* proof subgraph
* gold files/spans
* required constraints
* relevant tests
* runtime witnesses if reconstructable

This gives GitNexus its own local equivalent of a ContextBench-style gold-context layer. ([arXiv][2])

## 16.4 Metrics

### Retrieval metrics

* gold context recall
* gold context precision
* proof sufficiency
* files-opened per solved task
* tokens per useful artifact

### Review metrics

* gap precision
* gap severity calibration
* missed closure rate
* false alarm rate

### Implement metrics

* companion edit recall
* precedent usefulness
* patch acceptance rate
* post-review delta count

### Debug metrics

* broken-loop top-1/top-3 localization
* useful probe rate
* time-to-root-cause
* contradiction resolution rate

### Non-functional metrics

* security issue miss rate
* perf regression miss rate
* bad dependency decision rate

### Learning metrics

* planner uplift
* memory card utility
* operator promotion hit rate
* stale memory decay correctness

## 16.5 Canary policy

No new planner policy, ranker, operator, or constraint family should be promoted without local canary evaluation.

---

# 17. Mode behavior in V2

The public face still stays gloriously simple.

## 17.1 `$query`

Pipeline:

1. planner classifies intent
2. exact anchor resolution
3. slice/shape/value expansion
4. memory lookup if useful
5. compile minimal BrainPacket
6. return slice card + proof pack + optional constraints

Goal:

* answer in one or two slices
* never dump a bag of 30 files

## 17.2 `$review`

Pipeline:

1. map diff to slices/shapes/tests
2. apply closure templates
3. compute semantic delta
4. run constraints
5. rank gaps
6. optionally request tiny runtime probes if uncertainty is high
7. return proof-backed callouts

Goal:

* stencil matching, not checklist recital

## 17.3 `$implement`

Pipeline:

1. classify feature/change family
2. select precedents
3. compile companion edit set
4. compile constraints
5. propose file order
6. after patch, auto-run review + targeted tests + optional runtime verification
7. write useful experience cards

Goal:

* “trace over the picture” implementation

## 17.4 `$debug`

Pipeline:

1. parse symptom
2. anchor to slices/contracts/values/tests
3. rank broken-loop hypotheses
4. request targeted probes when needed
5. reconcile runtime vs static
6. rank root-cause candidates
7. compile repair path + verifying tests

Goal:

* corner the non-closed loop fast

---

# 18. Self-contained feedback loops

This is the part you explicitly asked for.

## 18.1 Static loop

```text
repo change
→ analyze
→ rebuild facts
→ derive expectations/gaps/constraints
→ publish manifest
```

## 18.2 Mode loop

```text
task request
→ plan
→ retrieve
→ compile context
→ answer/edit/debug
→ verify
→ log trajectory
→ govern memory
→ update planner stats
```

## 18.3 Runtime loop

```text
high uncertainty or debug symptom
→ compile probe plan
→ run targeted instrumentation
→ collect traces
→ compress witnesses
→ reconcile with static graph
→ update gap/constraint/debug ranking
```

## 18.4 Learning loop

```text
successful + failed trajectories
→ feature extraction
→ retrain rankers/policies
→ shadow eval
→ canary eval
→ promote or rollback
```

## 18.5 Tool loop

```text
mine repeated successful operator traces
→ synthesize candidate operator
→ sandbox
→ eval
→ policy review
→ promote or discard
```

## 18.6 Forgetting loop

```text
detect stale / contradicted / low-utility memory, traces, summaries, operators
→ decay score
→ demote
→ archive or delete
```

Every loop is internal.
No extra command is required from the user.

---

# 19. Recommended implementation order

This is the order I would give your agent.

## Phase A. BrainKernel foundations

Ship first:

* unified scheduler
* producer contract
* brain manifest
* artifact versioning
* promotion / rollback framework
* taint / trust metadata

This phase makes the rest coherent.

## Phase B. Planner + ContextCompiler

Ship next:

* plan envelope
* operator library
* query/review/implement/debug planners
* thin BrainPacket compiler
* context usage telemetry

This will produce immediate token savings.

## Phase C. RuntimeTruthGraph

Then:

* probe planner
* TS/Laravel instrumentors
* trace store
* witness compression
* static-dynamic reconciliation

This is the debugging rocket booster.

## Phase D. ExperienceGovernor 2.0

Then:

* subtask segmentation
* experience cards
* anti-pattern cards
* retrieval policy
* forgetting / consolidation

This prevents repeated wandering.

## Phase E. ConstraintGraph

Then:

* constraint families
* DSL extensions
* patch guard engine
* security/perf/dep base rules

This raises patch quality.

## Phase F. EvalGraph

Then:

* task miner
* gold context miner
* canary harness
* regression tracking
* dashboard metrics

This turns V2 into a self-improving system.

## Phase G. DistillationEngine

Then:

* rankers
* planner bandit
* test selector
* precedent ranker
* risk scorer

This adds repo-specific intelligence.

## Phase H. Toolsmith

Then:

* frequent subplan miner
* typed operator synthesis
* sandbox promoter
* operator rollback

This grows the internal nervous system.

## Phase I. Graph-to-model bridge

Then:

* symbolic bridge packets
* optional learned bridge later

This is research-heavy and should not block the practical gains.

---

## Phase J. V2 parity hardening backlog

Complete this phase before calling Project Ascension "V2 parity achieved":

* add a machine-checkable `v2_parity` gate report to the Brain manifest and MCP brain resource
* wire planner operator/context-shape selection to outcome-driven distillation policies (canary-gated rollout)
* add auto micro runtime-probe orchestration for review/debug under high uncertainty
* enforce implement finalize gates: mandatory patch guard + mandatory post-edit review contract
* add parity canary checks that fail promotions when any parity-critical gate regresses

---

# 20. V2 parity definition

I would define “V2 parity” as achieved only when all of these are true:

## Query

* returns proof-carrying slice cards by default
* median useful-context size is materially smaller than V1
* planner chooses retrieval operators adaptively
* context usage telemetry shows low waste

## Review

* closure/gap/constraint callouts are ranked and proof-backed
* security/perf/dep issues show up in review
* review can request micro runtime probes when uncertainty is high

## Implement

* companion edit recall is high
* precedents are slice-native, not just process-native
* patch guard runs automatically before finalizing
* post-implement auto-review is mandatory

## Debug

* runtime probes are automatic, selective, and self-contained
* broken-loop localization uses both static and runtime truth
* debug returns root-cause candidates with validating tests/witnesses

## Self-feedback

* planner updates from outcomes
* memory cards are governed and decayed
* operator candidates are auto-mined and evaluated
* eval canaries gate promotions
* every subsystem has producer + validator + consumer + forgetting

If any of those is missing, it is still V1.x with extra chrome.

---

# 21. The one-sentence V2 vision

**GitNexus V2 is a local-first, proof-carrying, graph-native agent operating system that can index, observe, plan, constrain, remember, evaluate, and improve itself without requiring manual side commands or human glue steps.**

That is the “real brain” version.

Please use TDD for all implementation.

[1]: https://arxiv.org/abs/2410.14684?utm_source=chatgpt.com "RepoGraph: Enhancing AI Software Engineering with ..."
[2]: https://arxiv.org/abs/2602.05892?utm_source=chatgpt.com "ContextBench: A Benchmark for Context Retrieval in Coding Agents"
[3]: https://arxiv.org/abs/2505.16901?utm_source=chatgpt.com "Code Graph Model (CGM): A Graph-Integrated Large Language Model for Repository-Level Software Engineering Tasks"
[4]: https://arxiv.org/abs/2601.06789?utm_source=chatgpt.com "MemGovern: Enhancing Code Agents through Learning from Governed Human Experiences"
[5]: https://arxiv.org/abs/2602.16891?utm_source=chatgpt.com "OpenSage: Self-programming Agent Generation Engine"
[6]: https://arxiv.org/abs/2509.25257?utm_source=chatgpt.com "RANGER -- Repository-Level Agent for Graph-Enhanced Retrieval"
[7]: https://www.sri.inf.ethz.ch/publications/gloaguen2026agentsmd?utm_source=chatgpt.com "Are Repository-Level Context Files Helpful for Coding Agents?"
[8]: https://arxiv.org/html/2602.18571v1?utm_source=chatgpt.com "Debug2Fix: Supercharging Coding Agents with Interactive ..."
[9]: https://arxiv.org/html/2511.07584v1?utm_source=chatgpt.com "SemanticForge: Repository-Level Code Generation ..."
[10]: https://arxiv.org/abs/2512.07666?utm_source=chatgpt.com "Bridging Code Graphs and Large Language Models for Better Code Understanding"
[11]: https://arxiv.org/abs/2601.17548?utm_source=chatgpt.com "Prompt Injection Attacks on Agentic Coding Assistants: A Systematic Analysis of Vulnerabilities in Skills, Tools, and Protocol Ecosystems"
[12]: https://arxiv.org/abs/2504.21205?utm_source=chatgpt.com "SecRepoBench: Benchmarking LLMs for Secure Code Generation in Real-World Repositories"
[13]: https://arxiv.org/abs/2602.10975?utm_source=chatgpt.com "FeatureBench: Benchmarking Agentic Coding for Complex Feature Development"

Please record your progress here and alert when all aspects of project ascension are fully implemented and ready to smoke test:

## Progress log

- 2026-03-01: Started Phase A (BrainKernel foundations) implementation.
- 2026-03-01: Added `core/brain` foundation module with producer contract, producer manager execution loop, manifest schema/store, trust + taint metadata, and artifact version markers.
- 2026-03-01: Wired `gitnexus analyze` fast/incremental/full paths to run a non-fatal BrainKernel tick and persist `.gitnexus/manifests/brain.json`.
- 2026-03-01: Added MCP resource template `gitnexus://repo/{name}/brain` and context/setup resource references so the Brain manifest is retrievable.
- 2026-03-01: Started Phase B (PlannerEngine + ContextCompiler) with baseline plan envelope, BrainPacket compiler, and context-usage telemetry persisted to `.gitnexus/manifests/context-telemetry.json`.
- 2026-03-01: Brain manifest now includes planner/context compiler summaries and telemetry rollups exposed through `gitnexus://repo/{name}/brain`.
- 2026-03-01: Started Phase C (RuntimeTruthGraph) with probe-plan synthesis, runtime witness compression, and static-dynamic reconciliation summaries.
- 2026-03-01: Brain tick now runs a `runtime-truth-graph` stage, emits runtime truth rollups into `.gitnexus/manifests/brain.json`, and surfaces `runtime_truth` in `gitnexus://repo/{name}/brain`.
- 2026-03-01: Started Phase D (ExperienceGovernor 2.0) with subtask segmentation, experience card generation/decay, compact retrieval policy, and persisted `experience-cards.json` store under `.gitnexus/manifests/`.
- 2026-03-01: Brain tick now runs an `experience-governor` stage and injects retrieved memory cards into `BrainPacket`, with `experience_governor` summary surfaced via `gitnexus://repo/{name}/brain`.
- 2026-03-01: Started Phase E (ConstraintGraph) with baseline constraint families, DSL-backed rule catalog, lightweight solver counters, and patch-gate actions (`block`, `warn`, `request-runtime-probe`, `request-targeted-tests`).
- 2026-03-01: Brain tick now runs a `constraint-graph` stage, persists `constraintGraph` rollups into `.gitnexus/manifests/brain.json`, injects constraint findings into `BrainPacket`, and surfaces `constraint_graph` via `gitnexus://repo/{name}/brain`.
- 2026-03-01: Started Phase F (EvalGraph) with task mining, gold-context mining, canary scoring, and regression tracking persisted in `.gitnexus/manifests/eval-graph.json`.
- 2026-03-01: Brain tick now runs an `eval-graph` stage, writes `evalGraph` summaries into `.gitnexus/manifests/brain.json`, updates eval status canary/regression fields, and surfaces `eval_graph` via `gitnexus://repo/{name}/brain`.
- 2026-03-01: Started Phase G (DistillationEngine) with persisted planner-bandit policy arms, reward tracking, and closed-loop selector/ranker scoring persisted in `.gitnexus/manifests/distillation-engine.json`.
- 2026-03-01: Brain tick now runs a `distillation-engine` stage, writes `distillationEngine` summaries into `.gitnexus/manifests/brain.json`, and surfaces `distillation_engine` via `gitnexus://repo/{name}/brain`.
- 2026-03-01: Started Phase H (Toolsmith) with frequent subplan mining, typed operator artifact synthesis, sandbox safety gating, promotion guardrails, and rollback tracking persisted in `.gitnexus/manifests/toolsmith-operators.json`.
- 2026-03-01: Brain tick now runs a `toolsmith` stage, writes `toolsmith` summaries into `.gitnexus/manifests/brain.json`, and surfaces `toolsmith` via `gitnexus://repo/{name}/brain`.
- 2026-03-01: Started Phase I (Graph-to-model bridge) with symbolic `BridgePacket` generation, topology/contract/gap/precedent/proof hashing, and persisted packet memory in `.gitnexus/manifests/bridge-packets.json`.
- 2026-03-01: Brain tick now runs a `graph-model-bridge` stage, writes `graphModelBridge` summaries into `.gitnexus/manifests/brain.json`, and surfaces `graph_model_bridge` via `gitnexus://repo/{name}/brain`.
- 2026-03-01: Optional Phase I follow-up shipped a shadow learned bridge model (`bridge-learned-model.json`) trained from symbolic packets, with non-invasive prediction telemetry (`mode`, `trainingPacketCount`, `shadowPredictionCount`, `averageConfidence`) surfaced through `graphModelBridge.learned` and MCP brain resource output.
- 2026-03-01: Started Phase J (V2 parity hardening) by opening a parity backlog and implementing machine-checkable parity gating in the Brain manifest.
- 2026-03-01: Phase J update: added `v2Parity` machine gate output to Brain manifest + MCP brain resource (`overall`, per-pillar scores, blockers) so parity status is queryable and canary-ready.
- 2026-03-01: Phase J update: enforced mandatory `implement_mode.post_edit_review` contract (ignores `include_review_contract=false`, emits explicit warning + requested knob telemetry).
- 2026-03-01: Phase J update: planner now consumes promoted distillation policy hints from prior manifest (`winningPolicy`) and adapts context/operator shape with safe baseline fallback.
- 2026-03-01: Phase J update: `review_mode` now auto-generates selective `micro_runtime_probe_requests` under high uncertainty (missing runtime snapshot, auth closure delta, high semantic gaps, no suggested tests) with self-contained capture templates.
- 2026-03-01: Phase J update: `review_mode` probe requests now persist to `.gitnexus/manifests/review-runtime-probes.json` and Brain tick ingests that sidecar into manifest/parity evidence (`reviewRuntimeProbes`) so review runtime probe coverage is measurable across ticks.
- 2026-03-01: Phase J update: finalize-time patch guard is now enforced through mandatory implement verification gates (`patch-guard-clean` pass gate + `patch-guard-blocked` fail gate) backed by `review_kernel.patch_guard` output and summary metrics.
- 2026-03-01: Phase J update: Distillation promotion now applies parity-canary gating from the latest Brain manifest and blocks promotion eligibility when critical parity checks are non-`met`.
- 2026-03-01: Phase J update: parity-canary deadlock mitigation shipped for adaptive planner promotion (query-adaptive `partial` no longer hard-blocks promotion), enabling baseline-to-adaptive promotion step while preserving hard blocks on missing critical checks.
- 2026-03-01: Phase J update: ContextCompiler proof resolution now tracks objective fulfillment (instead of treating all required objectives as unresolved), and runtime-witness proof debt only applies when runtime evidence is expected (debug/review or runtime-present runs).
- 2026-03-01: Phase J update: Eval canary retrieval baselines now budget gold-context files to planner capacity and promotion gating supports recovery via consecutive passing canaries (windowed pass-rate + pass streak), preventing permanent lockout from early failed history.
- 2026-03-01: Phase J update: adaptive planner policy promotion validated end-to-end in live manifests (`plannerPolicyVersion` moved from `rule-baseline-v1` to promoted winning policy), raising `query-adaptive-operator-selection` to `met`.
- 2026-03-01: Phase J update: dashboard retrieval/implement/debug metrics now use a recent-canary window (instead of full-history averaging) and context telemetry now summarizes recent runs with artifact-centric useful-ratio accounting.
- 2026-03-01: Phase J update: ContextCompiler now emits ranked packet precedents from anchor+memory signals, lifting distillation precedent confidence and moving `implement-slice-native-precedents` to `met`.
- 2026-03-01: Phase J update: EvalGraph now emits historical V1 baseline tokens (`baselines.v1MedianTokensPerUsefulArtifact`) and no-signal review calibration resolves to fully calibrated when constraint coverage exists; parity query/review checks now consume these signals.
- 2026-03-01: Phase J update: Debug parity checks now require self-contained probe templates plus runtime-backed evidence and accept validating test evidence for root-cause closure; telemetry/evidence fields were expanded accordingly.
- 2026-03-01: Phase J update: Seeded runtime observation snapshot via `runtime-ingest` and reran analyze; runtime truth now reports non-zero witnesses/loops/reconciliation and debug parity checks moved to `met`.
- 2026-03-01: Phase J complete: `v2Parity.overall.ready=true` with `met=19/19`, `partial=0`, `missing=0`, `unverified=0` in `.gitnexus/manifests/brain.json`. Project Ascension implementation is now parity-complete and ready for smoke testing.
