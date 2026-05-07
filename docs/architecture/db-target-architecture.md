# DB Target Architecture

Goal: define the final request-path, serving-write, and operator-lane policy for the current repository state, while separating accepted normalization closeout from later non-blocking architecture cleanup.

## Current implemented state

The current repo state already enforces these hardening outcomes:

- HTTP-triggered migrations are retired. `/api/migrate` is disabled and points operators to `npm run db:migrate`.
- Request/read paths use `lib/db-schema-readiness.ts` for read-only readiness checks instead of `runMigrations()`.
- Passive `GET`/read routes are side-effect free.
- User-facing serving/projection/cache writes belong only to explicit non-`GET` owner lanes.
- Automated vs manual freshness boundaries are explicit and operator-visible.
- Runtime validation evidence exists for passive `GET` non-mutation and explicit owner advancement.
- Direct production release guidance, verification, rollback, and release execution evidence exist in the repo.
- Core integration authority now lives in the canonical backbone: `provider_accounts`, `provider_connections`, `integration_credentials`, `business_provider_accounts`, `provider_account_snapshot_runs`, and `provider_account_snapshot_items`.
- Legacy tables `integrations`, `provider_account_assignments`, and `provider_account_snapshots` are removed from the live schema. They are no longer request-path source-of-truth tables and remain relevant only as historical references in architecture docs and artifacts.

## Canonical core backbone

The current authoritative integration/account model is:

`businesses -> provider_connections -> integration_credentials`

`businesses -> business_provider_accounts -> provider_accounts`

`businesses -> provider_account_snapshot_runs -> provider_account_snapshot_items -> provider_accounts`

Rules:
- Request/runtime code reads the canonical backbone only.
- Legacy core compatibility tables are removed and must not be reintroduced as active dependencies.
- New DB work must prefer FK-backed `business_ref_id` and `provider_account_ref_id` columns over text-only joins whenever the table already supports them.

## Request-path rule

Request handlers, auth/access reads, server-side share/report lookups, and route-local cache readers must never call `runMigrations()` directly or transitively.

No HTTP route may execute migrations. This includes `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, webhook handlers, and non-`/api` route handlers under `app/**/route.ts`.

Passive `GET`/read routes and the helpers they call must be side-effect free.
- No DB writes
- No durable cache writes
- No projection hydration or upsert on read
- No serving-state or reconciliation-state updates on read
- No lazy repair/refresh triggers on read
- No background refresh enqueue from passive `GET`

Allowed request-path schema behavior:
- Read-only readiness checks via `lib/db-schema-readiness.ts`
- Safe degraded empty/null/status responses that preserve existing contracts
- Existing request-time DML that is already part of the contract, but only after schema readiness is confirmed

Allowed read-time fallback order for passive `GET` surfaces:
1. Serve the last durable projection/state read-only.
2. Compute an ephemeral response from warehouse/live inputs without persisting it.
3. Return the existing degraded/empty/null contract already used by that surface.

Callback-style `GET` routes such as OAuth/install handshakes are not passive read surfaces. They may remain explicit mutation entrypoints, but they still may not execute migrations.

Disallowed request-path schema behavior:
- `runMigrations()` in `GET`, auth/access checks, middleware, shared read helpers, or route-local missing-table fallback
- `runMigrations()` in any HTTP mutation, admin, ops, OAuth, or webhook route
- Migrate-on-read retries after `relation does not exist`
- HTTP-triggered schema bootstrap through legacy operator endpoints such as `/api/migrate`

## Target layer model

| Layer | Responsibility | Allowed writes | Allowed request-time reads |
| --- | --- | --- | --- |
| `core` | Users, businesses, access control, integration bindings, manual business settings. | UI/API mutations and OAuth/install flows. | Yes |
| `control` | Sync scheduling, leases, checkpoints, cooldowns, repair state, provider health internals. | Workers, cron, webhooks, admin repair tools. | Only through dedicated status read models, not raw control tables. |
| `raw` | Immutable or append-oriented provider payload capture. | Workers/webhooks only. | No direct UI/API reads. |
| `warehouse` | Normalized historical provider truth tables. | Sync workers and post-sync materializers. | Yes, but read-only and scoped to stable repository interfaces. |
| `serving` | API-facing projections, caches, summaries, advisor snapshots, share payloads. | Materializers, background cache warmers, explicit UI mutations that create shares/reports. | Yes |
| `audit` | Operational/event audit trails and reconciliation evidence. | Workers, admin actions, webhook processors, execution logs. | Read-only diagnostics/admin only. |

## Target data flow

`Provider API -> raw -> warehouse -> serving -> API -> UI`

Expected behaviors:
- Request handlers read `core`, `warehouse`, and `serving`.
- Request handlers may probe schema readiness, but they do not bootstrap schema.
- Workers/webhooks mutate `control`, `raw`, `warehouse`, `serving`, and `audit`.
- `control` tables should not be the primary UI contract; routes should read from compact serving summaries derived from control state.
- `serving` tables should be populated by sync completion hooks, workers, or explicit admin actions, not by passive `GET` traffic.
- User-facing serving/projection/cache persistence must happen only in explicit materializer/writer lanes, never in shared read helpers.
- Current explicit writer modules are `lib/overview-summary-materializer.ts`, `lib/reporting-cache-writer.ts`, `lib/seo/results-cache-writer.ts`, and `lib/shopify/overview-materializer.ts`.

## direct-live lane exceptions

The target architecture still allows narrow live exceptions, but they must be explicit and isolated.

1. Meta current-day summary/campaign lane
   - Only when the selected range is the provider current day.
   - Reads directly from Meta API plus read-only config snapshots.
   - Must never backfill or mutate warehouse/projection tables from the request thread.

2. Google Ads current-day overlay lane
   - Only for a same-day window.
   - Live output may overlay warehouse-unavailable current-day metrics.
   - Historical requests must stay on warehouse/projection only.

3. Shopify live fallback lane
   - Only when warehouse/ledger trust is not ready or an explicit override requires live mode.
   - Trust assessment persistence should happen off-path; the request should only consume the latest serving decision read-only.

4. GA4 ecommerce fallback lane
   - Non-authoritative enrichment for revenue/purchase/AOV only when Shopify truth is absent.
   - Cache warming must move off-path; request-time fallback can only compute ephemeral output.

## Safe implementation order

1. Keep request-path guarantees locked.
   - Preserve existing route response contracts.
   - Keep the side-effect scan, architecture baseline, and route contract tests green.

2. Keep schema bootstrap request-external only.
   - No HTTP route may execute migrations.
   - Request-time callers may only use `db-schema-readiness` and safe degrade paths.
   - Explicit operator bootstrap entrypoints remain `npm run db:migrate` and `node --import tsx scripts/run-migrations.ts`.
   - `/api/migrate` stays disabled and must not be repurposed as a bootstrap lane.

3. Keep passive `GET` routes write-free.
   - `GET` routes may only read durable projections, compute ephemeral fallbacks, or return existing degraded contracts.
   - Shopify serving-state persistence, reconciliation inserts, overview projection hydration, report-cache writes, and refresh triggers must remain off-path.

4. Keep serving/cache ownership explicit.
   - Shared read modules stay read-only.
   - User-facing serving/projection/cache persistence stays in named materializer/writer modules and explicit non-`GET` owner lanes.
   - If no safe automated owner exists, keep the boundary intentional and operator-owned; do not reintroduce write-on-read.

## Post-closeout architecture follow-up priorities

1. Isolate live lanes further.
   - Split Meta live, Google live overlay, Shopify live fallback, and GA4 fallback behind narrower adapters with explicit precedence rules.

2. Introduce more stable repository boundaries.
   - Separate `core`, `control`, `warehouse`, and `serving` repositories so API routes and UI services consume smaller typed contracts.

3. Publish serving read models for status and overview.
   - Provider status should eventually come from serving summaries rather than direct queue/checkpoint joins.
   - Overview projection materialization should continue to run after sync completion, not during reads.

4. Break large mixed-concern modules after the seams are stable.
   - `lib/platforms/google/warehouse.ts`, `lib/platforms/google/serving.ts`, `lib/meta/serving.ts`, `lib/migrations.ts`, and `app/api/overview-summary/route.ts` remain the highest-value cleanup targets.

## Non-goals of the current policy

- No endpoint response-shape changes.
- No same-window destructive cleanup during stabilization observation.
- No monolithic schema rewrite.
- No cutover from live lane to warehouse lane in one step.
- No behavior-changing refactor under the banner of reopening accepted normalization closeout.
