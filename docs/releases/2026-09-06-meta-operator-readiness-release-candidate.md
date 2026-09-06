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

The canonical stage is the 10:30Z run, retained at
`docs/audits/generated/d077-canonical-database-seams-whole-shell-2026-09-06T1030Z.log`:

| | |
|---|---|
| Start / end (UTC) | 2026-09-06T10:30:54 → 2026-09-06T10:39:15 |
| Duration | 501.0 s |
| Exit code | 0 |
| Stage headers | 40 |
| Final line | `[verify-db-seams] PASS — 40 stages` |
| Bytes | 661,048 |

The three registered seam children report their counts inside it, each with
`skipped=0`: `direct Launchpad create route approval-standing` 7/7, `Meta History
bid verb title` 2/2, and the newly registered `Meta History bid write journal
admission` 6/6 — the last being the direct evidence that five previously dormant
database assertions now actually execute.

Four captures are retained in total and none was relabelled or edited: 2026-08-30
(38-stage) and 2026-09-03 (40-stage) as the earlier releases' evidence, 2026-09-06
07:59Z as the Phase 1 checkpoint's — superseded, not historical — and this one.

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
