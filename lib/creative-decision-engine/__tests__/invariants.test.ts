import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideCreative, ENGINE_VERSION } from "..";
import type { DecisionOutput } from "../types";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
  makeDataLayerHealth,
} from "./helpers";

type InvariantCoverage = {
  id: string;
  docText: string;
  status: "executable" | "pending";
  reason: string;
};

const HIGH_CONFIDENCE_FLOOR = 80;

const INVARIANT_COVERAGE: InvariantCoverage[] = [
  {
    id: "I01",
    docText: "UI must not compute `buyerAction`.",
    status: "executable",
    reason: "static source scan",
  },
  {
    id: "I02",
    docText: "No row-level `brief_variation`.",
    status: "executable",
    reason: "contract and source scan",
  },
  {
    id: "I03",
    docText: "No `fix_delivery` without active status + no spend/impression proof.",
    status: "pending",
    reason: "fix_delivery belongs to the V2.1 buyer adapter/data-readiness layer",
  },
  {
    id: "I04",
    docText: "No `fix_policy` without review/effective/disapproval/limited proof.",
    status: "pending",
    reason: "policy proof fields are not wired into active V3 inputs",
  },
  {
    id: "I05",
    docText: "No high-confidence scale/cut on stale data.",
    status: "executable",
    reason: "stale DataHealth confidence cap regression",
  },
  {
    id: "I06",
    docText:
      "No hard cut for new launch unless maturity threshold is met or severe-loss rule is explicit.",
    status: "pending",
    reason: "firstSeenAt/firstSpendAt launch fields are not active V3 inputs",
  },
  {
    id: "I07",
    docText: "No high-confidence scale when benchmark/target is missing.",
    status: "executable",
    reason: "scale benchmark readiness regression",
  },
  {
    id: "I08",
    docText:
      "Cut maturity must use commercial loss-budget spend, not winner-pool purchase depth.",
    status: "executable",
    reason: "loss-budget cut fixture",
  },
  {
    id: "I09",
    docText: "Scale spend maturity must use the same commercial loss-budget spend as cut.",
    status: "executable",
    reason: "near-scale low purchase-depth fixture",
  },
  {
    id: "I10",
    docText:
      "Scale must additionally require purchase depth and recent performance hold;",
    status: "executable",
    reason: "near-scale blocked fixture",
  },
  {
    id: "I11",
    docText:
      "Hard scale must additionally require account winner-benchmark readiness:",
    status: "executable",
    reason: "thin calibration and missing benchmark fixtures",
  },
  {
    id: "I12",
    docText:
      "A scale-zone creative blocked by spend, purchase, recent hold, or benchmark",
    status: "executable",
    reason: "scale_readiness_blocked badge regression",
  },
  {
    id: "I13",
    docText:
      "Raw `scale` decisions downgraded by soft-only hard-action eligibility must",
    status: "executable",
    reason: "soft-only scale badge regression",
  },
  {
    id: "I14",
    docText: "A `scale` verdict and the executable primary action are separate contracts:",
    status: "pending",
    reason: "buyerAction/briefing adapter is not active in this slice",
  },
  {
    id: "I15",
    docText: "Test campaign scale may show `Promote to main`; Main campaign scale must",
    status: "pending",
    reason: "campaign-kind-aware execution CTA is briefing adapter work",
  },
  {
    id: "I16",
    docText:
      "UI fallback logic must not map generic `scale` to `Promote to main` unless the",
    status: "pending",
    reason: "UI migration is behind later decisionCenter/buyerAction work",
  },
  {
    id: "I17",
    docText: "`hardCut` multipliers are severe-loss / scaled-loss thresholds, not the",
    status: "pending",
    reason: "requires config-as-data audit, not a resolver edit in this slice",
  },
  {
    id: "I18",
    docText: "Policy and delivery blockers override performance.",
    status: "pending",
    reason: "policy/delivery proof fields are not active V3 inputs",
  },
  {
    id: "I19",
    docText: "Campaign/adset paused must not become `fix_delivery`.",
    status: "pending",
    reason: "campaign/adset status proof is V2.1 data-readiness work",
  },
  {
    id: "I20",
    docText: "Missing required data must produce `diagnose_data` or confidence cap.",
    status: "pending",
    reason: "diagnose_data is buyerAction output, not active V3 output",
  },
  {
    id: "I21",
    docText: "Aggregate decisions must not attach to a random `creativeId`.",
    status: "pending",
    reason: "aggregate decision builder is not active yet",
  },
  {
    id: "I22",
    docText: "Same input/config/version must produce deterministic output.",
    status: "executable",
    reason: "semantic output equality ignoring generatedAt",
  },
  {
    id: "I23",
    docText: "No hard-coded thresholds scattered inside resolver.",
    status: "pending",
    reason: "config-as-data audit is the next report-only slice",
  },
  {
    id: "I24",
    docText:
      "Kind-aware baseline selection must be all-or-nothing per decision: a decision",
    status: "executable",
    reason: "kind fallback regression",
  },
  {
    id: "I25",
    docText: "Kind-aware selection must fall back to canonical baselines when required",
    status: "executable",
    reason: "sparse kind calibration regression",
  },
  {
    id: "I26",
    docText: "Unlabeled creatives must use canonical baselines; the campaign-label guard",
    status: "pending",
    reason: "guard behavior is covered in golden cases; full adapter remains pending",
  },
  {
    id: "I27",
    docText: "Sparse Mixed campaign buckets fall back to canonical `all`; they must not be",
    status: "executable",
    reason: "mixed kind fallback regression",
  },
  {
    id: "I28",
    docText: "Test-cohort `refresh` to `cut` transformation must execute inside",
    status: "executable",
    reason: "labelTransform pipeline regression",
  },
  {
    id: "I29",
    docText: "`labelTransform` must be preserved on the final `DecisionOutput` even if the",
    status: "executable",
    reason: "soft-only transformed cut regression",
  },
  {
    id: "I30",
    docText: "Snapshot persistence may store `labelTransform` only as nullable audit data;",
    status: "executable",
    reason: "snapshot persistence source assertion already has a concrete field",
  },
  {
    id: "I31",
    docText: "Test-cohort semantic transformation applies only to explicit",
    status: "executable",
    reason: "main/mixed/unlabeled refresh regression",
  },
  {
    id: "I32",
    docText: "Resolver gate files remain responsible for resolver math only; label semantic",
    status: "pending",
    reason: "requires architecture/static-boundary audit before enforcement",
  },
];

function semanticOutput(output: DecisionOutput) {
  return {
    creativeId: output.creativeId,
    label: output.label,
    reason: output.reason,
    confidence: output.confidence,
    truthSource: output.truthSource,
    effectiveTargetRoas: output.effectiveTargetRoas,
    ratioToTarget: output.ratioToTarget,
    badges: output.badges,
    metrics: output.metrics,
    decisionKindSource: output.decisionKindSource,
    labelTransform: output.labelTransform ?? null,
    engineVersion: output.engineVersion,
  };
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

describe("Creative Decision Center invariants", () => {
  it("keeps invariant coverage linked to INVARIANTS.md", () => {
    const markdown = readFileSync(
      "docs/creative-decision-center/INVARIANTS.md",
      "utf8",
    );

    for (const item of INVARIANT_COVERAGE) {
      expect(markdown, item.id).toContain(item.docText);
      expect(item.reason.length, item.id).toBeGreaterThan(0);
    }

    expect(INVARIANT_COVERAGE.filter((item) => item.status === "executable")).toHaveLength(18);
    expect(INVARIANT_COVERAGE.filter((item) => item.status === "pending")).toHaveLength(14);
  });

  it("keeps DecisionOutput row-safe and UI from computing buyerAction", () => {
    const typeSource = readFileSync(
      "lib/creative-decision-engine/types.ts",
      "utf8",
    );
    const decisionOutputSource = typeSource.slice(
      typeSource.indexOf("export interface DecisionOutput"),
      typeSource.indexOf("/**\n * Data freshness tier"),
    );

    expect(decisionOutputSource).not.toMatch(/\bbuyerAction\b/);
    expect(decisionOutputSource).not.toMatch(/brief_variation|briefVariation/);

    const uiFiles = [
      "app/(dashboard)/platforms/meta/creatives",
      "components/creatives",
    ].flatMap(sourceFiles);
    const offenders = uiFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return /\bbuyerAction\s*[:=]|\bafterBuyerAction\b|brief_variation/.test(
        source,
      );
    });

    expect(offenders).toEqual([]);
  });

  it("keeps semantic engine output deterministic for the same input/profile/version", () => {
    const input = makeCreativeInput();
    const profile = makeAccountDecisionProfile();

    const first = decideCreative(input, profile);
    const second = decideCreative(input, profile);

    expect(first.engineVersion).toBe(ENGINE_VERSION);
    expect(semanticOutput(first)).toEqual(semanticOutput(second));
  });

  it("caps stale scale/cut decisions below the high-confidence band", () => {
    const profile = makeAccountDecisionProfile();
    const input = makeCreativeInput({
      spend: 1000,
      purchases: 15,
      roas: 3.5,
      recent7dRoas: 3,
    });
    const staleHealth = makeDataHealth({
      calibration: makeDataLayerHealth({ staleTier: "disabled" }),
      lifecycle: makeDataLayerHealth({ staleTier: "warning" }),
      decisions: makeDataLayerHealth({ staleTier: "warning" }),
    });

    const fresh = decideCreative(input, profile);
    const stale = decideCreative(input, profile, staleHealth);

    expect(fresh.label).toBe("scale");
    expect(stale.label).toBe("scale");
    expect(stale.confidence).toBeLessThan(fresh.confidence);
    expect(stale.confidence).toBeLessThan(HIGH_CONFIDENCE_FLOOR);
  });

  it("keeps scale-zone blockers as review rows, not hard scale", () => {
    const baseInput = makeCreativeInput({
      spend: 600,
      purchases: 8,
      roas: 3.3,
      recent7dRoas: 2.8,
    });
    const lowPurchase = decideCreative(baseInput, makeAccountDecisionProfile());
    expect(lowPurchase.label).toBe("keep");
    expect(lowPurchase.badges.map((badge) => badge.type)).toContain(
      "scale_readiness_blocked",
    );

    const thinCalibration = decideCreative(
      { ...baseInput, purchases: 10 },
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
    expect(thinCalibration.label).toBe("keep");
    expect(thinCalibration.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "scale_readiness_blocked",
        "scale_calibration_thin",
      ]),
    );

    const missingWinnerBenchmark = decideCreative(
      { ...baseInput, purchases: 10 },
      makeAccountDecisionProfile({
        accountBaselines: makeAccountCalibration({
          matureCreativeCount: 35,
          winnerPurchaseP50: null,
        }),
        thresholds: { scaleMinPurchases: 1 },
      }),
    );
    expect(missingWinnerBenchmark.label).toBe("keep");
    expect(missingWinnerBenchmark.badges.map((badge) => badge.type)).toEqual(
      expect.arrayContaining([
        "scale_readiness_blocked",
        "scale_calibration_thin",
      ]),
    );
  });

  it("keeps loss-budget cut maturity independent from scale purchase depth", () => {
    const output = decideCreative(
      makeCreativeInput({
        spend: 300,
        purchases: 1,
        roas: 1.1,
        recent7dRoas: 1,
        ctr: 0.5,
        thumbstop: 10,
      }),
      makeAccountDecisionProfile(),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toContain("loss-budget maturity reached");
  });

  it("keeps soft-only scale verdicts server-driven with scale readiness evidence", () => {
    const output = decideCreative(
      makeCreativeInput({
        spend: 1000,
        purchases: 15,
        roas: 3.5,
        recent7dRoas: 3,
      }),
      makeAccountDecisionProfile({
        hardActionEligibility: {
          scale: false,
          cut: false,
          refresh: false,
          reason: "threshold baseline has low confidence",
        },
      }),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toContain("[near scale, soft-only]");
    expect(output.badges.map((badge) => badge.type)).toContain(
      "scale_readiness_blocked",
    );
  });

  it("keeps labelTransform in the finalize pipeline and off non-test refreshes", () => {
    const refreshInput = makeCreativeInput({
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
    });
    const baseProfile = makeAccountDecisionProfile({
      accountBaselinesByKind: {
        all: makeAccountCalibration(),
        main: makeAccountCalibration({ campaignKind: "main" }),
        test: makeAccountCalibration({ campaignKind: "test" }),
        mixed: makeAccountCalibration({ campaignKind: "mixed" }),
      },
    });

    const testOutput = decideCreative(
      { ...refreshInput, campaignKind: "test" },
      baseProfile,
    );
    expect(testOutput.label).toBe("cut");
    expect(testOutput.labelTransform).toBe("test_cohort_refresh_to_cut");

    for (const campaignKind of ["main", "mixed", null] as const) {
      const output = decideCreative(
        { ...refreshInput, campaignKind },
        baseProfile,
      );
      expect(output.label).toBe("refresh");
      expect(output.labelTransform ?? null).toBeNull();
    }
  });

  it("stores labelTransform as nullable snapshot audit data", () => {
    const source = readFileSync(
      "lib/creative-decision-engine/jobs/decisions-job.ts",
      "utf8",
    );

    expect(source).toContain("label_transform: input.decision.labelTransform ?? null");
  });
});

describe("Pending Creative Decision Center invariants", () => {
  for (const item of INVARIANT_COVERAGE.filter(
    (candidate) => candidate.status === "pending",
  )) {
    it.todo(`${item.id}: ${item.reason}`);
  }
});
