# June Operator Alignment - replayed hard decisions (weekly June grid) vs organic operator response, full 7d windows

Read-only companion to OPERATOR_RESPONSE_REPORT_2026-06-01_TO_2026-07-05.md: that report's persisted hard decisions all fell on 2026-07-02..05, so no full 7d forward window existed. Here the CURRENT engine replays what its hard decisions WOULD have been on a weekly June asOf grid, and June forward spend is complete through the evaluation ceiling - every 1/3/7d window is fully observable. The operator never saw these decisions; rates measure ORGANIC agreement, not compliance. No DB writes, no provider writes, no cron POST.

## Live Status

- generatedAt: 2026-07-06T16:58:14.838Z
- liveStatus: live_db_read_only; readOnly: true
- engineVersion (replay): v3-2026-07-06-decision-stability
- asOf grid: 2026-06-01, 2026-06-08, 2026-06-15, 2026-06-22; evaluation ceiling: 2026-07-05
- response windows: 1/3/7d; outcome window: 7d; cut threshold: forward daily spend < 10% of baseline or status leaves ACTIVE; scale proxy: mean forward daily spend > 125% of baseline
- businesses: 13 enabled included; excluded: Tiles Workshop (broken feed / sync problem (user directive))
- cohort: 65 deduped hard decisions (58 cut, 7 scale) from 124 grid rows; 37 recur on later grid dates
- data ceilings (raw -> last complete day used): ColorFullWorldsTR=2026-07-06->2026-07-05, EMOLOS=2026-07-06->2026-07-05, Grandmix=2026-07-06->2026-07-05, Halıcızade=2026-07-06->2026-07-05, IwaStore=2026-07-06->2026-07-05, TheSwaf=2026-07-06->2026-07-05
- source tables: meta_creative_daily, businesses, business_engine_v3_flags, meta campaign label + engine calibration tables (via the production decide+guard path)

## Replay grid

| asOf | Businesses ok | Failed | Creative inputs | Deduped decisions | Hard cut | Hard scale | New in cohort |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-06-01 | 13 | 0 | 904 | 904 | 34 | 3 | 37 |
| 2026-06-08 | 13 | 0 | 897 | 897 | 35 | 5 | 10 |
| 2026-06-15 | 13 | 0 | 840 | 840 | 24 | 0 | 6 |
| 2026-06-22 | 13 | 0 | 730 | 730 | 21 | 2 | 12 |

## Overall (all businesses, Tiles Workshop excluded)

- cuts: 58 total; 31 measurable, 27 zero-spend-at-decision, 0 unobservable (data ceiling)
- organic cut response (any day in 7d window): 21/31 (67.74%); median days-to-response: 1

Organic cut response by window (all windows fully observable):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 31 | 21 | 67.74% | 0 |
| 3d | 31 | 21 | 67.74% | 0 |
| 7d | 31 | 21 | 67.74% | 0 |

- spend after unresponded cuts (FULL 7d forward window): 14264.06 across 10 unresponded cuts
- unknown-outcome interaction: 10/21 (47.62%) of responded cuts have zero forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 7 total; 7 measurable, 0 zero-spend-at-decision, 0 unobservable

Organic scale response by window (crude spend-rise proxy):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 7 | 2 | 28.57% | 0 |
| 3d | 7 | 1 | 14.29% | 0 |
| 7d | 7 | 2 | 28.57% | 0 |

### ColorFullWorldsTR (raw ceiling 2026-07-06, last complete day used 2026-07-05)

- cuts: 2 total; 0 measurable, 2 zero-spend-at-decision, 0 unobservable (data ceiling)
- organic cut response (any day in 7d window): 0/0; median days-to-response: n/a

Organic cut response by window (all windows fully observable):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 0 | 0 | n/a | 0 |
| 3d | 0 | 0 | n/a | 0 |
| 7d | 0 | 0 | n/a | 0 |

- spend after unresponded cuts (FULL 7d forward window): 0 across 0 unresponded cuts
- unknown-outcome interaction: 0/0 of responded cuts have zero forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 1 total; 1 measurable, 0 zero-spend-at-decision, 0 unobservable

Organic scale response by window (crude spend-rise proxy):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 1 | 0 | 0% | 0 |
| 3d | 1 | 0 | 0% | 0 |
| 7d | 1 | 0 | 0% | 0 |

### EMOLOS (raw ceiling 2026-07-06, last complete day used 2026-07-05)

- cuts: 12 total; 6 measurable, 6 zero-spend-at-decision, 0 unobservable (data ceiling)
- organic cut response (any day in 7d window): 6/6 (100%); median days-to-response: 1

Organic cut response by window (all windows fully observable):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 6 | 6 | 100% | 0 |
| 3d | 6 | 6 | 100% | 0 |
| 7d | 6 | 6 | 100% | 0 |

- spend after unresponded cuts (FULL 7d forward window): 0 across 0 unresponded cuts
- unknown-outcome interaction: 1/6 (16.67%) of responded cuts have zero forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 0 total; 0 measurable, 0 zero-spend-at-decision, 0 unobservable

### Grandmix (raw ceiling 2026-07-06, last complete day used 2026-07-05)

- cuts: 7 total; 1 measurable, 6 zero-spend-at-decision, 0 unobservable (data ceiling)
- organic cut response (any day in 7d window): 0/1 (0%); median days-to-response: n/a

Organic cut response by window (all windows fully observable):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 1 | 0 | 0% | 0 |
| 3d | 1 | 0 | 0% | 0 |
| 7d | 1 | 0 | 0% | 0 |

- spend after unresponded cuts (FULL 7d forward window): 88.68 across 1 unresponded cuts
- unknown-outcome interaction: 0/0 of responded cuts have zero forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 1 total; 1 measurable, 0 zero-spend-at-decision, 0 unobservable

Organic scale response by window (crude spend-rise proxy):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 1 | 1 | 100% | 0 |
| 3d | 1 | 0 | 0% | 0 |
| 7d | 1 | 0 | 0% | 0 |

### Halıcızade (raw ceiling 2026-07-06, last complete day used 2026-07-05)

- cuts: 1 total; 1 measurable, 0 zero-spend-at-decision, 0 unobservable (data ceiling)
- organic cut response (any day in 7d window): 1/1 (100%); median days-to-response: 1

Organic cut response by window (all windows fully observable):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 1 | 1 | 100% | 0 |
| 3d | 1 | 1 | 100% | 0 |
| 7d | 1 | 1 | 100% | 0 |

- spend after unresponded cuts (FULL 7d forward window): 0 across 0 unresponded cuts
- unknown-outcome interaction: 1/1 (100%) of responded cuts have zero forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 0 total; 0 measurable, 0 zero-spend-at-decision, 0 unobservable

### IwaStore (raw ceiling 2026-07-06, last complete day used 2026-07-05)

- cuts: 3 total; 3 measurable, 0 zero-spend-at-decision, 0 unobservable (data ceiling)
- organic cut response (any day in 7d window): 2/3 (66.67%); median days-to-response: 1

Organic cut response by window (all windows fully observable):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 3 | 2 | 66.67% | 0 |
| 3d | 3 | 2 | 66.67% | 0 |
| 7d | 3 | 2 | 66.67% | 0 |

- spend after unresponded cuts (FULL 7d forward window): 62.49 across 1 unresponded cuts
- unknown-outcome interaction: 0/2 (0%) of responded cuts have zero forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 5 total; 5 measurable, 0 zero-spend-at-decision, 0 unobservable

Organic scale response by window (crude spend-rise proxy):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 5 | 1 | 20% | 0 |
| 3d | 5 | 1 | 20% | 0 |
| 7d | 5 | 2 | 40% | 0 |

### TheSwaf (raw ceiling 2026-07-06, last complete day used 2026-07-05)

- cuts: 33 total; 20 measurable, 13 zero-spend-at-decision, 0 unobservable (data ceiling)
- organic cut response (any day in 7d window): 12/20 (60%); median days-to-response: 1

Organic cut response by window (all windows fully observable):

| Window | Evaluable | Responded | Rate | Truncated |
| --- | ---: | ---: | ---: | ---: |
| 1d | 20 | 12 | 60% | 0 |
| 3d | 20 | 12 | 60% | 0 |
| 7d | 20 | 12 | 60% | 0 |

- spend after unresponded cuts (FULL 7d forward window): 14112.89 across 8 unresponded cuts
- unknown-outcome interaction: 8/12 (66.67%) of responded cuts have zero forward spend => 7d realized_outcome 'unknown' (missing_outcome_spend_or_target)
- scales: 0 total; 0 measurable, 0 zero-spend-at-decision, 0 unobservable

## Per-decision detail

| Business | Creative | Label | Grid asOf | Grid hits | Conf | Bucket | Baseline/day (source) | Resp day | Signal | 1d | 3d | 7d | Fwd 7d spend | Unknown via zero fwd spend |
| --- | --- | --- | --- | ---: | ---: | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| ColorFullWorldsTR | 1636437490809810 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| ColorFullWorldsTR | 1696918907975404 | cut | 2026-06-01 | 1 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| ColorFullWorldsTR | 1369446851662907 | scale | 2026-06-22 | 1 | 75 | measurable | 12.25 (decision_day_spend) | - | - | no | no | no | 74.88 | no |
| EMOLOS | 1323544629737422 | cut | 2026-06-01 | 3 | 75 | measurable | 41.5 (decision_day_spend) | 1 | status_left_active | yes | yes | yes | 69.07 | no |
| EMOLOS | 1365577345392907 | cut | 2026-06-01 | 2 | 75 | measurable | 23.35 (decision_day_spend) | 1 | status_left_active | yes | yes | yes | 63.2 | no |
| EMOLOS | 1619630062596638 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| EMOLOS | 1899500230707112 | cut | 2026-06-01 | 4 | 75 | measurable | 9.54 (decision_day_spend) | 1 | status_left_active | yes | yes | yes | 11.53 | no |
| EMOLOS | 2256567028449909 | cut | 2026-06-01 | 3 | 75 | measurable | 36.3 (decision_day_spend) | 1 | status_left_active | yes | yes | yes | 75.06 | no |
| EMOLOS | 2846119509068113 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| EMOLOS | 854440610396270 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| EMOLOS | 864212896711133 | cut | 2026-06-01 | 4 | 75 | measurable | 27.47 (decision_day_spend) | 1 | status_left_active | yes | yes | yes | 45.36 | no |
| EMOLOS | 907464492353856 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| EMOLOS | 989873033626399 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| EMOLOS | 962418690099350 | cut | 2026-06-08 | 3 | 75 | measurable | 9.57 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| EMOLOS | 839861612507719 | cut | 2026-06-22 | 1 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| Grandmix | 1199888448810753 | cut | 2026-06-01 | 3 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| Grandmix | 1479802413878502 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| Grandmix | 1598668524564962 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| Grandmix | 2227936340946323 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| Grandmix | 26793283900312957 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| Grandmix | 693776863669477 | cut | 2026-06-01 | 2 | 75 | measurable | 18.56 (decision_day_spend) | - | - | no | no | no | 88.68 | no |
| Grandmix | 903459306039600 | cut | 2026-06-01 | 1 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| Grandmix | 1301214195548874 | scale | 2026-06-08 | 1 | 75 | measurable | 1 (decision_day_spend) | 5 | spend_drop | yes | no | no | 6.41 | no |
| Halıcızade | 2266855037160102 | cut | 2026-06-01 | 2 | 75 | measurable | 107.26 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| IwaStore | 1157254709850013 | scale | 2026-06-01 | 2 | 75 | measurable | 0.76 (decision_day_spend) | 3 | spend_drop | yes | yes | yes | 53.9 | no |
| IwaStore | 1658131231999984 | scale | 2026-06-01 | 1 | 75 | measurable | 167.7 (decision_day_spend) | - | - | no | no | no | 1171.63 | no |
| IwaStore | 946471284944193 | scale | 2026-06-01 | 3 | 75 | measurable | 17.09 (decision_day_spend) | - | - | no | no | no | 111.07 | no |
| IwaStore | 1597946391493220 | cut | 2026-06-08 | 1 | 75 | measurable | 16.63 (decision_day_spend) | 1 | spend_drop | yes | yes | yes | 26.57 | no |
| IwaStore | 1655577498670460 | scale | 2026-06-08 | 1 | 75 | measurable | 6.11 (decision_day_spend) | - | - | no | no | yes | 60.57 | no |
| IwaStore | 931776873000095 | scale | 2026-06-08 | 1 | 75 | measurable | 17.81 (trailing_7d_mean) | 1 | spend_drop | no | no | no | 0 | yes |
| IwaStore | 1655577498670460 | cut | 2026-06-22 | 1 | 75 | measurable | 7.28 (decision_day_spend) | - | - | no | no | no | 62.49 | no |
| IwaStore | 2195290934643087 | cut | 2026-06-22 | 1 | 75 | measurable | 4.79 (decision_day_spend) | 1 | spend_drop | yes | yes | yes | 20.03 | no |
| TheSwaf | 1278059531165819 | cut | 2026-06-01 | 4 | 75 | measurable | 79.52 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| TheSwaf | 1467822764491123 | cut | 2026-06-01 | 3 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 1475823406953354 | cut | 2026-06-01 | 4 | 75 | measurable | 61.36 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| TheSwaf | 1508640670664791 | cut | 2026-06-01 | 1 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 1618052170325754 | cut | 2026-06-01 | 4 | 75 | measurable | 29.5 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| TheSwaf | 1693489775122852 | cut | 2026-06-01 | 3 | 75 | measurable | 12.51 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| TheSwaf | 1994401467865514 | cut | 2026-06-01 | 3 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 2099681837626498 | cut | 2026-06-01 | 3 | 75 | measurable | 78.62 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| TheSwaf | 2467451360428576 | cut | 2026-06-01 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 25832123469795143 | cut | 2026-06-01 | 1 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 768783149560195 | cut | 2026-06-01 | 3 | 75 | measurable | 16.98 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| TheSwaf | 841424642307232 | cut | 2026-06-01 | 1 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 967102445774372 | cut | 2026-06-01 | 1 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 972915358838780 | cut | 2026-06-01 | 3 | 75 | measurable | 12.12 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| TheSwaf | 1347969233807910 | cut | 2026-06-08 | 1 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 1433821918546106 | cut | 2026-06-08 | 2 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 1736230237414251 | cut | 2026-06-08 | 3 | 65 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 1983341218965296 | cut | 2026-06-08 | 2 | 60 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 951995590658338 | cut | 2026-06-08 | 1 | 60 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 1014356057726711 | cut | 2026-06-15 | 1 | 75 | measurable | 48.72 (decision_day_spend) | 1 | spend_drop | yes | yes | yes | 4.55 | no |
| TheSwaf | 1592506935781034 | cut | 2026-06-15 | 1 | 75 | measurable | 414.6 (decision_day_spend) | 1 | status_left_active | yes | yes | yes | 84.46 | no |
| TheSwaf | 1672191184091002 | cut | 2026-06-15 | 1 | 75 | measurable | 645.76 (decision_day_spend) | - | - | no | no | no | 3821.85 | no |
| TheSwaf | 1932525757401873 | cut | 2026-06-15 | 2 | 75 | measurable | 131.35 (decision_day_spend) | 1 | status_left_active | yes | yes | yes | 22.76 | no |
| TheSwaf | 1962656064410174 | cut | 2026-06-15 | 2 | 75 | measurable | 394.2 (decision_day_spend) | - | - | no | no | no | 3121.94 | no |
| TheSwaf | 2080314776223824 | cut | 2026-06-15 | 2 | 75 | measurable | 126 (decision_day_spend) | 1 | status_left_active | yes | yes | yes | 18.02 | no |
| TheSwaf | 1015107537840127 | cut | 2026-06-22 | 1 | 60 | zero_spend_at_decision | n/a | - | - | n/a | n/a | n/a | 0 | yes |
| TheSwaf | 1337157688566977 | cut | 2026-06-22 | 1 | 75 | measurable | 15.31 (decision_day_spend) | - | - | no | no | no | 115.51 | no |
| TheSwaf | 1546542256949523 | cut | 2026-06-22 | 1 | 75 | measurable | 123.04 (decision_day_spend) | - | - | no | no | no | 920.49 | no |
| TheSwaf | 1631905067884325 | cut | 2026-06-22 | 1 | 75 | measurable | 151.27 (decision_day_spend) | - | - | no | no | no | 1064.94 | no |
| TheSwaf | 2734470570262623 | cut | 2026-06-22 | 1 | 75 | measurable | 1.15 (trailing_7d_mean) | 1 | spend_drop | yes | yes | yes | 0 | yes |
| TheSwaf | 3041651776171249 | cut | 2026-06-22 | 1 | 75 | measurable | 441.65 (decision_day_spend) | - | - | no | no | no | 3050.26 | no |
| TheSwaf | 826201780574762 | cut | 2026-06-22 | 1 | 75 | measurable | 29.17 (decision_day_spend) | - | - | no | no | no | 327.07 | no |
| TheSwaf | 913690625083809 | cut | 2026-06-22 | 1 | 75 | measurable | 243.36 (decision_day_spend) | - | - | no | no | no | 1690.83 | no |

## Method & Evidence Limits

- Read-only analysis: SELECT-only DB access through the read_only_observation lane; no engine tables written, no provider writes, no cron POST, no jobs executed.
- NON-CAUSAL REPLAY: decisions are recomputed with the CURRENT engine code (v3-2026-07-06-decision-stability) and CURRENT configuration over historical June inputs. Target packs, decision calibration profile config, feature flags, and Meta campaign labels have NO historical versioning and are read as of the run date - an anachronistic-target caveat: these are the decisions today's engine WOULD have made in June, not decisions any system actually made (persisted snapshots only exist from 2026-07-02).
- THE OPERATOR NEVER SAW THESE DECISIONS. 'Response' here is ORGANIC AGREEMENT with what the engine would have said, not compliance. Read it as bounds, not compliance: the organic cut-agreement rate approximates the no-tool baseline and is a plausible LOWER bound on compliance if the decisions had been surfaced; spend-after-unagreed-cuts is an UPPER bound on the spend the engine's cut advice could have avoided (it assumes every replayed cut was correct and would have been executed immediately).
- Historical freshness normalization (mirrored from current-engine-historical-replay.ts freshnessMode=historical): warehouse freshness is computed against wall-clock now(), so June inputs read as weeks stale; data-health stale tiers are normalized to 'none' and per-creative dataFreshnessHours capped at 6h. Without this the gates would spuriously demote/block hard actions and the replay would be meaningless.
- Production dedupe mirrored from jobs/decisions-job.ts compareDecisionComputations: one decision per creative per asOf, keeping the highest-priority computation (cut beats scale beats keep ...).
- Grid dedupe: a creative counts once per (business, creative, label), keyed to the FIRST grid asOf where the hard label appears (gridAppearances records recurrence). The weekly grid (2026-06-01/08/15/22) undersamples decision churn between grid dates; a creative that became hard-labeled only between grid dates is missed, and the 'decision date' is the grid date, not the first date the engine would have flipped.
- Baseline daily spend = decision-day spend when positive (spend24h semantics via the meta_creative_daily series), else the trailing 7-day mean daily spend; decisions with no baseline are bucketed zero_spend_at_decision and excluded from response-rate denominators (semantics copied from operator-response-report.ts).
- Cut response = forward daily spend < 10% of baseline OR effective_status leaves ACTIVE. Missing forward rows inside the observable window count as zero spend (decision-outcomes COALESCE semantics). Spend-based responses cannot distinguish operator action from Meta delivery collapse; treat as operator-or-delivery response.
- Scale response is a CRUDE PROXY: mean forward daily spend over the window > 125% of baseline daily spend; it does not verify budget changes or action-journal receipts.
- Forward windows are truncated at min(last complete meta_creative_daily day, evaluation ceiling 2026-07-05); a raw ceiling >= the run date is an intraday partial ingest and is excluded (operator-response-report partial-day lesson). With the June grid every 7d window closes by 2026-06-29, so 1/3/7d windows are fully observable for every business whose feed reaches the ceiling.
- Tiles Workshop is EXCLUDED entirely (broken feed / stale warehouse sync; user directive to exclude sync-problem businesses).
- Unknown-outcome interaction mirrors the outcome-classifier rule missing_outcome_spend_or_target: zero forward spend over the full 7d outcome window => realized_outcome 'unknown'. With fully closed windows this is now a final share, not observed-so-far.
