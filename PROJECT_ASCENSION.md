# Project Ascension (Active): Monorepo Semantics Laminator

GitNexus’s scope is intentionally narrow:

- Specialize to the **monorepo** (not “generic repo intelligence”).
- Encode the monorepo’s **real abstractions + contracts** as durable **graph nodes/edges**.
- Make the graph + the 4 kernel heads (`query_mode`, `implement_mode`, `review_mode`, `debug_mode`) sufficient for an agent to act like a long-tenured principal engineer in this codebase.

Docs still matter, but the index is the **primary source of semantics**. Written docs are reinforcement, not the mechanism.

## North Star

1. **Accuracy first.** Speed work is only acceptable when it preserves the same semantic signal.
2. **Always-on for monorepo.** If a signal family is valuable, it runs by default — no opt-in flags.
3. **Deterministic guidance.** “Token overlap” is not a guidance system. Findings should attach to explicit guideline/templates via **finding codes** and graph edges.
4. **Cross-stack semantics.** The index must help agents traverse FE↔BE seams: routes → controllers → requests → resources → queries → cache invalidation → UI hooks.

## What “Lamination” Means

GitNexus builds a layered evidence stack. Lower tiers never silently overwrite higher tiers:

1. **Static facts** (symbols, imports, calls, heritage).
2. **Precision overlay facts** (when available and validated).
3. **Derived overlays** (slices/gaps/contracts/value/provenance/summaries/templates/evidence).
4. **Historical affinity** (git-history cochange edges).
5. **Runtime truth** (ingested runtime snapshots / probe summaries).
6. **Heuristics** (rankers + fallbacks), always labeled as such.

## Always-On Monorepo Indexing (No Opt-In Flags)

For monorepo profile runs, `gitnexus analyze` always performs:

- Full ingestion + all derived overlays.
- Git-history cochange graph (`CO_CHANGES_WITH`).
- Embeddings (monorepo ignores `--skip-embeddings` to avoid degraded ranking).
- A BrainKernel tick (best-effort; writes a manifest; never allowed to fail indexing).

If something is too expensive to be always-on, it should be redesigned/optimized — not hidden behind flags.

## Where Data Lives

Everything is local and worktree-safe:

- Durable graph: `<repo>/.gitnexus/kuzu/`
- Derived snapshots/sidecars: `<repo>/.gitnexus/**` (e.g. runtime observations, closure templates, summary overlays, evidence spans)
- BrainKernel manifest: `<repo>/.gitnexus/manifests/brain.json`
- Embedding cache:
  - Monorepo default: shared global cache at `~/.gitnexus/embedding-cache.jsonl` (worktrees reuse embeddings)
  - Override via `GITNEXUS_EMBEDDING_CACHE_PATH` / `GITNEXUS_EMBEDDING_CACHE_SCOPE`

## How Monorepo Docs Become Graph Semantics

The monorepo’s agent guidance is not just “readme text” — it is parsed into graph entities that kernels can retrieve deterministically:

- `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.agents/...` are parsed into section nodes.
- `.agents/review/pattern-catalog.md` is parsed into template/precedent section nodes.
- Any line like `Finding code: xyz` becomes a `ValueNode` (`valueType = finding_code`) and is linked to the relevant section/template nodes.

This enables stable attachment:

`review finding` → `finding_code` → `guideline section(s)` → `template/example files` (“do this instead” closure)

## What We Deliberately Do Not Optimize For (Yet)

- “General repo OS” ambitions that aren’t directly improving monorepo semantic correctness.
- Large new node families that aren’t consumed by the 4 kernel heads.
- Learned/policy auto-promotion without hard, canary-backed parity gates.

## Active Near-Term Work (Monorepo Semantics)

Concrete improvements that directly reinforce the laminator goal:

- Encode Laravel validation trust boundaries (e.g. post-`validate()` semantics) so redundant sanitize loops can be flagged.
- Raise review precision by converting more override rules into machine-checkable findings (finding codes → guideline sections → templates).
- Improve suggested-test quality by enforcing a confidence floor and suppressing low-signal fallbacks.
- Require runtime snapshot ingestion for perf-focused reviews so kernels can prefer observed hotspots over heuristics.

---

Historical note: the previous long-form “V2 blueprint” was moved to `PROJECT_ASCENSION_BLUEPRINT_ARCHIVE.md` to keep this document strictly aligned to the active, monorepo-focused direction.

