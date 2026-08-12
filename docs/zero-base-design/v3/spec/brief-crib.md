# Adsecute brief crib (from 01_ADSECUTE_CLAUDE_DESIGN_MASTER_PROMPT.md @ e947d467d)

## Counts (normative)
277 capability IDs · 24 invariants · 215 /api + 5 non-api handlers + 76 pages = 296 routes.
Lo-fi ≥70 frames; hi-fi ≥46 frames (mandatory list below). No TBD, no "Not examined" in complete package.

## Dispositions
LIVE, GATED, READ-ONLY (no editable controls), PARTIAL (only supported subset), OFF-BY-DEFAULT (refusal/manual primary), BROKEN (unavailable+prereq), UNSAFE (no actionable control), INTERNAL (never buyer nav), PLACEHOLDER (absent, no fake CTA), CONTRACT-ONLY (obey server availability), DESIGN-RISK (expose+reconcile), DESIGN-REQ (required treatment). Capability truth > visual ambition.

## Hard truth/safety rules
- UI never computes buyerAction/confidence/labels/thresholds/hysteresis/held state. primaryDecision ≠ operator action. Preserve as-of time, evidence window, freshness, provenance gaps, held/shadow, label≠mutation authority, V1/V2 snapshot readability, replay≠live.
- Scope always discoverable: business, provider, account, window, currency, timezone, freshness. Never sum money across currencies/providers/accounts w/o per-row proof. Missing = "Unavailable"+reason, never 0%/guessed symbol.
- Agency Desk allowed fields ONLY: business name/id, my membership/visibility, configured currency (labelled configuration), Meta connection state, Meta selected-account count, warehouse last-source-update freshness (labelled source activity). Alphabetical sort. NO spend/revenue/ROAS/severity/anomaly/policy/pending ranking. No assigned-to-me/overdue/snooze queue. Deep link = business context only.
- Plan lock ≠ security (client-side only). Reviewer read-only orthogonal to role. Demo labelled.
- No notification bell (NOTIF broken). No report-share control (unsafe). No billing call/payload (SEC-02). No recent-gap repair (SEC-01). Guardrails AUTO-05..10 read-only. Meta stop = business-scoped Meta only, never "Global"/"Stop all"; always show separate Google posture row (no Google stop exists).
- Google writes recommendation-bound, default-off, unverified; manual plan/copy/CSV/deep-link primary. Never expose pause_ad (GOOGLE-19). Batch = add_negative_keyword + pause_asset only, max 250, same type/group, non-atomic, partially_applied possible, weaker gates than single (disclose). No Google reconciliation state (unlike Meta). No owner/due-date on Google items. No Google Launchpad parity.
- Meta preflight reads persisted state, never "live provider verification"; show age. Ambiguous outcomes never auto-retried; Meta reconciliation exists. Launchpad launch/add-to-existing UNSAFE → design draft/validate, execution disabled behind named prerequisite (origin+confirmation enforcement, no rollback). Bulk ad status max 20. Rollback: only recommendation-bound Google (default-off); Meta Launchpad none.
- Comments (META-WF-09): write-only, no reader → no conversation UI. History actor gaps disclosed.
- Search = "Businesses + Meta entities" label; silent truncation disclosed ("Showing the available subset"; cap if known else "Backend cap not supplied"; never invent N total).
- ECON-04 divergence: Meta decisions read business_target_packs (COGS/fulfillment/payment + contributionMarginAssumption); Google serving+Overview read business_cost_models (cogs_percent/fee/fixed); reports read neither. Show consumers per edit + divergence.
- AI insights generate (ANALYTICS-07 UNSAFE): read latest only; no Generate control. SEO-04 generation gated w/ auth/skipped/failed. GEO collab-only, dual-source, aiPageCount proxy cap 50, top-3 truncation disclosed.
- Reports: 5 sources render; Shopify/GA4/SC/Klaviyo "coming soon" unavailable; only 7 verified Meta-oriented breakdown values; disable unsafe aggregates w/ reason; CSV table-widget-only; print/PDF live; share disabled (mint/revoke/strip prereqs).
- Destructive actions: impact copy + confirmation + authoritative read-back; business delete has NO read-back → warn.
- Business switching: URL context preserved; invalid account/entity context reset shows explicit message.

## IA (locked by brief)
Agency scope: **Agency Desk** (Today, Clients, withheld-state explainer). Client scope: Home; Meta (Decisions, Account Intelligence, Launchpad, Automation & Meta Stop, History); Creative Intelligence [Meta-scoped] (Performance, Detail/History, Briefs, Inbox, Copies, Landing Pages, Shares); Google Ads (Overview, Advisor, Search, Products, Assets & Audiences, Manual Plan & Activity); Analytics (GA4/Shopify, Landing Pages/Products, SEO/Search Console, GEO/AI Visibility); Reports. Manage: Integrations & Data, Team & Access, Business Settings, Account & Security, Plan & Billing (remediation-gated, static copy ok, no /api/billing), Admin/Ops (separate shell). Plans: Starter (Home+integrations/settings; module list Overview only), Growth (+Meta, Google, Creative, Analytics, LPs), Pro (+SEO/GEO; Klaviyo listed-but-placeholder), Scale (+Agency Desk, custom reporting, team roles; TikTok/Pinterest/Snapchat/Klaviyo placeholder). Plan availability = commercial presentation, never authorization; note commercial-consistency issue.

## Flows A–M
A agency entry; B Meta decision→supported action; C Needs Resolution (no comment UI, expectedVersion conflict); D creative refresh (engine posture, brief w/ lineage, share limits); E launch prep (stop before execution, named prereq); F Google manual plan + default-off posture (reference gated apply/batch); G report delivery; H integration recovery (admin-only sync handoff); I Meta automation safety (stop/release, Google unaffected); J admin incident; K onboarding/invite; L share lifecycle (creative live, report disabled); M account/business lifecycle (revoke-all w/ current-session consequence; business delete no-read-back warning). Each: happy/unavailable/partial/permission/offline/rate-limited/error branches where relevant.

## State matrices (9 named)
1 auth/identity; 2 plan intent vs authorization; 3 business/provider/account + currency/timezone proof; 4 data (pristine…rate-limited, tz-missing, tz-disagreement); 5 Meta decision+workflow; 6 Creative engine (disabled/hidden/shadow/actionable); 7 mutation (incl. aged preflight, silent failure, Meta reconcile, Google pending/partially-applied); 8 shares; 9 responsive (1440/1280/768/390/320/print/public). No "superseded"/global "rolled back".

## Visual direction
Original, calm, premium, decisive; warm-neutral; restrained accessible accents; high density w/o microtype; body 13–14px, 12px floor; contrast ≥4.5 text / ≥3:1 UI; minimal elevation; one primary action per region; progressive disclosure orientation→action→evidence; tabular numerals; up≠green (Spend/CPA/refunds business meaning); missing comparison "Unavailable" never 0%; no gradients/glass/neon/hero-cards/rainbow charts/chip forests; every click-looking element works; unavailable = absent or explicit+reason.
LOCKED: Schibsted Grotesk (UI/prose) + Fragment Mono (values/IDs/timestamps/receipts). Accent muted indigo oklch(0.50 0.09 275). Lanes: Act Now ember oklch(0.50 0.12 40); Needs Resolution amber oklch(0.53 0.10 80); Monitoring slate oklch(0.50 0.04 250). Semantics same L/C discipline. Light+dark tokens.

## A11y (WCAG 2.2 AA)
1.4.3/1.4.11 contrast; 2.4.7 focus visible; 2.4.11 focus not obscured; 2.5.7 drag alternatives (report builder); 2.5.8 targets ≥24px, primary mobile ≥44px; 3.2.6 consistent help (no dead Help); 3.3.7 redundant entry; 3.3.8 accessible auth; landmarks/headings/tables/live regions; focus trap/return/Escape; chart summaries+data tables; alt/captions/poster; no color-only; reduced motion; zoom/reflow no page overflow; no hover-only essentials; mobile keeps scope/economics/blockers; print/public first-class.

## Artifacts in order (§10)
1 Evidence/disposition summary; 2 Product model+sitemap; 3 Flows A–M; 4 State matrices; 5 Lo-fi ≥70; 6 Design system; 7 Hi-fi ≥46; 8 Responsive/a11y spec; 9 Capability+invariant ledgers; 10 Route ledger (296); 11 Handoff (slices, dependencies, rollback boundaries, EN/TR glossary, instrumentation map, test matrix).

## Mandatory hi-fi list
Agency Desk Today+Clients; client Home; Meta Decisions+inspector+Needs Resolution; Meta account intelligence; Creative list/detail/shadow-only/brief; Launchpad validation+execution-disabled; Meta manual preflight/confirmation/result/reconciliation; Automation/Meta Stop+separate Google posture; Meta History/replay; Google Overview/Advisor/manual plan/default-off card/batch partial; Analytics/SEO/GEO source states; Reports library/builder/unsupported source/print/share-disabled; Integrations/account assignment; Team/invite/reviewer/demo; Business settings/account security; Admin incident; public creative share; mobile shell, Agency Desk, Meta decision detail, Google manual plan, public share @390/320.

## Gates (§12) — report real numbers
missing/dup capability IDs 0; missing invariants 0; missing api 0/215, handlers 0/5, pages 0/76; unsafe-rendered-actionable 0; broken/off-default-as-live 0; placeholders-in-nav 0; dead affordances 0 (+inspected control count); silent truncations 0 (caps disclosed); UI-computed decision facts 0; unproven money sums 0; essential text <12px 0; text/non-text contrast failures 0; mobile 390/320 blockers 0; lo-fi ≥70 + index; hi-fi ≥46 + index; all matrices; EN/TR glossary 1; instrumentation map (every surface); 3 adversarial reviews; fake user-validation claims 0.

## Final response (§13)
verdict; artifact locations; sitemap+nav variants; 13 flows; matrix summary; visual+a11y summary; frame counts; ledger counts; gate results; unresolved backend prerequisites; handoff sequence; statement no code/backend/provider/production data changed.

## Personas
Buyer (collab+), Media lead/admin, Analyst, Membership guest/client reviewer, Shopify reviewer (read-only orthogonal), Demo/prospect, Unauthenticated share recipient, Platform admin.

## Demo dataset (mine, consistent across frames)
Agency user: Deniz Kaya (buyer), Selin Arat (admin). Clients: Atlas Coffee Roasters (USD, America/New_York), Brightloom Kids (USD), Cascadia Trailworks (USD), Fenwick & Moss (GBP), Halcyon Supply Co. (USD, act_298410771 + act_298410772), Marmara Home (TRY, Europe/Istanbul), Nordlys Skincare (NOK), Verdana Botanics (EUR, GA4 not connected), Peak & Pine Outfitters (USD, Meta auth expired), Juniper Lane Paper (USD, demo). Primary client for deep frames: Halcyon Supply Co.
