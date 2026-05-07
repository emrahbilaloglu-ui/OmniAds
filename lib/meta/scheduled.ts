import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { runMetaSnapshotForAllBusinesses } from "@/lib/meta/snapshot";

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
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1
      FROM meta_decision_snapshots_daily
      WHERE snapshot_date = ${snapshotDate}::date
      UNION ALL
      SELECT 1
      FROM meta_decision_calibration_daily
      WHERE snapshot_date = ${snapshotDate}::date
      LIMIT 1
    ) AS exists
  `) as Array<{ exists?: boolean }>;
  return rows[0]?.exists === true;
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
