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
import { getDb } from "@/lib/db";
import { executeMetaAutomationProposal } from "@/lib/meta/automation-proposal-execution";
import {
  META_AUTOMATION_PROPOSAL_ACTIONS,
  evaluateProposalTransition,
  readMetaAutomationProposal,
  readMetaAutomationProposalQueue,
  settleMetaAutomationProposal,
  type MetaAutomationProposal,
  type MetaAutomationProposalAction,
  META_AUTOMATION_PROPOSALS_CONTRACT,
} from "@/lib/meta/automation-proposals";
import { getMetaAutomationControlPlane } from "@/lib/meta/automation-control-plane";
import { rejectIfMetaWritesBlocked } from "@/lib/meta/automation-write-guard";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { resolveMetaCreativesAccountScope } from "@/lib/meta/creatives-warehouse";
import { MANUAL_CONFIRMATION } from "@/lib/zero-base/meta/dispatch-contract";
import { confirmationFor } from "@/lib/zero-base/meta/mutation-ceremony";

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

async function queueResponse(input: {
  businessId: string;
  providerAccountId: string;
  extra?: Record<string, unknown>;
}) {
  const queue = await readMetaAutomationProposalQueue({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  return NextResponse.json({
    ok: true,
    contractVersion: META_AUTOMATION_PROPOSALS_CONTRACT,
    providerAccountId: input.providerAccountId,
    readCompleteness: { proposals: queue.readCompleteness },
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

  const settled = await settleMetaAutomationProposal({
    businessId: input.businessId,
    proposalId: input.proposal.id,
    status: next,
    decidedBy: input.access.session.user.id,
    decisionNote: note || null,
    receipt: null,
  });
  if (!settled) {
    return jsonError(
      409,
      "proposal_not_pending",
      "This proposal was decided by another action before this one landed.",
    );
  }

  await recordProposalLedgerEntry({
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
      providerWrite: false,
    },
  });

  return queueResponse({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    extra: { proposal: settled },
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
  if (control.businessControl.readinessTier !== "manual_review") {
    return jsonError(
      409,
      "supervision_tier_mismatch",
      "The confirmation queue executes only under the Tier 1 supervised readiness tier.",
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

  const dryRunOnly = control.businessControl.guardrails.dryRunOnly === true;
  const execution = await executeMetaAutomationProposal({
    request: input.request,
    businessId: input.businessId,
    proposal: input.proposal,
    dryRunOnly,
  });

  const settled = await settleMetaAutomationProposal({
    businessId: input.businessId,
    proposalId: input.proposal.id,
    status: execution.ok ? "approved" : "failed",
    decidedBy: input.access.session.user.id,
    decisionNote: null,
    receipt: execution.receipt,
  });
  if (!settled) {
    return jsonError(
      409,
      "proposal_not_pending",
      "This proposal was decided by another action before this one landed.",
    );
  }

  await recordProposalLedgerEntry({
    businessId: input.businessId,
    userId: input.access.session.user.id,
    activityType: execution.ok
      ? "automation_proposal_approved"
      : "automation_proposal_failed",
    severity: execution.ok ? "success" : "danger",
    message: execution.ok
      ? `Proposal approved — ${input.proposal.actionLabel} on ${input.proposal.entityLabel ?? input.proposal.scopeId}${execution.receipt.dryRun ? " (dry run, per the dryRunOnly guardrail)" : ""}.`
      : `Proposal approval did not land — ${input.proposal.actionLabel} on ${input.proposal.entityLabel ?? input.proposal.scopeId}.`,
    payload: {
      proposalId: input.proposal.id,
      recId: input.proposal.recId,
      decisionKey: input.proposal.decisionKey,
      providerAccountId: input.proposal.providerAccountId,
      receipt: execution.receipt,
      providerWrite: true,
    },
  });

  return queueResponse({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    extra: { proposal: settled, receipt: execution.receipt },
  });
}

/**
 * Every outcome lands in the ledger.
 *
 * Written with the same statement shape the control plane already uses for
 * kill-switch events, so the Activity ledger on this screen reads proposal
 * outcomes through its existing `automation_ledger` source with no new reader.
 */
async function recordProposalLedgerEntry(input: {
  businessId: string;
  userId: string;
  activityType: string;
  severity: "info" | "warning" | "danger" | "success";
  message: string;
  payload: Record<string, unknown>;
}) {
  const sql = getDb();
  await sql`
    INSERT INTO meta_automation_activity_ledger (
      business_id,
      activity_type,
      severity,
      message,
      payload_json,
      created_by
    )
    VALUES (
      ${input.businessId},
      ${input.activityType},
      ${input.severity},
      ${input.message},
      ${JSON.stringify(input.payload)}::jsonb,
      ${input.userId}
    )
  `.catch(() => undefined);
}
