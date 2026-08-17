import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import {
  GA4AuthError,
  getAnalyticsOverviewData,
} from "@/lib/analytics-overview";
import { getCachedRouteReport } from "@/lib/route-report-cache";
import { runWithGoogleRequestAuditContext } from "@/lib/google-request-audit";
import { ProviderRequestCooldownError } from "@/lib/provider-request-governance";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const startDate =
    request.nextUrl.searchParams.get("startDate") ?? "30daysAgo";
  const endDate = request.nextUrl.searchParams.get("endDate") ?? "yesterday";
  // The design's KPI cards carry a "vs prev Nd" line. The caller names the
  // window it wants compared; nothing is inferred here.
  const compareStartDate = request.nextUrl.searchParams.get("compareStartDate");
  const compareEndDate = request.nextUrl.searchParams.get("compareEndDate");

  if (!businessId) {
    return NextResponse.json({ error: "missing_business_id" }, { status: 400 });
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  const cached = await getCachedRouteReport<Awaited<ReturnType<typeof getAnalyticsOverviewData>>>({
    businessId,
    provider: "ga4",
    reportType: "ga4_analytics_overview",
    searchParams: request.nextUrl.searchParams,
  });
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const payload = await runWithGoogleRequestAuditContext(
      {
        provider: "ga4",
        businessId,
        requestSource: "live_report",
        requestPath: "/api/analytics/overview",
        requestType: "ga4_analytics_overview",
      },
      () =>
        getAnalyticsOverviewData({
          businessId,
          startDate,
          endDate,
          compareStartDate,
          compareEndDate,
        }),
    );
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof ProviderRequestCooldownError) {
      return NextResponse.json(
        {
          error: "ga4_live_cooldown",
          message:
            "GA4 live refresh is temporarily suppressed after repeated Google failures. Serving fresh data will resume after cooldown.",
          retryAfterMs: err.retryAfterMs,
        },
        { status: 503 }
      );
    }
    if (await isDemoBusiness(businessId)) {
      throw err;
    }
    if (err instanceof GA4AuthError) {
      return NextResponse.json(
        {
          error: err.code,
          message: err.message,
          action: err.action,
          reconnectRequired: err.action === "reconnect_ga4",
        },
        { status: err.status }
      );
    }
    throw err;
  }
}
