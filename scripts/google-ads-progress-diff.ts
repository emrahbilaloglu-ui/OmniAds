import { loadEnvConfig } from "@next/env";
import { getDb } from "@/lib/db";
import {
  readGoogleAdsFreshness,
  toGoogleAdsFreshnessSummary,
} from "@/lib/google-ads/freshness-read";
import { addDaysToIsoDateUtc } from "@/lib/provider-platform-date";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import { configureOperationalScriptRuntime } from "./_operational-runtime";

loadEnvConfig(process.cwd());

/**
 * The scopes and window this diff reports freshness for.
 *
 * `completed_days` and the partition counters below are a legitimate progress
 * question — "did the worker move since T" — and they are unchanged. But a
 * `completed_days` that advanced tells you a date acquired its FIRST row, not
 * that any date was re-read after closing, so a run can look like steady
 * progress while the whole window stays provisional. The freshness verdict is
 * added so both movements are visible in one output.
 */
const PROGRESS_DIFF_SCOPES: GoogleAdsWarehouseScope[] = [
  "campaign_daily",
  "search_term_daily",
  "product_daily",
];
const PROGRESS_DIFF_WINDOW_DAYS = 14;

async function main() {
  configureOperationalScriptRuntime({
    lane: "read_only_observation",
  });
  const businessId = process.argv[2];
  const sinceIso = process.argv[3];
  if (!businessId || !sinceIso) {
    console.error(
      "usage: node --import tsx scripts/google-ads-progress-diff.ts <businessId> <sinceIsoTimestamp>"
    );
    process.exit(1);
  }

  const sql = getDb();
  const rows = await sql`
    SELECT
      scope,
      completed_days,
      dead_letter_count,
      latest_background_activity_at,
      updated_at
    FROM google_ads_sync_state
    WHERE business_id = ${businessId}
      AND scope IN ('campaign_daily', 'search_term_daily', 'product_daily')
    ORDER BY scope
  ` as Array<Record<string, unknown>>;

  const partitionRows = await sql`
    SELECT
      scope,
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_count,
      COUNT(*) FILTER (WHERE status IN ('leased', 'running'))::int AS active_count,
      COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter_count,
      MAX(updated_at) AS latest_activity_at
    FROM google_ads_sync_partitions
    WHERE business_id = ${businessId}
      AND scope IN ('campaign_daily', 'search_term_daily', 'product_daily')
    GROUP BY scope
    ORDER BY scope
  ` as Array<Record<string, unknown>>;

  const recentRuns = await sql`
    SELECT
      scope,
      status,
      COUNT(*)::int AS count
    FROM google_ads_sync_runs
    WHERE business_id = ${businessId}
      AND updated_at >= ${sinceIso}
      AND scope IN ('campaign_daily', 'search_term_daily', 'product_daily')
    GROUP BY scope, status
    ORDER BY scope, status
  ` as Array<Record<string, unknown>>;

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = addDaysToIsoDateUtc(endDate, -(PROGRESS_DIFF_WINDOW_DAYS - 1));
  // ONE bulk read for every scope in the window.
  const freshness = toGoogleAdsFreshnessSummary(
    await readGoogleAdsFreshness({
      businessId,
      scopes: PROGRESS_DIFF_SCOPES,
      startDate,
      endDate,
    }),
  );

  console.log(
    JSON.stringify(
      {
        businessId,
        sinceIso,
        capturedAt: new Date().toISOString(),
        states: rows,
        partitions: partitionRows,
        runsSince: recentRuns,
        freshness,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
