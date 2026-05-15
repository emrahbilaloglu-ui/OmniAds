import { describe, expect, it } from "vitest";
import {
  META_CAMPAIGN_LABEL_GUARD_REASON,
  META_TEST_REFRESH_TO_CUT_REASON,
  META_TEST_SCALE_TO_PROMOTE_REASON,
  applyMetaCampaignLabelGuard,
  buildMetaCampaignLabelKindMap,
} from "@/lib/meta/campaign-label-guard";
import type { MetaCampaignLabel } from "@/lib/meta/campaign-labels";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

function label(campaignId: string, kind: MetaCampaignLabel["kind"] = "main"): MetaCampaignLabel {
  return {
    businessId: "biz-1",
    campaignId,
    kind,
    testDimension: null,
    source: "user",
    providerAccountId: "act-1",
    campaignName: `Campaign ${campaignId}`,
    labeledBy: "user-1",
    labeledAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
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
  it("passes through labeled campaign hard actions", () => {
    const input = rec();
    const result = applyMetaCampaignLabelGuard({
      recommendations: [input],
      campaignLabelsById: buildMetaCampaignLabelKindMap([label("cmp-1")]),
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.downgradedCount).toBe(0);
    expect(result.recommendations[0]).toBe(input);
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
      confidenceReason: META_CAMPAIGN_LABEL_GUARD_REASON,
      priority: "medium",
    });
    expect(guarded.confidenceScore).toBeLessThanOrEqual(0.45);
    expect(guarded.signalQuality).toMatchObject({
      quality_status: "missing_campaign_label",
      confidence_cap: META_CAMPAIGN_LABEL_GUARD_REASON,
      label_status: "unlabeled",
      blocked_action_type: "scale_for_volume",
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
      confidenceReason: META_CAMPAIGN_LABEL_GUARD_REASON,
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
      ],
      campaignLabelsById: buildMetaCampaignLabelKindMap([]),
      activeCampaignIds: ["cmp-1"],
    });

    expect(result.downgradedCount).toBe(1);
    expect(result.recommendations[0]).toMatchObject({
      kind: "state",
      decisionLabel: "diagnose",
      decisionState: "watch",
      confidenceReason: META_CAMPAIGN_LABEL_GUARD_REASON,
    });
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
    expect(result.recommendations).toEqual(allowed);
  });

  it("turns refresh semantics into cut semantics for labeled Test campaigns", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [
        rec({
          id: "refresh",
          type: "scenario_e1_frequency_fatigue",
          decisionLabel: "refresh",
          recommendedAction: "Refresh creative.",
        }),
      ],
      campaignLabelsById: buildMetaCampaignLabelKindMap([label("cmp-1", "test")]),
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

  it("turns scale semantics into a promote-to-main payload recommendation for labeled Test campaigns", () => {
    const result = applyMetaCampaignLabelGuard({
      recommendations: [rec()],
      campaignLabelsById: buildMetaCampaignLabelKindMap([label("cmp-1", "test")]),
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

  it("downgrades account-level hard actions unless all active campaigns are labeled", () => {
    const accountRec = rec({
      id: "budget",
      level: "account",
      campaignId: undefined,
      type: "budget_allocation",
      lens: "volume",
    });

    const partial = applyMetaCampaignLabelGuard({
      recommendations: [accountRec],
      campaignLabelsById: buildMetaCampaignLabelKindMap([label("cmp-1")]),
      activeCampaignIds: ["cmp-1", "cmp-2"],
    });
    expect(partial.accountLevelDowngraded).toBe(true);
    expect(partial.recommendations[0]?.confidenceReason).toBe(META_CAMPAIGN_LABEL_GUARD_REASON);

    const complete = applyMetaCampaignLabelGuard({
      recommendations: [accountRec],
      campaignLabelsById: buildMetaCampaignLabelKindMap([label("cmp-1"), label("cmp-2", "test")]),
      activeCampaignIds: ["cmp-1", "cmp-2"],
    });
    expect(complete.downgradedCount).toBe(0);
    expect(complete.recommendations[0]).toBe(accountRec);
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
    expect(second.recommendations[0]).toBe(first);
  });
});
