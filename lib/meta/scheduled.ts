import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { runMetaSnapshotForAllBusinesses } from "@/lib/meta/snapshot";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";

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

async function alreadyRan(snapshotDate: string) {
  const sql = getDb();
  const coverage = (await sql`
    SELECT
      business_id,
      bool_or(scope_type = 'campaign') AS has_campaign_rows,
      bool_or(scope_type = 'adset') AS has_adset_rows
    FROM meta_decision_snapshots_daily
    WHERE snapshot_date = ${snapshotDate}::date
      AND kind IN ('recommendation', 'anomaly')
    GROUP BY business_id
  `) as Array<{
    business_id?: string | null;
    has_campaign_rows?: boolean | null;
    has_adset_rows?: boolean | null;
  }>;
  const activeBusinesses = await getActiveBusinesses();
  if (activeBusinesses.length === 0) return true;
  const coverageByBusiness = new Map(
    coverage
      .filter((row) => row.business_id)
      .map((row) => [row.business_id!, row]),
  );
  return activeBusinesses.every((business) => {
    const row = coverageByBusiness.get(business.id);
    return Boolean(row?.has_campaign_rows && row?.has_adset_rows);
  });
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
