/**
 * Turn on what a launch intent created.
 *
 * A launch intent may only create PAUSED entities — the table's own CHECK says
 * so — which means the launch receipt is not a publication. Something has to
 * activate them, and that something is a separate call with its own
 * authorization, because "make this, switched off" and "put this in front of
 * people, spending money" are not the same decision.
 *
 * The response reports the sequence step by step. A campaign that came on and
 * an ad set that did not is a real, ordinary outcome, and the operator has to
 * be able to read exactly that rather than a single ok/failed word — an ad
 * whose own status is ACTIVE under a paused parent shows to nobody, and the
 * one thing this route must never do is call that live.
 */
import { NextRequest, NextResponse } from "next/server";

import { getMetaLaunchIntent } from "@/lib/launchpad/meta-launch-intent-store";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
  resolveMetaLaunchWriteContext,
} from "@/lib/launchpad/meta-validation";
import { activateLaunchIntent } from "@/lib/meta/launch-intent-activation";
import {
  metaWriteBlockedResponse,
  readMetaWritePosture,
} from "@/lib/meta/automation-write-guard";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../../../route-utils";
import { rejectIfLaunchpadDemoWrite } from "../../../demo-write-authority";

export const dynamic = "force-dynamic";

type ActivateBody = {
  businessId?: string;
  actionOrigin?: string;
  manualConfirmation?: string;
};

/** The same two words every other manual Meta write compares character for character. */
const MANUAL_ACTION_ORIGIN = "manual_operator_v1";
const MANUAL_CONFIRMATION = "explicit_operator_confirmation";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ intentId: string }> },
) {
  const { intentId } = await context.params;
  const body = await readJsonBody<ActivateBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;

  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(
    access,
    "launchpad_activate_intent",
  );
  if (reviewerBlocked) return reviewerBlocked;
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_activate_intent",
  );
  if (demoBlocked) return demoBlocked;

  /*
    The operator's own confirmation, stated rather than inferred.

    This route acts under `kind: "operator"`, which skips the stored activation
    approval entirely — so the confirmation that replaces it has to be present
    and exact. A request without it is not an operator decision.
  */
  if (
    body?.actionOrigin !== MANUAL_ACTION_ORIGIN
    || body?.manualConfirmation !== MANUAL_CONFIRMATION
  ) {
    return jsonError(
      400,
      "manual_confirmation_absent",
      "Activation requires the operator action origin and explicit confirmation.",
    );
  }

  const intent = await getMetaLaunchIntent({
    businessId: access.businessId,
    id: intentId?.trim() ?? "",
  }).catch(() => null);
  if (!intent) {
    return jsonError(404, "launch_intent_not_found", "No such launch intent.");
  }

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: intent.providerAccountId,
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }
  const writeContext = await resolveMetaLaunchWriteContext(
    access.businessId,
    intent.providerAccountId,
  );
  if (!writeContext.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(writeContext.blocker.code),
      writeContext.blocker.code,
      writeContext.blocker.message,
    );
  }

  /*
    The posture, before anything is composed.

    Activation is a status write like any other, so it answers to the same
    capability, readiness tier, STOP and rehearsal the rest of the product
    answers to. Rehearsal REFUSES here rather than downgrading: an activation
    that did not activate is not a rehearsal an operator can read — the whole
    value of the step is the effective status coming back ACTIVE.
  */
  const posture = await readMetaWritePosture({ businessId: access.businessId });
  if (posture.blocked) return metaWriteBlockedResponse(posture);
  if (posture.rehearsal) {
    return jsonError(
      409,
      "dry_run_guardrail",
      "This business is in rehearsal, so nothing was activated on Meta.",
    );
  }

  try {
    const result = await activateLaunchIntent({
      intent,
      ctx: writeContext.ctx,
      authorization: {
        kind: "operator",
        operatorUserId: access.session.user.id,
      },
      /*
        Re-read before EVERY step's own write, not once for the request.

        The sequence makes up to three provider calls. An operator can engage
        the STOP between the campaign and the ad set, and this is the only
        place that can still act on it — a check at the top of the route would
        describe a posture that has since changed.
      */
      authorize: async () => {
        const step = await readMetaWritePosture({ businessId: access.businessId });
        if (step.blocked) return step.reason ?? "kill_switch_engaged";
        // Rehearsal engaged between two steps stops the sequence where it is,
        // rather than silently finishing a hierarchy the operator has just
        // said should not reach Meta.
        if (step.rehearsal) return "dry_run_guardrail";
        return null;
      },
    });

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: { code: result.refusal, message: refusalMessage(result.refusal) } },
        { status: 409 },
      );
    }

    const { activation } = result;
    return NextResponse.json({
      ok: true,
      contract: activation.contract,
      intentId: intent.id,
      // The word the surface renders. Never derived from the ad alone.
      delivering: activation.delivering,
      blockedAt: activation.blockedAt,
      blockedReason: activation.blockedReason,
      steps: activation.steps,
    });
  } catch (error) {
    return jsonError(500, "activation_failed", sanitizeErrorMessage(error));
  }
}

function refusalMessage(code: string): string {
  switch (code) {
    case "intent_not_succeeded":
      return "This launch did not create anything that can be activated.";
    case "receipt_absent":
      return "This intent has no receipt, so there is nothing to activate.";
    case "no_activatable_entities":
      return "The receipt names no entity this activation may turn on.";
    default:
      return "The stored activation approval does not authorize this activation.";
  }
}
