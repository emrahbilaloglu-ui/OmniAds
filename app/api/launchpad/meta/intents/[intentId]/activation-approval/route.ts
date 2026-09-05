/**
 * Record, or revoke, the approval that lets an activation run unattended.
 *
 * `activation_approval_json` had a migration and a validator and no writer, so
 * the column was permanently NULL, every scheduled activation refused with
 * `activation_approval_absent`, and the only way to turn anything on was an
 * operator pressing Activate. That was a safe state and not an implemented one.
 *
 * This is the operator's own act, and it is deliberately separate from
 * activating: approving says "this exact payload may be turned on later,
 * without me", which is a different decision from "turn it on now". It is also
 * separate from creating — an intent may only ever create PAUSED entities, and
 * that CHECK is what keeps the two apart.
 *
 * Almost nothing here comes from the request. The payload fingerprint, the
 * operation, the destination and the creative are read from the live intent and
 * its receipt, so an approval can only ever name what this launch actually
 * produced. What the operator supplies is what is genuinely theirs: the scope,
 * the copy they reviewed, and how long it stands.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  getMetaLaunchIntent,
  recordMetaLaunchIntentActivationApproval,
} from "@/lib/launchpad/meta-launch-intent-store";
import {
  buildActivationApproval,
  revokeActivationApproval,
  type ActivationApproval,
} from "@/lib/meta/launch-activation-approval";
import { ACTIVATION_POLICY_VERSION } from "@/lib/meta/launch-intent-activation";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../../route-utils";
import { rejectIfLaunchpadDemoWrite } from "../../../demo-write-authority";

export const dynamic = "force-dynamic";

/** The same two words every other manual Meta write compares exactly. */
const MANUAL_ACTION_ORIGIN = "manual_operator_v1";
const MANUAL_CONFIRMATION = "explicit_operator_confirmation";

/** A day. Long enough to be useful, short enough that a stale one lapses. */
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 24 * 7;

type ApprovalBody = {
  businessId?: string;
  actionOrigin?: string;
  manualConfirmation?: string;
  approvedScope?: string;
  approvedAssetVersion?: string;
  approvedCopyHash?: string;
  ttlHours?: number;
  /** Pass true to withdraw a standing approval. Nothing else is then read. */
  revoke?: boolean;
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ intentId: string }> },
) {
  const { intentId } = await context.params;
  const body = await readJsonBody<ApprovalBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(
    access,
    "launchpad_approve_activation",
  );
  if (reviewerBlocked) return reviewerBlocked;
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_approve_activation",
  );
  if (demoBlocked) return demoBlocked;

  /*
    No release gate here, on purpose.

    Writing an approval reaches no provider and starts no spending; the
    activation it authorizes does, and that path reads the gate for itself.
    Gating the approval too would mean an operator could not prepare one while
    a deployment was still closed, which is exactly when preparing is useful.
  */
  if (
    body?.actionOrigin !== MANUAL_ACTION_ORIGIN
    || body?.manualConfirmation !== MANUAL_CONFIRMATION
  ) {
    return jsonError(
      400,
      "manual_confirmation_absent",
      "Recording an activation approval requires the operator action origin and explicit confirmation.",
    );
  }

  const intent = await getMetaLaunchIntent({
    businessId: access.businessId,
    id: intentId?.trim() ?? "",
  }).catch(() => null);
  if (!intent) {
    return jsonError(404, "launch_intent_not_found", "No such launch intent.");
  }

  try {
    if (body?.revoke === true) {
      /*
        Revoking rewrites the stored document with `revokedAt` set rather than
        clearing the column. The validator already refuses a revoked approval,
        and keeping it means the record still says who approved what, and when
        it was withdrawn.
      */
      const stored = intent.activationApproval as ActivationApproval | null;
      const updated = await recordMetaLaunchIntentActivationApproval({
        businessId: access.businessId,
        id: intent.id,
        approval: stored
          ? revokeActivationApproval(stored, new Date().toISOString())
          : null,
      });
      return NextResponse.json({
        ok: true,
        intentId: updated.id,
        approval: updated.activationApproval,
        revoked: true,
      });
    }

    const scope = body?.approvedScope === "hierarchy" ? "hierarchy" : "ad";
    const receipt =
      intent.resultReceipt ?? intent.errorReceipt?.partialResult ?? null;
    if (!receipt) {
      return jsonError(
        409,
        "receipt_absent",
        "This intent has no receipt, so there is nothing an approval could name.",
      );
    }
    const ttlHours = Number.isFinite(body?.ttlHours)
      ? Math.min(Math.max(Number(body!.ttlHours), 1), MAX_TTL_HOURS)
      : DEFAULT_TTL_HOURS;
    const approvedAt = new Date();
    const built = buildActivationApproval({
      intent: {
        id: intent.id,
        businessId: intent.businessId,
        providerAccountId: intent.providerAccountId,
        operation: intent.operation,
        requestFingerprint: intent.requestFingerprint,
      },
      identities: {
        campaignId: receipt.campaignId ?? null,
        adsetId: receipt.adsetIds?.[0] ?? null,
        adIds: receipt.adIds ?? [],
        creativeId: readCreativeId(intent),
      },
      approvedScope: scope,
      approvedBy: access.session.user.id,
      approvedAt: approvedAt.toISOString(),
      expiresAt: new Date(
        approvedAt.getTime() + ttlHours * 60 * 60 * 1000,
      ).toISOString(),
      approvedAssetVersion: body?.approvedAssetVersion?.trim() || "v1",
      approvedCopyHash: body?.approvedCopyHash?.trim() ?? "",
      policyVersion: ACTIVATION_POLICY_VERSION,
    });
    if (!built.ok) {
      return jsonError(409, built.refusal, refusalMessage(built.refusal));
    }

    const updated = await recordMetaLaunchIntentActivationApproval({
      businessId: access.businessId,
      id: intent.id,
      approval: built.approval,
    });
    return NextResponse.json({
      ok: true,
      intentId: updated.id,
      approval: updated.activationApproval,
      revoked: false,
    });
  } catch (error) {
    return jsonError(500, "activation_approval_failed", sanitizeErrorMessage(error));
  }
}

/** The creative the launch used, from its own request payload. */
function readCreativeId(intent: { requestPayload: unknown }): string | null {
  const payload = intent.requestPayload as Record<string, unknown> | null;
  const direct = payload?.creativeId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const reuse = payload?.reuseCreative as { creativeId?: unknown } | undefined;
  if (typeof reuse?.creativeId === "string" && reuse.creativeId.trim()) {
    return reuse.creativeId.trim();
  }
  return null;
}

function refusalMessage(code: string): string {
  switch (code) {
    case "activation_approval_scope_mismatch":
      return "Only a launch that created its own campaign may be approved for hierarchy activation.";
    case "activation_approval_asset_mismatch":
      return "An approval must name the creative and the copy it approved.";
    case "activation_approval_destination_mismatch":
      return "The receipt names no destination this approval could authorize.";
    case "activation_approval_approver_absent":
      return "An approval must name the person who gave it.";
    default:
      return "The activation approval could not be recorded as stated.";
  }
}
