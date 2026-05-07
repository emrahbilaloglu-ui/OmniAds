# UI -> API -> Service -> DB Dependency Map

Scope: overview/dashboard-adjacent UI plus Meta, Google Ads, Shopify-connected read paths.

Canonical core backbone for these surfaces:
- `provider_connections`
- `integration_credentials`
- `business_provider_accounts`
- `provider_account_snapshot_runs`
- `provider_account_snapshot_items`

Former compatibility surface:
- `integrations`
- `provider_account_assignments`
- `provider_account_snapshots`

The canonical backbone is authoritative for current request/runtime behavior. The former compatibility tables are removed from the live schema and are listed here only for historical traceability.

## Cross-cutting pivots

| Pivot | Why it matters | DB touch |
| --- | --- | --- |
| `requireBusinessAccess()` in `lib/access.ts` | Every protected business-scoped route resolves session + membership before provider logic. | `sessions`, `users`, `memberships`, `businesses` |
| `getIntegration*()` + `getProviderAccountAssignments()` | Provider access, account selection, and current route readiness all fan out from these helpers. | `provider_connections`, `integration_credentials`, `business_provider_accounts`, `provider_accounts` |
| `readProviderAccountSnapshot()` | Time zone/account metadata is reused by Meta and Google serving/status paths. | `provider_account_snapshot_runs`, `provider_account_snapshot_items`, `provider_accounts` |
| `provider status routes` | Overview, Integrations, Meta, and Google Ads pages all surface sync-health state from control-plane tables. | `meta_sync_*`, `google_ads_sync_*`, `sync_worker_heartbeats`, `provider_*` control tables |

## Overview surface

| UI surface | UI file / component | API endpoint | Route -> service chain | Table families touched |
| --- | --- | --- | --- | --- |
| Overview summary cards, attribution, platform sections, AI brief shell | `app/(dashboard)/overview/page.tsx` via `src/services/data-service-overview.ts#getOverviewSummary` | `GET /api/overview-summary` | `app/api/overview-summary/route.ts` -> `getOverviewData()` + `getShopifyOverviewServingData()` + `getAnalyticsOverviewData()` + `getIntegrationStatusByBusiness()` + `getBusinessCostModel()` | `core`: `businesses`, `business_cost_models`, `provider_connections`, `integration_credentials`, `business_provider_accounts`, `provider_account_snapshot_runs`, `provider_account_snapshot_items`; `warehouse`: `meta_account_daily`, `google_ads_account_daily`, `shopify_orders/refunds/returns`; `serving`: `shopify_serving_state`, `shopify_reconciliation_runs`, `provider_reporting_snapshots`, `platform_overview_*`; `control`: provider status readers |
| Overview sparkline bundles | `app/(dashboard)/overview/page.tsx` via `getOverviewSparklines` | `GET /api/overview-sparklines` | `app/api/overview-sparklines/route.ts` -> `getOverviewTrendBundle()` + GA4 `runGA4Report()` | `warehouse`: `meta_account_daily`, `google_ads_account_daily`; `serving`: `platform_overview_*` fallback on Google path; live GA4 external read |
| Overview status pills | `app/(dashboard)/overview/page.tsx` | `GET /api/meta/status`, `GET /api/google-ads/status` | status routes -> warehouse/control readers | `control`: `meta_sync_*`, `google_ads_sync_*`, `provider_*`, `sync_worker_heartbeats`; `warehouse`: coverage reads from daily tables |
| Cost model save | `CostModelSheet` in overview page | `PUT /api/business-cost-model` | route -> `upsertBusinessCostModel()` | `core`: `business_cost_models` |
| AI daily brief read/regenerate | `AiDailyBrief` | `GET /api/ai/insights/latest`, `POST /api/ai/insights/generate` | AI routes -> overview aggregation + OpenAI helpers | `serving`: `ai_daily_insights`; indirect overview reads reuse warehouse/core tables |

## Meta surface

| UI surface | UI file / component | API endpoint | Route -> service chain | Table families touched |
| --- | --- | --- | --- | --- |
| Meta header/KPIs | `app/(dashboard)/platforms/meta/page.tsx` | `GET /api/meta/summary` | `app/api/meta/summary/route.ts` -> `getMetaCanonicalOverviewSummary()` -> `getMetaWarehouseSummary()` + optional `getMetaLiveSummaryTotals()` | `core`: `provider_connections`, `integration_credentials`, `business_provider_accounts`, `provider_account_snapshot_runs`, `provider_account_snapshot_items`; `warehouse`: `meta_account_daily`; live exception uses Meta API; `control`: truth readiness from `meta_sync_*` |
| Meta campaigns table/detail | `MetaCampaignList`, `MetaCampaignDetail` from Meta page | `GET /api/meta/campaigns` | route -> `getMetaWarehouseCampaignTable()` with current-day live exception via `getMetaLiveCampaignRows()` | `core`: canonical integration/assignment backbone; `warehouse`: `meta_campaign_daily`, `meta_adset_daily`, `meta_config_snapshots`; live Meta API for current day |
| Meta breakdown cards | Meta page side panels | `GET /api/meta/breakdowns` | route -> `getMetaWarehouseBreakdowns()` with fallback gating/readiness | `core`: canonical integration/assignment backbone; `warehouse`: `meta_breakdown_daily`, `meta_adset_daily`; `control`: readiness via `meta_sync_*` |
| Meta recommendation rail | Meta page | `GET /api/meta/recommendations` | route -> `lib/meta/recommendations` + campaign/breakdown readers | `warehouse`: `meta_campaign_daily`, `meta_breakdown_daily`, `meta_creative_daily`; `core`: canonical integration/assignment backbone |
| Meta sync/readiness badges | Meta page and Integrations page | `GET /api/meta/status` | `app/api/meta/status/route.ts` -> `lib/meta/warehouse` + `lib/sync/meta-sync` + `provider-status-truth` | `control`: `meta_sync_jobs`, `meta_sync_partitions`, `meta_sync_runs`, `meta_sync_checkpoints`, `meta_sync_state`, `sync_worker_heartbeats`; `warehouse`: `meta_account_daily`, `meta_campaign_daily`, `meta_adset_daily`, `meta_ad_daily`, `meta_creative_daily`, `meta_raw_snapshots`, authoritative tables |

## Google Ads surface

| UI surface | UI file / component | API endpoint | Route -> service chain | Table families touched |
| --- | --- | --- | --- | --- |
| Google Ads status header | `components/platforms/google/GoogleAdsIntelligenceDashboard.tsx` | `GET /api/google-ads/status` | `app/api/google-ads/status/route.ts` -> warehouse/control readers + request governance | `control`: `google_ads_sync_*`, `google_ads_runner_leases`, `provider_cooldown_state`, `provider_quota_usage`, `sync_worker_heartbeats`; `warehouse`: coverage reads on Google daily tables; `core`: canonical integration/assignment/snapshot backbone |
| Google Ads campaigns panel | same dashboard | `GET /api/google-ads/campaigns` | route -> `getGoogleAdsCampaignsReport()` -> `lib/platforms/google/serving` | `warehouse`: `google_ads_campaign_daily`, `google_ads_account_daily`; `core`: canonical assignment/snapshot backbone; live current-day overlay exception |
| Google Ads advisor | same dashboard | `GET /api/google-ads/advisor` | route -> `lib/platforms/google/serving` + `advisor-memory` + `advisor-snapshots` | `serving`: `google_ads_advisor_memory`, `google_ads_advisor_snapshots`; `warehouse`: campaign/account/search tables; `audit`: advisor execution/outcome logs |
| Search intelligence / products / assets / geo / devices / audiences / trends | same dashboard | `GET /api/google-ads/search-intelligence`, `/products`, `/assets`, `/asset-groups`, `/geo`, `/devices`, `/audiences`, `/trends` | routes -> `lib/platforms/google/serving` specialized readers | `warehouse`: corresponding `google_ads_*_daily` tables plus search-intelligence tables; `core`: canonical integration/assignment/snapshot backbone |
| Workspace overview card set | `GET /api/google-ads/overview` (also shared elsewhere) | `app/api/google-ads/overview/route.ts` -> `getGoogleAdsOverviewReport()` -> canonical summary/trend helpers | `warehouse`: `google_ads_account_daily`, `google_ads_campaign_daily`; `serving`: `platform_overview_*` fallback projection; live current-day overlay exception |

## Shopify-connected surface

| UI surface | UI file / component | API endpoint | Route -> service chain | Table families touched |
| --- | --- | --- | --- | --- |
| Overview store metrics | `app/(dashboard)/overview/page.tsx` | `GET /api/overview-summary` | summary route -> `getShopifyOverviewServingData()` -> `getShopifyOverviewReadCandidate()` | `warehouse`: `shopify_orders`, `shopify_refunds`, `shopify_returns`, `shopify_sales_events`; `serving`: `shopify_serving_state`, `shopify_reconciliation_runs`, `provider_reporting_snapshots`; `control`: `shopify_sync_state`, `shopify_serving_overrides`; `core`: `provider_connections`, `integration_credentials` |
| Shopify evidence / compare lane | operator scripts only | `shopify:read-compare`, `shopify:health-snapshot`, `runtime-validate-shopify-sales-events` | scripts -> `getShopifyOverviewReadCandidate()` / `getShopifyOverviewAggregate()` / status readers | `serving`: `provider_reporting_snapshots`, `shopify_serving_state`, `shopify_reconciliation_runs`; external Shopify Admin API only in explicit sync/evidence lanes |
| Integrations / Shopify health admin lane | `app/(dashboard)/integrations/page.tsx`, admin health route | `GET/POST /api/admin/integrations/health/shopify` and sync/webhook routes | admin route + webhook routes -> `lib/shopify/warehouse`, `lib/shopify/status`, `lib/shopify/read-adapter` | `control`: `shopify_sync_state`, `shopify_serving_overrides`, `shopify_repair_intents`; `serving`: `shopify_serving_state`, `shopify_serving_state_history`, `shopify_reconciliation_runs`; `audit/archive`: `shopify_webhook_deliveries`, `shopify_entity_payload_archives` |

## Critical fan-out notes

1. `GET /api/overview-summary` is the widest request-time fan-out in the repo. It combines overview aggregation, Shopify serving-state resolution, GA4 analytics, integration status, and cost-model reads.
2. `lib/platforms/google/serving.ts` mixes historical warehouse reads, current-day live overlay, and projection fallback from `platform_overview_*`.
3. `lib/meta/canonical-overview.ts` mixes warehouse historical reads with a direct-live current-day exception.
4. `lib/shopify/read-adapter.ts` is the serving trust switchboard. Request-time summary reads are projection-backed/read-only; live Shopify Admin reads remain in explicit sync/evidence lanes.
5. `business_provider_accounts` is the join point that turns a workspace-scoped UI request into provider-account-scoped warehouse reads across Meta and Google Ads.
