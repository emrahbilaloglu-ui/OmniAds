# Stack Consolidation Audit

CHATGPT_REVIEW_READY: YES
SANITIZED: YES
MAIN_PUSHED: NO
MERGE_REQUESTED: NO

# Source Branch Heads

PR #82 is now the canonical WIP integration candidate. PR #81 is superseded as
the merge surface and remains available for audit/history. PR #78 remains the
resolver base, and main remains untouched.

| Source | Branch | Commit |
| --- | --- | --- |
| PR #78 resolver branch | `wip/creative-decision-os-v2-baseline-first-2026-04-26` | `3da2e05cb47f97de89ee42d9af6a64598af8b17a` |
| PR #81 read-only preview branch | `wip/creative-v2-readonly-ui-preview-2026-04-26` | `bc9624e49d6c8b76746d6eb0ad062ce0ea5b43fc` |
| Integration candidate | `wip/creative-decision-os-v2-integration-candidate-2026-04-27` | merge commit `6b37ab17b940aeab95e72a7e4ce3aced00facbf1` before this report packet |

PR #81 is still based directly on PR #78. The merge-base between the PR #78
branch and the PR #81 branch is `3da2e05cb47f97de89ee42d9af6a64598af8b17a`,
which is the current PR #78 head.

# Merge Strategy Used

Codex did not update the PR #78 branch directly. A separate integration
candidate branch was created from PR #78, then PR #81 was merged into it with:

```bash
git checkout -B wip/creative-decision-os-v2-integration-candidate-2026-04-27 \
  origin/wip/creative-decision-os-v2-baseline-first-2026-04-26

git merge --no-ff origin/wip/creative-v2-readonly-ui-preview-2026-04-26 \
  -m "merge: integrate creative v2 read-only preview candidate"
```

Reason for integration branch instead of direct PR #78 mutation:

- Code merge was clean.
- Authenticated self-hosted runtime smoke could not be independently rerun from
  this shell without asking for prohibited domain, token, session, server, or DB
  details.
- The integration branch preserves Draft/WIP review without mutating PR #78.

# Conflicts

No merge conflicts occurred.

# Files Changed By Consolidation

The merge brought in the PR #81 changed files relative to PR #78:

- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx`
- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`
- `app/api/creatives/decision-os-v2/preview/route.test.ts`
- `app/api/creatives/decision-os-v2/preview/route.ts`
- `components/platforms/meta/creatives/CreativeDecisionOsV2PreviewSurface.tsx`
- `lib/creative-decision-os-v2-preview.test.tsx`
- `lib/creative-decision-os-v2-preview.ts`
- `src/services/data-service-ai.ts`
- PR #81 report files under
  `docs/operator-policy/creative-segmentation-recovery/reports/`

This audit then adds only the integration-candidate report packet under:

`docs/operator-policy/creative-segmentation-recovery/reports/v2-integration-candidate-2026-04-27/`.

# Behavior Change Beyond Combining PR #78 and PR #81

No behavior changed beyond combining the existing PR #78 resolver work and PR
#81 read-only preview work. The report packet is documentation only.

No resolver thresholds changed. No gold labels changed. v1 behavior was not
changed. Queue/apply was not enabled. Command Center was not wired. No DB write
or Meta/platform write path was added.

# Exact Commands Run

Pre-consolidation on PR #81:

```bash
git fetch --prune origin
git rev-parse HEAD
git merge-base origin/wip/creative-decision-os-v2-baseline-first-2026-04-26 \
  origin/wip/creative-v2-readonly-ui-preview-2026-04-26
git diff --check
npm test
npx tsc --noEmit
npm run build
npx vitest run lib/creative-decision-os-v2.test.ts \
  lib/creative-decision-os-v2-preview.test.tsx \
  components/platforms/meta/creatives/CreativeDecisionSupportSurface.test.tsx \
  components/platforms/meta/creatives/CreativesTableSection.test.tsx \
  app/'(dashboard)'/platforms/meta/creatives/page.test.tsx \
  app/api/creatives/decision-os-v2/preview/route.test.ts
node --import tsx scripts/creative-decision-os-v2-gold-eval.ts
node <targeted changed-file hygiene scan>
node <report-json-parse-check>
```

Post-consolidation on the integration branch:

```bash
git diff --check
npm test
npx tsc --noEmit
npm run build
npx vitest run lib/creative-decision-os-v2.test.ts \
  lib/creative-decision-os-v2-preview.test.tsx \
  components/platforms/meta/creatives/CreativeDecisionSupportSurface.test.tsx \
  components/platforms/meta/creatives/CreativesTableSection.test.tsx \
  app/'(dashboard)'/platforms/meta/creatives/page.test.tsx \
  app/api/creatives/decision-os-v2/preview/route.test.ts
node --import tsx scripts/creative-decision-os-v2-gold-eval.ts
node <targeted changed-file hygiene scan>
node <report-json-parse-check>
```

Public GitHub review/comment audit:

```bash
curl -fsSL https://api.github.com/repos/erhanrdn/OmniAds/pulls/78
curl -fsSL https://api.github.com/repos/erhanrdn/OmniAds/pulls/79
curl -fsSL https://api.github.com/repos/erhanrdn/OmniAds/pulls/80
curl -fsSL https://api.github.com/repos/erhanrdn/OmniAds/pulls/81
curl -fsSL https://api.github.com/repos/erhanrdn/OmniAds/pulls/<PR>/reviews
curl -fsSL https://api.github.com/repos/erhanrdn/OmniAds/pulls/<PR>/comments
curl -fsSL https://api.github.com/repos/erhanrdn/OmniAds/issues/<PR>/comments
```

# Final Branch Graph Summary

```text
6b37ab1 merge: integrate creative v2 read-only preview candidate
|\
| bc9624e docs: add targeted creative v2 warning proof
| ...
| 735765d Add read-only creative v2 preview surface
|
3da2e05 Document PR78 hidden Unicode inspection
...
3f2c0dc Add Creative Decision OS v2 baseline WIP
```

# PR Body Update Status

`gh auth status` reported that the local GitHub CLI is not logged in. Codex did
not ask the supervisor for a token and did not run `gh auth login`.

The GitHub connector was available after the branch was pushed, so Codex opened
Draft PR #82:

`https://github.com/erhanrdn/OmniAds/pull/82`

PR #82 targets:
`wip/creative-decision-os-v2-baseline-first-2026-04-26`.

PR #82 head:
`wip/creative-decision-os-v2-integration-candidate-2026-04-27`.

Codex did not update PR #78 or PR #81 bodies because no PR-body update connector
tool was available and local `gh` was not authenticated.

# GitHub Auth Limitation Status

Public GitHub API reads were available and used for PR metadata and public
comment/review counts. The GitHub connector was available for creating Draft PR
#82. Authenticated private review-thread state was not inspected.

If the merge owner sees unresolved threads in an authenticated GitHub UI, those
threads remain active blockers.
