import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import type { MetaOsStructureBidConfiguration } from "@/lib/meta/decisions-os-contract";
import {
  providerBudgetValue,
  providerCurrencyValue,
} from "@/lib/meta/decisions-os-presentation";
import {
  readLatestMetaAdSetConfigHistory,
  readLatestMetaCampaignConfigHistory,
  readMetaAdSetDimensions,
  readMetaCampaignDimensions,
  readPreviousDifferentMetaAdSetConfigHistoryDiffs,
  readPreviousDifferentMetaCampaignConfigHistoryDiffs,
} from "@/lib/meta/request-model-store";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { getCachedValue } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

type StructureLevel = "campaign" | "adset";

function parseLevel(value: string | null): StructureLevel | null {
  return value === "campaign" || value === "adset" ? value : null;
}

async function readConfiguration(input: {
  businessId: string;
  providerAccountId: string;
  level: StructureLevel;
  entityId: string;
}): Promise<MetaOsStructureBidConfiguration | null> {
  const entityIds = [input.entityId];
  const [dimensions, currentById, previousById] =
    input.level === "campaign"
      ? await Promise.all([
          readMetaCampaignDimensions({
            businessId: input.businessId,
            campaignIds: entityIds,
          }),
          readLatestMetaCampaignConfigHistory({
            businessId: input.businessId,
            campaignIds: entityIds,
          }),
          readPreviousDifferentMetaCampaignConfigHistoryDiffs({
            businessId: input.businessId,
            campaignIds: entityIds,
            includeBudget: false,
          }),
        ])
      : await Promise.all([
          readMetaAdSetDimensions({
            businessId: input.businessId,
            adsetIds: entityIds,
          }),
          readLatestMetaAdSetConfigHistory({
            businessId: input.businessId,
            adsetIds: entityIds,
          }),
          readPreviousDifferentMetaAdSetConfigHistoryDiffs({
            businessId: input.businessId,
            adsetIds: entityIds,
            includeBudget: false,
          }),
        ]);

  const dimension = dimensions.get(input.entityId);
  if (!dimension || dimension.providerAccountId !== input.providerAccountId) {
    return null;
  }
  const current = currentById.get(input.entityId);
  if (!current) return null;
  const previous = previousById.get(input.entityId) ?? null;

  return {
    strategyType: current.bidStrategyType ?? null,
    strategyLabel: current.bidStrategyLabel ?? null,
    currentValue: providerCurrencyValue(
      current.bidValue,
      current.bidValueFormat,
    ),
    currentValueFormat: current.bidValueFormat ?? null,
    previousValue: providerCurrencyValue(
      previous?.previousBidValue,
      previous?.previousBidValueFormat,
    ),
    previousValueFormat: previous?.previousBidValueFormat ?? null,
    previousValueCapturedAt: previous?.previousBidCapturedAt ?? null,
    dailyBudget: providerBudgetValue(current.dailyBudget),
    lifetimeBudget: providerBudgetValue(current.lifetimeBudget),
    budgetUtilization: null,
  };
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const providerAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() ?? "";
  const entityId = request.nextUrl.searchParams.get("entityId")?.trim() ?? "";
  const level = parseLevel(request.nextUrl.searchParams.get("level"));

  if (!businessId || !providerAccountId || !entityId || !level) {
    return NextResponse.json(
      {
        error: "invalid_structure_scope",
        message:
          "businessId, providerAccountId, entityId, and a campaign/adset level are required.",
      },
      { status: 400 },
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const assignments = await getProviderAccountAssignments(
    businessId,
    "meta",
  ).catch(() => null);
  if (!assignments?.account_ids.includes(providerAccountId)) {
    return NextResponse.json(
      {
        error: "provider_account_not_assigned",
        message: "The requested Meta account is not assigned to this business.",
      },
      { status: 403 },
    );
  }

  const loader = () =>
    readConfiguration({ businessId, providerAccountId, level, entityId });
  const configuration =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? await loader()
      : (
          await getCachedValue({
            key: `meta-structure-configuration-v1:${businessId}:${providerAccountId}:${level}:${entityId}`,
            ttlMs: 5 * 60_000,
            staleWhileRevalidateMs: 30 * 60_000,
            loader,
          })
        ).value;

  if (!configuration) {
    return NextResponse.json(
      {
        error: "structure_configuration_unavailable",
        message:
          "No account-scoped configuration history is available for this entity.",
      },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      businessId,
      providerAccountId,
      entityId,
      level,
      configuration,
    },
    { headers: { "Cache-Control": "private, max-age=0" } },
  );
}
