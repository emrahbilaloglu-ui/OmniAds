/**
 * Which config fields may hold a decision back, and which may not.
 *
 * The case that motivated this: an `observed_absent` conversion event is a real
 * finding in a PURCHASE cohort and noise in a THRUPLAY one. Gating on it
 * unconditionally would send every video campaign to review for missing a field
 * its optimisation never used.
 */
import { describe, expect, it } from "vitest";

import {
  addConfigAuthorityDay,
  classifyConfigAuthorityDay,
  EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS,
  mergeConfigAuthorityCounts,
  resolveCalibrationSampleAuthority,
  resolveNativeAdConfigAuthority,
  resolveVerifiedAuthoritySuffix,
  EMPTY_VERIFIED_AUTHORITY_SUFFIX,
  type MetaConfigDayAuthorityClass,
} from "@/lib/meta/config-field-readiness";

const AUTHORITY = "decision_authority";
const REVIEW = "review_only";

describe("the event gates only where it is relevant", () => {
  it("does not hold a non-purchase cohort for an absent conversion event", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "engagement",
      objectiveReadiness: AUTHORITY,
      optimizationGoalReadiness: AUTHORITY,
      customEventTypeReadiness: "none",
      customEventTypeTier: "observed_absent",
    });
    expect(verdict.readiness).toBe(AUTHORITY);
    expect(verdict.blockingField).toBeNull();
    expect(verdict.purchaseCohortWithoutEvent).toBe(false);
  });

  it("does hold a purchase cohort for the same absent event", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "purchase",
      objectiveReadiness: AUTHORITY,
      optimizationGoalReadiness: AUTHORITY,
      customEventTypeReadiness: "none",
      customEventTypeTier: "observed_absent",
    });
    expect(verdict.readiness).toBe("none");
    expect(verdict.blockingField).toBe("custom_event_type");
    /* Named, because the provider SAID there is none — it is a contradiction
       with the cohort, not a silence. */
    expect(verdict.purchaseCohortWithoutEvent).toBe(true);
  });
});

describe("the verdict is the weakest gate", () => {
  it("takes review_only when one field is only review_only", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "traffic",
      objectiveReadiness: AUTHORITY,
      optimizationGoalReadiness: REVIEW,
    });
    expect(verdict.readiness).toBe(REVIEW);
    expect(verdict.blockingField).toBe("optimization_goal");
  });

  it("reports the weakest field, not the first weak one", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "traffic",
      objectiveReadiness: REVIEW,
      optimizationGoalReadiness: "none",
    });
    expect(verdict.readiness).toBe("none");
    expect(verdict.blockingField).toBe("optimization_goal");
  });
});

describe("absent never means authorised", () => {
  it("treats a missing readiness as none", () => {
    const verdict = resolveNativeAdConfigAuthority({ cohort: "traffic" });
    expect(verdict.readiness).toBe("none");
    expect(verdict.blockingField).toBe("objective");
  });

  it("treats an unrecognised readiness as none rather than trusting it", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "traffic",
      objectiveReadiness: "looks_fine",
      optimizationGoalReadiness: AUTHORITY,
    });
    expect(verdict.readiness).toBe("none");
    expect(verdict.blockingField).toBe("objective");
  });
});

describe("a custom conversion is also a conversion target", () => {
  /*
    Meta's promoted object carries custom_conversion_id as a separate field from
    custom_event_type, so an absent standard event does not by itself mean the
    provider named no conversion target. Reading it that way would be wrong the
    first time a custom conversion appears — latent today, since no spending
    ad-set-day in the measured window carries one.
  */
  it("withholds the contradiction claim when a custom conversion is named", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "purchase",
      objectiveReadiness: "decision_authority",
      optimizationGoalReadiness: "decision_authority",
      customEventTypeReadiness: "none",
      customEventTypeTier: "observed_absent",
      customConversionId: "1234567890",
    });
    expect(verdict.purchaseCohortWithoutEvent).toBe(false);
    /* Still not authorised: the custom conversion's own event type has to be
       verified before it can carry economics. */
    expect(verdict.readiness).toBe("none");
    expect(verdict.blockingField).toBe("custom_event_type");
  });

  it("still claims the contradiction when no conversion target is named at all", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "purchase",
      objectiveReadiness: "decision_authority",
      optimizationGoalReadiness: "decision_authority",
      customEventTypeReadiness: "none",
      customEventTypeTier: "observed_absent",
      customConversionId: null,
    });
    expect(verdict.purchaseCohortWithoutEvent).toBe(true);
  });
});

describe("the corroboration horizon separates vantage point from uncertainty", () => {
  const AUTHORITATIVE = {
    cohort: "purchase" as const,
    objectiveReadiness: "decision_authority",
    objectiveTier: "provider_receipt_legacy_bracketed",
    optimizationGoalReadiness: "decision_authority",
    optimizationGoalTier: "provider_receipt_legacy_bracketed",
    customEventTypeReadiness: "decision_authority",
    customEventTypeTier: "provider_receipt_legacy_bracketed",
    /* The event's VALUE matters in a purchase cohort: see eventStatesPurchase. */
    customEventType: "PURCHASE",
  };
  /* Today's receipt: nothing wrong with it, tomorrow simply hasn't happened. */
  const PENDING = {
    ...AUTHORITATIVE,
    optimizationGoalReadiness: "review_only",
    optimizationGoalTier: "provider_receipt_pending_corroboration",
  };
  /* Multi-page legacy: no later observation will ever fix the page timing. */
  const SETTLED = {
    ...AUTHORITATIVE,
    optimizationGoalReadiness: "review_only",
    optimizationGoalTier: "provider_receipt_legacy_interval_uncertain",
  };

  it("calls an uncorroborated receipt from today pending, not uncertain", () => {
    expect(
      classifyConfigAuthorityDay({
        ...PENDING,
        date: "2026-09-21",
        asOfDate: "2026-09-21",
      }),
    ).toBe("review_only_pending");
  });

  it("stops forgiving once the receipt has had its chance to settle", () => {
    expect(
      classifyConfigAuthorityDay({
        ...PENDING,
        date: "2026-08-12",
        asOfDate: "2026-09-21",
      }),
    ).toBe("review_only_settled");
  });

  it("never forgives an uncertainty that corroboration cannot resolve", () => {
    expect(
      classifyConfigAuthorityDay({
        ...SETTLED,
        date: "2026-09-21",
        asOfDate: "2026-09-21",
      }),
    ).toBe("review_only_settled");
  });

  /*
    THE CASE THAT KILLED THE FIRST DESIGN. Summarising an ad by the weakest of
    its ninety days made every ad that spent today review-only, so the
    authoritative count was zero on every natural run.
  */
  it("does NOT let a pending day lend authority to its own spend", () => {
    let counts = EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS;
    for (let i = 89; i >= 1; i -= 1) {
      counts = addConfigAuthorityDay(counts, "decision_authority", 100);
    }
    counts = addConfigAuthorityDay(counts, "review_only_pending", 100);

    const resolved = resolveCalibrationSampleAuthority(counts);
    expect(counts.decisionAuthorityDays).toBe(89);
    expect(counts.reviewOnlyPendingDays).toBe(1);
    /*
      The pending class is NAMED separately — a consumer can wait for it — but it
      does not confer authority, because the cell's economics sum its spend along
      with everything else.
    */
    expect(resolved.readiness).toBe("review_only");
    expect(resolved.reason).toBe("pending_corroboration_days");
    expect(resolved.authoritativeSpendShare).toBeCloseTo(89 / 90, 10);
  });

  /*
    THE ADVERSARIAL CASE, stated at its sharpest: the authoritative days are
    numerous and tiny, the single uncorroborated day carries almost all the
    money. A rule that counted days and forgave the pending class would call this
    sample authoritative while 90% of the economy behind it was unverified.
  */
  it("refuses a sample whose one pending day carries most of the spend", () => {
    let counts = EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS;
    for (let i = 89; i >= 1; i -= 1) {
      counts = addConfigAuthorityDay(counts, "decision_authority", 1);
    }
    counts = addConfigAuthorityDay(counts, "review_only_pending", 900);

    const resolved = resolveCalibrationSampleAuthority(counts);
    expect(resolved.readiness).toBe("review_only");
    expect(resolved.reason).toBe("pending_corroboration_days");
    expect(resolved.authoritativeSpendShare).toBeCloseTo(89 / 989, 6);
  });

  it("is authoritative only when every day in the sample is", () => {
    let counts = EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS;
    for (let i = 90; i >= 1; i -= 1) {
      counts = addConfigAuthorityDay(counts, "decision_authority", 100);
    }
    expect(resolveCalibrationSampleAuthority(counts)).toMatchObject({
      readiness: "decision_authority",
      reason: "authoritative",
      authoritativeSpendShare: 1,
    });
  });

  it("withholds authority for one settled-uncertain day in the same sample", () => {
    let counts = EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS;
    for (let i = 89; i >= 1; i -= 1) {
      counts = addConfigAuthorityDay(counts, "decision_authority", 100);
    }
    counts = addConfigAuthorityDay(counts, "review_only_settled", 100);

    const resolved = resolveCalibrationSampleAuthority(counts);
    expect(resolved.readiness).toBe("review_only");
    expect(resolved.reason).toBe("settled_uncertain_days");
  });

  it("answers none when no day in the sample was ever authoritative", () => {
    const counts = addConfigAuthorityDay(
      EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS,
      "review_only_pending",
      100,
    );
    expect(resolveCalibrationSampleAuthority(counts)).toMatchObject({
      readiness: "none",
      reason: "no_authoritative_day",
    });
  });

  it("answers none for an empty sample and reports no share", () => {
    expect(
      resolveCalibrationSampleAuthority(EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS),
    ).toEqual({
      readiness: "none",
      reason: "no_sample",
      authoritativeSpendShare: null,
    });
  });

  it("reports unprovenanced days separately from settled uncertainty", () => {
    let counts = addConfigAuthorityDay(
      EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS,
      "decision_authority",
      50,
    );
    counts = addConfigAuthorityDay(counts, "none", 50);
    expect(resolveCalibrationSampleAuthority(counts)).toMatchObject({
      readiness: "review_only",
      reason: "unprovenanced_days",
      authoritativeSpendShare: 0.5,
    });
  });

  it("merges two samples without losing either grain", () => {
    const left = addConfigAuthorityDay(
      EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS,
      "decision_authority",
      1.1,
    );
    const right = addConfigAuthorityDay(
      EMPTY_CONFIG_SAMPLE_AUTHORITY_COUNTS,
      "review_only_settled",
      2.2,
    );
    expect(mergeConfigAuthorityCounts(left, right)).toMatchObject({
      decisionAuthorityDays: 1,
      reviewOnlySettledDays: 1,
      decisionAuthoritySpend: 1.1,
      reviewOnlySettledSpend: 2.2,
    });
  });
});

describe("a custom conversion is a target, not a verified purchase event", () => {
  const PURCHASE_NO_STANDARD_EVENT = {
    cohort: "purchase" as const,
    objectiveReadiness: "decision_authority",
    objectiveTier: "provider_receipt_legacy_bracketed",
    optimizationGoalReadiness: "decision_authority",
    optimizationGoalTier: "provider_receipt_legacy_bracketed",
    customEventTypeReadiness: "none",
    customEventTypeTier: "observed_absent",
  };

  it("claims a contradiction only when NEITHER target field names anything", () => {
    const verdict = resolveNativeAdConfigAuthority(PURCHASE_NO_STANDARD_EVENT);
    expect(verdict.readiness).toBe("none");
    expect(verdict.blockingField).toBe("custom_event_type");
    expect(verdict.purchaseCohortWithoutEvent).toBe(true);
  });

  it("withdraws the contradiction and holds at review-only for a named custom conversion", () => {
    const verdict = resolveNativeAdConfigAuthority({
      ...PURCHASE_NO_STANDARD_EVENT,
      customConversionId: "23849900000000000",
      customConversionIdReadiness: "decision_authority",
    });
    expect(verdict.purchaseCohortWithoutEvent).toBe(false);
    /* The target exists; which event it fires is not in this payload. */
    expect(verdict.readiness).toBe("review_only");
    expect(verdict.blockingField).toBe("custom_conversion_id");
    /* Waiting will not resolve it — only reading the custom conversion will. */
    expect(verdict.pendingCorroborationOnly).toBe(false);
    expect(
      classifyConfigAuthorityDay({
        ...PURCHASE_NO_STANDARD_EVENT,
        customConversionId: "23849900000000000",
        customConversionIdReadiness: "decision_authority",
        date: "2026-09-21",
        asOfDate: "2026-09-21",
      }),
    ).toBe("review_only_settled");
  });

  it("does not let an UNREAD custom conversion field lift anything", () => {
    const verdict = resolveNativeAdConfigAuthority({
      ...PURCHASE_NO_STANDARD_EVENT,
      customConversionId: "23849900000000000",
      customConversionIdReadiness: null,
    });
    expect(verdict.readiness).toBe("none");
    /* The id is present but its own provenance is unknown, so it proves nothing
       about authority — it still withdraws the contradiction claim, which rests
       on the VALUE being there rather than on how well it was observed. */
    expect(verdict.purchaseCohortWithoutEvent).toBe(false);
  });

  it("ignores a custom conversion outside a purchase cohort", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "traffic",
      objectiveReadiness: "decision_authority",
      objectiveTier: "provider_receipt_legacy_bracketed",
      optimizationGoalReadiness: "decision_authority",
      optimizationGoalTier: "provider_receipt_legacy_bracketed",
      customEventTypeTier: "observed_absent",
      customConversionId: "23849900000000000",
      customConversionIdReadiness: "decision_authority",
    });
    expect(verdict.readiness).toBe("decision_authority");
    expect(verdict.blockingField).toBeNull();
    expect(verdict.purchaseCohortWithoutEvent).toBe(false);
  });

  it("treats an empty-string id as no id at all", () => {
    const verdict = resolveNativeAdConfigAuthority({
      ...PURCHASE_NO_STANDARD_EVENT,
      customConversionId: "   ",
      customConversionIdReadiness: "decision_authority",
    });
    expect(verdict.purchaseCohortWithoutEvent).toBe(true);
    expect(verdict.readiness).toBe("none");
  });
});

describe("the verified suffix survives an old gap and refuses a fresh one", () => {
  const day = (
    n: number,
    dayClass: MetaConfigDayAuthorityClass,
    spend = 100,
    extra: { conversions?: number; revenue?: number } = {},
  ) => ({
    date: `2026-09-${String(n).padStart(2, "0")}`,
    spend,
    conversions: extra.conversions ?? 0,
    revenue: extra.revenue ?? 0,
    dayClass,
  });

  it("is empty when nothing was ever verified", () => {
    expect(
      resolveVerifiedAuthoritySuffix([day(1, "none"), day(2, "none")]),
    ).toMatchObject({ dayCount: 0, reason: "blocked_at_trailing_edge" });
    expect(resolveVerifiedAuthoritySuffix([])).toEqual(
      EMPTY_VERIFIED_AUTHORITY_SUFFIX,
    );
  });

  /*
    THE FORWARD FAILURE. The provider-side config gap leaves August with no
    provenance. A rule that reads the whole 90-day window keeps this ad in review
    for a full quarter after the source is repaired — the gap ages out one day at
    a time while corroborated receipts arrive daily and change nothing.
  */
  it("ignores an old unprovenanced head once verified days accumulate after it", () => {
    const days = [
      ...[1, 2, 3, 4, 5].map((n) => day(n, "none", 500)),
      ...[6, 7, 8, 9, 10].map((n) => day(n, "decision_authority", 100)),
    ];
    expect(resolveVerifiedAuthoritySuffix(days)).toMatchObject({
      startDate: "2026-09-06",
      endDate: "2026-09-10",
      dayCount: 5,
      spend: 500,
      reason: "verified",
    });
  });

  /*
    THE BACKWARD FAILURE, at its sharpest. The trailing day is uncorroborated and
    carries almost all the money. It must not be inside the verified run, or its
    spend inherits an authority nothing established.
  */
  it("steps over a pending trailing day WITHOUT counting its spend", () => {
    const days = [
      ...[1, 2, 3].map((n) => day(n, "decision_authority", 10)),
      day(4, "review_only_pending", 9000),
    ];
    const suffix = resolveVerifiedAuthoritySuffix(days);
    expect(suffix).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      dayCount: 3,
      spend: 30,
      pendingTrailingDays: 1,
      reason: "verified",
    });
    expect(suffix.spend).not.toBeGreaterThan(30);
  });

  /*
    THE ASYMMETRY THAT EARNS ITS PLACE. A pending day is stepped over because the
    horizon bounds how long it can stay pending. A settled-uncertain or
    unprovenanced trailing day has no such bound: stepping over a month of them
    would present month-old economics as current.
  */
  it("refuses to step over an unprovenanced trailing day", () => {
    const days = [
      ...[1, 2, 3].map((n) => day(n, "decision_authority")),
      day(4, "none", 5000),
    ];
    expect(resolveVerifiedAuthoritySuffix(days)).toMatchObject({
      dayCount: 0,
      reason: "blocked_at_trailing_edge",
    });
  });

  it("refuses to step over a settled-uncertain trailing day", () => {
    const days = [
      ...[1, 2, 3].map((n) => day(n, "decision_authority")),
      day(4, "review_only_settled"),
    ];
    expect(resolveVerifiedAuthoritySuffix(days)).toMatchObject({
      dayCount: 0,
      reason: "blocked_at_trailing_edge",
    });
  });

  it("stops at the most recent gap, not the oldest", () => {
    const days = [
      ...[1, 2, 3, 4, 5].map((n) => day(n, "decision_authority")),
      day(6, "none"),
      ...[7, 8].map((n) => day(n, "decision_authority")),
    ];
    expect(resolveVerifiedAuthoritySuffix(days)).toMatchObject({
      startDate: "2026-09-07",
      endDate: "2026-09-08",
      dayCount: 2,
    });
  });

  /*
    THE THREE-DAY RECEIPT SCENARIO. The source is repaired; fresh corroborated
    receipts start arriving. Day by day the verified run should GROW, and it
    should be usable from the first day it exists rather than after ninety.
  */
  it("grows a day at a time as new corroborated receipts arrive", () => {
    const history = [1, 2, 3, 4, 5].map((n) => day(n, "none", 500));
    const grown: number[] = [];
    for (const fresh of [6, 7, 8]) {
      history.push(day(fresh, "decision_authority", 100));
      grown.push(resolveVerifiedAuthoritySuffix(history).dayCount);
    }
    expect(grown).toEqual([1, 2, 3]);
    expect(resolveVerifiedAuthoritySuffix(history)).toMatchObject({
      startDate: "2026-09-06",
      endDate: "2026-09-08",
      spend: 300,
    });
  });

  it("still grows when today's receipt is not corroborated yet", () => {
    /* Yesterday settled; today is pending. The run is yesterday's, not empty. */
    const days = [
      ...[1, 2, 3].map((n) => day(n, "none", 500)),
      ...[4, 5].map((n) => day(n, "decision_authority", 100)),
      day(6, "review_only_pending", 100),
    ];
    expect(resolveVerifiedAuthoritySuffix(days)).toMatchObject({
      startDate: "2026-09-04",
      endDate: "2026-09-05",
      dayCount: 2,
      spend: 200,
      pendingTrailingDays: 1,
    });
  });

  it("does not care what order the days arrive in", () => {
    const days = [
      day(3, "decision_authority"),
      day(1, "none"),
      day(2, "decision_authority"),
    ];
    expect(resolveVerifiedAuthoritySuffix(days)).toMatchObject({
      startDate: "2026-09-02",
      endDate: "2026-09-03",
      dayCount: 2,
    });
  });

  /*
    THE EDGE CASE. `buildObservations` admits zero-spend days inside an ad's
    window, so an ad can end on a day with no activity at all. If that day also
    has no config receipt, it must not withhold authority from an ad whose every
    economically meaningful day was verified — it contributes nothing to any
    economy computed from the run.
  */
  it("is not blocked by a trailing day with no economic content", () => {
    const days = [
      ...[1, 2, 3].map((n) => day(n, "decision_authority", 100)),
      day(4, "none", 0),
    ];
    expect(resolveVerifiedAuthoritySuffix(days)).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      dayCount: 3,
      spend: 300,
      reason: "verified",
    });
  });

  it("does not let an empty day bridge two runs either", () => {
    /* Transparent means transparent: it neither breaks the chain nor joins it. */
    const days = [
      day(1, "decision_authority", 100),
      day(2, "none", 0),
      day(3, "decision_authority", 100),
    ];
    expect(resolveVerifiedAuthoritySuffix(days)).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      dayCount: 2,
      spend: 200,
    });
  });

  /*
    The other half of the rule, and the one that keeps it honest. A zero-SPEND
    day carrying a late-attributed conversion or revenue is economically real.
    Treating it as empty would launder exactly the days whose attribution is
    hardest to get right.
  */
  it("still classifies a zero-spend day that carries a late conversion", () => {
    expect(
      resolveVerifiedAuthoritySuffix([
        ...[1, 2, 3].map((n) => day(n, "decision_authority", 100)),
        day(4, "none", 0, { conversions: 1, revenue: 240 }),
      ]),
    ).toMatchObject({ dayCount: 0, reason: "blocked_at_trailing_edge" });
  });

  it("still classifies a zero-spend day that carries only revenue", () => {
    expect(
      resolveVerifiedAuthoritySuffix([
        ...[1, 2, 3].map((n) => day(n, "decision_authority", 100)),
        day(4, "none", 0, { revenue: 99.5 }),
      ]),
    ).toMatchObject({ dayCount: 0, reason: "blocked_at_trailing_edge" });
  });

  it("is empty when every day is economically empty", () => {
    expect(
      resolveVerifiedAuthoritySuffix([
        day(1, "decision_authority", 0),
        day(2, "decision_authority", 0),
      ]),
    ).toEqual(EMPTY_VERIFIED_AUTHORITY_SUFFIX);
  });
});

describe("a purchase cohort needs an event that states a purchase", () => {
  /*
    Meta's `AdPromotedObject` carries `custom_event_type` and
    `custom_conversion_id` as separate fields, and the `CustomConversion` object
    has its OWN `custom_event_type`. Nothing in that schema maps `OTHER` to
    PURCHASE — the conversion object has to be read. Live over 30 days: 21 ad
    sets on one account carry OTHER with a custom conversion, 4 more carry OTHER
    without one, and ZERO spending ad-set-days carry OTHER at all.
  */
  const AUTHORITATIVE_CONFIG = {
    cohort: "purchase" as const,
    objectiveReadiness: "decision_authority",
    objectiveTier: "provider_receipt_legacy_bracketed",
    optimizationGoalReadiness: "decision_authority",
    optimizationGoalTier: "provider_receipt_legacy_bracketed",
    customEventTypeReadiness: "decision_authority",
    customEventTypeTier: "provider_receipt_legacy_bracketed",
  };

  it("authorises a PURCHASE event whose receipt is bracketed", () => {
    expect(
      resolveNativeAdConfigAuthority({
        ...AUTHORITATIVE_CONFIG,
        customEventType: "PURCHASE",
      }),
    ).toMatchObject({ readiness: "decision_authority", blockingField: null });
  });

  it("authorises VALUE, which states a purchase just as PURCHASE does", () => {
    expect(
      resolveNativeAdConfigAuthority({
        ...AUTHORITATIVE_CONFIG,
        customEventType: "VALUE",
      }).readiness,
    ).toBe("decision_authority");
  });

  /* THE HOLE. Every other field is authoritative, so nothing else would hold it. */
  it("refuses to authorise OTHER, however well it was observed", () => {
    const verdict = resolveNativeAdConfigAuthority({
      ...AUTHORITATIVE_CONFIG,
      customEventType: "OTHER",
      customConversionId: "687098670133221",
      customConversionIdReadiness: "decision_authority",
    });
    expect(verdict.readiness).toBe("review_only");
    expect(verdict.blockingField).toBe("custom_event_type");
    /* Waiting does not resolve it; reading the conversion object does. */
    expect(verdict.pendingCorroborationOnly).toBe(false);
    /* A target IS named, so this is not the no-target contradiction. */
    expect(verdict.purchaseCohortWithoutEvent).toBe(false);
  });

  it("refuses OTHER even with no custom conversion to point at", () => {
    expect(
      resolveNativeAdConfigAuthority({
        ...AUTHORITATIVE_CONFIG,
        customEventType: "OTHER",
      }).readiness,
    ).toBe("review_only");
  });

  it("refuses a mid-funnel event standing in for a purchase", () => {
    expect(
      resolveNativeAdConfigAuthority({
        ...AUTHORITATIVE_CONFIG,
        customEventType: "ADD_TO_CART",
      }),
    ).toMatchObject({ readiness: "review_only", blockingField: "custom_event_type" });
  });

  it("leaves a NON-purchase cohort alone: OTHER gates nothing there", () => {
    expect(
      resolveNativeAdConfigAuthority({
        ...AUTHORITATIVE_CONFIG,
        cohort: "traffic",
        customEventType: "OTHER",
      }).readiness,
    ).toBe("decision_authority");
  });

  it("keeps the observed-absent contradiction distinct from the placeholder", () => {
    const absent = resolveNativeAdConfigAuthority({
      ...AUTHORITATIVE_CONFIG,
      customEventTypeReadiness: "none",
      customEventTypeTier: "observed_absent",
      customEventType: null,
    });
    expect(absent.readiness).toBe("none");
    expect(absent.purchaseCohortWithoutEvent).toBe(true);
  });

  it("classifies an OTHER day as settled, not pending", () => {
    expect(
      classifyConfigAuthorityDay({
        ...AUTHORITATIVE_CONFIG,
        customEventType: "OTHER",
        customConversionId: "687098670133221",
        customConversionIdReadiness: "decision_authority",
        date: "2026-09-22",
        asOfDate: "2026-09-22",
      }),
    ).toBe("review_only_settled");
  });
});

describe("an established value is not the same claim as a receipt tier", () => {
  /*
    TWO COUNTEREXAMPLES, both run against the pure resolver before the fix and
    both passing the action gate. They share a root cause: the gate tested the
    TIER, which says only that a receipt spoke, and neither case is about
    whether a receipt spoke.
  */
  const RECEIPT = "provider_receipt_legacy_bracketed";

  /*
    (1) WAREHOUSE / RECEIPT DISAGREEMENT. The receipt is bracketed — for a value
    this query did not choose. The SQL agreement test already withholds the
    readiness for exactly that; the tier knows nothing about it.
  */
  it("refuses a bracketed receipt that vouches for a DIFFERENT value", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "purchase",
      objectiveTier: RECEIPT,
      objectiveReadiness: "none",
      optimizationGoalTier: RECEIPT,
      optimizationGoalReadiness: "decision_authority",
      customEventTypeTier: RECEIPT,
      customEventTypeReadiness: "decision_authority",
      customEventType: "PURCHASE",
    });
    expect(verdict.readiness).toBe("none");
    expect(verdict.valueEstablished).toBe(false);
  });

  /*
    (2) UNREAD CONVERSION SEMANTICS. Every tier is a real receipt and every
    readiness is authoritative on its own terms; what the target MEANS was never
    read, because the CustomConversion object carries its own event type and
    this contract does not fetch it.
  */
  it("refuses a purchase target whose meaning was never read", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "purchase",
      objectiveTier: RECEIPT,
      objectiveReadiness: "decision_authority",
      optimizationGoalTier: RECEIPT,
      optimizationGoalReadiness: "decision_authority",
      customEventTypeTier: RECEIPT,
      customEventTypeReadiness: "decision_authority",
      customEventType: "OTHER",
      customConversionId: "123",
      customConversionIdReadiness: "decision_authority",
    });
    expect(verdict.readiness).toBe("review_only");
    expect(verdict.blockingField).toBe("custom_event_type");
    expect(verdict.valueEstablished).toBe(false);
  });

  /*
    AND THE CASES THAT MUST STILL PASS. Holding these would be the opposite
    mistake: a point-in-day receipt is a real observation of the value, and the
    freshest day of any run cannot be bracketed.
  */
  it("establishes a point-in-day receipt, which has no bracket and needs none", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "purchase",
      objectiveTier: "provider_receipt_point_in_day",
      objectiveReadiness: "review_only",
      optimizationGoalTier: "provider_receipt_point_in_day",
      optimizationGoalReadiness: "review_only",
      customEventTypeTier: "provider_receipt_point_in_day",
      customEventTypeReadiness: "review_only",
      customEventType: "PURCHASE",
    });
    expect(verdict.readiness).toBe("review_only");
    expect(verdict.valueEstablished).toBe(true);
  });

  it("establishes an uncorroborated freshest-day receipt", () => {
    expect(
      resolveNativeAdConfigAuthority({
        cohort: "purchase",
        objectiveTier: "provider_receipt_pending_corroboration",
        objectiveReadiness: "review_only",
        optimizationGoalTier: "provider_receipt_pending_corroboration",
        optimizationGoalReadiness: "review_only",
        customEventTypeTier: RECEIPT,
        customEventTypeReadiness: "decision_authority",
        customEventType: "PURCHASE",
      }).valueEstablished,
    ).toBe(true);
  });

  it("refuses the self-citing creative witness, which has no receipt", () => {
    expect(
      resolveNativeAdConfigAuthority({
        cohort: "traffic",
        objectiveTier: "typed_contemporaneous",
        objectiveReadiness: "review_only",
        optimizationGoalTier: RECEIPT,
        optimizationGoalReadiness: "decision_authority",
      }).valueEstablished,
    ).toBe(false);
  });

  it("refuses an observed absence, which is a measurement and not a value", () => {
    expect(
      resolveNativeAdConfigAuthority({
        cohort: "purchase",
        objectiveTier: RECEIPT,
        objectiveReadiness: "decision_authority",
        optimizationGoalTier: RECEIPT,
        optimizationGoalReadiness: "decision_authority",
        customEventTypeTier: "observed_absent",
        customEventTypeReadiness: "none",
      }).valueEstablished,
    ).toBe(false);
  });

  it("ignores the conversion gate entirely outside a purchase cohort", () => {
    expect(
      resolveNativeAdConfigAuthority({
        cohort: "traffic",
        objectiveTier: RECEIPT,
        objectiveReadiness: "decision_authority",
        optimizationGoalTier: RECEIPT,
        optimizationGoalReadiness: "decision_authority",
        customEventTypeTier: "unknown",
        customEventTypeReadiness: "none",
      }).valueEstablished,
    ).toBe(true);
  });

  /*
    THE MULTI-PAGE PAIR. Same receipt shape, same readiness, one difference: in
    the first the fetch might have straddled a provider-local midnight, and in
    the second that was measured and did not happen. The gate must separate them,
    because the first names a value without naming the day it belongs to and the
    second names both.
  */
  it("refuses a multi-page receipt whose interval is UNKNOWN", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "purchase",
      objectiveTier: "provider_receipt_legacy_interval_uncertain",
      objectiveReadiness: "review_only",
      optimizationGoalTier: "provider_receipt_legacy_interval_uncertain",
      optimizationGoalReadiness: "review_only",
      customEventTypeTier: "provider_receipt_legacy_interval_uncertain",
      customEventTypeReadiness: "review_only",
      customEventType: "PURCHASE",
    });
    expect(verdict.valueEstablished).toBe(false);
    /*
      Refused for the INTERVAL and for nothing else: every readiness is a genuine
      review_only and the event states a purchase, so no semantic cap fires. The
      positive case below is this same input with one word changed, which is what
      makes the tier the only variable.
    */
    expect(verdict.readiness).toBe("review_only");
  });

  it("establishes a multi-page receipt PROVEN to fit inside one local day", () => {
    const verdict = resolveNativeAdConfigAuthority({
      cohort: "purchase",
      objectiveTier: "provider_receipt_legacy_paged_within_day",
      objectiveReadiness: "review_only",
      optimizationGoalTier: "provider_receipt_legacy_paged_within_day",
      optimizationGoalReadiness: "review_only",
      customEventTypeTier: "provider_receipt_legacy_paged_within_day",
      customEventTypeReadiness: "review_only",
      customEventType: "PURCHASE",
    });
    expect(verdict.valueEstablished).toBe(true);
    /*
      Established is not authorised. The day is proven; the instant inside it is
      not, so this stays review_only exactly like the single-page receipt. The
      pair of assertions is the point: without the first, a permanently paged
      account is held forever; without the second, page timing it never had
      would have been invented for it.
    */
    expect(verdict.readiness).toBe("review_only");
  });

  it("still refuses the proven-day receipt when its readiness is none", () => {
    /*
      The tier is necessary and not sufficient — the same separation the
      bracketed-receipt-for-a-different-value case makes. A receipt whose value
      the warehouse disagrees with carries readiness none, and naming the day it
      belongs to does not rescue it.
    */
    expect(
      resolveNativeAdConfigAuthority({
        cohort: "purchase",
        objectiveTier: "provider_receipt_legacy_paged_within_day",
        objectiveReadiness: "none",
        optimizationGoalTier: RECEIPT,
        optimizationGoalReadiness: "decision_authority",
        customEventTypeTier: RECEIPT,
        customEventTypeReadiness: "decision_authority",
        customEventType: "PURCHASE",
      }).valueEstablished,
    ).toBe(false);
  });
});
