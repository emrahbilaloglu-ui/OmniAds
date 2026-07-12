# Current Engine Historical Replay - 2026-06-29 to 2026-07-05

Generated at: 2026-07-12T02:17:13.640Z
Current date assumed by run: 2026-07-12
Engine version: `v3-2026-07-12-safety-dominant-hysteresis`
Outcome classifier: `creative-outcome-classifier.v2`
Replay window: 2026-06-29 -> 2026-07-05
Outcome evaluation ceiling: 2026-07-12
Freshness mode: historical

## Verdict Boundary

This is a read-only historical replay/backtest of the current decision engine over existing warehouse data. It is not evidence that the production scheduler actually ran for 7 inclusive asOf dates / 6 elapsed historical days, and it is not causal proof that an operator would have achieved these outcomes.

The useful question answered here is narrower: if today's current engine had evaluated each historical asOf date, what labels would it have emitted, and what non-causal forward outcome proxy is visible for windows that are already closed by 2026-07-12?

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
- Outcome windows after 2026-07-05 for 7d and after 2026-06-28 for 14d are marked open_window under the 2026-07-12 ceiling.
- Closed-window unknown is distinct from open_window and commonly means zero forward spend; it is not counted as a failed hard decision.
- Outcome precision/missed-opportunity values are non-causal proxies because historical forward spend was affected by real operator/platform decisions.
- Targets are read from append-only bitemporal target history at each date-only 03:00Z producer cutoff; dates before history begins remain target-unknown and cannot gain target-derived hard authority.
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
- Label mix: test_more: 1229, out_of_scope: 605, diagnose: 76, keep: 56
- Source mode days: runtime_sql_fallback: 21
- Open outcome windows: 1966
- Closed daily outcome rows: 1966
- Episode-deduped outcome rows: 368
- Known episodes: 184
- Unknown episodes: 184

## Business Summary

| Business | Demo | Days | Failed | Decisions | Unique creatives | Labels | Hard rows | Blocked rows | Source modes | Profile ranges | Risk hints |
|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|---|
| Grandmix | no | 7 | 0 | 602 | 123 | test_more: 370, out_of_scope: 231, diagnose: 1 | 0 | 0 | runtime_sql_fallback: 7 | spendUnit 117.71-126.94, commercialMaturitySpend 235.41-253.88, hardCutSpend 588.53-634.69, scaleMinPurchases 1.00-1.00, matureCreativeCount 70.00-74.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| IwaStore | no | 7 | 0 | 545 | 92 | test_more: 414, diagnose: 68, out_of_scope: 40, keep: 23 | 0 | 0 | runtime_sql_fallback: 7 | spendUnit 36.45-42.05, commercialMaturitySpend 72.89-84.10, hardCutSpend 182.23-210.25, scaleMinPurchases 1.00-1.00, matureCreativeCount 47.00-69.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |
| TheSwaf | no | 7 | 0 | 819 | 125 | test_more: 445, out_of_scope: 334, keep: 33, diagnose: 7 | 0 | 0 | runtime_sql_fallback: 7 | spendUnit 152.41-155.94, commercialMaturitySpend 304.81-311.88, hardCutSpend 762.03-779.69, scaleMinPurchases 1.00-1.00, matureCreativeCount 109.00-110.00 | no_hard_actions_in_replay_window, raw_wall_clock_freshness_was_stale_or_degraded, runtime_sql_fallback_days_not_equivalent_to_lifecycle_informed_production |

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

- Grandmix 2026-07-03 creative 1002617308929281: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-03 creative 1003770772089284: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-03 creative 1005337862441315: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-03 creative 1008549465472004: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-03 creative 1009827774896101: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1010946998578771: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $58 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1012777161360911: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1020070427050295: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $15 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1024616573428480: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $82 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1025822163460162: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-03 creative 1068268059100740: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $16 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-03 creative 1186862256977827: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-04 creative 1002617308929281: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-04 creative 1003770772089284: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-04 creative 1005337862441315: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-04 creative 1008549465472004: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-04 creative 1009827774896101: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $5 < $240 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1010946998578771: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $58 < $240 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1012777161360911: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $240 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1020070427050295: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $15 < $240 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1024616573428480: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $82 < $240 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1025822163460162: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- Grandmix 2026-07-04 creative 1028255766263061: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $240 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- Grandmix 2026-07-04 creative 1068268059100740: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $16 < $240 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1003444735733770: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1016479011077401: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1020781523695732: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $78 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1025468773398763: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.82 (28d) = 14% of target after $276 spend (28d) — clear loser at scale. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-03 creative 1028452980202623: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 1.94 (28d) = 33% of target after $150 spend (28d) — loss-budget maturity reached at $78; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-03 creative 1033784855709309: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $13 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1037962691982511: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $78 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1038055285394393: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $51 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1038550568592146: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 2.91 (28d) = 49% of target after $134 spend (28d) — loss-budget maturity reached at $78; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-03 creative 1050560790774455: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-03 creative 1157254709850013: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 3.86 (28d) = 65% of target after $141 spend (28d) — loss-budget maturity reached at $78; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-03 creative 1230828315767797: replay out_of_scope/60 vs snapshot null/null; replay reason "Creative runs in mid_funnel adsets; purchase decision engine does not evaluate it.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1003444735733770: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $7 < $84 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1016479011077401: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $84 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1020781523695732: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $84 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1025468773398763: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.82 (28d) = 14% of target after $276 spend (28d) — clear loser at scale. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-04 creative 1028452980202623: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 2.51 (28d) = 44% of target after $186 spend (28d) — loss-budget maturity reached at $84; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-04 creative 1033784855709309: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $23 < $84 loss-budget floor, 1 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1037962691982511: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $0 < $84 loss-budget floor, 0 purchases, age 3d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1038055285394393: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $64 < $84 loss-budget floor, 1 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1038550568592146: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 2.15 (28d) = 37% of target after $181 spend (28d) — loss-budget maturity reached at $84; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-04 creative 1050560790774455: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $4 < $84 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal.", snapshot reason "null".
- IwaStore 2026-07-04 creative 1157254709850013: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 3.89 (28d) = 67% of target after $140 spend (28d) — loss-budget maturity reached at $84; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- IwaStore 2026-07-04 creative 1230828315767797: replay out_of_scope/60 vs snapshot null/null; replay reason "Creative runs in mid_funnel adsets; purchase decision engine does not evaluate it.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1000844809459077: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.78 (28d) = 36% of target after $711 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1002443442283933: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1007048011875307: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $678 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1008302678413358: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1014356057726711: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $262 < $310 loss-budget floor, 1 purchases) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1018252307526601: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1023264806904899: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $51 < $310 loss-budget floor, 0 purchases, age 17d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1023932563648623: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $310 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1030352566602424: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1031796332841133: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.48 (28d) = 22% of target after $312 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1033614439176557: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-03 creative 1111657292040172: replay out_of_scope/60 vs snapshot null/null; replay reason "decision context identity unavailable; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1000844809459077: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 1.00 (28d) = 46% of target after $725 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1002443442283933: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1007048011875307: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $721 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1008302678413358: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1014356057726711: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $262 < $310 loss-budget floor, 1 purchases) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1018252307526601: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1023264806904899: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $51 < $310 loss-budget floor, 0 purchases, age 18d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1023932563648623: replay test_more/60 vs snapshot null/null; replay reason "Below commercial maturity (28d spend $3 < $310 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal.", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1030352566602424: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1031796332841133: replay test_more/60 vs snapshot null/null; replay reason "[soft-only - cut blocked] ROAS 0.48 (28d) = 22% of target after $312 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready))", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1033614439176557: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".
- TheSwaf 2026-07-04 creative 1293016656251330: replay out_of_scope/60 vs snapshot null/null; replay reason "mixed decision context; evaluate at ad grain", snapshot reason "null".

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
| 7 | diagnose | non_hard | 24 | 14 | 10 (10) | 85.7% | 24 | 14 | 10 (10) | 85.7% |
| 7 | keep | non_hard | 14 | 13 | 1 (1) | 92.3% | 14 | 13 | 1 (1) | 92.3% |
| 7 | out_of_scope | non_hard | 86 | 0 | 86 (48) | - | 86 | 0 | 86 (48) | - |
| 7 | test_more | non_hard | 244 | 157 | 87 (87) | 89.8% | 244 | 157 | 87 (87) | 89.8% |
| 14 | diagnose | non_hard | 0 | 0 | 0 (0) | - | 0 | 0 | 0 (0) | - |
| 14 | keep | non_hard | 0 | 0 | 0 (0) | - | 0 | 0 | 0 (0) | - |
| 14 | out_of_scope | non_hard | 0 | 0 | 0 (0) | - | 0 | 0 | 0 (0) | - |
| 14 | test_more | non_hard | 0 | 0 | 0 (0) | - | 0 | 0 | 0 (0) | - |

## Outcome Episode Summary

`open_window` is not `unknown`: open means the 7d/14d forward window has not closed by 2026-07-12. `unknown` means the window is closed but the classifier cannot infer outcome, most commonly zero forward spend or missing target. Precision/missed-opportunity proxy below is episode-deduped, not daily-row counted.

| Business | Window | Label | Class | Open rows | Closed daily rows | Episodes | Known | Unknown | Positive | Negative | Neutral | Zero-forward unknown | Positive rate known | Reliability |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Grandmix | 7 | diagnose | non_hard | 0 | 1 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| Grandmix | 7 | out_of_scope | non_hard | 0 | 231 | 33 | 0 | 33 | 0 | 0 | 0 | 0 | - | insufficient |
| Grandmix | 7 | test_more | non_hard | 0 | 370 | 90 | 71 | 19 | 67 | 0 | 4 | 19 | 94.4% | defensible |
| Grandmix | 14 | diagnose | non_hard | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| Grandmix | 14 | out_of_scope | non_hard | 231 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| Grandmix | 14 | test_more | non_hard | 370 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaStore | 7 | diagnose | non_hard | 0 | 68 | 22 | 14 | 8 | 12 | 0 | 2 | 8 | 85.7% | directional |
| IwaStore | 7 | keep | non_hard | 0 | 23 | 7 | 6 | 1 | 5 | 0 | 1 | 1 | 83.3% | insufficient |
| IwaStore | 7 | out_of_scope | non_hard | 0 | 40 | 6 | 0 | 6 | 0 | 0 | 0 | 1 | - | insufficient |
| IwaStore | 7 | test_more | non_hard | 0 | 414 | 79 | 55 | 24 | 47 | 0 | 8 | 24 | 85.5% | defensible |
| IwaStore | 14 | diagnose | non_hard | 68 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaStore | 14 | keep | non_hard | 23 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaStore | 14 | out_of_scope | non_hard | 40 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| IwaStore | 14 | test_more | non_hard | 414 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| TheSwaf | 7 | diagnose | non_hard | 0 | 7 | 1 | 0 | 1 | 0 | 0 | 0 | 1 | - | insufficient |
| TheSwaf | 7 | keep | non_hard | 0 | 33 | 7 | 7 | 0 | 7 | 0 | 0 | 0 | 100.0% | insufficient |
| TheSwaf | 7 | out_of_scope | non_hard | 0 | 334 | 47 | 0 | 47 | 0 | 0 | 0 | 47 | - | insufficient |
| TheSwaf | 7 | test_more | non_hard | 0 | 445 | 75 | 31 | 44 | 27 | 0 | 4 | 44 | 87.1% | defensible |
| TheSwaf | 14 | diagnose | non_hard | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| TheSwaf | 14 | keep | non_hard | 33 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| TheSwaf | 14 | out_of_scope | non_hard | 334 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |
| TheSwaf | 14 | test_more | non_hard | 445 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | - | insufficient |

## Confidence Alignment Smoke

Hard and non-hard rows are deliberately separated. For hard actions, positive means the hard action proxy was supported. For non-hard rows, positive means a missed hard-action opportunity proxy; it is not the same polarity and must not be pooled with hard precision.

| Business | Window | Class | Bucket | Episodes | Known | Positive | Observed positive | Avg confidence | Abs gap |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| Grandmix | 7 | non_hard | 60_69 | 124 | 71 | 67 | 94.4% | 60.0% | 34.4% |
| IwaStore | 7 | non_hard | 50_59 | 24 | 14 | 12 | 85.7% | 55.0% | 30.7% |
| IwaStore | 7 | non_hard | 60_69 | 90 | 61 | 52 | 85.3% | 60.0% | 25.3% |
| TheSwaf | 7 | non_hard | 50_59 | 9 | 0 | 0 | - | - | - |
| TheSwaf | 7 | non_hard | 60_69 | 121 | 38 | 34 | 89.5% | 60.0% | 29.5% |

## Confidence By Label And Source Mode

This is the deeper calibration table requested after the multi-window review. It keeps business, surfaced action label, outcome window, confidence bucket, and replay source-mode separate. Positive polarity is listed explicitly because hard labels and non-hard labels do not mean the same thing.

| Business | Window | Source mode | Label | Class | Bucket | Episodes | Known | Unknown | Positive | Negative | Neutral | Observed positive | Avg confidence | Abs gap | Reliability | Positive meaning |
|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| Grandmix | 7 | runtime_sql_fallback | diagnose | non_hard | 60_69 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 90 | 71 | 19 | 67 | 0 | 4 | 94.4% | 60.0% | 34.4% | defensible | non_hard_missed_hard_action_proxy |
| Grandmix | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 33 | 0 | 33 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 22 | 14 | 8 | 12 | 0 | 2 | 85.7% | 55.0% | 30.7% | directional | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | test_more | non_hard | 50_59 | 2 | 0 | 2 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 77 | 55 | 22 | 47 | 0 | 8 | 85.5% | 60.0% | 25.4% | defensible | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 7 | 6 | 1 | 5 | 0 | 1 | 83.3% | 60.0% | 23.3% | insufficient | non_hard_missed_hard_action_proxy |
| IwaStore | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 6 | 0 | 6 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | diagnose | non_hard | 50_59 | 1 | 0 | 1 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | test_more | non_hard | 50_59 | 8 | 0 | 8 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | test_more | non_hard | 60_69 | 67 | 31 | 36 | 27 | 0 | 4 | 87.1% | 60.0% | 27.1% | defensible | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | keep | non_hard | 60_69 | 7 | 7 | 0 | 7 | 0 | 0 | 100.0% | 60.0% | 40.0% | insufficient | non_hard_missed_hard_action_proxy |
| TheSwaf | 7 | runtime_sql_fallback | out_of_scope | non_hard | 60_69 | 47 | 0 | 47 | 0 | 0 | 0 | - | - | - | insufficient | non_hard_missed_hard_action_proxy |

## Replay Date Summary

| Date | Success businesses | Failed businesses | Decisions | Labels | Source modes |
|---|---:|---:|---:|---|---|
| 2026-06-29 | 3 | 0 | 254 | test_more: 156, out_of_scope: 85, keep: 7, diagnose: 6 | runtime_sql_fallback: 3 |
| 2026-06-30 | 3 | 0 | 265 | test_more: 165, out_of_scope: 85, diagnose: 9, keep: 6 | runtime_sql_fallback: 3 |
| 2026-07-01 | 3 | 0 | 282 | test_more: 169, out_of_scope: 85, diagnose: 18, keep: 10 | runtime_sql_fallback: 3 |
| 2026-07-02 | 3 | 0 | 285 | test_more: 167, out_of_scope: 91, diagnose: 18, keep: 9 | runtime_sql_fallback: 3 |
| 2026-07-03 | 3 | 0 | 275 | test_more: 167, out_of_scope: 89, diagnose: 10, keep: 9 | runtime_sql_fallback: 3 |
| 2026-07-04 | 3 | 0 | 292 | test_more: 193, out_of_scope: 85, diagnose: 7, keep: 7 | runtime_sql_fallback: 3 |
| 2026-07-05 | 3 | 0 | 313 | test_more: 212, out_of_scope: 85, diagnose: 8, keep: 8 | runtime_sql_fallback: 3 |

## Business Samples

### Grandmix

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1002617308929281 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1003770772089284 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1005337862441315 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1008549465472004 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1009827774896101 | test_more | null | 60 | null | Below commercial maturity (28d spend $5 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1010946998578771 | test_more | null | 60 | null | Below commercial maturity (28d spend $58 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1012777161360911 | test_more | null | 60 | null | Below commercial maturity (28d spend $3 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1020070427050295 | test_more | null | 60 | null | Below commercial maturity (28d spend $15 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1024616573428480 | test_more | null | 60 | null | Below commercial maturity (28d spend $82 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1025822163460162 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1068268059100740 | test_more | null | 60 | null | Below commercial maturity (28d spend $16 < $235 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1186862256977827 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-07-03 | 7 | 2257729818314797 | test_more | positive | non_hard_missed_cut_opportunity | 2.45 | 371.71 | 0.48 |
| 2026-07-05 | 7 | 1504818567511615 | test_more | positive | non_hard_missed_cut_opportunity | 22.42 | 363.32 | 0.59 |
| 2026-07-04 | 7 | 2733360953731132 | test_more | positive | non_hard_missed_cut_opportunity | 11.61 | 278.81 | 1.34 |
| 2026-06-29 | 7 | 1548668237040903 | test_more | positive | non_hard_missed_cut_opportunity | 152.77 | 245.57 | 1.37 |
| 2026-07-05 | 7 | 2062535954331110 | test_more | positive | non_hard_missed_cut_opportunity | 7.33 | 240.00 | 1.63 |
| 2026-07-04 | 7 | 1515764536690624 | test_more | positive | non_hard_missed_cut_opportunity | 5.62 | 180.00 | 1.57 |
| 2026-07-05 | 7 | 1411899924098370 | test_more | positive | non_hard_missed_cut_opportunity | 6.22 | 128.06 | 1.96 |
| 2026-07-05 | 7 | 1994245131214531 | test_more | positive | non_hard_missed_cut_opportunity | 7.75 | 111.69 | 0.00 |
| 2026-06-29 | 7 | 970098709321843 | test_more | positive | non_hard_missed_cut_opportunity | 81.40 | 100.71 | 0.00 |
| 2026-06-29 | 7 | 1351988990223478 | test_more | positive | non_hard_missed_cut_opportunity | 83.22 | 94.32 | 0.00 |
| 2026-06-29 | 7 | 1265467295473629 | test_more | positive | non_hard_missed_cut_opportunity | 58.33 | 89.66 | 0.00 |
| 2026-07-04 | 7 | 1028255766263061 | test_more | positive | non_hard_missed_cut_opportunity | 7.25 | 83.61 | 0.00 |

### IwaStore

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1003444735733770 | test_more | null | 60 | null | Below commercial maturity (28d spend $7 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1016479011077401 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1020781523695732 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $78 loss-budget floor, 0 purchases, age 1d) — let the creative accumulate signal. | null |
| 1025468773398763 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.82 (28d) = 14% of target after $276 spend (28d) — clear loser at scale. (threshold baseline account_history has low confidence (meta AOV ready)) | null |
| 1028452980202623 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 1.94 (28d) = 33% of target after $150 spend (28d) — loss-budget maturity reached at $78; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready)) | null |
| 1033784855709309 | test_more | null | 60 | null | Below commercial maturity (28d spend $13 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1037962691982511 | test_more | null | 60 | null | Below commercial maturity (28d spend $0 < $78 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal. | null |
| 1038055285394393 | test_more | null | 60 | null | Below commercial maturity (28d spend $51 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1038550568592146 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 2.91 (28d) = 49% of target after $134 spend (28d) — loss-budget maturity reached at $78; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready)) | null |
| 1050560790774455 | test_more | null | 60 | null | Below commercial maturity (28d spend $4 < $78 loss-budget floor, 0 purchases, age 0d) — let the creative accumulate signal. | null |
| 1157254709850013 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 3.86 (28d) = 65% of target after $141 spend (28d) — loss-budget maturity reached at $78; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready)) | null |
| 1230828315767797 | out_of_scope | null | 60 | null | Creative runs in mid_funnel adsets; purchase decision engine does not evaluate it. | null |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-07-02 | 7 | 2038272963464339 | diagnose | positive | non_hard_missed_cut_opportunity | 121.05 | 947.46 | 1.91 |
| 2026-07-01 | 7 | 2266296250855098 | test_more | positive | non_hard_missed_cut_opportunity | 142.43 | 890.40 | 1.69 |
| 2026-07-03 | 7 | 3931469937157981 | test_more | positive | non_hard_missed_cut_opportunity | 236.41 | 827.94 | 1.13 |
| 2026-07-03 | 7 | 2038272963464339 | test_more | positive | non_hard_missed_cut_opportunity | 305.08 | 766.80 | 2.22 |
| 2026-07-03 | 7 | 1340184707529372 | test_more | positive | non_hard_missed_cut_opportunity | 265.73 | 757.38 | 1.07 |
| 2026-07-01 | 7 | 3931469937157981 | diagnose | positive | non_hard_missed_cut_opportunity | 62.14 | 718.80 | 1.92 |
| 2026-06-30 | 7 | 1340184707529372 | diagnose | positive | non_hard_missed_cut_opportunity | 88.33 | 650.94 | 1.69 |
| 2026-06-30 | 7 | 1737346164109012 | test_more | positive | non_hard_missed_cut_opportunity | 34.98 | 599.71 | 2.72 |
| 2026-07-01 | 7 | 1737346164109012 | keep | positive | non_hard_missed_cut_opportunity | 84.23 | 584.74 | 2.14 |
| 2026-07-02 | 7 | 1737346164109012 | test_more | positive | non_hard_missed_cut_opportunity | 158.24 | 574.98 | 1.74 |
| 2026-07-05 | 7 | 1340184707529372 | diagnose | positive | non_hard_missed_cut_opportunity | 472.35 | 550.76 | 0.17 |
| 2026-07-04 | 7 | 1888743981790432 | test_more | positive | non_hard_missed_cut_opportunity | 283.93 | 406.10 | 1.12 |

### TheSwaf

Fidelity mismatch samples:
| Creative | Replay | Snapshot | Replay conf | Snapshot conf | Replay reason | Snapshot reason |
|---|---|---|---:|---:|---|---|
| 1000844809459077 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.78 (28d) = 36% of target after $711 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready)) | null |
| 1002443442283933 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1007048011875307 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.00 (28d) = 0% of target after $678 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready)) | null |
| 1008302678413358 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1014356057726711 | test_more | null | 60 | null | Below commercial maturity (28d spend $262 < $310 loss-budget floor, 1 purchases) — let the creative accumulate signal. | null |
| 1018252307526601 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1023264806904899 | test_more | null | 60 | null | Below commercial maturity (28d spend $51 < $310 loss-budget floor, 0 purchases, age 17d) — let the creative accumulate signal. | null |
| 1023932563648623 | test_more | null | 60 | null | Below commercial maturity (28d spend $3 < $310 loss-budget floor, 0 purchases, age 2d) — let the creative accumulate signal. | null |
| 1030352566602424 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1031796332841133 | test_more | null | 60 | null | [soft-only - cut blocked] ROAS 0.48 (28d) = 22% of target after $312 spend (28d) — loss-budget maturity reached at $310; cut underperforming creative. (threshold baseline account_history has low confidence (meta AOV ready)) | null |
| 1033614439176557 | out_of_scope | null | 60 | null | mixed decision context; evaluate at ad grain | null |
| 1111657292040172 | out_of_scope | null | 60 | null | decision context identity unavailable; evaluate at ad grain | null |

Outcome episode samples:
| Date | Window | Creative | Label | Outcome | Rule | Baseline spend | Outcome spend | Outcome ROAS |
|---|---:|---|---|---|---|---:|---:|---:|
| 2026-06-29 | 7 | 1345674994165648 | test_more | positive | non_hard_missed_cut_opportunity | 9,836.80 | 3,127.30 | 0.91 |
| 2026-06-29 | 7 | 3041651776171249 | test_more | positive | non_hard_missed_cut_opportunity | 5,744.88 | 2,401.18 | 1.02 |
| 2026-06-29 | 7 | 2061803274760111 | test_more | positive | non_hard_missed_cut_opportunity | 86.69 | 1,661.56 | 1.18 |
| 2026-06-29 | 7 | 1546542256949523 | test_more | positive | non_hard_missed_cut_opportunity | 1,732.33 | 1,497.61 | 1.12 |
| 2026-07-01 | 7 | 2061803274760111 | keep | positive | non_hard_missed_cut_opportunity | 457.67 | 1,290.58 | 0.90 |
| 2026-07-01 | 7 | 1377865124404006 | keep | positive | non_hard_missed_cut_opportunity | 1,059.66 | 986.29 | 0.34 |
| 2026-06-29 | 7 | 1631905067884325 | keep | positive | non_hard_missed_cut_opportunity | 2,482.10 | 968.97 | 0.78 |
| 2026-07-02 | 7 | 2061803274760111 | test_more | positive | non_hard_missed_cut_opportunity | 823.84 | 924.41 | 0.95 |
| 2026-06-29 | 7 | 913690625083809 | test_more | positive | non_hard_missed_cut_opportunity | 3,554.01 | 872.97 | 0.00 |
| 2026-06-29 | 7 | 1751801452484886 | test_more | positive | non_hard_missed_cut_opportunity | 1,637.63 | 690.77 | 0.49 |
| 2026-06-29 | 7 | 1007048011875307 | test_more | positive | non_hard_missed_cut_opportunity | 322.99 | 432.73 | 0.00 |
| 2026-06-29 | 7 | 1338454571581641 | test_more | positive | non_hard_missed_cut_opportunity | 399.25 | 412.45 | 1.35 |
