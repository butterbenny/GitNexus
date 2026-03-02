# Monorepo Carbon-Copy Scan

## Pass 1 (Inventory Baseline)

Generated: 2026-03-01 (America/New_York)
Target repo: `/Users/benny/monorepo`
Index snapshot: 12,164 files, 93,309 symbols, 300 processes

### Artifact bundle
- `reports/monorepo-patterns/pass-1/clusters_top100.json`
- `reports/monorepo-patterns/pass-1/clusters_top100.csv`
- `reports/monorepo-patterns/pass-1/clusters_all_labels.json`
- `reports/monorepo-patterns/pass-1/clusters_all_labels.csv`
- `reports/monorepo-patterns/pass-1/archetypes_all.json`
- `reports/monorepo-patterns/pass-1/archetypes_signatures.csv`
- `reports/monorepo-patterns/pass-1/archetypes_routes.csv`

### Coverage metrics
- Distinct cluster labels discovered: 467
- Top module set captured (resource parity): top 100 clusters by symbol volume
- Archetype signatures discovered: 33
- Cross-stack signatures: 27
- Frontend-only/backend-only signatures: 6
- Cross-stack process coverage: 238/300 (79.3%)
- Non-cross-stack process coverage: 62/300 (20.7%)

### Cluster composition (all labels)
- Backend-only labels: 240
- Frontend-only labels: 86
- Mixed frontend+backend labels: 89
- Unmapped (outside `apps/dashboard|apps/mobile|apps/backend`): 52

### Top 25 clusters by symbol volume
| Rank | Cluster | Symbols | Frontend | Backend | Cohesion | Dominance |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Services | 2412 | 29 | 2383 | 87.84 | backend |
| 2 | Api | 2107 | 1936 | 118 | 80.34 | frontend |
| 3 | Engage | 1289 | 55 | 1234 | 77.94 | backend |
| 4 | Controllers | 720 | 29 | 684 | 91.52 | backend |
| 5 | Campaign | 701 | 15 | 686 | 72.39 | backend |
| 6 | Models | 693 | 4 | 689 | 82.56 | backend |
| 7 | Traits | 548 | 4 | 544 | 68.9 | backend |
| 8 | Actions | 535 | 13 | 522 | 80.83 | backend |
| 9 | Listeners | 496 | 7 | 489 | 77.84 | backend |
| 10 | Checkout | 493 | 5 | 488 | 79.85 | backend |
| 11 | Components | 458 | 122 | 168 | 83.38 | backend |
| 12 | Imports | 410 | 47 | 363 | 82.86 | backend |
| 13 | Dashboard | 407 | 30 | 377 | 86.79 | backend |
| 14 | Jobs | 393 | 1 | 392 | 89.69 | backend |
| 15 | Workflows | 383 | 24 | 359 | 79.33 | backend |
| 16 | Contacts | 383 | 51 | 332 | 80.44 | backend |
| 17 | Filters | 345 | 254 | 91 | 83.53 | frontend |
| 18 | CustomHooks | 338 | 325 | 7 | 69.36 | frontend |
| 19 | ModelFilters | 334 | 2 | 332 | 64.92 | backend |
| 20 | Transaction | 323 | 3 | 320 | 71.01 | backend |
| 21 | Auction | 322 | 25 | 297 | 74.98 | backend |
| 22 | Unit | 306 | 1 | 305 | 72.02 | backend |
| 23 | Auctions | 305 | 14 | 291 | 77.96 | backend |
| 24 | Hooks | 304 | 222 | 29 | 72.7 | frontend |
| 25 | Support | 294 | 0 | 294 | 87.86 | backend |

### Archetype signatures (top 20 by process count)
| Rank | Signature | Processes | Cross-Stack | Primary Route |
| --- | --- | ---: | --- | --- |
| 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model` | 44 | true | `http-get:/api/user/accounts/*` |
| 2 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource` | 43 | true | `http-get:/api/user/accounts/*` |
| 3 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource` | 40 | true | `http-get:/api/user/accounts/*` |
| 4 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Backend` | 37 | true | `http-get:/api/user/accounts/*` |
| 5 | `FE:Page → FE:Hook` | 28 | false | `-` |
| 6 | `FE:Page → FE:Hook → FE:Component` | 27 | false | `-` |
| 7 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Backend` | 14 | true | `http-get:/api/user/accounts/*` |
| 8 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource → BE:Model` | 9 | true | `http-get:/api/user/accounts/*` |
| 9 | `FE:Page → FE:Api → HTTP:GET → BE:Controller → BE:Backend` | 8 | true | `http-get:/api/accounts/*/billing/plans` |
| 10 | `FE:Page → FE:Api → HTTP:GET → BE:Controller → BE:Service → BE:Model` | 8 | true | `http-get:/api/accounts/*/engage-configuration` |
| 11 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model → BE:Backend` | 4 | true | `http-get:/api/campaigns/*` |
| 12 | `FE:Page → FE:Hook → FE:Util` | 4 | false | `-` |
| 13 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Backend` | 4 | true | `http-get:/api/reporting/accounts/*/reports/*` |
| 14 | `FE:Page → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource` | 3 | true | `http-get:/api/accounts/*/messages/*` |
| 15 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:FormRequest` | 3 | true | `http-get:/api/accounts/*/contacts/*` |
| 16 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller` | 2 | true | `http-get:/api/campaigns/*/items/*` |
| 17 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Backend` | 2 | true | `http-get:/api/reporting/accounts/*/reports/*` |
| 18 | `FE:Page → BE:Routes → BE:Controller → BE:Backend` | 2 | true | `-` |
| 19 | `FE:Page → FE:Api → HTTP:GET → BE:Controller → BE:Model` | 2 | true | `http-get:/api/accounts/*/billing/plans` |
| 20 | `FE:Page → FE:Api → HTTP:POST → BE:Backend` | 2 | true | `http-post:/api/accounts/*/quickbooks/refreshMapping` |

### Dominant cross-stack routes
| Rank | Route | Signature Route Count |
| --- | --- | ---: |
| 1 | `http-get:/api/user/accounts/*` | 151 |
| 2 | `http-get:/api/campaigns/*` | 24 |
| 3 | `http-get:/api/accounts/*/engage-configuration` | 9 |
| 4 | `http-get:/api/accounts/*/contacts/*` | 8 |
| 5 | `http-get:/api/accounts/*/messages/*` | 8 |
| 6 | `http-get:/api/accounts/*/billing/plans` | 6 |
| 7 | `http-get:/api/reporting/accounts/*/reports/*` | 6 |
| 8 | `http-get:/api/events` | 4 |
| 9 | `http-post:/api/accounts/*/get_recurring_plans` | 4 |
| 10 | `http-get:/api/campaigns/*/auctions/*` | 3 |
| 11 | `http-get:/api/accounts/*/message_templates` | 2 |
| 12 | `http-get:/api/accounts/*/payouts/summary` | 2 |
| 13 | `http-get:/api/user` | 2 |
| 14 | `http-post:/api/accounts/*/quickbooks/refreshMapping` | 2 |
| 15 | `http-get:/api/accounts/*/quickbooks/details` | 1 |

### Carbon-copy implications (from pass 1)
- The dominant implementation skeleton is cross-stack read flow:
  - `FE:Page -> FE:Hook -> FE:Api -> HTTP:GET -> BE:Controller -> BE:Resource(-> BE:Model)`
- The single highest-leverage route family is `http-get:/api/user/accounts/*`.
- Backend-heavy clusters (`Services`, `Engage`, `Controllers`, `Campaign`, `Models`) should anchor backend lamination templates.
- Frontend-heavy clusters (`Api`, `Filters`, `CustomHooks`, `Hooks`) should anchor UI/query orchestration templates.
- Mixed clusters (for example `Components`, `Finance`, `Integrations`, `Reports`) are likely best candidates for full-stack “carbon copy” feature templates.

## Pass 2 (Lamination Matrix Baseline)

### Artifact bundle
- `reports/monorepo-patterns/pass-2/lamination_matrix.json`
- `reports/monorepo-patterns/pass-2/lamination_matrix.csv`
- `reports/monorepo-patterns/pass-2/lamination_summary.json`
- `reports/monorepo-patterns/pass-2/top_mixed_clusters.json`
- `reports/monorepo-patterns/pass-2/top_archetypes.json`
- `reports/monorepo-patterns/pass-2/process_cluster_map.json`

### Matrix dimensions
- Top mixed clusters selected: 12
- Top archetypes selected: 10
- Matrix cells: 120

### Carbon-copy-ready score distribution
- High: 4
- Medium: 0
- Emerging: 7
- Low: 109
- Cells with non-zero evidence: 11

### Top mixed clusters (by mixed_score)
| Rank | Cluster | Symbols | Frontend | Backend | Mix Ratio | Mixed Score |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Components | 458 | 122 | 168 | 73% | 333 |
| 2 | Finance | 204 | 82 | 122 | 67% | 137 |
| 3 | Api | 2107 | 1936 | 118 | 6% | 128 |
| 4 | Filters | 345 | 254 | 91 | 36% | 124 |
| 5 | Accounts | 195 | 51 | 144 | 35% | 69 |
| 6 | Contacts | 383 | 51 | 332 | 15% | 59 |
| 7 | Engage | 1289 | 55 | 1234 | 4% | 57 |
| 8 | Integrations | 59 | 29 | 30 | 97% | 57 |
| 9 | Imports | 410 | 47 | 363 | 13% | 53 |
| 10 | Triggers | 166 | 40 | 126 | 32% | 53 |
| 11 | Hooks | 304 | 222 | 29 | 13% | 40 |
| 12 | Transactions | 266 | 29 | 237 | 12% | 33 |

### Top archetypes in matrix
| Rank | Signature | Count | Primary Route |
| --- | --- | ---: | --- |
| 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model` | 44 | `http-get:/api/user/accounts/*` |
| 2 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource` | 43 | `http-get:/api/user/accounts/*` |
| 3 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource` | 40 | `http-get:/api/user/accounts/*` |
| 4 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Backend` | 37 | `http-get:/api/user/accounts/*` |
| 5 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Backend` | 14 | `http-get:/api/user/accounts/*` |
| 6 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource → BE:Model` | 9 | `http-get:/api/user/accounts/*` |
| 7 | `FE:Page → FE:Api → HTTP:GET → BE:Controller → BE:Backend` | 8 | `http-get:/api/accounts/*/billing/plans` |
| 8 | `FE:Page → FE:Api → HTTP:GET → BE:Controller → BE:Service → BE:Model` | 8 | `http-get:/api/accounts/*/engage-configuration` |
| 9 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model → BE:Backend` | 4 | `http-get:/api/campaigns/*` |
| 10 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Backend` | 4 | `http-get:/api/reporting/accounts/*/reports/*` |

### Top scored matrix cells (with concrete exemplar slices)
| Rank | Cluster | Score | Band | Coverage | Signature | Exemplar Slice |
| --- | --- | ---: | --- | ---: | --- | --- |
| 1 | Api | 85 | high | 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model` | `proc_10_transactionsdetailsf | apps/dashboard/src/pages/transactions/TransactionsOfflineFormDrawer.tsx` |
| 2 | Api | 84 | high | 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource` | `proc_17_viewpledgedrawer | apps/dashboard/src/pages/pledges/ViewPledgeDrawer.tsx` |
| 3 | Api | 82 | high | 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource` | `proc_71_campaignitembundlefo | apps/dashboard/src/pages/campaign-settings/campaign-event/CampaignItemBundleFormDrawer.tsx` |
| 4 | Api | 80 | high | 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Backend` | `proc_111_eventdetails | apps/dashboard/src/pages/campaign-settings/campaign-event/EventDetails.tsx` |
| 5 | Api | 64 | emerging | 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Backend` | `proc_18_viewpledgedrawer | apps/dashboard/src/pages/pledges/ViewPledgeDrawer.tsx` |
| 6 | Api | 61 | emerging | 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource → BE:Model` | `proc_0_quickbooksruledrawer | apps/dashboard/src/pages/account-settings/account-integrations/integrations/QuickBooks/QuickBooksRuleDrawer.tsx` |
| 7 | Api | 60 | emerging | 1 | `FE:Page → FE:Api → HTTP:GET → BE:Controller → BE:Backend` | `proc_185_engageindex | apps/dashboard/src/pages/engage/EngageIndex.tsx` |
| 8 | Api | 60 | emerging | 1 | `FE:Page → FE:Api → HTTP:GET → BE:Controller → BE:Service → BE:Model` | `proc_96_engageindex | apps/dashboard/src/pages/engage/EngageIndex.tsx` |
| 9 | Api | 58 | emerging | 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model → BE:Backend` | `proc_152_campaignitembundlefo | apps/dashboard/src/pages/campaign-settings/campaign-event/CampaignItemBundleFormDrawer.tsx` |
| 10 | Api | 58 | emerging | 1 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Backend` | `proc_163_sharereportdialog | apps/dashboard/src/pages/reports/ShareReportDialog.tsx` |
| 11 | Engage | 56 | emerging | 1 | `FE:Page → FE:Api → HTTP:GET → BE:Controller → BE:Service → BE:Model` | `proc_96_engageindex | apps/dashboard/src/pages/engage/EngageIndex.tsx` |
| 12 | Components | 44 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model` | `- | -` |
| 13 | Components | 43 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource` | `- | -` |
| 14 | Components | 42 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource` | `- | -` |
| 15 | Components | 40 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Backend` | `- | -` |
| 16 | Finance | 35 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model` | `- | -` |
| 17 | Filters | 35 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model` | `- | -` |
| 18 | Finance | 35 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource` | `- | -` |
| 19 | Filters | 34 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Routes → BE:Controller → BE:Resource` | `- | -` |
| 20 | Triggers | 33 | low | 0 | `FE:Page → FE:Hook → FE:Api → HTTP:GET → BE:Controller → BE:Resource → BE:Model` | `- | -` |

### Coverage gaps to close next
- Most non-`Api` cells are low-evidence in this pass.
- Current archetype export is exemplar-sampled (max 10 per signature), so matrix coverage is intentionally conservative.
- Next pass should increase evidence recall by signature-level process expansion (beyond exemplar sample) before using scores as hard ranking signals.

## Pass 3 Plan (Kernel Specialization)
- Query mode:
  - Rank slice cards by archetype/cluster convergence and emit top “closest skeleton” examples first.
- Implement mode:
  - Prefer companion file sets from the same lamination card family before generic precedents.
- Review mode:
  - Auto-compare changed slice against its nearest lamination card and surface drift in auth/cache/shape/status semantics.
- Debug mode:
  - Prioritize broken-loop candidates by nearest lamination card plus runtime evidence mismatch.

## Pass 4 Plan (Operationalization)
- Persist lamination cards as first-class overlays (producer + validator + consumer + decay policy).
- Add eval canaries: “carbon-copy fidelity” checks against known-good sibling implementations.
- Gate promotions by measured uplift in implement/review/debug task success on monorepo canary suites.
