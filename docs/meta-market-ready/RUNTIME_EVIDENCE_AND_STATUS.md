# Meta market-ready — runtime evidence and corrected status

Branch: `meta-market-ready`
HEAD: `65b68c49f6887096fc1886a4db26086141ee4362`
Date: 2026-08-25
Supersedes the revision written at `e643f68a8`, and the status table in
`EXECUTION_LEDGER.md`.

---

## 1. What changed since `245ccaf58`

Twelve commits, 245 files, +6 357 / −80.

| Commit | Work package | Subject |
|---|---|---|
| `2c6564d38` | — | Record the archive search, so "it is not there" is checkable |
| `d17b5e2e0` | WP4 | Make the rollback lever work, by adding the half that was missing |
| `ebab8382f` | WP17 | Correct two facts I got wrong about the instrumentation contract |
| `5b3493ae4` | WP4 | Prove the rollback lever on four running servers, and stop it shipping unset |
| `d3e60d307` | WP16 | A gate that fails when release evidence measures an archived body |
| `1a257e0b3` | WP10 / WP17 | Tell the eight Creative Studio tabs apart in telemetry |
| `a81244c54` | WP17 | The public share emits, anonymously, carrying no identifier at all |
| `efd324455` | WP9 | Give every Intelligence section its own §9 read state, and prove the matrix |
| `9b7021eb3` | WP11 | Drive the share lifecycle through mounted controls, and fix the three things that stopped it |
| `4eb8e63ec` | WP17 | Check what only exists while somebody is operating the surface |
| `8d09bcbee` | WP16 | Route the rollback screen's sentences through the copy module |
| `65b68c49f` | WP16 | Recapture the 92 frames from the code this pass leaves behind |

Twenty runtime spec files now drive the mounted routes. Three are new in this
pass: `meta-runtime-rollout`, `meta-runtime-share-lifecycle`,
`meta-runtime-interaction`.

---

## 2. The harness this evidence comes from

`npm run meta:runtime-evidence` boots a throwaway PostgreSQL 16 cluster (never
15432, the production tunnel; never 5432, the local volume), runs the repo's
real deploy migrations against it, seeds the D6 fixture, and serves the
**production standalone build** — with `DATABASE_URL` force-set so a
`.env.local` pointing at production cannot win.

**Five servers, one database.** A mode and a gate are properties of a *process*,
and one process can only ever be in one state, so each posture gets its own
build against the same cluster and the same fixture. The difference between what
two of them answer to the same request *is* the mode or the gate.

| Server | Posture | What it proves |
|---|---|---|
| `shipped-gates` | `ZERO_BASE_UI_MODE=on`, every release gate at its shipped value | The canonical console, refusing what ships refused |
| `gates-open` | mode on, plus Stop / workflow / share-mint / account-picker | The capability half of each gate |
| `rolled-back` | `ZERO_BASE_UI_MODE=off` | Every canonical surface serving its preserved legacy owner, or naming itself as one with none |
| `allowlist` | `allowlist`, naming the one-account business | Both halves of an allowlist in one process |
| `legacy-mint` | mode off, share mint open | WP11's lifecycle end to end — see §4 |

`META_LAUNCHPAD_EXECUTION` and `META_AUTOMATION_LIVE_WRITES` are opened
**nowhere**: their next step is a call to Meta, and no local evidence may be
produced by making one.

### Four harness defects this pass exposed

Each made the harness measure something other than the product.

1. **The operator was on the Starter plan.** No `plan_override`, which the
   billing endpoint resolves to `starter` — and `PLAN_GATED_MODULES` records
   that three Creative Studio tabs refuse to render below Growth. Every legacy
   Creative surface in this harness was answering *"Growth plan required"*
   rather than answering. Fixed by seeding the top plan; the gate itself stays
   proven by `plan-gated-modules.test.ts`.
2. **Four runtime-contract variables were unset.** The contract requires them to
   be explicit in production, so `/api/meta/status` threw on every request and
   surfaces read the 500 as a degraded provider. Now set to the values
   `.env.production.example` documents.
3. **The fixture had no creatives at all.** No `meta_creative_daily`, no
   `meta_creative_dimensions` — so the Creative Studio's table was empty on
   every posture and the entire share lifecycle was unreachable rather than
   merely untested. Three separate things then produced an empty table
   silently, each now stated by the fixture probe: coverage shorter than the
   selected window falls through to a live Meta read; a `{}` projection makes
   the assembler drop every fact row while still reporting `status: ok`; a
   missing currency throws.
4. **Server logs were kept only in memory** and printed only on a boot failure,
   so a 500 raised while serving a request left nothing to look at. They are now
   written beside the handle.

---

## 3. Corrected status by work package

A package is DONE only when every acceptance item has the evidence class it asks
for. Nothing is DONE on a passing unit test alone.

| WP | Status | What holds | What is missing |
|---|---|---|---|
| **WP0** Baseline & authority | **DONE** | Exact HEAD and source hash; ADRs Accepted; `zero-base:contract:verify` reports the package's own verdict honestly as NOT READY; the untracked Share work is untouched | — |
| **WP1** Interim posture | **PARTIAL** | No provider write; Launchpad validate answers and execution is refused on the running server; Automation states the Meta-only scope of its stop | Manual assistive-technology confirmation that each disabled reason is announced |
| **WP2** Surface registry & nav | **DONE** | 37 runtime checks: every canonical route, every `/app` twin, every `/platforms` legacy spelling, compared on body identity rather than page text | — |
| **WP3** Integrations & assignment | **PARTIAL** | A refused connection reads "Action required" and stops claiming freshness; §7.2 duplicate spellings resolve to the catalog's form while a foreign id stays refused; a missing discovery snapshot does not erase a valid assignment | A genuinely revoked Meta credential needs Meta to refuse one. Production read-only schema evidence |
| **WP4** Shell, account authority, **rollout** | **DONE (local)** | The rollback lever works and is proven on running servers: 38 checks across `off` / `allowlist`-in / `allowlist`-out / `on`, for `/app`, `/c` and the legacy spellings. `off` serves the preserved legacy owner — never a global 404 — and the eight canonical-only surfaces name themselves instead of borrowing a screen. Authorization runs *before* the rollout decision, so a fallback is not a business-existence oracle. An unset mode now fails preflight rather than silently rolling production back | Nothing local |
| **WP5** Window, as-of, freshness | **DONE** | URL → request → caption asserted as one equality; a custom window honoured verbatim; a backwards pair ignored rather than repaired; a business with no timezone neither fabricates one nor loses its picker | — |
| **WP6** Response/state contract | **PARTIAL** | One server-owned resolver; all seven §9 states proven at runtime including two DB-level fault injections and a genuinely held in-flight request | Query-plan, capacity, retention and 30–90 day growth evidence needs production read-only access |
| **WP7** Mutation safety foundation | **BLOCKED** | The contract is declared and `launchpad_create` conforms 18/18 | The twelve-case guarded sandbox matrix. Needs a Meta sandbox account |
| **WP8** Decisions | **DONE (local)** | acknowledge → defer → resolve → reopen with a durable SELECT after each, and a stale `expectedVersion` losing with a 409 that does not move the record | Nothing local. The gate ships off by design |
| **WP9** Account Intelligence | **PARTIAL** | Every section now carries its **own** §9 read state, derived by the single shared resolver and rendered as `data-section-read-state`. The matrix is proven deterministically: 11 sections × 5 producible states, 60 cases | Two of the plan's nine sections do not exist as composed sections — see §7 finding 3. `loading`, `refreshing-with-stale` and `refused` are page-level by construction, stated rather than claimed |
| **WP10** Creative Studio core | **DONE (local)** | 29 runtime checks across five tabs × four account postures, both scope leaks, and the Engine V3 posture matrix. Per-tab telemetry now resolves to nine distinct surface names | — |
| **WP11** Briefs, Shares, Public Share | **DONE (local)** | The whole lifecycle through mounted controls with a database read-back at every step: mint → list → open publicly → CSV → message → rotate → the old token stops working → revoke → the new one stops working. Eleven checks | The canonical console cannot mint — see §7 finding 2 |
| **WP12** History | **DONE (local)** | The nine families SUM to the unfiltered journal, and `writes` matches the action log row for row | — |
| **WP13** Automation | **PARTIAL** | The Stop engages, reads back, releases, reads back, and does it again; a stop engaged on the open server releases through the shipped one | Provider-side reversibility. The gate stays shut until a sandbox proves what Meta does |
| **WP14** Launchpad read/draft/validate | **DONE (local)** | Create → edit → list → validate → delete against the real database, each read back from the table | — |
| **WP15** Launchpad execution | **BLOCKED** | The shipped refusal is proven end to end: 503, no LaunchIntent row, no action-log row | Every acceptance item needs a Meta sandbox account |
| **WP16** Harness, contracts, dead modules | **PARTIAL** | Anatomy 83/83, fidelity 83/83, frames 92/92 with zero substitutions, recaptured at this HEAD. A gate now fails if any release-evidence path reaches an archived body without a recorded reason; the a11y, responsive and visual evidence for the Meta surfaces is captured from **authenticated mounted routes** rather than from the component harness | Three archived bodies are still reached, each with its reason recorded and a ceiling that may only shrink — see §7 finding 5. Contract verdict READY needs a design-owner re-vendor |
| **WP17** Telemetry, security, a11y, perf | **PARTIAL** | Nine distinct Creative surface names, widened additively so `creative_studio` can never be dropped; the public share emits one anonymous `screen_view` carrying nothing but the surface name, throttled by IP; axe clean at 1440 light and 390 dark on all thirteen surfaces with the offending selectors now named on failure; landmarks unique; D13 at five widths in both themes; keyboard entry, focus visibility, dialog trap and focus return, live-region politeness, reduced motion and PII-safe logs all proven at runtime across 32 checks | Manual AT pass. `creative-studio` CLS — see §7 finding 1 |
| **WP18** Staged release | **BLOCKED** | — | Explicit authorization. Nothing merged, pushed, deployed or activated |

---

## 4. Defects found and fixed in this pass

Every one was found by pointing a check at the thing it claimed to measure.

| # | Defect | Consequence | Found by |
|---|---|---|---|
| 1 | `/app` read the rollout predicate only to report it in an envelope, and the one route that acted on it was unreachable | `ZERO_BASE_UI_MODE=off` said "rolled back" while the canonical console served every surface | WP4's acceptance, read literally |
| 2 | An anonymous recipient could not reply to a share: `proxy.ts` allowed only `GET /api/creatives/share/<token>` | Every Send on the public page answered `401 Authentication required`, telling a recipient to sign in to a product they have no account for | driving WP11's lifecycle |
| 3 | `client-action-feed.ts` typed `requested_at` as `string`; a `timestamptz` arrives as a `Date`, and the store called `.trim()` on it | **Every buyer share 500'd** for any business with a qualifying write in its action log — which is every real one | the same lifecycle |
| 4 | `DashboardFrame` — the shell every mounted route renders — had no skip link | A keyboard user tabbed the entire rail before reaching the page, on every navigation | WP17's keyboard checks |
| 5 | The command palette declared `aria-modal="true"` with no focus trap and no focus return | Tab walked out of a modal onto a page a screen reader had been told did not exist; dismissing it sent the next Tab to the top of the document | the same |
| 6 | `#b45309` on `#fbf1da` at 10.5px measures 4.47:1 where AA wants 4.5 | The pill that says a decision could not be computed was the hardest one to read | axe, once the plan gate stopped hiding the surface |
| 7 | The share modal's CSV switch had no accessible name | It announced "switch, on" and nothing else | WP11's spec could not address it by name either |
| 8 | The canonical Landing Pages surface rendered a second `<main>` | Two main landmarks, so "skip to main content" is ambiguous | the landmark check, once the plan gate stopped hiding the body |
| 9 | Eight contracted Creative Studio leaves shared one runtime surface name | Per-tab telemetry was unreadable | the telemetry audit |
| 10 | The public share page emitted no `screen_view` at all | The one surface reached by people outside the workspace counted nothing | the same |
| 11 | The `anonymous` flag was generated from an exact string match on one actor scope | `share_creative` was contracted as non-anonymous, which the ingest would have refused | the same audit, re-checked |
| 12 | No section of Account Intelligence had a §9 read state; `data-read-state` was one value for the whole page | The 9 × 7 acceptance could not have been met by any amount of testing | WP9, read literally |

---

## 5. Validation at this HEAD

Every command run at `65b68c49f6887096fc1886a4db26086141ee4362`. Results quoted, not summarised.

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npx vitest run` | **PASS** — 12 846 passed, 144 skipped, 63 todo (13 053) across 1 072 files, 0 failed |
| `npm run build` | **PASS** |
| `npm run meta:runtime-evidence` | **PASS** — 312 authenticated role-matrix cases (8 principals × every leaf) + 348 browser checks against five servers; 130 skipped are the responsive screenshot matrix, which writes only under a named artifact set |
| `npm run test:migrations-from-zero` | **PASS** |
| `npm run test:selection-race-seam` | **PASS** |
| `npm run test:release-gate-plan-seam` | **PASS** |
| `npm run test:operator-hardening` | **PASS** |
| `npm run meta:verify-mounted-bodies` | **PASS** |
| `npm run test:zero-base:contract` | **PASS** |
| `npm run test:zero-base:compatibility` | **PASS** |
| `npm run test:zero-base:design` | **PASS** |
| `npm run test:zero-base:flows` | **PASS** |
| `npm run test:zero-base:states` | **PASS** |
| `npm run test:zero-base:routes` | **PASS** |
| `npm run test:zero-base:locale` | **PASS** — zero unexplained inline operator copy |
| `npm run test:zero-base:reference` | **PASS** |
| `npm run test:zero-base:fidelity` | **PASS** |
| `npm run test:zero-base:frames` | **PASS** — 92/92, 0 substitutions, 83/83 artboards |
| `npm run test:zero-base:a11y` | **PASS** |
| `npm run test:zero-base:responsive` | **PASS** |
| `npm run test:zero-base:visual` | **PASS** |
| `npm run test:zero-base:theme` | **PASS** |
| `npm run zero-base:reconcile:frames` | **PASS** |
| `npm run zero-base:contract:verify` | **PASS** — reports the package's own verdict as NOT READY |
| `npm run zero-base:contracts:check` | **PASS** |
| `npm run zero-base:fonts:verify` | **PASS** |
| `npm run zero-base:legibility` | **PASS** |
| `npm run test:local-db` | **NOT RUN** — refuses without the external volume at `/Volumes/adsecuteDB`. A hardware precondition, not a code result; `test:migrations-from-zero` covers the same class on the ephemeral cluster |

---

## 6. Evidence by class

**Mounted route / browser.** 348 Playwright checks against the production
standalone build over HTTP with a real session, across five servers differing
only in rollout mode and release-gate environment.

**Database.** A real PostgreSQL 16 cluster with the repo's real migrations. Every
"it worked" claim is a `SELECT`, not a reading of a response body — a route
re-reads its own write and can report a success it did not persist.

**Deterministic composition.** Where a state cannot be injected into a live page
— WP9's per-section matrix — the composer is driven directly through the shared
resolver, and the difference between that and a browser test is stated in the
file rather than glossed.

**Provider.** None. No Meta call was made by anything in this session.

**Release and rollback.** Nothing merged, pushed, deployed or activated. Every
commit is independently revertible and scoped to one subject. Every release gate
still defaults off.

---

## 7. Open findings — real, local, and not closed

These are defects, not tolerances. Each is measured, each has a named
mechanism, and each fails a gate the moment it gets worse.

**1. `creative-studio` CLS 0.1042 against a 0.1 budget.** Repeatable to the last
digit, which is how it was traced: the same value before and after two attempted
fixes, so neither was the cause. The shell renders on the client, so a Meta
surface's first paint has no `<main>` at all, and the shell's first client render
is 52 px taller above `<main>` than its settled one; when that strip collapses,
the whole content column moves up at once. It is a shell defect that Creative
Studio is merely tall enough to expose. Recorded in `CLS_DEBT` with both
eliminated candidates. Fixing it means changing when the shell commits its final
height — a shell-wide change with its own regression surface.

**2. The canonical console cannot mint a share.** `/app/creative/shares` lists,
rotates and revokes, but passes `onCreate={undefined}`: it has no creative
selection to send, and the mint endpoint refuses a snapshot holding none. The
only mint UI is the legacy Creative Studio's modal. WP11's lifecycle therefore
runs on the `legacy-mint` posture — which is what a deployment is in today,
since the mode defaults to off — and the canonical ledger's refusal is pinned so
the gap is recorded rather than implied.

**3. Two of WP9's nine plan sections do not exist.** `IntelligenceView` accepts
an `onRespond` prop and the page never passes one, so no respond control renders
and *"Respond ve run-now role/capability gate kullanır"* has nothing to gate.
Snapshot/run-now is a hard-coded disabled button, not a composed section. Both
are recorded with their reasons rather than folded into the count.

**4. `gated:AUTO-03 mode` names a control that does not exist.** Five of H19's
six markers are ported onto the mounted Automation body and its `data-ctl` keys
match the interaction manifest. The sixth is a radiogroup that switches
automation mode; the mounted body has read-only autonomy rows and no such
control. That is a missing feature, not a missing attribute, so the harness
repoint would fail the anatomy gate on the surface it is meant to measure.

**5. Three archived bodies are still rendered by the shell harness.** Each is
recorded with its reason and the list may only shrink: Overview has no pure
presenter (repointing means four fakes, and a DOM assembled from four fakes is a
fifth thing to keep in sync); Decisions needs H09's ten anatomy markers ported
onto `MetaDecisionCenterExact` first, which today carries one of them; Automation
is blocked by finding 4. The release evidence for the Meta surfaces no longer
depends on any of them.

**6. The mounted shell is not the zero-base shell.** Every canonical route
renders `DashboardFrame`. The zero-base `AppShell` — with its skip link, its
`<main tabindex>`, its nav drawer and its scope sheet — is mounted by nothing but
the harness. The skip link and `<main tabindex>` have been ported to the shell
that ships; the drawer and scope sheet have not, and their absence is why WP17's
dialog check drives the command palette instead.

---

## 8. What is blocked, and on what

| Blocker | Blocks | What is needed |
|---|---|---|
| No Meta sandbox account | WP7 (twelve-case matrix), WP15 (all), WP13's provider-side reversibility, WP1's live-refusal confirmation | A physical Meta ad account that may receive PAUSED creates, named explicitly, with the scope it may be used at |
| No production read-only access | WP6 query plan / capacity / retention / growth | Explicit authorization and the exact business IDs that may be read |
| Design package not re-vendored | WP16 items 9–10, REQ-27, REQ-28/M11, REQ-41 | The design owner ships an export regenerated at a single fingerprint. The archive itself is **not** needed — see §9 |
| No human assistive-technology pass | WP1, WP17 | A person with a screen reader confirming each disabled control's reason is announced. axe, the accessibility tree, focus order, the dialog trap and live-region politeness are all checked; none is a substitute |
| No release authorization | WP18 (all) | Explicit approval, per step |

None of these can be closed by writing code.

---

## 9. The design archive: what the search actually found

The reference gate failed for weeks with *"Design package not found at
`/Users/harmelek/Downloads/Adsecute Zero-Base Design.zip`"*, so before changing
anything I looked for it. The search is recorded rather than summarised as "it
is missing", because "I could not find it" and "it is not there" are different
claims and only the second licenses a change of approach.

Read-only, five ways: `~/Downloads` filtered for `adsecute` / `zero-base` /
`design`; the home tree to depth 6 by name; every `.zip` under `~` to depth 5;
Spotlight by name and by filesystem predicate; and `~/.Trash`. The only hit
anywhere was `/Users/harmelek/Adsecute/docs/zero-base-design` — the vendored
directory, not an archive. No `.dc.html` artboards exist in the repository, and
`SOURCE.md` says they were deliberately not vendored.

**The archive is genuinely absent from this machine, and it is not needed.**
`docs/zero-base-design/v3/` holds the exact bytes copied from it at vendor time,
with a per-file SHA-256 manifest and `reference-manifest.json` bound to the
archive's own digest — 83 artboards, 142 contracts. `SOURCE.md` states the rule
directly: *"The application must never import the design package from
`Downloads/` or `/tmp`."* The gate was failing because it looked in the one place
the design owner's own note forbids.

So this is **not** an item on the external-blocker list. What is still needed
from the design owner is a **re-vendor** — a new export regenerated at a single
fingerprint, which is what REQ-27, REQ-28/M11 and REQ-41 are waiting on. That is
a different request from "please send the zip again", and conflating the two
would have sent someone hunting for a file that would change nothing.
