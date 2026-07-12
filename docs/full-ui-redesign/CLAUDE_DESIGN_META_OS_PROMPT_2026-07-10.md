# Claude Design Prompt - Adsecute Meta Operating System

Paste everything below into the separate **Claude Design** application. This is a design-only assignment. Do not implement code.

---

## ROLE AND OUTPUT

Act as a principal product designer, information architect, interaction designer, design-systems lead, accessibility specialist, and senior Meta media-buying product expert.

Create one original, high-fidelity, end-to-end product design for the complete authenticated **Adsecute Meta Operating System**. Deliver design output only: screens, components, states, responsive behavior, interaction flows, prototype links, design tokens, and implementation-ready annotations. Do not write React, CSS, API code, database schemas, migrations, or engineering tasks. Do not produce a marketing site, moodboard, generic dashboard, shallow variants, or disconnected concept frames.

Make one strong design direction and carry it consistently through every route, workflow, state, role, desktop/mobile viewport, and light/dark theme. The result must be detailed enough for engineers to implement without inventing missing behavior.

## PRODUCT MISSION

Adsecute is a verified-execution and institutional-memory operating system for experienced Meta media buyers. It is not primarily a reporting dashboard. Its defensible loop is:

`decision -> evidence -> human authority -> provider write -> verification -> outcome -> history`

The product must answer, in order:

1. What needs attention now?
2. Why is the system recommending this action?
3. Is the evidence sufficient, current, and comparable?
4. What is the financial and operational exposure?
5. What may this user safely approve or execute?
6. What did Meta actually accept and what was verified afterward?
7. What happened 1, 3, 7, and 14 days later?
8. Which creatives are current or historical winners, which are declining, and what should be briefed next?
9. How does a decision or brief become an account-scoped, PAUSED Meta draft with complete lineage?
10. Which automation action classes have earned stronger authority, and which remain blocked?

Primary user: an experienced DTC/performance Meta media buyer managing one or a few brands and repeatedly scanning high-volume evidence. Optimize for speed, skepticism, auditability, and daily professional use.

## MATURITY AND CAPABILITY TRUTH

Current executable maturity is **Stage B: approval-based decision and execution assistant**.

- Stage C: guardrailed auto-execution per action class, only after evidence and safety gates pass.
- Stage D: mature autonomy under explicit financial, reversibility, and authority ceilings.

Show the C/D path only as visibly locked future maturity. A configured preference is never presented as effective execution authority. No current executor or auto-execute capability may be implied. AI copilot/chat is out of scope.

Every frame and important component must carry one discreet handoff status:

- `Current / locally wired`
- `Proposed / contract required`
- `Future / fixture only`

Future fixtures must never look executable.

## SCOPE

Design the complete authenticated Meta OS and its shared Meta visual system.

Primary navigation contains exactly four destinations:

1. **Decisions**
2. **Creative Studio**
3. **Launchpad**
4. **Automation**

Required routes and surfaces:

- `/platforms/meta` - Decisions: Act Now and Monitor
- `/platforms/meta/history` - History journal and read-only Historical Replay
- `/platforms/meta/creatives` - Creative Studio: Assets, Winners, Briefs, Shares
- `/platforms/meta/copies` - Creative Studio: Copy analysis
- `/platforms/meta/landing-pages` - Creative Studio: Landing Page diagnostics
- `/platforms/meta/creative-inbox` - account-scoped Studio intake, never a cross-business portfolio
- `/platforms/meta/audiences` - honest planned/readiness view; do not invent an audience contract
- `/platforms/meta/launchpad` - From Decision, From Brief, New Campaign, Manage Existing
- `/platforms/meta/automation` - Modes, evidence gates, guardrails, stop controls, and activity

Supporting Meta flows:

- assigned-account selection and explicit provider account scope
- Meta disconnected, expired, unassigned, and partial-access states
- business economics/commercial target setup
- strategy preset: Conservative, Balanced, Aggressive
- onboarding/readiness to the first decision snapshot
- role/capability states for Viewer, Analyst, Operator, and Admin
- creator-share management and external creator recipient view
- weekly/monthly Meta operating review

Explicit exclusions:

- global `/overview`
- public marketing/landing pages
- unrelated Google, Klaviyo, TikTok, Pinterest, Snapchat, or other-platform redesigns
- AI copilot/chat

Do not rename URLs. If a legacy route is visually absorbed into Creative Studio, record its disposition in the route coverage matrix.

## NON-NEGOTIABLE TRUTH AND SAFETY RULES

1. The existing decision engines and mathematics are the foundation. Do not invent or redesign a third decision engine.
2. Raw and versioned engine output is immutable. User-facing classification is a versioned server overlay.
3. The browser never computes buyer action, assessment, lifecycle role, confidence, freshness, risk, priority, or automation authority.
4. Missing is never zero. Render `-` or an explicit missing state and explain the affected decision and reevaluation condition.
5. Unknown freshness is stale-equivalent, never fresh.
6. Unknown currency never defaults to USD and cannot produce currency-labeled totals or money mutations.
7. Never aggregate money across currencies.
8. Current Meta ROAS/revenue is always labeled `Meta-attributed`. Shopify is authoritative for realized orders, revenue, refunds, and profit only when a named server join exists. GA4 is diagnostic context only and cannot raise action authority.
9. Metrics range and decision snapshot are separate controls. A date filter never silently changes decision authority.
10. Historical Replay is unmistakably read-only and cannot expose live write controls.
11. Every execution-capable surface shows one explicit selected `providerAccountId`. Multiple assigned accounts require explicit selection. No cross-account aggregation or hidden first-account default.
12. Provider request acceptance is not verified success. Verification, failure, partial result, silent failure, and unknown outcome are separate states.
13. Never claim rollback, retry, compensation, or Ads Manager permalink verification without provider proof.
14. A creation is contain-only, not undoable. Any inverse action is a new, separately verified action.
15. Mobile never exposes money-increasing, ACTIVE activation, kill-switch release, or bulk write controls.

## CANONICAL PRODUCT LANGUAGE

Keep these dimensions separate in both layout and hierarchy.

### Lifecycle role

- Test
- Main
- Mixed
- Label needed

`Label needed` is a blocking card state, not a normal decorative chip.

### Creative assessment

Assessment is creative-grain-only in v1:

- Proven winner
- Above target - not scale-ready
- Fatigued former winner
- Below target
- Can't assess - {named blocker}

Reserved future value:

- Relative winner (cohort), only after a persisted evaluation scope and comparability gate exist

Never use generic `Uncertain` when a blocker can be named. Never use Winner language under global-default or thin-baseline truth. Winner claims must state `vs profit target` or `vs account baseline`.

### Action

The server `buyerAction` is the headline. `executionAction` is a suffix or CTA, never a top-level bucket.

- Scale - Promote to Main, Scale Budget, or Controlled Scale suffix
- Cut
- Refresh
- Test More
- Watch
- Investigate - {named signal}
- Fix Delivery
- Fix Policy
- Keep
- Tune
- Rebuild
- Switch
- Swap

Reserve `Observe` exclusively for Automation. Do not use `Diagnose`, `Hold`, or `Fix tracking` as user-facing action headlines.

### Promote to Main versus Scale Budget

These are different jobs and must never share visual semantics:

- **Promote to Main** moves an eligible test creative into an operator-selected Main ad set as a PAUSED, budget-neutral/additive object with lineage. It does not imply profitability. Use an info tone, never green.
- **Scale Budget** means economic scaling after stronger evidence. No current one-click budget executor exists; show it as a manual Ads Manager handoff or `Proposed / contract required`.

Every promotion carries a visible `promotionBasis` in detailed evidence/receipt context:

- `economic_scale_in_test`
- `relative_winner_below_target` - future only, after comparability exists

A below-economics relative winner is never called profitable and never automatically receives Scale Budget.

### Evaluation basis and account-relative fallback

Design an explicit, server-backed **Evaluation basis** control. It is not a cosmetic client filter and the browser never reclassifies rows. The selected basis requests a separately identified server read model and remains visible in every decision, winner claim, share, brief, and receipt:

- `Business economics` - default; evaluates against the named profit/ROAS target
- `Account-relative` - compares only within a named, server-approved comparable cohort and time window
- `Test-to-Main promotion` - finds the strongest eligible test creative for a PAUSED, budget-neutral Main placement

When every creative in an account is below the business target, do not return “no winners” and do not misuse Scale. Show the best comparable candidate as `Relative winner - below target`, state the account baseline and sample, and permit only the future/guarded `Promote to Main` workflow when comparability is proven. It remains below economics, never turns green, never receives Scale Budget, and never claims profitability. If comparability is absent, render `Can't assess - non-comparable cohort` with the exact reevaluation condition.

The active basis must be URL-addressable, saved-view-compatible, and audit-stamped. Changing it cannot silently mutate the current decision snapshot or provider authority.

### Automatic classification and human correction

Lifecycle role and creative assessment are automatically assigned by the server. Do not recreate a mandatory manual campaign-labeling workflow. When evidence is unresolved, show `Label needed` as a blocking exception with the system's best candidate and reason.

An authorized user may correct the served classification through a structured flow: current automatic value, proposed correction, reason code, optional note, affected scope, effective date, actor, and review status. The correction creates a versioned human overlay and History event; it never edits raw engine output, formulas, or prior snapshots. Show the raw automatic value and active overlay together in detailed evidence.

Learning from corrections is `Proposed / contract required`: corrections enter a reviewed feedback dataset and may influence a later model/version only after server-side quality checks, minimum sample rules, rollbackable versioning, and bias/drift review. A single correction must never immediately change formulas or unrelated predictions.

## GLOBAL SHELL AND VISUAL DIRECTION

Use Triple Whale only as inspiration for calm density, consolidated navigation, saved work contexts, and visual creative analysis. Do not copy its branding, exact layouts, colors, wording, or component shapes.

Create an original Adsecute system:

- light theme primary and a complete paired dark theme
- calm neutral canvas and surfaces
- IBM Plex Sans; IBM Plex Mono with tabular numerals
- compact 13px operational base type with small, disciplined hierarchy
- 1px borders; 4-8px radii
- restrained shadow only for overlays and floating inspectors
- Lucide icons for familiar tool actions
- semantic color only for danger, caution, positive, info, and automation/machine agency
- no dominant purple/blue palette; machine agency may have one restrained distinct marker
- stable dimensions for cards, rows, thumbnails, toolbars, controls, and loading states
- no layout shift as values, badges, or states change

Avoid:

- marketing heroes or oversized headlines
- giant cards or KPI card walls
- nested cards and floating page-section cards
- decorative gradients, orbs, bokeh, or illustration chrome
- a raw spreadsheet as the primary experience
- unbounded card walls
- excessive pills, badges, or color washes
- invented charts, trends, metrics, benchmark claims, or fake percentages
- feature-marketing or instructional prose inside the product

Use density by job:

- Act Now: compact decision cards
- Monitor: 32-40px grouped rows
- History: 26-34px dense journal rows/table
- Studio Assets: virtualized visual gallery by default; analytical table secondary

## 01 - DECISIONS

### Information architecture

Decisions has:

- **Act Now**
- **Monitor**
- a link/tab to additive **History**

Healthy is quiet supporting context. Out of sales scope is a Monitor segment. Closed structures belong in History. Do not recreate legacy lanes as equal top-level tabs.

### Act Now layout

The first viewport must answer `What should I act on now?` before showing analytics.

At 1440x900:

- one ranked decision column, never two columns
- a permanently reserved 420-460px right context/evidence zone
- opening an item never reflows or reorders the queue
- before selection, the right zone shows overnight receipts, due-backs, recent outcomes, and a concise selection state
- after selection, the zone becomes the evidence inspector
- show approximately 5 compact text cards, 4 fact-strip cards, or 3-4 thumbnail cards in the first viewport

Act Now is permanently sectioned in this order:

1. Integrity Fires
2. Money Moves
3. Creative Rotation

Never interleave campaign, ad-set, and creative engines into one ranked feed. A future calibrated Top strip may select across sections with quotas, but it never replaces sectioning.

Each section is server-selected and top-N bounded. Show:

- true pre-cap count
- comparable spend/exposure ordering inside the section
- null-exposure `Can't rank - investigate` band, never a zero sort
- suppression receipt, such as `Showing 7 of 203 - 182 below the section limit, 10 guard-capped, 4 deferred`
- a route into the complete Monitor/Studio inventory

### Decision card

Each card shows only:

- server action headline and one command/review state
- entity plus exact account/parent scope
- lifecycle role and creative assessment when available
- one-line media-buyer reason
- real spend exposure or explicit unrankable state
- exactly three action-relevant, source-labeled metrics when space permits
- confidence band, evidence maturity, freshness, and risk in one compact status line
- fixed 48-72px real thumbnail for creative cards, or `Preview unavailable`

Cards never show:

- numeric confidence or priority, including accessible names
- formulas
- base/upside/downside scenarios
- long risk-of-inaction prose
- client-derived classifications

### Evidence inspector

Use progressive disclosure in this order:

1. Recommendation and exact target scope
2. Verified facts with source and as-of labels
3. Assessment, economics qualifier, confidence band, maturity, freshness, and risk
4. Impact state: `Unavailable`, `Exposure proxy`, or `Modeled`
5. Risk of inaction
6. Missing, stale, or conflicting evidence and reevaluation condition
7. Collapsed `How this was decided`: raw/published labels, engine/classifier version, formula detail, evaluation scope, truth source, numeric engine score labeled as heuristic rather than probability
8. Defer, Reject, Override, Approve, structured reason, optional note, assignment/comments only where wired
9. Preflight/action area
10. Receipt, audit identity, provider-returned identifiers, and later outcomes

Current impact copy when no model exists:

`Estimated impact cannot be calculated from current evidence.`

If risk is absent, render `Risk unclassified` and use the highest confirmation ceremony. Missing risk never means low risk.

### Monitor

Monitor is a cursor-paginated grouped list, not a card wall. It supports 300+ items using aggregate cause/cohort rows. Every row answers:

- what is waiting
- why it is waiting
- which evidence is missing, stale, immature, or conflicting
- which decision is blocked
- when or under what condition it will be evaluated again
- owner/disposition where available

Groups include insufficient evidence, newly applied, learning/pacing, fatigue, tracking/data, policy/delivery, emerging risk, and out of sales scope.

## 02 - HISTORY AND HISTORICAL REPLAY

History is an immutable, account-scoped decision journal, not an archive lane. It must scale to 1,500+ events with cursor pagination/virtualization.

Journal event types include:

- computed/published decision transitions
- raw versus published label transitions and hysteresis
- Defer, Reject, Override, Approve, and structured reasons
- Creative Brief creation/revision/review
- LaunchIntent creation and lineage
- preflight and execution attempts
- verified success, failed, partial, silent failure, unknown outcome
- containment/inverse actions without fake rollback wording
- 1/3/7/14-day outcomes and confounder annotations
- automation mode/switch changes

Every row shows event time, actor/source, exact provider account/entity, before/intended/observed state where relevant, decision/brief/intent lineage, audit ID, and receipt status.

Historical Replay is an explicit read-only mode with unmistakable chrome. Metrics range does not activate it. It reads persisted snapshots only, never recomputes history, and contains no provider write controls. Decision Lab may appear only as a `Future / fixture only` read-only comparison of engine/config versions.

## 03 - CREATIVE STUDIO

Creative Studio is visual-first and analysis-first. It must not duplicate the Decisions command center.

Stable Studio areas:

- Assets
- Winners
- Briefs
- Shares
- linked Copy, Landing Pages, Inbox, and honest Audiences readiness views

Every Studio view is scoped to one explicitly selected provider account. If multiple accounts are assigned and none is selected, withhold data and request selection. Never show mixed-currency aggregate totals.

### Assets and Winners

- virtualized fixed-ratio gallery default; sortable metric table secondary
- 300+ assets across video, static, carousel, reused placements, and missing/expired media
- distinguish stable asset identity from each executable account-bound placement
- shared saved scope/filter context where the source supports it; unsupported filters say `Not applicable to this source`
- Current Winners and Historical Winners separated by engine-version era and 7/28/90/all-time windows
- truth-source-qualified Winner language only
- fatigue clusters and former-winner history leading into a Brief workflow
- metadata-only treatment for media outside retention unless an explicit winner-pinning contract preserved it

Copy analysis is diagnostic and must not invent a Winner claim. Landing Pages clearly label GA4-derived signals as diagnostic context. Audiences remains a planned/readiness ledger until a real backend contract exists.

### Persisted Creative Brief

Design a first-class persisted `Creative Brief`, never a row-level generated `brief_variation`.

The brief must visibly preserve:

- immutable business and provider-account scope
- source decision ID and source snapshot/engine evidence
- selected creative/family/cohort scope
- frozen raw decision evidence at creation
- editable structured fields: **Keep**, **Change**, **Next**
- status: Draft or Reviewed
- version, created/updated time, author/reviewer
- optimistic conflict state when another revision exists
- audit trail and Launchpad handoff

Editing a reviewed brief returns it to Draft. Raw decision lineage cannot be edited. Design duplicate-safe creation, saved state, validation, conflict/reload, review, and `Send to Launchpad` flows. Never allow the UI to silently change the originating decision evidence.

### Creator Shares

Design a creator-facing publication system, not a generic frozen analytics share.

Internal Shares ledger states: Draft, Active, Expired, Revoked. Show recipient, exact asset scope, expiry, permission tier, last open, published feedback revision, token rotation, access ledger, and revoke action.

Creator v1 is strict Tier 0 only. The server-projected external payload may include:

- thumbnail/asset preview and delivery state
- creative-signal trends: thumbstop/hook retention, all/link CTR, video 25-100 completion
- reviewed Keep / Change / Next feedback
- due date and delivery status

It must never serialize absolute spend, revenue, CPA, ROAS, CPM, cost per result, impressions, reach, frequency, targets, confidence numerals, raw labels, campaign/ad-set names, audiences, or other creators' data. Revocation is checked on every read with no-store caching. State honestly that revocation cannot recall previously downloaded media.

## 04 - LAUNCHPAD

Launchpad entry points:

- From Decision
- From Brief
- New Campaign
- Manage Existing

Desktop uses a compact step rail, flexible editor, and sticky summary/preflight pane. Mobile is review/read-only except for safe draft metadata; provider creation and activation remain desktop-only.

### Account-scoped LaunchIntent and lineage

Every decision/brief handoff creates or consumes a persisted, immutable-lineage `LaunchIntent` scoped to one business and one `providerAccountId`.

Show:

- LaunchIntent ID and status
- source Decision and Snapshot lineage
- source Creative Brief lineage when present
- source Draft/template lineage when present
- exact account and target hierarchy
- creative/post reuse identity
- campaign/ad-set strategy and lifecycle role stamps
- requested final state and expiry
- validation status and blockers
- kill-switch/control-plane state
- idempotency identity
- result/partial/silent-failure receipts

Do not reduce lineage to a creative ID in a URL. A History reader must be able to follow:

`decision -> brief -> launch intent -> draft -> provider objects -> receipts -> outcomes`

### PAUSED-only current writes

All current provider creation is PAUSED. Required copy:

`This creates Meta objects in PAUSED state. It changes provider state but cannot begin delivery.`

Support drafts/templates, recommendation prefill, creative selection, campaign basics, role/cohort stamping, budget/exposure review, ad sets/targeting, add-to-existing, manage-existing, validation, review, progress, and object-level receipts.

Final controls:

- Save Draft
- Create PAUSED
- Publish ACTIVE - visibly locked preview only

Required ACTIVE copy:

`Preview only. ACTIVE publishing is unavailable until server approval and execution contracts are enforced.`

The future ACTIVE design may explain create-PAUSED -> verify hierarchy -> fresh activation preflight -> activate children -> activate campaign last, but it must be tagged `Proposed / contract required` and cannot look clickable.

Partial result states must separate created/verified, failed, not attempted, and unknown provider outcomes. Never show automatic retry, fake rollback, fake cleanup, or success inferred from request acceptance.

## 05 - AUTOMATION

Automation is a supervision and readiness surface, not an autonomy theater dashboard.

Use one compact row per action class with exactly four modes:

- Observe
- Recommend
- Approval Required
- Auto-execute

Every row separates:

- configured preference
- effective server authority
- risk ceiling
- sample/calibration/financial/critical-error gates
- exceptions/protected entities
- last mode change and actor
- next review
- promotion proposal or demotion reason
- action-class stop state

Required honesty copy:

`Configured mode is a preference. Effective execution authority is determined by server gates.`

Stage B caps effective authority at Approval Required. Auto-execute is locked even when a preference exists. Promotion requires all hard gates: runtime sample `n >= 30` per calibration cell, ECE `<= 0.05` per label, mature financial outcomes excluding unknown outcomes, and zero critical errors. Any silent failure trips the affected class breaker in the future model.

Show environment/business stop state and future action-class switch registry distinctly. Control-plane read failure is fail-closed. Stop engagement is risk-reducing; release is Admin, desktop-only, and requires fresh preflight. Mobile may Engage but never Release.

Required stop copy:

`New mutations are blocked. A provider request already accepted may still complete.`

When a switch engages, pending approvals freeze as `Blocked by kill switch`. Release auto-executes nothing; each item returns to Approval Required and needs a fresh preflight.

Design Modes, Evidence, Guardrails, Stop Controls, Promotion Review, Activity Ledger, and failure drill views. Tag per-class breakers and any executor as `Proposed / contract required` or `Future / fixture only` as appropriate.

## ROLES, CONFIRMATIONS, AND RECEIPTS

Capabilities are server-returned; the client never infers authority from role names.

- Viewer: view/search/inspect/permitted export
- Analyst: comments, assignment, dispositions, brief/share drafts when capability exists
- Operator: policy-bounded approval/execution, creator publication, stop engagement
- Admin: economics, access, automation promotion, high-risk approval, stop release

Restricted users still see evidence. Replace unavailable commands with a concise capability/approver explanation; avoid disabled-button forests.

Preflight states:

- Not run
- Running
- Passed until [time]
- Warning
- Blocked
- Expired
- Control unavailable

Execution states:

- Queued
- Applying
- Verification pending
- Succeeded
- Partial
- Failed
- Silent failure
- Unknown outcome
- Compensating
- Compensated
- Compensation failed
- Cancelled

Every confirmation shows exact account/scope, current -> proposed state, financial exposure, reversibility, preflight, provider target, actor capability, plan expiry, and duplicate-submission protection.

Every receipt shows requested change, exact account/entity, previous/intended/observed state, provider response, verification time, actor/source, audit ID, provider trace when available, and a link built from provider-returned IDs when possible. Never call the link itself verified.

## RESPONSIVE REQUIREMENTS

Deliver complete high-fidelity frames at minimum for:

- desktop: **1440x900**
- mobile: **390x844**

Also document behavior at 768, 1280, and 1728 widths.

At >=1440, Decisions reserves the 420-460px right inspector zone. Below 1440, inspectors use an accessible overlay/full-screen drawer with focus trap and return-to-origin. No horizontal body overflow.

Mobile uses bottom tabs for Act, Monitor, and History. It supports:

- triage and complete L1/L2 evidence
- Defer, Reject, Acknowledge, comments
- single-entity Pause where server capability and preflight permit
- kill-switch Engage
- pending-write reconciliation

Mobile excludes kill-switch Release, budget/bid/activation, bulk actions, and all high-risk execution. Show `Continue on desktop` with an exact deep link for excluded work. Do not use a fake phone bezel or shrink desktop tables into the viewport.

## LIGHT, DARK, ACCESSIBILITY, AND MOTION

Design full light and dark token parity for every surface and component. Dark mode is not an inversion afterthought. Include semantic token tables for canvas, surfaces, text, borders, focus, danger, caution, positive, info, automation, selected, disabled, missing, stale, and overlay states.

Target WCAG 2.2 AA:

- text contrast >= 4.5:1
- component/focus contrast >= 3:1
- visible, non-obscured focus
- minimum 36px desktop and 44px mobile targets
- skip navigation
- correct tab/list/table/dialog semantics
- Enter opens inspector; Escape closes overlay; focus returns to origin
- complete dialog focus trap
- announced sort/state changes and live action feedback
- status never relies on color alone
- no lost function at 200% zoom or 320px width
- reduced-motion support

Motion is restrained and functional: pane transitions, progress, and status changes only. No ambient or decorative animation.

## REQUIRED STATES

Create production-quality components/frames, not footnotes, for:

- loading with preserved geometry and no fake counts
- valid empty with applied scope and recovery action
- no business / no assigned account / explicit account selection required
- disconnected Meta / expired integration / partial access
- insufficient history and first-snapshot readiness
- missing or stale target/economics
- partial data and source-specific failure
- stale source/snapshot and unknown freshness
- Meta/Shopify/GA4 conflict
- tracking degradation
- engine/version mismatch and malformed legacy snapshot
- timeout, rate limit, and resource-specific error while other regions remain usable
- snapshot cooldown
- missing thumbnail/media
- long Turkish/English names and provider IDs
- read-only/restricted role
- confirmation, blocked/expired preflight, and dry-run preview
- pending/in-flight, verified success, provider rejection, silent failure, partial success, unknown outcome
- containment/inverse action; rollback unavailable/planned/verified/failed only where honestly supported
- kill switch engaged, release review, and unreadable control plane
- mobile desktop-required handoff
- high volume

Keep a last-valid snapshot visible only when it is clearly timestamped and locked. Otherwise withhold counts. Retry only the failed resource.

## REALISTIC STRESS FIXTURES

Use realistic data, never lorem ipsum:

- one selected EUR Meta account and a second assigned USD account used to prove isolation
- one account-selection-required state with no implicit first account
- 3 Integrity Fires, 7 Money Moves, and 7 shown Creative Rotation decisions
- Creative Rotation receipt `Showing 7 of 203`
- 300+ Monitor items using pagination and aggregate entries
- 300 creatives across formats, reused placements, missing media, and long names
- Current/Historical Winners across multiple engine eras
- 10 Creative Briefs across draft, reviewed, conflict, and Launchpad-handoff states
- 12 creator share grants across draft, active, expired, and revoked
- 8 Launchpad drafts/intents with successful, partial, failed, and silent-failure receipts
- 10 Automation action classes with different readiness states
- 1,500 History events
- Viewer, Analyst, Operator, and Admin variants
- observed zero, missing, stale, conflict, and not-applicable values
- unknown currency that cannot execute a money mutation
- non-comparable cohort with a named reevaluation condition
- future below-economics relative winner eligible only for PAUSED, budget-neutral Promote to Main
- economically validated Main creative eligible for manual/locked Scale Budget handling
- unknown provider outcome and kill-switch event

Never combine EUR and USD in one total.

### Performance and rendering budgets

Annotate the design so implementation can meet these measurable budgets under the stress fixtures:

- initial authenticated Meta route payload <= 200KB compressed, excluding on-demand media
- rendered virtual window <= 60 decision rows, Monitor rows, History rows, or Studio tiles at once
- cached inspector open p95 <= 150ms
- local client filter/sort response p95 <= 100ms
- no full-list hydration for 300+ Monitor, 300 Studio assets, or 1,500 History events
- media loads progressively with stable reserved geometry and bounded concurrency

Show pagination/cursor, virtualization, skeleton geometry, and on-demand evidence/media boundaries in the handoff annotations. Do not solve volume by shrinking type or creating an unbounded DOM/card wall.

## REQUIRED CLICKABLE FLOWS

1. Act Now -> select decision -> inspect evidence -> preflight -> approve -> verified receipt -> Monitor
2. High-risk or unclassified-risk action -> blocked/expired preflight -> desktop recovery
3. Defer/Reject/Override -> structured reason -> History event
4. Studio asset/fatigue cluster -> persisted Creative Brief -> edit Keep/Change/Next -> review -> Launchpad handoff
5. Current/Historical Winner -> creator feedback review -> grant publish -> creator view -> revoke
6. Launchpad From Brief -> inspect account-scoped LaunchIntent lineage -> Create PAUSED -> verified object manifest
7. Launchpad object-level partial/silent failure with no fake retry or rollback
8. ACTIVE preview showing why execution remains locked
9. Automation evidence -> promotion proposal/closed gate -> stop engagement -> approval freeze -> Admin release review
10. History event -> immutable receipt -> 7-day outcome/confounder
11. Historical Replay -> read-only version comparison with no live action
12. Mobile triage, risk-reducing action, pending-write reconciliation, and high-risk desktop handoff
13. Restricted-role evidence view and approver handoff

## DELIVERABLES

Organize the design file exactly as:

1. `00 Scope`
2. `01 Foundations`
3. `02 Components`
4. `03 Desktop 1440`
5. `04 Mobile 390`
6. `05 Responsive Rules`
7. `06 Dark Theme`
8. `07 States`
9. `08 Prototype`
10. `09 Handoff`

Deliver:

- route coverage matrix: route, job, frame IDs, data source, account scope, write authority, maturity tag, responsive coverage
- product and lineage flow maps
- taxonomy and state-machine diagrams
- complete light/dark semantic token tables
- typography, spacing, radius, elevation, motion, breakpoint, and z-index tokens
- component inventory with variants and exact dimensions
- field-to-contract binding and null/error behavior for every visible field
- all required normal/exceptional/high-volume frames
- keyboard, focus, zoom, and screen-reader notes
- linked prototype covering every required flow
- implementation annotations without code
- unresolved-decisions register limited to genuinely unresolved server/product choices

Do not leave unnamed placeholders, fake data assumptions, or `developer will decide` gaps.

## FINAL ACCEPTANCE CHECKLIST

The design is acceptable only if every item passes:

1. The first Decisions viewport answers what to act on now.
2. 1440x900 uses one queue and a permanent 420-460px inspector/context zone; opening an item causes no reflow.
3. Integrity Fires, Money Moves, and Creative Rotation remain permanently sectioned.
4. Cards are compact; no giant cards, marketing hero, KPI wall, nested cards, or primary spreadsheet appears.
5. Cards show confidence bands only; numeric confidence/priority/formulas remain in detailed evidence.
6. Missing never renders as zero; unknown currency/freshness is explicit.
7. Money never aggregates across currencies.
8. Every execution-capable surface shows an explicit provider account.
9. Metrics range cannot silently change the decision snapshot.
10. Lifecycle role, creative assessment, action, economic truth, confidence, risk, maturity, and authority remain distinct.
11. Promote to Main and Scale Budget are never synonyms; Promote is not green and does not imply profitability.
12. Studio is visual-first and usable with 300+ creatives.
13. Persisted Creative Brief shows immutable evidence lineage plus editable Keep/Change/Next and version/conflict states.
14. Creator sharing is reviewed, revocable at read, asset-scoped, and serializes no absolute financials.
15. Launchpad uses an account-scoped LaunchIntent and makes full decision -> brief -> intent -> provider lineage inspectable.
16. Every current provider creation is PAUSED; ACTIVE is a visibly locked preview.
17. Automation preference never masquerades as effective authority; auto-execute remains locked at Stage B.
18. History is an immutable journal with receipts and outcomes, not an archive lane.
19. Historical Replay is unmistakably read-only.
20. Mobile is a real 390px workflow and excludes money-increasing, bulk, ACTIVE, and stop-release controls.
21. Light/dark, WCAG 2.2 AA, keyboard/focus, 200% zoom, long text, and high-volume cases are complete.
22. Every loading/empty/error/missing/stale/blocked/partial/silent-failure/unknown-outcome state is explicit and honest.
23. Every frame is labeled Current, Proposed, or Future without capability theater.
24. The result feels like one calm, dense, professional Meta operating system and does not copy Triple Whale branding.
25. Evaluation basis is explicit and server-backed; account-relative fallback never masquerades as profitability or Scale Budget.
26. Human classification correction is a versioned overlay/history event and never mutates raw engine evidence.
27. High-volume frames document the <=200KB payload, <=60 rendered-item window, and p95 interaction budgets.

Create the complete design now. Produce design output only and do not implement code.
