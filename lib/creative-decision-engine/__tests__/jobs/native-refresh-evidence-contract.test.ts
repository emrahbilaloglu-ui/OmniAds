import { describe, expect, it } from "vitest";

import type { CampaignContextLabelMap } from "../../campaign-context/source";
import { LIFECYCLE_HELD_REFRESH_CONFIDENCE_CAP } from "../../config-values";
import {
  NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT,
  computeNativeAdDecisions,
  computeNativeAdLifecycleEvidence,
  resolveNativeAdFrequencyPressureThreshold,
  resolveNativeAdFrequencyPressureThresholdsByAccount,
  toNativeSnapshotPayload,
} from "../../jobs/ad-decisions-job";
import type {
  AccountDecisionProfile,
  AdDecisionInput,
  AdDecisionOutput,
  AdDisjointBandEvidence,
} from "../../types";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "../helpers";

/*
  Area 5 regression: the native ad-level fatigue/lifecycle evidence contract.

  `toResolverInput` used to null `fatigueStatus` and `lifecyclePosition` for
  every native Ad, with the comment "Native ad labels cannot consume it until
  an ad-level lifecycle contract exists". `ratio-zones.shouldRefreshOnFatigue`
  requires `fatigueStatus === "fatigued"`, so Refresh was unreachable by
  construction on every native Ad — an ad whose recent period collapsed against
  its own preceding period served as an ordinary Keep with nothing held and
  nothing to see.

  The contract asserted here is `NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT`. It
  reads ONLY ad-grain, cutoff-bound evidence: this ad's own equal, disjoint,
  directly adjacent 14/14 windows, a CTR and click-to-purchase composite
  measured on them, and a frequency percentile taken across the whole provider
  account. Creative-grain lifecycle stays where it was.

  Two routes leave this module and both are asserted below. `fatigueStatus` and
  `lifecyclePosition` reach the RESOLVER. The contract version, the evidence
  hash and the missing-evidence list reach the PERSISTED DECISION as blockers,
  but only on a row that raised a Refresh the contract could not confirm. The
  decay ratios, the pressure flag and the prior-band verdict reach neither and
  are asserted here as derivation detail only.
*/

const BUSINESS_ID = "biz-refresh-evidence";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-0000000009b1";
const AS_OF = "2026-07-12";

/*
  The two admissible windows for a 2026-07-12 cutoff. Equal (14 days each,
  inclusive), disjoint, and directly adjacent: 2026-06-28 is the calendar day
  before 2026-06-29.
*/
const RECENT_14 = { startDate: "2026-06-29", endDate: "2026-07-12" };
const PRIOR_14 = { startDate: "2026-06-15", endDate: "2026-06-28" };

function campaignContext(campaignIds: string[]): CampaignContextLabelMap {
  return new Map(
    campaignIds.map((campaignId) => [
      campaignId,
      {
        kind: "main" as const,
        testDimension: null,
        contextTrust: "high" as const,
        provenance: {
          mode: "automatic" as const,
          source: "system_inferred" as const,
          campaignId,
          kind: "main" as const,
          testDimension: null,
          contextTrust: "high" as const,
          sourceRecordType: "engine_v3_campaign_context_daily" as const,
          sourceRecordId: `context-${campaignId}`,
          sourceAsOfDate: AS_OF,
          sourceUpdatedAt: `${AS_OF}T01:00:00.000Z`,
          sourceHash: "a".repeat(64),
        },
      },
    ]),
  );
}

interface BandShape {
  spend: number;
  purchases: number;
  revenue: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
}

/**
 * A confirmable composite: CTR halves (2.00% to 1.00%), click-to-purchase
 * falls by two thirds (0.0100 to 0.0033), and ROAS falls 73% (3.67 to 1.00).
 * All three clear `FATIGUE_SIGNIFICANT_DECAY_THRESHOLD` (0.18).
 */
const DECAYED_PRIOR: BandShape = {
  spend: 300,
  purchases: 20,
  revenue: 1100,
  impressions: 150_000,
  clicks: 3_000,
  linkClicks: 2_000,
};
const DECAYED_RECENT: BandShape = {
  spend: 100,
  purchases: 2,
  revenue: 100,
  impressions: 90_000,
  clicks: 900,
  linkClicks: 600,
};

function bandEvidence(
  overrides: {
    cutoffDate?: string;
    recent?: Partial<BandShape & { startDate: string; endDate: string }>;
    prior?: Partial<BandShape & { startDate: string; endDate: string }>;
  } = {},
): AdDisjointBandEvidence {
  return {
    cutoffDate: overrides.cutoffDate ?? AS_OF,
    recent14: { ...RECENT_14, ...DECAYED_RECENT, ...overrides.recent },
    prior14: { ...PRIOR_14, ...DECAYED_PRIOR, ...overrides.prior },
  };
}

interface AdShape {
  adId: string;
  spend: number;
  purchases: number;
  purchaseValue: number;
  roas: number;
  recent7dSpend: number;
  recent7dPurchases: number;
  recent7dRoas: number;
  impressions: number;
  recent7dImpressions: number;
  frequency: number;
  /** Creative-grain overlay, deliberately contradicting the ad's own bands. */
  creativeFatigue?: AdDecisionInput["fatigueStatus"];
  /** Absent by default, exactly as production hydration leaves it. */
  bands?: AdDisjointBandEvidence | null;
  creativeId?: string;
}

function adInput(shape: AdShape): AdDecisionInput {
  const creative = makeCreativeInput({
    businessId: BUSINESS_ID,
    creativeId: shape.creativeId ?? "shared-creative",
    campaignId: "campaign-main",
    objective: "OUTCOME_SALES",
    effectiveCohort: "purchase",
    contextGrain: {
      providerAccountCount: 1,
      campaignCount: 1,
      adsetCount: 1,
      optimizationContextCount: 1,
      objectiveCount: 1,
      contextIdentityUnknown: false,
    },
    spend: shape.spend,
    purchases: shape.purchases,
    purchaseValue: shape.purchaseValue,
    roas: shape.roas,
    recent7dSpend: shape.recent7dSpend,
    recent7dPurchases: shape.recent7dPurchases,
    recent7dRoas: shape.recent7dRoas,
    impressions: shape.impressions,
    recent7dImpressions: shape.recent7dImpressions,
    frequency: shape.frequency,
    targetRoas: 2,
    breakevenRoas: null,
    commercialTargetFreshness: "fresh",
    dataFreshnessHours: 4,
    fatigueStatus: shape.creativeFatigue ?? null,
  });
  return {
    ...creative,
    decisionEntityType: "ad",
    decisionEntityId: shape.adId,
    adId: shape.adId,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-grandmix",
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "TRY",
    adsetId: "adset-1",
    creativeId: shape.creativeId ?? "shared-creative",
    optimizationGoal: "PURCHASE",
    customEventType: "PURCHASE",
    adBandEvidence: shape.bands ?? null,
    metricEvidence: {
      sourceRowCount: 28,
      performanceMetricsObserved: true,
      eventMetricsObserved: true,
    },
    statusEvidence: {
      source: "entity_state_history",
      sourceRecordId: `state-${shape.adId}`,
      observedAt: `${AS_OF}T02:00:00.000Z`,
      capturedAt: `${AS_OF}T02:01:00.000Z`,
    },
    creativeEvidence: {
      sourceLifecycleRowId: `lifecycle-${shape.adId}`,
      sourceAsOfDate: AS_OF,
      sourceComputedAt: `${AS_OF}T02:30:00.000Z`,
      sourceMaxUpdatedAt: `${AS_OF}T02:00:00.000Z`,
      lifecyclePosition: "past_peak_natural",
      daysSincePeak: 21,
      peakRoas30d: 9.9,
      peakConfidence: 0.9,
      spendTrajectory30d: "falling",
      spendSlope7d: -1,
      spendSlope30d: -1,
      roasSlope7d: -1,
      roasSlope30d: -1,
      fatigueStatus: shape.creativeFatigue ?? "fatigued",
      qualityRanking: "above_average",
      engagementRateRanking: "above_average",
      conversionRateRanking: "above_average",
      creativeFormat: "carousel",
    },
  };
}

function decayedAd(overrides: Partial<AdShape> = {}): AdShape {
  // Cumulative 28d shape used by the resolver's zone math. The fatigue verdict
  // no longer comes from these numbers — it comes from `bands`.
  return {
    adId: "ad-decayed",
    spend: 400,
    purchases: 12,
    purchaseValue: 1200,
    roas: 3,
    recent7dSpend: 100,
    recent7dPurchases: 1,
    recent7dRoas: 1,
    impressions: 200000,
    recent7dImpressions: 90000,
    frequency: 4.2,
    ...overrides,
  };
}

function profile(): AccountDecisionProfile {
  return makeAccountDecisionProfile({
    asOfDate: AS_OF,
    accountBaselines: makeAccountCalibration({
      matureCreativeCount: 35,
      winnerPurchaseP50: 6,
      refreshRatioP10: 0.8,
    }),
    thresholds: {
      recentSampleMinSpend: 50,
      winnerMemoryMinSpend: 150,
      winnerMemoryMinPurchases: 5,
      scaleMinPurchases: 8,
      commercialMaturitySpend: 400,
    },
  });
}

function runNativeComputations(adInputs: AdDecisionInput[]) {
  return computeNativeAdDecisions({
    businessId: BUSINESS_ID,
    profile: profile(),
    dataHealth: makeDataHealth(),
    adInputs,
    campaignContextMode: "automatic",
    campaignContextById: campaignContext(["campaign-main"]),
    previousLabels: new Map(),
  });
}

function runNative(adInputs: AdDecisionInput[]): AdDecisionOutput[] {
  return runNativeComputations(adInputs).map(
    (computation) => computation.decision,
  );
}

/** Eight comparable ads, so the account-relative percentile exists at all. */
function siblingsWithFrequencies(frequencies: number[]): AdDecisionInput[] {
  return frequencies.map((frequency, index) =>
    adInput(
      decayedAd({
        adId: `ad-sibling-${index}`,
        purchaseValue: 760,
        roas: 1.9,
        recent7dRoas: 1.8,
        recent7dPurchases: 3,
        frequency,
        bands: bandEvidence({
          // Flat siblings: they supply the percentile, they are not the case.
          recent: { ...DECAYED_PRIOR, spend: 100, purchases: 7, revenue: 367 },
        }),
      }),
    ),
  );
}

describe("native Ad lifecycle evidence contract", () => {
  it("never binds a creative's fatigue verdict to an ad", () => {
    // The creative overlay screams "fatigued, past peak", while this ad's own
    // 14/14 windows are flat. One creative backs many ads; its verdict is not
    // this ad's.
    const steady = adInput(
      decayedAd({
        adId: "ad-steady",
        creativeFatigue: "fatigued",
        bands: bandEvidence({ recent: { ...DECAYED_PRIOR, spend: 300 } }),
      }),
    );
    const evidence = computeNativeAdLifecycleEvidence({
      ad: steady,
      profile: profile(),
      frequencyPressureThreshold: 3,
    });

    expect(evidence.fatigueStatus).toBe("none");
    expect(evidence.roasDecay).toBeCloseTo(0, 6);
    expect(evidence.ctrDecay).toBeCloseTo(0, 6);
    expect(evidence.clickToPurchaseDecay).toBeCloseTo(0, 6);
    expect(steady.creativeEvidence.fatigueStatus).toBe("fatigued");
  });

  it("splits one shared creative into two Ads that diverge", () => {
    /*
      The case the ad grain exists for. Two Ads carry the SAME `creativeId` and
      the same creative-grain overlay; only their own 14/14 windows differ. A
      creative-grain fatigue verdict would have to give both the same answer.
    */
    const worn = adInput(
      decayedAd({
        adId: "ad-shared-worn",
        creativeId: "creative-shared-by-two-ads",
        frequency: 9,
        bands: bandEvidence(),
      }),
    );
    const healthy = adInput(
      decayedAd({
        adId: "ad-shared-healthy",
        creativeId: "creative-shared-by-two-ads",
        frequency: 9,
        // Same creative, same account, same period — its own delivery held up.
        bands: bandEvidence({ recent: { ...DECAYED_PRIOR, spend: 300 } }),
      }),
    );
    expect(worn.creativeId).toBe(healthy.creativeId);
    expect(worn.creativeEvidence.fatigueStatus).toBe(
      healthy.creativeEvidence.fatigueStatus,
    );

    const wornEvidence = computeNativeAdLifecycleEvidence({
      ad: worn,
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });
    const healthyEvidence = computeNativeAdLifecycleEvidence({
      ad: healthy,
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });

    expect(wornEvidence.fatigueStatus).toBe("fatigued");
    expect(healthyEvidence.fatigueStatus).toBe("none");
    // Different evidence must never hash the same, or the provenance is a lie.
    expect(wornEvidence.evidenceHash).not.toBe(healthyEvidence.evidenceHash);
  });

  it("authorizes fatigue only on a valid CTR and click-to-purchase composite", () => {
    // The intermediate values below are derivation detail, not a contract:
    // production reads only the `fatigueStatus` they add up to, asserted last.
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd({ bands: bandEvidence() })),
      profile: profile(),
      // Account-relative: this ad's 4.2 frequency is at or above the sibling
      // P75, which is the exposure pressure INVARIANTS.md requires alongside
      // performance decay.
      frequencyPressureThreshold: 3.5,
    });

    expect(evidence.ctrDecay).toBeCloseTo(0.5, 6);
    expect(evidence.clickToPurchaseDecay).toBeCloseTo(2 / 3, 6);
    expect(evidence.roasDecay).toBeCloseTo(0.727, 3);
    expect(evidence.priorBandWasStrong).toBe(true);
    expect(evidence.frequencyPressure).toBe(true);
    expect(evidence.missingEvidence).toEqual([]);
    expect(evidence.fatigueStatus).toBe("fatigued");
  });

  it("refuses fatigue when only ROAS decayed and no funnel stage did", () => {
    /*
      DECISION_LOG.md D037: "Benchmark weakening can establish pressure but
      cannot substitute for a material CTR, click-to-purchase, or ROAS decay
      signal." ROAS alone is one signal on one denominator. Here CTR and
      click-to-purchase are unchanged and only revenue per purchase collapsed —
      an AOV or pricing question, not creative wear.

      Two rules keep this row out of `fatigued` and the assertions below pin
      both: one material signal is short of the two-signal floor, AND the
      surviving signal is not a funnel stage. Relaxing the floor to one alone
      still holds this row; relaxing it AND dropping the funnel-stage
      requirement labels it fatigued.
    */
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          bands: bandEvidence({
            recent: {
              spend: 100,
              impressions: 50_000,
              clicks: 1_000,
              linkClicks: 666,
              purchases: 6.66,
              revenue: 100,
            },
          }),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });

    expect(evidence.roasDecay).toBeGreaterThan(0.18);
    expect(evidence.ctrDecay).toBeCloseTo(0, 3);
    expect(evidence.clickToPurchaseDecay).toBeCloseTo(0, 3);
    expect(evidence.fatigueStatus).not.toBe("fatigued");
  });

  it("never labels an improving recent14 as fatigued", () => {
    /*
      INVARIANTS.md: "A recent floor-clearing period that is non-declining
      versus its older comparison period must not be labeled `fatigued`." Every
      composite stage improved here, and the exposure pressure is at its
      maximum, so pressure alone must not carry the verdict.
    */
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          frequency: 12,
          bands: bandEvidence({
            recent: {
              spend: 300,
              impressions: 150_000,
              clicks: 6_000, // CTR 4.00% versus the prior 2.00%
              linkClicks: 2_000,
              purchases: 40, // click-to-purchase 0.0200 versus 0.0100
              revenue: 2_200, // ROAS 7.33 versus 3.67
            },
          }),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });

    expect(evidence.frequencyPressure).toBe(true);
    expect(evidence.ctrDecay).toBeLessThan(0);
    expect(evidence.clickToPurchaseDecay).toBeLessThan(0);
    expect(evidence.roasDecay).toBeLessThan(0);
    expect(evidence.fatigueStatus).toBe("none");
  });

  it("ignores evidence dated after the decision cutoff", () => {
    /*
      PIT safety. A window whose last day is 2026-07-13 carries a fact the
      2026-07-12 decision is not allowed to have seen. It is discarded, not
      trimmed — a partially-in-window band has denominators the contract cannot
      reconstruct.
    */
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          bands: bandEvidence({
            recent: { startDate: "2026-06-30", endDate: "2026-07-13" },
          }),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });

    expect(evidence.missingEvidence).toContain(
      "ad_recent14_window_after_cutoff",
    );
    expect(evidence.fatigueStatus).toBe("unknown");
    expect(evidence.roasDecay).toBeNull();
  });

  it("rejects unequal or non-adjacent comparison periods", () => {
    // 7/21 was the previous shape. It is now inadmissible on both counts:
    // neither window is 14 days, and equality is checked before adjacency.
    const unequal = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          bands: bandEvidence({
            recent: { startDate: "2026-07-06", endDate: "2026-07-12" },
            prior: { startDate: "2026-06-15", endDate: "2026-07-05" },
          }),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });
    expect(unequal.missingEvidence).toContain(
      "ad_recent14_window_not_14_days",
    );
    expect(unequal.fatigueStatus).toBe("unknown");

    // Equal 14-day windows with a one-day gap are not "directly preceding".
    const gapped = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          bands: bandEvidence({
            prior: { startDate: "2026-06-14", endDate: "2026-06-27" },
          }),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });
    expect(gapped.missingEvidence).toContain(
      "ad_band_windows_not_directly_preceding",
    );
    expect(gapped.fatigueStatus).toBe("unknown");
  });

  it("withholds the verdict when the recent band is below the sample floor", () => {
    // `recentSampleMinSpend` is 50 on this profile; 12 is a rounding error, not
    // a period. Reporting `none` there would call a starved ad healthy.
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          bands: bandEvidence({ recent: { spend: 12 } }),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });

    expect(evidence.missingEvidence).toContain(
      "ad_recent_band_below_sample_floor",
    );
    expect(evidence.fatigueStatus).toBe("unknown");
    expect(evidence.roasDecay).toBeNull();
  });

  it("withholds the verdict when exposure pressure is missing", () => {
    /*
      Two distinct absences, one outcome each. No account-relative percentile at
      all is MISSING EVIDENCE and withholds the verdict. A percentile that
      exists but which this ad sits below is EVIDENCE OF NO PRESSURE, and
      INVARIANTS.md then makes the decay lifecycle state rather than fatigue.
    */
    const noPercentile = computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd({ bands: bandEvidence() })),
      profile: profile(),
      frequencyPressureThreshold: null,
    });
    expect(noPercentile.missingEvidence).toContain(
      "account_relative_frequency_threshold_unavailable",
    );
    expect(noPercentile.fatigueStatus).toBe("unknown");

    const belowPercentile = computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd({ frequency: 1.1, bands: bandEvidence() })),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });
    expect(belowPercentile.frequencyPressure).toBe(false);
    expect(belowPercentile.missingEvidence).toEqual([]);
    expect(belowPercentile.fatigueStatus).not.toBe("fatigued");
  });

  it("withholds the verdict when click-to-purchase has no denominator", () => {
    /*
      This is the production case, not a hypothetical. Read-only inspection of
      the live warehouse on 2026-09-07 found `meta_ad_daily.link_clicks` at
      zero positive rows across the whole current 28-day window (10,750 rows,
      2,846 of them non-null and none above zero), decaying month over month
      from 7,666 positive rows in March 2026 to nil in August. With no link
      clicks there is no click-to-purchase rate in either period, so the
      composite cannot be formed and fatigued authority is not granted.
    */
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          bands: bandEvidence({
            recent: { linkClicks: 0 },
            prior: { linkClicks: 0 },
          }),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });

    expect(evidence.missingEvidence).toContain(
      "ad_recent14_window_link_clicks_unavailable",
    );
    expect(evidence.missingEvidence).toContain(
      "ad_prior14_window_link_clicks_unavailable",
    );
    expect(evidence.fatigueStatus).toBe("unknown");
  });

  it("withholds the verdict when no 14/14 evidence was materialized at all", () => {
    // Exactly how every production ad arrives today: the hydration query emits
    // a 28-day cumulative row and a 7-day recent row and no band pair.
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd()),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });

    expect(evidence.missingEvidence).toContain(
      "ad_disjoint_14d_band_evidence_unavailable",
    );
    expect(evidence.fatigueStatus).toBe("unknown");
    /*
      RE-PINNED. This asserted `evidenceHash` was NULL here, which pinned the
      v2 defect: the Refresh outcome that most needs provenance — held for
      missing evidence — carried no receipt at all, so two holds with different
      causes were indistinguishable and determinism could not be shown.

      v3 hashes a full receipt for every outcome. The hold still holds; it now
      says what held it.
    */
    expect(evidence.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic at the same cutoff and sensitive to the evidence", () => {
    const ad = adInput(decayedAd({ bands: bandEvidence() }));
    const first = computeNativeAdLifecycleEvidence({
      ad,
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });
    const second = computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd({ bands: bandEvidence() })),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });

    expect(second.evidenceHash).toBe(first.evidenceHash);
    expect(second.fatigueStatus).toBe(first.fatigueStatus);
    expect(first.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.contractVersion).toBe(NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT);

    // One click more in the recent window is a different fact and a different
    // hash, so the provenance cannot be replayed onto other evidence.
    const perturbed = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({ bands: bandEvidence({ recent: { clicks: 901 } }) }),
      ),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });
    expect(perturbed.evidenceHash).not.toBe(first.evidenceHash);

    /*
      Two runs of the whole producer at the same cutoff agree on every decided
      field. `generatedAt` is excluded because it is a wall clock reading taken
      at emit time, not a decision — `normalizeDecision` in
      `canonical-evaluation.ts` omits it from the canonical envelope for the
      same reason, so it never reaches `decisionHash`.
    */
    const decided = (rows: AdDecisionOutput[]) =>
      JSON.stringify(
        rows.map(({ generatedAt: _generatedAt, ...rest }) => rest),
      );
    const runOne = runNative([adInput(decayedAd({ bands: bandEvidence() }))]);
    const runTwo = runNative([adInput(decayedAd({ bands: bandEvidence() }))]);
    expect(decided(runTwo)).toBe(decided(runOne));
    expect(runOne[0]?.generatedAt).toBeDefined();
  });

  it("publishes a Refresh end to end once ad evidence confirms fatigue", () => {
    // Eight comparable ads make the account-relative frequency percentile
    // available; the decayed ad sits in the target band and carries the
    // highest frequency in the group.
    const siblings = siblingsWithFrequencies([1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4]);
    const fatigued = adInput(
      decayedAd({
        adId: "ad-fatigued",
        purchaseValue: 760,
        roas: 1.9,
        recent7dRoas: 0.5,
        frequency: 9,
        bands: bandEvidence(),
      }),
    );

    const decisions = runNative([...siblings, fatigued]);
    const decision = decisions.find((row) => row.adId === "ad-fatigued");
    if (!decision) {
      throw new Error(
        `Expected a Refresh decision; got ${decisions
          .map((row) => `${row.label}/${row.preAuthorityLabel}`)
          .join(", ")}`,
      );
    }
    expect(decision.preAuthorityLabel).toBe("refresh");
    expect(decision.blockedActionType).toBe("refresh");
    // D036 still publishes a first hard signal as pending confirmation, so the
    // published label is `keep` on this first evaluation. What matters here is
    // that the resolver reached Refresh at all, which it could not do while
    // `fatigueStatus` was permanently null.
    expect(decision.label).toBe("keep");
    expect(decision.reason).toContain("Fatigued");

    /*
      RE-PINNED. This used to assert that a confirmed Refresh carried NO
      provenance at all, which left the authorized path with no evidence
      lineage: `normalizeDecision` in `canonical-evaluation.ts` enumerates the
      fields it canonicalizes and neither `adBandEvidence` nor the derivation
      object is among them, so two ads whose bands differed entirely could
      reach `fatigued` and persist byte-identical decisions. The confirmed row
      now carries the contract and the FULL hash, as `status: "passed"`.
    */
    const confirmed = (decision.blockers ?? []).find(
      (entry) => entry.predicate === "refresh_ad_lifecycle_evidence_contract",
    );
    expect(confirmed?.status).toBe("passed");
    expect(confirmed?.observed).toBe(
      `${NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT}#${
        computeNativeAdLifecycleEvidence({
          ad: fatigued,
          profile: profile(),
          // The percentile the producer used: the whole population it was
          // handed, this ad included, not the eight siblings alone. The
          // threshold is part of the hashed evidence, so a different
          // population is a different lineage.
          frequencyPressureThreshold: resolveNativeAdFrequencyPressureThreshold(
            [...siblings, fatigued],
          ),
        }).evidenceHash
      }`,
    );

    /*
      The guard against over-correcting the other way. Publishing provenance on
      the authorized path must not turn a confirmed Refresh into something that
      reads as held: no withheld-evidence wording, no `missing` status, and no
      `refresh_ad_lifecycle_evidence` blocker, which is the predicate
      `resolutionForAuthorityBlocker` in lib/meta/decision-semantics.ts keys the
      "Refresh Held — Ad Fatigue Evidence Missing" resolution on.
    */
    expect(confirmed?.reason).toContain("confirmed");
    expect(confirmed?.reason).not.toContain("withheld");
    expect(confirmed?.severity).toBe("info");
    expect(
      (decision.blockers ?? []).map((entry) => entry.predicate),
    ).not.toContain("refresh_ad_lifecycle_evidence");
    expect(
      (decision.blockers ?? []).filter((entry) => entry.status !== "passed"),
    ).toEqual([]);
    expect(decision.authorityBlocker).not.toBe("native_metrics_unavailable");
  });

  it("gives different band evidence different authority lineage", () => {
    /*
      "Different band or P75 evidence must not share authority lineage."

      The only route this contract has into `decision_output_json` is
      `blockers`, because `normalizeDecision` in `canonical-evaluation.ts`
      enumerates its fields and `normalizeCreativeInput` beside it omits
      `adBandEvidence`. So the persisted `observed` string IS the lineage, and
      these three runs check it end to end through the producer rather than on
      the derivation object.
    */
    const siblings = siblingsWithFrequencies([
      1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4,
    ]);
    const persistedLineage = (bands: AdDisjointBandEvidence) => {
      const rows = runNative([
        ...siblings,
        adInput(
          decayedAd({
            adId: "ad-lineage",
            purchaseValue: 760,
            roas: 1.9,
            recent7dRoas: 0.5,
            frequency: 9,
            bands,
          }),
        ),
      ]);
      const row = rows.find((entry) => entry.adId === "ad-lineage");
      if (!row) throw new Error("Expected a decision for ad-lineage.");
      const provenance = (row.blockers ?? []).find(
        (entry) => entry.predicate === "refresh_ad_lifecycle_evidence_contract",
      );
      if (!provenance) {
        throw new Error(
          `Expected lifecycle provenance; got ${(row.blockers ?? [])
            .map((entry) => entry.predicate)
            .join(", ")}`,
        );
      }
      return provenance;
    };

    const first = persistedLineage(bandEvidence());
    // Identical evidence at the same cutoff is deterministic.
    expect(persistedLineage(bandEvidence()).observed).toBe(first.observed);
    // One click more in the recent band is a different fact.
    const perturbed = persistedLineage(
      bandEvidence({ recent: { clicks: 901 } }),
    );
    expect(perturbed.observed).not.toBe(first.observed);

    // The hash is carried whole. A 16-hex prefix is a display convenience, and
    // lineage a prefix collision can merge is not lineage.
    expect(first.observed).toMatch(
      new RegExp(`^${NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT}#[0-9a-f]{64}$`),
    );
    expect(String(first.observed)).toHaveLength(
      NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT.length + 1 + 64,
    );
  });

  it("holds a Refresh candidate when the decay cannot be corroborated", () => {
    // Fewer than eight comparable ads means no account-relative frequency
    // percentile exists, so fatigue can never be confirmed. Reporting "none"
    // there would say a collapsing ad is fine; the contract says "unknown"
    // and the resolver holds the Refresh instead of deleting it.
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd({ bands: bandEvidence() })),
      profile: profile(),
      frequencyPressureThreshold: null,
    });
    expect(evidence.fatigueStatus).toBe("unknown");
    expect(evidence.missingEvidence).toContain(
      "account_relative_frequency_threshold_unavailable",
    );

    const [computation] = runNativeComputations([
      adInput(
        decayedAd({
          // Sits inside the target band (ROAS 1.9 against a 2.0 target) so the
          // row is a Refresh question, not a Cut question.
          adId: "ad-uncorroborated",
          purchaseValue: 760,
          roas: 1.9,
          recent7dRoas: 0.5,
          bands: bandEvidence(),
        }),
      ),
    ]);
    if (!computation) throw new Error("Expected one native Ad decision.");
    const decision = computation.decision;

    // Execution shut, verdict kept.
    expect(decision.label).toBe("keep");
    expect(decision.preAuthorityLabel).toBe("refresh");
    expect(decision.blockedActionType).toBe("refresh");
    expect(decision.confidence).toBe(
      LIFECYCLE_HELD_REFRESH_CONFIDENCE_CAP,
    );
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "refresh_ad_lifecycle_evidence",
          threshold: "fatigued",
          status: "missing",
        }),
      ]),
    );

    const decisionProfile = profile();
    const persisted = toNativeSnapshotPayload({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      jobRunId: "00000000-0000-4000-8000-0000000009b2",
      scope: decisionProfile.scope,
      computation,
      stored: {
        evaluationId: "00000000-0000-4000-8000-0000000009b3",
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: computation.input.providerAccountId,
        decisionEntityId: computation.input.decisionEntityId,
        inputHash: "1".repeat(64),
        decisionHash: "2".repeat(64),
      },
      calibrationRowId: "00000000-0000-4000-8000-0000000009b4",
      hardActionEligibility: decisionProfile.hardActionEligibility,
      computedAt: `${AS_OF}T03:00:00.000Z`,
    });
    expect(persisted.confidence).toBe(
      LIFECYCLE_HELD_REFRESH_CONFIDENCE_CAP,
    );
    expect(persisted.authorized_action).toBeNull();
  });

  it("publishes the withholding contract and its specific gaps on a held Refresh", () => {
    /*
      "A held Refresh stays visible, with its specific reason." `blockers` is
      canonicalized by `normalizeDecision` in `canonical-evaluation.ts` and
      stored in `decision_output_json`, so this provenance is genuinely
      readable by a consumer — unlike the decay ratios, which are not.
    */
    const [decision] = runNative([
      adInput(
        decayedAd({
          adId: "ad-uncorroborated",
          purchaseValue: 760,
          roas: 1.9,
          recent7dRoas: 0.5,
        }),
      ),
    ]);
    if (!decision) throw new Error("Expected one native Ad decision.");

    const provenance = (decision.blockers ?? []).find(
      (entry) => entry.predicate === "refresh_ad_lifecycle_evidence_contract",
    );
    expect(provenance).toBeDefined();
    /*
      RE-PINNED. This asserted `observed` was the BARE contract version, which
      was only true because a held Refresh had no hash to publish under v2.
      Under v3 every outcome carries a full receipt, so a held row publishes
      `contract#hash` exactly as an authorized one does — which is the point:
      an operator can pin the hold to a digest, and two holds with different
      causes are now distinguishable.
    */
    expect(provenance?.observed).toMatch(
      new RegExp(`^${NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT}#[0-9a-f]{64}$`),
    );
    expect(provenance?.status).toBe("missing");
    expect(provenance?.reason).toContain(
      "ad_disjoint_14d_band_evidence_unavailable",
    );
    expect(provenance?.reason).toContain(NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT);

    // The hash is carried when there was admissible evidence to hash.
    const [hashed] = runNative([
      adInput(
        decayedAd({
          adId: "ad-uncorroborated-hashed",
          purchaseValue: 760,
          roas: 1.9,
          recent7dRoas: 0.5,
          // Below the account P75 that a single-ad population cannot build, so
          // the bands are admissible and the pressure percentile is not.
          bands: bandEvidence(),
        }),
      ),
    ]);
    if (!hashed) throw new Error("Expected one native Ad decision.");
    const hashedProvenance = (hashed.blockers ?? []).find(
      (entry) => entry.predicate === "refresh_ad_lifecycle_evidence_contract",
    );
    /*
      RE-PINNED to the FULL hash. This used to accept a 16-hex prefix, which is
      a display convenience: two different evidence sets that agreed on 64 bits
      would have persisted the same lineage string. The held and the authorized
      path now publish the identical whole hash.
    */
    expect(hashedProvenance?.observed).toMatch(
      new RegExp(`^${NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT}#[0-9a-f]{64}$`),
    );
    const hashedEvidence = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          adId: "ad-uncorroborated-hashed",
          purchaseValue: 760,
          roas: 1.9,
          recent7dRoas: 0.5,
          bands: bandEvidence(),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: null,
    });
    expect(hashedProvenance?.observed).toBe(
      `${NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT}#${hashedEvidence.evidenceHash}`,
    );
    // The guard the other way: this row is still HELD, and publishing the whole
    // hash must not read as confirmation.
    expect(hashedProvenance?.status).toBe("missing");
    expect(hashedProvenance?.reason).toContain(
      "account_relative_frequency_threshold_unavailable",
    );
  });

  it("names the ad's own missing evidence rather than a generic hold", () => {
    /*
      A held Refresh has to keep a SPECIFIC resolution, not collapse into the
      generic "restore a fresh, complete evidence window".

      Two things carry that specificity out of the engine, and both are checked
      here because `resolutionForAuthorityBlocker` in
      lib/meta/decision-semantics.ts requires BOTH before it will serve
      "Refresh Held — Ad Fatigue Evidence Missing": the authority blocker must
      be `native_metrics_unavailable` (not `profile_hard_action_ineligible`,
      which routes to the commercial-target copy) and the row must carry a
      `refresh_ad_lifecycle_evidence` predicate blocker. The contract blocker
      beside them then names WHICH piece is missing, and two rows held for
      different reasons must not report the same one.
    */
    const held = (bands: AdDisjointBandEvidence | null) => {
      const [decision] = runNative([
        adInput(
          decayedAd({
            adId: "ad-specific-cause",
            purchaseValue: 760,
            roas: 1.9,
            recent7dRoas: 0.5,
            bands,
          }),
        ),
      ]);
      if (!decision) throw new Error("Expected one native Ad decision.");
      return decision;
    };

    const noLinkClicks = held(
      bandEvidence({ recent: { linkClicks: 0 }, prior: { linkClicks: 0 } }),
    );
    expect(noLinkClicks.blockedActionType).toBe("refresh");
    expect(noLinkClicks.authorityBlocker).toBe("native_metrics_unavailable");
    expect(
      (noLinkClicks.blockers ?? []).map((entry) => entry.predicate),
    ).toEqual(
      expect.arrayContaining([
        "refresh_ad_lifecycle_evidence",
        "refresh_ad_lifecycle_evidence_contract",
      ]),
    );
    const linkClickBlocker = (noLinkClicks.blockers ?? []).find(
      (entry) => entry.predicate === "refresh_ad_lifecycle_evidence_contract",
    );
    // A held row's contract blocker must stay `missing`. Publishing the same
    // provenance on the authorized path must not make every row read as
    // confirmed.
    expect(linkClickBlocker?.status).toBe("missing");
    const linkClickCause = linkClickBlocker?.reason;
    expect(linkClickCause).toContain(
      "ad_recent14_window_link_clicks_unavailable",
    );
    expect(linkClickCause).toContain("ad_prior14_window_link_clicks_unavailable");

    // A different cause on an otherwise identical row must read differently.
    const noBands = held(null);
    const missingBandsCause = (noBands.blockers ?? []).find(
      (entry) => entry.predicate === "refresh_ad_lifecycle_evidence_contract",
    )?.reason;
    expect(missingBandsCause).toContain(
      "ad_disjoint_14d_band_evidence_unavailable",
    );
    expect(missingBandsCause).not.toContain("link_clicks_unavailable");
    expect(missingBandsCause).not.toBe(linkClickCause);
  });

  it("refuses to build an account-relative frequency percentile below the observation floor", () => {
    const seven = Array.from({ length: 7 }, (_, index) =>
      adInput(decayedAd({ adId: `ad-${index}`, frequency: 1 + index })),
    );
    expect(resolveNativeAdFrequencyPressureThreshold(seven)).toBeNull();
    expect(
      resolveNativeAdFrequencyPressureThreshold([
        ...seven,
        adInput(decayedAd({ adId: "ad-8", frequency: 8 })),
      ]),
    ).toBe(6);
  });

  it("turns the seventh-versus-eighth observation into a withheld verdict", () => {
    /*
      The P75 floor is not decoration. With seven comparable ads the percentile
      is null and a materially decayed eighth ad is `unknown`; adding one more
      observation is the only difference between a withheld verdict and a
      confirmed one.
    */
    const decayedBands = bandEvidence();
    const withSeven = siblingsWithFrequencies([1, 1.2, 1.4, 1.6, 1.8, 2, 2.2])
      .slice(0, 7)
      .concat(
        adInput(
          decayedAd({ adId: "ad-under-test", frequency: 9, bands: decayedBands }),
        ),
      );
    // Seven of the eight carry no observable metrics, so only one frequency is
    // observable and the percentile stays null.
    const sevenObservations = withSeven.map((ad, index) =>
      index < 7
        ? {
            ...ad,
            metricEvidence: {
              ...ad.metricEvidence,
              performanceMetricsObserved: false,
            },
          }
        : ad,
    );
    expect(
      resolveNativeAdFrequencyPressureThreshold(sevenObservations),
    ).toBeNull();

    const sevenEvidence = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({ adId: "ad-under-test", frequency: 9, bands: decayedBands }),
      ),
      profile: profile(),
      frequencyPressureThreshold: resolveNativeAdFrequencyPressureThreshold(
        sevenObservations,
      ),
    });
    expect(sevenEvidence.fatigueStatus).toBe("unknown");

    const eight = siblingsWithFrequencies([1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4]);
    const threshold = resolveNativeAdFrequencyPressureThreshold(eight);
    expect(threshold).not.toBeNull();
    const eightEvidence = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({ adId: "ad-under-test", frequency: 9, bands: decayedBands }),
      ),
      profile: profile(),
      frequencyPressureThreshold: threshold,
    });
    expect(eightEvidence.fatigueStatus).toBe("fatigued");
  });

  it("builds the percentile per provider account, not per calibration cell", () => {
    /*
      INVARIANTS.md requires the percentile to be account-relative. A profile
      group is one calibration cell (provider account + objective +
      optimization goal + custom event type + cohort), so resolving it per
      group would split these eight ads across their cells and return null for
      every one of them, forcing `fatigueStatus: "unknown"` on an account that
      has ample observations.
    */
    const purchaseCell = Array.from({ length: 4 }, (_, index) =>
      adInput(
        decayedAd({
          adId: `ad-purchase-${index}`,
          frequency: 1 + index,
        }),
      ),
    );
    const leadCell = Array.from({ length: 4 }, (_, index) => {
      const ad = adInput(
        decayedAd({ adId: `ad-lead-${index}`, frequency: 5 + index }),
      );
      return { ...ad, customEventType: "LEAD" };
    });
    const otherAccount = adInput(
      decayedAd({ adId: "ad-other-account", frequency: 99 }),
    );

    const byAccount = resolveNativeAdFrequencyPressureThresholdsByAccount([
      ...purchaseCell,
      ...leadCell,
      { ...otherAccount, providerAccountId: "act-other" },
    ]);

    // Eight observations across two cells of one account: 1..8, nearest-rank
    // P75 = 6. Resolved per cell, each half would be four observations and
    // therefore null.
    expect(byAccount.get("act-grandmix")).toBe(6);
    expect(resolveNativeAdFrequencyPressureThreshold(purchaseCell)).toBeNull();
    expect(resolveNativeAdFrequencyPressureThreshold(leadCell)).toBeNull();
    // A second account never lends its observations to the first.
    expect(byAccount.get("act-other")).toBeNull();
  });

  it("keeps the derivation's intermediate evidence off the persisted decision", () => {
    /*
      The doc comment on `NativeAdLifecycleEvidence` names two routes out of the
      module and closes every other one. This is that claim checked rather than
      asserted: the decay ratios, the exposure-pressure flag and the prior-band
      verdict appear nowhere on the decision row that
      `buildAdCanonicalEvaluationProvenance` hashes and persists, so no consumer
      can cite them and no assertion above should be read as a consumable
      contract. The contract version and the missing-evidence list DO appear,
      by the blocker route, and are asserted separately.
    */
    const evidence = computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd({ bands: bandEvidence() })),
      profile: profile(),
      frequencyPressureThreshold: 3.5,
    });
    expect(evidence.roasDecay).not.toBeNull();
    expect(evidence.missingEvidence).toEqual([]);

    const [decision] = runNative([
      adInput(decayedAd({ bands: bandEvidence() })),
    ]);
    if (!decision) throw new Error("Expected one native Ad decision.");
    const serialized = JSON.stringify(decision);
    for (const field of [
      "roasDecay",
      "ctrDecay",
      "clickToPurchaseDecay",
      "frequencyPressure",
      "priorBandWasStrong",
    ]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("pins the badge and confidence cost of emitting past_peak_unclear", () => {
    /*
      Deliberate, not a side effect. `applyPostProcess` in
      `lib/creative-decision-engine/gates/types.ts` turns
      `lifecyclePosition: "past_peak_unclear"` into a `past_peak_unclear_signal`
      warning badge on keep/refresh/cut rows and subtracts 3 confidence on
      refresh and cut. This contract emits that position exactly when the ROAS
      band decayed past `FATIGUE_SIGNIFICANT_DECAY_THRESHOLD`, which is part of
      the same evidence a Refresh rests on, so the warning is earned and the
      confidence cost is the price of an unconfirmed lifecycle read. The
      granting positions (`rising`, `plateau`) are never emitted, so this
      contract can only lower confidence, never raise it.
    */
    const decayed = computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd({ bands: bandEvidence() })),
      profile: profile(),
      frequencyPressureThreshold: null,
    });
    expect(decayed.lifecyclePosition).toBe("past_peak_unclear");

    const steady = computeNativeAdLifecycleEvidence({
      ad: adInput(
        decayedAd({
          adId: "ad-steady",
          bands: bandEvidence({ recent: { ...DECAYED_PRIOR, spend: 300 } }),
        }),
      ),
      profile: profile(),
      frequencyPressureThreshold: null,
    });
    expect(steady.lifecyclePosition).toBe("insufficient_history");

    const [held] = runNative([
      adInput(
        decayedAd({
          adId: "ad-uncorroborated",
          purchaseValue: 760,
          roas: 1.9,
          recent7dRoas: 0.5,
          bands: bandEvidence(),
        }),
      ),
    ]);
    if (!held) throw new Error("Expected one native Ad decision.");
    expect(held.badges.map((badge) => badge.type)).toContain(
      "past_peak_unclear_signal",
    );
  });

  it("says insufficient history rather than lifecycle unavailable on a hard-action row", () => {
    /*
      `applyPostProcess` in `lib/creative-decision-engine/gates/types.ts` picks
      the `lifecycle_unavailable` badge label from the position: `null`, which
      is what every native Ad carried before this contract, reads "Lifecycle
      data unavailable"; the `insufficient_history` this contract emits reads
      "Insufficient history for lifecycle analysis". That is the honest
      sentence for an ad whose bands were never materialized. Pinned so the copy
      change is a decision, not a by-product.

      The row has to reach a hard label for the badge to be added at all, so
      this is a flat-ROAS severe loser: 0.50 against a 2.00 target on 9,000
      spend.
    */
    const [decision] = runNative([
      adInput({
        adId: "ad-flat-loser",
        spend: 9000,
        purchases: 30,
        purchaseValue: 4500,
        roas: 0.5,
        recent7dSpend: 2000,
        recent7dPurchases: 7,
        recent7dRoas: 0.5,
        impressions: 500000,
        recent7dImpressions: 100000,
        frequency: 2,
      }),
    ]);
    if (!decision) throw new Error("Expected one native Ad decision.");

    expect(decision.preAuthorityLabel).toBe("cut");
    const lifecycleBadge = decision.badges.find(
      (badge) => badge.type === "lifecycle_unavailable",
    );
    expect(lifecycleBadge?.label).toBe(
      "Insufficient history for lifecycle analysis",
    );
  });
});

/*
  CODEX A4 / A7 — THE RECEIPT IS FULL, DETERMINISTIC, AND EXISTS FOR EVERY
  REFRESH; AND AN IMPOSSIBLE WINDOW DATE FAILS CLOSED.

  Under v2 the hash was `bands ? sha256(...) : null`, so the outcome an
  operator most needs to interrogate — a Refresh HELD because evidence was
  missing or invalid — carried no receipt. Two holds with different causes were
  indistinguishable, and nothing could be shown to be stable across runs.

  Separately, `parseIsoDate` tested the SHAPE of a date and then trusted
  `Date.parse`. Measured on this runtime: `Date.parse("2026-02-30T00:00:00Z")`
  does not fail, it returns midnight on 2026-03-02, and `2026-04-31` returns
  2026-05-01. An impossible date therefore became a real one two days away and
  silently redefined the band it was bounding.
*/
describe("the lifecycle receipt covers every Refresh outcome", () => {
  const threshold = 3.5;

  function evidenceFor(ad: Partial<AdShape>, frequencyPressureThreshold = threshold) {
    return computeNativeAdLifecycleEvidence({
      ad: adInput(decayedAd(ad)),
      profile: profile(),
      frequencyPressureThreshold,
    });
  }

  it("hashes a held Refresh whose bands were never materialized", () => {
    const held = evidenceFor({});
    expect(held.fatigueStatus).toBe("unknown");
    expect(held.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(held.missingEvidence).toContain(
      "ad_disjoint_14d_band_evidence_unavailable",
    );
  });

  it("hashes an authorized-path Refresh too, and differently", () => {
    const held = evidenceFor({});
    const withBands = evidenceFor({ bands: bandEvidence() });
    expect(withBands.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    // A receipt that could not tell a hold from a measured band pair would be
    // no receipt at all.
    expect(withBands.evidenceHash).not.toBe(held.evidenceHash);
  });

  it("distinguishes two holds that failed for DIFFERENT reasons", () => {
    /*
      This is the property v2 could not express: both of these hold, both were
      `evidenceHash: null`, and an operator could not tell them apart. The
      missing-evidence codes differ, so the receipts must differ.
    */
    const noBands = evidenceFor({});
    const impossibleDates = evidenceFor({
      bands: bandEvidence({
        // 2026-02-30 does not exist. Before the round-trip fix this parsed to
        // 2026-03-02 and the band was silently accepted with shifted bounds.
        recent: { startDate: "2026-02-30", endDate: "2026-03-15" },
      }),
    });
    expect(noBands.fatigueStatus).toBe("unknown");
    expect(impossibleDates.fatigueStatus).toBe("unknown");
    expect(impossibleDates.evidenceHash).not.toBe(noBands.evidenceHash);
  });

  it("fails an impossible window date closed instead of rolling it over", () => {
    const rolled = evidenceFor({
      bands: bandEvidence({
        recent: { startDate: "2026-02-30", endDate: "2026-03-15" },
      }),
    });
    // Named as invalid dates, NOT silently admitted as a 14-day band.
    expect(rolled.missingEvidence).toContain(
      "ad_recent14_window_dates_invalid",
    );
    expect(rolled.fatigueStatus).toBe("unknown");
    expect(rolled.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a real end-of-month date, so the check is not merely strict", () => {
    // The control: 2026-01-31 round-trips, so a legitimate month end is not
    // collateral damage of the fix.
    const ok = evidenceFor({
      bands: bandEvidence({
        recent: { startDate: "2026-01-31", endDate: "2026-02-13" },
      }),
    });
    expect(ok.missingEvidence).not.toContain("ad_recent14_window_dates_invalid");
  });

  it("moves the receipt when a threshold moves, with every band identical", () => {
    const at35 = evidenceFor({ bands: bandEvidence() }, 3.5);
    const at40 = evidenceFor({ bands: bandEvidence() }, 4.0);
    // Same ad, same bands, same profile: only the account-relative frequency
    // threshold differs, and it is verdict-bearing, so the receipt must move.
    expect(at40.evidenceHash).not.toBe(at35.evidenceHash);
  });

  it("survives a zero denominator without losing its receipt", () => {
    /*
      Zero clicks and zero impressions make CTR and click-to-purchase
      undefined. The verdict must hold and the receipt must still exist —
      "we could not divide" is exactly the state that needs provenance.
    */
    const zeroed = evidenceFor({
      bands: bandEvidence({
        recent: { clicks: 0, impressions: 0, purchases: 0 },
        prior: { clicks: 0, impressions: 0, purchases: 0 },
      }),
    });
    expect(zeroed.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(zeroed.fatigueStatus).toBe("unknown");
    expect(Number.isNaN(Number(zeroed.ctrDecay))).toBe(false);
  });

  it("is deterministic for a HELD outcome across repeated runs", () => {
    // v2 could not make this claim at all: there was nothing to compare.
    const runs = [evidenceFor({}), evidenceFor({}), evidenceFor({})];
    expect(new Set(runs.map((r) => r.evidenceHash)).size).toBe(1);
  });
});
