# Meta market-ready — runtime evidence and corrected status

Branch: `meta-market-ready`
Code HEAD: `6ab9d12d9` — every figure below was measured there unless §5 says
otherwise. This document is the only thing committed after it.
Date: 2026-08-26
Supersedes the revision written at `8f15c972a`.

---

## 1. What this pass built

The previous revision left four things open and called three of them product
decisions. They were not. Each names a behaviour the master plan and the
accepted design package already define, and each is built here.

| # | Was | Now |
|---|---|---|
| 1 | The Stop ceremony existed only in an archived presenter no route mounts | **Ported** — preflight, typed confirmation both directions, read-back-only success, on the body the route renders |
| 2 | Launchpad's first load: 18 reads, cause recorded as "unattributed" | **11** — every request named, seven folded into one composed route, and the debt ceiling deleted rather than lowered |
| 3 | Respond named an action and led to a sentence saying to go elsewhere | **Acts** — on a served `rec_id`, through the route that owns it, read back from `meta_decision_responses` |
| 4 | The mobile scope sheet stated eight facts and could change none | **Changes three** — by invoking the topbar's own controls, not by mounting a second picker |
| 5 | `app/dev-preview-share` swept into history a second time | **Untracked again**, forward-only; the rewrite stays approval-gated |

Thirteen commits since `b719400a3`. Excluding the recaptured evidence:
40 files changed, +4 702 / −715.

| Commit | Subject |
|---|---|
| `8645fcd42` | Record the clean-history plan, and why it waits for approval |
| `ab80dc1f9` | WP13: port the Meta Stop ceremony onto the body the route mounts |
| `f7d7057cc` | Untrack app/dev-preview-share again, which my own commit re-added |
| `48ca88902` | Record the recurrence in the history remediation plan |
| `c29372622` | WP14/17: name every Launchpad first-load request, and fold seven into one |
| `a47aff00c` | WP9: give the respond control a recommendation to act on |
| `5316b0c33` | Mobile: let the scope sheet change scope, through the topbar's own controls |
| `4a1a58b87` | Make the runtime evidence for WP9 and WP13 actually measure what it claims |
| `c15080921` | WP13: keep the refused Stop trigger reachable from the keyboard |
| `4460f87cb` | Recapture the 92 frames from the code this pass actually changed |
| `e39edab85` | Make the Automation fixture describe the payload the route actually returns |
| `0e5ea61b1` | Recapture the frames from the corrected Automation fixture |
| `6ab9d12d9` | Recapture the runtime screenshot set from this pass's build |

---

## 2. The defects this pass found and fixed

Every one was found by building the behaviour the design names, or by making a
test measure what it claimed to, and discovering what the existing code did
instead.

| # | Defect | Consequence |
|---|---|---|
| 1 | `resolveStopCeremony` required `admin` for BOTH directions; `/api/meta/automation` requires `collaborator` to engage and `admin` to release | The surface was stricter than the route: an operator the server would have accepted was shown the emergency stop as refused |
| 2 | The mounted Stop had no preflight and no read age | The confirmation was made against nothing, and a 200 was allowed to announce success — the design's H20 calls this a release preflight for a reason |
| 3 | The Launchpad first load's 18 reads were recorded with the cause "unattributed" | A recorded number with no cause is a ceiling nobody can lower; naming the requests took seven of them away |
| 4 | Seven Launchpad routes asked one question about one account at one instant | Each was a separate round trip on every load, and each 4xx'd independently when the account could not resolve, so the surface inferred one state from seven answers |
| 5 | `count(model.recommendations.length)` — `count()` takes an array | The Recommendations fact read "Not reported" on every load; a served three was reported as unknown |
| 6 | The respond control was enabled and had no subject | It named an action and answered a click with a sentence saying to record it somewhere else |
| 7 | With NO decision snapshot, the respond control stayed ENABLED with no targets | The wrapper reported itself available while the select was disabled — a control that looks usable and is not |
| 8 | The refused Stop trigger was `disabled` | A `disabled` button leaves the tab order, so the reason it refuses — the whole point of keeping it on screen — was out of keyboard reach. The zero-base responsive gate caught it |
| 9 | The Automation fixture put the SECTIONS shape under the `readCompleteness` key and served no `sections` | Anything reading a section's observation instant saw nothing, so the Stop ceremony was refused as `preflight_unavailable` on every frame and every interaction case. The bare `disabled` attribute had been hiding it from the harness's `aria-disabled` check |
| 10 | The scope sheet's three picker slots were never filled | A phone could read the scope and not move it, while `ScopePickers` and `ROW_PICKER` had been in place for both |
| 11 | `storedKillSwitch()` queried `meta_automation_business_control`; the table is `..._controls`, and a bare `catch { return null }` swallowed it | The test reported "the database holds nothing" for a row that existed — the exact failure mode that file exists to catch |
| 12 | The gate probe asserted the literal `release_gate_closed`; the guard answers the §9.1 code `automation_stop_disabled` | The gate was shut all along; the assertion was reading for a word the server never says |
| 13 | `git add -A` swept `app/dev-preview-share` into a commit for the second time | A user-owned file readable from nine commits instead of seven. Untracked again, forward-only |

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
| **WP6** Response/state contract | **PARTIAL** | One server-owned resolver; all seven §9 states proven; the notice's placement decided by whether a state ENDS | Query-plan, capacity, retention and growth evidence needs production read-only access |
| **WP7** Mutation safety foundation | **BLOCKED** | The contract is declared and `launchpad_create` conforms 18/18 | Needs a Meta sandbox account |
| **WP8** Decisions | **DONE (local)** | Six lanes including the server's `blocked` state; the level filter with URL round-trip; the inspector's close, provenance band and grain gaps; share-view, brief, Ads Manager, inactive-assets strip and the manual-action route; the seven transitions with the fields the server requires; the 409 dialog with keep-mine and take-server; two server refusals every sibling route already performed | Provider execution needs a sandbox |
| **WP9** Account Intelligence | **DONE (local)** | All nine plan sections composed; the two control sections gated on the server; respond acts on a SERVED `rec_id` and the row is read back from `meta_decision_responses` on the running server | — |
| **WP10** Creative Studio core | **DONE (local)** | Five tabs × four account postures; per-tab telemetry resolves to nine distinct names | — |
| **WP11** Briefs, Shares, Public Share | **DONE (local)** | The whole lifecycle on the LEGACY studio and the CANONICAL console; and a decision can now reach the brief flow at all | — |
| **WP12** History | **DONE (local)** | Nine families SUM to the journal; `writes` matches the action log row for row | — |
| **WP13** Automation | **PARTIAL** | The Stop ceremony on the MOUNTED body: a fresh persisted preflight with its age, typed confirmation in both directions, a POST that may never announce anything, success only from a server read-back, and engage → read-back → release → read-back in one session with the control table checked after each. `collaborator` engages, `admin` releases, matching the route | Provider-side reversibility needs a sandbox |
| **WP14** Launchpad read/draft/validate | **DONE (local)** | Create → edit → list → validate → delete, each read back from the table; and the first load is one composed read at the two authorization floors the seven routes actually have | — |
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
`playwright/artifacts/meta-runtime/meta-market-ready-0e5ea61b13/` — thirteen
surfaces x five widths x two themes, named for the code it was taken from. It is
not a regression baseline: nothing diffs against it, and the pixel oracles are
the zero-base visual and fidelity gates.

---

## 5. Validation

Run at `6ab9d12d9` unless noted. Results quoted, not summarised.

| Command | Result |
|---|---|
| `git diff --check` / `npm run test:whitespace` | **PASS** — working tree, index, and `843b6e9c8..HEAD` as a tree diff |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS** — 13 011 passed, 144 skipped, 63 todo (13 218) across 1 083 files, 0 failed |
| `npm run build` | **PASS** |
| `npm run meta:runtime-evidence` | **PASS** — 381 passed, 130 skipped, 0 failed (26.1 min), exit 0 |
| `META_RUNTIME_SCREENSHOT_SET=meta-market-ready-0e5ea61b13 …screenshots.spec.ts` | **PASS** — 131 passed (7.8 min); this is the 130 the sweep skips |
| `npm run meta:verify-mounted-bodies` | **PASS** — 15 surfaces |
| `npm run test:zero-base:reference` | **PASS** — 99/99 regions, 248/248 controls, 35/35 collections, 83/83 artboards |
| `npm run test:zero-base:fidelity` | **PASS** — 81/83 frames matching, with the 45 recorded paint-system findings on H19/H20 (was 46) |
| `npm run zero-base:reconcile:frames` | **PASS** — 92/92, 0 substitutions, captured at `e39edab850` |
| `npm run test:zero-base:a11y` | **PASS** |
| `npm run test:zero-base:responsive` | **PASS** — 84 checks |
| `npm run test:zero-base:visual` / `:theme` | **PASS** |
| `npm run test:zero-base:routes` / `:flows` / `:states` / `:locale` / `:contract` / `:design` / `:compatibility` | **PASS** |
| `npm run test:zero-base:smoke:local` | **PASS** — 4 checks against the local production server |
| `npm run test:zero-base:perf:local` | **PASS** — 5 checks; shared baseline 492.0 KB, above the 400 KB local investigation trigger, which is a diagnostic and not a plan gate |
| `npm run zero-base:contract:verify` | **PASS** — reports the package's own verdict as NOT READY |
| `npm run zero-base:contracts:check` / `:fonts:verify` / `zero-base:legibility` | **PASS** |
| `npm run test:local-db` | **NOT RUN** — refuses without the external volume at `/Volumes/adsecuteDB`; a hardware precondition, and `test:migrations-from-zero` covers the same class |

### 5.0 Launchpad's first load, named

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

### 5.1 The runtime sweep, by matrix

Every one of the 381 checks runs in a browser against the production standalone
build over HTTP with a real session.

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
| Account Intelligence | 10 |
| history | 7 |
| window | 7 |
| integrations · security · write gates | 5 each |
| Launchpad | 4 |

The 130 skipped are `meta-runtime-screenshots.spec.ts`, which refuses to run
without a caller-supplied set name; they are the separate 131-check row above.

Ten of the 381 are new this pass: eight for the Stop ceremony — the refusal
before it acts, the preflight's age, the gate's two halves, release ungated,
the typed confirmation suppressing the request, the engage → read-back →
release → read-back round trip against `meta_automation_business_controls`, and
no provider call — and two for respond, which seeds one recommendation, drives
the mounted control and reads the row back out of `meta_decision_responses`.

### 5.2 The Decisions repoint, measured

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
history rewritten. Every release gate still defaults off — `automationStopUi`
holds ENGAGE and never holds RELEASE, and the gates-open server exists only so
the difference between the two answers can be measured.

---

## 7. What remains, and the measurement behind each

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

### 7.4 Respond, closed

The control acts. `SectionControl` carries `targets` — the snapshot's own
`rec_id` values with the titles it wrote — the view offers the recommendation
before the action, and the client posts `/api/meta/recommendations/respond` with
a SERVED id. Proven end to end on the running server: the runtime spec seeds one
recommendation, drives the mounted control, and reads the row back out of
`meta_decision_responses` for that exact `rec_id`.

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
named in §5.0, the seven that asked one question are one composed route, and the
surface's `FIRST_LOAD_API_CALL_DEBT` entry is deleted rather than lowered. No
exception is claimed, because none is needed.

### 7.8 The history rewrite waits for approval

`app/dev-preview-share/page.tsx` is user-owned, untracked, and byte-unchanged
(md5 `319c80d401494da99f507a4e4bb87c61`). It is readable from nine commits in
LOCAL history because a broad `git add -A` swept it in twice — once at
`eee701160` and again at `ab80dc1f9`, one commit after the first repair.
`f7d7057cc` untracked it again, forward-only.

The branch has never been pushed: `git ls-remote --heads origin meta-market-ready`
returns nothing and there is no remote-tracking ref, both re-checked at
execution time by step 2 of the plan. Removing the blob means rewriting thirteen
commits including the HEAD every measurement here is stamped with, so it is a
decision about the project's history rather than a defect to fix quietly.
`docs/meta-market-ready/HISTORY_REMEDIATION_PLAN.md` records the exact
procedure, its verification steps and its preconditions. **Nothing in it has
been run.**

---

## 8. Externally blocked

| Blocker | Blocks | What is needed |
|---|---|---|
| No Meta sandbox account | WP7, WP15, WP13's provider-side reversibility, WP1's live-refusal confirmation | A physical Meta ad account that may receive PAUSED creates, named explicitly, with the scope it may be used at |
| No production read-only access | WP6 query plan / capacity / retention / growth | Explicit authorization and the exact business IDs that may be read |
| **Design package not re-vendored** | **WP16 §7.1 and §7.2** — 229 measured findings on Decisions, and the same class on Overview — plus the 45 recorded paint-system findings on H19/H20, REQ-27, REQ-28/M11 and REQ-41 | An export regenerated at a single fingerprint. The archive itself is not needed; the vendored bytes are hash-verified |
| No human assistive-technology pass | WP1, WP17 | A person with a screen reader confirming each disabled control's reason is announced. axe, the accessibility tree, focus order, dialog traps, live-region politeness and reduced motion are all checked; none is a substitute |
| No release authorization | WP18 | Explicit approval, per step |
| No approval for the history rewrite | §7.8 | An explicit instruction. The plan, its verification and its preconditions are written; nothing in it has been run |

None of these can be closed by writing code.
