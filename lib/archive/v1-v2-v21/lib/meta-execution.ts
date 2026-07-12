import { getDemoMetaAdSets, isDemoBusinessId } from "@/lib/demo-business";
import { resolveMetaCredentials } from "@/lib/api/meta";

interface RawMetaExecutionAdSet {
  id?: string;
  account_id?: string;
  name?: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  bid_strategy?: string;
}

interface RawMetaExecutionCampaign {
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
}

export interface MetaExecutionAdSetState {
  provider: "meta";
  businessId: string;
  adSetId: string;
  adSetName: string;
  providerAccountId: string | null;
  providerAccountName: string | null;
  currency: string | null;
  campaignId: string | null;
  campaignName: string | null;
  status: string | null;
  budgetLevel: "campaign" | "adset" | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  optimizationGoal: string | null;
  bidStrategyLabel: string | null;
  isBudgetMixed: boolean;
  isConfigMixed: boolean;
  providerAccessible: boolean;
  isDemo: boolean;
}

export interface MetaExecutionMutationResult {
  statusCode: number;
  ok: boolean;
  body: Record<string, unknown>;
  traceId: string | null;
}

function parseNum(value: string | null | undefined) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value: string | null | undefined) {
  const text = String(value ?? "").trim().toUpperCase();
  return text.length > 0 ? text : null;
}

function labelBidStrategy(value: string | null | undefined) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

async function fetchMetaNode<TNode>(
  nodeId: string,
  fields: string,
  accessToken: string,
) {
  const url = new URL(`https://graph.facebook.com/v25.0/${nodeId}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString(), {
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof body.error === "object" &&
      body.error &&
      typeof (body.error as { message?: unknown }).message === "string"
        ? ((body.error as { message: string }).message)
        : `Meta execution read failed with status ${response.status}.`;
    throw new Error(message);
  }
  return body as TNode;
}

export async function getMetaAdSetExecutionState(input: {
  businessId: string;
  adSetId: string;
}): Promise<MetaExecutionAdSetState | null> {
  if (isDemoBusinessId(input.businessId)) {
    const demoRow =
      getDemoMetaAdSets().find((row) => row.id === input.adSetId) ?? null;
    if (!demoRow) return null;
    return {
      provider: "meta",
      businessId: input.businessId,
      adSetId: demoRow.id,
      adSetName: demoRow.name,
      providerAccountId: demoRow.accountId ?? null,
      providerAccountName: "Demo Meta Account",
      currency: "USD",
      campaignId: demoRow.campaignId,
      campaignName: null,
      status: normalizeStatus(demoRow.status),
      budgetLevel: demoRow.budgetLevel ?? null,
      dailyBudget: demoRow.dailyBudget ?? null,
      lifetimeBudget: demoRow.lifetimeBudget ?? null,
      optimizationGoal: demoRow.optimizationGoal ?? null,
      bidStrategyLabel: demoRow.bidStrategyLabel ?? null,
      isBudgetMixed: demoRow.isBudgetMixed,
      isConfigMixed: demoRow.isConfigMixed,
      providerAccessible: false,
      isDemo: true,
    };
  }

  const credentials = await resolveMetaCredentials(input.businessId);
  if (!credentials) return null;

  const adset = await fetchMetaNode<RawMetaExecutionAdSet>(
    input.adSetId,
    "id,account_id,name,campaign_id,effective_status,status,daily_budget,lifetime_budget,optimization_goal,bid_strategy",
    credentials.accessToken,
  );
  if (!adset?.id) return null;

  const campaign = adset.campaign_id
    ? await fetchMetaNode<RawMetaExecutionCampaign>(
        adset.campaign_id,
        "id,name,effective_status,status,daily_budget,lifetime_budget",
        credentials.accessToken,
      ).catch(() => null)
    : null;

  const adsetDailyBudget = parseNum(adset.daily_budget);
  const adsetLifetimeBudget = parseNum(adset.lifetime_budget);
  const campaignDailyBudget = parseNum(campaign?.daily_budget);
  const campaignLifetimeBudget = parseNum(campaign?.lifetime_budget);
  const usesCampaignBudgetFallback =
    adsetDailyBudget == null &&
    adsetLifetimeBudget == null &&
    (campaignDailyBudget != null || campaignLifetimeBudget != null);
  const providerAccountId = adset.account_id ?? null;

  return {
    provider: "meta",
    businessId: input.businessId,
    adSetId: adset.id,
    adSetName: adset.name ?? input.adSetId,
    providerAccountId,
    providerAccountName:
      providerAccountId != null
        ? credentials.accountProfiles[providerAccountId]?.name ?? null
        : null,
    currency:
      providerAccountId != null
        ? credentials.accountProfiles[providerAccountId]?.currency ??
          credentials.currency
        : credentials.currency,
    campaignId: adset.campaign_id ?? null,
    campaignName: campaign?.name ?? null,
    status:
      normalizeStatus(adset.effective_status) ??
      normalizeStatus(adset.status) ??
      normalizeStatus(campaign?.effective_status) ??
      normalizeStatus(campaign?.status),
    budgetLevel: usesCampaignBudgetFallback
      ? "campaign"
      : adsetDailyBudget != null || adsetLifetimeBudget != null
        ? "adset"
        : null,
    dailyBudget: usesCampaignBudgetFallback ? campaignDailyBudget : adsetDailyBudget,
    lifetimeBudget: usesCampaignBudgetFallback
      ? campaignLifetimeBudget
      : adsetLifetimeBudget,
    optimizationGoal: adset.optimization_goal ?? null,
    bidStrategyLabel: labelBidStrategy(adset.bid_strategy),
    isBudgetMixed: usesCampaignBudgetFallback
      ? campaignDailyBudget != null && campaignLifetimeBudget != null
      : adsetDailyBudget != null && adsetLifetimeBudget != null,
    isConfigMixed: false,
    providerAccessible:
      providerAccountId == null || credentials.accountIds.includes(providerAccountId),
    isDemo: false,
  };
}

export async function mutateMetaAdSetExecution(input: {
  businessId: string;
  adSetId: string;
  requestedStatus?: string | null;
  requestedDailyBudget?: number | null;
}): Promise<never> {
  void input;
  const error = new Error(
    "Legacy Command Center execution is archived and cannot write to Meta.",
  ) as Error & { code?: string };
  error.code = "archived_execution_disabled";
  throw error;
}
