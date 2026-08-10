/**
 * Server-page counterpart to `requireBusinessAccess`.
 *
 * Canonical pages live at `/c/[businessId]/**`, so the business ID arrives in
 * the URL where anyone can edit it. It is authorized through the same function
 * API routes use — never trusted because it is in the path — and the failure
 * result deliberately carries no tenant detail.
 *
 * Unused until the canonical shell lands (WP-06); adding it now keeps the two
 * entry points on one authority from the start.
 */
import { getSessionFromCookies } from "@/lib/auth";
import type { MembershipRole, SessionContext } from "@/lib/auth";
import type { MembershipRecord } from "@/lib/access-membership";
import {
  authorizeBusiness,
  type BusinessAuthorizationOutcome,
} from "@/lib/access/authorize-business";
import { isReviewerEmail } from "@/lib/reviewer-access";
import { DEMO_BUSINESS_ID } from "@/lib/demo-business";

export interface BusinessPageContext {
  session: SessionContext;
  membership: MembershipRecord;
  businessId: string;
  role: MembershipRole;
  /** Reviewers may read the demo business but must never be offered writes. */
  reviewerReadOnly: boolean;
  demo: boolean;
}

export type BusinessPageContextResult =
  | { kind: "ok"; context: BusinessPageContext }
  /** Send to login with a `next` param. */
  | { kind: "unauthenticated" }
  /** Render not-found: the actor may not learn whether this business exists. */
  | { kind: "not-found" }
  /** Authenticated and scoped, but the leaf needs a higher role. */
  | { kind: "forbidden"; required: MembershipRole; actual: MembershipRole }
  /** Schema not migrated — an explicit unavailable state, never an empty page. */
  | { kind: "unavailable" };

/** Maps an authorization outcome onto what a page is allowed to reveal. */
export function pageResultForOutcome(
  outcome: BusinessAuthorizationOutcome,
): BusinessPageContextResult {
  switch (outcome.kind) {
    case "authorized": {
      const { session, membership } = outcome;
      return {
        kind: "ok",
        context: {
          session,
          membership,
          businessId: membership.businessId,
          role: membership.role,
          reviewerReadOnly: isReviewerEmail(session.user.email),
          demo: membership.businessId === DEMO_BUSINESS_ID,
        },
      };
    }
    case "unauthenticated":
      return { kind: "unauthenticated" };
    case "insufficient_role":
      return { kind: "forbidden", required: outcome.required, actual: outcome.actual };
    case "schema_unavailable":
      return { kind: "unavailable" };
    // A missing ID, an out-of-scope reviewer, no membership and an inactive
    // membership are all one indistinguishable outcome to the browser.
    case "missing_business_id":
    case "reviewer_out_of_scope":
    case "no_membership":
    case "membership_inactive":
      return { kind: "not-found" };
  }
}

export async function requireBusinessPageContext(input: {
  businessId: string | null | undefined;
  minRole?: MembershipRole;
}): Promise<BusinessPageContextResult> {
  const session = await getSessionFromCookies();
  const outcome = await authorizeBusiness({
    session,
    businessId: input.businessId,
    minRole: input.minRole,
  });
  return pageResultForOutcome(outcome);
}
