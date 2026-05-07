# Adsecute Phase 2.1 Quality Reviewer

Date: 2026-04-21  
Scope: quality review of all Phase 2 reports in `docs/operator-policy/phase-2/reports/`  
Review posture: docs/review only. No engine code, Creatives logic, Meta recommendation logic, provider state, `main` merge, `main` push, or secrets were changed.

## Verdict

Phase 2 is accepted with conditions.

The report set is internally coherent enough to serve as Phase 3 input. It correctly rejects selected reporting ranges as action authority, audits both Meta and Creative selected-date coupling, identifies the legacy selected-range fallback risk, defines a broad scenario bank, and starts the Phase 3 roadmap with the right first slice: selected-range firewall, per-decision provenance, then Meta deterministic policy.

The conditions are Phase 3.1 entry gates, not reasons to reject Phase 2 doctrine. Before implementation work proceeds beyond the first slice, the team must normalize eligibility vocabulary, convert the scenario bank into fixture-ready tests, and make selected-range/provenance requirements non-optional acceptance criteria.

## Evidence

- The final report states the doctrine clearly: selected reporting ranges are analysis overlays and cannot authorize today's Meta or Creative action; authority comes from `decisionAsOf` and stable complete-provider-day windows.
- The selected-range split is explicit in the final report's table: selected `startDate/endDate` can change reports but cannot change the primary decision or enter execution.
- The code/data audit covers both surfaces. Meta selected-date coupling is found in the Decision OS route, Meta page query keys, campaign detail workflow links, legacy recommendation fallback, and Command Center clients. Creative selected-date coupling is found in the Creative Decision OS route, Creative page query key, selected historical analysis, and page history windows.
- The scenario bank contains the required counts: 50 Meta scenarios, 50 Creative scenarios, 20 cross-page scenarios, 20 do-not-act scenarios, and 20 future push-safety scenarios.
- The scenarios are generally testable: each row has input conditions, expected decision, blocked actions, required evidence, missing-data behavior, UI label, and a test case idea.
- The reports do not overfit to user examples. The final report explicitly says examples are intent signals, not exhaustive rules, and the specialist reports broaden the policy across budget, bid, learning, structure, GEO, placement, creative lifecycle, measurement, profitability, UX, and automation safety.
- Data gaps are usually treated as gaps, not assumptions. The scenario bank opens with "mark it `missing`, `derived`, or `requires extension`," and the code/data audit lists missing product inventory, profit actuals, LTV, reconciliation, attribution basis, pacing, learning state, audience overlap, creative supply, per-decision provenance, and selected-range regression contracts.
- The legacy rule engine audit is specific enough. It names `lib/meta/creative-score-service.ts`, `app/api/meta/recommendations/route.ts`, `lib/ai/generate-creative-decisions.ts`, AI commentary routes, and compatibility vocabulary, then states what to preserve and reject.
- UX recommendations are specific enough to avoid information pollution. The UX report defines first-screen order, collapsed defaults, forbidden copy, bucket names, row evidence density, missing-evidence labels, selected-range separation, and empty-state distinctions.
- The Phase 3 roadmap starts in the right place: contract firewall, per-decision provenance, Meta deterministic policy engine, Command Center rebinding, commercial/measurement truth gates, UX hierarchy, Creative policy engine, and scenario harness.

## Issues By Severity

### High

1. Phase 3.1 must not start by implementing action logic before selected-range identity is removed.
   - Evidence: the code/data audit says Meta and Creative internals are mostly stable-window anchored, but API/page/workflow contracts still accept or key decisions by selected dates. Command Center queue, preview, apply, and rollback still accept selected `startDate/endDate`.
   - Risk: implementation could accidentally preserve the old UX/API contract while adding new rules, making selected reporting slices continue to look authoritative.
   - Required condition: the first Phase 3.1 slice must prove selected analytics range changes cannot mutate primary Meta or Creative decisions for the same `decisionAsOf`.

2. Per-decision provenance is not yet a concrete contract.
   - Evidence: the code/data audit says response-level windows exist, but row-level `decisionSourceWindowKey`, `decisionAsOf`, evidence hash, source query id, and stable decision id are missing.
   - Risk: Command Center, preview, apply, rollback, and audit records cannot safely bind to the exact decision that produced an action.
   - Required condition: every action-bearing Meta, Creative, GEO, placement, no-touch, budget-shift, and Command Center row must carry stable provenance before it can enter queue or execution paths.

3. Legacy selected-range fallback remains a live action-surface risk.
   - Evidence: the legacy audit and code/data audit both identify the Meta recommendations fallback that can rebuild selected-span heuristic recommendations if Decision OS is unavailable.
   - Risk: Phase 3 could leave a bypass where Decision OS failure re-enables selected-range-driven budget, bid, or reallocation guidance.
   - Required condition: fallback recommendations must be labeled non-authoritative, capped to report/watch context, and blocked from action-core, default queue, preview, and apply.

### Medium

4. Push and eligibility vocabulary is not fully normalized across reports.
   - Evidence: reports use several taxonomies: `P0-P5`, `L0-L3`, `action_core/watchlist/manual_only`, Creative `queue_ready/review_queue`, and automation `safe_to_queue/eligible_for_push_when_enabled`.
   - Risk: engineers may map equivalent states inconsistently, especially at Command Center boundaries.
   - Required condition: Phase 3.1 needs one canonical eligibility enum and a mapping table from each specialist vocabulary to that enum.

5. Scenario bank is test-oriented but not fixture-ready.
   - Evidence: all 160 rows include test case ideas, but many expected outputs are prose labels rather than exact machine assertions over fields such as `primaryAction`, `surfaceLane`, `truthState`, `pushEligibility`, `confidenceCap`, `blockedActions`, and provenance.
   - Risk: tests may validate narrative intent without preventing regressions in actual decision payloads.
   - Required condition: convert the bank into structured fixtures before claiming scenario coverage.

6. Several scenarios depend on data that the audit says does not exist yet.
   - Evidence: creative-by-GEO, placement-by-format, product/SKU stock, order distribution, attribution reconciliation, learning status, account/payment issues, audience overlap, and creative supply are identified as missing or extension-needed.
   - Risk: implementation may infer unavailable fields from adjacent metrics.
   - Required condition: each fixture must declare unavailable fields as `missing`, `derived`, or `requires_extension`, with explicit confidence and eligibility caps.

7. Specialist reports define strong policy but not a single precedence compiler.
   - Evidence: measurement, profitability, delivery, bid, budget, structure, UX, and safety reports all define ceilings and blockers.
   - Risk: two valid policies may produce different ceilings unless the compiler order is explicit.
   - Required condition: Phase 3.1 should define precedence order: identity/freshness/provenance, selected-range firewall, commercial truth, measurement truth, delivery/learning, structure/budget/bid, creative compatibility, then UX/push presentation.

### Low

8. Some UX labels use "Do this" for manual-only recommendations.
   - Evidence: scenario labels include "Do this: review campaign budget", "Do this: pool geos", and "Do this: promote creative" while the same rows correctly block native push.
   - Risk: non-experts may read "Do this" as executable rather than manual/review.
   - Required condition: Phase 3 UI copy should pair every "Do this" manual row with visible `manual_handoff`, `review_queue`, or `blocked_from_push` eligibility.

9. Legacy transport/cache fields are identified but not promoted into a formal compatibility artifact.
   - Evidence: the legacy audit names `ruleVersion`, `computedAt`, `freshnessState`, selected snapshot fields, `analysisKey`, `source`, `warning`, `analysisSource`, and commentary envelope fields as missing from current policy work.
   - Risk: old consumers may keep relying on legacy shape without clear suppression rules.
   - Required condition: add a small compatibility contract before touching legacy consumers.

## Review Answers

1. Internally consistent: yes, with the vocabulary-normalization condition above.
2. Overfit to examples: no. Examples are correctly generalized into authority, evidence, and safety gates.
3. Required scenario counts: yes. The bank contains 50 Meta, 50 Creative, 20 cross-page, 20 do-not-act, and 20 push-safety scenarios.
4. Scenarios testable: mostly yes, but they must be converted into structured fixtures before Phase 3.1 can claim regression coverage.
5. Reporting range vs Operator Decision Context separated: yes, clearly and repeatedly.
6. Meta and Creative audited for selected-date coupling: yes, both at code/data and final-report levels.
7. Data gaps marked rather than assumed: mostly yes. Phase 3 fixtures must preserve that behavior.
8. Old rule engine findings specific enough: yes.
9. UX recommendations specific enough: yes.
10. Phase 3 roadmap first slice: yes. Start with selected-range firewall and provenance before policy expansion.

## Required Conditions Before Phase 3.1

1. Define one canonical decision/queue/push eligibility enum and map every specialist vocabulary into it.
2. Split decision route inputs into `decisionAsOf` authority and `analyticsStartDate/insights/analyticsEndDate` context.
3. Remove selected dates from Decision OS query identity for primary Meta and Creative decisions.
4. Add per-decision provenance fields: stable decision id, `decisionAsOf`, source window key, source window dates, source row scope, source query id, evidence hash, and action fingerprint.
5. Block Command Center queue, preview, apply, rollback, and workflow links unless provenance is present and current.
6. Demote legacy selected-range fallback recommendations to explicitly non-authoritative report/watch context.
7. Convert the 160 scenario rows into structured regression fixtures with exact expected fields and confidence/eligibility ceilings.
8. For unavailable data, require explicit `missing`, `derived`, or `requires_extension` state; never infer product, attribution, learning, placement, audience, or creative-supply facts from adjacent metrics.
9. Add selected-range firewall regression tests for both Meta and Creative: same `decisionAsOf`, different analytics ranges, identical primary decisions and eligibility.
10. Add a minimal legacy compatibility contract for snapshot/cache/commentary outputs and their suppression rules.

## Acceptance

Phase 2 is accepted with conditions.

Phase 3.1 may begin only as the selected-range firewall, provenance, eligibility-normalization, and scenario-fixture slice. Meta deterministic policy implementation should follow that slice. Creative implementation should follow after the same selected-range and provenance gates apply to Creative, unless production evidence shows Creative selected-window harm is more urgent than Meta's legacy fallback and Command Center date coupling.
