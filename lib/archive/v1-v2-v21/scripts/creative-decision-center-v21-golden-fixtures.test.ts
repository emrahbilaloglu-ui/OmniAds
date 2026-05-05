import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCreativeDecisionOsV21, type CreativeDecisionOsV21Input } from "@/lib/creative-decision-os-v2";
import {
  adaptCreativeDecisionCenterBuyerAction,
  confidenceBand,
} from "@/lib/creative-decision-center/buyer-adapter";
import {
  CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES,
  V21_ACTIONABILITIES,
  V21_BUYER_ACTIONS,
  V21_CONFIDENCE_BANDS,
  V21_MATURITY_BANDS,
  V21_PRIMARY_DECISIONS,
  V21_PRIORITY_BANDS,
  V21_PROBLEM_CLASSES,
  type CreativeDecisionCenterV21GoldenCase,
} from "./creative-decision-center-v21-golden-fixtures";

const canonicalGoldenCasesPath = "docs/creative-decision-center/GOLDEN_CASES.md";

type GoldenCaseExpectation = Omit<CreativeDecisionCenterV21GoldenCase, "scope">;

function parseCanonicalGoldenCases(): GoldenCaseExpectation[] {
  const markdown = readFileSync(canonicalGoldenCasesPath, "utf8");
  const tableRows = markdown
    .split("\n")
    .filter((line) => line.startsWith("| GC-"));

  return tableRows.map((line) => {
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());

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
    ] = cells;

    return {
      caseId: caseId as GoldenCaseExpectation["caseId"],
      inputSummary,
      expectedPrimaryDecision: expectedPrimaryDecision as GoldenCaseExpectation["expectedPrimaryDecision"],
      expectedBuyerAction: expectedBuyerAction as GoldenCaseExpectation["expectedBuyerAction"],
      expectedActionability: expectedActionability as GoldenCaseExpectation["expectedActionability"],
      expectedProblemClass: expectedProblemClass as GoldenCaseExpectation["expectedProblemClass"],
      expectedPriorityBand: expectedPriorityBand as GoldenCaseExpectation["expectedPriorityBand"],
      expectedConfidenceBand: expectedConfidenceBand as GoldenCaseExpectation["expectedConfidenceBand"],
      expectedTopReasonTag,
      expectedMaturity: expectedMaturity as GoldenCaseExpectation["expectedMaturity"],
      expectedSafeFallbackIfDataMissing:
        expectedSafeFallbackIfDataMissing as GoldenCaseExpectation["expectedSafeFallbackIfDataMissing"],
    };
  });
}

function fixtureWithoutScope(
  item: CreativeDecisionCenterV21GoldenCase,
): GoldenCaseExpectation {
  const { scope: _scope, ...expectation } = item;
  return expectation;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|jsx?)$/.test(entry) ? [path] : [];
  });
}

function v21InputFromGoldenCase(
  item: CreativeDecisionCenterV21GoldenCase,
): CreativeDecisionOsV21Input {
  const base: CreativeDecisionOsV21Input = {
    creativeId: item.caseId,
    rowId: item.caseId,
    identityGrain: "creative",
    activeStatus: true,
    adStatus: "ACTIVE",
    campaignStatus: "ACTIVE",
    adsetStatus: "ACTIVE",
    spend: 500,
    purchases: 3,
    impressions: 10_000,
    roas: 1,
    cpa: 50,
    recentRoas: 1,
    recentPurchases: 1,
    benchmarkRoas: 1,
    benchmarkCpa: 50,
    targetRoas: 1,
    targetCpa: 50,
    peerMedianSpend: 400,
    ctr: 1.2,
    cpm: 12,
    frequency: 2,
    benchmarkReliability: "medium",
    targetSource: "fixture",
    dataFreshnessStatus: "fresh",
    dataFreshnessHours: 2,
    truthState: "present",
    maturity: item.expectedMaturity,
    availableData: [
      "spend",
      "purchases",
      "impressions",
      "roas",
      "cpa",
      "ctr",
      "cpm",
      "frequency",
      "campaignStatus",
      "adsetStatus",
      "adStatus",
      "benchmarkReliability",
      "targetSource",
      "dataFreshness",
      "truth",
    ],
    missingData: [],
    reasonHints: [],
  };

  switch (item.expectedTopReasonTag) {
    case "active_no_spend_24h":
      return {
        ...base,
        spend24h: 0,
        impressions24h: 0,
        availableData: [
          ...(base.availableData ?? []),
          "spend24h",
          "impressions24h",
        ],
      };
    case "campaign_paused":
      return { ...base, campaignStatus: "PAUSED" };
    case "adset_paused":
      return { ...base, adsetStatus: "PAUSED" };
    case "disapproved_or_limited":
      return {
        ...base,
        reviewStatus: "DISAPPROVED",
        effectiveStatus: "DISAPPROVED",
        policyReason: "policy disapproved",
        availableData: [
          ...(base.availableData ?? []),
          "reviewStatus",
          "effectiveStatus",
          "policyReason",
        ],
      };
    case "missing_policy_status":
      return {
        ...base,
        reviewStatus: "DISAPPROVED",
        effectiveStatus: null,
        policyReason: null,
        missingData: ["effectiveStatus", "policyReason"],
      };
    case "new_launch_window":
    case "new_launch_severe_spend_no_purchase":
      return {
        ...base,
        firstSeenAt: "2026-04-30T00:00:00.000Z",
        firstSpendAt: "2026-04-30T01:00:00.000Z",
        launchAgeHours: 12,
        reasonHints: [item.expectedTopReasonTag],
        availableData: [
          ...(base.availableData ?? []),
          "firstSeenAt",
          "firstSpendAt",
        ],
      };
    case "severe_sustained_loser":
      return {
        ...base,
        spend: 1200,
        purchases: 5,
        recentPurchases: 0,
        roas: 0.4,
        cpa: 110,
        maturity: "mature",
      };
    case "strong_relative_winner":
      return {
        ...base,
        spend: 1600,
        purchases: 8,
        roas: 1.6,
        cpa: 35,
        maturity: "mature",
      };
    case "fatigue_composite":
      return {
        ...base,
        fatigueStatus: "fatigued",
        ctrDecayPct: 35,
        cpmIncreasePct: 30,
        frequencyIncreasePct: 30,
        purchases: 6,
        maturity: "mature",
        reasonHints: ["fatigue_composite"],
      };
    case "partial_fatigue_signal":
      return { ...base, reasonHints: ["partial_fatigue_signal"] };
    case "benchmark_missing":
      return {
        ...base,
        benchmarkReliability: "missing",
        missingData: ["benchmarkReliability"],
        availableData: (base.availableData ?? []).filter(
          (field) => field !== "benchmarkReliability",
        ),
      };
    case "weak_benchmark":
      return {
        ...base,
        benchmarkReliability: "weak",
        missingData: ["benchmarkReliability"],
      };
    case "stale_data":
      return { ...base, dataFreshnessStatus: "stale", dataFreshnessHours: 60 };
    case "truth_missing":
      return { ...base, truthState: "missing", missingData: ["truth"] };
    case "truth_degraded":
      return { ...base, truthState: "degraded", missingData: ["truth"] };
    case "tracking_drop_suspected":
      return {
        ...base,
        truthState: "missing",
        reasonHints: ["tracking_drop_suspected"],
        missingData: ["truth"],
      };
    case "missing_delivery_proof":
      return {
        ...base,
        spend24h: 0,
        impressions24h: null,
        missingData: ["impressions24h"],
      };
    case "spend_without_impressions":
      return {
        ...base,
        impressions: 0,
        reasonHints: ["spend_without_impressions"],
        missingData: ["impressions"],
      };
    case "landing_or_cvr_issue":
      return { ...base, reasonHints: ["landing_or_cvr_issue"] };
    case "tiny_spend_winner":
      return { ...base, spend: 20, purchases: 1 };
    case "low_purchase_count":
      return { ...base, purchases: 1 };
    case "low_evidence":
      return { ...base, spend: 120, purchases: 2 };
    case "stable_winner":
      return {
        ...base,
        spend: 1500,
        purchases: 8,
        roas: 1.5,
        maturity: "mature",
        reasonHints: ["stable_winner"],
      };
    default:
      return base;
  }
}

describe("Creative Decision Center V2.1 PR2 golden fixtures", () => {
  it("runs row fixtures through the V2.1 resolver and buyer adapter", () => {
    for (const item of CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES) {
      if (item.scope === "aggregate_only") continue;
      const input = v21InputFromGoldenCase(item);
      const engine = resolveCreativeDecisionOsV21(input);
      const adapted = adaptCreativeDecisionCenterBuyerAction(engine, {
        availableData: input.availableData,
      });

      expect(engine.primaryDecision, item.caseId).toBe(item.expectedPrimaryDecision);
      expect(engine.problemClass, item.caseId).toBe(item.expectedProblemClass);
      expect(engine.actionability, item.caseId).toBe(item.expectedActionability);
      expect(engine.maturity, item.caseId).toBe(item.expectedMaturity);
      expect(engine.reasonTags[0], item.caseId).toBe(item.expectedTopReasonTag);
      expect(confidenceBand(engine.confidence), item.caseId).toBe(
        item.expectedConfidenceBand,
      );
      expect(adapted.buyerAction, item.caseId).toBe(item.expectedBuyerAction);
    }
  });

  it("keeps the executable fixture in lockstep with canonical GOLDEN_CASES.md", () => {
    const canonicalCases = parseCanonicalGoldenCases();

    expect(canonicalCases).toHaveLength(35);
    expect(
      CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.map(fixtureWithoutScope),
    ).toEqual(canonicalCases);
  });

  it("asserts the full V2.1 contract surface for every golden case", () => {
    const caseIds = new Set<string>();

    for (const item of CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES) {
      expect(item.caseId).toMatch(/^GC-\d{3}$/);
      expect(caseIds.has(item.caseId)).toBe(false);
      caseIds.add(item.caseId);

      expect(item.inputSummary.length).toBeGreaterThan(0);
      expect(V21_PRIMARY_DECISIONS).toContain(item.expectedPrimaryDecision);
      expect(V21_BUYER_ACTIONS).toContain(item.expectedBuyerAction);
      expect(V21_ACTIONABILITIES).toContain(item.expectedActionability);
      expect(V21_PROBLEM_CLASSES).toContain(item.expectedProblemClass);
      expect(V21_PRIORITY_BANDS).toContain(item.expectedPriorityBand);
      expect(V21_CONFIDENCE_BANDS).toContain(item.expectedConfidenceBand);
      expect(item.expectedTopReasonTag.length).toBeGreaterThan(0);
      expect(V21_MATURITY_BANDS).toContain(item.expectedMaturity);
      expect(["diagnose_data", "disable_aggregate"]).toContain(
        item.expectedSafeFallbackIfDataMissing,
      );
    }

    expect(caseIds.size).toBe(35);
  });

  it("keeps buyerAction row-safe and leaves brief_variation aggregate-only", () => {
    expect(V21_BUYER_ACTIONS).not.toContain("brief_variation" as never);

    const aggregateOnlyCases = CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.filter(
      (item) => item.scope === "aggregate_only",
    );

    expect(aggregateOnlyCases.map((item) => item.caseId)).toEqual([
      "GC-029",
      "GC-030",
      "GC-031",
    ]);
    expect(
      aggregateOnlyCases.every(
        (item) => item.expectedSafeFallbackIfDataMissing === "disable_aggregate",
      ),
    ).toBe(true);
    expect(
      aggregateOnlyCases.every((item) =>
        item.expectedTopReasonTag.endsWith("_aggregate_only"),
      ),
    ).toBe(true);
  });

  it("locks delivery and policy proof gates before runtime resolver changes", () => {
    const fixDeliveryCases = CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.filter(
      (item) => item.expectedBuyerAction === "fix_delivery",
    );
    expect(fixDeliveryCases.map((item) => item.caseId)).toEqual(["GC-001"]);
    expect(fixDeliveryCases[0]?.expectedTopReasonTag).toBe("active_no_spend_24h");
    expect(fixDeliveryCases[0]?.expectedProblemClass).toBe("delivery");
    expect(fixDeliveryCases[0]?.expectedConfidenceBand).not.toBe("high");

    const deliveryFallback = CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.find(
      (item) => item.caseId === "GC-021",
    );
    expect(deliveryFallback?.expectedBuyerAction).toBe("diagnose_data");
    expect(deliveryFallback?.expectedTopReasonTag).toBe("missing_delivery_proof");
    expect(deliveryFallback?.expectedConfidenceBand).toBe("low");

    const fixPolicyCases = CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.filter(
      (item) => item.expectedBuyerAction === "fix_policy",
    );
    expect(fixPolicyCases.map((item) => item.caseId)).toEqual([
      "GC-004",
      "GC-005",
      "GC-022",
    ]);
    expect(
      fixPolicyCases.every(
        (item) =>
          item.expectedProblemClass === "policy" &&
          item.expectedTopReasonTag === "disapproved_or_limited",
      ),
    ).toBe(true);

    const policyFallback = CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.find(
      (item) => item.caseId === "GC-006",
    );
    expect(policyFallback?.expectedBuyerAction).toBe("diagnose_data");
    expect(policyFallback?.expectedTopReasonTag).toBe("missing_policy_status");
    expect(policyFallback?.expectedConfidenceBand).toBe("low");
  });

  it("prevents fake certainty for stale, missing benchmark, missing truth, and launch cases", () => {
    const lowConfidenceDataQualityCases = [
      "GC-006",
      "GC-016",
      "GC-017",
      "GC-018",
      "GC-019",
      "GC-020",
      "GC-021",
      "GC-023",
      "GC-024",
      "GC-033",
    ];

    for (const caseId of lowConfidenceDataQualityCases) {
      const item = CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.find(
        (candidate) => candidate.caseId === caseId,
      );

      expect(item?.expectedBuyerAction).toBe("diagnose_data");
      expect(item?.expectedConfidenceBand).toBe("low");
    }

    const highConfidenceScaleCutCases = CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.filter(
      (item) =>
        ["scale", "cut"].includes(item.expectedBuyerAction) &&
        item.expectedConfidenceBand === "high",
    );
    expect(highConfidenceScaleCutCases.map((item) => item.caseId)).toEqual([
      "GC-010",
      "GC-011",
    ]);
    expect(
      highConfidenceScaleCutCases.every(
        (item) =>
          item.expectedMaturity === "mature" &&
          item.expectedProblemClass === "performance",
      ),
    ).toBe(true);

    const launchCases = ["GC-007", "GC-008", "GC-009"].map((caseId) =>
      CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.find((item) => item.caseId === caseId),
    );
    expect(launchCases.map((item) => item?.expectedBuyerAction)).toEqual([
      "watch_launch",
      "watch_launch",
      "watch_launch",
    ]);
    expect(launchCases.every((item) => item?.expectedPrimaryDecision === "Test More")).toBe(true);
  });

  it("keeps Creative UI from computing V2.1 buyerAction during PR2", () => {
    const files = ["app/(dashboard)/creatives", "components/creatives"]
      .filter((root) => existsSync(root))
      .flatMap(sourceFiles);

    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      return /\bbuyerAction\s*[:=]|\bafterBuyerAction\b|brief_variation/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("records live artifacts as fixture-backed unless live-status proves otherwise", () => {
    const liveStatus = JSON.parse(
      readFileSync("docs/creative-decision-center/generated/live-status.json", "utf8"),
    ) as {
      attempted: boolean;
      source?: string;
      readOnly?: boolean;
      reason: string;
      missingEnv?: string[];
      snapshotId?: string | null;
    };

    if (liveStatus.attempted) {
      expect(liveStatus.source).toBe("database");
      expect(liveStatus.readOnly).toBe(true);
      expect(liveStatus.snapshotId).toBeTruthy();
      expect(liveStatus.reason).toContain("SELECT-only");
      return;
    }

    expect(liveStatus.source).toBe("fixture");
    expect(liveStatus.reason).toContain("DATABASE_URL");
    expect(liveStatus.missingEnv).toContain("DATABASE_URL");
  });
});
