# Phase A Meta Decision Hygiene - Live Smoke Evidence

Captured: 2026-05-15T20:02:25Z
Branch: `phase-a-meta-decision-hygiene`
Base SHA: `0b79c22229de09b014b0dc8fff91ee2bf74bb8c7`

Scope: read-only production DB smoke using `.env.local` `DATABASE_URL`.
Connection string and secrets were not printed.

## DB Sanity

```text
current_database | current_user | now
adsecute_prod | adsecute_app | 2026-05-15 19:58:50.47832+00
```

## Warehouse Funnel Payload Metrics

Query window: `meta_ad_daily.date >= current_date - interval '14 days'`.

```text
rows | min_date | max_date | has_thruplay_key | thruplay_sum | has_view_content_key | view_content_sum | has_post_engagement_key | post_engagement_sum
5306 | 2026-05-01 | 2026-05-15 | 342 | 19894 | 342 | 6355 | 342 | 87295
```

Interpretation: the new payload fields are present in recent production
warehouse rows. This supports the completed ingest path for ThruPlay,
`view_content`, and `post_engagement`.

## Calibration Rows By Cohort

Query window: `meta_decision_calibration_daily.snapshot_date >= current_date - interval '14 days'`.

```text
snapshot_date | cohort | scope_type | rows | sample_sum | min_sample_size | max_sample_size
2026-05-15 | purchase | account | 76 | 573 | 1 | 33
2026-05-15 | purchase | campaign | 6 | 45 | 7 | 8
2026-05-14 | purchase | account | 70 | 580 | 1 | 34
2026-05-14 | purchase | campaign | 6 | 45 | 7 | 8
2026-05-13 | purchase | account | 70 | 600 | 1 | 34
2026-05-13 | purchase | campaign | 6 | 45 | 7 | 8
2026-05-12 | purchase | account | 70 | 588 | 1 | 34
2026-05-12 | purchase | campaign | 6 | 33 | 3 | 8
2026-05-11 | purchase | account | 70 | 573 | 1 | 34
2026-05-10 | purchase | account | 70 | 568 | 1 | 34
2026-05-09 | purchase | account | 70 | 536 | 1 | 34
2026-05-08 | purchase | account | 70 | 539 | 1 | 34
2026-05-07 | purchase | account | 64 | 526 | 1 | 34
```

Interpretation: production currently has recent purchase calibration rows only.
No `mid_funnel`, `lead`, `traffic`, `upper_funnel`, or `engagement` calibration
rows were observed in this 14-day window. This means non-purchase emitters may
be code-ready but calibration-starved in live data today.

## Latest Adset Cohort Opportunity

Latest `meta_adset_daily` partition observed: 2026-05-14.

```text
latest_date | cohort | adsets | spending_adsets | spend | impressions
2026-05-14 | engagement | 82 | 0 | 0.00 | 0
2026-05-14 | lead | 1 | 0 | 0.00 | 0
2026-05-14 | mid_funnel | 30 | 1 | 14.50 | 838
2026-05-14 | purchase | 1028 | 47 | 5743.21 | 268688
2026-05-14 | traffic | 79 | 1 | 8.85 | 1689
2026-05-14 | unknown | 503 | 16 | 25550.82 | 316842
2026-05-14 | upper_funnel | 19 | 1 | 19.50 | 4723
```

Interpretation: non-purchase cohort rows exist, but current spend/sample volume
is likely too thin for account/campaign calibration thresholds. The large
`unknown` bucket also supports Phase A/B/C cleanup work around single-source
cohort resolution and data readiness.

## Non-Purchase Snapshot Emission

Query: snapshot rows where `rec_type` matches `scenario_m*`, `scenario_l*`,
`scenario_t*`, or `scenario_eg*`.

```text
rows returned: 0
```

Query for upper-funnel informational snapshot/card-like rec types:

```text
rows returned: 0
```

Interpretation: no live snapshot emission was observed for the newly added
non-purchase emitter families or upper-funnel informational card recs. This is
not a code failure by itself; it is consistent with missing/non-mature
non-purchase calibration and sparse active non-purchase spend.

## Entity Decision Signals Coverage

Query window: `meta_entity_decision_signals_daily.as_of_date >= current_date - interval '14 days'`.

```text
as_of_date | scope_type | rows | ready | partial | learning | overlap | recent_edit | creative_age_max | frequency_p80 | ctr_decay
2026-05-15 | adset | 3187 | 470 | 2717 | 3187 | 0 | 804 | 1616 | 132 | 40
2026-05-15 | campaign | 2071 | 1013 | 1058 | 2071 | 0 | 2015 | 1052 | 93 | 34
2026-05-14 | adset | 3148 | 464 | 2684 | 3148 | 0 | 792 | 1591 | 128 | 41
2026-05-14 | campaign | 2049 | 1005 | 1044 | 2049 | 0 | 1966 | 1042 | 90 | 33
2026-05-13 | adset | 3147 | 470 | 2677 | 3147 | 0 | 806 | 1590 | 131 | 32
2026-05-13 | campaign | 2048 | 1032 | 1016 | 2048 | 0 | 2027 | 1041 | 93 | 28
2026-05-12 | adset | 3145 | 473 | 2672 | 3145 | 0 | 817 | 1588 | 132 | 27
2026-05-12 | campaign | 2047 | 1012 | 1035 | 2047 | 0 | 1870 | 1040 | 94 | 26
2026-05-11 | adset | 3145 | 471 | 2674 | 3145 | 0 | 831 | 1588 | 126 | 26
2026-05-11 | campaign | 2046 | 1027 | 1019 | 2046 | 0 | 2022 | 1039 | 95 | 26
2026-05-10 | adset | 3137 | 598 | 2539 | 3137 | 0 | 1141 | 1545 | 126 | 25
2026-05-10 | campaign | 2045 | 1007 | 1038 | 2045 | 0 | 2039 | 1007 | 95 | 25
2026-05-09 | adset | 3129 | 132 | 2997 | 3129 | 0 | 45 | 1519 | 119 | 15
2026-05-09 | campaign | 2039 | 994 | 1045 | 2039 | 0 | 2033 | 994 | 90 | 9
2026-05-08 | adset | 184 | 41 | 143 | 184 | 0 | 27 | 126 | 29 | 14
2026-05-08 | campaign | 103 | 78 | 25 | 103 | 0 | 96 | 78 | 17 | 9
```

Interpretation: the entity-signal backfill is producing fresh rows. However,
`audience_overlap_pct` coverage is zero in this evidence window. D-phase overlap
work is therefore a populate/gap-fix problem, not just a reader-extension task.

## Campaign Label Coverage

Latest active-campaign label coverage, using latest `meta_ad_daily` partition
and `spend > 0` as active delivery proxy:

```text
latest_date | active_campaigns | labeled_active_campaigns | main_labels | test_labels | mixed_labels
2026-05-15 | 61 | 0 | 0 | 0 | 0
```

All label rows:

```text
total_labels | main_labels | test_labels | mixed_labels | min_labeled_at | max_labeled_at
0 | 0 | 0 | 0 | null | null
```

Interpretation: the label substrate exists but production adoption is currently
zero. Meta hard-action label guards are expected to block label-dependent
actions until the UI/user labeling workflow populates this table.
