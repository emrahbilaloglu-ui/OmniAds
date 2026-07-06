# Multi-Window Robustness - 2026-02-01 to 2026-03-31 decisions, 2026-07-05 data ceiling

This is a read-only parameter-evaluation report. It does not change resolver thresholds, formulas, database state, provider state, migrations, or operator behavior.

## Live Status

- generatedAt: 2026-07-05T22:13:59.698Z
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
- Query bound: per-business generated daily replay bounded to 2026-02-01..2026-03-31, 90d trailing calibration, and 14d primary forward windows
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
| V0_current | 131 | yes | 0 | 0.0% | 31.0% | 25 | 148.15 | +0 units; +0.0 pp early | 0 |
| V1a_purchase_floor_2 | 117 | yes | 82 | 0.5% | 35.9% | 21 | 133.47 | -14.68 units; +4.8 pp early | 0 |
| V1b_purchase_floor_3 | 111 | yes | 160 | 1.0% | 30.6% | 21 | 133.47 | -14.68 units; -0.4 pp early | 0 |
| V1c_purchase_floor_5 | 107 | yes | 169 | 1.0% | 29.2% | 21 | 133.47 | -14.68 units; -1.9 pp early | 0 |
| V1d_purchase_floor_half_winner | 111 | yes | 165 | 1.0% | 30.6% | 21 | 133.47 | -14.68 units; -0.4 pp early | 0 |
| V2a_p25_upper_clamp_1 | 131 | yes | 0 | 0.0% | 31.0% | 25 | 148.15 | +0 units; +0.0 pp early | 0 |
| V2b_p25_breakeven_floor | 167 | yes | 593 | 3.6% | 37.4% | 40 | 239.81 | +91.66 units; +6.3 pp early | 0 |
| V3_recommended_combo | 148 | yes | 699 | 4.2% | 37.0% | 34 | 222.3 | +74.15 units; +6.0 pp early | 0 |
| LB1_0_loss_budget | 154 | yes | 258 | 1.6% | 33.8% | 28 | 160.11 | +11.96 units; +2.8 pp early | 0 |
| LB1_5_loss_budget | 143 | yes | 150 | 0.9% | 31.8% | 27 | 156.21 | +8.06 units; +0.7 pp early | 0 |
| LB2_0_loss_budget | 132 | yes | 17 | 0.1% | 30.5% | 26 | 149.23 | +1.08 units; -0.5 pp early | 0 |
| LB2_5_loss_budget | 117 | yes | 102 | 0.6% | 31.4% | 20 | 131.48 | -16.67 units; +0.3 pp early | 0 |
| LB3_0_loss_budget | 106 | yes | 208 | 1.3% | 31.3% | 20 | 130.92 | -17.23 units; +0.2 pp early | 0 |
| LB4_0_loss_budget | 92 | yes | 378 | 2.3% | 31.7% | 19 | 122.24 | -25.91 units; +0.7 pp early | 0 |

## Business Detail

### EMOLOS

Window: 2026-02-01 to 2026-03-31; rows evaluated: 7127; target ROAS: 2.5
Preset: balanced; break-even ROAS: 2; source rows: 8825

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 25 | no | 131 | 0 | 0.0% | 20.0% | 555.01 | 16.39 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:12, ratio_hard_cut:11, ratio_sustained_loser:2 | none |
| V1a_purchase_floor_2 | 19 | no | 99 | 32 | 0.4% | 14.3% | 345.36 | 10.07 | -6.32 units; -5.7 pp early | 0 | ratio_hard_cut:11, ratio_loss_budget:5, ratio_sustained_loser:3 | none |
| V1b_purchase_floor_3 | 19 | no | 99 | 32 | 0.4% | 14.3% | 345.36 | 10.07 | -6.32 units; -5.7 pp early | 0 | ratio_hard_cut:11, ratio_loss_budget:5, ratio_sustained_loser:3 | none |
| V1c_purchase_floor_5 | 19 | no | 99 | 32 | 0.4% | 14.3% | 345.36 | 10.07 | -6.32 units; -5.7 pp early | 0 | ratio_hard_cut:11, ratio_loss_budget:5, ratio_sustained_loser:3 | none |
| V1d_purchase_floor_half_winner | 19 | no | 99 | 32 | 0.4% | 14.3% | 345.36 | 10.07 | -6.32 units; -5.7 pp early | 0 | ratio_hard_cut:11, ratio_loss_budget:5, ratio_sustained_loser:3 | none |
| V2a_p25_upper_clamp_1 | 25 | no | 131 | 0 | 0.0% | 20.0% | 555.01 | 16.39 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:12, ratio_hard_cut:11, ratio_sustained_loser:2 | none |
| V2b_p25_breakeven_floor | 39 | yes | 298 | 167 | 2.3% | 27.3% | 2,911.02 | 89.59 | +73.2 units; +7.3 pp early | 0 | ratio_hard_cut:19, ratio_loss_budget:18, ratio_sustained_loser:2 | none |
| V3_recommended_combo | 34 | yes | 260 | 193 | 2.7% | 21.1% | 2,701.37 | 83.27 | +66.88 units; +1.1 pp early | 1.5 | ratio_hard_cut:19, ratio_loss_budget:12, ratio_sustained_loser:3 | none |
| LB1_0_loss_budget | 28 | no | 143 | 12 | 0.2% | 20.0% | 555.01 | 16.39 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:15, ratio_hard_cut:11, ratio_sustained_loser:2 | none |
| LB1_5_loss_budget | 27 | no | 141 | 10 | 0.1% | 20.0% | 555.01 | 16.39 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:14, ratio_hard_cut:11, ratio_sustained_loser:2 | none |
| LB2_0_loss_budget | 25 | no | 131 | 0 | 0.0% | 20.0% | 555.01 | 16.39 | +0 units; +0.0 pp early | 0 | ratio_loss_budget:12, ratio_hard_cut:11, ratio_sustained_loser:2 | none |
| LB2_5_loss_budget | 21 | no | 111 | 20 | 0.3% | 25.0% | 345.36 | 10.07 | -6.32 units; +5.0 pp early | 0 | ratio_hard_cut:11, ratio_loss_budget:8, ratio_sustained_loser:2 | none |
| LB3_0_loss_budget | 19 | no | 99 | 32 | 0.4% | 14.3% | 345.36 | 10.07 | -6.32 units; -5.7 pp early | 0 | ratio_hard_cut:11, ratio_loss_budget:5, ratio_sustained_loser:3 | none |
| LB4_0_loss_budget | 14 | no | 66 | 65 | 0.9% | 25.0% | 345.36 | 10.07 | -6.32 units; +5.0 pp early | 0 | ratio_hard_cut:11, ratio_loss_budget:2, ratio_sustained_loser:1 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-03-26 | Instock | ratio_hard_cut | 981.17 | 21 | 1.8047 | 1.0369 |
| 2026-03-17 | Slim Fit Jeans Washed | ratio_hard_cut | 744.64 | 11 | 1.4808 | 1.1649 |
| 2026-03-25 | UGC Christian E | ratio_hard_cut | 723.98 | 15 | 1.544 | 0 |
| 2026-03-14 | Slim Fit Jeans Washed | ratio_hard_cut | 701.3 | 11 | 1.5485 | 1.3798 |
| 2026-02-02 | 21. Spray on Jeans 1 | ratio_hard_cut | 258.66 | 3 | 1.0958 | 0 |
| 2026-02-19 | 42. Esential Cargo Pants | ratio_hard_cut | 241.55 | 2 | 0.9441 | n/a |
| 2026-02-07 | 21. Spray on Jeans 1 | ratio_hard_cut | 232.18 | 3 | 1.2207 | n/a |
| 2026-02-05 | Instock | ratio_hard_cut | 225.32 | 3 | 0.9095 | n/a |

### Grandmix

Window: 2026-02-01 to 2026-03-31; rows evaluated: 807; target ROAS: 2.2
Preset: conservative; break-even ROAS: 1.8; source rows: 9066

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 9 | no | 51 | 0 | 0.0% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| V1a_purchase_floor_2 | 9 | no | 51 | 0 | 0.0% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| V1b_purchase_floor_3 | 8 | no | 35 | 16 | 2.0% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_loss_budget:2, ratio_sustained_loser:2 | none |
| V1c_purchase_floor_5 | 6 | no | 31 | 20 | 2.5% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| V1d_purchase_floor_half_winner | 7 | no | 32 | 19 | 2.4% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| V2a_p25_upper_clamp_1 | 9 | no | 51 | 0 | 0.0% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| V2b_p25_breakeven_floor | 9 | no | 58 | 7 | 0.9% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| V3_recommended_combo | 8 | no | 39 | 26 | 3.2% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_loss_budget:2, ratio_sustained_loser:2 | none |
| LB1_0_loss_budget | 11 | no | 79 | 28 | 3.5% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_loss_budget:5, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| LB1_5_loss_budget | 11 | no | 74 | 23 | 2.9% | 87.5% | 0 | n/a | saved n/a; -12.5 pp early | 0 | ratio_loss_budget:5, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| LB2_0_loss_budget | 10 | no | 65 | 14 | 1.7% | 85.7% | 114.63 | 1.08 | saved n/a; -14.3 pp early | 0 | ratio_loss_budget:4, ratio_hard_cut:4, ratio_sustained_loser:2 | none |
| LB2_5_loss_budget | 9 | no | 51 | 0 | 0.0% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| LB3_0_loss_budget | 7 | no | 42 | 9 | 1.1% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| LB4_0_loss_budget | 7 | no | 35 | 16 | 2.0% | 100.0% | 0 | n/a | saved n/a; +0.0 pp early | 0 | ratio_hard_cut:4, ratio_sustained_loser:2, ratio_loss_budget:1 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-03-25 | BathroomMeta | ratio_hard_cut | 3,542.38 | 39 | 1.7706 | 2.7761 |
| 2026-03-27 | BathroomMeta | ratio_hard_cut | 3,354.22 | 39 | 2.0348 | 2.7042 |
| 2026-03-04 | WallArtMeta | ratio_hard_cut | 2,652.38 | 25 | 2.0766 | 3.3657 |
| 2026-03-03 | WallArtMeta | ratio_hard_cut | 870.23 | 8 | 1.7935 | n/a |
| 2026-03-17 | LuggageRackMeta | ratio_sustained_loser | 606.83 | 3 | 1.1296 | 0 |
| 2026-02-27 | WallArtMeta | ratio_sustained_loser | 603.95 | 5 | 1.3918 | 2.7045 |
| 2026-02-23 | WallArtMeta | ratio_loss_budget | 480.56 | 4 | 1.5643 | 2.2363 |
| 2026-02-04 | Utility | ratio_loss_budget | 286.1 | 3 | 1.3527 | 0.7896 |

### IwaStore

Window: 2026-02-01 to 2026-03-31; rows evaluated: 6051; target ROAS: 3.5
Preset: balanced; break-even ROAS: 2.7; source rows: 16194

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 78 | yes | 666 | 0 | 0.0% | 26.5% | 5,436.56 | 96.21 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:33, ratio_sustained_loser:3 | none |
| V1a_purchase_floor_2 | 70 | yes | 619 | 47 | 0.8% | 34.4% | 4,973.61 | 87.85 | -8.36 units; +7.9 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:19, ratio_sustained_loser:9 | none |
| V1b_purchase_floor_3 | 65 | yes | 557 | 109 | 1.8% | 27.6% | 4,973.61 | 87.85 | -8.36 units; +1.1 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:14, ratio_sustained_loser:9 | none |
| V1c_purchase_floor_5 | 63 | yes | 552 | 114 | 1.9% | 27.6% | 4,973.61 | 87.85 | -8.36 units; +1.1 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:12, ratio_sustained_loser:9 | none |
| V1d_purchase_floor_half_winner | 66 | yes | 555 | 111 | 1.8% | 30.0% | 4,973.61 | 87.85 | -8.36 units; +3.5 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:15, ratio_sustained_loser:9 | none |
| V2a_p25_upper_clamp_1 | 78 | yes | 666 | 0 | 0.0% | 26.5% | 5,436.56 | 96.21 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:33, ratio_sustained_loser:3 | none |
| V2b_p25_breakeven_floor | 84 | yes | 949 | 283 | 4.7% | 29.7% | 5,654.46 | 99.65 | +3.44 units; +3.3 pp early | 0 | ratio_hard_cut:43, ratio_loss_budget:39, ratio_sustained_loser:2 | none |
| V3_recommended_combo | 72 | yes | 814 | 370 | 6.1% | 34.4% | 5,033.46 | 88.46 | -7.75 units; +7.9 pp early | 0 | ratio_hard_cut:43, ratio_loss_budget:21, ratio_sustained_loser:8 | none |
| LB1_0_loss_budget | 96 | yes | 884 | 218 | 3.6% | 30.2% | 6,149.37 | 108.17 | +11.96 units; +3.8 pp early | 0 | ratio_loss_budget:52, ratio_hard_cut:41, ratio_sustained_loser:3 | none |
| LB1_5_loss_budget | 86 | yes | 783 | 117 | 1.9% | 27.0% | 5,915.62 | 104.27 | +8.06 units; +0.6 pp early | 0 | ratio_loss_budget:42, ratio_hard_cut:41, ratio_sustained_loser:3 | none |
| LB2_0_loss_budget | 78 | yes | 666 | 0 | 0.0% | 26.5% | 5,436.56 | 96.21 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:33, ratio_sustained_loser:3 | none |
| LB2_5_loss_budget | 69 | yes | 619 | 47 | 0.8% | 23.3% | 5,000.58 | 88.41 | -7.8 units; -3.1 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:24, ratio_sustained_loser:3 | none |
| LB3_0_loss_budget | 63 | yes | 552 | 114 | 1.9% | 27.6% | 4,973.61 | 87.85 | -8.36 units; +1.1 pp early | 0 | ratio_hard_cut:42, ratio_loss_budget:12, ratio_sustained_loser:9 | none |
| LB4_0_loss_budget | 53 | yes | 433 | 233 | 3.9% | 24.0% | 4,496.46 | 79.17 | -17.04 units; -2.5 pp early | 0 | ratio_hard_cut:43, ratio_loss_budget:6, ratio_sustained_loser:4 | none |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-02-22 | In each name | ratio_hard_cut | 2,488.4 | 31 | 2.1314 | n/a |
| 2026-03-28 | I’m so happy | ratio_hard_cut | 1,786.93 | 26 | 1.9456 | n/a |
| 2026-02-17 | A prayer rug | ratio_hard_cut | 1,687.35 | 17 | 2.1306 | n/a |
| 2026-02-13 | A prayer rug | ratio_hard_cut | 1,584.65 | 16 | 2.1263 | 2.1691 |
| 2026-03-11 | Febieyyi | ratio_hard_cut | 1,463.64 | 20 | 2.0738 | 2.3391 |
| 2026-03-21 | Febieyyi | ratio_hard_cut | 1,365.91 | 14 | 1.7929 | 4.6438 |
| 2026-02-10 | A prayer rug | ratio_hard_cut | 1,274.93 | 12 | 2.1927 | 1.929 |
| 2026-02-08 | WallArtCatalog | ratio_hard_cut | 939.79 | 11 | 2.1964 | 3.1579 |

### TheSwaf

Window: 2026-02-01 to 2026-03-31; rows evaluated: 2610; target ROAS: 2.2
Preset: aggressive; break-even ROAS: 1.71; source rows: 8464

| Variant | Episodes | Defensible | Daily cut rows | Affected rows vs V0 | Flip rate vs V0 | 14d early-cut rate | Saved spend | Saved spend units | Trade-off vs V0 | Delay vs V0 | Source mix | Safety flags |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| V0_current | 19 | no | 242 | 0 | 0.0% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:4, ratio_sustained_loser:1 | none |
| V1a_purchase_floor_2 | 19 | no | 239 | 3 | 0.1% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| V1b_purchase_floor_3 | 19 | no | 239 | 3 | 0.1% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| V1c_purchase_floor_5 | 19 | no | 239 | 3 | 0.1% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| V1d_purchase_floor_half_winner | 19 | no | 239 | 3 | 0.1% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| V2a_p25_upper_clamp_1 | 19 | no | 242 | 0 | 0.0% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:4, ratio_sustained_loser:1 | none |
| V2b_p25_breakeven_floor | 35 | yes | 378 | 136 | 5.2% | 44.4% | 3,651.08 | 50.57 | +15.02 units; +31.9 pp early | 0 | ratio_hard_cut:26, ratio_loss_budget:8, ratio_sustained_loser:1 | none |
| V3_recommended_combo | 34 | yes | 346 | 110 | 4.2% | 41.2% | 3,651.08 | 50.57 | +15.02 units; +28.7 pp early | 0 | ratio_hard_cut:26, ratio_loss_budget:6, ratio_sustained_loser:2 | none |
| LB1_0_loss_budget | 19 | no | 242 | 0 | 0.0% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:4, ratio_sustained_loser:1 | none |
| LB1_5_loss_budget | 19 | no | 242 | 0 | 0.0% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:4, ratio_sustained_loser:1 | none |
| LB2_0_loss_budget | 19 | no | 239 | 3 | 0.1% | 12.5% | 2,537.3 | 35.55 | +0 units; +0.0 pp early | 0 | ratio_hard_cut:14, ratio_loss_budget:3, ratio_sustained_loser:2 | none |
| LB2_5_loss_budget | 18 | no | 207 | 35 | 1.3% | 14.3% | 2,372.33 | 33 | -2.55 units; +1.8 pp early | 0 | ratio_hard_cut:15, ratio_sustained_loser:2, ratio_loss_budget:1 | none |
| LB3_0_loss_budget | 17 | no | 189 | 53 | 2.0% | 14.3% | 2,372.33 | 33 | -2.55 units; +1.8 pp early | 0 | ratio_hard_cut:17 | lossBudget>=hardCut:17 |
| LB4_0_loss_budget | 18 | no | 178 | 64 | 2.5% | 14.3% | 2,372.33 | 33 | -2.55 units; +1.8 pp early | 0 | ratio_hard_cut:15, maturity_severe_loser:3 | lossBudget>=hardCut:18 |

Top V0 cut episode samples:

| Date | Creative | Source | Spend28 | Purchases28 | ROAS28 | Forward28 ROAS |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-03-23 | AllRings | ratio_hard_cut | 1,534.93 | 4 | 0.5524 | 0.9204 |
| 2026-03-14 | Alexis4 | ratio_hard_cut | 1,191.08 | 7 | 1.0044 | n/a |
| 2026-02-04 | AllRings | ratio_hard_cut | 1,065.9 | 8 | 1.305 | 1.8416 |
| 2026-03-07 | Advantage+ catalog ad | ratio_hard_cut | 865.98 | 4 | 0.9342 | n/a |
| 2026-03-07 | FlexProducts1 | ratio_hard_cut | 710.94 | 5 | 1.2322 | n/a |
| 2026-02-13 | Advantage+ catalog | ratio_hard_cut | 662.52 | 2 | 0.6022 | 0.9409 |
| 2026-02-13 | FlexProducts2 | ratio_hard_cut | 656.77 | 4 | 1.2721 | n/a |
| 2026-01-31 | AllRings | ratio_hard_cut | 509.79 | 3 | 1.2331 | 0.7706 |

## Recommendation

Status: no_uniform_change_supported

A uniform/global threshold change is not supported yet. The useful signal is account-level heterogeneity; re-test after current-version accrual before proposing per-account parameters.

Account-level signals:

- IwaStore V0 14d early-cut rate is 26.5%; this is an account-level alarm, not a global-rule proof.
- Grandmix V1d moves 14d early-cut rate 100.0% -> 100.0% (+0.0 pp).
- TheSwaf V2b saved spend units 35.55 -> 50.57 (1.4x) while 14d early-cut rate remains 44.4%.
- V2a upper-clamp-only effect is scarce in this replay: 0 affected daily rows vs V0.
- EMOLOS lossBudget sweep best saved-spend variant is LB1_0_loss_budget (lossBudget=1): saved units 16.39 -> 16.39 (+0), 14d early-cut 20.0% -> 20.0% (+0.0 pp), defensible=no, flip=0.2%.
- Grandmix lossBudget sweep best saved-spend variant is LB2_0_loss_budget (lossBudget=2): saved units n/a -> 1.08, 14d early-cut 100.0% -> 85.7% (-14.3 pp), defensible=no, flip=1.7%.
- IwaStore lossBudget sweep best saved-spend variant is LB1_0_loss_budget (lossBudget=1): saved units 96.21 -> 108.17 (+11.96), 14d early-cut 26.5% -> 30.2% (+3.8 pp), defensible=yes, flip=3.6%.
- TheSwaf lossBudget sweep best saved-spend variant is LB1_0_loss_budget (lossBudget=1): saved units 35.55 -> 35.55 (+0), 14d early-cut 12.5% -> 12.5% (+0.0 pp), defensible=no, flip=0.0%.

Parameter recommendation means a future formula phase only: user approval, golden cases, and an ENGINE_VERSION bump are required before implementation.

## Evidence Limits

- Survivorship: history contains creatives operators did not already kill, so observed early-cut rate is a lower bound.
- Attribution lag can move in both directions: delayed conversions may make forward ROAS look too low, while conversions caused by pre-cut spend may make post-cut recovery look too high.
- Target history is not versioned in business_target_packs; target and breakeven are held constant across the replay.
- The sweep uses raw forward ROAS and does not depend on v1/v2 outcome classifiers.
- Pooled saved-spend uses spendUnit-normalized units; raw currency is not pooled across businesses.
- LossBudgetMultiplier rows are univariate shadow sensitivity tests: purchase floor and boundary mode stay at current behavior unless the variant label says otherwise.
- This report does not change thresholds; any parameter adoption requires user approval, new golden cases, and an ENGINE_VERSION bump.
