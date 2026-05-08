# Meta Engine v1 Operator Runbook v2

Timestamp: 2026-05-09T00:09:20+03:00

## Architecture Overview

Meta Engine v1 is a scenario-library-driven decision system. It combines:

- Scenario registry: 40 A1-K4 rec types with fixture coverage.
- Production emitters: 12 high-priority scenario emitters wired into campaign and adset recommendation paths.
- Calibration: account-history percentiles and scoped calibration context.
- Signal backfill: daily entity-level signals for fatigue, CTR decay, creative age, recent edits, and learning state.
- Snapshot persistence: daily campaign/adset rows in `meta_decision_snapshots_daily`, including state rows for eligible entities without actions.
- UI consumption: `/api/meta/recommendations`, `/api/meta/anomalies`, pulse chips, anomaly cards, and operator response badges.

Decision labels are derived by the shared mapping layer. UI surfaces must not infer buyer-facing labels directly from `rec.type`.

## Calibration Cadence

Calibration runs daily before signal backfill and snapshot generation. The engine uses account-history percentiles and scoped calibration where sample size supports it. When campaign-scope samples are sparse, v1 falls back to broader account scope rather than forcing low-quality thresholds.

Missing or low-quality calibration inputs cap confidence. They do not produce high-confidence scale, cut, or rebuild actions.

## Signal Backfill Cadence

Signal backfill runs daily after calibration and before snapshot generation. The v1 backfill writes only the narrow signals required by the production-wired emitters:

- `frequency_p80`
- `ctr_decay_pct`
- `creative_age_days_max`
- `last_significant_edit_at`
- `days_since_significant_edit`
- `learning_state`

Signal rows are idempotent per business, scope, entity, and snapshot date. Signal quality/source metadata distinguishes API-authoritative, inferred, and missing values.

## Snapshot Freshness

The expected daily order is:

1. Calibration
2. Signal backfill
3. Snapshot recommendation build
4. Anomaly persistence

Snapshots are expected to refresh daily around the scheduled Meta job window. A snapshot older than 24 hours should be treated as stale and investigated through cron logs, calibration readiness, signal backfill status, and DB write errors.

## Anomaly Diagnostic Ladder

Anomaly cards are diagnostic first. Operators should investigate in this order:

1. Tracking: pixel, CAPI, dedup, attribution, and sync freshness.
2. Fatigue: frequency pressure, CTR decay, creative age, and exhausted winners.
3. Recent edits: budget, bid strategy, optimization event, or audience changes.
4. Auction: CPM spike, delivery stall, pacing failure, or bid-cap pressure.
5. Seasonality: peak, post-peak, normalized, or unstable regime context.

Anomalies should not become direct pause/scale actions unless a recommendation row separately supports that action.

## Operating Mode And Seasonal Regime

The account pulse classifies operating mode as `aggressive_volume` or `profit_first` and seasonal regime as `peak`, `post_peak`, `normalized`, or `unstable`. These fields explain why the same metric pattern can produce different scale ceilings or diagnostic posture across businesses and seasons.

Operators should read mode/regime chips as context, not as standalone commands.

## Tracking Degradation And Confidence

Tracking degradation propagates to confidence through signal-quality metadata and UI chips. When signal quality is missing, inferred, stale, or tracking-degraded, the engine caps confidence and prefers watch/diagnose output over high-confidence destructive or scale actions.

The operator should treat a confidence-cap chip as a reason to inspect evidence before acting, not as a hidden failure.

## Decision Label Coupling

Buyer-facing labels come from the backend-owned mapping contract:

- `kind = anomaly` generally maps to `diagnose`.
- `decisionState = watch` maps to `keep` or `test_more` depending on context.
- `recommendedAction` semantics decide whether defensive language maps to `tune`, `cut`, `diagnose`, `switch`, `refresh`, or `rebuild`.
- `rec.type` may inform copy, but it must not be the sole label source.

Known v1 coupling fixes:

- Defensive `scale_for_profitability` actions map to `tune`, not `scale`.
- Anomaly rec types such as `roas_drop_sudden` map to `diagnose`.

## Operator Response Telemetry

The `/api/meta/recommendations/respond` route records `acted`, `deferred`, `undeferred`, and `ignored` events. Cards and watch rows surface response state so operators can scan what has already been handled. Future engine versions should use this telemetry to tune thresholds from real acted/deferred/ignored outcomes.
