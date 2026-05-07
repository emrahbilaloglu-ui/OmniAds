# Creative Segmentation Recovery Foundation Hardening Final

Date: 2026-04-23
Branch: `feature/adsecute-creative-segmentation-foundation-hardening`

## Implemented

- Hardened `scale_review` push readiness so missing provenance, missing trust metadata, non-live evidence, preview gaps, suppression/archive state, and weak campaign/ad set context remain `blocked_from_push`.
- Kept `scale_review` review-required only for the relative-winner case where Commercial Truth / absolute business validation is the remaining blocker.
- Added deterministic account/campaign relative baseline computation in Creative Decision OS.
- Added benchmark scope metadata: account default, explicit campaign scope, source, label, scope id, and reliability.
- Prevented weak/unavailable baselines from emitting `scale_review`.
- Updated blocked/contextual UI language so policy/system ineligible rows show "Not eligible for evaluation" instead of "Not Enough Data."
- Updated the coarse blocked quick-filter label to "Check" to avoid Campaign Check rows sitting under a contradictory Refresh bucket.
- Restored an independent old-rule-style challenger helper for calibration comparison only.
- Patched the small-account ROAS-only edge so low spend with meaningful purchase evidence is not automatically labeled ROAS-only noise.

## Safety Status

`scale_review` remains a relative creative-quality signal only. It is never queue eligible, never `safe_to_queue`, and never apply eligible.

Commercial Truth still blocks absolute Scale validation, profit claims, budget/bid/target assumptions, queue eligibility, and apply/push behavior. Missing Commercial Truth no longer hides relative Scale Review when a reliable explicit baseline exists.

## Baseline And Benchmark Status

Default benchmark scope is account-wide. Campaign benchmark scope is explicit through `benchmarkScope: { scope: "campaign", scopeId }`; campaign filtering alone does not change benchmark authority inside the Decision OS contract.

Relative baselines include scope, benchmark key, scope id/label, creative count, eligible creative count, spend basis, purchase basis, weighted ROAS, weighted CPA, medians, reliability, and missing context. Only `strong` and `medium` baselines can support `scale_review`.

## Old Rule Challenger Status

Git history contained recoverable independent old-rule logic. It is restored as `buildCreativeOldRuleChallenger` in `lib/creative-old-rule-challenger.ts`.

The helper emits challenger action, lifecycle state, reason, metrics used, confidence, score, and non-authoritative flags. It does not drive UI/policy and cannot become queue/push/apply eligible.

## Tests Run

- `npx vitest run lib/creative-operator-policy.test.ts lib/creative-operator-surface.test.ts lib/creative-decision-os.test.ts lib/creative-old-rule-challenger.test.ts components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx` - passed, 42 tests.
- `npx vitest run lib/creative-operator-policy.test.ts lib/creative-operator-surface.test.ts lib/creative-decision-os.test.ts lib/creative-old-rule-challenger.test.ts components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx lib/command-center.test.ts` - passed, 81 tests.
- `npm test` - passed, 293 files and 2021 tests.
- `npx tsc --noEmit` - passed.
- `npm run build` - passed.
- `git diff --check` - passed.
- Hidden/bidi/control scan - passed.
- Lint skipped: no `lint` script exists in `package.json`.

## Pending Before Merge

- Remote PR CI.

## Remaining Risks

- Creative UI still needs a future explicit campaign benchmark control and persistent active benchmark scope label.
- Quick filter buckets are still coarse, though the most misleading Refresh/Campaign Check contradiction was reduced.
- Calibration still needs real account fixtures and media-buyer review to tune thresholds; this hardening only establishes prerequisites.

## Calibration Lab Readiness

Calibration Lab may start after this hardening PR is merged with green checks. Do not ask Claude for another review in this pass.
