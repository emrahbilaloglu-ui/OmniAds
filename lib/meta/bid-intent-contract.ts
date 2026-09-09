/**
 * The bid intent: a proposed cap change, validated before anybody sees it.
 *
 * Deliberately the budget contract's twin — same arithmetic module, same
 * rounding rule, same minor-unit discipline, same "every rejection, not the
 * first" reporting. A cap is a different control from a budget, but a proposed
 * money change has to answer the same questions either way, and two validators
 * that disagreed about what a valid currency amount is would be worse than one
 * shared answer.
 *
 * ## What is different, and why
 *
 * A cap only exists on a cap strategy. The strategy therefore travels in the
 * intent and is re-proved before the write: writing a number onto an ad set
 * whose strategy changed since the decision would be setting a value that now
 * means something else. That is why the read-back asserts `bid_strategy`
 * alongside the amount, and why an intent naming a non-cap strategy is
 * rejected here rather than discovered at the provider.
 *
 * ## What this does not do
 *
 * It does not decide the size — `lib/meta/bid-sizing-policy` does — and it
 * never contacts a provider. `executionState` stops at `validated_only`;
 * execution belongs to the queue and its authority.
 */
import { createHash } from "node:crypto";

import {
  ISO_4217_REGISTRY_SOURCE,
  ISO_4217_REGISTRY_VERSION,
  applyPercentToMinorUnits,
  resolveMinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";
import { isBidCapStrategy } from "@/lib/meta/bid-sizing-policy";
import type { MetaOsBidIntentPayload } from "@/lib/meta/decisions-os-contract";

export const META_BID_INTENT_CONTRACT_VERSION = "meta.bid-intent.v1" as const;

/**
 * Recommendation semantics that explicitly name a currency bid-amount move.
 *
 * Today B1 is the only real recommendation vocabulary whose meaning is an
 * exact cap increase. Its current producer is campaign-grain, so it still
 * cannot reach an ad-set write; keeping the semantic rule here makes that
 * absence explicit instead of borrowing an unrelated ad-set row as a carrier.
 * `bid_value_guidance` is deliberately absent: its producer describes a
 * Target-ROAS ratio, not Meta's `bid_amount` currency field.
 */
const META_BID_AMOUNT_DIRECTION_BY_RECOMMENDATION_TYPE = new Map<
  string,
  "increase" | "decrease"
>([["scenario_b1_capped_winner_bid_raise", "increase"]]);

export function metaBidAmountDirectionForRecommendationType(
  type: unknown,
): "increase" | "decrease" | null {
  return typeof type === "string"
    ? META_BID_AMOUNT_DIRECTION_BY_RECOMMENDATION_TYPE.get(type) ?? null
    : null;
}

/**
 * The executable amount only when the recommendation's structured vocabulary
 * and the typed intent agree about the operation and direction.
 *
 * `executableBidIntentMinorUnits` intentionally validates the payload alone;
 * queue envelopes use it without a recommendation object. Presentation and
 * projection need this stricter answer so a valid amount attached to a Cut,
 * Refresh, structural, or Target-ROAS row cannot change that row's meaning.
 */
export function executableMetaRecommendationBidAmount(input: {
  recommendationType: unknown;
  targetValue: unknown;
}): number | null {
  const expectedDirection = metaBidAmountDirectionForRecommendationType(
    input.recommendationType,
  );
  if (!expectedDirection) return null;
  if (!input.targetValue || typeof input.targetValue !== "object"
    || Array.isArray(input.targetValue)) return null;
  const target = input.targetValue as Record<string, unknown>;
  if (target.direction !== expectedDirection) return null;
  return executableBidIntentMinorUnits(input.targetValue);
}

export const BID_INTENT_REJECTIONS = [
  "contract_version_unsupported",
  "scope_identity_unknown",
  "scope_identity_cross_paired",
  "grain_unsupported",
  "bid_strategy_not_writable",
  "current_value_missing",
  "current_value_not_integer_minor_units",
  "percent_unsupported",
  "percent_math_inconsistent",
  "proposal_not_positive",
  "proposal_overflows_minor_units",
  "currency_unresolvable",
  "clock_invalid",
  "authority_status_unknown",
  "identity_unstable",
] as const;
export type BidIntentRejection = (typeof BID_INTENT_REJECTIONS)[number];

/** The rungs a bid intent may carry. See `BID_SIZING_POLICY_V1`. */
export const BID_INTENT_APPROVED_PERCENTS = [5, 10, 15] as const;

export interface BidIntentScope {
  businessId: string;
  providerAccountId: string;
  entityGrain: "adset";
  entityId: string;
  parentCampaignId: string | null;
}

export interface BidIntentInput {
  contractVersion: string;
  scope: BidIntentScope;
  bidStrategyType: string;
  direction: "increase" | "decrease";
  percent: number;
  currency: string;
  observedBidMinorUnits: number | null;
  originDate: string;
  effectiveAsOf: string;
  knowledgeAsOf: string;
  evidenceWindow: { from: string; to: string };
  authorityStatus: "authorised" | "blocked" | "not_determinable";
  blockerCodes: readonly string[];
}

export type BidIntentValidation =
  | { status: "valid"; intent: MetaOsBidIntentPayload }
  | { status: "rejected"; rejections: BidIntentRejection[]; reasons: string[] };

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * A stable identity for one intent.
 *
 * A pure function of the operation, not of the entity: raising a cap from
 * 1200 to 1320 and from 900 to 990 are two different money movements, and a
 * key that collapsed them would let a dispatcher deduplicate one away. The
 * strategy is in the key too, because the same number on a different strategy
 * is a different operation.
 */
export function bidIntentKey(input: {
  scope: BidIntentScope;
  bidStrategyType: string;
  direction: "increase" | "decrease";
  percent: number;
  originDate: string;
  currentMinorUnits: number;
  proposedMinorUnits: number;
  currency: string;
  currencyExponent: number;
}): string {
  const operation = [
    META_BID_INTENT_CONTRACT_VERSION,
    input.scope.businessId, input.scope.providerAccountId,
    input.scope.entityGrain, input.scope.entityId,
    input.scope.parentCampaignId ?? "-",
    input.bidStrategyType.trim().toLowerCase(),
    input.direction, String(input.percent), input.originDate,
    input.currency, String(input.currencyExponent),
    String(input.currentMinorUnits), String(input.proposedMinorUnits),
  ].join("|");
  return `${META_BID_INTENT_CONTRACT_VERSION}:${createHash("sha256").update(operation).digest("hex")}`;
}

export function validateBidIntent(
  input: BidIntentInput | unknown,
  knownBindings: ReadonlyArray<{ businessId: string; providerAccountId: string }> | unknown,
): BidIntentValidation {
  /*
    Total at the boundary. A function whose job is to decide whether an input
    is valid must never answer by throwing: a thrown error is the absence of a
    verdict, and every caller then has to guess which it was.
  */
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    return {
      status: "rejected",
      rejections: ["identity_unstable"],
      reasons: [`the intent input is ${input === undefined ? "absent" : JSON.stringify(input)}, not a map`],
    };
  }
  const typed = input as BidIntentInput;
  const bindings = knownBindings as ReadonlyArray<{
    businessId: string; providerAccountId: string;
  }>;

  const rejections: BidIntentRejection[] = [];
  const reasons: string[] = [];
  const reject = (code: BidIntentRejection, why: string) => {
    rejections.push(code);
    reasons.push(why);
  };

  if (typed.contractVersion !== META_BID_INTENT_CONTRACT_VERSION) {
    reject("contract_version_unsupported",
      `contract ${JSON.stringify(typed.contractVersion)} is not ${META_BID_INTENT_CONTRACT_VERSION}`);
  }

  const scope = typed.scope;
  if (!scope?.businessId || !scope?.providerAccountId || !scope?.entityId) {
    reject("scope_identity_unknown", "the composite scope is incomplete");
  } else if (!Array.isArray(bindings)) {
    reject("identity_unstable", "the known-binding set is not an array");
  } else if (!bindings.every((binding) =>
    binding !== null && typeof binding === "object" && !Array.isArray(binding))) {
    reject("identity_unstable", "the known-binding set carries an element that is not a business/account map");
  } else if (!bindings.some((binding) =>
    binding.businessId === scope.businessId
    && binding.providerAccountId === scope.providerAccountId)) {
    // The PAIR must be known. Each half being separately valid proves nothing.
    reject("scope_identity_cross_paired",
      `${scope.businessId}|${scope.providerAccountId} is not a known business/account pair`);
  }
  if (scope?.entityGrain !== "adset") {
    // There is no campaign-grain bid write; a campaign intent names an
    // endpoint that does not exist.
    reject("grain_unsupported", `grain ${JSON.stringify(scope?.entityGrain)} owns no bid amount`);
  }

  if (!isBidCapStrategy(typed.bidStrategyType)) {
    reject("bid_strategy_not_writable",
      `${JSON.stringify(typed.bidStrategyType)} owns no writable bid amount`);
  }

  const current = typed.observedBidMinorUnits;
  if (current === null || current === undefined) {
    reject("current_value_missing", "no observed bid amount to change");
  } else if (!Number.isInteger(current)) {
    reject("current_value_not_integer_minor_units",
      `the observed amount ${JSON.stringify(current)} is not an integer of minor units`);
  }

  if (!(BID_INTENT_APPROVED_PERCENTS as readonly number[]).includes(typed.percent)) {
    reject("percent_unsupported", `${JSON.stringify(typed.percent)} is not an approved bid magnitude`);
  }
  if (typed.direction !== "increase" && typed.direction !== "decrease") {
    reject("percent_math_inconsistent", `direction ${JSON.stringify(typed.direction)} is neither increase nor decrease`);
  }

  const exponent = resolveMinorUnitExponent(typed.currency);
  if (exponent.status !== "resolved") {
    reject("currency_unresolvable", `currency ${JSON.stringify(typed.currency)} has no known minor-unit exponent`);
  }

  if (!isCalendarDate(typed.originDate)) reject("clock_invalid", "originDate is not a calendar date");
  if (!isCalendarDate(typed.effectiveAsOf)) reject("clock_invalid", "effectiveAsOf is not a calendar date");
  if (!isInstant(typed.knowledgeAsOf)) reject("clock_invalid", "knowledgeAsOf is not an instant");
  if (!isCalendarDate(typed.evidenceWindow?.from) || !isCalendarDate(typed.evidenceWindow?.to)
    || typed.evidenceWindow.from > typed.evidenceWindow.to) {
    reject("clock_invalid", "the evidence window is not an ordered pair of calendar dates");
  }
  /*
    Evidence cannot be from after the decision.

    A window ending later than the origin would mean the decision was reasoned
    from data that did not exist when it was made — the exact leak every replay
    guard in this codebase exists to prevent.
  */
  if (isCalendarDate(typed.evidenceWindow?.to) && isCalendarDate(typed.originDate)
    && typed.evidenceWindow.to > typed.originDate) {
    reject("clock_invalid", "the evidence window ends after the origin date");
  }

  if (typed.authorityStatus !== "authorised" && typed.authorityStatus !== "blocked"
    && typed.authorityStatus !== "not_determinable") {
    reject("authority_status_unknown", `authority status ${JSON.stringify(typed.authorityStatus)} is not one of the three`);
  }
  if (!Array.isArray(typed.blockerCodes)) {
    reject("identity_unstable", "blockerCodes is not an array");
  }

  if (rejections.length > 0) {
    return {
      status: "rejected",
      rejections: [...new Set(rejections)].sort(),
      reasons,
    };
  }

  const resolved = exponent as Extract<
    ReturnType<typeof resolveMinorUnitExponent>, { status: "resolved" }
  >;
  const currentUnits = current as number;
  const applied = applyPercentToMinorUnits(currentUnits, typed.percent, typed.direction);
  if (applied.status !== "ok") {
    const code: BidIntentRejection =
      applied.reason.includes("overflow") || applied.reason.includes("safe integer")
        ? "proposal_overflows_minor_units"
        : applied.reason.includes("zero")
          ? "proposal_not_positive"
          : "percent_math_inconsistent";
    return { status: "rejected", rejections: [code], reasons: [applied.reason] };
  }
  // The direction has to have happened. Rounding can otherwise turn a 5%
  // decrease on a tiny amount into no change at all, and a "decrease" that
  // decreased nothing is a false statement in a journal.
  if (typed.direction === "increase" && applied.minorUnits <= currentUnits) {
    return {
      status: "rejected",
      rejections: ["percent_math_inconsistent"],
      reasons: ["an increase did not raise the amount"],
    };
  }
  if (typed.direction === "decrease" && applied.minorUnits >= currentUnits) {
    return {
      status: "rejected",
      rejections: ["percent_math_inconsistent"],
      reasons: ["a decrease did not lower the amount"],
    };
  }

  const signed = typed.direction === "increase" ? typed.percent : -typed.percent;
  const key = bidIntentKey({
    scope,
    bidStrategyType: typed.bidStrategyType,
    direction: typed.direction,
    percent: typed.percent,
    originDate: typed.originDate,
    currentMinorUnits: currentUnits,
    proposedMinorUnits: applied.minorUnits,
    currency: resolved.currency,
    currencyExponent: resolved.exponent,
  });

  return {
    status: "valid",
    intent: {
      kind: "bid_intent",
      contractVersion: META_BID_INTENT_CONTRACT_VERSION,
      intentKey: key,
      idempotencyKey: key,
      scope,
      bidStrategyType: typed.bidStrategyType.trim().toLowerCase(),
      direction: typed.direction,
      percent: typed.percent,
      currency: resolved.currency,
      currencyExponent: resolved.exponent,
      currencyRegistry: {
        version: ISO_4217_REGISTRY_VERSION,
        source: ISO_4217_REGISTRY_SOURCE,
      },
      currentMinorUnits: currentUnits,
      proposedMinorUnits: applied.minorUnits,
      deltaMinorUnits: applied.minorUnits - currentUnits,
      rounding: {
        applied: applied.roundingApplied,
        rule: applied.roundingRule,
        exactUnrounded: `${currentUnits * (100 + signed)}/100`,
      },
      originDate: typed.originDate,
      effectiveAsOf: typed.effectiveAsOf,
      knowledgeAsOf: typed.knowledgeAsOf,
      evidenceWindow: typed.evidenceWindow,
      authorityStatus: typed.authorityStatus,
      blockerCodes: [...typed.blockerCodes].sort(),
      // Validation is the ceiling. Nothing here contacts a provider.
      executionState: "validated_only",
      rollback: { priorMinorUnits: currentUnits, field: "bid_amount", operation: "set" },
      readback: {
        field: "bid_amount",
        expectedMinorUnits: applied.minorUnits,
        independentRead: true,
        alsoAsserts: ["bid_strategy_unchanged"],
      },
      createdBy: {
        module: "lib/meta/bid-intent-contract",
        contractVersion: META_BID_INTENT_CONTRACT_VERSION,
      },
    },
  };
}

/**
 * The executable amount a PERSISTED bid intent carries, or null.
 *
 * This validates the payload itself for callers that do not own a
 * recommendation object. It does not grant operation authority. Projection,
 * presentation, candidate selection and dispatch additionally require a
 * recommendation type whose declared bid direction agrees with this payload.
 *
 * Strict on purpose: a withheld or blocker-carrying intent returns null, and
 * so does a row whose `bidAmountMinor` and `proposedMinorUnits` differ — two
 * numbers for one write is not a number.
 */
export function executableBidIntentMinorUnits(targetValue: unknown): number | null {
  if (!targetValue || typeof targetValue !== "object" || Array.isArray(targetValue)) {
    return null;
  }
  const target = targetValue as Record<string, unknown>;
  if (target.contractVersion !== META_BID_INTENT_CONTRACT_VERSION) return null;
  if (target.authorityStatus !== "authorised") return null;
  if (!Array.isArray(target.blockerCodes) || target.blockerCodes.length > 0) return null;
  const positive = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
  const proposed = positive(target.proposedMinorUnits);
  const bidAmount = positive(target.bidAmountMinor);
  if (proposed === null || bidAmount === null || proposed !== bidAmount) return null;
  return bidAmount;
}
