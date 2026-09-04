# Golden Media-Buyer Cases

These cases must become executable fixtures before resolver behavior changes. Do not only test `buyerAction`; each case asserts confidence, priority, problemClass, maturity, and top reason tag.

| caseId  | inputSummary                                                                                                                                   | expectedPrimaryDecision | expectedBuyerAction | expectedActionability | expectedProblemClass | expectedPriorityBand | expectedConfidenceBand | expectedTopReasonTag                     | expectedMaturity | expectedSafeFallbackIfDataMissing |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------- | --------------------- | -------------------- | -------------------- | ---------------------- | ---------------------------------------- | ---------------- | --------------------------------- |
| GC-001  | active ad + active campaign/adset + 24h spend 0 + impressions 0                                                                                | Diagnose                | fix_delivery        | diagnose              | delivery             | high                 | medium                 | active_no_spend_24h                      | learning         | diagnose_data                     |
| GC-002  | no spend but campaign paused                                                                                                                   | Diagnose                | diagnose_data       | diagnose              | campaign_context     | medium               | medium                 | campaign_paused                          | learning         | diagnose_data                     |
| GC-003  | adset paused                                                                                                                                   | Diagnose                | diagnose_data       | diagnose              | campaign_context     | medium               | medium                 | adset_paused                             | learning         | diagnose_data                     |
| GC-004  | disapproved creative                                                                                                                           | Diagnose                | fix_policy          | diagnose              | policy               | high                 | high                   | disapproved_or_limited                   | learning         | diagnose_data                     |
| GC-005  | limited delivery with reason                                                                                                                   | Diagnose                | fix_policy          | diagnose              | policy               | high                 | high                   | disapproved_or_limited                   | learning         | diagnose_data                     |
| GC-006  | policy status unknown                                                                                                                          | Diagnose                | diagnose_data       | diagnose              | data_quality         | medium               | low                    | missing_policy_status                    | learning         | diagnose_data                     |
| GC-007  | new launch under 48h with low spend                                                                                                            | Test More               | watch_launch        | review_only           | launch_monitoring    | medium               | medium                 | new_launch_window                        | too_early        | diagnose_data                     |
| GC-008  | new launch under 72h with enough spend but no purchase                                                                                         | Test More               | watch_launch        | review_only           | launch_monitoring    | high                 | medium                 | new_launch_window                        | learning         | diagnose_data                     |
| GC-009  | new launch with severe overspend and no purchases                                                                                              | Test More               | watch_launch        | review_only           | launch_monitoring    | high                 | medium                 | new_launch_severe_spend_no_purchase      | learning         | diagnose_data                     |
| GC-010  | mature high-spend loser                                                                                                                        | Cut                     | cut                 | review_only           | performance          | high                 | high                   | severe_sustained_loser                   | mature           | diagnose_data                     |
| GC-011  | mature high-confidence winner                                                                                                                  | Scale                   | scale               | review_only           | performance          | high                 | high                   | strong_relative_winner                   | mature           | diagnose_data                     |
| GC-012  | winner entering fatigue                                                                                                                        | Refresh                 | refresh             | review_only           | fatigue              | high                 | high                   | fatigue_composite                        | mature           | diagnose_data                     |
| GC-013  | CTR down but frequency flat and CPM flat                                                                                                       | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | partial_fatigue_signal                   | actionable       | diagnose_data                     |
| GC-014  | frequency up but CTR stable                                                                                                                    | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | partial_fatigue_signal                   | actionable       | diagnose_data                     |
| GC-015  | CPM up but CPA/ROAS stable                                                                                                                     | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | partial_fatigue_signal                   | actionable       | diagnose_data                     |
| GC-016  | benchmark missing                                                                                                                              | Diagnose                | diagnose_data       | diagnose              | data_quality         | medium               | low                    | benchmark_missing                        | learning         | diagnose_data                     |
| GC-017  | benchmark weak                                                                                                                                 | Diagnose                | diagnose_data       | diagnose              | data_quality         | medium               | low                    | weak_benchmark                           | learning         | diagnose_data                     |
| GC-018  | stale data                                                                                                                                     | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | stale_data                               | learning         | diagnose_data                     |
| GC-019  | attribution/truth missing                                                                                                                      | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | truth_missing                            | learning         | diagnose_data                     |
| GC-020  | tracking drop suspected                                                                                                                        | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | tracking_drop_suspected                  | learning         | diagnose_data                     |
| GC-021  | high priority but low confidence delivery issue                                                                                                | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | missing_delivery_proof                   | learning         | diagnose_data                     |
| GC-022  | low maturity but high priority policy issue                                                                                                    | Diagnose                | fix_policy          | diagnose              | policy               | high                 | high                   | disapproved_or_limited                   | too_early        | diagnose_data                     |
| GC-023  | mature data but low confidence due to attribution degradation                                                                                  | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | truth_degraded                           | mature           | diagnose_data                     |
| GC-024  | active creative with spend but zero impressions anomaly                                                                                        | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | spend_without_impressions                | learning         | diagnose_data                     |
| GC-025  | high CTR but poor CVR / landing issue                                                                                                          | Diagnose                | diagnose_data       | diagnose              | performance          | medium               | medium                 | landing_or_cvr_issue                     | actionable       | diagnose_data                     |
| GC-026  | strong ROAS but tiny spend, not mature                                                                                                         | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | tiny_spend_winner                        | too_early        | diagnose_data                     |
| GC-027  | strong CPA but low purchase count, not scalable yet                                                                                            | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | low_purchase_count                       | learning         | diagnose_data                     |
| GC-028  | top 3 fatigue cluster                                                                                                                          | Refresh                 | refresh             | review_only           | fatigue              | high                 | high                   | fatigue_composite                        | mature           | diagnose_data                     |
| GC-029  | no new winner in 7 days                                                                                                                        | Protect                 | protect             | review_only           | performance          | medium               | medium                 | winner_gap_aggregate_only                | mature           | disable_aggregate                 |
| GC-030  | approved but unused creative exists                                                                                                            | Diagnose                | diagnose_data       | diagnose              | campaign_context     | medium               | medium                 | unused_approved_aggregate_only           | too_early        | disable_aggregate                 |
| GC-031  | family winner aging with no backup variants                                                                                                    | Protect                 | protect             | review_only           | performance          | medium               | medium                 | backup_variant_aggregate_only            | mature           | disable_aggregate                 |
| GC-032  | old challenger says scale_hard but V2 says Test More                                                                                           | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | low_evidence                             | learning         | diagnose_data                     |
| GC-033  | operator surface says act_now but V2 says Diagnose                                                                                             | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | truth_degraded                           | learning         | diagnose_data                     |
| GC-034  | old V1 stable_winner maps to V2 Protect                                                                                                        | Protect                 | protect             | review_only           | performance          | medium               | high                   | stable_winner                            | mature           | diagnose_data                     |
| GC-035  | old V1 fatigued_winner maps to V2 Refresh                                                                                                      | Refresh                 | refresh             | review_only           | fatigue              | high                 | high                   | fatigue_composite                        | mature           | diagnose_data                     |
| GC-036  | unlabeled campaign with would-be scale                                                                                                         | Diagnose                | diagnose_data       | review_only           | data_quality         | medium               | low                    | campaign_label_missing                   | mature           | diagnose_data                     |
| GC-037  | labeled campaign with would-be scale                                                                                                           | Scale                   | scale               | review_only           | performance          | high                 | high                   | strong_relative_winner                   | mature           | diagnose_data                     |
| GC-038  | labeled Main creative where Main baseline is stricter than all baseline                                                                        | Keep                    | review              | review_only           | performance          | medium               | medium                 | kind_main_baseline_stricter              | mature           | canonical_all_fallback            |
| GC-039  | labeled Test creative where Test baseline is easier than all baseline                                                                          | Scale                   | scale               | review_only           | performance          | high                 | high                   | kind_test_baseline_selected              | mature           | canonical_all_fallback            |
| GC-040  | labeled Main creative with sparse/null Main calibration row                                                                                    | Same as canonical       | same_as_canonical   | review_only           | performance          | medium               | medium                 | kind_baseline_fallback                   | mature           | canonical_all_fallback            |
| GC-041  | labeled Mixed creative with no sufficient Mixed calibration row                                                                                | Same as canonical       | same_as_canonical   | review_only           | performance          | medium               | medium                 | kind_mixed_fallback                      | mature           | canonical_all_fallback            |
| GC-042  | unlabeled campaign with would-be scale after kind-aware resolver                                                                               | Diagnose                | diagnose_data       | review_only           | data_quality         | medium               | low                    | campaign_label_missing                   | mature           | diagnose_data                     |
| GC-043  | labeled Test creative with gate-emitted refresh signal                                                                                         | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | test_cohort_refresh_to_cut               | mature           | diagnose_data                     |
| GC-044a | labeled Test creative with refresh signal where transformed cut is soft-blocked                                                                | Test More               | test_more           | review_only           | performance          | medium               | medium                 | test_cohort_refresh_to_cut_soft_blocked  | mature           | diagnose_data                     |
| GC-044b | labeled Test creative where original refresh would be soft-blocked but transformed cut is allowed                                              | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | test_cohort_refresh_before_soft_only     | mature           | diagnose_data                     |
| GC-045  | labeled Main creative with gate-emitted refresh signal                                                                                         | Refresh                 | refresh             | review_only           | fatigue              | high                 | medium                 | fatigue_composite                        | mature           | diagnose_data                     |
| GC-046  | labeled Mixed creative with gate-emitted refresh signal                                                                                        | Refresh                 | refresh             | review_only           | fatigue              | high                 | medium                 | fatigue_composite                        | mature           | diagnose_data                     |
| GC-047  | unlabeled creative with gate-emitted refresh signal                                                                                            | Diagnose                | diagnose_data       | review_only           | data_quality         | medium               | low                    | campaign_label_missing                   | mature           | diagnose_data                     |
| GC-048  | spend reaches commercial loss-budget floor, purchases below scale floor, ROAS below account bottom quartile                                    | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | loss_budget_mature_loser                 | mature           | diagnose_data                     |
| GC-049  | spend reaches commercial loss-budget floor, purchases below scale floor, ROAS in working zone                                                  | Keep                    | review              | review_only           | performance          | medium               | medium                 | weak_zone_not_cut                        | mature           | diagnose_data                     |
| GC-050  | spend reaches commercial loss-budget floor and ROAS is above scale threshold, but purchases are below scale floor                              | Keep                    | review              | review_only           | performance          | high                 | medium                 | near_scale_low_purchase_depth            | mature           | diagnose_data                     |
| GC-051  | scale-zone creative meets spend, purchase, and recent-hold gates, but account calibration sample is too thin for scale                         | Keep                    | review              | review_only           | performance          | high                 | medium                 | scale_calibration_thin                   | mature           | diagnose_data                     |
| GC-052  | scale-zone creative meets spend, purchase, and recent-hold gates, but winner purchase benchmark is missing                                     | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | scale_benchmark_missing                  | mature           | diagnose_data                     |
| GC-053  | scale-zone creative meets spend, purchase, recent-hold, and account winner benchmark readiness                                                 | Scale                   | scale               | review_only           | performance          | high                 | high                   | strong_relative_winner                   | mature           | diagnose_data                     |
| GC-054  | scale-ready winner in an explicit Test campaign                                                                                                | Scale                   | promote_to_main     | review_only           | performance          | high                 | high                   | strong_relative_winner                   | mature           | diagnose_data                     |
| GC-055  | scale-ready winner in an explicit Main campaign                                                                                                | Scale                   | scale_budget        | review_only           | performance          | high                 | high                   | strong_relative_winner                   | mature           | diagnose_data                     |
| GC-056  | scale-ready winner in an explicit Mixed campaign                                                                                               | Scale                   | controlled_scale    | review_only           | performance          | high                 | high                   | strong_relative_winner                   | mature           | diagnose_data                     |
| GC-057  | stale source evidence with a severe scaled stop-loss loser                                                                                     | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | stale_stop_loss_review                   | mature           | diagnose_data                     |
| GC-058  | stale source evidence with a sustained loser past commercial maturity                                                                          | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | stale_sustained_loser                    | mature           | diagnose_data                     |
| GC-059  | cut-zone creative has enough recent spend and recent 7d ROAS above target                                                                      | Keep                    | review              | review_only           | performance          | high                 | high                   | recovery_hold                            | mature           | diagnose_data                     |
| GC-060  | scale-ready winner has unknown source freshness                                                                                                | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | unknown_freshness_scale_block            | mature           | diagnose_data                     |
| GC-061  | funnel-step issue has unknown source freshness, so fresh proof is unavailable                                                                  | Keep                    | review              | review_only           | data_quality         | medium               | medium                 | unknown_freshness_funnel_proof_required  | mature           | diagnose_data                     |
| GC-062  | active creative has verified 0 spend and 0 impressions at 35h source freshness                                                                 | Diagnose                | fix_delivery        | diagnose              | delivery             | high                 | medium                 | active_no_spend_24h_fresh_boundary       | learning         | diagnose_data                     |
| GC-063  | 40h source freshness blocks no-delivery proof but mature severe loser math is present                                                          | Cut                     | cut                 | review_only           | performance          | high                 | high                   | freshness_boundary_severe_cut            | mature           | diagnose_data                     |
| GC-064  | 49h source freshness with a mature severe loser                                                                                                | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | stale_severe_cut_confidence_cap          | mature           | diagnose_data                     |
| GC-065  | unknown source freshness with a mature severe loser                                                                                            | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | unknown_freshness_severe_cut_cap         | mature           | diagnose_data                     |
| GC-066  | scale-ready winner has stale source freshness                                                                                                  | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | stale_freshness_scale_block              | mature           | diagnose_data                     |
| GC-067  | scale-ready winner has unknown source freshness as canonical scale blocker                                                                     | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | unknown_freshness_scale_block            | mature           | diagnose_data                     |
| GC-068  | funnel-step issue has unknown source freshness as canonical funnel blocker                                                                     | Keep                    | review              | review_only           | data_quality         | medium               | medium                 | unknown_freshness_funnel_proof_required  | mature           | diagnose_data                     |
| GC-069  | cut-zone creative has enough recent spend and recent 7d ROAS above target as canonical recovery hold                                           | Keep                    | review              | review_only           | performance          | high                 | high                   | recovery_hold                            | mature           | diagnose_data                     |
| GC-070  | cut-zone creative has recent 7d ROAS above target but recent spend below the recovery sample threshold                                         | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | recovery_hold_spend_boundary             | mature           | diagnose_data                     |
| GC-071  | cut-zone creative has enough recent spend but recent 7d ROAS equals target exactly                                                             | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | recovery_hold_strict_roas_boundary       | mature           | diagnose_data                     |
| GC-077  | scale-ready winner uses a positive commercial target confirmed within the 30-day freshness window                                              | Scale                   | scale               | review_only           | performance          | high                 | high                   | fresh_commercial_truth_unchanged         | mature           | diagnose_data                     |
| GC-078  | scale-ready winner uses a positive commercial target last confirmed more than 30 days ago                                                      | Scale                   | scale               | review_only           | performance          | high                 | high                   | target_age_does_not_change_authority     | mature           | diagnose_data                     |
| GC-079  | scale-ready winner uses a positive commercial target whose update time is unknown                                                              | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | commercial_truth_unknown_scale_block     | mature           | diagnose_data                     |
| GC-080  | mature ad is above fresh break-even but below an unusually high account P25                                                                    | Keep                    | review              | review_only           | performance          | medium               | medium                 | breakeven_cut_ceiling                    | mature           | diagnose_data                     |
| GC-081  | mature ad is between account P25 and fresh break-even, clears canonical Cut maturity, and recent ROAS is sufficiently sampled below break-even | Cut                     | cut                 | review_only           | performance          | high                 | high                   | expanded_economic_loss                   | mature           | diagnose_data                     |
| GC-082  | old valid target with a mature clear-loss profile remains a hard cut                                                                           | Cut                     | cut                 | review_only           | performance          | high                 | high                   | old_target_clear_loss_cut                | mature           | diagnose_data                     |
| GC-083  | exact purchase cell has no calibrated P25 but valid target/break-even and a mature loss below the cold-start stop-loss boundary                | Cut                     | cut                 | review_only           | performance          | high                 | high                   | uncalibrated_commercial_stop_loss        | mature           | diagnose_data                     |
| GC-084  | exact purchase cell has no calibrated P25 and sits below the cold-start ratio but above explicit break-even                                    | Keep                    | review              | review_only           | performance          | medium               | medium                 | uncalibrated_break_even_ceiling          | mature           | diagnose_data                     |
| GC-091  | expanded-strip mature loser has sufficient recent spend and recent ROAS equal to break-even                                                    | Keep                    | review              | review_only           | performance          | high                 | high                   | economic_recovery_hold                   | mature           | diagnose_data                     |
| GC-092  | expanded-strip mature loser has sufficient recent spend and recent ROAS above break-even                                                       | Keep                    | review              | review_only           | performance          | high                 | high                   | economic_recovery_hold                   | mature           | diagnose_data                     |
| GC-093  | expanded-strip mature loser has missing recent ROAS or spend                                                                                   | Test More               | null                | blocked               | data_quality         | high                 | medium                 | recent_recovery_unverifiable             | mature           | diagnose_data                     |
| GC-094  | expanded-strip mature loser has recent spend below the canonical recent-sample threshold                                                       | Test More               | null                | blocked               | data_quality         | high                 | medium                 | recent_recovery_unverifiable             | mature           | diagnose_data                     |
| GC-095  | mature loser remains below the legacy safe boundary with thin recent evidence                                                                  | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | recovery_hold_spend_boundary             | mature           | diagnose_data                     |
| GC-096  | fatigued creative is in the expanded economic strip and otherwise clears Cut maturity                                                          | Refresh                 | refresh             | review_only           | fatigue              | high                 | high                   | fatigue_composite                        | mature           | diagnose_data                     |
| GC-097  | mature creative's lifetime ROAS ratio equals explicit break-even ratio exactly                                                                 | Keep                    | review              | review_only           | performance          | medium               | medium                 | breakeven_cut_ceiling                    | mature           | diagnose_data                     |
| GC-098  | below-maturity creative clears severe target-relative spend/ratio gates but lifetime ROAS is at or above explicit break-even                   | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | above_breakeven_severe_ratio_not_cut     | learning         | diagnose_data                     |
| GC-099  | purchase cohort reports zero cumulative purchases but positive cumulative purchase value and ROAS                                              | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | high                   | contradictory_purchase_truth             | mature           | diagnose_data                     |
| GC-100  | purchase cohort reports positive recent spend and purchases but zero recent ROAS                                                               | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | high                   | contradictory_recent_purchase_truth      | mature           | diagnose_data                     |
| GC-101  | mature confirmed loser is inside the expanded P25-to-break-even strip while ROAS/target is above 0.85                                          | Cut                     | cut                 | review_only           | performance          | high                 | high                   | expanded_economic_loss_above_target_band | mature           | diagnose_data                     |
| GC-102  | thin exact cell has a lower untrusted Cut floor than its trusted physical-account AOV repair and spend is between them                         | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | trusted_account_aov_floor_not_reached    | learning         | diagnose_data                     |

## Case Notes

- GC-001 proves `fix_delivery` requires active ad, active campaign/adset, zero spend, and zero impressions proof.
- GC-002 proves a paused campaign must become campaign context / `diagnose_data`, not `fix_delivery`.
- GC-003 proves a paused adset must not be treated as a delivery failure.
- GC-004 proves disapproval is a policy blocker before performance.
- GC-005 proves limited delivery with a reason can become `fix_policy`.
- GC-006 proves unknown policy status cannot become confident `fix_policy`.
- GC-007 proves low-spend new launches should stay in launch monitoring.
- GC-008 proves early no-purchase data is not enough for hard cut without maturity.
- GC-009 proves severe early spend still needs an explicit severe-loss rule before hard cut.
- GC-010 proves mature high-spend losers can map to `Cut` / `cut`.
- GC-011 proves mature high-confidence winners can map to `Scale` / `scale`.
- GC-012 proves composite fatigue maps to `Refresh` / `refresh`.
- GC-013 proves CTR drop alone is not enough for confident fatigue.
- GC-014 proves frequency increase alone is not enough for confident fatigue.
- GC-015 proves CPM increase alone is not enough for confident fatigue.
- GC-016 proves missing benchmark forces `diagnose_data` or confidence cap.
- GC-017 proves weak benchmark prevents high-confidence scale/cut.
- GC-018 proves stale data blocks hard confident actions.
- GC-019 proves missing attribution/truth blocks performance confidence.
- GC-020 proves suspected tracking drop is data quality first.
- GC-021 proves high priority can still be low confidence when delivery proof is missing.
- GC-022 proves low maturity can still be high priority when policy proof exists.
- GC-023 proves mature data can still be low confidence if attribution is degraded.
- GC-024 proves spend-without-impressions anomaly is data quality, not performance.
- GC-025 proves landing/CVR issues should be diagnosed rather than disguised as creative failure.
- GC-026 proves strong ROAS at tiny spend is not scalable yet.
- GC-027 proves strong CPA with low purchase count is not scalable yet.
- GC-028 proves fatigue clusters are aggregate-sensitive and need composite proof.
- GC-029 proves winner gaps are aggregate-only and should not force a random row action.
- GC-030 proves approved-but-unused creatives are aggregate-only until launch/delivery linkage exists.
- GC-031 proves backup variant gaps are family-level unless a true primary creative exists.
- GC-032 proves old challenger aggressiveness should become regression context, not authority.
- GC-033 proves operator urgency must not override V2 data-quality diagnosis.
- GC-034 proves V1 `stable_winner` maps to V2 `Protect`.
- GC-035 proves V1 `fatigued_winner` maps to V2 `Refresh`.
- GC-036 proves missing Main/Test/Mixed campaign context blocks hard creative actions but preserves diagnostic evidence.
- GC-037 proves a present campaign label is context, not a blocker by itself.
- GC-038 proves a labeled Main campaign can use a stricter Main-specific
  baseline and avoid scaling against the easier canonical all-account baseline.
- GC-039 proves a labeled Test campaign can use Test-specific baselines when
  the Test bucket is sufficiently mature.
- GC-040 proves sparse/null kind calibration falls back to canonical all-account
  behavior rather than mixing per-gate thresholds.
- GC-041 proves sparse Mixed buckets fall back to all-account behavior and are
  never inferred from Main/Test buckets.
- GC-042 proves P1c kind-aware selection composes with the P0 campaign-label
  guard: unlabeled hard actions remain diagnostic.
- GC-043 proves Test campaign `refresh` emissions become `cut` semantics and
  carry the `test_cohort_refresh_to_cut` diagnostic.
- GC-044a proves the transform diagnostic is preserved even when the transformed
  cut is downgraded by soft-only hard-action eligibility.
- GC-044b proves the transform runs before soft-only handling; a refresh-blocked
  but cut-allowed Test decision still emits `cut`, not `keep`.
- GC-045 proves Main campaigns keep the existing refresh semantics.
- GC-046 proves Mixed campaigns keep the existing refresh semantics.
- GC-047 proves unlabeled creatives do not receive Test semantics and are still
  blocked by the campaign-label guard when the raw hard action is `refresh`.
- GC-048 proves cut maturity does not require winner-pool purchase depth once
  the commercial loss-budget spend floor is reached.
- GC-049 proves commercial maturity alone does not force cut when performance is
  weak but still above the account bottom-quartile cut zone.
- GC-050 proves scale shares the same commercial spend maturity but still needs
  purchase depth before emitting a hard scale decision.
- GC-051 proves hard scale also requires enough account-level calibration sample;
  thin scale calibration remains a near-scale review row.
- GC-052 proves a missing winner purchase benchmark blocks hard scale even when
  the row-level scale signals look strong.
- GC-053 proves benchmark-ready accounts can still emit hard scale when all
  row-level scale gates pass.
- GC-054 proves Test campaign scale is a winner verdict whose execution CTA is
  promote-to-main.
- GC-055 proves Main campaign scale is a winner verdict whose execution CTA is
  budget/volume scaling, not promote-to-main.
- GC-056 proves Mixed campaign scale is a winner verdict that needs structure
  review before an execution move.
- GC-057 proves stale evidence is not a terminal Diagnose when a mature
  severe-loss stop-loss rule is already met; confidence must stay capped.
- GC-058 proves stale evidence is not a terminal Diagnose when a sustained loser
  passes the commercial maturity and severe-loser thresholds.
- GC-059 proves recent target-above recovery can hold a cut-zone row as
  review-only `Keep` instead of emitting a hard cut.
- GC-060 proves unknown source freshness blocks hard scale and caps confidence
  while preserving the scale-readiness evidence for review.
- GC-061 proves funnel-step diagnosis requires fresh source proof; unknown
  freshness must not emit a high-confidence landing/checkout diagnosis.
- GC-062 proves verified no-delivery proof remains valid at the fresh side of
  the 36h boundary.
- GC-063 proves the 36-48h freshness band is not fresh enough for delivery
  proof and not stale enough for a stale-evidence cap; mature severe loser math
  can still surface `Cut`.
- GC-064 proves source freshness above 48h caps mature severe-cut confidence.
- GC-065 proves unknown freshness caps but does not hide mature severe-cut risk.
- GC-066 proves stale source freshness blocks hard scale and exposes the
  scale-readiness blocker for review.
- GC-067 preserves the canonical unknown-freshness scale blocker as an
  executable boundary case.
- GC-068 preserves the canonical unknown-freshness funnel blocker as an
  executable boundary case.
- GC-069 preserves the canonical recovery hold case as an executable boundary
  case.
- GC-070 proves recovery hold requires recent spend at the sample threshold,
  not only above-target recent ROAS.
- GC-071 proves recovery hold uses strict `recent7dRoas > targetRoas`; exact
  equality must not silently hold the cut unless a separate formula decision
  changes the operator.
- GC-072 through GC-075 are reserved for future config-surface todos covering
  `lossBudgetMultiplier` and `cutBoundaryMode`; they are not executable until
  those fields exist.
- GC-076 is reserved for report/harness policy coverage proving anachronistic
  target-history replay cannot justify production hard-action adoption; it is
  not a `decideCreative` fixture.
- GC-077 proves a recently confirmed commercial target preserves the existing
  hard scale behavior without a confidence penalty.
- GC-078 proves a cutoff-safe target older than 30 days produces the same hard
  Scale decision and confidence as the same recently persisted target.
- GC-079 proves an unknown target update time remains provenance-unsafe; this
  is distinct from a known timestamp that merely crossed the review interval.
- GC-080 proves fresh break-even narrows an economically unsafe account P25
  boundary and prevents an above-break-even cut.
- GC-081 proves a lower calibrated P25 no longer vetoes a mature, sufficiently
  recent-confirmed economic loss below explicit break-even.
- GC-082 proves an old valid target cannot suppress a mature clear-loss Cut
  when the existing target-relative loss and maturity gates pass. Its fixture
  values are regression evidence, not production thresholds.
- GC-083 proves missing peer calibration does not globally veto the canonical
  commercial stop-loss when exact commercial authority and loss-budget
  maturity are present.
- GC-084 proves the uncalibrated fallback cannot Cut an ad whose ROAS is above
  explicit break-even; break-even narrows the fallback before label math.

The following D061 items are module/integration regression requirements, not
rows in the executable `golden-cases.json` table:

- MR-D061-01 proves a thin exact purchase cell may recover Cut readiness from a
  same-account/currency 90-day AOV proof at the 20-purchase floor without
  making its exact-cell AOV ready.
- MR-D061-02 proves 19 account purchases remain fail-closed.
- MR-D061-03 proves legacy schema, fractional/negative/non-finite metrics,
  purchase/revenue contradictions, conflicting duplicates, mixed currency,
  cutoff drift, identity drift, or hash forgery cannot authorize account AOV.
- MR-D061-04 proves account-AOV Cut thresholds do not Cut or add a manual-Cut
  badge above explicit break-even.
- MR-D061-05 proves the first account-AOV-backed Cut is pending, a same-day
  retry is still pending, and only a later-date matching evaluation confirms it.
- MR-D061-06 proves account-AOV authority changes neither Scale nor Refresh
  eligibility, including kind-aware profile selection.

Executable fixture notes continue:

- GC-091 and GC-092 prove the expanded strip treats recent ROAS equal to or
  above break-even as recovery, not Cut.
- GC-093 and GC-094 prove missing or thin recent evidence preserves a held Cut
  with structured authority provenance, null buyer action, and no executable
  authority. The same tuple is required when a trusted P25-null account-AOV
  repair supplies the maturity floor; confirmed recovery remains the only
  path that restores the canonical non-Cut result.
- GC-095 proves D063 does not change legacy safe-loss semantics.
- GC-096 proves existing Refresh precedence runs before the expanded Cut strip.
- GC-097 proves the explicit break-even boundary is strict and cannot Cut on
  equality.
- GC-098 proves the early severe-loss gate cannot turn a target-relative miss
  into Cut when lifetime ROAS is at or above explicit break-even.
- GC-099 proves cumulative purchase count/value/ROAS contradictions fail closed
  before zero-conversion, maturity, ratio, or Scale gates.
- GC-100 proves recent purchase-count/ROAS contradictions fail closed before
  recent evidence can authorize either Cut or Scale.
- GC-101 also proves the above-0.85 target band cannot hide a below-break-even
  economic row. If expanded-zone authority is denied, Keep must remain
  fail-closed with truthful below-break-even review messaging rather than an
  above-break-even claim.
- GC-102 proves a held Cut whose compatibility label is `test_more` retains
  the canonical held-action buyer label and cannot map to Launchpad
  `Fresh Test`.

The following D064/D065 items are module/integration regression requirements,
not rows in the executable `golden-cases.json` table:

- MR-D064-01 proves GBP and other provider currencies round-trip through decision
  badges, diagnosis copy, recommendation copy, briefing cards, and bulk
  confirmation without a USD or dollar fallback.
- MR-D064-02 proves the committed demo fixture contains an engine-derived Cut that
  serves only as `demo_synthetic_review_only`, with no Cut primary action or
  decision-origin lineage.
- MR-D064-03 proves demo source-row, item-hash, count, identity, or current-epoch
  drift makes the entire synthetic canonical inventory unavailable.
- MR-D064-04 proves the demo briefing route reads the committed fixture, never the
  live native-decision inventory, and the fixture generator reproduces the
  committed JSON byte-for-byte.
- MR-D065-01 proves missing, inferred, or mixed native/manual/Launchpad action
  origin fails before intent, action-log, or provider work.
- MR-D065-02 proves a manual single or bulk status action cannot execute from a
  synthetic/creative fallback ID, wrong provider account, mismatched creative,
  or inactive/missing parent hierarchy; every bulk target is preflighted before
  the first write.
- MR-D065-03 proves duplicate/reuse requires the exact live source Ad/creative and
  exact ACTIVE target ad-set/campaign, and creative drift between discovery and
  the write boundary fails closed.
- MR-D065-04 proves new-campaign creation validates every creative against the
  exact Meta account before the first POST and verifies returned entity
  ID/account/parent identity after every POST.
- MR-D065-05 proves ambiguous provider create/duplicate POST failures are not
  retried while durable provider-idempotency attempt receipts are unavailable;
  bounded GET-only verification retry remains allowed.
- MR-D065-06 proves rebuild-creative and over-cardinality Launchpad payloads stop
  before intent preparation or provider work.
- MR-D065-07 proves a new provider-verified pause/resume receipt hash-binds the
  immutable source creative/campaign/ad-set and verified provider-account/
  creative/campaign/ad-set lineage; any field tamper fails closed, while a
  pre-lineage receipt with `verificationLineage = null` retains its exact old
  canonical hash and remains readable without synthesized hierarchy.
- P1b kind-segmented calibration was data-only. P1c consumes those
  baselines only through a strict profile selector: sufficient labeled kind
  data may change decisions; sparse, mixed-empty, or unlabeled rows must match
  canonical `all` behavior.

## Fixture Requirements

- Every executable fixture must include the expected engine primary decision.
- Every executable fixture must include the expected buyer-facing action.
- Every executable fixture must include actionability, problem class, priority, confidence, maturity, and top reason tag.
- Every fixture with missing required data must assert the safe fallback.
- Aggregate-only cases must assert that no row-level `brief_variation` is emitted.
- These cases are required before resolver behavior changes.

## Hysteresis Sequence Golden Cases (GS series)

Decision-label stability sequences for `v3-2026-07-06-decision-stability`.
Each case chains `applyLabelHysteresis` day over day from a clean epoch; the
executable lockstep lives in `golden-cases.test.ts` and parses this table.
GS-001..003 are the live flip creatives observed on 2026-07-04..06.

| Case   | Source                              | Raw sequence            | Published sequence      | Suppressed day indexes |
| ------ | ----------------------------------- | ----------------------- | ----------------------- | ---------------------- |
| GS-001 | IwaStore 946471284944193            | scale,keep,scale        | keep,keep,keep          | 0,2                    |
| GS-002 | TheSwaf 1962656064410174            | cut,keep,cut            | keep,keep,keep          | 0,2                    |
| GS-003 | Tiles 25889037484086563             | keep,cut,keep           | keep,keep,keep          | 1                      |
| GS-004 | hard-action exit is immediate       | cut,keep,keep,keep      | keep,keep,keep,keep     | 0                      |
| GS-005 | entering hard requires confirmation | keep,cut,cut            | keep,keep,cut           | 1                      |
| GS-006 | soft-to-soft publishes immediately  | test_more,keep,diagnose | test_more,keep,diagnose | none                   |
| GS-007 | hard-to-hard switch is neutralized  | scale,cut,cut           | keep,keep,cut           | 0,1                    |
| GS-008 | safety diagnosis exits immediately  | scale,diagnose          | keep,diagnose           | 0                      |

- A suppressed hard entry publishes the canonical non-actionable `keep` label
  with the `pending_transition` badge; the intended hard label is persisted in
  `raw_label`. This also applies when no previous evaluation exists.
- Published period-2 hard round-trips are structurally impossible; the
  replay evidence for oscillation reduction is the reversal-within-3 metric
  (76 -> 20 over 2026-06-01..07-05).

## Authority Provenance Golden Cases (AP series)

| Case   | Mathematical / semantic label | First authority blocker        | Post-authority raw | Published       | Executable action |
| ------ | ----------------------------- | ------------------------------ | ------------------ | --------------- | ----------------- |
| AP-001 | cut                           | profile_hard_action_ineligible | test_more          | test_more       | none              |
| AP-002 | scale                         | source_freshness               | keep               | keep            | none              |
| AP-003 | scale                         | none                           | scale              | keep (pending)  | none              |
| AP-004 | keep (site-owned transform)   | none                           | keep               | keep            | none              |
| AP-005 | historical unavailable        | historical unavailable         | persisted or null  | persisted label | existing guards   |
| AP-006 | scale                         | campaign_context               | scale (audit seam) | diagnose        | none              |

- AP-001 and AP-002 prove a hard `pre_authority_label` never grants provider
  authority after a profile or freshness restriction.
- AP-003 proves hysteresis is distinct from authority: the raw hard verdict is
  retained while the first published transition remains non-actionable.
- AP-004 proves landing-page/checkout ownership is normalized semantically
  before campaign/native authority is evaluated.
- AP-005 forbids reconstructing missing historical provenance from mutable
  explanation text.
- AP-006 proves that even an anomalous or replayed hard raw label cannot mint
  `authorized_action` while an authority blocker is present.

## Meta OS Resolution Golden Cases (MOG series)

These cases lock the D035 read-time compatibility projection. They do not
change persisted engine labels or formula outputs.

| Case    | Persisted / adapter input                                                          | Served state          | Served assessment          | Served action / resolution                      |
| ------- | ---------------------------------------------------------------------------------- | --------------------- | -------------------------- | ----------------------------------------------- |
| MOG-001 | `test_more` / `test_more`                                                          | Monitoring            | Learning                   | Continue Test                                   |
| MOG-002 | `keep` / `protect`                                                                 | Monitoring            | Stable                     | Keep Running                                    |
| MOG-003 | `diagnose` / `diagnose_data` + campaign-context blocker                            | Needs Resolution      | Decision Blocked           | Resolve Campaign Role                           |
| MOG-004 | `diagnose` / `diagnose_data` + `landing_page_issue`                                | Needs Resolution      | Funnel Bottleneck          | Fix Landing Page                                |
| MOG-005 | `diagnose` / `diagnose_data` + `checkout_breakdown`                                | Needs Resolution      | Funnel Bottleneck          | Fix Checkout                                    |
| MOG-006 | `diagnose` / `diagnose_data` + `tracking_anomaly`                                  | Needs Resolution      | Decision Blocked           | Repair Tracking                                 |
| MOG-007 | `out_of_scope` / compatibility fallback                                            | Not Applicable        | Out of Scope               | no buyer action                                 |
| MOG-008 | 100 high-confidence Monitoring rows + lower-confidence `cut`                       | Act row retained      | Underperformer             | Cut                                             |
| MOG-009 | selected lane empty while another lane has rows                                    | Non-empty lane shown  | server assessment retained | no fabricated action                            |
| MOG-010 | 140 eligible rows; explicit candidate limit grows 60 -> 120                        | Same ordering expands | server assessment retained | first 60 remain stable                          |
| MOG-011 | Ad active, parent ad set paused                                                    | Inactive assets       | prior verdict advisory     | no provider mutation                            |
| MOG-012 | automatic Test/Main inference lacks authority gate                                 | Review-only           | original verdict retained  | no manual-label task and no provider mutation   |
| MOG-013 | constrained bid winner with complete 30d under-utilization                         | Money move            | current/previous bid shown | server-proposed bid review                      |
| MOG-014 | USD daily budget `100000`, bid `15000`, spend `124`                                | Structure             | USD 1,000 / USD 150 shown  | utilization uses major units; write stays minor |
| MOG-015 | campaign `WITH_ISSUES`, paused, or unknown; or active ad set under paused campaign | Inactive assets       | prior verdict advisory     | no Structure row and no provider mutation       |

- MOG-003 through MOG-006 require `buyerAction: null`, a non-null resolution,
  and no provider mutation.
- MOG-008 requires lane-aware selection before the response cap; confidence
  alone cannot remove the Act row.
- MOG-009 is a UI state rule only. It may change the selected lane, never a
  server decision or action.
- MOG-010 requires server recomposition. The UI must not concatenate, re-rank,
  or classify raw decisions locally.
- MOG-011 requires all three current hierarchy statuses to be live before an Ad
  can enter the main queue; unknown fails closed into the inactive envelope.
- MOG-012 preserves the mathematical label while blocking action authority;
  rendering `diagnose` or asking the operator to supply a required label fails.
- MOG-013 requires current value, previous different value, capture date, and
  range-correct utilization to come from the server contract.
- MOG-014 requires provider minor-unit values to be converted before spend
  comparison and display without changing the provider-write integer contract.
- MOG-015 requires exact current `ACTIVE` membership at every Structure
  hierarchy level; `WITH_ISSUES` is not accepted as active on this surface.

## Authority And Raw-Restore Regression Cases

These are executable module/integration guards rather than `decideCreative`
fixtures:

| Case   | Input                                                                                                                     | Required result                                                                                                          | Executable proof                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| AR-001 | Fresh target CPA, no target/break-even ROAS                                                                               | `scale=false`, `cut=false`; refresh may remain eligible                                                                  | `account-decision-profile.test.ts`                                             |
| AR-002 | Fresh target ROAS, missing break-even ROAS                                                                                | scale may pass; cut is blocked                                                                                           | `account-decision-profile.test.ts`                                             |
| AR-003 | Fresh break-even ROAS, missing target ROAS                                                                                | cut may pass; scale is blocked                                                                                           | `account-decision-profile.test.ts`                                             |
| AR-004 | Persisted spend action, same valid target now older than review interval                                                  | preserve the action; age may add advisory metadata only                                                                  | `snapshot.test.ts`, `commercial-action-authority.test.ts`                      |
| AR-005 | Completed raw generation starts at global page 38                                                                         | next index is 39; page one is not fetched                                                                                | `raw-snapshot-generation.test.ts`, `meta.test.ts`                              |
| AR-006 | Rollback profile says low-sample Cut-ineligible; cutoff-bound challenger exact cell is AOV-ready, P25-null, and Cut-ready | rebuild through production resolver; do not retain `profile_hard_action_ineligible`; first hard Cut remains D036 pending | `native-ad-frozen-exact-replay.test.ts`, `ad-account-decision-profile.test.ts` |
| AR-007 | Retained compatibility profile resolves `account/*`, while native replay input names one physical provider account | Pin ready and soft-only D036 state to `account/<providerAccountId>`; gap reset, read, advance, and confirmation use the same key, so a later signal cannot false-confirm | `native-ad-account-aov-closed-window-replay.test.ts` |
| AR-008 | A soft daily decision sits between two Cut signals but is outside the outcome-scored cooldown sample | advance the soft decision before the later Cut; the later Cut remains first signal instead of false confirmation | `native-ad-account-aov-closed-window-replay.test.ts` |
| AR-009 | A future loser had not met commercial maturity at decision time | exclude it from Cut-opportunity recall while retaining any emitted-Cut precision classification | `d061-account-aov-closed-window-gate.test.ts` |
| AR-010 | Lane B has finalized daily facts but the requested exact optimization cell is absent | report exact-cell coverage failure; do not borrow an account-wide cell or grant automation authority | `native-ad-account-aov-closed-window-replay.test.ts`, `d061-account-aov-closed-window-gate.test.ts` |
| AR-011 | Exact native Cut is decision-authorized, but `computedAt` is more than 12 hours old | retain the persisted Cut evidence; serve `stale_decision`, a blocked review action, and zero provider mutation | `execution-safety.test.ts`, `decisions-workspace-read-model.test.ts`, `decisions-os-presentation.test.ts`, `meta-native-ad-pause.test.ts` |
| AR-012 | Exact native Cut is fresh and authorized, persisted business controls are verified/open | serve `live_preflight_required`; offer only a control that runs the existing live preflight before the exact-Ad pause | `decisions-workspace-read-model.test.ts`, `meta-native-ad-pause.test.ts` |
| AR-013 | Business exists but has no `meta_automation_business_controls` row | keep the Decisions read available, serve `governance_unavailable` and a blocking banner; central write guard refuses before provider mutation | `automation-control-plane.test.ts`, `decisions-workspace/route.test.ts` |
| AR-014 | Cached decision inventory crosses the 12-hour boundary between requests | recompute exact freshness on the request-specific cloned read model; cached source object remains unchanged and no action stays enabled | `decisions-workspace-read-model.test.ts` |
| AR-015 | Exact native Cut is fresh and decision-authorized, but sync admission is blocked, durable sync is stale, warehouse cutoff lags, or the generation manifest is invalid | retain and render the decision evidence; serve blocking pipeline health and `source_pipeline_unready`; Creative Briefing, Launchpad, and the decision-origin write boundary offer or perform zero provider mutation | `decision-pipeline-health.test.ts`, `decisions-workspace/route.test.ts`, `meta-decision-center-exact-adapter.test.ts`, `decision-origin-action-preflight.test.ts` |
| AR-016 | The metric picker ends on the latest completed fact day while a newer native decision generation exists | keep the stated dates for pulse/lane metrics; serve the newest account-scoped decision generation independently, so the metric window cannot resurrect an older invalid manifest | `decisions-workspace/route.test.ts` |

### D076 campaign-role resolver challenger guards (2026-08-29)

| Case   | Input                                                                                                   | Required result                                                                                                    | Executable proof                          |
| ------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| CR-001 | Small old campaign (8 creatives, 5 recently rotated, tiny spend share) — the v2 `mixed/high` regression | v3 must NOT publish `mixed`; the campaign resolves toward `main` on the weighted path                              | `campaign-context-resolver-v3.test.ts`    |
| CR-002 | Broad hybrid (32 creatives, 12 new, top3SpendShare 0.4747)                                              | v3 publishes `mixed` (0.45 winner-core bar applies at >=15 creatives)                                              | `campaign-context-resolver-v3.test.ts`    |
| CR-003 | Small low-share campaign named with a test token (3 creatives, top3 structurally 1.0)                    | no `naming_contradicts_behavior` conflict; concentration at N<=3 is structural, not Main behavior                  | `campaign-context-resolver-v3.test.ts`    |
| CR-004 | Test-token-named campaign carrying ~40% of account spend with settled winners                            | conflict surfaces (`naming_contradicts_behavior`) as evidence only; kind stays `main` — D081 C5: the name may not change the tuple the non-naming evidence already earned | `campaign-context-resolver-v3.test.ts` |
| CR-005 | Scope with <7 days of status coverage or missing budget median                                           | lifecycle weight stays unallocated; confidence may only drop, never rise; floors still fail closed                 | `campaign-context-resolver-v3.test.ts`    |
| CR-006 | Any v3 resolution                                                                                        | stamped `campaign-context-resolver.v3-lifecycle-name-neutral-2026-09-01`; runtime constant stays v2 while the D076 gate is REJECT | `campaign-context-resolver-v3.test.ts`    |

### D077 state-history compaction guards (2026-08-30)

| Case   | Input                                                                           | Required result                                                                                     | Executable proof                                            |
| ------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| SC-001 | Duplicate run with one lineage-pinned row                                       | whole run protected (`pinnedRunRows` = all rows), never deleted                                     | `ephemeral-postgres-state-history-compaction-seam-child.ts` |
| SC-002 | Duplicate run with a partial observation interleaved before it                   | excluded (`interleavedExcludedRuns`); as-of winners byte-stable                                     | compaction seam                                             |
| SC-003 | Invalid token / tampered payload / missing acknowledgement                       | refusal with ZERO writes, journal included                                                          | compaction seam                                             |
| SC-004 | Foreign run id injected into an honestly re-hashed plan                          | batch validation fails, whole batch rolls back, no row deleted                                      | compaction seam                                             |
| SC-005 | Scope changed after planning                                                     | `stale_plan_scope_changed` refusal                                                                  | compaction seam                                             |
| SC-006 | Kill switch mid-run, then two concurrent re-executions                           | one lease winner resumes with exact accounting (`runsAlreadyEmpty`); other refused; totals match     | compaction seam                                             |
| SC-007 | Plan without pgstattuple proof                                                   | `insufficient_evidence`, strictly refused — acknowledgement cannot override                          | compaction seam                                             |
| SC-008 | Malformed/negative/overlarge fence measurements                                  | explicit unavailable or raw fallback, never a zero that admits                                      | `state-history-effective-size.test.ts`                      |
| SC-009 | Post-compaction 1-of-N observation on a compacted scope                          | delta stats identical to an uncompacted twin; identical payload still coalesces                     | compaction seam                                             |
| SC-010 | Absent winner reaches any serving surface (workspace status, History feed, status recovery) | NULL status (never `DELETED`), no fabricated transition entry, no resurrected present/dimension status | seam leg D15b/D15c, workspace SQL pins, consumer closure guard |
| SC-011 | Unchanged entity at an operator-response window end (heartbeat and/or sibling delta in scope) | terminal truth certified by `confirmed_until`; superseded rows stop at their own confirmation; pre-heartbeat cutoff caps at first capture; `no_response` classifiable again | detection regression + seam leg D15a |
| SC-012 | Operational verifier over a delta manifest                                        | membership counted by reconstruction (equals logical `row_count`), never run-bound physical rows      | seam leg D15d + closure guard pins |
| SC-013 | Older exact replay after later heartbeats/delta confirmation                      | heartbeat clocks never move backward; established `confirmed_until` survives; `last_captured_at >= last_seen_at` | seam leg D15e (failed on pre-fix writer) + closure guard |
| SC-014 | Equal-captured competing rows / sibling-endpoint row for the same identity        | only the deterministic `(captured_at, created_at, id)` winner is confirmed, within its own endpoint scope; the tuple-loser and the sibling endpoint get and give nothing | seam legs D15f/D15g (failed on pre-fix predicate) + closure guard |
| SC-015 | Policy-forged compaction plan (edited status/totals/projection, honestly re-hashed token) | refused by the authoritative pre-write re-plan with ZERO journal rows and ZERO deletions (fail-first: the forged plan deleted rows) | compaction seam hardening leg |
| SC-016 | Compaction plan built under READ COMMITTED / concurrent commit mid-plan            | planner refuses weaker-than-REPEATABLE-READ isolation; under RR the whole multi-statement plan reads one snapshot (fingerprint stable) | compaction seam hardening leg (failed pre-fix) |
| SC-017 | Run pinned by several FK families at once / head-duplicate / archived-schema / response-event pins | per-reason counts attribute each family exactly; the union counts the run once (families are non-additive); head and interleave counted explicitly | compaction seam per-family fixtures + planner consistency check |
| SC-020 | Multi-endpoint unsupported scope                                                   | exact measured exclusion counts (every complete run + its rows, wholesale, disjoint from all other reasons) per scope and in hash-bound totals — never a boolean or a zero (seam failed pre-fix) | compaction seam multi-endpoint counts + counts validator |
| SC-021 | Plan whose own counts disagree at ROW level (candidate-row reconciliation, pinned-row union outside family bounds) | the planner refuses to serialize it — `validateCompactionScopeCounts` throws, per scope and on totals | `state-history-compaction-counts.test.ts` perturbation matrix |
| SC-022 | Journal-ONLY read failure on the readiness surface                                 | explicit `journalRead: unavailable` + `UNKNOWN_JOURNAL_UNAVAILABLE` + blocker; desktop and mobile render "journal state unavailable", never "NOT_EXECUTED"/"no journal entries"; a successful empty read stays honestly NOT_EXECUTED | readiness helper/section/route/page tests (failed pre-fix) |
| SC-018 | Response-event pin arriving AFTER planning                                         | refused before lease/journal (`authoritative_replan_mismatch`), zero deletions, pinned run intact; a fresh plan classifies it response-event-pinned with nothing removable | compaction seam hardening leg |
| SC-019 | Readiness surface under failure / cross-business journal / undeployed D075 writer  | journal strictly business-scoped; D075 evidence measured (observed / not_observed / unknown), never asserted; read failure visibly unavailable; UI display-only on desktop and mobile with no token or mutation affordance | readiness helper + route + section + page tests, isolation guard |

### D074b vocabulary-closure guards (2026-08-30)

| Case   | Input                                                                    | Required result                                                                                   | Executable proof                                    |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| VC-001 | Unresolved automatic role on a hard decision                             | review-only/watch, no provider mutation, no manual-label task, canonical blocker + evidence names | `campaign-label-guard.test.ts` (both modules)       |
| VC-002 | Legacy persisted payload (`label_status`/`unlabeled_campaign_soft_only`) | recognized and mapped into `campaign_context_unresolved`; deprecated blocker never re-emitted     | `automation-readiness.test.ts`                      |
| VC-003 | Legacy `campaignLabelStatus` alias vs canonical `campaignRoleStatus`     | contradiction fails closed as unresolved (never silently the authority-granting side); legacy-only `labeled` parses but NEVER resolves; missing-both is unresolved | `campaign-role-vocabulary-closure.test.ts`          |
| VC-004 | Any buyer-facing surface                                                  | zero label-request AND zero manual-correction copy; role shown as automatic inference with refresh/evidence ask | closure guard copy scan                             |
| VC-005 | Active writers across app/components/lib/scripts                          | every legacy-identifier occurrence matches the per-file per-token exact-count ledger; zero emissions | closure guard ledger + emission scans               |
| VC-006 | `campaignKind === "test"` scale decision                                  | "Promote to main" fires ONLY under canonical resolved status; missing/legacy/contradictory status asks to resolve the role and serves no kind | `card-serialization.test.ts` |
| VC-007 | Any briefing card, any Launchpad mode                                     | `canOpenBriefingCardInLaunchpad` false; no mode derived from label text/`campaignKind`/absent `blockedActionType`; all consumers review-only | `launchpad-bridge.test.ts`, page/bulk/drawer suites |
| VC-008 | Persisted legacy guardrail row `requireCampaignLabel: false`              | cannot disable `requireResolvedCampaignRole` (alias is tighten-only)                              | `campaign-role-vocabulary-closure.test.ts`          |
| VC-009 | Card with `campaignKind` but missing/legacy-only status                   | UI renders "Role unresolved", never Main/Test/Mixed as trusted; primary not executable            | `ActionNowCard.test.tsx`, `card-utils.test.tsx`     |
| VC-010 | Stale Decision Center row (`scale`/`promote_to_main`) on a card without resolved role | row is provenance only: serialized primary stays review, no Promote CTA/filter/label anywhere | `card-serialization.test.ts`, `ActionNowCard.test.tsx`, page/asset suites, closure precedence guard |
| VC-011 | Stale Scale row + resolved agreeing role but a DIFFERENT current decision (keep/diagnose/cut/refresh/test_more) or a blocked/held Scale | current decision's own primary wins everywhere — server, ActionNowCard label, action filter; the row may only exactly CONFIRM a current unblocked Scale CTA | `card-serialization.test.ts` label+blocked matrices, `card-utils.test.tsx` current-primary matrix, `ActionNowCard.test.tsx` source-freshness probe, closure precedence guard |
| VC-012 | Current `cut` server label + stale `scale`/"Scale - Promote to main" row on Asset Library and Evidence Drawer | Label cell/filter/CSV stay cut (current-projection-only; no current label → explicit "Review"); drawer keeps the Cut headline and renders the raw row only under the "Compatibility snapshot (provenance) … cannot execute any action" disclosure, with no composed buyerLabel/nextStep guidance and queue/apply marked as stored values | `AssetLibrarySection.test.tsx` bypass-C fixtures, `CreativeEvidenceDrawer.test.tsx` bypass-D probe, closure raw-row field census |

### D078 canonical-route readiness + governance display truth (2026-08-30)

| Case   | Input                                                                    | Required result                                                                                   | Executable proof                                    |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| SC-023 | Canonical `/platforms/meta/automation` (zero-base off) with a readable DB | the legacy body SERVER-reads the business-scoped D077 readiness (access-gated) and passes it verbatim — incl. `journalRead: "unavailable"` states; missing businessId / denied access / throwing read fail closed to null (rendered "unavailable", never ready) | `legacy-page.test.tsx` (5 tests; 5/5 failed on the rejected re-export) |
| SC-024 | Successful control-plane read of a business with NO persisted controls row | the kill-switch business pill renders `BLOCKED · NOT CONFIGURED` (stopped tone), never green ENABLED, because the write boundary refuses `business_control_not_configured`; an engaged stop stays STOPPED regardless of provenance; a FAILED read still withholds with `—` | automation `page.test.tsx` missing-row probe (failed pre-fix) + pre-existing failed-read withhold test |

### D078 correction 1 — account-state evidence and vocabulary (2026-08-30)

| Case   | Input                                                                    | Required result                                                                                   | Executable proof                                    |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| SC-025 | A business with an assigned-but-DESELECTED account holding spend and produced decisions | every read surface states it explicitly: workspace `assignedAccountStates` + coverage strip (selected · serving vs deselected · read-only history with spend/facts/unserved-decision counts); History offers it in a marked read-only optgroup and serves its journal with `accountScope: "deselected_historical"`; an UNBOUND id still 404s; no write control ever lists it | assigned-account route/view/strip tests (fail-first), journal-route contract tests, local-UI matrix |
| SC-026 | Persisted history rows of kind `label_flips`                              | rendered as automatic-decision vocabulary ("Decision transitions"); no buyer-facing surface says "Label flips" or asks for a manual label | history page render test (failed on the rejected copy) |
| SC-027 | A stale authorized hard decision and a fresh one, freshness DERIVED by the shared 12h evaluator | server presentation + adapter + rendered Decision Center: stale ⇒ review-only "Refresh Decision", provider mutation null, no enabled Cut in its card; fresh ⇒ supervised Cut stating a live preflight runs on submit; offline (no live provider inventory read) NO native row is presented at all | AMENDED by correction 2: primary proof is now the actual-route test (SC-028); `stale-fresh-cta-boundary.test.tsx` is the static function-level complement (relabeled in-file); the harness browser probe proves fail-closed withholding only |

### D078 correction 2 — actual-route proof, tri-state evidence, exit-guarded matrix (2026-08-30)

| Case   | Input                                                                    | Required result                                                                                   | Executable proof                                    |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| SC-028 | The ACTUAL `/api/meta/decisions-workspace` GET over a constitutionally valid ephemeral lattice; REAL cookie auth + REAL posture read; only the external provider-inventory boundary mocked; throwing fetch spy | the route response itself contains both exact seeded Ad rows; the shipped 12h evaluator derives stale ⇒ `stale_decision` (review-only Refresh Decision + providerMutation null) and fresh ⇒ `live_preflight_required` (supervised Cut + live-preflight scopeNote); zero provider/network calls; the rendered queue carries each served action as row text scoped to the exact row (decision information — the ACTION control proof is SC-032) | AMENDED by correction 3: `route.lattice-cta.db.test.tsx` (5 passed / 1 skipped; auth/posture mocks removed — a static guard scans for them; the correction-2 `data-decision-id` region check was vacuous and is replaced by a throwing extractor over real selectors) |
| SC-029 | The account-state read FAILS (`null`) vs returns proven-zero (`[]`) vs is absent (legacy `undefined`) — through the REAL adapter, not component props | workspace: `null` ⇒ visible "Assigned-account coverage unavailable…" warning; `[]` ⇒ explicit anomalous proven-zero state; `undefined` ⇒ legacy-silent — all four preserved VERBATIM by `buildMetaDecisionCenterExactViewModel` (correction 2's adapter collapsed undefined→null; C3.1). History: `array \| null` ONLY — a failed read AND an absent legacy field both map to null/unavailable, fail-closed by design; no undefined state exists or is claimed. Journal deep link under a failed authority read ⇒ 503 `meta_history_account_scope_unavailable`; 404 only after a successful read proves absence | AMENDED by correction 3: `assigned-account-tri-state-adapter.test.tsx` (fail-first vs the `?? null` line) + the existing server→client→render suites |
| SC-030 | TheSwaf History with the deselected NonTesvik scope, driven in a REAL browser at 1440 AND 390 px | the harness actually SELECTS the scope and asserts `accountScope: "deselected_historical"` from the journal plus visible identity/currency/timezone/spend/freshness/generation/policy text and ZERO write controls | local-UI harness NonTesvik probe (12 assertions per width, in the matrix artifact) |
| SC-031 | Any matrix violation: failed assertion, failed/self/disconnected/duplicate-target/wrong-order hop, wrong hop count, unproven selected/rendered hop identity, missing/duplicate entry, missing/zero-byte screenshot, contract mismatch, failed/missing route or drawer proof, single-string switcher shape | the shared validator validates the DECLARED ordered chain per width (`D078_SWITCH_ORDER`, imported by the harness) — not a name set — and the harness exits NONZERO after `finally` teardown; a fully valid artifact yields zero failures and exit 0 | AMENDED by correction 3: `d078-matrix-contract.test.ts` (14 tests; 7 new C3.3 fail-first cases for the shapes the correction-2 set check accepted) |

### D078 correction 3 — drawer/action proof, four-state adapter, ordered-chain + top-level guards (2026-08-30)

| Case   | Input                                                                    | Required result                                                                                   | Executable proof                                    |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| SC-032 | The captured ACTUAL route payload driven through the REAL `MetaPlatformPage` wiring in a real DOM: row review click → `CreativeEvidenceWindowExact` → `authorizeMetaNativeAdPause` | stale row: drawer opens scoped to that exact ad, stale evidence visible, review-only "Refresh Decision" primary DISABLED, zero Cut/Pause controls, no ceremony; fresh row: drawer opens, live-preflight copy visible, supervised Cut primary ENABLED, click opens ONLY the real `MetaNativeAdPauseDialog` ceremony (confirm present, not clicked), zero provider mutation/POST; every required selector throws on zero matches; no data/provider boundary mocked in the drawer file | `app/api/meta/decisions-workspace/drawer-cta.db.test.tsx` (4 passed / 1 skipped in the runner/harness; recorded inside `routeCtaProof`) |
| SC-033 | The frozen bundle's TOP-LEVEL `businesses` array | exactly six unique charter ids equal to `scopeContract.charterBusinessIds`, each with the pinned charter name; an extra, missing, duplicated, or renamed row fails | `d078-acceptance-guards.test.ts` C3.4 helper + fail-first cases |

## D079 commercial spend-unit anchor (golden cases)

Fail-closed capture (`lib/business-commercial.test.ts`):

| input | expected |
|---|---|
| `aovAssumption: 0` or negative | rejected, `targetPack.aovAssumption must be a finite number greater than zero or null.` |
| `aovAssumption: null` | accepted, anchor cleared, prior behaviour restored |
| client-supplied `updatedByUserId` / `updatedAt` | ignored; the server session user is persisted |
| a calibration profile still present in the payload | updated in place; engine-owned columns survive |
| a calibration profile removed from the payload | deleted, scoped to its exact identity |

Ladder and explanation (`lib/creative-decision-engine/commercial-anchor.test.ts`):

| anchor state | source | threshold eligible | code |
|---|---|---|---|
| explicit Target CPA | `target_cpa` | yes | — |
| operator AOV + Target ROAS | `operator_aov` | yes | — |
| Meta AOV, ≥20 purchases/90d | `meta_derived_aov` | yes | — |
| Meta AOV, <20 purchases/90d | `meta_derived_aov` | no | `commercial_anchor_sample_insufficient` |
| account CPA p50 only | `account_history` | no | `commercial_anchor_missing` |
| break-even fallback only | `break_even_aov` | no | `commercial_anchor_missing` |
| anchor present, timestamp unverifiable | any | no | `commercial_anchor_provenance_unverified` |
| anchor fine, no Target ROAS | — | Scale only blocked | `target_roas_missing` |
| anchor fine, no break-even ROAS | — | Cut only blocked | `break_even_roas_missing` |
| anchor fine, calibration below floor | — | Scale only blocked | `scale_calibration_below_floor` |
| shadow-only account | any | no | `shadow_only` |

Offline counterfactual (`scripts/creative-decision-center/commercial-anchor-counterfactual.test.ts`):
the no-anchor baseline reproduces 15,508 / 1,993 / 1,872 / 95 / 26 with 0
enabled hard actions; a candidate is rejected when absent, zero, negative,
malformed, currency-mismatched (a USD anchor for TRY-denominated Bilsem Zeka),
when it borrows a ROAS under as-of-origin semantics, or when it omits either
paired ROAS under declared-all-window semantics.

Per-action counterexample, pinned (a Target CPA candidate for IwaTR, which has
no frozen target pack):

| action | held before | eligible after | still blocked | code |
|---|---|---|---|---|
| Cut | 282 | 0 | 282 | `break_even_roas_missing` |
| Refresh | 9 | 9 | 0 | — |
| Scale | 0 | 0 | 0 | — |

No-future-leakage counterexample, pinned: Bilsem Zeka's only pack is
`effectiveAt 2026-04-22` / `recordedAt 2026-07-14`, so
`targetPackAsOfOrigin` returns null at origins 2026-05-11 and 2026-07-13 and a
pack only from 2026-07-15. All 603 of its held rows therefore resolve with no
knowable pack, and its Cuts stay blocked on `break_even_roas_missing`.

### D079 correction 2 golden cases

| case | expected |
|---|---|
| Commercial Truth rendered HTML | contains neither `CPA ceiling` nor `AOV floor`; names `Target CPA` and `AOV assumption` |
| real profile, Target CPA set, calibration below floor | `thresholdEligible: true`, `scale: false`, code `scale_calibration_below_floor`; panel reports `withheld.profileHardActionEvidence`, never a commercial-threshold gate |
| real Cut-only stop-loss overlay | base code `commercial_anchor_missing`, effective code `break_even_roas_missing`; panel copy is derived from the EFFECTIVE code and mentions break-even ROAS |
| eligible action | no blocker code and no operator copy |
| every replay action row and total | partitions completely; `blockedAfterTotal = heldBefore - eligibleAfter`; baseline `blockedAfterTotal = 1993` |
| per-action independent gates | Scale 8/0, Cut 86/26, Refresh 1/0 campaign-context/recovery |
| independent-gate transitions | `campaign_context->campaign_context`, never recast as a commercial-anchor transition |
