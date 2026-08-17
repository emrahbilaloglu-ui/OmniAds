import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { getGoogleAnalyticsStatus } from "@/lib/google-analytics-status";

/**
 * GET /api/google-analytics/status?businessId=...
 *
 * The GA4 half of the integrations card's first-sync evidence.
 *
 * Authorization is the shape every sibling provider status read already uses —
 * `requireBusinessAccess` at `minRole: "guest"`, the same as
 * `/api/shopify/status`, `/api/integrations/status`,
 * `/api/google-search-console/sites` and `/api/search-console/analytics`. It is
 * a read of connection metadata for one business and nothing else.
 */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");

  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId query parameter is required.",
      },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const status = await getGoogleAnalyticsStatus(businessId);

  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
