# Serving Write Ownership Map

Purpose: make ownership of user-facing serving/projection/cache persistence explicit. Shared read helpers stay read-only; only named writer/materializer modules may persist these surfaces.

## Overview serving projections

| Surface | Owner module | Actual trigger / entrypoint | Ownership mode | Forbidden contexts | Freshness strategy |
| --- | --- | --- | --- | --- | --- |
| `platform_overview_daily_summary` | `lib/overview-summary-materializer.ts` | `lib/meta/warehouse.ts`, `lib/platforms/google/warehouse.ts` | Automated sync/warehouse completion | Passive `GET`, `lib/overview-service.ts`, `lib/platforms/google/serving.ts`, `lib/overview-summary-store.ts` | Warehouse upserts refresh daily rows; GET serves durable rows or computes ephemeral fallback |
| `platform_overview_summary_ranges` | `lib/overview-summary-materializer.ts` via `lib/overview-summary-range-owner.ts` | `npm run overview:summary:materialize -- --business-id ... --provider meta|google --start-date ... --end-date ... [--provider-account-ids ...]` | Manual/script owner for exact selected historical ranges, backfill, and manual refresh | Passive `GET`, shared read helpers, route handlers | Warehouse upserts invalidate manifests, but exact range hydration stays explicit. Google projection fallback only consumes exact historical windows, and the current materializer writes finalized manifests, so no exact existing worker/cron/admin lane can safely pre-hydrate arbitrary or speculative selected ranges. See `docs/architecture/serving-operational-freshness-matrix.md`. |

## User-facing durable reporting caches

| Surface | Owner module | Actual trigger / entrypoint | Ownership mode | Forbidden contexts | Freshness strategy |
| --- | --- | --- | --- | --- | --- |
| `provider_reporting_snapshots` `ga4_analytics_overview` | `lib/reporting-cache-writer.ts` via `lib/user-facing-report-cache-owners.ts` | `lib/sync/ga4-sync.ts` | Automated sync owner for bounded default windows plus manual/script owner for non-default windows | Passive `GET`, `lib/reporting-cache.ts`, `lib/route-report-cache.ts`, overview/shopify read helpers | GA4 sync proactively warms only the shared default `30d` / `7d` windows. Non-default windows stay explicit CLI warmers. |
| `provider_reporting_snapshots` `ecommerce_fallback` | `lib/reporting-cache-writer.ts` via `lib/user-facing-report-cache-owners.ts` | `lib/sync/ga4-sync.ts` for automated default `30d` / `7d` windows; `npm run reporting:cache:warm -- --business-id ... --report-type ecommerce_fallback --start-date ... --end-date ...` for targeted refresh/backfill | Automated sync owner for default windows plus manual/script owner for non-default windows | Passive `GET`, `lib/overview-service.ts`, shared read helpers | GA4 sync warms the overview fallback snapshot for the shared default windows; non-default windows stay explicit operator warmers. |
| `provider_reporting_snapshots` `ga4_detailed_audience`, `ga4_detailed_cohorts`, `ga4_detailed_demographics`, `ga4_landing_page_performance_v1`, `ga4_detailed_landing_pages`, `ga4_detailed_products` | `lib/reporting-cache-writer.ts` via `lib/user-facing-report-cache-owners.ts` | `lib/sync/ga4-sync.ts` for automated default `30d` / `7d` windows; `npm run reporting:cache:warm -- --business-id ... --report-type <ga4_type> --start-date ... --end-date ... [--dimension ...]` for targeted refresh/backfill | Automated sync owner for default windows plus manual/script owner for targeted refresh/backfill | Passive `GET`, analytics route handlers, shared read helpers | GA4 sync schedules only the shared bounded detail warmers. Alternate demographics dimensions and non-default windows remain explicit operator warmers. |
| `provider_reporting_snapshots` `overview_shopify_orders_aggregate_v6` | `lib/reporting-cache-writer.ts` via `lib/user-facing-report-cache-owners.ts` | `lib/sync/shopify-sync.ts` for the existing recent sync window when overview materialization is enabled; `npm run reporting:cache:warm -- --business-id ... --report-type overview_shopify_orders_aggregate_v6 --start-date ... --end-date ...` for targeted refresh/backfill | Automated sync owner for the recent sync window plus manual/script owner for targeted warmups | Passive `GET`, `lib/shopify/overview.ts`, overview/shared read helpers | Existing Shopify sync lanes snapshot only the current bounded recent window without reintroducing write-on-read; targeted or non-sync windows remain explicit operator warmers. |
| `seo_results_cache` `overview` / `findings` | `lib/seo/results-cache-writer.ts` | `lib/sync/search-console-sync.ts` | Automated sync owner | Passive `GET`, `lib/seo/results-cache.ts`, SEO route handlers | Search Console sync warms both cache shapes for default windows; GET only reads cache or computes ephemeral fallback |

## Shopify overview serving state

| Surface | Owner module | Actual trigger / entrypoint | Ownership mode | Forbidden contexts | Freshness strategy |
| --- | --- | --- | --- | --- | --- |
| `shopify_serving_state` | `lib/shopify/overview-materializer.ts` | `lib/sync/shopify-sync.ts` for post-sync trust recovery; `app/api/webhooks/shopify/sync/route.ts` only for lightweight pending-repair marks | Automated sync owner plus limited webhook mutation lane | Passive `GET`, `lib/shopify/read-adapter.ts`, `lib/shopify/overview.ts`, `lib/shopify/warehouse.ts` read helpers | Sync completion advances durable trust state; webhook path can only mark pending repair, never do heavy reconciliation inline |
| `shopify_reconciliation_runs` | `lib/shopify/overview-materializer.ts` | `lib/sync/shopify-sync.ts` | Automated sync owner | Passive `GET`, `lib/shopify/read-adapter.ts`, `lib/shopify/status.ts` | Reconciliation evidence is recorded only after explicit sync completion, not during reads or webhook ack paths |

## Rules

- Shared read helpers must not import the writer/materializer modules above.
- `GET` routes may only read the durable state these tables/caches already hold.
- If no safe automated owner exists, add an explicit script/CLI owner and document the exact command. Do not leave in-scope serving surfaces unwired.
- Owner exceptions are intentionally tiny. Current explicit allowlist outside the owner modules is limited to `lib/platforms/google/warehouse.ts` and `scripts/reset-google-ads-stack.ts` for out-of-scope Google Ads reset/deletion flows touching `provider_reporting_snapshots`.
