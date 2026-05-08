import type { DecisionLabel } from "@/components/common/briefing/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import {
  decisionLabelForMetaRec,
  launchModeForMetaRec,
  primaryLabelForMetaRec,
} from "@/lib/meta/rec-label-mapping";
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
  return decisionLabelForMetaRec(rec);
}

export function launchModeForRec(rec: MetaRecommendation): MetaLaunchMode | null {
  return launchModeForMetaRec(rec);
}

export function primaryLabelForRec(rec: MetaRecommendation) {
  return primaryLabelForMetaRec(rec);
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
