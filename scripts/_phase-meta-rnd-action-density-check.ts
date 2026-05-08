import { resetDbClientCache, getDb } from "@/lib/db";
import { configureOperationalScriptRuntime, withOperationalStartupLogsSilenced } from "@/scripts/_operational-runtime";

const VALIDATION_BUSINESS_IDS = [
  "172d0ab8-495b-4679-a4c6-ffa404c389d3",
  "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
];

async function main() {
  configureOperationalScriptRuntime({ lane: "owner_maintenance" });
  await withOperationalStartupLogsSilenced(async () => {
    const sql = getDb();
    const [latest] = (await sql`
      SELECT MAX(snapshot_date)::text AS snapshot_date
      FROM meta_decision_snapshots_daily
      WHERE business_id = ANY(${VALIDATION_BUSINESS_IDS})
    `) as Array<{ snapshot_date: string | null }>;
    const snapshotDate = latest?.snapshot_date;
    if (!snapshotDate) throw new Error("No Meta decision snapshot rows found for validation businesses.");

    const [coverage, density, recTypes] = await Promise.all([
      sql`
        SELECT scope_type, COUNT(DISTINCT business_id || ':' || scope_id)::integer AS entities, COUNT(*)::integer AS rows
        FROM meta_decision_snapshots_daily
        WHERE business_id = ANY(${VALIDATION_BUSINESS_IDS})
          AND snapshot_date = ${snapshotDate}::date
          AND scope_type IN ('campaign', 'adset')
        GROUP BY scope_type
        ORDER BY scope_type
      `,
      sql`
        SELECT
          COUNT(*)::integer AS persisted_rows,
          COUNT(*) FILTER (
            WHERE kind IN ('recommendation', 'anomaly')
              AND rec_type NOT IN ('campaign_state', 'adset_state', 'entity_state')
          )::integer AS action_rows
        FROM meta_decision_snapshots_daily
        WHERE business_id = ANY(${VALIDATION_BUSINESS_IDS})
          AND snapshot_date = ${snapshotDate}::date
          AND scope_type IN ('campaign', 'adset')
      `,
      sql`
        SELECT rec_type, COUNT(*)::integer AS rows
        FROM meta_decision_snapshots_daily
        WHERE business_id = ANY(${VALIDATION_BUSINESS_IDS})
          AND snapshot_date = ${snapshotDate}::date
          AND scope_type IN ('campaign', 'adset')
          AND rec_type NOT IN ('campaign_state', 'adset_state', 'entity_state')
        GROUP BY rec_type
        ORDER BY rows DESC, rec_type
      `,
    ]);
    const densityRow = (density as Array<{ persisted_rows: number; action_rows: number }>)[0] ?? { persisted_rows: 0, action_rows: 0 };
    const actionDensity = densityRow.persisted_rows > 0 ? densityRow.action_rows / densityRow.persisted_rows : 0;
    console.log(JSON.stringify({
      snapshotDate,
      validationBusinessIds: VALIDATION_BUSINESS_IDS,
      coverage,
      persistedRows: densityRow.persisted_rows,
      actionRows: densityRow.action_rows,
      actionDensityPct: Math.round(actionDensity * 1000) / 10,
      recTypes,
    }, null, 2));
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    resetDbClientCache();
  });
