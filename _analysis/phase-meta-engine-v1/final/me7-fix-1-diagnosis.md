# ME7 Fix 1 Diagnosis

Timestamp: 2026-05-08T15:44:25Z

## Root Cause

The ME7 failure was a persisted snapshot completeness problem, not a missing campaign source problem. The campaign source returns mature campaigns for both validation businesses (`49` for TheSwaf, `54` for IwaStore over the 2026-04-09 to 2026-05-08 window), and `buildMetaEntityStateRows()` already iterates campaigns and adsets. A targeted rerun of `runMetaSnapshotForBusiness()` on the same branch wrote campaign `entity_state` rows immediately, proving the campaign hydration code path can emit rows when the business snapshot actually reruns end-to-end.

The implementation gap was in the scheduler/idempotency completeness guard and the observability shape of state rows. ME5’s guard considered a business complete when it had any recommendation/anomaly row for the snapshot date; an adset-only or anomaly-only partial snapshot could therefore be treated as done even when campaign state rows were absent. The fix tightens the guard to require both campaign and adset snapshot rows for every active business before skipping a run, and changes state rec types from the shared `entity_state` to level-specific `campaign_state` / `adset_state` so future coverage checks and PK coexistence are explicit.

## Fix Scope

- `lib/meta/scheduled.ts`: require campaign and adset row presence per active business before `already_ran`.
- `lib/meta/engine-v1/state-rows.ts`: emit stable level-specific state rec types.
- `lib/meta/recommendations.ts` and `lib/meta/rec-label-mapping.ts`: register the new state rec types and keep their buyer-facing label as `keep`.
- Tests: added scheduler partial-snapshot regression, campaign state iteration coverage, and campaign state/action coexistence coverage.
