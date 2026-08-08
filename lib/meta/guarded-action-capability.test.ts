import { describe, expect, it } from "vitest";
import {
  META_EXECUTION_ENV_FLAG,
  isGuardedExecutionEnabled,
  resolveGuardedActionCapability,
} from "@/lib/meta/guarded-action-capability";
import type { MetaOsDecisionAction } from "@/lib/meta/decisions-os-contract";

function action(overrides: Partial<MetaOsDecisionAction> = {}): MetaOsDecisionAction {
  return {
    code: "pause_ad",
    label: "Pause ad",
    intent: "execute",
    targetLevel: "ad",
    providerMutation: "pause",
    scopeNote: "single ad",
    ...overrides,
  } as MetaOsDecisionAction;
}

const permissive = {
  killSwitchEngaged: false,
  viewerCanWrite: true,
  hasPersistedAuthority: true,
  env: { [META_EXECUTION_ENV_FLAG]: "1" },
};

describe("nothing reaches a provider unless everything permits it", () => {
  it("permits a provider call only when every guard is satisfied", () => {
    const state = resolveGuardedActionCapability({ action: action(), ...permissive });
    expect(state.capability).toBe("execute_eligible");
    expect(state.providerCallPermitted).toBe(true);
  });

  it("stops at a dry run while live execution is disabled", () => {
    const state = resolveGuardedActionCapability({
      action: action(),
      ...permissive,
      env: {},
    });
    expect(state.capability).toBe("dry_run_eligible");
    expect(state.providerCallPermitted).toBe(false);
    expect(state.reason).toContain("stops before the provider");
  });

  it("blocks entirely when the kill switch is engaged", () => {
    const state = resolveGuardedActionCapability({
      action: action(),
      ...permissive,
      killSwitchEngaged: true,
    });
    expect(state.capability).toBe("blocked");
    expect(state.providerCallPermitted).toBe(false);
  });

  it("refuses a viewer who may not write", () => {
    const state = resolveGuardedActionCapability({
      action: action(),
      ...permissive,
      viewerCanWrite: false,
    });
    expect(state.capability).toBe("review_only");
    expect(state.providerCallPermitted).toBe(false);
  });

  it("cannot execute without a persisted authorization for the exact action", () => {
    const state = resolveGuardedActionCapability({
      action: action(),
      ...permissive,
      hasPersistedAuthority: false,
    });
    expect(state.capability).toBe("preflight_eligible");
    expect(state.providerCallPermitted).toBe(false);
  });

  it("gives demo and synthetic rows no authority at all", () => {
    const state = resolveGuardedActionCapability({
      action: action(),
      ...permissive,
      isSynthetic: true,
    });
    expect(state.capability).toBe("review_only");
    expect(state.providerCallPermitted).toBe(false);
  });

  it("never turns a review-only decision into a write", () => {
    for (const intent of ["review", "manual", "brief", "launchpad"] as const) {
      const state = resolveGuardedActionCapability({
        action: action({ intent }),
        ...permissive,
      });
      expect(state.capability).toBe("review_only");
      expect(state.providerCallPermitted).toBe(false);
    }
  });

  it("refuses an execute intent that names no provider mutation", () => {
    const state = resolveGuardedActionCapability({
      action: action({ providerMutation: null }),
      ...permissive,
    });
    expect(state.capability).toBe("review_only");
  });

  it("hides the command when there is no action", () => {
    expect(
      resolveGuardedActionCapability({ action: null, ...permissive }).capability,
    ).toBe("hidden");
    expect(
      resolveGuardedActionCapability({ action: action({ intent: "none" }), ...permissive })
        .capability,
    ).toBe("hidden");
  });
});

describe("the execution flag fails closed", () => {
  it("is off when unset, empty or merely truthy-looking", () => {
    expect(isGuardedExecutionEnabled({})).toBe(false);
    expect(isGuardedExecutionEnabled({ [META_EXECUTION_ENV_FLAG]: "" })).toBe(false);
    expect(isGuardedExecutionEnabled({ [META_EXECUTION_ENV_FLAG]: "true" })).toBe(false);
    expect(isGuardedExecutionEnabled({ [META_EXECUTION_ENV_FLAG]: "yes" })).toBe(false);
    expect(isGuardedExecutionEnabled({ [META_EXECUTION_ENV_FLAG]: "0" })).toBe(false);
  });

  it("is on only for an exact opt-in", () => {
    expect(isGuardedExecutionEnabled({ [META_EXECUTION_ENV_FLAG]: "1" })).toBe(true);
  });

  it("is off in this repository's own default environment", () => {
    // Guards the shipped default: no build enables writes by accident.
    expect(isGuardedExecutionEnabled()).toBe(false);
  });
});
