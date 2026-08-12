/**
 * Creative performance presentation (H21).
 *
 * Data logic extracted from `StudioOsView`, which is 3,800 lines of view and
 * data tangled together. Only the selection, filtering and disclosure rules are
 * taken; the component itself is never mounted here, because mounting it would
 * carry its whole legacy surface into a canonical route.
 *
 * The rules that matter:
 *
 * - **Nothing is computed.** Served metric values are formatted for display and
 *   never re-derived, summed or scaled. `buyerAction` in particular is the
 *   server's, and this module has no code that could produce one.
 * - **A cap is disclosed, never implied.** A collection that was truncated says
 *   so with its own numbers. Silence would read as "this is everything".
 * - **A missing metric is missing.** It renders as unavailable with its reason,
 *   not as `0` — a zero is a measurement, and an absence is not.
 * - **The legacy null filter is preserved.** Rows the legacy surface excluded
 *   for missing identity are excluded here too, and counted in the disclosure
 *   so their absence is visible rather than silent.
 */
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { EnginePosture } from "@/lib/zero-base/creative/engine-posture";

/** The subset of the served creative row this surface reads. */
export interface ServedCreativeRow {
  id: string;
  creative_id: string;
  real_ad_id?: string | null;
  account_id: string;
  account_name?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  adset_id?: string | null;
  adset_name?: string | null;
  name: string;
  currency?: string | null;
  launch_date?: string;
  spend?: number | null;
  roas?: number | null;
  cpa?: number | null;
  purchases?: number | null;
  impressions?: number | null;
  preview_status?: "ready" | "missing";
  preview_origin?: "snapshot" | "cache" | "live" | "fallback";
  cached_thumbnail_url?: string | null;
  thumbnail_url?: string | null;
}

export type MetricValue =
  | { available: true; display: string; raw: number }
  | { available: false; reason: string };

export interface PerformanceRow {
  /** Stable row key. The creative identity, never a synthesized index. */
  id: string;
  creativeId: string;
  adId: string | null;
  accountId: string;
  name: string;
  campaignName: string | null;
  adsetName: string | null;
  launchDate: string | null;
  currency: string | null;
  spend: MetricValue;
  roas: MetricValue;
  cpa: MetricValue;
  purchases: MetricValue;
  media: MediaState;
  /**
   * Server-owned decision presentation. The adapter only joins the exact Ad
   * identity already served by the canonical engine; it never derives a
   * verdict from the metrics beside it.
   */
  decision: {
    buyerAction: string | null;
    buyerLabel: string;
    decisionState: string;
    effectiveTargetRoas: number | null;
  } | null;
}

export type MediaState =
  | { kind: "ready"; url: string; origin: string }
  /** Video needs its poster and captions; both are contract, not enhancement. */
  | { kind: "video"; url: string; poster: string; captionsUrl: string | null; origin: string }
  /**
   * Distinct from `missing`. A failure can be retried; an asset that was never
   * captured cannot, and offering retry for it sends the user round a loop that
   * cannot succeed. The reason is carried verbatim so a transient stream error
   * is distinguishable from a revoked asset.
   */
  | { kind: "failed"; reason: string; alt: string }
  | { kind: "missing"; reason: string };

export interface PerformanceDisclosure {
  /** Rows served after the server's own cap. */
  served: number;
  /** Rows the server said exist, when it said. Null means it did not. */
  totalAvailable: number | null;
  /** Rows dropped here for missing identity, and why. */
  excludedForMissingIdentity: number;
  capped: boolean;
  text: string;
}

export interface PerformanceViewModel {
  rows: PerformanceRow[];
  disclosure: PerformanceDisclosure;
  posture: EnginePosture;
  currency: string | null;
}

/** A served number, formatted. Absent stays absent. */
export function toMetric(
  raw: number | null | undefined,
  format: (value: number) => string,
  reason = "Not served for this creative.",
): MetricValue {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return { available: false, reason };
  }
  return { available: true, display: format(raw), raw };
}

function money(currency: string | null): (value: number) => string {
  // The account's own currency, or an explicit marker. Never a silent "$".
  const code = currency?.trim().toUpperCase();
  return (value) => `${value.toFixed(2)} ${code || "(currency not served)"}`;
}

function ratio(value: number): string {
  return value.toFixed(2);
}

function whole(value: number): string {
  return String(Math.trunc(value));
}

export function mediaStateFor(row: ServedCreativeRow): MediaState {
  const url = row.cached_thumbnail_url?.trim() || row.thumbnail_url?.trim() || "";
  if (row.preview_status === "missing" || !url) {
    return {
      kind: "missing",
      // Named rather than blank: a blank frame reads as a loading bug.
      reason: "No preview was captured for this creative.",
    };
  }
  return { kind: "ready", url, origin: row.preview_origin ?? "snapshot" };
}

/**
 * A row must carry the identity the rest of the surface depends on.
 *
 * The legacy surface dropped rows with no creative identity; keeping that
 * filter matters because a row with no id cannot be deep-linked, cannot be
 * matched to a decision, and would render a detail route that resolves to
 * nothing. They are counted so the exclusion is disclosed rather than silent.
 */
export function hasUsableIdentity(row: ServedCreativeRow): boolean {
  return Boolean(row.creative_id?.trim() && row.account_id?.trim());
}

export function buildPerformanceViewModel(input: {
  rows: readonly ServedCreativeRow[];
  canonicalDecisions?: readonly MetaCanonicalDecision[];
  /** The server's own total when it supplies one. */
  totalAvailable?: number | null;
  posture: EnginePosture;
  defaultCurrency?: string | null;
}): PerformanceViewModel {
  const usable = input.rows.filter(hasUsableIdentity);
  const excluded = input.rows.length - usable.length;
  const total = input.totalAvailable ?? null;
  const capped = total !== null && total > usable.length;

  const decisionsByExactAd = new Map(
    (input.canonicalDecisions ?? []).flatMap((decision) => {
      const adId = decision.parentChain.ad?.id?.trim();
      return adId && decision.providerAccountId
        ? [[`${decision.providerAccountId}\u0000${adId}`, decision] as const]
        : [];
    }),
  );

  const rows = usable.map((row) => {
    const currency = row.currency?.trim() || input.defaultCurrency?.trim() || null;
    const fmt = money(currency);
    const canonicalDecision = row.real_ad_id
      ? decisionsByExactAd.get(`${row.account_id}\u0000${row.real_ad_id}`) ?? null
      : null;
    return {
      id: row.id || row.creative_id,
      creativeId: row.creative_id,
      adId: row.real_ad_id?.trim() || null,
      accountId: row.account_id,
      name: row.name,
      campaignName: row.campaign_name?.trim() || null,
      adsetName: row.adset_name?.trim() || null,
      launchDate: row.launch_date?.trim() || null,
      currency,
      spend: toMetric(row.spend, fmt),
      roas: toMetric(row.roas, ratio),
      cpa: toMetric(row.cpa, fmt),
      purchases: toMetric(row.purchases, whole),
      media: mediaStateFor(row),
      decision: canonicalDecision
        ? {
            buyerAction: canonicalDecision.classification.buyerAction,
            buyerLabel: canonicalDecision.classification.buyerLabel,
            decisionState: canonicalDecision.classification.decisionState,
            effectiveTargetRoas: Number.isFinite(canonicalDecision.metrics.effectiveTargetRoas)
              ? canonicalDecision.metrics.effectiveTargetRoas
              : null,
          }
        : null,
    } satisfies PerformanceRow;
  });

  const parts: string[] = [];
  if (capped) {
    parts.push(`Showing ${rows.length} of ${total} creatives served for this window.`);
  } else if (total !== null) {
    parts.push(`Showing all ${rows.length} creatives served for this window.`);
  } else {
    // The backend did not supply a total. Saying "all" would be a claim.
    parts.push(`Showing ${rows.length} creatives. The backend did not supply a total.`);
  }
  if (excluded > 0) {
    parts.push(
      `${excluded} row${excluded === 1 ? "" : "s"} omitted because no creative identity was recorded.`,
    );
  }

  return {
    rows,
    disclosure: {
      served: rows.length,
      totalAvailable: total,
      excludedForMissingIdentity: excluded,
      capped,
      text: parts.join(" "),
    },
    posture: input.posture,
    currency: input.defaultCurrency?.trim() || null,
  };
}

/**
 * The Decisions link for one creative.
 *
 * Every identifier the served row carries is retained. Dropping one produces a
 * link that lands on a different scope than the row the operator clicked, which
 * is worse than no link at all.
 */
export function decisionsHrefForCreative(input: {
  businessId: string;
  row: Pick<PerformanceRow, "creativeId" | "adId" | "accountId">;
}): string {
  const params = new URLSearchParams();
  params.set("providerAccountId", input.row.accountId);
  params.set("creativeId", input.row.creativeId);
  if (input.row.adId) {
    // The decision universe is keyed by ad; without this the link is a search,
    // not a destination.
    params.set("row", `ad:${input.row.adId}`);
  }
  return `/c/${encodeURIComponent(input.businessId)}/meta/decisions?${params.toString()}`;
}

/** Canonical detail href, scoped to the account the row belongs to. */
export function creativeDetailHref(input: {
  businessId: string;
  creativeId: string;
  accountId: string;
}): string {
  const params = new URLSearchParams({ providerAccountId: input.accountId });
  return `/c/${encodeURIComponent(input.businessId)}/creative/${encodeURIComponent(
    input.creativeId,
  )}?${params.toString()}`;
}
