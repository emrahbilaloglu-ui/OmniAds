/**
 * D084 Correction 1 — the server-owned commercial/evidence/change-safety gates.
 *
 * This is NOT a second decision core. It sits in front of the existing typed
 * budget-intent contract (`lib/meta/budget-intent-contract.ts`) and decides
 * whether a canonical budget fact may even be offered for validation. It owns
 * no arithmetic of its own: when every gate passes it delegates to
 * `validateBudgetIntent` and reports that contract's verdict verbatim.
 *
 * AUTHORITY CEILING
 * `validated_only` is reachable only when every local gate passes AND the typed
 * contract returns `status: "valid"`. `executable` is the literal `false`.
 * Automation stays OFF; nothing here adds a provider endpoint or a mutation.
 *
 * WHAT THIS MODULE MAY NOT DO
 * `AccountDecisionProfile.hardActionEligibility` (its `anchor` and `codes`) is
 * the sole commercial-anchor authority (D079 C1/C2). This module consumes that
 * verdict and never re-derives source, confidence, spend unit or eligibility
 * from target fields. `profile_hard_action_ineligible` is a persisted FAMILY
 * and is never restated here as a specific sub-cause. No role is inferred or
 * written; no buyer action is computed.
 *
 * WHAT CORRECTION 1 FIXED
 *   - a rejected typed intent was still reported `validated_only`;
 *   - non-finite clocks, counts and governance numbers failed OPEN;
 *   - `automationEnabled: true` emitted a code whose sentence said automation
 *     was off — the predicate, the code and the words now agree;
 *   - the input could not express the evidence floors it advertised, so
 *     spend-bearing days, conversions, binding evidence, direction asymmetry
 *     and the entity/account/business/fleet caps are now real inputs.
 */
import {
  validateBudgetIntent,
  type BudgetDirection,
  type BudgetIntentInput,
  type BudgetIntentValidation,
} from "@/lib/meta/budget-intent-contract";

/**
 * Correction 4: Correction 3 added `selectedAction`, `selectedActionReason`,
 * `anchorExplanation`, `sourceStatus`, `commercialProfileUnavailable` and
 * nullable change-safety counters to this contract's input and verdict WITHOUT
 * bumping the version string. A versioned shape may not change under its own
 * version. v3 carries those fields plus the canonical eligibility boolean and
 * action code this correction adds; v2 payloads are rejected, not coerced.
 */
export const META_BUDGET_DECISION_GATE_CONTRACT_VERSION = "meta.budget-decision-gates.v3" as const;

/** Versions this layer will not read. A v2 payload has a different shape. */
export const META_BUDGET_DECISION_GATE_REJECTED_VERSIONS = [
  "meta.budget-decision-gates.v1",
  "meta.budget-decision-gates.v2",
] as const;

/**
 * Ordered, stable gate codes. Order is the contract: the first unmet gate is
 * the one a surface may name, and a code never disagrees with the boolean it
 * explains. Absence of a code is unknown, never eligible.
 */
export const BUDGET_DECISION_GATE_CODES = [
  // --- input integrity: malformed evidence fails closed, never open --------
  "input_contract_unsupported",
  "input_clock_invalid",
  "input_counter_invalid",
  "input_governance_invalid",
  // --- identity and the canonical fact ------------------------------------
  "budget_fact_absent",
  "budget_fact_owner_unresolved",
  "budget_fact_intent_not_ready",
  "budget_shape_unsupported",
  // --- role: inferred automatically, never written -------------------------
  "role_authority_unresolved",
  // --- commercial truth: read from the canonical profile only --------------
  "commercial_profile_unavailable",
  "commercial_anchor_not_hard_action_eligible",
  "commercial_target_not_point_in_time_knowable",
  "commercial_target_stale",
  "commercial_target_not_economically_reconciled",
  // --- evidence floors, direction-aware ------------------------------------
  "evidence_window_unsupported",
  "evidence_observation_stale",
  "evidence_trailing_window_too_short",
  "evidence_spend_bearing_days_below_floor",
  "evidence_conversions_below_increase_floor",
  "evidence_budget_not_binding",
  // --- change safety, at every declared scope ------------------------------
  "change_safety_cooldown_conflict",
  "change_safety_entity_cap_conflict",
  "change_safety_account_cap_conflict",
  "change_safety_business_cap_conflict",
  "change_safety_fleet_cap_conflict",
  "change_safety_concentration_conflict",
  "change_safety_history_unavailable",
  // --- governance and provider ---------------------------------------------
  "threshold_not_owner_approved",
  "provider_compatibility_unknown",
  "automation_unexpectedly_enabled",
  // --- the typed intent is the last word -----------------------------------
  "intent_absent",
  "intent_rejected",
] as const;
export type BudgetDecisionGateCode = (typeof BUDGET_DECISION_GATE_CODES)[number];

export type GateAuthority = "validated_only" | "blocked";

export interface BudgetDecisionGateInput {
  contractVersion: string;
  direction: BudgetDirection;
  budgetFact: {
    present: boolean;
    ownerResolved: boolean;
    intentReady: boolean;
    shapeSupport: "supported" | "unsupported_shape" | "shape_not_observed";
    blockers: readonly string[];
  } | null;
  /**
   * Read verbatim from `AccountDecisionProfile.hardActionEligibility`. `null`
   * is an explicit unavailable state — never "no anchor configured", never
   * eligible.
   */
  commercialProfile: {
    hardActionEligible: boolean;
    anchor: string | null;
    codes: readonly string[];
    contractVersion: string;
    /**
     * The SELECTED action's own lineage, carried verbatim (Correction 3).
     *
     * r3 kept only the boolean, the code and the contract, so the action's own
     * `reason` and the resolver's full anchor explanation were destroyed before
     * the verdict, the panel and the UI ever saw them — and the surface then
     * showed a generic gate sentence in their place.
     */
    selectedAction: "scale" | "cut";
    /** The resolver's own boolean for THIS action, carried verbatim. */
    selectedActionEligible: boolean;
    /** The resolver's own code for THIS action, e.g. `SCALE_CODE`. */
    selectedActionCode: string | null;
    selectedActionReason: string | null;
    anchorExplanation: Record<string, unknown> | null;
    sourceStatus: "resolved";
  } | null;
  /** Why the profile is absent, when it is. Never null silence. */
  commercialProfileUnavailable: {
    status: "read_failed" | "output_not_retained" | "action_not_published";
    reason: string;
    expectedContract: string;
    observedContract: string | null;
  } | null;
  commercialTarget: {
    pitKnowableAtMs: number | null;
    effectiveAtMs: number | null;
    economicallyReconciled: boolean;
  } | null;
  roleResolved: boolean;
  /** The retained PIT evidence the floors actually need. */
  evidence: {
    windowSupported: boolean;
    observationAsOfMs: number | null;
    trailingDays: number | null;
    spendBearingDays: number | null;
    conversions: number | null;
    budgetIsBinding: boolean | null;
  };
  /** Recent-change history at every scope D080B declares. */
  changeSafety: {
    lastChangeAtMs: number | null;
    /**
     * Honestly nullable (Correction 3). r3's adapter cast unread counters with
     * `as number`, so the contract claimed a number where the value was null.
     * `null` means the scope was not read; it is never a measured zero, and
     * `change_safety_history_unavailable` is what it produces.
     */
    changesForEntityToday: number | null;
    changesInAccountToday: number | null;
    changesInBusinessToday: number | null;
    changesInFleetToday: number | null;
    accountShareOfFleetChanges: number | null;
    /**
     * Whether the counts already include the candidate change.
     *
     * Correction 2: the caps compared `observed >= cap`, which is the
     * PRE-CHANGE reading ("three already happened, so the fourth is refused"),
     * while the workspace adapter was sending PROSPECTIVE counts that already
     * included the candidate. Under that pairing a candidate that would be the
     * third change of the day was refused by a cap of three. The semantics are
     * declared on the input now, converted once on the server, and a count
     * this layer cannot interpret refuses instead of guessing.
     */
    countSemantics: "prospective_including_candidate";
  };
  governance: {
    thresholdsOwnerApproved: boolean;
    maxTargetAgeDays: number;
    maxObservationAgeDays: number;
    minTrailingDays: number;
    minSpendBearingDays: number;
    minConversionsForIncrease: number;
    cooldownDays: number;
    maxChangesPerEntityPerDay: number;
    maxChangesPerAccountPerDay: number;
    maxChangesPerBusinessPerDay: number;
    maxChangesPerFleetPerDay: number;
    maxAccountShareOfFleetChanges: number;
  };
  providerCompatibilityKnown: boolean;
  automationEnabled: boolean;
  originMs: number;
  intent: BudgetIntentInput | null;
  knownBindings: ReadonlyArray<{ businessId: string; providerAccountId: string }>;
}

export interface BudgetDecisionGateVerdict {
  contractVersion: typeof META_BUDGET_DECISION_GATE_CONTRACT_VERSION;
  authority: GateAuthority;
  blockerCodes: BudgetDecisionGateCode[];
  reasons: Array<{ code: BudgetDecisionGateCode; reason: string }>;
  /**
   * The one blocker a surface may name, paired with its own sentence so no
   * consumer has to recover the sentence by position. Null only when nothing
   * is unmet.
   */
  primaryBlocker: { code: BudgetDecisionGateCode; reason: string } | null;
  intent: BudgetIntentValidation | null;
  intentKey: string | null;
  /** The typed contract's own rejection lineage, never re-derived here. */
  intentRejections: string[];
  intentReasons: string[];
  lineage: {
    gateContract: typeof META_BUDGET_DECISION_GATE_CONTRACT_VERSION;
    commercialAuthority: "AccountDecisionProfile.hardActionEligibility";
    commercialProfileContract: string | null;
    /** The action the server selected for this direction, and its own lineage. */
    commercialSelectedAction: "scale" | "cut" | null;
    /**
     * Carried, never re-derived (Correction 4). r4's panel recovered `eligible`
     * from the ABSENCE of a generic gate blocker and set `code` from that gate
     * code, so an eligible canonical `SCALE_CODE` became `code: null` and an
     * ineligible one became `commercial_anchor_not_hard_action_eligible`.
     */
    commercialSelectedEligible: boolean | null;
    commercialSelectedCode: string | null;
    commercialSelectedActionReason: string | null;
    commercialAnchorExplanation: Record<string, unknown> | null;
    commercialProfileUnavailable: BudgetDecisionGateInput["commercialProfileUnavailable"];
    intentContractDelegated: boolean;
    evaluatedAtOriginMs: number;
  };
  executable: false;
}

const DAY_MS = 86_400_000;

const REASONS: Record<BudgetDecisionGateCode, string> = {
  input_contract_unsupported: "this gate contract version is not the one the caller supplied, so nothing may be assumed compatible",
  input_clock_invalid: "a supplied clock is not a finite instant, or is dated after the origin, so no point-in-time claim can be made from it",
  input_counter_invalid: "a supplied count is not a finite, non-negative number, so no cap or floor can be evaluated against it",
  change_safety_history_unavailable: "recent-change history for at least one declared scope was not read, so no cooldown, cap or concentration control can be evaluated; an unread history is not a history of no changes",
  input_governance_invalid: "a governance threshold is not a finite, non-negative number, so no gate can be evaluated against it",
  budget_fact_absent: "no canonical budget fact was resolved for this entity at this origin",
  budget_fact_owner_unresolved: "the canonical fact could not prove which entity owns the budget",
  budget_fact_intent_not_ready: "the canonical fact is not intent-ready; at least one of its own blockers is unmet",
  budget_shape_unsupported: "the observed budget shape is unsupported or was never observed",
  role_authority_unresolved: "campaign role is unresolved; role is inferred automatically and unresolved stays unresolved",
  commercial_profile_unavailable: "the account decision profile could not be resolved, so commercial authority is unknown",
  commercial_anchor_not_hard_action_eligible: "the canonical profile reports the commercial anchor is not hard-action eligible",
  commercial_target_not_point_in_time_knowable: "the target pack was not both effective and recorded at this origin, so it was not knowable then",
  commercial_target_stale: "the newest knowable target revision is older than the configured maximum age",
  commercial_target_not_economically_reconciled: "the published break-even is not reconciled to a complete retained cost basis",
  evidence_window_unsupported: "the requested evidence window is not supported by retained history at this origin",
  evidence_observation_stale: "the newest observation is older than the configured maximum age",
  evidence_trailing_window_too_short: "the retained trailing window is shorter than the configured minimum",
  evidence_spend_bearing_days_below_floor: "the trailing window carries fewer spend-bearing days than the configured floor",
  evidence_conversions_below_increase_floor: "an increase requires a conversion floor this window does not meet; a decrease never faces this gate",
  evidence_budget_not_binding: "the budget was not binding over the trailing window, so changing it has no evidenced effect",
  change_safety_cooldown_conflict: "a change to this account falls inside the configured cooldown",
  change_safety_entity_cap_conflict: "this entity has already reached the configured per-day change cap",
  change_safety_account_cap_conflict: "this account has already reached the configured per-day change cap",
  change_safety_business_cap_conflict: "this business has already reached the configured per-day change cap",
  change_safety_fleet_cap_conflict: "the fleet has already reached the configured per-day change cap",
  change_safety_concentration_conflict: "this account would take more than the configured share of the fleet's changes",
  threshold_not_owner_approved: "every threshold here is proposed governance and no owner has approved it",
  provider_compatibility_unknown: "provider compatibility for this change is unknown",
  automation_unexpectedly_enabled: "automation is expected to be off for this path and the caller reports it enabled, so this refuses rather than proceeding",
  intent_absent: "no typed budget intent was supplied, so there is nothing for the intent contract to validate",
  intent_rejected: "the typed budget-intent contract rejected this intent; its own rejection codes carry the detail",
};

/** A usable instant: finite, and never dated after the origin. */
function validInstant(value: number | null, originMs: number): boolean {
  return value !== null && Number.isFinite(value) && value <= originMs;
}

function validCount(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function evaluateBudgetDecisionGates(
  input: BudgetDecisionGateInput,
): BudgetDecisionGateVerdict {
  const found = new Set<BudgetDecisionGateCode>();
  const add = (code: BudgetDecisionGateCode) => found.add(code);

  if (input.contractVersion !== META_BUDGET_DECISION_GATE_CONTRACT_VERSION) {
    add("input_contract_unsupported");
  }

  // --- input integrity first: malformed evidence can never fail open -------
  if (!Number.isFinite(input.originMs)) add("input_clock_invalid");
  for (const clock of [
    input.evidence.observationAsOfMs,
    input.commercialTarget?.pitKnowableAtMs ?? null,
    input.commercialTarget?.effectiveAtMs ?? null,
    input.changeSafety.lastChangeAtMs,
  ]) {
    // `null` is "absent" and is handled by its own gate below; a NaN, an
    // Infinity or a future instant is malformed and refuses here.
    if (clock !== null && !validInstant(clock, input.originMs)) add("input_clock_invalid");
  }
  for (const count of [
    input.evidence.trailingDays,
    input.evidence.spendBearingDays,
    input.evidence.conversions,
    input.changeSafety.changesForEntityToday,
    input.changeSafety.changesInAccountToday,
    input.changeSafety.changesInBusinessToday,
    input.changeSafety.changesInFleetToday,
    input.changeSafety.accountShareOfFleetChanges,
  ]) {
    if (count !== null && !validCount(count)) add("input_counter_invalid");
  }
  /**
   * Correction 2: an ABSENT change-safety counter used to skip every check
   * below, so a caller that had read no history at all cleared the cooldown,
   * all four caps and the concentration control in silence. A count that was
   * never read is not a count of zero, and it refuses here under its own code.
   */
  for (const count of [
    input.changeSafety.changesForEntityToday,
    input.changeSafety.changesInAccountToday,
    input.changeSafety.changesInBusinessToday,
    input.changeSafety.changesInFleetToday,
    input.changeSafety.accountShareOfFleetChanges,
  ] as Array<number | null>) {
    if (count === null || count === undefined) { add("change_safety_history_unavailable"); break; }
  }
  for (const threshold of Object.values(input.governance)) {
    if (typeof threshold === "number" && !validCount(threshold)) add("input_governance_invalid");
  }

  const fact = input.budgetFact;
  if (fact === null || !fact.present) add("budget_fact_absent");
  else {
    if (!fact.ownerResolved) add("budget_fact_owner_unresolved");
    if (!fact.intentReady) add("budget_fact_intent_not_ready");
    if (fact.shapeSupport !== "supported") add("budget_shape_unsupported");
  }

  if (!input.roleResolved) add("role_authority_unresolved");

  const profile = input.commercialProfile;
  if (profile === null) add("commercial_profile_unavailable");
  else if (!profile.hardActionEligible) add("commercial_anchor_not_hard_action_eligible");

  const target = input.commercialTarget;
  if (target === null) add("commercial_target_not_point_in_time_knowable");
  else {
    if (!validInstant(target.pitKnowableAtMs, input.originMs)) {
      add("commercial_target_not_point_in_time_knowable");
    } else if (
      !validInstant(target.effectiveAtMs, input.originMs) ||
      (input.originMs - (target.effectiveAtMs ?? 0)) / DAY_MS > input.governance.maxTargetAgeDays
    ) {
      add("commercial_target_stale");
    }
    if (!target.economicallyReconciled) add("commercial_target_not_economically_reconciled");
  }

  // --- evidence floors, with the increase-only gate kept out of decrease ---
  if (!input.evidence.windowSupported) add("evidence_window_unsupported");
  if (
    !validInstant(input.evidence.observationAsOfMs, input.originMs) ||
    (input.originMs - (input.evidence.observationAsOfMs ?? 0)) / DAY_MS >
      input.governance.maxObservationAgeDays
  ) {
    add("evidence_observation_stale");
  }
  if (
    !validCount(input.evidence.trailingDays) ||
    (input.evidence.trailingDays ?? 0) < input.governance.minTrailingDays
  ) {
    add("evidence_trailing_window_too_short");
  }
  if (
    !validCount(input.evidence.spendBearingDays) ||
    (input.evidence.spendBearingDays ?? 0) < input.governance.minSpendBearingDays
  ) {
    add("evidence_spend_bearing_days_below_floor");
  }
  if (input.direction === "increase") {
    if (
      !validCount(input.evidence.conversions) ||
      (input.evidence.conversions ?? 0) < input.governance.minConversionsForIncrease
    ) {
      add("evidence_conversions_below_increase_floor");
    }
    if (input.evidence.budgetIsBinding !== true) add("evidence_budget_not_binding");
  }

  const last = input.changeSafety.lastChangeAtMs;
  if (last !== null && validInstant(last, input.originMs)) {
    if ((input.originMs - last) / DAY_MS < input.governance.cooldownDays) {
      add("change_safety_cooldown_conflict");
    }
  }
  const caps: Array<[number | null, number, BudgetDecisionGateCode]> = [
    [input.changeSafety.changesForEntityToday, input.governance.maxChangesPerEntityPerDay, "change_safety_entity_cap_conflict"],
    [input.changeSafety.changesInAccountToday, input.governance.maxChangesPerAccountPerDay, "change_safety_account_cap_conflict"],
    [input.changeSafety.changesInBusinessToday, input.governance.maxChangesPerBusinessPerDay, "change_safety_business_cap_conflict"],
    [input.changeSafety.changesInFleetToday, input.governance.maxChangesPerFleetPerDay, "change_safety_fleet_cap_conflict"],
  ];
  // Prospective: `observed` INCLUDES the candidate, so a cap of n admits
  // exactly the first n changes of the day and refuses the (n+1)th.
  const semanticsKnown =
    input.changeSafety.countSemantics === "prospective_including_candidate";
  if (!semanticsKnown) add("input_counter_invalid");
  for (const [observed, cap, code] of caps) {
    if (!semanticsKnown) continue;
    // A prospective count of zero is impossible: the candidate is in it.
    if (validCount(observed) && observed === 0) { add("input_counter_invalid"); continue; }
    if (validCount(observed) && validCount(cap) && (observed as number) > cap) add(code);
  }
  const share = input.changeSafety.accountShareOfFleetChanges;
  if (
    validCount(share) &&
    (share as number) > input.governance.maxAccountShareOfFleetChanges
  ) {
    add("change_safety_concentration_conflict");
  }

  if (!input.governance.thresholdsOwnerApproved) add("threshold_not_owner_approved");
  if (!input.providerCompatibilityKnown) add("provider_compatibility_unknown");
  // OFF is the expected state and is compatible with local review-only
  // validation. An unexpectedly ENABLED state is the anomaly, and the code now
  // says so rather than announcing that automation is off.
  if (input.automationEnabled) add("automation_unexpectedly_enabled");

  // --- the typed contract is the last word --------------------------------
  let intent: BudgetIntentValidation | null = null;
  let intentKey: string | null = null;
  let intentRejections: string[] = [];
  let intentReasons: string[] = [];
  const localGatesClear = found.size === 0;
  if (input.intent === null) {
    add("intent_absent");
  } else if (localGatesClear) {
    intent = validateBudgetIntent(input.intent, input.knownBindings);
    if (intent.status === "valid") {
      intentKey = intent.intent.intentKey;
    } else {
      // Preserve the typed contract's own lineage; do not re-derive it.
      intentRejections = [...intent.rejections];
      intentReasons = [...intent.reasons];
      add("intent_rejected");
    }
  }

  const ordered = BUDGET_DECISION_GATE_CODES.filter((code) => found.has(code));
  const reasons = ordered.map((code) => ({ code, reason: REASONS[code] }));

  return {
    contractVersion: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
    authority: ordered.length === 0 ? "validated_only" : "blocked",
    blockerCodes: ordered,
    reasons,
    primaryBlocker: reasons[0] ?? null,
    intent,
    intentKey,
    intentRejections,
    intentReasons,
    lineage: {
      gateContract: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
      commercialAuthority: "AccountDecisionProfile.hardActionEligibility",
      commercialProfileContract: input.commercialProfile?.contractVersion ?? null,
      // Carried through byte-for-byte; never summarised into a gate sentence.
      commercialSelectedAction: input.commercialProfile?.selectedAction ?? null,
      commercialSelectedEligible: input.commercialProfile?.selectedActionEligible ?? null,
      commercialSelectedCode: input.commercialProfile?.selectedActionCode ?? null,
      commercialSelectedActionReason: input.commercialProfile?.selectedActionReason ?? null,
      commercialAnchorExplanation: input.commercialProfile?.anchorExplanation ?? null,
      commercialProfileUnavailable: input.commercialProfileUnavailable ?? null,
      intentContractDelegated: intent !== null,
      evaluatedAtOriginMs: input.originMs,
    },
    executable: false,
  };
}

/** There is no executable path here, and this is the only answer. */
export function budgetDecisionIsExecutable(): false {
  return false;
}
