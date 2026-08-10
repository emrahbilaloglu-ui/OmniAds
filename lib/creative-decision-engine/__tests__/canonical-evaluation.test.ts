import { describe, expect, it } from "vitest";

import type { EngineV3Flags } from "../feature-flags";
import {
  buildCanonicalEvaluationProvenance,
  CANONICAL_EVALUATION_CONTRACT_VERSION,
  canonicalSha256,
  stableCanonicalJson,
  type BuildCanonicalEvaluationInput,
  type NativeAdSoftOnlyDecisionProfile,
} from "../canonical-evaluation";
import type {
  AdDecisionInput,
  AdDecisionOutput,
  DecisionOutput,
} from "../types";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "./helpers";

const flags: EngineV3Flags = {
  businessId: "biz-1",
  enabled: true,
  surfaceVisible: true,
  shadowOnly: false,
  presetOverride: null,
  source: {
    enabled: "env",
    surfaceVisible: "env",
    shadowOnly: "env",
    presetOverride: null,
  },
  envDefaults: {
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
  },
};

function makeDecision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  const label = overrides.label ?? "keep";
  return {
    creativeId: "creative-1",
    creativeName: "Test Creative",
    label,
    reason: "Evidence remains inside the keep band.",
    confidence: 72,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 1.1,
    badges: [
      { type: "low_ctr", label: "Low CTR", severity: "info" },
      {
        type: "fatigue_watch",
        label: "Fatigue watch",
        severity: "warning",
      },
    ],
    metrics: {
      spend: 500,
      purchases: 8,
      roas: 3,
      recent7dRoas: 2.8,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-07-12T03:00:00.000Z",
    ...overrides,
    preAuthorityLabel: overrides.preAuthorityLabel ?? label,
    authorityBlocker: overrides.authorityBlocker ?? null,
  };
}

function makeEvaluation(
  overrides: Partial<BuildCanonicalEvaluationInput> = {},
): BuildCanonicalEvaluationInput {
  const accountProfile = makeAccountDecisionProfile({
    asOfDate: "2026-07-12",
  });
  const creativeInput = makeCreativeInput();
  const decision = makeDecision();
  return {
    engineVersion: "v3-test",
    accountProfile,
    dataHealth: makeDataHealth(),
    flags,
    scope: accountProfile.scope,
    creativeInput,
    campaignContext: {
      mode: "automatic",
      source: "system_inferred",
      campaignId: creativeInput.campaignId,
      kind: "main",
      testDimension: null,
      contextTrust: "high",
      sourceRecordType: "engine_v3_campaign_context_daily",
      sourceRecordId: "ctx-1",
      sourceAsOfDate: "2026-07-12",
      sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    priorHysteresis: {
      source: "persisted_evaluation",
      sourceEvaluationId: "evaluation-previous",
      sourceSnapshotId: "snapshot-previous",
      sourceEngineVersion: "v3-test",
      sourceAsOfDate: "2026-07-11",
      sourceInputHash: "b".repeat(64),
      sourceDecisionHash: "c".repeat(64),
      publishedLabel: "keep",
      rawLabel: "keep",
    },
    decision,
    rawLabel: "keep",
    publishedLabel: "keep",
    hysteresisSuppressed: false,
    evaluatedAt: "2026-07-12T03:00:01.000Z",
    ...overrides,
  };
}

describe("stableCanonicalJson", () => {
  it("is equivalent across object key order and emits sorted keys", () => {
    const first = {
      z: 3,
      nested: { beta: 2, alpha: 1 },
      a: true,
    };
    const second = {
      a: true,
      nested: { alpha: 1, beta: 2 },
      z: 3,
    };

    expect(stableCanonicalJson(first)).toBe(stableCanonicalJson(second));
    expect(stableCanonicalJson(first)).toBe(
      '{"a":true,"nested":{"alpha":1,"beta":2},"z":3}',
    );
    expect(canonicalSha256(first)).toBe(canonicalSha256(second));
  });

  it("preserves array order", () => {
    expect(canonicalSha256({ values: ["a", "b"] })).not.toBe(
      canonicalSha256({ values: ["b", "a"] }),
    );
  });

  it("rejects invalid numbers, cycles, and non-JSON objects", () => {
    expect(() => stableCanonicalJson({ value: Number.NaN })).toThrow(
      /non-finite number/,
    );
    expect(() =>
      stableCanonicalJson({ value: Number.POSITIVE_INFINITY }),
    ).toThrow(/non-finite number/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableCanonicalJson(cyclic)).toThrow(/cyclic reference/);
    expect(() => stableCanonicalJson({ value: new Date() })).toThrow(
      /non-plain JSON object/,
    );
  });
});

describe("buildCanonicalEvaluationProvenance", () => {
  it("builds a versioned SHA-256 chain and normalizes optional fields", () => {
    const result = buildCanonicalEvaluationProvenance(makeEvaluation());

    expect(result.contractVersion).toBe(CANONICAL_EVALUATION_CONTRACT_VERSION);
    expect(result.contextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.decisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inputPayload.contextHash).toBe(result.contextHash);
    expect(result.decisionPayload.inputHash).toBe(result.inputHash);
    expect(result.inputPayload.creativeInput.firstSeenAt).toBeNull();
    expect(result.contextPayload.scope.fallbackReason).toBeNull();
    expect(result.decisionPayload.decision).toMatchObject({
      preAuthorityLabel: "keep",
      authorityBlocker: null,
    });
  });

  it("changes the input and downstream decision hashes for one input field", () => {
    const baseline = buildCanonicalEvaluationProvenance(makeEvaluation());
    const changed = buildCanonicalEvaluationProvenance(
      makeEvaluation({ creativeInput: makeCreativeInput({ spend: 501 }) }),
    );

    expect(changed.contextHash).toBe(baseline.contextHash);
    expect(changed.inputHash).not.toBe(baseline.inputHash);
    expect(changed.decisionHash).not.toBe(baseline.decisionHash);
  });

  it("binds expanded economic Cut authority into the canonical profile hash", () => {
    const baselineInput = makeEvaluation();
    const profile = {
      ...(baselineInput.accountProfile as ReturnType<
        typeof makeAccountDecisionProfile
      >),
      expandedEconomicCutAuthority: {
        eligible: false,
        authorityBasis: null,
        reason: "economic_spend_unit_authority_missing",
      } as const,
    };
    const baseline = buildCanonicalEvaluationProvenance(baselineInput);
    const changed = buildCanonicalEvaluationProvenance(
      makeEvaluation({ accountProfile: profile }),
    );

    expect(changed.contextHash).not.toBe(baseline.contextHash);
    expect(changed.contextPayload.accountProfile).toMatchObject({
      expandedEconomicCutAuthority: {
        eligible: false,
        authorityBasis: null,
        reason: "economic_spend_unit_authority_missing",
      },
    });
  });

  it("treats ordered evidence as decision evidence", () => {
    const baseline = buildCanonicalEvaluationProvenance(makeEvaluation());
    const reversedDecision = makeDecision({
      badges: [...makeDecision().badges].reverse(),
    });
    const changed = buildCanonicalEvaluationProvenance(
      makeEvaluation({ decision: reversedDecision }),
    );

    expect(changed.decisionHash).not.toBe(baseline.decisionHash);
  });

  it("excludes evaluatedAt and generatedAt from every deterministic hash", () => {
    const baseline = buildCanonicalEvaluationProvenance(makeEvaluation());
    const changed = buildCanonicalEvaluationProvenance(
      makeEvaluation({
        evaluatedAt: "2026-07-12T04:00:01.000Z",
        decision: makeDecision({ generatedAt: "2026-07-12T04:00:00.000Z" }),
      }),
    );

    expect(changed.contextHash).toBe(baseline.contextHash);
    expect(changed.inputHash).toBe(baseline.inputHash);
    expect(changed.decisionHash).toBe(baseline.decisionHash);
    expect(changed.volatile).not.toEqual(baseline.volatile);
    expect(changed.decisionJson).not.toContain("generatedAt");
    expect(changed.decisionJson).not.toContain("evaluatedAt");
  });

  it("never persists free-text data-health notes", () => {
    const secret = "password=do-not-persist";
    const result = buildCanonicalEvaluationProvenance(
      makeEvaluation({
        dataHealth: makeDataHealth({
          calibration: {
            asOfDate: null,
            computedAt: null,
            sourceFreshnessHours: null,
            staleTier: "disabled",
            fallbackMode: "insufficient",
            note: `Calibration unavailable; runtime SQL failed (${secret})`,
          },
        }),
      }),
    );

    expect(result.contextJson).not.toContain(secret);
    expect(result.contextJson).not.toContain("Calibration unavailable");
    expect(result.contextPayload.dataHealth.calibration).toMatchObject({
      noteCode: "runtime_sql_failed",
    });
    expect(result.contextJson).not.toContain('"note":');
  });

  it("includes raw, published, and suppression state in the decision hash", () => {
    const baseline = buildCanonicalEvaluationProvenance(makeEvaluation());
    const rawChanged = buildCanonicalEvaluationProvenance(
      makeEvaluation({ rawLabel: "cut" }),
    );
    const suppressionChanged = buildCanonicalEvaluationProvenance(
      makeEvaluation({ hysteresisSuppressed: true }),
    );
    const publishedChanged = buildCanonicalEvaluationProvenance(
      makeEvaluation({
        decision: makeDecision({ label: "test_more" }),
        publishedLabel: "test_more",
      }),
    );

    expect(rawChanged.decisionHash).not.toBe(baseline.decisionHash);
    expect(suppressionChanged.decisionHash).not.toBe(baseline.decisionHash);
    expect(publishedChanged.decisionHash).not.toBe(baseline.decisionHash);
  });

  it("binds authority provenance into the decision hash", () => {
    const baseline = buildCanonicalEvaluationProvenance(makeEvaluation());
    const changed = buildCanonicalEvaluationProvenance(
      makeEvaluation({
        decision: makeDecision({
          label: "keep",
          preAuthorityLabel: "scale",
          authorityBlocker: "source_freshness",
          blockedActionType: "scale",
        }),
      }),
    );

    expect(changed.decisionHash).not.toBe(baseline.decisionHash);
    expect(changed.decisionPayload.decision).toMatchObject({
      preAuthorityLabel: "scale",
      authorityBlocker: "source_freshness",
      blockedActionType: "scale",
    });
  });

  it("rejects invalid numbers inside typed decision inputs", () => {
    expect(() =>
      buildCanonicalEvaluationProvenance(
        makeEvaluation({
          creativeInput: makeCreativeInput({ spend: Infinity }),
        }),
      ),
    ).toThrow(/non-finite number/);
  });

  it("canonically binds native ad identity, nullable grouping, metric evidence and prior lineage", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: "2026-07-12" });
    const creative = makeCreativeInput({
      businessId: "biz-1",
      creativeId: "legacy-placeholder",
      campaignId: "campaign-1",
    });
    const ad: AdDecisionInput = {
      ...creative,
      decisionEntityType: "ad",
      decisionEntityId: "ad-1",
      adId: "ad-1",
      providerAccountRefId: "00000000-0000-4000-8000-000000000111",
      providerAccountId: "act-1",
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "USD",
      adsetId: "adset-1",
      creativeId: null,
      optimizationGoal: "PURCHASE",
      customEventType: "PURCHASE",
      metricEvidence: {
        sourceRowCount: 0,
        performanceMetricsObserved: false,
        eventMetricsObserved: false,
      },
      statusEvidence: {
        source: "entity_state_history",
        sourceRecordId: "state-1",
        observedAt: "2026-07-12T02:00:00.000Z",
        capturedAt: "2026-07-12T02:01:00.000Z",
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
    };
    const adDecision: AdDecisionOutput = {
      ...makeDecision({
        creativeId: "legacy-placeholder",
        engineVersion: "v3-ad-test",
      }),
      decisionEntityType: "ad",
      decisionEntityId: "ad-1",
      adId: "ad-1",
      providerAccountId: "act-1",
      creativeId: null,
    };

    const result = buildCanonicalEvaluationProvenance({
      engineVersion: "v3-ad-test",
      accountProfile: profile,
      dataHealth: makeDataHealth(),
      flags,
      scope: profile.scope,
      creativeInput: ad,
      campaignContext: {
        mode: "legacy_labels",
        source: "legacy_label",
        campaignId: "campaign-1",
        kind: "main",
        testDimension: null,
        contextTrust: null,
      },
      priorHysteresis: {
        source: "persisted_evaluation",
        sourceBusinessId: "biz-1",
        sourceProviderAccountId: "act-1",
        sourceDecisionEntityType: "ad",
        sourceDecisionEntityId: "ad-1",
        sourceEvaluationId: "evaluation-1",
        sourceSnapshotId: "snapshot-1",
        sourceEngineVersion: "v3-ad-test",
        sourceAsOfDate: "2026-07-11",
        sourceInputHash: "1".repeat(64),
        sourceDecisionHash: "2".repeat(64),
        publishedLabel: "keep",
        rawLabel: "keep",
      },
      decision: adDecision,
      rawLabel: "keep",
      publishedLabel: "keep",
      hysteresisSuppressed: false,
    });

    expect(result.inputPayload.creativeInput).toMatchObject({
      decisionEntityType: "ad",
      decisionEntityId: "ad-1",
      adId: "ad-1",
      providerAccountId: "act-1",
      creativeId: null,
      metricEvidence: {
        sourceRowCount: 0,
        performanceMetricsObserved: false,
      },
    });
    expect(result.inputPayload.priorHysteresis).toMatchObject({
      sourceProviderAccountId: "act-1",
      sourceDecisionEntityId: "ad-1",
      sourceEvaluationId: "evaluation-1",
    });
    expect(result.decisionPayload.decision).toMatchObject({
      decisionEntityType: "ad",
      decisionEntityId: "ad-1",
      creativeId: null,
    });
  });

  it("serializes a soft-only native profile without synthetic calibration thresholds", () => {
    const creativeInput = makeCreativeInput({ businessId: "biz-1" });
    const profile: NativeAdSoftOnlyDecisionProfile = {
      profileType: "native_ad_soft_only",
      businessId: "biz-1",
      asOfDate: "2026-07-12",
      channel: "meta",
      objectiveFamily: "sales",
      scope: { type: "account", id: "act-1" },
      blocker: "native_ad_profile_unready:native_calibration_missing",
      calibrationSource: null,
      selectedCell: null,
      hardActionEligibility: {
        scale: false,
        cut: false,
        refresh: false,
        reason: "hard_actions_blocked:native_calibration_missing",
      },
    };
    const result = buildCanonicalEvaluationProvenance({
      engineVersion: "v3-ad-test",
      accountProfile: profile,
      dataHealth: makeDataHealth(),
      flags,
      scope: profile.scope,
      creativeInput,
      campaignContext: {
        mode: "unknown",
        source: "unknown",
        campaignId: creativeInput.campaignId,
        kind: null,
        testDimension: null,
        contextTrust: null,
      },
      decision: makeDecision({ engineVersion: "v3-ad-test" }),
      rawLabel: "keep",
      publishedLabel: "keep",
      hysteresisSuppressed: false,
    });

    expect(result.contextPayload.accountProfile).toMatchObject({
      profileType: "native_ad_soft_only",
      blocker: "native_ad_profile_unready:native_calibration_missing",
      hardActionEligibility: {
        scale: false,
        cut: false,
        refresh: false,
      },
    });
    expect(result.contextPayload.accountProfile).not.toHaveProperty(
      "thresholds",
    );
    expect(result.contextPayload.accountProfile).not.toHaveProperty(
      "accountBaselines",
    );
  });
});
