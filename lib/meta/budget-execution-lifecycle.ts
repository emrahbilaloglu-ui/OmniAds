/**
 * D088 C2 — ONE claimed-execution lifecycle, shared by manual approval and the
 * scheduled sweep.
 *
 * C1 left the scheduler calling the runtime directly: it claimed rows and then
 * neither marked dispatch, settled, reconciled nor wrote a ledger row, so a
 * scheduled attempt could strand a row as `claimed` forever and leave no trace
 * an operator could read. Both paths now enter here.
 *
 * Two invariants the shape enforces:
 *
 * - A result WITHHELD before the provider was reached never marks dispatch as
 *   started. "We decided not to call" and "we called and heard nothing" are
 *   different facts and an operator must be able to tell them apart.
 * - A claimed row is always settled. An executor that throws settles to
 *   `reconcile`, because the write may have landed.
 */
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type { BudgetProposalExecutionResult } from "@/lib/meta/budget-proposal-runtime";

export const CLAIMED_EXECUTION_CONTRACT = "meta.claimed-proposal-execution.v1" as const;

export type ClaimedSettleStatus = "approved" | "failed" | "reconcile";

export interface ClaimedLedgerEntry {
  activityType:
    | "automation_proposal_approved"
    | "automation_proposal_failed"
    | "automation_proposal_reconcile";
  severity: "success" | "danger";
  message: string;
  payload: Record<string, unknown>;
}

export interface ClaimedExecutionDeps {
  businessId: string;
  providerAccountId: string;
  proposal: MetaAutomationProposal;
  claimToken: string;
  actorUserId: string;
  executionKind: "manual" | "scheduled";
  /**
   * Stamped SYNCHRONOUSLY, immediately before the provider POST.
   *
   * D088 C3: C2 marked after the outcome, which is not crash-safe — a process
   * that died mid-POST left no record that a call had been entered. The
   * executor calls this at the `writeBudget` boundary and refuses to POST if it
   * fails, so "a call may be live" is always recorded before it can be.
   */
  markDispatchStarted(input: {
    businessId: string; proposalId: string; claimToken: string;
  }): Promise<boolean>;
  settle(input: {
    businessId: string; proposalId: string; claimToken: string;
    status: ClaimedSettleStatus; decidedBy: string;
    receipt: BudgetProposalExecutionResult["receipt"];
  }): Promise<MetaAutomationProposal | null>;
  /** Last-resort durable hold when the normal terminal settlement is lost. */
  forceReconcile(input: {
    businessId: string; proposalId: string; claimToken: string;
  }): Promise<boolean>;
  /** Append the in-memory receipt when the normal settlement did not land. */
  recordReconciliation(input: {
    proposal: MetaAutomationProposal;
    claimToken: string;
    receipt: BudgetProposalExecutionResult["receipt"];
  }): Promise<boolean>;
  recordLedger(input: ClaimedLedgerEntry): Promise<void>;
  execute(
    beforeProviderPost: () => Promise<boolean>,
  ): Promise<BudgetProposalExecutionResult>;
}

export interface ClaimedExecutionResult {
  ok: boolean;
  contract: typeof CLAIMED_EXECUTION_CONTRACT;
  settledStatus: ClaimedSettleStatus;
  /** Whether a provider call was entered at all. */
  providerDispatchStarted: boolean;
  /** Whether its outcome is established. */
  providerOutcomeKnown: boolean;
  reconcile: boolean;
  rollbackRequested: false;
  lostTheRow: boolean;
  /** The normal terminal compare-and-set threw or matched no row. */
  settlementFailed: boolean;
  /** Whether the fallback status-only reconcile update landed. */
  reconciliationHeld: boolean;
  /** Whether the append-only reconciliation receipt landed. */
  reconciliationRecorded: boolean;
  /** The settled row, so a caller does not settle a second time to see it. */
  settled: MetaAutomationProposal | null;
  /** True when the pre-POST marker could not be written, so nothing was sent. */
  markerFailed: boolean;
  receipt: BudgetProposalExecutionResult["receipt"];
  journalId: string | null;
}

export async function runClaimedProposalExecution(
  deps: ClaimedExecutionDeps,
): Promise<ClaimedExecutionResult> {
  let outcome: BudgetProposalExecutionResult;
  let threw = false;
  let markerWritten = false;
  let markerFailed = false;
  /*
    The marker, fired from inside the executor at the literal pre-POST
    boundary. It is idempotent for one attempt and it VETOES the write when it
    cannot be recorded: a provider call nobody knows was made is the one state
    reconciliation cannot recover from.
  */
  const beforeProviderPost = async (): Promise<boolean> => {
    if (markerWritten) return true;
    const ok = await deps.markDispatchStarted({
      businessId: deps.businessId,
      proposalId: deps.proposal.id,
      claimToken: deps.claimToken,
    }).catch(() => false);
    if (ok) markerWritten = true; else markerFailed = true;
    return ok;
  };
  try {
    outcome = await deps.execute(beforeProviderPost);
  } catch {
    /*
      The executor entered and produced no answer. The row must not stay
      claimed, and the outcome must not be reported as a failure: a write may be
      live at the provider.
    */
    threw = true;
    outcome = {
      ok: false,
      receipt: {
        httpStatus: 502, response: null, dryRun: false,
        dispatchedAt: new Date().toISOString(),
        endpoint: `${deps.proposal.scopeType}:${deps.proposal.scopeId}`,
        withheld: null, receiptKey: deps.claimToken,
      },
      reconcile: true, rollbackRequested: false, journalId: null,
    };
  }

  /*
    WITHHELD means the gates refused before the provider. The marker was never
    fired, so a refusal stays distinguishable from an attempt in every
    downstream read.
  */
  const withheld = outcome.receipt.withheld !== null;
  const providerDispatchStarted = markerWritten;
  /*
    A marker that could not be written vetoed the POST, so the outcome is a
    definite non-attempt, not an unknown one.
  */
  const outcomeNeedsReconcile = (outcome.reconcile === true || threw) && !markerFailed;
  let settledStatus: ClaimedSettleStatus = outcomeNeedsReconcile
    ? "reconcile"
    : outcome.ok ? "approved" : "failed";

  const receipt = {
    ...outcome.receipt,
    executionKind: deps.executionKind,
  };
  let settled: MetaAutomationProposal | null = null;
  let settlementFailed = false;
  try {
    settled = await deps.settle({
      businessId: deps.businessId,
      proposalId: deps.proposal.id,
      claimToken: deps.claimToken,
      status: settledStatus,
      decidedBy: deps.actorUserId,
      receipt,
    });
    settlementFailed = settled === null;
  } catch {
    settlementFailed = true;
  }

  /*
    A provider write whose terminal row could not be persisted is not a
    success, even when the provider answer itself was verified. Hold the claim
    in `reconcile` through the minimal post-dispatch path so neither the manual
    response nor the scheduler can count it as applied or offer it again.
  */
  const settlementNeedsReconcile = settlementFailed && providerDispatchStarted;
  let reconciliationHeld = false;
  let reconciliationRecorded = false;
  if (settlementNeedsReconcile) {
    reconciliationHeld = await deps.forceReconcile({
      businessId: deps.businessId,
      proposalId: deps.proposal.id,
      claimToken: deps.claimToken,
    }).catch(() => false);
    reconciliationRecorded = await deps.recordReconciliation({
      proposal: deps.proposal,
      claimToken: deps.claimToken,
      receipt,
    }).catch(() => false);
    settledStatus = "reconcile";
  }
  const reconcile = outcomeNeedsReconcile || settlementNeedsReconcile;

  const entity = deps.proposal.entityLabel ?? deps.proposal.scopeId;
  await deps.recordLedger({
    activityType: reconcile
      ? "automation_proposal_reconcile"
      : outcome.ok ? "automation_proposal_approved" : "automation_proposal_failed",
    severity: outcome.ok && !reconcile ? "success" : "danger",
    message: reconcile
      ? `Proposal outcome unknown — ${deps.proposal.actionLabel} on ${entity}.`
      : outcome.ok
        ? `Proposal approved — ${deps.proposal.actionLabel} on ${entity}.`
        : `Proposal was not applied — ${deps.proposal.actionLabel} on ${entity}`
          + `${withheld ? ` (${outcome.receipt.withheld}).` : "."}`,
    payload: {
      proposalId: deps.proposal.id,
      receiptKey: deps.claimToken,
      recId: deps.proposal.recId,
      decisionKey: deps.proposal.decisionKey,
      providerAccountId: deps.providerAccountId,
      receipt,
      // Three separate facts, never one boolean.
      providerDispatchStarted,
      providerOutcomeKnown: providerDispatchStarted && !reconcile,
      providerWriteSucceeded: providerDispatchStarted && !reconcile && outcome.ok,
      journalId: outcome.journalId,
    },
  }).catch(() => undefined);

  return {
    ok: outcome.ok && providerDispatchStarted && !reconcile && !markerFailed,
    contract: CLAIMED_EXECUTION_CONTRACT,
    markerFailed,
    settledStatus,
    providerDispatchStarted,
    providerOutcomeKnown: providerDispatchStarted && !reconcile,
    reconcile,
    rollbackRequested: false,
    lostTheRow: settled === null,
    settlementFailed,
    reconciliationHeld,
    reconciliationRecorded,
    settled,
    receipt,
    journalId: outcome.journalId,
  };
}
