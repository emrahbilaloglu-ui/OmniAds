import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { ASSIGNMENT_SNAPSHOT_FRESHNESS_MS } from "@/lib/provider-assignment-authorization";
import {
  ASSIGNMENT_REQUIRED_TABLES,
  handleProviderAssignmentRequest,
} from "@/lib/provider-assignment-service";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import { describeSyncSafetyRefusal } from "@/lib/sync/safety-refusal";
import { enqueueGoogleAdsScheduledWork } from "@/lib/sync/google-ads-sync";

/**
 * POST /businesses/:businessId/google/assign-accounts
 *
 * Every guard lives in `handleProviderAssignmentRequest`, which both providers
 * share. This file supplies only the Google-specific scheduling step and its
 * durability proof.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ businessId: string }> },
) {
  const { businessId } = await params;
  logRuntimeDebug("google-assign-accounts", "request", { businessId });

  return handleProviderAssignmentRequest(
    {
      provider: "google",
      label: "google-assign-accounts",
      requiredTables: ASSIGNMENT_REQUIRED_TABLES.google,
      snapshotFreshnessMs: ASSIGNMENT_SNAPSHOT_FRESHNESS_MS,
      schedule: async ({ businessId: id, accountIds }) => {
        if (accountIds.length === 0) {
          return {
            scheduled: true,
            detail: "no accounts selected; nothing to schedule",
            refusal: null,
          };
        }
        try {
          await enqueueGoogleAdsScheduledWork(id);
        } catch (error) {
          return {
            scheduled: false,
            detail: error instanceof Error ? error.message : String(error),
            refusal: describeSyncSafetyRefusal(error),
          };
        }
        try {
          const sql = getDb();
          const rows = (await sql`
            SELECT COUNT(*)::int AS queued
            FROM google_ads_sync_partitions
            WHERE business_id = ${id}
              AND status IN ('queued', 'leased', 'running')
          `) as Array<{ queued: number }>;
          const queued = Number(rows[0]?.queued ?? 0);
          return {
            scheduled: queued > 0,
            detail: `${queued} Google partition(s) queued`,
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
