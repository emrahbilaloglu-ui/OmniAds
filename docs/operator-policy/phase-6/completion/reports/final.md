# Phase 6 Final Report

Branch: `feature/adsecute-operator-parameters-observability`

Scope: bounded operator parameters, Creative target context, evidence-based urgency, clearer hold/watch/investigate language, and production-safe operator-decision telemetry. This phase does not add automatic account push execution and does not loosen existing queue, push, or apply gates.

## Branches And PRs

- Working branch: `feature/adsecute-operator-parameters-observability`
- Base branch: `main`
- PR: [#27 Add Phase 6 operator parameters and observability](https://github.com/erhanrdn/OmniAds/pull/27)
- PRs merged at report time: none for Phase 6 yet.

## Files Changed

- `src/types/operator-decision.ts`
- `lib/operator-prescription.ts`
- `lib/meta/operator-surface.ts`
- `lib/creative-operator-surface.ts`
- `lib/command-center.ts`
- `components/meta/meta-decision-os.tsx`
- `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx`
- `components/platforms/meta/creatives/CreativeDetailExperience.tsx`
- `components/command-center/CommandCenterDashboard.tsx`
- Phase 6 tests in `lib/*` and component surfaces

## Bounded Parameter Contract

- `OperatorInstruction.amountGuidance` now supports optional assumptions.
- Meta ad set budget actions can show a bounded daily-budget band only when current daily budget exists on the source row and deterministic policy allows the move.
- Budget bands are conservative percentage bands based on the current source-row daily budget and are labeled as review-required. They do not grant queue or apply eligibility.
- If current budget, pacing, bid, or commercial-truth inputs are missing, the instruction remains unavailable or review-required instead of inventing an amount.
- Non-budget actions keep `No amount needed`.

## Urgency And Priority

- `OperatorInstruction.urgencyReason` explains why urgency was assigned.
- Do-now instructions are not automatically high urgency; evidence strength, push readiness, and missing context matter.
- Creative fatigue can raise urgency only when frequency pressure is available.
- Protected and contextual rows stay low or watch-level.

## Creative Target Context

- Creative scale instructions use deployment data to name a preferred ad set when available.
- If only campaign context is available, the instruction is review-required.
- If no deployment target is available, the instruction says target unavailable and requires review.
- Strong Creative rows inside weak campaign/ad set context retain the existing invalid-action warning.

## Observability

`OperatorInstruction.telemetry` adds production-safe decision telemetry:

- policy version
- source system and surface
- instruction kind
- push readiness
- queue/apply booleans
- evidence strength
- urgency
- amount guidance status
- target context status
- sanitized missing-evidence tokens
- counts of missing evidence, next observations, and invalid actions
- action fingerprint and evidence hash

Telemetry intentionally excludes raw business IDs, provider account IDs, entity names, actor IDs/emails, notes, and free-form reason text.

## Data Gaps

- Budget utilization and pacing ratio are not available in the current contract.
- Learning phase and delivery diagnostics are not first-class fields.
- Meta preferred ad set target context is not first-class.
- True days-in-state is unavailable; Command Center age is workflow age, not policy-state age.
- Bid/cost-control value recommendations remain unavailable unless a future source contract exposes reliable values.

## UI Integration

- Meta, Creative, and Command Center instruction blocks now show target context and urgency.
- Command Center uses `Amount` instead of `How much`, and separates target, urgency, and watch-next context.
- Creative HOLD language is narrowed to `Hold: verify` to distinguish truth/preview/deployment gates from generic holding.
- The UI changes are additive and compact; detailed evidence remains collapsed or secondary.

## Command Center Safety

- `buildOperatorInstruction` now fails closed when a policy is required but missing.
- Push readiness, queue eligibility, and apply capability cannot be loosened beyond deterministic policy.
- Policy `blocked_from_push` remains more restrictive than any caller override.
- Command Center bounded move-band display does not grant apply capability.
- Existing provenance, policy, push-readiness, and apply allowlist gates remain intact.

## Tests Added

- Policy clamp tests for `buildOperatorInstruction`.
- Sanitized telemetry tests.
- Meta bounded daily-budget band tests.
- Creative preferred ad set / target-unavailable tests.
- Creative frequency urgency test.
- Command Center bounded move-band and telemetry tests.
- Existing Meta, Creative, Command Center, provenance, and instruction suites were rerun.

## Checks Run

- `npm test -- lib/operator-prescription.test.ts lib/meta/operator-surface.test.ts lib/creative-operator-surface.test.ts lib/command-center.test.ts` - passed, 62 tests.
- `npm test -- components/meta/meta-decision-os.test.tsx components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx components/platforms/meta/creatives/CreativeDetailExperience.test.tsx components/command-center/CommandCenterDashboard.test.tsx` - passed, 17 tests across 3 available files.
- `npm test` - passed, 291 files / 1977 tests.
- `npx tsc --noEmit` - passed.
- `git diff --check` - passed.
- Hidden/bidi/control scan over `docs`, `lib`, `components`, `app`, and `src` - passed.
- `npm run build` - passed.
- `npm run test:smoke:local` through the approved SSH DB tunnel - passed, 5 Playwright tests passed and 1 configured execution canary skipped.
- No `lint` script exists in `package.json`.

## Runtime Smoke

Runtime smoke used the owner-approved localhost path:

- SSH tunnel to the database host through the app server.
- `DATABASE_URL` and `DATABASE_URL_UNPOOLED` set locally without printing values.
- Playwright web server served `http://127.0.0.1:3000`.
- Smoke covered seeded reviewer, commercial operator, Meta, Creative, Commercial Truth, and Command Center-adjacent flows.

## Remaining Risks

- Connected-account production monitoring should verify high-volume Creative target context after deployment.
- Amount bands are intentionally conservative and limited to available current daily budget; pacing-aware parameters require a future source extension.
- Telemetry is structured on the instruction object; exporting it to a metrics/log pipeline remains a Phase 7 production rollout task.

## Completion Status

- Phase 6 code is validation-clean on the feature branch.
- Phase 6 is not complete on `main` until the normal PR is opened, reviewed, checked, and merged.
- Phase 7 may start only after Phase 6 is merged to `main`.
