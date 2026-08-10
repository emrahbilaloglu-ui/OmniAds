import { describe, expect, it } from "vitest";
import {
  preflightPermitsExecution,
  runGuardedActionPreflight,
  type ObservedTarget,
  type PreflightTarget,
} from "@/lib/meta/guarded-action-preflight";

const checkedAt = "2026-08-08T12:00:00.000Z";

function target(overrides: Partial<PreflightTarget> = {}): PreflightTarget {
  return {
    entityType: "ad",
    entityId: "ad-1",
    providerAccountId: "act_1",
    expectedStatus: "ACTIVE",
    expectedCreativeId: "cr-1",
    expectedParentId: "adset-1",
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedTarget> = {}): ObservedTarget {
  return {
    entityId: "ad-1",
    providerAccountId: "act_1",
    status: "ACTIVE",
    creativeId: "cr-1",
    parentId: "adset-1",
    matchCount: 1,
    ...overrides,
  };
}

describe("preflight never contacts the provider", () => {
  it("reports that no provider was contacted, in every verdict", () => {
    for (const state of [observed(), observed({ matchCount: 0 }), null]) {
      const receipt = runGuardedActionPreflight({
        target: target(),
        observed: state,
        killSwitchEngaged: false,
        checkedAt,
      });
      expect(receipt.providerContacted).toBe(false);
    }
  });
});

describe("a verified target", () => {
  it("is ready when persisted state matches what the decision assumed", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: observed(),
      killSwitchEngaged: false,
      checkedAt,
    });
    expect(receipt.verdict).toBe("ready");
    expect(receipt.drift).toEqual([]);
    expect(preflightPermitsExecution(receipt)).toBe(true);
  });
});

describe("anything less than an exact match refuses", () => {
  it("refuses when the status moved since the decision was formed", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: observed({ status: "PAUSED" }),
      killSwitchEngaged: false,
      checkedAt,
    });
    expect(receipt.verdict).toBe("drifted");
    expect(receipt.drift.join(" ")).toContain("status is PAUSED");
    expect(preflightPermitsExecution(receipt)).toBe(false);
  });

  it("refuses when the creative behind the ad changed", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: observed({ creativeId: "cr-9" }),
      killSwitchEngaged: false,
      checkedAt,
    });
    expect(receipt.verdict).toBe("drifted");
    expect(receipt.drift.join(" ")).toContain("creative is cr-9");
  });

  it("refuses when the parent changed", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: observed({ parentId: "adset-9" }),
      killSwitchEngaged: false,
      checkedAt,
    });
    expect(receipt.verdict).toBe("drifted");
  });

  it("refuses when the account does not match", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: observed({ providerAccountId: "act_2" }),
      killSwitchEngaged: false,
      checkedAt,
    });
    expect(receipt.verdict).toBe("drifted");
    expect(receipt.drift.join(" ")).toContain("account is act_2");
  });

  it("refuses when nothing matches the identity", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: null,
      killSwitchEngaged: false,
      checkedAt,
    });
    expect(receipt.verdict).toBe("not_found");
    expect(preflightPermitsExecution(receipt)).toBe(false);
  });

  it("refuses when the identity matches more than one row", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: observed({ matchCount: 2 }),
      killSwitchEngaged: false,
      checkedAt,
    });
    expect(receipt.verdict).toBe("ambiguous");
    expect(preflightPermitsExecution(receipt)).toBe(false);
  });

  it("reports every difference, not merely the first", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: observed({ status: "PAUSED", creativeId: "cr-9" }),
      killSwitchEngaged: false,
      checkedAt,
    });
    expect(receipt.drift.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the kill switch outranks everything", () => {
  it("blocks even a target that would otherwise verify", () => {
    const receipt = runGuardedActionPreflight({
      target: target(),
      observed: observed(),
      killSwitchEngaged: true,
      checkedAt,
    });
    expect(receipt.verdict).toBe("blocked");
    expect(preflightPermitsExecution(receipt)).toBe(false);
  });
});
