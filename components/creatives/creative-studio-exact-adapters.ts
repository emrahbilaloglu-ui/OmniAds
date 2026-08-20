import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import type { CopyMotionRow } from "@/app/(dashboard)/platforms/meta/copies/page-support";
import type {
  MetaCreativeRow,
  MetaObservedMetricKey,
} from "@/components/creatives/metricConfig";
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

function divide(
  numerator: number | null,
  denominator: number | null,
  scale = 1,
) {
  if (numerator === null || denominator === null || denominator <= 0)
    return null;
  return (numerator / denominator) * scale;
}

/**
 * A ratio someone else computed, withheld when its denominator makes it
 * undefined.
 *
 * The value is passed through untouched — this is not a formula. It removes
 * only the substitution: zero purchases does not make acquisition free, zero
 * impressions does not make the cost per thousand zero, and printing 0 for
 * either is a measurement the provider never made.
 */
function ratioWithDenominator(
  value: number | null,
  denominator: number | null,
): number | null {
  if (denominator === null || denominator <= 0) return null;
  return value;
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDateMs(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed || !ISO_DATE.test(trimmed)) return null;
  const parsed = Date.parse(`${trimmed}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How many whole days the creative had existed by the END OF THE WINDOW the
 * row's numbers were measured over.
 *
 * ONE IMPLEMENTATION, imported by the mounted projector in
 * `app/(dashboard)/platforms/meta/creatives/legacy-page.tsx`, because a clock
 * that exists twice is a clock that will eventually disagree with itself.
 *
 * WHICH END, decided rather than defaulted. The default window ends YESTERDAY —
 * `lib/dashboard/date-window-presets.ts` states it: "a rolling preset ends
 * YESTERDAY, on completed days only" — so `Date.now()` would put the age on a
 * different clock from every other number in the same row, and a creative
 * created two days before the window closed would read 3 rather than 2. The
 * subtraction is against `windowEndIso`, so the row answers as of one instant.
 *
 * ELAPSED DAYS, NOT DAYS INCLUSIVE. A creative created ON the window's last day
 * is 0 — zero days have elapsed since it was created — and 0 is a MEASUREMENT
 * that prints as "0". The em dash is reserved for the two cases where no age
 * exists to state:
 *
 *   - no date. An unsupplied `launch_date` reaches the wire as `undefined` when
 *     the stored projection was spread through `coerceRawCreativeRow`, and as
 *     `""` on its api-row branch; `mapApiRowToUiRow` then runs `safeString`
 *     over either, so what this function is handed is the EMPTY STRING, not a
 *     null. Printing 0 for it would claim the creative was created on the day
 *     the window closed.
 *   - a date AFTER the window's end. Nothing was measured between those two
 *     instants; the row is asserting a creation date later than the last day it
 *     reports numbers for, which is a contradiction in the data rather than a
 *     negative age. It is withheld instead of clamped, because clamping would
 *     publish the contradiction as a measured 0.
 */
export function creativeAgeDays(
  launchDate: string | null | undefined,
  windowEndIso: string | null | undefined,
): number | null {
  const launchMs = isoDateMs(launchDate);
  const windowEndMs = isoDateMs(windowEndIso);
  if (launchMs === null || windowEndMs === null) return null;
  const days = Math.round((windowEndMs - launchMs) / MS_PER_DAY);
  return days < 0 ? null : days;
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

/**
 * NOTE: no route mounts this builder.
 *
 * `rg -n 'buildCreativeStudioAssetsModel' app components lib` finds this
 * definition and its unit test and nothing else; the live Assets surface
 * projects its rows with `toCreativeStudioAssetRows` in
 * app/(dashboard)/platforms/meta/creatives/legacy-page.tsx. Fixes made only
 * here would not reach a pixel, so the null-versus-zero work for Assets was
 * done there and this builder is only kept consistent with it.
 */
export function buildCreativeStudioAssetsModel(input: {
  rows: MetaCreativeRow[];
  state: CreativeStudioDataState;
  message?: string | null;
  /**
   * The last day the rows' numbers cover, as `YYYY-MM-DD`. Required, not
   * defaulted: an age has to be counted to something, and a caller that omitted
   * it would silently blank the column rather than fail.
   */
  windowEnd: string | null;
}): CreativeStudioAssetsModel {
  const rows: CreativeStudioAssetRow[] = input.rows.map((row) => {
    const metric = (
      key: MetaObservedMetricKey,
      value: number | null | undefined,
    ) =>
      row.observedMetrics
        ? finite(row.observedMetrics[key])
        : row.metricsAvailability === "available"
          ? finite(value)
          : null;
    const purchases = metric("purchases", row.purchases);
    const linkClicks = metric("linkClicks", row.linkClicks);
    const addToCart = metric("addToCart", row.addToCart);
    const purchaseValue = metric("purchaseValue", row.purchaseValue);
    const impressions = metric("impressions", row.impressions);
    const spend = metric("spend", row.spend);

    return {
      id: row.id,
      name: row.name?.trim() || "—",
      kind:
        [row.creativePrimaryLabel, row.creativeVisualFormat]
          .map((value) => value?.trim())
          .filter(Boolean)
          .join(" · ") || "—",
      imageUrl: previewUrl(row),
      // The Status column carries the ENGINE's classification, and this builder
      // is handed no engine read — only provider rows. It therefore states the
      // explicit non-decision state rather than leaving a blank. The live
      // surface gets its classification in
      // `toCreativeStudioAssetRows`
      // (app/(dashboard)/platforms/meta/creatives/legacy-page.tsx) from the
      // briefing index. Putting the delivery enum back here would restore the
      // exact defect that change fixed.
      status: "Not evaluated",
      statusTone: "neutral",
      decisionSegment: null,
      statusDetail: "No decision context was supplied to this adapter",
      decisionCount: 0,
      deliveryStatus: titleCaseStatus(row.effectiveStatus),
      marketingAngle:
        row.aiTags.messagingAngle?.find((value) => value.trim()) ?? null,
      currency: row.currency?.trim() || null,
      metrics: {
        spend,
        impressions,
        revenue: purchaseValue,
        clicks: metric("clicks", row.clicks),
        linkClicks,
        landingPageViews: metric("landingPageViews", row.landingPageViews),
        addToCart,
        initiateCheckout: metric("initiateCheckout", row.initiateCheckout),
        purchases,
        // Producer-computed ratios, withheld when their denominator makes them
        // undefined. `normalizeCreativeMetricFields` ends each of these with
        // `: 0`, so a creative with zero purchases published `cpa: 0` — the
        // best possible value in a lower-is-better column.
        roas: ratioWithDenominator(metric("roas", row.roas), spend),
        cpa: ratioWithDenominator(metric("cpa", row.cpa), purchases),
        cpm: ratioWithDenominator(metric("cpm", row.cpm), impressions),
        cpcLink: ratioWithDenominator(
          metric("cpcLink", row.cpcLink),
          linkClicks,
        ),
        aov: divide(purchaseValue, purchases),
        ctr: ratioWithDenominator(metric("ctrAll", row.ctrAll), impressions),
        thumbstop: ratioWithDenominator(
          metric("thumbstop", row.thumbstop),
          impressions,
        ),
        // `hold` is gone from `CreativeAssetMetricId` entirely: the creative
        // payload has no Hold 15s field, `META_OBSERVED_METRIC_KEYS` has no key
        // for one, and video-completion rates are a different question rather
        // than a proxy. It used to be assigned a literal `null` here and in the
        // mounted projector, which made it a permanent em dash in every row.
        frequency: metric("frequency", row.frequency),
        atcRate: divide(addToCart, linkClicks, 100),
        atcToPurchase: ratioWithDenominator(
          metric("atcToPurchaseRatio", row.atcToPurchaseRatio),
          addToCart,
        ),
        cvr: divide(purchases, linkClicks, 100),
        // Not a metric the provider serves — a subtraction between two dates
        // this row already carries. See `creativeAgeDays` for which clock and
        // which end, and `CreativeAssetMetricId` for the greps that establish
        // that "first seen" and "first spend" never reach this grain.
        ageDays: creativeAgeDays(row.launchDate, input.windowEnd),
      },
    };
  });

  return {
    state: input.state,
    message: input.message ?? null,
    // A count is only a count when a read produced one. `unavailable` means no
    // read happened, so it reports the same unknown as `loading` and `error`
    // rather than the 0 rows it happens to be holding.
    syncedCount:
      input.state === "loading" ||
      input.state === "error" ||
      input.state === "unavailable"
        ? null
        : rows.length,
    rows,
  };
}

/**
 * REMOVED: `copyHasObservedMetrics`, the "if any metric is non-zero then all
 * metrics are observed" heuristic.
 *
 * It answered a question no payload asks. A copy line that ran and delivered
 * nothing — paused before spend, or never entered delivery — is a real all-zero
 * row, and the heuristic declared every one of its numbers unknown, so the
 * surface printed em dashes over facts the provider had actually measured.
 * Reading it the other way was just as wrong: one non-zero field licensed every
 * other field on the row, including ones the response never carried.
 *
 * Availability is per field now. `mapApiRowToCopyRow`
 * (app/(dashboard)/platforms/meta/copies/page-support.ts) passes `spend`,
 * `roas`, `cpa`, `cpm`, `cpc_link` and `ctr_all` straight through without a
 * `?? 0`, so `finite()` is the honest test: a number is a measurement, absence
 * is absence, and 0 is a number.
 */
function copyMetric(value: number | null | undefined) {
  return finite(value);
}

function copyKind(row: CopyMotionRow) {
  if (row.copyAssetType === "primary_text") return "Primary";
  if (row.copyAssetType === "headline") return "Headline";
  if (row.copyAssetType === "description") return "Description";
  if (row.copyAssetType === "bundle") return "Bundle";
  return null;
}

function buildCopyAngles(rows: CopyMotionRow[]): CreativeStudioCopyAngle[] {
  // Only served numbers enter a total. A row that carried no `spend` adds
  // nothing and, unlike a row that carried 0, was never counted as evidence.
  const totalSpend = rows.reduce(
    (sum, row) => sum + (copyMetric(row.spend) ?? 0),
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
      const spend = bucket.reduce(
        (sum, row) => sum + (copyMetric(row.spend) ?? 0),
        0,
      );
      const value = bucket.reduce(
        (sum, row) => sum + (copyMetric(row.purchaseValue) ?? 0),
        0,
      );
      const impressions = bucket.reduce(
        (sum, row) => sum + (copyMetric(row.impressions) ?? 0),
        0,
      );
      const linkClicks = bucket.reduce(
        (sum, row) => sum + (copyMetric(row.linkClicks) ?? 0),
        0,
      );
      const best = bucket
        .filter((row) => copyMetric(row.roas) !== null)
        .sort(
          (left, right) =>
            (copyMetric(right.roas) ?? 0) - (copyMetric(left.roas) ?? 0),
        )[0];

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
    const metric = copyMetric;
    const purchases = metric(row.purchases);
    const linkClicks = metric(row.linkClicks);
    const impressions = metric(row.impressions);
    const spend = metric(row.spend);
    return {
      id: row.id,
      text: row.copyText?.trim() || "—",
      kind: copyKind(row),
      chars: row.copyText?.length ?? 0,
      angle: row.copyAngle?.trim() || null,
      tone: "neutral",
      ads: row.associatedAdsCountAvailable ? row.associatedAdsCount : null,
      currency: row.currency?.trim() || null,
      spend,
      // These fields are not present in the typed Meta copies response.
      seeMore: null,
      // `linkCtr` is computed in `mapApiRowToCopyRow` as
      // `impressions > 0 ? … : 0`, so with no impressions it is a fabricated 0
      // rather than a measured rate.
      ctr: ratioWithDenominator(metric(row.linkCtr), impressions),
      engagement: null,
      cvr: divide(purchases, linkClicks, 100),
      roas: ratioWithDenominator(metric(row.roas), spend),
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
      /**
       * A total of what was actually served — or nothing at all.
       *
       * `total + (read(row) ?? 0)` treated an unserved field as a contribution
       * of zero, so a destination whose ads carried no `spend` at all summed to
       * a confident `0` and rendered as a real, measured "this destination cost
       * nothing". Null now means no ad in the bucket reported the field, which
       * the table renders as an em dash. A bucket where every ad reported 0
       * still totals 0, because that is a measurement.
       */
      const sum = (read: (row: MetaCreativeApiRow) => number | null) => {
        let total: number | null = null;
        for (const row of bucket) {
          const value = read(row);
          if (value === null) continue;
          total = (total ?? 0) + value;
        }
        return total;
      };
      const spend = sum((row) => finite(row.spend));
      const purchaseValue = sum((row) => finite(row.purchase_value));
      const purchases = sum((row) => finite(row.purchases));
      const linkClicks = sum((row) => finite(row.link_clicks));
      const landingPageViews = sum((row) => finite(row.landing_page_views));
      const currencies = new Set(
        bucket
          .map((row) => row.currency?.trim())
          .filter((value): value is string => Boolean(value)),
      );
      const ads = bucket.reduce(
        (total, row) =>
          total +
          Math.max(1, Math.round(finite(row.associated_ads_count) ?? 1)),
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
