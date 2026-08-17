import type {
  BudgetCampaign,
} from "@/components/google-ads/BudgetScalingTab";
import type {
  Campaign,
} from "@/components/google-ads/google-ads-dashboard-support";
import type {
  GoogleAdsCanonicalOverviewSummaryResult,
  GoogleAdsCanonicalTrendResult,
} from "@/lib/google-ads/serving";
import type {
  GoogleAdvisorBudgetReallocationPayload,
  GoogleRecommendation,
} from "@/lib/google-ads/growth-advisor-types";
import type {
  GoogleOverviewBudgetRecommendationModel,
  GoogleOverviewCampaignModel,
  GoogleOverviewChartModel,
  GoogleOverviewChartValueKind,
  GoogleOverviewExactModel,
  GoogleOverviewFreshnessState,
  GoogleOverviewLookCardModel,
  GoogleOverviewMetricModel,
  GoogleOverviewRouteTarget,
} from "@/components/google-ads/google-overview-exact-model";

type OverviewSummarySource = Pick<
  GoogleAdsCanonicalOverviewSummaryResult,
  "kpis" | "kpiDeltas"
> & {
  summary?: GoogleAdsCanonicalOverviewSummaryResult["summary"];
  meta?: Partial<GoogleAdsCanonicalOverviewSummaryResult["meta"]>;
};

type OverviewTrendSource = Pick<GoogleAdsCanonicalTrendResult, "points">;

export interface GoogleOverviewExactAdapterInput {
  identity: {
    businessId: string;
    /** Explicit null is authoritative: the adapter never recovers an account from the URL. */
    providerAccountId: string | null;
  };
  currencyCode: string | null;
  window: {
    label: string | null;
    days: number | null;
  };
  freshness: {
    label: string | null;
    state: GoogleOverviewFreshnessState;
  };
  summary: OverviewSummarySource | null;
  currentTrends: OverviewTrendSource | null;
  previousTrends?: OverviewTrendSource | null;
  campaigns: Campaign[] | null;
  advisorRecommendations: GoogleRecommendation[] | null;
  budgetCampaigns: BudgetCampaign[] | null;
  targets?: {
    roas?: number | null;
    breakevenRoas?: number | null;
  };
}

const DASH = "—";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clean(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : DASH;
}

function readableSummary(
  source: OverviewSummarySource | null,
): OverviewSummarySource | null {
  const meta = source?.meta;
  if (
    !source ||
    !meta ||
    meta.dataState !== "ready" ||
    meta.partial !== false ||
    meta.isPartial !== false
  ) {
    return null;
  }

  const completion = meta.completion;
  if (
    completion &&
    (!completion.evidenceAvailable ||
      (completion.state !== "converging" && completion.state !== "settled"))
  ) {
    return null;
  }

  const hasReadRows =
    Object.values(meta.row_counts ?? {}).some((value) => {
      const count = finite(value);
      return count !== null && count > 0;
    }) ||
    (finite(source.summary?.totalAccounts) ?? 0) > 0;
  return hasReadRows ? source : null;
}

function validCurrencyCode(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return null;
  try {
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalized,
    }).format(0);
    return normalized;
  } catch {
    return null;
  }
}

function formatCurrency(
  value: number | null,
  currencyCode: string | null,
  digits: 0 | 2,
): string {
  if (value === null || currencyCode === null) return DASH;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatNumber(value: number | null, digits = 0): string {
  if (value === null) return DASH;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatCompact(value: number | null): string {
  if (value === null) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled.toFixed(Math.abs(scaled) >= 10 ? 0 : 1)}m`;
  }
  if (abs >= 1_000) {
    const scaled = value / 1_000;
    return `${scaled.toFixed(Math.abs(scaled) >= 100 ? 0 : 1)}k`;
  }
  return formatNumber(value);
}

function formatPercentValue(value: number | null, digits = 1): string {
  return value === null ? DASH : `${value.toFixed(digits)}%`;
}

function formatRatioPercent(value: number | null, digits = 0): string {
  if (value === null) return DASH;
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `${percent.toFixed(digits)}%`;
}

function asSharePercent(value: number | null): number | null {
  // The canonical campaign serving contract already exposes percentage points
  // (for example 46 means 46%). Treating sub-1 values as ratios turns a real
  // 0.46% campaign into 46%, so preserve the server unit exactly.
  return value;
}

function delta(value: number | null, withComparisonLabel = false) {
  if (value === null) {
    return { value: DASH, tone: "neutral" as const };
  }
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return {
    value: `${sign}${Math.abs(value).toFixed(1)}%${withComparisonLabel ? " vs prev" : ""}`,
    tone:
      value > 0
        ? ("positive" as const)
        : value < 0
          ? ("negative" as const)
          : ("neutral" as const),
  };
}

type TrendMetric =
  | "spend"
  | "revenue"
  | "roas"
  | "conversions"
  | "cpa"
  | "cpc"
  | "ctr"
  | "convRate"
  | "impressions"
  | "clicks";

type TrendPoint = GoogleAdsCanonicalTrendResult["points"][number];

function trendValue(point: TrendPoint | undefined, metric: TrendMetric): number | null {
  if (!point) return null;
  if (metric === "convRate") {
    const conversions = finite(point.conversions);
    const clicks = finite(point.clicks);
    return conversions !== null && clicks !== null && clicks > 0
      ? (conversions / clicks) * 100
      : null;
  }
  return finite(point[metric]);
}

function chart(
  id: string,
  valueKind: GoogleOverviewChartValueKind,
  metric: TrendMetric,
  current: OverviewTrendSource | null,
  previous: OverviewTrendSource | null | undefined,
): GoogleOverviewChartModel {
  return {
    id,
    valueKind,
    points: (current?.points ?? []).map((point, index) => ({
      date: point.date,
      current: trendValue(point, metric),
      previous: trendValue(previous?.points[index], metric),
    })),
  };
}

function lookTarget(recommendation: GoogleRecommendation): GoogleOverviewRouteTarget | null {
  switch (recommendation.type) {
    case "product_allocation":
    case "shopping_launch_or_split":
    case "search_shopping_overlap":
      return "products";
    case "keyword_buildout":
      return "keywords";
    case "query_governance":
    case "brand_capture_control":
    case "brand_leakage":
    case "non_brand_expansion":
    case "orphaned_non_brand_demand":
      return "search";
    case "budget_reallocation":
      return "advisor";
    default:
      return null;
  }
}

function targetLabel(target: GoogleOverviewRouteTarget | null): string {
  switch (target) {
    case "products":
      return "Open Products";
    case "search":
      return "Open Search";
    case "advisor":
      return "See Advisor";
    case "keywords":
      return "Open Keywords";
    default:
      return DASH;
  }
}

function placeholderLook(index: number): GoogleOverviewLookCardModel {
  return {
    id: `look-placeholder-${index}`,
    severity: DASH,
    tone: "neutral",
    title: DASH,
    description: DASH,
    evidence: DASH,
    actionLabel: DASH,
    target: null,
  };
}

function buildLookCards(
  recommendations: GoogleRecommendation[] | null,
): GoogleOverviewExactModel["lookCards"] {
  const cards = (recommendations ?? []).slice(0, 4).map((recommendation) => {
    const target = lookTarget(recommendation);
    return {
      id: recommendation.id,
      // The provider contract does not serve the prototype's
      // Critical/Waste/Opportunity/Positive vocabulary. Decision family and
      // blocker presence are evidence, but relabelling them as a severity is a
      // new client-side decision. Keep the fixed slot honest until the server
      // publishes an explicit compatible field.
      severity: DASH,
      tone: "neutral",
      title: clean(recommendation.title),
      description: clean(recommendation.summary),
      evidence: clean(
        recommendation.rankExplanation ||
          recommendation.whyNow ||
          recommendation.confidenceExplanation,
      ),
      actionLabel: targetLabel(target),
      target,
    } satisfies GoogleOverviewLookCardModel;
  });
  return [
    cards[0] ?? placeholderLook(0),
    cards[1] ?? placeholderLook(1),
    cards[2] ?? placeholderLook(2),
    cards[3] ?? placeholderLook(3),
  ];
}

function campaignTone(
  value: number | null,
  target: number | null,
): GoogleOverviewCampaignModel["roasTone"] {
  if (value === null || target === null || target <= 0) return "neutral";
  if (value >= target) return "positive";
  if (value >= target * 0.75) return "neutral";
  return "warning";
}

function campaignTypeTone(channel: string): GoogleOverviewCampaignModel["typeTone"] {
  const normalized = channel.trim().toLowerCase();
  if (normalized.includes("performance max") || normalized === "pmax") return "info";
  if (normalized.includes("shopping")) return "auto";
  return "neutral";
}

function buildCampaigns(input: {
  rows: Campaign[] | null;
  budgets: BudgetCampaign[] | null;
  currencyCode: string | null;
  roasTarget: number | null;
}): GoogleOverviewCampaignModel[] {
  const visible = (input.rows ?? []).slice(0, 4);
  const budgetById = new Map<string, number>();
  const budgetByName = new Map<string, number>();
  for (const budget of input.budgets ?? []) {
    if (Number.isFinite(budget.dailyBudget)) {
      budgetById.set(String(budget.id), budget.dailyBudget);
      budgetByName.set(budget.name.trim().toLowerCase(), budget.dailyBudget);
    }
  }
  return visible.map((row) => {
    const share = asSharePercent(finite(row.spendShare));
    const dailyBudget =
      budgetById.get(String(row.id)) ?? budgetByName.get(row.name.trim().toLowerCase());
    const roas = finite(row.roas);
    const lost = finite(row.lostIsBudget);
    const formattedDailyBudget = formatCurrency(
      finite(dailyBudget),
      input.currencyCode,
      0,
    );
    return {
      id: row.id,
      name: clean(row.name),
      type: clean(row.channel),
      typeTone: campaignTypeTone(row.channel),
      dailyBudget:
        formattedDailyBudget === DASH ? DASH : `${formattedDailyBudget}/day`,
      spend: formatCurrency(finite(row.spend), input.currencyCode, 0),
      spendShare: share === null ? DASH : `${share.toFixed(0)}%`,
      spendShareWidth: share === null ? 0 : Math.max(0, Math.min(100, share)),
      revenue: formatCurrency(finite(row.revenue), input.currencyCode, 0),
      roas: roas === null ? DASH : roas.toFixed(2),
      roasTone: campaignTone(roas, input.roasTarget),
      conversions: formatNumber(finite(row.conversions)),
      impressionShare: formatRatioPercent(finite(row.impressionShare)),
      lostImpressionShareBudget: formatRatioPercent(lost),
      lostImpressionShareTone:
        lost !== null && lost > 0 ? "warning" : "neutral",
      // There is no server-owned delivery-pulse contract on Campaign.
      pulse: DASH,
      pulseTone: "neutral",
    };
  });
}

interface NativeBudgetRecommendation {
  id: string;
  campaign: string;
  deltaAmount: number;
  direction: "increase" | "decrease";
  reason: string;
}

interface NativeBudgetPreview {
  recommendationId: string;
  payload: GoogleAdvisorBudgetReallocationPayload;
  recommendations: NativeBudgetRecommendation[];
}

function getNativeBudgetPreview(
  recommendations: GoogleRecommendation[] | null,
): NativeBudgetPreview | null {
  if (!recommendations) return null;
  for (const recommendation of recommendations) {
    const card = recommendation.operatorActionCard;
    if (
      recommendation.type !== "budget_reallocation" ||
      !card ||
      card.contractVersion !== "google_ads_advisor_action_v2" ||
      card.contractSource !== "native" ||
      card.exactChangePayload.kind !== "budget_reallocation" ||
      card.exactChangePayload.estimateMode !== "bounded_preview"
    ) {
      continue;
    }
    const payload = card.exactChangePayload;
    if (
      payload.sourceCampaigns.length === 0 ||
      payload.destinationCampaigns.length === 0 ||
      finite(payload.netDelta) !== 0 ||
      [...payload.sourceCampaigns, ...payload.destinationCampaigns].some(
        (campaign) =>
          finite(campaign.previousAmount) === null ||
          finite(campaign.proposedAmount) === null ||
          finite(campaign.deltaAmount) === null,
      )
    ) {
      return null;
    }
    const reason = clean(card.whyThisNow);
    const mapped: NativeBudgetRecommendation[] = [
      ...payload.destinationCampaigns.map((campaign, index) => ({
        id: `${recommendation.id}-destination-${campaign.id}-${index}`,
        campaign: clean(campaign.name),
        deltaAmount: campaign.deltaAmount,
        direction: "increase" as const,
        reason,
      })),
      ...payload.sourceCampaigns.map((campaign, index) => ({
        id: `${recommendation.id}-source-${campaign.id}-${index}`,
        campaign: clean(campaign.name),
        deltaAmount: campaign.deltaAmount,
        direction: "decrease" as const,
        reason,
      })),
    ];
    if (mapped.some((item) => finite(item.deltaAmount) === null)) return null;
    return {
      recommendationId: recommendation.id,
      payload,
      recommendations: mapped,
    };
  }
  return null;
}

function budgetAmount(
  recommendation: NativeBudgetRecommendation,
  currencyCode: string | null,
): string {
  const amount = finite(recommendation.deltaAmount);
  if (amount === null) return DASH;
  const formatted = formatCurrency(Math.abs(amount), currencyCode, 0);
  if (formatted === DASH) return DASH;
  return `${recommendation.direction === "increase" ? "+" : "−"}${formatted}/day`;
}

function placeholderBudgetRecommendation(index: number): GoogleOverviewBudgetRecommendationModel {
  return {
    id: `budget-placeholder-${index}`,
    campaign: DASH,
    amount: DASH,
    direction: "neutral",
    reason: DASH,
  };
}

function buildBudgetRecommendations(
  preview: NativeBudgetPreview | null,
  currencyCode: string | null,
): GoogleOverviewExactModel["budgetRecommendations"] {
  const cards = (preview?.recommendations ?? []).slice(0, 3).map((recommendation) => ({
    id: recommendation.id,
    campaign: clean(recommendation.campaign),
    amount: budgetAmount(recommendation, currencyCode),
    direction: recommendation.direction,
    reason: clean(recommendation.reason),
  } satisfies GoogleOverviewBudgetRecommendationModel));
  return [
    cards[0] ?? placeholderBudgetRecommendation(0),
    cards[1] ?? placeholderBudgetRecommendation(1),
    cards[2] ?? placeholderBudgetRecommendation(2),
  ];
}

function formatDailyShift(
  value: number | null,
  currencyCode: string | null,
): string {
  const formatted = formatCurrency(value, currencyCode, 0);
  return formatted === DASH ? DASH : `${formatted}/day`;
}

function buildBudgetKpis(input: {
  campaigns: BudgetCampaign[] | null;
  preview: NativeBudgetPreview | null;
  currencyCode: string | null;
}): GoogleOverviewExactModel["budgetKpis"] {
  const increases = input.preview?.recommendations.filter((item) => item.direction === "increase");
  const decreases = input.preview?.recommendations.filter((item) => item.direction === "decrease");
  const limited = input.campaigns?.filter(
    (campaign) => finite(campaign.lostIsBudget) !== null && (campaign.lostIsBudget as number) > 0,
  );
  const sourceBudgetRows =
    input.preview === null || input.campaigns === null
      ? null
      : input.preview.payload.sourceCampaigns.map((source) =>
          input.campaigns?.find(
            (campaign) =>
              String(campaign.id) === String(source.id) ||
              (source.name
                ? campaign.name.trim().toLowerCase() === source.name.trim().toLowerCase()
                : false),
          ),
        );
  const lowEfficiencySpend =
    sourceBudgetRows === null ||
    sourceBudgetRows.some((campaign) => !campaign || finite(campaign.spend) === null)
      ? null
      : sourceBudgetRows.reduce(
          (sum, campaign) => sum + (campaign ? (finite(campaign.spend) as number) : 0),
          0,
        );

  const allAmountsKnown =
    input.preview !== null &&
    input.preview.recommendations.every(
      (recommendation) => finite(recommendation.deltaAmount) !== null,
    );
  const increaseTotal = allAmountsKnown
    ? (increases ?? []).reduce(
        (sum, recommendation) => sum + Math.abs(recommendation.deltaAmount),
        0,
      )
    : null;
  const decreaseTotal = allAmountsKnown
    ? (decreases ?? []).reduce(
        (sum, recommendation) => sum + Math.abs(recommendation.deltaAmount),
        0,
      )
    : null;
  const balanced =
    increaseTotal !== null &&
    decreaseTotal !== null &&
    increaseTotal > 0 &&
    decreaseTotal > 0 &&
    finite(input.preview?.payload.netDelta) === 0 &&
    Math.abs(increaseTotal - decreaseTotal) < 0.005;
  const shift =
    increaseTotal === null || decreaseTotal === null
      ? null
      : balanced
        ? increaseTotal
        : Math.abs(increaseTotal - decreaseTotal);

  return [
    {
      key: "ready-to-scale",
      label: "Ready to scale",
      value: increases === undefined ? DASH : String(increases.length),
      detail: increases?.[0] ? clean(increases[0].campaign) : DASH,
    },
    {
      key: "budget-limited",
      label: "Budget-limited",
      value: limited === undefined ? DASH : String(limited.length),
      detail: "losing IS to budget",
    },
    {
      key: "low-efficiency-spend",
      label: "Low-efficiency spend",
      value: formatCurrency(lowEfficiencySpend, input.currencyCode, 0),
      detail: input.preview?.payload.sourceCampaigns[0]
        ? clean(input.preview.payload.sourceCampaigns[0].name)
        : DASH,
    },
    {
      key: "suggested-net-shift",
      label: "Suggested net shift",
      value: formatDailyShift(shift, input.currencyCode),
      detail: shift === null ? DASH : balanced ? "moved, not added" : "net daily change",
    },
  ];
}

export function buildGoogleOverviewExactModel(
  input: GoogleOverviewExactAdapterInput,
): GoogleOverviewExactModel {
  const currencyCode = validCurrencyCode(input.currencyCode);
  const summary = readableSummary(input.summary);
  const kpis = summary?.kpis;
  const deltas = summary?.kpiDeltas;
  const windowDays =
    input.window.days !== null &&
    Number.isFinite(input.window.days) &&
    input.window.days > 0
      ? Math.round(input.window.days)
      : null;
  const windowLabel = clean(
    input.window.label ?? (windowDays === null ? null : `${windowDays}d`),
  );
  const spend = finite(kpis?.spend);
  const revenue = finite(kpis?.revenue);
  const roas = finite(kpis?.roas);
  const conversions = finite(kpis?.conversions);
  const cpa = finite(kpis?.cpa);
  const cpc = finite(kpis?.cpc);
  const ctr = finite(kpis?.ctr);
  const convRate = finite(kpis?.convRate);
  const impressions = finite(kpis?.impressions);
  const clicks = finite(kpis?.clicks);
  const roasTarget = finite(input.targets?.roas);
  const breakevenRoas = finite(input.targets?.breakevenRoas);
  const spendDelta = delta(finite(deltas?.spend), true);
  const revenueDelta = delta(finite(deltas?.revenue));
  const roasDelta = delta(finite(deltas?.roas));
  const conversionDelta = delta(finite(deltas?.conversions));

  const hero: GoogleOverviewExactModel["hero"] = [
    {
      key: "spend",
      label: `Spend · ${windowLabel}`,
      value: formatCurrency(spend, currencyCode, 0),
      delta: spendDelta.value,
      deltaTone: spendDelta.tone,
      detail:
        spend !== null && windowDays !== null
          ? `${formatCurrency(spend / windowDays, currencyCode, 0)}/day avg`
          : DASH,
      chart: chart(
        "google-overview-spend",
        "currency-0",
        "spend",
        input.currentTrends,
        input.previousTrends,
      ),
    },
    {
      key: "conversion-value",
      label: "Conv value",
      value: formatCurrency(revenue, currencyCode, 0),
      delta: revenueDelta.value,
      deltaTone: revenueDelta.tone,
      detail:
        revenue !== null && conversions !== null && conversions > 0
          ? `AOV ${formatCurrency(revenue / conversions, currencyCode, 2)}`
          : DASH,
      chart: chart(
        "google-overview-revenue",
        "currency-0",
        "revenue",
        input.currentTrends,
        input.previousTrends,
      ),
    },
    {
      key: "roas",
      label: "ROAS",
      value: roas === null ? DASH : roas.toFixed(2),
      delta:
        roasTarget === null
          ? roasDelta.value
          : `${roas !== null && Math.abs(roas - roasTarget) < 0.005 ? "on target" : "target"} · ${roasTarget.toFixed(2)}`,
      deltaTone:
        roasTarget === null
          ? roasDelta.tone
          : "neutral",
      detail: breakevenRoas === null ? DASH : `breakeven ${breakevenRoas.toFixed(2)}`,
      chart: chart(
        "google-overview-roas",
        "decimal-2",
        "roas",
        input.currentTrends,
        input.previousTrends,
      ),
    },
    {
      key: "conversions",
      label: "Conversions",
      value: formatNumber(conversions),
      delta: conversionDelta.value,
      deltaTone: conversionDelta.tone,
      detail: cpa === null ? DASH : `CPA ${formatCurrency(cpa, currencyCode, 2)}`,
      chart: chart(
        "google-overview-conversions",
        "integer",
        "conversions",
        input.currentTrends,
        input.previousTrends,
      ),
    },
  ];

  const secondary: GoogleOverviewExactModel["secondary"] = [
    {
      key: "cpa",
      label: "CPA",
      value: formatCurrency(cpa, currencyCode, 2),
      chart: chart("google-overview-cpa", "currency-2", "cpa", input.currentTrends, input.previousTrends),
    },
    {
      key: "cpc",
      label: "CPC",
      value: formatCurrency(cpc, currencyCode, 2),
      chart: chart("google-overview-cpc", "currency-2", "cpc", input.currentTrends, input.previousTrends),
    },
    {
      key: "ctr",
      label: "CTR",
      value: formatPercentValue(ctr),
      chart: chart("google-overview-ctr", "percent-1", "ctr", input.currentTrends, input.previousTrends),
    },
    {
      key: "conversion-rate",
      label: "Conv rate",
      value: formatPercentValue(convRate),
      chart: chart(
        "google-overview-conversion-rate",
        "percent-1",
        "convRate",
        input.currentTrends,
        input.previousTrends,
      ),
    },
    {
      key: "impressions",
      label: "Impressions",
      value: formatCompact(impressions),
      chart: chart(
        "google-overview-impressions",
        "compact",
        "impressions",
        input.currentTrends,
        input.previousTrends,
      ),
    },
    {
      key: "clicks",
      label: "Clicks",
      value: formatCompact(clicks),
      chart: chart("google-overview-clicks", "integer", "clicks", input.currentTrends, input.previousTrends),
    },
  ];

  const campaigns = buildCampaigns({
    rows: input.campaigns,
    budgets: input.budgetCampaigns,
    currencyCode,
    roasTarget,
  });
  const activeCount =
    input.campaigns === null
      ? DASH
      : String(
          input.campaigns.filter((campaign) => {
            const status = campaign.status.trim().toLowerCase();
            return status === "active" || status === "enabled";
          }).length,
        );

  const nativeBudgetPreview = getNativeBudgetPreview(input.advisorRecommendations);

  return {
    identity: {
      businessId: input.identity.businessId,
      providerAccountId: clean(input.identity.providerAccountId),
      currencyCode: currencyCode ?? DASH,
      windowLabel,
      windowDays,
    },
    freshness: {
      label: clean(input.freshness.label),
      state: input.freshness.state,
    },
    hero,
    secondary,
    lookCards: buildLookCards(input.advisorRecommendations),
    campaigns,
    campaignSummary: `${activeCount} active · vs target ${roasTarget === null ? DASH : roasTarget.toFixed(2)} · impression-share signals are Google-served`,
    // The current read contract proves a bounded recommendation payload, not
    // that the Plan route can apply it through a guarded provider write.
    budgetNote: DASH,
    budgetKpis: buildBudgetKpis({
      campaigns: input.budgetCampaigns,
      preview: nativeBudgetPreview,
      currencyCode,
    }),
    budgetRecommendations: buildBudgetRecommendations(
      nativeBudgetPreview,
      currencyCode,
    ),
  };
}
