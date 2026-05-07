import type { DecisionLabel } from "@/components/common/briefing/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaLaunchMode } from "@/components/meta/redesign/types";

export function scopeIdForRec(rec: MetaRecommendation) {
  if (rec.level === "adset") return rec.adsetId ?? rec.id;
  if (rec.level === "campaign") return rec.campaignId ?? rec.id;
  return rec.id;
}

export function scopeNameForRec(rec: MetaRecommendation) {
  if (rec.level === "adset") return rec.adsetName ?? rec.campaignName ?? rec.id;
  if (rec.level === "campaign") return rec.campaignName ?? rec.id;
  return "Account";
}

export function decisionLabelForRec(rec: MetaRecommendation): DecisionLabel {
  if (rec.type === "adset_cut_spend") return "cut";
  if (rec.type === "adset_scale_budget" || rec.type === "scale_for_volume" || rec.type === "scale_for_profitability") {
    return "scale";
  }
  if (rec.type === "rebuild_with_constraints" || rec.type === "campaign_structure") return "rebuild";
  if (rec.type === "bid_strategy_fit" || rec.type === "bid_value_guidance" || rec.type === "bid_band_from_history") {
    return "tune";
  }
  if (rec.type === "geo_cluster_for_signal_density") return "swap";
  if (rec.decisionState === "watch") return "diagnose";
  return rec.decisionState === "test" ? "test_more" : "keep";
}

export function launchModeForRec(rec: MetaRecommendation): MetaLaunchMode | null {
  if (rec.type === "rebuild_with_constraints" || rec.type === "campaign_structure" || rec.type === "creative_test_structure") {
    return "rebuild";
  }
  if (rec.type === "geo_cluster_for_signal_density" || rec.type === "winner_promotion_flow") {
    return "duplicate";
  }
  if (rec.level === "adset" && rec.type === "bid_value_guidance") return "apply_bid";
  return null;
}

export function primaryLabelForRec(rec: MetaRecommendation) {
  const mode = launchModeForRec(rec);
  if (mode === "rebuild") return "Rebuild";
  if (mode === "duplicate") return "Duplicate to test";
  if (mode === "apply_bid") return "Apply bid cap";
  if (rec.type === "adset_cut_spend") return "Pause adset";
  if (rec.type === "adset_scale_budget") return "Scale budget";
  if (rec.type === "bid_strategy_fit" || rec.type === "bid_band_from_history") return "Switch strategy";
  return rec.decisionState === "act" ? "Act now" : "Open drilldown";
}

export function evidenceValue(rec: MetaRecommendation, label: string) {
  return rec.evidence.find((item) => item.label.toLowerCase() === label.toLowerCase())?.value ?? null;
}

export function parseFirstCurrencyAmount(text: string | null | undefined) {
  if (!text) return null;
  const match = text.replace(/,/g, "").match(/(?:\$|USD|EUR|TRY)?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function proposedBidValue(rec: MetaRecommendation) {
  if (rec.targetValue && typeof rec.targetValue === "object" && !Array.isArray(rec.targetValue)) {
    const record = rec.targetValue as Record<string, unknown>;
    const value = Number(record.bidValue ?? record.bidAmount ?? record.proposedBidCap ?? NaN);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return (
    parseFirstCurrencyAmount(evidenceValue(rec, "Suggested bid range")) ??
    parseFirstCurrencyAmount(evidenceValue(rec, "Bid value")) ??
    null
  );
}
