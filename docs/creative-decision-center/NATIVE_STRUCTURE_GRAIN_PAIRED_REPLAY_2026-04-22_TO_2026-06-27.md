# Native Campaign / Ad-set Structure Paired Replay

Generated: 2026-07-12T12:03:39.403Z

## Scope

- Decision dates: 2026-04-22, 2026-04-29, 2026-05-06, 2026-05-13, 2026-05-20, 2026-05-27, 2026-06-03, 2026-06-10, 2026-06-17, 2026-06-24
- Development dates: 2026-04-22, 2026-04-29, 2026-05-06, 2026-05-13, 2026-05-20, 2026-05-27, 2026-06-03
- Holdout dates: 2026-06-10, 2026-06-17, 2026-06-24
- Outcome window: 14 complete account days after each opportunity
- Candidate grid: 1536 H7/H9 combinations per grain
- Source manifest SHA-256: `6bdb1a4cd21209f53dec17ddeed34370028d64fd8962a71e1bb3edb5bb1154b5`

## Selected Development Variants

| Grain | Variant | Dev candidates | Dev precision (Wilson lower) | Dev recall | Holdout candidates | Holdout precision | Holdout recall | Holdout critical FP |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| campaign | `age7-p5-util95-hl14-support1-seasonality-none` | 26 | 46.01% | 17.57% | 2 | 100.00% | 7.14% | 0 |
| adset | `age14-half_peer_p50-util70-hl14-support1-seasonality-day_of_week_match` | 9 | 30.06% | 15.00% | 0 | n/a | 0.00% | 0 |

Selection is based only on the earlier development dates. Holdout metrics are reported without re-fitting. A selected row remains review-only because historical status is not versioned; the result is not an execution authorization.

## Promotion Gates

| Grain | Threshold gate | Execution gate | Holdout known | Wilson lower | Candidate accounts | Largest account share | Grid holdout passes |
|---|---|---|---:|---:|---:|---:|---:|
| campaign | BLOCKED | BLOCKED | 1 | 20.65% | 1 | 100.00% | 0/1536 |
| adset | BLOCKED | BLOCKED | 0 | n/a | 0 | n/a | 0/1536 |

No holdout result is used to choose a threshold. `Grid holdout passes` is an exhaustive diagnostic proving whether any bounded H7/H9 alternative could satisfy the predeclared statistical gate, not a second selection pass.

## Walk-forward Stability

| Grain | Folds | Unique selected variants | Validation known | Supported | Refuted | Critical FP |
|---|---:|---:|---:|---:|---:|---:|
| campaign | 3 | 2 | 7 | 5 | 2 | 2 |
| adset | 3 | 1 | 0 | 0 | 0 | 0 |

## Coverage

| Grain | Fixed rows | Purchase rows | Cutoff-safe config | Complete receipts | Owner reconstructable | Status reconstructable | Restated source |
|---|---:|---:|---:|---:|---:|---:|---:|
| campaign | 630 | 515 | 591 | 586 | 0 | 0 | 630 |
| adset | 824 | 696 | 754 | 770 | 218 | 0 | 824 |

## Non-causal Budget Observation

The following counts only describe whether the observed cutoff-gated budget later changed. They do not estimate lift caused by a budget step.

| Grain | Selected candidates | Increased | Unchanged | Decreased | Unknown |
|---|---:|---:|---:|---:|---:|
| campaign | 28 | 3 | 25 | 0 | 0 |
| adset | 9 | 0 | 9 | 0 | 0 |

## Evidence Limits

- Daily campaign/ad-set metrics are finalized warehouse facts but are restated, not exact raw point-in-time generations; source_updated_after_cutoff is reported rather than hidden.
- Cutoff-gated config history proves what was recorded by the decision cutoff, but the normalized schema collapses direct campaign budgets and equal ad-set budget fallbacks. Those cases remain review-only and cannot authorize writes.
- Campaign/ad-set status is not versioned in config history. Daily status columns can be restated from later provider reads, so historical execution authority is always false in this replay.
- A future durable-winner outcome is an observational ranking proxy. It does not identify causal budget-step lift, incrementality, or counterfactual savings.
- The conversion field is the warehouse Meta purchase metric. H7 purchase maturity is evaluated only for purchase-classified cutoff config cohorts.
- Relative portfolio strength is not business-economic scale authority. Explicit fresh target and break-even truth would still be required for a production budget increase.
- Unlogged provider actions, deleted entities, attribution restatements, and successor lineage cannot be reconstructed from these tables.

## Decision

All 1536 H7/H9 alternatives per grain were evaluated, and none passed the predeclared holdout threshold gate. Do not ship an H7/H9 threshold change from this replay. Campaign/ad-set budget recommendations remain review-only until stronger point-in-time evidence, budget-origin/status history, fresh business economics, and causal lift evidence exist.
