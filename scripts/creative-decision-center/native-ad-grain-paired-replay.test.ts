import { describe, expect, it } from "vitest";
import {
  assertNativeReplayCohortMatch,
  buildReplayProfile,
  buildFunnelBaselines,
  isObservationCutoffSafe,
  outcomeWindowDates,
  selectReplayTargetAtCutoff,
  selectCutoffSafeLifecycleObservation,
  selectForwardActionReceipts,
  summarizeActionExposure,
  type ActionReceipt,
  type LifecycleObservation,
  type NativeReplayCohortComparable,
} from "@/scripts/creative-decision-center/native-ad-grain-paired-replay";

function comparable(
  overrides: Partial<NativeReplayCohortComparable["lineage"]> = {},
): NativeReplayCohortComparable {
  return {
    coverage: {
      businesses: 12,
      sourceRows: 142_170,
      cohortRows: 17_233,
      targetExactRows: 2_902,
      completeOutcomeRows: 16_945,
      creativeIdRows: 17_233,
      duplicateCohortKeys: 0,
      uniqueDecisionInputHashes: 17_233,
    },
    lineage: {
      engineVersion: "v3-test",
      scriptContentHash: "script",
      simulationSourceHash: "simulation",
      productionEngineSourceHash: "engine",
      manifestSetHash: "manifest",
      outcomeWindowSetHash: "outcomes",
      ...overrides,
    },
  };
}

describe("native ad replay cohort comparison", () => {
  it("accepts full and smoke reports with the same cohort and source lineage", () => {
    expect(assertNativeReplayCohortMatch(comparable(), comparable())).toEqual({
      status: "pass",
      identityHash: "manifest",
      comparedFields: 14,
    });
  });

  it("uses the manifest set as cohort identity and rejects drift", () => {
    expect(() =>
      assertNativeReplayCohortMatch(
        comparable(),
        comparable({ manifestSetHash: "different" }),
      ),
    ).toThrow("lineage.manifestSetHash");
  });

  it("rejects coverage drift even when the manifest hash is copied", () => {
    const candidate = comparable();
    candidate.coverage.cohortRows -= 1;
    expect(() =>
      assertNativeReplayCohortMatch(comparable(), candidate),
    ).toThrow("coverage.cohortRows");
  });

  it("rejects drift in any of the closed outcome windows", () => {
    expect(() =>
      assertNativeReplayCohortMatch(
        comparable(),
        comparable({ outcomeWindowSetHash: "different" }),
      ),
    ).toThrow("lineage.outcomeWindowSetHash");
  });
});

function receipt(
  id: string,
  overrides: Partial<ActionReceipt> = {},
): ActionReceipt {
  return {
    id,
    businessId: "business-a",
    adId: "ad-a",
    action: "pause",
    status: "success",
    requestedAt: "2026-06-01T02:00:00.000Z",
    verifiedAt: "2026-06-01T02:01:00.000Z",
    dryRun: false,
    ...overrides,
  };
}

function lifecycle(
  computedAt: string,
  overrides: Partial<LifecycleObservation> = {},
): LifecycleObservation {
  return {
    businessId: "business-a",
    providerAccountId: "account-a",
    adId: "ad-a",
    asOfDate: "2026-06-01",
    engineVersion: "v3-test",
    computedAt,
    sourceMaxDate: "2026-06-01",
    sourceMaxUpdatedAt: computedAt,
    effectiveStatus: "ACTIVE",
    lifecyclePosition: "plateau",
    fatigueStatus: "none",
    fatigueConfidence: 0.8,
    daysSincePeak: 2,
    peakRoas30d: 3,
    peakConfidence: 0.8,
    spendTrajectory30d: "flat",
    spendSlope7d: 0,
    spendSlope30d: 0,
    roasSlope7d: 0,
    roasSlope30d: 0,
    qualityRanking: "average",
    engagementRateRanking: "average",
    conversionRateRanking: "average",
    creativeFormat: "image",
    ...overrides,
  };
}

describe("native ad replay PIT context", () => {
  it("keeps an old cutoff-safe target authoritative in the current engine replay", () => {
    const profileInput = {
      business: {
        id: "business-a",
        legacyId: "legacy-business-a",
        name: "Business A",
      },
      asOfDate: "2026-07-15",
      target: {
        targetCpa: 100,
        targetRoas: 2.4,
        breakEvenCpa: 130,
        breakEvenRoas: 1.6,
        operatorAovAssumption: 240,
        riskPosture: "balanced",
        updatedAt: "2026-01-01T00:00:00.000Z",
        effectiveAt: "2026-01-01T00:00:00.000Z",
        recordedAt: "2026-01-01T00:00:00.000Z",
        operation: "upsert",
        source: "business_target_pack_history",
      },
      calibration: {
        businessId: "business-a",
        computedAt: "2026-07-15T03:00:00.000Z",
        campaignKind: "all",
        matureCreativeCount: 30,
        roasP75: 3,
        roasP60: 2.5,
        refreshRatioP10: 0.5,
        lowCtrP10: 0.01,
        accountCpaP50: 100,
        accountCpaSampleCount: 30,
        metaAttributedAovMean90d: 240,
        metaAttributedAovPurchaseCount90d: 100,
        metaAttributedRevenue90d: 24_000,
        matureSpendP50: 300,
        matureSpendP75: 500,
        winnerSpendP25: 250,
        winnerSpendP50: 400,
        winnerPurchaseP50: 5,
        roasRatioP10: 0.4,
        roasRatioP25: 0.6,
        roasRatioP50: 1,
        roasRatioP75: 1.4,
        metaAovQuality: "ready",
      },
      profileConfig: null,
      forceRawAuthority: false,
    } satisfies Parameters<typeof buildReplayProfile>[0];
    const profile = buildReplayProfile(profileInput);

    expect(profile.quality).toMatchObject({
      commercialTruthReady: true,
      commercialTruthFreshness: "stale",
    });
    expect(profile.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
      refresh: true,
    });

    const deletedProfile = buildReplayProfile({
      ...profileInput,
      target: { ...profileInput.target, operation: "delete" },
    });
    expect(deletedProfile.quality.commercialTruthReady).toBe(false);
    expect(deletedProfile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
    });
  });

  it("treats the latest cutoff-safe target delete as no commercial authority", () => {
    const upsert = {
      targetCpa: 100,
      targetRoas: 2.4,
      breakEvenCpa: 130,
      breakEvenRoas: 1.6,
      operatorAovAssumption: 240,
      riskPosture: "balanced" as const,
      updatedAt: "2026-01-01T00:00:00.000Z",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      recordedAt: "2026-01-01T00:00:00.000Z",
      operation: "upsert" as const,
      source: "business_target_pack_history" as const,
    };
    const deleted = {
      ...upsert,
      updatedAt: "2026-03-01T00:00:00.000Z",
      effectiveAt: "2026-03-01T00:00:00.000Z",
      recordedAt: "2026-03-01T00:00:00.000Z",
      operation: "delete" as const,
    };

    expect(
      selectReplayTargetAtCutoff([upsert, deleted], "2026-07-15"),
    ).toBeNull();
    expect(
      selectReplayTargetAtCutoff(
        [
          upsert,
          {
            ...deleted,
            effectiveAt: "2026-08-01T00:00:00.000Z",
            recordedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        "2026-07-15",
      ),
    ).toEqual(upsert);
  });

  it("rejects lifecycle and daily observations first seen after the decision cutoff", () => {
    const selected = selectCutoffSafeLifecycleObservation(
      [
        lifecycle("2026-06-01T02:00:00.000Z"),
        lifecycle("2026-06-01T04:00:00.000Z", {
          lifecyclePosition: "closing",
        }),
        lifecycle("2026-06-01T02:30:00.000Z", {
          sourceMaxUpdatedAt: "2026-06-01T05:00:00.000Z",
          lifecyclePosition: "rising",
        }),
      ],
      "2026-06-01",
    );

    expect(selected?.computedAt).toBe("2026-06-01T02:00:00.000Z");
    expect(selected?.lifecyclePosition).toBe("plateau");
    expect(
      isObservationCutoffSafe({
        createdAt: "2026-06-01T02:00:00.000Z",
        updatedAt: "2026-06-01T04:00:00.000Z",
        cutoff: "2026-06-01T03:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("keeps pre-cutoff action strata observational and isolates forward contamination", () => {
    const receipts = [
      receipt("dry", { dryRun: true }),
      receipt("failed", { status: "failed", verifiedAt: null }),
      receipt("unverified", { verifiedAt: "2026-06-01T04:00:00.000Z" }),
      receipt("success", { requestedAt: "2026-06-01T02:30:00.000Z" }),
      receipt("forward", { requestedAt: "2026-06-03T10:00:00.000Z" }),
      receipt("outside", { requestedAt: "2026-06-09T10:00:00.000Z" }),
    ];
    const exposure = summarizeActionExposure(
      receipts,
      "2026-06-01T03:00:00.000Z",
    );
    expect(exposure).toMatchObject({
      stratum: "acted_success",
      successfulVerifiedReceiptCount: 1,
      failedReceiptCount: 2,
      dryRunReceiptCount: 1,
      observationalOnly: true,
      causalEffectClaimed: false,
    });
    expect(
      selectForwardActionReceipts(receipts, "2026-06-01", 7).map(
        (row) => row.id,
      ),
    ).toEqual(["forward"]);
  });

  it("closes the 3d, 7d, and 14d windows without off-by-one overlap", () => {
    expect(
      ([3, 7, 14] as const).map((windowDays) =>
        outcomeWindowDates("2026-06-01", windowDays),
      ),
    ).toEqual([
      { start: "2026-06-02", end: "2026-06-04" },
      { start: "2026-06-02", end: "2026-06-08" },
      { start: "2026-06-02", end: "2026-06-15" },
    ]);
  });

  it("builds format-specific funnel baselines instead of reusing overall", () => {
    type FunnelContext = Parameters<typeof buildFunnelBaselines>[0][number];
    const context = (
      creativeFormat: "image" | "video",
      ctr: number,
      index: number,
    ) =>
      ({
        retained: { creativeFormat },
        window28: {
          spend: 100,
          impressions: 1_000,
          clicks: 100,
          linkClicks: 80,
          outboundClicks: 70,
          landingPageViews: 60,
          addToCart: 20,
          initiateCheckout: 10,
          leads: 0,
          messages: 0,
          thumbstop: 30,
          video25Rate: creativeFormat === "video" ? 50 : null,
          video50Rate: creativeFormat === "video" ? 30 : null,
          video75Rate: creativeFormat === "video" ? 20 : null,
          video100Rate: creativeFormat === "video" ? 10 : null,
          funnelObservedDays: 28,
          purchases: 5,
          revenue: 200,
          roas: 2,
          cpa: 20,
          ctr: ctr + index / 10_000,
          frequency: 1.5,
          activeDays: 28,
          firstDate: "2026-05-01",
          lastSpendDate: "2026-06-01",
        },
      }) as unknown as FunnelContext;
    const contexts = [
      ...Array.from({ length: 8 }, (_, index) => context("image", 0.1, index)),
      ...Array.from({ length: 8 }, (_, index) => context("video", 0.9, index)),
    ];
    const baselines = buildFunnelBaselines(contexts, 8);

    expect(Object.keys(baselines)).toEqual(["overall", "image", "video"]);
    expect(baselines.image.ctrP50).toBeLessThan(0.11);
    expect(baselines.video.ctrP50).toBeGreaterThan(0.89);
    expect(baselines.image.ctrP50).not.toBe(baselines.overall.ctrP50);
  });
});
