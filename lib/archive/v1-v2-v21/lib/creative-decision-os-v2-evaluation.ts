import { readFileSync } from "node:fs";
import {
  CREATIVE_DECISION_OS_V2_PRIMARY_DECISIONS,
  resolveCreativeDecisionOsV2,
  type CreativeDecisionOsV2Input,
  type CreativeDecisionOsV2Output,
  type CreativeDecisionOsV2PrimaryDecision,
} from "@/lib/creative-decision-os-v2";

export const GOLD_LABELS_V0_PATH =
  "docs/operator-policy/creative-segmentation-recovery/reports/gold-labels-v0-2026-04-26/gold-labels-v0.json";

export type CreativeDecisionOsV2MismatchSeverity =
  | "severe"
  | "high"
  | "medium"
  | "low"
  | "none";

export interface CreativeGoldLabelV0Row {
  row_id: string;
  active_status: boolean;
  campaign_status?: string | null;
  adset_status?: string | null;
  spend?: number | null;
  roas?: number | null;
  recent_roas?: number | null;
  recent_purchases?: number | null;
  long90_roas?: number | null;
  active_benchmark_roas?: number | null;
  peer_median_spend?: number | null;
  trust_state?: string | null;
  baseline_reliability?: string | null;
  adjudicated_primary_decision: CreativeDecisionOsV2PrimaryDecision;
  actionability: CreativeDecisionOsV2Output["actionability"];
  current_adsecute_decision_raw?: string | null;
  current_adsecute_decision_mapped?: CreativeDecisionOsV2PrimaryDecision | null;
  severity_vs_adsecute?: "severe" | "high" | "medium" | "low" | null;
}

export interface CreativeGoldLabelsV0Artifact {
  version: string;
  row_count: number;
  rows: CreativeGoldLabelV0Row[];
}

export interface CreativeDecisionOsV2EvaluationRow {
  rowId: string;
  goldDecision: CreativeDecisionOsV2PrimaryDecision;
  v2Decision: CreativeDecisionOsV2PrimaryDecision;
  goldActionability: CreativeDecisionOsV2Output["actionability"];
  v2Actionability: CreativeDecisionOsV2Output["actionability"];
  currentAdsecuteDecision: string | null;
  currentAdsecuteMappedDecision: CreativeDecisionOsV2PrimaryDecision | null;
  severity: CreativeDecisionOsV2MismatchSeverity;
  currentSeverity: "severe" | "high" | "medium" | "low" | null;
  queueEligible: boolean;
  applyEligible: boolean;
  blockerReasons: string[];
  reasonTags: string[];
  evidenceSummary: string;
}

export interface CreativeDecisionOsV2DecisionScore {
  decision: CreativeDecisionOsV2PrimaryDecision;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CreativeDecisionOsV2Evaluation {
  artifactVersion: string;
  rowCount: number;
  macroF1: number;
  perDecision: CreativeDecisionOsV2DecisionScore[];
  confusionMatrix: Record<CreativeDecisionOsV2PrimaryDecision, Record<CreativeDecisionOsV2PrimaryDecision, number>>;
  mismatchCounts: Record<CreativeDecisionOsV2MismatchSeverity, number>;
  rows: CreativeDecisionOsV2EvaluationRow[];
  changedFromCurrent: CreativeDecisionOsV2EvaluationRow[];
  queueApplySafety: {
    queueEligibleCount: number;
    applyEligibleCount: number;
    directScaleCount: number;
    inactiveDirectScaleCount: number;
    watchPrimaryCount: number;
    scaleReviewPrimaryCount: number;
  };
}

export function readGoldLabelsV0(path = GOLD_LABELS_V0_PATH): CreativeGoldLabelsV0Artifact {
  return JSON.parse(readFileSync(path, "utf8")) as CreativeGoldLabelsV0Artifact;
}

export function mapGoldRowToV2Input(row: CreativeGoldLabelV0Row): CreativeDecisionOsV2Input {
  return {
    rowId: row.row_id,
    activeStatus: row.active_status,
    campaignStatus: row.campaign_status,
    adsetStatus: row.adset_status,
    spend: row.spend,
    roas: row.roas,
    recentRoas: row.recent_roas,
    recentPurchases: row.recent_purchases,
    long90Roas: row.long90_roas,
    activeBenchmarkRoas: row.active_benchmark_roas,
    peerMedianSpend: row.peer_median_spend,
    trustState: row.trust_state,
    baselineReliability: row.baseline_reliability,
  };
}

function isScaleCutPair(a: CreativeDecisionOsV2PrimaryDecision, b: CreativeDecisionOsV2PrimaryDecision) {
  return (
    (a === "Scale" && b === "Cut") ||
    (a === "Cut" && b === "Scale")
  );
}

export function classifyV2MismatchSeverity(
  gold: CreativeDecisionOsV2PrimaryDecision,
  predicted: CreativeDecisionOsV2PrimaryDecision,
): CreativeDecisionOsV2MismatchSeverity {
  if (gold === predicted) return "none";
  if (isScaleCutPair(gold, predicted)) return "severe";

  const highPairs = new Set([
    "Scale|Refresh",
    "Refresh|Scale",
    "Scale|Protect",
    "Protect|Scale",
    "Cut|Protect",
    "Protect|Cut",
    "Cut|Refresh",
    "Refresh|Cut",
  ]);
  if (highPairs.has(`${gold}|${predicted}`)) return "high";

  const mediumPairs = new Set([
    "Refresh|Test More",
    "Test More|Refresh",
    "Cut|Diagnose",
    "Diagnose|Cut",
    "Cut|Test More",
    "Test More|Cut",
    "Refresh|Protect",
    "Protect|Refresh",
    "Scale|Test More",
    "Test More|Scale",
  ]);
  if (mediumPairs.has(`${gold}|${predicted}`)) return "medium";
  return "low";
}

function zeroMatrix() {
  return Object.fromEntries(
    CREATIVE_DECISION_OS_V2_PRIMARY_DECISIONS.map((row) => [
      row,
      Object.fromEntries(CREATIVE_DECISION_OS_V2_PRIMARY_DECISIONS.map((col) => [col, 0])),
    ]),
  ) as Record<CreativeDecisionOsV2PrimaryDecision, Record<CreativeDecisionOsV2PrimaryDecision, number>>;
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}

export function evaluateCreativeDecisionOsV2Gold(
  artifact: CreativeGoldLabelsV0Artifact,
): CreativeDecisionOsV2Evaluation {
  const confusionMatrix = zeroMatrix();
  const rows = artifact.rows.map((row): CreativeDecisionOsV2EvaluationRow => {
    const output = resolveCreativeDecisionOsV2(mapGoldRowToV2Input(row));
    const severity = classifyV2MismatchSeverity(row.adjudicated_primary_decision, output.primaryDecision);
    confusionMatrix[row.adjudicated_primary_decision][output.primaryDecision] += 1;
    return {
      rowId: row.row_id,
      goldDecision: row.adjudicated_primary_decision,
      v2Decision: output.primaryDecision,
      goldActionability: row.actionability,
      v2Actionability: output.actionability,
      currentAdsecuteDecision: row.current_adsecute_decision_raw ?? null,
      currentAdsecuteMappedDecision: row.current_adsecute_decision_mapped ?? null,
      severity,
      currentSeverity: row.severity_vs_adsecute ?? null,
      queueEligible: output.queueEligible,
      applyEligible: output.applyEligible,
      blockerReasons: output.blockerReasons,
      reasonTags: output.reasonTags,
      evidenceSummary: output.evidenceSummary,
    };
  });

  const perDecision = CREATIVE_DECISION_OS_V2_PRIMARY_DECISIONS.map((decision) => {
    const tp = confusionMatrix[decision][decision];
    const fp = CREATIVE_DECISION_OS_V2_PRIMARY_DECISIONS.reduce(
      (sum, gold) => sum + (gold === decision ? 0 : confusionMatrix[gold][decision]),
      0,
    );
    const fn = CREATIVE_DECISION_OS_V2_PRIMARY_DECISIONS.reduce(
      (sum, predicted) => sum + (predicted === decision ? 0 : confusionMatrix[decision][predicted]),
      0,
    );
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return {
      decision,
      tp,
      fp,
      fn,
      precision: roundScore(precision * 100),
      recall: roundScore(recall * 100),
      f1: roundScore(f1 * 100),
    };
  });

  const mismatchCounts: Record<CreativeDecisionOsV2MismatchSeverity, number> = {
    severe: 0,
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
  };
  for (const row of rows) mismatchCounts[row.severity] += 1;

  const macroF1 = roundScore(
    perDecision.reduce((sum, row) => sum + row.f1, 0) / perDecision.length,
  );

  return {
    artifactVersion: artifact.version,
    rowCount: artifact.rows.length,
    macroF1,
    perDecision,
    confusionMatrix,
    mismatchCounts,
    rows,
    changedFromCurrent: rows.filter(
      (row) => row.currentAdsecuteMappedDecision && row.currentAdsecuteMappedDecision !== row.v2Decision,
    ),
    queueApplySafety: {
      queueEligibleCount: rows.filter((row) => row.queueEligible).length,
      applyEligibleCount: rows.filter((row) => row.applyEligible).length,
      directScaleCount: rows.filter(
        (row) => row.v2Decision === "Scale" && row.v2Actionability === "direct",
      ).length,
      inactiveDirectScaleCount: artifact.rows.filter((row, index) => {
        const evaluated = rows[index];
        return row.active_status === false &&
          evaluated?.v2Decision === "Scale" &&
          evaluated.v2Actionability === "direct";
      }).length,
      watchPrimaryCount: rows.filter((row) => row.v2Decision === ("Watch" as CreativeDecisionOsV2PrimaryDecision)).length,
      scaleReviewPrimaryCount: rows.filter(
        (row) => row.v2Decision === ("Scale Review" as CreativeDecisionOsV2PrimaryDecision),
      ).length,
    },
  };
}
