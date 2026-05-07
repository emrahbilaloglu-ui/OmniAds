import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import {
  buildMetaCampaignLaneSignals,
  type MetaCampaignLaneSignal,
} from "@/lib/meta/campaign-lanes";
import type { MetaBidRegime, MetaCampaignRole } from "@/lib/meta/types";

export interface MetaCampaignRoleContext {
  campaigns?: MetaCampaignRow[];
  laneSignals?: Map<string, MetaCampaignLaneSignal>;
}

type BidLike = Partial<{
  bidStrategyType: string | null;
  bid_strategy_type: string | null;
  bidStrategyLabel: string | null;
  bid_strategy_label: string | null;
  bidValueFormat: string | null;
  bid_value_format: string | null;
  manualBidAmount: number | null;
  manual_bid_amount: number | null;
}>;

function normalizedText(values: Array<string | null | undefined>) {
  return values
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .trim();
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function laneSignalsFor(context: MetaCampaignRoleContext | null | undefined) {
  if (context?.laneSignals) return context.laneSignals;
  return buildMetaCampaignLaneSignals(context?.campaigns ?? []);
}

export function inferCampaignRole(
  campaign: MetaCampaignRow,
  accountContext?: MetaCampaignRoleContext | null,
): MetaCampaignRole {
  const text = normalizedText([
    campaign.name,
    campaign.objective,
    campaign.optimizationGoal,
    campaign.bidStrategyLabel,
  ]);

  if (
    hasAny(text, [
      /promo/,
      /clearance/,
      /discount/,
      /sale\b/,
      /offer/,
      /deal/,
      /bfcm/,
      /black friday/,
    ])
  ) {
    return "promo_clearance";
  }
  if (
    hasAny(text, [
      /catalog/,
      /\bdpa\b/,
      /advantage\+?\s*shopping/,
      /\basc\b/,
      /shopping/,
      /product set/,
      /feed/,
    ])
  ) {
    return "catalog_dpa";
  }
  if (
    hasAny(text, [
      /retarget/,
      /remarket/,
      /\bwarm\b/,
      /visitor/,
      /\batc\b/,
      /add to cart/,
      /\bcart\b/,
      /\bvc\b/,
      /view content/,
    ])
  ) {
    return "retargeting";
  }
  if (
    hasAny(text, [
      /existing customer/,
      /\bltv\b/,
      /retention/,
      /repeat/,
      /\bcrm\b/,
      /\bvip\b/,
      /purchaser/,
    ])
  ) {
    return "existing_customer_ltv";
  }
  if (
    hasAny(text, [
      /\bgeo\b/,
      /expansion/,
      /international/,
      /new market/,
      /market test/,
      /country/,
      /region/,
    ])
  ) {
    return "geo_expansion";
  }

  const signal = laneSignalsFor(accountContext).get(campaign.id);
  if (signal?.lane === "Scaling") return "prospecting_scale";
  if (signal?.lane === "Test") return "prospecting_test";
  return "prospecting_validation";
}

function bidString(value: BidLike | null | undefined) {
  if (!value) return "";
  return normalizedText([
    value.bidStrategyType,
    value.bid_strategy_type,
    value.bidStrategyLabel,
    value.bid_strategy_label,
    value.bidValueFormat,
    value.bid_value_format,
  ]);
}

function hasManualBid(value: BidLike | null | undefined) {
  const manual =
    value?.manualBidAmount ??
    value?.manual_bid_amount ??
    null;
  return typeof manual === "number" && Number.isFinite(manual) && manual > 0;
}

export function inferBidRegime(
  adset?: (MetaAdSetData & BidLike) | null,
  campaign?: (MetaCampaignRow & BidLike) | null,
): MetaBidRegime {
  const text = `${bidString(adset)} ${bidString(campaign)}`.trim();
  if (hasAny(text, [/minimum roas/, /target roas/, /\broas floor\b/])) {
    return "minimum_roas";
  }
  if (hasAny(text, [/cost cap/])) return "cost_cap";
  if (
    hasManualBid(adset) ||
    hasManualBid(campaign) ||
    hasAny(text, [/bid cap/, /manual bid/])
  ) {
    return "bid_cap";
  }
  if (
    !text ||
    hasAny(text, [/lowest cost/, /\bopen\b/, /highest volume/, /high volume/])
  ) {
    return "lowest_cost";
  }
  return "unknown";
}
