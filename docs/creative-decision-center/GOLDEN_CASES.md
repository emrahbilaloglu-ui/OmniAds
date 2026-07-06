# Golden Media-Buyer Cases

These cases must become executable fixtures before resolver behavior changes. Do not only test `buyerAction`; each case asserts confidence, priority, problemClass, maturity, and top reason tag.

| caseId  | inputSummary                                                                                                           | expectedPrimaryDecision | expectedBuyerAction | expectedActionability | expectedProblemClass | expectedPriorityBand | expectedConfidenceBand | expectedTopReasonTag                    | expectedMaturity | expectedSafeFallbackIfDataMissing |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------- | --------------------- | -------------------- | -------------------- | ---------------------- | --------------------------------------- | ---------------- | --------------------------------- |
| GC-001  | active ad + active campaign/adset + 24h spend 0 + impressions 0                                                        | Diagnose                | fix_delivery        | diagnose              | delivery             | high                 | medium                 | active_no_spend_24h                     | learning         | diagnose_data                     |
| GC-002  | no spend but campaign paused                                                                                           | Diagnose                | diagnose_data       | diagnose              | campaign_context     | medium               | medium                 | campaign_paused                         | learning         | diagnose_data                     |
| GC-003  | adset paused                                                                                                           | Diagnose                | diagnose_data       | diagnose              | campaign_context     | medium               | medium                 | adset_paused                            | learning         | diagnose_data                     |
| GC-004  | disapproved creative                                                                                                   | Diagnose                | fix_policy          | diagnose              | policy               | high                 | high                   | disapproved_or_limited                  | learning         | diagnose_data                     |
| GC-005  | limited delivery with reason                                                                                           | Diagnose                | fix_policy          | diagnose              | policy               | high                 | high                   | disapproved_or_limited                  | learning         | diagnose_data                     |
| GC-006  | policy status unknown                                                                                                  | Diagnose                | diagnose_data       | diagnose              | data_quality         | medium               | low                    | missing_policy_status                   | learning         | diagnose_data                     |
| GC-007  | new launch under 48h with low spend                                                                                    | Test More               | watch_launch        | review_only           | launch_monitoring    | medium               | medium                 | new_launch_window                       | too_early        | diagnose_data                     |
| GC-008  | new launch under 72h with enough spend but no purchase                                                                 | Test More               | watch_launch        | review_only           | launch_monitoring    | high                 | medium                 | new_launch_window                       | learning         | diagnose_data                     |
| GC-009  | new launch with severe overspend and no purchases                                                                      | Test More               | watch_launch        | review_only           | launch_monitoring    | high                 | medium                 | new_launch_severe_spend_no_purchase     | learning         | diagnose_data                     |
| GC-010  | mature high-spend loser                                                                                                | Cut                     | cut                 | review_only           | performance          | high                 | high                   | severe_sustained_loser                  | mature           | diagnose_data                     |
| GC-011  | mature high-confidence winner                                                                                          | Scale                   | scale               | review_only           | performance          | high                 | high                   | strong_relative_winner                  | mature           | diagnose_data                     |
| GC-012  | winner entering fatigue                                                                                                | Refresh                 | refresh             | review_only           | fatigue              | high                 | high                   | fatigue_composite                       | mature           | diagnose_data                     |
| GC-013  | CTR down but frequency flat and CPM flat                                                                               | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | partial_fatigue_signal                  | actionable       | diagnose_data                     |
| GC-014  | frequency up but CTR stable                                                                                            | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | partial_fatigue_signal                  | actionable       | diagnose_data                     |
| GC-015  | CPM up but CPA/ROAS stable                                                                                             | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | partial_fatigue_signal                  | actionable       | diagnose_data                     |
| GC-016  | benchmark missing                                                                                                      | Diagnose                | diagnose_data       | diagnose              | data_quality         | medium               | low                    | benchmark_missing                       | learning         | diagnose_data                     |
| GC-017  | benchmark weak                                                                                                         | Diagnose                | diagnose_data       | diagnose              | data_quality         | medium               | low                    | weak_benchmark                          | learning         | diagnose_data                     |
| GC-018  | stale data                                                                                                             | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | stale_data                              | learning         | diagnose_data                     |
| GC-019  | attribution/truth missing                                                                                              | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | truth_missing                           | learning         | diagnose_data                     |
| GC-020  | tracking drop suspected                                                                                                | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | tracking_drop_suspected                 | learning         | diagnose_data                     |
| GC-021  | high priority but low confidence delivery issue                                                                        | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | missing_delivery_proof                  | learning         | diagnose_data                     |
| GC-022  | low maturity but high priority policy issue                                                                            | Diagnose                | fix_policy          | diagnose              | policy               | high                 | high                   | disapproved_or_limited                  | too_early        | diagnose_data                     |
| GC-023  | mature data but low confidence due to attribution degradation                                                          | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | truth_degraded                          | mature           | diagnose_data                     |
| GC-024  | active creative with spend but zero impressions anomaly                                                                | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | spend_without_impressions               | learning         | diagnose_data                     |
| GC-025  | high CTR but poor CVR / landing issue                                                                                  | Diagnose                | diagnose_data       | diagnose              | performance          | medium               | medium                 | landing_or_cvr_issue                    | actionable       | diagnose_data                     |
| GC-026  | strong ROAS but tiny spend, not mature                                                                                 | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | tiny_spend_winner                       | too_early        | diagnose_data                     |
| GC-027  | strong CPA but low purchase count, not scalable yet                                                                    | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | low_purchase_count                      | learning         | diagnose_data                     |
| GC-028  | top 3 fatigue cluster                                                                                                  | Refresh                 | refresh             | review_only           | fatigue              | high                 | high                   | fatigue_composite                       | mature           | diagnose_data                     |
| GC-029  | no new winner in 7 days                                                                                                | Protect                 | protect             | review_only           | performance          | medium               | medium                 | winner_gap_aggregate_only               | mature           | disable_aggregate                 |
| GC-030  | approved but unused creative exists                                                                                    | Diagnose                | diagnose_data       | diagnose              | campaign_context     | medium               | medium                 | unused_approved_aggregate_only          | too_early        | disable_aggregate                 |
| GC-031  | family winner aging with no backup variants                                                                            | Protect                 | protect             | review_only           | performance          | medium               | medium                 | backup_variant_aggregate_only           | mature           | disable_aggregate                 |
| GC-032  | old challenger says scale_hard but V2 says Test More                                                                   | Test More               | test_more           | review_only           | insufficient_signal  | medium               | medium                 | low_evidence                            | learning         | diagnose_data                     |
| GC-033  | operator surface says act_now but V2 says Diagnose                                                                     | Diagnose                | diagnose_data       | diagnose              | data_quality         | high                 | low                    | truth_degraded                          | learning         | diagnose_data                     |
| GC-034  | old V1 stable_winner maps to V2 Protect                                                                                | Protect                 | protect             | review_only           | performance          | medium               | high                   | stable_winner                           | mature           | diagnose_data                     |
| GC-035  | old V1 fatigued_winner maps to V2 Refresh                                                                              | Refresh                 | refresh             | review_only           | fatigue              | high                 | high                   | fatigue_composite                       | mature           | diagnose_data                     |
| GC-036  | unlabeled campaign with would-be scale                                                                                 | Diagnose                | diagnose_data       | review_only           | data_quality         | medium               | low                    | campaign_label_missing                  | mature           | diagnose_data                     |
| GC-037  | labeled campaign with would-be scale                                                                                   | Scale                   | scale               | review_only           | performance          | high                 | high                   | strong_relative_winner                  | mature           | diagnose_data                     |
| GC-038  | labeled Main creative where Main baseline is stricter than all baseline                                                | Keep                    | review              | review_only           | performance          | medium               | medium                 | kind_main_baseline_stricter             | mature           | canonical_all_fallback            |
| GC-039  | labeled Test creative where Test baseline is easier than all baseline                                                  | Scale                   | scale               | review_only           | performance          | high                 | high                   | kind_test_baseline_selected             | mature           | canonical_all_fallback            |
| GC-040  | labeled Main creative with sparse/null Main calibration row                                                            | Same as canonical       | same_as_canonical   | review_only           | performance          | medium               | medium                 | kind_baseline_fallback                  | mature           | canonical_all_fallback            |
| GC-041  | labeled Mixed creative with no sufficient Mixed calibration row                                                        | Same as canonical       | same_as_canonical   | review_only           | performance          | medium               | medium                 | kind_mixed_fallback                     | mature           | canonical_all_fallback            |
| GC-042  | unlabeled campaign with would-be scale after kind-aware resolver                                                       | Diagnose                | diagnose_data       | review_only           | data_quality         | medium               | low                    | campaign_label_missing                  | mature           | diagnose_data                     |
| GC-043  | labeled Test creative with gate-emitted refresh signal                                                                 | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | test_cohort_refresh_to_cut              | mature           | diagnose_data                     |
| GC-044a | labeled Test creative with refresh signal where transformed cut is soft-blocked                                        | Test More               | test_more           | review_only           | performance          | medium               | medium                 | test_cohort_refresh_to_cut_soft_blocked | mature           | diagnose_data                     |
| GC-044b | labeled Test creative where original refresh would be soft-blocked but transformed cut is allowed                      | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | test_cohort_refresh_before_soft_only    | mature           | diagnose_data                     |
| GC-045  | labeled Main creative with gate-emitted refresh signal                                                                 | Refresh                 | refresh             | review_only           | fatigue              | high                 | medium                 | fatigue_composite                       | mature           | diagnose_data                     |
| GC-046  | labeled Mixed creative with gate-emitted refresh signal                                                                | Refresh                 | refresh             | review_only           | fatigue              | high                 | medium                 | fatigue_composite                       | mature           | diagnose_data                     |
| GC-047  | unlabeled creative with gate-emitted refresh signal                                                                    | Diagnose                | diagnose_data       | review_only           | data_quality         | medium               | low                    | campaign_label_missing                  | mature           | diagnose_data                     |
| GC-048  | spend reaches commercial loss-budget floor, purchases below scale floor, ROAS below account bottom quartile            | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | loss_budget_mature_loser                | mature           | diagnose_data                     |
| GC-049  | spend reaches commercial loss-budget floor, purchases below scale floor, ROAS in working zone                          | Keep                    | review              | review_only           | performance          | medium               | medium                 | weak_zone_not_cut                       | mature           | diagnose_data                     |
| GC-050  | spend reaches commercial loss-budget floor and ROAS is above scale threshold, but purchases are below scale floor      | Keep                    | review              | review_only           | performance          | high                 | medium                 | near_scale_low_purchase_depth           | mature           | diagnose_data                     |
| GC-051  | scale-zone creative meets spend, purchase, and recent-hold gates, but account calibration sample is too thin for scale | Keep                    | review              | review_only           | performance          | high                 | medium                 | scale_calibration_thin                  | mature           | diagnose_data                     |
| GC-052  | scale-zone creative meets spend, purchase, and recent-hold gates, but winner purchase benchmark is missing             | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | scale_benchmark_missing                 | mature           | diagnose_data                     |
| GC-053  | scale-zone creative meets spend, purchase, recent-hold, and account winner benchmark readiness                         | Scale                   | scale               | review_only           | performance          | high                 | high                   | strong_relative_winner                  | mature           | diagnose_data                     |
| GC-054  | scale-ready winner in an explicit Test campaign                                                                        | Scale                   | promote_to_main     | review_only           | performance          | high                 | high                   | strong_relative_winner                  | mature           | diagnose_data                     |
| GC-055  | scale-ready winner in an explicit Main campaign                                                                        | Scale                   | scale_budget        | review_only           | performance          | high                 | high                   | strong_relative_winner                  | mature           | diagnose_data                     |
| GC-056  | scale-ready winner in an explicit Mixed campaign                                                                       | Scale                   | controlled_scale    | review_only           | performance          | high                 | high                   | strong_relative_winner                  | mature           | diagnose_data                     |
| GC-057  | stale source evidence with a severe scaled stop-loss loser                                                              | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | stale_stop_loss_review                  | mature           | diagnose_data                     |
| GC-058  | stale source evidence with a sustained loser past commercial maturity                                                   | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | stale_sustained_loser                   | mature           | diagnose_data                     |
| GC-059  | cut-zone creative has enough recent spend and recent 7d ROAS above target                                               | Keep                    | review              | review_only           | performance          | high                 | high                   | recovery_hold                          | mature           | diagnose_data                     |
| GC-060  | scale-ready winner has unknown source freshness                                                                        | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | unknown_freshness_scale_block           | mature           | diagnose_data                     |
| GC-061  | funnel-step issue has unknown source freshness, so fresh proof is unavailable                                           | Keep                    | review              | review_only           | data_quality         | medium               | medium                 | unknown_freshness_funnel_proof_required | mature           | diagnose_data                     |
| GC-062  | active creative has verified 0 spend and 0 impressions at 35h source freshness                                          | Diagnose                | fix_delivery        | diagnose              | delivery             | high                 | medium                 | active_no_spend_24h_fresh_boundary      | learning         | diagnose_data                     |
| GC-063  | 40h source freshness blocks no-delivery proof but mature severe loser math is present                                  | Cut                     | cut                 | review_only           | performance          | high                 | high                   | freshness_boundary_severe_cut           | mature           | diagnose_data                     |
| GC-064  | 49h source freshness with a mature severe loser                                                                        | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | stale_severe_cut_confidence_cap         | mature           | diagnose_data                     |
| GC-065  | unknown source freshness with a mature severe loser                                                                    | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | unknown_freshness_severe_cut_cap        | mature           | diagnose_data                     |
| GC-066  | scale-ready winner has stale source freshness                                                                          | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | stale_freshness_scale_block             | mature           | diagnose_data                     |
| GC-067  | scale-ready winner has unknown source freshness as canonical scale blocker                                             | Keep                    | review              | review_only           | data_quality         | high                 | medium                 | unknown_freshness_scale_block           | mature           | diagnose_data                     |
| GC-068  | funnel-step issue has unknown source freshness as canonical funnel blocker                                             | Keep                    | review              | review_only           | data_quality         | medium               | medium                 | unknown_freshness_funnel_proof_required | mature           | diagnose_data                     |
| GC-069  | cut-zone creative has enough recent spend and recent 7d ROAS above target as canonical recovery hold                   | Keep                    | review              | review_only           | performance          | high                 | high                   | recovery_hold                          | mature           | diagnose_data                     |
| GC-070  | cut-zone creative has recent 7d ROAS above target but recent spend below the recovery sample threshold                 | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | recovery_hold_spend_boundary            | mature           | diagnose_data                     |
| GC-071  | cut-zone creative has enough recent spend but recent 7d ROAS equals target exactly                                     | Cut                     | cut                 | review_only           | performance          | high                 | medium                 | recovery_hold_strict_roas_boundary      | mature           | diagnose_data                     |

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

| Case    | Source                              | Raw sequence            | Published sequence      | Suppressed day indexes |
|---------|-------------------------------------|-------------------------|-------------------------|------------------------|
| GS-001  | IwaStore 946471284944193            | scale,keep,scale        | scale,scale,scale       | 1                      |
| GS-002  | TheSwaf 1962656064410174            | cut,keep,cut            | cut,cut,cut             | 1                      |
| GS-003  | Tiles 25889037484086563             | keep,cut,keep           | keep,keep,keep          | 1                      |
| GS-004  | sustained transition confirms       | cut,keep,keep,keep      | cut,cut,keep,keep       | 1                      |
| GS-005  | entering hard requires confirmation | keep,cut,cut            | keep,keep,cut           | 1                      |
| GS-006  | soft-to-soft publishes immediately  | test_more,keep,diagnose | test_more,keep,diagnose | none                   |

- A suppressed day republishes the previous published label with the
  `pending_transition` badge; the raw label is persisted in `raw_label`.
- Published period-2 hard round-trips are structurally impossible; the
  replay evidence for oscillation reduction is the reversal-within-3 metric
  (76 -> 20 over 2026-06-01..07-05).
