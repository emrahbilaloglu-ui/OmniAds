export interface AuthBusinessLike {
  id: string;
  membershipStatus?: "active" | "invited" | "pending";
}

/**
 * A post-login return path, or null.
 *
 * This value ends up in `new URL(value, origin)` on a response that ALREADY
 * carries the session cookie, so anything that escapes the site here is a
 * post-authentication open redirect — the victim is signed in and then handed
 * to the attacker's page.
 *
 * `startsWith("//")` is not enough. The WHATWG URL parser treats a backslash as
 * a slash for special schemes, so `/\evil.com` passes that check and resolves
 * to `https://evil.com/`. Control characters are stripped before the parser
 * decides, so they can smuggle a second slash past a textual check too.
 *
 * Patterns are rejected first because they are cheap and name the specific
 * tricks, and then the result is PROVED by resolving it: if the origin moved,
 * it was never a local path, whatever it looked like.
 */
export function sanitizeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  // Protocol-relative in either slash flavour.
  if (/^[/\\]{2}/.test(value)) return null;
  // A backslash anywhere can become a slash during parsing.
  if (value.includes("\\")) return null;
  // Control characters (incl. tab/newline) are removed by the parser.
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;

  try {
    const base = "https://adsecute-sanitize.invalid";
    if (new URL(value, base).origin !== base) return null;
  } catch {
    return null;
  }

  return value;
}

export function getPostLoginDestination(
  businesses: AuthBusinessLike[],
  activeBusinessId: string | null | undefined
): string {
  if (businesses.length === 0) {
    return "/businesses/new";
  }

  if (activeBusinessId && businesses.some((business) => business.id === activeBusinessId)) {
    return "/overview";
  }

  const firstActiveBusiness = businesses.find(
    (business) => !business.membershipStatus || business.membershipStatus === "active"
  );
  if (firstActiveBusiness) {
    return "/select-business";
  }

  return "/select-business";
}

export function resolvePostLoginDestination(input: {
  businesses: AuthBusinessLike[];
  activeBusinessId: string | null | undefined;
  nextPath?: string | null;
}): string {
  return (
    sanitizeNextPath(input.nextPath) ??
    getPostLoginDestination(input.businesses, input.activeBusinessId)
  );
}
