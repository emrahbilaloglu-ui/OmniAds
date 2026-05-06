import type {
  MetaBidStrategy,
  MetaLaunchAdInput,
  MetaLaunchAdSetInput,
  MetaLaunchCampaignInput,
} from "@/lib/meta/launch-write";

export type MetaBudgetMode = "CBO" | "ABO";
export type MetaBudgetSchedule = "daily" | "lifetime";
export type MetaOptimizationGoal =
  | "OFFSITE_CONVERSIONS"
  | "VALUE"
  | "LANDING_PAGE_VIEWS";
export type MetaCustomEventType =
  | "PURCHASE"
  | "ADD_TO_CART"
  | "INITIATE_CHECKOUT";

export interface MetaLaunchCreativeRef {
  creativeId: string;
  name?: string | null;
}

export interface MetaLaunchBudgetPayload {
  mode: MetaBudgetMode;
  schedule: MetaBudgetSchedule;
  amountMinor: number;
  bidStrategy: MetaBidStrategy;
  bidAmountMinor?: number | null;
}

export interface MetaLaunchTargetingPayload {
  countries: string[];
  ageMin: number;
  ageMax: number;
  advantageAudience: boolean;
  advantagePlacements: boolean;
  publisherPlatforms?: string[];
  facebookPositions?: string[];
  instagramPositions?: string[];
}

export interface MetaLaunchAdSetPayload {
  clientId: string;
  name: string;
  optimizationGoal: MetaOptimizationGoal;
  pixelId: string;
  customEventType: MetaCustomEventType;
  targeting: MetaLaunchTargetingPayload;
  attributionSpec: Array<{
    eventType: "CLICK_THROUGH" | "VIEW_THROUGH";
    windowDays: 1 | 7;
  }>;
  budget?: MetaLaunchBudgetPayload | null;
}

export interface MetaLaunchPayload {
  campaign: {
    name: string;
    objective: "OUTCOME_SALES";
    smartPromotionType?: "GUIDED_CREATION" | null;
    specialAdCategories: string[];
  };
  budget: MetaLaunchBudgetPayload;
  creativeIds: string[];
  creatives: MetaLaunchCreativeRef[];
  adSets: MetaLaunchAdSetPayload[];
}

export interface LaunchpadIssue {
  code: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => asString(item)).filter(Boolean)
    : [];
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeBudget(value: unknown, fallbackMode: MetaBudgetMode): MetaLaunchBudgetPayload {
  const record = isRecord(value) ? value : {};
  const mode = record.mode === "ABO" ? "ABO" : fallbackMode;
  const schedule = record.schedule === "lifetime" ? "lifetime" : "daily";
  const bidStrategy =
    record.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ||
    record.bidStrategy === "COST_CAP"
      ? record.bidStrategy
      : "LOWEST_COST_WITHOUT_CAP";
  return {
    mode,
    schedule,
    amountMinor: Math.trunc(asNumber(record.amountMinor, 0)),
    bidStrategy,
    bidAmountMinor:
      record.bidAmountMinor == null
        ? null
        : Math.trunc(asNumber(record.bidAmountMinor, 0)),
  };
}

function normalizeAttributionSpec(value: unknown): MetaLaunchAdSetPayload["attributionSpec"] {
  if (!Array.isArray(value) || value.length === 0) {
    return [{ eventType: "CLICK_THROUGH", windowDays: 7 }];
  }
  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    return {
      eventType:
        record.eventType === "VIEW_THROUGH" ? "VIEW_THROUGH" : "CLICK_THROUGH",
      windowDays: record.windowDays === 1 ? 1 : 7,
    };
  });
}

function normalizeTargeting(value: unknown): MetaLaunchTargetingPayload {
  const record = isRecord(value) ? value : {};
  return {
    countries: uniqueStrings(asStringArray(record.countries)).length
      ? uniqueStrings(asStringArray(record.countries))
      : ["US"],
    ageMin: Math.max(13, Math.trunc(asNumber(record.ageMin, 18))),
    ageMax: Math.min(65, Math.trunc(asNumber(record.ageMax, 65))),
    advantageAudience: record.advantageAudience !== false,
    advantagePlacements: record.advantagePlacements !== false,
    publisherPlatforms: uniqueStrings(asStringArray(record.publisherPlatforms)),
    facebookPositions: uniqueStrings(asStringArray(record.facebookPositions)),
    instagramPositions: uniqueStrings(asStringArray(record.instagramPositions)),
  };
}

function normalizeCreatives(value: unknown, creativeIdsValue: unknown) {
  const fromRefs = Array.isArray(value)
    ? value
        .map((item) => {
          if (typeof item === "string") {
            return { creativeId: item.trim(), name: null };
          }
          const record = isRecord(item) ? item : {};
          return {
            creativeId: asString(record.creativeId || record.id),
            name: asString(record.name) || null,
          };
        })
        .filter((item) => item.creativeId)
    : [];
  const fromIds = asStringArray(creativeIdsValue).map((creativeId) => ({
    creativeId,
    name: null,
  }));
  const byId = new Map<string, MetaLaunchCreativeRef>();
  for (const item of [...fromRefs, ...fromIds]) byId.set(item.creativeId, item);
  return Array.from(byId.values());
}

export function normalizeMetaLaunchPayload(value: unknown): MetaLaunchPayload {
  const record = isRecord(value) ? value : {};
  const campaign = isRecord(record.campaign) ? record.campaign : {};
  const budget = normalizeBudget(record.budget, "CBO");
  const creatives = normalizeCreatives(record.creatives, record.creativeIds);
  const adSets = Array.isArray(record.adSets) ? record.adSets : [];

  return {
    campaign: {
      name: asString(campaign.name),
      objective: "OUTCOME_SALES",
      smartPromotionType:
        campaign.smartPromotionType === "GUIDED_CREATION"
          ? "GUIDED_CREATION"
          : null,
      specialAdCategories: uniqueStrings(
        asStringArray(campaign.specialAdCategories),
      ),
    },
    budget,
    creativeIds: creatives.map((item) => item.creativeId),
    creatives,
    adSets: adSets.map((item, index) => {
      const adSet = isRecord(item) ? item : {};
      const optimizationGoal =
        adSet.optimizationGoal === "VALUE" ||
        adSet.optimizationGoal === "LANDING_PAGE_VIEWS"
          ? adSet.optimizationGoal
          : "OFFSITE_CONVERSIONS";
      const customEventType =
        adSet.customEventType === "ADD_TO_CART" ||
        adSet.customEventType === "INITIATE_CHECKOUT"
          ? adSet.customEventType
          : "PURCHASE";
      return {
        clientId: asString(adSet.clientId) || `adset-${index + 1}`,
        name: asString(adSet.name),
        optimizationGoal,
        pixelId: asString(adSet.pixelId),
        customEventType,
        targeting: normalizeTargeting(adSet.targeting),
        attributionSpec: normalizeAttributionSpec(adSet.attributionSpec),
        budget: adSet.budget ? normalizeBudget(adSet.budget, "ABO") : null,
      };
    }),
  };
}

export function validateMetaLaunchPayloadShape(
  payload: MetaLaunchPayload,
): { blockers: LaunchpadIssue[]; warnings: LaunchpadIssue[] } {
  const blockers: LaunchpadIssue[] = [];
  const warnings: LaunchpadIssue[] = [];

  if (!payload.campaign.name) {
    blockers.push({
      code: "campaign_name_required",
      message: "Campaign name is required.",
    });
  }
  if (payload.campaign.objective !== "OUTCOME_SALES") {
    blockers.push({
      code: "objective_locked",
      message: "Launchpad MVP only supports Sales campaigns.",
    });
  }
  if (payload.creativeIds.length === 0) {
    blockers.push({
      code: "creative_required",
      message: "Select at least one creative.",
    });
  }
  if (payload.adSets.length === 0) {
    blockers.push({
      code: "adset_required",
      message: "Add at least one ad set.",
    });
  }
  if (payload.budget.amountMinor <= 0) {
    blockers.push({
      code: "budget_required",
      message: "Budget amount must be greater than zero.",
    });
  }
  if (
    payload.budget.bidStrategy !== "LOWEST_COST_WITHOUT_CAP" &&
    (!payload.budget.bidAmountMinor || payload.budget.bidAmountMinor <= 0)
  ) {
    blockers.push({
      code: "bid_amount_required",
      message: "Bid cap and cost cap strategies require a bid amount.",
    });
  }
  if (payload.budget.mode === "CBO") {
    const adsetBudgetCount = payload.adSets.filter(
      (adSet) => (adSet.budget?.amountMinor ?? 0) > 0,
    ).length;
    if (adsetBudgetCount > 0) {
      blockers.push({
        code: "cbo_abo_mixed",
        message: "CBO campaigns cannot include ad set budgets.",
      });
    }
  }
  if (payload.budget.mode === "ABO") {
    payload.adSets.forEach((adSet, index) => {
      if (!adSet.budget || adSet.budget.amountMinor <= 0) {
        blockers.push({
          code: "adset_budget_required",
          message: `Ad set ${index + 1} needs a budget in ABO mode.`,
        });
      }
    });
  }

  payload.adSets.forEach((adSet, index) => {
    if (!adSet.name) {
      blockers.push({
        code: "adset_name_required",
        message: `Ad set ${index + 1} needs a name.`,
      });
    }
    if (!adSet.pixelId) {
      blockers.push({
        code: "pixel_required",
        message: `Ad set ${index + 1} needs a pixel.`,
      });
    }
    if (adSet.targeting.countries.length === 0) {
      blockers.push({
        code: "country_required",
        message: `Ad set ${index + 1} needs at least one country.`,
      });
    }
    if (adSet.targeting.ageMin > adSet.targeting.ageMax) {
      blockers.push({
        code: "age_range_invalid",
        message: `Ad set ${index + 1} has an invalid age range.`,
      });
    }
    if (!adSet.targeting.advantagePlacements) {
      const placementCount =
        (adSet.targeting.publisherPlatforms?.length ?? 0) +
        (adSet.targeting.facebookPositions?.length ?? 0) +
        (adSet.targeting.instagramPositions?.length ?? 0);
      if (placementCount === 0) {
        warnings.push({
          code: "manual_placements_empty",
          message: `Ad set ${index + 1} has Advantage+ Placements off without explicit placements.`,
        });
      }
    }
  });

  return { blockers, warnings };
}

export function toCampaignInput(payload: MetaLaunchPayload): MetaLaunchCampaignInput {
  const shared = {
    name: payload.campaign.name,
    objective: "OUTCOME_SALES" as const,
    status: "PAUSED" as const,
    smartPromotionType: payload.campaign.smartPromotionType ?? null,
    buyingType: "AUCTION" as const,
    specialAdCategories: payload.campaign.specialAdCategories,
    bidStrategy: payload.budget.mode === "CBO" ? payload.budget.bidStrategy : undefined,
    bidAmountMinor:
      payload.budget.mode === "CBO" ? payload.budget.bidAmountMinor ?? undefined : undefined,
    isAdsetBudgetSharingEnabled: payload.budget.mode === "CBO",
  };
  return payload.budget.mode === "CBO" && payload.budget.schedule === "lifetime"
    ? { ...shared, lifetimeBudgetMinor: payload.budget.amountMinor }
    : payload.budget.mode === "CBO"
      ? { ...shared, dailyBudgetMinor: payload.budget.amountMinor }
      : shared;
}

export function toAdSetInput(
  campaignId: string,
  adSet: MetaLaunchAdSetPayload,
  campaignBudget: MetaLaunchBudgetPayload,
): MetaLaunchAdSetInput {
  const budget = campaignBudget.mode === "ABO" ? adSet.budget : null;
  const shared: MetaLaunchAdSetInput = {
    campaignId,
    name: adSet.name,
    optimizationGoal: adSet.optimizationGoal,
    billingEvent: "IMPRESSIONS",
    status: "PAUSED",
    promotedObject: {
      pixelId: adSet.pixelId,
      customEventType: adSet.customEventType,
    },
    targeting: {
      geoLocations: { countries: adSet.targeting.countries },
      ageMin: adSet.targeting.ageMin,
      ageMax: adSet.targeting.ageMax,
      advantageAudience: adSet.targeting.advantageAudience ? 1 : 0,
      publisherPlatforms: adSet.targeting.advantagePlacements
        ? undefined
        : adSet.targeting.publisherPlatforms,
      facebookPositions: adSet.targeting.advantagePlacements
        ? undefined
        : adSet.targeting.facebookPositions,
      instagramPositions: adSet.targeting.advantagePlacements
        ? undefined
        : adSet.targeting.instagramPositions,
    },
    attributionSpec: adSet.attributionSpec,
  };
  if (!budget) return shared;
  return {
    ...shared,
    dailyBudgetMinor:
      budget.schedule === "daily" ? budget.amountMinor : undefined,
    lifetimeBudgetMinor:
      budget.schedule === "lifetime" ? budget.amountMinor : undefined,
    bidStrategy: budget.bidStrategy,
    bidAmountMinor: budget.bidAmountMinor ?? undefined,
  };
}

export function toAdInput(
  adsetId: string,
  creative: MetaLaunchCreativeRef,
): MetaLaunchAdInput {
  return {
    adsetId,
    creativeId: creative.creativeId,
    name: creative.name
      ? `${creative.name} - ${adsetId}`
      : `Creative ${creative.creativeId} - ${adsetId}`,
    status: "PAUSED",
  };
}

export function amountToMinorUnits(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 100);
}

export function amountFromMinorUnits(value: number) {
  return (value / 100).toFixed(2);
}

export function adsManagerUrl(accountId: string, entity: "campaign" | "adset" | "ad", id: string) {
  const numeric = accountId.replace(/^act_/, "");
  const selected =
    entity === "campaign"
      ? "selected_campaign_ids"
      : entity === "adset"
        ? "selected_adset_ids"
        : "selected_ad_ids";
  return `https://adsmanager.facebook.com/adsmanager/manage/${entity === "adset" ? "adsets" : `${entity}s`}?act=${encodeURIComponent(
    numeric,
  )}&${selected}=${encodeURIComponent(id)}`;
}
