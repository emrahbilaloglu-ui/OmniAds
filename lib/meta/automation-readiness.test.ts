import { describe, expect, it } from "vitest";
import { deriveMetaAutomationReadiness } from "@/lib/meta/automation-readiness";
import { summarizeMetaDecisionOutcomes } from "@/lib/meta/empirical-outcomes";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec-1",
    level: "adset",
    campaignId: "cmp-1",
    campaignName: "Main campaign",
    adsetId: "adset-1",
    adsetName: "Purchase ad set",
    type: "adset_scale_budget",
    lens: "volume",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.86,
    confidenceReason: null,
    decisionState: "act",
    decision: "Scale this ad set carefully",
    title: "Purchase ad set can absorb more budget",
    why: "The ad set is above the calibrated ROAS line.",
    summary: "Strong purchase signal.",
    recommendedAction: "Increase ad set budget 10-15%.",
    expectedImpact: "More conversion volume.",
    evidence: [
      { label: "ROAS", value: "4.10x", tone: "positive" },
      { label: "Target ROAS", value: "2.20x", tone: "neutral" },
    ],
    timeframeContext: {
      coreVerdict: "Strong",
      selectedRangeOverlay: "Selected range supports scale.",
      historicalSupport: "History supports scale.",
      seasonalityFlag: "none",
      note: null,
    },
    signalQuality: { label_status: "main" },
    ...overrides,
  };
}

function controlledOutcomeRows(statuses: string[]) {
  return statuses.map((outcomeStatus, index) => {
    const recommendationFingerprint = `fingerprint-${index}`;
    const recId = `rec-${index}`;
    const experimentId = "experiment-1";
    const assignmentId = `assignment-${index}`;
    return {
      recommendationFingerprint,
      recId,
      treatmentReceiptValidated: true,
      causalAssignmentValidated: true,
      causalEstimateValidated: true,
      actionType: "outcome",
      outcomeStatus,
      payloadJson: {
        evidenceClass: "controlled_causal",
        causalDesign: {
          contractVersion: "meta-controlled-causal-design.v1",
          method: "randomized_controlled_trial",
          experimentId,
          assignmentId,
          estimateId: `estimate-${index}`,
        },
        treatmentReceipt: {
          contractVersion: "meta-treatment-receipt.v1",
          actionLogId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          recommendationFingerprint,
          recId,
          experimentId,
          assignmentId,
          status: "success",
          verificationStatus: "verified",
          executedAt: "2026-07-01T10:00:00.000Z",
          verifiedAt: "2026-07-01T10:05:00.000Z",
        },
      },
    };
  });
}

describe("deriveMetaAutomationReadiness", () => {
  it("keeps a high-confidence ad set scale candidate below auto-execute without empirical outcomes", () => {
    const readiness = deriveMetaAutomationReadiness(rec());

    expect(readiness.tier).toBe("backtest_candidate");
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.operatorReviewRequired).toBe(true);
    expect(readiness.blockers).toContain("no_empirical_outcome_model");
    expect(readiness.missingEvidence).toContain("empirical_outcome_backtest");
    expect(readiness.missingEvidence).toEqual(
      expect.arrayContaining(["live_preflight", "rollback_plan"]),
    );
  });

  it("does not allow auto-execute with empirical outcomes but missing preflight or rollback proof", () => {
    const readiness = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeModelAvailable: true,
    });

    expect(readiness.tier).toBe("backtest_candidate");
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        "missing_controlled_causal_evidence",
        "missing_valid_treatment_receipt",
        "missing_valid_random_assignment",
        "missing_valid_control_estimate",
        "missing_live_preflight",
        "missing_rollback_plan",
      ]),
    );
    expect(readiness.missingEvidence).toEqual(
      expect.arrayContaining([
        "controlled_causal_outcomes",
        "valid_treatment_receipt",
        "valid_random_assignment",
        "valid_control_estimate",
        "live_preflight",
        "rollback_plan",
      ]),
    );
  });

  it("does not let a legacy empirical-model flag stand in for causal evidence", () => {
    const readiness = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeModelAvailable: true,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
    });

    expect(readiness.tier).toBe("backtest_candidate");
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        "missing_controlled_causal_evidence",
        "missing_valid_treatment_receipt",
        "missing_valid_random_assignment",
        "missing_valid_control_estimate",
      ]),
    );
  });

  it("keeps high-confidence observational summaries out of auto-execute", () => {
    const summary = summarizeMetaDecisionOutcomes(
      Array.from({ length: 12 }, () => ({
        actionType: "outcome",
        outcomeStatus: "positive",
        payloadJson: {
          evidenceClass: "observational_pre_post",
          operatorActed: true,
        },
      })),
      { minSampleSize: 10 },
    );

    const readiness = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeSummary: summary,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
    });

    expect(summary.confidenceBand).toBe("high");
    expect(summary.autoEligible).toBe(false);
    expect(readiness.tier).toBe("backtest_candidate");
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        "missing_controlled_causal_evidence",
        "missing_valid_treatment_receipt",
        "missing_valid_random_assignment",
        "missing_valid_control_estimate",
      ]),
    );
  });

  it("allows receipt-backed controlled evidence only after every existing gate passes", () => {
    const summary = summarizeMetaDecisionOutcomes(
      controlledOutcomeRows(Array.from({ length: 10 }, () => "positive")),
      { minSampleSize: 10 },
    );

    const blocked = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeSummary: summary,
    });
    expect(summary.autoEligible).toBe(true);
    expect(blocked.autoExecuteEligible).toBe(false);
    expect(blocked.blockers).toEqual(
      expect.arrayContaining([
        "missing_live_preflight",
        "missing_rollback_plan",
        "missing_operator_enablement",
      ]),
    );

    const authorizationBlocked = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeSummary: summary,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
    });
    expect(authorizationBlocked.tier).toBe("backtest_candidate");
    expect(authorizationBlocked.autoExecuteEligible).toBe(false);
    expect(authorizationBlocked.blockers).toContain(
      "missing_operator_enablement",
    );

    const eligible = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeSummary: summary,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
      operatorEnablementAvailable: true,
    });
    expect(eligible.tier).toBe("auto_execute");
    expect(eligible.autoExecuteEligible).toBe(true);
    expect(eligible.blockers).toEqual([]);
    expect(eligible.missingEvidence).toEqual([]);
  });

  it("does not trust causal payload ids when assignment and control estimates are not registry-validated", () => {
    const summary = summarizeMetaDecisionOutcomes(
      controlledOutcomeRows(Array.from({ length: 10 }, () => "positive")).map(
        (row) => ({
          ...row,
          causalAssignmentValidated: false,
          causalEstimateValidated: false,
        }),
      ),
      { minSampleSize: 10 },
    );

    const readiness = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeSummary: summary,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
    });

    expect(summary.autoEligible).toBe(false);
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        "missing_controlled_causal_evidence",
        "missing_valid_random_assignment",
        "missing_valid_control_estimate",
      ]),
    );
  });

  it("blocks automation when empirical precision is below the floor", () => {
    const summary = summarizeMetaDecisionOutcomes(
      controlledOutcomeRows([
        "positive",
        "positive",
        "negative",
        "negative",
        "negative",
        "negative",
        "negative",
        "negative",
        "negative",
        "negative",
      ]),
      { minSampleSize: 10 },
    );

    const readiness = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeSummary: summary,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
    });

    expect(readiness.tier).toBe("backtest_candidate");
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.blockers).toContain("empirical_precision_below_floor");
  });

  it("keeps watch and diagnostic recommendations read-only", () => {
    const readiness = deriveMetaAutomationReadiness(
      rec({
        type: "scenario_f1_roas_drop_diagnostic",
        decisionLabel: "diagnose",
        decisionState: "watch",
        confidence: "medium",
        confidenceScore: 0.58,
      }),
    );

    expect(readiness.tier).toBe("read_only");
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        "diagnostic_or_watch_state",
        "not_action_state",
        "unsupported_action_class",
      ]),
    );
  });

  it("carries missing-label blockers from the campaign label guard", () => {
    const readiness = deriveMetaAutomationReadiness(
      rec({
        kind: "state",
        decisionLabel: "diagnose",
        decisionState: "watch",
        confidence: "low",
        confidenceScore: 0.45,
        confidenceReason: "unlabeled_campaign_soft_only",
        signalQuality: {
          quality_status: "missing_campaign_label",
          confidence_cap: "unlabeled_campaign_soft_only",
          label_status: "unlabeled",
        },
      }),
    );

    expect(readiness.tier).toBe("read_only");
    expect(readiness.blockers).toContain("missing_campaign_label");
    expect(readiness.missingEvidence).toContain("campaign_label");
  });

  it("blocks execution on automatic context uncertainty without asking for a label", () => {
    const readiness = deriveMetaAutomationReadiness(
      rec({
        decisionLabel: "scale",
        decisionState: "watch",
        confidenceReason: "automatic_campaign_context_review_only",
        signalQuality: {
          campaign_context_action_authority: "review_only",
        },
      }),
    );

    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.blockers).toContain("campaign_context_unresolved");
    expect(readiness.blockers).not.toContain("missing_campaign_label");
    expect(readiness.missingEvidence).toContain(
      "automatic_campaign_context_authority",
    );
  });

  it("keeps purchase event switch recommendations manual-review only", () => {
    const readiness = deriveMetaAutomationReadiness(
      rec({
        level: "campaign",
        adsetId: undefined,
        adsetName: undefined,
        type: "scenario_g2_downshift_to_purchase",
        decisionLabel: "switch",
        decisionState: "test",
        confidence: "medium",
        confidenceScore: 0.69,
        recommendedAction: "Test a separate PURCHASE optimization lane.",
      }),
    );

    expect(readiness.tier).toBe("manual_review");
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(readiness.blockers).toEqual(
      expect.arrayContaining([
        "no_empirical_outcome_model",
        "not_action_state",
        "unsupported_action_class",
      ]),
    );
  });
});
