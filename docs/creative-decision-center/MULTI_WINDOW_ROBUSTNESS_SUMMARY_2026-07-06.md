# Multi-Window Robustness Summary - 2026-07-06

Generated at: 2026-07-05T22:23:35.778Z

Read-only: yes. This summary only aggregates prior shadow replay outputs; it does not query providers, mutate DB rows, change resolver code, or post cron endpoints.

## Decision

No uniform/global formula change is supported by the multi-window replay.

The strongest repeated economic signal is TheSwaf + V2b (p25/breakeven boundary floor), but it is not a clean production candidate. It produces positive saved-unit deltas in all four windows (+869.9 units total), yet its pooled 14d early-cut rate worsens by +5.3 pp versus baseline and Dec-Jan/Feb-Mar worsen materially. The sign flips by regime: Dec-Jan +21.6 pp and Feb-Mar +31.9 pp, then Apr-May -10.4 pp and June -6.3 pp. This supports a deeper TheSwaf-only shadow investigation with golden cases, not rollout approval.

TheSwaf V2b is also target-history sensitive in a first-order way because its boundary depends on breakEvenRoas/targetRoas. This replay applies the latest target/config state across seven months of history; the two worst TheSwaf V2b windows (Dec-Mar) are also the most anachronistic windows. The final arbiter for this variant is live accrual under current targets, not the pooled +5.3 pp or the last-two-window improvement in isolation.

Grandmix V1d is not robust enough for production. It helps in the Apr-May window, is neutral in Dec-Jan and June, and does not fix the high-risk Feb-Mar window.

LossBudgetMultiplier should be account-level structurally, but it is not the first production lever. LB2.0 is small/inconsistent; LB3.0 exposes the lossBudget >= hardCut behavior class and must be blocked by validation/clamping or covered by new golden cases before any rollout.

IwaStore is no longer just a June small-n footnote. Older windows show enough episodes and high current early-cut rates to treat it as an account-level alarm. V2b is directionally interesting in aggregate, but it still worsens Feb-Mar early-cut rate and must be treated as a diagnostic candidate rather than a production-ready fix.

## Inputs

- 2025-12-01..2026-01-31: docs/creative-decision-center/generated/robustness-window-2025-12-01-to-2026-01-31.json (EMOLOS:ok, Grandmix:ok, IwaStore:ok, TheSwaf:ok)
- 2026-02-01..2026-03-31: docs/creative-decision-center/generated/robustness-window-2026-02-01-to-2026-03-31.json (EMOLOS:ok, Grandmix:ok, IwaStore:ok, TheSwaf:ok)
- 2026-04-01..2026-05-31: docs/creative-decision-center/generated/robustness-window-2026-04-01-to-2026-05-31.json (EMOLOS:ok, Grandmix:ok, IwaStore:ok, TheSwaf:ok)
- 2026-06-01..2026-06-20: docs/creative-decision-center/generated/robustness-window-2026-06-01-to-2026-06-20.json (EMOLOS:ok, Grandmix:ok, IwaStore:ok, TheSwaf:ok)

## Aggregate Weighted Table

Weighted rates sum recovered/known episodes across windows. Saved-unit deltas are summed only where both baseline and variant report finite saved-unit values; null saved-unit windows are retained in the JSON output. The pooled early-cut number is known-weighted, so longer/older windows can dominate shorter recent windows; do not quote TheSwaf V2b's pooled +5.3 pp without the per-window sign flip.

| Business | Variant | Windows | Defensible | Known 14d | Early 14d | Baseline Early | Delta | Saved Units | Saved Delta | Affected Rows | LB>=HardCut |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| EMOLOS | V0_current | 4 | 0 | 40 | 12.5% | 12.5% | +0.0 pp | 193.2 | +0.0 | 0 (0.0%) | 0 |
| EMOLOS | V1d_purchase_floor_half_winner | 4 | 0 | 32 | 6.3% | 12.5% | -6.3 pp | 176.6 | -16.7 | 58 (0.3%) | 0 |
| EMOLOS | V2b_p25_breakeven_floor | 4 | 4 | 78 | 20.5% | 12.5% | +8.0 pp | 413.0 | +219.7 | 842 (4.4%) | 0 |
| EMOLOS | V3_recommended_combo | 4 | 4 | 69 | 20.3% | 12.5% | +7.8 pp | 347.3 | +154.1 | 863 (4.5%) | 0 |
| EMOLOS | LB1_0_loss_budget | 4 | 1 | 40 | 12.5% | 12.5% | +0.0 pp | 194.8 | +1.6 | 40 (0.2%) | 0 |
| EMOLOS | LB2_0_loss_budget | 4 | 0 | 40 | 12.5% | 12.5% | +0.0 pp | 193.2 | +0.0 | 0 (0.0%) | 0 |
| EMOLOS | LB2_5_loss_budget | 4 | 0 | 37 | 13.5% | 12.5% | +1.0 pp | 184.7 | -8.6 | 33 (0.2%) | 0 |
| EMOLOS | LB3_0_loss_budget | 4 | 0 | 32 | 6.3% | 12.5% | -6.3 pp | 176.6 | -16.7 | 58 (0.3%) | 0 |
| Grandmix | V0_current | 4 | 0 | 28 | 32.1% | 32.1% | +0.0 pp | 101.6 | +0.0 | 0 (0.0%) | 0 |
| Grandmix | V1d_purchase_floor_half_winner | 4 | 0 | 21 | 19.0% | 32.1% | -13.1 pp | 70.1 | -31.5 | 135 (1.8%) | 0 |
| Grandmix | V2b_p25_breakeven_floor | 4 | 1 | 41 | 26.8% | 32.1% | -5.3 pp | 162.3 | +60.7 | 351 (4.7%) | 0 |
| Grandmix | V3_recommended_combo | 4 | 0 | 35 | 20.0% | 32.1% | -12.1 pp | 134.8 | +33.2 | 475 (6.4%) | 0 |
| Grandmix | LB1_0_loss_budget | 4 | 1 | 36 | 38.9% | 32.1% | +6.7 pp | 108.8 | +7.2 | 186 (2.5%) | 0 |
| Grandmix | LB2_0_loss_budget | 4 | 1 | 32 | 31.3% | 32.1% | -0.9 pp | 107.5 | +5.9 | 88 (1.2%) | 0 |
| Grandmix | LB2_5_loss_budget | 4 | 0 | 28 | 32.1% | 32.1% | +0.0 pp | 101.6 | +0.0 | 0 (0.0%) | 0 |
| Grandmix | LB3_0_loss_budget | 4 | 0 | 24 | 20.8% | 32.1% | -11.3 pp | 95.7 | -6.0 | 55 (0.7%) | 0 |
| IwaStore | V0_current | 4 | 3 | 83 | 38.6% | 38.6% | +0.0 pp | 244.3 | +0.0 | 0 (0.0%) | 0 |
| IwaStore | V1d_purchase_floor_half_winner | 4 | 2 | 72 | 43.1% | 38.6% | +4.5 pp | 201.9 | -42.4 | 249 (1.4%) | 0 |
| IwaStore | V2b_p25_breakeven_floor | 4 | 3 | 94 | 36.2% | 38.6% | -2.4 pp | 294.7 | +50.4 | 513 (2.8%) | 0 |
| IwaStore | V3_recommended_combo | 4 | 2 | 80 | 40.0% | 38.6% | +1.4 pp | 245.8 | +1.4 | 707 (3.8%) | 0 |
| IwaStore | LB1_0_loss_budget | 4 | 3 | 105 | 43.8% | 38.6% | +5.3 pp | 283.6 | +39.3 | 512 (2.8%) | 0 |
| IwaStore | LB2_0_loss_budget | 4 | 3 | 83 | 38.6% | 38.6% | +0.0 pp | 244.3 | +0.0 | 0 (0.0%) | 0 |
| IwaStore | LB2_5_loss_budget | 4 | 2 | 77 | 40.3% | 38.6% | +1.7 pp | 229.3 | -15.1 | 116 (0.6%) | 0 |
| IwaStore | LB3_0_loss_budget | 4 | 2 | 71 | 42.3% | 38.6% | +3.7 pp | 201.9 | -42.4 | 252 (1.4%) | 0 |
| TheSwaf | V0_current | 4 | 2 | 61 | 19.7% | 19.7% | +0.0 pp | 710.7 | +0.0 | 0 (0.0%) | 0 |
| TheSwaf | V1d_purchase_floor_half_winner | 4 | 2 | 58 | 19.0% | 19.7% | -0.7 pp | 703.5 | -7.2 | 63 (0.5%) | 0 |
| TheSwaf | V2b_p25_breakeven_floor | 4 | 4 | 120 | 25.0% | 19.7% | +5.3 pp | 1580.5 | +869.9 | 1022 (7.4%) | 0 |
| TheSwaf | V3_recommended_combo | 4 | 4 | 113 | 26.5% | 19.7% | +6.9 pp | 1563.0 | +852.3 | 1003 (7.3%) | 0 |
| TheSwaf | LB1_0_loss_budget | 4 | 2 | 61 | 19.7% | 19.7% | +0.0 pp | 711.9 | +1.2 | 33 (0.2%) | 0 |
| TheSwaf | LB2_0_loss_budget | 4 | 2 | 58 | 19.0% | 19.7% | -0.7 pp | 703.5 | -7.2 | 63 (0.5%) | 0 |
| TheSwaf | LB2_5_loss_budget | 4 | 2 | 53 | 18.9% | 19.7% | -0.8 pp | 690.7 | -20.0 | 152 (1.1%) | 0 |
| TheSwaf | LB3_0_loss_budget | 4 | 2 | 51 | 17.6% | 19.7% | -2.0 pp | 683.6 | -27.1 | 236 (1.7%) | 112 |

## Per-Window Detail

| Window | Business | Variant | Known 14d | Early 14d | Baseline Early | Delta | Saved Units | Saved Delta | Defensible | Affected Rows |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-12-01..2026-01-31 | EMOLOS | V0_current | 12 | 25.0% | 25.0% | +0.0 pp | 41.6 | +0.0 | no | 0 (0.0%) |
| 2025-12-01..2026-01-31 | EMOLOS | V1d_purchase_floor_half_winner | 8 | 12.5% | 25.0% | -12.5 pp | 41.6 | +0.0 | no | 20 (0.6%) |
| 2025-12-01..2026-01-31 | EMOLOS | V2b_p25_breakeven_floor | 28 | 32.1% | 25.0% | +7.1 pp | 65.3 | +23.7 | yes | 209 (6.0%) |
| 2025-12-01..2026-01-31 | EMOLOS | LB2_0_loss_budget | 12 | 25.0% | 25.0% | +0.0 pp | 41.6 | +0.0 | no | 0 (0.0%) |
| 2025-12-01..2026-01-31 | EMOLOS | LB3_0_loss_budget | 8 | 12.5% | 25.0% | -12.5 pp | 41.6 | +0.0 | no | 20 (0.6%) |
| 2025-12-01..2026-01-31 | Grandmix | V0_current | 2 | 0.0% | 0.0% | +0.0 pp | 17.7 | +0.0 | no | 0 (0.0%) |
| 2025-12-01..2026-01-31 | Grandmix | V1d_purchase_floor_half_winner | 2 | 0.0% | 0.0% | +0.0 pp | 17.7 | +0.0 | no | 16 (0.8%) |
| 2025-12-01..2026-01-31 | Grandmix | V2b_p25_breakeven_floor | 4 | 0.0% | 0.0% | +0.0 pp | 25.5 | +7.8 | no | 96 (4.8%) |
| 2025-12-01..2026-01-31 | Grandmix | LB2_0_loss_budget | 2 | 0.0% | 0.0% | +0.0 pp | 17.7 | +0.0 | no | 1 (0.1%) |
| 2025-12-01..2026-01-31 | Grandmix | LB3_0_loss_budget | 2 | 0.0% | 0.0% | +0.0 pp | 17.7 | +0.0 | no | 9 (0.5%) |
| 2025-12-01..2026-01-31 | IwaStore | V0_current | 43 | 46.5% | 46.5% | +0.0 pp | 144.3 | +0.0 | yes | 0 (0.0%) |
| 2025-12-01..2026-01-31 | IwaStore | V1d_purchase_floor_half_winner | 39 | 51.3% | 46.5% | +4.8 pp | 111.0 | -33.4 | yes | 78 (1.4%) |
| 2025-12-01..2026-01-31 | IwaStore | V2b_p25_breakeven_floor | 45 | 42.2% | 46.5% | -4.3 pp | 175.2 | +30.8 | yes | 73 (1.3%) |
| 2025-12-01..2026-01-31 | IwaStore | LB2_0_loss_budget | 43 | 46.5% | 46.5% | +0.0 pp | 144.3 | +0.0 | yes | 0 (0.0%) |
| 2025-12-01..2026-01-31 | IwaStore | LB3_0_loss_budget | 39 | 51.3% | 46.5% | +4.8 pp | 111.0 | -33.4 | yes | 78 (1.4%) |
| 2025-12-01..2026-01-31 | TheSwaf | V0_current | 12 | 16.7% | 16.7% | +0.0 pp | 44.4 | +0.0 | no | 0 (0.0%) |
| 2025-12-01..2026-01-31 | TheSwaf | V1d_purchase_floor_half_winner | 13 | 15.4% | 16.7% | -1.3 pp | 44.4 | +0.0 | no | 30 (1.1%) |
| 2025-12-01..2026-01-31 | TheSwaf | V2b_p25_breakeven_floor | 34 | 38.2% | 16.7% | +21.6 pp | 463.0 | +418.6 | yes | 222 (8.0%) |
| 2025-12-01..2026-01-31 | TheSwaf | LB2_0_loss_budget | 13 | 15.4% | 16.7% | -1.3 pp | 44.4 | +0.0 | no | 30 (1.1%) |
| 2025-12-01..2026-01-31 | TheSwaf | LB3_0_loss_budget | 12 | 25.0% | 16.7% | +8.3 pp | 41.8 | -2.6 | no | 62 (2.2%) |
| 2026-02-01..2026-03-31 | EMOLOS | V0_current | 10 | 20.0% | 20.0% | +0.0 pp | 16.4 | +0.0 | no | 0 (0.0%) |
| 2026-02-01..2026-03-31 | EMOLOS | V1d_purchase_floor_half_winner | 7 | 14.3% | 20.0% | -5.7 pp | 10.1 | -6.3 | no | 32 (0.4%) |
| 2026-02-01..2026-03-31 | EMOLOS | V2b_p25_breakeven_floor | 22 | 27.3% | 20.0% | +7.3 pp | 89.6 | +73.2 | yes | 167 (2.3%) |
| 2026-02-01..2026-03-31 | EMOLOS | LB2_0_loss_budget | 10 | 20.0% | 20.0% | +0.0 pp | 16.4 | +0.0 | no | 0 (0.0%) |
| 2026-02-01..2026-03-31 | EMOLOS | LB3_0_loss_budget | 7 | 14.3% | 20.0% | -5.7 pp | 10.1 | -6.3 | no | 32 (0.4%) |
| 2026-02-01..2026-03-31 | Grandmix | V0_current | 6 | 100.0% | 100.0% | +0.0 pp | n/a | n/a | no | 0 (0.0%) |
| 2026-02-01..2026-03-31 | Grandmix | V1d_purchase_floor_half_winner | 4 | 100.0% | 100.0% | +0.0 pp | n/a | n/a | no | 19 (2.4%) |
| 2026-02-01..2026-03-31 | Grandmix | V2b_p25_breakeven_floor | 6 | 100.0% | 100.0% | +0.0 pp | n/a | n/a | no | 7 (0.9%) |
| 2026-02-01..2026-03-31 | Grandmix | LB2_0_loss_budget | 7 | 85.7% | 100.0% | -14.3 pp | 1.1 | n/a | no | 14 (1.7%) |
| 2026-02-01..2026-03-31 | Grandmix | LB3_0_loss_budget | 5 | 100.0% | 100.0% | +0.0 pp | n/a | n/a | no | 9 (1.1%) |
| 2026-02-01..2026-03-31 | IwaStore | V0_current | 34 | 26.5% | 26.5% | +0.0 pp | 96.2 | +0.0 | yes | 0 (0.0%) |
| 2026-02-01..2026-03-31 | IwaStore | V1d_purchase_floor_half_winner | 30 | 30.0% | 26.5% | +3.5 pp | 87.8 | -8.4 | yes | 111 (1.8%) |
| 2026-02-01..2026-03-31 | IwaStore | V2b_p25_breakeven_floor | 37 | 29.7% | 26.5% | +3.3 pp | 99.7 | +3.4 | yes | 283 (4.7%) |
| 2026-02-01..2026-03-31 | IwaStore | LB2_0_loss_budget | 34 | 26.5% | 26.5% | +0.0 pp | 96.2 | +0.0 | yes | 0 (0.0%) |
| 2026-02-01..2026-03-31 | IwaStore | LB3_0_loss_budget | 29 | 27.6% | 26.5% | +1.1 pp | 87.8 | -8.4 | yes | 114 (1.9%) |
| 2026-02-01..2026-03-31 | TheSwaf | V0_current | 8 | 12.5% | 12.5% | +0.0 pp | 35.5 | +0.0 | no | 0 (0.0%) |
| 2026-02-01..2026-03-31 | TheSwaf | V1d_purchase_floor_half_winner | 8 | 12.5% | 12.5% | +0.0 pp | 35.5 | +0.0 | no | 3 (0.1%) |
| 2026-02-01..2026-03-31 | TheSwaf | V2b_p25_breakeven_floor | 18 | 44.4% | 12.5% | +31.9 pp | 50.6 | +15.0 | yes | 136 (5.2%) |
| 2026-02-01..2026-03-31 | TheSwaf | LB2_0_loss_budget | 8 | 12.5% | 12.5% | +0.0 pp | 35.5 | +0.0 | no | 3 (0.1%) |
| 2026-02-01..2026-03-31 | TheSwaf | LB3_0_loss_budget | 7 | 14.3% | 12.5% | +1.8 pp | 33.0 | -2.5 | no | 53 (2.0%) |
| 2026-04-01..2026-05-31 | EMOLOS | V0_current | 13 | 0.0% | 0.0% | +0.0 pp | 98.5 | +0.0 | no | 0 (0.0%) |
| 2026-04-01..2026-05-31 | EMOLOS | V1d_purchase_floor_half_winner | 12 | 0.0% | 0.0% | +0.0 pp | 88.2 | -10.3 | no | 5 (0.1%) |
| 2026-04-01..2026-05-31 | EMOLOS | V2b_p25_breakeven_floor | 18 | 0.0% | 0.0% | +0.0 pp | 132.4 | +33.9 | yes | 222 (3.7%) |
| 2026-04-01..2026-05-31 | EMOLOS | LB2_0_loss_budget | 13 | 0.0% | 0.0% | +0.0 pp | 98.5 | +0.0 | no | 0 (0.0%) |
| 2026-04-01..2026-05-31 | EMOLOS | LB3_0_loss_budget | 12 | 0.0% | 0.0% | +0.0 pp | 88.2 | -10.3 | no | 5 (0.1%) |
| 2026-04-01..2026-05-31 | Grandmix | V0_current | 16 | 18.8% | 18.8% | +0.0 pp | 80.0 | +0.0 | no | 0 (0.0%) |
| 2026-04-01..2026-05-31 | Grandmix | V1d_purchase_floor_half_winner | 11 | 0.0% | 18.8% | -18.8 pp | 48.5 | -31.5 | no | 76 (2.4%) |
| 2026-04-01..2026-05-31 | Grandmix | V2b_p25_breakeven_floor | 19 | 21.1% | 18.8% | +2.3 pp | 99.1 | +19.1 | yes | 107 (3.4%) |
| 2026-04-01..2026-05-31 | Grandmix | LB2_0_loss_budget | 18 | 16.7% | 18.8% | -2.1 pp | 84.7 | +4.8 | yes | 40 (1.3%) |
| 2026-04-01..2026-05-31 | Grandmix | LB3_0_loss_budget | 13 | 0.0% | 18.8% | -18.8 pp | 74.0 | -6.0 | no | 34 (1.1%) |
| 2026-04-01..2026-05-31 | IwaStore | V0_current | 4 | 50.0% | 50.0% | +0.0 pp | 3.1 | +0.0 | yes | 0 (0.0%) |
| 2026-04-01..2026-05-31 | IwaStore | V1d_purchase_floor_half_winner | 2 | 50.0% | 50.0% | +0.0 pp | 3.1 | +0.0 | no | 55 (1.0%) |
| 2026-04-01..2026-05-31 | IwaStore | V2b_p25_breakeven_floor | 10 | 30.0% | 50.0% | -20.0 pp | 19.2 | +16.2 | yes | 154 (2.7%) |
| 2026-04-01..2026-05-31 | IwaStore | LB2_0_loss_budget | 4 | 50.0% | 50.0% | +0.0 pp | 3.1 | +0.0 | yes | 0 (0.0%) |
| 2026-04-01..2026-05-31 | IwaStore | LB3_0_loss_budget | 2 | 50.0% | 50.0% | +0.0 pp | 3.1 | +0.0 | no | 55 (1.0%) |
| 2026-04-01..2026-05-31 | TheSwaf | V0_current | 25 | 24.0% | 24.0% | +0.0 pp | 284.7 | +0.0 | yes | 0 (0.0%) |
| 2026-04-01..2026-05-31 | TheSwaf | V1d_purchase_floor_half_winner | 22 | 27.3% | 24.0% | +3.3 pp | 277.2 | -7.5 | yes | 21 (0.5%) |
| 2026-04-01..2026-05-31 | TheSwaf | V2b_p25_breakeven_floor | 44 | 13.6% | 24.0% | -10.4 pp | 622.8 | +338.2 | yes | 407 (9.7%) |
| 2026-04-01..2026-05-31 | TheSwaf | LB2_0_loss_budget | 22 | 27.3% | 24.0% | +3.3 pp | 277.2 | -7.5 | yes | 21 (0.5%) |
| 2026-04-01..2026-05-31 | TheSwaf | LB3_0_loss_budget | 20 | 20.0% | 24.0% | -4.0 pp | 278.0 | -6.7 | yes | 83 (2.0%) |
| 2026-06-01..2026-06-20 | EMOLOS | V0_current | 5 | 0.0% | 0.0% | +0.0 pp | 36.7 | +0.0 | no | 0 (0.0%) |
| 2026-06-01..2026-06-20 | EMOLOS | V1d_purchase_floor_half_winner | 5 | 0.0% | 0.0% | +0.0 pp | 36.7 | +0.0 | no | 1 (0.0%) |
| 2026-06-01..2026-06-20 | EMOLOS | V2b_p25_breakeven_floor | 10 | 10.0% | 0.0% | +10.0 pp | 125.7 | +89.0 | yes | 244 (9.0%) |
| 2026-06-01..2026-06-20 | EMOLOS | LB2_0_loss_budget | 5 | 0.0% | 0.0% | +0.0 pp | 36.7 | +0.0 | no | 0 (0.0%) |
| 2026-06-01..2026-06-20 | EMOLOS | LB3_0_loss_budget | 5 | 0.0% | 0.0% | +0.0 pp | 36.7 | +0.0 | no | 1 (0.0%) |
| 2026-06-01..2026-06-20 | Grandmix | V0_current | 4 | 0.0% | 0.0% | +0.0 pp | 4.0 | +0.0 | no | 0 (0.0%) |
| 2026-06-01..2026-06-20 | Grandmix | V1d_purchase_floor_half_winner | 4 | 0.0% | 0.0% | +0.0 pp | 4.0 | +0.0 | no | 24 (1.6%) |
| 2026-06-01..2026-06-20 | Grandmix | V2b_p25_breakeven_floor | 12 | 8.3% | 0.0% | +8.3 pp | 37.7 | +33.8 | no | 141 (9.2%) |
| 2026-06-01..2026-06-20 | Grandmix | LB2_0_loss_budget | 5 | 20.0% | 0.0% | +20.0 pp | 4.0 | +0.0 | no | 33 (2.1%) |
| 2026-06-01..2026-06-20 | Grandmix | LB3_0_loss_budget | 4 | 0.0% | 0.0% | +0.0 pp | 4.0 | +0.0 | no | 3 (0.2%) |
| 2026-06-01..2026-06-20 | IwaStore | V0_current | 2 | 50.0% | 50.0% | +0.0 pp | 0.7 | +0.0 | no | 0 (0.0%) |
| 2026-06-01..2026-06-20 | IwaStore | V1d_purchase_floor_half_winner | 1 | 100.0% | 50.0% | +50.0 pp | n/a | n/a | no | 5 (0.5%) |
| 2026-06-01..2026-06-20 | IwaStore | V2b_p25_breakeven_floor | 2 | 50.0% | 50.0% | +0.0 pp | 0.7 | -0.0 | no | 3 (0.3%) |
| 2026-06-01..2026-06-20 | IwaStore | LB2_0_loss_budget | 2 | 50.0% | 50.0% | +0.0 pp | 0.7 | +0.0 | no | 0 (0.0%) |
| 2026-06-01..2026-06-20 | IwaStore | LB3_0_loss_budget | 1 | 100.0% | 50.0% | +50.0 pp | n/a | n/a | no | 5 (0.5%) |
| 2026-06-01..2026-06-20 | TheSwaf | V0_current | 16 | 18.8% | 18.8% | +0.0 pp | 346.1 | +0.0 | yes | 0 (0.0%) |
| 2026-06-01..2026-06-20 | TheSwaf | V1d_purchase_floor_half_winner | 15 | 13.3% | 18.8% | -5.4 pp | 346.4 | +0.4 | yes | 9 (0.2%) |
| 2026-06-01..2026-06-20 | TheSwaf | V2b_p25_breakeven_floor | 24 | 12.5% | 18.8% | -6.3 pp | 444.1 | +98.1 | yes | 257 (6.2%) |
| 2026-06-01..2026-06-20 | TheSwaf | LB2_0_loss_budget | 15 | 13.3% | 18.8% | -5.4 pp | 346.4 | +0.4 | yes | 9 (0.2%) |
| 2026-06-01..2026-06-20 | TheSwaf | LB3_0_loss_budget | 12 | 8.3% | 18.8% | -10.4 pp | 330.8 | -15.3 | yes | 38 (0.9%) |

## Evidence Limits

- Window-seam double counting is possible. Episode dedup state is scoped to each input window; a creative whose cut-zone run crosses a boundary such as late January into early February can open one episode in each neighboring window. This affects only three seams here and is expected to be small, but it can slightly inflate episode totals.
- Pooled rates are known-weighted, not equal-weighted by window. Dec-Jan and Feb-Mar have longer spans than the June closed window, so aggregate rates can over-represent older regimes.
- V2b is more target-history-sensitive than the other tested variants because it uses breakEvenRoas/targetRoas. Historical target-pack changes are not reconstructed in this replay.

## Validation Notes

- Data ceiling is 2026-07-05; the current live source latest date observed in the prior phase was 2026-07-04, so the closed June decision window ends on 2026-06-20 for a 14-day outcome read.
- Unit of analysis remains cut episode, not daily row. Episode dedup requires a new cut run plus post-trigger spend before a new episode can open.
- Calibration is trailing 90d per replay day, but historical target packs are assumed fixed because the target/config tables expose the latest target pack state.
- This formula-level replay does not apply campaign-label guard, provider writes, DB writes, migrations, UI behavior, or resolver threshold changes.
- The multi-window evidence is still shadow evidence. It can justify the next controlled shadow parameter phase, not a direct unguarded production change.
