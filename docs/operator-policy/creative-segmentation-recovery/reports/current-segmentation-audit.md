# Current Creative Segmentation Audit

Date: 2026-04-23
Branch: `feature/adsecute-creative-segmentation-recovery-foundation`

## Scope Inspected

- `lib/creative-operator-policy.ts`
- `lib/creative-decision-os.ts`
- `lib/creative-decision-os-source.ts`
- `lib/creative-operator-surface.ts`
- `components/platforms/meta/creatives/*`
- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`
- `lib/ai/generate-creative-decisions.ts`
- `lib/meta/creative-intelligence.ts`
- `lib/meta/creative-score-service.ts`

## Current User-Facing Labels

Primary Creative surface buckets remain coarse:

- `SCALE`
- `TEST`
- `REFRESH`
- `HOLD: VERIFY`
- `EVERGREEN`

Row-level operator labels now map technical segments into media-buyer language:

- `scale_ready` -> Scale
- `scale_review` -> Scale Review
- `promising_under_sampled` -> Test More
- `protected_winner` / `no_touch` -> Protect
- `hold_monitor` -> Watch
- `fatigued_winner` -> Refresh
- `needs_new_variant` -> Refresh or Retest depending on primary action
- `kill_candidate` / `spend_waste` -> Cut
- `investigate` -> Campaign Check
- `false_winner_low_evidence` / `creative_learning_incomplete` / `blocked` / `contextual_only` -> Not Enough Data

Remaining UI risk: coarse quick filters and some overview headings still do not represent the final 10-label taxonomy.

## Current Internal Segment Labels

`CREATIVE_OPERATOR_SEGMENTS` now contains:

- `scale_ready`
- `scale_review`
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

## Commercial Truth Gates

Current scale gates exist in multiple layers:

- `lib/creative-decision-os.ts`: `buildEconomics` uses target/breakeven values when present and fallback absolute floors when not present.
- `lib/creative-decision-os.ts`: `resolvePrimaryAction` downgrades `promote_to_scaling` when degraded Commercial Truth is active or economics are not eligible.
- `lib/creative-decision-os.ts`: `buildCreativePolicyEnvelope` keeps degraded Commercial Truth scale cases in test.
- `lib/creative-operator-policy.ts`: `hasScaleEvidence` still requires spend >= 250, purchases >= 5, and `economics.status === "eligible"` for `scale_ready`.
- `lib/creative-operator-policy.ts`: missing Commercial Truth still blocks fully validated Scale and `safe_to_queue`.

Narrow patch applied:

- `scale_review` can now be recognized in Creative policy when Commercial Truth is missing but an explicit account/campaign `relativeBaseline` shows strong relative performance.
- `kill_candidate` no longer requires Commercial Truth in `resolveSegment`; safety remains manual because queue eligibility is still false and `canApply` is false.

Remaining over-gate:

- Decision OS can downgrade the primary action before policy sees it, so many real live rows may never reach the `scale_review` branch until baseline data is wired upstream.

## HOLD / Hold Monitor Routing

Before this patch:

- `resolveCreativeAuthorityState` routed `operatorPolicy.state === "blocked"` or `contextual_only` to `needs_truth`, causing campaign/context-blocked `investigate` rows to hide under Hold.

After this patch:

- `investigate` routes to the non-Hold review bucket and row-level action label `Campaign Check`.
- insufficient evidence maps row-level label `Not Enough Data` or `Test More`.
- protected winners map row-level label `Protect`.
- true truth/preview/provenance/contextual gates can still route to Hold.

## Old Rule Engine / Challenger Location

Findings:

- `lib/ai/generate-creative-decisions.ts` contains the old public taxonomy (`scale_hard`, `scale`, `watch`, `test_more`, `pause`, `kill`) and an old AI prompt, but active `buildHeuristicCreativeDecisions` delegates to `buildCreativeDecisionOs`.
- `app/api/ai/creatives/decisions/route.ts`, `lib/meta/creative-intelligence.ts`, and `lib/meta/creative-score-service.ts` consume `buildHeuristicCreativeDecisions`.
- `applyDecisionGuardrails` exists in `lib/ai/generate-creative-decisions.ts` but is not currently called.

Conclusion: a true independent old simple rule engine was not found in active code. The current "legacy" output is mostly a compatibility projection from Decision OS, so the old challenger may need recovery from git history or reconstruction from documented rules before calibration.

## Account-Relative Baseline

Existing context:

- `selectBenchmark` computes peer cohorts and falls back to `account`.
- `buildMetricContext` computes account-style averages and spend percentiles for reports.
- Creative table heatmaps compute a current-table benchmark.

Missing:

- No explicit `relativeBaseline` is currently computed and passed into `assessCreativeOperatorPolicy`.
- No median account/campaign spend, median ROAS, or campaign benchmark scope contract is wired to policy.

## Campaign-Relative Benchmark

Existing:

- `selectBenchmark` has family, format, spend maturity, Meta family, format, and account cohorts.
- UI filters can narrow table rows.

Missing:

- No explicit campaign benchmark cohort.
- No "Evaluate within this campaign" or "Benchmark scope: Selected campaign" control.
- No always-visible active benchmark scope indicator for Creative segmentation.
- Campaign filter state does not intentionally re-run segmentation with visible scope semantics.

## Why Zero Scale / Scale Review Can Happen

Likely causes:

- Evidence source is non-live or unknown.
- preview truth is missing or degraded.
- Commercial Truth target pack is missing, stale, or degraded.
- `resolvePrimaryAction` downgrades `promote_to_scaling` before policy assessment.
- `hasScaleEvidence` requires spend >= 250, purchases >= 5, and `economics.status === "eligible"`.
- deployment compatibility must be clean for the strongest scale path.
- account/campaign relative baseline is not wired, so the system cannot yet emit `scale_review` from live Decision OS rows unless the policy input explicitly contains baseline data.

## Dead Code Verification

Verified dead code:

- Inside `resolveSegment`, `hasRoasOnlyPositiveSignal(input)` was checked before `isUnderSampled(input)`.
- The nested ternary inside the `isUnderSampled` block checked `hasRoasOnlyPositiveSignal(input)` again, but any true case had already returned.
- Removed the unreachable branch and left the reachable `false_winner_low_evidence` path intact.

## Deferred Work

- Wire account/campaign `relativeBaseline` from Decision OS source data into policy input.
- Add visible benchmark-scope UX.
- Recover or reconstruct a true old-rule challenger.
- Complete final 10-label UI taxonomy after Claude review.
