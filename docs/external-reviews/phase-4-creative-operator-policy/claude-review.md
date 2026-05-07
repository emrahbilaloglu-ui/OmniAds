# Phase 4 Independent Review — Creative Operator Policy Foundation

Reviewer: Claude Code (external, independent)
Date: 2026-04-22
Branch reviewed: `feature/adsecute-creative-operator-policy`
Merge status: Already merged to main via PR #20 (commit c80de2d)
Charter: `docs/external-reviews/CLAUDE_REVIEW_CHARTER.md`

---

## A. Executive Verdict

**PASS WITH CONDITIONS**

The phase is sound on its core safety guarantees. Evidence source gating, provenance requirements, push eligibility conservatism, and decision window separation are implemented correctly and verified by tests. The 1941-test suite passes cleanly with zero TypeScript errors.

Three issues are flagged that should be addressed before Phase 5 extends the Creative policy. They do not block the current merged state but would create compounding risk if ignored.

---

## B. Repository State

- Branch `feature/adsecute-creative-operator-policy` merged to main via PR #20 (commit c80de2d on 2026-04-22).
- No uncommitted changes at time of review.
- Main was not touched directly. The merge was via a proper PR.
- 15 files changed, 1,512 insertions, 38 deletions in the Creative phase commit.
- Phase 3 Meta files were also included in the diff (5 files). This is consistent with the Phase 3 hardening that preceded Phase 4.
- No secrets, tokens, or raw business identifiers observed in changed code.

---

## C. Phase Goal Alignment

### Stated goals (from final.md)
- Deterministic Creative operator policy with 14 segments and shared operator states
- Evidence-source safety for live/demo/snapshot/fallback/unknown
- Per-creative operatorPolicy with segment, state, pushReadiness, requiredEvidence, missingEvidence, blockers, explanation
- Decision window integrity preserved (selected range = analysis only)
- Command Center propagation of Creative operator policy
- Command Center blocking for missing policy and non-queue-eligible Creative rows
- Minimal UI integration in existing Decision Support drawer
- Filter support for operatorSegment, operatorState, pushReadiness

### Actual accomplishments (verified from code)

All stated goals are implemented. Specifically:

**creative-operator-policy.ts**: Deterministic policy function with 14 segments, 6 states, 5 push readiness levels. ROAS-only evidence correctly blocked from scale/kill. Evidence floors enforced. Commercial truth required for aggressive actions. Provenance required for queue eligibility. Non-live evidence fails closed. ✓

**creative-decision-os-source.ts**: Evidence source propagated from Meta creatives API into Decision OS. Combines sources conservatively (worst-case). Selected period feeds only into historicalAnalysis, not primary decisions. ✓

**command-center.ts**: Creative rows propagate operatorPolicy. `mapCreativeOpportunityToCommandCenter` rechecks row-level policy before passing queue eligibility. `decorateCommandCenterActionsWithThroughput` blocks throughput when Creative policy is missing or policy.queueEligible is false. ✓

**CreativeDecisionOsOverview.tsx**: Operator Policy section added with segment, state, push readiness, evidence source, missing evidence. Historical analysis labeled as "selected period" and "descriptive, not decision-authoritative." Decision window metadata shown to operator ("Decisions use live windows. Selected period affects analysis only."). ✓

**Filter support**: operatorSegment, operatorState, pushReadiness added to filter builder and applyCreativeFilters. ✓

### Not started (intentional)
- Provider-backed Creative execution: correctly not implemented. `canApply` is false for all Creative rows.
- Cross-page conflict detection: deferred to Phase 5, correctly noted in handoff.

---

## D. Deterministic Decision Safety

### ROAS-only protection
`hasRoasOnlyPositiveSignal` checks: ROAS >= 2 AND (spend < 120 OR purchases < 2). This is correctly checked BEFORE `isUnderSampled`, so a tiny-spend ROAS spike returns `false_winner_low_evidence` before the under-sampled path fires. ✓

### Evidence floors
`hasScaleEvidence`: spend >= 250 AND purchases >= 5 AND economics.status === "eligible". These floors are reasonable and not trivially defeatable.
`hasKillEvidence`: spend >= 250 AND (purchases >= 4 OR impressions >= 8000). Reasonable.

### Commercial truth requirement
Aggressive actions (promote_to_scaling, block_deploy, refresh_replace) require `commercialTruthConfigured: true`. Missing commercial truth blocks aggressive action and adds "commercial_truth" to missingEvidence. ✓

### Protected winners
`hold_no_touch` primaryAction → `protected_winner` segment → `do_not_touch` state → `blocked_from_push`. ✓
`protected_watchlist` operatorDisposition → same path. ✓

### Non-live evidence
Non-live evidence (`demo`, `snapshot`, `fallback`, `unknown`) → `contextual_only` segment → `contextual_only` state → `blocked_from_push`. ✓
The `combineCreativeEvidenceSource` function uses worst-case: unknown > fallback > snapshot > demo > live. ✓

### canApply
Set to `false` unconditionally for all Creative policy assessments. No Creative provider execution contract exists. ✓

---

## E. Decision Window Integrity

### Fingerprint stability
Test at command-center.test.ts:1273 verifies that fingerprints are identical when analytics range changes from April to March while Decision OS fixture data is the same. **PASS.**

Test at command-center.test.ts:1394 verifies that fingerprints DO change when `decisionAsOf` changes even if the analytics window is fixed. **PASS.**

### Reporting range vs primary decision data
`resolveCreativeDecisionTimeline` in creative-decision-os-source.ts separates:
- `reportingStartDate`/`reportingEndDate` (user's selected range) → used only for `selectedPeriod` fetch → feeds only into `historicalAnalysis`
- `analyticsStartDate`/`analyticsEndDate` → falls back to reporting range if not separately provided, but this only affects `analyticsWindow` metadata
- Primary data fetch uses `decisionContext.decisionWindows.primary30d` which is derived from `decisionAsOf`, not from the UI date picker

**Verified: selected range does not mutate primary operator decisions.** ✓

### Deep links
The `aggregateCommandCenterActions` function includes `startDate`/`endDate` in Creative deep links at line 1681:
```
/platforms/meta/creatives?...&startDate=...&endDate=...&creative=...
```
These are navigation parameters, not action authority. The Creatives page independently anchors to its own Decision OS context. This is currently safe.

**Watch:** If Phase 5 introduces a deep link consumer that reads these dates and uses them to pre-populate the analytics window in a way that bypasses the stable decision context, this would become a violation. Phase 5 must not do this.

---

## F. Blocking Issues

**None found** that affect current behavior.

The phase is already merged. There are no correctness issues that require rollback.

---

## G. High-Risk Non-Blockers

### HN-1: Dead code in `resolveSegment` — obscures policy intent

**File:** `lib/creative-operator-policy.ts:211`

```typescript
if (hasRoasOnlyPositiveSignal(input)) return "false_winner_low_evidence"; // line 206
if (isUnderSampled(input)) {
  if ((input.supportingMetrics?.purchases ?? 0) <= 0 || ...) {
    return "creative_learning_incomplete";
  }
  return hasRoasOnlyPositiveSignal(input)  // DEAD: always false here
    ? "false_winner_low_evidence"           // DEAD: unreachable
    : ...
```

The inner `hasRoasOnlyPositiveSignal(input)` check at line 211 is permanently dead code. If ROAS spike + low spend were true, line 206 would have already returned. The `false_winner_low_evidence` branch inside the `isUnderSampled` block can never be reached.

**Risk:** Not a behavioral bug today. However, if someone later reorders the guard checks or adds a new entry point, this dead branch could silently become live with unexpected results. It also misleads code readers into thinking the inner ternary is load-bearing.

**Recommendation:** Remove the dead ternary branch. Replace with the clean path: if purchases <= 0 or ROAS <= 0 → learning_incomplete; else if lifecycleState === "incubating" → learning_incomplete; else → promising_under_sampled.

---

## H. Medium-Risk Issues

### MR-1: `investigate` segment + `blocked` state routes to HOLD bucket — misleads operators on campaign structure conflicts

**Files:** `lib/creative-operator-policy.ts:183-242`, `lib/creative-operator-surface.ts:156-204`

When a creative has `primaryAction: "promote_to_scaling"` with sufficient evidence but weak deployment context (`compatibility.status: "limited"`), `resolveSegment` returns `"investigate"` (correctly: go figure out the campaign structure issue) but `resolveState` returns `"blocked"` because `aggressive && blockers.length > 0`.

Then in `resolveCreativeAuthorityState`:
```typescript
if (
  creative.operatorPolicy.state === "blocked" ||
  creative.operatorPolicy.state === "contextual_only"
) {
  return "needs_truth";
}
```

The creative lands in the **HOLD bucket** with label "HOLD" and summary "Creatives held back by truth, preview, deployment, or stop-level constraints."

The operator sees "HOLD" when the actual message is "this creative is strong but something in the campaign/ad set structure is limiting it — investigate the deployment context."

**Risk:** An operator following Adsecute's directive could go and add commercial truth targets (because "HOLD" implies missing truth) when the real action is to look at the campaign bid/objective family mismatch. This is a decision pollution risk in the operator interface.

**Note:** The `blockers[0]` explanation message correctly says "Campaign or ad set context limits this creative interpretation." so the detailed view shows the right message. The top-level bucket label is what misleads.

**Recommendation for Phase 5:** Add a distinct `OperatorAuthorityState` for this case or check the segment when routing to the surface bucket. When `segment === "investigate"` and `state === "blocked"`, the routing should prefer the "investigate" signal over "needs_truth". Alternatively: when the first blocker is a deployment/context blocker (not a truth blocker), route to a visible "investigate" state rather than HOLD.

---

### MR-2: Missing test coverage for several Creative policy branches

**File:** `lib/creative-operator-policy.test.ts`

The following policy paths are not tested:

1. **Undersampled + promote_to_scaling + modest ROAS (not roas-only):** A creative with spend=80, purchases=3, ROAS=1.5, primaryAction="promote_to_scaling". Expected: `promising_under_sampled`, `watch`, `blocked_from_push`. Not tested.

2. **Fatigued winner where primaryAction is NOT refresh_replace:** `lifecycleState: "fatigued_winner"`, `primaryAction: "keep_in_test"`. Expected: `needs_new_variant`. Not tested.

3. **spend_waste path:** `primaryAction: "block_deploy"`, spend >= 250 but neither kill evidence nor commercial truth configured. Expected: `spend_waste`. Not tested.

4. **Comeback/retest path:** `primaryAction: "retest_comeback"`. Expected: `needs_new_variant`. Not tested.

5. **Metrics-only-degraded + non-aggressive action:** `liveDecisionWindow: "metrics_only_degraded"` with `primaryAction: "keep_in_test"`. Expected: not `"investigate"` but `"hold_monitor"`. Partially covered but not explicit.

**Risk:** These uncovered paths could develop unintended behavior during Phase 5 refactors without any test catching the regression. The `spend_waste` and `needs_new_variant` paths are particularly relevant media buyer decisions.

**Recommendation:** Add targeted unit tests for each of these paths before Phase 5 extends the policy.

---

## I. Low-Risk Issues

### LR-1: Creative segment `"investigate"` is not present in `resolveCreativeAuthorityState` routing

The `resolveCreativeAuthorityState` function at creative-operator-surface.ts:156 has no explicit handler for `segment === "investigate"`. It falls through to the `state === "investigate"` path which returns `"watch"`. This is acceptable behavior (investigate → watch bucket is reasonable) but the lack of explicit handling could mask future policy additions.

### LR-2: `sourceDeepLink` includes UI-selected dates in both action and opportunity board deep links

Documented in Section E. Not a current risk. Requires vigilance in Phase 5.

### LR-3: No test for partial `combineCreativeEvidenceSource` with non-standard `snapshot_source` values

`mapMetaCreativesSnapshotSource` returns `"unknown"` for anything other than `"live"`, `"refresh"`, or `"persisted"`. The `"unknown"` result conservatively blocks primary action. Safe behavior, but not explicitly tested.

---

## J. Evidence Reviewed

### Files read
- `lib/creative-operator-policy.ts` — full
- `lib/creative-operator-policy.test.ts` — full
- `lib/creative-decision-os.ts` — lines 1–270
- `lib/creative-decision-os-source.ts` — full
- `lib/creative-operator-surface.ts` — full
- `lib/command-center.ts` — lines 1–250, 1230–1350, 1560–1715, 1840–1910
- `lib/command-center.test.ts` — full
- `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx` — full
- `components/platforms/meta/creatives/CreativesTopSection.tsx` — full
- `components/platforms/meta/creatives/platforms/meta/creatives-top-section-support.ts` — lines 1–60, 335–380
- `docs/operator-policy/phase-4/completion/reports/final.md` — full
- `docs/operator-policy/phase-5/handoff.md` — full

### Commands run
```
git log --oneline -20
git status
git show c80de2d --stat
git diff main~2 main --name-only
npm test -- lib/creative-operator-policy.test.ts lib/creative-decision-os.test.ts lib/command-center.test.ts components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx
npm test
npx tsc --noEmit
```

### Test results
- Targeted Phase 4 tests: **4 files / 34 tests — PASS**
- Full suite: **290 files / 1941 tests — PASS**
- TypeScript: **PASS (no output)**

---

## K. Claims Not Independently Verified

1. **Runtime smoke**: The final.md claims `npm run test:smoke:local` passed via SSH DB tunnel with Playwright results of 5 passed, 1 skipped. I cannot verify this claim. No local tunnel is available for this review.

2. **Connected-account production behavior**: Not verifiable from code review. The report correctly notes this requires post-merge monitoring.

3. **"Hidden/bidi Unicode scan passed"**: Not re-run. Trusted as stated since it is a simple text scan.

4. **Phase 3 Meta hardening regression**: The full test suite passes (1941 tests), which includes Meta operator policy tests. Regression-free from a test perspective. No runtime Meta operator behavior was independently validated.

---

## L. Recommended Next Actions

### Before Phase 5 starts
1. **Fix HN-1 (dead code in resolveSegment):** Remove the unreachable `false_winner_low_evidence` branch inside the `isUnderSampled` block. Low effort, high clarity improvement.

2. **Add MR-2 tests for uncovered policy branches:** Specifically the `spend_waste` path, `needs_new_variant` via fatigue-without-refresh, undersampled+scale+modest-ROAS, and comeback/retest. These are low-effort additions that protect against Phase 5 regressions.

3. **Design fix for MR-1 (HOLD bucket for campaign structure conflicts) as a Phase 5 scope item:** The UX routing should distinguish between "blocked by missing truth" and "blocked by campaign structure mismatch." This does not need to block Phase 5 start but should be included in Phase 5 scope, particularly when cross-page conflict detection is added.

### Phase 5 watch items
- The cross-page conflict detector (the first Phase 5 slice per handoff.md) must not reuse `segment === "investigate"` in a way that inherits the blocked-state routing problem described in MR-1.
- If Phase 5 adds any new deep link consumers, verify they do not treat the `startDate`/`endDate` URL params as action authority.
- Phase 5 must not introduce `canApply: true` for Creative rows without a separate provider execution contract PR.
- Alert rules described in the handoff (monitoring for demo/snapshot/fallback Creative rows becoming queue-eligible) should be implemented before any connected-account production traffic is extended to the Creative operator policy path.

---

## M. Safe to Merge / Safe to Start Next Phase

- **Phase 4 safe to merge:** Already merged. No rollback required.
- **Phase 4 accepted:** Yes, with the three issues above as tracked follow-up.
- **Safe to start Phase 5:** **Yes, after HN-1 and MR-2 are resolved.** The dead code and missing tests are low-effort and should not delay Phase 5, but they should be done first to establish a clean baseline for the cross-page conflict work.

---

*This review was conducted without access to runtime infrastructure or connected-account data. All findings are based on static code analysis and local test execution.*
