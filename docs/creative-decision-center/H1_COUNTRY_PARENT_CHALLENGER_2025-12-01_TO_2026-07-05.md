# H1 Country-Parent Challenger

Source mode: `restated_raw_ad_country_daily`
Decision range: 2025-12-01 to 2026-07-05
Outcome ceiling: 2026-07-11
Producer cutoff: 03:00:00.000Z
Report hash: `5bf845b99ca930f833a6c25af3b490b94c5dca20700eb8512655181b4aeeb944`

## Evidence Boundary

This is a producer-cutoff-strict, restated sensitivity analysis. Every source
day uses only the latest complete generation observed by that decision's
cutoff; later fetches cannot affect earlier decisions. It is not full resolver
PIT, causal lift, automation evidence, or production execution authority.
Country is represented as a 28-day ad-level spend-share vector. A multi-country
ad is never forced into one assigned country.

## Retained Source Coverage

- Retained raw country pages: **56803**
- Planned source-day/cutoff selections: **19443**
- Unique complete generations selected: **842**
- Normalized ad-country rows selected: **49245**
- Rejected source-day/cutoff selections: **7822**
- Unmapped raw scopes: **0**
- Normalized Meta ad rows: **142170**
- Raw source SHA-256: `66144a646394779cc5d49dcb7ba621824e7601d97eaa5fa54e8253a1d374f9b3`

## Fixed Cohort

- Rows / unique keys: **18928 / 18928**
- Purchase-cohort rows: **17301**
- Target observed / fresh: **3641 / 1864**
- Complete 14-day outcomes: **17470**
- Country mix available: **1337**
- Multi-country rows: **319**
- Complete country fallback rows: **17591**
- Reconciled country-spend coverage: **4.54%**
- Fixed cohort SHA-256: `ba9ee91596bf6bd07e5ef988d9865c32d6d16e98992a7a1cef0793c03b3104d5`
- Manifest-set SHA-256: `2ba9b28966e3b9b6f4eb0a764140f5edbd064d470d00ebda240aee16ef1aae65`

All **288** variants use this same cohort:
144 locked H1 configurations crossed with `account_goal` and
`account_goal_country_spend_weighted` parent modes.

## Locked Parent Comparison

Calibration selected the H1 configuration
`H1_hl14_k16_q0p7` using only the account-goal
parent. The country parent was then compared at that locked configuration.

| Parent | Emitted | Known | Supported | Refuted | Precision | Wilson lower | Recall | Safety violations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| account_goal | 49 | 26 | 18 | 8 | 69.23% | 50.01% | 15.00% | 0 |
| country_spend_weighted | 49 | 26 | 18 | 8 | 69.23% | 50.01% | 15.00% | 0 |

Paired locked-test deltas for country minus account:

- emitted: **0**
- supported: **0**
- refuted: **0**
- precision: **0.0000**
- recall: **0.0000**
- safety violations: **0**
- clustered recall-delta 95% interval: **0.0000 to 0.0000**

## Locked Outcome-Window Robustness

The H1 configuration is selected once on the primary 14-day calibration fold.
The same locked account and country variants are then scored independently on
closed 3-day, 7-day, and 14-day outcomes; windows are never pooled.

| Window | Account known | Account precision | Account recall | Country known | Country precision | Country recall | Decision changes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3d | 34 | 79.41% | 12.27% | 34 | 79.41% | 12.27% | 0 |
| 7d | 30 | 66.67% | 10.58% | 30 | 66.67% | 10.58% | 0 |
| 14d | 26 | 69.23% | 15.00% | 26 | 69.23% | 15.00% | 0 |

## Gate Decision

Status: **RETAIN_ACCOUNT_GOAL_NO_INCREMENTAL_DECISION_SIGNAL**

- `known_outcomes_below_100`
- `precision_below_0_92`
- `recall_below_0_92`
- `precision_wilson_lower_below_0_85`

This result can justify a production formula change only if every predeclared
historical gate passes. Even a passing result would remain review-only because
the source is restated and does not identify causal lift.

## Closure

Country conditioning is no longer an untested alternative. Sparse country
cells fall back share-by-share to the account-goal parent and cannot increase
confidence. The D049 break-even safety ceiling is identical in both modes.
No resolver change is made by this package.
