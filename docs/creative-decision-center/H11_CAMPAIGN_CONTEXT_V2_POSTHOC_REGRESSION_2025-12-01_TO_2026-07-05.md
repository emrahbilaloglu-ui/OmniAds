# H11 Campaign Context V2 Post-Hoc Regression

Deterministic, SELECT-only historical regression of the fixed 4x2 campaign-context matrix. The V2 signature was designed after the original H11 holdout summary had been inspected, so this reused set is post-hoc regression evidence, not an independent holdout and not authorization to enable automatic execution.
- validation status: post_hoc_reused_holdout_not_independent_production_approval

## Verdict

- verdict: **RETAIN_PRODUCTION_DEFAULT**
- selected on calibration: H11_P1_no_lineage_renormalized
- locked-test gate: reject
- automatic consumption recommendation: DO_NOT_ENABLE
- production change: No H11 resolver formula/configuration change is justified by retained history.
- reason: The calibration-selected policy H11_P1_no_lineage_renormalized did not pass every locked-test gate (reject); bounded H11 alternatives are closed rather than left open.

## Contract

- contract: adsecute.meta.h11-campaign-context-challenger.v2
- resolver: campaign-context-resolver.v2-account-scoped-2026-08-29
- source tier: restated_ad_daily_plus_current_manual_label_truth
- decision dates: 2025-12-01 .. 2026-07-05
- policies: 8 exactly; bootstrap: 10000 business/entity clustered replicates, 7-day moving blocks
- DB boundary: transaction_read_only=on; SELECT statements only; no provider or production writes

## Predeclared Policies

| Policy | Signals | Thresholds | Baseline | Config hash | Definition |
| --- | --- | --- | --- | --- | --- |
| H11_P0_production_default | production | production | yes | 9b8980922554 | Exact shipped resolver configuration and lineage policy. |
| H11_P1_no_lineage_renormalized | no_lineage | production | no | ee61cb9d9d40 | Eliminates the known first-attribution lineage weakness and redistributes its 0.10 weight before observing outcomes. |
| H11_P2_no_naming_renormalized | no_naming | production | no | 906ab27baaf8 | Eliminates mutable campaign-name evidence, including name-vs-behavior conflicts, while retaining lineage as a sensitivity axis. |
| H11_P3_conservative_confidence | production | conservative | no | d703ec625958 | Keeps shipped signals but raises predeclared high/medium evidence thresholds to test whether hard-action context can be made safer without collapse. |
| H11_P4_no_lineage_no_naming_renormalized | no_lineage_no_naming | production | no | c8c3d19cae77 | Removes both retained-history reliability risks together and redistributes their fixed weight before observing outcomes. |
| H11_P5_no_lineage_conservative_confidence | no_lineage | conservative | no | bf8adb2a7f0e | Crosses the lineage ablation with the same bounded conservative threshold regime. |
| H11_P6_no_naming_conservative_confidence | no_naming | conservative | no | 0586da082b4d | Crosses the naming ablation with the same bounded conservative threshold regime. |
| H11_P7_no_lineage_no_naming_conservative_confidence | no_lineage_no_naming | conservative | no | e57e9fcd23db | Crosses the combined reliability ablation with the same bounded conservative threshold regime. |

## Data Coverage

- businesses: 12
- providerAccounts: 13
- campaigns: 349
- creativeDayRows: 87945
- campaignNameChangeRows: 2246
- campaignFirstSeenRows: 2185
- manualLabelRows: 78
- manualLabelsWithExactAccount: 78
- manualLabelsWithInferredUniqueAccount: 0
- manualLabelsWithUnresolvedAccount: 0
- duplicateManualLabelKeys: 0
- labeledDailyObservations: 37568
- labelAvailableAtDecisionObservations: 16760
- labelAvailableAtDecisionRate: 0.44612436115843274

## Rolling-Origin Evaluation

One campaign contributes at most one anchor per fold. Daily rows are reserved for stability and the clustered bootstrap; they do not inflate the evidence gate.

| Fold | Policy | Labeled campaigns | Classified | High n | High accuracy | Wilson lower | False Test | Coverage |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| development | H11_P0_production_default | 14 | 13 | 2 | 100.00% | 34.24% | 2 | 92.86% |
| development | H11_P1_no_lineage_renormalized | 14 | 13 | 8 | 75.00% | 40.93% | 2 | 92.86% |
| development | H11_P2_no_naming_renormalized | 14 | 13 | 9 | 77.78% | 45.26% | 2 | 92.86% |
| development | H11_P3_conservative_confidence | 14 | 13 | 1 | 100.00% | 20.65% | 2 | 92.86% |
| development | H11_P4_no_lineage_no_naming_renormalized | 14 | 13 | 10 | 80.00% | 49.02% | 1 | 92.86% |
| development | H11_P5_no_lineage_conservative_confidence | 14 | 13 | 2 | 100.00% | 34.24% | 2 | 92.86% |
| development | H11_P6_no_naming_conservative_confidence | 14 | 13 | 1 | 100.00% | 20.65% | 2 | 92.86% |
| development | H11_P7_no_lineage_no_naming_conservative_confidence | 14 | 13 | 2 | 100.00% | 34.24% | 2 | 92.86% |
| calibration | H11_P0_production_default | 51 | 38 | 7 | 71.43% | 35.89% | 2 | 74.51% |
| calibration | H11_P1_no_lineage_renormalized | 51 | 38 | 21 | 85.71% | 65.36% | 2 | 74.51% |
| calibration | H11_P2_no_naming_renormalized | 51 | 38 | 21 | 85.71% | 65.36% | 3 | 74.51% |
| calibration | H11_P3_conservative_confidence | 51 | 38 | 5 | 60.00% | 23.07% | 2 | 74.51% |
| calibration | H11_P4_no_lineage_no_naming_renormalized | 51 | 38 | 23 | 82.61% | 62.86% | 3 | 74.51% |
| calibration | H11_P5_no_lineage_conservative_confidence | 51 | 38 | 12 | 75.00% | 46.77% | 2 | 74.51% |
| calibration | H11_P6_no_naming_conservative_confidence | 51 | 38 | 10 | 70.00% | 39.68% | 3 | 74.51% |
| calibration | H11_P7_no_lineage_no_naming_conservative_confidence | 51 | 38 | 10 | 70.00% | 39.68% | 3 | 74.51% |
| locked_test | H11_P0_production_default | 69 | 41 | 11 | 63.64% | 35.38% | 0 | 59.42% |
| locked_test | H11_P1_no_lineage_renormalized | 69 | 41 | 22 | 72.73% | 51.85% | 0 | 59.42% |
| locked_test | H11_P2_no_naming_renormalized | 69 | 44 | 26 | 73.08% | 53.92% | 0 | 63.77% |
| locked_test | H11_P3_conservative_confidence | 69 | 41 | 10 | 60.00% | 31.27% | 0 | 59.42% |
| locked_test | H11_P4_no_lineage_no_naming_renormalized | 69 | 44 | 27 | 74.07% | 55.32% | 0 | 63.77% |
| locked_test | H11_P5_no_lineage_conservative_confidence | 69 | 41 | 12 | 66.67% | 39.06% | 0 | 59.42% |
| locked_test | H11_P6_no_naming_conservative_confidence | 69 | 44 | 9 | 55.56% | 26.67% | 0 | 63.77% |
| locked_test | H11_P7_no_lineage_no_naming_conservative_confidence | 69 | 44 | 11 | 54.55% | 28.01% | 0 | 63.77% |

## Locked-Test Robustness

| Policy | Anchor pairs | McNemar net wins | p | Bootstrap delta [95%] | LOBO direction | LOAO direction | Gate | Closure |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| H11_P0_production_default | 69 | 0 | 1.0000 | 0.00% [0.00%, 0.00%] | mixed_or_zero | mixed_or_zero | reject | retain_as_policy |
| H11_P1_no_lineage_renormalized | 69 | 0 | 1.0000 | 0.33% [0.00%, 0.59%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P2_no_naming_renormalized | 69 | 0 | 1.0000 | -0.16% [-2.23%, 1.00%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P3_conservative_confidence | 69 | 0 | 1.0000 | -0.44% [-1.86%, 0.00%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P4_no_lineage_no_naming_renormalized | 69 | 0 | 1.0000 | -0.11% [-2.37%, 1.38%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P5_no_lineage_conservative_confidence | 69 | 0 | 1.0000 | 0.00% [0.00%, 0.00%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P6_no_naming_conservative_confidence | 69 | 0 | 1.0000 | -0.16% [-2.26%, 0.98%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P7_no_lineage_no_naming_conservative_confidence | 69 | 0 | 1.0000 | -0.11% [-2.28%, 1.34%] | mixed_or_zero | mixed_or_zero | reject | reject |

### Critical Test-recall diagnostic (not used for selection)

| Policy | Manual Test | Published Test | True-positive Test | Test recall | Missed Test |
| --- | ---: | ---: | ---: | ---: | ---: |
| H11_P0_production_default | 12 | 0 | 0 | 0.00% | 12 |
| H11_P1_no_lineage_renormalized | 12 | 0 | 0 | 0.00% | 12 |
| H11_P2_no_naming_renormalized | 12 | 0 | 0 | 0.00% | 12 |
| H11_P3_conservative_confidence | 12 | 0 | 0 | 0.00% | 12 |
| H11_P4_no_lineage_no_naming_renormalized | 12 | 0 | 0 | 0.00% | 12 |
| H11_P5_no_lineage_conservative_confidence | 12 | 0 | 0 | 0.00% | 12 |
| H11_P6_no_naming_conservative_confidence | 12 | 0 | 0 | 0.00% | 12 |
| H11_P7_no_lineage_no_naming_conservative_confidence | 12 | 0 | 0 | 0.00% | 12 |

This diagnostic was not added to the preregistered acceptance gate after seeing the result. It is reported because zero Test recall is operationally material and independently argues against automatic consumption.

### Selected policy by provider account

| Business / account | Labeled | Classified | High n | High accuracy | Test recall | Coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bilsem Zeka / act_840779107261785 | 6 | 6 | 4 | 25.00% | n/a | 100.00% |
| ColorFullWorldsTR / act_3554615364751964 | 2 | 1 | 1 | 100.00% | n/a | 50.00% |
| EMOLOS / act_1054905059780305 | 5 | 0 | 0 | n/a | 0.00% | 0.00% |
| Grandmix / act_805150454596350 | 11 | 5 | 4 | 100.00% | 0.00% | 45.45% |
| Halıcızade / act_590466298182006 | 4 | 1 | 1 | 100.00% | 0.00% | 25.00% |
| IwaStore / act_1087566732415606 | 8 | 3 | 2 | 100.00% | 0.00% | 37.50% |
| TheSwaf / act_822913786458311 | 18 | 11 | 0 | n/a | 0.00% | 61.11% |
| TheSwaf / act_921275999286619 | 3 | 2 | 2 | 0.00% | n/a | 66.67% |
| Tiles Workshop / act_904404985140555 | 12 | 12 | 8 | 87.50% | 0.00% | 100.00% |

## Stability And Sensitivity

| Policy | Published flips/100d | Raw flips/100d | Unresolved | Collapsed accounts | Invariant violations | Placebo p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| H11_P0_production_default | 3.6457 | 4.2784 | 24.96% | 0 | 0 | 0.9960 |
| H11_P1_no_lineage_renormalized | 3.6457 | 4.6701 | 22.15% | 0 | 0 | 0.9960 |
| H11_P2_no_naming_renormalized | 4.0374 | 4.5496 | 21.03% | 0 | 0 | 1.0000 |
| H11_P3_conservative_confidence | 3.5854 | 4.1277 | 25.13% | 0 | 0 | 0.9960 |
| H11_P4_no_lineage_no_naming_renormalized | 3.9470 | 4.3387 | 21.06% | 0 | 0 | 1.0000 |
| H11_P5_no_lineage_conservative_confidence | 3.6457 | 4.2181 | 24.96% | 0 | 0 | 0.9960 |
| H11_P6_no_naming_conservative_confidence | 4.0374 | 4.4893 | 21.03% | 0 | 0 | 1.0000 |
| H11_P7_no_lineage_no_naming_conservative_confidence | 3.9470 | 4.2784 | 21.06% | 0 | 0 | 1.0000 |

- account-isolated vs business-pooled sensitivity: 368/153296 kind divergences (0.24%), 0 high-Test divergences.
- source sensitivity H11_P0_production_default: kind 21/19162 (0.11%), class 282 (1.47%).
- source sensitivity H11_P1_no_lineage_renormalized: kind 37/19162 (0.19%), class 164 (0.86%).
- source sensitivity H11_P2_no_naming_renormalized: kind 66/19162 (0.34%), class 134 (0.70%).
- source sensitivity H11_P3_conservative_confidence: kind 31/19162 (0.16%), class 258 (1.35%).
- source sensitivity H11_P4_no_lineage_no_naming_renormalized: kind 60/19162 (0.31%), class 120 (0.63%).
- source sensitivity H11_P5_no_lineage_conservative_confidence: kind 21/19162 (0.11%), class 236 (1.23%).
- source sensitivity H11_P6_no_naming_conservative_confidence: kind 66/19162 (0.34%), class 249 (1.30%).
- source sensitivity H11_P7_no_lineage_no_naming_conservative_confidence: kind 66/19162 (0.34%), class 245 (1.28%).
- PIT append-future falsification: 0/39 failures.

## H11xH1 End-to-End Parent Sensitivity

This is a clearly bounded 8 x 144 sensitivity (1152 configuration cells), not a new authority source. Only high, non-null published context may select an H1 kind parent; all other rows use account-all.

| Policy | Rows | Kind-parent authority | Account-all fallback | Parent changes vs baseline | Authority violations |
| --- | ---: | ---: | ---: | ---: | ---: |
| H11_P0_production_default | 3462 | 721 | 2741 | 0 | 0 |
| H11_P1_no_lineage_renormalized | 3462 | 1351 | 2111 | 632 | 0 |
| H11_P2_no_naming_renormalized | 3462 | 1521 | 1941 | 822 | 0 |
| H11_P3_conservative_confidence | 3462 | 470 | 2992 | 251 | 0 |
| H11_P4_no_lineage_no_naming_renormalized | 3462 | 1696 | 1766 | 981 | 0 |
| H11_P5_no_lineage_conservative_confidence | 3462 | 612 | 2850 | 217 | 0 |
| H11_P6_no_naming_conservative_confidence | 3462 | 625 | 2837 | 356 | 0 |
| H11_P7_no_lineage_no_naming_conservative_confidence | 3462 | 663 | 2799 | 358 | 0 |

## Closure Classification

- H11_P0_production_default: **retain_as_policy** - Retained as the conservative policy while the automatic-context evidence gate remains closed.
- H11_P1_no_lineage_renormalized: **reject** - Not adopted: gate=reject; failed=h11_labeled_coverage; insufficient=h11_high_confidence_unique_campaigns,h11_high_confidence_accuracy,h11_high_confidence_wilson_lower.
- H11_P2_no_naming_renormalized: **reject** - Not adopted: gate=reject; failed=h11_labeled_coverage,h11_paired_accuracy_non_inferiority,h11_published_flip_rate; insufficient=h11_high_confidence_unique_campaigns,h11_high_confidence_accuracy,h11_high_confidence_wilson_lower.
- H11_P3_conservative_confidence: **reject** - Not adopted: gate=reject; failed=h11_labeled_coverage; insufficient=h11_high_confidence_unique_campaigns,h11_high_confidence_accuracy,h11_high_confidence_wilson_lower.
- H11_P4_no_lineage_no_naming_renormalized: **reject** - Not adopted: gate=reject; failed=h11_labeled_coverage,h11_paired_accuracy_non_inferiority,h11_published_flip_rate; insufficient=h11_high_confidence_unique_campaigns,h11_high_confidence_accuracy,h11_high_confidence_wilson_lower.
- H11_P5_no_lineage_conservative_confidence: **reject** - Not adopted: gate=reject; failed=h11_labeled_coverage; insufficient=h11_high_confidence_unique_campaigns,h11_high_confidence_accuracy,h11_high_confidence_wilson_lower.
- H11_P6_no_naming_conservative_confidence: **reject** - Not adopted: gate=reject; failed=h11_labeled_coverage,h11_paired_accuracy_non_inferiority,h11_published_flip_rate; insufficient=h11_high_confidence_unique_campaigns,h11_high_confidence_accuracy,h11_high_confidence_wilson_lower.
- H11_P7_no_lineage_no_naming_conservative_confidence: **reject** - Not adopted: gate=reject; failed=h11_labeled_coverage,h11_paired_accuracy_non_inferiority,h11_published_flip_rate; insufficient=h11_high_confidence_unique_campaigns,h11_high_confidence_accuracy,h11_high_confidence_wilson_lower.

## Physically Unreconstructable Limits

- meta_campaign_labels stores only the current label and timestamps, not a versioned label history; the campaign role that an operator believed on each historical day cannot be reconstructed.
- Only 78 reviewed labels exist and unlabeled campaigns have no independent role truth; restated behavior cannot manufacture reviewed Main/Test/Mixed ground truth.
- meta_creative_daily campaign/creative lineage is normalized and restatable rather than an immutable raw point-in-time identity graph; same-day multi-campaign reuse that was not retained cannot be recovered.
- Historical campaign status, policy/learning state, and every prior rename are not all preserved as exact raw point-in-time inputs; this replay therefore cannot claim exact producer reproduction.
- A context classification's causal effect on later buyer actions or business outcomes requires contemporaneous controlled assignment; observational history cannot reconstruct that counterfactual.

## Deterministic Lineage

- sourceHash: eca400bf45c77f1021a154dda7b79483c129fdba5cc1b6014f5c9f5a88778ac3
- scriptHash: 3939d7680c6cfa0ce06ec8f67b7f2991486b704829a0efd1bf55a2ae828691b1
- moduleHash: 22048f895d526c388711804396b104ff1d52075610aefe71a7d51e0411120a6b
- policyManifestHash: 0576681f18c077824dd2d0a1280a7b1659d332b890a409f44d2bdd7d7f2b9697
- inputManifestHash: 11a3e0c970f1b33a2c1170ecf02f94924669584091b9d67ded3845288b20f4fe
