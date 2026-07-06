# Multi-Window Robustness - 2026-04-01 to 2026-05-31 decisions, 2026-07-05 data ceiling

This is a read-only parameter-evaluation report. It does not change resolver thresholds, formulas, database state, provider state, migrations, or operator behavior.

## Live Status

- generatedAt: 2026-07-05T22:14:23.852Z
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
- Query bound: per-business generated daily replay bounded to 2026-04-01..2026-05-31, 90d trailing calibration, and 14d primary forward windows
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
| V0_current | 147 | yes | 0 | 0.0% | 19.0% | 41 | 466.21 | +0 units; +0.0 pp early | 0 |
| V1a_purchase_floor_2 | 128 | yes | 123 | 0.7% | 16.3% | 34 | 420.37 | -45.84 units; -2.6 pp early | 0 |
| V1b_purchase_floor_3 | 122 | yes | 170 | 0.9% | 14.9% | 33 | 403.05 | -63.16 units; -4.1 pp early | 0 |
| V1c_purchase_floor_5 | 119 | yes | 184 | 1.0% | 15.6% | 32 | 401.45 | -64.76 units; -3.4 pp early | 0 |
| V1d_purchase_floor_half_winner | 122 | yes | 157 | 0.8% | 14.9% | 34 | 416.87 | -49.34 units; -4.1 pp early | 0 |
| V2a_p25_upper_clamp_1 | 146 | yes | 4 | 0.0% | 19.3% | 40 | 465.52 | -0.69 units; +0.3 pp early | 0 |
| V2b_p25_breakeven_floor | 186 | yes | 890 | 4.7% | 14.3% | 65 | 873.56 | +407.35 units; -4.7 pp early | 0 |
| V3_recommended_combo | 159 | yes | 970 | 5.1% | 11.5% | 57 | 822.5 | +356.29 units; -7.4 pp early | 0 |
| LB1_0_loss_budget | 184 | yes | 299 | 1.6% | 24.3% | 44 | 491.66 | +25.45 units; +5.3 pp early | 0 |
| LB1_5_loss_budget | 165 | yes | 166 | 0.9% | 20.3% | 44 | 476.25 | +10.04 units; +1.3 pp early | 0 |
| LB2_0_loss_budget | 146 | yes | 61 | 0.3% | 19.3% | 40 | 463.48 | -2.73 units; +0.3 pp early | 0 |
| LB2_5_loss_budget | 131 | yes | 94 | 0.5% | 17.3% | 38 | 456.47 | -9.74 units; -1.7 pp early | 0 |
| LB3_0_loss_budget | 119 | yes | 177 | 0.9% | 10.6% | 37 | 443.25 | -22.96 units; -8.3 pp early | 0 |
| LB4_0_loss_budget | 101 | yes | 311 | 1.6% | 12.8% | 30 | 381.82 | -84.39 units; -6.2 pp early | 0 |

## Business Detail

### EMOLOS

Window: 2026-04-01 to 2026-05-31; rows evaluated: 5953; target ROAS: 2.5
Preset: balanced; break-even ROAS: 2; source rows: 8825

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 29 | no | 229 | 0 | 0.0% | 0.0% | 3,437.63 | 98.5 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:12, ratio_sustained_loser:4 | none |
| V1a_purchase_floor_2 | 28 | no | 224 | 5 | 0.1% | 0.0% | 3,077.91 | 88.15 | -10.35 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:11, ratio_sustained_loser:4 | none |
| V1b_purchase_floor_3 | 28 | no | 224 | 5 | 0.1% | 0.0% | 3,077.91 | 88.15 | -10.35 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:11, ratio_sustained_loser:4 | none |
| V1c_purchase_floor_5 | 28 | no | 224 | 5 | 0.1% | 0.0% | 3,077.91 | 88.15 | -10.35 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:11, ratio_sustained_loser:4 | none |
| V1d_purchase_floor_half_winner | 28 | no | 224 | 5 | 0.1% | 0.0% | 3,077.91 | 88.15 | -10.35 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:11, ratio_sustained_loser:4 | none |
| V2a_p25_upper_clamp_1 | 29 | no | 229 | 0 | 0.0% | 0.0% | 3,437.63 | 98.5 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:12, ratio_sustained_loser:4 | none |
| V2b_p25_breakeven_floor | 35 | yes | 451 | 222 | 3.7% | 0.0% | 4,576.91 | 132.41 | +33.91 units; +0.0 pp early | 0 | ratio_loss_budget:19, ratio_hard_cut:12, ratio_sustained_loser:4 | none |
| V3_recommended_combo | 34 | yes | 437 | 218 | 3.7% | 0.0% | 4,176.22 | 120.86 | +22.36 units; +0.0 pp early | 0 | ratio_loss_budget:18, ratio_hard_cut:12, ratio_sustained_loser:4 | none |
| LB1_0_loss_budget | 30 | yes | 257 | 28 | 0.5% | 0.0% | 3,492.27 | 100.06 | +1.56 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:13, ratio_sustained_loser:4 | none |
| LB1_5_loss_budget | 30 | yes | 256 | 27 | 0.4% | 0.0% | 3,492.27 | 100.06 | +1.56 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:13, ratio_sustained_loser:4 | none |
| LB2_0_loss_budget | 29 | no | 229 | 0 | 0.0% | 0.0% | 3,437.63 | 98.5 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:12, ratio_sustained_loser:4 | none |
| LB2_5_loss_budget | 29 | no | 226 | 3 | 0.1% | 0.0% | 3,359.48 | 96.27 | -2.23 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:12, ratio_sustained_loser:4 | none |
| LB3_0_loss_budget | 28 | no | 224 | 5 | 0.1% | 0.0% | 3,077.91 | 88.15 | -10.35 units; +0.0 pp early | 0 | ratio_hard_cut:13, ratio_loss_budget:11, ratio_sustained_loser:4 | none |
| LB4_0_loss_budget | 23 | no | 202 | 27 | 0.4% | 11.1% | 1,819.68 | 52.32 | -46.18 units; +11.1 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:6, ratio_sustained_loser:3 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-04-12 | Slim Fit Jeans Washed | ratio_hard_cut | 860.9 | 12 | 1.3352 | 0 |
| 2026-04-17 | Instock | ratio_hard_cut | 706.15 | 12 | 1.2475 | 0 |
| 2026-03-31 | UGC Christian E | ratio_hard_cut | 670.89 | 12 | 1.3035 | n/a |
| 2026-05-28 | Retest HOLD / Hoodies - R 4 / Video DOF5 | ratio_hard_cut | 373.91 | 1 | 0.4898 | 0.286 |
| 2026-04-27 | Instock | ratio_hard_cut | 365.47 | 4 | 0.7578 | n/a |
| 2026-05-18 | Polo Product Video - Premium Pique Polo Shirt White / DOF5 | ratio_hard_cut | 361.71 | 1 | 0.123 | n/a |
| 2026-05-26 | Retest / Polo Product Video - Premium Pique Polo Shirt Dark Grey / Video DOF5 | ratio_hard_cut | 258.78 | 3 | 0.8781 | 0.2003 |
| 2026-05-26 | Instock | ratio_hard_cut | 231.29 | 3 | 0.7653 | n/a |

### Grandmix

Window: 2026-04-01 to 2026-05-31; rows evaluated: 3108; target ROAS: 2.2
Preset: conservative; break-even ROAS: 1.8; source rows: 9066

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 29 | no | 287 | 0 | 0.0% | 18.8% | 8,584.31 | 79.96 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:23, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| V1a_purchase_floor_2 | 22 | no | 230 | 57 | 1.8% | 8.3% | 5,566.72 | 51.98 | -27.98 units; -10.4 pp early | 0 | ratio_loss_budget:10, ratio_sustained_loser:8, ratio_hard_cut:4 | none |
| V1b_purchase_floor_3 | 19 | no | 197 | 90 | 2.9% | 0.0% | 3,736.02 | 34.66 | -45.3 units; -18.8 pp early | 1 | ratio_sustained_loser:9, ratio_loss_budget:6, ratio_hard_cut:4 | none |
| V1c_purchase_floor_5 | 17 | no | 184 | 103 | 3.3% | 0.0% | 3,565.58 | 33.06 | -46.9 units; -18.8 pp early | 1 | ratio_sustained_loser:9, ratio_hard_cut:4, ratio_loss_budget:4 | none |
| V1d_purchase_floor_half_winner | 20 | no | 211 | 76 | 2.5% | 0.0% | 5,189.72 | 48.48 | -31.48 units; -18.8 pp early | 1 | ratio_sustained_loser:9, ratio_loss_budget:7, ratio_hard_cut:4 | none |
| V2a_p25_upper_clamp_1 | 28 | no | 283 | 4 | 0.1% | 20.0% | 8,509.87 | 79.27 | -0.69 units; +1.3 pp early | 0 | ratio_loss_budget:23, ratio_hard_cut:3, ratio_sustained_loser:2 | none |
| V2b_p25_breakeven_floor | 33 | yes | 386 | 107 | 3.4% | 21.1% | 10,612.96 | 99.09 | +19.13 units; +2.3 pp early | 0 | ratio_loss_budget:26, ratio_hard_cut:5, ratio_sustained_loser:2 | none |
| V3_recommended_combo | 26 | no | 306 | 175 | 5.6% | 6.7% | 8,044.67 | 75.23 | -4.73 units; -12.1 pp early | 2 | ratio_loss_budget:12, ratio_sustained_loser:9, ratio_hard_cut:5 | none |
| LB1_0_loss_budget | 40 | yes | 376 | 89 | 2.9% | 23.8% | 9,340.26 | 87.13 | +7.17 units; +5.1 pp early | 0 | ratio_loss_budget:34, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| LB1_5_loss_budget | 37 | yes | 343 | 56 | 1.8% | 16.7% | 9,206.29 | 85.89 | +5.93 units; -2.1 pp early | 0 | ratio_loss_budget:31, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| LB2_0_loss_budget | 35 | yes | 327 | 40 | 1.3% | 16.7% | 9,087.81 | 84.74 | +4.78 units; -2.1 pp early | 0 | ratio_loss_budget:29, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| LB2_5_loss_budget | 29 | no | 287 | 0 | 0.0% | 18.8% | 8,584.31 | 79.96 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:23, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| LB3_0_loss_budget | 24 | no | 253 | 34 | 1.1% | 0.0% | 7,944.36 | 74 | -5.96 units; -18.8 pp early | 0 | ratio_loss_budget:18, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| LB4_0_loss_budget | 19 | no | 202 | 85 | 2.7% | 0.0% | 6,417.67 | 59.82 | -20.14 units; -18.8 pp early | 0 | ratio_loss_budget:11, ratio_hard_cut:4, ratio_sustained_loser:4 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-05-16 | Claude-2TS-I4-1cac0362 | ratio_hard_cut | 1,159.23 | 4 | 1.086 | n/a |
| 2026-04-12 | TowelRack | ratio_hard_cut | 1,145.38 | 12 | 2.3089 | 0.3669 |
| 2026-04-29 | BathroomMeta | ratio_hard_cut | 1,098.85 | 10 | 1.8577 | 0.6013 |
| 2026-05-02 | BathroomMeta | ratio_hard_cut | 1,009.02 | 7 | 1.104 | n/a |
| 2026-05-12 | Claude-2TS-I3-6bab2dd5 | ratio_loss_budget | 799.32 | 4 | 0.9109 | 1.3587 |
| 2026-05-11 | Claude-2TS-I5-7d2dfb7e | ratio_sustained_loser | 634.46 | 1 | 0.2348 | 0.7839 |
| 2026-05-03 | BathroomMeta | ratio_loss_budget | 596.25 | 4 | 1.7571 | n/a |
| 2026-04-25 | TowelRack | ratio_sustained_loser | 558.44 | 5 | 1.5282 | 0 |

### IwaStore

Window: 2026-04-01 to 2026-05-31; rows evaluated: 5747; target ROAS: 3.5
Preset: balanced; break-even ROAS: 2.7; source rows: 16194

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 31 | yes | 212 | 0 | 0.0% | 50.0% | 180.12 | 3.08 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:12, ratio_sustained_loser:4 | none |
| V1a_purchase_floor_2 | 27 | no | 172 | 40 | 0.7% | 33.3% | 180.12 | 3.08 | +0 units; -16.7 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:8, ratio_sustained_loser:4 | none |
| V1b_purchase_floor_3 | 24 | no | 158 | 54 | 0.9% | 33.3% | 180.12 | 3.08 | +0 units; -16.7 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:5, ratio_sustained_loser:4 | none |
| V1c_purchase_floor_5 | 23 | no | 157 | 55 | 1.0% | 50.0% | 180.12 | 3.08 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:4, ratio_sustained_loser:4 | none |
| V1d_purchase_floor_half_winner | 23 | no | 157 | 55 | 1.0% | 50.0% | 180.12 | 3.08 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:4, ratio_sustained_loser:4 | none |
| V2a_p25_upper_clamp_1 | 31 | yes | 212 | 0 | 0.0% | 50.0% | 180.12 | 3.08 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:12, ratio_sustained_loser:4 | none |
| V2b_p25_breakeven_floor | 40 | yes | 366 | 154 | 2.7% | 30.0% | 1,148.16 | 19.24 | +16.16 units; -20.0 pp early | 0 | ratio_loss_budget:20, ratio_hard_cut:17, ratio_sustained_loser:3 | none |
| V3_recommended_combo | 29 | no | 285 | 183 | 3.2% | 16.7% | 942.14 | 15.8 | +12.72 units; -33.3 pp early | 0 | ratio_hard_cut:17, ratio_loss_budget:9, ratio_sustained_loser:3 | none |
| LB1_0_loss_budget | 54 | yes | 385 | 173 | 3.0% | 54.5% | 1,118.51 | 18.61 | +15.53 units; +4.5 pp early | 0 | ratio_loss_budget:36, ratio_hard_cut:15, ratio_sustained_loser:3 | none |
| LB1_5_loss_budget | 40 | yes | 295 | 83 | 1.4% | 50.0% | 332.55 | 5.63 | +2.55 units; +0.0 pp early | 0 | ratio_loss_budget:22, ratio_hard_cut:15, ratio_sustained_loser:3 | none |
| LB2_0_loss_budget | 31 | yes | 212 | 0 | 0.0% | 50.0% | 180.12 | 3.08 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:12, ratio_sustained_loser:4 | none |
| LB2_5_loss_budget | 26 | no | 172 | 40 | 0.7% | 66.7% | 180.12 | 3.08 | +0 units; +16.7 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:7, ratio_sustained_loser:4 | none |
| LB3_0_loss_budget | 23 | no | 157 | 55 | 1.0% | 50.0% | 180.12 | 3.08 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:15, ratio_loss_budget:4, ratio_sustained_loser:4 | none |
| LB4_0_loss_budget | 21 | no | 129 | 83 | 1.4% | 50.0% | 129.91 | 2.24 | -0.84 units; +0.0 pp early | 0 | ratio_hard_cut:15, ratio_sustained_loser:4, ratio_loss_budget:2 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-03-31 | I’m so happy | ratio_hard_cut | 1,371.31 | 19 | 1.9726 | n/a |
| 2026-04-07 | AyetelKursi | ratio_hard_cut | 1,197.05 | 16 | 1.8173 | n/a |
| 2026-05-15 | WallArtCatalog | ratio_hard_cut | 1,021.7 | 12 | 1.9869 | n/a |
| 2026-03-31 | Febieyyi | ratio_hard_cut | 933.22 | 11 | 2.1186 | n/a |
| 2026-04-07 | WoodenWallArtCatalog | ratio_hard_cut | 870.69 | 13 | 2.0556 | n/a |
| 2026-04-01 | dreamhome_decor_ | ratio_hard_cut | 568.88 | 8 | 1.5619 | n/a |
| 2026-03-31 | Our Islamic wall arts | ratio_hard_cut | 524.27 | 7 | 1.3358 | n/a |
| 2026-04-14 | WoodenWallArtCatalog | ratio_hard_cut | 501.35 | 7 | 1.8894 | n/a |

### TheSwaf

Window: 2026-04-01 to 2026-05-31; rows evaluated: 4198; target ROAS: 2.2
Preset: aggressive; break-even ROAS: 1.71; source rows: 8464

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 58 | yes | 404 | 0 | 0.0% | 24.0% | 26,623.53 | 284.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:17, ratio_sustained_loser:2 | none |
| V1a_purchase_floor_2 | 51 | yes | 383 | 21 | 0.5% | 27.3% | 25,916.34 | 277.16 | -7.51 units; +3.3 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:10, ratio_sustained_loser:2 | none |
| V1b_purchase_floor_3 | 51 | yes | 383 | 21 | 0.5% | 27.3% | 25,916.34 | 277.16 | -7.51 units; +3.3 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:10, ratio_sustained_loser:2 | none |
| V1c_purchase_floor_5 | 51 | yes | 383 | 21 | 0.5% | 27.3% | 25,916.34 | 277.16 | -7.51 units; +3.3 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:10, ratio_sustained_loser:2 | none |
| V1d_purchase_floor_half_winner | 51 | yes | 383 | 21 | 0.5% | 27.3% | 25,916.34 | 277.16 | -7.51 units; +3.3 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:10, ratio_sustained_loser:2 | none |
| V2a_p25_upper_clamp_1 | 58 | yes | 404 | 0 | 0.0% | 24.0% | 26,623.53 | 284.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:17, ratio_sustained_loser:2 | none |
| V2b_p25_breakeven_floor | 78 | yes | 811 | 407 | 9.7% | 13.6% | 58,434.29 | 622.82 | +338.15 units; -10.4 pp early | 0 | ratio_hard_cut:51, ratio_loss_budget:26, ratio_sustained_loser:1 | none |
| V3_recommended_combo | 70 | yes | 756 | 394 | 9.4% | 17.5% | 57,288.84 | 610.61 | +325.94 units; -6.5 pp early | 0 | ratio_hard_cut:51, ratio_loss_budget:17, ratio_sustained_loser:2 | none |
| LB1_0_loss_budget | 60 | yes | 413 | 9 | 0.2% | 24.0% | 26,737.3 | 285.86 | +1.19 units; +0.0 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:19, ratio_sustained_loser:2 | none |
| LB1_5_loss_budget | 58 | yes | 404 | 0 | 0.0% | 24.0% | 26,623.53 | 284.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:17, ratio_sustained_loser:2 | none |
| LB2_0_loss_budget | 51 | yes | 383 | 21 | 0.5% | 27.3% | 25,916.34 | 277.16 | -7.51 units; +3.3 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:10, ratio_sustained_loser:2 | none |
| LB2_5_loss_budget | 47 | yes | 353 | 51 | 1.2% | 20.0% | 25,916.34 | 277.16 | -7.51 units; -4.0 pp early | 0 | ratio_hard_cut:39, ratio_loss_budget:7, ratio_sustained_loser:1 | none |
| LB3_0_loss_budget | 44 | yes | 321 | 83 | 2.0% | 20.0% | 25,999.57 | 278.02 | -6.65 units; -4.0 pp early | 0 | ratio_hard_cut:44 | lossBudget>=hardCut:44 |
| LB4_0_loss_budget | 38 | yes | 288 | 116 | 2.8% | 17.6% | 24,840.36 | 267.44 | -17.23 units; -6.3 pp early | 0 | ratio_hard_cut:35, maturity_severe_loser:3 | lossBudget>=hardCut:38 |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-05-20 | EMB - CatalogAd | ratio_hard_cut | 11,505.98 | 49 | 0.8674 | 2.0421 |
| 2026-05-12 | aura (added) | ratio_hard_cut | 4,027.13 | 18 | 0.9757 | 1.896 |
| 2026-05-18 | EMB - CatalogAd | ratio_hard_cut | 3,025.21 | 14 | 0.882 | n/a |
| 2026-05-11 | wearthefearrevise | ratio_hard_cut | 2,026.62 | 8 | 0.8718 | n/a |
| 2026-04-26 | wearthefearrevise | ratio_hard_cut | 1,569.99 | 7 | 0.9491 | 1.1308 |
| 2026-03-31 | AllRings | ratio_hard_cut | 1,334.97 | 6 | 0.909 | 0 |
| 2026-05-23 | protection | ratio_hard_cut | 1,251.5 | 7 | 0.9411 | n/a |
| 2026-04-18 | EMB - CatalogAd | ratio_hard_cut | 1,183.44 | 5 | 1.0344 | 0.9083 |

## Recommendation

Status: candidate_available

The combined F1/F2 variant is a candidate for a separate formula phase, subject to user approval, new golden cases, and an ENGINE_VERSION bump.

Account-level signals:

- IwaStore V0 14d early-cut rate is 50.0%; this is an account-level alarm, not a global-rule proof.
- Grandmix V1d moves 14d early-cut rate 18.8% -> 0.0% (-18.8 pp).
- TheSwaf V2b saved spend units 284.67 -> 622.82 (2.2x) while 14d early-cut rate remains 13.6%.
- V2a upper-clamp-only effect is scarce in this replay: 4 affected daily rows vs V0.
- EMOLOS lossBudget sweep best saved-spend variant is LB1_0_loss_budget (lossBudget=1): saved units 98.5 -> 100.06 (+1.56), 14d early-cut 0.0% -> 0.0% (+0.0 pp), defensible=yes, flip=0.5%.
- Grandmix lossBudget sweep best saved-spend variant is LB1_0_loss_budget (lossBudget=1): saved units 79.96 -> 87.13 (+7.17), 14d early-cut 18.8% -> 23.8% (+5.1 pp), defensible=yes, flip=2.9%.
- IwaStore lossBudget sweep best saved-spend variant is LB1_0_loss_budget (lossBudget=1): saved units 3.08 -> 18.61 (+15.53), 14d early-cut 50.0% -> 54.5% (+4.5 pp), defensible=yes, flip=3.0%.
- TheSwaf lossBudget sweep best saved-spend variant is LB1_0_loss_budget (lossBudget=1): saved units 284.67 -> 285.86 (+1.19), 14d early-cut 24.0% -> 24.0% (+0.0 pp), defensible=yes, flip=0.2%.

Parameter recommendation means a future formula phase only: user approval, golden cases, and an ENGINE_VERSION bump are required before implementation.

## Evidence Limits

- Survivorship: history contains creatives operators did not already kill, so observed early-cut rate is a lower bound.
- Attribution lag can move in both directions: delayed conversions may make forward ROAS look too low, while conversions caused by pre-cut spend may make post-cut recovery look too high.
- Target history is not versioned in business_target_packs; target and breakeven are held constant across the replay.
- The sweep uses raw forward ROAS and does not depend on v1/v2 outcome classifiers.
- Pooled saved-spend uses spendUnit-normalized units; raw currency is not pooled across businesses.
- LossBudgetMultiplier rows are univariate shadow sensitivity tests: purchase floor and boundary mode stay at current behavior unless the variant label says otherwise.
- This report does not change thresholds; any parameter adoption requires user approval, new golden cases, and an ENGINE_VERSION bump.
