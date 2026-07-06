# Current Engine Historical Replay - 2026-06-01 to 2026-06-20

Generated at: 2026-07-05T22:44:56.295Z
Current date assumed by run: 2026-07-05
Engine version: `v3-2026-07-02-math-guardrails`
Outcome classifier: `creative-outcome-classifier.v2`
Replay window: 2026-06-01 -> 2026-06-20
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

## Global Summary

- Businesses found: 4
- Dates replayed: 20
- Decision rows: 9571
- Unique business+creative pairs: 644
- Label mix: test_more: 7076, keep: 890, diagnose: 833, cut: 592, out_of_scope: 130, scale: 50
- Source mode days: runtime_sql_fallback: 80
- Open outcome windows: 0
- Closed daily outcome rows: 19142
- Episode-deduped outcome rows: 1622
- Known episodes: 923
- Unknown episodes: 699

## Business Summary

| Business | Demo | Days | Failed | Decisions | Unique creatives | Labels | Hard rows | Blocked rows | Source modes | Profile ranges | Risk hints |
|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|---|
| EMOLOS | no | 20 | 0 | 2726 | 205 | test_more: 2225, keep: 262, cut: 187, diagnose: 52 | 187 | 51 | runtime_sql_fallback: 20 | spendUnit 34.45-35.39, commercialMaturitySpend 68.90-70.78, hardCutSpend 172.24-176.95, bottomQuartileRatio 0.23-0.25, severeLoserRatio 0.13-0.16, scaleMinPurchases 1.00-1.00, winnerPurchaseP50 1.00-1.00, matureCreativeCount 39.00-50.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| Grandmix | no | 20 | 0 | 1580 | 122 | test_more: 1072, keep: 222, diagnose: 209, cut: 74, scale: 3 | 77 | 66 | runtime_sql_fallback: 20 | spendUnit 106.05-108.51, commercialMaturitySpend 265.12-271.28, hardCutSpend 848.38-868.11, bottomQuartileRatio 0.41-0.48, severeLoserRatio 0.19-0.23, scaleMinPurchases 4.00-6.00, winnerPurchaseP50 2.50-4.00, matureCreativeCount 55.00-66.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| IwaStore | no | 20 | 0 | 1052 | 58 | test_more: 679, out_of_scope: 124, diagnose: 115, keep: 76, scale: 45, cut: 13 | 58 | 0 | runtime_sql_fallback: 20 | spendUnit 48.95-50.88, commercialMaturitySpend 97.91-101.77, hardCutSpend 244.76-254.42, bottomQuartileRatio 0.57-0.72, severeLoserRatio 0.42-0.49, scaleMinPurchases 2.00-3.00, winnerPurchaseP50 2.00-3.00, matureCreativeCount 59.00-96.00 | raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| TheSwaf | no | 20 | 0 | 4213 | 259 | test_more: 3100, diagnose: 457, keep: 330, cut: 318, out_of_scope: 6, scale: 2 | 320 | 197 | runtime_sql_fallback: 20 | spendUnit 92.98-95.07, commercialMaturitySpend 139.48-142.60, hardCutSpend 278.95-285.21, bottomQuartileRatio 0.39-0.46, severeLoserRatio 0.26-0.33, scaleMinPurchases 1.00-2.00, winnerPurchaseP50 1.00-2.00, matureCreativeCount 79.00-111.00 | campaign_label_guard_blocked_hard_actions, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |

## Fidelity Check vs Persisted Snapshots

This is the replay-faithfulness anchor requested by Claude: 2026-07-03 and 2026-07-04 replay rows are compared with actual persisted current-version snapshots. Low fidelity does not automatically mean the formula is wrong; it means replay mode/provenance differs and the historical result must be discounted accordingly.

| Business | Date | Source mode | Replay rows | Snapshot rows | Common | Label match | Label+confidence match | Replay-only | Snapshot-only |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| EMOLOS | 2026-07-03 | - | 0 | 277 | 0 | - | - | 0 | 277 |
| EMOLOS | 2026-07-04 | - | 0 | 277 | 0 | - | - | 0 | 277 |
| Grandmix | 2026-07-03 | - | 0 | 169 | 0 | - | - | 0 | 169 |
| Grandmix | 2026-07-04 | - | 0 | 169 | 0 | - | - | 0 | 169 |
| IwaStore | 2026-07-03 | - | 0 | 152 | 0 | - | - | 0 | 152 |
| IwaStore | 2026-07-04 | - | 0 | 155 | 0 | - | - | 0 | 155 |
| TheSwaf | 2026-07-03 | - | 0 | 284 | 0 | - | - | 0 | 284 |
| TheSwaf | 2026-07-04 | - | 0 | 284 | 0 | - | - | 0 | 284 |

## Fidelity Mismatch Notes

Sampled replay-vs-snapshot mismatches are listed explicitly so the fidelity rate cannot hide boundary-class differences.

- EMOLOS 2026-07-03 creative 1000487319029766: replay null/null vs snapshot test_more/70; replay reason "null", snapshot reason "Below commercial maturity (28d spend $4 < $70 loss-budget floor, 0 purchases, age 28d) — let the creative accumulate signal.".
- EMOLOS 2026-07-03 creative 1002568185675658: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 45d) — let the creative accumulate signal.".
- EMOLOS 2026-07-03 creative 1005965712212138: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $2 < $70 loss-budget floor, 0 purchases, age 27d) — let the creative accumulate signal.".
- EMOLOS 2026-07-03 creative 1007889655170360: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $11 < $70 loss-budget floor, 0 purchases, age 14d) — let the creative accumulate signal.".
- EMOLOS 2026-07-03 creative 1013506931191305: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 45d) — let the creative accumulate signal.".
- EMOLOS 2026-07-03 creative 1015151468123714: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $10 < $70 loss-budget floor, 0 purchases, age 27d) — let the creative accumulate signal.".
- EMOLOS 2026-07-03 creative 1017459037607213: replay null/null vs snapshot diagnose/70; replay reason "null", snapshot reason "Landing page issue: Link-to-LPV 57.41% vs account baseline 65.00%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.".
- EMOLOS 2026-07-03 creative 1019631847407242: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 44d) — let the creative accumulate signal.".
- EMOLOS 2026-07-04 creative 1000487319029766: replay null/null vs snapshot test_more/70; replay reason "null", snapshot reason "Below commercial maturity (28d spend $4 < $70 loss-budget floor, 0 purchases, age 29d) — let the creative accumulate signal.".
- EMOLOS 2026-07-04 creative 1002568185675658: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 46d) — let the creative accumulate signal.".
- EMOLOS 2026-07-04 creative 1005965712212138: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $2 < $70 loss-budget floor, 0 purchases, age 28d) — let the creative accumulate signal.".
- EMOLOS 2026-07-04 creative 1007889655170360: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $18 < $70 loss-budget floor, 0 purchases, age 15d) — let the creative accumulate signal.".
- EMOLOS 2026-07-04 creative 1013506931191305: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 46d) — let the creative accumulate signal.".
- EMOLOS 2026-07-04 creative 1015151468123714: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $7 < $70 loss-budget floor, 0 purchases, age 28d) — let the creative accumulate signal.".
- EMOLOS 2026-07-04 creative 1017459037607213: replay null/null vs snapshot diagnose/70; replay reason "null", snapshot reason "Landing page issue: Link-to-LPV 57.45% vs account baseline 66.35%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.".
- EMOLOS 2026-07-04 creative 1019631847407242: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 45d) — let the creative accumulate signal.".
- Grandmix 2026-07-03 creative 1001598219029844: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $263 loss-budget floor, 0 purchases, age 61d) — let the creative accumulate signal.".
- Grandmix 2026-07-03 creative 1002617308929281: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $10 < $263 loss-budget floor, 0 purchases, age 48d) — let the creative accumulate signal.".
- Grandmix 2026-07-03 creative 1003770772089284: replay null/null vs snapshot cut/72; replay reason "null", snapshot reason "ROAS 1.00 (28d) = 45% of target after $464 spend (28d) — loss-budget maturity reached at $263; cut underperforming creative.".
- Grandmix 2026-07-03 creative 1005337862441315: replay null/null vs snapshot test_more/70; replay reason "null", snapshot reason "Below commercial maturity (28d spend $5 < $263 loss-budget floor, 0 purchases, age 48d) — let the creative accumulate signal.".
- Grandmix 2026-07-03 creative 1008549465472004: replay null/null vs snapshot keep/75; replay reason "null", snapshot reason "[demote candidate] ROAS 1.16 (28d) = 53% of target — above account bottom quartile (46%) but below breakeven (1.80 = 82% of target) at $869 mature spend — consider demote to test placement or refresh creative concept.".
- Grandmix 2026-07-03 creative 1009246025120804: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $263 loss-budget floor, 0 purchases, age 43d) — let the creative accumulate signal.".
- Grandmix 2026-07-03 creative 1009827774896101: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $5 < $263 loss-budget floor, 0 purchases, age 5d) — let the creative accumulate signal.".
- Grandmix 2026-07-03 creative 1010946998578771: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $58 < $263 loss-budget floor, 0 purchases, age 5d) — let the creative accumulate signal.".
- Grandmix 2026-07-04 creative 1001598219029844: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $262 loss-budget floor, 0 purchases, age 62d) — let the creative accumulate signal.".
- Grandmix 2026-07-04 creative 1002617308929281: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $10 < $262 loss-budget floor, 0 purchases, age 49d) — let the creative accumulate signal.".
- Grandmix 2026-07-04 creative 1003770772089284: replay null/null vs snapshot keep/75; replay reason "null", snapshot reason "[weak zone] ROAS 1.43 (28d) = 65% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.".
- Grandmix 2026-07-04 creative 1005337862441315: replay null/null vs snapshot test_more/70; replay reason "null", snapshot reason "Below commercial maturity (28d spend $5 < $262 loss-budget floor, 0 purchases, age 49d) — let the creative accumulate signal.".
- Grandmix 2026-07-04 creative 1008549465472004: replay null/null vs snapshot keep/75; replay reason "null", snapshot reason "[demote candidate] ROAS 1.37 (28d) = 62% of target — above account bottom quartile (46%) but below breakeven (1.80 = 82% of target) at $898 mature spend — consider demote to test placement or refresh creative concept.".
- Grandmix 2026-07-04 creative 1009246025120804: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $262 loss-budget floor, 0 purchases, age 44d) — let the creative accumulate signal.".
- Grandmix 2026-07-04 creative 1009827774896101: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $5 < $262 loss-budget floor, 0 purchases, age 6d) — let the creative accumulate signal.".
- Grandmix 2026-07-04 creative 1010946998578771: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $58 < $262 loss-budget floor, 0 purchases, age 6d) — let the creative accumulate signal.".
- IwaStore 2026-07-03 creative 1003444735733770: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $6 < $100 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.".
- IwaStore 2026-07-03 creative 1020781523695732: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $100 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.".
- IwaStore 2026-07-03 creative 1025468773398763: replay null/null vs snapshot diagnose/70; replay reason "null", snapshot reason "Landing page issue: LPV-to-ATC 1.59% vs account baseline 4.76%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.".
- IwaStore 2026-07-03 creative 1028452980202623: replay null/null vs snapshot diagnose/50; replay reason "null", snapshot reason "[Stop-loss review - label campaign before cut] ROAS 0.85 (28d) = 24% of target after $117 spend (28d) — loss-budget maturity reached at $100; cut underperforming creative.".
- IwaStore 2026-07-03 creative 1033784855709309: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $10 < $100 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.".
- IwaStore 2026-07-03 creative 1037962691982511: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $100 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.".
- IwaStore 2026-07-03 creative 1038055285394393: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $32 < $100 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.".
- IwaStore 2026-07-03 creative 1038550568592146: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $90 < $100 loss-budget floor, 1 purchases, age 2d) — let the creative accumulate signal.".
- IwaStore 2026-07-04 creative 1003444735733770: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $6 < $99 loss-budget floor, 0 purchases, age 3d) — let the creative accumulate signal.".
- IwaStore 2026-07-04 creative 1016479011077401: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.".
- IwaStore 2026-07-04 creative 1020781523695732: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.".
- IwaStore 2026-07-04 creative 1025468773398763: replay null/null vs snapshot diagnose/70; replay reason "null", snapshot reason "Landing page issue: LPV-to-ATC 1.59% vs account baseline 4.99%. This is a funnel-step diagnosis, not proof that the creative itself is the problem.".
- IwaStore 2026-07-04 creative 1028452980202623: replay null/null vs snapshot diagnose/50; replay reason "null", snapshot reason "[Stop-loss review - label campaign before cut] ROAS 1.98 (28d) = 57% of target after $148 spend (28d) — loss-budget maturity reached at $99; cut underperforming creative.".
- IwaStore 2026-07-04 creative 1033784855709309: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $12 < $99 loss-budget floor, 0 purchases, age 3d) — let the creative accumulate signal.".
- IwaStore 2026-07-04 creative 1037962691982511: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $99 loss-budget floor, 0 purchases, age 3d) — let the creative accumulate signal.".
- IwaStore 2026-07-04 creative 1038055285394393: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $49 < $99 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.".
- TheSwaf 2026-07-03 creative 1000844809459077: replay null/null vs snapshot cut/72; replay reason "null", snapshot reason "ROAS 0.79 (28d) = 36% of target after $699 spend (28d) — clear loser at scale.".
- TheSwaf 2026-07-03 creative 1002443442283933: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $100 < $141 loss-budget floor, 0 purchases, age 28d) — let the creative accumulate signal.".
- TheSwaf 2026-07-03 creative 1007048011875307: replay null/null vs snapshot cut/80; replay reason "null", snapshot reason "0 purchases on $624 spend (28d cumulative, age 41d) — sustained zero-conversion burn past CPA-anchored maturity threshold $188.".
- TheSwaf 2026-07-03 creative 1008302678413358: replay null/null vs snapshot keep/65; replay reason "null", snapshot reason "[demote candidate] ROAS 1.27 (28d) = 58% of target — above account bottom quartile (39%) but below breakeven (1.71 = 78% of target) at $502 mature spend — consider demote to test placement or refresh creative concept.".
- TheSwaf 2026-07-03 creative 1014356057726711: replay null/null vs snapshot keep/65; replay reason "null", snapshot reason "[weak zone] ROAS 0.93 (28d) = 42% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.".
- TheSwaf 2026-07-03 creative 1015107537840127: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 41d) — let the creative accumulate signal.".
- TheSwaf 2026-07-03 creative 1017029037335130: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 40d) — let the creative accumulate signal.".
- TheSwaf 2026-07-03 creative 1017999650906955: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 39d) — let the creative accumulate signal.".
- TheSwaf 2026-07-04 creative 1000844809459077: replay null/null vs snapshot cut/72; replay reason "null", snapshot reason "ROAS 0.78 (28d) = 35% of target after $711 spend (28d) — clear loser at scale.".
- TheSwaf 2026-07-04 creative 1002443442283933: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $86 < $141 loss-budget floor, 0 purchases, age 29d) — let the creative accumulate signal.".
- TheSwaf 2026-07-04 creative 1007048011875307: replay null/null vs snapshot cut/80; replay reason "null", snapshot reason "0 purchases on $678 spend (28d cumulative, age 42d) — sustained zero-conversion burn past CPA-anchored maturity threshold $188.".
- TheSwaf 2026-07-04 creative 1008302678413358: replay null/null vs snapshot keep/65; replay reason "null", snapshot reason "[demote candidate] ROAS 1.39 (28d) = 63% of target — above account bottom quartile (39%) but below breakeven (1.71 = 78% of target) at $458 mature spend — consider demote to test placement or refresh creative concept.".
- TheSwaf 2026-07-04 creative 1014356057726711: replay null/null vs snapshot keep/65; replay reason "null", snapshot reason "[weak zone] ROAS 0.93 (28d) = 42% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.".
- TheSwaf 2026-07-04 creative 1015107537840127: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 42d) — let the creative accumulate signal.".
- TheSwaf 2026-07-04 creative 1017029037335130: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 41d) — let the creative accumulate signal.".
- TheSwaf 2026-07-04 creative 1017999650906955: replay null/null vs snapshot test_more/75; replay reason "null", snapshot reason "Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 40d) — let the creative accumulate signal.".

## Outcome Episode Summary

`open_window` is not `unknown`: open means the 7d/14d forward window has not closed by 2026-07-05. `unknown` means the window is closed but the classifier cannot infer outcome, most commonly zero forward spend or missing target. Precision/missed-opportunity proxy below is episode-deduped, not daily-row counted.

| Business | Window | Label | Class | Open rows | Closed daily rows | Episodes | Known | Unknown | Positive | Negative | Neutral | Zero-forward unknown | Positive rate known | Reliability |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| EMOLOS | 7 | cut | hard | 0 | 187 | 13 | 6 | 7 | 6 | 0 | 0 | 7 | 100.0% | insufficient |
| EMOLOS | 7 | diagnose | non_hard | 0 | 52 | 9 | 8 | 1 | 6 | 0 | 2 | 1 | 75.0% | insufficient |
| EMOLOS | 7 | keep | non_hard | 0 | 262 | 25 | 15 | 10 | 14 | 0 | 1 | 10 | 93.3% | directional |
| EMOLOS | 7 | test_more | non_hard | 0 | 2225 | 179 | 97 | 82 | 95 | 0 | 2 | 82 | 97.9% | defensible |
| EMOLOS | 14 | cut | hard | 0 | 187 | 13 | 6 | 7 | 6 | 0 | 0 | 7 | 100.0% | insufficient |
| EMOLOS | 14 | diagnose | non_hard | 0 | 52 | 9 | 8 | 1 | 6 | 0 | 2 | 1 | 75.0% | insufficient |
| EMOLOS | 14 | keep | non_hard | 0 | 262 | 25 | 15 | 10 | 13 | 0 | 2 | 10 | 86.7% | directional |
| EMOLOS | 14 | test_more | non_hard | 0 | 2225 | 179 | 97 | 82 | 95 | 0 | 2 | 82 | 97.9% | defensible |
| Grandmix | 7 | cut | hard | 0 | 74 | 9 | 3 | 6 | 1 | 2 | 0 | 6 | 33.3% | insufficient |
| Grandmix | 7 | scale | hard | 0 | 3 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0.0% | insufficient |
| Grandmix | 7 | diagnose | non_hard | 0 | 209 | 26 | 17 | 9 | 12 | 0 | 5 | 9 | 70.6% | directional |
| Grandmix | 7 | keep | non_hard | 0 | 222 | 25 | 20 | 5 | 12 | 0 | 8 | 5 | 60.0% | directional |
| Grandmix | 7 | test_more | non_hard | 0 | 1072 | 96 | 37 | 59 | 27 | 0 | 10 | 59 | 73.0% | defensible |
| Grandmix | 14 | cut | hard | 0 | 74 | 9 | 3 | 6 | 1 | 0 | 2 | 6 | 33.3% | insufficient |
| Grandmix | 14 | scale | hard | 0 | 3 | 2 | 2 | 0 | 0 | 2 | 0 | 0 | 0.0% | insufficient |
| Grandmix | 14 | diagnose | non_hard | 0 | 209 | 26 | 17 | 9 | 13 | 0 | 4 | 9 | 76.5% | directional |
| Grandmix | 14 | keep | non_hard | 0 | 222 | 25 | 20 | 5 | 14 | 0 | 6 | 5 | 70.0% | directional |
| Grandmix | 14 | test_more | non_hard | 0 | 1072 | 96 | 37 | 59 | 27 | 0 | 10 | 59 | 73.0% | defensible |
| IwaStore | 7 | cut | hard | 0 | 13 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 66.7% | insufficient |
| IwaStore | 7 | scale | hard | 0 | 45 | 8 | 7 | 1 | 3 | 2 | 2 | 1 | 42.9% | insufficient |
| IwaStore | 7 | diagnose | non_hard | 0 | 115 | 17 | 16 | 1 | 13 | 0 | 3 | 1 | 81.3% | directional |
| IwaStore | 7 | keep | non_hard | 0 | 76 | 11 | 11 | 0 | 8 | 0 | 3 | 0 | 72.7% | directional |
| IwaStore | 7 | out_of_scope | non_hard | 0 | 124 | 7 | 0 | 7 | 0 | 0 | 0 | 2 | - | insufficient |
| IwaStore | 7 | test_more | non_hard | 0 | 679 | 49 | 29 | 20 | 29 | 0 | 0 | 20 | 100.0% | directional |
| IwaStore | 14 | cut | hard | 0 | 13 | 3 | 3 | 0 | 2 | 1 | 0 | 0 | 66.7% | insufficient |
| IwaStore | 14 | scale | hard | 0 | 45 | 8 | 8 | 0 | 3 | 5 | 0 | 0 | 37.5% | insufficient |
| IwaStore | 14 | diagnose | non_hard | 0 | 115 | 17 | 16 | 1 | 13 | 0 | 3 | 1 | 81.3% | directional |
| IwaStore | 14 | keep | non_hard | 0 | 76 | 11 | 11 | 0 | 7 | 0 | 4 | 0 | 63.6% | directional |
| IwaStore | 14 | out_of_scope | non_hard | 0 | 124 | 7 | 0 | 7 | 0 | 0 | 0 | 2 | - | insufficient |
| IwaStore | 14 | test_more | non_hard | 0 | 679 | 49 | 30 | 19 | 29 | 0 | 1 | 19 | 96.7% | defensible |
| TheSwaf | 7 | cut | hard | 0 | 318 | 28 | 13 | 15 | 10 | 3 | 0 | 15 | 76.9% | directional |
| TheSwaf | 7 | scale | hard | 0 | 2 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0.0% | insufficient |
| TheSwaf | 7 | diagnose | non_hard | 0 | 457 | 62 | 37 | 25 | 28 | 0 | 9 | 25 | 75.7% | defensible |
| TheSwaf | 7 | keep | non_hard | 0 | 330 | 41 | 30 | 11 | 25 | 0 | 5 | 11 | 83.3% | defensible |
| TheSwaf | 7 | out_of_scope | non_hard | 0 | 6 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| TheSwaf | 7 | test_more | non_hard | 0 | 3100 | 199 | 108 | 91 | 93 | 0 | 15 | 91 | 86.1% | defensible |
| TheSwaf | 14 | cut | hard | 0 | 318 | 28 | 13 | 15 | 9 | 3 | 1 | 15 | 69.2% | directional |
| TheSwaf | 14 | scale | hard | 0 | 2 | 1 | 1 | 0 | 0 | 1 | 0 | 0 | 0.0% | insufficient |
| TheSwaf | 14 | diagnose | non_hard | 0 | 457 | 62 | 37 | 25 | 30 | 0 | 7 | 25 | 81.1% | defensible |
| TheSwaf | 14 | keep | non_hard | 0 | 330 | 41 | 30 | 11 | 23 | 0 | 7 | 11 | 76.7% | defensible |
| TheSwaf | 14 | out_of_scope | non_hard | 0 | 6 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| TheSwaf | 14 | test_more | non_hard | 0 | 3100 | 199 | 109 | 90 | 94 | 0 | 15 | 90 | 86.2% | defensible |

## Confidence Alignment Smoke

Hard and non-hard rows are deliberately separated. For hard actions, positive means the hard action proxy was supported. For non-hard rows, positive means a missed hard-action opportunity proxy; it is not the same polarity and must not be pooled with hard precision.

| Business | Window | Class | Bucket | Episodes | Known | Positive | Observed positive | Avg confidence | Abs gap |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| EMOLOS | 7 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| EMOLOS | 7 | hard | 70_79 | 7 | 6 | 6 | 100.0% | 75.0% | 25.0% |
| EMOLOS | 7 | non_hard | 50_59 | 8 | 7 | 6 | 85.7% | 50.0% | 35.7% |
| EMOLOS | 7 | non_hard | 60_69 | 10 | 0 | 0 | - | - | - |
| EMOLOS | 7 | non_hard | 70_79 | 195 | 113 | 109 | 96.5% | 75.0% | 21.5% |
| EMOLOS | 14 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| EMOLOS | 14 | hard | 70_79 | 7 | 6 | 6 | 100.0% | 75.0% | 25.0% |
| EMOLOS | 14 | non_hard | 50_59 | 8 | 7 | 6 | 85.7% | 50.0% | 35.7% |
| EMOLOS | 14 | non_hard | 60_69 | 10 | 0 | 0 | - | - | - |
| EMOLOS | 14 | non_hard | 70_79 | 195 | 113 | 108 | 95.6% | 75.0% | 20.6% |
| Grandmix | 7 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| Grandmix | 7 | hard | 70_79 | 5 | 5 | 1 | 20.0% | 75.0% | 55.0% |
| Grandmix | 7 | non_hard | 50_59 | 6 | 4 | 3 | 75.0% | 50.0% | 25.0% |
| Grandmix | 7 | non_hard | 60_69 | 5 | 0 | 0 | - | - | - |
| Grandmix | 7 | non_hard | 70_79 | 136 | 70 | 48 | 68.6% | 74.1% | 5.6% |
| Grandmix | 14 | hard | 60_69 | 6 | 0 | 0 | - | - | - |
| Grandmix | 14 | hard | 70_79 | 5 | 5 | 1 | 20.0% | 75.0% | 55.0% |
| Grandmix | 14 | non_hard | 50_59 | 6 | 4 | 3 | 75.0% | 50.0% | 25.0% |
| Grandmix | 14 | non_hard | 60_69 | 5 | 0 | 0 | - | - | - |
| Grandmix | 14 | non_hard | 70_79 | 136 | 70 | 51 | 72.9% | 74.1% | 1.3% |
| IwaStore | 7 | hard | 70_79 | 11 | 10 | 5 | 50.0% | 75.0% | 25.0% |
| IwaStore | 7 | non_hard | 60_69 | 7 | 0 | 0 | - | - | - |
| IwaStore | 7 | non_hard | 70_79 | 77 | 56 | 50 | 89.3% | 74.3% | 15.0% |
| IwaStore | 14 | hard | 70_79 | 11 | 11 | 5 | 45.5% | 75.0% | 29.5% |
| IwaStore | 14 | non_hard | 60_69 | 7 | 0 | 0 | - | - | - |
| IwaStore | 14 | non_hard | 70_79 | 77 | 57 | 49 | 86.0% | 74.2% | 11.8% |
| TheSwaf | 7 | hard | 60_69 | 7 | 0 | 0 | - | - | - |
| TheSwaf | 7 | hard | 70_79 | 22 | 14 | 10 | 71.4% | 75.0% | 3.6% |
| TheSwaf | 7 | non_hard | 50_59 | 27 | 25 | 18 | 72.0% | 50.0% | 22.0% |
| TheSwaf | 7 | non_hard | 60_69 | 6 | 0 | 0 | - | - | - |
| TheSwaf | 7 | non_hard | 70_79 | 270 | 150 | 128 | 85.3% | 74.6% | 10.8% |
| TheSwaf | 14 | hard | 60_69 | 7 | 0 | 0 | - | - | - |
| TheSwaf | 14 | hard | 70_79 | 22 | 14 | 9 | 64.3% | 75.0% | 10.7% |
| TheSwaf | 14 | non_hard | 50_59 | 27 | 25 | 19 | 76.0% | 50.0% | 26.0% |
| TheSwaf | 14 | non_hard | 60_69 | 6 | 0 | 0 | - | - | - |
| TheSwaf | 14 | non_hard | 70_79 | 270 | 151 | 128 | 84.8% | 74.6% | 10.2% |

## Confidence By Label And Source Mode

This is the deeper calibration table requested after the multi-window review. It keeps business, surfaced action label, outcome window, confidence bucket, and replay source-mode separate. Positive polarity is listed explicitly because hard labels and non-hard labels do not mean the same thing.

| Business | Window | Source mode | Label | Class | Bucket | Episodes | Known | Unknown | Positive | Negative | Neutral | Observed positive | Avg confidence | Abs gap | Reliability | Positive meaning |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| EMOLOS | 7 | runtime_sql_fallback | cut | hard | 60_69 | 6 | 0 | 6 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| EMOLOS | 7 | runtime_sql_fallback | cut | hard | 70_79 | 7 | 6 | 1 | 6 | 0 | 0 | 100.0% | 75.0% | 25.0% | insufficient | hard_action_supported |
| EMOLOS | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 8 | 7 | 1 | 6 | 0 | 1 | 85.7% | 50.0% | 35.7% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% | 75.0% | 75.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 179 | 97 | 82 | 95 | 0 | 2 | 97.9% | 75.0% | 22.9% | defensible | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 10 | 0 | 10 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 15 | 15 | 0 | 14 | 0 | 1 | 93.3% | 75.0% | 18.3% | directional | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | cut | hard | 60_69 | 6 | 0 | 6 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| EMOLOS | 14 | runtime_sql_fallback | cut | hard | 70_79 | 7 | 6 | 1 | 6 | 0 | 0 | 100.0% | 75.0% | 25.0% | insufficient | hard_action_supported |
| EMOLOS | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 8 | 7 | 1 | 6 | 0 | 1 | 85.7% | 50.0% | 35.7% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 1 | 1 | 0 | 0 | 0 | 1 | 0.0% | 75.0% | 75.0% | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 179 | 97 | 82 | 95 | 0 | 2 | 97.9% | 75.0% | 22.9% | defensible | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 10 | 0 | 10 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| EMOLOS | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 15 | 15 | 0 | 13 | 0 | 2 | 86.7% | 75.0% | 11.7% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | cut | hard | 60_69 | 6 | 0 | 6 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| Grandmix | 7 | runtime_sql_fallback | cut | hard | 70_79 | 3 | 3 | 0 | 1 | 2 | 0 | 33.3% | 75.0% | 41.7% | insufficient | hard_action_supported |
| Grandmix | 7 | runtime_sql_fallback | scale | hard | 70_79 | 2 | 2 | 0 | 0 | 2 | 0 | 0.0% | 75.0% | 75.0% | insufficient | hard_action_supported |
| Grandmix | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 6 | 4 | 2 | 3 | 0 | 1 | 75.0% | 50.0% | 25.0% | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 20 | 13 | 7 | 9 | 0 | 4 | 69.2% | 70.4% | 1.1% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 96 | 37 | 59 | 27 | 0 | 10 | 73.0% | 75.0% | 2.0% | defensible | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 5 | 0 | 5 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 20 | 20 | 0 | 12 | 0 | 8 | 60.0% | 75.0% | 15.0% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | cut | hard | 60_69 | 6 | 0 | 6 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| Grandmix | 14 | runtime_sql_fallback | cut | hard | 70_79 | 3 | 3 | 0 | 1 | 0 | 2 | 33.3% | 75.0% | 41.7% | insufficient | hard_action_supported |
| Grandmix | 14 | runtime_sql_fallback | scale | hard | 70_79 | 2 | 2 | 0 | 0 | 2 | 0 | 0.0% | 75.0% | 75.0% | insufficient | hard_action_supported |
| Grandmix | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 6 | 4 | 2 | 3 | 0 | 1 | 75.0% | 50.0% | 25.0% | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 20 | 13 | 7 | 10 | 0 | 3 | 76.9% | 70.4% | 6.5% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 96 | 37 | 59 | 27 | 0 | 10 | 73.0% | 75.0% | 2.0% | defensible | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 5 | 0 | 5 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 20 | 20 | 0 | 14 | 0 | 6 | 70.0% | 75.0% | 5.0% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | cut | hard | 70_79 | 3 | 3 | 0 | 2 | 1 | 0 | 66.7% | 75.0% | 8.3% | insufficient | hard_action_supported |
| IwaStore | 7 | runtime_sql_fallback | scale | hard | 70_79 | 8 | 7 | 1 | 3 | 2 | 2 | 42.9% | 75.0% | 32.1% | insufficient | hard_action_supported |
| IwaStore | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 17 | 16 | 1 | 13 | 0 | 3 | 81.3% | 72.5% | 8.8% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 49 | 29 | 20 | 29 | 0 | 0 | 100.0% | 75.0% | 25.0% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 11 | 11 | 0 | 8 | 0 | 3 | 72.7% | 75.0% | 2.3% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 7 | 0 | 7 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | cut | hard | 70_79 | 3 | 3 | 0 | 2 | 1 | 0 | 66.7% | 75.0% | 8.3% | insufficient | hard_action_supported |
| IwaStore | 14 | runtime_sql_fallback | scale | hard | 70_79 | 8 | 8 | 0 | 3 | 5 | 0 | 37.5% | 75.0% | 37.5% | insufficient | hard_action_supported |
| IwaStore | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 17 | 16 | 1 | 13 | 0 | 3 | 81.3% | 72.5% | 8.8% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 49 | 30 | 19 | 29 | 0 | 1 | 96.7% | 74.8% | 21.8% | defensible | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 11 | 11 | 0 | 7 | 0 | 4 | 63.6% | 75.0% | 11.4% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 7 | 0 | 7 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | cut | hard | 60_69 | 7 | 0 | 7 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| TheSwaf | 7 | runtime_sql_fallback | cut | hard | 70_79 | 21 | 13 | 8 | 10 | 3 | 0 | 76.9% | 75.0% | 1.9% | directional | hard_action_supported |
| TheSwaf | 7 | runtime_sql_fallback | scale | hard | 70_79 | 1 | 1 | 0 | 0 | 1 | 0 | 0.0% | 75.0% | 75.0% | insufficient | hard_action_supported |
| TheSwaf | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 27 | 25 | 2 | 18 | 0 | 7 | 72.0% | 50.0% | 22.0% | directional | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 35 | 12 | 23 | 10 | 0 | 2 | 83.3% | 70.8% | 12.5% | directional | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | test_more | non_hard | 70_79 | 199 | 108 | 91 | 93 | 0 | 15 | 86.1% | 74.9% | 11.3% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 5 | 0 | 5 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | keep | non_hard | 70_79 | 36 | 30 | 6 | 25 | 0 | 5 | 83.3% | 75.0% | 8.3% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | cut | hard | 60_69 | 7 | 0 | 7 | 0 | 0 | 0 | - | - | - | insufficient | hard_action_supported |
| TheSwaf | 14 | runtime_sql_fallback | cut | hard | 70_79 | 21 | 13 | 8 | 9 | 3 | 1 | 69.2% | 75.0% | 5.8% | directional | hard_action_supported |
| TheSwaf | 14 | runtime_sql_fallback | scale | hard | 70_79 | 1 | 1 | 0 | 0 | 1 | 0 | 0.0% | 75.0% | 75.0% | insufficient | hard_action_supported |
| TheSwaf | 14 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 27 | 25 | 2 | 19 | 0 | 6 | 76.0% | 50.0% | 26.0% | directional | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | diagnose | non_hard | 70_79 | 35 | 12 | 23 | 11 | 0 | 1 | 91.7% | 70.8% | 20.8% | directional | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | test_more | non_hard | 70_79 | 199 | 109 | 90 | 94 | 0 | 15 | 86.2% | 74.9% | 11.4% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | keep | non_hard | 60_69 | 5 | 0 | 5 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | keep | non_hard | 70_79 | 36 | 30 | 6 | 23 | 0 | 7 | 76.7% | 75.0% | 1.7% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 14 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |

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

## Business Samples

### EMOLOS

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1000487319029766 | null | test_more | null | 70 | null | Below commercial maturity (28d spend $4 < $70 loss-budget floor, 0 purchases, age 28d) — let the creative accumulate signal. |
| 1002568185675658 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 45d) — let the creative accumulate signal. |
| 1005965712212138 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $2 < $70 loss-budget floor, 0 purchases, age 27d) — let the creative accumulate signal. |
| 1007889655170360 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $11 < $70 loss-budget floor, 0 purchases, age 14d) — let the creative accumulate signal. |
| 1013506931191305 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 45d) — let the creative accumulate signal. |
| 1015151468123714 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $10 < $70 loss-budget floor, 0 purchases, age 27d) — let the creative accumulate signal. |
| 1017459037607213 | null | diagnose | null | 70 | null | Landing page issue: Link-to-LPV 57.41% vs account baseline 65.00%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. |
| 1019631847407242 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $70 loss-budget floor, 0 purchases, age 44d) — let the creative accumulate signal. |

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

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-03 | 14 | 1683734522755632 | test_more | positive | non_hard_missed_cut_opportunity | 23.61 | 1,175.02 | 0.69 |
| 2026-06-20 | 14 | 2114021279176127 | keep | positive | non_hard_missed_cut_opportunity | 74.95 | 1,044.64 | 0.55 |
| 2026-06-19 | 14 | 2114021279176127 | test_more | positive | non_hard_missed_cut_opportunity | 9.66 | 1,037.38 | 0.61 |
| 2026-06-03 | 7 | 1683734522755632 | test_more | positive | non_hard_missed_cut_opportunity | 23.61 | 953.95 | 0.65 |
| 2026-06-19 | 14 | 882021054308247 | test_more | positive | non_hard_missed_cut_opportunity | 8.86 | 936.09 | 0.18 |
| 2026-06-05 | 14 | 1457831769435391 | keep | positive | non_hard_missed_cut_opportunity | 135.19 | 917.73 | 0.55 |
| 2026-06-05 | 14 | 1683734522755632 | keep | positive | non_hard_missed_cut_opportunity | 358.20 | 861.89 | 0.65 |
| 2026-06-05 | 7 | 1457831769435391 | keep | positive | non_hard_missed_cut_opportunity | 135.19 | 846.35 | 0.59 |

### Grandmix

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1001598219029844 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $263 loss-budget floor, 0 purchases, age 61d) — let the creative accumulate signal. |
| 1002617308929281 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $10 < $263 loss-budget floor, 0 purchases, age 48d) — let the creative accumulate signal. |
| 1003770772089284 | null | cut | null | 72 | null | ROAS 1.00 (28d) = 45% of target after $464 spend (28d) — loss-budget maturity reached at $263; cut underperforming creative. |
| 1005337862441315 | null | test_more | null | 70 | null | Below commercial maturity (28d spend $5 < $263 loss-budget floor, 0 purchases, age 48d) — let the creative accumulate signal. |
| 1008549465472004 | null | keep | null | 75 | null | [demote candidate] ROAS 1.16 (28d) = 53% of target — above account bottom quartile (46%) but below breakeven (1.80 = 82% of target) at $869 mature spend — consider demote to test placement or refresh creative concept. |
| 1009246025120804 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $263 loss-budget floor, 0 purchases, age 43d) — let the creative accumulate signal. |
| 1009827774896101 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $5 < $263 loss-budget floor, 0 purchases, age 5d) — let the creative accumulate signal. |
| 1010946998578771 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $58 < $263 loss-budget floor, 0 purchases, age 5d) — let the creative accumulate signal. |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-07 | 1337092034931256 | cut | null | 75 | 1,017.99 | 4 | 0.92 | creative_quality_weak, lifecycle_unavailable | ROAS 0.92 (28d) = 42% of target after $1,018 spend (28d) — clear loser at scale. |
| 2026-06-01 | 693776863669477 | cut | null | 75 | 387.34 | 2 | 0.85 | creative_quality_weak, lifecycle_unavailable | ROAS 0.85 (28d) = 38% of target after $387 spend (28d) — loss-budget maturity reached at $265; cut underperforming creative. |
| 2026-06-02 | 693776863669477 | cut | null | 75 | 381.07 | 2 | 0.86 | creative_quality_weak, lifecycle_unavailable | ROAS 0.86 (28d) = 39% of target after $381 spend (28d) — loss-budget maturity reached at $265; cut underperforming creative. |
| 2026-06-03 | 693776863669477 | cut | null | 75 | 374.83 | 2 | 0.88 | creative_quality_weak, lifecycle_unavailable | ROAS 0.88 (28d) = 40% of target after $375 spend (28d) — loss-budget maturity reached at $266; cut underperforming creative. |
| 2026-06-04 | 693776863669477 | cut | null | 75 | 357.93 | 2 | 0.92 | creative_quality_weak, lifecycle_unavailable | ROAS 0.92 (28d) = 42% of target after $358 spend (28d) — loss-budget maturity reached at $266; cut underperforming creative. |
| 2026-06-10 | 693776863669477 | cut | null | 75 | 351.85 | 2 | 0.93 | creative_quality_weak, lifecycle_unavailable | ROAS 0.93 (28d) = 42% of target after $352 spend (28d) — loss-budget maturity reached at $271; cut underperforming creative. |
| 2026-06-09 | 693776863669477 | cut | null | 75 | 348.56 | 2 | 0.94 | creative_quality_weak, lifecycle_unavailable | ROAS 0.94 (28d) = 43% of target after $349 spend (28d) — loss-budget maturity reached at $271; cut underperforming creative. |
| 2026-06-05 | 693776863669477 | cut | null | 75 | 342.96 | 2 | 0.96 | creative_quality_weak, lifecycle_unavailable | ROAS 0.96 (28d) = 43% of target after $343 spend (28d) — loss-budget maturity reached at $267; cut underperforming creative. |

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

### IwaStore

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1003444735733770 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $6 < $100 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal. |
| 1020781523695732 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $100 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. |
| 1025468773398763 | null | diagnose | null | 70 | null | Landing page issue: LPV-to-ATC 1.59% vs account baseline 4.76%. This is a funnel-step diagnosis, not proof that the creative itself is the problem. |
| 1028452980202623 | null | diagnose | null | 50 | null | [Stop-loss review - label campaign before cut] ROAS 0.85 (28d) = 24% of target after $117 spend (28d) — loss-budget maturity reached at $100; cut underperforming creative. |
| 1033784855709309 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $10 < $100 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal. |
| 1037962691982511 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $100 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal. |
| 1038055285394393 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $32 < $100 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. |
| 1038550568592146 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $90 < $100 loss-budget floor, 1 purchases, age 2d) — let the creative accumulate signal. |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-20 | 931776873000095 | cut | null | 75 | 411.94 | 8 | 2.41 | lifecycle_unavailable | ROAS 2.41 (28d) = 69% of target after $412 spend (28d) — clear loser at scale. |
| 2026-06-08 | 1597946391493220 | cut | null | 75 | 230.55 | 4 | 1.42 | creative_quality_weak, lifecycle_unavailable | ROAS 1.42 (28d) = 41% of target after $231 spend (28d) — sustained loser. |
| 2026-06-13 | 1597946391493220 | cut | null | 75 | 223.67 | 2 | 0.87 | creative_quality_weak, lifecycle_unavailable | ROAS 0.87 (28d) = 25% of target after $224 spend (28d) — sustained loser. |
| 2026-06-10 | 1597946391493220 | cut | null | 75 | 223.52 | 2 | 0.87 | creative_quality_weak, lifecycle_unavailable | ROAS 0.87 (28d) = 25% of target after $224 spend (28d) — sustained loser. |
| 2026-06-09 | 1597946391493220 | cut | null | 75 | 223.21 | 2 | 0.88 | creative_quality_weak, lifecycle_unavailable | ROAS 0.88 (28d) = 25% of target after $223 spend (28d) — sustained loser. |
| 2026-06-11 | 1597946391493220 | cut | null | 75 | 220.03 | 2 | 0.89 | creative_quality_weak, lifecycle_unavailable | ROAS 0.89 (28d) = 25% of target after $220 spend (28d) — sustained loser. |
| 2026-06-12 | 1597946391493220 | cut | null | 75 | 220.03 | 2 | 0.89 | creative_quality_weak, lifecycle_unavailable | ROAS 0.89 (28d) = 25% of target after $220 spend (28d) — sustained loser. |
| 2026-06-14 | 1597946391493220 | cut | null | 75 | 211.85 | 2 | 0.92 | creative_quality_weak, lifecycle_unavailable | ROAS 0.92 (28d) = 26% of target after $212 spend (28d) — sustained loser. |

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

### TheSwaf

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1000844809459077 | null | cut | null | 72 | null | ROAS 0.79 (28d) = 36% of target after $699 spend (28d) — clear loser at scale. |
| 1002443442283933 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $100 < $141 loss-budget floor, 0 purchases, age 28d) — let the creative accumulate signal. |
| 1007048011875307 | null | cut | null | 80 | null | 0 purchases on $624 spend (28d cumulative, age 41d) — sustained zero-conversion burn past CPA-anchored maturity threshold $188. |
| 1008302678413358 | null | keep | null | 65 | null | [demote candidate] ROAS 1.27 (28d) = 58% of target — above account bottom quartile (39%) but below breakeven (1.71 = 78% of target) at $502 mature spend — consider demote to test placement or refresh creative concept. |
| 1014356057726711 | null | keep | null | 65 | null | [weak zone] ROAS 0.93 (28d) = 42% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further. |
| 1015107537840127 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 41d) — let the creative accumulate signal. |
| 1017029037335130 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 40d) — let the creative accumulate signal. |
| 1017999650906955 | null | test_more | null | 75 | null | Below commercial maturity (28d spend $0 < $141 loss-budget floor, 0 purchases, age 39d) — let the creative accumulate signal. |

Hard/blocker replay samples:
| Date | Creative | Label | Blocked | Confidence | Spend | Purchases | ROAS | Badges | Reason |
|---|---|---|---|---:|---:|---:|---:|---|---|
| 2026-06-20 | 1672191184091002 | cut | null | 75 | 4,028.39 | 19 | 0.87 | creative_quality_weak, lifecycle_unavailable | ROAS 0.87 (28d) = 39% of target after $4,028 spend (28d) — clear loser at scale. |
| 2026-06-19 | 1672191184091002 | cut | null | 75 | 3,543.71 | 14 | 0.78 | creative_quality_weak, lifecycle_unavailable | ROAS 0.78 (28d) = 35% of target after $3,544 spend (28d) — clear loser at scale. |
| 2026-06-18 | 1672191184091002 | cut | null | 75 | 3,035.16 | 8 | 0.54 | creative_quality_weak, lifecycle_unavailable | ROAS 0.54 (28d) = 24% of target after $3,035 spend (28d) — clear loser at scale. |
| 2026-06-20 | 1962656064410174 | cut | null | 75 | 2,764.18 | 5 | 0.35 | creative_quality_weak, lifecycle_unavailable | ROAS 0.35 (28d) = 16% of target after $2,764 spend (28d) — clear loser at scale. |
| 2026-06-17 | 1672191184091002 | cut | null | 75 | 2,507.87 | 5 | 0.44 | creative_quality_weak, lifecycle_unavailable | ROAS 0.44 (28d) = 20% of target after $2,508 spend (28d) — clear loser at scale. |
| 2026-06-19 | 1962656064410174 | cut | null | 75 | 2,383.54 | 5 | 0.41 | creative_quality_weak, lifecycle_unavailable | ROAS 0.41 (28d) = 19% of target after $2,384 spend (28d) — clear loser at scale. |
| 2026-06-18 | 1962656064410174 | cut | null | 75 | 1,960.73 | 5 | 0.50 | creative_quality_weak, lifecycle_unavailable | ROAS 0.50 (28d) = 23% of target after $1,961 spend (28d) — clear loser at scale. |
| 2026-06-16 | 1672191184091002 | cut | null | 75 | 1,958.59 | 4 | 0.46 | creative_quality_weak, lifecycle_unavailable | ROAS 0.46 (28d) = 21% of target after $1,959 spend (28d) — clear loser at scale. |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-16 | 14 | 1345674994165648 | cut | positive | cut_loss_continued | 1,137.45 | 9,282.39 | 1.17 |
| 2026-06-17 | 14 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 1,775.29 | 9,086.09 | 1.18 |
| 2026-06-14 | 14 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 232.35 | 8,947.62 | 1.09 |
| 2026-06-14 | 14 | 1672191184091002 | cut | positive | cut_loss_continued | 792.78 | 7,658.45 | 1.02 |
| 2026-06-14 | 14 | 1962656064410174 | cut | positive | cut_loss_continued | 195.78 | 5,858.14 | 0.57 |
| 2026-06-16 | 14 | 3041651776171249 | keep | positive | non_hard_missed_cut_opportunity | 309.90 | 5,794.56 | 0.69 |
| 2026-06-15 | 14 | 3041651776171249 | test_more | positive | non_hard_missed_cut_opportunity | 109.15 | 5,635.73 | 0.64 |
| 2026-06-14 | 14 | 3041651776171249 | diagnose | positive | non_hard_missed_cut_opportunity | 43.47 | 5,321.08 | 0.68 |
