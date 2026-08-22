import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { META_GATE_REFUSAL_REASONS } from "@/lib/meta/release-gate-copy";
import { readMetaReleaseGates } from "@/lib/meta/release-gates";
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
export function rejectIfLaunchpadExecutionGated(
  operation: "launchpad_launch" | "launchpad_add_to_existing",
) {
  if (readMetaReleaseGates().launchpadExecution) return null;
  return jsonError(
    503,
    "launchpad_execution_disabled",
    META_GATE_REFUSAL_REASONS.launchpadExecution,
    { operation },
  );
}
