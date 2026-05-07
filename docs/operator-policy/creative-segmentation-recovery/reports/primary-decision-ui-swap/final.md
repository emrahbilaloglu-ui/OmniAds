# Creative Primary-Decision UI Swap

Last updated: 2026-04-25 by Codex

## Verdict

Status: implemented in this branch.

This pass swaps the Creative presentation layer from the old 10 primary labels to the accepted six primary operator decisions:

- `Scale`
- `Test More`
- `Protect`
- `Refresh`
- `Cut`
- `Diagnose`

No Creative policy thresholds, Scale / Scale Review gates, benchmark-scope rules, snapshot behavior, or queue/push/apply safety gates were changed.

## Surfaces Swapped

- top Creative filter chips now use the six primary decisions
- filter and overview counts are computed from `resolveCreativeOperatorDecision(...).primary`
- Creative preview cards show the primary decision plus sub-tone/reason chips
- Creative Decision Support quick filters and operator buckets use primary-decision language
- Creative Decision OS overview cards use primary-decision counts
- operator instruction cards show primary decision plus sub-tone/reason context
- Creative detail verdict uses the primary decision first
- comeback / paused winner presentation is shown as `Refresh` with revive/comeback context

## Scale Review Representation

`Scale Review` is no longer a top-level primary filter.

Rows that previously surfaced as `Scale Review` now show:

- primary decision: `Scale`
- sub-tone: `Review only`
- reason tag: usually `Business target missing` or `Commercial truth missing`

The instruction path still uses `Scale Review` wording where it clarifies the review-only scale action, and queue/apply/push eligibility remains blocked unless the underlying policy already authorizes it.

## Old Labels Demoted

- `Scale Review` -> `Scale` + `Review only`
- `Watch` -> resolver-driven `Test More`, `Refresh`, `Cut`, or `Diagnose`
- `Retest` -> `Refresh` + `Revive`, `Comeback candidate`, or `Paused winner`
- `Campaign Check` -> `Diagnose` + `Campaign context`
- `Not Enough Data` -> `Diagnose` or `Test More` + `Low evidence` / `Learning incomplete`

## Count Accuracy

Primary decision counts no longer read old aggregate fields or old 10-label buckets.

The filter/count source is:

1. current Creative Decision OS row
2. `resolveCreativeOperatorDecision(row)`
3. resolved `primary`
4. six-primary filter/count aggregation

`Scale` includes review-only Scale rows, but those rows remain visibly review-only.

## Safety

Preserved:

- queue/push/apply safety
- non-live/fallback/snapshot evidence push blocks
- provenance and policy readiness blocks
- explicit benchmark scope behavior
- manual Decision OS snapshot behavior
- reporting date range remains non-authoritative
- old challenger remains comparison-only

## Validation Status

Passed:

- `npx vitest run lib/creative-operator-surface.test.ts components/platforms/meta/creatives/CreativeDecisionSupportSurface.test.tsx components/platforms/meta/creatives/CreativesTopSection.test.tsx`
- `npx vitest run components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx components/platforms/meta/creatives/CreativeDecisionOsDrawer.test.tsx components/platforms/meta/creatives/CreativeDetailExperience.test.tsx lib/operator-prescription.test.ts app/api/creatives/decision-os/route.test.ts`
- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- `git diff --check`
- hidden/bidi/control scan on touched files
- raw ID scan on touched docs

Runtime smoke:

- local production server started on `http://localhost:3000`
- `/platforms/meta/creatives` returned an expected auth redirect to `/login?next=%2Fcreatives`, then loaded the login page with HTTP 200
- `/platforms/meta` returned an expected auth redirect to `/login?next=%2Fplatforms%2Fmeta`, then loaded the login page with HTTP 200

PR status: pending.

## Next Recommended Action

Complete validation, runtime smoke, and PR review. If checks pass and no UI/count/safety blocker appears, request a Claude product review of the simplified Creative UI.
