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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function proposedBidMinorForExecute(rec: MetaRecommendation) {
  if (rec.proposedAction?.kind === "apply_bid") {
    return positiveInteger(rec.proposedAction.bidAmountMinor);
  }
  const target = recordValue(rec.targetValue);
  if (!target) return null;
  const direct = positiveInteger(target.bidAmountMinor);
  if (direct) return direct;
  const bid = recordValue(target.bid);
  return positiveInteger(bid?.bidAmountMinor);
}

export function proposedBidDisplayValue(rec: MetaRecommendation) {
  const executableMinor = proposedBidMinorForExecute(rec);
  if (executableMinor) return executableMinor / 100;
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

export const proposedBidValue = proposedBidDisplayValue;
