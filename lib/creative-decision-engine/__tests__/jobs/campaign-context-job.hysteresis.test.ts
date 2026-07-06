import { describe, expect, it } from "vitest";
import { applyDailyHysteresis } from "../../jobs/campaign-context-job";

describe("campaign context daily hysteresis", () => {
  it("publishes the first resolved kind immediately", () => {
    const outcome = applyDailyHysteresis(null, "main", "high");
    expect(outcome.publishedKind).toBe("main");
    expect(outcome.publishedClass).toBe("high");
    expect(outcome.state).toEqual({
      stableKind: "main",
      pendingKind: null,
      pendingCount: 0,
    });
  });

  it("suppresses a one-day kind flip and caps confidence at medium", () => {
    const day1 = applyDailyHysteresis(null, "main", "high");
    const day2 = applyDailyHysteresis(day1.state, "test", "high");
    expect(day2.publishedKind).toBe("main");
    expect(day2.publishedClass).toBe("medium");
    expect(day2.suppressedFlip).toBe(true);
    expect(day2.state.pendingKind).toBe("test");
    expect(day2.state.pendingCount).toBe(1);
  });

  it("confirms a kind change after two consecutive days", () => {
    const day1 = applyDailyHysteresis(null, "main", "high");
    const day2 = applyDailyHysteresis(day1.state, "mixed", "high");
    const day3 = applyDailyHysteresis(day2.state, "mixed", "high");
    expect(day3.publishedKind).toBe("mixed");
    expect(day3.publishedClass).toBe("high");
    expect(day3.state.stableKind).toBe("mixed");
    expect(day3.state.pendingCount).toBe(0);
  });

  it("resets the pending counter when the flip candidate changes", () => {
    const day1 = applyDailyHysteresis(null, "main", "high");
    const day2 = applyDailyHysteresis(day1.state, "test", "medium");
    const day3 = applyDailyHysteresis(day2.state, "mixed", "medium");
    expect(day3.publishedKind).toBe("main");
    expect(day3.state.pendingKind).toBe("mixed");
    expect(day3.state.pendingCount).toBe(1);
  });

  it("passes null resolutions through without advancing pending state", () => {
    const day1 = applyDailyHysteresis(null, "main", "high");
    const day2 = applyDailyHysteresis(day1.state, null, "unknown");
    expect(day2.publishedKind).toBeNull();
    expect(day2.publishedClass).toBe("unknown");
    expect(day2.state.stableKind).toBe("main");
  });
});
