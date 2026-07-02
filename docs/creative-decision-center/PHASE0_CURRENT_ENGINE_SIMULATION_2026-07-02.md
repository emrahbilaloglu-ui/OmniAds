# Phase 0 - Current Engine Simulation

Generated at: 2026-07-02T16:22:53.546Z
Requested asOf: 2026-07-01
Freshness mode: wall_clock
Engine version: v3-2026-07-02-math-guardrails

## Scope

- Read-only replay: no DB writes, no snapshot upsert, no decision event insert.
- Uses the current WarehouseDataSource + current account profile + current decideCreative pipeline.
- If requested asOf is `latest`, each business uses its latest available lifecycle date, falling back to latest Meta creative date.

## Summary

| Business | Status | Simulated asOf | Freshness | Inputs | Decisions | Labels | Blocked hard | Confidence | Risk hints |
|---|---:|---:|---:|---:|---:|---|---:|---|---|
| EMOLOS | ok | 2026-07-01 | wall_clock | 85 | 85 | test_more: 64, diagnose: 11, keep: 10 | 11 | 60_69: 57, 70_79: 17, 50_59: 11 | campaign_label_guard_is_blocking_hard_actions, freshness_can_dominate_formula_replay, cut_boundary_is_loose_and_may_miss_weak_losers |
| Grandmix | ok | 2026-07-01 | wall_clock | 82 | 82 | test_more: 61, diagnose: 13, keep: 7, cut: 1 | 1 | 70_79: 63, 60_69: 18, 50_59: 1 | campaign_label_guard_is_blocking_hard_actions, freshness_can_dominate_formula_replay, scale_candidates_exist_but_benchmark_or_purchase_depth_blocks_action |
| IwaStore | ok | 2026-07-01 | wall_clock | 80 | 80 | test_more: 49, diagnose: 19, out_of_scope: 6, keep: 4, scale: 2 | 2 | 70_79: 51, 60_69: 27, 50_59: 2 | campaign_label_guard_is_blocking_hard_actions, freshness_can_dominate_formula_replay, global_default_truth_used_confidence_should_remain_capped, scale_candidates_exist_but_benchmark_or_purchase_depth_blocks_action |
| TheSwaf | ok | 2026-07-01 | wall_clock | 120 | 120 | test_more: 73, keep: 21, diagnose: 14, cut: 10, scale: 2 | 13 | 60_69: 77, 70_79: 30, 50_59: 13 | campaign_label_guard_is_blocking_hard_actions, freshness_can_dominate_formula_replay, scale_candidates_exist_but_benchmark_or_purchase_depth_blocks_action, cut_boundary_is_loose_and_may_miss_weak_losers |

## EMOLOS

Business ID: a7fd8563-8c9a-497a-b0d7-fd65e4248d1f
Simulated asOf: 2026-07-01
Freshness mode: wall_clock
Flags: enabled=true, surfaceVisible=true, shadowOnly=false, presetOverride=null
Profile: preset=balanced, spendUnit=34.5382, source=meta_derived_aov, confidence=medium
Thresholds: commercialMaturity=69.0763, hardCut=172.6908, scaleMinPurchases=1, bottomQuartileRatio=0.2069, severeLoserRatio=0.1023
Data health: worst=warning, degraded=false
Raw wall-clock data health: worst=warning, degraded=false

Distributions:
- label: test_more: 64, diagnose: 11, keep: 10
- signalFamily: data_health: 66, launch_monitoring: 17, campaign_label: 2
- badgeType: stale_calibration: 85, stale_lifecycle: 85, unlabeled_campaign_context: 82, stale_evidence: 60, launch_monitoring: 17, lifecycle_unavailable: 11, missing_recent_data: 11, stop_loss_review: 11, weak_performance: 10, low_ctr: 9, below_breakeven: 5
- labelTransform: null: 85
- truthSource: commercial_truth: 85
- campaignLabelStatus: unlabeled: 82, labeled: 3

Risk counters:
- hardActionRows: 0
- blockedHardActionRows: 11
- staleEvidenceRows: 60
- nullFreshnessRows: 0
- highConfidenceHardWithoutCommercialTruthRows: 0
- scaleReadinessBlockedRows: 0
- scaleCalibrationThinRows: 0
- hints: campaign_label_guard_is_blocking_hard_actions, freshness_can_dominate_formula_replay, cut_boundary_is_loose_and_may_miss_weak_losers

Sample hard/blocker rows:
| Creative | Campaign | Label | Blocked | Confidence | Spend | Purchases | ROAS | Ratio | Badges | Reason |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 2114021279176127 | 120247978903560459 | diagnose | cut | 50 | 903.47 | 4 | 0.4038 | 0.1615 | lifecycle_unavailable, stale_calibration, stale_lifecycle, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.40 (28d) = 16% of target after $903 spend (28d) — clear loser at scale. |
| 882021054308247 | 120247976989260459 | diagnose | cut | 50 | 829.77 | 2 | 0.2049 | 0.082 | lifecycle_unavailable, stale_calibration, stale_lifecycle, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.20 (28d) = 8% of target after $830 spend (28d) — clear loser at scale. |
| 2140854016698365 | 120246844298470459 | diagnose | cut | 50 | 408.38 | 1 | 0.12 | 0.048 | stale_evidence, lifecycle_unavailable, stale_calibration, stale_lifecycle, missing_recent_data, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.12 (28d) = 5% of target after $408 spend (28d) — clear loser at scale. |
| 874161595187435 | 120247978903560459 | diagnose | cut | 50 | 289.99 | 1 | 0.2614 | 0.1046 | lifecycle_unavailable, stale_calibration, stale_lifecycle, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.26 (28d) = 10% of target after $290 spend (28d) — clear loser at scale. |
| 1984995775464428 | 120247976989260459 | diagnose | cut | 50 | 216.49 | 0 | 0 | 0 | lifecycle_unavailable, stale_calibration, stale_lifecycle, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.00 (28d) = 0% of target after $216 spend (28d) — clear loser at scale. |
| 1570024971411166 | 120247976989260459 | diagnose | cut | 50 | 190.95 | 0 | 0 | 0 | lifecycle_unavailable, stale_calibration, stale_lifecycle, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.00 (28d) = 0% of target after $191 spend (28d) — clear loser at scale. |
| 1787452825569906 | 120247978903560459 | diagnose | cut | 50 | 169.34 | 0 | 0 | 0 | lifecycle_unavailable, stale_calibration, stale_lifecycle, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.00 (28d) = 0% of target after $169 spend (28d) — sustained loser. |
| 2055930891688956 | 120246844311280459 | diagnose | cut | 50 | 167.72 | 0 | 0 | 0 | stale_evidence, stale_calibration, stale_lifecycle, missing_recent_data, lifecycle_unavailable, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] 0 purchases on $168 spend (28d cumulative, age 18d) — sustained zero-conversion burn past CPA-anchored maturity threshold $104. |
| 3325839554275052 | 120246844311280459 | diagnose | cut | 50 | 138.13 | 0 | 0 | 0 | stale_evidence, lifecycle_unavailable, stale_calibration, stale_lifecycle, missing_recent_data, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.00 (28d) = 0% of target after $138 spend (28d) — sustained loser. |
| 2041704626539529 | 120247976989260459 | diagnose | cut | 50 | 105.44 | 0 | 0 | 0 | lifecycle_unavailable, stale_calibration, stale_lifecycle, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.00 (28d) = 0% of target after $105 spend (28d) — sustained loser. |
| 1027652930238244 | 120247978903560459 | diagnose | cut | 50 | 70.25 | 0 | 0 | 0 | lifecycle_unavailable, stale_calibration, stale_lifecycle, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.00 (28d) = 0% of target after $70 spend (28d) — loss-budget maturity reached at $69; cut underperforming creative. |

## Grandmix

Business ID: 5dbc7147-f051-4681-a4d6-20617170074f
Simulated asOf: 2026-07-01
Freshness mode: wall_clock
Flags: enabled=true, surfaceVisible=true, shadowOnly=false, presetOverride=null
Profile: preset=conservative, spendUnit=105.7029, source=meta_derived_aov, confidence=medium
Thresholds: commercialMaturity=264.2573, hardCut=845.6232, scaleMinPurchases=5, bottomQuartileRatio=0.4621, severeLoserRatio=0.2373
Data health: worst=warning, degraded=false
Raw wall-clock data health: worst=warning, degraded=false

Distributions:
- label: test_more: 61, diagnose: 13, keep: 7, cut: 1
- signalFamily: launch_monitoring: 46, data_health: 15, campaign_label: 11, diagnose: 5, performance_loser: 2, scale_readiness: 2, fatigue: 1
- badgeType: stale_lifecycle: 82, unlabeled_campaign_context: 61, launch_monitoring: 46, stale_evidence: 18, low_ctr: 9, landing_page_issue: 7, checkout_breakdown: 5, weak_performance: 3, lifecycle_unavailable: 2, scale_readiness_blocked: 2, below_breakeven: 1, creative_quality_weak: 1, fatigue_watch: 1
- labelTransform: null: 82
- truthSource: commercial_truth: 82
- campaignLabelStatus: unlabeled: 61, labeled: 21

Risk counters:
- hardActionRows: 1
- blockedHardActionRows: 1
- staleEvidenceRows: 18
- nullFreshnessRows: 0
- highConfidenceHardWithoutCommercialTruthRows: 0
- scaleReadinessBlockedRows: 2
- scaleCalibrationThinRows: 0
- hints: campaign_label_guard_is_blocking_hard_actions, freshness_can_dominate_formula_replay, scale_candidates_exist_but_benchmark_or_purchase_depth_blocks_action

Sample hard/blocker rows:
| Creative | Campaign | Label | Blocked | Confidence | Spend | Purchases | ROAS | Ratio | Badges | Reason |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1003770772089284 | 120247884799930316 | cut | null | 75 | 473.62 | 3 | 0.9776 | 0.4444 | stale_lifecycle, creative_quality_weak, lifecycle_unavailable | ROAS 0.98 (28d) = 44% of target after $474 spend (28d) — loss-budget maturity reached at $264; cut underperforming creative. |
| 27134621589538352 | 120249371622510316 | diagnose | scale | 50 | 1045.74 | 23 | 4.4766 | 2.0348 | stale_lifecycle, lifecycle_unavailable, unlabeled_campaign_context | [Unlabeled campaign - label to enable action] ROAS 4.48 (28d) = 203% of target 2.20 with 23 purchases (28d) and recent 7d holding at 4.58 — scale the ad set budget. |

## IwaStore

Business ID: f8a3b5ac-588c-462f-8702-11cd24ff3cd2
Simulated asOf: 2026-07-01
Freshness mode: wall_clock
Flags: enabled=true, surfaceVisible=true, shadowOnly=false, presetOverride=null
Profile: preset=balanced, spendUnit=49.9988, source=meta_derived_aov, confidence=medium
Thresholds: commercialMaturity=99.9975, hardCut=249.9938, scaleMinPurchases=3, bottomQuartileRatio=0.6709, severeLoserRatio=0.4252
Data health: worst=warning, degraded=false
Raw wall-clock data health: worst=warning, degraded=false

Distributions:
- label: test_more: 49, diagnose: 19, out_of_scope: 6, keep: 4, scale: 2
- signalFamily: launch_monitoring: 33, data_health: 19, campaign_label: 14, diagnose: 9, insufficient_signal: 2, fatigue: 1, keep: 1, performance_loser: 1
- badgeType: stale_lifecycle: 80, unlabeled_campaign_context: 35, launch_monitoring: 33, stale_evidence: 21, landing_page_issue: 15, low_ctr: 8, lifecycle_unavailable: 4, checkout_breakdown: 2, creative_quality_weak: 2, stop_loss_review: 2, fatigue_watch: 1, scale_readiness_blocked: 1, weak_performance: 1
- labelTransform: null: 80
- truthSource: commercial_truth: 74, global_default: 6
- campaignLabelStatus: labeled: 45, unlabeled: 35

Risk counters:
- hardActionRows: 2
- blockedHardActionRows: 2
- staleEvidenceRows: 21
- nullFreshnessRows: 0
- highConfidenceHardWithoutCommercialTruthRows: 0
- scaleReadinessBlockedRows: 1
- scaleCalibrationThinRows: 0
- hints: campaign_label_guard_is_blocking_hard_actions, freshness_can_dominate_formula_replay, global_default_truth_used_confidence_should_remain_capped, scale_candidates_exist_but_benchmark_or_purchase_depth_blocks_action

Sample hard/blocker rows:
| Creative | Campaign | Label | Blocked | Confidence | Spend | Purchases | ROAS | Ratio | Badges | Reason |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 946471284944193 | 120242560371390077 | scale | null | 75 | 688.28 | 21 | 5.4088 | 1.5454 | stale_lifecycle, lifecycle_unavailable | ROAS 5.41 (28d) = 155% of target 3.50 with 21 purchases (28d) and recent 7d holding at 5.97 — scale the ad set budget. |
| 1655577498670460 | 120242560371390077 | scale | null | 75 | 232.95 | 8 | 9.7356 | 2.7816 | stale_lifecycle, lifecycle_unavailable | ROAS 9.74 (28d) = 278% of target 3.50 with 8 purchases (28d) and recent 7d holding at 11.98 — scale the ad set budget. |
| 2266296250855098 | 120246476058260077 | diagnose | cut | 50 | 142.43 | 1 | 0.7039 | 0.2011 | stale_lifecycle, creative_quality_weak, lifecycle_unavailable, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.70 (28d) = 20% of target after $142 spend (28d) — loss-budget maturity reached at $100; cut underperforming creative. |
| 1888743981790432 | 120246441524690077 | diagnose | cut | 50 | 113.26 | 1 | 0.8254 | 0.2358 | stale_lifecycle, creative_quality_weak, lifecycle_unavailable, unlabeled_campaign_context, stop_loss_review | [Stop-loss review - label campaign before cut] ROAS 0.83 (28d) = 24% of target after $113 spend (28d) — loss-budget maturity reached at $100; cut underperforming creative. |

## TheSwaf

Business ID: 172d0ab8-495b-4679-a4c6-ffa404c389d3
Simulated asOf: 2026-07-01
Freshness mode: wall_clock
Flags: enabled=true, surfaceVisible=true, shadowOnly=false, presetOverride=null
Profile: preset=aggressive, spendUnit=94.4325, source=meta_derived_aov, confidence=medium
Thresholds: commercialMaturity=141.6488, hardCut=283.2976, scaleMinPurchases=2, bottomQuartileRatio=0.3949, severeLoserRatio=0.2824
Data health: worst=warning, degraded=false
Raw wall-clock data health: worst=warning, degraded=false

Distributions:
- label: test_more: 73, keep: 21, diagnose: 14, cut: 10, scale: 2
- signalFamily: data_health: 97, launch_monitoring: 11, performance_loser: 7, diagnose: 1, fatigue: 1, insufficient_signal: 1, keep: 1, scale_readiness: 1
- badgeType: stale_lifecycle: 120, stale_evidence: 90, unlabeled_campaign_context: 82, missing_recent_data: 27, lifecycle_unavailable: 25, creative_quality_weak: 19, weak_performance: 14, stop_loss_review: 13, low_ctr: 12, launch_monitoring: 11, below_breakeven: 7, checkout_breakdown: 2, scale_readiness_blocked: 2, fatigue_watch: 1, upper_funnel_strong_site_weak: 1
- labelTransform: null: 120
- truthSource: commercial_truth: 120
- campaignLabelStatus: unlabeled: 82, labeled: 38

Risk counters:
- hardActionRows: 12
- blockedHardActionRows: 13
- staleEvidenceRows: 90
- nullFreshnessRows: 0
- highConfidenceHardWithoutCommercialTruthRows: 0
- scaleReadinessBlockedRows: 2
- scaleCalibrationThinRows: 0
- hints: campaign_label_guard_is_blocking_hard_actions, freshness_can_dominate_formula_replay, scale_candidates_exist_but_benchmark_or_purchase_depth_blocks_action, cut_boundary_is_loose_and_may_miss_weak_losers

Sample hard/blocker rows:
| Creative | Campaign | Label | Blocked | Confidence | Spend | Purchases | ROAS | Ratio | Badges | Reason |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1962656064410174 | 120248656753610042 | cut | null | 75 | 6761.53 | 21 | 0.6391 | 0.2905 | stale_lifecycle, creative_quality_weak, lifecycle_unavailable | ROAS 0.64 (28d) = 29% of target after $6,762 spend (28d) — clear loser at scale. |
| 3041651776171249 | 120248657183060042 | cut | null | 75 | 6543.77 | 34 | 0.7389 | 0.3359 | stale_lifecycle, lifecycle_unavailable | ROAS 0.74 (28d) = 34% of target after $6,544 spend (28d) — clear loser at scale. |
| 913690625083809 | 120248657047720042 | cut | null | 75 | 3933.75 | 10 | 0.5596 | 0.2544 | stale_lifecycle, creative_quality_weak, lifecycle_unavailable | ROAS 0.56 (28d) = 25% of target after $3,934 spend (28d) — clear loser at scale. |
| 1546542256949523 | 120248657047720042 | cut | null | 75 | 2148.31 | 9 | 0.8095 | 0.3679 | stale_lifecycle, creative_quality_weak, lifecycle_unavailable | ROAS 0.81 (28d) = 37% of target after $2,148 spend (28d) — clear loser at scale. |
| 1000844809459077 | 120248657183060042 | cut | null | 75 | 689.92 | 3 | 0.8022 | 0.3647 | stale_lifecycle, lifecycle_unavailable | ROAS 0.80 (28d) = 36% of target after $690 spend (28d) — clear loser at scale. |
| 1007048011875307 | 120244828390840430 | cut | null | 75 | 524.16 | 0 | 0 | 0 | stale_lifecycle, creative_quality_weak, lifecycle_unavailable | ROAS 0.00 (28d) = 0% of target after $524 spend (28d) — clear loser at scale. |
| 1337157688566977 | 120248657114880042 | cut | null | 75 | 411.81 | 2 | 0.7303 | 0.332 | stale_lifecycle, creative_quality_weak, lifecycle_unavailable | ROAS 0.73 (28d) = 33% of target after $412 spend (28d) — clear loser at scale. |
| 2080314776223824 | 120248656753610042 | cut | null | 65 | 337.37 | 1 | 0.5928 | 0.2695 | stale_evidence, stale_lifecycle, creative_quality_weak, missing_recent_data, lifecycle_unavailable | ROAS 0.59 (28d) = 27% of target after $337 spend (28d) — clear loser at scale. |
| 1932525757401873 | 120248657011350042 | cut | null | 65 | 254.04 | 1 | 0.7085 | 0.3221 | stale_evidence, stale_lifecycle, creative_quality_weak, missing_recent_data, lifecycle_unavailable | ROAS 0.71 (28d) = 32% of target after $254 spend (28d) — loss-budget maturity reached at $142; cut underperforming creative. |
| 2734470570262623 | 120248657114880042 | cut | null | 65 | 144.58 | 0 | 0 | 0 | stale_evidence, stale_lifecycle, creative_quality_weak, missing_recent_data, lifecycle_unavailable | ROAS 0.00 (28d) = 0% of target after $145 spend (28d) — loss-budget maturity reached at $142; cut underperforming creative. |
| 1377865124404006 | 120248656753610042 | scale | null | 75 | 1059.66 | 10 | 3.9302 | 1.7865 | stale_lifecycle, lifecycle_unavailable | ROAS 3.93 (28d) = 179% of target 2.20 with 10 purchases (28d) and recent 7d holding at 4.40 — scale the ad set budget. |
| 1511570353840312 | 120244828402390430 | scale | null | 75 | 417.47 | 7 | 3.2819 | 1.4918 | stale_lifecycle, lifecycle_unavailable | ROAS 3.28 (28d) = 149% of target 2.20 with 7 purchases (28d) and recent 7d holding at 3.29 — scale the ad set budget. |

## Limitations

- This is a replay of the current engine pipeline; it does not change formulas or persist decisions.
- The report measures output distribution and guard pressure, not outcome precision or causal correctness.
- Historical rows may be marked stale because the current data-source computes freshness against wall-clock now.
- Historical freshness mode is analysis-only; actual runtime still uses wall-clock freshness.
- If a business has no lifecycle/meta source date, no formula conclusion should be drawn for that business.
