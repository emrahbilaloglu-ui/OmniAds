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
  const label = overrides.label ?? "scale";
  return {
    creativeId: "creative-1",
    creativeName: "Creative 1",
    label,
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
    preAuthorityLabel: overrides.preAuthorityLabel ?? label,
    authorityBlocker: overrides.authorityBlocker ?? null,
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
      expect(decision.campaignRoleStatus).toBe("no_campaign");
      expect(decision.campaignKind).toBeNull();
      expect(decision.authorityBlocker).toBe("campaign_context");
      expect(decision.blockedActionType).toBe(label);
      expect(decision.badges.map((badge) => badge.type)).toContain(
        "campaign_context_unresolved",
      );
    }
  });

  it("passes through soft decisions with no campaign attribution", () => {
    const decision = guard("test_more", null);

    expect(decision.label).toBe("test_more");
    expect(decision.confidence).toBe(82);
    expect(decision.campaignRoleStatus).toBe("no_campaign");
    expect(decision.campaignKind).toBeNull();
    expect(decision.blockedActionType).toBeNull();
    expect(decision.badges).toHaveLength(0);
  });

  it("passes through labeled main, test, and mixed campaigns", () => {
    expect(guard("scale", "campaign-main")).toMatchObject({
      label: "scale",
      campaignRoleStatus: "resolved",
      campaignKind: "main",
      campaignTestDimension: null,
    });
    expect(guard("cut", "campaign-test")).toMatchObject({
      label: "cut",
      campaignRoleStatus: "resolved",
      campaignKind: "test",
      campaignTestDimension: "creative",
    });
    expect(guard("refresh", "campaign-mixed")).toMatchObject({
      label: "refresh",
      campaignRoleStatus: "resolved",
      campaignKind: "mixed",
    });
  });

  it("downgrades unlabeled hard decisions to diagnose with a confidence cap", () => {
    for (const label of ["scale", "cut", "refresh"] as const) {
      const decision = guard(label, "campaign-unlabeled");

      expect(decision.label).toBe("diagnose");
      expect(decision.confidence).toBe(CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP);
      expect(decision.campaignRoleStatus).toBe("unresolved");
      expect(decision.campaignKind).toBeNull();
      expect(decision.authorityBlocker).toBe("campaign_context");
      expect(decision.blockedActionType).toBe(label);
      if (label === "cut") {
        expect(decision.reason).toContain(
          "[Stop-loss review - automatic campaign role unresolved]",
        );
        expect(decision.badges.map((badge) => badge.type)).toContain(
          "stop_loss_review",
        );
      } else {
        expect(decision.reason).toMatch(CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX);
      }
      expect(decision.badges.map((badge) => badge.type)).toContain(
        "campaign_context_unresolved",
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
      expect(decision.campaignRoleStatus).toBe("unresolved");
      expect(decision.blockedActionType).toBeNull();
      expect(decision.badges.map((badge) => badge.type)).toContain(
        "campaign_context_unresolved",
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
      twice.badges.filter((badge) => badge.type === "campaign_context_unresolved"),
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
      twice.badges.filter((badge) => badge.type === "campaign_context_unresolved"),
    ).toHaveLength(1);
    expect(twice.campaignRoleStatus).toBe("no_campaign");
    expect(twice.blockedActionType).toBe("scale");
  });
});

describe("automatic campaign context trust classes (D033)", () => {
  function contextMap(
    trust: "override" | "high" | "medium" | "low" | "unknown" | "conflict",
    kind: "main" | "test" | "mixed" = "main",
  ) {
    return new Map([
      ["campaign-9", { kind, testDimension: null, contextTrust: trust }],
    ]);
  }

  it("trusts kind semantics only for high automatic trust (D074: no override path)", () => {
    const high = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "scale" }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("high", "test"),
    });
    expect(high.label).toBe("scale");
    expect(high.campaignRoleStatus).toBe("resolved");
    expect(high.campaignKind).toBe("test");
    expect(high.blockedActionType).toBeNull();

    // D074 removed the manual/override path entirely. A deserialized legacy
    // "override" trust is audit provenance only and must fail closed exactly
    // like an unresolved role.
    const override = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "scale" }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("override", "test"),
    });
    expect(override.label).toBe("diagnose");
    expect(override.campaignRoleStatus).toBe("unresolved");
    expect(override.blockedActionType).toBe("scale");
  });

  it("does not trust kind semantics when an automatic context row has no inferred kind", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "scale" }),
      input: makeInput("campaign-9"),
      campaignLabelsById: new Map([
        [
          "campaign-9",
          { kind: null, testDimension: null, contextTrust: "high" },
        ],
      ]),
    });

    expect(guarded.label).toBe("diagnose");
    expect(guarded.campaignRoleStatus).toBe("unresolved");
    expect(guarded.campaignKind).toBeNull();
    expect(guarded.blockedActionType).toBe("scale");
    expect(
      guarded.badges.some(
        (badge) => badge.type === "campaign_context_unresolved",
      ),
    ).toBe(true);
  });

  it("keeps mature cut visible but review-only at medium trust", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "cut", confidence: 78 }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("medium"),
    });
    expect(guarded.label).toBe("cut");
    expect(guarded.campaignRoleStatus).toBe("resolved");
    expect(guarded.campaignKind).toBeNull();
    expect(guarded.authorityBlocker).toBe("campaign_context");
    expect(guarded.blockedActionType).toBe("cut");
    expect(guarded.confidence).toBeLessThanOrEqual(
      CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
    );
    expect(
      guarded.badges.some(
        (badge) => badge.type === "campaign_context_low_confidence",
      ),
    ).toBe(true);
    expect(
      guarded.badges.some((badge) => badge.type === "stop_loss_review"),
    ).toBe(true);
  });

  it("keeps the scale verdict visible but blocked at medium trust", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "scale", confidence: 82 }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("medium"),
    });
    expect(guarded.label).toBe("scale");
    expect(guarded.authorityBlocker).toBe("campaign_context");
    expect(guarded.blockedActionType).toBe("scale");
    expect(guarded.confidence).toBeLessThanOrEqual(
      CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
    );
    expect(
      guarded.badges.some(
        (badge) => badge.type === "campaign_context_low_confidence",
      ),
    ).toBe(true);
  });

  it("suppresses kind semantics at medium trust", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "keep" }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("medium", "test"),
    });
    expect(guarded.campaignKind).toBeNull();
    expect(guarded.campaignRoleStatus).toBe("resolved");
  });

  it("keeps the cut verdict visible but blocked at unknown trust", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "cut", confidence: 80 }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("unknown"),
    });
    expect(guarded.label).toBe("cut");
    expect(guarded.authorityBlocker).toBe("campaign_context");
    expect(guarded.blockedActionType).toBe("cut");
    expect(guarded.confidence).toBeLessThanOrEqual(
      CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
    );
    expect(
      guarded.badges.some(
        (badge) => badge.type === "campaign_context_unresolved",
      ),
    ).toBe(true);
    expect(
      guarded.badges.some((badge) => badge.type === "stop_loss_review"),
    ).toBe(true);
  });

  it("marks conflict trust while preserving the review-only verdict", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "refresh", confidence: 75 }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("conflict"),
    });
    expect(guarded.label).toBe("refresh");
    expect(guarded.authorityBlocker).toBe("campaign_context");
    expect(guarded.blockedActionType).toBe("refresh");
    expect(
      guarded.badges.some(
        (badge) => badge.type === "campaign_context_conflict",
      ),
    ).toBe(true);
  });

  it("passes soft decisions at low trust with only the unresolved badge", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({ label: "keep" }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("low"),
    });
    expect(guarded.label).toBe("keep");
    expect(guarded.campaignRoleStatus).toBe("unresolved");
    expect(
      guarded.badges.some(
        (badge) => badge.type === "campaign_context_unresolved",
      ),
    ).toBe(true);
  });

  it("preserves an earlier freshness restriction when context also blocks", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({
        label: "cut",
        preAuthorityLabel: "cut",
        authorityBlocker: "source_freshness",
        blockedActionType: "cut",
      }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("unknown"),
    });

    expect(guarded.authorityBlocker).toBe("source_freshness");
    expect(guarded.blockedActionType).toBe("cut");
    expect(guarded.preAuthorityLabel).toBe("cut");
  });

  it("never clears a prior profile restriction when context becomes trusted", () => {
    const guarded = applyCreativeCampaignLabelGuard({
      decision: makeDecision({
        label: "keep",
        preAuthorityLabel: "scale",
        authorityBlocker: "profile_hard_action_ineligible",
        blockedActionType: "scale",
      }),
      input: makeInput("campaign-9"),
      campaignLabelsById: contextMap("high"),
    });

    expect(guarded.authorityBlocker).toBe(
      "profile_hard_action_ineligible",
    );
    expect(guarded.blockedActionType).toBe("scale");
    expect(guarded.preAuthorityLabel).toBe("scale");
  });
});
