import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { getSearchConsoleStatus } from "@/lib/search-console-status";

/**
 * GET /api/google-search-console/status?businessId=...
 *
 * The Search Console half of the integrations card's first-sync evidence.
 *
 * Authorization copies its closest sibling read exactly:
 * `app/api/google-search-console/sites/route.ts` guards with
 * `requireBusinessAccess` at `minRole: "guest"`, and so does this.
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

  const status = await getSearchConsoleStatus(businessId);

  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store" },
  });
}
