import { describe, expect, it } from "vitest";

import {
  buildServedCreativeClassifications,
  creativeDecisionStatusFallback,
} from "@/components/creatives/creative-served-classification";
import type { CreativesBriefingResponse } from "@/components/creatives/briefing/types";

function responseWithCanonical(input: {
  sourceLabel: string;
  buyerLabel: string | null;
  buyerAction: string | null;
  heldAction: string | null;
}) {
  return {
    actionNow: [
      {
        id: "card_1",
        creativeId: "creative_1",
        canonicalDecision: {
          creativeId: "creative_1",
          decisionId: "decision_1",
          sourceDecision: { label: input.sourceLabel },
          classification: {
            decisionState: input.heldAction ? "blocked" : "act",
            buyerLabel: input.buyerLabel,
            buyerAction: input.buyerAction,
            heldAction: input.heldAction,
          },
        },
      },
    ],
    watching: [],
    healthy: [],
  } as unknown as CreativesBriefingResponse;
}

describe("served creative classification copy", () => {
  it("maps canonical actions to buyer language without exposing engine fields", () => {
    const result = buildServedCreativeClassifications(
      responseWithCanonical({
        sourceLabel: "scale",
        buyerLabel: "Increase budget",
        buyerAction: "scale",
        heldAction: null,
      }),
    ).get("creative_1");

    expect(result).toMatchObject({
      label: "Increase budget",
      segment: "Act",
      detail: "Recommended action: Scale",
    });
    expect(result?.detail).not.toContain("Engine:");
    expect(result?.detail).not.toContain("Action:");
  });

  it("describes a held action without exposing its raw enum", () => {
    const result = buildServedCreativeClassifications(
      responseWithCanonical({
        sourceLabel: "cut",
        buyerLabel: null,
        buyerAction: null,
        heldAction: "fix_delivery",
      }),
    ).get("creative_1");

    expect(result).toMatchObject({
      label: "Cut",
      segment: "Blocked",
      detail: "Fix delivery is waiting for review",
    });
    expect(result?.detail).not.toContain("fix_delivery");
    expect(result?.detail).not.toContain("Held:");
  });

  it("describes missing recommendations without endpoint or serving jargon", () => {
    const states = ["loading", "unavailable", "available"] as const;
    const details = states.map(
      (state) => creativeDecisionStatusFallback(state).detail,
    );

    expect(details).toEqual([
      "Recommendation is loading.",
      "Recommendation is temporarily unavailable.",
      "No recommendation is available for this creative.",
    ]);
    expect(details.join(" ")).not.toMatch(/endpoint|served decision|context/i);
  });

  it("does not expose an unknown legacy engine enum", () => {
    const response = {
      actionNow: [
        {
          id: "card_2",
          creativeId: "creative_2",
          label: "internal_future_action",
        },
      ],
      watching: [],
      healthy: [],
    } as unknown as CreativesBriefingResponse;

    const result =
      buildServedCreativeClassifications(response).get("creative_2");

    expect(result?.label).toBe("Recommendation available");
    expect(result?.label).not.toContain("internal_future_action");
  });
});
