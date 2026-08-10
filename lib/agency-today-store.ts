import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";

/**
 * Cross-client spend and revenue for the Agency Today surface.
 *
 * This deliberately reads every requested client in one grouped query. The
 * alternative — one request per client — is the fan-out pattern that already
 * made reports and the decisions workspace slow and fragile, and it gets worse
 * with each client an agency adds.
 */

export interface AgencyTodayClientTotals {
  businessId: string;
  spend: number | null;
  revenue: number | null;
  purchases: number | null;
  lastSourceUpdatedAt: string | null;
}

interface TotalsRow {
  business_id: string;
  spend: string | number | null;
  revenue: string | number | null;
  purchases: string | number | null;
  last_source_updated_at: string | null;
}

function toNumber(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read per-business totals for a window.
 *
 * Returns an empty map rather than throwing when the summary tables are not
 * present, so a workspace that has never synced renders as "no data yet"
 * instead of an error — but a genuine query failure still propagates, because
 * a failed read must not be presented as an empty account.
 */
export async function readAgencyTodayTotals(input: {
  businessIds: string[];
  startDate: string;
  endDate: string;
}): Promise<Map<string, AgencyTodayClientTotals>> {
  const results = new Map<string, AgencyTodayClientTotals>();
  if (input.businessIds.length === 0) return results;

  const readiness = await getDbSchemaReadiness({
    tables: ["platform_overview_daily_summary"],
  }).catch(() => null);
  if (!readiness?.ready) return results;

  const rows = (await getDb().query<TotalsRow>(
    `
      SELECT
        business_id,
        SUM(spend)     AS spend,
        SUM(revenue)   AS revenue,
        SUM(purchases) AS purchases,
        MAX(source_updated_at)::text AS last_source_updated_at
      FROM platform_overview_daily_summary
      WHERE business_id = ANY($1::text[])
        AND date BETWEEN $2::date AND $3::date
      GROUP BY business_id
    `,
    [input.businessIds, input.startDate, input.endDate],
  )) as TotalsRow[];

  for (const row of rows) {
    results.set(row.business_id, {
      businessId: row.business_id,
      spend: toNumber(row.spend),
      revenue: toNumber(row.revenue),
      purchases: toNumber(row.purchases),
      lastSourceUpdatedAt: row.last_source_updated_at,
    });
  }

  return results;
}

/**
 * Freshness for a client, from when its source data was last updated.
 *
 * An absent timestamp is "unknown", never "fresh": claiming freshness we cannot
 * evidence is how a buyer ends up trusting a stalled sync.
 */
export function resolveClientFreshness(
  lastSourceUpdatedAt: string | null | undefined,
  now: Date,
  staleAfterHours = 26,
): "fresh" | "stale" | "unknown" {
  if (!lastSourceUpdatedAt) return "unknown";
  const updated = new Date(lastSourceUpdatedAt);
  if (Number.isNaN(updated.getTime())) return "unknown";
  const ageHours = (now.getTime() - updated.getTime()) / 3_600_000;
  if (!Number.isFinite(ageHours)) return "unknown";
  return ageHours <= staleAfterHours ? "fresh" : "stale";
}
