/**
 * lib/meta/live.ts
 *
 * Direct Meta Graph API fetch for today's live data — no warehouse writes.
 * Used when startDate === endDate === today (in account timezone).
 *
 * For campaigns: fetches insights + config directly from Meta API,
 * enriches with config snapshots from DB (read-only).
 *
 * For ad sets: delegates to getAdSets() which already fetches live
 * from Meta API without warehouse writes.
 *
 * Snapshot exception:
 * - meta_config_snapshots are allowed here for today/live config serving only.
 * - They must not be used for normal historical campaign/adset UI serving.
 */

import {
  resolveMetaCredentials,
  resolveMetaCurrencyForAccount,
  getAdSets,
} from "@/lib/api/meta";
import { fetchWithTimeout } from "@/lib/http-fetch-with-timeout";
import {
  readLatestMetaConfigSnapshots,
  readPreviousDifferentMetaConfigDiffs,
} from "@/lib/meta/config-snapshots";
import { buildConfigSnapshotPayload, summarizeCampaignConfig } from "@/lib/meta/configuration";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";

// ── Internal raw types ────────────────────────────────────────────────────────

interface RawActionValue {
  action_type: string;
  value: string;
}

interface RawCampaignInsight {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  ctr?: string;
  cpm?: string;
  impressions?: string;
  clicks?: string;
  actions?: RawActionValue[];
  action_values?: RawActionValue[];
  purchase_roas?: RawActionValue[];
}

interface RawCampaign {
  id: string;
  name?: string;
  objective?: string;
  status?: string;
  effective_status?: string;
  updated_time?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  bid_amount?: string;
  bid_constraints?: { roas_average_floor?: string };
}

interface RawAdSet {
  id: string;
  name?: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  bid_strategy?: string;
  bid_amount?: string;
  bid_constraints?: { roas_average_floor?: string };
  promoted_object?: {
    pixel_id?: string;
    custom_event_type?: string;
    custom_conversion_id?: string;
    [key: string]: unknown;
  } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNum(s?: string): number {
  return s ? parseFloat(s) || 0 : 0;
}

function parseAction(arr: RawActionValue[] | undefined, type: string): number {
  if (!Array.isArray(arr)) return 0;
  const found = arr.find((a) => a.action_type === type);
  return found ? parseFloat(found.value) || 0 : 0;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Live Meta Graph calls run inside the sync worker loop; bound every request so
// a stalled socket cannot park the worker (see worker hang runbook).
const META_LIVE_FETCH_TIMEOUT_MS = 90_000;

async function fetchPagedMeta<T>(initialUrl: string): Promise<T[]> {
  const rows: T[] = [];
  let nextUrl: string | null = initialUrl;
  let page = 0;
  while (nextUrl && page < 20) {
    const res = await fetchWithTimeout(
      nextUrl,
      { cache: "no-store" },
      { timeoutMs: META_LIVE_FETCH_TIMEOUT_MS, label: "Meta live page" },
    );
    if (!res.ok) break;
    const json = (await res.json()) as { data?: T[]; paging?: { next?: string } };
    rows.push(...(json.data ?? []));
    nextUrl = json.paging?.next ?? null;
    page++;
  }
  return rows;
}

// ── Campaign live fetch ───────────────────────────────────────────────────────

/**
 * Fetch today's campaign data directly from Meta Graph API.
 * Returns the same MetaCampaignRow shape as the warehouse path.
 * Fields not available at campaign-level in today's snapshot (reach, video views,
 * per-action costs, etc.) are zeroed out — the UI only needs spend/ROAS/CPA/CTR.
 */
export async function getMetaLiveCampaignRows(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds: string[];
  includePrev?: boolean;
}): Promise<MetaCampaignRow[]> {
  const credentials = await resolveMetaCredentials(input.businessId);
  if (!credentials) return [];

  const accountIds =
    input.providerAccountIds.length > 0
      ? input.providerAccountIds
      : credentials.accountIds;

  const allRows: MetaCampaignRow[] = [];

  await Promise.all(
    accountIds.map(async (accountId) => {
      const { accessToken } = credentials;
      const profile = credentials.accountProfiles[accountId];
      const currency = resolveMetaCurrencyForAccount(credentials, accountId);

      // Fetch campaign insights (metrics), campaign config, and ad set config in parallel.
      const insightUrl = new URL(`https://graph.facebook.com/v25.0/${accountId}/insights`);
      insightUrl.searchParams.set("level", "campaign");
      insightUrl.searchParams.set(
        "fields",
        "campaign_id,campaign_name,spend,ctr,cpm,impressions,clicks,actions,action_values,purchase_roas"
      );
      insightUrl.searchParams.set(
        "time_range",
        JSON.stringify({ since: input.startDate, until: input.endDate })
      );
      insightUrl.searchParams.set("limit", "200");
      insightUrl.searchParams.set("access_token", accessToken);

      const configUrl = new URL(`https://graph.facebook.com/v25.0/${accountId}/campaigns`);
      configUrl.searchParams.set(
        "fields",
        "id,name,objective,effective_status,status,updated_time,daily_budget,lifetime_budget,bid_strategy,bid_amount,bid_constraints{roas_average_floor}"
      );
      configUrl.searchParams.set("limit", "500");
      configUrl.searchParams.set("access_token", accessToken);

      const adsetConfigUrl = new URL(`https://graph.facebook.com/v25.0/${accountId}/adsets`);
      adsetConfigUrl.searchParams.set(
        "fields",
        "id,name,campaign_id,effective_status,status,daily_budget,lifetime_budget,optimization_goal,promoted_object{pixel_id,custom_event_type,custom_conversion_id},bid_strategy,bid_amount,bid_constraints{roas_average_floor}"
      );
      adsetConfigUrl.searchParams.set("limit", "500");
      adsetConfigUrl.searchParams.set("access_token", accessToken);

      const [insightRes, campaignRows, adsetRows] = await Promise.all([
        fetchWithTimeout(
          insightUrl.toString(),
          { cache: "no-store" },
          { timeoutMs: META_LIVE_FETCH_TIMEOUT_MS, label: "Meta live insight" },
        )
          .then((r) =>
            r.ok ? (r.json() as Promise<{ data?: RawCampaignInsight[] }>) : { data: [] as RawCampaignInsight[] }
          )
          .catch(() => ({ data: [] as RawCampaignInsight[] })),
        fetchPagedMeta<RawCampaign>(configUrl.toString()).catch(() => [] as RawCampaign[]),
        fetchPagedMeta<RawAdSet>(adsetConfigUrl.toString()).catch(() => [] as RawAdSet[]),
      ]);

      const insights: RawCampaignInsight[] = (insightRes as { data?: RawCampaignInsight[] }).data ?? [];
      const campaignMap = new Map<string, RawCampaign>(campaignRows.map((c) => [c.id, c]));
      const statusMap = new Map<string, string>(
        campaignRows.map((c) => [c.id, c.effective_status ?? c.status ?? "UNKNOWN"])
      );

      if (insights.length === 0) return;

      const campaignIds = [...new Set(insights.map((i) => i.campaign_id ?? "").filter(Boolean))];
      const adsetIds = [
        ...new Set(
          adsetRows
            .map((row) => row.id)
            .filter(Boolean)
        ),
      ];

      const [latestCampaignConfigs, latestAdSetConfigs, previousConfigs] = await Promise.all([
        readLatestMetaConfigSnapshots({
          businessId: input.businessId,
          entityLevel: "campaign",
          entityIds: campaignIds,
        }),
        readLatestMetaConfigSnapshots({
          businessId: input.businessId,
          entityLevel: "adset",
          entityIds: adsetIds,
        }),
        input.includePrev
          ? readPreviousDifferentMetaConfigDiffs({
              businessId: input.businessId,
              entityLevel: "campaign",
              entityIds: campaignIds,
            })
          : Promise.resolve(new Map<string, never>()),
      ]);

      const adsetPayloadsByCampaign = new Map<string, ReturnType<typeof buildConfigSnapshotPayload>[]>();
      for (const adset of adsetRows) {
        const adsetCampaignId = adset.campaign_id ?? "";
        if (!adsetCampaignId) continue;
        const payload = buildConfigSnapshotPayload({
          campaignId: adsetCampaignId,
          optimizationGoal:
            adset.optimization_goal ??
            latestAdSetConfigs.get(adset.id)?.optimizationGoal ??
            null,
          customEventType:
            adset.promoted_object?.custom_event_type ??
            latestAdSetConfigs.get(adset.id)?.customEventType ??
            null,
          pixelId:
            adset.promoted_object?.pixel_id ??
            latestAdSetConfigs.get(adset.id)?.pixelId ??
            null,
          customConversionId:
            adset.promoted_object?.custom_conversion_id ??
            latestAdSetConfigs.get(adset.id)?.customConversionId ??
            null,
          promotedObject:
            adset.promoted_object ??
            latestAdSetConfigs.get(adset.id)?.promotedObject ??
            null,
          bidStrategy:
            adset.bid_strategy ??
            latestAdSetConfigs.get(adset.id)?.bidStrategyType ??
            null,
          manualBidAmount:
            adset.bid_amount != null
              ? parseNum(adset.bid_amount)
              : latestAdSetConfigs.get(adset.id)?.manualBidAmount ?? null,
          targetRoas:
            adset.bid_constraints?.roas_average_floor != null
              ? parseNum(adset.bid_constraints.roas_average_floor)
              : latestAdSetConfigs.get(adset.id)?.bidValueFormat === "roas" &&
                  latestAdSetConfigs.get(adset.id)?.bidValue != null
                ? latestAdSetConfigs.get(adset.id)?.bidValue ?? null
                : null,
          dailyBudget:
            adset.daily_budget != null
              ? parseNum(adset.daily_budget)
              : latestAdSetConfigs.get(adset.id)?.dailyBudget ?? null,
          lifetimeBudget:
            adset.lifetime_budget != null
              ? parseNum(adset.lifetime_budget)
              : latestAdSetConfigs.get(adset.id)?.lifetimeBudget ?? null,
        });
        const existing = adsetPayloadsByCampaign.get(adsetCampaignId);
        if (existing) existing.push(payload);
        else adsetPayloadsByCampaign.set(adsetCampaignId, [payload]);
      }

      for (const insight of insights) {
        const campaignId = insight.campaign_id ?? "";
        if (!campaignId) continue;

        const rawCampaign = campaignMap.get(campaignId);
        const latestSnapshot = latestCampaignConfigs.get(campaignId);
        const previousDiff = input.includePrev ? previousConfigs.get(campaignId) : undefined;

        const config = summarizeCampaignConfig({
          campaignId,
          campaignDailyBudget:
            rawCampaign?.daily_budget != null
              ? parseNum(rawCampaign.daily_budget)
              : latestSnapshot?.dailyBudget ?? null,
          campaignLifetimeBudget:
            rawCampaign?.lifetime_budget != null
              ? parseNum(rawCampaign.lifetime_budget)
              : latestSnapshot?.lifetimeBudget ?? null,
          campaignBidStrategy:
            rawCampaign?.bid_strategy ?? latestSnapshot?.bidStrategyType ?? null,
          campaignManualBidAmount:
            rawCampaign?.bid_amount != null
              ? parseNum(rawCampaign.bid_amount)
              : latestSnapshot?.manualBidAmount ?? null,
          targetRoas:
            rawCampaign?.bid_constraints?.roas_average_floor != null
              ? parseNum(rawCampaign.bid_constraints.roas_average_floor)
              : latestSnapshot?.bidValueFormat === "roas" && latestSnapshot?.bidValue != null
                ? latestSnapshot.bidValue
                : null,
          adsets: adsetPayloadsByCampaign.get(campaignId) ?? [],
        });

        const spend = parseNum(insight.spend);
        const purchases = parseAction(insight.actions, "purchase");
        const revenueFromValues = parseAction(insight.action_values, "purchase");
        const purchaseRoasVal = parseAction(insight.purchase_roas, "omni_purchase");
        const revenue = revenueFromValues > 0 ? revenueFromValues : spend * purchaseRoasVal;
        const roas = spend > 0 ? r2(revenue / spend) : 0;
        const cpa = purchases > 0 ? r2(spend / purchases) : 0;
        const ctr = r2(parseNum(insight.ctr));
        const cpm = r2(parseNum(insight.cpm));
        const impressions = Math.round(parseNum(insight.impressions));
        const clicks = Math.round(parseNum(insight.clicks));
        const addToCart = parseAction(insight.actions, "add_to_cart");
        const addToCartValue = parseAction(insight.action_values, "add_to_cart");
        const initiateCheckout = parseAction(insight.actions, "initiate_checkout");
        const initiateCheckoutValue = parseAction(insight.action_values, "initiate_checkout");
        const leads = parseAction(insight.actions, "lead");
        const leadsValue = parseAction(insight.action_values, "lead");
        const registrations = parseAction(insight.actions, "complete_registration");
        const registrationsValue = parseAction(insight.action_values, "complete_registration");
        const addPaymentInfo = parseAction(insight.actions, "add_payment_info");
        const addPaymentInfoValue = parseAction(insight.action_values, "add_payment_info");

        allRows.push({
          id: campaignId,
          accountId,
          name: insight.campaign_name ?? rawCampaign?.name ?? "Unknown Campaign",
          status: statusMap.get(campaignId) ?? "UNKNOWN",
          statusUpdatedAt: rawCampaign?.updated_time ?? null,
          objective: rawCampaign?.objective ?? latestSnapshot?.objective ?? null,
          budgetLevel:
            config.dailyBudget != null || config.lifetimeBudget != null ? "campaign" : null,
          spend: r2(spend),
          purchases: Math.round(purchases),
          revenue: r2(revenue),
          roas,
          cpa,
          ctr,
          cpm,
          cpc: clicks > 0 ? r2(spend / clicks) : 0,
          cpp: purchases > 0 ? r2(spend / purchases) : 0,
          impressions,
          reach: 0,
          frequency: 0,
          clicks,
          uniqueClicks: 0,
          uniqueCtr: 0,
          inlineLinkClickCtr: 0,
          outboundClicks: 0,
          outboundCtr: 0,
          uniqueOutboundClicks: 0,
          uniqueOutboundCtr: 0,
          landingPageViews: 0,
          costPerLandingPageView: 0,
          addToCart: Math.round(addToCart),
          addToCartValue: r2(addToCartValue),
          costPerAddToCart: addToCart > 0 ? r2(spend / addToCart) : 0,
          initiateCheckout: Math.round(initiateCheckout),
          initiateCheckoutValue: r2(initiateCheckoutValue),
          costPerCheckoutInitiated: initiateCheckout > 0 ? r2(spend / initiateCheckout) : 0,
          leads: Math.round(leads),
          leadsValue: r2(leadsValue),
          costPerLead: leads > 0 ? r2(spend / leads) : 0,
          registrationsCompleted: Math.round(registrations),
          registrationsCompletedValue: r2(registrationsValue),
          costPerRegistrationCompleted: registrations > 0 ? r2(spend / registrations) : 0,
          searches: 0,
          searchesValue: 0,
          costPerSearch: 0,
          addPaymentInfo: Math.round(addPaymentInfo),
          addPaymentInfoValue: r2(addPaymentInfoValue),
          costPerAddPaymentInfo: addPaymentInfo > 0 ? r2(spend / addPaymentInfo) : 0,
          pageLikes: 0,
          costPerPageLike: 0,
          postEngagement: parseAction(insight.actions, "post_engagement"),
          costPerEngagement: 0,
          postReactions: parseAction(insight.actions, "post_reaction"),
          costPerReaction: 0,
          postComments: parseAction(insight.actions, "comment"),
          costPerPostComment: 0,
          postShares: parseAction(insight.actions, "post"),
          costPerPostShare: 0,
          messagingConversationsStarted: parseAction(
            insight.actions,
            "onsite_conversion.messaging_conversation_started_7d"
          ),
          costPerMessagingConversationStarted: 0,
          appInstalls: parseAction(insight.actions, "app_install"),
          costPerAppInstall: 0,
          contentViews: parseAction(insight.actions, "view_content"),
          contentViewsValue: parseAction(insight.action_values, "view_content"),
          costPerContentView: 0,
          videoViews3s: 0,
          videoViews15s: 0,
          videoViews25: 0,
          videoViews50: 0,
          videoViews75: 0,
          videoViews95: 0,
          videoViews100: 0,
          costPerVideoView: 0,
          currency,
          optimizationGoal: config.optimizationGoal ?? latestSnapshot?.optimizationGoal ?? null,
          customEventType: config.customEventType ?? latestSnapshot?.customEventType ?? null,
          isCustomEventTypeMixed: Boolean(config.isCustomEventTypeMixed),
          bidStrategyType: config.bidStrategyType,
          bidStrategyLabel: config.bidStrategyLabel,
          manualBidAmount: config.manualBidAmount,
          previousManualBidAmount: previousDiff?.previousManualBidAmount ?? null,
          bidValue: config.bidValue,
          bidValueFormat: config.bidValueFormat,
          previousBidValue: previousDiff?.previousBidValue ?? null,
          previousBidValueFormat: previousDiff?.previousBidValueFormat ?? null,
          previousBidValueCapturedAt: previousDiff?.previousBidCapturedAt ?? null,
          dailyBudget: config.dailyBudget,
          lifetimeBudget: config.lifetimeBudget,
          previousDailyBudget: previousDiff?.previousDailyBudget ?? null,
          previousLifetimeBudget: previousDiff?.previousLifetimeBudget ?? null,
          previousBudgetCapturedAt: previousDiff?.previousBudgetCapturedAt ?? null,
          isBudgetMixed: false,
          isConfigMixed: false,
          isOptimizationGoalMixed: false,
          isBidStrategyMixed: false,
          isBidValueMixed: false,
        });
      }
    })
  );

  return allRows.sort((a, b) => b.spend - a.spend);
}

// ── Summary live totals ───────────────────────────────────────────────────────

/**
 * Aggregate live campaign rows into KPI totals for the summary endpoint.
 */
export async function getMetaLiveSummaryTotals(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds: string[];
}): Promise<{
  spend: number;
  revenue: number;
  conversions: number;
  roas: number;
  cpa: number | null;
  ctr: number | null;
  cpc: number | null;
  impressions: number;
  clicks: number;
  reach: number;
}> {
  const rows = await getMetaLiveCampaignRows({ ...input, includePrev: false });
  const spend = r2(rows.reduce((s, r) => s + r.spend, 0));
  const revenue = r2(rows.reduce((s, r) => s + r.revenue, 0));
  const conversions = rows.reduce((s, r) => s + r.purchases, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  return {
    spend,
    revenue,
    conversions,
    roas: spend > 0 ? r2(revenue / spend) : 0,
    cpa: conversions > 0 ? r2(spend / conversions) : null,
    ctr: impressions > 0 ? r2((clicks / impressions) * 100) : null,
    cpc: clicks > 0 ? r2(spend / clicks) : null,
    impressions,
    clicks,
    reach: 0,
  };
}

/**
 * Determine whether current-day live summary and campaign surfaces are actually
 * available for serving. This is stricter than connection/assignment eligibility.
 */
export async function getMetaCurrentDayLiveAvailability(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds: string[];
}): Promise<{
  summaryAvailable: boolean;
  campaignsAvailable: boolean;
}> {
  const [summaryResult, campaignsResult] = await Promise.allSettled([
    getMetaLiveSummaryTotals(input),
    getMetaLiveCampaignRows({ ...input, includePrev: false }),
  ]);

  const summaryAvailable =
    summaryResult.status === "fulfilled" &&
    (summaryResult.value.spend > 0 || summaryResult.value.impressions > 0);
  const campaignsAvailable =
    campaignsResult.status === "fulfilled" && campaignsResult.value.length > 0;

  return {
    summaryAvailable,
    campaignsAvailable,
  };
}

// ── Ad set live fetch ─────────────────────────────────────────────────────────

/**
 * Fetch today's ad set data directly from Meta Graph API.
 * Delegates to getAdSets() with raw-snapshot recording OFF.
 *
 * That flag is the whole point. This is a READ: a screen asking what the ad sets
 * look like for a range. getAdSets defaults to capturing, and it recorded
 * `adset_statuses` and `adset_insights` keyed by the requested window — so
 * viewing a historical range attributed CURRENT provider state to a past date
 * and appended raw rows on every page load. The comment here used to claim
 * "without warehouse writes", which was simply false.
 */
export async function getMetaLiveAdSets(input: {
  businessId: string;
  campaignId?: string | null;
  startDate: string;
  endDate: string;
  includePrev?: boolean;
  providerAccountIds?: string[] | null;
}): Promise<MetaAdSetData[]> {
  const credentials = await resolveMetaCredentials(input.businessId);
  if (!credentials) return [];

  return getAdSets(
    credentials,
    input.campaignId,
    input.startDate,
    input.endDate,
    input.businessId,
    input.includePrev ?? false,
    input.providerAccountIds,
    { recordRawSnapshots: false },
  );
}
