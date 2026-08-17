import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoGoogleAdsAdvisor } from "@/lib/demo-business";
import { buildActionClusters } from "@/lib/google-ads/action-clusters";
import { hydrateAdvisorRecommendationsFromMemory } from "@/lib/google-ads/advisor-memory";
import { getOrCreateGoogleAdsAdvisorSnapshot } from "@/lib/google-ads/advisor-snapshots";
import { isGoogleAdsDecisionEngineV2Enabled } from "@/lib/google-ads/decision-engine-config";
import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";
import { parseGoogleAdsRequestParams } from "@/lib/google-ads-request-params";
import {
  buildGoogleAdsSelectedRangeContext,
  getGoogleAdsAdvisorReport,
  getGoogleAdsCampaignsReport,
} from "@/lib/google-ads/serving";
import {
  googleAdsReadAccountAuthorityFailure,
  resolveGoogleAdsReadAccountAuthority,
} from "@/lib/google-ads/account-authority";

export async function GET(request: NextRequest) {
  const { businessId, accountId, dateRange, customStart, customEnd, debug } = parseGoogleAdsRequestParams(
    request.nextUrl.searchParams
  );

  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 });
  }

  const access = await requireBusinessAccess({ request, businessId, minRole: "guest" });
  if ("error" in access) return access.error;

  if (!isGoogleAdsDecisionEngineV2Enabled()) {
    return NextResponse.json(
      { error: "Google Ads Decision Engine V2 is disabled." },
      { status: 503 }
    );
  }

  if (await isDemoBusiness(businessId)) {
    return NextResponse.json(getDemoGoogleAdsAdvisor());
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

  const payload = debug
    ? await getGoogleAdsAdvisorReport({
        businessId,
        accountId,
        dateRange,
        customStart,
        customEnd,
        debug,
      })
    : (
        await getOrCreateGoogleAdsAdvisorSnapshot({
          businessId,
          accountId,
          forceRefresh: request.nextUrl.searchParams.get("refresh") === "1",
        })
      ).advisorPayload;

  const hydratedRecommendations = await hydrateAdvisorRecommendationsFromMemory({
    businessId,
    accountId: accountId ?? "all",
    recommendations: payload.recommendations as GoogleRecommendation[],
  });
  const activeRecommendations = hydratedRecommendations.filter(
    (recommendation) =>
      recommendation.currentStatus !== "suppressed" &&
      recommendation.userAction !== "dismissed",
  );
  const recommendationsById = new Map(
    activeRecommendations.map((recommendation) => [recommendation.id, recommendation] as const)
  );
  payload.recommendations = activeRecommendations;
  payload.sections = payload.sections.map((section) => ({
    ...section,
    recommendations: section.recommendations
      .map((recommendation) => recommendationsById.get(recommendation.id) ?? null)
      .filter((recommendation): recommendation is GoogleRecommendation => recommendation !== null),
  }));
  payload.clusters = buildActionClusters({
    recommendations: activeRecommendations as GoogleRecommendation[],
  });
  payload.summary.watchouts = activeRecommendations
    .filter(
      (recommendation) =>
        recommendation.doBucket === "do_later" ||
        recommendation.decisionState === "watch" ||
        recommendation.integrityState === "blocked" ||
        recommendation.currentStatus === "escalated"
    )
    .slice(0, 3)
    .map((recommendation) => recommendation.title);

  if (!debug && payload.metadata && customStart && customEnd) {
    const selectedCampaigns = await getGoogleAdsCampaignsReport({
      businessId,
      accountId,
      dateRange,
      customStart,
      customEnd,
      compareMode: "none",
    }).catch(() => null);

    const selectedTotals = selectedCampaigns
      ? {
          spend: selectedCampaigns.rows.reduce((sum, row) => sum + Number(row.spend ?? 0), 0),
          revenue: selectedCampaigns.rows.reduce((sum, row) => sum + Number(row.revenue ?? 0), 0),
          conversions: selectedCampaigns.rows.reduce((sum, row) => sum + Number(row.conversions ?? 0), 0),
          roas:
            selectedCampaigns.rows.reduce((sum, row) => sum + Number(row.spend ?? 0), 0) > 0
              ? Number(
                  (
                    selectedCampaigns.rows.reduce((sum, row) => sum + Number(row.revenue ?? 0), 0) /
                    selectedCampaigns.rows.reduce((sum, row) => sum + Number(row.spend ?? 0), 0)
                  ).toFixed(2)
                )
              : 0,
        }
      : null;

    payload.metadata.selectedRangeContext =
      selectedTotals &&
      payload.metadata.asOfDate &&
      (payload.metadata.decisionSummaryTotals || payload.metadata.canonicalWindowTotals)
        ? buildGoogleAdsSelectedRangeContext({
            canonicalAsOfDate: payload.metadata.asOfDate,
            canonicalTotals:
              payload.metadata.canonicalWindowTotals ??
              (payload.metadata.decisionSummaryTotals
                ? {
                    spend: payload.metadata.decisionSummaryTotals.spend,
                    revenue: payload.metadata.decisionSummaryTotals.revenue,
                    conversions: payload.metadata.decisionSummaryTotals.conversions,
                    roas: payload.metadata.decisionSummaryTotals.roas,
                  }
                : null),
            selectedRangeStart: customStart,
            selectedRangeEnd: customEnd,
            selectedTotals,
          })
        : {
            eligible: false,
            state: "hidden",
            label: "",
            summary: "",
            selectedRangeStart: customStart,
            selectedRangeEnd: customEnd,
            deltaPercent: null,
            metricKey: null,
          };
  }

  return NextResponse.json(payload);
}
