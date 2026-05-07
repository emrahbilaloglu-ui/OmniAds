# Phase 05 Release Checklist

## Preflight
- Run `npx tsc --noEmit --pretty false`
- Run targeted Command Center tests plus existing Meta/Creative regression tests
- Run `npm run test`
- Run `npm run build`
- Confirm export/share parity and `/platforms/meta/copies` are unchanged

## Local Browser Smoke
- Reviewer
  - open `/command-center`
  - verify queue, journal, and handoff surfaces render
  - verify reviewer sees explicit read-only reason
  - verify mutation affordances are disabled
- Commercial smoke operator
  - open `/command-center`
  - approve, reject, reopen, complete-manual, assign, snooze, and note a queue item
  - create a shared saved view
  - create and acknowledge a handoff
  - verify Meta and Creative source deep-links open correctly
- Meta source
  - verify Command Center entry card renders on account/campaign detail
- Creative source
  - open a creative
  - verify workflow status card renders and deep-links into Command Center

## Release Discipline
- Merge to `main`
- Let CI publish exact-SHA images
- Let `.github/workflows/deploy-hetzner.yml` deploy that exact SHA
- Do not deploy branch names, `main`, or floating tags directly

## Post-Deploy Verification
- Verify `https://adsecute.com/api/build-info` returns the release SHA
- Verify `https://www.adsecute.com/api/build-info` returns the same SHA
- Run:
  - `node --import tsx scripts/verify-serving-direct-release.ts <businessId> --mode=post_deploy --base-url=https://adsecute.com --expected-build-id=<release_sha>`
- Run live Playwright smoke for reviewer and commercial operator
- Validate command center queue, journal, saved view, and handoff flows in production

## Rollback Readiness
- Identify prior known-good exact SHA before release
- Roll back using the existing exact-SHA deploy workflow only
- Do not remove additive command-center tables during rollback
- Re-run build-info verification and live smoke after rollback

## Blockers
- Command Center mutations are not idempotent under retry
- deterministic/AI provenance boundary regresses
- wording split or operating-mode semantics regress
- export/share truth regresses
- `/platforms/meta/copies` risk worsens
- build-info does not match release SHA
- local or live smoke fails
