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
  frequency: number | null;
}

export interface MetaAdSeriesResponse {
  /** How many of the requested ads the warehouse actually answered for. */
  adCount: number;
  points: MetaAdSeriesPoint[];
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

  const byDate = new Map<
    string,
    { impressions: number; linkClicks: number | null; frequencyWeighted: number; frequencyWeight: number }
  >();
  const answeredAdIds = new Set<string>();
  for (const row of rows) {
    answeredAdIds.add(row.adId);
    const bucket = byDate.get(row.date) ?? {
      impressions: 0,
      linkClicks: null,
      frequencyWeighted: 0,
      frequencyWeight: 0,
    };
    bucket.impressions += row.impressions;
    if (row.linkClicks != null) {
      bucket.linkClicks = (bucket.linkClicks ?? 0) + row.linkClicks;
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

  const points: MetaAdSeriesPoint[] = Array.from(byDate.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, bucket]) => ({
      date,
      impressions: bucket.impressions,
      linkClicks: bucket.linkClicks,
      linkCtr:
        bucket.linkClicks == null || bucket.impressions <= 0
          ? null
          : (bucket.linkClicks / bucket.impressions) * 100,
      frequency:
        bucket.frequencyWeight > 0
          ? bucket.frequencyWeighted / bucket.frequencyWeight
          : null,
    }));

  return NextResponse.json(
    { adCount: answeredAdIds.size, points } satisfies MetaAdSeriesResponse,
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
