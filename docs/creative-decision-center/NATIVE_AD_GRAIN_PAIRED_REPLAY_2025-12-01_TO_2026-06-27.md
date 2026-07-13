# Native Ad-Grain Paired Historical Replay

Generated at: 2026-07-12T22:05:19.448Z
Git SHA: `f896f7e7cc3c1b84378078b14edb6a4a5662689c`

## Evidence Boundary

This replay is read-only and uses finalized `meta_ad_daily` facts at native ad grain. These rows are restated warehouse facts, not exact decision-time PIT observations. Every hard action remains review-only in this artifact. Zero forward spend is censored, not counted as saved spend.

## Baseline Epoch

- Engine version: `v3-2026-07-12-breakeven-cut-ceiling`.
- This is the formula engine epoch replayed at ad grain, not the separate native producer/schema epoch.
- `V0_current` includes D049's fresh breakeven cut ceiling. It may narrow account P25 but never widen the cut zone.
- The immutable pre-D049 comparison is stored in `NATIVE_AD_GRAIN_PAIRED_REPLAY_2025-12-01_TO_2026-06-27_PRE_D049.md` and its matching generated JSON.

## Bounded Eliminations

- **H1 / campaign_kind_parent:** H11's four cutoff-safe automatic-context policies failed the locked segmentation gate, while legacy labels are current-only; a rejected shadow kind cannot define calibration cells.
- **H3 / convex_p25_to_breakeven_continuum:** lambda=0 is account P25, lambda=0.5 is the tested midpoint, and lambda=1 is the breakeven endpoint. When breakeven exceeds P25, every lambda>0 expands the cut zone and violates the no-widen invariant; when breakeven is lower, the cap collapses positive lambda endpoints to the tested breakeven ceiling.
- **H8 / continuous_non_purchase_weight_simplex:** The three operational vertices plus balanced-depth interior preset were evaluated. Locked evidence contains only 11 known actions from one business, so fitting arbitrary continuous weights would be account-specific overfit rather than an identifiable portable challenger.

## Coverage

- Businesses: 12
- Source rows: 142170
- Fixed matched cohort rows: 17233
- Target-exact rows: 2902 (16.8%)
- Complete 14d outcomes: 16945 (98.3%)
- Complete 3d outcomes: 17186 (99.7%); ingestion days 51597/51699.
- Complete 7d outcomes: 17082 (99.1%); ingestion days 120045/120631.
- Complete 14d outcomes: 16945 (98.3%); ingestion days 239178/241262.
- Cutoff-safe context rows: status 0, format 0, lifecycle 0, rankings 0, bid regime 4170.
- Pre-cutoff action strata: untreated 17226, success 7, failed 0, dry-run 0.
- Current-dimension creative IDs: 17233 (100.0%); grouping only, never execution authority.

## Paired Variant Results

| Variant | Applicable | Labels | Changed | Cut P (target-exact) | Cut R (target-exact) | Target winner P (target-exact) | Target winner R (target-exact) | Portfolio winner P | Portfolio winner R | Refresh P | Diagnose P | Unknown cut (all) | Censored cut (all) | Safety |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| V0_current | 17192 | out_of_scope:1450, diagnose:15742 | 0 (0.0%) | n/a | 0.0% | n/a | 0.0% | n/a | 0.0% | n/a | 20.4% | n/a | n/a | 0 |
| H1_hl14_k16_q0p1 | 2489 | out_of_scope:1450, diagnose:15742 | 0 (0.0%) | n/a | 0.0% | n/a | 0.0% | n/a | 0.0% | n/a | 11.8% | n/a | n/a | 0 |
| H2_loss1p25_zero2_hard3 | 2489 | out_of_scope:1450, diagnose:15742 | 0 (0.0%) | n/a | 0.0% | n/a | 0.0% | n/a | 0.0% | n/a | 11.8% | n/a | n/a | 0 |
| H3_account_p10_fixed_2 | 2489 | out_of_scope:1450, diagnose:15742 | 0 (0.0%) | n/a | 0.0% | n/a | 0.0% | n/a | 0.0% | n/a | 11.8% | n/a | n/a | 0 |
| H4_rel0p75_target1p1_purchase0p7 | 16160 | out_of_scope:1450, diagnose:15742 | 670 (3.9%) | n/a | 0.0% | 50.0% | 5.8% | 29.9% | 8.2% | n/a | 20.4% | n/a | n/a | 0 |
| H5_decay0p1_con0p4_freq0p7_count2 | 16160 | out_of_scope:1450, diagnose:15742 | 0 (0.0%) | n/a | 0.0% | n/a | 0.0% | n/a | 0.0% | n/a | 20.4% | n/a | n/a | 0 |
| H6_weak0p8_confidence0p55_sample8 | 13859 | out_of_scope:1450, diagnose:12526, keep:3216 | 3216 (18.7%) | n/a | 0.0% | n/a | 0.0% | n/a | 0.0% | n/a | 30.7% | n/a | n/a | 0 |
| H8_balanced_depth_depth1 | 1032 | out_of_scope:418, test_more:954, diagnose:15742, keep:78 | 1032 (6.0%) | n/a | 0.0% | 8.5% | 0.0% | 21.1% | 12.9% | n/a | n/a | n/a | n/a | 0 |
| HC_full_preregistered | 2489 | out_of_scope:1450, diagnose:14508, keep:1234 | 1371 (8.0%) | n/a | 0.0% | 50.0% | 4.9% | 20.0% | 1.5% | n/a | 15.0% | n/a | n/a | 0 |

## Family Closure Gates

| Family | Candidates | Calibration selection | Locked-test known | Locked-test precision | Wilson lower | Locked-test recall | Paired baseline P/R | Paired candidate P/R | Paired net wins | McNemar p | Safety | Gate |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| H1 | 144 | H1_hl14_k16_q0p1 | 0 | n/a | n/a | 0.0% | n/a / 0.0% | n/a / 0.0% | 0 | 1.0000 | 0 | insufficient_evidence |
| H2 | 100 | H2_loss1p25_zero2_hard3 | 0 | n/a | n/a | 0.0% | n/a / 0.0% | n/a / 0.0% | 0 | 1.0000 | 0 | insufficient_evidence |
| H3 | 16 | H3_account_p10_fixed_2 | 0 | n/a | n/a | 0.0% | n/a / 0.0% | n/a / 0.0% | 0 | 1.0000 | 0 | insufficient_evidence |
| H4 | 60 | H4_rel0p75_target1p1_purchase0p7 | 0 | n/a | n/a | 0.0% | n/a / 0.0% | n/a / 0.0% | 0 | 1.0000 | 0 | insufficient_evidence |
| H5 | 120 | H5_decay0p1_con0p4_freq0p7_count2 | 5 | 80.0% | 37.6% | 2.2% | 75.0% / 6.7% | 80.0% / 2.2% | -8 | 0.0215 | 0 | insufficient_evidence |
| H6 | 36 | H6_weak0p8_confidence0p55_sample8 | 352 | 25.0% | 20.8% | 60.9% | 17.3% / 72.1% | 25.0% / 60.9% | -24 | 0.0000 | 0 | reject_precision |
| H8 | 16 | H8_balanced_depth_depth1 | 11 | 18.2% | 5.1% | 10.0% | n/a / 0.0% | 18.2% / 10.0% | 2 | 0.5000 | 0 | insufficient_evidence |
| HC | 6 | HC_full_preregistered | 0 | n/a | n/a | 0.0% | n/a / 0.0% | n/a / 0.0% | 0 | 1.0000 | 0 | insufficient_evidence |

## H3 Account-Week Outcome Falsification

- Candidate-only known actions: 0 supported / 0 refuted.
- Baseline-only known actions: 0 supported / 0 refuted.
- Account-week outcome permutation was not evaluable.

## H10 Probability Calibration

| Variant | Calibration known | Test known | Transformed | Unsupported | Calibrated action ECE | Calibrated action Brier | Gate |
|---|---:|---:|---:|---:|---|---|---|
| identity:global | 15 | 67 | 0 | 111 | n/a | n/a | insufficient_evidence |
| identity:action_account_hierarchical | 15 | 67 | 0 | 111 | n/a | n/a | insufficient_evidence |
| equal_mass_histogram:global | 15 | 67 | 0 | 111 | n/a | n/a | insufficient_evidence |
| equal_mass_histogram:action_account_hierarchical | 15 | 67 | 0 | 111 | n/a | n/a | insufficient_evidence |
| isotonic_pav:global | 15 | 67 | 0 | 111 | n/a | n/a | insufficient_evidence |
| isotonic_pav:action_account_hierarchical | 15 | 67 | 0 | 111 | n/a | n/a | insufficient_evidence |
| platt:global | 15 | 67 | 0 | 111 | n/a | n/a | insufficient_evidence |
| platt:action_account_hierarchical | 15 | 67 | 0 | 111 | n/a | n/a | insufficient_evidence |

- Strict automation gate: closed_insufficient_or_failed_strict_evidence.
- Bayesian walk-forward sensitivity variants: 9; descriptive only, automation eligibility is always false.

## Interpretation Rules

- Cut support means the ad kept delivering and remained below explicit breakeven over the complete forward window.
- Target-winner support is durability at or above the target that was provably known at the cutoff; it is not budget-scale lift.
- Portfolio-winner support means complete forward ROAS remained in the same account-day-goal-currency cohort's top quartile; it measures promotion-to-main ranking, not economic target attainment.
- Refresh is a decay-persistence proxy without successor lineage, not replacement lift.
- Opportunity recall uses the same dated cohort for every variant.
- No result in this artifact is causal provider-write evidence.

## Closure Actions

- Keep D049 review-only as a monotonic no-widen safety invariant; the superseded pre-D049 artifact is not comparable to this strict-input run and no historical lift is claimed.
- H11 is closed: retain the production campaign-context default and do not enable automatic context consumption.
- H12 produced no strict historical hard entries: make no policy change and retain the shipped guard only as an unpromoted safety mechanism pending native evidence.
- Keep H10 automation closed unless the strict action-specific 5x50/ECE contract passes; Bayesian walk-forward outputs are bounded descriptive sensitivity only and cannot grant authority.
