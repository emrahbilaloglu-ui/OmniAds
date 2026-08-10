# Final Post-Release Media-Buyer UX Goal — 2026-08-10

This file is the complete execution and acceptance contract for the final Adsecute media-buyer UX remediation release. Claude Code must work to terminal completion: implementation, proof, PR/CI, exact-SHA production deployment, and signed-in read-only live acceptance. Do not stop for interim reporting or approval inside the safe scope below.

## Authority and safety

- Current production and `origin/main`: `72b3897cfeb57eb17e86d8d20dfb28a8d6bdd1ca` (PR #205). Apex/www build-info match; health, deploy gate, and release gate pass.
- Work only in `/Users/harmelek/Adsecute-native-integration`. Never edit, reset, clean, stash, switch, or otherwise touch the dirty user tree `/Users/harmelek/Adsecute`.
- Fetch first and create a fresh branch from current `origin/main`. The isolated branch has release-ledger commit `78bc20ba9` not on main. Preserve its verified release facts but correct its overclaims; do not treat prose as evidence.
- Before Creative/Decision Center changes, follow `docs/creative-decision-center/START_HERE.md` and its mandatory read order. Do not change resolver, `buyerAction`, confidence, thresholds, authority, or snapshot semantics. If an actual semantic change proves necessary, use the full ADR/golden/invariant process.
- No provider, campaign, ad, account, or live report writes. Do not enable `META_GUARDED_EXECUTION_ENABLED`, retention, or sync lanes. Do not send external notifications. No break-glass, force push, protection bypass, or destructive git operation.
- Missing or unknown data must never appear as zero or success. Every visible affordance must work. Mobile copy must match actual capability.

## Seven verified defects that must all close

### 1. Overview compare=None fabrication

`components/overview/SummaryMetricCard.tsx` still uses `changePct ?? 0`. In signed-in production `/overview`, Pins correctly show `— / No comparison selected`, while Store Metrics, Meta, Google, and Expenses cards show `0.0%` under Compare=None. Null, missing previous period, or no comparison must render `—` plus truthful unavailable/no-comparison semantics, with no direction or sentiment colour. Add a real `SummaryMetricCard` render test that fails before the fix. Correct the ledger claim that Overview Compare=None was fully closed.

### 2. Meta Decisions window mislabel

The UI says `Decision date range`, while the canonical contract says `metricsRangeAffectsDecisionSnapshot=false`. Rename and explain it as a metrics/evidence window that does not change current verdict/snapshot authority. Do not alter resolver behavior. Add contract and real-render coverage.

### 3. 320px global topbar overlap

Signed-in production geometry measured `Refresh ↔ Meta` overlap `3×16px` and `Meta ↔ Notifications` overlap `28×28px`. Fix composition without hiding freshness. A dedicated second mobile freshness row is acceptable. At 320 and 390, nav, brand/platform, notifications, account, and freshness must remain visible; independent interactive rectangles must have zero intersection; touch targets and no-page-overflow must hold. Add real browser geometry assertions.

### 4. Dead affordances

`PlatformSwitcher`'s `Notify me` only logs to console; remove it rather than inventing a backend. Its `⌘K` hint has no handler. Make real `GlobalSearch` respond to Cmd+K and Ctrl+K, show the hint in the truthful location, handle focus/open/Escape/ARIA, and avoid unsafe interception during editable/IME contexts. Add unit/render and real-keyboard browser coverage.

### 5. Creative Studio contrast and microtype

Light tokens remain `--ink3:#7d838c` (3.82:1 on white) and `--ink4:#a6abb2` (about 2.31:1), used by essential 11–12px live text such as Analyzing, dates, KPI, and row metadata. Essential normal text must be at least 4.5:1 and at least 12px. Audit token uses rather than applying a blind global override; distinguish decorative/disabled content and verify dark tokens too. Add static contrast protection and computed-style browser checks at 320, 390, and 1280.

### 6. MiniTrendAreaChart semantics and accessibility

The component ignores `tone`, gives every metric the same blue-to-emerald positive-looking line, hides the SVG from assistive tech, and offers a pointer-only tooltip. Do not invent sentiment. Prefer a neutral primary line unless a real sentiment input is introduced; a cost/risk increase must never become green by arithmetic direction. Add an accessible name/summary, keyboard focus and Arrow-key data exploration (or an equivalently complete interaction), distinguish comparison data, and cover it with behavior and browser tests.

### 7. Mobile read-only banner contradiction

`DashboardFrame` generically says `Adsecute · mobile read-only / Writes stay on desktop` on non-route-owned pages while write-capable Settings/Integrations content still renders. Make copy and capability route-true: either a genuinely gated read-only surface or no false read-only claim. Do not open provider mutations on mobile. Add a route/capability matrix test and live 320 checks for Settings, Integrations, and Meta.

## Ledger correction

Update `UX_REMEDIATION_LEDGER.md` from evidence, not intent. Production Chrome was successfully resized to 320 and 390 and Creative Studio labels/no-overflow were verified, so the claim that the browser could not go below 1281 is false. SummaryMetricCard's production `0.0%` was also directly observed. Keep local, production, and external evidence separate and reclassify every affected criterion honestly.

## Test and release gates

For each defect, first add the nearest real behavior test and prove it fails on the pre-fix behavior; source-string/grep tests alone cannot support broad claims.

Run and record:

- `npm run verify:pre-push`
- `LC_ALL=C npx vitest run` with at least the existing 7,140 passes and no unexplained skip/todo increase
- typecheck, lint, production build
- migrations from zero and required real-Postgres seams
- real six-width matrix: 320/390/768/1280/1440/1728

The browser matrix must assert: no page overflow or tabular clipping; topbar hitbox intersections equal zero; freshness visible; no fabricated SummaryMetricCard comparison; mobile stacked labels; essential computed contrast at least 4.5; essential computed type at least 12px; Cmd/Ctrl+K and Escape behavior; keyboard-readable chart. Claim only real light evidence while the product has no actual dark-mode mechanism.

Integrate current `origin/main` again before PR. Audit net removals so no current-main hardening is lost. Open a PR, wait for every required check to finish green, and merge without bypass. The resulting main merge SHA is the deployment identity.

Publish exact-SHA web and worker images. Deploy through the documented Hetzner workflow with current namespace, current-main requirement, migrations according to workflow contract, `break_glass=false`, and fail closed on `deploy/CUTOVER_REQUIRED`. After terminal success independently verify exact apex/www build-info, healthz, web/worker build identity, DB/config fingerprints, migrations, public propagation, ingress smoke, post-deploy artifact, and deploy/release gates.

Perform signed-in, read-only production acceptance. An existing signed-in Chrome session is available; do not stop after failing to find a local cookie. Check current Chrome/Browser `adsecute.com` tabs. Do not mutate live business data. At 320, 390, and 1280 validate Overview, Meta Decisions, Creative Studio, Settings, and Integrations, including all seven defects in the deployed DOM and real keyboard/geometry behavior.

Do not create a report merely to prove Flagship 7/7. If no saved report exists, leave that as an explicit external boundary. Provider pause, live provider disapproval, external-channel delivery, and physical-device acceptance are also outside the authorized safe scope. Do not confuse these with unfinished local or deployable work.

## Terminal final report

Return only after terminal completion, with: final branch and candidate SHA, PR URL, CI results, merge/deploy SHA, image digests, deploy and post-deploy run URLs, live acceptance matrix, corrected ledger, rollback target, and only the genuine external boundaries. Code written or tests green alone is not completion.
