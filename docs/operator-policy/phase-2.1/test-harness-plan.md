# Phase 2.1 Test Harness Plan

Scope: Adsecute Phase 3.1 Decision Range Firewall + Provenance Contract.

This is a planning document only. It does not implement tests, does not change Creatives logic, does not change Meta recommendation logic, and does not change queue or execution behavior.

## Harness Principles

- Decision authority is keyed by `businessId + decisionAsOf + sourceWindowKey`, not the selected reporting range.
- `analyticsStartDate` and `analyticsEndDate` are allowed to shape reporting, comparison, and historical/context panels only.
- Queue, apply, and Command Center deep-link eligibility require explicit decision provenance.
- Snapshot, demo, fallback, report-only, and non-live evidence can be visible, but cannot create push eligibility.
- Tests should prefer existing Vitest style: route tests in `app/api/**/route.test.ts`, domain tests in `lib/*.test.ts`, and component/link tests in `components/**/*.test.tsx`.

## Existing Test Style Observed

- Meta Decision OS route tests mock access, feature gates, source snapshots, and `buildMetaDecisionOs` in `app/api/meta/decision-os/route.test.ts`.
- Creative Decision OS route tests mock access, feature gates, Meta creative source rows, decision window context, and `buildCreativeDecisionOs` in `app/api/creatives/decision-os/route.test.ts`.
- Command Center domain tests already assert action fingerprint stability across selected ranges in `lib/command-center.test.ts`.
- Command Center route and execution tests mock service/store boundaries in `app/api/command-center/route.test.ts` and `app/api/command-center/execution/**/*.test.ts`.
- Legacy Meta recommendations fallback tests live in `app/api/meta/recommendations/route.test.ts`.

## Proposed Fixture Baseline

Use a shared test fixture shape where practical:

- `businessId`: `biz`
- `decisionAsOf`: `2026-04-10`
- analytics range A: `2026-04-01` to `2026-04-10`
- analytics range B: `2026-03-01` to `2026-03-31`
- primary source window: `primary30d`, `2026-03-12` to `2026-04-10`
- second decisionAsOf for drift tests: `2026-04-11`, primary source window `2026-03-13` to `2026-04-11`

The fixture should contain at least one Meta action-core item, one Creative queue-ready segment, one reporting-only fallback recommendation, one missing-provenance item, one same-day partial source, and one demo/snapshot/non-live item.

## Required Tests

### 1. Meta Decision OS actions stay identical across analytics ranges

Purpose: prove that the Meta primary Decision OS action set is controlled by `decisionAsOf` and source windows, not the selected analytics range.

Setup/fixtures:
- Mock `getMetaDecisionWindowContext` to return the same `decisionAsOf` and same `decisionWindows` for two requests with different `startDate/endDate`.
- Mock `getMetaDecisionSourceSnapshot` to assert it is called with the primary decision window, not the selected range.
- Return identical campaign/ad set/breakdown rows for both requests.

Assertions:
- `buildMetaDecisionOs` receives different `analyticsWindow` values but the same `decisionAsOf` and same `decisionWindows.primary30d`.
- Primary action outputs match exactly by stable fields: `actionType`, entity id, queue eligibility, confidence, authority state, and action fingerprint once provenance fingerprinting exists.
- Reporting fields may retain the selected analytics window.

Likely file location:
- `app/api/meta/decision-os/route.test.ts` for route/source-window wiring.
- `lib/meta/decision-os.test.ts` for pure action identity stability if a provenance-aware helper is introduced.

Blockers/data gaps:
- The route currently accepts `startDate/endDate` but not an explicit `decisionAsOf` query parameter.
- The source layer has optional `decisionAsOf` support through `getMetaDecisionWindowContext`, but `getMetaDecisionOsForRange` does not expose it yet.
- Action-level provenance fields do not yet appear in the public route contract.

### 2. Creative primary segments stay identical across analytics ranges

Purpose: prove that Creative primary segments and lifecycle decisions are computed from the decision source window, while selected-range creative history remains context only.

Setup/fixtures:
- Mock `getMetaDecisionWindowContext` with the same `decisionAsOf` and same primary window for two analytics ranges.
- Mock creative fetches so primary decision-window rows are identical for both requests.
- Mock selected-period rows differently for range A and range B to exercise historical/reporting context changes.

Assertions:
- `buildCreativeDecisionOs` receives the same primary `rows`, `decisionAsOf`, and `decisionWindows.primary30d` for both requests.
- `creatives`, `families`, `operatorQueues`, `protectedWinners`, and `supplyPlan` primary decision fields stay identical.
- `historicalAnalysis.selectedWindow` or equivalent reporting/context output is allowed to differ.

Likely file location:
- `app/api/creatives/decision-os/route.test.ts` for route/source-window wiring.
- `lib/creative-decision-os.test.ts` for deterministic segment stability if action provenance/fingerprints are built in the domain layer.

Blockers/data gaps:
- `getCreativeDecisionOsForRange` currently fetches selected-period rows for `historicalAnalysis`, which is correct, but the public contract needs explicit provenance to make this boundary testable.
- Like Meta, the route does not yet accept/pass an explicit `decisionAsOf`.

### 3. Analytics range affects reporting/context only, not action authority

Purpose: enforce the firewall between analysis-only range fields and authority-bearing decision fields.

Setup/fixtures:
- Build paired Meta, Creative, and Command Center payloads with identical `decisionAsOf` and primary source windows but different selected ranges.
- Include changed selected-period metrics large enough that a pre-firewall implementation would change actions.

Assertions:
- Allowed-to-change fields: `analyticsWindow`, selected-window labels, historical analysis, reporting summaries, chart/context copy, and selected-period report-only recommendations.
- Must-not-change fields: primary action title, recommended action, queue eligibility, action fingerprint, source decision id, authority lane, execution support mode, and apply eligibility.
- Any action delta caused only by selected range should fail the test.

Likely file location:
- `lib/command-center.test.ts` for aggregate action stability.
- `app/api/command-center/route.test.ts` for route payload contract.
- Optional helper test near the future provenance compiler, if introduced.

Blockers/data gaps:
- A formal allowlist/denylist of authority-bearing fields is not yet codified.
- Existing Command Center stability tests cover fingerprints and selected action text, but not the full authority/apply eligibility boundary.

### 4. Decision OS route response includes provenance

Purpose: ensure route consumers can verify the source window and action identity behind every authority-bearing decision.

Setup/fixtures:
- Use a deterministic Meta route fixture and Creative route fixture with one action-core item each.
- Expected provenance fields:
  - `decisionAsOf`
  - `sourceWindowKey`
  - `sourceWindow.startDate`
  - `sourceWindow.endDate`
  - `evidenceHash`
  - `actionFingerprint`

Assertions:
- The route response includes response-level decision metadata and action-level provenance.
- `sourceWindowKey` is `primary30d` for action authority unless a test fixture intentionally uses another documented authority window.
- `sourceWindow` dates match `decisionWindows[sourceWindowKey]`.
- `evidenceHash` is deterministic for the same evidence envelope.
- `actionFingerprint` is deterministic and excludes selected analytics range.

Likely file location:
- `app/api/meta/decision-os/route.test.ts`
- `app/api/creatives/decision-os/route.test.ts`
- Existing contract helper: `lib/meta/page-route-contract.test-helpers` may need a new assertion helper for provenance.

Blockers/data gaps:
- Current route payloads expose `decisionAsOf` and `decisionWindows`, but not standardized `sourceWindowKey`, `sourceWindow`, `evidenceHash`, or action-level `actionFingerprint`.
- The exact nesting path for provenance needs to be chosen before tests can assert it without becoming brittle.

### 5. Command Center link uses decision provenance, not selected dates

Purpose: prevent Meta and Creative source pages from building Command Center links from selected report dates when a decision provenance envelope is available.

Setup/fixtures:
- Render Meta campaign/detail and Creative detail components with selected dates that differ from decision provenance dates.
- Provide an action with `decisionAsOf`, `sourceWindowKey`, source-window dates, and `actionFingerprint`.

Assertions:
- Generated `/command-center` links include decision provenance parameters, not `since/until` or selected custom report dates as authority parameters.
- The selected range may appear only as an explicit reporting/context parameter if the contract keeps one.
- The `action` query param remains the provenance-derived `actionFingerprint`.

Likely file location:
- `components/meta/meta-campaign-detail.test.tsx`
- `components/platforms/meta/creatives/CreativeDetailExperience.test.tsx` if present; otherwise create focused component test beside `CreativeDetailExperience.tsx`.
- `app/api/command-center/route.test.ts` for parsing/forwarding provenance once route query shape is finalized.

Blockers/data gaps:
- Current links in `components/meta/meta-campaign-detail.tsx` and `components/platforms/meta/creatives/CreativeDetailExperience.tsx` use selected dates in the Command Center URL.
- Query parameter names for provenance are not finalized. Suggested names: `decisionAsOf`, `sourceWindowKey`, `sourceStartDate`, `sourceEndDate`, plus optional `reportStartDate/reportEndDate`.

### 6. Legacy selected-range recommendations are report-only/context-only

Purpose: guarantee that snapshot-backed or selected-range recommendation fallbacks remain visible only as reporting context and cannot override Decision OS authority.

Setup/fixtures:
- Mock `/api/meta/recommendations` fallback path with `sourceModel: "snapshot_heuristics"` or equivalent existing fallback marker.
- Pair it with a Decision OS route payload that is missing or degraded.
- Include a recommendation whose action conflicts with the deterministic Decision OS action.

Assertions:
- Response or derived UI status labels fallback recommendations as report-only/context-only.
- No fallback item receives queue eligibility, action fingerprint, `sourceDecisionId`, execution support, or apply eligibility.
- Decision OS action display takes precedence whenever deterministic authority exists.

Likely file location:
- `app/api/meta/recommendations/route.test.ts`
- `components/meta/meta-campaign-detail.test.tsx`
- `components/meta/meta-analysis-status-card.test.tsx` for label/status contract.

Blockers/data gaps:
- Current code labels snapshot fallback and Decision OS recommendation context, but a single shared "report-only/context-only" authority flag is not yet visible across API and UI.
- Need final field name for fallback authority state, for example `authority: "report_only"`.

### 7. Missing provenance blocks queue/apply eligibility

Purpose: ensure no action can enter default queue or provider-backed apply without complete decision provenance.

Setup/fixtures:
- Build Command Center actions from Meta and Creative payloads where one item is missing each required provenance field in turn.
- Include a control action with complete provenance.
- Exercise both batch queue selection and execution preview/apply paths.

Assertions:
- Missing `decisionAsOf`, `sourceWindowKey`, source-window dates, `evidenceHash`, or `actionFingerprint` results in `queueEligible: false`.
- `batchReviewEligible` and default queue selection exclude missing-provenance actions.
- `GET /api/command-center/execution` returns `manual_only` or `unsupported`.
- `POST /api/command-center/execution/apply` rejects missing-provenance actions even if workflow status is approved.

Likely file location:
- `lib/command-center.test.ts`
- `app/api/command-center/actions/batch/route.test.ts`
- `app/api/command-center/execution/route.test.ts`
- `app/api/command-center/execution/apply/route.test.ts`

Blockers/data gaps:
- Current Command Center identity relies on `actionFingerprint`, but complete provenance is not yet modeled as a first-class eligibility requirement.
- Execution routes currently resolve by `businessId + actionFingerprint + selected dates`; they need a provenance-aware lookup contract before these assertions can be exact.

### 8. Changing decisionAsOf can change decisions, changing reporting range cannot

Purpose: prove the intended mutable boundary: decisions may move when the authority date moves, not when the report range moves.

Setup/fixtures:
- Build three payloads:
  - A: `decisionAsOf=2026-04-10`, analytics range A.
  - B: `decisionAsOf=2026-04-10`, analytics range B.
  - C: `decisionAsOf=2026-04-11`, analytics range A.
- Fixture C should include changed primary-window evidence that legitimately changes one Meta and one Creative decision.

Assertions:
- A and B primary actions are identical.
- C may differ from A/B in action type, confidence, queue eligibility, evidence hash, and fingerprint.
- Any changed action includes changed `decisionAsOf` and source-window provenance.

Likely file location:
- `lib/meta/decision-os.test.ts`
- `lib/creative-decision-os.test.ts`
- `lib/command-center.test.ts`

Blockers/data gaps:
- Route/source functions need explicit `decisionAsOf` input to make this deterministic without stubbing provider platform date globally.
- Evidence hash semantics must define whether a one-day source-window shift changes all fingerprints or only actions whose evidence changed.

### 9. Same-day/current-day partial data cannot authorize aggressive action

Purpose: prevent partial current-day data from creating scale, pause, cut, push, or apply authority.

Setup/fixtures:
- Mock decision context where `decisionAsOf` is current-day or where source freshness reports partial data.
- Include apparent high-performance or poor-performance same-day rows that would otherwise trigger aggressive action.
- Include safer alternatives such as `hold`, `monitor`, `watchlist`, or `board_only`.

Assertions:
- Aggressive Meta actions such as `pause`, `scale_budget`, `cut`, and material budget shifts are downgraded or blocked.
- Aggressive Creative actions such as `promote_to_scaling` are blocked from queue readiness.
- Evidence envelope records partial freshness and `aggressiveActionBlocked: true` or an equivalent explicit block reason.
- Command Center excludes those actions from default queue and apply eligibility.

Likely file location:
- `lib/meta/decision-os.test.ts`
- `lib/creative-decision-os.test.ts`
- `lib/command-center.test.ts`
- `app/api/command-center/execution/route.test.ts` for apply-preview blocking.

Blockers/data gaps:
- Current `DecisionFreshnessMetadata` supports `partial`, but the provenance contract needs to define how current-day partial detection is represented.
- Need a shared list of "aggressive" action classes for Meta, Creative, GEO, and execution support.

### 10. Snapshot/demo/non-live evidence cannot become push eligible

Purpose: ensure demo, snapshot fallback, and non-live evidence can educate the operator but cannot authorize queue push or provider-backed apply.

Setup/fixtures:
- Build Meta recommendation fallback with snapshot source.
- Build Creative rows with `preview_origin: "snapshot"` or demo business data.
- Build execution live-state fixture with `isDemo: true` or `providerAccessible: false`.
- Include a control live-confident item.

Assertions:
- Snapshot/demo/non-live actions are labeled context/report-only, board-only, manual-only, or unsupported.
- They do not receive default queue eligibility, batch review eligibility, push eligibility, or `ready_for_apply` execution status.
- Execution preflight blocks provider-backed apply with a clear reason.
- Control live-confident item remains eligible to prove the test is not globally disabling the path.

Likely file location:
- `app/api/meta/recommendations/route.test.ts`
- `app/api/creatives/decision-os/route.test.ts`
- `lib/command-center.test.ts`
- `lib/command-center-execution-service.test.ts`
- `app/api/command-center/execution/apply/route.test.ts`

Blockers/data gaps:
- Demo handling exists in creative source and execution service, but route-level provenance does not yet expose a normalized `evidenceSourceMode`.
- Need final terminology for push eligibility versus queue eligibility versus provider-backed apply eligibility.

## Cross-Cutting Blockers

- Add explicit `decisionAsOf` passthrough from public routes to source functions for deterministic tests.
- Define the provenance envelope shape once and reuse it across Meta, Creative, Command Center, and execution tests.
- Define evidence hash canonicalization: stable field order, excluded volatile fields, and whether selected analytics range is excluded.
- Define action fingerprint inputs for Phase 3.1: include provenance and evidence identity, exclude selected reporting range.
- Add a shared test helper for comparing "authority-bearing fields" while allowing reporting/context deltas.
- Add a shared fixture factory for complete, missing, partial, snapshot, demo, and non-live provenance cases.

## Suggested Test Build Order

1. Contract helper tests for provenance envelope validation.
2. Route tests for Meta and Creative provenance passthrough and source-window use.
3. Domain tests for range-firewall stability across analytics ranges.
4. Command Center aggregate tests for queue eligibility and deep-link provenance.
5. Execution route/service tests for missing, partial, demo, snapshot, and non-live blocking.
6. UI/component tests for source-page links and report-only fallback labeling.
