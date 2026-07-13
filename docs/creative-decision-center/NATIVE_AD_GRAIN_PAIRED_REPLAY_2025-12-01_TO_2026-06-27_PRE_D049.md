# Native Ad-Grain Paired Historical Replay

Generated at: 2026-07-12T10:42:41.473Z
Git SHA: `f896f7e7cc3c1b84378078b14edb6a4a5662689c`

## Evidence Boundary

This replay is read-only and uses finalized `meta_ad_daily` facts at native ad grain. These rows are restated warehouse facts, not exact decision-time PIT observations. Every hard action remains review-only in this artifact. Zero forward spend is censored, not counted as saved spend.

## Coverage

- Businesses: 12
- Source rows: 142170
- Fixed matched cohort rows: 17233
- Target-exact rows: 2902 (16.8%)
- Complete 14d outcomes: 16945 (98.3%)
- Current-dimension creative IDs: 17233 (100.0%); grouping only, never execution authority.

## Paired Variant Results

| Variant | Applicable | Labels | Changed | Cut P (target-exact) | Cut R (target-exact) | Target winner P (target-exact) | Target winner R (target-exact) | Portfolio winner P | Portfolio winner R | Refresh P | Diagnose P | Unknown cut (all) | Censored cut (all) | Safety |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V0_current | 17233 | out_of_scope:1450, cut:1390, diagnose:563, keep:2309, test_more:11489, refresh:27, scale:5 | 0 (0.0%) | 75.0% | 34.0% | 66.7% | 1.8% | 50.0% | 0.1% | 0.0% | 28.8% | 90.2% | 0.6% | 10 |
| H1_hl14_k16_q0p3 | 2519 | out_of_scope:1450, cut:1401, diagnose:563, keep:2298, test_more:11489, refresh:27, scale:5 | 17 (0.1%) | 76.1% | 41.5% | 66.7% | 1.8% | 50.0% | 0.7% | 0.0% | 50.0% | 17.9% | 4.6% | 16 |
| H2_loss2_zero2_hard3 | 2519 | out_of_scope:1450, cut:1387, diagnose:563, keep:2312, test_more:11489, refresh:27, scale:5 | 28 (0.2%) | 74.4% | 36.2% | 66.7% | 1.8% | 50.0% | 0.7% | 0.0% | 50.0% | 16.4% | 5.0% | 10 |
| H3_midpoint_below_breakeven_none | 2519 | out_of_scope:1450, cut:1425, diagnose:563, keep:2274, test_more:11489, refresh:27, scale:5 | 55 (0.3%) | 78.7% | 52.4% | 66.7% | 1.8% | 50.0% | 0.7% | 0.0% | 50.0% | 9.6% | 7.1% | 0 |
| H4_rel0p75_target1p1_purchase0p7 | 16201 | out_of_scope:1450, cut:1380, diagnose:563, keep:2314, test_more:11489, refresh:27, scale:10 | 678 (3.9%) | 76.8% | 39.0% | 46.2% | 5.5% | 29.8% | 8.2% | 0.0% | 28.8% | 90.4% | 0.6% | 0 |
| H5_decay0p1_con0p4_freq0p7_count2 | 16201 | out_of_scope:1450, cut:1390, diagnose:563, keep:2335, test_more:11489, scale:5, refresh:1 | 26 (0.2%) | 75.0% | 39.0% | 66.7% | 1.8% | 50.0% | 0.1% | 0.0% | 28.8% | 90.2% | 0.6% | 10 |
| H6_weak0p8_confidence0p55_sample8 | 13890 | out_of_scope:1450, cut:1185, diagnose:1181, keep:2417, test_more:10971, refresh:24, scale:5 | 943 (5.5%) | 75.0% | 29.8% | 66.7% | 3.1% | 50.0% | 0.1% | n/a | 23.7% | 93.0% | 0.6% | 8 |
| H8_balanced_depth_depth1 | 1032 | out_of_scope:418, test_more:12443, cut:1390, diagnose:563, keep:2387, refresh:27, scale:5 | 1032 (6.0%) | n/a | 0.0% | 8.5% | 0.0% | 21.1% | 12.9% | n/a | n/a | n/a | n/a | 0 |
| HC_safe_cut_fatigue | 2519 | out_of_scope:1450, cut:1380, diagnose:563, keep:2319, test_more:11489, refresh:27, scale:5 | 10 (0.1%) | 76.8% | 39.0% | 66.7% | 1.8% | 50.0% | 0.7% | 0.0% | 50.0% | 12.5% | 5.3% | 0 |

## Family Closure Gates

| Family | Candidates | Calibration selection | Locked-test known | Locked-test precision | Wilson lower | Locked-test recall | Paired net wins | McNemar p | Safety | Gate |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| H1 | 144 | H1_hl14_k16_q0p3 | 70 | 84.3% | 74.0% | 53.6% | 3 | 0.3750 | 12 | reject_safety |
| H2 | 100 | H2_loss2_zero2_hard3 | 67 | 82.1% | 71.3% | 47.3% | -4 | 0.1250 | 7 | reject_safety |
| H3 | 16 | H3_midpoint_below_breakeven_none | 90 | 82.2% | 73.1% | 67.3% | 18 | 0.0000 | 0 | insufficient_evidence |
| H4 | 60 | H4_rel0p75_target1p1_purchase0p7 | 0 | n/a | n/a | 0.0% | 0 | 1.0000 | 0 | insufficient_evidence |
| H5 | 120 | H5_decay0p1_con0p4_freq0p7_count2 | 5 | 80.0% | 37.6% | 2.2% | -8 | 0.0215 | 0 | insufficient_evidence |
| H6 | 36 | H6_weak0p8_confidence0p55_sample8 | 16 | 37.5% | 18.5% | 3.3% | 0 | 1.0000 | 0 | insufficient_evidence |
| H8 | 16 | H8_balanced_depth_depth1 | 11 | 18.2% | 5.1% | 10.0% | 2 | 0.5000 | 0 | insufficient_evidence |
| HC | 6 | HC_safe_cut_fatigue | 68 | 82.4% | 71.6% | 50.9% | 0 | 1.0000 | 0 | insufficient_evidence |

## H10 Probability Calibration

| Variant | Calibration known | Test known | Transformed | Unsupported | Calibrated action ECE | Calibrated action Brier | Gate |
|---|---:|---:|---:|---:|---|---|---|
| identity:global | 22 | 69 | 0 | 120 | n/a | n/a | insufficient_evidence |
| identity:action_account_hierarchical | 22 | 69 | 0 | 120 | n/a | n/a | insufficient_evidence |
| equal_mass_histogram:global | 22 | 69 | 0 | 120 | n/a | n/a | insufficient_evidence |
| equal_mass_histogram:action_account_hierarchical | 22 | 69 | 0 | 120 | n/a | n/a | insufficient_evidence |
| isotonic_pav:global | 22 | 69 | 0 | 120 | n/a | n/a | insufficient_evidence |
| isotonic_pav:action_account_hierarchical | 22 | 69 | 0 | 120 | n/a | n/a | insufficient_evidence |
| platt:global | 22 | 69 | 0 | 120 | n/a | n/a | insufficient_evidence |
| platt:action_account_hierarchical | 22 | 69 | 0 | 120 | n/a | n/a | insufficient_evidence |

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
