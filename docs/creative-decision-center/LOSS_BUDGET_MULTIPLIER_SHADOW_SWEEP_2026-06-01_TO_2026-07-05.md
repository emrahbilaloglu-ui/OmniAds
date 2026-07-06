# LossBudgetMultiplier Shadow Sweep - 2026-06-01 to 2026-06-20 decisions, 2026-07-05 data ceiling

This is a read-only parameter-evaluation report. It does not change resolver thresholds, formulas, database state, provider state, migrations, or operator behavior.

## Live Status

- generatedAt: 2026-07-05T22:08:04.237Z
- asOf: 2026-07-05
- engineVersion: v3-2026-07-02-math-guardrails
- revision: 3
- source: live_db_read_only
- tables: meta_creative_daily, businesses, business_target_packs, business_decision_calibration_profiles, business_engine_v3_flags

## Revision Notes

- Episode dedup now requires at least one post-trigger daily spend > 0 before the same creative can open a new cut episode.
- Evidence limits now describe attribution lag in both directions.
- Recommendation is reframed from no-change-supported to no-uniform-change-supported with account-level signals.
- Adds 3.1 lossBudgetMultiplier absolute-override variants from 1.0 to 4.0; these are univariate shadow-only sensitivity rows and do not imply production adoption.

## Methodology

- Unit: cut episode, not daily row; after one creative opens an episode, another episode requires a new cut run plus at least one post-trigger daily spend > 0
- Lookahead bias: trailing 90d calibration percentiles are recomputed for each replay day from data available on or before that day
- Target history: business_target_packs keeps the latest target pack; historical target ROAS and breakeven ROAS are assumed fixed
- Scope: formula-level threshold sweep; campaign-label guard, provider writes, DB writes, migrations, and resolver threshold changes are not applied
- Query bound: per-business generated daily replay bounded to 2026-06-01..2026-06-20, 90d trailing calibration, and 14d primary forward windows
- Primary forward window: 14d
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
| LB1_0_loss_budget | 3.1 sensitivity: lossBudgetMultiplier absolute override 1.0 |
| LB1_5_loss_budget | 3.1 sensitivity: lossBudgetMultiplier absolute override 1.5 |
| LB2_0_loss_budget | 3.1 sensitivity: lossBudgetMultiplier absolute override 2.0 |
| LB2_5_loss_budget | 3.1 sensitivity: lossBudgetMultiplier absolute override 2.5 |
| LB3_0_loss_budget | 3.1 sensitivity: lossBudgetMultiplier absolute override 3.0 |
| LB4_0_loss_budget | 3.1 sensitivity: lossBudgetMultiplier absolute override 4.0 |

## Pooled View

| Variant | Episodes | Defensible | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | 14d true-loser episodes | Saved spend units | Trade-off vs V0 | Median delay vs V0 |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| V0_current | 83 | yes | 0 | 0.0% | 14.8% | 21 | 387.43 | +0 units; +0.0 pp early | 0 |
| V1a_purchase_floor_2 | 78 | yes | 39 | 0.4% | 12.0% | 20 | 387.08 | -0.35 units; -2.8 pp early | 0 |
| V1b_purchase_floor_3 | 73 | yes | 81 | 0.9% | 13.6% | 17 | 383.1 | -4.33 units; -1.2 pp early | 0 |
| V1c_purchase_floor_5 | 73 | yes | 81 | 0.9% | 13.6% | 17 | 383.1 | -4.33 units; -1.2 pp early | 0 |
| V1d_purchase_floor_half_winner | 78 | yes | 39 | 0.4% | 12.0% | 20 | 387.08 | -0.35 units; -2.8 pp early | 0 |
| V2a_p25_upper_clamp_1 | 83 | yes | 0 | 0.0% | 14.8% | 21 | 387.43 | +0 units; +0.0 pp early | 0 |
| V2b_p25_breakeven_floor | 124 | yes | 645 | 6.8% | 12.5% | 39 | 608.2 | +220.77 units; -2.3 pp early | 0 |
| V3_recommended_combo | 113 | yes | 656 | 6.9% | 14.3% | 34 | 551.42 | +163.99 units; -0.5 pp early | 0 |
| LB1_0_loss_budget | 89 | yes | 80 | 0.9% | 17.9% | 21 | 387.43 | +0 units; +3.0 pp early | 0 |
| LB1_5_loss_budget | 88 | yes | 60 | 0.6% | 17.9% | 21 | 387.43 | +0 units; +3.0 pp early | 0 |
| LB2_0_loss_budget | 84 | yes | 42 | 0.4% | 14.8% | 21 | 387.78 | +0.35 units; +0.0 pp early | 0 |
| LB2_5_loss_budget | 79 | yes | 24 | 0.3% | 11.5% | 21 | 380.7 | -6.73 units; -3.3 pp early | 0 |
| LB3_0_loss_budget | 72 | yes | 47 | 0.5% | 9.1% | 18 | 371.45 | -15.98 units; -5.7 pp early | 0 |
| LB4_0_loss_budget | 64 | yes | 122 | 1.3% | 15.8% | 15 | 363.32 | -24.11 units; +1.0 pp early | 0 |

## Business Detail

### EMOLOS

Window: 2026-06-01 to 2026-06-20; rows evaluated: 2708; target ROAS: 2.5
Preset: balanced; break-even ROAS: 2; source rows: 8825

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 21 | no | 170 | 0 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| V1a_purchase_floor_2 | 21 | no | 169 | 1 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| V1b_purchase_floor_3 | 21 | no | 169 | 1 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| V1c_purchase_floor_5 | 21 | no | 169 | 1 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| V1d_purchase_floor_half_winner | 21 | no | 169 | 1 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| V2a_p25_upper_clamp_1 | 21 | no | 170 | 0 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| V2b_p25_breakeven_floor | 32 | yes | 414 | 244 | 9.0% | 10.0% | 4,371.98 | 125.65 | +88.96 units; +10.0 pp early | 0 | ratio_hard_cut:23, ratio_loss_budget:9 | none |
| V3_recommended_combo | 31 | yes | 405 | 237 | 8.8% | 12.5% | 2,712.36 | 77.89 | +41.2 units; +12.5 pp early | 0 | ratio_hard_cut:24, ratio_loss_budget:7 | none |
| LB1_0_loss_budget | 21 | no | 170 | 0 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| LB1_5_loss_budget | 21 | no | 170 | 0 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| LB2_0_loss_budget | 21 | no | 170 | 0 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| LB2_5_loss_budget | 21 | no | 170 | 0 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| LB3_0_loss_budget | 21 | no | 169 | 1 | 0.0% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:4 | none |
| LB4_0_loss_budget | 18 | no | 147 | 23 | 0.9% | 0.0% | 1,279.8 | 36.69 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:1 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-06-05 | Perm / Catalog-DPA / UK | ratio_hard_cut | 616.41 | 5 | 0.5126 | 0.921 |
| 2026-06-16 | Retest HOLD / Outerwear - Denim Jacket R 6 / Video DOF5 | ratio_hard_cut | 513.45 | 3 | 0.5602 | n/a |
| 2026-05-31 | Retest HOLD / Hoodies - R 4 / Video DOF5 | ratio_hard_cut | 511.15 | 1 | 0.3583 | 0.8542 |
| 2026-06-01 | Retest / Polo Product Video - Premium Pique Polo Shirt Dark Grey / Video DOF5 | ratio_hard_cut | 479.46 | 4 | 0.5761 | 0 |
| 2026-06-06 | Perm / Catalog-DPA / USCA | ratio_hard_cut | 472.14 | 3 | 0.4707 | 1.1682 |
| 2026-06-04 | Retest / Jeans Product Video - Slim Fit Jeans Washed Raw Denim / Video DOF5 | ratio_hard_cut | 400.38 | 3 | 0.5854 | n/a |
| 2026-06-19 | Retest / Polo Product Video - Premium Pique Polo Shirt Dark Grey / Video DOF5 | ratio_hard_cut | 386.65 | 3 | 0.5582 | n/a |
| 2026-05-31 | Jeans Carousel - Slim Fit Jeans Washed Raw Denim / Carousel DOF5 | ratio_hard_cut | 385.8 | 1 | 0.1659 | n/a |
| 2026-05-31 | Chino Carousel - Slim Fit Chino Trousers Olive Grey / Carousel DOF5 | ratio_hard_cut | 375.81 | 1 | 0.3643 | n/a |
| 2026-05-31 | Polo Product Video - Premium Pique Polo Shirt White / DOF5 | ratio_hard_cut | 361.71 | 1 | 0.123 | n/a |
| 2026-05-31 | Polo Carousel - Premium Pique Polo Shirt Olive Khaki Extra Angles / Carousel DOF5 | ratio_hard_cut | 355.34 | 1 | 0.1693 | n/a |
| 2026-05-31 | Shorts Carousel - Carpenter Denim Shorts Washed - Stone Blue / Carousel DOF5 | ratio_hard_cut | 346.52 | 1 | 0.3095 | n/a |

### Grandmix

Window: 2026-06-01 to 2026-06-20; rows evaluated: 1537; target ROAS: 2.2
Preset: conservative; break-even ROAS: 1.8; source rows: 9066

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 15 | no | 141 | 0 | 0.0% | 0.0% | 422.96 | 3.98 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:7, ratio_hard_cut:6, ratio_sustained_loser:2 | none |
| V1a_purchase_floor_2 | 14 | no | 117 | 24 | 1.6% | 0.0% | 422.96 | 3.98 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:6, ratio_loss_budget:6, ratio_sustained_loser:2 | none |
| V1b_purchase_floor_3 | 9 | no | 75 | 66 | 4.3% | 0.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:6, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| V1c_purchase_floor_5 | 9 | no | 75 | 66 | 4.3% | 0.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:6, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| V1d_purchase_floor_half_winner | 14 | no | 117 | 24 | 1.6% | 0.0% | 422.96 | 3.98 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:6, ratio_loss_budget:6, ratio_sustained_loser:2 | none |
| V2a_p25_upper_clamp_1 | 15 | no | 141 | 0 | 0.0% | 0.0% | 422.96 | 3.98 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:7, ratio_hard_cut:6, ratio_sustained_loser:2 | none |
| V2b_p25_breakeven_floor | 27 | no | 282 | 141 | 9.2% | 8.3% | 4,032.92 | 37.74 | +33.76 units; +8.3 pp early | 0 | ratio_loss_budget:13, ratio_hard_cut:12, ratio_sustained_loser:2 | none |
| V3_recommended_combo | 24 | no | 255 | 162 | 10.5% | 9.1% | 3,635.75 | 34.07 | +30.09 units; +9.1 pp early | 0 | ratio_hard_cut:12, ratio_loss_budget:10, ratio_sustained_loser:2 | none |
| LB1_0_loss_budget | 20 | no | 204 | 63 | 4.1% | 20.0% | 422.96 | 3.98 | +0 units; +20.0 pp early | 0 | ratio_loss_budget:12, ratio_hard_cut:6, ratio_sustained_loser:2 | none |
| LB1_5_loss_budget | 20 | no | 201 | 60 | 3.9% | 20.0% | 422.96 | 3.98 | +0 units; +20.0 pp early | 0 | ratio_loss_budget:12, ratio_hard_cut:6, ratio_sustained_loser:2 | none |
| LB2_0_loss_budget | 19 | no | 174 | 33 | 2.1% | 20.0% | 422.96 | 3.98 | +0 units; +20.0 pp early | 0 | ratio_loss_budget:11, ratio_hard_cut:6, ratio_sustained_loser:2 | none |
| LB2_5_loss_budget | 15 | no | 141 | 0 | 0.0% | 0.0% | 422.96 | 3.98 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:7, ratio_hard_cut:6, ratio_sustained_loser:2 | none |
| LB3_0_loss_budget | 15 | no | 138 | 3 | 0.2% | 0.0% | 422.96 | 3.98 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:7, ratio_hard_cut:6, ratio_sustained_loser:2 | none |
| LB4_0_loss_budget | 11 | no | 100 | 41 | 2.7% | 0.0% | 121.59 | 1.15 | -2.83 units; +0.0 pp early | 0 | ratio_hard_cut:6, ratio_loss_budget:3, ratio_sustained_loser:2 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-06-18 | BathroomMeta-Sale | ratio_hard_cut | 1,788.92 | 9 | 0.9816 | n/a |
| 2026-05-31 | Claude-2TS-I5-7d2dfb7e | ratio_hard_cut | 1,452.26 | 5 | 0.544 | n/a |
| 2026-05-31 | Claude-2TS-V2-42a59e88 | ratio_hard_cut | 1,184.96 | 3 | 0.472 | n/a |
| 2026-05-31 | Claude-2TS-V3-6e8c9978 | ratio_hard_cut | 1,096.35 | 2 | 0.2664 | n/a |
| 2026-06-06 | TowelRack | ratio_hard_cut | 1,017.99 | 4 | 0.9239 | 0.6115 |
| 2026-05-31 | BathroomMeta-DPA | ratio_hard_cut | 949.77 | 3 | 0.3257 | n/a |
| 2026-05-31 | R2-Deanna-PDP | ratio_sustained_loser | 631.66 | 2 | 0.3902 | n/a |
| 2026-05-31 | Claude-2TS-I1-438391b8 | ratio_sustained_loser | 574.58 | 1 | 0.2245 | n/a |
| 2026-06-04 | WallArtMeta-Guarantee | ratio_loss_budget | 574.27 | 3 | 0.9823 | n/a |
| 2026-05-31 | WallArtMeta-Guarantee | ratio_loss_budget | 452.68 | 2 | 0.8903 | 1.3249 |
| 2026-05-31 | WallArtMeta-Original | ratio_loss_budget | 431.55 | 1 | 0.3107 | 0 |
| 2026-05-31 | Claude-2TS-I2-1d2012fa | ratio_loss_budget | 414.24 | 2 | 0.816 | n/a |

### IwaStore

Window: 2026-06-01 to 2026-06-20; rows evaluated: 1038; target ROAS: 3.5
Preset: balanced; break-even ROAS: 2.7; source rows: 16194

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 4 | no | 32 | 0 | 0.0% | 50.0% | 34.35 | 0.7 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1, ratio_loss_budget:1 | none |
| V1a_purchase_floor_2 | 3 | no | 27 | 5 | 0.5% | 100.0% | 0 | n/a | saved n/a; +50.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1 | none |
| V1b_purchase_floor_3 | 3 | no | 27 | 5 | 0.5% | 100.0% | 0 | n/a | saved n/a; +50.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1 | none |
| V1c_purchase_floor_5 | 3 | no | 27 | 5 | 0.5% | 100.0% | 0 | n/a | saved n/a; +50.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1 | none |
| V1d_purchase_floor_half_winner | 3 | no | 27 | 5 | 0.5% | 100.0% | 0 | n/a | saved n/a; +50.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1 | none |
| V2a_p25_upper_clamp_1 | 4 | no | 32 | 0 | 0.0% | 50.0% | 34.35 | 0.7 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1, ratio_loss_budget:1 | none |
| V2b_p25_breakeven_floor | 4 | no | 35 | 3 | 0.3% | 50.0% | 32.68 | 0.66 | -0.04 units; +0.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1, ratio_loss_budget:1 | none |
| V3_recommended_combo | 4 | no | 30 | 8 | 0.8% | 50.0% | 32.68 | 0.66 | -0.04 units; +0.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1, ratio_loss_budget:1 | none |
| LB1_0_loss_budget | 4 | no | 32 | 0 | 0.0% | 50.0% | 34.35 | 0.7 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1, ratio_loss_budget:1 | none |
| LB1_5_loss_budget | 4 | no | 32 | 0 | 0.0% | 50.0% | 34.35 | 0.7 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1, ratio_loss_budget:1 | none |
| LB2_0_loss_budget | 4 | no | 32 | 0 | 0.0% | 50.0% | 34.35 | 0.7 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1, ratio_loss_budget:1 | none |
| LB2_5_loss_budget | 5 | no | 31 | 1 | 0.1% | 33.3% | 66.85 | 1.36 | +0.66 units; -16.7 pp early | 0 | ratio_hard_cut:2, ratio_loss_budget:2, ratio_sustained_loser:1 | none |
| LB3_0_loss_budget | 3 | no | 27 | 5 | 0.5% | 100.0% | 0 | n/a | saved n/a; +50.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1 | none |
| LB4_0_loss_budget | 3 | no | 27 | 5 | 0.5% | 100.0% | 0 | n/a | saved n/a; +50.0 pp early | 0 | ratio_hard_cut:2, ratio_sustained_loser:1 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-06-07 | WallArtCatalog | ratio_hard_cut | 489.36 | 1 | 0.3821 | 0 |
| 2026-06-19 | Catalog New Collection | ratio_hard_cut | 411.94 | 8 | 2.413 | 4.28 |
| 2026-06-07 | WoodenWallArtCatalog | ratio_sustained_loser | 230.55 | 4 | 1.4246 | 0 |
| 2026-06-15 | Transforming a house | ratio_loss_budget | 133.43 | 1 | 1.4465 | 1.894 |

### TheSwaf

Window: 2026-06-01 to 2026-06-20; rows evaluated: 4177; target ROAS: 2.2
Preset: aggressive; break-even ROAS: 1.71; source rows: 8464

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 43 | yes | 296 | 0 | 0.0% | 18.8% | 32,430.89 | 346.06 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:12, ratio_sustained_loser:3 | none |
| V1a_purchase_floor_2 | 40 | yes | 287 | 9 | 0.2% | 13.3% | 32,460.27 | 346.41 | +0.35 units; -5.4 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:9, ratio_sustained_loser:3 | none |
| V1b_purchase_floor_3 | 40 | yes | 287 | 9 | 0.2% | 13.3% | 32,460.27 | 346.41 | +0.35 units; -5.4 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:9, ratio_sustained_loser:3 | none |
| V1c_purchase_floor_5 | 40 | yes | 287 | 9 | 0.2% | 13.3% | 32,460.27 | 346.41 | +0.35 units; -5.4 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:9, ratio_sustained_loser:3 | none |
| V1d_purchase_floor_half_winner | 40 | yes | 287 | 9 | 0.2% | 13.3% | 32,460.27 | 346.41 | +0.35 units; -5.4 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:9, ratio_sustained_loser:3 | none |
| V2a_p25_upper_clamp_1 | 43 | yes | 296 | 0 | 0.0% | 18.8% | 32,430.89 | 346.06 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:12, ratio_sustained_loser:3 | none |
| V2b_p25_breakeven_floor | 61 | yes | 553 | 257 | 6.2% | 12.5% | 41,659.32 | 444.15 | +98.09 units; -6.3 pp early | 0 | ratio_hard_cut:40, ratio_loss_budget:20, ratio_sustained_loser:1 | none |
| V3_recommended_combo | 54 | yes | 527 | 249 | 6.0% | 14.3% | 41,154.64 | 438.8 | +92.74 units; -4.5 pp early | 0 | ratio_hard_cut:41, ratio_loss_budget:12, ratio_sustained_loser:1 | none |
| LB1_0_loss_budget | 44 | yes | 313 | 17 | 0.4% | 18.8% | 32,430.89 | 346.06 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:13, ratio_sustained_loser:3 | none |
| LB1_5_loss_budget | 43 | yes | 296 | 0 | 0.0% | 18.8% | 32,430.89 | 346.06 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:12, ratio_sustained_loser:3 | none |
| LB2_0_loss_budget | 40 | yes | 287 | 9 | 0.2% | 13.3% | 32,460.27 | 346.41 | +0.35 units; -5.4 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:9, ratio_sustained_loser:3 | none |
| LB2_5_loss_budget | 38 | yes | 273 | 23 | 0.5% | 14.3% | 31,711.72 | 338.67 | -7.39 units; -4.5 pp early | 0 | ratio_hard_cut:29, ratio_loss_budget:6, ratio_sustained_loser:3 | none |
| LB3_0_loss_budget | 33 | yes | 258 | 38 | 0.9% | 8.3% | 30,971.19 | 330.78 | -15.28 units; -10.4 pp early | 0 | ratio_hard_cut:33 | lossBudget>=hardCut:33 |
| LB4_0_loss_budget | 32 | yes | 243 | 53 | 1.3% | 16.7% | 30,472.13 | 325.48 | -20.58 units; -2.1 pp early | 0 | ratio_hard_cut:29, maturity_severe_loser:3 | lossBudget>=hardCut:32 |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-05-31 | EMB - CatalogAd | ratio_hard_cut | 7,106.99 | 21 | 0.6749 | n/a |
| 2026-05-31 | EMB - AllRings | ratio_hard_cut | 1,492.03 | 1 | 0.1881 | n/a |
| 2026-06-15 | Ad_F5K_US_365D_WINNER_RETEST_03_HIST_ALEXIS4_20260614 | ratio_hard_cut | 1,137.45 | 6 | 0.7458 | 1.1536 |
| 2026-06-13 | Ad_F5K_US_DPA_VALUE_BEST_SELLERS_01_DPA_US_BEST_SELLERS_20260614 | ratio_hard_cut | 1,102.84 | 2 | 0.6075 | 0.1274 |
| 2026-05-31 | signature | ratio_hard_cut | 1,083.03 | 6 | 0.9208 | n/a |
| 2026-06-06 | Keepunder | ratio_hard_cut | 988.26 | 5 | 0.8175 | n/a |
| 2026-05-31 | Ad_Test_DepthHistorical | ratio_hard_cut | 984.2 | 5 | 0.8687 | n/a |
| 2026-05-31 | Ad_Test_ProtectionHistorical | ratio_hard_cut | 903.24 | 3 | 0.7241 | n/a |
| 2026-06-13 | Ad_F5K_US_DPA_VALUE_IN_STOCK_01_DPA_US_IN_STOCK_20260614 | ratio_hard_cut | 792.78 | 2 | 0.5671 | 1.1879 |
| 2026-06-17 | Ad_Core_NonUS_DPA_inStock | ratio_hard_cut | 740.94 | 3 | 0.8168 | n/a |
| 2026-06-04 | Ad_Test_AthenaOwlNecklace | ratio_hard_cut | 612.1 | 2 | 0.9635 | n/a |
| 2026-06-05 | restraintrevise (added) | ratio_hard_cut | 599.89 | 3 | 0.8001 | n/a |

## Recommendation

Status: no_uniform_change_supported

A uniform/global threshold change is not supported yet. The useful signal is account-level heterogeneity; re-test after current-version accrual before proposing per-account parameters.

Account-level signals:

- IwaStore V0 14d early-cut rate is 50.0%; this is an account-level alarm, not a global-rule proof.
- Grandmix V1d moves 14d early-cut rate 0.0% -> 0.0% (+0.0 pp).
- TheSwaf V2b saved spend units 346.06 -> 444.15 (1.3x) while 14d early-cut rate remains 12.5%.
- V2a upper-clamp-only effect is scarce in this replay: 0 affected daily rows vs V0.
- EMOLOS lossBudget sweep best saved-spend variant is LB1_0_loss_budget (lossBudget=1): saved units 36.69 -> 36.69 (+0), 14d early-cut 0.0% -> 0.0% (+0.0 pp), defensible=no, flip=0.0%.
- Grandmix lossBudget sweep best saved-spend variant is LB2_5_loss_budget (lossBudget=2.5): saved units 3.98 -> 3.98 (+0), 14d early-cut 0.0% -> 0.0% (+0.0 pp), defensible=no, flip=0.0%.
- IwaStore lossBudget sweep best saved-spend variant is LB2_5_loss_budget (lossBudget=2.5): saved units 0.7 -> 1.36 (+0.66), 14d early-cut 50.0% -> 33.3% (-16.7 pp), defensible=no, flip=0.1%.
- TheSwaf lossBudget sweep best saved-spend variant is LB2_0_loss_budget (lossBudget=2): saved units 346.06 -> 346.41 (+0.35), 14d early-cut 18.8% -> 13.3% (-5.4 pp), defensible=yes, flip=0.2%.

Parameter recommendation means a future formula phase only: user approval, golden cases, and an ENGINE_VERSION bump are required before implementation.

## Evidence Limits

- Survivorship: history contains creatives operators did not already kill, so observed early-cut rate is a lower bound.
- Attribution lag can move in both directions: delayed conversions may make forward ROAS look too low, while conversions caused by pre-cut spend may make post-cut recovery look too high.
- Target history is not versioned in business_target_packs; target and breakeven are held constant across the replay.
- The sweep uses raw forward ROAS and does not depend on v1/v2 outcome classifiers.
- Pooled saved-spend uses spendUnit-normalized units; raw currency is not pooled across businesses.
- LossBudgetMultiplier rows are univariate shadow sensitivity tests: purchase floor and boundary mode stay at current behavior unless the variant label says otherwise.
- This report does not change thresholds; any parameter adoption requires user approval, new golden cases, and an ENGINE_VERSION bump.
