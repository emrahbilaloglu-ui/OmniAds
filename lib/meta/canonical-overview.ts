import { getIntegration } from "@/lib/integrations";
import { getMetaHistoricalVerificationReason } from "@/lib/meta/historical-verification";
import { getMetaLiveSummaryTotals } from "@/lib/meta/live";
import {
  getMetaPartialReason,
  getMetaRangePreparationContext,
} from "@/lib/meta/readiness";
import {
  getMetaWarehouseSummary,
  getMetaWarehouseTrends,
} from "@/lib/meta/serving";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { logRuntimeDebug } from "@/lib/runtime-logging";

export type MetaCanonicalOverviewSummary = Awaited<
  ReturnType<typeof getMetaWarehouseSummary>
> & {
  isPartial: boolean;
  notReadyReason?: string | null;
  readSource:
    | "warehouse_published"
    | "current_day_live"
    | "live_historical_fallback";
};

export type MetaCanonicalOverviewTrends = Awaited<
  ReturnType<typeof getMetaWarehouseTrends>
> & {
  isPartial: boolean;
  notReadyReason?: string | null;
  readSource: "warehouse_published";
};

export async function getMetaCanonicalOverviewSummary(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  /**
   * Narrow the summary to ONE assigned account.
   *
   * Omitted, this reads every assigned account, which is correct for the
   * workspace overview. Account Intelligence asks a different question — it
   * puts an account name in its header — and without this it had to withhold
   * the whole Summary section for any business holding more than one
   * account, because the alternative was pooling A+B under B's name.
   *
   * Fail-closed: an id that is not currently assigned narrows to NOTHING
   * rather than falling back to the full set, so a stale or guessed id can
   * never widen the answer.
   */
  providerAccountId?: string | null;
}): Promise<MetaCanonicalOverviewSummary> {
  const [assignment, rangeContext, integration] = await Promise.all([
    getProviderAccountAssignments(input.businessId, "meta").catch(() => null),
    getMetaRangePreparationContext(input),
    getIntegration(input.businessId, "meta").catch(() => null),
  ]);
  const assignedAccountIds = assignment?.account_ids ?? [];
  const requestedAccountId = input.providerAccountId?.trim() || null;
  const providerAccountIds = requestedAccountId
    ? assignedAccountIds.filter((id) => id === requestedAccountId)
    : assignedAccountIds;
  const effectiveEndDate =
    !rangeContext.isSelectedCurrentDay &&
    rangeContext.selectedRangeTruthEndDate &&
    input.startDate <= rangeContext.selectedRangeTruthEndDate
      ? rangeContext.selectedRangeTruthEndDate
      : input.endDate;
  const warehouseSummary = await getMetaWarehouseSummary({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: effectiveEndDate,
    providerAccountIds,
  });

  const connected = integration?.status === "connected";
  if (rangeContext.isSelectedCurrentDay && connected) {
    try {
      const liveTotals = await getMetaLiveSummaryTotals({
        ...input,
        providerAccountIds,
      });
      logRuntimeDebug("meta-canonical", "summary_read", {
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        readSource: "current_day_live",
        isPartial: liveTotals.spend <= 0 && liveTotals.impressions <= 0,
        accountCount: 0,
      });
      return {
        ...warehouseSummary,
        totals: liveTotals,
        accounts: [],
        isPartial: liveTotals.spend <= 0 && liveTotals.impressions <= 0,
        notReadyReason:
          liveTotals.spend <= 0 && liveTotals.impressions <= 0
            ? getMetaPartialReason({
                isSelectedCurrentDay: true,
                currentDateInTimezone: rangeContext.currentDateInTimezone,
                primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                defaultReason:
                  "Current-day live Meta totals are still being prepared.",
              })
            : null,
        readSource: "current_day_live",
      };
    } catch (error: unknown) {
      console.warn("[meta-canonical] live_totals_failed", {
        businessId: input.businessId,
        message: error instanceof Error ? error.message : String(error),
      });
      logRuntimeDebug("meta-canonical", "summary_read", {
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        readSource: "current_day_live",
        isPartial: true,
        accountCount: 0,
      });
      return {
        ...warehouseSummary,
        totals: {
          spend: 0,
          revenue: 0,
          conversions: 0,
          roas: 0,
          cpa: null,
          ctr: null,
          cpc: null,
          impressions: 0,
          clicks: 0,
          reach: 0,
        },
        accounts: [],
        isPartial: true,
        notReadyReason: getMetaPartialReason({
          isSelectedCurrentDay: true,
          currentDateInTimezone: rangeContext.currentDateInTimezone,
          primaryAccountTimezone: rangeContext.primaryAccountTimezone,
          defaultReason: "Current-day live Meta totals are still being prepared.",
        }),
        readSource: "current_day_live",
      };
    }
  }
  if (
    rangeContext.historicalReadMode === "historical_live_fallback" &&
    connected &&
    providerAccountIds.length > 0
  ) {
    try {
      const liveTotals = await getMetaLiveSummaryTotals({
        ...input,
        providerAccountIds,
      });
      logRuntimeDebug("meta-canonical", "summary_read", {
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        readSource: "live_historical_fallback",
        isPartial: false,
        accountCount: warehouseSummary.accounts.length,
      });
      return {
        ...warehouseSummary,
        totals: liveTotals,
        isPartial: false,
        notReadyReason: null,
        readSource: "live_historical_fallback",
      };
    } catch (error: unknown) {
      console.warn("[meta-canonical] live_historical_totals_failed", {
        businessId: input.businessId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result = {
    ...warehouseSummary,
    isPartial: Boolean(warehouseSummary.isPartial),
    notReadyReason:
      warehouseSummary.isPartial
      ? getMetaHistoricalVerificationReason({
          verificationState: warehouseSummary.verification?.verificationState ?? null,
          fallbackReason: getMetaPartialReason({
            isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
            currentDateInTimezone: rangeContext.currentDateInTimezone,
            primaryAccountTimezone: rangeContext.primaryAccountTimezone,
            defaultReason:
              "Warehouse data is still being prepared for the requested range.",
          }),
        })
        : null,
    readSource: "warehouse_published" as const,
  };
  logRuntimeDebug("meta-canonical", "summary_read", {
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: effectiveEndDate,
    readSource: result.readSource,
    isPartial: result.isPartial,
    accountCount: result.accounts.length,
  });
  return result;
}

export async function getMetaCanonicalOverviewTrends(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountId?: string | null;
}): Promise<MetaCanonicalOverviewTrends> {
  const assignment = await getProviderAccountAssignments(input.businessId, "meta").catch(
    () => null,
  );
  const assignedProviderAccountIds = assignment?.account_ids ?? [];
  const providerAccountIds = input.providerAccountId
    ? assignedProviderAccountIds.filter(
        (accountId) => accountId === input.providerAccountId,
      )
    : assignedProviderAccountIds;
  const [rangeContext, trends] = await Promise.all([
    getMetaRangePreparationContext(input),
    getMetaWarehouseTrends({
      ...input,
      providerAccountIds,
    }),
  ]);

  const result = {
    ...trends,
    isPartial: Boolean(trends.isPartial),
    notReadyReason: trends.isPartial
      ? getMetaPartialReason({
          isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
          currentDateInTimezone: rangeContext.currentDateInTimezone,
          primaryAccountTimezone: rangeContext.primaryAccountTimezone,
          defaultReason: "Trend data is still being prepared for the requested range.",
        })
      : null,
    readSource: "warehouse_published" as const,
  };
  logRuntimeDebug("meta-canonical", "trends_read", {
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    readSource: result.readSource,
    isPartial: result.isPartial,
    pointCount: result.points.length,
  });
  return result;
}
