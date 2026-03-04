# Project Ascension Tech Tree (Active): Monorepo Semantics Lamination

This file is a **capability map of what we actually run and depend on** for the monorepo.
Avoid stale “status dashboards” here — use `gitnexus status` / `gitnexus://repo/*/context` for live stats.

## 0) Entry Points (User/Agent Surface)

- `gitnexus analyze <repo>`: builds/updates the laminated index (graph + derived overlays + embeddings + cochange + BrainKernel manifest).
- `gitnexus runtime-ingest`: writes/updates runtime snapshot sidecars used by review/debug kernels and BrainKernel freshness.
- MCP kernel heads: `query_mode`, `implement_mode`, `review_mode`, `debug_mode` (+ navigation tools: `query`, `context`, `impact`, `precedents`, `closure_templates`, `summary_overlay`, `evidence_spans`).

## 1) Static FactGraph (Always-On)

Durable nodes/edges derived from parsing and lightweight static analysis:

- Nodes: `File`, `Function`, `Class`, `Method`, `Interface`, … (multi-language support tables exist)
- Edges: `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`, `DEFINES`, `CONTAINS`

## 2) Derived Semantic Overlays (Always-On)

Graph-native overlays that turn raw edges into monorepo-useful semantics:

- **Execution flows**: `Process` + `STEP_IN_PROCESS`
- **Feature anatomy**: `FeatureSlice`, `Gap`
- **Contracts**: `ContractShape`, `ContractField`, `CacheKey`, `DBTable`, `DBColumn`
- **Value graph**: `ValueNode` for stable literals (route names, query-key families, permissions, finding codes, etc.)
- **Provenance edges**: derived semantics that connect “what implies what” (framework-driven expansions, config-driven wiring)
- **Evidence spans** and **structured summaries** for proof-carrying review/implement output
- **Closure templates** for slice closure expectations

## 3) Guidance Lamination (Always-On)

Monorepo agent guidance is parsed into graph entities so kernels can link findings deterministically:

- Guideline sections become `CodeElement` nodes.
- `Finding code: ...` becomes `ValueNode{valueType: finding_code}`.
- Edges connect guideline/template sections to codes and to referenced files.
- Pattern catalog (`.agents/review/pattern-catalog.md`) produces template/precedent anchors (“do this instead”).

## 4) Historical Lamination: Git Cochange (Always-On)

- Adds `CO_CHANGES_WITH` edges between `File` nodes based on git history.
- Used as a *supporting* affinity signal (never overwrites higher-trust facts).

## 5) Runtime Lamination (When Available)

- Runtime snapshots live as sidecars under `.gitnexus/` and are ingested via `gitnexus runtime-ingest`.
- Kernels can incorporate runtime hotspots/witnesses (or emit “runtime probe requests” when uncertainty is high).
- BrainKernel publishes runtime freshness in its manifest so agents can see when they’re operating static-only.

## 6) BrainKernel Manifest (Always-On)

Every `analyze` run performs a BrainKernel tick (best-effort) and publishes:

- `.gitnexus/manifests/brain.json`

Current intent:

- Provide a deterministic control-plane summary (freshness, warnings, step results, parity signals).
- Act as a single place to “see what signals are available” before trusting review/implement output.

Non-goals (for now):

- Autonomous learned-policy promotion without strict canary/parity enforcement.

## 7) Kernel Heads Consume the Laminated Graph

- `query_mode`: navigation + anchor selection across monorepo systems
- `implement_mode`: plan + companions + write-order anchored in existing slice anatomy and templates
- `review_mode`: emits finding codes and links them to monorepo guidance/templates; ranks risks by contract impact
- `debug_mode`: broken-loop localization using static + runtime evidence (when present)

## Near-Term Enrichment Targets (Monorepo-First)

- Encode Laravel validation boundaries as explicit semantic signals.
- Convert more override rules into machine-checkable findings (and tie them to finding codes + templates).
- Suppress low-signal suggested tests (return “no confident suggested tests” instead of noise).
- Treat runtime snapshot availability as a perf-review gate (warn or degrade confidence when missing).

