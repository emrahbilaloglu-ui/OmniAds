# Design Fidelity Ledger — Adsecute Redesign vs Claude Design reference

_Generated 2026-07-08 by an adversarial code-vs-reference audit (8 parallel auditors). Source of truth: the Claude Design `.dc.html` reference set. This REPLACES the earlier route-coverage ledger's dishonest "covered" claims — "covered" there meant "route renders without crashing," NOT "matches the reference composition."_

## Blunt verdict: table-average reference fidelity ~**52%**. Nothing here is design-complete.

The prior green gates (typecheck/lint/vitest/Playwright smoke) only proved no-crash / no-Pulse / no-overflow. They never compared against the reference. On real data the flagship surfaces render empty skeletons; the shell is a looser, blue-accented, wider, Geist-font reinterpretation rather than the reference's dense IBM Plex operator console.

> Calibration update after user review, 2026-07-08: treat all surface rows below as **open** until the specific blockers and major fidelity gaps are reworked and re-verified against the matching `.dc.html` file. Later smoke screenshots or slice-level improvements may prove progress, but they do not close the surface unless this ledger is updated with explicit reference-fidelity evidence and remaining deviations.

| Surface | Fidelity | Verdict | Blockers | Major | Minor |
| --- | --- | --- | --- | --- | --- |
| 08 Components Mobile (mobile composition + shared component  | **31%** | partial | 2 | 5 | 1 |
| 05 Client Panel (client-facing read-only share views) | **55%** | partial | 1 | 4 | 3 |
| 04 Automation — /platforms/meta/automation | **48%** | partial | 2 | 4 | 2 |
| 07 Auth & Onboarding | **58%** | partial | 1 | 4 | 3 |
| Shared app shell / chrome (topbar + left nav + Layer-1 conte | **38%** | partial | 2 | 8 | 2 |
| 06 Workspace (home overview / reports / targets & economics  | **51%** | partial | 1 | 6 | 5 |
| 02 Creative Studio | **45%** | partial | 0 | 7 | 3 |
| 01 Decisions (Meta Decision Center) + Inspector | **66%** | partial | 1 | 4 | 3 |
| 03 Launchpad (Meta guarded write-surface: index + wizard + p | **65%** | partial | 1 | 3 | 5 |

## Admin/Internal Addendum — route-covered, design-open

> Slice update, 2026-07-08: Admin/internal pages are not scored as a full product-design surface in the Claude Design reference set, but they are in scope for "no old UI pocket" visual normalization. `/admin` now wraps all admin routes in a scoped `.ad-admin-shell`, uses a 196px rail instead of the old 240px `w-60` rail, inherits IBM Plex/token typography, and maps legacy admin-only gray/blue/indigo/purple/red/amber/emerald utility colors plus oversized radius/shadow classes to the shared `--adc` token family. Verified by `npx vitest run components/admin/admin-token-normalization.test.ts components/admin/release-authority-panel.test.tsx` plus the final static/smoke gates. This is behaviorless normalization only: admin routes remain design-open, no admin data/action logic was rewritten, and this addendum is not a completion claim.

**Still open:**
- Admin pages still keep their existing information architecture and Turkish operational copy; no dedicated Claude Design admin wireframe exists.
- Several admin pages still carry dense legacy table/card structures internally; the scoped token layer normalizes them visually but does not redesign each page.
- Full fidelity cannot be claimed without admin-specific reference artifacts or a separate admin design brief.

**Impl files:** `app/admin/layout.tsx`, `app/globals.css`, `components/admin/admin-token-normalization.test.ts`

## 08 Components Mobile (mobile composition + shared component primitives) — 31% (partial)

> Slice update, 2026-07-08: `/platforms/meta` now owns a page-scoped mobile Decisions queue and mobile Evidence screen backed by the real Decisions workspace/anomaly/lane payload. `DashboardFrame` no longer serves the old static Meta Decisions placeholder; the shell only shows the generic read-only mobile note. Verified by `npx vitest run components/meta/redesign/MetaPlatformPage.test.tsx components/layout/shell-redesign.test.tsx` (48/48), `npm run typecheck`, `npm run lint`, `git diff --check`, protected-path audit, and `FULL_UI_SMOKE_VISUAL_ONLY=1 FULL_UI_SMOKE_SCREENSHOTS=meta-decisions node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` (desktop+mobile 2/2). The Playwright mobile path now asserts the real `.meta-mobile-decision-stage`, the desktop-only write notice, `Read evidence`, and the mobile evidence view. This is progress, not closure.

> Slice update, 2026-07-08: `/platforms/meta/automation` and `/platforms/meta/launchpad` now own page-specific mobile read-only screens instead of the generic shell fallback. Automation mobile renders real control-plane posture (readiness tier, kill-switch/blocked reasons, guardrails, STOP-only note) with no stop/promote/demote/write controls. Launchpad mobile renders guarded launch state, PAUSED copy, draft/template counts, media-pipeline contract gap, and explicit `write posture is guarded, not hydrated`; no launch/upload/pause/resume/retry controls render. `DashboardFrame` now routes these pages away from the generic `meta-evidence` fallback and uses route-specific shell notes. Verified by targeted vitest (17/17), `npm run typecheck`, `npm run lint`, `git diff --check`, protected-path audit, and `FULL_UI_SMOKE_VISUAL_ONLY=1 FULL_UI_SMOKE_SCREENSHOTS=automation,launchpad node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` (desktop+mobile 2/2). Still open: Portfolio/business mobile, Creative Studio mobile, Workspace/Auth/Client mobile parity, and the unused/dead shared primitive cleanup.

**Reference structures the surface must have:**
- Mobile status bar row (mono 09:41 · context label e.g. 'Adsecute · read-only', 'Nordventure · Act now 5')
- Freshness line under title ('synced 42m ago · snapshot 2026-07-06') in IBM Plex Mono
- Mobile Portfolio screen: business cards with act-count (danger '5 act'), spend today in tabular nums, tracking status; degraded card bordered danger with failure reason (HTTP 502 since 06:00)
- Mobile Decisions screen: anomaly card (caution border) + decision rows (Cut candidate danger, Scale review pos) each with confidence pill text + 'Read evidence →' info link; explicit 'Writes are desktop-only — rows open evidence, never a pause button. Hit targets ≥44px' note
- Mobile Evidence screen: entity header, danger heat callout (−160 EUR/wk below breakeven), body text with inline citation chips [1]/[3] (info-tone mono), dashed 'Act on desktop — this device is read-only by design' banner
- Read-only-by-design thesis (no write buttons on mobile; no desktop parity)
- Device frame: surface-1 body, rounded-22px outer / rounded-14px inner card, soft shadow, 300px width
- Component sheet primitives: token swatches, confidence pill (bar morphology High/Med/Low), square iconed automation-readiness tag (purple --auto), execute/route/review/defer button hierarchy, pending→verified→silent_failure states, heat cells with in-cell value, media tile fixed ratio + format tag, actor-named audit toast
- IBM Plex Sans body + IBM Plex Mono for ALL numerics/timestamps

**Missing or wrong (severity — structure):**
- **[blocker] Mobile read-only coverage is still incomplete outside Meta Decisions**
  - reference: Three dedicated read-only mobile screens with status bar, freshness line, and card compositions (ref lines 88-120)
  - current: `/platforms/meta` now renders a real mobile Decisions queue/evidence screen, and Automation + Launchpad now render surface-specific read-only mobile screens. Still missing: the Portfolio/business mobile screen, Creative Studio mobile, Workspace/Auth/Client mobile parity, and surface-specific mobile evidence for other Meta subroutes. The global app chrome above the 300px device still differs from the reference.
- **[blocker] MobileReadOnlyCard primitive**
  - reference: Mobile cards carry status/act-count/freshness/evidence-link and enforce read-only intent (ref 96-98,105-106)
  - current: components/ui/product-surface.tsx:124-140 defines a generic label/value/children card, but it is DEAD CODE — grep shows zero usages in app/ or components/. It also bears none of the reference structure (no act-count, no tone borders, no evidence link, no citation chips).
- **[major] Read-only-by-design signaling / write suppression is only proven on Meta Decisions**
  - reference: Writes stay desktop-only; mobile rows open evidence, never a pause button; explicit 'Act on desktop' dashed banners and ≥44px hit-target note (ref 89,107,116)
  - current: Meta Decisions mobile now suppresses write controls and renders "Writes are desktop-only" plus an evidence-only row flow. Other in-scope surfaces are not yet proven desktop-only on mobile.
- **[major] Mobile status bar + freshness line**
  - reference: Mono status row (09:41 · context) and 'synced 42m ago · snapshot <date>' line (ref 93-95)
  - current: Meta Decisions mobile has a mono status row and snapshot freshness line. Portfolio and most other surfaces still lack this structure.
- **[major] Mobile navigation affordance**
  - reference: Reference mobile screens are self-contained read-only views; navigation is not a desktop sidebar
  - current: On <md the sidebar is fully hidden with NO replacement — no hamburger, drawer, or bottom nav (sidebar.tsx:7, topbar.tsx has no menu trigger). Mobile users lose all navigation.
- **[major] Citation chips on evidence (mobile)**
  - reference: Inline info-tone mono citation chips [1]/[3] embedded in evidence prose (ref 115)
  - current: Meta Decisions mobile Evidence renders inline citation chips. Other mobile evidence surfaces are still absent/generic.
- **[major] Tone-bordered decision/business cards**
  - reference: Cards use semantic tone borders (danger-bd for degraded, caution-bd for anomaly, pos/danger text for scale/cut) (ref 97,104-106)
  - current: Meta Decisions mobile uses caution/danger/positive tone cards from real lane data. Portfolio/business cards and other surface cards remain missing; `MobileReadOnlyCard` is still unused.
- **[major] Shared primitive design language (component sheet)**
  - reference: IBM Plex Sans/Mono, tokened surfaces (--s1/2/3, --ink1-3), purple --auto automation tag, confidence-bar pill, dense radius 6-8px, actor-named toast
  - current: product-surface.tsx primitives use Geist font, raw Tailwind slate/neutral/blue/emerald/amber/rose, rounded-lg, generic ProductPageShell/ProductSection card wrappers. No confidence pill, no automation-readiness tag, no --auto purple, no heat cell, no media tile, no audit toast primitive here.

**Visual/token mismatches:**
- Body font: reference `IBM Plex Sans` vs current Meta Decisions mobile/console uses IBM Plex; shared `product-surface` primitives and some non-Meta surfaces still need the same audit.
- Numeric/timestamp font: reference `IBM Plex Mono for ALL numerics and mono status/freshness rows` vs current Meta Decisions mobile status/freshness uses IBM Plex Mono; other mobile surfaces remain missing/generic.
- Canvas / card surfaces: reference `--s1 #F5F5F3 canvas, --s2 #FFFFFF card, --s3 #EDEDEA hover` vs current `canvas #fafafb, --surface #fff; product-surface uses bg-white / border-neutral-200`
- Accent for links/selection: reference `--info-fg #1D5FC4 / --focus #1E62D0` vs current Meta Decisions mobile uses `--adc-info`; unused `MobileReadOnlyCard` and several shared surfaces still need cleanup.
- Automation/provenance tone: reference `purple --auto #6C41BE / bg #F2EDFB / bd #D9CCF1` vs current `No purple auto token used in these primitives`
- Card radius: reference `6-8px inner cards, 14-22px device frame (tight/dense)` vs current Meta Decisions mobile uses the 14/22 device frame, but shared `product-surface` cards still use looser generic radii.
- Semantic tones: reference `role tokens danger/caution/pos/info with matched fg/bg/bd` vs current Meta Decisions mobile uses `--adc` semantic tones; shared primitives still contain generic tone wrappers and need audit.

**Top fixes (highest leverage first):**
1. Build the missing Portfolio/business mobile screen and then repeat the surface-specific mobile pass for Creative Studio, Workspace, Client Panel, and Auth. Meta Decisions, Automation, and Launchpad now have real read-only mobile starts, but this is not portfolio-wide parity.
2. Enforce the read-only-by-design thesis on every remaining mobile surface: suppress write controls below md, replace with 'Read evidence →' / 'Act on desktop' dashed banners, and guarantee ≥44px hit targets.
3. Add a mobile navigation affordance to replace the hidden sidebar, and carry the mono status/freshness row pattern from Meta Decisions into each remaining mobile surface.
4. Rebuild the shared primitives on the reference token/type system (IBM Plex Sans/Mono, --s1/2/3 + --ink + semantic + purple --auto, 6-8px radius) instead of Geist + raw Tailwind slate/rounded-lg wrappers.
5. Either wire MobileReadOnlyCard into real usage with reference structure (act-count, tone borders, evidence link) or delete it — it is currently dead, off-spec code.
6. Port the missing component-sheet primitives (confidence-bar pill, square automation-readiness tag, heat cells, media tile, actor-named audit toast) to shared components.

**Impl files:** `components/ui/product-surface.tsx`, `app/(dashboard)/layout.tsx`, `components/layout/sidebar.tsx`, `components/layout/topbar.tsx`, `components/layout/sidebar-content.tsx`, `components/meta/redesign/MetaPlatformPage.tsx`, `components/platform-table-page.tsx`, `app/(dashboard)/platforms/meta/launchpad/page.tsx`, `app/globals.css`

## 05 Client Panel (client-facing read-only share views) — 55% (partial)

> Correction, 2026-07-08: the earlier 20% audit was stale and falsely described `/share/creative/[token]` as the old wide operator export. Current code already has the reference-shaped client topbar, 760px centered column, KPI grid, client-safe copy, creative highlights, and footer disclaimer in `components/creatives/PublicCreativeSharePage.tsx` plus `app/globals.css`. This slice tightens the contract instead of declaring completion: the feed now renders only explicit `payload.clientActions`; it no longer derives client-facing action cards from internal `analysis.actionLabel`. Buyer snapshots may persist sanitized client-safe actions; external/creative-team snapshots drop them. `/share/report/[token]` now carries business/currency metadata when the report share endpoint can resolve it. This is progress, not closure.

**Reference structures the surface must have:**
- 50px top bar: 9px ink square brand mark + client business name + 'Client view · read-only' pill (rounded-999 11px) + spacer + outlined 'Download PDF' button + client email in ink3
- Narrow centered content column (max-width:760px, 26/20/40 padding, 20px gap flex-column) — NOT a wide operator canvas
- Header block: 19px semibold title ('Your advertising results') + 12px ink3 subline 'period · data as of … UTC'
- Conditional transparency/degraded caution banner (caution-bg/bd/fg, radius 8) shown only in tracking_degraded state
- 3-col KPI stat grid: Spend / Return / Sales cards (s2 bg, b1 border, radius 10), 19px semibold tabular-nums value, Return colored --pos-fg, ink3 label + sub-label
- 'What we did and why' plain-language action feed: stacked cards with what (13px semibold) + date (ink3 right) + why (ink2 12.5px line-height 1.6) + optional outcome pill (pos or neutral ink triplet, rounded-999)
- no_actions empty state: centered card explaining 'no changes were needed … when we do nothing we say so plainly'
- 'Creative highlights' section: heading + threshold-disclosure note + 3-col media grid; each card has aspect-ratio placeholder (diagonal hatch) with mono media-format label + name + mono 'spend · Nx' line
- Footer disclaimer: 11px ink3, top border — currency note, 'missing data renders as —, never 0', 'outcome statements are correlational'
- Turkish-first bilingual copy (TR default, EN alternate); client-safe plain language throughout
- IBM Plex Sans body / IBM Plex Mono for all numerics; 13px base; semantic token palette incl purple --auto

**Missing or wrong (severity — structure):**
- **[blocker] Real client action history is still a new optional contract, not a fully populated backend feed**
  - reference: chronological "What we did and why" feed with real client-safe actions and outcome pills.
  - current: `clientActions` now exists and is sanitized for buyer shares, and the UI refuses to fabricate actions from `analysis.actionLabel`. Existing producers do not yet populate real action history from audit/decision events, so many shares will honestly show the missing-action empty card.
- **[major] `/share/report/[token]` is visually normalized but still not the same advertising-results panel**
  - reference: Spend / Return / Sales KPI cards and creative highlights.
  - current: shared custom reports use the same 50px topbar/760px client shell and metadata cards, but arbitrary report canvases cannot always map to Spend/Return/Sales without a report-to-client-summary contract. Business/currency metadata is now carried when available.
- **[major] Client recipient identity is not a first-class report-share field**
  - reference: topbar shows client email.
  - current: creative shares can carry `clientEmail`; report shares still set it to null because the share endpoint has no recipient field. The UI falls back to `client view` instead of leaking the operator email.
- **[major] No degraded-state source for report shares**
  - reference: caution banner appears only for tracking-degraded periods.
  - current: creative shares support `trackingState`; report shares carry an optional type but no renderer/service populates it yet.
- **[major] Share invalid/expired states still use old generic Tailwind cards**
  - reference: same calm client-panel token language should cover public-facing empty/error states.
  - current: invalid `/share/creative` and `/share/report` token states still render separate neutral Tailwind cards, not the client-panel shell.
- **[minor] Creative highlights use real media preview instead of the reference's hatch-only placeholder**
  - reference: hatch placeholder with mono media-format label.
  - current: uses `CreativeRenderSurface` when media exists and overlays the mono format tag. This is a product improvement but not pixel-identical to the wireframe.
- **[minor] Outcome history is capped and simplified**
  - reference: outcome pills can be positive or neutral per action.
  - current: supports positive/neutral, but no measured 7-day outcome hydration exists yet.

**Visual/token mismatches:**
- Creative and report share happy paths now use the reference `--s1/--s2/--ink/--b` client token set and IBM Plex stack. Invalid/expired states do not.
- The topbar/content/card density is close to reference, but report canvas internals still bring their own report-builder visual grammar.
- Mobile collapses the grids to one column; the reference client panel is primarily desktop-sized and does not specify a rich mobile variant.
- Purple `--auto` exists in the reference token palette but is not used on this client panel because the client design does not surface automation controls.

**Top fixes (highest leverage first):**
1. Populate `clientActions` from real decision/audit outcomes when creating buyer shares; acceptance = feed rows cite persisted action id/date/outcome class, not creative analysis labels.
2. Add a recipient field to report share creation so the client topbar can show a real client email without leaking the operator identity.
3. Add a report-share summary contract for Spend / Return / Sales when the report has safe single-currency inputs; otherwise keep the current report-metadata cards.
4. Restyle invalid/expired token states into the same client-panel shell.
5. Add tests for `/share/report` metadata propagation and invalid-token shell parity.

**Impl files:** `app/share/creative/[token]/page.tsx`, `app/share/report/[token]/page.tsx`, `components/creatives/PublicCreativeSharePage.tsx`

## 04 Automation — /platforms/meta/automation — 48% (partial)

> Slice update, 2026-07-08: Automation now has a reference-shaped desktop surface: local context row with purple autopilot pill + Decisions link, per-decision-type mode rows, server-enforced guardrails with a STOP-only business kill-switch button, promotion-contract modal, bottom-center toast stack, and activity rows with no-write/verified posture. Backend added a real `POST /api/meta/automation?action=engage_kill_switch` path and `engageMetaAutomationKillSwitch` control-plane writer that only stops Meta writes; no enable-all/promotion writer was added. Verified by `npx vitest run app/(dashboard)/platforms/meta/automation/page.test.tsx app/api/meta/automation/route.test.ts lib/meta/automation-control-plane.test.ts` (12/12), `npm run typecheck`, `npm run lint`, `git diff --check`, protected-path audit, and `FULL_UI_SMOKE_VISUAL_ONLY=1 FULL_UI_SMOKE_SCREENSHOTS=automation node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` (desktop+mobile 2/2). This is progress, not closure.

> Double-chrome correction, 2026-07-08: the duplicated internal `Adsecute` brand/topbar was removed from Automation. The route now renders a local context row (`Automation`, business, autopilot pill, readiness, Decisions link) under the single global console topbar. Verified by `npx vitest run app/(dashboard)/platforms/meta/automation/page.test.tsx app/(dashboard)/platforms/meta/launchpad/page.test.tsx components/layout/shell-redesign.test.tsx components/layout/nav-items.test.ts` (16/16), `npm run typecheck`, `npm run lint`, `git diff --check`, protected-path audit, and `FULL_UI_SMOKE_VISUAL_ONLY=1 FULL_UI_SMOKE_SCREENSHOTS=automation,launchpad node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` (desktop+mobile 2/2). Remaining gaps after this chrome slice were per-type automation contract, executable promotion/demotion, mobile specificity, and richer activity payloads; the mobile specificity gap was reduced in the following slice, not closed.

> Mobile slice update, 2026-07-08: Automation now has a page-owned mobile read-only screen (`data-testid="meta-mobile-automation"`) instead of the generic Meta fallback. It renders the real business control-plane payload: readiness tier, blocked reasons, current business-scoped mode, daily cap, per-action ceiling, notification policy, and STOP-only posture. Mobile does not render `Stop all writes`, promote, demote, or other write controls. Verified by targeted vitest (17/17), typecheck, lint, protected-path audit, and Automation/Launchpad visual smoke (desktop+mobile 2/2). It remains partial because per-decision-type gates and promotion/demotion contracts are still backend-missing.

**Reference structures the surface must have:**
- Top app bar (46px): Adsecute mark, 'Automation — {business}' title, PURPLE --auto pill 'autopilot earned gradually', spacer, '← Decisions' link
- Explainer paragraph drawing the recommendation-tier vs standing-mode distinction (read_only→manual_review→backtest_candidate→auto_execute; Auto mode still skips sub-tier recs)
- Per-decision-type readiness ROWS (4 rows: Pause bleeding ad set, Apply bid cap, Budget change, Creative pause) each with: name, sub, gate progress bar (colored fill), gate text 'X of Y improved (80% required)', gate note, and a 3-button mode radiogroup [Manual / Semi-auto / Auto] with lock/disabled states and per-row lockNote
- Mode radiogroup interaction: demote = one click immediate; promote = opens confirm modal; Auto button uses purple --auto active styling; locked buttons show not-allowed cursor + tooltip
- Guardrails — server-enforced card: 'Daily auto-action cap 3/day', 'Per-action spend ceiling 50 EUR', 'Notification policy on every auto action', 'Business kill switch' with red danger 'Stop all writes' BUTTON, plus 'STOP only, no enable-all master switch' explainer
- Activity — auto-executed ledger card (filtered Audit Trail view): rows with bold entity, actor '(bleeding-ad-set rule)', pos-fg 'verified 06:41', meta line 'tier at action: auto_execute · within daily cap (1 of 3) · notification sent', 'Undo' button; plus a skipped/protected-entity row 'no write'
- Promotion confirm modal (dialog): 'Promote X to {target}', evidence gate '16 of 20 improved', restated guardrails block, Cancel + purple 'Confirm promotion' buttons
- Toast stack (aria-live) at bottom-center for demote/promote/kill-switch feedback

**Missing or wrong (severity — structure):**
- **[blocker] Per-decision-type persistence + judged-outcome gate contract is still absent**
  - reference: each decision type owns its own judged outcomes, eligible mode ceiling, current standing mode, demote-on-click, and promote-confirm path.
  - current: UI now renders the four dense rows and Manual/Semi-auto/Auto buttons, but gate bars are honest indeterminate tracks (`read model missing`) because the backend only exposes business-level automation posture. No per-type mode persistence or judged-outcome contract exists yet.
- **[blocker] Promotion confirm is evidence-only, not executable**
  - reference: eligible promotion opens confirm modal and the purple `Confirm promotion` button persists the operator decision.
  - current: modal exists and restates guardrails, but confirm is disabled with explicit backend-missing copy. This is honest, but not functionally complete.
- **[fixed in slice] Mobile Automation page-owned read-only surface**
  - reference: Automation needs its own mobile read-only version or intentionally scoped operator-only fallback.
  - current: mobile now renders a dedicated Automation surface with control-plane posture, guardrails and desktop-only write notice. It is read-only and omits stop/promote/demote controls. Remaining mismatch: it is a compact guardrail summary, not a full mobile automation parity screen.
- **[major] Global shell/chrome still wraps the surface; duplicate brand bar is now removed**
  - reference: standalone 46px Automation bar at the viewport top.
  - current: the app shell topbar/sidebar remain visible, but the route no longer renders a second `Adsecute` brand bar underneath. The local row is now a context header. This is still not the standalone reference shell.
- **[major] Activity ledger row detail is still limited by stored payloads**
  - reference: rows show entity, actor rule, verified time, tier at action, daily cap position, notification sent, Undo.
  - current: rows now use verified/no-write posture and an Undo-unavailable control, but entity/actor/cap/notification values are only shown when future payloads provide them. No fabricated values are emitted.
- **[major] Stop-only kill switch exists, but no operator-safe release flow**
  - reference: explicitly STOP-only; no enable-all master switch.
  - current: `Stop all writes` is real and backend-backed. Releasing the business kill switch intentionally has no UI/API path yet, so admin release remains an out-of-band future contract.
- **[minor] Backend prerequisite details still appear as dense mono copy**
  - reference: only the main guardrails are shown.
  - current: label/commercial-anchor/preflight/rollback/dry-run details are retained as a compact backend-prerequisites line for operator honesty.
- **[minor] Reference visual density improved, but not pixel-equivalent**
  - reference: no lucide shell icons, exact standalone composition.
  - current: internal Automation uses IBM Plex/--adc/purple auto tokens and tight radii, but the surrounding global shell still carries product chrome.

**Visual/token mismatches:**
- Font family: internal Automation now uses the global IBM Plex/--adc stack, but the surrounding app shell still carries its own chrome.
- Numerics: guardrail values use mono/tabular styling; real judged-outcome numerics cannot render until the per-type contract exists.
- Automation color: purple --auto is now used for the autopilot pill and modal disabled confirm, but executable Auto mode styling is still blocked by missing backend mode state.
- Progress bar / gate meter: row tracks exist, but fills are indeterminate because hit/judged counts are missing by design.
- Iconography: internal Automation avoids lucide icons; global shell still has app-wide icons.

**Top fixes (highest leverage first):**
1. Add the real per-decision-type automation mode contract: table/API for decision type, current mode, judged calls, improved calls, evidence-window metadata, eligible ceiling, lock reason, updated_by/updated_at; acceptance = UI shows real `16 of 20 improved` style gates, not `read model missing`.
2. Add promotion/demotion writers with audit records and no provider writes until downstream guardrails allow it; acceptance = demote one-click persists, promote confirm persists a record, unsupported paths return a typed blocked reason.
3. Enrich the mobile Automation summary only after the backend exposes real per-decision-type judged gates; do not fabricate hit/judged counts.
4. Enrich activity ledger payloads with entity, actor rule, tier at action, daily cap count, notification status, and explicit protected-skip class; keep Undo disabled until a reversal contract exists.
5. Finish the shell decision globally: Automation/Launchpad no longer duplicate the brand bar, but the reference shell is still approximated by the app-wide dashboard chrome.

**Impl files:** `app/(dashboard)/platforms/meta/automation/page.tsx`, `lib/meta/automation-control-plane.ts`

## 07 Auth & Onboarding — 58% (partial)

> Slice update, 2026-07-08: Auth/Business setup now has a real shared `AuthSurface` token card, login/signup Google parity, a dedicated `/forgot-password` page backed by the honest `501 email_delivery_not_configured` password-reset API, invite email-mismatch guard with switch-account and disabled accept reason, dense business select/create cards, and a new `AuthOnboardingArc` on business create/select. The arc renders Connect Meta → Pick accounts → First sync → Set economics from current client store evidence where available, and explicitly avoids fake progress bars, counts, and ETAs. Verified by `npx vitest run components/auth/onboarding-arc.test.ts components/platform-table-page.test.ts components/states/ComingSoonState.test.tsx` (7/7), `npm run typecheck`, `npm run lint`, `git diff --check`, protected-path audit, and `FULL_UI_SMOKE_VISUAL_ONLY=1 FULL_UI_SMOKE_SCREENSHOTS=auth node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` (desktop+mobile 2/2). This is progress only; reset email delivery, full onboarding write/status contracts, and the critical-event email template remain open.

**Reference structures the surface must have:**
- LOGIN card (340px, IBM Plex, dark ink1 primary 'Sign in', outline 'Continue with Google', bottom row: 'Forgot password?' + 'Create account')
- SIGNUP card (Name/Email/Password only, Google, Facebook explicitly dropped)
- FORGOT PASSWORD card (NEW) — email input + dark 'Send reset link' + pos-tone sent-state banner
- INVITE ACCEPT card — role+scope sentence, caution-tone email-mismatch guard banner, 'Switch account' button, DISABLED 'Accept invite' with visible reason caption ('never a silent dead button')
- BUSINESS SELECT + CREATE card (400px) — business rows with pos/caution/danger status dots, mono 'EUR · 2 accounts' meta, delete-requires-typing row, dashed '+ Create business' button; note: select-language page retired
- ONBOARDING ARC — 4 dense 300px step cards: STEP 1 Connect Meta, STEP 2 Pick ad accounts (checkbox rows w/ mono currency), STEP 3 First sync in progress (truthful step list, no fake progress bars/ETAs), STEP 4 Set economics (Target ROAS mono input, skip allowed, lands on 'needs 7 days of data')
- CRITICAL-EVENT email template (danger heading, mono metadata block, dark 'Open in Audit Trail')

**Missing or wrong (severity — structure):**
- **[blocker] Password reset delivery contract is still not executable**
  - reference: Forgot-password success banner says a reset link is on its way and expires in 30 minutes.
  - current: `/forgot-password` exists and uses the reference card/button shape, but `/api/auth/password-reset/request` intentionally returns `501 email_delivery_not_configured`; the UI honestly reports that no email was sent. This avoids false success, but it is not the reference executable reset flow.
- **[major] Onboarding arc is visible but not a full wizard**
  - reference: Four standalone onboarding cards include Connect Meta, account checkbox picker with mono currency, first-sync state list, and Target ROAS input that finishes into Decisions.
  - current: `AuthOnboardingArc` now renders the four steps and uses real client-store evidence for Meta connection, assigned account count, and last sync. It does not yet provide the account checkbox picker inline, a target input write, or a dedicated server-backed onboarding status contract. It links to `/integrations`, `/commercial-truth`, and `/platforms/meta` instead of owning the whole flow.
- **[major] Critical-event email template missing**
  - reference: Danger email template with UTC timestamp, silent_failure/tracking/kill-switch copy, mono business/entity/idempotency metadata, and `Open in Audit Trail`.
  - current: no corresponding mail template/component was added in this slice. This remains a real Auth/Onboarding deliverability and operator-safety gap.
- **[major] Business create/select cards are close but not exact**
  - reference: Business select is a compact 400px card; create is adjacent to the onboarding arc; rows use exact pos/caution/danger status semantics.
  - current: select/create now use `AuthSurface`/`ad-auth-*` token cards and status dots, but the wider `lg` shell and inline onboarding arc make them a productized interpretation rather than a pixel match. Delete confirmation remains expanded inline instead of the reference's single danger row.
- **[minor] Login/signup cards still have live-product redirects and fallback loading variants**
  - reference: static card examples only.
  - current: the product correctly preserves existing session restore, invite query handling, and loading fallbacks. This is required behavior, but it means the visual states exceed the reference and need visual QA on each auth path.
- **[minor] select-language page still exists**
  - reference: the vestigial select-language page is retired.
  - current: `app/select-language/page.tsx` remains a redirect stub via `AuthSurface`. Functionally neutralized, but not removed.

**Visual/token mismatches:**
- Body font: Auth cards now use IBM Plex via `--font-ibm-plex-sans`, but global app shell and some loading fallback utilities still inherit broader app chrome.
- Numeric/eyebrow font: `ad-auth-eyebrow`, mono status, step labels, and business meta now use IBM Plex Mono; remaining live-product fallbacks need route-by-route visual QA.
- Primary button: auth primary now uses ink1 fill/white text; linked OAuth/provider flows still rely on external browser redirects.
- Canvas: auth page uses `--adc-s1 #F5F5F3`; the reference document's outer canvas `#E9E9E6` is only approximated inside the real app.
- Card radius: cards/inputs/buttons match the 12px/6px family closely, but the new `lg` card for onboarding is wider than the reference single-card examples.
- Error/status banners: danger/caution/positive triplets are now used for forgot/invite/delete/onboarding states; email-delivery-not-configured stays caution, not success.
- Status dots: business select now uses 7px pos/caution/danger dots from integration/assignment posture; exact reference examples are illustrative, not data-bound.

**Top fixes (highest leverage first):**
1. Implement real password-reset delivery: token generation, 30-minute expiry, email provider integration, and reset-confirm page; acceptance = UI may show the positive sent-state without lying.
2. Add a server-backed onboarding status/read model: Meta connection, discovered accounts with currency, assigned accounts, sync stage, first engine run, and target-pack status; acceptance = step cards light up from server evidence, not only client store.
3. Add the inline ad-account checkbox picker and Target ROAS write inside onboarding, reusing the Integrations and Commercial Truth contracts instead of duplicating state.
4. Build the critical-event email template and audit-trail target route for tracking blocked, kill switch, and silent_failure events.
5. Decide whether to fully retire `/select-language` or keep it as a redirect compatibility route with explicit ADR.

**Impl files:** `app/login/page.tsx`, `app/signup/page.tsx`, `app/forgot-password/page.tsx`, `app/api/auth/password-reset/request/route.ts`, `app/invite/[token]/page.tsx`, `app/select-language/page.tsx`, `app/(dashboard)/businesses/new/page.tsx`, `app/(dashboard)/select-business/page.tsx`, `components/auth/auth-surface.tsx`, `components/auth/onboarding-arc.tsx`, `components/business/BusinessForm.tsx`, `app/globals.css`

## Shared app shell / chrome (topbar + left nav + Layer-1 context header + Layer-2 queue-filter bar) — 38% (partial)

> Slice update, 2026-07-08: the worst cross-surface double-chrome regression was reduced on Automation and Launchpad. Those routes no longer render a second `Adsecute` brand bar below the global console topbar; each now uses a local context row with the route title, business/currency or readiness metadata, posture chip, and Decisions link. Launchpad's static `writes enabled` claim was also changed to `writes guarded` because the page does not yet hydrate kill-switch/write-posture freshness. This does **not** implement the reference shell globally: the shared Layer-1 context header, Layer-2 queue filter bar, posture banner stack, and full mobile navigation model remain open.

**Reference structures the surface must have:**
- Topbar (46px): 9px square ink logo + 'Adsecute' wordmark, vertical divider, business/scope menu button (dot+name+caret), spacer, Cmd-K 'Jump or act...' command button with mono kbd, notification bell (30x28) with danger dot, 28px round avatar 'EO'
- Left nav (196px, canvas bg --s1): three groups WORKSPACE / PLATFORM·META (collapsible w/ platform dropdown) / MANAGE; items 12.5px, pad 6px 10px, radius 6px; active item = white card (--s2) + border --b1 + weight 600 (neutral, NOT accent); footer 'Redesign preview' line
- Layer-1 context header bar (bg --s2, border-bottom): account/currency menu button, 'Last 28d' date-range button, snapshot note ('queue reflects snapshot 2026-07-06...'), mono system-status button ('synced 42m ago · snapshot · engine v1.19.0'), posture chip, track-record pill ('21 of 29 judged calls improved · 7d windows'), snapshot run button + 'runs today', '+ New campaign' info-tinted CTA
- Posture banner stack (kill-switch danger, dry-run info, tracking-degraded caution, reviewer read-only)
- Layer-2 queue-filter bar (bg --s2): tabs with 2px underline active state, dashed 'Deferred N' chip, Sort <select>, min-spend toggle chip, 'Search entities' input (150px), density toggle button
- Design system: IBM Plex Sans body + IBM Plex Mono for ALL numerics; base 13px / line-height 1.45; canvas --s1 #F5F5F3; radius 6-8px; --focus #1E62D0 outline rings; purple --auto pill for automation

**Missing or wrong (severity — structure):**
- **[blocker] Layer-1 context header bar**
  - reference: Full context header (lines 99-122): account/currency menu, 'Last 28d' date range, snapshot-date note, mono system-status button (synced/snapshot/engine version), posture chip, track-record pill '21 of 29 judged calls improved', snapshot run button + runs-today counter, '+ New campaign' CTA
  - current: Still absent from the shared shell. Automation and Launchpad now carry local context rows to avoid double-chrome, but `app/(dashboard)/layout.tsx` has no shared context-header contract that all routes can consume.
- **[blocker] Layer-2 queue-filter bar**
  - reference: Queue-local bar (lines 154-173): underline tabs, dashed 'Deferred N' chip, Sort select, min-spend chip, 'Search entities' input, density toggle
  - current: ABSENT from the shell. No tabs/underline, no Deferred chip, no sort/min-spend/search/density controls anywhere in components/layout/ or the dashboard layout.
- **[major] Posture banner stack**
  - reference: Kill-switch (danger), dry-run (info), tracking-degraded (caution), reviewer (read-only) banners rendered between context header and queue bar (lines 125-150)
  - current: ABSENT. No posture/kill-switch/dry-run/reviewer banner surface in the shell.
- **[fixed in console shell] Cmd-K command / 'Jump or act...' button**
  - reference: Topbar center-right pill button 'Jump or act...' with a mono ⌘K kbd chip (line 50)
  - current: Present in the non-overview `DashboardFrame` console topbar. Legacy `/overview` still uses the old frame by design and is protected/out of scope for this redesign pass.
- **[major] Topbar composition & route-local context**
  - reference: Topbar (line 28) height 46px, holds the 9px square ink logo + 'Adsecute' wordmark on the LEFT, then a divider, then the scope/business menu
  - current: non-overview `DashboardFrame` uses a 46px console topbar with brand, business selector, platform switcher, command button, notification, and account menu. Still open: reference Layer-1 context/header controls are not shared, and only Automation/Launchpad have had duplicate route-local brand bars removed.
- **[major] Left nav width**
  - reference: nav width:196px (line 60)
  - current: sidebar.tsx line 7 and sidebar-content.tsx line 243 use w-60 = 240px. ~44px too wide.
- **[major] Left nav background**
  - reference: nav background:var(--s1) = #F5F5F3 canvas grey (line 60), so nav sits flush with canvas and only the card-bg active item pops
  - current: sidebar-content.tsx line 243 bg-white. Nav is white, inverting the reference figure/ground relationship.
- **[major] Active nav item treatment**
  - reference: Active item (line 80) = white card bg --s2 + 1px border --b1 + weight 600, fully NEUTRAL (ink colors). No brand accent anywhere in nav.
  - current: sidebar-content.tsx: L1 active = 'bg-blue-50 text-blue-700 font-semibold' (line 108), L2 active adds a blue-600 left border (lines 36-43). Uses brand-blue accent the reference deliberately avoids.
- **[major] Font family (body + mono numerics)**
  - reference: IBM Plex Sans body + IBM Plex Mono for ALL numerics (line 11,13); mono used for dates, counts, badges, currency
  - current: app/layout.tsx lines 3-17 load Geist + Geist_Mono; IBM Plex is never loaded. Mono is applied only to the L2 badge (sidebar-content.tsx line 180), not to numerics broadly.
- **[major] Shell does not use its own token system**
  - reference: Reference shell is driven by --s1/--s2/--ink/--b1/--focus tokens end to end
  - current: The shell (topbar/sidebar/layout) uses raw Tailwind neutral-* + shadcn oklch tokens, and does NOT apply the .ad-final class (grep for 'ad-final' in components/layout + dashboard layout returns nothing). Even the project's own dense token block is bypassed by the chrome.
- **[minor] PLATFORM·META group as collapsible platform switcher**
  - reference: Group header 'PLATFORM · META' is a button opening an inline dropdown listing Meta(live)/Klaviyo(beta)/Google(beta)/TikTok(soon)/Pinterest/Snapchat with status labels (lines 69-79)
  - current: Platform switching lives in the TOPBAR (PlatformSwitcher). Sidebar shows a static 'Platform · <name>' label row (lines 271-280) with no in-nav platform dropdown. Group structure exists but interaction is relocated.
- **[minor] Base type scale**
  - reference: font-size:13px; line-height:1.45 on the shell root (line 25)
  - current: No 13px/1.45 root; .ad-final sets 14px/1.55 (globals.css 180-181) and is not even applied to the shell. Nav items are text-[13px] but the system baseline differs.

**Visual/token mismatches:**
- Body font: reference `IBM Plex Sans` vs current `Geist Sans (app/layout.tsx)`
- Numeric/mono font: reference `IBM Plex Mono for all numerics` vs current `Geist Mono, applied only to L2 nav badge`
- Base font-size / line-height: reference `13px / 1.45` vs current `14px / 1.55 in .ad-final (and shell uses tailwind base, not applied)`
- Left nav width: reference `196px` vs current `240px (w-60)`
- Left nav background: reference `#F5F5F3 (--s1 canvas)` vs current `#ffffff (bg-white)`
- Topbar height: reference `46px` vs current `48px (h-12)`
- Active nav item: reference `white card + border --b1 + weight 600, neutral ink` vs current `bg-blue-50 / text-blue-700 / blue-600 accent border`
- Canvas color: reference `#F5F5F3 (--s1)` vs current `bg-neutral-50 (~#fafafa) on main; .ad-final --bg #f7f8fa`
- Focus ring: reference `2px solid --focus #1E62D0` vs current `shadcn outline-ring/50 (neutral oklch)`

**Top fixes (highest leverage first):**
1. Build the Layer-1 context header as a shared shell region (account/currency menu, date-range, mono system-status button, posture chip, track-record pill, snapshot run + New campaign) -- currently 100% missing
2. Build the Layer-2 queue-filter bar (underline tabs, Deferred chip, Sort, min-spend, Search entities, density toggle) as shared chrome -- currently 100% missing
3. Add the posture banner stack (kill-switch/dry-run/tracking-degraded/reviewer)
4. Switch the shell to IBM Plex Sans + IBM Plex Mono at 13px/1.45 and route ALL numerics through the mono face
5. Retune the nav: width 196px, canvas (#F5F5F3) background, neutral white-card active state (drop blue-50/blue-700 accent), and verify all non-overview routes use the same console header grammar.
6. Convert route-local reference topbars into context rows everywhere instead of duplicating `Adsecute` under the global shell; Automation and Launchpad are the first corrected cases.
7. Drive the chrome from --s1/--s2/--ink/--b1/--focus tokens instead of raw neutral-* / shadcn oklch (and reconcile with .ad-final, which itself diverges from the reference)

**Impl files:** `app/(dashboard)/layout.tsx`, `components/layout/topbar.tsx`, `components/layout/sidebar-content.tsx`, `components/layout/sidebar.tsx`, `app/globals.css`, `app/layout.tsx`

## 06 Workspace (home overview / reports / targets & economics / integrations / settings / team / insights) — 51% (partial)

> Slice update, 2026-07-08: Reports, Integrations, Targets & Economics, Insights, Settings, and Team now use a shared `WorkspaceSurface`/`WorkspaceCard`/`WorkspaceStat` token grammar with 16px section titles, IBM Plex/mono inheritance, `--adc` semantic tokens, 6-10px radii, and narrower 900-1060px content widths. Settings form primitives were retuned to the same token system; non-working Profile picture / 2FA / API token / Manage sessions stubs were removed per the reference's "cut, not stubbed" rule. Team now exposes the missing client-identity model as a visible `NEEDS-SERVER-CONTRACT` gap instead of fabricating scoped clients, and Integrations/Reports retain their existing backend behavior while reducing old oversized page chrome. Verified so far by `npm run typecheck`, `npm run lint`, targeted vitest, `git diff --check`, protected-path audit, and reports/settings visual smoke. This is progress only; Workspace is still not design-complete.

> Platform-family slice, 2026-07-08: Google/Klaviyo beta/soon pages now use a dedicated `ComingSoonState` readiness surface instead of the generic `ProductPageShell` card wrapper. It shows platform context, beta/soon posture, Connection/Execution/Data readiness rows, an Integrations link, and an explicit no-write/no-zero-data honesty note. TikTok/Pinterest/Snapchat shared `PlatformTablePage` now labels itself as `Server-backed table · currency not inferred` and no longer formats money metrics as `$...` when row currency is unavailable; money cells render `value · currency —` until the backend adds a row-level currency contract. Verified by targeted vitest. This is breadth progress only; the provider routes remain placeholders/table shells, not full platform workspaces.

**Reference structures the surface must have:**
- Global chrome: 46px top bar (logo dot + Adsecute wordmark, divider, business pill with green status dot, Decisions link) + 196px left nav rail grouped WORKSPACE / PLATFORM·META / MANAGE with active pill styling
- HOME cross-platform overview: 5 provider status pills (colored dot + name·status, one status vocabulary), 3 pinned KPI cards (label·pinned/unpin, 19px tabular value, delta vs prev, inline sparkline polyline), Meta summary card (synced Nm ago mono, Spend/ROAS/Purchases/CPA inline), Google-not-connected dashed CTA card, Expenses card (Edit cost model), Daily brief grounded card with [evidence] mono chips
- TARGETS & ECONOMICS: 3 stat cards (editable Target ROAS input w/ underline, derived Break-even, pos-tinted Status buffer), Coverage card (2-col dotted rows w/ blocking/optional tags + fallback ladder text), Advanced·Cost structure collapsible (4 inputs + derived break-even note + WHAT-IF ROAS mono table), 4 collapsed Advanced rows, fixed bottom Unsaved-changes bar (left:196px, Discard / Save & recompute)
- REPORTS: title + inline underline tab bar (Saved & templates / Builder); Saved = 1 saved-report card w/ striped preview thumb + Edit/Duplicate/Delete + 2 dashed TEMPLATE cards (Preview & use); Builder = 4-col widget grid (SECTION header, metric tiles, trend svg, dashed missing widget, TABLE widget) + right 250px Widget config panel (Type/Source selects, grid/export note)
- INTEGRATIONS: mono uppercase group labels (ADVERTISING / ADVERTISING·MORE / ANALYTICS), 3-col card grid; each card = name + pill status (999px colored) + sub + single CTA button OR honest 'soon' text (no dead affordance) + opacity dim for soon; OAuth callback interstitial note bar; right 400px assignment drawer w/ ad-account checkboxes + mono currency, dark Save button
- SETTINGS: 170px sticky sub-nav; Business identity card (Name, Client language, Currency read-only, Timezone read-only), Account (3 buttons + note '2FA/API tokens/profile pics are CUT not stubbed'), Billing (Single package·active + 'Managed in Shopify' link), Data & maintenance (snapshot rows w/ Re-sync), Preferences (inline range/compact/heatmaps), Danger zone (danger-bordered)
- TEAM (separate page): title + dark Invite member button; members table w/ mono header MEMBER/ROLE/BUSINESS ACCESS/LAST ACTIVE, inline role select + Remove; 'Client identities' section; Pending invites row w/ caution expiry + Copy link/Revoke + purple --auto pill 'email delivery NEEDS-SERVER-CONTRACT'; invite modal (420px) w/ role toggle buttons + role note
- INSIGHTS restyle: title + 'restyle only' pill, 3 tabs (Analytics/AI Visibility/SEO), single dense table PAGE/SESSIONS 28D/CONV.RATE/REVENUE w/ mono header, tabular nums, missing rendered as '—'

**Missing or wrong (severity — structure):**
- **[blocker] HOME cross-platform overview**
  - reference: Provider status-pill row, 3 pinned KPI sparkline cards, Meta summary + Google dashed connect CTA, Expenses card, and grounded Daily-brief card with [evidence] mono chips.
  - current: Entirely absent from the audited workspace file set — there is no cross-platform home page implementing this composition. Only per-platform surfaces exist.
- **[major] Global page header pattern**
  - reference: No per-page hero header; each screen opens directly with a 16px section title inline with controls, under a shared 46px top bar + 196px nav rail.
  - current: The audited Workspace routes now use `WorkspaceSurface` instead of `ProductPageShell`, with 16px titles and dense actions. Still open: the exact reference standalone topbar/nav split is approximated by the global dashboard shell, and several child cards still carry old component internals.
- **[major] REPORTS tab bar + Builder**
  - reference: Inline underline tabs 'Saved & templates' / 'Builder'; Builder is a 4-col widget canvas with a 250px right config panel, all on one screen.
  - current: app/(dashboard)/reports/page.tsx now uses the dense Workspace shell, narrower grid, dashed template cards, mono widget/output labels, and tokenized empty/error states. Still open: no inline Saved/Builder tab bar, Builder remains separate at /reports/new, and search/sort UI remains a non-reference addition.
- **[major] SETTINGS — stubbed 2FA / API tokens**
  - reference: Reference explicitly states '2FA, API tokens and profile pictures are cut, not stubbed — only what works is designed.'
  - current: fixed in this slice. The profile-picture card and the non-working 2FA/API/session-browser stubs were removed. Security now shows only the working revoke-all-sessions action plus an explicit cut-not-stub note.
- **[major] TEAM — Client identities section**
  - reference: A distinct 'Client identities — separate from roles, one business each' block listing scoped client logins.
  - current: Team now shows a distinct Client identities card, but it is intentionally marked `NEEDS-SERVER-CONTRACT` because no scoped client-identity backend model exists. Honest gap, not functional parity.
- **[major] TEAM — purple --auto server-contract pills**
  - reference: Pending invite row carries a purple --auto pill 'email delivery NEEDS-SERVER-CONTRACT'; automation/auto semantics use the purple triplet.
  - current: Purple `--auto` contract pill now exists on the Client identities gap card. Still open: pending invite rows do not yet carry the exact email-delivery `NEEDS-SERVER-CONTRACT` pill.
- **[major] TEAM layout model**
  - reference: Single scrolling screen: members table (inline role select + Remove), client identities, pending invites, plus a 420px invite modal with role toggle buttons.
  - current: Team now uses the dense Workspace shell and tokenized tables, and the client-identity gap is visible. Still open: members/invites remain tabbed, role/remove stay behind a dropdown, and the invite modal still uses multi-workspace selection rather than the 420px reference role-toggle modal.
- **[major] Platform-family beta/soon surfaces**
  - reference: calm not-connected/degraded/provider status vocabulary, honest connect CTA, no empty charts, and no dead write affordances.
  - current: `ComingSoonState` now uses a tokenized readiness surface with platform context, connection/execution/data rows, Integrations link, and explicit no-write/no-zero copy across Google/Klaviyo beta/soon routes. Still open: no provider-specific business status row, no real freshness timestamp, and no account-picker/assignment state on these placeholder routes.
- **[major] INTEGRATIONS group labels + summary**
  - reference: Mono uppercase group captions (ADVERTISING / ADVERTISING·MORE / ANALYTICS); no KPI summary tiles.
  - current: integrations/page.tsx now uses the dense Workspace shell, 3-col provider grid, tokenized status/context chips, and compact summary tiles. Still open: group labels are not the exact mono uppercase taxonomy, summary tiles and active-business chip remain non-reference additions, and provider cards still depend on the older component internals.
- **[minor] SETTINGS — Billing**
  - reference: Minimal: 'Single package · active' with a 'Managed in Shopify ↗' link.
  - current: Settings page renders a heavy Plan & Billing block with a 4-plan comparison grid (PLAN_ORDER map, lines 670-709) in rounded-xl blue-tinted cards — far beyond and off-language from the reference's one-line link.
- **[minor] SETTINGS/TEAM boundary**
  - reference: Team is its own dedicated screen; Settings contains no team management.
  - current: Team management is duplicated: a full Team section lives inside settings/page.tsx (lines 829-949) AND a separate app/(dashboard)/team/page.tsx exists. Reference keeps them separate; impl forks them.
- **[minor] TARGETS & ECONOMICS visual language**
  - reference: Simple flat cards at 6-10px radius, ink1 dark save button, mono WHAT-IF ROAS table, dotted coverage rows on canvas tokens.
  - current: components/settings/commercial-truth-settings.tsx does implement Coverage, Break-even, Target ROAS, a ROAS scenario matrix and a dirty save bar, but in rounded-2xl/rounded-xl cards with amber/rose/emerald Tailwind and a dark gradient scenario table — correct information architecture, wrong token system, and far more elaborate than the reference's lean layout.
- **[minor] INSIGHTS restyle pill**
  - reference: Header carries a pill 'restyle only — same information architecture, new tokens'.
  - current: insights/layout.tsx now uses `WorkspaceSurface` and a `restyle only` pill with tokenized tabs. Dense child tables still need route-by-route verification.

**Visual/token mismatches:**
- Typeface: reference `'IBM Plex Sans' body + 'IBM Plex Mono' for ALL numerics/table headers/timestamps` vs current `Geist Sans / Geist Mono (globals.css:179,187); mono headers use uppercase tracking Tailwind, not IBM Plex Mono`
- Base type scale: reference `13px base, 1.45 line-height, 16px section titles` vs current `ProductPageShell h1 at 22–24px; section titles 15px; Tailwind text-sm/text-xs scale`
- Card radius: reference `6–8px (dense/tight), cards 10px max` vs current `rounded-xl (12px) and rounded-2xl (16px) throughout settings/commercial-truth/integrations; --r-lg 11px`
- Accent / primary: reference `--focus #1E62D0 blue, ink1 #1A1C1F dark solid buttons, purple --auto #6C41BE for automation pills` vs current `--brand #2f6bff (globals.css:147); blue-50/blue-600 plan cards; no purple --auto usage anywhere`
- Canvas / surface: reference `--s1 #F5F5F3 warm canvas, --s2 #FFFFFF cards, --s3 #EDEDEA hover` vs current `--surface #fff, --surface-2 #fafafb cool grey, neutral-50/neutral-200 slate scale`
- Status pills: reference `999px pills with colored dot + semantic fg/bg/bd triplet (pos/caution/danger/info)` vs current `rounded-md neutral badges and emerald/amber/rose Tailwind Badges; SummaryTile 3xl numbers not in reference`
- Header chrome: reference `46px top bar + 196px nav rail, fixed save bar offset left:196px` vs current `No dense top bar/rail in these files; per-page ProductPageShell hero with border-b`
- Generic platform tables no longer invent `$`, but they still lack row-level provider currency; this remains a backend/data-contract gap.

**Top fixes (highest leverage first):**
1. Build the missing HOME cross-platform overview (provider status-pill row, 3 pinned KPI sparkline cards, Meta summary + Google dashed connect CTA, Expenses card, grounded Daily-brief with [evidence] mono chips) — currently absent.
2. Replace ProductPageShell hero + rounded-xl/2xl ProductSection wrappers with the reference dense chrome: 46px top bar, 196px grouped nav rail, 16px inline section titles, 6-10px radii, flat cards on --s1/--s2 canvas.
3. Swap the token/type system to IBM Plex Sans + IBM Plex Mono (mono for every numeric/table-header/timestamp), --focus #1E62D0, ink1 dark buttons, and the purple --auto pill for server-contract/automation states.
4. Reports: add the 'Saved & templates / Builder' underline tab bar and bring the 4-col Builder canvas + 250px Widget config panel onto the page; drop the non-reference search/sort and swap template cards to dashed TEMPLATE cards.
5. Settings: remove the stubbed 2FA / API tokens / profile-picture 'Coming soon' cards (reference bans stubs), collapse Billing to the 'Managed in Shopify' link, and stop duplicating Team inside Settings.
6. Team: switch to the single-scroll layout with inline role select + Remove, add the 'Client identities' section, and add the purple --auto 'email delivery NEEDS-SERVER-CONTRACT' pill on pending invites.
7. Integrations: convert group headings to mono uppercase captions, drop the 3xl SummaryTile stats and 'Active business' chip, and render honest inline 'soon' text instead of dimmed cards where no real connect exists.
8. Add row-level account currency to `PlatformTableRow`/provider services and then restore true localized money formatting; until then keep `currency —`.

**Impl files:** `app/(dashboard)/reports/page.tsx`, `app/(dashboard)/settings/page.tsx`, `app/(dashboard)/team/page.tsx`, `app/(dashboard)/integrations/page.tsx`, `app/(dashboard)/commercial-truth/page.tsx`, `app/(dashboard)/insights/layout.tsx`, `components/ui/product-surface.tsx`, `components/settings/commercial-truth-settings.tsx`, `components/states/ComingSoonState.tsx`, `components/platform-table-page.tsx`, `app/globals.css`

## 02 Creative Studio — 45% (partial)

**Reference structures the surface must have:**
- Topbar (46px: ink square logo, Adsecute wordmark, business switcher pill, Decisions link)
- Left nav rail 196px (PLATFORM · META group; Decisions / Creative Studio / Launchpad / Automation)
- Layer-1 context bar (title + 'Analysis only' pill + mono 'window last 28d · synced 42m ago' + 'buyer decision language' checkbox toggle)
- Layer-2 mode toggle bar (underline tabs Library / Copy / Compare + disabled Angles & Usage Map auto pills + preset select + Customize + Hide gallery + CSV + dark Share)
- Dense inline metric summary strip (Creatives / Spend 28d / Mean ROAS on one bordered row)
- Filter row (Status / Campaign kind selects, search, server-ranked pill)
- Gallery grid (auto-fill minmax 170px, checkerboard media, fmt pill top-left, video ▶ badge, name + spend/roas)
- Sortable metric table (56px thumb | CREATIVE | SPEND 28D▾ | ROAS | CPA | THUMBSTOP (PROXY) | HOOK SCORE(+client auto pill) | DECISION[buyer-gated])
- Table footer ('Showing 5 of 5 …' + 'Compare 3 selected' button)
- Copy view (group-by pills, horizontal copy-compare cards, heat-tinted ROAS/CTR copy table, heat legend)
- Copy drawer 380px (full pre copy, VARIANTS, PROVENANCE copy_asset_type/copy_source, RAN ON N CREATIVES thumbnails, PER-CONTEXT METRICS)
- Compare overlay modal 900px (120px label col + 3 creative cols, thumbnail header row, metric rows with deltas vs baseline)
- Share modal 480px (Buyer/Creative team/External audience buttons, audience note, Anonymize + Allow CSV checkboxes, frozen/expires/opens, language, Preview feedback / Preview page+PDF / Copy link)
- Public share page + PDF layout
- Creative-team feedback package (retention bar chart, WORKS/AVOID production brief cards, reserved angle slot)
- Bottom-center toast stack

**Missing or wrong (severity — structure):**
- **[major] Layer-2 mode toggle bar**
  - reference: In-page underline tab buttons Library / Copy / Compare (border-bottom:2px ink on active, weight 600), all three modes rendered inside the SAME screen; Compare is a mode of this surface.
  - current: Rendered as filled pill buttons (btn--sm, active = btn--primary) that are Next Links navigating to SEPARATE routes (/copies, /landing-pages, /creative-inbox, /audiences). No underline-tab treatment, no in-page Compare mode on the creatives surface at all. Adds Landing pages/Inbox/Audiences tabs not in the reference mode bar.
- **[major] buyer decision language toggle + DECISION column**
  - reference: Layer-1 has a 'buyer decision language' checkbox that reveals a right-aligned DECISION column (Scale/Protect/Test more/Refresh/Cut, semantically colored) in the metric table.
  - current: No buyer-language toggle anywhere. The metric table has no DECISION column. Decision labels are demoted to a passive 'Decision labels are context only' ghost chip. The entire buyer/decision-language mechanic is absent.
- **[major] Dense inline metric summary strip**
  - reference: A single bordered card, 8px radius, one flex row: 'Creatives 5 · Spend 28d 6,410 EUR · Mean ROAS 2.12x' with small ink3 caption — operator-dense.
  - current: Replaced by a 4-up grid of large StudioMetric cards (Visible creatives / Selected / Visible spend / Preview coverage) with 18px numbers and uppercase micro-labels. Different metrics, different (spacious card-grid) composition, wrong altitude.
- **[major] Sortable metric table columns**
  - reference: Fixed operator column set: 56px thumbnail, CREATIVE (name + fmt pill + sub), SPEND 28D (sorted ▾), ROAS, CPA, THUMBSTOP (PROXY), HOOK SCORE with an inline client-computed auto (purple) provenance pill, DECISION (buyer-gated). Thumbnail is a ratio-true checkerboard swatch.
  - current: Generic configurable CreativesTableSection driven by DEFAULT_TOP_METRIC_IDS = spend, roas, thumbstopRatio, purchaseValueShare, purchases. No CPA/HOOK SCORE/DECISION in the default set, no per-cell client auto-provenance pill on hook, no fixed 56px ratio-true thumbnail column contract. Column grammar does not match.
- **[major] Copy drawer (380px)**
  - reference: Right drawer titled 'Copy detail': full copy in a pre block, VARIANTS (headline/description), PROVENANCE (copy_asset_type / copy_source), 'RAN ON N CREATIVES' with thumbnail strip, PER-CONTEXT METRICS with the max-1-context honesty note.
  - current: ReadOnlyCreativeDrawer is a 520px CREATIVE-detail drawer instead: render surface + 6-cell Performance grid + context chips + copyText + a Notes textarea + 'Open in Decisions' footer. None of the copy-drawer sections (VARIANTS / PROVENANCE / RAN ON N / PER-CONTEXT) exist; it answers a different question and adds a notes affordance not in the reference.
- **[major] Compare overlay**
  - reference: Creatives surface has a Compare mode/overlay: 900px modal, 120px label column + 3 creative columns, thumbnail header row (ratio-true), metric rows (Spend/ROAS/CPA/Thumbstop/Copy) with deltas vs the first column as baseline, review-only note.
  - current: No compare overlay on the creatives page. A 'Compare 3 selected' table-footer button does not exist. (A CopyCompareOverlay exists only on the separate copies page and is a different, copy-oriented layout.)
- **[major] Share modal**
  - reference: 480px modal: three audience selector buttons (Buyer / Creative team / External) with a per-audience explanation note, 'Anonymize campaign names' + 'Allow CSV download' checkboxes, frozen-at/expires/opens line, client-language line, and three actions Preview feedback package / Preview page + PDF / Copy link (dark).
  - current: The Share button calls handleShareExport which immediately POSTs to /api/creatives/share with hardcoded audience 'creative_team', includeDecisionLanguage:false, allowCsv:true — no audience selection UI, no anonymize/CSV toggles, no feedback/PDF preview branch surfaced from this page. A ShareCreativesModal component exists but the audience/preview grammar of the reference is not wired into the studio Share flow shown here.
- **[minor] Gallery cards**
  - reference: auto-fill minmax(170px) grid; each card media area uses the creative's own aspect-ratio (9/16, 4/5, 1/1) as a checkerboard, with a fmt pill (VID/IMG/CAR) top-left and a ▶ badge bottom-right for video; footer shows spend + colored roas.
  - current: StudioGallery forces aspect-square on every card regardless of true ratio, has no fmt overlay pill and no video ▶ badge, and is wrapped in an extra titled 'Gallery' section card with its own header/subtitle + 'N preview cards' chip that the reference does not have. Uses real render surface (fine) but ratio-true framing and format affordances are lost.
- **[minor] Topbar + left nav rail**
  - reference: Surface-specific 46px topbar (ink square + Adsecute + business switcher pill + Decisions link) and a 196px 'PLATFORM · META' rail listing Decisions/Creative Studio/Launchpad/Automation.
  - current: Neither is present on the page; it relies on the generic dashboard shell. The page instead opens with a rounded-11px header card (crumbs 'Platforms · Meta' + page-title + info chip). Chrome grammar differs from the reference console.
- **[minor] Public share page / PDF + feedback package views**
  - reference: Reference defines full frozen public share page (cover line, period, highlight cards, metrics-vs-frozen-baseline table, as-of stamp), matching PDF grammar, and a creative-team feedback package (retention quartile bars, WORKS/AVOID production-brief cards, reserved angle slot).
  - current: Not part of this page; served by separate share routes not audited here. Cannot confirm they reproduce the reference share/feedback grammar from this surface.

**Visual/token mismatches:**
- Type family: reference `IBM Plex Sans for text, IBM Plex Mono for ALL numerics/labels` vs current `Geist Sans / Geist Mono (var(--font-geist-sans/mono)) in app/globals.css:179,187`
- Base sizing: reference `13px base, line-height 1.45, dense operator console` vs current `TW-calm scale with 18px summary numbers, roomier card grids; no 13px/1.45 base contract`
- Canvas / surface tokens: reference `--s1 #F5F5F3 canvas, --s2 #FFFFFF cards, --s3 #EDEDEA hover` vs current `--surface #ffffff, --surface-2 #fafafb, --surface-3 #f2f3f5 (globals.css:135-137) — cooler/whiter, different values`
- Primary action color: reference `Dark ink #1A1C1F fill (Share/Copy link buttons are ink, no blue)` vs current `--brand #2f6bff blue primary (globals.css:147); btn--primary uses ink but overall system introduces a blue brand absent from reference`
- Radius: reference `6–8px tight/dense on cards, tables, pills` vs current `--r-lg 11px on header/section cards (globals.css:169); rounded-[var(--r-lg)] wrappers read softer/larger than reference`
- Auto/automation accent: reference `--auto #6C41BE / bg #F2EDFB / bd #D9CCF1 purple, used on hook-score provenance and Angles/Usage-Map pills` vs current `chip--auto exists (globals.css:371) and is used on Angles/Usage Map chips, but the per-row hook-score client provenance pill is not rendered in the table`

**Top fixes (highest leverage first):**
1. Convert the mode bar to real in-page underline tabs (Library / Copy / Compare) instead of filled pills that route to separate pages; bring Copy and Compare back onto the Studio surface.
2. Restore the buyer-decision-language toggle in the context bar and the buyer-gated DECISION column (Scale/Protect/Test more/Refresh/Cut) in the metric table.
3. Fix the metric table column contract to the reference set (thumb 56px | CREATIVE | SPEND 28D▾ | ROAS | CPA | THUMBSTOP proxy | HOOK SCORE + client auto pill | DECISION), including the inline hook-score provenance pill.
4. Replace the 4-up StudioMetric card grid with the reference single dense inline summary strip (Creatives / Spend 28d / Mean ROAS).
5. Build the Compare overlay (900px, 120px label col + 3 creative cols, deltas vs baseline) and wire the 'Compare N selected' table-footer button.
6. Rework the drawer into the Copy detail drawer (full copy pre + VARIANTS + PROVENANCE + RAN ON N + PER-CONTEXT), or add it alongside the creative drawer; drop the notes textarea that is not in the reference.
7. Wire the Share button to the audience-selector Share modal (Buyer/Creative team/External + anonymize/CSV toggles + Preview feedback / Preview page+PDF / Copy link) rather than an immediate hardcoded POST.
8. Make gallery cards ratio-true with fmt pill + video badge instead of forced aspect-square, and drop the extra titled Gallery section wrapper.
9. Swap the design tokens toward the reference system: IBM Plex Sans/Mono, 13px/1.45 base, --s1/s2/s3 surfaces, ink (not blue) primary, 6–8px radii.

**Impl files:** `app/(dashboard)/platforms/meta/creatives/page.tsx`, `app/(dashboard)/platforms/meta/copies/page.tsx`, `components/creatives/creatives-top-section-support.ts`, `components/creatives/metricConfig.ts`, `components/creatives/CreativesTopSection.tsx`, `components/creatives/CreativesTableSection.tsx`, `app/globals.css`

## 01 Decisions (Meta Decision Center) + Inspector — 66% (partial)

> Slice update, 2026-07-08: Meta Decisions has new verified progress, but the surface remains **open**. Verified by `npx vitest run components/meta/redesign app/api/meta/decisions-workspace/route.test.ts` (110/110), targeted reviewer/write hardening tests (`97/97`), targeted row-anatomy tests (`npx vitest run lib/meta/__tests__/rec-presentation.test.ts components/meta/redesign/MetaActionCard.test.tsx components/meta/redesign/MetaPlatformPage.test.tsx app/api/meta/lane-classify/route.test.ts`, 88/88), `npm run typecheck`, `npm run lint`, `git diff --check`, and `FULL_UI_SMOKE_VISUAL_ONLY=1 FULL_UI_SMOKE_SCREENSHOTS=meta-decisions node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` (2/2). New visual artifacts: `docs/full-ui-redesign/playwright-smoke-artifacts/test-results/full-ui-redesign-smoke-ful-5706d-ures-representative-visuals-full-ui-desktop/full-ui-desktop-meta-decisions.png`, `docs/full-ui-redesign/playwright-smoke-artifacts/test-results/full-ui-redesign-smoke-ful-5706d-ures-representative-visuals-full-ui-desktop/full-ui-desktop-meta-decisions-inspector.png`, and `docs/full-ui-redesign/playwright-smoke-artifacts/test-results/full-ui-redesign-smoke-ful-5706d-ures-representative-visuals-full-ui-mobile/full-ui-mobile-meta-decisions.png`.
>
> What improved: the inspector now renders the reference 14-section spine (`1 · DECISION CONTRACT` through `14 · RAW JSON`) with raw/published/hysteresis rows, WHY citation chips, precedent missing-state, confidence, automation readiness, blockers, maturity, ad set depth, creative evidence, entity timeline, notes/protection, provenance, and raw JSON. The smoke now opens the real `MetaDrillDrawer` from the real decision row instead of only screenshotting the queue. The page also has verified mono group headers / anomaly as-of contract (`data-testid="meta-anomaly-asof"`), a non-colliding `MetaWorkspacePostureBanners` stack for served/fallback workspace posture rows, a real action row seeded through the ephemeral DB contract, and a server-composed reviewer/read-only posture from `viewer` that downgrades write controls to evidence review. Reviewer/read-only is now enforced beyond the UI for state-changing paths: snapshot refresh, operator responses, triage events, campaign-label writes, Meta provider writes, and Launchpad write routes return `reviewer_read_only` before persistence/provider calls. Row anatomy now has a server-owned `rowPresentation` contract and renders the reference checkbox + 14px blocker/shield signal slot, mono account badge when the serving row has `accountId`, compact purple `auto` pill when automation is truly `auto_execute`, and a purple protection/blocker warn line.
>
> Additional slice update, 2026-07-08: the large amber `Decision readiness needs attention` card has been collapsed into a reference-style thin readiness/status stack with separate server-truth rows for campaign labels, target pack, and snapshot freshness. `rowPresentation` is now recomputed at read time instead of preserving a stale persisted presentation object. Verified by `npx vitest run components/meta/redesign/MetaPlatformPage.test.tsx components/meta/redesign/MetaActionCard.test.tsx lib/meta/__tests__/rec-presentation.test.ts` (65/65), `npm run typecheck`, `git diff --check`, and the Meta Decisions Playwright visual smoke (2/2). Screenshot check confirms the old large readiness card is gone.
>
> Additional slice update, 2026-07-08: `MetaOvernightDigest` is now a reference-style expandable strip backed by the Decisions workspace server contract. The API composes label flips from `meta_decision_snapshots_daily`, verified/silent_failure write outcomes from `meta_ads_action_log`, anomaly opens from anomaly snapshots, and due deferrals from `meta_decision_responses`; the UI does not derive action outcomes client-side. Verified by `npx vitest run app/api/meta/decisions-workspace/route.test.ts components/meta/redesign/MetaPlatformPage.test.tsx` (47/47) and `npm run typecheck`. Remaining digest gap: Meta Decisions snapshots do not persist a separate raw-vs-published label stream, so raw pending-transition detail is honestly absent rather than fabricated.
>
> Additional slice update, 2026-07-08: the Decisions main chrome is now pinned to the design ZIP token/type language: `.ad-final` legacy variables alias the `--adc` surface/ink/semantic/auto triplets, base type is IBM Plex Sans 13px/1.45, mono slots use IBM Plex Mono, negative tracking was removed, topbar/lane/filter/digest/row density was tightened, and the visible `MetaPlatformPage` helper states no longer use Tailwind slate/blue/violet color classes. Verified by `npm run typecheck`, `npm run lint`, `npx vitest run app/api/meta/decisions-workspace/route.test.ts components/meta/redesign/MetaPlatformPage.test.tsx components/meta/redesign/MetaActionCard.test.tsx` (62/62), `git diff --check`, protected-path audit, and `FULL_UI_SMOKE_VISUAL_ONLY=1 FULL_UI_SMOKE_SCREENSHOTS=meta-decisions node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` (2/2 after a transient first-run 504). This is visual parity progress only; no decision/action/write behavior changed.
>
> Additional slice update, 2026-07-08: Meta Decisions mobile is now a real page-owned read-only composition instead of the old shell placeholder. It renders the selected business context, snapshot freshness, active anomaly state, server-provided action/watch rows, confidence pill, "Read evidence" affordance, and a mobile evidence screen with citation chips backed by real `rec.evidence` or anomaly diagnostics plus an "Act on desktop" notice. `DashboardFrame` no longer hides `/platforms/meta` behind the generic `.ad-console-mobile-stage`. Verified by `npx vitest run components/meta/redesign/MetaPlatformPage.test.tsx components/layout/shell-redesign.test.tsx` (48/48), `npm run typecheck`, `npm run lint`, `git diff --check`, protected-path audit, and the Meta Decisions Playwright smoke (2/2) including mobile evidence click-through.
>
> Still not complete: posture banners are still not the four exact reference banners because dry-run is not a proven standing workspace state and is not rendered without a real contract; row anatomy still lacks real creative thumbnail/media provenance because Decisions recommendations do not yet carry a trustworthy media preview source; scope rail is not fully per-business rich; residual drawer/compare/archive sub-surfaces still need a full token audit; the global mobile shell/chrome still differs from the reference device-only composition; the digest still lacks raw pending-transition rows because the backend does not persist them for Meta Decisions; and the inspector still uses honest missing states where the backend does not yet persist rich precedent, creative quartiles/thumbstop, or full timeline/protection notes.

**Reference structures the surface must have:**
- Context header as-of cluster + posture chip + track-record chip ('21 of 29 judged calls improved') + 'runs today: N' + Run snapshot + New campaign
- Posture banners x4: kill switch (danger), dry-run (info), tracking-degraded (caution, dismissible), reviewer (read-only ink)
- Queue-local filter bar (lane tabs w/ counts, Deferred pill, Sort, min-spend chip, search, density toggle)
- Scope rail 236px: 'BUSINESSES · BY URGENCY' header, per-business dot+name+count, per-account spend in own currency + snap stamp, degraded+Retry error state, 'never summed' footnote
- Business pulse strip: thin single-line (Spend today vs 7d avg | ROAS 7d vs target+source | track chip) + 'tones from this business's server targets'
- Overnight digest: collapsible 'Since last snapshot' with label flips / actions verified / anomaly opened / deferrals due back
- Anomalies section: mono 'ANOMALIES · 1 · counted separately' header + 'anomaly scan as of' + caution card w/ diagnostic-ladder sub + Open diagnostic
- Decision row GROUPS: mono group titles ('CAMPAIGNS & AD SETS · N', 'CREATIVES · N') + per-group note + optional explain/CTA; watching SEGMENT groups
- Decision ROW (dense single line): checkbox + blocker-square/purple-shield icon + creative thumb (26x46 hatched) + name + mono acct badge + purple 'auto' pill + sub + colored label + mono money + confidence bar-chart pill + action button + ⋯ menu
- Expandable ⋯ menu row (Defer 24h / Compare / Open in Ads Manager / Copy entity ID) + purple warn line for operator protection
- Inspector 480px inline ≥1440px else overlay drawer, 14 mono-numbered sections (1·DECISION CONTRACT raw/published+hysteresis … 14·raw JSON), WHY grounded-summary w/ inline citations, Precedent, Creative evidence (quartiles/thumbstop), Entity timeline, Notes & protection, act-and-advance footer
- Config-delta / tracking-gate / bulk confirm modals; write-state machine (Writing…→verified); toasts w/ actor + Audit Trail link
- Onboarding empty states: not-connected / first-sync / no-decisions-yet
- Design system: IBM Plex Sans + IBM Plex Mono (mono for ALL numerics), 13px/1.45, tokens s1/s2/ink1-3/b1-2, purple --auto, 6-8px radius, ink-based primary button

**Missing or wrong (severity — structure):**
- **[major] Posture banners (kill switch / dry-run / reviewer)**
  - reference: 01 Decisions.dc.html:125-150 renders four distinct posture banners: kill_switch (danger, 'All writes disabled'), dry_run (info, 'Writes are simulated'), tracking-degraded (caution, dismissible), reviewer (ink, 'read-only access'). Driven by writePosture/role props.
  - current: `MetaWorkspacePostureBanners` now renders server/fallback posture rows in priority order. Kill switch links to `/platforms/meta/automation`; tracking hide copy explicitly says it does not unlock writes. Reviewer/read-only is now driven by `MetaDecisionsWorkspacePayload.viewer`, sourced from session + membership + reviewer-access. UI controls downgrade to `Review evidence`, and server write endpoints reject reviewer state-changing calls with `reviewer_read_only`. Remaining gap: dry-run is not rendered unless the server serves a real standing workspace posture; if dry-run remains only a per-request write flag, the reference dry-run banner is not a truthful production state.
- **[major] Overnight digest ('Since last snapshot')**
  - reference: 01 Decisions.dc.html:221-235 — collapsible strip summarizing label flips (published/raw), actions verified/silent_failure, anomalies opened, deferrals due back, with expand detail rows.
  - current: `MetaOvernightDigest` now renders a thin expandable "Since last snapshot" summary and detail rows from `MetaDecisionsWorkspacePayload.digest`. Server sources: `meta_decision_snapshots_daily` label transitions, `meta_ads_action_log` verified/silent_failure outcomes, anomaly snapshots, and `meta_decision_responses` due deferrals. Remaining gap: raw-vs-published pending transition rows are absent because Meta Decisions currently persists only served/published snapshot labels.
- **[major] Mono row-group headers + Anomalies 'counted separately'**
  - reference: 01 Decisions.dc.html:248-266 — anomalies get a mono header 'ANOMALIES · 1 · counted separately'; decision rows are wrapped in mono group titles 'CAMPAIGNS & AD SETS · N' and 'CREATIVES · N' with per-group notes (fmtGroups, lines 472-495).
  - current: `MetaLaneGroupHeader` now renders `ANOMALIES · N · counted separately` with `data-testid="meta-anomaly-asof"` and `CAMPAIGNS & AD SETS · N` for decision rows. Remaining gap: no `CREATIVES · N` group, no full per-group explain/CTA treatment, and group typography still only partially matches the reference.
- **[major] Business pulse strip**
  - reference: 01 Decisions.dc.html:211-219 — a thin single-line strip: 'Spend today <b> vs 7d avg' | 'ROAS 7d <b> vs target · source' | colored track chip, ending 'tones from this business's server targets'.
  - current: `FinalMetaPulse` now renders a thin `.pulse--thin` strip with spend vs 7d average, ROAS vs target, tracking chip, and the server-target footnote. Remaining gap: it still includes label coverage, snapshot/engine/lane sync metadata, and a manage-labels action inline; the reference keeps the pulse to the three business facts and moves operational metadata to the header/System Status.
- **[major] Decision row — remaining media/source fidelity gap**
  - reference: 01 Decisions.dc.html:276-317 — each row lead can show a caution blocker square or purple operator-protection shield SVG; an optional 26x46 hatched creative thumbnail; a mono account badge (e.g. 'NV-EU'); a purple '◆ auto' pill (auto-fg/auto-bg/auto-bd) for auto-executed items; and a full-width purple warn line under the row for protection notes.
  - current: `MetaRecommendation.rowPresentation` is now server-owned at read time via `annotateMetaRecPresentation`; `MetaActionCard` renders the separate checkbox slot, 14px blocker/shield signal slot, mono account badge from serving `accountId`, compact purple `auto` pill only for `auto_execute`, and a full-width purple warn line. Remaining gap: creative thumbnail remains absent unless a real server media source provides `thumbLabel`; no fake thumbnail is rendered. Row grouping/spacing/menu treatment is closer but still not exact reference parity.
- **[major] Scope rail per-business detail + error state**
  - reference: 01 Decisions.dc.html:186-199 (+BIZ data 436-441) — every rail row shows dot, name, act count, spend in that account's own currency, snap stamp, and a degraded 'Briefing source failed · HTTP 502 · Retry' error state per business.
  - current: MetaScopeRail (MetaPlatformPage.tsx:1279-1372) shows count+spend only for the currently-selected business; all other businesses render a bare name + 'Open' with no count, spend, currency, snap, or error/Retry state. Footnote ('never summed') is present and correct.
- **[major] Inspector — 14 mono-numbered sections, contract, cited WHY, precedent, creative evidence, timeline, notes & protection**
  - reference: Inspector.dc.html defines 14 mono-numbered sections (1·DECISION CONTRACT with raw/published + hysteresis banner, 2·WHY grounded summary with inline [n] citation buttons that flash evidence, 3·MONEY, 4·PRECEDENT, 5·CONFIDENCE, 6·AUTOMATION READINESS, 7·BLOCKERS, 8·MATURITY, 9·AD SET DEPTH, 10·CREATIVE EVIDENCE quartiles/thumbstop, 11·TIMELINE, 12·NOTES & PROTECTION shield, 13·PROVENANCE, 14·raw JSON) plus an act-and-advance footer.
  - current: MetaDrillDrawer.tsx (704 lines) is a partial port: it has Money/metrics, Ad set depth, Diagnostic ladder, Evidence confidence, Automation readiness, Blockers, Provenance, an evidence accordion, and raw JSON — but uses sentence-case SectionLabel, NOT mono-numbered '1 · DECISION CONTRACT' headers. Missing: decision-contract raw/published + hysteresis, cited WHY grounded summary with flashing [n] citations, Precedent, structured Creative-evidence (quartile bars/thumbstop/lifecycle), Entity timeline, and Notes & protection.
- **[minor] Context-header posture chip + track-record chip + runs-today**
  - reference: 01 Decisions.dc.html:115-120 — header carries a posture chip, a rounded track-record chip ('21 of 29 judged calls improved · 7d windows'), and 'runs today: N' next to Run snapshot.
  - current: MetaPlatformPage.tsx:2202-2214 header has only the as-of cluster, Run snapshot, and New campaign. grep confirms no track-record chip, no posture chip, no 'runs today' counter.
- **[minor] Onboarding empty states (not-connected / first-sync)**
  - reference: 01 Decisions.dc.html:326-354 — three distinct full-screen states: Connect Meta, First sync in progress (per-step spinner), Connected-needs-7-days.
  - current: Only a data-readiness banner and EmptyActionState (no-decisions) exist. No dedicated not-connected 'Connect Meta to start' screen and no first-sync progress screen in this surface.

**Visual/token mismatches:**
- Font family: reference `'IBM Plex Sans' for text + 'IBM Plex Mono' for ALL numerics/IDs/badges (01 Decisions.dc.html:11,13)` vs current `.ad-final` and the visible Decisions main helper states now use IBM Plex. Remaining risk: drawer/compare/modal sub-surfaces still need the same strict audit.
- Base type scale: reference `13px / line-height 1.45, dense operator console` vs current `.ad-final` base, topbar, lane tabs, filter bar, digest and rows are now denser; some secondary card/table/drawer shells still use mixed 11-14px sizing.
- Primary action color: reference `ink-based primary button (bg var(--ink1) #1A1C1F); blue reserved for info/route only` vs current `btn--primary` is ink and legacy `--brand` now aliases `--adc-focus`; info links still use blue as intended.
- Automation/auto pill color: reference `purple triplet --auto-fg #6C41BE / --auto-bg #F2EDFB / --auto-bd #D9CCF1 with a rotated-square glyph` vs current `meta-row__auto` uses the purple auto triplet and rotated square for true auto-execute rows.
- Corner radius: reference `6-8px tight/dense` vs current main Decisions chrome is tightened to 6-8px, but some modal/drawer/creative-evidence shells still keep larger radii from the earlier implementation.
- Canvas/card tokens: reference `--s1 #F5F5F3 canvas / --s2 #FFFFFF cards / --s3 #EDEDEA hover / warm neutral borders b1 #E4E4E0` vs current `.ad-final` aliases `--surface`/`--border` to the `--adc` triplets; residual token drift can remain in subcomponents outside the first-viewport Decisions queue.

**Top fixes (highest leverage first):**
1. Confirm whether dry-run is a real standing workspace posture. If yes, expose it in the Decisions workspace contract; if not, keep it unrendered and mark the design artifact as non-production.
2. Strip the remaining extra metadata out of `FinalMetaPulse` or move it into the header/System Status so the pulse is exactly the three reference facts.
3. Keep the new readiness stack but decide whether label/target/snapshot rows should be elevated into the global posture stack or stay queue-local; do not reintroduce a large independent card.
4. Finish per-row fidelity by adding a real creative/media presentation source for `thumbLabel` and matching the reference row grouping/menu spacing exactly; do not render fake thumbnails.
5. Fill the scope rail's non-selected rows with per-business act count + spend in own currency + snap stamp + degraded/Retry error state.
6. Add the missing `CREATIVES · N` row group and the full per-group explain/CTA treatment.
7. Add a real raw-vs-published pending-transition source if Meta Decisions needs the reference's raw label detail; otherwise keep the digest explicit that only served/published snapshot flips are known.
8. Finish the residual token audit in drawers, compare modal, label modal, archive table, and adjacent Meta components; the main Decisions queue is now on IBM Plex / `--adc`, but this is not a whole-surface closure.

**Impl files:** `app/api/meta/decisions-workspace/route.ts`, `components/meta/redesign/MetaPlatformPage.tsx`, `components/meta/redesign/MetaActionCard.tsx`, `components/meta/redesign/MetaDrillDrawer.tsx`, `components/meta/redesign/types.ts`, `lib/meta/recommendations.ts`, `lib/meta/rec-presentation.ts`, `app/api/meta/lane-classify/route.ts`, `app/globals.css`

## 03 Launchpad (Meta guarded write-surface: index + wizard + progress/partial-failure states) — 65% (partial)

> Slice update, 2026-07-08: Launchpad now has a reference-shaped local context row, a visible upload/media-pipeline contract region, mono engine-label vocabulary including `out_of_scope`, dashed placeholder chips for auto-recent templates, a static `SERVER VALIDATION · real blocker vocabulary` line, collapsed-by-default raw launch JSON, a compact sticky footer math line that remains visible on Review, and separate progress banners for partial HALT, `silent_failure`, and 409 in-flight states. Verified by `npx vitest run app/(dashboard)/platforms/meta/launchpad/page.test.tsx components/launchpad/LaunchpadCreativeSelection.test.tsx components/launchpad/LaunchpadReview.test.tsx components/launchpad/LaunchpadProgress.test.tsx` (15/15), `npm run typecheck`, `npm run lint`, `git diff --check`, protected-path audit, and `FULL_UI_SMOKE_VISUAL_ONLY=1 FULL_UI_SMOKE_SCREENSHOTS=launchpad node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` (desktop+mobile 2/2). Visual check: desktop is closer to the reference index; global dashboard shell still wraps it. This is progress, not closure.

> Double-chrome correction, 2026-07-08: Launchpad's duplicated internal `Adsecute` brand/topbar was replaced with a local context row under the single global console topbar. The context row keeps `Launchpad`, business/currency, guarded-write caution, creative-window freshness, and Decisions link, but the static `writes enabled` claim is now `writes guarded` because Launchpad does not yet hydrate a route-specific kill-switch/write-posture read model. Verified with the same double-chrome smoke and static checks listed in the Shared shell update. This lifts the recurring shell mismatch slightly; it does not solve media upload or topbar freshness/write-posture backend contracts. The mobile specificity gap was reduced in the following slice, not closed to full wizard parity.

> Mobile slice update, 2026-07-08: Launchpad now owns a page-specific mobile read-only screen (`data-testid="meta-mobile-launchpad"`) instead of the generic Meta fallback. It renders guarded launch state, PAUSED launch copy, current mode/step/selected-count context, draft/template counts, the media-pipeline `NEEDS-SERVER-CONTRACT` gap, and the honest `write posture is guarded, not hydrated` state. Mobile does not render launch, upload, pause/resume, retry, or status-write controls. Verified by targeted vitest (17/17), typecheck, lint, protected-path audit, and Automation/Launchpad visual smoke (desktop+mobile 2/2). It remains partial because upload/media backend, route-specific write posture, Launchpad mobile wizard detail, and progress evidence are still incomplete.

**Reference structures the surface must have:**
- Global 46px operator top app bar: Adsecute logo mark + 'Launchpad' + guarded-write caution pill + right-side mono 'creative window: fixed 28d · synced 42m ago' + 'writes enabled' pos pill w/ dot + '← Decisions' link
- INDEX: 3 mode cards (grid), Drafts card (failed draft renders stored server error verbatim in mono), Templates card (Auto pill + dashed 'placeholder — set at use' mono chips), footnote
- WIZARD header bar: '← modes' + title + 'Prefilled from Decisions · rebuild · 1 creative' info pill + horizontal numbered step rail on the right
- STEP Creatives: search + Status select + Format select + engine-label mono filter chips (scale/keep/refresh/cut/test_more/diagnose/out_of_scope) + vocabulary note + 'Select all matching'
- STEP Creatives: Upload dropzone (dashed, 'Upload new creative' + NEEDS-SERVER-CONTRACT purple auto pill + 'Choose files') and upload result rows (processing / failed+Retry)
- STEP Creatives: pick-row table (checkbox, striped thumbnail, name+fmt badge, fatigue/below_breakeven caution badge, colored engine label, mono right-aligned stats, engine advisory sub-row visible BEFORE selection)
- STEP Campaign/Target: new-campaign form (Advantage+, special ad categories, CBO/ABO, bid select, ad-set builder w/ pixel auto-selected/event/countries/attribution + pixel_not_active blocker) OR add-to-existing (one ad set per campaign, copy-mode radios, cross_account block, inherited-settings preview, per-creative name override)
- STEP Budget: single daily budget field + 'no spend caps' note
- STEP Review: manage bulk-status block, human-readable checklist-first, 'SERVER VALIDATION · real blocker vocabulary' enumerated line w/ ✓/— markers, collapsible '▸ raw launch JSON' toggle, Launch (paused) ink button + 'No auto-retry/no auto-rollback' note
- STEP Progress: colored-dot status rows + inline 'Ads Manager ↗' link, three distinct honest states (partial-HALT / silent_failure verify / 409 in-flight), PAUSED footnote
- Sticky footer math bar: single bold mono 'N creatives × 2 ad sets = M ads' line + selection note + Back/Continue (shown on Review too)

**Missing or wrong (severity — structure):**
- **[major] Reference topbar adapted into a local context row; still not standalone**
  - reference: Fixed 46px bar: square logo mark + 'Launchpad', a caution guarded-write pill, right-aligned mono 'creative window: fixed 28d · synced 42m ago', a green-dot 'writes enabled' pos pill, and '← Decisions' link (ref lines 23-32)
  - current: The duplicate `Adsecute` mark was removed and the row is now contextual: `Launchpad`, business/currency, guarded-write caution, `creative window: fixed 28d · synced —`, `writes guarded`, and `← Decisions`. It is still wrapped by the global dashboard topbar/sidebar, and freshness/write posture are not yet backed by a dedicated Launchpad workspace-status contract.
- **[blocker] Upload dropzone is visible but the media pipeline is still not executable**
  - reference: Dashed dropzone card 'Upload new creative' with a purple NEEDS-SERVER-CONTRACT auto pill, spec text (video 9:16/4:5/1:1 ≤4GB, image ≤30MB), 'Choose files' button, and per-file upload result rows (processing / failed + Retry) (ref lines 106-125)
  - current: Dashed upload contract card now exists with purple `NEEDS-SERVER-CONTRACT · media pipeline`, spec text, disabled `Choose files`, and an explicit no-file-staged/no-transmission row. This is honest, but not complete: no staged media metadata backend, no provider upload write, no real processing/failed upload result rows.
- **[fixed in slice] Launchpad-specific mobile read-only composition**
  - reference: Mobile surfaces should be self-contained, read-only, and should not expose write controls.
  - current: Launchpad mobile now renders a dedicated read-only device frame with PAUSED write policy, mode/draft/template state, media-pipeline gap, write-posture honesty, and desktop-only note. Remaining mismatch: it is a compact guardrail/status summary, not a full mobile Launchpad wizard/progress parity screen.
- **[fixed in slice] Review — SERVER VALIDATION vocabulary line**
  - reference: Static enumerated line 'SERVER VALIDATION · real blocker vocabulary' listing the full blocker vocabulary with ✓/— markers: campaign_name_required ✓ · budget_required ✓ · pixel_required ✓ · pixel_not_active ✓ · attribution_click_required ✓ · creative_rejected ✓ · target_adset_not_active — · billing_not_ok ✓ · meta_not_connected ✓ · cross_account_duplicate_not_supported — (ref lines 219-222)
  - current: Rendered alongside the live validation card. The live server blockers still remain source-of-truth for launch enablement.
- **[fixed in slice] Progress — three distinct honest failure states**
  - reference: Colored-dot rows plus three explicit state banners: partial-launch HALT ('New-campaign mode HALTS on failure; add-to-existing and manage continue per item'), silent_failure ('create claimed success but Meta verification cannot find ad 4 · logged to Audit Trail'), and 409 in-flight ('Launch already in flight (409)') (ref lines 233-253)
  - current: Progress rows now use colored dots, Ads Manager links say `Ads Manager ↗`, and separate banners render for partial HALT, `silent_failure`, and `launch_in_flight`/`action_in_flight`. It still depends on the backend returning the relevant typed error codes; no fake state is shown.
- **[fixed in slice] Raw launch JSON (collapsible)**
  - reference: Collapsed-by-default toggle button '▸ raw launch JSON' that expands a compact pre block (ref lines 223-224)
  - current: Rendered as a collapsed-by-default `▸ raw launch JSON` button; JSON is only shown after operator expansion.
- **[fixed in slice] Sticky footer math bar**
  - reference: Compact single bold mono line 'N creatives × 2 ad sets = M ads' + selection note; shown on Review as well as builder steps (ref lines 256-265, nextShown=!isProgress)
  - current: Footer now uses a compact mono math line and remains visible on Review. Review's primary launch action still lives inside the Review block, so the footer shows a disabled/read-only `Launch action is in review` cue instead of a second fake launcher.
- **[fixed in slice] Prefilled-from-Decisions pill detail**
  - reference: 'Prefilled from Decisions · rebuild · 1 creative' (ref line 81)
  - current: Prefill pill now includes action and creative count when the Decisions query supplies the source mode.
- **[fixed in slice] Templates placeholder chips**
  - reference: Last-launch Auto template row shows dashed mono chips 'placeholder — set at use' for budget and countries (ref lines 65-68)
  - current: Auto-recent template rows now render dashed mono `budget: placeholder — set at use` and `countries: placeholder` chips.
- **[minor] Engine-label filter vocabulary + styling**
  - reference: Mono, per-label-colored pills over the full 7-term vocabulary including out_of_scope; note 'deliberately distinct from buyerAction' (ref lines 98-104)
  - current: `out_of_scope` is present, engine pills are mono and semantically colored, and the buyerAction distinction note is rendered. Remaining mismatch: the extra `All` and `Badges` filter groups are functional additions outside the reference grammar.
- **[minor] Manage-existing review density**
  - reference: Compact block: 'Pause 3 active · Resume 1 paused', a caution activation-write note, and a mono blocked line (ref lines 201-208)
  - current: Heavier generic layout with 40px icon tiles and four 26px-number SummaryTiles (page.tsx 1502-1573) — different, lower-density composition than the reference operator console.

**Visual/token mismatches:**
- Body font: reference `IBM Plex Sans` vs current `Geist Sans (var(--font-geist-sans), globals.css 179)`
- Numeric/mono font: reference `IBM Plex Mono for ALL numerics` vs current `Geist Mono + tabular-nums (globals.css 187)`
- Base font-size / line-height: reference `13px / 1.45` vs current `14px (globals.css 180)`
- Canvas token: reference `--s1 #F5F5F3 (warm gray)` vs current `--bg #f7f8fa (cool bluish) / wizard main uses var(--bg)`
- Corner radius: reference `6-8px tight/dense (NOT rounded-xl)` vs current `--r-lg 11px; cards rounded-[10px]/[12px] (page.tsx 1010, 1622, 1646)`
- Automation/auto pill purple: reference `--auto #6C41BE / bg #F2EDFB / bd #D9CCF1` vs current `--purple #6d28d9 / bg #f5f3ff / bd #ddd6fe (globals.css 163-165) — close but off-hue`
- Focus/accent: reference `blue --focus #1E62D0 used only for focus rings; primary action is near-black ink1` vs current `--brand #2f6bff blue as pervasive accent; primary btn correctly uses --ink (near-black), OK`

**Top fixes (highest leverage first):**
1. Decide and implement the real media upload contract: staged media metadata, provider upload write boundaries, processing/failed result rows, and disabled/blocked states. Acceptance = `Choose files` is either truly wired or intentionally hidden; no dead uploader.
2. Back the context-row and mobile posture with a real Launchpad workspace-status contract: freshness, write enabled/blocked, kill-switch/dry-run/reviewer state.
3. Expand Launchpad mobile only with real state: wizard step blockers, progress/silent-failure state, and Ads Manager verification links once those payloads are available; no fake mobile writes.
4. Continue the app-wide shell work: Launchpad no longer duplicates the brand bar, but the reference standalone shell is still approximated by the global dashboard chrome.
5. Tighten the remaining off-reference additions: extra `All`/`Badges` filters, manage-existing heavy cards, and wizard outer card chrome.
6. Continue token/density cleanup around the wizard internals (ad-set builder, target picker, and manage-existing review) so the whole flow reads as the dense 13px operator console.

**Impl files:** `app/(dashboard)/platforms/meta/launchpad/page.tsx`, `components/launchpad/LaunchpadReview.tsx`, `components/launchpad/LaunchpadProgress.tsx`, `components/launchpad/LaunchpadCreativeSelection.tsx`, `app/globals.css`
