import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyLabelHysteresis,
  type PreviousPublishedLabel,
} from "../decision-stability";
import { decideCreative } from "..";
import { applyCreativeCampaignLabelGuard } from "../campaign-label-guard";
import { STALE_CONFIDENCE_CAP } from "../config-values";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  AccountFunnelCalibration,
  CalibrationCampaignKind,
  CreativeInput,
  DecisionLabel,
  DecisionOutput,
  EngineThresholdSet,
  HardActionEligibility,
  SpendUnitProfile,
} from "../types";
import canonicalFixture from "./fixtures/golden-cases.json";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeAccountFunnelCalibration,
  makeCreativeInput,
} from "./helpers";

type GoldenCase = {
  caseId: string;
  inputSummary: string;
  expectedPrimaryDecision: string;
  expectedBuyerAction: string;
  expectedActionability: string;
  expectedProblemClass: string;
  expectedPriorityBand: string;
  expectedConfidenceBand: string;
  expectedTopReasonTag: string;
  expectedMaturity: string;
  expectedSafeFallbackIfDataMissing: string;
};

const GOLDEN_CASES_PATH = "docs/creative-decision-center/GOLDEN_CASES.md";

const PRIMARY_DECISIONS = [
  "Diagnose",
  "Test More",
  "Cut",
  "Scale",
  "Refresh",
  "Protect",
  "Keep",
  "Same as canonical",
] as const;

const BUYER_ACTIONS = [
  "fix_delivery",
  "fix_policy",
  "watch_launch",
  "cut",
  "scale",
  "refresh",
  "test_more",
  "diagnose_data",
  "protect",
  "review",
  "same_as_canonical",
  "promote_to_main",
  "scale_budget",
  "controlled_scale",
] as const;

const ACTIONABILITIES = ["diagnose", "review_only"] as const;
const PROBLEM_CLASSES = [
  "delivery",
  "campaign_context",
  "policy",
  "launch_monitoring",
  "performance",
  "fatigue",
  "insufficient_signal",
  "data_quality",
] as const;
const PRIORITY_BANDS = ["high", "medium", "low"] as const;
const CONFIDENCE_BANDS = ["high", "medium", "low"] as const;
const MATURITY_BANDS = [
  "too_early",
  "learning",
  "actionable",
  "mature",
] as const;
const SAFE_FALLBACKS = [
  "diagnose_data",
  "disable_aggregate",
  "canonical_all_fallback",
] as const;

const EXECUTABLE_PRIMARY_CASE_IDS = new Set([
  "GC-010",
  "GC-011",
  "GC-012",
  "GC-038",
  "GC-039",
  "GC-040",
  "GC-041",
  "GC-042",
  "GC-043",
  "GC-044a",
  "GC-044b",
  "GC-045",
  "GC-046",
  "GC-047",
  "GC-048",
  "GC-049",
  "GC-050",
  "GC-051",
  "GC-052",
  "GC-053",
  "GC-057",
  "GC-058",
  "GC-059",
  "GC-060",
  "GC-061",
  "GC-062",
  "GC-063",
  "GC-064",
  "GC-065",
  "GC-066",
  "GC-067",
  "GC-068",
  "GC-069",
  "GC-070",
  "GC-071",
  "GC-077",
  "GC-078",
  "GC-079",
  "GC-080",
  "GC-081",
  "GC-082",
]);

function parseCanonicalGoldenCases(): GoldenCase[] {
  const markdown = readFileSync(GOLDEN_CASES_PATH, "utf8");
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("| GC-"))
    .map((line) => {
      const [
        caseId,
        inputSummary,
        expectedPrimaryDecision,
        expectedBuyerAction,
        expectedActionability,
        expectedProblemClass,
        expectedPriorityBand,
        expectedConfidenceBand,
        expectedTopReasonTag,
        expectedMaturity,
        expectedSafeFallbackIfDataMissing,
      ] = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());

      return {
        caseId,
        inputSummary,
        expectedPrimaryDecision,
        expectedBuyerAction,
        expectedActionability,
        expectedProblemClass,
        expectedPriorityBand,
        expectedConfidenceBand,
        expectedTopReasonTag,
        expectedMaturity,
        expectedSafeFallbackIfDataMissing,
      };
    });
}

function emptyByKind<T>(): Record<CalibrationCampaignKind, T | null> {
  return {
    all: null,
    main: null,
    test: null,
    mixed: null,
  };
}

function kindAwareProfile(input: {
  base: AccountDecisionProfile;
  kind: Exclude<CalibrationCampaignKind, "all">;
  calibration?: Partial<AccountCalibration>;
  thresholds?: Partial<EngineThresholdSet>;
  hardActionEligibility?: HardActionEligibility;
}): AccountDecisionProfile {
  const calibration: AccountCalibration = {
    ...input.base.accountBaselines,
    campaignKind: input.kind,
    matureCreativeCount: 35,
    accountCpaP50: 58,
    accountCpaSampleCount: 24,
    metaAttributedAovMean90d: 50,
    metaAttributedAovPurchaseCount90d: 42,
    matureSpendP50: 300,
    winnerPurchaseP50: 4,
    roasRatioP10: 0.4,
    roasRatioP25: 0.7,
    refreshRatioP10: 0.82,
    ...input.calibration,
  };
  const accountBaselinesByKind = emptyByKind<AccountCalibration>();
  const spendUnitByKind = emptyByKind<SpendUnitProfile>();
  const thresholdsByKind = emptyByKind<EngineThresholdSet>();
  const hardActionEligibilityByKind = emptyByKind<HardActionEligibility>();
  const funnelCalibrationByKind = emptyByKind<AccountFunnelCalibration>();
  const baseSpendUnitProfile: SpendUnitProfile = {
    spendUnit: input.base.spendUnit,
    spendUnitSource: input.base.spendUnitSource,
    spendUnitConfidence: input.base.spendUnitConfidence,
    spendUnitEvidence: input.base.spendUnitEvidence,
    hardEligibleByDefault: true,
  };

  accountBaselinesByKind.all = input.base.accountBaselines;
  accountBaselinesByKind[input.kind] = calibration;
  spendUnitByKind.all = baseSpendUnitProfile;
  spendUnitByKind[input.kind] = {
    ...baseSpendUnitProfile,
    spendUnitEvidence: {
      ...input.base.spendUnitEvidence,
      accountCpaP50: calibration.accountCpaP50,
      accountCpaSampleCount: calibration.accountCpaSampleCount,
    },
  };
  thresholdsByKind.all = input.base.thresholds;
  thresholdsByKind[input.kind] = {
    ...input.base.thresholds,
    scaleMinPurchases: 4,
    bottomQuartileRatio: calibration.roasRatioP25,
    severeLoserRatio: calibration.roasRatioP10,
    ...input.thresholds,
  };
  hardActionEligibilityByKind.all = input.base.hardActionEligibility;
  hardActionEligibilityByKind[input.kind] =
    input.hardActionEligibility ?? input.base.hardActionEligibility;
  funnelCalibrationByKind.all = input.base.funnelCalibration;
  funnelCalibrationByKind[input.kind] = makeAccountFunnelCalibration({
    campaignKind: input.kind,
  });

  return {
    ...input.base,
    accountBaselinesByKind,
    spendUnitByKind,
    thresholdsByKind,
    hardActionEligibilityByKind,
    funnelCalibrationByKind,
  };
}

function wouldRefreshInput(
  overrides: Partial<CreativeInput> = {},
): CreativeInput {
  return makeCreativeInput({
    spend: 600,
    purchases: 6,
    roas: 1.65,
    recent7dRoas: 1,
    recent7dSpend: 80,
    fatigueStatus: "fatigued",
    linkClicks: 400,
    landingPageViews: 320,
    addToCart: 50,
    initiateCheckout: 25,
    ...overrides,
  });
}

function unknownFunnelIssueInput(
  overrides: Partial<CreativeInput> = {},
): CreativeInput {
  return makeCreativeInput({
    spend: 500,
    purchases: 8,
    roas: 3,
    recent7dRoas: 2.8,
    dataFreshnessHours: null,
    linkClicks: 1_000,
    landingPageViews: 200,
    addToCart: 10,
    initiateCheckout: 5,
    ctr: 1.5,
    thumbstop: 30,
    ...overrides,
  });
}

function severeLoserInput(
  overrides: Partial<CreativeInput> = {},
): CreativeInput {
  return makeCreativeInput({
    targetRoas: 2.5,
    spend: 620,
    purchases: 1,
    roas: 0.27,
    recent7dRoas: 0.4,
    linkClicks: 600,
    landingPageViews: 480,
    addToCart: 80,
    initiateCheckout: 40,
    ...overrides,
  });
}

function severeStopLossProfile(): AccountDecisionProfile {
  return makeAccountDecisionProfile({
    spendUnit: 36,
    thresholds: {
      commercialMaturitySpend: 72,
      hardCutSpend: 360,
      sustainedLoserSpend: 108,
      severeLoserRatio: 0.4,
    },
  });
}

function scaleReadyInput(
  overrides: Partial<CreativeInput> = {},
): CreativeInput {
  return makeCreativeInput({
    spend: 1000,
    purchases: 15,
    roas: 3.5,
    recent7dRoas: 3,
    ...overrides,
  });
}

function semanticDecision(output: DecisionOutput) {
  return {
    label: output.label,
    reason: output.reason,
    truthSource: output.truthSource,
    effectiveTargetRoas: output.effectiveTargetRoas,
    decisionKindSource: output.decisionKindSource,
    labelTransform: output.labelTransform ?? null,
  };
}

function expectPrimaryLabel(
  output: DecisionOutput,
  expected: DecisionLabel,
): void {
  expect(output.label).toBe(expected);
}

function decideGoldenPrimary(caseId: string): DecisionOutput {
  const baseProfile = makeAccountDecisionProfile();

  switch (caseId) {
    case "GC-010":
      return decideCreative(
        makeCreativeInput({
          spend: 1500,
          purchases: 5,
          roas: 0.8,
          recent7dRoas: 0.7,
          ctr: 0.5,
          thumbstop: 10,
        }),
        baseProfile,
      );
    case "GC-011":
    case "GC-053":
      return decideCreative(
        makeCreativeInput({
          spend: 1000,
          purchases: 15,
          roas: 3.5,
          recent7dRoas: 3,
        }),
        baseProfile,
      );
    case "GC-012":
      return decideCreative(wouldRefreshInput(), baseProfile);
    case "GC-038": {
      const canonicalScaleProfile = makeAccountDecisionProfile({
        thresholds: { scaleMinPurchases: 4 },
      });
      return decideCreative(
        makeCreativeInput({ campaignKind: "main" }),
        kindAwareProfile({
          base: canonicalScaleProfile,
          kind: "main",
          thresholds: { scaleMinPurchases: 10 },
        }),
      );
    }
    case "GC-039":
      return decideCreative(
        makeCreativeInput({ campaignKind: "test" }),
        kindAwareProfile({
          base: baseProfile,
          kind: "test",
          thresholds: { scaleMinPurchases: 4 },
        }),
      );
    case "GC-040":
      return decideCreative(
        makeCreativeInput({ campaignKind: "main" }),
        kindAwareProfile({
          base: baseProfile,
          kind: "main",
          calibration: { matureSpendP50: null },
          thresholds: { scaleMinPurchases: 4 },
        }),
      );
    case "GC-041":
      return decideCreative(
        makeCreativeInput({ campaignKind: "mixed" }),
        kindAwareProfile({
          base: baseProfile,
          kind: "main",
          thresholds: { scaleMinPurchases: 4 },
        }),
      );
    case "GC-042": {
      const raw = decideCreative(
        makeCreativeInput({ campaignKind: null }),
        makeAccountDecisionProfile({ thresholds: { scaleMinPurchases: 4 } }),
      );
      return applyCreativeCampaignLabelGuard({
        decision: raw,
        input: makeCreativeInput({ campaignKind: null }),
        campaignLabelsById: new Map(),
      });
    }
    case "GC-043":
      return decideCreative(
        wouldRefreshInput({ campaignKind: "test" }),
        kindAwareProfile({ base: baseProfile, kind: "test" }),
      );
    case "GC-044a":
      return decideCreative(
        wouldRefreshInput({ campaignKind: "test" }),
        kindAwareProfile({
          base: baseProfile,
          kind: "test",
          hardActionEligibility: {
            scale: true,
            cut: false,
            refresh: true,
            reason: "cut disabled for test cohort",
          },
        }),
      );
    case "GC-044b":
      return decideCreative(
        wouldRefreshInput({ campaignKind: "test" }),
        kindAwareProfile({
          base: baseProfile,
          kind: "test",
          hardActionEligibility: {
            scale: true,
            cut: true,
            refresh: false,
            reason: "refresh disabled for low-confidence baselines",
          },
        }),
      );
    case "GC-045":
      return decideCreative(
        wouldRefreshInput({ campaignKind: "main" }),
        kindAwareProfile({ base: baseProfile, kind: "main" }),
      );
    case "GC-046":
      return decideCreative(
        wouldRefreshInput({ campaignKind: "mixed" }),
        kindAwareProfile({ base: baseProfile, kind: "mixed" }),
      );
    case "GC-047": {
      const input = wouldRefreshInput({ campaignKind: null });
      return applyCreativeCampaignLabelGuard({
        decision: decideCreative(input, baseProfile),
        input,
        campaignLabelsById: new Map(),
      });
    }
    case "GC-048":
      return decideCreative(
        makeCreativeInput({
          spend: 300,
          purchases: 1,
          roas: 1.1,
          recent7dRoas: 1,
          ctr: 0.5,
          thumbstop: 10,
        }),
        baseProfile,
      );
    case "GC-049":
      return decideCreative(
        makeCreativeInput({
          spend: 300,
          purchases: 4,
          roas: 1.65,
          recent7dRoas: 1.6,
          linkClicks: 400,
          landingPageViews: 300,
          addToCart: 40,
          initiateCheckout: 20,
        }),
        baseProfile,
      );
    case "GC-050":
      return decideCreative(
        makeCreativeInput({
          spend: 500,
          purchases: 8,
          roas: 3,
          recent7dRoas: 2.8,
        }),
        baseProfile,
      );
    case "GC-051":
      return decideCreative(
        makeCreativeInput({
          spend: 600,
          purchases: 10,
          roas: 3.3,
          recent7dRoas: 2.8,
        }),
        makeAccountDecisionProfile({
          accountBaselines: makeAccountCalibration({
            matureCreativeCount: 12,
            winnerPurchaseP50: 3,
          }),
          quality: {
            commercialTruthReady: true,
            calibrationReady: false,
            metaAovQuality: "ready",
            thresholdQuality: "ready",
          },
          thresholds: { scaleMinPurchases: 3 },
        }),
      );
    case "GC-052":
      return decideCreative(
        makeCreativeInput({
          spend: 600,
          purchases: 10,
          roas: 3.3,
          recent7dRoas: 2.8,
        }),
        makeAccountDecisionProfile({
          accountBaselines: makeAccountCalibration({
            matureCreativeCount: 35,
            winnerPurchaseP50: null,
          }),
          thresholds: { scaleMinPurchases: 1 },
        }),
      );
    case "GC-057":
      return decideCreative(
        makeCreativeInput({
          targetRoas: 2.5,
          spend: 620,
          purchases: 1,
          roas: 0.27,
          recent7dRoas: 0.4,
          dataFreshnessHours: 57,
          linkClicks: 600,
          landingPageViews: 480,
          addToCart: 80,
          initiateCheckout: 40,
        }),
        makeAccountDecisionProfile({
          spendUnit: 36,
          thresholds: {
            commercialMaturitySpend: 72,
            hardCutSpend: 360,
            sustainedLoserSpend: 108,
            severeLoserRatio: 0.4,
          },
        }),
      );
    case "GC-058":
      return decideCreative(
        makeCreativeInput({
          targetRoas: 2.5,
          spend: 521,
          purchases: 2,
          roas: 0.85,
          recent7dRoas: 0.6,
          dataFreshnessHours: 57,
          linkClicks: 600,
          landingPageViews: 480,
          addToCart: 80,
          initiateCheckout: 40,
        }),
        makeAccountDecisionProfile({
          thresholds: {
            commercialMaturitySpend: 72,
            hardCutSpend: 600,
            sustainedLoserSpend: 108,
            severeLoserRatio: 0.4,
          },
        }),
      );
    case "GC-059":
      return decideCreative(
        makeCreativeInput({
          spend: 300,
          purchases: 1,
          roas: 1.1,
          recent7dRoas: 2.4,
          recent7dSpend: 80,
          ctr: 0.5,
          thumbstop: 10,
        }),
        baseProfile,
      );
    case "GC-060":
      return decideCreative(
        makeCreativeInput({
          spend: 1000,
          purchases: 15,
          roas: 3.5,
          recent7dRoas: 3,
          dataFreshnessHours: null,
        }),
        baseProfile,
      );
    case "GC-061":
      return decideCreative(unknownFunnelIssueInput(), baseProfile);
    case "GC-062":
      return decideCreative(
        makeCreativeInput({
          dataFreshnessHours: 35,
          spend24h: 0,
          impressions24h: 0,
        }),
        baseProfile,
      );
    case "GC-063":
      return decideCreative(
        severeLoserInput({
          dataFreshnessHours: 40,
          spend24h: 0,
          impressions24h: 0,
        }),
        severeStopLossProfile(),
      );
    case "GC-064":
      return decideCreative(
        severeLoserInput({ dataFreshnessHours: 49 }),
        severeStopLossProfile(),
      );
    case "GC-065":
      return decideCreative(
        severeLoserInput({ dataFreshnessHours: null }),
        severeStopLossProfile(),
      );
    case "GC-066":
      return decideCreative(
        scaleReadyInput({ dataFreshnessHours: 49 }),
        makeAccountDecisionProfile({ thresholds: { scaleMinPurchases: 4 } }),
      );
    case "GC-067":
      return decideCreative(
        scaleReadyInput({ dataFreshnessHours: null }),
        makeAccountDecisionProfile({ thresholds: { scaleMinPurchases: 4 } }),
      );
    case "GC-068":
      return decideCreative(unknownFunnelIssueInput(), baseProfile);
    case "GC-069":
      return decideCreative(
        makeCreativeInput({
          spend: 300,
          purchases: 1,
          roas: 1.1,
          recent7dRoas: 2.4,
          recent7dSpend: 80,
          ctr: 0.5,
          thumbstop: 10,
        }),
        baseProfile,
      );
    case "GC-070":
      return decideCreative(
        makeCreativeInput({
          spend: 300,
          purchases: 1,
          roas: 1.1,
          recent7dRoas: 2.4,
          recent7dSpend: 40,
          ctr: 0.5,
          thumbstop: 10,
        }),
        baseProfile,
      );
    case "GC-071":
      return decideCreative(
        makeCreativeInput({
          spend: 300,
          purchases: 1,
          roas: 1.1,
          recent7dRoas: 2.2,
          recent7dSpend: 80,
          ctr: 0.5,
          thumbstop: 10,
        }),
        baseProfile,
      );
    case "GC-077":
      return decideCreative(
        scaleReadyInput({ commercialTargetFreshness: "fresh" }),
        baseProfile,
      );
    case "GC-078":
      return decideCreative(
        scaleReadyInput({ commercialTargetFreshness: "stale" }),
        makeAccountDecisionProfile({
          quality: {
            commercialTruthReady: true,
            commercialTruthFreshness: "stale",
            calibrationReady: true,
            metaAovQuality: "ready",
            thresholdQuality: "ready",
          },
        }),
      );
    case "GC-079":
      return decideCreative(
        scaleReadyInput({
          commercialTargetFreshness: "unknown",
        }),
        makeAccountDecisionProfile({
          hardActionEligibility: {
            scale: false,
            cut: false,
            refresh: false,
            reason: "commercial_truth_stale",
          },
          quality: {
            commercialTruthReady: false,
            commercialTruthFreshness: "unknown",
            calibrationReady: true,
            metaAovQuality: "ready",
            thresholdQuality: "ready",
          },
        }),
      );
    case "GC-080": {
      const profile = makeAccountDecisionProfile({
        thresholds: { bottomQuartileRatio: 0.9 },
      });
      return decideCreative(
        makeCreativeInput({
          spend: 1500,
          purchases: 12,
          roas: 1.6,
          recent7dRoas: 1.6,
          targetRoas: 2,
          breakevenRoas: 1.4,
        }),
        {
          ...profile,
          spendUnitEvidence: {
            ...profile.spendUnitEvidence,
            targetRoas: 2,
            breakEvenRoas: 1.4,
          },
        },
      );
    }
    case "GC-081": {
      const profile = makeAccountDecisionProfile({
        thresholds: { bottomQuartileRatio: 0.52 },
      });
      return decideCreative(
        makeCreativeInput({
          spend: 1500,
          purchases: 12,
          roas: 1.2,
          recent7dRoas: 1.2,
          targetRoas: 2,
          breakevenRoas: 1.56,
        }),
        {
          ...profile,
          spendUnitEvidence: {
            ...profile.spendUnitEvidence,
            targetRoas: 2,
            breakEvenRoas: 1.56,
          },
        },
      );
    }
    case "GC-082": {
      const profile = makeAccountDecisionProfile();
      return decideCreative(
        makeCreativeInput({
          spend: 500,
          purchases: 4,
          purchaseValue: 400,
          roas: 0.8,
          cpa: 125,
          recent7dSpend: 120,
          recent7dRoas: 0.8,
          targetRoas: 2,
          breakevenRoas: 1.5,
          commercialTargetFreshness: "stale",
          linkClicks: 200,
          landingPageViews: 180,
          addToCart: 40,
          initiateCheckout: 16,
        }),
        {
          ...profile,
          quality: {
            ...profile.quality,
            commercialTruthFreshness: "stale",
          },
          spendUnitEvidence: {
            ...profile.spendUnitEvidence,
            targetRoas: 2,
            breakEvenRoas: 1.5,
          },
        },
      );
    }
    default:
      throw new Error(`Golden case ${caseId} is not executable in active V3.`);
  }
}

function pendingReason(item: GoldenCase): string {
  if (item.expectedSafeFallbackIfDataMissing === "disable_aggregate") {
    return "aggregate decision builder is not active in V3 row resolver";
  }
  if (
    ["fix_delivery", "fix_policy", "watch_launch"].includes(
      item.expectedBuyerAction,
    )
  ) {
    return "V2.1 data-readiness fields are not wired into active V3 resolver";
  }
  if (
    ["protect", "review", "same_as_canonical"].includes(
      item.expectedBuyerAction,
    )
  ) {
    return "buyerAction adapter contract is not active yet";
  }
  if (
    ["promote_to_main", "scale_budget", "controlled_scale"].includes(
      item.expectedBuyerAction,
    )
  ) {
    return "campaign-kind-aware execution CTA belongs to the briefing adapter";
  }
  return "golden case has no active V3 fixture yet";
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry) && !/\.test\./.test(entry)
      ? [path]
      : [];
  });
}

const fixtureCases = canonicalFixture as GoldenCase[];
const executableCases = fixtureCases.filter((item) =>
  EXECUTABLE_PRIMARY_CASE_IDS.has(item.caseId),
);
const pendingCases = fixtureCases.filter(
  (item) => !EXECUTABLE_PRIMARY_CASE_IDS.has(item.caseId),
);

describe("Creative Decision Center golden cases", () => {
  it("keeps the executable fixture in lockstep with GOLDEN_CASES.md", () => {
    expect(fixtureCases).toEqual(parseCanonicalGoldenCases());
    expect(fixtureCases).toHaveLength(78);
  });

  it("asserts the full contract surface for every canonical case", () => {
    const caseIds = new Set<string>();

    for (const item of fixtureCases) {
      expect(item.caseId).toMatch(/^GC-\d{3}[ab]?$/);
      expect(caseIds.has(item.caseId)).toBe(false);
      caseIds.add(item.caseId);
      expect(item.inputSummary.length).toBeGreaterThan(0);
      expect(PRIMARY_DECISIONS).toContain(
        item.expectedPrimaryDecision as never,
      );
      expect(BUYER_ACTIONS).toContain(item.expectedBuyerAction as never);
      expect(ACTIONABILITIES).toContain(item.expectedActionability as never);
      expect(PROBLEM_CLASSES).toContain(item.expectedProblemClass as never);
      expect(PRIORITY_BANDS).toContain(item.expectedPriorityBand as never);
      expect(CONFIDENCE_BANDS).toContain(item.expectedConfidenceBand as never);
      expect(item.expectedTopReasonTag.length).toBeGreaterThan(0);
      expect(MATURITY_BANDS).toContain(item.expectedMaturity as never);
      expect(SAFE_FALLBACKS).toContain(
        item.expectedSafeFallbackIfDataMissing as never,
      );
    }
  });

  it("marks every non-executable case with an explicit blocker reason", () => {
    expect(executableCases.map((item) => item.caseId)).toEqual([
      "GC-010",
      "GC-011",
      "GC-012",
      "GC-038",
      "GC-039",
      "GC-040",
      "GC-041",
      "GC-042",
      "GC-043",
      "GC-044a",
      "GC-044b",
      "GC-045",
      "GC-046",
      "GC-047",
      "GC-048",
      "GC-049",
      "GC-050",
      "GC-051",
      "GC-052",
      "GC-053",
      "GC-057",
      "GC-058",
      "GC-059",
      "GC-060",
      "GC-061",
      "GC-062",
      "GC-063",
      "GC-064",
      "GC-065",
      "GC-066",
      "GC-067",
      "GC-068",
      "GC-069",
      "GC-070",
      "GC-071",
      "GC-077",
      "GC-078",
      "GC-079",
      "GC-080",
      "GC-081",
      "GC-082",
    ]);

    expect(pendingCases).toHaveLength(37);
    for (const item of pendingCases) {
      expect(pendingReason(item), item.caseId).not.toMatch(
        /undefined|unknown/i,
      );
    }
  });

  it.each(executableCases)(
    "$caseId locks the active V3 primary decision without buyerAction mapping",
    (item) => {
      const output = decideGoldenPrimary(item.caseId);
      const expectedLabel =
        item.expectedPrimaryDecision === "Test More"
          ? "test_more"
          : item.expectedPrimaryDecision === "Same as canonical"
            ? "keep"
            : item.expectedPrimaryDecision.toLowerCase();

      expectPrimaryLabel(output, expectedLabel as DecisionLabel);
    },
  );

  it("locks phase-end guardrail semantics for recovery and freshness golden cases", () => {
    const recovery = decideGoldenPrimary("GC-059");
    expect(recovery.label).toBe("keep");
    expect(recovery.reason).toContain("[recovery hold]");
    expect(recovery.reason).toContain(
      "do not hard cut while recovery is holding",
    );
    expect(recovery.badges.map((badge) => badge.type)).toContain(
      "weak_performance",
    );

    const unknownScale = decideGoldenPrimary("GC-060");
    expect(unknownScale.label).toBe("keep");
    expect(unknownScale.reason).toContain(
      "scale requires fresh recent performance proof",
    );
    expect(unknownScale.confidence).toBeLessThanOrEqual(STALE_CONFIDENCE_CAP);
    expect(unknownScale.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining(["unknown_freshness", "scale_readiness_blocked"]),
    );
    expect(unknownScale.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "scale_recent_freshness",
          status: "missing",
        }),
      ]),
    );

    const unknownFunnel = decideGoldenPrimary("GC-061");
    expect(unknownFunnel.label).toBe("keep");
    expect(unknownFunnel.reason).not.toContain("Landing page issue");
    expect(unknownFunnel.confidence).toBeLessThanOrEqual(STALE_CONFIDENCE_CAP);
    expect(unknownFunnel.badges.map((badge) => badge.type)).toContain(
      "unknown_freshness",
    );

    const freshFunnel = decideCreative(
      unknownFunnelIssueInput({ dataFreshnessHours: 6 }),
      makeAccountDecisionProfile(),
    );
    expect(freshFunnel.label).toBe("keep");
    expect(freshFunnel.reason).toContain("near scale");
    expect(freshFunnel.badges.map((badge) => badge.type)).toContain(
      "landing_page_issue",
    );

    const freshBoundaryNoDelivery = decideGoldenPrimary("GC-062");
    expect(freshBoundaryNoDelivery.label).toBe("diagnose");
    expect(freshBoundaryNoDelivery.badges.map((badge) => badge.type)).toContain(
      "delivery_no_spend_24h",
    );

    const midFreshnessSevereCut = decideGoldenPrimary("GC-063");
    expect(midFreshnessSevereCut.label).toBe("cut");
    expect(midFreshnessSevereCut.confidence).toBeGreaterThan(
      STALE_CONFIDENCE_CAP,
    );
    expect(midFreshnessSevereCut.badges.map((badge) => badge.type)).not.toEqual(
      expect.arrayContaining([
        "delivery_no_spend_24h",
        "stale_evidence",
        "unknown_freshness",
      ]),
    );

    const staleSevereCut = decideGoldenPrimary("GC-064");
    expect(staleSevereCut.label).toBe("cut");
    expect(staleSevereCut.confidence).toBeLessThanOrEqual(STALE_CONFIDENCE_CAP);
    expect(staleSevereCut.badges.map((badge) => badge.type)).toContain(
      "stale_evidence",
    );

    const unknownFreshnessSevereCut = decideGoldenPrimary("GC-065");
    expect(unknownFreshnessSevereCut.label).toBe("cut");
    expect(unknownFreshnessSevereCut.confidence).toBeLessThanOrEqual(
      STALE_CONFIDENCE_CAP,
    );
    expect(
      unknownFreshnessSevereCut.badges.map((badge) => badge.type),
    ).toContain("unknown_freshness");

    const staleScale = decideGoldenPrimary("GC-066");
    expect(staleScale.label).toBe("keep");
    expect(staleScale.confidence).toBeLessThanOrEqual(STALE_CONFIDENCE_CAP);
    expect(staleScale.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining(["stale_evidence", "scale_readiness_blocked"]),
    );

    const canonicalUnknownScale = decideGoldenPrimary("GC-067");
    expect(semanticDecision(canonicalUnknownScale)).toEqual(
      semanticDecision(unknownScale),
    );

    const canonicalUnknownFunnel = decideGoldenPrimary("GC-068");
    expect(semanticDecision(canonicalUnknownFunnel)).toEqual(
      semanticDecision(unknownFunnel),
    );

    const canonicalRecovery = decideGoldenPrimary("GC-069");
    expect(semanticDecision(canonicalRecovery)).toEqual(
      semanticDecision(recovery),
    );

    const belowSpendRecoveryBoundary = decideGoldenPrimary("GC-070");
    expect(belowSpendRecoveryBoundary.label).toBe("cut");
    expect(belowSpendRecoveryBoundary.reason).not.toContain("[recovery hold]");

    const exactTargetRecoveryBoundary = decideGoldenPrimary("GC-071");
    expect(exactTargetRecoveryBoundary.label).toBe("cut");
    expect(exactTargetRecoveryBoundary.reason).not.toContain("[recovery hold]");

    const freshCommercialTruth = decideGoldenPrimary("GC-077");
    expect(freshCommercialTruth.label).toBe("scale");
    expect(freshCommercialTruth.truthSource).toBe("commercial_truth");
    expect(
      freshCommercialTruth.badges.map((badge) => badge.type),
    ).not.toContain("truth_commercial_stale");

    const oldCommercialTruth = decideGoldenPrimary("GC-078");
    expect(oldCommercialTruth.label).toBe("scale");
    expect(oldCommercialTruth.truthSource).toBe("commercial_truth");
    expect(oldCommercialTruth.confidence).toBe(freshCommercialTruth.confidence);
    expect(oldCommercialTruth.badges.map((badge) => badge.type)).not.toContain(
      "scale_readiness_blocked",
    );

    const unknownCommercialTruth = decideGoldenPrimary("GC-079");
    expect(unknownCommercialTruth.label).toBe("keep");
    expect(unknownCommercialTruth.truthSource).toBe("commercial_truth_stale");
    expect(unknownCommercialTruth.confidence).toBeLessThan(
      freshCommercialTruth.confidence,
    );
    expect(unknownCommercialTruth.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "truth_commercial_stale",
        "scale_readiness_blocked",
      ]),
    );

    expect(decideGoldenPrimary("GC-082")).toMatchObject({
      label: "cut",
      preAuthorityLabel: "cut",
      authorityBlocker: null,
      blockedActionType: null,
      truthSource: "commercial_truth",
    });
  });

  it("keeps canonical fallback cases equal to canonical all-account behavior", () => {
    const baseline = decideCreative(
      makeCreativeInput(),
      makeAccountDecisionProfile(),
    );

    for (const caseId of ["GC-040", "GC-041"]) {
      expect(semanticDecision(decideGoldenPrimary(caseId))).toEqual({
        ...semanticDecision(baseline),
        decisionKindSource: "all_fallback",
      });
    }
  });

  it("keeps aggregate-only cases out of row-level buyer actions", () => {
    const aggregateOnlyCases = fixtureCases.filter(
      (item) => item.expectedSafeFallbackIfDataMissing === "disable_aggregate",
    );

    expect(aggregateOnlyCases.map((item) => item.caseId)).toEqual([
      "GC-029",
      "GC-030",
      "GC-031",
    ]);
    expect(
      aggregateOnlyCases.every(
        (item) =>
          item.expectedTopReasonTag.endsWith("_aggregate_only") &&
          item.expectedBuyerAction !== "brief_variation",
      ),
    ).toBe(true);
  });

  it("keeps Creative UI from computing V2.1 buyerAction during fixture work", () => {
    const files = [
      "app/(dashboard)/platforms/meta/creatives",
      "components/creatives",
    ].flatMap(sourceFiles);

    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return /\bbuyerAction\s*[:=]|\bafterBuyerAction\b|brief_variation/.test(
        source,
      );
    });

    expect(offenders).toEqual([]);
  });

  it("keeps anachronistic target-history replay out of decideCreative fixtures", () => {
    const spec = readFileSync(
      "docs/creative-decision-center/GOLDEN_CASE_SPEC_PACKAGE_2026-07-06.md",
      "utf8",
    );

    expect(fixtureCases.some((item) => item.caseId === "GC-076")).toBe(false);
    expect(EXECUTABLE_PRIMARY_CASE_IDS.has("GC-076")).toBe(false);
    expect(spec).toContain("Harness/policy rule");
    expect(spec).toContain("not the `decideCreative` golden fixture table");
  });

  it("keeps confidence copy contracts explicit in the spec package", () => {
    const spec = readFileSync(
      "docs/creative-decision-center/GOLDEN_CASE_SPEC_PACKAGE_2026-07-06.md",
      "utf8",
    );
    const normalizedSpec = spec.replace(/\s+/g, " ");

    expect(normalizedSpec).toContain(
      "Calibration not proven: fewer than 30 comparable outcomes for this action/account/source mode.",
    );
    expect(normalizedSpec).toContain(
      "Confidence is capped because source freshness is stale or unknown. Refresh evidence before applying this action.",
    );
    expect(normalizedSpec).toContain(
      "Observed positive is a missed-hard-action proxy, not hard-action precision.",
    );
    expect(normalizedSpec).toContain(
      "Historical replay isolates formula behavior and does not equal lifecycle-informed production behavior.",
    );
  });
});

describe("Pending V2.1 golden cases", () => {
  for (const item of pendingCases) {
    it.todo(`${item.caseId}: ${pendingReason(item)}`);
  }
});

describe("Pending config-surface golden cases", () => {
  it.todo(
    "GC-072: lossBudgetMultiplier < hardCutMultiplier accepted once account override config exists",
  );
  it.todo(
    "GC-073: lossBudgetMultiplier >= hardCutMultiplier rejected or explicitly golden-tested before runtime",
  );
  it.todo(
    "GC-074: cutBoundaryMode=account_p25_current preserves current boundary once config exists",
  );
  it.todo(
    "GC-075: cutBoundaryMode=breakeven_floor stays account-scoped once config exists",
  );
});

describe("Hysteresis sequence golden cases (GS series)", () => {
  interface SequenceGolden {
    caseId: string;
    source: string;
    rawSequence: DecisionLabel[];
    publishedSequence: DecisionLabel[];
    suppressedDays: number[];
  }

  function parseSequenceGoldens(): SequenceGolden[] {
    const markdown = readFileSync(GOLDEN_CASES_PATH, "utf8");
    return markdown
      .split("\n")
      .filter((line) => line.startsWith("| GS-"))
      .map((line) => {
        const cells = line
          .split("|")
          .map((cell) => cell.trim())
          .filter((cell) => cell.length > 0);
        const [caseId, source, raw, published, suppressed] = cells;
        return {
          caseId,
          source,
          rawSequence: raw
            .split(",")
            .map((label) => label.trim()) as DecisionLabel[],
          publishedSequence: published
            .split(",")
            .map((label) => label.trim()) as DecisionLabel[],
          suppressedDays:
            suppressed === "none"
              ? []
              : suppressed.split(",").map((value) => Number(value.trim())),
        };
      });
  }

  const sequenceGoldens = parseSequenceGoldens();

  it("keeps the GS table populated with the named live flip creatives", () => {
    expect(sequenceGoldens.length).toBeGreaterThanOrEqual(8);
    const sources = sequenceGoldens.map((item) => item.source).join(" ");
    expect(sources).toContain("946471284944193");
    expect(sources).toContain("1962656064410174");
    expect(sources).toContain("25889037484086563");
  });

  it("executes every GS sequence through applyLabelHysteresis", () => {
    for (const golden of sequenceGoldens) {
      const published: DecisionLabel[] = [];
      const suppressedDays: number[] = [];
      let previous: PreviousPublishedLabel | null = null;
      golden.rawSequence.forEach((raw, day) => {
        const result = applyLabelHysteresis(raw, previous);
        published.push(result.publishedLabel);
        if (result.suppressed) suppressedDays.push(day);
        previous = {
          publishedLabel: result.publishedLabel,
          rawLabel: result.rawLabel,
        };
      });
      expect(published, golden.caseId).toEqual(golden.publishedSequence);
      expect(suppressedDays, golden.caseId).toEqual(golden.suppressedDays);
    }
  });
});
