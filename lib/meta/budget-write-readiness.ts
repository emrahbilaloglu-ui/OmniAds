/**
 * D087 — what the surface is allowed to say about the budget write capability.
 *
 * The rule from D085 and D086 holds unchanged: the UI computes nothing. It does
 * not decide an entity, a field, a magnitude or a role, and it does not decide
 * whether execution is possible. This module answers that question once, on the
 * server, from the same preflight the executor would run, and hands the surface
 * a set of strings to print.
 */
import {
  D087_ACTIVATION_BLOCKERS,
  D087_BUDGET_TRANSPORT_CAPABILITY,
  budgetWriteIsActivated,
  type BudgetWriteActivationBlocker,
} from "@/lib/meta/budget-write-capability";
import type { BudgetField, BudgetOwnerGrain } from "@/lib/meta/budget-intent-contract";
import {
  evaluateBudgetWritePreflight,
  type BudgetWritePreflightInput,
} from "@/lib/meta/budget-write-preflight";
import { parseBudgetWriteRequest } from "@/lib/meta/budget-write-request";

export const BUDGET_WRITE_READINESS_CONTRACT = "meta.budget-write-readiness.v1" as const;

export interface BudgetWriteProposalView {
  proposalId: string;
  ownerGrain: BudgetOwnerGrain;
  entityId: string;
  budgetField: BudgetField;
  currency: string;
  currencyExponent: number;
  beforeAmountMinor: number;
  intendedAmountMinor: number;
  /** Signed, so the surface never has to compute a direction. */
  changePercent: number | null;
  evidenceAsOf: string;
  evidenceAgeHours: number | null;
}

export interface BudgetWriteExecutionView {
  /** Always false in this slice, and the surface must render it. */
  executionEnabled: boolean;
  capabilityPrepared: boolean;
  activationBlockers: readonly BudgetWriteActivationBlocker[];
  preflightBlockers: readonly string[];
  readbackState: "not_attempted" | "verified" | "failed" | "unknown";
  rollbackEligible: boolean;
  lastAttemptAt: string | null;
  /**
   * D088: the queue states the operator is actually looking at. Server facts,
   * like everything else here — the surface computes none of them.
   */
  proposalState: string | null;
  claimState: "unclaimed" | "claimed" | "settled" | null;
  reconcileState: "none" | "pending" | "resolved" | null;
  /** Why activation is impossible right now, from the same verdict the
   *  ceremony would evaluate. */
  activationReadyBlockers: readonly string[];
  /*
    D088 C3: the provider account automatic execution is actually enabled FOR.

    The control row is business-wide, so "automation is on" is not an answer:
    an operator looking at account B must be able to see that the activation
    they are looking at was performed for account A, and that nothing on this
    account will execute. `null` means no account is activated.
  */
  activatedProviderAccountId: string | null;
}

import type { BudgetPreparationView } from "@/lib/meta/budget-preparation-contract";

export interface BudgetWriteReadinessModel {
  contract: typeof BUDGET_WRITE_READINESS_CONTRACT;
  businessId: string;
  providerAccountId: string;
  proposal: BudgetWriteProposalView | null;
  execution: BudgetWriteExecutionView;
  /** Why there is no proposal, when there is none. Never an empty surface. */
  unavailableReason: string | null;
  /*
    PRE-DEPLOY AUDIT: the persisted preparation, for the admin form that writes
    it. Optional because every existing caller predates it and a missing block
    must read as "not supplied" rather than as "nothing is prepared" — the
    section renders an absent block as unknown, never as unset.
  */
  preparation?: BudgetPreparationView | null;
}

export interface BudgetWriteReadinessInput {
  /** Passed straight through to the model; never derived here. */
  preparation?: BudgetPreparationView | null;
  businessId: string;
  providerAccountId: string;
  /** The candidate request, exactly as the executor would receive it. */
  candidate: unknown;
  preflight: Omit<BudgetWritePreflightInput, "request" | "capability"> | null;
  lastAttempt: {
    at: string | null;
    readbackState: BudgetWriteExecutionView["readbackState"];
    rollbackEligible: boolean;
  } | null;
  /** D088: the live queue/claim/reconcile facts for this entity, if any. */
  runtime?: {
    /** Exact-account persisted activation, read by the server. */
    executionEnabled?: boolean;
    proposalState: string | null;
    claimState: BudgetWriteExecutionView["claimState"];
    reconcileState: BudgetWriteExecutionView["reconcileState"];
    activationReadyBlockers: readonly string[];
    activatedProviderAccountId?: string | null;
  } | null;
}

/**
 * Build the surface's whole truth in one place.
 *
 * A caller with no candidate proposal still gets a model: the capability, the
 * activation blockers and the reason there is nothing to show. An empty panel
 * would be indistinguishable from a working one that found nothing.
 */
export function buildBudgetWriteReadiness(
  input: BudgetWriteReadinessInput,
): BudgetWriteReadinessModel {
  const execution: BudgetWriteExecutionView = {
    // The compatibility default remains false; a server read may prove the
    // exact account was deliberately activated.
    executionEnabled: input.runtime?.executionEnabled ?? budgetWriteIsActivated(),
    capabilityPrepared: D087_BUDGET_TRANSPORT_CAPABILITY.budgetEndpointExists === true,
    activationBlockers: input.runtime?.executionEnabled === true
      ? Object.freeze([])
      : D087_ACTIVATION_BLOCKERS,
    preflightBlockers: [],
    readbackState: input.lastAttempt?.readbackState ?? "not_attempted",
    rollbackEligible: input.lastAttempt?.rollbackEligible === true,
    lastAttemptAt: input.lastAttempt?.at ?? null,
    proposalState: input.runtime?.proposalState ?? null,
    claimState: input.runtime?.claimState ?? null,
    reconcileState: input.runtime?.reconcileState ?? null,
    activationReadyBlockers: input.runtime?.activationReadyBlockers ?? Object.freeze([]),
    activatedProviderAccountId: input.runtime?.activatedProviderAccountId ?? null,
  };

  const parsed = parseBudgetWriteRequest(input.candidate);
  if (!parsed.ok) {
    return {
      contract: BUDGET_WRITE_READINESS_CONTRACT,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      proposal: null,
      execution: { ...execution, preflightBlockers: Object.freeze([parsed.code]) },
      unavailableReason: parsed.message,
      preparation: input.preparation ?? null,
    };
  }
  const request = parsed.request;

  const verdict = input.preflight
    ? evaluateBudgetWritePreflight({
      ...input.preflight,
      request,
      capability: D087_BUDGET_TRANSPORT_CAPABILITY,
    })
    : null;

  const evidenceAgeHours = input.preflight && Number.isFinite(input.preflight.nowMs)
    ? Math.max(0, (input.preflight.nowMs - request.evidenceAsOfMs) / 3_600_000)
    : null;

  return {
    contract: BUDGET_WRITE_READINESS_CONTRACT,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    proposal: {
      proposalId: request.proposalId,
      ownerGrain: request.scope.ownerGrain,
      entityId: request.scope.entityId,
      budgetField: request.budgetField,
      currency: request.currency,
      currencyExponent: request.currencyExponent,
      beforeAmountMinor: request.baseline.amountMinor,
      intendedAmountMinor: request.intendedAmountMinor,
      changePercent: verdict?.changePercent ?? null,
      evidenceAsOf: request.evidenceAsOf,
      evidenceAgeHours: evidenceAgeHours === null
        ? null : Math.round(evidenceAgeHours * 10) / 10,
    },
    execution: {
      ...execution,
      preflightBlockers: verdict
        ? verdict.blockers
        : Object.freeze(["preflight_inputs_unavailable"]),
    },
    unavailableReason: verdict ? null : "The preflight inputs could not be read.",
    preparation: input.preparation ?? null,
  };
}
