# Phase 01 Truth Foundation

## Scope

Phase 01 is limited to trust, provenance, and release safety for the existing Meta and Creative surfaces.

- No new decision families ship here.
- No commercial-truth layer ships here.
- No write-back or execution logic ships here.

The contract for this phase is:

1. operator-visible metrics must map cleanly to their real source fields
2. deterministic decision-engine output must not be labeled as AI
3. AI commentary must remain clearly optional and secondary
4. every critical operator surface must have a browser smoke path and a release runbook

## Truth ownership rules

- Meta KPI and campaign/ad set metrics:
  - source of truth is the existing Meta live/warehouse serving layer
  - the page contract remains `docs/meta-page-ui-contract.md`
- Meta recommendations:
  - source of truth is the deterministic recommendation engine behind `/api/meta/recommendations`
  - page status truth class is `deterministic_decision_engine`
- Creative metrics:
  - source of truth is the raw Meta creatives row mapper plus explicit derived formulas in `app/(dashboard)/platforms/meta/platforms/meta/creatives/page-support.tsx` and `components/platforms/meta/creatives/creative-truth.ts`
- Creative decision signals:
  - source of truth is `/api/creatives/decisions`
  - response provenance is only `cache` or `deterministic`
- Creative commentary:
  - source of truth is `/api/creatives/commentary`
  - response provenance is only `ai` or `fallback`
  - commentary is optional narrative and must not replace the deterministic report/score
- Proxy / compatibility metrics:
  - if a surface reuses another field as a heuristic placeholder, the label must explicitly say `proxy` or `compat`
  - misleading export labels were removed instead of silently reusing semantically different data

## Meta Metric Matrix

This matrix covers operator-visible metrics on the current Meta page. For the broader surface/readiness inventory, see `docs/meta-page-ui-contract.md`.

| Surface | UI label | UI key | API field | CSV header | Share payload field | Truth owner | Nullability / readiness notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| KPI row | Total Spend | `totalSpend` | `/api/meta/summary -> totals.spend` with `/api/meta/campaigns -> row.spend` fallback | n/a | n/a | Meta canonical overview summary / campaign serving fallback | Required KPI. Masked as preparing when selected-range page readiness is not ready. |
| KPI row | Total Revenue | `totalRevenue` | `/api/meta/summary -> totals.revenue` with `/api/meta/campaigns -> row.revenue` fallback | n/a | n/a | Meta canonical overview summary / campaign serving fallback | Required KPI. Attributed purchase revenue. |
| KPI row | Avg. CPA | `avgCpa` | `/api/meta/summary -> totals.cpa` with campaigns aggregate fallback | n/a | n/a | Meta canonical overview summary / campaign serving fallback | Required KPI. Displays `-` while masked/preparing. |
| KPI row | Blended ROAS | `blendedRoas` | `/api/meta/summary -> totals.roas` with campaigns aggregate fallback | n/a | n/a | Meta canonical overview summary / campaign serving fallback | Required KPI. |
| Campaign list / detail | Spend | `campaign.spend` | `/api/meta/campaigns -> row.spend` | n/a | n/a | Meta live or warehouse campaign rows | Required once campaign rows are present. |
| Campaign list / detail | Revenue | `campaign.revenue` | `/api/meta/campaigns -> row.revenue` | n/a | n/a | Meta live or warehouse campaign rows | Required once campaign rows are present. |
| Campaign list / detail | ROAS | `campaign.roas` | `/api/meta/campaigns -> row.roas` | n/a | n/a | Meta live or warehouse campaign rows | Required once campaign rows are present. |
| Campaign list / detail | CPA | `campaign.cpa` | `/api/meta/campaigns -> row.cpa` | n/a | n/a | Meta live or warehouse campaign rows | Required once campaign rows are present. |
| Campaign detail | Budget current value | `campaign.budgetCurrent` | `/api/meta/campaigns -> row.dailyBudget or row.lifetimeBudget` | n/a | n/a | Meta live or warehouse campaign config fields | Conditional. Entire tile hides when both budget fields are null. |
| Campaign detail | Previous budget + age | `campaign.budgetPrevious` | `/api/meta/campaigns -> row.previousDailyBudget or row.previousLifetimeBudget plus previousBudgetAgeDays` | n/a | n/a | Meta live config helper / warehouse derivation | Conditional. Hidden when no prior budget exists. |
| Ad set drilldown | Spend | `adset.spend` | `/api/meta/adsets -> row.spend` | n/a | n/a | Meta live or warehouse ad set rows | Conditional drilldown. Hidden until a campaign is selected. |
| Ad set drilldown | ROAS | `adset.roas` | `/api/meta/adsets -> row.roas` | n/a | n/a | Meta live or warehouse ad set rows | Conditional drilldown. |
| Ad set drilldown | CPA | `adset.cpa` | `/api/meta/adsets -> row.cpa` | n/a | n/a | Meta live or warehouse ad set rows | Conditional drilldown. |
| Ad set drilldown | CTR | `adset.ctr` | `/api/meta/adsets -> row.inlineLinkClickCtr` with `row.ctr` fallback | n/a | n/a | Meta live or warehouse ad set rows | Conditional drilldown. UI prefers link CTR when present. |

## Creative Core Metric Matrix

These are the authoritative creative metrics used by the table, top cards, CSV export, and shared-report payloads.

| UI label | UI key | API field | CSV header | Share payload field | Truth owner | Nullability / readiness notes |
| --- | --- | --- | --- | --- | --- | --- |
| Spend | `spend` | `spend` | `Spend` | `spend` | Raw creative row | Required. |
| Purchase value | `purchaseValue` | `purchase_value` | `Purchase value` | `purchaseValue` | Raw creative row | Required. |
| ROAS | `roas` | `roas` | `ROAS` | `roas` | Raw creative row | Required. |
| Cost per purchase | `cpa` | `cpa` | `Cost per purchase` | `cpa` | Raw creative row | Required. |
| Cost per link click | `cpcLink` | `cpc_link` | `Cost per link click` | `cpcLink` | Raw creative row | Required. |
| CPM | `cpm` | `cpm` | `CPM` | `cpm` | Raw creative row | Required. |
| Cost per click (all) | `cpcAll` | derived from `spend / clicks` | `Cost per click (all)` | derived from `spend` + `clicks` | `creative-truth.ts` | Requires non-zero `clicks`; returns `0` when denominator is absent. |
| Average order value | `averageOrderValue` | derived from `purchase_value / purchases` | `Average order value` | derived from `purchaseValue` + `purchases` | `creative-truth.ts` | Returns `0` when purchases are absent. |
| Clicks (all) | `clicksAll` | `clicks` | `Clicks (all)` | `clicks` | Raw creative row | Required on Creative surfaces. |
| Link clicks | `linkClicks` | `link_clicks` | `Link clicks` | `linkClicks` | Raw creative row | Required. |
| Click through rate (all) | `ctrAll` | `ctr_all` | `Click through rate (all)` | `ctrAll` | Raw creative row | Required. |
| Link CTR | `linkCtr` | derived from `link_clicks / impressions` | `Click through rate (link clicks)` | `linkCtr` | `creative-truth.ts` | Returns `0` when impressions are absent. |
| Click to add-to-cart ratio | `clickToAtcRatio` | `click_to_atc` or derived from `add_to_cart / link_clicks` | `Click to add-to-cart ratio` | `clickToAddToCart` | Raw creative row with deterministic derived fallback | Returns `0` when link clicks are absent. |
| Add-to-cart to purchase ratio | `atcToPurchaseRatio` | `atc_to_purchase` | `Add-to-cart to purchase ratio` | `atcToPurchaseRatio` | Raw creative row | Returns `0` when add-to-cart evidence is absent. |
| Click to purchase ratio | `clickToPurchaseRatio` | derived from `purchases / link_clicks` | `Click to purchase ratio` | `clickToPurchase` | `creative-truth.ts` | Returns `0` when link clicks are absent. |
| Purchases | `purchases` | `purchases` | `Purchases` | `purchases` | Raw creative row | Required. |
| Impressions | `impressions` | `impressions` | `Impressions` | `impressions` | Raw creative row | Required. |
| Thumbstop ratio | `thumbstopRatio` | `thumbstop` | `Thumbstop ratio` | `thumbstop` | Raw creative row | Video-evidence metric. Blank in CSV when the creative has no video evidence. |
| 25% video plays (rate) | `video25Rate` | `video25` | `25% video plays (rate)` | `video25` | Raw creative row | Video-evidence metric. Blank in CSV when the creative has no video evidence. |
| 50% video plays (rate) | `video50Rate` | `video50` | `50% video plays (rate)` | `video50` | Raw creative row | Video-evidence metric. Blank in CSV when the creative has no video evidence. |
| 75% video plays (rate) | `video75Rate` | `video75` | `75% video plays (rate)` | `video75` | Raw creative row | Video-evidence metric. Blank in CSV when the creative has no video evidence. |
| 100% video plays (rate) | `video100Rate` | `video100` | `100% video plays (rate)` | `video100` | Raw creative row | Video-evidence metric. Blank in CSV when the creative has no video evidence. |
| % purchase value | `purchaseValueShare` | derived from `purchase_value / total_purchase_value` | `% purchase value` | derived from `purchaseValue` + report total | `creative-truth.ts` | Relative metric. Requires report total purchase value. |
| % spend | `spendShare` | derived from `spend / total_spend` | n/a | derived from `spend` + report total | `creative-truth.ts` | Relative metric for table/share only. |
| Purchases per 1,000 impressions | `purchasesPer1000Imp` | derived from `purchases / impressions * 1000` | n/a | derived from `purchases` + `impressions` | `creative-truth.ts` | Relative metric for table/share only. |
| Revenue per 1,000 impressions | `revenuePer1000Imp` | derived from `purchase_value / impressions * 1000` | n/a | derived from `purchaseValue` + `impressions` | `creative-truth.ts` | Relative metric for table/share only. |

## Creative Proxy / Compatibility Metrics

These values remain available for continuity, but the label must make the reuse explicit.

| UI label | UI key | Underlying field | CSV header | Share payload field | Truth owner | Nullability / readiness notes |
| --- | --- | --- | --- | --- | --- | --- |
| First-impression proxy (thumbstop) | `firstFrameRetention` | `thumbstop` | removed in Phase 01 | `thumbstop` | Compatibility alias only | Visible only where legacy column pickers/shared reports need continuity. |
| Link CTR (compat) | `ctrOutbound` | derived `link_clicks / impressions` | removed in Phase 01 | `linkCtr` | Compatibility alias only | Kept only as an explicitly marked compat alias. |
| Completion proxy (100% plays) | `holdRate` | `video100` | removed in Phase 01 | `video100` | Compatibility alias only | Video-only proxy. |
| Hook proxy (thumbstop) | `hookScore` | `thumbstop` | removed in Phase 01 | `thumbstop` | Heuristic proxy only | Not a model score. |
| Watch proxy (50% plays) | `watchScore` | `video50` | removed in Phase 01 | `video50` | Heuristic proxy only | Video-only proxy. |
| Click proxy (CTR all x10) | `clickScore` | `ctr_all * 10` | removed in Phase 01 | `ctrAll` | Heuristic proxy only | Explicit score proxy. |
| Conversion proxy (ROAS x10) | `convertScore` | `roas * 10` | removed in Phase 01 | `roas` | Heuristic proxy only | Explicit score proxy. |
| Average order value (website) / (Shop) | `averageOrderValueWebsite` / `averageOrderValueShop` | derived `purchase_value / purchases` | removed in Phase 01 | `purchaseValue` + `purchases` | Compatibility alias only | Both labels intentionally point to the same AOV formula until a distinct commerce split exists. |
| Website purchase ROAS | `websitePurchaseRoas` | `roas` | removed in Phase 01 | `roas` | Compatibility alias only | Alias only until website-vs-shop attribution splits exist. |
| Click to website purchase ratio | `clickToWebsitePurchaseRatio` | derived `purchases / link_clicks` | removed in Phase 01 | `clickToPurchase` | Compatibility alias only | Alias only until a distinct website purchase metric exists. |

## Decision And Commentary Provenance Matrix

| Surface | UI label | Route | Response provenance | Truth owner | Notes |
| --- | --- | --- | --- | --- | --- |
| Meta recommendations | `Recommendations`, `Run Recommendations`, `Refresh Recommendations` | `/api/meta/recommendations` | deterministic only | `buildMetaRecommendations` | Optional page surface. Status truth class is `deterministic_decision_engine`. |
| Creative decision controls | `Decision Signals`, `Run Signals`, `Refresh Signals` | `/api/creatives/decisions` | `cache` or `deterministic` | deterministic creative decision engine | Cached responses must render as cached, fresh responses must render as deterministic/non-AI. |
| Creative detail commentary | `AI interpretation` / commentary block | `/api/creatives/commentary` | `ai` or `fallback` | commentary generator plus deterministic fallback formatter | Commentary is secondary. Deterministic report, score, and factors remain the primary decision surface. |

## Export And Share Guarantees

- `toCsv()` and `toSharedCreative()` now share the same truthful field set for:
  - all clicks
  - link CTR
  - click-to-add-to-cart
  - click-to-purchase
- Misleading CSV headers removed in Phase 01:
  - `CTR outbound`
  - `First frame retention`
  - `Hold rate`
- Shared report payloads now carry the additional truthful fields required to keep public share pages aligned with the internal table:
  - `clicks`
  - `linkCtr`
  - `clickToAddToCart`

## Implementation anchors

- Creative mapper and export/share alignment:
  - `app/(dashboard)/platforms/meta/platforms/meta/creatives/page-support.tsx`
  - `components/platforms/meta/creatives/creative-truth.ts`
  - `components/platforms/meta/creatives/shareTableEngine.ts`
- Creative deterministic provenance:
  - `src/services/data-service-ai.ts`
  - `app/api/ai/creatives/decisions/route.ts`
  - `lib/migrations.ts`
- Meta page truth class and wording:
  - `lib/meta/status-types.ts`
  - `lib/meta/page-contract.ts`
  - `app/api/meta/status/route.ts`
  - `components/meta/meta-account-recs.tsx`
