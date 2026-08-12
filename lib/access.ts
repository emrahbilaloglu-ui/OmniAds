import { NextRequest, NextResponse } from "next/server";
import { MembershipRole, SessionContext, getSessionFromRequest } from "@/lib/auth";
import {
  authorizationDenialResponse,
  authorizeBusiness,
} from "@/lib/access/authorize-business";

export type { MembershipRecord } from "@/lib/access-membership";
export {
  findMembership,
  findMembershipResult,
  hasRole,
  listUserBusinesses,
} from "@/lib/access-membership";

import type { MembershipRecord } from "@/lib/access-membership";

export function authError(message: string, status = 401) {
  return NextResponse.json({ error: "auth_error", message }, { status });
}

export async function requireAuthedRequest(
  request: NextRequest
): Promise<{ session: SessionContext } | { error: NextResponse }> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return { error: authError("Authentication required.", 401) };
  }
  return { session };
}

/**
 * Unchanged contract, shared implementation.
 *
 * The signature, status codes and message strings are exactly as before; the
 * decision itself now comes from `authorizeBusiness` so API routes and server
 * pages cannot drift apart.
 */
export async function requireBusinessAccess(input: {
  request: NextRequest;
  businessId: string | null;
  minRole?: MembershipRole;
}): Promise<
  | { session: SessionContext; membership: MembershipRecord }
  | { error: NextResponse }
> {
  const { request, businessId, minRole } = input;

  // The session is read before the authorizer so an unauthenticated caller
  // never reaches a membership lookup, exactly as the previous flow did.
  const session = businessId ? await getSessionFromRequest(request) : null;

  const outcome = await authorizeBusiness({ session, businessId, minRole });
  if (outcome.kind === "authorized") {
    return { session: outcome.session, membership: outcome.membership };
  }

  const denial = authorizationDenialResponse(outcome);
  return {
    error: NextResponse.json(
      { error: denial.error, message: denial.message },
      { status: denial.status },
    ),
  };
}
