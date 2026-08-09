import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import {
  GA4AuthError,
  isGa4InvalidArgumentError,
} from "@/lib/google-analytics-reporting";
import {
  buildDemoLandingPagePerformanceResponse,
} from "@/lib/landing-pages/performance";
import { getGa4LandingPagePerformanceData } from "@/lib/ga4-user-facing-reports";
import { getCachedRouteReport } from "@/lib/route-report-cache";
import { runWithGoogleRequestAuditContext } from "@/lib/google-request-audit";
import { ProviderRequestCooldownError } from "@/lib/provider-request-governance";
import type { LandingPagePerformanceResponse } from "@/src/types/landing-pages";

const REPORT_TYPE = "ga4_landing_page_performance_v1";

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const startDate = request.nextUrl.searchParams.get("startDate") ?? "30daysAgo";
  const endDate = request.nextUrl.searchParams.get("endDate") ?? "yesterday";

  if (!businessId) {
    return NextResponse.json({ error: "missing_business_id" }, { status: 400 });
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  if (await isDemoBusiness(businessId)) {
    return NextResponse.json(buildDemoLandingPagePerformanceResponse());
  }

  const cached = await getCachedRouteReport<LandingPagePerformanceResponse>({
    businessId,
    provider: "ga4",
    reportType: REPORT_TYPE,
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
        requestPath: "/api/analytics/landing-page-performance",
        requestType: REPORT_TYPE,
      },
      () =>
        getGa4LandingPagePerformanceData({
          businessId,
          startDate,
          endDate,
        }),
    );
    // Stamped here, on the live retrieval, and not on the cache-hit path
    // above: the cached payload carries this value forward, so a response
    // served an hour later still reports when GA4 was actually read.
    return NextResponse.json({
      ...payload,
      meta: { ...payload.meta, retrievedAt: new Date().toISOString() },
    });
  } catch (error) {
    if (error instanceof ProviderRequestCooldownError) {
      return NextResponse.json(
        {
          error: "ga4_live_cooldown",
          message:
            "GA4 live refresh is temporarily suppressed after repeated Google failures. Please retry after cooldown.",
          retryAfterMs: error.retryAfterMs,
          action: "retry_later",
        },
        { status: 503 }
      );
    }
    if (error instanceof GA4AuthError) {
      return NextResponse.json(
        {
          error: error.code,
          message: error.message,
          action: error.action,
          reconnectRequired: error.action === "reconnect_ga4",
        },
        { status: error.status }
      );
    }
    const reason =
      isGa4InvalidArgumentError(error)
        ? "One or more GA4 metrics or dimensions are unavailable for this property."
        : error instanceof Error
          ? error.message
          : "Failed to load landing page performance.";

    return NextResponse.json(
      {
        error: "landing_page_performance_failed",
        message: reason,
        action: "retry_later",
      },
      { status: 502 }
    );
  }
}
