/**
 * Source readiness for the MOUNTED Overview, from facts it already reads.
 *
 * `lib/zero-base/home/home-server.ts` builds the same contract for the zero-base
 * Home body, and it can only say `freshness: "unknown"` for every source —
 * `getIntegrationStatusByBusiness` returns a connected boolean and no
 * timestamp. The mounted Overview is better placed: it already fetches
 * `/api/meta/status` and `/api/google-ads/status` for its platform cards, and
 * both carry a real `latestSync`. So the two providers whose numbers dominate
 * this page get a freshness that was measured, and the rest stay `unknown`
 * rather than being asserted as fresh.
 *
 * Nothing here decides anything. Connected-ness comes from the integrations
 * read, the timestamps come from the provider status reads, and a source with
 * no timestamp is `unknown` — never `fresh`, and never a silent `ok`.
 */
import type { HomeSourceState } from "@/lib/zero-base/home/metric-contract";

/**
 * How old a sync may be before this page calls it stale.
 *
 * A day. The Overview's own reads are daily aggregates, so a source that has
 * synced within the last 24 hours has contributed to the window on screen and
 * one that has not may be missing a whole day of it. Deliberately not a
 * decision threshold: nothing downstream reads this, and the Meta surfaces
 * resolve their own freshness from the engine's snapshot rather than from here.
 */
export const OVERVIEW_SOURCE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The sources Overview's own numbers are built from, in reading order. */
const OVERVIEW_SOURCES: ReadonlyArray<{
  key: string;
  label: string;
  /** Which provider status read, if any, carries this source's timestamp. */
  syncKey?: "meta" | "google";
}> = [
  { key: "meta", label: "Meta", syncKey: "meta" },
  { key: "google", label: "Google Ads", syncKey: "google" },
  { key: "shopify", label: "Shopify" },
  { key: "ga4", label: "GA4" },
  { key: "search_console", label: "Search Console" },
];

function freshnessFor(
  lastUpdatedAt: string | null,
  now: number,
): HomeSourceState["freshness"] {
  if (!lastUpdatedAt) return "unknown";
  const at = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(at)) return "unknown";
  return now - at <= OVERVIEW_SOURCE_STALE_AFTER_MS ? "fresh" : "stale";
}

export function buildOverviewSourceHealth(input: {
  /** `/api/integrations/status`: provider → connected. Null when unread. */
  integrations: Record<string, boolean> | null | undefined;
  /** The two provider status reads this page already performs. */
  latestSync?: { meta?: string | null; google?: string | null };
  now: number;
}): HomeSourceState[] {
  return OVERVIEW_SOURCES.map((source) => {
    /*
     * An unread integrations map is not "not connected".
     *
     * The whole point of this panel is to distinguish a source that is absent
     * from one nobody asked about, so an unread map produces `unavailable` with
     * a reason that says the READ failed — and, crucially, no remedy, because
     * "Connect this source" would be advice given without knowing whether it is
     * already connected.
     */
    if (!input.integrations) {
      return {
        key: source.key,
        label: source.label,
        state: "unavailable",
        reason: "The integration status read did not complete for this business.",
        freshness: "unknown",
        lastUpdatedAt: null,
        remedy: "details",
      };
    }

    const connected = input.integrations[source.key] === true;
    if (!connected) {
      return {
        key: source.key,
        label: source.label,
        state: "unavailable",
        reason: "Not connected for this business.",
        freshness: "unknown",
        lastUpdatedAt: null,
        remedy: "connect",
      };
    }

    const lastUpdatedAt = source.syncKey
      ? (input.latestSync?.[source.syncKey] ?? null)
      : null;
    const freshness = freshnessFor(lastUpdatedAt, input.now);
    /*
     * Connected and stale is `partial`, not `ok`.
     *
     * The numbers on this page are real and they are behind, which is a
     * different fact from both "serving" and "unavailable" — and the one an
     * operator most needs, because a stale source produces a page that looks
     * complete and is not.
     */
    if (freshness === "stale") {
      return {
        key: source.key,
        label: source.label,
        state: "partial",
        reason: "Connected, but the last sync is more than a day old.",
        freshness,
        lastUpdatedAt,
        remedy: "reconnect",
      };
    }
    return {
      key: source.key,
      label: source.label,
      state: "ok",
      reason: null,
      freshness,
      lastUpdatedAt,
      remedy: "details",
    };
  });
}

/**
 * The daily spend/ROAS series the trend panel draws.
 *
 * ROAS is revenue over spend on the day, which is the same quotient this
 * surface's own sparkline builder already takes for its per-provider ROAS
 * series. A day with no spend has no ROAS — `null`, never 0 and never
 * Infinity — because the ratio is undefined rather than bad, and a line that
 * dives to the axis on a day nobody spent is a claim about performance that
 * was never measured.
 */
export function overviewTrendPoints(
  combined: ReadonlyArray<{ date: string; spend: number; revenue: number }>,
): Array<{ date: string; spend: number | null; roas: number | null }> {
  return combined.map((point) => {
    const spend = Number.isFinite(point.spend) ? point.spend : null;
    const revenue = Number.isFinite(point.revenue) ? point.revenue : null;
    return {
      date: point.date,
      spend,
      roas:
        spend !== null && spend > 0 && revenue !== null ? revenue / spend : null,
    };
  });
}
