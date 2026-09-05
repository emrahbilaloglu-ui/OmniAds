/**
 * The unattended executor for a queued LAUNCH row.
 *
 * The queue could raise a `launch` row and an operator could approve it, and
 * that was the whole of it: the sweep filtered the page to families that had a
 * runtime, and `launch` had none. A business whose creative family is on `auto`
 * therefore had its staged launches sit in the queue until they expired, which
 * is the same outcome as never having raised them.
 *
 * It follows `scheduled-bid-runtime.ts` step for step, because the two are the
 * same kind of act: an unattended write that must never speak for an operator,
 * must re-prove its authority at the pre-POST boundary, and must journal under
 * its own origin. What a create adds is three things a status change does not
 * have.
 *
 * ## The three
 *
 * **A second release gate.** `META_AUTOMATION_LIVE_WRITES` opens the queue's
 * writes; `META_LAUNCHPAD_EXECUTION` opens Launchpad's, and the write-safety
 * contract's `launchpad_create` family has to declare no missing step. Both
 * bind, and they are read as two facts rather than one so a receipt can say
 * which of them is shut.
 *
 * **No rehearsal.** Every other family can rehearse: the primitive verifies the
 * entity and reports what it would have written. There is no such thing for a
 * create — `launch-write.ts` has no dry-run path, because a campaign that was
 * not created has no id to read back. So a rehearsing business is refused here
 * rather than handed a receipt for entities that do not exist.
 *
 * **The payload is the operator's, replayed.** `executionAuthority` is inside
 * `metaLaunchIntentRequestFingerprint`, so a caller that recomposed the payload
 * to describe itself would be refused by its own honesty as
 * `launch_intent_contract_mismatch`. This runtime therefore touches nothing in
 * `request_payload_json` and says what it is in the action log alone, under
 * `launchpad_scheduled_v1` with no requester — the same shape
 * `scheduled-ad-status-runtime.ts` uses for the row nobody asked for.
 */
import {
  META_LAUNCHPAD_MANUAL_ACTION_ORIGIN,
  META_LAUNCHPAD_MANUAL_CONFIRMATION,
  type MetaLaunchpadManualAuthority,
} from "@/lib/launchpad/meta-manual-authority";
import {
  metaLaunchIntentRequestFingerprint,
  buildMetaLaunchIntentErrorReceipt,
  buildMetaLaunchIntentValidationReceipt,
  type MetaLaunchIntent,
} from "@/lib/launchpad/meta-launch-intent";
import { prepareMetaLaunchIntentForExecution } from "@/lib/launchpad/meta-launch-intent-service";
import {
  getMetaLaunchIntent,
  recordMetaLaunchIntentPreExecutionFailure,
  recordMetaLaunchIntentValidation,
  recordMetaLaunchIntentWriteBlocked,
} from "@/lib/launchpad/meta-launch-intent-store";
import {
  normalizeMetaAddToExistingPayload,
  normalizeMetaLaunchPayload,
} from "@/lib/launchpad/meta";
import {
  resolveMetaLaunchWriteContext,
  validateMetaAddToExistingLiveProviderPreflight,
  validateMetaAddToExistingRequest,
  validateMetaLaunchRequest,
} from "@/lib/launchpad/meta-validation";
import { preflightAgeSeconds } from "@/lib/launchpad/validation-preflight-disclosure";
import {
  runMetaAddToExistingCreate,
  runMetaLaunchIntentCreate,
  META_LAUNCH_PROVIDER_MUTATION_WITHHELD_CODE,
  type MetaLaunchExecutionOutcome,
  type MetaLaunchProviderMutationVerdict,
} from "@/lib/launchpad/meta-launch-execution";
import {
  hasRecentPendingMetaAddToExistingAction,
  hasRecentPendingMetaLaunchAction,
} from "@/lib/meta/ads-action-log";
import { preflightMetaLaunchCreatives } from "@/lib/meta/launch-write";
import type { MetaAdsWriteContext } from "@/lib/meta/ads-write";
import { readMetaWritePosture } from "@/lib/meta/automation-write-guard";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { missingSteps, writeFamily } from "@/lib/meta/write-safety-contract";
import type { MetaAutomationProposal } from "@/lib/meta/automation-proposals";
import type {
  BudgetProposalExecutionResult,
  BudgetProposalWithheldReason,
} from "@/lib/meta/budget-proposal-runtime";
import {
  evaluateScheduledAuthority,
  type ScheduledAuthorityGates,
} from "@/lib/meta/scheduled-action-execution";

/**
 * The origin an unattended create is journalled under.
 *
 * Deliberately not `launchpad_manual` — that word means an operator was on the
 * review screen and confirmed this create, which is false here. The stored
 * payload still carries the operator's own `executionAuthority`, because that
 * is what they approved when they staged the intent; the action log is where
 * the two authorities are told apart afterwards.
 */
export const SCHEDULED_LAUNCH_ACTION_LOG_ORIGIN = "launchpad_scheduled_v1" as const;

export interface ScheduledLaunchRuntimeInput {
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

/**
 * The provider tail, behind one seam.
 *
 * It is the same sequence the operator's own route runs — prepare, validate,
 * preflight, create — and it is named as a dependency so the gates above it can
 * be driven in a test without a database or a provider. Production gets the
 * real one by default.
 */
export interface ScheduledLaunchCreateRequest {
  intent: MetaLaunchIntent;
  actionLogOrigin: string;
  /** Nobody requested this. The enabling admin is on the proposal row. */
  requestedBy: null;
  scheduledAuthority: {
    enablingActorUserId: string;
    activationControlVersion: string;
  };
  /**
   * Fired immediately before EVERY provider create, not once before the
   * sequence, and it names the gate that closed when it refuses.
   */
  beforeProviderMutation: () => Promise<MetaLaunchProviderMutationVerdict>;
}

export interface ScheduledLaunchRuntimeDeps {
  readGates: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<ScheduledAuthorityGates | null>;
  readMode: (input: {
    proposal: MetaAutomationProposal;
  }) => Promise<"manual" | "semi_auto" | "auto" | null>;
  readIntent?: (input: {
    businessId: string;
    id: string;
  }) => Promise<MetaLaunchIntent | null>;
  runCreate?: (
    request: ScheduledLaunchCreateRequest,
  ) => Promise<MetaLaunchExecutionOutcome>;
  now?: () => Date;
}

/** Same shape as `sanitizeErrorMessage`, without dragging a route module in. */
function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * The authority the operator bound into the payload when they staged it.
 *
 * Read rather than supplied: it is inside the fingerprint, so the only value
 * that can be true here is the one already stored. An intent whose payload does
 * not carry it was not staged through the authorized path, and this runtime
 * refuses it rather than inventing the missing half.
 */
export function storedLaunchExecutionAuthority(
  intent: MetaLaunchIntent,
): MetaLaunchpadManualAuthority | null {
  const stored = isRecord(intent.requestPayload)
    ? intent.requestPayload.executionAuthority
    : null;
  if (!isRecord(stored)) return null;
  if (stored.actionOrigin !== META_LAUNCHPAD_MANUAL_ACTION_ORIGIN) return null;
  if (stored.manualConfirmation !== META_LAUNCHPAD_MANUAL_CONFIRMATION) return null;
  return {
    actionOrigin: META_LAUNCHPAD_MANUAL_ACTION_ORIGIN,
    manualConfirmation: META_LAUNCHPAD_MANUAL_CONFIRMATION,
  };
}

/**
 * Whether this create's outcome is one nobody can read.
 *
 * The create path reports ambiguity three ways — a step's `providerOutcome`, an
 * error code, and the intent status it settles — and any of them means the
 * queue row must PARK rather than be offered again. A create that may have
 * landed is the one outcome a second attempt could duplicate.
 */
export function launchOutcomeIsAmbiguous(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (body.launchIntentStatus === "silent_failure") return true;
  if (body.retryAllowed === false) return true;
  if (body.providerOutcome === "outcome_ambiguous") return true;
  const error = isRecord(body.error) ? body.error : null;
  if (error?.code === "provider_outcome_ambiguous") return true;
  if (error?.code === "silent_failure") return true;
  const steps = Array.isArray(body.steps) ? body.steps : [];
  return steps.some(
    (step) =>
      isRecord(step)
      && (step.status === "silent_failure"
        || step.providerOutcome === "outcome_ambiguous"),
  );
}

export function createScheduledLaunchRuntime(
  deps: ScheduledLaunchRuntimeDeps,
): (input: ScheduledLaunchRuntimeInput) => Promise<BudgetProposalExecutionResult> {
  const now = deps.now ?? (() => new Date());
  const readIntent = deps.readIntent ?? getMetaLaunchIntent;
  const runCreate = deps.runCreate ?? runScheduledLaunchCreate;
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

    if (proposal.proposedAction !== "launch") return withheld("composition_blocked");
    /*
      A launch row without its intent is not a launch.

      The database refuses one (`meta_automation_proposals_launch_lineage`), so
      a null here is a pre-migration read or a hand-edited row. Either way there
      is nothing to replay, and this runtime never composes a payload of its own.
    */
    if (!proposal.launchIntentId) return withheld("launch_intent_absent");
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
    /*
      A create cannot be rehearsed, so a rehearsing business is refused.

      Dispatching anyway would make the guardrail decorative for the one family
      where ignoring it is most expensive: there is no "what would have been
      written" for entities that do not exist yet.
    */
    if (posture.rehearsal || input.dryRunOnly === true) {
      return withheld("dry_run_guardrail");
    }
    if (input.authorization.kind !== "scheduled") {
      return withheld("manual_confirmation_absent");
    }
    const expectation = {
      providerAccountId: proposal.providerAccountId,
      expectedEnablingActorUserId: input.authorization.expectedEnablingActorUserId,
      expectedActivationControlVersion:
        input.authorization.expectedActivationControlVersion,
      /*
        The CREATIVE mode, not the pause one. A launch is a creative decision:
        the operator who armed unattended creative work armed this, and an
        operator who armed unattended pausing did not.
      */
      decisionType: "creative" as const,
    };
    const first = evaluateScheduledAuthority({
      gates, expectation, mode, killSwitchEngaged: false,
    });
    if (!first.authorized) return withheld(first.refusal);

    const launchpadRefusal = launchpadCreateGateRefusal();
    if (launchpadRefusal) return withheld(launchpadRefusal);

    const intent = await readIntent({
      businessId: proposal.businessId,
      id: proposal.launchIntentId,
    }).catch(() => null);
    if (!intent) return withheld("launch_intent_unreadable");
    /*
      The scheduled authority was proved for ONE account. An intent belonging to
      another is not the thing that was authorized, whatever the row says.
    */
    if (intent.providerAccountId !== proposal.providerAccountId) {
      return withheld("composition_blocked");
    }
    /*
      `prepared` is the only state a create may start from, and the service
      refuses anything else. Reading it here means a launch an operator has
      already run — or one the wizard is running right now — is refused before
      any account resolution or provider read, not after.
    */
    if (intent.status !== "prepared") return withheld("launch_intent_not_prepared");
    if (intent.startedAt !== null) return withheld("launch_intent_not_prepared");
    /*
      The payload still hashes to what was approved.

      This is the same comparison `prepareMetaLaunchIntentForExecution` makes,
      run early and for free, so an edited payload is named as such rather than
      arriving as a generic contract mismatch after the account and the write
      context have been resolved.
    */
    const fingerprint = metaLaunchIntentRequestFingerprint({
      operation: intent.operation,
      providerAccountId: intent.providerAccountId,
      requestPayload: intent.requestPayload,
    });
    if (fingerprint !== intent.requestFingerprint) {
      return withheld("launch_payload_changed");
    }

    /*
      The binding authority check, at EVERY pre-POST boundary.

      Everything above was read before the claim, and claiming, resolving and
      preflighting take seconds. This runs immediately before each provider
      create, which is the only place a re-read can still prevent the write
      rather than describe it. A refusal is remembered so the receipt can name
      the gate that closed rather than reporting a missing marker.

      It used to run once, before the whole sequence. A launch is three or more
      POSTs, so the campaign's answer was reused for the ad set and the ad below
      it: an operator could take the family off `auto`, engage the STOP, put the
      business into rehearsal or shut the Launchpad gate the moment after the
      campaign existed, and the rest of the launch was still built. Asking again
      per create is what makes those four gates bind for the whole sequence.
    */
    let lateRefusal: BudgetProposalWithheldReason | null = null;
    const refuse = (
      reason: BudgetProposalWithheldReason,
    ): MetaLaunchProviderMutationVerdict => {
      lateRefusal = reason;
      return { allowed: false, reason };
    };
    const beforeProviderMutation = async (): Promise<MetaLaunchProviderMutationVerdict> => {
      const [currentGates, currentMode, currentPosture] = await Promise.all([
        deps.readGates({ proposal }).catch(() => null),
        deps.readMode({ proposal }).catch(() => null),
        readMetaWritePosture({ businessId: proposal.businessId }).catch(() => null),
      ]);
      if (!currentGates || !currentMode || !currentPosture) {
        return refuse("control_state_unavailable");
      }
      if (currentPosture.blocked) return refuse("kill_switch_engaged");
      if (currentPosture.rehearsal) return refuse("dry_run_guardrail");
      const verdict = evaluateScheduledAuthority({
        gates: currentGates, expectation, mode: currentMode, killSwitchEngaged: false,
      });
      if (!verdict.authorized) return refuse(verdict.refusal);
      const lateGate = launchpadCreateGateRefusal();
      if (lateGate) return refuse(lateGate);
      if (input.beforeProviderPost) {
        /*
          The write-ahead dispatch marker, which is idempotent for one attempt:
          the second and later creates in a sequence re-enter it and it answers
          true from what it already wrote.
        */
        const marked = await input.beforeProviderPost();
        if (!marked) return refuse("dispatch_marker_unavailable");
      }
      /*
        Authority held for THIS create only. The next one asks again, and a
        remembered refusal from an earlier boundary would name the wrong gate on
        a receipt this one is allowed to write.
      */
      lateRefusal = null;
      return true;
    };

    const endpoint = intent.operation === "add_to_existing"
      ? "/api/launchpad/meta/add-to-existing"
      : "/api/launchpad/meta/launch";
    const outcome = await runCreate({
      intent,
      actionLogOrigin: SCHEDULED_LAUNCH_ACTION_LOG_ORIGIN,
      requestedBy: null,
      scheduledAuthority: {
        enablingActorUserId: input.authorization.expectedEnablingActorUserId,
        activationControlVersion:
          input.authorization.expectedActivationControlVersion,
      },
      beforeProviderMutation,
    }).catch((error): MetaLaunchExecutionOutcome => ({
      ok: false,
      status: 500,
      body: {
        ok: false,
        error: { code: "launch_execution_failed", message: sanitizeError(error) },
      },
      /*
        The tail threw with no answer. Whether a create is live is decided by
        the durable dispatch marker downstream, never by an exception, so this
        reports the honest "we do not know" rather than a definite non-attempt.
      */
      providerMutationAttempted: true,
    }));

    /*
      A boundary refusal, told apart by whether anything was created.

      Before the first POST there is nothing to report but the refusal, so the
      row settles as withheld and names the gate. Once a campaign or an ad set
      exists, "withheld" would be a false account of the attempt: the receipt
      below carries the identities, the steps and the reason instead, and the
      intent's own durable receipt carries them too.
    */
    const boundaryError = isRecord(outcome.body) && isRecord(outcome.body.error)
      ? outcome.body.error.code
      : null;
    const boundaryVetoed = boundaryError === "dispatch_marker_unavailable"
      || boundaryError === META_LAUNCH_PROVIDER_MUTATION_WITHHELD_CODE;
    if (boundaryVetoed && outcome.providerMutationAttempted === false) {
      return withheld(lateRefusal ?? "dispatch_marker_unavailable");
    }

    return {
      ok: outcome.ok,
      receipt: {
        httpStatus: outcome.status,
        response: outcome.body,
        dryRun: false,
        dispatchedAt: now().toISOString(),
        endpoint,
        withheld: null,
        receiptKey: claimToken,
        providerMutationAttempted: outcome.providerMutationAttempted,
      },
      reconcile: outcome.providerMutationAttempted
        && launchOutcomeIsAmbiguous(outcome.body),
      rollbackRequested: false,
      /*
        The action log rows are per created entity and the intent's own receipt
        is the record of the attempt as a whole, so there is no single journal
        row for this write to point at.
      */
      journalId: null,
    };
  };
}

/**
 * Launchpad's own release gate, read as the two facts it is.
 *
 * `META_LAUNCHPAD_EXECUTION` and the `launchpad_create` safety declaration are
 * separate: the first is an environment flag an operator flips, the second is
 * this repository saying a step is not implemented. Reporting either as
 * `release_gate_closed` would point the operator at the Automation gate, which
 * is a third, unrelated switch that may well be open.
 */
function launchpadCreateGateRefusal(): BudgetProposalWithheldReason | null {
  if (readMetaReleaseGates().launchpadExecution !== true) {
    return "launchpad_execution_gated";
  }
  if (missingSteps(writeFamily("launchpad_create")).length > 0) {
    return "launchpad_safety_step_missing";
  }
  return null;
}

function refusalOutcome(input: {
  status: number;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}): MetaLaunchExecutionOutcome {
  return {
    ok: false,
    status: input.status,
    body: {
      ok: false,
      error: { code: input.code, message: input.message },
      ...(input.extra ?? {}),
    },
    providerMutationAttempted: false,
  };
}

/**
 * Prepare, validate, preflight, create — the operator's own sequence, entered
 * without an operator.
 *
 * It cannot forward to `handleMetaLaunchAction`: that handler's first gate is
 * `requireLaunchpadBusinessAccess`, and a sweep has no session to present. What
 * it must not do instead is drop the gates that check the WRITE rather than the
 * caller, so every one of them is here in the handler's own order — the stored
 * payload replayed untouched, the in-flight idempotency guard, the validation
 * and its persisted receipt, the fresh creative or hierarchy preflight, and
 * only then the create.
 */
export async function runScheduledLaunchCreate(
  request: ScheduledLaunchCreateRequest,
): Promise<MetaLaunchExecutionOutcome> {
  const { intent } = request;
  const businessId = intent.businessId;
  const providerAccountId = intent.providerAccountId;
  const authority = storedLaunchExecutionAuthority(intent);
  if (!authority) {
    return refusalOutcome({
      status: 409,
      code: "launch_execution_authority_absent",
      message:
        "This launch intent's stored payload carries no operator execution authority, so nothing was created on Meta.",
    });
  }

  const prepared = await prepareMetaLaunchIntentForExecution({
    businessId,
    providerAccountId,
    operation: intent.operation,
    idempotencyKey: intent.idempotencyKey,
    // Byte for byte. The fingerprint covers `executionAuthority`, so anything
    // this runtime added would be refused as a contract mismatch.
    requestPayload: intent.requestPayload,
    launchIntentId: intent.id,
  }).catch((error) => ({
    ok: false as const,
    status: 500 as const,
    error: {
      code: "launch_intent_prepare_failed",
      message: sanitizeError(error),
    },
  }));
  if (!prepared.ok) {
    return refusalOutcome({
      status: prepared.status,
      code: prepared.error.code,
      message: prepared.error.message,
      extra: { launchIntentId: intent.id },
    });
  }

  const requestFingerprint = prepared.intent.requestFingerprint;
  const receiptBinding = {
    executionAuthority: authority,
    requestFingerprint,
  } as const;
  /*
    What the action log will say about WHO did this.

    The manual path writes `metaLaunchpadActionLogAuthority`, whose
    `action_origin` is `launchpad_manual_v1`. Writing that here would be a false
    statement about an execution nobody attended, so the origin is this
    runtime's own and the enabling activation is named beside it.
  */
  const actionLogAuthority = {
    action_origin: SCHEDULED_LAUNCH_ACTION_LOG_ORIGIN,
    scheduled_authority: request.scheduledAuthority,
    launch_intent_request_fingerprint: requestFingerprint,
    /*
      The operator's own authority, quoted as the intent's fact rather than as
      this attempt's. It is what they confirmed when they staged the payload.
    */
    staged_execution_authority: authority,
  };

  const ctxResult = await resolveMetaLaunchWriteContext(
    businessId,
    providerAccountId,
  );
  if (!ctxResult.ok) {
    await recordMetaLaunchIntentWriteBlocked({
      businessId,
      id: intent.id,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: ctxResult.blocker.code,
        message: ctxResult.blocker.message,
        failedAt: "write_context",
      }),
    }).catch(() => null);
    return refusalOutcome({
      status: 502,
      code: ctxResult.blocker.code,
      message: ctxResult.blocker.message,
      extra: { launchIntentId: intent.id },
    });
  }
  const ctx = ctxResult.ctx;

  return intent.operation === "add_to_existing"
    ? runScheduledAddToExisting({ request, ctx, receiptBinding, actionLogAuthority })
    : runScheduledNewCampaign({ request, ctx, receiptBinding, actionLogAuthority });
}

type ScheduledCreateContext = {
  request: ScheduledLaunchCreateRequest;
  ctx: MetaAdsWriteContext;
  receiptBinding: {
    executionAuthority: MetaLaunchpadManualAuthority;
    requestFingerprint: string;
  };
  actionLogAuthority: Record<string, unknown>;
};

async function runScheduledNewCampaign(
  input: ScheduledCreateContext,
): Promise<MetaLaunchExecutionOutcome> {
  const { request, ctx, receiptBinding, actionLogAuthority } = input;
  const intent = request.intent;
  const businessId = intent.businessId;
  const providerAccountId = intent.providerAccountId;

  const inFlight = await hasRecentPendingMetaLaunchAction({
    businessId,
    idempotencyKey: intent.idempotencyKey,
    sinceSeconds: 30,
  }).catch(() => true);
  if (inFlight) {
    // Somebody else's attempt on this key may still be live. Two creates under
    // one idempotency key is the exact thing the key exists to prevent.
    return refusalOutcome({
      status: 409,
      code: "launch_in_flight",
      message: "A Meta launch with this idempotency key is already pending.",
      extra: { launchIntentId: intent.id },
    });
  }

  const normalizedPayload = normalizeMetaLaunchPayload(intent.requestPayload);
  let validation: Awaited<ReturnType<typeof validateMetaLaunchRequest>>;
  try {
    validation = await validateMetaLaunchRequest({
      businessId,
      providerAccountId,
      payload: normalizedPayload,
    });
  } catch (error) {
    const message = sanitizeError(error);
    await recordMetaLaunchIntentPreExecutionFailure({
      businessId,
      id: intent.id,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "launch_validation_failed",
        message,
        failedAt: "validation",
      }),
    }).catch(() => null);
    return refusalOutcome({
      status: 500,
      code: "launch_validation_failed",
      message,
      extra: { launchIntentId: intent.id },
    });
  }
  if (!validation.ok) {
    await recordMetaLaunchIntentValidation({
      businessId,
      id: intent.id,
      receipt: buildMetaLaunchIntentValidationReceipt({
        ...receiptBinding,
        providerAccountId,
        ok: false,
        blockers: validation.blockers,
        warnings: validation.warnings,
      }),
    }).catch(() => null);
    return refusalOutcome({
      status: 400,
      code: "validation_blocked",
      message: "Launch validation failed.",
      extra: { launchIntentId: intent.id, blockers: validation.blockers },
    });
  }

  let creativePreflight: Awaited<ReturnType<typeof preflightMetaLaunchCreatives>>;
  try {
    creativePreflight = await preflightMetaLaunchCreatives(
      ctx,
      validation.payload.creativeIds,
    );
  } catch (error) {
    const message = sanitizeError(error);
    await recordMetaLaunchIntentValidation({
      businessId,
      id: intent.id,
      receipt: buildMetaLaunchIntentValidationReceipt({
        ...receiptBinding,
        providerAccountId,
        ok: false,
        blockers: [{ code: "creative_preflight_failed", message }],
        warnings: validation.warnings,
      }),
      errorReceipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "creative_preflight_failed",
        message,
        failedAt: "creative_preflight",
      }),
    }).catch(() => null);
    return refusalOutcome({
      status: 502,
      code: "creative_preflight_failed",
      message,
      extra: { launchIntentId: intent.id },
    });
  }
  const preflightChecks = creativePreflight.checks.map((check) => ({
    ...check,
    error: check.error ? { ...check.error } : null,
  }));
  const preflightBlockers = creativePreflight.checks
    .filter((check) => !check.ok)
    .map((check) => ({
      code: check.error?.code ?? "creative_preflight_failed",
      message: `${check.requestedCreativeId}: ${
        check.error?.message
        ?? "The selected Meta creative identity could not be proven."
      }`,
    }));
  await recordMetaLaunchIntentValidation({
    businessId,
    id: intent.id,
    receipt: buildMetaLaunchIntentValidationReceipt({
      ...receiptBinding,
      providerAccountId,
      ok: creativePreflight.ok,
      blockers: preflightBlockers,
      warnings: validation.warnings,
      checks: preflightChecks,
      checkedAt: creativePreflight.checkedAt,
    }),
    errorReceipt: creativePreflight.ok
      ? null
      : buildMetaLaunchIntentErrorReceipt({
          ...receiptBinding,
          providerAccountId,
          code: "creative_preflight_blocked",
          message:
            "Fresh Meta creative identity validation blocked the launch before any provider create request.",
          failedAt: "creative_preflight",
          checks: preflightChecks,
        }),
  }).catch(() => null);
  if (!creativePreflight.ok) {
    return refusalOutcome({
      status: 400,
      code: "creative_preflight_blocked",
      message:
        "Fresh Meta creative identity validation blocked the launch before any provider create request.",
      extra: { launchIntentId: intent.id, blockers: preflightBlockers },
    });
  }

  return runMetaLaunchIntentCreate({
    businessId,
    launchIntentId: intent.id,
    providerAccountId,
    idempotencyKey: intent.idempotencyKey,
    ctx,
    payload: validation.payload,
    executionAuthority: receiptBinding.executionAuthority,
    requestFingerprint: receiptBinding.requestFingerprint,
    actionLogAuthority,
    actionLogPreflightProof: {
      creative_preflight_provider_account_id: creativePreflight.providerAccountId,
      creative_preflight_checked_at: creativePreflight.checkedAt,
      creative_preflight_checks: preflightChecks,
    },
    preflightChecks,
    preflightDisclosure: {
      checkedAt: creativePreflight.checkedAt,
      ageSeconds: preflightAgeSeconds(creativePreflight.checkedAt),
      creativeIdentityVerified: true,
      providerAccountId: creativePreflight.providerAccountId,
    },
    sanitizeError,
    actionLogOrigin: request.actionLogOrigin,
    requestedBy: request.requestedBy,
    beforeProviderMutation: request.beforeProviderMutation,
  });
}

async function runScheduledAddToExisting(
  input: ScheduledCreateContext,
): Promise<MetaLaunchExecutionOutcome> {
  const { request, ctx, receiptBinding, actionLogAuthority } = input;
  const intent = request.intent;
  const businessId = intent.businessId;
  const providerAccountId = intent.providerAccountId;
  const normalizedPayload = normalizeMetaAddToExistingPayload(intent.requestPayload);

  /*
    `rebuild_creative` is refused on the manual path too.

    Recreate-exact-ad has no durable per-step receipt for the image and creative
    writes it would make, so it is review-only. An unattended path that allowed
    it would produce an ad the operator's own screen would have refused to make.
  */
  if (normalizedPayload.copyMode !== "reuse_creative") {
    return refusalOutcome({
      status: 409,
      code: "rebuild_creative_receipt_contract_required",
      message:
        "Recreate exact ad is review-only until every provider image, creative, and ad write has a durable step receipt.",
      extra: { launchIntentId: intent.id },
    });
  }

  const inFlight = await Promise.all(
    normalizedPayload.targets.map((target) =>
      hasRecentPendingMetaAddToExistingAction({
        businessId,
        idempotencyKey: intent.idempotencyKey,
        targetAdsetId: target.targetAdsetId,
        sinceSeconds: 30,
      }).catch(() => true),
    ),
  );
  if (inFlight.some(Boolean)) {
    return refusalOutcome({
      status: 409,
      code: "launch_in_flight",
      message:
        "A Meta add-to-existing launch with this idempotency key is already pending for one of these ad sets.",
      extra: { launchIntentId: intent.id },
    });
  }

  let validation: Awaited<ReturnType<typeof validateMetaAddToExistingRequest>>;
  try {
    validation = await validateMetaAddToExistingRequest({
      businessId,
      providerAccountId,
      payload: normalizedPayload,
    });
  } catch (error) {
    const message = sanitizeError(error);
    await recordMetaLaunchIntentPreExecutionFailure({
      businessId,
      id: intent.id,
      receipt: buildMetaLaunchIntentErrorReceipt({
        ...receiptBinding,
        providerAccountId,
        code: "launch_validation_failed",
        message,
        failedAt: "validation",
      }),
    }).catch(() => null);
    return refusalOutcome({
      status: 500,
      code: "launch_validation_failed",
      message,
      extra: { launchIntentId: intent.id },
    });
  }
  if (!validation.ok) {
    await recordMetaLaunchIntentValidation({
      businessId,
      id: intent.id,
      receipt: buildMetaLaunchIntentValidationReceipt({
        ...receiptBinding,
        providerAccountId,
        ok: false,
        blockers: validation.blockers,
        warnings: validation.warnings,
      }),
    }).catch(() => null);
    return refusalOutcome({
      status: 400,
      code: "validation_blocked",
      message: "Launch validation failed.",
      extra: { launchIntentId: intent.id, blockers: validation.blockers },
    });
  }

  let livePreflight: Awaited<
    ReturnType<typeof validateMetaAddToExistingLiveProviderPreflight>
  >;
  try {
    livePreflight = await validateMetaAddToExistingLiveProviderPreflight({
      ctx,
      payload: validation.payload,
    });
  } catch (error) {
    livePreflight = {
      ok: false,
      blockers: [
        { code: "provider_preflight_unavailable", message: sanitizeError(error) },
      ],
      checks: [],
    };
  }
  await recordMetaLaunchIntentValidation({
    businessId,
    id: intent.id,
    receipt: buildMetaLaunchIntentValidationReceipt({
      ...receiptBinding,
      providerAccountId,
      ok: livePreflight.ok,
      blockers: livePreflight.blockers,
      warnings: validation.warnings,
      checks: livePreflight.checks,
    }),
  }).catch(() => null);
  if (!livePreflight.ok) {
    return refusalOutcome({
      status: 409,
      code: "provider_preflight_blocked",
      message:
        "Fresh Meta source and target hierarchy verification blocked this launch.",
      extra: { launchIntentId: intent.id, blockers: livePreflight.blockers },
    });
  }

  return runMetaAddToExistingCreate({
    businessId,
    launchIntentId: intent.id,
    providerAccountId,
    idempotencyKey: intent.idempotencyKey,
    ctx,
    payload: validation.payload,
    validationTargets: validation.targets,
    validationCreatives: validation.creatives,
    // The operator's own per-creative names, as the stored payload carries
    // them. `normalizeMetaAddToExistingPayload` keeps them in `names`.
    nameOverrides: validation.payload.names ?? {},
    copyMode: validation.payload.copyMode,
    livePreflightChecks: livePreflight.checks,
    targetCampaignId: validation.payload.targetCampaignId,
    targetAdsetId: validation.payload.targetAdsetId,
    executionAuthority: receiptBinding.executionAuthority,
    requestFingerprint: receiptBinding.requestFingerprint,
    actionLogAuthority,
    sanitizeError,
    actionLogOrigin: request.actionLogOrigin,
    requestedBy: request.requestedBy,
    beforeProviderMutation: request.beforeProviderMutation,
  });
}
