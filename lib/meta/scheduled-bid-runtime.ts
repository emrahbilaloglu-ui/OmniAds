/**
 * The unattended executor for a queued bid change.
 *
 * It exists because `bid` was an allowed queue action with no producer and no
 * executor: the sweep dispatched budget, pause and resume, and a bid row — had
 * one ever been raised — would have been claimed and then withheld as
 * `composition_blocked`. The row now carries an envelope with an exact amount,
 * so there is finally something to execute.
 *
 * It follows the scheduled status runtime step for step, because the two are
 * the same kind of act: an unattended write that must never speak for an
 * operator, must re-prove its authority at the pre-POST boundary, and must
 * journal under its own origin. What it adds is the one thing a bid has that a
 * status does not — a number whose meaning depends on a provider setting that
 * can move underneath it.
 *
 * ## Why the baseline is read again here
 *
 * The sizing policy reasoned from a retained `bid_amount` and a retained
 * strategy, hours earlier. Between then and now an operator can change either
 * in Ads Manager. Writing 1320 onto an ad set that is no longer on a cap, or
 * whose cap somebody has already moved to 1500, is not the change anybody
 * approved — so both are read from the provider immediately before the write
 * and both must still agree with the envelope.
 */
import {
  completeMetaAdsActionLog,
  createMetaAdsActionLog,
} from "@/lib/meta/ads-action-log";
import {
  readMetaAdsetBidState,
  updateAdsetBidAmount,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";
import { bidStrategyFamily } from "@/lib/meta/bid-sizing-policy";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type {
  BudgetProposalExecutionResult,
  BudgetProposalWithheldReason,
} from "@/lib/meta/budget-proposal-runtime";
import {
  evaluateScheduledAuthority,
  type ScheduledAuthorityGates,
} from "@/lib/meta/scheduled-action-execution";
import { readMetaWritePosture } from "@/lib/meta/automation-write-guard";
import { SCHEDULED_ACTION_ORIGIN } from "@/lib/meta/scheduled-status-runtime";

export interface ScheduledBidRuntimeInput {
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
  beforeProviderPost?: () => Promise<boolean>;
}

export interface ScheduledBidRuntimeDeps {
  ctx: MetaAdsWriteContext;
  readGates: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<ScheduledAuthorityGates | null>;
  readMode: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<"manual" | "semi_auto" | "auto" | null>;
  now?: () => Date;
}

/** The same two facts the other write paths read, so one attempt cannot be
 *  ambiguous on one path and merely failed on the other. */
function isAmbiguous(result: MetaAdsWriteFailure): boolean {
  return (
    result.error?.code === "provider_outcome_ambiguous"
    || result.providerOutcome === "outcome_ambiguous"
  );
}

export function createScheduledBidRuntime(
  deps: ScheduledBidRuntimeDeps,
): (input: ScheduledBidRuntimeInput) => Promise<BudgetProposalExecutionResult> {
  const now = deps.now ?? (() => new Date());
  return async (input) => {
    const { proposal, claimToken } = input;
    const withheld = (
      reason: BudgetProposalWithheldReason,
    ): BudgetProposalExecutionResult => ({
      ok: false,
      receipt: {
        httpStatus: 422,
        response: null,
        dryRun: input.dryRunOnly,
        dispatchedAt: now().toISOString(),
        endpoint: null,
        withheld: reason,
        receiptKey: claimToken,
        providerMutationAttempted: false,
      },
      reconcile: false,
      rollbackRequested: false,
      journalId: null,
    });

    if (proposal.proposedAction !== "bid") return withheld("composition_blocked");
    if (proposal.scopeType !== "adset") return withheld("composition_blocked");
    if (!claimToken) return withheld("claim_absent");
    /*
      No envelope, no write.

      The database refuses a `bid` row without one, so a null here means the
      stored value did not parse, its arithmetic did not hold, or it named
      another row. Every one of those describes a bid change of unknown size.
    */
    const envelope = proposal.bidEnvelope;
    if (!envelope) return withheld("bid_envelope_absent");

    const gates = await deps.readGates({ proposal }).catch(() => null);
    const mode = await deps.readMode({ proposal }).catch(() => null);
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
    const rehearsing = posture.rehearsal || input.dryRunOnly === true;
    if (input.authorization.kind !== "scheduled") {
      return withheld("manual_confirmation_absent");
    }
    const expectation = {
      providerAccountId: proposal.providerAccountId,
      expectedEnablingActorUserId: input.authorization.expectedEnablingActorUserId,
      expectedActivationControlVersion:
        input.authorization.expectedActivationControlVersion,
      decisionType: "bid" as const,
    };
    const first = evaluateScheduledAuthority({
      gates, expectation, mode, killSwitchEngaged: false,
    });
    if (!first.authorized) return withheld(first.refusal);

    /*
      The live baseline, read before anything is composed.

      Three separate refusals, because they are three different situations and
      an operator reading the receipt has to be able to tell them apart.
    */
    const baseline = await readMetaAdsetBidState(deps.ctx, envelope.entityId)
      .catch(() => null);
    if (!baseline || !baseline.ok) return withheld("bid_baseline_unreadable");
    const liveFamily = bidStrategyFamily(baseline.bidStrategy);
    if (liveFamily === null || liveFamily !== bidStrategyFamily(envelope.bidStrategyType)) {
      // Either the strategy no longer owns a writable amount, or it is not the
      // strategy this amount was reasoned under. `manual_bid` lands here too,
      // which is exactly the settlement the plan asked a real read to make.
      return withheld("bid_strategy_not_writable");
    }
    if (baseline.bidAmountMinor === null) return withheld("bid_baseline_unreadable");
    if (baseline.bidAmountMinor !== envelope.currentMinorUnits) {
      /*
        Somebody moved the cap since the decision.

        The proposed amount is a percentage of a number that is no longer
        current, so applying it would be a change of the wrong size. The row is
        refused rather than recomputed: recomputing here would be this runtime
        sizing a bid, which is the producer's job and the card's evidence.
      */
      return withheld("bid_baseline_changed");
    }

    const dryRun = rehearsing;
    const log = await createMetaAdsActionLog({
      businessId: proposal.businessId,
      providerAccountId: proposal.providerAccountId,
      adId: proposal.scopeId,
      creativeId: null,
      action: "bid",
      source: SCHEDULED_ACTION_ORIGIN,
      // Nobody requested this one; the enabling admin is on the proposal row.
      requestedBy: null,
      recIdOrigin: proposal.recId,
      payloadRequest: {
        method: "POST",
        endpoint: `/${proposal.scopeId}`,
        scope_type: "adset",
        body: { bid_amount: envelope.proposedMinorUnits },
        dry_run: dryRun,
        action_origin: SCHEDULED_ACTION_ORIGIN,
        proposal_id: proposal.id,
        claim_token: claimToken,
        // Written before the POST: what a compensating action would restore.
        prior_state: {
          bid_amount: baseline.bidAmountMinor,
          bid_strategy: baseline.bidStrategy,
        },
        rollback: { operation: "set", field: "bid_amount", bid_amount: baseline.bidAmountMinor },
        bid_envelope_fingerprint: envelope.fingerprint,
      },
    }).catch(() => null);
    if (!log) return withheld("dispatch_marker_unavailable");

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
      if (currentPosture.rehearsal && !rehearsing) throw new Error("dry_run_guardrail");
      const verdict = evaluateScheduledAuthority({
        gates: currentGates, expectation, mode: currentMode, killSwitchEngaged: false,
      });
      if (!verdict.authorized) throw new Error(verdict.refusal);
      if (input.beforeProviderPost) {
        const marked = await input.beforeProviderPost();
        if (!marked) throw new Error("dispatch_marker_unavailable");
      }
    };

    const startedAt = Date.now();
    const write = await updateAdsetBidAmount(deps.ctx, {
      adsetId: envelope.entityId,
      bidAmountMinor: envelope.proposedMinorUnits,
      // The provider's OWN spelling, read a moment ago. The read-back must
      // still show it, which is what the intent's `bid_strategy_unchanged`
      // assertion means.
      expectedBidStrategy: baseline.bidStrategy,
      /*
        The cap read a moment ago, re-proved immediately before the POST.

        The comparison above is not the last word: the action-log insert, the
        three control re-reads in `beforeMutationAttempt` and the dispatch
        marker all await after it, and an operator can move the cap in Ads
        Manager in that time. The read-back cannot catch that — it verifies the
        amount this write itself sent — so the amount is compared against a
        fresh read taken as the last operation before the request goes out. The
        unattended path needs it exactly as much as the manual one: nobody is
        watching this write at all.
      */
      expectedCurrentBidAmountMinor: baseline.bidAmountMinor,
      dryRun,
      beforeMutationAttempt,
    });

    if (!write.ok) {
      const ambiguous = isAmbiguous(write);
      const completed = await completeMetaAdsActionLog({
        id: log.id,
        status: ambiguous ? "silent_failure" : "failure",
        errorCode: write.error?.code ?? "meta_bid_write_failed",
        errorMessage: write.error?.message ?? null,
        payloadResponse: (write.responsePayload ?? null) as Record<string, unknown> | null,
        durationMs: Date.now() - startedAt,
      }).then(() => true).catch(() => false);
      return {
        ok: false,
        receipt: {
          httpStatus: completed ? write.httpStatus ?? 502 : 503,
          response: write.responsePayload ?? null,
          dryRun,
          dispatchedAt: now().toISOString(),
          endpoint: `/${proposal.scopeId}`,
          withheld: null,
          receiptKey: claimToken,
          providerMutationAttempted:
            write.mutationAttempt !== null && write.mutationAttempt !== undefined,
        },
        reconcile: ambiguous || !completed,
        rollbackRequested: false,
        journalId: log.id,
      };
    }

    const completed = await completeMetaAdsActionLog({
      id: log.id,
      status: "success",
      payloadResponse: (write.responsePayload ?? null) as Record<string, unknown> | null,
      durationMs: Date.now() - startedAt,
      verifiedAt: now().toISOString(),
      verificationPayload:
        (write.verificationPayload ?? null) as Record<string, unknown> | null,
    }).then(() => true).catch(() => false);

    // A verified provider write is not settled until its journal is durable.
    // Preserve the attempt fact so the shared lifecycle holds live writes for
    // reconciliation without inventing a POST for a rehearsal.
    return {
      ok: completed,
      receipt: {
        httpStatus: completed ? 200 : 503,
        response: write.responsePayload ?? null,
        dryRun: write.dryRun === true,
        dispatchedAt: now().toISOString(),
        endpoint: `/${proposal.scopeId}`,
        withheld: null,
        receiptKey: claimToken,
        providerMutationAttempted: write.dryRun !== true,
      },
      reconcile: !completed,
      rollbackRequested: false,
      journalId: log.id,
    };
  };
}
