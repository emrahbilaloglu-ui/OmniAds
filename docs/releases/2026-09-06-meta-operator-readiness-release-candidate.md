# Meta operator readiness — release candidate, Phase 1

Local verification only. **Nothing has been pushed, no PR exists, nothing is
merged or deployed.** This document is the checkpoint a reviewer reads before
the first push is authorised.

| | |
|---|---|
| candidate SHA | `fb4b8a3b4c81aef68c212d89a34d984deacd21a2` |
| branch | `codex/meta-v2-panel-fidelity` (published tip `fc8a16b28`; nothing already published was rewritten) |
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

No test is skipped to achieve this. The 576 `skipped` in the vitest total are
`describe.runIf(ADSECUTE_EPHEMERAL_DB_SEAM)` suites, which is the lane the
40-stage seam shell runs — and it passed. 63 `todo` are pre-existing.

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
writes the manifest excluding its own path. No hash was hand-edited. The
whole-shell proof needed no new capture: the script still declares 40 stages and
the retained 2026-09-03 log still carries 40 headers.

The manifest's own `manifestHash` and `pinnedNonSelfFileCount` are recorded in
the artifact itself and are deliberately not restated here: this document is one
of the files the manifest pins, so quoting them would make the report's own
bytes depend on a hash taken over the report. The generator excludes only its
own path, and `d077-artifact-hash-contract` checks both directions — every pin
matches disk, and nothing changed or added is missing from the pin set.

## Migration and backward compatibility

Seven statement groups, all in `lib/migrations.ts` (this repository has no
`.sql` files). No `DROP TABLE`, no `DROP COLUMN`, no `ALTER COLUMN TYPE`, no
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
deeper fallbacks. A rollback therefore does not depend on registry availability.
GHCR could not be queried directly: this session's `gh` token lacks
`read:packages`.

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
  2026-09-06: **16**, verdict still NO_GO. Thirteen cleared unaided. Fresh
  evidence at
  `docs/audits/generated/serving-freshness-current-preflight-2026-09-06.json`;
  the runbook section that said "unchanged" is corrected.
- **Automation state recorded for later comparison** — settings, kill switches,
  rehearsal flags and write authority are unchanged by this candidate.

## Blockers and decisions for the reviewer

1. **Grandmix GA4 — 16 `automated_missing`, verdict NO_GO.** Root cause read at
   the row level: Grandmix's `ga4` credential has `refresh_token = NULL` with
   its access token expired 2026-09-04 16:58:14, so every ten-minute tick
   returns `skipped`. **Remedy:** an operator re-runs the GA4 OAuth connect in
   the application. It needs no automation enablement and no advertising
   account; it is interactive, so it was reported, not performed. Do **not**
   clear it by writing cache rows — the documented fallback calls GA4 with the
   same dead credential.
2. **Tiles Workshop's Meta ingest has been dead since 2026-07-25** — 45
   dead-letter partitions, Facebook-side token invalidation, Decision Center
   serving six-week-old data. Pre-existing; this release neither causes nor
   repairs it. **Decide explicitly** whether shipping with one of thirteen
   businesses dark is acceptable.
3. **The runtime `release_gate` is currently BLOCKED** (Google Ads snapshot
   freshness on canary businesses), so sync self-repair is inert in production.
   It does **not** gate `deploy-hetzner.yml` — verified — but deploying on top of
   it means the post-deploy artifact is produced against an already-failing gate
   and will not distinguish a new regression from this standing one. Needs a
   named owner decision.
4. **No GHCR images exist for this candidate SHA**, and cannot until it is main's
   head. Expected, recorded so it is not mistaken for a defect.

## Observations, not blockers

- `deploy/PRODUCTION_BASELINE_SHA` is `28802cff0`, an **ancestor** of the
  deployed `3f0bf857a`. The schema-upgrade seam therefore exercises a superset
  of the real upgrade path — conservative, not wrong.
- `release:authority:preflight` notes that the canonical release-authority doc
  comparison is skipped while the candidate differs from remote main, and must
  be regenerated on the exact-SHA main deploy candidate before shipping.
