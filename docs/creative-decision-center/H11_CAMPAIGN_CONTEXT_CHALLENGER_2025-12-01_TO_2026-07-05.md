# H11 Campaign Context Challenger Closure

Deterministic, SELECT-only historical simulation of the fixed 4x2 campaign-context matrix. This is restated-history evidence, not authorization to change production resolver behavior or enable automatic execution.

## Verdict

- verdict: **RETAIN_PRODUCTION_DEFAULT**
- selected on calibration: H11_P1_no_lineage_renormalized
- locked-test gate: reject
- automatic consumption recommendation: DO_NOT_ENABLE
- production change: No H11 resolver formula/configuration change is justified by retained history.
- reason: The calibration-selected policy H11_P1_no_lineage_renormalized did not pass every locked-test gate (reject); bounded H11 alternatives are closed rather than left open.

## Contract

- contract: adsecute.meta.h11-campaign-context-challenger.v2
- resolver: campaign-context-resolver.v1-shadow-2026-07-06
- source tier: restated_ad_daily_plus_current_manual_label_truth
- decision dates: 2025-12-01 .. 2026-07-05
- policies: 8 exactly; bootstrap: 10000 business/entity clustered replicates, 7-day moving blocks
- DB boundary: transaction_read_only=on; SELECT statements only; no provider or production writes

## Predeclared Policies

| Policy | Signals | Thresholds | Baseline | Config hash | Definition |
| --- | --- | --- | --- | --- | --- |
| H11_P0_production_default | production | production | yes | 36ccb9f9aa16 | Exact shipped resolver configuration and lineage policy. |
| H11_P1_no_lineage_renormalized | no_lineage | production | no | b4be660cb0cb | Eliminates the known first-attribution lineage weakness and redistributes its 0.10 weight before observing outcomes. |
| H11_P2_no_naming_renormalized | no_naming | production | no | d4a2ecf7cacf | Eliminates mutable campaign-name evidence, including name-vs-behavior conflicts, while retaining lineage as a sensitivity axis. |
| H11_P3_conservative_confidence | production | conservative | no | 97a6b2749aca | Keeps shipped signals but raises predeclared high/medium evidence thresholds to test whether hard-action context can be made safer without collapse. |
| H11_P4_no_lineage_no_naming_renormalized | no_lineage_no_naming | production | no | 992b9e3277a7 | Removes both retained-history reliability risks together and redistributes their fixed weight before observing outcomes. |
| H11_P5_no_lineage_conservative_confidence | no_lineage | conservative | no | e90e33b4bea0 | Crosses the lineage ablation with the same bounded conservative threshold regime. |
| H11_P6_no_naming_conservative_confidence | no_naming | conservative | no | b0b48acb4f3e | Crosses the naming ablation with the same bounded conservative threshold regime. |
| H11_P7_no_lineage_no_naming_conservative_confidence | no_lineage_no_naming | conservative | no | 81d39fd031b5 | Crosses the combined reliability ablation with the same bounded conservative threshold regime. |

## Data Coverage

- businesses: 12
- providerAccounts: 13
- campaigns: 349
- creativeDayRows: 87945
- campaignNameChangeRows: 2228
- campaignFirstSeenRows: 2183
- manualLabelRows: 59
- manualLabelsWithExactAccount: 59
- manualLabelsWithInferredUniqueAccount: 0
- manualLabelsWithUnresolvedAccount: 0
- duplicateManualLabelKeys: 0
- labeledDailyObservations: 34104
- labelAvailableAtDecisionObservations: 16760
- labelAvailableAtDecisionRate: 0.49143795449214167

## Rolling-Origin Evaluation

One campaign contributes at most one anchor per fold. Daily rows are reserved for stability and the clustered bootstrap; they do not inflate the evidence gate.

| Fold | Policy | Labeled campaigns | Classified | High n | High accuracy | Wilson lower | False Test | Coverage |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| development | H11_P0_production_default | 13 | 12 | 2 | 100.00% | 34.24% | 2 | 92.31% |
| development | H11_P1_no_lineage_renormalized | 13 | 12 | 7 | 85.71% | 48.69% | 2 | 92.31% |
| development | H11_P2_no_naming_renormalized | 13 | 12 | 8 | 87.50% | 52.91% | 2 | 92.31% |
| development | H11_P3_conservative_confidence | 13 | 12 | 1 | 100.00% | 20.65% | 2 | 92.31% |
| development | H11_P4_no_lineage_no_naming_renormalized | 13 | 12 | 9 | 88.89% | 56.50% | 1 | 92.31% |
| development | H11_P5_no_lineage_conservative_confidence | 13 | 12 | 2 | 100.00% | 34.24% | 2 | 92.31% |
| development | H11_P6_no_naming_conservative_confidence | 13 | 12 | 1 | 100.00% | 20.65% | 2 | 92.31% |
| development | H11_P7_no_lineage_no_naming_conservative_confidence | 13 | 12 | 2 | 100.00% | 34.24% | 2 | 92.31% |
| calibration | H11_P0_production_default | 50 | 37 | 7 | 71.43% | 35.89% | 2 | 74.00% |
| calibration | H11_P1_no_lineage_renormalized | 50 | 37 | 21 | 85.71% | 65.36% | 2 | 74.00% |
| calibration | H11_P2_no_naming_renormalized | 50 | 37 | 21 | 85.71% | 65.36% | 3 | 74.00% |
| calibration | H11_P3_conservative_confidence | 50 | 37 | 5 | 60.00% | 23.07% | 2 | 74.00% |
| calibration | H11_P4_no_lineage_no_naming_renormalized | 50 | 37 | 22 | 86.36% | 66.67% | 3 | 74.00% |
| calibration | H11_P5_no_lineage_conservative_confidence | 50 | 37 | 12 | 75.00% | 46.77% | 2 | 74.00% |
| calibration | H11_P6_no_naming_conservative_confidence | 50 | 37 | 10 | 70.00% | 39.68% | 3 | 74.00% |
| calibration | H11_P7_no_lineage_no_naming_conservative_confidence | 50 | 37 | 10 | 70.00% | 39.68% | 3 | 74.00% |
| locked_test | H11_P0_production_default | 58 | 34 | 8 | 75.00% | 40.93% | 0 | 58.62% |
| locked_test | H11_P1_no_lineage_renormalized | 58 | 34 | 17 | 82.35% | 58.97% | 0 | 58.62% |
| locked_test | H11_P2_no_naming_renormalized | 58 | 37 | 22 | 81.82% | 61.48% | 0 | 63.79% |
| locked_test | H11_P3_conservative_confidence | 58 | 34 | 7 | 71.43% | 35.89% | 0 | 58.62% |
| locked_test | H11_P4_no_lineage_no_naming_renormalized | 58 | 37 | 22 | 81.82% | 61.48% | 0 | 63.79% |
| locked_test | H11_P5_no_lineage_conservative_confidence | 58 | 34 | 9 | 77.78% | 45.26% | 0 | 58.62% |
| locked_test | H11_P6_no_naming_conservative_confidence | 58 | 37 | 6 | 66.67% | 30.00% | 0 | 63.79% |
| locked_test | H11_P7_no_lineage_no_naming_conservative_confidence | 58 | 37 | 8 | 62.50% | 30.57% | 0 | 63.79% |

## Locked-Test Robustness

| Policy | Anchor pairs | McNemar net wins | p | Bootstrap delta [95%] | LOBO direction | LOAO direction | Gate | Closure |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| H11_P0_production_default | 58 | 0 | 1.0000 | 0.00% [0.00%, 0.00%] | mixed_or_zero | mixed_or_zero | reject | retain_as_policy |
| H11_P1_no_lineage_renormalized | 58 | 0 | 1.0000 | 0.00% [0.00%, 0.00%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P2_no_naming_renormalized | 58 | 0 | 1.0000 | -0.57% [-2.77%, 0.94%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P3_conservative_confidence | 58 | 0 | 1.0000 | 0.00% [0.00%, 0.00%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P4_no_lineage_no_naming_renormalized | 58 | 0 | 1.0000 | -0.51% [-2.97%, 1.40%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P5_no_lineage_conservative_confidence | 58 | 0 | 1.0000 | 0.00% [0.00%, 0.00%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P6_no_naming_conservative_confidence | 58 | 0 | 1.0000 | -0.57% [-2.75%, 0.92%] | mixed_or_zero | mixed_or_zero | reject | reject |
| H11_P7_no_lineage_no_naming_conservative_confidence | 58 | 0 | 1.0000 | -0.51% [-3.02%, 1.34%] | mixed_or_zero | mixed_or_zero | reject | reject |

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
| ColorFullWorldsTR / act_3554615364751964 | 2 | 1 | 1 | 100.00% | n/a | 50.00% |
| EMOLOS / act_1054905059780305 | 5 | 0 | 0 | n/a | 0.00% | 0.00% |
| Grandmix / act_805150454596350 | 9 | 4 | 3 | 100.00% | 0.00% | 44.44% |
| Halıcızade / act_590466298182006 | 4 | 1 | 1 | 100.00% | 0.00% | 25.00% |
| IwaStore / act_1087566732415606 | 5 | 3 | 2 | 100.00% | 0.00% | 60.00% |
| TheSwaf / act_822913786458311 | 18 | 11 | 0 | n/a | 0.00% | 61.11% |
| TheSwaf / act_921275999286619 | 3 | 2 | 2 | 0.00% | n/a | 66.67% |
| Tiles Workshop / act_904404985140555 | 12 | 12 | 8 | 87.50% | 0.00% | 100.00% |

## Stability And Sensitivity

| Policy | Published flips/100d | Raw flips/100d | Unresolved | Collapsed accounts | Invariant violations | Placebo p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| H11_P0_production_default | 3.6457 | 4.2784 | 24.96% | 0 | 0 | 0.9500 |
| H11_P1_no_lineage_renormalized | 3.6457 | 4.6701 | 22.15% | 0 | 0 | 0.9500 |
| H11_P2_no_naming_renormalized | 4.1277 | 4.5797 | 21.03% | 0 | 0 | 1.0000 |
| H11_P3_conservative_confidence | 3.5854 | 4.1277 | 25.13% | 0 | 0 | 0.9500 |
| H11_P4_no_lineage_no_naming_renormalized | 4.0374 | 4.3688 | 21.06% | 0 | 0 | 1.0000 |
| H11_P5_no_lineage_conservative_confidence | 3.6457 | 4.2181 | 24.96% | 0 | 0 | 0.9500 |
| H11_P6_no_naming_conservative_confidence | 4.0374 | 4.4893 | 21.03% | 0 | 0 | 1.0000 |
| H11_P7_no_lineage_no_naming_conservative_confidence | 3.9771 | 4.3085 | 21.06% | 0 | 0 | 1.0000 |

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
| H11_P0_production_default | 3462 | 719 | 2743 | 0 | 0 |
| H11_P1_no_lineage_renormalized | 3462 | 1351 | 2111 | 634 | 0 |
| H11_P2_no_naming_renormalized | 3462 | 1505 | 1957 | 808 | 0 |
| H11_P3_conservative_confidence | 3462 | 468 | 2994 | 251 | 0 |
| H11_P4_no_lineage_no_naming_renormalized | 3462 | 1680 | 1782 | 967 | 0 |
| H11_P5_no_lineage_conservative_confidence | 3462 | 610 | 2852 | 217 | 0 |
| H11_P6_no_naming_conservative_confidence | 3462 | 609 | 2853 | 338 | 0 |
| H11_P7_no_lineage_no_naming_conservative_confidence | 3462 | 647 | 2815 | 340 | 0 |

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
- Only 59 reviewed labels exist and unlabeled campaigns have no independent role truth; restated behavior cannot manufacture reviewed Main/Test/Mixed ground truth.
- meta_creative_daily campaign/creative lineage is normalized and restatable rather than an immutable raw point-in-time identity graph; same-day multi-campaign reuse that was not retained cannot be recovered.
- Historical campaign status, policy/learning state, and every prior rename are not all preserved as exact raw point-in-time inputs; this replay therefore cannot claim exact producer reproduction.
- A context classification's causal effect on later buyer actions or business outcomes requires contemporaneous controlled assignment; observational history cannot reconstruct that counterfactual.

## Deterministic Lineage

- sourceHash: d7528e61d770a035db3614c78b53dbab010b75b6c3b00bf5cfb195155fb9c61b
- scriptHash: 94b4cba4c2f9185ced18f4c8bfe6f67fc5cc2823658201927f5c3130e15e768c
- moduleHash: 65af0a36507b2643355983f493590252cef5e63e0a4b2772efefbebf1899b926
- policyManifestHash: fe635d8db1157e385ba9173e999c9ddf0bc366c25e9f115f3108b3f58356b863
- inputManifestHash: 59f7b35d923ddab415915dc325c46d918e5ddc091f825c720040da73f022ee8d
