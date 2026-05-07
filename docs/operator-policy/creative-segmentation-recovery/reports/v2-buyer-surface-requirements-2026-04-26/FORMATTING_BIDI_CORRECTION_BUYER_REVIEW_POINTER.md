CHATGPT_REVIEW_READY: YES
ROLE: CLAUDE_MEDIA_BUYER_JUDGE
ADDENDUM_FOR: PR #80
POINTER_ONLY: YES
ALSO_PUSHED_AS_BRANCH: review/creative-v2-formatting-bidi-correction-buyer-review-2026-04-27
ALSO_PUSHED_AS_BRANCH_HEAD_COMMIT: 06177a722baf01eecb7a8951bdbc92ea411a66fe
DRAFT_PR_OPEN_URL: https://github.com/erhanrdn/OmniAds/pull/new/review/creative-v2-formatting-bidi-correction-buyer-review-2026-04-27
DRAFT_PR_TITLE: [CHATGPT-REVIEW] Creative v2 formatting + bidi correction buyer review
PRIMARY_REPORT_PATH: docs/operator-policy/creative-segmentation-recovery/reports/v2-formatting-bidi-correction-buyer-review-2026-04-27/FOR_CHATGPT_REVIEW.md
TARGET_PR: #81
TARGET_BRANCH: wip/creative-v2-readonly-ui-preview-2026-04-26
TARGET_HEAD_COMMIT: 0f90b2d4037e56ee0a4765cad07134b0bc977210
SANITIZED: YES
PRODUCT_CODE_CHANGED: NO
RESOLVER_LOGIC_CHANGED: NO
GOLD_LABELS_CHANGED: NO
MERGE_REQUESTED: NO
MAIN_PUSHED: NO

# Pointer

The senior Meta media buyer review of Codex's narrow active-file
formatting + hidden/bidi correction packet on PR #81 has been pushed as a
standalone branch and a single primary report file. The local `gh` CLI is
not authenticated in this environment and no `GH_TOKEN` /
`GITHUB_TOKEN` is exported, so a Draft PR could not be opened from here.

This file is a pointer only. The full review is at the
`PRIMARY_REPORT_PATH` on the standalone branch.

# Verdict summary

- Verdict: MERGE_READINESS_STILL_BLOCKED.
- Product-ready: NO.
- Merge-ready to main: NO.
- Merge-ready for human consideration into the PR #78 stacked
  dependency branch: NO. Conditional yes from the prior review is
  withdrawn alongside the false-positive exception that supported it.
- Queue/apply safe: NO.
- Buyer confidence score: 83/100 (down from 86).

# What changed

Code (`cb9eb9b`):

- `CreativeDecisionOsV2PreviewSurface.tsx` — extracted shared className
  constants and broke long inline class strings across multiple lines.
  No functional change. 593 lines, max 118 chars (independently
  verified).
- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx` — split dense vi.mock
  factories across multiple readable lines. 292 lines, max 108 chars
  (independently verified).
- `lib/creative-decision-os-v2-preview.test.tsx` — added a new
  file-hygiene test that fails if any active TS/TSX preview file is
  compressed (large file with too few lines) or contains a line longer
  than 220 characters.

Documentation (`256d337`, `0f90b2d`):

- Withdrew the prior `closed_by_documented_false_positive_exception`
  for M1/M2.
- Recorded post-push public GitHub evidence at PR #81 head `cb9eb9b`
  showing the GitHub files-view hidden/bidi warning banner is still
  visible on `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx`,
  `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`,
  `app/api/creatives/decision-os-v2/preview/route.test.ts`, and
  `app/api/creatives/decision-os-v2/preview/route.ts` after formatting,
  with raw scans reporting zero hidden/bidi/control codepoints in those
  files. Re-tagged the verdict back to "not ready for human merge
  consideration into the PR #78 branch while the active GitHub warning
  remains open".

# Independent verification

Active raw file metrics confirm the formatting fix:

| File | Lines | Max line |
| --- | ---: | ---: |
| `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx` | 292 | 108 |
| `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx` | 1266 | 196 |
| `app/api/creatives/decision-os-v2/preview/route.test.ts` | 65 | 109 |
| `app/api/creatives/decision-os-v2/preview/route.ts` | 117 | 105 |
| `components/platforms/meta/creatives/CreativeDecisionOsV2PreviewSurface.tsx` | 593 | 118 |

Component still has only one `<button>` with `onClick`, wired to the
existing `onOpenRow` callback. No new write paths.

# Remaining blockers

Pre-merge for human consideration into the PR #78 stacked dependency
branch:

- M1/M2: Active GitHub files-view hidden/bidi banner on the four
  documented files persists after formatting. Either the banner clears
  on a follow-up files-view recheck, or post-formatting per-line
  evidence captures exactly what GitHub is flagging, or an owner-level
  adjudication with concrete trigger evidence is recorded.

Pre-merge to main (additional):

- M5: Authenticated GraphQL inspection of unresolved review-thread
  state.
- M6 (CI wiring): Contract parity / forbidden-term scan must fail the
  merge gate automatically in CI.
- M3 extension: Mechanical authenticated DOM scan with `data-testid`
  assertions plus network-level write-request capture.

Product-ready:

- P1-P7 unchanged from prior review.

# Recommended next step

Do not merge PR #81 into the PR #78 stacked dependency branch yet. Keep
PR #81 Draft. Continue limited read-only preview as supervised evidence
gathering. Drive M1/M2 to closure via:

1. Recheck the GitHub files-view banner after a brief delay; if gone,
   record the exact PR #81 head SHA and re-run this review.
2. If persistent, ask the supervisor (authenticated browser session) to
   capture exact post-formatting line ranges and any specific character
   ranges GitHub highlights, then either normalize/replace the
   identifiable codepoint or record concrete owner-visible evidence for
   adjudication.
3. Do not silently re-introduce the prior false-positive exception
   without one of those paths.

# Confirmations

- This pointer changed no product code, resolver logic, gold labels,
  fixtures, v1 behavior, UI behavior, queue/apply, Command Center
  wiring, DB writes, or Meta/platform writes.
- This pointer did not merge, did not push to main, did not enable
  queue/apply, did not wire Command Center, and did not introduce any
  write behavior.
- All artifacts cited use sanitized row aliases.
- Active runtime validation refers to the self-hosted server and
  self-hosted PostgreSQL database only.
