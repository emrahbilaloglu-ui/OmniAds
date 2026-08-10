# Native Ad Scale Hardening Handoff - 2026-07-15

## Objective

Finish, independently review, release, and verify the systemic native-ad
decision hardening already implemented in this worktree. Do not narrow the
solution to one business. The release must make the native producer reliable
for both large Meta accounts and businesses without a Meta binding, while
preserving decision math, authority, and fail-closed behavior.

## Required Read Order

1. `/Users/harmelek/Adsecute/AGENTS.md`
2. `docs/creative-decision-center/START_HERE.md`
3. The decision documents required by `START_HERE.md`
4. This handoff
5. `docs/creative-decision-center/NATIVE_AD_SCALE_HARDENING_2026-07-14.md`
6. The complete uncommitted diff against `origin/main`

Do not trust this handoff in place of the current repository or live evidence.
Recheck drift before acting.

## Repository State At Handoff

- Repository: `/Users/harmelek/Adsecute`
- Branch: `codex/native-ad-scale-hardening`
- Branch base and `origin/main`: `708a5cc938300a2dff9d84f0653c062c8cdf2b2c`
- Working tree: intentionally dirty with the hardening implementation; nothing
  is staged or committed.
- Current hotfix has not been pushed, opened as a PR, merged, or deployed.
- Prior release PR: `#198`, merged as `708a5cc9` and last verified deployed on
  both production domains before this follow-up began.
- Do not reset, discard, or recreate the current work. Inspect and continue it.

Changed production files:

- `lib/creative-decision-engine/batching.ts` (new)
- `lib/creative-decision-engine/data-source.ts`
- `lib/creative-decision-engine/decision-stability.ts`
- `lib/creative-decision-engine/evaluation-store.ts`
- `lib/creative-decision-engine/jobs/ad-decisions-job.ts`
- `lib/creative-decision-engine/jobs/native-ad-scheduled.ts`

Changed/new tests:

- `lib/creative-decision-engine/__tests__/batching.test.ts` (new)
- `lib/creative-decision-engine/__tests__/data-source.ad-grain.test.ts`
- `lib/creative-decision-engine/__tests__/decision-stability.test.ts`
- `lib/creative-decision-engine/__tests__/evaluation-store.test.ts`
- `lib/creative-decision-engine/__tests__/jobs/ad-decisions-job.test.ts`
- `lib/creative-decision-engine/__tests__/jobs/native-ad-scheduled.test.ts`

Evidence artifact:

- `docs/creative-decision-center/NATIVE_AD_SCALE_HARDENING_2026-07-14.md`

## Production Trigger And Diagnosis

The all-business verification after PR #198 exposed two systemic defects:

1. Bilsem Zeka had roughly 3.1k active native ads. Its native decisions job
   failed after 41,759 ms because an individual database statement exceeded the
   production 30-second query timeout.
2. Enise had no `business_provider_accounts.provider = 'meta'` binding, but the
   native Meta scheduler still admitted it and repeatedly failed on an
   unproven empty hydration.

Read-only Bilsem diagnosis through the live tunnel showed:

- Exact complete manifest: 3,136 ads.
- Unoptimized diagnostic hydration: 71,290 ms total.
- Global present-state scan: 10,431 ms.
- Hydration SQL: 21,278 ms.
- Entity-state SQL: 20,321 ms.
- `EXPLAIN ANALYZE`: 604,792 history rows sorted with an external merge,
  240,283 shared blocks read, 8,388 ms for the unnecessary global seed path.
- Naive 250-row batching avoided the statement timeout but regressed total
  tunnel time to 88,973 ms because of excessive round trips.
- Final 500-row exact-identity implementation: 3,136/3,136 hydrated,
  `authoritative=true`, 48,181 ms total, and no statement exceeded 30 seconds.

All live diagnosis was SELECT/read-only. No manual cron, provider write,
database write, or production environment edit was performed.

## Implemented Systemic Fix

1. A shared 500-row batching primitive bounds native-ad database payloads.
2. Complete same-day manifests supply exact ad identities to current-state and
   hydration reads. The expensive global state-history seed scan is skipped.
3. Complete-manifest state rows are reused as status evidence instead of being
   read twice.
4. Missing or incomplete receipts preserve the existing unbounded fallback and
   fail-closed authority semantics; completeness is never manufactured.
5. Hysteresis reads, evaluation persistence, snapshot upserts, previous
   snapshot reads, and change-event reconciliation are batched.
6. Every batched write still runs inside the existing job transaction, so a
   later failure must roll back all prior batches.
7. Change-event matching includes provider account reference, provider account
   ID, and ad ID to avoid cross-account row association.
8. The scheduled native Meta chain filters active+enabled businesses through
   actual Meta bindings. An unbound business receives no native chain run; a
   bound but unhealthy account remains visible and fail-closed.
9. Decision formulas, labels, authority contracts, pruning rules, and engine
   versions are intentionally unchanged.

## Verification Already Completed

Before the final test-format cleanup:

- Full Vitest: 573 files passed, 4 skipped; 4,855 tests passed, 61 skipped,
  61 todo.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run test:migrations-from-zero`: passed against real Postgres seams.
- `node --import tsx scripts/ephemeral-postgres-native-ad-decision-seam.ts`:
  passed all native receipt, tombstone, cutoff, retry, authority, and linkage
  checks.
- `npm run build`: passed; 220 routes.
- `git diff --check`: passed.

Rechecked on 2026-07-15 after the last identity-key and formatting cleanup:

- Six targeted files: 100 tests passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

Do not treat these results as a reason to skip the final release gates after
review changes.

## Mandatory Independent Review

Use a fresh Claude Code application chat for an independent adversarial review
before committing. The reviewer must inspect the actual current diff and must
not be asked to implement, commit, push, or deploy during the first pass.

The review must cover:

- complete-manifest cutoff/tombstone/account lineage and fallback truth;
- duplicate/provider-account-reference identity handling;
- all native producer read and write batch boundaries;
- transaction rollback and conflict/idempotency behavior across batches;
- snapshot/evaluation lineage and change-event reconciliation;
- scheduler kill-switch/slot/schema/Meta-eligibility ordering;
- whether boundary tests prove behavior instead of only call counts;
- whether a real-Postgres rollback or large-account seam is still required;
- confirmation that formula, label, authority, prune, and version behavior did
  not change.

Require findings ordered P1/P2/P3 with exact file and line references and a
final verdict of exactly `STOP_AND_FIX` or `CONTINUE`. Resolve every confirmed
P1/P2 and any correctness-relevant P3, rerun review, and proceed only on
`CONTINUE`.

## Remaining Execution Sequence

1. Re-read the current diff and run the independent Claude review.
2. Fix confirmed findings with focused tests. Preserve fail-closed semantics.
3. Run the complete final gate set:
   - `npm run typecheck`
   - `npm run lint`
   - `npx vitest run`
   - `npm run test:migrations-from-zero`
   - `node --import tsx scripts/ephemeral-postgres-native-ad-decision-seam.ts`
   - `npm run build`
   - `git diff --check`
4. Stage only the intended files, inspect the staged diff, and commit on
   `codex/native-ad-scale-hardening`.
5. Push the branch and open a focused ready-for-review PR. Explain the systemic
   trigger, generic fix, unchanged decision behavior, test evidence, read-only
   live replay, and rollback path.
6. Wait for all CI checks and GitHub reviews. Resolve all actionable feedback,
   rerun gates, and repeat until green with no unresolved correctness comments.
7. Merge through the normal repository workflow. Do not deploy with manual host
   compose commands.
8. Monitor the standard deploy and post-deploy workflows to completion.
9. Verify both production domains report the exact merged SHA from
   `/api/build-info`; verify web/worker health and the workflow's environment
   pin assertion.
10. Wait for the natural scheduler wave. Do not manually POST `/api/sync/cron`.
11. Through the live tunnel, run the generic current-epoch SELECT-only
    operational verifier with the exact deploy anchor, scheduler date, expected
    business/account counts, and Enise UUID negative control. Its deterministic
    JSON/checksum must remain under `/tmp`:

    ```bash
    npm run creative:decision:native-ad-natural-wave-verify -- \
      --as-of=<successful-post-deploy-scheduler-date> \
      --deploy-anchor=<exact-final-deploy-timestamp> \
      --expected-business-count=12 \
      --expected-provider-account-count=13 \
      --expected-unbound=64df05ed-fd04-4274-968b-5bf122235e89 \
      --env-default-enabled=<exact-deployed-DECISION_ENGINE_V3_ENABLED>
    ```

    Derive `--env-default-enabled` from the final deployed release
    environment. The production code default is `true` only when
    `DECISION_ENGINE_V3_ENABLED` is absent; use `true` for an absent variable
    only after that absence is proved from the standard release authority.

    The passing proof must show:
    - Bilsem's latest current-version native calibration, decisions, and
      operator jobs succeed without statement timeout and cover the complete
      current manifest.
    - Snapshot/evaluation linkage is complete and authority contradictions are
      zero.
    - Enise receives no new native Meta chain run after the deployed scheduler
      filter because it has no Meta binding; historical failed rows are not a
      regression.
    - Every active+enabled Meta-bound business has a terminal latest job state,
      with no failed, running, or stuck rows attributable to the release.
    - IwaStore, EMOLOS, TheSwaf, and Grandmix remain healthy and show no decision
      behavior epoch change from this operational-only release.
12. If live evidence finds another account-class failure, fix the generic class
    rather than adding a business-specific exception, then repeat the full
    release loop.

## Hard Constraints

- Live DB tunnel is SELECT-only.
- No provider writes during verification.
- No manual `/api/sync/cron` POST.
- No manual production environment edits or host compose deploys.
- Do not change decision formulas or bump an engine version for this operational
  hardening unless a newly proven correctness defect makes that unavoidable and
  is explicitly documented.
- Do not let UI compute buyer actions or weaken missing-data authority.
- Do not revert unrelated user/concurrent changes.
- User-facing completion report must be Turkish; durable technical artifacts
  remain English.
- Continue until PR, CI, deploy, and natural-schedule live evidence are all
  complete, unless a real external blocker is proven.

## Prompt For The New Codex Chat

```text
Continue the Adsecute native-ad systemic hardening from
/Users/harmelek/Adsecute. First read AGENTS.md and
docs/creative-decision-center/HANDOFF_NATIVE_AD_SCALE_HARDENING_2026-07-15.md,
then follow its required read order and verify every claim against the current
repo and live state. Preserve the existing dirty worktree on branch
codex/native-ad-scale-hardening; do not restart or discard it.

Use the fresh Claude Code application chat for the mandatory independent review
described in the handoff, reconcile its findings with your own review, and fix
confirmed issues. Then complete all local gates, commit, push a focused PR,
wait for CI and reviews, resolve every actionable finding, merge through the
normal workflow, monitor deploy, and perform the passive SELECT-only
all-business production verification after the natural scheduler wave. Do not
manually trigger cron, write to the provider/live DB, or make business-specific
exceptions. Continue until no planned technical or release work remains.
User-facing updates and final summary must be Turkish.
```

## Prompt For The Fresh Claude Code Chat

```text
You are the independent phase-end adversarial reviewer for
/Users/harmelek/Adsecute. First read AGENTS.md and
docs/creative-decision-center/HANDOFF_NATIVE_AD_SCALE_HARDENING_2026-07-15.md,
then inspect the CURRENT uncommitted diff on branch
codex/native-ad-scale-hardening against origin/main. Do not edit files, commit,
push, deploy, or write to any live system during this first review. You may run
local read-only tests and inspect code/docs.

Independently verify the complete-manifest exact-identity hydration and state
semantics, cutoff/tombstone/completeness/account lineage, incomplete-receipt
fallback, all 500-row read/write batch boundaries, transaction rollback and
idempotency across batches, snapshot/evaluation/change-event identity safety,
Meta-binding scheduler eligibility and guard ordering, and the strength of the
tests. Confirm explicitly whether decision formulas, labels, authority,
pruning, and engine versions remain unchanged. Do not trust the handoff's test
or performance claims without checking the code and available evidence.

Return findings first, ordered P1/P2/P3. Every finding must include exact
file:line evidence, failure mechanism, and a concrete fix/test. Do not
manufacture findings. Then report the checks you performed and finish with a
verdict exactly STOP_AND_FIX or CONTINUE.
```
