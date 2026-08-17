import { NextRequest, NextResponse } from "next/server";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { requireBusinessAccess } from "@/lib/access";
import { getDemoGoogleAdsOverview } from "@/lib/demo-business";
import { getGoogleAdsOverviewReport } from "@/lib/google-ads/serving";
import { parseGoogleAdsRequestParams } from "@/lib/google-ads-request-params";
import { logPerfEvent } from "@/lib/perf";
import {
  googleAdsReadAccountAuthorityFailure,
  resolveGoogleAdsReadAccountAuthority,
} from "@/lib/google-ads/account-authority";

function getDateSpanDays(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return null;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function getReadSource(meta: unknown) {
  if (!meta || typeof meta !== "object") return "unknown";
  const candidate = meta as { readSource?: unknown; source?: unknown };
  if (typeof candidate.readSource === "string") return candidate.readSource;
  if (typeof candidate.source === "string") return candidate.source;
  return "unknown";
}

export async function GET(request: NextRequest) {
  const requestStartedAt = Date.now();
  const {
    businessId,
    accountId,
    dateRange,
    customStart,
    customEnd,
    compareMode,
    compareStart,
    compareEnd,
    debug,
  } = parseGoogleAdsRequestParams(request.nextUrl.searchParams);

  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  if (await isDemoBusiness(businessId)) {
    return NextResponse.json(getDemoGoogleAdsOverview());
  }

  if (accountId && accountId !== "all") {
    const refusal = googleAdsReadAccountAuthorityFailure(
      await resolveGoogleAdsReadAccountAuthority(businessId, accountId),
    );
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, code: refusal.code },
        { status: refusal.httpStatus },
      );
    }
  }

  const report = await getGoogleAdsOverviewReport({
    businessId,
    accountId,
    dateRange,
    customStart,
    customEnd,
    compareMode,
    compareStart,
    compareEnd,
    debug,
    source: "google_ads_workspace_overview_route",
  });

  const payload = {
    kpis: report.kpis,
    kpiDeltas: report.kpiDeltas,
    topCampaigns: report.topCampaigns,
    insights: report.insights,
    summary: report.summary,
    meta: report.meta,
  };
  logPerfEvent("google_ads_overview_route", {
    businessId,
    accountId,
    dateRange,
    customStart,
    customEnd,
    dateSpanDays: getDateSpanDays(customStart, customEnd),
    compareMode,
    rowCount: payload.topCampaigns.length,
    topCampaignCount: payload.topCampaigns.length,
    readSource: getReadSource(report.meta),
    durationMs: Date.now() - requestStartedAt,
  });
  return NextResponse.json(payload);
}
