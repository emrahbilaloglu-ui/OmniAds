# PR Title Suggestion

`feat: ship Google Ads Decision Engine V2 operator-first release candidate`

## Summary

This PR turns the Google Ads advisor into a safer, typed, operator-first decision surface.

It introduces Decision Engine V2 foundations, Decision Snapshot V2 multi-window serving, additive warehouse/search-intelligence groundwork, strict query-governance guardrails, an operator queue UI, and replay-style release hardening coverage.

The release posture is intentionally conservative:

- V1 operator-first
- write-back disabled by default
- suppressed unsafe actions remain visible and explainable
- no autonomy claims

## Scope

Included:

- Decision Engine V2 flags, types, lane model, and write-back gate
- Decision Snapshot V2 metadata and serving semantics
- additive retention/search-intelligence storage foundation
- expert-safe query-governance suppression and brand-governance separation
- operator-first Google Ads recommendation surface
- release checklist and fixture-based regression coverage

Not included:

- verified write-back
- autonomous optimization
- full serving migration to aggregate search-intelligence storage
- destructive retention execution
- major app-wide redesign

## Screenshots / Visual Notes

No screenshots attached in this branch.

Visual notes for reviewer:

- Google Ads page now centers on `Account Pulse`, `Decision Snapshot`, and `Opportunity Queue`
- queue sections are `Review`, `Test`, `Watch`, and `Suppressed`
- cards surface windows, confidence, risk, blast radius, blockers, validation, and rollback
- write-back-disabled posture is rendered as manual-plan/operator-review language

## Test / Build Results

Targeted Google Ads regression suite:

- `npm test -- lib/platforms/google/decision-engine-release.test.ts lib/platforms/google/query-ownership.test.ts lib/platforms/google/reporting.test.ts lib/platforms/google/growth-advisor.test.ts lib/platforms/google/decision-engine-v2.test.ts lib/platforms/google/decision-snapshot.test.ts lib/platforms/google/serving.test.ts lib/platforms/google/advisor-ux.test.ts components/google/google-advisor-panel.test.tsx components/platforms/google/GoogleAdsIntelligenceDashboard.test.tsx app/api/google-ads/advisor/route.test.ts app/api/google-ads/status/route.test.ts`
- result: `Test Files 12 passed (12)`, `Tests 98 passed (98)`

Production build:

- `npm run build`
- result: passed

Lint:

- no lint script exists in `package.json`

## Rollout / Rollback

Rollout:

1. Deploy additive schema plus code.
2. Set `GOOGLE_ADS_DECISION_ENGINE_V2=true`.
3. Keep `GOOGLE_ADS_WRITEBACK_ENABLED=false`.
4. Verify `/api/google-ads/status` and `/api/google-ads/advisor`.
5. Smoke-test the Google Ads operator surface.

Rollback:

1. Set `GOOGLE_ADS_DECISION_ENGINE_V2=false` if the V2 surface must be disabled.
2. Keep `GOOGLE_ADS_WRITEBACK_ENABLED=false`.
3. Redeploy prior app version if necessary.
4. Re-run advisor/status smoke checks.

## Limitations

- write-back is not verified and remains disabled by default
- replay coverage is fixture-based, not true production replay
- `lagAdjustedEndDate` is a placeholder shape, not a completed lag-adjustment system
- search-intelligence serving is only partially migrated onto the new storage foundations
- some compatibility shims remain in serving/snapshot plumbing

## Follow-up Work

- full serving adoption of normalized search-intelligence aggregates
- explicit retention execution with observability and dry-run reporting
- future release/replay tooling beyond fixture scenarios
- any future write-back work only after dedicated verification
