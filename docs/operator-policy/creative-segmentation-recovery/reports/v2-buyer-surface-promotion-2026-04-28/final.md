# Creative v2 Buyer Surface Promotion - 2026-04-28

SANITIZED: YES

## Scope

- Promote the Creative v2 read-only buyer surface from limited query-gated
  preview to normal `/platforms/meta/creatives` page visibility.
- Preserve explicit opt-out with `creativeDecisionOsV2Preview=0`,
  `creativeDecisionOsV2Preview=false`, `v2Preview=0`, or `v2Preview=false`.
- Preserve the existing read-only safety boundary: v1 still renders, queue/apply
  stays disconnected, Command Center stays disconnected, and no DB or
  Meta/platform write path is added.
- Preserve PR #79 surface-contract and PR #80 buyer-requirements history in
  main as docs-only evidence. No stale branch code is used.

## Product-Readiness Closure

- `Scale-worthy = 0` confusion is closed by the `Scale-ready` label and strict
  evidence explanation.
- Diagnose `Investigate` no-op is closed; the aggregate Diagnose lane is not a
  clickable empty action, and row buttons open read-only detail.
- Ready for Buyer Confirmation is separate from Diagnose and has an empty state
  when no direct confirmation candidates exist.
- Direct-actionability live-row absence is accepted for this read-only promotion
  through deterministic substitute tests proving direct rows stay in confirmation
  unless separate urgency qualifies.
- Diagnose volume is accepted for this read-only promotion because Diagnose is
  collapsed, grouped, visually separate, and not mixed into confirmation/action
  lanes.

## Verification

- `git diff --check`: pass.
- Hidden/bidi/control scan over touched and untracked files: pass.
- Focused Creative v2/page/API tests: pass, 4 files / 22 tests.
- `npm run creative:v2:safety`: pass, macro F1 `97.96`, severe/high
  mismatches `0`, queue/apply/direct-scale safety counts `0`.
- `npx vitest run lib/creative-v2-no-write-enforcement.test.ts --reporter=verbose`:
  pass, 5 tests.
- `node --import tsx scripts/check-request-path-side-effects.ts --json`:
  pass for Creative v2 preview, `previewRouteFindings=0`.
- `npm test`: pass, 308 files / 2251 tests.
- `npm run build`: pass.
- `npx tsc --noEmit`: pass after the production build completed. A concurrent
  first run raced with `.next/types` generation and was rerun cleanly.
- Local DB Creative v2 smoke through the approved SSH tunnel: pass.

## Local DB Smoke Result

- `/platforms/meta/creatives` default buyer surface visible: true.
- `creativeDecisionOsV2Preview=0` explicit opt-out hidden: true.
- `creativeDecisionOsV2Preview=1` explicit opt-in visible: true.
- Today Priority visible: true.
- `Scale-ready` copy visible: true.
- Ready for Buyer Confirmation visible: true.
- Diagnose visible: true.
- Inactive Review visible: true.
- Forbidden action terms: `0`.
- Forbidden internal terms: `0`.
- Write-like mutation requests: `0`.
- Temporary local auth storage state removed after smoke.
