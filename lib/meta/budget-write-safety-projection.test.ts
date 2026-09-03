import { describe, expect, it } from "vitest";

import { projectBudgetPolicySafety } from "@/lib/meta/budget-write-safety-projection";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");

function facts(over: Record<string, unknown> = {}) {
  return {
    currentAmountMinor: 100_000,
    intendedAmountMinor: 120_000,
    nowMs: NOW,
    policy: {
      maxChangePercent: 25,
      minHoursBetweenChanges: 12,
      maxChangesPer7d: 3,
      maxAccountConcentrationPercent: 40,
    },
    history: {
      lastChangeAtMs: NOW - 13 * 3_600_000,
      changesInLast7d: 1,
      accountConcentrationPercent: 20,
    },
    ...over,
  };
}

describe("budget policy safety projection", () => {
  it("clears a real prior change once the persisted cooldown has elapsed", () => {
    const result = projectBudgetPolicySafety(facts());
    expect(result.cooldown.state).toBe("clear");
    expect(result.cap.state).toBe("clear");
  });

  it("engages cooldown only while the measured window is active", () => {
    const result = projectBudgetPolicySafety(facts({
      history: {
        lastChangeAtMs: NOW - 6 * 3_600_000,
        changesInLast7d: 1,
        accountConcentrationPercent: 20,
      },
    }));
    expect(result.cooldown.state).toBe("engaged");
    expect(result.cooldown.why).toContain("6.00h");
  });

  it.each([
    ["magnitude", { intendedAmountMinor: 130_000 }],
    ["frequency", { history: {
      lastChangeAtMs: NOW - 13 * 3_600_000,
      changesInLast7d: 3,
      accountConcentrationPercent: 20,
    } }],
    ["concentration", { history: {
      lastChangeAtMs: NOW - 13 * 3_600_000,
      changesInLast7d: 1,
      accountConcentrationPercent: 41,
    } }],
  ])("engages the cap for a measured %s breach", (_name, over) => {
    expect(projectBudgetPolicySafety(facts(over)).cap.state).toBe("engaged");
  });

  it("keeps missing or contradictory evidence unknown", () => {
    expect(projectBudgetPolicySafety(facts({ history: null })).cap.state).toBe("unknown");
    expect(projectBudgetPolicySafety(facts({ history: null })).cooldown.state)
      .toBe("unknown");
    expect(projectBudgetPolicySafety(facts({
      history: {
        lastChangeAtMs: NOW + 1,
        changesInLast7d: 0,
        accountConcentrationPercent: 10,
      },
    })).cooldown.state).toBe("unknown");
  });
});
