import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { getMetaAdDailySeries } from "@/lib/meta/warehouse";

export const dynamic = "force-dynamic";

const MAX_AD_IDS = 25;
const MAX_CTR_EVIDENCE_AD_IDS = 120;

/** Supplemental warehouse observations, never the native decision's admitted CTR. */
export interface MetaAdCtrObservation {
  adId: string;
  providerAccountId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  observedStartDate: string | null;
  observedEndDate: string | null;
  measuredDays: number;
  state: "observed" | "missing" | "incomplete";
  ctrPercent: number | null;
  dailyCtr: Array<{ date: string; ctrPercent: number }>;
  lastWarehouseUpdateAt: string | null;
}

export interface MetaAdSeriesPoint {
  date: string;
  impressions: number;
  linkClicks: number | null;
  /** Percent, not a fraction: link clicks over impressions × 100. */
  linkCtr: number | null;
  /**
   * The provider's all-clicks CTR, as stored.
   *
   * Distinct from `linkCtr` and not interchangeable with it. This series uses
   * provider all-clicks CTR for its own requested reporting dates; a native
   * decision can use a shorter admitted economic context window, so its
   * aggregate CTR need not equal an unrestricted 28-day series.
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
  /** Present only for `ctrEvidence=1`; separate from decision authority. */
  ctrEvidence?: MetaAdCtrObservation[];
}

interface SeriesBucket {
  impressions: number;
  linkClicks: number | null;
  linkClicksMissing: boolean;
  frequencyWeighted: number;
  frequencyWeight: number;
  frequencyMissing: boolean;
  ctrWeighted: number;
  ctrWeight: number;
  ctrMissing: boolean;
}

type SeriesBuckets = Map<string, SeriesBucket>;

function emptySeriesBucket(): SeriesBucket {
  return {
    impressions: 0,
    linkClicks: null,
    linkClicksMissing: false,
    frequencyWeighted: 0,
    frequencyWeight: 0,
    frequencyMissing: false,
    ctrWeighted: 0,
    ctrWeight: 0,
    ctrMissing: false,
  };
}

function pointsFromBuckets(byDate: SeriesBuckets): MetaAdSeriesPoint[] {
  return Array.from(byDate.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([date, bucket]) => ({
      date,
      impressions: bucket.impressions,
      linkClicks: bucket.linkClicksMissing ? null : bucket.linkClicks,
      linkCtr:
        bucket.linkClicksMissing || bucket.linkClicks == null || bucket.impressions <= 0
          ? null
          : (bucket.linkClicks / bucket.impressions) * 100,
      ctr: !bucket.ctrMissing && bucket.ctrWeight > 0
        ? bucket.ctrWeighted / bucket.ctrWeight
        : null,
      frequency:
        !bucket.frequencyMissing && bucket.frequencyWeight > 0
          ? bucket.frequencyWeighted / bucket.frequencyWeight
          : null,
    }));
}

function parseAdIds(raw: string | null, limit = MAX_AD_IDS): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).slice(0, limit);
}

function ctrObservations(input: {
  adIds: string[];
  providerAccountId: string;
  startDate: string;
  endDate: string;
  rows: Awaited<ReturnType<typeof getMetaAdDailySeries>>;
}): MetaAdCtrObservation[] {
  const byAd = new Map<string, typeof input.rows>();
  for (const row of input.rows) {
    const rows = byAd.get(row.adId) ?? [];
    rows.push(row);
    byAd.set(row.adId, rows);
  }
  return input.adIds.map((adId) => {
    const rows = byAd.get(adId) ?? [];
    const measured = rows.filter((row) =>
      Number.isFinite(row.impressions) && row.impressions > 0,
    );
    const incomplete = measured.some((row) =>
      row.ctr === null || !Number.isFinite(row.ctr) || row.ctr < 0,
    );
    const dailyCtr = measured
      .filter((row) => row.ctr !== null && Number.isFinite(row.ctr) && row.ctr >= 0)
      .map((row) => ({ date: row.date, ctrPercent: row.ctr! }));
    const impressionTotal = measured.reduce((sum, row) => sum + row.impressions, 0);
    const weightedCtr = measured.reduce(
      (sum, row) => sum + (row.ctr ?? 0) * row.impressions,
      0,
    );
    const updated = rows
      .map((row) => row.sourceUpdatedAt ?? null)
      .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
    return {
      adId,
      providerAccountId: input.providerAccountId,
      requestedStartDate: input.startDate,
      requestedEndDate: input.endDate,
      observedStartDate: measured[0]?.date ?? null,
      observedEndDate: measured.at(-1)?.date ?? null,
      measuredDays: new Set(measured.map((row) => row.date)).size,
      state: measured.length === 0 ? "missing" : incomplete ? "incomplete" : "observed",
      ctrPercent: measured.length > 0 && !incomplete && impressionTotal > 0
        ? weightedCtr / impressionTotal
        : null,
      dailyCtr,
      lastWarehouseUpdateAt: updated,
    };
  });
}

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ error: code, message }, { status });
}

function isIsoReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
  const ctrEvidenceMode = params.get("ctrEvidence") === "1";
  const adIds = parseAdIds(
    params.get("adIds"),
    ctrEvidenceMode ? MAX_CTR_EVIDENCE_AD_IDS + 1 : MAX_AD_IDS,
  );

  if (!businessId) {
    return jsonError(400, "missing_business_id", "businessId is required.");
  }
  if (!start || !end) {
    return jsonError(400, "missing_date_range", "start and end are required.");
  }
  if (adIds.length === 0) {
    return jsonError(400, "missing_ad_ids", "adIds is required.");
  }
  if (ctrEvidenceMode) {
    if (adIds.length > MAX_CTR_EVIDENCE_AD_IDS) {
      return jsonError(400, "too_many_ad_ids", "CTR evidence supports up to 120 ads.");
    }
    if (!params.get("providerAccountId")) {
      return jsonError(400, "missing_provider_account_id", "providerAccountId is required.");
    }
    if (!isIsoReportDate(start) || !isIsoReportDate(end) || start > end) {
      return jsonError(400, "invalid_date_range", "A valid reporting range is required.");
    }
    const days = (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000;
    if (!Number.isFinite(days) || days > 30) {
      return jsonError(400, "invalid_date_range", "CTR evidence supports up to 31 report days.");
    }
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const assignedAccountIds = await fetchAssignedAccountIds(businessId);
  if (ctrEvidenceMode) {
    const providerAccountId = params.get("providerAccountId")!;
    if (!assignedAccountIds.includes(providerAccountId)) {
      return jsonError(403, "provider_account_not_assigned", "The Meta account is not assigned to this business.");
    }
    const rows = await getMetaAdDailySeries({
      businessId,
      adIds,
      startDate: start,
      endDate: end,
      providerAccountIds: [providerAccountId],
      finalizedOnly: true,
    });
    return NextResponse.json(
      { adCount: rows.length ? new Set(rows.map((row) => row.adId)).size : 0,
        points: [],
        ctrEvidence: ctrObservations({ adIds, providerAccountId, startDate: start, endDate: end, rows }),
      } satisfies MetaAdSeriesResponse,
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
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
    } else if (row.impressions > 0 || row.clicks > 0) {
      bucket.linkClicksMissing = true;
    }
    if (row.ctr != null && row.impressions > 0) {
      bucket.ctrWeighted += row.ctr * row.impressions;
      bucket.ctrWeight += row.impressions;
    } else if (row.impressions > 0) {
      bucket.ctrMissing = true;
    }
    // One ad per day is the normal case and this is then that ad's own value.
    // With several ads it is the impression-weighted mean of their reported
    // frequencies — never a deduplicated cross-ad frequency, which Meta does
    // not report and this warehouse cannot derive.
    if (row.frequency != null && row.impressions > 0) {
      bucket.frequencyWeighted += row.frequency * row.impressions;
      bucket.frequencyWeight += row.impressions;
    } else if (row.impressions > 0) {
      bucket.frequencyMissing = true;
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
      } else if (row.impressions > 0 || row.clicks > 0) {
        bucket.linkClicksMissing = true;
      }
      if (row.ctr != null && row.impressions > 0) {
        bucket.ctrWeighted += row.ctr * row.impressions;
        bucket.ctrWeight += row.impressions;
      } else if (row.impressions > 0) {
        bucket.ctrMissing = true;
      }
      if (row.frequency != null && row.impressions > 0) {
        bucket.frequencyWeighted += row.frequency * row.impressions;
        bucket.frequencyWeight += row.impressions;
      } else if (row.impressions > 0) {
        bucket.frequencyMissing = true;
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
