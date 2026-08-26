# Meta market-ready — runtime evidence and corrected status

Branch: `meta-market-ready`
Date: 2026-08-26
Supersedes the revision written at `db50bea17`.

**Which commit each figure was measured at.** The previous revision said "Code
HEAD: db50bea17 — every figure below was measured there", and then reported a
rewrite-range count of 24 that was only true at `f06d923f3`; at `db50bea17` it
was 28. A status document cannot be measured at a commit that includes itself,
so this one names the measurement commit per class instead of claiming one HEAD
for everything:

| Class | Measured at |
|---|---|
| unit suite, typecheck, lint, whitespace, build, zero-base gates | `b964cd9b1` — the last code commit |
| runtime harness (388 checks) | `b964cd9b1` |
| frame evidence (92/92) | `b749db52f`, which is what the manifest records |
| screenshot set (131 checks) | `b749db52f` |
| the history-plan facts in §7.8 / §7.9 | re-measured at `daac86815` |

The commit that carries THIS document is later than all of them, and nothing
here claims to have measured it.

**Four classes, kept apart.**

- **Verified local facts** — §1–§5. A command produced the number, and the
  command is named.
- **Architecture gaps** — §6.1. Local, real, and NOT closed by this pass. They
  are not external and are not listed in §8.
- **External blockers** — §8. Nothing in this repository closes them.
- **Inferences** — said as inferences, in the sentence, wherever they appear.

---

## 1. What this pass built

An independent review found that the previous revision had left a safe local
security defect open in §7.10, that the new served-id boundary did not reject
the stale ids the document claimed it did, that Account Intelligence had no
physical-account lineage at all, and that the history plan was operationally
unsafe. All of it is closed here except one named architecture gap (§6.1).

| # | Was | Now |
|---|---|---|
| 1 | §7.10 left two routes with no demo gate, and the inventory had never been done | **14 boundaries closed**, each before its first durable side effect, and a contract test that walks the route tree |
| 2 | `getMetaWriteBlockState` assumed sound for the shared handlers | **Verified fail-closed** — and it needed an env var, because it stubs itself out under vitest |
| 3 | `respond` accepted any rec served in 30 days, while the control serves the LATEST snapshot | **Per-action authority**: current snapshot for acted/deferred/ignored, an active prior deferral for undeferred |
| 4 | Read-then-write, with a snapshot rotation possible between them | **One statement** — the authority is the INSERT's own `WHERE` |
| 5 | The snapshot could not say which provider account a recommendation was about | **`provider_account_id`**, populated at generation, withheld when unproven, never inferred from `scope_id` |
| 6 | The history plan hard-coded a count that changes with every commit, and proposed a rebase that would collide with the untracked user file | **Execution-time measurement**, a scratch-clone rewrite, a ref-scoped reflog expiry |

Seven commits since `cfc569258`. Excluding the recaptured evidence:
39 files changed, +2 455 / −325.

| Commit | Subject |
|---|---|
| `837f91949` | Complete the plan-wide demo mutation boundary, and make it machine-checked |
| `1e62c840c` | D6: give snapshot rows a physical account, and authorize responses per action |
| `b9949bdc2` | Prove the account boundary against a real database |
| `b964cd9b1` | Make the history plan safe to execute, and stop it going stale |
| `43f3575c8` | Update the Meta context snapshot, as INVARIANTS requires |
| `b749db52f` | Recapture the 92 frames from the audited tree |
| `daac86815` | Recapture the runtime screenshot set from the audited build |

Two ADRs were required by the project's own rules and were written BEFORE the
contract changed: `D-M009` (physical account lineage) and `D-M010` (per-action
response authority) in `docs/meta-decision-center/DECISION_LOG.md`, with
`CONTEXT_SNAPSHOT.md` updated as `INVARIANTS.md` demands.

---

## 2. The defects this pass found and fixed

| # | Defect | Consequence |
|---|---|---|
| 1 | `campaign-labels` PUT had no demo gate | Main/Test/Mixed labels are a precondition for hard-action semantics, and the route then runs the engine inline |
| 2 | `business-commercial-settings` PUT/POST had no demo gate | The commercial truth snapshot carries the hard-action anchors; its only demo check fired for the reviewer email on one hard-coded id, so a demo ADMIN passed it |
| 3 | `decision-workflow` used `isDemoBusiness(...).catch(() => false)` over a function that already swallows errors into `false` | Two fail-open steps, against the BODY's business id |
| 4 | `launchpad-handoff` POST lacked the boundary its own `/copy` sibling has | A handoff persists an `authorizedAction`; INVARIANTS gives a demo workspace null authorized action |
| 5 | `creative-briefs` POST and PATCH were reviewer-only | A brief is the record that a decision authorized creative work |
| 6 | `creatives/share` POST, DELETE and rotate/delete were reviewer-only | WP11's acceptance names reviewer AND demo. A share token leaves the workspace and outlives the conversation |
| 7 | `decision-action/preflight` (both handlers) was ungated | It issues a receipt and a dispatch descriptor and writes an instrumentation row — an action-authorizing artifact, not a browse |
| 8 | `launchpad/meta/validate` was ungated | It answers "is this launch cleared" with billing status and the pixel list. A demo workspace has false execution eligibility |
| 9 | `runMetaDecisionIgnoredMarker` had no business filter at all | A cron sweep stamping `ignored` across every business in the database, read back later as operator evidence |
| 10 | `appendCreativeShareMessage` appended for any live token | A durable row in a demo workspace's ledger, from a deliberately unauthenticated endpoint |
| 11 | `readServedMetaRecommendation` accepted any rec served in 30 days | The mounted control serves the LATEST snapshot only, so an id served yesterday and absent today passed a check the screen would never have offered — and the previous status document said stale ids were rejected |
| 12 | `undeferred` was authorized by "any served rec in the window" | An arbitrary 30-day-old id is not undefer authority |
| 13 | The route read, then wrote, in two statements | `upsertSnapshotRows` DELETEs and re-inserts a day's rows, so a rotation between them could produce a row the check would refuse |
| 14 | `meta_decision_snapshots_daily` had no provider-account column | An account-scoped surface served another account's recommendations under this account's heading, and the respond control acted on them |
| 15 | The history plan hard-coded "24 commits" | True at `f06d923f3`, 28 at `db50bea17` where the status document repeated it, 32 by the time it was re-read |
| 16 | The plan's rebase fallback would have run in this working copy | `eee701160` and `ab80dc1f9` both ADD the untracked user path, so checkout is refused mid-rewrite — or overwrites the file |
| 17 | Phase B ran `git reflog expire --all` | Four branch reflogs exist; three are unrelated to this remediation and would have lost their recovery history |

### 2.1 What was verified SOUND and deliberately left alone

Recorded because "add a gate everywhere" would have been the wrong fix.

**The shared write-block path is fail-closed.** The ad / campaign / ad-set
action routes are three-line wrappers that delegate to
`lib/meta/ads-action-routes.ts` and `lib/meta/entity-action-routes.ts`, which
reach `getMetaWriteBlockState`. It refuses a confirmed demo business, a missing
business row, and an unreadable control state, and the well-known demo id is
refused before any read at all. Adding gates to those wrappers would have been a
redundant second authority over one fact.

Proving it required `META_AUTOMATION_WRITE_GUARD_TEST_READS=1`: the guard
short-circuits to "not blocked" under vitest, so **every other test in this
repository has been running against a stub of it**. That is now pinned by a case
of its own, so the short-circuit cannot become unconditional unnoticed.

### 2.2 What the review asked for that the schema does NOT support

**A `triage:` namespace exemption was NOT added.** The concern is real — triage
rec ids never appear in a snapshot — but `lib/triage-events.ts` writes to
`meta_decision_responses` directly and never through this route. The only caller
of `/api/meta/recommendations/respond` is the Intelligence controls client. An
exemption would have been a hole with no traffic through it.

**Account scope for account-LEVEL recommendations is still not expressible.**
See §6.1. It is an architecture gap, not an external blocker.

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
| **WP7** Mutation safety foundation | **BLOCKED** | The contract is declared and `launchpad_create` conforms 18/18. Demo write authority is enforced at every Meta mutation boundary — 14 direct, 12 through the verified shared handler, 1 in the store — all reading one flag through one function, and machine-checked so a new one cannot land without it | Needs a Meta sandbox account |
| **WP8** Decisions | **DONE (local)** | Six lanes including the server's `blocked` state; the level filter with URL round-trip; the inspector's close, provenance band and grain gaps; share-view, brief, Ads Manager, inactive-assets strip and the manual-action route; the seven transitions with the fields the server requires; the 409 dialog with keep-mine and take-server; two server refusals every sibling route already performed | Provider execution needs a sandbox |
| **WP9** Account Intelligence | **PARTIAL** | All nine plan sections composed. Both control sections gated on the SERVER at three floors — role, reviewer, demo — with the demo half fail-closed. Respond acts on a `rec_id` the server verifies per action, scoped to the physical account, in the same statement that writes it; account isolation, colliding ids, stale ids and unproven lineage are all refused against the real database | **Not DONE**: account-LEVEL recommendations for a multi-account business still carry no physical account, so they are withheld rather than attributed — see §6.1 |
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
`playwright/artifacts/meta-runtime/meta-market-ready-b749db52fb/` — thirteen
surfaces x five widths x two themes, named for the code it was taken from. It is
not a regression baseline: nothing diffs against it, and the pixel oracles are
the zero-base visual and fidelity gates.

---

## 5. Validation

Measured at `b964cd9b1` — the last code commit — unless a row says otherwise.
Results quoted, not summarised.

| Command | Result |
|---|---|
| `git diff --check` / `npm run test:whitespace` | **PASS** — working tree, index, and `843b6e9c8..HEAD` as a tree diff |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS** — 13 195 passed, 144 skipped, 63 todo (13 402) across 1 087 files, 0 failed |
| `npm run build` | **PASS** |
| `npm run meta:runtime-evidence` | **PASS** — 388 passed, 130 skipped, 0 failed (26.1 min), exit 0 |
| `META_RUNTIME_SPEC_FILTER=meta-runtime-intelligence …` | **PASS** — 18 passed, including the five new D6 account cases |
| `npm run test:migrations-from-zero` | **PASS** — the new column builds from zero and the migrations stay idempotent |
| `npm run test:schema-upgrade-seam` | **PASS** — P1/P2/P3 |
| `META_RUNTIME_SCREENSHOT_SET=meta-market-ready-b749db52fb …` | **PASS** — 131 passed (7.7 min), at `b749db52f` |
| `npm run meta:verify-mounted-bodies` | **PASS** — 15 surfaces |
| `npm run test:zero-base:reference` | **PASS** — 99/99 regions, 248/248 controls, 35/35 collections, 83/83 artboards |
| `npm run test:zero-base:fidelity` | **PASS** — 81/83 frames matching, with the 45 recorded paint-system findings on H19/H20. **Unchanged by this pass** |
| `npm run zero-base:reconcile:frames` | **PASS** — 92/92, 0 substitutions, recaptured at `43f3575c83` |
| `npm run test:zero-base:a11y` / `:responsive` / `:visual` / `:theme` | **PASS** |
| `npm run test:zero-base:routes` / `:flows` / `:states` / `:locale` / `:contract` / `:design` / `:compatibility` | **PASS** |
| `npm run test:local-db` | **NOT RUN** — refuses without the external volume at `/Volumes/adsecuteDB`; a hardware precondition, and `test:migrations-from-zero` covers the same class |

### 5.0 The write-boundary inventory, by classification

Every route under `app/api/meta/**`, `app/api/launchpad/meta/**`,
`app/api/creatives/share/**` and `app/api/business-commercial-settings` that
exports POST, PUT, PATCH or DELETE, enumerated by
`app/api/meta-demo-write-authority.contract.test.ts` walking the filesystem —
not by grep, and not by a hand-maintained list.

| Classification | Count | Demo authority |
|---|---|---|
| (c) provider mutation | 12 | Delegated to `getMetaWriteBlockState` through the shared handlers, verified fail-closed (§2.1) |
| (b) durable local mutation or action-authorizing artifact | 21 | Direct fail-closed guard before the first side effect |
| (b) enforced in the store | 1 | `creatives/share/[token]/messages` — unauthenticated by design, so the refusal is a predicate on the UPDATE |
| (a) no side effect | 2 | Exempt, with a reason, and re-checked: a listed route that starts writing FAILS |

The contract runs 97 checks. It also asserts the negative: naming
`isDemoBusiness` or `isDemoBusinessId` in a Meta route is a failure, not a pass.

**What the contract cannot see is ORDER.** That the refusal precedes the first
durable write is behavioural, and is asserted per route in the colocated tests —
zero store calls, zero telemetry, zero cooldown stamps, zero token
mint/rotate/revoke/delete, and zero provider calls, for BOTH a confirmed demo
workspace and an unreadable flag.

### 5.1 The new regressions

| Area | Cases | Where |
|---|---|---|
| Demo authority, per route | confirmed demo → 403 with nothing written; `unverified` and `not_established` → 503 with nothing written; the flag read for the SERVER's business, not the body's | the colocated `route.test.ts` of each of the 14 boundaries |
| Demo authority, structural | 97 checks: every Meta mutator reaches a fail-closed authority; no Meta route names a fail-open instrument; exemptions carry a reason and are re-checked | `app/api/meta-demo-write-authority.contract.test.ts` |
| The shared handler | live passes; confirmed demo blocks; an unreadable control state blocks; a missing business row blocks; the canonical demo id blocks without reading; and the vitest short-circuit is pinned | `lib/meta/write-block-demo-authority.test.ts` |
| Freshness, per action | acted/deferred/ignored served in the current snapshot and REFUSED from an older one; refused with no account; undeferred served on an active deferral, refused with none; the SQL asks for the latest response and excludes an expired deferral | `lib/meta/served-recommendation.test.ts` |
| Account scope, unit | the predicate names `provider_account_id` and NOT `scope_id` | same file |
| Identity at the boundary | invented id → 404 nothing written; unreadable source → 503 nothing written, not 404; the atomic writer is called with the server's business and the account | `app/api/meta/recommendations/respond/route.test.ts` |
| Account isolation, runtime | another account's rec refused; the SAME id under two accounts stays separated; an OLDER snapshot's id refused while the current one is accepted; unproven lineage withheld; no-account refused | `playwright/tests/meta-runtime-intelligence.spec.ts` |
| Migration | the column builds from zero, migrations stay idempotent, and the upgrade seam passes | `test:migrations-from-zero`, `test:schema-upgrade-seam` |

**The stale-within-window case the review named** is covered twice: at the unit
level (an id present only in an older snapshot is `not_served` for all three
current-snapshot actions) and against the real database (an older-snapshot id is
refused 404 while a current-snapshot id is accepted 200, so the refusal is about
staleness rather than about the seeding being wrong).

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

Every one of the 388 checks runs in a browser against the production standalone
build over HTTP with a real session. This pass added five — another account's
recommendation refused, the same id under two accounts kept separate, an older
snapshot's id refused while the current one is accepted, unproven lineage
withheld, and a response with no account refused — which is why Account
Intelligence is 17 rather than 12.

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
| Account Intelligence | 17 |
| history | 7 |
| window | 7 |
| integrations · security · write gates | 5 each |
| Launchpad | 4 |

The 130 skipped are `meta-runtime-screenshots.spec.ts`, which refuses to run
without a caller-supplied set name; they are the separate 131-check row above.

Ten of the 388 were added by an earlier pass: eight for the Stop ceremony — the refusal
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

## 6. Architecture gaps — local, real, and NOT closed

Neither of these is external. Nothing in §8 covers them, and neither is waiting
on anyone outside this repository. They are recorded here so that "PARTIAL" in
§3 has a specific meaning.

### 6.1 An account-level recommendation for a multi-account business has no account

`provider_account_id` is populated from the campaign and ad-set rows the engine
already reads, so campaign-scoped and ad-set-scoped recommendations carry a
physical account. Account-LEVEL recommendations do not, unless the business has
exactly one assigned account — in which case "this business" and "this account"
are the same fact and the row carries it.

The cause is structural: `runMetaSnapshotForBusiness(businessId, snapshotDate)`
aggregates across every assigned account, so an account-level recommendation is
genuinely about all of them. There is no column to add that fixes this; the
engine would have to run per account.

**What this pass did instead of pretending otherwise.** Those rows stay NULL and
are WITHHELD from an account-scoped read. The surface shows fewer
recommendations rather than one account's decisions under another's heading, and
the respond boundary refuses them. That is the fail-closed direction, and it is
why WP9 is PARTIAL rather than DONE.

Closing it is a Phase H change to the engine — per-account snapshot generation —
and `D-M009` records it as deferred with that reasoning rather than as a
limitation of the data.

### 6.2 Two demo instruments remain in the codebase

`lib/business-mode.server.isDemoBusiness` and `lib/demo-business.isDemoBusinessId`
both answer "not a demo workspace" when they cannot tell. Neither is used by any
Meta write boundary any more, and the contract test FAILS if one appears in a
Meta route. They are still used elsewhere — presentation paths, where a
fail-open read is survivable — and were not swept, because rewriting every
caller is a wider change than this review asked for.

The risk is contained by the contract test rather than removed.

## 6.3 Evidence by class

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

**Corrected.** The previous revision said this was closed and that stale ids
were rejected. They were not: the check accepted any rec served in the last 30
days, while the mounted control serves the LATEST snapshot only. The authority
is per-action now (§2, rows 11–13), scoped to the physical account, and applied
in the same statement that writes.

**What the revision before that closed was the AFFORDANCE. The one after closed
the BOUNDARY. This one made the boundary correct.** The control acting on a served id was the surface doing the right
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

### 7.10 The plan-wide write boundary, closed

The two routes this entry named — `campaign-labels` and
`business-commercial-settings` — are gated, and so are twelve more that the
inventory found once it was done properly rather than by grep. The full
classification is §5.0; the enforcement is machine-checked; the shared-handler
path was verified sound and deliberately left alone.

This entry is retained rather than deleted because the previous revision used it
to record a decision — "the instruction named two routes, so widening the change
would stop this being a review" — and that decision was wrong in a way worth
keeping visible. A security boundary that is known to be missing elsewhere is
not made safer by being documented. The correct move was to do the inventory and
close all of it, which is what this pass did.

### 7.11 The two demo instruments have not been swept from the codebase

Open, local, and NOT closed. `lib/business-mode.server.isDemoBusiness` and
`lib/demo-business.isDemoBusinessId` still exist and are still used on
presentation paths, where answering "not demo" for an unreadable flag is
survivable. No Meta write boundary uses either, and the contract test fails if
one appears in a Meta route — see §6.2. Rewriting every remaining caller is a
wider change than this review asked for and is recorded rather than done.

### 7.12 The history plan is executable, and still unexecuted

Three operational defects were repaired (§2, rows 15–17): a hard-coded commit
count that self-invalidates, a rebase that would have collided with the
untracked user file in this working copy, and a `git reflog expire --all` that
would have destroyed three unrelated branches' recovery history.

Phase A now rewrites in a scratch clone and returns the result as an object,
with `git diff --stat` between the old and new branch as the gate. Phase B's
expiry is ref-scoped and its verification is skipped — with the outcome recorded
honestly — if B0 keeps a Codex ref that still holds the blob.

**Nothing in the plan has been run.** What was run, and only this: two
read-only `git ls-remote` queries, one `git clone --no-checkout` to a scratch
path that was then removed, and one `git reflog expire --dry-run` against a
single named ref. After all three the user file was unchanged in bytes, mtime
and index state.

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

**Not on this list, because they are not external:** §6.1 (account-level
recommendations carry no physical account — a Phase H engine change), §6.2 /
§7.11 (the two fail-open demo instruments still used on presentation paths), and
§7.12 (the history plan, which waits for an instruction rather than for anyone
outside this repository). Turning a local schema or authority gap into an
"external blocker" is how a gap stops being worked on.
