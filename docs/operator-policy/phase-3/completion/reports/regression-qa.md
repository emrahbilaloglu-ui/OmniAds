# Regression QA Report

## Scope

Role: Regression QA Agent for Adsecute Phase 3 Completion.

Constraint followed: no app code changes. This pass only wrote this report.

## Branch And Commit Evidence

- Current branch: `feature/adsecute-decision-range-firewall`
- Tracking status: branch is aligned with `origin/feature/adsecute-decision-range-firewall`
- Latest local commit: `55d7961 Preserve command center identity during provenance rollout`
- Local HEAD SHA: `55d7961a2b3de61f99806649fd3e40311939878e`
- Origin feature branch SHA: `55d7961a2b3de61f99806649fd3e40311939878e`
- PR #16 status from GitHub: open, not merged, mergeable
- PR #16 URL: `https://github.com/erhanrdn/OmniAds/pull/16`

## Main Branch Safety

- Current branch is not `main`.
- Local `main` SHA: `e1fbea22932c68413c8a9e27038b727b4848a963`
- `origin/main` SHA: `e1fbea22932c68413c8a9e27038b727b4848a963`
- Evidence indicates `main` was not modified by this pass.

## Working Tree

`git status --short --branch` showed:

```text
## feature/adsecute-decision-range-firewall...origin/feature/adsecute-decision-range-firewall
?? docs/operator-policy/phase-3/
```

The untracked path is the Phase 3 completion report directory. This pass did not modify app code.

## Local Checks Recorded

These checks were recently run by the orchestrator and recorded for this QA pass:

- `npm test -- lib/operator-decision-metadata.test.ts lib/command-center.test.ts lib/command-center-execution-service.test.ts app/api/meta/decision-os/route.test.ts app/api/meta/recommendations/route.test.ts app/api/creatives/decision-os/route.test.ts lib/meta/decision-os.test.ts lib/creative-decision-os.test.ts components/meta/meta-decision-os.test.tsx components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx`
  - Result: passed, 10 files / 72 tests
- `npm test`
  - Result: passed, 288 files / 1908 tests
- `npx tsc --noEmit`
  - Result: passed
- `git diff --check`
  - Result: passed
- `npm run build`
  - Result: passed
- Lint
  - Result: no lint script exists

This role did not rerun the full suite; it verified branch/commit state and GitHub CI status.

## GitHub CI Status

- Workflow: `CI`
- Run number: `444`
- Run ID: `24775532981`
- Commit: `55d7961a2b3de61f99806649fd3e40311939878e`
- Final workflow status: completed
- Final workflow conclusion: success

Job evidence:

- `build`: completed / success
- `test`: completed / success
- `typecheck`: completed / success
- `detect-runtime-changes`: skipped
- `skip-runtime-deploy`: skipped
- `publish-web-image`: skipped
- `publish-worker-image`: skipped
- `dispatch-deploy`: skipped

## Automated-Check Blockers

No remaining automated-check blocker found in this pass.

Open non-automated gate remains runtime/browser smoke or explicit owner waiver, per the broader Phase 3 merge rules.
