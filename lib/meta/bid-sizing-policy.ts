/**
 * How large a bid-cap change should be, and when there should be none.
 *
 * The write primitive for this has existed for a long time
 * (`updateAdsetBidAmount`, and the `apply-bid` route in front of it), but no
 * producer ever proposed a bid amount. The one recommendation type that sounds
 * like it — `bid_value_guidance` — is about Target ROAS, which is a different
 * control with a different payload, and conflating them would have written a
 * currency amount into a ratio.
 *
 * ## Scope
 *
 * Only ad sets whose bid strategy is a cap family, because only those have a
 * `bid_amount` to change. The retained inventory of the six working accounts
 * shows caps are real — cost cap and bid cap across four of them — while two
 * accounts run lowest cost only and get no intent at all. The strategy is read
 * again at write time from the provider's own answer: `updateAdsetBidAmount`'s
 * dry-run verification already fetches `bid_strategy`, and a value outside the
 * cap family refuses there.
 *
 * ## Why a narrower ladder than budget
 *
 * A cap is a delivery gate, not a rate of spend. Lowering it too far stops
 * delivery outright rather than slowing it, so the rungs stop at fifteen.
 *
 * Like the budget policy, this is a stated operating policy and not a proven
 * optimum.
 */
import type { MinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";

export const BID_SIZING_POLICY_VERSION = "meta.bid-sizing.v1" as const;

/**
 * Provider bid strategies that own a writable `bid_amount`.
 *
 * Compared case-insensitively against the retained value, and re-proved at
 * write time against the provider's own. `manual_bid` appears in retained rows
 * for two accounts but is NOT assumed to be a provider strategy: it is absent
 * here on purpose, so a row carrying it produces no intent and the question is
 * settled by a real provider read rather than by this list.
 */
export const BID_CAP_STRATEGIES = ["cost_cap", "bid_cap", "lowest_cost_with_bid_cap"] as const;

export const BID_SIZING_POLICY_V1 = {
  version: BID_SIZING_POLICY_VERSION,
  ladder: [5, 10, 15] as const,
  /** `q = cpa28d / spendUnit`; inside this band the cap is where it should be. */
  deadBand: { min: 0.9, max: 1.1 },
  /** Raising a cap only makes sense when delivery is actually constrained. */
  raiseBands: [
    { maxRatio: 0.75, percent: 15 },
    { maxRatio: 0.9, percent: 10 },
  ],
  lowerBands: [
    { minRatio: 1.4, percent: 15 },
    { minRatio: 1.1, percent: 10 },
  ],
  /** The policy's own ceiling on a single change; never the budget ceiling. */
  maxBidChangePercent: 15,
} as const;

export type BidSizingWithheldCode =
  | "bid_strategy_not_writable"
  | "current_bid_unknown"
  | "spend_unit_unavailable"
  | "currency_unresolvable"
  | "cpa_unavailable"
  | "maturity_insufficient"
  | "within_cpa_dead_band"
  | "no_delivery_constraint"
  | "sibling_change_same_window"
  | "policy_cooldown_active"
  | "policy_change_frequency_exceeded"
  | "sizing_policy_version_unbound";

export interface BidSizingInput {
  /** Retained `bid_strategy_type`, from meta_adset_daily or config history. */
  bidStrategyType: string | null;
  currentBidMinor: number | null;
  /** Spend unit in MINOR units — the derived CPA benchmark. */
  spendUnitMinor: number | null;
  /**
   * The account currency's ISO-4217 minor-unit exponent, resolved by the
   * caller from `lib/currency/iso-4217-minor-units` — the one registry this
   * repository has for the question, and the same one that built
   * `spendUnitMinor` and that the bid intent contract re-resolves at write
   * time.
   *
   * It has to be here because the two operands below arrive in different
   * units: `spend28d` is a MAJOR-unit sum of the daily tables, while the
   * benchmark was built as `round(major * 10 ** exponent)`. Null when the
   * registry refuses the code, because a ratio computed on an assumed scale
   * is worse than no ratio at all.
   */
  currencyExponent: MinorUnitExponent | null;
  /** 28-day spend in MAJOR units, summed from `meta_*_daily.spend`. */
  spend28d: number | null;
  purchases28d: number | null;
  maturityOk: boolean;
  /**
   * Delivery is actually limited: a `delivery_stall` anomaly, or a measured
   * fall in impressions or spend against the trailing week.
   */
  deliveryConstrained: boolean;
  /** A budget change already proposed for this ad set in this run. */
  budgetChangeProposedSameWindow: boolean;
  hoursSinceLastChange: number | null;
  changesLast7d: number | null;
  policy: {
    budgetMinHoursBetweenChanges: number | null;
    budgetMaxChangesPer7d: number | null;
    bidSizingPolicyVersion: string | null;
  };
}

export type BidSizingOutcome =
  | {
      status: "sized";
      direction: "increase" | "decrease";
      percent: number;
      proposedBidMinor: number;
      rationale: string[];
      policyVersion: typeof BID_SIZING_POLICY_VERSION;
    }
  | { status: "withheld"; code: BidSizingWithheldCode; detail: string };

function withheld(code: BidSizingWithheldCode, detail: string): BidSizingOutcome {
  return { status: "withheld", code, detail };
}

function positive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isBidCapStrategy(value: string | null | undefined): boolean {
  return bidStrategyFamily(value) !== null;
}

/**
 * The family two spellings of one strategy share.
 *
 * The warehouse says `bid_cap`; Meta says `LOWEST_COST_WITH_BID_CAP`. They are
 * the same strategy, and a write path that compared the retained value with
 * the provider's own by string equality would refuse every real bid cap in the
 * account — reading "the strategy changed" off a difference in vocabulary. The
 * comparison that matters is the family, so it is named once here rather than
 * re-derived at each boundary.
 */
export function bidStrategyFamily(
  value: string | null | undefined,
): "cost_cap" | "bid_cap" | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "cost_cap") return "cost_cap";
  if (normalized === "bid_cap" || normalized === "lowest_cost_with_bid_cap") {
    return "bid_cap";
  }
  return null;
}

export function sizeBidChange(input: BidSizingInput): BidSizingOutcome {
  if (input.policy.bidSizingPolicyVersion !== BID_SIZING_POLICY_VERSION) {
    return withheld(
      "sizing_policy_version_unbound",
      "No bid sizing policy version is bound to this business's automation configuration.",
    );
  }
  if (!isBidCapStrategy(input.bidStrategyType)) {
    return withheld(
      "bid_strategy_not_writable",
      `This ad set runs ${input.bidStrategyType ?? "an unrecorded strategy"}, which owns no writable bid amount.`,
    );
  }
  if (!positive(input.currentBidMinor)) {
    return withheld(
      "current_bid_unknown",
      "No current bid amount was observed for this ad set.",
    );
  }
  if (!input.maturityOk) {
    return withheld(
      "maturity_insufficient",
      "The ad set has not spent enough for its cost per purchase to carry a bid change.",
    );
  }
  if (!positive(input.spendUnitMinor)) {
    return withheld(
      "spend_unit_unavailable",
      "No cost-per-purchase benchmark is available to judge the cap against.",
    );
  }
  if (!positive(input.spend28d) || !positive(input.purchases28d)) {
    return withheld(
      "cpa_unavailable",
      "Cost per purchase could not be computed for the evidence window.",
    );
  }
  if (input.currencyExponent === null) {
    // The registry refuses codes it has not transcribed, and so does this: a
    // benchmark and a cost per purchase compared at guessed scales is a
    // guessed ratio, and the executor would spend real money on it.
    return withheld(
      "currency_unresolvable",
      "The account currency has no known minor-unit scale, so cost per purchase cannot be put on the same footing as the benchmark.",
    );
  }
  if (input.budgetChangeProposedSameWindow) {
    // One lever at a time: changing a cap and a budget together makes the
    // result of neither readable.
    return withheld(
      "sibling_change_same_window",
      "A budget change is already proposed for this ad set, so its bid is left alone.",
    );
  }
  if (
    positive(input.policy.budgetMinHoursBetweenChanges) &&
    input.hoursSinceLastChange !== null &&
    input.hoursSinceLastChange < input.policy.budgetMinHoursBetweenChanges
  ) {
    const wait = Math.ceil(
      input.policy.budgetMinHoursBetweenChanges - input.hoursSinceLastChange,
    );
    return withheld(
      "policy_cooldown_active",
      `This ad set changed too recently; it can be reconsidered in ${wait} hours.`,
    );
  }
  if (
    positive(input.policy.budgetMaxChangesPer7d) &&
    input.changesLast7d !== null &&
    input.changesLast7d >= input.policy.budgetMaxChangesPer7d
  ) {
    return withheld(
      "policy_change_frequency_exceeded",
      "This ad set has already changed as often as the policy allows in seven days.",
    );
  }

  /*
    Both operands at the account's own scale.

    A fixed `* 100` here was only correct for two-decimal currencies. On JPY
    (exponent 0) it inflated cost per purchase a hundredfold, so an ad set half
    the benchmark — a raise — was read as fifty times it and cut instead; on
    KWD (exponent 3) it understated it tenfold and reversed the same decision
    the other way. The wrong side of the dead band is then a real bid amount
    handed to the automatic executor.
  */
  const cpaMinor =
    (input.spend28d / input.purchases28d) * 10 ** input.currencyExponent;
  const ratio = cpaMinor / input.spendUnitMinor;
  const rationale: string[] = [];

  if (ratio >= BID_SIZING_POLICY_V1.deadBand.min && ratio <= BID_SIZING_POLICY_V1.deadBand.max) {
    return withheld(
      "within_cpa_dead_band",
      `Cost per purchase is ${ratio.toFixed(2)}x the benchmark, which is where the cap should be.`,
    );
  }

  let direction: "increase" | "decrease";
  let percent: number;

  if (ratio < BID_SIZING_POLICY_V1.deadBand.min) {
    // Under the benchmark. Raising a cap that is not actually holding delivery
    // back buys nothing and costs more per result, so the constraint has to be
    // observed rather than assumed from the ratio alone.
    if (!input.deliveryConstrained) {
      return withheld(
        "no_delivery_constraint",
        "Cost per purchase is under the benchmark but delivery is not constrained, so raising the cap would only raise costs.",
      );
    }
    const band = BID_SIZING_POLICY_V1.raiseBands.find(
      (candidate) => ratio < candidate.maxRatio,
    )!;
    direction = "increase";
    percent = band.percent;
    rationale.push(
      `cost per purchase is ${ratio.toFixed(2)}x the benchmark and delivery is constrained → +${percent}%`,
    );
  } else {
    const band = BID_SIZING_POLICY_V1.lowerBands.find(
      (candidate) => ratio >= candidate.minRatio,
    )!;
    direction = "decrease";
    percent = band.percent;
    rationale.push(
      `cost per purchase is ${ratio.toFixed(2)}x the benchmark → -${percent}%`,
    );
  }

  if (percent > BID_SIZING_POLICY_V1.maxBidChangePercent) {
    percent = BID_SIZING_POLICY_V1.maxBidChangePercent;
    rationale.push(`policy ceiling → ${percent}%`);
  }

  const factor = direction === "increase" ? 1 + percent / 100 : 1 - percent / 100;
  const proposedBidMinor = Math.round(input.currentBidMinor * factor);
  if (proposedBidMinor === input.currentBidMinor || proposedBidMinor <= 0) {
    return withheld(
      "within_cpa_dead_band",
      "Every approved change rounds back to the current bid.",
    );
  }

  return {
    status: "sized",
    direction,
    percent,
    proposedBidMinor,
    rationale,
    policyVersion: BID_SIZING_POLICY_VERSION,
  };
}
