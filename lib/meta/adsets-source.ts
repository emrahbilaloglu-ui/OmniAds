import { isDemoBusiness } from "@/lib/business-mode.server";
import { getIntegration } from "@/lib/integrations";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { getMetaHistoricalVerificationReason } from "@/lib/meta/historical-verification";
import {
  getMetaPartialReason,
  getMetaRangePreparationContext,
} from "@/lib/meta/readiness";
import { getMetaWarehouseAdSets } from "@/lib/meta/serving";
import { getMetaLiveAdSets } from "@/lib/meta/live";
import { getMetaSelectedRangeTruthReadiness } from "@/lib/sync/meta-sync";
import type { MetaAdSetData } from "@/lib/api/meta";
import { getDemoMetaAdSets } from "@/lib/demo-business";
import type { MetaEvidenceSource } from "@/lib/meta/operator-policy";

export interface MetaAdSetsSourceResult {
  status?:
    | "ok"
    | "no_accounts_assigned"
    | "account_not_assigned"
    | "not_connected";
  rows: MetaAdSetData[];
  isPartial?: boolean;
  notReadyReason?: string | null;
  evidenceSource: MetaEvidenceSource;
}

export async function getMetaAdSetsForRange(input: {
  businessId: string;
  accountId?: string | null;
  campaignId?: string | null;
  campaignIds?: string[] | null;
  startDate?: string | null;
  endDate?: string | null;
  includePrev?: boolean;
  includePrevBudget?: boolean;
}): Promise<MetaAdSetsSourceResult> {
  const resolvedStart =
    input.startDate ??
    new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const resolvedEnd = input.endDate ?? new Date().toISOString().slice(0, 10);
  const requestedCampaignIds = Array.from(
    new Set(
      [input.campaignId, ...(input.campaignIds ?? [])].filter(
        Boolean,
      ) as string[],
    ),
  );
  let targetAccountIds: string[] | null = null;
  const filterAdSetRows = (rows: MetaAdSetData[]) => {
    const accountScopedRows = targetAccountIds
      ? rows.filter(
          (row) =>
            typeof row.accountId === "string" &&
            targetAccountIds!.includes(row.accountId),
        )
      : rows;
    if (requestedCampaignIds.length === 0) return accountScopedRows;
    const requested = new Set(requestedCampaignIds);
    return accountScopedRows.filter((row) => requested.has(row.campaignId));
  };

  if (await isDemoBusiness(input.businessId)) {
    return {
      status: "ok",
      rows: filterAdSetRows(
        requestedCampaignIds.length === 1
          ? getDemoMetaAdSets(requestedCampaignIds[0])
          : getDemoMetaAdSets(null),
      ),
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "demo",
    };
  }

  const integration = await getIntegration(input.businessId, "meta").catch(
    () => null,
  );
  const connected = integration?.status === "connected";
  const assignment = await getProviderAccountAssignments(
    input.businessId,
    "meta",
  ).catch(() => null);
  const providerAccountIds = assignment?.account_ids ?? [];
  if (providerAccountIds.length === 0) {
    return {
      status: "no_accounts_assigned",
      rows: [],
      isPartial: false,
      notReadyReason: "No Meta ad account is assigned to this workspace.",
      evidenceSource: "unknown",
    };
  }
  targetAccountIds =
    input.accountId && input.accountId !== "all"
      ? providerAccountIds.filter((accountId) => accountId === input.accountId)
      : providerAccountIds;
  if (targetAccountIds.length === 0) {
    return {
      status: "account_not_assigned",
      rows: [],
      isPartial: false,
      notReadyReason:
        "The requested Meta ad account is not assigned to this workspace.",
      evidenceSource: "unknown",
    };
  }
  const rangeContext = await getMetaRangePreparationContext({
    businessId: input.businessId,
    startDate: resolvedStart,
    endDate: resolvedEnd,
  });
  const historicalTruth =
    !rangeContext.isSelectedCurrentDay &&
    rangeContext.withinAuthoritativeHistory &&
    connected
      ? await getMetaSelectedRangeTruthReadiness({
          businessId: input.businessId,
          startDate: resolvedStart,
          endDate: resolvedEnd,
        }).catch(() => null)
      : null;

  try {
    if (rangeContext.historicalReadMode === "historical_live_fallback") {
      if (!connected) {
        return {
          status: "not_connected",
          rows: [],
          isPartial: true,
          notReadyReason:
            "Meta integration is not connected. Historical live fallback is unavailable.",
          evidenceSource: "unknown",
        };
      }
      const liveRows = await getMetaLiveAdSets({
        businessId: input.businessId,
        campaignId:
          requestedCampaignIds.length === 1 ? requestedCampaignIds[0] : null,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        includePrev: input.includePrev,
        providerAccountIds: targetAccountIds,
      });
      const filteredLiveRows = filterAdSetRows(liveRows);
      return {
        status: "ok",
        rows: filteredLiveRows,
        isPartial: false,
        notReadyReason: null,
        evidenceSource: filteredLiveRows.length > 0 ? "live" : "unknown",
      };
    }

    if (rangeContext.isSelectedCurrentDay) {
      if (!connected) {
        return {
          status: "not_connected",
          rows: [],
          isPartial: true,
          notReadyReason:
            "Meta integration is not connected. Current-day ad set data is only available from the live provider.",
          evidenceSource: "unknown",
        };
      }
      const liveRows = await getMetaLiveAdSets({
        businessId: input.businessId,
        campaignId:
          requestedCampaignIds.length === 1 ? requestedCampaignIds[0] : null,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        includePrev: input.includePrev,
        providerAccountIds: targetAccountIds,
      });
      const filteredLiveRows = filterAdSetRows(liveRows);
      return {
        status: "ok",
        rows: filteredLiveRows,
        isPartial: filteredLiveRows.length === 0,
        notReadyReason:
          filteredLiveRows.length === 0
            ? getMetaPartialReason({
                isSelectedCurrentDay: true,
                currentDateInTimezone: rangeContext.currentDateInTimezone,
                primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                defaultReason:
                  "Current-day live Meta ad set data is still being prepared.",
              })
            : null,
        evidenceSource: liveRows.length > 0 ? "live" : "unknown",
      };
    }

    const warehouseRows = await getMetaWarehouseAdSets({
      businessId: input.businessId,
      startDate: resolvedStart,
      endDate: resolvedEnd,
      campaignId:
        requestedCampaignIds.length === 1 ? requestedCampaignIds[0] : null,
      campaignIds:
        requestedCampaignIds.length > 0 ? requestedCampaignIds : null,
      providerAccountIds: targetAccountIds,
      includePrev: input.includePrev,
      includePrevBudget: input.includePrevBudget,
    });
    const filteredWarehouseRows = filterAdSetRows(warehouseRows);
    if (filteredWarehouseRows.length > 0) {
      return {
        status: "ok",
        rows: filteredWarehouseRows,
        isPartial: historicalTruth ? !historicalTruth.truthReady : false,
        notReadyReason:
          historicalTruth && !historicalTruth.truthReady
            ? getMetaHistoricalVerificationReason({
                verificationState:
                  historicalTruth.verificationState ??
                  historicalTruth.state ??
                  null,
                fallbackReason:
                  "Ad set warehouse data is still being prepared for the requested range.",
              })
            : null,
        evidenceSource:
          !historicalTruth || historicalTruth.truthReady ? "live" : "unknown",
      };
    }
  } catch (error) {
    console.warn("[meta-adsets] data_fetch_failed", {
      businessId: input.businessId,
      campaignId: input.campaignId ?? null,
      live: rangeContext.isSelectedCurrentDay,
      message: error instanceof Error ? error.message : String(error),
    });
    if (rangeContext.historicalReadMode === "historical_live_fallback") {
      return {
        status: connected ? "ok" : "not_connected",
        rows: [],
        isPartial: true,
        notReadyReason: connected
          ? "Historical live Meta ad set data is temporarily unavailable for the selected range."
          : "Meta integration is not connected. Historical live fallback is unavailable.",
        evidenceSource: "unknown",
      };
    }
    if (rangeContext.isSelectedCurrentDay) {
      return {
        status: connected ? "ok" : "not_connected",
        rows: [],
        isPartial: true,
        notReadyReason: connected
          ? getMetaPartialReason({
              isSelectedCurrentDay: true,
              currentDateInTimezone: rangeContext.currentDateInTimezone,
              primaryAccountTimezone: rangeContext.primaryAccountTimezone,
              defaultReason:
                "Current-day live Meta ad set data is still being prepared.",
            })
          : "Meta integration is not connected. Current-day ad set data is only available from the live provider.",
        evidenceSource: "unknown",
      };
    }
    try {
      const warehouseRows = await getMetaWarehouseAdSets({
        businessId: input.businessId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        campaignId:
          requestedCampaignIds.length === 1 ? requestedCampaignIds[0] : null,
        campaignIds:
          requestedCampaignIds.length > 0 ? requestedCampaignIds : null,
        providerAccountIds: targetAccountIds,
        includePrev: input.includePrev,
        includePrevBudget: input.includePrevBudget,
      });
      const filteredWarehouseRows = filterAdSetRows(warehouseRows);
      if (filteredWarehouseRows.length > 0) {
        return {
          status: "ok",
          rows: filteredWarehouseRows,
          isPartial: historicalTruth ? !historicalTruth.truthReady : false,
          notReadyReason:
            historicalTruth && !historicalTruth.truthReady
              ? getMetaHistoricalVerificationReason({
                  verificationState:
                    historicalTruth.verificationState ??
                    historicalTruth.state ??
                    null,
                  fallbackReason:
                    "Ad set warehouse data is still being prepared for the requested range.",
                })
              : null,
          evidenceSource:
            !historicalTruth || historicalTruth.truthReady ? "live" : "unknown",
        };
      }
    } catch {
      // Fall through to the partial payload below.
    }
  }

  const warehouseUnavailableWithReadyTruth =
    historicalTruth?.truthReady === true;

  return {
    status: "ok",
    rows: [],
    isPartial: historicalTruth
      ? !historicalTruth.truthReady || warehouseUnavailableWithReadyTruth
      : true,
    notReadyReason: warehouseUnavailableWithReadyTruth
      ? "Ad set data is temporarily unavailable for the requested range."
      : historicalTruth
        ? historicalTruth.truthReady
          ? null
          : getMetaHistoricalVerificationReason({
              verificationState:
                historicalTruth.verificationState ??
                historicalTruth.state ??
                null,
              fallbackReason: getMetaPartialReason({
                isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
                currentDateInTimezone: rangeContext.currentDateInTimezone,
                primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                defaultReason:
                  "Ad set warehouse data is still being prepared for the requested range.",
              }),
            })
        : connected
          ? getMetaPartialReason({
              isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
              currentDateInTimezone: rangeContext.currentDateInTimezone,
              primaryAccountTimezone: rangeContext.primaryAccountTimezone,
              defaultReason:
                "Ad set warehouse data is still being prepared for the requested range.",
            })
          : "Meta integration is not connected. Historical warehouse data will appear here once available.",
    evidenceSource: "unknown",
  };
}
