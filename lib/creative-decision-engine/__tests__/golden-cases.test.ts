import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
const MATURITY_BANDS = ["too_early", "learning", "actionable", "mature"] as const;
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
    expect(fixtureCases).toHaveLength(62);
  });

  it("asserts the full contract surface for every canonical case", () => {
    const caseIds = new Set<string>();

    for (const item of fixtureCases) {
      expect(item.caseId).toMatch(/^GC-\d{3}[ab]?$/);
      expect(caseIds.has(item.caseId)).toBe(false);
      caseIds.add(item.caseId);
      expect(item.inputSummary.length).toBeGreaterThan(0);
      expect(PRIMARY_DECISIONS).toContain(item.expectedPrimaryDecision as never);
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
    ]);

    expect(pendingCases).toHaveLength(37);
    for (const item of pendingCases) {
      expect(pendingReason(item), item.caseId).not.toMatch(/undefined|unknown/i);
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
    expect(recovery.reason).toContain("do not hard cut while recovery is holding");
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
    expect(freshFunnel.label).toBe("diagnose");
    expect(freshFunnel.badges.map((badge) => badge.type)).toContain(
      "landing_page_issue",
    );
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
});

describe("Pending V2.1 golden cases", () => {
  for (const item of pendingCases) {
    it.todo(`${item.caseId}: ${pendingReason(item)}`);
  }
});
