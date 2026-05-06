import { describe, expect, it } from "vitest";
import {
  adaptCreativeDecisionCenterBuyerAction,
  confidenceBand,
  CREATIVE_DECISION_CENTER_BUYER_ACTION_RULES,
} from "@/lib/creative-decision-center/buyer-adapter";
import {
  CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
  type CreativeDecisionOsV21Output,
} from "@/lib/creative-decision-center/contracts";
import {
  CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES,
  type CreativeDecisionCenterV21GoldenCase,
} from "@/scripts/creative-decision-center-v21-golden-fixtures";

function confidenceForBand(
  band: CreativeDecisionCenterV21GoldenCase["expectedConfidenceBand"],
) {
  if (band === "high") return 82;
  if (band === "medium") return 70;
  return 50;
}

function engineFromGoldenCase(
  item: CreativeDecisionCenterV21GoldenCase,
): CreativeDecisionOsV21Output {
  return {
    contractVersion: CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
    engineVersion: "creative-decision-os.v2.1-test",
    primaryDecision: item.expectedPrimaryDecision,
    actionability: item.expectedActionability,
    problemClass: item.expectedProblemClass,
    confidence: confidenceForBand(item.expectedConfidenceBand),
    maturity: item.expectedMaturity,
    priority: item.expectedPriorityBand,
    reasonTags: [item.expectedTopReasonTag],
    evidenceSummary: item.inputSummary,
    blockerReasons: [],
    missingData:
      item.expectedBuyerAction === "diagnose_data" &&
      item.expectedConfidenceBand === "low"
        ? [item.expectedTopReasonTag]
        : [],
    queueEligible: false,
    applyEligible: false,
  };
}

function availableDataForGoldenCase(item: CreativeDecisionCenterV21GoldenCase) {
  const data = new Set(["targetSource", "benchmarkReliability", "dataFreshness"]);

  if (item.expectedBuyerAction === "fix_delivery") {
    data.add("adStatus");
    data.add("campaignStatus");
    data.add("adsetStatus");
    data.add("spend24h");
    data.add("impressions24h");
  }
  if (item.expectedBuyerAction === "fix_policy") {
    data.add("reviewStatus");
    data.add("effectiveStatus");
    data.add("policyReason");
  }
  if (item.expectedBuyerAction === "watch_launch") {
    data.add("firstSeenAt");
    data.add("firstSpendAt");
  }

  return Array.from(data);
}

describe("Creative Decision Center V2.1 buyer adapter shadow mode", () => {
  it("is deterministic and table-driven", () => {
    const engine = engineFromGoldenCase(CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES[0]);
    const context = {
      availableData: availableDataForGoldenCase(
        CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES[0],
      ),
    };

    expect(CREATIVE_DECISION_CENTER_BUYER_ACTION_RULES.length).toBeGreaterThan(5);
    expect(adaptCreativeDecisionCenterBuyerAction(engine, context)).toEqual(
      adaptCreativeDecisionCenterBuyerAction(engine, context),
    );
  });

  it("maps row-level golden cases to expected buyer actions without aggregate leakage", () => {
    const rowCases = CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.filter(
      (item) => item.scope === "row",
    );

    for (const item of rowCases) {
      const result = adaptCreativeDecisionCenterBuyerAction(
        engineFromGoldenCase(item),
        { availableData: availableDataForGoldenCase(item) },
      );

      expect(result.buyerAction, item.caseId).toBe(item.expectedBuyerAction);
      expect(result.uiBucket, item.caseId).toBe(item.expectedBuyerAction);
      expect(result.buyerAction, item.caseId).not.toBe("brief_variation");
      expect(result.ruleId, item.caseId).not.toBe("default-diagnose-data");
    }
  });

  it("keeps aggregate-only golden cases out of row buyer actions", () => {
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
  });

  it("falls back to diagnose_data when delivery proof is missing", () => {
    const engine = engineFromGoldenCase(
      CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.find(
        (item) => item.caseId === "GC-001",
      )!,
    );

    const result = adaptCreativeDecisionCenterBuyerAction(engine, {
      availableData: ["campaignStatus", "adsetStatus"],
    });

    expect(result.buyerAction).toBe("diagnose_data");
    expect(result.ruleId).toBe("diagnose-delivery-active-no-spend.missing_required_data");
    expect(result.missingData).toEqual(
      expect.arrayContaining(["adStatus", "spend24h", "impressions24h"]),
    );
  });

  it("falls back to diagnose_data when policy proof is missing", () => {
    const engine = engineFromGoldenCase(
      CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.find(
        (item) => item.caseId === "GC-004",
      )!,
    );

    const result = adaptCreativeDecisionCenterBuyerAction(engine, {
      availableData: ["reviewStatus"],
    });

    expect(result.buyerAction).toBe("diagnose_data");
    expect(result.ruleId).toBe(
      "diagnose-policy-disapproved-or-limited.missing_required_data",
    );
    expect(result.missingData).toEqual(
      expect.arrayContaining(["effectiveStatus", "policyReason"]),
    );
  });

  it("falls back to diagnose_data when launch basis is missing", () => {
    const engine = engineFromGoldenCase(
      CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.find(
        (item) => item.caseId === "GC-007",
      )!,
    );

    const result = adaptCreativeDecisionCenterBuyerAction(engine, {
      availableData: ["firstSeenAt"],
    });

    expect(result.buyerAction).toBe("diagnose_data");
    expect(result.ruleId).toBe("test-more-launch-monitoring.missing_required_data");
    expect(result.missingData).toContain("firstSpendAt");
  });

  it("keeps confidence banding deterministic for later row decisions", () => {
    expect(confidenceBand(78)).toBe("high");
    expect(confidenceBand(77)).toBe("medium");
    expect(confidenceBand(62)).toBe("medium");
    expect(confidenceBand(61)).toBe("low");
  });
});
