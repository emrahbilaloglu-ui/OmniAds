import type { DecisionLabel } from "@/components/common/briefing/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaLaunchMode } from "@/components/meta/redesign/types";
import { normalizeCurrencyCode } from "@/components/creatives/money";
import { metaMinorUnitsToMajor } from "@/lib/currency/meta-currency-offsets";

export const CURRENCY_UNAVAILABLE_LABEL = "Currency unavailable";

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

export type MetaRecommendationUiActionKind =
  | "route_launchpad_rebuild"
  | "route_launchpad_duplicate"
  | "review_drill";

/**
 * Defensive client boundary for legacy campaign/ad-set recommendations.
 * execute_* existed before recommendation writes had a canonical
 * decision-origin authority contract. Treat even an injected/stale execute
 * value as review-only; proposedAction and display copy never grant authority.
 */
export function uiActionKindForRec(
  rec: Pick<MetaRecommendation, "actionKind">,
): MetaRecommendationUiActionKind {
  if (rec.actionKind === "route_launchpad_rebuild") {
    return "route_launchpad_rebuild";
  }
  if (rec.actionKind === "route_launchpad_duplicate") {
    return "route_launchpad_duplicate";
  }
  return "review_drill";
}

export function launchModeForRec(rec: MetaRecommendation): MetaLaunchMode | null {
  switch (uiActionKindForRec(rec)) {
    case "route_launchpad_rebuild":
      return "rebuild";
    case "route_launchpad_duplicate":
      return "duplicate";
    default:
      return null;
  }
}

export function primaryLabelForRec(rec: MetaRecommendation) {
  if (uiActionKindForRec(rec) === "review_drill") {
    return rec.actionKind === "review_drill"
      ? (rec.primaryActionLabel ?? "Open drilldown")
      : "Review evidence";
  }
  return rec.primaryActionLabel ?? "Open drilldown";
}

export function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
) {
  if (value == null || !Number.isFinite(value)) return "—";
  const normalizedCurrency = normalizeCurrencyCode(currency);
  if (normalizedCurrency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: normalizedCurrency,
        maximumFractionDigits: value >= 1000 ? 0 : 2,
      }).format(value);
    } catch {
      // Fall through to the explicit unitless state.
    }
  }
  const unitless = value.toLocaleString("en-US", {
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  });
  return `${unitless} (${CURRENCY_UNAVAILABLE_LABEL})`;
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

function typedBidMinor(rec: MetaRecommendation) {
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

export function proposedBidMinorForExecute(
  rec: MetaRecommendation,
  currency?: string | null,
) {
  if (!normalizeCurrencyCode(currency)) return null;
  return typedBidMinor(rec);
}

/**
 * The bid cap number an operator reads immediately before authorising a write,
 * in MAJOR units — the same scale `formatBidCap` in the overlay assumes.
 *
 * Two things were wrong here and they compounded.
 *
 * 1. The typed branch divided provider minor units by a constant 100. That is
 *    Meta's offset for USD/TRY/GBP and wrong by 100x for every currency Meta
 *    lists at offset 1 (JPY, KRW, CLP, ISK, VND, HUF, IDR, TWD, COP …). The
 *    divisor now comes from the provider's own offset table, and the currency
 *    must be supplied — the same currency the overlay will render beside it.
 *
 * 2. A middle branch read `targetValue.bidValue / .bidAmount / .proposedBidCap`
 *    and returned it untouched, so the function returned MINOR units on one
 *    branch and MAJOR units on another with nothing to tell them apart. No
 *    producer in this repo writes any of those three keys into `targetValue`
 *    (the bid intent projection writes `proposedMinorUnits` / `currency` /
 *    `currencyExponent`), and the value carries no `bidValueFormat`, so there
 *    is no evidence anywhere for what unit such a key would be in. That branch
 *    is removed rather than reinterpreted: guessing would print a bid cap
 *    100x off in the confirmation dialog, while refusing prints "—".
 *
 * The remaining evidence-string fallbacks are already major units — they are
 * parsed back out of strings this module's own formatters produced.
 */
export function proposedBidDisplayValue(
  rec: MetaRecommendation,
  currency?: string | null,
) {
  const typedMinor = typedBidMinor(rec);
  if (typedMinor) {
    const major = metaMinorUnitsToMajor({ minorUnits: typedMinor, currency });
    return major.ok ? major.majorUnits : null;
  }
  return (
    parseFirstCurrencyAmount(evidenceValue(rec, "Suggested bid range")) ??
    parseFirstCurrencyAmount(evidenceValue(rec, "Bid value")) ??
    null
  );
}

export const proposedBidValue = proposedBidDisplayValue;
