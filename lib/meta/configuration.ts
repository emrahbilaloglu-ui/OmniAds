import { MAX_MINOR_UNITS } from "@/lib/currency/iso-4217-minor-units";
export interface MetaConfigSnapshotPayload {
  /** Raw provider receipt provenance; absent on legacy or unlinked UI snapshots. */
  providerObservation?: {
    kind: "provider_config_receipt";
    /** Canonical CONTENT id; shared by every re-read of that content. */
    sourceSnapshotId: string;
    /**
     * RECEIPT id: one real provider GET, from
     * `meta_raw_snapshot_observations.id`. Distinct from `sourceSnapshotId`,
     * which payload deduplication shares across re-reads. Absent on a legacy
     * snapshot-only receipt, which has no observation row.
     */
    sourceObservationId?: string | null;
    observedAt: string;
    /** Provider entity mutation clock, used to prove a whole report day. */
    entityUpdatedAt?: string | null;
    /** Later complete receipt confirming the day ended without a config edit. */
    corroboratingSourceSnapshotId?: string | null;
    /** The day-closing witness's RECEIPT id; see `sourceObservationId`. */
    corroboratingObservationId?: string | null;
    corroboratingObservedAt?: string | null;
    normalizationVersion: number;
    /** Fields actually present on this entity, distinct from the selector. */
    observedFieldScope?: string[];
    fieldScope: string[];
  };
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


/**
 * ── THE BID VALUE UNIT CONTRACT ─────────────────────────────────────────────
 *
 * `bidValue` carries TWO different number systems in one column, discriminated
 * ONLY by `bidValueFormat`. Reading it without that discriminator is a bug
 * regardless of scale.
 *
 *   bidValueFormat "currency" -> PROVIDER MINOR UNITS, exactly as Meta returned
 *                                `bid_amount`. Never rescaled on the way in.
 *   bidValueFormat "roas"     -> a plain multiplier (2.5 means 2.5x), already
 *                                divided down from Meta's scaled integer by
 *                                `metaTargetRoasFromProviderFloor`, ONCE, on
 *                                the way in. A reader never divides it again.
 *
 * WHY MINOR, ESTABLISHED FROM FOUR INDEPENDENT DIRECTIONS:
 *
 *  1. Ingest does not scale. `lib/meta/live.ts` stores `parseNum(bid_amount)`
 *     straight through, and the raw-config receipt reader does the same.
 *  2. The stored distribution. 294,991 currency bid rows across all retained
 *     history contain ZERO fractional values and none below 1, ranging 30 to
 *     500,000. A major-unit column would show cents; a $500,000 ad-set bid cap
 *     would not.
 *  3. The live provider value. Read-only Graph GET on TheSwaf ad set
 *     `120251964734540042` returns a bid amount of 120 USD while this warehouse
 *     stores `bid_value = 12000` for the same ad set — exactly 100x. The
 *     advertiser's own name for it is `TS_DPA_US_BID120`.
 *  4. The repository already says so. `lib/currency/iso-4217-minor-units.ts`
 *     opens with "The repository invariant asserts Meta budget values are
 *     provider minor units", and two display consumers already divide by 100.
 *
 * WHAT THIS FIXES: `lib/meta/intent-projection-context.ts` read the stored
 * value as MAJOR and multiplied it by `10 ** exponent` again, so a $120.00 cap
 * became a $12,000.00 cap before sizing. On JPY (exponent 0) that error is
 * invisible; on KWD (exponent 3) it is 1000x. No stored value changes here —
 * the rows were always minor units; only the reader that misread them does.
 *
 * NOTHING IS SILENTLY REINTERPRETED. A stored value that is not a non-negative
 * integer cannot be a provider minor-unit amount under this contract, so it is
 * REFUSED rather than rounded into one. Today that costs nothing — zero such
 * rows exist, and no migration, backfill or script in this repository has ever
 * multiplied or divided a stored bid value, so the column has carried one
 * convention throughout. `lib/meta/warehouse.ts` even asserts it at runtime,
 * throwing `meta_current_config_history_bid_value_source_mismatch` unless the
 * stored value equals the raw provider `bid_amount`. The refusal is what stops
 * a row written under some other convention from ever being read as money.
 *
 * ── WHY THIS DOES NOT DEPEND ON THE EXPONENT ────────────────────────────────
 *
 * Meta publishes its OWN per-currency `offset` (a MULTIPLIER, 100 or 1 — not an
 * exponent; `10 ** offset` would be catastrophic), and it does NOT always agree
 * with the ISO-4217 minor-unit exponent this repository resolves. Verified
 * against https://developers.facebook.com/docs/marketing-api/currencies:
 *
 *   HUF, IDR, TWD, COP   Meta offset 1  vs repo exponent 2   -> 100x apart
 *   BHD, JOD             Meta offset 100 vs repo exponent 3  -> 10x apart
 *   CRC                  Meta offset 1, absent from the repo registry, so it
 *                        fails closed rather than diverging
 *   KWD, OMR, TND, IQD, LYD   not in Meta's list at all
 *   USD, TRY, GBP, JPY   agree, and those are the currencies this product
 *                        actually runs today
 *
 * The repository cannot even see Meta's number: there is not one reference to
 * `currency_offset` or `offsetted_amount` anywhere in the tree, and
 * `lib/api/meta.ts` labels the provenance `"client_registry"` — honestly, but
 * it is still a client guess about a provider fact.
 *
 * NONE OF THAT CAN CORRUPT A BID HERE, because this conversion does not scale:
 * the stored number is returned as-is, so the answer is identical at every
 * exponent. The exponent is required only so that a currency whose scale is
 * unknown fails closed in one place rather than being compared or rendered at a
 * guessed scale. Anything that still MULTIPLIES by it — the cost-per-purchase
 * conversion in `bid-sizing-policy.ts`, and every display formatter — remains
 * exposed to the divergence above. That is a separate defect and is out of this
 * contract's scope.
 */
export const META_BID_VALUE_UNIT_CONTRACT_VERSION =
  "meta.bid-value-units.v1" as const;

/** Why a stored bid value could not be read as a currency cap in minor units. */
export type MetaBidMinorUnitsRefusal =
  | "bid_value_absent"
  | "bid_value_not_a_currency_cap"
  | "currency_exponent_unknown"
  | "bid_value_not_provider_minor_units";

export type MetaBidMinorUnitsResult =
  | { ok: true; minorUnits: number; contractVersion: typeof META_BID_VALUE_UNIT_CONTRACT_VERSION }
  | { ok: false; refusal: MetaBidMinorUnitsRefusal };

/**
 * The ONE conversion from a stored bid value to the minor units every money
 * path works in. There is deliberately no second one: a bare arithmetic
 * expression on `bid_value` at a call site is how the scales diverged.
 *
 * The exponent is required but NOT used to scale — the value is already minor.
 * It is required because a currency whose scale is unknown cannot be compared
 * against a benchmark or rendered, and failing closed here keeps that refusal
 * in one place.
 */
export function metaBidValueToMinorUnits(input: {
  bidValue: number | null | undefined;
  bidValueFormat: string | null | undefined;
  currencyExponent: number | null | undefined;
}): MetaBidMinorUnitsResult {
  if (typeof input.bidValue !== "number" || !Number.isFinite(input.bidValue)) {
    return { ok: false, refusal: "bid_value_absent" };
  }
  /* A ratio is not a currency amount. Reading a 2.5x ROAS floor as 2.5 minor
     units would hand the executor a two-cent bid cap. */
  if (input.bidValueFormat !== "currency") {
    return { ok: false, refusal: "bid_value_not_a_currency_cap" };
  }
  if (typeof input.currencyExponent !== "number"
      || !Number.isFinite(input.currencyExponent)) {
    return { ok: false, refusal: "currency_exponent_unknown" };
  }
  if (!Number.isInteger(input.bidValue) || input.bidValue < 0
      || input.bidValue > MAX_MINOR_UNITS) {
    return { ok: false, refusal: "bid_value_not_provider_minor_units" };
  }
  return {
    ok: true,
    minorUnits: input.bidValue,
    contractVersion: META_BID_VALUE_UNIT_CONTRACT_VERSION,
  };
}

export function roundCurrencyAmount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * The version this contract is stamped with. A stored `bidValueFormat: "roas"`
 * value produced under it is a plain ROAS multiplier and is NEVER divided again.
 */
export const META_TARGET_ROAS_UNIT_CONTRACT_VERSION =
  "meta.target-roas-units.v1" as const;

/** Meta's documented bounds for `bid_constraints.roas_average_floor`. */
const PROVIDER_ROAS_FLOOR_MIN = 100;
const PROVIDER_ROAS_FLOOR_MAX = 10_000_000;

/**
 * Meta's `bid_constraints.roas_average_floor` -> the ROAS multiplier a person
 * reads. One direction, one domain, applied exactly once.
 *
 * > "In the API, `roas_average_floor` is an integer and scaled up 10000x …
 * > `roas_average_floor = 100` means 'the minimum roas' = 0.01 …
 * > `roas_average_floor = 23300` means 'the minimum roas' = 2.33"
 * > valid range "[100, 10000000], inclusive"
 * > — https://developers.facebook.com/docs/marketing-api/bidding/overview/bid-strategy/
 *
 * The scaling is UNCONDITIONAL. The predecessor guessed from magnitude
 * (`Math.abs(value) > 100 ? value / 10000 : value`) and was therefore two
 * functions wearing one name:
 *
 *  - At Meta's documented MINIMUM, raw 100, the guess read the floor as a
 *    ROAS of 100x instead of 0.01. Exactly at the boundary, and exactly on a
 *    value the provider is documented to send.
 *  - Fed an already-normalized stored value it divided a second time, which is
 *    how `normalizeLegacySnapshotPayload` came to re-apply it on the read path.
 *
 * Both arms close by having one function that only ever accepts a RAW provider
 * floor, and a read path that passes a stored multiplier through unchanged.
 *
 * Out-of-range input is refused rather than scaled: a number outside the
 * documented interval is not a floor this contract can name, and "no target"
 * is visible where a silently rescaled one is not.
 *
 * Rounding stays at two decimals, deliberately and not because it is exact:
 * a floor between 100 and 149 all collapses to 0.01. Widening it would change
 * the value for the same provider input, and `bid_value` is inside the config
 * fingerprint — so every affected entity would materialise a NEW history row
 * and read as a configuration change nobody made. Left as-is until that is
 * handled on its own.
 */
export function metaTargetRoasFromProviderFloor(
  providerFloor: number | null | undefined,
): number | null {
  if (typeof providerFloor !== "number" || !Number.isFinite(providerFloor)) {
    return null;
  }
  if (
    providerFloor < PROVIDER_ROAS_FLOOR_MIN ||
    providerFloor > PROVIDER_ROAS_FLOOR_MAX
  ) {
    return null;
  }
  return Math.round((providerFloor / 10_000) * 100) / 100;
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
      ? metaTargetRoasFromProviderFloor(input.targetRoas)
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
      ? metaTargetRoasFromProviderFloor(input.targetRoas)
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
