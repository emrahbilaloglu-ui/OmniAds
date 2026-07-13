# Native Ad-Grain Paired Historical Replay

Generated at: 2026-07-12T09:52:51.576Z
Git SHA: `f896f7e7cc3c1b84378078b14edb6a4a5662689c`

## Evidence Boundary

This replay is read-only and uses finalized `meta_ad_daily` facts at native ad grain. These rows are restated warehouse facts, not exact decision-time PIT observations. Every hard action remains review-only in this artifact. Zero forward spend is censored, not counted as saved spend.

## Coverage

- Businesses: 12
- Source rows: 74540
- Fixed matched cohort rows: 5006
- Target-exact rows: 2551 (51.0%)
- Complete 14d outcomes: 4607 (92.0%)
- Current-dimension creative IDs: 5006 (100.0%); grouping only, never execution authority.

## Paired Variant Results

| Variant | Labels | Changed | Cut P (target-exact) | Cut R (target-exact) | Target winner P (target-exact) | Target winner R (target-exact) | Portfolio winner P | Portfolio winner R | Refresh P | Unknown cut (all) | Censored cut (all) | Safety |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V0_current | test_more:3915, out_of_scope:82, keep:532, cut:407, scale:61, refresh:9 | 0 (0.0%) | 70.9% | 30.8% | 61.5% | 29.1% | 25.0% | 1.8% | 50.0% | 73.0% | 1.7% | 4 |
| H2_loss_budget_1_5 | test_more:3736, out_of_scope:82, keep:606, cut:507, scale:66, refresh:9 | 179 (3.6%) | 74.3% | 30.8% | 59.6% | 29.1% | 21.4% | 1.8% | 50.0% | 71.4% | 1.8% | 5 |
| H2_loss_budget_2_5 | test_more:4045, out_of_scope:82, keep:471, cut:345, refresh:9, scale:54 | 130 (2.6%) | 67.9% | 22.4% | 63.0% | 26.4% | 30.0% | 1.8% | 50.0% | 75.9% | 1.4% | 4 |
| H3_below_both | test_more:3915, out_of_scope:82, keep:536, cut:403, scale:61, refresh:9 | 4 (0.1%) | 72.3% | 30.8% | 61.5% | 29.1% | 25.0% | 1.8% | 50.0% | 73.2% | 1.7% | 0 |
| H3_below_both_half_winner_floor | test_more:4003, out_of_scope:82, keep:536, cut:315, scale:61, refresh:9 | 92 (1.8%) | 69.2% | 19.0% | 61.5% | 29.1% | 25.0% | 1.8% | 50.0% | 78.1% | 1.3% | 0 |
| H5_sensitive_fatigue | test_more:3915, out_of_scope:82, keep:539, cut:407, scale:61, refresh:2 | 7 (0.1%) | 70.9% | 30.8% | 61.5% | 29.1% | 25.0% | 1.8% | 50.0% | 73.0% | 1.7% | 4 |
| H5_conservative_fatigue | test_more:3915, out_of_scope:82, keep:539, cut:407, scale:61, refresh:2 | 7 (0.1%) | 70.9% | 30.8% | 61.5% | 29.1% | 25.0% | 1.8% | 50.0% | 73.0% | 1.7% | 4 |
| H4_relative_winner_p75 | test_more:3915, out_of_scope:82, keep:536, cut:403, scale:61, refresh:9 | 62 (1.2%) | 72.3% | 30.8% | 58.9% | 30.0% | 27.8% | 6.1% | 50.0% | 73.2% | 1.7% | 0 |

## Interpretation Rules

- Cut support means the ad kept delivering and remained below explicit breakeven over the complete forward window.
- Target-winner support is durability at or above the target that was provably known at the cutoff; it is not budget-scale lift.
- Portfolio-winner support means complete forward ROAS remained in the same account-day-goal-currency cohort's top quartile; it measures promotion-to-main ranking, not economic target attainment.
- Refresh is a decay-persistence proxy without successor lineage, not replacement lift.
- Opportunity recall uses the same dated cohort for every variant.
- No result in this artifact is causal provider-write evidence.

## Remaining Follow-Up

- Run the full H1-H10 bounded grid with rolling-origin train/validation/test selection.
- Add exact-raw-PIT rows as a separate evidence tier; never merge them with restated rows.
- Add campaign/ad-set budget-owner replay using cutoff-gated config histories.
- Calibrate confidence only after hard-known action cells clear sample floors.
- Use logged pause/launch receipts to reclassify otherwise censored outcomes.
