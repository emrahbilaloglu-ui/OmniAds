import { describe, expect, it } from "vitest";
import { creativeAutomationReadiness } from "../automation-readiness";
import type { DecisionOutput } from "../types";

function decision(): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: "Creative 1",
    label: "cut",
    reason: "Clear loser.",
    confidence: 82,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 0.4,
    badges: [],
    metrics: {
      spend: 500,
      purchases: 1,
      roas: 0.8,
      recent7dRoas: 0.7,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-05-04T00:00:00.000Z",
  };
}

describe("creativeAutomationReadiness", () => {
  it("blocks auto-execute without empirical model, preflight, rollback, and monitor evidence", () => {
    const readiness = creativeAutomationReadiness({ decision: decision() });

    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.operatorReviewRequired).toBe(true);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        "no_empirical_outcome_model",
        "missing_executor",
        "missing_live_preflight",
        "missing_rollback_plan",
        "missing_post_action_monitor",
        "missing_holdout_plan",
        "missing_operator_enablement",
      ]),
    );
    expect(readiness.missingEvidence).toContain("creative_post_action_monitor");
  });

  it("still remains read-only even when mathematical gates pass", () => {
    const readiness = creativeAutomationReadiness({
      decision: decision(),
      executorAvailable: true,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
      postActionMonitorAvailable: true,
      holdoutPlanAvailable: true,
      operatorEnablementRecorded: true,
      backtestSummary: {
        hardActionPrecision: 0.91,
        hardActionRecall: 0.86,
        expectedCalibrationError: 0.04,
        criticalFalsePositiveRate: 0,
        highSeverityMissedOpportunityRate: 0.04,
        activeDecisionCoverage: 0.96,
        dataFreshnessPass: true,
        persistedCoveragePass: true,
        conflictFreePass: true,
        sampleSize: 200,
        hardActionKnownSampleSize: 200,
        hardConfidenceBuckets: [],
      },
    });

    expect(readiness.blockers).toEqual([]);
    expect(readiness.tier).toBe("read_only");
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.reason).toContain("explicit operator enablement");
  });
});
