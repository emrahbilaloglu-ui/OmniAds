import { describe, expect, it } from "vitest";

import {
  buildCanonicalEvaluationProvenance,
  type BuildCanonicalEvaluationInput,
} from "../canonical-evaluation";
import { decideCreative } from "../engine";
import type { EngineV3Flags } from "../feature-flags";
import type {
  AdDecisionInput,
  CreativeInput,
  DecisionEvidenceWindow,
  DecisionOutput,
} from "../types";
import { observedConfigAuthority } from "./config-authority-fixture";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "./helpers";

/*
  ADR D107. The admitted window changes the reason text, so it is HASHED input
  on the native Ad path (`AD_DECISION_EVALUATION_CONTRACT_VERSION` `.v16`) —
  and only there: a legacy creative input's envelope must not gain the key.
*/

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
  envDefaults: { enabled: true, surfaceVisible: true, shadowOnly: false },
};

const RUN: DecisionEvidenceWindow = {
  startDate: "2026-09-09",
  endDate: "2026-09-23",
  calendarDaySpan: 15,
  observedDayCount: 15,
  economicDayCount: 15,
  bridgedUnresolvedDayCount: 1,
  lookbackStartDate: "2026-08-28",
  lookbackEndDate: "2026-09-24",
  recentStartDate: "2026-09-18",
  recentEndDate: "2026-09-23",
};

function adInput(decisionWindow: DecisionEvidenceWindow | null): AdDecisionInput {
  const creative = makeCreativeInput();
  return {
    ...creative,
    decisionWindow,
    decisionEntityType: "ad",
    decisionEntityId: "ad-d107",
    adId: "ad-d107",
    providerAccountId: "act-1",
    providerAccountRefId: "00000000-0000-4000-8000-000000000001",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    adsetId: "adset-1",
    creativeId: "creative-1",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    customEventType: "PURCHASE",
    configAuthority: observedConfigAuthority(),
    metricEvidence: {
      sourceRowCount: 15,
      performanceMetricsObserved: true,
      eventMetricsObserved: true,
    },
    statusEvidence: null,
    creativeEvidence: null,
  } as unknown as AdDecisionInput;
}

function inputHash(creativeInput: CreativeInput | AdDecisionInput): string {
  const accountProfile = makeAccountDecisionProfile({ asOfDate: "2026-09-24" });
  return buildCanonicalEvaluationProvenance({
    engineVersion: "v3-test",
    accountProfile,
    dataHealth: makeDataHealth(),
    flags,
    scope: accountProfile.scope,
    creativeInput,
    campaignContext: {
      mode: "legacy_labels",
      source: "none",
      campaignId: creativeInput.campaignId,
      kind: null,
      testDimension: null,
      contextTrust: "unknown",
      sourceRecordType: null,
      sourceRecordId: null,
      sourceAsOfDate: null,
      sourceUpdatedAt: null,
      sourceHash: null,
    },
    priorHysteresis: { source: "none" },
    decision: {
      creativeId: creativeInput.creativeId,
      creativeName: creativeInput.creativeName,
      label: "keep",
      reason: "fixed",
      confidence: 70,
      truthSource: "commercial_truth",
      effectiveTargetRoas: 2.2,
      ratioToTarget: 1.1,
      badges: [],
      engineVersion: "v3-test",
      generatedAt: "2026-09-24T03:00:00.000Z",
      ...("decisionEntityType" in creativeInput &&
      creativeInput.decisionEntityType === "ad"
        ? {
            decisionEntityType: "ad",
            decisionEntityId: creativeInput.decisionEntityId,
            adId: creativeInput.adId,
            providerAccountId: creativeInput.providerAccountId,
          }
        : {}),
    } as unknown as DecisionOutput,
    rawLabel: "keep",
    publishedLabel: "keep",
    hysteresisSuppressed: false,
  } as unknown as BuildCanonicalEvaluationInput).inputHash;
}

describe("the D107 admitted window in hashed identity", () => {
  it("moves the native Ad input hash with the window", () => {
    const none = inputHash(adInput(null));
    const run = inputHash(adInput(RUN));
    const otherRun = inputHash(
      adInput({ ...RUN, startDate: "2026-09-22", calendarDaySpan: 2 }),
    );
    expect(run).not.toBe(none);
    expect(otherRun).not.toBe(run);
  });

  it("leaves a legacy creative input's hash untouched", () => {
    const creative = makeCreativeInput();
    // A creative input never carries a window; the key must not appear, so a
    // stray field cannot move the creative identity either.
    expect(inputHash(creative)).toBe(
      inputHash({ ...creative, decisionWindow: RUN }),
    );
  });

  describe("the zero-recent-spend warning (ADR D107)", () => {
    const profile = makeAccountDecisionProfile();
    const base = {
      spend: 900,
      purchases: 12,
      purchaseValue: 2700,
      roas: 3,
      cpa: 75,
      recent7dSpend: 0,
      recent7dPurchases: 0,
      recent7dRoas: null,
      effectiveStatus: "ACTIVE" as const,
      dataFreshnessHours: 2,
    };
    const badgesFor = (
      overrides: Parameters<typeof makeCreativeInput>[0],
    ): string[] =>
      decideCreative(makeCreativeInput({ ...base, ...overrides }), profile)
        .badges.map((badge) => badge.type);
    /* Lookback 2026-08-28..2026-09-24, recent band 2026-09-18..2026-09-24. */
    const run = (
      endDate: string,
      recent: [string, string] | null,
    ): DecisionEvidenceWindow => ({
      ...RUN,
      startDate: "2026-08-28",
      endDate,
      calendarDaySpan: 1,
      recentStartDate: recent?.[0] ?? null,
      recentEndDate: recent?.[1] ?? null,
    });

    it("NEGATIVE: the run ends before the band and the ad spent inside it", () => {
      expect(
        badgesFor({
          recent7dSpend: null,
          lastSpendAt: "2026-09-22",
          decisionWindow: run("2026-09-15", null),
        }),
      ).not.toContain("delivery_limited");
    });

    it("NEGATIVE: the run touches the band only through a $0 late-attribution day", () => {
      // 2026-09-18 carried a late conversion and no spend; the spending days
      // after it did not resolve and are outside the run.
      expect(
        badgesFor({
          lastSpendAt: "2026-09-22",
          decisionWindow: run("2026-09-18", ["2026-09-18", "2026-09-18"]),
        }),
      ).not.toContain("delivery_limited");
    });

    it("POSITIVE: the ad's last spend day is before the band", () => {
      expect(
        badgesFor({
          recent7dSpend: null,
          lastSpendAt: "2026-09-15",
          decisionWindow: run("2026-09-15", null),
        }),
      ).toContain("delivery_limited");
      expect(
        badgesFor({
          lastSpendAt: "2026-09-16",
          decisionWindow: run("2026-09-18", ["2026-09-18", "2026-09-18"]),
        }),
      ).toContain("delivery_limited");
    });

    it("POSITIVE: the run covers the whole recent band with no spend in it", () => {
      expect(
        badgesFor({
          // No last-spend evidence at all: only the run's full coverage of
          // the band can make the zero known.
          lastSpendAt: null,
          decisionWindow: run("2026-09-24", ["2026-09-18", "2026-09-24"]),
        }),
      ).toContain("delivery_limited");
    });

    it("keeps the legacy behaviour for an input without a window", () => {
      expect(badgesFor({ recent7dSpend: null })).toContain("delivery_limited");
    });
  });
});
