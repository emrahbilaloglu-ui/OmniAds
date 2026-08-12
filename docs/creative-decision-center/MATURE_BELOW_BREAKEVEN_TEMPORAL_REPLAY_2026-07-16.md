# Mature Below-Breakeven Temporal Replay - 2026-07-16

This is a SELECT-only historical formula simulation. It does not change the production resolver, provider state, live database state, thresholds, or operator behavior.

## Verdict

Status: review_only_reject_production_promotion

Reject production promotion from this lane alone. It can compare relative formula behavior, but current target packs are applied anachronistically, historical rows are creative-grain survivor data, and observational forward spend/ROAS is not a controlled pause counterfactual.

The useful conclusion is comparative, not causal: V2c tests a break-even recovery hold on top of V2b, while V2d tests one later-calendar-date confirmation for ratio cuts. Neither may be promoted from this legacy lane without exact point-in-time commercial and decision-input evidence.

## Read-Only Contract

- generatedAt: 2026-07-16T13:36:03.212Z
- gitSha: 848c61989eda26c83d52eb02a0710a3964d1b871
- isolation: repeatable read
- transaction readOnly: true
- statement timeout: 30000 ms
- application name: codex_f1_f2_temporal_breakeven_replay_final2
- terminal action: one ROLLBACK for the complete four-window suite; no COMMIT path
- integrity verification (run from the repository root): `shasum -a 256 -c docs/creative-decision-center/generated/mature-below-breakeven-temporal-replay-2026-07-16.sha256`

## Exact Account Scope

- EMOLOS: act_1054905059780305
- Grandmix: act_805150454596350
- IwaStore: act_1087566732415606
- TheSwaf: act_822913786458311

## Aggregate Across Four Requested Windows

| Scope | Variant | Episodes | Delta episodes vs V2b | 14d known/unknown | 14d early-cut | Delta early vs V2b | 14d true losers | Delta losers | 14d saved units | Delta units | 28d known/unknown | 28d early-cut | Delta early vs V2b | 28d true losers | Delta losers | 28d saved units | Delta units |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EMOLOS / act_1054905059780305 | V0_current | 90 | -29 | 70/20 | 10.0% | -4.7 pp | 54 | -28 | 289.52 | -167.43 | 70/20 | 10.0% | -5.6 pp | 59 | -24 | 423 | -130.3 |
| EMOLOS / act_1054905059780305 | V2b_p25_breakeven_floor | 119 | +0 | 109/10 | 14.7% | +0.0 pp | 82 | +0 | 456.95 | +0 | 109/10 | 15.6% | +0.0 pp | 83 | +0 | 553.3 | +0 |
| EMOLOS / act_1054905059780305 | V2c_breakeven_recent_hold | 126 | +7 | 116/10 | 15.5% | +0.8 pp | 87 | +5 | 476.97 | +20.02 | 116/10 | 12.9% | -2.7 pp | 91 | +8 | 654.71 | +101.41 |
| EMOLOS / act_1054905059780305 | V2d_breakeven_recent_hold_temporal_confirmation | 108 | -11 | 95/13 | 20.0% | +5.3 pp | 67 | -15 | 333.6 | -123.35 | 95/13 | 14.7% | -0.9 pp | 69 | -14 | 458.13 | -95.17 |
| Grandmix / act_805150454596350 | V0_current | 51 | -11 | 38/13 | 23.7% | +2.4 pp | 28 | -8 | 113.01 | -50.99 | 38/13 | 23.7% | +0.3 pp | 28 | -5 | 135.27 | -50.68 |
| Grandmix / act_805150454596350 | V2b_p25_breakeven_floor | 62 | +0 | 47/15 | 21.3% | +0.0 pp | 36 | +0 | 164 | +0 | 47/15 | 23.4% | +0.0 pp | 33 | +0 | 185.95 | +0 |
| Grandmix / act_805150454596350 | V2c_breakeven_recent_hold | 61 | -1 | 46/15 | 21.7% | +0.5 pp | 35 | -1 | 147.88 | -16.12 | 46/15 | 21.7% | -1.7 pp | 33 | +0 | 173.89 | -12.06 |
| Grandmix / act_805150454596350 | V2d_breakeven_recent_hold_temporal_confirmation | 46 | -16 | 33/13 | 18.2% | -3.1 pp | 27 | -9 | 103.71 | -60.29 | 34/12 | 20.6% | -2.8 pp | 27 | -6 | 117.47 | -68.48 |
| IwaStore / act_1087566732415606 | V0_current | 165 | -11 | 117/48 | 27.4% | +0.0 pp | 65 | -9 | 284.16 | -43.88 | 117/48 | 33.3% | -0.3 pp | 62 | -8 | 317.91 | -30.76 |
| IwaStore / act_1087566732415606 | V2b_p25_breakeven_floor | 176 | +0 | 128/48 | 27.3% | +0.0 pp | 74 | +0 | 328.04 | +0 | 128/48 | 33.6% | +0.0 pp | 70 | +0 | 348.67 | +0 |
| IwaStore / act_1087566732415606 | V2c_breakeven_recent_hold | 185 | +9 | 132/53 | 26.5% | -0.8 pp | 76 | +2 | 346.7 | +18.66 | 132/53 | 34.1% | +0.5 pp | 70 | +0 | 328.87 | -19.8 |
| IwaStore / act_1087566732415606 | V2d_breakeven_recent_hold_temporal_confirmation | 149 | -27 | 96/53 | 25.0% | -2.3 pp | 59 | -15 | 288.39 | -39.65 | 96/53 | 33.3% | -0.3 pp | 54 | -16 | 275.08 | -73.59 |
| TheSwaf / act_822913786458311 | V0_current | 140 | -33 | 108/32 | 16.7% | -2.1 pp | 82 | -20 | 1,036.4 | -265.57 | 109/31 | 11.9% | -2.0 pp | 83 | -19 | 1,177.49 | -637.49 |
| TheSwaf / act_822913786458311 | V2b_p25_breakeven_floor | 173 | +0 | 144/29 | 18.8% | +0.0 pp | 102 | +0 | 1,301.97 | +0 | 144/29 | 13.9% | +0.0 pp | 102 | +0 | 1,814.98 | +0 |
| TheSwaf / act_822913786458311 | V2c_breakeven_recent_hold | 180 | +7 | 145/35 | 17.9% | -0.8 pp | 103 | +1 | 1,613.52 | +311.55 | 145/35 | 15.2% | +1.3 pp | 102 | +0 | 1,773.19 | -41.79 |
| TheSwaf / act_822913786458311 | V2d_breakeven_recent_hold_temporal_confirmation | 151 | -22 | 106/45 | 20.8% | +2.0 pp | 76 | -26 | 920.11 | -381.86 | 106/45 | 17.0% | +3.1 pp | 78 | -24 | 1,339.11 | -475.87 |
| POOLED | V0_current | 446 | -84 | 333/113 | 19.8% | -0.7 pp | 229 | -65 | 1,723.09 | -527.87 | 334/112 | 20.4% | -0.9 pp | 232 | -56 | 2,053.67 | -849.23 |
| POOLED | V2b_p25_breakeven_floor | 530 | +0 | 428/102 | 20.6% | +0.0 pp | 294 | +0 | 2,250.96 | +0 | 428/102 | 21.3% | +0.0 pp | 288 | +0 | 2,902.9 | +0 |
| POOLED | V2c_breakeven_recent_hold | 552 | +22 | 439/113 | 20.3% | -0.3 pp | 301 | +7 | 2,585.07 | +334.11 | 439/113 | 21.0% | -0.3 pp | 296 | +8 | 2,930.66 | +27.76 |
| POOLED | V2d_breakeven_recent_hold_temporal_confirmation | 454 | -76 | 330/124 | 21.5% | +1.0 pp | 229 | -65 | 1,645.81 | -605.15 | 331/123 | 21.4% | +0.2 pp | 228 | -60 | 2,189.79 | -713.11 |

### True-Loser Precision And Wilson Lower Bound

True-loser precision is the share of known forward outcomes below explicit break-even. It is observational precision, not causal pause precision.

| Scope | Variant | 14d precision | 14d Wilson 95% lower | 28d precision | 28d Wilson 95% lower |
| --- | --- | ---: | ---: | ---: | ---: |
| EMOLOS / act_1054905059780305 | V0_current | 77.1% | 66.0% | 84.3% | 74.0% |
| EMOLOS / act_1054905059780305 | V2b_p25_breakeven_floor | 75.2% | 66.4% | 76.1% | 67.3% |
| EMOLOS / act_1054905059780305 | V2c_breakeven_recent_hold | 75.0% | 66.4% | 78.4% | 70.1% |
| EMOLOS / act_1054905059780305 | V2d_breakeven_recent_hold_temporal_confirmation | 70.5% | 60.7% | 72.6% | 62.9% |
| Grandmix / act_805150454596350 | V0_current | 73.7% | 58.0% | 73.7% | 58.0% |
| Grandmix / act_805150454596350 | V2b_p25_breakeven_floor | 76.6% | 62.8% | 70.2% | 56.0% |
| Grandmix / act_805150454596350 | V2c_breakeven_recent_hold | 76.1% | 62.1% | 71.7% | 57.5% |
| Grandmix / act_805150454596350 | V2d_breakeven_recent_hold_temporal_confirmation | 81.8% | 65.6% | 79.4% | 63.2% |
| IwaStore / act_1087566732415606 | V0_current | 55.6% | 46.5% | 53.0% | 44.0% |
| IwaStore / act_1087566732415606 | V2b_p25_breakeven_floor | 57.8% | 49.1% | 54.7% | 46.1% |
| IwaStore / act_1087566732415606 | V2c_breakeven_recent_hold | 57.6% | 49.0% | 53.0% | 44.5% |
| IwaStore / act_1087566732415606 | V2d_breakeven_recent_hold_temporal_confirmation | 61.5% | 51.5% | 56.3% | 46.3% |
| TheSwaf / act_822913786458311 | V0_current | 75.9% | 67.1% | 76.1% | 67.3% |
| TheSwaf / act_822913786458311 | V2b_p25_breakeven_floor | 70.8% | 62.9% | 70.8% | 62.9% |
| TheSwaf / act_822913786458311 | V2c_breakeven_recent_hold | 71.0% | 63.2% | 70.3% | 62.5% |
| TheSwaf / act_822913786458311 | V2d_breakeven_recent_hold_temporal_confirmation | 71.7% | 62.5% | 73.6% | 64.5% |
| POOLED | V0_current | 68.8% | 63.6% | 69.5% | 64.3% |
| POOLED | V2b_p25_breakeven_floor | 68.7% | 64.1% | 67.3% | 62.7% |
| POOLED | V2c_breakeven_recent_hold | 68.6% | 64.1% | 67.4% | 62.9% |
| POOLED | V2d_breakeven_recent_hold_temporal_confirmation | 69.4% | 64.2% | 68.9% | 63.7% |

### V2c Direction Consistency By Account And Window

- V0 to V2c 14d: early-cut improved/worse/tied/unavailable = 5/9/2/0; saved units improved/worse/tied/unavailable = 12/3/1/0.
- V0 to V2c 28d: early-cut improved/worse/tied/unavailable = 5/8/3/0; saved units improved/worse/tied/unavailable = 11/4/1/0.
- V2b to V2c 14d: early-cut improved/worse/tied/unavailable = 6/4/6/0; saved units improved/worse/tied/unavailable = 7/6/3/0.
- V2b to V2c 28d: early-cut improved/worse/tied/unavailable = 5/6/5/0; saved units improved/worse/tied/unavailable = 8/5/3/0.

| Window | Business/account | V0 to V2c episodes | V2b to V2c episodes | V0 to V2c 14d early | V2b to V2c 14d early | V0 to V2c 14d units | V2b to V2c 14d units | V0 to V2c 28d early | V2b to V2c 28d early | V0 to V2c 28d units | V2b to V2c 28d units |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2025-12_to_2026-01 | EMOLOS / act_1054905059780305 | +19 | +4 | +0.0 pp | -0.8 pp | +11.28 | +12.76 | +0.0 pp | -6.0 pp | +31.41 | +23.2 |
| 2025-12_to_2026-01 | Grandmix / act_805150454596350 | +2 | +0 | +25.0 pp | +25.0 pp | -8.81 | -12.83 | +25.0 pp | +25.0 pp | -8.81 | -12.83 |
| 2025-12_to_2026-01 | IwaStore / act_1087566732415606 | +7 | +2 | -7.1 pp | -2.5 pp | +51.01 | +18.43 | -4.7 pp | +1.1 pp | +1.56 | -16.2 |
| 2025-12_to_2026-01 | TheSwaf / act_822913786458311 | +8 | +2 | +15.3 pp | -5.5 pp | +224.13 | +326.78 | +30.4 pp | +2.7 pp | -32.33 | -23.01 |
| 2026-02_to_2026-03 | EMOLOS / act_1054905059780305 | +13 | +1 | +6.9 pp | -0.4 pp | +75.3 | +7.86 | +1.4 pp | -3.6 pp | +89.81 | +73.72 |
| 2026-02_to_2026-03 | Grandmix / act_805150454596350 | -1 | -1 | -3.6 pp | -3.6 pp | +0 | +0 | -3.6 pp | -3.6 pp | +0 | +0 |
| 2026-02_to_2026-03 | IwaStore / act_1087566732415606 | +10 | +7 | +3.4 pp | +0.1 pp | -0.93 | +3.6 | +3.4 pp | +0.1 pp | -3.69 | +3.64 |
| 2026-02_to_2026-03 | TheSwaf / act_822913786458311 | +7 | +0 | +1.1 pp | +0.0 pp | +9.08 | +2.66 | -0.4 pp | +0.0 pp | +14.24 | +3.25 |
| 2026-04_to_2026-05 | EMOLOS / act_1054905059780305 | +4 | +1 | +3.1 pp | +3.1 pp | +41.21 | -0.8 | +0.0 pp | +0.0 pp | +50.83 | +4.29 |
| 2026-04_to_2026-05 | Grandmix / act_805150454596350 | +4 | +0 | +2.8 pp | +0.0 pp | +19.42 | -0.2 | +2.8 pp | +0.0 pp | +23.55 | +0.19 |
| 2026-04_to_2026-05 | IwaStore / act_1087566732415606 | +2 | +0 | -0.8 pp | +1.5 pp | +12.5 | -3.37 | +4.8 pp | +1.8 pp | +13.1 | -7.24 |
| 2026-04_to_2026-05 | TheSwaf / act_822913786458311 | +23 | +3 | -1.9 pp | +0.0 pp | +271.63 | -17.89 | -3.4 pp | +1.5 pp | +502.47 | -22.03 |
| 2026-06 | EMOLOS / act_1054905059780305 | +0 | +1 | +7.1 pp | -0.5 pp | +59.66 | +0.2 | +7.1 pp | -0.5 pp | +59.66 | +0.2 |
| 2026-06 | Grandmix / act_805150454596350 | +5 | +0 | +0.0 pp | +0.0 pp | +24.26 | -3.09 | +0.0 pp | -14.3 pp | +23.88 | +0.58 |
| 2026-06 | IwaStore / act_1087566732415606 | +1 | +0 | +33.3 pp | +0.0 pp | -0.04 | +0 | +33.3 pp | +0.0 pp | -0.01 | +0 |
| 2026-06 | TheSwaf / act_822913786458311 | +2 | +2 | -2.0 pp | +0.0 pp | +72.28 | +0 | -1.1 pp | +0.0 pp | +111.32 | +0 |

### V2d Is Not Production D036

V2d is a standalone historical sensitivity: it confirms only ratio-based Cuts and intentionally leaves zero-conversion/maturity-severe safety branches immediate. Production D036 governs entry into every hard action using persisted prior-epoch evaluation state. Composing V2d with D036 would double-count confirmation and could add an unintended extra delay; V2d must never be layered on top of D036 as a second calculator.
V2d also changes episode boundaries: a pending day followed by a confirmed day, recovery interruption, or window edge can create more counted episodes while reducing known-outcome coverage. Its episode and unknown counts are therefore part of the rejection evidence, not a lift claim.

## Focus Creative Identity History

These rows bind the requested current exact-Ad identities only to their persisted creative IDs. They do not pretend that a creative-grain historical row is an immutable exact-Ad input.

Current exact-Ad binding was cross-checked against `native-ad-account-aov-authority-replay-query-proof-2026-07-16.json` (SHA-256 `2f1d87b5eed96b44b4cd910678ed032dc638995f622f075721a424943ecb1970`); both rows had matching recomputed input/decision hashes and valid canonical snapshot envelopes:

- `120247018755120316` -> `2533787297105379` / `Claude-BathroomMeta`: current 28d spend `1171.81`, 11 purchases, ROAS `1.6129`, target `2.20`, break-even `1.80`; current calibrated-P25 path publishes `Keep` with a demote-candidate warning. The closed June creative history gives V0 zero Cut days but V2b/V2c 13 published Cut days, zero 14d/28d above-target recovery, and 5.42/10.19 observational saved-spend units.
- `120249371633480316` -> `1008549465472004` / `BathroomMeta-Shipping`: current 28d spend `796.33`, 4 purchases, ROAS `1.0013`, target `2.20`, break-even `1.80`; current calibrated-P25 path also publishes `Keep` with a demote-candidate warning. The closed June creative history gives V0 zero Cut days but V2b/V2c two published Cut days, zero 14d/28d above-target recovery, and 7.06/15.21 observational saved-spend units.

These examples support evaluating a below-break-even expansion, but they do not distinguish V2c from V2b: neither creative had a sufficient recent-7d recovery at or above break-even during its historical Cut days. They therefore cannot rescue V2c's inconsistent 16-cell aggregate result.

| Window | Business/account | Creative | Variant | Daily rows | Raw Cut days | Published Cut days | Pending days | Recovery-hold days | First published | Last published | Episodes | 14d early | 14d saved units | 28d early | 28d saved units |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 2026-04_to_2026-05 | Grandmix / act_805150454596350 | Claude-BathroomMeta (2533787297105379) | V0_current | 12 | 0 | 0 | 0 | 0 | n/a | n/a | 0 | n/a | n/a | n/a | n/a |
| 2026-04_to_2026-05 | Grandmix / act_805150454596350 | Claude-BathroomMeta (2533787297105379) | V2b_p25_breakeven_floor | 12 | 0 | 0 | 0 | 0 | n/a | n/a | 0 | n/a | n/a | n/a | n/a |
| 2026-04_to_2026-05 | Grandmix / act_805150454596350 | Claude-BathroomMeta (2533787297105379) | V2c_breakeven_recent_hold | 12 | 0 | 0 | 0 | 0 | n/a | n/a | 0 | n/a | n/a | n/a | n/a |
| 2026-04_to_2026-05 | Grandmix / act_805150454596350 | Claude-BathroomMeta (2533787297105379) | V2d_breakeven_recent_hold_temporal_confirmation | 12 | 0 | 0 | 0 | 0 | n/a | n/a | 0 | n/a | n/a | n/a | n/a |
| 2026-06 | Grandmix / act_805150454596350 | Claude-BathroomMeta (2533787297105379) | V0_current | 18 | 0 | 0 | 0 | 0 | n/a | n/a | 0 | n/a | n/a | n/a | n/a |
| 2026-06 | Grandmix / act_805150454596350 | Claude-BathroomMeta (2533787297105379) | V2b_p25_breakeven_floor | 18 | 13 | 13 | 0 | 0 | 2026-06-06 | 2026-06-18 | 1 | 0.0% | 5.42 | 0.0% | 10.19 |
| 2026-06 | Grandmix / act_805150454596350 | Claude-BathroomMeta (2533787297105379) | V2c_breakeven_recent_hold | 18 | 13 | 13 | 0 | 0 | 2026-06-06 | 2026-06-18 | 1 | 0.0% | 5.42 | 0.0% | 10.19 |
| 2026-06 | Grandmix / act_805150454596350 | Claude-BathroomMeta (2533787297105379) | V2d_breakeven_recent_hold_temporal_confirmation | 18 | 13 | 12 | 1 | 0 | 2026-06-07 | 2026-06-18 | 1 | 0.0% | 5.46 | 0.0% | 10.62 |
| 2026-06 | Grandmix / act_805150454596350 | BathroomMeta-Shipping (1008549465472004) | V0_current | 13 | 0 | 0 | 0 | 0 | n/a | n/a | 0 | n/a | n/a | n/a | n/a |
| 2026-06 | Grandmix / act_805150454596350 | BathroomMeta-Shipping (1008549465472004) | V2b_p25_breakeven_floor | 13 | 2 | 2 | 0 | 0 | 2026-06-11 | 2026-06-14 | 2 | 0.0% | 7.06 | 0.0% | 15.21 |
| 2026-06 | Grandmix / act_805150454596350 | BathroomMeta-Shipping (1008549465472004) | V2c_breakeven_recent_hold | 13 | 2 | 2 | 0 | 0 | 2026-06-11 | 2026-06-14 | 2 | 0.0% | 7.06 | 0.0% | 15.21 |
| 2026-06 | Grandmix / act_805150454596350 | BathroomMeta-Shipping (1008549465472004) | V2d_breakeven_recent_hold_temporal_confirmation | 13 | 2 | 0 | 2 | 0 | n/a | n/a | 0 | n/a | n/a | n/a | n/a |

## December 2025 - January 2026

Requested window: 2025-12-01 to 2026-01-31.

| Scope | Variant | Episodes | Delta episodes vs V2b | 14d known/unknown | 14d early-cut | Delta early vs V2b | 14d true losers | Delta losers | 14d saved units | Delta units | 28d known/unknown | 28d early-cut | Delta early vs V2b | 28d true losers | Delta losers | 28d saved units | Delta units |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EMOLOS / act_1054905059780305 (2025-12-01..2026-01-31) | V0_current | 19 | -15 | 19/0 | 31.6% | -0.8 pp | 11 | -7 | 48.21 | +1.48 | 19/0 | 26.3% | -6.0 pp | 12 | -7 | 76.15 | -8.21 |
| EMOLOS / act_1054905059780305 (2025-12-01..2026-01-31) | V2b_p25_breakeven_floor | 34 | +0 | 34/0 | 32.4% | +0.0 pp | 18 | +0 | 46.73 | +0 | 34/0 | 32.4% | +0.0 pp | 19 | +0 | 84.36 | +0 |
| EMOLOS / act_1054905059780305 (2025-12-01..2026-01-31) | V2c_breakeven_recent_hold | 38 | +4 | 38/0 | 31.6% | -0.8 pp | 22 | +4 | 59.49 | +12.76 | 38/0 | 26.3% | -6.0 pp | 23 | +4 | 107.56 | +23.2 |
| EMOLOS / act_1054905059780305 (2025-12-01..2026-01-31) | V2d_breakeven_recent_hold_temporal_confirmation | 31 | -3 | 31/0 | 35.5% | +3.1 pp | 17 | -1 | 45.2 | -1.53 | 31/0 | 25.8% | -6.5 pp | 17 | -2 | 68.33 | -16.03 |
| Grandmix / act_805150454596350 (2025-12-01..2026-01-31) | V0_current | 7 | -2 | 1/6 | 0.0% | +0.0 pp | 1 | -2 | 12.17 | -4.02 | 1/6 | 0.0% | +0.0 pp | 1 | -2 | 12.17 | -4.02 |
| Grandmix / act_805150454596350 (2025-12-01..2026-01-31) | V2b_p25_breakeven_floor | 9 | +0 | 4/5 | 0.0% | +0.0 pp | 3 | +0 | 16.19 | +0 | 4/5 | 0.0% | +0.0 pp | 3 | +0 | 16.19 | +0 |
| Grandmix / act_805150454596350 (2025-12-01..2026-01-31) | V2c_breakeven_recent_hold | 9 | +0 | 4/5 | 25.0% | +25.0 pp | 2 | -1 | 3.36 | -12.83 | 4/5 | 25.0% | +25.0 pp | 2 | -1 | 3.36 | -12.83 |
| Grandmix / act_805150454596350 (2025-12-01..2026-01-31) | V2d_breakeven_recent_hold_temporal_confirmation | 5 | -4 | 2/3 | 50.0% | +50.0 pp | 1 | -2 | 2.46 | -13.73 | 3/2 | 33.3% | +33.3 pp | 2 | -1 | 2.73 | -13.46 |
| IwaStore / act_1087566732415606 (2025-12-01..2026-01-31) | V0_current | 56 | -5 | 48/8 | 35.4% | +4.7 pp | 21 | -4 | 181.01 | -32.58 | 48/8 | 50.0% | +5.8 pp | 16 | -4 | 179.66 | -17.76 |
| IwaStore / act_1087566732415606 (2025-12-01..2026-01-31) | V2b_p25_breakeven_floor | 61 | +0 | 52/9 | 30.8% | +0.0 pp | 25 | +0 | 213.59 | +0 | 52/9 | 44.2% | +0.0 pp | 20 | +0 | 197.42 | +0 |
| IwaStore / act_1087566732415606 (2025-12-01..2026-01-31) | V2c_breakeven_recent_hold | 63 | +2 | 53/10 | 28.3% | -2.5 pp | 25 | +0 | 232.02 | +18.43 | 53/10 | 45.3% | +1.1 pp | 18 | -2 | 181.22 | -16.2 |
| IwaStore / act_1087566732415606 (2025-12-01..2026-01-31) | V2d_breakeven_recent_hold_temporal_confirmation | 47 | -14 | 39/8 | 28.2% | -2.6 pp | 19 | -6 | 194.86 | -18.73 | 39/8 | 51.3% | +7.0 pp | 15 | -5 | 170.75 | -26.67 |
| TheSwaf / act_822913786458311 (2025-12-01..2026-01-31) | V0_current | 18 | -6 | 18/0 | 16.7% | -20.8 pp | 12 | -1 | 303.95 | +102.65 | 18/0 | 5.6% | -27.8 pp | 12 | +1 | 233.94 | +9.32 |
| TheSwaf / act_822913786458311 (2025-12-01..2026-01-31) | V2b_p25_breakeven_floor | 24 | +0 | 24/0 | 37.5% | +0.0 pp | 13 | +0 | 201.3 | +0 | 24/0 | 33.3% | +0.0 pp | 11 | +0 | 224.62 | +0 |
| TheSwaf / act_822913786458311 (2025-12-01..2026-01-31) | V2c_breakeven_recent_hold | 26 | +2 | 25/1 | 32.0% | -5.5 pp | 13 | +0 | 528.08 | +326.78 | 25/1 | 36.0% | +2.7 pp | 10 | -1 | 201.61 | -23.01 |
| TheSwaf / act_822913786458311 (2025-12-01..2026-01-31) | V2d_breakeven_recent_hold_temporal_confirmation | 17 | -7 | 17/0 | 35.3% | -2.2 pp | 7 | -6 | 55.35 | -145.95 | 17/0 | 23.5% | -9.8 pp | 8 | -3 | 130.12 | -94.5 |
| POOLED | V0_current | 100 | -28 | 86/14 | 30.2% | -1.4 pp | 45 | -14 | 545.34 | +67.53 | 86/14 | 34.9% | -2.0 pp | 41 | -12 | 501.92 | -20.67 |
| POOLED | V2b_p25_breakeven_floor | 128 | +0 | 114/14 | 31.6% | +0.0 pp | 59 | +0 | 477.81 | +0 | 114/14 | 36.8% | +0.0 pp | 53 | +0 | 522.59 | +0 |
| POOLED | V2c_breakeven_recent_hold | 136 | +8 | 120/16 | 30.0% | -1.6 pp | 62 | +3 | 822.95 | +345.14 | 120/16 | 36.7% | -0.2 pp | 53 | +0 | 493.75 | -28.84 |
| POOLED | V2d_breakeven_recent_hold_temporal_confirmation | 100 | -28 | 89/11 | 32.6% | +1.0 pp | 44 | -15 | 297.87 | -179.94 | 90/10 | 36.7% | -0.2 pp | 42 | -11 | 371.93 | -150.66 |

## February - March 2026

Requested window: 2026-02-01 to 2026-03-31.

| Scope | Variant | Episodes | Delta episodes vs V2b | 14d known/unknown | 14d early-cut | Delta early vs V2b | 14d true losers | Delta losers | 14d saved units | Delta units | 28d known/unknown | 28d early-cut | Delta early vs V2b | 28d true losers | Delta losers | 28d saved units | Delta units |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EMOLOS / act_1054905059780305 (2026-02-01..2026-03-31) | V0_current | 26 | -12 | 18/8 | 5.6% | -7.3 pp | 11 | -11 | 29.6 | -67.44 | 18/8 | 11.1% | -5.0 pp | 15 | -7 | 132.15 | -16.09 |
| EMOLOS / act_1054905059780305 (2026-02-01..2026-03-31) | V2b_p25_breakeven_floor | 38 | +0 | 31/7 | 12.9% | +0.0 pp | 22 | +0 | 97.04 | +0 | 31/7 | 16.1% | +0.0 pp | 22 | +0 | 148.24 | +0 |
| EMOLOS / act_1054905059780305 (2026-02-01..2026-03-31) | V2c_breakeven_recent_hold | 39 | +1 | 32/7 | 12.5% | -0.4 pp | 22 | +0 | 104.9 | +7.86 | 32/7 | 12.5% | -3.6 pp | 24 | +2 | 221.96 | +73.72 |
| EMOLOS / act_1054905059780305 (2026-02-01..2026-03-31) | V2d_breakeven_recent_hold_temporal_confirmation | 31 | -7 | 24/7 | 25.0% | +12.1 pp | 15 | -7 | 56.7 | -40.34 | 24/7 | 20.8% | +4.7 pp | 16 | -6 | 149.12 | +0.88 |
| Grandmix / act_805150454596350 (2026-02-01..2026-03-31) | V0_current | 9 | +0 | 8/1 | 75.0% | +0.0 pp | 2 | +0 | 1.26 | +0 | 8/1 | 75.0% | +0.0 pp | 2 | +0 | 4.78 | +0 |
| Grandmix / act_805150454596350 (2026-02-01..2026-03-31) | V2b_p25_breakeven_floor | 9 | +0 | 8/1 | 75.0% | +0.0 pp | 2 | +0 | 1.26 | +0 | 8/1 | 75.0% | +0.0 pp | 2 | +0 | 4.78 | +0 |
| Grandmix / act_805150454596350 (2026-02-01..2026-03-31) | V2c_breakeven_recent_hold | 8 | -1 | 7/1 | 71.4% | -3.6 pp | 2 | +0 | 1.26 | +0 | 7/1 | 71.4% | -3.6 pp | 2 | +0 | 4.78 | +0 |
| Grandmix / act_805150454596350 (2026-02-01..2026-03-31) | V2d_breakeven_recent_hold_temporal_confirmation | 6 | -3 | 5/1 | 80.0% | +5.0 pp | 1 | -1 | 1 | -0.26 | 5/1 | 80.0% | +5.0 pp | 1 | -1 | 2.87 | -1.91 |
| IwaStore / act_1087566732415606 (2026-02-01..2026-03-31) | V0_current | 75 | -3 | 53/22 | 20.8% | -3.3 pp | 33 | -2 | 86.2 | +4.53 | 53/22 | 20.8% | -3.3 pp | 35 | -1 | 110.23 | +7.33 |
| IwaStore / act_1087566732415606 (2026-02-01..2026-03-31) | V2b_p25_breakeven_floor | 78 | +0 | 54/24 | 24.1% | +0.0 pp | 35 | +0 | 81.67 | +0 | 54/24 | 24.1% | +0.0 pp | 36 | +0 | 102.9 | +0 |
| IwaStore / act_1087566732415606 (2026-02-01..2026-03-31) | V2c_breakeven_recent_hold | 85 | +7 | 58/27 | 24.1% | +0.1 pp | 38 | +3 | 85.27 | +3.6 | 58/27 | 24.1% | +0.1 pp | 39 | +3 | 106.54 | +3.64 |
| IwaStore / act_1087566732415606 (2026-02-01..2026-03-31) | V2d_breakeven_recent_hold_temporal_confirmation | 71 | -7 | 40/31 | 22.5% | -1.6 pp | 27 | -8 | 66.26 | -15.41 | 40/31 | 20.0% | -4.1 pp | 27 | -9 | 69.25 | -33.65 |
| TheSwaf / act_822913786458311 (2026-02-01..2026-03-31) | V0_current | 17 | -7 | 14/3 | 35.7% | -1.1 pp | 9 | -2 | 13.24 | -6.42 | 14/3 | 21.4% | +0.4 pp | 8 | -2 | 16.89 | -10.99 |
| TheSwaf / act_822913786458311 (2026-02-01..2026-03-31) | V2b_p25_breakeven_floor | 24 | +0 | 19/5 | 36.8% | +0.0 pp | 11 | +0 | 19.66 | +0 | 19/5 | 21.1% | +0.0 pp | 10 | +0 | 27.88 | +0 |
| TheSwaf / act_822913786458311 (2026-02-01..2026-03-31) | V2c_breakeven_recent_hold | 24 | +0 | 19/5 | 36.8% | +0.0 pp | 12 | +1 | 22.32 | +2.66 | 19/5 | 21.1% | +0.0 pp | 11 | +1 | 31.13 | +3.25 |
| TheSwaf / act_822913786458311 (2026-02-01..2026-03-31) | V2d_breakeven_recent_hold_temporal_confirmation | 17 | -7 | 10/7 | 20.0% | -16.8 pp | 8 | -3 | 12.32 | -7.34 | 10/7 | 10.0% | -11.1 pp | 8 | -2 | 18.74 | -9.14 |
| POOLED | V0_current | 127 | -22 | 93/34 | 24.7% | -2.1 pp | 55 | -15 | 130.3 | -69.33 | 93/34 | 23.7% | -1.3 pp | 60 | -10 | 264.05 | -19.75 |
| POOLED | V2b_p25_breakeven_floor | 149 | +0 | 112/37 | 26.8% | +0.0 pp | 70 | +0 | 199.63 | +0 | 112/37 | 25.0% | +0.0 pp | 70 | +0 | 283.8 | +0 |
| POOLED | V2c_breakeven_recent_hold | 156 | +7 | 116/40 | 25.9% | -0.9 pp | 74 | +4 | 213.75 | +14.12 | 116/40 | 23.3% | -1.7 pp | 76 | +6 | 364.41 | +80.61 |
| POOLED | V2d_breakeven_recent_hold_temporal_confirmation | 125 | -24 | 79/46 | 26.6% | -0.2 pp | 51 | -19 | 136.28 | -63.35 | 79/46 | 22.8% | -2.2 pp | 52 | -18 | 239.98 | -43.82 |

## April - May 2026

Requested window: 2026-04-01 to 2026-05-31.

| Scope | Variant | Episodes | Delta episodes vs V2b | 14d known/unknown | 14d early-cut | Delta early vs V2b | 14d true losers | Delta losers | 14d saved units | Delta units | 28d known/unknown | 28d early-cut | Delta early vs V2b | 28d true losers | Delta losers | 28d saved units | Delta units |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EMOLOS / act_1054905059780305 (2026-04-01..2026-05-31) | V0_current | 31 | -3 | 25/6 | 0.0% | +0.0 pp | 25 | -6 | 163.75 | -42.01 | 25/6 | 0.0% | +0.0 pp | 25 | -6 | 166.74 | -46.54 |
| EMOLOS / act_1054905059780305 (2026-04-01..2026-05-31) | V2b_p25_breakeven_floor | 34 | +0 | 31/3 | 0.0% | +0.0 pp | 31 | +0 | 205.76 | +0 | 31/3 | 0.0% | +0.0 pp | 31 | +0 | 213.28 | +0 |
| EMOLOS / act_1054905059780305 (2026-04-01..2026-05-31) | V2c_breakeven_recent_hold | 35 | +1 | 32/3 | 3.1% | +3.1 pp | 31 | +0 | 204.96 | -0.8 | 32/3 | 0.0% | +0.0 pp | 32 | +1 | 217.57 | +4.29 |
| EMOLOS / act_1054905059780305 (2026-04-01..2026-05-31) | V2d_breakeven_recent_hold_temporal_confirmation | 33 | -1 | 28/5 | 3.6% | +3.6 pp | 26 | -5 | 160.31 | -45.45 | 28/5 | 0.0% | +0.0 pp | 27 | -4 | 169.29 | -43.99 |
| Grandmix / act_805150454596350 (2026-04-01..2026-05-31) | V0_current | 31 | -4 | 26/5 | 11.5% | -2.8 pp | 23 | -1 | 97.19 | -19.62 | 26/5 | 11.5% | -2.8 pp | 22 | -1 | 98.36 | -23.36 |
| Grandmix / act_805150454596350 (2026-04-01..2026-05-31) | V2b_p25_breakeven_floor | 35 | +0 | 28/7 | 14.3% | +0.0 pp | 24 | +0 | 116.81 | +0 | 28/7 | 14.3% | +0.0 pp | 23 | +0 | 121.72 | +0 |
| Grandmix / act_805150454596350 (2026-04-01..2026-05-31) | V2c_breakeven_recent_hold | 35 | +0 | 28/7 | 14.3% | +0.0 pp | 24 | +0 | 116.61 | -0.2 | 28/7 | 14.3% | +0.0 pp | 23 | +0 | 121.91 | +0.19 |
| Grandmix / act_805150454596350 (2026-04-01..2026-05-31) | V2d_breakeven_recent_hold_temporal_confirmation | 28 | -7 | 21/7 | 4.8% | -9.5 pp | 20 | -4 | 78.27 | -38.54 | 21/7 | 9.5% | -4.8 pp | 19 | -4 | 82.57 | -39.15 |
| IwaStore / act_1087566732415606 (2026-04-01..2026-05-31) | V0_current | 32 | -2 | 14/18 | 28.6% | +2.3 pp | 9 | -3 | 15.42 | -15.87 | 14/18 | 28.6% | -3.0 pp | 9 | -3 | 25.92 | -20.34 |
| IwaStore / act_1087566732415606 (2026-04-01..2026-05-31) | V2b_p25_breakeven_floor | 34 | +0 | 19/15 | 26.3% | +0.0 pp | 12 | +0 | 31.29 | +0 | 19/15 | 31.6% | +0.0 pp | 12 | +0 | 46.26 | +0 |
| IwaStore / act_1087566732415606 (2026-04-01..2026-05-31) | V2c_breakeven_recent_hold | 34 | +0 | 18/16 | 27.8% | +1.5 pp | 11 | -1 | 27.92 | -3.37 | 18/16 | 33.3% | +1.8 pp | 11 | -1 | 39.02 | -7.24 |
| IwaStore / act_1087566732415606 (2026-04-01..2026-05-31) | V2d_breakeven_recent_hold_temporal_confirmation | 29 | -5 | 15/14 | 26.7% | +0.4 pp | 11 | -1 | 25.74 | -5.55 | 15/14 | 26.7% | -4.9 pp | 10 | -2 | 32.98 | -13.28 |
| TheSwaf / act_822913786458311 (2026-04-01..2026-05-31) | V0_current | 63 | -20 | 46/17 | 10.9% | +1.9 pp | 38 | -14 | 377.93 | -289.52 | 46/17 | 10.9% | +4.9 pp | 38 | -15 | 444.91 | -524.5 |
| TheSwaf / act_822913786458311 (2026-04-01..2026-05-31) | V2b_p25_breakeven_floor | 83 | +0 | 67/16 | 9.0% | +0.0 pp | 52 | +0 | 667.45 | +0 | 67/16 | 6.0% | +0.0 pp | 53 | +0 | 969.41 | +0 |
| TheSwaf / act_822913786458311 (2026-04-01..2026-05-31) | V2c_breakeven_recent_hold | 86 | +3 | 67/19 | 9.0% | +0.0 pp | 52 | +0 | 649.56 | -17.89 | 67/19 | 7.5% | +1.5 pp | 53 | +0 | 947.38 | -22.03 |
| TheSwaf / act_822913786458311 (2026-04-01..2026-05-31) | V2d_breakeven_recent_hold_temporal_confirmation | 73 | -10 | 50/23 | 16.0% | +7.0 pp | 38 | -14 | 462.82 | -204.63 | 50/23 | 16.0% | +10.0 pp | 39 | -14 | 657.72 | -311.69 |
| POOLED | V0_current | 157 | -29 | 111/46 | 10.8% | +0.5 pp | 95 | -24 | 654.29 | -367.02 | 111/46 | 10.8% | +1.1 pp | 94 | -25 | 735.93 | -614.74 |
| POOLED | V2b_p25_breakeven_floor | 186 | +0 | 145/41 | 10.3% | +0.0 pp | 119 | +0 | 1,021.31 | +0 | 145/41 | 9.7% | +0.0 pp | 119 | +0 | 1,350.67 | +0 |
| POOLED | V2c_breakeven_recent_hold | 190 | +4 | 145/45 | 11.0% | +0.7 pp | 118 | -1 | 999.05 | -22.26 | 145/45 | 10.3% | +0.7 pp | 119 | +0 | 1,325.88 | -24.79 |
| POOLED | V2d_breakeven_recent_hold_temporal_confirmation | 163 | -23 | 114/49 | 12.3% | +1.9 pp | 95 | -24 | 727.14 | -294.17 | 114/49 | 12.3% | +2.6 pp | 95 | -24 | 942.56 | -408.11 |

## June 2026

Requested window: 2026-06-01 to 2026-06-30.

| Scope | Variant | Episodes | Delta episodes vs V2b | 14d known/unknown | 14d early-cut | Delta early vs V2b | 14d true losers | Delta losers | 14d saved units | Delta units | 28d known/unknown | 28d early-cut | Delta early vs V2b | 28d true losers | Delta losers | 28d saved units | Delta units |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EMOLOS / act_1054905059780305 (2026-06-01..2026-06-18) | V0_current | 14 | +1 | 8/6 | 0.0% | -7.7 pp | 7 | -4 | 47.96 | -59.46 | 8/6 | 0.0% | -7.7 pp | 7 | -4 | 47.96 | -59.46 |
| EMOLOS / act_1054905059780305 (2026-06-01..2026-06-18) | V2b_p25_breakeven_floor | 13 | +0 | 13/0 | 7.7% | +0.0 pp | 11 | +0 | 107.42 | +0 | 13/0 | 7.7% | +0.0 pp | 11 | +0 | 107.42 | +0 |
| EMOLOS / act_1054905059780305 (2026-06-01..2026-06-18) | V2c_breakeven_recent_hold | 14 | +1 | 14/0 | 7.1% | -0.5 pp | 12 | +1 | 107.62 | +0.2 | 14/0 | 7.1% | -0.5 pp | 12 | +1 | 107.62 | +0.2 |
| EMOLOS / act_1054905059780305 (2026-06-01..2026-06-18) | V2d_breakeven_recent_hold_temporal_confirmation | 13 | +0 | 12/1 | 8.3% | +0.6 pp | 9 | -2 | 71.39 | -36.03 | 12/1 | 8.3% | +0.6 pp | 9 | -2 | 71.39 | -36.03 |
| Grandmix / act_805150454596350 (2026-06-01..2026-06-18) | V0_current | 4 | -5 | 3/1 | 0.0% | +0.0 pp | 2 | -5 | 2.39 | -27.35 | 3/1 | 0.0% | -14.3 pp | 3 | -2 | 19.96 | -23.3 |
| Grandmix / act_805150454596350 (2026-06-01..2026-06-18) | V2b_p25_breakeven_floor | 9 | +0 | 7/2 | 0.0% | +0.0 pp | 7 | +0 | 29.74 | +0 | 7/2 | 14.3% | +0.0 pp | 5 | +0 | 43.26 | +0 |
| Grandmix / act_805150454596350 (2026-06-01..2026-06-18) | V2c_breakeven_recent_hold | 9 | +0 | 7/2 | 0.0% | +0.0 pp | 7 | +0 | 26.65 | -3.09 | 7/2 | 0.0% | -14.3 pp | 6 | +1 | 43.84 | +0.58 |
| Grandmix / act_805150454596350 (2026-06-01..2026-06-18) | V2d_breakeven_recent_hold_temporal_confirmation | 7 | -2 | 5/2 | 0.0% | +0.0 pp | 5 | -2 | 21.98 | -7.76 | 5/2 | 0.0% | -14.3 pp | 5 | +0 | 29.3 | -13.96 |
| IwaStore / act_1087566732415606 (2026-06-01..2026-06-18) | V0_current | 2 | -1 | 2/0 | 0.0% | -33.3 pp | 2 | +0 | 1.53 | +0.04 | 2/0 | 0.0% | -33.3 pp | 2 | +0 | 2.1 | +0.01 |
| IwaStore / act_1087566732415606 (2026-06-01..2026-06-18) | V2b_p25_breakeven_floor | 3 | +0 | 3/0 | 33.3% | +0.0 pp | 2 | +0 | 1.49 | +0 | 3/0 | 33.3% | +0.0 pp | 2 | +0 | 2.09 | +0 |
| IwaStore / act_1087566732415606 (2026-06-01..2026-06-18) | V2c_breakeven_recent_hold | 3 | +0 | 3/0 | 33.3% | +0.0 pp | 2 | +0 | 1.49 | +0 | 3/0 | 33.3% | +0.0 pp | 2 | +0 | 2.09 | +0 |
| IwaStore / act_1087566732415606 (2026-06-01..2026-06-18) | V2d_breakeven_recent_hold_temporal_confirmation | 2 | -1 | 2/0 | 0.0% | -33.3 pp | 2 | +0 | 1.53 | +0.04 | 2/0 | 0.0% | -33.3 pp | 2 | +0 | 2.1 | +0.01 |
| TheSwaf / act_822913786458311 (2026-06-01..2026-06-18) | V0_current | 42 | +0 | 30/12 | 16.7% | +2.0 pp | 23 | -3 | 341.28 | -72.28 | 31/11 | 12.9% | +1.1 pp | 25 | -3 | 481.75 | -111.32 |
| TheSwaf / act_822913786458311 (2026-06-01..2026-06-18) | V2b_p25_breakeven_floor | 42 | +0 | 34/8 | 14.7% | +0.0 pp | 26 | +0 | 413.56 | +0 | 34/8 | 11.8% | +0.0 pp | 28 | +0 | 593.07 | +0 |
| TheSwaf / act_822913786458311 (2026-06-01..2026-06-18) | V2c_breakeven_recent_hold | 44 | +2 | 34/10 | 14.7% | +0.0 pp | 26 | +0 | 413.56 | +0 | 34/10 | 11.8% | +0.0 pp | 28 | +0 | 593.07 | +0 |
| TheSwaf / act_822913786458311 (2026-06-01..2026-06-18) | V2d_breakeven_recent_hold_temporal_confirmation | 44 | +2 | 29/15 | 20.7% | +6.0 pp | 23 | -3 | 389.62 | -23.94 | 29/15 | 17.2% | +5.5 pp | 23 | -5 | 532.53 | -60.54 |
| POOLED | V0_current | 62 | -5 | 43/19 | 11.6% | -0.7 pp | 34 | -12 | 393.16 | -159.05 | 44/18 | 9.1% | -3.2 pp | 37 | -9 | 551.77 | -194.07 |
| POOLED | V2b_p25_breakeven_floor | 67 | +0 | 57/10 | 12.3% | +0.0 pp | 46 | +0 | 552.21 | +0 | 57/10 | 12.3% | +0.0 pp | 46 | +0 | 745.84 | +0 |
| POOLED | V2c_breakeven_recent_hold | 70 | +3 | 58/12 | 12.1% | -0.2 pp | 47 | +1 | 549.32 | -2.89 | 58/12 | 10.3% | -1.9 pp | 48 | +2 | 746.62 | +0.78 |
| POOLED | V2d_breakeven_recent_hold_temporal_confirmation | 66 | -1 | 48/18 | 14.6% | +2.3 pp | 39 | -7 | 484.52 | -67.69 | 48/18 | 12.5% | +0.2 pp | 39 | -7 | 635.32 | -110.52 |

## Zero-Conversion And Severe-Loss Safety Isolation

Raw daily safety eligibility is shown separately from episode outcomes. V2d deliberately leaves these two branches immediate; only ratio cuts receive temporal confirmation.

| Scope | Variant | Zero-conversion raw days | Maturity-severe raw days | Temporal-pending ratio days |
| --- | --- | ---: | ---: | ---: |
| EMOLOS / act_1054905059780305 | V0_current | 10 | 0 | 0 |
| EMOLOS / act_1054905059780305 | V2b_p25_breakeven_floor | 10 | 0 | 0 |
| EMOLOS / act_1054905059780305 | V2c_breakeven_recent_hold | 10 | 0 | 0 |
| EMOLOS / act_1054905059780305 | V2d_breakeven_recent_hold_temporal_confirmation | 10 | 0 | 128 |
| Grandmix / act_805150454596350 | V0_current | 0 | 0 | 0 |
| Grandmix / act_805150454596350 | V2b_p25_breakeven_floor | 0 | 0 | 0 |
| Grandmix / act_805150454596350 | V2c_breakeven_recent_hold | 0 | 0 | 0 |
| Grandmix / act_805150454596350 | V2d_breakeven_recent_hold_temporal_confirmation | 0 | 0 | 66 |
| IwaStore / act_1087566732415606 | V0_current | 76 | 0 | 0 |
| IwaStore / act_1087566732415606 | V2b_p25_breakeven_floor | 76 | 0 | 0 |
| IwaStore / act_1087566732415606 | V2c_breakeven_recent_hold | 76 | 0 | 0 |
| IwaStore / act_1087566732415606 | V2d_breakeven_recent_hold_temporal_confirmation | 76 | 0 | 205 |
| TheSwaf / act_822913786458311 | V0_current | 71 | 0 | 0 |
| TheSwaf / act_822913786458311 | V2b_p25_breakeven_floor | 71 | 0 | 0 |
| TheSwaf / act_822913786458311 | V2c_breakeven_recent_hold | 71 | 0 | 0 |
| TheSwaf / act_822913786458311 | V2d_breakeven_recent_hold_temporal_confirmation | 71 | 0 | 194 |
| POOLED | V0_current | 157 | 0 | 0 |
| POOLED | V2b_p25_breakeven_floor | 157 | 0 | 0 |
| POOLED | V2c_breakeven_recent_hold | 157 | 0 | 0 |
| POOLED | V2d_breakeven_recent_hold_temporal_confirmation | 157 | 0 | 593 |

## Evidence Limits

- Current target and break-even packs are held fixed across every historical date because exact point-in-time commercial target history is not consumed by this legacy sweep.
- The raw source is creative-grain, not the immutable exact-Ad decision input chain; one creative may represent more than one Ad over time.
- Survivorship bias remains: creatives already paused by operators disappear from later observed spend, so early-cut error can be understated.
- Attribution lag moves both directions: delayed conversions can make forward ROAS look too low, while conversions caused by pre-trigger spend can make apparent recovery look too high.
- Saved-spend units are observational spend after a trigger divided by the trigger spend unit; they are not causal savings and raw currencies are never pooled.
- The June 2026 requested window is automatically truncated per account to the last date with a closed 28-day forward outcome.
- Zero-conversion and maturity-severe raw safety branches are intentionally unchanged by V2b/V2c/V2d; V2d temporal confirmation applies only to ratio cuts.
