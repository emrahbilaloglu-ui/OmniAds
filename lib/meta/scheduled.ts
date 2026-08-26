import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { META_RECOMMENDATION_ENGINE_VERSION } from "@/lib/meta/recommendations";
import { runMetaSnapshotForAllBusinesses } from "@/lib/meta/snapshot";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";

export interface MetaSnapshotJobDueResult {
  skipped: boolean;
  reason?: "outside_slot" | "schema_not_ready" | "already_ran";
  snapshotDate: string;
  result?: Awaited<ReturnType<typeof runMetaSnapshotForAllBusinesses>>;
}

function snapshotDateFor(now: Date) {
  return now.toISOString().slice(0, 10);
}

function isDailyMetaSnapshotSlot(now: Date) {
  return now.getUTCHours() === 3;
}

/**
 * Has today's run already covered every business, in every assigned account?
 *
 * The account half is not a refinement — it is what stops a partial run from
 * looking complete. Generation is per assigned account now, so if account A
 * writes campaign and ad-set rows and account B then fails, a business-wide
 * `bool_or` reports the whole business covered and this guard skips the job for
 * the rest of the day. Account B silently gets no snapshot, daily, and the
 * result object says `already_ran`.
 *
 * Coverage is therefore counted per (business, account), and a business is
 * covered only when EVERY currently assigned account is. A business with no
 * assignment is covered by its single unattributed batch, which is what the
 * generator writes for it.
 */
async function alreadyRan(snapshotDate: string) {
  const sql = getDb();
  const coverage = (await sql`
    SELECT
      business_id,
      provider_account_id,
      bool_or(scope_type = 'campaign') AS has_campaign_rows,
      bool_or(scope_type = 'adset') AS has_adset_rows
    FROM meta_decision_snapshots_daily
    WHERE snapshot_date = ${snapshotDate}::date
      AND kind IN ('recommendation', 'anomaly')
      AND engine_version = ${META_RECOMMENDATION_ENGINE_VERSION}
    GROUP BY business_id, provider_account_id
  `) as Array<{
    business_id?: string | null;
    provider_account_id?: string | null;
    has_campaign_rows?: boolean | null;
    has_adset_rows?: boolean | null;
  }>;
  const activeBusinesses = await getActiveBusinesses();
  if (activeBusinesses.length === 0) return true;

  const coveredKeys = new Set(
    coverage
      .filter((row) => row.business_id && row.has_campaign_rows && row.has_adset_rows)
      .map((row) => `${row.business_id}|${row.provider_account_id ?? ""}`),
  );

  for (const business of activeBusinesses) {
    const assignment = await getProviderAccountAssignments(business.id, "meta").catch(
      () => null,
    );
    const accounts = assignment?.account_ids ?? [];
    // No assignment: one unattributed batch is the whole of this business.
    const required = accounts.length > 0 ? accounts : [""];
    for (const account of required) {
      if (!coveredKeys.has(`${business.id}|${account}`)) return false;
    }
  }
  return true;
}

export async function runMetaSnapshotJobIfDue(
  now = new Date(),
): Promise<MetaSnapshotJobDueResult> {
  const snapshotDate = snapshotDateFor(now);
  if (!isDailyMetaSnapshotSlot(now)) {
    return { skipped: true, reason: "outside_slot", snapshotDate };
  }

  const readiness = await getDbSchemaReadiness({
    tables: [
      "meta_decision_snapshots_daily",
      "meta_decision_calibration_daily",
    ],
  }).catch(() => null);
  if (!readiness?.ready) {
    return { skipped: true, reason: "schema_not_ready", snapshotDate };
  }

  if (await alreadyRan(snapshotDate)) {
    return { skipped: true, reason: "already_ran", snapshotDate };
  }

  const result = await runMetaSnapshotForAllBusinesses(snapshotDate);
  return { skipped: false, snapshotDate, result };
}
