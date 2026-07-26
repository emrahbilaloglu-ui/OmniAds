import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { ASSIGNMENT_SNAPSHOT_FRESHNESS_MS } from "@/lib/provider-assignment-authorization";
import {
  ASSIGNMENT_REQUIRED_TABLES,
  handleProviderAssignmentRequest,
} from "@/lib/provider-assignment-service";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import { readProviderConnectionGenerationToken } from "@/lib/provider-account-snapshots";
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
      schedule: async ({ businessId: id, accountIds, connectionGeneration, scheduledAfter }) => {
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
        // Scoped to THIS operation and to the exact committed accounts.
        // Counting every queued partition for the business let unrelated
        // in-flight work report `syncScheduled: true` for accounts that had
        // nothing enqueued.
        try {
          const sql = getDb();
          const rows = (await sql`
            SELECT provider_account_id, COUNT(*)::int AS queued
            FROM google_ads_sync_partitions
            WHERE business_id = ${id}
              AND provider_account_id = ANY(${accountIds}::text[])
              AND status IN ('queued', 'leased', 'running')
              AND created_at >= ${scheduledAfter}::timestamptz
            GROUP BY provider_account_id
          `) as Array<{ provider_account_id: string; queued: number }>;
          const scheduledAccounts = new Set(rows.map((row) => row.provider_account_id));
          const missing = accountIds.filter((accountId) => !scheduledAccounts.has(accountId));
          const queued = rows.reduce((total, row) => total + Number(row.queued ?? 0), 0);

          const currentGeneration = await readProviderConnectionGenerationToken(id, "google");
          if (connectionGeneration != null && currentGeneration !== connectionGeneration) {
            return {
              scheduled: false,
              detail: `the Google connection changed while scheduling (expected ${connectionGeneration}, found ${currentGeneration ?? "none"})`,
              refusal: null,
            };
          }

          return {
            scheduled: missing.length === 0 && queued > 0,
            detail:
              missing.length === 0
                ? `${queued} Google partition(s) queued for ${accountIds.length} selected account(s)`
                : `no new Google partitions for: ${missing.join(", ")}`,
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
