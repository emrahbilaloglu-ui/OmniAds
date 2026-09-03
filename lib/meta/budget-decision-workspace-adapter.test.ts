import { describe, expect, it } from "vitest";

import {
  DIRECTION_TO_PROFILE_ACTION,
  META_BUDGET_PROPOSED_GOVERNANCE,
  buildWorkspaceBudgetGateInput,
  prospectiveAccountShare,
  type WorkspaceBudgetFacts,
  type WorkspaceChangeHistory,
} from "@/lib/meta/budget-decision-workspace-adapter";
import {
  META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
  evaluateBudgetDecisionGates,
} from "@/lib/meta/budget-decision-gates";
import {
  projectBudgetDecisionEvidencePanel,
  unavailableEvidencePanel,
} from "@/lib/meta/budget-decision-evidence-panel";

const unreadHistory: WorkspaceChangeHistory = {
  readState: "not_attempted",
  readStateWhy: "this route performs no change-history read",
  lastChangeAtMs: null,
  changesForEntityToday: null,
  changesInAccountToday: null,
  changesInBusinessToday: null,
  changesInFleetToday: null,
  accountChangesToday: null,
  fleetChangesToday: null,
  countSemantics: "prospective_including_candidate",
};

const measuredHistory: WorkspaceChangeHistory = {
  readState: "available",
  readStateWhy: "a successful read returned these counters",
  lastChangeAtMs: null,
  changesForEntityToday: 1,
  changesInAccountToday: 1,
  changesInBusinessToday: 1,
  changesInFleetToday: 1,
  accountChangesToday: 1,
  fleetChangesToday: 2,
  countSemantics: "prospective_including_candidate",
};

const facts = (over: Partial<WorkspaceBudgetFacts> = {}): WorkspaceBudgetFacts => ({
  direction: "increase",
  originMs: Date.parse("2026-09-01T00:00:00.000Z"),
  profile: null,
  profileSourceStatus: "read_failed",
  profileUnavailableWhy: "the account decision profile read failed",
  commercialTarget: null,
  roleResolved: false,
  providerCompatibilityKnown: false,
  automationEnabled: false,
  changeHistory: unreadHistory,
  knownBindings: [],
  ...over,
});

const withProfile = (
  scale: boolean,
  cut: boolean,
  over: Partial<WorkspaceBudgetFacts> = {},
): WorkspaceBudgetFacts =>
  facts({
    profile: {
      byAction: {
        scale: { eligible: scale, code: scale ? null : "no_scale_anchor", reason: scale ? null : "scale has no anchor" },
        cut: { eligible: cut, code: cut ? null : "no_cut_anchor", reason: cut ? null : "cut has no break-even" },
        refresh: { eligible: false, code: "refresh_code", reason: "refresh is a creative action" },
      },
      anchorExplanation: { spendUnit: 40, spendUnitSource: "operator_aov", lineage: ["a", "b"] },
      contractVersion: "adsecute.account-decision-profile.v1",
    },
    profileUnavailableWhy: null,
    ...over,
  });

describe("the adapter speaks the gate's own contract", () => {
  it("sends the GATE contract version, not the adapter's name", () => {
    const input = buildWorkspaceBudgetGateInput(facts());
    expect(input.contractVersion).toBe(META_BUDGET_DECISION_GATE_CONTRACT_VERSION);
    const wrong = evaluateBudgetDecisionGates({ ...input, contractVersion: "meta-budget-decision-workspace-adapter.v2" });
    expect(wrong.blockerCodes).toContain("input_contract_unsupported");
    expect(evaluateBudgetDecisionGates(input).blockerCodes).not.toContain("input_contract_unsupported");
  });
});

describe("direction decides which action's truth is consulted", () => {
  it("maps increase to scale and decrease to cut", () => {
    expect(DIRECTION_TO_PROFILE_ACTION).toEqual({ increase: "scale", decrease: "cut" });
  });

  it("an increase is eligible on scale=true even when cut is false", () => {
    // r2's `scale && cut` conjunction reported a CUT refusal on an INCREASE.
    const input = buildWorkspaceBudgetGateInput(withProfile(true, false, { direction: "increase" }));
    expect(input.commercialProfile?.hardActionEligible).toBe(true);
    expect(evaluateBudgetDecisionGates(input).blockerCodes).not.toContain("commercial_anchor_not_hard_action_eligible");
  });

  it("the same profile blocks a DECREASE, because cut is false", () => {
    const input = buildWorkspaceBudgetGateInput(withProfile(true, false, { direction: "decrease" }));
    expect(input.commercialProfile?.hardActionEligible).toBe(false);
    expect(evaluateBudgetDecisionGates(input).blockerCodes).toContain("commercial_anchor_not_hard_action_eligible");
  });

  it("and the inverse: cut=true, scale=false blocks the increase and clears the decrease", () => {
    expect(
      buildWorkspaceBudgetGateInput(withProfile(false, true, { direction: "increase" })).commercialProfile?.hardActionEligible,
    ).toBe(false);
    expect(
      buildWorkspaceBudgetGateInput(withProfile(false, true, { direction: "decrease" })).commercialProfile?.hardActionEligible,
    ).toBe(true);
  });

  it("carries that action's own code, never a union of every action's codes", () => {
    const increase = buildWorkspaceBudgetGateInput(withProfile(false, false, { direction: "increase" }));
    expect(increase.commercialProfile?.codes).toEqual(["no_scale_anchor"]);
    expect(increase.commercialProfile?.codes).not.toContain("no_cut_anchor");
    expect(increase.commercialProfile?.codes).not.toContain("refresh_code");
    const decrease = buildWorkspaceBudgetGateInput(withProfile(false, false, { direction: "decrease" }));
    expect(decrease.commercialProfile?.codes).toEqual(["no_cut_anchor"]);
  });

  it("never lets refresh stand in for a budget direction", () => {
    // refresh is eligible; scale and cut are not. Neither direction may pass.
    const profile = withProfile(false, false);
    profile.profile!.byAction.refresh = { eligible: true, code: null, reason: null };
    for (const direction of ["increase", "decrease"] as const) {
      const input = buildWorkspaceBudgetGateInput({ ...profile, direction });
      expect(input.commercialProfile?.hardActionEligible, direction).toBe(false);
    }
  });

  it("a failed profile read is unavailable, never ineligible and never eligible", () => {
    const input = buildWorkspaceBudgetGateInput(facts({ profile: null }));
    expect(input.commercialProfile).toBeNull();
    const verdict = evaluateBudgetDecisionGates(input);
    expect(verdict.blockerCodes).toContain("commercial_profile_unavailable");
    expect(verdict.blockerCodes).not.toContain("commercial_anchor_not_hard_action_eligible");
  });

  it("cites the canonical profile contract the truth came from", () => {
    const input = buildWorkspaceBudgetGateInput(withProfile(true, true));
    expect(input.commercialProfile?.contractVersion).toBe("adsecute.account-decision-profile.v1");
    expect(evaluateBudgetDecisionGates(input).lineage.commercialProfileContract).toBe(
      "adsecute.account-decision-profile.v1",
    );
  });
});

describe("unread change history is never a measured zero", () => {
  it("produces a stable blocker when no history was read", () => {
    // r2 sent every counter as 0 with lastChangeAtMs null, so the cooldown,
    // all four caps and the concentration control cleared on an absence.
    const verdict = evaluateBudgetDecisionGates(buildWorkspaceBudgetGateInput(facts()));
    expect(verdict.blockerCodes).toContain("change_safety_history_unavailable");
    expect(verdict.authority).toBe("blocked");
  });

  it.each([["unavailable"], ["partial"], ["not_attempted"]] as const)(
    "treats readState=%s as unread",
    (readState) => {
      const input = buildWorkspaceBudgetGateInput(
        facts({ changeHistory: { ...measuredHistory, readState } }),
      );
      expect(input.changeSafety.changesInAccountToday).toBeNull();
      expect(evaluateBudgetDecisionGates(input).blockerCodes).toContain("change_safety_history_unavailable");
    },
  );

  it("accepts a measured NO-PRIOR-CHANGE only when the read actually succeeded", () => {
    // Under prospective semantics the candidate is always counted, so "nothing
    // has happened yet today" is a count of ONE, not zero, with a null
    // lastChangeAtMs. A literal zero could not include the candidate and is
    // refused separately.
    const measuredNoPrior: WorkspaceChangeHistory = {
      ...measuredHistory,
      lastChangeAtMs: null,
      changesForEntityToday: 1, changesInAccountToday: 1,
      changesInBusinessToday: 1, changesInFleetToday: 1,
      accountChangesToday: 1, fleetChangesToday: 1,
    };
    const input = buildWorkspaceBudgetGateInput(facts({ changeHistory: measuredNoPrior }));
    expect(input.changeSafety.changesInAccountToday).toBe(1);
    expect(input.changeSafety.accountShareOfFleetChanges).toBe(1);
    const codes = evaluateBudgetDecisionGates(input).blockerCodes;
    expect(codes).not.toContain("change_safety_history_unavailable");
    expect(codes).not.toContain("input_counter_invalid");
  });

  it("converts pre-change counts to prospective once, on the server", () => {
    const preChange = buildWorkspaceBudgetGateInput(
      facts({ changeHistory: { ...measuredHistory, countSemantics: "pre_change", changesInAccountToday: 2, accountChangesToday: 2, fleetChangesToday: 3 } }),
    );
    // Two already happened; this candidate would be the third.
    expect(preChange.changeSafety.changesInAccountToday).toBe(3);
    const prospectiveInput = buildWorkspaceBudgetGateInput(
      facts({ changeHistory: { ...measuredHistory, changesInAccountToday: 3 } }),
    );
    expect(prospectiveInput.changeSafety.changesInAccountToday).toBe(3);
  });

  it("blocks one past the cap, and clears at it", () => {
    const at = (n: number) =>
      evaluateBudgetDecisionGates(
        buildWorkspaceBudgetGateInput(
          facts({ changeHistory: { ...measuredHistory, changesInAccountToday: n, accountChangesToday: 1, fleetChangesToday: 4 } }),
        ),
      ).blockerCodes;
    const cap = META_BUDGET_PROPOSED_GOVERNANCE.maxChangesPerAccountPerDay;
    // Prospective: a cap of n admits exactly the first n changes of the day.
    expect(at(cap)).not.toContain("change_safety_account_cap_conflict");
    expect(at(cap + 1)).toContain("change_safety_account_cap_conflict");
    expect(at(cap - 1)).not.toContain("change_safety_account_cap_conflict");
  });

  it("declares the prospective semantics on the input it hands the gate", () => {
    const input = buildWorkspaceBudgetGateInput(facts({ changeHistory: measuredHistory }));
    expect(input.changeSafety.countSemantics).toBe("prospective_including_candidate");
  });
});

describe("prospective concentration is domain-valid and inspectable", () => {
  it("counts the candidate on both sides, so a lone fleet change is a share of 1", () => {
    const share = prospectiveAccountShare({ ...measuredHistory, accountChangesToday: 1, fleetChangesToday: 1 });
    expect(share).toBe(1);
  });

  it("converts a pre-change pair once", () => {
    const share = prospectiveAccountShare({
      ...measuredHistory, countSemantics: "pre_change", accountChangesToday: 0, fleetChangesToday: 3,
    });
    // The candidate makes it 1 of 4.
    expect(share).toBeCloseTo(0.25, 10);
  });

  it("is unavailable — never zero — when the denominator is unknown", () => {
    expect(prospectiveAccountShare({ ...measuredHistory, fleetChangesToday: null })).toBeNull();
    expect(prospectiveAccountShare(unreadHistory)).toBeNull();
    const input = buildWorkspaceBudgetGateInput(facts({ changeHistory: { ...measuredHistory, fleetChangesToday: null } }));
    expect(input.changeSafety.accountShareOfFleetChanges).toBeNull();
    expect(evaluateBudgetDecisionGates(input).blockerCodes).toContain("change_safety_history_unavailable");
  });

  it("always lands inside [0,1]", () => {
    for (const [account, fleet] of [[0, 0], [1, 1], [1, 10], [5, 5], [0, 7]] as const) {
      const share = prospectiveAccountShare({ ...measuredHistory, accountChangesToday: account, fleetChangesToday: fleet });
      if (share !== null) {
        expect(share).toBeGreaterThanOrEqual(0);
        expect(share).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("an unread fact arrives as unread, never as a permissive default", () => {
  it("passes explicit absences for everything the workspace has not read", () => {
    const input = buildWorkspaceBudgetGateInput(facts());
    expect(input.budgetFact).toBeNull();
    expect(input.evidence.windowSupported).toBe(false);
    for (const field of ["observationAsOfMs", "trailingDays", "spendBearingDays", "conversions", "budgetIsBinding"] as const) {
      expect(input.evidence[field], field).toBeNull();
    }
    expect(input.intent).toBeNull();
    expect(input.roleResolved).toBe(false);
  });

  it("makes the gate name every floor it could not measure", () => {
    const verdict = evaluateBudgetDecisionGates(buildWorkspaceBudgetGateInput(facts()));
    for (const code of [
      "evidence_window_unsupported", "evidence_trailing_window_too_short",
      "evidence_spend_bearing_days_below_floor", "evidence_conversions_below_increase_floor",
      "evidence_budget_not_binding",
    ] as const) {
      expect(verdict.blockerCodes, code).toContain(code);
    }
    expect(verdict.executable).toBe(false);
  });

  it("clears exactly the floors a measured input satisfies, and no others", () => {
    const input = buildWorkspaceBudgetGateInput(facts());
    const measured = evaluateBudgetDecisionGates({
      ...input,
      evidence: {
        windowSupported: true,
        observationAsOfMs: input.originMs - 86_400_000,
        trailingDays: META_BUDGET_PROPOSED_GOVERNANCE.minTrailingDays,
        spendBearingDays: META_BUDGET_PROPOSED_GOVERNANCE.minSpendBearingDays,
        conversions: META_BUDGET_PROPOSED_GOVERNANCE.minConversionsForIncrease,
        budgetIsBinding: true,
      },
    });
    for (const code of [
      "evidence_window_unsupported", "evidence_observation_stale",
      "evidence_trailing_window_too_short", "evidence_spend_bearing_days_below_floor",
      "evidence_conversions_below_increase_floor", "evidence_budget_not_binding",
    ] as const) {
      expect(measured.blockerCodes, code).not.toContain(code);
    }
    expect(measured.blockerCodes).toContain("budget_fact_absent");
    expect(measured.blockerCodes).toContain("threshold_not_owner_approved");
  });

  it("never marks its own proposed thresholds owner-approved", () => {
    const input = buildWorkspaceBudgetGateInput(facts());
    expect(input.governance.thresholdsOwnerApproved).toBe(false);
    for (const [key, value] of Object.entries(META_BUDGET_PROPOSED_GOVERNANCE)) {
      expect(input.governance[key as keyof typeof META_BUDGET_PROPOSED_GOVERNANCE], key).toBe(value);
    }
    expect(evaluateBudgetDecisionGates(input).blockerCodes).toContain("threshold_not_owner_approved");
  });
});

/**
 * Correction 3 — the SELECTED action's whole lineage must survive the trip.
 *
 * r3's adapter kept only the boolean, the code and the contract, so the
 * action's own `reason`, the resolver's full nested anchor explanation and the
 * profile-unavailable reason were destroyed before the verdict, the panel and
 * the UI ever saw them. The tests then asserted only boolean/code/contract and
 * so could not notice.
 */
describe("the selected action's full lineage propagates byte-for-byte", () => {
  const NESTED = {
    spendUnit: 41.5,
    spendUnitSource: "operator_aov_with_target_roas",
    lineage: { inputs: ["aov_assumption", "target_roas"], rung: 2, nested: { deep: [1, 2, { deeper: true }] } },
    missingInputs: [] as string[],
  };
  const distinct = (over: Partial<WorkspaceBudgetFacts> = {}): WorkspaceBudgetFacts =>
    facts({
      profile: {
        byAction: {
          scale: { eligible: true, code: "SCALE_CODE", reason: "SCALE REASON: an operator AOV accompanies the Target ROAS" },
          cut: { eligible: false, code: "CUT_CODE", reason: "CUT REASON: no break-even is retained" },
          refresh: { eligible: true, code: "REFRESH_CODE", reason: "REFRESH REASON: never a budget substitute" },
        },
        anchorExplanation: NESTED,
        contractVersion: "adsecute.account-decision-profile.v1",
      },
      profileSourceStatus: "resolved",
      profileUnavailableWhy: null,
      ...over,
    });

  it("carries the increase's own reason, never the cut's or the refresh's", () => {
    const input = buildWorkspaceBudgetGateInput(distinct({ direction: "increase" }));
    expect(input.commercialProfile?.selectedAction).toBe("scale");
    expect(input.commercialProfile?.selectedActionReason).toBe(
      "SCALE REASON: an operator AOV accompanies the Target ROAS",
    );
    expect(input.commercialProfile?.selectedActionReason).not.toContain("CUT REASON");
    expect(input.commercialProfile?.selectedActionReason).not.toContain("REFRESH REASON");
  });

  it("carries the decrease's own reason, never the scale's or the refresh's", () => {
    const input = buildWorkspaceBudgetGateInput(distinct({ direction: "decrease" }));
    expect(input.commercialProfile?.selectedAction).toBe("cut");
    expect(input.commercialProfile?.selectedActionReason).toBe("CUT REASON: no break-even is retained");
    expect(input.commercialProfile?.selectedActionReason).not.toContain("SCALE REASON");
    expect(input.commercialProfile?.selectedActionReason).not.toContain("REFRESH REASON");
  });

  it("preserves the nested anchor explanation by deep equality, not by summary", () => {
    const input = buildWorkspaceBudgetGateInput(distinct());
    expect(input.commercialProfile?.anchorExplanation).toEqual(NESTED);
    // Byte-preserving: the serialised form is identical, so nothing was
    // flattened, re-keyed or reduced to `spendUnitSource`.
    expect(JSON.stringify(input.commercialProfile?.anchorExplanation)).toBe(JSON.stringify(NESTED));
  });

  it("reaches the gate verdict lineage intact", () => {
    for (const [direction, action, reason] of [
      ["increase", "scale", "SCALE REASON: an operator AOV accompanies the Target ROAS"],
      ["decrease", "cut", "CUT REASON: no break-even is retained"],
    ] as const) {
      const verdict = evaluateBudgetDecisionGates(buildWorkspaceBudgetGateInput(distinct({ direction })));
      expect(verdict.lineage.commercialSelectedAction, direction).toBe(action);
      expect(verdict.lineage.commercialSelectedActionReason, direction).toBe(reason);
      expect(verdict.lineage.commercialAnchorExplanation, direction).toEqual(NESTED);
      expect(verdict.lineage.commercialProfileContract, direction).toBe("adsecute.account-decision-profile.v1");
      expect(verdict.lineage.commercialProfileUnavailable, direction).toBeNull();
    }
  });

  it("reaches the evidence panel intact, with the ACTION's own boolean, code and sentence", () => {
    for (const [direction, action, code, reason, eligible] of [
      ["increase", "scale", "SCALE_CODE", "SCALE REASON: an operator AOV accompanies the Target ROAS", true],
      ["decrease", "cut", "CUT_CODE", "CUT REASON: no break-even is retained", false],
    ] as const) {
      const panel = projectBudgetDecisionEvidencePanel({
        verdict: evaluateBudgetDecisionGates(buildWorkspaceBudgetGateInput(distinct({ direction }))),
      });
      expect(panel.commercialLineage.selectedAction, direction).toBe(action);
      // r4 re-derived these two from generic gate blockers: an eligible action
      // lost its code entirely and an ineligible one got the gate's code.
      expect(panel.commercialLineage.code, direction).toBe(code);
      expect(panel.commercialLineage.eligible, direction).toBe(eligible);
      expect(panel.commercialLineage.code, direction).not.toBe("commercial_anchor_not_hard_action_eligible");
      // Not a generic gate sentence.
      expect(panel.commercialLineage.reason, direction).toBe(reason);
      expect(panel.commercialLineage.anchorExplanation, direction).toEqual(NESTED);
      expect(panel.commercialLineage.availability.status, direction).toBe("resolved");
      expect(panel.commercialLineage.contractVersion, direction).toBe("adsecute.account-decision-profile.v1");
    }
  });

  it("keeps an ELIGIBLE action's canonical code, which a gate blocker cannot supply", () => {
    // The sharpest case: nothing is blocked, so a blocker-derived code is null.
    const panel = projectBudgetDecisionEvidencePanel({
      verdict: evaluateBudgetDecisionGates(buildWorkspaceBudgetGateInput(distinct({ direction: "increase" }))),
    });
    expect(panel.commercialLineage.eligible).toBe(true);
    expect(panel.commercialLineage.code).toBe("SCALE_CODE");
    expect(panel.commercialLineage.code).not.toBeNull();
  });

  it("blames the GATE, not the profile, when no verdict exists", () => {
    const absent = unavailableEvidencePanel("gate_verdict_absent");
    expect(absent.commercialLineage.availability.status).toBe("gate_not_evaluated");
    expect(absent.commercialLineage.availability.status).not.toBe("output_not_retained");
    const unsupported = unavailableEvidencePanel("gate_contract_unsupported");
    expect(unsupported.commercialLineage.availability.status).toBe("gate_not_evaluated");
  });

  it("distinguishes a successful read with no output from a failed read", () => {
    const noOutput = buildWorkspaceBudgetGateInput(
      facts({ profile: null, profileSourceStatus: "output_not_retained", profileUnavailableWhy: "the read succeeded but retained no eligibility output" }),
    );
    expect(noOutput.commercialProfileUnavailable?.status).toBe("output_not_retained");
    expect(noOutput.commercialProfileUnavailable?.status).not.toBe("read_failed");
    const readFailed = buildWorkspaceBudgetGateInput(
      facts({ profile: null, profileSourceStatus: "read_failed", profileUnavailableWhy: "the read threw" }),
    );
    expect(readFailed.commercialProfileUnavailable?.status).toBe("read_failed");
  });

  it("publishes an honest unavailable status rather than null silence", () => {
    const readFailed = buildWorkspaceBudgetGateInput(
      facts({ profile: null, profileSourceStatus: "read_failed", profileUnavailableWhy: "the account decision profile read failed" }),
    );
    expect(readFailed.commercialProfile).toBeNull();
    expect(readFailed.commercialProfileUnavailable).toEqual({
      status: "read_failed",
      reason: "the account decision profile read failed",
      expectedContract: "adsecute.account-decision-profile.v1",
      observedContract: null,
    });
    const panel = projectBudgetDecisionEvidencePanel({ verdict: evaluateBudgetDecisionGates(readFailed) });
    expect(panel.commercialLineage.availability.status).toBe("read_failed");
    expect(panel.commercialLineage.eligible).toBeNull();
  });

  it("distinguishes a resolved profile that never published this action", () => {
    // The profile resolved, but the direction's action is absent: that is not
    // a read failure and it is not ineligibility.
    const input = buildWorkspaceBudgetGateInput(
      facts({
        direction: "decrease",
        profile: {
          byAction: { scale: { eligible: true, code: null, reason: "only scale was published" } },
          anchorExplanation: null,
          contractVersion: "adsecute.account-decision-profile.v1",
        },
        profileSourceStatus: "resolved",
        profileUnavailableWhy: null,
      }),
    );
    expect(input.commercialProfile).toBeNull();
    expect(input.commercialProfileUnavailable?.status).toBe("action_not_published");
    expect(input.commercialProfileUnavailable?.reason).toContain("cut");
    expect(input.commercialProfileUnavailable?.observedContract).toBe("adsecute.account-decision-profile.v1");
  });

  it("never lets refresh leak into either direction", () => {
    for (const direction of ["increase", "decrease"] as const) {
      const input = buildWorkspaceBudgetGateInput(distinct({ direction }));
      expect(input.commercialProfile?.selectedAction, direction).not.toBe("refresh");
      expect(input.commercialProfile?.codes, direction).not.toContain("REFRESH_CODE");
      expect(input.commercialProfile?.selectedActionReason, direction).not.toContain("REFRESH");
    }
  });
});
