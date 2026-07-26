import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import {
  ASSIGNMENT_REQUIRED_TABLES,
  handleProviderAssignmentRequest,
} from "@/lib/provider-assignment-service";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import { describeSyncSafetyRefusal } from "@/lib/sync/safety-refusal";
import { readProviderConnectionGenerationToken } from "@/lib/provider-account-snapshots";
import { syncMetaInitial } from "@/lib/sync/meta-sync";

/**
 * POST /businesses/:businessId/meta/assign-accounts
 *
 * Every guard lives in `handleProviderAssignmentRequest`, which both providers
 * share. This file supplies only the Meta-specific scheduling step and its
 * durability proof.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> }
) {
  const { businessId } = await params;
  logRuntimeDebug("meta-assign-accounts", "request", { businessId });

  return handleProviderAssignmentRequest(
    {
      provider: "meta",
      label: "meta-assign-accounts",
      requiredTables: ASSIGNMENT_REQUIRED_TABLES.meta,
      schedule: async ({ businessId: id, accountIds, connectionGeneration, schedulingAttemptId }) => {
        if (accountIds.length === 0) {
          return {
            scheduled: true,
            detail: "no accounts selected; nothing to schedule",
            refusal: null,
          };
        }
        try {
          await syncMetaInitial(id);
        } catch (error) {
          // A lane or capacity refusal is structured; it must survive as
          // structure rather than being flattened to null and reported as a
          // healthy integration.
          return {
            scheduled: false,
            detail: error instanceof Error ? error.message : String(error),
            refusal: describeSyncSafetyRefusal(error),
          };
        }
        // Durable readback, scoped to THIS operation.
        //
        // Counting every queued partition for the business made `syncScheduled:
        // true` satisfiable by unrelated work: a backfill still draining for a
        // different account, or a concurrent selection by another request,
        // reported success for accounts that had nothing enqueued at all.
        //
        // The readback therefore requires partitions for the exact committed
        // account ids, created after this request began scheduling, and it
        // requires EVERY committed account to have at least one — a partial
        // enqueue is a 202, not a success.
        try {
          const sql = getDb();
          const rows = (await sql`
            SELECT provider_account_id, COUNT(*)::int AS queued
            FROM meta_sync_partitions
            WHERE business_id = ${id}
              AND provider_account_id = ANY(${accountIds}::text[])
              AND status IN ('queued', 'leased', 'running')
              -- THIS attempt's work, by immutable id. A clock window is
              -- satisfiable by a concurrent enqueue and breakable by skew
              -- between the app clock and the database clock.
              AND scheduling_attempt_id = ${schedulingAttemptId}::uuid
            GROUP BY provider_account_id
          `) as Array<{ provider_account_id: string; queued: number }>;
          const scheduledAccounts = new Set(rows.map((row) => row.provider_account_id));
          const missing = accountIds.filter((accountId) => !scheduledAccounts.has(accountId));
          const queued = rows.reduce((total, row) => total + Number(row.queued ?? 0), 0);

          // ...and the connection must still be the one this selection was
          // validated and written under. Work enqueued for a credential the
          // user replaced mid-request is not work anyone asked for.
          const currentGeneration = await readProviderConnectionGenerationToken(id, "meta");
          if (connectionGeneration != null && currentGeneration !== connectionGeneration) {
            return {
              scheduled: false,
              detail: `the Meta connection changed while scheduling (expected ${connectionGeneration}, found ${currentGeneration ?? "none"})`,
              refusal: null,
            };
          }

          return {
            scheduled: missing.length === 0 && queued > 0,
            detail:
              missing.length === 0
                ? `${queued} Meta partition(s) queued for ${accountIds.length} selected account(s)`
                : `no new Meta partitions for: ${missing.join(", ")}`,
            refusal: null,
          };
        } catch (error) {
          return {
            scheduled: false,
            detail: `scheduling readback failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            refusal: null,
          };
        }
      },
    },
    request,
    businessId,
  );
}
