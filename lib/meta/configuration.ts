export interface MetaConfigSnapshotPayload {
  campaignId?: string | null;
  objective?: string | null;
  optimizationGoal: string | null;
  customEventType?: string | null;
  pixelId?: string | null;
  customConversionId?: string | null;
  promotedObject?: unknown;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  manualBidAmount: number | null;
  bidValue: number | null;
  bidValueFormat: "currency" | "roas" | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  isBudgetMixed?: boolean;
  isConfigMixed?: boolean;
  isOptimizationGoalMixed?: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed?: boolean;
  isBidValueMixed?: boolean;
}

export interface MetaCampaignConfigSummary extends MetaConfigSnapshotPayload {
  previousManualBidAmount: number | null;
  previousBidValue: number | null;
}

export interface MetaPreviousSnapshotLike {
  campaignId?: string | null;
  manualBidAmount?: number | null;
  bidValue?: number | null;
  bidValueFormat?: "currency" | "roas" | null;
}

export function roundCurrencyAmount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

export function normalizeTargetRoasValue(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.abs(value) > 100 ? value / 10000 : value;
  return Math.round(normalized * 100) / 100;
}

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toTitleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function normalizeOptimizationGoal(value: string | null | undefined): string | null {
  const normalized = normalizeToken(value);
  if (!normalized) return null;

  const labelMap: Record<string, string> = {
    add_to_cart: "Add To Cart",
    complete_registration: "Complete Registration",
    landing_page_views: "Landing Page Views",
    lead_generation: "Lead",
    leads: "Lead",
    link_clicks: "Link Clicks",
    omni_purchase: "Purchase",
    page_likes: "Page Likes",
    post_engagement: "Post Engagement",
    quality_lead: "Quality Lead",
    reach: "Reach",
    search: "Search",
    thruplay: "ThruPlay",
    value: "Value",
  };

  return labelMap[normalized] ?? toTitleCase(normalized);
}

export function normalizeCustomEventType(value: string | null | undefined): string | null {
  const normalized = normalizeToken(value);
  if (!normalized) return null;

  const labelMap: Record<string, string> = {
    add_to_cart: "ADD_TO_CART",
    purchase: "PURCHASE",
    initiate_checkout: "INITIATE_CHECKOUT",
    view_content: "VIEW_CONTENT",
    lead: "LEAD",
    search: "SEARCH",
    add_payment_info: "ADD_PAYMENT_INFO",
    complete_registration: "COMPLETE_REGISTRATION",
  };

  return labelMap[normalized] ?? normalized.toUpperCase();
}

export function normalizeBidStrategy(
  strategy: string | null | undefined,
  manualBidAmount: number | null | undefined
): { type: string | null; label: string | null } {
  const normalized = normalizeToken(strategy);
  const hasManualBid = typeof manualBidAmount === "number" && Number.isFinite(manualBidAmount);

  if (!normalized) {
    return hasManualBid
      ? { type: "manual_bid", label: "Manual Bid" }
      : { type: null, label: null };
  }

  const strategyMap: Record<string, { type: string; label: string }> = {
    cost_cap: { type: "cost_cap", label: "Cost Cap" },
    bid_cap: { type: "bid_cap", label: "Bid Cap" },
    target_roas: { type: "target_roas", label: "Target ROAS" },
    lowest_cost: { type: "lowest_cost", label: "Lowest Cost" },
    manual_bid: { type: "manual_bid", label: "Manual Bid" },
    lowest_cost_with_bid_cap: { type: "bid_cap", label: "Bid Cap" },
    lowest_cost_without_cap: { type: "lowest_cost", label: "Lowest Cost" },
    lowest_cost_with_min_roas: { type: "target_roas", label: "Target ROAS" },
    target_cost: { type: "cost_cap", label: "Cost Cap" },
  };

  const mapped = strategyMap[normalized];
  if (mapped) return mapped;
  if (hasManualBid) return { type: "manual_bid", label: "Manual Bid" };
  return { type: normalized, label: toTitleCase(normalized) };
}

export function formatBidStrategyLabel(
  bidStrategyType: string | null | undefined
): string | null {
  return normalizeBidStrategy(bidStrategyType, null).label;
}

export function deriveManualBidAmount(
  bidValue: number | null | undefined,
  bidValueFormat: "currency" | "roas" | string | null | undefined
): number | null {
  return bidValueFormat === "currency" ? roundCurrencyAmount(bidValue) : null;
}

export function isMetaConstrainedBidStrategy(value: string | null | undefined) {
  const normalized = normalizeToken(value);
  return normalized === "bid_cap" || normalized === "cost_cap" || normalized === "target_roas";
}

export function stripIncompleteConstrainedBidFields<
  T extends {
    bidStrategyType?: string | null;
    bidValue?: number | null;
    bidValueFormat?: "currency" | "roas" | null;
    isBidValueMixed?: boolean;
  },
>(payload: T): T {
  if (!isMetaConstrainedBidStrategy(payload.bidStrategyType) || payload.bidValue != null) {
    return payload;
  }
  return {
    ...payload,
    bidStrategyType: null,
    bidValue: null,
    bidValueFormat: null,
    isBidValueMixed: false,
  };
}

export function withDerivedMetaConfigFields(
  payload: MetaConfigSnapshotPayload
): MetaConfigSnapshotPayload {
  return {
    ...payload,
    bidStrategyLabel:
      payload.bidStrategyLabel ?? formatBidStrategyLabel(payload.bidStrategyType),
    manualBidAmount:
      payload.manualBidAmount ??
      deriveManualBidAmount(payload.bidValue, payload.bidValueFormat),
  };
}

export function stripDerivedMetaConfigFields(
  payload: MetaConfigSnapshotPayload
): Omit<MetaConfigSnapshotPayload, "bidStrategyLabel" | "manualBidAmount"> {
  const { bidStrategyLabel: _bidStrategyLabel, manualBidAmount: _manualBidAmount, ...canonical } = payload;
  return canonical;
}

function summarizeSingleValue(values: Array<string | null | undefined>): {
  value: string | null;
  isMixed: boolean;
} {
  const normalized = values.map((value) => (value && String(value).trim() ? String(value).trim() : null));
  const unique = Array.from(new Set(normalized));
  const present = unique.filter((value): value is string => Boolean(value));

  if (present.length === 0) return { value: null, isMixed: false };
  if (present.length === 1 && unique.length === 1) return { value: present[0], isMixed: false };
  return { value: null, isMixed: true };
}

function summarizeSingleValueIgnoringNull(values: Array<string | null | undefined>): {
  value: string | null;
  isMixed: boolean;
} {
  const present = Array.from(
    new Set(
      values
        .map((value) => (value && String(value).trim() ? String(value).trim() : null))
        .filter((value): value is string => Boolean(value))
    )
  );

  if (present.length === 0) return { value: null, isMixed: false };
  if (present.length === 1) return { value: present[0], isMixed: false };
  return { value: null, isMixed: true };
}

function summarizeNumericValue(values: Array<number | null | undefined>): {
  value: number | null;
  isMixed: boolean;
} {
  const normalized = values.map((value) => roundCurrencyAmount(value));
  const unique = Array.from(new Set(normalized));
  const present = unique.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (present.length === 0) return { value: null, isMixed: false };
  if (present.length === 1 && unique.length === 1) return { value: present[0], isMixed: false };
  return { value: null, isMixed: true };
}

function summarizeNumericValueIgnoringNull(values: Array<number | null | undefined>): {
  value: number | null;
  isMixed: boolean;
} {
  const present = Array.from(
    new Set(
      values
        .map((value) => roundCurrencyAmount(value))
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    )
  );

  if (present.length === 0) return { value: null, isMixed: false };
  if (present.length === 1) return { value: present[0], isMixed: false };
  return { value: null, isMixed: true };
}

export function buildConfigSnapshotPayload(input: {
  campaignId?: string | null;
  objective?: string | null;
  optimizationGoal?: string | null;
  customEventType?: string | null;
  pixelId?: string | null;
  customConversionId?: string | null;
  promotedObject?: unknown;
  bidStrategy?: string | null;
  manualBidAmount?: number | null;
  targetRoas?: number | null;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  isBudgetMixed?: boolean;
  isConfigMixed?: boolean;
  isOptimizationGoalMixed?: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed?: boolean;
  isBidValueMixed?: boolean;
}): MetaConfigSnapshotPayload {
  const manualBidAmount = roundCurrencyAmount(input.manualBidAmount);
  const strategy = normalizeBidStrategy(input.bidStrategy, manualBidAmount);
  const bidValue =
    strategy.type === "target_roas"
      ? normalizeTargetRoasValue(input.targetRoas)
      : manualBidAmount;
  const bidValueFormat = strategy.type === "target_roas"
    ? "roas"
    : bidValue != null
      ? "currency"
      : null;

  return {
    campaignId: input.campaignId ?? null,
    objective: input.objective?.trim() ? input.objective.trim() : null,
    optimizationGoal: normalizeOptimizationGoal(input.optimizationGoal),
    customEventType: normalizeCustomEventType(input.customEventType),
    pixelId: input.pixelId?.trim() ? input.pixelId.trim() : null,
    customConversionId: input.customConversionId?.trim() ? input.customConversionId.trim() : null,
    promotedObject: input.promotedObject ?? null,
    bidStrategyType: strategy.type,
    bidStrategyLabel: strategy.label,
    manualBidAmount,
    bidValue,
    bidValueFormat,
    dailyBudget: roundCurrencyAmount(input.dailyBudget),
    lifetimeBudget: roundCurrencyAmount(input.lifetimeBudget),
    isBudgetMixed: Boolean(input.isBudgetMixed),
    isConfigMixed: Boolean(input.isConfigMixed),
    isOptimizationGoalMixed: Boolean(input.isOptimizationGoalMixed),
    isCustomEventTypeMixed: Boolean(input.isCustomEventTypeMixed),
    isBidStrategyMixed: Boolean(input.isBidStrategyMixed),
    isBidValueMixed: Boolean(input.isBidValueMixed),
  };
}

export function summarizeCampaignConfig(input: {
  campaignId?: string | null;
  campaignDailyBudget?: number | null;
  campaignLifetimeBudget?: number | null;
  campaignBidStrategy?: string | null;
  campaignManualBidAmount?: number | null;
  targetRoas?: number | null;
  adsets: MetaConfigSnapshotPayload[];
  previousAdsets?: MetaPreviousSnapshotLike[];
  previousCampaignManualBidAmount?: number | null;
}): MetaCampaignConfigSummary {
  const optimizationSummary = summarizeSingleValue(
    input.adsets.map((adset) => adset.optimizationGoal)
  );
  const customEventTypeSummary = summarizeSingleValue(
    input.adsets.map((adset) => adset.customEventType)
  );
  const bidStrategySummary = summarizeSingleValueIgnoringNull(
    input.adsets.map((adset) => adset.bidStrategyLabel)
  );
  const bidStrategyTypeSummary = summarizeSingleValueIgnoringNull(
    input.adsets.map((adset) => adset.bidStrategyType)
  );
  const manualBidSummary = summarizeNumericValue(
    input.adsets.map((adset) => adset.manualBidAmount)
  );
  const bidValueSummary = summarizeNumericValueIgnoringNull(
    input.adsets.map((adset) => adset.bidValue)
  );
  const bidValueFormatSummary = summarizeSingleValueIgnoringNull(
    input.adsets.map((adset) => adset.bidValueFormat)
  );
  const previousManualBidSummary = summarizeNumericValue(
    (input.previousAdsets ?? []).map((adset) => adset.manualBidAmount ?? null)
  );
  const previousBidValueSummary = summarizeNumericValueIgnoringNull(
    (input.previousAdsets ?? []).map((adset) => adset.bidValue ?? null)
  );
  const adsetDailyBudgetSummary = summarizeNumericValue(
    input.adsets.map((adset) => adset.dailyBudget)
  );
  const fallbackStrategy = normalizeBidStrategy(
    input.campaignBidStrategy,
    input.campaignManualBidAmount ?? null
  );
  const fallbackBidValue =
    fallbackStrategy.type === "target_roas"
      ? normalizeTargetRoasValue(input.targetRoas)
      : roundCurrencyAmount(input.campaignManualBidAmount);
  const fallbackBidValueFormat =
    fallbackStrategy.type === "target_roas"
      ? "roas"
      : fallbackBidValue != null
        ? "currency"
        : null;

  return {
    campaignId: input.campaignId ?? null,
    optimizationGoal: optimizationSummary.isMixed ? null : optimizationSummary.value,
    customEventType: customEventTypeSummary.isMixed ? null : customEventTypeSummary.value,
    pixelId: null,
    customConversionId: null,
    promotedObject: null,
    bidStrategyType: bidStrategyTypeSummary.isMixed
      ? fallbackStrategy.type
      : bidStrategyTypeSummary.value ?? fallbackStrategy.type,
    bidStrategyLabel: bidStrategySummary.isMixed
      ? fallbackStrategy.label
      : bidStrategySummary.value ?? fallbackStrategy.label,
    manualBidAmount: manualBidSummary.isMixed ? null : manualBidSummary.value,
    bidValue: bidValueSummary.isMixed
      ? null
      : bidValueSummary.value ?? fallbackBidValue,
    bidValueFormat: bidValueFormatSummary.isMixed
      ? null
      : (bidValueFormatSummary.value as "currency" | "roas" | null) ?? fallbackBidValueFormat,
    previousManualBidAmount: previousManualBidSummary.isMixed
      ? null
      : previousManualBidSummary.value ?? roundCurrencyAmount(input.previousCampaignManualBidAmount),
    previousBidValue: previousBidValueSummary.isMixed
      ? null
      : previousBidValueSummary.value ?? previousManualBidSummary.value ?? null,
    dailyBudget:
      roundCurrencyAmount(input.campaignDailyBudget) ?? adsetDailyBudgetSummary.value,
    lifetimeBudget: roundCurrencyAmount(input.campaignLifetimeBudget),
    isBudgetMixed:
      roundCurrencyAmount(input.campaignDailyBudget) == null &&
      (adsetDailyBudgetSummary.isMixed ||
        input.adsets.some((adset) => adset.lifetimeBudget != null)),
    isConfigMixed:
      optimizationSummary.isMixed ||
      customEventTypeSummary.isMixed ||
      bidStrategySummary.isMixed ||
      manualBidSummary.isMixed ||
      bidValueSummary.isMixed ||
      bidValueFormatSummary.isMixed,
    isOptimizationGoalMixed: optimizationSummary.isMixed,
    isCustomEventTypeMixed: customEventTypeSummary.isMixed,
    isBidStrategyMixed: bidStrategySummary.isMixed || bidStrategyTypeSummary.isMixed,
    isBidValueMixed: bidValueSummary.isMixed || bidValueFormatSummary.isMixed,
  };
}
