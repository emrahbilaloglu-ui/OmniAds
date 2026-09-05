/**
 * The unattended executor for a queued AD-grain pause.
 *
 * This family was excluded, in the queue and in the sweep, with a real reason:
 * an ad write carries a creative identity and an immutable per-attempt journal
 * that the status runtime neither knows about nor can honour. Withholding was
 * the right temporary answer. It was not an implementation, and the thousands
 * of authorized native `cut` decisions a day had no unattended path at all.
 *
 * So this drives the DECISION-ORIGIN lifecycle directly — the same claim, the
 * same post-claim preflight, the same reconciliation markers and the same
 * terminal receipt the operator's own native-decision write uses — under an
 * authorization that says what it is. It calls no HTTP handler: that one
 * stamps `manual_operator_v1` and an explicit confirmation, and a scheduler
 * supplying either would put a false statement in the action log.
 *
 * ## What it will not do
 *
 * It never invents lineage. The decision-origin contract requires the exact
 * snapshot, evaluation, engine version and decision hash the recommendation was
 * written under; a queue row that cannot present all four produces no write at
 * all, because a request that cannot name its decision is not a decision-origin
 * request. The projection carries them on the row for exactly this reason.
 */
import {
  completeDecisionOriginMetaAdsActionLog,
  createDecisionOriginMetaAdsActionLog,
  decisionOriginIdempotencyReceiptFromLog,
  markDecisionOriginActionReconciliationRequired,
  resolveExactMetaAdActionTarget,
  type MetaAdsActionLogRow,
} from "@/lib/meta/ads-action-log";
import {
  pauseAd,
  resumeAd,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
} from "@/lib/meta/ads-write";
import {
  createDecisionOriginAdActionIdempotencyKey,
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  validateDecisionOriginAdExecutionRequest,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";
import { runServerDecisionOriginAdActionPreflight }
  from "@/lib/meta/decision-origin-action-preflight";
import { reconciliationOutcomeForProviderWriteFailure }
  from "@/lib/meta/write-outcome";
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

export interface ScheduledAdStatusRuntimeInput {
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

export interface ScheduledAdStatusRuntimeDeps {
  ctx: MetaAdsWriteContext;
  readGates: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<ScheduledAuthorityGates | null>;
  readMode: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<"manual" | "semi_auto" | "auto" | null>;
  now?: () => Date;
}

/**
 * The decision this row came from, rebuilt from what the projection stored.
 *
 * Every field is read, none is defaulted. The validator then has the last word:
 * a request it rejects produces no claim and no call, which is the difference
 * between "we could not prove the decision" and "we wrote anyway".
 */
export function decisionOriginRequestForProposal(
  proposal: MetaAutomationProposal,
): DecisionOriginAdExecutionRequest | null {
  const action = proposal.proposedAction;
  if (action !== "pause" && action !== "resume") return null;
  const evidence = proposal.evidenceRef ?? {};
  const read = (key: string): string => {
    const value = evidence[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const base = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: proposal.businessId,
    providerAccountId: proposal.providerAccountId,
    adId: proposal.scopeId,
    snapshotId: read("snapshotId"),
    evaluationId: read("evaluationId") || proposal.recId?.trim() || "",
    engineVersion: read("engineVersion"),
    decisionHash: read("decisionHash"),
    action,
    creativeId: read("creativeId"),
  };
  const request: DecisionOriginAdExecutionRequest = {
    ...base,
    // Deterministic, so a re-claim of the same decision is the same key and
    // the durable idempotency check can recognise it rather than writing twice.
    idempotencyKey: createDecisionOriginAdActionIdempotencyKey(base),
  };
  return validateDecisionOriginAdExecutionRequest(request).length === 0
    ? request
    : null;
}

function ensureRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function createScheduledAdStatusRuntime(
  deps: ScheduledAdStatusRuntimeDeps,
): (input: ScheduledAdStatusRuntimeInput) => Promise<BudgetProposalExecutionResult> {
  const now = deps.now ?? (() => new Date());
  return async (input) => {
    const { proposal, claimToken } = input;
    const dispatchedAt = () => now().toISOString();
    const withheld = (
      reason: BudgetProposalWithheldReason,
    ): BudgetProposalExecutionResult => ({
      ok: false,
      receipt: {
        httpStatus: 422,
        response: null,
        dryRun: input.dryRunOnly,
        dispatchedAt: dispatchedAt(),
        endpoint: null,
        withheld: reason,
        receiptKey: claimToken,
        providerMutationAttempted: false,
      },
      reconcile: false,
      rollbackRequested: false,
      journalId: null,
    });

    if (proposal.scopeType !== "ad") return withheld("composition_blocked");
    if (proposal.proposedAction !== "pause" && proposal.proposedAction !== "resume") {
      return withheld("composition_blocked");
    }
    if (!claimToken) return withheld("claim_absent");

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
      decisionType: "pause" as const,
    };
    const first = evaluateScheduledAuthority({
      gates, expectation, mode, killSwitchEngaged: false,
    });
    if (!first.authorized) return withheld(first.refusal);

    /*
      The lineage, or nothing.

      A row that cannot present its snapshot, evaluation, engine version and
      decision hash cannot make a decision-origin request, and there is no
      other kind of unattended ad write. Filling a gap with a plausible value
      would be this runtime inventing the decision it claims to be executing.
    */
    const request = decisionOriginRequestForProposal(proposal);
    if (!request) return withheld("decision_lineage_absent");

    /*
      The exact target, from the retained dimension.

      It proves the ad belongs to this business and this account, and that the
      creative on it is still the one the decision was about. The manual route
      does the same read before it claims.
    */
    const target = await resolveExactMetaAdActionTarget({
      businessId: proposal.businessId,
      providerAccountId: proposal.providerAccountId,
      adId: proposal.scopeId,
    }).catch(() => null);
    if (!target || !target.ok) return withheld("composition_blocked");
    if (
      !target.target.creativeId
      || target.target.creativeId !== request.creativeId
    ) {
      // The ad now carries a different creative. The decision was about the
      // old one, so it is not a decision about this ad any more.
      return withheld("creative_identity_mismatch");
    }

    const dryRun = rehearsing;
    const effectiveRequest: DecisionOriginAdExecutionRequest = dryRun
      ? {
        ...request,
        dryRun: true,
        idempotencyKey: createDecisionOriginAdActionIdempotencyKey({
          ...request, dryRun: true,
        }),
      }
      : request;

    let log: MetaAdsActionLogRow;
    try {
      log = await createDecisionOriginMetaAdsActionLog({
        request: effectiveRequest,
        // Nobody requested this one. The enabling admin is on the proposal row
        // and in the ledger; the log must not name them as the requester.
        requestedBy: null,
        payloadRequest: {
          method: "POST",
          endpoint: `/${proposal.scopeId}`,
          body: { status: proposal.proposedAction === "pause" ? "PAUSED" : "ACTIVE" },
          dry_run: dryRun,
          action_origin: "native_decision_v1",
          scheduled_authority: {
            enablingActorUserId: input.authorization.expectedEnablingActorUserId,
            activationControlVersion:
              input.authorization.expectedActivationControlVersion,
          },
          proposal_id: proposal.id,
          claim_token: claimToken,
        },
      });
    } catch {
      return withheld("dispatch_marker_unavailable");
    }

    /*
      This exact decision has already been executed.

      The idempotency key is a pure function of the decision, so a replay means
      an earlier attempt owns the outcome. Its receipt is the truth; this run
      reports it rather than sending a second write.
    */
    if (log.idempotentReplay) {
      const receipt = decisionOriginIdempotencyReceiptFromLog(
        log, effectiveRequest.idempotencyKey,
      );
      const settled = receipt.status === "success";
      return {
        ok: settled,
        receipt: {
          httpStatus: settled ? 200 : 409,
          response: { decision_origin_idempotent_replay: receipt },
          dryRun,
          dispatchedAt: dispatchedAt(),
          endpoint: `/${proposal.scopeId}`,
          withheld: null,
          receiptKey: claimToken,
          providerMutationAttempted: false,
        },
        // A prior attempt still pending is unresolved, not failed.
        reconcile: receipt.status === "pending",
        rollbackRequested: false,
        journalId: log.id,
      };
    }

    /*
      The post-claim preflight, which is where freshness, hierarchy, policy and
      the pending-receipt rule are proved. It is the same server function the
      operator's own native-decision write runs, given the same request.
    */
    let preflight;
    try {
      preflight = await runServerDecisionOriginAdActionPreflight({
        request: effectiveRequest,
        ctx: deps.ctx,
        ignorePendingReceiptActionLogId: log.id,
      });
    } catch {
      preflight = {
        shouldMutate: false,
        blockers: ["decision_preflight_unavailable"],
        errorCode: "decision_preflight_unavailable",
      };
    }
    if (!preflight.shouldMutate) {
      const errorCode = preflight.errorCode ?? "decision_preflight_blocked";
      // Two attempts, then a marker: a refusal must never leave a row that
      // says a call may be in flight.
      let completed = false;
      for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
        completed = await completeDecisionOriginMetaAdsActionLog({
          id: log.id,
          status: "failure",
          payloadResponse: {
            post_claim_preflight: {
              should_mutate: false,
              blockers: preflight.blockers,
            },
          },
          errorCode,
          errorMessage:
            `Post-claim decision-origin preflight blocked the provider write (${preflight.blockers.join(", ")}).`,
        }).then(() => true).catch(() => false);
      }
      if (!completed) {
        await markDecisionOriginActionReconciliationRequired({
          id: log.id,
          outcome: "pre_provider_terminal_persistence_failed",
          providerErrorCode: errorCode,
          errorMessage: "Pre-provider terminal persistence failed twice.",
        }).catch(() => null);
        return {
          ...withheld("dispatch_marker_unavailable"),
          reconcile: true,
          journalId: log.id,
        };
      }
      return { ...withheld("composition_blocked"), journalId: log.id };
    }

    /*
      The binding authority check, at the pre-POST boundary.

      Everything above was read before the claim and the preflight, and both
      take time. This runs after every adapter-side check and immediately
      before the request begins, which is the only place a re-read can still
      prevent the write rather than describe it.
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
    const options = dryRun ? { dryRun: true } : { beforeMutationAttempt };
    const result = proposal.proposedAction === "pause"
      ? await pauseAd(deps.ctx, proposal.scopeId, options)
      : await resumeAd(deps.ctx, proposal.scopeId, options);

    if (!result.ok) {
      const failure = result as MetaAdsWriteFailure;
      const outcome = reconciliationOutcomeForProviderWriteFailure(failure, dryRun);
      if (outcome) {
        /*
          The provider may have applied it. The row parks, and the ONE thing
          that must not happen is it being offered again.
        */
        await markDecisionOriginActionReconciliationRequired({
          id: log.id,
          outcome,
          providerErrorCode: failure.error.code,
          errorMessage: failure.error.message,
          providerResponsePayload: ensureRecord(failure.responsePayload),
          durationMs: Date.now() - startedAt,
          verificationPayload: ensureRecord(failure.verificationPayload),
          providerCompletedAt: failure.mutationAttempt?.completedAt ?? null,
          mutationAttempt: failure.mutationAttempt ?? null,
        }).catch(() => null);
        return {
          ok: false,
          receipt: {
            httpStatus: failure.httpStatus ?? 502,
            response: failure.responsePayload ?? null,
            dryRun,
            dispatchedAt: dispatchedAt(),
            endpoint: `/${proposal.scopeId}`,
            withheld: null,
            receiptKey: claimToken,
            providerMutationAttempted: Boolean(failure.mutationAttempt),
          },
          reconcile: true,
          rollbackRequested: false,
          journalId: log.id,
        };
      }
      let completed = false;
      for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
        completed = await completeDecisionOriginMetaAdsActionLog({
          id: log.id,
          status: "failure",
          payloadResponse: ensureRecord(failure.responsePayload),
          errorCode: failure.error.code,
          errorMessage: failure.error.message,
          durationMs: Date.now() - startedAt,
          verificationPayload: ensureRecord(failure.verificationPayload),
        }).then(() => true).catch(() => false);
      }
      if (!completed) {
        await markDecisionOriginActionReconciliationRequired({
          id: log.id,
          outcome: dryRun
            ? "dry_run_terminal_persistence_failed"
            : "pre_provider_terminal_persistence_failed",
          providerErrorCode: failure.error.code,
          errorMessage: "Terminal persistence failed twice.",
          durationMs: Date.now() - startedAt,
        }).catch(() => null);
      }
      return {
        ok: false,
        receipt: {
          httpStatus: failure.httpStatus ?? 502,
          response: failure.responsePayload ?? null,
          dryRun,
          dispatchedAt: dispatchedAt(),
          endpoint: `/${proposal.scopeId}`,
          withheld: null,
          receiptKey: claimToken,
          providerMutationAttempted: Boolean(failure.mutationAttempt),
        },
        reconcile: !completed,
        rollbackRequested: false,
        journalId: log.id,
      };
    }

    let completedLog: MetaAdsActionLogRow | null = null;
    let completionError: unknown = null;
    // A rehearsal gets two attempts because nothing is at stake in retrying it;
    // a live write gets one, because its receipt row must not be raced.
    const attempts = result.dryRun === true ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        completedLog = await completeDecisionOriginMetaAdsActionLog({
          id: log.id,
          status: "success",
          payloadResponse: ensureRecord(result.responsePayload),
          durationMs: Date.now() - startedAt,
          providerCompletedAt: result.mutationAttempt?.completedAt ?? null,
          verificationPayload: ensureRecord(result.verificationPayload),
        });
        completionError = null;
        break;
      } catch (error) {
        completionError = error;
      }
    }
    if (completionError) {
      /*
        The write was verified and its receipt would not persist.

        This is the worst state to be wrong about: the change IS live, and a
        row that looks unfinished would be offered again. It parks explicitly.
      */
      await markDecisionOriginActionReconciliationRequired({
        id: log.id,
        outcome: result.dryRun === true
          ? "dry_run_terminal_persistence_failed"
          : "provider_write_verified_receipt_persistence_failed",
        providerErrorCode: "receipt_persistence_failed",
        errorMessage: completionError instanceof Error
          ? completionError.message : String(completionError),
        providerResponsePayload: ensureRecord(result.responsePayload),
        durationMs: Date.now() - startedAt,
        verificationPayload: ensureRecord(result.verificationPayload),
        providerCompletedAt: result.mutationAttempt?.completedAt ?? null,
        mutationAttempt: result.mutationAttempt ?? null,
      }).catch(() => null);
      return {
        ok: false,
        receipt: {
          httpStatus: 503,
          response: result.responsePayload ?? null,
          dryRun: result.dryRun === true,
          dispatchedAt: dispatchedAt(),
          endpoint: `/${proposal.scopeId}`,
          withheld: null,
          receiptKey: claimToken,
          providerMutationAttempted: result.dryRun !== true,
        },
        reconcile: true,
        rollbackRequested: false,
        journalId: log.id,
      };
    }

    // The completion itself can downgrade a provider success: the receipt
    // finalisation re-checks the native lineage and writes `silent_failure`
    // when verification did not preserve it.
    const settledOk = completedLog?.status === "success"
      || completedLog?.status === undefined;
    return {
      ok: settledOk,
      receipt: {
        httpStatus: settledOk ? 200 : 502,
        response: result.responsePayload ?? null,
        dryRun: result.dryRun === true,
        dispatchedAt: dispatchedAt(),
        endpoint: `/${proposal.scopeId}`,
        withheld: null,
        receiptKey: claimToken,
        providerMutationAttempted: result.dryRun !== true,
      },
      reconcile: completedLog?.status === "silent_failure",
      rollbackRequested: false,
      journalId: log.id,
    };
  };
}
