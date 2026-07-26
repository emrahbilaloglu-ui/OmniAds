import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import {
  ASSIGNMENT_REQUIRED_TABLES,
  handleProviderAssignmentRequest,
} from "@/lib/provider-assignment-service";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import { describeSyncSafetyRefusal } from "@/lib/sync/safety-refusal";
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
      schedule: async ({ businessId: id, accountIds }) => {
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
        // Durable readback: enqueueing is only real if the work is now visible
        // in the queue. `syncMetaInitial` resolving proves it ran, not that it
        // left anything behind.
        try {
          const sql = getDb();
          const rows = (await sql`
            SELECT COUNT(*)::int AS queued
            FROM meta_sync_partitions
            WHERE business_id = ${id}
              AND status IN ('queued', 'leased', 'running')
          `) as Array<{ queued: number }>;
          const queued = Number(rows[0]?.queued ?? 0);
          return {
            scheduled: queued > 0,
            detail: `${queued} Meta partition(s) queued`,
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
