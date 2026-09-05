/**
 * Approval execution — a caller of the existing guarded write path, not a path.
 *
 * There is exactly one place in this repo that performs a manual campaign or
 * ad-set status write: `handleMetaEntityPauseAction` /
 * `handleMetaEntityResumeAction` in `lib/meta/entity-action-routes.ts`. That
 * handler is what enforces the manual-operator origin, the explicit operator
 * confirmation, the kill switch, the reviewer read-only rule, the in-flight
 * lock, the fresh provider preflight and both halves of the action log.
 *
 * This module does **not** reimplement any of that. It builds the exact request
 * that handler requires — using `buildDispatchDescriptor`, the same module the
 * decision-bound ceremony uses, so the body is the one the handler was read
 * against — and then calls the handler itself with the operator's own
 * credentials forwarded. Every guard therefore runs on the real request, in the
 * real order, and a change to the handler changes approval too.
 *
 * Two things are deliberately NOT delegated, because the handler cannot know
 * them:
 *
 * - `recId` is added to the body so the action-log row the handler writes
 *   carries `rec_id_origin` = the engine decision the proposal projects. That
 *   is the durable link between a queue row and its ledger receipt. The field
 *   is accepted by the handler's contract (it is not a native-lineage field);
 *   it does not manufacture native decision authority, and the action is still
 *   recorded as `manual_operator_v1` because an operator confirmed it. A
 *   rule-raised proposal has no engine decision behind it, so the field is
 *   simply omitted rather than filled with the rule's own id — a forged
 *   `rec_id_origin` would point the ledger at a decision that never existed.
 * - `dryRun` is set from the business's own `dryRunOnly` guardrail — the
 *   guardrail the Automation screen displays directly above the queue. The
 *   handler already supports this mode; wiring the persisted guardrail to it is
 *   what makes "approving executes inside the guardrails above" true rather
 *   than decorative.
 *
 * The Launchpad families arrived the same way. A `launch` row and an activation
 * `resume` row are dispatched by forwarding to the extracted Launchpad handlers
 * — `handleMetaLaunchAction` / `handleMetaAddToExistingAction` and
 * `handleMetaLaunchIntentActivateAction` — which is why those bodies were moved
 * out of `app/` at all. Nothing about a create or an activation is reimplemented
 * here, and this module still imports no provider client and no action log.
 */
import { NextRequest } from "next/server";

import {
  handleMetaEntityPauseAction,
  handleMetaAdsetBidAction,
  handleMetaEntityResumeAction,
} from "@/lib/meta/entity-action-routes";
import {
  handleMetaAddToExistingAction,
  handleMetaLaunchAction,
} from "@/lib/launchpad/meta-launch-route-handlers";
import { handleMetaLaunchIntentActivateAction } from "@/lib/meta/launch-activation-route-handlers";
import type { MetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent";
import type {
  MetaAutomationProposal,
  MetaAutomationProposalReceipt,
} from "@/lib/meta/automation-proposals";
import { handleMetaAdStatusAction } from "@/lib/meta/ads-action-routes";
import { buildDispatchDescriptor } from "@/lib/zero-base/meta/dispatch-contract";
import type { BudgetProposalExecutionResult } from "@/lib/meta/budget-proposal-runtime";

const PARAM_NAME: Record<MetaAutomationProposal["scopeType"], string> = {
  campaign: "campaignId",
  adset: "adsetId",
  ad: "adId",
};

/**
 * Actions this module may hand to the entity-action handler as a descriptor.
 *
 * `bid` was here for a reason that has since stopped being true — it needed an
 * amount no proposal could prove — and it is now handled by its own branch
 * below, from the row's persisted envelope rather than from an operator's
 * typing. `duplicate` is still absent: it exists only at ad grain, whose write
 * path is the decision-origin contract.
 *
 * `launch` is likewise handled by its own branch, and so is the `resume` that
 * carries a `launchIntentId`. An activation resume is NOT a status write on
 * something the engine was watching — it turns on a hierarchy a launch just
 * created — so sending it to this descriptor would resume an entity through a
 * path that knows nothing about ordering, read-back or the intent's receipt.
 */
type ExecutableProposalAction = "pause" | "resume";

function isExecutable(
  action: MetaAutomationProposal["proposedAction"],
): action is ExecutableProposalAction {
  return action === "pause" || action === "resume";
}

/**
 * Forward only what authorizes the caller.
 *
 * The cookie proves the operator; the content type describes the body we build
 * here. Copying the whole header set would carry a stale `content-length` from
 * the original request and describe a body that no longer exists.
 */
function forwardedHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  headers.set("content-type", "application/json");
  return headers;
}

export interface ExecuteProposalResult {
  ok: boolean;
  receipt: MetaAutomationProposalReceipt;
}

/**
 * A refusal that reached no handler, said in the receipt's own vocabulary.
 *
 * `withheld` is the field every downstream reader uses to tell a refusal from
 * an attempt, so a branch that decides not to dispatch has to fill it rather
 * than return a bare failure.
 */
function withheldResult(input: {
  reason: string;
  dryRunOnly: boolean;
  dispatchedAt: string;
  receiptKey: string | null;
}): ExecuteProposalResult {
  return {
    ok: false,
    receipt: {
      httpStatus: 422,
      response: null,
      dryRun: input.dryRunOnly,
      dispatchedAt: input.dispatchedAt,
      endpoint: null,
      withheld: input.reason,
      receiptKey: input.receiptKey,
    },
  };
}

export async function executeMetaAutomationProposal(input: {
  request: NextRequest;
  businessId: string;
  proposal: MetaAutomationProposal;
  /** The persisted `dryRunOnly` guardrail shown above the queue. */
  dryRunOnly: boolean;
  /**
   * The attempt's claim token, stamped into every receipt this call produces.
   *
   * It is what makes the ledger row, the queue row and the response envelope
   * joinable to ONE attempt. Optional only so a caller that has not migrated
   * to the claim path still type-checks; the queue's own boundary always
   * supplies it.
   */
  receiptKey?: string | null;
  /**
   * D088: the budget runtime, injected.
   *
   * Absent for every current caller, which is why a budget proposal cannot
   * reach a provider today even if one were somehow raised.
   */
  budgetRuntime?: (input: {
    proposal: MetaAutomationProposal;
    dryRunOnly: boolean;
    claimToken: string | null;
  }) => Promise<BudgetProposalExecutionResult>;
  /**
   * The intent a Launchpad row points at, read by the caller and injected.
   *
   * The queue row knows it is a launch; only the intent knows WHICH launch —
   * its operation, its idempotency key and the payload the operator's own
   * fingerprint was taken over. Reading any of that from the row instead would
   * let a stale projection create something the operator never composed.
   */
  launchIntent?: (launchIntentId: string) => Promise<MetaLaunchIntent | null>;
  /**
   * Write-ahead dispatch intent, fired at the handler's own pre-POST boundary.
   *
   * The Launchpad handlers refuse the create or the activation outright when
   * this answers false, so a claim that can no longer be marked cannot cause a
   * provider write nobody could account for afterwards. Absent for the pause
   * family, whose boundary marks before the handler is entered at all.
   */
  markDispatchStarted?: () => Promise<boolean>;
  now?: Date;
}): Promise<ExecuteProposalResult> {
  const dispatchedAt = (input.now ?? new Date()).toISOString();
  const receiptKey = input.receiptKey ?? null;
  const { proposal } = input;

  /*
    D088: a budget proposal executes through the SAME entry point, and through
    the SAME D087 executor the scheduled sweep uses. It is routed here rather
    than through `buildDispatchDescriptor` because a budget change is not an
    operator ceremony — the browser posts nothing, and `MUTATION_ENDPOINTS`
    deliberately names no path for it.

    The runtime is INJECTED. A caller that has not supplied one has no way to
    reach a provider, which is the state every current caller is in.
  */
  if (proposal.proposedAction === "budget") {
    if (!input.budgetRuntime) {
      return {
        ok: false,
        receipt: {
          httpStatus: 422,
          response: null,
          dryRun: input.dryRunOnly,
          dispatchedAt,
          endpoint: null,
          withheld: "budget_runtime_unavailable",
          receiptKey,
        },
      };
    }
    const result = await input.budgetRuntime({
      proposal, dryRunOnly: input.dryRunOnly, claimToken: receiptKey,
    });
    return {
      ok: result.ok,
      receipt: {
        httpStatus: result.receipt.httpStatus,
        response: result.receipt.response,
        dryRun: result.receipt.dryRun,
        dispatchedAt: result.receipt.dispatchedAt,
        endpoint: result.receipt.endpoint,
        withheld: result.receipt.withheld,
        receiptKey,
      },
    };
  }

  /*
    An approved BID row, with the amount the server proved.

    `buildDispatchDescriptor` asks an operator to TYPE a bid amount, which is
    right on a decision card and wrong here: this row already carries an
    envelope naming the exact minor units, bound to the row's identity and
    fingerprinted. Asking again would invite a different number than the one
    that was approved.

    It goes through the same guarded `apply-bid` handler an operator's own
    entry uses, under the same manual origin and confirmation — both true
    statements: a person clicked Approve on this row.
  */
  if (proposal.proposedAction === "bid") {
    const envelope = proposal.bidEnvelope;
    if (!envelope || proposal.scopeType !== "adset") {
      return {
        ok: false,
        receipt: {
          httpStatus: 422,
          response: null,
          dryRun: input.dryRunOnly,
          dispatchedAt,
          endpoint: null,
          withheld: "bid_envelope_absent",
          receiptKey,
        },
      };
    }
    const path = `/api/meta/adsets/${proposal.scopeId}/apply-bid`;
    const bidRequest = new NextRequest(
      new URL(path, input.request.nextUrl.origin),
      {
        method: "POST",
        headers: forwardedHeaders(input.request),
        body: JSON.stringify({
          actionOrigin: "manual_operator_v1",
          manualConfirmation: "explicit_operator_confirmation",
          businessId: input.businessId,
          providerAccountId: proposal.providerAccountId,
          bidAmountMinor: envelope.proposedMinorUnits,
          ...(proposal.recId ? { recId: proposal.recId } : {}),
          ...(input.dryRunOnly ? { dryRun: true } : {}),
        }),
      },
    );
    const bidResponse = await handleMetaAdsetBidAction(bidRequest, {
      params: Promise.resolve({ adsetId: proposal.scopeId }),
    });
    const bidPayload = (await bidResponse.json().catch(() => null)) as unknown;
    return {
      ok: bidResponse.status < 400
        && (bidPayload as { ok?: boolean } | null)?.ok === true,
      receipt: {
        httpStatus: bidResponse.status,
        response: bidPayload,
        dryRun: input.dryRunOnly,
        dispatchedAt,
        endpoint: path,
        withheld: null,
        receiptKey,
      },
    };
  }

  /*
    An approved LAUNCH row, executed by the Launchpad handler an operator's own
    review screen posts to.

    Before this branch the row fell through to `unsupported_action`, and the
    boundary settled that withheld answer as `failed` — so approving a launch
    destroyed the queue row and created nothing. The row is not the authority
    here and never composes anything: the operation, the idempotency key and
    the payload all come from the intent, whose stored payload is replayed
    field for field because `metaLaunchIntentRequestFingerprint` hashes it
    whole. Recomposing it to look like a queue dispatch would be refused by the
    intent service as `launch_intent_contract_mismatch`.
  */
  if (proposal.proposedAction === "launch") {
    const withheld = (reason: string) =>
      withheldResult({ reason, dryRunOnly: input.dryRunOnly, dispatchedAt, receiptKey });
    if (!proposal.launchIntentId) return withheld("launch_intent_absent");
    if (!input.launchIntent) return withheld("launch_intent_reader_unavailable");
    /*
      The guardrail the screen shows above the queue, honoured by refusing.

      Every other family can answer `dryRunOnly` by rehearsing. A create
      cannot: `launch-write.ts` has no dry-run path, because a campaign that
      was not created has no id to read back. Dispatching anyway would make the
      guardrail decorative for the one family where it is most expensive to
      ignore.
    */
    if (input.dryRunOnly) return withheld("dry_run_guardrail");
    const intent = await input
      .launchIntent(proposal.launchIntentId)
      .catch(() => null);
    if (!intent) return withheld("launch_intent_unreadable");

    const addToExisting = intent.operation === "add_to_existing";
    const path = addToExisting
      ? "/api/launchpad/meta/add-to-existing"
      : "/api/launchpad/meta/launch";
    const launchRequest = new NextRequest(
      new URL(path, input.request.nextUrl.origin),
      {
        method: "POST",
        headers: forwardedHeaders(input.request),
        body: JSON.stringify({
          actionOrigin: "launchpad_manual_v1",
          manualConfirmation: "explicit_operator_confirmation",
          businessId: input.businessId,
          providerAccountId: intent.providerAccountId,
          idempotencyKey: intent.idempotencyKey,
          launchIntentId: intent.id,
          /*
            The two handlers read the stored payload differently — the create
            takes it whole under `payload`, add-to-existing reads its own
            fields off the body — so it is handed over in the shape each one
            normalizes back to the very payload the fingerprint was taken over.
          */
          ...(addToExisting
            ? intent.requestPayload
            : { payload: intent.requestPayload }),
        }),
      },
    );
    const launchResponse = addToExisting
      ? await handleMetaAddToExistingAction(launchRequest, {
          beforeProviderMutation: input.markDispatchStarted,
        })
      : await handleMetaLaunchAction(launchRequest, {
          beforeProviderMutation: input.markDispatchStarted,
        });
    const launchPayload = (await launchResponse.json().catch(() => null)) as unknown;
    return {
      ok: launchResponse.status < 400
        && (launchPayload as { ok?: boolean } | null)?.ok === true,
      receipt: {
        httpStatus: launchResponse.status,
        response: launchPayload,
        dryRun: input.dryRunOnly,
        dispatchedAt,
        endpoint: path,
        withheld: null,
        receiptKey,
      },
    };
  }

  /*
    An approved ACTIVATION row — a `resume` that names the intent it turns on.

    `resume` alone would go to the entity handler below, which resumes one
    entity and knows nothing about the campaign above it. Activation is the
    ordered, read-back, journalled sequence in `launch-intent-activation.ts`,
    and an ad reading ACTIVE under a paused parent shows to nobody. The lineage
    on the row is what tells the two apart, which is why it is checked before
    the descriptor path and not after it.
  */
  if (proposal.proposedAction === "resume" && proposal.launchIntentId) {
    const withheld = (reason: string) =>
      withheldResult({ reason, dryRunOnly: input.dryRunOnly, dispatchedAt, receiptKey });
    // An activation cannot be rehearsed either: the whole value of the step is
    // the effective status coming back ACTIVE, which a dry run cannot produce.
    if (input.dryRunOnly) return withheld("dry_run_guardrail");
    const path = `/api/launchpad/meta/intents/${proposal.launchIntentId}/activate`;
    const activateRequest = new NextRequest(
      new URL(path, input.request.nextUrl.origin),
      {
        method: "POST",
        headers: forwardedHeaders(input.request),
        body: JSON.stringify({
          actionOrigin: "manual_operator_v1",
          manualConfirmation: "explicit_operator_confirmation",
          businessId: input.businessId,
        }),
      },
    );
    const activateResponse = await handleMetaLaunchIntentActivateAction(
      activateRequest,
      { params: Promise.resolve({ id: proposal.launchIntentId }) },
      { beforeProviderMutation: input.markDispatchStarted },
    );
    const activatePayload = (await activateResponse
      .json()
      .catch(() => null)) as unknown;
    return {
      ok: activateResponse.status < 400
        && (activatePayload as { ok?: boolean } | null)?.ok === true,
      receipt: {
        httpStatus: activateResponse.status,
        response: activatePayload,
        dryRun: input.dryRunOnly,
        dispatchedAt,
        endpoint: path,
        withheld: null,
        receiptKey,
      },
    };
  }

  if (!isExecutable(proposal.proposedAction)) {
    return {
      ok: false,
      receipt: {
        httpStatus: 422,
        response: null,
        dryRun: input.dryRunOnly,
        dispatchedAt,
        endpoint: null,
        withheld: "unsupported_action",
        receiptKey,
      },
    };
  }

  /*
    The creative identity an ad write must present.

    The ad route resolves the true target and refuses unless the creative it
    finds still matches the one presented — which is the check that makes a
    stale row unable to pause a different ad than the one it was raised about.
    The projection persists the identity the decision was made on; nothing here
    invents it, and an ad row without one is withheld by the builder.
  */
  const creativeId = typeof proposal.evidenceRef?.creativeId === "string"
    ? proposal.evidenceRef.creativeId
    : null;
  const built = buildDispatchDescriptor({
    businessId: input.businessId,
    target: {
      grain: proposal.scopeType,
      entityId: proposal.scopeId,
      providerAccountId: proposal.providerAccountId,
      creativeId,
      parentId: null,
    },
    action: proposal.proposedAction,
    accountCurrency: null,
    issuedAt: dispatchedAt,
  });
  if (!built.ok) {
    return {
      ok: false,
      receipt: {
        httpStatus: 422,
        response: { error: { code: built.reason, message: built.message } },
        dryRun: input.dryRunOnly,
        dispatchedAt,
        endpoint: null,
        withheld: built.reason,
        receiptKey,
      },
    };
  }

  const body = {
    ...built.descriptor.body,
    // Lineage of the *evidence*, not of the authority. See the module note.
    ...(proposal.recId ? { recId: proposal.recId } : {}),
    ...(input.dryRunOnly ? { dryRun: true } : {}),
  };

  const url = new URL(built.descriptor.path, input.request.nextUrl.origin);
  const forwarded = new NextRequest(url, {
    method: "POST",
    headers: forwardedHeaders(input.request),
    body: JSON.stringify(body),
  });
  const paramName = PARAM_NAME[proposal.scopeType];
  const context = {
    params: Promise.resolve({ [paramName]: proposal.scopeId }),
  };

  /*
    Ad grain goes to the ad handler, which is a different write with a
    different journal: it resolves the true target, refuses unless the creative
    identity it finds still matches the one presented, and records an immutable
    per-attempt event before the single POST. Sending an ad row to the entity
    handler would hit a route that does not exist for it.
  */
  const response =
    proposal.scopeType === "ad"
      ? await handleMetaAdStatusAction(
          forwarded,
          { params: Promise.resolve({ adId: proposal.scopeId }) },
          proposal.proposedAction,
        )
      : proposal.proposedAction === "pause"
        ? await handleMetaEntityPauseAction(forwarded, context, {
            scopeType: proposal.scopeType,
            paramName,
          })
        : await handleMetaEntityResumeAction(forwarded, context, {
            scopeType: proposal.scopeType,
            paramName,
          });

  const payload = (await response.json().catch(() => null)) as unknown;
  const ok = response.status < 400 && (payload as { ok?: boolean } | null)?.ok === true;

  return {
    ok,
    receipt: {
      httpStatus: response.status,
      response: payload,
      dryRun: input.dryRunOnly,
      dispatchedAt,
      endpoint: built.descriptor.path,
      withheld: null,
      receiptKey,
    },
  };
}
