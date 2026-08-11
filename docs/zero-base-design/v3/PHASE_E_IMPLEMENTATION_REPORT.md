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

---

## 11 · Second transition audit — corrections at `d25fbb18a`

The re-audit of `07935bad3` rejected the completion claim again and named five
defect groups. All five are closed. The audit's central charge was fair and is
recorded here plainly: **a passing test encoded a field the real producer does
not emit**, and that test is why the defect survived the first correction round.

### 11.1 · A — analytics source truth (`0827fdee0`)

`AnalyticsSourceClient`, `AnalyticsLandingPagesClient` and `SeoClient` called
`adaptSources(raw)` on their own report payload. Only `/api/geo/overview` emits
a `sources` object, so on analytics and SEO **every** provider rendered as "not
reported" — the surface told the operator GA4 was down while displaying GA4's
own numbers.

Connection state now comes from `/api/integrations/status`, keyed off the
producer's own `IntegrationStatusResponse` type so a rename there is a compile
error rather than a silent all-down report. (The first draft of this fix guessed
the key `google_analytics`; the real keys are `ga4` and `search_console`, which
is precisely why the mapping is now bound to the producer's type.)

GEO keeps its real dual-source payload untouched. Connection is separated from
measurement: analytics claims only GA4, so a connected Shopify no longer implies
it supplied the figures beside it, and an unreadable authority reads as unknown
rather than down.

Five mounted tests; four fail against `07935bad3`.

### 11.2 · B — the real report model (`04f6b3cb0`)

`RenderedReportWidget` has no `dataSource`. The renderer reads `dataSource` off
the widget **definition** and never echoes it. `report-documents.test.ts`
invented one in its `RENDERED` fixture and `adaptRenderedReport` read it, so the
test passed while production resolved every widget to `""` — identical React
keys for every card, and all metric, trend and text content dropped through a
rows-only table.

- The fixture is now typed as `RenderedReportPayload`, making an invented field
  a compile error. A regression asserts no rendered widget carries `dataSource`.
- `adaptRenderedReport` passes `RenderedReportWidget` through whole.
- `RenderedWidgetCard` renders by type: `value`/`deltaLabel` for metrics,
  `points`/`series` for trends, `rows`/`columns` for tables, `text` for text —
  with `emptyMessage`, `warning` and per-widget error preserved. Retry appears
  only where the renderer marked the failure retryable.
- The CSV guard reads the stored definition, because the rendered payload cannot
  answer it, and fails closed when the definition is unreadable.
- `ReportBuilderView` captured `initial` once while the client loaded
  asynchronously; the client now gates on load, and the view adopts a later
  `initial`. An unreadable record refuses rather than showing a blank canvas.
- Saving rebuilt the document from the grid, destroying `metricKey`, `yMetrics`,
  `breakdown`, `accountId`, `limit`, `columns`, `tableDimension`, `axisMode`,
  `text`, `subtitle` and the document-level settings. It now mutates only
  geometry against the stored document.
- Reading a document back dropped `text`/`section` widgets for having no
  `dataSource`, which deleted them on the next save. **This was found by the
  new round-trip test, not by inspection.**
- A newly added source arrives with the configuration its type needs, taken from
  the shipped templates, so a fresh metric widget no longer renders "Metric
  unavailable" purely because the builder omitted a `metricKey`.
- `Math.random` row keys are gone; `DataTable.rowKey` now receives the index.

Nine mounted flow tests; seven fail against `07935bad3`.

### 11.3 · C — the complete Manage scope (`d25fbb18a`)

**OAuth.** `oauthStartUrl` omitted `returnTo` while the client waited for a
`reconnected` parameter no callback emitted. Every offered start route now takes
a sanitized `returnTo` — Google and Shopify already did; Meta and GA4 carry it
through their OAuth state; Search Console forwards it to the Google start it
delegates to — and each callback re-sanitizes it on the way out to the shared
callback page, which already honours it. The parameter is no longer invented: it
is part of our own return URL, and the real flow carries it. Klaviyo is no
longer offered, because its start route answers 501 by design.

**Team.** Implemented on the actual handlers: members GET/PATCH/DELETE including
the `update_workspaces` branch, invites GET/POST/PATCH, access-requests GET/POST,
workspaces GET. The previous surface read `member.id`; the handler selects
`membership_id`, so every row fell back to its array index. Guest, reviewer and
admin see the handlers' own gates, refusals name the required role, and a
reviewer never requests the admin-only access-request queue. Every write shows
progress, surfaces the handler's message, and confirms only after an independent
re-read — a re-read that disagrees is reported unresolved.

**Assignment.** Reuses `provider-assignment-drawer-support` rather than
reimplementing it, so the snake_case `account_ids` body, the two distinct
discovery routes and the lane/authorization semantics behind them are untouched.
The selection is seeded from the served `assigned` flags. That helper echoes the
draft back on failure, so its return value is never treated as evidence.

**Business settings.** Name and currency were absent; they now use the real
PATCH contract, which takes both together and refuses a name under two
characters. The route has no GET, so current values and the confirming read come
from the business collection.

**Plan** stays static, with no `/api/billing` call, asserted by test.

Eighteen contract tests and eighteen mounted flow tests; twenty-two fail against
`07935bad3`.

### 11.4 · D — Flow J made executable (`338117398`)

`OpsIncidentSurface` was mounted with no `businessId` on both `/ops` and
`/ops/integrations`, while the Shopify handler reads `businessId` from the PATCH
body and the GET query. **Every click on the shipped button was a 400.**

Ops has no business in its route, so the surface now asks: a workspace selector
backed by `GET /api/admin/businesses`, with the action withheld and the reason
stated until a workspace is chosen, and withheld when the list cannot be read.
Because this calls a provider, running it requires a confirmation naming the
workspace, the provider and the action. The no-read-back disclosure is unchanged.

The re-read stamped "Health re-read at …" unconditionally, including after a 400.
It now reports success only after `response.ok` **and** a body the handler
recognisably produced, reports failure or unknown otherwise, and drops a stale
result when the workspace changes.

`RepairOutcome.readBack` had a single member, so the one path that genuinely
re-read and agreed was forced to stamp `not_performed` on itself. It can now say
`confirmed`, and only that path does.

`verify_webhooks` is never actually run: `fetch` is stubbed at the network
boundary for every test in the file. Fifteen mounted tests at 1280/768/390; all
fifteen fail against `07935bad3`.

The superadmin gate, 16 tuples, zero buyer links and legacy `/admin` are
unchanged.

### 11.5 · E — gates at `d25fbb18a`

typecheck 0 · lint 0 · **Vitest 8888 passed / 0 failed** (812 files; 61 skipped,
63 todo, 4 skipped files — all pre-existing) · migrations-from-zero PASS with
all DB seams · selection-race seam PASS (S1–S7) · creative:v2:safety 0 · frozen
acceptance 22/22 · contract verify / freshness / fonts 0 · zero-base contract
17/17 · design 26/26 · responsive Playwright 84/84 · production build clean ·
credential-free smoke **95 passed / 3 failed**.

The three smoke failures are the same three spec names as the accepted Phase D
baseline (`reviewer-smoke.spec.ts:71`, `commercial-truth-smoke.spec.ts:322`,
`commercial-truth-smoke.spec.ts:367`), unchanged by any Phase E work.

Each defect group ships with tests that fail against `07935bad3` — 48 failing
tests in total across the four groups, verified by checking out the prior
sources and re-running.

`git diff 1d769b534..d25fbb18a` touches no resolver or decision-output file.

### 11.6 · Remaining limitations, restated honestly

1. The Shopify repair endpoint still performs no read-back. That is the
   endpoint's property, preserved deliberately and disclosed on the surface.
2. The three baseline smoke failures remain, unchanged.
3. OAuth **error** redirects that fire before the state is decoded cannot carry
   `returnTo` — the value has not been read yet. Those land on the shared
   callback page, which reports the error. Success paths and post-decode errors
   carry it.
4. Reconnect completes outside this product. The surface proves only what the
   post-return status read observed.
5. GA4 property and Search Console site selection are not offered: assignment
   covers Meta and Google Ads, the two providers with a real discovery route on
   disk. `getProviderFetchPath` returns null for the others, and the panel
   offers only what it can actually read.

---

## 12 · Third audit — corrections at `4077db0c9`

The audit of `4a51ed4ee` rejected the completion claim and named four
production paths that were unreachable or dishonest in the mounted UI. All four
are closed. One item is a correction of **this report**, not only of the code:
§11.6 claimed GA4 property and Search Console site selection were "not offered"
because no discovery route existed. That claim was false — the routes and the
GA4 picker helpers were already on disk. The scope had simply never been
surfaced, and the report asserted a limitation instead of checking.

### 12.1 · Flow H — first-time connection was unreachable (`32636db96`)

`IntegrationsView` rendered `Reconnect` only for `needs_reconnect` and a dash
for `not_connected`. A provider that had never been connected had **no entry
point at all** on the canonical surface: Flow H did not exist in production.

Connect now uses the same OAuth start and the same sanitized `returnTo` as
reconnect — the provider does not distinguish them, and two return paths would
be two chances to get the return wrong. Support is computed from whether a real
start route exists (`oauthStartUrl(...) !== null`) rather than assumed, so a
provider whose route intentionally refuses renders as unavailable and
non-clickable with the reason stated. Reconnect behaviour and the post-return
status read are unchanged.

Five mounted tests, including one asserting each of the five supported
providers targets its own real start path. All five fail against `4a51ed4ee`.

### 12.2 · GA4 property and Search Console site selection (`03771fc44`)

Reuses `fetchGa4Properties` and `saveGa4PropertySelection` rather than
re-deriving the request shapes, so discovery, authorization, stale-generation
protection and persistence stay owned by the real routes.

Confirmation never comes from the write response:

| surface | read-back authority | why |
|---|---|---|
| GA4 property | `GET /api/google-analytics/properties` → `selectedPropertyId` | the discovery route reports the current selection |
| Search Console site | `GET /api/integrations?provider=search_console` → `provider_account_id` | the sites route reports **no** selection at all |

The existing dashboard flow confirms from the write response; this one does not.
Identifier comparison follows the routes' own normalization — GA4 ids compared
bare because both sides carry the `properties/` prefix, and a trailing-slash
difference on a site URL is the same site because `select-site` runs URLs
through `new URL(...).toString()`. A 409 `connection_changed` saved nothing and
is reported as a refusal.

Ten mounted tests (success, permission denial, unreadable discovery, failed
write, mismatched read-back, reassignment) plus ten route-bound tests that
import the four route modules and assert their verbs.

### 12.3 · Flow J workspace scope and health read-back (`b07309539`)

Three defects, all real:

1. The surface requested `?limit=200`, but `/api/admin/businesses` **hardcodes
   `limit = 30`** and ignores the parameter. A superadmin could not select the
   31st workspace, and the truncated list looked complete. Pages are now walked
   using the route's own reported `total`/`limit`; a failed page is disclosed as
   an incomplete list; a failed first page reads as unreadable rather than an
   empty estate. A 50-page ceiling guards against a nonsense `total`.
2. `isReadableHealthBody` accepted any object containing a `businessId`, so a
   response about a **different** workspace satisfied it. Reading now requires
   the echoed `businessId` to equal the selected one.
3. The confirmation stamped a timestamp and told the operator to "read the board
   above" — a legacy board this GET did not update. It now renders what the GET
   returned: `status.state`, `auth.shopDomain`, token validity with its reported
   reason, `auth.productionMode`, and named blockers built from
   `missingRequiredScopes`,
   `historicalCoverageBlockedByMissingReadAllOrders` and
   `returnsRepairBlockedByMissingReadReturns`. A read with no blockers says so.

Stale health is dropped when the workspace changes. Nine new mounted tests
(74 workspaces across three pages, page-2 failure, page-1 failure,
wrong-business body, visible health, workspace change); all nine fail against
`4a51ed4ee`. `verify_webhooks` is still never actually run.

### 12.4 · Report CSV export was a dead affordance (`4077db0c9`)

`ReportViewerClient` rendered every card without `onExportCsv`, so eligible
tables showed an **enabled button wired to nothing** in front of a real,
working endpoint.

Export now calls `GET /api/reports/[reportId]/export?widgetId=…`. The id
matters: the route falls back to the first table widget when it cannot resolve
one, so omitting it would quietly export a different widget than the operator
clicked. `startDate`/`endDate` from the rendered payload are passed through so
the file covers the window on screen, and `dateRangePreset` is sent only when it
is one of the three values the route honours.

The request is fetched rather than navigated so a refusal can be shown — the
route answers 400 `table_widget_required` with a message that a bare location
change would drop. On success the response becomes a blob and a real download
fires, honouring the route's `Content-Disposition` filename. Eligibility is now
two guards: the catalog's per-source rule **and** whether the route would accept
the widget at all, so a metric card and a table that served no rows are both
explicitly blocked with the reason they would be refused.

Five mounted tests; all five fail against `4a51ed4ee`.

### 12.5 · Gates at `4077db0c9`

Commands run, in this worktree:

```
npm run typecheck                                  → 0 errors
npm run lint                                       → 0 problems
npx vitest run                                     → 8927 passed / 0 failed
                                                     (812 files passed, 4 skipped;
                                                      61 skipped, 63 todo — all pre-existing)
npm run creative:v2:safety                         → 0 violations
npm run creative:decision:native-ad-frozen-acceptance → 22/22
npm run zero-base:contract:verify                  → PASS
npm run zero-base:contracts:check                  → current (exit 0)
npm run zero-base:fonts:verify                     → ok
npm run test:zero-base:contract                    → 17/17
npm run test:zero-base:design                      → 26/26
npm run test:migrations-from-zero                  → PASS, all DB seams clean
npm run test:selection-race-seam                   → PASS (S1–S7)
npm run build                                      → compiled, 219 static pages
npm run test:zero-base:responsive                  → 84/84
credential-free smoke                              → 95 passed / 3 failed / 1 skipped
```

The smoke needs a local database for its two auth-setup projects. It was run
against an **ephemeral PostgreSQL** created for the run, migrated from zero, and
destroyed afterwards; the throwaway `.env.local` is gitignored and was deleted.
No production or tunnelled database was used.

The three smoke failures are the same three spec names as the accepted Phase D
baseline — `reviewer-smoke.spec.ts:71`, `commercial-truth-smoke.spec.ts:322`,
`commercial-truth-smoke.spec.ts:367` — unchanged by any Phase E work.

Twenty-eight tests across the four groups fail against `4a51ed4ee`, verified by
checking out the prior sources and re-running each group.

`git diff 1d769b534..4077db0c9` touches no resolver or decision-output file.

### 12.6 · Residual limitations

1. `§11.6` of this report wrongly declared GA4/Search Console selection absent.
   That claim is withdrawn; the scope is implemented in `03771fc44`.
2. Account assignment still covers Meta and Google Ads only.
   `getProviderFetchPath` returns null for other providers, so the panel offers
   only what it can actually discover. GA4 and Search Console are handled by
   their own selection panels rather than that generic one.
3. The Shopify repair endpoint still performs no read-back of its own. The
   surface now shows the state a **separate** health GET returned, which is a
   different fact and is labelled as such.
4. OAuth error redirects that fire before the state is decoded still cannot
   carry `returnTo`; the value has not been read at that point.
5. The workspace list is walked to at most 50 pages (1,500 workspaces). Beyond
   that the list is disclosed as incomplete rather than silently truncated.
6. The three baseline smoke failures remain, unchanged and unrelated.

---

## 13 · Fourth audit — corrections at `c80fb9791`

The audit of `6467a7d80` independently passed 121 targeted tests, typecheck and
lint, and rejected completion for three contract defects. All three shared a
shape: **the UI claimed more than the handlers support.** All three are closed.

### 13.1 · Flow H permission posture

`IntegrationsClient` already received the real workspace role, and every start
route for Meta, Google, GA4 and Search Console calls
`requireBusinessAccess({minRole: "collaborator"})`. Guests were nevertheless
shown enabled Connect and Reconnect controls and navigated into a JSON 403 — an
error document, not a surface.

Both controls are now gated by `oauthStartPermission`, which mirrors that same
requirement. A guest sees a stated read-only reason and no enabled
authorization control. The server gate remains the authority; this only stops
the UI offering an action it already knows will be refused.

Five mounted tests: guest denied on `not_connected`, guest denied on
`needs_reconnect`, guest click starts no navigation, collaborator may connect,
admin may reconnect.

### 13.2 · Shopify was falsely classified as a completable OAuth start

`oauthStartUrl` emitted `/api/oauth/shopify/start?businessId=…&returnTo=…` with
no `shop`. Invoking the real handler shows what that does:

| request | result |
|---|---|
| no `shop` | 302 to `/shopify/connect`; **`businessId` and `returnTo` are dropped** |
| valid `shop` | 302 to `https://<shop>/admin/oauth/authorize`, state carrying `businessId` + sanitized `returnTo`, `shopify_oauth_state` cookie set |

So the generic Connect could never complete, and the "can actually complete"
claim on `OAUTH_START_PROVIDERS` was false for Shopify. Shopify is removed from
that map and given its own entry:

- **No known shop** → "Open Shopify setup", linking to `/shopify/connect`, the
  surface the handler itself redirects to, with copy stating that authorization
  starts in Shopify and that the result cannot be confirmed here. No automatic
  return or read-back is claimed.
- **Authoritative shop domain** → the audit permitted a direct reauthorization
  *only after verifying the contract*. Verified: the handler reads the session
  and honours `businessId` and a sanitized `returnTo` when a `shop` is present.
  That path is offered only for a `provider_account_id` the stored integration
  supplied and only when it matches the real `myshopify.com` pattern — never a
  domain this surface guessed or asked an operator to type.

The pathname-only assertion is replaced by `shopify-entry.test.ts`, which
invokes the handler for both outcomes and asserts the dropped context on the
no-shop path.

### 13.3 · Flow J accepted a non-health body

`readHealthBody({businessId: expected}, expected)` returned a non-null object,
and the test encoded that as valid — so a 200 carrying no health at all was
stamped as a successful re-read.

A health claim now requires a **health core**: a `status` object with `state`
(non-empty string) and `connected` (boolean). Optional fields may be absent —
ordinary, and still rendered honestly as null — but a *present, malformed* value
no longer gets silently downgraded to "not reported" under a successful
receipt; it makes the whole reading unknown. `auth` must be an object if
present, and `missingRequiredScopes` must be an array of strings.

Seven unit assertions plus four mounted regressions: `{businessId}` only,
malformed status, malformed optional field, and a real producer-shaped payload
whose visible fields are rendered.

### 13.4 · Gates at `c80fb9791`

```
npm run typecheck                                     → 0 errors
npm run lint                                          → 0 problems
npx vitest run                                        → 8947 passed / 0 failed
                                                        (813 files passed, 4 skipped;
                                                         61 skipped, 63 todo — pre-existing)
npm run creative:v2:safety                            → exit 0
npm run creative:decision:native-ad-frozen-acceptance → exit 0 (22/22)
npm run zero-base:contract:verify                     → exit 0
npm run zero-base:contracts:check                     → exit 0
npm run zero-base:fonts:verify                        → exit 0
npm run test:zero-base:contract                       → exit 0 (17/17)
npm run test:zero-base:design                         → exit 0 (26/26)
npm run test:migrations-from-zero                     → PASS, all DB seams clean
npm run test:selection-race-seam                      → PASS (S1–S7)
npm run build                                         → compiled successfully
npm run test:zero-base:responsive                     → 84/84
credential-free smoke                                 → 95 passed / 3 failed / 1 skipped
```

Smoke was run against an ephemeral PostgreSQL created for the run, migrated from
zero, and destroyed afterwards; the throwaway `.env.local` is gitignored and was
deleted. No production or tunnelled database was used. The three failures are
the same three spec names as the accepted Phase D baseline —
`reviewer-smoke.spec.ts:71`, `commercial-truth-smoke.spec.ts:322`,
`commercial-truth-smoke.spec.ts:367`.

18 tests fail against `6467a7d80`, verified by checking out the prior sources
and re-running. `git diff 1d769b534..c80fb9791` touches no resolver or
decision-output file.

### 13.5 · Residual limitations

1. **Shopify cannot support a first-time in-product round trip, and this is now
   represented truthfully rather than worked around.** Installation is owned by
   the Shopify App Store or store admin; the product links to its own setup
   surface and states that the result cannot be confirmed here. Only
   reauthorization of an already-connected store completes in product, because
   only then does an authoritative shop domain exist.
2. Shopify's start route enforces no `minRole` of its own — it is
   session-authenticated only — so the collaborator gate applied to the other
   four providers is not claimed for it.
3. Account assignment still covers Meta and Google Ads only; GA4 and Search
   Console have their own selection panels.
4. The Shopify repair endpoint still performs no read-back of its own; the
   surface shows what a separate health GET returned, labelled as such.
5. OAuth error redirects firing before the state is decoded cannot carry
   `returnTo`.
6. The workspace list is walked to at most 50 pages and discloses truncation.
7. The three baseline smoke failures remain, unchanged and unrelated.
