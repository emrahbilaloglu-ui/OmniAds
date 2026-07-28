import { getDb } from "@/lib/db";
import {
  readGoogleAdsFreshness,
  toGoogleAdsFreshnessSummary,
} from "@/lib/google-ads/freshness-read";
import { addDaysToIsoDateUtc } from "@/lib/provider-platform-date";
import type { GoogleAdsWarehouseScope } from "@/lib/google-ads/warehouse-types";
import {
  configureOperationalScriptRuntime,
  runOperationalMigrationsIfEnabled,
} from "./_operational-runtime";

const SCOPES = [
  "account_daily",
  "campaign_daily",
  "search_term_daily",
  "product_daily",
  "asset_group_daily",
  "asset_daily",
  "geo_daily",
  "device_daily",
  "audience_daily",
] as const satisfies readonly GoogleAdsWarehouseScope[];

/**
 * The window this script judges freshness over.
 *
 * `completed_days` and `ready_through_date` below are echoed verbatim from
 * `google_ads_sync_state` — that is the point of a consistency check, and those
 * columns answer the legitimate "what does state claim?". What they cannot
 * answer is whether the days they count were ever re-read after they closed, so
 * a state row can look perfectly consistent with its partitions and still be
 * describing numbers captured while the day was open. The freshness block is
 * added alongside so the drift an operator is hunting is visible in the same
 * output.
 */
const STATE_CONSISTENCY_WINDOW_DAYS = 14;

async function main() {
  const runtime = configureOperationalScriptRuntime();
  const businessId = process.argv[2];
  if (!businessId) {
    console.error("usage: node --import tsx scripts/google-ads-state-consistency.ts <businessId>");
    process.exit(1);
  }

  await runOperationalMigrationsIfEnabled(runtime);
  const sql = getDb();

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = addDaysToIsoDateUtc(endDate, -(STATE_CONSISTENCY_WINDOW_DAYS - 1));
  // ONE bulk read covering every scope, rather than one read per scope inside
  // the loop below.
  const freshnessSnapshot = await readGoogleAdsFreshness({
    businessId,
    scopes: SCOPES,
    startDate,
    endDate,
  });
  const freshness = toGoogleAdsFreshnessSummary(freshnessSnapshot);
  const freshnessByScope = new Map(freshness.scopes.map((scope) => [scope.scope, scope]));

  const results = await Promise.all(
    SCOPES.map(async (scope) => {
      const [stateRows, partitionRows] = (await Promise.all([
        sql`
          SELECT
            provider_account_id,
            completed_days,
            ready_through_date,
            latest_background_activity_at
          FROM google_ads_sync_state
          WHERE business_id = ${businessId}
            AND scope = ${scope}
          ORDER BY provider_account_id
        `,
        sql`
          SELECT
            provider_account_id,
            COUNT(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter_count,
            COUNT(*) FILTER (WHERE status IN ('queued', 'leased', 'running'))::int AS active_partition_count,
            MAX(updated_at) AS latest_partition_activity_at
          FROM google_ads_sync_partitions
          WHERE business_id = ${businessId}
            AND scope = ${scope}
          GROUP BY provider_account_id
          ORDER BY provider_account_id
        `,
      ])) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>];

      const partitionsByAccount = new Map(
        partitionRows.map((row) => [String(row.provider_account_id), row])
      );

      return {
        scope,
        // Per-scope freshness verdict for the same window, so "state says 14
        // completed days" can be read next to "0 of those days have been
        // re-read since they closed".
        freshness: freshnessByScope.get(scope) ?? {
          scope,
          state: "unknown" as const,
          label: "Unknown",
          percent: 0,
          complete: false,
          mayStopPolling: false,
          detail: freshness.unavailableReason ?? "No freshness evidence for this scope.",
          coveredDays: 0,
          postCloseObservedDays: 0,
          lookbackExhaustedDays: 0,
          dueNowDays: 0,
          oldestObservationAt: null,
          latestObservationAt: null,
        },
        accounts: stateRows.map((stateRow) => {
          const accountId = String(stateRow.provider_account_id);
          const partitionRow = partitionsByAccount.get(accountId);
          return {
            providerAccountId: accountId,
            completedDays: Number(stateRow.completed_days ?? 0),
            readyThroughDate: stateRow.ready_through_date ? String(stateRow.ready_through_date).slice(0, 10) : null,
            latestBackgroundActivityAt: stateRow.latest_background_activity_at
              ? String(stateRow.latest_background_activity_at)
              : null,
            activePartitionCount: Number(partitionRow?.active_partition_count ?? 0),
            deadLetterCount: Number(partitionRow?.dead_letter_count ?? 0),
            latestPartitionActivityAt: partitionRow?.latest_partition_activity_at
              ? String(partitionRow.latest_partition_activity_at)
              : null,
          };
        }),
      };
    })
  );

  console.log(
    JSON.stringify(
      {
        businessId,
        capturedAt: new Date().toISOString(),
        freshnessWindow: { startDate, endDate, totalDays: freshness.totalDays },
        freshness: {
          evidenceAvailable: freshness.evidenceAvailable,
          unavailableReason: freshness.unavailableReason,
          state: freshness.state,
          label: freshness.label,
          percent: freshness.percent,
          complete: freshness.complete,
          mayStopPolling: freshness.mayStopPolling,
          detail: freshness.detail,
          includesOpenDay: freshness.includesOpenDay,
          timeZoneSource: freshness.timeZoneSource,
          conversionLookbackDays: freshness.conversionLookbackDays,
        },
        results,
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
