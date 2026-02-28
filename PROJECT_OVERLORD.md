Based on the rundown you gave me, not a checkout of the branch itself, my read is: **GitNexus already has the right skeleton**. Recent repo-scale systems keep converging on the same ingredients, unified code graphs, graph-guided retrieval, hierarchical summaries, and some form of working memory, instead of flat chunk retrieval alone. RANGER uses a graph plus dual-stage retrieval, Prometheus adds working memory to avoid repeated exploration, and Code-Craft/HCGS uses bottom-up graph summaries for better retrieval. ([arXiv][1])

The part I would protect at all costs is your **trust model**. LSIF and SCIP are excellent for persisted code navigation, and SCIP gives package/version-aware symbol identities, but LSIF explicitly does **not** define symbol semantics. So the generic code-intelligence world is great at “where is the definition/reference/range?”, while your branch is already doing something more valuable: **repo-specific contract modeling** with endpoints, permission slugs, roles, route-name closure, and cache semantics. That is the moat. ([GitHub][2])

So my headline is:

**Do not rewrite GitNexus into a bigger search engine.
Turn it into a 3-layer brain.**

1. **Fact graph**: what exists.
   This is your current graph, and it is already strong.

2. **Expectation graph**: what should exist together.
   This is the missing superpower for `$review`, `$implement`, and `$debug`.

3. **Episode graph**: what this agent has already learned in the current task.
   This is the living context layer.

You already have the map. The next move is to add a stencil and a memory.

## What I would not change

* The **confidence-first invariant**
* The **bridge-node strategy** for cross-language closure
* The **incremental indexing posture**
* The idea that the **same substrate powers CLI, MCP, and web**
* The preference for **skipping uncertain edges instead of inventing them**

Those are not constraints. Those are your bones.

## If you only build four new things

### 1. Add `FeatureSlice` nodes, then make closure first-class

Right now you have:

* **Communities**: what lives together
* **Processes**: what runs together
* **Archetypes/precedents**: what looks similar

What you still need is:

* **Slices**: what ships together
* **Closure**: what must be present together

A `FeatureSlice` should be a vertical capsule rooted on a high-confidence anchor:

* Endpoint
* route name
* permission slug
* query key family
* template action
* job/event topic

From that anchor, GitNexus should materialize the *minimal closed loop*:

* UI callers / hooks / components
* API wrapper
* endpoint
* controller / handler
* auth / policy / permission
* request validator
* domain/service/model touchpoints
* serializer/resource
* cache/query invalidation
* tests

Then build a `ClosureTemplate` for each slice family.

That changes everything:

* `$review` becomes: **changed slice vs expected closure**
* `$implement` becomes: **instantiate nearest sibling slice**
* `$debug` becomes: **which slot or link in the slice is broken**
* `$query` becomes: **return the slice card, not a sack of files**

This is the closest thing to your “trace over the picture” idea. The agent is no longer searching the forest. It is aligning a slice against its stencil.

### 2. Materialize a `GapGraph`, the negative space

Your current graph knows what is present.
To make review and debug unfair, it also needs to know what is **missing**.

Make gaps first-class nodes, not just warnings.

Examples:

* endpoint has controller but no auth closure
* mutation touches entity but has no invalidation/writeback closure
* field validated in `FormRequest` but never serialized
* field serialized in `Resource` but never consumed or typed in frontend
* permission slug referenced in Blade but not reachable from role closure
* feature slice has siblings with tests, this one does not
* route/resource pair exists, but precedent slices strongly imply a missing request/resource/policy/test companion

The crucial detail is **absence semantics**. Every gap needs a tier:

* **Deterministic missing**: absence is meaningful because the world is closed here
* **Pattern missing**: strong sibling or archetype evidence says this is probably missing
* **Heuristic suspicion**: useful for debug, but do not present as fact

This is the part that turns `$review` into something far beyond “remember these 12 rules.” The rules become graph facts.

### 3. Add a `ShapeGraph` for fields and payload contracts

Your next best bridge nodes are not more call edges. They are **field and shape contracts**.

I would add first-class nodes for:

* `ContractShape`
* `ContractField`
* `CacheKey`
* `DBTable` / `DBColumn`
* `TestCase`

Then wire:

* Laravel `FormRequest` rules / validated payloads
* controller inputs
* Eloquent casts / fillable / relationships
* Resources / transformers / JSON arrays
* migrations / schema
* TypeScript interfaces / types / Zod schemas
* React Query consumers
* Blade / MJML variables where reliable

Edges look like:

* `VALIDATES_FIELD`
* `READS_FIELD`
* `WRITES_FIELD`
* `SERIALIZES_FIELD`
* `DERIVES_FROM_COLUMN`
* `INVALIDATES_KEY`
* `TESTS_SHAPE`

This one graph would supercharge all four skills:

* `$query`: “where does `ticket.status` actually come from?”
* `$implement`: “add field X everywhere it must exist”
* `$review`: “you added validation but forgot serialization”
* `$debug`: “backend emits field, frontend still reads old name”

This is your next deterministic bridge layer after endpoints and permissions.

### 4. Add an `EpisodeGraph`, the living context brain

Prometheus is useful here because its real insight is not “graphs are good.” It is that the agent stops wasting time once it keeps a working memory of **query-relevant repository artifacts and evolving repair state** instead of repeatedly re-discovering them. ([arXiv][3])

So GitNexus should have a sidecar **episode graph**, separate from the base repo index:

* opened slices
* opened spans
* accepted/rejected hypotheses
* failing tests
* error strings / stack traces
* chosen precedents
* current edit set
* current target branch / task id
* last proven witness paths

I would **not** put this in the main Kuzu file if that complicates MCP read-only pooling. Make it a sidecar overlay, then merge it at query time.

This is how the system becomes “living” without corrupting the durable fact graph.

## Power boosters that make it feel supernatural

### Precision overlay: stack graphs / SCIP / LSP

I would not replace your tree-sitter pipeline. I would add an **precision overlay**.

Why this fits:

* GitHub’s stack graphs target precise code navigation **without requiring repo-specific configuration or a build/CI job**, and GitHub says they power precise TypeScript navigation too. ([The GitHub Blog][4])
* SCIP is a language-agnostic protocol with indexers for TS/JS and PHP, among others, and Sourcegraph uses package/version-aware symbol identities for cross-repo resolution. ([GitHub][2])

In GitNexus terms:

* native pipeline stays the base
* overlay can *upgrade* ambiguous resolution where local tools exist
* overlay never gets to flood the graph with lower-trust junk
* provenance must record whether an edge came from native parsing, precision overlay, or heuristic inference

That would materially improve `$query`, `$review`, rename-quality, and symbol disambiguation in TS/PHP-heavy codebases.


----PRECISION OVERKAY PRODUCER STEP----

Yes. I would treat the missing **producer** as a real architecture gap and build it now. A consumer-only hook is a turbo inlet with no air pipe: technically present, operationally awkward. **SCIP** is already a language-agnostic indexing format with a schema, CLI, and bindings, and its protobuf explicitly allows complementary information from multiple sources to be merged into one code-intel view. **LSP** is a live JSON-RPC protocol between a tool and a language server, so it fits better as an on-demand probe than as your canonical persisted artifact. And **stack-graphs** is now archived and read-only, so I would keep that adapter experimental instead of making it the center beam. ([GitHub][1])

My recommendation is not “build all producers at once.” It is:

1. **Define one normalized precision snapshot format**
2. **Ship a SCIP producer first**
3. **Run it from `analyze` automatically**
4. **Validate in shadow mode on the real monorepo**
5. **Only then add LSP probe mode**
6. **Keep stack-graphs behind an experimental flag** ([GitHub][2])

Why **SCIP first**: for your stack, there is an official `scip-typescript` indexer that supports TypeScript projects rooted at `tsconfig.json`, plus Yarn and pnpm workspaces, which makes it a very good fit for monorepo analyze validation. For PHP, there is a community `scip-php` indexer that expects `composer.json`, `composer.lock`, and an installed autoloader in the project root, so it is a reasonable phase-two adapter for the Laravel side. ([GitHub][2])

## What I would build

### 1. A normalized producer contract

Not raw SCIP in your runtime. Not raw LSP responses either. Normalize all precision inputs into one versioned artifact, ideally **JSONL/chunked JSON**, not one giant blob, because SCIP indexes can be large and are designed for streaming consumption. ([GitHub][3])

```ts
type PrecisionSnapshotV1 = {
  schemaVersion: 1
  workspaceRoot: string
  producer: {
    kind: 'scip' | 'lsp' | 'stack-graph'
    mode: 'batch' | 'probe'
    name: string
    version?: string
    runId: string
    generatedAt: string
  }
  documents: Array<{
    path: string
    language?: string
    positionEncoding?: 'utf8' | 'utf16' | 'utf32'
  }>
  symbols: Array<{
    externalId: string
    displayName?: string
    kind?: string
    path: string
    range: [number, number, number, number]
    enclosingExternalId?: string
    isLocal?: boolean
  }>
  occurrences: Array<{
    externalId: string
    path: string
    range: [number, number, number, number]
    roles: Array<'definition' | 'reference' | 'implementation' | 'import'>
  }>
  relations: Array<{
    type:
      | 'DEFINES'
      | 'REFERENCES'
      | 'IMPLEMENTS'
      | 'OVERRIDES'
      | 'TYPE_DEFINITION'
      | 'IMPORTS'
    fromExternalId: string
    toExternalId: string
    path?: string
    range?: [number, number, number, number]
    precisionTier: 'compiler' | 'language-server' | 'dsl'
    confidence: number
    evidence?: string[]
  }>
  unresolved: Array<{
    path: string
    range: [number, number, number, number]
    reason: string
  }>
}
```

The important part is not the JSON shape itself. It is the **provenance discipline**:

* where this came from
* how precise it is
* whether it is batch or probe data
* whether it should promote an edge, annotate an edge, or just help ranking

### 2. Producer adapters, in this order

**Adapter A: `scip-typescript`**
This should be your first real producer because it matches your monorepo frontend world and already supports workspace-style indexing. ([GitHub][2])

**Adapter B: `scip-php` or custom PHP bridge**
Useful for Laravel once the TS lane is proven. I would keep it optional at first and evaluate quality on your repo, not by theory alone. ([GitHub][4])

**Adapter C: LSP probe producer**
Not a full persisted producer. A **targeted resolver** for:

* changed files
* ambiguous symbols
* high-value rename/disambiguation cases
* debug-time probes

That is because LSP is fundamentally a request/response protocol with negotiated capabilities, which makes it a better live supplement than a stable source-of-truth artifact. That is an inference from the protocol shape, and it is exactly why I would not make LSP your primary batch lane. ([Microsoft GitHub][5])

**Adapter D: stack-graphs importer**
Experimental only. Useful if you want to harvest extra name-resolution evidence from languages where you can generate it, but I would not anchor the architecture to a repo GitHub has archived and marked unsupported. ([GitHub][6])

## Where it plugs into `analyze`

I would wire it like this:

```text
scan
-> parse definitions
-> build base symbol table
-> precision producers (parallel, optional)
-> normalize snapshots
-> align external symbols to GitNexus node ids
-> arbitration / promotion
-> imports + calls + heritage with overlay assist
-> semantic processors
-> persist graph + overlay tables
-> communities / processes / derived views
```

The key choice here is **alignment before promotion**.

That means:

* your native graph stays the spine
* overlay data upgrades certainty where it can
* unresolved overlay facts remain attached as evidence, not pollution

So instead of replacing `call-processor`, you let it consult:

1. native deterministic resolution
2. exact overlay match by file/span
3. exact overlay match by qualified symbol
4. only then existing heuristics

That preserves your trust invariant.

## How arbitration should work

I would add a small policy engine:

* **Native deterministic edge wins**
* **Overlay precise edge may fill a gap**
* **Overlay never deletes a native edge**
* **Probe-mode LSP evidence never becomes a top-tier edge without corroboration**
* **Every promoted edge gets provenance**

  * `source = native | scip | lsp | stack-graph`
  * `precision = deterministic | precise-overlay | assisted | heuristic`
  * `witness = file/range or external symbol ids`

This matters because your tools should later be able to say:

* “deterministically known”
* “precision-overlay confirmed”
* “heuristically inferred”

That distinction is gold dust for `$review` and `$debug`.

## What `analyze` should own

Yes, `analyze` should own the whole lifecycle. No manual handoff.

I would make it:

* discover producers
* run them
* cache artifacts
* invalidate them
* import them
* report overlay stats

Something like:

```bash
gitnexus analyze --precision-overlay=auto
gitnexus analyze --precision-overlay=scip
gitnexus analyze --precision-overlay=shadow
gitnexus analyze --precision-overlay=lsp-probe
```

And store per-run artifacts in something like:

```text
.gitnexus/
  kuzu/
  meta.json
  precision/
    runs/<hash>/
      snapshot.jsonl
      stats.json
      producer-meta.json
```

Cache keys should include:

* repo commit / dirty fingerprint
* relevant lockfiles
* tsconfig / workspace config
* composer.lock
* producer version
* normalization schema version

## How to validate it end-to-end

Yes, validate with the real monorepo `analyze` flow, not just fixtures. I would do it in three gates.

### Gate 1: tiny goldens

Small repos that prove:

* symbol alignment
* definition/reference mapping
* implementation/override mapping
* no duplicate promotion
* no cross-app hallucinations

### Gate 2: monorepo shadow mode

Run native analyze and overlay analyze side by side.
Do **not** let overlay change ranking or tool output yet. Measure:

* aligned symbols %
* promoted precise edges
* ambiguous native edges resolved by overlay
* bad promotions
* runtime overhead
* cache hit rate

### Gate 3: tool-quality deltas

Promote only if it improves what matters:

* `$query`: fewer files opened per successful answer
* `$review`: more real gaps, fewer noisy callouts
* `$implement`: better precedent matching / companion-file recall
* `$debug`: shorter broken-loop candidate lists

That last gate is the real scoreboard. Not “more edges,” but “less wandering.”

## The one thing I would not do

I would **not** start with “SCIP/LSP/stack-graph all pour into the same hopper on day one.”

That tends to become a soup cauldron.

Start with:

**`SCIP → normalized snapshot → shadow import → monorepo analyze validation`**

Then add:

* PHP producer
* LSP probe mode
* experimental stack-graphs importer

in that order.

## Bottom line

So yes: **build the producer now**.
Your instinct is right. The consumer hook alone leaves too much manual ceremony and weakens freshness, provenance, and testing.

The path I’d choose is:

**SCIP-first producer, normalized JSONL snapshot, analyze-owned lifecycle, shadow validation on the real monorepo, then selective promotion.**

That turns the precision overlay from a decorative socket into a real power rail.

[1]: https://github.com/sourcegraph/scip "GitHub - sourcegraph/scip: SCIP Code Intelligence Protocol"
[2]: https://github.com/sourcegraph/scip-typescript "GitHub - sourcegraph/scip-typescript: SCIP indexer for TypeScript and JavaScript"
[3]: https://raw.githubusercontent.com/sourcegraph/scip/main/scip.proto "raw.githubusercontent.com"
[4]: https://github.com/davidrjenni/scip-php "GitHub - davidrjenni/scip-php: SCIP Code Intelligence Protocol (SCIP) indexer for PHP"
[5]: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ "Specification"
[6]: https://github.com/github/stack-graphs "GitHub - github/stack-graphs: Rust implementation of stack graphs"


### Targeted micro-dataflow, not whole-repo dataflow soup

CodeQL’s separation between AST and data-flow graphs, its local/global distinction, API graphs, and context-sensitive call-graph work all point to the same lesson: use **bounded semantic traces**, not omniscient whole-program flow everywhere. Semgrep’s cross-file analysis story lands in the same place, interfile reasoning is powerful, but expensive and best used selectively. ([CodeQL][5])

So I would add targeted overlays for only high-value flows:

* request field → validator → controller → model/resource
* query key factory → mutation → invalidation/writeback → consumer
* event payload → listener → notification/job
* permission slug derivation chains
* route param / model binding / serializer field closure

This is a **debug multiplier**. It helps corner the open loop without turning your index into a static-analysis moonbase.

### Generalize literal nodes into a `ValueGraph`

You already did this brilliantly with permission slugs and endpoints.

Keep going.

Make first-class nodes for:

* cache keys
* feature flags
* config keys
* env vars
* queue names
* broadcast channels
* event names
* command names
* table/column literals when useful
* i18n keys
* route segments / query-key families

A shocking amount of framework glue lives in strings wearing fake mustaches. Pull them into the graph and the agent stops spelunking.

### Add `EvidenceSpan` storage so the agent opens lines, not files

LSIF models navigation around **ranges** and graph edges, partly to keep emitted data compact. That is a very good design steal. ([Microsoft GitHub][6])

For GitNexus, every meaningful node/edge should have:

* primary defining span
* witness spans
* proof spans for why this result was returned

Then every skill should return:

* a small subgraph
* exact spans
* a proof path

Not: “open these 14 files.”

This one change saves tokens more directly than many fancier retrieval ideas.

### Add provenance edges for generated and derived artifacts

Kythe’s alias edges and generated-code `generates` / `imputes` model are worth stealing. They show how to connect aliases and derived artifacts back to the real source of truth. ([Kythe][7])

In GitNexus, that means first-class provenance for:

* resource route expansion
* enum-to-slug expansion
* config-driven behavior
* generated client types
* compiled or transformed artifacts
* framework-derived handlers / middleware behavior

The agent should learn: **edit the source, not the echo**.

### Add structured hierarchical summaries, but only as overlays

Code-Craft/HCGS argues for bottom-up summaries built from the dependency graph, and that fits your existing communities/processes/archetypes substrate very well. ([arXiv][8])

I would generate structured summaries at:

* symbol
* file
* slice
* community
* process
* archetype

But make them structured, not prose blobs:

* responsibilities
* inbound callers
* downstream effects
* auth/cache/shape contracts
* typical companions
* known sibling precedents

Then embed **those**, not just raw code.

### Add a graph-expectation DSL

Semgrep join mode is a nice design cue because it lets you ask whole-codebase questions by joining multiple rule results across files. GitNexus should have its own graph-native expectation DSL. ([Semgrep][9])

Examples:

* mutation touching shape `Ticket` should invalidate query family `tickets/*`
* endpoint in `admin/*` surface should have auth closure
* resource field conditioned on relation should point to a real relation edge
* UI action that calls route name X should land in an endpoint slice with matching permission closure

Those rules should compile into `Gap` nodes, not live only in prompt text.

## How the four skills should actually run

The four skills should be **four heads on one retrieval kernel**, not four giant prompt recipes.

### `$query`

Planner:

1. classify intent: entity, contract, symptom, natural-language concept
2. do exact lookup first: symbol, alias, literal, route, endpoint, permission, field
3. only then do guided graph exploration
4. return one or two slices with proof spans

RANGER’s split between fast entity lookup and guided graph exploration is the right instinct here. ([arXiv][1])

### `$review`

Planner:

1. map diff to changed spans and slices
2. attach closure templates
3. compute semantic delta by relation family: auth, shape, cache, test, event, template
4. materialize/rank gaps
5. compare against nearest healthy sibling slice
6. return proof pack + exact tests/spans

This becomes **stencil matching**, not checklist prompting.

### `$implement`

Planner:

1. classify task into archetype + target slice family
2. retrieve 2 to 3 closest precedent slices
3. produce companion set from closure + history + shape graph
4. open exact witness spans in write order
5. after edits, auto-run `$review` kernel on the changed slices

This becomes **slice cloning with adaptation**.

### `$debug`

Planner:

1. classify symptom: stale UI, 403, wrong field, null, routing bug, missing update, queue/event issue
2. anchor symptom into the graph via literals, failing tests, stack traces, route names, query keys, endpoints, fields
3. build candidate broken loops
4. diff against nearest working sibling or archetype
5. rank missing/contradictory edges by confidence and symptom fit

This becomes **closed-loop break localization**.

## Build order I would choose

### Phase 1: highest ROI, lowest risk

* `EvidenceSpan` / witness-span store
* `ValueGraph`
* `FeatureSlice`
* `ClosureTemplate`
* `GapGraph`
* provenance metadata upgrade on edges:

  * certainty tier
  * provenance family
  * absence semantics
  * witness path ids

### Phase 2: the unfairness jump

* `ShapeGraph`
* `TestCase` nodes and static test closure
* git-history cochange graph
* precedent mining 2.0 from slices, not just processes
* episode graph sidecar

### Phase 3: precision and surgical semantics

* stack-graph / SCIP / LSP overlay
* targeted micro-dataflow
* graph expectation DSL
* richer semantic diffs in review/debug

## Guardrails, so the graph stays clean

* **Deterministic beats typed, typed beats historical, historical beats semantic**
* **Absence is not evidence** unless that relation family is declared closed-world
* **Do not global-dataflow the universe**
* **Do not let empirical cochange outrank real contract edges**
* **Do not edit derived artifacts if a provenance edge points upstream**

## The essence

Your next leap is **not** “better search.”

It is:

* facts
* expectations
* provenance
* episode memory

And remember to use TDD all the way through these phases of development.
Do not worry about the 4 skills yet, we will create them after this project is fully complete.

Once you add those, the four skills stop acting like prompt wrappers around search and start acting like **graph-native operating modes**.

That is where it gets unfair.

[1]: https://arxiv.org/abs/2509.25257 "https://arxiv.org/abs/2509.25257"
[2]: https://github.com/sourcegraph/scip "https://github.com/sourcegraph/scip"
[3]: https://arxiv.org/html/2507.19942v2 "https://arxiv.org/html/2507.19942v2"
[4]: https://github.blog/open-source/introducing-stack-graphs/ "https://github.blog/open-source/introducing-stack-graphs/"
[5]: https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/ "https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/"
[6]: https://microsoft.github.io/language-server-protocol/overviews/lsif/overview/ "https://microsoft.github.io/language-server-protocol/overviews/lsif/overview/"
[7]: https://kythe.io/docs/schema/ "https://kythe.io/docs/schema/"
[8]: https://arxiv.org/html/2504.08975v1 "https://arxiv.org/html/2504.08975v1"
[9]: https://semgrep.dev/docs/writing-rules/experiments/join-mode/overview "https://semgrep.dev/docs/writing-rules/experiments/join-mode/overview"

Please record your progress here:
Checklist - steps/phases complete:
- [x] Step 1 (`FeatureSlice` + closure slots) — completed on 2026-02-28
- [x] Step 2 (`GapGraph` + absence tiers) — completed on 2026-02-28
- [x] Step 3 (`ShapeGraph` for field/payload contracts) — completed on 2026-02-28
- [x] Step 4 (`EpisodeGraph` sidecar working memory) — completed on 2026-02-28
- [x] Step 5 (`TestCase` nodes + static test closure) — completed on 2026-02-28
- [x] Step 6 (`git-history cochange graph`) — completed on 2026-02-28
- [x] Step 7 (`precedent mining 2.0 from slices, not just processes`) — completed on 2026-02-28
- [x] Step 8 (`stack-graph / SCIP / LSP overlay`) — completed on 2026-02-28
- [x] Step 9 (`precision overlay producer lifecycle`) — completed on 2026-02-28
- [x] Step 10 (`targeted micro-dataflow overlays`) — completed on 2026-02-28
- [x] Step 11 (`graph expectation DSL`) — completed on 2026-02-28
- [x] Step 12 (`richer semantic diffs in review/debug`) — completed on 2026-02-28
- [x] Step 13 (`ValueGraph` literal-node generalization) — completed on 2026-02-28
- [x] Step 14 (`EvidenceSpan` storage for line-level proof spans) — completed on 2026-02-28
- [x] Step 15 (`provenance edges for generated/derived artifacts`) — completed on 2026-02-28
- [x] Step 16 (`structured hierarchical summaries as overlays`) — completed on 2026-02-28
- [x] Step 17 (`ClosureTemplate overlays per slice family`) — completed on 2026-02-28
- [x] Step 18 (`edge provenance metadata upgrade`) — completed on 2026-02-28
- [x] Step 19 (`DBTable/DBColumn shape-graph bridge nodes`) — completed on 2026-02-28
- [x] Step 20 (`ValueGraph literal-family expansion`) — completed on 2026-02-28
- [x] Step 21 (`ValueGraph deterministic family coverage + incremental parity`) — completed on 2026-02-28
- [x] Step 22 (`review_mode proof-pack evidence spans`) — completed on 2026-02-28
- [x] Step 23 (`query intent planner + slice cards + proof spans`) — completed on 2026-02-28
- [x] Step 24 (`review_mode slice stencil + closure-template deltas`) — completed on 2026-02-28
- [x] Step 25 (`action_plan implement kernel planner`) — completed on 2026-02-28
- [x] Step 26 (`debug_mode broken-loop localization kernel`) — completed on 2026-02-28
- [x] Step 27 (`query_mode exploration kernel wrapper`) — completed on 2026-02-28
- [x] Step 28 (`implement_mode execution planner wrapper`) — completed on 2026-02-28
- [x] Step 29 (`review_mode review-kernel synthesis`) — completed on 2026-02-28
- [x] Step 30 (`mode_router unified kernel dispatcher`) — completed on 2026-02-28
- [x] Step 31 (`mode_router unified handoff envelope`) — completed on 2026-02-28
- [x] Step 32 (`mode_router decision trace + no-query fallback`) — completed on 2026-02-28
- [x] Step 33 (`mode_router EpisodeGraph writeback hardening`) — completed on 2026-02-28
- [x] Step 34 (`CLI kernel-head parity for mode_router/query/review/implement/debug`) — completed on 2026-02-28
- [x] Step 35 (`eval-server kernel-head formatting + guidance parity`) — completed on 2026-02-28
- [x] Step 36 (`HTTP API kernel-head parity via /api/tool`) — completed on 2026-02-28
- [x] Step 37 (`HTTP API tool-dispatch extraction + kernel-head contract test`) — completed on 2026-02-28
- [x] Step 38 (`HTTP API/MCP tool-registry single-source parity`) — completed on 2026-02-28
- [x] Step 39 (`eval-server/MCP tool-registry single-source parity`) — completed on 2026-02-28
- [x] Step 40 (`LocalBackend/MCP dispatch-coverage parity guard`) — completed on 2026-02-28
- [x] Step 41 (`Codex skills scaffold for query/implement/review/debug`) — completed on 2026-02-28

Milestone status:
- Core architecture milestone: **completed at Step 33** on 2026-02-28 (`mode_router EpisodeGraph writeback hardening`).
- Post-core hardening tranche: **Steps 34–40** on 2026-02-28 (CLI/eval-server/HTTP parity and registry/dispatch drift guards).

Progress log:
- 2026-02-28: Materialized `FeatureSlice` nodes from endpoint/permission/query-key anchors, attached `feature-slice:*` `MEMBER_OF` edges, and integrated into full + incremental analyze flows.
- 2026-02-28: Materialized first-class `Gap` nodes with tiered absence semantics (`deterministic_missing`, `pattern_missing`, `heuristic_suspicion`) plus `Gap -> FeatureSlice` `MEMBER_OF` links.
- 2026-02-28: Extended Kuzu schema/storage/API/MCP docs for `Gap` support (schema version `5`, node table + CSV + COPY + graph export/query surfaces).
- 2026-02-28: Materialized `ShapeGraph` foundation with first-class `ContractShape`, `ContractField`, and `CacheKey` nodes plus relation families (`VALIDATES_FIELD`, `SERIALIZES_FIELD`, `INVALIDATES_KEY`, `MEMBER_OF`, `DEFINES`) from FormRequest rules, Resource `toArray` fields, and React Query key/invalidation callsites.
- 2026-02-28: Integrated ShapeGraph into full pipeline and incremental recomputation (`analyze`) and extended Kuzu schema/storage/API/MCP docs for shape/key contracts (schema version `6`).
- 2026-02-28: Materialized `EpisodeGraph` sidecar at `.gitnexus/episode-graph.json` with first-class session memory for opened symbols/processes/spans, hypotheses, failing tests, error strings, chosen precedents, edit set, witness paths, and target branch/task context.
- 2026-02-28: Integrated query-time EpisodeGraph overlay merge (recency/frequency boosts for recently opened symbols + edited files) without mutating Kuzu index state.
- 2026-02-28: Added EpisodeGraph access/update surfaces in MCP (`episode_state`, `episode_update`) and repo resource (`gitnexus://repo/{name}/episode`) while keeping sidecar storage separate from durable fact graph.
- 2026-02-28: Materialized first-class `TestCase` nodes from static test extraction (`it`/`test` callsites + PHPUnit `test_*`/`@test` methods) and linked test files via `DEFINES`.
- 2026-02-28: Added static test closure edges `TESTS_SHAPE` from `TestCase -> ContractShape` using class/file-name evidence matching against extracted request/resource shapes.
- 2026-02-28: Extended Kuzu schema + graph docs for `TestCase` support (schema version `7`, `TestCase` node table, `File -> TestCase`, `TestCase -> ContractShape` relation allowances, MCP schema/docs updates).
- 2026-02-28: Materialized git-history `CO_CHANGES_WITH` edges between `File` nodes from commit-level cochange support (bounded by commit window and per-file neighbor caps) to add empirical companion-signal coverage.
- 2026-02-28: Integrated cochange extraction into both full pipeline and incremental analyze refresh (`MATCH ()-[r:CodeRelation {type: 'CO_CHANGES_WITH'}]->() DELETE r` + reload), while preserving guardrail that historical edges remain lower-confidence than deterministic contract edges.
- 2026-02-28: Updated schema/docs to include `CO_CHANGES_WITH` relation type across Kuzu `REL_TYPES`, MCP schema references, and AI context scaffolding.
- 2026-02-28: Upgraded `precedents` to slice-first retrieval: anchor `FeatureSlice` discovery from symbol/process/hop signals, closure-slot + role-overlap ranking of sibling slices, and cochange-aware scoring when `CO_CHANGES_WITH` evidence exists.
- 2026-02-28: Kept backwards-compatible fallback chain for `precedents` (`slice` → `hop` → `process`) and updated MCP tool docs to describe the new slice-first mining behavior.
- 2026-02-28: Materialized Step 8 precision overlay support via `processPrecisionOverlay` to ingest optional `.gitnexus/precision-overlay.json` relation overlays (stack-graph/SCIP/LSP style), resolve symbol refs by id or file/name/line, and emit confidence-bounded provenance edges using `reason` family `precision-overlay:*`.
- 2026-02-28: Integrated precision overlay into full pipeline before communities/processes and into incremental analyze refresh (delete prior `precision-overlay:*` edges, rebuild overlay edges, reload), so overlays remain deterministic best-effort augmentation without schema changes.
- 2026-02-28: Updated schema/docs scaffolding to expose precision provenance guidance (`precision-overlay:*`) in MCP schema resource and AI context output.
- 2026-02-28: Added first-class precision producer lifecycle via `producePrecisionOverlay` with mode controls (`auto|scip|shadow|lsp-probe|off`), commit/dirty/config cache keys, run artifacts under `.gitnexus/precision/runs/<cache>/` (`snapshot.jsonl`, `overlay.json`, `stats.json`, `producer-meta.json`), and canonical overlay handoff to `.gitnexus/precision-overlay.json`.
- 2026-02-28: Implemented SCIP-first normalization path to convert `scip print --json` index output into `PrecisionSnapshotV1` (documents/symbols/occurrences/relations/unresolved) and map precision relations into importable overlay edges with provenance reasons.
- 2026-02-28: Wired analyze-owned producer execution into both full and incremental flows (`--precision-overlay`, `--precision-overlay-path`, `--precision-overlay-force`) and added summary reporting for imported/declared precision relations plus cache/skip status.
- 2026-02-28: Added shadow/probe guardrails so producer runs can be validated and cached without importing overlay edges into the graph.
- 2026-02-28: Materialized targeted micro-dataflow processor (`processMicroDataflow`) to derive bounded closure edges for request-field/read, response-field/write, endpoint field closure, query invalidation fanout, endpoint→event closures, and endpoint→permission closures using `micro-dataflow:*` provenance reasons.
- 2026-02-28: Integrated targeted micro-dataflow into full pipeline (post-precision, pre-communities) and incremental analyze refresh (delete/rebuild `micro-dataflow:*` edges) with run summaries.
- 2026-02-28: Added Step 11 graph-expectation DSL support in `processGaps`: optional `.gitnexus/graph-expectations.json` rule loading, slice-scoped expectation matching (`closed_slot`, `member_role`, `anchor_edge`, `member_edge`), and rule-driven `Gap` materialization with tier/severity/evidence semantics.
- 2026-02-28: Wired graph-expectation path controls through `analyze`/pipeline (`--graph-expectation-path`) so both full and incremental indexing runs can evaluate the same expectation policy file.
- 2026-02-28: Added Step 12 semantic-diff enrichment in `review_mode`: relation-family deltas (`auth`, `shape`, `cache`, `test`, `event`, `template`) for changed symbols plus slice-linked `Gap` signal rollups (tier/severity counts + top gaps).
- 2026-02-28: Extended `review_mode` summaries/tool docs to include semantic family and gap-signal counts for richer review/debug verification packs.
- 2026-02-28: Materialized Step 13 `ValueGraph` support by promoting literal signals into first-class `ValueNode` nodes (permission slugs, endpoint signatures, route names, cache keys) with `value-graph:*` provenance edges.
- 2026-02-28: Integrated ValueGraph into full + incremental `analyze` flows (post-shape refresh in incremental), including delete/rebuild lifecycle for `ValueNode` + `value-graph:*` relations and run-summary reporting.
- 2026-02-28: Extended schema/storage/API/MCP docs and query surfaces for `ValueNode` support (schema version `8`, CSV/COPY wiring, HTTP graph export, MCP valid label set, schema context/tool docs).
- 2026-02-28: Added `EvidenceSpan` snapshot materialization (`processEvidenceSpans`) to produce per-symbol primary spans and per-edge witness/proof spans, with deterministic stats for node/edge/span coverage.
- 2026-02-28: Added sidecar storage lifecycle at `.gitnexus/evidence-spans.json` and integrated refresh into both full and incremental `analyze` flows so line-level proof ranges stay synchronized with index updates.
- 2026-02-28: Exposed EvidenceSpan retrieval across MCP/API surfaces (`evidence_spans` tool, `gitnexus://repo/{name}/evidence` resource, `/api/evidence`) and updated context/schema docs to advertise line-level proof/witness anchors.
- 2026-02-28: Materialized Step 15 provenance processing via `processProvenanceEdges`, emitting `DERIVES_FROM` ancestry edges with `provenance:*` reasons for route expansion (file/handler), enum-to-slug expansion, config-driven behavior, framework-derived middleware permission links, and compiled template/file artifacts.
- 2026-02-28: Integrated provenance refresh into both full pipeline and incremental analyze flows (delete/rebuild `provenance:*` edges, reload, and summarize emitted edge families), and extended schema/docs/test coverage for `DERIVES_FROM` including `CodeElement -> File` allowances.
- 2026-02-28: Materialized Step 16 structured-summary overlay generation via `processStructuredSummaryOverlay` to emit deterministic, non-prose summaries for symbol/file/slice/community/process/archetype levels with responsibilities, inbound/downstream contracts, auth/cache/shape signals, companions, and sibling precedent hints.
- 2026-02-28: Added summary overlay sidecar lifecycle at `.gitnexus/summary-overlays.json`, integrated refresh into both full and incremental `analyze` flows, and exposed read surfaces via MCP (`summary_overlay` tool, `gitnexus://repo/{name}/summaries` resource) and HTTP (`/api/summaries`).
- 2026-02-28: Materialized Step 17 closure-template overlays via `processClosureTemplates` to derive per-slice-family closure expectations (required/optional slots, role coverage, exemplar slices, average closure score) from `FeatureSlice` + `feature-slice:*` membership signals.
- 2026-02-28: Added closure-template sidecar lifecycle at `.gitnexus/closure-templates.json`, integrated refresh into both full and incremental `analyze` flows, and exposed read surfaces via MCP (`closure_templates` tool, `gitnexus://repo/{name}/closure-templates` resource) and HTTP (`/api/closure-templates`).
- 2026-02-28: Materialized Step 18 edge metadata normalization via `enrichRelationshipMetadata` so every relation carries `certaintyTier`, `provenanceFamily`, `absenceSemantics`, and stable `witnessPathIds` defaults in the in-memory graph and CSV export path.
- 2026-02-28: Extended CodeRelation storage/query surfaces for edge metadata (schema version `9`, relation CSV/COPY + fallback insert fields, HTTP graph export fields, MCP schema/tool docs, and AI context schema notes).
- 2026-02-28: Materialized Step 19 `ShapeGraph` DB bridge nodes by extending `processContractShapes` with migration extraction for `DBTable`/`DBColumn`, `File -> DBTable` + `DBColumn -> DBTable` contract edges, and `ContractField -> DBColumn` `DERIVES_FROM_COLUMN` links using field/table hint arbitration.
- 2026-02-28: Extended schema/storage/query surfaces for DB contract nodes (schema version `10`, `DBTable`/`DBColumn` node tables + CSV/COPY wiring, ContractField/DB relation allowances, incremental shape refresh deletion/reinsert lifecycle, and API/MCP/AI context label docs).
- 2026-02-28: Materialized Step 20 ValueGraph literal-family expansion by deriving additional `ValueNode` types (`role_slug`, `query_key_family`, `route_segment`, `table_name`, `table_column`) from deterministic role/codeelement signals, cache key families, route-name edges, and `DBTable`/`DBColumn` bridge nodes.
- 2026-02-28: Extended incremental/full `analyze` value-graph summaries with family-level counters (role/query-family/route-segment/table/table-column) to expose expanded literal coverage directly in run reports.
- 2026-02-28: Materialized Step 21 ValueGraph deterministic-family coverage by deriving additional `ValueNode` types for `feature_flag`, `config_key`, `env_var`, `queue_name`, `broadcast_channel`, `event_name`, `command_name`, and `i18n_key` from deterministic `CodeElement` prefix signals plus class/file-path conventions (`Events`, `Console/Commands`, `Jobs`, `Broadcasting`).
- 2026-02-28: Added incremental/full parity for DB-backed value extraction by loading `DBTable`/`DBColumn` nodes (including `tableName`/`columnName` properties) into incremental ValueGraph recomputation, and extended run summaries with the new family counters.
- 2026-02-28: Materialized Step 22 review proof-pack support by extending `review_mode` with an EvidenceSpan-backed `proof_pack` payload (changed-symbol spans + sampled semantic-edge witness/proof spans + witness path IDs) and summary counters for proof-symbol/proof-edge coverage.
- 2026-02-28: Extended `review_mode` tool schema with `include_evidence_spans` and `limit_evidence` knobs, and propagated settings through `_review_mode.knobs` for deterministic replay of review payload shape.
- 2026-02-28: Materialized Step 23 query planner upgrades by adding intent classification + exact entity lookup before hybrid retrieval, then returning `query_plan` diagnostics to expose intent and retrieval mode decisions.
- 2026-02-28: Extended query output/tool schema with slice-first `slice_cards` (closure/gap signals + matched members) and optional EvidenceSpan-backed slice proof spans via `include_slice_cards` / `limit_slices` / `include_evidence_spans` / `limit_evidence`.
- 2026-02-28: Materialized Step 24 review stencil matching by mapping changed symbols to `FeatureSlice` capsules, attaching closure-template expectations, and returning per-slice missing required slots/roles plus closure-score deltas.
- 2026-02-28: Extended `review_mode` output/tool schema with `slice_stencil` payloads (changed slices, sibling precedents, gap-signal rollups) and replay knobs `include_slice_stencil` / `limit_slice_stencil`.
- 2026-02-28: Materialized Step 25 implement-kernel planning in `action_plan`: target intent/archetype + target slice selection, precedent retrieval, companion-file synthesis from slice membership + cochange + shape edges, and ordered write anchors.
- 2026-02-28: Added `implement_plan.post_edit_review` contract so implement flows hand off directly to `review_mode` with slice-stencil/evidence enabled after edits.
- 2026-02-28: Materialized Step 26 `debug_mode` planner with symptom classification (`auth/cache/shape/routing/event`), anchored loop candidates (HTTP chain/cache coverage/slice gaps), and ranked findings by symptom fit + confidence.
- 2026-02-28: Added sibling precedent diff + actionable debug handoff (`context`/`impact`/`review_mode`) and integrated episode memory capture for `debug_mode` anchors/hypotheses.
- 2026-02-28: Materialized Step 27 `query_mode` exploration wrapper that packages `query` intent diagnostics, top slice cards, process/symbol anchors, sibling precedents, and compact action hints in one response.
- 2026-02-28: Integrated `query_mode` into MCP dispatch/tool schemas/context resources and added episode memory capture + targeted contract test coverage.
- 2026-02-28: Materialized Step 28 `implement_mode` wrapper that consolidates implement target anatomy, closure template signals, ranked companion files, ordered write anchors, and post-edit review contract into a single response.
- 2026-02-28: Integrated `implement_mode` into MCP dispatch/tool schemas/context resources and added episode memory capture + targeted contract test coverage.
- 2026-02-28: Materialized Step 29 review-kernel synthesis in `review_mode` with deterministic risk scoring, top findings, hypothesis generation, and action sequencing over semantic gap + slice stencil signals.
- 2026-02-28: Extended `review_mode` outputs/docs/tests to include `review_kernel` guidance payloads for fast triage after diff analysis.
- 2026-02-28: Materialized Step 30 `mode_router` dispatcher to auto-route requests into `query_mode` / `implement_mode` / `review_mode` / `debug_mode` using explicit mode or intent signals.
- 2026-02-28: Integrated `mode_router` into MCP dispatch/tool schemas/context resources and added targeted contract test coverage for auto + explicit routing.
- 2026-02-28: Materialized Step 31 `mode_router` unified handoff envelope with normalized primary symbols/files, findings, hypotheses, next actions, risk summary, and recommended follow-up tool handoff.
- 2026-02-28: Extended `mode_router` docs/tests to assert unified envelope stability across auto and explicit routing paths.
- 2026-02-28: Materialized Step 32 `mode_router` decision trace with scored mode candidates/reasons and deterministic fallback metadata for route selection replay.
- 2026-02-28: Hardened `mode_router` auto behavior to route no-query/no-symptom requests to `review_mode` (instead of query error) and extended tests for fallback + trace assertions.
- 2026-02-28: Materialized Step 33 `mode_router` EpisodeGraph writeback hardening so route-candidate reasoning, handoff intent, unified hypotheses, failing tests, and error strings are auto-recorded into episode working memory.
- 2026-02-28: Materialized Step 34 direct CLI kernel-head parity by adding `query-mode`, `implement-mode`, `review-mode`, `debug-mode`, and `mode-router` commands that map 1:1 to MCP kernel tool params (including path-prefix/failing-test/error-string controls).
- 2026-02-28: Added CLI integration coverage for `mode-router` command output envelope + routing behavior (`status`, selected mode, unified envelope, route trace).
- 2026-02-28: Materialized Step 35 eval-server kernel parity by adding compact formatters and next-step hints for `query_mode`, `implement_mode`, `review_mode`, `debug_mode`, and `mode_router`, plus startup endpoint visibility for these heads.
- 2026-02-28: Added eval-server formatter tests to lock readable kernel summaries and actionable hint coverage for router + head outputs.
- 2026-02-28: Materialized Step 36 HTTP API kernel parity with `GET /api/tools` + `POST /api/tool/:name`, default repo fallback, and LocalBackend-backed dispatch for `query_mode` / `implement_mode` / `review_mode` / `debug_mode` / `mode_router` (plus existing tools).
- 2026-02-28: Added HTTP API integration coverage proving tool discovery, `mode_router` JSON envelope retrieval, and unknown-tool rejection semantics.
- 2026-02-28: Materialized Step 37 HTTP API tool-dispatch extraction via `HTTP_API_TOOL_NAMES` + `callHttpApiTool(...)` in `api.ts`, so `/api/tools` and `/api/tool/:name` share one deterministic validation/default-repo dispatch contract.
- 2026-02-28: Added no-socket HTTP API dispatch contract coverage in `test/http-api-tool-dispatch.test.js` for kernel-head availability, `mode_router` envelope retrieval, and unknown-tool rejection semantics.
- 2026-02-28: Materialized Step 38 HTTP API/MCP registry parity by deriving `HTTP_API_TOOL_NAMES` directly from `GITNEXUS_TOOLS` and enforcing lookup via a shared name-set, eliminating duplicate tool-name lists across surfaces.
- 2026-02-28: Extended `test/http-api-tool-dispatch.test.js` to assert HTTP `/api/tools` exposure stays in exact parity with MCP tool definitions.
- 2026-02-28: Materialized Step 39 eval-server/MCP registry parity by deriving `EVAL_SERVER_TOOL_NAMES` directly from `GITNEXUS_TOOLS`, adding centralized eval tool-name validation (`resolveEvalToolName`), and exposing `GET /tools` for deterministic tool discovery.
- 2026-02-28: Extended eval-server coverage to assert tool-registry parity and unknown-tool/missing-tool rejection semantics via exported resolver helpers.
- 2026-02-28: Materialized Step 40 LocalBackend dispatch guard by checking MCP-declared tool names in `callTool` default handling and surfacing explicit `Tool handler not implemented` errors for registry/dispatcher drift instead of generic unknown-tool failures.
- 2026-02-28: Added `test/local-backend-tool-dispatch-parity.test.js` to probe every MCP tool through LocalBackend and assert dispatch-path recognition (no unknown/not-implemented rejections) against a real indexed temp repo.
- 2026-02-28: Materialized Step 41 codex skill scaffolds for kernel-native workflows by adding `.claude/skills/gitnexus/query|implement|review|debug/SKILL.md` with startup preflight and stale-index refresh guidance.
- 2026-02-28: Updated `AGENTS.md` skill-routing table so future agents map directly to kernel heads (`query_mode`, `implement_mode`, `review_mode`, `debug_mode`) before legacy exploratory/refactor workflows.
- 2026-02-28: Validation passed via `npm run build` and targeted tests:
  - `npm run build`
  - `node --test test/git-history-cochange-processor.test.js`
  - `node --test test/episode-graph.test.js test/query-codeelement.test.js test/review-mode.test.js test/no-registry-refresh.test.js`
  - `node --test test/contract-shape-processor.test.js test/gap-processor.test.js test/feature-slice-processor.test.js test/kuzu-schema.test.js`
  - `node --test test/laravel-route-middleware-authorization.test.js`
  - `node --test test/precedents.test.js test/precedents-hop-fallback.test.js`
  - `node --test test/action-plan-hops.test.js`
  - `node --test test/precision-overlay-processor.test.js`
  - `node --test test/precision-overlay-producer.test.js`
  - `node --test test/micro-dataflow-processor.test.js`
  - `node --test test/gap-processor.test.js`
  - `node --test test/review-mode.test.js`
  - `node --test test/value-graph-processor.test.js test/kuzu-schema.test.js`
  - `node --test test/incremental-indexing.test.js`
  - `node --test test/blade-route-name-incremental.test.js`
  - `node --test test/evidence-span-processor.test.js`
  - `node --test test/provenance-processor.test.js test/kuzu-schema.test.js test/incremental-indexing.test.js test/blade-route-name-incremental.test.js`
  - `node --test test/summary-overlay-processor.test.js test/provenance-processor.test.js test/kuzu-schema.test.js test/incremental-indexing.test.js test/blade-route-name-incremental.test.js`
  - `node --test test/review-mode.test.js test/precedents.test.js`
  - `node --test test/closure-template-processor.test.js test/feature-slice-processor.test.js test/gap-processor.test.js test/summary-overlay-processor.test.js test/provenance-processor.test.js test/kuzu-schema.test.js test/incremental-indexing.test.js test/blade-route-name-incremental.test.js`
  - `node --test test/edge-metadata.test.js test/kuzu-schema.test.js test/incremental-indexing.test.js test/blade-route-name-incremental.test.js`
  - `node --test test/contract-shape-processor.test.js test/kuzu-schema.test.js test/incremental-indexing.test.js test/blade-route-name-incremental.test.js`
  - `node --test test/value-graph-processor.test.js test/incremental-indexing.test.js test/blade-route-name-incremental.test.js`
  - `node --test test/value-graph-processor.test.js test/incremental-indexing.test.js test/blade-route-name-incremental.test.js`
  - `node --test test/review-mode.test.js test/value-graph-processor.test.js test/incremental-indexing.test.js test/blade-route-name-incremental.test.js`
  - `node --test test/query-codeelement.test.js test/path-prefixes.test.js`
  - `node --test test/review-mode.test.js`
  - `node --test test/action-plan-hops.test.js`
  - `node --test test/debug-mode.test.js`
  - `node --test test/query-mode.test.js`
  - `node --test test/implement-mode.test.js`
  - `node --test test/review-mode.test.js`
  - `node --test test/mode-router.test.js`
