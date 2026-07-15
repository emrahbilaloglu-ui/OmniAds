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

  it("keeps a Test winner actionable while the same Main winner monitors", () => {
    const base = {
      legacyBuyerAction: "scale" as const,
      sourceLabel: "scale",
      badgeCodes: [] as string[],
    };
    expect(
      projectMetaDecisionSemantics({ ...base, lifecycleRole: "test" }),
    ).toMatchObject({ decisionState: "act", buyerAction: "scale" });
    expect(
      projectMetaDecisionSemantics({ ...base, lifecycleRole: "main" }),
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
    expect(projection.resolution?.nextStep).toContain("No label is required");
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
    });
  });
});
