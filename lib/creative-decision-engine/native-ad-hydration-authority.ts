/**
 * What the decision loader's hydrated config is allowed to authorise.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Calibration learned a cohort's economics from ad-days classified by how well
 * their configuration was observed. The decision loader read the same three
 * config fields with no provenance at all, so the two halves of the engine
 * disagreed about what is knowable: an ad-day could be too weakly observed to
 * enter a calibration sample and still, on the very same evidence, carry a hard
 * Cut through the decision path. Reading one contract in both places is the
 * point of this module.
 *
 * THE RULE IS NOT RESTATED HERE. `classifyConfigAuthorityDay`,
 * `resolveVerifiedAuthoritySuffix` and `resolveCalibrationSampleAuthority` are
 * the same functions calibration calls, and they are called here over the same
 * per-field tiers and readinesses. This module only reshapes what SQL returned —
 * parallel arrays, one element per day of the loader's window — into the per-day
 * tuples those functions take. The SQL deliberately computes no verdict of its
 * own, because a verdict in SQL would be a second definition of "we may act on
 * this".
 *
 * WHAT THE ARRAYS ARE. The loader hydrates a 28-day window and returns one row
 * per ad, so a day-scoped fact has to travel as an array. They are aggregated
 * `ORDER BY date` in one CTE, so element i of every array describes the same
 * day; a length disagreement means the aggregation drifted and is refused rather
 * than silently zipped short.
 */
import {
  addConfigAuthorityDay,
  classifyConfigAuthorityDay,
  EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS,
  EMPTY_VERIFIED_AUTHORITY_SUFFIX,
  resolveCalibrationSampleAuthority,
  resolveNativeAdConfigAuthority,
  resolveVerifiedAuthoritySuffix,
  type MetaConfigDayAuthorityClass,
  type MetaConfigSampleAuthority,
  type MetaConfigSampleAuthorityCounts,
  type NativeAdConfigAuthority,
  type VerifiedAuthoritySuffix,
} from "@/lib/meta/config-field-readiness";
import { isPurchaseCohort, type MetaFunnelCohort } from "@/lib/meta/funnel-cohort";
import {
  META_CONFIG_EVIDENCE_FIELDS,
  parseConfigFieldEvidenceRef,
  parseConfigReceiptWindowManifest,
  type ConfigFieldEvidenceRef,
  type ConfigFieldEvidenceRefRefusal,
  type ConfigReceiptWindowManifest,
  type MetaConfigEvidenceField,
} from "@/lib/meta/config-field-evidence-ref";

export interface HydratedConfigAuthorityRow {
  /** The day the scalar provenance below describes; see `observedDate`. */
  latestContextDate: string | null;
  /**
   * The evaluation day in the ACCOUNT's calendar, not the scheduler's.
   *
   * The job's `asOf` is a UTC date taken at 03 or 15 UTC; `latestContextDate` is
   * provider-local. For an account west of UTC those are different days at 03
   * UTC even when nothing is stale, so the comparison is made against this.
   */
  providerLocalAsOfDate: string | null;
  /** The deciding day's own provenance, gated by the loader's cardinality tests. */
  objectiveTier: string | null;
  objectiveReadiness: string | null;
  optimizationGoalTier: string | null;
  optimizationGoalReadiness: string | null;
  customEventTypeTier: string | null;
  customEventTypeReadiness: string | null;
  customEventType: string | null;
  customConversionId: string | null;
  customConversionIdReadiness: string | null;
  /** The window, one element per day, all aggregated in the same date order. */
  authorityDates: string[];
  authoritySpend: number[];
  authorityConversions: number[];
  authorityRevenue: number[];
  authorityObjectiveTier: (string | null)[];
  authorityObjectiveReadiness: (string | null)[];
  authorityGoalTier: (string | null)[];
  authorityGoalReadiness: (string | null)[];
  authorityEventTier: (string | null)[];
  authorityEventReadiness: (string | null)[];
  authorityEventValue: (string | null)[];
  authorityCustomConversionId: (string | null)[];
  authorityCustomConversionReadiness: (string | null)[];
  objectiveReceiptDisagreements: number;
  optimizationGoalReceiptDisagreements: number;
  /**
   * The EVALUATION DAY's own receipt, resolved independently of metric days.
   *
   * Everything above describes the most recent day the loader has CONTEXT for,
   * which is metric-driven; during an ingest outage that day goes stale while
   * the ad keeps delivering. These describe the day the action is actually taken
   * on, and their readiness is already withheld at the SQL boundary when the
   * current receipt names a different configuration than the one in play.
   */
  currentConfigDay: string | null;
  currentObjectiveTier: string | null;
  currentObjectiveReadiness: string | null;
  currentOptimizationGoalTier: string | null;
  currentOptimizationGoalReadiness: string | null;
  currentCustomEventTypeTier: string | null;
  currentCustomEventTypeReadiness: string | null;
  currentCustomEventType: string | null;
  currentCustomConversionId: string | null;
  currentCustomConversionIdReadiness: string | null;
  /**
   * WHICH RECEIPT each field of the evaluation day's verdict rests on
   * (`ConfigFieldEvidenceRef` JSON, lib/meta/config-field-evidence-ref.ts).
   *
   * The loader always supplies all four keys, and a key it could not fill is
   * null — an absent receipt, which fails closed like a malformed one. Only a
   * hand-built row that predates receipt lineage omits the property; its
   * references are then reported as explicit nulls and nothing is gated on
   * them, because there is nothing to gate on.
   */
  currentEvidenceRefs?: Record<MetaConfigEvidenceField, unknown>;
  /**
   * The economic window's receipt manifest facts, aggregated in SQL over the
   * same economic days `decisionEconomics` counts. Omitted only by a
   * hand-built row that predates receipt lineage.
   */
  authorityReceiptManifest?: {
    hash: unknown;
    economicDayCount: unknown;
    nullObservationIdCount: unknown;
    incoherentDayCount: unknown;
  };
}

/** Why a supplied current-day reference did not count as evidence. */
export type CurrentEvidenceRefRefusal =
  | ConfigFieldEvidenceRefRefusal
  /** The reference is coherent, but names a different tier than the row's. */
  | "row_tier_mismatch"
  /** The reference is coherent, but its authority differs from the hydrated row. */
  | "row_readiness_mismatch";

export interface HydratedConfigAuthority {
  /**
   * The verdict for the most recently OBSERVED day, which is not necessarily
   * today.
   *
   * `latest_context` picks the newest day present in the loader's context, and
   * that comes from metric rows — so for an ad whose today has not been ingested
   * yet (every ad, on a 03:06 run) this describes YESTERDAY. Calling it the
   * current configuration would be a false claim: nothing here observed today.
   *
   * `observedDate` and `describesAsOfDay` carry that distinction rather than
   * leaving it to be assumed. Whether a day-old configuration may still
   * authorise an action today is a POLICY question with a real cost either way,
   * and it is deliberately not answered inside this function.
   */
  latestDay: NativeAdConfigAuthority;
  /** The provider-local day `latestDay` describes, or null when there is none. */
  observedDate: string | null;
  /** The evaluation day in the account's calendar, which `observedDate` is read against. */
  evaluationDay: string | null;
  /** Whether that day IS the evaluation day. False is the normal case at 03:06. */
  describesAsOfDay: boolean;
  /** Whole days from the observed day to the evaluation day; null if unreadable. */
  observedAgeDays: number | null;
  /** The provider-local day the current receipt describes, or null if none. */
  currentConfigDay: string | null;
  /**
   * WAS THE VALUE OBSERVED, as distinct from was the DAY PROVEN.
   *
   * These are two different questions and collapsing them breaks the product. A
   * whole-day bracket needs an observation after the day ends, so on any natural
   * run the freshest day cannot have one — it is `pending_corroboration` by
   * construction. Requiring a bracket for the day an action acts on would
   * therefore make every hard output review-only on every run, every day, for
   * reasons that have nothing to do with the evidence.
   *
   * The bracket is what an ECONOMIC sample needs: to attribute a day's spend to
   * a configuration you must know the configuration held through that day. The
   * action needs something weaker and different: that a complete, field-scoped
   * provider receipt actually named these values. That is what this reports, and
   * the verified suffix reports the other.
   *
   * `bracketed` is kept beside it so the stronger fact is still visible when it
   * happens to be true — it is never required for the value to count as observed.
   */
  currentValueEvidence: {
    /** A provider receipt named every gating field on the observed day. */
    observed: boolean;
    /** That receipt also proved the whole day at both ends. Rare when fresh. */
    bracketed: boolean;
    /** The weakest gating field's tier, for a surface that has to say why. */
    weakestTier: string | null;
    /**
     * The receipt each field's verdict rests on. Null for a field with no
     * coherent reference, and for every field when lineage was not supplied.
     */
    refs: Record<MetaConfigEvidenceField, ConfigFieldEvidenceRef | null>;
    /**
     * Supplied references that were refused, by field. A refused field's
     * readiness was treated as `none` before the verdict above was computed.
     */
    refRefusals: Partial<Record<MetaConfigEvidenceField, CurrentEvidenceRefRefusal>>;
    /** False only for a hand-built row that predates receipt lineage. */
    lineageSupplied: boolean;
  };
  /** Every economic day included in this ad's decision metrics has proven config. */
  decisionEconomics: {
    fullyVerified: boolean;
    economicDayCount: number;
    unverifiedEconomicDayCount: number;
    /**
     * WHICH RECEIPTS the economic days rested on, as a compact manifest. Null
     * when lineage was not supplied, or when the supplied manifest was
     * malformed — in which case `fullyVerified` is false.
     */
    receiptManifest: ConfigReceiptWindowManifest | null;
  };
  /** The window's ad-days and spend, split by what each day's provenance permits. */
  counts: MetaConfigSampleAuthorityCounts;
  /** The contiguous verified run at the recent end; see the resolver for why a suffix. */
  suffix: VerifiedAuthoritySuffix;
  /** The window roll-up, with the share of spend that rested on authoritative config. */
  window: MetaConfigSampleAuthority;
  /**
   * Days where the provider RECEIPT named a different value than the one this
   * query chose.
   *
   * Not an error and not silently dropped: the readiness for such a day is
   * already withheld at the SQL level, because a receipt cannot vouch for a
   * value it does not name. Counted so the disagreement is visible rather than
   * appearing as unexplained missing authority.
   */
  receiptDisagreements: {
    objective: number;
    optimizationGoal: number;
  };
}

export const EMPTY_HYDRATED_CONFIG_AUTHORITY: HydratedConfigAuthority = {
  latestDay: {
    readiness: "none",
    blockingField: "objective",
    pendingCorroborationOnly: false,
    purchaseCohortWithoutEvent: false,
    valueEstablished: false,
  },
  observedDate: null,
  evaluationDay: null,
  describesAsOfDay: false,
  observedAgeDays: null,
  currentConfigDay: null,
  currentValueEvidence: {
    observed: false,
    bracketed: false,
    weakestTier: null,
    refs: {
      objective: null,
      optimization_goal: null,
      custom_event_type: null,
      custom_conversion_id: null,
    },
    refRefusals: {},
    lineageSupplied: false,
  },
  decisionEconomics: {
    fullyVerified: false,
    economicDayCount: 0,
    unverifiedEconomicDayCount: 0,
    receiptManifest: null,
  },
  counts: EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS,
  suffix: EMPTY_VERIFIED_AUTHORITY_SUFFIX,
  window: {
    readiness: "none",
    reason: "no_sample",
    authoritativeSpendShare: null,
  },
  receiptDisagreements: { objective: 0, optimizationGoal: 0 },
};

/** Tiers where the receipt also proved the whole day at both of its ends. */
const BRACKETED_TIERS = new Set([
  "provider_receipt_day_bracketed",
  "provider_receipt_legacy_bracketed",
]);

/**
 * Was the value ESTABLISHED, as distinct from was the DAY PROVEN.
 *
 * Derived from the resolver's own verdict rather than re-read from the raw
 * tiers, which is the whole fix: a tier-only test said "a receipt spoke" and
 * missed both a receipt that spoke about a DIFFERENT value than the one this
 * query chose, and a conversion target whose MEANING was never read. Both are
 * already expressed in `valueEstablished`, computed where every gate is
 * visible; reading it here keeps one definition instead of two.
 *
 * `bracketed` stays a separate, weaker-to-obtain fact, reported beside it and
 * never required.
 */
/**
 * Parses the evaluation day's receipt references and says which fields may keep
 * their readiness. FAIL CLOSED: once lineage is supplied, a field whose
 * reference is absent, malformed, incoherent, or names a different tier than
 * the row carries is treated as `none` before any authority rule reads it.
 */
function currentEvidenceRefs(row: HydratedConfigAuthorityRow): {
  refs: Record<MetaConfigEvidenceField, ConfigFieldEvidenceRef | null>;
  refusals: Partial<Record<MetaConfigEvidenceField, CurrentEvidenceRefRefusal>>;
  supplied: boolean;
} {
  const refs: Record<MetaConfigEvidenceField, ConfigFieldEvidenceRef | null> = {
    objective: null,
    optimization_goal: null,
    custom_event_type: null,
    custom_conversion_id: null,
  };
  const refusals: Partial<Record<MetaConfigEvidenceField, CurrentEvidenceRefRefusal>> = {};
  if (row.currentEvidenceRefs === undefined) {
    return { refs, refusals, supplied: false };
  }
  const rowTier: Record<MetaConfigEvidenceField, string | null> = {
    objective: row.currentObjectiveTier,
    optimization_goal: row.currentOptimizationGoalTier,
    custom_event_type: row.currentCustomEventTypeTier,
    /* custom_conversion_id carries no tier column; its reference names its own. */
    custom_conversion_id: null,
  };
  const rowReadiness: Record<MetaConfigEvidenceField, string | null> = {
    objective: row.currentObjectiveReadiness,
    optimization_goal: row.currentOptimizationGoalReadiness,
    custom_event_type: row.currentCustomEventTypeReadiness,
    custom_conversion_id: row.currentCustomConversionIdReadiness,
  };
  for (const field of META_CONFIG_EVIDENCE_FIELDS) {
    const parsed = parseConfigFieldEvidenceRef(row.currentEvidenceRefs[field], field);
    if (!parsed.ok) {
      refusals[field] = parsed.refusal;
      continue;
    }
    if (rowTier[field] !== null && parsed.ref.tier !== rowTier[field]) {
      refusals[field] = "row_tier_mismatch";
      continue;
    }
    /*
      A receipt reference describes the contract's readiness before the
      hydration query's value-agreement checks. If SQL withheld authority
      because the receipt names a different value, retaining that reference as
      evidence would let the JSON and scalar halves contradict one another.
      Require exact agreement for every field, including custom conversion.
    */
    if (parsed.ref.readiness !== rowReadiness[field]) {
      refusals[field] = "row_readiness_mismatch";
      continue;
    }
    refs[field] = parsed.ref;
  }
  return { refs, refusals, supplied: true };
}

function currentValueEvidence(
  row: HydratedConfigAuthorityRow,
  cohort: MetaFunnelCohort,
): HydratedConfigAuthority["currentValueEvidence"] {
  const lineage = currentEvidenceRefs(row);
  /* A refused reference is not evidence: its field reads as `none`. */
  const gated = (field: MetaConfigEvidenceField, readiness: string | null) =>
    lineage.supplied && lineage.refs[field] === null ? "none" : readiness;
  /*
    Resolved over the EVALUATION DAY's receipt, not the last metric day's. The
    same rule, the same function — only the inputs differ, which is the point:
    the gate's question is about the day the action lands on.
  */
  const verdict = resolveNativeAdConfigAuthority({
    cohort,
    objectiveTier: row.currentObjectiveTier,
    objectiveReadiness: gated("objective", row.currentObjectiveReadiness),
    optimizationGoalTier: row.currentOptimizationGoalTier,
    optimizationGoalReadiness: gated(
      "optimization_goal",
      row.currentOptimizationGoalReadiness,
    ),
    customEventTypeTier: row.currentCustomEventTypeTier,
    customEventTypeReadiness: gated(
      "custom_event_type",
      row.currentCustomEventTypeReadiness,
    ),
    customEventType: row.currentCustomEventType,
    customConversionId: row.currentCustomConversionId,
    customConversionIdReadiness: gated(
      "custom_conversion_id",
      row.currentCustomConversionIdReadiness,
    ),
  });
  const gating = [row.currentObjectiveTier, row.currentOptimizationGoalTier];
  if (isPurchaseCohort(cohort)) gating.push(row.currentCustomEventTypeTier);
  return {
    refs: lineage.refs,
    refRefusals: lineage.refusals,
    lineageSupplied: lineage.supplied,
    observed: verdict.valueEstablished,
    bracketed:
      verdict.valueEstablished &&
      gating.every((tier) => tier !== null && BRACKETED_TIERS.has(tier)),
    /* The field the verdict stopped at, with the tier it stopped on. */
    weakestTier:
      verdict.blockingField === "objective"
        ? row.currentObjectiveTier
        : verdict.blockingField === "optimization_goal"
          ? row.currentOptimizationGoalTier
          : verdict.blockingField === "custom_event_type"
            ? row.currentCustomEventTypeTier
            : verdict.blockingField === "custom_conversion_id"
              ? "custom_conversion_event_type_unread"
              : (gating.find(
                  (tier) => tier !== null && !BRACKETED_TIERS.has(tier),
                ) ?? null),
  };
}

/** Whole days from `from` to `to`, or null if either date is unreadable. */
function wholeDaysBetween(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

/** Element i of every array must describe the same day, or nothing may be zipped. */
function arraysAgree(row: HydratedConfigAuthorityRow): boolean {
  const n = row.authorityDates.length;
  return [
    row.authoritySpend,
    row.authorityConversions,
    row.authorityRevenue,
    row.authorityObjectiveTier,
    row.authorityObjectiveReadiness,
    row.authorityGoalTier,
    row.authorityGoalReadiness,
    row.authorityEventTier,
    row.authorityEventReadiness,
    row.authorityEventValue,
    row.authorityCustomConversionId,
    row.authorityCustomConversionReadiness,
  ].every((column) => column.length === n) &&
    [row.authoritySpend, row.authorityConversions, row.authorityRevenue]
      .every((column) => column.every(Number.isFinite));
}

export function resolveHydratedConfigAuthority(input: {
  cohort: MetaFunnelCohort;
  /** The evaluation day, for measuring a receipt's age against the horizon. */
  asOfDate: string;
  row: HydratedConfigAuthorityRow;
}): HydratedConfigAuthority {
  const { row } = input;
  const latestDay = resolveNativeAdConfigAuthority({
    cohort: input.cohort,
    objectiveReadiness: row.objectiveReadiness,
    objectiveTier: row.objectiveTier,
    optimizationGoalReadiness: row.optimizationGoalReadiness,
    optimizationGoalTier: row.optimizationGoalTier,
    customEventTypeReadiness: row.customEventTypeReadiness,
    customEventTypeTier: row.customEventTypeTier,
    customEventType: row.customEventType,
    customConversionId: row.customConversionId,
    customConversionIdReadiness: row.customConversionIdReadiness,
  });
  const observedDate = row.latestContextDate;
  /* Provider-local on both sides, or the age is an account's UTC offset. */
  const evaluationDay = row.providerLocalAsOfDate ?? input.asOfDate;
  const observedAgeDays = observedDate
    ? wholeDaysBetween(observedDate, evaluationDay)
    : null;
  const dayFacts = {
    observedDate,
    evaluationDay,
    describesAsOfDay: observedDate !== null && observedDate === evaluationDay,
    observedAgeDays,
    currentConfigDay: row.currentConfigDay,
    currentValueEvidence: currentValueEvidence(row, input.cohort),
  };
  const receiptDisagreements = {
    objective: row.objectiveReceiptDisagreements,
    optimizationGoal: row.optimizationGoalReceiptDisagreements,
  };
  /*
    The economic window's receipt manifest. Supplied by the loader on every
    row; a supplied manifest that does not parse is not evidence, and the
    window cannot be fully verified on it.
  */
  const manifestSupplied = row.authorityReceiptManifest !== undefined;
  const receiptManifest = manifestSupplied
    ? parseConfigReceiptWindowManifest(row.authorityReceiptManifest!)
    : null;

  /*
    A LENGTH DISAGREEMENT FAILS CLOSED. Zipping to the shortest array would
    silently drop the days at one end of the window — and it is the RECENT end
    that decides a verified suffix, so the failure would not look like a bug, it
    would look like an ad that merely lacks recent evidence.
  */
  if (row.authorityDates.length === 0 || !arraysAgree(row)) {
    return {
      ...EMPTY_HYDRATED_CONFIG_AUTHORITY,
      latestDay,
      ...dayFacts,
      decisionEconomics: {
        ...EMPTY_HYDRATED_CONFIG_AUTHORITY.decisionEconomics,
        receiptManifest,
      },
      receiptDisagreements,
    };
  }

  const classified: Array<{
    date: string;
    spend: number;
    conversions: number;
    revenue: number;
    dayClass: MetaConfigDayAuthorityClass;
  }> = [];
  let counts = EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS;
  let economicDayCount = 0;
  let unverifiedEconomicDayCount = 0;
  for (let i = 0; i < row.authorityDates.length; i += 1) {
    const dayClass = classifyConfigAuthorityDay({
      cohort: input.cohort,
      objectiveReadiness: row.authorityObjectiveReadiness[i],
      objectiveTier: row.authorityObjectiveTier[i],
      optimizationGoalReadiness: row.authorityGoalReadiness[i],
      optimizationGoalTier: row.authorityGoalTier[i],
      customEventTypeReadiness: row.authorityEventReadiness[i],
      customEventTypeTier: row.authorityEventTier[i],
      customEventType: row.authorityEventValue[i],
      customConversionId: row.authorityCustomConversionId[i],
      customConversionIdReadiness: row.authorityCustomConversionReadiness[i],
      date: row.authorityDates[i]!,
      // `date` is a provider-local reporting day. At 03 UTC a west-of-UTC
      // account is still on yesterday, so the corroboration horizon must be
      // measured in that same calendar rather than the scheduler's UTC date.
      asOfDate: evaluationDay,
    });
    const spend = row.authoritySpend[i] ?? 0;
    const economicallyMeaningful =
      spend !== 0 ||
      (row.authorityConversions[i] ?? 0) !== 0 ||
      (row.authorityRevenue[i] ?? 0) !== 0;
    if (economicallyMeaningful) {
      economicDayCount += 1;
      if (dayClass !== "decision_authority") {
        unverifiedEconomicDayCount += 1;
      }
    }
    classified.push({
      date: row.authorityDates[i]!,
      spend,
      conversions: row.authorityConversions[i] ?? 0,
      revenue: row.authorityRevenue[i] ?? 0,
      dayClass,
    });
    counts = addConfigAuthorityDay(counts, dayClass, spend);
  }

  return {
    latestDay,
    ...dayFacts,
    counts,
    decisionEconomics: {
      /*
        The manifest must describe exactly the days this loop judged, and none
        of them may carry an incoherent reference. The SQL already forced such a
        day's readiness to `none`; this is the cross-check that the two halves
        counted the same window, so a drift between them fails closed instead of
        silently verifying a window the manifest does not describe.
      */
      fullyVerified:
        economicDayCount > 0 &&
        unverifiedEconomicDayCount === 0 &&
        (!manifestSupplied ||
          (receiptManifest !== null &&
            receiptManifest.economicDayCount === economicDayCount &&
            receiptManifest.incoherentDayCount === 0)),
      economicDayCount,
      unverifiedEconomicDayCount,
      receiptManifest,
    },
    suffix: resolveVerifiedAuthoritySuffix(classified),
    window: resolveCalibrationSampleAuthority(counts),
    receiptDisagreements,
  };
}
