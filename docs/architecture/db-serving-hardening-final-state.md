# DB / Serving Hardening Final State

Purpose: give future engineers and operators one concise entry point for the current DB/serving hardening state without re-reading the full execution history.

## Before vs after

Before:

- Request paths could bootstrap schema through `runMigrations()`.
- Passive `GET` routes could persist serving state, cache rows, projection rows, or refresh triggers.
- Serving/projection/cache ownership was blurred across shared read helpers and broad repository files.
- Freshness gaps existed but were not all explicit or operator-visible.

After:

- HTTP-triggered migrations are retired. `/api/migrate` is disabled and points operators to `npm run db:migrate`.
- Request/read paths use read-only schema readiness and degrade safely when required tables are absent.
- Passive `GET`/read routes are side-effect free.
- User-facing serving/projection/cache writes belong only to explicit non-`GET` owner lanes.
- Automated vs manual freshness boundaries are documented, operator-visible, and paired with exact fallback commands.
- Runtime validation evidence and direct-release evidence both exist in the repo.

## Final guarantees now in place

- No HTTP route may execute migrations.
- Passive `GET`/read routes must not write DB state, durable cache state, projections, serving state, reconciliation rows, or refresh triggers.
- Shared read helpers remain read-only.
- Readiness checks are read-only and flow through `lib/db-schema-readiness.ts`.
- User-facing serving/projection/cache writes happen only in explicit materializer/writer lanes.
- Release verification and rollback use exact-SHA deploy semantics, not branch names or floating tags.

## Explicit owner model

Current user-facing writer/materializer modules:

- `lib/overview-summary-materializer.ts`
- `lib/reporting-cache-writer.ts`
- `lib/seo/results-cache-writer.ts`
- `lib/shopify/overview-materializer.ts`

Current automated owner lanes:

- `lib/sync/ga4-sync.ts`
- `lib/sync/search-console-sync.ts`
- `lib/sync/shopify-sync.ts`

Current explicit manual owner lanes:

- `npm run overview:summary:materialize`
- `npm run reporting:cache:warm`

Reference:

- `docs/architecture/serving-write-ownership-map.md`

## Automated vs manual freshness

Automated:

- GA4 default bounded windows for overview, ecommerce fallback, and the bounded detailed snapshot set
- Search Console default bounded windows for `seo_results_cache`
- Shopify recent bounded window for `overview_shopify_orders_aggregate_v6`, `shopify_serving_state`, and `shopify_reconciliation_runs`

Intentional manual/operator-owned:

- `platform_overview_summary_ranges` exact selected historical ranges
- Non-default GA4 windows
- Non-`country` `ga4_detailed_demographics` dimensions
- `overview_shopify_orders_aggregate_v6` outside the automated recent window

References:

- `docs/architecture/serving-operational-freshness-matrix.md`
- `docs/architecture/serving-freshness-observability-runbook.md`

## Runtime validation and release status

- Runtime validation closed successfully and proved:
  - repeated authenticated passive `GET` traffic did not mutate the exercised in-scope serving/projection/cache keys
  - explicit non-`GET` owner lanes advanced the intended automated and manual surfaces
  - the constrained Shopify recent-window owner lane completes and advances the expected recent serving surfaces
- Product-ready signoff reached `GO` under the documented deploy prerequisite.
- Direct production release was later executed successfully, and release verification passed.

References:

- `docs/architecture/serving-runtime-validation-evidence.md`
- `docs/architecture/serving-product-ready-signoff.md`
- `docs/architecture/serving-direct-production-release-runbook.md`
- `docs/architecture/serving-release-execution-evidence.md`

## Operator command groups

Schema bootstrap:

- `npm run db:migrate`

Guardrails and baseline:

- `npm run db:architecture:baseline`
- `node --import tsx scripts/check-request-path-side-effects.ts --json`

Read-only status / observability:

- `node --import tsx scripts/report-serving-freshness-status.ts <businessId> [...]`

Manual owner commands:

- `npm run overview:summary:materialize -- --business-id <business_id> --provider ... --start-date ... --end-date ...`
- `npm run reporting:cache:warm -- --business-id <business_id> --report-type ... --start-date ... --end-date ...`

Release verification:

- `node --import tsx scripts/verify-serving-direct-release.ts <businessId> --mode=preflight [...]`
- `node --import tsx scripts/verify-serving-direct-release.ts <businessId> --mode=post_deploy --base-url=https://adsecute.com --expected-build-id=<sha> [...]`

## Remaining non-blocking debt

- Large mixed-concern modules remain, especially `lib/platforms/google/warehouse.ts`, `lib/platforms/google/serving.ts`, `lib/meta/serving.ts`, and `lib/migrations.ts`.
- Status routes still couple directly to control-plane tables instead of dedicated serving summaries.
- Some request-time orchestration paths still read across live, warehouse, and serving layers inside broad modules, even though passive-read writes are removed.
- Intentional manual freshness boundaries remain operator-owned by design.

Use this doc as the high-level entry point. Use the linked detailed artifacts for exact evidence, commands, and owner rationale.
