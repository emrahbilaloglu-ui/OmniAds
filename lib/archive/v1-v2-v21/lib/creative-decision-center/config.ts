import type { CreativeDecisionConfig } from "@/lib/creative-decision-center/contracts";

export const CREATIVE_DECISION_CENTER_V21_DEFAULT_CONFIG = {
  configVersion: "creative-decision-center.v2.1.config.v0",
  launchWindowHours: 72,
  noSpendWindowHours: 24,
  minSpendForMaturityMultiplier: 2,
  minPurchasesForScale: 5,
  minImpressionsForCtrReliability: 5000,
  fatigueCtrDropPct: 25,
  fatigueCpmIncreasePct: 20,
  fatigueFrequencyIncreasePct: 25,
  maxCpaOverTargetForCut: 1.8,
  minRoasOverTargetForScale: 1.25,
  winnerGapDays: 7,
  fatigueClusterTopN: 3,
  benchmarkReliabilityMinimum: "medium",
  staleDataHours: 36,
  minConfidenceForScale: 70,
  minConfidenceForCut: 70,
} as const satisfies CreativeDecisionConfig;

export function getCreativeDecisionCenterV21DefaultConfig(): CreativeDecisionConfig {
  return { ...CREATIVE_DECISION_CENTER_V21_DEFAULT_CONFIG };
}
