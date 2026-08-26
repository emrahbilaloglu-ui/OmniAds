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

  /*
   * Empirical outcomes are what an operator reads as "how this kind of decision
   * has worked out HERE". Once two assigned accounts can hold the same rec type
   * (D-M011), a business-wide read answers that question with the other
   * account's history — and the summary carries a confidence band and an
   * automation-readiness tier, so it is evidence with consequences.
   */
  it("asks for one account's outcome history, not the business's", async () => {
    vi.mocked(readMetaDecisionActionOutcomeLogsForRecommendationTypes).mockResolvedValue(
      [] as never,
    );

    await attachMetaEmpiricalOutcomeSummariesFromLogs({
      businessId: "biz-1",
      providerAccountId: "act_1",
      recommendations: [rec()],
    });

    expect(readMetaDecisionActionOutcomeLogsForRecommendationTypes).toHaveBeenCalledWith({
      businessId: "biz-1",
      providerAccountId: "act_1",
      recTypes: ["adset_scale_budget"],
    });
  });

  /*
   * The consumption half. Two accounts share a rec type; the source answers
   * with only the requested account's rows — which is what the account-scoped
   * predicate in `readMetaDecisionActionOutcomeLogsForRecommendationTypes`
   * does — and the summary A receives must be built from A's twelve positives
   * alone, not from a pool that includes B's twelve negatives.
   */
  it("never builds one account's summary from the other's outcomes", async () => {
    const outcomeRows = (status: string) =>
      Array.from({ length: 12 }, () => ({
        rec_type: "adset_scale_budget",
        decision_label: "scale",
        action_type: "outcome",
        outcome_status: status,
      }));
    const byAccount: Record<string, unknown[]> = {
      act_1: outcomeRows("positive"),
      act_2: outcomeRows("negative"),
    };
    vi.mocked(readMetaDecisionActionOutcomeLogsForRecommendationTypes).mockImplementation(
      async (input) =>
        (input.providerAccountId
          ? (byAccount[input.providerAccountId] ?? [])
          : // A null account is the business-wide read, and it is what the
            // defect produced: both accounts' rows in one pool.
            [...byAccount.act_1!, ...byAccount.act_2!]) as never,
    );

    const [forAccountA] = await attachMetaEmpiricalOutcomeSummariesFromLogs({
      businessId: "biz-1",
      providerAccountId: "act_1",
      recommendations: [rec()],
    });
    const [forAccountB] = await attachMetaEmpiricalOutcomeSummariesFromLogs({
      businessId: "biz-1",
      providerAccountId: "act_2",
      recommendations: [rec()],
    });

    // Twelve each, not twenty-four: neither account's evidence is the pool.
    expect(forAccountA?.empiricalOutcomeSummary?.sampleSize).toBe(12);
    expect(forAccountB?.empiricalOutcomeSummary?.sampleSize).toBe(12);
    // ...and the two accounts reach OPPOSITE verdicts from the same rec type,
    // which a pooled read cannot express at all: A is twelve-for-twelve, B is
    // nought-for-twelve, and the pool would have shown each of them a 50%.
    expect(forAccountA?.empiricalOutcomeSummary).toMatchObject({
      positiveCount: 12,
      negativeCount: 0,
      precision: 1,
    });
    expect(forAccountB?.empiricalOutcomeSummary).toMatchObject({
      positiveCount: 0,
      negativeCount: 12,
      precision: 0,
    });
  });
});
