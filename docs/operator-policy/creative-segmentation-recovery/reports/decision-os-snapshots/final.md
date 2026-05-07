# Creative Decision OS Snapshot Pass

Date: 2026-04-25  
Author: Codex  
Branch: `feature/adsecute-creative-decision-os-snapshots`
PR: `https://github.com/erhanrdn/OmniAds/pull/66`
Merge: squash to `main` as `7be5f28cf2918fe020b55393cd5f8513882eceb2`

## Executive Result

Manual Creative Decision OS analysis snapshots were implemented for the Creative page.

The Creative page no longer uses the selected reporting date range as an automatic Decision OS computation trigger. Reporting range changes can still update the Creative table, reporting metrics, exports, and visible row set, but they do not run or mutate the saved Decision OS result.

## Auto-Run Behavior Found

Before this pass:

- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx` used a React Query key:
  - `creative-decision-os`
  - `businessId`
  - `drStart`
  - `drEnd`
  - `activeBenchmarkScope.scope`
  - `activeBenchmarkScope.scopeId`
- The query was enabled whenever Creative data could load.
- The query function called `getCreativeDecisionOs(businessId, drStart, drEnd, benchmarkScope)`.
- `app/api/creatives/decision-os/route.ts` used `GET` to compute `getCreativeDecisionOsForRange`.

That meant page load and reporting date range changes could compute a new Decision OS payload.

## Snapshot Contract

Added persistent Creative Decision OS snapshots with:

- `snapshotId`
- `surface = creative`
- `businessId`
- `analysisScope`: `account` or `campaign`
- `benchmarkScope`: `account` or `campaign`
- optional scope ids and labels
- `decisionAsOf`
- `generatedAt`
- `generatedBy`
- source window metadata
- operator decision version
- policy version
- instruction version placeholder
- input/evidence hashes
- summary counts
- status
- safe error metadata
- saved Decision OS payload

Selected reporting dates are stored only as snapshot context. They are not part of the snapshot lookup identity.

## API Behavior

`GET /api/creatives/decision-os`

- loads the latest matching snapshot
- does not compute Decision OS
- returns `not_run` when no matching snapshot exists

`POST /api/creatives/decision-os`

- manually computes Creative Decision OS
- saves a snapshot after success
- returns the saved snapshot
- returns an error response without marking a successful last-analyzed snapshot when computation fails

## UI Behavior

The Creative page now:

- loads the latest matching snapshot on page load
- shows `Decision OS has not been run for this scope` when no snapshot exists
- exposes a manual `Run Creative Analysis` CTA
- shows running state during manual analysis
- shows last analyzed timestamp when a snapshot exists
- shows analysis scope, benchmark scope, and decision-as-of metadata
- keeps the saved snapshot visible when the reporting date range changes
- shows a note when the reporting range differs from the saved snapshot context
- loads a matching snapshot or not-run state when benchmark/campaign scope changes

## Scope Preservation

Unchanged:

- Creative segmentation policy
- segment taxonomy
- Scale / Scale Review floors
- queue/push/apply safety
- Command Center safety contracts
- old rule challenger behavior
- benchmark semantics

## Validation

Completed:

- `npx vitest run lib/creative-decision-os-snapshots.test.ts app/api/creatives/decision-os/route.test.ts app/'(dashboard)'/platforms/meta/creatives/page.test.tsx components/platforms/meta/creatives/CreativeDecisionOsDrawer.test.tsx`
- `npx tsc --noEmit`
- targeted Creative/API/surface/Command Center tests
- full `npm test` (`302` files, `2154` tests)
- `npm run build`
- `git diff --check`
- hidden/bidi/control scan
- raw ID scan on touched docs/reports

Runtime smoke:

- built server started on `127.0.0.1:3100`
- `/platforms/meta/creatives` returned the expected unauthenticated redirect to `/login?next=%2Fcreatives`, then login HTML loaded
- `/platforms/meta` returned the expected unauthenticated redirect to `/login?next=%2Fplatforms%2Fmeta`, then login HTML loaded

Remaining before merge:

- PR checks

## Remaining Risks

- Existing snapshots are scope-specific. Businesses with no prior Creative Decision OS snapshot will correctly see a not-run state until an operator runs analysis.
- Error snapshots are not persisted as successful analysis snapshots. This is intentional so the UI does not show a failed run as last analyzed.
- Meta Decision OS was not broadened in this pass.

## Recommended Next Action

Finish validation, open the PR, and merge only if checks and runtime smoke pass.
