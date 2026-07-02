import { describe, expect, it } from "vitest";
import {
  applyCreativeCampaignLabelGuard,
  buildCreativeCampaignLabelMap,
  CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
  CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX,
} from "../campaign-label-guard";
import type { CreativeInput, DecisionLabel, DecisionOutput } from "../types";

function makeDecision(
  overrides: Partial<DecisionOutput> = {},
): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: "Creative 1",
    label: "scale",
    reason: "Strong winner against target.",
    confidence: 82,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 1.36,
    badges: [],
    metrics: {
      spend: 500,
      purchases: 8,
      roas: 3,
      recent7dRoas: 2.8,
    },
    engineVersion: "v3-test",
    generatedAt: "2026-05-04T12:00:00.000Z",
    ...overrides,
  };
}

function makeInput(campaignId: string | null): Pick<CreativeInput, "campaignId"> {
  return { campaignId };
}

function makeLabelMap() {
  return buildCreativeCampaignLabelMap([
    {
      campaignId: "campaign-main",
      kind: "main",
      testDimension: null,
    },
    {
      campaignId: "campaign-test",
      kind: "test",
      testDimension: "creative",
    },
    {
      campaignId: "campaign-mixed",
      kind: "mixed",
      testDimension: null,
    },
  ]);
}

function guard(
  label: DecisionLabel,
  campaignId: string | null,
  confidence = 82,
) {
  return applyCreativeCampaignLabelGuard({
    decision: makeDecision({ label, confidence }),
    input: makeInput(campaignId),
    campaignLabelsById: makeLabelMap(),
  });
}

describe("applyCreativeCampaignLabelGuard", () => {
  it("downgrades hard decisions with no campaign attribution to diagnose", () => {
    for (const label of ["scale", "cut", "refresh"] as const) {
      const decision = guard(label, null);

      expect(decision.label).toBe("diagnose");
      expect(decision.confidence).toBe(CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP);
      expect(decision.campaignLabelStatus).toBe("no_campaign");
      expect(decision.campaignKind).toBeNull();
      expect(decision.blockedActionType).toBe(label);
      expect(decision.badges.map((badge) => badge.type)).toContain(
        "unlabeled_campaign_context",
      );
    }
  });

  it("passes through soft decisions with no campaign attribution", () => {
    const decision = guard("test_more", null);

    expect(decision.label).toBe("test_more");
    expect(decision.confidence).toBe(82);
    expect(decision.campaignLabelStatus).toBe("no_campaign");
    expect(decision.campaignKind).toBeNull();
    expect(decision.blockedActionType).toBeNull();
    expect(decision.badges).toHaveLength(0);
  });

  it("passes through labeled main, test, and mixed campaigns", () => {
    expect(guard("scale", "campaign-main")).toMatchObject({
      label: "scale",
      campaignLabelStatus: "labeled",
      campaignKind: "main",
      campaignTestDimension: null,
    });
    expect(guard("cut", "campaign-test")).toMatchObject({
      label: "cut",
      campaignLabelStatus: "labeled",
      campaignKind: "test",
      campaignTestDimension: "creative",
    });
    expect(guard("refresh", "campaign-mixed")).toMatchObject({
      label: "refresh",
      campaignLabelStatus: "labeled",
      campaignKind: "mixed",
    });
  });

  it("downgrades unlabeled hard decisions to diagnose with a confidence cap", () => {
    for (const label of ["scale", "cut", "refresh"] as const) {
      const decision = guard(label, "campaign-unlabeled");

      expect(decision.label).toBe("diagnose");
      expect(decision.confidence).toBe(CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP);
      expect(decision.campaignLabelStatus).toBe("unlabeled");
      expect(decision.campaignKind).toBeNull();
      expect(decision.blockedActionType).toBe(label);
      if (label === "cut") {
        expect(decision.reason).toContain(
          "[Stop-loss review - label campaign before cut]",
        );
        expect(decision.badges.map((badge) => badge.type)).toContain(
          "stop_loss_review",
        );
      } else {
        expect(decision.reason).toMatch(CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX);
      }
      expect(decision.badges.map((badge) => badge.type)).toContain(
        "unlabeled_campaign_context",
      );
    }
  });

  it("preserves unlabeled soft decisions while adding context", () => {
    for (const label of [
      "keep",
      "test_more",
      "diagnose",
      "out_of_scope",
    ] as const) {
      const decision = guard(label, "campaign-unlabeled");

      expect(decision.label).toBe(label);
      expect(decision.campaignLabelStatus).toBe("unlabeled");
      expect(decision.blockedActionType).toBeNull();
      expect(decision.badges.map((badge) => badge.type)).toContain(
        "unlabeled_campaign_context",
      );
    }
  });

  it("does not raise confidence when applying the cap", () => {
    const decision = guard("cut", "campaign-unlabeled", 45);

    expect(decision.confidence).toBe(45);
  });

  it("is idempotent for already guarded decisions", () => {
    const once = guard("scale", "campaign-unlabeled");
    const twice = applyCreativeCampaignLabelGuard({
      decision: once,
      input: makeInput("campaign-unlabeled"),
      campaignLabelsById: makeLabelMap(),
    });

    expect(twice.reason).toBe(once.reason);
    expect(
      twice.badges.filter((badge) => badge.type === "unlabeled_campaign_context"),
    ).toHaveLength(1);
    expect(twice.blockedActionType).toBe("scale");
  });

  it("is idempotent for already guarded no-campaign decisions", () => {
    const once = guard("scale", null);
    const twice = applyCreativeCampaignLabelGuard({
      decision: once,
      input: makeInput(null),
      campaignLabelsById: makeLabelMap(),
    });

    expect(twice.reason).toBe(once.reason);
    expect(
      twice.badges.filter((badge) => badge.type === "unlabeled_campaign_context"),
    ).toHaveLength(1);
    expect(twice.campaignLabelStatus).toBe("no_campaign");
    expect(twice.blockedActionType).toBe("scale");
  });
});
