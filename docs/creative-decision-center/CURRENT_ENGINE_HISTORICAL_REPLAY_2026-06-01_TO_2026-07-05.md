# Current Engine Historical Replay - 2026-06-01 to 2026-07-05

Generated at: 2026-07-12T02:05:37.116Z
Current date assumed by run: 2026-07-12
Engine version: `v3-2026-07-12-safety-dominant-hysteresis`
Outcome classifier: `creative-outcome-classifier.v2`
Replay window: 2026-06-01 -> 2026-07-05
Outcome evaluation ceiling: 2026-07-05
Freshness mode: historical

## Verdict Boundary

This is a read-only historical replay/backtest of the current decision engine over existing warehouse data. It is not evidence that the production scheduler actually ran for 35 inclusive asOf dates / 34 elapsed historical days, and it is not causal proof that an operator would have achieved these outcomes.

The useful question answered here is narrower: if today's current engine had evaluated each historical asOf date, what labels would it have emitted, and what non-causal forward outcome proxy is visible for windows that are already closed by 2026-07-05?

## Live/Write Safety

- DB writes: no.
- Provider/API writes: no.
- Manual `/api/sync/cron` POST: no.
- Migrations: no.
- Live read source: live_db_tunnel via 127.0.0.1:15432.

## Method Limits

- This replay uses the current engine path and does not create a standalone decision core.
- Historical freshness mode normalizes freshness to isolate formula behavior; it is analysis-only and not exact production runtime behavior.
- June dates can be runtime SQL fallback if no current-version lifecycle rows existed yet; they must not be compared as equal to lifecycle-informed July production rows.
- Outcome windows after 2026-06-28 for 7d and after 2026-06-21 for 14d are marked open_window under the 2026-07-05 ceiling.
- Closed-window unknown is distinct from open_window and commonly means zero forward spend; it is not counted as a failed hard decision.
- Outcome precision/missed-opportunity values are non-causal proxies because historical forward spend was affected by real operator/platform decisions.
- Targets are read from current business target packs; target history is not versioned in this replay.
- Outcome/calibration cells use the guard-applied surfaced decision.label; blockedActionType is reported separately and is not reclassified as a surfaced hard outcome.
- Hard and non-hard positive polarity is never pooled.
- Hysteresis is simulated with a clean per-business epoch at startDate and in-memory day-over-day chaining; production chains through persisted raw_label snapshots but applies identical rules.
- Suppressed-day published decisions keep the raw decision's confidence and metrics, matching production stabilizeDecisionLabel.
- Matched suppressed-day scoring is the primary hold-vs-flip evidence: identical creative/asOf/window on both sides, so censoring and anchoring are symmetric by construction.
- Episode-level raw-vs-published cells are secondary context: published sequences re-segment runs, anchor confirmed hard transitions one day later (their windows exclude the trigger day and can cross the evaluation ceiling), and zero-forward-spend unknown-censoring selects different known sets per stream under the historically executed operator actions (off-policy).
- Delay exposure sums the NEXT adjacent day's spend on suppressed days (cut and scale separately); it is exposure under historical operator policy, not realized savings or a bound.
- Suppression resolutions: confirmed/reverted require a next-calendar-day observation; gap_return, exited_universe and replay_end carry no next-day claim. Universe exit after a suppressed raw cut often means the creative genuinely died - exits are therefore reported, not folded into reverted.
- Published period-2 round-trips are structurally zero under hysteresis and are not evidence; the reversal-within-3-observations metric is the fair oscillation comparison.
- Replay hard-transition counts are not directly comparable to production decision_changed telemetry (different dedupe surface and universe scoping); use them for raw-vs-published deltas within this replay only.
- Raw hard transitions on a creative's final observed day cannot be suppressed-and-confirmed inside the window (right-edge censoring modestly favors the published stream; replay_end counts quantify it).
- Fidelity vs persisted snapshots is vacuous for the current ENGINE_VERSION (no persisted rows exist yet); fidelity rows validate the replay pipeline against prior-version dates only.
- The published stream re-executes the same outcome-aggregate queries as the raw stream; results are expected identical but mid-run warehouse drift is theoretically possible.
- The dedupe comparator was corrected in v2 to match production (highest-priority computation wins); v1 replay artifacts used an inverted comparator and are not comparable.

## Label Flow And Guard Boundary

Outcome and confidence cells are computed from the guard-applied surfaced `decision.label`. `blockedActionType` is reported separately as guard context; this replay does not silently convert a blocked raw hard verdict into a hard outcome episode.

Interpretation consequence: a hard episode is a surfaced historical-replay label for that business/day/source-mode, not a claim that the same business is currently surfacing hard production labels. Fallback-mode hard labels must not be read as lifecycle-informed July production behavior.

## Global Summary

- Businesses found: 14
- Dates replayed: 35
- Decision rows: 33532
- Unique business+creative pairs: 1522
- Label mix: test_more: 25107, keep: 3273, out_of_scope: 3244, diagnose: 1456, cut: 420, scale: 32
- Source mode days: runtime_sql_fallback: 490
- Open outcome windows: 18482
- Closed daily outcome rows: 48582
- Episode-deduped outcome rows: 4344
- Known episodes: 2178
- Unknown episodes: 2166

## Business Summary

| Business | Demo | Days | Failed | Decisions | Unique creatives | Labels | Hard rows | Blocked rows | Source modes | Profile ranges | Risk hints |
|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|---|
| Adsecute Demo | yes | 35 | 0 | 0 | 0 | - | 0 | 0 | runtime_sql_fallback: 35 | spendUnit 42.00-42.00, commercialMaturitySpend 84.00-84.00, hardCutSpend 210.00-210.00, scaleMinPurchases 1.00-1.00, matureCreativeCount 0.00-0.00 | demo_business_in_enabled_scope, no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Bilsem Zeka | no | 35 | 0 | 3956 | 148 | test_more: 1819, out_of_scope: 1807, keep: 249, diagnose: 81 | 0 | 0 | runtime_sql_fallback: 35 | spendUnit 2,517.01-3,886.65, commercialMaturitySpend 5,034.03-7,773.31, hardCutSpend 12,585.07-19,433.27, bottomQuartileRatio 0.65-0.83, severeLoserRatio 0.34-0.66, scaleMinPurchases 1.00-3.00, winnerPurchaseP50 1.00-3.00, matureCreativeCount 71.00-76.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| BskTR | no | 35 | 0 | 1138 | 41 | out_of_scope: 574, test_more: 526, diagnose: 23, keep: 15 | 0 | 0 | runtime_sql_fallback: 35 | scaleMinPurchases 1.00-1.00, matureCreativeCount 29.00-41.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| ColorFullWorldsTR | no | 35 | 0 | 1086 | 48 | test_more: 884, keep: 100, diagnose: 84, cut: 16, scale: 2 | 18 | 39 | runtime_sql_fallback: 35 | spendUnit 30.93-32.83, commercialMaturitySpend 61.87-65.67, hardCutSpend 154.67-164.17, bottomQuartileRatio 0.64-0.91, severeLoserRatio 0.42-0.52, scaleMinPurchases 2.00-6.00, winnerPurchaseP50 2.00-6.00, matureCreativeCount 29.00-36.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| EMOLOS | no | 35 | 0 | 4283 | 205 | test_more: 3672, keep: 414, cut: 153, diagnose: 44 | 153 | 30 | runtime_sql_fallback: 35 | spendUnit 34.34-35.39, commercialMaturitySpend 68.69-70.78, hardCutSpend 171.72-176.95, bottomQuartileRatio 0.21-0.25, severeLoserRatio 0.09-0.16, scaleMinPurchases 1.00-1.00, winnerPurchaseP50 1.00-1.00, matureCreativeCount 39.00-51.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Enise | no | 35 | 0 | 0 | 0 | - | 0 | 0 | runtime_sql_fallback: 35 | scaleMinPurchases 1.00-1.00, matureCreativeCount 0.00-0.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Grandmix | no | 35 | 0 | 2579 | 200 | test_more: 1830, keep: 444, diagnose: 241, cut: 55, scale: 9 | 64 | 23 | runtime_sql_fallback: 35 | spendUnit 102.79-108.51, commercialMaturitySpend 256.98-271.28, hardCutSpend 822.34-868.11, bottomQuartileRatio 0.41-0.48, severeLoserRatio 0.19-0.24, scaleMinPurchases 4.00-7.00, winnerPurchaseP50 2.50-4.50, matureCreativeCount 55.00-74.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Halıcızade | no | 35 | 0 | 1935 | 148 | test_more: 1859, keep: 29, out_of_scope: 28, cut: 14, diagnose: 5 | 14 | 3 | runtime_sql_fallback: 35 | spendUnit 6,691.64-9,031.38, commercialMaturitySpend 13,383.27-18,062.77, hardCutSpend 33,458.18-45,156.92, bottomQuartileRatio 0.35-0.75, severeLoserRatio 0.20-0.49, scaleMinPurchases 1.00-2.00, winnerPurchaseP50 1.00-2.00, matureCreativeCount 12.00-19.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| IwaStore | no | 35 | 0 | 1993 | 104 | test_more: 1322, keep: 256, out_of_scope: 212, diagnose: 203 | 0 | 0 | runtime_sql_fallback: 35 | spendUnit 48.95-50.88, commercialMaturitySpend 97.91-101.77, hardCutSpend 244.76-254.42, bottomQuartileRatio 0.57-0.83, severeLoserRatio 0.40-0.57, scaleMinPurchases 2.00-5.00, winnerPurchaseP50 2.00-4.50, matureCreativeCount 46.00-96.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| IwaTR | no | 35 | 0 | 2191 | 92 | test_more: 1941, diagnose: 134, keep: 112, out_of_scope: 4 | 0 | 0 | runtime_sql_fallback: 35 | scaleMinPurchases 1.00-1.00, matureCreativeCount 24.00-42.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Silveristic | no | 35 | 0 | 1226 | 64 | test_more: 772, out_of_scope: 405, diagnose: 32, keep: 17 | 0 | 0 | runtime_sql_fallback: 35 | scaleMinPurchases 1.00-1.00, matureCreativeCount 28.00-32.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| TheSwaf | no | 35 | 0 | 6267 | 259 | test_more: 5223, keep: 717, diagnose: 321, out_of_scope: 6 | 0 | 0 | runtime_sql_fallback: 35 | spendUnit 92.76-95.07, commercialMaturitySpend 139.14-142.60, hardCutSpend 278.28-285.21, bottomQuartileRatio 0.38-0.46, severeLoserRatio 0.24-0.33, scaleMinPurchases 1.00-2.00, winnerPurchaseP50 1.00-2.00, matureCreativeCount 79.00-112.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Tiles Workshop | no | 35 | 0 | 5353 | 161 | test_more: 4125, keep: 862, cut: 182, diagnose: 163, scale: 21 | 203 | 144 | runtime_sql_fallback: 35 | spendUnit 53.41-54.77, commercialMaturitySpend 106.83-109.54, hardCutSpend 267.07-273.85, bottomQuartileRatio 0.63-0.69, severeLoserRatio 0.35-0.50, scaleMinPurchases 5.00-9.00, winnerPurchaseP50 4.50-9.00, matureCreativeCount 100.00-111.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Vornom | no | 35 | 0 | 1525 | 52 | test_more: 1134, out_of_scope: 208, diagnose: 125, keep: 58 | 0 | 0 | runtime_sql_fallback: 35 | scaleMinPurchases 1.00-1.00, matureCreativeCount 26.00-31.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |

## Fidelity Check vs Persisted Snapshots

This is the replay-faithfulness anchor requested by Claude: 2026-07-03 and 2026-07-04 replay rows are compared with actual persisted current-version snapshots. Low fidelity does not automatically mean the formula is wrong; it means replay mode/provenance differs and the historical result must be discounted accordingly.

| Business | Date | Source mode | Replay rows | Snapshot rows | Common | Label match | Label+confidence match | Replay-only | Snapshot-only |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| Adsecute Demo | 2026-07-03 | runtime_sql_fallback | 0 | 0 | 0 | - | - | 0 | 0 |
| Adsecute Demo | 2026-07-04 | runtime_sql_fallback | 0 | 0 | 0 | - | - | 0 | 0 |
| Bilsem Zeka | 2026-07-03 | runtime_sql_fallback | 104 | 0 | 0 | - | - | 104 | 0 |
| Bilsem Zeka | 2026-07-04 | runtime_sql_fallback | 104 | 0 | 0 | - | - | 104 | 0 |
| BskTR | 2026-07-03 | runtime_sql_fallback | 33 | 0 | 0 | - | - | 33 | 0 |
| BskTR | 2026-07-04 | runtime_sql_fallback | 33 | 0 | 0 | - | - | 33 | 0 |
| ColorFullWorldsTR | 2026-07-03 | runtime_sql_fallback | 22 | 0 | 0 | - | - | 22 | 0 |
| ColorFullWorldsTR | 2026-07-04 | runtime_sql_fallback | 22 | 0 | 0 | - | - | 22 | 0 |
| EMOLOS | 2026-07-03 | runtime_sql_fallback | 81 | 0 | 0 | - | - | 81 | 0 |
| EMOLOS | 2026-07-04 | runtime_sql_fallback | 81 | 0 | 0 | - | - | 81 | 0 |
| Enise | 2026-07-03 | runtime_sql_fallback | 0 | 0 | 0 | - | - | 0 | 0 |
| Enise | 2026-07-04 | runtime_sql_fallback | 0 | 0 | 0 | - | - | 0 | 0 |
| Grandmix | 2026-07-03 | runtime_sql_fallback | 71 | 0 | 0 | - | - | 71 | 0 |
| Grandmix | 2026-07-04 | runtime_sql_fallback | 92 | 0 | 0 | - | - | 92 | 0 |
| Halıcızade | 2026-07-03 | runtime_sql_fallback | 101 | 0 | 0 | - | - | 101 | 0 |
| Halıcızade | 2026-07-04 | runtime_sql_fallback | 101 | 0 | 0 | - | - | 101 | 0 |
| IwaStore | 2026-07-03 | runtime_sql_fallback | 90 | 0 | 0 | - | - | 90 | 0 |
| IwaStore | 2026-07-04 | runtime_sql_fallback | 90 | 0 | 0 | - | - | 90 | 0 |
| IwaTR | 2026-07-03 | runtime_sql_fallback | 85 | 0 | 0 | - | - | 85 | 0 |
| IwaTR | 2026-07-04 | runtime_sql_fallback | 85 | 0 | 0 | - | - | 85 | 0 |
| Silveristic | 2026-07-03 | runtime_sql_fallback | 32 | 0 | 0 | - | - | 32 | 0 |
| Silveristic | 2026-07-04 | runtime_sql_fallback | 32 | 0 | 0 | - | - | 32 | 0 |
| TheSwaf | 2026-07-03 | runtime_sql_fallback | 114 | 0 | 0 | - | - | 114 | 0 |
| TheSwaf | 2026-07-04 | runtime_sql_fallback | 110 | 0 | 0 | - | - | 110 | 0 |
| Tiles Workshop | 2026-07-03 | runtime_sql_fallback | 143 | 0 | 0 | - | - | 143 | 0 |
| Tiles Workshop | 2026-07-04 | runtime_sql_fallback | 142 | 0 | 0 | - | - | 142 | 0 |
| Vornom | 2026-07-03 | runtime_sql_fallback | 45 | 0 | 0 | - | - | 45 | 0 |
| Vornom | 2026-07-04 | runtime_sql_fallback | 45 | 0 | 0 | - | - | 45 | 0 |

## Fidelity Mismatch Notes

Sampled replay-vs-snapshot mismatches are listed explicitly so the fidelity rate cannot hide boundary-class differences.

- Bilsem Zeka 2026-07-03 creative 1008704841683230: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $6,344 < $7,622 loss-budget floor, 1 purchases, age 17d) — let the creative accumulate signal.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1013268184911193: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $2,110 < $7,622 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1023072616831733: replay keep/60 vs snapshot null/null; replay reason "[weak target] ROAS 2.78 (28d) just above breakeven (93% of target) — keep observing; consider tightening if recent 7d weakens.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1030506112969508: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3,859 < $7,622 loss-budget floor, 1 purchases) — let the creative accumulate signal.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1044351044928169: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_ENGAGEMENT.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1151248610534669: replay keep/60 vs snapshot null/null; replay reason "[near scale] ROAS 3.79 (28d) approaching scale threshold (126%) — needs $7,622+ spend or 3+ purchases for full scale.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1167086666488357: replay out_of_scope/60 vs snapshot null/null; replay reason "Creative runs in lead adsets; purchase decision engine does not evaluate it.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1201616515475332: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $325 < $7,622 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1201772688835593: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_LEADS.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1212323447586489: replay keep/60 vs snapshot null/null; replay reason "[near scale, soft-only] ROAS 3.96 (28d) = 132% of target 3.00 with 12 purchases (28d) and recent 7d holding at 8.10 — scale the ad set budget. (Reason for soft mode: threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1219831126816285: replay out_of_scope/60 vs snapshot null/null; replay reason "Creative runs in unknown adsets; purchase decision engine does not evaluate it.", snapshot reason "null".
- Bilsem Zeka 2026-07-03 creative 1275971854641276: replay out_of_scope/60 vs snapshot null/null; replay reason "Creative runs in unknown adsets; purchase decision engine does not evaluate it.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1008704841683230: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5,317 < $7,721 loss-budget floor, 1 purchases, age 18d) — let the creative accumulate signal.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1013268184911193: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $2,134 < $7,721 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1023072616831733: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_LEADS.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1030506112969508: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3,859 < $7,721 loss-budget floor, 1 purchases) — let the creative accumulate signal.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1044351044928169: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_ENGAGEMENT.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1151248610534669: replay keep/60 vs snapshot null/null; replay reason "[near scale] ROAS 3.79 (28d) approaching scale threshold (126%) — needs $7,721+ spend or 3+ purchases for full scale.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1167086666488357: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_LEADS.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1201616515475332: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $320 < $7,721 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1201772688835593: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_LEADS.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1212323447586489: replay keep/60 vs snapshot null/null; replay reason "[near scale, soft-only] ROAS 3.95 (28d) = 132% of target 3.00 with 12 purchases (28d) and recent 7d holding at 9.67 — scale the ad set budget. (Reason for soft mode: threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1219831126816285: replay out_of_scope/60 vs snapshot null/null; replay reason "Creative runs in unknown adsets; purchase decision engine does not evaluate it.", snapshot reason "null".
- Bilsem Zeka 2026-07-04 creative 1275971854641276: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_LEADS.", snapshot reason "null".
- BskTR 2026-07-03 creative 1298865939017532: replay keep/40 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.22x vs account baseline (hook score 1.13x; ctr score 0.69x; cpm_efficiency score 1.78x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- BskTR 2026-07-03 creative 1301841691777176: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- BskTR 2026-07-03 creative 1320994476557693: replay diagnose/40 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 31.47% vs account baseline 37.74%; Link-to-ATC 1.02% vs account baseline 1.61%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- BskTR 2026-07-03 creative 1409617320900427: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- BskTR 2026-07-03 creative 1417831732911331: replay keep/65 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.03x vs account baseline (hook score 0.91x; ctr score 0.72x; cpm_efficiency score 1.89x; click_to_lpv score 0.88x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- BskTR 2026-07-03 creative 1475080064389055: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- BskTR 2026-07-03 creative 1513543513755396: replay keep/40 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.12x vs account baseline (hook score 0.92x; ctr score 1.01x; cpm_efficiency score 1.32x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- BskTR 2026-07-03 creative 1521229436347382: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- BskTR 2026-07-03 creative 1636921507500503: replay diagnose/40 vs snapshot null/null; replay reason "Checkout breakdown: IC-to-purchase 20.00% vs account baseline 23.47%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- BskTR 2026-07-03 creative 1643837866722652: replay diagnose/40 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 31.71% vs account baseline 37.74%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- BskTR 2026-07-03 creative 1665290848045267: replay test_more/40 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.95x vs account baseline (hook score 0.94x; ctr score 0.50x; cpm_efficiency score 1.31x; click_to_lpv score 1.02x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- BskTR 2026-07-03 creative 1803086350649085: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- BskTR 2026-07-04 creative 1298865939017532: replay keep/40 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.26x vs account baseline (hook score 1.14x; ctr score 0.78x; cpm_efficiency score 1.81x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- BskTR 2026-07-04 creative 1301841691777176: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- BskTR 2026-07-04 creative 1320994476557693: replay diagnose/40 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 31.47% vs account baseline 37.74%; Link-to-ATC 1.02% vs account baseline 1.61%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- BskTR 2026-07-04 creative 1409617320900427: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- BskTR 2026-07-04 creative 1417831732911331: replay keep/65 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.03x vs account baseline (hook score 0.91x; ctr score 0.72x; cpm_efficiency score 1.89x; click_to_lpv score 0.88x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- BskTR 2026-07-04 creative 1475080064389055: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- BskTR 2026-07-04 creative 1513543513755396: replay keep/40 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.06x vs account baseline (hook score 0.93x; ctr score 0.79x; cpm_efficiency score 1.41x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- BskTR 2026-07-04 creative 1521229436347382: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- BskTR 2026-07-04 creative 1636921507500503: replay diagnose/40 vs snapshot null/null; replay reason "Checkout breakdown: IC-to-purchase 20.00% vs account baseline 23.47%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- BskTR 2026-07-04 creative 1643837866722652: replay diagnose/40 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 31.71% vs account baseline 37.74%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- BskTR 2026-07-04 creative 1665290848045267: replay test_more/40 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.94x vs account baseline (hook score 0.95x; ctr score 0.50x; cpm_efficiency score 1.36x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- BskTR 2026-07-04 creative 1803086350649085: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1030453132762286: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 2.43 (28d) = 61% of target after $629 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1032849702636102: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $63 loss-budget floor, 0 purchases, age 11d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1122094770994342: replay diagnose/40 vs snapshot null/null; replay reason "Delivery status is unavailable; resolve the current ad, ad set, and campaign state before applying a performance action.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1281394557535687: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $63 loss-budget floor, 0 purchases) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1350949346841523: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $23 < $63 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1368337941819592: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $63 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1369446851662907: replay keep/60 vs snapshot null/null; replay reason "[near scale] ROAS 5.28 (28d) above target (132%) — recent 7d ROAS 3.01 below target 4.00; observe.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1422123969673979: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $6 < $63 loss-budget floor, 0 purchases, age 11d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1498929587981582: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $34 < $63 loss-budget floor, 2 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1534243521462061: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $8 < $63 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1581834267283055: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $60 < $63 loss-budget floor, 1 purchases, age 10d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-03 creative 1632090364761099: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 2.48 (28d) = 62% of target after $633 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1030453132762286: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 2.31 (28d) = 58% of target after $663 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1032849702636102: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $63 loss-budget floor, 0 purchases, age 12d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1122094770994342: replay diagnose/40 vs snapshot null/null; replay reason "Delivery status is unavailable; resolve the current ad, ad set, and campaign state before applying a performance action.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1281394557535687: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $63 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1350949346841523: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $24 < $63 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1368337941819592: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $63 loss-budget floor, 1 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1369446851662907: replay keep/60 vs snapshot null/null; replay reason "[near scale] ROAS 5.35 (28d) above target (134%) — recent 7d ROAS 0.00 below target 4.00; observe.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1422123969673979: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $6 < $63 loss-budget floor, 0 purchases, age 12d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1498929587981582: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $40 < $63 loss-budget floor, 2 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1534243521462061: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $10 < $63 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1581834267283055: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $60 < $63 loss-budget floor, 1 purchases, age 11d) — let the creative accumulate signal.", snapshot reason "null".
- ColorFullWorldsTR 2026-07-04 creative 1632090364761099: replay keep/60 vs snapshot null/null; replay reason "[demote candidate] ROAS 2.69 (28d) = 67% of target — above account bottom quartile (64%) but below breakeven (3.00 = 75% of target) at $641 mature spend — consider demote to test placement or refresh creative concept.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1000487319029766: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $70 loss-budget floor, 0 purchases, age 16d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1005965712212138: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $2 < $70 loss-budget floor, 0 purchases, age 22d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1007889655170360: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $16 < $70 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1015151468123714: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $10 < $70 loss-budget floor, 0 purchases, age 21d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1017459037607213: replay keep/50 vs snapshot null/null; replay reason "[weak zone] ROAS 0.86 (28d) = 35% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1027652930238244: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $87 spend (28d) — loss-budget maturity reached at $70; cut underperforming creative. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1055877293537375: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $1 < $70 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1072760288625872: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $26 < $70 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1236188488428719: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 18d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1292712935970318: replay diagnose/55 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 17.94% vs account baseline 35.11%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1300829758785189: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $6 < $70 loss-budget floor, 0 purchases, age 22d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-03 creative 1305385024907982: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $29 < $70 loss-budget floor, 0 purchases) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1000487319029766: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $69 loss-budget floor, 0 purchases, age 17d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1005965712212138: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $2 < $69 loss-budget floor, 0 purchases, age 23d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1007889655170360: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $24 < $69 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1015151468123714: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $69 loss-budget floor, 0 purchases, age 22d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1017459037607213: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.45 (28d) = 18% of target after $130 spend (28d) — loss-budget maturity reached at $69; cut underperforming creative. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1027652930238244: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $96 spend (28d) — loss-budget maturity reached at $69; cut underperforming creative. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1055877293537375: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $1 < $69 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1072760288625872: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $35 < $69 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1236188488428719: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $69 loss-budget floor, 0 purchases, age 19d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1292712935970318: replay diagnose/55 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 15.34% vs account baseline 34.66%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1300829758785189: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $1 < $69 loss-budget floor, 0 purchases, age 23d) — let the creative accumulate signal.", snapshot reason "null".
- EMOLOS 2026-07-04 creative 1305385024907982: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $27 < $69 loss-budget floor, 0 purchases) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1002617308929281: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $11 < $262 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1003770772089284: replay keep/60 vs snapshot null/null; replay reason "[weak zone] ROAS 1.40 (28d) = 63% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1005337862441315: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $262 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1008549465472004: replay keep/60 vs snapshot null/null; replay reason "[demote candidate] ROAS 1.33 (28d) = 61% of target — above account bottom quartile (46%) but below breakeven (1.80 = 82% of target) at $926 mature spend — consider demote to test placement or refresh creative concept.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1009827774896101: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1010946998578771: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $58 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1012777161360911: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1020070427050295: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $15 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1024616573428480: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $82 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1025822163460162: replay keep/60 vs snapshot null/null; replay reason "[weak target] ROAS 1.98 (28d) just above breakeven (90% of target) — keep observing; consider tightening if recent 7d weakens.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1068268059100740: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $16 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1186862256977827: replay diagnose/55 vs snapshot null/null; replay reason "Landing page issue: Link-to-ATC 0.18% vs account baseline 1.17%; LPV-to-ATC 0.22% vs account baseline 1.44%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1002617308929281: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $11 < $257 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1003770772089284: replay keep/60 vs snapshot null/null; replay reason "[weak zone] ROAS 1.42 (28d) = 64% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1005337862441315: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $257 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1008549465472004: replay keep/60 vs snapshot null/null; replay reason "[demote candidate] ROAS 1.29 (28d) = 59% of target — above account bottom quartile (45%) but below breakeven (1.80 = 82% of target) at $955 mature spend — consider demote to test placement or refresh creative concept.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1009827774896101: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $257 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1010946998578771: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $58 < $257 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1012777161360911: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $257 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1020070427050295: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $15 < $257 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1024616573428480: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $82 < $257 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1025822163460162: replay keep/60 vs snapshot null/null; replay reason "[weak target] ROAS 2.02 (28d) just above breakeven (92% of target) — keep observing; consider tightening if recent 7d weakens.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1028255766263061: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $257 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1068268059100740: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $16 < $257 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1003434722545007: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1010914318351229: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1015362021206871: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1016155387685429: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $2 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1017320697689121: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $161 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1017778567316723: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1029804472879586: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $275 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1029954866216939: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $14 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1040413421673611: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $1 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1046628518053014: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1049503267758812: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-03 creative 1057121653536604: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $65 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1003434722545007: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $13,792 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1010914318351229: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $13,792 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1015362021206871: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $13,792 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1016155387685429: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $2 < $13,792 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1017320697689121: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $163 < $13,792 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1017778567316723: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $13,792 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1029804472879586: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $277 < $13,792 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1029954866216939: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $14 < $13,792 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1040413421673611: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $1 < $13,792 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1046628518053014: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $13,792 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1049503267758812: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $13,792 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Halıcızade 2026-07-04 creative 1057121653536604: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $72 < $13,792 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1003444735733770: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1016479011077401: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1020781523695732: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1025468773398763: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.82 (28d) = 23% of target after $276 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-03 creative 1028452980202623: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 1.94 (28d) = 56% of target after $150 spend (28d) — loss-budget maturity reached at $99; cut underperforming creative. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-03 creative 1033784855709309: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $13 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1037962691982511: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1038055285394393: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $51 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1038550568592146: replay keep/60 vs snapshot null/null; replay reason "[weak zone] ROAS 2.91 (28d) = 83% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1050560790774455: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1157254709850013: replay keep/60 vs snapshot null/null; replay reason "[at target] ROAS 3.86 (28d) at/around target 3.50 (110%) — stable, let it run.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1230828315767797: replay out_of_scope/60 vs snapshot null/null; replay reason "Creative runs in mid_funnel adsets; purchase decision engine does not evaluate it.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1003444735733770: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1016479011077401: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1020781523695732: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1025468773398763: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.82 (28d) = 23% of target after $276 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-04 creative 1028452980202623: replay keep/60 vs snapshot null/null; replay reason "[weak zone] ROAS 2.51 (28d) = 72% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1033784855709309: replay diagnose/55 vs snapshot null/null; replay reason "Checkout breakdown: IC-to-purchase 20.00% vs account baseline 20.71%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1037962691982511: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 3d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1038055285394393: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $64 < $99 loss-budget floor, 1 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1038550568592146: replay keep/60 vs snapshot null/null; replay reason "[weak zone] ROAS 2.15 (28d) = 62% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1050560790774455: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $99 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1157254709850013: replay keep/60 vs snapshot null/null; replay reason "[at target] ROAS 3.89 (28d) at/around target 3.50 (111%) — stable, let it run.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1230828315767797: replay out_of_scope/60 vs snapshot null/null; replay reason "Creative runs in mid_funnel adsets; purchase decision engine does not evaluate it.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1016123361020200: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1026667059767519: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1030238108868060: replay keep/53 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.22x vs account baseline (hook score 1.07x; ctr score 1.06x; cpm_efficiency score 1.38x; click_to_lpv score 1.28x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1092817043324998: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1098359138836126: replay keep/57 vs snapshot null/null; replay reason "[quality-only strong] Upper/mid-funnel score 1.57x vs account baseline (hook score 1.08x; ctr score 1.39x; cpm_efficiency score 1.21x; click_to_lpv score 1.13x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1136950221240357: replay keep/60 vs snapshot null/null; replay reason "[quality-only strong] Upper/mid-funnel score 1.32x vs account baseline (hook score 0.50x; ctr score 2.00x; cpm_efficiency score 1.05x; click_to_lpv score 0.96x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1171849118359340: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1172712014746001: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1207500747600201: replay test_more/40 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.73x vs account baseline (hook score 1.04x; ctr score 0.50x; cpm_efficiency score 0.80x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1223002432706265: replay keep/47 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.25x vs account baseline (hook score 1.05x; ctr score 0.81x; cpm_efficiency score 1.12x; click_to_lpv score 1.19x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1225265562983552: replay test_more/40 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.77x vs account baseline (hook score 1.09x; ctr score 0.52x; cpm_efficiency score 0.85x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- IwaTR 2026-07-03 creative 1279637120690685: replay diagnose/40 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 17.74% vs account baseline 32.28%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1016123361020200: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1026667059767519: replay test_more/40 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.92x vs account baseline (hook score 1.09x; ctr score 0.71x; cpm_efficiency score 1.04x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1030238108868060: replay keep/53 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.26x vs account baseline (hook score 1.06x; ctr score 1.11x; cpm_efficiency score 1.37x; click_to_lpv score 1.27x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1092817043324998: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1098359138836126: replay keep/57 vs snapshot null/null; replay reason "[quality-only strong] Upper/mid-funnel score 1.50x vs account baseline (hook score 1.07x; ctr score 1.47x; cpm_efficiency score 1.21x; click_to_lpv score 1.12x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1136950221240357: replay keep/60 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.26x vs account baseline (hook score 0.50x; ctr score 2.00x; cpm_efficiency score 1.05x; click_to_lpv score 0.95x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1171849118359340: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1172712014746001: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1207500747600201: replay test_more/40 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.73x vs account baseline (hook score 1.04x; ctr score 0.50x; cpm_efficiency score 0.80x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1223002432706265: replay keep/47 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.26x vs account baseline (hook score 1.04x; ctr score 0.86x; cpm_efficiency score 1.12x; click_to_lpv score 1.18x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1225265562983552: replay test_more/40 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.75x vs account baseline (hook score 1.09x; ctr score 0.50x; cpm_efficiency score 0.82x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- IwaTR 2026-07-04 creative 1279637120690685: replay diagnose/40 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 16.12% vs account baseline 32.61%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1023001666791831: replay test_more/61 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.87x vs account baseline (hook score 1.80x; ctr score 0.70x; cpm_efficiency score 0.56x; click_to_lpv score 1.02x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1033214469106065: replay diagnose/45 vs snapshot null/null; replay reason "[quality-only] checkout bottleneck detected before profit evaluation: IC-to-purchase 20.00% vs account baseline 21.82%. Do not judge the creative as a sales loser until this step is checked.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1134586805526549: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1257946859799919: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1303618031863949: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1471338801678548: replay keep/65 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.15x vs account baseline (hook score 0.50x; ctr score 1.40x; cpm_efficiency score 0.92x; click_to_lpv score 1.08x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1471818274365238: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1510442940714267: replay keep/65 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.30x vs account baseline (hook score 0.50x; ctr score 1.60x; cpm_efficiency score 1.28x; click_to_lpv score 0.97x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1521733932924068: replay test_more/40 vs snapshot null/null; replay reason "[quality-only weak] Upper/mid-funnel score 0.66x vs account baseline (hook score 0.50x; ctr score 0.91x; cpm_efficiency score 0.50x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1540476307413620: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1572249944256651: replay keep/40 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.01x vs account baseline (ctr score 1.13x; cpm_efficiency score 0.86x; click_to_lpv score 1.03x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Silveristic 2026-07-03 creative 1575801273494328: replay diagnose/40 vs snapshot null/null; replay reason "Checkout breakdown: ATC-to-IC 0.00% vs account baseline 12.15%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1023001666791831: replay test_more/44 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.79x vs account baseline (hook score 2.00x; ctr score 0.90x; cpm_efficiency score 0.50x; atc_to_ic score 0.62x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1033214469106065: replay diagnose/45 vs snapshot null/null; replay reason "[quality-only] checkout bottleneck detected before profit evaluation: IC-to-purchase 20.00% vs account baseline 21.82%. Do not judge the creative as a sales loser until this step is checked.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1134586805526549: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1257946859799919: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1303618031863949: replay test_more/40 vs snapshot null/null; replay reason "[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1471338801678548: replay keep/65 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.17x vs account baseline (hook score 0.50x; ctr score 1.38x; cpm_efficiency score 0.91x; click_to_lpv score 1.09x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1471818274365238: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1510442940714267: replay keep/65 vs snapshot null/null; replay reason "[quality-only strong] Upper/mid-funnel score 1.32x vs account baseline (hook score 0.50x; ctr score 1.59x; cpm_efficiency score 1.28x; click_to_lpv score 0.96x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1521733932924068: replay test_more/40 vs snapshot null/null; replay reason "[quality-only weak] Upper/mid-funnel score 0.66x vs account baseline (hook score 0.50x; ctr score 0.90x; cpm_efficiency score 0.50x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1540476307413620: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1572249944256651: replay test_more/51 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.92x vs account baseline (ctr score 1.29x; cpm_efficiency score 0.87x; click_to_lpv score 1.03x; lpv_to_atc score 0.89x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- Silveristic 2026-07-04 creative 1575801273494328: replay diagnose/40 vs snapshot null/null; replay reason "Checkout breakdown: ATC-to-IC 0.00% vs account baseline 12.15%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1000844809459077: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.78 (28d) = 35% of target after $711 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1002443442283933: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $100 < $141 loss-budget floor, 0 purchases, age 19d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1007048011875307: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $678 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1008302678413358: replay keep/50 vs snapshot null/null; replay reason "[demote candidate] ROAS 1.27 (28d) = 58% of target — above account bottom quartile (39%) but below breakeven (1.71 = 78% of target) at $502 mature spend — consider demote to test placement or refresh creative concept.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1014356057726711: replay keep/50 vs snapshot null/null; replay reason "[weak zone] ROAS 0.93 (28d) = 42% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1018252307526601: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $31 < $141 loss-budget floor, 0 purchases, age 19d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1023264806904899: replay diagnose/55 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 46.15% vs account baseline 50.00%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1023932563648623: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $141 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1030352566602424: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $141 loss-budget floor, 0 purchases) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1031796332841133: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.48 (28d) = 22% of target after $312 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1033614439176557: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $19 < $141 loss-budget floor, 0 purchases, age 19d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1111657292040172: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1000844809459077: replay keep/60 vs snapshot null/null; replay reason "[demote candidate] ROAS 1.00 (28d) = 45% of target — above account bottom quartile (39%) but below breakeven (1.71 = 78% of target) at $725 mature spend — consider demote to test placement or refresh creative concept.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1002443442283933: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $86 < $140 loss-budget floor, 0 purchases, age 20d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1007048011875307: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $721 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1008302678413358: replay keep/50 vs snapshot null/null; replay reason "[demote candidate] ROAS 1.39 (28d) = 63% of target — above account bottom quartile (39%) but below breakeven (1.71 = 78% of target) at $458 mature spend — consider demote to test placement or refresh creative concept.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1014356057726711: replay keep/50 vs snapshot null/null; replay reason "[weak zone] ROAS 0.93 (28d) = 42% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1018252307526601: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $31 < $140 loss-budget floor, 0 purchases, age 20d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1023264806904899: replay diagnose/55 vs snapshot null/null; replay reason "Landing page issue: Link-to-LPV 46.15% vs account baseline 50.00%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1023932563648623: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $140 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1030352566602424: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $6 < $140 loss-budget floor, 0 purchases) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1031796332841133: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.48 (28d) = 22% of target after $312 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1033614439176557: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $15 < $140 loss-budget floor, 0 purchases, age 20d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1293016656251330: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $31 < $140 loss-budget floor, 0 purchases, age 21d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1042376994660818: replay test_more/55 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 1.83 (28d) = 52% of target after $322 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1053498142940351: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $6 < $107 loss-budget floor, 0 purchases, age 14d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1116501586972225: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $16 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1124168746317341: replay test_more/55 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 1.95 (28d) = 56% of target after $459 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1137243591241158: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1178789597502548: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $48 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1181134667483485: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $107 loss-budget floor, 0 purchases, age 14d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1182354087394020: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $53 < $107 loss-budget floor, 1 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1185432376938133: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $2 < $107 loss-budget floor, 0 purchases, age 25d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1233113425673369: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $14 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1233220061966018: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-03 creative 1237623548179791: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1042376994660818: replay test_more/55 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 1.83 (28d) = 52% of target after $322 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1053498142940351: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $6 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1116501586972225: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $14 < $107 loss-budget floor, 0 purchases, age 16d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1124168746317341: replay test_more/55 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 2.19 (28d) = 62% of target after $408 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready))", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1137243591241158: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $6 < $107 loss-budget floor, 0 purchases, age 16d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1178789597502548: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $48 < $107 loss-budget floor, 0 purchases, age 16d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1181134667483485: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1182354087394020: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $47 < $107 loss-budget floor, 1 purchases, age 16d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1185432376938133: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $1 < $107 loss-budget floor, 0 purchases, age 26d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1233113425673369: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $12 < $107 loss-budget floor, 0 purchases, age 16d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1233220061966018: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $107 loss-budget floor, 0 purchases, age 16d) — let the creative accumulate signal.", snapshot reason "null".
- Tiles Workshop 2026-07-04 creative 1237623548179791: replay test_more/55 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $107 loss-budget floor, 0 purchases, age 16d) — let the creative accumulate signal.", snapshot reason "null".
- Vornom 2026-07-03 creative 1020768527549028: replay test_more/40 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.83x vs account baseline (hook score 0.77x; ctr score 1.44x; cpm_efficiency score 0.50x; click_to_lpv score 0.66x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- Vornom 2026-07-03 creative 1052280054449931: replay test_more/44 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.98x vs account baseline (hook score 1.11x; ctr score 0.50x; cpm_efficiency score 2.00x; click_to_lpv score 0.58x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- Vornom 2026-07-03 creative 1068520515515581: replay test_more/65 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.90x vs account baseline (hook score 0.50x; ctr score 1.01x; cpm_efficiency score 1.17x; click_to_lpv score 0.99x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- Vornom 2026-07-03 creative 1213490407486500: replay diagnose/40 vs snapshot null/null; replay reason "Delivery issue: active creative has verified 0 spend and 0 impressions in the latest daily delivery window; inspect ad, ad set, campaign, budget, audience, and learning constraints before judging creative performance.", snapshot reason "null".
- Vornom 2026-07-03 creative 1249540987094718: replay keep/55 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.11x vs account baseline (hook score 0.79x; ctr score 0.73x; cpm_efficiency score 1.10x; click_to_lpv score 0.99x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-03 creative 1258933613045907: replay keep/64 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.28x vs account baseline (hook score 1.33x; ctr score 0.50x; cpm_efficiency score 1.73x; click_to_lpv score 1.13x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-03 creative 1286573629509612: replay keep/63 vs snapshot null/null; replay reason "[quality-only strong] Upper/mid-funnel score 1.45x vs account baseline (hook score 0.50x; ctr score 0.99x; cpm_efficiency score 0.90x; click_to_lpv score 0.90x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-03 creative 1340554338140232: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_AWARENESS.", snapshot reason "null".
- Vornom 2026-07-03 creative 1370044211804963: replay keep/65 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.12x vs account baseline (hook score 1.26x; ctr score 0.99x; cpm_efficiency score 1.04x; click_to_lpv score 1.21x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-03 creative 1437835607584666: replay test_more/53 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.89x vs account baseline (hook score 0.50x; ctr score 0.92x; cpm_efficiency score 2.00x; click_to_lpv score 0.80x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- Vornom 2026-07-03 creative 1443857737094759: replay test_more/53 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.83x vs account baseline (hook score 1.19x; ctr score 0.50x; cpm_efficiency score 1.47x; click_to_lpv score 0.94x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- Vornom 2026-07-03 creative 1452182979458051: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_AWARENESS.", snapshot reason "null".
- Vornom 2026-07-04 creative 1020768527549028: replay keep/60 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.03x vs account baseline (hook score 0.97x; ctr score 1.04x; cpm_efficiency score 0.55x; click_to_lpv score 1.11x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-04 creative 1052280054449931: replay keep/61 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.22x vs account baseline (hook score 1.24x; ctr score 0.50x; cpm_efficiency score 2.00x; click_to_lpv score 1.05x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-04 creative 1068520515515581: replay test_more/65 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.90x vs account baseline (hook score 0.50x; ctr score 1.00x; cpm_efficiency score 1.18x; click_to_lpv score 1.00x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- Vornom 2026-07-04 creative 1213490407486500: replay test_more/53 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.70x vs account baseline (hook score 0.50x; ctr score 0.53x; cpm_efficiency score 0.72x; click_to_lpv score 1.15x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- Vornom 2026-07-04 creative 1249540987094718: replay keep/55 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.10x vs account baseline (hook score 0.79x; ctr score 0.72x; cpm_efficiency score 1.11x; click_to_lpv score 0.99x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-04 creative 1258933613045907: replay keep/65 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.29x vs account baseline (hook score 1.32x; ctr score 0.50x; cpm_efficiency score 1.74x; click_to_lpv score 1.13x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-04 creative 1286573629509612: replay keep/63 vs snapshot null/null; replay reason "[quality-only strong] Upper/mid-funnel score 1.45x vs account baseline (hook score 0.50x; ctr score 0.99x; cpm_efficiency score 0.90x; click_to_lpv score 0.90x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-04 creative 1340554338140232: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_AWARENESS.", snapshot reason "null".
- Vornom 2026-07-04 creative 1370044211804963: replay keep/65 vs snapshot null/null; replay reason "[quality-only above_average] Upper/mid-funnel score 1.10x vs account baseline (hook score 1.26x; ctr score 1.01x; cpm_efficiency score 1.04x; click_to_lpv score 1.21x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.", snapshot reason "null".
- Vornom 2026-07-04 creative 1437835607584666: replay test_more/53 vs snapshot null/null; replay reason "[quality-only neutral] Upper/mid-funnel score 0.89x vs account baseline (hook score 0.50x; ctr score 0.92x; cpm_efficiency score 2.00x; click_to_lpv score 0.80x). No hard action until profit target or stronger funnel separation exists.", snapshot reason "null".
- Vornom 2026-07-04 creative 1443857737094759: replay test_more/53 vs snapshot null/null; replay reason "[quality-only below_average] Upper/mid-funnel score 0.83x vs account baseline (hook score 1.19x; ctr score 0.50x; cpm_efficiency score 1.48x; click_to_lpv score 0.94x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.", snapshot reason "null".
- Vornom 2026-07-04 creative 1452182979458051: replay out_of_scope/60 vs snapshot null/null; replay reason "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_AWARENESS.", snapshot reason "null".

## Decision Stability (Hysteresis Simulation)

Epoch: clean_epoch_per_business_at_start_date. Raw = engine output before stabilization; published = label after hard-boundary two-evaluation confirmation.

| Metric | Raw | Published | Change |
|---|---:|---:|---:|
| Hard-boundary transitions | 116 | 118 | 1.7% |
| Hard reversals within 3 obs | 36 | 23 | -36.1% |

Raw period-2 round-trips (A->B->A): 20. Published period-2 round-trips are structurally zero by hysteresis construction and are NOT reported as evidence; the reversal metric above is period-agnostic and fair to both streams.

Suppressed days: 73 (resolutions: confirmed: 59, reverted: 12, changed_again: 2). confirmed/reverted are next-calendar-day evidence only; gap_return/exited_universe/replay_end are broken out and carry no next-day claim.
Cut delays: 64 suppressed days, next-day exposure 3,610.36. Scale delays: 9 suppressed days, next-day exposure 269.25. Exposure = next adjacent day's spend under historical operator policy; non-causal.

Matched suppressed-day scoring (identical forward windows, only the label differs - primary hold-vs-flip evidence):
| Window | Suppressed | Scored | Hold right | Flip right | Neutral/unknown | Open window |
|---:|---:|---:|---:|---:|---:|---:|
| 7d | 73 | 73 | 15 | 27 | 31 | 0 |
| 14d | 73 | 73 | 10 | 28 | 35 | 0 |

Per business:
| Business | Obs | Raw hard transitions | Published hard transitions | Raw reversals<=3 | Published reversals<=3 | Suppressed days | Resolutions | Cut-delay next-day spend |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Adsecute Demo | 0 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| Bilsem Zeka | 3956 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| BskTR | 1138 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| ColorFullWorldsTR | 1086 | 8 | 4 | 4 | 1 | 5 | reverted: 3, confirmed: 2 | 0.00 |
| EMOLOS | 4283 | 22 | 26 | 5 | 1 | 16 | confirmed: 13, reverted: 3 | 184.64 |
| Enise | 0 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| Grandmix | 2579 | 18 | 22 | 6 | 6 | 13 | confirmed: 11, reverted: 2 | 38.63 |
| Halıcızade | 1935 | 9 | 6 | 4 | 1 | 5 | confirmed: 3, changed_again: 2 | 2,313.23 |
| IwaStore | 1993 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| IwaTR | 2191 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| Silveristic | 1226 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| TheSwaf | 6267 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| Tiles Workshop | 5353 | 59 | 60 | 17 | 14 | 34 | confirmed: 30, reverted: 4 | 1,073.86 |
| Vornom | 1525 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |

Raw vs published outcome cells (SECONDARY context only: episode re-segmentation anchors confirmed transitions one day later and censors unknowns differently per stream, so these cells are not a like-for-like comparison - use the matched table above for hold-vs-flip claims):
| Window | Label | Class | Raw episodes | Raw known | Raw unknown (zero-spend) | Raw positive rate | Published episodes | Published known | Published unknown (zero-spend) | Published positive rate |
|---:|---|---|---:|---:|---|---:|---:|---:|---|---:|
| 7 | cut | hard | 54 | 38 | 16 (16) | 55.3% | 32 | 28 | 4 (4) | 60.7% |
| 7 | scale | hard | 9 | 9 | 0 (0) | 55.6% | 6 | 6 | 0 (0) | 66.7% |
| 7 | diagnose | non_hard | 357 | 186 | 171 (33) | 79.0% | 357 | 186 | 171 (33) | 79.0% |
| 7 | keep | non_hard | 246 | 201 | 45 (45) | 71.6% | 272 | 213 | 59 (59) | 71.8% |
| 7 | out_of_scope | non_hard | 207 | 0 | 207 (68) | - | 207 | 0 | 207 (68) | - |
| 7 | test_more | non_hard | 1423 | 716 | 707 (435) | 88.8% | 1421 | 716 | 705 (433) | 88.8% |
| 14 | cut | hard | 54 | 38 | 16 (16) | 57.9% | 32 | 28 | 4 (4) | 60.7% |
| 14 | scale | hard | 9 | 9 | 0 (0) | 55.6% | 6 | 6 | 0 (0) | 66.7% |
| 14 | diagnose | non_hard | 294 | 159 | 135 (31) | 76.1% | 294 | 159 | 135 (31) | 76.1% |
| 14 | keep | non_hard | 214 | 176 | 38 (38) | 65.3% | 240 | 188 | 52 (52) | 64.4% |
| 14 | out_of_scope | non_hard | 186 | 0 | 186 (66) | - | 186 | 0 | 186 (66) | - |
| 14 | test_more | non_hard | 1291 | 646 | 645 (411) | 86.7% | 1289 | 646 | 643 (409) | 86.7% |

Suppression samples (first 40):
| Business | Date | Creative | Held | Raw | Resolution | As-of spend |
|---|---|---|---|---|---|---:|
| ColorFullWorldsTR | 2026-06-12 | 1369446851662907 | keep | scale | reverted | 7.42 |
| ColorFullWorldsTR | 2026-06-18 | 1369446851662907 | keep | scale | reverted | 15.31 |
| ColorFullWorldsTR | 2026-06-01 | 1636437490809810 | keep | cut | confirmed | - |
| ColorFullWorldsTR | 2026-06-01 | 1696918907975404 | keep | cut | confirmed | - |
| ColorFullWorldsTR | 2026-06-06 | 1696918907975404 | keep | cut | reverted | - |
| EMOLOS | 2026-06-01 | 1323544629737422 | keep | cut | confirmed | 41.50 |
| EMOLOS | 2026-06-01 | 1365577345392907 | keep | cut | reverted | 23.35 |
| EMOLOS | 2026-06-05 | 1365577345392907 | keep | cut | reverted | - |
| EMOLOS | 2026-06-07 | 1365577345392907 | keep | cut | confirmed | - |
| EMOLOS | 2026-06-12 | 1466459534601098 | keep | cut | confirmed | - |
| EMOLOS | 2026-06-01 | 1619630062596638 | keep | cut | confirmed | - |
| EMOLOS | 2026-06-01 | 1899500230707112 | keep | cut | confirmed | 9.54 |
| EMOLOS | 2026-06-01 | 2256567028449909 | keep | cut | confirmed | 36.30 |
| EMOLOS | 2026-06-01 | 2846119509068113 | keep | cut | confirmed | - |
| EMOLOS | 2026-06-01 | 854440610396270 | keep | cut | confirmed | - |
| EMOLOS | 2026-06-01 | 864212896711133 | keep | cut | confirmed | 27.47 |
| EMOLOS | 2026-06-01 | 907464492353856 | keep | cut | confirmed | - |
| EMOLOS | 2026-06-12 | 910165658712484 | keep | cut | confirmed | - |
| EMOLOS | 2026-06-02 | 962418690099350 | keep | cut | confirmed | 43.06 |
| EMOLOS | 2026-06-13 | 971834475468970 | keep | cut | reverted | - |
| EMOLOS | 2026-06-01 | 989873033626399 | keep | cut | confirmed | - |
| Grandmix | 2026-06-01 | 1199888448810753 | keep | cut | confirmed | - |
| Grandmix | 2026-06-05 | 1301214195548874 | keep | scale | reverted | 1.05 |
| Grandmix | 2026-06-07 | 1301214195548874 | keep | scale | confirmed | 15.27 |
| Grandmix | 2026-06-07 | 1337092034931256 | keep | cut | reverted | 12.38 |
| Grandmix | 2026-06-01 | 1479802413878502 | keep | cut | confirmed | - |
| Grandmix | 2026-06-01 | 1598668524564962 | keep | cut | confirmed | - |
| Grandmix | 2026-06-01 | 2227936340946323 | keep | cut | confirmed | - |
| Grandmix | 2026-06-01 | 26793283900312957 | keep | cut | confirmed | - |
| Grandmix | 2026-06-01 | 3248297215341499 | keep | scale | confirmed | 29.44 |
| Grandmix | 2026-06-05 | 3248297215341499 | keep | scale | confirmed | 25.95 |
| Grandmix | 2026-06-01 | 693776863669477 | keep | cut | confirmed | 18.56 |
| Grandmix | 2026-06-07 | 693776863669477 | keep | cut | confirmed | 22.81 |
| Grandmix | 2026-06-01 | 903459306039600 | keep | cut | confirmed | - |
| Halıcızade | 2026-06-09 | 1177415824013359 | keep | cut | confirmed | 856.10 |
| Halıcızade | 2026-06-14 | 1524605835227107 | keep | cut | changed_again | 1,579.44 |
| Halıcızade | 2026-06-16 | 1524605835227107 | keep | cut | confirmed | 1,577.19 |
| Halıcızade | 2026-06-01 | 2266855037160102 | keep | cut | confirmed | - |
| Halıcızade | 2026-06-14 | 2266855037160102 | keep | cut | changed_again | - |
| Tiles Workshop | 2026-06-01 | 1042376994660818 | keep | cut | confirmed | 11.13 |

## Outcome Episode Summary

`open_window` is not `unknown`: open means the 7d/14d forward window has not closed by 2026-07-05. `unknown` means the window is closed but the classifier cannot infer outcome, most commonly zero forward spend or missing target. Precision/missed-opportunity proxy below is episode-deduped, not daily-row counted.

| Business | Window | Label | Class | Open rows | Closed daily rows | Episodes | Known | Unknown | Positive | Negative | Neutral | Zero-forward unknown | Positive rate known | Reliability |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Bilsem Zeka | 7 | diagnose | non_hard | 13 | 68 | 56 | 55 | 1 | 41 | 0 | 14 | 1 | 74.6% | defensible |
| Bilsem Zeka | 7 | keep | non_hard | 51 | 198 | 37 | 33 | 4 | 27 | 0 | 6 | 4 | 81.8% | defensible |
| Bilsem Zeka | 7 | out_of_scope | non_hard | 341 | 1466 | 140 | 0 | 140 | 0 | 0 | 0 | 32 | - | insufficient |
| Bilsem Zeka | 7 | test_more | non_hard | 327 | 1492 | 170 | 160 | 10 | 133 | 0 | 27 | 10 | 83.1% | defensible |
| Bilsem Zeka | 14 | diagnose | non_hard | 18 | 63 | 51 | 50 | 1 | 42 | 0 | 8 | 1 | 84.0% | defensible |
| Bilsem Zeka | 14 | keep | non_hard | 98 | 151 | 29 | 26 | 3 | 19 | 0 | 7 | 3 | 73.1% | directional |
| Bilsem Zeka | 14 | out_of_scope | non_hard | 706 | 1101 | 119 | 0 | 119 | 0 | 0 | 0 | 31 | - | insufficient |
| Bilsem Zeka | 14 | test_more | non_hard | 713 | 1106 | 148 | 138 | 10 | 110 | 0 | 28 | 10 | 79.7% | defensible |
| BskTR | 7 | diagnose | non_hard | 18 | 5 | 4 | 0 | 4 | 0 | 0 | 0 | 0 | - | insufficient |
| BskTR | 7 | keep | non_hard | 15 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| BskTR | 7 | out_of_scope | non_hard | 119 | 455 | 18 | 0 | 18 | 0 | 0 | 0 | 3 | - | insufficient |
| BskTR | 7 | test_more | non_hard | 79 | 447 | 23 | 0 | 23 | 0 | 0 | 0 | 8 | - | insufficient |
| BskTR | 14 | diagnose | non_hard | 18 | 5 | 4 | 0 | 4 | 0 | 0 | 0 | 0 | - | insufficient |
| BskTR | 14 | keep | non_hard | 15 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| BskTR | 14 | out_of_scope | non_hard | 238 | 336 | 18 | 0 | 18 | 0 | 0 | 0 | 2 | - | insufficient |
| BskTR | 14 | test_more | non_hard | 190 | 336 | 22 | 0 | 22 | 0 | 0 | 0 | 7 | - | insufficient |
| ColorFullWorldsTR | 7 | cut | hard | 0 | 16 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | - | insufficient |
| ColorFullWorldsTR | 7 | scale | hard | 0 | 2 | 2 | 2 | 0 | 1 | 1 | 0 | 0 | 50.0% | insufficient |
| ColorFullWorldsTR | 7 | diagnose | non_hard | 17 | 67 | 20 | 18 | 2 | 14 | 0 | 4 | 2 | 77.8% | directional |
| ColorFullWorldsTR | 7 | keep | non_hard | 19 | 81 | 11 | 11 | 0 | 6 | 0 | 5 | 0 | 54.5% | directional |
| ColorFullWorldsTR | 7 | test_more | non_hard | 114 | 770 | 55 | 29 | 26 | 26 | 0 | 3 | 26 | 89.7% | directional |
| ColorFullWorldsTR | 14 | cut | hard | 0 | 16 | 2 | 0 | 2 | 0 | 0 | 0 | 2 | - | insufficient |
| ColorFullWorldsTR | 14 | scale | hard | 0 | 2 | 2 | 2 | 0 | 1 | 1 | 0 | 0 | 50.0% | insufficient |
| ColorFullWorldsTR | 14 | diagnose | non_hard | 26 | 58 | 18 | 17 | 1 | 11 | 0 | 6 | 1 | 64.7% | directional |
| ColorFullWorldsTR | 14 | keep | non_hard | 46 | 54 | 8 | 8 | 0 | 5 | 0 | 3 | 0 | 62.5% | insufficient |
| ColorFullWorldsTR | 14 | test_more | non_hard | 232 | 652 | 52 | 28 | 24 | 22 | 0 | 6 | 24 | 78.6% | directional |
| EMOLOS | 7 | cut | hard | 0 | 153 | 12 | 6 | 6 | 6 | 0 | 0 | 6 | 100.0% | insufficient |
| EMOLOS | 7 | diagnose | non_hard | 3 | 41 | 10 | 9 | 1 | 7 | 0 | 2 | 1 | 77.8% | insufficient |
| EMOLOS | 7 | keep | non_hard | 59 | 355 | 27 | 18 | 9 | 17 | 0 | 1 | 9 | 94.4% | directional |
| EMOLOS | 7 | test_more | non_hard | 561 | 3111 | 191 | 99 | 92 | 97 | 0 | 2 | 92 | 98.0% | defensible |
| EMOLOS | 14 | cut | hard | 0 | 153 | 12 | 6 | 6 | 6 | 0 | 0 | 6 | 100.0% | insufficient |
| EMOLOS | 14 | diagnose | non_hard | 4 | 40 | 9 | 8 | 1 | 6 | 0 | 2 | 1 | 75.0% | insufficient |
| EMOLOS | 14 | keep | non_hard | 140 | 274 | 24 | 15 | 9 | 13 | 0 | 2 | 9 | 86.7% | directional |
| EMOLOS | 14 | test_more | non_hard | 1296 | 2376 | 188 | 97 | 91 | 95 | 0 | 2 | 91 | 97.9% | defensible |
| Grandmix | 7 | cut | hard | 0 | 55 | 9 | 3 | 6 | 1 | 2 | 0 | 6 | 33.3% | insufficient |
| Grandmix | 7 | scale | hard | 0 | 9 | 4 | 4 | 0 | 2 | 2 | 0 | 0 | 50.0% | insufficient |
| Grandmix | 7 | diagnose | non_hard | 62 | 179 | 26 | 23 | 3 | 18 | 0 | 5 | 3 | 78.3% | directional |
| Grandmix | 7 | keep | non_hard | 77 | 367 | 35 | 29 | 6 | 18 | 0 | 11 | 6 | 62.1% | directional |
| Grandmix | 7 | test_more | non_hard | 463 | 1367 | 146 | 76 | 70 | 60 | 0 | 16 | 70 | 79.0% | defensible |
| Grandmix | 14 | cut | hard | 0 | 55 | 9 | 3 | 6 | 1 | 0 | 2 | 6 | 33.3% | insufficient |
| Grandmix | 14 | scale | hard | 0 | 9 | 4 | 4 | 0 | 2 | 2 | 0 | 0 | 50.0% | insufficient |
| Grandmix | 14 | diagnose | non_hard | 119 | 122 | 20 | 17 | 3 | 11 | 0 | 6 | 3 | 64.7% | directional |
| Grandmix | 14 | keep | non_hard | 156 | 288 | 31 | 25 | 6 | 16 | 0 | 9 | 6 | 64.0% | directional |
| Grandmix | 14 | test_more | non_hard | 679 | 1151 | 104 | 37 | 67 | 25 | 0 | 12 | 67 | 67.6% | defensible |
| Halıcızade | 7 | cut | hard | 0 | 14 | 4 | 3 | 1 | 2 | 1 | 0 | 1 | 66.7% | insufficient |
| Halıcızade | 7 | diagnose | non_hard | 0 | 5 | 2 | 1 | 1 | 1 | 0 | 0 | 1 | 100.0% | insufficient |
| Halıcızade | 7 | keep | non_hard | 7 | 22 | 2 | 1 | 1 | 0 | 0 | 1 | 1 | 0.0% | insufficient |
| Halıcızade | 7 | out_of_scope | non_hard | 0 | 28 | 7 | 0 | 7 | 0 | 0 | 0 | 7 | - | insufficient |
| Halıcızade | 7 | test_more | non_hard | 496 | 1363 | 74 | 36 | 38 | 36 | 0 | 0 | 38 | 100.0% | defensible |
| Halıcızade | 14 | cut | hard | 0 | 14 | 4 | 3 | 1 | 2 | 1 | 0 | 1 | 66.7% | insufficient |
| Halıcızade | 14 | diagnose | non_hard | 0 | 5 | 2 | 1 | 1 | 0 | 0 | 1 | 1 | 0.0% | insufficient |
| Halıcızade | 14 | keep | non_hard | 14 | 15 | 2 | 1 | 1 | 0 | 0 | 1 | 1 | 0.0% | insufficient |
| Halıcızade | 14 | out_of_scope | non_hard | 0 | 28 | 7 | 0 | 7 | 0 | 0 | 0 | 7 | - | insufficient |
| Halıcızade | 14 | test_more | non_hard | 723 | 1136 | 74 | 36 | 38 | 34 | 0 | 2 | 38 | 94.4% | defensible |
| IwaStore | 7 | diagnose | non_hard | 72 | 131 | 27 | 25 | 2 | 24 | 0 | 1 | 2 | 96.0% | directional |
| IwaStore | 7 | keep | non_hard | 61 | 195 | 15 | 15 | 0 | 11 | 0 | 4 | 0 | 73.3% | directional |
| IwaStore | 7 | out_of_scope | non_hard | 40 | 172 | 7 | 0 | 7 | 0 | 0 | 0 | 2 | - | insufficient |
| IwaStore | 7 | test_more | non_hard | 372 | 950 | 59 | 39 | 20 | 39 | 0 | 0 | 20 | 100.0% | defensible |
| IwaStore | 14 | diagnose | non_hard | 114 | 89 | 18 | 17 | 1 | 16 | 0 | 1 | 1 | 94.1% | directional |
| IwaStore | 14 | keep | non_hard | 108 | 148 | 12 | 12 | 0 | 7 | 0 | 5 | 0 | 58.3% | directional |
| IwaStore | 14 | out_of_scope | non_hard | 82 | 130 | 7 | 0 | 7 | 0 | 0 | 0 | 2 | - | insufficient |
| IwaStore | 14 | test_more | non_hard | 586 | 736 | 55 | 36 | 19 | 34 | 0 | 2 | 19 | 94.4% | defensible |
| IwaTR | 7 | diagnose | non_hard | 29 | 105 | 45 | 0 | 45 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaTR | 7 | keep | non_hard | 112 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaTR | 7 | out_of_scope | non_hard | 0 | 4 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| IwaTR | 7 | test_more | non_hard | 366 | 1575 | 111 | 0 | 111 | 0 | 0 | 0 | 11 | - | insufficient |
| IwaTR | 14 | diagnose | non_hard | 57 | 77 | 34 | 0 | 34 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaTR | 14 | keep | non_hard | 112 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaTR | 14 | out_of_scope | non_hard | 0 | 4 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| IwaTR | 14 | test_more | non_hard | 744 | 1197 | 97 | 0 | 97 | 0 | 0 | 0 | 6 | - | insufficient |
| Silveristic | 7 | diagnose | non_hard | 19 | 13 | 4 | 0 | 4 | 0 | 0 | 0 | 1 | - | insufficient |
| Silveristic | 7 | keep | non_hard | 17 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| Silveristic | 7 | out_of_scope | non_hard | 63 | 342 | 25 | 0 | 25 | 0 | 0 | 0 | 18 | - | insufficient |
| Silveristic | 7 | test_more | non_hard | 125 | 647 | 40 | 0 | 40 | 0 | 0 | 0 | 16 | - | insufficient |
| Silveristic | 14 | diagnose | non_hard | 27 | 5 | 3 | 0 | 3 | 0 | 0 | 0 | 1 | - | insufficient |
| Silveristic | 14 | keep | non_hard | 17 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| Silveristic | 14 | out_of_scope | non_hard | 126 | 279 | 25 | 0 | 25 | 0 | 0 | 0 | 18 | - | insufficient |
| Silveristic | 14 | test_more | non_hard | 287 | 485 | 40 | 0 | 40 | 0 | 0 | 0 | 16 | - | insufficient |
| TheSwaf | 7 | diagnose | non_hard | 24 | 297 | 36 | 15 | 21 | 12 | 0 | 3 | 21 | 80.0% | directional |
| TheSwaf | 7 | keep | non_hard | 164 | 553 | 51 | 37 | 14 | 31 | 0 | 6 | 14 | 83.8% | defensible |
| TheSwaf | 7 | out_of_scope | non_hard | 0 | 6 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| TheSwaf | 7 | test_more | non_hard | 631 | 4592 | 246 | 135 | 111 | 114 | 0 | 21 | 111 | 84.4% | defensible |
| TheSwaf | 14 | diagnose | non_hard | 68 | 253 | 30 | 9 | 21 | 8 | 0 | 1 | 21 | 88.9% | insufficient |
| TheSwaf | 14 | keep | non_hard | 332 | 385 | 45 | 32 | 13 | 25 | 0 | 7 | 13 | 78.1% | defensible |
| TheSwaf | 14 | out_of_scope | non_hard | 0 | 6 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| TheSwaf | 14 | test_more | non_hard | 1469 | 3754 | 237 | 131 | 106 | 111 | 0 | 20 | 106 | 84.7% | defensible |
| Tiles Workshop | 7 | cut | hard | 0 | 182 | 27 | 26 | 1 | 12 | 8 | 6 | 1 | 46.2% | directional |
| Tiles Workshop | 7 | scale | hard | 0 | 21 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 66.7% | insufficient |
| Tiles Workshop | 7 | diagnose | non_hard | 0 | 163 | 41 | 40 | 1 | 30 | 0 | 10 | 1 | 75.0% | defensible |
| Tiles Workshop | 7 | keep | non_hard | 145 | 717 | 68 | 57 | 11 | 34 | 0 | 23 | 11 | 59.7% | defensible |
| Tiles Workshop | 7 | test_more | non_hard | 869 | 3256 | 172 | 142 | 30 | 131 | 0 | 11 | 30 | 92.3% | defensible |
| Tiles Workshop | 14 | cut | hard | 0 | 182 | 27 | 26 | 1 | 13 | 5 | 8 | 1 | 50.0% | directional |
| Tiles Workshop | 14 | scale | hard | 0 | 21 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 66.7% | insufficient |
| Tiles Workshop | 14 | diagnose | non_hard | 0 | 163 | 41 | 40 | 1 | 27 | 0 | 13 | 1 | 67.5% | defensible |
| Tiles Workshop | 14 | keep | non_hard | 319 | 543 | 63 | 57 | 6 | 30 | 0 | 27 | 6 | 52.6% | defensible |
| Tiles Workshop | 14 | test_more | non_hard | 1752 | 2373 | 167 | 143 | 24 | 129 | 0 | 14 | 24 | 90.2% | defensible |
| Vornom | 7 | diagnose | non_hard | 17 | 108 | 86 | 0 | 86 | 0 | 0 | 0 | 0 | - | insufficient |
| Vornom | 7 | keep | non_hard | 58 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| Vornom | 7 | out_of_scope | non_hard | 28 | 180 | 8 | 0 | 8 | 0 | 0 | 0 | 4 | - | insufficient |
| Vornom | 7 | test_more | non_hard | 196 | 938 | 136 | 0 | 136 | 0 | 0 | 0 | 3 | - | insufficient |
| Vornom | 14 | diagnose | non_hard | 43 | 82 | 64 | 0 | 64 | 0 | 0 | 0 | 0 | - | insufficient |
| Vornom | 14 | keep | non_hard | 58 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| Vornom | 14 | out_of_scope | non_hard | 66 | 142 | 8 | 0 | 8 | 0 | 0 | 0 | 4 | - | insufficient |
| Vornom | 14 | test_more | non_hard | 435 | 699 | 107 | 0 | 107 | 0 | 0 | 0 | 3 | - | insufficient |

## Confidence Alignment Smoke

Hard and non-hard rows are deliberately separated. For hard actions, positive means the hard action proxy was supported. For non-hard rows, positive means a missed hard-action opportunity proxy; it is not the same polarity and must not be pooled with hard precision.

| Business | Window | Class | Bucket | Episodes | Known | Positive | Observed positive | Avg confidence | Abs gap |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| Bilsem Zeka | 7 | non_hard | 50_59 | 2 | 1 | 1 | 100.0% | 55.0% | 45.0% |
| Bilsem Zeka | 7 | non_hard | 60_69 | 401 | 247 | 200 | 81.0% | 60.0% | 21.0% |
| Bilsem Zeka | 14 | non_hard | 50_59 | 2 | 1 | 1 | 100.0% | 55.0% | 45.0% |
| Bilsem Zeka | 14 | non_hard | 60_69 | 345 | 213 | 170 | 79.8% | 60.0% | 19.8% |
| BskTR | 7 | non_hard | 00_49 | 27 | 0 | 0 | - | - | - |
| BskTR | 7 | non_hard | 60_69 | 18 | 0 | 0 | - | - | - |
| BskTR | 14 | non_hard | 00_49 | 26 | 0 | 0 | - | - | - |
| BskTR | 14 | non_hard | 60_69 | 18 | 0 | 0 | - | - | - |
| ColorFullWorldsTR | 7 | hard | 60_69 | 2 | 0 | 0 | - | - | - |
| ColorFullWorldsTR | 7 | hard | 70_79 | 2 | 2 | 1 | 50.0% | 75.0% | 25.0% |
| ColorFullWorldsTR | 7 | non_hard | 00_49 | 1 | 0 | 0 | - | - | - |
| ColorFullWorldsTR | 7 | non_hard | 50_59 | 5 | 5 | 3 | 60.0% | 50.0% | 10.0% |
| ColorFullWorldsTR | 7 | non_hard | 60_69 | 18 | 16 | 11 | 68.8% | 60.0% | 8.8% |
| ColorFullWorldsTR | 7 | non_hard | 70_79 | 62 | 37 | 32 | 86.5% | 75.0% | 11.5% |
| ColorFullWorldsTR | 14 | hard | 60_69 | 2 | 0 | 0 | - | - | - |
| ColorFullWorldsTR | 14 | hard | 70_79 | 2 | 2 | 1 | 50.0% | 75.0% | 25.0% |
| ColorFullWorldsTR | 14 | non_hard | 00_49 | 1 | 0 | 0 | - | - | - |
| ColorFullWorldsTR | 14 | non_hard | 50_59 | 5 | 5 | 2 | 40.0% | 50.0% | 10.0% |
| ColorFullWorldsTR | 14 | non_hard | 60_69 | 10 | 10 | 8 | 80.0% | 60.0% | 20.0% |
| ColorFullWorldsTR | 14 | non_hard | 70_79 | 62 | 38 | 28 | 73.7% | 75.0% | 1.3% |
| EMOLOS | 7 | hard | 60_69 | 5 | 0 | 0 | - | - | - |
| EMOLOS | 7 | hard | 70_79 | 7 | 6 | 6 | 100.0% | 75.0% | 25.0% |
| EMOLOS | 7 | non_hard | 50_59 | 8 | 7 | 6 | 85.7% | 50.7% | 35.0% |
| EMOLOS | 7 | non_hard | 60_69 | 55 | 36 | 36 | 100.0% | 60.0% | 40.0% |
| EMOLOS | 7 | non_hard | 70_79 | 165 | 83 | 79 | 95.2% | 75.0% | 20.2% |
| EMOLOS | 14 | hard | 60_69 | 5 | 0 | 0 | - | - | - |
| EMOLOS | 14 | hard | 70_79 | 7 | 6 | 6 | 100.0% | 75.0% | 25.0% |
| EMOLOS | 14 | non_hard | 50_59 | 8 | 7 | 6 | 85.7% | 50.7% | 35.0% |
| EMOLOS | 14 | non_hard | 60_69 | 48 | 30 | 30 | 100.0% | 60.0% | 40.0% |
| EMOLOS | 14 | non_hard | 70_79 | 165 | 83 | 78 | 94.0% | 75.0% | 19.0% |
| Grandmix | 7 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| Grandmix | 7 | hard | 70_79 | 7 | 7 | 3 | 42.9% | 75.0% | 32.1% |
| Grandmix | 7 | non_hard | 50_59 | 19 | 17 | 12 | 70.6% | 54.1% | 16.5% |
| Grandmix | 7 | non_hard | 60_69 | 74 | 61 | 50 | 82.0% | 60.0% | 22.0% |
| Grandmix | 7 | non_hard | 70_79 | 114 | 50 | 34 | 68.0% | 74.6% | 6.6% |
| Grandmix | 14 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| Grandmix | 14 | hard | 70_79 | 7 | 7 | 3 | 42.9% | 75.0% | 32.1% |
| Grandmix | 14 | non_hard | 50_59 | 14 | 12 | 6 | 50.0% | 53.8% | 3.8% |
| Grandmix | 14 | non_hard | 60_69 | 27 | 17 | 9 | 52.9% | 60.0% | 7.1% |
| Grandmix | 14 | non_hard | 70_79 | 114 | 50 | 37 | 74.0% | 74.6% | 0.6% |
| Halıcızade | 7 | hard | 70_79 | 4 | 3 | 2 | 66.7% | 75.0% | 8.3% |
| Halıcızade | 7 | non_hard | 50_59 | 1 | 0 | 0 | - | - | - |
| Halıcızade | 7 | non_hard | 60_69 | 8 | 0 | 0 | - | - | - |
| Halıcızade | 7 | non_hard | 70_79 | 76 | 38 | 37 | 97.4% | 75.0% | 22.4% |
| Halıcızade | 14 | hard | 70_79 | 4 | 3 | 2 | 66.7% | 75.0% | 8.3% |
| Halıcızade | 14 | non_hard | 50_59 | 1 | 0 | 0 | - | - | - |
| Halıcızade | 14 | non_hard | 60_69 | 8 | 0 | 0 | - | - | - |
| Halıcızade | 14 | non_hard | 70_79 | 76 | 38 | 34 | 89.5% | 75.0% | 14.5% |
| IwaStore | 7 | non_hard | 50_59 | 21 | 11 | 11 | 100.0% | 55.0% | 45.0% |
| IwaStore | 7 | non_hard | 60_69 | 87 | 68 | 63 | 92.7% | 60.0% | 32.6% |
| IwaStore | 14 | non_hard | 50_59 | 18 | 10 | 10 | 100.0% | 55.0% | 45.0% |
| IwaStore | 14 | non_hard | 60_69 | 74 | 55 | 47 | 85.5% | 60.0% | 25.4% |
| IwaTR | 7 | non_hard | 00_49 | 156 | 0 | 0 | - | - | - |
| IwaTR | 7 | non_hard | 60_69 | 1 | 0 | 0 | - | - | - |
| IwaTR | 14 | non_hard | 00_49 | 131 | 0 | 0 | - | - | - |
| IwaTR | 14 | non_hard | 60_69 | 1 | 0 | 0 | - | - | - |
| Silveristic | 7 | non_hard | 00_49 | 44 | 0 | 0 | - | - | - |
| Silveristic | 7 | non_hard | 60_69 | 25 | 0 | 0 | - | - | - |
| Silveristic | 14 | non_hard | 00_49 | 43 | 0 | 0 | - | - | - |
| Silveristic | 14 | non_hard | 60_69 | 25 | 0 | 0 | - | - | - |
| TheSwaf | 7 | non_hard | 00_49 | 1 | 0 | 0 | - | - | - |
| TheSwaf | 7 | non_hard | 50_59 | 66 | 11 | 11 | 100.0% | 55.0% | 45.0% |
| TheSwaf | 7 | non_hard | 60_69 | 267 | 176 | 146 | 83.0% | 60.0% | 22.9% |
| TheSwaf | 14 | non_hard | 00_49 | 1 | 0 | 0 | - | - | - |
| TheSwaf | 14 | non_hard | 50_59 | 64 | 9 | 9 | 100.0% | 55.0% | 45.0% |
| TheSwaf | 14 | non_hard | 60_69 | 248 | 163 | 135 | 82.8% | 60.0% | 22.8% |
| Tiles Workshop | 7 | hard | 70_79 | 30 | 29 | 14 | 48.3% | 75.0% | 26.7% |
| Tiles Workshop | 7 | non_hard | 00_49 | 3 | 0 | 0 | - | - | - |
| Tiles Workshop | 7 | non_hard | 50_59 | 28 | 25 | 15 | 60.0% | 50.0% | 10.0% |
| Tiles Workshop | 7 | non_hard | 60_69 | 42 | 17 | 17 | 100.0% | 60.0% | 40.0% |
| Tiles Workshop | 7 | non_hard | 70_79 | 208 | 197 | 163 | 82.7% | 75.0% | 7.8% |
| Tiles Workshop | 14 | hard | 70_79 | 30 | 29 | 15 | 51.7% | 75.0% | 23.3% |
| Tiles Workshop | 14 | non_hard | 50_59 | 25 | 25 | 12 | 48.0% | 50.0% | 2.0% |
| Tiles Workshop | 14 | non_hard | 60_69 | 38 | 17 | 17 | 100.0% | 60.0% | 40.0% |
| Tiles Workshop | 14 | non_hard | 70_79 | 208 | 198 | 157 | 79.3% | 75.0% | 4.3% |
| Vornom | 7 | non_hard | 00_49 | 222 | 0 | 0 | - | - | - |
| Vornom | 7 | non_hard | 60_69 | 8 | 0 | 0 | - | - | - |
| Vornom | 14 | non_hard | 00_49 | 171 | 0 | 0 | - | - | - |
| Vornom | 14 | non_hard | 60_69 | 8 | 0 | 0 | - | - | - |

## Confidence By Label And Source Mode

This is the deeper calibration table requested after the multi-window review. It keeps business, surfaced action label, outcome window, confidence bucket, and replay source-mode separate. Positive polarity is listed explicitly because hard labels and non-hard labels do not mean the same thing.

| Business | Window | Source mode | Label | Class | Bucket | Episodes | Known | Unknown | Positive | Negative | Neutral | Observed positive | Avg confidence | Abs gap | Reliability | Positive meaning |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| Bilsem Zeka | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 56 | 55 | 1 | 41 | 0 | 14 | 74.6% | 60.0% | 14.5% | defensible | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 7 | runtime_sql_fallback | test_more | non_hard | 50_59 | 2 | 1 | 1 | 1 | 0 | 0 | 100.0% | 55.0% | 45.0% | insufficient | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 168 | 159 | 9 | 132 | 0 | 27 | 83.0% | 60.0% | 23.0% | defensible | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 37 | 33 | 4 | 27 | 0 | 6 | 81.8% | 60.0% | 21.8% | defensible | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 140 | 0 | 140 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 14 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 51 | 50 | 1 | 42 | 0 | 8 | 84.0% | 60.0% | 24.0% | defensible | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 14 | runtime_sql_fallback | test_more | non_hard | 50_59 | 2 | 1 | 1 | 1 | 0 | 0 | 100.0% | 55.0% | 45.0% | insufficient | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 14 | runtime_sql_fallback | test_more | non_hard | 60_69 | 146 | 137 | 9 | 109 | 0 | 28 | 79.6% | 60.0% | 19.6% | defensible | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 29 | 26 | 3 | 19 | 0 | 7 | 73.1% | 60.0% | 13.1% | directional | non_hard_missed_hard_action_proxy |
| Bilsem Zeka | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 119 | 0 | 119 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| BskTR | 7 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 4 | 0 | 4 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| BskTR | 7 | runtime_sql_fallback | test_more | non_hard | 00_49 | 23 | 0 | 23 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| BskTR | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 18 | 0 | 18 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| BskTR | 14 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 4 | 0 | 4 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| BskTR | 14 | runtime_sql_fallback | test_more | non_hard | 00_49 | 22 | 0 | 22 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| BskTR | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 18 | 0 | 18 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | cut | hard | 60_69 | 2 | 0 | 2 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | scale | hard | 70_79 | 2 | 2 | 0 | 1 | 1 | 0 | 50.0% | 75.0% | 25.0% | insufficient | hard_action_supported |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 5 | 5 | 0 | 3 | 0 | 2 | 60.0% | 50.0% | 10.0% | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 3 | 2 | 1 | 1 | 0 | 1 | 50.0% | 60.0% | 10.0% | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 11 | 11 | 0 | 10 | 0 | 1 | 90.9% | 75.0% | 15.9% | directional | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 11 | 10 | 1 | 8 | 0 | 2 | 80.0% | 60.0% | 20.0% | directional | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 44 | 19 | 25 | 18 | 0 | 1 | 94.7% | 75.0% | 19.7% | directional | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 4 | 4 | 0 | 2 | 0 | 2 | 50.0% | 60.0% | 10.0% | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 7 | 7 | 0 | 4 | 0 | 3 | 57.1% | 75.0% | 17.9% | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | cut | hard | 60_69 | 2 | 0 | 2 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | scale | hard | 70_79 | 2 | 2 | 0 | 1 | 1 | 0 | 50.0% | 75.0% | 25.0% | insufficient | hard_action_supported |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 5 | 5 | 0 | 2 | 0 | 3 | 40.0% | 50.0% | 10.0% | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 1 | 1 | 0 | 1 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 11 | 11 | 0 | 8 | 0 | 3 | 72.7% | 75.0% | 2.3% | directional | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | test_more | non_hard | 60_69 | 8 | 8 | 0 | 6 | 0 | 2 | 75.0% | 60.0% | 15.0% | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 44 | 20 | 24 | 16 | 0 | 4 | 80.0% | 75.0% | 5.0% | directional | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 1 | 1 | 0 | 1 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| ColorFullWorldsTR | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 7 | 7 | 0 | 4 | 0 | 3 | 57.1% | 75.0% | 17.9% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | cut | hard | 60_69 | 5 | 0 | 5 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| EMOLOS | 7 | runtime_sql_fallback | cut | hard | 70_79 | 7 | 6 | 1 | 6 | 0 | 0 | 100.0% | 75.0% | 25.0% | insufficient | hard_action_supported |
| EMOLOS | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 8 | 7 | 1 | 6 | 0 | 1 | 85.7% | 50.7% | 35.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 1 | 1 | 0 | 1 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% | 75.0% | 75.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 41 | 31 | 10 | 31 | 0 | 0 | 100.0% | 60.0% | 40.0% | defensible | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 150 | 68 | 82 | 66 | 0 | 2 | 97.1% | 75.0% | 22.1% | defensible | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 13 | 4 | 9 | 4 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 14 | 14 | 0 | 13 | 0 | 1 | 92.9% | 75.0% | 17.9% | directional | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | cut | hard | 60_69 | 5 | 0 | 5 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| EMOLOS | 14 | runtime_sql_fallback | cut | hard | 70_79 | 7 | 6 | 1 | 6 | 0 | 0 | 100.0% | 75.0% | 25.0% | insufficient | hard_action_supported |
| EMOLOS | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 8 | 7 | 1 | 6 | 0 | 1 | 85.7% | 50.7% | 35.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% | 75.0% | 75.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | test_more | non_hard | 60_69 | 38 | 29 | 9 | 29 | 0 | 0 | 100.0% | 60.0% | 40.0% | directional | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 150 | 68 | 82 | 66 | 0 | 2 | 97.1% | 75.0% | 22.1% | defensible | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 10 | 1 | 9 | 1 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 14 | 14 | 0 | 12 | 0 | 2 | 85.7% | 75.0% | 10.7% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | cut | hard | 60_69 | 6 | 0 | 6 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| Grandmix | 7 | runtime_sql_fallback | cut | hard | 70_79 | 3 | 3 | 0 | 1 | 2 | 0 | 33.3% | 75.0% | 41.7% | insufficient | hard_action_supported |
| Grandmix | 7 | runtime_sql_fallback | scale | hard | 70_79 | 4 | 4 | 0 | 2 | 2 | 0 | 50.0% | 75.0% | 25.0% | insufficient | hard_action_supported |
| Grandmix | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 19 | 17 | 2 | 12 | 0 | 5 | 70.6% | 54.1% | 16.5% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 2 | 2 | 0 | 2 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 5 | 4 | 1 | 4 | 0 | 0 | 100.0% | 70.0% | 30.0% | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 52 | 45 | 7 | 39 | 0 | 6 | 86.7% | 60.0% | 26.7% | defensible | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 94 | 31 | 63 | 21 | 0 | 10 | 67.7% | 75.0% | 7.3% | defensible | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 20 | 14 | 6 | 9 | 0 | 5 | 64.3% | 60.0% | 4.3% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 15 | 15 | 0 | 9 | 0 | 6 | 60.0% | 75.0% | 15.0% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | cut | hard | 60_69 | 6 | 0 | 6 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| Grandmix | 14 | runtime_sql_fallback | cut | hard | 70_79 | 3 | 3 | 0 | 1 | 0 | 2 | 33.3% | 75.0% | 41.7% | insufficient | hard_action_supported |
| Grandmix | 14 | runtime_sql_fallback | scale | hard | 70_79 | 4 | 4 | 0 | 2 | 2 | 0 | 50.0% | 75.0% | 25.0% | insufficient | hard_action_supported |
| Grandmix | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 14 | 12 | 2 | 6 | 0 | 6 | 50.0% | 53.8% | 3.8% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 1 | 1 | 0 | 1 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 5 | 4 | 1 | 4 | 0 | 0 | 100.0% | 70.0% | 30.0% | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | test_more | non_hard | 60_69 | 10 | 6 | 4 | 4 | 0 | 2 | 66.7% | 60.0% | 6.7% | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 94 | 31 | 63 | 21 | 0 | 10 | 67.7% | 75.0% | 7.3% | defensible | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 16 | 10 | 6 | 4 | 0 | 6 | 40.0% | 60.0% | 20.0% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 15 | 15 | 0 | 12 | 0 | 3 | 80.0% | 75.0% | 5.0% | directional | non_hard_missed_hard_action_proxy |
| Halıcızade | 7 | runtime_sql_fallback | cut | hard | 70_79 | 4 | 3 | 1 | 2 | 1 | 0 | 66.7% | 75.0% | 8.3% | insufficient | hard_action_supported |
| Halıcızade | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 1 | 1 | 0 | 1 | 0 | 0 | 100.0% | 75.0% | 25.0% | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 74 | 36 | 38 | 36 | 0 | 0 | 100.0% | 75.0% | 25.0% | defensible | non_hard_missed_hard_action_proxy |
| Halıcızade | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% | 75.0% | 75.0% | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 7 | 0 | 7 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 14 | runtime_sql_fallback | cut | hard | 70_79 | 4 | 3 | 1 | 2 | 1 | 0 | 66.7% | 75.0% | 8.3% | insufficient | hard_action_supported |
| Halıcızade | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% | 75.0% | 75.0% | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 74 | 36 | 38 | 34 | 0 | 2 | 94.4% | 75.0% | 19.4% | defensible | non_hard_missed_hard_action_proxy |
| Halıcızade | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% | 75.0% | 75.0% | insufficient | non_hard_missed_hard_action_proxy |
| Halıcızade | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 7 | 0 | 7 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 13 | 11 | 2 | 11 | 0 | 0 | 100.0% | 55.0% | 45.0% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 14 | 14 | 0 | 13 | 0 | 1 | 92.9% | 60.0% | 32.9% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | test_more | non_hard | 50_59 | 8 | 0 | 8 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 51 | 39 | 12 | 39 | 0 | 0 | 100.0% | 60.0% | 40.0% | defensible | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 15 | 15 | 0 | 11 | 0 | 4 | 73.3% | 60.0% | 13.3% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 7 | 0 | 7 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 10 | 9 | 1 | 9 | 0 | 0 | 100.0% | 55.0% | 45.0% | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 8 | 8 | 0 | 7 | 0 | 1 | 87.5% | 60.0% | 27.5% | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | test_more | non_hard | 50_59 | 8 | 1 | 7 | 1 | 0 | 0 | 100.0% | 55.0% | 45.0% | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | test_more | non_hard | 60_69 | 47 | 35 | 12 | 33 | 0 | 2 | 94.3% | 60.0% | 34.3% | defensible | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 12 | 12 | 0 | 7 | 0 | 5 | 58.3% | 60.0% | 1.7% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 7 | 0 | 7 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaTR | 7 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 45 | 0 | 45 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaTR | 7 | runtime_sql_fallback | test_more | non_hard | 00_49 | 111 | 0 | 111 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaTR | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaTR | 14 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 34 | 0 | 34 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaTR | 14 | runtime_sql_fallback | test_more | non_hard | 00_49 | 97 | 0 | 97 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaTR | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Silveristic | 7 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 4 | 0 | 4 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Silveristic | 7 | runtime_sql_fallback | test_more | non_hard | 00_49 | 40 | 0 | 40 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Silveristic | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 25 | 0 | 25 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Silveristic | 14 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 3 | 0 | 3 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Silveristic | 14 | runtime_sql_fallback | test_more | non_hard | 00_49 | 40 | 0 | 40 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Silveristic | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 25 | 0 | 25 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 29 | 8 | 21 | 8 | 0 | 0 | 100.0% | 55.0% | 45.0% | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 7 | 7 | 0 | 4 | 0 | 3 | 57.1% | 60.0% | 2.9% | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | test_more | non_hard | 50_59 | 32 | 3 | 29 | 3 | 0 | 0 | 100.0% | 55.0% | 45.0% | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 214 | 132 | 82 | 111 | 0 | 21 | 84.1% | 60.0% | 24.1% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | keep | non_hard | 00_49 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | keep | non_hard | 50_59 | 5 | 0 | 5 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 45 | 37 | 8 | 31 | 0 | 6 | 83.8% | 60.0% | 23.8% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 27 | 6 | 21 | 6 | 0 | 0 | 100.0% | 55.0% | 45.0% | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 3 | 3 | 0 | 2 | 0 | 1 | 66.7% | 60.0% | 6.7% | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | test_more | non_hard | 50_59 | 32 | 3 | 29 | 3 | 0 | 0 | 100.0% | 55.0% | 45.0% | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | test_more | non_hard | 60_69 | 205 | 128 | 77 | 108 | 0 | 20 | 84.4% | 60.0% | 24.4% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | keep | non_hard | 00_49 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | keep | non_hard | 50_59 | 5 | 0 | 5 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 39 | 32 | 7 | 25 | 0 | 7 | 78.1% | 60.0% | 18.1% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | cut | hard | 70_79 | 27 | 26 | 1 | 12 | 8 | 6 | 46.2% | 75.0% | 28.8% | directional | hard_action_supported |
| Tiles Workshop | 7 | runtime_sql_fallback | scale | hard | 70_79 | 3 | 3 | 0 | 2 | 1 | 0 | 66.7% | 75.0% | 8.3% | insufficient | hard_action_supported |
| Tiles Workshop | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 25 | 25 | 0 | 15 | 0 | 10 | 60.0% | 50.0% | 10.0% | directional | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 3 | 2 | 1 | 2 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 13 | 13 | 0 | 13 | 0 | 0 | 100.0% | 75.0% | 25.0% | directional | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | test_more | non_hard | 50_59 | 3 | 0 | 3 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 29 | 12 | 17 | 12 | 0 | 0 | 100.0% | 60.0% | 40.0% | directional | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 140 | 130 | 10 | 119 | 0 | 11 | 91.5% | 75.0% | 16.6% | defensible | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | keep | non_hard | 00_49 | 3 | 0 | 3 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 10 | 3 | 7 | 3 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 55 | 54 | 1 | 31 | 0 | 23 | 57.4% | 75.0% | 17.6% | defensible | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 14 | runtime_sql_fallback | cut | hard | 70_79 | 27 | 26 | 1 | 13 | 5 | 8 | 50.0% | 75.0% | 25.0% | directional | hard_action_supported |
| Tiles Workshop | 14 | runtime_sql_fallback | scale | hard | 70_79 | 3 | 3 | 0 | 2 | 1 | 0 | 66.7% | 75.0% | 8.3% | insufficient | hard_action_supported |
| Tiles Workshop | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 25 | 25 | 0 | 12 | 0 | 13 | 48.0% | 50.0% | 2.0% | directional | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 14 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 3 | 2 | 1 | 2 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 13 | 13 | 0 | 13 | 0 | 0 | 100.0% | 75.0% | 25.0% | directional | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 14 | runtime_sql_fallback | test_more | non_hard | 60_69 | 27 | 12 | 15 | 12 | 0 | 0 | 100.0% | 60.0% | 40.0% | directional | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 140 | 131 | 9 | 117 | 0 | 14 | 89.3% | 75.0% | 14.3% | defensible | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 8 | 3 | 5 | 3 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| Tiles Workshop | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 55 | 54 | 1 | 27 | 0 | 27 | 50.0% | 75.0% | 25.0% | defensible | non_hard_missed_hard_action_proxy |
| Vornom | 7 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 86 | 0 | 86 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Vornom | 7 | runtime_sql_fallback | test_more | non_hard | 00_49 | 136 | 0 | 136 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Vornom | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 8 | 0 | 8 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Vornom | 14 | runtime_sql_fallback | diagnose | non_hard | 00_49 | 64 | 0 | 64 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Vornom | 14 | runtime_sql_fallback | test_more | non_hard | 00_49 | 107 | 0 | 107 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Vornom | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 8 | 0 | 8 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |

## Replay Date Summary

| Date | Success businesses | Failed businesses | Decisions | Labels | Source modes |
|---|---:|---:|---:|---|---|
| 2026-06-01 | 14 | 0 | 1058 | test_more: 785, out_of_scope: 123, keep: 74, diagnose: 46, cut: 29, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-02 | 14 | 0 | 1071 | test_more: 793, out_of_scope: 127, keep: 71, diagnose: 48, cut: 30, scale: 2 | runtime_sql_fallback: 14 |
| 2026-06-03 | 14 | 0 | 1075 | test_more: 792, out_of_scope: 130, keep: 74, diagnose: 48, cut: 30, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-04 | 14 | 0 | 1084 | test_more: 799, out_of_scope: 133, keep: 82, diagnose: 40, cut: 29, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-05 | 14 | 0 | 1095 | test_more: 832, out_of_scope: 98, keep: 86, diagnose: 47, cut: 29, scale: 3 | runtime_sql_fallback: 14 |
| 2026-06-06 | 14 | 0 | 1103 | test_more: 844, keep: 89, out_of_scope: 86, diagnose: 54, cut: 28, scale: 2 | runtime_sql_fallback: 14 |
| 2026-06-07 | 14 | 0 | 1091 | test_more: 835, keep: 93, out_of_scope: 85, diagnose: 46, cut: 29, scale: 3 | runtime_sql_fallback: 14 |
| 2026-06-08 | 14 | 0 | 1058 | test_more: 805, keep: 94, out_of_scope: 83, diagnose: 46, cut: 27, scale: 3 | runtime_sql_fallback: 14 |
| 2026-06-09 | 14 | 0 | 1041 | test_more: 780, keep: 95, out_of_scope: 83, diagnose: 58, cut: 24, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-10 | 14 | 0 | 1039 | test_more: 781, keep: 97, out_of_scope: 87, diagnose: 49, cut: 24, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-11 | 14 | 0 | 1034 | test_more: 766, keep: 94, out_of_scope: 92, diagnose: 56, cut: 25, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-12 | 14 | 0 | 1013 | test_more: 750, keep: 92, out_of_scope: 90, diagnose: 53, cut: 26, scale: 2 | runtime_sql_fallback: 14 |
| 2026-06-13 | 14 | 0 | 989 | test_more: 724, keep: 94, out_of_scope: 90, diagnose: 55, cut: 25, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-14 | 14 | 0 | 1025 | test_more: 760, keep: 95, out_of_scope: 92, diagnose: 53, cut: 24, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-15 | 14 | 0 | 995 | test_more: 758, out_of_scope: 92, keep: 88, diagnose: 43, cut: 11, scale: 3 | runtime_sql_fallback: 14 |
| 2026-06-16 | 14 | 0 | 949 | test_more: 704, out_of_scope: 89, keep: 87, diagnose: 51, cut: 15, scale: 3 | runtime_sql_fallback: 14 |
| 2026-06-17 | 14 | 0 | 927 | test_more: 687, keep: 90, out_of_scope: 89, diagnose: 44, cut: 15, scale: 2 | runtime_sql_fallback: 14 |
| 2026-06-18 | 14 | 0 | 909 | test_more: 690, keep: 93, out_of_scope: 91, diagnose: 34, scale: 1 | runtime_sql_fallback: 14 |
| 2026-06-19 | 14 | 0 | 930 | test_more: 723, keep: 91, out_of_scope: 86, diagnose: 30 | runtime_sql_fallback: 14 |
| 2026-06-20 | 14 | 0 | 922 | test_more: 713, keep: 90, out_of_scope: 90, diagnose: 29 | runtime_sql_fallback: 14 |
| 2026-06-21 | 14 | 0 | 891 | test_more: 680, out_of_scope: 90, keep: 89, diagnose: 32 | runtime_sql_fallback: 14 |
| 2026-06-22 | 14 | 0 | 882 | test_more: 673, keep: 91, out_of_scope: 91, diagnose: 27 | runtime_sql_fallback: 14 |
| 2026-06-23 | 14 | 0 | 878 | test_more: 669, keep: 92, out_of_scope: 89, diagnose: 28 | runtime_sql_fallback: 14 |
| 2026-06-24 | 14 | 0 | 873 | test_more: 661, out_of_scope: 91, keep: 89, diagnose: 32 | runtime_sql_fallback: 14 |
| 2026-06-25 | 14 | 0 | 839 | test_more: 629, out_of_scope: 92, keep: 90, diagnose: 28 | runtime_sql_fallback: 14 |
| 2026-06-26 | 14 | 0 | 836 | test_more: 618, keep: 92, out_of_scope: 87, diagnose: 39 | runtime_sql_fallback: 14 |
| 2026-06-27 | 14 | 0 | 824 | test_more: 617, out_of_scope: 88, keep: 85, diagnose: 34 | runtime_sql_fallback: 14 |
| 2026-06-28 | 14 | 0 | 852 | test_more: 640, keep: 91, out_of_scope: 89, diagnose: 32 | runtime_sql_fallback: 14 |
| 2026-06-29 | 14 | 0 | 838 | test_more: 637, keep: 87, out_of_scope: 84, diagnose: 30 | runtime_sql_fallback: 14 |
| 2026-06-30 | 14 | 0 | 839 | test_more: 639, out_of_scope: 84, keep: 78, diagnose: 38 | runtime_sql_fallback: 14 |
| 2026-07-01 | 14 | 0 | 835 | test_more: 632, keep: 85, out_of_scope: 84, diagnose: 34 | runtime_sql_fallback: 14 |
| 2026-07-02 | 14 | 0 | 922 | test_more: 718, keep: 86, out_of_scope: 85, diagnose: 33 | runtime_sql_fallback: 14 |
| 2026-07-03 | 14 | 0 | 921 | test_more: 643, keep: 147, out_of_scope: 83, diagnose: 48 | runtime_sql_fallback: 14 |
| 2026-07-04 | 14 | 0 | 937 | test_more: 655, keep: 152, out_of_scope: 85, diagnose: 45 | runtime_sql_fallback: 14 |
| 2026-07-05 | 14 | 0 | 957 | test_more: 675, keep: 150, out_of_scope: 86, diagnose: 46 | runtime_sql_fallback: 14 |

## Business Samples

### Adsecute Demo


### Bilsem Zeka

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1008704841683230 | test_more | null | 55 | null | Below commercial maturity (28d spend $6,344 < $7,622 loss-budget floor, 1 purchases, age 17d) — let the creative accumulate signal. | null |
| 1013268184911193 | test_more | null | 60 | null | Below commercial maturity (28d spend $2,110 < $7,622 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1023072616831733 | keep | null | 60 | null | [weak target] ROAS 2.78 (28d) just above breakeven (93% of target) — keep observing; consider tightening if recent 7d weakens. | null |
| 1030506112969508 | test_more | null | 60 | null | Below commercial maturity (28d spend $3,859 < $7,622 loss-budget floor, 1 purchases) — let the creative accumulate signal. | null |
| 1044351044928169 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_ENGAGEMENT. | null |
| 1151248610534669 | keep | null | 60 | null | [near scale] ROAS 3.79 (28d) approaching scale threshold (126%) — needs $7,622+ spend or 3+ purchases for full scale. | null |
| 1167086666488357 | out_of_scope | null | 60 | null | Creative runs in lead adsets; purchase decision engine does not evaluate it. | null |
| 1201616515475332 | test_more | null | 60 | null | Below commercial maturity (28d spend $325 < $7,622 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1201772688835593 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_LEADS. | null |
| 1212323447586489 | keep | null | 60 | null | [near scale, soft-only] ROAS 3.96 (28d) = 132% of target 3.00 with 12 purchases (28d) and recent 7d holding at 8.10 — scale the ad set budget. (Reason for soft mode: threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1219831126816285 | out_of_scope | null | 60 | null | Creative runs in unknown adsets; purchase decision engine does not evaluate it. | null |
| 1275971854641276 | out_of_scope | null | 60 | null | Creative runs in unknown adsets; purchase decision engine does not evaluate it. | null |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-05 | 14 | 2418076021999784 | keep | positive | non_hard_missed_scale_opportunity | 6,531.75 | 98,170.83 | 4.20 |
| 2026-06-02 | 14 | 2418076021999784 | test_more | positive | non_hard_missed_scale_opportunity | 1,811.74 | 81,340.10 | 4.13 |
| 2026-06-05 | 7 | 2418076021999784 | keep | positive | non_hard_missed_scale_opportunity | 6,531.75 | 48,610.59 | 4.03 |
| 2026-06-16 | 14 | 1167086666488357 | test_more | positive | non_hard_missed_cut_opportunity | 1,909.75 | 47,246.14 | 0.72 |
| 2026-06-19 | 14 | 1167086666488357 | test_more | positive | non_hard_missed_cut_opportunity | 3,030.56 | 47,041.20 | 0.72 |
| 2026-06-14 | 14 | 1167086666488357 | test_more | positive | non_hard_missed_cut_opportunity | 1,649.88 | 41,964.27 | 0.33 |
| 2026-06-02 | 7 | 2418076021999784 | test_more | positive | non_hard_missed_scale_opportunity | 1,811.74 | 33,956.80 | 6.30 |
| 2026-06-21 | 14 | 27469336322660929 | test_more | positive | non_hard_missed_scale_opportunity | 3,919.39 | 31,790.84 | 7.05 |
| 2026-06-19 | 14 | 27469336322660929 | test_more | positive | non_hard_missed_scale_opportunity | 3,848.07 | 30,329.87 | 6.20 |
| 2026-06-18 | 14 | 27469336322660929 | diagnose | positive | non_hard_missed_scale_opportunity | 3,382.28 | 29,813.66 | 5.84 |
| 2026-06-12 | 14 | 1167086666488357 | test_more | positive | non_hard_missed_cut_opportunity | 1,367.82 | 27,700.39 | 0.51 |
| 2026-06-19 | 7 | 1167086666488357 | test_more | positive | non_hard_missed_cut_opportunity | 3,030.56 | 26,037.65 | 0.54 |

### BskTR

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1298865939017532 | keep | null | 40 | null | [quality-only above_average] Upper/mid-funnel score 1.22x vs account baseline (hook score 1.13x; ctr score 0.69x; cpm_efficiency score 1.78x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1301841691777176 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC. | null |
| 1320994476557693 | diagnose | null | 40 | null | Landing page issue: Link-to-LPV 31.47% vs account baseline 37.74%; Link-to-ATC 1.02% vs account baseline 1.61%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. | null |
| 1409617320900427 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC. | null |
| 1417831732911331 | keep | null | 65 | null | [quality-only above_average] Upper/mid-funnel score 1.03x vs account baseline (hook score 0.91x; ctr score 0.72x; cpm_efficiency score 1.89x; click_to_lpv score 0.88x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1475080064389055 | test_more | null | 40 | null | [quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action. | null |
| 1513543513755396 | keep | null | 40 | null | [quality-only above_average] Upper/mid-funnel score 1.12x vs account baseline (hook score 0.92x; ctr score 1.01x; cpm_efficiency score 1.32x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1521229436347382 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC. | null |
| 1636921507500503 | diagnose | null | 40 | null | Checkout breakdown: IC-to-purchase 20.00% vs account baseline 23.47%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. | null |
| 1643837866722652 | diagnose | null | 40 | null | Landing page issue: Link-to-LPV 31.71% vs account baseline 37.74%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. | null |
| 1665290848045267 | test_more | null | 40 | null | [quality-only neutral] Upper/mid-funnel score 0.95x vs account baseline (hook score 0.94x; ctr score 0.50x; cpm_efficiency score 1.31x; click_to_lpv score 1.02x). No hard action until profit target or stronger funnel separation exists. | null |
| 1803086350649085 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC. | null |


### ColorFullWorldsTR

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1030453132762286 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 2.43 (28d) = 61% of target after $629 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1032849702636102 | test_more | null | 55 | null | Below commercial maturity (28d spend $5 < $63 loss-budget floor, 0 purchases, age 11d) — let the creative accumulate signal. | null |
| 1122094770994342 | diagnose | null | 40 | null | Delivery status is unavailable; resolve the current ad, ad set, and campaign state before applying a performance action. | null |
| 1281394557535687 | test_more | null | 60 | null | Below commercial maturity (28d spend $3 < $63 loss-budget floor, 0 purchases) — let the creative accumulate signal. | null |
| 1350949346841523 | test_more | null | 60 | null | Below commercial maturity (28d spend $23 < $63 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1368337941819592 | test_more | null | 60 | null | Below commercial maturity (28d spend $5 < $63 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1369446851662907 | keep | null | 60 | null | [near scale] ROAS 5.28 (28d) above target (132%) — recent 7d ROAS 3.01 below target 4.00; observe. | null |
| 1422123969673979 | test_more | null | 55 | null | Below commercial maturity (28d spend $6 < $63 loss-budget floor, 0 purchases, age 11d) — let the creative accumulate signal. | null |
| 1498929587981582 | test_more | null | 60 | null | Below commercial maturity (28d spend $34 < $63 loss-budget floor, 2 purchases, age 0d) — let the creative accumulate signal. | null |
| 1534243521462061 | test_more | null | 60 | null | Below commercial maturity (28d spend $8 < $63 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1581834267283055 | test_more | null | 60 | null | Below commercial maturity (28d spend $60 < $63 loss-budget floor, 1 purchases, age 10d) — let the creative accumulate signal. | null |
| 1632090364761099 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 2.48 (28d) = 62% of target after $633 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-01 | 1636437490809810 | cut | null | 65 | 450.45 | 11 | 2.32 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 2.32 (28d) = 58% of target after $450 spend (28d) — clear loser at scale. |
| 2026-06-02 | 1636437490809810 | cut | null | 65 | 414.65 | 9 | 2.04 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 2.04 (28d) = 51% of target after $415 spend (28d) — clear loser at scale. |
| 2026-06-03 | 1636437490809810 | cut | null | 65 | 380.41 | 7 | 1.64 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 1.64 (28d) = 41% of target after $380 spend (28d) — clear loser at scale. |
| 2026-06-04 | 1636437490809810 | cut | null | 65 | 380.41 | 7 | 1.64 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 1.64 (28d) = 41% of target after $380 spend (28d) — clear loser at scale. |
| 2026-06-05 | 1636437490809810 | cut | null | 65 | 376.71 | 7 | 1.66 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 1.66 (28d) = 41% of target after $377 spend (28d) — clear loser at scale. |
| 2026-06-03 | 1696918907975404 | cut | null | 65 | 363.34 | 11 | 2.96 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 2.96 (28d) = 74% of target after $363 spend (28d) — clear loser at scale. |
| 2026-06-01 | 1696918907975404 | cut | null | 65 | 363.34 | 11 | 2.96 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 2.96 (28d) = 74% of target after $363 spend (28d) — clear loser at scale. |
| 2026-06-02 | 1696918907975404 | cut | null | 65 | 363.34 | 11 | 2.96 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 2.96 (28d) = 74% of target after $363 spend (28d) — clear loser at scale. |
| 2026-06-06 | 1636437490809810 | cut | null | 65 | 350.72 | 7 | 1.78 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 1.78 (28d) = 44% of target after $351 spend (28d) — clear loser at scale. |
| 2026-06-07 | 1636437490809810 | cut | null | 65 | 318.38 | 7 | 1.96 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 1.96 (28d) = 49% of target after $318 spend (28d) — clear loser at scale. |
| 2026-06-08 | 1636437490809810 | cut | null | 65 | 285.86 | 5 | 1.55 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 1.55 (28d) = 39% of target after $286 spend (28d) — clear loser at scale. |
| 2026-06-09 | 1636437490809810 | cut | null | 65 | 236.76 | 5 | 1.88 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 1.88 (28d) = 47% of target after $237 spend (28d) — clear loser at scale. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-03 | 14 | 1632090364761099 | keep | positive | non_hard_missed_cut_opportunity | 371.25 | 382.46 | 1.44 |
| 2026-06-07 | 14 | 2393918294462188 | diagnose | positive | non_hard_missed_cut_opportunity | 90.15 | 316.58 | 2.39 |
| 2026-06-09 | 7 | 1632090364761099 | diagnose | positive | non_hard_missed_cut_opportunity | 421.09 | 287.49 | 1.91 |
| 2026-06-27 | 7 | 1030453132762286 | test_more | positive | non_hard_missed_cut_opportunity | 408.79 | 254.23 | 1.54 |
| 2026-06-28 | 7 | 1030453132762286 | keep | positive | non_hard_missed_cut_opportunity | 453.93 | 238.76 | 1.11 |
| 2026-06-12 | 14 | 1369446851662907 | scale | positive | scale_held_above_target | 283.02 | 162.84 | 5.82 |
| 2026-06-13 | 14 | 1369446851662907 | keep | positive | non_hard_missed_scale_opportunity | 286.73 | 158.05 | 6.99 |
| 2026-06-18 | 14 | 1369446851662907 | scale | negative | scale_failed_recent_hold | 284.92 | 134.14 | 2.13 |
| 2026-06-19 | 14 | 1369446851662907 | keep | positive | non_hard_missed_cut_opportunity | 283.31 | 133.38 | 2.14 |
| 2026-06-01 | 7 | 1632090364761099 | diagnose | positive | non_hard_missed_scale_opportunity | 326.96 | 90.31 | 8.25 |
| 2026-06-02 | 14 | 776467862124288 | test_more | positive | non_hard_missed_cut_opportunity | 6.01 | 88.27 | 1.95 |
| 2026-06-12 | 7 | 1369446851662907 | scale | positive | scale_held_above_target | 283.02 | 81.60 | 10.04 |

### EMOLOS

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1000487319029766 | test_more | null | 55 | null | Below commercial maturity (28d spend $4 < $70 loss-budget floor, 0 purchases, age 16d) — let the creative accumulate signal. | null |
| 1005965712212138 | test_more | null | 60 | null | Below commercial maturity (28d spend $2 < $70 loss-budget floor, 0 purchases, age 22d) — let the creative accumulate signal. | null |
| 1007889655170360 | test_more | null | 60 | null | Below commercial maturity (28d spend $16 < $70 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1015151468123714 | test_more | null | 60 | null | Below commercial maturity (28d spend $10 < $70 loss-budget floor, 0 purchases, age 21d) — let the creative accumulate signal. | null |
| 1017459037607213 | keep | null | 50 | null | [weak zone] ROAS 0.86 (28d) = 35% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further. | null |
| 1027652930238244 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $87 spend (28d) — loss-budget maturity reached at $70; cut underperforming creative. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1055877293537375 | test_more | null | 60 | null | Below commercial maturity (28d spend $1 < $70 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1072760288625872 | test_more | null | 60 | null | Below commercial maturity (28d spend $26 < $70 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1236188488428719 | test_more | null | 55 | null | Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 18d) — let the creative accumulate signal. | null |
| 1292712935970318 | diagnose | null | 55 | null | Landing page issue: Link-to-LPV 17.94% vs account baseline 35.11%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. | null |
| 1300829758785189 | test_more | null | 60 | null | Below commercial maturity (28d spend $6 < $70 loss-budget floor, 0 purchases, age 22d) — let the creative accumulate signal. | null |
| 1305385024907982 | test_more | null | 60 | null | Below commercial maturity (28d spend $29 < $70 loss-budget floor, 0 purchases) — let the creative accumulate signal. | null |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-05 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable, confirm_kill | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-04 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable, confirm_kill | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-06 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable, confirm_kill | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-08 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable, confirm_kill | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-03 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable, confirm_kill | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-07 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable, confirm_kill | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-09 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable, confirm_kill | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-02 | 1323544629737422 | cut | null | 75 | 548.31 | 2 | 0.44 | lifecycle_unavailable, confirm_kill | ROAS 0.44 (28d) = 18% of target after $548 spend (28d) — clear loser at scale. |
| 2026-06-01 | 1323544629737422 | cut | null | 75 | 511.15 | 1 | 0.36 | lifecycle_unavailable | ROAS 0.36 (28d) = 14% of target after $511 spend (28d) — clear loser at scale. |
| 2026-06-06 | 962418690099350 | cut | null | 75 | 503.42 | 4 | 0.55 | lifecycle_unavailable, confirm_kill | ROAS 0.55 (28d) = 22% of target after $503 spend (28d) — clear loser at scale. |
| 2026-06-03 | 962418690099350 | cut | null | 75 | 503.42 | 4 | 0.55 | lifecycle_unavailable, confirm_kill | ROAS 0.55 (28d) = 22% of target after $503 spend (28d) — clear loser at scale. |
| 2026-06-04 | 962418690099350 | cut | null | 75 | 503.42 | 4 | 0.55 | lifecycle_unavailable, confirm_kill | ROAS 0.55 (28d) = 22% of target after $503 spend (28d) — clear loser at scale. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-03 | 14 | 1683734522755632 | test_more | positive | non_hard_missed_cut_opportunity | 23.61 | 1,175.02 | 0.69 |
| 2026-06-21 | 14 | 2114021279176127 | test_more | positive | non_hard_missed_cut_opportunity | 155.72 | 1,062.02 | 0.63 |
| 2026-06-20 | 14 | 2114021279176127 | keep | positive | non_hard_missed_cut_opportunity | 74.95 | 1,044.64 | 0.55 |
| 2026-06-19 | 14 | 2114021279176127 | test_more | positive | non_hard_missed_cut_opportunity | 9.66 | 1,037.38 | 0.61 |
| 2026-06-03 | 7 | 1683734522755632 | test_more | positive | non_hard_missed_cut_opportunity | 23.61 | 953.95 | 0.65 |
| 2026-06-19 | 14 | 882021054308247 | test_more | positive | non_hard_missed_cut_opportunity | 8.86 | 936.09 | 0.18 |
| 2026-06-05 | 14 | 1457831769435391 | keep | positive | non_hard_missed_cut_opportunity | 135.19 | 917.73 | 0.55 |
| 2026-06-05 | 14 | 1683734522755632 | keep | positive | non_hard_missed_cut_opportunity | 358.20 | 861.89 | 0.65 |
| 2026-06-05 | 7 | 1457831769435391 | keep | positive | non_hard_missed_cut_opportunity | 135.19 | 846.35 | 0.59 |
| 2026-06-05 | 14 | 2409619466182666 | keep | positive | non_hard_missed_cut_opportunity | 215.52 | 800.47 | 0.89 |
| 2026-06-05 | 7 | 1683734522755632 | keep | positive | non_hard_missed_cut_opportunity | 358.20 | 757.45 | 0.65 |
| 2026-06-05 | 7 | 2409619466182666 | keep | positive | non_hard_missed_cut_opportunity | 215.52 | 722.25 | 0.80 |

### Enise


### Grandmix

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1002617308929281 | test_more | null | 60 | null | Below commercial maturity (28d spend $11 < $262 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1003770772089284 | keep | null | 60 | null | [weak zone] ROAS 1.40 (28d) = 63% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further. | null |
| 1005337862441315 | test_more | null | 60 | null | Below commercial maturity (28d spend $5 < $262 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1008549465472004 | keep | null | 60 | null | [demote candidate] ROAS 1.33 (28d) = 61% of target — above account bottom quartile (46%) but below breakeven (1.80 = 82% of target) at $926 mature spend — consider demote to test placement or refresh creative concept. | null |
| 1009827774896101 | test_more | null | 60 | null | Below commercial maturity (28d spend $5 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1010946998578771 | test_more | null | 60 | null | Below commercial maturity (28d spend $58 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1012777161360911 | test_more | null | 60 | null | Below commercial maturity (28d spend $3 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1020070427050295 | test_more | null | 60 | null | Below commercial maturity (28d spend $15 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1024616573428480 | test_more | null | 60 | null | Below commercial maturity (28d spend $82 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1025822163460162 | keep | null | 60 | null | [weak target] ROAS 1.98 (28d) just above breakeven (90% of target) — keep observing; consider tightening if recent 7d weakens. | null |
| 1068268059100740 | test_more | null | 60 | null | Below commercial maturity (28d spend $16 < $262 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1186862256977827 | diagnose | null | 55 | null | Landing page issue: Link-to-ATC 0.18% vs account baseline 1.17%; LPV-to-ATC 0.22% vs account baseline 1.44%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. | null |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-07 | 1337092034931256 | cut | null | 75 | 1,017.99 | 4 | 0.92 | lifecycle_unavailable | ROAS 0.92 (28d) = 42% of target after $1,018 spend (28d) — clear loser at scale. |
| 2026-06-01 | 693776863669477 | cut | null | 75 | 387.34 | 2 | 0.85 | lifecycle_unavailable | ROAS 0.85 (28d) = 38% of target after $387 spend (28d) — loss-budget maturity reached at $265; cut underperforming creative. |
| 2026-06-02 | 693776863669477 | cut | null | 75 | 381.07 | 2 | 0.86 | lifecycle_unavailable | ROAS 0.86 (28d) = 39% of target after $381 spend (28d) — loss-budget maturity reached at $265; cut underperforming creative. |
| 2026-06-03 | 693776863669477 | cut | null | 75 | 374.83 | 2 | 0.88 | lifecycle_unavailable | ROAS 0.88 (28d) = 40% of target after $375 spend (28d) — loss-budget maturity reached at $266; cut underperforming creative. |
| 2026-06-04 | 693776863669477 | cut | null | 75 | 357.93 | 2 | 0.92 | lifecycle_unavailable | ROAS 0.92 (28d) = 42% of target after $358 spend (28d) — loss-budget maturity reached at $266; cut underperforming creative. |
| 2026-06-05 | 693776863669477 | cut | null | 75 | 342.96 | 2 | 0.96 | lifecycle_unavailable | ROAS 0.96 (28d) = 43% of target after $343 spend (28d) — loss-budget maturity reached at $267; cut underperforming creative. |
| 2026-06-08 | 693776863669477 | cut | null | 75 | 342.11 | 2 | 0.96 | lifecycle_unavailable | ROAS 0.96 (28d) = 44% of target after $342 spend (28d) — loss-budget maturity reached at $269; cut underperforming creative. |
| 2026-06-07 | 693776863669477 | cut | null | 75 | 334.93 | 2 | 0.98 | lifecycle_unavailable | ROAS 0.98 (28d) = 45% of target after $335 spend (28d) — loss-budget maturity reached at $267; cut underperforming creative. |
| 2026-06-01 | 2227936340946323 | cut | null | 65 | 1,452.26 | 5 | 0.54 | confirm_kill, missing_recent_data, lifecycle_unavailable | ROAS 0.54 (28d) = 25% of target after $1,452 spend (28d) — clear loser at scale. |
| 2026-06-02 | 2227936340946323 | cut | null | 65 | 1,452.26 | 5 | 0.54 | confirm_kill, missing_recent_data, lifecycle_unavailable | ROAS 0.54 (28d) = 25% of target after $1,452 spend (28d) — clear loser at scale. |
| 2026-06-03 | 2227936340946323 | cut | null | 65 | 1,452.26 | 5 | 0.54 | confirm_kill, missing_recent_data, lifecycle_unavailable | ROAS 0.54 (28d) = 25% of target after $1,452 spend (28d) — clear loser at scale. |
| 2026-06-04 | 2227936340946323 | cut | null | 65 | 1,452.26 | 5 | 0.54 | confirm_kill, missing_recent_data, lifecycle_unavailable | ROAS 0.54 (28d) = 25% of target after $1,452 spend (28d) — clear loser at scale. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-18 | 14 | 1337092034931256 | diagnose | positive | non_hard_missed_cut_opportunity | 963.81 | 1,360.78 | 0.20 |
| 2026-06-19 | 14 | 1337092034931256 | keep | positive | non_hard_missed_cut_opportunity | 979.58 | 1,331.35 | 0.21 |
| 2026-06-21 | 14 | 1337092034931256 | diagnose | positive | non_hard_missed_cut_opportunity | 996.93 | 1,256.50 | 0.13 |
| 2026-06-14 | 14 | 27134621589538352 | keep | positive | non_hard_missed_scale_opportunity | 281.59 | 605.25 | 4.72 |
| 2026-06-06 | 14 | 2533787297105379 | keep | positive | non_hard_missed_cut_opportunity | 274.91 | 579.50 | 0.98 |
| 2026-06-03 | 14 | 3248297215341499 | keep | positive | non_hard_missed_scale_opportunity | 503.89 | 534.39 | 3.73 |
| 2026-06-01 | 14 | 2533787297105379 | test_more | positive | non_hard_missed_cut_opportunity | 193.16 | 529.63 | 0.82 |
| 2026-06-01 | 14 | 3248297215341499 | scale | positive | scale_held_above_target | 498.26 | 526.17 | 3.79 |
| 2026-06-06 | 14 | 27134621589538352 | test_more | positive | non_hard_missed_scale_opportunity | 0.43 | 525.20 | 4.51 |
| 2026-06-05 | 14 | 3248297215341499 | scale | positive | scale_held_above_target | 506.57 | 515.97 | 3.37 |
| 2026-06-08 | 14 | 1337092034931256 | keep | positive | non_hard_missed_cut_opportunity | 998.58 | 483.58 | 0.81 |
| 2026-06-09 | 14 | 3248297215341499 | keep | positive | non_hard_missed_cut_opportunity | 582.55 | 476.22 | 0.70 |

### Halıcızade

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1003434722545007 | test_more | null | 60 | null | Below commercial maturity (28d spend $7 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1010914318351229 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1015362021206871 | test_more | null | 60 | null | Below commercial maturity (28d spend $4 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1016155387685429 | test_more | null | 60 | null | Below commercial maturity (28d spend $2 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1017320697689121 | test_more | null | 60 | null | Below commercial maturity (28d spend $161 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1017778567316723 | test_more | null | 60 | null | Below commercial maturity (28d spend $3 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1029804472879586 | test_more | null | 60 | null | Below commercial maturity (28d spend $275 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1029954866216939 | test_more | null | 60 | null | Below commercial maturity (28d spend $14 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1040413421673611 | test_more | null | 60 | null | Below commercial maturity (28d spend $1 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1046628518053014 | test_more | null | 60 | null | Below commercial maturity (28d spend $7 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1049503267758812 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $13,421 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1057121653536604 | test_more | null | 60 | null | Below commercial maturity (28d spend $65 < $13,421 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-10 | 1177415824013359 | cut | null | 75 | 18,854.60 | 2 | 2.41 | lifecycle_unavailable | ROAS 2.41 (28d) = 48% of target after $18,855 spend (28d) — loss-budget maturity reached at $17,748; cut underperforming creative. |
| 2026-06-09 | 1177415824013359 | cut | null | 75 | 17,885.02 | 2 | 2.54 | lifecycle_unavailable | ROAS 2.54 (28d) = 51% of target after $17,885 spend (28d) — loss-budget maturity reached at $17,581; cut underperforming creative. |
| 2026-06-17 | 1524605835227107 | cut | null | 75 | 17,731.21 | 0 | 0.00 | lifecycle_unavailable, confirm_kill | ROAS 0.00 (28d) = 0% of target after $17,731 spend (28d) — loss-budget maturity reached at $16,833; cut underperforming creative. |
| 2026-06-01 | 2266855037160102 | cut | null | 75 | 17,484.82 | 0 | 0.00 | lifecycle_unavailable, confirm_kill | ROAS 0.00 (28d) = 0% of target after $17,485 spend (28d) — loss-budget maturity reached at $15,586; cut underperforming creative. |
| 2026-06-16 | 1524605835227107 | cut | null | 75 | 17,445.93 | 0 | 0.00 | lifecycle_unavailable | ROAS 0.00 (28d) = 0% of target after $17,446 spend (28d) — loss-budget maturity reached at $16,833; cut underperforming creative. |
| 2026-06-14 | 1524605835227107 | cut | null | 75 | 17,198.19 | 0 | 0.00 | lifecycle_unavailable | ROAS 0.00 (28d) = 0% of target after $17,198 spend (28d) — loss-budget maturity reached at $17,017; cut underperforming creative. |
| 2026-06-04 | 2266855037160102 | cut | null | 65 | 17,484.82 | 0 | 0.00 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 0.00 (28d) = 0% of target after $17,485 spend (28d) — loss-budget maturity reached at $16,631; cut underperforming creative. |
| 2026-06-06 | 2266855037160102 | cut | null | 65 | 17,484.82 | 0 | 0.00 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 0.00 (28d) = 0% of target after $17,485 spend (28d) — loss-budget maturity reached at $17,183; cut underperforming creative. |
| 2026-06-07 | 2266855037160102 | cut | null | 65 | 17,484.82 | 0 | 0.00 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 0.00 (28d) = 0% of target after $17,485 spend (28d) — loss-budget maturity reached at $17,212; cut underperforming creative. |
| 2026-06-02 | 2266855037160102 | cut | null | 65 | 17,484.82 | 0 | 0.00 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 0.00 (28d) = 0% of target after $17,485 spend (28d) — loss-budget maturity reached at $15,823; cut underperforming creative. |
| 2026-06-03 | 2266855037160102 | cut | null | 65 | 17,484.82 | 0 | 0.00 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 0.00 (28d) = 0% of target after $17,485 spend (28d) — loss-budget maturity reached at $15,823; cut underperforming creative. |
| 2026-06-05 | 2266855037160102 | cut | null | 65 | 17,484.82 | 0 | 0.00 | lifecycle_unavailable, confirm_kill, missing_recent_data | ROAS 0.00 (28d) = 0% of target after $17,485 spend (28d) — loss-budget maturity reached at $17,183; cut underperforming creative. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-01 | 14 | 1177415824013359 | test_more | positive | non_hard_missed_cut_opportunity | 7,065.64 | 17,272.57 | 2.03 |
| 2026-06-09 | 14 | 1177415824013359 | cut | negative | cut_recovered_above_target | 17,885.02 | 10,180.82 | 15.42 |
| 2026-06-01 | 7 | 1177415824013359 | test_more | positive | non_hard_missed_cut_opportunity | 7,065.64 | 9,963.28 | 0.00 |
| 2026-06-01 | 14 | 1224042096434041 | test_more | positive | non_hard_missed_cut_opportunity | 753.35 | 8,980.62 | 0.56 |
| 2026-06-01 | 14 | 1524605835227107 | test_more | positive | non_hard_missed_cut_opportunity | 10,203.02 | 7,611.16 | 0.00 |
| 2026-06-01 | 14 | 1662334828217776 | test_more | positive | non_hard_missed_cut_opportunity | 10,042.34 | 6,710.03 | 0.00 |
| 2026-06-09 | 7 | 1177415824013359 | cut | negative | cut_recovered_above_target | 17,885.02 | 6,643.63 | 5.27 |
| 2026-06-01 | 7 | 1662334828217776 | test_more | positive | non_hard_missed_cut_opportunity | 10,042.34 | 6,440.97 | 0.00 |
| 2026-06-01 | 14 | 2166959420810529 | test_more | positive | non_hard_missed_cut_opportunity | 2,212.83 | 6,330.89 | 0.00 |
| 2026-06-01 | 14 | 1323544096366849 | test_more | positive | non_hard_missed_cut_opportunity | 9,295.15 | 6,111.69 | 0.00 |
| 2026-06-01 | 7 | 2166959420810529 | test_more | positive | non_hard_missed_cut_opportunity | 2,212.83 | 6,046.88 | 0.00 |
| 2026-06-01 | 14 | 4486561654913204 | test_more | positive | non_hard_missed_cut_opportunity | 5,838.04 | 5,896.80 | 0.00 |

### IwaStore

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1003444735733770 | test_more | null | 60 | null | Below commercial maturity (28d spend $7 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1016479011077401 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1020781523695732 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1025468773398763 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.82 (28d) = 23% of target after $276 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1028452980202623 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 1.94 (28d) = 56% of target after $150 spend (28d) — loss-budget maturity reached at $99; cut underperforming creative. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1033784855709309 | test_more | null | 60 | null | Below commercial maturity (28d spend $13 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1037962691982511 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal. | null |
| 1038055285394393 | test_more | null | 60 | null | Below commercial maturity (28d spend $51 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1038550568592146 | keep | null | 60 | null | [weak zone] ROAS 2.91 (28d) = 83% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further. | null |
| 1050560790774455 | test_more | null | 60 | null | Below commercial maturity (28d spend $4 < $99 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1157254709850013 | keep | null | 60 | null | [at target] ROAS 3.86 (28d) at/around target 3.50 (110%) — stable, let it run. | null |
| 1230828315767797 | out_of_scope | null | 60 | null | Creative runs in mid_funnel adsets; purchase decision engine does not evaluate it. | null |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-01 | 14 | 946471284944193 | keep | positive | non_hard_missed_scale_opportunity | 616.57 | 294.08 | 6.37 |
| 2026-06-01 | 7 | 931776873000095 | keep | positive | non_hard_missed_scale_opportunity | 1,044.90 | 124.70 | 4.57 |
| 2026-06-01 | 14 | 931776873000095 | keep | positive | non_hard_missed_scale_opportunity | 1,044.90 | 124.70 | 4.57 |
| 2026-06-01 | 7 | 946471284944193 | keep | positive | non_hard_missed_scale_opportunity | 616.57 | 111.07 | 12.09 |
| 2026-06-04 | 14 | 1157254709850013 | diagnose | positive | non_hard_missed_scale_opportunity | 219.73 | 105.39 | 5.76 |
| 2026-06-05 | 14 | 1157254709850013 | keep | positive | non_hard_missed_scale_opportunity | 220.54 | 101.34 | 5.37 |
| 2026-06-21 | 14 | 1655577498670460 | test_more | positive | non_hard_missed_scale_opportunity | 195.98 | 82.86 | 22.20 |
| 2026-06-01 | 14 | 1157254709850013 | keep | positive | non_hard_missed_scale_opportunity | 385.20 | 79.90 | 7.60 |
| 2026-06-01 | 14 | 1597946391493220 | keep | positive | non_hard_missed_cut_opportunity | 274.37 | 72.56 | 0.00 |
| 2026-06-22 | 7 | 931776873000095 | keep | positive | non_hard_missed_scale_opportunity | 381.58 | 71.72 | 8.84 |
| 2026-06-23 | 7 | 1655577498670460 | keep | positive | non_hard_missed_scale_opportunity | 199.53 | 69.04 | 16.40 |
| 2026-06-01 | 14 | 1751293382982422 | test_more | positive | non_hard_missed_scale_opportunity | 40.57 | 61.67 | 7.83 |

### IwaTR

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1016123361020200 | test_more | null | 40 | null | [quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action. | null |
| 1026667059767519 | test_more | null | 40 | null | [quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action. | null |
| 1030238108868060 | keep | null | 53 | null | [quality-only above_average] Upper/mid-funnel score 1.22x vs account baseline (hook score 1.07x; ctr score 1.06x; cpm_efficiency score 1.38x; click_to_lpv score 1.28x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1092817043324998 | test_more | null | 40 | null | [quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action. | null |
| 1098359138836126 | keep | null | 57 | null | [quality-only strong] Upper/mid-funnel score 1.57x vs account baseline (hook score 1.08x; ctr score 1.39x; cpm_efficiency score 1.21x; click_to_lpv score 1.13x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1136950221240357 | keep | null | 60 | null | [quality-only strong] Upper/mid-funnel score 1.32x vs account baseline (hook score 0.50x; ctr score 2.00x; cpm_efficiency score 1.05x; click_to_lpv score 0.96x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1171849118359340 | test_more | null | 40 | null | [quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action. | null |
| 1172712014746001 | test_more | null | 40 | null | [quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action. | null |
| 1207500747600201 | test_more | null | 40 | null | [quality-only below_average] Upper/mid-funnel score 0.73x vs account baseline (hook score 1.04x; ctr score 0.50x; cpm_efficiency score 0.80x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence. | null |
| 1223002432706265 | keep | null | 47 | null | [quality-only above_average] Upper/mid-funnel score 1.25x vs account baseline (hook score 1.05x; ctr score 0.81x; cpm_efficiency score 1.12x; click_to_lpv score 1.19x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1225265562983552 | test_more | null | 40 | null | [quality-only below_average] Upper/mid-funnel score 0.77x vs account baseline (hook score 1.09x; ctr score 0.52x; cpm_efficiency score 0.85x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence. | null |
| 1279637120690685 | diagnose | null | 40 | null | Landing page issue: Link-to-LPV 17.74% vs account baseline 32.28%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. | null |


### Silveristic

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1023001666791831 | test_more | null | 61 | null | [quality-only neutral] Upper/mid-funnel score 0.87x vs account baseline (hook score 1.80x; ctr score 0.70x; cpm_efficiency score 0.56x; click_to_lpv score 1.02x). No hard action until profit target or stronger funnel separation exists. | null |
| 1033214469106065 | diagnose | null | 45 | null | [quality-only] checkout bottleneck detected before profit evaluation: IC-to-purchase 20.00% vs account baseline 21.82%. Do not judge the creative as a sales loser until this step is checked. | null |
| 1134586805526549 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC. | null |
| 1257946859799919 | test_more | null | 40 | null | [quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action. | null |
| 1303618031863949 | test_more | null | 40 | null | [quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (not enough upper/mid-funnel denominators for quality scoring). Keep collecting upper/mid-funnel signal before a profit action. | null |
| 1471338801678548 | keep | null | 65 | null | [quality-only above_average] Upper/mid-funnel score 1.15x vs account baseline (hook score 0.50x; ctr score 1.40x; cpm_efficiency score 0.92x; click_to_lpv score 1.08x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1471818274365238 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC. | null |
| 1510442940714267 | keep | null | 65 | null | [quality-only above_average] Upper/mid-funnel score 1.30x vs account baseline (hook score 0.50x; ctr score 1.60x; cpm_efficiency score 1.28x; click_to_lpv score 0.97x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1521733932924068 | test_more | null | 40 | null | [quality-only weak] Upper/mid-funnel score 0.66x vs account baseline (hook score 0.50x; ctr score 0.91x; cpm_efficiency score 0.50x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence. | null |
| 1540476307413620 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_TRAFFIC. | null |
| 1572249944256651 | keep | null | 40 | null | [quality-only above_average] Upper/mid-funnel score 1.01x vs account baseline (ctr score 1.13x; cpm_efficiency score 0.86x; click_to_lpv score 1.03x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1575801273494328 | diagnose | null | 40 | null | Checkout breakdown: ATC-to-IC 0.00% vs account baseline 12.15%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. | null |


### TheSwaf

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1000844809459077 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.78 (28d) = 35% of target after $711 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1002443442283933 | test_more | null | 60 | null | Below commercial maturity (28d spend $100 < $141 loss-budget floor, 0 purchases, age 19d) — let the creative accumulate signal. | null |
| 1007048011875307 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $678 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1008302678413358 | keep | null | 50 | null | [demote candidate] ROAS 1.27 (28d) = 58% of target — above account bottom quartile (39%) but below breakeven (1.71 = 78% of target) at $502 mature spend — consider demote to test placement or refresh creative concept. | null |
| 1014356057726711 | keep | null | 50 | null | [weak zone] ROAS 0.93 (28d) = 42% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further. | null |
| 1018252307526601 | test_more | null | 60 | null | Below commercial maturity (28d spend $31 < $141 loss-budget floor, 0 purchases, age 19d) — let the creative accumulate signal. | null |
| 1023264806904899 | diagnose | null | 55 | null | Landing page issue: Link-to-LPV 46.15% vs account baseline 50.00%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. | null |
| 1023932563648623 | test_more | null | 60 | null | Below commercial maturity (28d spend $3 < $141 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal. | null |
| 1030352566602424 | test_more | null | 60 | null | Below commercial maturity (28d spend $7 < $141 loss-budget floor, 0 purchases) — let the creative accumulate signal. | null |
| 1031796332841133 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.48 (28d) = 22% of target after $312 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1033614439176557 | test_more | null | 60 | null | Below commercial maturity (28d spend $19 < $141 loss-budget floor, 0 purchases, age 19d) — let the creative accumulate signal. | null |
| 1111657292040172 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases) — let the creative accumulate signal. | null |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-16 | 14 | 1345674994165648 | test_more | positive | non_hard_missed_cut_opportunity | 1,137.45 | 9,282.39 | 1.17 |
| 2026-06-17 | 14 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 1,775.29 | 9,086.09 | 1.18 |
| 2026-06-14 | 14 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 232.35 | 8,947.62 | 1.09 |
| 2026-06-14 | 14 | 1672191184091002 | test_more | positive | non_hard_missed_cut_opportunity | 792.78 | 7,658.45 | 1.02 |
| 2026-06-21 | 14 | 1672191184091002 | keep | positive | non_hard_missed_cut_opportunity | 4,707.14 | 7,451.55 | 1.30 |
| 2026-06-21 | 14 | 3041651776171249 | test_more | positive | non_hard_missed_cut_opportunity | 2,252.97 | 5,875.20 | 0.73 |
| 2026-06-14 | 14 | 1962656064410174 | test_more | positive | non_hard_missed_cut_opportunity | 195.78 | 5,858.14 | 0.57 |
| 2026-06-16 | 14 | 3041651776171249 | keep | positive | non_hard_missed_cut_opportunity | 309.90 | 5,794.56 | 0.69 |
| 2026-06-14 | 14 | 3041651776171249 | test_more | positive | non_hard_missed_cut_opportunity | 43.47 | 5,321.08 | 0.68 |
| 2026-06-17 | 7 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 1,775.29 | 4,680.34 | 1.23 |
| 2026-06-16 | 7 | 1345674994165648 | test_more | positive | non_hard_missed_cut_opportunity | 1,137.45 | 4,657.62 | 1.22 |
| 2026-06-14 | 7 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 232.35 | 4,230.16 | 1.15 |

### Tiles Workshop

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1042376994660818 | test_more | null | 55 | null | [soft-only - cut blocked] ROAS 1.83 (28d) = 52% of target after $322 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1053498142940351 | test_more | null | 55 | null | Below commercial maturity (28d spend $6 < $107 loss-budget floor, 0 purchases, age 14d) — let the creative accumulate signal. | null |
| 1116501586972225 | test_more | null | 55 | null | Below commercial maturity (28d spend $16 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal. | null |
| 1124168746317341 | test_more | null | 55 | null | [soft-only - cut blocked] ROAS 1.95 (28d) = 56% of target after $459 spend (28d) — clear loser at scale. (threshold baseline meta_derived_aov has low confidence (meta AOV ready)) | null |
| 1137243591241158 | test_more | null | 55 | null | Below commercial maturity (28d spend $7 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal. | null |
| 1178789597502548 | test_more | null | 55 | null | Below commercial maturity (28d spend $48 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal. | null |
| 1181134667483485 | test_more | null | 55 | null | Below commercial maturity (28d spend $3 < $107 loss-budget floor, 0 purchases, age 14d) — let the creative accumulate signal. | null |
| 1182354087394020 | test_more | null | 55 | null | Below commercial maturity (28d spend $53 < $107 loss-budget floor, 1 purchases, age 15d) — let the creative accumulate signal. | null |
| 1185432376938133 | test_more | null | 55 | null | Below commercial maturity (28d spend $2 < $107 loss-budget floor, 0 purchases, age 25d) — let the creative accumulate signal. | null |
| 1233113425673369 | test_more | null | 55 | null | Below commercial maturity (28d spend $14 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal. | null |
| 1233220061966018 | test_more | null | 55 | null | Below commercial maturity (28d spend $4 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal. | null |
| 1237623548179791 | test_more | null | 55 | null | Below commercial maturity (28d spend $5 < $107 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal. | null |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-07 | 2434481843638891 | cut | null | 75 | 2,542.77 | 20 | 1.79 | lifecycle_unavailable | ROAS 1.79 (28d) = 51% of target after $2,543 spend (28d) — clear loser at scale. |
| 2026-06-08 | 2434481843638891 | cut | null | 75 | 2,499.02 | 19 | 1.78 | lifecycle_unavailable | ROAS 1.78 (28d) = 51% of target after $2,499 spend (28d) — clear loser at scale. |
| 2026-06-06 | 2434481843638891 | cut | null | 75 | 2,493.19 | 19 | 1.74 | lifecycle_unavailable | ROAS 1.74 (28d) = 50% of target after $2,493 spend (28d) — clear loser at scale. |
| 2026-06-05 | 2434481843638891 | cut | null | 75 | 2,416.62 | 19 | 1.80 | lifecycle_unavailable | ROAS 1.80 (28d) = 51% of target after $2,417 spend (28d) — clear loser at scale. |
| 2026-06-09 | 2434481843638891 | cut | null | 75 | 2,407.77 | 17 | 1.52 | lifecycle_unavailable | ROAS 1.52 (28d) = 43% of target after $2,408 spend (28d) — clear loser at scale. |
| 2026-06-04 | 2434481843638891 | cut | null | 75 | 2,373.85 | 18 | 1.75 | lifecycle_unavailable | ROAS 1.75 (28d) = 50% of target after $2,374 spend (28d) — clear loser at scale. |
| 2026-06-03 | 2434481843638891 | cut | null | 75 | 2,325.66 | 18 | 1.78 | lifecycle_unavailable | ROAS 1.78 (28d) = 51% of target after $2,326 spend (28d) — clear loser at scale. |
| 2026-06-10 | 2434481843638891 | cut | null | 75 | 2,314.70 | 15 | 1.47 | lifecycle_unavailable | ROAS 1.47 (28d) = 42% of target after $2,315 spend (28d) — clear loser at scale. |
| 2026-06-11 | 2434481843638891 | cut | null | 75 | 2,301.73 | 15 | 1.47 | lifecycle_unavailable | ROAS 1.47 (28d) = 42% of target after $2,302 spend (28d) — clear loser at scale. |
| 2026-06-02 | 2434481843638891 | cut | null | 75 | 2,266.90 | 18 | 1.83 | lifecycle_unavailable | ROAS 1.83 (28d) = 52% of target after $2,267 spend (28d) — clear loser at scale. |
| 2026-06-12 | 2434481843638891 | cut | null | 75 | 2,185.02 | 15 | 1.55 | lifecycle_unavailable | ROAS 1.55 (28d) = 44% of target after $2,185 spend (28d) — clear loser at scale. |
| 2026-06-01 | 2434481843638891 | cut | null | 75 | 2,183.16 | 17 | 1.79 | lifecycle_unavailable | ROAS 1.79 (28d) = 51% of target after $2,183 spend (28d) — clear loser at scale. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-01 | 14 | 1793117274735358 | keep | positive | non_hard_missed_scale_opportunity | 1,636.42 | 2,835.87 | 4.92 |
| 2026-06-02 | 14 | 1793117274735358 | scale | positive | scale_held_above_target | 1,882.68 | 2,698.48 | 4.52 |
| 2026-06-01 | 7 | 1793117274735358 | keep | positive | non_hard_missed_scale_opportunity | 1,636.42 | 1,374.81 | 5.76 |
| 2026-06-02 | 7 | 1793117274735358 | scale | positive | scale_held_above_target | 1,882.68 | 1,355.42 | 4.97 |
| 2026-06-01 | 14 | 2817477148644711 | cut | negative | cut_recovered_above_target | 1,329.72 | 1,234.09 | 3.67 |
| 2026-06-03 | 14 | 672236422177292 | keep | positive | non_hard_missed_cut_opportunity | 700.82 | 880.75 | 1.80 |
| 2026-06-01 | 14 | 747209084691729 | keep | positive | non_hard_missed_cut_opportunity | 989.33 | 849.23 | 1.48 |
| 2026-06-01 | 14 | 2434481843638891 | cut | positive | cut_loss_continued | 2,183.16 | 772.14 | 0.83 |
| 2026-06-01 | 14 | 2710249745986679 | cut | negative | cut_recovered_above_target | 1,088.32 | 738.43 | 4.12 |
| 2026-06-05 | 14 | 917337130721916 | keep | positive | non_hard_missed_cut_opportunity | 988.59 | 674.11 | 1.59 |
| 2026-06-01 | 14 | 1259131729556067 | test_more | positive | non_hard_missed_cut_opportunity | 106.05 | 601.77 | 1.21 |
| 2026-06-02 | 14 | 1259131729556067 | cut | positive | cut_loss_continued | 137.06 | 580.68 | 1.25 |

### Vornom

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1020768527549028 | test_more | null | 40 | null | [quality-only below_average] Upper/mid-funnel score 0.83x vs account baseline (hook score 0.77x; ctr score 1.44x; cpm_efficiency score 0.50x; click_to_lpv score 0.66x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence. | null |
| 1052280054449931 | test_more | null | 44 | null | [quality-only neutral] Upper/mid-funnel score 0.98x vs account baseline (hook score 1.11x; ctr score 0.50x; cpm_efficiency score 2.00x; click_to_lpv score 0.58x). No hard action until profit target or stronger funnel separation exists. | null |
| 1068520515515581 | test_more | null | 65 | null | [quality-only neutral] Upper/mid-funnel score 0.90x vs account baseline (hook score 0.50x; ctr score 1.01x; cpm_efficiency score 1.17x; click_to_lpv score 0.99x). No hard action until profit target or stronger funnel separation exists. | null |
| 1213490407486500 | diagnose | null | 40 | null | Delivery issue: active creative has verified 0 spend and 0 impressions in the latest daily delivery window; inspect ad, ad set, campaign, budget, audience, and learning constraints before judging creative performance. | null |
| 1249540987094718 | keep | null | 55 | null | [quality-only above_average] Upper/mid-funnel score 1.11x vs account baseline (hook score 0.79x; ctr score 0.73x; cpm_efficiency score 1.10x; click_to_lpv score 0.99x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1258933613045907 | keep | null | 64 | null | [quality-only above_average] Upper/mid-funnel score 1.28x vs account baseline (hook score 1.33x; ctr score 0.50x; cpm_efficiency score 1.73x; click_to_lpv score 1.13x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1286573629509612 | keep | null | 63 | null | [quality-only strong] Upper/mid-funnel score 1.45x vs account baseline (hook score 0.50x; ctr score 0.99x; cpm_efficiency score 0.90x; click_to_lpv score 0.90x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1340554338140232 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_AWARENESS. | null |
| 1370044211804963 | keep | null | 65 | null | [quality-only above_average] Upper/mid-funnel score 1.12x vs account baseline (hook score 1.26x; ctr score 0.99x; cpm_efficiency score 1.04x; click_to_lpv score 1.21x). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark. | null |
| 1437835607584666 | test_more | null | 53 | null | [quality-only neutral] Upper/mid-funnel score 0.89x vs account baseline (hook score 0.50x; ctr score 0.92x; cpm_efficiency score 2.00x; click_to_lpv score 0.80x). No hard action until profit target or stronger funnel separation exists. | null |
| 1443857737094759 | test_more | null | 53 | null | [quality-only below_average] Upper/mid-funnel score 0.83x vs account baseline (hook score 1.19x; ctr score 0.50x; cpm_efficiency score 1.47x; click_to_lpv score 0.94x). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence. | null |
| 1452182979458051 | out_of_scope | null | 60 | null | Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_AWARENESS. | null |
