import type { SessionContext } from "@/lib/auth";
import { listUserBusinesses } from "@/lib/access";
import { logServerAuthEvent } from "@/lib/auth-diagnostics";
import { scopeBusinessesForUser } from "@/lib/reviewer-access";

/**
 * Picks the business a session should be scoped to.
 *
 * Exported so server pages can reuse the exact selection rule instead of
 * reimplementing it: the session's own choice wins if it is still visible,
 * otherwise the first active membership, otherwise nothing.
 */
export function selectActiveBusinessId(
  sessionActiveBusinessId: string | null,
  businesses: ReadonlyArray<{ id: string; membershipStatus: string }>
): string | null {
  if (
    sessionActiveBusinessId &&
    businesses.some((business) => business.id === sessionActiveBusinessId)
  ) {
    return sessionActiveBusinessId;
  }
  return businesses.find((business) => business.membershipStatus === "active")?.id ?? null;
}

export async function resolveBusinessContext(session: SessionContext) {
  const businesses = scopeBusinessesForUser(
    session.user.email,
    await listUserBusinesses(session.user.id)
  );
  const activeBusinessId = selectActiveBusinessId(session.activeBusinessId, businesses);

  logServerAuthEvent("business_context_resolved", {
    sessionId: session.sessionId,
    userId: session.user.id,
    email: session.user.email,
    membershipCount: businesses.length,
    activeBusinessId,
    healedActiveBusinessId:
      session.activeBusinessId !== activeBusinessId ? activeBusinessId : undefined,
  });

  return {
    businesses,
    activeBusinessId,
  };
}
