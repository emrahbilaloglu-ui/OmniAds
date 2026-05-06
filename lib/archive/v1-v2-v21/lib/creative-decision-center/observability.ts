import { createHash } from "node:crypto";
import type {
  CreativeDecisionCenterBuyerAction,
  DecisionCenterSnapshot,
} from "@/lib/creative-decision-center/contracts";
import { CREATIVE_DECISION_CENTER_BUYER_ACTIONS } from "@/lib/creative-decision-center/contracts";

export interface DecisionCenterObservabilitySummary {
  contractVersion: string;
  engineVersion: string;
  adapterVersion: string;
  configVersion: string;
  generatedAt: string;
  dataFreshnessStatus: DecisionCenterSnapshot["dataFreshness"]["status"];
  rowDecisionCount: number;
  aggregateDecisionCount: number;
  actionDistribution: Record<CreativeDecisionCenterBuyerAction, number>;
  missingDataRowCount: number;
  missingDataRate: number;
  diagnoseDataRate: number;
  highConfidenceWithMissingDataCount: number;
  fallbackRate: number;
}

export interface DecisionCenterRowDecisionEvent {
  rowHash: string;
  creativeHash: string;
  engineVersion: string;
  adapterVersion: string;
  configVersion: string;
  primaryDecision: string;
  action: CreativeDecisionCenterBuyerAction;
  confidenceBand: string;
  maturity: string;
  priority: string;
  problemClass: string;
  missingDataCount: number;
}

export function hashDecisionCenterIdentifier(value: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 24);
}

export function summarizeDecisionCenterSnapshot(
  snapshot: DecisionCenterSnapshot,
): DecisionCenterObservabilitySummary {
  const actionDistribution = CREATIVE_DECISION_CENTER_BUYER_ACTIONS.reduce(
    (acc, action) => {
      acc[action] = snapshot.actionBoard[action]?.length ?? 0;
      return acc;
    },
    {} as Record<CreativeDecisionCenterBuyerAction, number>,
  );

  const rowCount = snapshot.rowDecisions.length;
  const missingDataRowCount = snapshot.rowDecisions.filter(
    (item) => item.missingData.length > 0 || item.engine.missingData.length > 0,
  ).length;
  const diagnoseDataCount = snapshot.rowDecisions.filter(
    (item) => item.buyerAction === "diagnose_data",
  ).length;
  const highConfidenceWithMissingDataCount = snapshot.rowDecisions.filter(
    (item) =>
      item.confidenceBand === "high" &&
      (item.missingData.length > 0 || item.engine.missingData.length > 0),
  ).length;
  const fallbackCount = snapshot.rowDecisions.filter(
    (item) => item.buyerAction === "diagnose_data" || item.confidenceBand === "low",
  ).length;

  return {
    contractVersion: snapshot.contractVersion,
    engineVersion: snapshot.engineVersion,
    adapterVersion: snapshot.adapterVersion,
    configVersion: snapshot.configVersion,
    generatedAt: snapshot.generatedAt,
    dataFreshnessStatus: snapshot.dataFreshness.status,
    rowDecisionCount: rowCount,
    aggregateDecisionCount: snapshot.aggregateDecisions.length,
    actionDistribution,
    missingDataRowCount,
    missingDataRate: rowCount === 0 ? 0 : missingDataRowCount / rowCount,
    diagnoseDataRate: rowCount === 0 ? 0 : diagnoseDataCount / rowCount,
    highConfidenceWithMissingDataCount,
    fallbackRate: rowCount === 0 ? 0 : fallbackCount / rowCount,
  };
}

export function buildDecisionCenterRowDecisionEvents(input: {
  snapshot: DecisionCenterSnapshot;
  salt: string;
}): DecisionCenterRowDecisionEvent[] {
  return input.snapshot.rowDecisions.map((item) => ({
    rowHash: hashDecisionCenterIdentifier(item.rowId ?? item.creativeId, input.salt),
    creativeHash: hashDecisionCenterIdentifier(item.creativeId, input.salt),
    engineVersion: input.snapshot.engineVersion,
    adapterVersion: input.snapshot.adapterVersion,
    configVersion: input.snapshot.configVersion,
    primaryDecision: item.engine.primaryDecision,
    action: item.buyerAction,
    confidenceBand: item.confidenceBand,
    maturity: item.engine.maturity,
    priority: item.priority,
    problemClass: item.engine.problemClass,
    missingDataCount: new Set([...item.missingData, ...item.engine.missingData]).size,
  }));
}
