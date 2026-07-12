# Current Engine Historical Replay - 2026-06-29 to 2026-07-05

Generated at: 2026-07-12T00:45:35.043Z
Current date assumed by run: 2026-07-12
Engine version: `v3-2026-07-12-safety-dominant-hysteresis`
Outcome classifier: `creative-outcome-classifier.v2`
Replay window: 2026-06-29 -> 2026-07-05
Outcome evaluation ceiling: 2026-07-12
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

- Businesses found: 3
- Dates replayed: 7
- Decision rows: 1966
- Unique business+creative pairs: 340
- Label mix: test_more: 1466, keep: 302, diagnose: 158, out_of_scope: 40
- Source mode days: runtime_sql_fallback: 21
- Open outcome windows: 1966
- Closed daily outcome rows: 1966
- Episode-deduped outcome rows: 383
- Known episodes: 233
- Unknown episodes: 150

## Business Summary

| Business | Demo | Days | Failed | Decisions | Unique creatives | Labels | Hard rows | Blocked rows | Source modes | Profile ranges | Risk hints |
|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|---|
| Grandmix | no | 7 | 0 | 602 | 123 | test_more: 463, keep: 77, diagnose: 62 | 0 | 0 | runtime_sql_fallback: 7 | spendUnit 102.79-107.44, commercialMaturitySpend 256.98-268.61, hardCutSpend 822.34-859.56, bottomQuartileRatio 0.45-0.48, severeLoserRatio 0.22-0.24, scaleMinPurchases 5.00-5.00, winnerPurchaseP50 3.00-3.00, matureCreativeCount 70.00-74.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| IwaStore | no | 7 | 0 | 545 | 92 | test_more: 372, diagnose: 72, keep: 61, out_of_scope: 40 | 0 | 0 | runtime_sql_fallback: 7 | spendUnit 49.43-50.07, commercialMaturitySpend 98.86-100.15, hardCutSpend 247.15-250.37, bottomQuartileRatio 0.62-0.83, severeLoserRatio 0.40-0.57, scaleMinPurchases 3.00-4.00, winnerPurchaseP50 3.00-4.00, matureCreativeCount 47.00-69.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| TheSwaf | no | 7 | 0 | 819 | 125 | test_more: 631, keep: 164, diagnose: 24 | 0 | 0 | runtime_sql_fallback: 7 | spendUnit 92.99-94.43, commercialMaturitySpend 139.48-141.65, hardCutSpend 278.96-283.30, bottomQuartileRatio 0.39-0.40, severeLoserRatio 0.26-0.28, scaleMinPurchases 2.00-2.00, winnerPurchaseP50 2.00-2.00, matureCreativeCount 109.00-110.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |

## Fidelity Check vs Persisted Snapshots

This is the replay-faithfulness anchor requested by Claude: 2026-07-03 and 2026-07-04 replay rows are compared with actual persisted current-version snapshots. Low fidelity does not automatically mean the formula is wrong; it means replay mode/provenance differs and the historical result must be discounted accordingly.

| Business | Date | Source mode | Replay rows | Snapshot rows | Common | Label match | Label+confidence match | Replay-only | Snapshot-only |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| Grandmix | 2026-07-03 | runtime_sql_fallback | 71 | 0 | 0 | - | - | 71 | 0 |
| Grandmix | 2026-07-04 | runtime_sql_fallback | 92 | 0 | 0 | - | - | 92 | 0 |
| IwaStore | 2026-07-03 | runtime_sql_fallback | 90 | 0 | 0 | - | - | 90 | 0 |
| IwaStore | 2026-07-04 | runtime_sql_fallback | 90 | 0 | 0 | - | - | 90 | 0 |
| TheSwaf | 2026-07-03 | runtime_sql_fallback | 114 | 0 | 0 | - | - | 114 | 0 |
| TheSwaf | 2026-07-04 | runtime_sql_fallback | 110 | 0 | 0 | - | - | 110 | 0 |

## Fidelity Mismatch Notes

Sampled replay-vs-snapshot mismatches are listed explicitly so the fidelity rate cannot hide boundary-class differences.

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

## Decision Stability (Hysteresis Simulation)

Epoch: clean_epoch_per_business_at_start_date. Raw = engine output before stabilization; published = label after hard-boundary two-evaluation confirmation.

| Metric | Raw | Published | Change |
|---|---:|---:|---:|
| Hard-boundary transitions | 0 | 0 | n/a |
| Hard reversals within 3 obs | 0 | 0 | n/a |

Raw period-2 round-trips (A->B->A): 0. Published period-2 round-trips are structurally zero by hysteresis construction and are NOT reported as evidence; the reversal metric above is period-agnostic and fair to both streams.

Suppressed days: 0 (resolutions: -). confirmed/reverted are next-calendar-day evidence only; gap_return/exited_universe/replay_end are broken out and carry no next-day claim.
Cut delays: 0 suppressed days, next-day exposure 0.00. Scale delays: 0 suppressed days, next-day exposure 0.00. Exposure = next adjacent day's spend under historical operator policy; non-causal.

Matched suppressed-day scoring (identical forward windows, only the label differs - primary hold-vs-flip evidence):
| Window | Suppressed | Scored | Hold right | Flip right | Neutral/unknown | Open window |
|---:|---:|---:|---:|---:|---:|---:|
| 7d | 0 | 0 | 0 | 0 | 0 | 0 |
| 14d | 0 | 0 | 0 | 0 | 0 | 0 |

Per business:
| Business | Obs | Raw hard transitions | Published hard transitions | Raw reversals<=3 | Published reversals<=3 | Suppressed days | Resolutions | Cut-delay next-day spend |
|---|---:|---:|---:|---:|---:|---:|---|---:|
| Grandmix | 602 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| IwaStore | 545 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |
| TheSwaf | 819 | 0 | 0 | 0 | 0 | 0 | - | 0.00 |

Raw vs published outcome cells (SECONDARY context only: episode re-segmentation anchors confirmed transitions one day later and censors unknowns differently per stream, so these cells are not a like-for-like comparison - use the matched table above for hold-vs-flip claims):
| Window | Label | Class | Raw episodes | Raw known | Raw unknown (zero-spend) | Raw positive rate | Published episodes | Published known | Published unknown (zero-spend) | Published positive rate |
|---:|---|---|---:|---:|---|---:|---:|---:|---|---:|
| 7 | diagnose | non_hard | 42 | 30 | 12 (12) | 73.3% | 42 | 30 | 12 (12) | 73.3% |
| 7 | keep | non_hard | 55 | 41 | 14 (14) | 75.6% | 55 | 41 | 14 (14) | 75.6% |
| 7 | out_of_scope | non_hard | 6 | 0 | 6 (1) | - | 6 | 0 | 6 (1) | - |
| 7 | test_more | non_hard | 280 | 162 | 118 (118) | 80.9% | 280 | 162 | 118 (118) | 80.9% |
| 14 | diagnose | non_hard | 0 | 0 | 0 (0) | - | 0 | 0 | 0 (0) | - |
| 14 | keep | non_hard | 0 | 0 | 0 (0) | - | 0 | 0 | 0 (0) | - |
| 14 | out_of_scope | non_hard | 0 | 0 | 0 (0) | - | 0 | 0 | 0 (0) | - |
| 14 | test_more | non_hard | 0 | 0 | 0 (0) | - | 0 | 0 | 0 (0) | - |

## Outcome Episode Summary

`open_window` is not `unknown`: open means the 7d/14d forward window has not closed by 2026-07-05. `unknown` means the window is closed but the classifier cannot infer outcome, most commonly zero forward spend or missing target. Precision/missed-opportunity proxy below is episode-deduped, not daily-row counted.

| Business | Window | Label | Class | Open rows | Closed daily rows | Episodes | Known | Unknown | Positive | Negative | Neutral | Zero-forward unknown | Positive rate known | Reliability |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Grandmix | 7 | diagnose | non_hard | 0 | 62 | 12 | 11 | 1 | 7 | 0 | 4 | 1 | 63.6% | directional |
| Grandmix | 7 | keep | non_hard | 0 | 77 | 13 | 13 | 0 | 9 | 0 | 4 | 0 | 69.2% | directional |
| Grandmix | 7 | test_more | non_hard | 0 | 463 | 107 | 88 | 19 | 73 | 0 | 15 | 19 | 83.0% | defensible |
| Grandmix | 14 | diagnose | non_hard | 62 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| Grandmix | 14 | keep | non_hard | 77 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| Grandmix | 14 | test_more | non_hard | 463 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaStore | 7 | diagnose | non_hard | 0 | 72 | 25 | 18 | 7 | 15 | 0 | 3 | 7 | 83.3% | directional |
| IwaStore | 7 | keep | non_hard | 0 | 61 | 14 | 13 | 1 | 10 | 0 | 3 | 1 | 76.9% | directional |
| IwaStore | 7 | out_of_scope | non_hard | 0 | 40 | 6 | 0 | 6 | 0 | 0 | 0 | 1 | - | insufficient |
| IwaStore | 7 | test_more | non_hard | 0 | 372 | 75 | 51 | 24 | 37 | 0 | 14 | 24 | 72.5% | defensible |
| IwaStore | 14 | diagnose | non_hard | 72 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaStore | 14 | keep | non_hard | 61 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaStore | 14 | out_of_scope | non_hard | 40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaStore | 14 | test_more | non_hard | 372 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| TheSwaf | 7 | diagnose | non_hard | 0 | 24 | 5 | 1 | 4 | 0 | 0 | 1 | 4 | 0.0% | insufficient |
| TheSwaf | 7 | keep | non_hard | 0 | 164 | 28 | 15 | 13 | 12 | 0 | 3 | 13 | 80.0% | directional |
| TheSwaf | 7 | test_more | non_hard | 0 | 631 | 98 | 23 | 75 | 21 | 0 | 2 | 75 | 91.3% | directional |
| TheSwaf | 14 | diagnose | non_hard | 24 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| TheSwaf | 14 | keep | non_hard | 164 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| TheSwaf | 14 | test_more | non_hard | 631 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |

## Confidence Alignment Smoke

Hard and non-hard rows are deliberately separated. For hard actions, positive means the hard action proxy was supported. For non-hard rows, positive means a missed hard-action opportunity proxy; it is not the same polarity and must not be pooled with hard precision.

| Business | Window | Class | Bucket | Episodes | Known | Positive | Observed positive | Avg confidence | Abs gap |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| Grandmix | 7 | non_hard | 50_59 | 10 | 10 | 7 | 70.0% | 55.0% | 15.0% |
| Grandmix | 7 | non_hard | 60_69 | 122 | 102 | 82 | 80.4% | 60.0% | 20.4% |
| IwaStore | 7 | non_hard | 50_59 | 27 | 18 | 15 | 83.3% | 55.0% | 28.3% |
| IwaStore | 7 | non_hard | 60_69 | 93 | 64 | 47 | 73.4% | 60.0% | 13.4% |
| TheSwaf | 7 | non_hard | 50_59 | 26 | 1 | 0 | 0.0% | 55.0% | 55.0% |
| TheSwaf | 7 | non_hard | 60_69 | 105 | 38 | 33 | 86.8% | 60.0% | 26.8% |

## Confidence By Label And Source Mode

This is the deeper calibration table requested after the multi-window review. It keeps business, surfaced action label, outcome window, confidence bucket, and replay source-mode separate. Positive polarity is listed explicitly because hard labels and non-hard labels do not mean the same thing.

| Business | Window | Source mode | Label | Class | Bucket | Episodes | Known | Unknown | Positive | Negative | Neutral | Observed positive | Avg confidence | Abs gap | Reliability | Positive meaning |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| Grandmix | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 10 | 10 | 0 | 7 | 0 | 3 | 70.0% | 55.0% | 15.0% | directional | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 2 | 1 | 1 | 0 | 0 | 1 | 0.0% | 60.0% | 60.0% | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 107 | 88 | 19 | 73 | 0 | 15 | 83.0% | 60.0% | 22.9% | defensible | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 13 | 13 | 0 | 9 | 0 | 4 | 69.2% | 60.0% | 9.2% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 25 | 18 | 7 | 15 | 0 | 3 | 83.3% | 55.0% | 28.3% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | test_more | non_hard | 50_59 | 2 | 0 | 2 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 73 | 51 | 22 | 37 | 0 | 14 | 72.5% | 60.0% | 12.6% | defensible | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 14 | 13 | 1 | 10 | 0 | 3 | 76.9% | 60.0% | 16.9% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 6 | 0 | 6 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 5 | 1 | 4 | 0 | 0 | 1 | 0.0% | 55.0% | 55.0% | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | test_more | non_hard | 50_59 | 8 | 0 | 8 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 90 | 23 | 67 | 21 | 0 | 2 | 91.3% | 60.0% | 31.3% | directional | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | keep | non_hard | 50_59 | 13 | 0 | 13 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 15 | 15 | 0 | 12 | 0 | 3 | 80.0% | 60.0% | 20.0% | directional | non_hard_missed_hard_action_proxy |

## Replay Date Summary

| Date | Success businesses | Failed businesses | Decisions | Labels | Source modes |
|---|---:|---:|---:|---|---|
| 2026-06-29 | 3 | 0 | 254 | test_more: 190, keep: 38, diagnose: 21, out_of_scope: 5 | runtime_sql_fallback: 3 |
| 2026-06-30 | 3 | 0 | 265 | test_more: 199, keep: 37, diagnose: 24, out_of_scope: 5 | runtime_sql_fallback: 3 |
| 2026-07-01 | 3 | 0 | 282 | test_more: 205, keep: 41, diagnose: 30, out_of_scope: 6 | runtime_sql_fallback: 3 |
| 2026-07-02 | 3 | 0 | 285 | test_more: 205, keep: 45, diagnose: 29, out_of_scope: 6 | runtime_sql_fallback: 3 |
| 2026-07-03 | 3 | 0 | 275 | test_more: 204, keep: 45, diagnose: 20, out_of_scope: 6 | runtime_sql_fallback: 3 |
| 2026-07-04 | 3 | 0 | 292 | test_more: 220, keep: 49, diagnose: 17, out_of_scope: 6 | runtime_sql_fallback: 3 |
| 2026-07-05 | 3 | 0 | 313 | test_more: 243, keep: 47, diagnose: 17, out_of_scope: 6 | runtime_sql_fallback: 3 |

## Business Samples

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

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-29 | 7 | 27134621589538352 | keep | positive | non_hard_missed_scale_opportunity | 926.94 | 1,003.29 | 3.33 |
| 2026-06-29 | 7 | 1337092034931256 | diagnose | positive | non_hard_missed_cut_opportunity | 1,098.09 | 649.27 | 0.00 |
| 2026-06-29 | 7 | 27999779066276373 | keep | positive | non_hard_missed_scale_opportunity | 554.08 | 425.56 | 3.40 |
| 2026-07-03 | 7 | 2257729818314797 | test_more | positive | non_hard_missed_cut_opportunity | 2.45 | 371.71 | 0.48 |
| 2026-07-05 | 7 | 1504818567511615 | test_more | positive | non_hard_missed_cut_opportunity | 22.42 | 363.32 | 0.59 |
| 2026-07-01 | 7 | 1625994111845870 | keep | positive | non_hard_missed_scale_opportunity | 274.35 | 305.94 | 2.90 |
| 2026-06-29 | 7 | 1008549465472004 | keep | positive | non_hard_missed_cut_opportunity | 783.13 | 261.55 | 0.86 |
| 2026-06-29 | 7 | 3248297215341499 | keep | positive | non_hard_missed_scale_opportunity | 925.26 | 259.03 | 3.73 |
| 2026-06-29 | 7 | 1676475616888508 | keep | positive | non_hard_missed_scale_opportunity | 372.92 | 223.21 | 3.26 |
| 2026-06-29 | 7 | 1298753055736035 | diagnose | positive | non_hard_missed_cut_opportunity | 386.29 | 151.06 | 0.99 |
| 2026-07-04 | 7 | 2026274487993766 | test_more | positive | non_hard_missed_cut_opportunity | 197.49 | 126.05 | 0.00 |
| 2026-07-05 | 7 | 1994245131214531 | test_more | positive | non_hard_missed_cut_opportunity | 7.75 | 111.69 | 0.00 |

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
| 2026-07-02 | 7 | 2038272963464339 | diagnose | positive | non_hard_missed_cut_opportunity | 121.05 | 947.46 | 1.91 |
| 2026-07-01 | 7 | 2266296250855098 | test_more | positive | non_hard_missed_cut_opportunity | 142.43 | 890.40 | 1.69 |
| 2026-07-02 | 7 | 3931469937157981 | keep | positive | non_hard_missed_cut_opportunity | 139.85 | 760.82 | 1.43 |
| 2026-07-03 | 7 | 1340184707529372 | test_more | positive | non_hard_missed_cut_opportunity | 265.73 | 757.38 | 1.07 |
| 2026-07-01 | 7 | 3931469937157981 | diagnose | positive | non_hard_missed_cut_opportunity | 62.14 | 718.80 | 1.92 |
| 2026-06-30 | 7 | 1340184707529372 | diagnose | positive | non_hard_missed_cut_opportunity | 88.33 | 650.94 | 1.69 |
| 2026-07-02 | 7 | 1737346164109012 | keep | positive | non_hard_missed_cut_opportunity | 158.24 | 574.98 | 1.74 |
| 2026-07-05 | 7 | 1340184707529372 | diagnose | positive | non_hard_missed_cut_opportunity | 472.35 | 550.76 | 0.17 |
| 2026-06-30 | 7 | 1408036801165194 | diagnose | positive | non_hard_missed_cut_opportunity | 27.48 | 340.21 | 1.51 |
| 2026-06-30 | 7 | 1668812617742088 | test_more | positive | non_hard_missed_cut_opportunity | 30.33 | 311.55 | 1.34 |
| 2026-07-02 | 7 | 1888743981790432 | keep | positive | non_hard_missed_cut_opportunity | 179.45 | 292.57 | 1.40 |
| 2026-07-01 | 7 | 1038550568592146 | test_more | positive | non_hard_missed_cut_opportunity | 51.65 | 259.26 | 1.79 |

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
| 2026-06-29 | 7 | 1345674994165648 | keep | positive | non_hard_missed_cut_opportunity | 9,836.80 | 3,127.30 | 0.91 |
| 2026-06-29 | 7 | 3041651776171249 | test_more | positive | non_hard_missed_cut_opportunity | 5,744.88 | 2,401.18 | 1.02 |
| 2026-06-29 | 7 | 2061803274760111 | test_more | positive | non_hard_missed_cut_opportunity | 86.69 | 1,661.56 | 1.18 |
| 2026-06-29 | 7 | 1546542256949523 | test_more | positive | non_hard_missed_cut_opportunity | 1,732.33 | 1,497.61 | 1.12 |
| 2026-07-01 | 7 | 2061803274760111 | keep | positive | non_hard_missed_cut_opportunity | 457.67 | 1,290.58 | 0.90 |
| 2026-06-29 | 7 | 1631905067884325 | keep | positive | non_hard_missed_cut_opportunity | 2,482.10 | 968.97 | 0.78 |
| 2026-06-29 | 7 | 913690625083809 | test_more | positive | non_hard_missed_cut_opportunity | 3,554.01 | 872.97 | 0.00 |
| 2026-06-29 | 7 | 1751801452484886 | keep | positive | non_hard_missed_cut_opportunity | 1,637.63 | 690.77 | 0.49 |
| 2026-06-29 | 7 | 1007048011875307 | test_more | positive | non_hard_missed_cut_opportunity | 322.99 | 432.73 | 0.00 |
| 2026-06-29 | 7 | 1345796717452247 | keep | positive | non_hard_missed_scale_opportunity | 868.01 | 288.58 | 3.01 |
| 2026-07-04 | 7 | 1962656064410174 | keep | positive | non_hard_missed_cut_opportunity | 7,346.24 | 280.04 | 1.03 |
| 2026-07-04 | 7 | 1000844809459077 | keep | positive | non_hard_missed_cut_opportunity | 725.33 | 247.86 | 0.00 |
