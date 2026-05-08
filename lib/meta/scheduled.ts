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
  const [coverage] = (await sql`
    SELECT COUNT(DISTINCT business_id)::integer AS business_count
    FROM meta_decision_snapshots_daily
    WHERE snapshot_date = ${snapshotDate}::date
      AND kind IN ('recommendation', 'anomaly')
  `) as Array<{ business_count?: number | string | null }>;
  const activeBusinesses = await getActiveBusinesses();
  const activeBusinessCount = activeBusinesses.length;
  if (activeBusinessCount === 0) return true;
  return Number(coverage?.business_count ?? 0) >= activeBusinessCount;
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
