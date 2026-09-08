import { describe, expect, it } from "vitest";

import {
  readMetaAutomationPosture,
  readMetaReleaseGates,
} from "@/lib/meta/release-gates";
import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";
import type { CampaignContextLabelMap } from "../../campaign-context/source";
import { MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE } from "../../config-values";
import { computeNativeAdDecisions } from "../../jobs/ad-decisions-job";
import type {
  AccountDecisionProfile,
  AdDecisionInput,
  AdDecisionOutput,
} from "../../types";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "../helpers";

/*
  Area 4/5 regression: the operator VERDICT and EXECUTION eligibility are two
  contracts, and only the second one is allowed to close.

  Both cases here are measured on Grandmix's exact purchase cell, whose native
  calibration receipt reads:

    cut     ready=true  authorityBasis=commercial_stop_loss observed=19 required=0
    scale   ready=false scale_calibration_sample_low        observed=19 required=30
    refresh ready=false refresh_calibration_sample_low      observed=0  required=20

  Before the fix, `ratioZonesGate` turned a scale-zone ad whose own economics
  were complete into a plain `keep` with `preAuthorityLabel: "keep"` the moment
  `scaleBenchmarkBlockers` was non-empty. The row then carried no
  `blockedActionType`, so nothing downstream — lane routing, the held-verdict
  label, the resolution copy — could tell it apart from an ad that simply is
  not a scale candidate. The recommendation was deleted, not withheld.
*/

const BUSINESS_ID = "biz-verdict-execution";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-0000000009a1";
const AS_OF = "2026-07-12";

/** Grandmix's observed mature-ad sample for the exact purchase cell. */
const GRANDMIX_OBSERVED_SCALE_SAMPLE = 19;

function campaignContext(): CampaignContextLabelMap {
  return new Map([
    [
      "campaign-main",
      {
        kind: "main" as const,
        testDimension: null,
        contextTrust: "high" as const,
        provenance: {
          mode: "automatic" as const,
          source: "system_inferred" as const,
          campaignId: "campaign-main",
          kind: "main" as const,
          testDimension: null,
          contextTrust: "high" as const,
          sourceRecordType: "engine_v3_campaign_context_daily" as const,
          sourceRecordId: "context-campaign-main",
          sourceAsOfDate: AS_OF,
          sourceUpdatedAt: `${AS_OF}T01:00:00.000Z`,
          sourceHash: "a".repeat(64),
        },
      },
    ],
  ]);
}

function adInput(overrides: Partial<AdDecisionInput> = {}): AdDecisionInput {
  const creative = makeCreativeInput({
    businessId: BUSINESS_ID,
    creativeId: "shared-creative",
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
    // A finished scale candidate: 175% of a 2.0 target on real purchase depth,
    // with the recent week holding above target.
    spend: 900,
    purchases: 26,
    purchaseValue: 3150,
    roas: 3.5,
    recent7dSpend: 220,
    recent7dPurchases: 6,
    recent7dRoas: 3.4,
    recent7dImpressions: 18000,
    impressions: 74000,
    targetRoas: 2,
    breakevenRoas: null,
    commercialTargetFreshness: "fresh",
    dataFreshnessHours: 4,
  });
  return {
    ...creative,
    decisionEntityType: "ad",
    decisionEntityId: "ad-scale-candidate",
    adId: "ad-scale-candidate",
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-grandmix",
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "TRY",
    adsetId: "adset-1",
    creativeId: "shared-creative",
    optimizationGoal: "PURCHASE",
    customEventType: "PURCHASE",
    metricEvidence: {
      sourceRowCount: 28,
      performanceMetricsObserved: true,
      eventMetricsObserved: true,
    },
    statusEvidence: {
      source: "entity_state_history",
      sourceRecordId: "state-ad-scale-candidate",
      observedAt: `${AS_OF}T02:00:00.000Z`,
      capturedAt: `${AS_OF}T02:01:00.000Z`,
    },
    creativeEvidence: {
      sourceLifecycleRowId: null,
      sourceAsOfDate: null,
      sourceComputedAt: null,
      sourceMaxUpdatedAt: null,
      lifecyclePosition: null,
      daysSincePeak: null,
      peakRoas30d: null,
      peakConfidence: null,
      spendTrajectory30d: null,
      spendSlope7d: null,
      spendSlope30d: null,
      roasSlope7d: null,
      roasSlope30d: null,
      fatigueStatus: null,
      qualityRanking: null,
      engagementRateRanking: null,
      conversionRateRanking: null,
      creativeFormat: null,
    },
    ...overrides,
  };
}

/**
 * A profile shaped like Grandmix's cell: Cut is authorized on the commercial
 * stop-loss path, Scale is not, because the mature-ad sample is 19 against a
 * floor of 30.
 */
function thinScaleCalibrationProfile(): AccountDecisionProfile {
  return makeAccountDecisionProfile({
    asOfDate: AS_OF,
    accountBaselines: makeAccountCalibration({
      matureCreativeCount: GRANDMIX_OBSERVED_SCALE_SAMPLE,
      winnerPurchaseP50: 8,
    }),
    thresholds: { scaleMinPurchases: 8, commercialMaturitySpend: 400 },
    hardActionEligibility: {
      scale: false,
      cut: true,
      refresh: false,
      reason: "scale calibration sample is below automation-quality floor",
      reasons: {
        scale: "scale calibration sample is below automation-quality floor",
        cut: null,
        refresh: "refresh calibration sample is below automation-quality floor",
      },
    },
    quality: {
      commercialTruthReady: true,
      calibrationReady: false,
      metaAovQuality: "ready",
      thresholdQuality: "ready",
    },
  });
}

/**
 * GC-052's shape: the account's mature-ad sample clears the floor, so Scale
 * stays profile-eligible, but no winner purchase P50 exists to compare this ad
 * against.
 */
function missingWinnerBenchmarkProfile(): AccountDecisionProfile {
  return makeAccountDecisionProfile({
    asOfDate: AS_OF,
    accountBaselines: makeAccountCalibration({
      matureCreativeCount: 40,
      winnerPurchaseP50: null,
    }),
    thresholds: { scaleMinPurchases: 8, commercialMaturitySpend: 400 },
    quality: {
      commercialTruthReady: true,
      calibrationReady: true,
      metaAovQuality: "ready",
      thresholdQuality: "ready",
    },
  });
}

function runNativeDecision(
  profile: AccountDecisionProfile,
): AdDecisionOutput {
  const [computation] = computeNativeAdDecisions({
    businessId: BUSINESS_ID,
    profile,
    dataHealth: makeDataHealth(),
    adInputs: [adInput()],
    campaignContextMode: "automatic",
    campaignContextById: campaignContext(),
    previousLabels: new Map(),
  });
  if (!computation) throw new Error("Expected one native Ad computation.");
  return computation.decision;
}

describe("native Ad verdict versus execution eligibility", () => {
  it("holds a scale-zone ad for execution while keeping the Scale verdict and its numbers", () => {
    const decision = runNativeDecision(thinScaleCalibrationProfile());

    // Execution stays shut: the published label is a soft Keep and no
    // provider action is authorized.
    expect(decision.label).toBe("keep");

    // The verdict survives. Before the fix both of these were "keep" / null.
    expect(decision.preAuthorityLabel).toBe("scale");
    expect(decision.blockedActionType).toBe("scale");
    expect(decision.authorityBlocker).toBe("profile_hard_action_ineligible");

    // observed/required are readable as numbers, not as a prose sentence.
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "scale_account_benchmark_ready",
          observed: GRANDMIX_OBSERVED_SCALE_SAMPLE,
          threshold: MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
        }),
      ]),
    );
    expect(decision.reason).toContain(
      `account scale calibration thin (${GRANDMIX_OBSERVED_SCALE_SAMPLE} mature creatives; need ${MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE}+)`,
    );
    expect(decision.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "scale_readiness_blocked",
        "scale_calibration_thin",
      ]),
    );
  });

  it("serves the held Scale as a blocked state with a specific reason, not a generic gap", () => {
    const decision = runNativeDecision(thinScaleCalibrationProfile());
    const semantics = projectMetaDecisionSemantics({
      // `test_more`/`keep` is the compatibility label the buyer adapter emits
      // for a held hard verdict; the projection must not present it as an
      // affirmative soft action.
      legacyBuyerAction: "test_more",
      sourceLabel: decision.label,
      lifecycleRole: "main",
      badgeCodes: decision.badges.map((badge) => badge.type),
      blockerCodes: [decision.authorityBlocker].filter(
        (code): code is NonNullable<typeof code> => Boolean(code),
      ),
      heldAction: "scale",
      authorityBlocker: decision.authorityBlocker,
      // Badges cannot carry this distinction: `scaleReadinessBadges` stamps
      // `scale_calibration_thin` for a thin sample AND for a missing winner
      // purchase P50. Only the numeric blocker separates GC-051 from GC-052.
      predicateBlockers: decision.blockers ?? [],
    });

    expect(semantics).toMatchObject({
      decisionState: "blocked",
      buyerAction: null,
      heldAction: "scale",
    });
    // The specific held reason, not "complete the missing evidence".
    expect(semantics.resolution?.label).toBe(
      "Scale Held — Calibration Sample Thin",
    );
    expect(semantics.resolution?.nextStep).toContain(
      "The Scale verdict stands on this ad's own economics",
    );
  });

  it("does not claim a thin calibration sample when the gap is the missing winner benchmark", () => {
    /*
      GOLDEN_CASES.md GC-051 (thin account calibration sample) and GC-052
      (missing winner purchase benchmark) are distinct rows, and the badge does
      not distinguish them: `scaleReadinessBadges` emits
      `scale_calibration_thin` for either. Keying the held-Scale copy on the
      badge therefore told a GC-052 operator that "only the account
      winner-calibration sample is below its floor", which is false — that
      account's sample is fine and its winner benchmark does not exist.

      `resolveHardActionEligibility` in account-decision-profile.ts makes
      `scaleEligible` require `calibrationReady`, so this profile — calibration
      ready, no winner P50 — is the exact shape that reaches the explicit hold
      in `ratioZonesGate` rather than the profile-denial path.
    */
    const decision = runNativeDecision(missingWinnerBenchmarkProfile());

    expect(decision.label).toBe("keep");
    expect(decision.preAuthorityLabel).toBe("scale");
    expect(decision.blockedActionType).toBe("scale");
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "scale_account_benchmark_ready",
          observed: null,
          threshold: "positive winner purchase P50",
        }),
      ]),
    );
    // The badge is identical to the GC-051 row's, which is why it cannot key
    // the copy.
    expect(decision.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining(["scale_calibration_thin"]),
    );

    const semantics = projectMetaDecisionSemantics({
      legacyBuyerAction: "test_more",
      sourceLabel: decision.label,
      lifecycleRole: "main",
      badgeCodes: decision.badges.map((badge) => badge.type),
      blockerCodes: [decision.authorityBlocker].filter(
        (code): code is NonNullable<typeof code> => Boolean(code),
      ),
      heldAction: "scale",
      authorityBlocker: decision.authorityBlocker,
      predicateBlockers: decision.blockers ?? [],
    });

    expect(semantics.resolution?.label).toBe(
      "Scale Held — Winner Benchmark Missing",
    );
    expect(semantics.resolution?.nextStep).not.toContain(
      "winner-calibration sample is below its floor",
    );
  });

  it("names the honest authority blocker on an explicit hold", () => {
    /*
      `finalizeDecision` in gates/types.ts honours a requested authority hold
      only when `profileBlocksHardAuthority` is FALSE — that is, only when the
      profile's `hardActionEligibility` allows the action. So a hold that
      hard-codes `profile_hard_action_ineligible` names the one state that
      cannot be true when it is written, and
      `resolutionForAuthorityBlocker` routes that code to commercial-target and
      hard-action-evidence copy the row has nothing to do with.
    */
    const profile = missingWinnerBenchmarkProfile();
    expect(profile.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
      refresh: true,
    });
    expect(runNativeDecision(profile).authorityBlocker).toBe(
      "native_metrics_unavailable",
    );

    // The thin-sample row still reports the profile denial, because there the
    // profile really does deny Scale.
    expect(runNativeDecision(thinScaleCalibrationProfile()).authorityBlocker).toBe(
      "profile_hard_action_ineligible",
    );
  });

  it("keeps a Main-campaign Scale in the Act lane instead of demoting it to monitor", () => {
    // The demotion had no blocker and no reason behind it: a Main campaign
    // carries most of an account's budget, and the role never made the
    // mathematics weaker. Only an unresolved role is untrustworthy context.
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "scale",
        sourceLabel: "scale",
        lifecycleRole: "main",
        badgeCodes: [],
      }),
    ).toMatchObject({ decisionState: "act", buyerAction: "scale" });
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "scale",
        sourceLabel: "scale",
        lifecycleRole: "role_unresolved",
        badgeCodes: [],
      }),
    ).toMatchObject({ decisionState: "monitor", buyerAction: "scale" });
  });

  it("changes Apply/auto availability and nothing else when the execution switch flips", () => {
    const profile = thinScaleCalibrationProfile();
    const closed = { META_AUTOMATION_LIVE_WRITES: "false" };
    const open = { META_AUTOMATION_LIVE_WRITES: "true" };

    // The capability itself really does flip, so this is not a vacuous pass.
    expect(readMetaReleaseGates(closed).automationLiveWrites).toBe(false);
    expect(readMetaReleaseGates(open).automationLiveWrites).toBe(true);
    expect(readMetaAutomationPosture(closed).dryRunOnly).toBe(true);
    expect(readMetaAutomationPosture(open).dryRunOnly).toBe(false);

    const before = runNativeDecision(profile);
    process.env.META_AUTOMATION_LIVE_WRITES = "true";
    let after: AdDecisionOutput;
    try {
      after = runNativeDecision(profile);
    } finally {
      delete process.env.META_AUTOMATION_LIVE_WRITES;
    }

    // Verdict, held action, reason, badges, blockers and confidence are all
    // untouched by the write capability. `generatedAt` is the only field the
    // clock owns.
    const verdict = (decision: AdDecisionOutput) => ({
      ...decision,
      generatedAt: null,
    });
    expect(verdict(after)).toEqual(verdict(before));
    expect(after.preAuthorityLabel).toBe("scale");
    expect(after.blockedActionType).toBe("scale");
  });
});
