import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { getMetaAdDailySeries } from "@/lib/meta/warehouse";

export const dynamic = "force-dynamic";

const MAX_AD_IDS = 25;

export interface MetaAdSeriesPoint {
  date: string;
  impressions: number;
  linkClicks: number | null;
  /** Percent, not a fraction: link clicks over impressions × 100. */
  linkCtr: number | null;
  /**
   * The provider's all-clicks CTR, as stored.
   *
   * Distinct from `linkCtr` and not interchangeable with it: `link_clicks` is
   * currently 0 on every warehouse row, so a surface captioned plainly "CTR"
   * that read `linkCtr` drew a flat zero line for every creative. This is the
   * same definition the engine's own `ctr_28d` uses, so a card showing the
   * engine's number and a card showing this trail agree.
   */
  ctr: number | null;
  frequency: number | null;
}

export interface MetaAdSeriesResponse {
  /** How many of the requested ads the warehouse actually answered for. */
  adCount: number;
  points: MetaAdSeriesPoint[];
  /**
   * The same trail kept per ad, returned only for `groupBy=ad`.
   *
   * The merged `points` array answers "how did this one ad move"; the Decision
   * Center's creative queue asks a different question — one sparkline per row —
   * and merging would have drawn every row the same shape.
   */
  series?: Array<{ adId: string; points: MetaAdSeriesPoint[] }>;
}

interface SeriesBucket {
  impressions: number;
  linkClicks: number | null;
  frequencyWeighted: number;
  frequencyWeight: number;
  ctrWeighted: number;
  ctrWeight: number;
}

type SeriesBuckets = Map<string, SeriesBucket>;

function emptySeriesBucket(): SeriesBucket {
  return {
    impressions: 0,
    linkClicks: null,
    frequencyWeighted: 0,
    frequencyWeight: 0,
    ctrWeighted: 0,
    ctrWeight: 0,
  };
}

function pointsFromBuckets(byDate: SeriesBuckets): MetaAdSeriesPoint[] {
  return Array.from(byDate.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, bucket]) => ({
      date,
      impressions: bucket.impressions,
      linkClicks: bucket.linkClicks,
      linkCtr:
        bucket.linkClicks == null || bucket.impressions <= 0
          ? null
          : (bucket.linkClicks / bucket.impressions) * 100,
      ctr: bucket.ctrWeight > 0 ? bucket.ctrWeighted / bucket.ctrWeight : null,
      frequency:
        bucket.frequencyWeight > 0
          ? bucket.frequencyWeighted / bucket.frequencyWeight
          : null,
    }));
}

function parseAdIds(raw: string | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).slice(0, MAX_AD_IDS);
}

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: code, message }, { status });
}

/**
 * The per-ad daily trail behind the evidence window's CTR and Frequency
 * sparklines. `meta_ad_daily` already stores date + ad_id + link_clicks +
 * frequency and is indexed on (ad_id, date DESC); until this route existed
 * nothing read it as a series, which is why those two cards were empty.
 *
 * Authorization is the same `requireBusinessAccess` gate the sibling read
 * routes use, and the warehouse read intersects the named ads with the
 * business's own rows and its assigned Meta accounts — naming a foreign ad id
 * returns nothing rather than widening scope.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId");
  const start = params.get("start");
  const end = params.get("end");
  const adIds = parseAdIds(params.get("adIds"));

  if (!businessId) {
    return jsonError(400, "missing_business_id", "businessId is required.");
  }
  if (!start || !end) {
    return jsonError(400, "missing_date_range", "start and end are required.");
  }
  if (adIds.length === 0) {
    return jsonError(400, "missing_ad_ids", "adIds is required.");
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const assignedAccountIds = await fetchAssignedAccountIds(businessId);
  if (assignedAccountIds.length === 0) {
    return NextResponse.json({ adCount: 0, points: [] } satisfies MetaAdSeriesResponse, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }

  const rows = await getMetaAdDailySeries({
    businessId,
    adIds,
    startDate: start,
    endDate: end,
    providerAccountIds: assignedAccountIds,
  });

  const byDate: SeriesBuckets = new Map();
  const answeredAdIds = new Set<string>();
  for (const row of rows) {
    answeredAdIds.add(row.adId);
    const bucket = byDate.get(row.date) ?? emptySeriesBucket();
    bucket.impressions += row.impressions;
    if (row.linkClicks != null) {
      bucket.linkClicks = (bucket.linkClicks ?? 0) + row.linkClicks;
    }
    if (row.ctr != null && row.impressions > 0) {
      bucket.ctrWeighted += row.ctr * row.impressions;
      bucket.ctrWeight += row.impressions;
    }
    // One ad per day is the normal case and this is then that ad's own value.
    // With several ads it is the impression-weighted mean of their reported
    // frequencies — never a deduplicated cross-ad frequency, which Meta does
    // not report and this warehouse cannot derive.
    if (row.frequency != null && row.impressions > 0) {
      bucket.frequencyWeighted += row.frequency * row.impressions;
      bucket.frequencyWeight += row.impressions;
    }
    byDate.set(row.date, bucket);
  }

  const points = pointsFromBuckets(byDate);

  let series: MetaAdSeriesResponse["series"];
  if (params.get("groupBy") === "ad") {
    const perAd = new Map<string, SeriesBuckets>();
    for (const row of rows) {
      const bucketsForAd: SeriesBuckets = perAd.get(row.adId) ?? new Map();
      const bucket = bucketsForAd.get(row.date) ?? emptySeriesBucket();
      bucket.impressions += row.impressions;
      if (row.linkClicks != null) {
        bucket.linkClicks = (bucket.linkClicks ?? 0) + row.linkClicks;
      }
      if (row.ctr != null && row.impressions > 0) {
        bucket.ctrWeighted += row.ctr * row.impressions;
        bucket.ctrWeight += row.impressions;
      }
      if (row.frequency != null && row.impressions > 0) {
        bucket.frequencyWeighted += row.frequency * row.impressions;
        bucket.frequencyWeight += row.impressions;
      }
      bucketsForAd.set(row.date, bucket);
      perAd.set(row.adId, bucketsForAd);
    }
    series = Array.from(perAd.entries())
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([adId, buckets]) => ({ adId, points: pointsFromBuckets(buckets) }));
  }

  return NextResponse.json(
    {
      adCount: answeredAdIds.size,
      points,
      ...(series ? { series } : {}),
    } satisfies MetaAdSeriesResponse,
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
