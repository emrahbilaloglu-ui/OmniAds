# Multi-Window Robustness - 2025-12-01 to 2026-01-31 decisions, 2026-07-05 data ceiling

This is a read-only parameter-evaluation report. It does not change resolver thresholds, formulas, database state, provider state, migrations, or operator behavior.

## Live Status

- generatedAt: 2026-07-05T22:13:34.283Z
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
- Query bound: per-business generated daily replay bounded to 2025-12-01..2026-01-31, 90d trailing calibration, and 14d primary forward windows
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
| V0_current | 111 | yes | 0 | 0.0% | 36.2% | 27 | 248.05 | +0 units; +0.0 pp early | 0 |
| V1a_purchase_floor_2 | 98 | yes | 135 | 1.0% | 38.5% | 24 | 214.67 | -33.38 units; +2.2 pp early | 0 |
| V1b_purchase_floor_3 | 93 | yes | 167 | 1.2% | 37.1% | 24 | 214.67 | -33.38 units; +0.9 pp early | 0 |
| V1c_purchase_floor_5 | 93 | yes | 167 | 1.2% | 37.1% | 24 | 214.67 | -33.38 units; +0.9 pp early | 0 |
| V1d_purchase_floor_half_winner | 95 | yes | 144 | 1.0% | 37.1% | 24 | 214.67 | -33.38 units; +0.9 pp early | 0 |
| V2a_p25_upper_clamp_1 | 111 | yes | 0 | 0.0% | 36.2% | 27 | 248.05 | +0 units; +0.0 pp early | 0 |
| V2b_p25_breakeven_floor | 162 | yes | 600 | 4.3% | 36.9% | 47 | 728.95 | +480.9 units; +0.7 pp early | 0 |
| V3_recommended_combo | 146 | yes | 723 | 5.2% | 39.4% | 43 | 694.65 | +446.6 units; +3.2 pp early | 0 |
| LB1_0_loss_budget | 129 | yes | 134 | 1.0% | 42.1% | 28 | 259.84 | +11.79 units; +5.9 pp early | 0 |
| LB1_5_loss_budget | 118 | yes | 44 | 0.3% | 38.0% | 28 | 261.11 | +13.06 units; +1.8 pp early | 0 |
| LB2_0_loss_budget | 111 | yes | 31 | 0.2% | 35.7% | 27 | 248.05 | +0 units; -0.5 pp early | 0 |
| LB2_5_loss_budget | 104 | yes | 81 | 0.6% | 40.9% | 24 | 237.56 | -10.49 units; +4.7 pp early | 0 |
| LB3_0_loss_budget | 94 | yes | 169 | 1.2% | 39.3% | 23 | 212.1 | -35.95 units; +3.1 pp early | 0 |
| LB4_0_loss_budget | 82 | yes | 310 | 2.2% | 41.5% | 20 | 187.21 | -60.84 units; +5.3 pp early | 0 |

## Business Detail

### EMOLOS

Window: 2025-12-01 to 2026-01-31; rows evaluated: 3497; target ROAS: 2.5
Preset: balanced; break-even ROAS: 2; source rows: 8825

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 21 | no | 147 | 0 | 0.0% | 25.0% | 1,295.2 | 41.64 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:10, ratio_loss_budget:8, ratio_sustained_loser:3 | none |
| V1a_purchase_floor_2 | 15 | no | 127 | 20 | 0.6% | 12.5% | 1,295.2 | 41.64 | +0 units; -12.5 pp early | 0 | ratio_hard_cut:10, ratio_sustained_loser:3, ratio_loss_budget:2 | none |
| V1b_purchase_floor_3 | 15 | no | 127 | 20 | 0.6% | 12.5% | 1,295.2 | 41.64 | +0 units; -12.5 pp early | 0 | ratio_hard_cut:10, ratio_sustained_loser:3, ratio_loss_budget:2 | none |
| V1c_purchase_floor_5 | 15 | no | 127 | 20 | 0.6% | 12.5% | 1,295.2 | 41.64 | +0 units; -12.5 pp early | 0 | ratio_hard_cut:10, ratio_sustained_loser:3, ratio_loss_budget:2 | none |
| V1d_purchase_floor_half_winner | 15 | no | 127 | 20 | 0.6% | 12.5% | 1,295.2 | 41.64 | +0 units; -12.5 pp early | 0 | ratio_hard_cut:10, ratio_sustained_loser:3, ratio_loss_budget:2 | none |
| V2a_p25_upper_clamp_1 | 21 | no | 147 | 0 | 0.0% | 25.0% | 1,295.2 | 41.64 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:10, ratio_loss_budget:8, ratio_sustained_loser:3 | none |
| V2b_p25_breakeven_floor | 39 | yes | 356 | 209 | 6.0% | 32.1% | 2,066.09 | 65.31 | +23.67 units; +7.1 pp early | 0 | ratio_loss_budget:21, ratio_hard_cut:15, ratio_sustained_loser:3 | none |
| V3_recommended_combo | 34 | yes | 322 | 215 | 6.2% | 36.0% | 2,066.09 | 65.31 | +23.67 units; +11.0 pp early | 0 | ratio_loss_budget:16, ratio_hard_cut:15, ratio_sustained_loser:3 | none |
| LB1_0_loss_budget | 21 | no | 147 | 0 | 0.0% | 25.0% | 1,295.2 | 41.64 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:10, ratio_loss_budget:8, ratio_sustained_loser:3 | none |
| LB1_5_loss_budget | 21 | no | 147 | 0 | 0.0% | 25.0% | 1,295.2 | 41.64 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:10, ratio_loss_budget:8, ratio_sustained_loser:3 | none |
| LB2_0_loss_budget | 21 | no | 147 | 0 | 0.0% | 25.0% | 1,295.2 | 41.64 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:10, ratio_loss_budget:8, ratio_sustained_loser:3 | none |
| LB2_5_loss_budget | 18 | no | 137 | 10 | 0.3% | 27.3% | 1,295.2 | 41.64 | +0 units; +2.3 pp early | 0 | ratio_hard_cut:10, ratio_loss_budget:5, ratio_sustained_loser:3 | none |
| LB3_0_loss_budget | 15 | no | 127 | 20 | 0.6% | 12.5% | 1,295.2 | 41.64 | +0 units; -12.5 pp early | 0 | ratio_hard_cut:10, ratio_sustained_loser:3, ratio_loss_budget:2 | none |
| LB4_0_loss_budget | 14 | no | 91 | 56 | 1.6% | 0.0% | 1,295.2 | 41.64 | +0 units; -25.0 pp early | 0 | ratio_hard_cut:10, ratio_sustained_loser:4 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2025-12-14 | Instock | ratio_hard_cut | 2,079.46 | 31 | 1.1146 | 1.1208 |
| 2025-12-30 | Instock | ratio_hard_cut | 1,594.25 | 16 | 0.7327 | 1.9507 |
| 2026-01-15 | Instock | ratio_hard_cut | 831 | 9 | 0.8523 | 0.8824 |
| 2025-12-20 | UGC Christian E | ratio_hard_cut | 355.44 | 1 | 0.3376 | 1.5421 |
| 2025-12-21 | 21. Spray on Jeans 1 | ratio_hard_cut | 298.19 | 3 | 0.8545 | 1.6752 |
| 2025-11-30 | UGC Christian E | ratio_hard_cut | 221.57 | 1 | 0.2663 | 0.718 |
| 2026-01-30 | KR 6 | ratio_hard_cut | 205.09 | 1 | 0.3403 | 0 |
| 2026-01-24 | 21. Spray on Jeans 1 | ratio_hard_cut | 196.41 | 2 | 0.6008 | 0 |

### Grandmix

Window: 2025-12-01 to 2026-01-31; rows evaluated: 1997; target ROAS: 2.2
Preset: conservative; break-even ROAS: 1.8; source rows: 9066

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 13 | no | 132 | 0 | 0.0% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:6, ratio_hard_cut:5, ratio_sustained_loser:2 | none |
| V1a_purchase_floor_2 | 11 | no | 116 | 16 | 0.8% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:5, ratio_loss_budget:4, ratio_sustained_loser:2 | none |
| V1b_purchase_floor_3 | 9 | no | 93 | 39 | 1.9% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:5, ratio_sustained_loser:2, ratio_loss_budget:2 | none |
| V1c_purchase_floor_5 | 9 | no | 93 | 39 | 1.9% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:5, ratio_sustained_loser:2, ratio_loss_budget:2 | none |
| V1d_purchase_floor_half_winner | 11 | no | 116 | 16 | 0.8% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:5, ratio_loss_budget:4, ratio_sustained_loser:2 | none |
| V2a_p25_upper_clamp_1 | 13 | no | 132 | 0 | 0.0% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:6, ratio_hard_cut:5, ratio_sustained_loser:2 | none |
| V2b_p25_breakeven_floor | 17 | no | 228 | 96 | 4.8% | 0.0% | 2,608.87 | 25.5 | +7.83 units; +0.0 pp early | 0 | ratio_hard_cut:9, ratio_loss_budget:6, ratio_sustained_loser:2 | none |
| V3_recommended_combo | 17 | no | 212 | 112 | 5.6% | 0.0% | 2,608.87 | 25.5 | +7.83 units; +0.0 pp early | 0 | ratio_hard_cut:9, ratio_loss_budget:6, ratio_sustained_loser:2 | none |
| LB1_0_loss_budget | 16 | no | 138 | 6 | 0.3% | 33.3% | 1,801.73 | 17.67 | +0 units; +33.3 pp early | 0 | ratio_loss_budget:9, ratio_hard_cut:5, ratio_sustained_loser:2 | none |
| LB1_5_loss_budget | 15 | no | 135 | 3 | 0.1% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:8, ratio_hard_cut:5, ratio_sustained_loser:2 | none |
| LB2_0_loss_budget | 14 | no | 133 | 1 | 0.1% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:7, ratio_hard_cut:5, ratio_sustained_loser:2 | none |
| LB2_5_loss_budget | 13 | no | 132 | 0 | 0.0% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:6, ratio_hard_cut:5, ratio_sustained_loser:2 | none |
| LB3_0_loss_budget | 11 | no | 123 | 9 | 0.4% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:5, ratio_loss_budget:4, ratio_sustained_loser:2 | none |
| LB4_0_loss_budget | 10 | no | 106 | 26 | 1.3% | 0.0% | 1,801.73 | 17.67 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:5, ratio_loss_budget:3, ratio_sustained_loser:2 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2025-11-30 | BathroomMeta | ratio_hard_cut | 2,086.38 | 13 | 0.9713 | n/a |
| 2025-12-19 | Utility | ratio_hard_cut | 1,356.52 | 7 | 1.1343 | 1.394 |
| 2026-01-19 | Utility | ratio_hard_cut | 1,120.12 | 4 | 1.1232 | n/a |
| 2025-12-17 | BathroomMeta | ratio_hard_cut | 968.85 | 4 | 0.636 | n/a |
| 2025-12-25 | Jealous - Winner | ratio_hard_cut | 894.32 | 1 | 0.2194 | 0 |
| 2025-11-30 | Utility | ratio_loss_budget | 632.61 | 3 | 0.7734 | 1.7764 |
| 2025-11-30 | BathroomMeta | ratio_sustained_loser | 599.39 | 2 | 0.4656 | n/a |
| 2025-12-20 | TowelRack | ratio_loss_budget | 544.68 | 3 | 1.0575 | n/a |

### IwaStore

Window: 2025-12-01 to 2026-01-31; rows evaluated: 5603; target ROAS: 3.5
Preset: balanced; break-even ROAS: 2.7; source rows: 16194

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 57 | yes | 454 | 0 | 0.0% | 46.5% | 6,805.83 | 144.35 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:29, ratio_loss_budget:22, ratio_sustained_loser:6 | none |
| V1a_purchase_floor_2 | 53 | yes | 385 | 69 | 1.2% | 52.4% | 5,071.3 | 110.97 | -33.38 units; +5.9 pp early | 0 | ratio_hard_cut:30, ratio_loss_budget:13, ratio_sustained_loser:10 | none |
| V1b_purchase_floor_3 | 50 | yes | 376 | 78 | 1.4% | 51.3% | 5,071.3 | 110.97 | -33.38 units; +4.8 pp early | 0 | ratio_hard_cut:30, ratio_sustained_loser:10, ratio_loss_budget:10 | none |
| V1c_purchase_floor_5 | 50 | yes | 376 | 78 | 1.4% | 51.3% | 5,071.3 | 110.97 | -33.38 units; +4.8 pp early | 0 | ratio_hard_cut:30, ratio_sustained_loser:10, ratio_loss_budget:10 | none |
| V1d_purchase_floor_half_winner | 50 | yes | 376 | 78 | 1.4% | 51.3% | 5,071.3 | 110.97 | -33.38 units; +4.8 pp early | 0 | ratio_hard_cut:30, ratio_sustained_loser:10, ratio_loss_budget:10 | none |
| V2a_p25_upper_clamp_1 | 57 | yes | 454 | 0 | 0.0% | 46.5% | 6,805.83 | 144.35 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:29, ratio_loss_budget:22, ratio_sustained_loser:6 | none |
| V2b_p25_breakeven_floor | 62 | yes | 527 | 73 | 1.3% | 42.2% | 8,190.79 | 175.15 | +30.8 units; -4.3 pp early | 0 | ratio_hard_cut:28, ratio_loss_budget:28, ratio_sustained_loser:6 | none |
| V3_recommended_combo | 52 | yes | 444 | 146 | 2.6% | 47.5% | 6,410.06 | 140.85 | -3.5 units; +1.0 pp early | 0 | ratio_hard_cut:29, ratio_loss_budget:13, ratio_sustained_loser:10 | none |
| LB1_0_loss_budget | 72 | yes | 575 | 121 | 2.2% | 53.1% | 7,303.64 | 156.14 | +11.79 units; +6.6 pp early | 0 | ratio_loss_budget:38, ratio_hard_cut:29, ratio_sustained_loser:5 | none |
| LB1_5_loss_budget | 62 | yes | 495 | 41 | 0.7% | 48.9% | 7,385.6 | 157.41 | +13.06 units; +2.4 pp early | 0 | ratio_hard_cut:29, ratio_loss_budget:28, ratio_sustained_loser:5 | none |
| LB2_0_loss_budget | 57 | yes | 454 | 0 | 0.0% | 46.5% | 6,805.83 | 144.35 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:29, ratio_loss_budget:22, ratio_sustained_loser:6 | none |
| LB2_5_loss_budget | 54 | yes | 426 | 28 | 0.5% | 51.2% | 6,445.35 | 136.43 | -7.92 units; +4.7 pp early | 0 | ratio_hard_cut:30, ratio_loss_budget:17, ratio_sustained_loser:7 | none |
| LB3_0_loss_budget | 50 | yes | 376 | 78 | 1.4% | 51.3% | 5,071.3 | 110.97 | -33.38 units; +4.8 pp early | 0 | ratio_hard_cut:30, ratio_sustained_loser:10, ratio_loss_budget:10 | none |
| LB4_0_loss_budget | 41 | yes | 303 | 151 | 2.7% | 57.6% | 4,479.78 | 98.15 | -46.2 units; +11.1 pp early | 0 | ratio_hard_cut:31, ratio_loss_budget:6, ratio_sustained_loser:4 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2025-12-23 | home.ideas.by.g | ratio_hard_cut | 2,361.02 | 35 | 2.4191 | 5.2629 |
| 2025-12-19 | home.ideas.by.g | ratio_hard_cut | 1,912.84 | 29 | 2.4081 | 4.8082 |
| 2025-11-30 | Whenever I am | ratio_hard_cut | 1,575.29 | 27 | 2.1484 | 1.6826 |
| 2025-12-27 | WallArtCatalog | ratio_hard_cut | 1,352.87 | 21 | 2.3127 | 4.6001 |
| 2026-01-10 | maryamlina2 | ratio_hard_cut | 1,287.59 | 17 | 2.1704 | 4.4478 |
| 2025-12-11 | home.ideas.by.g | ratio_hard_cut | 1,239.99 | 16 | 2.0832 | 4.76 |
| 2026-01-20 | maryamlina2 | ratio_hard_cut | 881.36 | 16 | 2.4242 | n/a |
| 2026-01-27 | Besmele | ratio_hard_cut | 657.49 | 6 | 2.043 | 3.5629 |

### TheSwaf

Window: 2025-12-01 to 2026-01-31; rows evaluated: 2783; target ROAS: 2.2
Preset: aggressive; break-even ROAS: 1.71; source rows: 8464

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 20 | no | 136 | 0 | 0.0% | 16.7% | 2,734.77 | 44.39 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:16, ratio_loss_budget:3, ratio_sustained_loser:1 | none |
| V1a_purchase_floor_2 | 19 | no | 106 | 30 | 1.1% | 15.4% | 2,734.77 | 44.39 | +0 units; -1.3 pp early | 0 | ratio_hard_cut:16, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| V1b_purchase_floor_3 | 19 | no | 106 | 30 | 1.1% | 15.4% | 2,734.77 | 44.39 | +0 units; -1.3 pp early | 0 | ratio_hard_cut:16, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| V1c_purchase_floor_5 | 19 | no | 106 | 30 | 1.1% | 15.4% | 2,734.77 | 44.39 | +0 units; -1.3 pp early | 0 | ratio_hard_cut:16, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| V1d_purchase_floor_half_winner | 19 | no | 106 | 30 | 1.1% | 15.4% | 2,734.77 | 44.39 | +0 units; -1.3 pp early | 0 | ratio_hard_cut:16, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| V2a_p25_upper_clamp_1 | 20 | no | 136 | 0 | 0.0% | 16.7% | 2,734.77 | 44.39 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:16, ratio_loss_budget:3, ratio_sustained_loser:1 | none |
| V2b_p25_breakeven_floor | 44 | yes | 358 | 222 | 8.0% | 38.2% | 28,254.33 | 462.99 | +418.6 units; +21.6 pp early | 0 | ratio_hard_cut:38, ratio_loss_budget:5, ratio_sustained_loser:1 | none |
| V3_recommended_combo | 43 | yes | 326 | 250 | 9.0% | 37.1% | 28,254.33 | 462.99 | +418.6 units; +20.5 pp early | 0 | ratio_hard_cut:38, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| LB1_0_loss_budget | 20 | no | 143 | 7 | 0.3% | 16.7% | 2,734.77 | 44.39 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:16, ratio_loss_budget:3, ratio_sustained_loser:1 | none |
| LB1_5_loss_budget | 20 | no | 136 | 0 | 0.0% | 16.7% | 2,734.77 | 44.39 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:16, ratio_loss_budget:3, ratio_sustained_loser:1 | none |
| LB2_0_loss_budget | 19 | no | 106 | 30 | 1.1% | 15.4% | 2,734.77 | 44.39 | +0 units; -1.3 pp early | 0 | ratio_hard_cut:16, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| LB2_5_loss_budget | 19 | no | 93 | 43 | 1.6% | 25.0% | 2,569.8 | 41.82 | -2.57 units; +8.3 pp early | 0 | ratio_hard_cut:17, ratio_sustained_loser:1, ratio_loss_budget:1 | none |
| LB3_0_loss_budget | 18 | no | 74 | 62 | 2.2% | 25.0% | 2,569.8 | 41.82 | -2.57 units; +8.3 pp early | 0 | ratio_hard_cut:18 | lossBudget>=hardCut:18 |
| LB4_0_loss_budget | 17 | no | 71 | 77 | 2.8% | 27.3% | 1,812.48 | 29.75 | -14.64 units; +10.6 pp early | 0 | ratio_hard_cut:12, maturity_severe_loser:5 | lossBudget>=hardCut:17 |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2025-12-16 | Alexis3 | ratio_hard_cut | 2,445.27 | 32 | 1.4328 | 1.7846 |
| 2025-11-30 | Alexis2 | ratio_hard_cut | 1,781.89 | 21 | 1.2957 | n/a |
| 2026-01-12 | Alexis1 | ratio_hard_cut | 1,493.86 | 14 | 1.163 | n/a |
| 2025-12-18 | AllRings | ratio_hard_cut | 838.41 | 8 | 1.2673 | 2.0239 |
| 2026-01-22 | FlexProducts2 | ratio_hard_cut | 787.49 | 5 | 1.2999 | 2.0475 |
| 2025-11-30 | AllRings | ratio_hard_cut | 468.57 | 4 | 1.086 | 1.8054 |
| 2026-01-20 | AllRings | ratio_hard_cut | 430.85 | 4 | 1.3028 | 0.5452 |
| 2026-01-19 | AllRings | ratio_hard_cut | 414.09 | 3 | 1.2905 | 1.0468 |

## Recommendation

Status: no_uniform_change_supported

A uniform/global threshold change is not supported yet. The useful signal is account-level heterogeneity; re-test after current-version accrual before proposing per-account parameters.

Account-level signals:

- IwaStore V0 14d early-cut rate is 46.5%; this is an account-level alarm, not a global-rule proof.
- Grandmix V1d moves 14d early-cut rate 0.0% -> 0.0% (+0.0 pp).
- TheSwaf V2b saved spend units 44.39 -> 462.99 (10.4x) while 14d early-cut rate remains 38.2%.
- V2a upper-clamp-only effect is scarce in this replay: 0 affected daily rows vs V0.
- EMOLOS lossBudget sweep best saved-spend variant is LB4_0_loss_budget (lossBudget=4): saved units 41.64 -> 41.64 (+0), 14d early-cut 25.0% -> 0.0% (-25.0 pp), defensible=no, flip=1.6%.
- Grandmix lossBudget sweep best saved-spend variant is LB1_5_loss_budget (lossBudget=1.5): saved units 17.67 -> 17.67 (+0), 14d early-cut 0.0% -> 0.0% (+0.0 pp), defensible=no, flip=0.1%.
- IwaStore lossBudget sweep best saved-spend variant is LB1_5_loss_budget (lossBudget=1.5): saved units 144.35 -> 157.41 (+13.06), 14d early-cut 46.5% -> 48.9% (+2.4 pp), defensible=yes, flip=0.7%.
- TheSwaf lossBudget sweep best saved-spend variant is LB2_0_loss_budget (lossBudget=2): saved units 44.39 -> 44.39 (+0), 14d early-cut 16.7% -> 15.4% (-1.3 pp), defensible=no, flip=1.1%.

Parameter recommendation means a future formula phase only: user approval, golden cases, and an ENGINE_VERSION bump are required before implementation.

## Evidence Limits

- Survivorship: history contains creatives operators did not already kill, so observed early-cut rate is a lower bound.
- Attribution lag can move in both directions: delayed conversions may make forward ROAS look too low, while conversions caused by pre-cut spend may make post-cut recovery look too high.
- Target history is not versioned in business_target_packs; target and breakeven are held constant across the replay.
- The sweep uses raw forward ROAS and does not depend on v1/v2 outcome classifiers.
- Pooled saved-spend uses spendUnit-normalized units; raw currency is not pooled across businesses.
- LossBudgetMultiplier rows are univariate shadow sensitivity tests: purchase floor and boundary mode stay at current behavior unless the variant label says otherwise.
- This report does not change thresholds; any parameter adoption requires user approval, new golden cases, and an ENGINE_VERSION bump.
