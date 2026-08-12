import { describe, expect, it } from "vitest";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import {
  formatMoney,
  launchModeForRec,
  primaryLabelForRec,
  proposedBidDisplayValue,
  proposedBidMinorForExecute,
  uiActionKindForRec,
} from "./meta-card-utils";

function recommendation(
  overrides: Partial<MetaRecommendation> = {}
): MetaRecommendation {
  return {
    id: "rec-1",
    level: "adset",
    type: "bid_strategy_fit",
    lens: "structure",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: "Apply bid",
    title: "Apply bid",
    why: "Typed bid",
    summary: "Typed bid",
    recommendedAction: "Apply bid",
    expectedImpact: "Controlled delivery",
    evidence: [],
    timeframeContext: {
      coreVerdict: "act",
      selectedRangeOverlay: "none",
      historicalSupport: "none",
      seasonalityFlag: "none",
      note: null,
    },
    ...overrides,
  } as MetaRecommendation;
}

describe("Meta card currency honesty", () => {
  it("formats missing currency unitlessly with an explicit unavailable state", () => {
    expect(formatMoney(12.5, null)).toBe("12.5 (Currency unavailable)");
    expect(formatMoney(12.5, "not-a-code")).toBe(
      "12.5 (Currency unavailable)"
    );
  });

  it("preserves a genuine currency code", () => {
    const formatted = formatMoney(12.5, "TRY");
    expect(formatted).toContain("TRY");
    expect(formatted).not.toContain("USD");
    expect(formatted).not.toContain("Currency unavailable");
  });

  it("fails executable bid extraction closed without currency", () => {
    const rec = recommendation({
      proposedAction: { kind: "apply_bid", bidAmountMinor: 2200 },
    });

    expect(proposedBidMinorForExecute(rec)).toBeNull();
    expect(proposedBidMinorForExecute(rec, null)).toBeNull();
    expect(proposedBidMinorForExecute(rec, "invalid")).toBeNull();
    expect(proposedBidMinorForExecute(rec, "TRY")).toBe(2200);
  });

  it("keeps typed bid amounts available for read-only display", () => {
    const rec = recommendation({
      proposedAction: { kind: "apply_bid", bidAmountMinor: 2200 },
    });

    expect(proposedBidDisplayValue(rec)).toBe(22);
  });
});

describe("legacy recommendation write authority", () => {
  it.each(["execute_pause", "execute_resume", "execute_bid"] as const)(
    "fails an injected %s action closed to evidence review",
    (actionKind) => {
      const rec = recommendation({
        actionKind,
        primaryActionLabel: "Injected provider write",
        proposedAction:
          actionKind === "execute_bid"
            ? { kind: "apply_bid", bidAmountMinor: 2200 }
            : actionKind === "execute_pause"
              ? { kind: "pause" }
              : { kind: "resume" },
      });

      expect(uiActionKindForRec(rec)).toBe("review_drill");
      expect(launchModeForRec(rec)).toBeNull();
      expect(primaryLabelForRec(rec)).toBe("Review evidence");
    },
  );
});
