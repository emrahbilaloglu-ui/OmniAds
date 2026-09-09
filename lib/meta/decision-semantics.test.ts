import { describe, expect, it } from "vitest";
import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";

describe("projectMetaDecisionSemantics", () => {
  it.each([
    ["policy_blocked", "fix_policy", "policy", "operator"],
    ["delivery_no_spend_24h", "fix_delivery", "delivery", "operator"],
    ["tracking_anomaly", "repair_tracking", "tracking", "integration"],
    ["checkout_breakdown", "fix_checkout", "funnel", "operator"],
    ["landing_page_issue", "fix_landing_page", "funnel", "operator"],
    [
      "campaign_context_unresolved",
      "resolve_campaign_role",
      "campaign_context",
      "system",
    ],
    [
      "truth_commercial_stale",
      "confirm_commercial_target",
      "commercial_truth",
      "operator",
    ],
    ["stale_evidence", "refresh_decision_data", "data", "integration"],
  ] as const)(
    "serves %s as a blocked resolution rather than a buyer action",
    (badge, code, category, owner) => {
      expect(
        projectMetaDecisionSemantics({
          legacyBuyerAction: "diagnose_data",
          sourceLabel: "diagnose",
          lifecycleRole: "label_needed",
          badgeCodes: [badge],
        }),
      ).toMatchObject({
        decisionState: "blocked",
        legacyBuyerAction: "diagnose_data",
        buyerAction: null,
        resolution: { code, category, owner },
      });
    },
  );

  it("uses the persisted engine authority blocker before secondary evidence on a held verdict", () => {
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "test_more",
        sourceLabel: "test_more",
        lifecycleRole: "main",
        badgeCodes: ["campaign_context_unresolved"],
        blockerCodes: ["profile_hard_action_ineligible"],
        heldAction: "cut",
        authorityBlocker: "profile_hard_action_ineligible",
      }),
    ).toMatchObject({
      decisionState: "blocked",
      buyerAction: null,
      resolution: { code: "complete_hard_action_evidence" },
    });
  });

  it("uses structured commercial-truth evidence within a profile authority hold", () => {
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "test_more",
        sourceLabel: "test_more",
        lifecycleRole: "main",
        badgeCodes: [
          "campaign_context_unresolved",
          "truth_commercial_stale",
        ],
        blockerCodes: ["profile_hard_action_ineligible"],
        heldAction: "cut",
        authorityBlocker: "profile_hard_action_ineligible",
      }),
    ).toMatchObject({
      decisionState: "blocked",
      buyerAction: null,
      resolution: { code: "confirm_commercial_target" },
    });
  });

  it.each([
    {
      name: "missing recent evidence",
      badgeCodes: ["missing_recent_data"],
      code: "refresh_decision_data",
      category: "data",
      owner: "integration",
    },
    {
      name: "thin recent sample",
      badgeCodes: [],
      code: "await_recent_evidence",
      category: "system",
      owner: "system",
    },
  ] as const)(
    "keeps a D063 held Cut blocked for $name",
    ({ badgeCodes, code, category, owner }) => {
      expect(
        projectMetaDecisionSemantics({
          legacyBuyerAction: "test_more",
          sourceLabel: "test_more",
          lifecycleRole: "main",
          badgeCodes,
          blockerCodes: ["recent_recovery_unverifiable"],
          heldAction: "cut",
          authorityBlocker: "recent_recovery_unverifiable",
        }),
      ).toMatchObject({
        decisionState: "blocked",
        legacyBuyerAction: "test_more",
        buyerAction: null,
        resolution: { code, category, owner },
      });
    },
  );

  it("keeps a held verdict blocked even when its compatibility label is out of scope", () => {
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "diagnose_data",
        sourceLabel: "out_of_scope",
        lifecycleRole: "label_needed",
        badgeCodes: [],
        blockerCodes: ["native_profile_unavailable"],
        heldAction: "cut",
        authorityBlocker: "native_profile_unavailable",
      }),
    ).toMatchObject({
      decisionState: "blocked",
      buyerAction: null,
      resolution: { code: "restore_native_profile" },
    });
  });

  it("keeps a Scale actionable for every resolved role and holds only an unresolved one", () => {
    const base = {
      legacyBuyerAction: "scale" as const,
      sourceLabel: "scale",
      badgeCodes: [] as string[],
    };
    // A Main campaign carries most of an account's budget; demoting its Scale
    // to `monitor` on the role alone dropped the verdict with no blocker and
    // no reason. Only an unresolved role is untrustworthy context.
    for (const lifecycleRole of ["test", "main", "mixed"] as const) {
      expect(
        projectMetaDecisionSemantics({ ...base, lifecycleRole }),
      ).toMatchObject({ decisionState: "act", buyerAction: "scale" });
    }
    expect(
      projectMetaDecisionSemantics({ ...base, lifecycleRole: "role_unresolved" }),
    ).toMatchObject({ decisionState: "monitor", buyerAction: "scale" });
  });

  it("does not turn target-age metadata into a second buyer-action gate", () => {
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "cut",
        sourceLabel: "cut",
        lifecycleRole: "main",
        badgeCodes: ["truth_commercial_stale"],
      }),
    ).toMatchObject({
      decisionState: "act",
      buyerAction: "cut",
      resolution: null,
    });
  });

  it.each([
    [
      "cut",
      "test_more",
      "profile_hard_action_ineligible",
      "complete_hard_action_evidence",
    ],
    ["scale", "protect", "pending_transition", "await_decision_confirmation"],
    ["refresh", "protect", "source_freshness", "refresh_decision_data"],
  ] as const)(
    "serves a held %s as a blocked resolution instead of the published %s action",
    (heldAction, legacyBuyerAction, blockerCode, resolutionCode) => {
      expect(
        projectMetaDecisionSemantics({
          legacyBuyerAction,
          sourceLabel: legacyBuyerAction,
          lifecycleRole: "main",
          badgeCodes:
            blockerCode === "pending_transition" ? [blockerCode] : [],
          blockerCodes:
            blockerCode === "pending_transition" ? [] : [blockerCode],
          heldAction,
        }),
      ).toMatchObject({
        decisionState: "blocked",
        legacyBuyerAction,
        buyerAction: null,
        resolution: { code: resolutionCode },
      });
    },
  );

  it("keeps unresolved automatic context system-owned instead of requesting a label", () => {
    const projection = projectMetaDecisionSemantics({
      legacyBuyerAction: "diagnose_data",
      sourceLabel: "diagnose",
      lifecycleRole: "label_needed",
      badgeCodes: ["campaign_context_unresolved"],
    });

    expect(projection.resolution).toMatchObject({
      code: "resolve_campaign_role",
      owner: "system",
      label: "Automatic Classification Pending",
    });
    // D074b/D075 acceptance correction: resolution copy is system-owned
    // automatic-evidence phrasing — no operator input, no label vocabulary,
    // review-only until the automatic role resolves.
    expect(projection.resolution?.nextStep).toContain(
      "No operator input is required; hard actions stay review-only until the role resolves.",
    );
    expect(projection.resolution?.nextStep).not.toMatch(
      /[Ll]abel|save an explicit correction|provisional role/,
    );
  });

  it("keeps a stale cut verdict in provenance but blocks its buyer action", () => {
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "cut",
        sourceLabel: "cut",
        lifecycleRole: "main",
        badgeCodes: ["stale_evidence"],
      }),
    ).toMatchObject({
      decisionState: "blocked",
      legacyBuyerAction: "cut",
      buyerAction: null,
      resolution: {
        code: "refresh_decision_data",
        category: "data",
        owner: "integration",
      },
    });
  });

  /*
   * A HELD REFRESH IS IDENTIFIED BY ITS PREDICATE, NOT BY THE ACTION LABEL.
   *
   * `heldAction` is `DecisionOutput.blockedActionType`, and `finalizeDecision`
   * in lib/creative-decision-engine/gates/types.ts rewrites a held Refresh's
   * `blockedActionType` to "cut" on a Test campaign — the same
   * `applyTestCohortRefreshOverride` rewrite the label gets, applied to the
   * hold so a transform cannot silently drop it. Keying the resolution on
   * `heldAction === "refresh"` therefore skipped exactly the Test-cohort rows
   * the branch exists for.
   */
  it.each([
    {
      cohort: "main campaign (no transform)",
      heldAction: "refresh" as const,
      label: "Refresh Held — Ad Fatigue Evidence Missing",
    },
    {
      cohort: "test cohort, Refresh rewritten to Cut",
      heldAction: "cut" as const,
      label: "Cut Held — Ad Fatigue Evidence Missing",
    },
  ])(
    "resolves a held ad-fatigue gap on the $cohort",
    ({ heldAction, label }) => {
      const projection = projectMetaDecisionSemantics({
        legacyBuyerAction: "protect",
        sourceLabel: "keep",
        lifecycleRole: heldAction === "cut" ? "test" : "main",
        badgeCodes: ["lifecycle_unavailable"],
        blockerCodes: ["native_metrics_unavailable"],
        heldAction,
        authorityBlocker: "native_metrics_unavailable",
        predicateBlockers: [
          {
            predicate: "refresh_ad_lifecycle_evidence",
            observed: "unavailable",
            threshold: "fatigued",
          },
        ],
      });

      expect(projection.resolution).toEqual({
        code: "complete_hard_action_evidence",
        category: "system",
        owner: "system",
        label,
        nextStep:
          "The recent window decayed against this ad's own earlier period, but no ad-level fatigue verdict exists to confirm creative wear, so no provider action is authorized yet. The verdict resolves as sibling-ad exposure evidence accumulates.",
      });
      // The wrong answer: a data repair aimed at a feed that is already
      // current, owned by integration, for evidence the account has simply not
      // produced yet.
      expect(projection.resolution?.code).not.toBe("refresh_decision_data");
      expect(projection.resolution?.owner).not.toBe("integration");
    },
  );

  it("keeps the generic native-metrics reading when no lifecycle predicate is present", () => {
    // The predicate is what makes the specific copy true, so a held Cut under
    // the same authority blocker without it must NOT borrow the fatigue
    // sentence.
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "protect",
        sourceLabel: "keep",
        lifecycleRole: "test",
        badgeCodes: [],
        blockerCodes: ["native_metrics_unavailable"],
        heldAction: "cut",
        authorityBlocker: "native_metrics_unavailable",
        predicateBlockers: [],
      }).resolution,
    ).toMatchObject({
      code: "refresh_decision_data",
      owner: "integration",
      label: "Refresh Decision Data",
    });
  });

  it("excludes out-of-scope snapshots without fabricating a resolution", () => {
    expect(
      projectMetaDecisionSemantics({
        legacyBuyerAction: "diagnose_data",
        sourceLabel: "out_of_scope",
        lifecycleRole: "label_needed",
        badgeCodes: [],
      }),
    ).toEqual({
      decisionState: "not_applicable",
      legacyBuyerAction: "diagnose_data",
      buyerAction: null,
      resolution: null,
      heldAction: null,
    });
  });
});
