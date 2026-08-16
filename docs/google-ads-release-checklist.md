# Google Ads Decision Engine V2 Release Checklist

## Release posture

This is a V1 operator-first release candidate.

Canonical product posture now lives in [`docs/platforms/google-product-truth-matrix.md`](/Users/harmelek/Adsecute/docs/platforms/google-product-truth-matrix.md).
Operational rollout procedure now lives in [`docs/platforms/google-rollout-runbook.md`](/Users/harmelek/Adsecute/docs/platforms/google-rollout-runbook.md).

- It is not autonomous.
- It is not a verified write-back release.
- It is intended to help operators review, validate, and route decisions safely.

## Required feature flags

Required defaults for V1:

- `GOOGLE_ADS_DECISION_ENGINE_V2=true`
- `GOOGLE_ADS_WRITEBACK_ENABLED=false`

Rationale:

- Decision Snapshot V2 and the typed lane/decision surface must be enabled.
- Write-back stays off because mutate and rollback are not yet considered verified for production use.

## Migration and rollout order

1. Run additive migrations first.
2. Confirm Google Ads warehouse/state health is stable.
3. Confirm Decision Snapshot V2 routes and UI are serving.
4. Keep write-back disabled.
5. Validate operator-only behavior in a real business before broader rollout.

Recommended order:

1. `npm run google:ads:product-gate -- <businessId>`
2. `npm run build`
3. Deploy additive schema and code
4. Verify `/api/google-ads/status`
5. Refresh and verify the native advisor snapshot with `npm run google:ads:advisor-refresh -- <businessId> --json`
6. Verify `/api/google-ads/advisor`
7. Open the Google Ads page and confirm the operator queue renders
8. Run targeted smoke checks below
9. Record the outcome in the current rollout record

## Smoke checks

API / backend:

- `/api/google-ads/status` reports decision-snapshot-compatible language
- `/api/google-ads/status` reports advisor `actionContract` truth, AI assist rollout posture, including native vs compatibility-derived posture, and retention runtime posture
- `/api/google-ads/advisor` returns Decision Snapshot V2 metadata with `google_ads_advisor_action_v2` on refreshed native snapshots
- selected-range context is present only as contextual metadata
- query-governance recommendations suppress unsafe brand/SKU/product cases
- write-back capability gate reports disabled when `GOOGLE_ADS_WRITEBACK_ENABLED=false`

UI / operator surface:

- Google Ads page shows `Account Pulse`
- Google Ads page shows `Decision Snapshot`
- Google Ads page shows `Opportunity Queue`
- recommendations appear under `Review`, `Test`, `Watch`, and `Suppressed`
- suppressed recommendations remain visible and explainable
- cards show windows, confidence, risk, blast radius, blockers, validation, and rollback
- cards lead with the action-first v2 contract: primary action, scope, exact changes, expected effect, why this now, evidence, validation, rollback, and blocked because when applicable
- validation-due recommendations and recent operator outcomes render as manual workflow views, not autonomous queues
- UI uses manual-plan / operator-review wording
- UI does not imply direct execution when write-back is disabled
- Truth matrix, readiness checklist, and retention posture do not contradict each other
- `npm run google:ads:product-gate -- <businessId>` reports honest PASS/WARN/FAIL/NOT VERIFIED sections

Scenario checks:

- branded low-ROAS queries do not become negative-keyword actions
- obvious support-like waste can still surface as exact-negative-safe cleanup
- ambiguous queries remain suppressed
- SKU-specific and product-specific queries remain suppressed
- weak PMax situations do not present as reckless autonomous actions
- learning-period allocator cases remain blocked from native mutate

## Rollback steps

If the release must be rolled back:

1. Disable the surface operationally by setting `GOOGLE_ADS_DECISION_ENGINE_V2=false`
2. Keep `GOOGLE_ADS_WRITEBACK_ENABLED=false`
3. Redeploy the previous known-good application version
4. Re-check `/api/google-ads/status` and `/api/google-ads/advisor`
5. If needed, keep existing additive schema in place; this release does not require destructive rollback of migrations

If UI-only regression is isolated:

1. Revert the Google Ads operator-surface commit
2. Redeploy
3. Re-run the smoke checks above

## Known limitations

- Write-back remains disabled by default and is not verified for production-safe use
- `lagAdjustedEndDate` exists as an honest placeholder shape; lag adjustment is not yet implemented
- Search-intelligence storage foundations are additive, but serving is not fully cut over to those aggregates
- Replay coverage in Phase 6 is fixture-based, not a true historical execution replay framework
- Some deeper readiness/recovery semantics still rely on older internal coverage concepts even though outward copy is Decision Snapshot V2-compatible

## Not supported in V1

- Autonomous optimization
- Verified native mutate
- Verified native rollback
- Phrase-negative or broad-negative automation
- Hidden suppression of unsafe query-governance cases
- Full release automation or release replay workflow

## Why write-back is still not considered verified

Write-back is still not considered verified because:

- backend mutate codepaths existing in the repo are not proof of production safety
- rollback codepaths existing in the repo are not proof of safe recovery
- the current product posture is operator-first and manual-plan-first
- query governance and allocator actions still require conservative human review in V1

For V1, the honest release boundary is:

- Decision Engine V2 enabled
- operator-first decision surface enabled
- write-back disabled
- suppressed unsafe recommendations visible and explainable

<!-- CI baseline probe: no code change; opened to establish whether database-seams fails on main itself. -->
