import { describe, expect, it } from "vitest";
import {
  CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS,
  CREATIVE_DECISION_CENTER_BUYER_ACTIONS,
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
  type CreativeDecisionCenterRowDecision,
  type CreativeDecisionOsV21Output,
  type DecisionCenterSnapshot,
} from "@/lib/creative-decision-center/contracts";
import { getCreativeDecisionCenterV21DefaultConfig } from "@/lib/creative-decision-center/config";
import {
  validateCreativeDecisionCenterAggregateDecision,
  validateCreativeDecisionCenterRowDecision,
  validateCreativeDecisionConfig,
  validateDecisionCenterSnapshot,
} from "@/lib/creative-decision-center/validators";

function engine(): CreativeDecisionOsV21Output {
  return {
    contractVersion: CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
    engineVersion: "test-engine",
    primaryDecision: "Diagnose",
    actionability: "diagnose",
    problemClass: "data_quality",
    confidence: 42,
    maturity: "learning",
    priority: "high",
    reasonTags: ["truth_missing"],
    evidenceSummary: "Truth signal is missing.",
    blockerReasons: ["truth_missing"],
    missingData: ["truth"],
    queueEligible: false,
    applyEligible: false,
  };
}

function rowDecision(): CreativeDecisionCenterRowDecision {
  return {
    scope: "creative",
    creativeId: "creative_1",
    rowId: "ad_1",
    identityGrain: "ad",
    familyId: null,
    engine: engine(),
    buyerAction: "diagnose_data",
    buyerLabel: "Diagnose data",
    uiBucket: "diagnose_data",
    confidenceBand: "low",
    priority: "high",
    oneLine: "Missing data prevents a confident recommendation.",
    reasons: ["Truth signal is missing."],
    nextStep: "Resolve missing truth fields.",
    missingData: ["truth"],
  };
}

function snapshot(): DecisionCenterSnapshot {
  return {
    contractVersion: CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
    engineVersion: "test-engine",
    adapterVersion: "test-adapter",
    configVersion: "test-config",
    generatedAt: "2026-04-30T00:00:00.000Z",
    dataFreshness: { status: "unknown", maxAgeHours: null },
    inputCoverageSummary: { truth: 0 },
    missingDataSummary: { truth: 1 },
    todayBrief: [
      {
        id: "brief_1",
        priority: "high",
        text: "Diagnose missing data.",
        rowIds: ["ad_1"],
      },
    ],
    actionBoard: {
      scale: [],
      cut: [],
      refresh: [],
      protect: [],
      test_more: [],
      watch_launch: [],
      fix_delivery: [],
      fix_policy: [],
      diagnose_data: ["ad_1"],
    },
    rowDecisions: [rowDecision()],
    aggregateDecisions: [],
  };
}

describe("Creative Decision Center V2.1 contracts", () => {
  it("keeps primary buyer actions separate from aggregate actions", () => {
    expect(CREATIVE_DECISION_CENTER_BUYER_ACTIONS).not.toContain(
      "brief_variation" as never,
    );
    expect(CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS).toContain(
      "brief_variation",
    );
  });

  it("validates row decisions and rejects queue/apply eligibility", () => {
    expect(validateCreativeDecisionCenterRowDecision(rowDecision())).toEqual({
      ok: true,
      errors: [],
    });

    expect(
      validateCreativeDecisionCenterRowDecision({
        ...rowDecision(),
        engine: { ...engine(), queueEligible: true },
      }).errors,
    ).toContain("rowDecision.engine.queueEligible: must be false for V2.1 MVP");
  });

  it("validates aggregate decisions separately from row buyer actions", () => {
    expect(
      validateCreativeDecisionCenterAggregateDecision({
        scope: "family",
        familyId: "family_1",
        action: "brief_variation",
        priority: "medium",
        confidence: 55,
        oneLine: "Family needs a backup variant.",
        reasons: ["No backup variant is available."],
        affectedCreativeIds: ["creative_1"],
        nextStep: "Prepare a family-level variation brief.",
        missingData: [],
      }),
    ).toEqual({ ok: true, errors: [] });
  });

  it("validates complete decisionCenter snapshots", () => {
    expect(validateDecisionCenterSnapshot(snapshot())).toEqual({
      ok: true,
      errors: [],
    });
    expect(
      validateDecisionCenterSnapshot({
        ...snapshot(),
        contractVersion: "creative-decision-center.v2",
      }).errors,
    ).toContain(
      "snapshot.contractVersion: expected creative-decision-center.v2.1",
    );
  });

  it("keeps config-as-data complete and conservative", () => {
    const config = getCreativeDecisionCenterV21DefaultConfig();

    expect(validateCreativeDecisionConfig(config)).toEqual({ ok: true, errors: [] });
    expect(config.configVersion).toBe("creative-decision-center.v2.1.config.v0");
    expect(config.launchWindowHours).toBe(72);
    expect(config.noSpendWindowHours).toBe(24);
    expect(config.minConfidenceForScale).toBeGreaterThanOrEqual(70);
    expect(config.minConfidenceForCut).toBeGreaterThanOrEqual(70);
    expect(config.benchmarkReliabilityMinimum).toBe("medium");
  });
});
