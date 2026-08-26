# Meta market-ready — runtime evidence and corrected status

Branch: `meta-market-ready`
Code HEAD: `3cdfc19e2` — every figure below was measured there unless §5 marks
otherwise. This document is the only thing committed after it.
Date: 2026-08-26
Supersedes the revision written at `65b68c49f`.

---

## 1. What this pass closed

The previous revision ended with six findings recorded as "defects, not
tolerances". Four are closed outright, one is closed for the surface it could be
closed for, and one is closed as far as the design contract allows. What is left
is stated in §7 with the evidence that makes it a decision rather than a
difficulty.

| # | Finding | Now |
|---|---|---|
| 1 | `creative-studio` CLS 0.1042 vs 0.100 | **CLOSED** — 0.010, `CLS_DEBT` empty, budget untouched |
| 2 | The canonical console cannot mint a share | **CLOSED** — mints from a ticked selection, full lifecycle proven on the mounted route |
| 3 | Two of WP9's nine sections do not exist | **CLOSED** — both composed, gated on the server |
| 4 | `gated:AUTO-03 mode` names a control nobody built | **CLOSED** — built, and the harness repointed at the mounted body |
| 5 | Three archived bodies rendered by the harness | **PARTLY** — Automation repointed, ceiling 3→2; the other two are §7 |
| 6 | The mounted shell is not the zero-base shell | **PARTLY** — skip link, drawer and scope sheet ported; the rest is §7 |

Ten commits, plus the one that records this. Against `2ec3e1f1a`: 44 source
files, +3 592 / −507, and 186 evidence files.

| Commit | Item | Subject |
|---|---|---|
| `dc8c339dc` | 1 | Stop the §9 notice moving the page, and close the CLS defect without an exemption |
| `f51fbede6` | 2 | Let the canonical console mint a share, and fix the audience value that made it impossible anyway |
| `1dff3d396` | 4, 5 | Build the AUTO-03 mode control, and point the Automation harness at the body the route mounts |
| `bcdcde93c` | 3 | Compose the two WP9 sections that never existed, and gate them on the server |
| `c512394a2` | — | Keep the two gates the §9 notice and the new sections moved |
| `fbbe08944` | 6 | Make the mounted console's mobile navigation an actual drawer |
| `944573b87` | 3 | Draw the two new Intelligence sections in the artboard that grades them |
| `4c6b62de2` | — | Resolve the window spec's presets on the clock the product uses |
| `113177f9d` | 6 | Give the mounted console the scope sheet the design draws |
| `3cdfc19e2` | 5 | Say what the two remaining archived bodies would actually cost |

---

## 2. The defects this pass found and fixed

Every one was found by pointing a gate at the thing it claimed to measure.

| # | Defect | Consequence |
|---|---|---|
| 1 | The §9 read-state notice was a 52 px card in flow while `loading` and 0 px once served | Every Meta surface moved its whole content column the moment data landed; Creative Studio's column was tall enough to cross the CLS budget |
| 2 | The canonical Shares ledger sent `audience: "creator"` | In none of `SHARE_AUDIENCES`; every mint it could have issued was a 400 before the store was reached |
| 3 | The same ledger sent `creatives: []` | The route requires at least one, so the screen disabled its own control and the canonical console could not produce a share at all |
| 4 | The autonomy ladder drew three of the server's four decision types | A `bid` mode could be recorded by the control plane and appear nowhere on the screen that claims to show every action kind |
| 5 | `data-collection="h19-guardrails"` | `collectionKind` strips the artboard prefix before comparing, so the marker the gate looks for was one the body never carried |
| 6 | `data-el` and `data-collection` on the same element | The reference nests the collection inside the region; the fidelity gate calls that `wrong-owner` |
| 7 | The shell harness sliced `globals.css` from line 9878 | The whole `.adv-*` layer that paints the mounted console lives at 7893, so a mounted body rendered with no styling and axe reported contrast failures the surface does not have |
| 8 | Two of WP9's nine sections were not composed | The respond control the plan asks to gate had nothing to gate; run-now's refusal was written in a route file |
| 9 | The respond control offered `acknowledged \| acted \| dismissed` | The route accepts `acted \| deferred \| undeferred \| ignored`; two of the three would have been rejected |
| 10 | No §9.1 code for a role refusal | A guest who is neither reviewer nor demo was told they were a reviewer, or told nothing |
| 11 | The mounted console's closed mobile drawer stayed in the tab order | A keyboard user on a phone tabbed the whole rail — invisible — before reaching the page, on every navigation |
| 12 | That drawer was not a dialog | Tab walked onto the page behind it; closing left focus on `<body>` |
| 13 | Nothing stated currency proof, timezone proof or freshness at narrow widths | The facts that decide whether a figure can be trusted had no representation on a phone |

And three defects in the gates themselves, each of which had made a real defect
invisible:

- **The CLS instrument changed the number it measured.** Reading
  `getBoundingClientRect` inside the layout-shift callback forces synchronous
  layout: the same page reported 0.104 without the probe and 0.031 with it.
- **A `textContent()` in a Playwright assertion message auto-waits**, and
  message arguments are evaluated eagerly — so a diagnostic written for the
  empty case blocked its own test until the budget ran out.
- **Reading a response body from a test races the page's read of it.** Under
  load the note composer's `await response.json()` never settled, so a working
  endpoint looked like a note that would not appear.

---

## 3. Status by work package

| WP | Status | What holds | What is missing |
|---|---|---|---|
| **WP0** Baseline & authority | **DONE** | Exact HEAD and source hash; ADRs Accepted; the untracked Share work untouched | — |
| **WP1** Interim posture | **PARTIAL** | No provider write; execution refused on the running server; Automation states the Meta-only scope of its stop at every width | Manual assistive-technology confirmation |
| **WP2** Surface registry & nav | **DONE** | 37 runtime checks: every canonical route, `/app` twin and legacy spelling, compared on body identity | — |
| **WP3** Integrations & assignment | **PARTIAL** | A refused connection reads "Action required" and stops claiming freshness; duplicate spellings resolve to the catalog's form | A genuinely revoked Meta credential needs Meta to refuse one. Production read-only schema evidence |
| **WP4** Shell, account authority, rollout | **DONE (local)** | 38 checks across `off` / `allowlist`-in / `allowlist`-out / `on`; authorization runs before the rollout decision; an unset mode fails preflight | — |
| **WP5** Window, as-of, freshness | **DONE** | URL → request → caption as one equality, on the workspace's own clock | — |
| **WP6** Response/state contract | **PARTIAL** | One server-owned resolver; all seven §9 states proven; the notice's placement is now decided by whether a state ENDS | Query-plan, capacity, retention and growth evidence needs production read-only access |
| **WP7** Mutation safety foundation | **BLOCKED** | The contract is declared and `launchpad_create` conforms 18/18 | Needs a Meta sandbox account |
| **WP8** Decisions | **DONE (local)** | Four transitions with a durable SELECT after each, and a stale `expectedVersion` losing with a 409 | The 409 has no UI — see §7.2 |
| **WP9** Account Intelligence | **DONE (local)** | All nine plan sections composed. The two control sections carry a server-authored role/capability gate with a §9.1 code, reachable per section for the first time. The matrix is proven three ways: the mapping deterministically, the gate in the composer's tests, the laws and the controls on the mounted route | Respond acts on one recommendation and this section reports a count — see §7.5 |
| **WP10** Creative Studio core | **DONE (local)** | Five tabs × four account postures; per-tab telemetry resolves to nine distinct names | — |
| **WP11** Briefs, Shares, Public Share | **DONE (local)** | The whole lifecycle on the LEGACY studio and, now, on the CANONICAL console: ticked selection → stored row → public open → tier privacy → withdrawal, plus the shipped-gate refusal | — |
| **WP12** History | **DONE (local)** | Nine families SUM to the journal; `writes` matches the action log row for row | — |
| **WP13** Automation | **PARTIAL** | The Stop's full round trip both directions; and AUTO-03 records an autonomy mode per action kind, refusing locally before the wire and announcing off the read-back | Provider-side reversibility needs a sandbox |
| **WP14** Launchpad read/draft/validate | **DONE (local)** | Create → edit → list → validate → delete, each read back from the table | — |
| **WP15** Launchpad execution | **BLOCKED** | The shipped refusal proven end to end | Needs a Meta sandbox account |
| **WP16** Harness, contracts, dead modules | **PARTIAL** | Anatomy 83/83 with no exemption; frames 92/92; the Automation harness renders the body the route mounts and the archived-body ceiling is 2. Fidelity now measures the mounted Automation body and reports where it diverges rather than reporting 83/83 about a copy | Decisions and Overview — see §7.1 and §7.3 |
| **WP17** Telemetry, security, a11y, perf | **PARTIAL** | CLS within budget on every surface with an empty debt map; skip link, palette focus trap, mobile drawer and scope sheet on the shell every route renders; axe clean at 1440 light and 390 dark on thirteen surfaces, with offending selectors named on failure | Manual AT pass |
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

`META_LAUNCHPAD_EXECUTION` and `META_AUTOMATION_LIVE_WRITES` are opened
**nowhere**: their next step is a call to Meta.

The saved responsive matrix — thirteen surfaces × five widths × two themes — is
`playwright/artifacts/meta-runtime/meta-market-ready-3cdfc19e21/`, named for the
code it was taken from. It replaces the `e643f68a89` set, which was captured
before the §9 notice moved out of the layout and before the drawer and the scope
sheet existed, and every one of its 130 files therefore showed code that is no
longer what runs. It is not a regression baseline: nothing diffs against it, and
the pixel oracles are the zero-base visual and fidelity gates.

---

## 5. Validation

Run at `3cdfc19e2` unless a row says otherwise. Results quoted, not summarised.
`3cdfc19e2` changes two string literals in one Vitest file and the name of an
artifact directory; it touches no code any route, API or harness renders, which
is why the 26-minute browser sweep is reported at the code HEAD before it.

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS** — 12 887 passed, 144 skipped, 63 todo (13 094) across 1 073 files, 0 failed |
| `npm run build` | **PASS** |
| `npm run meta:runtime-evidence` | **PASS** at `113177f9d` — 372 passed, 130 skipped, 0 failed (26.2 min). The 130 are `meta-runtime-screenshots.spec.ts`, which refuses to run without a caller-supplied set name; captured in its own row below |
| `META_RUNTIME_SCREENSHOT_SET=meta-market-ready-3cdfc19e21 META_RUNTIME_SPEC_FILTER=playwright/tests/meta-runtime-screenshots.spec.ts npm run meta:runtime-evidence` | **PASS** — 131 passed (7.8 min). All 130 files differ from the superseded `e643f68a89` set, which was captured before the notice placement, the drawer and the scope sheet existed |
| `npm run test:migrations-from-zero` | **PASS** |
| `npm run test:selection-race-seam` | **PASS** |
| `npm run test:release-gate-plan-seam` | **PASS** |
| `npm run test:operator-hardening` | **PASS** |
| `npm run meta:verify-mounted-bodies` | **PASS** |
| `npm run test:zero-base:reference` | **PASS** — 99/99 regions, 248/248 controls, 35/35 collections, 83/83 artboards |
| `npm run test:zero-base:fidelity` | **PASS** — with 46 recorded paint-system findings on H19/H20, see §7.4 |
| `npm run test:zero-base:frames` | **PASS** — 92/92, 0 substitutions |
| `npm run zero-base:reconcile:frames` | **PASS** |
| `npm run test:zero-base:a11y` | **PASS** — 85 checks |
| `npm run test:zero-base:responsive` | **PASS** — 84 checks |
| `npm run test:zero-base:visual` | **PASS** |
| `npm run test:zero-base:theme` | **PASS** |
| `npm run test:zero-base:flows` | **PASS** |
| `npm run test:zero-base:states` | **PASS** |
| `npm run test:zero-base:routes` | **PASS** |
| `npm run test:zero-base:locale` | **PASS** — zero unexplained inline operator copy |
| `npm run test:zero-base:compatibility` | **PASS** |
| `npm run test:zero-base:contract` | **PASS** |
| `npm run test:zero-base:design` | **PASS** |
| `npm run zero-base:contract:verify` | **PASS** — reports the package's own verdict as NOT READY |
| `npm run zero-base:contracts:check` | **PASS** |
| `npm run zero-base:fonts:verify` | **PASS** |
| `npm run zero-base:legibility` | **PASS** |
| `npm run test:local-db` | **NOT RUN** — refuses without the external volume at `/Volumes/adsecuteDB`; a hardware precondition, and `test:migrations-from-zero` covers the same class |

### 5.1 CLS, before and after

Every mounted surface, measured with an instrument that no longer perturbs what
it measures:

```
meta-decisions      0.013 → 0.036    creative-copies         0.062 → 0.062
meta-intelligence   0.000 → 0.000    creative-landing-pages  0.011 → 0.011
creative-studio     0.104 → 0.010    creative-inbox          0.000 → 0.000
meta-launchpad      0.026 → 0.000    creative-audiences      0.004 → 0.004
meta-automation     0.000 → 0.000    creative-briefs         0.000 → 0.000
meta-history        0.000 → 0.000    creative-shares         0.000 → 0.000
                                     manage-integrations     0.037 → 0.037
```

Decisions moved the wrong way, from 0.013 to 0.036, and the reason is worth
stating rather than burying: its in-flow `loading` card used to reserve most of
the space its `partial` card would need, so settling only cost 10 px. It pays
the honest 74 px once now, when a persistent notice arrives above the content it
qualifies. Well inside the budget, and the common path — a surface that settles
to `success` — went from 52 px of movement to none.

---

## 6. Evidence by class

**Mounted route / browser.** Playwright against the production standalone build
over HTTP with a real session, across five servers differing only in rollout
mode and release-gate environment.

**Database.** A real PostgreSQL 16 cluster with the repo's real migrations. Every
"it worked" claim is a `SELECT`, not a reading of a response body.

**Deterministic composition.** Where a state cannot be injected into a live page
— WP9's per-section matrix, and its role/capability gate — the composer is
driven directly, and the reason that is the right instrument is stated in the
file rather than glossed.

**Provider.** None. No Meta call was made by anything in this session.

**Release and rollback.** Nothing merged, pushed, deployed or activated. Every
release gate still defaults off.

---

## 7. What remains, and why each one is a decision rather than a difficulty

Every item below was attempted or specified in detail, and each stops at a point
where continuing would mean deciding what the product IS. None of them stops at
"this would be hard".

### 7.1 The Decisions harness repoint

`MetaDecisionCenterExact` — the body every Decisions route mounts — carries zero
design-contract markers today, and nine of the ones H09–H12 require have no
element to attach to, because the mounted Decision Center is a different product
from the one the design draws:

- Its lanes are `action | watching | healthy | nonsales | archive`. There is no
  **Needs Resolution** lane, so no `blocker-chip` and no `needsres` collection.
- It filters by **scope** (`structure | creatives`), not by **level**. There is
  no `live:META-DEC-02 level`.
- Its inspector is an inline grid column with no close control, so no
  `live:close` and no `evidence-window` statement.
- It has no share-view control, no brief control, no Ads Manager open, no
  mutation-ceremony trigger, and no `stale-demoted` marker.
- H12's `conflict-dialog` with keep/reapply is a **feature to build**:
  `use-decision-workflow.ts` handles a 409 and sets `lastMessage`, and
  `MetaPlatformPage` never reads it — so on a version conflict an operator sees
  the row's state change silently and gets no statement, no keep and no reapply.
- Every string in the file is a hardcoded English literal with no `useCopy`, so
  the Turkish artboards P06/P07 cannot render from it at all.

Attaching markers to elements that do not exist would be stamping the contract.
Building the lane, the level filter, the conflict dialog and the rest is a
decision about what the Decision Center should be, which the master plan does
not make.

### 7.2 The 409 an operator never sees

Separable from 7.1 and worth naming on its own: the decision-workflow conflict
path is real, tested, and headless. The message exists and nothing renders it.

### 7.3 The Overview harness repoint

H03/H04/B01 require `data-el="source-readiness"` with `data-collection="sources"`,
`live:INTEGRATION-03 connect`, `live:chart-table-toggle`,
`live:ECON-04 divergence-link` and `live:MOBILE-01`. The mounted Overview has no
source-health panel, no chart/table toggle, no break-even divergence link and no
mobile triage entry anywhere in it. Four features to build, each a decision about
what Overview is. Extracting a pure presenter from the 790-line client component
is real work on top of that, and secondary to it.

### 7.4 The paint system

With the Automation harness repointed and the harness finally supplying the
body's own stylesheet, fidelity reports 46 findings on H19/H20 — 40 untokenised
colours and 6 typography — and all of them are one fact: the mounted console is
built in the `adv` system (Instrument Sans, Space Grotesk, `--adv-*`) and the
accepted design package is the Ledger one (Schibsted Grotesk, Fragment Mono,
`--ledger-*`). Repainting one surface in Ledger tokens leaves it foreign to the
other twelve; repainting all thirteen is the design migration the contract
verdict already records as NOT READY pending the design owner's re-vendor.
Recorded in `PAINT_SYSTEM_DEBT` with a ceiling that may only come down.

### 7.5 What respond can honestly do

`/api/meta/recommendations/respond` needs a `recId`, and the Recommendations
section reports how many are in scope rather than which. The control records the
action and says where to record it against a specific decision, rather than
posting a request the route would refuse. Giving the section a
per-recommendation list is a design question about what belongs on Account
Intelligence versus Decision Center.

### 7.6 The scope sheet's pickers

The sheet states all eight facts; its rows carry no pickers. `ScopePickers`
treats an omitted handler as "this actor genuinely cannot do this" and draws
nothing rather than something disabled — and the console's real business,
account and window controls are in the topbar two inches above. Wiring the rows
would put a second route to the same three controls on one screen.

### 7.7 The archived Automation presenter

Still on disk, unreachable from any route and no longer reached by any release
evidence. It is the only implementation of the stop CEREMONY the design's H20
calls a "release preflight" — type-to-confirm, success announced only once a
read-back agrees, an explicitly unknown outcome when the confirming read fails —
and the mounted body has a direct engage/release pair with none of it. Deleting
it deletes the ceremony and the flow-I suite that encodes its laws.

### 7.8 Launchpad's first-load read count

18, measured three times with no variance, against a ceiling recorded as a 16–17
band. This pass touched no Launchpad code and could not attribute the extra read
to a change it made. Recorded as what it measures, with the fact that the cause
is unattributed written down beside it.

---

## 8. Externally blocked

| Blocker | Blocks | What is needed |
|---|---|---|
| No Meta sandbox account | WP7, WP15, WP13's provider-side reversibility, WP1's live-refusal confirmation | A physical Meta ad account that may receive PAUSED creates, named explicitly, with the scope it may be used at |
| No production read-only access | WP6 query plan / capacity / retention / growth | Explicit authorization and the exact business IDs that may be read |
| Design package not re-vendored | WP16 items 9–10, REQ-27, REQ-28/M11, REQ-41, and §7.4 | An export regenerated at a single fingerprint. The archive itself is not needed; the vendored bytes are hash-verified |
| No human assistive-technology pass | WP1, WP17 | A person with a screen reader confirming each disabled control's reason is announced. axe, the accessibility tree, focus order, dialog traps, live-region politeness and reduced motion are all checked; none is a substitute |
| No release authorization | WP18 | Explicit approval, per step |

None of these can be closed by writing code.
