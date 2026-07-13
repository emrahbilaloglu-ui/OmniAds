# H12 Decision Hysteresis Challenger Closure

Generated at: 2026-07-12T22:07:27.463Z
Contract: `adsecute.h12-decision-hysteresis-challenger.v1`
Report hash: `6b4d65c88dcf8778356869a5b5d62960caad4b191f7d5311bccf55f4bde3ac24`

## Evidence Boundary

The selection replay is read-only `restated_ad_daily` evidence at native ad grain. It never claims exact decision-time inputs or causal provider-write lift. The persisted `raw_label` seam is reported separately and is not pooled with the restated selection. Exact/native coverage and hashes are loaded from their current artifacts at runtime; a native source-hash mismatch aborts the replay.

## Fixed Protocol

- Policies: exactly 7 predeclared symmetric, gap-reset, and action-specific entry policies.
- Development: 2025-12-01..2026-03-31; 14d outcomes mature through 2026-03-17.
- Calibration: 2026-04-01..2026-05-31; 14d outcomes mature through 2026-05-17.
- Locked test: 2026-06-01..2026-07-05; 14d outcomes mature through 2026-06-27.
- Policy state is causal: current/past raw labels only. Soft, blocked, and not-applicable exits publish immediately.
- A direct hard-to-hard switch publishes canonical `keep` while the new action is pending.

## Coverage

- Restated observations: 86770
- Businesses / accounts / entities: 12 / 13 / 3614
- Target-cutoff-exact rows: 15049
- Complete outcome rows (3d / 7d / 14d): 86425 / 85792 / 82533
- Source rows updated after decision cutoff: 86770; therefore the tier remains restated.

## development

Policy | Rows | Raw reversals | Published reversals | Reduction | 1-eval blips published | Durable recall | Durability precision | Outcome precision | Outcome recall | Delay P50 | Delay P95 | Safety-exit delays
---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:
H12_no_hard_label_hysteresis | 53303 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_two_consecutive_evaluations | 53303 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_three_consecutive_evaluations | 53303 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_two_consecutive_gap_reset | 53303 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut1_scale2_refresh2 | 53303 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut2_scale3_refresh2 | 53303 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut1_scale3_refresh2 | 53303 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0

Policy | Window | Available | Complete | Known entries | Precision | Supported recall
---|---:|---:|---:|---:|---:|---:
H12_no_hard_label_hysteresis | 3d | 53303 | 51995 | 0 | n/a | n/a
H12_no_hard_label_hysteresis | 7d | 53303 | 50338 | 0 | n/a | n/a
H12_no_hard_label_hysteresis | 14d | 53303 | 47892 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 3d | 53303 | 51995 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 7d | 53303 | 50338 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 14d | 53303 | 47892 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 3d | 53303 | 51995 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 7d | 53303 | 50338 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 14d | 53303 | 47892 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 3d | 53303 | 51995 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 7d | 53303 | 50338 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 14d | 53303 | 47892 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 3d | 53303 | 51995 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 7d | 53303 | 50338 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 14d | 53303 | 47892 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 3d | 53303 | 51995 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 7d | 53303 | 50338 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 14d | 53303 | 47892 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 3d | 53303 | 51995 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 7d | 53303 | 50338 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 14d | 53303 | 47892 | 0 | n/a | n/a

## calibration

Policy | Rows | Raw reversals | Published reversals | Reduction | 1-eval blips published | Durable recall | Durability precision | Outcome precision | Outcome recall | Delay P50 | Delay P95 | Safety-exit delays
---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:
H12_no_hard_label_hysteresis | 21056 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_two_consecutive_evaluations | 21056 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_three_consecutive_evaluations | 21056 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_two_consecutive_gap_reset | 21056 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut1_scale2_refresh2 | 21056 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut2_scale3_refresh2 | 21056 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut1_scale3_refresh2 | 21056 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0

Policy | Window | Available | Complete | Known entries | Precision | Supported recall
---|---:|---:|---:|---:|---:|---:
H12_no_hard_label_hysteresis | 3d | 21056 | 20213 | 0 | n/a | n/a
H12_no_hard_label_hysteresis | 7d | 21056 | 19062 | 0 | n/a | n/a
H12_no_hard_label_hysteresis | 14d | 21056 | 16528 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 3d | 21056 | 20213 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 7d | 21056 | 19062 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 14d | 21056 | 16528 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 3d | 21056 | 20213 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 7d | 21056 | 19062 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 14d | 21056 | 16528 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 3d | 21056 | 20213 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 7d | 21056 | 19062 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 14d | 21056 | 16528 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 3d | 21056 | 20213 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 7d | 21056 | 19062 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 14d | 21056 | 16528 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 3d | 21056 | 20213 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 7d | 21056 | 19062 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 14d | 21056 | 16528 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 3d | 21056 | 20213 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 7d | 21056 | 19062 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 14d | 21056 | 16528 | 0 | n/a | n/a

## locked_test

Policy | Rows | Raw reversals | Published reversals | Reduction | 1-eval blips published | Durable recall | Durability precision | Outcome precision | Outcome recall | Delay P50 | Delay P95 | Safety-exit delays
---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:
H12_no_hard_label_hysteresis | 12411 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_two_consecutive_evaluations | 12411 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_three_consecutive_evaluations | 12411 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_two_consecutive_gap_reset | 12411 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut1_scale2_refresh2 | 12411 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut2_scale3_refresh2 | 12411 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0
H12_cut1_scale3_refresh2 | 12411 | 0 | 0 | n/a | 0 | n/a | n/a | n/a | n/a | n/a | n/a | 0

Policy | Window | Available | Complete | Known entries | Precision | Supported recall
---|---:|---:|---:|---:|---:|---:
H12_no_hard_label_hysteresis | 3d | 12411 | 12066 | 0 | n/a | n/a
H12_no_hard_label_hysteresis | 7d | 12411 | 11433 | 0 | n/a | n/a
H12_no_hard_label_hysteresis | 14d | 12411 | 8174 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 3d | 12411 | 12066 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 7d | 12411 | 11433 | 0 | n/a | n/a
H12_two_consecutive_evaluations | 14d | 12411 | 8174 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 3d | 12411 | 12066 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 7d | 12411 | 11433 | 0 | n/a | n/a
H12_three_consecutive_evaluations | 14d | 12411 | 8174 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 3d | 12411 | 12066 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 7d | 12411 | 11433 | 0 | n/a | n/a
H12_two_consecutive_gap_reset | 14d | 12411 | 8174 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 3d | 12411 | 12066 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 7d | 12411 | 11433 | 0 | n/a | n/a
H12_cut1_scale2_refresh2 | 14d | 12411 | 8174 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 3d | 12411 | 12066 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 7d | 12411 | 11433 | 0 | n/a | n/a
H12_cut2_scale3_refresh2 | 14d | 12411 | 8174 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 3d | 12411 | 12066 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 7d | 12411 | 11433 | 0 | n/a | n/a
H12_cut1_scale3_refresh2 | 14d | 12411 | 8174 | 0 | n/a | n/a

## Selection And Locked Inference

Calibration selection: `none`.
Verdict: **REJECT_H12_POLICY_CHANGE** - The predeclared calibration/locked safety, stability, or delay gate did not support changing the current policy.
Performance promotion gate: **REJECT**; known=0, precision=n/a, supported-opportunity recall=n/a, episode-start precision-delta lower=n/a.
10,000-replicate reversal-reduction CI: n/a .. n/a.
10,000-replicate episode-start precision delta CI: n/a .. n/a.
McNemar paired episodes: n=0, net wins=0, p=1.0000.

## Held-Out Evidence

- Account cells: 13; non-negative reversal direction: 0/0.
- Entity hash folds: 5; non-negative reversal direction: 5/5.
- Seen/new entity cells: seen_pre_locked:0, new_in_locked:0.

## Falsification And Sensitivity

- Future mutation prefix invariance: PASS.
- Deterministic rerun: PASS.
- Gap-reset reversals: 0; production-like carry: 0.
- Continuity-destroyed placebo durability precision: n/a vs observed n/a.
- Outcome-permutation precision: n/a vs observed n/a.

## Persisted Raw-Label Seam

Engine version: `v3-2026-07-07-vnext-stale-fatigue`; rows=11552; dates=2026-07-06..2026-07-12.
Full-seam reversal counts by policy order: 4 / 5 / 3 / 5 / 4 / 5 / 4; safety-exit delays: 0 / 0 / 0 / 0 / 0 / 0 / 0.
This is exact persisted output behavior, not exact-PIT input reconstruction and not outcome evidence.

## Exact-PIT Boundary

Full-resolver-input exact rows: 0; exact 7d/28d rolling windows: 87/77. H12 exact sequence status: `unavailable_no_full_resolver_input_rows`.

## Physically Unreconstructable Limits

- The retained exact raw ad-insight payload has no creative_id, so its exact rows cannot be linked to the persisted creative decision sequence without promoting a later dimension.
- Exact-PIT receipt: canonical serialized CreativeInput, AccountDecisionProfile, DataHealth, campaign-label context, and hysteresis memory were not persisted
- Exact-PIT receipt: the persisted historical baseline does not have a complete decision/lifecycle/calibration input-hash chain for every output row
- Exact-PIT receipt: retained sources do not completely prove historical ad-level configured/effective status or policy/review inputs; campaign-status receipts prove only positively observed parent state
- Exact-PIT receipt: provider attribution restatements cannot be reversed to the value Meta exposed at an earlier cutoff when that generation was not retained
- Provider-account identity is absent from engine_v3_decision_snapshots_daily, so account-held-out analysis of the persisted raw-label seam would require mixing a restated identity and is intentionally not performed.
- The causal performance effect of acting one or two evaluations later cannot be identified without controlled contemporaneous treatment receipts; observational outcome precision remains review-only.
