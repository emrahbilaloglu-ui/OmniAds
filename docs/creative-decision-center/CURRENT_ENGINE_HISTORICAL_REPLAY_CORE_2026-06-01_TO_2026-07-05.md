# Current Engine Historical Replay - 2026-06-01 to 2026-07-05

Generated at: 2026-07-05T20:47:12.998Z
Current date assumed by run: 2026-07-05
Engine version: `v3-2026-07-02-math-guardrails`
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

## Label Flow And Guard Boundary

Outcome and confidence cells are computed from the guard-applied surfaced `decision.label`. `blockedActionType` is reported separately as guard context; this replay does not silently convert a blocked raw hard verdict into a hard outcome episode.

Interpretation consequence: a hard episode is a surfaced historical-replay label for that business/day/source-mode, not a claim that the same business is currently surfacing hard production labels. Fallback-mode hard labels must not be read as lifecycle-informed July production behavior.

EMOLOS-specific correction after Claude review: EMOLOS hard `cut` episodes in this core replay come from surfaced fallback-mode historical labels, not from guard-blocked raw verdicts. EMOLOS lifecycle-informed replay on 2026-07-03, 2026-07-04, and 2026-07-05 surfaced zero hard labels (`test_more`/`diagnose`/`keep` only). Therefore the EMOLOS cut proxy is a June fallback formula signal, not evidence that July production is surfacing hard EMOLOS decisions.

## Global Summary

- Businesses found: 4
- Dates replayed: 35
- Decision rows: 16840
- Unique business+creative pairs: 912
- Label mix: test_more: 12526, diagnose: 1651, keep: 1540, cut: 814, out_of_scope: 209, scale: 100
- Source mode days: runtime_sql_fallback: 127, lifecycle_same_day: 13
- Open outcome windows: 11178
- Closed daily outcome rows: 22502
- Episode-deduped outcome rows: 1780
- Known episodes: 1058
- Unknown episodes: 722

## Business Summary

| Business | Demo | Days | Failed | Decisions | Unique creatives | Labels | Hard rows | Blocked rows | Source modes | Profile ranges | Risk hints |
|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|---|
| EMOLOS | no | 35 | 0 | 4871 | 277 | test_more: 4022, keep: 409, cut: 227, diagnose: 213 | 227 | 187 | runtime_sql_fallback: 32, lifecycle_same_day: 3 | spendUnit 34.34-35.39, commercialMaturitySpend 68.69-70.78, hardCutSpend 171.72-176.95, bottomQuartileRatio 0.20-0.25, severeLoserRatio 0.09-0.16, scaleMinPurchases 1.00-1.00, winnerPurchaseP50 1.00-1.00, matureCreativeCount 39.00-51.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Grandmix | no | 35 | 0 | 2833 | 191 | test_more: 2022, diagnose: 395, keep: 329, cut: 84, scale: 3 | 87 | 100 | runtime_sql_fallback: 32, lifecycle_same_day: 3 | spendUnit 103.63-108.51, commercialMaturitySpend 259.08-271.28, hardCutSpend 829.04-868.11, bottomQuartileRatio 0.41-0.48, severeLoserRatio 0.19-0.24, scaleMinPurchases 4.00-7.00, winnerPurchaseP50 2.50-4.50, matureCreativeCount 55.00-72.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| IwaStore | no | 35 | 0 | 2183 | 159 | test_more: 1449, diagnose: 295, out_of_scope: 203, keep: 135, scale: 75, cut: 26 | 101 | 21 | runtime_sql_fallback: 32, lifecycle_same_day: 3 | spendUnit 48.95-50.88, commercialMaturitySpend 97.91-101.77, hardCutSpend 244.76-254.42, bottomQuartileRatio 0.56-0.83, severeLoserRatio 0.41-0.57, scaleMinPurchases 2.00-5.00, winnerPurchaseP50 2.00-4.50, matureCreativeCount 46.00-96.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| TheSwaf | no | 35 | 0 | 6953 | 285 | test_more: 5033, diagnose: 748, keep: 667, cut: 477, scale: 22, out_of_scope: 6 | 499 | 414 | runtime_sql_fallback: 31, lifecycle_same_day: 4 | spendUnit 92.76-95.07, commercialMaturitySpend 139.14-142.60, hardCutSpend 278.28-285.21, bottomQuartileRatio 0.38-0.46, severeLoserRatio 0.24-0.33, scaleMinPurchases 1.00-2.00, winnerPurchaseP50 1.00-2.00, matureCreativeCount 79.00-112.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |

## Fidelity Check vs Persisted Snapshots

This is the replay-faithfulness anchor requested by Claude: 2026-07-03 and 2026-07-04 replay rows are compared with actual persisted current-version snapshots. Low fidelity does not automatically mean the formula is wrong; it means replay mode/provenance differs and the historical result must be discounted accordingly.

| Business | Date | Source mode | Replay rows | Snapshot rows | Common | Label match | Label+confidence match | Replay-only | Snapshot-only |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| EMOLOS | 2026-07-03 | lifecycle_same_day | 277 | 277 | 277 | 100.0% | 100.0% | 0 | 0 |
| EMOLOS | 2026-07-04 | lifecycle_same_day | 277 | 277 | 277 | 100.0% | 100.0% | 0 | 0 |
| Grandmix | 2026-07-03 | lifecycle_same_day | 169 | 169 | 169 | 99.4% | 98.8% | 0 | 0 |
| Grandmix | 2026-07-04 | lifecycle_same_day | 169 | 169 | 169 | 99.4% | 99.4% | 0 | 0 |
| IwaStore | 2026-07-03 | lifecycle_same_day | 152 | 152 | 152 | 100.0% | 100.0% | 0 | 0 |
| IwaStore | 2026-07-04 | lifecycle_same_day | 155 | 155 | 155 | 100.0% | 100.0% | 0 | 0 |
| TheSwaf | 2026-07-03 | lifecycle_same_day | 284 | 284 | 284 | 100.0% | 100.0% | 0 | 0 |
| TheSwaf | 2026-07-04 | lifecycle_same_day | 284 | 284 | 284 | 100.0% | 100.0% | 0 | 0 |

## Fidelity Mismatch Notes

Sampled replay-vs-snapshot mismatches are listed explicitly so the 99.4-100.0% fidelity rates do not hide boundary-class differences.

- Grandmix 2026-07-03 creative `1503539391277675`: replay `diagnose`/75 vs snapshot `test_more`/75. Replay classified latest zero-spend delivery as a delivery issue; persisted snapshot treated it as below commercial maturity.
- Grandmix 2026-07-03 creative `769388716237610`: replay `diagnose`/75 vs snapshot `diagnose`/70. Label matched; confidence/reason drifted between latest zero-spend delivery issue and LPV funnel diagnosis.
- Grandmix 2026-07-04 creative `1548668237040903`: replay `diagnose`/75 vs snapshot `keep`/75. Replay treated latest zero-spend delivery as delivery issue; persisted snapshot treated it as weak-zone keep.

These are local delivery/funnel/freshness boundary differences, not hard-label reversals. They explain the Grandmix 99.4% label fidelity and keep the replay usable, but Grandmix rows should still be interpreted with this boundary in mind.

## Outcome Episode Summary

`open_window` is not `unknown`: open means the 7d/14d forward window has not closed by 2026-07-05. `unknown` means the window is closed but the classifier cannot infer outcome, most commonly zero forward spend or missing target. Precision/missed-opportunity proxy below is episode-deduped, not daily-row counted.

| Business | Window | Label | Class | Open rows | Closed daily rows | Episodes | Known | Unknown | Positive | Negative | Neutral | Zero-forward unknown | Positive rate known | Reliability |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| EMOLOS | 7 | cut | hard | 2 | 225 | 14 | 6 | 8 | 6 | 0 | 0 | 8 | 100.0% | insufficient |
| EMOLOS | 7 | diagnose | non_hard | 95 | 118 | 17 | 16 | 1 | 14 | 0 | 2 | 1 | 87.5% | directional |
| EMOLOS | 7 | keep | non_hard | 54 | 355 | 31 | 18 | 13 | 17 | 0 | 1 | 13 | 94.4% | directional |
| EMOLOS | 7 | test_more | non_hard | 1060 | 2962 | 180 | 98 | 82 | 96 | 0 | 2 | 82 | 98.0% | defensible |
| EMOLOS | 14 | cut | hard | 36 | 191 | 13 | 6 | 7 | 6 | 0 | 0 | 7 | 100.0% | insufficient |
| EMOLOS | 14 | diagnose | non_hard | 156 | 57 | 11 | 10 | 1 | 8 | 0 | 2 | 1 | 80.0% | directional |
| EMOLOS | 14 | keep | non_hard | 135 | 274 | 27 | 15 | 12 | 13 | 0 | 2 | 12 | 86.7% | directional |
| EMOLOS | 14 | test_more | non_hard | 1701 | 2321 | 179 | 97 | 82 | 95 | 0 | 2 | 82 | 97.9% | defensible |
| Grandmix | 7 | cut | hard | 6 | 78 | 12 | 6 | 6 | 1 | 4 | 1 | 6 | 16.7% | insufficient |
| Grandmix | 7 | scale | hard | 0 | 3 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0.0% | insufficient |
| Grandmix | 7 | diagnose | non_hard | 90 | 305 | 38 | 28 | 10 | 20 | 0 | 8 | 10 | 71.4% | directional |
| Grandmix | 7 | keep | non_hard | 48 | 281 | 32 | 27 | 5 | 16 | 0 | 11 | 5 | 59.3% | directional |
| Grandmix | 7 | test_more | non_hard | 712 | 1310 | 142 | 78 | 64 | 64 | 0 | 14 | 64 | 82.0% | defensible |
| Grandmix | 14 | cut | hard | 9 | 75 | 10 | 4 | 6 | 1 | 0 | 3 | 6 | 25.0% | insufficient |
| Grandmix | 14 | scale | hard | 0 | 3 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0.0% | insufficient |
| Grandmix | 14 | diagnose | non_hard | 175 | 220 | 27 | 18 | 9 | 14 | 0 | 4 | 9 | 77.8% | directional |
| Grandmix | 14 | keep | non_hard | 98 | 231 | 27 | 22 | 5 | 14 | 0 | 8 | 5 | 63.6% | directional |
| Grandmix | 14 | test_more | non_hard | 926 | 1096 | 97 | 37 | 60 | 27 | 0 | 10 | 60 | 73.0% | defensible |
| IwaStore | 7 | cut | hard | 3 | 23 | 4 | 4 | 0 | 2 | 2 | 0 | 0 | 50.0% | insufficient |
| IwaStore | 7 | scale | hard | 13 | 62 | 10 | 9 | 1 | 4 | 3 | 2 | 1 | 44.4% | insufficient |
| IwaStore | 7 | diagnose | non_hard | 121 | 174 | 28 | 25 | 3 | 22 | 0 | 3 | 3 | 88.0% | directional |
| IwaStore | 7 | keep | non_hard | 34 | 101 | 13 | 13 | 0 | 10 | 0 | 3 | 0 | 76.9% | directional |
| IwaStore | 7 | out_of_scope | non_hard | 31 | 172 | 7 | 0 | 7 | 0 | 0 | 0 | 2 | - | insufficient |
| IwaStore | 7 | test_more | non_hard | 533 | 916 | 54 | 34 | 20 | 34 | 0 | 0 | 20 | 100.0% | defensible |
| IwaStore | 14 | cut | hard | 10 | 16 | 4 | 4 | 0 | 2 | 2 | 0 | 0 | 50.0% | insufficient |
| IwaStore | 14 | scale | hard | 29 | 46 | 8 | 8 | 0 | 3 | 5 | 0 | 0 | 37.5% | insufficient |
| IwaStore | 14 | diagnose | non_hard | 174 | 121 | 18 | 17 | 1 | 14 | 0 | 3 | 1 | 82.3% | directional |
| IwaStore | 14 | keep | non_hard | 56 | 79 | 11 | 11 | 0 | 7 | 0 | 4 | 0 | 63.6% | directional |
| IwaStore | 14 | out_of_scope | non_hard | 73 | 130 | 7 | 0 | 7 | 0 | 0 | 0 | 2 | - | insufficient |
| IwaStore | 14 | test_more | non_hard | 738 | 711 | 51 | 32 | 19 | 31 | 0 | 1 | 19 | 96.9% | defensible |
| TheSwaf | 7 | cut | hard | 69 | 408 | 32 | 17 | 15 | 13 | 4 | 0 | 15 | 76.5% | directional |
| TheSwaf | 7 | scale | hard | 12 | 10 | 4 | 4 | 0 | 2 | 2 | 0 | 0 | 50.0% | insufficient |
| TheSwaf | 7 | diagnose | non_hard | 113 | 635 | 71 | 44 | 27 | 33 | 0 | 11 | 27 | 75.0% | defensible |
| TheSwaf | 7 | keep | non_hard | 151 | 516 | 51 | 39 | 12 | 32 | 0 | 7 | 12 | 82.0% | defensible |
| TheSwaf | 7 | out_of_scope | non_hard | 0 | 6 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| TheSwaf | 7 | test_more | non_hard | 1160 | 3873 | 207 | 112 | 95 | 95 | 0 | 17 | 95 | 84.8% | defensible |
| TheSwaf | 14 | cut | hard | 142 | 335 | 30 | 15 | 15 | 10 | 4 | 1 | 15 | 66.7% | directional |
| TheSwaf | 14 | scale | hard | 19 | 3 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0.0% | insufficient |
| TheSwaf | 14 | diagnose | non_hard | 270 | 478 | 63 | 38 | 25 | 31 | 0 | 7 | 25 | 81.6% | defensible |
| TheSwaf | 14 | keep | non_hard | 311 | 356 | 43 | 32 | 11 | 25 | 0 | 7 | 11 | 78.1% | defensible |
| TheSwaf | 14 | out_of_scope | non_hard | 0 | 6 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| TheSwaf | 14 | test_more | non_hard | 1813 | 3220 | 200 | 109 | 91 | 94 | 0 | 15 | 91 | 86.2% | defensible |

## Confidence Alignment Smoke

Hard and non-hard rows are deliberately separated. For hard actions, positive means the hard action proxy was supported. For non-hard rows, positive means a missed hard-action opportunity proxy; it is not the same polarity and must not be pooled with hard precision.

| Business | Window | Class | Bucket | Episodes | Known | Positive | Observed positive | Avg confidence | Abs gap |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| EMOLOS | 7 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| EMOLOS | 7 | hard | 70_79 | 8 | 6 | 6 | 100.0% | 75.0% | 25.0% |
| EMOLOS | 7 | non_hard | 50_59 | 15 | 14 | 13 | 92.9% | 50.0% | 42.9% |
| EMOLOS | 7 | non_hard | 60_69 | 13 | 0 | 0 | - | - | - |
| EMOLOS | 7 | non_hard | 70_79 | 200 | 118 | 114 | 96.6% | 75.0% | 21.6% |
| EMOLOS | 14 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| EMOLOS | 14 | hard | 70_79 | 7 | 6 | 6 | 100.0% | 75.0% | 25.0% |
| EMOLOS | 14 | non_hard | 50_59 | 10 | 9 | 8 | 88.9% | 50.0% | 38.9% |
| EMOLOS | 14 | non_hard | 60_69 | 12 | 0 | 0 | - | - | - |
| EMOLOS | 14 | non_hard | 70_79 | 195 | 113 | 108 | 95.6% | 75.0% | 20.6% |
| Grandmix | 7 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| Grandmix | 7 | hard | 70_79 | 8 | 8 | 1 | 12.5% | 75.0% | 62.5% |
| Grandmix | 7 | non_hard | 50_59 | 7 | 4 | 3 | 75.0% | 50.0% | 25.0% |
| Grandmix | 7 | non_hard | 60_69 | 5 | 0 | 0 | - | - | - |
| Grandmix | 7 | non_hard | 70_79 | 200 | 129 | 97 | 75.2% | 74.2% | 1.0% |
| Grandmix | 14 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| Grandmix | 14 | hard | 70_79 | 6 | 6 | 1 | 16.7% | 75.0% | 58.3% |
| Grandmix | 14 | non_hard | 50_59 | 6 | 4 | 3 | 75.0% | 50.0% | 25.0% |
| Grandmix | 14 | non_hard | 60_69 | 5 | 0 | 0 | - | - | - |
| Grandmix | 14 | non_hard | 70_79 | 140 | 73 | 52 | 71.2% | 74.1% | 2.9% |
| IwaStore | 7 | hard | 70_79 | 14 | 13 | 6 | 46.2% | 75.0% | 28.8% |
| IwaStore | 7 | non_hard | 60_69 | 7 | 0 | 0 | - | - | - |
| IwaStore | 7 | non_hard | 70_79 | 95 | 72 | 66 | 91.7% | 74.2% | 17.4% |
| IwaStore | 14 | hard | 70_79 | 12 | 12 | 5 | 41.7% | 75.0% | 33.3% |
| IwaStore | 14 | non_hard | 60_69 | 7 | 0 | 0 | - | - | - |
| IwaStore | 14 | non_hard | 70_79 | 80 | 60 | 52 | 86.7% | 74.2% | 12.5% |
| TheSwaf | 7 | hard | 60_69 | 7 | 0 | 0 | - | - | - |
| TheSwaf | 7 | hard | 70_79 | 29 | 21 | 15 | 71.4% | 75.0% | 3.6% |
| TheSwaf | 7 | non_hard | 50_59 | 29 | 25 | 18 | 72.0% | 50.0% | 22.0% |
| TheSwaf | 7 | non_hard | 60_69 | 6 | 0 | 0 | - | - | - |
| TheSwaf | 7 | non_hard | 70_79 | 295 | 170 | 142 | 83.5% | 74.6% | 9.0% |
| TheSwaf | 14 | hard | 60_69 | 7 | 0 | 0 | - | - | - |
| TheSwaf | 14 | hard | 70_79 | 24 | 16 | 10 | 62.5% | 75.0% | 12.5% |
| TheSwaf | 14 | non_hard | 50_59 | 27 | 25 | 19 | 76.0% | 50.0% | 26.0% |
| TheSwaf | 14 | non_hard | 60_69 | 6 | 0 | 0 | - | - | - |
| TheSwaf | 14 | non_hard | 70_79 | 274 | 154 | 131 | 85.1% | 74.6% | 10.5% |

## Replay Date Summary

| Date | Success businesses | Failed businesses | Decisions | Labels | Source modes |
|---|---:|---:|---:|---|---|
| 2026-06-01 | 4 | 0 | 484 | test_more: 359, diagnose: 45, keep: 38, cut: 31, out_of_scope: 8, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-02 | 4 | 0 | 485 | test_more: 360, diagnose: 46, keep: 37, cut: 31, out_of_scope: 8, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-03 | 4 | 0 | 484 | test_more: 359, diagnose: 48, keep: 37, cut: 29, out_of_scope: 8, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-04 | 4 | 0 | 484 | test_more: 370, keep: 39, diagnose: 33, cut: 31, out_of_scope: 8, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-05 | 4 | 0 | 528 | test_more: 409, keep: 39, diagnose: 38, cut: 31, out_of_scope: 7, scale: 4 | runtime_sql_fallback: 4 |
| 2026-06-06 | 4 | 0 | 549 | test_more: 430, keep: 43, diagnose: 37, cut: 29, out_of_scope: 7, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-07 | 4 | 0 | 544 | test_more: 424, keep: 40, diagnose: 36, cut: 34, out_of_scope: 6, scale: 4 | runtime_sql_fallback: 4 |
| 2026-06-08 | 4 | 0 | 515 | test_more: 396, keep: 42, cut: 33, diagnose: 33, out_of_scope: 6, scale: 5 | runtime_sql_fallback: 4 |
| 2026-06-09 | 4 | 0 | 502 | test_more: 378, keep: 45, diagnose: 35, cut: 34, out_of_scope: 6, scale: 4 | runtime_sql_fallback: 4 |
| 2026-06-10 | 4 | 0 | 489 | test_more: 363, keep: 47, diagnose: 37, cut: 33, out_of_scope: 6, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-11 | 4 | 0 | 486 | test_more: 362, keep: 47, diagnose: 39, cut: 29, out_of_scope: 6, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-12 | 4 | 0 | 470 | test_more: 349, keep: 46, diagnose: 37, cut: 29, out_of_scope: 6, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-13 | 4 | 0 | 448 | test_more: 325, keep: 46, diagnose: 40, cut: 28, out_of_scope: 6, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-14 | 4 | 0 | 490 | test_more: 354, keep: 52, diagnose: 46, cut: 30, out_of_scope: 6, scale: 2 | runtime_sql_fallback: 4 |
| 2026-06-15 | 4 | 0 | 473 | test_more: 344, diagnose: 51, keep: 48, cut: 24, out_of_scope: 6 | runtime_sql_fallback: 4 |
| 2026-06-16 | 4 | 0 | 432 | test_more: 302, diagnose: 50, keep: 49, cut: 25, out_of_scope: 6 | runtime_sql_fallback: 4 |
| 2026-06-17 | 4 | 0 | 425 | test_more: 295, keep: 49, diagnose: 47, cut: 28, out_of_scope: 6 | runtime_sql_fallback: 4 |
| 2026-06-18 | 4 | 0 | 419 | test_more: 290, keep: 50, diagnose: 46, cut: 27, out_of_scope: 6 | runtime_sql_fallback: 4 |
| 2026-06-19 | 4 | 0 | 436 | test_more: 306, diagnose: 48, keep: 47, cut: 27, out_of_scope: 6, scale: 2 | runtime_sql_fallback: 4 |
| 2026-06-20 | 4 | 0 | 428 | test_more: 301, keep: 49, diagnose: 41, cut: 29, out_of_scope: 6, scale: 2 | runtime_sql_fallback: 4 |
| 2026-06-21 | 4 | 0 | 398 | test_more: 272, keep: 50, diagnose: 43, cut: 25, out_of_scope: 6, scale: 2 | runtime_sql_fallback: 4 |
| 2026-06-22 | 4 | 0 | 389 | test_more: 266, keep: 50, diagnose: 45, cut: 21, out_of_scope: 6, scale: 1 | runtime_sql_fallback: 4 |
| 2026-06-23 | 4 | 0 | 385 | test_more: 261, keep: 50, diagnose: 46, cut: 19, out_of_scope: 6, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-24 | 4 | 0 | 380 | test_more: 258, diagnose: 51, keep: 47, cut: 16, out_of_scope: 6, scale: 2 | runtime_sql_fallback: 4 |
| 2026-06-25 | 4 | 0 | 351 | test_more: 231, diagnose: 50, keep: 45, cut: 16, out_of_scope: 6, scale: 3 | runtime_sql_fallback: 4 |
| 2026-06-26 | 4 | 0 | 349 | test_more: 227, diagnose: 55, keep: 41, cut: 15, out_of_scope: 6, scale: 5 | runtime_sql_fallback: 4 |
| 2026-06-27 | 4 | 0 | 338 | test_more: 217, diagnose: 56, keep: 38, cut: 16, out_of_scope: 6, scale: 5 | runtime_sql_fallback: 4 |
| 2026-06-28 | 4 | 0 | 372 | test_more: 253, diagnose: 53, keep: 42, cut: 14, out_of_scope: 6, scale: 4 | runtime_sql_fallback: 4 |
| 2026-06-29 | 4 | 0 | 364 | test_more: 252, diagnose: 50, keep: 39, cut: 14, out_of_scope: 5, scale: 4 | runtime_sql_fallback: 4 |
| 2026-06-30 | 4 | 0 | 367 | test_more: 254, diagnose: 55, keep: 37, cut: 12, out_of_scope: 5, scale: 4 | runtime_sql_fallback: 4 |
| 2026-07-01 | 4 | 0 | 367 | test_more: 242, diagnose: 63, keep: 41, cut: 11, out_of_scope: 6, scale: 4 | runtime_sql_fallback: 4 |
| 2026-07-02 | 4 | 0 | 536 | test_more: 409, diagnose: 61, keep: 45, cut: 11, out_of_scope: 6, scale: 4 | runtime_sql_fallback: 3, lifecycle_same_day: 1 |
| 2026-07-03 | 4 | 0 | 882 | test_more: 763, diagnose: 59, keep: 42, cut: 11, scale: 4, out_of_scope: 3 | lifecycle_same_day: 4 |
| 2026-07-04 | 4 | 0 | 885 | test_more: 764, diagnose: 62, keep: 42, cut: 10, scale: 4, out_of_scope: 3 | lifecycle_same_day: 4 |
| 2026-07-05 | 4 | 0 | 906 | test_more: 781, diagnose: 69, keep: 41, cut: 11, out_of_scope: 3, scale: 1 | lifecycle_same_day: 4 |

## Business Samples

### EMOLOS

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-05 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-04 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-06 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-08 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-03 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-07 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-09 | 1323544629737422 | cut | null | 75 | 580.22 | 2 | 0.42 | lifecycle_unavailable | ROAS 0.42 (28d) = 17% of target after $580 spend (28d) — clear loser at scale. |
| 2026-06-02 | 1323544629737422 | cut | null | 75 | 548.31 | 2 | 0.44 | lifecycle_unavailable | ROAS 0.44 (28d) = 18% of target after $548 spend (28d) — clear loser at scale. |
| 2026-06-01 | 1323544629737422 | cut | null | 75 | 511.15 | 1 | 0.36 | lifecycle_unavailable | ROAS 0.36 (28d) = 14% of target after $511 spend (28d) — clear loser at scale. |
| 2026-06-06 | 962418690099350 | cut | null | 75 | 503.42 | 4 | 0.55 | lifecycle_unavailable | ROAS 0.55 (28d) = 22% of target after $503 spend (28d) — clear loser at scale. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-03 | 14 | 1683734522755632 | test_more | positive | non_hard_missed_cut_opportunity | 23.61 | 1,175.02 | 0.69 |
| 2026-06-21 | 14 | 2114021279176127 | diagnose | positive | non_hard_missed_cut_opportunity | 155.72 | 1,062.02 | 0.63 |
| 2026-06-20 | 14 | 2114021279176127 | keep | positive | non_hard_missed_cut_opportunity | 74.95 | 1,044.64 | 0.55 |
| 2026-06-19 | 14 | 2114021279176127 | test_more | positive | non_hard_missed_cut_opportunity | 9.66 | 1,037.38 | 0.61 |
| 2026-06-03 | 7 | 1683734522755632 | test_more | positive | non_hard_missed_cut_opportunity | 23.61 | 953.95 | 0.65 |
| 2026-06-19 | 14 | 882021054308247 | test_more | positive | non_hard_missed_cut_opportunity | 8.86 | 936.09 | 0.18 |
| 2026-06-21 | 14 | 882021054308247 | diagnose | positive | non_hard_missed_cut_opportunity | 135.84 | 928.05 | 0.27 |
| 2026-06-05 | 14 | 1457831769435391 | keep | positive | non_hard_missed_cut_opportunity | 135.19 | 917.73 | 0.55 |
| 2026-06-05 | 14 | 1683734522755632 | keep | positive | non_hard_missed_cut_opportunity | 358.20 | 861.89 | 0.65 |
| 2026-06-05 | 7 | 1457831769435391 | keep | positive | non_hard_missed_cut_opportunity | 135.19 | 846.35 | 0.59 |

### Grandmix

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1503539391277675 | diagnose | test_more | 75 | 75 | Delivery issue: active creative has verified 0 spend and 0 impressions in the latest daily delivery window; inspect ad, ad set, campaign, budget, audience, and learning constraints before judging creative performance. | Below commercial maturity (28d spend $4 < $263 loss-budget floor, 0 purchases, age 48d) — let the creative accumulate signal. |
| 769388716237610 | diagnose | diagnose | 75 | 70 | Delivery issue: active creative has verified 0 spend and 0 impressions in the latest daily delivery window; inspect ad, ad set, campaign, budget, audience, and learning constraints before judging creative performance. | Landing page issue: Link-to-LPV 44.83% vs account baseline 71.43%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. |
| 1548668237040903 | diagnose | keep | 75 | 75 | Delivery issue: active creative has verified 0 spend and 0 impressions in the latest daily delivery window; inspect ad, ad set, campaign, budget, audience, and learning constraints before judging creative performance. | [weak zone] ROAS 1.60 (28d) = 73% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further. |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-07 | 1337092034931256 | cut | null | 75 | 1,017.99 | 4 | 0.92 | creative_quality_weak, lifecycle_unavailable | ROAS 0.92 (28d) = 42% of target after $1,018 spend (28d) — clear loser at scale. |
| 2026-06-21 | 2533787297105379 | cut | null | 75 | 815.69 | 4 | 0.92 | creative_quality_weak, lifecycle_unavailable | ROAS 0.92 (28d) = 42% of target after $816 spend (28d) — loss-budget maturity reached at $269; cut underperforming creative. |
| 2026-06-28 | 1003770772089284 | cut | null | 75 | 496.11 | 3 | 0.93 | creative_quality_weak, lifecycle_unavailable | ROAS 0.93 (28d) = 42% of target after $496 spend (28d) — loss-budget maturity reached at $269; cut underperforming creative. |
| 2026-06-27 | 1003770772089284 | cut | null | 75 | 489.21 | 3 | 0.95 | creative_quality_weak, lifecycle_unavailable | ROAS 0.95 (28d) = 43% of target after $489 spend (28d) — loss-budget maturity reached at $269; cut underperforming creative. |
| 2026-06-29 | 1003770772089284 | cut | null | 75 | 478.95 | 3 | 0.97 | creative_quality_weak, lifecycle_unavailable | ROAS 0.97 (28d) = 44% of target after $479 spend (28d) — loss-budget maturity reached at $269; cut underperforming creative. |
| 2026-06-30 | 1003770772089284 | cut | null | 75 | 476.76 | 3 | 0.97 | creative_quality_weak, lifecycle_unavailable | ROAS 0.97 (28d) = 44% of target after $477 spend (28d) — loss-budget maturity reached at $267; cut underperforming creative. |
| 2026-07-02 | 1003770772089284 | cut | null | 75 | 474.99 | 3 | 0.97 | creative_quality_weak, lifecycle_unavailable | ROAS 0.97 (28d) = 44% of target after $475 spend (28d) — loss-budget maturity reached at $265; cut underperforming creative. |
| 2026-07-01 | 1003770772089284 | cut | null | 75 | 473.62 | 3 | 0.98 | creative_quality_weak, lifecycle_unavailable | ROAS 0.98 (28d) = 44% of target after $474 spend (28d) — loss-budget maturity reached at $264; cut underperforming creative. |
| 2026-06-01 | 693776863669477 | cut | null | 75 | 387.34 | 2 | 0.85 | creative_quality_weak, lifecycle_unavailable | ROAS 0.85 (28d) = 38% of target after $387 spend (28d) — loss-budget maturity reached at $265; cut underperforming creative. |
| 2026-06-02 | 693776863669477 | cut | null | 75 | 381.07 | 2 | 0.86 | creative_quality_weak, lifecycle_unavailable | ROAS 0.86 (28d) = 39% of target after $381 spend (28d) — loss-budget maturity reached at $265; cut underperforming creative. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-14 | 14 | 27134621589538352 | keep | positive | non_hard_missed_scale_opportunity | 281.59 | 605.25 | 4.72 |
| 2026-06-15 | 14 | 27134621589538352 | diagnose | positive | non_hard_missed_scale_opportunity | 331.56 | 595.38 | 3.24 |
| 2026-06-06 | 14 | 2533787297105379 | keep | positive | non_hard_missed_cut_opportunity | 274.91 | 579.50 | 0.98 |
| 2026-06-13 | 14 | 1337092034931256 | diagnose | positive | non_hard_missed_cut_opportunity | 811.07 | 536.42 | 0.73 |
| 2026-06-01 | 14 | 2533787297105379 | test_more | positive | non_hard_missed_cut_opportunity | 193.16 | 529.63 | 0.82 |
| 2026-06-01 | 14 | 3248297215341499 | diagnose | positive | non_hard_missed_scale_opportunity | 498.26 | 526.17 | 3.79 |
| 2026-06-06 | 14 | 27134621589538352 | test_more | positive | non_hard_missed_scale_opportunity | 0.43 | 525.20 | 4.51 |
| 2026-06-08 | 14 | 1337092034931256 | keep | positive | non_hard_missed_cut_opportunity | 998.58 | 483.58 | 0.81 |
| 2026-06-13 | 14 | 1008549465472004 | diagnose | positive | non_hard_missed_cut_opportunity | 350.70 | 363.40 | 0.93 |
| 2026-06-01 | 7 | 1491639495754377 | keep | positive | non_hard_missed_cut_opportunity | 1,583.11 | 354.47 | 0.84 |

### IwaStore

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-20 | 931776873000095 | cut | null | 75 | 411.94 | 8 | 2.41 | lifecycle_unavailable | ROAS 2.41 (28d) = 69% of target after $412 spend (28d) — clear loser at scale. |
| 2026-06-21 | 931776873000095 | cut | null | 75 | 405.43 | 9 | 2.71 | lifecycle_unavailable | ROAS 2.71 (28d) = 77% of target after $405 spend (28d) — clear loser at scale. |
| 2026-06-08 | 1597946391493220 | cut | null | 75 | 230.55 | 4 | 1.42 | creative_quality_weak, lifecycle_unavailable | ROAS 1.42 (28d) = 41% of target after $231 spend (28d) — sustained loser. |
| 2026-06-13 | 1597946391493220 | cut | null | 75 | 223.67 | 2 | 0.87 | creative_quality_weak, lifecycle_unavailable | ROAS 0.87 (28d) = 25% of target after $224 spend (28d) — sustained loser. |
| 2026-06-10 | 1597946391493220 | cut | null | 75 | 223.52 | 2 | 0.87 | creative_quality_weak, lifecycle_unavailable | ROAS 0.87 (28d) = 25% of target after $224 spend (28d) — sustained loser. |
| 2026-06-09 | 1597946391493220 | cut | null | 75 | 223.21 | 2 | 0.88 | creative_quality_weak, lifecycle_unavailable | ROAS 0.88 (28d) = 25% of target after $223 spend (28d) — sustained loser. |
| 2026-06-11 | 1597946391493220 | cut | null | 75 | 220.03 | 2 | 0.89 | creative_quality_weak, lifecycle_unavailable | ROAS 0.89 (28d) = 25% of target after $220 spend (28d) — sustained loser. |
| 2026-06-12 | 1597946391493220 | cut | null | 75 | 220.03 | 2 | 0.89 | creative_quality_weak, lifecycle_unavailable | ROAS 0.89 (28d) = 25% of target after $220 spend (28d) — sustained loser. |
| 2026-06-14 | 1597946391493220 | cut | null | 75 | 211.85 | 2 | 0.92 | creative_quality_weak, lifecycle_unavailable | ROAS 0.92 (28d) = 26% of target after $212 spend (28d) — sustained loser. |
| 2026-06-22 | 1655577498670460 | cut | null | 75 | 198.07 | 2 | 2.16 | lifecycle_unavailable | ROAS 2.16 (28d) = 62% of target after $198 spend (28d) — loss-budget maturity reached at $100; cut underperforming creative. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-01 | 14 | 1658131231999984 | scale | negative | scale_failed_recent_hold | 4,127.06 | 2,249.38 | 2.77 |
| 2026-06-14 | 14 | 946471284944193 | keep | positive | non_hard_missed_scale_opportunity | 604.30 | 399.19 | 5.54 |
| 2026-06-19 | 14 | 946471284944193 | scale | positive | scale_held_above_target | 621.18 | 325.48 | 4.90 |
| 2026-06-01 | 14 | 946471284944193 | scale | positive | scale_held_above_target | 616.57 | 294.08 | 6.37 |
| 2026-06-19 | 7 | 946471284944193 | scale | positive | scale_held_above_target | 621.18 | 216.60 | 4.38 |
| 2026-06-14 | 7 | 946471284944193 | keep | positive | non_hard_missed_scale_opportunity | 604.30 | 182.29 | 6.07 |
| 2026-06-20 | 14 | 931776873000095 | cut | negative | cut_recovered_above_target | 411.94 | 172.27 | 4.28 |
| 2026-06-15 | 14 | 1655577498670460 | keep | positive | non_hard_missed_scale_opportunity | 160.43 | 129.03 | 14.26 |
| 2026-06-08 | 14 | 1655577498670460 | scale | negative | scale_failed_recent_hold | 129.09 | 127.11 | 0.89 |
| 2026-06-01 | 7 | 931776873000095 | keep | positive | non_hard_missed_scale_opportunity | 1,044.90 | 124.70 | 4.57 |

### TheSwaf

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-07-05 | 1007048011875307 | cut | null | 80 | 720.47 | 0 | 0.00 | creative_quality_weak | 0 purchases on $720 spend (28d cumulative, age 43d) — sustained zero-conversion burn past CPA-anchored maturity threshold $187. |
| 2026-07-04 | 1007048011875307 | cut | null | 80 | 678.36 | 0 | 0.00 | creative_quality_weak | 0 purchases on $678 spend (28d cumulative, age 42d) — sustained zero-conversion burn past CPA-anchored maturity threshold $188. |
| 2026-07-03 | 1007048011875307 | cut | null | 80 | 624.30 | 0 | 0.00 | creative_quality_weak | 0 purchases on $624 spend (28d cumulative, age 41d) — sustained zero-conversion burn past CPA-anchored maturity threshold $188. |
| 2026-07-02 | 1007048011875307 | cut | null | 80 | 596.72 | 0 | 0.00 | creative_quality_weak | 0 purchases on $597 spend (28d cumulative, age 40d) — sustained zero-conversion burn past CPA-anchored maturity threshold $189. |
| 2026-07-04 | 1962656064410174 | cut | null | 75 | 7,146.16 | 25 | 0.71 | creative_quality_weak | ROAS 0.71 (28d) = 32% of target after $7,146 spend (28d) — clear loser at scale. |
| 2026-07-03 | 1962656064410174 | cut | null | 75 | 7,014.87 | 23 | 0.68 | creative_quality_weak | ROAS 0.68 (28d) = 31% of target after $7,015 spend (28d) — clear loser at scale. |
| 2026-07-01 | 1962656064410174 | cut | null | 75 | 6,761.53 | 21 | 0.64 | creative_quality_weak, lifecycle_unavailable | ROAS 0.64 (28d) = 29% of target after $6,762 spend (28d) — clear loser at scale. |
| 2026-07-01 | 3041651776171249 | cut | null | 75 | 6,543.77 | 34 | 0.74 | lifecycle_unavailable | ROAS 0.74 (28d) = 34% of target after $6,544 spend (28d) — clear loser at scale. |
| 2026-06-30 | 1962656064410174 | cut | null | 75 | 6,521.23 | 20 | 0.63 | creative_quality_weak, lifecycle_unavailable | ROAS 0.63 (28d) = 29% of target after $6,521 spend (28d) — clear loser at scale. |
| 2026-06-29 | 1962656064410174 | cut | null | 75 | 6,265.99 | 19 | 0.63 | creative_quality_weak, lifecycle_unavailable | ROAS 0.63 (28d) = 29% of target after $6,266 spend (28d) — clear loser at scale. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-16 | 14 | 1345674994165648 | cut | positive | cut_loss_continued | 1,137.45 | 9,282.39 | 1.17 |
| 2026-06-17 | 14 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 1,775.29 | 9,086.09 | 1.18 |
| 2026-06-14 | 14 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 232.35 | 8,947.62 | 1.09 |
| 2026-06-14 | 14 | 1672191184091002 | cut | positive | cut_loss_continued | 792.78 | 7,658.45 | 1.02 |
| 2026-06-21 | 14 | 1672191184091002 | keep | positive | non_hard_missed_cut_opportunity | 4,707.14 | 7,192.85 | 1.28 |
| 2026-06-14 | 14 | 1962656064410174 | cut | positive | cut_loss_continued | 195.78 | 5,858.14 | 0.57 |
| 2026-06-21 | 14 | 3041651776171249 | cut | positive | cut_loss_continued | 2,252.97 | 5,812.22 | 0.74 |
| 2026-06-16 | 14 | 3041651776171249 | keep | positive | non_hard_missed_cut_opportunity | 309.90 | 5,794.56 | 0.69 |
| 2026-06-15 | 14 | 3041651776171249 | test_more | positive | non_hard_missed_cut_opportunity | 109.15 | 5,635.73 | 0.64 |
| 2026-06-14 | 14 | 3041651776171249 | diagnose | positive | non_hard_missed_cut_opportunity | 43.47 | 5,321.08 | 0.68 |
