import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import {
  PROVIDER_ACCOUNT_PARAM,
  readProviderAccountParam,
} from "@/lib/meta/provider-account-param";

export const dynamic = "force-dynamic";

export interface MetaCampaignRow {
  id: string;
  accountId: string;
  name: string;
  status: string;
  statusUpdatedAt?: string | null;
  objective?: string | null;
  firstDeliveryDate?: string | null;
  activeDayCount?: number | null;
  ageDays?: number | null;
  asOfDate?: string | null;
  budgetLevel: "campaign" | "adset" | null;
  spend: number;
  purchases: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  cpm: number;
  cpc: number;
  cpp: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  uniqueClicks: number;
  uniqueCtr: number;
  inlineLinkClickCtr: number;
  outboundClicks: number;
  outboundCtr: number;
  uniqueOutboundClicks: number;
  uniqueOutboundCtr: number;
  landingPageViews: number;
  costPerLandingPageView: number;
  addToCart: number;
  addToCartValue: number;
  costPerAddToCart: number;
  initiateCheckout: number;
  initiateCheckoutValue: number;
  costPerCheckoutInitiated: number;
  leads: number;
  leadsValue: number;
  costPerLead: number;
  registrationsCompleted: number;
  registrationsCompletedValue: number;
  costPerRegistrationCompleted: number;
  searches: number;
  searchesValue: number;
  costPerSearch: number;
  addPaymentInfo: number;
  addPaymentInfoValue: number;
  costPerAddPaymentInfo: number;
  pageLikes: number;
  costPerPageLike: number;
  postEngagement: number;
  costPerEngagement: number;
  postReactions: number;
  costPerReaction: number;
  postComments: number;
  costPerPostComment: number;
  postShares: number;
  costPerPostShare: number;
  messagingConversationsStarted: number;
  costPerMessagingConversationStarted: number;
  appInstalls: number;
  costPerAppInstall: number;
  contentViews: number;
  contentViewsValue: number;
  costPerContentView: number;
  videoViews3s: number;
  videoViews15s: number;
  videoViews25: number;
  videoViews50: number;
  videoViews75: number;
  videoViews95: number;
  videoViews100: number;
  costPerVideoView: number;
  currency: string | null;
  optimizationGoal: string | null;
  customEventType?: string | null;
  isCustomEventTypeMixed?: boolean;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  previousManualBidAmount: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  previousBidValue: number | null;
  previousBidValueFormat: "currency" | "roas" | null;
  previousBidValueCapturedAt: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  previousDailyBudget: number | null;
  previousLifetimeBudget: number | null;
  previousBudgetCapturedAt: string | null;
  isBudgetMixed: boolean;
  isConfigMixed: boolean;
  isOptimizationGoalMixed: boolean;
  isBidStrategyMixed: boolean;
  isBidValueMixed: boolean;
}

export interface MetaCampaignsResponse {
  status?: "ok" | "no_accounts_assigned" | "account_not_assigned" | "not_connected";
  rows: MetaCampaignRow[];
  isPartial?: boolean;
  notReadyReason?: string | null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  /**
   * `providerAccountId` is the canonical name; `accountId` is read here only
   * because links carrying it already exist (WP4 items 1–2). Every deprecated
   * read is logged so the tail is observable and the alias can eventually go.
   *
   * Two spellings for one fact is how a scope goes missing: a link written with
   * one and read with the other resolves to nothing, and "nothing" is
   * indistinguishable from "the operator has not chosen" — so the surface
   * refuses for a selection that was in the URL all along.
   */
  const { requestedAccountId, source: accountParamSource } =
    readProviderAccountParam(searchParams, {
      onDeprecatedAlias: () => {
        console.warn("[meta-campaigns] deprecated accountId parameter", {
          // No id and no business id: this is a deprecation counter, not an
          // audit record, and it must not put a tenant identifier in the logs.
          canonical: PROVIDER_ACCOUNT_PARAM,
        });
      },
    });
  void accountParamSource;
  const campaignId = searchParams.get("campaignId");
  const includePrev = searchParams.get("includePrev") === "1";

  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const payload = await getMetaCampaignsForRange({
    businessId,
    startDate,
    endDate,
    accountId: requestedAccountId,
    campaignId,
    includePrev,
  });
  return NextResponse.json(payload satisfies MetaCampaignsResponse, {
    headers: { "Cache-Control": "no-store" },
  });
}
