# Meta Engine v1 ME1 Audit

Run date: 2026-05-08
Branch: `phase-meta-engine-v1-me1`
Scope: audit-only. No runtime code, migrations, snapshot writes, PR open, or merge actions were performed.

## Executive Summary

The Meta engine has a real production path, but it is not an end-to-end per-entity engine yet.

Current serving defaults to persisted rows from `meta_decision_snapshots_daily`. The scheduled snapshot job can build campaign and adset recommendations, but the scheduler can skip entire days after partial writes, the live debug route bypasses adsets, and adset decision generation emits only sparse top actionable rows. That combination explains why R&D extraction saw 4 campaign snapshots and 0 adset snapshots across 278 mature entities.

The ME2 rebuild should not treat "no row" as a valid keep decision. It should persist one engine state row per eligible entity, then separately measure action density so coverage cannot be gamed by writing no-action rows.

## Production Call Graph

### Scheduled write path

1. `/api/sync/cron` calls `runMetaSnapshotJobIfDue()` after the regular sync fanout.
2. `runMetaSnapshotJobIfDue()` checks:
   - UTC hour is exactly `03`.
   - `meta_decision_snapshots_daily` and `meta_decision_calibration_daily` are schema-ready.
   - `alreadyRan(snapshotDate)` is false.
3. `runMetaSnapshotForAllBusinesses(snapshotDate)` reads active businesses and calls `runMetaSnapshotForBusiness()` with `Promise.allSettled`.
4. `runMetaSnapshotForBusiness()`:
   - Runs `runMetaCalibrationForBusiness()`.
   - Builds campaign windows via `getMetaCampaignsForRange()`.
   - Builds campaign/account recs via `buildMetaRecommendations()`.
   - Reads adsets via `getMetaAdSetsForRange()`.
   - Builds adset recs via `buildMetaAdsetRecommendations()`.
   - Detects anomalies via `detectAnomaliesForBusiness()`.
   - Builds evidence trails.
   - Writes recommendation/anomaly rows to `meta_decision_snapshots_daily`.

### Read path

1. `/api/meta/recommendations` defaults to persisted mode unless `live=1`.
2. Persisted mode calls `readMetaDecisionSnapshotForRange()`.
3. `readMetaDecisionSnapshotForRange()` selects the latest snapshot date in the requested range where `kind = 'recommendation'`.
4. It hydrates persisted rows back into `MetaRecommendation` objects.
5. UI consumers receive the response through lane classification and Meta redesigned page components.

### UI consumer path

Main consumers found:

- `MetaPlatformPage` fetches `/api/meta/lane-classify`, `/api/meta/anomalies`, and account pulse data. It uses `decisionLabelForRec()` in compare drawer items and adset rollup grouping.
- `MetaActionCard` renders action cards and calls `decisionLabelForRec()` and `primaryLabelForRec()`.
- `MetaDrillDrawer` renders related-rec decision chips and primary labels through the same helpers.
- `CrossAdsetRollupCard` renders rollup decision chips through `decisionLabelForRec()`.
- `MetaAlertsStrip` and anomaly mode in `MetaActionCard` render anomalies separately from recommendation cards.

Impact: a label bug in `meta-card-utils.ts` is not isolated. It propagates into action cards, drilldown, compare items, and cross-adset rollups.

## Live, Debug, and Dead Paths

### Live

- `lib/meta/scheduled.ts`: daily scheduler for snapshot generation.
- `app/api/sync/cron/route.ts`: cron entrypoint that invokes the scheduled Meta snapshot job.
- `lib/meta/snapshot.ts`: campaign/adset recommendation build, anomaly build, persistence, and hydration.
- `lib/meta/recommendations.ts`: current campaign/account recommendation engine.
- `lib/meta/adset-decisions.ts`: current adset recommendation engine.
- `lib/meta/anomalies.ts`: anomaly detector and anomaly read API support.
- `app/api/meta/recommendations/route.ts`: persisted recommendation API.
- `app/api/meta/anomalies/route.ts`: active anomaly API.

### Debug-only / partially live

- `GET /api/meta/recommendations?live=1` recomputes campaign/account recommendations only. It calls `buildMetaRecommendations()` directly and does not call `getMetaAdSetsForRange()` or `buildMetaAdsetRecommendations()`.
- This confirms the live debug path bypasses adset recommendations. If operators or tests inspect `?live=1`, they cannot see the adset path at all.

### R&D / not production serving

- `_analysis/phase-meta-rnd/*`
- `scripts/_phase-meta-rnd-extract.ts`
- `scripts/_phase-meta-rnd-claude-personas.ts`
- `_analysis/phase-4-meta-archive/*`

### Archived, forbidden for imports

- `lib/archive/v1-v2-v21/*`

No new engine v1 work should import archived code.

## Current Coverage Baseline From R&D Extract

The checked-in R&D CSVs contain:

| level | entities | engine snapshots |
|---|---:|---:|
| campaign | 101 | 4 |
| adset | 177 | 0 |
| total | 278 | 4 |

Current entity coverage is `4 / 278 = 1.44%`.

If only sales entities with live or historically active spend are counted as action candidates, the checked-in R&D set has 47 sales action-denominator rows and 4 engine snapshots, or `8.51%`. This is still far below the ME7 target and still entirely campaign-level.

## Coverage Blockers

### Scheduler and idempotency

- `runMetaSnapshotJobIfDue()` runs only during UTC hour `03`. If the external scheduler misses that hour, the job returns `outside_slot`.
- `alreadyRan(snapshotDate)` is global by date. Any row in `meta_decision_snapshots_daily` or `meta_decision_calibration_daily` for that date can block the all-business job.
- Calibration rows alone count as already-run evidence. A calibration write followed by snapshot failure prevents retry for that date.
- `/api/sync/cron` catches snapshot failures and still returns a successful cron response with an embedded `failed` reason. Uptime-only monitoring can miss engine failure.
- `runMetaSnapshotForAllBusinesses()` uses `Promise.allSettled`, but a failed business is not retried if another business wrote rows for the date and `alreadyRan()` later blocks the job.

### Recommendation sparsity

- `buildMetaAdsetRecommendations()` filters to `ACTIVE` adsets only.
- It emits only three current patterns: scale, cut/cap, and watch fatigue.
- It sorts and slices to 5 rows.
- It does not produce `keep`, `watch`, `out_of_scope`, or no-action state rows for every eligible adset.
- Therefore 80% adset entity coverage is structurally impossible under current semantics even if the job runs correctly.

### Adset path visibility

- Persisted snapshot jobs can write adset recommendations if emitted.
- `?live=1` bypasses adsets, so live/debug verification can falsely imply the engine has no adset code path.
- Snapshot tests mock adset rows as empty in important paths, so persistence of adset recommendations is not currently guarded enough.

### Calibration and data readiness

- Current calibration metrics are limited to `roas_28d`, `cpa_28d`, `freq_14d`, `cpm_14d`, `ctr_28d`, and `win_rate_28d`.
- Calibration requires finalized/finalized_verified warehouse rows and mature spend/impression samples.
- Missing signals block most scenario-library branches: learning state, last edit, audience overlap, audience size, lookalike %, creative age, feed disapprovals, dedup rate, CRM/Meta ratio, and daily ROAS volatility.

## Consumer-Side Sweep

### Confirmed Bug A

`decisionLabelForRec()` maps `scale_for_profitability` to `scale`. R&D confirmed this is wrong for rows where the engine says reduce, tighten, or reallocate. The bug affects:

- `MetaActionCard`
- `MetaDrillDrawer`
- `MetaPlatformPage` compare drawer items
- `CrossAdsetRollupCard`
- grouping logic in `groupAdsetRollups()`

### Confirmed Bug B

Unknown anomaly rec types fall through the recommendation label helper. `roas_drop_sudden` is not represented in the helper and surfaced as `unknown` in the extraction. Anomalies are better handled via `kind = 'anomaly'` and a diagnose label.

### Additional mapping risks

- `primaryLabelForRec()` is also rec-type based. A profitability-protection rec can get an action label that does not match the action semantics.
- `launchModeForRec()` is rec-type based and may expose rebuild/duplicate/apply paths from analytical type rather than backend-confirmed operator action.
- `decisionLabelForRec()` does not inspect `kind`. A persisted anomaly hydrated as a recommendation-shaped row would not be automatically diagnose.
- `decisionState === 'watch'` always maps to diagnose. That collapses legitimate watch/protect/no-action states into a data-quality-like label.

ME2 should move label derivation into a shared backend-owned mapping module and have UI consume the derived result rather than infer buyer-facing labels from `rec.type`.

## Scenario Coverage Findings

R&D synthesis and Codex method show frequent fired scenarios that production does not cover:

- I4 `test_should_use_abo`
- K4 `catalog_feed_anomaly_first`
- G1 `optimization_event_upper_funnel`
- C1 `controlled scale`
- J1 `stable_winner_protected`
- A1 `mathematical floor unmet`
- B1 `capped winner needs bid raise`
- A2 `structural underperformer`
- F1/F2 diagnostic ladder and recent-data confidence cap

Never-fired scenario groups mostly require missing extraction signals, not just new rules:

- Learning state and days-at-status: A3, A4, A5, C2, F3.
- Audience metadata and overlap: D1-D5, I5.
- Frequency distribution and creative age: E1, E3, E4.
- Tracking quality: H1-H4.
- Daily volatility and bid ceiling pressure: B3-B6.
- Seasonal regime: K2, K3.

## ME1 Sign-Off Status

Mandatory PR blockers:

- A. Coverage gaming protection: documented in `me1-coverage-baseline.md`.
- B. Eligible entity definition: documented in `me1-coverage-baseline.md`.
- C. Paused and non-sales denominator handling: documented in `me1-coverage-baseline.md`.
- D. UI consumer-side mapping audit: completed in this file.
- E. `?live=1` adset bypass: confirmed in this file.
- F. Marcus + Aria ME2 consultation schedule: documented in `me2-work-breakdown.md`.

## Toolchain Status

Recorded in this ME1 pass:

- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run test`: pass, 374 files passed and 5 skipped; 2476 tests passed and 44 skipped.
- `npm run build`: pass.
- Targeted Meta tests: pass, `npx vitest run lib/meta/calibration.test.ts lib/meta/snapshot.test.ts app/api/sync/cron/route.test.ts`; 3 files passed, 19 tests passed.

No read-only SQL was run in ME1 because no database access was available in this workspace session. The checked-in R&D CSVs were used for denominator and density baseline calculations in `me1-coverage-baseline.md`.

## ME2 Recommendations

ME2 should start by defining a Meta Engine v1 output contract before adding 40+ rule modules:

1. Persist one row per eligible entity per day.
2. Separate `kind = state` from `kind = recommendation | anomaly`.
3. Derive UI labels from backend/shared semantics, not type prefixes.
4. Add state rows for `keep`, `watch`, `out_of_scope`, `no_action`, and protected winners.
5. Keep action density as an explicit quality metric.
6. Fix scheduler idempotency and retry behavior before relying on daily snapshot coverage.
7. Add tests proving adset rows are built, persisted, hydrated, and visible through the default persisted API path.
