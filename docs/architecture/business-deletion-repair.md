# Business deletion repair — 2026-10-08

The old teardown deleted `business_provider_accounts` before its Meta observation
and native-decision children. A real migrated PostgreSQL reproduces SQLSTATE
23503 on `meta_entity_observation_runs_binding_fk`. The enclosing transaction
rolls back; this is not a database-growth admission refusal. The user-facing
picker also offered deletion to collaborators whom the API refuses.

Both DELETE routes now use `deleteBusinessWithData`. Its reviewed ownership
allowlist covers the migrated schema plus three optional legacy provider tables.
Catalog foreign keys determine child-before-parent order. Every DELETE uses the
one authenticated business ID, with bound values and quoted catalog identifiers.
Shared users and provider accounts remain; connection credentials cascade from
only the removed connections. Legacy share payload ownership is used only when
its explicit ownership columns are null. Sessions lose the deleted active scope.
The assignment kill switch, advisory lock, business row lock, foreign keys and
immutable-record triggers stay enabled. Unexpected ownership tables, cycles,
contradictory owners, live provider leases and active jobs refuse before writes.
Any later SQL failure rolls the whole transaction back, preserving membership
and the ability to retry. The API does not claim rollback when a connection or
commit failure leaves the outcome unknown.

## Supported scope and intentional limit

This repair supports businesses with removable warehouse/observation history.
It does **not** authorize deleting protected native calibrations, context objects,
operator receipts or advertising/controlled-experiment journals. If any scoped
table has an enabled user DELETE trigger and contains business rows, the route
returns `409/protected_history` before mutation. This is deliberately conservative,
including conditional DELETE triggers: no trigger is disabled or bypassed.
Retained native evaluation/snapshot/context/event lineage and frozen campaign
labels are also hard pins even where they have no DELETE trigger.
An explicit controlled-offboarding design is still required for those businesses.
Do not call this universal deletion support or storage closure.

The optional `db_normalization_orphan_core_legacy` recovery archive is created by
`scripts/db-normalization-archive-orphans.ts`, outside the migrations. It is a
reviewed retained table, not a deletion target. Its presence must not prevent
unrelated business removal. Matching business history still refuses the teardown
before writes; the archive is preserved unchanged. Other unknown ownership tables
continue to fail closed.

Manage Business confirms the business is absent from a fresh authoritative list
before clearing local state or announcing success. It selects the next workspace
from that same list and distinguishes a completed deletion from a failed session
switch. Its confirmation describes
the permanent local-data effect, preserved provider accounts/backups, possible
protected-history refusal, and the absence of a guaranteed disk-size reduction.

## Validation and live acceptance

`lib/business-deletion.db.test.ts` has thirteen cases on a disposable PostgreSQL
with the real migrations, registered in the canonical migrations harness. They
cover the old failure, supported deletion, shared-account/tenant isolation,
credential/session cleanup, immutable evidence, unknown schema, late-FK rollback,
live lease refusal, growth-refused removal, conflicting owners, kill switch,
absent businesses and frozen campaign labels.
Two cases reproduce the optional legacy archive, checking unrelated deletion
with the original archive unchanged and target-owned history refusal with no
loss of access or facts.
Route and mounted picker tests cover the contract, permissions and fresh readback.

Before publication, complete `npm run verify:pre-push`, exact-head CI and image
gates. No selected production business has been deleted to test this repair.
After an authorized deployment, the user chooses the exact business and confirms
its name in the product. Read back business-list absence and scoped cleanup;
measure database size and capacity admission separately. Protected-history
refusal must preserve both access and evidence. SQL DELETE frees reusable tuple
space; it generally does not shrink PostgreSQL files immediately, so this alone
does not prove that a `pg_database_size` admission gate will reopen.

## Rollback

Revert this repair and redeploy the prior image using the canonical release
workflow. There is no schema migration. A code rollback cannot restore data that
the user has already permanently deleted; restoration requires the existing
backup/recovery process. Backups, retention, growth budgets and provider state
are not changed by this repair. No automatic data deletion runs on deployment.
