import { getDb } from "@/lib/db";
import { buildGoogleAdsAdvisorProgress } from "@/lib/google-ads/advisor-progress";
import {
  readGoogleAdsFreshness,
  toGoogleAdsFreshnessSummary,
} from "@/lib/google-ads/freshness-read";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import {
  configureOperationalScriptRuntime,
  runOperationalMigrationsIfEnabled,
} from "./_operational-runtime";

/**
 * The scopes this snapshot reports coverage for. `advisorReady` used to be
 * `completed_days >= 90` over `COUNT(DISTINCT date)` — pure row existence — so
 * an operator triaging an incident read "advisor ready" over ninety days that
 * may never have been re-read after they closed. The coverage counts stay
 * (they answer the legitimate "is there data at all?"), but readiness now comes
 * from the shared freshness verdict.
 */
const HEALTH_SNAPSHOT_SCOPES: GoogleAdsWarehouseScope[] = [
  "campaign_daily",
  "search_term_daily",
  "product_daily",
];

async function main() {
  const runtime = configureOperationalScriptRuntime();
  const businessId = process.argv[2];
  if (!businessId) {
    console.error("usage: node --import tsx scripts/google-ads-health-snapshot.ts <businessId>");
    process.exit(1);
  }

  await runOperationalMigrationsIfEnabled(runtime);
  const sql = getDb();

  const [partitions, states, recent90Rows, recent90PartitionRows] = (await Promise.all([
    sql`
      SELECT
        lane,
        scope,
        status,
        COUNT(*)::int AS count,
        MIN(partition_date) AS oldest_partition_date,
        MAX(updated_at) AS latest_activity_at
      FROM google_ads_sync_partitions
      WHERE business_id = ${businessId}
      GROUP BY lane, scope, status
      ORDER BY lane, scope, status
    `,
    sql`
      SELECT
        scope,
        provider_account_id,
        ready_through_date,
        completed_days,
        dead_letter_count,
        latest_background_activity_at,
        latest_successful_sync_at
      FROM google_ads_sync_state
      WHERE business_id = ${businessId}
      ORDER BY scope, provider_account_id
    `,
    sql`
      WITH recent_window AS (
        SELECT
          COALESCE(MAX(date)::date, CURRENT_DATE - interval '1 day') AS recent_end
        FROM google_ads_campaign_daily
        WHERE business_id = ${businessId}
      ),
      scoped_dates AS (
        SELECT
          'campaign_daily'::text AS scope,
          COUNT(DISTINCT date)::int AS completed_days,
          MAX(date)::date AS ready_through_date
        FROM google_ads_campaign_daily, recent_window
        WHERE business_id = ${businessId}
          AND date >= recent_window.recent_end - interval '89 days'
          AND date <= recent_window.recent_end
        UNION ALL
        SELECT
          'search_term_daily'::text AS scope,
          COUNT(DISTINCT date)::int AS completed_days,
          MAX(date)::date AS ready_through_date
        FROM google_ads_search_term_daily, recent_window
        WHERE business_id = ${businessId}
          AND date >= recent_window.recent_end - interval '89 days'
          AND date <= recent_window.recent_end
        UNION ALL
        SELECT
          'product_daily'::text AS scope,
          COUNT(DISTINCT date)::int AS completed_days,
          MAX(date)::date AS ready_through_date
        FROM google_ads_product_daily, recent_window
        WHERE business_id = ${businessId}
          AND date >= recent_window.recent_end - interval '89 days'
          AND date <= recent_window.recent_end
      )
      SELECT
        scoped_dates.scope,
        scoped_dates.completed_days,
        scoped_dates.ready_through_date,
        recent_window.recent_end::text AS recent_end,
        (recent_window.recent_end - interval '89 days')::date::text AS recent_start
      FROM scoped_dates
      CROSS JOIN recent_window
      ORDER BY scoped_dates.scope
    `,
    sql`
      WITH recent_window AS (
        SELECT
          COALESCE(MAX(date)::date, CURRENT_DATE - interval '1 day') AS recent_end
        FROM google_ads_campaign_daily
        WHERE business_id = ${businessId}
      )
      SELECT
        scope,
        COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter_count,
        COUNT(*) FILTER (WHERE status IN ('queued', 'leased', 'running'))::int AS active_count,
        MAX(updated_at) AS latest_activity_at
      FROM google_ads_sync_partitions, recent_window
      WHERE business_id = ${businessId}
        AND scope IN ('campaign_daily', 'search_term_daily', 'product_daily')
        AND partition_date >= recent_window.recent_end - interval '89 days'
        AND partition_date <= recent_window.recent_end
      GROUP BY scope
      ORDER BY scope
    `,
  ])) as [
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>,
  ];

  const recentStart = recent90Rows[0]?.recent_start
    ? String(recent90Rows[0].recent_start).slice(0, 10)
    : null;
  const recentEnd = recent90Rows[0]?.recent_end
    ? String(recent90Rows[0].recent_end).slice(0, 10)
    : null;

  // ONE bulk read for the whole 90-day window across every scope, not one per
  // scope and not one per date.
  const freshnessSnapshot =
    recentStart && recentEnd
      ? await readGoogleAdsFreshness({
          businessId,
          scopes: HEALTH_SNAPSHOT_SCOPES,
          startDate: recentStart,
          endDate: recentEnd,
        })
      : null;
  const freshness = freshnessSnapshot ? toGoogleAdsFreshnessSummary(freshnessSnapshot) : null;

  const recent90Progress = buildGoogleAdsAdvisorProgress({
    connected: true,
    assignedAccountCount: 1,
    coreUsable: true,
    // Fail closed: no window, no evidence, or a non-settled verdict all mean
    // "not ready". Row existence can no longer promote this to true.
    advisorReady: freshness?.complete === true,
    coverages: recent90Rows.map((row) => ({
      completedDays: Number(row.completed_days ?? 0),
    })),
  });

  console.log(
    JSON.stringify(
      {
        businessId,
        capturedAt: new Date().toISOString(),
        recent90: {
          startDate: recentStart,
          endDate: recentEnd,
          // Data availability only: how many days have at least one row.
          coverage: recent90Rows,
          partitionHealth: recent90PartitionRows,
          // The completion/freshness claim, from the shared decision.
          freshness:
            freshness ??
            {
              evidenceAvailable: false,
              unavailableReason:
                "No Google Ads window could be derived for this business.",
              state: "unknown",
              label: "Unknown",
              percent: 0,
              complete: false,
              mayStopPolling: false,
              detail: "No Google Ads window could be derived for this business.",
            },
          expectedAdvisorProgress: recent90Progress,
        },
        partitions,
        states,
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
