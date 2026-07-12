import { describe, expect, it } from "vitest";
import { classifyMetaCreativeAssessment } from "@/lib/meta/creative-assessment";

describe("classifyMetaCreativeAssessment", () => {
  it.each([
    ["test_more", [], null, "learning", "Learning"],
    ["keep", [], null, "stable", "Stable"],
    ["refresh", [], null, "refresh_candidate", "Refresh candidate"],
    ["out_of_scope", [], null, "out_of_scope", "Out of scope"],
  ] as const)(
    "classifies %s without the generic assessment fallback",
    (label, badgeCodes, heldAction, value, display) => {
      expect(
        classifyMetaCreativeAssessment({
          label,
          truthSource: "commercial_truth",
          badgeCodes,
          heldAction,
        }),
      ).toMatchObject({ value, label: display, blockerCode: null });
    },
  );

  it("preserves the held cut assessment while campaign context blocks execution", () => {
    expect(
      classifyMetaCreativeAssessment({
        label: "diagnose",
        truthSource: "commercial_truth",
        badgeCodes: ["campaign_context_unresolved", "stop_loss_review"],
        heldAction: "cut",
      }),
    ).toMatchObject({
      value: "below_target",
      label: "Underperformer",
      blockerCode: null,
    });
  });

  it.each([
    ["landing_page_issue", "funnel_bottleneck", "Funnel bottleneck"],
    ["checkout_breakdown", "funnel_bottleneck", "Funnel bottleneck"],
    ["tracking_anomaly", "decision_blocked", "Decision blocked"],
  ] as const)("classifies diagnose badge %s", (badge, value, display) => {
    expect(
      classifyMetaCreativeAssessment({
        label: "diagnose",
        truthSource: "commercial_truth",
        badgeCodes: [badge],
      }),
    ).toMatchObject({ value, label: display });
  });
});
