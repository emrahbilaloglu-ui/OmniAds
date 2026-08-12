/**
 * Additive hardening for the existing workflow overlay.
 *
 * One nullable column and one partial unique index on the tables that already
 * exist. No second table, no parallel store, no route of its own — the plan is
 * explicit that `decision_workflow_state` and `decision_workflow_events` are
 * the authority, and a parallel pair would split the event journal in two.
 *
 * `mutation_id` gives a client-generated idempotency key. Without it a retried
 * POST — a flaky connection, a double click, a mobile browser restoring a
 * request — appends a second event and bumps the version again, so the operator
 * sees their own action twice and the next actor's expectedVersion is wrong.
 * The index is partial so the rows already in the table, which have no
 * mutation id, do not collide with each other.
 */

export function workflowIdempotencyUpgradeStatements(): string[] {
  return [
    `ALTER TABLE decision_workflow_events
       ADD COLUMN IF NOT EXISTS mutation_id UUID`,

    // Scoped to the business: two tenants may legitimately generate the same
    // client-side id, and a global unique index would let one tenant's retry
    // silently suppress another tenant's event.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_decision_workflow_events_mutation
       ON decision_workflow_events (business_id, mutation_id)
       WHERE mutation_id IS NOT NULL`,

    `CREATE INDEX IF NOT EXISTS idx_decision_workflow_events_decision_created
       ON decision_workflow_events (business_id, decision_key, created_at DESC)`,
  ];
}
