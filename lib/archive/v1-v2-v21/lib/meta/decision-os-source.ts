import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import {
  buildMetaDecisionOs,
  type MetaDecisionOsV1Response,
} from "@/lib/meta/decision-os";
import {
  getMetaDecisionSourceSnapshot,
  getMetaDecisionWindowContext,
} from "@/lib/meta/operator-decision-source";
import type { MetaEvidenceSource } from "@/lib/meta/operator-policy";

function normalizeGeoFreshnessState(
  value: string | null | undefined,
): "ready" | "syncing" | "stale" {
  if (value === "ready") return "ready";
  if (value === "stale" || value === "paused" || value === "action_required") {
    return "stale";
  }
  return "syncing";
}

function normalizeOptionalDecisionAsOf(value: string | null | undefined) {
  return value?.trim() || null;
}

function normalizeOptionalDateParam(value: string | null | undefined) {
  return value?.trim() || null;
}

function combineMetaEvidenceSource(
  sources: MetaEvidenceSource[],
): MetaEvidenceSource {
  if (sources.includes("unknown")) return "unknown";
  if (sources.includes("fallback")) return "fallback";
  if (sources.includes("snapshot")) return "snapshot";
  if (sources.includes("demo")) return "demo";
  if (sources.every((source) => source === "live")) return "live";
  return "unknown";
}

export async function getMetaDecisionOsForRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  analyticsStartDate?: string;
  analyticsEndDate?: string;
  decisionAsOf?: string | null;
}): Promise<MetaDecisionOsV1Response> {
  const analyticsStartDate =
    normalizeOptionalDateParam(input.analyticsStartDate) ?? input.startDate;
  const analyticsEndDate =
    normalizeOptionalDateParam(input.analyticsEndDate) ?? input.endDate;
  const [snapshot, decisionContext] = await Promise.all([
    getBusinessCommercialTruthSnapshot(input.businessId),
    getMetaDecisionWindowContext({
      businessId: input.businessId,
      startDate: analyticsStartDate,
      endDate: analyticsEndDate,
      decisionAsOf: normalizeOptionalDecisionAsOf(input.decisionAsOf),
    }),
  ]);
  const { campaigns, breakdowns, geoBreakdown, adSets } = await getMetaDecisionSourceSnapshot({
    businessId: input.businessId,
    decisionWindows: decisionContext.decisionWindows,
  });

  return buildMetaDecisionOs({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    analyticsStartDate,
    analyticsEndDate,
    analyticsWindow: decisionContext.analyticsWindow,
    decisionWindows: decisionContext.decisionWindows,
    historicalMemory: decisionContext.historicalMemory,
    decisionAsOf: decisionContext.decisionAsOf,
    evidenceSource: combineMetaEvidenceSource([
      campaigns.evidenceSource,
      adSets.evidenceSource,
    ]),
    campaigns: campaigns.rows ?? [],
    adSets: adSets.rows ?? [],
    geoSource: {
      rows: geoBreakdown?.rows ?? breakdowns.location ?? [],
      freshness: {
        dataState: normalizeGeoFreshnessState(geoBreakdown?.freshness?.dataState),
        lastSyncedAt: geoBreakdown?.freshness?.lastSyncedAt ?? null,
        isPartial: geoBreakdown?.isPartial ?? Boolean(breakdowns.isPartial),
        verificationState: geoBreakdown?.verification?.verificationState ?? null,
        reason: geoBreakdown?.notReadyReason ?? breakdowns.notReadyReason ?? null,
      },
    },
    breakdowns:
      breakdowns.location.length > 0 || breakdowns.placement.length > 0
        ? {
            location: breakdowns.location ?? [],
            placement: breakdowns.placement ?? [],
          }
        : null,
    commercialTruth: snapshot,
  });
}
