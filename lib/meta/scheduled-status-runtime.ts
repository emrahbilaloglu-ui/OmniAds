/**
 * The unattended executor for a queued status change.
 *
 * The approval route reaches the provider by forwarding to the manual HTTP
 * handler, and for an approval that is the truthful path: an operator really
 * did confirm, so `manual_operator_v1` and an explicit confirmation are
 * statements about something that happened. The scheduler has no operator. If
 * it went through the same handler it would have to supply a confirmation
 * nobody gave, and afterwards nothing in the action log could tell the two
 * authorities apart.
 *
 * So this drives the write primitive directly, journals under its own origin,
 * and re-proves the authority at the pre-POST boundary the primitive now
 * exposes. It returns the shape the shared claimed-execution lifecycle already
 * settles, so a scheduled attempt reaches the same marker, the same settle, the
 * same reconcile and the same ledger row as an approved one.
 */
import {
  createMetaAdsActionLog,
  completeMetaAdsActionLog,
} from "@/lib/meta/ads-action-log";
import {
  pauseAdset,
  pauseCampaign,
  resumeAdset,
  resumeCampaign,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type {
  BudgetProposalExecutionResult,
} from "@/lib/meta/budget-proposal-runtime";
import {
  evaluateScheduledAuthority,
  type ScheduledAuthorityGates,
} from "@/lib/meta/scheduled-action-execution";
import { readMetaWritePosture } from "@/lib/meta/automation-write-guard";

/** What the action log calls a write this sweep made. Never the manual origin. */
export const SCHEDULED_ACTION_ORIGIN = "scheduled_automation_v1" as const;

export interface ScheduledStatusRuntimeInput {
  proposal: MetaAutomationProposal;
  dryRunOnly: boolean;
  claimToken: string | null;
  authorization:
    | { kind: "manual"; explicitConfirmation: boolean; operatorUserId: string }
    | {
        kind: "scheduled";
        expectedEnablingActorUserId: string;
        expectedActivationControlVersion: string;
      };
  /** Fired at the pre-POST boundary by the shared lifecycle. */
  beforeProviderPost?: () => Promise<boolean>;
}

export interface ScheduledStatusRuntimeDeps {
  ctx: MetaAdsWriteContext;
  /** The full posture, re-read on demand. `null` means it could not be read. */
  readGates: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<ScheduledAuthorityGates | null>;
  /** The standing mode of this row's family, re-read at the boundary. */
  readMode: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<"manual" | "semi_auto" | "auto" | null>;
  now?: () => Date;
}

/**
 * Whether a failure leaves the provider's answer unknown.
 *
 * An unknown answer is never a failure and never a success: it parks in
 * reconcile, because the write may have landed and offering the row again
 * would apply it twice.
 */
function isAmbiguous(result: MetaAdsWriteFailure): boolean {
  // The same two facts the manual route reads, so one attempt cannot be
  // ambiguous on one path and merely failed on the other.
  return (
    result.error?.code === "provider_outcome_ambiguous"
    || result.providerOutcome === "outcome_ambiguous"
  );
}

export function createScheduledStatusRuntime(
  deps: ScheduledStatusRuntimeDeps,
): (input: ScheduledStatusRuntimeInput) => Promise<BudgetProposalExecutionResult> {
  const now = deps.now ?? (() => new Date());
  return async (input) => {
    const { proposal, claimToken } = input;
    const withheld = (reason: string): BudgetProposalExecutionResult => ({
      ok: false,
      receipt: {
        httpStatus: 422,
        response: null,
        dryRun: input.dryRunOnly,
        dispatchedAt: now().toISOString(),
        endpoint: null,
        withheld: reason as never,
        receiptKey: claimToken,
        providerMutationAttempted: false,
      },
      reconcile: false,
      rollbackRequested: false,
      journalId: null,
    });

    if (proposal.proposedAction !== "pause" && proposal.proposedAction !== "resume") {
      return withheld("composition_blocked");
    }
    if (!claimToken) return withheld("claim_absent");
    if (proposal.scopeType !== "campaign" && proposal.scopeType !== "adset") {
      // Ad-grain rows execute through the decision-origin ad write, which
      // carries a creative identity this path has no place inventing.
      return withheld("composition_blocked");
    }

    /*
      The cheap refusal first: reaching the provider costs an account request
      even when it is only a verification GET, and a row the gates already
      refuse should never spend one.
    */
    const gates = await deps.readGates({ proposal }).catch(() => null);
    const mode = await deps.readMode({ proposal }).catch(() => null);
    /*
      The SAME server posture every operator write answers to.

      This runtime passed `killSwitchEngaged: false` as a literal, which meant
      the unattended path — the one with nobody watching — was the only write
      family that never consulted the shared gate. The capability, the
      readiness tier, the STOP, the guard rules and quiet hours all live behind
      this one read.
    */
    const posture = await readMetaWritePosture({
      businessId: proposal.businessId,
    }).catch(() => null);
    if (!gates || !mode || !posture) return withheld("control_state_unavailable");
    if (posture.blocked) {
      return withheld(
        posture.reason === "release_capability_closed"
          ? "release_gate_closed"
          : posture.reason === "readiness_tier_read_only"
            ? "auto_execution_disabled"
            : "kill_switch_engaged",
      );
    }
    // Rehearsal downgrades an unattended write the same way it downgrades an
    // operator one: it runs, verifies and journals, and never posts.
    const rehearsing = posture.rehearsal || input.dryRunOnly === true;
    if (input.authorization.kind !== "scheduled") {
      // Manual approval has its own guarded path and its own true statements
      // about who confirmed. This runtime never speaks for an operator.
      return withheld("manual_confirmation_absent");
    }
    const expectation = {
      providerAccountId: proposal.providerAccountId,
      expectedEnablingActorUserId: input.authorization.expectedEnablingActorUserId,
      expectedActivationControlVersion:
        input.authorization.expectedActivationControlVersion,
      decisionType: "pause" as const,
    };
    const first = evaluateScheduledAuthority({
      gates,
      expectation,
      mode,
      killSwitchEngaged: false,
    });
    if (!first.authorized) return withheld(first.refusal);

    const dryRun = rehearsing;
    const targetStatus = proposal.proposedAction === "pause" ? "PAUSED" : "ACTIVE";
    const log = await createMetaAdsActionLog({
      businessId: proposal.businessId,
      providerAccountId: proposal.providerAccountId,
      adId: proposal.scopeId,
      creativeId: null,
      action: proposal.proposedAction,
      source: SCHEDULED_ACTION_ORIGIN,
      // Nobody requested this one. The enabling admin is on the proposal row
      // and in the ledger; the log must not name them as the requester.
      requestedBy: null,
      recIdOrigin: proposal.recId,
      payloadRequest: {
        method: "POST",
        endpoint: `/${proposal.scopeId}`,
        scope_type: proposal.scopeType,
        body: { status: targetStatus },
        dry_run: dryRun,
        action_origin: SCHEDULED_ACTION_ORIGIN,
        proposal_id: proposal.id,
        claim_token: claimToken,
      },
    }).catch(() => null);
    if (!log) return withheld("dispatch_marker_unavailable");

    /*
      The binding check, and the durable intent marker, in that order.

      Re-reading the authority first means a refusal never leaves a marker
      claiming a call may be live; writing the marker second means no request
      can begin without one. Either failing throws, and a throw in this hook is
      handled inside the write primitive before any request is made.
    */
    const beforeMutationAttempt = async (): Promise<void> => {
      const [currentGates, currentMode, currentPosture] = await Promise.all([
        deps.readGates({ proposal }).catch(() => null),
        deps.readMode({ proposal }).catch(() => null),
        readMetaWritePosture({ businessId: proposal.businessId }).catch(() => null),
      ]);
      if (!currentGates || !currentMode || !currentPosture) {
        throw new Error("control_state_unavailable");
      }
      if (currentPosture.blocked) throw new Error("kill_switch_engaged");
      // Rehearsal engaged between the claim and here: this call was composed as
      // a live write, so it is refused rather than silently downgraded.
      if (currentPosture.rehearsal && !rehearsing) {
        throw new Error("dry_run_guardrail");
      }
      const verdict = evaluateScheduledAuthority({
        gates: currentGates,
        expectation,
        mode: currentMode,
        killSwitchEngaged: false,
      });
      if (!verdict.authorized) throw new Error(verdict.refusal);
      if (input.beforeProviderPost) {
        const marked = await input.beforeProviderPost();
        if (!marked) throw new Error("dispatch_marker_unavailable");
      }
    };

    const startedAt = Date.now();
    const options = { dryRun, beforeMutationAttempt };
    const write =
      proposal.scopeType === "campaign"
        ? proposal.proposedAction === "pause"
          ? await pauseCampaign(deps.ctx, proposal.scopeId, options)
          : await resumeCampaign(deps.ctx, proposal.scopeId, options)
        : proposal.proposedAction === "pause"
          ? await pauseAdset(deps.ctx, proposal.scopeId, options)
          : await resumeAdset(deps.ctx, proposal.scopeId, options);

    if (!write.ok) {
      const ambiguous = isAmbiguous(write);
      await completeMetaAdsActionLog({
        id: log.id,
        status: ambiguous ? "silent_failure" : "failure",
        errorCode: write.error?.code ?? "meta_write_failed",
        errorMessage: write.error?.message ?? null,
        payloadResponse: (write.responsePayload ?? null) as Record<string, unknown> | null,
        durationMs: Date.now() - startedAt,
      }).catch(() => null);
      return {
        ok: false,
        receipt: {
          httpStatus: write.httpStatus ?? 502,
          response: write.responsePayload ?? null,
          dryRun,
          dispatchedAt: now().toISOString(),
          endpoint: `/${proposal.scopeId}`,
          withheld: null,
          receiptKey: claimToken,
          // The exact provider fact: a hook that refused never sent anything.
          providerMutationAttempted: write.mutationAttempt !== null
            && write.mutationAttempt !== undefined,
        },
        reconcile: ambiguous,
        rollbackRequested: false,
        journalId: log.id,
      };
    }

    await completeMetaAdsActionLog({
      id: log.id,
      status: "success",
      payloadResponse: (write.responsePayload ?? null) as Record<string, unknown> | null,
      durationMs: Date.now() - startedAt,
      verifiedAt: now().toISOString(),
      verificationPayload:
        (write.verificationPayload ?? null) as Record<string, unknown> | null,
    }).catch(() => null);

    return {
      ok: true,
      receipt: {
        httpStatus: 200,
        response: write.responsePayload ?? null,
        dryRun: write.dryRun === true,
        dispatchedAt: now().toISOString(),
        endpoint: `/${proposal.scopeId}`,
        withheld: null,
        receiptKey: claimToken,
        providerMutationAttempted: write.dryRun !== true,
      },
      reconcile: false,
      rollbackRequested: false,
      journalId: log.id,
    };
  };
}
