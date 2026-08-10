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
| 03 | not started | — | — | — | — | — | G0 now clean; not reached this session |
| 03A | not started | — | — | — | — | — | depends on G0; `ZERO_BASE_REPORT_SHARE_FAIL_CLOSED` not introduced |
| 04 | not started | — | — | — | — | — | outside Phase A |
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

- WP-00 (`b082885be`), WP-00.5 (`59fd7118b`), WP-01 (`b36079f65`) and WP-02 are committed; see the rows above for evidence. No dependency, provider, deployment or production state changed; `package-lock.json` is unmodified.
- WP-02's test is not self-referential. Every set is compared against the vendored JSON read fresh from disk, and that JSON must first hash to the digest recorded independently in `SOURCE.md` at vendor time; the scalar counts are master-plan literals. Both failure modes were exercised, not assumed.
- Reconciliation proven in code, not asserted in prose: 67 legacy records = 20 alias + 47 changed over 46 unique changed paths, because `/settings` is the only old path that splits (into `L-ME-ACCOUNT` and `L-C-M-BIZ`). 66 mapped + 9 retired + 1 dev-excluded = 76 legacy pages. 11 `new-surface` leaves, 10 of which have no legacy record — `L-ME-ACCOUNT` is the eleventh. The single range alias `gated:META-WF-02..08 menu` expands to exactly 7 workflow capabilities and any other `..` token is rejected.
- The planning worktree `/Users/harmelek/Adsecute` (`c46d91c2a`, 346 dirty files) was read only and remains untouched.
- Full stop evidence: `PHASE_A_IMPLEMENTATION_REPORT.md` in this directory.
