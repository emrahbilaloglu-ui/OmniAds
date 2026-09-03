import { describe, expect, it } from "vitest";
import {
  META_AUTOMATIC_CONTEXT_REVIEW_REASON,
  META_CAMPAIGN_LABEL_GUARD_REASON,
  META_TEST_REFRESH_TO_CUT_REASON,
  META_TEST_SCALE_TO_PROMOTE_REASON,
  applyMetaCampaignLabelGuard,
  buildMetaCampaignLabelKindMap,
} from "@/lib/meta/campaign-label-guard";
import type { MetaCampaignLabel } from "@/lib/meta/campaign-labels";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

function automaticRoles(
  ...entries: Array<[campaignId: string, kind: MetaCampaignLabel["kind"]]>
) {
  return new Map(
    entries.map(([campaignId, kind]) => [
      campaignId,
      {
        kind,
        contextTrust: "high" as const,
        source: "system_inferred" as const,
      },
    ]),
  );
}

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec-1",
    level: "campaign",
    campaignId: "cmp-1",
    campaignName: "Campaign 1",
    type: "scale_for_volume",
    lens: "volume",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.88,
    confidenceReason: null,
    decisionState: "act",
    decision: "Scale this campaign",
    title: "Scale Campaign 1",
    why: "Campaign 1 is above the calibrated scale line.",
    summary: "Strong campaign.",
    recommendedAction: "Increase budget 10-15%.",
    expectedImpact: "More volume.",
    evidence: [{ label: "ROAS", value: "4.00x", tone: "positive" }],
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

describe("applyMetaCampaignLabelGuard", () => {
  it("passes through hard actions with a high-confidence automatic campaign role", () => {
    const input = rec();
    const result = applyMetaCampaignLabelGuard({
      recommendations: [input],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      campaignContextById: automaticRoles(["cmp-1", "main"]),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.downgradedCount).toBe(0);
    expect(result.recommendations[0]).toMatchObject(input);
    expect(result.recommendations[0]?.automationReadiness).toMatchObject({
      tier: "manual_review",
      autoExecuteEligible: false,
    });
  });

  it("does not let a legacy manual-role map authorize a hard action", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [rec()],
      campaignLabelsById: buildMetaCampaignLabelKindMap([
        { campaignId: "cmp-1", kind: "main" },
      ]),
      campaignContextById: new Map(),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.downgradedCount).toBe(1);
    expect(result.recommendations[0]).toMatchObject({
      decisionState: "watch",
      confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      automationReadiness: {
        autoExecuteEligible: false,
      },
    });
  });

  it("downgrades unlabeled campaign hard actions to soft-only watch", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [rec()],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      activeCampaignIds: ["cmp-1"],
    });
    const guarded = result.recommendations[0]!;

    expect(result.downgradedCount).toBe(1);
    expect(result.unlabeledCampaignIds).toEqual(["cmp-1"]);
    expect(guarded).toMatchObject({
      kind: "state",
      decisionLabel: "diagnose",
      decisionState: "watch",
      confidence: "low",
      confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      priority: "medium",
    });
    expect(guarded.confidenceScore).toBeLessThanOrEqual(0.45);
    expect(guarded.signalQuality).toMatchObject({
      quality_status: "campaign_context_unresolved",
      confidence_cap: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      campaign_context_action_authority: "review_only",
      blocked_action_type: "scale_for_volume",
    });
    expect(guarded.automationReadiness).toMatchObject({
      tier: "read_only",
      autoExecuteEligible: false,
      blockers: expect.arrayContaining(["campaign_context_unresolved"]),
    });
  });

  it("uses the parent campaign label for adset hard actions", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [
        rec({
          id: "adset-cut",
          level: "adset",
          campaignId: "cmp-2",
          adsetId: "adset-1",
          type: "adset_cut_spend",
          lens: "profitability",
        }),
      ],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      activeCampaignIds: ["cmp-2"],
    });

    expect(result.recommendations[0]).toMatchObject({
      decisionState: "watch",
      confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    });
    expect(result.unlabeledCampaignIds).toEqual(["cmp-2"]);
  });

  it("downgrades unlabeled optimization-event switch recommendations", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [
        rec({
          id: "g1",
          type: "scenario_g1_upper_funnel_event",
          decisionLabel: "switch",
          recommendedAction: "Test a separate ADD_TO_CART optimization lane.",
        }),
        rec({
          id: "g2",
          type: "scenario_g2_downshift_to_purchase",
          decisionLabel: "switch",
          recommendedAction: "Test a separate PURCHASE optimization lane.",
        }),
      ],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.downgradedCount).toBe(2);
    expect(result.recommendations).toHaveLength(2);
    for (const guarded of result.recommendations) {
      expect(guarded).toMatchObject({
        kind: "state",
        decisionLabel: "diagnose",
        decisionState: "watch",
        confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      });
    }
  });

  it("allows diagnostics, refreshes, rebuilds, state rows, and anomalies without labels", () => {
    const allowed = [
      rec({ id: "diag", type: "scenario_f1_roas_drop_diagnostic", decisionLabel: "diagnose" }),
      rec({ id: "refresh", type: "scenario_e1_frequency_fatigue", decisionLabel: "refresh" }),
      rec({ id: "rebuild", type: "scenario_k1_mixed_config_rebuild", decisionLabel: "rebuild" }),
      rec({ id: "state", type: "campaign_state", kind: "state", decisionState: "watch" }),
      rec({ id: "anomaly", kind: "anomaly", decisionLabel: "diagnose" }),
    ];

    const result = applyMetaCampaignLabelGuard({
      recommendations: allowed,
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.downgradedCount).toBe(0);
    expect(result.recommendations.map((item) => item.id)).toEqual(allowed.map((item) => item.id));
    expect(result.recommendations.every((item) => item.automationReadiness)).toBe(true);
  });

  it("turns refresh semantics into cut semantics for automatically classified Test campaigns", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [
        rec({
          id: "refresh",
          type: "scenario_e1_frequency_fatigue",
          decisionLabel: "refresh",
          recommendedAction: "Refresh creative.",
        }),
      ],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      campaignContextById: automaticRoles(["cmp-1", "test"]),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.downgradedCount).toBe(0);
    expect(result.recommendations[0]).toMatchObject({
      type: "scenario_e1_frequency_fatigue",
      decisionLabel: "cut",
      labelTransform: {
        reason: META_TEST_REFRESH_TO_CUT_REASON,
        campaignKind: "test",
        fromDecisionLabel: "refresh",
        toDecisionLabel: "cut",
      },
      signalQuality: {
        labelTransform: {
          reason: META_TEST_REFRESH_TO_CUT_REASON,
        },
      },
    });
    expect(result.recommendations[0]?.recommendedAction).toContain("Cut or stop this Test lane");
  });

  it("turns scale semantics into a promote-to-main payload for automatically classified Test campaigns", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [rec()],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      campaignContextById: automaticRoles(["cmp-1", "test"]),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.downgradedCount).toBe(0);
    expect(result.recommendations[0]).toMatchObject({
      id: "promote-test-to-main-rec-1",
      type: "promote_test_to_main",
      decisionLabel: "scale",
      labelTransform: {
        reason: META_TEST_SCALE_TO_PROMOTE_REASON,
        campaignKind: "test",
        fromType: "scale_for_volume",
        toType: "promote_test_to_main",
        fromDecisionLabel: "scale",
        toDecisionLabel: "scale",
      },
    });
    expect(result.recommendations[0]?.recommendedAction).toContain("Promote the validated Test setup");
  });

  it("keeps an automatic unresolved scale verdict explicit and review-only", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [rec()],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      campaignContextById: new Map([
        [
          "cmp-1",
          {
            kind: "test",
            contextTrust: "medium",
            source: "system_inferred",
          } as const,
        ],
      ]),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.recommendations[0]).toMatchObject({
      decisionLabel: "scale",
      decisionState: "watch",
      confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      campaignContext: {
        kind: "test",
        source: "system_inferred",
        confidence: "medium",
        trustedForAction: false,
      },
      automationReadiness: {
        autoExecuteEligible: false,
        blockers: expect.arrayContaining(["campaign_context_unresolved"]),
      },
    });
    expect(result.recommendations[0]?.campaignKind).toBeUndefined();
    expect(result.recommendations[0]?.kind).not.toBe("state");
  });

  it("downgrades account-level hard actions unless all active campaign roles resolve automatically", () => {
    const accountRec = rec({
      id: "budget",
      level: "account",
      campaignId: undefined,
      type: "budget_allocation",
      lens: "volume",
    });

    const partial = applyMetaCampaignLabelGuard({
      recommendations: [accountRec],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      campaignContextById: automaticRoles(["cmp-1", "main"]),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1", "cmp-2"],
    });
    expect(partial.accountLevelDowngraded).toBe(true);
    expect(partial.recommendations[0]?.confidenceReason).toBe(
      META_AUTOMATIC_CONTEXT_REVIEW_REASON,
    );

    const complete = applyMetaCampaignLabelGuard({
      recommendations: [accountRec],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      campaignContextById: automaticRoles(
        ["cmp-1", "main"],
        ["cmp-2", "test"],
      ),
      automaticContextEnabled: true,
      activeCampaignIds: ["cmp-1", "cmp-2"],
    });
    expect(complete.downgradedCount).toBe(0);
    expect(complete.recommendations[0]).toMatchObject(accountRec);
  });

  it("is idempotent for already downgraded recommendations", () => {
    const first = applyMetaCampaignLabelGuard({
      recommendations: [rec()],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      activeCampaignIds: ["cmp-1"],
    }).recommendations[0]!;
    const second = applyMetaCampaignLabelGuard({
      recommendations: [first],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      activeCampaignIds: ["cmp-1"],
    });

    expect(second.downgradedCount).toBe(0);
    expect(second.recommendations[0]).toMatchObject({
      confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      automationReadiness: {
        tier: "read_only",
      },
    });
  });
});
