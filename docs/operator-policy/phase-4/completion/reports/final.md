# Phase 4 Completion Report - Creative Operator Policy Foundation

Date: 2026-04-22
Branch: `feature/adsecute-creative-operator-policy`

## Status

Phase 4 implementation is code-ready for PR review. The branch adds the Creative deterministic operator policy foundation and keeps Phase 3 Meta safety intact.

Main should contain Phase 4 only after this branch is merged through a normal PR with passing checks and no unresolved correctness blockers.

## Scope Completed

- Added deterministic Creative operator policy assessment.
- Added Creative evidence-source safety for `live`, `demo`, `snapshot`, `fallback`, and `unknown`.
- Added per-creative `operatorPolicy`, `evidenceSource`, `pushReadiness`, required evidence, missing evidence, blockers, and explanation.
- Preserved existing Creative Decision OS provenance, `evidenceHash`, and `actionFingerprint`.
- Propagated Creative evidence source from Meta creatives serving into Creative Decision OS.
- Kept selected reporting range as analysis/reporting context; primary Creative fingerprints remain anchored by `decisionAsOf` and source windows.
- Kept demo/snapshot/fallback/unknown evidence contextual and blocked from queue/push eligibility.
- Kept missing provenance and missing Creative policy blocked in Command Center.
- Added Creative operator policy summary to the existing Decision Support drawer.
- Added operator policy labels to the existing Creative detail evidence surface.
- Added operator segment, operator state, and push readiness fields to the existing Creative filter builder.
- Removed selected reporting dates from the Creative detail Command Center deep link; the handoff binds to the Command Center action fingerprint.

## Files Changed

- `lib/creative-operator-policy.ts`
- `lib/creative-operator-policy.test.ts`
- `lib/creative-decision-os.ts`
- `lib/creative-decision-os-source.ts`
- `lib/creative-decision-os.test.ts`
- `lib/creative-operator-surface.ts`
- `lib/command-center.ts`
- `lib/command-center.test.ts`
- `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx`
- `components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx`
- `components/platforms/meta/creatives/CreativeDetailExperience.tsx`
- `components/platforms/meta/creatives/CreativesTopSection.tsx`
- `components/platforms/meta/creatives/platforms/meta/creatives-top-section-support.ts`
- `docs/operator-policy/phase-4/completion/reports/final.md`
- `docs/operator-policy/phase-5/handoff.md`

## Creative Policy Contract

Creative operator segments:

- `scale_ready`
- `promising_under_sampled`
- `false_winner_low_evidence`
- `fatigued_winner`
- `kill_candidate`
- `protected_winner`
- `hold_monitor`
- `needs_new_variant`
- `creative_learning_incomplete`
- `spend_waste`
- `no_touch`
- `investigate`
- `contextual_only`
- `blocked`

Operator states reuse the shared policy vocabulary:

- `do_now`
- `do_not_touch`
- `watch`
- `investigate`
- `blocked`
- `contextual_only`

Push readiness uses the shared Phase 3 model:

- `read_only_insight`
- `operator_review_required`
- `safe_to_queue`
- `eligible_for_push_when_enabled`
- `blocked_from_push`

Phase 4 does not make Creative provider push available. `eligible_for_push_when_enabled` is not emitted for Creative rows in this implementation; Creative execution remains manual/unsupported until a future provider-backed creative mutation contract exists.

## Guardrails Implemented

- ROAS alone cannot authorize scale or kill.
- Very low spend or very low conversion count cannot become `scale_ready` or `kill_candidate`.
- Missing commercial truth blocks aggressive Creative scale, kill, and refresh actions.
- Missing provenance blocks queue and push eligibility.
- Missing evidence source fails closed as `contextual_only`.
- Demo, snapshot, fallback, and unknown evidence cannot become primary or push eligible.
- Protected winners stay `do_not_touch`.
- Strong creative inside weak campaign/ad set context becomes investigation, not a clean scale command.
- Missing preview truth blocks queue and push eligibility.
- Creative rows without `operatorPolicy` are blocked from Command Center queue/push surfaces.

## Scenario Fixtures Added

The deterministic test coverage includes:

- clean high-evidence live scale candidate
- tiny-spend high-ROAS false winner
- high-evidence poor performer kill candidate
- low-spend no-conversion learning-incomplete loser
- protected winner
- missing commercial truth blocking aggressive action
- demo/snapshot/fallback context-only evidence
- missing provenance and missing evidence source fail-closed behavior
- weak campaign/ad set context downgrading creative interpretation
- selected reporting range preserving Creative fingerprints and operator policy outputs
- snapshot Creative policy staying out of the Command Center default queue
- missing Creative policy blocking Command Center queue/push eligibility

## Data Gaps

The policy uses only fields already available in the current Creative Decision OS path. These remain gaps for later phases:

- durable creative policy decision table
- creative-level attribution reconciliation basis
- current-day partial-data protection beyond source-window anchoring
- inventory and production capacity inputs
- full creative-by-placement and creative-by-geo evidence
- richer campaign/ad set delivery diagnostics for creative blame separation
- provider-backed creative mutation targets and rollback proof

Missing data is not treated as permission for aggressive action.

## UI Integration

The UI change is intentionally small:

- Existing `Decision Support` drawer remains the primary Creative operator surface.
- Existing quick filters remain the top-level entry points.
- Creative overview now includes an `Operator Policy` section with segment, state, push readiness, evidence source, and missing evidence.
- Creative detail now shows operator segment and push readiness in the existing deterministic decision panel.
- Advanced Creative filter builder can filter by operator segment, operator state, and push readiness.

No broad redesign was made.

## Workflow / Command Center Safety

- Creative rows propagate `operatorPolicy` into Command Center actions.
- Missing Creative operator policy blocks queue and push eligibility.
- Creative opportunity-board queue eligibility is rechecked against row-level Creative operator policy before Command Center displays it as queue eligible.
- Command Center still uses legacy `cc_` action fingerprints for compatibility while retaining upstream provenance on the action.
- Creative provider execution remains unsupported by capability registry and execution service.
- Non-Meta Creative rows cannot become provider-apply eligible.
- Selected reporting dates are not used in the Creative detail Command Center handoff URL.

## Validation

Automated checks run on this branch:

- `npm test` - passed, 290 files / 1941 tests.
- `npx tsc --noEmit` - passed.
- `npm run build` - passed.
- `git diff --check` - passed.
- Hidden/bidi Unicode scan - passed, no unsafe characters found.
- `npm run lint` - not available; package has no lint script.

Targeted Phase 4 checks:

- `npm test -- lib/creative-operator-policy.test.ts lib/creative-decision-os.test.ts lib/creative-operator-surface.test.ts components/platforms/meta/creatives/platforms/meta/creatives-top-section-support.test.ts components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx components/platforms/meta/creatives/CreativeDetailExperience.test.tsx lib/command-center.test.ts app/api/creatives/decision-os/route.test.ts` - passed, 8 files / 47 tests.

Runtime smoke:

- `npm run test:smoke:local` through the approved SSH DB tunnel - passed.
- Playwright result: 5 passed, 1 skipped.
- Covered Meta, Command Center, Creative reviewer smoke, and commercial truth smoke.
- The skipped test was the configured canary execution smoke, which is intentionally skipped when the canary is not configured.

## Review Agents

Real subagents were used for:

- Creative policy and data contract audit
- Legacy rule engine recovery and scenario fixture selection
- Workflow / Command Center safety review
- UX/runtime smoke path review
- Regression QA focused verification
- Final diff review

The final diff reviewer found no blocking issues. One non-blocking Command Center opportunity-board hardening gap was patched before final validation.

## Remaining Risks

- Creative provider write-back is intentionally not implemented.
- Snapshot-backed Creative evidence remains visible as context but cannot become primary or push eligible.
- Runtime smoke validates seeded/localhost paths; connected-account production rollout should still be monitored after merge.
- A future Phase 5 provider-execution design must not reuse Creative `safe_to_queue` as provider-apply permission.

## Recommendation

- Safe to keep branch: yes.
- Safe to open PR: yes.
- Safe to merge main: yes after PR review has no unresolved correctness blocker and CI passes.
- Safe to start Phase 5: only after the Phase 4 PR is merged into main.
