import { describe, expect, it } from "vitest";

import {
  decisionTypeForProposedAction,
  evaluateScheduledAuthority,
  type ScheduledAuthorityGates,
} from "@/lib/meta/scheduled-action-execution";

const EXPECTATION = {
  providerAccountId: "act_1",
  expectedEnablingActorUserId: "22222222-2222-4222-8222-222222222222",
  expectedActivationControlVersion: "v-7",
  decisionType: "pause" as const,
};

function gates(overrides: Partial<ScheduledAuthorityGates> = {}): ScheduledAuthorityGates {
  return {
    releaseGateOpen: true,
    autoExecutionEnabled: true,
    enabledProviderAccountId: "act_1",
    enablingActorUserId: EXPECTATION.expectedEnablingActorUserId,
    activationControlVersion: "v-7",
    dryRunOnly: false,
    ...overrides,
  };
}

function evaluate(
  overrides: Partial<ScheduledAuthorityGates> = {},
  extra: { mode?: "manual" | "semi_auto" | "auto"; killSwitchEngaged?: boolean } = {},
) {
  return evaluateScheduledAuthority({
    gates: gates(overrides),
    expectation: EXPECTATION,
    mode: extra.mode ?? "auto",
    killSwitchEngaged: extra.killSwitchEngaged ?? false,
  });
}

/**
 * Unattended dispatch is not `kind: "scheduled"` plus optimism. Each of these
 * is a way the authority a claim was taken under can be gone by the time the
 * request would be made.
 */
describe("scheduled authority", () => {
  it("authorizes only when every condition holds", () => {
    expect(evaluate()).toEqual({ authorized: true });
  });

  it("refuses the moment the business STOP is engaged", () => {
    expect(evaluate({}, { killSwitchEngaged: true })).toEqual({
      authorized: false,
      refusal: "kill_switch_engaged",
    });
  });

  it("refuses in every mode but auto", () => {
    for (const mode of ["manual", "semi_auto"] as const) {
      expect(evaluate({}, { mode })).toEqual({
        authorized: false,
        refusal: "mode_not_auto",
      });
    }
  });

  it("never lets one account's activation enable another", () => {
    expect(evaluate({ enabledProviderAccountId: "act_2" })).toEqual({
      authorized: false,
      refusal: "account_not_activated",
    });
  });

  it("requires the exact admin the activation was performed by", () => {
    expect(evaluate({ enablingActorUserId: null })).toEqual({
      authorized: false,
      refusal: "enabling_actor_absent",
    });
    expect(
      evaluate({ enablingActorUserId: "33333333-3333-4333-8333-333333333333" }),
    ).toEqual({ authorized: false, refusal: "enabling_actor_absent" });
    // Not a user id at all.
    expect(evaluate({ enablingActorUserId: "meta_budget_automation_sweep" })).toEqual({
      authorized: false,
      refusal: "enabling_actor_absent",
    });
  });

  it("refuses when the activation it acts under has been superseded", () => {
    // The claim was taken under v-7; an operator has since re-activated.
    expect(evaluate({ activationControlVersion: "v-8" })).toEqual({
      authorized: false,
      refusal: "scheduled_authority_changed",
    });
    expect(evaluate({ activationControlVersion: null })).toEqual({
      authorized: false,
      refusal: "scheduled_authority_changed",
    });
  });

  it("refuses while rehearsal is on", () => {
    expect(evaluate({ dryRunOnly: true })).toEqual({
      authorized: false,
      refusal: "dry_run_guardrail",
    });
  });

  it("refuses a closed capability before anything else is considered", () => {
    expect(evaluate({ releaseGateOpen: false })).toEqual({
      authorized: false,
      refusal: "release_gate_closed",
    });
  });
});

describe("which standing mode governs an action", () => {
  it("puts pause and resume in one family", () => {
    // An operator who armed stopping delivery armed undoing that too.
    expect(decisionTypeForProposedAction("pause")).toBe("pause");
    expect(decisionTypeForProposedAction("resume")).toBe("pause");
  });

  it("maps the rest to their own families", () => {
    expect(decisionTypeForProposedAction("bid")).toBe("bid");
    expect(decisionTypeForProposedAction("budget")).toBe("budget");
    expect(decisionTypeForProposedAction("duplicate")).toBe("creative");
    expect(decisionTypeForProposedAction("launch")).toBe("creative");
  });
});
