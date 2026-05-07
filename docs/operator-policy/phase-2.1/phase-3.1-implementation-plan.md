# Phase 3.1 Implementation Plan: Decision Range Firewall + Provenance Contract

Date: 2026-04-21  
Repo: `/Users/harmelek/Adsecute`  
Scope: implementation planning only. No application code, Creatives logic, Meta recommendation logic, provider writes, `main` merge, `main` push, or secret access is authorized by this document.

## Goal

Phase 3.1 must make this invariant true:

Changing the UI selected reporting range must not change primary Decision OS actions for the same `businessId`, `decisionAsOf`, source rows, commercial truth, and business state.

The first implementation slice is only:

1. Decision Range Firewall.
2. Provenance Contract.

It is not the full Meta policy engine. It must not introduce new Meta policy decisions, change Creatives decision logic, or rewrite recommendation heuristics beyond labeling/demoting legacy fallback authority.

## Current Code Findings

The shared model already has the correct concepts:

- `src/types/operator-decision.ts` separates `analyticsWindow` from `recent7d`, `primary30d`, and `baseline90d`.
- `lib/operator-decision-metadata.ts` builds decision windows from `decisionAsOf`.
- `lib/meta/operator-decision-source.ts` fetches primary Meta source rows from `decisionWindows.primary30d`.
- `lib/creative-decision-os-source.ts` fetches Creative primary decision rows from `primary30d` and selected-period rows separately for historical analysis.

The contract flaw is that selected `startDate/endDate` still travel through routes, query keys, links, queue reconstruction, preview, apply, rollback, and fallback recommendations.

Primary hotspots:

- `app/api/meta/decision-os/route.ts` reads `startDate/endDate`.
- `app/api/creatives/decision-os/route.ts` reads `startDate/endDate`.
- `app/api/meta/recommendations/route.ts` requires selected dates and can fall back to selected-range heuristics.
- `app/(dashboard)/platforms/meta/page.tsx` keys Decision OS and recommendations by selected dates.
- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx` keys Creative Decision OS by selected dates.
- `components/meta/meta-campaign-detail.tsx` and `components/platforms/meta/creatives/CreativeDetailExperience.tsx` build Command Center links with selected dates.
- `lib/command-center.ts`, `lib/command-center-service.ts`, `src/services/data-service-command-center.ts`, and Command Center routes reconstruct workflow actions from selected dates.
- Execution preview/apply/rollback routes still accept selected `startDate/endDate`.

## Required Contract Terms

Add or standardize these terms before any policy expansion:

- `decisionAsOf`: complete provider-day anchor for the decision.
- `analyticsStartDate` / `analyticsEndDate`: selected reporting range, role `analysis_only`.
- `sourceWindowKey`: the decision source window key, initially `primary30d` for action-bearing rows unless a row is explicitly non-action context.
- `sourceWindowStartDate` / `sourceWindowEndDate`: actual source window dates used for the action-bearing source rows.
- Stable decision id: deterministic id for the source decision, independent of selected analytics range.
- Source row scope: exact source entity scope used to build the decision.
- Evidence hash: deterministic hash of the normalized evidence envelope that authorizes the decision.
- Action fingerprint: Command Center workflow identity derived from stable provenance, not selected analytics dates.

## Target Contract Shape

Add a shared type in `src/types/operator-decision.ts`:

```ts
export interface OperatorDecisionProvenance {
  contractVersion: "operator-decision-provenance.v1";
  decisionAsOf: string;
  sourceWindowKey: OperatorDecisionWindowKey;
  sourceWindowStartDate: string;
  sourceWindowEndDate: string;
  stableDecisionId: string;
  sourceRowScope: {
    provider: "meta" | "creative";
    entityType: string;
    entityIds: string[];
    businessId: string;
  };
  evidenceHash: string;
  sourceQueryId: string;
}
```

Rules:

- `analyticsStartDate/insights/analyticsEndDate` must never be included in `stableDecisionId`, `evidenceHash`, or action fingerprint inputs.
- `sourceQueryId` must be deterministic and based on business, provider, entity scope, `decisionAsOf`, `sourceWindowKey`, and source window dates.
- `evidenceHash` must hash a normalized JSON object with sorted keys and stable numeric/string values. Do not include `generatedAt`, UI labels that can be translated, selected analytics dates, or array order unless the order is semantically part of evidence.
- For Phase 3.1, provenance is additive to existing payloads. Existing `startDate/endDate` response fields may remain as compatibility aliases if clearly backed by `analyticsWindow`, but new code must use `analyticsStartDate/insights/analyticsEndDate`.

## Implementation Sequence

### 1. Add Provenance Helpers

Files:

- `src/types/operator-decision.ts`
- `lib/operator-decision-metadata.ts`
- new helper module, recommended: `lib/operator-decision-provenance.ts`
- tests: `lib/operator-decision-metadata.test.ts` or new `lib/operator-decision-provenance.test.ts`

Plan:

- Add `OperatorDecisionProvenance`.
- Add helper functions:
  - `normalizeDecisionEvidenceForHash(value)`.
  - `buildEvidenceHash(value)`.
  - `buildSourceQueryId(input)`.
  - `buildStableDecisionId(input)`.
  - `buildOperatorDecisionProvenance(input)`.
- Use Node `crypto` SHA-256, truncated only for UI-friendly ids if needed; keep full hash where execution safety needs exact matching.

Acceptance:

- Same input with different object key order produces the same `evidenceHash`.
- Changing `analyticsStartDate/insights/analyticsEndDate` does not change provenance.
- Changing `decisionAsOf`, `sourceWindowKey`, source dates, entity ids, or evidence does change provenance.

### 2. Rename Decision Route Inputs

Files:

- `app/api/meta/decision-os/route.ts`
- `app/api/creatives/decision-os/route.ts`
- `lib/meta/decision-os-source.ts`
- `lib/creative-decision-os-source.ts`
- `lib/meta/operator-decision-source.ts`
- `src/services/data-service-ai.ts`
- Meta page fetch helper in `app/(dashboard)/platforms/meta/page.tsx`

Plan:

- Accept `analyticsStartDate/insights/analyticsEndDate` as the primary public query names.
- Keep `startDate/endDate` as temporary deprecated aliases only for compatibility, mapping them immediately to analytics names.
- Add optional `decisionAsOf`; default remains server-resolved provider previous complete date.
- Rename internal source inputs from `startDate/endDate` to `analyticsStartDate/insights/analyticsEndDate` where they represent selected reporting context.
- Preserve selected-period Creative historical analysis, but make it visibly fed by `analyticsStartDate/insights/analyticsEndDate`, not the decision identity.

Acceptance:

- Route tests assert `analyticsStartDate/insights/analyticsEndDate` are passed to `analyticsWindow`.
- Route tests assert `decisionAsOf` controls `primary30d`.
- Compatibility tests assert old `startDate/endDate` still work temporarily but are not used as action identity.

### 3. Add Provenance To Action-Bearing Rows

Files:

- `lib/meta/decision-os.ts`
- `lib/creative-decision-os.ts`
- `lib/meta/decision-os-linkage.ts`
- contract tests under `lib/meta/decision-os.test.ts`, `lib/creative-decision-os.test.ts`, component contract helpers as needed.

Rows requiring provenance:

- Meta `campaigns`.
- Meta `adSets`.
- Meta `budgetShifts`.
- Meta `geoDecisions`.
- Meta `placementAnomalies`.
- Meta `noTouchList`.
- Meta `winnerScaleCandidates`.
- Creative `creatives`.
- Creative opportunity/action rows that can enter Command Center.

Plan:

- Add `provenance: OperatorDecisionProvenance` to action-bearing row interfaces.
- For Meta ad set decisions, use entity scope `["campaignId", "adSetId"]` values in a deterministic object, with entity ids sorted only where order is not semantic.
- For budget shifts, include both donor and recipient campaign ids in source row scope.
- For GEO and placement rows, use normalized geo/placement key plus decision source window.
- For Creative rows, use `creativeId`, family id if action authority depends on family context, and linked campaign/ad set ids where present.
- Use existing `decisionId` as an input only after stabilizing it. If a current `decisionId` is entity/action based, keep it but back it with `stableDecisionId`.

Acceptance:

- Every action-bearing row has `provenance`.
- No provenance object includes selected analytics dates.
- Existing tests comparing selected analytics windows are expanded to also compare `stableDecisionId`, `sourceWindowKey`, source window dates, `evidenceHash`, and primary action fields.

### 4. Rebind Command Center Identity

Files:

- `lib/command-center.ts`
- `lib/command-center-service.ts`
- `src/services/data-service-command-center.ts`
- `app/api/command-center/route.ts`
- `app/api/command-center/actions/route.ts`
- `app/api/command-center/actions/note/route.ts`
- `app/api/command-center/actions/batch/route.ts`
- `app/api/command-center/feedback/route.ts`
- `app/api/command-center/execution/route.ts`
- `app/api/command-center/execution/apply/route.ts`
- `app/api/command-center/execution/rollback/route.ts`
- `lib/command-center-execution.ts`
- `lib/command-center-execution-service.ts`

Plan:

- Extend `CommandCenterActionSourceContext` with `provenance`.
- Change `createActionFingerprint` input to include:
  - action fingerprint version,
  - source system/type,
  - recommended action,
  - `provenance.stableDecisionId`,
  - `provenance.decisionAsOf`,
  - `provenance.sourceWindowKey`,
  - `provenance.sourceWindowStartDate`,
  - `provenance.sourceWindowEndDate`,
  - `provenance.evidenceHash`.
- Exclude `analyticsStartDate/insights/analyticsEndDate`, source deep links, UI labels, and `generatedAt`.
- Replace `findCommandCenterActionForRange` with `findCommandCenterActionForDecisionContext`, accepting `decisionAsOf` and action fingerprint/provenance, not selected dates.
- Command Center GET may still accept analytics dates for historical intelligence panels, but workflow mutation, note, batch, feedback action-scope lookup, preview, apply, and rollback must resolve by provenance.

Acceptance:

- Same selected analytics range changes do not change action fingerprints.
- Changing evidence hash changes action fingerprint and invalidates old preview/apply.
- Workflow mutations can resolve actions with `decisionAsOf` and action fingerprint without selected dates.
- Handoff-linked actions store provenance-bearing action fingerprints.

### 5. Rebind Workflow Links And Handoffs

Files:

- `components/meta/meta-campaign-detail.tsx`
- `components/platforms/meta/creatives/CreativeDetailExperience.tsx`
- `components/command-center/CommandCenterDashboard.tsx`
- `app/(dashboard)/command-center/page.tsx`
- `lib/command-center.ts`
- `app/api/command-center/handoffs/route.ts`
- `lib/command-center-store.ts`

Plan:

- Source pages should link with `decisionAsOf` and `actionFingerprint` when targeting a workflow action.
- Selected reporting dates may remain in links only as `analyticsStartDate/insights/analyticsEndDate` for display context, never for action resolution.
- Extend handoff records to carry linked action provenance snapshots or, at minimum, linked provenance-bearing action fingerprints plus `decisionAsOf`.
- Keep handoff text free-form; do not attempt policy decisions in handoff code.

Acceptance:

- Opening Command Center from Meta/Creative resolves the same action when selected page range changes.
- Handoffs show linked action fingerprints that are stable across analytics ranges.
- Handoffs do not need selected dates to acknowledge or edit.

### 6. Mark Legacy Recommendations Fallback As Non-Authoritative

Files:

- `app/api/meta/recommendations/route.ts`
- `lib/meta/recommendations.ts`
- `components/meta/meta-account-recs.tsx`
- `components/meta/meta-campaign-detail.tsx`
- tests: `app/api/meta/recommendations/route.test.ts`, component tests around fallback labeling.

Plan:

- Do not rewrite recommendation logic in Phase 3.1.
- Add explicit response fields when fallback is used:
  - `analysisSource.system = "snapshot_fallback"`.
  - `analysisSource.authority = "non_authoritative_selected_range_context"`.
  - `analysisSource.canEnterCommandCenter = false`.
  - `analysisSource.canEnterExecution = false`.
- Ensure fallback recommendations cannot be mapped into Command Center actions.
- UI copy should label fallback recommendations as selected-range context/watch/report only.

Acceptance:

- Decision OS-backed recommendations can remain authoritative only when provenance exists.
- Snapshot fallback route responses are explicitly non-authoritative.
- Component tests assert fallback labels do not imply action-core or execution eligibility.

### 7. Query Keys And Client Contracts

Files:

- `app/(dashboard)/platforms/meta/page.tsx`
- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`
- `components/meta/meta-campaign-detail.tsx`
- `components/platforms/meta/creatives/CreativeDetailExperience.tsx`
- `components/command-center/CommandCenterDashboard.tsx`
- `src/services/data-service-ai.ts`
- `src/services/data-service-command-center.ts`

Plan:

- Decision OS query keys should use:
  - business id,
  - `decisionAsOf` or server-resolved decision context key,
  - stable source window key/version.
- They may include analytics dates only in a nested/display subquery or selected-period analysis query, not the primary action identity.
- Split Command Center query identity:
  - workflow/action query: business id + `decisionAsOf`.
  - historical intelligence/display query: business id + `analyticsStartDate/insights/analyticsEndDate`.

Acceptance:

- Changing UI selected reporting range does not invalidate/refetch primary Decision OS action query as if it were a new decision.
- Selected-period tables and historical panels still update with analytics dates.
- Existing UX remains functional with clearer labels.

### 8. Execution Preview, Apply, Rollback Guard

Files:

- `lib/command-center-execution.ts`
- `lib/command-center-execution-service.ts`
- `app/api/command-center/execution/route.ts`
- `app/api/command-center/execution/apply/route.ts`
- `app/api/command-center/execution/rollback/route.ts`
- `src/services/data-service-command-center.ts`

Plan:

- Add provenance fields to `CommandCenterExecutionPreview`.
- Include provenance and `evidenceHash` in preview hash.
- Apply must reject when:
  - submitted action fingerprint does not match current provenance,
  - submitted preview hash was built from a different evidence hash,
  - submitted request contains only selected dates and no decision provenance,
  - live provider target no longer matches the resolved provenance target.
- Rollback should resolve by action fingerprint/provenance and latest execution state, not selected dates.

Acceptance:

- Preview hash changes when evidence hash changes.
- Apply rejects stale evidence.
- Apply and rollback tests no longer require selected `startDate/endDate` to resolve the action.

## Test Plan

Add focused regression tests before broader policy work:

- `lib/operator-decision-provenance.test.ts`: hash stability, analytics-date exclusion, source-window sensitivity.
- `lib/meta/decision-os.test.ts`: same `decisionAsOf`, same rows, different analytics dates -> identical Meta primary action fields and provenance.
- `lib/creative-decision-os.test.ts`: same invariant for Creative primary action fields and provenance; selected historical analysis may differ.
- `app/api/meta/decision-os/route.test.ts`: `analyticsStartDate/insights/analyticsEndDate` contract and legacy alias behavior.
- `app/api/creatives/decision-os/route.test.ts`: same route contract.
- `app/api/meta/recommendations/route.test.ts`: fallback is `non_authoritative_selected_range_context`.
- `lib/command-center.test.ts`: action fingerprints use provenance and remain stable across analytics ranges.
- `lib/command-center-service.test.ts` or route tests: action lookup by `decisionAsOf`/fingerprint without selected dates.
- `lib/command-center-execution-service.test.ts`: preview/apply stale evidence rejection.
- `components/meta/meta-campaign-detail.test.tsx` and Creative detail tests: Command Center links pass `decisionAsOf` and action fingerprint, not selected date authority.

Primary assertion shape:

```ts
expect(projectPrimaryActions(aprilPayload)).toEqual(projectPrimaryActions(marchPayload));
expect(projectProvenance(aprilPayload)).toEqual(projectProvenance(marchPayload));
expect(aprilPayload.analyticsWindow).not.toEqual(marchPayload.analyticsWindow);
```

Projection fields should include only action authority:

- stable decision id,
- source window key and dates,
- evidence hash,
- entity scope,
- primary action/recommended action,
- action size where present,
- trust lane,
- truth state,
- queue eligibility,
- action fingerprint.

## Backward Compatibility

During Phase 3.1 only:

- Continue accepting old `startDate/endDate` on decision routes as aliases for analytics dates.
- Continue returning top-level `startDate/endDate` if existing consumers require them, but document them as deprecated aliases for `analyticsWindow.startDate/endDate`.
- Do not migrate persisted Command Center state destructively.
- New action fingerprints may differ after provenance is introduced. Keep old workflow rows readable as historical records, but new mutations should require provenance-backed fingerprints.

## Out Of Scope

Explicitly do not implement in Phase 3.1:

- Full Meta policy engine.
- New evidence floors, bid policy, budget pacing logic, learning logic, or profitability policy.
- Changes to Creatives decision logic.
- Changes to Meta recommendation heuristics beyond authority labeling and suppression from workflow/execution.
- Provider write expansion.
- New apply-supported action classes.
- Broad UX redesign into final operator buckets.
- Database normalization unrelated to provenance/workflow binding.

## Definition Of Done

Phase 3.1 is complete when:

- Decision routes expose `analyticsStartDate/insights/analyticsEndDate` and `decisionAsOf`.
- Primary Decision OS actions are keyed by decision provenance, not selected reporting dates.
- Every action-bearing Decision OS row includes provenance.
- Command Center action fingerprinting uses provenance and excludes analytics dates.
- Workflow links, handoffs, queue lookup, preview, apply, and rollback bind to provenance.
- Legacy fallback recommendations are explicitly non-authoritative selected-range context and cannot enter Command Center or execution.
- Tests prove selected reporting range changes do not mutate primary Meta or Creative action outputs for the same `decisionAsOf` and source state.
