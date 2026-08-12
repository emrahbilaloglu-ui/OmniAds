/**
 * The single tenant authority shared by API routes and server pages.
 *
 * Before this module the same four checks — reviewer scope, membership
 * existence, membership status, minimum role — were written out per caller, so
 * a new surface could accidentally trust a business ID that came from the URL.
 * Callers now evaluate authorization here and only translate the outcome into
 * their own transport.
 *
 * `evaluateBusinessAuthorization` is pure: it performs no I/O so every branch,
 * including the ones that are hard to reach against a real database, is
 * directly testable. `authorizeBusiness` is the thin I/O wrapper.
 */
import type { MembershipRole, SessionContext } from "@/lib/auth";
import { canReviewerAccessBusiness } from "@/lib/reviewer-access";
import type { MembershipRecord } from "@/lib/access-membership";
import { findMembershipResult, hasRole } from "@/lib/access-membership";

export type BusinessAuthorizationOutcome =
  | { kind: "authorized"; session: SessionContext; membership: MembershipRecord }
  | { kind: "missing_business_id" }
  | { kind: "unauthenticated" }
  | { kind: "reviewer_out_of_scope" }
  /** Schema not migrated yet. Distinct from "no membership" for diagnostics. */
  | { kind: "schema_unavailable" }
  | { kind: "no_membership" }
  | { kind: "membership_inactive"; status: MembershipRecord["status"] }
  | { kind: "insufficient_role"; required: MembershipRole; actual: MembershipRole };

export interface BusinessAuthorizationInput {
  session: SessionContext | null;
  businessId: string | null | undefined;
  minRole?: MembershipRole;
  /** False when the memberships schema is not ready; membership must be null. */
  schemaAvailable: boolean;
  membership: MembershipRecord | null;
}

/**
 * Order matters and is part of the contract: a caller must never learn that a
 * business exists by getting a different error for it. Reviewer scope is
 * checked before any membership read, and the three "no access" branches are
 * deliberately indistinguishable to the client.
 */
export function evaluateBusinessAuthorization(
  input: BusinessAuthorizationInput,
): BusinessAuthorizationOutcome {
  const { session, businessId, minRole = "guest", schemaAvailable, membership } = input;

  if (!businessId) return { kind: "missing_business_id" };
  if (!session) return { kind: "unauthenticated" };
  if (!canReviewerAccessBusiness(session.user.email, businessId)) {
    return { kind: "reviewer_out_of_scope" };
  }
  if (!schemaAvailable) return { kind: "schema_unavailable" };
  if (!membership) return { kind: "no_membership" };
  if (membership.status !== "active") {
    return { kind: "membership_inactive", status: membership.status };
  }
  if (!hasRole(minRole, membership.role)) {
    return { kind: "insufficient_role", required: minRole, actual: membership.role };
  }

  return { kind: "authorized", session, membership };
}

/** Loads the membership for `businessId`, then evaluates it. */
export async function authorizeBusiness(input: {
  session: SessionContext | null;
  businessId: string | null | undefined;
  minRole?: MembershipRole;
}): Promise<BusinessAuthorizationOutcome> {
  const { session, businessId, minRole } = input;

  // Nothing is read until the caller has proven who they are and that the
  // reviewer scope permits this business.
  if (!businessId) return { kind: "missing_business_id" };
  if (!session) return { kind: "unauthenticated" };
  if (!canReviewerAccessBusiness(session.user.email, businessId)) {
    return { kind: "reviewer_out_of_scope" };
  }

  const { schemaReady, membership } = await findMembershipResult({
    userId: session.user.id,
    businessId,
  });

  return evaluateBusinessAuthorization({
    session,
    businessId,
    minRole,
    schemaAvailable: schemaReady,
    membership,
  });
}

/**
 * Every non-authorized outcome collapses to one of three client-visible
 * responses. Keeping the mapping here means a new outcome cannot be added
 * without deciding, in one place, what the client is allowed to learn from it.
 */
export function authorizationDenialResponse(
  outcome: Exclude<BusinessAuthorizationOutcome, { kind: "authorized" }>,
): { status: number; error: string; message: string } {
  switch (outcome.kind) {
    case "missing_business_id":
      return {
        status: 400,
        error: "missing_business_id",
        message: "businessId is required.",
      };
    case "unauthenticated":
      return { status: 401, error: "auth_error", message: "Authentication required." };
    case "insufficient_role":
      return {
        status: 403,
        error: "auth_error",
        message: "Insufficient role permissions for this action.",
      };
    case "reviewer_out_of_scope":
    case "schema_unavailable":
    case "no_membership":
    case "membership_inactive":
      return {
        status: 403,
        error: "auth_error",
        message: "You do not have access to this business.",
      };
  }
}
