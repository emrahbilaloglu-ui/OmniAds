import { describe, expect, it } from "vitest";
import { finalizeDecision, type GateContext } from "../../gates/types";
import {
  TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
  TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX,
} from "../../test-cohort-semantic";
import type { HardActionEligibility } from "../../types";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeGateContext,
} from "../helpers";

function contextFor(input: {
  campaignKind?: "main" | "test" | "mixed" | null;
  hardActionEligibility?: HardActionEligibility;
  gate?: Partial<Omit<GateContext, "input" | "profile">>;
}) {
  return makeGateContext({
    input: makeCreativeInput({
      campaignKind: input.campaignKind,
      fatigueStatus: "fatigued",
      recent7dRoas: 1,
      recent7dSpend: 80,
    }),
    profile: makeAccountDecisionProfile({
      hardActionEligibility: input.hardActionEligibility ?? {
        scale: true,
        cut: true,
        refresh: true,
        reason: null,
      },
    }),
    gate: input.gate,
  });
}

describe("finalizeDecision - test cohort semantic transform", () => {
  it("turns Test refresh into cut before eligibility handling", () => {
    const output = finalizeDecision(
      contextFor({ campaignKind: "test" }),
      "refresh",
      "fatigued creative needs iteration",
    );

    expect(output.label).toBe("cut");
    expect(output.labelTransform).toBe(
      TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
    );
    expect(output.reason).toBe(
      `${TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX} fatigued creative needs iteration`,
    );
  });

  it("preserves the transform diagnostic when transformed cut is soft-blocked", () => {
    const output = finalizeDecision(
      contextFor({
        campaignKind: "test",
        gate: { ratioToTarget: 0.5 },
        hardActionEligibility: {
          scale: true,
          cut: false,
          refresh: true,
          reason: "cut disabled for test cohort",
        },
      }),
      "refresh",
      "fatigued creative needs iteration",
    );

    expect(output.label).toBe("test_more");
    expect(output.labelTransform).toBe(
      TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
    );
    expect(output.reason).toContain("[soft-only - cut blocked]");
    expect(output.reason).toContain(TEST_COHORT_REFRESH_TO_CUT_REASON_PREFIX);
    expect(output.badges.map((badge) => badge.type)).toContain("cut_candidate");
    expect(
      output.badges.filter((badge) => badge.type === "cut_candidate"),
    ).toHaveLength(1);
  });

  it("still emits cut when refresh would have been soft-blocked but cut is allowed", () => {
    const output = finalizeDecision(
      contextFor({
        campaignKind: "test",
        hardActionEligibility: {
          scale: true,
          cut: true,
          refresh: false,
          reason: "refresh disabled for low-confidence baselines",
        },
      }),
      "refresh",
      "fatigued creative needs iteration",
    );

    expect(output.label).toBe("cut");
    expect(output.labelTransform).toBe(
      TEST_COHORT_REFRESH_TO_CUT_LABEL_TRANSFORM,
    );
    expect(output.reason).not.toContain("[soft-only - refresh blocked]");
  });

  it("keeps Main refresh semantics unchanged", () => {
    const output = finalizeDecision(
      contextFor({ campaignKind: "main" }),
      "refresh",
      "fatigued creative needs iteration",
    );

    expect(output.label).toBe("refresh");
    expect(output.labelTransform ?? null).toBeNull();
    expect(output.reason).toBe("fatigued creative needs iteration");
  });
});
