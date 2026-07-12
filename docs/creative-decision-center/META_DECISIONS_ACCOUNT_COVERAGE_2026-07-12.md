# Meta Decisions Account Coverage - 2026-07-12

## Scope

Read-only verification against the live tunnel for every assigned Meta provider
account. No DB, provider, cron, environment, push, or deploy write was made.
The audit executed the production `readMetaDecisionsWorkspaceReadModel` and
`buildMetaOsDecisionsPresentation` functions from the local code under review.

Snapshot date: `2026-07-11` for all accounts.

## Root Cause And Fix

- IwaStore's blanket `Cannot Assess` was caused by a classification fallback
  that did not classify valid `test_more`, ordinary `keep`, generic `refresh`,
  or structured diagnose states.
- TheSwaf-Main's empty Ads/Act view was caused by confidence-first Top-60
  selection before action/lane semantics. All Cut and diagnose rows were
  excluded while 60 Monitoring rows were retained.
- Meta Decisions classification overlay v2 now separates `act`, `blocked`,
  `monitor`, and `not_applicable`; legacy `diagnose_data` is audit metadata, not
  a served buyer action.
- Exact-ad selection now runs after semantic classification and reserves every
  non-empty lane before filling remaining capacity by priority.
- Structure and Ads retain independent lane state and fall back to a non-empty
  lane. Empty accounts show explicit source/identity reasons.
- New snapshots persist nullable `blocked_action_type`; legacy reads use only
  the structured `stop_loss_review` fallback for a held Cut and never parse
  reason text.

## Live Coverage

`Eligible` means a single verified Meta ad identity with a displayable served
state. `Selected` is the bounded first response. Pre-cap lane counts remain in
the server receipt so suppression is explicit. Show More expands the same
server ordering in 60-row increments up to 300; all 13 current accounts fit
within that bound (largest eligible account: 246).

| Business | Account | Source | Eligible | Selected | Act | Needs resolution | Monitor | Ambiguous | Missing ad ID |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bilsem Zeka | BILSEM ZEKA-1 | 115 | 59 | 59 | 0 | 5 | 54 | 46 | 1 |
| BskTR | BSK - TR | 37 | 2 | 2 | 0 | 0 | 2 | 34 | 0 |
| ColorFullWorldsTR | ColorfullworldsTR | 50 | 42 | 42 | 2 | 4 | 36 | 6 | 0 |
| EMOLOS | Emolos LTD. | 270 | 246 | 60 | 10 | 6 | 44 | 23 | 1 |
| Grandmix | Grandmix | 222 | 194 | 60 | 2 | 12 | 46 | 25 | 1 |
| Halicizade | Halicizade | 194 | 118 | 60 | 0 | 8 | 52 | 43 | 33 |
| IwaStore | IWA-MDNLLC | 156 | 139 | 60 | 0 | 23 | 37 | 1 | 11 |
| IwaTR | IWA-TR | 104 | 80 | 60 | 0 | 18 | 42 | 0 | 4 |
| Silveristic | Silveristic Ad Account | 47 | 24 | 24 | 0 | 2 | 22 | 21 | 2 |
| TheSwaf | TheSwaf-Main | 269 | 232 | 60 | 7 | 16 | 37 | 37 | 0 |
| TheSwaf | TheSwaf-NonTesvik | 19 | 17 | 17 | 1 | 0 | 16 | 0 | 0 |
| Tiles Workshop | Tiles Workshop Ads Account | 141 | 135 | 60 | 0 | 18 | 42 | 5 | 0 |
| Vornom | Furnitreasure | 49 | 48 | 48 | 2 | 25 | 21 | 0 | 1 |

Result: 13/13 accounts read successfully, runtime errors `0`, and served rows
containing `Cannot Assess`, `Investigate Data`, or `Diagnose Data`: `0`.

Ambiguous creative reuse remains intentionally withheld. Creative-grain metrics
must not be copied to an arbitrary ad; expanding those rows requires an ad-grain
decision producer.

## Focus Accounts

IwaStore selected presentation:

- Assessments: 11 Underperformer, 5 Funnel Bottleneck, 7 Stable, 37 Learning.
- Resolution tasks: Fix Checkout 1, Fix Landing Page 4, Resolve Campaign Role
  17, Fix Delivery 1.

TheSwaf-Main selected presentation:

- Lanes: 7 Act, 16 Needs Resolution, 37 Monitoring.
- Assessments: 20 Underperformer, 2 Funnel Bottleneck, 1 Above Target - Not
  Proven, 4 Stable, 33 Learning.
- Actions/resolutions: Cut 7, Fix Landing Page 2, Resolve Campaign Role 14,
  Continue Test 37.

## Verification

- TypeScript: pass.
- ESLint: pass.
- Vitest full suite: 522 files passed; 4 skipped. 4068 tests passed; 56
  skipped; 61 TODO.
- Focused D035 suite: 7 files passed; 49 tests passed; 13 skipped.
- Migrations from zero and idempotent rerun: pass.
- Real Postgres seam: `blocked_action_type` write/read round-trip: pass.
- Full UI Playwright visual smoke: desktop and mobile, 2/2 passed.
