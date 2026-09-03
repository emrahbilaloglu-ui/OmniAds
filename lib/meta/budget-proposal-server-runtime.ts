/**
 * D088 C1 — the concrete, server-owned budget runtime.
 *
 * This is what the approval route passes to `executeMetaAutomationProposal`.
 * It runs AFTER the existing atomic claim, and it re-derives everything rather
 * than trusting the row: the stored envelope is re-parsed and re-fingerprinted,
 * the canonical fact is rebuilt from current retained observations, the
 * provider baseline is read fresh through the existing Meta read boundary, and
 * the durable D087 request is recomposed with the real claim token in its
 * identity — immediately before execution, not at projection time.
 *
 * Every reader it needs is injected, so the route can supply the real ones and
 * a test can supply mocked ones without a network.
 */
import type { NextRequest } from "next/server";

import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import {
  executeBudgetProposal,
  type BudgetProposalExecutionResult,
} from "@/lib/meta/budget-proposal-runtime";
import {
  composeBudgetExecutionCandidate,
  type BudgetCompositionSources,
} from "@/lib/meta/budget-execution-composition";
import {
  executeBudgetWrite,
  type BudgetWriteDeps,
} from "@/lib/meta/budget-write-execution";

/** `claimed_by`, `decided_by` and the journal's actor are UUID columns. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BUDGET_SERVER_RUNTIME_CONTRACT =
  "meta.budget-proposal-server-runtime.v1" as const;

export interface BudgetServerRuntimeReaders {
  /** Everything the composition root needs, read for THIS entity, right now. */
  loadCompositionSources(input: {
    proposal: MetaAutomationProposal;
    claimToken: string;
    /*
      D088 C3: the CURRENT attempt's facts, not the row's stale copy.

      C2 derived "a claim is held" and "this was explicitly approved" from
      `proposal.claimToken` / `proposal.decidedBy`, which are read BEFORE the
      claim is taken and before the approval is recorded — so every manual
      approval composed with `conflict_unverified` and a missing
      `typed_or_explicit_confirmation`, and D085 could never answer anything but
      blocked. The runtime holds both facts and passes them.
    */
    explicitlyApproved: boolean;
  }): Promise<Omit<BudgetCompositionSources, "proposalId" | "claimToken"> | null>;
  /** The persisted controls and release gates, read fresh. */
  readGates(input: { proposal: MetaAutomationProposal }): Promise<{
    releaseGateOpen: boolean;
    autoExecutionEnabled: boolean;
    /** The PERSISTED guardrail, read rather than inferred from the gate. */
    dryRunOnly?: boolean;
    /** The admin who persisted the enablement. The scheduler's authority. */
    enablingActorUserId?: string | null;
    /** The account the enablement was proven for. */
    enabledProviderAccountId?: string | null;
    /** Persisted business cap for unattended writes in a rolling 24h window. */
    dailyAutoActionCap?: number | null;
  }>;
  /** The D087 executor's dependencies, bound to the real journal and adapter. */
  writeDeps(input: {
    proposal: MetaAutomationProposal;
    claimToken: string;
    /*
      D088 C3: whether THIS execution is authorized to reach the provider.

      D087 calls its gate `automationEnabled`, and the readers derived it from
      the business's automatic-execution flag alone — so a manual approval with
      automatic execution OFF passed every gate here and was then refused by
      the preflight as `automation_disabled`, which was not true of it. The
      authorization is decided once, above, and travels.
    */
    providerWriteAuthorized: boolean;
  }): Promise<BudgetWriteDeps>;
  /*
    D088 C3: there is no composition seam.

    C2 kept an optional `compose` so a test could hand the runtime an
    admissible candidate, on the grounds that D085's authority floor was
    unreachable here. `budget-production-path.c3.test.ts` reaches it from the
    real candidate SQL, so the seam bought nothing except the ability to prove
    the injected object instead of the path.
  */
}

export interface BudgetServerRuntimeInput {
  proposal: MetaAutomationProposal;
  dryRunOnly: boolean;
  claimToken: string | null;
  /**
   * D088 C3: the two authorizations are DIFFERENT.
   *
   * A manual approval is authorized by the operator's explicit confirmation and
   * needs no automatic enablement — that is what "manual" means. A scheduled
   * execution has no operator, so it requires account-bound auto enablement.
   * Conflating them made manual approval impossible while automation was off,
   * which is the state this product ships in.
   */
  authorization:
    | { kind: "manual"; explicitConfirmation: boolean; operatorUserId: string }
    | { kind: "scheduled" };
  /** Fired at the pre-POST boundary by the shared lifecycle. */
  beforeProviderPost?: () => Promise<boolean>;
}

/**
 * Build the runtime the route passes in.
 *
 * It is a closure over the readers rather than a free function so the route
 * supplies its request-scoped context once and every proposal in that request
 * uses the same one.
 */
export function createBudgetProposalServerRuntime(
  readers: BudgetServerRuntimeReaders,
): (input: BudgetServerRuntimeInput) => Promise<BudgetProposalExecutionResult> {
  return async (input) => {
    const { proposal, claimToken } = input;
    const withheld = (reason: string): BudgetProposalExecutionResult => ({
      ok: false,
      receipt: {
        httpStatus: 422, response: null, dryRun: input.dryRunOnly,
        dispatchedAt: new Date().toISOString(), endpoint: null,
        withheld: reason as never, receiptKey: claimToken,
      },
      reconcile: false, rollbackRequested: false, journalId: null,
    });

    /*
      The envelope is the row's whole authority. `mapProposalRow` already
      refuses to produce one that does not re-fingerprint, so a null here means
      the row is unexecutable — a pre-migration read, a non-budget action, or a
      row that was edited after it was written.
    */
    const envelope = proposal.budgetEnvelope;
    if (!envelope) return withheld("composition_blocked");
    if (!claimToken) return withheld("claim_absent");

    const gates = await readers.readGates({ proposal });
    /*
      The gates first, and nothing else if they are shut.

      Composing means reading observations and taking a FRESH provider baseline
      — a real GET against the account. Doing that for a proposal that cannot be
      executed would tell the provider we are interested in an entity we may not
      touch, and would cost the account a request for nothing.
    */
    if (gates.releaseGateOpen !== true) return withheld("release_gate_closed");
    /*
      Manual approval is authorized by the operator; only the scheduled path
      needs the account-bound automatic enablement.
    */
    if (input.authorization.kind === "manual") {
      if (input.authorization.explicitConfirmation !== true) {
        return withheld("manual_confirmation_absent");
      }
    } else if (gates.autoExecutionEnabled !== true) {
      return withheld("auto_execution_disabled");
    } else if (gates.enabledProviderAccountId !== proposal.providerAccountId) {
      // One account's confirmation never enables another account.
      return withheld("account_not_activated");
    } else if (!UUID_PATTERN.test(gates.enablingActorUserId ?? "")) {
      /* No enabling admin — or one that is not a real user id — means no
         authority to act under, and the claim/journal columns are UUIDs. */
      return withheld("enabling_actor_absent");
    }
    // The caller's posture OR the persisted guardrail. Either one holds.
    if (input.dryRunOnly === true || gates.dryRunOnly === true) {
      return withheld("dry_run_guardrail");
    }

    /*
      The authorization this execution actually holds, restated for D087. A
      manual approval is authorized by the operator's confirmation; a scheduled
      one by the account-bound enablement and its enabling admin.
    */
    const providerWriteAuthorized = input.authorization.kind === "manual"
      ? input.authorization.explicitConfirmation === true
      : gates.autoExecutionEnabled === true
        && gates.enabledProviderAccountId === proposal.providerAccountId
        && Boolean(gates.enablingActorUserId);

    const sources = await readers.loadCompositionSources({
      proposal, claimToken,
      /* Manual: the operator's confirmation. Scheduled: the account-bound
         enablement its own gate above has already proven. */
      explicitlyApproved: providerWriteAuthorized,
    });
    if (!sources) return withheld("composition_blocked");

    // RECOMPOSED here, with the real claim in the durable identity.
    const composed = composeBudgetExecutionCandidate({
      ...sources,
      proposalId: proposal.id,
      claimToken,
    });

    const writeDeps = await readers.writeDeps({
      proposal, claimToken, providerWriteAuthorized,
    });
    return executeBudgetProposal({
      envelope,
      claimToken,
      /*
        The APPROVING actor, never the claim holder. `claimedBy` records who
        holds the row, which is not who authorized the change.
      */
      actorUserId: input.authorization.kind === "manual"
        ? input.authorization.operatorUserId
        : (gates.enablingActorUserId ?? ""),
      dryRunOnly: input.dryRunOnly,
      releaseGateOpen: gates.releaseGateOpen,
      // The authorization THIS execution holds, not the business-wide flag.
      autoExecutionEnabled: providerWriteAuthorized,
      composition: {
        blockers: composed.blockers,
        request: composed.request,
        dryRunStatus: composed.dryRun?.status ?? "unavailable",
        dryRunBlockers: composed.dryRun?.blockers ?? [],
        requestFingerprint: composed.requestFingerprint,
      },
      // The ONE executor. Manual approval and the sweep both arrive here.
      execute: async (request) => executeBudgetWrite(writeDeps, request, {
        beforeProviderPost: input.beforeProviderPost,
      }),
    });
  };
}

/** Convenience for callers that hold a `NextRequest` but need no part of it. */
export type BudgetRuntimeForRequest = (request: NextRequest) =>
  (input: BudgetServerRuntimeInput) => Promise<BudgetProposalExecutionResult>;
