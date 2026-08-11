/**
 * Zero-base projection of the existing search.
 *
 * Adapts what `lib/entity-search.ts` already returns rather than re-querying:
 * scope resolution, ranking and the no-live-Meta guarantee stay exactly where
 * they are. What is added here is the part the canonical overlay needs and the
 * legacy response lacks — a cap with an honest X-of-Y line, and deep links
 * that point at canonical routes.
 *
 * The cap matters more than it looks. A capped list rendered without a
 * disclosure reads as "these are all the matches", and the buyer then decides
 * an entity does not exist because it was ranked 51st.
 */
import type { CollectionEnvelope } from "@/lib/zero-base/state-types";
import type { EntitySearchResult, SearchEntityType } from "@/lib/entity-search";

export const SEARCH_RESULT_CAP = 50;

/** The exact label the design specifies. No other provider is implied. */
export const SEARCH_SCOPE_LABEL = "Businesses + Meta entities";

export interface ZeroBaseSearchResult {
  entityType: SearchEntityType;
  entityId: string;
  /** An unnamed entity falls back to its id rather than rendering blank. */
  name: string;
  businessId: string;
  businessName: string | null;
  /** Canonical route, or null when no canonical destination can resolve it. */
  href: string | null;
  group: string;
}

const GROUP_LABEL: Record<SearchEntityType, string> = {
  business: "Businesses",
  campaign: "Meta campaigns",
  adset: "Meta ad sets",
  ad: "Meta ads",
  report: "Reports",
};

/**
 * Canonical destination for a result.
 *
 * Returns null rather than guessing: a link that 404s is worse than a row that
 * is plainly not navigable. Meta entities resolve to the Decisions collection
 * for their business, which is the canonical surface that can locate them —
 * there is no per-entity canonical leaf to deep link to.
 */
export function canonicalHrefFor(result: {
  entityType: SearchEntityType;
  entityId: string;
  businessId: string;
}): string | null {
  if (!result.businessId) return null;
  switch (result.entityType) {
    case "business":
      return `/c/${result.businessId}/home`;
    case "report":
      return `/c/${result.businessId}/reports/${result.entityId}`;
    case "campaign":
    case "adset":
    case "ad":
      return `/c/${result.businessId}/meta/decisions`;
    default:
      return null;
  }
}

export function toZeroBaseSearchEnvelope(
  results: readonly (EntitySearchResult & { businessName?: string | null })[],
  options: { cap?: number } = {},
): CollectionEnvelope<ZeroBaseSearchResult> {
  const cap = options.cap ?? SEARCH_RESULT_CAP;
  const total = results.length;
  const served = results.slice(0, cap);
  const truncated = total > cap;

  return {
    items: served.map((result) => ({
      entityType: result.entityType,
      entityId: result.entityId,
      name: result.name ?? result.entityId,
      businessId: result.businessId,
      businessName: result.businessName ?? null,
      href: canonicalHrefFor(result),
      group: GROUP_LABEL[result.entityType],
    })),
    servedCount: served.length,
    totalCount: total,
    cap,
    nextCursor: null,
    truncated,
    disclosure: truncated
      ? `Showing the top ${served.length} of ${total} matches. Narrow the search to see the rest.`
      : null,
  };
}

/** Copy for a caller with no active membership — not an empty result. */
export const SEARCH_PERMISSION_EMPTY =
  "You do not have access to any business yet, so there is nothing to search.";

export const SEARCH_ZERO_RESULT = "No matches. Search covers businesses and Meta entities only.";
