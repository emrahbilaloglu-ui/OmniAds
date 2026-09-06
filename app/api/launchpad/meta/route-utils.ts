import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getMetaWriteBlockState } from "@/lib/meta/automation-control-plane";
import {
  LAUNCHPAD_EXECUTION_SAFETY_INCOMPLETE_REASON,
  META_GATE_REFUSAL_REASONS,
} from "@/lib/meta/release-gate-copy";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
import { missingSteps, writeFamily } from "@/lib/meta/write-safety-contract";
import type { MembershipRole } from "@/lib/auth";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import {
  metaLaunchAccountBlockerHttpStatus,
  resolveAssignedMetaLaunchAccount,
} from "@/lib/launchpad/meta-validation";

export function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(extra ?? {}) } },
    { status },
  );
}

export function sanitizeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

export async function readJsonBody<T = Record<string, unknown>>(
  request: NextRequest,
): Promise<T | null> {
  const body = (await request.json().catch(() => null)) as T | null;
  return body && typeof body === "object" ? body : null;
}

export async function requireLaunchpadBusinessAccess(input: {
  request: NextRequest;
  businessId: string | null | undefined;
}) {
  const businessId = input.businessId?.trim() ?? "";
  if (!businessId) {
    return {
      ok: false as const,
      response: jsonError(400, "missing_business_id", "businessId is required."),
    };
  }
  const access = await requireBusinessAccess({
    request: input.request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) {
    return { ok: false as const, response: access.error };
  }
  return {
    ok: true as const,
    businessId: access.membership.businessId,
    userId: access.session.user.id,
    session: access.session,
    membership: access.membership,
  };
}

/**
 * Membership AND current assignment, both proven before any warehouse read.
 *
 * `WHERE provider_account_id = $n` is a filter, not an authorization. The
 * warehouse keeps rows for every account a business has ever synced, keyed by
 * `(business_id, provider_account_id)`, so an account that was assigned last
 * month and unassigned today still has campaigns, ad sets and pixels sitting
 * under this business's id. A read that only filters therefore answers a
 * direct request for a stale — or never-assigned-but-once-synced — account
 * with real rows, and Launchpad then offers those rows as launch targets.
 *
 * The write side has proven this for a while: every mutating Launchpad route
 * goes through `resolveAssignedMetaLaunchAccount`. The reads that FEED those
 * writes did not, which is the weaker door into the same scope. This is the
 * same call, so a read and the write it precedes cannot disagree about which
 * accounts this workspace holds.
 *
 * Failure modes, in the order they are decided:
 *   - no membership            -> whatever `requireBusinessAccess` answers
 *   - assignment read failed   -> 503 `provider_account_scope_unavailable`
 *   - id not currently assigned-> 403 `provider_account_not_assigned`
 *
 * An unreadable assignment source is explicitly NOT "assigned nothing" and
 * explicitly NOT a business-wide read: failing to prove authority is not a
 * proof that authority is absent, and the honest answer is unavailable.
 *
 * No statement is issued on any refusing path.
 */
export async function requireLaunchpadAssignedAccountScope(input: {
  request: NextRequest;
  businessId: string;
  providerAccountId: string;
  minRole: MembershipRole;
}): Promise<
  | { ok: true; businessId: string; providerAccountId: string }
  | { ok: false; response: NextResponse }
> {
  const access = await requireBusinessAccess({
    request: input.request,
    businessId: input.businessId,
    minRole: input.minRole,
  });
  if ("error" in access) return { ok: false as const, response: access.error };

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.membership.businessId,
    providerAccountId: input.providerAccountId,
  });
  if (!account.ok) {
    return {
      ok: false as const,
      response: jsonError(
        metaLaunchAccountBlockerHttpStatus(account.blocker.code),
        account.blocker.code,
        account.blocker.message,
      ),
    };
  }

  return {
    ok: true as const,
    businessId: access.membership.businessId,
    providerAccountId: account.providerAccountId,
  };
}

export function rejectIfLaunchpadReviewerReadOnly(
  access: Extract<Awaited<ReturnType<typeof requireLaunchpadBusinessAccess>>, { ok: true }>,
  action: string,
) {
  return rejectIfReviewerReadOnly(access, action);
}

/**
 * The server half of the Launchpad execution gate.
 *
 * `docs/adr-003-launchpad-execution-posture.md` puts the shipped state at
 * disabled-with-reason, and the master plan's §17.6 forbids letting a client
 * guard be the only thing between an operator and a provider write. The review
 * screen renders the same refusal, but this is the one that decides: a hand-made
 * POST, a stale tab that loaded while the gate was open, and a script all reach
 * here and are refused before any account, credential or Meta call is touched.
 *
 * Returns a response when the write must not proceed, and `null` when it may.
 * Callers place it after access/reviewer/demo so the operator learns the most
 * specific true reason first — being a reviewer is a fact about them, while a
 * closed gate is a fact about the product, and the former is more useful to
 * hear. It still runs before every provider-facing step.
 *
 * `503` rather than `403`: nothing is wrong with the caller's authority, and
 * the same request will succeed unchanged once execution is enabled. A `403`
 * would tell an operator to go asking for permissions they already have.
 */
/**
 * The pure decision, separated from the readings so both branches stay
 * provable.
 *
 * The runtime gate has to keep refusing when the safety contract is incomplete
 * — that is the P1 fix — but the Launchpad family is complete today, so a test
 * driven by the real contract can no longer exercise the refusal at all. A
 * protection that cannot be tested once the thing it guards is fixed is a
 * protection that silently rots.
 *
 * So the route supplies the real gate value and the real missing-step list, and
 * this decides. A test supplies either. Nothing about the runtime path is
 * softened: `rejectIfLaunchpadExecutionGated` below reads both facts itself and
 * has no injection point.
 */
export type LaunchpadExecutionOperation =
  | "launchpad_launch"
  | "launchpad_add_to_existing"
  | "launchpad_activate_intent";

export function launchpadExecutionRefusal(input: {
  gateOpen: boolean;
  missingSafetySteps: readonly string[];
  operation: LaunchpadExecutionOperation;
}) {
  if (!input.gateOpen) {
    return jsonError(
      503,
      "launchpad_execution_disabled",
      META_GATE_REFUSAL_REASONS.launchpadExecution,
      { operation: input.operation },
    );
  }
  if (input.missingSafetySteps.length > 0) {
    return jsonError(
      503,
      "launchpad_execution_safety_incomplete",
      LAUNCHPAD_EXECUTION_SAFETY_INCOMPLETE_REASON,
      { operation: input.operation },
    );
  }
  return null;
}

export function rejectIfLaunchpadExecutionGated(
  operation: LaunchpadExecutionOperation,
) {
  const gateOpen = readMetaReleaseGates().launchpadExecution;
  /**
   * The second gate, and the one that makes the first one safe.
   *
   * P1 defect, reproduced before this was written: the release flag was the
   * whole gate, so a single runtime environment flip opened the provider-write
   * path while §10 safety steps were still declared missing — including the
   * independent provider read-back, without which a create's outcome is never
   * verified. `openGatesWithMissingSteps()` existed but was only ever called
   * from a unit test, so the claim "the gate cannot be opened while these steps
   * are missing" was true of the test suite and false of the running server.
   *
   * A build-time check, a default-off value and a passing test are all things a
   * production environment variable can step around. This is evaluated on every
   * request, in the route, so it cannot be.
   *
   * Ordering: the release flag is the cheaper refusal and answers first; both
   * land before account resolution, credential reads and any provider contact,
   * so a replayed POST against a misconfigured environment costs nothing.
   */
  /*
    Activation answers to its OWN family record.

    `launchpad_create` declares its rollback step not-applicable on the grounds
    that every create is PAUSED and nothing begins spending. Activation is the
    write that ends that, so checking it against the create's declaration would
    let it pass on a reason that is false of it.
  */
  const missing = missingSteps(writeFamily(
    operation === "launchpad_activate_intent"
      ? "launchpad_activation"
      : "launchpad_create",
  ));
  const refusal = launchpadExecutionRefusal({
    gateOpen,
    missingSafetySteps: missing,
    operation,
  });
  if (refusal && gateOpen) {
    console.error("[launchpad] execution enabled with an incomplete safety contract", {
      operation,
      missingSteps: missing,
      // No business, account or credential: this is a deployment-configuration
      // fact and must be readable without carrying a tenant identifier.
    });
  }
  return refusal;
}

/**
 * The Meta Stop, enforced on Launchpad too.
 *
 * `getMetaWriteBlockState` is the server's single answer to "may this workspace
 * write to Meta right now". Decisions and Automation both consult it; Launchpad
 * did not, so an operator who engaged the business kill switch — or an incident
 * responder who set `META_ADS_WRITE_KILL_SWITCH` — could still create campaigns,
 * ad sets and ads from Launchpad. The stop was global in the operator's mind and
 * partial in fact, which is the worst combination a safety control can have.
 *
 * It also covers the demo workspace and the fail-closed
 * `control_state_unavailable` case, so an unreadable control plane blocks the
 * write rather than admitting it by default.
 *
 * Returns a response when the write must not proceed, `null` when it may.
 * Placed after the execution gate: a closed gate is the cheaper refusal and
 * costs no database read.
 */
export async function rejectIfLaunchpadMetaWritesBlocked(
  businessId: string,
  operation: "launchpad_launch" | "launchpad_add_to_existing",
) {
  const block = await getMetaWriteBlockState({ businessId }).catch(() => ({
    // An unreadable control plane is a refusal, never an admission. This mirrors
    // `getMetaWriteBlockState`'s own fail-closed behaviour for the case where
    // the call itself throws rather than returning a blocked state.
    blocked: true as const,
    reason: "control_state_unavailable" as const,
    message:
      "Meta write authority could not be confirmed for this workspace, so nothing was sent.",
  }));
  if (!block.blocked) return null;
  return jsonError(
    block.reason === "demo_business_read_only" ? 403 : 503,
    block.reason ?? "meta_writes_blocked",
    block.message ??
      "Meta writes are currently stopped for this workspace, so nothing was sent.",
    { operation },
  );
}
