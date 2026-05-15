import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoMetaBreakdowns, getDemoMetaCampaigns } from "@/lib/demo-business";
import { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { readMetaDecisionSnapshotForRange } from "@/lib/meta/snapshot";
import {
  buildMetaRecommendations,
  type MetaRecommendationAnalysisSource,
  type MetaRecommendationsResponse,
} from "@/lib/meta/recommendations";
import { readMetaBidRegimeHistorySummaries } from "@/lib/meta/config-snapshots";
import { buildMetaCreativeIntelligence } from "@/lib/meta/creative-intelligence";
import { getCreativeScoreSnapshot } from "@/lib/meta/creative-score-service";
import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { resolveRequestLanguage } from "@/lib/request-language";
import { META_WAREHOUSE_HISTORY_DAYS } from "@/lib/meta/history";
import { readMetaCommercialTargets } from "@/lib/meta/commercial-targets";

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

function emptyPersistentSnapshotPayload(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): MetaRecommendationsResponse {
  return {
    status: "ok",
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    summary: {
      title: "No persisted Meta recommendation snapshot",
      summary: "No daily Meta decision snapshot rows were found for the selected range.",
      primaryLens: "structure",
      confidence: "low",
      recommendationCount: 0,
    },
    recommendations: [],
    sourceModel: "snapshot_persistent",
    analysisSource: {
      system: "snapshot_persistent",
      decisionOsAvailable: false,
      fallbackReason: "meta_engine_v1_snapshot_empty",
    },
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const language = await resolveRequestLanguage(request);
  const businessId = searchParams.get("businessId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const live = searchParams.get("live") === "1";

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

  const demoBusiness = await isDemoBusiness(businessId);

  if (demoBusiness) {
    const demoCampaigns = getDemoMetaCampaigns().rows as MetaCampaignRow[];
    const demoBreakdowns = getDemoMetaBreakdowns() as MetaBreakdownsResponse;
    return NextResponse.json(
      attachAnalysisSource(
        buildMetaRecommendations({
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
        }),
        {
          businessId,
          startDate,
          endDate,
          sourceModel: "snapshot_live",
          analysisSource: {
            system: "demo",
            decisionOsAvailable: false,
          },
        },
      ),
    );
  }

  if (!live) {
    const snapshotPayload = await readMetaDecisionSnapshotForRange({
      businessId,
      startDate,
      endDate,
    });
    if (snapshotPayload) {
      return NextResponse.json(snapshotPayload);
    }
    return NextResponse.json(
      emptyPersistentSnapshotPayload({ businessId, startDate, endDate }),
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
    commercialTargets,
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
    readMetaCommercialTargets(businessId).catch(() => null),
  ]);

  const creativeIntelligence = buildMetaCreativeIntelligence({
    rows: creativeScoreSnapshot.selectedRows,
    historyById: creativeScoreSnapshot.historyById,
    campaigns: selectedCampaigns.rows ?? [],
  });

  const payload = attachAnalysisSource(
    buildMetaRecommendations({
      windows: {
        selected: selectedCampaigns.rows ?? [],
        previousSelected: previousSelectedCampaigns.rows ?? [],
        last3: last3Campaigns.rows ?? [],
        last7: last7Campaigns.rows ?? [],
        last14: last14Campaigns.rows ?? [],
        last30: last30Campaigns.rows ?? [],
        last90: last90Campaigns.rows ?? [],
        allHistory: allHistoryCampaigns.rows ?? [],
      },
      breakdowns,
      creativeIntelligence,
      historicalBidRegimes: Object.fromEntries(
        (
          await readMetaBidRegimeHistorySummaries({
            businessId,
            entityLevel: "campaign",
            entityIds: (selectedCampaigns.rows ?? []).map((row) => row.id),
          })
        ).entries()
      ),
      commercialTargets,
      language,
    }),
    {
      businessId,
      startDate,
      endDate,
      sourceModel: "snapshot_live",
      analysisSource: {
        system: "snapshot_live",
        decisionOsAvailable: false,
        fallbackReason: "meta_engine_v1_live_debug",
      },
    },
  );

  return NextResponse.json(payload);
}
