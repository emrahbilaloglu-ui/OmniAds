# Dashboard v2 — design parity defect inventory

Generated 2026-08-17 by a 28-agent audit: every `data-screen-label` section of
`Adsecute Dashboard v2.dc.html` was inventoried in full and diffed against the
code that renders it, then every claim was re-checked by an independent
adversarial verifier that opened both sides again. 36 further claims were
rejected at that stage and are not listed here.

Categories: **EXTRA** = the app renders something the design never defines →
delete. **MISSING** = the design defines it and the app has nothing → build it.
**WRONG** = present in both but diverging → correct it. **GEOMETRY** = a pinned
px/weight/hex value differs → match it. Current totals are **134 EXTRA**, **179
WRONG**, **81 GEOMETRY**, and **64 MISSING**.

**458 verified divergences, 139 of them high severity.** The original audit
found 418; the Batch 1 full-source re-read added 11 shell findings
(`SHELL-10`–`SHELL-20`), and the Batch 2 full-source re-read added 29 Overview
findings (`OVERVIEW-28`–`OVERVIEW-56`).

| Screen                                        | Findings | High |
| --------------------------------------------- | -------: | ---: |
| Shell chrome (left rail + top bar)            |       20 |    0 |
| Overview                                      |       56 |   10 |
| Meta Decision Center                          |       34 |   12 |
| Creative Studio                               |       38 |   16 |
| Launchpad + Automation                        |       23 |    4 |
| Google Ads Overview + Advisor                 |       35 |   13 |
| Google Ads Search + Products                  |       26 |   11 |
| Google Ads Assets & Audiences + Plan          |       21 |    4 |
| Klaviyo + Integrations                        |       23 |    3 |
| Insights - outer tabs + Analytics tab         |       36 |   11 |
| Insights - SEO tab + AI visibility (GEO) tab  |       37 |   11 |
| Reports (incl. the drag-drop builder)         |       35 |   25 |
| Commercial Truth + Team + Settings            |       39 |    9 |
| Creative evidence window + Copy detail drawer |       35 |   10 |

---

## Shell chrome (left rail + top bar)

### Batch 1 implementation status

Canonical source read in full for this batch: markup lines **23–144**, initial
state line **3178**, navigation model lines **3229–3294**, and comparison toggle
lines **4415–4423** of `Adsecute Dashboard v2.dc.html` at SHA-256
`d65c0117871aa392fb2f93e79d02540f6538be6a00b1d2ecea03bdd9f8432193`.

| ID       | Status | Current proof                                                                                                                                                     |
| -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHELL-01 | CLOSED | Parent ink/weight are unconditional; only family background is conditional.                                                                                       |
| SHELL-02 | CLOSED | Meta Decisions and Google Advisor receive real cached counts through a per-child map.                                                                             |
| SHELL-03 | CLOSED | V2 comparison is one keyboard-operable binary span; the shared dashboard preference normalizes every supported on-state to previous-period.                       |
| SHELL-04 | CLOSED | Closed business trigger contains only icon, real business name and chevrons.                                                                                      |
| SHELL-05 | CLOSED | Freshness is a non-interactive span.                                                                                                                              |
| SHELL-06 | CLOSED | Topbar avatar is a static span.                                                                                                                                   |
| SHELL-07 | CLOSED | Unified route bodies begin immediately inside the shared frame; no posture banner is injected, and the server-authorized provider/evidence envelope is preserved. |
| SHELL-08 | CLOSED | Date chevron is pinned to `#7A869E`.                                                                                                                              |
| SHELL-09 | CLOSED | One `Jump or act…` launcher opens the single mounted Command Palette.                                                                                             |
| SHELL-10 | CLOSED | Rail account footer is a static div and has no menu.                                                                                                              |
| SHELL-11 | CLOSED | Rail/footer hover-only paint absent from the design was removed.                                                                                                  |
| SHELL-12 | CLOSED | Building, calendar, compare, search and bell glyph geometry uses the literal design paths/strokes.                                                                |
| SHELL-13 | CLOSED | Business trigger is intrinsic; no app-only width cap or truncation.                                                                                               |
| SHELL-14 | CLOSED | Shell inheritance is 16px/normal, matching the canonical body inheritance.                                                                                        |
| SHELL-15 | CLOSED | Fresh Dashboard v2 preference is Last 28 days with comparison on; persisted off stays off and noncanonical on-states normalize to previous-period.                |
| SHELL-16 | CLOSED | Platform images bypass Next raster optimisation; the source asset is rendered directly.                                                                           |
| SHELL-17 | CLOSED | A real unread notification uses the design's 7×7 dot, never a count or `?` badge.                                                                                 |
| SHELL-18 | CLOSED | Rail navigation rows use the design's clickable div control type while preserving scoped routing and plan redirects.                                              |
| SHELL-19 | CLOSED | Brand and platform image alternative text matches the design source.                                                                                              |
| SHELL-20 | CLOSED | Date, comparison, search, freshness, bell and avatar are direct topbar children in design order.                                                                  |

Prototype seed literals are not production data. `4` Decisions, `3` Advisor,
`Synced 12m ago`, `Aurora Supply Co.`, `Emrah B.` and the red notification dot
are rendered only when the equivalent real state exists. A missing snapshot
remains absent/`—` under R1. Consequently `test:dashboard-v2:visual-strict` is
not used or reported as a fidelity gate; Batch 1 proof is the source inventory
plus fixed-style/render geometry acceptance.

Batch 1 was isolated from the broader implementation work before acceptance.
The clean branch retains Meta/Google provider catalog reads for `/app/**` and
the defense-in-depth `/c/[businessId]/**` layout; focused tests prove that URL
scope can only narrow to an authorized provider account and that creative
evidence windows survive the shell change. The existing public `/c/**`
switch-business redirect remains the compatibility authority and is tested as
such rather than being misreported as a second durable browser route family.

### SHELL-01 · MEDIUM · GEOMETRY — Meta and Google Ads parent rows drop to child-row ink (#a8b3c7) and weight 500 when their family is not the active route

- **Design:** canonical model lines 3261 and 3275 define the Meta and Google parents. Only `bg` is conditional; `color: '#E7ECF5'` and `weight: 600` are unconditional, so both platform headers always read brighter and heavier than the children beneath them.
- **Code before:** app/globals.css applied child ink/weight until the active-family selector overrode it.
- **Resolution:** `.adv-rail-item--parent` now owns the bright ink/600 weight unconditionally; `[data-family="true"]` changes only the background.

### SHELL-02 · MEDIUM · MISSING — Google Ads › Advisor can never render the red count chip the design defines

- **Design:** canonical markup lines 66–72 render the optional Advisor count; model line 3278 seeds it. The design gives exactly two rail counts, Decisions and Advisor.
- **Code before:** the count condition and prop were hard-bound to Meta's `pulse` child, so `.adv-rail-count` was unreachable for `google-advisor`.
- **Resolution:** `PlatformBlock` accepts a per-child count map; Meta and Google counts bind to their real cached payloads and remain absent when no snapshot exists.

### SHELL-03 · MEDIUM · WRONG — Compare control is a four-preset popover whose caption can change; the design pins a binary toggle with a fixed literal

- **Design:** canonical markup line 126 and handler line 4423 define one clickable span, one fixed `vs previous period` caption and two icon/paint states.
- **Code before:** the shell chip opened a four-preset comparison popover and could read custom or previous-year text.
- **Resolution:** the V2 trigger is a keyboard-operable binary span; its shell-owned preference narrows every supported on-state to previous-period while preserving a persisted off state.

### SHELL-04 · LOW · EXTRA — Workspace switcher trigger carries a "Demo" tag chip the design's closed switcher never has

- **Design:** canonical markup lines 113–118 contain only the Building icon, bare workspace text and chevrons inside the closed trigger.
- **Code before:** a green `Demo` tag sat between the workspace name and chevron.
- **Resolution:** the closed trigger contains only the canonical three children; real business state remains available inside the dropdown.

### SHELL-05 · LOW · EXTRA — Freshness chip is a clickable refresh button; the design draws a non-interactive status span

- **Design:** canonical markup lines 133–136 define a status span with no click, title or cursor.
- **Code before:** freshness was a button whose handler refetched provider status.
- **Resolution:** `AppTopbar` renders the same non-interactive status span; real active-surface freshness still supplies its text and tone.

### SHELL-06 · LOW · EXTRA — Topbar avatar is a navigation button to Settings; the design draws a static badge

- **Design:** canonical markup lines 137–141 place a static 34px avatar span directly after the bell.
- **Code before:** the avatar was a button that navigated to Settings.
- **Resolution:** the topbar avatar is a static span with real user initials.

### SHELL-07 · LOW · EXTRA — Reviewer / demo posture banners are injected above every page body on /app/** and /c/** routes, in the other design system's tokens

- **Design:** canonical markup lines 143–146 begin the selected screen immediately inside the main page container.
- **Code before:** reviewer/demo posture notices were injected above every `/app/**` and `/c/**` body.
- **Resolution:** the unified shell passes only the route body into `DashboardFrame`; authorization/read-only state remains enforced without design-absent shell paint.

### SHELL-08 · LOW · GEOMETRY — Date-range trigger chevron inherits the label colour instead of the design's #7A869E

- **Design:** canonical markup lines 120–125 pin the date chevron stroke to `#7A869E`, lighter than the trigger label.
- **Code before:** the chevron inherited the trigger's `#45526B` text colour.
- **Resolution:** the V2 chevron now carries the literal `#7A869E` colour.

### SHELL-09 · LOW · WRONG — Search is a live inline combobox with its own result dropdown, not the design's ⌘K launcher button — and the palette written for it is dead code

- **Design:** canonical markup lines 128–132 define one 230px `Jump or act…` button with a mono `⌘K` chip and no inline result list.
- **Code before:** the topbar rendered a live combobox/result panel while the written command-palette module was unmounted.
- **Resolution:** the topbar contains one launcher; click or Cmd/Ctrl+K opens the single mounted Command Palette, which owns entity results.

### SHELL-10 · LOW · EXTRA — Rail account footer was an interactive account menu; the design footer is static

- **Design:** shell markup lines 103–110 — one plain `<div>` containing a 32px avatar, two text lines and the two-chevron SVG. It has no `onClick`, button, dropdown or hover state.
- **Code before:** `components/layout/v2/app-rail.tsx` rendered the footer as a button backed by a dropdown with Settings, Integrations and sign-out actions.
- **Resolution:** `app-rail.tsx:438–463` now renders the same static div hierarchy; account actions remain available on their named routes.

### SHELL-11 · LOW · EXTRA — Rail rows and footer painted hover states the design never defines

- **Design:** markup lines 32–110 contain no `style-hover` on home, platform, child, growth, workspace or footer nodes. Only active/background state from `nav()` is defined at data-model lines 3229–3233.
- **Code before:** `.adv-rail-item:hover`, `.adv-rail-child:hover` and `.adv-rail-foot:hover` added background/ink changes.
- **Resolution:** those selectors were deleted; the rail row and footer blocks at `app/globals.css:7884–7968` and `:8008–8027` contain only the design's base, active and family-state paint.

### SHELL-12 · LOW · GEOMETRY — Shell glyph paths and compare stroke were nominal Lucide equivalents, not the literal design geometry

- **Design:** building line 115, calendar line 121, compare line 126 (`stroke-width="2.5"`), search line 129 (`4.35`) and bell line 138 each pin an exact path.
- **Code before:** Lucide `Building2`, `Calendar`, `Search`, `Bell` and the default-width check icon produced different SVG paths/strokes; isolated DPR1 renders differed.
- **Resolution:** literal paths are in `app-topbar.tsx:40–53`, `DateRangePicker.tsx:1393–1410`, `GlobalSearch.tsx:53–64`, and `NotificationBell.tsx:124–135`; both comparison states use `2.5` at `DateRangePicker.tsx:1471–1508`.

### SHELL-13 · LOW · GEOMETRY — Business trigger had an app-only width cap and truncation

- **Design:** markup lines 114–118 size the business trigger intrinsically and render the name as a bare text node; no max-width, overflow or ellipsis is defined.
- **Code before:** the trigger used `max-w-[240px]` and a truncated name span, changing long-name geometry.
- **Resolution:** `app-topbar.tsx:145–154` has no width cap or truncation; it preserves the real workspace name under R1.

### SHELL-14 · LOW · GEOMETRY — Shell inherited 13px/1.45 instead of the canonical body's 16px/normal

- **Design:** body/root lines 14–23 set the font family but no body font size or line height, so Chromium computes `16px` and `normal`; visible shell children then apply their literal sizes.
- **Code before:** `.adv-shell` set `font-size:13px;line-height:1.45`, expanding unsized line boxes and making inherited computed styles different.
- **Resolution:** `app/globals.css:7799–7808` now uses `font-size:16px;line-height:normal`; every explicitly sized rail/topbar primitive retains its canonical literal.

### SHELL-15 · LOW · WRONG — A fresh user started at Last 30 days with comparison off, opposite the design's initial state

- **Design:** topbar line 122 says `Last 28 days`; state line 3178 initializes `cmpOn:true`.
- **Code before:** `DEFAULT_DATE_RANGE` used `rangePreset:"30d"` and `comparisonPreset:"none"`.
- **Resolution:** the generic picker default remains `30d`/off for unrelated consumers. `hooks/use-persistent-date-range.ts:15–58` gives Dashboard v2 its own `28d`/`previousPeriod` default, preserves a persisted off state, and normalizes every supported noncanonical on-state to `previousPeriod` before the shell reads or writes it.

### SHELL-16 · LOW · GEOMETRY — Next image optimisation resampled the Meta raster logo

- **Design:** markup line 42 renders the original `Meta.png` directly at 13×13 inside a 20×20 white box.
- **Code before:** `next/image` routed the PNG through `/_next/image?...w=32&q=75`, producing a different DPR1 raster despite an identical source hash.
- **Resolution:** platform images set `unoptimized` at `app-rail.tsx:228–236`; the browser receives the canonical asset unchanged.

### SHELL-17 · LOW · WRONG — Notification status used a number/`?` badge instead of the design's 7×7 red dot

- **Design:** markup lines 137–140 define a bell with one `7px × 7px`, `#E8434A`, `1.5px` white-bordered dot and no text.
- **Code before:** unread counts and read failures rendered a minimum-14px text badge.
- **Resolution:** `NotificationBell.tsx:87–141` renders a dot only for a real unread state; `app/globals.css:9697–9706` pins the exact dot geometry. Loading, failure and genuine zero do not fabricate a prototype unread state.

### SHELL-18 · LOW · WRONG — Rail navigation tags were anchors/buttons while the design uses clickable div rows

- **Design:** home, platform, child, growth and workspace rows are all `<div onClick>` at markup lines 33–100.
- **Code before:** unlocked rows were anchors and plan-locked rows were buttons, so tag-level DOM differed even when pixels matched.
- **Resolution:** `app-rail.tsx:151–200` and `:251–295` use clickable divs. The handlers still call the same family-scoped route and redirect locked destinations through the existing plan boundary.

### SHELL-19 · LOW · WRONG — Brand/platform images suppressed alternative text present in the design

- **Design:** markup line 27 uses `alt="Adsecute"`; lines 42 and 60 use `alt="Meta"` and `alt="Google Ads"`.
- **Code before:** these images used empty alt text/`aria-hidden` presentation semantics.
- **Resolution:** `app-rail.tsx:228–236` and `:348–356` use the same non-empty labels.

### SHELL-20 · LOW · WRONG — Wrapper nodes changed the topbar's direct-child hierarchy and wrap points

- **Design:** markup lines 113–142 have this direct child sequence: business button → divider span → date button → comparison span → flex spacer → search button → freshness span → bell button → avatar span.
- **Code before:** date/comparison, search and notification controls were wrapped in extra grouping nodes, so flex wrapping differed at 1024/1280 widths.
- **Resolution:** `app-topbar.tsx:224–268`, the V2 fragment in `DateRangePicker.tsx:1377–1508`, `GlobalSearch.tsx:44–74` and the Radix `asChild` bell trigger at `NotificationBell.tsx:93–143` preserve the design's direct sequence.

---

## Overview

### Batch 2 implementation status

Canonical source read in full for this batch: markup lines **147–367**, state
and model lines **3178–3257** and **3295–3336**, and comparison/interaction
lines **4415–4426** of `Adsecute Dashboard v2.dc.html` at SHA-256
`d65c0117871aa392fb2f93e79d02540f6538be6a00b1d2ecea03bdd9f8432193`.

| ID          | Status | Current proof                                                                                                                            |
| ----------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| OVERVIEW-01 | CLOSED | Store & customer value is a fixed four-card projection: AOV, New customers, Repeat rate and LTV : CAC.                                   |
| OVERVIEW-02 | CLOSED | The required New customers card binds to the real GA4 first-time-purchaser value/series and falls back to `—`.                           |
| OVERVIEW-03 | CLOSED | Web analytics always includes the fourth Conv rate card, backed only by GA4 purchase CVR.                                                |
| OVERVIEW-04 | CLOSED | Attribution has the canonical fixed columns; the design-absent column chooser, Clicks and CTR are absent.                                |
| OVERVIEW-05 | CLOSED | Edit cost model is the canonical inert Overview affordance; no Overview cost-model drawer is mounted.                                    |
| OVERVIEW-06 | CLOSED | Overview status chips, tags and sync state use the literal canonical positive, negative, warning, info and automation colours.           |
| OVERVIEW-07 | CLOSED | Every comparison spark tooltip includes the current line and the canonical previous-value/delta second line when comparison data exists. |
| OVERVIEW-08 | CLOSED | Attribution headings are static text, with the design's fixed `Spend ↓` caption and no sort controls.                                    |
| OVERVIEW-09 | CLOSED | Store sparklines are always green and Web sparklines always amber, independent of trend direction.                                       |
| OVERVIEW-10 | CLOSED | The hero metric caption is pinned to `Revenue`.                                                                                          |
| OVERVIEW-11 | CLOSED | The first hero tile caption is pinned to `Ad Spend`.                                                                                     |
| OVERVIEW-12 | CLOSED | The fourth hero tile caption is pinned to `Conv Rate · GA4`.                                                                             |
| OVERVIEW-13 | CLOSED | Platform cards expose `Purchases`, not a generic Conversions caption.                                                                    |
| OVERVIEW-14 | CLOSED | Web captions and order are Sessions, Engagement, Avg session and Conv rate.                                                              |
| OVERVIEW-15 | CLOSED | Store captions are the canonical AOV, New customers, Repeat rate and LTV : CAC literals.                                                 |
| OVERVIEW-16 | CLOSED | The fourth hero tile uses the literal canonical Percent glyph.                                                                           |
| OVERVIEW-17 | CLOSED | Share snapshot preserves the server operation but renders no toast, URL panel, copy action or dismiss control.                           |
| OVERVIEW-18 | CLOSED | Share snapshot is a text-only button with no leading glyph.                                                                              |
| OVERVIEW-19 | CLOSED | Compact stat labels use the canonical 9px computed size.                                                                                 |
| OVERVIEW-20 | CLOSED | Attribution table headings use the canonical 10px computed size.                                                                         |
| OVERVIEW-21 | CLOSED | AI brief kind tags use the canonical 9px computed size.                                                                                  |
| OVERVIEW-22 | CLOSED | The Overview eyebrow uses the canonical 11px computed size.                                                                              |
| OVERVIEW-23 | CLOSED | Both page-head buttons use the canonical 14px horizontal padding.                                                                        |
| OVERVIEW-24 | CLOSED | Hero-tile delta chips use 11.5px type and a 3px internal gap.                                                                            |
| OVERVIEW-25 | CLOSED | Hero-tile icon squares use the literal canonical icon/background colours.                                                                |
| OVERVIEW-26 | CLOSED | The cost-model affordance always reads `Edit cost model`; data availability never changes its caption.                                   |
| OVERVIEW-27 | CLOSED | Blended ROAS always retains `· target`; a real commercial-truth target is formatted to two decimals and unavailable data renders `—`.    |
| OVERVIEW-28 | CLOSED | Hero placement ignores persisted pin order and always renders Revenue followed by Ad Spend, Blended ROAS, Orders and Conv Rate.          |
| OVERVIEW-29 | CLOSED | Every required hero, attribution, platform, store and web shell remains mounted; unavailable producer values render `—`.                 |
| OVERVIEW-30 | CLOSED | Meta account rows are collapsed into one provider-level Meta card/attribution row, with ROAS and CPA recalculated from totals.           |
| OVERVIEW-31 | CLOSED | Attribution is fixed to Meta Ads, Google Ads, Klaviyo and Organic · GA4; TikTok, Pinterest and Snapchat are absent.                      |
| OVERVIEW-32 | CLOSED | Missing channel measures remain `null` and render `—`; no absent Klaviyo or Organic value is fabricated as zero.                         |
| OVERVIEW-33 | CLOSED | Attribution Share is spend share over known paid spend, matching the canonical column contract; it is not filtered revenue share.        |
| OVERVIEW-34 | CLOSED | Ad Spend uses the canonical info-blue treatment even when its comparison delta is positive.                                              |
| OVERVIEW-35 | CLOSED | Web tiles retain the canonical order instead of producer-array order.                                                                    |
| OVERVIEW-36 | CLOSED | LTV : CAC uses ratio formatting and Avg session uses duration formatting, including `—` for unavailable values.                          |
| OVERVIEW-37 | CLOSED | Spark tooltip current lines use the metric's canonical formatter rather than a generic number formatter.                                 |
| OVERVIEW-38 | CLOSED | AI brief is bounded to exactly Opportunity, Risk and Action rows; no fourth producer item can expand the card.                           |
| OVERVIEW-39 | CLOSED | A missing hero comparison renders the canonical neutral chip treatment instead of the app's generic gray fallback.                       |
| OVERVIEW-40 | CLOSED | Compact spark tooltip position, marker radius/stroke and hover hit geometry match the canonical chart primitive.                         |
| OVERVIEW-41 | CLOSED | Platform sync pill dot gap and horizontal padding match the literal canonical geometry.                                                  |
| OVERVIEW-42 | CLOSED | Attribution channel icon-to-label spacing matches the canonical row geometry.                                                            |
| OVERVIEW-43 | CLOSED | Compact metric values do not inherit the design-absent `adv-num` tracking treatment.                                                     |
| OVERVIEW-44 | CLOSED | Negative deltas use the canonical Unicode minus `−`, never an ASCII hyphen.                                                              |
| OVERVIEW-45 | CLOSED | Regenerate uses the canonical caption and button radius.                                                                                 |
| OVERVIEW-46 | CLOSED | Overview controls do not add native `title` tooltips absent from the canonical DOM.                                                      |
| OVERVIEW-47 | CLOSED | All four hero-tile icons use the canonical literal SVG paths, including the receipt-text Ad Spend glyph.                                 |
| OVERVIEW-48 | CLOSED | Attribution's first header and body cells use 16px padding on both sides.                                                                |
| OVERVIEW-49 | CLOSED | Each platform pill derives `Synced <age> ago` only from a successful real `latestSync.finishedAt`; unavailable evidence renders `—`.     |
| OVERVIEW-50 | CLOSED | Filter channels remains the canonical unbound input, with no filtering, invented empty row, or focus-border repaint.                     |
| OVERVIEW-51 | CLOSED | Tooltip formatting is card-specific at all value sizes; currency/session compaction and integer cards follow the canonical formatter.    |
| OVERVIEW-52 | CLOSED | Each chart has one relative wrapper and retains an empty SVG shell when real trend data is unavailable.                                  |
| OVERVIEW-53 | CLOSED | Attribution uses fixed `en-US` punctuation instead of the host browser locale.                                                           |
| OVERVIEW-54 | CLOSED | Share and Regenerate retain canonical opacity and caption while their existing in-flight write guards are active.                        |
| OVERVIEW-55 | CLOSED | Share snapshot fails closed when the real business name is absent rather than minting a fabricated `Workspace` report.                   |
| OVERVIEW-56 | CLOSED | The page header uses the canonical flex contract without shared app-only child flex-basis/grow rules.                                    |

### OVERVIEW-01 · HIGH · EXTRA — "Store & customer value" renders up to 10 tiles; the design defines exactly 4

- **Design:** 00-overview.html:170 "<sc-for list="{{ storeTiles }}" as="s" hint-placeholder-count="4">"; data-model.js:152-156 storeTiles is a fixed, named four: "{ k: 'AOV' }", "{ k: 'New customers' }", "{ k: 'Repeat rate' }", "{ k: 'LTV : CAC' }". No gross-sales, refund, return or revenue-per-customer tile exists anywhere in the fragment. Verified by reading all 220 lines of the fragment and data-model.js:151-156.
- **Code:** app/(dashboard)/overview/legacy-page.tsx:420-423 "const storeAndCustomerMetrics = useMemo(() => [...storeMetrics, ...ltvMetrics], ...)", fed to TileCard at :575-580 which maps every entry to a StatTile (:623-626). app/api/overview-summary/route.ts:519-604 storeMetrics = "store-aov", "store-gross-sales", "store-refunded-revenue", "store-refund-rate", "store-return-events", "store-return-rate" (6); :610-673 ltv = "ltv-average", "ltv-cac", "ltv-repeat-rate", "ltv-revenue-per-customer" (4).
- **Fix:** Restrict the Store & customer value card to the design's four tiles — AOV, New customers, Repeat rate, LTV : CAC. Move Gross Sales, Refunded Revenue, Refund Rate, Return Events, Return Rate, Average Customer LTV and Revenue per Customer to Commercial Truth.

### OVERVIEW-02 · HIGH · MISSING — "New customers" tile absent from Store & customer value

- **Design:** data-model.js:154 "{ k: 'New customers', v: '4,102', d: '+11.2%', dFg: C.pos[1], line: SG[0], fill: SG[1], ... }" — the second of the four storeTiles rendered by 00-overview.html:170.
- **Code:** app/api/overview-summary/route.ts:519-604 (storeMetrics) and :610-673 (ltv) contain no new-customers card. The series already exists: app/(dashboard)/overview/legacy-page.tsx:679 "const ga4NewCustomersSeries = ga4Daily.map((p) => ({ date: p.date, value: rv(p.firstTimePurchasers) }))", and it is wired to an orphan key at :785 ""store-new-customers": ga4NewCustomersSeries" that no card id ever matches, so patchCard (:809) never uses it.
- **Fix:** Add a "store-new-customers" metric card backed by GA4 firstTimePurchasers and place it second in the Store & customer value card; the sparkline key is already plumbed.

### OVERVIEW-03 · HIGH · MISSING — "Conv rate" tile absent from Web analytics · GA4 (3 tiles instead of 4)

- **Design:** 00-overview.html:195 "<sc-for list="{{ webTiles }}" as="s" hint-placeholder-count="4">"; data-model.js:157-161 webTiles = "Sessions", "Engagement", "Avg session", "Conv rate".
- **Code:** app/api/overview-summary/route.ts:931-970 "const webAnalytics" holds exactly three cards: "web-sessions" (:933), "web-session-duration" (:946), "web-engagement-rate" (:959). Rendered via app/(dashboard)/overview/legacy-page.tsx:581-586. This is not an honest data gap: the GA4 conversion-rate series is already computed at legacy-page.tsx:675 "ga4ConvRateSeries" and consumed by the hero band.
- **Fix:** Add a "web-conversion-rate" card to the webAnalytics array using the existing GA4 conversion-rate series so the card carries the design's four tiles.

### OVERVIEW-04 · MEDIUM · EXTRA — Attribution "Columns" opens a checkbox popover exposing Clicks and CTR columns the design never defines

- **Design:** 00-overview.html:71 is a bare button "Columns" with no onClick and no menu markup; the thead at :77-84 defines exactly eight columns — Channel, Spend ↓, Revenue, ROAS, CPA, AOV, Conv., Share. Grepping the fragment for "clicks"/"ctr" returns nothing, and there is no popover, dropdown or checkbox markup in the whole attribution article (:66-112).
- **Code:** components/overview/v2/attribution-card.tsx:92-115 renders an absolutely-positioned "w-[190px]" popover of checkboxes over every entry of COLUMNS; COLUMNS at :26-35 includes "{ key: "clicks", label: "Clicks" }" and "{ key: "ctr", label: "CTR" }". The popover also lets the user remove CPA and AOV, which the design pins as always present. (Default render does match: DEFAULT_COLUMNS at :39 is the design's six.)
- **Fix:** Drop the Clicks and CTR entries from COLUMNS so no column outside the design's set can be added, and reduce the "Columns" control to the design's plain affordance (or a menu limited to the six defined metric columns).

### OVERVIEW-05 · MEDIUM · EXTRA — Cost-model side drawer built from off-token shadcn chrome — the design draws no modal on Overview

- **Design:** 00-overview.html:9 defines "Edit cost model" as a button with no handler and no result surface. Grepping the full 4462-line "Adsecute Dashboard v2.dc.html" for "cost model" returns exactly one hit (line 155, that same button); "COGS" appears only as Commercial Truth copy (lines 4219, 4289, 4299). No drawer, sheet or cost-model form exists anywhere in the design.
- **Code:** app/(dashboard)/overview/legacy-page.tsx:486 "onClick={() => setCostModelSheetOpen(true)}" and :589-600 "<CostModelSheet …/>". components/overview/CostModelSheet.tsx:68-115 renders a shadcn "Sheet"/"SheetContent side="right"" with SheetTitle "Set cost model", fields "COGS %", "Shipping %", "Fees %", "Fixed monthly cost", and "Cancel" / "Save cost model" buttons; :132-133 and :142 style it with "text-neutral-800", "border-neutral-200", "text-neutral-500" and "rounded-xl" — none of which exist in the v2 token set (app/globals.css:107-136).
- **Fix:** Route "Edit cost model" to the Commercial Truth surface that owns the cost model; if the drawer must stay on Overview, rebuild it in the v2 token language (--adv-border, --adv-ink-*, --adv-r-tile) instead of shadcn neutral-grey chrome.

### OVERVIEW-06 · MEDIUM · GEOMETRY — Every status colour on Overview comes from the muted --adc-* palette, not the design's C palette

- **Design:** data-model.js:62 fixes the whole status palette: "const C = { pos: ['#E7F6F0','#0E9F6E','#BFE5D6'], neg: ['#FDECF0','#E11D48','#F6C6D2'], warn: ['#FBF3E1','#B45309','#EBD6A4'], info: ['#EAF0FF','#2F6BFF','#CBD9FF'], auto: ['#F1EBFB','#6C41BE','#DACBF2'] }". Overview paints with it in four places: the platform sync pill hard-codes it inline at 00-overview.html:139 "background:#E7F6F0;color:#0E9F6E" (dot also #0E9F6E); the hero-tile delta chip at :43 "background:{{ t.deltaBg }};color:{{ t.deltaFg }}"; the attribution ROAS chip at :98 "background:{{ row.roasBg }};color:{{ row.roasFg }}"; the AI-brief kind tag at :125 "background:{{ b.bg }};color:{{ b.fg }}".
- **Code:** app/globals.css:92-104 defines a desaturated substitute set — "--adc-danger-fg: #a6224a; --adc-danger-bg: #fbedf1;" "--adc-pos-fg: #0b6b4f; --adc-pos-bg: #e9f4ef;" "--adc-info-fg: #1d5fc4; --adc-info-bg: #ebf1fb;" "--adc-caution-fg: #86590a; --adc-caution-bg: #faf2df;" — none of which equal the design's values (the neutral --adv-* set at :107-136 does match exactly, which is what makes the --adc-* drift stand out). These tokens reach the screen through app/globals.css:8230-8249 ".adv-chip[data-tone="pos"|"neg"|…]" and ".adv-tag[data-tone=…]" (:8267-8288), components/overview/v2/platform-card.tsx:91-94 (sync pill), attribution-card.tsx:204-211 (ROAS chip), and metric-band.tsx:191-196 (StatTile delta text). The auditor caught only the four hero-tile icon squares; the chips, pills, tags and delta text are a separate and larger surface.
- **Fix:** Remap the --adc-* status tokens used by the v2 surfaces to the design's C palette — pos #E7F6F0/#0E9F6E, neg #FDECF0/#E11D48, warn #FBF3E1/#B45309, info #EAF0FF/#2F6BFF, auto #F1EBFB/#6C41BE — or introduce --adv-pos-_/--adv-neg-_/--adv-info-* aliases carrying those hexes and point .adv-chip, .adv-tag, the sync pill and the ROAS chip at them, so the whole screen shares one status palette.

### OVERVIEW-07 · MEDIUM · MISSING — Sparkline tooltip drops the design's second line (previous value + delta %)

- **Design:** Every sparkline in the fragment carries a two-line tooltip: 00-overview.html:32 (hero), :58 (hero tiles), :156 (platform stats), :184 (store tiles), :209 (web tiles) each end with "<sc-if value="{{ …c.cmp }}"><span style="display:block;margin-top:1px;color:#8FA3C8;font-weight:400">{{ …c.tip2 }}</span></sc-if>"; data-model.js builds tip2 as "'prev ' + fmt(pvals[i]) + ' · ' + (dlt >= 0 ? '+' : '−') + Math.abs(dlt).toFixed(1) + '%'".
- **Code:** components/overview/v2/adv-sparkline.tsx:175-198 — the tooltip body is a single expression "{formatDay(points[index]!.date)} · {format(points[index]!.value)}" with no second span. "previousPoints" is used only for the dashed path (:128-138) and the shared scale (:21-31), so the comparison value is available but never printed.
- **Fix:** When "previousPoints" has a value at the hovered index, append the design's second line — a block span, margin-top 1px, color #8FA3C8, font-weight 400 — reading "prev <formatted previous value> · ±x.x%".

### OVERVIEW-08 · MEDIUM · WRONG — Attribution column headers are sort buttons; the design has static text with a fixed "Spend ↓"

- **Design:** 00-overview.html:78 "<th style="…">Spend ↓</th>" — plain text inside th; :79-83 Revenue/ROAS/CPA/AOV/Conv. are plain text too. There is no button, onClick or focusable element anywhere in the thead (:75-86).
- **Code:** components/overview/v2/attribution-card.tsx:123-143 wraps spend/revenue/roas/conversions header labels in "<button type="button" className="cursor-pointer bg-transparent …" onClick={() => setSortKey(column.key as SortKey)}>" and appends "" ↓"" conditionally at :136.
- **Fix:** Render every th label as plain text with a static "↓" on Spend. If interactive sorting must stay, keep the text identical and move the handler onto the th so no nested button/focus ring appears.

### OVERVIEW-09 · MEDIUM · WRONG — Store and Web tile sparklines are coloured by trend direction, not by card

- **Design:** data-model.js:151 "const SG = ['#0E9F6E','rgba(14,159,110,0.08)'], WO = ['#B45309','rgba(180,83,9,0.07)']"; every storeTile (:152-156) carries "line: SG[0], fill: SG[1]" and every webTile (:157-161) carries "line: WO[0], fill: WO[1]" — including the falling "Conv rate" tile at :161 whose delta is "−0.4%" yet still draws amber. Colour is per card, not per direction.
- **Code:** components/overview/v2/metric-band.tsx:213-227 StatTile passes "line={direction === "down" ? "#E11D48" : direction === "up" ? "#0E9F6E" : "#2F6BFF"}" with matching fills, where "direction = metric.trendDirection" (:190). A declining Web tile therefore draws red and a flat one blue.
- **Fix:** Give TileCard a tone prop and pass a fixed pair into StatTile — #0E9F6E / rgba(14,159,110,0.08) on Store & customer value, #B45309 / rgba(180,83,9,0.07) on Web analytics · GA4.

### OVERVIEW-10 · MEDIUM · WRONG — Hero metric label reads "Total Revenue"; the design pins "Revenue"

- **Design:** 00-overview.html:16 "<p style="…">Revenue</p>" — literal markup, not a template variable, in the hero card's mono eyebrow.
- **Code:** app/api/overview-summary/route.ts:422-423 "id: "pins-revenue", title: tr("Total Revenue", "Toplam Gelir")"; printed verbatim by components/overview/v2/metric-band.tsx:101 via "metricLabel(metric)" (:78-80 returns "metric.title").
- **Fix:** Rename the "pins-revenue" card title to "Revenue".

### OVERVIEW-11 · MEDIUM · WRONG — Spend tile label reads "Total Spend"; the design pins "Ad Spend"

- **Design:** data-model.js:121 "label: 'Ad Spend'" — the first heroTile, rendered at 00-overview.html:47.
- **Code:** app/api/overview-summary/route.ts:437-438 "id: "pins-spend", title: tr("Total Spend", "Toplam Harcama")". lib/overview-metric-catalog.ts:62-68 DEFAULT_PINNED_METRICS places "spend" first after revenue, so this is the first hero tile.
- **Fix:** Rename the "pins-spend" card title to "Ad Spend".

### OVERVIEW-12 · MEDIUM · WRONG — Conversion-rate tile label reads "Conversion Rate"; the design pins "Conv Rate · GA4"

- **Design:** data-model.js:124 "label: 'Conv Rate · GA4'" — the fourth heroTile.
- **Code:** app/api/overview-summary/route.ts:483-484 "id: "pins-conversion-rate", title: tr("Conversion Rate", "Conversion Rate")". The resolved source is held separately as "sourceLabel: storeConversionSource.label" (:489) and never reaches the tile — metric-band.tsx:163 prints only "metric.title".
- **Fix:** Set the title to "Conv Rate · <source>" using the already-resolved "storeConversionSource" (GA4 or Shopify).

### OVERVIEW-13 · MEDIUM · WRONG — Platform card's fourth stat is captioned "Conversions"; the design pins "Purchases"

- **Design:** data-model.js:142 "{ k: 'Purchases', v: '3,845', … }" (Meta) and :148 "{ k: 'Purchases', v: '1,982', … }" (Google) — the fourth of the five stats rendered at 00-overview.html:143-146. Stat order in both design and app is Spend, Revenue, ROAS, Purchases, CPA.
- **Code:** lib/overview-summary-support.ts:322 "title: "Conversions"" on the "${provider}-purchases" card; printed by components/overview/v2/platform-card.tsx:113 "{metric.title}".
- **Fix:** Rename the "${provider}-purchases" stat title from "Conversions" to "Purchases".

### OVERVIEW-14 · MEDIUM · WRONG — Web analytics tile captions differ from the design

- **Design:** data-model.js:159 "{ k: 'Engagement', v: '63.4%' }" and :160 "{ k: 'Avg session', v: '2m 41s' }".
- **Code:** app/api/overview-summary/route.ts:947 "title: tr("Session Duration", "Oturum Suresi")" and :960 "title: tr("Engagement Rate", "Etkilesim Orani")", rendered as tile keys by metric-band.tsx:199-201.
- **Fix:** Rename "web-session-duration" to "Avg session" and "web-engagement-rate" to "Engagement".

### OVERVIEW-15 · MEDIUM · WRONG — Store/LTV tile captions differ from the design

- **Design:** data-model.js:155 "{ k: 'Repeat rate', v: '34.2%' }" and :156 "{ k: 'LTV : CAC', v: '3.2x' }".
- **Code:** app/api/overview-summary/route.ts:656 "title: tr("Repeat Purchase Rate", "Tekrar Satin Alma Orani")" on "ltv-repeat-rate", and :628 "title: "LTV / CAC"" on "ltv-cac".
- **Fix:** Rename "ltv-repeat-rate" to "Repeat rate" and "ltv-cac" to "LTV : CAC".

### OVERVIEW-16 · MEDIUM · WRONG — Fourth hero tile uses a Wallet icon where the design draws a Percent icon

- **Design:** data-model.js:124 the "Conv Rate · GA4" tile's icon path is "M19 5L5 19 M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" — the percent glyph — painted at 00-overview.html:41. The other three (receipt, concentric target, cart) match the app.
- **Code:** components/overview/v2/metric-band.tsx:30 "const TILE_ICONS: LucideIcon[] = [Receipt, Target, ShoppingCart, Wallet];" and :138 "TILE_ICONS[index % TILE_ICONS.length]". lib/overview-metric-catalog.ts:62-68 DEFAULT_PINNED_METRICS = revenue, spend, blended_roas, orders, conversion_rate, so index 3 is the conversion-rate tile and renders "Wallet".
- **Fix:** Replace "Wallet" with lucide "Percent" at index 3 of TILE_ICONS.

### OVERVIEW-17 · LOW · EXTRA — Share snapshot spawns a fixed bottom toast with the share URL, "Copy link" and a dismiss X

- **Design:** 00-overview.html:10 is a plain button "Share snapshot" with no handler and no result surface. Scanning all 220 lines of the fragment there is no toast, link display, copy control or dismiss control anywhere on Overview.
- **Code:** components/overview/v2/share-snapshot-button.tsx:91-143 renders a "fixed bottom-5 left-1/2 z-50 w-[min(560px,calc(100vw-32px))]" status bar carrying the minted URL (:106-111), a "Copy link" / "Copied" button (:112-128) and an "aria-label="Dismiss"" icon button (:131-141).
- **Fix:** Surface the minted link through the shell's own notification chrome rather than a bespoke fixed bar on Overview. (Note: the bar is at least on-token — it uses --adv-* variables — so this is presentation placement, not palette.)

### OVERVIEW-18 · LOW · EXTRA — "Share snapshot" button carries an icon the design's button does not have

- **Design:** 00-overview.html:10 "<button style="…background:#2F6BFF…">Share snapshot</button>" — text-only, no svg child. The design does nest svgs in icon-bearing controls elsewhere (e.g. :18, :41), so the omission is deliberate.
- **Code:** components/overview/v2/share-snapshot-button.tsx:83-88 renders "<Share2 className="h-3.5 w-3.5" />" (or "<Loader2 …/>" while working) before the caption; ".adv-btn" supplies an 8px gap (app/globals.css:8044).
- **Fix:** Drop the Share2/Loader2 glyph so the primary CTA is text-only; keep the disabled state for the in-flight case.

### OVERVIEW-19 · LOW · GEOMETRY — Tile stat labels render at 12px; the design pins 9px

- **Design:** 00-overview.html:145 (platform stat key), :172 (store tile key) and :197 (web tile key) all pin "font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:0.08em;color:#7A869E".
- **Code:** app/globals.css:8365-8371 ".adv-label { margin:0; font-family: var(--adv-font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--adv-ink-3); }" — consumed by components/overview/v2/platform-card.tsx:113 and metric-band.tsx:199.
- **Fix:** Set ".adv-label" font-size to 9px (letter-spacing and colour already match).

### OVERVIEW-20 · LOW · GEOMETRY — Attribution table headers render at 12px; the design pins 10px

- **Design:** 00-overview.html:77-84 — every th pins "font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em".
- **Code:** app/globals.css:8393-8404 ".adv-table th { padding: 9px 12px; … font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.1em; … }" — used by components/overview/v2/attribution-card.tsx:119 "className="adv-table"".
- **Fix:** Set ".adv-table th" font-size to 10px.

### OVERVIEW-21 · LOW · GEOMETRY — AI brief kind tags render at 12px; the design pins 9px

- **Design:** 00-overview.html:125 pins "font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:0.08em;border-radius:5px;padding:3px 7px" on the "{{ b.kind }}" tag.
- **Code:** app/globals.css:8255-8265 ".adv-tag { font-family: var(--adv-font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; border-radius: 5px; padding: 3px 7px; … }" — used by components/overview/v2/ai-brief-card.tsx:82.
- **Fix:** Set ".adv-tag" font-size to 9px (radius and padding already match).

### OVERVIEW-22 · LOW · GEOMETRY — Page eyebrow renders at 12px; the design pins 11px

- **Design:** 00-overview.html:4 pins "font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7A869E" on the "Home" eyebrow.
- **Code:** app/globals.css:8341-8348 ".adv-eyebrow { … font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--adv-ink-3); }" — used by app/(dashboard)/overview/legacy-page.tsx:475.
- **Fix:** Set ".adv-eyebrow" font-size to 11px.

### OVERVIEW-23 · LOW · GEOMETRY — Page-head buttons use 12px horizontal padding; the design pins 14px

- **Design:** 00-overview.html:9 and :10 both pin "height:36px;padding:0 14px;border-radius:9px".
- **Code:** app/globals.css:8041-8057 ".adv-btn { … height: 36px; padding: 0 12px; border-radius: var(--adv-r-control); … }" (--adv-r-control is 9px, globals.css:135, so only the padding diverges) — applied at app/(dashboard)/overview/legacy-page.tsx:485 and components/overview/v2/share-snapshot-button.tsx:79.
- **Fix:** Set ".adv-btn" padding to "0 14px".

### OVERVIEW-24 · LOW · GEOMETRY — Hero-tile delta chip is 12px with a 4px gap; the design pins 11.5px with a 3px gap

- **Design:** 00-overview.html:43 pins "display:inline-flex;align-items:center;gap:3px;border-radius:9999px;padding:2px 8px;font-size:11.5px;font-weight:600" on the hero-tile delta chip. (The hero card's own chip at :17 is 12px/gap 4px/padding 3px 9px and the app matches that one inline at metric-band.tsx:54.)
- **Code:** app/globals.css:8217-8228 ".adv-chip { display:inline-flex; align-items:center; gap: 4px; border-radius: 9999px; padding: 2px 8px; font-size: 12px; font-weight: 600; … }" — used for the tile chip at components/overview/v2/metric-band.tsx:65 and :41.
- **Fix:** Set ".adv-chip" font-size to 11.5px and gap to 3px.

### OVERVIEW-25 · LOW · GEOMETRY — Hero-tile icon squares use muted token greens/ambers instead of the design's hexes

- **Design:** data-model.js:122 "tileBg: '#0E9F6E'" (Blended ROAS) and :124 "tileBg: '#B45309'" (Conv Rate), painted at 00-overview.html:40 "background:{{ t.tileBg }}". Tiles 1 and 3 ("#0B1020", "#6C41BE") do match the app's tokens.
- **Code:** components/overview/v2/metric-band.tsx:23-28 TILE_TONES uses "bg: "var(--adc-pos-fg)"" and "bg: "var(--adc-caution-fg)"", which app/globals.css:98 and :95 define as "#0b6b4f" and "#86590a". (The line/fill values in the same table already match the design exactly, so only the icon-square background diverges.)
- **Fix:** Paint the tile icon squares with the design's literal hexes — #0B1020, #0E9F6E, #6C41BE, #B45309 — rather than the muted --adc-*-fg tokens.

### OVERVIEW-26 · LOW · WRONG — Cost-model button caption flips to "Set cost model"; the design pins one caption

- **Design:** 00-overview.html:9 "Edit cost model" — the only caption for this control in the fragment, and the only "cost model" string in the entire 4462-line design file.
- **Code:** app/(dashboard)/overview/legacy-page.tsx:488 "{effectiveSummary?.costModel.configured ? "Edit cost model" : "Set cost model"}".
- **Fix:** Always render "Edit cost model".

### OVERVIEW-27 · LOW · WRONG — Blended ROAS tile drops the design's "· target <value>" suffix

- **Design:** data-model.js:122 "label: 'Blended ROAS · target 3.80'" — the second heroTile.
- **Code:** app/api/overview-summary/route.ts:468-469 "id: "pins-blended-roas", title: "Blended ROAS"" — no target segment; metric-band.tsx:163 prints the title verbatim. The app does carry a target concept (lib/business-operating-mode.ts:157 "targetPack.targetRoas"), so the segment is implementable.
- **Fix:** Append the workspace's configured target to the label as "Blended ROAS · target <value>", falling back to plain "Blended ROAS" when no target pack is set.

### OVERVIEW-28 · HIGH · WRONG — Persisted pin preferences can reorder or replace the canonical five-metric hero

- **Design:** markup lines 164–204 and model lines 3205–3227 define one Revenue hero followed by the fixed Ad Spend, Blended ROAS, Orders and Conv Rate tiles; there is no pin-preference state in the canonical model.
- **Code before:** the page resolved a stored metric-catalog pin list and used those keys to select/reorder the hero and four supporting metrics.
- **Resolution:** Overview ignores stored pin order and projects the canonical five IDs in the canonical order while preserving the real metric payloads.

### OVERVIEW-29 · HIGH · WRONG — Required cards disappear when a producer or metric is unavailable instead of rendering the design's fixed shells with `—`

- **Design:** markup lines 164–360 use fixed placeholder counts for the hero, attribution, platform, store and web regions; model lines 3205–3257 define their required identities.
- **Code before:** provider filtering, metric filtering and empty-array branches removed whole required cards when a producer was disconnected or returned no value.
- **Resolution:** every canonical shell remains mounted and unavailable measurements are represented as `null`/`—` under R1.

### OVERVIEW-30 · HIGH · WRONG — Multiple Meta accounts render as multiple platform/attribution entries instead of one Meta provider rollup

- **Design:** markup lines 268–308 and model lines 3241–3253 define exactly one Meta card and one Meta Ads attribution row.
- **Code before:** account-level `overview.platforms` rows flowed through directly, so a workspace with multiple Meta accounts could expand the canonical provider count.
- **Resolution:** account rows are collapsed by provider; spend, revenue, conversions and clicks are summed and ROAS/CPA are recalculated from those totals.

### OVERVIEW-31 · HIGH · WRONG — Attribution channels come from enabled integrations and omit the canonical Organic row

- **Design:** markup lines 227–266 and model lines 3230–3240 pin four rows in order: Meta Ads, Google Ads, Klaviyo and Organic · GA4.
- **Code before:** the table inherited dynamic provider rows, including TikTok, Pinterest or Snapchat, and had no guaranteed Organic · GA4 row.
- **Resolution:** the adapter returns exactly the four canonical channels in design order; unsupported providers remain confined to Integrations.

### OVERVIEW-32 · HIGH · WRONG — Missing attribution values are fabricated as numeric zero

- **Design:** the fixed rows are presentation identities, not evidence that a producer supplied measurements; R1 requires unavailable real values to render `—`.
- **Code before:** absent provider/channel values were coerced through zero-valued fallbacks, making unavailable Klaviyo or Organic measurements look measured.
- **Resolution:** missing values stay `null` through the view model and render `—`; zero is shown only when the producer actually supplies zero.

### OVERVIEW-33 · HIGH · WRONG — Attribution Share is calculated from filtered revenue even though the canonical column is spend share

- **Design:** markup lines 238 and 253–258 place Share alongside the spend-led attribution model; model lines 3230–3240 derive the displayed percentages from paid spend proportions.
- **Code before:** the Share cell used each displayed row's fraction of filtered revenue, changing both its meaning and values.
- **Resolution:** `spendShare` is computed against known paid spend and stored as percentage points; unavailable denominators render `—`.

### OVERVIEW-34 · MEDIUM · WRONG — Ad Spend changes to a positive green treatment when spend rises

- **Design:** model lines 3210–3216 give Ad Spend the info-blue icon/chip family; that semantic colour is fixed independently of comparison direction.
- **Code before:** the generic trend-tone resolver painted any positive delta green, including Ad Spend.
- **Resolution:** the Ad Spend tile owns the canonical info-blue treatment while its real comparison text remains unchanged.

### OVERVIEW-35 · MEDIUM · WRONG — Web analytics tile order follows producer order instead of the canonical order

- **Design:** markup lines 340–360 and model lines 3254–3257 order the tiles Sessions → Engagement → Avg session → Conv rate.
- **Code before:** the API/page order placed Avg session before Engagement and omitted or appended Conv rate conditionally.
- **Resolution:** the page projects the four named IDs in canonical order, independent of producer-array order.

### OVERVIEW-36 · MEDIUM · WRONG — LTV : CAC and Avg session use generic numeric formatting

- **Design:** model lines 3250–3257 render LTV : CAC as a ratio and Avg session as a duration, not as currency/decimal output.
- **Code before:** both values passed through the generic compact-number/currency formatter, producing incorrect units and punctuation.
- **Resolution:** the named cards use ratio and duration formatters respectively, and unavailable inputs remain `—`.

### OVERVIEW-37 · MEDIUM · WRONG — Spark tooltip current lines ignore each metric's display formatter

- **Design:** markup lines 172–357 and model lines 3295–3336 format tooltip values with the same metric semantics as their cards.
- **Code before:** the tooltip's current line used one generic number formatter, so currency, percent, ratio and duration cards diverged.
- **Resolution:** each sparkline receives its metric formatter for the current and previous lines.

### OVERVIEW-38 · MEDIUM · EXTRA — AI brief can render an unbounded producer list beyond the canonical three rows

- **Design:** markup lines 310–337 and model lines 3318–3336 define exactly Opportunity, Risk and Action.
- **Code before:** every returned brief item was mapped, so a fourth producer item expanded the card and changed downstream geometry.
- **Resolution:** the presentation adapter selects the three canonical kinds in canonical order and supplies no extra row.

### OVERVIEW-39 · MEDIUM · WRONG — A missing hero comparison uses the app's generic gray chip instead of the canonical neutral chip

- **Design:** markup lines 184–201 and model lines 3205–3227 define the neutral comparison treatment used when no directional comparison is present.
- **Code before:** the shared fallback tone substituted a different gray background, border and ink.
- **Resolution:** the no-comparison branch uses the canonical neutral chip colours and geometry while keeping its value honest.

### OVERVIEW-40 · LOW · GEOMETRY — Compact chart hover marker and tooltip geometry differ from the canonical spark primitive

- **Design:** markup lines 174–357 and interaction model lines 4415–4426 pin the tooltip offset and the hovered dot's radius/stroke relationship.
- **Code before:** the compact chart reused the hero chart's larger hover target/marker and a different tooltip offset.
- **Resolution:** compact charts use the canonical marker radius, stroke, hit region and tooltip position.

### OVERVIEW-41 · LOW · GEOMETRY — Platform sync pill uses the wrong dot gap and horizontal padding

- **Design:** markup lines 272–277 pin the sync pill's compact inline gap and horizontal inset.
- **Code before:** the shared status-pill spacing produced a wider pill than the canonical Meta/Google cards.
- **Resolution:** the platform card applies the literal canonical gap and horizontal padding.

### OVERVIEW-42 · LOW · GEOMETRY — Attribution channel icon-to-label spacing is too wide

- **Design:** markup lines 244–251 define the icon wrapper and its literal gap to the channel label.
- **Code before:** a generic flex-gap utility expanded every channel cell.
- **Resolution:** the channel cell uses the canonical icon/text gap.

### OVERVIEW-43 · LOW · GEOMETRY — Compact metric values inherit design-absent numeric letter spacing

- **Design:** markup lines 290–357 sets the compact values' size/weight but no tracking override.
- **Code before:** `adv-num` added numeric letter spacing to platform, store and web values.
- **Resolution:** compact values no longer carry `adv-num`; their computed tracking matches normal canonical inheritance.

### OVERVIEW-44 · LOW · WRONG — Negative comparison text uses an ASCII hyphen instead of the canonical minus glyph

- **Design:** model lines 3295–3336 construct negative deltas with Unicode minus `−`.
- **Code before:** tooltip/chip formatting emitted ASCII `-`, changing both the glyph and its advance width.
- **Resolution:** negative deltas consistently use Unicode minus `−`.

### OVERVIEW-45 · LOW · GEOMETRY — AI brief Regenerate control has the wrong radius and caption geometry

- **Design:** markup lines 314–320 pin the `Regenerate` caption and the button's literal radius/insets.
- **Code before:** the shared button primitive supplied a different radius and spacing.
- **Resolution:** the control uses the canonical caption, radius and padding while retaining the existing refresh operation.

### OVERVIEW-46 · LOW · WRONG — Overview adds native browser tooltips through `title` attributes absent from the design

- **Design:** markup lines 147–367 contain no native `title` tooltip on Overview controls; authored hover surfaces are limited to chart tooltips.
- **Code before:** icon/status/control elements added explanatory `title` attributes, creating browser-native overlays outside the canonical interaction model.
- **Resolution:** design-absent `title` attributes are removed from Overview; accessible names remain available through visible labels or ARIA where required.

### OVERVIEW-47 · LOW · GEOMETRY — Ad Spend uses a different receipt glyph from the canonical literal path

- **Design:** model line 3296 defines `M4 2v20… M8 7h8 M8 11h8 M8 15h5`, a receipt-text glyph, and markup lines 186–188 paint that path in the first hero tile.
- **Code before:** `metric-band.tsx` imported Lucide `Receipt`, whose current package path contains a dollar-sign receipt and rasterises differently.
- **Resolution:** all four hero tiles now render the literal paths from model lines 3296–3299, so package icon revisions cannot alter the design.

### OVERVIEW-48 · LOW · GEOMETRY — Attribution's first column has 12px right padding instead of 16px

- **Design:** markup lines 223 and 236 pin the first `th` to `9px 16px` and first `td` to `11px 16px`.
- **Code before:** shared `.adv-table` supplied 12px right padding and only overrode the first cell's left side, shifting all later column boundaries.
- **Resolution:** the first header/body cells own the exact two-sided padding inline.

### OVERVIEW-49 · HIGH · WRONG — Platform freshness pills show readiness labels rather than the real last successful sync age

- **Design:** markup line 285 and model lines 3313/3319 define `Synced <age> ago` in the positive pill.
- **Code before:** Overview passed the generic readiness resolver, so the same slot could read `Active`, `Core ready`, `Needs attention`, or a blue fabricated fallback.
- **Resolution:** the slot derives age only from a successful `latestSync.finishedAt`; failed, invalid or missing evidence renders the same green shell with `Synced —` under R1.

### OVERVIEW-50 · MEDIUM · EXTRA — Filter channels mutates the table and invents an empty-state row

- **Design:** markup line 216 is an unbound input with no handler and `outline:none`; the four attribution rows remain fixed.
- **Code before:** controlled React state filtered the rows, emitted `No attributed channels for this window.`, and shared focus CSS repainted the border blue.
- **Resolution:** the input is unbound and owns the literal inline geometry; it neither changes the fixed rows nor gains an app-only focus colour.

### OVERVIEW-51 · MEDIUM · WRONG — One generic tooltip formatter changes card semantics at low and high values

- **Design:** model lines 3295–3336 define a formatter per metric: money/session series always use one-decimal `k`, purchase/customer series use rounded integers, and ratios/percentages pin their own precision.
- **Code before:** generic compacting emitted `900` for 900 Sessions, `1.2k` for 1,200 Purchases and `1.2m` above one million.
- **Resolution:** `metric-format.ts` dispatches by canonical metric id, preserving those exact contracts at every value size.

### OVERVIEW-52 · LOW · GEOMETRY — Chart callers add a second wrapper and missing data removes the SVG shell

- **Design:** every chart in markup lines 167–206 and 296–357 has one relative wrapper containing the SVG, conditional hover nodes and scrubber.
- **Code before:** each caller wrapped `AdvSparkline`, which then rendered a second relative div; an unavailable series returned a plain height div instead of SVG.
- **Resolution:** margin belongs to the single `AdvSparkline` wrapper and unavailable data retains an empty labelled SVG without fabricated paths.

### OVERVIEW-53 · MEDIUM · WRONG — Attribution punctuation depends on the operator's browser locale

- **Design:** model lines 3301–3306 pin comma thousands and dot decimals.
- **Code before:** attribution used `toLocaleString(undefined)`, so a Turkish locale could render dot thousands and comma decimals.
- **Resolution:** attribution values use explicit `en-US` punctuation while retaining the real workspace currency symbol and `—` when that symbol is unavailable.

### OVERVIEW-54 · LOW · GEOMETRY — In-flight write guards dim Share and Regenerate to 55% opacity

- **Design:** markup lines 156 and 275 define no alternate disabled paint or caption.
- **Code before:** the existing guarded buttons inherited `.adv-btn:disabled { opacity:.55 }` while their requests were pending.
- **Resolution:** the write guards and disabled semantics remain intact, but the controls explicitly retain canonical opacity, cursor and captions.

### OVERVIEW-55 · LOW · WRONG — Share snapshot can fabricate `Workspace` as a report owner/name

- **Design:** R1 requires real data or `—`; no `Workspace` seed/fallback appears in the Overview contract.
- **Code before:** a missing business name minted `${businessName ?? "Workspace"} snapshot`, producing a confident invented report name.
- **Resolution:** sharing is fail-closed until both the authorized business id and its real name are present; no provider/report write is attempted otherwise.

### OVERVIEW-56 · LOW · GEOMETRY — Shared page-header child rules add flex basis/grow absent from Overview

- **Design:** markup lines 148–157 define only the wrapping header row and its two ordinary child divs.
- **Code before:** `.adv-page-head` added a 360px basis/grow to the identity child plus action-cluster flex rules, changing computed layout and long-name wrap points.
- **Resolution:** Overview uses the literal header row utilities and ordinary children, leaving the separate sub-1024 responsive contract outside the reference range.

---

## Meta Decision Center

### META-01 · HIGH · EXTRA — Act Now lane is split into three server sections with headers the design never draws

- **Design:** 01-meta-decision-center.html:74-99 — the action lane is "<sc-if value="{{ laneAction }}">" wrapping a single "<sc-for list="{{ actionRows }}">" inside a plain "display:flex;flex-direction:column;gap:8px" container. No section header, count badge or note line appears anywhere in the lane.
- **Code:** MetaPlatformPage.tsx:3707-3714 "<section data-decision-section="integrity_fires">" + MetaLaneSectionHeader title="Integrity fires" note="delivery, policy, tracking · scan …"; 3740-3745 "money_moves" header "Money moves" note="Campaign and ad-set actions · ranked from server evidence"; 3789-3803 "creative_rotation" header "Creative rotation"/"Ad decisions" note="Legacy creative-grain calls · review only". Wrapped in "styles.osSections" (gap 18px), not a flat gap-8 list.
- **Fix:** Remove the three MetaLaneSectionHeader blocks and their notes and render one flat card list.

### META-02 · HIGH · EXTRA — "Since last snapshot" overnight digest strip has no counterpart in the design

- **Design:** 01-meta-decision-center.html:74-99 — the left queue column contains only the action card list. There is no collapsible digest, no "since last snapshot" line, and no label-flip/action/anomaly/deferral summary anywhere in the fragment.
- **Code:** MetaPlatformPage.tsx:3677-3685 renders "<MetaOvernightDigest …>" unconditionally at the top of the queue when the inspector is not pushed, and again at 4114-4121 inside the idle inspector. MetaOvernightDigest (1147-1199) emits a toggle reading "Since last snapshot" plus a four-part summary line. It has no null guard — it always renders.
- **Fix:** Remove the MetaOvernightDigest strip from the queue column and from the inspector idle panel.

### META-03 · HIGH · EXTRA — Inspector body carries 14 numbered sections against the design's unnumbered block set

- **Design:** 01-meta-decision-center.html:227-266 defines exactly: entity identity, "Decision contract", "Engine reasoning", "Money impact · ROAS vs target", the Confidence/Readiness two-up, "Blockers", the evidence key/value rows, the CTA, and the provenance line. Nothing is numbered.
- **Code:** MetaDrillDrawer.tsx SectionLabel calls carry number props 1-14 at lines 718, 745, 411, 806, 821, 833, 865, 878, 484, 888, 904, 927, 934, 945 — adding "Precedent", "Automation readiness", "Maturity", "Ad set depth", "Creative evidence", "Entity timeline", "Notes & protection", "Provenance", "Raw JSON" as numbered sections.
- **Fix:** Trim the inspector to the design's block set and remove the numeric prefixes from the section labels.

### META-04 · HIGH · MISSING — The two-way scope switch (Campaigns & Ad sets / Creatives) does not exist

- **Design:** 01-meta-decision-center.html:52-56 — a white r11 pill container wrapping "<sc-for list="{{ scopeTabs }}" hint-placeholder-count="2">"; data-model.js:406 "[['structure','Campaigns & Ad sets',4],['creatives','Creatives',3]]". The entire queue is gated on "{{ scopeStructure }}" (line 59) / "{{ scopeCreatives }}" (line 179), and the lane row itself only exists inside the structure branch.
- **Code:** MetaPlatformPage.tsx:3559-3607 — the only tab nav is "styles.osAreaTabs" (Act Now / Monitor / Inactive assets / History / Deferred). Repo grep for "Campaigns & Ad sets" hits only components/meta/decision-center/DecisionCenterBody.tsx:303, and I confirmed DecisionCenterBody/DecisionCenterView are imported by nothing outside their own folder — the rendered surface is app/(dashboard)/platforms/meta/legacy-page.tsx → MetaPlatformPage (mounted by app/app/[[...path]]/page.tsx case "meta"). Creative decisions are instead a third section inside the Act Now lane (line 3789 "data-decision-section="creative_rotation"").
- **Fix:** Add the scope pill switch above the lane row with captions "Campaigns & Ad sets" and "Creatives" plus counts, and move the creative decision list out of Act Now into the Creatives scope branch.

### META-05 · HIGH · MISSING — Creatives scope body missing: posture tile row and the Creative Studio footnote panel

- **Design:** 01-meta-decision-center.html:180-188 renders "{{ creativePosture }}" as 4 r12 tiles with a 3px coloured top border (data-model.js:413-418: 'Fatigued spend share' 41%, 'Winner concentration' 38%, 'Avg frequency · 28d' 3.2, 'Refresh pipeline' 2); lines 215-218 render the dashed r12 panel with the "only three ad-level calls — refresh, retire, scale winner" copy plus an "Open Creative Studio →" link.
- **Code:** grep over components/ and app/ for "Fatigued spend share|Winner concentration|Refresh pipeline|Open Creative Studio" returns exactly one hit: MetaPlatformPage.tsx:1631, an "Open Creative Studio" button inside the creative evidence drawer footer. No posture tiles and no dashed footnote panel exist on the page.
- **Fix:** Build the 4-tile creative posture row and the dashed footnote panel with the design's copy and the "Open Creative Studio →" link inside the Creatives scope.

### META-06 · HIGH · WRONG — Lane tab set and captions replaced: 5 pills become 3 underline tabs plus nested Monitor sub-tabs

- **Design:** 01-meta-decision-center.html:61-66 renders "{{ laneTabs }}" as five sibling pills; data-model.js:163-165 "lanes = [action 'Action Now' 4, watching 'Watching' 7, healthy 'Healthy' 12, nonsales 'Non-sales' 2, archive 'Archive' 30]".
- **Code:** MetaPlatformPage.tsx:3565 "<span>Act Now</span>", 3585 "<span>Monitor</span>", 3599 "<span>Inactive assets</span>" — three only. Watching / Healthy / Non-sales are demoted to a second-level "styles.monitorSegments" tablist at 3832-3861 with captions "Watch · N", "Healthy context · N", "Out of sales scope · N".
- **Fix:** Render all five lanes as sibling pill tabs with the design captions Action Now / Watching / Healthy / Non-sales / Archive and delete the nested monitorSegments tablist.

### META-07 · HIGH · WRONG — The 5-card KPI band is rendered as a single flat text strip

- **Design:** 01-meta-decision-center.html:18-50 — "display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px" holding five "<article style="border-radius:14px;background:#ffffff;border:1px solid #E4E8F0;padding:14px">" cards with 24px/700 Space Grotesk tabular values.
- **Code:** MetaPlatformPage.tsx:1081 "<div className="pulse pulse--thin" data-testid="meta-business-strip">" holding bare "<span>" runs; app/globals.css:2914-2925 ".ad-final .pulse--thin { display:flex; flex-wrap:wrap; gap:8px 14px; font-size:12px; padding:8px 16px; border-bottom:1px solid var(--border); }" — no cards, no radius, no 24px numerals.
- **Fix:** Replace pulse--thin with the design's five-card auto-fit grid (r14, 1px #E4E8F0, pad 14px) and 24px tabular values.

### META-08 · HIGH · WRONG — Archive lane table replaced by a row list with different columns and no Resume action

- **Design:** 01-meta-decision-center.html:156-177 — an r14 card wrapping a "<table>" whose "<thead>" columns are Entity | Status | Spend · 28d (text-align:right) | Note | blank action column; line 172 renders a 28px r8 "Resume" button when "{{ r.resumable }}" (data-model.js:191-196 supplies note + resumable per row).
- **Code:** MetaPlatformPage.tsx:4007-4031 renders MetaLaneSectionHeader title="Inactive assets" plus "styles.quietList" of MetaInactiveStructureRow / MetaInactiveAdRow. MetaInactiveStructureRow (1802-1843) is a div row with grain badge / name / Spend / ROAS / Purchases / statusLabel — no table, no Note column, no Spend · 28d header, no Resume button.
- **Fix:** Render the archive lane as the design's 5-column table inside one r14 card, with a Resume button on resumable rows.

### META-09 · HIGH · WRONG — Healthy lane loses the campaign→ad-set grouping and renders flat rows

- **Design:** 01-meta-decision-center.html:120-135 — "{{ healthyGroups }}" renders one r14 card per campaign with a #F7F9FC header strip (8px green dot, group name 13.5px/600, strategy chip, right-aligned rollup) and nested "{{ g.adsets }}" rows at "padding:10px 16px 10px 34px" with mono 11.5px stats right-aligned (data-model.js:184-189).
- **Code:** MetaPlatformPage.tsx:3925-3935 maps "boundedHealthyRows" straight into MetaQuietEntityRow; that component (1763-1800) renders a flat grid row: CMP/SET grain badge, name, Spend/ROAS/CPA, and a "Healthy" status pill — no group header, no dot, no strategy chip, no rollup, no nesting.
- **Fix:** Group healthy entities by campaign and render the design's grouped card: header strip with dot, name, strategy chip and rollup, then indented ad-set rows.

### META-10 · HIGH · WRONG — Watching lane: segment chip row becomes per-segment section headers and full action cards

- **Design:** 01-meta-decision-center.html:101-105 renders "{{ watchSegments }}" as one row of r9999 outline chips (data-model.js:178: 'Learning 2', 'Recently changed 1', 'Mid confidence 3', 'Deferred 2', 'Insufficient signal 1'); 107-116 then render compact r14 rows: seg badge / name + level pill / note / money / a 30px r8 outline "Review" button.
- **Code:** MetaPlatformPage.tsx:3866-3913 iterates META_WATCHING_SEGMENT_ORDER and emits a MetaLaneSectionHeader per segment, then renders each row with the full "MetaActionCard layout="board"". There is no segment chip row and no "Review" button anywhere in the lane.
- **Fix:** Render the segment summary as a single chip row and use a compact watching row with a "Review" button instead of the full action card.

### META-11 · HIGH · WRONG — Inspector chrome is wrong: light header with a close button instead of the dark "Evidence inspector" bar with a verdict chip

- **Design:** 01-meta-decision-center.html:222-226 — "<aside style="border-radius:16px;background:#ffffff;border:1px solid #E4E8F0;overflow:hidden;position:sticky;top:0">" whose first child is "<div style="padding:14px 16px;background:#0B1020;…">" with a mono 9.5px uppercase "Evidence inspector" eyebrow and a right-aligned "background:#0E9F6E;color:#ffffff" verdict chip reading "Scale". No close control is drawn.
- **Code:** MetaDrillDrawer.tsx:643-674 — sticky header with "background: "var(--surface)"", a MetaScopeChip, a 15px title + 12px subtitle, and a "<button aria-label="Close inspector">" with an X icon. MetaPlatformPage.module.css:1405-1413 ".contextDock { position:sticky; top:0; height:calc(100vh - 46px); border-left:1px solid var(--adc-b1); }" — no radius, no card border.
- **Fix:** Give the inspector the design's r16 card shell and a #0B1020 header bar with the mono "Evidence inspector" eyebrow plus the verdict chip; drop the close button in the push variant.

### META-12 · HIGH · WRONG — Inspector footer shows Close / Launchpad bridge instead of the verdict CTA and provenance line

- **Design:** 01-meta-decision-center.html:265 — "<button style="height:38px;border-radius:9px;background:#0E9F6E;color:#ffffff;font-size:13px;font-weight:700">Scale budget +20%</button>", one full-width CTA repeating the row's verdict; line 266 is a centred mono 10px "provenance: snapshot 2026-08-14 · rec 8f3a…c2 · raw JSON ↓".
- **Code:** MetaDrillDrawer.tsx:984-1001 — a bordered footer bar with "<button className="btn btn--sm">Close</button>" and "<button className="btn btn--primary btn--sm">Launchpad bridge</button>". Provenance lives instead inside numbered Panel 13 at 933-941. There is no full-width verdict CTA.
- **Fix:** Replace the footer with a single full-width verdict CTA in the decision tone, and place the provenance string as a centred mono line beneath it.

### META-13 · MEDIUM · EXTRA — Row selection checkboxes and a floating bulk action bar

- **Design:** 01-meta-decision-center.html:77-97 — the action card starts directly with the identity block ("<div style="min-width:0;flex:1.4">"). No checkbox, no selection affordance, and no bulk bar exists anywhere in the fragment.
- **Code:** MetaActionCard.tsx:520-533 renders "<label className="meta-row__lead"><input type="checkbox" className="sr-only" …/></label>" on every row unconditionally when onSelect is passed, and MetaPlatformPage.module.css:401-405 reserves a 16px lead column for it. MetaPlatformPage.tsx:4046-4080 renders "<div className="bulkbar">" with "N selected · …" and Defer 24h / Compare / Clear.
- **Fix:** Drop the per-row checkbox and the bulkbar; the design drives every action from the row's own primary button and ⋯ menu.

### META-14 · MEDIUM · EXTRA — Toolbar carries a Scope rail toggle, a Min spend filter and a policy sentence the design has none of

- **Design:** 01-meta-decision-center.html:60-71 — the toolbar row holds only the lane tab pills, the dashed "Deferred 2" chip, a "flex:1" spacer, the sort "<select>" and the search "<input>". Nothing else.
- **Code:** MetaPlatformPage.tsx:3611-3618 "<button className={styles.scopeToggle}><PanelLeft/>Scope</button>"; 3641-3651 "<button className={styles.minSpendToggle}>Min spend · {…}</button>"; 3652-3656 "<span className={styles.osToolbarNote}>Filters change presentation only. Server decisions remain authoritative.</span>" (module.css:1295-1300 pins it right with margin-left:auto).
- **Fix:** Remove the Scope toggle, the Min spend toggle and the toolbar note sentence.

### META-15 · MEDIUM · EXTRA — Left scope rail (Account structure / campaign tree) is not in the design

- **Design:** 01-meta-decision-center.html:73 — the body is "grid-template-columns:{{ metaGridCols }}"; data-model.js:1252 "inspectorVisible ? 'minmax(0,1.8fr) minmax(280px,1fr)' : 'minmax(0,1fr)'" — a two-column queue+inspector layout at most. No third rail column, campaign tree, or "Clear scope" control appears.
- **Code:** MetaPlatformPage.tsx:3665-3674 renders "<MetaScopeRail …>"; the component (1999-2119) emits an aside headed "Account structure" / "N campaigns" with "Selection filters decisions. It never hides account-wide calls.", an "All decisions / Full account / ALL" row, per-campaign buttons with ad-set children, and a "Clear scope" button. module.css:1317-1320 ".osQueueShellWithScope { grid-template-columns: 204px minmax(0,1fr); gap:14px; }".
- **Fix:** Remove the MetaScopeRail column and its toggle so the body is the design's queue + inspector two-column grid.

### META-16 · MEDIUM · EXTRA — Action rows carry an authority chip, a "Read evidence →" link and a why paragraph

- **Design:** 01-meta-decision-center.html:79-87 — the card's name line contains only "{{ r.name }}" and the level pill; the second line contains only the chips from "{{ r.chips }}". There is no authority chip, no inline evidence link, and no free-text reason paragraph — reasoning lives in the inspector (lines 236-241).
- **Code:** MetaActionCard.tsx:577-589 "<span className="meta-row__authority" …>{displayedActionAuthority.label}</span>" (globals.css:7181-7190 styles it as a bordered r999 chip); line 652 "<span className="meta-row__evidence-link">Read evidence →</span>"; lines 661-668 "<p className="meta-row__why" title={rec.why}>" rendered whenever boardLayout is true.
- **Fix:** Delete the authority chip, the "Read evidence →" link and the why paragraph from the action card.

### META-17 · MEDIUM · EXTRA — Idle inspector panel ("Nothing selected" / Authority / Due backs) is invented chrome

- **Design:** 01-meta-decision-center.html:221 — the aside is wrapped in "<sc-if value="{{ inspectorVisible }}">" and always renders the populated evidence panel; data-model.js:1239 "inspectorVisible = inspectorOpen && sc && st.lane === 'action'", and line 1252 collapses the grid to "minmax(0,1fr)" when it is false. The design never draws an empty-state inspector.
- **Code:** MetaPlatformPage.tsx:4105-4165 renders "styles.contextIdle" with "Account context", "Nothing selected", "Select a row to inspect evidence without moving the queue.", the overnight digest, an Authority dl (Target / Tracking / Write scope), a "Due backs" section, and footer links "Automation controls" / "Decision history". This is the default state — nothing is selected on load.
- **Fix:** Hide the inspector column when nothing is selected and collapse the grid to one column, as data-model.js:1252 does.

### META-18 · MEDIUM · EXTRA — Action card carries three extra always-on slots the design's card never defines: a signal glyph column, an account badge, and an operator response chip

- **Design:** 01-meta-decision-center.html:77-97 defines the card's complete slot list in order: identity block (name + level pill, then chips), label chip, money block, confidence pill, primary button, "⋯". There is no leading glyph column, no account badge, and no operator-response chip anywhere in the card or in data-model.js:173-176.
- **Code:** MetaActionCard.tsx:540 "<MetaRowSignal rec={rec} />" renders a dedicated blocker/shield glyph slot (globals.css:7085-7104), and MetaPlatformPage.module.css:401-405 reserves it a permanent 14px grid column ("grid-template-columns: 16px 14px minmax(0,1fr)"), so the slot occupies space even in the "data-row-signal="none"" case; MetaActionCard.tsx:567-574 renders "<span className="meta-row__account">{rowPresentation.accountBadge}</span>" (globals.css:7161); 597-603 renders "<span className="meta-row__response" data-operator-response={…}>"; 640-651 adds two "meta-row__evidence-age" spans for evidence age and bid configuration.
- **Fix:** Remove the signal column, the account badge, the response chip and the evidence-age/bid spans from the card, and collapse the grid back to the design's identity / label / money / confidence / button / ⋯ slot sequence.

### META-19 · MEDIUM · MISSING — No Labels ratio card and no Mode card; Snapshot content exists only as header text

- **Design:** 01-meta-decision-center.html:37-41 card 4 "Labels" with 24px "18/22" + "82%" + "Manage labels →" (12px/600 #2F6BFF); 42-48 card 5 "Mode" with 14px/600 "Standard" and chips "High season" / "Tracking OK"; 32-36 card 3 "Snapshot" with an r9999 #E7F6F0/#0E9F6E pill "fresh · 2h old".
- **Code:** MetaPlatformPage.tsx:1080-1141 FinalMetaPulse emits only: a Spend span, a ROAS span, a tracking chip, a context span with "N overrides · Review exceptions", and a target-freshness span. There is no labels ratio/percent, no Mode value or season chips, and no freshness pill; snapshot/engine/synced live in MetaAsOfCluster in the header (3386-3391). Narrowed from the auditor's "no equivalent" claim — the tracking and labels signals do exist as strip text, but not as the design's cards.
- **Fix:** Add Snapshot, Labels and Mode cards to the KPI band with the freshness pill, labels ratio + percent, and the mode value with its chips.

### META-20 · MEDIUM · MISSING — Action cards have no 4px tone-coloured left edge

- **Design:** 01-meta-decision-center.html:77 — "<article style="…border-left:4px solid {{ r.edge }}">", with "r.edge" per decision tone in data-model.js:173-176 (#0E9F6E, #E11D48, #B45309, #6C41BE). Repeated on the creative cards at line 190.
- **Code:** app/globals.css:7035-7044 ".ad-final .meta-row { border: 1px solid var(--border); border-radius: 8px; … }" — a uniform border. I grepped both globals.css and MetaPlatformPage.module.css for any "meta-row" rule setting border-left or an edge/tone variable and found none.
- **Fix:** Add a 4px solid left border on .meta-row driven by the decision tone.

### META-21 · MEDIUM · WRONG — Window segmented control replaced by a full date-range picker (plus an ad-account select)

- **Design:** 01-meta-decision-center.html:9-13 — the only left-hand header control is a white r9 pill with 3px padding wrapping "{{ windowKeys }}"; data-model.js:162 "['7d','14d','28d','90d']" with the active segment on "#0B1020". No account picker and no calendar control appears in the header.
- **Code:** MetaPlatformPage.tsx:3418-3445 "<DateRangePicker … rangePresets={["today","yesterday","7d","14d","28d","90d","thisMonth","lastMonth","custom"]} label="Metric date range" showComparisonTrigger={false} align="end" />", preceded by 3393-3417 "<label className={styles.accountSelect}><span>Ad account</span><select …>". The control type is a popover calendar, not a 4-segment pill.
- **Fix:** Render the four-segment 7d/14d/28d/90d pill control as the design specifies. (The account picker is a real multi-account need the mock does not model; relocating it is optional.)

### META-22 · MEDIUM · WRONG — Non-sales card: wrong tile set, wrong footnote copy, and an extra button

- **Design:** 01-meta-decision-center.html:144-152 — tiles come from "{{ upperFunnel }}" = data-model.js:190 "[{k:'Thruplay'},{k:'CPM'},{k:'CPM · acct p50'},{k:'Reach · 28d'}]"; the footnote at line 152 is "No purchase objective — shown for context only. No action is computed for this cohort."; lines 139-143 give the card a name, a level pill and exactly one chip ("Upper funnel · informational"), in that order, and no button.
- **Code:** MetaUpperFunnelInformationalCard.tsx:87-94 tiles are "Cost / ThruPlay", "ThruPlay rate", "Hook rate (3s)", "Frequency"; line 128 copy is "Brand-build cohort — no purchase decision evaluation"; lines 117-124 render three chips (MetaScopeChip, MetaCohortChip, "Informational") ahead of the title, not one after it; lines 139-147 add a "View in drawer" button.
- **Fix:** Use the design's four tile labels and footnote sentence, collapse to the single "Upper funnel · informational" chip placed after the name and level pill, and remove the View in drawer button.

### META-23 · MEDIUM · WRONG — Decision label renders as bare coloured text instead of a filled tone chip

- **Design:** 01-meta-decision-center.html:89 — "<span style="flex-shrink:0;display:inline-flex;border-radius:8px;padding:5px 11px;font-size:12.5px;font-weight:700;background:{{ r.labelBg }};color:{{ r.labelFg }}">{{ r.label }}</span>", a filled pill (data-model.js:173-176 labels Scale / Cut spend / Fix setup / Rebuild with tone bg+fg pairs).
- **Code:** MetaActionCard.tsx:605-612 "<span className="meta-row__label" data-decision-label={label} style={{ color: TONE_INK[labelTone] }}>"; app/globals.css:7250-7253 ".ad-final .meta-row__label { font-size: 12.5px; font-weight: 600; }" — no background, no radius, no padding, weight 600 not 700. I grepped MetaPlatformPage.module.css for any override and found none.
- **Fix:** Render the decision label as a filled chip: border-radius 8px, padding 5px 11px, font-weight 700, tone background plus tone foreground.

### META-24 · MEDIUM · WRONG — Money block replaced by a mono "ROAS · CPA" summary plus a corner Spend anchor; moneySub has no renderer

- **Design:** 01-meta-decision-center.html:90-93 — "<div style="flex:1.2"><p style="font-family:'Space Grotesk';font-size:15px;font-weight:600">{{ r.money }}</p><p style="font-size:11.5px;color:#7A869E">{{ r.moneySub }}</p></div>"; data-model.js:173 money "$1,240/d · ROAS 5.12", moneySub "vs 3.80 target · $8.6k upside/mo".
- **Code:** MetaActionCard.tsx:443-446 builds "boardMetricSummary" as "ROAS x× · CPA y" and 613-617 renders it as "meta-row__metric-summary"; 671-677 renders a separate "<span className="meta-row__spend-anchor"><small>Spend</small><b>…</b></span>" that module.css:464-475 absolutely positions at top:11px right:12px. The only "vs target" string in the file is at line 226, inside the confidence-band helper, not a money sub-line.
- **Fix:** Restore the design's two-line money block inside the card body: a 15px/600 primary line and an 11.5px muted sub-line stating value vs target.

### META-25 · MEDIUM · WRONG — Confidence pill says "High" with bar glyphs instead of "High confidence"

- **Design:** 01-meta-decision-center.html:94 — "<span style="…border-radius:9999px;border:1px solid {{ r.bandBd }};background:{{ r.bandBg }};color:{{ r.bandFg }};padding:3px 10px;font-size:11px;font-weight:600">{{ r.band }} confidence</span>" — literal text "High confidence", no glyph.
- **Code:** MetaActionCard.tsx:235-257 ConfidenceBandPill renders "<span className="meta-confidence-band__bars">" with three sized bars (heights 4/7/10, globals.css:7326-7340) followed by "{band.label}" only — "High"/"Medium"/"Low". The word "confidence" appears only in the aria-label at line 242.
- **Fix:** Change the visible text to "{band} confidence" and drop the three bar glyphs.

### META-26 · MEDIUM · WRONG — Entity level is plain capitalised text, not the design's bordered mono uppercase pill

- **Design:** 01-meta-decision-center.html:81 — "<span style="font-family:'IBM Plex Mono',monospace;font-size:9px;text-transform:uppercase;letter-spacing:0.08em;border:1px solid #E4E8F0;border-radius:5px;padding:2px 6px;color:#7A869E">{{ r.level }}</span>".
- **Code:** app/globals.css:7177-7181 ".ad-final .meta-row__level { color: var(--muted); font-size: 12px; text-transform: capitalize; }" — no border, no radius, no padding, no mono family, and capitalize instead of uppercase. No module.css override exists.
- **Fix:** Style .meta-row__level as a bordered mono uppercase pill: 1px border, radius 5px, padding 2px 6px, 9px, letter-spacing 0.08em.

### META-27 · LOW · EXTRA — Server suppression receipt renders a dashed footer line the design never defines

- **Design:** 01-meta-decision-center.html:75-99 and 179-218 — each lane renders its "<sc-for>" list and nothing after it. There is no "showing N of M" receipt and no suppression receipt anywhere in the fragment.
- **Code:** MetaPlatformPage.tsx:3821-3823 "<MetaServerSuppressionReceipt section={creativeDecisionSection} />"; the component (1734-1760) has no null branch — it always emits either "Creative selection unavailable · no client fallback or fabricated zero is shown" or "Server selected N of M · top K · S suppressed". Narrowed from the auditor's finding: MetaRevealReceipt (1676 "if (hidden === 0) return null") and MetaMonitorPager (1702 "if (pageCount <= 1) return null") are overflow-only controls and are not a steady-state divergence.
- **Fix:** Remove the always-on suppression receipt line, or fold it into the section note the design does not draw.

### META-28 · LOW · EXTRA — A "History" link sits inside the lane tab bar

- **Design:** 01-meta-decision-center.html:61-67 — the tab row contains the five "{{ laneTabs }}" pills, then the dashed "Deferred 2" chip, then a "flex:1" spacer. No navigation link.
- **Code:** MetaPlatformPage.tsx:3602-3605 "<a href={metaHref("/platforms/meta/history")}><History size={13}/>History</a>" rendered as a sibling of the lane tab buttons inside "styles.osAreaTabs", before the Deferred chip at 3606.
- **Fix:** Remove the History link from the lane tab bar.

### META-29 · LOW · EXTRA — Lane tabs and the sort/search filters are split across two full-width bars; the design puts them on one row

- **Design:** 01-meta-decision-center.html:60-71 is a single "<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">" that holds the lane pills, the "Deferred 2" chip, a "<span style="flex:1">" spacer, then the sort "<select>" and the search "<input>" — one row, no separator between them.
- **Code:** MetaPlatformPage.tsx:3559-3607 is "<nav className={styles.osAreaTabs}>" and 3609-3657 is a separate sibling "<div className={styles.osToolbar} data-meta-secondary-controls>"; MetaPlatformPage.module.css:1207-1215 and 1264-1272 each give their bar its own "border-bottom: 1px solid var(--adc-b1)" and "background: var(--adc-s2)", producing two stacked 43px + 45px banded rows where the design has one.
- **Fix:** Merge the sort select and search input into the lane-tab row after a flex spacer, and drop the second toolbar bar and its border.

### META-30 · LOW · GEOMETRY — Lane tabs: 34px blue pills become a 43px underline tab bar at 12px

- **Design:** 01-meta-decision-center.html:62 — "height:34px;padding:0 14px;border-radius:9999px;font-size:13px;font-weight:600;background:{{ tab.bg }};border:1px solid {{ tab.bd }}" with active bg #2F6BFF (data-model.js:169).
- **Code:** MetaPlatformPage.module.css:1207-1215 ".osAreaTabs { min-height: 43px; border-bottom: 1px solid var(--adc-b1); background: var(--adc-s2); padding: 0 14px; }"; 1217-1231 "min-width:112px; border-bottom:2px solid transparent; font-size:12px;"; 1239-1243 active is "border-bottom-color: var(--adc-ink); color: var(--adc-ink); font-weight:650" — a dark underline, not a blue pill.
- **Fix:** Restyle the lane tabs as 34px fully rounded pills at 13px/600 with a #2F6BFF active fill and a 1px border, and remove the underline container.

### META-31 · LOW · GEOMETRY — Card radius and padding are roughly half the design values, and a min-height is pinned

- **Design:** 01-meta-decision-center.html:77 "border-radius:14px;background:#ffffff;border:1px solid #E4E8F0;padding:14px 16px" for action cards; lines 19, 107, 121, 138, 156 repeat radius 14 (16 on the inspector aside at 222). No height is pinned anywhere.
- **Code:** app/globals.css:7035-7044 ".ad-final .meta-row { border-radius: 8px; padding: 9px 14px; }"; MetaPlatformPage.module.css:401-411 ".boardGrid :global(.meta-row) { border-radius: 7px; padding: 11px 12px; min-height: 158px; }", overridden at 1517-1519 by ".boardGrid :global(.meta-row) { min-height: 124px; }" (a later top-level rule, outside any media query).
- **Fix:** Set the action card radius to 14px and padding to 14px 16px, and drop the pinned min-height.

### META-32 · LOW · GEOMETRY — Header eyebrow and as-of line are 12px instead of 11px, and the as-of line carries different copy in a different slot

- **Design:** 01-meta-decision-center.html:4 eyebrow "font-size:11px;letter-spacing:0.12em"; line 6 as-of "font-size:11px" reading "synced 12m ago · snapshot 2026-08-14 · engine v3.2 · 14:05 UTC" directly under the h1; the "date range scopes metrics, not decisions" sentence sits on the scope row at line 57.
- **Code:** MetaPlatformPage.module.css:1067-1073 ".osEyebrow { font-size: 12px; letter-spacing: 0.12em; }" and 1103-1108 ".osIdentity p { font-size: 12px; }"; MetaPlatformPage.tsx:3376-3382 the p under the h1 instead reads "Snapshot … · date range scopes metrics, not decisions", while the synced/snapshot/engine cluster is MetaAsOfCluster in the right-hand tools column at 3386-3391.
- **Fix:** Set both to 11px, put the synced/snapshot/engine cluster back under the h1, and move the "date range scopes metrics, not decisions" sentence to the scope row.

### META-33 · LOW · GEOMETRY — Inspector column is a fixed 440px flush panel instead of a proportional 280px-min card

- **Design:** 01-meta-decision-center.html:73 "grid-template-columns:{{ metaGridCols }};gap:12px;align-items:start" with data-model.js:1252 "'minmax(0,1.8fr) minmax(280px,1fr)'"; line 222 the aside is "border-radius:16px;border:1px solid #E4E8F0;position:sticky;top:0".
- **Code:** MetaPlatformPage.module.css:1302-1308 ".osWorkspace { grid-template-columns: minmax(0, 1fr) 440px; gap: 0; }"; 1405-1413 ".contextDock { height: calc(100vh - 46px); border-left: 1px solid var(--adc-b1); background: var(--adc-s2); }" — full-bleed, no gap, no radius, no card border.
- **Fix:** Use minmax(0,1.8fr) minmax(280px,1fr) with a 12px gap and render the inspector as a bordered r16 card rather than a flush edge panel.

### META-34 · LOW · WRONG — Sort options and search placeholder use different captions

- **Design:** 01-meta-decision-center.html:69 "<option>Sort: Money at stake</option><option>Sort: Priority</option><option>Sort: Age</option>" — the caption is inside each option, with no external label; line 70 "<input placeholder="Search entities…" …>".
- **Code:** MetaPlatformPage.tsx:3637-3639 "<option value="money">Spend exposure</option><option value="priority">Server priority</option><option value="age">Evidence age</option>"; line 3628-3629 wraps the select in "<label className={styles.toolbarSort}>Sort" adding a visible external label; line 3624 "placeholder="Find a campaign, ad set, or decision"".
- **Fix:** Use the option captions "Sort: Money at stake", "Sort: Priority", "Sort: Age", drop the external Sort label, and set the placeholder to "Search entities…".

---

## Creative Studio

### CREATIVE-01 · HIGH · EXTRA — Audiences tab invents a "Readiness ledger" table, a "Current safe routes" aside and a "Contract needed" section

- **Design:** 02-creative-studio.html L308-373: the csAudiences block contains no ledger, no Contract/State/Evidence table, no navigation aside and no "Contract needed" panel.
- **Code:** app/(dashboard)/platforms/meta/audiences/legacy-page.tsx:77 "data-testid="audience-readiness-ledger""; :90 header cells "<span>Contract</span><span>State</span><span>Current evidence</span>" over the "audienceReadiness" array (:10-36); :123-159 aside "Current safe routes" with three Link buttons ("Review creative evidence", "Open Decisions", "Build in Launchpad"); :162-171 section "Contract needed".
- **Fix:** Delete the readiness ledger, the "Current safe routes" aside and the "Contract needed" section — chrome the design never had.

### CREATIVE-02 · HIGH · EXTRA — Studio header carries an account picker, a freshness label, a status popover and a Business STOP link the design never had

- **Design:** 02-creative-studio.html L2-11 is the whole header: eyebrow + h1 on the left, exactly two buttons on the right. No account selector, no freshness string, no info button, no kill-switch chip. shell-chrome.html carries no account control either, so this is not shell chrome relocated into the page.
- **Code:** components/creatives/StudioOsView.tsx:1077-1145 account button + :1146-1247 listbox "Assigned Meta ad accounts"; :1250-1252 "Decision context {freshnessLabel}"; :1254-1332 ⓘ button and "System status" popover; :1334-1362 Link rendering "Business STOP engaged/off/unavailable".
- **Fix:** Remove the account picker, freshness label, ⓘ status popover and Business STOP link from the screen header, or relocate them to shell chrome; the screen header is eyebrow + h1 + the two design buttons.

### CREATIVE-03 · HIGH · EXTRA — Assets tab adds an action-filter chip strip the design does not define

- **Design:** 02-creative-studio.html L17-136 (the whole csAssets block, re-read): the only controls above the table are the sort select (L21), the search input (L22), the metric-set pills (L70-72) and "+ Edit metrics" (L73). There is no per-action filter row.
- **Code:** components/creatives/StudioOsView.tsx:1795-1807 "<div className="studio-action-toolbar" ... borderBottom: "1px solid var(--b1)">", then :1808 "renderActionChip("all", "All", null)" and :1809 "primaryActionChips.map(...)", with an overflow menu following.
- **Fix:** Delete the action-filter chip strip and its overflow menu from the Assets surface.

### CREATIVE-04 · HIGH · EXTRA — Assets tab adds Optimization / Lifecycle role / Format filters and a date-range picker

- **Design:** 02-creative-studio.html L18-23 is the complete Assets toolbar: one mono caption, one sort select, one search input. The fragment contains no date control at all — periods appear only as inline text such as "· 28d".
- **Code:** components/creatives/StudioOsView.tsx:1626-1651 "<DateRangePicker ... rangePresets={["today","yesterday","7d",…]}"; :1666-1703 renderContextControl("opt", "Optimization", …); :1704-1743 renderContextControl("role", "Lifecycle role", …); :1744-1762 renderContextControl("fmt", "Format", …).
- **Fix:** Remove the date-range picker and the Optimization / Lifecycle role / Format dropdowns from the Assets toolbar.

### CREATIVE-05 · HIGH · EXTRA — Copies tab adds a two-layer header card with Compare / Angles / Usage Map / CSV / Share controls

- **Design:** 02-creative-studio.html L138-196 (the whole csCopies block) contains no header card, no mode switch, no Compare control and no export buttons — the tab starts directly with the angle cards at L139.
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:433-610 bordered header card: crumbs "Platforms · Meta · Copies" (:454-456), chip "Analysis only — decisions live in Decisions" (:459-472), "Ad account" select (:474-515), window/as-of block (:516-523); layer 2 :526-608 with "Compare" (:547), "Angles" + "needs server contract" (:568-571), "Usage Map" + the same chip (:577-580), "CSV" (:592-599) and "Share" (:600-607).
- **Fix:** Strip the two-layer header card down to the design's screen header (eyebrow + h1 + Export CSV + Share with client) and delete the Compare / Angles / Usage Map mode row.

### CREATIVE-06 · HIGH · EXTRA — Copies tab renders CreativesTopSection's filter bar and "selected creatives" workspace, plus a heat-legend footer

- **Design:** 02-creative-studio.html L138-196: between the angle cards and the "Copy performance" table the design has only the dashed "Angle coverage" band (L153-159); after the table only the mono footnote (L195). No filter card, no metric-selector bar, no preview strip, no heat legend.
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:614-635 renders "<CreativesTopSection ...>", which at components/creatives/CreativesTopSection.tsx:468-510 draws a bordered filter card (CreativeDateRangePicker, "Group by" select, AddFilterDropdown, TopExportDropdown) and at :514-537 a second bordered card with MetricSelectorBar + PreviewStrip. legacy-page.tsx:705-708 then adds "<HeatLegendFooter ...>".
- **Fix:** Remove CreativesTopSection and HeatLegendFooter from the Copies route; the tab is angle cards → coverage band → Copy performance table → footnote.

### CREATIVE-07 · HIGH · MISSING — Audiences tab renders none of the design's four sections

- **Design:** 02-creative-studio.html L308-373 (sc-if csAudiences), re-read end to end: L309-321 audienceCards grid (name + status pill, Spend · 28d / ROAS / Freq, note); L322-325 h2 "Breakdowns & frequency" + mono "account-wide · 28d · bar = spend share · right value = ROAS"; L326-343 five audBreakdowns cards (data-model.js:307-321 Frequency / Age / Gender / Placement / Platform) with rows on grid 76px 1fr 34px 32px; L344-371 article "Creative × audience matrix" over matrixCols ['Broad US','LAL 1%','Retarg 7d','Retarg 30d'] (data-model.js:322); L372 closing mono note.
- **Code:** app/(dashboard)/platforms/meta/audiences/legacy-page.tsx read in full (175 lines). Body is StudioTabRow (:54), a header card (:55-74), "<section ... data-testid="audience-readiness-ledger">" (:76-121), an aside (:123-159) and a "Contract needed" section (:162-171). No audience card, no breakdown card, no matrix table exists anywhere in the file.
- **Fix:** Build the Audiences surface the design defines: four audience summary cards, the "Breakdowns & frequency" heading plus five breakdown cards, and the "Creative × audience matrix" table with the four audience columns. Where a metric has no server read, render an em-dash inside the designed shape instead of replacing the whole screen.

### CREATIVE-08 · HIGH · MISSING — Inbox has no kanban board — the four status columns are absent

- **Design:** 02-creative-studio.html L277 "grid-template-columns:repeat(4,minmax(210px,1fr))" over "{{ inboxCols }}"; L280 per-column dot + mono uppercase name + count; L282-293 cards with source chip, name, note, avatar, due and optional CTA button. Columns Requested (2) / In production (1) / Delivered (1) / Live (1) — data-model.js:293-303.
- **Code:** app/(dashboard)/platforms/meta/creative-inbox/legacy-page.tsx:331 "<div className="grid gap-3">" then :332 "{scopedCards.map((card) => <article ...>)}" — one flat vertical stack. No column grouping and no status column exists in the file.
- **Fix:** Render the inbox as the design's four-column board (Requested / In production / Delivered / Live) with per-column dot, name and count, and cards carrying source chip, name, note, owner avatar, due and optional CTA.

### CREATIVE-09 · HIGH · MISSING — Inbox is missing the Decisions routing strip and the file dropzone

- **Design:** 02-creative-studio.html L273-276 purple strip (border #DACBF2, background #FDFBFF, inbox svg): "Requests route here from <b>Decisions</b> with evidence attached. Delivered files are versioned, linked back to the request, and approved assets hand off to Launchpad." L298-305 dashed dropzone "Drop new exports here" / "Files auto-match to open requests by name · MP4, MOV, PNG, JPG up to 500MB · versions kept" + button "Browse files".
- **Code:** app/(dashboard)/platforms/meta/creative-inbox/legacy-page.tsx read from :219 to end — the page goes header (:228-281) → error banner (:283) → loading/guard ladder (:294-330) → card stack (:331-393) → withheld-count banner (:394). Neither string nor either element appears.
- **Fix:** Add the purple routing strip above the board and the dashed upload dropzone with the "Browse files" button below it, using the design's exact copy.

### CREATIVE-10 · HIGH · MISSING — Landing Pages is missing "What's missing", "What to try" and "Destination history"

- **Design:** 02-creative-studio.html L199 two-column grid "minmax(0,1.7fr) minmax(280px,1fr)"; L232-243 card h2 "What's missing" + "Gaps the engine sees in the current link map." over landerGaps; L244-255 card h2 "What to try" + "Test ideas from the reads below — each starts as a Launchpad draft." over landerTests; L258-269 article h2 "Destination history" + mono "what changed, what it did — these reads feed the test ideas" over landerHistory (data-model.js:289-293).
- **Code:** app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx:241-313 — the body is StudioTabRow, LandingPageHeader, a date+search row (:248-260), "<section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">" of AnalyticsKpiCard (:274-283), then LandingPagesTableSection (:291-298) and a detail drawer. No gaps card, tests card or history list, and no 1.7fr/1fr grid.
- **Fix:** Add the right-hand column with the "What's missing" and "What to try" cards and the "Destination history" article beneath, laying the table + sidebar on the design's 1.7fr / 1fr grid.

### CREATIVE-11 · HIGH · MISSING — Copies tab is missing the four messaging-angle cards

- **Design:** 02-creative-studio.html L139-152: "grid-template-columns:repeat(auto-fit,minmax(225px,1fr))" over "{{ copyAngles }}"; each card carries a 3px tone top border, name, "{{ a.lines }} lines", the stat trio Spend share / ROAS / CTR at 16px/700 (L144-146), "Best line: "{{ a.best }}"" (L148) and the mono usage line (L149). Seeds at data-model.js:210-215.
- **Code:** grep for "Best line" and "Spend share" across app/(dashboard)/platforms/meta/copies/legacy-page.tsx, components/meta/copies/ and components/creatives/ returns nothing. The route goes header card (:434-610) → CreativesTopSection (:614) → CopyAngleCoverage (:636).
- **Fix:** Add the angle card row above the coverage band: one card per messaging angle with line count, spend share, ROAS, CTR, best line and the rotation note.

### CREATIVE-12 · HIGH · MISSING — Assets table has no Status column and no Marketing angle column

- **Design:** 02-creative-studio.html L108 "<th ...>Status</th>" and L109 "<th ... white-space:nowrap">Marketing angle</th>", filled at L123 (tag pill from r.tag) and L124 (r.angle; seeds at data-model.js:352 "angles = { c1: 'Habit / routine', … }").
- **Code:** components/creatives/StudioOsView.tsx:2283-2372 the thead is one "Creative" th (:2304) followed by "orderedCols.map(...)" metric ths only. grep for "Marketing angle" in the file returns nothing; the status label is folded into the Creative cell as a badge at :2482-2528.
- **Fix:** Add Status and Marketing angle as their own columns between Creative and the metric columns, and move the assessment pill out of the Creative cell into Status.

### CREATIVE-13 · HIGH · MISSING — Header "Export CSV" and "Share with client" buttons are absent from the Studio header

- **Design:** 02-creative-studio.html L7-10: a flex row of two buttons, "Export CSV" and "Share with client", height 36px, radius 9px, border 1px #E4E8F0, background #ffffff, 13px/600 #0E1526.
- **Code:** components/creatives/StudioOsView.tsx:1050-1074 is the title block; :1076-1363 the header action area holds only the account picker, "Decision context {freshnessLabel}", the ⓘ status button and the Business STOP Link. grep for "Export CSV" and "Share with client" across StudioOsView.tsx and app/(dashboard)/platforms/meta/creatives/legacy-page.tsx returns nothing.
- **Fix:** Add the two header buttons "Export CSV" and "Share with client" with the design's geometry to the right of the title block.

### CREATIVE-14 · HIGH · WRONG — Landing Pages table shows a GA4 session funnel instead of the design's Meta destination columns

- **Design:** 02-creative-studio.html L204-212 header order: Destination · Ads · Spend · Link clicks · LP view rate · CVR · CPA · ROAS · Signal, under the caption at L201 "Meta-reported only — link clicks + pixel LP views · no analytics join · 28d".
- **Code:** components/landing-pages/LandingPagesTableSection.tsx:30-41 getColumns returns Sessions, Engagement, Scroll, View Item, Add to Cart, Checkout, Shipping, Purchases, Revenue, AOV; app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx:146 sources them from "getLandingPagePerformance" (GA4) and :211 gates the entire page on "!ga4Connected".
- **Fix:** Replace the column set with Destination / Ads / Spend / Link clicks / LP view rate / CVR / CPA / ROAS / Signal driven off the Meta destination read, and carry the design's "Meta-reported only …" caption.

### CREATIVE-15 · HIGH · WRONG — Copies table column set and order do not match the design

- **Design:** 02-creative-studio.html L168-176 header order: Copy · Angle · Ads · Spend · See more · CTR · Engage · CVR · ROAS, with ROAS last and rendered as a pill (L189).
- **Code:** components/creatives/CreativesTableSection.tsx:448-461 "META_COPY_PERFORMANCE_COLUMNS = ["spend","purchaseValue","roas","cpa","cpcLink","purchases","linkCtr","clickToAtcRatio","atcToPurchaseRatio","clickToPurchaseRatio","linkClicks","purchaseValueShare"]", wired at :496-506 into the "Meta Copy Performance" preset, which app/(dashboard)/platforms/meta/copies/legacy-page.tsx:695 selects via "initialPresetName". Angle, Ads, See more and Engage have no column; ROAS sits third instead of last.
- **Fix:** Rebuild the copies table on the design's nine columns in the design's order, adding Angle, Ads, See more and Engage, and moving ROAS to last as a pill.

### CREATIVE-16 · HIGH · WRONG — Metric picker is a KPI-preset dropdown instead of the design's four metric-set pills plus "+ Edit metrics"

- **Design:** 02-creative-studio.html L69-73: mono eyebrow "Columns", then "sc-for" over "{{ metricSets }}" rendering pills, then a dashed button "+ Edit metrics" ("border:1px dashed #9DB4E8", "color:#2F6BFF"). metricSets = Performance / Engagement / Funnel / Custom (data-model.js:392-395). L74-96 the popover titled "Table metrics" with "edits save as the Custom set", groups Volume / Efficiency / Engagement / Funnel (data-model.js:397).
- **Code:** components/creatives/StudioOsView.tsx:1765-1792 a single button "KPIs {presetLabel} ▾" opening the menu at :2110-2167 headed "KPI preset" listing Ecommerce / Lead Gen / Creative (:268-287), plus a separate "Columns" button (:1889-1914) whose popover is headed by COLUMN_GROUPS Delivery / Click / Funnel / Outcome / Video (:347-353). grep for "+ Edit metrics" and "Table metrics" returns nothing.
- **Fix:** Replace the KPIs dropdown and Column-groups popover with the design's inline pill row (Performance / Engagement / Funnel / Custom · N) preceded by the mono "Columns" eyebrow, plus the dashed "+ Edit metrics" button opening the "Table metrics" popover grouped Volume / Efficiency / Engagement / Funnel.

### CREATIVE-17 · MEDIUM · EXTRA — Assets tab adds an "Analyzing …" account/currency/window strip above the toolbar

- **Design:** 02-creative-studio.html L17-23 — the csAssets block opens directly with the toolbar row (caption, spacer, sort select, search). There is no account/currency/window strip.
- **Code:** components/creatives/StudioOsView.tsx:1570-1586 "<div className="studio-analysis-meta">" rendering "Analyzing" + account name + account id + currency + dateRangeLabel + "Account-scoped metrics · missing shown as —".
- **Fix:** Delete the studio-analysis-meta strip; the design's toolbar caption line replaces it.

### CREATIVE-18 · MEDIUM · EXTRA — Assets table sits inside a bordered card and carries a pagination footer bar the design never had

- **Design:** 02-creative-studio.html L64 the section wrapper is "<article style="display:flex;flex-direction:column;padding-top:6px">" — no background, border, radius or shadow — and L103 the table is wrapped only by "<div style="overflow-x:auto">". The tbody closes at L131 with no footer row of any kind.
- **Code:** components/creatives/StudioOsView.tsx:2268-2277 ".studio-table-frame" with "background: "var(--s2)", border: "1px solid var(--b1)", borderRadius: 9, boxShadow: "0 1px 3px rgba(26,28,31,.05)""; :2580-2688 footer bar with "Showing {a}–{b} of {n}" (:2592), "Show more" (:2609), "{n} selected · missing metrics render "—"" (:2613) and a "Rows {pageSize} ▾" menu (:2617-2686).
- **Fix:** Remove the card frame around the table and delete the pagination/selection footer bar.

### CREATIVE-19 · MEDIUM · EXTRA — ROAS and Revenue headers carry a "Meta-attr." eyebrow line the design does not define

- **Design:** 02-creative-studio.html L110-112: each metric header is a single "<th>" containing only "{{ m.head }}" (the label plus a ↑/↓ direction glyph, data-model.js:398). There is no second header line and no attribution eyebrow anywhere in the table.
- **Code:** components/creatives/StudioOsView.tsx:346 "const ATTR_COLUMNS: Record<string, string> = { roas: "Meta-attr.", purchaseValue: "Meta-attr." }", rendered as a second stacked line inside the header button at :2349-2361.
- **Fix:** Remove the "Meta-attr." eyebrow from the ROAS and Revenue headers; attribution belongs in the surface footnote, not in every header cell. (Narrowed from the auditor's finding — see rejected.)

### CREATIVE-20 · MEDIUM · EXTRA — Studio adds a "More ▾ / Also in Studio" menu with Winners, Briefs and Shares views

- **Design:** 02-creative-studio.html L12-16 — the tab row is one "sc-for" over "{{ studioTabs }}" and nothing else; data-model.js:203 defines exactly five tabs. No overflow menu and no Winners / Briefs / Shares surface appears in the fragment.
- **Code:** components/creatives/StudioOsView.tsx:1465-1545 the "More" button (:1489) opens a popover headed "Also in Studio" (:1518) listing STUDIO_MORE_LINKS (:260-264) = Winners / Briefs / Shares, rendered by renderWinners/renderBriefs/renderShares at :1550-1554.
- **Fix:** Remove the More menu and its three extra sub-views from the tab row.

### CREATIVE-21 · MEDIUM · EXTRA — Inbox header and cards add crumbs, a read-only chip, a description, an account select, a count chip and per-card decision chrome

- **Design:** 02-creative-studio.html L272-306 — the csInbox block contains only the routing strip, the kanban board and the dropzone. There is no breadcrumb, no chip, no account selector, no item count and no per-card decision/priority block; card footers carry only avatar, due date and an optional CTA (L286-292).
- **Code:** app/(dashboard)/platforms/meta/creative-inbox/legacy-page.tsx:231 crumbs; :234 chip "Read-only · account scoped"; :236-238 description paragraph; :241-273 account "<select>"; :274-277 count chip; :278 "Decisions" button; per card :349-356 "Decision context" + priority, :358-373 chips "Spend"/"ROAS"/"Confidence", :374-388 "Open Decisions" link.
- **Fix:** Reduce the inbox header to the shared Studio header and strip the cards down to source chip, name, note, avatar, due and optional CTA.

### CREATIVE-22 · MEDIUM · EXTRA — Assets toolbar adds a "Performance color map" mode control (Hybrid / Target / Cohort / Off)

- **Design:** 02-creative-studio.html L98-102 is the design's entire colour affordance: a static legend of two mono strings around an 88×8 gradient. The heat rule is fixed — "cell color = rank across these creatives on that metric" — and nothing in L17-136 lets the operator change it.
- **Code:** components/creatives/StudioOsView.tsx:619 "const [colorMode, setColorMode] = useState<StudioColorMode>("hybrid")"; :2004-2038 a toolbar button showing the active mode label, opening a "role="menu" aria-label="Performance color map"" popover over STUDIO_COLOR_MODES (:288-320) = Hybrid / Target / Cohort / Off; :2239 the legend itself is suppressed when the mode is "off".
- **Fix:** Remove the colour-mode control and pin the heat rule to the design's single rank-within-cohort behaviour so the legend at L98-102 is always true.

### CREATIVE-23 · MEDIUM · EXTRA — Assets metric cells render a volume bar under the value; the design's cell is a tinted chip only

- **Design:** 02-creative-studio.html L125-127: each metric cell is one "<span>" chip with padding 7px 9px, radius 8px, right-aligned, containing "{{ cell.v }}" and nothing else. data-model.js:405-414 "heatCell" returns only { v, bg, fg } — volume columns are explicitly left neutral ("if (!m.dir) return { v, bg:'transparent', fg:'#45526B' }"), not bar-charted.
- **Code:** components/creatives/StudioOsView.tsx:2534-2536 computes "barW" from "volumeColMax", and :2555-2568 renders a second "<span>" of height 3 and width "barW" inside the value chip for every volume column.
- **Fix:** Drop the in-cell volume bar; volume columns stay neutral text as the legend at L101 promises.

### CREATIVE-24 · MEDIUM · EXTRA — "All creatives" header row carries two extra captions the design does not have

- **Design:** 02-creative-studio.html L66-73: the row is h2 "All creatives", mono "8 synced · Meta", a flex spacer, then the "Columns" eyebrow, the metric-set pills and "+ Edit metrics". Nothing else.
- **Code:** components/creatives/StudioOsView.tsx:2232-2237 the caption is "{sortedRows.length} synced · Meta · one row per creative · usages aggregated" — the design's string plus an appended clause; :2238 adds a further right-aligned span "KPI preset · {presetLabel} · Revenue and ROAS are Meta-attributed" where the design puts the pills.
- **Fix:** Trim the caption to "{n} synced · Meta" and delete the "KPI preset · … Meta-attributed" span, freeing the right side for the metric-set pills.

### CREATIVE-25 · MEDIUM · GEOMETRY — The Studio's ink ramp is collapsed, so every mono caption the design pins at #98A4BA or #7A869E renders at #45526b

- **Design:** 02-creative-studio.html uses a three-tone ramp deliberately: body/secondary #45526B (L124, L155), header and legend #7A869E (L4, L99, L107), and quiet mono captions #98A4BA (L19, L27, L67, L121, L135).
- **Code:** components/creatives/StudioOsView.tsx:53 "--ink:var(--adv-ink); --ink2:var(--adv-ink-2); --ink3:var(--adv-ink-2); --ink4:var(--adv-ink-2);" — ink3 and ink4 both alias to --adv-ink-2 = #45526b (app/globals.css:113). Every caption written as "color: "var(--ink3)"" (e.g. :2233, :2245, :2251, :2296) therefore paints two steps darker than the design pins.
- **Fix:** Point --ink3 at --adv-ink-3 (#7a869e) and --ink4 at --adv-ink-4 (#98a4ba) so the caption ramp matches the design; the alias block is the single place to fix it.

### CREATIVE-26 · MEDIUM · MISSING — Tab pills carry no count badges

- **Design:** 02-creative-studio.html L14 renders "<sc-if value="{{ t.count }}">" a mono 10px radius-9999 pill inside each tab, background "{{ t.cntBg }}" / colour "{{ t.cntFg }}" (data-model.js:205: inactive #F1F4F9 / #7A869E, active rgba(255,255,255,0.18) / #ffffff).
- **Code:** components/creatives/StudioTabRow.tsx:46 the pill body is just "{tab.label}"; components/creatives/StudioOsView.tsx:1460 likewise renders only "{tab.label}". Neither file emits a count span.
- **Fix:** Render the count badge inside the pills with the design's mono 10px geometry and the active/inactive token pair.

### CREATIVE-27 · MEDIUM · MISSING — Assets tab is missing its two caption lines: the toolbar subtitle and the closing thumbnail note

- **Design:** 02-creative-studio.html L19 mono 10.5px #98A4BA "visual assets · heat table + comparison board"; L135 mono 11px #98A4BA "Thumbnails render from synced ad assets — drop real creative exports to replace placeholders. Board picks and the Custom column set persist per operator."
- **Code:** grep for "visual assets" and "Thumbnails render" in components/creatives/StudioOsView.tsx returns nothing. The toolbar row at :1588 opens with the search box, and the assets section ends at :2692 with the table frame and usage drawer, no trailing note.
- **Fix:** Add the mono toolbar caption to the left of the sort select and the mono closing note beneath the table, using the design's exact strings.

### CREATIVE-28 · MEDIUM · WRONG — "Angle coverage" band lists covered angles instead of the design's never-tested gaps

- **Design:** 02-creative-studio.html L155 copy: "All 18 live lines sit on 4 angles — discount holds 16% of spend at the lowest ROAS. Never tested:" followed by L156-158 chips over "{{ angleGaps }}" = ['Founder story','Comparison / vs','How-to & demo','Guarantee-led','Bundle value'] (data-model.js:228) — the chips are the UNTESTED angles, and the taxonomy they come from is design-owned, not provider data.
- **Code:** components/meta/copies/CopyAngleCoverage.tsx:51-62 maps "ranked" (built at :23-28 from "row.copyAngle" of rows that ARE tagged) into the chips and appends a spend figure; the sentence at :43-50 ends with a period and never says "Never tested:".
- **Fix:** Keep the covered-angle sentence but end it with "Never tested:" and render chips for the angles with no live lines, not for the angles already in rotation.

### CREATIVE-29 · MEDIUM · WRONG — Second tab is captioned "Copy" instead of "Copies"

- **Design:** data-model.js:203 "[['assets','Assets',8],['copies','Copies',0],['landers','Landing Pages',0],['inbox','Inbox',5],['audiences','Audiences',0]]" — the label is "Copies".
- **Code:** components/creatives/StudioOsView.tsx:252 "{ key: "copies", label: "Copy", href: "/platforms/meta/copies" }" in STUDIO_TABS, which both StudioTabRow and the in-view row read from.
- **Fix:** Change the STUDIO_TABS label for the copies key from "Copy" to "Copies".

### CREATIVE-30 · MEDIUM · WRONG — On four of five routes the tab row is rendered above the screen title, inverting the design's order

- **Design:** 02-creative-studio.html: the header block (eyebrow + h1 + buttons) is L2-11 and the tab row is L12-16 — title first, pills second. The Assets surface honours this (StudioOsView header ends :1363, tab row follows at :1430+).
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:432 "<StudioTabRow active="copies" />" precedes the header whose h1 is at :457; landing-pages/legacy-page.tsx:242 vs h1 at :332 (inside LandingPageHeader); creative-inbox/legacy-page.tsx:227 vs :233; audiences/legacy-page.tsx:54 vs :60.
- **Fix:** Move StudioTabRow below the screen header on the copies, landing-pages, creative-inbox and audiences routes so the order matches Assets.

### CREATIVE-31 · MEDIUM · WRONG — Landing Pages, Inbox and Audiences use their tab name as the h1 instead of "Creative Studio"

- **Design:** 02-creative-studio.html L5: a single "<h1 ...>Creative Studio</h1>" for the whole screen; tab identity is carried by the lit pill at L14, never by the heading.
- **Code:** app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx:332 "<h1 className="page-title">Landing Pages</h1>"; creative-inbox/legacy-page.tsx:233 "<h1 className="page-title">Creative Inbox</h1>"; audiences/legacy-page.tsx:60 "<h1 className="page-title">Audiences</h1>". Only copies/legacy-page.tsx:457 uses "Creative Studio".
- **Fix:** Set the h1 on all five Studio routes to "Creative Studio" with the design's eyebrow above it, and let the lit tab pill identify the surface.

### CREATIVE-32 · MEDIUM · WRONG — Sorting is done through clickable column headers, not the design's sort select

- **Design:** 02-creative-studio.html L21 "<select onChange="{{ setSort }}" style="height:32px;…"><option value="spend">Sort: Spend</option><option value="roas">Sort: ROAS</option><option value="thumb">Sort: Thumbstop</option></select>". Table headers at L107-112 are plain "<th>" text with no sort affordance.
- **Code:** components/creatives/StudioOsView.tsx:2324-2371 every metric "<th>" wraps a "<button onClick={...}>" that sets sortId/sortDir, with a ▾/▴ indicator at :2364-2366. grep for "Sort: " in the file returns nothing.
- **Fix:** Add the three-option sort select (Sort: Spend / Sort: ROAS / Sort: Thumbstop) to the Assets toolbar and make the metric headers plain non-interactive text.

### CREATIVE-33 · MEDIUM · WRONG — Populated comparison board loses its heading and swaps "Clear board" for "Clear" plus a Grid KPIs control

- **Design:** 02-creative-studio.html L25-31: the h2 "Comparison board" and the mono "{{ pinnedCount }} pinned · your working set, never auto-fills" sit in the same row in both states; only the "Clear board" button is conditional on "pinnedAny". There is no per-board metric picker.
- **Code:** components/creatives/StudioOsView.tsx:2172-2213 the h2 and the "0 pinned · …" caption render only in the "selectedRows.length === 0" branch; the populated branch calls renderComparisonGrid (:2830), whose toolbar shows "Comparing {n} creatives" (:2839), "grid metrics independent from the table" (:2840), a "Grid KPIs" dropdown (:2862-2864) and a button labelled "Clear" (:2947).
- **Fix:** Keep the "Comparison board" h2 and the "{n} pinned · your working set, never auto-fills" caption in both branches, rename the button to "Clear board", and drop the "Comparing N creatives" line and the Grid KPIs picker.

### CREATIVE-34 · MEDIUM · WRONG — Pinned comparison cards show two configurable KPIs instead of the design's fixed Spend / ROAS / Thumbstop / Hold

- **Design:** 02-creative-studio.html L52-57: each pinned card carries exactly four stat blocks labelled "Spend", "ROAS", "Thumbstop" and "Hold", mono 8.5px uppercase labels over 13.5px/600 values.
- **Code:** components/creatives/StudioOsView.tsx:613 "const [gridKpiIds, setGridKpiIds] = useState<string[]>(["spend", "roas"])" and :3104-3115 renders "gridKpis.map(...)" — two stats by default, user-selectable from GRID_KPI_OPTIONS (:354), which contains thumbstopRatio but no holdRate at all. (Auditor cited line 74 for the state; the declaration is at 613 — substance confirmed.)
- **Fix:** Fix the pinned-card stat row to Spend / ROAS / Thumbstop / Hold and remove the Grid KPIs selection state.

### CREATIVE-35 · LOW · EXTRA — Landing Pages adds a KPI summary grid, a date-range picker and a page-path search the design does not define

- **Design:** 02-creative-studio.html L198-270 — the csLanders block opens straight onto the two-column grid at L199; there is no summary-card row, no date picker and no search field anywhere in it.
- **Code:** app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx:248-260 "<DateRangePicker ...>" plus the search input "placeholder={… "Search page path"}"; :274-283 "<section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{summaryCards.map(card => <AnalyticsKpiCard .../>)}" built by buildSummaryCards at :178-181.
- **Fix:** Remove the KPI summary card grid, the date-range picker and the page-path search from the Landing Pages surface.

### CREATIVE-36 · LOW · EXTRA — Landing Pages and Audiences replace the design's plain screen header with a bordered card carrying crumbs, a status chip and a description paragraph

- **Design:** 02-creative-studio.html L2-11: the header is an unframed flex row — eyebrow p, h1, and two buttons. No card, no breadcrumb, no chip, no descriptive paragraph.
- **Code:** app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx:327-345 "<header className="overflow-hidden rounded-[var(--r-lg)] border …">" with crumbs (:330), chip "Analysis only - decisions live in Decisions" (:333-335) and a description (:337-340); app/(dashboard)/platforms/meta/audiences/legacy-page.tsx:55-74 the same shape with crumbs (:58), chip "Planned surface" (:61-64) and a description (:66-69).
- **Fix:** Replace both header cards with the design's unframed eyebrow + h1 + Export CSV / Share with client row, matching the Assets surface.

### CREATIVE-37 · LOW · GEOMETRY — Active tab pill, header eyebrow, table width, header type and row thumbnail all use different numbers than the design pins

- **Design:** 02-creative-studio.html L14 active pill "background:{{ t.bg }}" = #0B1020 with "color:#ffffff" and "border:1px solid #0B1020" (data-model.js:205); L4 eyebrow "font-size:11px"; L104 table "min-width:820px"; L107-111 "<th … font-size:10px … color:#7A869E>"; L120 row thumb "width:34px;height:34px;border-radius:8px"; L22 search input "width:170px" with placeholder "Search creatives…"; L19/L27/L67 mono captions "font-size:10.5px;color:#98A4BA".
- **Code:** components/creatives/StudioTabRow.tsx:41-43 active pill uses "--adv-accent-bd" / "--adv-accent-bg" / "--adv-accent" = #cbd9ff / #eaf0ff / #2f6bff (app/globals.css:117-121) — pale blue, not near-black; components/creatives/StudioOsView.tsx:1055 eyebrow "fontSize: 12"; :2281 "minWidth: 920"; :2296 header "fontSize: "12px""; :115 ".studio-table-media-wrap{width:36px;height:46px;…border-radius:4px}"; :1601 search "width: 210" with :1613 "placeholder="Search creatives"" (no ellipsis); :2233/:2245 captions "fontSize: "12px"".
- **Fix:** Restore the design values: active pill #0B1020 background with #ffffff text, eyebrow 11px, table min-width 820px, metric headers 10px, row thumbnail 34×34 radius 8px, search input 170px wide with the "Search creatives…" placeholder, and mono captions at 10.5px.

### CREATIVE-38 · LOW · GEOMETRY — The Assets table has no dedicated checkbox column — selection is folded into the Creative cell

- **Design:** 02-creative-studio.html L106 the first "<th>" is a dedicated 32px column, and L118 the first "<td>" holds only the 17px selection box (radius 5px, 1.5px border). The Creative cell (L119-122) starts at the thumbnail.
- **Code:** components/creatives/StudioOsView.tsx:2296-2306 the thead's first cell is the "Creative" th itself; :2396-2430 the row's first "<td>" is a sticky 300px-min Creative cell whose inner flex row begins with a 16px selection button before the thumbnail.
- **Fix:** Split the 32px selection column back out as the table's first column and start the Creative cell at the 34×34 thumbnail.

---

## Launchpad + Automation

### LAUNCHPAD-AUTOMATION-01 · HIGH · EXTRA — Launchpad renders a whole "Templates" library section the design never defines

- **Design:** 03-launchpad.html, all 60 lines re-read. After the head (2-5) the section contains exactly: amber notice bar (6-9), the {{ launchStarts }} grid (10-19), the Drafts article (20-45), the Launch receipts article (46-57), then </section> at 58. No templates list, no "Auto" chip, no "Use" chip, no placeholder chips. data-model.js Launchpad block defines only launchStarts, drafts, receipts.
- **Code:** app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx:2742-2825 — a third "<LaunchpadLibraryCard icon={<LayoutTemplate/>} title="Templates">" with per-row "chip chip--auto" "Auto", "chip chip--ghost" "Use", dashed mono chips "budget: placeholder — set at use" and "countries: placeholder", plus a per-row delete button (2810-2822).
- **Fix:** Remove the Templates card from the Launchpad landing (or move it off this screen). The landing after the notice bar is exactly: start cards, Drafts, Launch receipts.

### LAUNCHPAD-AUTOMATION-02 · HIGH · EXTRA — Launchpad renders an extra "Source" panel with three handoff rows

- **Design:** 03-launchpad.html:19-20 — the launch-start grid closes at line 19 and the Drafts <article> opens at line 20 with nothing between them. No "Source" eyebrow, no "Decision handoff"/"Reviewed brief"/"Manual or saved setup" rows, no "Creates PAUSED" chip anywhere in the fragment.
- **Code:** app/(dashboard)/platforms/meta/launchpad/legacy-page.tsx:2540-2613 — "<section className={styles.sourcePanel} data-testid="launchpad-source-step">" with "<p>Source</p><h2>Continue from evidence or start manually</h2>", a "chip chip--warn" "Creates PAUSED", and three "styles.sourceRow" rows each with its own button or link.
- **Fix:** Remove the Source panel from the landing. The three launch-start cards are the design's only entry points.

### LAUNCHPAD-AUTOMATION-03 · HIGH · EXTRA — Launchpad wraps the landing in wizard chrome (frame header + sticky Back/Continue footer) the design has no counterpart for

- **Design:** 03-launchpad.html:1 — "<section data-screen-label="Launchpad" style="display:flex;flex-direction:column;gap:16px">" is a plain stack; lines 1-58 contain no framing card, no mode/lineage strip and no footer bar.
- **Code:** legacy-page.tsx:1749-1783 renders "<div className={styles.wizardFrame}>" with "styles.wizardHeader" showing "<strong>{launchpadModeLabel(mode)}</strong>" and "{sourceLineageLabel} · {providerAccountId} · {currency}"; :2056-2122 renders "<div className={styles.footer}>" (page.module.css:450-458 "position: sticky; bottom: 0") with the math line, "Create changes provider state to PAUSED and cannot begin delivery.", a Back and a Continue button. Both render whenever "step !== "progress"", and "step" starts at "source" (:591 "useState<WizardStep>(requestedStep)", :196-204 defaulting to "source"). The step rail itself is correctly "hidden" on source (:1808).
- **Fix:** Suppress the wizard frame header and the sticky footer while step === "source" so the landing is the bare stack: notice bar, start cards, Drafts, Launch receipts.

### LAUNCHPAD-AUTOMATION-04 · HIGH · WRONG — Drafts and Launch receipts are collapsed <details> disclosures instead of always-open cards

- **Design:** 03-launchpad.html:20 and :46 — both are "<article style="border-radius:14px;background:#ffffff;border:1px solid #E4E8F0">" with the table/rows rendered directly inside; neither is a disclosure and neither header carries a count.
- **Code:** legacy-page.tsx:2863-2884 "function LaunchpadLibraryCard(...)" returns "<details className={styles.librarySection}><summary className={styles.librarySummary}>{icon}<strong>{title}</strong><span>{count}</span></summary><div className={styles.libraryBody}>…" with no "open" attribute, and page.module.css:408-448 adds no "[open]" override — so Drafts (:2633) and Launch receipts (:2829) are both closed on first paint, showing only a title, an icon and a row count.
- **Fix:** Render Drafts and Launch receipts as plain always-visible <article> cards (radius 14px, 1px #E4E8F0, white) with content shown, and drop the count from the header.

### LAUNCHPAD-AUTOMATION-05 · MEDIUM · EXTRA — Launchpad page head carries a currency sub-line, two chips, an ad-account <select> and a "← Decisions" link

- **Design:** 03-launchpad.html:2-5 — the head <div> holds exactly the mono eyebrow p "Meta · Guarded write surface" and the h1 "Launchpad". Nothing else.
- **Code:** legacy-page.tsx:2253-2296 — "<div className="mono mt-1 …">{businessName} · {currency ?? "currency unavailable"}</div>" (2253-2255), "<span className="chip chip--warn">Everything launches PAUSED</span>" (2257-2259), "<label …>Ad account<select …>" (2261-2286), "<span className="chip chip--ghost">guards checked at write time</span>" (2287) and the "← Decisions" Link (2288-2296).
- **Fix:** Reduce the head to the eyebrow and the h1. Drop the two chips, the currency sub-line and the "← Decisions" link; if the ad-account scope must stay selectable, it belongs in the shell chrome that already owns scope.

### LAUNCHPAD-AUTOMATION-06 · MEDIUM · EXTRA — Launch receipt rows add a status chip, a lineage line, a receipt-facts line and a retry/rollback sentence

- **Design:** 03-launchpad.html:49-55 — a receipt row has exactly five children: mono id, bold name, the PAUSED badge, the time, and the right-aligned "Open in Ads Manager ↗". No second status chip and no additional copy lines.
- **Code:** app/(dashboard)/platforms/meta/launchpad/LaunchIntentReceiptRows.tsx:89-91 "<span className={statusClass(intent.status)}>{intent.status.replaceAll("_"," ")}</span>" beside the PAUSED badge; :79-81 "{summarizeLineage(intent)} · PAUSED only"; :97-101 "receipt: {facts.join(" · ")}"; :107-110 "Immutable receipt · no automatic retry or rollback".
- **Fix:** Strip the row to the design's five elements — drop the status chip, the lineage line, the receipt-facts line and the retry/rollback sentence.

### LAUNCHPAD-AUTOMATION-07 · MEDIUM · EXTRA — Launchpad ends with a "supports Sales campaigns only" paragraph the design does not have

- **Design:** 03-launchpad.html:57-58 — the Launch receipts </article> is immediately followed by </section>; there is no trailing copy after the last card.
- **Code:** legacy-page.tsx:2854-2858 — "<p className="text-[11.5px] leading-relaxed text-[var(--muted)]">Launchpad currently supports Sales campaigns only. Create paths land PAUSED. Activation inside Adsecute is Proposed/contract required…</p>".
- **Fix:** Remove the trailing paragraph; the notice bar already carries the PAUSED boundary statement the design specifies.

### LAUNCHPAD-AUTOMATION-08 · MEDIUM · EXTRA — Automation page head adds an in-page "Ad account" select

- **Design:** 04-automation.html:2-5 — the head <div> is only the mono eyebrow "Meta · Supervision control plane" and the h1 "Automation"; nothing else, and no scope control appears anywhere in the remaining 116 lines.
- **Code:** automation-view.tsx:533-555 — "<label className={styles.canonicalAccountSelect}><span>Ad account</span><select …>" inside "styles.canonicalHeader", absolutely positioned at the head's bottom-right by automation.module.css:1157-1171.
- **Fix:** Remove the in-page ad-account select from the Automation head; scope belongs to the shell top bar. (I am not counting the adjacent "canonicalScopeAlert" at :556-563 — it only renders when a business is unselected or a fetch failed, which is honest error handling.)

### LAUNCHPAD-AUTOMATION-09 · MEDIUM · GEOMETRY — Launch receipt rows are stacked multi-line blocks instead of one horizontal flex line

- **Design:** 03-launchpad.html:49 — "<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid #F3F5F9">" with the id (50), name (51), PAUSED badge (52), time (53) and the link pushed right by "margin-left:auto" (54) all on that one line.
- **Code:** LaunchIntentReceiptRows.tsx:71-121 — "<div className="px-4 py-3">" containing a column stack: a header flex row, then the mono id+timestamp on its own line (:94-96), then optional facts/error lines, then a wrapping flex row that carries the Ads Manager link (:107-120).
- **Fix:** Lay each receipt out as a single "display:flex;align-items:center;gap:12px" row: mono id, the row's primary label, PAUSED badge, timestamp, then the Ads Manager link pushed right. (I am not asking for the design's "r.name": MetaLaunchIntent stores no campaign name, so the app's operation label is honest — only the geometry is wrong.)

### LAUNCHPAD-AUTOMATION-10 · MEDIUM · GEOMETRY — Drafts / Launch receipts card headings are 12px bold in a 38px strip instead of the design's 15px Space Grotesk h2 in a 13px 16px header row

- **Design:** 03-launchpad.html:21-22 and :47 — the card header is "<div style="padding:13px 16px;border-bottom:1px solid #EDF0F6…">" containing "<h2 style="font-family:'Space Grotesk';font-size:15px;font-weight:600;color:#0E1526">Drafts</h2>" (and the same for "Launch receipts").
- **Code:** legacy-page.tsx:2876-2880 renders the title as "<strong>{title}</strong>" inside "styles.librarySummary", and page.module.css:416-436 sets ".librarySummary { min-height: 38px; padding: 8px 11px }" with ".librarySummary strong { font-size: 12px }" — no h2, no display font, no 13px/16px header padding, and it adds a leading icon the design has no slot for.
- **Fix:** Emit a real "<h2>" at 15px/600 in the display font inside a "padding:13px 16px; border-bottom:1px solid #EDF0F6" header row, and drop the leading icon.

### LAUNCHPAD-AUTOMATION-11 · MEDIUM · MISSING — Drafts card header loses the "validation runs before any provider call" hint

- **Design:** 03-launchpad.html:21-24 — the header row is "justify-content:space-between" with the h2 "Drafts" opposite "<span style="font-family:'IBM Plex Mono';font-size:10.5px;color:#7A869E">validation runs before any provider call</span>".
- **Code:** legacy-page.tsx:2874-2882 — the header is "<summary className={styles.librarySummary}>{icon}<strong>{title}</strong><span>{count}</span></summary>"; the right-hand slot (page.module.css:438-443, "margin-left:auto") holds a row count. The string "validation runs before any provider call" does not appear in the file.
- **Fix:** Put the mono 10.5px #7A869E hint on the right of the Drafts card header, replacing the count.

### LAUNCHPAD-AUTOMATION-12 · MEDIUM · MISSING — Automation drops three fixed footnote sentences and prints "—" instead

- **Design:** 04-automation.html:51 "approving executes inside the guardrails above · every outcome lands in the ledger with a receipt · expired proposals re-evaluate on the next snapshot"; :76 "rules never write directly — they raise proposals into the confirmation queue (or hard-block, for guards)"; :93 "promotion reviews weekly on clean-approval streaks · any error demotes instantly". All three are literal markup text, not {{ }} bindings.
- **Code:** app/(dashboard)/platforms/meta/automation/automation-view.tsx:737, :783 and :816 — each is "<p className={styles.canonicalFootnote}>—</p>".
- **Fix:** Restore the three literal sentences. They are static policy copy, so no backend is required to show them honestly.

### LAUNCHPAD-AUTOMATION-13 · MEDIUM · WRONG — Launchpad notice bar drops "LaunchIntent lineage" and says "receipt" instead

- **Design:** 03-launchpad.html:8 — "…Every write records an immutable LaunchIntent lineage."
- **Code:** legacy-page.tsx:1743-1747 — "Activation is a separate manual step with its own confirmation. Every write records an immutable receipt."
- **Fix:** Restore the design's sentence verbatim: "Every write records an immutable LaunchIntent lineage."

### LAUNCHPAD-AUTOMATION-14 · MEDIUM · WRONG — Readiness card replaces the design's fixed autonomy sentence with a derived authority string

- **Design:** 04-automation.html:25 — "<p …>Every action requires operator confirmation. Per-action auto-execute is <b>locked · contract required</b> — promotion records will unlock tiers per action kind.</p>", literal markup with a bolded clause, not a binding.
- **Code:** automation-view.tsx:696-698 — "<p className={styles.readinessCopy}>Effective authority: <b>{authority.mode}</b>. {authority.reason}</p>".
- **Fix:** Render the design's sentence in the Readiness card with "locked · contract required" bolded. If the derived authority string must stay visible, place it outside this card's body copy.

### LAUNCHPAD-AUTOMATION-15 · LOW · EXTRA — Kill switch card turns the "This business" pill into a button and adds a release-confirmation group plus a notice paragraph

- **Design:** 04-automation.html:9-11 — both rows end in an identical static "<span …background:#0E9F6E…>ENABLED</span>", and the card has exactly four children: kicker, two rows, the 11.5px copy.
- **Code:** automation-view.tsx:583-621 renders "<button type="button" className={styles.writeStatus} … onClick={…}>" for the "This business" row; :628-651 adds a "releaseActions" group with "Cancel" and "Confirm release (Admin)"; :652-656 adds "<p className={styles.killSwitchNotice}>{actionNotice}</p>".
- **Fix:** Match the design by rendering "This business" as a static pill like "Global writes". Note this removes a real safety control, so if the engage/release flow must stay, relocate it out of the summary card rather than deleting it.

### LAUNCHPAD-AUTOMATION-16 · LOW · EXTRA — Each Drafts row carries a second delete button; the design gives a row exactly one action

- **Design:** 03-launchpad.html:40 — the action cell is "<td style="padding:11px 16px;text-align:right"><button …>{{ d.btn }}</button></td>": one button, no icon button.
- **Code:** legacy-page.tsx:2715-2731 — a "Resume" button followed by "<button … aria-label={"Delete draft ${draft.name}"}><Trash2 className="h-3.5 w-3.5"/></button>" in the same cell.
- **Fix:** Remove the per-row trash button so each Drafts row exposes the single action the design defines (or move deletion into the row's action menu).

### LAUNCHPAD-AUTOMATION-17 · LOW · EXTRA — Drafts rows add a summary sub-line and a stored-error line under the draft name

- **Design:** 03-launchpad.html:36 — the Draft cell is exactly "<td style="padding:11px 16px;font-weight:600;color:#0E1526">{{ d.name }}</td>": one line, nothing beneath it.
- **Code:** legacy-page.tsx:2677-2687 — inside the same cell, "<span className="mt-0.5 block text-[11px] …">{summarizeDraft(draft)}</span>" and a conditional "<span …>stored error: {storedError}</span>".
- **Fix:** Keep only the draft name in the Draft cell to match the design's single-line row.

### LAUNCHPAD-AUTOMATION-18 · LOW · GEOMETRY — Launch-start cards use one uniform border/background/chip colour instead of the design's three per-position roles

- **Design:** 03-launchpad.html:12-13 binds "border:{{ s.border }};background:{{ s.bg }}" and "background:{{ s.chipBg }};color:{{ s.chipFg }}"; data-model.js launchStarts gives card 1 "1px solid #DACBF2" on "#FDFBFF" with chip #F1EBFB/#6C41BE, card 2 "1px solid #CBD9FF" on "#FBFCFF" with chip #EAF0FF/#2F6BFF, card 3 "1px dashed #C9D2E0" on "#ffffff" with chip #F1F4F9/#45526B.
- **Code:** legacy-page.tsx:2518 — every card is "border border-[var(--adv-border)] bg-[var(--adv-surface)]", and :2520-2522 every chip is "bg-[var(--adv-fill-2)] text-[var(--adv-ink-2)]".
- **Fix:** Give the three cards their own border colour, background tint and chip pair by position: purple, blue, then dashed grey on white.

### LAUNCHPAD-AUTOMATION-19 · LOW · GEOMETRY — Launchpad notice bar copy is 12px grey instead of 13px amber, and the bar is top-aligned with 13px side padding

- **Design:** 03-launchpad.html:6 "display:flex;align-items:center;…padding:12px 14px"; :8 "<p style="margin:0;font-size:13px;color:#7A4A08">" wrapping both the bolded lead and the sentence.
- **Code:** app/(dashboard)/platforms/meta/launchpad/page.module.css:20-44 — ".scopeBlock { align-items: flex-start; padding: 12px 13px }", ".scopeBlock strong { font-size: 12px }", ".scopeBlock p { color: var(--ink-3); font-size: 12px }".
- **Fix:** Set both the bold lead and the sentence to 13px #7A4A08, and use "padding: 12px 14px" with "align-items: center".

### LAUNCHPAD-AUTOMATION-20 · LOW · GEOMETRY — Rules table header "Fired · 28d" is left-aligned; the design right-aligns it

- **Design:** 04-automation.html:61 — "<th style="padding:9px 12px;text-align:right;…">Fired · 28d</th>" (the Active th on :62 is also right-aligned).
- **Code:** automation.module.css:1569-1580 ".rulesTable th, .activityTable th { … text-align: left }" with only ".rulesTable th:last-child { text-align: right }" (:1587-1590), while the cells are right-aligned by ".rulesTable td:nth-child(4) { … text-align: right }" (:1620-1625).
- **Fix:** Add ".rulesTable th:nth-child(4) { text-align: right; }" so the header lines up with its right-aligned numbers.

### LAUNCHPAD-AUTOMATION-21 · LOW · GEOMETRY — Drafts and Launch receipts sit 6px apart instead of the section's 16px rhythm

- **Design:** 03-launchpad.html:1 — the screen section is "display:flex;flex-direction:column;gap:16px", and the Drafts (20) and Launch receipts (46) articles are direct siblings of it, so they are 16px apart like every other block on the page.
- **Code:** legacy-page.tsx:2629 wraps them in "<div className={styles.libraryGrid}>", and page.module.css:402-406 sets ".libraryGrid { display: grid; grid-template-columns: minmax(0,1fr); gap: 6px }".
- **Fix:** Let the two cards be direct children of the page stack (or set the wrapper's gap to 16px) so their spacing matches the rest of the screen.

### LAUNCHPAD-AUTOMATION-22 · LOW · MISSING — Autonomy ladder is missing the "Launches · new spend" policy row

- **Design:** data-model.js autonomy[3] "{ kind: 'Launches · new spend', tier: 'Manual · by design', tBg: C.warn[0], tFg: C.warn[1], w: '0%', barBg: '#E4E8F0', progress: 'locked', next: 'New spend never automates. Launches stay a deliberate human act, always PAUSED first.' }", rendered by 04-automation.html:80-92.
- **Code:** automation-view.tsx:79-84 "LADDER_ACTION_KINDS = ["pause","bid","budget","creative"]"; no launches/new-spend entry exists in the file, and the ladder maps only that array (:790-813).
- **Fix:** Add a non-provider-backed row for launches: tier "Manual · by design", 0%-width bar, progress "locked", and the design's next-step sentence. This is fixed product policy (Launchpad already only creates PAUSED), so it needs no backend — but it must be hard-coded as policy, not faked as a control-plane row.

### LAUNCHPAD-AUTOMATION-23 · LOW · WRONG — Kill switch footnote copy is rewritten

- **Design:** 04-automation.html:11 — "Flipping either switch blocks every provider write instantly — server-enforced, not a UI state."
- **Code:** automation-view.tsx:625-628 — "Business STOP blocks new Meta provider writes for this business — server-enforced, not a UI state."
- **Fix:** Restore the design's sentence verbatim in the kill-switch card.

---

## Google Ads Overview + Advisor

### GOOGLE-OVERVIEW-ADVISOR-01 · HIGH · EXTRA — Overview renders an entire Advisor section (tiles + advisor panel + Advisor's closing paragraph) the Overview design never defines

- **Design:** 05-google-ads-overview.html: 91 lines read end to end. Last element is the "Budget & scaling" <article> (71-90), then "</section>" (91). No advisor tile grid, no advisor card list, and the 'Apply executes through the guarded write boundary…' paragraph exists only in 06-google-ads-advisor.html:59.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1755-1787 — "{activePanel === "summary" && summaryAdvisor?.sections.length ? (<section className="space-y-3 rounded-[14px] border border-border/70 bg-card p-3">" wrapping "<GoogleAdvisorTiles/>", the line "Account-level growth decisions and lane orchestration", "<GoogleAdvisorPanel/>", and the guarded-write-boundary paragraph at 1771-1775; plus an "else" idle/empty section at 1778-1787.
- **Fix:** Delete the summary advisor block (1755-1787). Overview must end after GoogleBudgetScalingCard; move GoogleAdvisorTiles and the closing paragraph to the insights (Advisor) branch.

### GOOGLE-OVERVIEW-ADVISOR-02 · HIGH · EXTRA — Advisor screen opens with an 'Account decisions' + 'Decision Snapshot / Multi-window analysis' two-card band the design never draws

- **Design:** 06-google-ads-advisor.html:9-17 — the first content block after the page head is the "gAdvTiles" grid; line 18 immediately begins "<sc-for list="{{ gAdvCards }}">". No summary headline card, no operating-mode badge, no window card, no watchouts box anywhere in the 60-line fragment.
- **Code:** components/google/google-advisor-panel.tsx:1179-1285 — "<section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">" with 'Account decisions' + "advisor.summary.headline", badges, the four boxes Top constraint / Top growth lever / Recommended focus / Queue load, 'Watchouts', then 'Decision Snapshot' / 'Multi-window analysis' with Primary decision window / Query governance window / Baseline window / Selected-range context / Operator-first mode / Aggregate support. Reached from GoogleAdsIntelligenceDashboard.tsx:1790-1798 (insights branch).
- **Fix:** Remove the entire opening "<section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">" band (google-advisor-panel.tsx:1179-1285).

### GOOGLE-OVERVIEW-ADVISOR-03 · HIGH · EXTRA — Advisor screen renders an 'Opportunity Queue / Decision lanes' wrapper with four lane sub-sections the design has no concept of

- **Design:** 06-google-ads-advisor.html:18 "<sc-for list="{{ gAdvCards }}" as="c">" emits the cards as a FLAT sibling list of <article>s; grouping is carried only by the per-card bucket chip "{{ c.bucket }}" (line 21). No lane heading, description sentence, count badge or per-lane empty state exists.
- **Code:** components/google/google-advisor-panel.tsx:1291-1343 — "Opportunity Queue" / "Decision lanes" / 'Recommendations are grouped by operator lane, not by the selected date range.' then four "<QueueSection lane="review|test|watch|suppressed">". QueueSection (975-1026) adds its own bordered "<section>", an uppercase lane heading, "laneDescription()" (49-60, e.g. 'Operator-reviewed decisions that are complete enough to act on manually now.'), a count Badge, and 'No decisions in this lane right now.'
- **Fix:** Delete the Opportunity Queue section and QueueSection; render the recommendation cards as a flat list of sibling articles with the bucket carried only by the card-header chip.

### GOOGLE-OVERVIEW-ADVISOR-04 · HIGH · EXTRA — Advisor screen renders a 'Lifecycle, validation, and outcomes' workflow section the design does not have

- **Design:** 06-google-ads-advisor.html: all 60 lines contain only the tile grid (9-17), the gAdvCards loop (18-58) and the closing paragraph (59). No counts dashboard, no 'Validation due' list, no 'Recent outcomes' list.
- **Code:** components/google/google-advisor-panel.tsx:1287 "<WorkflowSection advisor={advisor} />"; body at 382+ renders 'Manual Workflow' / 'Lifecycle, validation, and outcomes', the New/Persistent/Escalated/Suppressed/Resolved counters, applied/outcome lists.
- **Fix:** Remove "<WorkflowSection />" from GoogleAdvisorPanel and delete the component.

### GOOGLE-OVERVIEW-ADVISOR-05 · HIGH · EXTRA — Advisor screen renders a 'Manual Action Packs / Bundled operator moves' cluster section the design does not have

- **Design:** 06-google-ads-advisor.html: no cluster, pack, step-order, dependency or cooldown element appears anywhere; the only list structure inside a card is the "c.changes" box (31-42).
- **Code:** components/google/google-advisor-panel.tsx:1289 "<ActionPackSection … />"; body at 1036-1137 renders 'Manual Action Packs', 'Bundled operator moves', 'These packs group related steps for human approval…', per-cluster badges, 'Manual recovery', and 'Prepare this pack for manual approval only…'.
- **Fix:** Remove "<ActionPackSection />" from GoogleAdvisorPanel and delete the component.

### GOOGLE-OVERVIEW-ADVISOR-06 · HIGH · EXTRA — Advisor card body carries five blocks of operator-workflow chrome the design card never defines

- **Design:** 06-google-ads-advisor.html:26-56 define the complete card body: action + "scope · …" line (27-30), the changes box (31-42), the four-up Expected effect / Why this now / Validation / Rollback grid (43-48), and the confidence + buttons footer (49-55). Nothing else.
- **Code:** components/google/google-advisor-panel.tsx — tinted 'Primary action' banner + 'Recommendation label: …' (622-656); Scope/Expected effect/Why this now bordered SurfaceBlock grid (658-672); a separate 'Evidence' DetailList (689-694); the Lifecycle / Execution state / Outcome / Manual workflow 4-block grid (715-753); the 'Operator actions' panel with Outcome and Confidence "<select>"s (755-893); the "<details>" disclosure 'Narrative context and legacy details' (895-950).
- **Fix:** Strip the card body to the design's four parts: action headline + mono scope line, the exact-changes box, the four-up grid, and the confidence+buttons footer. Delete the Primary-action banner, Evidence list, Lifecycle/Execution/Outcome/Manual-workflow grid, Operator-actions panel and the narrative disclosure.

### GOOGLE-OVERVIEW-ADVISOR-07 · HIGH · EXTRA — Overview carries a filter bar (toggle, two dropdowns, a second date picker, a Decision Snapshot button, a sync pill) the design has no trace of

- **Design:** 05-google-ads-overview.html:1-18 — the page head (2-8) is followed immediately by the "gHero" grid (9). No filter control, dropdown, date picker or button appears in the 91-line fragment; the only date control in the design lives in the shell top bar.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1514-1630 — mono "Filters" label (1520), "Include inactive with spend > 0" button (1531), "Type: …" DropdownMenu (1537), campaign-selection DropdownMenu (1553), an in-page "<DateRangePicker>" (1578) duplicating components/layout/v2/app-topbar.tsx:207-213 "testId="shell-date-range-picker"", "campaignScopeLabel" (1585), the advisor CTA button (1616), and "<SyncStatusPill>" (1623).
- **Fix:** Delete the filter bar block (1514-1630). Date scope already comes from the shell top-bar picker.

### GOOGLE-OVERVIEW-ADVISOR-08 · HIGH · EXTRA — Overview shows a sync-domain status card (Core / Visible coverage / Advisor) the design does not define

- **Design:** 05-google-ads-overview.html: all 91 lines read; the only freshness signal on the screen is the head pill "Synced 26m ago" (line 7). No per-domain status card exists.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1645-1651 — "<div className="rounded-[14px] border border-border/70 bg-card/70 p-3">" containing "<StatusDomainRow label="Core"/>", ""Visible coverage"", ""Advisor""; StatusDomainRow (321-343) renders a label, a coloured pill and a detail sentence.
- **Fix:** Delete the status-domain card at 1645-1651; the head pill already carries freshness.

### GOOGLE-OVERVIEW-ADVISOR-09 · HIGH · MISSING — Advisor screen has no advisor tile row (Do now / Do next / Blocked / Applied · 30d)

- **Design:** 06-google-ads-advisor.html:9-17 — "repeat(auto-fit,minmax(200px,1fr))" grid over "{{ gAdvTiles }}" is the Advisor screen's first content block. data-model.js gAdvTiles: "Do now"/'ranked by money at stake', "Do next"/'this week', "Blocked"/'feed fix first', "Applied · 30d"/'guarded writes · receipted'.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1789-1811 — the "activePanel === "insights"" branch renders only a bordered section wrapping "<GoogleAdvisorPanel>". "GoogleAdvisorTiles" is referenced only at line 1758, inside the summary branch.
- **Fix:** Render "<GoogleAdvisorTiles>" as the first child of the insights branch, above the card list, and remove it from the summary branch.

### GOOGLE-OVERVIEW-ADVISOR-10 · HIGH · MISSING — Advisor cards have no 'Apply (guarded)' and no 'Dismiss' button

- **Design:** 06-google-ads-advisor.html:52-53 — "<button onClick="{{ c.queue }}" style="height:30px;…background:{{ c.ctaBg }};color:{{ c.ctaFg }}…">{{ c.cta }}</button>" and a bordered white "Dismiss" button. data-model.js "advCard" defaults "cta: 'Apply (guarded)', ctaBg: '#2F6BFF', ctaFg: '#ffffff'"; only the blocked card overrides to 'Open Products'.
- **Code:** components/google/google-advisor-panel.tsx:765-888 render 'Mark applied', 'Suppress 7d'/'Unsuppress', 'Mark complete', 'Log outcome'; 952-969 render 'Open in Google Ads' and 'Jump to entity' as the card's last element. No button carries 'Apply (guarded)' or 'Dismiss'.
- **Fix:** Give each card a right-aligned footer with a primary h30 'Apply (guarded)' button (accent bg, white text) and a secondary bordered 'Dismiss' button; drop the four operator-workflow buttons.

### GOOGLE-OVERVIEW-ADVISOR-11 · HIGH · WRONG — Advisor screen is type-filtered so three of the design's six card kinds can never appear on it

- **Design:** 06-google-ads-advisor.html:18 loops the whole "gAdvCards" list. data-model.js gAdvCards defines six cards typed 'Query governance', 'Budget reallocation', 'Keyword buildout', 'Target strategy', 'Asset group restructure', 'Product allocation' — all six on the Advisor screen.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1325-1331 "const insightsAdvisor = filterAdvisorByTypes(advisorCurrent, ["non_brand_expansion","query_governance","keyword_buildout","geo_device_adjustment","diagnostic_guardrail"]);" — budget_reallocation, product_allocation, asset_group_structure and pmax_scaling_fit are excluded and routed to the summary/products/assets panels instead (1318-1347).
- **Fix:** Pass the unfiltered "advisorCurrent" to the Advisor panel so every recommendation type can appear, as the design does.

### GOOGLE-OVERVIEW-ADVISOR-12 · HIGH · WRONG — Hero KPI band has five cards in a fixed 5-column grid instead of the design's four in an auto-fit grid, and the order differs

- **Design:** 05-google-ads-overview.html:9 "grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px" over "{{ gHero }}" with "hint-placeholder-count="4"". data-model.js gHero gives exactly four, in order: "Spend · 28d", "Conv value", "ROAS", "Conversions".
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1656 "<div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">" with five "<Kpi>" cards at 1659-1663 in order Spend, ROAS, Revenue, Conv, CPA.
- **Fix:** Reduce to four cards in the design's order — Spend, Conv value, ROAS, Conversions — on "[grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]". CPA belongs in the secondary strip.

### GOOGLE-OVERVIEW-ADVISOR-13 · HIGH · WRONG — Secondary metric strip has seven cells in the wrong order, adds two the design does not have and drops CPA

- **Design:** 05-google-ads-overview.html:19-27, "hint-placeholder-count="6"". data-model.js gSecondary gives six in order: "CPA", "CPC", "CTR", "Conv rate", "Impressions", "Clicks". No Impression Share cell, no Lost IS cell.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1668-1723 renders seven "<OverviewMetric>" cells in order Impressions, Clicks, CTR, Average CPC, Conversion Rate, Impression Share, Lost IS (Budget).
- **Fix:** Render exactly six cells in the order CPA, CPC, CTR, Conv rate, Impressions, Clicks; drop Impression Share and Lost IS (Budget); rename 'Average CPC' → 'CPC' and 'Conversion Rate' → 'Conv rate'.

### GOOGLE-OVERVIEW-ADVISOR-14 · MEDIUM · EXTRA — Overview shows a blended-account scope receipt row with an account <select> the design does not define

- **Design:** 05-google-ads-overview.html: all 91 lines read — the page head (2-8) is the only chrome above the hero grid and contains no account selector and no scope notice.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1457-1487 — a "role="status"" row rendering 'Blended view' / 'Scoped to one account', "accountScope.notice", and a "<select>" whose first option is 'All assigned accounts (blended)'.
- **Fix:** Remove the scope-receipt row from the screen body; account scoping belongs to the shell top bar in the design.

### GOOGLE-OVERVIEW-ADVISOR-15 · MEDIUM · MISSING — Advisor card has no mono confidence footer line, and the Advisor screen has no closing guarded-write paragraph

- **Design:** 06-google-ads-advisor.html:50 "<span style="font-family:'IBM Plex Mono';font-size:10px;color:#98A4BA">{{ c.conf }}</span>" on the footer row (e.g. 'high confidence · low risk · blast radius: 1 campaign · contract v2 · native'); line 59 the closing 11px mono paragraph 'Apply executes through the guarded write boundary — …'.
- **Code:** components/google/google-advisor-panel.tsx:952-969 is the card's last element — an 'Open in Google Ads' / 'Jump to entity' row with no confidence line. GoogleAdsIntelligenceDashboard.tsx:1789-1811 (the whole insights branch) has no closing paragraph; that copy sits at 1771-1775 in the summary branch.
- **Fix:** Add the mono 10px confidence line to each card footer, left of the buttons, and move the guarded-write paragraph to the end of the insights branch.

### GOOGLE-OVERVIEW-ADVISOR-16 · MEDIUM · WRONG — Advisor tile captions are all four different from the design's

- **Design:** data-model.js gAdvTiles — labels "Do now", "Do next", "Blocked", "Applied · 30d"; subs 'ranked by money at stake', 'this week', 'feed fix first', 'guarded writes · receipted'. Rendered by 06-google-ads-advisor.html:12-14.
- **Code:** components/google-ads/GoogleAdvisorTiles.tsx:30-42 — "{ label: "Open findings", sub: "ranked by the advisor" }, { label: "High priority", sub: "act on these first" }, { label: "Money at stake", … }, { label: "Blocked", sub: "waiting on data or access" }".
- **Fix:** Rename the four tiles to Do now / Do next / Blocked / Applied · 30d with the design's sub-lines, counted from the same bucket the card header uses.

### GOOGLE-OVERVIEW-ADVISOR-17 · MEDIUM · WRONG — Advisor card header is missing the money-at-stake figure and replaces the mode chip with unrelated badges

- **Design:** 06-google-ads-advisor.html:20-25 — header band = bucket chip "{{ c.bucket }}", mono uppercase type "{{ c.type }}", a bordered mode chip "{{ c.mode }}" ('bounded range', 'bounded preview', 'heuristic only', 'directional only', 'blocked'), then "font-size:14.5px;font-weight:700" "{{ c.money }}" ('$180–$320/mo', '+$0.9k/mo', 'volume-first', 'structure', '—').
- **Code:** components/google/google-advisor-panel.tsx:588-620 — header renders a lane "Badge", "familyLabel(...)", "<Badge variant="outline">{labelize(recommendation.strategyLayer)}</Badge>", plus conditional 'Manual plan only' / 'AI-structured assist' / 'Legacy snapshot compatibility' badges, and a right-hand three-line Confidence: / Risk: / Blast radius: block. No money figure, no mode chip.
- **Fix:** Header = bucket chip, mono uppercase type, bordered mode chip from the estimation mode, money figure at 14.5px/700 on the right. Remove the strategy-layer and conditional badges; move confidence/risk/blast-radius into the single mono footer line.

### GOOGLE-OVERVIEW-ADVISOR-18 · MEDIUM · WRONG — Advisor card's scope and effect blocks use the wrong structure — bordered blocks in a 3-up grid instead of a mono scope line and one 4-up text grid

- **Design:** 06-google-ads-advisor.html:28-29 — action "font-size:15.5px;font-weight:600" then "font-family:'IBM Plex Mono';font-size:10.5px" "scope · {{ c.scope }}". Lines 43-48 — a single "repeat(auto-fit,minmax(210px,1fr))" grid of four PLAIN label+paragraph pairs: Expected effect | Why this now | Validation | Rollback, the fourth label swapping to "{{ c.lastLabel }}" = 'Unblock path' when blocked.
- **Code:** components/google/google-advisor-panel.tsx:658-672 renders Scope, Expected effect and Why this now as three bordered "SurfaceBlock" cards in "grid gap-3 md:grid-cols-2 xl:grid-cols-3"; 689-712 renders Evidence / Validation / Rollback / Blocked because as bordered "DetailList" chip boxes in a separate grid.
- **Fix:** Render scope as a mono 10.5px "scope · …" line under the action, and put Expected effect / Why this now / Validation / Rollback into one "repeat(auto-fit,minmax(210px,1fr))" grid of unbordered label+paragraph pairs, with the fourth label switching to 'Unblock path' on blocked cards.

### GOOGLE-OVERVIEW-ADVISOR-19 · MEDIUM · WRONG — 'Where to look first' severity chips use a different, smaller vocabulary than the design

- **Design:** data-model.js gLook — "sev" values "Critical", "Waste", "Opportunity", "Positive", each with its own bg/fg pair (C.neg, C.warn, C.pos, C.info). Rendered at 05-google-ads-overview.html:31.
- **Code:** components/google-ads/GoogleWhereToLookFirst.tsx:12-16 — "const SEVERITY_STYLE = { high: {…label: "Risk"}, medium: {…label: "Watch"}, low: {…label: "Opportunity"} }" — three labels, none of which is Critical, Waste or Positive.
- **Fix:** Map the advisor's severity/kind onto the design's four chip labels Critical / Waste / Opportunity / Positive with their matching tone roles.

### GOOGLE-OVERVIEW-ADVISOR-20 · MEDIUM · WRONG — 'Where to look first' is fed from a 4-type advisor subset, so the product, search-term and keyword findings the design's band is built from can never surface

- **Design:** data-model.js gLook — the four cards point at Products ('Open Products'), Search terms ('Open Search'), Advisor ('See Advisor') and Keywords ('Open Keywords'); the band spans every Google surface.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1318-1323 "const summaryAdvisor = filterAdvisorByTypes(advisorCurrent, ["operating_model_gap","brand_capture_control","pmax_scaling_fit","budget_reallocation"]);" and 1727-1731 feeds "summaryAdvisor.recommendations" into "<GoogleWhereToLookFirst>" — query_governance, keyword_buildout and product_allocation are excluded.
- **Fix:** Feed "GoogleWhereToLookFirst" from the unfiltered "advisorCurrent.recommendations" so any surface's finding can rank into the band.

### GOOGLE-OVERVIEW-ADVISOR-21 · MEDIUM · WRONG — Budget & scaling KPI strip uses four different captions from the design

- **Design:** data-model.js gBudgetKpis — labels "Ready to scale", "Budget-limited", "Low-efficiency spend", "Suggested net shift"; subs 'Search — Brand', 'losing IS to budget', 'Shopping — Core feed', 'moved, not added'. Rendered at 05-google-ads-overview.html:73-81.
- **Code:** components/google-ads/GoogleBudgetScalingCard.tsx:46-73 — "{ label: "Daily budget", sub: "N campaigns" }, { label: "Capped by budget", sub: "losing impression share" }, { label: "Suggested moves", sub: "N up · N down" }, { label: "Net shift", sub: "vs today's budget" }".
- **Fix:** Rename the four KPIs to Ready to scale / Budget-limited / Low-efficiency spend / Suggested net shift, with the design's sub-lines.

### GOOGLE-OVERVIEW-ADVISOR-22 · MEDIUM · WRONG — Page-head eyebrow drops the currency and window segments and prefixes the account id with 'Account'

- **Design:** 05-google-ads-overview.html:4 and 06-google-ads-advisor.html:4 (identical): "Google Ads · 493-118-2201 · USD · 28d window" — four segments, the account id bare, then currency, then the window.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:518-520 — ""return "Google Ads · ${accountId ? "Account ${accountId}" : "Account —"} · ${effectiveGoogleTimeZoneLabel}";"" — three segments, an 'Account ' prefix, and the time-zone label in place of currency + window.
- **Fix:** Build the eyebrow as "Google Ads · <accountId> · <currencyCode> · <window> window"; drop the 'Account ' prefix and the time-zone segment.

### GOOGLE-OVERVIEW-ADVISOR-23 · MEDIUM · WRONG — Campaign type chip is always neutral instead of tone-coded by channel

- **Design:** 05-google-ads-overview.html:56 "background:{{ r.tBg }};color:{{ r.tFg }}". data-model.js gCampaignRows: Performance Max uses C.info, Search uses neu (#F1F4F9/#45526B), Shopping uses C.auto — three distinct tones.
- **Code:** components/google-ads/GoogleCampaignsTable.tsx:111-113 — "<span className="mt-[3px] inline-flex rounded-md bg-[var(--adv-fill-2)] px-[7px] py-px text-[10px] font-semibold text-[var(--adv-ink-2)]">{row.channel}</span>" — one hard-coded neutral tone for every channel.
- **Fix:** Tone the channel chip by channel: Performance Max → info, Shopping → auto/violet, Search and everything else → neutral.

### GOOGLE-OVERVIEW-ADVISOR-24 · MEDIUM · WRONG — The ROAS hero card renders green-tinted when ROAS ≥ 3; the design's hero cards are uniformly white

- **Design:** 05-google-ads-overview.html:11 — every gHero card is "border-radius:14px;background:#ffffff;border:1px solid #E4E8F0;padding:16px" and the value (line 13) is always "color:#0E1526". No highlight variant exists; data-model.js gives the ROAS card only a neutral delta colour "#45526B".
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1660 "<Kpi label="ROAS" … highlight={blendedRoas >= 3} … />"; Kpi at 2489-2503 applies "highlight && "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)]"" and "highlight ? "text-[var(--adc-pos-fg)]" : …".
- **Fix:** Drop the "highlight" prop from the ROAS Kpi call so every hero card renders on --adv-surface with --adv-ink values.

### GOOGLE-OVERVIEW-ADVISOR-25 · MEDIUM · WRONG — Advisor card's exact-changes block is a headed 2-column grid of bordered boxes instead of the design's single bordered box of 200px-label + chip rows

- **Design:** 06-google-ads-advisor.html:31-42 — ONE bordered box ("border:1px solid #EDF0F6;border-radius:10px;padding:11px 13px") whose children are rows of a fixed "width:200px" mono 9.5px uppercase label (line 34) beside a wrapping chip list (36-38). There is no 'Exact changes' heading above it and no sub-grid.
- **Code:** components/google/google-advisor-panel.tsx:674-687 — "<div className="text-[10px] uppercase tracking-wide text-muted-foreground">Exact changes</div>" above a "grid gap-3 md:grid-cols-2" of separate bordered "<DetailList>" boxes, one per change block, each with its own title and border.
- **Fix:** Render the change blocks as rows inside one bordered 10px-radius box: a 200px mono 9.5px uppercase label column beside the wrapping chips, and drop the 'Exact changes' heading and the per-block borders.

### GOOGLE-OVERVIEW-ADVISOR-26 · LOW · EXTRA — Advisor screen wraps the whole card list in an extra bordered card, and spaces its children at 12px instead of the design's 16px

- **Design:** 06-google-ads-advisor.html:1 — the screen is "display:flex;flex-direction:column;gap:16px" and the advisor "<article>" cards (19-57) are direct children of it, with no wrapper card between the tile grid and the cards.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1790 — "<section className="space-y-3 rounded-[14px] border border-border/70 bg-card p-3">" wraps "<GoogleAdvisorPanel …>" (1796-1802), adding a border, a card background, 12px padding and 12px child spacing around the whole card list.
- **Fix:** Drop the wrapper section on the insights branch so the tiles, the cards and the closing paragraph are direct children of the screen's 16px flex column.

### GOOGLE-OVERVIEW-ADVISOR-27 · LOW · EXTRA — Overview renders a 'Reconnect Google Ads' banner above the metric bands; the design carries access state only in the head pill

- **Design:** 05-google-ads-overview.html: all 91 lines read — the only status affordance on the screen is the head pill at line 7 ("Synced 26m ago", a tone-carrying pill). No banner, callout or notice block appears anywhere between the head and the hero grid.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1632-1644 — "{shouldShowActionRequiredBanner ? (<div role="status" className="rounded-[14px] border border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] px-4 py-3 text-sm …"><p className="font-semibold">Reconnect Google Ads</p>…". The same state is already reported by the head pill, which sets "{ tone: "neg", label: "Reconnect required" }" at 526-528.
- **Fix:** Remove the banner and let the head pill's "Reconnect required" tone carry the state, as the design does.

### GOOGLE-OVERVIEW-ADVISOR-28 · LOW · GEOMETRY — Page-head eyebrow is 12px; the design pins 11px

- **Design:** 05-google-ads-overview.html:4 / 06-google-ads-advisor.html:4 — "font-size:11px;letter-spacing:0.12em".
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1435 — "className="m-0 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]"".
- **Fix:** Change "text-[12px]" to "text-[11px]" on the eyebrow paragraph.

### GOOGLE-OVERVIEW-ADVISOR-29 · LOW · GEOMETRY — Hero KPI grid gap is 8px and the hero sparkline is 40px tall; the design pins 12px and 56px

- **Design:** 05-google-ads-overview.html:9 "gap:12px". data-model.js gHero: every card calls "gChart(…, 56)" and gChart's final parameter is the chart height ("height: hgt").
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1656 "className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5"" (gap-2 = 8px); Kpi at 2528 "<MiniTrendAreaChart … className="h-10 w-full" />" (40px).
- **Fix:** Use "gap-3" (12px) on the hero grid and "h-14" (56px) on the hero sparkline.

### GOOGLE-OVERVIEW-ADVISOR-30 · LOW · GEOMETRY — A 24px margin is added under the metric bands where the design uses its uniform 16px column gap

- **Design:** 05-google-ads-overview.html:1 — the screen is "display:flex;flex-direction:column;gap:16px", and every child (hero grid 9, secondary card 19, gLook grid 28) carries no margin of its own.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1655 "{activePanel === "summary" && <section className="mb-6">" on top of the parent's "flex flex-col gap-4" (1429), producing 40px before 'Where to look first'.
- **Fix:** Remove "mb-6" so the parent's 16px gap is the only spacing.

### GOOGLE-OVERVIEW-ADVISOR-31 · LOW · GEOMETRY — Budget & scaling sub-lines and rec text are 12px where the design pins 11px and 11.5px

- **Design:** 05-google-ads-overview.html:78 (KPI sub) "font-size:11px"; line 85 (amount chip) "font-size:11.5px;font-weight:700"; line 86 (reason) "font-size:11.5px;line-height:1.5".
- **Code:** components/google-ads/GoogleBudgetScalingCard.tsx:100 "className="m-0 mt-0.5 text-[12px] text-[var(--adv-ink-3)]""; 119 "className="rounded-md px-2 py-0.5 text-[12px] font-bold tabular-nums""; 132 "className="m-0 mt-1.5 text-[12px] leading-[1.5] text-[var(--adv-ink-3)]"".
- **Fix:** Set the KPI sub to "text-[11px]", and the amount chip and reason paragraph to "text-[11.5px]".

### GOOGLE-OVERVIEW-ADVISOR-32 · LOW · GEOMETRY — Campaigns table header cells use 12px horizontal padding on the first and last columns where the design pins 16px, so headers no longer align with their body cells

- **Design:** 05-google-ads-overview.html:42 (Campaign th) and 51 (Pulse th) "padding:9px 16px"; the middle eight th's are "padding:9px 12px" (43-50). Body cells match: lines 56 and 65 use "padding:11px 16px".
- **Code:** components/google-ads/GoogleCampaignsTable.tsx:55-56 — one shared "const HEAD = "px-3 py-[9px] …"" (12px) applied to all ten th's at 87-96, while the matching body cells at 107 and 168 use "px-4" (16px).
- **Fix:** Give the first and last header cells "px-4", keeping "px-3" for the middle eight.

### GOOGLE-OVERVIEW-ADVISOR-33 · LOW · WRONG — Campaigns table subtitle says 'vs account' instead of 'vs target', and the Spend column loses its window suffix

- **Design:** 05-google-ads-overview.html:39 "4 active · vs target 3.80 · impression-share signals are Google-served"; line 44 column header "Spend · 28d".
- **Code:** components/google-ads/GoogleCampaignsTable.tsx:82 — "{activeCount} active · vs account {benchmark.toFixed(2)} · impression-share signals are Google-served"; line 90 — "<th className={"${HEAD} text-right"}>Spend</th>".
- **Fix:** Change 'vs account' to 'vs target' and label the spend column 'Spend · <window>'.

### GOOGLE-OVERVIEW-ADVISOR-34 · LOW · WRONG — ROAS cell appends an 'x' the design does not render, and budget-shift chips drop the '/day' unit

- **Design:** 05-google-ads-overview.html:61 renders "{{ r.roas }}" and data-model.js supplies bare numbers ('3.76', '3.43', '2.82', '5.88'); line 85 renders "{{ b.amt }}" and data-model.js supplies '+$120/day', '+$80/day', '−$200/day'.
- **Code:** components/google-ads/GoogleCampaignsTable.tsx:147 — ""{Number.isFinite(row.roas) ? "${row.roas.toFixed(2)}x" : "—"}"". components/google-ads/GoogleBudgetScalingCard.tsx:119-129 — the amount chip renders "{up ? "+" : "−"}{currencyFormatter(...)}" with no '/day' suffix.
- **Fix:** Render ROAS as a bare two-decimal number and suffix budget-shift amounts with '/day'.

### GOOGLE-OVERVIEW-ADVISOR-35 · LOW · WRONG — Budget & scaling subtitle drops the design's 'net $0 added' clause

- **Design:** 05-google-ads-overview.html:72 "suggested shifts are advisor previews — net $0 added, applied as guarded writes from the Plan page".
- **Code:** components/google-ads/GoogleBudgetScalingCard.tsx:84 — "suggested shifts are advisor previews — applied as guarded writes from the Plan page".
- **Fix:** Restore the full sentence including 'net $0 added, '.

---

## Google Ads Search + Products

### GOOGLE-SEARCH-PRODUCTS-01 · HIGH · EXTRA — Search screen carries an "Escape hatch" card with Copy negatives / Download CSV buttons and a Google Ads deep link

- **Design:** 07-google-ads-search.html read end to end (lines 1-98): the only interactive elements are the tab pills (line 11) and the four filter pills (line 25). Nothing sits between the filter row (23-27) and the table article (28); there is no button, no anchor, no secondary card anywhere in the fragment.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1900-2008 — a bordered card containing "Escape hatch" (:1904), "Read-only hop into Google Ads, scoped to the account in view." (:1907), "<button>Copy negatives</button>" (:1935), "<button>Download CSV</button>" (:1960) and "<a target="_blank">{describeGoogleAdsDeepLink({ kind: "search_terms" })}</a>" (:1980-2002). The code's own comment at :1896 concedes "The design closes this screen on the served tables".
- **Fix:** Delete the Escape hatch card (:1900-2008) from the Search panel. If the export/deep-link path must survive, move it to shell chrome or the Plan screen; it is not part of the design's Search intelligence surface.

### GOOGLE-SEARCH-PRODUCTS-02 · HIGH · EXTRA — Search screen renders two "When and where ads showed" geo/device cards the design has no trace of

- **Design:** 07-google-ads-search.html contains no geography, location or device element in lines 1-98; the terms branch closes on the footnote at line 58 and the keywords branch closes on the footnote at line 96. 08-google-ads-products.html likewise contains none.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:2029-2075 — "<div className="grid gap-2 xl:grid-cols-2">" holding "When and where ads showed - Locations" (:2031) and "When and where ads showed - Devices" (:2054), each row printed as "Spend {fmtCurrency(row.spend)} · ROAS {fmtRoas(row.roas)}" on "rounded-lg border border-border/70 bg-card" cards that use none of the --adv tokens.
- **Fix:** Remove both cards from the Search panel, along with the two now-orphaned "SurfaceRecoveryNotice" strips for geo and device at :1879-1880 and the geo/device queries in the "needsSearchData" gate.

### GOOGLE-SEARCH-PRODUCTS-03 · HIGH · EXTRA — Search screen adds a second chip strip (Search terms / PMax / Search / Negative / Positive) above the table

- **Design:** 07-google-ads-search.html has exactly one pill row under the stat cards — gTermFilters at lines 23-27 — and the table article follows immediately at line 28. No PMax/Search source split appears in the fragment or in data-model.js's gTermStats / gTermFilters definitions.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1888-1894 — "<div className="flex flex-wrap items-center gap-1.5 text-[11px]">" with "Search terms {scopedSearchTerms.length}", "PMax {searchSourceCounts.pmax}", "Search {searchSourceCounts.search}", "Negative {searchTermNegativeRows.length}", "Positive {searchTermPositiveRows.length}".
- **Fix:** Delete the chip strip at :1888-1894; the design's counts already ride on the four filter pills.

### GOOGLE-SEARCH-PRODUCTS-04 · HIGH · EXTRA — Products screen embeds the full GoogleAdvisorPanel (and an EmptyState in its place) inside the design's Products column

- **Design:** 08-google-ads-products.html:18-60 — the two-column grid holds exactly two children: the Products table article (19-43) and the Allocation read article (44-59). No advisor card, no queue, no buttons appear anywhere in the fragment; the closing footnote at line 61 is the last element.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:2235-2245 — "{productsAdvisor?.sections.length ? (<GoogleAdvisorPanel advisor={productsAdvisor} onFocusEntity={...} businessId={...} accountId={...} onRefreshAdvisor={...} />) : (<EmptyState title={advisorIdleState.title} ... />)}", nested inside the left grid track's "flex flex-col gap-3" div opened at :2222.
- **Fix:** Remove the GoogleAdvisorPanel and its EmptyState fallback from the products panel; the design keeps advisor content on the Advisor screen and shows only the read-only Allocation read summary here.

### GOOGLE-SEARCH-PRODUCTS-05 · HIGH · EXTRA — Search body is wrapped in an extra bordered card with a caption line, nesting the design's table cards inside a second card

- **Design:** 07-google-ads-search.html:28 — the table article "<article style="border-radius:14px;background:#ffffff;border:1px solid #E4E8F0;overflow-x:auto">" is a direct child of the 16px-gap section opened at line 1. There is no outer container and no caption sentence introducing the screen.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1875 "<div className="space-y-3 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-3">" followed at :1876 by "<p className="text-xs text-muted-foreground">Search terms and when/where ads appeared metrics</p>"; that div closes only at :2078, so both design table cards (and both footnotes) render inside a second bordered card with a doubled border.
- **Fix:** Unwrap the search body: delete the outer bordered div and the caption paragraph so the stat grid, filter row, terms table and keywords table sit as direct children of the 16px flex column.

### GOOGLE-SEARCH-PRODUCTS-06 · HIGH · MISSING — Search screen has no Search terms / Keywords tab row — both tables render stacked at once

- **Design:** 07-google-ads-search.html:9-13 renders "<sc-for list="{{ gSearchTabs }}" as="t">" pills (h32, pad 0 13px, radius 9999, 12.5px/600); data-model.js gSearchTabs = mkTabs([['terms','Search terms'],['keywords','Keywords']], st.gSearchTab, 'gSearchTab'). The bodies are mutually exclusive: line 14 "<sc-if value="{{ gsTerms }}">" closes at line 59, line 60 "<sc-if value="{{ gsKeywords }}">" closes at line 97.
- **Code:** components/google-ads/GoogleAdsIntelligenceDashboard.tsx:1865-2080 — the "activePanel === "search"" section renders no pill row (the only pill row in the file, PANEL_ITEMS at :1489-1497, is suppressed by "{panel ? null : ...}" and the route passes panel="search" via GoogleWorkspaceScreen.tsx:83-87). Both tables mount unconditionally: "<GoogleSearchTermsTable" :2012 and "<GoogleKeywordsTable" :2024. Verified SearchTab.tsx / SearchTermsTab.tsx / KeywordsTab.tsx are imported nowhere (grep for "google-ads/SearchTab" etc. returns nothing).
- **Fix:** Add the two-pill tab row ("Search terms", "Keywords") as the second child of the Search section — h32, px 13, radius 9999, 12.5px/600, active #0B1020 bg / #ffffff fg / #0B1020 bd, inactive #ffffff / #45526B / #E4E8F0 — and render the terms block (stat cards + filter pills + terms table + its footnote) and the keywords block (kw stat pills + keywords table + its footnote) mutually exclusively from that state.

### GOOGLE-SEARCH-PRODUCTS-07 · HIGH · WRONG — Products feed tiles are a different four-tile set than the design's feed-health tiles

- **Design:** data-model.js gFeedTiles = [{ k:'Products serving', v:'214', sub:'of 226 in feed' }, { k:'Limited', vFg:'#B45309', sub:'missing GTIN · price mismatch' }, { k:'Disapproved', vFg:'#D64550', sub:'blocks their listing groups' }, { k:'Feed synced', sub:'Shopify → Merchant Center' }], rendered at 08-google-ads-products.html:9-17.
- **Code:** components/google-ads/GoogleFeedTiles.tsx:23-48 — the four tiles are "Products with spend" / "${rows.length} in the served feed", "Converting" / "…% of spenders", "Draining spend" / "N negative-contribution products", "Scale candidates" / "server-assigned status". None of the four design labels survives, including "Feed synced", whose value the app already has in the sync-status payload it uses for the header pill.
- **Fix:** Rebuild the tiles on the design's feed-health read: Products serving (of N in feed), Limited (missing GTIN · price mismatch, #B45309), Disapproved (blocks their listing groups, #D64550), Feed synced (Shopify → Merchant Center). Where the shopping report genuinely does not carry a feed state, keep the design's label and show an em dash rather than substituting a different metric — the current tiles answer a different question in the design's slot.

### GOOGLE-SEARCH-PRODUCTS-08 · HIGH · WRONG — Search-term stat cards carry different labels, a different third metric, and a wrong dot tone

- **Design:** data-model.js gTermStats = [{ v:'$2,140', k:'wasted on zero-conv terms · 28d', dot:'#D64550' }, { v:'6', k:'converting terms not yet keywords', dot:'#6C41BE' }, { v:'11', k:'high-performing terms', dot:'#0E9F6E' }], rendered at 07-google-ads-search.html:15-22.
- **Code:** components/google-ads/GoogleSearchStats.tsx:47-63 — stat 1 label "spend on ${counts.waste} wasteful term…"; stat 2 is a currency value labelled "revenue from ${counts.opportunity} unharvested term…" with "DOTS.opportunity = "var(--adc-pos-fg)"" (green; design pins purple #6C41BE); stat 3 is "String(counts.negative)" labelled ""negative-keyword candidates"" with "DOTS.negative = "var(--adc-caution-fg)"" (amber) where the design's third stat is a green high-performing-terms count.
- **Fix:** Restore the three design stats and tones: wasted spend on zero-conversion terms (#D64550 dot), count of converting terms not yet keywords (#6C41BE dot), count of high-performing terms (#0E9F6E dot).

### GOOGLE-SEARCH-PRODUCTS-09 · HIGH · WRONG — Search-term filter pills use a different label set and replace "High performing" with "Negative candidates"

- **Design:** data-model.js gTermFilters = [['all','All terms',…], ['wasteful','Wasteful',…], ['opportunity','KW opportunity',…], ['high','High performing',…]], rendered at 07-google-ads-search.html:23-27 with the count in a mono 10px span at 0.75 opacity.
- **Code:** components/google-ads/GoogleSearchStats.tsx:65-70 — "const filters = [{ key: "all", label: "All terms" }, { key: "waste", label: "Waste" }, { key: "opportunity", label: "Opportunity" }, { key: "negative", label: "Negative candidates" }]". Three of the four labels differ and the fourth filter selects a different category than the design's high performers.
- **Fix:** Rename the pills to "All terms", "Wasteful", "KW opportunity", "High performing", and back the fourth with a high-performing predicate (converting terms above target ROAS) rather than negative-keyword candidates.

### GOOGLE-SEARCH-PRODUCTS-10 · HIGH · WRONG — Search-terms ROAS chip has no target, so every positive-ROAS row renders the same amber tint

- **Design:** 07-google-ads-search.html:50 pins the ROAS chip as the only colour in the row, and data-model.js's gTermsAll spreads it across four tones: C.pos green for 5.78 / 12.0 / 3.93, neutral for 3.17, C.warn amber for 2.99, C.neg red for 0.59, and neutral grey for the em-dash rows. The chip is what makes the column readable at a glance.
- **Code:** components/google-ads/GoogleSearchTermsTable.tsx:25-34 "roasTone(roas, target)" returns pos only "if (target && roas >= target)" and danger only "if (target && roas < target * 0.75)", otherwise falling through to caution; "targetRoas" defaults to "null" (:39) and the only call site, GoogleAdsIntelligenceDashboard.tsx:2012-2021, passes just "rows" and "currencyFormatter". With target null every row whose ROAS is above 0 takes the caution branch, so the whole column renders one flat amber and the design's green/red signal never appears.
- **Fix:** Pass the account's target ROAS (or the blended account ROAS the dashboard already computes for "blendedRoas") into "targetRoas", and make roasTone fall back to a neutral fill rather than caution when no target is available, so an unknown target reads as grey instead of a false warning.

### GOOGLE-SEARCH-PRODUCTS-11 · HIGH · WRONG — Filter pill counts and the rows the filter actually shows are computed from different predicates, and the filtered table is capped at 8 rows

- **Design:** data-model.js derives both sides from one tag list: "tCount = (t) => gTermsAll.filter((x) => x.tags.indexOf(t) >= 0).length" feeds the pill counts, and "gTermRows = gTermsAll.filter((t) => st.gTermFilter === 'all' ? true : t.tags.indexOf(st.gTermFilter) >= 0)" feeds the table — the badge on a pill is exactly the number of rows pressing it produces, and nothing is truncated.
- **Code:** components/google-ads/GoogleSearchStats.tsx:19-26 counts "waste" by "row.wasteFlag", "opportunity" by "row.keywordOpportunityFlag", "negative" by "row.negativeKeywordFlag". But GoogleAdsIntelligenceDashboard.tsx:2013-2019 feeds the table "searchTermNegativeRows" for both "waste" and "negative", and "searchTermPositiveRows" for "opportunity" — and those are defined at :1191-1219 with much broader predicates ("negativeKeywordFlag || wasteFlag || (spend > 20 && conversions === 0) || (spend > 20 && roas < 1.3)") plus ".slice(0, 8)". A pill reading "Wasteful 14" therefore shows at most 8 rows, selected by a different rule, and the "Waste" and "Negative candidates" pills show the identical table.
- **Fix:** Filter the table from the same flags the pill counts read ("wasteFlag", "keywordOpportunityFlag", and the high-performing predicate), drop the ".slice(0, 8)" for the on-screen table, and keep the broader negative-pack predicate scoped to the export/advisor path where it belongs.

### GOOGLE-SEARCH-PRODUCTS-12 · MEDIUM · GEOMETRY — Active filter pill is the blue accent (#EAF0FF / #2F6BFF) where the design pins near-black #0B1020 on white

- **Design:** data-model.js gTermFilters mapper: "bg: a ? '#0B1020' : '#ffffff', color: a ? '#ffffff' : '#45526B', bd: a ? '#0B1020' : '#E4E8F0'" — the same active treatment mkTabs applies to the tab pills.
- **Code:** components/google-ads/GoogleSearchStats.tsx:105-109 — "borderColor: on ? "var(--adv-accent-bd)" : …, background: on ? "var(--adv-accent-bg)" : …, color: on ? "var(--adv-accent)" : …", with app/globals.css:118-121 defining "--adv-accent: #2f6bff; --adv-accent-bg: #eaf0ff; --adv-accent-bd: #cbd9ff;".
- **Fix:** Set the active pill to background #0B1020, colour #ffffff, border #0B1020; keep inactive at #ffffff / #45526B / #E4E8F0, and use the same treatment for the Search terms / Keywords tab pills once they exist.

### GOOGLE-SEARCH-PRODUCTS-13 · MEDIUM · WRONG — Keyword insight pills report row counts and QS buckets instead of the design's three diagnostic tallies

- **Design:** data-model.js gKwStats = [{ n:'4', fg:'#B45309', t:'keywords: high CTR, zero conversions' }, { n:'3', fg:'#2F6BFF', t:'with conversions but low impression share' }, { n:'2', fg:'#6C41BE', t:'may deserve their own ad group' }], rendered at 07-google-ads-search.html:61-65.
- **Code:** components/google-ads/GoogleKeywordsTable.tsx:62-66 — "[{ n: rows.length, label: "keywords", fg: "var(--adv-ink)" }, { n: strong, label: "quality score 8+", fg: "var(--adc-pos-fg)" }, { n: weak, label: "quality score ≤5", fg: "var(--adc-danger-fg)" }]". All three labels and all three tones differ; every field the design's tallies need (ctr, conversions, impressionShare) is already on GoogleKeywordRow (:18-27).
- **Fix:** Replace the three pills with the design's tallies and tones: high-CTR-zero-conversion count (#B45309), converting-but-low-impression-share count (#2F6BFF), deserves-own-ad-group count (#6C41BE), with the design's wording.

### GOOGLE-SEARCH-PRODUCTS-14 · MEDIUM · WRONG — Keywords table renders ROAS as plain text; the design pins a tinted ROAS chip

- **Design:** 07-google-ads-search.html:87 — "<td style="padding:10px 12px;text-align:right"><span style="display:inline-flex;border-radius:6px;padding:2px 8px;font-size:11.5px;font-weight:700;background:{{ r.rBg }};color:{{ r.rFg }}">{{ r.roas }}</span></td>", with data-model.js seeding pos / neutral / warn tints per row.
- **Code:** components/google-ads/GoogleKeywordsTable.tsx:142-144 — "<td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">{typeof row.roas === "number" && row.roas > 0 ? row.roas.toFixed(2) : "—"}</td>" — no chip wrapper, no tone, while the sibling terms table at GoogleSearchTermsTable.tsx:117-126 does render the chip.
- **Fix:** Wrap the keyword ROAS value in the same tinted chip (inline-flex, radius 6px, padding 2px 8px, 11.5px/700) with pos / neutral / caution / danger backgrounds.

### GOOGLE-SEARCH-PRODUCTS-15 · MEDIUM · WRONG — Keywords QS cell is a tinted chip showing a bare number; the design draws bold coloured text reading "8/10"

- **Design:** 07-google-ads-search.html:88 — "<td style="padding:10px 12px;text-align:right;font-weight:700;color:{{ r.qsFg }}">{{ r.qs }}</td>", with data-model.js pinning "qs: '8/10', qsFg: '#0E9F6E'" — coloured text on no background, denominator included.
- **Code:** components/google-ads/GoogleKeywordsTable.tsx:145-156 — "<span className="inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-bold" style={{ background: tone!.bg, color: tone!.fg }}>{qs}</span>", a filled chip carrying only the raw score.
- **Fix:** Render QS as right-aligned bold text coloured by score (>=8 pos, <=5 danger, else ink) with no background, printed as "{qs}/10".

### GOOGLE-SEARCH-PRODUCTS-16 · MEDIUM · WRONG — Keyword match type renders as untinted lowercase mono text instead of the design's tinted chip

- **Design:** 07-google-ads-search.html:82 — the keyword and its match chip share one "display:flex;align-items:center;gap:6px" row, the chip being "border-radius:6px;padding:1px 7px;font-size:10px;font-weight:600;background:{{ r.mBg }};color:{{ r.mFg }}"; data-model.js seeds Title-Case "Exact" (C.info), "Phrase" (C.warn), "Broad" (neutral).
- **Code:** components/google-ads/GoogleKeywordsTable.tsx:118-122 — "<span className="ml-1.5 font-[family-name:var(--adv-font-mono)] text-[10px] font-normal uppercase tracking-[0.06em] text-[var(--adv-ink-4)]">{row.matchType.replace(/_/g, " ").toLowerCase()}</span>" — no background, no tone, mono lowercase, inline in the keyword span rather than a flex row.
- **Fix:** Restore the match-type chip: radius 6px, padding 1px 7px, 10px/600, Title Case, info tint for Exact, caution tint for Phrase, neutral fill for Broad, laid out on one flex row with the keyword at gap 6px.

### GOOGLE-SEARCH-PRODUCTS-17 · MEDIUM · WRONG — Search-term intent chip shows the ownership taxonomy in lowercase, so all four design intents fall through to the untinted default

- **Design:** 07-google-ads-search.html:44 renders "{{ r.intent }}" in the chip; data-model.js seeds "Transactional" (C.pos), "Navigational" (neutral), "Commercial" (C.info), "Informational" (C.auto) — four Title-Case values, each with its own tint.
- **Code:** components/google-ads/GoogleSearchTermsTable.tsx:67 "const intent = row.ownershipClass ?? row.intent ?? null;" and :92 "{intent.replace(/_/g, " ")}" print "brand" / "non brand" / "competitor" / "sku specific" / "weak commercial" in lowercase. INTENT_TONE (:17-23) is keyed only on those five, so any row that does fall through to "row.intent" renders untinted. This is a choice, not a limitation: "SearchIntelligenceRow.intent" exists (google-ads-dashboard-support.ts:149) and the server fills it from "classifySearchIntent" (lib/google-ads/reporting.ts:610, 1015), which returns exactly navigational / transactional / commercial / informational (lib/google-ads-intelligence.ts:132-139).
- **Fix:** Prefer "row.intent" for the chip, Title-Case the label, and key INTENT_TONE on transactional (pos) / commercial (info) / informational (auto) / navigational (neutral).

### GOOGLE-SEARCH-PRODUCTS-18 · MEDIUM · WRONG — Products "Feed status" column carries performance verdicts instead of feed states, and Serving loses the design's green tint

- **Design:** 08-google-ads-products.html:28 names the column "Feed status"; data-model.js gProductRows issue values are "Serving" with iBg/iFg = C.pos (green), "Missing GTIN" (C.warn), "Disapproved" (C.neg), "Hidden winner" (C.auto purple), rendered as a tinted chip at line 38.
- **Code:** components/google-ads/GoogleProductsTable.tsx:33-49 — "feedStatus()" returns "Not serving" (danger), "No conversions" (caution), "Negative return" (danger), "Scale candidate" (pos) and, only as the fallback, "Serving" with "{ bg: "var(--adv-fill-2)", fg: "var(--adv-ink-2)" }" — neutral grey, not the design's green. Three of the five labels are conversion/contribution verdicts, not feed states.
- **Fix:** Give "Serving" the pos tint. Where the shopping report genuinely omits Merchant Center state (the file's own comment at :10-13 says it does), leave the chip at Serving / — rather than filling the feed-status column with "No conversions" / "Negative return" / "Scale candidate", which answer a different question than the column the design drew.

### GOOGLE-SEARCH-PRODUCTS-19 · MEDIUM · WRONG — Page eyebrow prints a timezone and omits the currency and the date window the design pins

- **Design:** 07-google-ads-search.html:4 and 08-google-ads-products.html:4, identical: "Google Ads · 493-118-2201 · USD · 28d window" — four segments: platform, bare account id, currency, window.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:512-521 — "return \"Google Ads · ${accountId ? \"Account ${accountId}\" : "Account —"} · ${effectiveGoogleTimeZoneLabel}\";" — three segments, the third being the account timezone. No currency segment and no window segment, though the component already formats currency (fmtCurrency) and already owns the date range.
- **Fix:** Build the eyebrow as "Google Ads · {accountId} · {currencyCode} · {windowLabel}", em dash per segment the server has not reported, dropping the "Account " prefix and the timezone.

### GOOGLE-SEARCH-PRODUCTS-20 · LOW · GEOMETRY — Both closing footnotes lose the IBM Plex Mono family the design pins

- **Design:** 07-google-ads-search.html:58 and :96 — both "<p style="margin:0;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#98A4BA">".
- **Code:** components/google-ads/GoogleSearchTermsTable.tsx:146 "<p className="m-0 text-[11px] text-[var(--adv-ink-4)]">" and components/google-ads/GoogleKeywordsTable.tsx:170, same class list — neither carries "font-[family-name:var(--adv-font-mono)]", so both render in the sans body face. The Products closing note at GoogleAdsIntelligenceDashboard.tsx:2255 does apply the mono class, which is the correct pattern.
- **Fix:** Add "font-[family-name:var(--adv-font-mono)]" to both footnote paragraphs.

### GOOGLE-SEARCH-PRODUCTS-21 · LOW · GEOMETRY — Keyword QS-components sub-line is 11px sans where the design pins 9.5px mono

- **Design:** 07-google-ads-search.html:82 — "<span style="display:block;margin-top:2px;font-family:'IBM Plex Mono',monospace;font-size:9.5px;color:#98A4BA">{{ r.sub }}</span>".
- **Code:** components/google-ads/GoogleKeywordsTable.tsx:124-128 — "<span className="mt-0.5 block text-[11px] text-[var(--adv-ink-4)]">{components}</span>" — 11px, no mono family.
- **Fix:** Change to "mt-0.5 block font-[family-name:var(--adv-font-mono)] text-[9.5px] text-[var(--adv-ink-4)]".

### GOOGLE-SEARCH-PRODUCTS-22 · LOW · GEOMETRY — Keywords IS cell drops the mono 12px #7A869E treatment the design pins

- **Design:** 07-google-ads-search.html:89 — "<td style="padding:10px 12px;text-align:right;font-family:'IBM Plex Mono',monospace;font-size:12px;color:#7A869E">{{ r.is }}</td>" — the only mono numeric cell in the row.
- **Code:** components/google-ads/GoogleKeywordsTable.tsx:157-159 — "<td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">{percent(row.impressionShare)}</td>" — inherits the table's 13px sans and uses --adv-ink-2 (#45526b) instead of --adv-ink-3 (#7a869e).
- **Fix:** Add "font-[family-name:var(--adv-font-mono)] text-[12px]" and switch the colour to "var(--adv-ink-3)" on the IS cell.

### GOOGLE-SEARCH-PRODUCTS-23 · LOW · GEOMETRY — Both screens stack their blocks at 12px where the design's section gap is 16px

- **Design:** 07-google-ads-search.html:1 "<section … style="display:flex;flex-direction:column;gap:16px">" and 08-google-ads-products.html:1, identical declaration.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1866 "<section className="space-y-3">" (Search) and :2217 "<section className="space-y-3">" (Products) — 12px. components/google-ads/GoogleSearchStats.tsx:73 "flex flex-col gap-3" likewise separates the stat grid from the filter row at 12px where the design's section separates them at 16px. (The outer screen wrapper at :1429 correctly uses gap-4, which is what makes the panel sections the odd ones out.)
- **Fix:** Use "flex flex-col gap-4" on both panel sections and on the GoogleSearchStats wrapper.

### GOOGLE-SEARCH-PRODUCTS-24 · LOW · GEOMETRY — Search terms table min-width is 880px where the design pins 860px

- **Design:** 07-google-ads-search.html:29 — "min-width:860px" on the search-terms table; the 880px value belongs to the keywords table at line 67.
- **Code:** components/google-ads/GoogleSearchTermsTable.tsx:51 — "<table className="w-full min-w-[880px] border-collapse text-[13px] tabular-nums">", the keywords table's width applied to the terms table.
- **Fix:** Change the search terms table to "min-w-[860px]"; leave the keywords table at 880px.

### GOOGLE-SEARCH-PRODUCTS-25 · LOW · GEOMETRY — Page eyebrow is 12px where the design pins 11px

- **Design:** 07-google-ads-search.html:4 and 08-google-ads-products.html:4 — "font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7A869E".
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1435 — "<p className="m-0 font-[family-name:var(--adv-font-mono)] text-[12px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">".
- **Fix:** Change "text-[12px]" to "text-[11px]" on the eyebrow paragraph.

### GOOGLE-SEARCH-PRODUCTS-26 · LOW · MISSING — Allocation read card disappears entirely when the advisor has no Shopping & Products findings, leaving the design's right-hand column blank

- **Design:** 08-google-ads-products.html:44-59 — the Allocation read article is an unconditional second child of the two-column grid, and its own closing copy at line 57 is the honest fallback the design ships: "Cluster reads are directional — restructures apply from Advisor → Plan as guarded writes."
- **Code:** components/google-ads/GoogleAllocationRead.tsx:31 — "if (scoped.length === 0) return null;", while the grid at GoogleAdsIntelligenceDashboard.tsx:2221 still declares two tracks "[grid-template-columns:minmax(0,1.6fr)_minmax(290px,1fr)]", so the 290px track renders empty and the Products table keeps a 1.6fr width with nothing beside it.
- **Fix:** Always render the card shell with its title, subtitle and footnote; when no findings are scoped, show the footnote alone rather than returning null.

---

## Google Ads Assets & Audiences + Plan

### GOOGLE-ASSETS-PLAN-01 · HIGH · EXTRA — Plan appends a whole Budget & scaling workspace the fragment never defines

- **Design:** 10-google-ads-plan.html is 69 lines end-to-end. Line 9 opens the two-column grid, line 64 closes it, line 65 is the single mono footnote, line 66 </section>. No budget card, KPI tile, spend bar or second table exists anywhere in the fragment.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1843-1856 — inside the "activePanel === "plan"" branch, after the grid closes: "<div className="space-y-3 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-3">" with "<p className="text-xs text-muted-foreground">Budget headroom and scaling candidates · suggested shifts are advisor previews, applied manually in Google Ads</p>" then "<BudgetScalingTab campaigns={budgetData?.rows} … />". BudgetScalingTab.tsx renders 4 KPI cards, Budget Recommendations, scaling/waste pair, Spend Concentration and an 8-column Campaign Detail table.
- **Fix:** Delete the wrapper div and the "<BudgetScalingTab>" mount (GoogleAdsIntelligenceDashboard.tsx:1843-1856) from the plan branch; the screen ends at the grid plus the mono footnote.

### GOOGLE-ASSETS-PLAN-02 · HIGH · EXTRA — Assets & Audiences appends an Asset Performance Radar block and an "Asset read" panel below every tab

- **Design:** 09-google-ads-assets-and-audiences.html is 99 lines. The three "<sc-if>" blocks are gaGroups (14-41), gaAssets (42-68), gaAudiences (69-96); the section closes at 97. There is no advisor panel, no allocation/asset-read card, no coverage chip row and no per-asset-type card grid outside those three blocks.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:2336-2422 — a grid "[grid-template-columns:minmax(0,1.6fr)_minmax(290px,1fr)]" rendered OUTSIDE all three "assetView === …" conditionals, containing "<p className="text-xs text-muted-foreground">Instantly highlights weak headline, description, image, and video assets</p>", "<SurfaceRecoveryNotice …/>", the chip row "Underperforming/Top assets/Total assets", a 4-card grid over "["Headline", "Description", "Image", "Video"]", "<GoogleAdvisorPanel …/>" and "<GoogleAllocationRead title="Asset read" subtitle="advisor · asset & audience coverage" …/>". "app/(dashboard)/platforms/google/assets/page.tsx" mounts "panel="assets"" with "title="Assets & Audiences"", so this is the audited screen.
- **Fix:** Delete GoogleAdsIntelligenceDashboard.tsx:2336-2422; the section must be pill row + the one selected surface, then close.

### GOOGLE-ASSETS-PLAN-03 · HIGH · MISSING — Execution queue steps carry no Apply now / Roll back, Copy or Dismiss buttons

- **Design:** 10-google-ads-plan.html:27-31 — an "ml-auto" group of three h28/radius-8 buttons per step: "{{ s.applyLabel }}" (data-model.js: "applyLabel: applied ? 'Roll back' : 'Apply now'", "applyBg: applied ? '#F1F4F9' : '#2F6BFF'"), "Copy", "Dismiss".
- **Code:** GoogleExecutionQueue.tsx:222-263 — the pl-[33px] control row contains only the tick "<button>" and, at 260-262, "<span className="font-[family-name:var(--adv-font-mono)] text-[10px] …">{step.recommendedAction}</span>". Grepping the file finds no apply/rollback, copy or dismiss control.
- **Fix:** Add the three-button group to the right of the tick row (h28, radius 8px; accent fill for "Apply now", neutral fill for "Roll back"; outlined "Copy" and "Dismiss").

### GOOGLE-ASSETS-PLAN-04 · HIGH · MISSING — The Activity table (When/Who/What/Detail) never renders — the mount hardcodes an unavailable notice

- **Design:** 10-google-ads-plan.html:45-62 — the Activity card's "<table>" with "<th>When</th><th>Who</th><th>What</th><th>Detail</th>" and "<sc-for list="{{ gActivityRows }}">". The table is the unconditional payload of the right-hand column.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1838-1842 — "<GoogleActivityTable rows={[]} isLoading={false} unavailableReason="Activity history is unavailable. This surface stays read-only until a verified activity source is configured." />". GoogleActivityTable.tsx:53-59 short-circuits on that literal, so the "<table>" at 68-93 is unreachable. This is not a provider gap: lib/google-ads/advisor-memory.ts:1378-1409 already exposes "listAdvisorExecutionEvents()" returning "GoogleAdsActivityEntry[]" off "google_ads_advisor_execution_logs", and the component's own docstring says an empty log should render an empty feed.
- **Fix:** Wire GoogleActivityTable to "listAdvisorExecutionEvents" output instead of "rows={[]}" plus a hardcoded "unavailableReason", so the four-column table renders (empty state when the log is empty).

### GOOGLE-ASSETS-PLAN-05 · MEDIUM · EXTRA — Execution queue renders a card-level post-apply result banner the design has no slot for

- **Design:** 10-…html:11-34 — the card goes head (12) → intro <p> (13) → "<sc-for>" steps (14). No status or result row exists between them.
- **Code:** GoogleExecutionQueue.tsx:165-187 — "{result ? (<p role="status" className="m-0 border-b px-4 py-[11px] text-[12.5px]" style={…}>{result.kind === "error" ? result.message : "${result.applied} applied…"}</p>) : null}", a full-width tinted bar above the steps.
- **Fix:** Express the outcome through the per-step state the design already defines (tick label "applied · receipt …" and the amber note line) and drop the card-level banner.

### GOOGLE-ASSETS-PLAN-06 · MEDIUM · MISSING — Activity card has no retention-boundary line

- **Design:** 10-…html:44 — "<p style="margin:0;padding:0 16px 11px;font-size:11.5px;color:#B45309">Entries before Jul 20 are past retention and cannot be shown.</p>", an amber line between the intro copy and the table.
- **Code:** GoogleActivityTable.tsx:48-65 — after the intro paragraph the component branches straight into unavailableReason / loading / empty / table; no amber retention line exists anywhere in the file.
- **Fix:** Add an amber ("var(--adc-caution-fg)") 11.5px line under the intro naming the retention cutoff.

### GOOGLE-ASSETS-PLAN-07 · MEDIUM · MISSING — The whole Execution queue card vanishes when there are no steps — no empty state stands in for it

- **Design:** 10-google-ads-plan.html:11-35 — the "<article>" head (title, "N queued · N applied", "Apply all approved", "Download CSV") and the intro paragraph sit outside the "<sc-for>" at line 14, so the card and its controls are unconditional; only the step rows are list-driven.
- **Code:** GoogleExecutionQueue.tsx:54 — "if (steps.length === 0) return null;", and GoogleAdsIntelligenceDashboard.tsx:1819-1825 mounts "<GoogleExecutionQueue recommendations={summaryAdvisor?.recommendations ?? []} … />" with no fallback branch. With no advisor recommendations the left column collapses to the dashed "Batch apply" card alone — the queue head, both buttons and the guardrail paragraph disappear entirely.
- **Fix:** Render the card head and intro unconditionally in GoogleExecutionQueue.tsx and show an empty row region (or an EmptyState) in place of the steps, instead of returning null.

### GOOGLE-ASSETS-PLAN-08 · MEDIUM · WRONG — Second tab is captioned "Assets"; the design captions it "Text & image assets"

- **Design:** data-model.js: "const gAssetTabs = mkTabs([['groups', 'Asset groups'], ['assets', 'Text & image assets'], ['audiences', 'Audiences']], st.gAssetTab, 'gAssetTab');", consumed by 09-…html:10-12.
- **Code:** google-ads-dashboard-support.ts:254-258 — "export const ASSET_VIEWS = [{ key: "groups", label: "Asset groups" }, { key: "assets", label: "Assets" }, { key: "audiences", label: "Audiences" }];", rendered at GoogleAdsIntelligenceDashboard.tsx:2280.
- **Fix:** Change the "assets" entry's label to "Text & image assets".

### GOOGLE-ASSETS-PLAN-09 · MEDIUM · WRONG — Active tab pill uses the pale accent tint instead of the design's solid dark pill

- **Design:** 09-…html:11 — "background:{{ t.bg }};color:{{ t.color }};border:1px solid {{ t.bd }}" fed by mkTabs, whose active values are "#0B1020" / "#ffffff" / "#0B1020" (same pattern visible in data-model.js "klaviyoTabs").
- **Code:** GoogleAdsIntelligenceDashboard.tsx:2274-2276 — active branch ""border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]""; app/globals.css:118-121 defines those as "#cbd9ff" / "#eaf0ff" / "#2f6bff", while "--adv-rail" is "#0b1020".
- **Fix:** Use "bg-[var(--adv-rail)] text-white border-[var(--adv-rail)]" for the active pill.

### GOOGLE-ASSETS-PLAN-10 · MEDIUM · WRONG — Ad-strength chip tones are mis-mapped: Good renders green, Low renders red, Excellent falls through to amber

- **Design:** data-model.js gGroupRows — "str: 'Excellent', sBg: C.pos[0], sFg: C.pos[1]"; "str: 'Good', sBg: C.info[0], sFg: C.info[1]" (blue); "str: 'Low', sBg: C.warn[0], sFg: C.warn[1]" (amber). Rendered at 09-…html:34.
- **Code:** GoogleAssetSurfaces.tsx:54-62 — "if (value === "best" || value === "good") return { bg: "var(--adc-pos-bg)", … }; if (value === "low") return { bg: "var(--adc-danger-bg)", … }; return { bg: "var(--adc-caution-bg)", … };"
- **Fix:** Map excellent/best → pos, good → info, low → caution (amber), leaving danger for nothing on this chip.

### GOOGLE-ASSETS-PLAN-11 · MEDIUM · WRONG — Text-asset performance chips use the wrong tones and have no "Learning" state

- **Design:** data-model.js gAssetRows — Best→C.pos, Good→C.info (blue), Low→C.warn (amber), Learning→C.auto (purple); four distinct chips rendered at 09-…html:51.
- **Code:** GoogleAssetSurfaces.tsx:64-68 — "const PERFORMANCE_TONE = { top: {…adc-pos…, label: "Best"}, average: {…adc-caution…, label: "Good"}, underperforming: {…adc-danger…, label: "Low"} };" — three states, Good amber, Low red, no Learning entry (unmapped labels fall to the "—" at line 226).
- **Fix:** Retone "average"→info blue and "underperforming"→caution amber, and add a "learning" entry with the auto/purple tone and label "Learning".

### GOOGLE-ASSETS-PLAN-12 · MEDIUM · WRONG — Page eyebrow drops the currency and window segments and prefixes the account id with "Account"

- **Design:** 09-…html:4 and 10-…html:4 — the eyebrow is four dot-separated segments: platform / bare account id / currency / reporting window ("Google Ads · 493-118-2201 · USD · 28d window").
- **Code:** GoogleAdsIntelligenceDashboard.tsx:517-519 — ""return "Google Ads · ${accountId ? "Account ${accountId}" : "Account —"} · ${effectiveGoogleTimeZoneLabel}";"" — three segments, "Account" prefix, and a timezone label where the design has currency and window.
- **Fix:** Rebuild workspaceEyebrow as "Google Ads · {accountId} · {currencyCode} · {windowLabel}" with the bare id.

### GOOGLE-ASSETS-PLAN-13 · MEDIUM · WRONG — Execution queue counter says "N approved"; the design says "N applied"

- **Design:** 10-…html:12 — "{{ gPlanCount }} queued · {{ gPlanDone }} applied", and data-model.js derives gPlanDone from the applied set.
- **Code:** GoogleExecutionQueue.tsx:131-133 — "{steps.length} queued · {approvedCount} approved", with "approvedCount = steps.filter((step) => approved[step.id]).length" (line 56).
- **Fix:** Render "… · {appliedCount} applied", counting steps that actually executed.

### GOOGLE-ASSETS-PLAN-14 · MEDIUM · WRONG — Step tick label reads "Mark approved" / "Approved for manual apply" instead of the queued/receipt wording

- **Design:** data-model.js gPlanSteps — "stLabel: applied ? 'applied · receipt ' + s.rcpt : 'queued — awaiting apply'", rendered at 10-…html:26 beside the 16px tick.
- **Code:** GoogleExecutionQueue.tsx:257 — "{on ? "Approved for manual apply" : "Mark approved"}".
- **Fix:** Use "queued — awaiting apply" and "applied · receipt {receiptId}".

### GOOGLE-ASSETS-PLAN-15 · MEDIUM · WRONG — Execution queue intro paragraph rewrites the design's guardrail sentence

- **Design:** 10-…html:13 — "Approved changes execute here through the guarded write boundary — nothing bypasses approval, guardrails or quiet hours, and every write returns a Google receipt."
- **Code:** GoogleExecutionQueue.tsx:159-163 — "Approved changes execute here through the guarded write boundary — the server still enforces trust bands, dependencies and blockers, and every write returns a Google receipt."
- **Fix:** Restore the design copy verbatim.

### GOOGLE-ASSETS-PLAN-16 · MEDIUM · WRONG — Plan screen footer replaces the design's blocked-stays-queued sentence

- **Design:** 10-…html:65 — "…approval, guardrails, quiet hours. Anything blocked stays queued with its blocker named rather than dropped."
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1858-1861 — "…approval, guardrails, quiet hours. Anything outside it stays a read."
- **Fix:** Restore the design's second sentence.

### GOOGLE-ASSETS-PLAN-17 · MEDIUM · WRONG — "Batch apply — guarded" body drops the kill-switch clause

- **Design:** 10-…html:38 — "One execution target type per run, up to 250 items, one receipt chain. Batches run inside the same guardrails — the kill switch and quiet hours apply."
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1828-1834 — "…one receipt chain. Batches run inside the same approval, guardrail and quiet hour boundary as a single change."
- **Fix:** Restore the design's second sentence.

### GOOGLE-ASSETS-PLAN-18 · LOW · EXTRA — Both screens can render an account-scope banner with a native <select> the design never defines

- **Design:** Neither fragment contains a notice strip or a select: 09's only controls are the three tab pills (lines 9-13), 10's are the queue buttons and ticks. Both heads (lines 2-8) are eyebrow + h1 + mono line + sync pill only.
- **Code:** GoogleAdsIntelligenceDashboard.tsx:1455-1487 — a "role="status"" bar rendered for every panel (gated only on "accountScope.mode !== "none"" and more than one assigned account) with "Blended view"/"Scoped to one account" mono text and a "<select>" offering "All assigned accounts (blended)" plus one option per account id.
- **Fix:** Move the scope control out of the screen body — into the shell account chip or the Overview screen — so these two screens open on the head + content the design specifies.

### GOOGLE-ASSETS-PLAN-19 · LOW · WRONG — "Apply all approved" silently retitles itself "Desktop only" below 1024px

- **Design:** 10-…html:12 — the primary button's caption is the literal "Apply all approved"; no alternate caption exists.
- **Code:** GoogleExecutionQueue.tsx:143-147 — "{mobileReadOnly ? "Desktop only" : applying ? "Applying…" : "Apply all approved"}", with mobileReadOnly from "matchMedia("(max-width: 1023px)")" (lines 45-52).
- **Fix:** Keep the caption and express the restriction via the disabled state plus the existing "title" tooltip.

### GOOGLE-ASSETS-PLAN-20 · LOW · WRONG — Step provenance sub-line shows a layer/entity breadcrumb instead of the design's fixed advisor provenance sentence

- **Design:** 10-…html:20 renders "{{ s.src }}"; data-model.js gPlanRaw sets "src: 'served by the advisor from the last complete day'" identically on all three steps, i.e. fixed copy rather than per-row seed data.
- **Code:** GoogleExecutionQueue.tsx:204-206 — "{step.strategyLayer} · {step.entityName ?? "account"}" in that mono 10px slot.
- **Fix:** Put the advisor provenance sentence in the mono sub-line and relocate or drop the layer/entity breadcrumb.

### GOOGLE-ASSETS-PLAN-21 · LOW · WRONG — Activity intro copy is swapped for a read-only disclaimer and drops "on the next sync"

- **Design:** 10-…html:43 — "Every guarded write lands here with its receipt and is confirmed against the Google Ads change history on the next sync."
- **Code:** GoogleActivityTable.tsx:48-52 — the ternary prints "The activity feed remains read-only unless a verified execution-log source is available." whenever unavailableReason is set (always, on Plan), and its other branch ends at "…change history.", dropping "on the next sync".
- **Fix:** Make the design sentence (including "on the next sync") the standing intro and leave any unavailable notice to the secondary line.

---

## Klaviyo + Integrations

### KLAVIYO-INTEGRATIONS-01 · HIGH · EXTRA — Integration card renders up to eight extra notice/progress blocks where the design defines exactly four children

- **Design:** 15-integrations.html:9-43 — the card "<article>" has four children and no more: header row (10-14), description "<p>" (15), the single "sc-if i.syncing" first-sync block (16-35), and the footer row (36-42). Across all 64 lines of the fragment there is no other banner, sub-card, pill or stage list, and line 5 pins sync progress to appearing "once".
- **Code:** components/integrations/integrations-card.tsx:172-222 — "view.notice" blue banner (172-176), sync pill/skeleton (178-186), "MetaIntegrationProgress" (188-190), "GoogleIntegrationProgress" (192-194), "ShopifyIntegrationStatus" (196-198), "syncNotice" banner (200-204), needs-assignment banner (206-210), sync-action-required banner (212-216), action-required error banner (218-222). "ShopifyIntegrationStatus" (416-454) is itself a nested sub-card with a "Shopify sync" heading, its own Badge, and a "Ready through / Last sync / N orders" row.
- **Fix:** Delete these from the card body. Everything that still must be said belongs in the design's two slots: the first-sync block while the initial import runs, and the one monospace meta line in the footer.

### KLAVIYO-INTEGRATIONS-02 · HIGH · EXTRA — Cards carry up to three action buttons; the design gives each card exactly one

- **Design:** 15-integrations.html:39-41 — a single "<sc-if value="{{ i.showBtn }}">" around one "<button onClick="{{ i.onBtn }}">{{ i.btn }}</button>". data-model.js:1170-1171 "showBtn: !syncing", "btn: connected ? 'Manage' : 'Connect'" — one button, two captions, and no button at all while syncing.
- **Code:** components/integrations/integrations-card.tsx:241-337 — connected cards render "{view.primaryActionLabel}" (272-280) + "Reconnect" (281-295) + "Disconnect" (296-303); action-required cards render "Retry" (309-311) + "Reconnect" (312-326) + "Disconnect" (327-334); loading cards render "Loading data..." (260-263) + "Cancel" (264-266).
- **Fix:** Reduce the footer to one button (Connect / Manage), and hide it entirely while the first import runs. Reconnect, Disconnect, Retry and Cancel belong behind the Manage destination, not on the card face.

### KLAVIYO-INTEGRATIONS-03 · HIGH · MISSING — The design's single "First sync" progress block — label, percent, 6px bar, four named steps — exists nowhere in the app

- **Design:** 15-integrations.html:16-35 — "<sc-if value="{{ i.syncing }}">" wraps a radius-11px / #F7F9FC / 1px #E4E8F0 / 11px 13px box with a mono "First sync" label (line 19), a mono percent in #2F6BFF (line 20), a "height:6px" bar "background:{{ i.barColor }};width:{{ i.barW }}" (22-23), and "<sc-for list="{{ i.steps }}">" of 15px check circles + 11.5px label + mono 9.5px note (26-32). data-model.js:1148-1152 "syncSteps" names them ['Authorize',0,8,'OAuth scopes'], ['Fetch entities',8,35,'flows · campaigns · lists'], ['Backfill 28 days',35,82,'events & revenue'], ['Validate & snapshot',82,100,'ready to read']; :1168 "barColor: pct >= 100 ? '#0E9F6E' : '#2F6BFF'". The header sentence at line 5 states the rule outright: "Sync progress appears once: while a new source runs its first import."
- **Code:** "grep -rn "First sync|Backfill 28|Validate & snapshot|Fetch entities" components/ app/(dashboard)/integrations/" returns only components/auth/onboarding-arc.tsx:65 — nothing in the Integrations surface. components/integrations/integrations-card.tsx:178-198 offers only SyncStatusPillSkeleton / SyncStatusPill, MetaIntegrationProgress, GoogleIntegrationProgress and ShopifyIntegrationStatus in its place.
- **Fix:** Add the design's one first-sync block to IntegrationsCard, shown only while a provider runs its first import: radius 11px, bg #F7F9FC, border 1px #E4E8F0, padding 11px 13px; mono uppercase "First sync" + mono percent #2F6BFF; a 6px rounded bar (#E4E8F0 track, #2F6BFF fill, #0E9F6E at 100%); then the four fixed steps Authorize / Fetch entities / Backfill 28 days / Validate & snapshot with 15px check circles and mono 9.5px notes.

### KLAVIYO-INTEGRATIONS-04 · MEDIUM · EXTRA — A pre-OAuth ConnectModal overlay interposes on the Connect path the design draws as a single click

- **Design:** 15-integrations.html:39-41 — the card's only interactive element is "<button onClick="{{ i.onBtn }}">"; data-model.js:1170 "onBtn: connected ? noop : () => this.startSync(b.id)" — one click begins the import. No dialog, drawer or confirmation step appears anywhere in the 64-line fragment.
- **Code:** app/(dashboard)/integrations/legacy-page.tsx:831-839 renders "<ConnectModal>"; components/integrations/connect-modal.tsx:52-101 is a "fixed inset-0 z-50 ... bg-black/50" overlay with an "Connect {providerLabel}" heading, a "Requested permissions" list, and Cancel / Continue buttons — "handleContinue" (43-50) only then navigates to the OAuth start URL.
- **Fix:** Let Connect navigate straight to the provider handshake as the design does, and drop the interstitial permissions dialog. (Scoped to ConnectModal only: the design's "Manage" is a "noop", so it defines no Manage destination and the assignment drawer / GA4 / Search Console pickers behind it cannot be judged against it.)

### KLAVIYO-INTEGRATIONS-05 · MEDIUM · EXTRA — Integrations header carries a workspace-name line and a "demo fixtures" chip the design's header does not have

- **Design:** 15-integrations.html:2-6 — the header "<div>" holds exactly three elements: the mono eyebrow, the h1, and the one 12.5px description paragraph. The grid opens immediately at line 7.
- **Code:** app/(dashboard)/integrations/legacy-page.tsx:738-746 — a fourth "<p className="mt-2 inline-flex w-fit items-center gap-2 font-[family-name:var(--adv-font-mono)] text-[10.5px] ...">" rendering "{activeBusiness?.name ?? "Unknown business"}" plus a "demo fixtures" chip.
- **Fix:** Remove the business-name paragraph and the demo-fixtures chip; the header ends with the sync-behaviour sentence.

### KLAVIYO-INTEGRATIONS-06 · MEDIUM · EXTRA — A full-width success/danger banner is inserted between the header and the grid

- **Design:** 15-integrations.html — nothing sits between the header div (2-6) and the live grid (7); across all 64 lines the screen has no toast, banner or status strip.
- **Code:** app/(dashboard)/integrations/legacy-page.tsx:748-755 — "{toast && <StateBanner tone={toast.type === "success" ? "success" : "danger"} title={... "Integration updated" : "Integration action failed"}>{toast.message}</StateBanner>}", fed by "setToast" at :485, :604, :615, :857 and :887.
- **Fix:** Drop the StateBanner from the page body. If action feedback is still needed, surface it on the card the action came from rather than as a band that reflows the grid.

### KLAVIYO-INTEGRATIONS-07 · MEDIUM · GEOMETRY — Card border turns emerald/blue/amber by state; the design only ever uses #E4E8F0 or #CBD9FF

- **Design:** 15-integrations.html:9 "border:1px solid {{ i.cardBd }}"; data-model.js:1166 "cardBd: syncing ? '#CBD9FF' : '#E4E8F0'" — two values, and the non-default one only during the first import.
- **Code:** components/integrations/integrations-card.tsx:136-144 — "syncActionRequired ? "border-amber-200" : isReady || isDegraded ? "border-emerald-200" : isLoading || isNeedsAssignment ? "border-blue-200" : isActionRequired ? "border-amber-200" : "border-[var(--adv-border)]"", so every connected card draws a green border instead of #E4E8F0.
- **Fix:** Bind the border to two values only: #CBD9FF while the first import runs, #E4E8F0 otherwise. Let the status pill carry state colour.

### KLAVIYO-INTEGRATIONS-08 · MEDIUM · GEOMETRY — Klaviyo screen is clamped to 1060px with extra padding and forced to IBM Plex Sans 13px

- **Design:** 11-klaviyo.html:1 — "<section data-screen-label="Klaviyo" style="display:flex;flex-direction:column;gap:16px">"; no max-width, no padding, no font-family or font-size override, so the section inherits the shell page frame.
- **Code:** app/(dashboard)/platforms/klaviyo/page.tsx:43 "className="ad-workspace-page""; app/globals.css:864-876 defines it as "max-width: 1060px; margin: 0 auto; padding: 18px 20px 48px; ... font-family: var(--font-ibm-plex-sans) ...; font-size: 13px". The shell already supplies ".adv-page { max-width: 1560px; margin: 0 auto; padding: 24px 28px 48px }" (app/globals.css:8298-8302) via components/layout/dashboard-frame.tsx:196, and "grep -rl ad-workspace-page app/ components/" returns only this page and components/workspace/workspace-surface.tsx — no other v2 screen uses it.
- **Fix:** Remove "className="ad-workspace-page"" from the Klaviyo page root so it inherits the shell's ".adv-page" frame and body font like every other v2 screen.

### KLAVIYO-INTEGRATIONS-09 · MEDIUM · GEOMETRY — Card footer buttons use the shadcn sm size — 32px tall, 6px radius, 14px/500 type, with a hardcoded min-width — against the design's 30px / 8px / 12px / 600

- **Design:** 15-integrations.html:40 — "<button ... style="height:30px;padding:0 12px;border-radius:8px;border:{{ i.btnBd }};background:{{ i.btnBg }};color:{{ i.btnFg }};font-size:12px;font-weight:600">"; data-model.js:1172 gives it "btnBg: connected ? '#ffffff' : '#2F6BFF'" and "btnBd: connected ? '1px solid #E4E8F0' : 'none'". No minimum width is set anywhere, so the button hugs its caption. The roadmap card's button (line 58) is separately pinned at h28 / 11.5px, which the impl does match.
- **Code:** components/integrations/integrations-card.tsx:243-334 renders every action through "<Button size="sm">"; components/ui/button.tsx:26 defines "sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5"" on a base of "rounded-md text-sm font-medium" (line 8) — i.e. 32px tall, 6px radius, 14px type at weight 500. The card additionally forces "min-w-[104px]" (:245), "min-w-[118px]" (:260), "min-w-[126px]" (:274) and "min-w-[108px]" (:309), which the design never has.
- **Fix:** Give the card's single footer button the design's own geometry rather than the shared "sm" variant: height 30px, padding 0 12px, radius 8px, 12px/600, and no min-width so it sizes to "Connect" / "Manage".

### KLAVIYO-INTEGRATIONS-10 · MEDIUM · MISSING — Status pill has no leading 5px currentColor dot

- **Design:** 15-integrations.html:13 — the pill is "display:inline-flex;align-items:center;gap:6px" and its first child is "<span style="width:5px;height:5px;border-radius:9999px;background:currentColor"></span>" ahead of "{{ i.status }}".
- **Code:** components/integrations/integrations-card.tsx:388-409 — every "StatusBadge" branch renders text only, e.g. :391-393 "<Badge className="rounded-full border-0 bg-emerald-50 px-[10px] py-[3px] text-[11px] font-bold text-emerald-700">Connected</Badge>".
- **Fix:** Add a 5×5px "currentColor" dot as the pill's first child with a 6px gap, in every status branch.

### KLAVIYO-INTEGRATIONS-11 · MEDIUM · WRONG — Connected-card button caption is provider-specific; the design says "Manage" for every provider

- **Design:** data-model.js:1171 "btn: connected ? 'Manage' : 'Connect'", read by 15-integrations.html:40 as "{{ i.btn }}" — two captions, and "Manage" is unconditional across all six providers.
- **Code:** store/integrations-support.ts:420-423 sets "primaryActionLabel" to "Connect" when disconnected (so the disconnected caption does match) but otherwise to "providerActionLabel", which at :306-321 returns "Connected" (shopify), "Select Property"/"Change Property" (ga4), "Select Site"/"Change Site" (search_console) and "Open intelligence" (klaviyo). Rendered at components/integrations/integrations-card.tsx:254 and :279.
- **Fix:** Make the connected caption "Manage" for every provider; move the provider-specific wording (property/site pickers, intelligence link) inside the Manage destination.

### KLAVIYO-INTEGRATIONS-12 · MEDIUM · WRONG — Live card order puts Shopify fifth; the design opens the grid with it

- **Design:** data-model.js:1140-1146 "integBase" order: shopify, meta ('Meta Ads'), google ('Google Ads'), ga4, sc ('Search Console'), klaviyo; mapped in that order at :1157 and iterated by 15-integrations.html:8 "<sc-for list="{{ integrations }}">".
- **Code:** app/(dashboard)/integrations/legacy-page.tsx:60-67 "PRIMARY_CARD_PROVIDERS" and :69-79 "DISPLAY_PROVIDERS" both begin meta, google, ga4, search_console, shopify, klaviyo; DISPLAY_PROVIDERS is mapped in order at :628 and filtered into "liveCards" at :710-712, so Shopify renders fifth.
- **Fix:** Reorder both arrays to shopify, meta, google, ga4, search_console, klaviyo (roadmap providers unchanged after).

### KLAVIYO-INTEGRATIONS-13 · MEDIUM · WRONG — Three live-card names (and one roadmap name) differ from the design's captions

- **Design:** data-model.js:1142 "name: 'Meta Ads'", :1143 "'Google Ads'", :1145 "'Search Console'", :1175 "'TikTok Ads'" — rendered at 15-integrations.html:12 and :55.
- **Code:** components/integrations/oauth.ts:3-13 "PROVIDER_LABELS" = "meta: "Meta"", "google: "Google"", "search_console: "Google Search Console"", "tiktok: "TikTok""; read by integrations-card.tsx:89 and soon-card.tsx:29.
- **Fix:** Change those four labels to "Meta Ads", "Google Ads", "Search Console" and "TikTok Ads". (Narrowed: Shopify, GA4, Klaviyo, Pinterest and Snapchat already match — the auditor's "all six" is an overstatement.)

### KLAVIYO-INTEGRATIONS-14 · MEDIUM · WRONG — Every card description is different copy from the design's

- **Design:** data-model.js:1141-1146 "desc" values — shopify "Orders and revenue ledger — the trusted commercial source.", meta "Campaign performance, decision snapshots and guarded writes.", google "Search, PMax and Shopping intelligence — guarded writes with receipts.", ga4 "Site behavior, funnels and audience quality for Insights.", sc "Query and indexing data behind SEO insights." — rendered at 15-integrations.html:15.
- **Code:** app/(dashboard)/integrations/legacy-page.tsx:81-93 "DESCRIPTIONS" — shopify "Sync storefront events and conversion data for attribution.", meta "Connect Ads Manager to import campaigns, ad sets, and spend.", google "Link Google Ads to track performance and sync account data.", ga4 "Connect Google Analytics 4 to enrich landing page and conversion insights.", search_console "Connect Google Search Console to analyze organic search performance and keyword visibility." Passed to the card at :765.
- **Fix:** Replace the DESCRIPTIONS map with the design's six sentences verbatim — this is fixed UI copy, not provider-supplied data.

### KLAVIYO-INTEGRATIONS-15 · MEDIUM · WRONG — Meta line and the action button sit on separate rows; the design puts them on one bottom-pinned footer row

- **Design:** 15-integrations.html:36-42 — one "<div style="display:flex;align-items:center;gap:8px;margin-top:auto">" containing the mono meta span, a "flex:1" spacer (line 38), then the button, so every card's footer lands on the same baseline across the grid.
- **Code:** components/integrations/integrations-card.tsx:227-232 renders the meta line as its own "<p className="truncate font-[family-name:var(--adv-font-mono)] text-[10.5px] ...">", and :234 opens a separate "<div className="mt-auto flex flex-wrap items-center gap-2">" for the buttons — only the button row is pinned, so the meta lines float at different heights per card.
- **Fix:** Merge them into one "mt-auto" flex row with 8px gap: meta span, "flex-1" spacer, single button.

### KLAVIYO-INTEGRATIONS-16 · LOW · EXTRA — Klaviyo sub-routes exist and every one of them marks "Flows" as the selected tab

- **Design:** 11-klaviyo.html:9-13 — the four pills come from "klaviyoTabs" (data-model.js:720), which carries only label/bg/color/bd, with no "go" handler and no route; the design has exactly one Klaviyo screen.
- **Code:** app/(dashboard)/platforms/klaviyo/{flows,campaigns,templates,segments}/page.tsx each contain only "export { default } from "../page";", and lib/dashboard-v2/screen-registry.ts:121-124 registers all four. The shared page hardcodes "aria-selected={index === 0}" and the dark pill styling on index 0 (app/(dashboard)/platforms/klaviyo/page.tsx:66-71), so /platforms/klaviyo/segments still shows "Flows" active.
- **Fix:** Either delete the four sub-route files and their registry entries, or drive the active pill from the pathname so the selected tab matches the URL.

### KLAVIYO-INTEGRATIONS-17 · LOW · EXTRA — Loading skeleton paints a three-summary-tile header and three titled two-card sections — a layout this screen no longer has

- **Design:** 15-integrations.html:7-61 — one auto-fit grid of live cards and one auto-fit grid of roadmap cards; no summary tiles and no titled provider sections anywhere. The impl's own comment at legacy-page.tsx:730-732 records that the design "replaced the three summary tiles".
- **Code:** app/(dashboard)/integrations/legacy-page.tsx:963-1027 "IntegrationsPageSkeleton" — a header card containing "<div className="grid gap-2 sm:grid-cols-3 lg:min-w-[360px]">" of three tiles (976-989), then three "<section>" blocks each with a title/subtitle skeleton pair and an "xl:grid-cols-2" card grid (991-1025). Rendered at :567, :587 and :597.
- **Fix:** Rewrite the skeleton to the shipped shape: eyebrow + title + one paragraph, then a single "repeat(auto-fit,minmax(300px,1fr))" grid of six card placeholders.

### KLAVIYO-INTEGRATIONS-18 · LOW · GEOMETRY — Integration card column gap is 12px; the design pins 10px

- **Design:** 15-integrations.html:9 — "padding:16px;display:flex;flex-direction:column;gap:10px".
- **Code:** components/integrations/integrations-card.tsx:135 — ""group flex h-full flex-col gap-3 rounded-[14px] border bg-[var(--adv-surface)] p-4 ...""; Tailwind "gap-3" is 0.75rem = 12px.
- **Fix:** Change "gap-3" to "gap-[10px]" on the card root.

### KLAVIYO-INTEGRATIONS-19 · LOW · GEOMETRY — Klaviyo flow table drops the design's tabular figures

- **Design:** 11-klaviyo.html:15 — "<table style="width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums">".
- **Code:** app/(dashboard)/platforms/klaviyo/page.tsx:80 — "<table className="w-full text-[13px]">", with no "tabular-nums", so the right-aligned Revenue / Open rate / Recipients columns will not align digit-for-digit once rows exist.
- **Fix:** Add "tabular-nums" to the table element.

### KLAVIYO-INTEGRATIONS-20 · LOW · GEOMETRY — Klaviyo header row cannot wrap; the design wraps it

- **Design:** 11-klaviyo.html:2 — "<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap">".
- **Code:** app/(dashboard)/platforms/klaviyo/page.tsx:47 — "<div className="flex items-end justify-between gap-4">"; no "flex-wrap", so on narrow viewports the "shrink-0" "BETA — read-only analysis" pill compresses the title instead of dropping to a second line.
- **Fix:** Add "flex-wrap" to that header row.

### KLAVIYO-INTEGRATIONS-21 · LOW · WRONG — The importing-state pill reads "Loading"; the design's reads "Connecting"

- **Design:** data-model.js:1163 "status: syncing ? 'Connecting' : connected ? (isK ? 'Connected · Beta' : 'Connected') : 'Not connected'", rendered at 15-integrations.html:13 as "{{ i.status }}".
- **Code:** components/integrations/integrations-card.tsx:399-401 — "status === "loading_data"" renders a Badge captioned "Loading" (mirrored by store/integrations-support.ts:426-434 "statusLabel"). "Connecting" appears nowhere in the surface.
- **Fix:** Rename the loading_data caption to "Connecting". (Narrowed from the auditor's claim: Degraded / Needs setup / Action required are honest provider states the mock never had to model, and "Connected · Beta" is unreachable while Klaviyo is fail-closed — neither is a defect.)

### KLAVIYO-INTEGRATIONS-22 · LOW · WRONG — Klaviyo footer sentence renders in the body font; the design sets IBM Plex Mono

- **Design:** 11-klaviyo.html:36 — "<p style="margin:0;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#98A4BA">The Overview opportunity …</p>".
- **Code:** app/(dashboard)/platforms/klaviyo/page.tsx:101 — "<p className="m-0 text-[11px] text-[var(--adv-ink-4)]">" with no "font-[family-name:var(--adv-font-mono)]".
- **Fix:** Add "font-[family-name:var(--adv-font-mono)]" to that paragraph.

### KLAVIYO-INTEGRATIONS-23 · LOW · WRONG — Each integration name is an <h2>; the design uses a plain span and reserves h2 for "Coming soon"

- **Design:** 15-integrations.html:12 renders the provider name as "<span style="font-size:14.5px;font-weight:600;color:#0E1526">{{ i.name }}</span>"; the only "<h2>" on the screen is line 47, "Coming soon".
- **Code:** components/integrations/integrations-card.tsx:153-155 — "<h2 className="min-w-0 truncate text-[14.5px] font-semibold text-[var(--adv-ink)]">{providerLabel}</h2>", producing six h2s that precede the real one at app/(dashboard)/integrations/legacy-page.tsx:810-812.
- **Fix:** Render the provider name as a span (or h3) so the outline matches the design's single h1 / single h2.

---

## Insights - outer tabs + Analytics tab

### INSIGHTS-A-01 · HIGH · EXTRA — Analytics tab renders a second page header (h2 + paragraph + property chip) the design does not have

- **Design:** 12-insights.html: the only head is L2–12 (eyebrow "Growth · GA4 + Search Console" + h1 "Insights" + 3 chips). Inside the insAnalytics branch the sub-tab strip at L20 ("<div style="display:flex;gap:2px;border-bottom:1px solid #E4E8F0;overflow-x:auto">") follows the outer pill row at L13–17 directly; re-read L13–L26 — no h2, no paragraph, no property chip between them.
- **Code:** app/(dashboard)/insights/analytics/legacy-page.tsx:302-305 renders "<AnalyticsHeader ga4Connected propertyName={overviewQuery.data?.propertyName} />"; AnalyticsHeader at :517-536 emits "<h2 …text-[19px]…>Analytics</h2>" (:520-522), "<p …>Understand product funnels, audience quality, landing page performance, and customer behavior…</p>" (:523-526) and a mono "{propertyName}" chip (:530-532). Also called at :278 and :287.
- **Fix:** Delete AnalyticsHeader and its three call sites (:278, :287, :302). The Insights layout already owns the single page head the design defines.

### INSIGHTS-A-02 · HIGH · EXTRA — All Analytics tab content is wrapped in one extra bordered card the design never draws

- **Design:** 12-insights.html L25-58 (anaOverview) holds three bare sibling "<div style="display:grid…">" blocks with no wrapping article. Card chrome exists only per table: L60 "<article style="border-radius:14px;background:#ffffff;border:1px solid #E4E8F0;overflow-x:auto">" (Product funnel), L84 (Landing pages), L120 (Traffic source quality), L146 (Demographics), L166/L184 (Cohorts).
- **Code:** app/(dashboard)/insights/analytics/legacy-page.tsx:345 "<section className="rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-5">" opens before the tab body and closes at :500, so every tab (overview → opportunities) sits inside one card; tables inside it carry no card of their own.
- **Fix:** Remove the wrapping "<section>" at :345. Render Overview's grids bare, and give each table its own r14 "<article>" with the design's header row (h2 15px + mono 10.5px hint) and "overflow-x:auto".

### INSIGHTS-A-03 · HIGH · EXTRA — Five tabs get a SectionHeader (title + sentence) the design does not define

- **Design:** 12-insights.html: anaOverview (L25), anaDemo (L139-140), anaCohorts (L164-165) and anaOpps (L205-206) each open directly on their grid/chip row — no h2/h3, no descriptive sentence. Headings appear only inside table cards: L61 Product funnel, L85 Landing page performance, L121 Traffic source quality, L167 Weekly new vs returning, L185 Monthly acquisition summary.
- **Code:** legacy-page.tsx:348-351 "title="Executive Overview" description="Top-line site performance and key behavioral insights.""; :433-436 "Audience demographics"; :459-462 "Acquisition cohorts"; :483-486 "Opportunities and warnings"; :409-412 "Traffic source quality" (design puts this inside the card, not above it). SectionHeader body at :539-554.
- **Fix:** Delete the SectionHeader calls for overview, demographics, cohorts and opportunities. For products / landing-pages / audience, move title+hint into each table card's header row.

### INSIGHTS-A-04 · HIGH · GEOMETRY — Page h1 is 16px/600 with letter-spacing 0; the design pins 26px/700 Space Grotesk at −0.02em

- **Design:** 12-insights.html L5: "<h1 style="margin:4px 0 0;font-family:'Space Grotesk',sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.02em;color:#0E1526">Insights</h1>".
- **Code:** app/(dashboard)/insights/layout.tsx:117 passes "title="Insights"" to WorkspaceSurface, which renders it in ".ad-workspace-title-row h1" (components/workspace/workspace-surface.tsx:39-40); app/globals.css:917-924 sets "font-size: 16px; font-weight: 600; letter-spacing: 0;".
- **Fix:** Give the Insights screen a display-font h1 at 26px/700, letter-spacing −0.02em, colour var(--adv-ink).

### INSIGHTS-A-05 · HIGH · MISSING — Header date-range chip is absent; the picker is exiled into an extra bordered controls card

- **Design:** 12-insights.html L8: "<span style="…border:1px solid #E4E8F0;border-radius:9px;background:#ffffff;padding:6px 11px;font-family:'IBM Plex Mono'…font-size:11.5px">Jul 18 – Aug 14 · 28d <span style="color:#98A4BA">▾</span></span>" — first of the three head chips. L13-24 contains no controls strip between the tab rows.
- **Code:** app/(dashboard)/insights/layout.tsx:119-132 the "meta" cluster holds only the two SourceChips — no date chip. legacy-page.tsx:308-313 renders "<section className="rounded-[14px] border … p-3">" wrapping "<DateRangePicker showComparisonTrigger={false} …/>" between the outer tabs and the sub-tabs.
- **Fix:** Move the DateRangePicker trigger into the layout's header meta cluster as the first chip (mono 11.5px pill, r9, ▾ caret) and delete the controls "<section>" at :308.

### INSIGHTS-A-06 · HIGH · MISSING — Overview New/Returning cards show 2 metrics; the design's card is a 3-up grid including Engagement

- **Design:** 12-insights.html L42-46: "<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">" with cells labelled "Sessions", "Engagement" and "Purchase CVR", each value Space Grotesk 18px/700. The badge sits in a separate header row at L38-41, right-aligned.
- **Code:** components/analytics/OverviewSection.tsx:99-112 and :123-137 render a "flex items-end justify-between" pair — sessions and purchase CVR only; the badge is inlined into the label paragraph at :117-121. The 3-up version exists only in AudienceSection.tsx:188-196 (whose segment data does carry engagementRate, AudienceSection.tsx:10).
- **Fix:** Reuse AudienceSection's SegmentCard layout (Sessions / Engagement / Purchase CVR grid) and move the "× better CVR" badge into a right-aligned header row.

### INSIGHTS-A-07 · HIGH · MISSING — Both cohort tables lose their card headers and mono hint lines

- **Design:** 12-insights.html L167: "<h2 …font-size:15px;font-weight:600…>Weekly new vs returning</h2><span style="font-family:'IBM Plex Mono';font-size:10.5px;color:#98A4BA">retention pill = returning share of sessions</span>" on a "border-bottom:1px solid #EDF0F6" band; L185 the same with "Monthly acquisition summary" / "do acquired users return and repurchase".
- **Code:** components/analytics/CohortSection.tsx:106-108 "<p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Weekly New vs Returning Sessions</p>" and :149-151 "Monthly Acquisition Summary" — uppercase eyebrows, no hint text, no header band.
- **Fix:** Replace the two eyebrows with the design's card header row: h2 15px/600 display font plus the mono 10.5px hint on a #EDF0F6 bottom border.

### INSIGHTS-A-08 · HIGH · WRONG — Landing pages table has 9 columns instead of the design's 6

- **Design:** 12-insights.html L87 thead for landRows lists exactly: Page | Sessions | Engagement | Purchases | Purchase CVR | Signal.
- **Code:** components/analytics/LandingPageSection.tsx:67-154 defines Page (:70), Sessions (:82), "Engaged" (:88), "Engagement rate" (:95), "Avg time" (:108), Purchases (:116), "Purchase CVR" (:122), "Bounce rate" (:130), Signal (:139).
- **Fix:** Drop Engaged, Avg time and Bounce rate; rename "Engagement rate" to "Engagement"; keep the order Page, Sessions, Engagement, Purchases, Purchase CVR, Signal.

### INSIGHTS-A-09 · HIGH · WRONG — Outer Insights tab order is Analytics / AI Visibility / SEO Intelligence; the design is Analytics / SEO Intelligence / AI Visibility

- **Design:** data-model.js:727 "const insSections = mkTabs([['analytics','Analytics'],['seo','SEO Intelligence'],['geo','AI Visibility']], st.insightsTab, 'insightsTab');", rendered in order by 12-insights.html L14 "<sc-for list="{{ insSections }}">".
- **Code:** app/(dashboard)/insights/layout.tsx:24-43 INSIGHTS_TABS is ordered analytics (:25-30), ai-visibility "AI Visibility" (:31-36), seo "SEO Intelligence" (:37-42).
- **Fix:** Swap the second and third entries of INSIGHTS_TABS so the row reads Analytics, SEO Intelligence, AI Visibility.

### INSIGHTS-A-10 · HIGH · WRONG — Cohorts tab stacks its two tables vertically; the design lays them side by side

- **Design:** 12-insights.html L165: "<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px;align-items:start">" wrapping the "Weekly new vs returning" article (L166-183) and the "Monthly acquisition summary" article (L184-202).
- **Code:** components/analytics/CohortSection.tsx:97 "<div className="space-y-6">" stacks the weekly block (:104-144) above the monthly block (:147-187); neither is wrapped in a card and there is no grid.
- **Fix:** Wrap both in "grid [grid-template-columns:repeat(auto-fit,minmax(420px,1fr))] gap-3 items-start" and give each its own r14 white card.

### INSIGHTS-A-11 · HIGH · WRONG — Opportunities are a vertical stack of icon rows; the design is a card grid with text kind chips

- **Design:** 12-insights.html L206 "<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:10px">" and L209 "<span style="font-family:'IBM Plex Mono';font-size:9px;text-transform:uppercase;…background:#ffffff;color:{{ o.fg }}">{{ o.kind }}</span>"; data-model.js anaOppCards gives the kinds "Opportunity", "Strong", "Warning".
- **Code:** components/analytics/OpportunityFlags.tsx:140 "<div className="space-y-2.5">"; :183 renders "{config.icon}" — lucide Zap / AlertTriangle / TrendingUp defined at :155-177 — with no textual kind label anywhere in the file.
- **Fix:** Switch the container to "grid [grid-template-columns:repeat(auto-fit,minmax(380px,1fr))] gap-2.5" and replace the icons with the design's white mono uppercase chip carrying Opportunity / Strong / Warning.

### INSIGHTS-A-12 · MEDIUM · EXTRA — AudienceSection repeats the section title and adds a question sentence

- **Design:** 12-insights.html L120-121: the traffic table's card header carries exactly one h2 "Traffic source quality" and one mono hint "which sources bring high-quality, converting visitors" — the label appears once, inside the card.
- **Code:** components/analytics/AudienceSection.tsx:147-149 emits "Traffic Source Quality" as an uppercase eyebrow and :150-152 "<p className="mb-3 text-sm text-muted-foreground">Which sources bring high-quality, converting visitors?</p>", while legacy-page.tsx:409-412 already prints the same title and description above the component.
- **Fix:** Delete the eyebrow and sentence at AudienceSection.tsx:147-152; keep one title inside the table card header.

### INSIGHTS-A-13 · MEDIUM · EXTRA — An "Insights" eyebrow is stacked above the Overview callouts; the design has none

- **Design:** 12-insights.html L49-51: the anaCallouts grid ("<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:10px">", L50) is a direct sibling of the nvCards grid closing at L49 — no label element between them.
- **Code:** components/analytics/OverviewSection.tsx:143-146 "<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Insights</p>" sits above the callout grid at :147.
- **Fix:** Remove the "Insights" label paragraph; render the callout grid directly after the New/Returning grid.

### INSIGHTS-A-14 · MEDIUM · EXTRA — AudienceSection adds a "New vs returning" eyebrow the design does not have

- **Design:** 12-insights.html L104-105: the anaAudience branch opens straight into "<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px">" looping nvCards — no label above it.
- **Code:** components/analytics/AudienceSection.tsx:127-129 "<p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">New vs returning</p>" precedes the two SegmentCards.
- **Fix:** Delete the eyebrow paragraph at AudienceSection.tsx:127-129.

### INSIGHTS-A-15 · MEDIUM · EXTRA — Cohorts tab opens with an explanatory paragraph the design never wrote

- **Design:** 12-insights.html L164-166: "<sc-if value="{{ anaCohorts }}">" is followed immediately by the two-column grid div and then the first "<article>" — no prose precedes the tables.
- **Code:** components/analytics/CohortSection.tsx:98-101 "<p className="text-sm text-muted-foreground">Understand retention and return behavior. Higher returning session share indicates audience that keeps coming back.</p>".
- **Fix:** Remove the lead paragraph at CohortSection.tsx:98-101.

### INSIGHTS-A-16 · MEDIUM · EXTRA — Every table header is a sort button with an arrow icon; the design's headers are static text

- **Design:** 12-insights.html L63, L87, L123, L148, L169, L187: every "<th>" is a plain styled cell ("padding:9px 16px;text-align:left;font-family:'IBM Plex Mono'…") containing only the caption — no icon element, no cursor:pointer, and rows carry no hover style (L66 "<tr style="border-top:1px solid #EDF0F6">").
- **Code:** components/analytics/SortableTable.tsx:92 adds "cursor-pointer select-none hover:text-foreground" to every header, :96-111 renders "<ArrowUpDown/>" / "<ArrowUp/>" / "<ArrowDown/>" beside each caption, and :120 adds "hover:bg-muted/30" row hover.
- **Fix:** Suppress the sort icons, pointer affordance and row hover in these Insights tables (or gate them behind an explicit opt-in) so headers render as the design's static mono labels.

### INSIGHTS-A-17 · MEDIUM · EXTRA — A "strong"/"weak" badge is injected inside the landing-page engagement cell

- **Design:** 12-insights.html L93: the engagement cell is "<td style="padding:11px 12px;text-align:right;color:#45526B">{{ r.eng }}</td>" — a bare value. Signal (L96) is the design's only per-row badge.
- **Code:** components/analytics/LandingPageSection.tsx:30-44 defines "QualityBadge" and :99-104 renders it beside the engagement value in every row.
- **Fix:** Delete QualityBadge and its use in the engagement cell; the Signal column already carries the row's verdict.

### INSIGHTS-A-18 · MEDIUM · EXTRA — The Insights page head carries a description paragraph the design's head does not have

- **Design:** 12-insights.html L3-6: the head's left column is exactly "<p …>Growth · GA4 + Search Console</p>" + "<h1 …>Insights</h1>" and then "</div>" at L6 — no third element. The chip cluster (L7-11) follows, then the tab row at L13.
- **Code:** app/(dashboard)/insights/layout.tsx:118 passes "description="Analytics, AI visibility, and SEO intelligence share the same workspace context."", which components/workspace/workspace-surface.tsx:43 renders as "<p className="ad-workspace-description">" (app/globals.css:927-933, 12px, max-width 720px) directly under the h1.
- **Fix:** Drop the "description" prop from the Insights WorkspaceSurface call so the head is eyebrow + h1 + chip cluster only.

### INSIGHTS-A-19 · MEDIUM · GEOMETRY — Header eyebrow is 12px with no tracking; the design pins 11px at 0.12em

- **Design:** 12-insights.html L4: "<p style="margin:0;font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#7A869E">Growth · GA4 + Search Console</p>".
- **Code:** app/globals.css:899 "letter-spacing: 0;" for ".ad-workspace-eyebrow" and :902-907 "font-size: 12px; font-weight: 500; text-transform: uppercase;", applied via components/workspace/workspace-surface.tsx:38.
- **Fix:** Set the eyebrow to 11px with letter-spacing 0.12em on this screen.

### INSIGHTS-A-20 · MEDIUM · GEOMETRY — Active outer tab pill is a light blue tint; the design pins solid #0B1020 with white text

- **Design:** data-model.js:495 "const mkTabs = (defs, cur, key) => defs.map((d) => { const a = cur === d[0]; return { … bg: a ? '#0B1020' : '#ffffff', color: a ? '#ffffff' : '#45526B', bd: a ? '#0B1020' : '#E4E8F0' }; });" consumed by 12-insights.html L15.
- **Code:** app/(dashboard)/insights/layout.tsx:152-154 active = "border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]", which app/globals.css:118-121 resolves to bd #cbd9ff / bg #eaf0ff / text #2f6bff.
- **Fix:** Active pill "background:#0B1020; color:#fff; border-color:#0B1020"; inactive "#fff / #45526B / #E4E8F0".

### INSIGHTS-A-21 · MEDIUM · GEOMETRY — Analytics sub-tab underline is accent blue at weight 500; the design pins #0B1020 at weight 600

- **Design:** 12-insights.html L22 "border-bottom:2px solid {{ t.bd }};font-weight:{{ t.w }};color:{{ t.color }}" with data-model.js:728 "mkU" returning "bd: a ? '#0B1020' : 'transparent', color: a ? '#0E1526' : '#7A869E', w: a ? 600 : 500".
- **Code:** app/(dashboard)/insights/analytics/legacy-page.tsx:332-337 — every tab is "font-medium" (500) and the active one is "border-[var(--adv-accent)]" = #2f6bff (app/globals.css:118).
- **Fix:** Use "border-b-2 border-[#0B1020]" and "font-semibold" on the active tab, weight 500 / transparent border on the rest.

### INSIGHTS-A-22 · MEDIUM · GEOMETRY — KPI card radius, label size and value weight all differ from the design's pins

- **Design:** 12-insights.html L28-31: card "border-radius:14px;background:#ffffff;border:1px solid #E4E8F0;padding:14px 16px"; label mono "font-size:9.5px" uppercase ls 0.1em; value "font-family:'Space Grotesk';font-size:22px;font-weight:700".
- **Code:** components/analytics/AnalyticsKpiCard.tsx:27 "rounded-[var(--r-lg,11px)] … p-4" (app/globals.css:2680 "--r-lg: 11px"); :28 label "text-xs" (12px) "tracking-wide" in the body font; :31 value "text-2xl font-semibold" (24px / 600) in the body font.
- **Fix:** Set radius 14px, padding 14px 16px, label mono 9.5px uppercase ls 0.1em, value 22px/700 in the display font.

### INSIGHTS-A-23 · MEDIUM · GEOMETRY — Table head has no #F7F9FC band and is 12px body font; the design pins mono 10px on a filled header row

- **Design:** 12-insights.html L63/L87/L123/L148/L169/L187: every "<th style="padding:9px 16px;…font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.1em;color:#7A869E;background:#F7F9FC">".
- **Code:** components/analytics/SortableTable.tsx:85 "<tr className="border-b">" (no fill) and :89 "py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground". CohortSection.tsx:112-119 and :155-163 do the same by hand.
- **Fix:** Set the header row background to #F7F9FC and the cells to mono 10px/500, letter-spacing 0.1em, colour var(--adv-ink-3), padding 9px 16px / 9px 12px.

### INSIGHTS-A-24 · MEDIUM · MISSING — Overview KPI cards have no change/delta line — the design gives every card a third toned line

- **Design:** 12-insights.html L31: "<p style="margin:4px 0 0;font-size:11.5px;font-weight:600;color:{{ s.dFg }}">{{ s.d }}</p>" inside every anaKpis card; data-model.js:731-735 supplies d/dFg for all six (e.g. "{ k:'Sessions', v:'241.8K', d:'+8.2% vs prev 28d', dFg: C.pos[1] }").
- **Code:** components/analytics/OverviewSection.tsx:60-89 passes only "label" and "value" to each "<AnalyticsKpiCard>"; AnalyticsKpiCard.tsx:32-34 renders "sub" only when supplied. app/api/analytics/overview/route.ts fetches a single window — no previous-period query anywhere, so nothing can populate the line.
- **Fix:** Add a previous-window query to the overview report and pass the comparison as the card's third line, coloured positive/caution per direction, at 11.5px/600.

### INSIGHTS-A-25 · MEDIUM · MISSING — GA4 and Search Console head chips are missing their 14×14 platform logo

- **Design:** 12-insights.html L9: "…<img src="assets/platform-logos/GA4.svg" alt="GA4" style="width:14px;height:14px">GA4 <span …>connected</span>" and L10 the same with "assets/platform-logos/searchconsole.svg" for Search Console — the icon is the first child of each chip.
- **Code:** app/(dashboard)/insights/layout.tsx:82-98 SourceChip renders only "{label}" plus the state badge — no image element. The assets exist unused at public/platform-logos/GA4.svg and public/platform-logos/searchconsole.svg.
- **Fix:** Render a 14×14 "<img>" from /platform-logos/GA4.svg and /platform-logos/searchconsole.svg as the first child of each SourceChip, gap 6px.

### INSIGHTS-A-26 · MEDIUM · WRONG — Heat cells are tinted by text colour; the design shades the cell background green and keeps the text dark

- **Design:** 12-insights.html L72-74: "<td style="padding:11px 12px;text-align:right;font-weight:600;color:#0E1526;background:{{ r.arBg }}">"; data-model.js:729 "const heat = (v, max) => 'rgba(14,159,110,' + (0.05 + 0.3 * Math.min(1, v / max)).toFixed(3) + ')';"
- **Code:** components/analytics/SortableTable.tsx:130-137 sets only text classes — "heatClass = "text-[var(--adc-pos-fg)] font-medium"" / ""text-[var(--adc-caution-fg)] "" / ""text-[var(--adc-danger-fg)] "" — and the "<td>" at :139-147 carries no background.
- **Fix:** Apply the heat as "background: rgba(14,159,110,α)" with α = 0.05 + 0.3·(v/max), keep the text at --adv-ink weight 600, and drop the amber/red text tinting.

### INSIGHTS-A-27 · MEDIUM · WRONG — Overview callouts render a lucide icon instead of the design's text kind chip

- **Design:** 12-insights.html L53: "<span style="…font-family:'IBM Plex Mono';font-size:9px;text-transform:uppercase;letter-spacing:0.08em;border-radius:5px;padding:3px 7px;background:#ffffff;color:{{ o.fg }}">{{ o.kind }}</span>"; data-model.js anaCallouts gives the kinds "Positive", "Warning", "Info".
- **Code:** components/analytics/InsightCallout.tsx:14 "<TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-[var(--adc-pos-fg)] " />", :25 "<AlertTriangle …/>", :35 "<Info …/>" — no textual kind label anywhere in the file.
- **Fix:** Replace the icons with the design's white mono uppercase chip carrying "Positive" / "Warning" / "Info".

### INSIGHTS-A-28 · MEDIUM · WRONG — Callout and opportunity body text is painted in the tone colour instead of ink

- **Design:** 12-insights.html L54 "<span style="font-size:12.5px;line-height:1.55;color:#0E1526">{{ o.text }}</span>"; L209-210 title "color:#0E1526" and description "<p style="margin:0;font-size:12px;line-height:1.55;color:#45526B">" — only the kind chip is toned.
- **Code:** components/analytics/InsightCallout.tsx:15 "<p className="text-sm text-[var(--adc-pos-fg)] ">" and :26 "text-[var(--adc-caution-fg)]"; components/analytics/OpportunityFlags.tsx:185-186 apply "config.titleColor" / "config.textColor" to the whole card body.
- **Fix:** Set callout/opportunity title to var(--adv-ink) and description to var(--adv-ink-2); reserve the tone colour for the chip text and the card border/background.

### INSIGHTS-A-29 · MEDIUM · WRONG — Retention pill's 25–40% tier is green text on a green fill — unreadable

- **Design:** data-model.js "const retPill = (r) => r >= 0.4 ? ['#0E9F6E','#ffffff'] : r >= 0.25 ? ['#BFE5D6','#065F46'] : r >= 0.15 ? ['#F5E1B0','#92400E'] : ['#F6C6D2','#9F1239'];" — the second tier is a light mint fill with dark green text, applied at 12-insights.html L176.
- **Code:** components/analytics/CohortSection.tsx:44 "if (rate >= 0.25) return "bg-[var(--adc-pos-fg)] text-[var(--adc-pos-fg)]";" — background and foreground are both --adc-pos-fg (#0b6b4f, app/globals.css:98). :46 also adds a redundant fifth tier duplicating :45.
- **Fix:** Change that tier to "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]" and drop the duplicated "rate >= 0.05" tier so the ladder matches the design's four steps.

### INSIGHTS-A-30 · MEDIUM · WRONG — Analytics sub-tab caption "Landing Pages" instead of the design's "Landing pages"

- **Design:** data-model.js:730 "const anaTabs = mkU([['overview','Overview'],['products','Products'],['landing','Landing pages'],['audience','Audience'],['demo','Demographics'],['cohorts','Cohorts'],['opps','Opportunities']], st.anaTab, 'anaTab');"
- **Code:** app/(dashboard)/insights/analytics/legacy-page.tsx:41 "{ id: "landing-pages", label: "Landing Pages" },"
- **Fix:** Change the label to "Landing pages".

### INSIGHTS-A-31 · LOW · GEOMETRY — Table footer notes are mono 10.5px outside the card; the design pins 11.5px body font inside the card on a #F3F5F9 top border

- **Design:** 12-insights.html L80: "<p style="margin:0;padding:10px 16px;border-top:1px solid #F3F5F9;font-size:11.5px;color:#98A4BA">Showing 6 of up to 50 rows · GA4 item-scoped events · …</p>" sits inside the Product funnel "<article>"; L101 the same for Landing pages; L214 the Opportunities trailing note is "font-size:11.5px;color:#98A4BA".
- **Code:** components/analytics/ProductFunnelSection.tsx:139 and components/analytics/LandingPageSection.tsx:187 render "className="m-0 font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]"" as a sibling below the table with no border-top band and no card; components/analytics/OpportunityFlags.tsx:146 uses the same mono 10.5px treatment.
- **Fix:** Move the footers inside each table's "<article>" with "padding:10px 16px; border-top:1px solid #F3F5F9", and set all three notes to 11.5px in the body font at var(--adv-ink-4).

### INSIGHTS-A-32 · LOW · WRONG — Landing-page Signal chip vocabulary does not match the design's three words

- **Design:** 12-insights.html L96 renders "{{ r.sig }}" as the Signal chip; data-model.js landRows uses exactly three labels across all six rows: 'Watch', 'Healthy', 'Leaking'.
- **Code:** components/analytics/LandingPageSection.tsx:51-65 "pageSignal" returns ""traffic, no purchase"", ""high bounce"", ""weak engagement"", ""converting"", else null → em-dash at :143.
- **Fix:** Map the same thresholds onto Healthy / Watch / Leaking, keeping the pos / caution / danger tones.

### INSIGHTS-A-33 · LOW · WRONG — Two Overview KPI labels are title-cased against the design's sentence case

- **Design:** data-model.js:731-735 anaKpis: "{ k: 'Engaged sessions', … }" and "{ k: 'Engagement rate', … }".
- **Code:** components/analytics/OverviewSection.tsx:66 "label="Engaged Sessions"" and :71 "label="Engagement Rate"".
- **Fix:** Rename to "Engaged sessions" and "Engagement rate".

### INSIGHTS-A-34 · LOW · WRONG — New/Returning card labels and the demographic chip caption are title-cased against the design

- **Design:** data-model.js nvCards "{ label: 'New visitors' … }", "{ label: 'Returning visitors' … }"; demoChips defs "['age','Age group']".
- **Code:** components/analytics/OverviewSection.tsx:97 "New Visitors", :116 "Returning Visitors"; components/analytics/DemographicSection.tsx:38 "userAgeBracket: "Age Group",".
- **Fix:** Use "New visitors", "Returning visitors" and "Age group".

### INSIGHTS-A-35 · LOW · WRONG — Cohort table column captions differ from the design

- **Design:** 12-insights.html L169 "<th …>New purch.</th><th …>Return purch.</th>"; L187 "<th …>New users</th><th …>Active users</th>".
- **Code:** components/analytics/CohortSection.tsx:117-118 "New Purchases" / "Return Purchases"; :157-158 "New Users" / "Active Users".
- **Fix:** Rename to "New purch.", "Return purch.", "New users", "Active users".

### INSIGHTS-A-36 · LOW · WRONG — Demographic summary sentence says "(avg X)" where the design says "(site avg X)"

- **Design:** data-model.js DEMO: "country: { col: 'Country', sum: 'Country “Germany” has the highest purchase rate at 3.07% (site avg 1.77%).', … }" — every dimension uses "site avg", rendered at 12-insights.html L145.
- **Code:** components/analytics/DemographicSection.tsx:152-155 "<span className="text-muted-foreground"> (avg {fmt(summary.avgPurchaseCvr, "percent")})</span>" — the rest of the sentence at :146-151 is otherwise word-for-word the design's.
- **Fix:** Change the parenthetical to "(site avg …)".

---

## Insights - SEO tab + AI visibility (GEO) tab

### INSIGHTS-B-01 · HIGH · EXTRA — Both SEO and AI Visibility repeat a page header (h2 + paragraph) that the design does not have inside the tab

- **Design:** 12-insights.html has exactly one heading for the screen: h1 "Insights" at line 5. insSEO (218-386) opens directly with the seoKpis band; insGEO (388-586) opens directly with the explainer band. Neither block contains a per-tab h2 or a descriptive paragraph.
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:233-243 renders <h2>SEO Intelligence</h2> plus "Monitor organic search volatility, isolate likely causes, and prioritize technical or content fixes using Search Console-backed intelligence."; app/(dashboard)/insights/ai-visibility/legacy-page.tsx:174-182 renders <h2>AI Visibility</h2> plus "Generative Engine · how your brand surfaces in AI tools." (both also duplicated in the bootstrap-guard branches at 215-225 and 156-165).
- **Fix:** Delete both per-tab headers; the tab identity already comes from the active section pill under the single "Insights" h1.

### INSIGHTS-B-02 · HIGH · EXTRA — AI Visibility renders a second pair of GA4 / Search Console connection chips on top of the layout's

- **Design:** 12-insights.html:9-10 draws the GA4 and Search Console chips once, in the page header cluster. The insGEO block (388-586) contains no connection chips of its own.
- **Code:** app/(dashboard)/insights/ai-visibility/legacy-page.tsx:184-187 renders <ConnectedChip label="GA4"/> and <ConnectedChip label="Search Console"/> inside the page body, while app/(dashboard)/insights/layout.tsx:119-131 already renders SourceChip for both providers in the header meta slot — four chips on the happy path.
- **Fix:** Remove the ConnectedChip pair (and the ConnectedChip component) from the AI Visibility body; keep only the layout header chips.

### INSIGHTS-B-03 · HIGH · EXTRA — Every SEO and GEO tab body is wrapped in an extra white bordered card the design does not draw

- **Design:** 12-insights.html renders each tab's content as free-standing articles on the page background: seoQueriesTab opens directly with <article …background:#ffffff;border:1px solid #E4E8F0> for the table itself (295), and geoOverview (395-440) is four sibling grids with no enclosing panel. No wrapper element exists between the sub-tab row and the tab content in either block.
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:349 <section className="space-y-4 rounded-xl border border-[var(--adv-border)] bg-white p-5"> wraps all six SEO tabs; app/(dashboard)/insights/ai-visibility/legacy-page.tsx:276 <section className="rounded-xl border border-[var(--adv-border)] bg-white p-5"> wraps all six GEO tabs — card-inside-card for every table.
- **Fix:** Remove both wrapper sections so each tab's cards sit directly on the page background.

### INSIGHTS-B-04 · HIGH · EXTRA — Every tab adds a SectionIntro/SectionHeader title + description block the design does not have

- **Design:** In 12-insights.html the captions live inside a card's header bar (e.g. 296 h2 "Query leaders" with the mono sub-caption in the same bar; 316; 364; 373; 443; 466) or as a trailing note (292, 349, 551). No block-level heading precedes a tab's cards anywhere in insSEO (218-386) or insGEO (388-586).
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:352, 412, 451, 466, 481, 518 render <SectionIntro title=… description=…/>; app/(dashboard)/insights/ai-visibility/legacy-page.tsx:279, 295, 317, 339, 361, 383 render <SectionHeader title=… description=…/> — line 279-282 adds a "Search intelligence" heading that then repeats inside the strip at components/geo/GeoOverviewSection.tsx:130-132.
- **Fix:** Delete the SectionIntro/SectionHeader calls and move each caption into the corresponding card's header bar (h2 + mono sub-caption) or to the trailing-note position the design uses.

### INSIGHTS-B-05 · HIGH · WRONG — AI Visibility Pages table has 10 columns instead of the design's 6, and drops "Sourced by"

- **Design:** 12-insights.html:468 (geoPagesTab) — the AI content winners <thead> has exactly six <th>: Page, AI sessions, Engagement, Purchase CVR, AIV score, Sourced by. data-model.js:888 geoPageRows2 rows carry page/s/er/cv/score/by and nothing else. No readiness, AI value, momentum, priority or action column exists anywhere in insGEO (388–586).
- **Code:** components/geo/GeoPagesSection.tsx:94-187 — columns are Page(96), Purchase CVR(107), AIV score(114), Readiness(121), AI value(131), Momentum(141), AI sessions(151), Engagement(158), Priority(166), Action(173). The GeoPage interface (15-38) has no sourcedBy/by field at all.
- **Fix:** Cut the table to the design's six columns in order — Page, AI sessions, Engagement, Purchase CVR, AIV score, Sourced by — deleting Readiness, AI value, Momentum, Priority and Action, and add the engines that sourced each page as the final column.

### INSIGHTS-B-06 · HIGH · WRONG — SEO Monthly AI tab renders a different card entirely: no "reads" chips, no What changed / Likely causes / 30-day plan grid

- **Design:** 12-insights.html:237-275 (seoAiTab) is ONE article: h2 "Monthly AI analysis — August 2026" + green "available" chip (241-242), mono generated/window line (244), a non-clickable chip "One analysis per month · next window Sep 1" (246), a "reads" label with 4 chips (249-250, data-model.js:800), one 14.5px/600 headline paragraph (252), then a three-column grid What changed | Likely causes | 30-day plan with 01–NN numbering (253-274).
- **Code:** app/(dashboard)/insights/seo/seo-intelligence-support.tsx:150-183 renders Badges "Monthly AI Analysis"/"1 run per month", h3 "This month's SEO strategy analysis is locked in", and three StatusMeta blocks (Generated / Coverage period / Availability), then SeoAiWorkspaceOverview (326-334) = AiAnalysisSummary + AiRootCauseGrid + AiPriorityMatrix + AiActionPlanTimeline. AiBriefCard — the only component that renders "What changed"/"Likely causes"/"30-day plan" (501-525) — is imported nowhere but page.test.tsx:5 (verified by grep across app/, components/, lib/).
- **Fix:** Rebuild the tab as the design's single card: title + availability chip, the mono generated/window line, the disabled "One analysis per month · next window …" chip, the reads chip row, the headline paragraph, and the three-column What changed / Likely causes / 30-day plan grid. Drop the StatusMeta blocks and the workspace-overview stack.

### INSIGHTS-B-07 · HIGH · WRONG — SEO Actions tab renders a 4-quadrant impact/effort matrix plus a 30-day timeline instead of the design's 3 tone groups

- **Design:** 12-insights.html:334-350 (seoActionsTab) renders seoActionGroups as three cards, each headed by ONE tone chip (337) with items of title + why + impact · effort (341-343), followed by the note at 349 "Sequenced from the monthly model output — what to fix first, what to schedule, what to defer." data-model.js:828-837 defines exactly three tones: Quick wins, Strategic, Supporting. There is no quadrant grid and no timeline in this block.
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:496-502 mounts SeoMonthlyAiActionsPanel; seo-intelligence-support.tsx:271-272 renders AiPriorityMatrix + AiActionPlanTimeline. AiPriorityMatrix (408-427) draws four quadrants "High impact / low effort", "High impact / higher effort", "Medium impact / low effort", "Deeper follow-up work"; AiActionPlanTimeline (470-499) draws a "30-day action plan" section.
- **Fix:** Replace the quadrant matrix and the timeline with three tone-grouped cards (Quick wins / Strategic / Supporting), items as title + why + impact · effort, plus the design's trailing note.

### INSIGHTS-B-08 · HIGH · WRONG — GEO Playbook tab is implemented as an "Opportunities" tab with filter pills, a sort dropdown, type icons and a Target line

- **Design:** 12-insights.html:555-571 (geoPlaysTab) is a two-column grid of geoPlays cards, each = mono number "01"…"04" (559) + title (561) + why "Evidence: …" (562) + out "Expected: …" (563) + two effort/impact chips (564-566). data-model.js:909-913 confirms n/t/why/out/chips only. Nothing in insGEO (388–586) has a priority filter row, a sort control, a type icon or a Target line.
- **Code:** components/geo/GeoOpportunitiesSection.tsx:76-81 FILTERS All/High Priority/Medium/Low rendered at 133-156; a <select> sort control at 158-168 with Priority / Lowest effort first / Highest effort first; cards at 178-239 carry a lucide icon (186), priority badge (191-196), type badge (197-199), "Impact:" (202-205), effort badge, confidence dot, "Target:" (220-222), "Evidence:" (223-225) and a "Recommendation" box (228-234) — and no 01/02/03 numbering and no "Expected:" line.
- **Fix:** Strip the filter pills, sort select, type icon/badges, confidence dot and Target line; render numbered cards (01…N) with title, "Evidence: …", "Expected: …" and the two effort/impact chips.

### INSIGHTS-B-09 · HIGH · WRONG — SEO sub-tab set has two wrong captions and two tabs in the wrong order

- **Design:** data-model.js:793 seoTabs2 = mkU([['ai','Monthly AI'],['traffic','Traffic changes'],['queries','Queries'],['pages','Pages'],['actions','Actions'],['technical','Technical findings']]), rendered in that order by 12-insights.html:232-234; default st.seoTab='ai' (data-model.js:3).
- **Code:** app/(dashboard)/insights/seo/seo-intelligence-support.tsx:25-32 — SEO_TABS = Overview, "Traffic Changes", Queries, Pages, "Technical Findings", "AI Priorities"; default activeTab "overview" (legacy-page.tsx:155).
- **Fix:** Rename tab 1 to "Monthly AI" and the actions tab to "Actions", and move Actions ahead of Technical findings: Monthly AI, Traffic changes, Queries, Pages, Actions, Technical findings.

### INSIGHTS-B-10 · HIGH · WRONG — "Confirmed excluded pages" is a 6-column table with a subtitle instead of the design's url + reason-badge list

- **Design:** 12-insights.html:363-371 — card header h2 "Confirmed excluded pages" plus mono caption "URL Inspection · 5 of 5" (364), then seoExcluded rows rendered as a flex row of exactly two things: the mono, ellipsised URL (367) and one reason badge (368). data-model.js:839-845 supplies only url + reason + badge tones. No Type/Verdict/Coverage/Indexing/Fetch columns.
- **Code:** app/(dashboard)/insights/seo/seo-intelligence-support.tsx:902 title "Confirmed excluded important pages", 903-905 an extra subtitle paragraph, 911-916 a six-column <thead>: Page, Type, Verdict, Coverage, Indexing, Fetch.
- **Fix:** Render as a two-part list — path left, one reason badge right — retitle to "Confirmed excluded pages", add the mono "URL Inspection · N of N" caption in the header bar, delete the subtitle and the extra columns.

### INSIGHTS-B-11 · HIGH · WRONG — Insights section pills are in the wrong order — AI Visibility is placed before SEO Intelligence

- **Design:** data-model.js:727 insSections = mkTabs([['analytics','Analytics'],['seo','SEO Intelligence'],['geo','AI Visibility']], …), rendered in order by 12-insights.html:13-17.
- **Code:** app/(dashboard)/insights/layout.tsx:24-43 — INSIGHTS_TABS = analytics, ai-visibility, seo.
- **Fix:** Reorder INSIGHTS_TABS to Analytics, SEO Intelligence, AI Visibility.

### INSIGHTS-B-12 · MEDIUM · EXTRA — SEO Pages table carries a sixth "Click delta" column the design's five-column Page leaders table does not define

- **Design:** 12-insights.html:318 (seoPagesTab) — the Page leaders <thead> has exactly five <th>: Page, Clicks, Impressions, CTR, Position. seoPageRows (data-model.js:820-827) carries no delta field.
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:470-475 reuses EntityTable, whose fixed column set (seo-intelligence-support.tsx:630-677) always appends a sixth "Click delta" column.
- **Fix:** Give the Pages tab a five-column table (Page, Clicks, Impressions, CTR, Position) with no delta column.

### INSIGHTS-B-13 · MEDIUM · EXTRA — SEO tables add sortable header buttons and per-row classification badges the design's static tables have none of

- **Design:** 12-insights.html:298 and :318 — every <th> is plain text (IBM Plex Mono, 10px, weight 500, uppercase) with no button, arrow glyph or handler; the query/page rows (300-309, 320-328) contain only the metric cells, with no intent or page-type badge.
- **Code:** app/(dashboard)/insights/seo/seo-intelligence-support.tsx:712-737 SortableHeader renders a <button> with an "↕/↑/↓" indicator in every header cell; 685-692 renders a ClassificationBadge under each row label.
- **Fix:** Render the Queries and Pages table headers as static text and drop the classification badge from the row label cell.

### INSIGHTS-B-14 · MEDIUM · EXTRA — GEO Overview adds "Top Priorities" and "Insights" group labels above blocks the design leaves unlabelled

- **Design:** 12-insights.html geoOverview (395-440): the geoPris grid (410-419) and the geoCallouts grid (432-439) each start directly with the card loop — no preceding label element in either block.
- **Code:** components/geo/GeoOverviewSection.tsx:154-157 renders "Top Priorities" above the priority grid, and 254-257 renders "Insights" above the callout grid.
- **Fix:** Delete both group labels so the priority cards and callouts sit directly under the search-intelligence strip.

### INSIGHTS-B-15 · MEDIUM · EXTRA — Methodology accordion carries six paragraphs where the design defines four

- **Design:** data-model.js:915-919 methodPs has exactly four entries, bolded "AI referral traffic", "GEO scores", "Query intent classification", "Direct citation visibility"; rendered by 12-insights.html:580-582.
- **Code:** app/(dashboard)/insights/ai-visibility/legacy-page.tsx:409-441 renders six paragraphs, adding "Topic clusters …" (425-430) and "AI Visibility scores per page, query, and topic …" (431-436), and names the second one "AI Visibility Opportunity Score" instead of "GEO scores".
- **Fix:** Cut the Topic clusters and per-entity-score paragraphs, rename the second lead-in to "GEO scores", and fold the proxy/cap sentence into the direct-citation paragraph as the design does.

### INSIGHTS-B-16 · MEDIUM · EXTRA — Technical findings cards add category/page-type badges, a "Recommended fix" line and an "Affected pages" list the design does not draw

- **Design:** 12-insights.html:374-382 — each seoFindings row is exactly a severity chip (376) + a 12.5px/600 title (378) + an 11.5px description (379). data-model.js:846-851 supplies only sev/bg/fg/t/d. No category badge, no page-type badge, no fix line, no affected-page list.
- **Code:** app/(dashboard)/insights/seo/seo-intelligence-support.tsx:849-874 — SeverityBadge plus <Badge>{finding.category}</Badge> and <Badge>{finding.pageType}</Badge> (851-852), a "Recommended fix:" paragraph (856-858) and an "Affected pages" scroll list (859-874).
- **Fix:** Reduce each finding to severity chip + title + description; fold the fix text into the description or drop it, and remove the category/page-type badges and the affected-pages list.

### INSIGHTS-B-17 · MEDIUM · EXTRA — The Insights header carries a description paragraph the design's header does not have

- **Design:** 12-insights.html:3-6 — the header's left column is exactly two elements: the eyebrow <p> "Growth · GA4 + Search Console" and <h1>Insights</h1>. Nothing follows the h1.
- **Code:** app/(dashboard)/insights/layout.tsx:118 passes description="Analytics, AI visibility, and SEO intelligence share the same workspace context.", which components/workspace/workspace-surface.tsx:42 renders as <p className="ad-workspace-description">.
- **Fix:** Drop the description prop from the Insights WorkspaceSurface.

### INSIGHTS-B-18 · MEDIUM · EXTRA — AI Sources, Pages and Playbook tabs each render a second intro paragraph inside the section, on top of the SectionHeader

- **Design:** 12-insights.html: geoSources (441-462), geoPagesTab (464-483) and geoPlaysTab (554-572) each open directly with the card/grid — their only prose is the mono sub-caption inside the card header bar (443, 466), and the Playbook block has none at all.
- **Code:** components/geo/AiTrafficSourcesSection.tsx:171-174 "Sessions arriving from known AI discovery engines. …"; components/geo/GeoPagesSection.tsx:207-211 "Pages receiving AI-origin traffic scored by GEO readiness, AI traffic value, and momentum. …"; components/geo/GeoOpportunitiesSection.tsx:129-131 "Evidence-based actions to improve your AI-era discoverability. …". Each sits below the page-level SectionHeader, so these tabs carry two paragraphs of explanatory copy the design has none of.
- **Fix:** Delete these component-level intro paragraphs; the only caption the design allows is the mono sub-caption in the card's own header bar.

### INSIGHTS-B-19 · MEDIUM · EXTRA — GEO tables add clickable sort headers with arrow icons the design's static GEO tables do not have

- **Design:** 12-insights.html:445 (AI traffic sources), :468 (AI content winners) and :492 (Query intelligence) — every <th> is plain text (IBM Plex Mono, 10px, weight 500, uppercase, background #F7F9FC) with no onClick, button or glyph. The only interactive element inside those tables is the GEO-score pill (500), which the design explicitly makes clickable.
- **Code:** components/analytics/SortableTable.tsx:85-110 gives every non-opted-out <th> cursor-pointer, an onClick handler and an ArrowUp/ArrowDown/ArrowUpDown icon; it backs both AiTrafficSourcesSection (177-182) and GeoPagesSection (212-217). components/geo/GeoQueriesSection.tsx:261-275 does the same by hand with "↑/↓" for GEO Score, Impressions, CTR and Position.
- **Fix:** Render the GEO table headers as static text, keeping only the GEO-score pill interactive.

### INSIGHTS-B-20 · MEDIUM · MISSING — The header date-range chip is absent; the range control is a full-width bordered card in each tab body instead

- **Design:** 12-insights.html:8 places the range control in the header cluster as a chip: "Jul 18 – Aug 14 · 28d ▾" (border 1px #E4E8F0, radius 9px, padding 6px 11px, 11.5px mono). No range control appears anywhere below the header in insSEO or insGEO.
- **Code:** app/(dashboard)/insights/layout.tsx:119-132 — the header meta slot holds only the two SourceChips, no date control. app/(dashboard)/insights/seo/legacy-page.tsx:256-261 and app/(dashboard)/insights/ai-visibility/legacy-page.tsx:222-228 each render <section className="rounded-xl border … bg-white p-3"><DateRangePicker …/></section> inside the tab body.
- **Fix:** Move the DateRangePicker into the Insights layout header meta row, styled as the design's chip, and delete the bordered range-picker card from both tab bodies.

### INSIGHTS-B-21 · MEDIUM · MISSING — Four of the six GEO KPI cards lose their sub-line, including the two that are static explanatory copy

- **Design:** data-model.js:854-861 — every geoKpi carries a sub: "+38% vs prev 28d", "site avg 65.6%", "site avg 1.77%", "composite · deterministic", "proxy · capped at 50", "2,148 sessions · 56% of AI traffic"; rendered unconditionally at 12-insights.html:401.
- **Code:** components/geo/GeoOverviewSection.tsx:84-124 — only AI Engagement Rate (89-98) and AI Purchase CVR (99-108) pass sub. AI-Source Sessions (84-88), GEO Opportunity Score (109-114), Pages with GEO Signals (115-119) and Top AI Source (120-124) pass none.
- **Fix:** Add the sub-line to all six: period delta for sessions, "composite · deterministic" for the opportunity score, "proxy · capped at 50" for pages with GEO signals, and "N sessions · X% of AI traffic" for the top source (the first needs a prev-period session count added to the overview payload).

### INSIGHTS-B-22 · MEDIUM · WRONG — SEO Technical findings stat cards are the wrong set (Pages audited and Passed missing, Opportunities invented) and sit after the excluded-pages list

- **Design:** 12-insights.html:353-384 (seoTech) orders the block as: grey explainer band (353) → seoTechCards row (354-361) → the two-column Confirmed excluded pages / Technical findings row (362-384). data-model.js:838 seoTechCards = Pages audited 148, Critical 5, Warnings 12, Passed 131. No "Opportunities" card exists in the block.
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:547-553 renders ConfirmedExcludedPagesList first and FindingsSummaryCards after it; seo-intelligence-support.tsx:800-812 FindingsSummaryCards renders exactly three cards: Critical, Warnings, Opportunities.
- **Fix:** Move the summary cards above the excluded-pages/findings row and make them four — Pages audited, Critical, Warnings, Passed — dropping Opportunities (the payload's summary type needs the two counts added).

### INSIGHTS-B-23 · MEDIUM · WRONG — SEO Traffic changes renders four full 6-column sortable tables instead of the design's compact mover lists

- **Design:** 12-insights.html:278-291 (seoTraffic) — each seoMovers card has a header bar (title + mono "clicks · 28d vs prev", line 281) and rows of exactly three elements: label, current clicks, delta pill (283-287). data-model.js:804-810 mv(label, cur, d, up) carries nothing else.
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:417-444 mounts four EntityTables; seo-intelligence-support.tsx:627-707 emits a six-column table (label, Clicks, Impressions, CTR, Position, Click delta) with sortable header buttons, and the header bar (623-625) carries only the title — no mono "clicks · 28d vs prev" caption.
- **Fix:** Render the four mover cards as label + current-clicks + delta-pill rows under a header carrying the mono "clicks · 28d vs prev" caption, instead of reusing EntityTable.

### INSIGHTS-B-24 · MEDIUM · WRONG — SEO Queries table ends in a "Click delta" column where the design specifies "Δ pos"

- **Design:** 12-insights.html:298 — the last <th> of the Query leaders table reads "Δ pos", rendered as a tone pill at line 307; data-model.js:811-819 fills it with position deltas ('+0.8', '−0.6', '=').
- **Code:** app/(dashboard)/insights/seo/seo-intelligence-support.tsx:670-677 — the sixth column is label="Click delta" with sortKey "clickDelta", rendered at 698-700 from row.clicksDeltaPercent. The needed field already exists: lib/seo/intelligence.ts:73 SeoEntityChange.positionDelta.
- **Fix:** Change the Queries table's last column to "Δ pos", driven by row.positionDelta and rendered as a tone pill.

### INSIGHTS-B-25 · MEDIUM · WRONG — GEO Query Intelligence filter pills are in the wrong order — "All Queries" leads where the design leads with "AI intent"

- **Design:** data-model.js:899 geoFilters = [['ai','AI intent','41'],['all','All queries','220'],['hi','High impressions','68'],['weak','Weak CTR','23'],['rising','Rising ↑','17']], rendered in that order by 12-insights.html:486-488.
- **Code:** components/geo/GeoQueriesSection.tsx:48-54 — FILTERS = All Queries, AI Intent, High Impressions, Weak CTR, Rising ↑ (the default selection at line 98 is already "ai_style", so only the render order is wrong).
- **Fix:** Put the AI Intent pill first, followed by All Queries, High Impressions, Weak CTR, Rising ↑.

### INSIGHTS-B-26 · MEDIUM · WRONG — GEO query-table footnote is placed above the filters, outside the card, and its text is rewritten

- **Design:** 12-insights.html:515 — the note sits INSIDE the table card, below the </tbody>, on a top-bordered strip: "✦ marks high answer-engine potential · click a GEO score for its component breakdown · counts reflect the full 220-query dataset, table shows the top rows by GEO score."
- **Code:** components/geo/GeoQueriesSection.tsx:148-152 renders "Queries classified by semantic intent and format, scored for GEO relevance. ✦ marks high AI answer-engine potential. Click a GEO score to see its breakdown. Momentum compares to the previous equivalent period." above the filter pills (155-179) and above the table (182).
- **Fix:** Move the footnote below the table inside the card on a top-bordered strip, and use the design's wording including the dataset-count clause.

### INSIGHTS-B-27 · MEDIUM · WRONG — The sixth GEO tab is captioned "Opportunities" instead of "Playbook"

- **Design:** data-model.js:853 geoTabs = mkU([… ['plays','Playbook']], st.geoTab, 'geoTab'), rendered by 12-insights.html:391-393.
- **Code:** app/(dashboard)/insights/ai-visibility/legacy-page.tsx:40-47 — the last entry is { id: "opportunities", label: "Opportunities" }.
- **Fix:** Rename the tab label to "Playbook".

### INSIGHTS-B-28 · MEDIUM · WRONG — SEO KPI cards render the delta as plain text and the previous value as "Previous: N" instead of the design's pill + mono "prev N"

- **Design:** 12-insights.html:223-227 — value and delta share one baseline row (display:flex;align-items:baseline), the delta being a filled pill (border-radius:6px;padding:1px 7px;font-size:11px;font-weight:700;background:{{ s.dBg }}), with a mono 10.5px line below reading {{ s.prev }} = "prev 44.2K" (data-model.js:795).
- **Code:** app/(dashboard)/insights/seo/seo-intelligence-support.tsx:88-98 — the delta is <p className="text-sm font-medium"> with no background, pushed to the right of a flex row, and the previous value renders as "Previous: {formatMetric(...)}" at line 93-95.
- **Fix:** Render the delta as a tone-filled pill beside the value on the same baseline, and change the sub-line to the mono "prev <value>" form.

### INSIGHTS-B-29 · LOW · GEOMETRY — Active Insights section pill is light blue instead of the design's near-black

- **Design:** data-model.js:495 mkTabs active branch: bg '#0B1020', color '#ffffff', bd '#0B1020'; bound at 12-insights.html:15.
- **Code:** app/(dashboard)/insights/layout.tsx:152-154 — active pill uses border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)], which app/globals.css:118-121 defines as #cbd9ff / #eaf0ff / #2f6bff.
- **Fix:** Give the active section pill background #0B1020, border #0B1020 and text #ffffff.

### INSIGHTS-B-30 · LOW · GEOMETRY — The GEO opportunity-score KPI card uses a purple border on white instead of the design's blue-tinted card

- **Design:** data-model.js:858 — the GEO opportunity score KPI is bd '#CBD9FF', bg '#F8FAFF' while the other five are bd '#E4E8F0', bg '#ffffff'; bound as border:1px solid {{ s.bd }};background:{{ s.bg }} at 12-insights.html:398. The value keeps the standard ink #0E1526 (line 400).
- **Code:** components/geo/GeoKpiCard.tsx:27-41 — the highlight branch keeps bg-white and only swaps the border to var(--adc-auto-bd) (#d9ccf1, app/globals.css:106) and the value colour to var(--adc-auto-fg) (#6c41be).
- **Fix:** Give the highlighted KPI card background #F8FAFF and border #CBD9FF, and leave the value in the standard ink colour.

### INSIGHTS-B-31 · LOW · GEOMETRY — Sub-tab labels stay at weight 500 when active where the design pins 600

- **Design:** data-model.js:728 mkU returns w: a ? 600 : 500, and 12-insights.html:233 (SEO) and :392 (GEO) bind it to font-weight:{{ t.w }}.
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:338 and app/(dashboard)/insights/ai-visibility/legacy-page.tsx:262 both apply the constant class "text-[13px] font-medium" (500) to every sub-tab regardless of active state.
- **Fix:** Set the active sub-tab to font-weight 600 and leave inactive ones at 500.

### INSIGHTS-B-32 · LOW · GEOMETRY — Confirmed excluded pages and Technical findings stack full-width instead of sitting side by side

- **Design:** 12-insights.html:362 — the two cards live in one grid: style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px;align-items:start", with Confirmed excluded pages (363-371) left and Technical findings (372-383) right. The excluded list's finding copy even reads "5 remain excluded (listed left)" (data-model.js:847).
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:547-553 renders ConfirmedExcludedPagesList and TechnicalFindingsList as consecutive siblings inside the single-column <section className="space-y-4 …"> (349); TechnicalFindingsList itself is a space-y-3 stack (seo-intelligence-support.tsx:846).
- **Fix:** Wrap the two cards in a repeat(auto-fit, minmax(380px,1fr)) grid with align-items:start so they render as a two-column row.

### INSIGHTS-B-33 · LOW · WRONG — AI Visibility explainer band copy drops the design's "measured from your own traffic and search data" clause

- **Design:** 12-insights.html:389 — "How AI surfaces like ChatGPT, Perplexity, Gemini and Copilot expose your brand and content — measured from your own traffic and search data — and what to improve to win more AI-sourced discovery."
- **Code:** app/(dashboard)/insights/ai-visibility/legacy-page.tsx:194-198 — "Understand how AI-driven surfaces like ChatGPT, Perplexity, Gemini, and Copilot expose your brand and content, and what to improve next to win more AI-sourced discovery."
- **Fix:** Replace the explainer sentence with the design's exact wording, including the em-dash clause about measuring from your own traffic and search data.

### INSIGHTS-B-34 · LOW · WRONG — SEO KPI label reads "Average Position" where the design says "Avg position"

- **Design:** data-model.js:794-799 — labels are "Organic clicks", "Impressions", "CTR", "Avg position". (Both design and impl uppercase the label via CSS, so only the abbreviation actually differs on screen: "AVG POSITION" vs "AVERAGE POSITION".)
- **Code:** app/(dashboard)/insights/seo/legacy-page.tsx:322 label="Average Position".
- **Fix:** Use the design's caption verbatim: "Avg position".

### INSIGHTS-B-35 · LOW · WRONG — AI Sources table column reads "Purchase CVR" where the design's 9-column header says "CVR"

- **Design:** 12-insights.html:445 — the AI traffic sources <thead> is AI engine | AI value | Momentum | Sessions | Engagement | Purchases | CVR | Revenue | Recommendation; the seventh <th> is literally "CVR" (the wider Pages table at 468 uses "Purchase CVR", so the shortening is deliberate).
- **Code:** components/geo/AiTrafficSourcesSection.tsx:120-127 — { key: "purchaseCvr", header: "Purchase CVR", … }.
- **Fix:** Rename the AI Sources CVR column header to "CVR".

### INSIGHTS-B-36 · LOW · WRONG — GEO query Intent/format cell is split into two badges plus a confidence dot instead of one combined badge

- **Design:** 12-insights.html:497 renders a single span: {{ r.star }}{{ r.intent }}, where intent is already the combined string (data-model.js:890 intent: 'Informational · How-to'), tinted violet when AI-style. No format chip and no confidence dot appear in the row.
- **Code:** components/geo/GeoScoreBreakdown.tsx:146-160 QueryIntentBadge renders an intent capsule (151-153), a separate format chip (154-156) and a 1.5px confidence dot (157); mounted by components/geo/GeoQueriesSection.tsx:206-212.
- **Fix:** Collapse the cell to one badge reading "✦ <Intent> · <Format>", violet when AI-style, and drop the separate format chip and confidence dot.

### INSIGHTS-B-37 · LOW · WRONG — Topic Authority adds an intro paragraph and omits the design's trailing explanatory note

- **Design:** 12-insights.html geoTopicsTab (518-553): the card loop starts immediately at 520, and the only prose is the note AFTER the cards at 551: "Clusters built from your ranking queries — strong coverage means many queries rank for the topic; gaps are where demand exists without owned answers."
- **Code:** components/geo/GeoTopicsSection.tsx:135-139 renders "Topic clusters scored for GEO authority with momentum tracking. …" above the grid at 140; the component ends at the grid close (243) with nothing following.
- **Fix:** Remove the intro paragraph and add the design's note below the topic cards.

---

## Reports (incl. the drag-drop builder)

### REPORTS-01 · HIGH · EXTRA — Builder right rail permanently shows a Templates panel the design's inspector column has no room for

- **Design:** 13-reports.html l.241-287: the third grid column is one <article> with exactly two mutually exclusive states, sc-if {{ bSelAny }} (l.242-265) and sc-if {{ bSelNone }} (l.266-286). I read the whole rBuilder block l.81-290: no template list and no category pills anywhere in the builder.
- **Code:** components/reports/report-builder.tsx:1891 "{true ? (" … :1894 "{tr("Templates", "Template'ler")}" … category filter pills … full CUSTOM_REPORT_TEMPLATES list with TemplateMiniPreview, closing at :1932. Rendered unconditionally, so it is on screen even while a block is selected.
- **Fix:** Delete the Templates section (report-builder.tsx:1891-1932) from the builder's right rail; template choice lives on the Templates tab.

### REPORTS-02 · HIGH · EXTRA — Canvas card carries a "Canvas" heading, a description textarea and a "Template: id" chip the design never draws

- **Design:** 13-reports.html l.110-115: the canvas <article> begins directly with the report page header row. I read the whole rBuilder block l.81-290 — no "Canvas" heading, no description field, no template-id badge.
- **Code:** components/reports/report-builder.tsx:1013 "<h2 className="text-lg font-semibold">{tr("Canvas", "Tuval")}</h2>"; :1014-1020 description "<textarea … placeholder={tr("Add a description for this report...", …)}"; :1022-1026 "Template: {templateId}" chip.
- **Fix:** Remove the "Canvas" heading, the description textarea and the Template id chip from the canvas card (report-builder.tsx:1011-1027).

### REPORTS-03 · HIGH · EXTRA — Every canvas block has three drag-resize handles; the design resizes only via S/M/L

- **Design:** 13-reports.html l.122 — the only resize affordance on a block is the size chip cycling S → M → L; l.251-258 the inspector offers Width [⅓ ½ Full]. No resize handles exist anywhere in the fragment.
- **Code:** components/reports/report-builder.tsx:1239 right-edge "cursor-ew-resize" handle, :1259 bottom-edge "cursor-ns-resize" handle, :1279 corner "cursor-se-resize" handle, all driving "setActiveResize".
- **Fix:** Delete the three resize handles (report-builder.tsx:1225-1283); width changes come from the block's size chip and the inspector's Width control.

### REPORTS-04 · HIGH · EXTRA — Inspector adds table, breakdown, body and subtitle sections the design does not define

- **Design:** 13-reports.html l.242-265: the bSelAny branch contains exactly Title, Metric, Source, Date range, Width, the compare checkbox, Remove block and the footnote. No dimension picker, no row-count control, no column chips, no breakdown, no body field, no subtitle field.
- **Code:** components/reports/report-builder.tsx:1571 table panel (Dimension select at :1648-1666, rows select "5 rows/8 rows/10 rows/15 rows/20 rows", metric chips, "+ Add metric" search dropdown); :1771 "Breakdown" section; :1857 "Body" textarea; :1882 "placeholder={tr("Subtitle (optional)", …)}".
- **Fix:** Remove the Dimension / rows-limit / column-chip / Add-metric block, the Breakdown section, the Body textarea and the Subtitle input so the inspector matches the design's six controls.

### REPORTS-05 · HIGH · EXTRA — Inspector adds a "← Back" button and a quick-add widget strip

- **Design:** 13-reports.html l.242-265 (bSelAny) read in full: no back control and no add-widget buttons inside the inspector; blocks are added from the left palette (l.100 "onClick="{{ it.add }}"").
- **Code:** components/reports/report-builder.tsx:1355 "← Back" button; :1363-1374 quick-add strip rendering "+ {w.label}" for every WIDGET_LIBRARY entry.
- **Fix:** Delete the "← Back" button and the quick-add strip; deselecting happens by clicking the block again (design: w.select toggles bSel).

### REPORTS-06 · HIGH · EXTRA — Both tabs are wrapped in ProductSection headings the design has no counterpart for

- **Design:** 13-reports.html l.17-45 (rMine) is a bare <article> list plus a footnote; l.47-79 (rTemplates) is a bare grid plus a footnote. Neither sc-if block contains a section heading or sub-description.
- **Code:** app/(dashboard)/reports/legacy-page.tsx:244-247 "<ProductSection title={… "Saved Reports"} description={… "Every saved report belongs to the active business."} …>"; :337-339 "<ProductSection title={… "Template Gallery"} description={… "Start with a one-click structure, then customize every widget and slot."}>". ProductSection renders an h2 + p (components/ui/product-surface.tsx:63-66).
- **Fix:** Drop both ProductSection wrappers; render the report list article and the template grid directly under the tab row as the design does.

### REPORTS-07 · HIGH · EXTRA — Builder toolbar adds a "Back" button and an "Actions" dropdown (Export CSV / Export PDF / Share expiry / Copy share link)

- **Design:** 13-reports.html l.82-90 — the toolbar article contains exactly: name input, date-range select, "vs previous period" pill, spacer, block counter, Preview, Save & schedule. No back control, no overflow menu, no share-expiry control.
- **Code:** components/reports/report-builder.tsx:835-848 "Back" Button; :884-934 Actions dropdown containing "Export CSV" (:901), "Export PDF" (:909), a "Share expiry" label + select (:913-922) and "Copy share link" (:930).
- **Fix:** Remove the Back button and the Actions dropdown from the builder toolbar; export/share belong to the saved-report row (Share link / PDF) per the design.

### REPORTS-08 · HIGH · MISSING — Inspector has no "Report settings" state (Client, Schedule, Recipients, Live share link)

- **Design:** 13-reports.html l.266-282: eyebrow "Report settings"; label "Client" + select (Aurora Supply Co. / Northpeak Agency (white-label)); label "Schedule" + select (Manual — send when I say / Weekly · Monday 08:00 / Monthly · 1st, 08:00); "Recipients" chip list with a dashed "+ add" chip; toggle row "Live share link" with right-aligned mono "viewer role".
- **Code:** components/reports/report-builder.tsx:1933-1938 — with nothing selected the rail renders only the hint paragraph. grep for "Recipients", "Schedule", "Live share" in components/reports/report-builder.tsx returns nothing, and lib/custom-reports.ts has no schedule/recipients field at all.
- **Fix:** Add the bSelNone branch: Report settings eyebrow, Client select, Schedule select, Recipients chip list with "+ add", and the Live share link toggle with the "viewer role" mono note. Note this needs a schedule/recipients concept in the report record, which does not exist yet.

### REPORTS-09 · HIGH · MISSING — Builder canvas has no report page header (accent square, name, client · date range · Page 1, 2px dark rule)

- **Design:** 13-reports.html l.111-114: header row with "border-bottom:2px solid #0B1020", a 10px #2F6BFF square, "{{ bName }}" in Space Grotesk 17px/700, and right-aligned mono "Aurora Supply Co. · Jul 17 – Aug 13 · Page 1".
- **Code:** components/reports/report-builder.tsx:1011-1027 — the canvas card opens with "<h2 className="text-lg font-semibold">{tr("Canvas", "Tuval")}</h2>"; grep for "Page 1" in components/reports/ returns nothing.
- **Fix:** Render the design's page header at the top of the canvas card: accent square + report name + right-aligned "{client} · {range} · Page 1", with the 2px #0B1020 bottom rule.

### REPORTS-10 · HIGH · MISSING — Canvas blocks lack the design's block chrome: drag handle, mono title, S/M/L size chip, ✕ remove, provenance line

- **Design:** 13-reports.html l.119-123: "⠿" handle titled "Drag to reorder", mono uppercase "{{ w.title }}", size chip "onClick="{{ w.cycleSize }}" title="Cycle width S → M → L"" showing "{{ w.sizeLabel }}", and "✕" remove; l.233 mono "{{ w.srcNote }}" = "blended · report range · vs previous period" (data-model.js base.srcNote).
- **Code:** components/reports/report-builder.tsx:1186-1224 — the block's only chrome is a hover pill bar with "Edit" (:1200), "Copy" (:1211) and "Del" (:1222). No drag-handle glyph, no size chip, and grep for "report range · vs previous" in components/ returns nothing.
- **Fix:** Replace the Edit/Copy/Del pill bar with the design's header row (⠿ handle, mono uppercase title, S/M/L cycle chip, ✕) and add the mono provenance line under every block body.

### REPORTS-11 · HIGH · MISSING — Block palette has no groups and is missing 7 of the design's 13 block types

- **Design:** data-model.js bPalette: 'KPIs' [KPI tile, KPI row · 4 up], 'Charts' [Trend line, Bar compare, Share donut, Funnel], 'Tables' [Campaign table, Creative heat table, Query table], 'Content' [AI summary, Text block, Decision log, Creative brief] — 13 items with per-group icon colours #2F6BFF / #0E9F6E / #B45309 / #6C41BE; rendered with group headings at 13-reports.html l.95-97 "{{ g.name }}".
- **Code:** components/reports/report-builder.tsx:52-57 WIDGET_LIBRARY = metric, trend, bar, table, text, section — a flat list of 6, rendered at :965-1002 with no group heading and a single icon colour ("bg-[var(--adv-accent-bg)]").
- **Fix:** Add the four palette groups with their headings and the missing block types (KPI row, Share donut, Funnel, Creative heat table, Query table, AI summary, Decision log, Creative brief), keeping the design's group order and per-group icon colours.

### REPORTS-12 · HIGH · MISSING — Inspector has no "Source" select; it uses a row of platform logo buttons instead

- **Design:** 13-reports.html l.249: labelled "Source" + "<select>" with "Blended · all providers", "Meta Ads", "Google Ads", "GA4", "Shopify", "Search Console".
- **Code:** components/reports/report-builder.tsx:1396-1450 — a "Channel logo strip" of "<button className="flex h-8 w-8 …">" icon buttons with "<Image src={logo} …>" (repeated for the table panel at :1608-1651). No labelled Source select exists anywhere in the panel.
- **Fix:** Replace the channel logo button strip with a labelled "Source" <select> carrying the design's six options.

### REPORTS-13 · HIGH · MISSING — Inspector has no Width control (⅓ / ½ / Full segmented)

- **Design:** 13-reports.html l.251-258: "Width" label over a segmented control iterating {{ bSizeOpts }}; data-model.js bSizeOpts = [['S','⅓'],['M','½'],['L','Full']] with the active segment filled #0B1020.
- **Code:** components/reports/report-builder.tsx:1338-1888 — the whole selected-widget panel; the only "Width" occurrence in the file is "columnWidth" at :562 and the resize-handle tooltip at :1240. Width is changeable only by dragging the resize handles.
- **Fix:** Add the three-segment Width control (⅓ / ½ / Full) below Date range, writing the block's S/M/L size.

### REPORTS-14 · HIGH · MISSING — Inspector has no "Show vs previous period" checkbox and no "Remove block" button

- **Design:** 13-reports.html l.259-262: checkbox row "onClick="{{ bToggleCompare }}"" labelled "Show vs previous period"; l.263: "<button onClick="{{ bRemoveSel }}" style="…border:1px solid #F6C6D2;…color:#E11D48…">Remove block</button>".
- **Code:** components/reports/report-builder.tsx:1870-1885 — the panel ends with the Copy section (Title + Subtitle inputs) and closes at :1887-1888. Neither string appears in the file; removal is only reachable from the canvas hover pill "Del" at :1222.
- **Fix:** Append the "Show vs previous period" checkbox and the red-outline "Remove block" button to the bottom of the block inspector.

### REPORTS-15 · HIGH · MISSING — Inspector header is missing the "Block settings" eyebrow and the block-kind chip

- **Design:** 13-reports.html l.243-245: mono uppercase eyebrow "Block settings" with a right-aligned chip "{{ bSelKind }}"; data-model.js bKindNames maps kinds to 'KPI tile', 'KPI row', 'Trend line', 'Bar compare', 'Share donut', 'Funnel', 'Table', 'Heat table', 'AI summary', 'Text block', 'Creative brief'.
- **Code:** components/reports/report-builder.tsx:1341-1360 — the panel header is a "← Back" button plus "{selectedWidget.title}"; no eyebrow, no kind chip.
- **Fix:** Replace the panel header with the design's mono "Block settings" eyebrow and the right-aligned block-kind chip.

### REPORTS-16 · HIGH · MISSING — Inspector has no per-block "Date range" select

- **Design:** 13-reports.html l.250: labelled "Date range" + "<select>" with "Report range", "Last 7 days", "Last 28 days".
- **Code:** components/reports/report-builder.tsx:1338-1888 — the selected-widget panel contains Metrics, Table, Breakdown, Body and Copy only; no per-block date-range control exists.
- **Fix:** Add a per-block "Date range" select with the options Report range / Last 7 days / Last 28 days.

### REPORTS-17 · HIGH · MISSING — Template cards omit the cadence, the numbered contents list, the meta footer and both action buttons

- **Design:** 13-reports.html l.58 right-aligned mono "{{ t.cadence }}" (data-model.js e.g. 'best weekly · Mon'); l.64-68 numbered "inside" list rendering "{{ s.n }} {{ s.t }}" (01..05, e.g. 'KPI summary strip', 'Spend vs revenue trend'); l.70 mono "{{ t.meta }}" ('9 blocks · 1 page · Meta + Google + GA4 + Shopify'); l.72-73 buttons "Preview" and "Use template" in a footer separated by a 1px #F3F5F9 rule.
- **Code:** app/(dashboard)/reports/legacy-page.tsx:343-364 — the card renders only the category chip, TemplateProviders, TemplateMiniPreview, name, description and "{template.definition.widgets.length} widgets · share link · CSV · print". The entire card is one "<button onClick={… setReportView("builder")}>" at :343-350, so there is no Preview action and no distinct Use template action. lib/custom-reports.ts CustomReportTemplate has no cadence or contents field.
- **Fix:** Rebuild the template card as an <article>: category chip + cadence on one row, name + description, the numbered 01..05 contents list, then a footer with the meta string and the two buttons Preview and Use template.

### REPORTS-18 · HIGH · MISSING — Builder toolbar has no "Preview" button and no "{n} blocks · autosaved" counter

- **Design:** 13-reports.html l.87 mono "{{ bCount }} blocks · autosaved"; l.88 "<button …>Preview</button>" immediately left of the primary button.
- **Code:** components/reports/report-builder.tsx:855-938 — the toolbar's right cluster is two selects, the Actions dropdown and the Save button; grep for "autosaved" in components/reports/ returns nothing, and the only "Preview" strings in the file are the drag-preview labels around :1293-1300.
- **Fix:** Add the mono "{n} blocks · autosaved" counter and a "Preview" button to the toolbar, immediately left of the primary button.

### REPORTS-19 · HIGH · WRONG — Canvas is a fixed 4-column × 140px slot grid instead of the design's S/M/L flow layout

- **Design:** 13-reports.html l.116 "display:flex;flex-wrap:wrap;gap:10px;align-content:flex-start" and l.118 "width:{{ w.wCss }}"; data-model.js wCss = "L → 100%", "M → calc(50% - 5px)", else "calc(33.333% - 7px)". Blocks flow in document order; no empty slots exist.
- **Code:** components/reports/report-builder.tsx:1051-1052 "className="grid gap-3" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridAutoRows: "140px" }}"; :1054 "Array.from({ length: REPORT_GRID_SLOT_COUNT }).map((_, slot) …" renders a drop target per empty slot; :1111 "aria-label={"Target slot ${slot + 1}"}"; a second absolutely-positioned overlay grid at :1128-1132 repeats the same 4×140px geometry.
- **Fix:** Replace the slot grid with a flex-wrap flow where each block takes 33.333% / 50% / 100% from its S/M/L size, and make drop-reorder insert before the hovered block instead of into a numbered slot.

### REPORTS-20 · HIGH · WRONG — Palette item captions and source tags do not match the design, and it adds a "Section" block

- **Design:** data-model.js bPalette label/src pairs: 'KPI tile'/'any', 'Trend line'/'any', 'Bar compare'/'any', 'Campaign table'/'Meta·G', 'Text block'/'—'. 13-reports.html l.103 renders "{{ it.src }}" in the right-hand mono slot. No block named "Section" exists in bPalette or in bKindNames.
- **Code:** components/reports/report-builder.tsx:52-57 — "{ type: "metric", label: "Metric", eyebrow: "KPI" }", "{ type: "trend", label: "Line Chart", eyebrow: "Trend" }", "{ type: "bar", label: "Bar Chart", eyebrow: "Compare" }", "{ type: "table", label: "Table", eyebrow: "Rows" }", "{ type: "text", label: "Text", eyebrow: "Notes" }", "{ type: "section", label: "Section", eyebrow: "Structure" }"; the right-hand mono slot renders "{widget.eyebrow}".
- **Fix:** Rename the palette items to the design's labels and set the right-hand tag to the design's data-source string (any / GA4 / Meta·G / Meta / GSC / engine / —). Drop the "Section" block.

### REPORTS-21 · HIGH · WRONG — Metric control is a searchable multi-row picker; the design specifies one plain select of 7 metrics

- **Design:** 13-reports.html l.248: labelled "Metric" + a single "<select>" with Spend / Revenue / ROAS / Orders / CTR / CVR / Sessions — one metric per block.
- **Code:** components/reports/report-builder.tsx:1456-1548 renders one collapsible row per metric with a search input (:1506-1513 "placeholder={tr("Search", "Ara")}") and a scrolling option list, plus :1550-1565 a "+ Metric" button that appends more metric rows.
- **Fix:** Collapse the metric picker to a single labelled "Metric" select with the design's seven options; remove the search box, the multi-row list and the "+ Metric" button.

### REPORTS-22 · HIGH · WRONG — Saved report row action set diverges: Share link and PDF are missing, Delete is added, "Open in builder" is renamed "Edit"

- **Design:** 13-reports.html l.36-39, in order: "Open in builder" (blue outline, border #CBD9FF, colour #2F6BFF), "Duplicate", "Share link", "PDF". I read the whole rMine block l.17-45: no Delete control exists.
- **Code:** app/(dashboard)/reports/legacy-page.tsx:310-312 "<Link …>{language === "tr" ? "Düzenle" : "Edit"}</Link>"; :313-320 Duplicate; :321-328 "Delete" wired to "handleDelete". No Share link and no PDF button on the row.
- **Fix:** Restore the design's four row actions in order — Open in builder (accent outline), Duplicate, Share link, PDF — and remove the Delete button from the row.

### REPORTS-23 · HIGH · WRONG — Primary builder button says "Save", the design says "Save & schedule"

- **Design:** 13-reports.html l.89: "<button style="…background:#0B1020;color:#ffffff;…">Save & schedule</button>".
- **Code:** components/reports/report-builder.tsx:935-937 "<Button onClick={() => void handleSave()}>{saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved ✓" : "Save"}</Button>" — the default shadcn Button, not the design's #0B1020 fill.
- **Fix:** Rename the primary builder action to "Save & schedule" and give it the design's #0B1020 fill. Depends on the missing schedule concept, so land it together with the Report settings panel.

### REPORTS-24 · HIGH · WRONG — Builder date-range select carries the wrong options

- **Design:** 13-reports.html l.84: "<option>Last 28 days</option><option>Last 7 days</option><option>This month</option><option>Custom range…</option>" — Last 28 days first, and a custom-range option is offered.
- **Code:** components/reports/report-builder.tsx:866-868 "<option value="7">Last 7 Days</option><option value="30">Last 30 Days</option><option value="90">Last 90 Days</option>".
- **Fix:** Change the toolbar range select to Last 28 days / Last 7 days / This month / Custom range…, defaulting to Last 28 days.

### REPORTS-25 · HIGH · WRONG — The builder renders as a full-bleed min-h-screen page with an edge-to-edge toolbar bar, nested inside the Reports tab

- **Design:** 13-reports.html l.82: the toolbar is an "<article style="border-radius:14px;background:#ffffff;border:1px solid #E4E8F0;padding:10px 14px;…">" sitting in the same 16px-gap section column as the header and tab row; l.91-92 the three-column grid follows it directly with "gap:12px". Nothing in the fragment is full-bleed or introduces a second page background.
- **Code:** components/reports/report-builder.tsx:831 "<div className="min-h-screen bg-[#f6f7fb]">" wrapping :832 "<div className="border-b bg-white px-6 py-4">" — a hard-coded page background and an edge-to-edge bordered bar, then :955+ the column grid inside "px-6 py-6". This component is mounted inside the Reports tab at app/(dashboard)/reports/legacy-page.tsx:369, so a whole page shell renders inside the workspace section.
- **Fix:** Drop the "min-h-screen bg-[#f6f7fb]" wrapper and the "border-b" bar; make the toolbar a rounded 14px article with a 1px #E4E8F0 border and 10px/14px padding that sits in the page column, with the three-column grid immediately below it at 12px gap.

### REPORTS-26 · MEDIUM · EXTRA — My reports tab adds a search box and a sort select

- **Design:** 13-reports.html l.9-15 (tab row) and l.17-45 (rMine) read in full: the only controls are the three tab pills and the right-aligned export note; there is no search field and no sort control.
- **Code:** app/(dashboard)/reports/legacy-page.tsx:249-266 — "reports.length > 5 ? (" … "<input … placeholder={… "Search reports..."} />" and "<select …><option value="recent">Sort: Recently updated</option><option value="name">Sort: Name</option></select>".
- **Fix:** Remove the search input and the sort select from the My reports tab (legacy-page.tsx:249-266).

### REPORTS-27 · MEDIUM · EXTRA — Empty builder shows a "Start with your first widget" panel and keyboard-shortcut tips

- **Design:** 13-reports.html l.236-238 — with no blocks the canvas shows only the dashed drop zone reading "Drop a block here — drag any block to reorder, click to configure". No onboarding panel and no shortcut hints appear anywhere in rBuilder (l.81-290).
- **Code:** components/reports/report-builder.tsx:1028-1048 — "Start with your first widget" heading (:1032), a two-sentence paragraph, a "Drag from left" badge, and a tip line naming "Delete", "Cmd/Ctrl + D" and "Shift + Arrow" (:1043-1046).
- **Fix:** Replace this panel with the design's single dashed drop zone carrying the copy "Drop a block here — drag any block to reorder, click to configure".

### REPORTS-28 · MEDIUM · EXTRA — Template card shows a providers line the design's card header does not have

- **Design:** 13-reports.html l.56-59 — the card's top row is exactly the category chip "{{ t.cat }}" plus the right-aligned cadence "{{ t.cadence }}". Providers appear only inside the footer meta string (l.70).
- **Code:** app/(dashboard)/reports/legacy-page.tsx:356 "<TemplateProviders template={template} />" rendered opposite the category chip; components/reports/template-mini-preview.tsx:125 renders "{template.providers.join(" • ")}".
- **Fix:** Remove TemplateProviders from the card header and fold the provider list into the footer meta string as the design does.

### REPORTS-29 · MEDIUM · EXTRA — Page header carries a description sentence, and the export note sits in the header instead of the tab row

- **Design:** 13-reports.html l.3-6 — the header is only the eyebrow paragraph and the h1; there is no description. The mono note "every report exports as PDF · share link · CSV per table" belongs to the tab row, right-aligned after a flex spacer (l.13-14).
- **Code:** app/(dashboard)/reports/legacy-page.tsx:161-165 "description={… "Save report formats, share as a link, or export tables as CSV."}"; :166-172 the export note is passed as "meta", and WorkspaceSurface renders meta inside ".ad-workspace-title-row" next to the h1 (components/workspace/workspace-surface.tsx:38-40).
- **Fix:** Drop the description prop, and move the "every report exports as PDF · share link · CSV per table" note to the right end of the tab row.

### REPORTS-30 · MEDIUM · GEOMETRY — Page title and eyebrow are rendered at the wrong size, weight and tracking

- **Design:** 13-reports.html l.5: h1 "font-family:'Space Grotesk';font-size:26px;font-weight:700;letter-spacing:-0.02em"; l.4: eyebrow "font-size:11px;letter-spacing:0.12em;text-transform:uppercase".
- **Code:** app/globals.css:917-924 ".ad-workspace-title-row h1 { font-size: 16px; font-weight: 600; letter-spacing: 0; }" and :902-907 ".ad-workspace-eyebrow { font-size: 12px; font-weight: 500; }" with no letter-spacing — the only definitions of these classes in the repo, and the classes WorkspaceSurface applies for this screen.
- **Fix:** Give the Reports header the design's metrics: h1 at 26px/700 Space Grotesk with -0.02em tracking, eyebrow at 11px with 0.12em tracking. Note this class is shared, so scope the change or fix it shell-wide deliberately.

### REPORTS-31 · MEDIUM · MISSING — Saved report rows have no status badge (Scheduled / Draft)

- **Design:** 13-reports.html l.30: "<span style="…background:{{ r.stBg }};color:{{ r.stFg }}">{{ r.status }}</span>" immediately right of the report name; data-model.js savedReports statuses 'Scheduled', 'Draft', 'Scheduled' with positive / neutral tone pairs.
- **Code:** app/(dashboard)/reports/legacy-page.tsx:293 "<h3 className="text-[13px] font-semibold …">{report.name}</h3>" — the name renders alone; the only chip on the row is the widget count at :306-308.
- **Fix:** Render a status badge beside the report name using the design's positive/neutral tone pair. It needs the same scheduling concept as the Report settings panel — lib/custom-reports.ts has no status or schedule field today, so land the two together rather than fabricating a status.

### REPORTS-32 · MEDIUM · MISSING — Both tab footnotes are missing

- **Design:** 13-reports.html l.44: "Scheduled reports send from reports@adsecute.com with a live share link — recipients see data as of send time, with provenance stamped per widget."; l.78: "Using a template opens it in the builder pre-filled — every block stays editable, removable and reorderable before the first send." Both are mono 11px #98A4BA.
- **Code:** app/(dashboard)/reports/legacy-page.tsx:335 the saved branch closes straight after the list, and :367 the templates branch closes straight after the grid; neither string exists in the repo.
- **Fix:** Add the two mono footnote paragraphs beneath the report list and beneath the template grid.

### REPORTS-33 · MEDIUM · WRONG — Comparison is a select; the design shows a static "vs previous period" pill

- **Design:** 13-reports.html l.85: "<span style="…height:28px;…border-radius:9999px;background:#EAF0FF;color:#2F6BFF;font-size:12px;font-weight:600">vs previous period</span>" — a pill, not a control; comparison is toggled per block by the inspector checkbox at l.259-262.
- **Code:** components/reports/report-builder.tsx:870-882 "<select value={definition.compareMode} …><option value="none">No Comparison</option><option value="previous_period">Previous Period</option></select>".
- **Fix:** Replace the compareMode select in the toolbar with the accent pill reading "vs previous period"; per-block comparison comes from the inspector checkbox.

### REPORTS-34 · MEDIUM · WRONG — Saved reports render as separate cards with the preview in a right-hand column; the design is one article of divided rows led by an 86px thumbnail

- **Design:** 13-reports.html l.18 a single "<article style="border-radius:14px;background:#ffffff;border:1px solid #E4E8F0;overflow:hidden">" containing every report; l.20 each row is "padding:14px 16px;border-top:1px solid #F3F5F9" and opens with l.21-26 an 86px-wide 2×2 mosaic thumbnail on the left, then the text column (l.27-34), then the action cluster (l.35-40) on the same row.
- **Code:** app/(dashboard)/reports/legacy-page.tsx:285 "<div className="mt-4 space-y-2">" with each report at :287-290 its own "rounded-[8px] border … px-3 py-3" card; :291 "grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]" puts TemplateMiniPreview (:302) in a 160px right column, and :305 moves the actions to a separate row below.
- **Fix:** Wrap the rows in one r14 bordered article, separate them with a 1px #F3F5F9 border-top, and lay each row out as [86px thumbnail] [name/desc/meta] [actions] on a single line.

### REPORTS-35 · LOW · EXTRA — Saved report rows carry a "{n} widgets" chip the design does not define

- **Design:** 13-reports.html l.27-34 — the text column holds exactly the name + status badge (l.28-31), the description line (l.32) and the mono "{{ r.meta }}" line (l.33). No standalone chip appears on the row.
- **Code:** app/(dashboard)/reports/legacy-page.tsx:306-308 "<span className="rounded-[5px] border … font-mono text-[10.5px] …">{report.definition?.widgets?.length ?? 0} {language === "tr" ? "widget" : "widgets"}</span>" rendered opposite the action buttons.
- **Fix:** Remove the widget-count chip; fold the block count into the row's mono meta line as the design does ("… · 9 blocks · Meta + Google + GA4").

---

## Commercial Truth + Team + Settings

### TRUTH-TEAM-SETTINGS-01 · HIGH · EXTRA — Commercial Truth renders five numbered sections the design has no equivalent of

- **Design:** 14-commercial-truth.html is 194 lines end-to-end and contains exactly five top-level blocks: header (:2-6), navy band (:7-13), the 1.45fr/1fr grid (:14-82: Target pack, 'Where $100 of revenue goes', 'Consumed by', 'Change history'), 'Spend × ROAS scenario guide' (:83-131) and 'Where spend sits against these targets' (:132-193). No <h2> reads Decision Coverage, Country Economics, Promo Calendar, Site Health or Decision Calibration; neither does data-model.js.
- **Code:** grep of eyebrow="Section …" in components/settings/commercial-truth-settings.tsx returns 606 (Decision Coverage), 748, 938, 1261, 1472 (Country Economics), 1579 (Promo Calendar), 1687 (Site Health), 1818 (Decision Calibration). All are mounted unconditionally in the render at :2482 DecisionCoverageSection, :2517 CountryEconomicsSection, :2542 PromoCalendarSection, :2565 SiteHealthSection, :2571 CalibrationSection.
- **Fix:** Delete Decision Coverage, Country Economics, Promo Calendar, Site Health & Stock Pressure and Decision Calibration from this screen. The design's Commercial Truth is only: navy band, Target pack, revenue split, Consumed by, Change history, scenario guide, spend-vs-targets.

### TRUTH-TEAM-SETTINGS-02 · HIGH · EXTRA — Settings renders three field cards; the design defines one

- **Design:** 17-settings.html:6-11 — a single <article … display:grid;grid-template-columns:1fr 1fr;gap:14px> with exactly four labels: Full name, Email, Interface language, Workspace timezone. The whole fragment (:1-28) then holds only the plan band (:12-18) and the settingsRows loop (:19-27).
- **Code:** app/(dashboard)/settings/legacy-page.tsx:630-666 a second <FieldCard> with 'Workspace name' (:631) and 'Reporting currency' (:639) plus a 'Save workspace' button (:663); :669-716 a third <FieldCard> with 'Default date range' (:670), 'Metric display' (:684), 'Table density' (:694), 'Heatmap cells' (:706).
- **Fix:** Remove the workspace-identity card and the reporting-defaults card. Only the four-field identity/locale card stays above the plan band.

### TRUTH-TEAM-SETTINGS-03 · HIGH · EXTRA — Settings has seven action rows including a delete-workspace danger zone; the design defines exactly three

- **Design:** 17-settings.html:19 <sc-for list="{{ settingsRows }}" hint-placeholder-count="3">; data-model.js:1232-1236 defines settingsRows as exactly Change password → 'Update', Active sessions → 'Revoke others', Resync warehouse → 'Run resync'. No Refresh / Clear cache / Disconnect / Delete row exists in the fragment or the model.
- **Code:** app/(dashboard)/settings/legacy-page.tsx:804-811 <ActionRow title="Refresh provider snapshots"> → caution 'Refresh'; :813-818 'Clear cached provider accounts' → 'Clear cache'; :820-827 'Disconnect all integrations' → tone="danger" 'Disconnect'; :829-840 'Delete workspace' detail 'Permanently removes this workspace and its assignments. Cannot be undone.' → tone="danger" 'Delete'.
- **Fix:** Delete those four rows. Keep only Change password / Active sessions / Resync warehouse.

### TRUTH-TEAM-SETTINGS-04 · HIGH · EXTRA — Team is wrapped in a plan gate that replaces the whole screen with an upsell the design never draws

- **Design:** 16-team.html:1 — <section data-screen-label="Team"> renders unconditionally; there is no gate, lock icon or upgrade panel anywhere in the 105-line fragment. The only plan reference in the design is one sentence on Settings (17-settings.html:15).
- **Code:** app/(dashboard)/team/legacy-page.tsx:334 <PlanGate requiredPlan="scale"> wraps the entire return; components/pricing/PlanGate.tsx:44-65 returns a centred lock circle, an h2 '{planName} plan required', a paragraph and an 'Upgrade to Scale' link in place of the page, and :29-35 shows a full-screen 'Loading workspace…' state before that.
- **Fix:** Remove the PlanGate wrapper so the designed screen renders; if entitlement must be surfaced, do it as row-level state rather than a full-screen replacement.

### TRUTH-TEAM-SETTINGS-05 · HIGH · MISSING — 'Where spend sits against these targets' has no campaign table — the design's 7-column table and blended tfoot are absent

- **Design:** 14-commercial-truth.html:154-191 — <table … min-width:900px> with thead cells in order Campaign | Spend · 28d | Share | Revenue | ROAS | vs target | Next-snapshot verdict (:157-163), a body row per {{ truthSpendRows }} carrying a platform logo tile, '{{ r.platform }} · {{ r.level }}', a share micro-bar, a ROAS chip, a delta and a verdict pill (:166-179), and a <tfoot> row 'Blended · all labeled spend' with totals and 'vs target {{ tRoasView }}' (:181-189).
- **Code:** components/settings/commercial-truth-blocks.tsx:344-395 — CommercialSpendBands returns only the four band cards (:352-376) and the 12px share bar plus coverage note (:377-392), then closes. There is no <table>, <thead> or <tfoot> in the file.
- **Fix:** Add the campaign table under the share bar with exactly those seven columns in that order, plus the 'Blended · all labeled spend' tfoot carrying total spend, revenue, blended ROAS chip, delta and 'vs target {n}'.

### TRUTH-TEAM-SETTINGS-06 · HIGH · MISSING — Commercial Truth's navy 'Single source' band is not built — its chip, sentence and three stats are scattered into the page header

- **Design:** 14-commercial-truth.html:7-13 — <div style="border-radius:16px;background:#0B1020;padding:16px 20px;display:flex;…"> holding a green pill 'Single source' with a 5px dot on rgba(14,159,110,0.16)/#34D399 (:8), the paragraph 'One target pack per workspace. Surfaces read it deterministically — nothing recomputed locally, nothing overridden per screen.' (:9) and the three {{ truthStats }} as white 13px values over 9px uppercase mono labels (:10-12).
- **Code:** app/(dashboard)/commercial-truth/legacy-page.tsx:141 meta={<WorkspacePill tone="info">Single source</WorkspacePill>} sits beside the h1; :143-151 actions={<SettingsStat label="Workspace"/><SettingsStat label="Currency"/><SettingsStat label="Timezone"/>} which components/settings/settings-section.tsx:111-124 renders as white bordered cards (bg var(--adc-s2)). grep for '0B1020|adv-rail' across the three Commercial Truth files returns nothing, and 'One target pack per workspace' appears nowhere in app/ or components/.
- **Fix:** Build the navy band as its own element between header and grid: #0B1020, radius 16, padding 16px 20px, green dotted 'Single source' pill, the design's sentence, and the three stats inline white-on-navy.

### TRUTH-TEAM-SETTINGS-07 · HIGH · WRONG — Commercial Truth section order is inverted — the target pack sits below the grid instead of first inside it

- **Design:** 14-commercial-truth.html:14-53 — the grid's left column is, in order, the 'Target pack' article (:16-35) then 'Where $100 of revenue goes' (:36-52); the right column is 'Consumed by' + 'Change history' (:54-81). Nothing sits between the grid's close (:82) and the scenario guide (:83).
- **Code:** app/(dashboard)/commercial-truth/legacy-page.tsx:156-174 — the grid's left column is <CommercialRevenueSplit/> alone (:157) and the right is Consumers + ChangeHistory (:171-172); the entire target-pack editor mounts after the grid closes, at :176 <CommercialTruthSettingsSection businessId={selectedBusinessId} />.
- **Fix:** Move the target-pack card into the grid's left column above 'Where $100 of revenue goes' so reading order is Target pack → revenue split, with Consumed by / Change history on the right.

### TRUTH-TEAM-SETTINGS-08 · HIGH · WRONG — Target pack is split into two cards with a different field set — AOV floor, Fixed costs / mo and Gross margin are absent

- **Design:** 14-commercial-truth.html:21-29 — one auto-fit(minmax(200px,1fr)) grid inside the single 'Target pack' article renders all eight {{ truthFields }} as label + h36 input + hint; data-model.js:1041-1047 names them Target ROAS, Breakeven ROAS, Gross margin ('After COGS'), AOV floor ('Flags low-value winners'), Shipping cost, Payment fees, CPA ceiling ('Validates Launchpad drafts'), Fixed costs / mo ('Feeds net profit + contribution').
- **Code:** components/settings/commercial-truth-settings.tsx:747-806 a separate 'Section 2 · Cost Structure' card holds Blended COGS / Shipping cost / Fulfillment cost / Payment processing; :1261-1382 a separate 'Section 4 · Target pack' card holds Target ROAS / Break-even ROAS / Target CPA / Break-even CPA. grep -i 'AOV|Fixed cost' over the whole 2606-line file returns zero matches; 'Fulfillment cost' (:781) and 'Break-even CPA' (:1366) have no design counterpart.
- **Fix:** Collapse both cards into one 'Target pack' article carrying the design's eight fields in order as label + h36 input + hint; add AOV floor and Fixed costs / mo, and fold or drop Fulfillment cost and Break-even CPA.

### TRUTH-TEAM-SETTINGS-09 · HIGH · WRONG — Scenario-guide table has six rows instead of seven — the Fixed costs row is missing, two captions renamed, and no row carries its mono sub-label

- **Design:** data-model.js:1112-1120 scRows in order: 'Ad-attributed revenue' (sub 'spend × ROAS'), 'Variable costs' (sub 'COGS 38% + shipping 8% + fees 3%'), 'Contribution before ads' (sub '51% of revenue'), 'Ad spend', 'Fixed costs' (sub 'from the pack · applies once per month'), 'Net profit / month' (rowBg #0B1020), 'Net margin' (sub 'net profit ÷ revenue'). 14-commercial-truth.html:121 renders {{ r.sub }} as a mono block under each label.
- **Code:** components/settings/commercial-truth-settings.tsx:905-934 rows = [Ad-attributed revenue, Variable costs, Gross profit, Ad spend, Net profit (highlight), Net margin] — no Fixed costs row, 'Contribution before ads' renamed 'Gross profit', 'Net profit / month' renamed 'Net profit'; the cell math at :884-893 computes netProfit = grossProfit − spend with no fixed base; :1046-1050 renders {r.label} only, with no sub-label element.
- **Fix:** Add the 'Fixed costs' row between 'Ad spend' and net profit and subtract it in the math, rename 'Gross profit' → 'Contribution before ads' and 'Net profit' → 'Net profit / month', and render each row's mono sub-label under the caption.

### TRUTH-TEAM-SETTINGS-10 · MEDIUM · EXTRA — Pack save controls live in a sticky bottom bar with different captions instead of inline in the Target pack card

- **Design:** 14-commercial-truth.html:30-34 — inside the Target pack article: <button …background:#2F6BFF>Save target pack</button>, <button …border:1px solid #E4E8F0>Discard changes</button>, then a mono span 'last updated Aug 2 by Emrah B.'. No sticky element exists in the fragment.
- **Code:** components/settings/commercial-truth-settings.tsx:2097 <div className="sticky bottom-0 z-10 mt-7 … border-t … backdrop-blur-sm"> with a dirty dot and 'Unsaved changes'/'All changes saved' (:2098-2105), a 'Discard' button (:2113) and 'Save Commercial Truth' (:2122); mounted at :2581.
- **Fix:** Delete StickySaveBar and place the two buttons inline at the bottom of the Target pack card, captioned 'Save target pack' and 'Discard changes', followed by the mono last-updated line.

### TRUTH-TEAM-SETTINGS-11 · MEDIUM · EXTRA — Target pack card carries a 'Reconfirm unchanged economics' button, an authority banner and its own confirm modal

- **Design:** 14-commercial-truth.html:16-35 — the Target pack article's only controls are the eight inputs and the Save/Discard buttons; the only provenance shown is the mono span 'last updated Aug 2 by Emrah B.' (:33). No banner, second button or dialog appears anywhere in the fragment.
- **Code:** components/settings/commercial-truth-settings.tsx:1266-1276 <CtGhostBtn … testId="commercial-target-pack-reconfirm">Reconfirm unchanged economics</CtGhostBtn> as the section action; :1385-1434 a tone-coloured banner reading 'Decision authority current' / 'Commercial target review is due' / 'Decision authority unavailable' plus 'Target confirmation time is unavailable or cutoff-unsafe; hard Scale/Cut authority remains withheld.'; :2591-2603 <ConfirmOverlay title="Reconfirm unchanged economics?">.
- **Fix:** Remove the reconfirm button, the authority banner and its confirm overlay from the Target pack card; the design's provenance is the single mono 'last updated … by …' line.

### TRUTH-TEAM-SETTINGS-12 · MEDIUM · EXTRA — Team ships a full workspace-access modal reached from the row ⋯; the design draws no menu and no modal

- **Design:** 16-team.html:49 — the row action is a single non-interactive span: <span title="Manage member" style="…width:26px;height:26px;border-radius:7px;border:1px solid #E4E8F0…">⋯</span>. The whole 105-line fragment contains no popover, no 'Workspace access', no checkbox list and no Cancel/Save dialog.
- **Code:** app/(dashboard)/team/legacy-page.tsx:522-559 an absolutely-positioned menu with 'Workspace access…', 'Make Operator/Analyst/Viewer' and 'Remove from workspace'; :700-814 a fixed-overlay modal titled 'Workspace access' (:709) with role chips (:726-740), a 'Select all'/'Deselect all' toggle (:749-761), a scrollable workspace checkbox list (:764-783) and 'Cancel' / 'Save access' buttons (:801, :809).
- **Fix:** Remove the workspace-access modal and trim the ⋯ affordance to the design's inert 'Manage member' control (or a minimal menu), so the row matches.

### TRUTH-TEAM-SETTINGS-13 · MEDIUM · EXTRA — Settings 'Change password' row expands into an inline two-field form the design never defines

- **Design:** 17-settings.html:20-26 — each settingsRow article is a flex row of title, detail and ONE button {{ s.btn }}; data-model.js:1233 gives that button the caption 'Update'. The article has no footer slot and no form.
- **Code:** app/(dashboard)/settings/legacy-page.tsx:751-784 footer={passwordOpen ? <div className="mt-[14px] border-t …"> with <Field label="Current password">, <Field label="New password">, an error paragraph and a 'Save password' button …}; :786-788 the row button flips its caption to 'Cancel' when open.
- **Fix:** Move password change off the row (dialog or dedicated route) so the row stays a single-line title/detail/'Update' article.

### TRUTH-TEAM-SETTINGS-14 · MEDIUM · EXTRA — Settings mounts confirmation overlays the design has no dialogs for

- **Design:** 17-settings.html — the Settings section ends at :28 </section>; the next element (:31) is the unrelated {{ cdOpen }} creative drawer. No dialog, overlay or confirm step belongs to this screen, and the 'Revoke others' row (data-model.js:1234) is a single button with no confirmation step.
- **Code:** app/(dashboard)/settings/legacy-page.tsx:843-851 <ConfirmOverlay title="Disconnect all integrations?">, :852-860 <ConfirmOverlay title="Delete this workspace?">, :861-870 <ConfirmOverlay title="Revoke all sessions?">.
- **Fix:** The disconnect and delete overlays go with their rows (see the seven-rows finding). Drop the revoke-sessions overlay too, or keep it as the only destructive guard and accept it as a deliberate deviation.

### TRUTH-TEAM-SETTINGS-15 · MEDIUM · EXTRA — Scenario table highlights a 'best' column in green; the design has no winning-column treatment

- **Design:** 14-commercial-truth.html:99-126 — every spend cell shares one style (bg #0B1020 with an rgba(255,255,255,0.1) input chip), every ROAS cell shares one style (#FBF3E1 with a #ffffff chip), and body-cell colour comes only from {{ c.fg }}, which data-model.js:1112-1120 sets per row, never per column. No max/best logic exists in the model.
- **Code:** components/settings/commercial-truth-settings.tsx:897-903 computes bestIdx by max netProfit; :966 "${i === bestIdx ? "bg-[var(--adc-pos-fg)]/20" : ""}" on the spend header cell; :1010-1013 "bg-[var(--adc-pos-fg)] text-[var(--adc-s2)]" on the best ROAS chip; :1057-1060 green tinting of every cell in the best column.
- **Fix:** Remove bestIdx and its conditional classes so all five columns render identically.

### TRUTH-TEAM-SETTINGS-16 · MEDIUM · EXTRA — Invite card grows a generated-links block with 'Copy invite link' buttons after sending

- **Design:** 16-team.html:15-24 — the Invite people article holds exactly the input, two selects, the 'Send invite' button and the one helper paragraph ending 'Invites expire after 7 days.' (:23). Nothing follows inside the article.
- **Code:** app/(dashboard)/team/legacy-page.tsx:407-424 — {generatedLinks.length > 0 ? <div className="mt-3 … border-t …"> … <button …>Copy invite link</button> … : null} appended inside the same article.
- **Fix:** Remove the generated-links list; the design's invite flow ends at the helper sentence.

### TRUTH-TEAM-SETTINGS-17 · MEDIUM · EXTRA — Every Commercial Truth card is wrapped in a 'Section N' eyebrow plus a tooltip button, and its heading is 17px instead of 15px

- **Design:** 14-commercial-truth.html:17-20, :37-40, :86-89, :133-136 — each card header is just an h2 (Space Grotesk 15px/600, colour #0E1526) plus a mono 10px sub-note (e.g. 'recalculates live from this pack’s economics'). There is no eyebrow line, no help icon, and no tooltip anywhere in the fragment.
- **Code:** components/settings/commercial-truth-settings.tsx:126-167 CtSection renders an eyebrow <p> at 12px/600/uppercase/tracking .14em (:145-149), an h2 at text-[17px] (:151-153), a <CtTooltip> next to the title (:154) and a 12.5px subtitle — and every mounted section passes eyebrow="Section 1"…"Section 8" plus a tooltip string (:606-609, :748-751, :938-941, :1261-1264).
- **Fix:** Drop the eyebrow and tooltip props from CtSection (or the component's eyebrow/tooltip slots entirely), and set the heading to 15px/600 with the design's mono sub-note beside it.

### TRUTH-TEAM-SETTINGS-18 · MEDIUM · EXTRA — Settings' identity card carries a 'Save profile' button; the design's field card has no button at all

- **Design:** 17-settings.html:6-11 — the field card article contains exactly four <label> children and closes at :11. It has no button, no error slot and no action row; the design's only buttons on this screen are the plan band's 'Upgrade to Pro' (:17) and one per settingsRow (:25).
- **Code:** app/(dashboard)/settings/legacy-page.tsx:617-626 — inside the first FieldCard, an error paragraph (:617-621) and <div className="flex justify-end sm:col-span-2"><RowButton onClick={handleAccountSave}>Save profile</RowButton></div>.
- **Fix:** Remove the 'Save profile' button (and its col-spanning row) from the identity card so the card matches the design's four-field grid; persist on change or move the action out of the card.

### TRUTH-TEAM-SETTINGS-19 · MEDIUM · GEOMETRY — Page title and eyebrow typography is far smaller than the design on all three screens

- **Design:** 14-commercial-truth.html:3-4, 16-team.html:4-5 and 17-settings.html:3-4 all pin eyebrow font-size:11px;letter-spacing:0.12em and h1 font-size:26px;font-weight:700;letter-spacing:-0.02em in Space Grotesk.
- **Code:** app/globals.css:901-907 .ad-workspace-eyebrow { font-size: 12px; font-weight: 500 } with letter-spacing:0 set at :899; app/globals.css:918-925 .ad-workspace-title-row h1 { font-size: 16px; font-weight: 600; letter-spacing: 0 }. All three pages route their header through components/workspace/workspace-surface.tsx:36-46.
- **Fix:** Set .ad-workspace-eyebrow to 11px / letter-spacing .12em and .ad-workspace-title-row h1 to 26px / 700 / letter-spacing -0.02em in the display face.

### TRUTH-TEAM-SETTINGS-20 · MEDIUM · MISSING — Both closing mono footnotes on Commercial Truth are absent

- **Design:** 14-commercial-truth.html:130 — 'Reads gross margin, shipping, fees and fixed costs from the pack — save the pack and every scenario re-anchors. Net profit needs ROAS × contribution margin to clear ad spend plus the fixed base.'; :192 — 'Preview only — verdicts stamp on the next snapshot after the pack is saved. Unlabeled spend ({{ truthUnlabeled }}) is excluded until it gets a label in Decisions.' Both are border-topped mono 10.5px #98A4BA paragraphs.
- **Code:** components/settings/commercial-truth-settings.tsx:1067-1069 the scenario CtSection closes straight after the body rows with no footer paragraph; components/settings/commercial-truth-blocks.tsx:389-394 the spend-bands article closes after the coverage note. grep for 'Preview only' and 'Reads gross margin' across app/ and components/ returns zero matches.
- **Fix:** Add both as border-topped mono lines (10.5px, var(--adv-ink-4)) at the foot of the scenario card and the spend-vs-targets card.

### TRUTH-TEAM-SETTINGS-21 · MEDIUM · MISSING — Pending-invite rows have no 'Resend' button

- **Design:** 16-team.html:88 — <button style="…height:27px;padding:0 10px;border-radius:7px;border:1px solid #E4E8F0;background:#ffffff;…color:#2F6BFF">Resend</button> immediately precedes the red Revoke button on every invite row.
- **Code:** app/(dashboard)/team/legacy-page.tsx:631-655 — the invite row renders one button only, 'Revoke' (:648-654). grep for 'Resend' in the file returns nothing.
- **Fix:** Add the blue 'Resend' button (h27, r7, 1px border, colour #2F6BFF) before Revoke on each pending-invite row.

### TRUTH-TEAM-SETTINGS-22 · MEDIUM · MISSING — Team seat meter is missing: no progress bar, truncated eyebrow, and 'used of allowance' replaced by a plain count

- **Design:** 16-team.html:9-12 — mono eyebrow 'Seats · Growth plan', value '4 of 5 used', and <div style="width:110px;height:8px;border-radius:9999px;background:#E4E8F0"><div style="height:100%;width:80%;…background:#2F6BFF"></div></div>.
- **Code:** app/(dashboard)/team/legacy-page.tsx:342-351 — meta renders 'Seats' (:345) and '{members.length} active' (:347-349) only. There is no bar element and no seat allowance anywhere in the file.
- **Fix:** Restore the eyebrow to 'Seats · {plan} plan', render '{used} of {allowance} used', and add the 110×8 rounded meter filled to used/allowance.

### TRUTH-TEAM-SETTINGS-23 · MEDIUM · WRONG — Team's role-capability matrix uses a different, shorter row set than the design's nine capabilities

- **Design:** 16-team.html:67 <sc-for list="{{ permRows }}">; data-model.js:1186-1196 lists nine rows in order: 'View dashboards & evidence' [✓✓✓—], 'Open share-link reports' [✓✓✓✓], 'Comment & annotate', 'Approve automation proposals', 'Launch drafts · provider writes', 'Edit Commercial Truth pack', 'Manage integrations', 'Invite & manage members', 'Billing & plan'.
- **Code:** app/(dashboard)/team/legacy-page.tsx:76-84 PERM_ROWS = seven rows — 'Read every dashboard' [true,true,true,true], 'Trigger provider writes (Launchpad, automation)', 'Invite and manage members', 'Edit workspace settings', 'Release the kill switch', 'Delete the workspace', 'Cannot be removed from the workspace'. No caption matches a design row, and row 1 grants Viewer full dashboard access where the design denies it.
- **Fix:** Replace PERM_ROWS with the design's nine captions in the design's order and tick pattern; where the backend genuinely cannot enforce a row, keep the caption and mark the cells honestly rather than inventing new rows.

### TRUTH-TEAM-SETTINGS-24 · MEDIUM · WRONG — Spend bands use different names, ranges and verdict wording than the design's four-band ROAS ladder

- **Design:** data-model.js:1065-1070 bandMeta (first four used at :1076): 'Above target' → 'Scale', 'Near target' → 'Hold', 'Above breakeven' → 'Watch / Trim', 'Below breakeven' → 'Cut', with ranges ROAS ≥ T, mid–T, Bv–mid (mid = max(Bv, T×0.85)), ROAS < Bv. 14-commercial-truth.html:142 renders '{{ b.n }} entities → <b>{{ b.verdict }}</b>'.
- **Code:** components/settings/commercial-truth-blocks.tsx:304-332 bands = [{name:'Above target', verdict:'scale candidates'}, {name:'Target to break-even', verdict:'holding, not scaling'}, {name:'Below break-even', verdict:'losing contribution'}, {name:'No return', range:'spend, zero revenue', verdict:'cut or diagnose'}]; :371 renders '{n} campaigns → verdict'.
- **Fix:** Restore the four design bands with their ranges (Above target / Near target / Above breakeven / Below breakeven) and the verdicts Scale / Hold / Watch / Trim / Cut.

### TRUTH-TEAM-SETTINGS-25 · MEDIUM · WRONG — Revenue-split bar has seven segments with renamed labels instead of the design's five

- **Design:** data-model.js:1123-1127 econSegs = COGS / Shipping / Fees / Ad spend / Contribution — five segments, rendered twice at 14-commercial-truth.html:42-49 (bar and legend) with hint-placeholder-count="5".
- **Code:** components/settings/commercial-truth-blocks.tsx:44-51 costs = ['COGS','Shipping','Fulfillment','Payment fees','Fixed costs','Ads'] and :72-78 appends {k:'Contribution'} — seven segments, with 'Fulfillment' and 'Fixed costs' having no design counterpart and 'Fees'→'Payment fees', 'Ad spend'→'Ads' renamed.
- **Fix:** Reduce the split to the design's five segments and restore the captions COGS / Shipping / Fees / Ad spend / Contribution.

### TRUTH-TEAM-SETTINGS-26 · MEDIUM · WRONG — 'Consumed by' rows drop the design's grey reads chip

- **Design:** 14-commercial-truth.html:63 — <span style="display:inline-flex;margin-top:6px;border-radius:6px;background:#F1F4F9;color:#45526B;padding:2px 8px;font-family:'IBM Plex Mono';font-size:10px">reads: {{ c.reads }}</span>.
- **Code:** components/settings/commercial-truth-blocks.tsx:182-184 renders <p className="m-0 mt-1 font-[…mono] text-[10px] text-[var(--adv-ink-4)]">reads: {consumer.reads}</p> — a bare paragraph with no background, radius or padding.
- **Fix:** Render the reads line as the design's chip: inline-flex, radius 6, bg #F1F4F9 (var(--adv-fill-2)), colour #45526B, padding 2px 8px, mono 10px. (The consumer names themselves — Google advisor, Launchpad — are the app's real reading surfaces and the omitted 'last read' timestamp is honest; leave both alone.)

### TRUTH-TEAM-SETTINGS-27 · LOW · GEOMETRY — Content max-widths are capped below the design on all three screens

- **Design:** 14-commercial-truth.html:1 max-width:1240px; 16-team.html:1 max-width:1240px; 17-settings.html:1 max-width:920px.
- **Code:** app/globals.css:864-885 — .ad-workspace-page max-width:1060px (Team uses this default; app/(dashboard)/team/legacy-page.tsx:339 passes no width), .ad-workspace-page-wide max-width:1120px (Commercial Truth, legacy-page.tsx:140 width="wide"), .ad-workspace-page-narrow max-width:900px (Settings, legacy-page.tsx:575 width="narrow"). The correct 1240/920 caps set by components/dashboard-v2/screen-root.ts:31-38 sit on the outer wrapper and are overridden by the inner cap.
- **Fix:** Raise the wide and default caps to 1240px and the narrow cap to 920px, or drop the inner .ad-workspace-page cap so screen-root's max-width governs.

### TRUTH-TEAM-SETTINGS-28 · LOW · GEOMETRY — Commercial Truth grid ratio and band-card accent border differ from the design

- **Design:** 14-commercial-truth.html:14 grid-template-columns:minmax(0,1.45fr) minmax(300px,1fr); :139 each band card is border:1px solid #EDF0F6;border-left:4px solid {{ b.tone }};background:#FBFCFE.
- **Code:** app/(dashboard)/commercial-truth/legacy-page.tsx:156 [grid-template-columns:minmax(0,1.35fr)_minmax(300px,1fr)]; components/settings/commercial-truth-blocks.tsx:356 className="rounded-xl border border-[var(--adv-hairline)] bg-[var(--adv-fill)] px-[13px] py-2.5" — no 4px tone-coloured left border.
- **Fix:** Set the first track to 1.45fr and give each band card a 4px left border in the band's tone colour.

### TRUTH-TEAM-SETTINGS-29 · LOW · GEOMETRY — Scenario table header and net-profit rows use accent blue where the design uses navy #0B1020

- **Design:** 14-commercial-truth.html:98 and :100 — the 'Spend / month' stub and every spend cell use background:#0B1020; data-model.js:1118 sets the 'Net profit / month' row rowBg:'#0B1020' with kFg '#ffffff'.
- **Code:** components/settings/commercial-truth-settings.tsx:955 className="grid bg-[var(--adv-accent)] text-[var(--adc-s2)]" for the spend header row; :1041 "${r.highlight ? "bg-[var(--adv-accent)]" : …}" for the net-profit row. app/globals.css:118 --adv-accent: #2f6bff (the button blue) while :122 --adv-rail: #0b1020 is the navy ground.
- **Fix:** Paint the spend header row and the net-profit row with var(--adv-rail) (#0B1020) instead of var(--adv-accent).

### TRUTH-TEAM-SETTINGS-30 · LOW · GEOMETRY — Team card headers lose their hairline and the table head type is 12px instead of 10px

- **Design:** 16-team.html:26, :57, :80, :94 — every card header carries border-bottom:1px solid #EDF0F6; :29-35 and :60-64 every <th> is font-size:10px;font-weight:500 in IBM Plex Mono with letter-spacing:0.1em.
- **Code:** app/(dashboard)/team/legacy-page.tsx:429, :573, :618, :661 — each header div is 'flex items-baseline gap-2 px-4 py-[13px]' (:661 'px-4 py-[13px]') with no border-b class; :86-87 const TH = "bg-[var(--adv-fill)] px-4 py-[9px] … text-[12px] font-medium uppercase tracking-[0.1em] …".
- **Fix:** Add border-b border-[var(--adv-hairline)] to the four card headers and set TH to text-[10px].

### TRUTH-TEAM-SETTINGS-31 · LOW · GEOMETRY — Team's card sub-captions and footers lose the mono face and their pinned sizes

- **Design:** 16-team.html:26 '4 active' is IBM Plex Mono 10.5px #98A4BA; :57 'enforced server-side on every call' is mono 10.5px; :80 the invite count is mono 10.5px; :101 'full audit trail lives in the Automation ledger' is mono 10px with border-top:1px solid #F3F5F9.
- **Code:** app/(dashboard)/team/legacy-page.tsx:433-435 <span className="text-[10.5px] text-[var(--adv-ink-4)]"> (no mono family); :577-579 same; :622-624 same; :691-693 <p className="m-0 px-4 py-2.5 text-[12px] text-[var(--adv-ink-4)]"> — 12px, non-mono, and with no border-t.
- **Fix:** Apply font-[family-name:var(--adv-font-mono)] to the three card sub-captions and render the audit-trail footer at 10px mono with a border-t hairline.

### TRUTH-TEAM-SETTINGS-32 · LOW · GEOMETRY — Section gap is 14px on every screen instead of the design's 16px (Commercial Truth, Team) and 12px (Settings)

- **Design:** 14-commercial-truth.html:1 and 16-team.html:1 both set gap:16px on the section; 17-settings.html:1 sets gap:12px.
- **Code:** components/dashboard-v2/screen-root.ts:31-45 sets the correct gap (16 / 12) — but only on the outer wrapper div; the real stack is the inner .ad-workspace-page, which app/globals.css:864-875 fixes at gap: 14px for every screen. Same override pattern as the max-width finding.
- **Fix:** Let the inner .ad-workspace-page inherit the per-screen gap (or drop its own gap) so 16px/12px reach the actual card stack.

### TRUTH-TEAM-SETTINGS-33 · LOW · MISSING — Target pack card has no mono revision note beside its heading and no inline 'last updated by' line

- **Design:** 14-commercial-truth.html:19 — mono span 'v4 · applies on the next snapshot, never retroactively' beside the 'Target pack' h2; :33 — mono span 'last updated Aug 2 by Emrah B.' beside the Save/Discard buttons.
- **Code:** components/settings/commercial-truth-settings.tsx:1259-1264 the CtSection for 'Target pack' passes only eyebrow/title/subtitle/tooltip; the subtitle is 'The efficiency anchors the engine uses for revenue and acquisition objectives. Empty fields remain unconfigured.' The pack timestamp exists only inside the extra freshness banner at :1405-1409 ('Last updated or confirmed: {date}'), with no actor.
- **Fix:** Add the mono appliance note beside the heading ('applies on the next snapshot, never retroactively') and a compact mono 'last updated {date} by {actor}' line next to the Save/Discard buttons. (The literal 'v4' and 'Aug 2 by Emrah B.' are seed data.)

### TRUTH-TEAM-SETTINGS-34 · LOW · WRONG — Scenario guide's ROAS stub label and reset-button caption differ from the design

- **Design:** 14-commercial-truth.html:109 — the amber stub cell reads 'ROAS' with the mono sub-line 'edit per column · defaults to target'; data-model.js:1122 scResetLabel = 'Reset ROAS to target ' + T.toFixed(2) + '×'.
- **Code:** components/settings/commercial-truth-settings.tsx:995-1000 renders 'Target ROAS' with the sub-line 'edit per column'; :941-945 <CtGhostBtn onClick={resetRoas}>Reset ROAS to {targetRoas.toFixed(2)}x</CtGhostBtn> — 'target' dropped, Latin 'x' for the design's '×'.
- **Fix:** Set the stub cell to 'ROAS' / 'edit per column · defaults to target' and the button to 'Reset ROAS to target {n}×'.

### TRUTH-TEAM-SETTINGS-35 · LOW · WRONG — Commercial Truth lede's second sentence is rewritten

- **Design:** 14-commercial-truth.html:5 — 'The single economic ground truth every decision surface reads. Meta Decisions, Creative Studio and Automation guardrails anchor to these numbers deterministically.'
- **Code:** app/(dashboard)/commercial-truth/legacy-page.tsx:139 description="The single economic ground truth every decision surface reads. Meta Decisions, Creative Studio and the Google advisor all resolve their thresholds from this pack."
- **Fix:** Restore the design's second sentence verbatim (the app does have an Automation surface, so nothing forces the substitution).

### TRUTH-TEAM-SETTINGS-36 · LOW · WRONG — Spend-share coverage note drops the design's window token and coverage percentage

- **Design:** 14-commercial-truth.html:152 — 'share of labeled ad spend · 28d · {{ truthCoverage }}', where data-model.js:1099 makes truthCoverage 'labeled coverage {n}% — the rest is unlabeled'.
- **Code:** components/settings/commercial-truth-blocks.tsx:389-391 renders 'share of labeled ad spend · {coverageNote}', and app/(dashboard)/commercial-truth/legacy-page.tsx:183 passes coverageNote as "${n} campaigns with spend". The '· 28d ·' segment and the labeled-coverage percentage are gone.
- **Fix:** Render 'share of labeled ad spend · 28d · labeled coverage {n}% — the rest is unlabeled'.

### TRUTH-TEAM-SETTINGS-37 · LOW · WRONG — Settings 'Resync warehouse' detail loses the design's reassurance clause

- **Design:** data-model.js:1235 — { k: 'Resync warehouse', d: 'Rebuild read models from provider data. Safe, may take minutes.', btn: 'Run resync' }.
- **Code:** app/(dashboard)/settings/legacy-page.tsx:293 setSnapshotNote("Rebuild read models from provider data. ${parts.join(" · ")}.") — 'Safe, may take minutes.' is dropped and a provider-status tail appended; the row consumes snapshotNote at :798.
- **Fix:** Keep 'Rebuild read models from provider data. Safe, may take minutes.' as the detail and surface provider status elsewhere.

### TRUTH-TEAM-SETTINGS-38 · LOW · WRONG — Team invite placeholder differs from the design

- **Design:** 16-team.html:18 — <input placeholder="teammate@company.com" …>.
- **Code:** app/(dashboard)/team/legacy-page.tsx:372 placeholder="name@company.com".
- **Fix:** Change the placeholder to 'teammate@company.com'.

### TRUTH-TEAM-SETTINGS-39 · LOW · WRONG — Revenue-split mono sub-note is truncated

- **Design:** 14-commercial-truth.html:39 — <span …>derived from this pack · 28d blended pace</span> beside the 'Where $100 of revenue goes' heading.
- **Code:** components/settings/commercial-truth-blocks.tsx:60 and :86 — <span className={SUB}>derived from this pack</span> in both the empty and populated branches; '28d blended pace' appears nowhere in the file.
- **Fix:** Restore the full sub-note 'derived from this pack · 28d blended pace'.

---

## Creative evidence window + Copy detail drawer

### DRAWERS-01 · HIGH · EXTRA — Decision Center evidence drawer adds a 4-tile Spend / ROAS / Purchases / ROAS·7d metric grid the design never had

- **Design:** 18-creative-evidence-window.html L11-86 scanned end to end: there is no stat-tile grid anywhere. The design's only money statement is the single line inside the Decision contract card, L23 "{{ cd.money }} <span …>{{ cd.moneySub }}</span>" at 17px/700.
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1446-1464 builds "const metrics = [["Spend", …], ["ROAS", …], ["Purchases", …], ["ROAS · 7d", …]]", rendered at :1519-1526 as "<section className={styles.drawerMetrics}>"; MetaPlatformPage.module.css:939-949 ".drawerMetrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); … }" — a boxed 2×2 tile grid.
- **Fix:** Remove the tile grid and fold the money statement into the Decision contract card as the design's single 17px/700 line plus its 11.5px sub-line.

### DRAWERS-02 · HIGH · EXTRA — Studio evidence drawer appends a whole exact-ad-usage list the design never had

- **Design:** 18-creative-evidence-window.html L11-86 read end to end: after the key/value grid (L78-85) the only remaining body element is the provenance line (L86). There is no ad list, no per-ad rows, no campaign/ad-set rows anywhere in the fragment.
- **Code:** components/creatives/StudioOsView.tsx:3463-3495 — "usageRows.map((usage) => (<div className="studio-usage-row" …>" rendering campaign name, effective-status chip, "{usage.adSetName} › {usage.name}", "Ad {usage.realAdId}", optimization goal, bid strategy, plus a 3-metric grid per row (:3485-3492).
- **Fix:** Remove the ad-grain usage list from the evidence window; the design's body ends at the provenance line. If ad-grain usage must stay reachable, give it its own surface.

### DRAWERS-03 · HIGH · MISSING — "Where it runs" ad-set card and its footnote are absent from both evidence drawers

- **Design:** 18-creative-evidence-window.html L66-76: eyebrow "Where it runs", "<sc-for list="{{ cd.audiences }}" as="au">" rows of "{{ au.k }}" / "{{ au.spend }}" / a ROAS pill "{{ au.roas }}", closing on L75 "ROAS per ad set · same 28d window" (data-model.js:437 Prospecting — Broad US / Retargeting 14d).
- **Code:** components/creatives/StudioOsView.tsx:3418-3420 goes straight from the funnel card to the evidence key/value grid; components/meta/redesign/MetaPlatformPage.tsx:1526-1527 goes from the metric tiles to "Evidence context". Neither file contains the string "Where it runs" (the only repo hit is components/creatives/CreativeInsightsDrawer.tsx:138, which has no render site).
- **Fix:** Add the Where it runs card as the right cell of the 2-col grid — one row per ad set (name, spend, ROAS pill) plus the literal footnote "ROAS per ad set · same 28d window". The Studio drawer already fetches ad-set names, spend and ROAS for its usage list, so the material exists.

### DRAWERS-04 · HIGH · MISSING — "Placement mix" card is absent from both evidence drawers

- **Design:** 18-creative-evidence-window.html L57-65: eyebrow "Placement mix", "<sc-for list="{{ cd.placements }}" as="pl">" rendering "{{ pl.k }}" and "{{ pl.share }} · ROAS {{ pl.roas }}" over an 8px bar "background:#2F6BFF" (data-model.js:436 Feed/Reels/Stories).
- **Code:** No hit for "Placement mix" anywhere in the repo. StudioOsView.tsx drawer body :3340-3527 and MetaPlatformPage.tsx drawer body :1502-1601 contain no placement breakdown of any kind.
- **Fix:** Add the Placement mix card as the left cell of the 2-col grid, fed by the Meta publisher-platform/position breakdown (share + ROAS per placement), rendering an em-dash row when the account returns no breakdown.

### DRAWERS-05 · HIGH · MISSING — Creative preview panel and confidence band pill are missing from the Decision Center evidence drawer

- **Design:** 18-creative-evidence-window.html L11-19: a full-width card ("border-radius:14px;border:1px solid #E4E8F0") whose top is a "height:148px" preview block and whose footer row carries "{{ cd.kind }}" on the left and the pill "{{ cd.band }}" on the right (data-model.js:430 band = 'High confidence').
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1502 "<div className={styles.creativeDrawerBody}>" opens directly onto :1504 "<span className={styles.sectionEyebrow}>Decision contract</span>" — no image, no preview surface, no pill. The confidence value is instead flattened to a text line at :1509-1512 "{Math.round(decision.sourceDecision.confidence)}% · {decision.sourceDecision.confidenceBand}".
- **Fix:** Open the drawer body with the design's preview card: the served asset at 148px (the codebase already has CreativeRenderSurface for this), the kind line, and the confidence band as a pill on the right of the footer row.

### DRAWERS-06 · HIGH · WRONG — The design's single evidence window exists twice in the app, and the drawer on the design's own trigger is a different composition

- **Design:** 18-creative-evidence-window.html L1 "data-screen-label="Creative evidence window"". Its only trigger is 01-meta-decision-center.html L190 "<article onClick="{{ r.open }}">" ending in L209 "Evidence →" (open: openCd('c3'|'c4'|'c1'), data-model.js:410,421-423). I grepped the whole design set: cdOpen/openCd/closeCd appear only in data-model.js and the 18/17 wrapper — no Creative Studio surface opens an evidence drawer (02-creative-studio.html L117 the assets row onClick is "r.toggle", the pin toggle, and L180 the copies row onClick is "r.open" → copyOpen).
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1430 "function MetaCreativeEvidenceDrawer({", mounted at :4175, opened from the decision card's :1424 "Evidence <ArrowRight size={12} …>" — the design's own trigger, but its body (:1502-1601) has no preview, no engine-reasoning card, no sparklines, no funnel, no placement mix, no where-it-runs, no provenance line. A second, differently-composed drawer carrying the design's captions lives at components/creatives/StudioOsView.tsx:3165 "function renderUsageDrawer(row: MetaCreativeRow)" and opens from a per-row button in the Studio assets table at :2460-2463 "onClick={() => void openUsageDrawer(row)}" titled "Open exact ad usage performance" — a trigger the design does not have.
- **Fix:** Collapse to one Creative evidence window behind the Decision Center's "Evidence →". Give it the design's composition and retire the Studio-table drawer (or demote it to a non-evidence surface) rather than maintaining two divergent evidence drawers.

### DRAWERS-07 · HIGH · WRONG — Decision Center drawer replaces the design's key/value evidence grid with a 7-row engine-plumbing list under an eyebrow the design does not have

- **Design:** 18-creative-evidence-window.html L78-85: the key/value card is "padding:4px 14px;display:grid;grid-template-columns:1fr 1fr;column-gap:20px" with NO heading element before the "<sc-for list="{{ cd.evidence }}">", and its keys are creative-fatigue facts (data-model.js:438/452/466: Frequency, First-time reach, Thumbstop, Hold 15s, the decision-specific fifth row, First seen).
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1527-1575 — "<span className={styles.sectionEyebrow}>Evidence context</span>" followed by a "<dl className={styles.drawerFacts}>" of Ad ID, Creative group, Truth source, Target ROAS, Lifecycle role, Generated, Risk. Seven rows, none of which the design defines, plus a heading the design has not.
- **Fix:** Drop the "Evidence context" eyebrow and render the design's six creative-evidence keys in the design's order, em-dashing any the provider does not serve.

### DRAWERS-08 · HIGH · WRONG — Studio evidence drawer ships the wrong six keys in the evidence key/value grid

- **Design:** 18-creative-evidence-window.html L78-85 renders "{{ cd.evidence }}"; data-model.js:438/452/466 fix the key set and order to Frequency, First-time reach, Thumbstop, Hold 15s, (Fatigue confirmed | Better variants live | Days above target), First seen.
- **Code:** components/creatives/StudioOsView.tsx:3186-3197 "const evidencePairs = … [{ k: "CPM" }, { k: "CPC · link" }, { k: "CTR · link" }, { k: "CPA" }, { k: "Frequency" }, { k: "Thumbstop" }]" — four of six are unit-economics fields the design never lists, and First-time reach / Hold 15s / First seen are absent.
- **Fix:** Replace the pair list with the design's six keys in the design's order, em-dashing the ones the provider does not serve (which is honest; substituting different metrics is not).

### DRAWERS-09 · HIGH · WRONG — Decision Center evidence drawer footer has the wrong buttons, and renders empty when the creative link is missing

- **Design:** 18-creative-evidence-window.html L88-92 pins three footer buttons: "{{ cd.btn }}" at "flex:1;height:38px;background:{{ cd.btnBg }}" (data-model.js:439/453/467 = "Rebuild in Launchpad" | "Pause ad" | "Duplicate into draft"), then "Compare in Studio" (L90), then "Ads Manager ↗" (L91).
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1602-1635 — only two anchors, both hard-captioned (:1620 "Open in Launchpad", :1631 "Open Creative Studio"), both inside "{decision.parentChain.creative ? (" at :1603 so the whole footer is empty without a creative link, and there is no "Ads Manager ↗" control at all.
- **Fix:** Make the primary carry the server decision's own action caption in its tone colour, rename the second to "Compare in Studio", and add the third "Ads Manager ↗" provider link (StudioOsView already imports buildMetaAdsManagerUrl for exactly this).

### DRAWERS-10 · HIGH · WRONG — Decision Center evidence drawer header is not the design's band: wrong eyebrow, no navy ground, decision chip not in the header

- **Design:** 18-creative-evidence-window.html L2-8: header "padding:14px 18px;background:#0B1020", eyebrow "Creative evidence · Meta" (mono 9.5px, #8B93A7), title "{{ cd.name }}" at 16px/600 #ffffff, and the decision chip "{{ cd.label }}" in the header at "border-radius:7px;padding:4px 11px;font-size:12px;font-weight:700".
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1479 "<span>Ad evidence</span>" — not the design's eyebrow; MetaPlatformPage.module.css:881-888 ".creativeDrawerHeader { display:flex; … border-bottom: 1px solid var(--adc-b1); padding: 14px 16px; }" declares no background, so the band is not navy; and the decision chip appears only in the body at :1506 "<span className="chip chip--info">{decision.classification.buyerLabel}</span>". (StudioOsView.tsx:3249-3275 does build the design's band correctly — the two drawers disagree.)
- **Fix:** Rebuild the header as the #0B1020 band with the eyebrow "Creative evidence · Meta", the name at 16px/600 white, and the decision label chip on the right of the header row.

### DRAWERS-11 · MEDIUM · EXTRA — Studio evidence drawer adds a "Trends (7 / 28 / 90d)" accordion the design never had

- **Design:** 18-creative-evidence-window.html contains no collapsible control anywhere; every body block (L11-86) is always-open. The design's trend affordance is the inline sparkline pair at L31-42.
- **Code:** components/creatives/StudioOsView.tsx:3497-3520 "<button type="button" onClick={() => setDrawerTrends((prev) => !prev)}" captioned "Trends (7 / 28 / 90d)" with a "▾/▸" glyph and the trailing label "collapsed by default"; :3521-3525 renders the expanded note.
- **Fix:** Remove the accordion; add the design's always-visible CTR/Frequency sparkline pair instead.

### DRAWERS-12 · MEDIUM · EXTRA — Studio evidence drawer adds a breadcrumb row and an ad-grain disclosure paragraph the design never had

- **Design:** 18-creative-evidence-window.html L43-86 — between the funnel card and the provenance line the design has only the placement/where-it-runs grid and the key/value grid. No breadcrumb, no explanatory paragraph.
- **Code:** components/creatives/StudioOsView.tsx:3434-3441 renders "{account?.name ?? "Account"}" › "Exact ad usages" with the date range, and :3443-3446 the paragraph "Rows below are provider ad-grain performance for this account and window. The badge above remains the server's creative-level decision; Studio does not copy that action onto every ad usage."
- **Fix:** Delete both, together with the ad-usage list they introduce.

### DRAWERS-13 · MEDIUM · EXTRA — Studio evidence drawer inserts a Usage / Ad-grain spend / Weighted ROAS strip between the header and the body

- **Design:** 18-creative-evidence-window.html L9-11: the navy header closes and the scroll body opens directly onto the preview card "<div style="border-radius:14px;overflow:hidden;border:1px solid #E4E8F0…">". Nothing sits between them.
- **Code:** components/creatives/StudioOsView.tsx:3298-3338 — a "flex: "none"" block outside the scroll area holding a 48×58 thumb and three inline stats: :3317 "Usage", :3321 "Ad-grain spend", :3333 "Weighted ROAS".
- **Fix:** Replace this strip with the design's 148px preview card carrying the kind line and the confidence pill.

### DRAWERS-14 · MEDIUM · EXTRA — Decision Center evidence drawer adds a "Signals" badge section the design never had

- **Design:** 18-creative-evidence-window.html body inventory L11-86: preview card, decision contract, engine reasoning, sparkline pair, funnel, placement/where-it-runs grid, key/value grid, provenance line. No badge or signal section exists.
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1576-1585 "{decision.sourceDecision.badges.length > 0 ? (<section><span className={styles.sectionEyebrow}>Signals</span> … badges.map(…)".
- **Fix:** Remove the Signals section, or carry its content as the design's own evidence keys.

### DRAWERS-15 · MEDIUM · EXTRA — Decision Center evidence drawer adds a "Blockers" section the design never had

- **Design:** 18-creative-evidence-window.html L11-86 — no blocker list. The design's only qualifiers on the verdict are the confidence pill on the preview card (L17) and "{{ cd.verdictSub }}" on the verdict line (L22).
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1586-1595 "{decision.classification.blockers.length > 0 ? (<section><span className={styles.sectionEyebrow}>Blockers</span> … blockers.map((blocker) => (<p key={blocker.code}>{blocker.label}</p>))".
- **Fix:** Fold the blocker text into the design's verdict sub-line (L22's "cd.verdictSub" slot) rather than keeping a section the design does not define — do not simply delete authority-gate information from view.

### DRAWERS-16 · MEDIUM · EXTRA — Decision Center evidence drawer header adds a third line of engine plumbing

- **Design:** 18-creative-evidence-window.html L3-6: the header's text column holds exactly two lines — the eyebrow (L4) and the title (L5).
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1485-1491 "<p>{decision.identityGrain === "ad" ? "Native Ad" : "Legacy creative"} engine · {decision.sourceDecision.engineVersion} · {decision.providerAccountId}</p>".
- **Fix:** Remove the third header line; if the engine version must be surfaced, it belongs in the provenance line at the foot of the body.

### DRAWERS-17 · MEDIUM · GEOMETRY — Decision Center evidence drawer is 520px with a border and no shadow; the design pins 560px, no border, a 70px shadow, and the canvas colour

- **Design:** 18-creative-evidence-window.html L1: "width:560px;max-width:94vw;height:100%;background:#F3F5F9;box-shadow:-28px 0 70px rgba(11,16,32,0.35)" — and no border property.
- **Code:** components/meta/redesign/MetaPlatformPage.module.css:869-879 ".creativeDrawer { position:absolute; … width: min(520px, 94vw); … border-left: 1px solid var(--adc-b1); background: var(--adc-s2); }" — 520 not 560, a hairline border the design does not have, no box-shadow, and the surface token instead of the #F3F5F9 canvas. (StudioOsView.tsx:3238-3241 gets width 560 and the exact shadow right — the two drawers disagree.)
- **Fix:** Set "width: min(560px, 94vw)", drop the border-left, add "box-shadow: -28px 0 70px rgba(11,16,32,0.35)", and paint the aside with the canvas colour so the inner blocks read as white cards.

### DRAWERS-18 · MEDIUM · MISSING — "Engine reasoning" card is missing from the Decision Center evidence drawer

- **Design:** 18-creative-evidence-window.html L25-30: its own white card with eyebrow "Engine reasoning" and one 4px tone-dotted bullet per entry of "{{ cd.reasons }}".
- **Code:** components/meta/redesign/MetaPlatformPage.tsx:1514-1517 folds the reasoning into a bare paragraph inside the Decision contract section: "<p>{decision.sourceDecision.reason || "No server reason was provided."}</p>". There is no separate card and no bullet. (StudioOsView.tsx:3368-3383 does render the design's card from "decision.reasons".)
- **Fix:** Give the Decision Center drawer the design's own "Engine reasoning" card below the contract card. lib/meta/decisions-workspace-contract.ts:281 serves a single "reason: string", so render one tone-dotted bullet from it — do not split a sentence into fake plural bullets.

### DRAWERS-19 · MEDIUM · MISSING — "Click-to-purchase funnel" card is missing from the Decision Center evidence drawer

- **Design:** 18-creative-evidence-window.html L43-55: card with eyebrow "Click-to-purchase funnel · 28d" and four bar rows over "{{ cd.funnel }}" (label 84px, bar, 52px value, 66px mono sub).
- **Code:** components/meta/redesign/MetaPlatformPage.tsx drawer body :1502-1601 contains nothing funnel-shaped; the closest thing is the 4-tile metric grid at :1519-1526.
- **Fix:** Add the design's funnel card. lib/meta/decisions-workspace-contract.ts:333-343 currently exposes only spend/purchases/roas on "metrics", so the impression/click/ATC counts need plumbing through — drop steps the account does not report rather than showing zeros.

### DRAWERS-20 · MEDIUM · MISSING — CTR · 28d and Frequency · 28d sparkline pair is absent from both evidence drawers

- **Design:** 18-creative-evidence-window.html L31-42: a "grid-template-columns:1fr 1fr" pair — "CTR · 28d" with "<path d="{{ cd.ctrPath }}" stroke="{{ cd.headBg }}">" + "{{ cd.ctrNote }}", and "Frequency · 28d" with "<path d="{{ cd.freqPath }}" stroke="#E11D48">" + "{{ cd.freqNote }}".
- **Code:** components/creatives/StudioOsView.tsx:3383-3385 — the Engine reasoning card is immediately followed by the funnel guard "{funnelSteps.length > 0 && funnelTop > 0 ? ("; no svg sits between them. components/meta/redesign/MetaPlatformPage.tsx:1502-1601 contains no "<svg>" at all.
- **Fix:** Insert the two-up sparkline grid between Engine reasoning and the funnel, each with its trailing note. MetaPlatformPage.tsx:462 already maps a "sparkline" from "roas_history", so a series exists; render the card with an em-dash note for any series (CTR, frequency) the provider does not return rather than interpolating.

### DRAWERS-21 · MEDIUM · MISSING — Centred provenance line is missing from both evidence drawers

- **Design:** 18-creative-evidence-window.html L86: "<p style="margin:0;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:10px;color:#98A4BA">{{ cd.prov }}</p>" — the last element of the scroll body (data-model.js:439 = 'provenance: snapshot 2026-08-14 · rec 4c1b…9e · raw JSON ↓').
- **Code:** components/creatives/StudioOsView.tsx:3527 closes the scroll body straight into the footer at :3531 — no provenance element of any kind. components/meta/redesign/MetaPlatformPage.tsx:1596-1600 has a left-aligned "contractNote" block carrying decision id, episode id, response attribution and provider-write linkage instead.
- **Fix:** End the scroll body with the design's centred mono 10px provenance line (snapshot as-of · decision/rec id · raw JSON link). The engine already serves "snapshotAsOf" and "decisionId".

### DRAWERS-22 · MEDIUM · WRONG — Studio evidence drawer's funnel has a fifth step the design does not define

- **Design:** 18-creative-evidence-window.html L46 iterates "{{ cd.funnel }}"; data-model.js:435/449/463 fix it to exactly four steps in order: Impressions, Clicks, Add to cart, Purchases.
- **Code:** components/creatives/StudioOsView.tsx:3176-3183 "[{ k: "Impressions" }, { k: "Link clicks" }, { k: "Add to cart" }, { k: "Checkout" }, { k: "Purchases" }]" — an extra "Checkout" step.
- **Fix:** Drop the Checkout step to match the design's four. (Keep the label "Link clicks": it is the precise name of the served metric, so the rename is honest and should not be reverted to "Clicks".)

### DRAWERS-23 · MEDIUM · WRONG — Studio evidence drawer's primary footer button is "Take to Decisions" instead of the decision's own action

- **Design:** 18-creative-evidence-window.html L89: "<button style="flex:1;height:38px;…background:{{ cd.btnBg }}">{{ cd.btn }}</button>" — data-model.js:439/453/467 give the captions "Rebuild in Launchpad", "Pause ad", "Duplicate into draft"; the button is the action, not a navigation.
- **Code:** components/creatives/StudioOsView.tsx:3532-3550 — a "<Link href={studioHref("/platforms/meta/decisions")}>" captioned "{label ? \"Take to Decisions · ${label}\" : "Take to Decisions"}", i.e. a jump to the Decisions list.
- **Fix:** Caption the primary with the server decision's own action and route it to that action's destination (Launchpad rebuild / pause confirmation / duplicate draft), not to the Decisions index.

### DRAWERS-24 · MEDIUM · WRONG — Copy drawer ships the wrong four stat tiles, in the wrong order

- **Design:** 19-copy-detail-drawer.html L15-23 renders "{{ co.stats }}" in a "repeat(4,1fr)" grid; data-model.js:267-271 fixes them to See more, CTR, Engage, ROAS with subs "acct median 11.4%" / "median 1.34%" / "median 1.2%" / "target 3.80".
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:799-814 "const stats = [{ k: "Spend" …}, { k: "ROAS" …}, { k: "CPA" …}, { k: "Link CTR" …}]" — Spend and CPA are tiles the design never defines, See more and Engage are absent, and ROAS moves from position 4 to position 2.
- **Fix:** Render the design's four tiles in order. app/(dashboard)/platforms/meta/copies/page-support.ts has no see-more or engagement field, so those two tiles should show an em-dash with their benchmark sub-line until the metric is served — substituting Spend and CPA silently changes what the card is.

### DRAWERS-25 · MEDIUM · WRONG — Copy drawer's angle chip duplicates the asset type already printed in the eyebrow

- **Design:** 19-copy-detail-drawer.html L13: "<span style="…background:{{ co.aBg }};color:{{ co.aFg }}">{{ co.angle }}</span>" — the messaging angle in its own tone colours (data-model.js:210 angleTone: UGC voice | Social proof | Problem → solution | Discount & urgency), deliberately distinct from the eyebrow's "co.kind" at L4.
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:944-957 renders "{kind}" in that chip slot with a neutral fill ("background: "var(--adv-fill-2)", color: "var(--adv-ink-2)""), where "kind = dash(row.copyAssetType)" (:797) — the same value already printed in the eyebrow at :873. The row carries "copyAngle" (page-support.ts:20,153) and it is never read here.
- **Fix:** Bind the chip to "row.copyAngle" with the angle tone palette. page-support.ts:153 documents the field as null until the engine's angle tagging ships, so an em-dash chip is the honest render — duplicating the asset type is not.

### DRAWERS-26 · MEDIUM · WRONG — Decision Center drawer body is a flat divider-separated section list; the design's body is a stack of discrete white cards on the canvas

- **Design:** 18-creative-evidence-window.html L10 sets the scroll body to "padding:16px 18px;display:flex;flex-direction:column;gap:12px", and every block inside it (L11, L20, L25, L32, L37, L43, L57, L66, L78) opens as its own card: "border-radius:12-14px;background:#ffffff;border:1px solid #E4E8F0". There are no dividers anywhere in the fragment.
- **Code:** components/meta/redesign/MetaPlatformPage.module.css:910-915 ".creativeDrawerBody { min-height:0; flex:1 1 auto; overflow-y:auto; padding: 14px 16px; }" with :917-921 ".creativeDrawerBody section { border-bottom: 1px solid var(--adc-b1); padding: 0 0 14px; margin-bottom: 14px; }" — no border-radius, no background, no card border, and hairline separators instead of the design's 12px gaps between white cards.
- **Fix:** Give the body "display:flex; flex-direction:column; gap:12px" and turn each section into a white card (radius 12-14, 1px hairline border) over the #F3F5F9 canvas, dropping the section border-bottoms.

### DRAWERS-27 · LOW · EXTRA — Studio evidence drawer adds a "Next step:" line to the Decision contract card

- **Design:** 18-creative-evidence-window.html L20-24 — the Decision contract card holds exactly three elements: the eyebrow (L21), the verdict paragraph (L22), the money line (L23).
- **Code:** components/creatives/StudioOsView.tsx:3360-3364 "{decision.nextStep ? (<p style={{ margin: "8px 0 0", fontSize: "12px", color: "var(--ink3)" }}>Next step: {decision.nextStep}</p>) : null}".
- **Fix:** Remove the paragraph; the design carries that intent in "cd.verdictSub", already rendered on the verdict line at :3346-3349.

### DRAWERS-28 · LOW · GEOMETRY — Both evidence drawers set the header eyebrow to 12px; the design pins 9.5px

- **Design:** 18-creative-evidence-window.html L4: "font-family:'IBM Plex Mono',monospace;font-size:9.5px;text-transform:uppercase;letter-spacing:0.1em;color:#8B93A7".
- **Code:** components/creatives/StudioOsView.tsx:3251 "style={{ margin: 0, fontSize: "12px", textTransform: "uppercase", letterSpacing: ".1em", color: "#8B93A7" }}" — 12px and no mono family. components/meta/redesign/MetaPlatformPage.module.css:890-896 ".creativeDrawerHeader span, .sectionEyebrow { … font-family: var(--font-ibm-plex-mono)…; font-size: 12px; }" — mono is present here, only the size is wrong.
- **Fix:** Set the drawer header eyebrow to 9.5px in both, and add the IBM Plex Mono stack to StudioOsView's.

### DRAWERS-29 · LOW · GEOMETRY — Decision Center evidence drawer backdrop is far lighter than the design's, on a different hue

- **Design:** The wrapper the fragment opens inside (identical in 17-settings.html L32, which carries the same overlay): "position:fixed;inset:0;z-index:80;background:rgba(11,16,32,0.46)".
- **Code:** components/meta/redesign/MetaPlatformPage.module.css:861-867 ".creativeDrawerBackdrop { position:absolute; inset:0; border:0; background: rgba(24, 26, 29, 0.24); … }".
- **Fix:** Set the backdrop to rgba(11,16,32,0.46). (The copy drawer already does this correctly at copies/legacy-page.tsx:835.)

### DRAWERS-30 · LOW · GEOMETRY — Studio drawer's Decision contract card lacks the design's 4px tone edge, and the copy drawer's Read card lacks its 3px edge

- **Design:** 18-creative-evidence-window.html L20: "border-left:4px solid {{ cd.headBg }}" on the Decision contract card. 19-copy-detail-drawer.html L25: "border-left:3px solid {{ co.edge }}" on the Read card.
- **Code:** components/creatives/StudioOsView.tsx:3344 "style={{ borderRadius: 12, background: "var(--s2)", border: "1px solid var(--b1)", padding: "12px 14px" }}" — uniform border only. app/(dashboard)/platforms/meta/copies/legacy-page.tsx:983-989 "{ borderRadius: 12, background: "var(--adv-surface)", border: "1px solid var(--adv-border)", padding: "12px 14px" }" — same, no left edge.
- **Fix:** Add a 4px tone left border to the Decision contract card and a 3px ROAS-tone left border to the copy drawer's Read card.

### DRAWERS-31 · LOW · GEOMETRY — Studio drawer's funnel value column and evidence-grid gutter use different pixel values than the design

- **Design:** 18-creative-evidence-window.html L50: the funnel value span is "width:52px". L78: the key/value card is "grid-template-columns:1fr 1fr;column-gap:20px".
- **Code:** components/creatives/StudioOsView.tsx:3407 "style={{ width: 62, textAlign: "right", … }}" for the funnel value; :3421 "gridTemplateColumns: "1fr 1fr", columnGap: 14" for the evidence grid.
- **Fix:** Set the funnel value column to 52px and the evidence grid column-gap to 20px.

### DRAWERS-32 · LOW · GEOMETRY — Copy drawer stat values are hard-coded to one ink colour, losing the design's ROAS tone

- **Design:** 19-copy-detail-drawer.html L19: "<p style="…font-size:16px;font-weight:700;…color:{{ s.fg }}">{{ s.v }}</p>", and data-model.js:271 sets the ROAS tile's fg to "coSel.rFg" — the row's ROAS band colour, not the default ink.
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:974 "<p className="tabular-nums" style={{ margin: "3px 0 0", fontSize: 16, fontWeight: 700, color: "var(--adv-ink)" }}>" — every tile, ROAS included, painted with the same neutral ink.
- **Fix:** Carry a per-stat foreground colour and tone the ROAS tile with the row's ROAS band colour (the row already computes a ROAS tone elsewhere in this file).

### DRAWERS-33 · LOW · GEOMETRY — Copy drawer stat sub-lines drop the mono face the design pins

- **Design:** 19-copy-detail-drawer.html L20: "<p style="margin:2px 0 0;font-family:'IBM Plex Mono',monospace;font-size:9px;color:#98A4BA">{{ s.sub }}</p>" — the tile's third line is mono, matching its label on L18.
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:977 "<p style={{ margin: "2px 0 0", fontSize: 9, color: "var(--adv-ink-4)" }}>{stat.sub}</p>" — no "fontFamily", while the label directly above it at :962-973 does set "fontFamily: "var(--adv-font-mono)"". The sub-line renders in the body face.
- **Fix:** Add "fontFamily: "var(--adv-font-mono)"" to the stat sub-line, matching the label above it.

### DRAWERS-34 · LOW · WRONG — Copy drawer eyebrow drops the character count

- **Design:** 19-copy-detail-drawer.html L4: "Copy detail · {{ co.kind }}", where co.kind is built at data-model.js:266 as "coSel.kind + ' · ' + coSel.chars + ' chars'".
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:873 "Copy detail · {kind}" with "kind = dash(row.copyAssetType)" (:797); "row.copyText" is in hand at :887 but its length is never used.
- **Fix:** Append " · ${row.copyText.length} chars" after the asset type.

### DRAWERS-35 · LOW · WRONG — Copy drawer's closing footnote sits inside the Alternative lines card and loses the mono face

- **Design:** 19-copy-detail-drawer.html L44 — a body-level paragraph AFTER the card closes at L43, styled "font-family:'IBM Plex Mono',monospace;font-size:10px;line-height:1.6;color:#98A4BA".
- **Code:** app/(dashboard)/platforms/meta/copies/legacy-page.tsx:1100-1103 places it inside the card (the card's closing "</div>" is at :1104) and styles it "{ margin: 0, fontSize: 10, lineHeight: 1.6, color: "var(--adv-ink-4)" }" with no font-family, so it renders in the body face.
- **Fix:** Move the paragraph out of the card to body level and set the mono family. (The reworded text itself is fine — it describes what this app actually does with served variants; do not restore the design's seed wording about angle-shifted drafts.)

---
