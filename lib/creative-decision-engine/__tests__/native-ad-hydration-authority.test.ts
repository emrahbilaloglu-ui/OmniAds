/**
 * What the decision loader's hydrated config is allowed to authorise.
 *
 * The cases here are the ones that decide whether this is useful or merely
 * safe. Two in particular:
 *
 *   - A NATURAL RUN'S FRESHEST DAY cannot be bracketed, because a bracket needs
 *     an observation after the day ends. If "the value was observed" and "the
 *     day was proven" were one test, every hard output would be review-only on
 *     every run forever.
 *   - THE EVALUATION DAY IS PROVIDER-LOCAL. The scheduler takes `asOf` from
 *     `now().toISOString().slice(0,10)` at 03 and 15 UTC, so for an account west
 *     of UTC the UTC date and the account's own date are different days at 03
 *     UTC even when nothing is stale.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_HYDRATED_CONFIG_AUTHORITY,
  resolveHydratedConfigAuthority,
  type HydratedConfigAuthorityRow,
} from "@/lib/creative-decision-engine/native-ad-hydration-authority";

const BRACKETED = "provider_receipt_legacy_bracketed";
const PENDING = "provider_receipt_pending_corroboration";

function row(
  over: Partial<HydratedConfigAuthorityRow> = {},
): HydratedConfigAuthorityRow {
  const dates = over.authorityDates ?? ["2026-09-20", "2026-09-21"];
  const n = dates.length;
  const fill = <T>(value: T): T[] => Array.from({ length: n }, () => value);
  return {
    latestContextDate: dates[n - 1] ?? null,
    providerLocalAsOfDate: "2026-09-21",
    objectiveTier: BRACKETED,
    objectiveReadiness: "decision_authority",
    optimizationGoalTier: BRACKETED,
    optimizationGoalReadiness: "decision_authority",
    customEventTypeTier: BRACKETED,
    customEventTypeReadiness: "decision_authority",
    customEventType: "PURCHASE",
    customConversionId: null,
    customConversionIdReadiness: null,
    authorityDates: dates,
    authoritySpend: fill(100),
    authorityConversions: fill(2),
    authorityRevenue: fill(240),
    authorityObjectiveTier: fill(BRACKETED),
    authorityObjectiveReadiness: fill("decision_authority"),
    authorityGoalTier: fill(BRACKETED),
    authorityGoalReadiness: fill("decision_authority"),
    authorityEventTier: fill(BRACKETED),
    authorityEventReadiness: fill("decision_authority"),
    authorityEventValue: fill("PURCHASE"),
    authorityCustomConversionId: fill(null),
    authorityCustomConversionReadiness: fill(null),
    /*
      The evaluation day's own receipt. Defaulted to the SAME shape as the
      context day's, so a case that overrides only the context day is still
      testing the thing it means to. The current-day fields are what the ACTION
      gate reads; the context-day fields are what the window verdict reads.
    */
    currentConfigDay: dates[n - 1] ?? null,
    currentObjectiveTier: BRACKETED,
    currentObjectiveReadiness: "decision_authority",
    currentOptimizationGoalTier: BRACKETED,
    currentOptimizationGoalReadiness: "decision_authority",
    currentCustomEventTypeTier: BRACKETED,
    currentCustomEventTypeReadiness: "decision_authority",
    currentCustomEventType: "PURCHASE",
    currentCustomConversionId: null,
    currentCustomConversionIdReadiness: "none",
    objectiveReceiptDisagreements: 0,
    optimizationGoalReceiptDisagreements: 0,
    ...over,
  };
}

const resolve = (over: Partial<HydratedConfigAuthorityRow> = {}) =>
  resolveHydratedConfigAuthority({
    cohort: "purchase",
    asOfDate: "2026-09-21",
    row: row(over),
  });

describe("the action gate reads the EVALUATION DAY, not the last metric day", () => {
  /*
    The gate used to read the provenance of `latest_context` — the most recent
    day the loader has CONTEXT for, which is metric-driven. During an ingest
    outage that day goes stale while the ad keeps delivering, so a receipt from
    a week ago would have authorised an action taken today. The fix is not an
    age bound, which would be an invented number: it is to ask about the day the
    action lands on.
  */
  it("blocks when there is no receipt for the evaluation day, however good the metric day's is", () => {
    const authority = resolve({
      /* The last metric day is perfectly observed... */
      objectiveTier: BRACKETED,
      objectiveReadiness: "decision_authority",
      /* ...and today has no receipt at all. */
      currentObjectiveTier: "unknown",
      currentObjectiveReadiness: "none",
    });
    expect(authority.latestDay.readiness).toBe("decision_authority");
    expect(authority.currentValueEvidence.observed).toBe(false);
    expect(authority.currentValueEvidence.weakestTier).toBe("unknown");
  });

  it("allows when today's receipt is present, even if it is only uncorroborated", () => {
    const authority = resolve({
      currentObjectiveTier: PENDING,
      currentObjectiveReadiness: "review_only",
      currentOptimizationGoalTier: PENDING,
      currentOptimizationGoalReadiness: "review_only",
    });
    expect(authority.currentValueEvidence.observed).toBe(true);
    expect(authority.currentValueEvidence.bracketed).toBe(false);
  });

  it("allows a point-in-day receipt, which has no bracket and needs none", () => {
    expect(
      resolve({
        currentObjectiveTier: "provider_receipt_point_in_day",
        currentObjectiveReadiness: "review_only",
      }).currentValueEvidence.observed,
    ).toBe(true);
  });

  /*
    THE DISAGREEMENT CASE. The SQL withholds the current readiness when today's
    receipt names a different configuration than the one in play, because that
    means the configuration CHANGED — which is decision-relevant, not reassuring.
  */
  it("blocks when today's receipt vouches for a different configuration", () => {
    expect(
      resolve({
        currentObjectiveTier: BRACKETED,
        currentObjectiveReadiness: "none",
      }).currentValueEvidence.observed,
    ).toBe(false);
  });

  it("blocks on an observed ABSENCE today, which is a measurement not a value", () => {
    expect(
      resolve({
        currentOptimizationGoalTier: "observed_absent",
        currentOptimizationGoalReadiness: "none",
      }).currentValueEvidence.observed,
    ).toBe(false);
  });

  it("blocks on the self-citing creative witness", () => {
    expect(
      resolve({
        currentObjectiveTier: "typed_contemporaneous",
        currentObjectiveReadiness: "review_only",
      }).currentValueEvidence.observed,
    ).toBe(false);
  });

  /* THE UNREAD PURCHASE TARGET, at the day the action lands on. */
  it("blocks a purchase target whose meaning was never read", () => {
    const authority = resolve({
      currentCustomEventType: "OTHER",
      currentCustomConversionId: "123",
      currentCustomConversionIdReadiness: "decision_authority",
    });
    expect(authority.currentValueEvidence.observed).toBe(false);
    expect(authority.currentValueEvidence.weakestTier).toBe(BRACKETED);
  });

  it("ignores the conversion event outside a purchase cohort", () => {
    const traffic = resolveHydratedConfigAuthority({
      cohort: "traffic",
      asOfDate: "2026-09-21",
      row: row({
        currentCustomEventTypeTier: "unknown",
        currentCustomEventTypeReadiness: "none",
        currentCustomEventType: null,
      }),
    });
    expect(traffic.currentValueEvidence.observed).toBe(true);
    expect(
      resolve({
        currentCustomEventTypeTier: "unknown",
        currentCustomEventTypeReadiness: "none",
      }).currentValueEvidence.observed,
    ).toBe(false);
  });

  it("carries the day the current receipt describes", () => {
    expect(resolve({ currentConfigDay: "2026-09-21" }).currentConfigDay).toBe(
      "2026-09-21",
    );
  });
});

describe("the evaluation day is the account's, not the scheduler's", () => {
  /*
    `native-ad-scheduled.ts` sets asOf from the UTC instant and runs at 03 UTC.
    A Los Angeles account is then still on the PREVIOUS provider-local day, so
    comparing its context day to the UTC asOf would call a perfectly current
    observation a day stale.
  */
  it("calls a west-of-UTC account current when its OWN day matches", () => {
    const authority = resolveHydratedConfigAuthority({
      cohort: "purchase",
      asOfDate: "2026-09-21",
      row: row({
        authorityDates: ["2026-09-19", "2026-09-20"],
        providerLocalAsOfDate: "2026-09-20",
      }),
    });
    expect(authority.observedDate).toBe("2026-09-20");
    expect(authority.evaluationDay).toBe("2026-09-20");
    expect(authority.describesAsOfDay).toBe(true);
    expect(authority.observedAgeDays).toBe(0);
  });

  it("still reports a genuinely stale day as stale", () => {
    const authority = resolveHydratedConfigAuthority({
      cohort: "purchase",
      asOfDate: "2026-09-21",
      row: row({
        authorityDates: ["2026-09-14", "2026-09-15"],
        providerLocalAsOfDate: "2026-09-21",
      }),
    });
    expect(authority.describesAsOfDay).toBe(false);
    expect(authority.observedAgeDays).toBe(6);
  });

  it("falls back to the UTC day only when the account's is unreadable", () => {
    const authority = resolveHydratedConfigAuthority({
      cohort: "purchase",
      asOfDate: "2026-09-21",
      row: row({ providerLocalAsOfDate: null }),
    });
    expect(authority.evaluationDay).toBe("2026-09-21");
  });

  it("classifies pending corroboration in the provider-local calendar", () => {
    const authority = resolveHydratedConfigAuthority({
      cohort: "purchase",
      asOfDate: "2026-09-21", // 03 UTC, still September 20 in Los Angeles
      row: row({
        providerLocalAsOfDate: "2026-09-20",
        authorityDates: ["2026-09-17"],
        authorityObjectiveTier: [PENDING],
        authorityObjectiveReadiness: ["review_only"],
        authorityGoalTier: [PENDING],
        authorityGoalReadiness: ["review_only"],
      }),
    });
    // Three local days, although the UTC calendar says four. This is a
    // pending receipt, not a settled evidence gap.
    expect(authority.counts.reviewOnlyPendingDays).toBe(1);
    expect(authority.counts.reviewOnlySettledDays).toBe(0);
  });
});

describe("the window travels as arrays and is classified by the shared rule", () => {
  it("counts the days and finds the verified run", () => {
    const authority = resolve({
      authorityDates: ["2026-09-19", "2026-09-20", "2026-09-21"],
    });
    expect(authority.counts).toMatchObject({
      decisionAuthorityDays: 3,
      noneDays: 0,
    });
    expect(authority.suffix).toMatchObject({ dayCount: 3, reason: "verified" });
    expect(authority.window.readiness).toBe("decision_authority");
  });

  it("keeps an unprovenanced head out of the verified run", () => {
    const authority = resolve({
      authorityDates: ["2026-09-19", "2026-09-20", "2026-09-21"],
      authorityObjectiveTier: ["unknown", BRACKETED, BRACKETED],
      authorityObjectiveReadiness: ["none", "decision_authority", "decision_authority"],
    });
    expect(authority.counts).toMatchObject({
      decisionAuthorityDays: 2,
      noneDays: 1,
    });
    expect(authority.suffix).toMatchObject({
      startDate: "2026-09-20",
      dayCount: 2,
    });
    /* One unprovenanced day withholds the WINDOW verdict without erasing the run. */
    expect(authority.window).toMatchObject({
      readiness: "review_only",
      reason: "unprovenanced_days",
    });
    expect(authority.decisionEconomics).toEqual({
      fullyVerified: false,
      economicDayCount: 3,
      unverifiedEconomicDayCount: 1,
      receiptManifest: null,
    });
  });

  it("does not treat a zero-economy day with missing config as contaminated spend", () => {
    const authority = resolve({
      authorityDates: ["2026-09-19", "2026-09-20", "2026-09-21"],
      authoritySpend: [0, 100, 100],
      authorityConversions: [0, 2, 2],
      authorityRevenue: [0, 240, 240],
      authorityObjectiveTier: ["unknown", BRACKETED, BRACKETED],
      authorityObjectiveReadiness: ["none", "decision_authority", "decision_authority"],
    });
    expect(authority.window.readiness).toBe("review_only");
    expect(authority.decisionEconomics).toEqual({
      fullyVerified: true,
      economicDayCount: 2,
      unverifiedEconomicDayCount: 0,
      receiptManifest: null,
    });
  });

  /*
    FAIL CLOSED ON A LENGTH MISMATCH. Zipping to the shortest array would drop
    days from one end, and it is the RECENT end that decides a verified run — so
    the failure would look like an ad that merely lacks recent evidence.
  */
  it("refuses to zip arrays that disagree about how many days there were", () => {
    const authority = resolve({
      authorityDates: ["2026-09-19", "2026-09-20", "2026-09-21"],
      authorityGoalReadiness: ["decision_authority"],
    });
    expect(authority.counts).toEqual(EMPTY_HYDRATED_CONFIG_AUTHORITY.counts);
    expect(authority.suffix.dayCount).toBe(0);
    /* The scalar verdict for the deciding day survives; only the window is lost. */
    expect(authority.latestDay.readiness).toBe("decision_authority");
  });

  it("refuses an invalid number instead of counting it as measured zero", () => {
    const authority = resolve({ authoritySpend: [100, Number.NaN] });
    expect(authority.decisionEconomics.fullyVerified).toBe(false);
    expect(authority.window.reason).toBe("no_sample");
  });

  it("returns the empty window when there are no days at all", () => {
    const authority = resolve({ authorityDates: [] });
    expect(authority.window.reason).toBe("no_sample");
    expect(authority.observedDate).toBeNull();
  });

  it("carries receipt disagreements rather than hiding them", () => {
    const authority = resolve({
      objectiveReceiptDisagreements: 3,
      optimizationGoalReceiptDisagreements: 1,
    });
    expect(authority.receiptDisagreements).toEqual({
      objective: 3,
      optimizationGoal: 1,
    });
  });
});

/*
  RECEIPT LINEAGE (2026-09-22): once the loader supplies references, a field
  whose reference is absent, malformed, incoherent or names another tier grants
  nothing, and a window manifest that does not describe the judged days cannot
  fully verify the economics. A hand-built row without lineage keeps its old
  behaviour and reports explicit nulls.
*/
describe("the evaluation day's receipt references gate its readiness, fail closed", () => {
  const OBS = "33333333-3333-4333-8333-333333333333";
  const SNAP = "11111111-1111-4111-8111-111111111111";
  const CORROB = "55555555-5555-4555-8555-555555555555";
  const refFor = (field: string, tier = BRACKETED) => ({
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: 1,
    tier,
    readiness: tier === BRACKETED ? "decision_authority" : "review_only",
    sourceClass: "legacy_observed",
    pitClass: "as_of_known",
    sourceSnapshotId: SNAP,
    observationId: OBS,
    observedAt: "2026-09-21T09:00:00.000Z",
    fieldScopeHash: "b".repeat(64),
    corroboratingSnapshotId: tier === BRACKETED ? SNAP : null,
    corroboratingObservationId: tier === BRACKETED ? CORROB : null,
    corroboratingObservedAt: tier === BRACKETED ? "2026-09-22T01:00:00.000Z" : null,
  });
  const unknownRef = (field: string) => ({
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: null,
    tier: "unknown",
    readiness: "none",
    sourceClass: "none",
    pitClass: null,
    sourceSnapshotId: null,
    observationId: null,
    observedAt: null,
    fieldScopeHash: null,
    corroboratingSnapshotId: null,
    corroboratingObservationId: null,
    corroboratingObservedAt: null,
  });
  const refs = (over: Record<string, unknown> = {}) => ({
    objective: refFor("objective"),
    optimization_goal: refFor("optimization_goal"),
    custom_event_type: refFor("custom_event_type"),
    custom_conversion_id: unknownRef("custom_conversion_id"),
    ...over,
  });
  const manifest = (over: Record<string, unknown> = {}) => ({
    hash: "c".repeat(64),
    economicDayCount: 2,
    nullObservationIdCount: 0,
    incoherentDayCount: 0,
    ...over,
  });

  it("POSITIVE: coherent references keep the verdict and are carried whole", () => {
    const authority = resolve({
      currentEvidenceRefs: refs() as never,
      authorityReceiptManifest: manifest(),
    });
    expect(authority.currentValueEvidence.observed).toBe(true);
    expect(authority.currentValueEvidence.lineageSupplied).toBe(true);
    expect(authority.currentValueEvidence.refs.objective?.observationId).toBe(OBS);
    expect(authority.currentValueEvidence.refRefusals).toEqual({});
    expect(authority.decisionEconomics.fullyVerified).toBe(true);
    expect(authority.decisionEconomics.receiptManifest?.hash).toBe("c".repeat(64));
  });

  it("NEGATIVE: an absent reference for a gating field is not evidence", () => {
    const authority = resolve({
      currentEvidenceRefs: refs({ objective: null }) as never,
      authorityReceiptManifest: manifest(),
    });
    expect(authority.currentValueEvidence.observed).toBe(false);
    expect(authority.currentValueEvidence.refRefusals.objective).toBe("absent");
  });

  it("NEGATIVE: a malformed reference fails closed", () => {
    const authority = resolve({
      currentEvidenceRefs: refs({
        optimization_goal: { ...refFor("optimization_goal"), observationId: "not-a-uuid" },
      }) as never,
      authorityReceiptManifest: manifest(),
    });
    expect(authority.currentValueEvidence.observed).toBe(false);
    expect(authority.currentValueEvidence.refRefusals.optimization_goal).toBe(
      "identity_malformed",
    );
  });

  it("NEGATIVE: a modern/observed receipt without an observation id is incoherent", () => {
    const authority = resolve({
      currentEvidenceRefs: refs({
        objective: { ...refFor("objective"), observationId: null },
      }) as never,
    });
    expect(authority.currentValueEvidence.observed).toBe(false);
    expect(authority.currentValueEvidence.refRefusals.objective).toBe(
      "identity_incoherent",
    );
  });

  it("POSITIVE: a legacy snapshot-only receipt carries an explicit null observation id", () => {
    const authority = resolve({
      currentEvidenceRefs: refs({
        objective: {
          ...refFor("objective"),
          sourceClass: "legacy_snapshot_only",
          observationId: null,
        },
      }) as never,
    });
    expect(authority.currentValueEvidence.observed).toBe(true);
    expect(authority.currentValueEvidence.refs.objective?.observationId).toBeNull();
  });

  it("NEGATIVE: a reference naming a different tier than the row is refused", () => {
    const authority = resolve({
      currentEvidenceRefs: refs({
        objective: {
          ...refFor("objective", "provider_receipt_point_in_day"),
          // point_in_day is reachable only through a modern receipt.
          sourceClass: "modern",
        },
      }) as never,
    });
    expect(authority.currentValueEvidence.observed).toBe(false);
    expect(authority.currentValueEvidence.refRefusals.objective).toBe("row_tier_mismatch");
  });

  it("NEGATIVE: a reference cannot restore readiness withheld by the hydrated row", () => {
    const authority = resolve({
      currentObjectiveReadiness: "review_only",
      currentEvidenceRefs: refs() as never,
      authorityReceiptManifest: manifest(),
    });
    expect(authority.currentValueEvidence.observed).toBe(false);
    expect(authority.currentValueEvidence.refs.objective).toBeNull();
    expect(authority.currentValueEvidence.refRefusals.objective).toBe(
      "row_readiness_mismatch",
    );
  });

  it("NEGATIVE: a current fallback can never stand in for a receipt", () => {
    const authority = resolve({
      currentEvidenceRefs: refs({
        objective: { ...unknownRef("objective"), sourceClass: "current_fallback" },
      }) as never,
    });
    // The unknown/current_fallback reference is coherent, but it names a
    // different tier than the row's bracketed claim, so the claim is refused.
    expect(authority.currentValueEvidence.observed).toBe(false);
  });

  it("NEGATIVE: a manifest that does not describe the judged days cannot verify the window", () => {
    for (const bad of [
      manifest({ economicDayCount: 1 }),
      manifest({ incoherentDayCount: 1 }),
      manifest({ hash: "not-a-hash" }),
    ]) {
      const authority = resolve({
        currentEvidenceRefs: refs() as never,
        authorityReceiptManifest: bad,
      });
      expect(authority.decisionEconomics.fullyVerified).toBe(false);
    }
  });

  it("a hand-built row without lineage keeps explicit nulls and is not gated", () => {
    const authority = resolve();
    expect(authority.currentValueEvidence.lineageSupplied).toBe(false);
    expect(authority.currentValueEvidence.refs).toEqual({
      objective: null,
      optimization_goal: null,
      custom_event_type: null,
      custom_conversion_id: null,
    });
    expect(authority.decisionEconomics.receiptManifest).toBeNull();
    expect(authority.currentValueEvidence.observed).toBe(true);
  });
});
