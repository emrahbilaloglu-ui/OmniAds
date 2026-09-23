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

    /* Major units, at the provider's offset for the currency the overlay will
       render beside the number. */
    expect(proposedBidDisplayValue(rec, "TRY")).toBe(22);
  });

  it("scales a display bid by the provider's offset, not a constant 100", () => {
    const rec = recommendation({
      proposedAction: { kind: "apply_bid", bidAmountMinor: 2200 },
    });

    /* Meta lists JPY at offset 1: ¥2,200 stays ¥2,200. The old constant
       divisor showed ¥22 for the bid cap about to be written. */
    expect(proposedBidDisplayValue(rec, "JPY")).toBe(2200);
  });

  it("shows no display bid at all when the currency has no provider offset", () => {
    const rec = recommendation({
      proposedAction: { kind: "apply_bid", bidAmountMinor: 2200 },
    });

    /* The overlay renders "—" for null. A missing bid cap in the confirmation
       dialog is recoverable; one that is wrong by 100x is not. */
    expect(proposedBidDisplayValue(rec, null)).toBeNull();
    expect(proposedBidDisplayValue(rec, "KWD")).toBeNull();
  });

  it("does not guess a unit for an undiscriminated targetValue amount", () => {
    /*
      `targetValue.bidValue` / `.bidAmount` / `.proposedBidCap` used to be
      returned untouched, so the function answered in minor units on one
      branch and major units on another. No producer writes those keys (the
      bid intent projection writes `proposedMinorUnits` / `currency` /
      `currencyExponent`) and none carries a `bidValueFormat`, so there is no
      evidence for what unit such a value would be in.
    */
    const rec = recommendation({
      targetValue: { bidValue: 2200 },
    });

    expect(proposedBidDisplayValue(rec, "TRY")).toBeNull();
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
