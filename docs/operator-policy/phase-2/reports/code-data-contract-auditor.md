# Code/Data Contract Auditor Report

Audit date: 2026-04-21  
Scope: current Meta Decision OS, current Creative Decision OS, shared decision trust layer, Meta and Creative page components, and Command Center/execution entry points.

## Executive Finding

Adsecute already has the right central concept: selected UI reporting dates are `analysis_only`, while operator authority should come from rolling windows (`recent7d`, `primary30d`, `baseline90d`) anchored to `decisionAsOf`. The implementation partially honors that contract. Meta Decision OS and Creative Decision OS primary deterministic rows are largely built from `primary30d` plus rolling history, not from arbitrary selected dashboard dates.

The design flaw is that both Meta and Creative surfaces still pass selected `startDate`/`endDate` into Decision OS routes, query keys, detail views, Command Center links, and selected-period analysis. Legacy Meta recommendations can also fall back to selected-range heuristics. This means the product can still look and feel as if changing the dashboard date range changes "today's decision," even where the engine internally uses stable windows.

Before Phase 2 implementation, the code/data contract must make decision authority impossible to confuse with reporting context. Command Center and execution must bind to `decisionAsOf`, source window, decision id, and evidence hash, not selected dashboard dates.

## Policy Contract Being Audited Against

The Phase 2 specialist reports agree on the core boundary:

- Scaling policy requires rolling operator decision windows and says the selected reporting range can explain context but cannot authorize today's action (`docs/operator-policy/phase-2/reports/scaling-strategist.md:49`, `docs/operator-policy/phase-2/reports/scaling-strategist.md:55`).
- Budget policy says selected reporting range must not directly drive today's budget action and requires live current state plus a stable decision window (`docs/operator-policy/phase-2/reports/budget-pacing-specialist.md:84`, `docs/operator-policy/phase-2/reports/budget-pacing-specialist.md:102`).
- Bid policy blocks bid action from selected reporting range only (`docs/operator-policy/phase-2/reports/bid-strategy-specialist.md:74`) and states selected range is inspection, not direct bid execution (`docs/operator-policy/phase-2/reports/bid-strategy-specialist.md:107`).
- Creative policy says selected reporting range must not directly drive creative decisions; decisions use recent 7d, primary 30d, baseline 90d/all-history (`docs/operator-policy/phase-2/reports/creative-performance-analyst.md:33`).
- Measurement policy defines a stable decision window firewall and caps selected-range-only evidence (`docs/operator-policy/phase-2/reports/measurement-attribution-skeptic.md:86`, `docs/operator-policy/phase-2/reports/measurement-attribution-skeptic.md:92`).
- Learning/delivery policy says selected ranges may generate hypotheses but must not directly drive edits (`docs/operator-policy/phase-2/reports/learning-delivery-specialist.md:48`, `docs/operator-policy/phase-2/reports/learning-delivery-specialist.md:96`).

## Current Window Contract

The shared operator window type already encodes the correct split:

- `analyticsWindow` has role `analysis_only` (`src/types/operator-decision.ts:10`).
- Decision windows are `recent7d`, `primary30d`, and `baseline90d` (`src/types/operator-decision.ts:1`).
- Window roles are `recent_watch`, `decision_authority`, and `historical_memory` (`src/types/operator-decision.ts:16`).
- Metadata builds `primary30d` from `decisionAsOf`, not from the selected UI range (`lib/operator-decision-metadata.ts:41`, `lib/operator-decision-metadata.ts:52`).
- Historical memory explicitly says decisions use live rolling windows instead of the selected period (`lib/operator-decision-metadata.ts:69`, `lib/operator-decision-metadata.ts:79`).
- Meta `decisionAsOf` defaults to provider platform previous date (`lib/operator-decision-metadata.ts:101`, `lib/operator-decision-metadata.ts:107`).

This contract is good and should remain the basis for Phase 2.

## Selected Date Dependencies

| Surface | Current dependency on selected `startDate` / `endDate` | Audit verdict |
| --- | --- | --- |
| Meta Decision OS route | Reads selected dates from query params and passes them into `getMetaDecisionOsForRange` (`app/api/meta/decision-os/route.ts:50`). Also passes the same dates into Creative Decision OS for linkage (`app/api/meta/decision-os/route.ts:66`). | Design flaw at API contract level: selected dates enter the Decision OS route even though action authority should be `decisionAsOf` + rolling windows. |
| Meta Decision OS source | Accepts selected dates (`lib/meta/decision-os-source.ts:21`) but fetches campaigns, breakdowns, GEO rows, and ad sets from `decisionContext.decisionWindows.primary30d` (`lib/meta/operator-decision-source.ts:32`, `lib/meta/operator-decision-source.ts:34`, `lib/meta/operator-decision-source.ts:49`). | Primary deterministic data is correctly stable-window anchored. Selected dates still affect response `startDate`, `endDate`, `analyticsWindow`, linkage, route/query identity, and any wrapper analysis. |
| Meta Decision OS builder | Builds metadata from selected analytics dates but overrides with supplied decision windows and `decisionAsOf` (`lib/meta/decision-os.ts:3158`). Decisions are built from input campaigns/ad sets/geo rows (`lib/meta/decision-os.ts:3207`, `lib/meta/decision-os.ts:3220`, `lib/meta/decision-os.ts:3240`) and response returns both selected dates and decision windows (`lib/meta/decision-os.ts:3344`). | Mostly compliant internally, but response shape still puts selected dates beside decisions without a hard per-decision provenance field. |
| Legacy Meta recommendations route | Requires selected dates (`app/api/meta/recommendations/route.ts:70`), tries Decision OS first (`app/api/meta/recommendations/route.ts:123`), then falls back to selected-span windows anchored to selected `endDate` (`app/api/meta/recommendations/route.ts:172`) and selected campaign rows (`app/api/meta/recommendations/route.ts:196`). | Noncompliant fallback. If Decision OS is unavailable/disabled, this can generate selected-range-driven recommendations. |
| Meta page | Persists date range (`app/(dashboard)/platforms/meta/page.tsx:556`), derives `startDate/endDate` from UI (`app/(dashboard)/platforms/meta/page.tsx:623`), keys campaigns/recommendations/Decision OS by selected dates (`app/(dashboard)/platforms/meta/page.tsx:687`, `app/(dashboard)/platforms/meta/page.tsx:730`, `app/(dashboard)/platforms/meta/page.tsx:737`), and "Run analysis" refetches both for that range (`app/(dashboard)/platforms/meta/page.tsx:805`). | Design flaw. The UX makes selected range look like the authority for today's decision even where the engine uses rolling windows. |
| Meta campaign detail | Command Center overlay is keyed by selected `since/until` (`components/meta/meta-campaign-detail.tsx:606`), breakdowns fetch selected dates (`components/meta/meta-campaign-detail.tsx:618`), and workflow link includes selected dates (`components/meta/meta-campaign-detail.tsx:796`). | Design flaw for workflow handoff. Execution context can inherit reporting dates. |
| Creative Decision OS route | Reads selected dates from query params and passes them into `getCreativeDecisionOsForRange` (`app/api/creatives/decision-os/route.ts:46`). | Design flaw at API contract level, even though primary decision rows are not selected-period rows. |
| Creative Decision OS source | Accepts selected dates (`lib/creative-decision-os-source.ts:257`) and uses them for `analyticsWindow`, operating mode wrapper, and selected-period historical analysis (`lib/creative-decision-os-source.ts:362`, `lib/creative-decision-os-source.ts:376`). Primary decision rows come from `primary30d` (`lib/creative-decision-os-source.ts:296`, `lib/creative-decision-os-source.ts:323`, `lib/creative-decision-os-source.ts:347`). | Primary decisions are stable-window anchored. Selected dates still change response metadata and historical analysis, so the route should not present them as decision inputs. |
| Creative page | Persists selected creative date range (`app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:140`), uses it for main table fetch (`app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:216`), derives page history windows from selected `drEnd` (`app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:254`), and keys Creative Decision OS by selected dates (`app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:307`). | Design flaw. Page history and query identity are selected-range dependent; users can infer that changing the selected range changes the operator decision. |
| Command Center/execution client | Queue fetch, mutations, execution preview, apply, and rollback accept/pass selected `startDate/endDate` (`src/services/data-service-command-center.ts:19`, `src/services/data-service-command-center.ts:50`, `src/services/data-service-command-center.ts:304`, `src/services/data-service-command-center.ts:335`, `src/services/data-service-command-center.ts:366`). | Critical pre-implementation blocker. Workflow execution must bind to decision provenance, not selected reporting range. |

## Stable Multi-Window Context Already Present

Meta:

- `getMetaDecisionWindowContext` maps selected dates only into `analyticsStartDate/insights/analyticsEndDate` and returns shared decision metadata (`lib/meta/operator-decision-source.ts:14`).
- `getMetaDecisionSourceSnapshot` fetches campaigns, breakdowns, country breakdowns, and ad sets with `primary30d.startDate/endDate` (`lib/meta/operator-decision-source.ts:32`).
- Meta ad set decisions use signal floors, recent-change cooldown, target/break-even thresholds, mixed config, bid regime, constraints, and campaign role (`lib/meta/decision-os.ts:1592`, `lib/meta/decision-os.ts:1596`, `lib/meta/decision-os.ts:1605`, `lib/meta/decision-os.ts:1617`, `lib/meta/decision-os.ts:1632`).
- Meta downgrades aggressive actions when commercial targets are missing (`lib/meta/decision-os.ts:1880`).
- Winner scale candidates require `scale_budget`, `action_core`, `live_confident`, `scale_candidate`, and not no-touch (`lib/meta/decision-os.ts:2334`).
- GEO opportunities have floors for signal depth, freshness, commercial context, and queue readiness (`lib/meta/decision-os.ts:2419`).
- Meta surface authority is truth/freshness/readiness-gated (`lib/meta/decision-os.ts:3304`).

Creative:

- Creative source builds rolling `last3`, `last7`, `last14`, `last30`, `last90`, and all-history windows from `decisionAsOf`, with `last30` equal to `primary30d` (`lib/creative-decision-os-source.ts:296`).
- Creative primary rows are fetched from `primary30d`, while selected period is fetched separately for historical analysis only (`lib/creative-decision-os-source.ts:323`, `lib/creative-decision-os-source.ts:339`, `lib/creative-decision-os-source.ts:376`).
- Creative decision rows carry historical windows (`lib/creative-decision-os.ts:126`) and input fields for identity, campaign/ad set context, metrics, taxonomy, tags, and history (`lib/creative-decision-os.ts:153`).
- Creative economics uses configured target/break-even values when present and conservative fallback floors when absent (`lib/creative-decision-os.ts:1040`).
- Creative fatigue uses historical winner memory, CTR/click-to-purchase/ROAS decay, spend concentration, and frequency when available (`lib/creative-decision-os.ts:1239`).
- Creative lifecycle/action logic protects stable winners and downgrades promotion when commercial truth, economics, or deployment compatibility is not ready (`lib/creative-decision-os.ts:1321`, `lib/creative-decision-os.ts:1379`).
- Creative policy envelope checks objective family, bid regime, campaign family, deployment compatibility, degraded truth, protected winner, fatigue, and supply planning (`lib/creative-decision-os.ts:1946`).
- Creative read reliability is stable only when creative history coverage is high and commercial truth is fresh (`lib/creative-decision-os.ts:3017`).

Trust layer:

- Trust lanes include `action_core`, `watchlist`, `archive_context`, and `opportunity_board` (`src/types/decision-trust.ts:1`).
- Truth states include `live_confident`, `degraded_missing_truth`, and `inactive_or_immaterial` (`src/types/decision-trust.ts:10`).
- Operator dispositions include review/hold/reduce/degraded/protected/archive states (`src/types/decision-trust.ts:18`).
- Trust compilation forces inactive/immaterial rows to archive, suppresses watch/archive/opportunity surfaces, and blocks aggressive actions unless truth is live and lane is action core (`lib/decision-trust/compiler.ts:35`, `lib/decision-trust/compiler.ts:44`, `lib/decision-trust/compiler.ts:48`).
- Opportunity queue eligibility blocks when shared truth is not live, authority is not ready, or floors are blocked/watch (`lib/decision-trust/opportunity.ts:44`).
- Policy floors exist for objective family, bid regime, campaign family, and deployment compatibility (`lib/decision-trust/policy.ts:30`, `lib/decision-trust/policy.ts:46`, `lib/decision-trust/policy.ts:62`, `lib/decision-trust/policy.ts:78`).

## Data That Exists

Commercial/business truth:

- Cost model: COGS, shipping, fees, fixed costs (`lib/migrations.ts:1223`).
- Target pack: target CPA/ROAS, break-even CPA/ROAS, contribution margin assumption, AOV assumption, new-customer weight, risk posture, source label (`lib/migrations.ts:1235`).
- Country economics: economics multiplier, margin modifier, serviceability, priority tier, scale override (`lib/migrations.ts:1253`).
- Promo calendar events (`lib/migrations.ts:1272`).
- Operating constraints: site, checkout, conversion tracking, feed, stock pressure, landing/merchandising concerns, manual do-not-scale (`lib/migrations.ts:1291`).
- Calibration profiles by channel, objective family, bid regime, archetype, multipliers, confidence cap, and action ceiling (`lib/migrations.ts:1313`).
- Commercial truth loader treats target pack, country economics, and operating constraints as blocking sections (`lib/business-commercial.ts:239`) and produces action ceilings when inputs are missing (`lib/business-commercial.ts:638`, `lib/business-commercial.ts:660`, `lib/business-commercial.ts:704`, `lib/business-commercial.ts:845`).

Meta performance/config:

- Account daily has timezone, currency, spend, impressions, clicks, reach, frequency, conversions, revenue, ROAS, CPA, CTR, CPC, and truth metadata (`lib/migrations.ts:2232`).
- Campaign daily has status, objective, optimization goal, bid strategy, bid values, daily/lifetime budgets, mixed flags, spend/revenue/ROAS/CPA/CTR, and truth metadata (`lib/migrations.ts:2267`).
- Ad set daily has ad set status, optimization goal, bid strategy, bid values, daily/lifetime budgets, mixed flags, performance metrics, and truth metadata (`lib/migrations.ts:2336`).
- Breakdowns exist by breakdown type/key with spend, revenue, ROAS, CPA, CTR, frequency, and truth metadata (`lib/migrations.ts:2404`).
- Ad daily has campaign/ad set/ad identity, status, frequency, spend/revenue/ROAS/CPA/CTR/CPC/link clicks, payload, and truth metadata (`lib/migrations.ts:2439`).
- Campaign API row exposes funnel metrics, budget/bid fields, previous captured values, and mixed config flags (`app/api/meta/campaigns/route.ts:7`).

Creative performance/metadata:

- Creative daily has campaign/ad set/ad/creative ids, name, headline, primary text, destination URL, thumbnail URL, asset type, spend, impressions, clicks, conversions, revenue, ROAS, CTR, CPC, and link clicks (`lib/migrations.ts:2490`).
- Creative dimensions store creative metadata and projection JSON (`lib/migrations.ts:2835`).
- Creative score snapshots are keyed by selected start/end and as-of date (`lib/migrations.ts:2861`), which is useful for reporting but reinforces selected-window coupling.
- Creative row type includes preview/media fields, taxonomy, tags, spend, purchase value, ROAS, CPA, CPC/CPM/CTR, purchases, impressions, clicks, link clicks, landing page views, add to cart, checkout, leads, messages, video/attention metrics, and funnel ratios (`components/platforms/meta/creatives/metricConfig.ts:59`).

## Data Missing For Expert Policy

These are contract gaps, not implementation requests:

- No durable policy/rule tables for expert decisions such as scale bands, bid tests, pacing rules, learning-state gates, creative fatigue thresholds, and no-touch protections. Much of the logic remains hard-coded in Meta and Creative Decision OS.
- No per-SKU/product inventory feed, stock depth, product margin, product availability, fulfillment constraints, or category-level profitability. Current data has coarse `stock_pressure_status` and country modifiers, not item-level supply.
- No true contribution profit actuals per campaign, ad set, ad, creative, country, or product. Cost models and target packs exist, but current Decision OS decisions still primarily use revenue, ROAS, CPA, and assumptions.
- No LTV, payback, cohort retention, refund, cancellation, new-vs-returning, or order-quality data. `new_customer_weight` exists as an assumption, not observed cohort truth.
- No Shopify/GA4/server reconciliation table in the audited decision path. Measurement policy requires reconciliation before profit certainty, but current Meta/Creative decisions can only use available Meta-reported revenue plus configured assumptions.
- No explicit attribution basis/action-report-time contract exposed per decision row. Measurement policy requires attribution consistency and finalization lag handling.
- No current-day pacing source sufficient for budget pacing policies: account-day progress, same-day spend vs daily budget, lifetime schedule remaining budget, budget remaining, and timezone-aware live pacing are not contract-complete in the audited Decision OS path.
- No delivery-state/learning-phase feed at the level required by Learning & Delivery policy. Status and config exist; explicit learning/learning-limited diagnostics, policy warnings, account/payment/review issues, and activity-history edit classes are not complete.
- No audience size, overlap, placement saturation, auction competition, estimated action rate, or demand headroom signal. Current code approximates demand constraints from metrics and config.
- No creative production/supply queue: fresh concept availability, variant backlog, creative refresh capacity, concept reuse limits, and production owner are not represented. Creative supply planning is inferred from existing rows and family depth.
- No row-level `decisionSourceWindowKey`, `decisionAsOf`, evidence hash, source query id, or stable decision id attached to every individual Meta/Creative decision. Response-level windows exist, but execution needs per-action provenance.
- No regression contract that proves changing selected analytics range while holding `decisionAsOf` constant cannot change primary Meta/Creative decisions.

## Current Media-Buyer-Stupid Recommendation Risks

These are the places current code can still produce media-buyer-stupid recommendations:

1. Legacy Meta recommendations fallback can issue selected-range-driven budget, bid, and reallocation guidance. When Decision OS is unavailable, `/api/meta/recommendations` builds selected/last-N windows from selected `endDate` (`app/api/meta/recommendations/route.ts:172`) and passes selected rows into the heuristic builder (`app/api/meta/recommendations/route.ts:260`). The fallback can say "Increase budget by 10-15%" (`lib/meta/recommendations.ts:2096`), "Hold or reduce budget 10-15%" (`lib/meta/recommendations.ts:2145`), or "Shift 10-15% budget" (`lib/meta/recommendations.ts:2235`). That is exactly the type of date-range-driven advice Phase 2 policy is trying to prevent.

2. Meta campaign-level fallback can scale from campaign ROAS when no ad set decision exists. `buildCampaignDecision` picks top ad set action when present, but otherwise falls back to `roas >= target ? scale_budget : monitor_only` (`lib/meta/decision-os.ts:2159`). If ad set rows are missing or incomplete, campaign aggregate ROAS can become too coarse an authority.

3. Meta ad set creative fatigue can be oversimplified. The fatigue candidate uses active status, no recent change, no mixed config, enough signal, CTR below 1.05, and ROAS between break-even and target (`lib/meta/decision-os.ts:1646`). It does not require actual creative inventory freshness, variant backlog, family saturation, frequency history, or replacement capacity.

4. Hard-coded evidence floors and fallback thresholds can be too generic for a business. Meta uses fixed spend/purchase floors such as `$250/8`, `$500/12`, `$500/18` (`lib/meta/decision-os.ts:1592`). Creative fallback promotion can use `$250`, 5 purchases, and 2.0x ROAS when commercial targets are absent (`lib/creative-decision-os.ts:1044`). Trust caps help, but the numeric policy is still hard-coded rather than business-calibrated.

5. Creative decisions are stable-window based, but the UI query identity is selected-range based. The Creative page keys Decision OS by `drStart/drEnd` (`app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:307`) and selected historical analysis is visible in the same operator console (`components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx:624`). Even though the UI says selected period affects analysis only (`components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx:195`), the coupling can still teach operators that range-picking changes decisions.

6. Meta page runs Decision OS and legacy recommendations side by side for the selected range. The detail card says Decision OS takes precedence (`components/meta/meta-campaign-detail.tsx:270`), but fallback recommendation context remains visible when Decision OS does not produce authoritative guidance (`components/meta/meta-campaign-detail.tsx:275`). This is safer than primary fallback, but not enough for Phase 2 execution readiness.

7. Command Center/execution accepts selected dates throughout. Execution preview and apply use `startDate/endDate` alongside `actionFingerprint` (`src/services/data-service-command-center.ts:304`, `src/services/data-service-command-center.ts:335`). That creates risk that a workflow action is reconstructed from a reporting slice instead of a stable decision snapshot.

## Meta Selected-Range Design Flaw

Meta Decision OS internals are mostly stable-window compliant, but the public contract is not.

Evidence:

- The route accepts selected `startDate/endDate` (`app/api/meta/decision-os/route.ts:50`).
- The page derives those dates from the DateRangePicker (`app/(dashboard)/platforms/meta/page.tsx:623`) and keys Decision OS by them (`app/(dashboard)/platforms/meta/page.tsx:737`).
- `Run analysis` refetches both recommendations and Decision OS for the current selected range (`app/(dashboard)/platforms/meta/page.tsx:805`).
- The Decision OS source then correctly fetches primary data from `primary30d` (`lib/meta/operator-decision-source.ts:32`).

Verdict: selected range should not be an input identity for Meta operator decisions. It should be renamed and enforced as analytics context only. The current design is a UX/API contract flaw even where the engine avoids selected rows.

## Creative Selected-Range Design Flaw

Creative Decision OS internals are mostly stable-window compliant, but the public contract is also not.

Evidence:

- The route accepts selected `startDate/endDate` (`app/api/creatives/decision-os/route.ts:46`).
- The source fetches primary decision rows from `primary30d` (`lib/creative-decision-os-source.ts:323`) and assigns them to `decisionRows` (`lib/creative-decision-os-source.ts:347`).
- The same source separately fetches selected-period rows for historical analysis (`lib/creative-decision-os-source.ts:339`, `lib/creative-decision-os-source.ts:376`).
- The page keys Creative Decision OS by selected dates (`app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:307`) and page history windows are derived from selected `drEnd` (`app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx:254`).

Verdict: selected range should not be an input identity for Creative operator decisions. Selected-period historical analysis is valid only as descriptive context and must be contractually separated from primary actions.

## Required Contract Changes Before Implementation

1. Split API parameters:
   - Replace decision-route `startDate/endDate` semantics with explicit `analyticsStartDate/insights/analyticsEndDate` for reporting overlays.
   - Add explicit `decisionAsOf` or server-resolved provider previous date as the only anchor for Decision OS authority.

2. Add per-decision provenance:
   - Every Meta campaign, ad set, GEO, placement, no-touch, budget shift, creative, and Command Center action must carry `decisionAsOf`, `sourceWindowKey`, source window dates, source row scope, evidence hash, and stable decision id.
   - Response-level `decisionWindows` is not enough for execution.

3. Make selected-range firewall testable:
   - Add regression tests proving same `decisionAsOf` plus different selected analytics ranges produces identical primary Meta decisions.
   - Add the same regression for Creative decisions.
   - Selected-period `historicalAnalysis` may change; `primaryAction`, `surfaceLane`, `truthState`, and queue eligibility must not.

4. Demote or remove legacy Meta recommendation fallback from action surfaces:
   - If Decision OS is unavailable, selected-range heuristic recommendations may be report-only context, never action-core, default queue, or execution preview input.
   - The fallback response must carry a hard `non_authoritative_selected_range_context` flag.

5. Rebind Command Center and execution:
   - Queue fetch, mutation, preview, apply, and rollback must bind to decision id/provenance and `decisionAsOf`, not selected dashboard dates.
   - `actionFingerprint` should include source window/provenance, and stale-preview rejection should verify the exact evidence hash.

6. Add data readiness gates for specialist policies:
   - Profit actions require configured/fresh target pack, margin/cost basis, attribution basis, and reconciliation status.
   - Budget pacing actions require live budget owner, current daily/lifetime budget semantics, account timezone, same-day or provider-current state, and edit cooldown.
   - Bid/control actions require bid strategy/control values, previous control age, budget utilization, objective/optimization fit, and commercial targets.
   - Creative promotion/fatigue requires deployment compatibility, historical memory, benchmark cohort quality, frequency or alternative pressure evidence, and creative supply readiness.
   - Learning/delivery decisions require delivery state, learning status, status stack, recent activity/change evidence, and constraint diagnosis.

7. Move expert thresholds into policy/config contracts:
   - Current hard-coded floors should become versioned, business-calibrated policy inputs with safe defaults and audit labels.
   - Fallback floors can remain for context, but must cap confidence and prevent push eligibility.

8. Separate descriptive analytics from operator action UI:
   - Pages can keep selected date pickers for reporting tables and historical analysis.
   - Decision panels should show "Decision as of" and authority window as the primary control, with selected period clearly subordinate.
   - Detail links to Command Center should not include selected reporting dates as execution context.

## Implementation Go/No-Go

No-go for Phase 2 implementation until:

- selected reporting range is no longer part of operator decision identity;
- Command Center/execution actions bind to stable decision provenance;
- selected-range fallback recommendations cannot enter action surfaces;
- per-decision source windows and evidence hashes exist;
- regression tests prove selected-date changes do not mutate primary decisions;
- data readiness gates explicitly block policy classes when required commercial, measurement, pacing, delivery, bid, or creative-supply data is absent.

The current codebase is close on deterministic Meta/Creative decision-window logic, but not close enough on API/page/workflow contracts. The risk is not only bad math; it is letting an operator or execution workflow mistake a reporting slice for decision authority.
