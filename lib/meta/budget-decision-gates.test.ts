import { describe, expect, it } from "vitest";

import {
  BUDGET_DECISION_GATE_CODES,
  META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
  budgetDecisionIsExecutable,
  evaluateBudgetDecisionGates,
  type BudgetDecisionGateInput,
} from "@/lib/meta/budget-decision-gates";
import { META_BUDGET_INTENT_CONTRACT_VERSION } from "@/lib/meta/budget-intent-contract";

const ORIGIN = Date.parse("2026-08-20T00:00:00Z");
const DAY = 86_400_000;
const BUSINESS = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";
const ACCOUNT = "act_1087566732415606";
const HEX = "a".repeat(64);

/** Everything satisfied except the typed intent, which each test supplies. */
function healthy(over: Partial<BudgetDecisionGateInput> = {}): BudgetDecisionGateInput {
  return {
    contractVersion: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
    direction: "increase",
    budgetFact: { present: true, ownerResolved: true, intentReady: true, shapeSupport: "supported", blockers: [] },
    commercialProfile: {
      hardActionEligible: true, anchor: "target_cpa", codes: [], contractVersion: "account-decision-profile.v1",
      selectedAction: "scale" as const, selectedActionEligible: true, selectedActionCode: null, selectedActionReason: null, anchorExplanation: null, sourceStatus: "resolved" as const,
    },
    commercialProfileUnavailable: null,
    commercialTarget: { pitKnowableAtMs: ORIGIN - 10 * DAY, effectiveAtMs: ORIGIN - 10 * DAY, economicallyReconciled: true },
    roleResolved: true,
    evidence: { windowSupported: true, observationAsOfMs: ORIGIN - DAY, trailingDays: 14, spendBearingDays: 12, conversions: 40, budgetIsBinding: true },
    changeSafety: {
      lastChangeAtMs: ORIGIN - 30 * DAY,
      // Prospective: the candidate itself is counted, so 1 means "this would
      // be the first change today", never "nothing has happened".
      changesForEntityToday: 1, changesInAccountToday: 1,
      changesInBusinessToday: 1, changesInFleetToday: 4,
      accountShareOfFleetChanges: 0.25,
      countSemantics: "prospective_including_candidate",
    },
    governance: {
      thresholdsOwnerApproved: true,
      maxTargetAgeDays: 60, maxObservationAgeDays: 3,
      minTrailingDays: 7, minSpendBearingDays: 5, minConversionsForIncrease: 25,
      cooldownDays: 7,
      maxChangesPerEntityPerDay: 1, maxChangesPerAccountPerDay: 2,
      maxChangesPerBusinessPerDay: 3, maxChangesPerFleetPerDay: 5,
      maxAccountShareOfFleetChanges: 0.5,
    },
    providerCompatibilityKnown: true,
    automationEnabled: false,
    originMs: ORIGIN,
    intent: null,
    knownBindings: [{ businessId: BUSINESS, providerAccountId: ACCOUNT }],
    ...over,
  };
}

/** A structurally complete intent the typed contract accepts. */
function validIntent(): BudgetDecisionGateInput["intent"] {
  return {
    contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
    scope: { businessId: BUSINESS, providerAccountId: ACCOUNT, entityGrain: "campaign", entityId: "c-1", parentCampaignId: null },
    ownerMode: "campaign_budget_optimization",
    budgetField: "daily_budget",
    observedDailyMinorUnits: 100_000,
    observedLifetimeMinorUnits: null,
    lifetimeSchedule: null,
    direction: "increase",
    percent: 10,
    accountCurrency: "USD",
    originDate: "2026-08-20",
    effectiveAsOf: "2026-08-19",
    knowledgeAsOf: "2026-08-19",
    authorityEvidenceAsOf: "2026-08-19",
    maxAuthorityEvidenceAgeDays: 7,
    sourceFingerprints: { configStateHash: HEX, ownerStateHash: HEX, roleAuthorityHash: HEX },
    evidenceWindow: { from: "2026-08-06", to: "2026-08-19" },
    targetSource: { source: "settings_manual_entry", version: "1" },
    authorityStatus: "authorised",
    blockerCodes: [],
  };
}

describe("F7 — validated_only requires the typed contract to say valid", () => {
  it("refuses validated_only when no intent was supplied", () => {
    const verdict = evaluateBudgetDecisionGates(healthy({ intent: null }));
    expect(verdict.blockerCodes).toContain("intent_absent");
    expect(verdict.authority).toBe("blocked");
  });

  it("refuses validated_only when the typed contract rejects the intent", () => {
    // The exact reproduction: every local gate clear, an intent the typed
    // contract cannot accept. Before Correction 1 this returned
    // {"authority":"validated_only","blockers":[],"intentStatus":"rejected"}.
    const verdict = evaluateBudgetDecisionGates(healthy({ intent: {} as never }));
    expect(verdict.intent?.status).toBe("rejected");
    expect(verdict.blockerCodes).toContain("intent_rejected");
    expect(verdict.authority).toBe("blocked");
    expect(verdict.intentKey).toBeNull();
    // The typed contract's own lineage is preserved, not re-derived here.
    expect(verdict.intentRejections.length).toBeGreaterThan(0);
    expect(verdict.lineage.intentContractDelegated).toBe(true);
  });

  it("reaches validated_only only when the typed contract validates", () => {
    const verdict = evaluateBudgetDecisionGates(healthy({ intent: validIntent() }));
    expect(verdict.blockerCodes, JSON.stringify(verdict.intent)).toEqual([]);
    expect(verdict.intent?.status).toBe("valid");
    expect(verdict.authority).toBe("validated_only");
    expect(verdict.intentKey).toMatch(/^meta\.budget-intent\.v1:[0-9a-f]{64}$/);
    // ...and it is still never executable.
    expect(verdict.executable).toBe(false);
    expect(budgetDecisionIsExecutable()).toBe(false);
  });

  it("carries the typed contract's own lineage without re-deriving it", () => {
    const verdict = evaluateBudgetDecisionGates(healthy({ intent: {} as never }));
    // The typed contract emits its own codes and its own sentences, and the two
    // lists are deliberately not the same length: a single malformed field can
    // produce several sentences. Both are passed through untouched.
    expect(verdict.intentRejections.length).toBeGreaterThan(0);
    expect(verdict.intentReasons.length).toBeGreaterThan(0);
    for (const reason of verdict.intentReasons) expect(reason.length).toBeGreaterThan(5);
    // The gate layer contributes exactly one code of its own, and no sentence
    // of its own about the intent's arithmetic.
    expect(verdict.blockerCodes.filter((c) => c.startsWith("intent_"))).toEqual(["intent_rejected"]);
    const gateReason = verdict.reasons.find((r) => r.code === "intent_rejected")!.reason;
    expect(gateReason).toContain("its own rejection codes carry the detail");
  });
});

describe("F8 — malformed evidence fails closed, never open", () => {
  it.each([
    ["NaN observation", { evidence: { ...healthy().evidence, observationAsOfMs: Number.NaN } }],
    ["Infinity observation", { evidence: { ...healthy().evidence, observationAsOfMs: Number.POSITIVE_INFINITY } }],
    ["future observation", { evidence: { ...healthy().evidence, observationAsOfMs: ORIGIN + DAY } }],
    ["future target effective", { commercialTarget: { pitKnowableAtMs: ORIGIN - DAY, effectiveAtMs: ORIGIN + DAY, economicallyReconciled: true } }],
    ["future last change", { changeSafety: { ...healthy().changeSafety, lastChangeAtMs: ORIGIN + DAY } }],
  ])("refuses %s with an input_clock_invalid blocker", (_label, over) => {
    const verdict = evaluateBudgetDecisionGates(healthy({ ...over, intent: validIntent() } as Partial<BudgetDecisionGateInput>));
    expect(verdict.blockerCodes).toContain("input_clock_invalid");
    expect(verdict.authority).toBe("blocked");
  });

  it.each([
    ["NaN spend-bearing days", { evidence: { ...healthy().evidence, spendBearingDays: Number.NaN } }],
    ["negative conversions", { evidence: { ...healthy().evidence, conversions: -1 } }],
    ["negative account count", { changeSafety: { ...healthy().changeSafety, changesInAccountToday: -3 } }],
  ])("refuses %s with an input_counter_invalid blocker", (_label, over) => {
    const verdict = evaluateBudgetDecisionGates(healthy({ ...over, intent: validIntent() } as Partial<BudgetDecisionGateInput>));
    expect(verdict.blockerCodes).toContain("input_counter_invalid");
  });

  it.each([
    ["NaN cooldown", { cooldownDays: Number.NaN }],
    ["negative cap", { maxChangesPerAccountPerDay: -5 }],
    ["Infinity floor", { minSpendBearingDays: Number.POSITIVE_INFINITY }],
  ])("refuses %s with an input_governance_invalid blocker", (_label, over) => {
    const verdict = evaluateBudgetDecisionGates(
      healthy({ governance: { ...healthy().governance, ...over }, intent: validIntent() }),
    );
    expect(verdict.blockerCodes).toContain("input_governance_invalid");
  });

  it("is not vacuous: the healthy fixture really clears every gate", () => {
    expect(evaluateBudgetDecisionGates(healthy({ intent: validIntent() })).blockerCodes).toEqual([]);
  });
});

describe("F9 — automation semantics match their own words", () => {
  it("lets OFF reach local review-only validation", () => {
    const verdict = evaluateBudgetDecisionGates(healthy({ automationEnabled: false, intent: validIntent() }));
    expect(verdict.blockerCodes).toEqual([]);
    expect(verdict.authority).toBe("validated_only");
    expect(verdict.executable).toBe(false);
  });

  it("refuses an unexpectedly enabled state under an accurately named code", () => {
    const verdict = evaluateBudgetDecisionGates(healthy({ automationEnabled: true, intent: validIntent() }));
    expect(verdict.blockerCodes).toContain("automation_unexpectedly_enabled");
    // The old code said "automation is off" while the input said enabled.
    expect(verdict.blockerCodes).not.toContain("automation_disabled" as never);
    const reason = verdict.reasons.find((r) => r.code === "automation_unexpectedly_enabled")!.reason;
    expect(reason).toContain("reports it enabled");
    expect(reason).not.toContain("automation is off;");
  });
});

describe("F10 — the gates consume the evidence they advertise", () => {
  it.each([
    ["evidence_trailing_window_too_short", { evidence: { ...healthy().evidence, trailingDays: 2 } }],
    ["evidence_spend_bearing_days_below_floor", { evidence: { ...healthy().evidence, spendBearingDays: 1 } }],
    ["evidence_conversions_below_increase_floor", { evidence: { ...healthy().evidence, conversions: 3 } }],
    ["evidence_budget_not_binding", { evidence: { ...healthy().evidence, budgetIsBinding: false } }],
    ["change_safety_entity_cap_conflict", { changeSafety: { ...healthy().changeSafety, changesForEntityToday: 2 } }],
    ["change_safety_account_cap_conflict", { changeSafety: { ...healthy().changeSafety, changesInAccountToday: 3 } }],
    ["change_safety_business_cap_conflict", { changeSafety: { ...healthy().changeSafety, changesInBusinessToday: 4 } }],
    ["change_safety_fleet_cap_conflict", { changeSafety: { ...healthy().changeSafety, changesInFleetToday: 6 } }],
    ["change_safety_concentration_conflict", { changeSafety: { ...healthy().changeSafety, accountShareOfFleetChanges: 0.9 } }],
  ])("raises %s from real evidence", (code, over) => {
    const verdict = evaluateBudgetDecisionGates(healthy({ ...over, intent: validIntent() } as Partial<BudgetDecisionGateInput>));
    expect(verdict.blockerCodes).toContain(code);
  });

  it("never leaks an increase-only gate into a decrease", () => {
    const starved = { ...healthy().evidence, conversions: 0, budgetIsBinding: false };
    const increase = evaluateBudgetDecisionGates(healthy({ direction: "increase", evidence: starved, intent: validIntent() }));
    const decrease = evaluateBudgetDecisionGates(healthy({ direction: "decrease", evidence: starved, intent: validIntent() }));
    expect(increase.blockerCodes).toContain("evidence_conversions_below_increase_floor");
    expect(increase.blockerCodes).toContain("evidence_budget_not_binding");
    expect(decrease.blockerCodes).not.toContain("evidence_conversions_below_increase_floor");
    expect(decrease.blockerCodes).not.toContain("evidence_budget_not_binding");
    // Non-vacuity: the decrease really did run the shared floors.
    const shortDecrease = evaluateBudgetDecisionGates(
      healthy({ direction: "decrease", evidence: { ...starved, spendBearingDays: 0 }, intent: validIntent() }),
    );
    expect(shortDecrease.blockerCodes).toContain("evidence_spend_bearing_days_below_floor");
  });
});

describe("the gate layer stays fail-closed and canonical", () => {
  it("returns blockers in contract order with a paired primary", () => {
    const verdict = evaluateBudgetDecisionGates(
      healthy({ automationEnabled: true, budgetFact: null, roleResolved: false, intent: validIntent() }),
    );
    const positions = verdict.blockerCodes.map((c) => BUDGET_DECISION_GATE_CODES.indexOf(c));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(verdict.primaryBlocker?.code).toBe(verdict.blockerCodes[0]);
    expect(verdict.primaryBlocker?.reason).toBe(
      verdict.reasons.find((r) => r.code === verdict.blockerCodes[0])?.reason,
    );
  });

  it("never names a specific sub-cause for the persisted generic family", () => {
    const verdict = evaluateBudgetDecisionGates(
      healthy({
        commercialProfile: { hardActionEligible: false, anchor: null, codes: ["profile_hard_action_ineligible"], contractVersion: "account-decision-profile.v1", selectedAction: "scale" as const, selectedActionEligible: false, selectedActionCode: null, selectedActionReason: null, anchorExplanation: null, sourceStatus: "resolved" as const },
        intent: validIntent(),
      }),
    );
    expect(verdict.blockerCodes).toContain("commercial_anchor_not_hard_action_eligible");
    expect(JSON.stringify(verdict)).not.toContain("profile_hard_action_ineligible");
    expect(verdict.lineage.commercialAuthority).toBe("AccountDecisionProfile.hardActionEligibility");
    expect(verdict.lineage.commercialProfileContract).toBe("account-decision-profile.v1");
  });

  it("refuses an unknown gate contract version", () => {
    const verdict = evaluateBudgetDecisionGates(healthy({ contractVersion: "old", intent: validIntent() }));
    expect(verdict.blockerCodes).toContain("input_contract_unsupported");
  });

  it("never delegates to the typed contract while a local gate is unmet", () => {
    const verdict = evaluateBudgetDecisionGates(healthy({ roleResolved: false, intent: validIntent() }));
    expect(verdict.intent).toBeNull();
    expect(verdict.lineage.intentContractDelegated).toBe(false);
  });
});

/**
 * Correction 2 — an ABSENT change-safety counter used to skip every safety
 * check, so a caller that had read no history cleared the cooldown, all four
 * caps and the concentration control in silence.
 */
describe("unread change history refuses instead of clearing", () => {
  const unread = (over: Partial<BudgetDecisionGateInput["changeSafety"]> = {}) =>
    evaluateBudgetDecisionGates(
      healthy({
        intent: validIntent(),
        changeSafety: {
          lastChangeAtMs: null,
          changesForEntityToday: null as unknown as number,
          changesInAccountToday: null as unknown as number,
          changesInBusinessToday: null as unknown as number,
          changesInFleetToday: null as unknown as number,
          accountShareOfFleetChanges: null as unknown as number,
          countSemantics: "prospective_including_candidate" as const,
          ...over,
        },
      }),
    );

  it("blocks under its own code when every counter is unread", () => {
    const verdict = unread();
    expect(verdict.blockerCodes).toContain("change_safety_history_unavailable");
    expect(verdict.authority).toBe("blocked");
    // The reason must say what is actually wrong, not "no changes".
    const reason = verdict.reasons.find((r) => r.code === "change_safety_history_unavailable")!.reason;
    expect(reason).toContain("not read");
    expect(reason).toContain("not a history of no changes");
  });

  it("blocks when even ONE declared scope is unread", () => {
    for (const field of [
      "changesForEntityToday", "changesInAccountToday",
      "changesInBusinessToday", "changesInFleetToday", "accountShareOfFleetChanges",
    ] as const) {
      const verdict = evaluateBudgetDecisionGates(
        healthy({
          intent: validIntent(),
          changeSafety: { ...healthy().changeSafety, [field]: null as unknown as number },
        }),
      );
      expect(verdict.blockerCodes, field).toContain("change_safety_history_unavailable");
    }
  });

  it("does NOT fire on a fully measured history, including measured zeros", () => {
    // Non-vacuity: a real read of zero changes must still reach validated_only.
    const verdict = evaluateBudgetDecisionGates(healthy({ intent: validIntent() }));
    expect(verdict.blockerCodes).not.toContain("change_safety_history_unavailable");
    expect(verdict.authority).toBe("validated_only");
  });

  it("keeps a malformed counter under input_counter_invalid, not the new code", () => {
    const verdict = evaluateBudgetDecisionGates(
      healthy({ intent: validIntent(), changeSafety: { ...healthy().changeSafety, changesInAccountToday: Number.NaN } }),
    );
    expect(verdict.blockerCodes).toContain("input_counter_invalid");
    expect(verdict.blockerCodes).not.toContain("change_safety_history_unavailable");
  });
});

/**
 * Correction 2 — prospective caps, tested at the exact boundary.
 *
 * The gate compared `observed >= cap`, which is the PRE-CHANGE reading, while
 * the workspace adapter sent counts that already included the candidate. A
 * candidate that would be the third change of the day was therefore refused by
 * a cap of three.
 */
describe("prospective caps admit exactly the first n changes of a day", () => {
  const at = (n: number) =>
    evaluateBudgetDecisionGates(
      healthy({
        intent: validIntent(),
        changeSafety: { ...healthy().changeSafety, changesInAccountToday: n },
      }),
    ).blockerCodes;

  it("clears at the cap and refuses one past it", () => {
    const cap = healthy().governance.maxChangesPerAccountPerDay;
    expect(at(cap)).not.toContain("change_safety_account_cap_conflict");
    expect(at(cap + 1)).toContain("change_safety_account_cap_conflict");
    // And one below the cap is obviously fine.
    expect(at(cap - 1)).not.toContain("change_safety_account_cap_conflict");
  });

  it("refuses a prospective count of zero, which cannot include the candidate", () => {
    const verdict = evaluateBudgetDecisionGates(
      healthy({
        intent: validIntent(),
        changeSafety: { ...healthy().changeSafety, changesInAccountToday: 0 },
      }),
    );
    expect(verdict.blockerCodes).toContain("input_counter_invalid");
  });

  it("refuses counts whose semantics it cannot interpret", () => {
    const verdict = evaluateBudgetDecisionGates(
      healthy({
        intent: validIntent(),
        changeSafety: {
          ...healthy().changeSafety,
          countSemantics: "pre_change" as unknown as "prospective_including_candidate",
        },
      }),
    );
    expect(verdict.blockerCodes).toContain("input_counter_invalid");
    // And no cap verdict is invented from counts it cannot read.
    expect(verdict.blockerCodes).not.toContain("change_safety_account_cap_conflict");
  });

  it("keeps concentration strict: at the threshold clears, above it refuses", () => {
    const share = (v: number) =>
      evaluateBudgetDecisionGates(
        healthy({
          intent: validIntent(),
          changeSafety: { ...healthy().changeSafety, accountShareOfFleetChanges: v },
        }),
      ).blockerCodes;
    const max = healthy().governance.maxAccountShareOfFleetChanges;
    expect(share(max)).not.toContain("change_safety_concentration_conflict");
    expect(share(max + 0.01)).toContain("change_safety_concentration_conflict");
  });
});
