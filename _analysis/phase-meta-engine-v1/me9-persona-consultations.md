# ME9 Persona Consultations — Signal Backfill

Timestamp: 2026-05-08

## Signal A — frequency_p80

Question: Aria and Dr. Lin — given E1/E3 fatigue emitters need distribution-aware frequency, how do you weigh p80 frequency versus mean frequency?

Aria: Mean frequency hides the tired tail. Use p80 when available; if only mean frequency exists, treat it as secondary evidence. Refresh should require frequency pressure and CTR not above the calibrated median.

Dr. Lin: p80 is only meaningful with enough delivery. ME9 uses a 1,000-impression floor before writing `frequency_p80`; below that the signal remains null and the emitter does not claim high confidence.

Outcome: `frequency_p80` is impression-weighted from daily rows, requires at least 1,000 impressions, and E1 consumes the signal first. Mean adset frequency remains a fallback only when the signal row is unavailable.

## Signal B — ctr_decay_pct

Question: Aria and Dr. Lin — given E2 needs 7d-vs-14d CTR decay, how should we avoid false creative-refresh calls from spend volatility?

Aria: Use the recent creative click decay, not ROAS alone. A refresh call should fire when the click path visibly weakens while delivery is still active.

Dr. Lin: Require comparable spend in both weeks. ME9 rejects CTR decay when the last-7d spend to previous-7d spend ratio is outside 0.5-2.0.

Outcome: `ctr_decay_pct` is stored as `(ctr_7d / ctr_14d - 1) * 100`; E2/E4 require a non-null value at or below -15%. Missing or volatile-spend signals suppress the refresh emitter.

## Signal C — creative_age_days_max

Question: Aria and Sam — given E4 needs creative age, should ad churn weaken the signal?

Aria: Aged active ads plus CTR decay is enough for a refresh recommendation; age alone should not trigger.

Sam: Aggregate active ads at adset/campaign scope and keep quality transparent. If there are no active ads, keep the signal null rather than inferring age from stale rows.

Outcome: ME9 computes `creative_age_days_max` from `meta_ad_dimensions.first_seen_at` for active/with-issues ads only. E4 requires both `creative_age_days_max >= 21` and CTR decay.

## Signal D — last_significant_edit_at

Question: Sam and Dr. Lin — what counts as a significant edit, and how long should cooldown suppress diagnostic/scale emitters?

Sam: Budget changes over 20%, bid strategy changes, optimization-event changes, and promoted-object changes are structural enough to explain short-term volatility.

Dr. Lin: A seven-day cooldown is the conservative floor. If the edit is inside that window, avoid high-confidence scale and avoid diagnosing ROAS drops as fatigue or auction pressure.

Outcome: ME9 writes `last_significant_edit_at` and `days_since_significant_edit` from config-history deltas. C1/J1/F1/F4 suppress when `days_since_significant_edit < 7`.

## Signal E — learning_state

Question: Dr. Lin and Sam — if Meta API learning state is unavailable, how should inference be marked?

Dr. Lin: Do not call inferred state authoritative. Use conversion density and age as a confidence cap, and do not fire A1/A2 when the learning signal is missing.

Sam: Campaign learning state should aggregate child adsets; worst child state wins because architecture inherits the weakest active delivery cell.

Outcome: ME9 infers adset state from 7d purchase density and age, then aggregates campaign state by worst child adset. Because the table’s existing `quality_status` constraint is additive-only, rows use `quality_status=partial|ready` and mark `source_json.learning_state_quality = "inferred"`.

## Deferred Signals

Signal F `audience_overlap_pct` is deferred to engine v2 because it requires a cross-campaign overlap matrix and no ME2-redo wired emitter depends on it.

Signal G `feed_disapproval_count` is deferred to engine v2 because K4 was not in the ME2-redo wired-12 production set.
