/**
 * Canonical post-login routing (Flow K).
 *
 * Added alongside `getPostLoginDestination`, not in place of it: legacy routes
 * are not renamed in this migration, so the legacy resolver keeps returning
 * `/overview` and `/select-business` for callers that have not moved.
 *
 * The ordering rule that matters: a `next` path is honoured **only after**
 * authorization, and only when it is both locally-resolvable and reachable by
 * this actor. Applying `next` first would let a link decide where an
 * authenticated session lands, which is how a "harmless" redirect becomes a
 * way to probe which businesses exist.
 */
import { sanitizeNextPath, type AuthBusinessLike } from "@/lib/auth-routing";

export interface CanonicalRoutingInput {
  businesses: readonly AuthBusinessLike[];
  /** The business this session last used, if it is still visible. */
  lastCanonicalBusinessId?: string | null;
  /** Raw `next` from the URL. Never trusted as given. */
  next?: string | null;
}

export const NO_BUSINESS_DESTINATION = "/businesses/new";
export const SELECT_BUSINESS_DESTINATION = "/select-business";
export const AGENCY_DESTINATION = "/a/desk";

function activeBusinesses(businesses: readonly AuthBusinessLike[]): AuthBusinessLike[] {
  return businesses.filter(
    (business) => !business.membershipStatus || business.membershipStatus === "active",
  );
}

/**
 * True when `path` is a canonical route this actor can actually reach.
 *
 * A `/c/<id>/…` path is only reachable when `<id>` is one of the actor's own
 * active businesses — otherwise honouring it would bounce them into a
 * not-found for a tenant they cannot see, which is both a bad landing and a
 * weak existence oracle.
 */
export function isReachableCanonicalPath(
  path: string,
  businesses: readonly AuthBusinessLike[],
): boolean {
  const active = activeBusinesses(businesses);
  const clientMatch = /^\/c\/([^/]+)(\/|$)/.exec(path);
  if (clientMatch) {
    return active.some((business) => business.id === clientMatch[1]);
  }
  if (path.startsWith("/a/")) return active.length >= 2;
  // Account-scoped and onboarding paths need no business.
  return path.startsWith("/me/") || path === "/businesses/new" || path === "/select-business";
}

export function resolveCanonicalPostLoginDestination(input: CanonicalRoutingInput): string {
  const { businesses, lastCanonicalBusinessId, next } = input;
  const active = activeBusinesses(businesses);

  // 1 · No membership at all — including invite-only, which cannot be entered
  //     until the invitation is accepted.
  if (businesses.length === 0) return NO_BUSINESS_DESTINATION;
  if (active.length === 0) return SELECT_BUSINESS_DESTINATION;

  // 2 · `next` is considered only now: after we know what this actor may
  //     reach. Sanitisation alone is not authorization.
  const sanitized = sanitizeNextPath(next);
  if (sanitized && isReachableCanonicalPath(sanitized, businesses)) return sanitized;

  // 3 · A single client goes straight to its Home; there is nothing to choose.
  if (active.length === 1) return `/c/${active[0].id}/home`;

  // 4 · Several clients: return to the last one if it is still visible,
  //     otherwise the Agency desk rather than an arbitrary pick.
  if (lastCanonicalBusinessId && active.some((b) => b.id === lastCanonicalBusinessId)) {
    return `/c/${lastCanonicalBusinessId}/home`;
  }
  return AGENCY_DESTINATION;
}

/** Login URL preserving where the user was trying to go. */
export function loginUrlFor(path: string): string {
  const sanitized = sanitizeNextPath(path);
  return sanitized ? `/login?next=${encodeURIComponent(sanitized)}` : "/login";
}
