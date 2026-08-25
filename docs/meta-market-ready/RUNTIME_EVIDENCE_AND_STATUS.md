# Meta market-ready — runtime evidence and corrected status

Branch: `meta-market-ready`
HEAD: `e643f68a89e93fb5aab94936aa37cdfae7fb0890`
Date: 2026-08-25
Supersedes the previous revision of this file (written at `7a3d00a19`) and the
status table in `EXECUTION_LEDGER.md`.

---

## 1. What changed in this pass

Twelve commits on top of `6e807d54e`: 328 files, +9 627 / −302. 186 of those
files are captured evidence (frame screenshots with per-file SHA-256 and a
render fingerprint); 142 are source and tests.

| Commit | Work package | Subject |
|---|---|---|
| `caed5f0f8` | WP6 | The §9 read state, decided on the server and adopted by every Meta body |
| `743ff35fd` | WP11 / WP13 / WP4 / WP8 | Wire every release gate to a server that enforces it |
| `744034d41` | WP11 / WP13 / WP8 / WP4 | The gates, proven on two running servers — and the fixture that was lying |
| `d2342e5ca` | WP2 | Every spelling of a surface, asked of the server |
| `0306e4d79` | WP5 | The URL, the request and the caption, proven to name one window |
| `6c61c03f9` | WP10 / WP12 / WP14 | The Studio's five tabs, History's nine families, Launchpad's whole draft |
| `2064ba3ea` | WP9 / WP3 | Eleven sections that answer for themselves, and a connection that admits it is broken |
| `2a0a4f4bf` | — | Finish the locale gate: 70 hardcoded strings, classified and migrated |
| `398bd4e27` | WP16 | The reference gate was looking in the one place the repo forbids |
| `f7c835f2a` | WP16 | Recapture the 92 frames from the code that now exists |
| `07babe405` | WP16 | The three dead bodies now live where their status is legible |
| `a59a8df09` | WP17 | Audit the telemetry contract, and correct two claims about it |

Twelve runtime spec files now drive the mounted routes; eight are new in this
pass: `meta-runtime-release-gates`, `-surface-identity`, `-window`, `-studio`,
`-history`, `-launchpad`, `-intelligence`, `-integrations`, plus
`-screenshots`. A thirteenth commit (`e643f68a8`) adds the saved responsive
matrix, and this document is the fourteenth.

---

## 2. The harness this evidence comes from

`npm run meta:runtime-evidence` boots a throwaway PostgreSQL 16 cluster (never
15432, the production tunnel; never 5432, the local volume), runs the repo's
real deploy migrations against it, seeds the D6 fixture, and serves the
**production standalone build** — with `DATABASE_URL` force-set so a
`.env.local` pointing at production cannot win.

**Two servers, one database.** New in this pass. A release gate has two halves —
the refusal and the capability — and one process can only ever show one of them.
The harness now runs two standalone builds against the same cluster and the same
fixture, differing only in release-gate environment, and each case asks both the
same question. The difference between the two answers *is* the gate.

Four gates are opened on the second server: the Meta Stop, the decision
workflow, the share mint and the account picker. Every one acts on our own
database and contacts no provider. `META_LAUNCHPAD_EXECUTION` and
`META_AUTOMATION_LIVE_WRITES` are opened **nowhere** — their next step is a call
to Meta, and no local evidence may be produced by making one.

### Three fixture defects the two-server run exposed

1. **The "many accounts" business had one account.** `ACCOUNT_MANY_B` was seeded
   `is_selected = false`, and every reader of an assignment filters on it — so
   every N-account assertion in this harness had been measuring the 1-account
   posture under an N-account name. No surface had ever reached
   `account_required`; no picker had ever had a second option to offer. It now
   has two assigned plus a third that is discovered and never assigned, and
   `seed.ts` asserts its own 0/1/N shape.
2. **The journal sat on a day boundary.** Rows written at `now() - 3 hours`
   against a window that ends *yesterday* meant History said `success` in the
   evening and `empty-proven` after midnight. Moved three days back.
3. **Per-test sign-in tripped the login throttle**, and a 429 mid-sweep reads as
   a gate failure. The project's existing storage state is used instead.

---

## 3. Corrected status by work package

A package is DONE only when every acceptance item has the evidence class it asks
for. Nothing is DONE on a passing unit test alone.

| WP | Status | What holds | What is missing |
|---|---|---|---|
| **WP0** Baseline & authority | **DONE** | Exact HEAD and source hash; ADRs Accepted; `zero-base:contract:verify` reports the package's own verdict honestly as NOT READY; the untracked Share work is untouched | — |
| **WP1** Interim posture | **PARTIAL** | No provider write; Launchpad validate answers and execution is refused on the running server; Automation states the Meta-only scope of its stop | Manual assistive-technology confirmation that each disabled reason is announced. axe passes; axe is a scanner |
| **WP2** Surface registry & nav | **DONE** | 38 runtime checks: every canonical route, every `/app` twin, every `/platforms` legacy spelling. Each resolves, lights exactly one rail row — its own, its hub's, or its workspace row — and keeps the Meta product row lit inside Meta. Twins compared on body identity, not page text | — |
| **WP3** Integrations & assignment | **PARTIAL** | A connection recorded as refused reads "Action required" AND stops claiming freshness; §7.2 duplicate spellings resolve to the catalog's form while a foreign id stays refused; a missing discovery snapshot does not erase a valid assignment. Reconnect race and snapshot-revision refusals covered by `provider-account-assignments-race.test.ts` | A genuinely revoked Meta credential needs Meta to refuse one. For Meta the stored `token_expires_at` is deliberately not expiry — confirmed on the running server that moving it changes nothing, which is correct. Production read-only schema evidence |
| **WP4** Shell & account authority | **PARTIAL** | Role matrix 312/312; `account_required` is exited by a real selection on the gates-open server; the picker is locked with a named reason when the gate is shut; an open gate grants no authorization — other tenant, unassigned account and zero-account business all still refused | The rollout lever, see §8. The full 0/1/N × surface × role cross-product is covered for the Studio tabs and the six hubs, not for every leaf |
| **WP5** Window, as-of, freshness | **DONE** | URL → request → caption asserted as one equality for 7d and 28d; a custom window honoured verbatim; a backwards pair ignored rather than repaired; the transition driven through the real control — open, choose, **Apply** — with URL, caption and the next request moving together; a business with no timezone neither fabricates one nor loses its picker | — |
| **WP6** Response/state contract | **PARTIAL** | One server-owned resolver; all seven §9 states proven at runtime, including two DB-level fault injections and a genuinely held in-flight request; every Meta hub, all four Studio tabs and both sub-surfaces emit a read state | Query-plan, capacity, retention and 30–90 day growth evidence needs production read-only access |
| **WP7** Mutation safety foundation | **BLOCKED** | The contract is declared and `launchpad_create` conforms 18/18 | The twelve-case guarded sandbox matrix. Needs a Meta sandbox account |
| **WP8** Decisions | **DONE (local)** | acknowledge → defer → resolve → reopen with a durable SELECT after each, and a stale `expectedVersion` losing with a 409 that does not move the record. The workflow route is gated server-side, ordered after the role check and before the assignee lookup so a shut gate is not a membership oracle | Nothing local. The gate ships off by design |
| **WP9** Account Intelligence | **PARTIAL** | Eleven sections, each answering in the closed vocabulary with a reason whenever it is not serving, and no raw exception anywhere. One source broken for real against the database: only that section stops serving, the header count agrees with the rows beneath it, and the reason is not SQL | The full 9 × 7 matrix cannot be produced from outside — sixty-three distinct failures cannot be injected into a live composition. The laws are checked across every section instead, and the difference is stated rather than hidden |
| **WP10** Creative Studio core | **PARTIAL** | 30 runtime checks: five tabs × four account postures, the window reaching each tab unchanged, and both leaks — an account carried across a tab switch and a refusal carried across one. The Engine V3 posture is resolved on the server and stated; its eight flag combinations are a 24-row matrix | Per-tab telemetry is unreadable because eight contracted leaves share one runtime surface name (§5) |
| **WP11** Briefs, Shares, Public Share | **PARTIAL** | `META_PUBLIC_SHARE_MINT` gates the mint on the server; refused → nothing minted; open → the row is really there; withdrawal stays available at the shipped setting | Rotate and revoke driven through the mounted UI rather than the store seam |
| **WP12** History | **DONE (local)** | `kind` and `entity` now reach the server — on the first paint too — with controls carrying the whole vocabulary. The nine families SUM to the unfiltered journal, and `writes` matches the action log row for row | — |
| **WP13** Automation | **PARTIAL** | The Stop exists, engages, reads back, releases, reads back and does it again — twice, because a one-way mechanism survives a single round trip. A stop engaged on the open server releases through the shipped one. Both directions land in the activity ledger | Provider-side reversibility. The gate stays shut until a sandbox proves what Meta does |
| **WP14** Launchpad read/draft/validate | **DONE (local)** | Create → edit → list → validate → delete against the real database, each read back from the table, with the two tables a provider write would mark checked before and after | — |
| **WP15** Launchpad execution | **BLOCKED** | The shipped refusal is proven end to end: 503, no LaunchIntent row, no action-log row | Every acceptance item needs a Meta sandbox account |
| **WP16** Harness, contracts, dead modules | **PARTIAL** | Anatomy 83/83, fidelity 83/83, frames 92/92 with zero substitutions. The reference gate runs again from the vendored hash-bound bytes. The three dead bodies are under `_reference`, bound to the reachability check in both directions | The shell harness still renders those three, so a11y/visual/responsive still measure them. Re-pointing it at the mounted owners is the rest of WP16 5–6. Contract verdict READY needs a re-vendor |
| **WP17** Telemetry, security, a11y, perf | **PARTIAL** | axe clean at 1440 light and 390 dark on thirteen surfaces; landmarks unique; D13 at five widths in both themes; the saved responsive matrix is 130/130 with a SHA-256 per file; LCP 228–256 ms, CLS ≤ 0.021, TBT 0 ms; token secrecy, HttpOnly, cookie-only POST refusal and login throttling. The instrumentation contract is now audited, with two of its claims corrected | Manual AT pass; the Creative Studio surface-name collapse; the public share page emits nothing |
| **WP18** Staged release | **BLOCKED** | — | Explicit authorization. Nothing merged, pushed, deployed or activated |

---

## 4. Defects found and fixed in this pass

Every one was found by pointing a gate at the thing it claimed to measure.

| # | Defect | Where it was found |
|---|---|---|
| 1 | Four of six release gates governed nothing, and `META_PUBLIC_SHARE_MINT` named a capability that was live and ungated | the gate wiring contract, rewritten from an audit into an enforcement |
| 2 | The Automation screen's "Approvals reach Meta" row answered from the guardrail column alone, printing "Yes" while the proposals route independently forced dry-run | wiring the gate to its screen |
| 3 | The Meta Stop was described on screen and reachable by nothing — "deliberately absent" reads as "this product cannot stop Meta writes" | WP13's acceptance, read literally |
| 4 | The "many accounts" fixture had ONE assigned account; every N-account assertion in the harness measured the wrong posture | the account-picker runtime checks |
| 5 | The seeded journal sat on the day boundary: History passed before midnight and failed after | the same run, twice, an hour apart |
| 6 | The four Creative Studio tabs and both sub-surfaces had no §9 read state at all | the five-tab × account-posture matrix |
| 7 | `engine-posture.ts` was reachable only from its own test — the five postures were written and mounted nowhere, so shadow and serving looked identical | WP10's "shadow decision authority gibi gösterilmez" |
| 8 | History's `kind` and `entity` filters were parsed by the read model and passed as `null` by every caller, with no controls at all | WP12's item 9 |
| 9 | The locale gate's own pattern counted `data-*` markers as copy, contradicting its documented rule | migrating the 70 strings |
| 10 | The reference gate read the design package from `Downloads/`, which `SOURCE.md` explicitly forbids, while the hash-bound vendored manifest sat unused in the tree | searching for an archive that was never needed |
| 11 | The product has two instrumentation vocabularies that were never reconciled; eight contracted Creative Studio leaves share one runtime name | the telemetry audit |
| 12 | The public creative share page emits no `screen_view` — it renders outside the shell, where the emitter lives | the same audit |

---

## 5. Validation at this HEAD

Every command was run at `e643f68a89e93fb5aab94936aa37cdfae7fb0890`. Results are quoted, not summarised.

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS** — 12 727 passed, 144 skipped, 63 todo, 0 failed (1 068 files) |
| `npm run build` | **PASS** |
| `npm run meta:runtime-evidence` | **PASS** — 264 authenticated role-matrix cases (8 principals × 33 leaves) + 397 browser checks, including the 130-cell responsive screenshot matrix |
| `npm run test:migrations-from-zero` | **PASS** |
| `npm run test:selection-race-seam` | **PASS** |
| `npm run test:release-gate-plan-seam` | **PASS** |
| `npm run test:operator-hardening` | **PASS** |
| `npm run test:zero-base:contract` | **PASS** |
| `npm run test:zero-base:compatibility` | **PASS** |
| `npm run test:zero-base:design` | **PASS** |
| `npm run test:zero-base:flows` | **PASS** |
| `npm run test:zero-base:states` | **PASS** |
| `npm run test:zero-base:routes` | **PASS** |
| `npm run test:zero-base:locale` | **PASS** — zero unexplained inline operator copy |
| `npm run test:zero-base:reference` | **PASS** — 99/99 regions, 248/248 controls, 35/35 collections, 83/83 artboards |
| `npm run test:zero-base:fidelity` | **PASS** |
| `npm run test:zero-base:frames` | **PASS** — 92/92, 0 substitutions |
| `npm run test:zero-base:a11y` | **PASS** |
| `npm run test:zero-base:responsive` | **PASS** |
| `npm run test:zero-base:visual` | **PASS** |
| `npm run test:zero-base:theme` | **PASS** |
| `npm run zero-base:reconcile:frames` | **PASS** |
| `npm run zero-base:contract:verify` | **PASS** — reports the package's own verdict as NOT READY |
| `npm run zero-base:contracts:check` | **PASS** |
| `npm run zero-base:fonts:verify` | **PASS** |
| `npm run zero-base:legibility` | **PASS** |
| `npm run meta:verify-mounted-bodies` | **PASS** |
| `npm run test:local-db` | **NOT RUN** — refuses without the external volume at `/Volumes/adsecuteDB`. A hardware precondition, not a code result. The same class of coverage runs on the ephemeral cluster, and `test:migrations-from-zero` passes |

---

## 6. Evidence by class

**Mounted route / browser.** 397 Playwright checks against the production standalone build
over HTTP with a real session, on two servers differing only in release-gate
environment. Every §9 state including two DB-level fault injections; the Meta
Stop's full round trip with a SELECT after each step; the decision workflow's
four transitions plus a version conflict; a share minted and read back from the
table; every canonical route, twin and legacy spelling; the window equality; the
five Studio tabs across four account postures; History's nine families against
SQL; the whole Launchpad draft lifecycle.

**Database.** A real PostgreSQL 16 cluster with the repo's real migrations. Every
"it worked" claim above is a `SELECT`, not a reading of a response body — a route
re-reads its own write and can report a success it did not persist.

**Provider.** None. No Meta call was made by anything in this session.

**Release and rollback.** Nothing merged, pushed, deployed or activated. Every
commit is independently revertible and scoped to one subject. Every release gate
still defaults off, asserted at `lib/meta/release-gate-wiring.test.ts`, which
now also fails on a gate reader it cannot account for.

---

## 7. What is blocked, and on what

| Blocker | Blocks | What is needed |
|---|---|---|
| No Meta sandbox account | WP7 (twelve-case matrix), WP15 (all), WP13's provider-side reversibility, WP1's live-refusal confirmation | A physical Meta ad account that may receive PAUSED creates, named explicitly, with the scope it may be used at |
| No production read-only access | WP6 query plan / capacity / retention / growth | Explicit authorization and the exact business IDs that may be read |
| Design package not re-vendored | WP16 items 9–10, REQ-27, REQ-28/M11, REQ-41 | The design owner ships an export regenerated at a single fingerprint. The vendored bytes are hash-verified and sufficient for every gate that runs today |
| No human assistive-technology pass | WP1, WP17 | A person with a screen reader confirming each disabled control's reason is announced. axe and the accessibility tree are checked; neither is a substitute |
| No release authorization | WP18 (all) | Explicit approval, per step |

None of these can be closed by writing code.

---

## 8. A finding I am not resolving unilaterally

The `off` / `allowlist` / `on` rollback lever does not do what its name says,
and the reason is worth stating precisely because the obvious fix would take
the product down.

- The mode parser **defaults to `off`** when the variable is unset.
- The only route that acts on it is `app/c/[businessId]/layout.tsx`, which
  `notFound()`s when the predicate is false.
- But `/c/:businessId/…` is redirected by the proxy to
  `/switch-business/:id?next=/app/…` **before that layout renders**, and the
  `/app` family — the canonical mount for every surface — reads the predicate
  only to report it in an envelope. Nothing there refuses.

So the lever is bypassed on the path an operator actually takes, which is why
the runtime harness serves every surface with the variable unset. The predicate
itself is correct and covered (`lib/zero-base/rollout.test.ts`).

The obvious repair — gate `/app` on the same predicate — would 404 the entire
product in every environment where the variable is not explicitly set to `on`
or to an allowlist containing the business, **including production**. Whether
production sets it, and to what, is not something I can see or change from
here, and taking a rollback lever from "ineffective" to "the product is down"
without knowing that is not a call to make silently.

It needs one decision from the operator: either `/app` starts honouring the
predicate (and the deployment sets the variable first), or the lever is
retired and the rollback story becomes the release gates, which are wired,
enforced on the server and default off. Recorded rather than chosen.
