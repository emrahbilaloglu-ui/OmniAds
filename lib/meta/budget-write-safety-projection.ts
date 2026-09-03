/**
 * D088 C3 — the write-safety ceremony as it stands at PROJECTION time.
 *
 * A proposal is projected before anyone approves it, so the eighteen steps
 * split into two kinds and only one of them is a fact about this row:
 *
 *  - STATE steps — the role, the profile, the freshness of the provider read,
 *    the kill switch — are measured now, from the evidence the loader read.
 *    Unmeasured is `missing`, never `satisfied`.
 *  - PATH steps — business access, the physical account, the action origin,
 *    the target identity, the typed confirmation, the atomic claim, the
 *    receipts, the independent read-back and the reconciliation marker — are
 *    properties of the family that would execute the proposal, not of the row.
 *    Their status is READ from the canonical `WRITE_FAMILIES` declaration for
 *    `automation_proposal_approval`, which the conformance test enforces
 *    against the code, so a family that stopped implementing a step reports it
 *    here as `missing` instead of being asserted satisfied by this module.
 *
 * The point is that nothing below decides a step is satisfied on its own
 * authority. Every answer traces to either a measurement or the declaration.
 */
import {
  WRITE_FAMILIES,
  WRITE_SAFETY_STEPS,
  type WriteSafetyStep,
} from "@/lib/meta/write-safety-contract";
import type { SafetyFlag } from "@/lib/meta/budget-proposal-dry-run";

export type WriteSafetyState = "satisfied" | "missing" | "not_applicable";

export interface ProjectionSafetyFacts {
  /** The canonical resolver authorised the role for the exact campaign. */
  roleReady: boolean;
  /** The exact profile action row is a usable commercial verdict. */
  profileReady: boolean;
  /** A fresh provider GET produced the baseline this preview is built on. */
  baselineFresh: boolean;
  /** Neither kill switch is engaged and write endpoints are not blocked. */
  killSwitchClear: boolean;
  /** A campaign-role requirement the persisted guardrail actually declares. */
  requireResolvedCampaignRole: boolean;
  /** A commercial-anchor requirement the persisted guardrail declares. */
  requireCommercialAnchor: boolean;
}

export interface BudgetPolicySafetyFacts {
  currentAmountMinor: number | null;
  intendedAmountMinor: number;
  nowMs: number;
  policy: {
    maxChangePercent: number | null;
    minHoursBetweenChanges: number | null;
    maxChangesPer7d: number | null;
    maxAccountConcentrationPercent: number | null;
  };
  history: {
    lastChangeAtMs: number | null;
    changesInLast7d: number;
    accountConcentrationPercent: number;
  } | null;
}

const unknownPolicyFlag = (why: string): SafetyFlag => ({
  state: "unknown",
  source: null,
  asOf: null,
  why,
});

const measuredPolicyFlag = (
  engaged: boolean,
  nowMs: number,
  why: string,
): SafetyFlag => ({
  state: engaged ? "engaged" : "clear",
  source:
    "meta_automation_business_controls+meta_budget_write_journal+meta_entity_state_history",
  asOf: new Date(nowMs).toISOString(),
  why,
});

/**
 * Evaluate the persisted budget caps against the measured history.
 *
 * This is intentionally shared by projection and execution. Merely finding a
 * configured policy does not clear a cap, and merely finding any historical
 * change does not keep cooldown engaged forever. Invalid/missing inputs remain
 * unknown so D085 refuses them without reporting a fabricated breach.
 */
export function projectBudgetPolicySafety(
  facts: BudgetPolicySafetyFacts,
): Pick<Record<"cap" | "cooldown", SafetyFlag>, "cap" | "cooldown"> {
  const { policy, history } = facts;
  const nowValid = Number.isFinite(facts.nowMs);
  const minHoursValid = policy.minHoursBetweenChanges !== null
    && Number.isFinite(policy.minHoursBetweenChanges)
    && policy.minHoursBetweenChanges >= 0;

  let cooldown: SafetyFlag;
  if (!nowValid || !minHoursValid || history === null) {
    cooldown = unknownPolicyFlag("cooldown policy or measured history is unavailable");
  } else if (history.lastChangeAtMs === null) {
    cooldown = measuredPolicyFlag(false, facts.nowMs, "no prior verified budget change");
  } else if (!Number.isFinite(history.lastChangeAtMs)
    || history.lastChangeAtMs > facts.nowMs) {
    cooldown = unknownPolicyFlag("the last-change clock is invalid or in the future");
  } else {
    const elapsedHours = (facts.nowMs - history.lastChangeAtMs) / 3_600_000;
    const engaged = elapsedHours < policy.minHoursBetweenChanges!;
    cooldown = measuredPolicyFlag(
      engaged,
      facts.nowMs,
      engaged
        ? `only ${elapsedHours.toFixed(2)}h elapsed; ${policy.minHoursBetweenChanges}h is required`
        : `${elapsedHours.toFixed(2)}h elapsed; ${policy.minHoursBetweenChanges}h is required`,
    );
  }

  const capInputsValid = nowValid
    && Number.isSafeInteger(facts.currentAmountMinor)
    && (facts.currentAmountMinor ?? 0) > 0
    && Number.isSafeInteger(facts.intendedAmountMinor)
    && facts.intendedAmountMinor > 0
    && policy.maxChangePercent !== null
    && Number.isFinite(policy.maxChangePercent)
    && policy.maxChangePercent > 0
    && policy.maxChangesPer7d !== null
    && Number.isFinite(policy.maxChangesPer7d)
    && policy.maxChangesPer7d > 0
    && policy.maxAccountConcentrationPercent !== null
    && Number.isFinite(policy.maxAccountConcentrationPercent)
    && policy.maxAccountConcentrationPercent > 0
    && history !== null
    && Number.isInteger(history.changesInLast7d)
    && history.changesInLast7d >= 0
    && Number.isFinite(history.accountConcentrationPercent)
    && history.accountConcentrationPercent >= 0;

  let cap: SafetyFlag;
  if (!capInputsValid) {
    cap = unknownPolicyFlag("budget caps, baseline, or measured account history are unavailable");
  } else {
    const changePercent = Math.abs(
      (facts.intendedAmountMinor - facts.currentAmountMinor!)
        / facts.currentAmountMinor! * 100,
    );
    const breaches: string[] = [];
    if (changePercent > policy.maxChangePercent!) {
      breaches.push(`${changePercent.toFixed(2)}% change exceeds ${policy.maxChangePercent}%`);
    }
    if (history!.changesInLast7d >= policy.maxChangesPer7d!) {
      breaches.push(
        `${history!.changesInLast7d} changes in 7d reaches ${policy.maxChangesPer7d}`,
      );
    }
    if (history!.accountConcentrationPercent > policy.maxAccountConcentrationPercent!) {
      breaches.push(
        `${history!.accountConcentrationPercent.toFixed(2)}% concentration exceeds `
          + `${policy.maxAccountConcentrationPercent}%`,
      );
    }
    cap = measuredPolicyFlag(
      breaches.length > 0,
      facts.nowMs,
      breaches.length > 0 ? breaches.join("; ") : "magnitude, frequency, and concentration are within policy",
    );
  }

  return { cap, cooldown };
}

/** The steps this row's own evidence decides. Everything else is the path's. */
const STATE_STEPS: Readonly<Record<string, true>> = Object.freeze({
  exact_role_and_posture: true,
  parent_hierarchy_and_policy: true,
  fresh_provider_or_current_state_read: true,
  persisted_preflight: true,
  preflight_age_and_no_provider_contact_disclosure: true,
  independent_provider_readback: true,
  exact_identity_and_state_verification: true,
  rollback_or_compensation_record: true,
  server_side_kill_switch: true,
});

const FAMILY = WRITE_FAMILIES.find((family) => family.id === "automation_proposal_approval");

/**
 * How the `automation_proposal_approval` family DECLARES it satisfies one
 * path-structural step.
 *
 * Exported so the execution path and the projection path answer the same
 * question from the same source. Neither may assert a step on its own
 * authority: the declaration is machine-checked against the code by the
 * write-safety conformance test.
 */
export function declaredFamilyStatus(step: WriteSafetyStep): WriteSafetyState {
  const declared = FAMILY?.steps?.[step];
  return declared?.status === "implemented"
    ? "satisfied"
    : declared?.status === "not_applicable" ? "not_applicable" : "missing";
}

function measured(step: WriteSafetyStep, facts: ProjectionSafetyFacts): WriteSafetyState {
  switch (step) {
    case "exact_role_and_posture":
      if (facts.roleReady) return "satisfied";
      return facts.requireResolvedCampaignRole ? "missing" : "not_applicable";
    case "parent_hierarchy_and_policy":
      if (facts.profileReady) return "satisfied";
      return facts.requireCommercialAnchor ? "missing" : "not_applicable";
    case "server_side_kill_switch":
      return facts.killSwitchClear ? "satisfied" : "missing";
    default:
      // The remaining state steps all rest on the same fresh read.
      return facts.baselineFresh ? "satisfied" : "missing";
  }
}

/**
 * The ceremony map for a projected candidate.
 *
 * `not_applicable` is deliberately reachable only where a persisted guardrail
 * says the requirement does not apply — D085 refuses it as a satisfaction, so
 * it cannot buy a preview anything it did not earn.
 */
export function projectionWriteSafety(
  facts: ProjectionSafetyFacts,
): Record<WriteSafetyStep, WriteSafetyState> {
  const out = {} as Record<WriteSafetyStep, WriteSafetyState>;
  for (const step of WRITE_SAFETY_STEPS) {
    if (STATE_STEPS[step] === true) {
      out[step] = measured(step, facts);
      continue;
    }
    out[step] = declaredFamilyStatus(step);
  }
  return out;
}
