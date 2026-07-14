# Phase 0 - Current Engine Simulation

Generated at: 2026-07-14T15:02:05.615Z
Requested asOf: 2026-07-13
Freshness mode: historical
Engine version: v3-2026-07-14-decision-health-provenance

## Scope

- Read-only replay: no DB writes, no snapshot upsert, no decision event insert.
- Uses the current WarehouseDataSource + current account profile + current decideCreative pipeline.
- Analysis-only historical mode normalizes freshness to the simulated date so formula output is not dominated by wall-clock staleness.
- If requested asOf is `latest`, each business uses its latest available lifecycle date, falling back to latest Meta creative date.

## Summary

| Business | Status | Simulated asOf | Freshness | Inputs | Decisions | Labels | Blocked hard | Confidence | Risk hints |
|---|---:|---:|---:|---:|---:|---|---:|---|---|
| EMOLOS | ok | 2026-07-13 | historical | 57 | 57 | test_more: 34, keep: 20, out_of_scope: 3 | 0 | 00_49: 37, 50_59: 10, 60_69: 10 | historical_freshness_normalized_not_actual_runtime, raw_wall_clock_data_health_was_stale, global_default_truth_used_confidence_should_remain_capped, hard_action_eligibility_not_fully_ready_for_account |
| Grandmix | ok | 2026-07-13 | historical | 125 | 125 | test_more: 72, keep: 36, out_of_scope: 11, diagnose: 6 | 0 | 00_49: 93, 60_69: 23, 50_59: 9 | historical_freshness_normalized_not_actual_runtime, raw_wall_clock_data_health_was_stale, global_default_truth_used_confidence_should_remain_capped, hard_action_eligibility_not_fully_ready_for_account |
| IwaStore | ok | 2026-07-13 | historical | 96 | 96 | test_more: 40, keep: 38, diagnose: 11, out_of_scope: 7 | 0 | 00_49: 60, 60_69: 28, 50_59: 8 | historical_freshness_normalized_not_actual_runtime, raw_wall_clock_data_health_was_stale, global_default_truth_used_confidence_should_remain_capped, hard_action_eligibility_not_fully_ready_for_account |
| TheSwaf | ok | 2026-07-13 | historical | 91 | 91 | test_more: 47, keep: 22, out_of_scope: 22 | 0 | 00_49: 49, 60_69: 28, 50_59: 14 | historical_freshness_normalized_not_actual_runtime, raw_wall_clock_data_health_was_stale, global_default_truth_used_confidence_should_remain_capped, hard_action_eligibility_not_fully_ready_for_account |

## EMOLOS

Business ID: a7fd8563-8c9a-497a-b0d7-fd65e4248d1f
Simulated asOf: 2026-07-13
Freshness mode: historical
Flags: enabled=true, surfaceVisible=true, shadowOnly=false, presetOverride=null
Profile: preset=balanced, spendUnit=null, source=insufficient, confidence=insufficient
Thresholds: commercialMaturity=null, hardCut=null, scaleMinPurchases=1, bottomQuartileRatio=null, severeLoserRatio=null
Data health: worst=none, degraded=false
Raw wall-clock data health: worst=warning, degraded=false

Distributions:
- label: test_more: 34, keep: 20, out_of_scope: 3
- signalFamily: campaign_label: 18, keep: 16, insufficient_signal: 12, delivery: 11
- badgeType: quality_only_assessment: 54, truth_global_default: 54, unlabeled_campaign_context: 29, delivery_limited: 11, missing_recent_data: 4
- labelTransform: null: 57
- truthSource: global_default: 57
- campaignLabelStatus: unlabeled: 29, labeled: 28

Risk counters:
- hardActionRows: 0
- blockedHardActionRows: 0
- staleEvidenceRows: 0
- nullFreshnessRows: 0
- highConfidenceHardWithoutCommercialTruthRows: 0
- scaleReadinessBlockedRows: 0
- scaleCalibrationThinRows: 0
- hints: historical_freshness_normalized_not_actual_runtime, raw_wall_clock_data_health_was_stale, global_default_truth_used_confidence_should_remain_capped, hard_action_eligibility_not_fully_ready_for_account

## Grandmix

Business ID: 5dbc7147-f051-4681-a4d6-20617170074f
Simulated asOf: 2026-07-13
Freshness mode: historical
Flags: enabled=true, surfaceVisible=true, shadowOnly=false, presetOverride=null
Profile: preset=balanced, spendUnit=null, source=insufficient, confidence=insufficient
Thresholds: commercialMaturity=null, hardCut=null, scaleMinPurchases=1, bottomQuartileRatio=null, severeLoserRatio=null
Data health: worst=none, degraded=false
Raw wall-clock data health: worst=warning, degraded=false

Distributions:
- label: test_more: 72, keep: 36, out_of_scope: 11, diagnose: 6
- signalFamily: campaign_label: 63, delivery: 38, keep: 10, insufficient_signal: 8, diagnose: 4, out_of_scope: 2
- badgeType: truth_global_default: 114, quality_only_assessment: 108, unlabeled_campaign_context: 100, delivery_limited: 38, low_ctr: 13, missing_recent_data: 10, creative_quality_weak: 8, landing_page_issue: 5, checkout_breakdown: 1
- labelTransform: null: 125
- truthSource: global_default: 125
- campaignLabelStatus: unlabeled: 100, labeled: 25

Risk counters:
- hardActionRows: 0
- blockedHardActionRows: 0
- staleEvidenceRows: 0
- nullFreshnessRows: 0
- highConfidenceHardWithoutCommercialTruthRows: 0
- scaleReadinessBlockedRows: 0
- scaleCalibrationThinRows: 0
- hints: historical_freshness_normalized_not_actual_runtime, raw_wall_clock_data_health_was_stale, global_default_truth_used_confidence_should_remain_capped, hard_action_eligibility_not_fully_ready_for_account

## IwaStore

Business ID: f8a3b5ac-588c-462f-8702-11cd24ff3cd2
Simulated asOf: 2026-07-13
Freshness mode: historical
Flags: enabled=true, surfaceVisible=true, shadowOnly=false, presetOverride=null
Profile: preset=balanced, spendUnit=null, source=insufficient, confidence=insufficient
Thresholds: commercialMaturity=null, hardCut=null, scaleMinPurchases=1, bottomQuartileRatio=null, severeLoserRatio=null
Data health: worst=none, degraded=false
Raw wall-clock data health: worst=warning, degraded=false

Distributions:
- label: test_more: 40, keep: 38, diagnose: 11, out_of_scope: 7
- signalFamily: delivery: 31, campaign_label: 28, keep: 18, insufficient_signal: 14, diagnose: 4, out_of_scope: 1
- badgeType: truth_global_default: 89, quality_only_assessment: 84, delivery_limited: 31, unlabeled_campaign_context: 30, missing_recent_data: 16, low_ctr: 12, landing_page_issue: 7, checkout_breakdown: 4, creative_quality_weak: 3
- labelTransform: null: 96
- truthSource: global_default: 96
- campaignLabelStatus: labeled: 66, unlabeled: 30

Risk counters:
- hardActionRows: 0
- blockedHardActionRows: 0
- staleEvidenceRows: 0
- nullFreshnessRows: 0
- highConfidenceHardWithoutCommercialTruthRows: 0
- scaleReadinessBlockedRows: 0
- scaleCalibrationThinRows: 0
- hints: historical_freshness_normalized_not_actual_runtime, raw_wall_clock_data_health_was_stale, global_default_truth_used_confidence_should_remain_capped, hard_action_eligibility_not_fully_ready_for_account

## TheSwaf

Business ID: 172d0ab8-495b-4679-a4c6-ffa404c389d3
Simulated asOf: 2026-07-13
Freshness mode: historical
Flags: enabled=true, surfaceVisible=true, shadowOnly=false, presetOverride=null
Profile: preset=balanced, spendUnit=null, source=insufficient, confidence=insufficient
Thresholds: commercialMaturity=null, hardCut=null, scaleMinPurchases=1, bottomQuartileRatio=null, severeLoserRatio=null
Data health: worst=none, degraded=false
Raw wall-clock data health: worst=warning, degraded=false

Distributions:
- label: test_more: 47, keep: 22, out_of_scope: 22
- signalFamily: campaign_label: 61, insufficient_signal: 19, keep: 11
- badgeType: quality_only_assessment: 69, truth_global_default: 69, unlabeled_campaign_context: 61, missing_recent_data: 13, low_ctr: 9, creative_quality_weak: 7
- labelTransform: null: 91
- truthSource: global_default: 91
- campaignLabelStatus: unlabeled: 61, labeled: 30

Risk counters:
- hardActionRows: 0
- blockedHardActionRows: 0
- staleEvidenceRows: 0
- nullFreshnessRows: 0
- highConfidenceHardWithoutCommercialTruthRows: 0
- scaleReadinessBlockedRows: 0
- scaleCalibrationThinRows: 0
- hints: historical_freshness_normalized_not_actual_runtime, raw_wall_clock_data_health_was_stale, global_default_truth_used_confidence_should_remain_capped, hard_action_eligibility_not_fully_ready_for_account

## Limitations

- This is a replay of the current engine pipeline; it does not change formulas or persist decisions.
- The report measures output distribution and guard pressure, not outcome precision or causal correctness.
- Historical rows may be marked stale because the current data-source computes freshness against wall-clock now.
- Historical freshness mode is analysis-only; actual runtime still uses wall-clock freshness.
- If a business has no lifecycle/meta source date, no formula conclusion should be drawn for that business.
