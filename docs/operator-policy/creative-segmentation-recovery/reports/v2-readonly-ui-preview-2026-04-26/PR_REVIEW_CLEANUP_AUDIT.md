CHATGPT_REVIEW_READY: YES
ROLE: CODEX_WIP_IMPLEMENTATION
BRANCH: wip/creative-v2-readonly-ui-preview-2026-04-26
PRIMARY_REPORT_PATH: docs/operator-policy/creative-segmentation-recovery/reports/v2-readonly-ui-preview-2026-04-26/
HANDOFF_FILE: docs/operator-policy/creative-segmentation-recovery/reports/v2-readonly-ui-preview-2026-04-26/PR_REVIEW_CLEANUP_AUDIT.md
SANITIZED: YES
PRODUCT_CODE_CHANGED: YES
MERGE_REQUESTED: NO
MAIN_PUSHED: NO

# PR Review Cleanup Audit

Generated: 2026-04-26T21:11:23Z

This audit covers PR #81 and its active dependencies. PRs remain Draft. No merge
or main push was performed.

## 1. PR #81 Current HEAD Commit

PR #81 code head before this audit-only documentation update:

- `8d04d358a4e8f0695468052321e9835b7fc6130e`

The final pushed branch head after this audit file is recorded in the PR #81
body because a commit cannot reliably contain its own final SHA.

## 2. PR #78 Dependency Commit

- PR: #78
- Branch: `wip/creative-decision-os-v2-baseline-first-2026-04-26`
- Dependency commit: `3da2e05cb47f97de89ee42d9af6a64598af8b17a`

## 3. PR #79 Contract v0.1.1 Dependency Commit

- PR: #79
- Branch: `review/creative-v2-operator-surface-contract-2026-04-26`
- Dependency commit: `d0c326d3051510df74a7ef063bbd3e93d127a8f2`
- Contract JSON:
  `docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.1.json`

## 4. GitHub Checks Status

GitHub API check-run summary:

| PR | Head | Required local jobs | Deprecated infra checks | Active blocker |
| --- | --- | --- | --- | --- |
| #78 | `3da2e05` | build/test/typecheck success | legacy deploy checks skipped; legacy external suite queued | no |
| #79 | `d0c326d` | build/test/typecheck success | legacy deploy checks skipped; legacy external suite queued | no |
| #80 | `9d2c582` | build/test/typecheck success | legacy deploy checks skipped; legacy external suite queued | no |
| #81 | `8d04d35` | build/test/typecheck success | legacy deploy checks skipped; legacy external suite queued | no |

Infrastructure update: the active runtime is now the self-hosted site and
self-hosted PostgreSQL database. Vercel and Neon references are deprecated
infrastructure and must not be treated as active merge-readiness blockers.

The queued external app suites and skipped deploy/runtime jobs shown on #78-#81
are tracked here as deprecated-infrastructure artifacts only. They are not
active product blockers for PR #81. Any future active deployment/runtime check
should be named and evaluated against the self-hosted server environment.

## 5. GitHub Files-View Warning Status

GitHub files view inspection:

- PR #79 files view: no active hidden/bidirectional warning text found.
- PR #81 files view: hidden/bidirectional warning text still appears in the
  unauthenticated GitHub files view on multiple active diff sections.

Active PR #81 files-view warnings observed:

Exact warning text:

```text
This file contains hidden or bidirectional Unicode text that may be interpreted or compiled differently than what appears below.
```

| PR | File | GitHub files-view line/context | Status |
| --- | --- | --- | --- |
| #81 | `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx` | lines 318-327 | Not fixed in code; no active codepoint found |
| #81 | `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx` | lines 369-379 | Not fixed in code; no active hidden codepoint found |
| #81 | `app/api/creatives/decision-os-v2/preview/route.test.ts` | lines 469-478 | Not fixed in code; no active hidden codepoint found |
| #81 | `app/api/creatives/decision-os-v2/preview/route.ts` | lines 542-551 | Not fixed in code; no active hidden codepoint found |

The PR #81 unauthenticated files page loaded only the first part of the diff and
then showed a GitHub page-load error. Active raw blobs, PR diff, and PR patch
were scanned separately.

## 6. Hidden/Bidi Warning Status

Active blob and patch scans:

| Target | Result |
| --- | --- |
| PR #79 active raw blobs | no hidden/bidi/control findings |
| PR #79 `.diff` | no hidden/bidi/control findings |
| PR #79 `.patch` | no hidden/bidi/control findings |
| PR #81 active raw blobs | no hidden/bidi/control findings |
| PR #81 `.diff` | no hidden/bidi/control findings |
| PR #81 `.patch` | no hidden/bidi/control findings |

Exact active scan behavior:

- Hidden/control ranges scanned:
  `U+0000-U+0008`, `U+000B`, `U+000C`, `U+000E-U+001F`, `U+007F`,
  `U+202A-U+202E`, `U+2066-U+2069`.
- PR #81 active raw blobs scanned: 10 changed files.
- PR #79 active raw blobs scanned: 3 changed files.

Historical/stale GitHub conversation warnings:

| PR | Location | Context | Status |
| --- | --- | --- | --- |
| #79 | Conversation page lines 273-279 | Historical commit `895016d` | Historical/stale; active files and raw blobs are clean |
| #81 | Conversation page lines 278-284 | Historical commit `735765d` | Historical/stale; active raw blobs and patch are clean |

The PR #81 files view still displays active UI warning banners even though no
hidden/bidi/control codepoint was found in active raw blobs, `.diff`, or
`.patch`. This is not ignored; it remains a documented GitHub UI warning that
must be reviewed before any merge decision.

## 7. Codex PR Review Comments Status

Inspection method:

- GitHub connector `_list_pull_request_review_threads`
- GitHub connector `_fetch_pr_comments`
- GitHub connector `_list_pull_request_reviews`
- PRs inspected: #78, #79, #80, #81
- Local `gh auth status`: unavailable because the GitHub CLI is not logged in.

Result:

| PR | Review threads | Timeline comments/reviews | Review submissions |
| --- | ---: | ---: | ---: |
| #78 | 0 | 0 | 0 |
| #79 | 0 | 0 | 0 |
| #80 | 0 | 0 | 0 |
| #81 | 0 | 0 | 0 |

No Codex PR Review comment was found through the connector surfaces. There was
therefore no actionable review thread to resolve through the connector.

## 8. Unresolved Review Threads Status

GitHub connector review-thread result:

- PR #78: 0 review threads.
- PR #79: 0 review threads.
- PR #80: 0 review threads.
- PR #81: 0 review threads.

No unresolved review thread was found.

## 9. Security/Secret/Raw-Data Scan Status

Local scans were run against the PR #81 changed source/report scope:

- restricted filename scan: passed.
- secret/raw-data pattern scan: passed.
- no environment files are included.
- no raw private screenshots are included.
- report artifacts use sanitized row aliases and sanitized screen notes.

## 10. Formatting/Readability Scan Status

Local formatting/readability checks:

- `git diff --check`: passed.
- line-length/readability check: passed.
- hidden/bidi/control scan: passed.
- strict non-ASCII diff scan: passed.
- v2 preview readability test: passed.

The new report files are multiline Markdown, not generated one-line files.

## Infrastructure Reference Audit

Supervisor infrastructure update applied:

- Active site runtime: self-hosted server.
- Active database runtime: self-hosted PostgreSQL database.
- Deprecated infrastructure names must not be treated as active blockers.
- Generic `DATABASE_URL` requirements remain valid because the self-hosted DB
  still needs a configured PostgreSQL connection string.

PR #81 report updates:

- `FOR_CHATGPT_REVIEW.md`: standard DB connection wording kept, with no
  provider-specific assumption.
- `authenticated-preview-screen-notes.md`: self-hosted DB wording retained.
- `PR_REVIEW_CLEANUP_AUDIT.md`: legacy deploy/check wording reclassified as
  deprecated infrastructure, not active blockers.
- `OPERATOR_SESSION_CHECKLIST.md`: not present in this branch/worktree.

Repository reference scan:

| Path | Reference | Classification | Action |
| --- | --- | --- | --- |
| `lib/db.ts` | `DATABASE_URL` | active generic DB connection | keep |
| `scripts/*seed*`, `scripts/check-google-reset.mjs` | `DATABASE_URL` | active generic DB connection | keep |
| `lib/meta/*`, `lib/platforms/google/*`, `lib/sync/runtime-contract.ts` | `DATABASE_URL` | active generic DB/runtime checks | keep |
| `.github/workflows/db-normalization-second-window.yml` | remote `.env.production` `DATABASE_URL` | self-hosted workflow-style DB lookup | keep |
| `app/api/db-test/route.ts` | legacy provider name in comment | legacy wording leftover | list only; no code change in PR #81 |
| `lib/media-cache/cache-repository.ts` | legacy provider name in comment | legacy wording leftover | list only; no code change in PR #81 |
| `docs/hetzner-migration.md` | legacy provider migration note | historical doc | list only |
| `docs/architecture/serving-runtime-validation-evidence.md` | old provider-specific validation note | historical doc | list only |
| `docs/self-hosted-db-ops.md` | self-hosted DB without deprecated provider | current self-hosted doc | keep |

No product code or deployment workflow was changed in this audit branch. The
legacy provider wording above should be cleaned separately if ChatGPT requests a
repo-wide infrastructure documentation cleanup.

## 11. Remaining Warnings

Remaining documented warnings:

1. PR #81 GitHub files-view hidden/bidirectional warning banners still appear in
   the unauthenticated files UI, despite clean active raw/diff/patch scans.
2. PR #79 and PR #81 conversation pages still show historical hidden/bidi
   warning banners from older commits.
3. The authenticated demo workspace has no direct-actionability row, so visual
   proof of review-only Scale/high-spend Cut ranking above direct Protect/Test
   More is fixture-backed, not workspace-rendered.

Deprecated-infrastructure notes, not active blockers:

- Legacy external deployment suites appear queued through the GitHub checks API.
- Legacy deploy/runtime GitHub Actions jobs are skipped on #78-#81.
- These are not active blockers because the active infrastructure is the
  self-hosted server and self-hosted database.

## Pre-Merge Hard Gate Still Open

Limited read-only preview is allowed. Merge is not allowed.

Before any merge decision, every active warning must be fixed or explicitly
closed with evidence:

- GitHub/Codex PR Review warnings remain tracked.
- Hidden/bidirectional Unicode GitHub UI warnings remain tracked.
- Security, secret, and raw-data warnings remain tracked.
- Formatting and readability warnings remain tracked.
- Unresolved review threads remain tracked.
- Suspicious active self-hosted runtime/deployment checks remain tracked.
- Any active self-hosted DB/live-preview validation blocker remains tracked.

Deprecated infrastructure is not an active blocker:

- Vercel and Neon are deprecated infrastructure.
- Vercel queued/skipped checks must not be listed as active blockers.
- Neon-specific DB assumptions must be removed or marked legacy.
- Active deployment/runtime validation should refer to the self-hosted server
  and self-hosted PostgreSQL database only.

No warning is being ignored silently. Visible GitHub UI warnings and review
items remain documented in this audit until fixed or explicitly closed with
evidence.

## 12. Remaining Warning Detail

- PR #79, conversation historical commit `895016d`, web text lines 273-279:
  hidden/bidirectional Unicode warning. Not changed in code because active files
  view and raw/diff/patch scans are clean. Classified as historical/stale.
- PR #81, conversation historical commit `735765d`, web text lines 278-284:
  hidden/bidirectional Unicode warning. Not changed in code because active
  raw/diff/patch scans are clean. Warning remains visible in conversation.
- PR #81, `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx`, GitHub files view lines
  318-327: hidden/bidirectional Unicode warning. Active raw blob and PR patch
  have no matching hidden/bidi/control codepoint.
- PR #81, `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`, GitHub files view lines
  369-379: hidden/bidirectional Unicode warning. Active raw blob and PR patch
  have no matching hidden/bidi/control codepoint.
- PR #81, `app/api/creatives/decision-os-v2/preview/route.test.ts`, GitHub
  files view lines 469-478: hidden/bidirectional Unicode warning. Active raw
  blob and PR patch have no matching hidden/bidi/control codepoint.
- PR #81, `app/api/creatives/decision-os-v2/preview/route.ts`, GitHub files
  view lines 542-551: hidden/bidirectional Unicode warning. Active raw blob and
  PR patch have no matching hidden/bidi/control codepoint.
- PR #78-#81, GitHub checks: legacy external deploy suite queued. Not fixed in
  PR #81 because it is deprecated infrastructure, not an active blocker.
- PR #78-#81, GitHub Actions deploy/runtime jobs: completed with conclusion
  `skipped`. Not fixed in PR #81 because this is a deprecated deploy/runtime
  path, not an active blocker.
- PR #81, authenticated preview evidence: no direct-actionability row was
  present in the demo workspace. This is not a code fix; fixture-backed sorting
  tests remain the evidence for limited preview.

## 13. No Silent Warning Ignoring

No warning is being ignored silently.

Items that remain visible or suspicious in GitHub UI are listed above with the
reason they were not changed in this branch. PR #81 remains Draft, WIP, and not
merge-requested.

## Commands Run

Review/warning inspection:

- `gh auth status`
- GitHub connector `_list_pull_request_review_threads` for #78-#81
- GitHub connector `_fetch_pr_comments` for #78-#81
- GitHub connector `_list_pull_request_reviews` for #78-#81
- GitHub checks API for #78-#81
- GitHub PR files API plus raw blob hidden/bidi/control scan for #79 and #81
- GitHub PR `.diff` and `.patch` hidden/bidi/control scan for #79 and #81
- GitHub PR conversation/files pages inspected for #79 and #81

Validation checks:

- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- Focused Creative/v2 preview tests
- `node --import tsx scripts/creative-decision-os-v2-gold-eval.ts`
- `git diff --check`
- hidden/bidi/control scan
- strict non-ASCII diff scan
- restricted filename scan
- secret/raw-data scan
- line-length/readability check

Failed command during local verification:

```text
Command: npm test
Error: sh: vitest: command not found
Branch: wip/creative-v2-readonly-ui-preview-2026-04-26
Timestamp: 2026-04-26T21:11Z
Unavailable data: none; the worktree dependency install was absent.
Resolution: reused the existing local dependency install as an untracked
validation-only symlink, reran npm test, and removed the symlink before commit.
```

Final verification results after dependency path was available:

| Check | Result |
| --- | --- |
| `npm test` | passed, 305 files, 2186 tests |
| `npx tsc --noEmit` | passed |
| `npm run build` | passed |
| Focused Creative/v2 preview tests | passed, 6 files, 33 tests |
| v2 gold eval | macro F1 97.96; severe 0, high 0, medium 2, low 0 |
| forbidden rendered button/text scan | passed through focused tests |
| forbidden internal artifact scan | passed through focused tests |
| hidden/bidi/control scan | passed |
| strict non-ASCII diff scan | passed |
| restricted filename scan | passed |
| secret/raw-data scan | passed |
| line-length/readability check | passed |

## Confirmations

- No product behavior was changed by this audit.
- No resolver thresholds were changed.
- v1 behavior was not changed.
- Queue/apply remains disabled for v2 preview.
- Command Center is not wired to v2 preview.
- No platform write behavior was added.
- PR #81 remains Draft.
