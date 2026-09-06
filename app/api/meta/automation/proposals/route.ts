/**
 * The confirmation queue's server boundary.
 *
 * Shaped after its closest sibling, `app/api/meta/automation/route.ts`, because
 * it is the same subsystem on the same screen: the same account-scope
 * resolution, the same `guest` read / `collaborator` write split, the same
 * reviewer read-only guard, and one POST with an action discriminator rather
 * than three routes. Three routes would be three answers to "may this
 * proposal be decided", and only one of them could be right.
 *
 * Approve is the only action that reaches a provider, and it does not write
 * anything itself: it calls the existing guarded entity-action handler through
 * `executeMetaAutomationProposal`. Everything below approve's own gate —
 * manual-operator origin, in-flight lock, fresh provider preflight, action log
 * — belongs to that handler and is not restated here.
 */
import { NextRequest, NextResponse } from "next/server";

import { requireBusinessAccess } from "@/lib/access";
import {
  executeMetaAutomationProposal,
  type ExecuteProposalResult,
} from "@/lib/meta/automation-proposal-execution";
import {
  META_AUTOMATION_PROPOSAL_ACTIONS,
  NO_PROVIDER_DISPATCH,
  claimMetaAutomationProposal,
  countMetaAutomationProposalHolds,
  evaluateProposalTransition,
  forceMetaAutomationProposalReconcile,
  markMetaAutomationProposalDispatchStarted,
  providerDispatchFacts,
  readMetaAutomationProposal,
  readMetaAutomationProposalQueue,
  settleMetaAutomationProposal,
  type MetaAutomationProposal,
  type MetaAutomationProposalAction,
  type MetaAutomationProposalReceipt,
  type MetaAutomationProviderDispatchFacts,
  META_AUTOMATION_PROPOSALS_CONTRACT,
} from "@/lib/meta/automation-proposals";
import { appendMetaAutomationReconciliationReceipt } from "@/lib/meta/automation-reconciliation";
import {
  getMetaAutomationControlPlane,
  writeActivityLedgerRow,
  type MetaAutomationActivityResultStatus,
} from "@/lib/meta/automation-control-plane";
import { rejectIfMetaWritesBlocked } from "@/lib/meta/automation-write-guard";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { resolveMetaCreativesAccountScope } from "@/lib/meta/creatives-warehouse";
import { confirmationFor } from "@/lib/zero-base/meta/mutation-ceremony";
import { rejectIfAutomationDemoWrite } from "../demo-write-authority";
import { metaAutomationDryRunOnly } from "@/lib/meta/release-gate-guard";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { missingSteps, writeFamily } from "@/lib/meta/write-safety-contract";
import { BUDGET_PROPOSAL_ACTION } from "@/lib/meta/budget-proposal-runtime";
import { createBudgetProposalServerRuntime } from "@/lib/meta/budget-proposal-server-runtime";
import { runClaimedProposalExecution } from "@/lib/meta/budget-execution-lifecycle";
import { createBudgetServerReaders } from "@/lib/meta/budget-proposal-server-readers";
import {
  buildMetaBudgetWriteContextForProposal,
  readProposalBidBaseline,
} from "@/lib/meta/budget-proposal-write-context";
import { getMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import { MANUAL_CONFIRMATION } from "@/lib/zero-base/meta/dispatch-contract";

export const dynamic = "force-dynamic";

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function sanitizeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

/** Identical to the sibling Automation route's scope resolution. */
async function resolveAutomationAccountScope(input: {
  businessId: string;
  providerAccountId: string | null;
}) {
  try {
    const result = resolveMetaCreativesAccountScope({
      assignedAccountIds: await fetchAssignedAccountIds(input.businessId),
      requestedProviderAccountId: input.providerAccountId,
    });
    if (result.ok) return { ok: true as const, providerAccountId: result.providerAccountId };
    return {
      ok: false as const,
      response: jsonError(
        result.status === "account_not_assigned" ? 403 : 400,
        result.status,
        result.status === "account_not_assigned"
          ? "The requested Meta account is not assigned to this business."
          : "Select one assigned Meta account before reading or changing Automation.",
      ),
    };
  } catch {
    return {
      ok: false as const,
      response: jsonError(
        503,
        "provider_account_scope_unavailable",
        "Meta account assignments are unavailable; Automation fails closed.",
      ),
    };
  }
}

/**
 * The queue, plus provenance for the queue.
 *
 * `sections.proposals` is the same envelope shape every other Automation
 * section now carries: a status, the code behind it, and when it was observed.
 * The flat `readCompleteness.proposals` stays beside it because the surface and
 * its tests already read that field, and removing it would turn an additive
 * envelope into a breaking one.
 *
 * `holds` is how a claimed or reconcile row stays visible without inventing a
 * queue row for it: those rows are not approvable, so they are not in
 * `proposals`, but the operator must not be told the queue is empty while one
 * of them is holding an entity's slot.
 */
async function queueResponse(input: {
  businessId: string;
  providerAccountId: string;
  extra?: Record<string, unknown>;
}) {
  const observedAt = new Date().toISOString();
  const queue = await readMetaAutomationProposalQueue({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const holds = await countMetaAutomationProposalHolds({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  }).catch(() => null);
  return NextResponse.json({
    ok: true,
    contractVersion: META_AUTOMATION_PROPOSALS_CONTRACT,
    providerAccountId: input.providerAccountId,
    readCompleteness: { proposals: queue.readCompleteness },
    sections: {
      proposals: {
        status: queue.readCompleteness,
        errorCode:
          queue.readCompleteness === "complete"
            ? null
            : "proposal_queue_unavailable",
        observedAt,
      },
    },
    holds,
    proposals: queue.proposals,
    ...(input.extra ?? {}),
  });
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const requestedProviderAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() || null;
  if (!businessId) return jsonError(400, "missing_business_id", "businessId is required.");

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const accountScope = await resolveAutomationAccountScope({
    businessId: access.membership.businessId,
    providerAccountId: requestedProviderAccountId,
  });
  if (!accountScope.ok) return accountScope.response;

  try {
    return await queueResponse({
      businessId: access.membership.businessId,
      providerAccountId: accountScope.providerAccountId,
    });
  } catch (error) {
    return jsonError(500, "proposal_queue_read_failed", sanitizeErrorMessage(error));
  }
}

/**
 * Record what an operator decided, and — for approve only — reach the provider.
 *
 * The order of the gates is part of the contract. Authorization first, then
 * posture (reviewer), then the account scope, then the proposal's own state
 * machine, and only then the write-side gates. A reviewer never reaches a
 * proposal lookup, and an expired proposal never reaches the kill switch.
 */
export async function POST(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  const requestedProviderAccountId =
    request.nextUrl.searchParams.get("providerAccountId")?.trim() || null;
  if (!businessId) return jsonError(400, "missing_business_id", "businessId is required.");

  const body = (await request.json().catch(() => null)) as
    | {
        action?: unknown;
        proposalId?: unknown;
        note?: unknown;
        manualConfirmation?: unknown;
      }
    | null;

  const action = body?.action;
  if (
    typeof action !== "string" ||
    !META_AUTOMATION_PROPOSAL_ACTIONS.includes(
      action as MetaAutomationProposalAction,
    )
  ) {
    return jsonError(
      400,
      "unsupported_proposal_action",
      "Only approve, modify and dismiss are supported from the confirmation queue.",
    );
  }
  const proposalAction = action as MetaAutomationProposalAction;
  const proposalId = typeof body?.proposalId === "string" ? body.proposalId.trim() : "";
  if (!proposalId) {
    return jsonError(400, "missing_proposal_id", "proposalId is required.");
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    // Same authority the sibling route requires to engage the stop or record a
    // decision-type mode, and the same the entity-action handler this approval
    // delegates to requires. Nothing here loosens a safety control, so nothing
    // here needs the `admin` level the sibling reserves for the STOP release.
    minRole: "collaborator",
  });
  if ("error" in access) return access.error;

  const reviewerBlocked = rejectIfReviewerReadOnly(
    access,
    `automation_proposal_${proposalAction}`,
  );
  if (reviewerBlocked) return reviewerBlocked;

  /**
   * Zero write authority in a demo workspace, for all three actions.
   *
   * `approve` was already covered downstream — `rejectIfMetaWritesBlocked`
   * inside `approve()` reads `getMetaWriteBlockState`, which refuses a demo
   * business. `modify` and `dismiss` were not: `decideWithoutProviderWrite`
   * never consults that guard, so a demo session could settle a proposal row
   * and write an activity-ledger row for it. Hoisted here so all three answer
   * the same way, and so `approve` refuses before it claims the row rather
   * than after — a claim taken by a request that was always going to be
   * refused would leave the proposal held by nobody.
   */
  const demoBlocked = await rejectIfAutomationDemoWrite(
    access.membership.businessId,
    `automation_proposal_${proposalAction}`,
  );
  if (demoBlocked) return demoBlocked;

  const accountScope = await resolveAutomationAccountScope({
    businessId: access.membership.businessId,
    providerAccountId: requestedProviderAccountId,
  });
  if (!accountScope.ok) return accountScope.response;

  const scopedBusinessId = access.membership.businessId;

  try {
    const proposal = await readMetaAutomationProposal({
      businessId: scopedBusinessId,
      providerAccountId: accountScope.providerAccountId,
      proposalId,
    });
    if (!proposal) {
      return jsonError(
        404,
        "proposal_not_found",
        "No such proposal exists for this business and Meta account.",
      );
    }

    const transition = evaluateProposalTransition({
      status: proposal.status,
      expiresAt: proposal.expiresAt,
      action: proposalAction,
      now: new Date(),
    });
    if (!transition.ok) {
      return jsonError(409, transition.refusal, transition.message);
    }

    if (proposalAction !== "approve") {
      return await decideWithoutProviderWrite({
        access,
        businessId: scopedBusinessId,
        providerAccountId: accountScope.providerAccountId,
        proposal,
        action: proposalAction,
        note: typeof body?.note === "string" ? body.note : null,
      });
    }

    return await approve({
      request,
      access,
      businessId: scopedBusinessId,
      providerAccountId: accountScope.providerAccountId,
      proposal,
      manualConfirmation: body?.manualConfirmation,
    });
  } catch (error) {
    return jsonError(500, "proposal_action_failed", sanitizeErrorMessage(error));
  }
}

type Access = Extract<
  Awaited<ReturnType<typeof requireBusinessAccess>>,
  { session: unknown }
>;

/**
 * Modify and Dismiss.
 *
 * Neither reaches a provider. Modify is not an editor: no field of a pause
 * proposal is operator-editable (the dispatch contract declares no operator
 * fields for a status write), so the honest boundary records the operator's
 * written modification, takes the row out of the executable queue, and leaves
 * the underlying decision to be re-proposed by the next snapshot. A note is
 * required for exactly that reason — without it the record would say a
 * modification happened and not what it was.
 */
async function decideWithoutProviderWrite(input: {
  access: Access;
  businessId: string;
  providerAccountId: string;
  proposal: MetaAutomationProposal;
  action: Exclude<MetaAutomationProposalAction, "approve">;
  note: string | null;
}) {
  const next = input.action === "modify" ? "modified" : "dismissed";
  const note = input.note?.trim() || "";
  if (input.action === "modify" && !note) {
    return jsonError(
      400,
      "modification_note_required",
      "Recording a modification requires the change you want instead; the proposal itself has no editable field.",
    );
  }

  // No claim token, so the settle is guarded on `status = 'pending'`. That is
  // deliberate and it is the law here: a row an approval has already claimed is
  // mid-dispatch, and letting a dismissal overwrite it would record "dismissed"
  // for something being paused in Meta at that moment.
  const settled = await settleMetaAutomationProposal({
    businessId: input.businessId,
    proposalId: input.proposal.id,
    status: next,
    decidedBy: input.access.session.user.id,
    decisionNote: note || null,
    receipt: null,
  });
  if (!settled) {
    const current = await readMetaAutomationProposal({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      proposalId: input.proposal.id,
    }).catch(() => null);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code:
            current?.status === "claimed"
              ? "proposal_claim_conflict"
              : "proposal_not_pending",
          message:
            current?.status === "claimed"
              ? "An approval already holds this proposal and is dispatching it, so it can no longer be modified or dismissed."
              : "This proposal was decided by another action before this one landed.",
        },
        proposalStatus: current?.status ?? null,
      },
      { status: 409 },
    );
  }

  const ledger = await recordProposalLedgerEntry({
    businessId: input.businessId,
    userId: input.access.session.user.id,
    activityType: `automation_proposal_${input.action}`,
    severity: "info",
    message:
      input.action === "modify"
        ? `Proposal modified without execution — ${input.proposal.actionLabel} on ${input.proposal.entityLabel ?? input.proposal.scopeId}.`
        : `Proposal dismissed — ${input.proposal.actionLabel} on ${input.proposal.entityLabel ?? input.proposal.scopeId}.`,
    payload: {
      proposalId: input.proposal.id,
      recId: input.proposal.recId,
      decisionKey: input.proposal.decisionKey,
      providerAccountId: input.proposal.providerAccountId,
      note: note || null,
      // Kept, and provable HERE and only here: modify and dismiss never enter a
      // provider handler, so "no write happened" is an observation rather than
      // an inference. The approve path carries the three-fact shape instead,
      // because it is the path where `false` could otherwise mean "unknown".
      providerWrite: false,
      ...NO_PROVIDER_DISPATCH,
    },
    proposal: input.proposal,
    // Nothing reached a provider, so neither `applied` nor `failed` is true of
    // this row: what happened is that the decision was recorded.
    resultStatus: "recorded",
  });

  return queueResponse({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    extra: { proposal: settled, ...ledger },
  });
}

/**
 * Approve.
 *
 * The gate stack, in order, and why each one is here rather than left to the
 * handler this delegates to:
 *
 * 1. **Kill switch** — checked here so an approval never even builds a dispatch
 *    body while writes are stopped. The handler checks it again on the real
 *    request; this is not a substitute for that.
 * 2. **Tier 1 supervision** — the queue's whole premise. Executing requires a
 *    *persisted* supervised posture; a default-shaped control record proves
 *    nothing about what this business actually authorized.
 * 3. **Explicit operator confirmation** — the same token and the same
 *    confirmation level the existing ceremony defines for this action.
 * 4. **`dryRunOnly` guardrail** — read from the same persisted control the
 *    screen shows above the queue and handed to the handler's own dry-run mode.
 * 5. **The atomic claim.** Last, because it is the only gate that MUTATES, and
 *    a claim taken before a cheap refusal would leave the row held by a request
 *    that was never going to dispatch. Everything above is a read.
 *
 * The claim is the fix this boundary owed. The compare-and-set used to run
 * AFTER `executeMetaAutomationProposal`, so it decided who got to record the
 * outcome rather than who got to cause it: two concurrent approvals both
 * reached the provider handler, and the loser was told its action "did not
 * land" while a pause sat in Meta. Now `pending -> claimed` happens first, in
 * one statement, and only its holder may dispatch or settle.
 */
async function approve(input: {
  request: NextRequest;
  access: Access;
  businessId: string;
  providerAccountId: string;
  proposal: MetaAutomationProposal;
  manualConfirmation: unknown;
}) {
  const blocked = await rejectIfMetaWritesBlocked({ businessId: input.businessId });
  if (blocked) return blocked;

  const control = await getMetaAutomationControlPlane({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  }).catch(() => null);
  if (!control || control.businessControl.source !== "persisted") {
    return jsonError(
      503,
      "supervision_state_unavailable",
      "Automation control state could not be verified, so no proposal can be approved.",
    );
  }
  /*
    `readiness_tier` has no application writer anywhere in this repository, so
    its value is always the column default. Requiring exactly `manual_review`
    here therefore passed by accident rather than by decision, and would have
    begun refusing every approval the moment anything wrote a different tier.
    The tier now has one meaning — `read_only` forbids writes — and the standing
    mode is what decides whether a queue row may be approved.
  */
  if (control.businessControl.readinessTier === "read_only") {
    return jsonError(
      409,
      "supervision_tier_read_only",
      "This business is set to read-only, so no proposal can be approved.",
    );
  }

  // `confirmationFor` is the existing ceremony's own rule for how much
  // confirmation an action costs. Reading it here means a future change to that
  // rule changes this boundary too.
  const requiredConfirmation = confirmationFor(input.proposal.proposedAction);
  if (
    requiredConfirmation !== "none" &&
    input.manualConfirmation !== MANUAL_CONFIRMATION
  ) {
    return jsonError(
      400,
      "manual_confirmation_required",
      "Approving a proposal requires the explicit operator confirmation the guarded write path demands.",
    );
  }

  /**
   * Dry-run is decided by the guardrail AND the release gate, not by either
   * alone.
   *
   * `dryRunOnly` is the operator's own persisted control row and stays
   * authoritative — but `META_AUTOMATION_LIVE_WRITES` was declared as the gate
   * for this family and read by nothing, so a row saying `dryRunOnly: false`
   * produced a live provider write with the gate shut. The gate can only ever
   * ADD dry-run: it is the second lock, never a way to remove the first.
   *
   * The write-safety contract is the third: with the gate open and steps
   * missing, this family still runs dry, because "enabled" and "safe to enable"
   * are different facts.
   */
  const dryRunOnly = metaAutomationDryRunOnly({
    persistedGuardrailDryRunOnly:
      control.businessControl.guardrails.dryRunOnly === true,
    gateOpen: readMetaReleaseGates().automationLiveWrites,
    missingSafetySteps: missingSteps(writeFamily("automation_proposal_approval")).map(String),
  });

  const claim = await claimMetaAutomationProposal({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    proposalId: input.proposal.id,
    claimedBy: input.access.session.user.id,
  }).catch(() => ({ status: "unavailable" as const }));

  if (claim.status === "migration_required") {
    // No claim columns means no exclusivity, and an approval without
    // exclusivity is the race this gate exists to close. Refusing costs an
    // operator one deploy; dispatching would cost them a second pause.
    return jsonError(
      503,
      "proposal_claim_unavailable",
      "This deployment cannot claim a proposal exclusively, so no approval may reach Meta. Run the pending Automation migration and retry.",
    );
  }
  if (claim.status === "unavailable") {
    return jsonError(
      503,
      "proposal_claim_unavailable",
      "The confirmation queue could not be claimed, so nothing was dispatched.",
    );
  }
  if (claim.status === "conflict") {
    return claimConflictResponse(claim.current);
  }

  /*
    Written before the handler is entered, never after: its presence is the
    only durable evidence that a provider write MIGHT exist for this attempt.

    D088 C3: NOT for a budget approval. The budget path enters the shared
    lifecycle, which marks synchronously at the pre-POST boundary and vetoes
    the write if the mark cannot be taken — so marking here as well would stamp
    a dispatch on every budget approval that is withheld BEFORE any provider
    contact (a shut gate, a missing confirmation, an inadmissible composition),
    and an operator reading the row could not tell those from a real dispatch.
    The pause family keeps its own marker: its handler has no such boundary.

    Nor for a Launchpad row — a `launch`, or the `resume` that names the intent
    it activates. Both cross a long chain of pre-provider refusals inside their
    handler (a closed execution gate, a demo workspace, rehearsal, validation,
    the fresh creative preflight), and until this branch existed a launch row
    was stamped as dispatched while the executor answered `unsupported_action`
    and nothing was ever sent. They take the marker through
    `markDispatchStarted` below, which the handler fires immediately before its
    first provider call and which VETOES that call when it cannot be written.
  */
  const marksAtItsOwnBoundary =
    input.proposal.proposedAction === BUDGET_PROPOSAL_ACTION
    || input.proposal.proposedAction === "launch"
    /*
      `bid` joins them, because it too can refuse BEFORE any provider call.

      The executor now re-reads the live cap and withholds on
      `bid_baseline_changed` / `bid_strategy_not_writable` / a failed read —
      all of them ahead of the handler. Stamping a dispatch before that would
      leave a row reading as though a provider write may have been attempted
      when nothing was sent, which is the same pathology this file's header
      records for launch rows.
    */
    || input.proposal.proposedAction === "bid"
    || (input.proposal.proposedAction === "resume"
      && input.proposal.launchIntentId !== null);
  const dispatchMarked = marksAtItsOwnBoundary
    ? true
    : await markMetaAutomationProposalDispatchStarted({
      businessId: input.businessId,
      proposalId: input.proposal.id,
      claimToken: claim.claimToken,
    }).catch(() => false);
  if (!dispatchMarked) {
    // The claim is no longer ours. Dispatching anyway would be exactly the
    // unclaimed provider write this whole path exists to prevent.
    const current = await readMetaAutomationProposal({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      proposalId: input.proposal.id,
    }).catch(() => null);
    return claimConflictResponse(current);
  }

  let execution: ExecuteProposalResult;
  let ambiguous = false;
  /*
    D088 C3: the budget path settles and ledgers ONCE, inside the shared
    lifecycle. Its result is captured here so the response can be built from
    the settlement that already happened instead of performing a second one.
  */
  let budgetLifecycle: Awaited<ReturnType<typeof runClaimedProposalExecution>> | null = null;
  try {
    execution = await executeMetaAutomationProposal({
      request: input.request,
      businessId: input.businessId,
      proposal: input.proposal,
      dryRunOnly,
      receiptKey: claim.claimToken,
      /*
        The live cap, read at the manual boundary the way the scheduled sweep
        reads it at its own.

        Injected rather than imported. `automation-write-path.test.ts` asserts
        that no module in this subsystem — this file included — so much as
        mentions the Meta write client by name, and it checks the SOURCE TEXT,
        so even naming it in a comment trips the guard. That crudeness is the
        point: it catches a second write path that a type signature would not.
        The read therefore lives behind `readProposalBidBaseline`, in the one
        module on the proposal path sanctioned to hold that import.

        Omitting it is not a safe default: without a reader the executor
        refuses every bid row, which would consume the operator's proposal and
        settle it `failed` with no remedy.
      */
      readBidBaseline: async ({ providerAccountId, adsetId }) =>
        readProposalBidBaseline({
          businessId: input.businessId,
          providerAccountId,
          adsetId,
        }),
      /*
        The intent behind a Launchpad row, bound to THIS business.

        The executor is handed a reader, not an id it could resolve itself, so
        a launch row can never reach an intent belonging to a business the
        approving operator has no membership in.
      */
      launchIntent: async (launchIntentId) =>
        getMetaLaunchIntent({
          businessId: input.businessId,
          id: launchIntentId,
        }).catch(() => null),
      /*
        The write-ahead marker, fired from inside the Launchpad handler at the
        boundary before its first provider call, and refusing the call when it
        cannot be recorded. Same compare-and-set the pause family takes above,
        moved to the only place that can tell a refusal from an attempt.
      */
      markDispatchStarted: async () =>
        Boolean(await markMetaAutomationProposalDispatchStarted({
          businessId: input.businessId,
          proposalId: input.proposal.id,
          claimToken: claim.claimToken,
        }).catch(() => null)),
      /*
        D088 C3: the CONCRETE budget runtime, and the SHARED lifecycle.

        A budget approval no longer relies on this route's own marker/settle
        block: it enters `runClaimedProposalExecution`, the same function the
        scheduled sweep uses, which fires the dispatch marker synchronously at
        the pre-POST boundary and vetoes the write if it cannot be recorded.
        Authorization here is the operator's explicit confirmation — automatic
        enablement is the SCHEDULED path's requirement, not this one's.
      */
      budgetRuntime: async (runtimeInput) => {
        const runtime = createBudgetProposalServerRuntime(
          createBudgetServerReaders({
            businessId: input.businessId,
            actorUserId: input.access.session.user.id,
            writeContext: await buildMetaBudgetWriteContextForProposal({
              businessId: input.businessId,
              providerAccountId: input.providerAccountId,
            }),
          }),
        );
        const lifecycle = await runClaimedProposalExecution({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          proposal: runtimeInput.proposal,
          claimToken: claim.claimToken,
          actorUserId: input.access.session.user.id,
          executionKind: "manual",
          markDispatchStarted: async (marked) =>
            Boolean(await markMetaAutomationProposalDispatchStarted({
              businessId: marked.businessId,
              proposalId: marked.proposalId,
              claimToken: marked.claimToken,
            }).catch(() => null)),
          settle: async (settleInput) => settleMetaAutomationProposal({
            businessId: settleInput.businessId,
            proposalId: settleInput.proposalId,
            status: settleInput.status,
            decidedBy: settleInput.decidedBy,
            decisionNote: null,
            receipt: settleInput.receipt,
            claimToken: settleInput.claimToken,
          }),
          forceReconcile: (reconcileInput) =>
            forceMetaAutomationProposalReconcile(reconcileInput),
          recordReconciliation: async ({ proposal, claimToken, receipt }) => {
            const recorded = await appendMetaAutomationReconciliationReceipt({
              businessId: proposal.businessId,
              proposalId: proposal.id,
              providerAccountId: proposal.providerAccountId,
              decisionKey: proposal.decisionKey,
              proposedAction: proposal.proposedAction,
              claimToken,
              reason: "settle_failed_after_dispatch",
              facts: providerDispatchFacts({
                dispatchStarted: true,
                outcomeKnown: false,
                ok: false,
                dryRun: receipt.dryRun === true,
              }),
              receipt,
            });
            return recorded.status !== "unavailable";
          },
          recordLedger: async (entry) => {
            await recordProposalLedgerEntry({
              businessId: input.businessId,
              userId: input.access.session.user.id,
              activityType: entry.activityType,
              severity: entry.severity,
              message: entry.message,
              payload: entry.payload,
              proposal: runtimeInput.proposal,
              resultStatus: entry.severity === "success" ? "applied" : "failed",
            }).catch(() => undefined);
          },
          execute: async (beforeProviderPost) => runtime({
            proposal: runtimeInput.proposal,
            dryRunOnly: runtimeInput.dryRunOnly,
            claimToken: runtimeInput.claimToken,
            authorization: {
              kind: "manual",
              explicitConfirmation:
                input.manualConfirmation === MANUAL_CONFIRMATION,
              operatorUserId: input.access.session.user.id,
            },
            beforeProviderPost,
          }),
        });
        budgetLifecycle = lifecycle;
        return {
          ok: lifecycle.ok,
          receipt: lifecycle.receipt,
          reconcile: lifecycle.reconcile,
          rollbackRequested: false,
          journalId: lifecycle.journalId,
        };
      },
    });
  } catch (error) {
    // The dispatch was entered and produced no answer. That is not a failure
    // and it is certainly not a success: a pause may be live in Meta. The row
    // goes to `reconcile` and the response says so.
    ambiguous = true;
    execution = {
      ok: false,
      receipt: {
        httpStatus: 0,
        response: { error: { message: sanitizeErrorMessage(error) } },
        dryRun: dryRunOnly,
        dispatchedAt: new Date().toISOString(),
        endpoint: null,
        withheld: null,
        receiptKey: claim.claimToken,
        ambiguous: true,
      },
    };
  }

  // Everything below this line runs AFTER the provider has been reached. The
  // dispatch is not repeatable and is never repeated: `executeMetaAutomation
  // Proposal` is called exactly once, above, and no path from here calls it
  // again.
  const settledStatus = ambiguous
    ? "reconcile"
    : execution.ok
      ? "approved"
      : "failed";

  // The three facts, derived once, so the ledger row, the response envelope and
  // the reconciliation receipt cannot disagree about the same attempt.
  const facts = providerDispatchFacts({
    dispatchStarted: true,
    outcomeKnown: !ambiguous,
    ok: execution.ok,
    dryRun: execution.receipt.dryRun === true,
  });

  let settled: MetaAutomationProposal | null = null;
  let settleThrew: unknown = null;
  const lifecycle = budgetLifecycle as
    | Awaited<ReturnType<typeof runClaimedProposalExecution>>
    | null;
  if (lifecycle) {
    /*
      Already settled and already ledgered, by the one lifecycle both the
      manual route and the scheduled sweep enter. Settling again would move the
      row a second time and write a second ledger row for one attempt.
    */
    if (lifecycle.settlementFailed) {
      const postDispatch = lifecycle.providerDispatchStarted;
      const anythingDurable = lifecycle.reconciliationHeld
        || lifecycle.reconciliationRecorded;
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: postDispatch
              ? anythingDurable
                ? "proposal_reconciliation_required"
                : "reconciliation_recording_failed"
              : "proposal_claim_lost",
            message: postDispatch
              ? anythingDurable
                ? "This approval reached Meta but its terminal proposal row could not be recorded. It was not reported as applied and must be reconciled before any retry."
                : "This approval reached Meta, but neither the terminal proposal row nor the reconciliation record could be persisted. Use the receipt key below to reconcile before any retry."
              : "The proposal claim could not be settled. Nothing reached Meta; read the fresh queue state before retrying.",
          },
          receipt: lifecycle.receipt,
          receiptKey: claim.claimToken,
          proposalStatus: postDispatch
            ? lifecycle.reconciliationHeld ? "reconcile" : "claimed"
            : null,
          reconciliation: {
            required: postDispatch,
            held: lifecycle.reconciliationHeld,
            recorded: lifecycle.reconciliationRecorded,
            errorCode: postDispatch && !lifecycle.reconciliationRecorded
              ? "reconciliation_receipt_write_failed"
              : null,
          },
          providerDispatchIntentMarked: lifecycle.providerDispatchIntentMarked,
          providerDispatchStarted: lifecycle.providerDispatchStarted,
          providerOutcomeKnown: lifecycle.providerOutcomeKnown,
          providerWriteVerified: false,
        },
        { status: postDispatch ? anythingDurable ? 502 : 500 : 409 },
      );
    }
    return queueResponse({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      extra: {
        proposal: lifecycle.settled,
        receipt: execution.receipt,
        receiptKey: claim.claimToken,
        proposalStatus: lifecycle.settledStatus,
        providerDispatchIntentMarked: lifecycle.providerDispatchIntentMarked,
        providerDispatchStarted: lifecycle.providerDispatchStarted,
        providerOutcomeKnown: lifecycle.providerOutcomeKnown,
        providerWriteVerified:
          lifecycle.providerOutcomeKnown && lifecycle.ok
          && execution.receipt.dryRun !== true,
      },
    });
  }
  try {
    settled = await settleMetaAutomationProposal({
      businessId: input.businessId,
      proposalId: input.proposal.id,
      status: settledStatus,
      decidedBy: input.access.session.user.id,
      decisionNote: null,
      receipt: execution.receipt,
      claimToken: claim.claimToken,
    });
  } catch (error) {
    // THE post-dispatch settle exception.
    //
    // The provider answered and the write that had to record its answer threw.
    // This used to fall through to the POST handler's generic catch, which
    // returned `proposal_action_failed` with a 500 — a sentence an operator
    // reads as "nothing happened" — while the ledger was never attempted and the
    // receipt existed only in this dead request's memory.
    //
    // It is caught here, separately, because it is a different fact from the
    // dispatch failing: the outcome may be KNOWN to this process and merely
    // unrecorded. Either way it is not a success, the provider is not called
    // again, and the row must not be left claimable.
    settleThrew = error;
  }

  if (settleThrew !== null) {
    return await recordPostDispatchSettleFailure({
      access: input.access,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      proposal: input.proposal,
      claimToken: claim.claimToken,
      receipt: execution.receipt,
      // The provider answered, but this request could not record it. Whether
      // that answer survived anywhere durable is exactly what is unknown, so
      // the facts written to the outbox report the outcome as NOT established.
      facts: providerDispatchFacts({
        dispatchStarted: true,
        outcomeKnown: false,
        ok: false,
        dryRun: execution.receipt.dryRun === true,
      }),
      error: settleThrew,
    });
  }

  // Losing here is no longer a race with another approval — the claim made that
  // impossible — so it can only mean the claim was swept out from under this
  // request. The outcome is still recorded in the ledger, because a dispatch
  // nobody can see is worse than the bookkeeping that lost it.
  const lostTheRow = !settled;

  const ledger = await recordProposalLedgerEntry({
    businessId: input.businessId,
    userId: input.access.session.user.id,
    activityType: ambiguous
      ? "automation_proposal_reconcile"
      : execution.ok
        ? "automation_proposal_approved"
        : "automation_proposal_failed",
    severity: execution.ok && !ambiguous ? "success" : "danger",
    message: `${
      ambiguous
        ? `Proposal outcome unknown — ${input.proposal.actionLabel} on ${input.proposal.entityLabel ?? input.proposal.scopeId} was dispatched and no result came back. Reconcile against Meta before retrying.`
        : execution.ok
          ? `Proposal approved — ${input.proposal.actionLabel} on ${input.proposal.entityLabel ?? input.proposal.scopeId}${execution.receipt.dryRun ? " (dry run, per the dryRunOnly guardrail)" : ""}.`
          : `Proposal approval did not land — ${input.proposal.actionLabel} on ${input.proposal.entityLabel ?? input.proposal.scopeId}.`
    }${
      lostTheRow
        ? " The claim on this proposal was released before the outcome could be recorded against it, so this outcome is recorded after the fact."
        : ""
    }`,
    payload: {
      proposalId: input.proposal.id,
      // The auditable link. One key, present on the queue row, on this ledger
      // row and inside the receipt envelope the response returns.
      receiptKey: claim.claimToken,
      recId: input.proposal.recId,
      decisionKey: input.proposal.decisionKey,
      providerAccountId: input.proposal.providerAccountId,
      receipt: execution.receipt,
      // Three fields, never one boolean.
      //
      // This row used to carry `providerWrite: !ambiguous && !dryRun`, so a row
      // whose own message says "was dispatched and no result came back" was
      // written to the ledger as `providerWrite: false` — indistinguishable, to
      // any reader, filter or aggregate, from "nothing was sent". An unknown
      // outcome is not a negative one. `providerWriteVerified: false` beside
      // `providerOutcomeKnown: false` is the honest pair; read either alone and
      // you have not read the record.
      ...facts,
    },
    proposal: input.proposal,
    // A dry run is not an application. `dryRunOnly` defaults to true in both the
    // code and the column, and nothing in the tree ever writes guardrails_json,
    // so in the only configuration production can reach every approval
    // short-circuits before the provider POST and returns receipt.dryRun.
    // Stamping those "applied" put a green chip and the word Applied in the
    // ledger under a footnote promising a receipt, for a write that never left
    // the building. `recorded` is what actually happened, and it is already in
    // the status vocabulary and the column's CHECK constraint.
    //
    // An ambiguous dispatch is `failed` for the same reason in reverse: the one
    // thing it must never render as is the green Applied chip.
    resultStatus: ambiguous
      ? "failed"
      : execution.ok
        ? execution.receipt.dryRun
          ? "recorded"
          : "applied"
        : "failed",
  });

  if (ambiguous) {
    // The durable half. The proposal row already says `reconcile`, but that row
    // alone cannot tell an operator WHICH attempt is unresolved or hand them a
    // receipt to reconcile against; the outbox row is keyed by the claim token
    // and is append-only, so the attempt's facts survive whatever happens next.
    const outbox = await appendMetaAutomationReconciliationReceipt({
      businessId: input.businessId,
      proposalId: input.proposal.id,
      providerAccountId: input.proposal.providerAccountId,
      decisionKey: input.proposal.decisionKey,
      proposedAction: input.proposal.proposedAction,
      claimToken: claim.claimToken,
      reason: "dispatch_no_answer",
      facts,
      receipt: execution.receipt,
    });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "proposal_outcome_unknown",
          message:
            "This approval was dispatched and no provider result came back, so whether it paused anything is unknown. The proposal is held for reconciliation and was NOT recorded as applied.",
        },
        receipt: execution.receipt,
        receiptKey: claim.claimToken,
        proposalStatus: settled?.status ?? "reconcile",
        reconciliation: {
          required: true,
          recorded: outbox.status !== "unavailable",
          // Named, not implied. If the outbox write failed too, the only
          // durable trace is the queue row's own claim token, and the operator
          // is told that rather than shown a receipt that does not exist.
          errorCode:
            outbox.status === "unavailable"
              ? "reconciliation_receipt_write_failed"
              : null,
        },
        ...facts,
        ...ledger,
      },
      { status: 502 },
    );
  }

  if (lostTheRow) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "proposal_claim_lost",
          message: execution.receipt.dryRun
            ? "This proposal's claim was released before the outcome could be recorded. Nothing reached Meta: the dryRunOnly guardrail held this approval inside the building."
            : "This proposal's claim was released before the outcome could be recorded — but this approval had already been dispatched to Meta. The receipt below is what this request sent; check the activity ledger before retrying.",
        },
        // Never withheld. A dispatch the operator cannot see is worse than the
        // race that caused it.
        receipt: execution.receipt,
        receiptKey: claim.claimToken,
        ...ledger,
      },
      { status: 409 },
    );
  }

  return queueResponse({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    extra: {
      proposal: settled,
      receipt: execution.receipt,
      receiptKey: claim.claimToken,
      ...ledger,
    },
  });
}

/**
 * The provider answered; the write that had to record it did not.
 *
 * This is the narrowest, least-dependent path in the file, because it runs on a
 * database that has just proven it can fail. In order, and each step
 * independent of the last:
 *
 * 1. **The provider is NOT called again.** There is no dispatch in this
 *    function and no caller re-enters one. A create/duplicate/pause POST has no
 *    provider idempotency key bound to a durable per-attempt receipt here, so
 *    it has no retry at all.
 * 2. **The claim moves to `reconcile`** through a statement that shares nothing
 *    with the settle that just failed — no receipt marshalling, no jsonb, no
 *    decided_by. If even that cannot land, the row stays `claimed` with
 *    `dispatch_started_at` set, which `claimMetaAutomationProposal` (guarded on
 *    `status = 'pending'`) refuses to re-claim and the stale-claim sweep later
 *    resolves to `reconcile` on its own. Either way the proposal cannot be
 *    dispatched again.
 * 3. **The receipt and claim token are appended to the durable outbox**, keyed
 *    by the claim token, in one INSERT of already-serialized values.
 * 4. **The ledger is attempted** — attempted, not required. It is the second
 *    copy.
 *
 * The response is never a success and never a bare 500. If anything durable
 * landed, it is `proposal_reconciliation_required`. If the database is entirely
 * unavailable — nothing moved, nothing appended, nothing logged — it is
 * `reconciliation_recording_failed`, which says out loud that a provider
 * dispatch exists with NO durable record of it, and hands the operator the
 * claim token and receipt in the response body because that is then the only
 * copy that exists.
 */
async function recordPostDispatchSettleFailure(input: {
  access: Access;
  businessId: string;
  providerAccountId: string;
  proposal: MetaAutomationProposal;
  claimToken: string;
  receipt: MetaAutomationProposalReceipt;
  facts: MetaAutomationProviderDispatchFacts;
  error: unknown;
}) {
  const heldForReconcile = await forceMetaAutomationProposalReconcile({
    businessId: input.businessId,
    proposalId: input.proposal.id,
    claimToken: input.claimToken,
  });

  const outbox = await appendMetaAutomationReconciliationReceipt({
    businessId: input.businessId,
    proposalId: input.proposal.id,
    providerAccountId: input.proposal.providerAccountId,
    decisionKey: input.proposal.decisionKey,
    proposedAction: input.proposal.proposedAction,
    claimToken: input.claimToken,
    reason: "settle_failed_after_dispatch",
    facts: input.facts,
    receipt: input.receipt,
  });

  const ledger = await recordProposalLedgerEntry({
    businessId: input.businessId,
    userId: input.access.session.user.id,
    activityType: "automation_proposal_reconcile",
    severity: "danger",
    message:
      `Proposal outcome unrecorded — ${input.proposal.actionLabel} on ${input.proposal.entityLabel ?? input.proposal.scopeId} was dispatched and the write that had to record its result failed. ` +
      `Reconcile against Meta using receipt key ${input.claimToken} before retrying; this approval was NOT recorded as applied.`,
    payload: {
      proposalId: input.proposal.id,
      receiptKey: input.claimToken,
      recId: input.proposal.recId,
      decisionKey: input.proposal.decisionKey,
      providerAccountId: input.proposal.providerAccountId,
      receipt: input.receipt,
      settleError: sanitizeErrorMessage(input.error),
      reconciliationHeld: heldForReconcile,
      reconciliationRecorded: outbox.status !== "unavailable",
      ...input.facts,
    },
    proposal: input.proposal,
    // Never `applied`. The one thing this outcome must not render as is the
    // green Applied chip, and `recorded` would claim bookkeeping that failed.
    resultStatus: "failed",
  });

  const anythingDurable =
    heldForReconcile ||
    outbox.status !== "unavailable" ||
    ledger.ledgerCompleteness === "complete";

  if (!anythingDurable) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "reconciliation_recording_failed",
          message:
            "This approval was dispatched to Meta and NOTHING about it could be recorded: the proposal could not be moved, the reconciliation receipt could not be written, and the activity ledger refused too. The receipt and receipt key below are the only copy that exists — reconcile against Meta before any retry.",
        },
        receipt: input.receipt,
        receiptKey: input.claimToken,
        proposalStatus: null,
        reconciliation: {
          required: true,
          recorded: false,
          errorCode: "reconciliation_receipt_write_failed",
        },
        ...input.facts,
        ...ledger,
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "proposal_reconciliation_required",
        message:
          "This approval was dispatched to Meta and the write that had to record its result failed, so whether it landed is unknown. The proposal is held for reconciliation and was NOT recorded as applied; nothing was re-sent.",
      },
      receipt: input.receipt,
      receiptKey: input.claimToken,
      proposalStatus: heldForReconcile ? "reconcile" : "claimed",
      reconciliation: {
        required: true,
        recorded: outbox.status !== "unavailable",
        errorCode:
          outbox.status === "unavailable"
            ? "reconciliation_receipt_write_failed"
            : null,
      },
      ...input.facts,
      ...ledger,
    },
    { status: 502 },
  );
}

/**
 * The loser's answer — one code, whatever the winner is doing right now.
 *
 * Deterministic on purpose: the refusal must not depend on how far the winning
 * request happened to get, so the code is always `proposal_claim_conflict` and
 * the row's ACTUAL state travels beside it. `proposalStatus` is `claimed` while
 * the winner is dispatching and `approved`/`failed`/`reconcile` once it has
 * settled, and `receipt` is the winner's receipt whenever one exists yet.
 */
function claimConflictResponse(current: MetaAutomationProposal | null) {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "proposal_claim_conflict",
        message:
          current?.status === "claimed"
            ? "Another approval already holds this proposal and is dispatching it. Nothing was sent from this request; its outcome will appear in the activity ledger."
            : "This proposal was already decided by another action, so nothing was dispatched from this request.",
      },
      proposalStatus: current?.status ?? null,
      receipt: current?.receipt ?? null,
      receiptKey: current?.claimToken ?? null,
    },
    { status: 409 },
  );
}

/**
 * Every outcome lands in the ledger — with the tuple the screen renders, and
 * with an answer when it does NOT land.
 *
 * This delegates to the control plane's single ledger writer rather than
 * repeating its INSERT, which is the whole point: the hand-rolled copy here
 * named only the six pre-tuple columns, so `actor_kind`, `entity_type`,
 * `entity_id` and `result_status` were left NULL on every proposal decision.
 * The ledger's SELECT already reads all four, so the Activity ledger showed an
 * em dash under Actor, Entity and Result for rows whose writer knew each one.
 *
 * The entity is the proposal's own scope (`campaign`/`adset` plus its id) — the
 * thing the decision was about. The receipt id column stays null because it
 * drives the rendered `Receipt <id>` chip and expects a PROVIDER entity id; the
 * attempt's receipt key travels in `payload.receiptKey`, where it is queryable
 * jsonb and joins the ledger row to the queue row and to the receipt envelope
 * without putting a claim uuid inside a design caption that promises a provider
 * receipt.
 *
 * **The failure is returned, not swallowed.** It used to end in
 * `.catch(() => undefined)` under a footnote reading "every outcome lands in
 * the ledger with a receipt" — so a failed INSERT produced a screen that
 * promised an audit trail it did not have. There is no retry here on purpose:
 * this function runs AFTER the provider result exists, and a retry loop around
 * it can only ever duplicate bookkeeping, never recover a write. The durable
 * record of the outcome is the proposal row itself (status + `receipt_json` +
 * `claim_token`, all written in the same database); the ledger is the second
 * copy, and its absence is reported rather than hidden.
 */
async function recordProposalLedgerEntry(input: {
  businessId: string;
  userId: string;
  activityType: string;
  severity: "info" | "warning" | "danger" | "success";
  message: string;
  payload: Record<string, unknown>;
  proposal: MetaAutomationProposal;
  resultStatus: MetaAutomationActivityResultStatus;
}): Promise<{
  ledgerCompleteness: "complete" | "unavailable";
  ledgerErrorCode: string | null;
}> {
  try {
    await writeActivityLedgerRow({
      businessId: input.businessId,
      activityType: input.activityType,
      severity: input.severity,
      message: input.message,
      payload: input.payload,
      userId: input.userId,
      actorKind: "operator",
      entityType: input.proposal.scopeType,
      entityId: input.proposal.scopeId,
      resultStatus: input.resultStatus,
      resultReceiptId: null,
    });
    return { ledgerCompleteness: "complete", ledgerErrorCode: null };
  } catch {
    return {
      ledgerCompleteness: "unavailable",
      ledgerErrorCode: "activity_ledger_write_failed",
    };
  }
}
