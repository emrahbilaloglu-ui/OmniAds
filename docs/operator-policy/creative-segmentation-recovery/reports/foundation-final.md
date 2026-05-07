# Creative Segmentation Recovery Foundation Final

Date: 2026-04-23
Branch: `feature/adsecute-creative-segmentation-recovery-foundation`

## Implemented

- Created shared context system at `docs/operator-policy/creative-segmentation-recovery/STATE.md`.
- Added audit report at `reports/current-segmentation-audit.md`.
- Added internal `scale_review` segment to Creative operator policy.
- Added explicit `relativeBaseline` policy input for account/campaign-relative Scale Review recognition.
- Preserved safety: Scale Review is not `safe_to_queue`, is not queue-eligible, and cannot apply.
- Removed verified unreachable `resolveSegment` branch.
- Patched narrow HOLD routing so `investigate` maps toward Campaign Check instead of Hold.
- Patched policy kill/Cut recognition so Commercial Truth is not required for `kill_candidate`; push/apply safety remains constrained.
- Added media-buyer row label mapping for Scale Review, Test More, Protect, Watch, Refresh, Retest, Cut, Campaign Check, and Not Enough Data.

## Audited / Documented Only

- Upstream Decision OS over-gating remains: degraded Commercial Truth and economics can downgrade `promote_to_scaling` before Creative policy sees it.
- Account/campaign baseline computation is not wired into Decision OS policy input yet.
- Campaign benchmark mode and visible benchmark scope are not implemented.
- A truly independent old simple rule engine was not found in active code; current heuristic output delegates to Decision OS.
- Full calibration lab was not implemented.
- Full UI taxonomy rewrite was not implemented.

## Tests Run

- `npx vitest run lib/creative-operator-policy.test.ts lib/creative-operator-surface.test.ts` - passed, 23 tests.
- `npx vitest run lib/creative-operator-policy.test.ts lib/creative-operator-surface.test.ts components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx` - passed, 24 tests.
- `npx vitest run lib/creative-decision-os.test.ts components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx components/platforms/meta/creatives/CreativesTableSection.test.tsx` - passed, 12 tests.
- `npx vitest run lib/command-center.test.ts` - passed, 39 tests.
- `npm test` - passed, 292 files and 2008 tests.
- `npx tsc --noEmit` - passed.
- `npm run build` - passed.
- `git diff --check` - passed.
- Lint skipped: no `lint` script exists in `package.json`.

## Old Rule Engine Finding

The old taxonomy is present in `lib/ai/generate-creative-decisions.ts`, and downstream code still calls `buildHeuristicCreativeDecisions`, but that function now builds Decision OS and maps it back to legacy decisions. This means the active code does not currently expose a true independent old-rule challenger.

## Scale Review Behavior

`scale_review` exists as an internal segment. It fires only when:

- primary action is `promote_to_scaling`
- Commercial Truth is not configured
- explicit `relativeBaseline` exists with sample size >= 3
- current spend, purchases, ROAS, and CPA are strong enough versus that baseline

It does not fire from missing baseline data. It maps to the user-facing label "Scale Review" and remains manual/review-only.

## HOLD Routing

Fixed narrowly:

- `investigate` rows now map to row-level "Campaign Check" and do not route to `needs_truth` / Hold.
- insufficient evidence rows map to "Not Enough Data" or "Test More."
- protected rows map to "Protect."

True truth, preview, provenance, and contextual blockers can still route to Hold.

## Commercial Truth Over-Gating

Patched narrowly in Creative policy:

- Commercial Truth still gates full Scale validation and `safe_to_queue`.
- Commercial Truth no longer gates policy-level `kill_candidate` recognition.
- Upstream Decision OS Commercial Truth/economics gates are deferred because changing them safely requires explicit baseline wiring and calibration fixtures.

## Open Risks

- `scale_review` is policy-ready but not yet live-wired from Decision OS because `relativeBaseline` is not computed/passed upstream.
- Coarse Creative quick filter buckets still do not fully match the final 10 labels.
- Campaign benchmark scope is not visible or selectable.
- Old-rule challenger needs recovery/reconstruction before calibration.

## Ready For Claude Review

Ready after full validation and PR checks pass. Claude product review should focus on whether the foundation correctly separates relative creative quality from Commercial Truth and whether the deferred upstream gates are the right next target.

## Next Step

Do not start Calibration Lab immediately until Claude reviews this foundation. After review, build account/campaign baseline computation and benchmark-scope contract, then run the Calibration Lab.
