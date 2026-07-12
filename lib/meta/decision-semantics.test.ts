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
