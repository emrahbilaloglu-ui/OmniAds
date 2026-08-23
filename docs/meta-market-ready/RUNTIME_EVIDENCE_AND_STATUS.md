# Meta market-ready — runtime evidence and corrected status

Branch: `meta-market-ready`
HEAD: `7a3d00a1993c4c885f1af350c5bd5b3351d5dffb`
Date: 2026-08-23
Supersedes the status table in `EXECUTION_LEDGER.md`, which was written before
any surface had been exercised at runtime.

---

## 1. What changed since `fd66e06ba`

Eleven commits, 724 files, +11 859 / −983. 595 of those files are captured
evidence (frame and shell screenshots with per-file SHA-256 and a render
fingerprint); 129 are source.

| Commit | Work package | Subject |
|---|---|---|
| `86b48e252` | P1 | The Launchpad gate enforces the safety contract at runtime |
| `27978a9ed` | WP9 | The three Intelligence sections that were never composed |
| `73536e40b` | WP8 / WP4 | Remove the label writer from Decisions, scope its reads |
| `43d6d039f` | WP4 | Finish the cache-key sweep, as a gate rather than a pass |
| `ff9ec7008` | WP16 | Make the design gates run again, then fix what they found |
| `0f1b8af30` | WP16 | Close the ten artboard gaps anatomy and fidelity found |
| `3433c129a` | WP16 | Let the frames reconciler tell frame evidence from shell |
| `ec7895d27` | WP16 / WP17 | Runtime evidence, against the mounted routes |
| `44b559eed` | WP16 / WP17 | Fix what the runtime gate found on the mounted routes |
| `330e38b46` | WP6 / WP8 / WP17 | D8 and the landmarks, found on the mounted routes |
| `d7f9cfeca` | — | Stop `migrations-from-zero` failing on a clock race |
| `36f0ba2bd` | WP4 / WP15 | The role matrix and the write gates, run for the first time |
| `7a3d00a19` | WP11 / WP13 | Record which release gates are wired, and which are not |

Plus two evidence-only commits, `371bd9aba` and `8d53b0f67`.

---

## 2. The harness this evidence comes from

`npm run meta:runtime-evidence` boots a throwaway PostgreSQL 16 cluster (never
15432, the production tunnel; never 5432, the local volume), runs the repo's
real deploy migrations against it, seeds D6's zero / one / many account fixture
plus a second tenant, starts the production standalone build with
`DATABASE_URL` force-set, and drives the canonical routes as a signed-in
operator.

It makes **no provider call** and touches **no production system**. What it
proves is the application's behaviour on a real request against a real
database. What it cannot prove is anything about a provider response.

Its evidence class is **VERIFIED-RUNTIME (local)**. It is not
VERIFIED-RUNTIME (production) and it is not VERIFIED-PROVIDER.

---

## 3. Corrected status by work package

Read against each work package's own acceptance list in the master plan. A
package is DONE only when every acceptance item has the evidence class it asks
for. Nothing is marked DONE on the strength of a passing unit test alone.

| WP | Status | What holds | What is missing |
|---|---|---|---|
| **WP0** Baseline & authority | **DONE** | Exact HEAD and source hash; ADRs numbered and Accepted; `zero-base:contract:verify` reports the package's own verdict honestly as NOT READY; the dirty Share work is untouched (`stash@{0}`, `app/dev-preview-share/`) | — |
| **WP1** Interim posture | **PARTIAL** | No new provider write; Launchpad validate green and execution refused — proven on the running server; Automation states plainly that no control on it stops Google Ads | Manual assistive-technology confirmation that each disabled reason is announced. axe passes; axe is a scanner |
| **WP2** Surface registry & nav | **PARTIAL** | Six rail entries, five Creative tabs, all leaves reachable, zero 404, `meta:verify-mounted-bodies` 15/15, 312 authenticated route cases across every Client and Ops leaf | Active-state correctness on the `/app` twin and the legacy alias paths is asserted statically, not driven at runtime |
| **WP3** Integrations & assignment | **PARTIAL** | Authenticated 0 / 1 / N proven on the mounted route; selection read-back proven against the database the surface read; every Meta surface resolves the same account | Stale-snapshot, reconnect-race, revoked-credential, duplicate-ID and scheduling-failure cases; production read-only schema evidence |
| **WP4** Shell & account authority | **PARTIAL** | Role matrix 312/312 (admin, collaborator, guest, cross-tenant, inactive membership, orphan, Ops); no cross-account state survives a business switch, in either direction; cache-key sweep is a gate | The full 0/1/N × surface × role cross-product; leaving `account_required` by making a selection; `ZERO_BASE_UI_MODE` off / allowlist / on on `/c` and `/app` |
| **WP5** Window, as-of, freshness | **PARTIAL** | The windowed surfaces name the window they read; no fixed-day label contradicts the served range | URL → payload → label equality for 7d / 28d / today / custom; a window transition on a real account; timezone-missing behaviour |
| **WP6** Response/state contract | **PARTIAL** | Contract tests; migrations from zero and the upgrade seam both pass against a real cluster; no surface renders a money, ratio or rate value as zero for an account with no data; no empty collection renders bare | **No production body emits a §9 read state.** The envelope is defined and adopted by nothing. Query-plan, capacity, retention and 30–90 day growth evidence needs production read-only access |
| **WP7** Mutation safety foundation | **BLOCKED** | The contract is declared and the `launchpad_create` family conforms 18/18 | The twelve-case guarded sandbox matrix has not run. It needs a Meta sandbox account |
| **WP8** Decisions | **PARTIAL** | Workflow state machine, blocker priority and Golden Cases hold as unit proofs; the label writer is gone from Decisions; the surface withholds without an account | `acknowledge → defer → resolve` on a real decision with durable read-back; `expectedVersion` conflict as an integration test |
| **WP9** Account Intelligence | **PARTIAL** | Eleven sections compose; the surface renders against a real database and states Partial where the warehouse is not ready | The nine-section × seven-read-state matrix has not been exercised |
| **WP10** Creative Studio core | **PARTIAL** | All five tabs render on the mounted route; no scope leak across a business switch | The five-tab account/window/state matrix; the shadow posture's eight combinations; cache/scope leakage across a *tab* switch |
| **WP11** Briefs, Shares, Public Share | **PARTIAL** | The mint → rotate → revoke lifecycle, token enumeration, sanitised projection and buyer-tier privacy are proven against a real database by `ephemeral-postgres-public-share-seam-child.ts` | The same lifecycle driven through the mounted UI. And `META_PUBLIC_SHARE_MINT` gates nothing — minting is live and ungated (§5) |
| **WP12** History | **PARTIAL** | Outcome and entity golden tests hold; the surface renders and states its exclusions | Event-family counts read from a real database and matched against the rendered row counts |
| **WP13** Automation | **PARTIAL** | The role matrix covers the Automation leaf; the surface states the Meta-only scope of the kill switch | Engage → read-back → release → read-back, and reversibility in one session. The control is deliberately absent, so its gate is a placeholder (§5) |
| **WP14** Launchpad read/draft/validate | **PARTIAL** | Zero provider POSTs; over-limit, missing account/pixel/source and revoked account hold as unit proofs; the execution refusal is proven on the server | Draft create / edit / delete and the validate happy path driven at runtime |
| **WP15** Launchpad execution | **BLOCKED** | The shipped refusal is proven end to end: 503, no LaunchIntent row, no action-log row | Every acceptance item needs a Meta sandbox account |
| **WP16** Harness, contracts, dead modules | **PARTIAL** | Every design gate runs again (they had all been failing at their first import); anatomy 83/83, fidelity 83/83, frames 92/92; the a11y and responsive gates are retargeted at the mounted route DOM | "Harness DOM and route DOM diff zero" cannot be reached by harness changes: D2 fixes the legacy bodies as the visual owners, and the design package describes the zero-base library. Dead modules are enumerated but not moved. Contract verdict READY needs a re-vendor |
| **WP17** Telemetry, security, a11y, perf | **PARTIAL** | Real mounted-route evidence; axe clean at 1440 light and 390 dark on all thirteen surfaces; landmarks unique; D13 holds at five widths in both themes; LCP 212–280 ms, CLS ≤ 0.010, TBT 0 ms; token secrecy, HttpOnly, cookie-only POST refusal and login throttling all proven | Manual AT pass; a saved responsive screenshot matrix; the other 48 contracted telemetry events; PII-safe logging audit |
| **WP18** Staged release | **BLOCKED** | — | Needs explicit authorization. Nothing has been merged, pushed, deployed or activated |

---

## 4. Defects found and fixed this session

Each was found by pointing an existing or new gate at the thing it was supposed
to be measuring.

| # | Defect | Where it was found |
|---|---|---|
| 1 | `rejectIfLaunchpadExecutionGated` returned no refusal when the gate was open with an incomplete safety contract | P1, reproduced then closed at runtime |
| 2 | Every zero-base design gate had been failing at its first CSS-module import — a11y, responsive, visual, frames, fidelity | `npm run zero-base:shell:harness` |
| 3 | Ten artboards did not carry the anatomy the design package declares | anatomy gate, once it could run |
| 4 | Phone-width Meta and Creative interiors had no navigation and no scope at all | artboard anatomy → real defect |
| 5 | A stacked table's inline `min-width` dragged the whole surface sideways at 390 and 320 | fidelity gate |
| 6 | 253 serious colour-contrast failures across all thirteen mounted surfaces | axe on the mounted routes |
| 7 | Two scrollable regions no keyboard could reach | axe on the mounted routes |
| 8 | CLS 0.536 — five times the budget — from a status chip whose width is its text | the runtime performance gate |
| 9 | Every page in the product read the session twice | the runtime duplicate-read gate |
| 10 | Every Meta surface emitted `screen_view` twice, doubling every adoption number | the runtime duplicate-read gate |
| 11 | Plan & Billing told operators "No route or control in this product is gated by it" while five live `PlanGate`s refuse three Creative Studio tabs, Reports and Insights | the runtime route sweep |
| 12 | The Decision Center printed "Spend · today ₺0 — 0 conversions" for an account with no warehouse data | the runtime D8 gate |
| 13 | Three pages carried two `main` landmarks; Account Intelligence had two unnamed complementary landmarks | the runtime landmark gate |
| 14 | The role matrix had never run: it read the scope hop as a failure, looked for a shell marker no route emits, and declared a client-side return as a server redirect | first execution |
| 15 | `migrations-from-zero` failed intermittently on a clock race inside its own fixture | the validation battery |
| 16 | Four of six release gates are declared and wired to nothing; one of them (`publicShareMint`) names a capability that is live and ungated | gate wiring audit |

---

## 5. Validation at this HEAD

Every command below was run at `7a3d00a19`. Results are quoted, not summarised.

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS** — 12 647 passed, 144 skipped, 63 todo, 0 failed (1 064 files) |
| `npm run build` | **PASS** |
| `npm run test:migrations-from-zero` | **PASS** |
| `npm run test:schema-upgrade-seam` | **PASS** |
| `npm run zero-base:contract:verify` | **PASS** — reports the package's own verdict as NOT READY |
| `npm run zero-base:contracts:check` | **PASS** |
| `npm run test:zero-base:routes` | **PASS** |
| `npm run test:zero-base:compatibility` | **PASS** — 59 tests |
| `npm run check:workflows` | **PASS** |
| `npm run meta:verify-mounted-bodies` | **PASS** — 15/15 |
| `npm run zero-base:legibility` | **PASS** |
| `npm run test:zero-base:states` | **PASS** — G6 38/38, G7 142/142 |
| `npm run test:zero-base:flows` | **PASS** — 71/71 |
| `npm run test:zero-base:fidelity` | **PASS** — 83/83 artboards |
| `npm run test:zero-base:a11y` | **PASS** — 85 checks |
| `npm run test:zero-base:responsive` | **PASS** — 84 checks |
| `npm run zero-base:reconcile:frames` | **PASS** — 92/92 frames, 0 substitutions, 83/83 artboards |
| `npm run test:zero-base:visual` | **PASS** — 78 shell frames captured |
| `npm run meta:runtime-evidence` | **PASS** — 312 route cases + 130 browser checks |
| `npm run test:zero-base:locale` | **FAIL** — 70 unexplained inline strings. Pre-existing: every one exists at `fd66e06ba`, and this session added none |
| `npm run test:zero-base:reference` | **FAIL at its first step** — the extractor needs `Adsecute Zero-Base Design.zip`, which is no longer on this machine. The anatomy comparison it wraps passes 83/83 against the committed, hash-verified manifest |

---

## 6. Evidence by class

**Mounted route / browser.** 130 Playwright checks against the production build
over HTTP with a real session: the three D6 account postures, business
switching in both directions, tenant isolation by route and by API, every
canonical route refused without a session, axe at 1440 light and 390 dark on
thirteen surfaces, landmark uniqueness, D13 at 1440/1024/768/390/320 in both
themes, LCP/CLS/TBT/request counts, D8, empty-collection accounting, evidence
windows, and the Launchpad execution refusal.

**Database.** A real PostgreSQL 16 cluster with the repo's real migrations:
`migrations-from-zero` (three runs, including idempotency and the prior-epoch
upgrade), the schema upgrade seam, the public-share lifecycle seam, and the
selection-contract read-back — one selected account for the one-account
business, one of two for the many-account business, none for the zero-account
business.

**Provider.** None. No Meta call was made by anything in this session.

**Release and rollback.** Nothing merged, pushed, deployed or activated. Every
commit is independently revertible and scoped to one subject; the harness and
the fixes it found are separate commits, as the plan asks. Every release gate
still defaults off, asserted at `lib/meta/release-gate-wiring.test.ts`.

---

## 7. What is blocked, and on what

| Blocker | Blocks | What is needed |
|---|---|---|
| No Meta sandbox account | WP7 (twelve-case matrix), WP15 (all) | A physical Meta ad account that may receive PAUSED creates, named explicitly |
| No production read-only access | WP6 query plan / capacity / retention / growth, WP12 event-family counts | Explicit authorization for read-only production queries |
| Design package not re-vendored | WP16 items 9–10, REQ-27, REQ-28/M11, REQ-41 | The design owner ships an export regenerated at a single fingerprint. The archive is not even on this machine any more |
| No release authorization | WP18 (all) | Explicit approval, per step |

None of these can be closed by writing code.
