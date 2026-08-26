# Meta market-ready — runtime evidence and corrected status

Branch: `meta-market-ready`
Code HEAD: `db50bea17` — every figure below was measured there unless §5 says
otherwise. This document is the only thing committed after it.
Date: 2026-08-26
Supersedes the revision written at `392c92e37`.

**How to read this document.** §1–§5 are MEASURED: every number has a command
behind it and the command is named. §7 separates what is closed from what is
open, and says which measurement closed it. §8 is EXTERNAL — things no amount
of code can close. Where something is an inference rather than a measurement,
it says so in the sentence.

---

## 1. What this pass built

An independent audit found five safe local defects the green suite did not
cover, plus an incoherent remediation document. All five are fixed here, with
regressions, and the document is rewritten.

The previous revision's claim that "all four local items closed" was true of
the four items it named and is NOT a claim about these five. They are different
findings, and this revision does not inherit that sentence.

| # | Was | Now |
|---|---|---|
| 1 | Two operator POST routes enforced role and reviewer and never read the demo flag, while the composer disabled their controls on the claim that they did | **Enforced on the server**, fail-closed: 403 for a confirmed demo workspace, 503 for a flag that could not be read, before any durable write |
| 2 | `respond` took any non-empty `recId` straight to an INSERT — no FK, no existence check | **Server-authoritative**: the id must name a recommendation this business was served, inside a bounded window. Foreign-business, invented and stale ids are refused with nothing written |
| 3 | The Launchpad composite substituted an empty array for a store its capability said was unreadable, then stamped the section `complete` | **`unavailable` / `schema_not_ready`**, and the repositories are not called. The client outcome is `not-ready`, never `empty` |
| 4 | The Stop ceremony's phrase followed the payload while its action followed the direction the form was opened in | **Both follow the captured direction**, and submit re-resolves against the payload and clock as they are. Zero requests when either moved |
| 5 | The history plan created a backup ref and then required checks that the backup makes impossible | **Two phases**, each verifying only what it can be true about — and a measured fact that reshapes it (§7.9) |

Seven commits since `392c92e37`. Excluding the recaptured evidence:
19 files changed, +1 868 / −190.

| Commit | Subject |
|---|---|
| `50c2ac9a6` | Enforce demo authority and served-id authority at the two operator write boundaries |
| `8efb14ab6` | Launchpad: an unreadable store is not an empty one |
| `f06d923f3` | WP13: confirm the direction that was opened, against the reading as it is now |
| `011b38926` | Rewrite the history plan into two phases that can both be true |
| `f5da5da38` | Prove the served-id refusal against a real database, not a mock |
| `159cdf614` | Recapture the 92 frames from the audited tree |
| `db50bea17` | Recapture the runtime screenshot set from the audited build |

---

## 2. The defects this pass found and fixed

Every one is a MEASURED defect: an assertion that failed, or a guard that was
absent and provably reachable. Where the audit's framing and the code disagreed,
the code is quoted.

| # | Defect | Consequence |
|---|---|---|
| 1 | `/api/meta/recommendations/respond` had no demo gate | `/api/auth/demo-login` opens a session as an ADMIN of the demo business under a non-reviewer email, so it cleared the role floor and the reviewer floor and inserted a durable `meta_decision_responses` row — which `lib/meta/outcome-accrual.ts` later reads back as evidence that an operator acted |
| 2 | `/api/meta/snapshot/run-now` had no demo gate | Same session ran the recommendation engine INLINE: a five-minute in-process cooldown is stamped before anything else, then a calibration transaction opens and snapshot rows are upserted |
| 3 | `lib/zero-base/meta/intelligence-server.ts` said both routes refuse a demo workspace, and disabled two controls on that basis | The rule existed only in the browser. A control disabled in a client is not an authority boundary |
| 4 | The surface's `actor.demo` is a well-known-id comparison, not a read of `businesses.is_demo_business` | A workspace flagged demo without that id read as live on screen. The routes now read the flag; the screen may be the more permissive of the two, never the only one |
| 5 | `respond` accepted any non-empty `recId` | No FK on the column, no existence check in the route: an operator decision could be recorded against an id of the caller's choosing, or another workspace's recommendation |
| 6 | `/api/launchpad/meta/workspace` substituted `Promise.resolve([])` for an unreadable store and `settled()` stamped the section `complete` | An unmigrated schema arrived at the surface as "this workspace has no drafts" — the §9 collapse the contract exists to stop, and the opposite of what the route's own header claimed |
| 7 | The composite refused a guest with `capability_read_denied` | §9.1 declares that a PROVIDER permission failure whose remedy is reconnecting Meta. It told an under-privileged operator to go reconnect a credential that was fine. `insufficient_role` is the code the dictionary added for exactly this |
| 8 | `stopPhrase` was derived from the payload while the submitted action came from the captured direction | A payload that moved underneath produced "Type RESUME META to stop Meta automation for this business", and typing the phrase on screen submitted the OTHER direction |
| 9 | The ceremony was resolved only at render | Typing takes time. A preflight could age past `STOP_PREFLIGHT_MAX_AGE_MS` while the operator typed, and nothing re-renders when a clock passes a boundary, so the confirmation was made against a reading the surface itself would now refuse |
| 10 | `interpretMetaSnapshotRunResponse` read only a top-level `message` | The one interpreter both run-now clients share. Every nested guard refusal — including the reviewer 403 that has always existed — reached the operator as the generic "Snapshot refresh failed." |
| 11 | The history plan created a backup ref, then required `--all` and blob-unreachability checks | The backup exists to keep those objects alive. Neither check could ever pass while it did |
| 12 | This document's own first attempt to enumerate the blob-bearing commits used `"$c:path"` under zsh | zsh's `:a` modifier mangled it into an absolute path, and the loop reported a clean history for a history that was not clean. The corrected form and the reason are now recorded in the plan |

### 2.1 What the audit named that the code did NOT support

Recorded because a fix that invents a scope is worse than one that admits it
cannot express one.

**Account scope for a recommendation response is not expressible.**
`meta_decision_snapshots_daily` has no provider-account column — the DDL is
`(scope_type, scope_id, business_id, snapshot_date, rec_id, rec_type, …)` — and
for `scope_type='account'` rows `scope_id` is the BUSINESS id
(`lib/meta/snapshot.ts`: `return { scopeType: "account", scopeId: businessId }`).
A predicate against `scope_id` would mean two different things by row level and
would reject every account-level recommendation. The check is therefore
business- and recency-scoped, and `lib/meta/served-recommendation.ts` says so in
its own header rather than implying an account scope it does not enforce.

**"Latest snapshot only" would be wrong.** `undeferred` exists to lift a
deferral taken days ago, so a latest-only test would refuse a legitimate
response. The window is bounded at 30 days, which is also what keeps the read on
`(business_id, snapshot_date)` — the only index there is. `rec_id` is in none of
them, and this codebase has already lost a surface to an index-unusable
predicate.

**The check cannot be a table constraint.** `lib/triage-events.ts` is a second
writer of `meta_decision_responses` whose rec ids are synthetic and never have a
snapshot row. An FK, trigger or CHECK would break it. The check belongs at the
route that accepts an id from a caller.

---

## 3. Status by work package

| WP | Status | What holds | What is missing |
|---|---|---|---|
| **WP0** Baseline & authority | **DONE** | Exact HEAD and source hash; ADRs Accepted; the untracked Share work untouched | — |
| **WP1** Interim posture | **PARTIAL** | No provider write; execution refused on the running server; Automation states the Meta-only scope of its stop at every width | Manual assistive-technology confirmation |
| **WP2** Surface registry & nav | **DONE** | 37 runtime checks: every canonical route, `/app` twin and legacy spelling, compared on body identity | — |
| **WP3** Integrations & assignment | **PARTIAL** | A refused connection reads "Action required"; duplicate spellings resolve to the catalog's form; Overview now states per-source readiness from the real reads | A genuinely revoked Meta credential needs Meta to refuse one. Production read-only schema evidence |
| **WP4** Shell, account authority, rollout | **DONE (local)** | 38 checks across `off` / `allowlist`-in / `allowlist`-out / `on`; authorization runs before the rollout decision | — |
| **WP5** Window, as-of, freshness | **DONE** | URL → request → caption as one equality, on the workspace's own clock; and the inspector now states the as-of and the evidence window as separate facts | — |
| **WP6** Response/state contract | **PARTIAL** | One server-owned resolver; all seven §9 states proven; the notice's placement decided by whether a state ENDS; and `not-ready` is now produced by a real surface rather than only declared — Launchpad emits it for an unmigrated store | Query-plan, capacity, retention and growth evidence needs production read-only access |
| **WP7** Mutation safety foundation | **BLOCKED** | The contract is declared and `launchpad_create` conforms 18/18. Demo write authority is now enforced at four boundaries rather than two — Launchpad, Automation, and both operator-decision routes — all reading one flag through one function | Needs a Meta sandbox account. TWO further routes run the same inline snapshot without a demo gate: see §7.10 |
| **WP8** Decisions | **DONE (local)** | Six lanes including the server's `blocked` state; the level filter with URL round-trip; the inspector's close, provenance band and grain gaps; share-view, brief, Ads Manager, inactive-assets strip and the manual-action route; the seven transitions with the fields the server requires; the 409 dialog with keep-mine and take-server; two server refusals every sibling route already performed | Provider execution needs a sandbox |
| **WP9** Account Intelligence | **DONE (local)** | All nine plan sections composed. Both control sections gated on the SERVER at three floors — role, reviewer, demo — with the demo half fail-closed. Respond acts on a `rec_id` the server verifies as served: an invented id and another workspace's id are both refused 404 against the real database, with nothing written | — |
| **WP10** Creative Studio core | **DONE (local)** | Five tabs × four account postures; per-tab telemetry resolves to nine distinct names | — |
| **WP11** Briefs, Shares, Public Share | **DONE (local)** | The whole lifecycle on the LEGACY studio and the CANONICAL console; and a decision can now reach the brief flow at all | — |
| **WP12** History | **DONE (local)** | Nine families SUM to the journal; `writes` matches the action log row for row | — |
| **WP13** Automation | **PARTIAL** | The Stop ceremony on the MOUNTED body: a fresh persisted preflight with its age, typed confirmation in both directions, a POST that may never announce anything, success only from a server read-back, and engage → read-back → release → read-back in one session with the control table checked after each. The confirmation is now made in ONE direction against ONE reading: the phrase and copy follow the direction the form was opened in, and submit re-resolves against the payload and clock as they are — zero requests if either moved. `collaborator` engages, `admin` releases, matching the route | Provider-side reversibility needs a sandbox |
| **WP14** Launchpad read/draft/validate | **DONE (local)** | Create → edit → list → validate → delete, each read back from the table; the first load is one composed read at the two authorization floors the seven routes actually have; and a store the capability says is unreadable is reported `not-ready`/`schema_not_ready` rather than empty, with its repository never called | — |
| **WP15** Launchpad execution | **BLOCKED** | The shipped refusal proven end to end | Needs a Meta sandbox account |
| **WP16** Harness, contracts, dead modules | **PARTIAL** | Anatomy 83/83; frames 92/92 recaptured from this tree; the Automation harness renders the mounted body, and the archived Automation presenter is now unreachable from every route and from every module outside `_reference` bar the flow-I suite. The Decisions repoint was RUN: 83/83 anatomy with the mounted body, and 229 fidelity findings, all `untokenised-colour` | The two repoints wait on the design re-vendor — see §7.1 and §7.2 |
| **WP17** Telemetry, security, a11y, perf | **PARTIAL** | CLS within budget with an empty debt map; axe clean at 1440 light and 390 dark on thirteen surfaces; Launchpad's first load inside the budget with its ceiling deleted; the refused Stop reachable from the keyboard; the mobile scope sheet able to change the scope it states | Manual AT pass |
| **WP18** Staged release | **BLOCKED** | — | Explicit authorization. Nothing merged, pushed, deployed or activated |

---

## 4. The harness this evidence comes from

`npm run meta:runtime-evidence` boots a throwaway PostgreSQL 16 cluster (never
15432, the production tunnel; never 5432, the local volume), runs the repo's real
deploy migrations, seeds the D6 fixture, and serves the **production standalone
build** on five servers against one database — `shipped-gates`, `gates-open`,
`rolled-back`, `allowlist` and `legacy-mint`. A mode and a gate are properties
of a process, so each posture gets its own build and the difference between two
answers to the same request *is* the mode or the gate.

`META_LAUNCHPAD_EXECUTION`, `META_AUTOMATION_LIVE_WRITES`,
`META_DECISION_WORKFLOW_UI` and `ZERO_BASE_MUTATION_UI_ENABLED` are opened
**nowhere**. The first two because their next step is a call to Meta; the second
two because the controls they open default off, which is what a staged release
means.

`META_AUTOMATION_STOP_UI` is the one gate the two servers differ on, and the
difference is the evidence: the same POST answers 503 `automation_stop_disabled`
on the shipped server and is accepted on the gates-open one. Releasing an
existing stop is refused by no gate at either setting — a stop that cannot be
lifted is worse than no stop — and both servers still reach no provider, because
`dryRunOnly` stays true and nothing on the surface addresses Meta.

The saved responsive matrix is
`playwright/artifacts/meta-runtime/meta-market-ready-159cdf6148/` — thirteen
surfaces x five widths x two themes, named for the code it was taken from. It is
not a regression baseline: nothing diffs against it, and the pixel oracles are
the zero-base visual and fidelity gates.

---

## 5. Validation

Run at `db50bea17` unless noted. Results quoted, not summarised.

| Command | Result |
|---|---|
| `git diff --check` / `npm run test:whitespace` | **PASS** — working tree, index, and `843b6e9c8..HEAD` as a tree diff |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS** — 13 052 passed, 144 skipped, 63 todo (13 259) across 1 085 files, 0 failed |
| `npm run build` | **PASS** |
| `npm run meta:runtime-evidence` | **PASS** — 381 passed, 130 skipped, 0 failed (26.2 min), exit 0 |
| `META_RUNTIME_SPEC_FILTER=meta-runtime-intelligence …` | **PASS** — 13 passed, including the two new served-id refusals against the real table |
| `META_RUNTIME_SCREENSHOT_SET=meta-market-ready-159cdf6148 …screenshots.spec.ts` | **PASS** — 131 passed (7.7 min); this is the 130 the sweep skips |
| `npm run meta:verify-mounted-bodies` | **PASS** — 15 surfaces |
| `npm run test:zero-base:reference` | **PASS** — 99/99 regions, 248/248 controls, 35/35 collections, 83/83 artboards |
| `npm run test:zero-base:fidelity` | **PASS** — 81/83 frames matching, with the 45 recorded paint-system findings on H19/H20. Unchanged by this pass |
| `npm run zero-base:reconcile:frames` | **PASS** — 92/92, 0 substitutions, recaptured at `f5da5da381` |
| `npm run test:zero-base:a11y` / `:responsive` / `:visual` / `:theme` | **PASS** |
| `npm run test:zero-base:routes` / `:flows` / `:states` / `:locale` / `:contract` / `:design` / `:compatibility` | **PASS** |
| `npm run test:local-db` | **NOT RUN** — refuses without the external volume at `/Volumes/adsecuteDB`; a hardware precondition, and `test:migrations-from-zero` covers the same class |

### 5.1 The new regressions, and proof they are regressions

A test that passes before and after a fix is not a regression test. Where a
case could be run against the previous behaviour, it was.

| Area | Cases | Where |
|---|---|---|
| Demo authority, respond | confirmed demo → 403 nothing written; `unverified` and `not_established` → 503 nothing written; the flag read for the SERVER's business, not the body's | `app/api/meta/recommendations/respond/route.test.ts` |
| Demo authority, run-now | the same three, plus "the refusal is where the shared interpreter can read it" and the server-business check | `app/api/meta/snapshot/run-now/route.test.ts` |
| The guard itself | live passes; demo 403; both unverified states 503; both refusals stated at the top level AND inside `error`; asks about the business it was given | `app/api/meta/demo-write-authority.test.ts` |
| Served-id | served / not_served / source_unavailable; the predicate names `business_id`, `rec_id`, `kind` and a date bound; it does NOT name `scope_id` or `provider_account_id`; the window clamps; an empty id asks the source nothing | `lib/meta/served-recommendation.test.ts` |
| Served-id at the boundary | invented id → 404 nothing written; unreadable source → 503 nothing written, not 404 | `app/api/meta/recommendations/respond/route.test.ts` |
| Served-id end to end | an invented id and another workspace's id, both refused 404 by the live server with `meta_decision_responses` read back at 0 rows | `playwright/tests/meta-runtime-intelligence.spec.ts` |
| Unreadable schema, server | templates / drafts / intents each unmigrated → that section `unavailable` + `schema_not_ready` while the others stay `complete`; no repository called; a FAILED capability probe still attempts the read | `app/api/launchpad/meta/workspace/route.test.ts` |
| Unreadable schema, client | outcome `not-ready` with `schema_not_ready` and the migration sentence; a guest's `insufficient_role` still reads as a refusal; an undeclared code is ignored | `app/(dashboard)/platforms/meta/launchpad/launchpad-exact.test.tsx` |
| Direction flip | the phrase and copy stay in the opened direction; submit sends nothing and says why; the notice clears on reopen | `app/(dashboard)/platforms/meta/automation/stop-ceremony.test.tsx` |
| Expiry after typing | fresh at open, aged past the window at submit → zero requests, the resolver's own sentence | same file |
| The interpreter | reads a nested guard refusal; prefers a top-level sentence when both exist; still falls back when neither carries one | `components/meta/redesign/MetaPlatformPage.test.tsx` |

**Proven against the previous behaviour.** The four ceremony cases were run
with the fix reverted: all four fail, and the fifth — "still sends when nothing
moved" — passes both ways, which is what a control case must do.

```
× keeps the phrase and the copy in the direction the form was opened in
× refuses and sends nothing when the payload flipped direction while open
× refuses and sends nothing when the reading aged out after typing
× clears a previous abort notice when the ceremony is opened again
  Tests  4 failed | 1 passed | 13 skipped (18)
```

### 5.2 Launchpad's first load, named

The count was 18 with the cause recorded as "unattributed". The perf spec now
prints every request whenever a surface is over budget, so the inventory is a
measurement rather than a claim. Nine of the eighteen are the SHELL, and every
Meta surface pays the same nine:

```
/api/instrumentation/event   /api/auth/me        /api/billing
/api/integrations  (x2)      /api/notifications  /api/meta/status
/api/oauth/shopify/pending   /api/google-ads/status
```

`meta-history` measures exactly nine, which is how the shell's share was
isolated. The other nine were Launchpad's own, and seven asked the same question
about the same account at the same instant:

```
/api/meta/history/accounts           /api/launchpad/meta/drafts
/api/launchpad/meta/templates        /api/launchpad/meta/intents
/api/launchpad/meta/templates/recent /api/launchpad/meta/recent-ad-actions
/api/business-commercial-settings
```

`/api/launchpad/meta/workspace` composes those seven. Measured **11** on four
consecutive runs (once 10), against a budget of 12, and the surface's entry in
`FIRST_LOAD_API_CALL_DEBT` is **deleted** rather than lowered — it needs no
ceiling of its own. The only repeat is the shell's known `/api/integrations`
duplicate, which is on the recorded list and belongs to two owners of the
integrations store.

What did not change, and is asserted in `app/api/launchpad/meta/workspace/route.test.ts`:

- **Authorization.** The seven routes do not share one floor and this does not
  give them one. `/api/meta/history/accounts` admits a `guest`; the six
  Launchpad routes are hardcoded to `collaborator`. Both are enforced
  separately, so a guest still reads the account list and still cannot read the
  library — the refusal arrives as a 200 that names it per section, not as a 403
  that would have taken the account picker away.
- **Scope.** The same `resolveAssignedMetaLaunchAccount`, and the client still
  filters rows to the account it asked for.
- **Freshness.** Every folded route is `force-dynamic` and uncached; so is this.
- **Reporting.** The four §9 outcomes keep their ids, their row counts and their
  meaning. A section the server did not report on is unread, never empty.

### 5.3 The runtime sweep, by matrix

Every one of the 381 checks runs in a browser against the production standalone
build over HTTP with a real session. This pass added two — an invented `rec_id`
and another workspace's `rec_id`, both refused by the live server with
`meta_decision_responses` read back at zero rows — which is why Account
Intelligence is 12 rather than 10.

| Spec | Checks |
|---|---|
| a11y (axe, 13 surfaces x 2 postures) | 53 |
| Automation Stop ceremony | 8 |
| interaction (keyboard, dialogs, drawer, scope sheet, notice placement, reduced motion, logs) | 49 |
| rollout (four modes x the surface set) | 38 |
| surface identity (canonical / `/app` twin / legacy spelling) | 37 |
| states (§9's seven, per surface) | 32 |
| Creative Studio (five tabs x four postures) | 29 |
| perf (CLS and first-load reads, 13 surfaces) | 26 |
| read-state | 22 |
| release gates | 18 |
| share lifecycle | 16 |
| scope | 11 |
| Account Intelligence | 12 |
| history | 7 |
| window | 7 |
| integrations · security · write gates | 5 each |
| Launchpad | 4 |

The 130 skipped are `meta-runtime-screenshots.spec.ts`, which refuses to run
without a caller-supplied set name; they are the separate 131-check row above.

Ten of the 381 were added by the previous pass: eight for the Stop ceremony — the refusal
before it acts, the preflight's age, the gate's two halves, release ungated,
the typed confirmation suppressing the request, the engage → read-back →
release → read-back round trip against `meta_automation_business_controls`, and
no provider call — and two for respond, which seeds one recommendation, drives
the mounted control and reads the row back out of `meta_decision_responses`.

### 5.4 The Decisions repoint, measured

Not reasoned about — run.

```
frame-registry.tsx -> MetaDecisionCenterExact (through the real adapter)
npm run test:zero-base:reference   PASS   83/83 artboards, 99/99 els, 248/248 ctls
npm run test:zero-base:fidelity    FAIL   229 findings across 11 artboards
                                          — every one `untokenised-colour`
```

Four non-paint defects surfaced by that run were fixed and are in the shipped
code: two `not-a-control` markers, one `placement`, and four elements sized off
the reference type scale. After those, the residue is **229 untokenised-colour
findings and nothing else**. §7.1 is why the repoint did not land.

---

## 6. Evidence by class

**Mounted route / browser.** Playwright against the production standalone build
over HTTP with a real session, across five servers differing only in rollout
mode and release-gate environment.

**Database.** A real PostgreSQL 16 cluster with the repo's real migrations. Every
"it worked" claim is a `SELECT`, not a reading of a response body.

**Deterministic composition.** Where a state cannot be injected into a live page
— WP9's per-section matrix, the workflow menu's refusals, the conflict dialog's
two choices — the composer or the component is driven directly, and the reason
that is the right instrument is stated in the file rather than glossed.

**Provider.** None. No Meta call was made by anything in this session.

**Release and rollback.** Nothing merged, pushed, deployed or activated, and no
history rewritten. Each fix in this pass is one commit and reverts on its own. Every release gate still defaults off — `automationStopUi`
holds ENGAGE and never holds RELEASE, and the gates-open server exists only so
the difference between the two answers can be measured.

---

## 7. What remains, and the measurement behind each

Three classes, kept apart on purpose:

- **Closed** (§7.4–§7.7, §7.9) — a measurement says so, and the measurement is
  named.
- **Open and local** (§7.10) — this pass measured it and did not fix it,
  because it is outside the instruction that produced this revision.
- **Open and external** (§7.1–§7.3, §7.8) — no amount of code closes it. §8
  lists what each needs.

### 7.1 The Decisions harness repoint — held by the paint system

The previous revision said the mounted Decision Center "is a different product
from the one the design draws" and that nine markers had no element to attach
to. That was true when it was written. It is not true now: the lane, the level
filter, the close control, the evidence band, the share/brief/Ads-Manager/
ceremony controls, the workflow menu and the conflict dialog are all built, and
pointing the eleven Decisions artboards at the mounted body takes the anatomy
gate to **83/83**.

Fidelity reports **229 findings across those eleven artboards, every single one
`untokenised-colour`**. The mounted console is painted in the `adv` system
(Instrument Sans, Space Grotesk, `--adv-*`); the accepted package is the Ledger
one (Schibsted Grotesk, Fragment Mono, `--ledger-*`). There are exactly two ways
to make that green and both are refused by standing instruction: repainting this
one surface leaves it foreign to the other twelve, and adding these frames to
`PAINT_SYSTEM_DEBT` raises a ceiling that may only fall.

So the repoint waits on the design owner's re-vendor, and it is **one line** in
`frame-registry.tsx` when that lands — the fixture, the CSS-module wiring and
the markers are already written beside it.
`scripts/zero-base/decisions-repoint-readiness.test.ts` keeps the anatomy half
permanently true: it renders the mounted body from that fixture and asserts every
required marker of H09, H10, H11, H12, B02, B06, B07, H52, H57, P06 and P07 on
every run.

### 7.2 The Overview harness repoint — the same wall, plus a presenter

The four capabilities exist. `app/(dashboard)/overview/page.test.tsx` asserts
`data-el="home-kpis"`, `data-el="source-readiness"`,
`data-collection="sources"`, `live:chart-table-toggle` and `live:MOBILE-01`
against the rendered mounted body, and the connect control is proven where a
source is genuinely disconnected.

Two things still hold the harness. The same paint system: the mounted body and
the v2 cards it composes paint with 70 raw hex values and the `.adv-*` layer.
And, unlike `MetaDecisionCenterExact`, this body is not props-only —
`legacy-page.tsx` is a zero-prop client component with 19 hook call sites, so
the harness cannot render it without a presenter extraction. That extraction
belongs with the re-vendor rather than before it: on its own it would produce a
harness that renders the mounted body and still fails fidelity for the paint.

### 7.3 The archived-body ceiling is still 2

Unchanged by this pass, and worth stating plainly rather than letting §7.6 imply
otherwise. `PERMITTED_REFERENCE_BODIES` holds two entries — the archived
Decisions body and the archived Overview body — and both are held by the paint
system, not by anything this pass could build. The Automation presenter came off
that list in the previous pass, when H19/H20 were repointed at the mounted body;
what this pass did was remove its remaining reachability, which is a different
claim (§7.6).

The ceiling may only fall. It falls to zero on the day the design package is
re-vendored.

### 7.4 Respond, closed — and now enforced on the server as well as offered

The control acts. `SectionControl` carries `targets` — the snapshot's own
`rec_id` values with the titles it wrote — the view offers the recommendation
before the action, and the client posts `/api/meta/recommendations/respond` with
a SERVED id. Proven end to end on the running server: the runtime spec seeds one
recommendation, drives the mounted control, and reads the row back out of
`meta_decision_responses` for that exact `rec_id`.

**What the previous revision closed was the AFFORDANCE. This pass closed the
BOUNDARY.** The control acting on a served id was the surface doing the right
thing; the route still accepted any id from any caller, and still wrote for a
demo workspace. Both are now server-enforced, fail-closed, and proven against
the real table (§5.1).

Two refusals, both server-authored. The ACTOR's — reviewer, then demo, then role
— outranks everything, in the route's own precedence. And when there is nothing
to act on, the control is refused with a served sentence and **no §9.1 code**: a
snapshot that carries no recommendation is a measured zero, and giving it a
failure code would report an absence as a defect.

The count fact was also wrong: `count()` takes an array and was handed
`.length`, so a served three read "Not reported" on every load.

### 7.5 The scope sheet's pickers, closed

The three rows the design gives a picker now have one, and it is the topbar's.
Each topbar control registers a handle through `ScopeControlsProvider`; the
sheet closes, the real trigger takes focus and opens, and the same handler
writes the same cookie, the same URL and the same store it always did. There is
no second writer and no second opinion about what is permitted.

A picker appears only where there is a choice: with no assigned account the row
is a link to Integrations and with exactly one the account is named rather than
offered, so neither registers. Refusals travel with the handle and are RENDERED,
not only titled — the account picker's release-gate sentence and the surface
registry's current-state note, in the words that decided them — and the control
is `aria-disabled` rather than `disabled`, so it keeps its place in the tab
order.

### 7.6 The archived Automation presenter, retired

The ceremony was ported to `app/(dashboard)/platforms/meta/automation/automation-view.tsx`,
which is the body every route mounts: a fresh persisted preflight with its age,
a typed confirmation whose phrase depends on the direction, a POST that may
never announce anything, and success only where a server read-back agrees with
the intent. `collaborator` engages and `admin` releases, matching the route —
the archived resolver required `admin` for both and was therefore hiding the
emergency stop from operators the server would have accepted.

The presenter was already off the harness allowlist. What changed here is
reachability: its client wrapper moved to `components/zero-base/_reference/`
beside it, and `harness-reachability.test.ts` now asserts both that no route
reaches the presenter and that nothing outside `_reference` imports it, with one
named exception — `flow-i.test.tsx`, which still encodes the ceremony's laws
against it.

It is not deleted. WP16's migration rule holds compatibility until the required
stable-release gate.

### 7.7 Launchpad's first-load read count, closed

11, measured on four consecutive runs, against a budget of 12. Every request is
named in §5.2, the seven that asked one question are one composed route, and the
surface's `FIRST_LOAD_API_CALL_DEBT` entry is deleted rather than lowered. No
exception is claimed, because none is needed.

### 7.8 The history rewrite waits for approval

`app/dev-preview-share/page.tsx` is user-owned, untracked, and byte-unchanged
(md5 `319c80d401494da99f507a4e4bb87c61`, verified again at `db50bea17`). It was
swept into the index twice by a broad `git add -A` — at `eee701160` and again
at `ab80dc1f9` — and untracked both times, forward-only, by `b719400a3` and
`f7d7057cc`.

Two numbers, measured and different: **seven** commits carry the path in their
tree; the rewrite RANGE `eee701160~1..HEAD` is **24** commits, because every
commit after the first addition must be rewritten for its parent to change.
Earlier revisions of the plan gave one number for both and were wrong twice.

Both remotes were queried live — `git ls-remote --heads origin` and
`origin-ssh` — and neither holds this branch. There is no remote-tracking ref.
`origin` and `origin-ssh` are two transports to one GitHub repository, and both
are asked anyway.

`docs/meta-market-ready/HISTORY_REMEDIATION_PLAN.md` is now two separately
approved phases (§7.9 is why). **Nothing in it has been run**, and
`git-filter-repo` is not installed on this machine.

### 7.9 The blob is reachable from outside this branch — MEASURED, and it changes the plan

The old plan's success criterion was "the blob is unreachable". That is not
achievable by rewriting this branch, and this pass measured why.

```
$ for r in $(git for-each-ref --format='%(refname)' refs/codex refs/stash); do
    git rev-parse -q --verify "${r}:app/dev-preview-share/page.tsx" >/dev/null && echo "$r"; done
refs/codex/turn-diffs/captures/1787684943906/…/base                    -> 792c3e307
refs/codex/turn-diffs/checkpoints/9f788053…/bff28d85…/1787635490589/…  -> ac9872d44
```

Both hold blob `7eee531c6d5e783f389e05e99ea6cd73cbedc1b4` — the same bytes —
and neither descends from this branch. `refs/heads/meta-market-ready` is the
only ref that descends from `eee701160`. `refs/stash` holds one entry and does
not carry the path.

Those refs are another tool's checkpoint state. Deleting them is a decision
about that tool's recoverability, not about this branch's history, so Phase B
names it as a precondition and says to STOP after Phase A rather than run a `gc`
that cannot deliver what it claims.

This is a fact about the repository, not a defect in the product, and it is not
closable by code.

### 7.10 Two more routes run the same inline snapshot without a demo gate — OPEN

Measured while fixing §7.4's demo boundary, and deliberately not fixed here:
the instruction that produced this revision named two routes, and widening a
security change beyond its stated scope without saying so is how a review stops
being a review.

```
$ grep -rn "requestMetaSnapshotRefreshForBusiness" --include="*.ts" . | grep -v node_modules
app/api/meta/snapshot/run-now/route.ts:47          <- gated by this pass
app/api/meta/campaign-labels/route.ts:109          <- reviewer gate only, no demo gate
app/api/business-commercial-settings/route.ts:223  <- no demo gate
app/api/business-commercial-settings/route.ts:349  <- no demo gate
```

All three run the identical inline snapshot: the same cooldown stamp, the same
calibration transaction, the same snapshot upserts.
`business-commercial-settings` does have an `isDemoBusinessId` check, but it
fires only for the REVIEWER email and is the id-comparison helper rather than a
read of `businesses.is_demo_business` — so a demo ADMIN passes it.

The fix is mechanical now that `rejectIfMetaOperatorDemoWrite` exists: the same
call, after each route's reviewer guard, before its refresh. It is a decision
about scope, not a technical blocker.

## 8. Externally blocked

| Blocker | Blocks | What is needed |
|---|---|---|
| No Meta sandbox account | WP7, WP15, WP13's provider-side reversibility, WP1's live-refusal confirmation | A physical Meta ad account that may receive PAUSED creates, named explicitly, with the scope it may be used at |
| No production read-only access | WP6 query plan / capacity / retention / growth | Explicit authorization and the exact business IDs that may be read |
| **Design package not re-vendored** | **WP16 §7.1 and §7.2** — 229 measured findings on Decisions, and the same class on Overview — plus the 45 recorded paint-system findings on H19/H20, REQ-27, REQ-28/M11 and REQ-41 | An export regenerated at a single fingerprint. The archive itself is not needed; the vendored bytes are hash-verified |
| No human assistive-technology pass | WP1, WP17 | A person with a screen reader confirming each disabled control's reason is announced. axe, the accessibility tree, focus order, dialog traps, live-region politeness and reduced motion are all checked; none is a substitute |
| No release authorization | WP18 | Explicit approval, per step |
| No approval for the history rewrite | §7.8 | An explicit instruction. The plan, its verification and its preconditions are written; nothing in it has been run |
| The Codex turn-diff refs hold the blob | §7.9 | A decision by whoever owns that tooling about whether those two refs may be deleted. Until then Phase B cannot deliver an unreachable blob, whatever it does to this branch |

None of these can be closed by writing code.

**Not on this list, because it is not external:** §7.10 — two further routes
run the same inline snapshot without a demo gate. That is a scope decision, and
the fix is one call each.
