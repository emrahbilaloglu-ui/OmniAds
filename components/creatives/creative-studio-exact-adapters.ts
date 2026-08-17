import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import type { CopyMotionRow } from "@/app/(dashboard)/platforms/meta/copies/page-support";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type {
  CreativeStudioAssetRow,
  CreativeStudioAssetsModel,
  CreativeStudioCopiesModel,
  CreativeStudioCopyAngle,
  CreativeStudioCopyRow,
  CreativeStudioDataState,
  CreativeStudioLandingModel,
  CreativeStudioLandingRow,
  CreativeStudioTone,
} from "@/components/creatives/creative-studio-exact-types";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function divide(numerator: number | null, denominator: number | null, scale = 1) {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return (numerator / denominator) * scale;
}

function titleCaseStatus(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function statusTone(value: string | null | undefined): CreativeStudioTone {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (["active", "enabled", "live"].includes(normalized)) return "positive";
  if (["error", "disapproved", "rejected"].includes(normalized)) return "negative";
  if (["pending", "in_process", "in review", "limited"].includes(normalized)) return "warning";
  return "neutral";
}

function previewUrl(row: MetaCreativeRow) {
  return (
    row.tableThumbnailUrl ??
    row.cardPreviewUrl ??
    row.imageUrl ??
    row.thumbnailUrl ??
    row.cachedThumbnailUrl ??
    null
  );
}

export function buildCreativeStudioAssetsModel(input: {
  rows: MetaCreativeRow[];
  state: CreativeStudioDataState;
  message?: string | null;
  onOpenRow?: (rowId: string) => void;
}): CreativeStudioAssetsModel {
  const rows: CreativeStudioAssetRow[] = input.rows.map((row) => {
    const available = row.metricsAvailability === "available";
    const metric = (value: number | null | undefined) =>
      available ? finite(value) : null;
    const purchases = metric(row.purchases);
    const linkClicks = metric(row.linkClicks);
    const addToCart = metric(row.addToCart);
    const purchaseValue = metric(row.purchaseValue);
    const status = titleCaseStatus(row.effectiveStatus);

    return {
      id: row.id,
      name: row.name?.trim() || "—",
      kind:
        [row.creativePrimaryLabel, row.creativeVisualFormat]
          .map((value) => value?.trim())
          .filter(Boolean)
          .join(" · ") || "—",
      imageUrl: previewUrl(row),
      status,
      statusTone: statusTone(row.effectiveStatus),
      marketingAngle: row.aiTags.messagingAngle?.find((value) => value.trim()) ?? null,
      currency: row.currency?.trim() || null,
      metrics: {
        spend: metric(row.spend),
        impressions: metric(row.impressions),
        clicks: metric(row.clicks),
        purchases,
        roas: metric(row.roas),
        cpa: metric(row.cpa),
        cpm: metric(row.cpm),
        aov: divide(purchaseValue, purchases),
        ctr: metric(row.ctrAll),
        thumbstop: metric(row.thumbstop),
        // The current creative payload has no Hold 15s field. Video-completion
        // rates are not a valid proxy for the canonical metric.
        hold: null,
        frequency: metric(row.frequency),
        atcRate: divide(addToCart, linkClicks, 100),
        cvr: divide(purchases, linkClicks, 100),
      },
    };
  });

  return {
    state: input.state,
    message: input.message ?? null,
    syncedCount: input.state === "loading" || input.state === "error" ? null : rows.length,
    rows,
    onOpenRow: input.onOpenRow,
  };
}

function copyHasObservedMetrics(row: CopyMotionRow) {
  return [
    row.spend,
    row.purchaseValue,
    row.purchases,
    row.impressions,
    row.linkClicks,
    row.addToCart,
  ].some((value) => (finite(value) ?? 0) !== 0);
}

function copyKind(row: CopyMotionRow) {
  if (row.copyAssetType === "primary_text") return "Primary";
  if (row.copyAssetType === "headline") return "Headline";
  if (row.copyAssetType === "description") return "Description";
  if (row.copyAssetType === "bundle") return "Bundle";
  return null;
}

function buildCopyAngles(rows: CopyMotionRow[]): CreativeStudioCopyAngle[] {
  const totalSpend = rows.reduce(
    (sum, row) => sum + (copyHasObservedMetrics(row) ? finite(row.spend) ?? 0 : 0),
    0,
  );
  const groups = new Map<string, CopyMotionRow[]>();
  for (const row of rows) {
    const angle = row.copyAngle?.trim();
    if (!angle) continue;
    const bucket = groups.get(angle) ?? [];
    bucket.push(row);
    groups.set(angle, bucket);
  }

  return [...groups.entries()]
    .map(([name, bucket]) => {
      const observed = bucket.filter(copyHasObservedMetrics);
      const spend = observed.reduce((sum, row) => sum + (finite(row.spend) ?? 0), 0);
      const value = observed.reduce(
        (sum, row) => sum + (finite(row.purchaseValue) ?? 0),
        0,
      );
      const impressions = observed.reduce(
        (sum, row) => sum + (finite(row.impressions) ?? 0),
        0,
      );
      const linkClicks = observed.reduce(
        (sum, row) => sum + (finite(row.linkClicks) ?? 0),
        0,
      );
      const best = observed
        .filter((row) => finite(row.roas) !== null)
        .sort((left, right) => (finite(right.roas) ?? 0) - (finite(left.roas) ?? 0))[0];

      return {
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || name,
        name,
        tone: "neutral" as const,
        lines: bucket.length,
        spendShare: totalSpend > 0 ? (spend / totalSpend) * 100 : null,
        roas: spend > 0 ? value / spend : null,
        ctr: impressions > 0 ? (linkClicks / impressions) * 100 : null,
        bestLine: best?.copyText?.trim() || null,
        usage: null,
      };
    })
    .sort((left, right) => (right.spendShare ?? -1) - (left.spendShare ?? -1))
    .slice(0, 4);
}

export function buildCreativeStudioCopiesModel(input: {
  rows: CopyMotionRow[];
  state: CreativeStudioDataState;
  message?: string | null;
  onOpenRow?: (rowId: string) => void;
}): CreativeStudioCopiesModel {
  const rows: CreativeStudioCopyRow[] = input.rows.map((row) => {
    const available = copyHasObservedMetrics(row);
    const metric = (value: number | null | undefined) =>
      available ? finite(value) : null;
    const purchases = metric(row.purchases);
    const linkClicks = metric(row.linkClicks);
    return {
      id: row.id,
      text: row.copyText?.trim() || "—",
      kind: copyKind(row),
      chars: row.copyText?.length ?? 0,
      angle: row.copyAngle?.trim() || null,
      tone: "neutral",
      ads: row.associatedAdsCountAvailable ? row.associatedAdsCount : null,
      currency: row.currency?.trim() || null,
      spend: metric(row.spend),
      // These fields are not present in the typed Meta copies response.
      seeMore: null,
      ctr: metric(row.linkCtr),
      engagement: null,
      cvr: divide(purchases, linkClicks, 100),
      roas: metric(row.roas),
    };
  });
  const angleCount = rows.filter((row) => row.angle).length;
  return {
    state: input.state,
    message: input.message ?? null,
    angles: buildCopyAngles(input.rows),
    angleCoverage:
      input.rows.length > 0
        ? `${angleCount} of ${input.rows.length} synced lines have a server-supplied angle.`
        : null,
    angleGaps: [],
    insight: null,
    rows,
    onOpenRow: input.onOpenRow,
  };
}

function destinationLabel(value: string) {
  try {
    const url = new URL(value);
    return `${url.pathname || "/"}${url.search}`;
  } catch {
    return value;
  }
}

export function buildCreativeStudioLandingModel(input: {
  rows: MetaCreativeApiRow[];
  state: CreativeStudioDataState;
  message?: string | null;
}): CreativeStudioLandingModel {
  const grouped = new Map<string, MetaCreativeApiRow[]>();
  for (const row of input.rows) {
    const destination = row.destination_url?.trim();
    if (!destination) continue;
    const bucket = grouped.get(destination) ?? [];
    bucket.push(row);
    grouped.set(destination, bucket);
  }

  const rows: CreativeStudioLandingRow[] = [...grouped.entries()]
    .map(([destination, bucket]) => {
      const sum = (read: (row: MetaCreativeApiRow) => number | null) =>
        bucket.reduce((total, row) => total + (read(row) ?? 0), 0);
      const spend = sum((row) => finite(row.spend));
      const purchaseValue = sum((row) => finite(row.purchase_value));
      const purchases = sum((row) => finite(row.purchases));
      const linkClicks = sum((row) => finite(row.link_clicks));
      const landingPageViews = sum((row) => finite(row.landing_page_views));
      const currencies = new Set(
        bucket.map((row) => row.currency?.trim()).filter((value): value is string => Boolean(value)),
      );
      const ads = bucket.reduce(
        (total, row) => total + Math.max(1, Math.round(finite(row.associated_ads_count) ?? 1)),
        0,
      );
      return {
        id: destination,
        destination: destinationLabel(destination),
        ads,
        currency: currencies.size === 1 ? [...currencies][0]! : null,
        spend,
        linkClicks,
        landingPageViewRate: divide(landingPageViews, linkClicks, 100),
        cvr: divide(purchases, landingPageViews, 100),
        cpa: divide(spend, purchases),
        roas: divide(purchaseValue, spend),
        // The Meta creative payload does not own a destination verdict.
        signal: null,
        signalTone: "neutral" as const,
      };
    })
    .sort((left, right) => (right.spend ?? -1) - (left.spend ?? -1));

  return {
    state: input.state,
    message: input.message ?? null,
    rows,
    // No producer currently owns these reads. Preserve the designed sections
    // and let the presentation render their honest empty state.
    gaps: [],
    tests: [],
    history: [],
  };
}
