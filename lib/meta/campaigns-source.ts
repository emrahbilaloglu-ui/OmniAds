import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getDemoMetaCampaigns } from "@/lib/demo-business";
import { getIntegration } from "@/lib/integrations";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  getProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import { getMetaHistoricalVerificationReason } from "@/lib/meta/historical-verification";
import { getMetaLiveCampaignRows } from "@/lib/meta/live";
import {
  getMetaPartialReason,
  getMetaRangePreparationContext,
} from "@/lib/meta/readiness";
import { getMetaWarehouseCampaignTable } from "@/lib/meta/serving";
import { getMetaSelectedRangeTruthReadiness } from "@/lib/sync/meta-sync";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaEvidenceSource } from "@/lib/meta/operator-policy";
import {
  META_POSTURE_UNVERIFIED_REASON,
  readMetaBusinessDataPosture,
} from "@/lib/meta/business-data-posture";

export interface MetaCampaignsSourceResult {
  status?:
    | "ok"
    | "no_accounts_assigned"
    | "account_not_assigned"
    | "not_connected";
  rows: MetaCampaignRow[];
  isPartial?: boolean;
  notReadyReason?: string | null;
  evidenceSource: MetaEvidenceSource;
}

function toISODate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function nDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

async function fetchAssignedAccountIds(businessId: string): Promise<string[]> {
  try {
    const readiness = await getDbSchemaReadiness({
      tables: [...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES],
    });
    if (!readiness.ready) return [];
    const row = await getProviderAccountAssignments(businessId, "meta");
    return row?.account_ids ?? [];
  } catch {
    return [];
  }
}

export async function getMetaCampaignsForRange(input: {
  businessId: string;
  startDate?: string | null;
  endDate?: string | null;
  accountId?: string | null;
  campaignId?: string | null;
  campaignIds?: string[] | null;
  includePrev?: boolean;
  includePrevBudget?: boolean;
}): Promise<MetaCampaignsSourceResult> {
  /*
   * Tri-state posture, not a boolean.
   *
   * This branch used to be `if (await isDemoBusiness(...))`, which answers
   * `false` — live — for an unreadable flag, so a database that could not say
   * whether the workspace was real sent the request on to the live reader.
   * `unverified` now withholds instead.
   *
   * The demo branch is ALSO account-scoped now. It returned the fixture whole,
   * before the assignment intersection below ever ran, so a per-account
   * generation for the demo business got every account's campaigns pooled — the
   * exact defect the account narrowing exists to remove.
   */
  const posture = await readMetaBusinessDataPosture(input.businessId);
  if (posture === "unverified") {
    return {
      status: "not_connected",
      rows: [],
      isPartial: false,
      notReadyReason: META_POSTURE_UNVERIFIED_REASON,
      evidenceSource: "unknown",
    };
  }
  if (posture === "demo") {
    const demoRows = getDemoMetaCampaigns().rows as MetaCampaignRow[];
    const requestedAccountId =
      input.accountId && input.accountId !== "all" ? input.accountId : null;
    return {
      status: "ok",
      rows: requestedAccountId
        ? demoRows.filter((row) => row.accountId === requestedAccountId)
        : demoRows,
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "demo",
    };
  }

  const resolvedStart = input.startDate ?? toISODate(nDaysAgo(29));
  const resolvedEnd = input.endDate ?? toISODate(new Date());
  const assignedAccountIds = await fetchAssignedAccountIds(input.businessId);
  if (assignedAccountIds.length === 0) {
    return {
      status: "no_accounts_assigned",
      rows: [],
      isPartial: false,
      notReadyReason: "No Meta ad account is assigned to this workspace.",
      evidenceSource: "unknown",
    };
  }

  const targetAccountIds =
    input.accountId && input.accountId !== "all"
      ? assignedAccountIds.filter((accountId) => accountId === input.accountId)
      : assignedAccountIds;
  const requestedCampaignIds = Array.from(
    new Set(
      [input.campaignId, ...(input.campaignIds ?? [])].filter(
        Boolean,
      ) as string[],
    ),
  );
  const filterCampaignRows = (rows: MetaCampaignRow[]) => {
    if (requestedCampaignIds.length === 0) return rows;
    const requested = new Set(requestedCampaignIds);
    return rows.filter((row) => requested.has(row.id));
  };
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

  const integration = await getIntegration(input.businessId, "meta").catch(
    () => null,
  );
  const connected = integration?.status === "connected";
  const rangeContext = await getMetaRangePreparationContext({
    businessId: input.businessId,
    startDate: resolvedStart,
    endDate: resolvedEnd,
  });
  const effectiveEndDate =
    !rangeContext.isSelectedCurrentDay &&
    rangeContext.selectedRangeTruthEndDate &&
    resolvedStart <= rangeContext.selectedRangeTruthEndDate
      ? rangeContext.selectedRangeTruthEndDate
      : resolvedEnd;
  const historicalTruth =
    !rangeContext.isSelectedCurrentDay &&
    rangeContext.withinAuthoritativeHistory &&
    connected
      ? await getMetaSelectedRangeTruthReadiness({
          businessId: input.businessId,
          startDate: resolvedStart,
          endDate: effectiveEndDate,
        }).catch(() => null)
      : null;

  let rows: MetaCampaignRow[] = [];
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
      rows = await getMetaLiveCampaignRows({
        businessId: input.businessId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        providerAccountIds: targetAccountIds,
        includePrev: input.includePrev,
      });
      rows = filterCampaignRows(rows);
      return {
        status: "ok",
        rows,
        isPartial: false,
        notReadyReason: null,
        evidenceSource: "live",
      };
    }

    if (rangeContext.isSelectedCurrentDay) {
      if (!connected) {
        return {
          status: "not_connected",
          rows: [],
          isPartial: true,
          notReadyReason:
            "Meta integration is not connected. Current-day campaign data is only available from the live provider.",
          evidenceSource: "unknown",
        };
      }
      rows = await getMetaLiveCampaignRows({
        businessId: input.businessId,
        startDate: resolvedStart,
        endDate: resolvedEnd,
        providerAccountIds: targetAccountIds,
        includePrev: input.includePrev,
      });
      rows = filterCampaignRows(rows);
      return {
        status: "ok",
        rows,
        isPartial: rows.length === 0,
        notReadyReason:
          rows.length === 0
            ? getMetaPartialReason({
                isSelectedCurrentDay: true,
                currentDateInTimezone: rangeContext.currentDateInTimezone,
                primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                defaultReason:
                  "Current-day live Meta campaign data is still being prepared.",
              })
            : null,
        evidenceSource: rows.length > 0 ? "live" : "unknown",
      };
    }

    rows = (await getMetaWarehouseCampaignTable({
      businessId: input.businessId,
      startDate: resolvedStart,
      endDate: effectiveEndDate,
      providerAccountIds: targetAccountIds,
      campaignIds:
        requestedCampaignIds.length > 0 ? requestedCampaignIds : null,
      includePrev: input.includePrev,
      includePrevBudget: input.includePrevBudget,
    })) as MetaCampaignRow[];
    rows = filterCampaignRows(rows);
  } catch (error) {
    console.warn("[meta-campaigns] data_fetch_failed", {
      businessId: input.businessId,
      live: rangeContext.isSelectedCurrentDay,
      message: error instanceof Error ? error.message : String(error),
    });
    if (rangeContext.historicalReadMode === "historical_live_fallback") {
      return {
        status: connected ? "ok" : "not_connected",
        rows: [],
        isPartial: true,
        notReadyReason: connected
          ? "Historical live Meta campaign data is temporarily unavailable for the selected range."
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
                "Current-day live Meta campaign data is still being prepared.",
            })
          : "Meta integration is not connected. Current-day campaign data is only available from the live provider.",
        evidenceSource: "unknown",
      };
    }
    try {
      rows = (await getMetaWarehouseCampaignTable({
        businessId: input.businessId,
        startDate: resolvedStart,
        endDate: effectiveEndDate,
        providerAccountIds: targetAccountIds,
        campaignIds:
          requestedCampaignIds.length > 0 ? requestedCampaignIds : null,
        includePrev: input.includePrev,
        includePrevBudget: input.includePrevBudget,
      })) as MetaCampaignRow[];
      rows = filterCampaignRows(rows);
    } catch {
      rows = [];
    }
  }

  const warehouseUnavailableWithReadyTruth =
    rows.length === 0 && Boolean(historicalTruth?.truthReady);

  return {
    status: "ok",
    rows,
    isPartial: historicalTruth
      ? !historicalTruth.truthReady || rows.length === 0
      : rows.length === 0,
    notReadyReason: warehouseUnavailableWithReadyTruth
      ? "Campaign data is temporarily unavailable for the requested range."
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
                  "Campaign warehouse data is still being prepared for the requested range.",
              }),
            })
        : rows.length === 0
          ? connected
            ? getMetaPartialReason({
                isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
                currentDateInTimezone: rangeContext.currentDateInTimezone,
                primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                defaultReason:
                  "Campaign warehouse data is still being prepared for the requested range.",
              })
            : "Meta integration is not connected. Historical warehouse data will appear here once available."
          : null,
    evidenceSource:
      rows.length > 0 && (!historicalTruth || historicalTruth.truthReady)
        ? "live"
        : "unknown",
  };
}
