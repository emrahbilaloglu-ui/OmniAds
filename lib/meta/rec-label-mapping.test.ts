import { describe, expect, it } from "vitest";
import { decisionLabelForMetaRec, primaryLabelForMetaRec } from "@/lib/meta/rec-label-mapping";

describe("Meta rec label mapping", () => {
  it("does not map defensive scale_for_profitability actions to scale", () => {
    expect(
      decisionLabelForMetaRec({
        type: "scale_for_profitability",
        decisionState: "act",
        recommendedAction: "Do not scale; tighten the bid cap and reallocate spend.",
      }),
    ).toBe("tune");
  });

  it("uses backend-provided decision label before type inference", () => {
    expect(
      decisionLabelForMetaRec({
        type: "scale_for_profitability",
        decisionState: "act",
        recommendedAction: "Scale budget.",
        decisionLabel: "cut",
      }),
    ).toBe("cut");
  });

  it("maps anomalies to diagnose with diagnostic primary action", () => {
    const input = {
      kind: "anomaly" as const,
      type: "roas_drop_sudden",
      decisionState: "act" as const,
      recommendedAction: "Sudden ROAS drop",
    };

    expect(decisionLabelForMetaRec(input)).toBe("diagnose");
    expect(primaryLabelForMetaRec(input)).toBe("Open diagnostics");
  });

  it("keeps state rows from becoming diagnose just because they are watch state", () => {
    expect(
      decisionLabelForMetaRec({
        kind: "state",
        type: "campaign_state",
        decisionState: "watch",
        recommendedAction: "No immediate operator action.",
      }),
    ).toBe("keep");
  });

  it.each([
    ["scenario_m1_mid_funnel_efficient_scale", "scale", "Scale budget"],
    ["scenario_m2_mid_funnel_steady_keep", "keep", "Hold"],
    ["scenario_m3_mid_funnel_inefficient_cut", "cut", "Pause adset"],
    ["scenario_m4_mid_funnel_refresh", "refresh", "Refresh creative"],
    ["scenario_l1_lead_efficient_scale", "scale", "Scale budget"],
    ["scenario_l2_lead_steady_keep", "keep", "Hold"],
    ["scenario_l3_lead_inefficient_cut", "cut", "Pause adset"],
    ["scenario_l4_lead_refresh", "refresh", "Refresh creative"],
    ["scenario_t1_traffic_efficient_scale", "scale", "Scale budget"],
    ["scenario_t2_traffic_steady_keep", "keep", "Hold"],
    ["scenario_t3_traffic_inefficient_cut", "cut", "Pause adset"],
    ["scenario_t4_traffic_refresh", "refresh", "Refresh creative"],
    ["scenario_eg1_engagement_efficient_scale", "scale", "Scale budget"],
    ["scenario_eg2_engagement_steady_keep", "keep", "Hold"],
    ["scenario_eg3_engagement_inefficient_cut", "cut", "Pause adset"],
    ["scenario_eg4_engagement_refresh", "refresh", "Refresh creative"],
    ["scenario_g1_upper_funnel_event", "switch", "Switch optimization"],
    ["scenario_g2_downshift_to_purchase", "switch", "Switch to purchase"],
    ["scenario_k4_catalog_feed_first", "diagnose", "Open diagnostics"],
  ] as const)("maps %s to its decision and primary action labels", (type, decisionLabel, primaryLabel) => {
    const input = {
      type,
      decisionState: "act" as const,
      recommendedAction: primaryLabel,
    };

    expect(decisionLabelForMetaRec(input)).toBe(decisionLabel);
    expect(primaryLabelForMetaRec(input)).toBe(primaryLabel);
  });
});
