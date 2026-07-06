import { describe, expect, it } from "vitest";
import {
  applyDailyHysteresis,
  parseHysteresisState,
} from "../../jobs/campaign-context-job";

describe("campaign context daily hysteresis", () => {
  it("publishes the first resolved kind immediately", () => {
    const outcome = applyDailyHysteresis(null, "main", "high");
    expect(outcome.publishedKind).toBe("main");
    expect(outcome.publishedClass).toBe("high");
    expect(outcome.state).toEqual({
      stableKind: "main",
      stableClass: "high",
      pendingKind: null,
      pendingCount: 0,
      graceDaysUsed: 0,
      pendingConflictCount: 0,
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

  it("bridges short insufficient-evidence dips with the stable kind at reduced class", () => {
    const day1 = applyDailyHysteresis(null, "main", "high");
    const day2 = applyDailyHysteresis(day1.state, null, "unknown");
    expect(day2.publishedKind).toBe("main");
    expect(day2.publishedClass).toBe("medium");
    expect(day2.suppressedFlip).toBe(true);
    expect(day2.state.graceDaysUsed).toBe(1);
    const day3 = applyDailyHysteresis(day2.state, "main", "high");
    expect(day3.publishedKind).toBe("main");
    expect(day3.state.graceDaysUsed).toBe(0);
  });

  it("clears stable state after the grace budget so stale kinds cannot resume", () => {
    let state = applyDailyHysteresis(null, "main", "high").state;
    for (let day = 0; day < 3; day += 1) {
      const outcome = applyDailyHysteresis(state, null, "unknown");
      expect(outcome.publishedKind).toBe("main");
      state = outcome.state;
    }
    const day5 = applyDailyHysteresis(state, null, "unknown");
    expect(day5.publishedKind).toBeNull();
    expect(day5.state.stableKind).toBeNull();
    // A later return needs no confirmation only because it re-establishes
    // from a clean state, exactly like a new campaign.
    const day6 = applyDailyHysteresis(day5.state, "main", "medium");
    expect(day6.publishedKind).toBe("main");
  });

  it("absorbs a single-day conflict blip but surfaces a persistent conflict on day 2", () => {
    const day1 = applyDailyHysteresis(null, "main", "high");
    const day2 = applyDailyHysteresis(day1.state, null, "conflict");
    expect(day2.publishedKind).toBe("main");
    expect(day2.publishedClass).toBe("medium");
    expect(day2.suppressedFlip).toBe(true);
    const day3 = applyDailyHysteresis(day2.state, null, "conflict");
    expect(day3.publishedKind).toBeNull();
    expect(day3.publishedClass).toBe("conflict");
    expect(day3.state.stableKind).toBeNull();
  });

  it("surfaces conflict immediately when there is no stable kind", () => {
    const day1 = applyDailyHysteresis(null, null, "conflict");
    expect(day1.publishedKind).toBeNull();
    expect(day1.publishedClass).toBe("conflict");
  });

  it("resets the conflict counter when the kind resolves again", () => {
    const day1 = applyDailyHysteresis(null, "main", "high");
    const day2 = applyDailyHysteresis(day1.state, null, "conflict");
    const day3 = applyDailyHysteresis(day2.state, "main", "high");
    expect(day3.publishedKind).toBe("main");
    expect(day3.state.pendingConflictCount).toBe(0);
    // A fresh single-day conflict is again absorbed.
    const day4 = applyDailyHysteresis(day3.state, null, "conflict");
    expect(day4.publishedKind).toBe("main");
  });

  it("holds low-class stable kinds at low during grace", () => {
    const day1 = applyDailyHysteresis(null, "mixed", "low");
    const day2 = applyDailyHysteresis(day1.state, null, "unknown");
    expect(day2.publishedKind).toBe("mixed");
    expect(day2.publishedClass).toBe("low");
  });
});

describe("hysteresis state DB round-trip", () => {
  it("parses back every field the job persists (grace and conflict rules depend on it)", () => {
    let state = applyDailyHysteresis(null, "main", "high").state;
    state = applyDailyHysteresis(state, null, "unknown").state; // graceDaysUsed 1
    state = applyDailyHysteresis(state, null, "conflict").state; // pendingConflictCount 1
    const persisted = JSON.parse(JSON.stringify(state));
    expect(parseHysteresisState(persisted)).toEqual(state);
    // The persisted JSON must carry the counters, not just the kinds.
    expect(persisted.graceDaysUsed).toBeGreaterThan(0);
    expect(persisted.pendingConflictCount).toBeGreaterThan(0);
    expect(persisted.stableClass).toBe("high");
  });

  it("defaults legacy persisted shapes safely", () => {
    const legacy = { stableKind: "main", pendingKind: null, pendingCount: 0 };
    expect(parseHysteresisState(legacy)).toEqual({
      stableKind: "main",
      stableClass: null,
      pendingKind: null,
      pendingCount: 0,
      graceDaysUsed: 0,
      pendingConflictCount: 0,
    });
    expect(parseHysteresisState(null).stableKind).toBeNull();
  });

  it("survives a full grace cycle across simulated persistence", () => {
    let state = applyDailyHysteresis(null, "main", "high").state;
    for (let day = 0; day < 3; day += 1) {
      state = parseHysteresisState(JSON.parse(JSON.stringify(state)));
      const outcome = applyDailyHysteresis(state, null, "unknown");
      expect(outcome.publishedKind).toBe("main");
      state = outcome.state;
    }
    state = parseHysteresisState(JSON.parse(JSON.stringify(state)));
    const exhausted = applyDailyHysteresis(state, null, "unknown");
    expect(exhausted.publishedKind).toBeNull();
    expect(exhausted.state.stableKind).toBeNull();
  });
});
