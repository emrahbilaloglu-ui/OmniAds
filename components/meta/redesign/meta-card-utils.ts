import type { DecisionLabel } from "@/components/common/briefing/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaLaunchMode } from "@/components/meta/redesign/types";
import { formatCurrency as legacyFormatCurrency } from "@/lib/briefing/utils";

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

// Server-owned action contract (Codex cross-review): lane-classify
// annotates every recommendation with decisionLabel / actionKind /
// primaryActionLabel via lib/meta/rec-presentation.ts. The UI consumes
// them verbatim - no client derivation from types or display strings.
// Fallbacks are static neutral values for payloads predating the contract.
export function decisionLabelForRec(rec: MetaRecommendation): DecisionLabel {
  return (rec.decisionLabel as DecisionLabel | undefined) ?? "diagnose";
}

export function launchModeForRec(rec: MetaRecommendation): MetaLaunchMode | null {
  switch (rec.actionKind) {
    case "route_launchpad_rebuild":
      return "rebuild";
    case "route_launchpad_duplicate":
      return "duplicate";
    case "execute_bid":
      return "apply_bid";
    default:
      return null;
  }
}

export function primaryLabelForRec(rec: MetaRecommendation) {
  return rec.primaryActionLabel ?? "Open drilldown";
}

// Currency-aware money formatting shared by the Meta Decision Center
// surfaces: the ad-account currency from the pulse payload wins, then the
// business currency prop; only when both are unknown do we fall back to the
// legacy USD-style formatter. No silent "$" for non-USD accounts.
export function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        maximumFractionDigits: value >= 1000 ? 0 : 2,
      }).format(value);
    } catch {
      return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
    }
  }
  return legacyFormatCurrency(value);
}

export function evidenceValue(rec: MetaRecommendation, label: string) {
  return rec.evidence.find((item) => item.label.toLowerCase() === label.toLowerCase())?.value ?? null;
}

/**
 * Structured metrics for compare/bulk math. Display strings in evidence[]
 * are presentation-only; when the server did not attach metrics the entity
 * is excluded from numeric comparisons instead of being regex-guessed.
 */
export function structuredMetricsForRec(rec: MetaRecommendation) {
  return rec.metrics ?? null;
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
