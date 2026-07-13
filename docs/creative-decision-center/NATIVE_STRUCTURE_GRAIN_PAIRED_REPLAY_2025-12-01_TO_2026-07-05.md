# Native Campaign / Ad-set Structure Paired Replay

Generated: 2026-07-12T15:44:43.894Z

## Scope

- Decision dates: 2025-12-01, 2025-12-08, 2025-12-15, 2025-12-22, 2025-12-29, 2026-01-05, 2026-01-12, 2026-01-19, 2026-01-26, 2026-02-02, 2026-02-09, 2026-02-16, 2026-02-23, 2026-03-02, 2026-03-09, 2026-03-16, 2026-03-23, 2026-03-30, 2026-04-06, 2026-04-13, 2026-04-20, 2026-04-27, 2026-05-04, 2026-05-11, 2026-05-18, 2026-05-25, 2026-06-01, 2026-06-08, 2026-06-15, 2026-06-22, 2026-06-29
- Cadence anchor: 2025-12-01 (7 days)
- Outcome windows: 3, 7, 14 complete account days
- Candidate grid: 1536 H7/H9 combinations per grain
- Source manifest SHA-256: `4e623a78c11ee9c4584d09eeec2c830046d06198ff799ac6784203bffa31293f`

## Period Protocol

| Phase | Range | Outcome ceiling | Cadence dates |
|---|---|---|---:|
| development | 2025-12-01..2026-03-31 | 2026-03-31 | 18 |
| calibration | 2026-04-01..2026-05-31 | 2026-05-31 | 8 |
| locked_test | 2026-06-01..2026-07-05 | 2026-07-11 | 5 |

Calibration selects each finite-grid candidate. Locked-test rows never alter selection. Every cell is isolated by grain, outcome window, funnel cohort, and currency.

## Promotion Gates

| Grain | Window | Cohort | Currency | Variant | Locked known | Precision | Wilson lower | Recall | Safety | Threshold | Execution |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---|---|
| campaign | 3d | engagement | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | engagement | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | engagement | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | engagement | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | engagement | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | engagement | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | lead | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | lead | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | lead | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | mid_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | mid_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | mid_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | purchase | GBP | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | purchase | GBP | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | purchase | GBP | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | purchase | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | purchase | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | purchase | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | purchase | USD | `age14-half_peer_p50-util70-hl14-support2-seasonality-none` | 6 | 16.67% | 3.01% | 6.67% | 4 | BLOCKED | BLOCKED |
| campaign | 7d | purchase | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 8 | 25.00% | 7.15% | 20.00% | 6 | BLOCKED | BLOCKED |
| campaign | 14d | purchase | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 1 | 0.00% | 0.00% | 0.00% | 1 | BLOCKED | BLOCKED |
| campaign | 3d | traffic | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | traffic | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | traffic | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | traffic | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | traffic | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | traffic | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | upper_funnel | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | upper_funnel | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | upper_funnel | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 3d | upper_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 7d | upper_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| campaign | 14d | upper_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | engagement | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | engagement | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | engagement | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | lead | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | lead | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | lead | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | mid_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | mid_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | mid_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | purchase | GBP | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | purchase | GBP | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | 0.00% | 0 | BLOCKED | BLOCKED |
| adset | 14d | purchase | GBP | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | purchase | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | purchase | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | purchase | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | purchase | USD | `age7-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | purchase | USD | `age7-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | purchase | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | traffic | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | traffic | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | traffic | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | traffic | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | traffic | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | traffic | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | upper_funnel | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | upper_funnel | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | upper_funnel | TRY | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 3d | upper_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 7d | upper_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |
| adset | 14d | upper_funnel | USD | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 0 | n/a | n/a | n/a | 0 | BLOCKED | BLOCKED |

No currency is pooled into selection or promotion metrics. Purchase cells require cutoff-safe fresh target and break-even anchors. Other funnel cells use their own primary-result cost distribution and never inherit ROAS targets.

## Coverage

| Grain | Fixed rows | Purchase | Non-purchase | Config PIT | Bid PIT | Target PIT | Fresh target | Complete 14d |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| campaign | 1718 | 580 | 92 | 669 | 574 | 351 | 211 | 1630 |
| adset | 2113 | 807 | 86 | 881 | 880 | 493 | 300 | 1996 |

## Evidence Limits

- Daily campaign/ad-set metrics are finalized warehouse facts but are restated, not exact raw point-in-time generations; source_updated_after_cutoff is reported rather than hidden.
- Cutoff-gated config history proves what was recorded by the decision cutoff, but the normalized schema collapses direct campaign budgets and equal ad-set budget fallbacks. Those cases remain review-only and cannot authorize writes.
- Campaign/ad-set status is not versioned in config history. Daily status columns can be restated from later provider reads, so historical execution authority is always false in this replay.
- A future durable-winner outcome is an observational ranking proxy. It does not identify causal budget-step lift, incrementality, or counterfactual savings.
- The warehouse conversion field is interpreted only inside its cutoff-classified funnel cohort. Purchase cells require fresh target and break-even truth; non-purchase cells use primary-result cost without ROAS substitution.
- Bid strategy/value and budget owner/origin must be reconstructable at the cutoff. Mixed or unsupported contexts fail closed rather than borrowing another regime.
- Unlogged provider actions, deleted entities, attribution restatements, and successor lineage cannot be reconstructed from these tables.

## Decision

All 1536 finite H7/H9 alternatives were evaluated independently in every estimable grain/window/cohort/currency cell; none passed the locked-test threshold gate. Do not ship an H7/H9 threshold change from this replay.
