# Zero-Base Execution Ledger (working copy of master-plan Appendix C)

Source of truth for the template: `ADSECUTE_ZERO_BASE_APPLICATION_IMPLEMENTATION_MASTER_PLAN_2026-08-10.md` (SHA-256 `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613`). That file is immutable; this is the working ledger.

## Baseline record (WP-00 attempt, 2026-08-11)

| Field | Value |
|---|---|
| Design ZIP SHA-256 | `0695ae452469ba3efe2615efe3ffd30fcdb88f5847db53d569042fb864c09b9d` |
| Master plan SHA-256 | `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613` (verified) |
| `origin/main` | `23e9fc86e95298da71d4afb28567cd300c61e943` |
| Integration branch | `codex/adsecute-zero-base-implementation` |
| Worktree HEAD | `23e9fc86e` (clean) |
| Safety branch | `codex/native-ad-bounded-stop-loss-authority` @ `c46d91c2a` |
| Safety commits in `origin/main` | `31950b1a9` NO · `1517674c7` NO · `e41691f33` NO · `c46d91c2a` NO |
| Node / npm | **node v24.4.1 · npm 11.4.2** (`npm ci`, 705 packages; `package-lock.json` unmodified) |
| Post-G0 HEAD | `7d8bd86c1` · 7 commits ahead of `origin/main` (4 safety commits brought in by the merge + WP-00, WP-00.5, docs) |
| Locale required for PostgreSQL gates | `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` |

## Ledger

| WP | Status | Commit | Files/PR | Tests | Visual/AT evidence | Rollback verified | Exceptions |
|---|---|---|---|---|---|---|---|
| 00 | **complete** | `b082885be` | 54 hunks / 29 files | typecheck 0 · lint 0 · vitest 7608/0 · migrations-from-zero PASS · creative:v2:safety PASS · frozen 22/22 | — | `git revert -m 1 b082885be` | G0 ancestry verified for origin/main + all four safety commits |
| 00.5 | **complete** | `59fd7118b` | WP00_5_BASELINE_INVENTORY.md | read-only inventory at G0 | — | revert doc commit | all 5 APIs + notifications PRESENT; workflow/instrumentation tables PRESENT; /api/db-test absent |
| 01 | **complete** | `b36079f65` | 15 vendored contract/spec files + `SOURCE.md`, `ACCEPTED_RESIDUALS.md`, `scripts/zero-base/verify-design-contract.ts` | `zero-base:contract:verify` 23/23 checks PASS · typecheck 0 · lint 0 | — | `git revert b36079f65` | design package remains **NOT READY**: REQ-27, REQ-28 (`M11`), REQ-41 recorded as accepted residuals, never laundered green |
| 02 | **complete** | `29715accb` | `scripts/zero-base/{generate,verify}-contracts.ts`, `lib/zero-base/{generated-contracts,route-registry,control-registry,report-source-registry,contract}.ts` | `test:zero-base:contract` 17/17 · `zero-base:contracts:check` current · typecheck 0 · lint 0 | — | `git revert 29715accb` | gates proven fail-closed by tamper test: leaf-id edit → check stale + 3 test failures; `audit.json` `NOT READY`→`READY` → hash-drift + verdict failure |
| 03 | **complete** | `e2c2d0885` | `lib/access/{authorize-business,require-business-page-context}.ts`, `lib/access-membership.ts`, `lib/workspace/{workspace-context,switch-destination,agency-return}.ts`, `lib/zero-base/rollout.ts`, `lib/access.ts`, `lib/business-context.ts` + 7 test files | 91 new tests · full suite 7699/0 · typecheck 0 · lint 0 | — | `git revert e2c2d0885` | page helper and workspace modules intentionally unused until WP-06; no API gated on rollout or plan |
| 03A | **complete** | `9a98dc176` | `lib/reports/share-fail-closed.ts`, `app/api/reports/[reportId]/share/route.ts`, `app/share/report/[token]/page.tsx` + 2 test files | 15 tests across both flag branches · full suite 7714/0 · migrations-from-zero PASS · creative:v2:safety PASS · frozen 22/22 | — | set/leave `ZERO_BASE_REPORT_SHARE_FAIL_CLOSED=false`; no data rollback | **flag defaults false and is set in no environment file.** Deploying flag-on needs written operator authority plus a decision on already-issued tokens; that authority does not exist, so flag-on was never enabled outside per-test env vars |
| 04 | not started | — | — | — | — | — | outside Phase A; needs vendored `.woff2` + license files not present in this repo |
| 05 | not started | — | — | — | — | — | outside Phase A |
| 06 | not started | — | — | — | — | — | outside Phase A |
| 07 | not started | — | — | — | — | — | outside Phase A |
| 08 | not started | — | — | — | — | — | outside Phase A |
| 09 | not started | — | — | — | — | — | outside Phase A |
| 10 | not started | — | — | — | — | — | outside Phase A |
| 11 | not started | — | — | — | — | — | outside Phase A |
| 12 | not started | — | — | — | — | — | outside Phase A |
| 13 | not started | — | — | — | — | — | outside Phase A |
| 14 | not started | — | — | — | — | — | outside Phase A |
| 15 | not started | — | — | — | — | — | outside Phase A |
| 16 | not started | — | — | — | — | — | outside Phase A |
| 17 | not started | — | — | — | — | — | outside Phase A |
| 18 | not started | — | — | — | — | — | outside Phase A |
| 19 | not started | — | — | — | — | — | outside Phase A |
| 20 | not started | — | — | — | — | — | outside Phase A |
| 21 | not started | — | — | — | — | — | outside Phase A |
| 22 | not started | — | — | — | — | — | outside Phase A |
| 23 | not started | — | — | — | — | — | outside Phase A |
| 24 | not started | — | — | — | — | — | outside Phase A |
| 25 | not started | — | — | — | — | — | outside Phase A |
| 26 | not started | — | — | — | — | — | outside Phase A |
| 27A | not started | — | — | — | — | — | outside Phase A |
| 27B | awaiting separate authority | — | — | — | — | — | deployment gated |

## Notes

- WP-00 (`b082885be`), WP-00.5 (`59fd7118b`), WP-01 (`b36079f65`), WP-02 (`29715accb`), WP-03 (`e2c2d0885`) and WP-03A are committed; see the rows above for evidence. No dependency, provider, deployment or production state changed; `package-lock.json` is unmodified.
- WP-02's test is not self-referential. Every set is compared against the vendored JSON read fresh from disk, and that JSON must first hash to the digest recorded independently in `SOURCE.md` at vendor time; the scalar counts are master-plan literals. Both failure modes were exercised, not assumed.
- Reconciliation proven in code, not asserted in prose: 67 legacy records = 20 alias + 47 changed over 46 unique changed paths, because `/settings` is the only old path that splits (into `L-ME-ACCOUNT` and `L-C-M-BIZ`). 66 mapped + 9 retired + 1 dev-excluded = 76 legacy pages. 11 `new-surface` leaves, 10 of which have no legacy record — `L-ME-ACCOUNT` is the eleventh. The single range alias `gated:META-WF-02..08 menu` expands to exactly 7 workflow capabilities and any other `..` token is rejected.
- The planning worktree `/Users/harmelek/Adsecute` (`c46d91c2a`, 346 dirty files) was read only and remains untouched.
- WP-03 changed no observable API behaviour. `requireBusinessAccess` keeps its signature, status codes and message strings; a parity test pins all seven denial branches and asserts no membership read occurs for a caller who has not proven identity. The pre-existing migration guard in `lib/access.test.ts` passes untouched.
- WP-03A is **built and tested but never enabled.** `ZERO_BASE_REPORT_SHARE_FAIL_CLOSED` defaults to false, appears in no environment file, and is set only per-test with a restore. Flag-on reads nothing: the mint endpoint returns an identical body for existing and non-existent reports, and the public page's guard runs before the token promise is awaited, so no timing difference distinguishes a live token from a fabricated one. No stored snapshot is read, written or deleted in either branch.
- Appendix C authority for a deployed flag-on state: **absent.** Not requested and not required for local implementation.
- Full stop evidence: `PHASE_A_IMPLEMENTATION_REPORT.md` in this directory.
