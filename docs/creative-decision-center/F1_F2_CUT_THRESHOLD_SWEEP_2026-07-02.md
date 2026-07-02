# F1/F2 Cut Threshold Sweep - 2026-07-02

This is a read-only parameter-evaluation report. It does not change resolver thresholds, formulas, database state, provider state, migrations, or operator behavior.

## Live Status

- generatedAt: 2026-07-02T17:41:03.872Z
- asOf: 2026-07-02
- engineVersion: v3-2026-07-02-math-guardrails
- revision: 2
- source: live_db_read_only
- tables: meta_creative_daily, businesses, business_target_packs, business_decision_calibration_profiles, business_engine_v3_flags

## Revision Notes

- Episode dedup now requires at least one post-trigger daily spend > 0 before the same creative can open a new cut episode.
- Evidence limits now describe attribution lag in both directions.
- Recommendation is reframed from no-change-supported to no-uniform-change-supported with account-level signals.

## Methodology

- Unit: cut episode, not daily row; after one creative opens an episode, another episode requires a new cut run plus at least one post-trigger daily spend > 0
- Lookahead bias: trailing 90d calibration percentiles are recomputed for each replay day from data available on or before that day
- Target history: business_target_packs keeps the latest target pack; historical target ROAS and breakeven ROAS are assumed fixed
- Scope: formula-level threshold sweep; campaign-label guard, provider writes, DB writes, migrations, and resolver threshold changes are not applied
- Query bound: per-business generated daily replay bounded to 180 lookback days, 90d trailing calibration, and 28d forward windows
- Defensible threshold: n >= 30 episodes

## Variants

| Variant | Meaning |
| --- | --- |
| V0_current | Current formula baseline; recovery guard already live |
| V1a_purchase_floor_2 | F1 sensitivity: purchase floor 2 or sustained-loser spend |
| V1b_purchase_floor_3 | F1 sensitivity: purchase floor 3 or sustained-loser spend |
| V1c_purchase_floor_5 | F1 sensitivity: fixed purchase floor 5 or sustained-loser spend |
| V1d_purchase_floor_half_winner | F1 account-relative: max(2, ceil(0.5 * winnerPurchaseP50)) or sustained-loser spend |
| V2a_p25_upper_clamp_1 | F2 sensitivity: cut boundary min(P25, 1.0) |
| V2b_p25_breakeven_floor | F2 sensitivity: cut boundary clamped to [breakevenRatio, 1.0] |
| V3_recommended_combo | F1+F2 combined: account-relative purchase floor and [breakevenRatio, 1.0] boundary |

## Pooled View

| Variant | Episodes | Defensible | Affected rows vs V0 | 28d early-cut rate | 28d true-loser episodes | Saved spend units | Median delay vs V0 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| V0_current | 364 | yes | 0 | 29.2% | 101 | 1,100.34 | 0 |
| V1a_purchase_floor_2 | 324 | yes | 335 | 30.8% | 89 | 1,017.26 | 0 |
| V1b_purchase_floor_3 | 307 | yes | 498 | 28.7% | 86 | 994.71 | 0 |
| V1c_purchase_floor_5 | 300 | yes | 521 | 28.8% | 84 | 989.63 | 0 |
| V1d_purchase_floor_half_winner | 311 | yes | 460 | 28.6% | 88 | 1,009.68 | 0 |
| V2a_p25_upper_clamp_1 | 363 | yes | 4 | 29.3% | 100 | 1,098.77 | 0 |
| V2b_p25_breakeven_floor | 474 | yes | 2112 | 28.0% | 154 | 2,443.18 | 0 |
| V3_recommended_combo | 423 | yes | 2413 | 29.0% | 134 | 2,329.52 | 0 |

## Business Detail

### EMOLOS

Window: 2025-12-06 to 2026-06-03; rows evaluated: 16762; target ROAS: 2.5
Preset: balanced; break-even ROAS: 2; source rows: 8755

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | 28d early-cut rate | Saved spend | Saved spend units | Delay vs V0 | Source mix |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| V0_current | 71 | yes | 524 | 0 | 11.4% | 9,789.48 | 293.79 | 0 | ratio_hard_cut:34, ratio_loss_budget:30, ratio_sustained_loser:7 |
| V1a_purchase_floor_2 | 60 | yes | 468 | 56 | 6.9% | 9,086.6 | 272.99 | 0 | ratio_hard_cut:34, ratio_loss_budget:18, ratio_sustained_loser:8 |
| V1b_purchase_floor_3 | 60 | yes | 468 | 56 | 6.9% | 9,086.6 | 272.99 | 0 | ratio_hard_cut:34, ratio_loss_budget:18, ratio_sustained_loser:8 |
| V1c_purchase_floor_5 | 60 | yes | 468 | 56 | 6.9% | 9,086.6 | 272.99 | 0 | ratio_hard_cut:34, ratio_loss_budget:18, ratio_sustained_loser:8 |
| V1d_purchase_floor_half_winner | 60 | yes | 468 | 56 | 6.9% | 9,086.6 | 272.99 | 0 | ratio_hard_cut:34, ratio_loss_budget:18, ratio_sustained_loser:8 |
| V2a_p25_upper_clamp_1 | 71 | yes | 524 | 0 | 11.4% | 9,789.48 | 293.79 | 0 | ratio_hard_cut:34, ratio_loss_budget:30, ratio_sustained_loser:7 |
| V2b_p25_breakeven_floor | 106 | yes | 1146 | 622 | 20.3% | 13,757.06 | 417.2 | 0 | ratio_loss_budget:57, ratio_hard_cut:42, ratio_sustained_loser:7 |
| V3_recommended_combo | 96 | yes | 1062 | 650 | 21.0% | 12,658.06 | 383.87 | 0 | ratio_loss_budget:46, ratio_hard_cut:42, ratio_sustained_loser:8 |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2025-12-14 | Instock | ratio_hard_cut | 2,079.46 | 31 | 1.1146 | 1.1208 |
| 2025-12-30 | Instock | ratio_hard_cut | 1,594.25 | 16 | 0.7327 | 1.9507 |
| 2026-03-26 | Instock | ratio_hard_cut | 981.17 | 21 | 1.8047 | 1.0369 |
| 2026-04-12 | Slim Fit Jeans Washed | ratio_hard_cut | 860.9 | 12 | 1.3352 | 0 |
| 2026-01-15 | Instock | ratio_hard_cut | 831 | 9 | 0.8523 | 0.8824 |
| 2026-03-17 | Slim Fit Jeans Washed | ratio_hard_cut | 744.64 | 11 | 1.4808 | 1.1649 |
| 2026-03-25 | UGC Christian E | ratio_hard_cut | 723.98 | 15 | 1.544 | 0 |
| 2026-04-17 | Instock | ratio_hard_cut | 706.15 | 12 | 1.2475 | 0 |
| 2026-03-14 | Slim Fit Jeans Washed | ratio_hard_cut | 701.3 | 11 | 1.5485 | 1.3798 |
| 2026-06-01 | Retest / Polo Product Video - Premium Pique Polo Shirt Dark Grey / Video DOF5 | ratio_hard_cut | 479.46 | 4 | 0.5761 | 0 |
| 2026-04-08 | UGC Christian E | ratio_hard_cut | 476.39 | 5 | 0.7468 | n/a |
| 2026-05-28 | Retest HOLD / Hoodies - R 4 / Video DOF5 | ratio_hard_cut | 373.91 | 1 | 0.4898 | 0.286 |

### Grandmix

Window: 2025-12-06 to 2026-06-03; rows evaluated: 5895; target ROAS: 2.2
Preset: conservative; break-even ROAS: 1.8; source rows: 8918

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | 28d early-cut rate | Saved spend | Saved spend units | Delay vs V0 | Source mix |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| V0_current | 52 | yes | 477 | 0 | 34.6% | 12,119.36 | 114.36 | 0 | ratio_loss_budget:33, ratio_hard_cut:14, ratio_sustained_loser:5 |
| V1a_purchase_floor_2 | 43 | yes | 404 | 73 | 31.8% | 9,101.77 | 86.38 | 0 | ratio_loss_budget:18, ratio_hard_cut:14, ratio_sustained_loser:11 |
| V1b_purchase_floor_3 | 35 | yes | 325 | 152 | 27.8% | 7,149.48 | 67.91 | 0 | ratio_hard_cut:14, ratio_sustained_loser:12, ratio_loss_budget:9 |
| V1c_purchase_floor_5 | 31 | yes | 308 | 169 | 26.7% | 6,614.27 | 62.83 | 0 | ratio_hard_cut:14, ratio_sustained_loser:12, ratio_loss_budget:5 |
| V1d_purchase_floor_half_winner | 39 | yes | 366 | 111 | 21.1% | 8,724.77 | 82.88 | 0 | ratio_hard_cut:14, ratio_loss_budget:13, ratio_sustained_loser:12 |
| V2a_p25_upper_clamp_1 | 51 | yes | 473 | 4 | 36.0% | 11,950.1 | 112.79 | 0 | ratio_loss_budget:33, ratio_hard_cut:13, ratio_sustained_loser:5 |
| V2b_p25_breakeven_floor | 59 | yes | 677 | 208 | 36.7% | 14,424.85 | 136.08 | 0 | ratio_loss_budget:35, ratio_hard_cut:19, ratio_sustained_loser:5 |
| V3_recommended_combo | 52 | yes | 560 | 309 | 28.0% | 11,856.56 | 112.22 | 1 | ratio_loss_budget:21, ratio_hard_cut:19, ratio_sustained_loser:12 |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-03-25 | BathroomMeta | ratio_hard_cut | 3,542.38 | 39 | 1.7706 | 2.7761 |
| 2026-03-27 | BathroomMeta | ratio_hard_cut | 3,354.22 | 39 | 2.0348 | 2.7042 |
| 2026-03-04 | WallArtMeta | ratio_hard_cut | 2,652.38 | 25 | 2.0766 | 3.3657 |
| 2025-12-05 | BathroomMeta | ratio_hard_cut | 2,086.38 | 13 | 0.9713 | n/a |
| 2025-12-19 | Utility | ratio_hard_cut | 1,356.52 | 7 | 1.1343 | 1.394 |
| 2026-05-16 | Claude-2TS-I4-1cac0362 | ratio_hard_cut | 1,159.23 | 4 | 1.086 | n/a |
| 2026-04-12 | TowelRack | ratio_hard_cut | 1,145.38 | 12 | 2.3089 | 0.3669 |
| 2026-01-19 | Utility | ratio_hard_cut | 1,120.12 | 4 | 1.1232 | n/a |
| 2026-04-29 | BathroomMeta | ratio_hard_cut | 1,098.85 | 10 | 1.8577 | 0.6013 |
| 2026-05-02 | BathroomMeta | ratio_hard_cut | 1,009.02 | 7 | 1.104 | n/a |
| 2025-12-17 | BathroomMeta | ratio_hard_cut | 968.85 | 4 | 0.636 | n/a |
| 2025-12-25 | Jealous - Winner | ratio_hard_cut | 894.32 | 1 | 0.2194 | 0 |

### IwaStore

Window: 2025-12-06 to 2026-06-03; rows evaluated: 17192; target ROAS: 3.5
Preset: balanced; break-even ROAS: 2.7; source rows: 16083

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | 28d early-cut rate | Saved spend | Saved spend units | Delay vs V0 | Source mix |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| V0_current | 151 | yes | 1303 | 0 | 42.1% | 10,785.84 | 208.11 | 0 | ratio_hard_cut:78, ratio_loss_budget:61, ratio_sustained_loser:12 |
| V1a_purchase_floor_2 | 139 | yes | 1148 | 155 | 46.6% | 9,467.48 | 182.55 | 0 | ratio_hard_cut:79, ratio_loss_budget:37, ratio_sustained_loser:23 |
| V1b_purchase_floor_3 | 130 | yes | 1064 | 239 | 44.1% | 9,281.84 | 178.47 | 0 | ratio_hard_cut:79, ratio_loss_budget:28, ratio_sustained_loser:23 |
| V1c_purchase_floor_5 | 127 | yes | 1058 | 245 | 44.8% | 9,281.84 | 178.47 | 0 | ratio_hard_cut:79, ratio_loss_budget:25, ratio_sustained_loser:23 |
| V1d_purchase_floor_half_winner | 130 | yes | 1061 | 242 | 45.6% | 9,281.84 | 178.47 | 0 | ratio_hard_cut:79, ratio_loss_budget:28, ratio_sustained_loser:23 |
| V2a_p25_upper_clamp_1 | 151 | yes | 1303 | 0 | 42.1% | 10,785.84 | 208.11 | 0 | ratio_hard_cut:78, ratio_loss_budget:61, ratio_sustained_loser:12 |
| V2b_p25_breakeven_floor | 162 | yes | 1808 | 505 | 40.7% | 13,070.97 | 249.84 | 0 | ratio_loss_budget:77, ratio_hard_cut:76, ratio_sustained_loser:9 |
| V3_recommended_combo | 137 | yes | 1511 | 692 | 46.6% | 10,680.99 | 203.97 | 0 | ratio_hard_cut:77, ratio_loss_budget:40, ratio_sustained_loser:20 |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-02-22 | In each name | ratio_hard_cut | 2,488.4 | 31 | 2.1314 | n/a |
| 2025-12-23 | home.ideas.by.g | ratio_hard_cut | 2,361.02 | 35 | 2.4191 | 5.2629 |
| 2025-12-19 | home.ideas.by.g | ratio_hard_cut | 1,912.84 | 29 | 2.4081 | 4.8082 |
| 2026-03-28 | I’m so happy | ratio_hard_cut | 1,786.93 | 26 | 1.9456 | n/a |
| 2026-02-17 | A prayer rug | ratio_hard_cut | 1,687.35 | 17 | 2.1306 | n/a |
| 2026-02-13 | A prayer rug | ratio_hard_cut | 1,584.65 | 16 | 2.1263 | 2.1691 |
| 2025-12-05 | Whenever I am | ratio_hard_cut | 1,471.5 | 24 | 2.0205 | n/a |
| 2026-03-11 | Febieyyi | ratio_hard_cut | 1,463.64 | 20 | 2.0738 | 2.3391 |
| 2026-03-21 | Febieyyi | ratio_hard_cut | 1,365.91 | 14 | 1.7929 | 4.6438 |
| 2025-12-27 | WallArtCatalog | ratio_hard_cut | 1,352.87 | 21 | 2.3127 | 4.6001 |
| 2026-01-10 | maryamlina2 | ratio_hard_cut | 1,287.59 | 17 | 2.1704 | 4.4478 |
| 2026-02-10 | A prayer rug | ratio_hard_cut | 1,274.93 | 12 | 2.1927 | 1.929 |

### TheSwaf

Window: 2025-12-06 to 2026-06-03; rows evaluated: 9892; target ROAS: 2.2
Preset: aggressive; break-even ROAS: 1.71; source rows: 8381

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | 28d early-cut rate | Saved spend | Saved spend units | Delay vs V0 | Source mix |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| V0_current | 90 | yes | 805 | 0 | 18.8% | 42,888.7 | 484.08 | 0 | ratio_hard_cut:61, ratio_loss_budget:24, ratio_sustained_loser:5 |
| V1a_purchase_floor_2 | 82 | yes | 754 | 51 | 20.0% | 42,072.15 | 475.34 | 0 | ratio_hard_cut:61, ratio_loss_budget:14, ratio_sustained_loser:7 |
| V1b_purchase_floor_3 | 82 | yes | 754 | 51 | 20.0% | 42,072.15 | 475.34 | 0 | ratio_hard_cut:61, ratio_loss_budget:14, ratio_sustained_loser:7 |
| V1c_purchase_floor_5 | 82 | yes | 754 | 51 | 20.0% | 42,072.15 | 475.34 | 0 | ratio_hard_cut:61, ratio_loss_budget:14, ratio_sustained_loser:7 |
| V1d_purchase_floor_half_winner | 82 | yes | 754 | 51 | 20.0% | 42,072.15 | 475.34 | 0 | ratio_hard_cut:61, ratio_loss_budget:14, ratio_sustained_loser:7 |
| V2a_p25_upper_clamp_1 | 90 | yes | 805 | 0 | 18.8% | 42,888.7 | 484.08 | 0 | ratio_hard_cut:61, ratio_loss_budget:24, ratio_sustained_loser:5 |
| V2b_p25_breakeven_floor | 147 | yes | 1582 | 777 | 19.6% | 132,134.52 | 1,640.06 | 0 | ratio_hard_cut:106, ratio_loss_budget:38, ratio_sustained_loser:3 |
| V3_recommended_combo | 138 | yes | 1465 | 762 | 20.6% | 131,146.03 | 1,629.46 | 0 | ratio_hard_cut:106, ratio_loss_budget:26, ratio_sustained_loser:6 |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-05-20 | EMB - CatalogAd | ratio_hard_cut | 11,505.98 | 49 | 0.8674 | 2.0421 |
| 2026-05-12 | aura (added) | ratio_hard_cut | 4,027.13 | 18 | 0.9757 | 1.896 |
| 2026-05-18 | EMB - CatalogAd | ratio_hard_cut | 3,025.21 | 14 | 0.882 | n/a |
| 2025-12-16 | Alexis3 | ratio_hard_cut | 2,445.27 | 32 | 1.4328 | 1.7846 |
| 2026-05-11 | wearthefearrevise | ratio_hard_cut | 2,026.62 | 8 | 0.8718 | n/a |
| 2026-04-26 | wearthefearrevise | ratio_hard_cut | 1,569.99 | 7 | 0.9491 | 1.1308 |
| 2026-03-23 | AllRings | ratio_hard_cut | 1,534.93 | 4 | 0.5524 | 0.9204 |
| 2026-01-12 | Alexis1 | ratio_hard_cut | 1,493.86 | 14 | 1.163 | n/a |
| 2026-05-23 | protection | ratio_hard_cut | 1,251.5 | 7 | 0.9411 | n/a |
| 2026-03-14 | Alexis4 | ratio_hard_cut | 1,191.08 | 7 | 1.0044 | n/a |
| 2026-04-18 | EMB - CatalogAd | ratio_hard_cut | 1,183.44 | 5 | 1.0344 | 0.9083 |
| 2026-04-16 | EMB - CatalogAd | ratio_hard_cut | 1,119.52 | 5 | 1.0935 | 0.8919 |

## Recommendation

Status: no_uniform_change_supported

A uniform/global threshold change is not supported yet. The useful signal is account-level heterogeneity; re-test after current-version accrual before proposing per-account parameters.

Account-level signals:

- IwaStore V0 28d early-cut rate is 42.1%; this is an account-level alarm, not a global-rule proof.
- Grandmix V1d moves 28d early-cut rate 34.6% -> 21.1% (-13.6 pp).
- TheSwaf V2b saved spend units 484.08 -> 1,640.06 (3.4x) while 28d early-cut rate remains 19.6%.
- V2a upper-clamp-only effect is scarce in this replay: 4 affected daily rows vs V0.

Parameter recommendation means a future formula phase only: user approval, golden cases, and an ENGINE_VERSION bump are required before implementation.

## Evidence Limits

- Survivorship: history contains creatives operators did not already kill, so observed early-cut rate is a lower bound.
- Attribution lag can move in both directions: delayed conversions may make forward ROAS look too low, while conversions caused by pre-cut spend may make post-cut recovery look too high.
- Target history is not versioned in business_target_packs; target and breakeven are held constant across the replay.
- The sweep uses raw forward ROAS and does not depend on v1/v2 outcome classifiers.
- Pooled saved-spend uses spendUnit-normalized units; raw currency is not pooled across businesses.
- This report does not change thresholds; any parameter adoption requires user approval, new golden cases, and an ENGINE_VERSION bump.
