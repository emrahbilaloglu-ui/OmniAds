import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { listAdvisorExecutionEvents } from "@/lib/google-ads/advisor-memory";
import { GOOGLE_ADS_RETENTION_POLICY } from "@/lib/google-ads/warehouse-retention";

/**
 * The Plan screen's Activity feed: the guarded-write execution log, newest
 * first.
 *
 * This is a read with the same authority as every other Google Ads report
 * route — `requireBusinessAccess` at `guest`, demo businesses short-circuited —
 * and it writes nothing. The retention window travels with the rows because
 * the boundary the screen states above the table is the log's own policy, not
 * a number the client may pick.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const businessId = params.get("businessId");
  const accountId = params.get("accountId");

  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  const retentionDays =
    GOOGLE_ADS_RETENTION_POLICY.advisor_execution_log.retentionDays;

  // A demo business has no execution log and never executes a guarded write, so
  // the feed is empty rather than seeded.
  if (await isDemoBusiness(businessId)) {
    return NextResponse.json({ rows: [], count: 0, retentionDays });
  }

  const rows = await listAdvisorExecutionEvents({
    businessId,
    accountId: accountId && accountId !== "all" ? accountId : null,
  });

  return NextResponse.json({ rows, count: rows.length, retentionDays });
}
