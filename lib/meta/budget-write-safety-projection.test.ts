import { describe, expect, it } from "vitest";

import { projectBudgetPolicySafety } from "@/lib/meta/budget-write-safety-projection";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");

function facts(over: Record<string, unknown> = {}) {
  return {
    currentAmountMinor: 100_000,
    intendedAmountMinor: 120_000,
    currency: "TRY",
    nowMs: NOW,
    policy: {
      maxChangePercent: 25,
      minHoursBetweenChanges: 12,
      maxChangesPer7d: 3,
      maxAccountConcentrationPercent: 40,
      maxAmountMinor: 500_000,
      currency: "TRY",
      spendCeilingValid: true,
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
    ["monetary ceiling", { policy: {
      maxChangePercent: 25,
      minHoursBetweenChanges: 12,
      maxChangesPer7d: 3,
      maxAccountConcentrationPercent: 40,
      maxAmountMinor: 110_000,
      currency: "TRY",
      spendCeilingValid: true,
    } }],
    ["ceiling currency", { currency: "USD" }],
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

  it("allows an explicitly cleared ceiling but rejects a half-persisted pair", () => {
    const cleared = facts({
      policy: {
        ...facts().policy,
        maxAmountMinor: null,
        currency: null,
        spendCeilingValid: true,
      },
    });
    expect(projectBudgetPolicySafety(cleared).cap.state).toBe("clear");

    const invalid = facts({
      policy: {
        ...facts().policy,
        maxAmountMinor: null,
        currency: "TRY",
        spendCeilingValid: false,
      },
    });
    expect(projectBudgetPolicySafety(invalid).cap.state).toBe("unknown");
  });
});
