import {
  META_POSTURE_UNVERIFIED_REASON,
  readMetaBusinessDataPosture,
} from "@/lib/meta/business-data-posture";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getDemoMetaBreakdowns, getDemoMetaStatus } from "@/lib/demo-business";
import { getIntegration } from "@/lib/integrations";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  getProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import { getMetaBreakdownGuardrail } from "@/lib/meta/constraints";
import { getMetaHistoricalVerificationReason } from "@/lib/meta/historical-verification";
import { getMetaPartialReason, getMetaRangePreparationContext } from "@/lib/meta/readiness";
import {
  getMetaWarehouseBreakdowns,
  getMetaWarehouseCountryBreakdowns,
  type MetaWarehouseCountryBreakdownsResponse,
} from "@/lib/meta/serving";
import { getMetaSelectedRangeTruthReadiness } from "@/lib/sync/meta-sync";
import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";

export type MetaBreakdownsSourceResult = MetaBreakdownsResponse;
export interface MetaCountryBreakdownsSourceResult {
  status: MetaBreakdownsResponse["status"];
  rows: MetaBreakdownsResponse["location"];
  freshness: MetaWarehouseCountryBreakdownsResponse["freshness"] | null;
  verification: MetaWarehouseCountryBreakdownsResponse["verification"] | null;
  isPartial: boolean;
  notReadyReason: string | null;
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

function emptyBreakdowns(
  status: MetaBreakdownsResponse["status"],
  notReadyReason: string | null,
  isPartial: boolean,
  freshness: MetaBreakdownsResponse["freshness"] = null,
): MetaBreakdownsResponse {
  return {
    status,
    age: [],
    gender: [],
    location: [],
    placement: [],
    budget: { campaign: [], adset: [] },
    audience: {
      available: false,
      reason:
        "Audience Performance unavailable: no reliable audience-type dimension from current Meta account setup.",
    },
    products: {
      available: false,
      reason:
        "Top Products unavailable: product-level catalog breakdown is not available from current Meta insights endpoint/tokens.",
    },
    isPartial,
    notReadyReason,
    freshness,
  };
}

/**
 * Breakdown rows for a range, optionally narrowed to one assigned account.
 *
 * `providerAccountId` is a request, not an authority: it is intersected with
 * this workspace's assignments and an unassigned id is refused. Widening it to
 * every assigned account instead would pool two accounts' spend and ROAS into
 * one bar and label that bar with the single account the operator chose.
 */
export async function getMetaBreakdownsForRange(input: {
  businessId: string;
  providerAccountId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}): Promise<MetaBreakdownsSourceResult> {
  const resolvedStart = input.startDate ?? toISODate(nDaysAgo(29));
  const resolvedEnd = input.endDate ?? toISODate(new Date());
  const requestedAccountId = input.providerAccountId?.trim() || null;

  const posture = await readMetaBusinessDataPosture(input.businessId);
  if (posture === "unverified") {
    /*
     * Tri-state, not a boolean. `isDemoBusiness` answers `false` — live — for
     * an unreadable flag, so a workspace the database could not vouch for was
     * sent to the live reader. Withheld instead.
     */
    // `no_connection` is this module's own word for "there is nothing to read
    // from here" — the closest existing member, and reusing it keeps the status
    // union closed rather than widening a contract for one branch.
    return emptyBreakdowns("no_connection", META_POSTURE_UNVERIFIED_REASON, false);
  }
  if (posture === "demo") {
    /**
     * ITEM 17 — the demo branch answers for the account it HOLDS, or refuses.
     *
     * This branch used to return the fixture for whatever `providerAccountId`
     * the caller named, because it ran before the assignment intersection below
     * ever executed. Audiences sends the operator's chosen account on every
     * request, so a demo workspace answered `act_SOMEONE_ELSES` with
     * UrbanTrail's spend and ROAS and captioned the panels with the requested
     * account's name — a fabricated number wearing a real account's identity,
     * which is exactly what the non-demo path refuses with
     * `account_not_assigned`. A demo is allowed to be fictional; it is not
     * allowed to answer a question about an account it does not have.
     *
     * The fixture is NOT account-partitioned, and does not need to be: the demo
     * workspace is EXPLICITLY SINGLE-ACCOUNT. `getDemoMetaStatus()` — the same
     * assignment list every other demo Meta surface reads — holds exactly one
     * id (`act_210009998877`, "UrbanTrail DTC"), so `getDemoMetaBreakdowns()`
     * is that one account's breakdown and there is no second account whose rows
     * could be pooled into it. Reading the ids from that function rather than
     * restating them here is what keeps the two from drifting apart: adding a
     * second demo account there makes this branch serve it too, and THAT is the
     * point at which the fixture must be partitioned rather than shared.
     *
     * An omitted `providerAccountId` keeps the long-standing account-wide
     * answer, which for one assigned account is the same rows either way.
     */
    const demoAssignedAccountIds = getDemoMetaStatus().assignedAccountIds ?? [];
    if (requestedAccountId && !demoAssignedAccountIds.includes(requestedAccountId)) {
      return emptyBreakdowns(
        "account_not_assigned",
        "The requested Meta ad account is not assigned to this workspace.",
        false,
      );
    }
    return {
      ...getDemoMetaBreakdowns(),
      isPartial: false,
      notReadyReason: null,
    };
  }

  const integration = await getIntegration(input.businessId, "meta").catch(() => null);
  if (!integration || integration.status !== "connected") {
    return emptyBreakdowns(
      "no_connection",
      "Meta integration is not connected.",
      false,
    );
  }
  if (!integration.access_token) {
    return emptyBreakdowns(
      "no_access_token",
      "Meta access token is missing for this workspace.",
      false,
    );
  }

  const assignedAccountIds = await fetchAssignedAccountIds(input.businessId);
  if (assignedAccountIds.length === 0) {
    return emptyBreakdowns(
      "no_accounts_assigned",
      "No Meta ad account is assigned to this workspace.",
      false,
    );
  }
  if (requestedAccountId && !assignedAccountIds.includes(requestedAccountId)) {
    return emptyBreakdowns(
      "account_not_assigned",
      "The requested Meta ad account is not assigned to this workspace.",
      false,
    );
  }
  const scopedAccountIds = requestedAccountId
    ? [requestedAccountId]
    : assignedAccountIds;

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
  const breakdownGuardrail = getMetaBreakdownGuardrail({
    startDate: resolvedStart,
    endDate: resolvedEnd,
    referenceToday: rangeContext.currentDateInTimezone,
  });
  const historicalTruth =
    !rangeContext.isSelectedCurrentDay &&
    rangeContext.withinBreakdownHistory
      ? await getMetaSelectedRangeTruthReadiness({
          businessId: input.businessId,
          startDate: resolvedStart,
          endDate: effectiveEndDate,
        }).catch(() => null)
      : null;

  if (rangeContext.breakdownReadMode === "historical_breakdown_unsupported") {
    return emptyBreakdowns(
      "ok",
      breakdownGuardrail.message ??
        "Meta breakdown data is outside the supported historical horizon.",
      true,
    );
  }

  // Held outside the try so an empty read still reports when the warehouse was
  // last observed. A failed read leaves it null — "age unknown" — rather than
  // borrowing a timestamp from a read that did not happen.
  let warehouseFreshness: MetaBreakdownsResponse["freshness"] = null;
  try {
    const warehouse = await getMetaWarehouseBreakdowns({
      businessId: input.businessId,
      startDate: resolvedStart,
      endDate: effectiveEndDate,
      providerAccountIds: scopedAccountIds,
    });
    warehouseFreshness = warehouse.freshness ?? null;
    const hasWarehouseRows =
      warehouse.age.length > 0 ||
      warehouse.location.length > 0 ||
      warehouse.placement.length > 0 ||
      warehouse.budget.campaign.length > 0 ||
      warehouse.budget.adset.length > 0;
    if (hasWarehouseRows) {
      return {
        status: "ok",
        age: warehouse.age,
        // Empty for every day written before the write-path fold was
        // removed. Those days hold no gender split at all, so the surface
        // withholds rather than splitting the age blend by guesswork.
        gender: warehouse.gender,
        location: warehouse.location,
        placement: warehouse.placement,
        budget: warehouse.budget,
        audience: {
          available: false,
          reason:
            "Audience Performance unavailable: no reliable audience-type dimension from current Meta account setup.",
        },
        products: {
          available: false,
          reason:
            "Top Products unavailable: product-level catalog breakdown is not available from current Meta insights endpoint/tokens.",
        },
        isPartial: historicalTruth ? !historicalTruth.truthReady : false,
        notReadyReason:
          historicalTruth && !historicalTruth.truthReady
            ? getMetaHistoricalVerificationReason({
                verificationState:
                  historicalTruth.verificationState ?? historicalTruth.state ?? null,
                fallbackReason:
                  "Breakdown warehouse data is still being prepared for the requested range.",
              })
            : null,
        freshness: warehouseFreshness,
      };
    }
  } catch (error) {
    console.warn("[meta-breakdowns] warehouse_read_failed", {
      businessId: input.businessId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return emptyBreakdowns(
    "ok",
    breakdownGuardrail.message ??
      (historicalTruth
        ? historicalTruth.truthReady
          ? null
          : getMetaHistoricalVerificationReason({
              verificationState:
                historicalTruth.verificationState ?? historicalTruth.state ?? null,
              fallbackReason: getMetaPartialReason({
                isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
                currentDateInTimezone: rangeContext.currentDateInTimezone,
                primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                defaultReason:
                  "Breakdown warehouse data is still being prepared for the requested range.",
              }),
            })
        : getMetaPartialReason({
            isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
            currentDateInTimezone: rangeContext.currentDateInTimezone,
            primaryAccountTimezone: rangeContext.primaryAccountTimezone,
            defaultReason:
              "Breakdown warehouse data is still being prepared for the requested range.",
          })),
    historicalTruth ? !historicalTruth.truthReady : true,
    warehouseFreshness,
  );
}

export async function getMetaCountryBreakdownsForRange(input: {
  businessId: string;
  startDate?: string | null;
  endDate?: string | null;
}): Promise<MetaCountryBreakdownsSourceResult> {
  const resolvedStart = input.startDate ?? toISODate(nDaysAgo(29));
  const resolvedEnd = input.endDate ?? toISODate(new Date());

  if ((await readMetaBusinessDataPosture(input.businessId)) === "demo") {
    const demo = getDemoMetaBreakdowns();
    return {
      status: "ok",
      rows: demo.location,
      freshness: {
        dataState: demo.location.length > 0 ? "ready" : "stale",
        lastSyncedAt: null,
        liveRefreshedAt: null,
        isPartial: false,
        missingWindows: [],
        warnings: [],
      },
      verification: null,
      isPartial: false,
      notReadyReason: null,
    };
  }

  const integration = await getIntegration(input.businessId, "meta").catch(() => null);
  if (!integration || integration.status !== "connected") {
    return {
      status: "no_connection",
      rows: [],
      freshness: null,
      verification: null,
      isPartial: false,
      notReadyReason: "Meta integration is not connected.",
    };
  }
  if (!integration.access_token) {
    return {
      status: "no_access_token",
      rows: [],
      freshness: null,
      verification: null,
      isPartial: false,
      notReadyReason: "Meta access token is missing for this workspace.",
    };
  }

  const assignedAccountIds = await fetchAssignedAccountIds(input.businessId);
  if (assignedAccountIds.length === 0) {
    return {
      status: "no_accounts_assigned",
      rows: [],
      freshness: null,
      verification: null,
      isPartial: false,
      notReadyReason: "No Meta ad account is assigned to this workspace.",
    };
  }

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
  const breakdownGuardrail = getMetaBreakdownGuardrail({
    startDate: resolvedStart,
    endDate: resolvedEnd,
    referenceToday: rangeContext.currentDateInTimezone,
  });
  const historicalTruth =
    !rangeContext.isSelectedCurrentDay
      ? await getMetaSelectedRangeTruthReadiness({
          businessId: input.businessId,
          startDate: resolvedStart,
          endDate: effectiveEndDate,
        }).catch(() => null)
      : null;

  try {
    const warehouse = await getMetaWarehouseCountryBreakdowns({
      businessId: input.businessId,
      startDate: resolvedStart,
      endDate: effectiveEndDate,
      providerAccountIds: assignedAccountIds,
    });
    if (warehouse.rows.length > 0) {
      return {
        status: "ok",
        rows: warehouse.rows,
        freshness: warehouse.freshness,
        verification: warehouse.verification ?? null,
        isPartial: historicalTruth ? !historicalTruth.truthReady : Boolean(warehouse.isPartial),
        notReadyReason:
          historicalTruth && !historicalTruth.truthReady
            ? getMetaHistoricalVerificationReason({
                verificationState:
                  historicalTruth.verificationState ?? historicalTruth.state ?? null,
                fallbackReason:
                  "Country breakdown warehouse data is still being prepared for the requested range.",
              })
            : null,
      };
    }
  } catch (error) {
    console.warn("[meta-country-breakdowns] warehouse_read_failed", {
      businessId: input.businessId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    status: "ok",
    rows: [],
    freshness: {
      dataState: "syncing",
      lastSyncedAt: null,
      liveRefreshedAt: null,
      isPartial: historicalTruth ? !historicalTruth.truthReady : true,
      missingWindows: [],
      warnings: [],
    },
    verification: null,
    isPartial: historicalTruth ? !historicalTruth.truthReady : true,
    notReadyReason:
      breakdownGuardrail.message ??
      (historicalTruth
        ? historicalTruth.truthReady
          ? null
          : getMetaHistoricalVerificationReason({
              verificationState:
                historicalTruth.verificationState ?? historicalTruth.state ?? null,
              fallbackReason: getMetaPartialReason({
                isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
                currentDateInTimezone: rangeContext.currentDateInTimezone,
                primaryAccountTimezone: rangeContext.primaryAccountTimezone,
                defaultReason:
                  "Country breakdown warehouse data is still being prepared for the requested range.",
              }),
            })
        : getMetaPartialReason({
            isSelectedCurrentDay: rangeContext.isSelectedCurrentDay,
            currentDateInTimezone: rangeContext.currentDateInTimezone,
            primaryAccountTimezone: rangeContext.primaryAccountTimezone,
            defaultReason:
              "Country breakdown warehouse data is still being prepared for the requested range.",
          })),
  };
}
