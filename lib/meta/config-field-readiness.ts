/**
 * What a row's config provenance permits, at the decision boundary.
 *
 * The source contract says where each field came from and how strong that is.
 * This turns those per-field answers into one verdict for an ad-day, and it is a
 * separate module because calibration and decision hydration must reach the same
 * verdict from the same inputs — two copies of this rule would be two different
 * definitions of "we may act on this".
 *
 * The rule that needed care is which fields GATE at all. Objective and the
 * optimization goal always do: they state what the delivery was optimising for,
 * and an economic judgement without them is a judgement about an unknown thing.
 * The conversion event does NOT always: for a THRUPLAY or PROFILE_VISIT cohort
 * the goal already states the intent and there is no purchase event to be missing
 * — holding those for an absent event would be a gap invented out of a field that
 * was never relevant. In a PURCHASE cohort it is relevant, and an absence there
 * is a real contradiction rather than a silence: the cohort claims purchases
 * while the provider says no purchase event is configured.
 */
import type { MetaFunnelCohort } from "@/lib/meta/funnel-cohort";
import {
  isPurchaseCohort,
  resolveMetaFunnelCohortFromConfigOnly,
} from "@/lib/meta/funnel-cohort";
import {
  CORROBORATION_HORIZON_DAYS,
  type MetaConfigFieldReadiness,
} from "@/lib/meta/config-field-source-contract";

/** Which field held the verdict back, for a surface that has to say why. */
export interface NativeAdConfigAuthority {
  readiness: MetaConfigFieldReadiness;
  /** The weakest gating field, or null when nothing held it back. */
  blockingField:
    | "objective"
    | "optimization_goal"
    | "custom_event_type"
    | "custom_conversion_id"
    | null;
  /**
   * Everything that fell short did so ONLY because its receipt has not been
   * corroborated by a later observation yet.
   *
   * This separates a fact about OUR VANTAGE POINT from a fact about the
   * evidence. A receipt captured this morning cannot have a next-day
   * corroborating observation — not because anything is uncertain about what
   * the provider said, but because tomorrow has not happened. A day that is
   * review-only for that reason is expected to settle; a day that is
   * review-only because its page timing is unknowable never will.
   *
   * Without the distinction the two collapse, and every ad with a spending day
   * TODAY is review-only forever — which is cautious and useless.
   */
  pendingCorroborationOnly: boolean;
  /**
   * The provider positively reported no conversion TARGET at all while the cohort
   * claims purchases. Not the same as never having looked, and worth surfacing.
   *
   * A missing `custom_event_type` alone does not mean that: Meta's promoted object
   * carries `custom_conversion_id` as a SEPARATE field, so an ad set can name a
   * custom conversion instead of a standard event and still be optimising for
   * purchases. (Live today the distinction is latent — no spending ad-set-day in
   * 2026-08-25..09-20 carries a custom_conversion_id, and all 1,672 Offsite
   * Conversions and 89 Value rows carry an event — but a rule that reads the
   * absence of one field as the absence of the intent would be wrong the first
   * time a custom conversion appears.)
   */
  purchaseCohortWithoutEvent: boolean;
  /**
   * A receipt named EVERY gating field, for the value actually in play, and the
   * meaning of those values is established.
   *
   * ── WHAT THIS IS FOR, AND WHY IT IS NOT `readiness` ─────────────────────
   *
   * An action needs a weaker thing than an economic sample does. A sample must
   * know the configuration held through a whole day, which needs a bracket — an
   * observation after the day ends. The freshest day of any natural run cannot
   * have one, so gating an action on `readiness === "decision_authority"` would
   * hold every hard output on every run, forever, for a reason that has nothing
   * to do with the evidence.
   *
   * ── AND WHY IT IS NOT THE TIER EITHER ──────────────────────────────────
   *
   * It was, and a purely structural test let two real cases through:
   *
   *   1. A receipt bracketed for value X while the query chose value Y from the
   *      warehouse. The tier says a receipt spoke; it spoke about something
   *      else. `readiness` is already withheld for exactly this — the agreement
   *      test at the SQL boundary sets it to `none` — so the readiness must be
   *      part of the test, not just the tier.
   *   2. A purchase cohort whose conversion event is `OTHER` beside a custom
   *      conversion. Every tier is a real receipt and every readiness is
   *      authoritative on its own terms, yet what the target MEANS was never
   *      read: Meta's own CustomConversion object carries its event type, and
   *      this contract does not fetch it. The semantic caps express that, and a
   *      tier-only test walked straight past them.
   *
   * So: a receipt tier, a readiness that is not `none`, and no semantic cap. A
   * `provider_receipt_point_in_day` receipt passes — it is a real observation of
   * the value, and holding it merely for lacking a bracket is the mistake this
   * field exists to avoid.
   */
  valueEstablished: boolean;
}

/** Is a conversion target named here at all? Empty string is not an id. */
function hasValue(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

const RANK: Record<MetaConfigFieldReadiness, number> = {
  decision_authority: 2,
  review_only: 1,
  none: 0,
};

/** An unreadable or absent readiness is `none`: absent never means authorised. */
function readinessOf(value: string | null | undefined): MetaConfigFieldReadiness {
  return value === "decision_authority" || value === "review_only"
    ? value
    : "none";
}

export interface NativeAdConfigAuthorityInput {
  cohort: MetaFunnelCohort;
  objectiveReadiness?: string | null;
  objectiveTier?: string | null;
  optimizationGoalReadiness?: string | null;
  optimizationGoalTier?: string | null;
  customEventTypeReadiness?: string | null;
  customEventTypeTier?: string | null;
  /**
   * The event's VALUE, because in a purchase cohort not every event states a
   * purchase. Meta's `OTHER` is a placeholder: the promoted object carries it
   * beside a `custom_conversion_id`, and the conversion's real event type lives
   * on the `CustomConversion` object, which has its own `custom_event_type`
   * field and which this contract does not read. Mapping `OTHER` to PURCHASE is
   * not supported by the provider's own schema.
   */
  customEventType?: string | null;
  /**
   * A custom conversion named instead of a standard event.
   *
   * It is READ FROM ITS OWN RECEIPT, with its own tier and readiness, for the
   * same reason the event type is: a value nothing supplies cannot withhold
   * anything, and this one exists precisely to stop a wrong claim. Its presence
   * does not grant authority — the event type BEHIND the custom conversion is
   * not in this payload, so a purchase economy resting on it is review-only
   * until that event type is verified from its own source.
   */
  customConversionId?: string | null;
  customConversionIdReadiness?: string | null;
}

/** The tier that means "the receipt is fine, tomorrow just hasn't happened". */
const PENDING_TIER = "provider_receipt_pending_corroboration";

/**
 * Tiers where a provider receipt actually named the value on that day.
 *
 * `typed_contemporaneous` is absent on purpose: it is a creative witness with no
 * receipt behind it, and the reason that tier is review-only is that it cites
 * itself. `observed_absent` is absent too — a receipt saying there is NO value
 * is a measurement, not a value. The two synthetic tiers the semantic caps
 * emit are likewise absent, which is what makes them visible to this test.
 *
 * `provider_receipt_legacy_interval_uncertain` was here and is NOT any more, and
 * the reason is what this gate is FOR. Every other tier in this set names the
 * value AND the day it belongs to. That one names the value and explicitly
 * refuses to say which day — its whole definition is that a multi-page fetch may
 * have straddled a provider-local midnight, so the row read on page 9 may belong
 * to a different day from the one on page 1. Accepting it here let a hard Cut or
 * Scale rest on a config value that might describe the day before, which is not
 * a weaker proof of the same claim but a different claim.
 *
 * It is replaced, not merely removed. `provider_receipt_legacy_paged_within_day`
 * is the SAME multi-page receipt with the straddle measured away: first request
 * and last response recorded, both on the row's own local date. That is what
 * keeps the narrowing from becoming a permanent hold on accounts whose config
 * list simply never fits on one page — on the live warehouse, two such accounts
 * carrying 18.0% of the 28-day spend, neither of which ever returns one page.
 *
 * Receipts written before those timings existed carry neither tier's proof and
 * stay held — correctly, because nothing about them says which day they describe.
 */
const RECEIPT_NAMED_VALUE_TIERS = new Set([
  "provider_receipt_day_bracketed",
  "provider_receipt_legacy_bracketed",
  "provider_receipt_point_in_day",
  "provider_receipt_legacy_single_page",
  "provider_receipt_legacy_paged_within_day",
  PENDING_TIER,
]);

export function resolveNativeAdConfigAuthority(
  input: NativeAdConfigAuthorityInput,
): NativeAdConfigAuthority {
  const gates: Array<{
    field: NonNullable<NativeAdConfigAuthority["blockingField"]>;
    readiness: MetaConfigFieldReadiness;
    tier: string | null;
  }> = [
    {
      field: "objective",
      readiness: readinessOf(input.objectiveReadiness),
      tier: input.objectiveTier ?? null,
    },
    {
      field: "optimization_goal",
      readiness: readinessOf(input.optimizationGoalReadiness),
      tier: input.optimizationGoalTier ?? null,
    },
  ];

  const purchase = isPurchaseCohort(input.cohort);
  const namedCustomConversion = hasValue(input.customConversionId);
  /*
    Does the EVENT ITSELF state a purchase, or does the cohort come from the
    goal and objective while the promoted object names something else?

    Asked through the same mapping the cohort is resolved by, rather than a
    second list: passing only the event makes the answer "this event, alone,
    means purchase" — true for PURCHASE and VALUE and for nothing else.
  */
  const eventStatesPurchase =
    hasValue(input.customEventType) &&
    isPurchaseCohort(
      resolveMetaFunnelCohortFromConfigOnly({
        customEventType: input.customEventType,
      }),
    );
  /*
    THE CUSTOM-CONVERSION BRANCH.

    `observed_absent` on the event type is an authoritative statement that no
    STANDARD event is configured. On its own that reads as "no conversion target
    at all", and in a purchase cohort that is a contradiction worth reporting.
    It stops being one the moment the same promoted object names a custom
    conversion: the target exists, it simply is not a standard event.

    What that buys is strictly limited. We now know a target exists and we do
    NOT know which event it fires — that lives on the custom conversion object,
    which this contract does not read. So the day is neither authoritative (the
    purchase semantics are unverified) nor nothing (the target is positively
    observed). It is review-only, named as such, and it will not settle by
    waiting — only by reading the custom conversion's own event type.
  */
  const customConversionSubstitutes =
    purchase &&
    namedCustomConversion &&
    input.customEventTypeTier === "observed_absent" &&
    readinessOf(input.customConversionIdReadiness) !== "none";
  /*
    THE PLACEHOLDER CASE, and the reason this is not just an identity question.

    A promoted object may carry `custom_event_type = OTHER` together with a
    `custom_conversion_id`. Separating those ad sets into their own cells stops
    six unrelated conversions being averaged together, but it does not make any
    one of them a purchase: `OTHER` names no event, and the conversion object
    that does is not read here. With the goal and objective both authoritative,
    nothing else in this function would have held the day back, so a purchase
    economy would have been authorised on a target whose meaning was unread.

    Measured on live `adset_configs` over 30 days: 21 ad sets on one account
    carry OTHER with a custom conversion and 4 more carry OTHER without one —
    and ZERO spending ad-set-days carry OTHER at all. So this is a latent hole
    rather than a wrong decision already taken, which is precisely why it is
    closed now: nothing would have surfaced it.
  */
  const eventDoesNotStatePurchase =
    purchase &&
    !eventStatesPurchase &&
    readinessOf(input.customEventTypeReadiness) !== "none" &&
    input.customEventTypeTier !== "observed_absent";
  if (purchase) {
    gates.push(
      customConversionSubstitutes
        ? {
            field: "custom_conversion_id",
            readiness: "review_only",
            /* Not the pending tier: no later observation resolves this. */
            tier: "custom_conversion_event_type_unread",
          }
        : eventDoesNotStatePurchase
          ? {
              field: "custom_event_type",
              readiness: "review_only",
              tier: "conversion_event_semantics_unread",
            }
          : {
              field: "custom_event_type",
              readiness: readinessOf(input.customEventTypeReadiness),
              tier: input.customEventTypeTier ?? null,
            },
    );
  }

  let weakest = gates[0] ?? {
    field: "objective" as const,
    readiness: "none" as const,
    tier: null,
  };
  for (const gate of gates) {
    if (RANK[gate.readiness] < RANK[weakest.readiness]) weakest = gate;
  }

  const shortfalls = gates.filter(
    (gate) => gate.readiness !== "decision_authority",
  );
  /*
    Every gate, not just the weakest: a single field whose receipt vouched for a
    different value, or whose meaning is unread, is enough to make the whole
    configuration unestablished.
  */
  const valueEstablished = gates.every(
    (gate) =>
      gate.readiness !== "none" &&
      gate.tier !== null &&
      RECEIPT_NAMED_VALUE_TIERS.has(gate.tier),
  );
  return {
    readiness: weakest.readiness,
    valueEstablished,
    blockingField:
      weakest.readiness === "decision_authority" ? null : weakest.field,
    pendingCorroborationOnly:
      weakest.readiness === "review_only" &&
      shortfalls.length > 0 &&
      shortfalls.every((gate) => gate.tier === PENDING_TIER),
    purchaseCohortWithoutEvent:
      purchase &&
      input.customEventTypeTier === "observed_absent" &&
      /* A named custom conversion is a conversion target, so the absence of a
         standard event is not the absence of an intent. */
      !namedCustomConversion,
  };
}

/**
 * What ONE ad-day's config provenance contributes to a sample.
 *
 * The four classes exist because the three-valued readiness could not tell the
 * two kinds of review-only apart, and the difference decides whether a rule is
 * useful or merely safe. See `pendingCorroborationOnly`.
 */
export type MetaConfigDayAuthorityClass =
  | "decision_authority"
  | "review_only_pending"
  | "review_only_settled"
  | "none";

/**
 * Classify one ad-day.
 *
 * `date` and `asOfDate` are both provider-local calendar dates (YYYY-MM-DD); the
 * horizon is measured in whole days between them, so a day is "pending" only
 * while a corroborating observation could still legitimately be missing.
 * Anything older than the horizon that is STILL uncorroborated has had its
 * chance and is counted as settled uncertainty, not as a vantage-point artifact.
 */
export function classifyConfigAuthorityDay(
  input: NativeAdConfigAuthorityInput & {
    date: string;
    asOfDate: string;
  },
): MetaConfigDayAuthorityClass {
  const verdict = resolveNativeAdConfigAuthority(input);
  if (verdict.readiness !== "review_only") return verdict.readiness;
  if (!verdict.pendingCorroborationOnly) return "review_only_settled";
  const ageDays = wholeDaysBetween(input.date, input.asOfDate);
  return ageDays !== null && ageDays <= CORROBORATION_HORIZON_DAYS
    ? "review_only_pending"
    : "review_only_settled";
}

/** Whole days from `from` to `to`, or null if either date is unreadable. */
function wholeDaysBetween(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Ad-days and spend behind a calibration sample, split by config authority.
 *
 * AD-DAY GRAIN, DELIBERATELY. The first version of this counter summarised each
 * ad by the WEAKEST of its ninety days, and that is worthless in production: on
 * any natural run the current day's receipt has no next-day corroboration, so
 * every ad with spend today summarised to review-only and the authoritative
 * count was zero even when eighty-nine days were certain. Counting ad-days keeps
 * one trailing day worth one day. Carrying spend beside the count keeps a
 * twenty-dollar day from weighing the same as a two-thousand-dollar one.
 */
export interface MetaConfigSampleAuthorityCounts {
  decisionAuthorityDays: number;
  reviewOnlyPendingDays: number;
  reviewOnlySettledDays: number;
  noneDays: number;
  decisionAuthoritySpend: number;
  reviewOnlyPendingSpend: number;
  reviewOnlySettledSpend: number;
  noneSpend: number;
}

export const EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS: MetaConfigSampleAuthorityCounts =
  {
    decisionAuthorityDays: 0,
    reviewOnlyPendingDays: 0,
    reviewOnlySettledDays: 0,
    noneDays: 0,
    decisionAuthoritySpend: 0,
    reviewOnlyPendingSpend: 0,
    reviewOnlySettledSpend: 0,
    noneSpend: 0,
  };

const DAY_FIELD: Record<
  MetaConfigDayAuthorityClass,
  keyof MetaConfigSampleAuthorityCounts
> = {
  decision_authority: "decisionAuthorityDays",
  review_only_pending: "reviewOnlyPendingDays",
  review_only_settled: "reviewOnlySettledDays",
  none: "noneDays",
};
const SPEND_FIELD: Record<
  MetaConfigDayAuthorityClass,
  keyof MetaConfigSampleAuthorityCounts
> = {
  decision_authority: "decisionAuthoritySpend",
  review_only_pending: "reviewOnlyPendingSpend",
  review_only_settled: "reviewOnlySettledSpend",
  none: "noneSpend",
};

/** Spend rounds to six places so a numeric round-trip re-sums to the same bytes. */
function roundSpend(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : 0;
}

export function addConfigAuthorityDay(
  counts: MetaConfigSampleAuthorityCounts,
  dayClass: MetaConfigDayAuthorityClass,
  spend: number,
): MetaConfigSampleAuthorityCounts {
  const next = { ...counts };
  next[DAY_FIELD[dayClass]] += 1;
  next[SPEND_FIELD[dayClass]] = roundSpend(
    next[SPEND_FIELD[dayClass]] + (Number.isFinite(spend) ? spend : 0),
  );
  return next;
}

export function mergeConfigAuthorityCounts(
  left: MetaConfigSampleAuthorityCounts,
  right: MetaConfigSampleAuthorityCounts,
): MetaConfigSampleAuthorityCounts {
  return {
    decisionAuthorityDays: left.decisionAuthorityDays + right.decisionAuthorityDays,
    reviewOnlyPendingDays:
      left.reviewOnlyPendingDays + right.reviewOnlyPendingDays,
    reviewOnlySettledDays:
      left.reviewOnlySettledDays + right.reviewOnlySettledDays,
    noneDays: left.noneDays + right.noneDays,
    decisionAuthoritySpend: roundSpend(
      left.decisionAuthoritySpend + right.decisionAuthoritySpend,
    ),
    reviewOnlyPendingSpend: roundSpend(
      left.reviewOnlyPendingSpend + right.reviewOnlyPendingSpend,
    ),
    reviewOnlySettledSpend: roundSpend(
      left.reviewOnlySettledSpend + right.reviewOnlySettledSpend,
    ),
    noneSpend: roundSpend(left.noneSpend + right.noneSpend),
  };
}

export type MetaConfigSampleAuthorityReason =
  | "no_sample"
  | "no_authoritative_day"
  | "settled_uncertain_days"
  | "unprovenanced_days"
  /** Only uncorroborated-but-recent days stand in the way; waiting resolves it. */
  | "pending_corroboration_days"
  | "authoritative";

export interface MetaConfigSampleAuthority {
  readiness: MetaConfigFieldReadiness;
  reason: MetaConfigSampleAuthorityReason;
  /** Share of the sample's spend that rested on authoritative config, or null. */
  authoritativeSpendShare: number | null;
}

/**
 * What a SAMPLE may lend to a decision taken against it.
 *
 * NOTHING IS FORGIVEN, and that includes the pending class.
 *
 * An earlier version of this promoted a sample to `decision_authority` when its
 * only defect was uncorroborated days inside the horizon, on the reasoning that
 * those are a statement about when we looked rather than about the evidence.
 * That reasoning is sound about the CLASS and unsound about the SAMPLE: the
 * cell's economics sum every day's spend and conversions, pending ones included,
 * so forgiving a pending day hands its dollars an authority they were never
 * shown to have. Ninety authoritative-but-tiny days plus one uncorroborated day
 * carrying most of the spend would have read as fully authoritative.
 *
 * So a pending day withholds exactly as a settled-uncertain one does. The class
 * is still counted separately, because a consumer can WAIT for a pending day and
 * cannot wait for a settled one, and because that is the number to re-measure
 * once the provider-side config gap is repaired.
 *
 * NO SHARE THRESHOLD IS APPLIED either. `authoritativeSpendShare` is reported so
 * a later decision about "how much is enough" can be made against measured
 * distributions instead of a number invented here, and none of the existing
 * sample floors (the mature-ad counts) are touched by any of this.
 */
export function resolveCalibrationSampleAuthority(
  counts: MetaConfigSampleAuthorityCounts,
): MetaConfigSampleAuthority {
  const totalDays =
    counts.decisionAuthorityDays +
    counts.reviewOnlyPendingDays +
    counts.reviewOnlySettledDays +
    counts.noneDays;
  const totalSpend =
    counts.decisionAuthoritySpend +
    counts.reviewOnlyPendingSpend +
    counts.reviewOnlySettledSpend +
    counts.noneSpend;
  const authoritativeSpendShare =
    totalSpend > 0 ? counts.decisionAuthoritySpend / totalSpend : null;

  if (totalDays === 0) {
    return { readiness: "none", reason: "no_sample", authoritativeSpendShare };
  }
  if (counts.decisionAuthorityDays === 0) {
    return {
      readiness: "none",
      reason: "no_authoritative_day",
      authoritativeSpendShare,
    };
  }
  if (counts.noneDays > 0) {
    return {
      readiness: "review_only",
      reason: "unprovenanced_days",
      authoritativeSpendShare,
    };
  }
  if (counts.reviewOnlySettledDays > 0) {
    return {
      readiness: "review_only",
      reason: "settled_uncertain_days",
      authoritativeSpendShare,
    };
  }
  if (counts.reviewOnlyPendingDays > 0) {
    return {
      readiness: "review_only",
      reason: "pending_corroboration_days",
      authoritativeSpendShare,
    };
  }
  return {
    readiness: "decision_authority",
    reason: "authoritative",
    authoritativeSpendShare,
  };
}

/**
 * The contiguous run of authority-verified ad-days at the recent end of a window.
 *
 * WHY A SUFFIX AND NOT A SHARE. Two failures pull in opposite directions and a
 * single ratio cannot answer both.
 *
 * Reading the whole window at once fails forward: the provider-side config gap
 * of 2026-08/09 leaves old days with no provenance at all, and a rule that lets
 * any such day withhold authority keeps every ad in review for a FULL QUARTER
 * after the source is repaired — the gap ages out one day at a time while fresh,
 * corroborated receipts arrive daily and change nothing. That is the "everything
 * always needs extra review" failure, and it is indistinguishable from the
 * product being broken.
 *
 * Forgiving recent days fails backward: the freshest day is exactly the one
 * whose receipt cannot be corroborated yet, and on a launch day it can carry
 * most of the window's spend. Forgiving it hands its dollars an authority they
 * were never shown to have.
 *
 * A suffix answers both. Old gaps sit outside it and stop mattering the day
 * enough verified days accumulate after them; a pending or unprovenanced day at
 * the trailing edge is not IN it, so its spend cannot enter whatever is computed
 * from it. Nothing is averaged across a gap and no share is invented.
 *
 * The one skip is bounded by a constant that already exists: trailing days that
 * are `review_only_pending` are stepped over, because by construction they are
 * inside `CORROBORATION_HORIZON_DAYS` and are expected to settle. A trailing day
 * that is settled-uncertain or unprovenanced is NOT stepped over — there is no
 * principled bound on how long such a run may be, and stepping over a month of
 * them would present month-old economics as current.
 */
export interface VerifiedAuthoritySuffix {
  /** Bounds of the verified run, or null when there is none. */
  startDate: string | null;
  endDate: string | null;
  dayCount: number;
  spend: number;
  /** Trailing days stepped over because they are merely uncorroborated yet. */
  pendingTrailingDays: number;
  reason:
    | "verified"
    | "no_verified_day"
    /** The most recent day is uncertain or unprovenanced, not merely pending. */
    | "blocked_at_trailing_edge";
}

export const EMPTY_VERIFIED_AUTHORITY_SUFFIX: VerifiedAuthoritySuffix = {
  startDate: null,
  endDate: null,
  dayCount: 0,
  spend: 0,
  pendingTrailingDays: 0,
  reason: "no_verified_day",
};

/**
 * A day with no spend, no conversions and no revenue contributes nothing to any
 * economy computed from it.
 *
 * Such days are removed from the chain entirely — they neither extend a verified
 * run nor break one. Letting them break it was a real defect: `buildObservations`
 * admits zero-spend days inside an ad's window, so a single trailing day with no
 * activity AND no config receipt would have withheld authority from an ad whose
 * every economically meaningful day was verified.
 *
 * Only ALL THREE being zero makes a day transparent. A zero-spend day carrying a
 * late-attributed conversion or revenue is economically real and must be
 * classified like any other, or the suffix would quietly launder exactly the
 * days whose attribution is hardest.
 */
function economicallyEmpty(day: {
  spend: number;
  conversions: number;
  revenue: number;
}): boolean {
  return (
    (day.spend || 0) === 0 &&
    (day.conversions || 0) === 0 &&
    (day.revenue || 0) === 0
  );
}

export function resolveVerifiedAuthoritySuffix(
  days: ReadonlyArray<{
    date: string;
    spend: number;
    conversions: number;
    revenue: number;
    dayClass: MetaConfigDayAuthorityClass;
  }>,
): VerifiedAuthoritySuffix {
  const ordered = [...days]
    .filter((day) => !economicallyEmpty(day))
    .sort((left, right) => left.date.localeCompare(right.date));
  if (ordered.length === 0) return EMPTY_VERIFIED_AUTHORITY_SUFFIX;

  let index = ordered.length - 1;
  let pendingTrailingDays = 0;
  while (index >= 0 && ordered[index]!.dayClass === "review_only_pending") {
    pendingTrailingDays += 1;
    index -= 1;
  }
  if (index < 0 || ordered[index]!.dayClass !== "decision_authority") {
    return {
      ...EMPTY_VERIFIED_AUTHORITY_SUFFIX,
      pendingTrailingDays,
      reason: index < 0 ? "no_verified_day" : "blocked_at_trailing_edge",
    };
  }

  const endIndex = index;
  let spend = 0;
  while (index >= 0 && ordered[index]!.dayClass === "decision_authority") {
    spend += Number.isFinite(ordered[index]!.spend) ? ordered[index]!.spend : 0;
    index -= 1;
  }
  const startIndex = index + 1;
  return {
    startDate: ordered[startIndex]!.date,
    endDate: ordered[endIndex]!.date,
    dayCount: endIndex - startIndex + 1,
    spend: roundSpend(spend),
    pendingTrailingDays,
    reason: "verified",
  };
}
