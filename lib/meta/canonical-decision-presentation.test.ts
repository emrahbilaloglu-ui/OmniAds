import { describe, expect, it } from "vitest";
import type { DecisionOutput } from "@/lib/creative-decision-engine/types";
import { projectCanonicalMetaDecisionPresentation } from "./canonical-decision-presentation";

function decision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    creativeId: "creative_1",
    creativeName: "Creative 1",
    label: "keep",
    preAuthorityLabel: "keep",
    authorityBlocker: null,
    blockedActionType: null,
    reason: "Continue observing the ad.",
    confidence: 55,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 0.9,
    badges: [{ type: "campaign_context_unresolved", label: "Campaign role unresolved", severity: "warning" }],
    metrics: { spend: 185, purchases: 2, roas: 1.9, recent7dRoas: 2.6 },
    campaignRoleStatus: "unresolved",
    campaignKind: null,
    campaignTestDimension: null,
    labelTransform: null,
    engineVersion: "v3-ad-test",
    generatedAt: "2026-09-24T17:00:00.000Z",
    ...overrides,
  };
}

function present(value: DecisionOutput) {
  return projectCanonicalMetaDecisionPresentation({
    decision: value,
    context: { creativeId: value.creativeId, identityGrain: "ad" },
    lifecycleRole: "role_unresolved",
    blockerCodes: ["campaign_context_low_confidence"],
    reviewOnly: true,
  });
}

describe("canonical Meta soft Keep presentation", () => {
  it("serves a role-only soft Keep as Monitor without a resolution or execution", () => {
    const result = present(decision());
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") return;
    expect(result.bridge.engine.primaryDecision).toBe("Protect");
    expect(result.semantics).toMatchObject({
      decisionState: "monitor",
      buyerAction: "protect",
      heldAction: null,
      resolution: null,
    });
    expect(result.executionAction).toBeNull();
    expect(result.bridge.engine.applyEligible).toBe(false);
  });

  it("keeps independent thin-calibration and weak-performance reviews visible", () => {
    for (const badge of ["scale_calibration_thin", "weak_performance"] as const) {
      const result = present(decision({
        badges: [
          { type: "campaign_context_unresolved", label: "Campaign role unresolved", severity: "warning" },
          { type: badge, label: badge, severity: "warning" },
        ],
      }));
      expect(result.kind).toBe("mapped");
      if (result.kind !== "mapped") continue;
      expect(result.bridge.engine.primaryDecision).toBe("Test More");
      expect(result.semantics.decisionState).toBe("monitor");
      expect(result.semantics.buyerAction).toBe("test_more");
      expect(result.executionAction).toBeNull();
    }
  });

  it("never releases a held Cut or an unresolved hard Scale", () => {
    const heldCut = present(decision({
      preAuthorityLabel: "cut",
      authorityBlocker: "campaign_context",
      blockedActionType: "cut",
    }));
    expect(heldCut.kind).toBe("mapped");
    if (heldCut.kind === "mapped") {
      expect(heldCut.semantics.decisionState).toBe("blocked");
      expect(heldCut.semantics.heldAction).toBe("cut");
      expect(heldCut.semantics.buyerAction).toBeNull();
      expect(heldCut.executionAction).toBeNull();
    }

    const hardScale = present(decision({
      label: "scale",
      preAuthorityLabel: "scale",
    }));
    expect(hardScale.kind).toBe("mapped");
    if (hardScale.kind === "mapped") {
      expect(hardScale.bridge.engine.primaryDecision).toBe("Diagnose");
      expect(hardScale.semantics.decisionState).toBe("blocked");
      expect(hardScale.semantics.buyerAction).toBeNull();
      expect(hardScale.executionAction).toBeNull();
    }
  });
});
