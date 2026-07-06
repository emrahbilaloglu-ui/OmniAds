# Operator Response Report (hard decisions: cut/scale) - 2026-06-01 to 2026-07-05

Read-only companion evidence for the 2026-07-02 math review gap: operator compliance with a cut mechanically lowers measured precision (zero forward spend => 'unknown' outcome), so this report measures whether hard decisions were actually followed and quantifies the precision-denominator interaction. No DB writes, no provider writes, no jobs executed.

## Live Status

- generatedAt: 2026-07-06T14:34:28.722Z
- liveStatus: live_db_read_only; readOnly: true
- window: 2026-06-01 .. 2026-07-05
- response windows: 1/3/7d; outcome window: 7d; cut threshold: forward daily spend < 10% of baseline or status leaves ACTIVE; scale proxy: mean forward daily spend > 125% of baseline
- cohort: 35 deduped decisions (5 decision_changed event rows, 35 first-seen snapshot rows; sources: {"event":0,"snapshot_first_seen":30,"both":5})
- data ceilings (meta_creative_daily max date raw -> last complete day used): TheSwaf=2026-07-06->2026-07-05, Grandmix=2026-07-06->2026-07-05, Halıcızade=2026-07-06->2026-07-05, Tiles Workshop=2026-06-19->2026-06-19, IwaStore=2026-07-06->2026-07-05
- source tables: engine_v3_decision_events, engine_v3_decision_snapshots_daily, meta_creative_daily, businesses

## Engine version: v3-2026-07-02-math-guardrails

### Overall

- cuts: 30 total; 9 measurable, 3 zero-spend-at-decision, 18 unobservable (data ceiling)
- cut response (lower bound, any observable day): 2/9 (22.22%); median days-to-response: 1

Cut response by window (fully observable windows only):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 9 | 2 | 22.22% | 0 |
| 3d | 7 | 0 | 0% | 2 |
| 7d | 0 | 0 | n/a | 9 |

- spend after unresponded cuts (observed forward <=7d, truncated): 3195.15 across 7 unresponded cuts
- unknown-outcome interaction: 1/2 (50%) of responded cuts have zero observed forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 5 total; 5 measurable, 0 zero-spend-at-decision, 0 unobservable

Scale response by window (crude spend-rise proxy):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 5 | 1 | 20% | 0 |
| 3d | 2 | 1 | 50% | 3 |
| 7d | 0 | 0 | n/a | 5 |

### Grandmix (raw ceiling 2026-07-06, last complete day 2026-07-05)

- cuts: 2 total; 1 measurable, 0 zero-spend-at-decision, 1 unobservable (data ceiling)
- cut response (lower bound, any observable day): 1/1 (100%); median days-to-response: 1

Cut response by window (fully observable windows only):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 1 | 1 | 100% | 0 |
| 3d | 0 | 0 | n/a | 1 |
| 7d | 0 | 0 | n/a | 1 |

- spend after unresponded cuts (observed forward <=7d, truncated): 0 across 0 unresponded cuts
- unknown-outcome interaction: 0/1 (0%) of responded cuts have zero observed forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 0 total; 0 measurable, 0 zero-spend-at-decision, 0 unobservable

### Halıcızade (raw ceiling 2026-07-06, last complete day 2026-07-05)

- cuts: 1 total; 1 measurable, 0 zero-spend-at-decision, 0 unobservable (data ceiling)
- cut response (lower bound, any observable day): 1/1 (100%); median days-to-response: 1

Cut response by window (fully observable windows only):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 1 | 1 | 100% | 0 |
| 3d | 0 | 0 | n/a | 1 |
| 7d | 0 | 0 | n/a | 1 |

- spend after unresponded cuts (observed forward <=7d, truncated): 0 across 0 unresponded cuts
- unknown-outcome interaction: 1/1 (100%) of responded cuts have zero observed forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 0 total; 0 measurable, 0 zero-spend-at-decision, 0 unobservable

### IwaStore (raw ceiling 2026-07-06, last complete day 2026-07-05)

- cuts: 1 total; 0 measurable, 0 zero-spend-at-decision, 1 unobservable (data ceiling)
- cut response (lower bound, any observable day): 0/0; median days-to-response: n/a

Cut response by window (fully observable windows only):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 0 | 0 | n/a | 0 |
| 3d | 0 | 0 | n/a | 0 |
| 7d | 0 | 0 | n/a | 0 |

- spend after unresponded cuts (observed forward <=7d, truncated): 0 across 0 unresponded cuts
- unknown-outcome interaction: 0/0 of responded cuts have zero observed forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 2 total; 2 measurable, 0 zero-spend-at-decision, 0 unobservable

Scale response by window (crude spend-rise proxy):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 2 | 0 | 0% | 0 |
| 3d | 0 | 0 | n/a | 2 |
| 7d | 0 | 0 | n/a | 2 |

### TheSwaf (raw ceiling 2026-07-06, last complete day 2026-07-05)

- cuts: 11 total; 7 measurable, 3 zero-spend-at-decision, 1 unobservable (data ceiling)
- cut response (lower bound, any observable day): 0/7 (0%); median days-to-response: n/a

Cut response by window (fully observable windows only):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 7 | 0 | 0% | 0 |
| 3d | 7 | 0 | 0% | 0 |
| 7d | 0 | 0 | n/a | 7 |

- spend after unresponded cuts (observed forward <=7d, truncated): 3195.15 across 7 unresponded cuts
- unknown-outcome interaction: 0/0 of responded cuts have zero observed forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 3 total; 3 measurable, 0 zero-spend-at-decision, 0 unobservable

Scale response by window (crude spend-rise proxy):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 3 | 1 | 33.33% | 0 |
| 3d | 2 | 1 | 50% | 1 |
| 7d | 0 | 0 | n/a | 3 |

### Tiles Workshop (raw ceiling 2026-06-19, last complete day 2026-06-19)

- cuts: 15 total; 0 measurable, 0 zero-spend-at-decision, 15 unobservable (data ceiling)
- cut response (lower bound, any observable day): 0/0; median days-to-response: n/a

Cut response by window (fully observable windows only):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 0 | 0 | n/a | 0 |
| 3d | 0 | 0 | n/a | 0 |
| 7d | 0 | 0 | n/a | 0 |

- spend after unresponded cuts (observed forward <=7d, truncated): 0 across 0 unresponded cuts
- unknown-outcome interaction: 0/0 of responded cuts have zero observed forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 0 total; 0 measurable, 0 zero-spend-at-decision, 0 unobservable

## Per-decision detail

| Business | Creative | Label | Decision date | Source | Bucket | Baseline/day | Fwd days | Response day | Signal | Fwd 7d spend | Unknown via zero fwd spend |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| Grandmix | 1003770772089284 | cut | 2026-07-03 | snapshot_first_seen | measurable | 20.84 | 2 | 1 | status_left_active | 2.93 | no |
| Grandmix | 2257729818314797 | cut | 2026-07-05 | snapshot_first_seen | unobservable_forward_window | 53.45 | 0 | - | - | 0 | no |
| Halıcızade | 4486561654913204 | cut | 2026-07-03 | snapshot_first_seen | measurable | 384.19 | 2 | 1 | spend_drop | 0 | yes |
| IwaStore | 1655577498670460 | scale | 2026-07-03 | snapshot_first_seen | measurable | 6.78 | 2 | 1 | spend_drop | 0 | yes |
| IwaStore | 946471284944193 | scale | 2026-07-03 | snapshot_first_seen | measurable | 15.55 | 2 | 1 | spend_drop | 0 | yes |
| IwaStore | 1157254709850013 | cut | 2026-07-05 | both | unobservable_forward_window | 1.35 | 0 | - | - | 0 | no |
| TheSwaf | 1000844809459077 | cut | 2026-07-02 | snapshot_first_seen | measurable | 8.62 | 3 | - | - | 41.18 | no |
| TheSwaf | 1007048011875307 | cut | 2026-07-02 | snapshot_first_seen | measurable | 100.15 | 3 | - | - | 129.12 | no |
| TheSwaf | 1337157688566977 | cut | 2026-07-02 | snapshot_first_seen | measurable | 22.36 | 3 | - | - | 93.35 | no |
| TheSwaf | 1377865124404006 | scale | 2026-07-02 | snapshot_first_seen | measurable | 207.25 | 3 | - | - | 701.87 | no |
| TheSwaf | 1511570353840312 | scale | 2026-07-02 | snapshot_first_seen | measurable | 5.02 | 3 | - | - | 145.64 | no |
| TheSwaf | 1546542256949523 | cut | 2026-07-02 | snapshot_first_seen | measurable | 357.42 | 3 | - | - | 708.36 | no |
| TheSwaf | 1932525757401873 | cut | 2026-07-02 | snapshot_first_seen | zero_spend_at_decision | n/a | 3 | - | - | 0 | yes |
| TheSwaf | 1962656064410174 | cut | 2026-07-02 | snapshot_first_seen | measurable | 251.84 | 3 | - | - | 603.48 | no |
| TheSwaf | 2080314776223824 | cut | 2026-07-02 | snapshot_first_seen | zero_spend_at_decision | n/a | 3 | - | - | 0 | yes |
| TheSwaf | 2734470570262623 | cut | 2026-07-02 | snapshot_first_seen | zero_spend_at_decision | n/a | 3 | - | - | 0 | yes |
| TheSwaf | 3041651776171249 | cut | 2026-07-02 | snapshot_first_seen | measurable | 392.53 | 3 | - | - | 1191.87 | no |
| TheSwaf | 913690625083809 | cut | 2026-07-02 | snapshot_first_seen | measurable | 45.59 | 3 | - | - | 427.79 | no |
| TheSwaf | 1345796717452247 | scale | 2026-07-04 | both | measurable | 43.52 | 1 | - | - | 38.22 | no |
| TheSwaf | 826201780574762 | cut | 2026-07-05 | both | unobservable_forward_window | 29.81 | 0 | - | - | 0 | no |
| Tiles Workshop | 1042376994660818 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 1124168746317341 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 1238676120520278 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 1259131729556067 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 1264667732121150 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 1292494029432068 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 1713831619786925 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 2310316516043464 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 2380056079073883 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 2434481843638891 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 4295255303953852 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 4389333598006385 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 672236422177292 | cut | 2026-07-03 | snapshot_first_seen | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 747209084691729 | cut | 2026-07-04 | both | unobservable_forward_window | n/a | 0 | - | - | 0 | no |
| Tiles Workshop | 25889037484086563 | cut | 2026-07-05 | both | unobservable_forward_window | n/a | 0 | - | - | 0 | no |

## Method & Evidence Limits

- Read-only analysis: SELECT-only DB access; the dormant engine_v3_operator_response_job was NOT executed and no engine_v3 rows were written.
- Cohort = decision_changed events flipping to cut/scale UNION first-seen cut/scale decision snapshots in the window, deduped per (business, creative, label) keeping the earliest date. Events alone severely undercount (5 event rows vs the snapshot universe), so first-seen snapshots are included as stated in the task; 'first-seen' means the first as_of_date in the analysis window carrying the label, which overcounts genuinely new decisions if a label was already active before the window (snapshots only exist from 2026-07-02, so within this window every first-seen date is also the first snapshot ever).
- engine_v3_decision_events has no engine_version column; event engine_version is resolved via the linked decision snapshot and falls back to 'unknown'.
- Baseline daily spend = decision-day spend when positive, else the trailing 7-day mean daily spend (fallback needed because several decisions have zero decision-day spend); decisions with no baseline are bucketed as zero_spend_at_decision and excluded from response-rate denominators.
- Cut response = forward daily spend < 10% of baseline OR effective_status leaves ACTIVE (PAUSED / CAMPAIGN_PAUSED / DELETED / missing-ACTIVE). Missing forward rows inside the observable window count as zero spend, mirroring the decision-outcomes job COALESCE semantics. Spend-based responses cannot distinguish operator action from Meta delivery collapse; treat as operator-or-delivery response.
- Scale response is a CRUDE PROXY: mean forward daily spend over the window > 125% of baseline daily spend. It does not verify budget changes or action-journal receipts (the dormant job's richer detector needs scale/refresh recommendations plus budget history; not re-run here).
- Forward windows are truncated at each business's LAST COMPLETE meta_creative_daily day. A raw ceiling equal to the run date is an intraday partial ingest (verified: ceiling-day business spend runs at ~10-25% of typical complete days) and is excluded, because partial-day spend mechanically fakes cut 'responses'; before this exclusion, five TheSwaf 2026-07-02 cuts all 'responded' on the partial day. All qualifying decisions fall on 2026-07-02..05 with 2026-07-05 as the last complete day, so NO 7d window is fully observable, 3d windows are only fully observable for 2026-07-02 decisions, and 2026-07-05 decisions have zero observable forward days (bucketed unobservable). Per-window rates use only fully observable windows; the lower-bound rate uses any observable forward day.
- Tiles Workshop's meta_creative_daily ceiling is 2026-06-19 while its decisions are dated 2026-07-03..05: its entire cohort is unobservable_forward_window (the engine decided on stale warehouse data); its cuts appear in counts but in no response-rate denominator.
- Unknown-outcome interaction mirrors the outcome-classifier rule missing_outcome_spend_or_target: zero forward spend over the (truncated) 7d outcome window => realized_outcome 'unknown'. With truncated windows this is the observed-so-far share; a creative could still spend after the ceiling.
- The dormant job's RESPONSE_WINDOW_DAYS=30 is a lookback for scale/refresh recommendation detection and is reported for context only; this report's response windows are 1/3/7 days per the task spec.
