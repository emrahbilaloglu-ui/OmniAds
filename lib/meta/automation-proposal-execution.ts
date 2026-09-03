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
 */
import { NextRequest } from "next/server";

import {
  handleMetaEntityPauseAction,
  handleMetaEntityResumeAction,
} from "@/lib/meta/entity-action-routes";
import type {
  MetaAutomationProposal,
  MetaAutomationProposalReceipt,
} from "@/lib/meta/automation-proposals";
import { buildDispatchDescriptor } from "@/lib/zero-base/meta/dispatch-contract";
import type { BudgetProposalExecutionResult } from "@/lib/meta/budget-proposal-runtime";

const PARAM_NAME: Record<MetaAutomationProposal["scopeType"], string> = {
  campaign: "campaignId",
  adset: "adsetId",
};

/**
 * Actions this module may hand to the entity-action handler.
 *
 * `bid` and `duplicate` are absent on purpose: the first needs an
 * operator-entered amount no proposal proves, and the second exists only at ad
 * grain, whose write path is the decision-origin contract.
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

  const built = buildDispatchDescriptor({
    businessId: input.businessId,
    target: {
      grain: proposal.scopeType,
      entityId: proposal.scopeId,
      providerAccountId: proposal.providerAccountId,
      creativeId: null,
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

  const response =
    proposal.proposedAction === "pause"
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
