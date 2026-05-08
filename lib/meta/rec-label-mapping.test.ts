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
        type: "entity_state",
        decisionState: "watch",
        recommendedAction: "No immediate operator action.",
      }),
    ).toBe("keep");
  });
});
