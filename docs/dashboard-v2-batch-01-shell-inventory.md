# Dashboard v2 Batch 1 — shell design/app inventory

Canonical artifact: `/Users/harmelek/Downloads/Dashboard tasarımı yenileme/Adsecute Dashboard v2.dc.html`

SHA-256: `d65c0117871aa392fb2f93e79d02540f6538be6a00b1d2ecea03bdd9f8432193`

Source ranges read: markup **23–144**; initial state **3178–3179**;
navigation helper/model **3229–3294**; comparison/chart state **3250–3257**
and **4415–4423**.

This is the two-column inventory required for Batch 1. Text values that come
from the prototype data model are identified as seed data; the app column uses
the equivalent real workspace/provider state or an honest absent value.

| Order | Design inventory                                                                                                                                             | App inventory                                                                                                                                                                                                                                   |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|     1 | Shell root: full viewport flex, hidden overflow, `#F3F5F9`; body inheritance 16px/normal (lines 14–24).                                                      | `.adv-shell`: full viewport flex, hidden overflow, `--adv-canvas`; 16px/normal (`app/globals.css:7799–7809`).                                                                                                                                   |
|     2 | Rail: `aside`, 248px fixed, `#0B1020`, column (line 24).                                                                                                     | `AppRail` renders one 248px fixed `aside` using the same values (`app-rail.tsx:301–423`; CSS `7822–7829`).                                                                                                                                      |
|     3 | Brand: 30px blue mark with original 18px asset; `Adsecute`; mono `v2` (lines 25–31).                                                                         | Same mark asset, alt text, wordmark and version in the same order (`app-rail.tsx:348–360`).                                                                                                                                                     |
|     4 | Nav container: scrollable column, `12px 10px 16px`, 2px gap (line 32).                                                                                       | `.adv-rail-nav` matches and contains no additional rail group (`app-rail.tsx:362–418`; CSS `7866–7873`).                                                                                                                                        |
|     5 | Home: one clickable div, Overview, 16px exact icon (lines 33–38; model 3260).                                                                                | One clickable div from the canonical registry; exact icon path and scoped route handler (`app-rail.tsx:151–200`, `363–373`).                                                                                                                    |
|     6 | `PLATFORMS` mono group label (line 39).                                                                                                                      | Same group label/order (`app-rail.tsx:375`).                                                                                                                                                                                                    |
|     7 | Meta parent: white 13px logo box, `Meta`, green live dot; 13.5px/600 bright ink regardless of active family (lines 40–46; model 3261).                       | Same div, direct unoptimised asset, label/dot, unconditional bright/600; only family background changes (`app-rail.tsx:202–267`; CSS `7912–7932`).                                                                                              |
|     8 | Meta children: Decisions, Creative Studio, Launchpad, Automation; 15px exact icons, active state and optional mono red count (lines 47–57; model 3262–3268). | Same four/order/paths/state. Decisions count mirrors a real cached workspace snapshot and stays absent if unavailable (`app-rail.tsx:268–295`, `382–390`; `use-shell-signals.ts:28–58`).                                                        |
|     9 | Google parent: white 13px logo box, `Google Ads`, green live dot; same bright/600 rule (lines 58–64; model 3274–3275).                                       | Same div, direct asset, label/dot and family rule (`app-rail.tsx:202–267`; CSS `7912–7932`).                                                                                                                                                    |
|    10 | Google children: Overview, Advisor, Search, Products, Assets & Audiences, Plan & Activity; optional Advisor count (lines 65–75; model 3276–3283).            | Same six/order/paths. Advisor count mirrors the real cached recommendation payload and stays absent if unavailable (`app-rail.tsx:268–295`, `382–390`; `use-shell-signals.ts:62–84`).                                                           |
|    11 | Additional platform row is conditional Klaviyo `BETA`; no TikTok/Pinterest/Snapchat rail rows (lines 76–87; model 3284).                                     | Conditional Klaviyo only when a real synced connection exists or the legacy Klaviyo route is active; no “soon” platforms in rail (`app-rail.tsx:320–335`; `nav-model.ts:93–110`).                                                               |
|    12 | `GROWTH`: Insights → Reports → Commercial Truth (lines 88–94; model 3285–3289).                                                                              | Same labels/order/exact paths; existing plan enforcement changes the click destination without adding design-absent paint (`app-rail.tsx:393–404`).                                                                                             |
|    13 | `WORKSPACE`: Integrations → Team → Settings (lines 95–101; model 3290–3294).                                                                                 | Same labels/order/exact paths and scoped routing (`app-rail.tsx:406–417`).                                                                                                                                                                      |
|    14 | Footer: static div; 32px avatar, short user name, plan line, exact chevrons; 57px rendered height (lines 103–110).                                           | Static div with real user/plan and exact hierarchy; no account menu/hover action (`app-rail.tsx:438–463`).                                                                                                                                      |
|    15 | Content column: flex column, hidden overflow (line 112).                                                                                                     | Same content-column geometry in `DashboardFrame` (`dashboard-frame.tsx:214–268`).                                                                                                                                                               |
|    16 | Header: min 56px, flex-wrap, `gap:6px 10px`, `8px 20px`, white/bottom border (line 113).                                                                     | `.adv-topbar` matches; controls are direct children so canonical wrap behavior is retained (`app-topbar.tsx:224–270`; CSS `8030–8040`).                                                                                                         |
|    17 | Business button: exact building path, seed workspace text, chevrons; 36px, intrinsic width, 13.5px/600 (lines 114–118).                                      | Same closed control with real workspace text, literal path and no Demo chip/width cap/truncation (`app-topbar.tsx:73–195`). Existing switch action remains server-bound.                                                                        |
|    18 | 1×20 divider (line 119).                                                                                                                                     | Same direct span (`app-topbar.tsx:238`).                                                                                                                                                                                                        |
|    19 | Date button: exact calendar path, `Last 28 days`, seed dates, muted chevron; 36px, 13px/500 (lines 120–125).                                                 | Same control/path/geometry; real rolling dates use workspace timezone (`app-topbar.tsx:240–248`; `DateRangePicker.tsx:1393–1420`).                                                                                                              |
|    20 | Comparison: clickable span, fixed `vs previous period`, exact title, 11px icon at stroke 2.5; binary on/off (line 126; state 3178; handler 4423).            | Same direct span and keyboard-operable binary state; the shell-owned preference starts at 28d/previous-period and narrows old custom/year on-states to previous-period (`use-persistent-date-range.ts:15–78`; `DateRangePicker.tsx:1474–1511`). |
|    21 | Flex spacer (line 127).                                                                                                                                      | Same direct flex-1 span (`app-topbar.tsx:250`).                                                                                                                                                                                                 |
|    22 | Search: one 230px button, literal search path, `Jump or act…`, mono `⌘K` (lines 128–132).                                                                    | Same launcher; no inline input/dropdown. Click or Cmd/Ctrl+K opens the one mounted command palette (`GlobalSearch.tsx:36–75`; `dashboard-frame.tsx:184–212`, `232–267`).                                                                        |
|    23 | Freshness: static 28px status span with 6px dot; seed text `Synced 12m ago` (lines 133–136).                                                                 | Same static span/geometry; colour and text are derived from real active-surface/provider freshness, never a fabricated seed (`app-topbar.tsx:254–261`; `use-shell-signals.ts:129–237`).                                                         |
|    24 | Notification: 36px button, literal bell path and 7px red/white dot (lines 137–140).                                                                          | Same button/path. The exact dot appears only for a real unread state; loading/error/zero do not create prototype unread data (`NotificationBell.tsx:60–167`; CSS `9678–9708`).                                                                  |
|    25 | Avatar: static 34px blue circle, 12px/600 seed initials (line 141).                                                                                          | Same static span with real user initials and literal 9999px radius (`app-topbar.tsx:265–267`).                                                                                                                                                  |
|    26 | Main: internal vertical scroller; page max width 1560 and `24px 28px 48px` padding (lines 143–144).                                                          | `.adv-main`/`.adv-page` preserve the same scroll and container contract (`dashboard-frame.tsx:240–262`; CSS `8302–8314`).                                                                                                                       |

## Closed defects

`SHELL-01` through `SHELL-20` are closed. `SHELL-10`–`SHELL-20` were found by
the Batch 1 full-source/render re-read and were added to the central defect
inventory.

The shared shell implementation keeps the server-resolved Meta/Google provider
catalogs. Its effective workspace envelope accepts an account only when it
exists in that authorized catalog, preserves single/portfolio scope, and
carries the creative evidence window. The public `/c/[businessId]/**`
compatibility URL still performs its existing switch-business redirect into
`/app/**`; the otherwise-direct scoped layout also fails closed if its
server-authorized envelope and hydrated client selection disagree.

## Verification

- `npm run test:dashboard-v2:shell-acceptance` — pass on the isolated Batch 1
  worktree at `1024×900`, `1280×900`, `1440×900`, and `1728×1000` in one
  Chromium process, DPR 1. Before capture it verifies all 12 canonical package
  files and five pinned font responses, then waits for loaded fonts.
- Fixed primitive measurements match: rail 248px; footer 57px; direct topbar
  tag order `button, span, button, span, span, button, span, button, span`;
  control height/padding/radius/font/line-height; parent-row paint; no inline
  search input; no interactive footer; no browser-originated API/provider
  mutation request reached the server. Page-view instrumentation is fulfilled
  in-memory and never reaches the local acceptance database. This does not
  claim zero provider traffic from server rendering: server-side reads are
  outside the browser interceptor.
- At 1024, 1440 and 1728 the real-data header height currently matches the
  canonical 95/56/56px. At 1280 the live reviewer fixture is 93px while the
  prototype seed is 95px because real business/date/freshness strings have
  different intrinsic widths. This is a data-driven wrap result, not a fixed
  geometry mismatch, and is not presented as zero-pixel proof.
- Relevant Vitest run: 21 files / 208 tests passed, including A/B business
  binding, provider/evidence envelope, route-family navigation, plan gates,
  freshness, command-palette and notification contracts.
- Authenticated route acceptance passed for `/app/home`; Meta, Google, Settings
  and Home navigation retained the expected compatibility family and active
  business. A no-follow `/c/<active>/home` request returned the existing exact
  307 switch-business target without executing the session-writing switch
  page. One read-only `/api/auth/me` response was captured outside the browser
  and replayed in memory; browser Overview reads received typed, value-free
  payloads and all other browser `/api/**` reads were fulfilled as unavailable
  in memory. Page telemetry was fulfilled with 204, and every non-GET or
  external browser request was blocked before dispatch; no browser API/provider
  mutation request reached the server. Server-render reads are outside this
  interception boundary and are not reported as zero provider traffic.
- Full ESLint, TypeScript typecheck, production build and `git diff --check`
  passed on the isolated branch.
- Screenshots: `/tmp/adsecute-dashboard-v2-batch-01-shell-isolated-readonly/`.

`npm run test:dashboard-v2:visual-strict` is deliberately not a Batch 1 gate.
Its prototype seed data and production real-data render cannot be equal by
construction, and the current fixture marker does not seed production view
models. The shell acceptance above compares the exact fixed contract while
leaving R1 intact.
