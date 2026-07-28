import { getDb } from "@/lib/db";
import { GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS } from "@/lib/google-ads/advisor-readiness";
import { readGoogleAdsSearchIntelligenceCoverage } from "@/lib/google-ads/search-intelligence-storage";
import { getGoogleAdsDailyCoverage, getGoogleAdsCoveredDates } from "@/lib/google-ads/warehouse";
import {
  readGoogleAdsFreshness,
  toGoogleAdsFreshnessSummary,
} from "@/lib/google-ads/freshness-read";
import {
  configureOperationalScriptRuntime,
  runOperationalMigrationsIfEnabled,
} from "./_operational-runtime";

const REQUIRED_SCOPES = ["campaign_daily", "search_term_daily", "product_daily"] as const;

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function toDate(value: unknown) {
  return value ? String(value).slice(0, 10) : null;
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function main() {
  const runtime = configureOperationalScriptRuntime();
  const businessId = process.argv[2];
  const endDate = process.argv[3] ?? addDays(new Date().toISOString().slice(0, 10), -1);
  const startDate = process.argv[4] ?? addDays(endDate, -(GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS - 1));

  if (!businessId) {
    console.error(
      "usage: node --import tsx scripts/google-ads-advisor-blocker-diagnostic.ts <businessId> [endDate] [startDate]"
    );
    process.exit(1);
  }

  await runOperationalMigrationsIfEnabled(runtime);
  const sql = getDb();

  const coverage = await Promise.all(
    REQUIRED_SCOPES.map(async (scope) => {
      if (scope === "search_term_daily") {
        const result = await readGoogleAdsSearchIntelligenceCoverage({
          businessId,
          startDate,
          endDate,
        });
        return {
          scope,
          completedDays: result.completedDays,
          readyThroughDate: result.readyThroughDate,
          source: "search_intelligence",
        };
      }

      const result = await getGoogleAdsDailyCoverage({
        businessId,
        providerAccountId: null,
        scope,
        startDate,
        endDate,
        includeMetadata: true,
      });
      return {
        scope,
        completedDays: toNumber(result.completed_days),
        readyThroughDate: toDate(result.ready_through_date),
        latestUpdatedAt: result.latest_updated_at ?? null,
        totalRows: toNumber(result.total_rows),
        source: "warehouse_or_succeeded_partition",
      };
    })
  );

  // Data availability: which campaign days have no rows at all, so their
  // partitions can be inspected below. Row existence answers this honestly.
  const coveredCampaignDates = new Set(
    await getGoogleAdsCoveredDates({
      businessId,
      providerAccountId: null,
      scope: "campaign_daily",
      startDate,
      endDate,
    })
  );
  // Freshness evidence, in one bulk read. Without it this diagnostic answers
  // "why is the advisor blocked?" with coverage numbers alone, so a window
  // whose days were each fetched once at 01:40 and never re-read reads as
  // perfectly healthy — exactly the blindness the operator is here to escape.
  const freshness = await readGoogleAdsFreshness({
    businessId,
    scopes: ["campaign_daily", "search_term_daily", "product_daily"],
    startDate,
    endDate,
  })
    .then(toGoogleAdsFreshnessSummary)
    .catch(() => null);
  const missingCampaignDates = (await sql.query(
    `
      WITH days AS (
        SELECT generate_series($1::date, $2::date, interval '1 day')::date AS date
      )
      SELECT date::text
      FROM days
      ORDER BY date ASC
    `,
    [startDate, endDate]
  ) as Array<Record<string, unknown>>)
    .map((row) => String(row.date).slice(0, 10))
    .filter((date) => !coveredCampaignDates.has(date));

  const campaignPartitionRows = (await sql.query(
    `
      SELECT
        lane,
        source,
        status,
        COUNT(*)::int AS count,
        MIN(partition_date)::text AS first_date,
        MAX(partition_date)::text AS last_date,
        MAX(updated_at) AS latest_activity_at
      FROM google_ads_sync_partitions
      WHERE business_id = $1
        AND scope = 'campaign_daily'
        AND partition_date >= $2::date
        AND partition_date <= $3::date
      GROUP BY lane, source, status
      ORDER BY lane, source, status
    `,
    [businessId, startDate, endDate]
  )) as Array<Record<string, unknown>>;

  const missingCampaignPartitionRows =
    missingCampaignDates.length === 0
      ? []
      : ((await sql.query(
          `
            SELECT
              partition_date::text AS date,
              lane,
              source,
              status,
              priority,
              attempt_count,
              retry_after_at,
              updated_at,
              last_error
            FROM google_ads_sync_partitions
            WHERE business_id = $1
              AND scope = 'campaign_daily'
              AND partition_date = ANY($2::date[])
            ORDER BY partition_date ASC, priority ASC, updated_at DESC
          `,
          [businessId, missingCampaignDates]
        )) as Array<Record<string, unknown>>);

  const latestSuccessfulCampaignRows = (await sql.query(
    `
      SELECT
        partition_date::text AS date,
        lane,
        source,
        updated_at
      FROM google_ads_sync_partitions
      WHERE business_id = $1
        AND scope = 'campaign_daily'
        AND status = 'succeeded'
      ORDER BY updated_at DESC
      LIMIT 12
    `,
    [businessId]
  )) as Array<Record<string, unknown>>;

  const totalDays =
    Math.floor(
      (new Date(`${endDate}T00:00:00Z`).getTime() -
        new Date(`${startDate}T00:00:00Z`).getTime()) /
        86_400_000
    ) + 1;

  console.log(
    JSON.stringify(
      {
        businessId,
        capturedAt: new Date().toISOString(),
        window: {
          startDate,
          endDate,
          totalDays,
        },
        coverage,
        missingSurfaces: coverage
          .filter((entry) => entry.completedDays < totalDays)
          .map((entry) => entry.scope),
        freshness,
        /** Could we read the evidence at all? `false` invalidates the claims below. */
        freshnessVerified: freshness?.evidenceAvailable ?? false,
        /**
         * Surfaces with rows for every day that were nevertheless never
         * re-read after a day closed. `missingSurfaces` cannot see these.
         */
        staleSurfaces: (freshness?.evidenceAvailable ? freshness.scopes : [])
          .filter((scope) => scope.postCloseObservedDays < (freshness?.totalDays ?? 0))
          .map((scope) => ({
            scope: scope.scope,
            state: scope.state,
            coveredDays: scope.coveredDays,
            postCloseObservedDays: scope.postCloseObservedDays,
            unreobservedDays:
              (freshness?.totalDays ?? 0) - scope.postCloseObservedDays,
            dueNowDays: scope.dueNowDays,
            latestObservationAt: scope.latestObservationAt,
          })),
        campaignDaily: {
          missingDates: missingCampaignDates,
          partitionSummary: campaignPartitionRows,
          missingDatePartitions: missingCampaignPartitionRows,
          latestSuccessfulPartitions: latestSuccessfulCampaignRows,
        },
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
