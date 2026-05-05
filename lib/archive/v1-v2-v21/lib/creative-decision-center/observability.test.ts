import { describe, expect, it } from "vitest";
import {
  buildDecisionCenterRowDecisionEvents,
  hashDecisionCenterIdentifier,
  summarizeDecisionCenterSnapshot,
} from "@/lib/creative-decision-center/observability";
import {
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
  type DecisionCenterSnapshot,
} from "@/lib/creative-decision-center/contracts";

function snapshot(): DecisionCenterSnapshot {
  return {
    contractVersion: CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
    engineVersion: "engine-v21",
    adapterVersion: "adapter-v21",
    configVersion: "config-v21",
    generatedAt: "2026-04-30T00:00:00.000Z",
    dataFreshness: { status: "fresh", maxAgeHours: 2 },
    inputCoverageSummary: { totalCreatives: 1 },
    missingDataSummary: { truth: 1 },
    todayBrief: [],
    actionBoard: {
      scale: [],
      cut: [],
      refresh: [],
      protect: [],
      test_more: [],
      watch_launch: [],
      fix_delivery: [],
      fix_policy: [],
      diagnose_data: ["raw-row-id-123"],
    },
    rowDecisions: [
      {
        scope: "creative",
        creativeId: "raw-creative-id-456",
        rowId: "raw-row-id-123",
        identityGrain: "ad",
        engine: {
          contractVersion: CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
          engineVersion: "engine-v21",
          primaryDecision: "Diagnose",
          actionability: "diagnose",
          problemClass: "data_quality",
          confidence: 40,
          maturity: "learning",
          priority: "high",
          reasonTags: ["truth_missing"],
          evidenceSummary: "Truth missing.",
          blockerReasons: ["truth_missing"],
          missingData: ["truth"],
          queueEligible: false,
          applyEligible: false,
        },
        buyerAction: "diagnose_data",
        buyerLabel: "Diagnose data",
        uiBucket: "diagnose_data",
        confidenceBand: "low",
        priority: "high",
        oneLine: "Missing truth signal.",
        reasons: ["Truth missing."],
        nextStep: "Verify tracking.",
        missingData: ["truth"],
      },
    ],
    aggregateDecisions: [],
  };
}

describe("Decision Center observability helpers", () => {
  it("summarizes distribution and missing-data rates without raw creative payload", () => {
    const summary = summarizeDecisionCenterSnapshot(snapshot());

    expect(summary.actionDistribution.diagnose_data).toBe(1);
    expect(summary.missingDataRate).toBe(1);
    expect(summary.diagnoseDataRate).toBe(1);
    expect(summary.highConfidenceWithMissingDataCount).toBe(0);
    expect(JSON.stringify(summary)).not.toContain("raw-creative-id-456");
  });

  it("hashes row event identifiers and excludes raw IDs", () => {
    const events = buildDecisionCenterRowDecisionEvents({
      snapshot: snapshot(),
      salt: "test-salt",
    });
    const serialized = JSON.stringify(events);

    expect(events).toHaveLength(1);
    expect(events[0]?.rowHash).toBe(hashDecisionCenterIdentifier("raw-row-id-123", "test-salt"));
    expect(serialized).not.toContain("raw-row-id-123");
    expect(serialized).not.toContain("raw-creative-id-456");
    expect(serialized).not.toContain("Truth missing.");
  });
});
