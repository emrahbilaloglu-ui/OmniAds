import { describe, expect, it } from "vitest";
import { metaDecisionCommercialBasisText, metaDecisionConfidenceBasisText, metaDecisionRequirementText,
  projectMetaDecisionEvidenceRequirements, readMetaDecisionCalibrationEvidence } from "./decision-evidence-presentation";
import type { DecisionPredicateBlocker } from "@/lib/creative-decision-engine/types";

const receipt = () => ({ rowId: "original-cell", batchId: "original-batch", contractVersion: "engine-v3-native-ad-calibration.v7",
  cellScope: "objective_cohort_context", objective: "OUTCOME_SALES", funnelCohort: "purchase", optimizationContext: "purchase",
  windowStart: "2026-09-08", windowEnd: "2026-10-06", asOfCutoff: "2026-10-07T14:00:00Z",
  inputManifestHash: "a".repeat(64), batchInputManifestHash: "b".repeat(64), sourceManifestHash: "c".repeat(64),
  currency: "USD", targetRoas: 2.2, breakEvenRoas: 1.8, metaAov: 216.46207818930088, metaAovPurchases: 972,
  actionReadiness: { scale: { observedSampleCount: 6, requiredSampleCount: 30, ready: false },
    refresh: { observedSampleCount: 8, requiredSampleCount: 20, ready: false },
    spendUnitAuthority: { basis: "physical_account_purchase_aov_90d", baseSpendUnit: 98.39185372240948,
      accountAovEvidence: { sampleWindowStart: "2026-07-09", sampleWindowEnd: "2026-10-06" },
      observedShopifyAovEvidence: { meanAov: 9999 } } } });
const blocker = (observed: number | null = 6, threshold: number | string = 30): DecisionPredicateBlocker => ({
  predicate: "scale_account_benchmark_ready", observed, threshold, status: "failed", severity: "warning", reason: "legacy producer wording" });

describe("recorded decision evidence presentation", () => {
  it("carries exact Ad sample/cell/window/source without parsing producer prose or granting action", () => {
    const c = readMetaDecisionCalibrationEvidence(receipt())!;
    const result = projectMetaDecisionEvidenceRequirements({ blockers: [blocker()], calibration: c, heldAction: "scale", currency: "USD", evaluationId: "eval" });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ observed: 6, required: 30, unit: "ad_calibration_observations", sourceId: "original-cell",
      source: "referenced_native_calibration", window: { startDate: "2026-09-08", endDate: "2026-10-06" }, cell: { scope: "objective_cohort_context" } });
    expect(metaDecisionRequirementText(result[0]!)).toContain("6 / 30 Ad calibration observations");
    expect(metaDecisionRequirementText(result[0]!)).toContain("Other independent checks must also pass");
    expect(result[0]).not.toHaveProperty("buyerAction");
  });
  it("keeps missing winner P50 distinct from a thin sample, even with a readable cell", () => {
    const result = projectMetaDecisionEvidenceRequirements({ blockers: [blocker(null, "positive winner purchase P50")],
      calibration: readMetaDecisionCalibrationEvidence(receipt()), heldAction: "scale", currency: "USD", evaluationId: "eval" });
    expect(result[0]).toMatchObject({ observed: null, required: "positive winner purchase P50", unit: "purchases", source: "persisted_evaluation" });
    expect(result).toHaveLength(1);
  });
  it("reports absent or inconsistent calibration as unknown; Refresh counts are not invented", () => {
    const missing = projectMetaDecisionEvidenceRequirements({ blockers: [], calibration: null, heldAction: "refresh", currency: "USD", evaluationId: "eval" });
    expect(missing[0]).toMatchObject({ observed: null, required: null, status: "missing", cell: null, window: null });
    const c = readMetaDecisionCalibrationEvidence(receipt())!;
    const mismatch = projectMetaDecisionEvidenceRequirements({ blockers: [blocker(5)], calibration: c, heldAction: "scale", currency: "USD", evaluationId: "eval" });
    expect(mismatch[0]).toMatchObject({ observed: null, required: null, status: "missing" });
    expect(readMetaDecisionCalibrationEvidence({ ...receipt(), contractVersion: "unknown-v8" })).toBeNull();
    expect(readMetaDecisionCalibrationEvidence({ ...receipt(), sourceManifestHash: null })).toBeNull();
  });
  it("carries the D091 recorded commercial unit and explicit missing-data band basis", () => {
    const c = readMetaDecisionCalibrationEvidence(receipt())!;
    const text = metaDecisionCommercialBasisText(c);
    expect(text).toContain("Meta platform AOV 216.46 USD / Target ROAS 2.20");
    expect(text).toContain("98.39 USD");
    expect(text).toContain("972 attributed purchases, 2026-07-09–2026-10-06");
    expect(text).not.toContain("9999");
    expect(metaDecisionConfidenceBasisText({ rule: "missing_data_cap", missingData: ["scale_calibration"] }, "low", 55)).toContain("Missing Scale calibration caps");
    expect(metaDecisionConfidenceBasisText({ rule: "score_band", missingData: [] }, "medium", 55)).toContain("Band follows the recorded score");
    expect(metaDecisionConfidenceBasisText(undefined, "low", null)).toContain("basis unknown");
  });
  it("formats currency evidence without changing the recorded floor or filling NULL", () => {
    const result = projectMetaDecisionEvidenceRequirements({ blockers: [{ ...blocker(), predicate: "expanded_cut_recent_recovery_evidence", observed: 95.18, threshold: 98.39185372240948 }], calibration: null, heldAction: "cut", currency: "USD", evaluationId: "eval" });
    expect(result[0]?.required).toBe(98.39185372240948);
    expect(metaDecisionRequirementText(result[0]!)).toContain("95.18 / 98.39 USD");
  });
});
