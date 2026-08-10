/**
 * Global entity search.
 *
 * A buyer who remembers a campaign by name has no way to reach it today: the
 * decision surfaces carry no search field, and their lists are capped, so a
 * name outside the visible page is unreachable. This ranks matches from a
 * server query rather than filtering an already-capped list in the browser —
 * concatenating capped pages client-side would quietly bypass the decision
 * contract instead of searching the account.
 */

export type SearchEntityType = "campaign" | "adset" | "ad" | "business" | "report";

export interface EntitySearchCandidate {
  entityType: SearchEntityType;
  entityId: string;
  name: string | null;
  businessId: string;
  businessName?: string | null;
  provider?: string | null;
  providerAccountId?: string | null;
  status?: string | null;
  parentName?: string | null;
  updatedAt?: string | null;
}

export interface EntitySearchResult extends EntitySearchCandidate {
  /** Why this matched, so a surprising hit is explainable. */
  matchKind: "exact_id" | "exact_name" | "prefix" | "contains";
  score: number;
  href: string;
}

/** Rank bands. Lower sorts first. */
const MATCH_RANK: Record<EntitySearchResult["matchKind"], number> = {
  exact_id: 0,
  exact_name: 1,
  prefix: 2,
  contains: 3,
};

/**
 * Entity ordering within an equal match band: the container a buyer is more
 * likely to mean first.
 */
const TYPE_RANK: Record<SearchEntityType, number> = {
  business: 0,
  campaign: 1,
  adset: 2,
  ad: 3,
  report: 4,
};

export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

function classifyMatch(
  candidate: EntitySearchCandidate,
  query: string,
): EntitySearchResult["matchKind"] | null {
  const name = candidate.name?.trim().toLowerCase() ?? "";
  const id = candidate.entityId.trim().toLowerCase();

  if (id === query) return "exact_id";
  // Provider ids are often pasted with their prefix; match the bare number too.
  if (id.replace(/^act_/, "") === query.replace(/^act_/, "")) return "exact_id";
  if (name && name === query) return "exact_name";
  if (name && name.startsWith(query)) return "prefix";
  if (name && name.includes(query)) return "contains";
  if (id.includes(query)) return "contains";
  return null;
}

function buildHref(candidate: EntitySearchCandidate): string {
  const params = new URLSearchParams();
  params.set("businessId", candidate.businessId);
  if (candidate.providerAccountId) {
    params.set("providerAccountId", candidate.providerAccountId);
  }

  switch (candidate.entityType) {
    case "business":
      return `/overview?businessId=${encodeURIComponent(candidate.businessId)}`;
    case "report":
      return `/reports/${encodeURIComponent(candidate.entityId)}`;
    case "campaign":
    case "adset":
    case "ad":
    default:
      // Land on the decision surface with business and account scope intact so
      // the destination is the same context the search was run from.
      params.set("entityId", candidate.entityId);
      params.set("entityType", candidate.entityType);
      return `/platforms/meta?${params.toString()}`;
  }
}

/**
 * Rank candidates for a query.
 *
 * Deliberately stable: equal matches fall back to entity type and then name, so
 * the same query returns the same order between keystrokes.
 */
export function rankEntitySearchResults(
  candidates: EntitySearchCandidate[],
  rawQuery: string,
  limit = 20,
): EntitySearchResult[] {
  const query = normalizeQuery(rawQuery);
  if (!query) return [];

  const results: EntitySearchResult[] = [];
  for (const candidate of candidates) {
    const matchKind = classifyMatch(candidate, query);
    if (!matchKind) continue;
    results.push({
      ...candidate,
      matchKind,
      score: MATCH_RANK[matchKind],
      href: buildHref(candidate),
    });
  }

  results.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const byType = TYPE_RANK[a.entityType] - TYPE_RANK[b.entityType];
    if (byType !== 0) return byType;
    return (a.name ?? a.entityId).localeCompare(b.name ?? b.entityId);
  });

  return results.slice(0, limit);
}

/** The shortest query worth running against the warehouse. */
export const MIN_SEARCH_QUERY_LENGTH = 2;

export function isSearchableQuery(rawQuery: string): boolean {
  return normalizeQuery(rawQuery).length >= MIN_SEARCH_QUERY_LENGTH;
}
