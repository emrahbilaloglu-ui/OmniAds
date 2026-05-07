# Google Ads Decision Engine V2 PR Summary

## What changed overall

This branch converts the Google Ads advisor from a mostly recommendation-list experience into a typed, operator-first decision surface with explicit safety boundaries.

The work was delivered in six deliberate layers:

- Phase 1: Decision Engine V2 foundation, feature flags, typed decision schema, explicit write-back gate
- Phase 2: Decision Snapshot V2 serving and multi-window snapshot semantics
- Phase 3: search-term cutover onto additive search-intelligence storage
- Phase 4: strict query-governance guardrails, including expert-safe suppression behavior
- Phase 5: operator-first recommendation surface grouped by action lane
- Phase 6: replay-style fixture coverage, release checklist, and build/test hardening

## Why this change was made

The prior Google Ads advisor relied too heavily on a single long-window mental model and could produce unsafe or weakly explained recommendations. That was not sufficient for a product-ready operating surface.

This change set makes the system:

- explicit about which windows drive which decisions
- honest about operator-first/manual-plan posture
- explicit about why recommendations are blocked or suppressed
- safer around branded, SKU-specific, product-specific, and ambiguous queries
- more reviewable through typed metadata, flags, tests, and release docs

## Key architectural improvements

- Decision Engine V2 foundation with typed decision family, lane, risk, blast radius, evidence, validation, and rollback fields
- Explicit feature flags:
  - `GOOGLE_ADS_DECISION_ENGINE_V2=true`
  - `GOOGLE_ADS_WRITEBACK_ENABLED=false`
- Decision Snapshot V2 model with multi-window metadata:
  - alarm: `1d`, `3d`, `7d`
  - operational: `28d`
  - query governance: `56d`
  - baseline: `84d`
- Selected range remains contextual instead of acting as the primary decision brain
- Additive search-intelligence foundation:
  - query dictionary
  - hot raw-query daily layer
  - top-query weekly aggregate
  - search cluster/theme aggregate
  - action/outcome log foundation
- Search-intelligence serving/status now read additive storage instead of depending on long-history raw `google_ads_search_term_daily`
- Explicit query-governance suppression model with payload-visible blocker reasons
- Operator queue surface grouped by `Review`, `Test`, `Watch`, and `Suppressed`

## What is included in V1

- Decision Engine V2 enabled by flag
- Decision Snapshot V2 serving and snapshot metadata
- Operator-first Google Ads recommendation surface
- Manual-plan semantics when write-back is disabled
- Visible suppressed states with explanation
- Brand-governance separated from negative-keyword waste cleanup
- Exact-negative-only guardrails for eligible query-waste actions
- Google search-intelligence/advisor-support cutover onto additive storage while keeping raw search terms hot-only
- Replay-style fixture coverage for release-critical decision scenarios

## What is explicitly NOT included in V1

- Autonomous Google Ads optimization
- Verified native write-back
- Verified rollback automation
- Phrase-negative or broad-negative automation
- Destructive warehouse cleanup execution
- Historical replay engine with production event re-execution

## Known limitations

- `GOOGLE_ADS_WRITEBACK_ENABLED` remains `false` by default and write-back is not release-verified
- replay coverage is fixture-based, not a true historical replay system
- `lagAdjustedEndDate` is an honest placeholder shape, not an implemented lag model
- some serving/readiness internals still use legacy compatibility paths while outward semantics are V2-aligned
- retention execution is still intentionally disabled; Phase 4 must prove delete safety before any raw search-term cleanup can run

## Rollout guidance

1. Deploy additive schema and application code together.
2. Keep `GOOGLE_ADS_DECISION_ENGINE_V2=true`.
3. Keep `GOOGLE_ADS_WRITEBACK_ENABLED=false`.
4. Verify `/api/google-ads/status`.
5. Verify `/api/google-ads/advisor`.
6. Open the Google Ads page and review the operator queue.
7. Smoke-test branded suppression, ambiguous-query suppression, and exact-negative-safe waste.

## Reviewer guidance: what to inspect first

1. Read [`docs/platforms/google-decision-engine-v2.md`](/Users/harmelek/Adsecute/docs/platforms/google-decision-engine-v2.md).
2. Read [`docs/platforms/google-release-checklist.md`](/Users/harmelek/Adsecute/docs/platforms/google-release-checklist.md).
3. Inspect [`lib/platforms/google/decision-engine-config.ts`](/Users/harmelek/Adsecute/lib/platforms/google/decision-engine-config.ts) for the explicit flags and write-back gate posture.
4. Inspect [`lib/platforms/google/decision-snapshot.ts`](/Users/harmelek/Adsecute/lib/platforms/google/decision-snapshot.ts) and [`lib/platforms/google/serving.ts`](/Users/harmelek/Adsecute/lib/platforms/google/serving.ts) for Decision Snapshot V2 semantics.
5. Inspect [`lib/platforms/google/query-ownership.ts`](/Users/harmelek/Adsecute/lib/platforms/google/query-ownership.ts), [`lib/platforms/google/growth-advisor.ts`](/Users/harmelek/Adsecute/lib/platforms/google/growth-advisor.ts), and [`lib/platforms/google/reporting.ts`](/Users/harmelek/Adsecute/lib/platforms/google/reporting.ts) for query-governance safety.
6. Inspect [`components/google/google-advisor-panel.tsx`](/Users/harmelek/Adsecute/components/google/google-advisor-panel.tsx) for operator-first/manual-plan rendering.
7. Run the targeted test/build commands listed in the release checklist.

## Risk areas

- serving compatibility around legacy date-range and snapshot plumbing
- query classification quality where product/catalog context is partial
- mismatch risk between UI copy, status copy, and backend capability posture
- additive warehouse foundations not yet being the sole serving source

## Recommended manual smoke checks

- Confirm the Google Ads page shows `Account Pulse`, `Decision Snapshot`, and `Opportunity Queue`
- Confirm queue sections render as `Review`, `Test`, `Watch`, and `Suppressed`
- Confirm a branded low-ROAS query does not become a negative-keyword action
- Confirm a clearly irrelevant waste query can still surface as exact-negative-safe cleanup
- Confirm ambiguous, SKU-specific, and product-specific queries remain suppressed with reasons
- Confirm selected date range reads as context, not as the decision brain
- Confirm write-back language remains manual-plan/operator-review only
