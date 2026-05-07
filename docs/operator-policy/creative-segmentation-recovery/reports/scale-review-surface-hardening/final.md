# Scale Review Surface Hardening

Last updated: 2026-04-25 by Codex

## Verdict

Status: implemented in this branch.

The PR #71 review issue was real. The primary-decision UI correctly grouped
Scale Review rows under `Scale`, but `buildCreativeOperatorSurfaceModel`
used total primary `scale` count to choose `act_now` emphasis. That could
make a scope with only review-only Scale candidates read like direct Scale
action was ready.

No Creative policy thresholds, Scale / Scale Review gates, benchmark behavior,
or queue/push/apply safety gates were changed.

## Fix

Added a presentation-only Scale actionability split:

- total primary `Scale`
- direct-action Scale
- review-first Scale
- muted / non-live Scale

Direct-action Scale now requires the existing safe policy/readiness state:

- resolved primary decision is `scale`
- sub-tone is not `review_only`
- row is not thin/archive-muted
- evidence source is live or legacy-unset
- operator policy segment is `scale_ready`
- existing readiness is queue/apply eligible, `safe_to_queue`, or `eligible_for_push_when_enabled`

Rows that do not meet those conditions remain grouped under the `Scale` filter,
but they cannot drive `act_now` surface emphasis.

## UI Behavior

When Scale rows are all review-only, muted, non-live, fallback, or otherwise
not direct-action ready:

- headline does not use `act_now`
- headline says Scale candidates need operator review
- note says no creatives are ready for direct Scale
- Scale filter/count remains available
- Scale filter/overview show how many rows need review before scale action

When a true direct-action Scale row exists:

- `act_now` emphasis is allowed
- headline counts only direct-action Scale rows
- review-only Scale rows remain labeled `Review only`

## Validation

Passed:

- `npx vitest run lib/creative-operator-surface.test.ts components/platforms/meta/creatives/CreativeDecisionSupportSurface.test.tsx components/platforms/meta/creatives/CreativesTopSection.test.tsx components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx components/platforms/meta/creatives/CreativeDetailExperience.test.tsx`
- `npx vitest run lib/creative-operator-surface.test.ts components/platforms/meta/creatives/CreativeDecisionSupportSurface.test.tsx components/platforms/meta/creatives/CreativesTopSection.test.tsx components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx components/platforms/meta/creatives/CreativeDetailExperience.test.tsx lib/operator-prescription.test.ts`
- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- `git diff --check`
- hidden/bidi/control scan on touched files
- raw ID scan on touched docs

Runtime smoke:

- local production server started on `http://localhost:3000`
- `/platforms/meta/creatives` returned the expected auth redirect to `/login?next=%2Fcreatives`, then loaded with HTTP 200
- `/platforms/meta` returned the expected auth redirect to `/login?next=%2Fplatforms%2Fmeta`, then loaded with HTTP 200

Package has no lint script.

## Next Recommended Action

Open PR `Harden review-only Scale surface emphasis`. After it merges, rerun
Claude primary-decision UI review.
