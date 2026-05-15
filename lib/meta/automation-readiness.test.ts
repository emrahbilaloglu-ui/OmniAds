import { describe, expect, it } from "vitest";
import { deriveMetaAutomationReadiness } from "@/lib/meta/automation-readiness";
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
      expect.arrayContaining(["missing_live_preflight", "missing_rollback_plan"]),
    );
    expect(readiness.missingEvidence).toEqual(["live_preflight", "rollback_plan"]);
  });

  it("requires empirical outcomes, live preflight, and rollback proof before auto-execute", () => {
    const readiness = deriveMetaAutomationReadiness(rec(), {
      empiricalOutcomeModelAvailable: true,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
    });

    expect(readiness.tier).toBe("auto_execute");
    expect(readiness.autoExecuteEligible).toBe(true);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.missingEvidence).toEqual([]);
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
