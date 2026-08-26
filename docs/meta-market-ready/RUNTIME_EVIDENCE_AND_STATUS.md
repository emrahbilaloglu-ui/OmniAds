# Meta market-ready — runtime evidence and corrected status

Branch: `meta-market-ready`
Code HEAD: `8f15c972a` — every figure below was measured there unless §5 says
otherwise. This document and the recaptured evidence are the only things
committed after it.
Date: 2026-08-26
Supersedes the revision written at `bede81bd2`.

---

## 1. What this pass built

The previous revision closed six findings and left two "product decisions":
repointing the Decisions and Overview harnesses. That framing was wrong. The
missing pieces were product BEHAVIOUR, the master plan and the accepted design
package define it, and it is built now.

| # | Was | Now |
|---|---|---|
| 1 | No Needs Resolution lane | **Built** — the server's own `blocked` state, given a lane |
| 2 | No level filter | **Built** — and the `levels` link parameter is honoured for the first time |
| 3 | Inspector could not be closed | **Built** — `live:close`, focus returned to the row |
| 4 | No evidence-window / as-of statement | **Built** — two facts, drawn separately, plus the grain gaps |
| 5 | No share-view, brief, Ads Manager, ceremony trigger, stale-demoted | **Built** — all five, on existing safe contracts |
| 6 | The 409 was handled headlessly | **Built** — the conflict dialog, keep-mine and take-server |
| 7 | The seven workflow transitions, three of which could not work | **Built** — a real menu, and the fields the server requires |
| 8 | Every string a hardcoded English literal | **Built** — 76 catalogue keys, EN and TR, aria-labels included |
| 9 | Overview had none of its four capabilities | **Built** — readiness, connect, chart/table, divergence, mobile triage |
| 10 | The archived Decisions body in the harness allowlist | **Measured, and still there** — see §7.1 |
| 11 | The archived Overview body in the harness allowlist | **Measured, and still there** — see §7.2 |

Ten commits since `bede81bd2`; 43 source files, +6 168 / −346.

| Commit | Subject |
|---|---|
| `685d05d41` | Gate the whitespace that four green gates could not see |
| `d67f61c3c` | WP8: give the server's blocked decisions a lane of their own |
| `f8b998e6c` | WP8: give the queue the level filter its own links already promised |
| `0a35f137c` | WP8: say what the verdict was measured over, let the panel close, route the brief |
| `130485425` | WP8: the three queue controls the design names and the surface had none of |
| `eee701160` | WP8: render the 409, build the transition menu, and close two server gaps |
| `ffc46fc60` | WP8: give the decision a route into the manual action sheet |
| `97c9e181a` | WP8: put the Decision Center's own words through the copy catalogue |
| `428f6c950` | Overview: build the four capabilities the design names |
| `8f15c972a` | WP16: run the Decisions repoint, and record what it measured |

---

## 2. The defects this pass found and fixed

Every one was found by building the behaviour the design names and discovering
what the existing code did instead.

| # | Defect | Consequence |
|---|---|---|
| 1 | Trailing whitespace survived typecheck, lint, 12 887 Vitest checks and a 26-minute browser sweep | None of them looks at bytes nobody can see; `git diff --check` was wired to nothing |
| 2 | A `blocked` decision was drawn under "Action Now" | The lane that promises an action held decisions whose authority the engine had explicitly withheld — on Grandmix, most of the queue |
| 3 | `lane=test` links resolved to Action Now and were reported as unrestorable | It is the older contract's name for `blocked`; there was nowhere to put it, so the recipient saw a different set of rows |
| 4 | `levels=campaign` was reported as dropped | The surface had no level filter, so a link that promised "campaigns only" showed every ad set |
| 5 | Selecting Needs Resolution would have written `segment=structures` | A reload would have landed on Archive |
| 6 | The inspector had no close control | `inspectorOpen` is computed by the page and is unconditionally true on the Action lane |
| 7 | The inspector rendered with no selection | A workspace that had not resolved drew a full evidence column of em dashes beside an empty queue |
| 8 | `startDate`, `endDate` and `snapshotCreatedAt` reached no screen | A verdict with no window is unfalsifiable, and a snapshot time shown as a window is how a stale read passes for a current one |
| 9 | Nothing minted a brief link | `canCreateBrief` and the Briefs surface's URL lineage both existed; the flow was reachable only by hand-writing a URL |
| 10 | The 409 was invisible | The hook returned a structured conflict and the page voided it, so a refused transition changed the row on screen and said nothing |
| 11 | `assign` with no assignee is a no-op that still burns a `stateVersion` | Every other open tab then conflicts over a change that changed nothing |
| 12 | `reject` and `snooze` were fired with their required fields hard-coded null | Two of the seven offered transitions were guaranteed 422s |
| 13 | `dueAt: null` on every action | Null CLEARS a stored due date, so an unrelated acknowledge destroyed one |
| 14 | `POST /api/meta/decision-workflow` had no reviewer guard and no demo refusal | A reviewer holds a real membership and passed the role check; the screen was enforcing a rule the server did not |
| 15 | Two clicks sent two POSTs with the same `expectedVersion` | Once conflicts are rendered, the second reads as a phantom third-party edit of the operator's own making |
| 16 | The mobile screen drew five lanes | It would have hidden the blocked rows entirely once they left Action Now |
| 17 | Overview never asked `/api/integrations/status` | The readiness panel would have had to infer connectedness from whether a metric happened to be non-zero |
| 18 | Overview drew a chart with no way to read the numbers | `live:chart-table-toggle` contracts real `<table>` markup, announced, persisted per surface |
| 19 | Four marked controls were `<span>` or sized off the reference type scale | A marked control that is not a control cannot be reached by keyboard to read its own refusal; 11px is below this product's own floor |
| 20 | The workflow menu sat below the manual action | B02 draws it above |

And one trap worth recording, because it cost a green gate: adding
`MetaDecisionCenterExact.module.css` to the frame harness while the frames still
render the reference body **moved a control on H09**. The CSS-module stub leaves
class names unhashed, so a module appended to a frame that renders a different
body paints that body through generic names.

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
| **WP9** Account Intelligence | **DONE (local)** | All nine plan sections composed, the two control sections gated on the server with a §9.1 code | Respond acts on one recommendation and this section reports a count — see §7.4 |
| **WP10** Creative Studio core | **DONE (local)** | Five tabs × four account postures; per-tab telemetry resolves to nine distinct names | — |
| **WP11** Briefs, Shares, Public Share | **DONE (local)** | The whole lifecycle on the LEGACY studio and the CANONICAL console; and a decision can now reach the brief flow at all | — |
| **WP12** History | **DONE (local)** | Nine families SUM to the journal; `writes` matches the action log row for row | — |
| **WP13** Automation | **PARTIAL** | The Stop's round trip both directions; AUTO-03 records an autonomy mode per action kind | Provider-side reversibility needs a sandbox |
| **WP14** Launchpad read/draft/validate | **DONE (local)** | Create → edit → list → validate → delete, each read back from the table | — |
| **WP15** Launchpad execution | **BLOCKED** | The shipped refusal proven end to end | Needs a Meta sandbox account |
| **WP16** Harness, contracts, dead modules | **PARTIAL** | Anatomy 83/83; frames 92/92; the Automation harness renders the mounted body. The Decisions repoint was RUN: 83/83 anatomy with the mounted body, and 229 fidelity findings, all `untokenised-colour` | The two repoints wait on the design re-vendor — see §7.1 and §7.2 |
| **WP17** Telemetry, security, a11y, perf | **PARTIAL** | CLS within budget with an empty debt map; axe clean at 1440 light and 390 dark on thirteen surfaces; the Decision Center's own words in EN and TR | Manual AT pass |
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
two because the controls they open are new this pass and default off, which is
what a staged release means.

The saved responsive matrix is
`playwright/artifacts/meta-runtime/meta-market-ready-8f15c972a0/` — thirteen
surfaces x five widths x two themes, named for the code it was taken from. It is
not a regression baseline: nothing diffs against it, and the pixel oracles are
the zero-base visual and fidelity gates.

---

## 5. Validation

Run at `8f15c972a`. Results quoted, not summarised.

| Command | Result |
|---|---|
| `npm run test:whitespace` | **PASS** — working tree, index, and `843b6e9c8..HEAD` as a tree diff |
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS** — 12 951 passed, 144 skipped, 63 todo (13 158) across 1 079 files, 0 failed |
| `npm run build` | **PASS** |
| `npm run meta:runtime-evidence` | **PASS** — 372 passed, 130 skipped, 0 failed (26.0 min), exit 0 |
| `META_RUNTIME_SCREENSHOT_SET=… META_RUNTIME_SPEC_FILTER=…screenshots.spec.ts npm run meta:runtime-evidence` | **PASS** — 131 passed (7.8 min); this is the 130 the sweep skips |
| `npx vitest run lib/creative-decision-engine/__tests__/golden-cases.test.ts …/invariants.test.ts` | **PASS** — 74 passed, 52 todo |
| `npm run meta:verify-mounted-bodies` | **PASS** — 15 surfaces |
| `npm run test:zero-base:reference` | **PASS** — 99/99 regions, 248/248 controls, 35/35 collections, 83/83 artboards |
| `npm run test:zero-base:fidelity` | **PASS** — with the 46 recorded paint-system findings on H19/H20 |
| `npm run test:zero-base:frames` | **PASS** — 92/92, 0 substitutions |
| `npm run zero-base:reconcile:frames` | **PASS** |
| `npm run test:zero-base:a11y` | **PASS** — 85 checks |
| `npm run test:zero-base:responsive` | **PASS** — 84 checks |
| `npm run test:zero-base:visual` | **PASS** |
| `npm run test:zero-base:theme` | **PASS** — 84 checks |
| `npm run test:zero-base:routes` / `:flows` / `:states` / `:locale` / `:contract` / `:design` / `:compatibility` | **PASS** |
| `npm run zero-base:contract:verify` | **PASS** — reports the package's own verdict as NOT READY |
| `npm run zero-base:contracts:check` / `:fonts:verify` / `zero-base:legibility` | **PASS** |
| `npm run test:migrations-from-zero` | **PASS** |
| `npm run test:selection-race-seam` | **PASS** |
| `npm run test:release-gate-plan-seam` | **PASS** |
| `npm run test:operator-hardening` | **PASS** |
| `npm run test:local-db` | **NOT RUN** — refuses without the external volume at `/Volumes/adsecuteDB`; a hardware precondition, and `test:migrations-from-zero` covers the same class |

### 5.1 The runtime sweep, by matrix

Every one of the 372 checks runs in a browser against the production standalone
build over HTTP with a real session.

| Spec | Checks |
|---|---|
| a11y (axe, 13 surfaces x 2 postures) | 53 |
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
| Account Intelligence | 8 |
| history | 7 |
| window | 7 |
| integrations · security · write gates | 5 each |
| Launchpad | 4 |

The 130 skipped are `meta-runtime-screenshots.spec.ts`, which refuses to run
without a caller-supplied set name; they are the separate 131-check row above.

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

**Release and rollback.** Nothing merged, pushed, deployed or activated. Every
release gate still defaults off, including the two this pass gave controls to.

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

### 7.3 The archived-body ceiling is 2, not 0

Both entries remain, and both reasons in
`scripts/zero-base/harness-reachability.test.ts` are now measurements rather
than judgements. The ceiling may only fall, and it falls to zero on the day the
design package is re-vendored.

### 7.4 What respond can honestly do

`/api/meta/recommendations/respond` needs a `recId`, and the Recommendations
section reports how many are in scope rather than which. The control records the
action and says where to record it against a specific decision. Giving the
section a per-recommendation list is a design question about what belongs on
Account Intelligence versus Decision Center.

### 7.5 The scope sheet's pickers

The sheet states all eight facts; its rows carry no pickers. `ScopePickers`
treats an omitted handler as "this actor genuinely cannot do this" and draws
nothing rather than something disabled — and the console's real business,
account and window controls are in the topbar two inches above.

### 7.6 The archived Automation presenter

Still on disk, unreachable from any route and no longer reached by any release
evidence. It is the only implementation of the stop CEREMONY the design's H20
calls a "release preflight", and the mounted body has a direct engage/release
pair with none of it. Deleting it deletes the ceremony and the flow-I suite that
encodes its laws.

### 7.7 Launchpad's first-load read count

18, measured with no variance, against a ceiling recorded as a 16–17 band. No
Launchpad code was touched in this pass or the last, and neither could attribute
the extra read to a change it made. Recorded as what it measures, with the fact
that the cause is unattributed written down beside it.

---

## 8. Externally blocked

| Blocker | Blocks | What is needed |
|---|---|---|
| No Meta sandbox account | WP7, WP15, WP13's provider-side reversibility, WP1's live-refusal confirmation | A physical Meta ad account that may receive PAUSED creates, named explicitly, with the scope it may be used at |
| No production read-only access | WP6 query plan / capacity / retention / growth | Explicit authorization and the exact business IDs that may be read |
| **Design package not re-vendored** | **WP16 §7.1 and §7.2** — 229 measured findings on Decisions, and the same class on Overview — plus REQ-27, REQ-28/M11, REQ-41 | An export regenerated at a single fingerprint. The archive itself is not needed; the vendored bytes are hash-verified |
| No human assistive-technology pass | WP1, WP17 | A person with a screen reader confirming each disabled control's reason is announced. axe, the accessibility tree, focus order, dialog traps, live-region politeness and reduced motion are all checked; none is a substitute |
| No release authorization | WP18 | Explicit approval, per step |

None of these can be closed by writing code.
