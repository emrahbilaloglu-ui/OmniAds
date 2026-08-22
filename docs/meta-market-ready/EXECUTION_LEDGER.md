# Meta market-ready plan — execution ledger

Plan: `docs/meta-market-ready-master-plan-2026-08-22.md`
Branch: `meta-market-ready`, from `main` at `843b6e9c8`
Date: 2026-08-22

Fifteen commits, one per work package or package pair, each independently
revertible. 132 files, +11 689 / −243.

## Status by work package

| WP | Commit | State |
|---|---|---|
| WP0 Baseline & authority | `3bf9cd460` | **DONE** |
| WP1 Safe interim posture | `ce05ed234` | **DONE** |
| WP2 Surface registry & nav | `a910e5f18` | **DONE** |
| WP3 Integrations & assignment | `299171a11` | **DONE** (static); runtime UNKNOWN |
| WP4 Shell & account authority | `c0494883e` | **DONE** except cache-key sweep (item 8, deferred to WP9–WP10) |
| WP5 Window, as-of, freshness | `0cc68d71a` | **PARTIAL** — items 6, 7, 9 open |
| WP6 Response/state contract | `fd547684c` | **PARTIAL** — envelope defined, no surface migrated; items 9–10 need DB |
| WP7 Mutation safety foundation | `02dd3eeab` | **DONE** as a contract; sandbox matrix not run |
| WP8 Decisions | `fed624904` | **PARTIAL** — workflow ported and gated; 4 presentation claims unaudited; label writer open |
| WP9 Account Intelligence | `34962c918` | **PARTIAL** — 8 of 9 sections |
| WP10/WP11 Studio, Shares, Briefs | `3f1e635ca` | **PARTIAL** — 3 contract mismatches fixed; 5-tab matrix unverified |
| WP12 History | `45cce8855` | **PARTIAL** — actor and before-state fixed; 4 presentation claims unaudited |
| WP13/WP14 Automation & Launchpad reads | `43c129e30` | **PARTIAL** — pixel-retention fixed; several items open, Stop UI deliberately absent |
| WP15 Launchpad execution | `825ac2197` (doc) | **BLOCKED** — preconditions unmet; 7 of 18 safety steps missing |
| WP16/WP17 Gates & telemetry | `db0a50d35` | **PARTIAL** — reachability gate and `screen_view`; harness retarget and measurements open |
| WP18 Release | `825ac2197` (doc) | **BLOCKED** — needs explicit approval |

## Defects found and fixed

Each was a surface stating something the system did not support.

| # | Defect | WP |
|---|---|---|
| 1 | ADR-D070 cited as authority while marked `Proposed` | WP0 |
| 2 | `reference-contract.ts` pinned a superseded design digest | WP0 |
| 3 | Launchpad could create real Meta entities with no gate | WP1 |
| 4 | Automation claimed the kill switch stopped **every provider**; it is Meta-only | WP1 |
| 5 | `dryRunOnly` — the guardrail deciding whether anything reaches Meta — was not shown | WP1 |
| 6 | A dry-run approval rendered identically to one that changed something | WP1 |
| 7 | Every Automation read failure collapsed into one message | WP1 |
| 8 | `/c/:id/meta/history` resolved to no screen, so the rail said **Decisions** | WP2 |
| 9 | `/c/:id/meta/intelligence` lit up nothing | WP2 |
| 10 | `/platforms/meta/decisions` — a phantom path that translated cleanly and 404'd | WP2 |
| 11 | An `/app` href from `/c/:businessId` re-scoped to a **different business** | WP2 |
| 12 | Demo assignment answered `selectionSaved: true` having written nothing | WP3 |
| 13 | A 202 (saved, not scheduled) read as a clean success | WP3 |
| 14 | Assignment returned the caller's own draft ids as the result on failure | WP3 |
| 15 | A failed account-list read rendered as "no accounts found" | WP3 |
| 16 | `null` account meant **all accounts** in the shell envelope | WP4 |
| 17 | `act_123` and `123` did not match, so an assigned account resolved to null | WP4 |
| 18 | `zeroBaseEnabled: true` was a literal — the rollback flag was a constant | WP4 |
| 19 | Opening any legacy interior page **wiped the workspace switcher** | WP4 |
| 20 | The date picker looked active on control-state screens it never scoped | WP5 |
| 21 | Launchpad's creative table headed a 30-day read "28d metrics" | WP5 |
| 22 | The Meta Stop did not stop a Launchpad create | WP7 |
| 23 | The decision workflow's only caller was in a body no route mounts | WP8 |
| 24 | Account Intelligence printed raw `Error.message`, including Graph URLs carrying tokens | WP9 |
| 25 | The Shares ledger read `data.shares`; the API sends `grants` — permanently empty | WP10/11 |
| 26 | An unreadable share ledger rendered as "no shares" | WP10/11 |
| 27 | The Shares create form could never succeed (server requires ≥1 creative) | WP10/11 |
| 28 | Every brief reported "does not record the creative it was derived from" | WP10/11 |
| 29 | Every History workflow event was attributed to the engine | WP12 |
| 30 | A failed pixel read wiped the operator's chosen pixel from every ad set | WP13/14 |
| 31 | `screen_view` was absent from the runtime vocabulary — unemittable | WP16/17 |

## Gates, at the end

| Gate | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npx eslint .` | **PASS** |
| `npx vitest run` | **PASS** — 12 600 passed, 144 skipped, 63 todo, **0 failed** (baseline 12 389) |
| `npm run test:migrations-from-zero` | **PASS** |
| `npm run test:schema-upgrade-seam` | **PASS** |
| `npm run zero-base:contract:verify` | **PASS** — verdict honestly `NOT READY` |
| `npm run zero-base:contracts:check` | **PASS** |
| `npm run test:zero-base:routes` | **PASS** |
| `npm run test:zero-base:compatibility` | **PASS** |
| `npm run check:workflows` | **PASS** |
| `npm run meta:verify-mounted-bodies` | **PASS** — 15/15 |

## Evidence class of the whole body of work

**VERIFIED-STATIC**, plus **VERIFIED-RUNTIME for the schema** (both migration
gates ran against a real ephemeral Postgres).

There is **no VERIFIED-RUNTIME evidence for any surface** and **no
VERIFIED-PROVIDER evidence at all**. No authenticated session, no production
database, no Meta API call, no deploy.

Under the plan's §19, **no surface is market-ready**, and §14 says so directly:
green tests are not readiness. What this branch delivers is the work that had to
come first — and 31 defects that would each have reached an operator.

## The next session's first three moves

1. Merge this branch, then run the harness retarget (WP16 items 1–3). It is the
   largest remaining piece and everything visual depends on it.
2. Get a Meta sandbox account, then close WP15's seven steps against it —
   read-back first. `openGatesWithMissingSteps` will tell you when you are done.
3. Ask for approval for WP18 steps 3–6, which are read-only and unblock the
   runtime evidence every surface report is currently missing.
