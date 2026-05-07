import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoMetaBreakdowns, getDemoMetaCampaigns } from "@/lib/demo-business";
import { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import {
  buildMetaRecommendations,
  type MetaRecommendationAnalysisSource,
  type MetaRecommendationsResponse,
} from "@/lib/meta/recommendations";
import { buildMetaAdsetRecommendations } from "@/lib/meta/adset-decisions";
import { getMetaAdSetsForRange } from "@/lib/meta/adsets-source";
import { readMetaBidRegimeHistorySummaries } from "@/lib/meta/config-snapshots";
import { buildMetaCreativeIntelligence } from "@/lib/meta/creative-intelligence";
import { getCreativeScoreSnapshot } from "@/lib/meta/creative-score-service";
import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { resolveRequestLanguage } from "@/lib/request-language";
import { META_WAREHOUSE_HISTORY_DAYS } from "@/lib/meta/history";

// Intentional exception: recommendations keep snapshot-backed historical
// config regime analysis across multi-window history. This is not a normal
// campaign/adset historical UI serving path.

function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDaysToISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDiffInclusive(startDate: string, endDate: string): number {
  const start = parseISODate(startDate).getTime();
  const end = parseISODate(endDate).getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

function attachAnalysisSource(
  payload: MetaRecommendationsResponse,
  input: {
    businessId: string;
    startDate: string;
    endDate: string;
    analysisSource: MetaRecommendationAnalysisSource;
    sourceModel: MetaRecommendationsResponse["sourceModel"];
  },
): MetaRecommendationsResponse {
  return {
    ...payload,
    businessId: payload.businessId ?? input.businessId,
    startDate: payload.startDate ?? input.startDate,
    endDate: payload.endDate ?? input.endDate,
    sourceModel: payload.sourceModel ?? input.sourceModel,
    analysisSource: input.analysisSource,
  };
}

function appendAdsetRecommendations(
  payload: MetaRecommendationsResponse,
  adsetRecommendations: MetaRecommendationsResponse["recommendations"],
): MetaRecommendationsResponse {
  if (adsetRecommendations.length === 0) return payload;
  const recommendations = [...payload.recommendations, ...adsetRecommendations];
  return {
    ...payload,
    summary: {
      ...payload.summary,
      recommendationCount: recommendations.length,
    },
    recommendations,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const language = await resolveRequestLanguage(request);
  const businessId = searchParams.get("businessId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  if (!businessId || !startDate || !endDate) {
    return NextResponse.json(
      { error: "missing_params", message: "businessId, startDate and endDate are required." },
      { status: 400 }
    );
  }

  if (await isDemoBusiness(businessId)) {
    const demoCampaigns = getDemoMetaCampaigns().rows as MetaCampaignRow[];
    const demoBreakdowns = getDemoMetaBreakdowns() as MetaBreakdownsResponse;
    const demoCampaignIds = demoCampaigns.map((row) => row.id);
    const demoAdsets = await getMetaAdSetsForRange({
      businessId,
      campaignIds: demoCampaignIds,
      startDate,
      endDate,
      includePrev: true,
    }).catch(() => ({ rows: [] }));
    const basePayload = buildMetaRecommendations({
      windows: {
        selected: demoCampaigns,
        previousSelected: demoCampaigns,
        last3: demoCampaigns,
        last7: demoCampaigns,
        last14: demoCampaigns,
        last30: demoCampaigns,
        last90: demoCampaigns,
        allHistory: demoCampaigns,
      },
      breakdowns: demoBreakdowns,
      language,
    });
    const adsetRecommendations = buildMetaAdsetRecommendations({
      adsets: demoAdsets.rows,
      previousAdsets: [],
      selectedCampaigns: demoCampaigns,
      windows: {
        selected: demoCampaigns,
        previousSelected: demoCampaigns,
        last3: demoCampaigns,
        last7: demoCampaigns,
        last14: demoCampaigns,
        last30: demoCampaigns,
        last90: demoCampaigns,
        allHistory: demoCampaigns,
      },
      selectedRangeDays: dayDiffInclusive(startDate, endDate),
    });
    return NextResponse.json(
      attachAnalysisSource(
        appendAdsetRecommendations(basePayload, adsetRecommendations),
        {
          businessId,
          startDate,
          endDate,
          sourceModel: "snapshot_heuristics",
          analysisSource: {
            system: "demo",
            decisionOsAvailable: false,
          },
        },
      ),
    );
  }

  const selectedSpanDays = dayDiffInclusive(startDate, endDate);
  const previousEnd = addDaysToISO(startDate, -1);
  const previousStart = addDaysToISO(previousEnd, -(selectedSpanDays - 1));
  const last3Start = addDaysToISO(endDate, -2);
  const last7Start = addDaysToISO(endDate, -6);
  const last14Start = addDaysToISO(endDate, -13);
  const last30Start = addDaysToISO(endDate, -29);
  const last90Start = addDaysToISO(endDate, -89);
  const allHistoryStart = addDaysToISO(endDate, -(META_WAREHOUSE_HISTORY_DAYS - 1));

  const baseParams = new URLSearchParams({ businessId });

  const [
    selectedCampaigns,
    previousSelectedCampaigns,
    last3Campaigns,
    last7Campaigns,
    last14Campaigns,
    last30Campaigns,
    last90Campaigns,
    allHistoryCampaigns,
    breakdowns,
    creativeScoreSnapshot,
  ] = await Promise.all([
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      startDate,
      endDate,
      includePrev: true,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      startDate: previousStart,
      endDate: previousEnd,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      startDate: last3Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      startDate: last7Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      startDate: last14Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      startDate: last30Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      startDate: last90Start,
      endDate,
    }),
    getMetaCampaignsForRange({
      ...Object.fromEntries(baseParams),
      businessId,
      startDate: allHistoryStart,
      endDate,
    }),
    getMetaBreakdownsForRange({ businessId, startDate, endDate }),
    getCreativeScoreSnapshot({
      request,
      businessId,
      selectedStartDate: startDate,
      selectedEndDate: endDate,
    }),
  ]);

  const creativeIntelligence = buildMetaCreativeIntelligence({
    rows: creativeScoreSnapshot.selectedRows,
    historyById: creativeScoreSnapshot.historyById,
    campaigns: selectedCampaigns.rows ?? [],
  });

  const selectedCampaignRows = selectedCampaigns.rows ?? [];
  const windows = {
    selected: selectedCampaignRows,
    previousSelected: previousSelectedCampaigns.rows ?? [],
    last3: last3Campaigns.rows ?? [],
    last7: last7Campaigns.rows ?? [],
    last14: last14Campaigns.rows ?? [],
    last30: last30Campaigns.rows ?? [],
    last90: last90Campaigns.rows ?? [],
    allHistory: allHistoryCampaigns.rows ?? [],
  };
  const selectedCampaignIds = selectedCampaignRows.map((row) => row.id);
  const [selectedAdsets, previousSelectedAdsets] =
    selectedCampaignIds.length > 0
      ? await Promise.all([
          getMetaAdSetsForRange({
            businessId,
            campaignIds: selectedCampaignIds,
            startDate,
            endDate,
            includePrev: true,
          }).catch((error) => {
            console.warn("[meta-recommendations] selected_adsets_unavailable", {
              businessId,
              message: error instanceof Error ? error.message : String(error),
            });
            return { rows: [] };
          }),
          getMetaAdSetsForRange({
            businessId,
            campaignIds: selectedCampaignIds,
            startDate: previousStart,
            endDate: previousEnd,
          }).catch((error) => {
            console.warn("[meta-recommendations] previous_adsets_unavailable", {
              businessId,
              message: error instanceof Error ? error.message : String(error),
            });
            return { rows: [] };
          }),
        ])
      : [{ rows: [] }, { rows: [] }];

  const basePayload = buildMetaRecommendations({
    windows,
    breakdowns,
    creativeIntelligence,
    historicalBidRegimes: Object.fromEntries(
      (
        await readMetaBidRegimeHistorySummaries({
          businessId,
          entityLevel: "campaign",
          entityIds: selectedCampaignRows.map((row) => row.id),
        })
      ).entries()
    ),
    language,
  });
  const adsetRecommendations = buildMetaAdsetRecommendations({
    adsets: selectedAdsets.rows,
    previousAdsets: previousSelectedAdsets.rows,
    selectedCampaigns: selectedCampaignRows,
    windows,
    selectedRangeDays: selectedSpanDays,
  });
  const payload = attachAnalysisSource(
    appendAdsetRecommendations(basePayload, adsetRecommendations),
    {
      businessId,
      startDate,
      endDate,
      sourceModel: "snapshot_heuristics",
      analysisSource: {
        system: "snapshot_fallback",
        decisionOsAvailable: false,
        fallbackReason: "legacy_decision_os_archived_phase_4_1",
      },
    },
  );

  return NextResponse.json(payload);
}
