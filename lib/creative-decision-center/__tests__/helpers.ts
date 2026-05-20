import {
  CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
  CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterRowDecision,
  type CreativeDecisionOsV21Output,
  type DecisionCenterSnapshot,
} from "../contracts";
import { createEmptyActionBoard } from "../validators";

export function makeEngine(
  overrides: Partial<CreativeDecisionOsV21Output> = {},
): CreativeDecisionOsV21Output {
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
    ...overrides,
  };
}

export function makeRowDecision(
  overrides: Partial<CreativeDecisionCenterRowDecision> = {},
): CreativeDecisionCenterRowDecision {
  return {
    scope: "creative",
    creativeId: "creative_1",
    rowId: "ad_1",
    identityGrain: "ad",
    familyId: null,
    engine: makeEngine(),
    buyerAction: "diagnose_data",
    buyerLabel: "Diagnose data",
    uiBucket: "diagnose_data",
    confidenceBand: "low",
    priority: "high",
    oneLine: "Missing data prevents a confident recommendation.",
    reasons: ["Truth signal is missing."],
    nextStep: "Resolve missing truth fields.",
    missingData: ["truth"],
    ...overrides,
  };
}

export function makeAggregateDecision(
  overrides: Partial<CreativeDecisionCenterAggregateDecision> = {},
): CreativeDecisionCenterAggregateDecision {
  return {
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
    ...overrides,
  };
}

export function makeSnapshot(
  overrides: Partial<DecisionCenterSnapshot> = {},
): DecisionCenterSnapshot {
  const actionBoard = createEmptyActionBoard();
  actionBoard.diagnose_data = ["ad_1"];

  return {
    contractVersion: CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION,
    engineVersion: "test-engine",
    adapterVersion: "test-adapter",
    configVersion: "test-config",
    generatedAt: "2026-05-20T00:00:00.000Z",
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
    actionBoard,
    rowDecisions: [makeRowDecision()],
    aggregateDecisions: [],
    ...overrides,
  };
}
