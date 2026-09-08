import { describe, expect, it } from "vitest";
import {
  enforceHardActionEligibility,
  finalizeDecision,
  type GateContext,
} from "../../gates/types";
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
  dataFreshnessHours?: number | null;
  hardActionEligibility?: HardActionEligibility;
  gate?: Partial<Omit<GateContext, "input" | "profile">>;
}) {
  return makeGateContext({
    input: makeCreativeInput({
      campaignKind: input.campaignKind,
      dataFreshnessHours:
        input.dataFreshnessHours === undefined
          ? 6
          : input.dataFreshnessHours,
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
    expect(output.preAuthorityLabel).toBe("cut");
    expect(output.authorityBlocker).toBeNull();
    expect(output.blockedActionType).toBeNull();
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
    expect(output.preAuthorityLabel).toBe("cut");
    expect(output.authorityBlocker).toBe(
      "profile_hard_action_ineligible",
    );
    expect(output.blockedActionType).toBe("cut");
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

  it("keeps an eligible hard decision unblocked", () => {
    const output = finalizeDecision(
      contextFor({ campaignKind: "main" }),
      "scale",
      "winner evidence supports promotion",
    );

    expect(output.label).toBe("scale");
    expect(output.preAuthorityLabel).toBe("scale");
    expect(output.authorityBlocker).toBeNull();
    expect(output.blockedActionType).toBeNull();
  });

  it("demotes stale scale while preserving the mathematical verdict", () => {
    const output = finalizeDecision(
      contextFor({ campaignKind: "main", dataFreshnessHours: 80 }),
      "scale",
      "winner evidence supports promotion",
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("scale");
    expect(output.authorityBlocker).toBe("source_freshness");
    expect(output.blockedActionType).toBe("scale");
  });

  it("keeps stale cut visible but marks it review-only", () => {
    const output = finalizeDecision(
      contextFor({ campaignKind: "main", dataFreshnessHours: 80 }),
      "cut",
      "stop-loss evidence supports pausing",
    );

    expect(output.label).toBe("cut");
    expect(output.preAuthorityLabel).toBe("cut");
    expect(output.authorityBlocker).toBe("source_freshness");
    expect(output.blockedActionType).toBe("cut");
  });

  it("enforces profile authority idempotently and preserves the first blocker", () => {
    const eligible = finalizeDecision(
      contextFor({ campaignKind: "main" }),
      "scale",
      "winner evidence supports promotion",
    );
    const profile = makeAccountDecisionProfile({
      hardActionEligibility: {
        scale: false,
        cut: true,
        refresh: true,
        reason: "scale authority unavailable",
      },
    });

    const once = enforceHardActionEligibility(eligible, profile);
    const twice = enforceHardActionEligibility(once, profile);

    expect(once).toMatchObject({
      label: "keep",
      preAuthorityLabel: "scale",
      authorityBlocker: "profile_hard_action_ineligible",
      blockedActionType: "scale",
    });
    expect(twice).toBe(once);
  });
});

describe("a label transform cannot silently drop a requested authority hold", () => {
  /**
   * The hold that vanished on Test campaigns, and manufactured an action.
   *
   * `finalizeDecision` runs `applyTestCohortRefreshOverride` FIRST — which on a
   * `test` campaign rewrites `refresh` into `cut` — and then decided whether to
   * honour the requested hold by comparing `authorityHold.blockedActionType`
   * against the ALREADY-REWRITTEN label. A caller asking to withhold a Refresh
   * (`{blockedActionType: "refresh", label: "keep"}`) therefore compared
   * `"cut" === "refresh"`, and the hold was discarded without a trace.
   *
   * What reached the operator: an ad with NO ad-level fatigue verdict, one the
   * economic Cut branch had just DECLINED, still carrying its
   * `refresh_ad_lifecycle_evidence` blocker and `lifecycle_unavailable` badge,
   * published at `decisionState: "act"` as an authorized Cut. Missing evidence
   * manufactured an action — the mirror of the rule that missing evidence must
   * not erase one.
   *
   * The two cases below are the SAME input with only `campaignKind` changed,
   * which is how the defect was isolated.
   */
  const hold = {
    authorityBlocker: "native_metrics_unavailable",
    blockedActionType: "refresh",
    label: "keep",
    reasonPrefix: "[held: no ad-level fatigue verdict]",
  } as const;

  it("holds the Refresh on a Main campaign", () => {
    const output = finalizeDecision(
      contextFor({ campaignKind: "main" }),
      "refresh",
      "Recent decay without a lifecycle verdict.",
      hold,
    );

    expect(output.label).toBe("keep");
    expect(output.preAuthorityLabel).toBe("refresh");
    expect(output.authorityBlocker).toBe("native_metrics_unavailable");
    expect(output.blockedActionType).toBe("refresh");
  });

  it("still holds it on a Test campaign, as the Cut the transform makes it", () => {
    const output = finalizeDecision(
      contextFor({ campaignKind: "test" }),
      "refresh",
      "Recent decay without a lifecycle verdict.",
      hold,
    );

    // The verdict is NOT published as an action.
    expect(output.label).toBe("keep");
    expect(output.authorityBlocker).toBe("native_metrics_unavailable");
    // And the withheld action names what is actually withheld: on a Test
    // campaign a Refresh IS a Cut, so the hold travels through the same
    // rewrite the label did rather than being dropped.
    expect(output.blockedActionType).toBe("cut");
    expect(output.preAuthorityLabel).toBe("cut");
  });

  it("leaves a Scale hold alone, because only refresh is ever rewritten", () => {
    // The guard against over-correcting: the transform touches `refresh` and
    // nothing else, so a Scale hold must be identical on both campaign kinds.
    const scaleHold = {
      authorityBlocker: "native_metrics_unavailable",
      blockedActionType: "scale",
      label: "keep",
      reasonPrefix: "[held: account benchmark missing]",
    } as const;
    const onMain = finalizeDecision(
      contextFor({ campaignKind: "main" }),
      "scale",
      "Scale zone with no account benchmark.",
      scaleHold,
    );
    const onTest = finalizeDecision(
      contextFor({ campaignKind: "test" }),
      "scale",
      "Scale zone with no account benchmark.",
      scaleHold,
    );

    for (const output of [onMain, onTest]) {
      expect(output.label).toBe("keep");
      expect(output.blockedActionType).toBe("scale");
      expect(output.preAuthorityLabel).toBe("scale");
    }
  });

  it("does not invent a hold the caller did not ask for", () => {
    // A hold whose `blockedActionType` does not match the verdict at all is
    // still refused — the fix moved WHICH label is compared, not whether one is.
    const output = finalizeDecision(
      contextFor({ campaignKind: "main" }),
      "cut",
      "Economic loss.",
      hold,
    );

    expect(output.blockedActionType).toBeNull();
    expect(output.authorityBlocker).toBeNull();
  });
});
