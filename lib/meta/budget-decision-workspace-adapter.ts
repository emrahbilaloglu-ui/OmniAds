/**
 * The one adapter between what the Meta decisions workspace has actually read
 * and what `evaluateBudgetDecisionGates` requires.
 *
 * WHAT CHANGED (D084 Correction 2). The previous adapter broke three rules it
 * was written to enforce:
 *
 * 1. It rewrote per-action commercial truth as `scale && cut`, aggregated every
 *    action's code into one list, and reduced the whole anchor explanation to a
 *    single `spendUnitSource` string. A profile that says "scale yes, cut no"
 *    is not the same fact as "not eligible", and the reason a surface must show
 *    is the one that action actually carries.
 * 2. It reported change history the route never read as MEASURED ZERO —
 *    `lastChangeAtMs: null` with every scope counter at 0 and concentration 0.
 *    Under that input every safety gate silently clears, so unread history read
 *    as "nothing has happened recently". Read state is now explicit and unread
 *    history produces stable blockers.
 * 3. Its caller hardcoded `direction: "increase"` on an account-scoped panel
 *    where no proposal direction had been selected. Direction is never invented
 *    here: the server publishes two review-only projections instead.
 */

import {
  META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
  type BudgetDecisionGateInput,
} from "@/lib/meta/budget-decision-gates";
import { type BudgetDirection } from "@/lib/meta/budget-intent-contract";

/** The resolver whose output is the only commercial authority. */
export const ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED = "adsecute.account-decision-profile.v1";

export const META_BUDGET_DECISION_WORKSPACE_ADAPTER_CONTRACT =
  "meta-budget-decision-workspace-adapter.v4" as const;

/**
 * The floors D084 proposes. Named constants so a surface, a test and the gate
 * read the same numbers. They are `proposed_governance` and unapproved:
 * `thresholdsOwnerApproved` stays false until an owner approves them.
 */
export const META_BUDGET_PROPOSED_GOVERNANCE = {
  maxTargetAgeDays: 90,
  maxObservationAgeDays: 3,
  minTrailingDays: 14,
  minSpendBearingDays: 5,
  minConversionsForIncrease: 25,
  cooldownDays: 7,
  maxChangesPerEntityPerDay: 1,
  maxChangesPerAccountPerDay: 3,
  maxChangesPerBusinessPerDay: 5,
  maxChangesPerFleetPerDay: 10,
  maxAccountShareOfFleetChanges: 0.5,
} as const;

/**
 * Which action a budget direction actually depends on.
 *
 * An increase is a scale decision and a decrease is a cut decision. `refresh`
 * is a creative action and is NEVER a budget-direction substitute, so it is
 * carried for display and never consulted for eligibility.
 */
export const DIRECTION_TO_PROFILE_ACTION = {
  increase: "scale",
  decrease: "cut",
} as const satisfies Record<BudgetDirection, "scale" | "cut">;

export type ProfileActionName = "scale" | "cut" | "refresh";

/** One action's canonical truth, carried verbatim. */
export interface ProfileActionTruth {
  eligible: boolean;
  code: string | null;
  reason: string | null;
}

/**
 * How the change-history read went. Absence of a value is not a measurement.
 *
 * `available` means a successful read happened and its counters are real —
 * only then may `lastChangeAtMs: null` mean "measured no prior change".
 */
export type ChangeHistoryReadState = "available" | "unavailable" | "partial" | "not_attempted";

/**
 * The profile read/output state, stated by the caller rather than inferred.
 *
 * r4 classified EVERY null profile as `read_failed`, so `output_not_retained`
 * was unreachable and a successful read that simply produced no eligibility
 * was reported as a failure that never happened.
 */
export type ProfileSourceStatus =
  | "resolved"
  | "read_failed"
  | "output_not_retained"
  | "action_not_published";

export interface WorkspaceChangeHistory {
  readState: ChangeHistoryReadState;
  readStateWhy: string;
  lastChangeAtMs: number | null;
  changesForEntityToday: number | null;
  changesInAccountToday: number | null;
  changesInBusinessToday: number | null;
  changesInFleetToday: number | null;
  /** Numerator and denominator, so the ratio is inspectable rather than asserted. */
  accountChangesToday: number | null;
  fleetChangesToday: number | null;
  /** Whether the counters already include the candidate change. */
  countSemantics: "prospective_including_candidate" | "pre_change";
}

export interface WorkspaceBudgetFacts {
  direction: BudgetDirection;
  originMs: number;
  /**
   * `AccountDecisionProfile.hardActionEligibility`, per action, verbatim.
   * `null` means the profile read failed or the output is not retained; it is
   * never "no anchor configured" and never eligible.
   */
  profile: {
    byAction: Partial<Record<ProfileActionName, ProfileActionTruth>>;
    /** The resolver's full anchor explanation, carried whole. */
    anchorExplanation: Record<string, unknown> | null;
    contractVersion: string;
  } | null;
  /** How the profile read actually went. Never guessed from a null. */
  profileSourceStatus: ProfileSourceStatus;
  profileUnavailableWhy: string | null;
  commercialTarget: {
    pitKnowableAtMs: number | null;
    effectiveAtMs: number | null;
    economicallyReconciled: boolean;
  } | null;
  roleResolved: boolean;
  providerCompatibilityKnown: boolean;
  automationEnabled: boolean;
  changeHistory: WorkspaceChangeHistory;
  knownBindings: ReadonlyArray<{ businessId: string; providerAccountId: string }>;
}

/**
 * Prospective account concentration in [0,1], or null when unknowable.
 *
 * The candidate change is counted in BOTH sides, so a single fleet-wide change
 * is a share of 1 rather than a division by zero. An unknown denominator is
 * unavailable — never 0, which would read as "no concentration at all".
 */
export function prospectiveAccountShare(history: WorkspaceChangeHistory): number | null {
  if (history.readState !== "available") return null;
  const account = history.accountChangesToday;
  const fleet = history.fleetChangesToday;
  if (account === null || fleet === null) return null;
  const bump = history.countSemantics === "prospective_including_candidate" ? 0 : 1;
  const numerator = account + bump;
  const denominator = fleet + bump;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const share = numerator / denominator;
  return share >= 0 && share <= 1 ? share : null;
}

/** Convert once, on the server, to the prospective form the gates consume. */
function prospective(value: number | null, semantics: WorkspaceChangeHistory["countSemantics"]): number | null {
  if (value === null) return null;
  return semantics === "prospective_including_candidate" ? value : value + 1;
}

export function buildWorkspaceBudgetGateInput(
  facts: WorkspaceBudgetFacts,
): BudgetDecisionGateInput {
  const action = DIRECTION_TO_PROFILE_ACTION[facts.direction];
  const truth = facts.profile?.byAction[action];
  // Only THIS direction's action decides, and its whole lineage travels with
  // it: the boolean, the code, the action's own reason, and the resolver's full
  // nested anchor explanation, preserved verbatim.
  const commercialProfile =
    facts.profile == null || truth == null
      ? null
      : {
          hardActionEligible: truth.eligible,
          anchor: truth.code,
          codes: truth.code === null ? [] : [truth.code],
          contractVersion: facts.profile.contractVersion,
          selectedAction: action,
          selectedActionEligible: truth.eligible,
          selectedActionCode: truth.code,
          selectedActionReason: truth.reason,
          anchorExplanation: facts.profile.anchorExplanation,
          sourceStatus: "resolved" as const,
        };
  // An absent profile always says WHY. `action_not_published` is the case r3
  // could not express at all: the profile resolved, but this direction's action
  // was not among the actions it published.
  const commercialProfileUnavailable =
    commercialProfile !== null
      ? null
      : {
          status:
            // The caller's own statement wins. Only when it says `resolved`
            // while no action is present do we classify the shape ourselves.
            facts.profileSourceStatus !== "resolved"
              ? facts.profileSourceStatus
              : facts.profile == null
                ? ("output_not_retained" as const)
                : ("action_not_published" as const),
          reason:
            facts.profileUnavailableWhy ??
            (facts.profile == null
              ? "no AccountDecisionProfile output was available for this account"
              : `the resolved profile publishes no ${action} verdict, which is the action a ${facts.direction} depends on`),
          expectedContract: ACCOUNT_DECISION_PROFILE_CONTRACT_EXPECTED,
          observedContract: facts.profile?.contractVersion ?? null,
        };

  const history = facts.changeHistory;
  const known = history.readState === "available";
  const semantics = history.countSemantics;

  return {
    // The GATE contract the caller speaks, not the adapter's own name.
    contractVersion: META_BUDGET_DECISION_GATE_CONTRACT_VERSION,
    direction: facts.direction,
    budgetFact: null,
    commercialProfile,
    commercialProfileUnavailable,
    commercialTarget: facts.commercialTarget,
    roleResolved: facts.roleResolved,
    evidence: {
      windowSupported: false,
      observationAsOfMs: null,
      trailingDays: null,
      spendBearingDays: null,
      conversions: null,
      budgetIsBinding: null,
    },
    // Unread history arrives as NaN-free explicit absence. The gate layer's
    // `input_counter_invalid` and its change-safety codes then fire, instead of
    // a zero silently clearing every cap.
    changeSafety: {
      lastChangeAtMs: known ? history.lastChangeAtMs : null,
      changesForEntityToday: known ? prospective(history.changesForEntityToday, semantics) : null,
      changesInAccountToday: known ? prospective(history.changesInAccountToday, semantics) : null,
      changesInBusinessToday: known ? prospective(history.changesInBusinessToday, semantics) : null,
      changesInFleetToday: known ? prospective(history.changesInFleetToday, semantics) : null,
      accountShareOfFleetChanges: known ? prospectiveAccountShare(history) : null,
      // Converted once, above; the gate is told which reading it is getting.
      countSemantics: "prospective_including_candidate",
    },
    governance: {
      thresholdsOwnerApproved: false,
      ...META_BUDGET_PROPOSED_GOVERNANCE,
    },
    providerCompatibilityKnown: facts.providerCompatibilityKnown,
    automationEnabled: facts.automationEnabled,
    originMs: facts.originMs,
    intent: null,
    knownBindings: facts.knownBindings,
  };
}
