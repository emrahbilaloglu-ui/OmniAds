import { describe, expect, it, vi } from "vitest";
import { readMetaDecisionActionOutcomeLogsForRecommendationTypes } from "@/lib/meta/decision-outcomes";
import { attachMetaEmpiricalOutcomeSummariesFromLogs } from "@/lib/meta/empirical-outcome-integration";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

vi.mock("@/lib/meta/decision-outcomes", () => ({
  readMetaDecisionActionOutcomeLogsForRecommendationTypes: vi.fn(),
}));

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
    ...overrides,
  };
}

describe("Meta empirical outcome integration", () => {
  it("attaches scenario-level outcome summaries without enabling auto-execute alone", async () => {
    vi.mocked(readMetaDecisionActionOutcomeLogsForRecommendationTypes).mockResolvedValue(
      Array.from({ length: 12 }, () => ({
        rec_type: "adset_scale_budget",
        decision_label: "scale",
        action_type: "outcome",
        outcome_status: "positive",
      })) as never,
    );

    const [enriched] = await attachMetaEmpiricalOutcomeSummariesFromLogs({
      businessId: "biz-1",
      recommendations: [rec()],
    });

    expect(readMetaDecisionActionOutcomeLogsForRecommendationTypes).toHaveBeenCalledWith({
      businessId: "biz-1",
      providerAccountId: null,
      recTypes: ["adset_scale_budget"],
    });
    expect(enriched?.empiricalOutcomeSummary).toMatchObject({
      sampleSize: 12,
      judgedSampleSize: 12,
      confidenceBand: "high",
      controlledCausal: {
        sampleSize: 0,
        validTreatmentReceiptCount: 0,
        confidenceBand: "insufficient_sample",
      },
      autoEligible: false,
    });
    expect(enriched?.automationReadiness?.tier).toBe("backtest_candidate");
    expect(enriched?.automationReadiness?.blockers).not.toContain("no_empirical_outcome_model");
    expect(enriched?.automationReadiness?.blockers).toEqual(
      expect.arrayContaining([
        "missing_controlled_causal_evidence",
        "missing_valid_treatment_receipt",
        "missing_live_preflight",
        "missing_rollback_plan",
      ]),
    );
  });
});
