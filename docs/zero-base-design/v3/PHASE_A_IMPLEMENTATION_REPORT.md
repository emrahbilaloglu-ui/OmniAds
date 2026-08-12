# Phase A Implementation Report

**Date:** 2026-08-11
**Worktree:** `/Users/harmelek/Adsecute-zero-base` · branch `codex/adsecute-zero-base-implementation`
**Result:** **Phase A is COMPLETE.** WP-00, WP-00.5, WP-01, WP-02, WP-03 and WP-03A are all committed with their named gates green. No WP-04 work was started; no push, PR, deploy, production migration, remote database, provider call or live mutation occurred.

---

## 1 · Authorities re-read

- Master plan SHA-256 `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613` — **verified**, 1,994 lines.
- `AGENTS.md` and the full CDC read order re-read, with targeted re-reads of **D065** (origin/identity/durable attempts), **D067** (append-only attempt journal, exact-state reconciliation), **D069** (unresolved duplicate outcomes remain retry-blocking).

## 2 · Baseline

| Item | Value |
|---|---|
| `origin/main` (fetched, read-only) | `23e9fc86e95298da71d4afb28567cd300c61e943` |
| Safety branch | `codex/native-ad-bounded-stop-loss-authority` @ `c46d91c2a` |
| Merge base | `848c61989eda26c83d52eb02a0710a3964d1b871` |
| Safety commits in `origin/main` | `31950b1a9` NO · `1517674c7` NO · `e41691f33` NO · `c46d91c2a` NO → merge genuinely required |
| `npm ci` | 705 packages; **`package-lock.json` unmodified** |
| Planning worktree `/Users/harmelek/Adsecute` | `c46d91c2a`, 346 dirty files — **untouched throughout** |

## 3 · Conflict resolution performed (54 hunks, 29 files)

Applied strictly under the operator's rules. Highlights:

| Rule | File | Resolution |
|---|---|---|
| 4 | `lib/meta/ads-write.ts` | Kept main's **atomic authority snapshot** (`assertProviderWriteAuthorityUnchanged` + `resolveMetaAccountAuthority`) and added `providerMutationAttempted: false` to **all 4** pre-provider/kill-switch returns. Verified main already carries the field on its other pre-provider paths (`:248`, `:2453`, `:2466`) and that `lib/creative-decision-engine/execution-safety.ts` consumes it. |
| 5 | `app/api/launchpad/meta/launch/route.ts` | Kept main's narrowed `Exclude<MetaAdsActionStatus,"pending">` typing **and** the branch's `provider_outcome_ambiguous` / `result.providerOutcome` predicate plus `isProviderOutcomeAmbiguous`. Verified 4 downstream `retryAllowed` call sites depend on it (D069) and main has **zero** ambiguity handling in this file. D067 requires `silent_failure` for ambiguous completions. |
| 6 | `lib/meta/ads-action-log.ts` (4 hunks) | Took main, which **wraps** — not replaces — the branch's D067 journal calls with product instrumentation. Verified `attempt_started` ×13 and `manual_status_mutation_target` ×4 survive, brace balance 0, and main's post-transaction block correctly excludes idempotent replays. |
| 6 | `lib/meta/manual-ad-status-reconciliation.test.ts` | add/add conflict: rebuilt with **both** suites (main's `guarded_action_reconciled` instrumentation tests + the branch's D067 settlement/provider-read tests), deduplicated imports, renamed the colliding fixture to `orchestratorCandidate`. |
| 3/7 | 6 UI files | Synthesis: main's ≥12px type floor **plus** the branch's D064 currency arguments (`formatCurrency(value, currency)`), verified the 2nd parameter exists. |
| 7 | `.github/workflows/ci.yml` | Took main's canonical `scripts/verify-database-seams.sh` after verifying it already runs **both** branch steps (`:35` migrations-from-zero, `:44` native-ad-decision seam) plus 15 more. |
| 7 | `app/api/sync/cron/route.ts` | Kept main's **global admission gate before any work** and main's fixed `readActiveBusinesses()` (its comment condemns the branch's `catch(() => [])` coercion), then spliced the branch's duplicate-ad sweep **after** the gate, and added `await duplicateAdReconciliationPromise` to both of main's early returns so the branch's "settle before every response" guarantee holds (4 awaits total). |
| — | `lib/migrations.ts` | Union kept branch's `D063_AUTHORITY_BLOCKER_CONSTRAINT_UPGRADE_SQL` and main's `product_instrumentation_events` tables; later removed a byte-identical duplicate declaration and 2 duplicate imports my union introduced. |

### Correction I made to my own resolution

My initial one-sided-union heuristic treated "branch side empty" as "main added". For three files that was **wrong** — the branch had *deleted* that code. Verified against the merge base:

| symbol | base | branch | main |
|---|---:|---:|---:|
| `payload.decision.badges` | 2 | **0** | 2 |
| `pendingPauseRec` | 4 | **0** | 4 |
| `readMeasurementSnapshotSummary` | 2 | **0** | 2 |

`app/api/creatives/briefing/route.ts` (branch −1044 lines), `components/meta/redesign/MetaPlatformPage.tsx` (−566) and `components/creatives/CreativeEngineV3EvidenceSection.tsx` (−303) were rebased onto the branch refactor with main's small additions re-applied via `git apply -3`, and the branch's deletions accepted. This removed **62 of 87** type errors. The other main-only unions were re-audited and stand (both sides grew from base there).

## 4 · Gates

| Gate | At G0 (WP-00) | Final (through WP-03A) |
|---|---|---|
| `npm run typecheck` | **PASS — 0** | **PASS — 0** |
| `npm run lint` | **PASS — 0** | **PASS — 0** |
| `npm run test` | **PASS — 7,608 passed · 0 failed · 739 files** | **PASS — 7,714 passed · 0 failed · 750 files · 4 skipped** |
| `npm run test:migrations-from-zero` | **PASS — exit 0** | **PASS — exit 0** |
| `npm run creative:v2:safety` | **PASS — exit 0** | **PASS — exit 0** |
| `npm run creative:decision:native-ad-frozen-acceptance` | **PASS — 22/22** | **PASS — 22/22** |
| `npm run zero-base:contract:verify` | — | **PASS — 23/23 checks** |
| `npm run zero-base:contracts:check` | — | **PASS — generated file current** |
| `npm run test:zero-base:contract` | — | **PASS — 17/17** |

The +106 tests between G0 and the final run are exactly the ones added by WP-02, WP-03 and WP-03A; no pre-existing test changed status.

**Required in this shell:** `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`. Without it `initdb` fails with "invalid locale settings" and every ephemeral-PostgreSQL seam reports a false `pg_ctl` failure. That was the sole cause of the earlier pg failures.

## 5 · Adjudication 4 applied (fixture only)

You were right that the guard does not read legacy `integrations`; I had that wrong. `readProviderWriteAuthority` reads `provider_connections` + `integration_credentials` + the **selected** `business_provider_accounts` binding.

In `scripts/ephemeral-postgres-duplicate-ad-reconciliation-seam-child.ts`, immediately after the provider-account seed:

1. `business_provider_accounts` now sets `is_selected = TRUE`, preserving the existing `provider_account_ref_id`/account id.
2. `provider_connections` upserted for the business with `status='connected'`, `connection_generation=1`, `RETURNING id`.
3. `integration_credentials` upserted for that `provider_connection_id` with `access_token = ACCESS_TOKEN`.

Copied from the proven pattern in `scripts/ephemeral-postgres-manual-ad-status-route-seam-child.ts:108-121`. No legacy `integrations` insert, no mock or bypass of `assertProviderWriteAuthorityUnchanged`, no loosened selection/generation/token requirement, no provider or live call — the guard is exercised for real against an ephemeral local database, and `test:migrations-from-zero` now exits 0.

## 6 · Packages completed

| WP | Commit | Evidence |
|---|---|---|
| **WP-00** | `b082885be` | 54 hunks resolved; G0 ancestry verified — `origin/main`, `31950b1a9`, `1517674c7`, `e41691f33`, `c46d91c2a` all ancestors of HEAD; all six gates green |
| **WP-00.5** | `59fd7118b` | `WP00_5_BASELINE_INVENTORY.md` — all five design-named APIs and both notification routes PRESENT at G0; workflow and instrumentation tables PRESENT; dispositions recorded as ADOPT+ADAPT / +EXTEND / +HARDEN / RETAIN-NO-UI; `/api/db-test` absent so WP-06's step is a no-op |
| **WP-01** | `b36079f65` | 15 contract/spec files vendored under `docs/zero-base-design/v3/` with a SHA-256 manifest in `SOURCE.md`; `scripts/zero-base/verify-design-contract.ts` passes 23 checks, each an independent master-plan literal rather than a value read back from the file it checks |
| **WP-02** | `29715accb` | `lib/zero-base/generated-contracts.ts` generated from the vendored JSON; three registries; 17 contract tests |
| **WP-03** | `e2c2d0885` | Shared authorizer, page resolver, workspace scope/switch/return, rollout foundation; 91 new tests including full `requireBusinessAccess` parity |
| **WP-03A** | `9a98dc176` | Report-share fail-closed branch, default off; both branches proven locally |

### WP-01 — residuals recorded, not laundered

The design package's own audit says **NOT READY**: REQ-27, REQ-28 (mutation `M11` undetected) and REQ-41 fail, and `ACCEPTED_RESIDUALS.md` records all three with their root cause. The verifier asserts `audit.verdict === "NOT READY"` and fails if that ever silently flips, so no application signal can present the package as ready. The archive SHA-256 (`0695ae45…`) and the active-manifest fingerprint (`f27bf51b…`) are distinct values and are labelled distinctly everywhere.

One correction to the earlier plan reading: **`spec/matrices.js` does not exist.** `MATRICES` is exported from `flows.js`, so the vendored spec set is 5 files, not 6.

### WP-02 — the gates were proven to fail, not assumed to work

The test is not self-referential. Every set is compared against the vendored JSON read fresh from disk, and that JSON must first hash to the digest recorded independently in `SOURCE.md`; the scalar counts are master-plan literals. Both failure modes were exercised:

| Tamper | Result |
|---|---|
| Rename one leaf ID in the generated file | `zero-base:contracts:check` reports stale · 3 contract tests fail |
| Flip `audit.json` from `NOT READY` to `READY` | hash-drift guard fires · verdict assertion fails · verifier exits 1 |

Reconciliation holds in code: 67 legacy records = 20 alias + 47 changed over **46** unique changed paths, because `/settings` is the only old path that splits (`L-ME-ACCOUNT` and `L-C-M-BIZ`). 66 mapped + 9 retired + 1 dev-excluded = 76 legacy pages. 11 `new-surface` leaves, 10 with no legacy record, `L-ME-ACCOUNT` the eleventh. The single range alias `gated:META-WF-02..08 menu` expands to exactly 7 workflow capabilities and any other `..` token is rejected.

### WP-03 — one authority, unchanged contract

`evaluateBusinessAuthorization` is pure, so schema-unavailable is now distinguishable from no-membership for diagnostics while both still return byte-identical responses. `requireBusinessAccess` keeps its signature, status codes and message strings; the parity test pins all seven denial branches and asserts **no membership read** happens for a caller who has not proven identity. Membership reads moved to `lib/access-membership.ts` purely to avoid an import cycle — `lib/access.ts` re-exports them, so no caller changed, and the pre-existing migration guard in `lib/access.test.ts` still passes untouched.

Rollout grants nothing: nothing reads `NEXT_PUBLIC_*`, and a test asserts the config exposes no value that could be mistaken for an authorization decision. API access is not gated on rollout or plan.

### WP-03A — built and tested, never enabled

`ZERO_BASE_REPORT_SHARE_FAIL_CLOSED` defaults to **false** and is set in no environment file; it exists only in code and in tests that set it per-case and restore it. Flag-off behaviour is unchanged. Flag-on refuses before anything is read: the mint endpoint performs no report lookup, render, snapshot write or instrumentation event, and returns an identical body for an existing and a non-existent report. The public page's guard runs **before the token promise is awaited** — resolving the token and discarding it would still leave a timing oracle — and a test asserts the promise is never awaited and that two different tokens produce identical markup. No stored snapshot is read, written or deleted in either branch.

**Operator boundary observed:** deploying flag-on requires written authority and a decision on already-issued tokens, recorded in Appendix C. That authority does not exist, so the flag was never enabled outside per-test environment variables.

## 8 · State and rollback

- Branch `codex/adsecute-zero-base-implementation`. The last implementation commit is WP-03A `9a98dc176`, 12 commits ahead of `origin/main` (4 safety commits brought in by the WP-00 merge, plus WP-00, WP-00.5, WP-01, WP-02, WP-03, WP-03A and their documentation commits). Documentation-only commits follow it, so the count quoted here is anchored to that commit rather than to HEAD — a commit cannot state its own descendant count. Worktree clean.
- `package-lock.json` unmodified. No push, PR, deploy, production migration, remote or production database, provider call, campaign mutation, or live-state change. Only ephemeral local PostgreSQL clusters, all removed. No `.env` file was read into the repo, created or committed, and no secret was printed.
- `/Users/harmelek/Adsecute` untouched at `c46d91c2a` with 346 dirty files.

**Rollback (non-destructive).** This branch is isolated, so prefer reverts or removal over history rewriting:

- Undo a single package: `git revert --no-edit <commit>` (use `git revert -m 1 b082885be` for the WP-00 merge).
- Discard the whole attempt: `git worktree remove /Users/harmelek/Adsecute-zero-base` then `git branch -D codex/adsecute-zero-base-implementation`.
- `WP00_MERGE_RESOLUTION.patch` replays the merge resolution if the branch is rebuilt.

Do not use `git reset --hard`; it discards committed evidence this ledger references.

## 9 · Next allowed package

**WP-04** — scoped Ledger tokens, fonts and no-flash theme. It was explicitly out of scope for this phase and was not started. It needs vendored `.woff2` files plus their verified license files, which are not in this repository, so it requires its own authorization.

Two things carry forward into it:

1. The design package is still **NOT READY**. Re-vendoring after the design owner ships an export regenerated at a single fingerprint with 23/23 mutations detected would clear REQ-27, REQ-28 and REQ-41.
2. `lib/access/require-business-page-context.ts` and the workspace modules are deliberately **unused** until the canonical shell lands in WP-06. That is the intended rollback position: nothing renders differently today.
