# Adsecute Full UI Redesign Route Coverage Ledger

> Current Meta status, 2026-07-10: the owner-discovery and joint Meta OS
> direction supersedes the original ZIP as the product-design authority for
> authenticated Meta routes. See
> `META_OS_LOCAL_IMPLEMENTATION_COMPLETION_2026-07-10.md`. The older phase
> entries below remain an audit trail; they are not the current Meta status.
>
> Status correction, 2026-07-08: this file is a route/render coverage ledger only.
> It is not a design-completion ledger and must not be used as proof that a
> surface matches the Claude Design reference. The authoritative fidelity audit
> is `docs/full-ui-redesign/DESIGN_FIDELITY_LEDGER_2026-07-08.md`, which keeps
> every surface open until screenshot/code evidence proves reference parity.

Date: 2026-07-07
Branch: design-tw-uplift
Design source: `/Users/harmelek/Downloads/Create a complete from-scratch product redesign for Adsecute_ the full_applicati.zip`

## Ground Rules

- `/overview` is protected and excluded from implementation.
- Public marketing landing pages are excluded.
- Route URLs remain stable unless the route is missing from the product contract.
- The only planned new route is `/platforms/meta/automation`.
- UI must not compute buyer action or override decision authority.
- Missing data must render as missing, not zero.
- Money values must not aggregate across currencies.
- Meta write endpoints must stay guarded and must honor the business kill switch.
- Admin/internal pages get token and visual normalization only.

## Excluded Or Protected Routes

| Route or path | Status | Reason |
| --- | --- | --- |
| `/overview` | protected | Explicitly excluded by user. Do not edit `app/(dashboard)/overview/page.tsx` or `components/overview/*`. |
| `/` | excluded | Public marketing landing page. |
| `/about` | excluded | Public marketing/static surface. |
| `/contact` | excluded | Public marketing/static surface. |
| `/pricing` | excluded | Public marketing surface under `(marketing)`. |
| `/product` | excluded | Public marketing surface under `(marketing)`. |
| `/demo` | excluded | Public marketing surface under `(marketing)`. |
| `/privacy` | excluded | Public legal/static surface. |
| `/terms` | excluded | Public legal/static surface. |
| `/security` | excluded | Public trust/static surface. |
| `/ai-transparency` | excluded | Public/static trust surface, not authenticated product UI. |
| `/dev/briefing-playground` | excluded | Developer playground, not user-facing app surface. |

## In-Scope Route Checklist

| Product area | Routes | Target state | Status |
| --- | --- | --- | --- |
| App shell and navigation | dashboard shell, platform layer navigation, mobile shell | Calm dense shell, visible "Decisions" naming, stable mobile read-only behavior | covered by Phase 2 foundation |
| Auth and onboarding | `/login`, `/signup`, `/invite/[token]`, `/select-language`, `/shopify/connect`, `/businesses/new`, `/select-business` | New auth/onboarding visuals, truthful connection and first-sync states | covered by Phase 7 auth/onboarding shell |
| Integrations callback | `/integrations/callback/[provider]` | Token-normalized callback status surface | covered by Phase 7 callback shell |
| Workspace | `/commercial-truth`, `/reports`, `/reports/new`, `/reports/[reportId]`, `/reports/[reportId]/edit`, `/reports/[reportId]/print`, `/integrations`, `/settings`, `/team`, `/insights`, `/insights/analytics`, `/insights/ai-visibility`, `/insights/seo` | Workspace visual family aligned to design, no behavior rewrite unless contract truthfulness requires it | covered by Phase 7 workspace shell and report wrapper normalization |
| Meta Decisions and History | `/platforms/meta`, `/platforms/meta/history` | Sectioned Act Now, Monitor, persistent/overlay evidence inspector, explicit account/currency scope, read-only History and Historical Replay | current Meta OS local design and account-scoped read contracts covered 2026-07-10 |
| Meta Creative Studio | `/platforms/meta/creatives`, `/platforms/meta/copies`, `/platforms/meta/landing-pages`, `/platforms/meta/creative-inbox`, `/platforms/meta/audiences` | Analysis-first Studio family; decision labels only as server-provided context/deep links | current Meta OS local design covered 2026-07-10; unavailable producers remain visibly contract-required |
| Meta Launchpad | `/platforms/meta/launchpad` | Guarded write surface, drafts/templates, immutable LaunchIntent lineage, validation, receipts, partial/silent failure, PAUSED launches | current PAUSED contract covered 2026-07-10; ACTIVE and budget execution remain locked |
| Meta Automation | `/platforms/meta/automation` | Kill switch, guardrails, readiness, promotion records, activity ledger, honest blocked states | current supervision contract covered 2026-07-10; per-action promotion/auto-execute remains locked |
| Google Ads | `/platforms/google`, `/platforms/google/pulse`, `/platforms/google/launchpad`, `/platforms/google/ads`, `/platforms/google/keywords`, `/platforms/google/audiences` | Token-normalized platform family and visible "Decisions" naming where pulse was product language | covered by Phase 7 ComingSoonState family |
| Klaviyo | `/platforms/klaviyo`, `/platforms/klaviyo/flows`, `/platforms/klaviyo/campaigns`, `/platforms/klaviyo/templates`, `/platforms/klaviyo/segments` | Token-normalized beta platform family | covered by Phase 7 ComingSoonState family |
| Soon platforms | `/platforms/tiktok`, `/platforms/pinterest`, `/platforms/snapchat` | Calm placeholder states aligned to design | covered by Phase 7 PlatformTablePage shell |
| Shared/client views | `/share/report/[token]`, `/share/creative/[token]` | Client-facing read-only surfaces aligned to design tokens | covered by Phase 7 client-share normalization |
| Admin/internal | `/admin`, `/admin/activity`, `/admin/auth-health`, `/admin/businesses`, `/admin/businesses/[businessId]`, `/admin/discounts`, `/admin/discounts/new`, `/admin/discounts/[codeId]`, `/admin/integrations`, `/admin/release-authority`, `/admin/revenue-risk`, `/admin/subscriptions`, `/admin/sync-health`, `/admin/system-capacity`, `/admin/users`, `/admin/users/[userId]` | Token/visual normalization only; no product behavior rewrite | route-render covered only; design-fidelity open; admin token normalization reapplied 2026-07-08 |

## Route Gate History

These entries record route/render and contract gates only. They are not design-completion claims. A surface remains open until the fidelity ledger has current screenshot/code evidence that it matches the Claude Design reference.

- Phase 1 route gate passed after Claude Code adversarial review confirmed 72/72 route coverage and correct exclusions.
- Phase 2 route/label gate passed after Claude Code `CONTINUE`: visible Pulse labels removed, Meta Automation route shell added honestly, product-surface primitives added, `/overview` untouched, full `npx vitest run` green.
- Phase 3 server-contract gate passed locally before Claude review: `/api/meta/decisions-workspace` composes account metrics + lane payloads server-side, exposes queue groups/action-state counts/system banners/currency/kill-switch posture, and `/platforms/meta` now reads the single workspace query instead of client-merging pulse + lanes.
- Phase 3 contract gate passed after Claude Code `CONTINUE`: the new workspace endpoint was confirmed as a BFF aggregator, not a decision-core reimplementation; auth forwarding, missing-data behavior, currency isolation, kill-switch banner truthfulness, and workspace invalidation were independently reviewed. Non-blocking follow-up for Phase 6: normalize kill-switch env parsing in write guards to match the BFF reader.
- Phase 4 Studio route gate passed after Claude Code `CONTINUE`: `/platforms/meta/creatives` no longer imports the briefing/decision-center page and now renders an analysis-only Creative Studio library with gallery, sortable metrics, CSV/share, and readonly detail drawer; `/copies`, `/landing-pages`, `/creative-inbox`, and `/audiences` are aligned under the Studio family and link execution work back to Decisions or Launchpad. This does not mean Creative Studio matches `02 Creative Studio.dc.html`; fidelity remains open.
- Phase 5 Launchpad route/contract gate passed after Claude Code `CONTINUE`: `/platforms/meta/launchpad` keeps the existing guarded write contract for paused launches, validation blockers, stored errors, partial/silent failures, Ads Manager links, idempotency keys, and explicit resume activation warnings; the route now joins the Meta Decisions / Creative Studio / Automation navigation family. This does not mean Launchpad matches `03 Launchpad.dc.html`; fidelity remains open.
- Phase 6 Automation route/contract gate passed after Claude Code `CONTINUE`: `/platforms/meta/automation` now reads a server-composed control-plane API with global/business kill-switch posture, guardrails, readiness tier, promotion records, and activity ledger. Additive migrations create the Automation control-plane tables, and active Meta write endpoints now call the shared write guard before validation/provider context/Meta mutation paths. Claude's non-blocking fail-open advisory was fixed before Phase 7: unexpected business-control DB read errors now fail closed for writes while the pre-migration `42P01` table-missing case stays open. This does not mean Automation matches `04 Automation.dc.html`; fidelity remains open.
- Phase 7 workspace/auth/client/admin/platform route gate passed before Claude Code review: auth/onboarding moved to shared AuthSurface; OAuth callback, workspace, reports, integrations, settings, team, insights, Google/Klaviyo beta placeholders, soon-platform tables, share views, and admin layout were normalized without changing provider writes, report behavior, team permissions, or decision authority.
- Phase 7 route/visual-normalization gate passed after Claude Code `CONTINUE` (no blockers): shared AuthSurface, callback/workspace/reports/integrations/settings/team/insights normalization, Google/Klaviyo/soon placeholders, share views, and admin layout were confirmed token/visual-only, with provider writes, report behavior, team permissions, and decision authority unchanged. This does not mean Auth/Workspace/Client/Admin matches the reference; fidelity remains open.
- 2026-07-08 admin token-normalization correction: `/admin` now uses a scoped `.ad-admin-shell`, 196px rail, IBM Plex/token inheritance, and admin-only utility color/radius overrides. This is still route/render and visual-normalization evidence only; admin/internal pages are not design-complete and no behavior was rewritten.
- Phase 8 route/render gate passed by Claude Code (this chat). See "Phase 8 Route Gate Results" below.
- Each later phase must keep the relevant rows at `covered`, `covered-by-shared-shell`, or `excluded`.
- Route closure requires zero uncovered rows in the in-scope checklist. **Satisfied at Phase 8 for route coverage only:** all in-scope rows are `covered`; every uncovered route is in the excluded/protected set.
- Design completion remains open for every surface until the fidelity ledger is updated with reference-matching evidence.

## Phase 8 Route Gate Results

Route/render gate passed by Claude Code on 2026-07-07 after fixing two real blockers found during route coverage (a Playwright spec typecheck failure and a banned-tint palette violation) and independently verifying route-level acceptance invariants. This is still not a design-completion result.

### Final command results

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (after fixing 3 real `testInfo.config.use.baseURL` type errors in `playwright/tests/full-ui-redesign-smoke.spec.ts`; replaced with an env-derived `SMOKE_BASE_URL`) |
| `npm run lint` | PASS |
| `npx vitest run` | 475 files / 3697 tests passed (4 files, 56 tests skipped, 61 todo); 0 failed |
| `npm run test:migrations-from-zero` | PASS (ephemeral DB + seam checks) |
| `node --import tsx scripts/full-ui-redesign-playwright-smoke.ts` | **2 passed (3.2m), exit 0** |

### Playwright smoke coverage and safety

- Request-level route smoke over every in-scope route (public + dashboard + admin), desktop only: asserts HTTP status < 500, server HTML contains no `\bPulse\b` product language, and no fatal error markers.
- Real-browser visual/overflow smoke for representative routes at desktop `1440x1000` and mobile `390x844`: asserts no crash text, no rendered `\bPulse\b`, horizontal body overflow ≤ 2px, and zero page errors.
- These checks do not compare rendered composition against the Claude Design reference; they only prove route health and basic visual safety.
- DB safety: ephemeral Postgres on a random free port with `{5432, 15432}` forbidden; the `.env.local` prod tunnel URL cannot leak because the smoke pre-sets `DATABASE_URL` and `@next/env` never overrides an already-set var. Ephemeral DB and temp worktree are torn down after the run.
- Artifacts: `docs/full-ui-redesign/playwright-smoke-artifacts/` (Playwright HTML report + full-page screenshots for the representative desktop and mobile routes).

### Adversarial source audit (6 invariants)

| Invariant | Verdict |
| --- | --- |
| No visible "Pulse" product language | PASS (also enforced at runtime by the smoke `\bPulse\b` assertion on every route) |
| No UI-computed buyerAction / client decision authority | PASS (`/api/meta/decisions-workspace` composes/forwards upstream server truth; client only tallies server `actionKind`) |
| Missing data renders as `—`, never fabricated 0 | PASS (finite guards throughout; `?? 0` occurrences are structural counts, not metric displays) |
| No cross-currency money aggregation | PASS (cross-business inbox renders per-account currency; creatives page guards "Mixed currencies") |
| TW-calm token compliance | FAIL → FIXED — removed the dead, unused `automation` surface tone that used banned purple chrome (`border-purple-200 bg-purple-50 text-purple-800`) from `components/ui/product-surface.tsx`; no consumer or test referenced it |
| Meta writes guarded / kill-switch-blocked | CONCERN, no active bypass — every active write path is guarded (route-level `rejectIfMetaWritesBlocked` before mutation + honors global env and per-business kill switch) |

### Documented non-blocking follow-ups (verified non-active — not a bypass today)

- `lib/meta/launch-write.ts` `createCampaign/createAdSet/createAd` lack the inline `META_ADS_WRITE_KILL_SWITCH` guard that `lib/meta/ads-write.ts` write primitives have. Protected today because the sole caller `app/api/launchpad/meta/launch/route.ts` invokes `rejectIfMetaWritesBlocked` unconditionally before any create. Follow-up: add the inline early-return (`create*` already return `... | MetaAdsWriteFailure`, so it is contract-compatible) for uniform defense-in-depth.
- `lib/meta/execution.ts:227` `mutateMetaAdSetExecution` issues a Graph POST with no kill-switch check. Not a live bypass: its only callers live under `lib/archive/v1-v2-v21/**`, which Next does not serve and no active code imports. Follow-up: guard or delete when the archive is pruned.

## 2026-07-10 Meta OS Current-Design Addendum

This addendum supersedes the older Meta route statuses above without rewriting
their historical gate record.

- `/platforms/meta/history` is now part of the route inventory and is exercised
  by request smoke and desktop/mobile visual smoke.
- Decisions, History, Studio Assets, Studio Copy, Studio Landing Pages, Studio
  Inbox, Studio Audiences, Launchpad, and Automation all have route-specific
  loaded/empty/error readiness assertions in Playwright.
- Every account-bearing Meta read requires or resolves an explicitly assigned
  `providerAccountId`; Copy was corrected so rows cannot merge across accounts
  or currencies.
- The former orphaned active write implementation was removed from
  `lib/meta/execution.ts` and retained only as an archive artifact. Current Meta
  write routes continue through shared authorization, account scope, write
  guard, and kill-switch checks.
- Responsive evidence covers 390, 768, 1280, 1440, and 1728 widths in both
  light and dark themes. Dark primary-action contrast is asserted at WCAG AA
  and the Adsecute mark is checked for dark-topbar visibility.
- `/overview` and `components/overview/*` remain protected. Public marketing
  routes remain excluded.

The route ledger says where a user can go. It does not turn an intentionally
locked provider capability into a current feature. ACTIVE publication, budget
mutation, per-action auto-execution promotion, and an executable media upload
pipeline remain labelled `Proposed/contract required` rather than simulated.
