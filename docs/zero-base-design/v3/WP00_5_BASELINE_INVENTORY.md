# WP-00.5 — Post-baseline capability and schema inventory

**Baseline:** `b082885be` (WP-00 merge; `origin/main` `23e9fc86e` + safety history)
**Date:** 2026-08-11 · read-only inventory, no code changed by this package.

Master plan §10.1 disposition after G0. Every path below was checked in this
worktree at the G0 commit, not in the stale planning tree.

## Design-named product APIs

| Path | Present at G0 | Disposition |
|---|---|---|
| `GET /api/agency-today` | **PRESENT** | **ADOPT + ADAPT** — retain route/store/read-model; add the safe Agency projection and remove money/severity/ranking from the canonical UI path. Legacy projection stays until WP-27. |
| `GET /api/search` | **PRESENT** | **ADOPT + ADAPT** — retain route/store; add cap, truncation envelope, permission-empty copy and canonical links. |
| `POST /api/instrumentation/event` | **PRESENT** | **ADOPT + EXTEND** — retain first-party sink/table/health/retention; extend additively to the vendored 74-surface ledger. No second telemetry store. |
| `GET/POST /api/meta/decision-workflow` | **PRESENT** | **ADOPT + HARDEN** — retain route, service, tables and optimistic version authority; add only missing validation/idempotency/atomicity. |
| `POST /api/meta/decision-action/preflight` | **PRESENT** | **ADOPT + HARDEN** — retain route/service; make the zero-base mode decision-bound, server-derived, multi-grain, aged and explicitly provider-offline. |
| `/api/notifications` | **PRESENT** | **RETAIN BACKEND / NO ZERO-BASE UI** — no bell, feed, polling or navigation. Do not delete infrastructure. |
| `/api/notifications/[deliveryId]` | **PRESENT** | **RETAIN BACKEND / NO ZERO-BASE UI** — preserve compatibility; no canonical caller. |
| `/api/db-test` | **ABSENT at G0** | Nothing to do. WP-06's production fail-closed step is a **no-op** and must not create the route. |

**No implementation WP may create any of these.** Master-plan §10.2–§10.5 contract shapes are superseded by the adopted routes; the existing request/response behaviour is preserved until WP-27, with canonical callers using an explicit `contract=zero-base.v1` discriminator where the final shape would break an existing caller.

## Persistence present at G0

| Object | Location | Disposition |
|---|---|---|
| `decision_workflow_state` | `lib/migrations.ts` (~:6840) | **ADOPT.** Never create `meta_decision_workflow_state`. |
| `decision_workflow_events` | `lib/migrations.ts` (~:6867) | **ADOPT.** Never create `meta_decision_workflow_events`. |
| `idx_decision_workflow_state_business_state`, `idx_decision_workflow_state_assignee`, `idx_decision_workflow_events_decision` | `lib/migrations.ts` | **ADOPT** as-is. |
| `product_instrumentation_events` | `lib/migrations.ts` (~:13762) | **ADOPT + EXTEND** additively only; keep v1 writes readable. |
| `product_instrumentation_sink_health` | `lib/migrations.ts` (~:13821) | **ADOPT** — remains the single operational authority for health/retention. |

## Supporting modules present at G0

`lib/decision-workflow.ts`, `lib/decision-workflow-store.ts`, `lib/agency-today-read-model.ts`, `lib/agency-today-store.ts`, `lib/entity-search.ts`, `lib/entity-search-store.ts`, `lib/product-instrumentation.ts`, `lib/meta/decision-origin-action-preflight.ts` — all **ADOPT**; record each contract and its tests before editing.

## Known behaviour gaps to close in the owning packages (not here)

- Agency Desk currently returns and ranks money/severity — incompatible with the safe field contract (WP-10).
- Search returns legacy deep links and no truncation envelope (WP-08).
- Workflow lacks parts of the final idempotency/validation contract (WP-13).
- Preflight is ad-only and trusts client-supplied expected fields (WP-14).
- Instrumentation does not yet cover the 74-surface screen ledger (WP-07).

## Environment note

This shell requires an explicit UTF-8 locale or `initdb` fails and every
ephemeral-PostgreSQL seam reports a false `pg_ctl` failure:

```bash
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
```
