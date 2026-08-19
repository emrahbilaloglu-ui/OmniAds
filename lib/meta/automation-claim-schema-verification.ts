/**
 * Post-migration proof that the Automation execution-claim schema landed.
 *
 * WHY IT IS A SEPARATE MODULE. It is a sibling of `lib/migration-verification.ts`
 * for the same reason that file exists: `runMigrations` is exercised by unit
 * tests against a stub database, and a verifier that reads the real catalog can
 * only be honest there by being mockable. Those tests neutralize the sibling
 * verifier with `vi.mock("@/lib/migration-verification", ...)` and rely on the
 * real-PostgreSQL seams for the actual behaviour; this module is imported the
 * same way, mocked the same way, and proven the same way — by
 * `scripts/ephemeral-postgres-automation-claim-race-seam.ts`, which also
 * reproduces a genuinely unrepairable schema state and REQUIRES the migration
 * to exit non-zero over it.
 */
import { getDb } from "@/lib/db";

/**
 * The Automation execution-claim schema, verified as a MANDATORY deploy gate.
 *
 * WHY THIS IS NOT OPTIONAL. Every statement that builds this schema ends in
 * `.catch(() => {})` — the four claim columns, the widened status CHECK, the
 * unique claim-token index, the open-slot index and the removal of the
 * pending-only index it supersedes. That is a reasonable pattern for a DDL that
 * is idempotent-or-already-done, and a catastrophic one as the ONLY guarantee
 * here, because every object below is load-bearing for a provider WRITE:
 *
 * - Without `claim_token` / `claimed_at` / `dispatch_started_at`, an approval
 *   cannot be exclusive, and two concurrent approvals both reach Meta.
 * - Without `reconcile` in the status CHECK, an attempt whose provider outcome
 *   is unknown cannot be recorded as unknown, and the code's only remaining
 *   options are to call it a success or to requeue it — a guess either way.
 * - Without the open-slot index covering pending + claimed + reconcile, the
 *   database stops being the backstop for one-action-per-entity, and a snapshot
 *   projection can raise a second pause for an entity whose first pause may
 *   already be live at Meta.
 * - Without the append-only reconciliation table, the post-dispatch failure
 *   path has nowhere durable to put a receipt, so a provider write that was
 *   dispatched can leave no trace an operator can find.
 *
 * So: a swallowed failure on any of them must FAIL THE RELEASE, not start the
 * application over a schema that cannot support the code about to run on it.
 * This function runs inside `runMigrations` before completion is announced, and
 * it throws.
 */
export async function assertMetaAutomationClaimSchema(
  sql: Pick<ReturnType<typeof getDb>, "query">,
): Promise<string[]> {
  const failures: string[] = [];
  const verified: string[] = [];

  const columns = (await sql.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'meta_automation_proposals'`,
  )) as Array<{ column_name: string }>;
  const present = new Set(columns.map((row) => row.column_name));
  for (const column of [
    "claim_token",
    "claimed_by",
    "claimed_at",
    "dispatch_started_at",
  ]) {
    if (present.has(column)) verified.push(`column:${column}`);
    else failures.push(`meta_automation_proposals.${column} is missing`);
  }

  const statusChecks = (await sql.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema()
       AND t.relname = 'meta_automation_proposals'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%dismissed%'`,
  )) as Array<{ def: string }>;
  if (statusChecks.length === 0) {
    failures.push(
      "the meta_automation_proposals status CHECK constraint is missing entirely",
    );
  } else {
    for (const row of statusChecks) {
      if (!row.def.includes("'claimed'") || !row.def.includes("'reconcile'")) {
        failures.push(
          `a status CHECK still refuses 'claimed'/'reconcile': ${row.def}`,
        );
      }
    }
    verified.push("constraint:status_vocabulary");
  }

  const indexes = (await sql.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename IN (
         'meta_automation_proposals',
         'meta_automation_reconciliation_receipts'
       )`,
  )) as Array<{ indexname: string; indexdef: string }>;
  const indexByName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

  const openSlot = indexByName.get("uq_meta_automation_proposals_open_slot");
  if (!openSlot) {
    failures.push("uq_meta_automation_proposals_open_slot is missing");
  } else if (
    !openSlot.includes("UNIQUE") ||
    !openSlot.includes("'pending'") ||
    !openSlot.includes("'claimed'") ||
    !openSlot.includes("'reconcile'")
  ) {
    // Substring matching is enough here only because the predicate is a fixed
    // literal list this file writes; the failure it must catch is the earlier
    // pending+claimed predicate surviving, and that one is missing 'reconcile'.
    failures.push(
      `uq_meta_automation_proposals_open_slot does not hold the slot for pending + claimed + reconcile: ${openSlot}`,
    );
  } else {
    verified.push("index:open_slot");
  }

  if (indexByName.has("uq_meta_automation_proposals_pending_slot")) {
    // Not cosmetic. Its presence means the DROP guarded on the open-slot index
    // never ran, which is the signature of an open-slot index that was never
    // created in this deployment's history.
    failures.push(
      "uq_meta_automation_proposals_pending_slot survived the index that supersedes it",
    );
  } else {
    verified.push("index:pending_slot_removed");
  }

  const claimToken = indexByName.get(
    "uq_meta_automation_proposals_claim_token",
  );
  if (!claimToken || !claimToken.includes("UNIQUE")) {
    failures.push(
      "uq_meta_automation_proposals_claim_token is missing or not unique, so a receipt key would not identify one attempt",
    );
  } else {
    verified.push("index:claim_token");
  }

  const reconciliationTable = (await sql.query<{ exists: boolean }>(
    `SELECT to_regclass('meta_automation_reconciliation_receipts') IS NOT NULL AS exists`,
  )) as Array<{ exists: boolean }>;
  if (!reconciliationTable[0]?.exists) {
    failures.push("meta_automation_reconciliation_receipts is missing");
  } else {
    verified.push("table:reconciliation_receipts");
    if (!indexByName.has("uq_meta_automation_reconciliation_claim_token")) {
      failures.push(
        "uq_meta_automation_reconciliation_claim_token is missing, so one attempt could hold two reconciliation receipts",
      );
    } else {
      verified.push("index:reconciliation_claim_token");
    }
    const trigger = (await sql.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema()
           AND c.relname = 'meta_automation_reconciliation_receipts'
           AND t.tgname = 'trg_meta_automation_reconciliation_append_only'
       ) AS exists`,
    )) as Array<{ exists: boolean }>;
    if (!trigger[0]?.exists) {
      failures.push(
        "trg_meta_automation_reconciliation_append_only is missing, so an attempt's recorded facts are rewritable",
      );
    } else {
      verified.push("trigger:reconciliation_append_only");
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Automation claim schema verification failed (${failures.length}):\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
  return verified;
}
