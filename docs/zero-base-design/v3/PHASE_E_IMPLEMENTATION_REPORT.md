# Phase E Implementation Report — WP-21 … WP-25

**Worktree:** `/Users/harmelek/Adsecute-zero-base` · **Branch:** `codex/adsecute-zero-base-implementation`
**Phase D accepted head:** `1d769b534` · **Phase E head:** `13b4274b0`
**Authoritative plan:** SHA-256 verified `79b4b4f88b5b89ca06dd52cfaff28c8b21e17d0cde58902fed10594d307ab613`

**Status: complete.** WP-21 through WP-25 are all implemented and proven.

Two earlier states of this report were wrong and are recorded rather than
overwritten:

1. A checkpoint ended `PHASE_E_BLOCKED` with WP-24 and WP-25 unstarted on
   grounds of remaining capacity. Capacity is not a technical blocker; both were
   then built (§6, §7).
2. A **transition audit rejected `PHASE_E_COMPLETE` at `f27eb81ee`.** The 131
   focused tests passed, but they exercised isolated invented fixtures rather
   than the shipped clients against real handlers — so four boundaries that
   could never work still shipped. §10 records each defect, the fix, and the
   regression test that fails against the old code.

`/Users/harmelek/Adsecute` was not modified. Nothing was pushed, deployed, or
migrated; no provider was contacted; no flag was enabled; no live data changed;
no prior commit was rewritten. WP-26 was not started.

## Commits

| WP | Commit | Surface | Tests |
|---|---|---|---|
| 21 | `e948bfdd7` | Analytics, landing pages, SEO, GEO (4 routes) | 31 |
| 22 | `a15dfc63c` | Reports library/builder/viewer/print/disabled share (5 routes) | 35 |
| 23 | `91bf1fbd8` | Integrations, Team, Business, Plan + callback (5 routes) | 24 |
| 24 | `5328ac1b4` | Ops shell and all 16 Ops leaves | 39 + 6 Playwright |
| 25 | `8723609dc` | Ten public and marketing surfaces | 16 + 6 Playwright |

## 1 · WP-21 — Analytics, landing pages, SEO, GEO · `e948bfdd7`

**Files.** `lib/zero-base/analytics/analytics-contract.ts`,
`components/zero-base/analytics/{analytics-views,analytics-clients}.tsx`, four
`app/c/[businessId]/analytics/*/page.tsx` routes, 2 test files.

Adapters were written **after** inventorying the real handlers. Two disclosures
the GEO endpoint forces:

- `aiPageCount` is `Math.min(rowCount, 50)` in `app/api/geo/overview/route.ts`.
  It is a proxy capped at 50, so the disclosure shows whenever the number does —
  printing "50" bare reports a ceiling as a measurement — and a value sitting on
  the cap is additionally flagged.
- `top3Priorities` is already `.slice(0, 3)` server-side. The surface renders
  exactly what it received, never padding or re-slicing, and says others may
  exist.

Dual sources degrade rather than blank: when one of GA4 / Search Console fails,
the half that answered is still shown and the half that did not is named with
the provider's verbatim error. A measured zero carries
`data-measured-zero="true"` and stays a measurement; an absent value renders
"Not served" with its reason. Caps print only when the backend served one.

The AI insight is read only, and a comment-stripped scan over the shipped
analytics files asserts **zero call sites** to `/api/ai/insights/generate`.

## 2 · WP-22 — Reports · `a15dfc63c`

**Files.** `lib/zero-base/reports/{report-catalog,builder-model}.ts`,
`components/zero-base/reports/{report-views,report-clients}.tsx`, five
`app/c/[businessId]/reports/**` routes, 2 test files.

The catalog is read from the vendored `report-catalog.json`: **exactly 5
renderable + 4 coming-soon = 9**, with identity and order asserted. Search
Console and Klaviyo stay separate rows. A coming-soon source is **disabled,
never hidden** — hidden reads as "this data does not exist" rather than "not
wired yet".

CSV is table-only, with the reason shown where the control would be. Unsafe
breakdowns refuse aggregation because one entity appears in more than one row.

The builder is **one model for keyboard and pointer**, not a reduced fallback.
Undo replays the exact prior state rather than a computed inverse: a widget
clamped at the grid edge does not move back the way it moved in. Moves clamp
instead of pushing a widget off-canvas where the keyboard could not reach it.
Each widget owns its state, so a failed source shows an error and retry inside
its own frame while neighbours keep rendering.

**WP-03A exercised against the ACTUAL share route in both states:** flag-on
fails closed with **zero report lookups and zero access checks**, so a refusal
cannot probe which report ids exist; flag-off still looks the report up,
preserving legacy compatibility. No stored snapshot was touched, and no token
revoke/rotate was invented. The canonical UI has zero mint/share controls —
asserted in the DOM and by a call-site scan — and shows the real prerequisites,
including the Appendix C authorization G12 requires.

## 3 · WP-23 — Manage · `91bf1fbd8`

**Files.** `lib/zero-base/manage/manage-contract.ts`,
`components/zero-base/manage/{manage-views,manage-clients}.tsx`, five
`app/c/[businessId]/manage/**` routes including the provider callback, 2 test
files.

Provider health is per provider; an unmentioned provider is **unknown**, not
disconnected. There is no aggregate health badge and the surface says why.

**A write is not a read-back.** Reconnect and delete each issue an independent
read afterwards, and only an observation that matches the intent may be
reported as confirmed. Business deletion treats a subsequent 404 as the only
confirmation and can never print "deleted" from a response — a business that
still exists while the UI says it is gone is unrecoverable confusion.

Economics divergence names the exact sources, values and consumers, because
"these differ" is not actionable. An unset value counts as divergence.
`recommendedMode` is rendered with no control of any kind in its section.

Plan is static, gates nothing, says so, and a scan asserts **zero call sites**
to `/api/billing`.

## 4 · Checked API boundary matrix

| Boundary | Verdict |
|---|---|
| `/api/analytics/overview` | adapted; malformed refuses visibly |
| `/api/analytics/landing-pages` | adapted; caps only when served |
| `/api/seo/overview` | adapted; role gate stated, not hidden |
| `/api/geo/overview` | real `sources`/`kpis`/`top3Priorities`; 50-proxy and top-three disclosed |
| `/api/ai/insights/latest` | read only; absent state stated |
| `/api/ai/insights/generate` | **zero call sites**, scan-proven |
| `/api/reports` GET/POST | list + duplicate; a 200 without `reports` is degraded |
| `/api/reports/[reportId]` GET/PATCH | viewer/print read and builder save |
| `/api/reports/[reportId]/share` POST | both flag states driven against the real route |
| `/api/integrations/status` | per-provider adaptation; unknown ≠ not connected |
| `/api/integrations` POST | reconnect + independent read-back |
| `/api/team/members` | list; permissions stated |
| `/api/business-cost-model` | economics + read-only recommendedMode |
| `/api/businesses/[businessId]` DELETE | delete + separate 404 read-back |
| `/api/billing` | **zero call sites**, scan-proven |
| `/api/admin/**` (16 Ops leaves) | reused via the mounted admin components; no Ops page issues its own fetch |
| `/api/admin/integrations/health/shopify` PATCH | repair ceremony read from the real `{ok, action, actionResult}` shape; **no read-back exists and none is claimed** |
| Public marketing pages | no session or business guard; root page's soft forward permitted explicitly |

## 5 · Gates at `8723609dc`

typecheck 0 · lint 0 · **Vitest 8745 passed / 0 failed** (804 files; 61 skipped,
63 todo pre-existing) · migrations-from-zero PASS with all DB seams ·
selection-race seam PASS · creative:v2:safety 0 · frozen acceptance 22/22 ·
contract verify / freshness / fonts 0 · zero-base contract 17/17 · design 26/26 ·
responsive Playwright **84/84** (78 harness pages) · production build clean ·
credential-free smoke **95 passed / 3 failed**.

The three smoke failures are **identical to the accepted Phase D baseline** —
3 failed there and here; the passing count rose from 83 to 95 purely from the
new Phase E Playwright coverage. They are pre-existing, need Meta and commercial
data a credential-free cluster cannot hold, and are unchanged by Phase E.

Test growth across Phase E: 8586 (Phase D) → 8645 → 8680 → 8704 → 8729 → 8745.

`git diff 1d769b534..HEAD` touches no resolver or decision-output file. No ADR
was required and none was added.

## 6 · WP-24 — Ops shell and all 16 Ops leaves · `5328ac1b4`

**Files.** `lib/zero-base/ops/{ops-routes,repair-ceremony}.ts`,
`components/zero-base/ops/repair-panel.tsx`, `app/ops/layout.tsx` and 16
`app/ops/**/page.tsx` routes, 2 test files.

**Operational logic is reused, never duplicated.** Each Ops leaf mounts the
existing admin component, so confirmation, progress, error and read-back
semantics are literally the same code and cannot drift from the behaviour they
mirror. A test asserts every Ops page imports from `@/app/admin` or
`@/components/admin`, and that none contains a `fetch` or an `/api/admin`
string of its own. The one server-rendered admin page (release-authority)
reuses its report and panel directly.

**The route matrix is data, not convention.** Sixteen tuples, each resolving in
both directions, each with a real page file on disk, each legacy admin page
still present. A tuple that resolved in a constant but had no route would be a
404 an operator finds during an incident.

**The gate is server-side**, using the same two guards as the admin shell —
`getSessionFromCookies` and `isSuperadmin`. A client check would be a
suggestion, not a boundary.

**Buyer surfaces link to Ops zero times**, asserted by scanning every shipped
zero-base component and `/c` route for an `/ops` path or the Ops surface token.

**The repair ceremony preserves the real gap.** The admin PATCH answers
`{ok:true, action, actionResult}` and performs **no read-back**. So the panel
reports what the action returned, never prints a receipt, states that
confirmation requires re-running the health check, and offers that re-check. A
transport failure is **ambiguous** rather than refused, because the request may
have reached the server and run. Adding a read-back would be changing
semantics, which this work package forbids — naming the gap is the honest
alternative. Flow J's incident path ends in a re-read at 1280/768/390 in both
themes, with all four steps surviving every width.

## 7 · WP-25 — Public and marketing surfaces · `8723609dc`

**Files.** `lib/zero-base/marketing/ledger-marketing.ts`,
`scripts/zero-base/capture-marketing-snapshots.ts`, `app/marketing-ledger.css`,
scope attributes on `app/page.tsx`, `app/(marketing)/layout.tsx` and
`components/legal/PublicLegalPage.tsx`, 1 test file.

**The order mattered.** A copy snapshot was captured **before any edit** — 575
fragments across all ten pages — and is asserted equal afterwards, with the
claim-bearing pages (pricing, security, privacy, terms, ai-transparency) named
separately so a failure says which contract broke. Extracting rendered text
rather than hashing files means a pure styling edit may change the source while
the words cannot move.

**Presentation is scoped and rollbackable.** Everything lives under
`[data-adc-marketing]`, attached at exactly three roots that cover all ten
pages. Every rule is asserted scoped, and the stylesheet declares only an
allowed token subset — a public visitor has no session, no theme cookie and no
business scope, so the file must stand alone.

**Both leakage directions are guarded**: no workspace shell, ops shell or
business scope in any public page (asserted per file and by a DOM check at
every width), and the marketing stylesheet asserted absent from the workspace
shell.

**One distinction the tests had to get right.** The root page reads the session
to forward an already-signed-in visitor, then falls straight through
(`if (!session) return;`). That is a soft forward, not a gate, and flagging it
would have been wrong — so the check permits exactly that shape for
`getSessionFromCookies` while still refusing the business and admin guards,
which redirect unconditionally.

EN/TR is reported from what each file actually branches on rather than assumed
from the product supporting both.

**Visual coverage** at 1440/390/320 in light and dark asserts the typography is
really applied (body ≥15px, line height >1.4, bounded measure, heading larger
than body), that focus is visible for a keyboard visitor, and that nothing
scrolls sideways at 320 — with long legal prose as the hard case.

## 7 · Rollback

```
git revert 8723609dc   # WP-25
git revert 5328ac1b4   # WP-24
git revert 91bf1fbd8   # WP-23
git revert a15dfc63c   # WP-22
git revert e948bfdd7   # WP-21
```

WP-25 is additionally rollbackable by hand: delete `app/marketing-ledger.css`
and the three `data-adc-marketing` attributes. WP-24 reverting leaves `/admin`
untouched, since it was never modified.

Each is an additive set of canonical routes; reverting one leaves the others and
all legacy surfaces working. No server behaviour was changed in Phase E — the
report share route was exercised, not modified.

## 8 · Limitations

1. **The Ops repair action still has no read-back.** That is a property of the
   existing admin endpoint, preserved deliberately: the surface reports what the
   action returned and says confirmation requires re-running the health check.
   Adding one would change operational semantics, which WP-24 forbids.
2. The three legacy smoke failures in §5 remain, unchanged from Phase D.
3. These routes compose client-side over existing endpoints, matching the
   pattern accepted in Phases C and D.
4. Responsive evidence for the new Phase E surfaces is component-level: the DOM
   is asserted to carry every metric at any viewport. No new static harness page
   is claimed as proof of network behaviour.
5. Report viewer/print read `/api/reports/[reportId]`; where that endpoint does
   not serve per-widget rows, widgets render their empty grammar rather than
   fabricated data.
6. **Marketing copy equality is proven at the source level**, by extracting
   rendered text from each page file and comparing to the pre-change snapshot.
   It does not execute the pages, so a claim that is composed at runtime from a
   data file outside these ten pages is outside the snapshot's reach.
7. **The Ops leaves inherit the legacy admin components' own language and
   layout.** WP-24 adapts the shell; restyling each admin board's internals
   would have meant editing operational components, which is exactly what the
   work package forbids.

## 9 · Worktree state

Clean and fully committed at `8723609dc`. Nothing was pushed.


---

## 10 · Transition-audit corrections

The audit was right on every point, and the root cause was one habit: writing a
client against an assumed payload and then testing the assumption. Each fix
below is accompanied by a regression assertion that fails against the previous
code.

### 10.1 · WP-21 — the analytics payloads · `bf71a2999`

| Endpoint | What it returns | What the client did |
|---|---|---|
| `/api/analytics/overview` | `{propertyName, kpis, newVsReturning, insights}` | `adaptTable(["rows","sources","channels"])` — **always degraded** |
| `/api/analytics/landing-pages` | `pages[]` with `purchases`, `purchaseCvr` | asked for `conversions` — **"Not served" on every row** |
| `/api/seo/overview` | `{meta, summary, leaders, movers, causes, recommendations, aiBrief, aiWorkspace}` | expected `findings/rows/pages` — **always degraded** |

A wrong-shape guess is indistinguishable from an outage to whoever is looking at
it, which is why all three read as failures on healthy data. The adapters are now
typed against the handlers' actual return types. New vs returning renders as two
labelled cohorts and is never summed — GA4 serves no combined figure, so adding
them would invent one. A null `deltaPercent` renders unavailable rather than as a
0% "no change" claim. GEO and the latest-insight read are unchanged.

### 10.2 · WP-22 — the report workflows · `993e0b089`

- **Duplicate** POSTed `{businessId, duplicateOf}`; the route requires
  `businessId` **and `name`** and has no `duplicateOf`. Every duplicate was a
  400. It now reads the source record and creates from its definition.
- **Save** sent `{businessId, layout}` with no name, and `PATCH` also requires
  one; a `GridState` is not a `CustomReportDocument` either. The builder now
  collects a name (save is disabled without it) and converts the grid to a real
  version-1, slot-based document. Edit loads the record and reads its definition
  back into the canvas.
- **Viewer/print** read `/api/reports/[id]` expecting top-level `widgets`, but
  that route returns `{report: CustomReportRecord}` — so a healthy report
  rendered as one with nothing in it. It now reads `/render` and adapts
  `{report: RenderedReportPayload}`, including per-widget `errorMessage` and
  `retryable`, and refuses a body without that nesting.

One thing worth stating: the catalog source ids are exactly the
`CustomReportDataSource` union, so source→dataSource is identity rather than a
mapping table that could drift. Share UI stays absent; WP-03A fail-closed is
untouched.

### 10.3 · WP-23 — the Manage workflows · `bf6f78c7b`

- `/api/integrations` has **GET and DELETE only**, so the reconnect POST
  answered 405 every time. Reconnect is an OAuth round trip: the surface
  navigates to the provider's real start route, and on return re-reads
  `/api/integrations/status` and reports only the observed state.
- `/api/business-cost-model` returns `{costModel}`, and the client read the
  wrapper while asking for `targetRoas`/`recommendedMode`, which the cost model
  does not carry — the economics table was empty forever. It now reads the
  nested model, the target from `/api/business-commercial-settings`, and
  `recommendedMode` from `/api/business-operating-mode`, each labelled with its
  own source and consumers.
- `/api/businesses/[businessId]` has **no GET**, so the deletion read-back saw
  405 and could never confirm. Confirmation now comes from `GET /api/businesses`
  and counts only the deleted id's absence; a failed list read stays unknown
  rather than becoming a false confirmation from an empty array.

### 10.4 · WP-24 — production mounting and two semantics · `13b4274b0`

`repair-panel.tsx` and `CriticalIncidentPath` were referenced only by their own
test. A test-only component is not Flow J. Both are now mounted on the Ops
overview and Ops integrations pages, wired to the real Shopify health handler —
which the admin integrations page does not call, so this exposes an existing
endpoint rather than duplicating a mutation.

The two admin repair paths are now explicitly separated, because conflating them
would either invent a confirmation or withhold a real one:

| Path | Read-back | May confirm? |
|---|---|---|
| `/api/admin/sync-health` POST | the admin page GETs after the POST | yes — but only when the re-read agrees |
| `/api/admin/integrations/health/shopify` PATCH | none | never; the gap is disclosed |

The superadmin gate, all 16 tuples, zero buyer links and legacy `/admin` are
unchanged.

### 10.5 · Evidence integrity

87 tests were added or rewritten to bind to real contracts. They import the
actual route modules and assert method sets (`POST` absent on `/api/integrations`,
`GET` absent on `/api/businesses/[businessId]`, `PATCH`/`POST`/`GET` present
where claimed), the real payload nesting, and that the shipped clients use
neither a missing method nor a missing field. Eleven are explicit regressions
that fail against the pre-correction code.

### 10.6 · Gates at `13b4274b0`

typecheck 0 · lint 0 · **Vitest 8809 passed / 0 failed** (807 files; 61 skipped,
63 todo pre-existing) · migrations-from-zero PASS with all DB seams ·
selection-race seam PASS · creative:v2:safety 0 · frozen acceptance 22/22 ·
contract verify / freshness / fonts 0 · zero-base contract 17/17 · design 26/26 ·
responsive Playwright 84/84 · production build clean · credential-free smoke
**95 passed / 3 failed**.

The three smoke failures are byte-for-byte the accepted Phase D baseline — the
same three spec names (`reviewer-smoke.spec.ts:71`,
`commercial-truth-smoke.spec.ts:322`, `commercial-truth-smoke.spec.ts:367`),
unchanged by any Phase E work.

`git diff 1d769b534..13b4274b0` touches no resolver or decision-output file.

### 10.7 · Remaining limitations

1. The Ops repair on the Shopify path still has no read-back. That is the
   endpoint's property, preserved deliberately and disclosed; adding one would
   change operational semantics.
2. The three baseline smoke failures remain, unchanged.
3. Report viewer rows come from the render payload; where a widget carries no
   rows, it renders its catalog empty grammar rather than fabricated data.
4. Reconnect completes outside this product, in the provider's OAuth flow. The
   surface proves only what the post-return status read observed.
