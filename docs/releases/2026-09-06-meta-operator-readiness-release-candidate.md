# Meta operator readiness — release candidate, Phase 1

Local verification only. **Nothing has been pushed, no PR exists, nothing is
merged or deployed.** This document is the checkpoint a reviewer reads before
the first push is authorised.

The identity table below is the **preparation** snapshot and is kept as written,
because the numbers in it are exactly right for the commit it names. It is not
this PR's identity: two evidence-correction commits land after it, so the
delivered head is larger. The PR body carries the delivered figures; they are
not restated here, because this document is one of the files the release
manifest pins and quoting the head that contains the manifest would be a
self-hash cycle.

| preparation snapshot | |
|---|---|
| candidate SHA | `fb4b8a3b4c81aef68c212d89a34d984deacd21a2` |
| branch | `codex/meta-v2-panel-fidelity` (published tip at the time `fc8a16b28`; nothing already published was rewritten) |
| remote main at preparation | `3f0bf857a9dde41bf2d7f461ef24b5f2ce26a651` |
| divergence | 44 commits ahead, **0 behind** |
| release diff | 281 files, +68,404 / −3,603 |

## How main was integrated

`origin/main`'s only commit we lacked, PR #275, is **byte-identical to this
branch's own first three commits** — the same 13 files and the same 1,667-line
delta from the common ancestor `d0d66cfc1`. It was merged, not rebased, because
`fc8a16b28` is already published and a release does not rewrite published
history. One conflict, a leaf-count assertion in
`decision-payload-coverage.test.ts`: main carried 757, correct for main's tree;
this tree has 759 because of its own canonical bid action. The number was not
chosen — the walk counts it, and the suite was re-run to confirm.

## Release-scope defects found and fixed in Phase 1

Each was found by **running** a canonical gate, not by reading it.

1. **`generalized-pit-replay` 420 s timeout — an algorithmic defect, not
   starvation.** `analyzePitReplay` answered each of 108,556 outcome cells by
   scanning all 89,433 frozen tuples: ~9.7e9 visits, 225 s of the case's 226 s.
   Two composite-key indexes narrow the scans. No identity guard removed; each
   bucket fills in one forward pass so floating-point **addition order is
   unchanged**, which is why every frozen SHA-256 still re-derives — proven on
   the real 44 MB artifact by an identical semantic failure set before and
   after. 64 cases before, 64 after.
2. **`d080b` fifteen-attack block — a load-sensitive flake.** Each case really
   costs 11–17 s against a 15 s default. Raised to 90 s, the bound its sibling
   evidence suite already uses. The work is irreducible (each attack verifies a
   distinct mutation of a 247,050-proposal replay), so nothing was hoisted and
   no assertion changed.
3. **The automation claim-race seam failed on this branch and passed on main.**
   It sets `META_AUTOMATION_WRITE_GUARD_TEST_READS` so the **real** write guard
   runs, and this release gives Meta one write capability — so all eight racing
   approvals returned `release_capability_closed`, nothing dispatched, and the
   two provider-call assertions failed while the five that only inspect the
   claim still passed. Reproduced in isolation (guard on, capability unset),
   then fixed by having the seam declare the capability it needs, exactly as the
   duplicate-ad and activation-identity children already do. **The guard is
   untouched — it is what refused.**

## Gate results on this exact tree

| gate | result |
|---|---|
| `npm run check:workflows` | PASS |
| `npx tsc --noEmit` | 0 |
| `npx eslint .` | 0 |
| `npx vitest run` | **17,613 passed, 0 failed**, exit 0 |
| `bash scripts/verify-database-seams.sh` | **PASS — 40 stages**, exit 0 |
| `npm run check:release-owner` (seam stage 40, re-run last) | PASS |
| `npm run meta:verify-mounted-bodies` (CI extra) | PASS |
| `ZERO_BASE_UI_MODE=off npm run release:authority:preflight` (CI extra, CI's own env) | **pass**, exit 0 |
| `d077-artifact-hash-contract` | **21 passed, 0 failed** |

No test is skipped to achieve this, with one exception that was found while
preparing the PR and has been fixed rather than explained away.

The 576 `skipped` in the vitest total are seam-gated suites — the lane the
40-stage shell runs. That was true of all of them but one:
`lib/meta/bid-history-writes-journal.db.test.ts` gated five of its six cases on
`ADSECUTE_EPHEMERAL_DB_SEAM` and was registered in **no** runner, so those five
never executed anywhere. Run as the unit sweep runs it, the file reports
`Test Files 1 passed` / `Tests 1 passed | 5 skipped (6)` — green on the strength
of one static assertion. It is now registered in
`scripts/ephemeral-postgres-migrations-check.ts`, and `runChildVitest` reads the
JSON report back and refuses a child whose tests skipped or whose passing count
is short, the way `ephemeral-postgres-breakdown-dimension-seam.ts` always has.
An exit code is a floor, not evidence.

Two caveats a reviewer should have rather than discover. The vitest totals above
come from a full sweep whose log is not retained in the repository, so they are
reported, not pinned — unlike the 40-stage seam result, which is pinned by the
retained canonical log. And four other new `.db.test.ts` files boot their own
cluster by probing `/opt/homebrew`, `/usr/local/opt` and `/usr/bin`; they run
locally on macOS and skip on CI's Linux runners, which install PostgreSQL only
in the `database-seams` job — and that job runs the shell, not vitest. Those 25
cases are therefore local-only evidence today. 63 `todo` are pre-existing.

**Local tests cannot reach production, verified rather than assumed.** A probe
test printed `DATABASE_URL` as `(unset)` inside vitest: nothing loads
`.env.local` for tests, even though a live SSH tunnel to production is listening
on `127.0.0.1:15432`. Every database-backed suite boots its own throwaway
cluster.

### Ordering of the generated evidence

`verify:pre-push` was run first and stopped at vitest on the then-stale D077
manifest. The tree was then settled — sources fixed, the 40-stage shell run to
completion, and confirmed to leave the tree clean — and only then was
`d077-correction1-artifact-generator.ts phase2` run **last**, in its own order:
it refreshes the deploy packet's `expectedFinalTree` and re-hashes it, then
writes the manifest excluding its own path. No hash was hand-edited.

**The whole-shell proof was repinned to this release's own run, and the earlier
claim that it needed no new capture was wrong.** `buildWholeShellProof` compares
the ordered stage HEADINGS of a retained log against the current
`scripts/verify-database-seams.sh`; it deliberately does not bind the child
PROGRAMS those headings invoke. So "the 2026-09-03 log still carries 40 headers"
established that the script's shape was unchanged and nothing more. That log
could not speak for this candidate: it predates the claim-race seam's capability
repair, and it never executed the newly registered
`direct-launch-standing-boundary` child at all, because that registration did not
exist when it ran.

**The same reasoning then forced a second repin within the same day, and this is
the point of the rule rather than an exception to it.** The 07:59Z capture was
canonical at the Phase 1 checkpoint. Preparing the PR found two gate defects and
fixed them — `bid-history-writes-journal.db.test.ts` was registered (five of its
six cases were seam-gated while registered in no runner, so they executed
nowhere), and `runChildVitest` began reading the JSON report back to refuse a
skipped or short child. Both change what the stage EXECUTES while leaving all 40
headings byte-identical: precisely the blind spot described above. So the 07:59Z
log cannot speak for the delivered tree either, and the shell was re-run.

It happened a THIRD time, for the same reason, and that is the rule working
rather than churn: addressing the review's five findings changed
`lib/migrations.ts` and `campaign-context-job.ts`, both of which the seam's
children execute. On all three occasions the 40 headings were byte-identical, so
a header comparison alone would have accepted a log that no longer described what
ran.

A fourth repin followed the second review round, which changed the bid sizing
policy one of the seam's children exercises. The cause is identical every time,
and so is the justification: the 40 headings were byte-identical on each
occasion, so only a fresh run can bind what actually executed.

A fifth repin followed the third review round, which changed the launch-intent
producers the decision-launch-chain seam child exercises.

The sixth repin is different in kind from the first five, and the difference is
the point. Those replaced a PASSING log whose child programs had changed. This
one replaces a tree that FAILED the shell — see the round-4 section below.

The canonical stage is the 16:07Z run, retained at
`docs/audits/generated/d077-canonical-database-seams-whole-shell-2026-09-06T1607Z.log`:

| | |
|---|---|
| Start / end (UTC) | 2026-09-06T16:07:01 → 2026-09-06T16:16:35 |
| Duration | 574.0 s |
| Exit code | 0 |
| Stage headers | 40 |
| Final line | `[verify-db-seams] PASS — 40 stages` |
| Bytes | 661,176 |

The three registered seam children report their counts inside it, each with
`skipped=0`: `direct Launchpad create route approval-standing` 7/7, `Meta History
bid verb title` 2/2, and the newly registered `Meta History bid write journal
admission` 6/6 — the last being the direct evidence that five previously dormant
database assertions now actually execute.

Twelve captures are retained and none was relabelled or edited: 2026-08-30
(38-stage) and 2026-09-03 (40-stage) as the earlier releases' evidence; 2026-09-06
07:59Z (Phase 1 checkpoint), 10:30Z (PR open), 11:18Z (round 1), 11:56Z (round 2),
12:34Z (round 3), 13:17Z (round 4), 13:56Z (round 5), 14:43Z (round 6) and
15:26Z (round 7) and 16:07Z (this one, the NULL-race closure). The ten same-day
captures are superseded rather than historical.
Each is kept because it is truthful evidence of the tree it ran on — only the
label moves, never the bytes.

**One executed-source change post-dates that run, and it is named rather than
glossed.** Retaining the log inside the repository required registering it in
`scripts/check-release-owner-references.sh`, because each capture contains one
occurrence of the token that guard scans for — the guard's own announcement of
it. That registration cannot precede the log it registers, so the run could not
have included it; the entries for the 2026-08-30 and 2026-09-03 captures have
exactly the same property. The guard was therefore re-run standalone on the final
tree: `npm run check:release-owner` → `PASS — 81 historical occurrence(s)
frozen`, exit 0. Apart from that one registry entry, every change after the run
is under `docs/` or is generated evidence, which the shell neither reads nor
executes.

The manifest's own `manifestHash` and `pinnedNonSelfFileCount` are recorded in
the artifact itself and are deliberately not restated here: this document is one
of the files the manifest pins, so quoting them would make the report's own
bytes depend on a hash taken over the report. The generator excludes only its
own path, and `d077-artifact-hash-contract` checks both directions — every pin
matches disk, and nothing changed or added is missing from the pin set.

## Migration and backward compatibility

Seven statement groups, all in `lib/migrations.ts`. (An earlier draft said this
repository has no `.sql` files; `git ls-files '*.sql'` returns three —
`deploy/db/adsecute-table-fingerprint-chunk.sql`,
`docs/architecture/live-db-baseline-checks.sql` and a 2026-07-10 schema
proposal. None is a migration and none is executed by `runMigrations`, which is
the claim that actually matters.) No `DROP TABLE`, no `DROP COLUMN`, no `ALTER COLUMN TYPE`, no
`NOT NULL` added to an existing column.

1. `shopify_sync_state`: two nullable DATE columns plus an idempotent additive
   backfill.
2. `meta_ads_action_log`: action CHECK widened to include `bid` (a strict
   superset).
3. New table `meta_structure_snapshot_runs` + index.
4. `meta_launch_intents`: two JSONB columns + two `jsonb_typeof` CHECKs that
   constrain only the new all-NULL columns.
5. `meta_automation_proposals`: `launch_intent_id`, `bid_envelope_json`, widened
   `origin`/`action` CHECKs, and four new CHECKs.
6. New table `engine_v3_campaign_role_authority` + index.
7. New table `engine_v3_account_profile_output` + index.

**No table rewrite:** relfilenodes for `meta_automation_proposals`,
`meta_launch_intents`, `shopify_sync_state` and `meta_ads_action_log` are
byte-identical before and after the real migration path.

**The one reported deploy-aborting risk was measured, not argued.**
`meta_automation_proposals_bid_envelope_required` is added without `NOT VALID`,
so PostgreSQL validates every existing row. Read-only against production, in an
explicit `SET TRANSACTION READ ONLY`, every new constraint predicate was
evaluated:

```
legacy_bid_rows                 = 0
total_proposal_rows             = 18
distinct action/origin          = pause/engine_decision   (only)
violates_origin_lineage         = 0
violates_launch_lineage         = 0
violates_activation_lineage     = 0
violates_bid_envelope_required  = 0
```

`run_migrations=true` is required (the release adds three tables, six columns
and several constraints), and on today's production rows it validates cleanly.

## Rollback

The rollback target is `3f0bf857a9dde41bf2d7f461ef24b5f2ce26a651`. Its images
are not merely published — they are **present on the deploy host and currently
running**:

```
adsecute-web-1     ghcr.io/…/omniads-web:3f0bf857a9dde41bf2d7f461ef24b5f2ce26a651
adsecute-worker-1  ghcr.io/…/omniads-worker:3f0bf857a9dde41bf2d7f461ef24b5f2ce26a651
```

Older SHAs (`41311172d`, `8df9121ba`, `babf158e1`) are also present locally as
deeper fallbacks.

**An image on the host's disk does not by itself prove the supported rollback
can run, and the earlier claim that "a rollback does not depend on registry
availability" is withdrawn.** The supported rollback is a re-dispatch of
`deploy-hetzner.yml` at the previous full SHA, and that workflow contains a
mandatory, pre-host registry gate: *Verify registry access for the target images*
(`.github/workflows/deploy-hetzner.yml:247-277`) logs in to GHCR and runs
`docker manifest inspect` against both `omniads-web:<sha>` and
`omniads-worker:<sha>`; if either manifest is unreadable it exits 1 before SSH is
even prepared. That check reads the REGISTRY. It does not consult the host, so a
layer cached on the host satisfies none of it.

So the two facts are separate and only one of them is measured here:

- **Measured.** Both images for `3f0bf857a` are present on the deploy host and
  currently running, which is what makes an *unsupported* manual recovery
  physically possible on that box.
- **Not measured.** Whether the deploy token can read those manifests from GHCR
  today. This session's `gh` token lacks `read:packages`, so the registry could
  not be queried, and the gate uses `secrets.GITHUB_TOKEN` inside the workflow
  rather than this token in any case. The only faithful proof is the gate's own
  step succeeding in an actual run.

Claiming registry independence from on-disk images would also invite the manual
`docker compose` path, which this repository already records as a trap: the
wrapper sets the release tag inline and never updates `/var/www/adsecute/.env`,
so a bare `docker compose up` silently reverts production to whatever tag that
file still holds.

## Production prerequisites, re-measured read-only

Every statement ran under `default_transaction_read_only=on`; a `CREATE TABLE`
probe was rejected by PostgreSQL, so the read-only claim is proven, not stated.

- **Deployed build identity:** web and worker both run
  `…:3f0bf857a…`, matching remote main, `/api/build-info` on both hostnames, and
  `APP_IMAGE_TAG` in `/var/www/adsecute/.env`. The documented compose-revert trap
  is **not** armed.
- **Serving freshness:** Meta ingest current for 12 of 13 businesses with
  selected Meta accounts.
- **The 2026-09-03 "29 automated_missing" NO_GO is stale.** Re-measured
  2026-09-06: **16**, verdict still NO_GO. Thirteen cleared unaided. That
  preflight is multi-provider, so its verdict is not this Meta candidate's
  verdict; the rows are attributed under *Pre-existing, out-of-scope* below.
  Fresh evidence at
  `docs/audits/generated/serving-freshness-current-preflight-2026-09-06.json`;
  the runbook section that said "unchanged" is corrected.
- **Automation state recorded for later comparison.** The production DB rows —
  settings, kill switches, rehearsal flags and write authority — are unchanged
  by this candidate, and were re-read to confirm it. The GATE POSTURE is not
  unchanged, and the two must not be conflated: `lib/meta/release-gates.ts:99`
  now resolves `decisionWorkflowUi` to `automationLiveWrites`, and `:108`
  hard-codes `automationStopUi` to `true`. `META_DECISION_WORKFLOW_UI` and
  `META_AUTOMATION_STOP_UI` therefore become dead keys on deploy. The net effect
  with `META_AUTOMATION_LIVE_WRITES` unset — the shipped production state — is
  that STOP becomes visible and operable while every provider write still
  refuses with `release_capability_closed`.

## Source freeze and delivery HEAD

`32a5ae332` was the source freeze at the Phase 1 checkpoint. Preparing the PR
moved it: two gate defects and one silent-migration hazard were found and fixed,
so Meta product source DID change after that commit. Every such change is
enumerated below, and the canonical shell was re-run on the result rather than
carried over.

Three files changed after it, none of them product code, each re-run on the final
tree rather than assumed:

| Post-freeze change | What it is | Re-run on the final tree |
|---|---|---|
| `scripts/audits/d077-correction1-artifact-generator.ts` | Release-evidence generator: retargets the canonical whole-shell stage at the 2026-09-06 log | `phase1` then `phase2`, in that order, exit 0 |
| `lib/meta/__tests__/d077-artifact-hash-contract.test.ts` | The evidence contract's own pinned literals for that log | `d077-artifact-hash-contract`, 21/21 |
| `scripts/check-release-owner-references.sh` | Registry entries for the retained logs (a data table, not guard logic) | `npm run check:release-owner`, PASS, exit 0 |
| `scripts/ephemeral-postgres-migrations-check.ts` | Registers the orphaned seam test; `runChildVitest` now refuses a skipped or short child | the full 40-stage shell, re-run on this tree |
| `lib/migrations.ts`, `lib/meta/entity-action-routes.ts`, `lib/meta/history-read-model.ts`, `lib/meta/scheduled-action-execution.ts` | The action-CHECK widening no longer fails silently; three comments corrected that asserted things untrue of the build being replaced | the full 40-stage shell, plus typecheck and lint |

Everything else is under `docs/` or is generated evidence. The delivery HEAD is
reported in the delivery message rather than written here: this document is one of
the files the manifest pins, so naming the commit that contains the manifest
inside the document would be a self-hash cycle. The historical baseline
`RELEASE_BASE_SHA` / `deploy/PRODUCTION_BASELINE_SHA` identities are untouched.

## Review round on PR #276

Codex Review completed on head `cae8c886` with five findings — three P1, two P2.
All five were verified at source, all five were true, and all five are fixed.
Each fix carries a test that was mutation-checked: the fix was reverted, the test
observed failing, then restored.

| finding | fix |
|---|---|
| P1 `campaign-context-job.ts` — a withdrawn role kept authorising writes for up to 60 days, because publishing `null` wrote no row and both readers take the newest one | The unresolved day is now persisted as a sentinel kind that neither reader's allow-list contains, so the withdrawal shadows the stale row instead of being silence. The frozen readers were not touched. |
| P1 `lib/migrations.ts` — the Shopify column adds and their backfill were swallowed twice over | Both catch layers removed, exactly as the action-CHECK widening was. Landed with an upgrade-path test, which is the only path that can catch it: from-zero creates the columns in the CREATE TABLE, so the ALTERs are no-ops there. |
| P1 `automation/route.ts` — `set_business_mode` wrote four rows in a loop, so a mid-loop failure returned 500 having already armed some families | The four mode writes and their audit rows now run inside one `runDbTransaction`. |
| P2 `meta-launch-route-handlers.ts` — the durable receipt was hard-coded `kill_switch_engaged` whatever the actual refusal was | The receipt is built from the same refusal the response carries, reusing the frozen codes. |
| P2 `daily-brief.ts` — the "Applied overnight" count had only a lower bound, so it spanned 24–48 hours | Both ends now hang off one anchor, so the span is fixed by construction. |

Two of these are worth naming as classes rather than incidents: the first is
authority outliving its evidence, which is the defect this whole release exists
to remove; the fourth contradicts the invariant this release advertises, that a
refusal names the posture that refused. All five are defects in code this PR
introduces — none is a shipped production incident.

**Residuals, disclosed rather than fixed.** Making `set_business_mode` atomic
means an additive-column fallback can no longer retry inside the aborted
transaction, so on a database missing those columns the endpoint would answer 500
instead of degrading. Production is not such a database: `clean_approval_threshold`
and all five activity-ledger tuple columns were re-read and are present. The
daily-brief anchor resolves in the session time zone, so a session ahead of UTC
would under-count the tail of a UTC day; nothing sets a session time zone and the
server default is UTC.

## Review round 2 on PR #276

CI on `5081bd98b` was fully green — all eleven jobs, including the shard that had
carried the time bomb. Codex Review completed on the same head with four NEW
findings, none a re-raise of round 1.

| finding | fix |
|---|---|
| P1 `bid-sizing-policy.ts` — CPA was converted with a hard-coded `* 100` while the benchmark used `10 ** currencyExponent`, so JPY inflated CPA 100× and KWD understated it 10×, able to reverse the bid direction | The resolved exponent is threaded through from the ISO-4217 registry the contract already uses, and the policy refuses `currency_unresolvable` rather than guessing. Mutation-checked in both directions: with the old `* 100` restored, JPY flips raise→cut and KWD flips cut→raise. |
| P1 `automation-proposal-execution.ts` — the manual queue forwarded a stale amount without comparing the live cap, so a queued +10% could land as a cut | The same compare-and-set the scheduled runtime already performs, with the same refusal codes, ahead of the handler. |
| P2 `automation/route.ts` — `ensureBusinessControlRow` ran before the reviewer and demo guards, so a refused request still wrote a durable row stamped with the refused actor | Bootstrap moved below both guards. |
| P2 `daily-brief.ts` — the anomaly read omitted `endDate`, so a historical `asOf` mixed in today's alerts | `asOf` is passed as the bound, sharing the anchor the overnight-window fix introduced. |

**The re-check caught a regression in one of these fixes, which matters more than
any of the findings.** Wiring the bid compare-and-set made `readBidBaseline` a
required dependency, but the executor's only production caller did not supply it
— so every manual bid approval would have refused with
`bid_baseline_reader_unavailable`, and because `bid` was not in
`marksAtItsOwnBoundary` the row would have been stamped dispatched, settled
`failed` and consumed, leaving the operator without the proposal and without a
remedy. Strictly worse than the defect being fixed. The reader is now exported
from `budget-proposal-write-context.ts` — the one module on this path sanctioned
to import the write client — injected by the route, and `bid` marks at its own
boundary because it can refuse before any provider call.

Two follow-ups in files the fixing agents correctly refused to touch were closed
in the same batch: the identical control-row-before-guards ordering survived on
the Automation PAGE, where a reviewer merely opening it persisted a row under
their own id, so bootstrap now runs only for a `live` write authority; and
`notification-producer.ts` carried `as never` on the same anomaly read, whose
removal exposed a second unsound cast that had only type-checked because the
first one blinded the compiler.

## The activation-approval NULL race — and the regression inside its first fix

An independent reviewer found the round-7 compare-and-set still open when
`activation_approval_json` starts NULL: an approval reads NULL, a revoke wins the
lock, re-reads NULL and writes NULL — moving no version — and the older approval
then compares NULL against NULL, passes, and lands live. The transaction and the
advisory lock were correct and irrelevant; they serialize around a version that
never moved. Reproduced against the real exported POST before anything changed:
the stale approve answered **200** and left a complete approval with
`revokedAt: null` — exactly the document the scheduled runtime acts on.

Every revocation now leaves a durable, NON-AUTHORIZING document. A never-approved
intent gets a tombstone under its own contract carrying no `approvedBy`,
`approvedAt`, `expiresAt`, `approvedScope`, `approvedAssets` or
`approvedDestination` — there is no field a reader can turn into permission. A
standing approval is stamped instead, so the record of who approved what
survives. The `revokedAt` refusal was hoisted above the field checks, so a
document that declares itself revoked is refused AS revoked rather than as
malformed; that hoist can only add refusals, never remove one. And the store now
refuses to write NULL at all — it is the only SQL in the repository that writes
this column, so the erasing value is unreachable application-wide.

**The first version of this fix reopened the defect, and the adversarial
re-check caught it.** It kept a `changed: false` short-circuit: a second Revoke
against an already-withdrawn document wrote nothing, which preserved `revokedAt`
but moved no version. "Already withdrawn" is the state that exists after EVERY
revocation, so a stale approve that read it passed its compare-and-set and landed
live — measured 409 before the short-circuit existed and 200 after. A comment
asserted the fence held unconditionally, which was false of the very branch it
introduced. Both are fixed: `revokedAt` still names when authority ended,
`reaffirmedAt` moves, so the document differs and every revocation moves the
version. The `changed` flag is gone rather than left as a dormant trap.

**A second consequence, not in the finding, which this release's own earlier work
amplifies.** A tombstone makes `activation_approval_json IS NOT NULL` true, so a
revoked intent passed the unattended pre-filter — whose comment states it exists
to stop the runtime claiming rows an operator still means to approve by hand. It
would be claimed, withheld before any provider contact, settled `failed` with no
dispatch stamp, and then re-raised by the round-4 non-dispatched-failure
carve-out on the next snapshot: an indefinite flap holding a slot ahead of live
rows. Never a safety hole — the validator refuses it on every pass — but it would
silently churn away the manual offers that filter protects. The gate and the
producer's `approval_present` projection now both exclude withdrawn documents.

Traced end to end and confirmed by the re-check: a tombstone cannot reach a
provider activation. The scheduled arm validates before `runActivation`, so the
dispatch marker never fires and no POST is composed.

## Review round 7 on PR #276

CI on `535d6db1f` was fully green across all eleven jobs, the sixth consecutive
fully-green head. Codex Review completed on it with three findings — one P1, two
P2 — so the merge gate stayed shut.

| finding | fix |
|---|---|
| **P1** `activation-approval/route.ts` — an approval POST overlapping a REVOCATION had no version predicate, so a revoked document could be replaced by the older live approval and the unattended runtime could then activate real provider entities | A compare-and-set on a hash of the stored document, re-read inside the advisory lock this table already uses in `createMetaLaunchIntent`. The loser is refused `409 activation_approval_conflict`. |
| P2 `account-profile-output-producer.ts` — a partially materialized identity short-circuited forever on a `LIMIT 1` probe | The probe requires the complete action set, so a partial identity is sent back through production and completed. |
| P2 `automation/page.tsx` — a GUEST could still bootstrap a durable control row with themselves in `updated_by` | Gated on `viewer.canMutate`. |

**The revocation fix is deliberately asymmetric, and that is what closes it.**
Approval gets the compare-and-set; revocation does not. Refusing a revoke on a
version conflict would leave the racing approval LIVE — precisely the outcome the
operator pressed Revoke to prevent. So an approval can never resurrect a
revocation, and a revocation can never lose to an approval, in either arrival
order. There is exactly one SQL writer of `activation_approval_json` in the
repository, so no other writer carries the same gap.

**The bootstrap finding was the third round on that family, and the first two
fixes were wrong on the same axis.** Round 2 moved the bootstrap below the
reviewer and demo guards; round 4 moved the page's below the write-authority
resolution and gated it on `!reviewerReadOnly && writeAuthority === "live"`. Both
tested the BUSINESS's posture and the reviewer flag; neither tested the VIEWER's
authority to write, which is how a guest walked through both. It is now
`viewer.canMutate`, the axis the write routes themselves use.

Three comment claims were corrected before landing, each verified first: the page
said a read-only viewer sees `control_state_unavailable`, when a missing row is a
successful read that degrades to `business_control_not_configured` and it is the
WRITE boundary that answers the former; the producer said a partial set stayed
"permanently" treated as done, when `runMetaSnapshotForBusiness` calls the
producer unconditionally every snapshot and the next tick already healed it; and
the approval conflict's contract is "409 except when the advisory-lock wait
exceeds the statement timeout", not "409 always".

## Review round 6 on PR #276 — the two families closed

CI on `5eb543f3e` was fully green across all eleven jobs, the fifth consecutive
fully-green head. Codex Review completed on it with two findings, and both were
continuations of families this release had already touched, so both were closed
rather than incremented.

| finding | fix |
|---|---|
| **P1** `automation-proposal-execution.ts` — round 5 carried the checked STRATEGY to the write but not the AMOUNT, so a cap moved during the handler's awaits was overwritten and verified as a success | `expectedCurrentBidAmountMinor`, enforced in `beforeProviderMutation` — the same pre-POST hook `updateEntityBudget` already uses. Refusal is a definite failure with no `mutationAttempt`. BOTH callers pass it, manual and unattended. |
| P2 `daily-brief.ts` — the queue count was not bounded to `asOf`, and building the read ran expiry and stale-claim MUTATIONS | The queue reader's import is gone, so no card render can write; a past-day brief reports `unavailable` rather than a number that only looks bounded. |

**Why the amount could not be solved the way the strategy was.** The strategy
guard is a POST-WRITE read-back comparison. That is structurally unavailable for
the amount, because by read-back time the write has overwritten it. The amount
needs a genuine pre-POST comparison, and `metaFetchWriteOnce` orders kill-switch
→ `beforeMutationAttempt` → `beforeProviderMutation` → `metaFetch`, with no await
inside `metaFetch` before the request — so the new read really is the last
operation before the POST.

**What remains open on that path, stated so there is no seventh round.** The
GET→POST pair is irreducible: Meta exposes no conditional or versioned bid
mutation, so a read and a write are two requests and this is an application-level
compare-and-set, not an atomic one. A crash between them leaves the action log
`pending`, which reads as ambiguous and forbids retry — conservative and
unchanged. A rehearsal returns before any POST. And the operator's own apply-bid
deliberately proves no baseline: a cap a person types at that moment is an
instruction, not a projection of an older reading.

**Three limits of the daily brief, recorded rather than fixed.**
`meta_automation_activity_ledger` and the modes table have no
`provider_account_id` column at all, so "Applied overnight" and the modes line
are structurally business-wide on a card whose other sections are account-scoped;
neither is fixable without a schema change. Alerts are read business-wide while
the anomalies route and the intelligence server both scope theirs, so Home's
alert count can exceed the Alerts screen's for the same business — left as it is
rather than changed late in a release, but recorded as an open judgement call
rather than presented as settled.

## Review round 5 on PR #276

CI on `8971347ae` was fully green across all eleven jobs — the fourth
consecutive fully-green head. Codex Review completed on it with two findings.
Across five rounds: 5 → 4 → 3 → 2 → 2 findings, and 3 → 2 → 0 → 0 → 1 at P1.

| finding | fix |
|---|---|
| **P1** `automation-proposal-execution.ts` — the forwarded bid request carried only `bidAmountMinor`, so the handler wrote with no `expectedBidStrategy` and an ad set flipped cost-cap → bid-cap inside the handler's awaits would take the approved amount and report success under a strategy nobody approved | The checked strategy is threaded to `updateAdsetBidAmount`, matching the shape the scheduled runtime already used. Optional for the operator's own route, whose test asserts the exact input object and still passes. |
| P2 `notification-store.ts` — the event row and the recipient fan-out were not atomic, so a mid-loop failure permanently omitted that recipient and everyone after, because the next run short-circuits on the dedupe key | The event insert and the whole loop run in one `runDbTransaction`. |

**The P1 was a gap in this release's own round-2 fix.** That fix closed the
window between proposal and approval by adding a baseline compare-and-set — but
the check sits in the executor while the POST happens inside a handler the check
never reaches. Moving a check earlier without carrying its result forward is the
whole of the defect.

**And the P2 fix introduced a regression that had to be repaired with it.**
Atomicity is right, but it removed an accidental self-healing property: under the
old code a mid-loop failure still committed the event row, so the next hourly run
hit the dedupe short-circuit and carried on to every later anomaly. With no
marker left behind, a DETERMINISTIC failure would be re-attempted every run, fail
again, and abort the business's scan again — every later anomaly never produced,
for as long as the cause persisted. The producer had no per-anomaly catch (its
only three catches are elsewhere), so the failure is now contained to its own
anomaly and counted under a new `failed` tally, deliberately NOT folded into
`skipped`: skipped means "already produced", and reporting an undeliverable
notification as routine deduplication is exactly how the severity-translation
defect this producer was written to fix stayed invisible behind a reassuring
zero.

One comment corrected: binding the strategy makes the read-back prove it on a
REAL write only — `updateAdsetBidAmount` returns from its dry-run branch before
the comparison, so a rehearsal binds the field and checks nothing against it.
That costs nothing, since a rehearsal reaches no provider write to be wrong
about, but the sentence claimed otherwise.

## Review round 4 on PR #276 — and the gate catching a fix of mine

CI on `f7d7df37b` was fully green across all eleven jobs. Codex Review completed
on the same head with two findings, both P2. Across four rounds: 5 → 4 → 3 → 2
findings, and 3 → 2 → 0 → 0 at P1.

| finding | fix |
|---|---|
| P2 `activation-proposal-producer.ts` — `runClaimedProposalExecution`, and on the manual path the approve route's own settle, map PRE-PROVIDER refusals to `failed`, so treating every `failed` row as consuming permanently retired a still-paused hierarchy | The carve-out qualifies `failed` alone, on `dispatch_started_at IS NULL` — the same proof the claim sweep already uses to choose `reconcile` over `expired`. |
| P2 `daily-brief.ts` — the actionable count filtered on `decisionLabel`, which the authority guards leave in place while moving `decisionState` to `watch` | Filters on `decisionState === "act"`. The count and the top list slice the same array, so they cannot disagree. |

**Then the canonical shell rejected the first fix, and it was right to.**
`decision-launch-chain-seam FAILED [and raises its launch row]: expected 1, got 2`.
The expectation was not updated; the case was read. In it an operator un-reviews
a brief, the sweep refuses `creative_brief_not_reviewed` before touching Meta,
the row settles `failed` with `providerMutationAttempted: false`, and the intent
stays `prepared`. The two-condition carve-out brought that intent straight back —
and would bring it back on every projection afterwards, to be refused every time,
because nothing re-reviews a brief on its own. **A queue row that can only ever
fail is worse for the operator than the disappearance the carve-out set out to
fix.**

So re-offering now has to mean *the work can proceed again*, not merely *nothing
was created*. The carve-out gained a third condition: the linked brief must still
be `reviewed`. That is one leg of the standing contract rather than a rule
invented here — `verifyMetaLaunchIntentLineage` refuses with exactly that code on
exactly that predicate, and `meta_creative_briefs.status` is
`CHECK (status IN ('draft','reviewed'))`. An intent naming no brief is unaffected,
and the whole contract is still enforced at execution.

Round 3's `expired` carve-out had the same latent gap — an expired proposal for a
withdrawn brief would have been re-offered too. The standing leg closes both.

Two things this round says about the process rather than the code. The gate
caught what prose review had only gestured at: the round-4 adversarial re-check
did name this re-offer cadence as "noise", in words, and it took the seam to turn
that into a failure. And the fixing agent's own test parser failed SAFE when it
could no longer read the rewritten clause — it reported "consumes" and failed the
re-offer cases loudly rather than greenlighting the dangerous direction.

## Review round 3 on PR #276

CI on `3a43f73d0` was fully green — all eleven jobs. Codex Review completed on
the same head with three findings, all P2 and **no P1**. Across the three rounds
the trend is 5 → 4 → 3 findings and 3 → 2 → 0 at P1.

| finding | fix |
|---|---|
| P2 `launch-proposal-producer.ts` (and its activation twin) — an EXPIRED proposal removed its intent from every later snapshot, so a launch left the queue permanently | The producers now exclude an intent only for statuses that CONSUMED it. `expired` is the one terminal status the server writes with no dispatch having begun, so it alone returns. |
| P2 `daily-brief.ts` — `readLatestMetaDecisionSnapshot` ignored its own `startDate`/`endDate`, taking `MAX(snapshot_date)` across all time, so a historical `asOf` carried today's decisions | An opt-in `snapshotDateCeiling` applied inside the `latest` CTE, which is the only place a bound can work. Opt-in because the other callers pass ranges meaning the opposite. |
| P2 `daily-brief/route.ts` — with zero or several assignments, `providerAccountId: null` read as *no filter*, so business-wide rows appeared in an account-scoped section | The decision read now takes the same `providerAccountId ? … : null` guard the queue read already had. The route was already correct and is unchanged. |

The first was the one worth being careful about, because the permissive direction
is worse than the defect: wrongly readmitting a status could re-offer a launch
that already created a campaign. Every status was enumerated from the `CHECK`
constraint and justified individually — `approved`, `failed` and `reconcile` all
imply the dispatch was entered, so they stay excluded — and the predicate is a
short `NOT IN`, so a status added later defaults to excluding rather than
re-offering. The defect also proved worse than reported:
`readMetaAutomationProposalQueue` expires stale rows on every queue READ, so an
operator merely opening the queue after 24 hours was enough to retire the launch
while its intent still sat `prepared`.

Findings two and three were the third and fourth forward-leaks found in the same
brief function; the earlier two are already fixed above, and this fix reuses
their anchor rather than adding a third notion of "as of".

Two false claims in the new comments were caught by the re-check and corrected
before landing: a function named `readMetaAutomationProposals`, which does not
exist under that name, and a test comment describing a shared import where the
constant is deliberately duplicated.

## A latent time bomb CI caught, which local runs could not

`lib/meta/activation-approval-recheck.test.ts` — a file this release adds — pinned
its shared approval fixture at `expiresAt: 2026-09-06T09:00:00.000Z` and forced
`vi.useRealTimers()` in `beforeEach`. Every run before 09:00Z today passed;
every run after it fails 14 of 15 cases. CI first reported it at 11:12Z and it
reproduced locally at 11:14Z — and, decisively, on both earlier commits of this
branch, which is how it was established as latent rather than a regression from
the review fixes.

This is the honest footnote to the `17,613 passed, 0 failed` figure recorded
above: that sweep ran before 09:00Z and was true when taken. It would not be true
now, which is exactly why the figure is marked reported-not-pinned while the
40-stage seam result is pinned by a retained log. The suite's clock is now frozen
inside the approval window, so an expiry test can no longer expire.

## Scope: one detour was opened and withdrawn

A GA4 OAuth-principal repair was started during this phase and then withdrawn by
the user as out of scope — this release is Meta-only. Its four file edits and one
new test were reverted from the working tree and preserved as a recoverable patch
outside the repository; nothing was committed, and the four files are byte-
identical to `8f9f53af5`. It is recorded here so the candidate's diff is not
mistaken for having ever contained it.

## Blockers and decisions for the reviewer

1. **Tiles Workshop's Meta ingest is partly frozen — not uniformly dark.**
   Measured read-only at 2026-09-06T10:05:53Z for business
   `979a04f6-1ca9-41d8-be0a-5d58dd7c4bc7` / `act_904404985140555`, because the
   six-business serving-freshness JSON does not contain this business and cannot
   speak for it:

   | lane | latest | stale | dead letters |
   |---|---|---|---|
   | `meta_campaign_daily` | 2026-07-24 | 44 d | — |
   | `meta_adset_daily` | 2026-07-24 | 44 d | — |
   | `meta_ad_daily` | 2026-07-25 | 43 d | — |
   | `account_daily` (sync state) | 2026-07-23 | — | **45** |
   | `creative_daily` (sync state) | **2026-09-05** | current | 0 |

   Decisions follow the same split: `engine_v3_ad_decision_snapshots_daily` is
   current (`as_of_date` 2026-09-06, 21,657 rows) while
   `meta_decision_snapshots_daily` holds **0** rows for the account. So the
   structural lane is six weeks stale and the creative/native-ad lane is not.
   Write posture is fail-closed and was not touched: 0 control rows
   (`control_state_unavailable`), 0 decision-type-mode rows (effective mode
   `manual`), 0 queue rows.

   Pre-existing; this release neither causes nor repairs it, and no token was
   changed. **Decide explicitly** whether shipping with one business's structural
   lane stale is acceptable. Do not read this as thirteen healthy businesses.
2. **The runtime `release_gate` is currently BLOCKED**, so sync self-repair is
   inert in production. The *cause* is out of scope (Google Ads snapshot
   freshness on canary businesses — see below). The *consequence* is in scope and
   is why it stays on this list: deploying on top of a already-failing gate means
   the post-deploy artifact is produced against it and will not distinguish a new
   regression from this standing one. It does **not** gate `deploy-hetzner.yml` —
   verified against the workflow. Needs a named owner decision about how to read
   the post-deploy artifact, not a gate change.

## Pre-existing, out-of-scope: the non-Meta preflight findings

These were measured read-only while re-checking production. They are **not**
Meta-release prerequisites, they are **not** fixed, and they are **not** claimed
to be. They are recorded so that a general multi-provider preflight reporting
NO_GO is not misread as this candidate's verdict.

- **The multi-provider serving-freshness preflight reports NO_GO** — 29
  `automated_missing` on 2026-09-03, re-measured **16** on 2026-09-06 with the
  verdict unchanged. It spans GA4, Google Ads and Search Console as well as Meta.
  Its Meta-scoped rows are covered above; the remainder are listed here rather
  than escalated. Evidence:
  `docs/audits/generated/serving-freshness-current-preflight-2026-09-06.json`.
- **Grandmix GA4 has no refresh token.** Read at the row level on 2026-09-06: the
  `ga4` connection is `connected` at generation 11 with an access token and
  `refresh_token IS NULL`, so each operator reconnect buys roughly an hour and no
  offline refresh. An operator reconnect at 08:38 UTC restored access without
  restoring a refresh token. A candidate code-level explanation was identified in
  the property-selection write path; investigating or repairing it was withdrawn
  as out of scope and **no fix is included in this release**. Do not clear the
  symptom by writing cache rows — the documented fallback calls GA4 with the same
  dead credential.
- **Google Ads snapshot freshness on the canary businesses** is what holds the
  runtime `release_gate` BLOCKED. Diagnosis was stopped when the scope was
  corrected; no remedy is proposed and no threshold, mode or waiver is requested.

## Observations, not blockers

- **No GHCR images exist for this candidate SHA**, and cannot until it is main's
  head. That is the expected state before the merge, not an owner decision.
- `deploy/PRODUCTION_BASELINE_SHA` is `28802cff0`, an **ancestor** of the
  deployed `3f0bf857a`. The schema-upgrade seam therefore exercises a superset
  of the real upgrade path — conservative, not wrong.
- `release:authority:preflight` notes that the canonical release-authority doc
  comparison is skipped while the candidate differs from remote main, and must
  be regenerated on the exact-SHA main deploy candidate before shipping.
