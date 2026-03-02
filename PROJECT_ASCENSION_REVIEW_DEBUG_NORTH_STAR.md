# Project Ascension: Review + Debug North Star Metrics

Last updated: 2026-03-02 (RD1 rerun)

## Objective

Extend the same measurable quality discipline used for `query_mode`/`implement_mode` to:

- `review_mode`
- `debug_mode`

with explicit score formulas, baseline canaries, and promotion gates.

## Score Definitions (0..1)

### review_mode score

Weighted proxy for first-action review usefulness and proof/actionability quality:

`review_score = 0.40 * top_finding_rank + 0.25 * proof_signal + 0.20 * suggested_test_signal + 0.15 * actionability_signal`

Components:

- `top_finding_rank`: normalized top `review_kernel.findings[0].ranking.score`
- `proof_signal`: normalized proof density (`proof_pack.summary.symbol_spans`, `edge_spans`)
- `suggested_test_signal`: normalized `summary.suggested_tests`
- `actionability_signal`: presence of findings + next actions + suggested tests + proof

### debug_mode score

Weighted proxy for root-cause candidate quality and evidence-backed actionability:

`debug_score = 0.45 * rank_score + 0.20 * route_alignment + 0.20 * root_cause_confidence + 0.15 * evidence_coverage`

Components:

- `rank_score`: prioritized candidate rank (`prioritized_candidate.rank_score` / `_debug_mode.ranking.top_candidate_rank_score`)
- `route_alignment`: prioritized candidate route alignment
- `root_cause_confidence`: confidence claim for root-cause localization
- `evidence_coverage`: candidates present + next actions + runtime evidence + prioritized candidate

## Current Baseline Canary (2026-03-02)

Source:
`reports/monorepo-patterns/canary/review_debug_north_star_2026-03-02T06-54-15Z.json`

### review_mode baseline

- `total = 4`
- `coverage_present = 1/4 (25%)`
- `avg_new = 0.203`
- `p90_new = 0.454`

Baseline interpretation:

- review actionability is sparse on low-risk rule-only diffs.
- most scoped runs produce proof but no findings/test actions.

### debug_mode baseline

- `total = 8`
- `coverage_present = 5/8 (62.5%)`
- `avg_new = 0.404`
- `p90_new = 0.671`

Baseline interpretation:

- debug returns strong ranked candidates for anchored flows,
- but still has zero-candidate pockets in low-signal scenarios.

## North Star Target Numbers

### review_mode targets

- `regressed = 0` (mandatory)
- `improved >= 80%` across canary scenarios
- `avg_delta >= +0.10` sustained
- `coverage_present >= 90%`
- `avg_new >= 0.60`
- `p90_new >= 0.80`

### debug_mode targets

- `regressed = 0` (mandatory)
- `improved >= 80%` across canary scenarios
- `avg_delta >= +0.10` sustained
- `coverage_present >= 90%`
- `avg_new >= 0.65`
- `p90_new >= 0.80`

## Upgrade Plan

### Phase RD1: Coverage-first candidate/finding guarantees

Status: `completed (2026-03-02)`

- Review: ensure at least one prioritized finding/action path even when risk is low and no semantic gaps are detected.
- Debug: add fallback prioritized candidate chain for sparse scenarios (`runtime` -> `route/hop` -> `symbol/process`).

Observed effect (monorepo canary):

- `review_mode` coverage: `25% -> 100%`
- `debug_mode` coverage: `62.5% -> 100%`

Report:
`reports/monorepo-patterns/canary/review_debug_north_star_2026-03-02T07-13-09-945Z.json`

### Phase RD2: Adaptive gating and convergence-aware ranking

Status: `pending`

- Review: adaptive finding/test ranking gates based on diff density and proof coverage.
- Debug: adaptive candidate floors based on symptom certainty + runtime availability.

Expected effect:

- increase `avg_new`, reduce zero/near-zero rows.

### Phase RD3: Runtime-probe closure for uncertainty

Status: `pending`

- Review: auto-micro-probe requests when finding confidence is low.
- Debug: selective runtime probe generation for no-candidate/no-route-align cases.

Expected effect:

- improve `root_cause_confidence` and raise p90.

### Phase RD4: Canary gating + promotion policy

Status: `pending`

- Add hard promotion gates for the target thresholds above.
- Block promotion when any mandatory check regresses.

## Success Criteria

A cycle is complete when both modes hit:

1. `regressed = 0`
2. `improved >= 80%`
3. `avg_delta >= +0.10`
4. `coverage_present >= 90%`
5. mode-specific `avg_new` and `p90_new` targets

## Latest Canary Snapshot (2026-03-02 RD1)

Source:
`reports/monorepo-patterns/canary/review_debug_north_star_2026-03-02T07-13-09-945Z.json`

### review_mode

- `regressed = 0/4` ✅
- `improved = 4/4` (`100%`) ✅
- `coverage_present = 4/4` (`100%`) ✅
- `avg_old = 0.203 -> avg_new = 0.854` (`avg_delta = +0.651`) ✅
- `p90_new = 0.958` ✅

### debug_mode

- `coverage_present = 8/8` (`100%`) ✅
- `avg_old = 0.404 -> avg_new = 0.567` (`avg_delta = +0.163`) ✅
- `p90_new = 0.663` (below target `0.80`) ❌
- per-scenario regressions are small (`~0.006..0.008`) on already-ranked cases; zero-candidate scenarios are now covered via fallback candidates.

Open gap:

- keep full coverage while lifting ranked-case precision (`p90` and `regressed=0` gate in debug suite).
