import { recordProductInstrumentationEvent } from "@/lib/product-instrumentation";
import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/access";
import {
  MIN_SEARCH_QUERY_LENGTH,
  isSearchableQuery,
  rankEntitySearchResults,
  type EntitySearchCandidate,
} from "@/lib/entity-search";
import { findEntitySearchCandidates } from "@/lib/entity-search-store";

export const dynamic = "force-dynamic";

/**
 * Find an entity by name or id across everything the caller can see.
 *
 * Scope is resolved from the caller's memberships and applied in the query, so
 * results can only contain entities they are already entitled to. Results are
 * ranked server-side rather than assembled from capped decision pages.
 */
export async function GET(request: NextRequest) {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json(
      { error: "auth_error", message: "Authentication required." },
      { status: 401 },
    );
  }

  const rawQuery = request.nextUrl.searchParams.get("q") ?? "";
  if (!isSearchableQuery(rawQuery)) {
    return NextResponse.json({
      query: rawQuery,
      results: [],
      reason: "query_too_short",
      minimumLength: MIN_SEARCH_QUERY_LENGTH,
    });
  }

  const businesses = (await listUserBusinesses(session.user.id)).filter(
    (business) => business.membershipStatus === "active",
  );
  if (businesses.length === 0) {
    return NextResponse.json({ query: rawQuery, results: [], reason: "no_scope" });
  }

  const businessNames = new Map(businesses.map((business) => [business.id, business.name]));

  let candidates: EntitySearchCandidate[];
  try {
    candidates = await findEntitySearchCandidates({
      businessIds: businesses.map((business) => business.id),
      query: rawQuery,
    });
  } catch (error: unknown) {
    // A failed search is a failure, not "no matches" — otherwise the buyer
    // concludes the entity does not exist.
    return NextResponse.json(
      {
        error: "search_unavailable",
        message: error instanceof Error ? error.message : "Search is unavailable.",
      },
      { status: 503 },
    );
  }

  // Businesses themselves are searchable and need no warehouse read.
  for (const business of businesses) {
    candidates.push({
      entityType: "business",
      entityId: business.id,
      name: business.name,
      businessId: business.id,
    });
  }

  const results = rankEntitySearchResults(candidates, rawQuery).map((result) => ({
    ...result,
    businessName: businessNames.get(result.businessId) ?? null,
  }));

  // Section 9: search spans the workspace, so it is portfolio-scoped. The query
  // text is never recorded -- only that a search happened, and whether it found
  // anything, which is what the zero-result rate actually needs.
  await recordProductInstrumentationEvent({
    businessId: null,
    scope: "portfolio",
    eventName: results.length > 0 ? "search_submitted" : "search_zero_result",
    surface: "global_search",
    outcome: results.length > 0 ? "ok" : "withheld",
    itemCount: results.length,
    occurredAt: new Date().toISOString(),
  });

  return NextResponse.json({ query: rawQuery, results });
}
