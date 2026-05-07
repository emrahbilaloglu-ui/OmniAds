# PR #65 Main Release Evidence - 2026-04-28

Scope:

- Integrated PR #65 media-buyer scoring into the current main release path.
- Preserved the PR #74 fatigued high-spend below-baseline Cut behavior inside the new scorecard path.
- Restored Creative v2 buyer preview visibility on the default Creative page, with explicit query opt-out only.
- Reviewed open Creative PRs for runtime/UI work. PR #65 was the only open non-draft runtime merge candidate; older draft/review PRs are evidence or helper history and must not be wholesale applied over the current v2 UI.
- Google Ads and sync/control-plane work were intentionally excluded from this release scope.

Verification:

- `git diff --cached --check`: pass
- hidden/bidi/control scan over staged files: pass
- `npm test`: pass, 308 files / 2251 tests
- `npx tsc --noEmit`: pass
- `npm run build`: pass
- `npm run creative:v2:safety`: pass, macro F1 `97.96`, severe/high mismatches `0`, queue/apply/direct-scale safety counts `0`
- `npx vitest run lib/creative-v2-no-write-enforcement.test.ts --reporter=verbose`: pass, 5 tests
- `node --import tsx scripts/check-request-path-side-effects.ts --json`: pass for Creative v2 preview, `previewRouteFindings=0`
- Local DB Creative v2 smoke through SSH tunnel: pass

Local DB smoke result:

- `/platforms/meta/creatives` default buyer preview visible: true
- explicit preview opt-out hidden: true
- explicit preview opt-in visible: true
- forbidden action terms: `0`
- forbidden internal terms: `0`
- write-like mutation requests: `0`

Release notes:

- No database migration is expected.
- No queue/apply/push path was added for Creative v2.
- Command Center remains disconnected from Creative v2 preview.
- Temporary local auth storage state was deleted after smoke verification.
