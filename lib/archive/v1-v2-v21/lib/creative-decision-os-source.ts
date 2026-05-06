import type { NextRequest } from "next/server";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import { buildAccountOperatingMode } from "@/lib/business-operating-mode";
import {
  getDemoMetaAdSets,
  getDemoMetaBreakdowns,
  getDemoMetaCampaigns,
  getDemoMetaCreatives,
  isDemoBusinessId,
} from "@/lib/demo-business";
import {
  buildCreativeDecisionOs,
  buildEmptyCreativeHistoricalAnalysis,
  type CreativeDecisionBenchmarkScopeInput,
  type CreativeDecisionOsHistoricalWindows,
  type CreativeDecisionOsInputRow,
  type CreativeDecisionOsV1Response,
} from "@/lib/creative-decision-os";
import { buildCreativeHistoricalAnalysis } from "@/lib/creative-historical-intelligence";
import {
  addDaysToIsoDate,
  META_CREATIVE_WAREHOUSE_HISTORY_DAYS,
} from "@/lib/meta/history";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import {
  getMetaDecisionSourceSnapshot,
  getMetaDecisionWindowContext,
} from "@/lib/meta/operator-decision-source";
import { mapApiRowToUiRow } from "@/app/(dashboard)/creatives/page-support";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { CreativeEvidenceSource } from "@/lib/creative-operator-policy";

export function resolveCreativeDecisionEvidenceSource(input: {
  primary: CreativeEvidenceSource;
  supporting?: CreativeEvidenceSource[];
  campaigns?: CreativeEvidenceSource;
  adSets?: CreativeEvidenceSource;
}): CreativeEvidenceSource {
  const { primary } = input;
  if (primary !== "live") return primary;

  // The primary 30d creative window is the decision-authority source. Supporting
  // windows and campaign/ad set snapshots can degrade benchmark or context
  // quality, but they should not erase live row authority on their own.
  return "live";
}

function mapMetaCreativesSnapshotSource(
  value: unknown,
): CreativeEvidenceSource {
  if (value === "live" || value === "refresh") return "live";
  if (value === "persisted") return "snapshot";
  return "unknown";
}

async function fetchCreativeRowsForWindow(input: {
  request: NextRequest;
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const payload = await getMetaCreativesApiPayload({
    request: input.request,
    requestStartedAt: Date.now(),
    businessId: input.businessId,
    mediaMode: "metadata",
    groupBy: "creative",
    format: "all",
    sort: "spend",
    start: input.startDate,
    end: input.endDate,
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: false,
    snapshotWarm: false,
    enableCopyRecovery: false,
    enableCreativeBasicsFallback: false,
    enableCreativeDetails: false,
    enableThumbnailBackfill: false,
    enableCardThumbnailBackfill: false,
    enableImageHashLookup: false,
    enableMediaRecovery: false,
    enableMediaCache: true,
    enableDeepAudit: false,
    perAccountSampleLimit: 10,
  });

  return {
    rows: ((payload.rows ?? []) as MetaCreativeApiRow[]).map(mapApiRowToUiRow),
    evidenceSource: mapMetaCreativesSnapshotSource(
      (payload as { snapshot_source?: unknown }).snapshot_source,
    ),
  };
}

function resolveCreativeDecisionTimeline(input: {
  startDate: string;
  endDate: string;
  analyticsStartDate?: string | null;
  analyticsEndDate?: string | null;
  decisionAsOf?: string | null;
}) {
  const normalizedAnalyticsStartDate = input.analyticsStartDate?.trim() || null;
  const normalizedAnalyticsEndDate = input.analyticsEndDate?.trim() || null;
  const reportingStartDate = input.startDate;
  const reportingEndDate = input.endDate;
  const analyticsStartDate = normalizedAnalyticsStartDate ?? reportingStartDate;
  const analyticsEndDate = normalizedAnalyticsEndDate ?? reportingEndDate;
  const decisionAsOf = input.decisionAsOf?.trim() || null;

  return {
    reportingStartDate,
    reportingEndDate,
    analyticsStartDate,
    analyticsEndDate,
    decisionAsOf,
  };
}

function toHistoricalWindow(row: MetaCreativeRow) {
  return {
    spend: row.spend,
    purchaseValue: row.purchaseValue,
    roas: row.roas,
    cpa: row.cpa,
    ctr: row.ctrAll,
    purchases: row.purchases,
    impressions: row.impressions,
    linkClicks: row.linkClicks,
    hookRate: row.thumbstop,
    holdRate: row.video100,
    video25Rate: row.video25,
    watchRate: row.video50,
    video75Rate: row.video75,
    clickToPurchaseRate: row.clickToPurchase,
    atcToPurchaseRate: row.atcToPurchaseRatio,
  };
}

function buildHistoryById(
  input: Partial<
    Record<keyof CreativeDecisionOsHistoricalWindows, MetaCreativeRow[]>
  >,
) {
  const map = new Map<string, CreativeDecisionOsHistoricalWindows>();
  for (const [windowKey, rows] of Object.entries(input) as Array<
    [keyof CreativeDecisionOsHistoricalWindows, MetaCreativeRow[] | undefined]
  >) {
    for (const row of rows ?? []) {
      const current = map.get(row.id) ?? {};
      current[windowKey] = toHistoricalWindow(row);
      map.set(row.id, current);
    }
  }
  return map;
}

function calculateCreativeAgeDays(launchDate: string) {
  const launchMs = Date.parse(`${launchDate}T00:00:00.000Z`);
  if (!Number.isFinite(launchMs)) return 0;
  const diffMs = Date.now() - launchMs;
  return Math.max(0, Math.round(diffMs / 86_400_000));
}

function toDecisionInputRow(
  row: MetaCreativeRow,
  history: CreativeDecisionOsHistoricalWindows | null,
): CreativeDecisionOsInputRow {
  const frequency = Number(
    (row as MetaCreativeRow & { frequency?: number }).frequency ?? 0,
  );
  const creativeAgeDays = calculateCreativeAgeDays(row.launchDate);

  return {
    creativeId: row.id,
    name: row.name,
    creativeFormat: row.format,
    previewUrl: row.previewUrl ?? null,
    imageUrl: row.imageUrl ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
    tableThumbnailUrl: row.tableThumbnailUrl ?? null,
    cardPreviewUrl: row.cardPreviewUrl ?? null,
    cachedThumbnailUrl: row.cachedThumbnailUrl ?? null,
    previewManifest: row.previewManifest ?? null,
    creativeAgeDays,
    spendVelocity: row.spend / Math.max(1, creativeAgeDays || 1),
    frequency,
    spend: row.spend,
    purchaseValue: row.purchaseValue,
    roas: row.roas,
    cpa: row.cpa,
    ctr: row.ctrAll,
    cpm: row.cpm,
    cpc: row.cpcLink,
    purchases: row.purchases,
    impressions: row.impressions,
    linkClicks: row.linkClicks,
    hookRate: row.thumbstop,
    holdRate: row.video100,
    video25Rate: row.video25,
    watchRate: row.video50,
    video75Rate: row.video75,
    clickToPurchaseRate: row.clickToPurchase,
    atcToPurchaseRate: row.atcToPurchaseRatio,
    copyText: row.copyText ?? null,
    copyVariants: row.copyVariants ?? [],
    headlineVariants: row.headlineVariants ?? [],
    descriptionVariants: row.descriptionVariants ?? [],
    objectStoryId: row.objectStoryId ?? null,
    effectiveObjectStoryId: row.effectiveObjectStoryId ?? null,
    postId: row.postId ?? null,
    accountId: row.accountId ?? null,
    accountName: row.accountName ?? null,
    campaignId: row.campaignId ?? null,
    campaignName: row.campaignName ?? null,
    adSetId: row.adSetId ?? null,
    adSetName: row.adSetName ?? null,
    taxonomyPrimaryLabel: row.creativePrimaryLabel ?? null,
    taxonomySecondaryLabel: row.creativeSecondaryLabel ?? null,
    taxonomyVisualFormat: row.creativeVisualFormat ?? null,
    aiTags: row.aiTags ?? {},
    historicalWindows: history,
  };
}

function buildDemoHistoryById(rows: MetaCreativeRow[]) {
  const map = new Map<string, CreativeDecisionOsHistoricalWindows>();

  rows.forEach((row, index) => {
    const strongBase = {
      spend: row.spend * 0.9,
      purchaseValue: row.purchaseValue * 1.12,
      roas: row.roas * 1.18,
      cpa: row.cpa * 0.84,
      ctr: row.ctrAll * 1.08,
      purchases: row.purchases + 2,
      impressions: row.impressions * 0.92,
      linkClicks: row.linkClicks * 0.96,
      hookRate: row.thumbstop * 1.08,
      holdRate: row.video100 * 1.04,
      video25Rate: row.video25 * 1.03,
      watchRate: row.video50 * 1.03,
      video75Rate: row.video75 * 1.03,
      clickToPurchaseRate: row.clickToPurchase * 1.08,
      atcToPurchaseRate: row.atcToPurchaseRatio * 1.05,
    };

    let history: CreativeDecisionOsHistoricalWindows = {
      last7: strongBase,
      last30: strongBase,
      last90: strongBase,
      allHistory: strongBase,
    };

    if (index === 2) {
      history = {
        last7: {
          ...strongBase,
          roas: row.roas * 1.35,
          ctr: row.ctrAll * 1.2,
          clickToPurchaseRate: row.clickToPurchase * 1.22,
        },
        last30: {
          ...strongBase,
          roas: row.roas * 1.4,
          ctr: row.ctrAll * 1.26,
          clickToPurchaseRate: row.clickToPurchase * 1.28,
        },
        last90: {
          ...strongBase,
          roas: row.roas * 1.32,
        },
        allHistory: {
          ...strongBase,
          roas: row.roas * 1.3,
        },
      };
    } else if (index === 4) {
      history = {};
    } else if (index === 5) {
      history = {
        last30: {
          ...strongBase,
          roas: row.roas * 2.1,
          ctr: row.ctrAll * 1.45,
          clickToPurchaseRate: row.clickToPurchase * 1.9,
          purchases: row.purchases + 9,
        },
        last90: {
          ...strongBase,
          roas: row.roas * 2.0,
          purchases: row.purchases + 12,
        },
        allHistory: {
          ...strongBase,
          roas: row.roas * 1.92,
          purchases: row.purchases + 14,
        },
      };
    } else if (index === 6) {
      history = {
        last30: {
          ...strongBase,
          roas: row.roas * 0.86,
          ctr: row.ctrAll * 0.9,
        },
      };
    }

    map.set(row.id, history);
  });

  return map;
}

export async function getCreativeDecisionOsForRange(input: {
  request: NextRequest;
  businessId: string;
  startDate: string;
  endDate: string;
  analyticsStartDate?: string | null;
  analyticsEndDate?: string | null;
  decisionAsOf?: string | null;
  benchmarkScope?: CreativeDecisionBenchmarkScopeInput | null;
}): Promise<CreativeDecisionOsV1Response> {
  const timeline = resolveCreativeDecisionTimeline({
    startDate: input.startDate,
    endDate: input.endDate,
    analyticsStartDate: input.analyticsStartDate,
    analyticsEndDate: input.analyticsEndDate,
    decisionAsOf: input.decisionAsOf,
  });
  const decisionContext = await getMetaDecisionWindowContext({
    businessId: input.businessId,
    startDate: timeline.analyticsStartDate,
    endDate: timeline.analyticsEndDate,
    decisionAsOf: timeline.decisionAsOf,
  });
  let decisionRows: MetaCreativeRow[] = [];
  let selectedPeriodRows: MetaCreativeRow[] | null = null;
  let evidenceSource: CreativeEvidenceSource = "unknown";
  let historyById = new Map<string, CreativeDecisionOsHistoricalWindows>();
  let campaigns: Awaited<
    ReturnType<typeof getMetaDecisionSourceSnapshot>
  >["campaigns"]["rows"] = [];
  let adSets: Awaited<
    ReturnType<typeof getMetaDecisionSourceSnapshot>
  >["adSets"]["rows"] = [];
  let breakdowns: Awaited<
    ReturnType<typeof getMetaDecisionSourceSnapshot>
  >["breakdowns"] = {
    age: [],
    location: [],
    placement: [],
    budget: { campaign: [], adset: [] },
    audience: { available: false },
    products: { available: false },
  };

  if (isDemoBusinessId(input.businessId)) {
    decisionRows = (
      getDemoMetaCreatives().rows as unknown as MetaCreativeApiRow[]
    ).map(mapApiRowToUiRow);
    selectedPeriodRows = decisionRows;
    evidenceSource = "demo";
    historyById = buildDemoHistoryById(decisionRows);
    campaigns = getDemoMetaCampaigns().rows as Awaited<
      ReturnType<typeof getMetaDecisionSourceSnapshot>
    >["campaigns"]["rows"];
    adSets = getDemoMetaAdSets();
    breakdowns = getDemoMetaBreakdowns() as Awaited<
      ReturnType<typeof getMetaDecisionSourceSnapshot>
    >["breakdowns"];
  } else {
    const primaryWindow = decisionContext.decisionWindows.primary30d;
    const windowDefs = {
      last3: {
        startDate: addDaysToIsoDate(decisionContext.decisionAsOf, -2),
        endDate: decisionContext.decisionAsOf,
      },
      last7: {
        startDate: addDaysToIsoDate(decisionContext.decisionAsOf, -6),
        endDate: decisionContext.decisionAsOf,
      },
      last14: {
        startDate: addDaysToIsoDate(decisionContext.decisionAsOf, -13),
        endDate: decisionContext.decisionAsOf,
      },
      last30: {
        startDate: primaryWindow.startDate,
        endDate: primaryWindow.endDate,
      },
      last90: {
        startDate: addDaysToIsoDate(decisionContext.decisionAsOf, -89),
        endDate: decisionContext.decisionAsOf,
      },
      allHistory: {
        startDate: addDaysToIsoDate(
          decisionContext.decisionAsOf,
          -(META_CREATIVE_WAREHOUSE_HISTORY_DAYS - 1),
        ),
        endDate: decisionContext.decisionAsOf,
      },
    } satisfies Record<
      keyof CreativeDecisionOsHistoricalWindows,
      { startDate: string; endDate: string }
    >;

    const [primary, last3, last7, last14, last90, allHistory, selectedPeriod] =
      await Promise.all([
        fetchCreativeRowsForWindow({
          request: input.request,
          businessId: input.businessId,
          startDate: primaryWindow.startDate,
          endDate: primaryWindow.endDate,
        }),
        fetchCreativeRowsForWindow({
          request: input.request,
          businessId: input.businessId,
          ...windowDefs.last3,
        }),
        fetchCreativeRowsForWindow({
          request: input.request,
          businessId: input.businessId,
          ...windowDefs.last7,
        }),
        fetchCreativeRowsForWindow({
          request: input.request,
          businessId: input.businessId,
          ...windowDefs.last14,
        }),
        fetchCreativeRowsForWindow({
          request: input.request,
          businessId: input.businessId,
          ...windowDefs.last90,
        }),
        fetchCreativeRowsForWindow({
          request: input.request,
          businessId: input.businessId,
          ...windowDefs.allHistory,
        }),
        fetchCreativeRowsForWindow({
          request: input.request,
          businessId: input.businessId,
          startDate: timeline.reportingStartDate,
          endDate: timeline.reportingEndDate,
        }).catch(() => null),
      ]);
    const decisionSnapshot = await getMetaDecisionSourceSnapshot({
      businessId: input.businessId,
      decisionWindows: decisionContext.decisionWindows,
      campaignIds: Array.from(
        new Set(
          primary.rows.map((row) => row.campaignId).filter(Boolean) as string[],
        ),
      ),
    });
    const last30 = primary;

    decisionRows = primary.rows;
    selectedPeriodRows = selectedPeriod?.rows ?? null;
    evidenceSource = resolveCreativeDecisionEvidenceSource({
      primary: primary.evidenceSource,
      supporting: [
        last3.evidenceSource,
        last7.evidenceSource,
        last14.evidenceSource,
        last30.evidenceSource,
        last90.evidenceSource,
        allHistory.evidenceSource,
      ],
      campaigns: decisionSnapshot.campaigns.evidenceSource,
      adSets: decisionSnapshot.adSets.evidenceSource,
    });
    historyById = buildHistoryById({
      last3: last3.rows,
      last7: last7.rows,
      last14: last14.rows,
      last30: last30.rows,
      last90: last90.rows,
      allHistory: allHistory.rows,
    });
    campaigns = decisionSnapshot.campaigns.rows ?? [];
    adSets = decisionSnapshot.adSets.rows ?? [];
    breakdowns = decisionSnapshot.breakdowns;
  }

  const snapshot = await getBusinessCommercialTruthSnapshot(input.businessId);
  const operatingMode = buildAccountOperatingMode({
    businessId: input.businessId,
    startDate: timeline.analyticsStartDate,
    endDate: timeline.analyticsEndDate,
    analyticsWindow: decisionContext.analyticsWindow,
    decisionWindows: decisionContext.decisionWindows,
    historicalMemory: decisionContext.historicalMemory,
    decisionAsOf: decisionContext.decisionAsOf,
    snapshot,
    campaigns: { rows: campaigns },
    breakdowns,
  });

  const historicalAnalysis =
    selectedPeriodRows && selectedPeriodRows.length > 0
      ? buildCreativeHistoricalAnalysis({
          startDate: timeline.reportingStartDate,
          endDate: timeline.reportingEndDate,
          rows: selectedPeriodRows.map((row) => toDecisionInputRow(row, null)),
        })
      : buildEmptyCreativeHistoricalAnalysis({
          startDate: timeline.reportingStartDate,
          endDate: timeline.reportingEndDate,
        });

  return {
    ...buildCreativeDecisionOs({
      businessId: input.businessId,
      startDate: timeline.reportingStartDate,
      endDate: timeline.reportingEndDate,
      analyticsWindow: decisionContext.analyticsWindow,
      decisionWindows: decisionContext.decisionWindows,
      historicalMemory: decisionContext.historicalMemory,
      decisionAsOf: decisionContext.decisionAsOf,
      evidenceSource,
      rows: decisionRows.map((row) =>
        toDecisionInputRow(row, historyById.get(row.id) ?? null),
      ),
      campaigns,
      adSets,
      breakdowns: {
        location: breakdowns.location ?? [],
      },
      commercialTruth: snapshot,
      operatingMode,
      benchmarkScope: input.benchmarkScope ?? null,
    }),
    historicalAnalysis,
  };
}
