import { describe, expect, it } from "vitest";

import { classifyPurchaseIntentDay } from "@/lib/meta/config-field-readiness";
import {
  buildManualCutStressedAdInput,
  META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT,
  parseNativeManualCutAdvisoryProof,
  peerFreeCutProfile,
  resolveNativeManualCutAdvisory,
  type ManualCutCoreVerdict,
  type ManualCutSensitivity,
  type NativeManualCutAdvisoryFacts,
} from "../native-manual-cut-advisory";
import { EMPTY_HYDRATED_CONFIG_AUTHORITY } from "../native-ad-hydration-authority";
import type { AdDecisionInput } from "../types";
import {
  observedConfigAuthority,
  purchaseIntentConfigAuthority,
  purchaseIntentDays,
  type PurchaseIntentFixtureDay,
} from "./config-authority-fixture";
import { makeAccountDecisionProfile } from "./helpers";

/*
  meta-native-manual-cut-advisory.v1 — pure golden cases. The real decision
  core runs in jobs/ad-decisions-job.test.ts ("through the real decision core").
*/

const BRACKETED = "provider_receipt_legacy_bracketed";
const SINGLE_PAGE = "provider_receipt_legacy_single_page";

describe("PI — how one economic day's purchase intent was observed", () => {
  const intentDay = (over: Partial<Parameters<typeof classifyPurchaseIntentDay>[0]> = {}) =>
    classifyPurchaseIntentDay({
      optimizationGoal: "OFFSITE_CONVERSIONS",
      optimizationGoalReadiness: "review_only",
      optimizationGoalTier: SINGLE_PAGE,
      customEventType: "PURCHASE",
      customEventTypeReadiness: "review_only",
      customEventTypeTier: SINGLE_PAGE,
      customConversionId: null,
      ...over,
    });

  it("PI-01: both receipts carrying authority is bracketed; the objective is not an input", () => {
    expect(intentDay({
      optimizationGoalReadiness: "decision_authority",
      optimizationGoalTier: BRACKETED,
      customEventTypeReadiness: "decision_authority",
      customEventTypeTier: BRACKETED,
    })).toBe("bracketed");
  });

  it.each([
    ["a single-page same-day receipt", SINGLE_PAGE],
    ["a point-in-day receipt", "provider_receipt_point_in_day"],
    ["a paged within-day receipt", "provider_receipt_legacy_paged_within_day"],
    ["a pending corroboration", "provider_receipt_pending_corroboration"],
  ])("PI-02: %s is point-observed", (_label, tier) => {
    expect(intentDay({ optimizationGoalTier: tier, customEventTypeTier: tier })).toBe("point_observed");
  });

  it.each([
    ["an interval-uncertain legacy receipt", "provider_receipt_legacy_interval_uncertain"],
    ["a typed witness", "typed_contemporaneous"],
    ["an observed absence", "observed_absent"],
    ["no tier", null],
  ])("PI-03: %s names nothing", (_label, tier) => {
    expect(intentDay({ customEventTypeTier: tier })).toBe("none");
  });

  it.each([
    ["a non-purchase event", { customEventType: "ADD_TO_CART" }],
    ["the OTHER placeholder", { customEventType: "OTHER" }],
    ["a goal with no event", { customEventType: null }],
    ["a traffic goal", { optimizationGoal: "LINK_CLICKS" }],
    ["no goal", { optimizationGoal: null }],
    ["a named custom conversion", { customConversionId: "555" }],
    ["a bridged day", { optimizationGoalReadiness: "none" }],
  ])("PI-04: %s is never purchase intent", (_label, over) => {
    expect(intentDay(over as never)).toBe("none");
  });
});

describe("PW — the hydrated purchase-intent window", () => {
  it("PW-01: counts per economic day and keeps each point day's own economics", () => {
    const authority = purchaseIntentConfigAuthority("2026-07-12", {
      days: [
        ...purchaseIntentDays([1, 3]),
        // Not economic: no spend, conversions or revenue.
        { date: "2026-07-12", spend: 0, revenue: 0, conversions: 0, observation: "typed" },
      ],
    });
    expect(authority.decisionEconomics).toMatchObject({ fullyVerified: false, economicDayCount: 5 });
    expect(authority.purchaseIntentWindow).toEqual({
      contractVersion: "meta-purchase-intent-window.v1",
      economicDayCount: 5,
      bracketedDays: 3,
      pointObservedDays: 2,
      unnamedDays: 0,
      historicalObjectiveVerifiedDays: 0,
      historicalObjectiveUnverifiedDays: 5,
      pointObserved: [
        { date: "2026-07-08", spend: 100, revenue: 100 },
        { date: "2026-07-10", spend: 100, revenue: 100 },
      ],
    });
  });

  it("PW-02: a verified objective day is counted, never inferred", () => {
    expect(observedConfigAuthority().purchaseIntentWindow).toMatchObject({
      economicDayCount: 1,
      historicalObjectiveVerifiedDays: 1,
      historicalObjectiveUnverifiedDays: 0,
    });
  });

  it("PW-03: no window on the empty authority", () => {
    expect(EMPTY_HYDRATED_CONFIG_AUTHORITY.purchaseIntentWindow).toBeUndefined();
  });
});

/* ── the sensitivity input ── */

const stressDays: PurchaseIntentFixtureDay[] = [
  { date: "2026-06-20", spend: 300, revenue: 150, observation: "point" },
  { date: "2026-06-27", spend: 300, revenue: 150 },
  { date: "2026-07-04", spend: 280, revenue: 150 },
  { date: "2026-07-08", spend: 100, revenue: 0 },
  { date: "2026-07-10", spend: 20, revenue: 50 },
];

function stressAd(
  over: Partial<AdDecisionInput> = {},
  days: PurchaseIntentFixtureDay[] = stressDays,
): AdDecisionInput {
  return {
    configAuthority: purchaseIntentConfigAuthority("2026-07-12", { days }),
    spend: 1000,
    purchases: 4,
    purchaseValue: 500,
    roas: 0.5,
    recent7dSpend: 120,
    recent7dPurchases: 1,
    recent7dRoas: 50 / 120,
    decisionWindow: {
      startDate: "2026-06-15",
      endDate: "2026-07-11",
      calendarDaySpan: 27,
      observedDayCount: 27,
      economicDayCount: 5,
      bridgedUnresolvedDayCount: 0,
      lookbackStartDate: "2026-06-15",
      lookbackEndDate: "2026-07-12",
      recentStartDate: "2026-07-05",
      recentEndDate: "2026-07-11",
    },
    adBandEvidence: {
      cutoffDate: "2026-07-11",
      recent14: {
        startDate: "2026-06-28", endDate: "2026-07-11",
        spend: 400, purchases: 2, revenue: 200, impressions: 1, clicks: 1, linkClicks: 1,
      },
      prior14: {
        startDate: "2026-06-14", endDate: "2026-06-27",
        spend: 600, purchases: 2, revenue: 300, impressions: 1, clicks: 1, linkClicks: 1,
      },
    },
    ...over,
  } as AdDecisionInput;
}

describe("ST — each point day is moved alone, exactly or not at all", () => {
  it("ST-01: a point day outside the recent band moves the window and its lifecycle band only", () => {
    const ad = stressAd();
    const built = buildManualCutStressedAdInput(ad, 2.2);
    if (!built.ok) throw new Error(built.refusal);
    expect(built.detail).toEqual({
      commercialTargetRoas: 2.2,
      days: [{ date: "2026-06-20", spend: 300, revenue: 150, stressedRevenue: 660 }],
      purchaseValue: { actual: 500, stressed: 1010 },
      roas: { actual: 0.5, stressed: 1.01 },
      recent7dRoas: null,
      bands: ["prior14"],
    });
    expect(built.ad.adBandEvidence?.prior14.revenue).toBe(810);
    expect(built.ad.adBandEvidence?.prior14.spend).toBe(600);
    expect(built.ad.adBandEvidence?.recent14).toEqual(ad.adBandEvidence?.recent14);
    // Spend, purchases, the window and the recent band are untouched.
    expect(built.ad.spend).toBe(1000);
    expect(built.ad.purchases).toBe(4);
    expect(built.ad.decisionWindow).toEqual(ad.decisionWindow);
    expect(built.ad.recent7dRoas).toBe(ad.recent7dRoas);
    expect(built.ad.recent7dSpend).toBe(120);
    // The input is not mutated.
    expect(ad.purchaseValue).toBe(500);
    expect(ad.adBandEvidence?.prior14.revenue).toBe(300);
  });

  it("ST-02: a point day inside the recent band moves recent ROAS on the same spend", () => {
    const days: PurchaseIntentFixtureDay[] = [
      { date: "2026-06-20", spend: 300, revenue: 150 },
      { date: "2026-06-27", spend: 300, revenue: 150 },
      { date: "2026-07-04", spend: 280, revenue: 150 },
      { date: "2026-07-08", spend: 100, revenue: 0, observation: "point" },
      { date: "2026-07-10", spend: 20, revenue: 50 },
    ];
    const built = buildManualCutStressedAdInput(stressAd({}, days), 2.2);
    if (!built.ok) throw new Error(built.refusal);
    expect(built.detail.recent7dRoas?.stressed).toBeCloseTo(270 / 120, 12);
    expect(built.detail.bands).toEqual(["recent14"]);
    expect(built.ad.recent7dSpend).toBe(120);
  });

  it("ST-03: per day, not in aggregate — a winner cannot hide a loser", () => {
    const days: PurchaseIntentFixtureDay[] = [
      { date: "2026-06-20", spend: 50, revenue: 300, observation: "point" },
      { date: "2026-06-27", spend: 180, revenue: 0, observation: "point" },
      { date: "2026-07-04", spend: 770, revenue: 200 },
    ];
    const built = buildManualCutStressedAdInput(stressAd({}, days), 2.2);
    if (!built.ok) throw new Error(built.refusal);
    const perDayDelta = built.detail.purchaseValue.stressed - built.detail.purchaseValue.actual;
    const aggregateDelta = Math.max(300, 230 * 2.2) - 300;
    expect(perDayDelta).toBeCloseTo(396, 9);
    expect(aggregateDelta).toBeCloseTo(206, 9);
  });

  it("ST-04: a point day already above target is not lowered", () => {
    const days: PurchaseIntentFixtureDay[] = [
      { date: "2026-06-20", spend: 100, revenue: 400, observation: "point" },
      { date: "2026-06-27", spend: 900, revenue: 100 },
    ];
    // No lifecycle bands here: the stored bands above would not contain this day.
    const built = buildManualCutStressedAdInput(stressAd({ adBandEvidence: null }, days), 2.2);
    if (!built.ok) throw new Error(built.refusal);
    expect(built.detail.days[0]?.stressedRevenue).toBe(400);
    expect(built.detail.purchaseValue.stressed).toBe(500);
  });

  const recentPointDays: PurchaseIntentFixtureDay[] = [
    { date: "2026-06-20", spend: 900, revenue: 450 },
    { date: "2026-07-08", spend: 100, revenue: 50, observation: "point" },
  ];

  it.each([
    ["no commercial target", {}, undefined, null, "commercial_target_invalid"],
    ["a zero target", {}, undefined, 0, "commercial_target_invalid"],
    ["a negative target", {}, undefined, -2, "commercial_target_invalid"],
    ["a non-finite target", {}, undefined, Number.NaN, "commercial_target_invalid"],
    ["no decision window", { decisionWindow: null }, undefined, 2.2, "decision_window_absent"],
    [
      "a point day outside the decision window",
      {},
      [{ date: "2026-06-01", spend: 100, revenue: 0, observation: "point" as const },
        { date: "2026-06-20", spend: 900, revenue: 500 }],
      2.2,
      "point_day_outside_decision_window",
    ],
    ["a null purchase value", { purchaseValue: null }, undefined, 2.2, "cumulative_value_unconstructible"],
    ["a null ROAS", { roas: null }, undefined, 2.2, "cumulative_value_unconstructible"],
    ["zero window spend", { spend: 0 }, undefined, 2.2, "cumulative_value_unconstructible"],
    ["a purchase value below the point day's own revenue", { purchaseValue: 100 }, undefined, 2.2, "cumulative_value_unconstructible"],
    ["window spend below the point day's own spend", { spend: 200 }, undefined, 2.2, "cumulative_value_unconstructible"],
    ["a recent band without recent spend", { recent7dSpend: null }, recentPointDays, 2.2, "recent_window_unconstructible"],
    ["a recent band without recent ROAS", { recent7dRoas: null }, recentPointDays, 2.2, "recent_window_unconstructible"],
    ["recent spend below the point day's own", { recent7dSpend: 50 }, recentPointDays, 2.2, "recent_window_unconstructible"],
  ] as const)("ST-05: %s refuses", (_label, over, days, target, refusal) => {
    const ad = stressAd(over as Partial<AdDecisionInput>, days as PurchaseIntentFixtureDay[] | undefined);
    expect(buildManualCutStressedAdInput(ad, target)).toEqual({ ok: false, refusal });
  });

  it("ST-06: a half-open recent band refuses", () => {
    const ad = stressAd();
    expect(buildManualCutStressedAdInput(
      { ...ad, decisionWindow: { ...ad.decisionWindow!, recentEndDate: null } },
      2.2,
    )).toEqual({ ok: false, refusal: "recent_window_unconstructible" });
  });

  it("ST-07: a lifecycle band without revenue refuses; a band the day is not in is left alone", () => {
    const ad = stressAd();
    expect(buildManualCutStressedAdInput(
      { ...ad, adBandEvidence: { ...ad.adBandEvidence!, prior14: { ...ad.adBandEvidence!.prior14, revenue: null } } },
      2.2,
    )).toEqual({ ok: false, refusal: "band_unconstructible" });
    expect(buildManualCutStressedAdInput(
      { ...ad, adBandEvidence: { ...ad.adBandEvidence!, recent14: { ...ad.adBandEvidence!.recent14, revenue: null } } },
      2.2,
    ).ok).toBe(true);
  });

  it.each([
    ["a non-finite spend", { spend: Number.POSITIVE_INFINITY }],
    ["a negative revenue", { revenue: -1 }],
    ["an unreadable date", { date: "not-a-date" }],
  ])("ST-08: a hydrated point day with %s refuses", (_label, patch) => {
    const ad = stressAd();
    const window = ad.configAuthority.purchaseIntentWindow!;
    const tampered = {
      ...ad,
      configAuthority: {
        ...ad.configAuthority,
        purchaseIntentWindow: {
          ...window,
          pointObserved: [{ ...window.pointObserved[0]!, ...patch }],
        },
      },
    };
    expect(buildManualCutStressedAdInput(tampered, 2.2)).toEqual({
      ok: false,
      refusal: "point_day_invalid",
    });
  });
});

/* ── the advisory's own order ── */

const CUT: ManualCutCoreVerdict = { label: "cut", authorityBlocker: null, labelTransform: null };

function sensitivityFor(ad: AdDecisionInput): ManualCutSensitivity {
  const built = buildManualCutStressedAdInput(ad, 2.2);
  if (!built.ok) throw new Error(built.refusal);
  return {
    commercialTargetRoas: 2.2,
    peerFree: CUT,
    stress: {
      status: "evaluated",
      verdict: CUT,
      originalProfileVerdict: CUT,
      detail: built.detail,
    },
  };
}

function facts(over: Partial<NativeManualCutAdvisoryFacts> = {}): NativeManualCutAdvisoryFacts {
  const ad = stressAd();
  return {
    asOfDate: "2026-07-12",
    computedAt: "2026-07-12T03:10:00.000Z",
    engineVersion: "engine-test",
    providerAccountId: "act-1",
    adId: "ad-1",
    rawLabel: "cut",
    publishedLabel: "cut",
    hysteresisSuppressed: false,
    labelTransform: null,
    engineAuthorityBlocker: null,
    configSourceBlocked: true,
    sourceCoverageBlocked: false,
    purchaseEvidenceBlocked: false,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    configAuthority: ad.configAuthority,
    sensitivity: sensitivityFor(ad),
    ...over,
  };
}

describe("PA — the advisory, its proof and its named refusals", () => {
  it("PA-01: advised, as a compact proof that round-trips through the parser", () => {
    const result = resolveNativeManualCutAdvisory(facts());
    expect(result.status).toBe("advised");
    if (result.status !== "advised") return;
    expect(result.proof).toMatchObject({
      contractVersion: META_NATIVE_MANUAL_CUT_ADVISORY_CONTRACT,
      confidenceCap: "medium",
      authority: "none",
      heldBy: "config_source_authority",
      engineAuthorityBlocker: null,
      economicDayCount: 5,
      bracketedDays: 4,
      historicalObjectiveUnverifiedDays: 5,
    });
    expect(parseNativeManualCutAdvisoryProof(JSON.parse(JSON.stringify(result.proof)))).toEqual(
      result.proof,
    );
  });

  it("PA-02: the campaign role routes execution only and stays named in the proof", () => {
    const result = resolveNativeManualCutAdvisory(facts({ engineAuthorityBlocker: "campaign_context" }));
    expect(result.status === "advised" && result.proof.engineAuthorityBlocker).toBe("campaign_context");
  });

  const withStressVerdict = (
    verdict: Partial<ManualCutCoreVerdict>,
    profile: "verdict" | "originalProfileVerdict" = "verdict",
  ) => {
    const base = facts().sensitivity!;
    if (base.stress.status !== "evaluated") throw new Error("expected evaluated stress");
    return {
      sensitivity: { ...base, stress: { ...base.stress, [profile]: { ...CUT, ...verdict } } },
    };
  };

  it.each([
    ["a Scale", { rawLabel: "scale", publishedLabel: "scale" }, "not_a_published_cut"],
    ["a Refresh", { rawLabel: "refresh", publishedLabel: "refresh" }, "not_a_published_cut"],
    ["an insufficient-spend Test More", { rawLabel: "test_more", publishedLabel: "test_more" }, "not_a_published_cut"],
    ["a hysteresis-held Cut", { publishedLabel: "keep", hysteresisSuppressed: true }, "hysteresis_pending"],
    ["a Test-cohort Refresh turned Cut", { labelTransform: "test_cohort_refresh_to_cut" }, "refresh_transform_not_eligible"],
    ["a row D098 does not hold", { configSourceBlocked: false }, "config_not_held"],
    ["an unverifiable recent recovery", { engineAuthorityBlocker: "recent_recovery_unverifiable" }, "engine_validity_hold"],
    ["an ineligible profile", { engineAuthorityBlocker: "profile_hard_action_ineligible" }, "engine_validity_hold"],
    ["a D101 gap", { sourceCoverageBlocked: true }, "source_coverage_gap"],
    ["incomplete purchase observation", { purchaseEvidenceBlocked: true }, "purchase_observation_incomplete"],
    ["the empty authority", { configAuthority: EMPTY_HYDRATED_CONFIG_AUTHORITY }, "current_config_unobserved"],
    ["a stale commercial target", { truthSource: "commercial_truth_stale" }, "commercial_truth_absent"],
    ["an account-baseline target", { truthSource: "account_baseline" }, "commercial_truth_absent"],
    ["no target", { effectiveTargetRoas: null }, "commercial_truth_absent"],
    ["a stress built on another target", { effectiveTargetRoas: 2.5 }, "sensitivity_not_computed"],
    ["no sensitivity", { sensitivity: undefined }, "sensitivity_not_computed"],
    ["a peer-driven Cut", { sensitivity: { ...facts().sensitivity!, peerFree: { ...CUT, label: "test_more" } } }, "peer_free_cut_not_confirmed"],
    ["a peer-free Cut held by recovery", { sensitivity: { ...facts().sensitivity!, peerFree: { ...CUT, authorityBlocker: "recent_recovery_unverifiable" } } }, "peer_free_cut_not_confirmed"],
    [
      "an unconstructible sensitivity input",
      { sensitivity: { ...facts().sensitivity!, stress: { status: "unconstructible", refusal: "band_unconstructible" } } },
      "sensitivity_unconstructible",
    ],
    [
      "a point day with no stress run",
      { sensitivity: { ...facts().sensitivity!, stress: { status: "not_required" } } },
      "sensitivity_not_computed",
    ],
    ["a stressed Keep (recovery after stress)", withStressVerdict({ label: "keep" }), "stressed_cut_not_confirmed"],
    ["a stressed Cut held by a blocker", withStressVerdict({ authorityBlocker: "recent_recovery_unverifiable" }), "stressed_cut_not_confirmed"],
    ["a stressed transformed Cut", withStressVerdict({ labelTransform: "test_cohort_refresh_to_cut" }), "stressed_cut_not_confirmed"],
    [
      "a stressed Keep on the ORIGINAL profile (its own recovery hold)",
      withStressVerdict({ label: "keep" }, "originalProfileVerdict"),
      "stressed_original_cut_not_confirmed",
    ],
    [
      "a stressed original-profile Cut held by a blocker",
      withStressVerdict({ authorityBlocker: "recent_recovery_unverifiable" }, "originalProfileVerdict"),
      "stressed_original_cut_not_confirmed",
    ],
    [
      "a stressed original-profile transformed Cut",
      withStressVerdict({ labelTransform: "test_cohort_refresh_to_cut" }, "originalProfileVerdict"),
      "stressed_original_cut_not_confirmed",
    ],
    [
      "an objective receipt that named another objective",
      {
        configAuthority: purchaseIntentConfigAuthority("2026-07-12", {
          days: stressDays,
          objectiveReceiptDisagreements: 1,
        }),
      },
      "objective_receipt_conflict",
    ],
  ] as const)("PA-03: %s is refused", (_label, over, refusal) => {
    expect(resolveNativeManualCutAdvisory(facts(over as Partial<NativeManualCutAdvisoryFacts>))).toEqual({
      status: "refused",
      refusal,
    });
  });

  it("PA-04: a window whose counts disagree with the manifest's economics is refused", () => {
    const base = facts();
    const window = base.configAuthority.purchaseIntentWindow!;
    for (const tampered of [
      { ...window, economicDayCount: 4 },
      { ...window, bracketedDays: 5 },
      { ...window, pointObserved: [] },
      { ...window, contractVersion: "meta-purchase-intent-window.v0" },
    ]) {
      expect(resolveNativeManualCutAdvisory({
        ...base,
        configAuthority: { ...base.configAuthority, purchaseIntentWindow: tampered as never },
      })).toEqual({ status: "refused", refusal: "purchase_intent_window_invalid" });
    }
  });

  it("PA-05: the peer-free profile removes only the Cut-enabling peer ratios", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: "2026-07-12" });
    const peerFree = peerFreeCutProfile(profile);
    expect(peerFree.thresholds.bottomQuartileRatio).toBeNull();
    expect(peerFree.thresholds.severeLoserRatio).toBeNull();
    expect(peerFree.accountBaselines.roasRatioP25).toBeNull();
    expect(peerFree.accountBaselines.roasRatioP10).toBeNull();
    expect(peerFree.thresholds.commercialMaturitySpend).toBe(profile.thresholds.commercialMaturitySpend);
    expect(peerFree.thresholds.recentSampleMinSpend).toBe(profile.thresholds.recentSampleMinSpend);
    expect(peerFree.spendUnitEvidence).toEqual(profile.spendUnitEvidence);
    expect(peerFree.hardActionEligibility).toEqual(profile.hardActionEligibility);
    expect(profile.thresholds.bottomQuartileRatio).not.toBeNull();
  });
});

describe("PP — serving-side proof revalidation", () => {
  const proof = () => {
    const result = resolveNativeManualCutAdvisory(facts());
    if (result.status !== "advised") throw new Error("expected advice");
    return JSON.parse(JSON.stringify(result.proof)) as Record<string, unknown>;
  };
  const days = (p: Record<string, unknown>) => p.pointObservedDays as Array<Record<string, unknown>>;

  it.each([
    ["another contract", (p: Record<string, unknown>) => { p.contractVersion = "meta-native-manual-cut-advisory.v0"; }],
    ["a claimed authority", (p: Record<string, unknown>) => { p.authority = "cut"; }],
    ["a high confidence", (p: Record<string, unknown>) => { p.confidenceCap = "high"; }],
    ["a Scale", (p: Record<string, unknown>) => { p.recommendation = "scale"; }],
    ["a validity blocker", (p: Record<string, unknown>) => { p.engineAuthorityBlocker = "recent_recovery_unverifiable"; }],
    ["a forged stressed revenue", (p: Record<string, unknown>) => { days(p)[0]!.stressedRevenue = 150; }],
    ["an extra bracketed day", (p: Record<string, unknown>) => { p.bracketedDays = 5; }],
    ["a stress block with no point day", (p: Record<string, unknown>) => { p.pointObservedDays = []; p.bracketedDays = 5; }],
    ["a missing stress block", (p: Record<string, unknown>) => { p.stress = null; }],
    ["a stress total that does not add up", (p: Record<string, unknown>) => {
      (p.stress as { purchaseValue: { stressed: number } }).purchaseValue.stressed = 700;
    }],
    ["an unknown band", (p: Record<string, unknown>) => { (p.stress as { bands: string[] }).bands = ["recent28"]; }],
    ["a malformed manifest hash", (p: Record<string, unknown>) => { p.receiptManifestHash = "x"; }],
    ["an infinite target", (p: Record<string, unknown>) => { p.commercialTargetRoas = Infinity; }],
    ["a negative spend", (p: Record<string, unknown>) => { days(p)[0]!.spend = -1; }],
  ])("PP-01: %s is not a proof", (_label, tamper) => {
    const value = proof();
    tamper(value);
    expect(parseNativeManualCutAdvisoryProof(value)).toBeNull();
  });

  it("PP-02: a fully bracketed proof carries no stress block", () => {
    const base = facts();
    const authority = purchaseIntentConfigAuthority("2026-07-12", { days: purchaseIntentDays([]) });
    const result = resolveNativeManualCutAdvisory({
      ...base,
      configAuthority: authority,
      sensitivity: { commercialTargetRoas: 2.2, peerFree: CUT, stress: { status: "not_required" } },
    });
    expect(result.status).toBe("advised");
    if (result.status !== "advised") return;
    expect(result.proof).toMatchObject({ bracketedDays: 5, pointObservedDays: [], stress: null });
    expect(parseNativeManualCutAdvisoryProof(JSON.parse(JSON.stringify(result.proof)))).toEqual(
      result.proof,
    );
  });
});
