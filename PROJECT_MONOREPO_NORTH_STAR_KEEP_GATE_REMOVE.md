# Monorepo North Star: Keep / Gate / Remove (GitNexus)

Last updated: 2026-03-02

## Goal

Specialize GitNexus for `/Users/benny/monorepo` “1-shot semantics”:

- Precision-first indexing (no “fast but wrong” profile).
- Index + docs + the 4 kernel heads reinforce the monorepo’s own patterns (`.agents/*`, `.claude/*`, override docs).
- Reduce moving parts that do not improve kernel-head correctness or monorepo pattern lamination.

This doc is **not** a deletion plan by itself. It is a scoped “what’s essential?” map so we can gate (first), then delete (later) with confidence.

## Keep (Core)

### Package-level

- `gitnexus/` (CLI + MCP + ingestion + kernels)

### CLI commands (required for monorepo workflow)

- `gitnexus analyze` (index build + derived snapshots + embeddings)
- `gitnexus runtime-ingest` (runtime evidence -> `.gitnexus/runtime-observations.json`)
- `gitnexus mcp` (MCP server)
- Direct tool commands in `gitnexus/src/cli/tool.ts` (kernel heads + supporting tools)

### MCP tools (kernel heads + hard deps)

- Kernel heads: `query_mode`, `implement_mode`, `review_mode`, `debug_mode`
- Supporting: `query`, `precedents`, `action_plan`, `ui_contract`, `closure_templates`, `summary_overlay`, `context`, `impact`, `cypher`

## Gate (Monorepo profile: off by default / not documented)

These can remain in-tree, but should be behind a “non-monorepo” gate (or moved to a separate package) so they don’t add surface area / drift risk to the monorepo-first workflow.

### Packages

- `gitnexus-web/` (web UI + browser-side graph tooling)
- `gitnexus-claude-plugin/` (Claude hooks/skills bundle)
- `gitnexus-cursor-integration/` (Cursor hooks/skills bundle)
- `eval/` (evaluation harness; keep for regressions but not part of “developer uses kernels daily” loop)
- `gitnexus-test-setup/` (fixtures; keep only if tests depend on it)

### CLI commands

- `serve` (web UI server)
- `wiki` (wiki generator, LLM-powered)
- `augment` (hook helper)
- `archetypes` (exploration helper)
- `eval-server` (local eval runner)

### Docs

- Any docs that instruct “general-purpose GitNexus usage” vs monorepo-specific norms.

## Remove (Later, after gating + measurements)

Candidates to delete once:

1) monorepo profile exists, and
2) core kernels/tests don’t depend on them, and
3) we’ve observed no real usage.

- Old skill wrappers / non-kernel skills under `.claude/skills/gitnexus/*` that duplicate kernel head workflows.
- Hook-only CLIs and web-only code that is not part of the monorepo kernel loop.
- Redundant derived pipelines that don’t affect kernel output quality (to be decided from the “Analyze pass map”).

## Next: Analyze Pass Map

### Full pipeline phases (runPipelineFromRepo)

Keep (kernel correctness / monorepo semantics):

- `extracting` (repo scan)
- `structure` (folders + templates/includes)
- `parsing` (definitions)
- `imports` (import resolution)
- `calls` (call graph)
- `laravel wiring` (routes/http/auth/events/notifications/jobs/resources/permissions/query-keys)
- `shapes` (ContractShape/ContractField/CacheKey/DBTable/DBColumn/TestCase + edges)
- `heritage` (extends/implements)
- `precision` (precision overlay; higher-precision edges)
- `microflow` (derived READS/WRITES/VALIDATES/INVALIDATES closure edges)
- `values` (ValueNode literals/contracts)
- `provenance` (derived ancestry edges)
- `communities` (clusters)
- `processes` (execution flows)
- `slices` (FeatureSlice closure)
- `gaps` (closure/template gaps)

Gate (optional, expensive, low-value for daily loop):

- `cochange` (git-history CO_CHANGES_WITH edges)

### Post-Kuzu derived snapshots (analyze.ts)

Keep (kernel output quality / proof):

- evidence spans snapshot
- structured summary overlay snapshot
- closure templates snapshot
- FTS indexes

Keep-but-optimize (speed target: don’t block daily use):

- embeddings pipeline (must not force “skip embeddings” for monorepo; instead speed up)

Gate (optional; complexity risk unless it proves measurable uplift):

- BrainKernel tick / promotion state

### Incremental derived passes (analyze.ts)

These are the incremental “refresh derived overlays” passes; adaptive mode may skip some of them on low-signal changes.

Keep (precision / kernel outputs):

- `precision-overlay`
- `micro-dataflow`
- `shape-graph`
- `value-graph`
- `provenance`
- `slices`
- `gaps`
- `evidence-spans`
- `structured-summaries`
- `closure-templates`

Gate:

- `cochange`
