/**
 * D087 — the preflight every budget write must pass before a provider call.
 *
 * The rule this encodes is that UNKNOWN IS REFUSAL. Each gate answers a
 * question that has three possible answers — yes, no, and "I could not tell" —
 * and only the first permits a write. A missing policy is not a permissive
 * policy; an unreadable provider baseline is not a matching one.
 *
 * It is a pure function over facts the caller has already read, so the whole
 * chain is testable without a network, a database or a clock.
 */
import type { BudgetField } from "@/lib/meta/budget-intent-contract";
import type { ProviderCapabilityContract } from "@/lib/meta/budget-proposal-dry-run";
import { validateCapability } from "@/lib/meta/budget-proposal-dry-run";
import type { BudgetWriteRequest } from "@/lib/meta/budget-write-request";

export const BUDGET_WRITE_PREFLIGHT_BLOCKERS = [
  "actor_unauthenticated",
  "business_scope_mismatch",
  "account_scope_mismatch",
  "write_scope_not_bound",
  "governance_unverified",
  "kill_switch_engaged",
  "automation_disabled",
  "provider_capability_absent",
  "provider_baseline_unknown",
  "provider_baseline_stale",
  "provider_baseline_entity_mismatch",
  "provider_baseline_account_mismatch",
  "provider_baseline_field_mismatch",
  "provider_baseline_currency_mismatch",
  "compare_and_set_mismatch",
  "policy_unknown",
  "policy_magnitude_exceeded",
  "policy_spend_ceiling_exceeded",
  "policy_spend_ceiling_currency_mismatch",
  "policy_cooldown_active",
  "policy_change_frequency_exceeded",
  "policy_account_concentration_exceeded",
  "policy_history_unknown",
  "evidence_clock_unknown",
] as const;
export type BudgetWritePreflightBlocker =
  (typeof BUDGET_WRITE_PREFLIGHT_BLOCKERS)[number];

export interface BudgetWriteActorContext {
  userId: string;
  businessId: string;
  authenticated: boolean;
  /** The current write-scope binding, not a historical grant. */
  writeScopeBound: boolean;
  selectedProviderAccountId: string;
}

export interface BudgetWriteGovernance {
  verified: boolean;
  writeBlocked: boolean;
  killSwitchEngaged: boolean;
  blockReason: string | null;
}

/** A FRESH provider read, taken for this attempt. Never a warehouse row. */
export interface BudgetWriteProviderBaseline {
  entityId: string;
  providerAccountId: string;
  budgetField: BudgetField;
  amountMinor: number;
  currency: string;
  readAtMs: number;
}

export interface BudgetWritePolicy {
  maxChangePercent: number;
  minHoursBetweenChanges: number;
  maxChangesPer7d: number;
  maxAccountConcentrationPercent: number;
  maxBaselineAgeMinutes: number;
  /** Absolute intended budget ceiling, in the named minor-unit currency. */
  maxAmountMinor: number | null;
  currency: string | null;
}

export interface BudgetWriteHistory {
  lastChangeAtMs: number | null;
  changesInLast7d: number;
  accountConcentrationPercent: number;
}

export interface BudgetWritePreflightInput {
  request: BudgetWriteRequest;
  actor: BudgetWriteActorContext | null;
  governance: BudgetWriteGovernance | null;
  automationEnabled: boolean;
  capability: ProviderCapabilityContract | null;
  providerBaseline: BudgetWriteProviderBaseline | null;
  policy: BudgetWritePolicy | null;
  history: BudgetWriteHistory | null;
  nowMs: number;
}

export interface BudgetWritePreflightVerdict {
  ok: boolean;
  blockers: readonly BudgetWritePreflightBlocker[];
  /** The one question the adapter asks. False whenever anything is unknown. */
  mayCallProvider: boolean;
  /** Published so a surface can show the magnitude it refused, not just that it did. */
  changePercent: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function evaluateBudgetWritePreflight(
  input: BudgetWritePreflightInput,
): BudgetWritePreflightVerdict {
  const blockers: BudgetWritePreflightBlocker[] = [];
  const add = (blocker: BudgetWritePreflightBlocker) => {
    if (!blockers.includes(blocker)) blockers.push(blocker);
  };
  const request = input?.request;
  const nowMs = finite(input?.nowMs) ? input.nowMs : Number.NaN;

  // --- actor and scope -----------------------------------------------------
  const actor = isRecord(input?.actor) ? (input.actor as BudgetWriteActorContext) : null;
  if (!actor || actor.authenticated !== true) add("actor_unauthenticated");
  if (!actor || actor.businessId !== request?.scope.businessId) add("business_scope_mismatch");
  if (!actor || actor.selectedProviderAccountId !== request?.scope.providerAccountId) {
    add("account_scope_mismatch");
  }
  if (!actor || actor.writeScopeBound !== true) add("write_scope_not_bound");

  // --- governance and enablement ------------------------------------------
  const governance = isRecord(input?.governance)
    ? (input.governance as BudgetWriteGovernance) : null;
  if (!governance || governance.verified !== true) add("governance_unverified");
  if (!governance || governance.killSwitchEngaged === true || governance.writeBlocked === true) {
    add("kill_switch_engaged");
  }
  /*
    Enablement is a POSITIVE, explicit boolean. Anything else — undefined, a
    string, a missing control row — is not an enablement decision, and the
    default in this slice is that no such decision has been taken.
  */
  if (input?.automationEnabled !== true) add("automation_disabled");

  // --- provider capability -------------------------------------------------
  const capability = isRecord(input?.capability)
    ? (input.capability as ProviderCapabilityContract) : null;
  if (!capability) {
    add("provider_capability_absent");
  } else {
    const { valid } = validateCapability(capability, request?.budgetField);
    if (!valid || capability.budgetEndpointExists !== true
      || capability.dispatchVerbExists !== true) {
      add("provider_capability_absent");
    }
  }

  // --- the fresh provider baseline, and compare-and-set --------------------
  const baseline = isRecord(input?.providerBaseline)
    ? (input.providerBaseline as BudgetWriteProviderBaseline) : null;
  if (!baseline || !finite(baseline.readAtMs) || !finite(baseline.amountMinor)) {
    add("provider_baseline_unknown");
  } else {
    const policyForAge = isRecord(input?.policy)
      ? (input.policy as BudgetWritePolicy) : null;
    const maxAgeMs = policyForAge && finite(policyForAge.maxBaselineAgeMinutes)
      ? policyForAge.maxBaselineAgeMinutes * 60_000 : null;
    if (!Number.isFinite(nowMs) || maxAgeMs === null) {
      // Freshness cannot be judged without both a clock and a limit.
      add("provider_baseline_stale");
    } else if (nowMs - baseline.readAtMs > maxAgeMs || baseline.readAtMs > nowMs) {
      add("provider_baseline_stale");
    }
    if (baseline.entityId !== request?.scope.entityId) {
      add("provider_baseline_entity_mismatch");
    }
    if (baseline.providerAccountId !== request?.scope.providerAccountId) {
      add("provider_baseline_account_mismatch");
    }
    if (baseline.budgetField !== request?.budgetField) {
      add("provider_baseline_field_mismatch");
    }
    if (baseline.currency !== request?.currency) {
      add("provider_baseline_currency_mismatch");
    }
    /*
      COMPARE AND SET. The proposal was built against a retained amount; if the
      provider no longer holds that amount, somebody or something changed it
      after the proposal and the intended value is no longer the value that was
      reasoned about. This is checked LAST among the baseline gates so a
      mismatch on identity is never reported as a value race.
    */
    if (blockers.every((b) => !b.startsWith("provider_baseline_"))
      && baseline.amountMinor !== request?.baseline.amountMinor) {
      add("compare_and_set_mismatch");
    }
  }

  // --- policy --------------------------------------------------------------
  const policy = isRecord(input?.policy) ? (input.policy as BudgetWritePolicy) : null;
  const history = isRecord(input?.history) ? (input.history as BudgetWriteHistory) : null;
  const spendCeilingCleared = policy?.maxAmountMinor === null
    && policy?.currency === null;
  const spendCeilingSet = policy !== null
    && Number.isSafeInteger(policy.maxAmountMinor)
    && (policy.maxAmountMinor ?? 0) > 0
    && typeof policy.currency === "string"
    && /^[A-Z]{3}$/.test(policy.currency);
  let changePercent: number | null = null;
  if (!policy
    || !finite(policy.maxChangePercent) || !finite(policy.minHoursBetweenChanges)
    || !finite(policy.maxChangesPer7d) || !finite(policy.maxAccountConcentrationPercent)
    || !finite(policy.maxBaselineAgeMinutes)
    || (!spendCeilingCleared && !spendCeilingSet)) {
    add("policy_unknown");
  }
  if (!history || !finite(history.changesInLast7d)
    || !finite(history.accountConcentrationPercent)) {
    add("policy_history_unknown");
  }
  if (policy && request && finite(request.baseline.amountMinor)
    && request.baseline.amountMinor > 0) {
    changePercent = Math.abs(
      ((request.intendedAmountMinor - request.baseline.amountMinor)
        / request.baseline.amountMinor) * 100,
    );
    if (finite(policy.maxChangePercent) && changePercent > policy.maxChangePercent) {
      add("policy_magnitude_exceeded");
    }
  }
  if (policy && request && spendCeilingSet) {
    if (request.currency !== policy.currency) {
      add("policy_spend_ceiling_currency_mismatch");
    } else if (Number.isSafeInteger(policy.maxAmountMinor)
      && request.intendedAmountMinor > policy.maxAmountMinor!) {
      add("policy_spend_ceiling_exceeded");
    }
  }
  if (policy && history) {
    if (history.lastChangeAtMs !== null) {
      if (!finite(history.lastChangeAtMs) || !Number.isFinite(nowMs)) {
        add("policy_history_unknown");
      } else if (nowMs - history.lastChangeAtMs
        < policy.minHoursBetweenChanges * 3_600_000) {
        add("policy_cooldown_active");
      }
    }
    if (finite(history.changesInLast7d)
      && history.changesInLast7d >= policy.maxChangesPer7d) {
      add("policy_change_frequency_exceeded");
    }
    if (finite(history.accountConcentrationPercent)
      && history.accountConcentrationPercent > policy.maxAccountConcentrationPercent) {
      add("policy_account_concentration_exceeded");
    }
  }

  // --- the evidence clock --------------------------------------------------
  if (!request || !finite(request.evidenceAsOfMs) || !Number.isFinite(nowMs)
    || request.evidenceAsOfMs > nowMs) {
    add("evidence_clock_unknown");
  }

  const ok = blockers.length === 0;
  return {
    ok,
    blockers: Object.freeze(blockers),
    mayCallProvider: ok,
    changePercent: changePercent === null ? null : Math.round(changePercent * 100) / 100,
  };
}
