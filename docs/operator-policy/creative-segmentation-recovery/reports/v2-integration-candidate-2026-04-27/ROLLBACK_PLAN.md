# Rollback Plan

CHATGPT_REVIEW_READY: YES
SANITIZED: YES

# Immediate Disable Path

The v2 preview is off by default. To disable it immediately for users, do not
use the `creativeDecisionOsV2Preview=1` query parameter. Without that flag, the
normal v1 Creative page remains the default surface.

No queue/apply path is connected to the v2 preview. Command Center remains
disconnected.

# Confirmations

- v1 remains default.
- v2 preview remains off by default.
- Queue/apply remains disabled.
- Command Center remains disconnected.
- No DB write path was added by the preview.
- No Meta/platform write path was added by the preview.
- Main was not pushed.

# Candidate Branch Rollback

If the integration candidate is rejected before it is merged anywhere:

1. Leave PR #78 unchanged.
2. Leave PR #81 unchanged and Draft.
3. Close or ignore the integration candidate branch/PR.
4. Do not delete source branches unless the owner explicitly requests it.

# If Candidate Is Merged Into PR #78 Later

If the candidate or PR #81 is later merged into the PR #78 branch and needs to
be backed out before main:

1. Revert the merge commit on the PR #78 branch.
2. Verify `/platforms/meta/creatives` without the preview query parameter still renders v1.
3. Verify `/platforms/meta/creatives?creativeDecisionOsV2Preview=1` no longer renders the v2
   preview if the revert removes the preview.
4. Rerun `npm test`.
5. Rerun the focused Creative/v2 tests if any v2 files remain.
6. Rerun `npx tsc --noEmit`.
7. Rerun `npm run build`.

# Files To Revert If Needed

The v2 read-only preview integration is mainly contained in:

- `components/platforms/meta/creatives/CreativeDecisionOsV2PreviewSurface.tsx`
- `lib/creative-decision-os-v2-preview.ts`
- `lib/creative-decision-os-v2-preview.test.tsx`
- `app/api/creatives/decision-os-v2/preview/route.ts`
- `app/api/creatives/decision-os-v2/preview/route.test.ts`
- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`
- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx`
- `src/services/data-service-ai.ts`

Report-only artifacts live under:

- `docs/operator-policy/creative-segmentation-recovery/reports/v2-readonly-ui-preview-2026-04-26/`
- `docs/operator-policy/creative-segmentation-recovery/reports/v2-limited-operator-preview-session-2026-04-26/`
- `docs/operator-policy/creative-segmentation-recovery/reports/v2-second-operator-preview-session-2026-04-27/`
- `docs/operator-policy/creative-segmentation-recovery/reports/v2-integration-candidate-2026-04-27/`

# Preserve v1

Do not remove or change existing v1 Creative page behavior as part of rollback.
The rollback should remove only the preview flag path, preview endpoint, preview
surface, and related tests/reports if the owner chooses to remove the WIP.

# Verify Queue/Apply Remain Disconnected

After rollback or revert, verify:

- No preview UI renders Apply, Queue, Push, Auto, Scale now, Cut now, or
  Approve action copy.
- No v2 preview code imports or calls Command Center execution/apply modules.
- `npm test` and focused Creative/v2 tests pass or the removed v2 tests are
  intentionally absent after rollback.

# Rollback Without Affecting Main Production

This work remains on Draft/WIP branches. To roll back without affecting main
production, revert or close the candidate branch before any main merge. Do not
push to main. Do not deploy as product-ready.
