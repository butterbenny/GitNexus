# Project Ascension: Query North Star Metrics

Last updated: 2026-03-02

## Goal Definition (Must Hold)

`query_mode` first-action quality goals:

- `regressed = 0` (mandatory)
- `improved >= 80%` across canary scenarios
- `avg_delta >= +0.10` sustained
- `first_action_coverage >= 90%` (prioritized action present, not null)
- `avg_new >= 0.65`
- `p90 >= 0.80`

`implement_mode` first-action quality goals:

- `regressed = 0` (mandatory)
- `improved >= 80%`
- `avg_delta >= +0.10`
- `first_action_coverage >= 90%`
- `avg_new >= 0.65`
- `p90 >= 0.80`

## Current Baseline (Canary: 2026-03-02)

Source: `reports/monorepo-patterns/canary/first_action_canary_2026-03-02.json`

### query_mode

- `total = 8`
- `improved = 1/8 (12.5%)`
- `regressed = 0/8`
- `avg_old = 0.170`
- `avg_new = 0.186`
- `avg_delta = +0.016`
- Coverage signal: multiple `new_source = null` rows; prioritized candidate absence is diluting quality averages.

### implement_mode

- `total = 8`
- `improved = 8/8 (100%)`
- `regressed = 0/8`
- `avg_old = 0.423`
- `avg_new = 0.501`
- `avg_delta = +0.078`

## Gap To Target

`query_mode` is currently below target on:

- improvement rate (`12.5% < 80%`)
- average uplift (`+0.016 < +0.10`)
- average quality (`0.186 < 0.65`)
- p90 quality target (not met)
- prioritized first-action coverage (below `90%`)

`implement_mode` has strong directional gains but still below quality floor targets (`avg_new` and likely `p90`).

## Query Uplift Plan (Execution Log)

### Phase Q1: Coverage-first prioritized action

Status: `completed (2026-03-02 first pass)`

- Add non-null prioritized-action fallback chain.
- Include `action_hints` as a ranked candidate source.
- Emit reason codes for sparse/zero-signal scenarios.

Expected impact:

- large increase in `first_action_coverage`
- immediate reduction in null/zero rows

### Phase Q2: Adaptive gating + stronger convergence in symbol path

Status: `in_progress`

- Replace fixed candidate thresholds with adaptive floors based on retrieval signal strength.
- Remove symbol convergence handicap by deriving symbol convergence from linked slice/process readiness.

Expected impact:

- increase `avg_new`
- increase `improved%` from sparse scenarios

### Phase Q3: Sparse-case second-pass retrieval

Status: `pending`

- Run bounded second-pass backfill only when pass-1 yields weak/no prioritized candidate.
- Expand candidate pool with cheap route/slice/archetype anchors.

Expected impact:

- push `first_action_coverage` toward `>= 90%`
- improve tail cases and p90 consistency

### Phase Q4: Weight calibration + canary enforcement

Status: `pending`

- Tune first-action ranking weights against monorepo canary set.
- Add pass/fail gate for the numeric targets above.

Expected impact:

- sustained `avg_delta >= +0.10`
- controlled regression risk (`regressed = 0`)

## Success Criteria For This Implementation Cycle

A cycle is complete when:

1. query-mode canary reports `regressed = 0`.
2. prioritized first-action coverage reaches `>= 90%`.
3. improvement rate reaches `>= 80%`.
4. average delta reaches `>= +0.10`.
5. score floor trend is moving toward `avg_new >= 0.65` and `p90 >= 0.80`.

## Latest Canary Snapshot (2026-03-02)

Source:
`reports/monorepo-patterns/canary/first_action_canary_2026-03-02T06-48-36Z_legacy_compare.json`

Method note:
legacy baseline is simulated from each live run (`query_mode` legacy selector + `implement_mode` fixed-rank-scale selector), so old/new comparisons use identical scenario inputs.

### query_mode (legacy vs current)

- `regressed = 0/8` ✅
- `improved = 8/8` (`100%`) ✅
- `avg_old = 0.174` -> `avg_new = 0.551` (`avg_delta = +0.377`) ✅ for delta, not yet at quality floor
- `coverage_old = 3/8 (37.5%)` -> `coverage_new = 8/8 (100%)` ✅
- `p90_old = 0.495` -> `p90_new = 0.862` ✅

Gap still open:

- `avg_new >= 0.65` (current `0.551`, below target)

### implement_mode (legacy vs current)

- `regressed = 0/8` ✅
- `improved = 7/8` (`87.5%`) ✅
- `avg_old = 0.522` -> `avg_new = 0.634` (`avg_delta = +0.112`) ✅
- `coverage_old = 8/8 (100%)` -> `coverage_new = 8/8 (100%)` ✅
- `p90_old = 0.869` -> `p90_new = 0.869` ✅

Gap still open:

- `avg_new >= 0.65` (current `0.634`, marginally below target)
