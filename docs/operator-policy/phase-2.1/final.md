# Adsecute Phase 2.1 Final Report

Date: 2026-04-21  
Scope: final docs/report synthesis for Adsecute Phase 2.1. This file does not implement engine code, change Creatives logic, change Meta recommendation logic, merge `main`, push `main`, or expose secrets.

## 1. Phase 2 Acceptance

Phase 2 is accepted with conditions.

The Phase 2 report set is coherent enough to become Phase 3 input. It establishes the core doctrine that selected reporting ranges are analysis overlays only, while action authority must come from `decisionAsOf`, stable complete-provider-day windows, deterministic policy, commercial truth, measurement truth, source freshness, and execution safety.

The acceptance conditions are Phase 3.1 entry gates, not reasons to reject Phase 2:

- Normalize decision, queue, and push eligibility vocabulary into one canonical contract.
- Convert the 160 scenario rows into structured fixture-ready regression tests.
- Add selected-range firewall tests for Meta and Creative before full policy expansion.
- Add per-decision provenance before Command Center queue, preview, apply, rollback, or workflow links can rely on any action.
- Demote legacy selected-range fallback recommendations to non-authoritative report/watch context.

## 2. Quality Issues Found

High-severity issues:

- Phase 3.1 must not start with action logic before selected-range identity is removed from primary decision authority.
- Per-decision provenance is not yet a concrete payload contract.
- The legacy Meta selected-range fallback remains a live action-surface risk unless explicitly demoted.

Medium-severity issues:

- Eligibility vocabulary is not normalized across `P0-P5`, `L0-L3`, `action_core`, `watchlist`, `manual_only`, `queue_ready`, `review_queue`, `safe_to_queue`, and `eligible_for_push_when_enabled`.
- The scenario bank is test-oriented but not fixture-ready.
- Some scenarios depend on unavailable or extension-needed data, including inventory, profit actuals, attribution reconciliation, learning state, placement detail, audience overlap, and creative supply.
- Specialist policy reports need one explicit compiler precedence order.

Low-severity issues:

- Some manual-only UX labels such as "Do this" need visible `manual_handoff`, `review_queue`, or `blocked_from_push` eligibility.
- Legacy compatibility fields need a small compatibility contract before legacy consumers are touched.

## 3. Source Gaps

The source review is sufficient for Phase 2 acceptance, but these gaps must be resolved before stronger deterministic production claims:

- Capture official Meta support for the current full list of significant edits.
- Capture official Meta source text for learning-limited wording and delivery-status hierarchy if the gated Help Center pages remain inaccessible.
- Capture the official Meta developer changelog for January 12, 2026 Ads Insights attribution-window and retention-limit changes before using those changes as deterministic policy.
- Capture the official Meta developer changelog for June 10, 2025 `action_report_time` / unified-attribution behavior before using it as deterministic policy.
- Do not cite community "20% budget change" rules as Meta policy unless official documentation is found.
- Treat the three-complete-provider-day cooldown as labeled Adsecute conservative safety, not as a Meta official threshold.

## 4. Scenario Bank Sufficiency

The scenario bank is sufficient for Phase 2 acceptance as a policy and acceptance-test source.

It contains the required 160 scenarios:

- 50 Meta scenarios.
- 50 Creative scenarios.
- 20 cross-page scenarios.
- 20 do-not-act scenarios.
- 20 future push-safety scenarios.

It is not yet sufficient as an executable test harness. Phase 3.1 must convert the rows into structured fixtures with exact expected fields, including `primaryAction`, `surfaceLane`, `truthState`, `pushEligibility`, `confidenceCap`, `blockedActions`, provenance, missing-data state, and action fingerprint behavior.

## 5. Selected-Date Coupling

Selected-date coupling is confirmed.

Meta coupling exists in the Decision OS route, Meta page query keys, recommendation query behavior, campaign-detail workflow links, the legacy selected-range fallback, Command Center clients, and execution preview/apply/rollback paths.

Creative coupling exists in the Creative Decision OS route, Creative page query key, selected historical analysis, detail workflow links, and selected page history windows.

The important nuance is that core source-window concepts already exist in the codebase, but the public API, query identity, workflow links, and execution contracts still allow selected reporting dates to look action-authoritative.

## 6. Phase 3.1 Implementation Sequence

Phase 3.1 must start with selected-range firewall and provenance contract. Do not implement the full Meta or Creative policy engine until firewall tests pass.

Exact sequence:

1. Add provenance helpers.
   - Add `OperatorDecisionProvenance`.
   - Add hash normalization, evidence hash, source query id, stable decision id, and provenance builder helpers.
   - Prove analytics dates do not change provenance.

2. Rename decision route inputs.
   - Accept `analyticsStartDate/insights/analyticsEndDate`.
   - Keep `startDate/endDate` only as deprecated aliases.
   - Add optional `decisionAsOf`.
   - Ensure selected-period Creative analysis remains context only.

3. Add provenance to action-bearing rows.
   - Cover Meta campaigns, ad sets, budget shifts, GEO decisions, placement anomalies, no-touch rows, winner scale candidates, Creative rows, and Creative opportunity/action rows.
   - Exclude analytics dates from provenance.

4. Rebind Command Center identity.
   - Build action fingerprints from provenance, evidence hash, action type, and decision context.
   - Replace range-based action lookup with decision context and provenance lookup.
   - Require provenance for queue, mutation, preview, apply, rollback, notes, batch, and feedback action scope.

5. Rebind workflow links and handoffs.
   - Link with `decisionAsOf` and action fingerprint.
   - Keep selected analytics dates only as display context.
   - Store provenance-bearing action fingerprints in handoffs.

6. Mark legacy recommendations fallback as non-authoritative.
   - Use `analysisSource.system = "snapshot_fallback"`.
   - Use `analysisSource.authority = "non_authoritative_selected_range_context"`.
   - Set `canEnterCommandCenter = false`.
   - Set `canEnterExecution = false`.

7. Update query keys and client contracts.
   - Primary Decision OS query identity uses business id, `decisionAsOf`, and source window key/version.
   - Analytics dates may key reporting/context panels only.
   - Command Center action queries use business id plus `decisionAsOf`.

8. Add execution preview, apply, and rollback guard.
   - Include provenance and evidence hash in preview hash.
   - Reject stale evidence, missing provenance, selected-date-only requests, and live target mismatches.
   - Resolve rollback by provenance/action fingerprint and execution state, not selected dates.

## 7. Tests To Write First

Exact first test build order:

1. `lib/operator-decision-provenance.test.ts`
   - Validate provenance envelope shape.
   - Validate hash stability across object key order.
   - Validate analytics-date exclusion.
   - Validate sensitivity to `decisionAsOf`, source window, entity ids, and evidence.

2. `app/api/meta/decision-os/route.test.ts`
   - Assert `analyticsStartDate/insights/analyticsEndDate` map to `analyticsWindow`.
   - Assert `decisionAsOf` controls `primary30d`.
   - Assert legacy `startDate/endDate` aliases still work temporarily but do not become action identity.

3. `app/api/creatives/decision-os/route.test.ts`
   - Assert the same route contract for Creative.
   - Assert selected-period rows may affect historical/context output only.

4. `lib/meta/decision-os.test.ts`
   - Same `decisionAsOf`, same source rows, different analytics ranges must produce identical Meta primary action fields and provenance.

5. `lib/creative-decision-os.test.ts`
   - Same invariant for Creative primary fields and provenance, while selected historical analysis may differ.

6. `lib/command-center.test.ts`
   - Action fingerprints use provenance.
   - Fingerprints stay stable across analytics range changes.
   - Missing provenance blocks queue eligibility.

7. Command Center service or route tests.
   - Resolve actions by `decisionAsOf` and provenance/action fingerprint without selected dates.
   - Reject missing, partial, demo, snapshot, and non-live evidence from queue/apply paths.

8. `lib/command-center-execution-service.test.ts` and execution route tests.
   - Preview hash changes when evidence hash changes.
   - Apply rejects stale evidence and selected-date-only requests.
   - Rollback resolves by provenance/action fingerprint.

9. `app/api/meta/recommendations/route.test.ts`
   - Fallback is `non_authoritative_selected_range_context`.
   - Fallback cannot create queue eligibility, action fingerprint, source decision id, execution support, or apply eligibility.

10. Component/link tests.
   - `components/meta/meta-campaign-detail.test.tsx`.
   - Creative detail test beside `CreativeDetailExperience.tsx` if no current test exists.
   - Assert Command Center links pass `decisionAsOf` and action fingerprint, with selected dates only as reporting context.

Primary assertion shape:

```ts
expect(projectPrimaryActions(aprilPayload)).toEqual(projectPrimaryActions(marchPayload));
expect(projectProvenance(aprilPayload)).toEqual(projectProvenance(marchPayload));
expect(aprilPayload.analyticsWindow).not.toEqual(marchPayload.analyticsWindow);
```

## 8. Open PR For Phase 2 Docs

Open a PR for the Phase 2 and Phase 2.1 docs.

The PR should be docs-only and should explicitly state that it does not implement engine code, change Creatives logic, change Meta recommendation logic, merge `main`, push `main`, or expose secrets.

## 9. Merge Phase 2 Docs

Merge the Phase 2 docs after docs review confirms the report-only scope and the Phase 3.1 conditions are preserved.

The merge should not be blocked by the Phase 3.1 implementation conditions. Those conditions are gates for implementation, not rejection criteria for the policy package.

## 10. Start Phase 3.1 Implementation

Start Phase 3.1 implementation only as the selected-range firewall and provenance contract slice.

Do not implement the full Meta deterministic policy engine until the firewall/provenance tests pass.

Do not implement the Creative policy engine until the same selected-range and provenance gates apply to Creative.

Allowed first implementation scope:

- `analyticsStartDate/insights/analyticsEndDate` route contract.
- `decisionAsOf` passthrough.
- provenance helpers and action-bearing provenance fields.
- Command Center fingerprint rebinding.
- workflow link/handoff rebinding.
- legacy fallback authority labeling and suppression from workflow/execution.
- tests proving selected reporting range changes do not mutate primary Meta or Creative decisions for the same `decisionAsOf` and source state.

Final recommendation: Phase 2 is accepted with conditions. Open and merge the docs PR after review. Begin Phase 3.1 with the selected-range firewall and provenance contract only.
