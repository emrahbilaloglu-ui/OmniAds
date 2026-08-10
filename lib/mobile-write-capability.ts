/**
 * What a route actually lets someone do on a phone.
 *
 * The shell used to print "Adsecute · mobile read-only / Writes stay on
 * desktop" on every route that did not own a mobile surface of its own. That
 * included Settings and Integrations, which render real write controls at the
 * same width: save workspace settings, update profile, change password,
 * reconnect a provider, manage assignments, disconnect. So the banner told an
 * operator their changes would not be saved, directly above controls that save
 * them — and the safe reading of that is to stop trying, which makes the
 * product look broken when it is working.
 *
 * D5 gates *provider mutation* to desktop: budget, bid, activation, bulk. It
 * does not make a phone read-only, and it never covered account or workspace
 * settings. This is the difference the banner was flattening.
 */
export type MobileWriteCapability = "read_only" | "writes_allowed";

/** Meta surfaces where provider mutation is genuinely desktop-gated. */
const READ_ONLY_PREFIXES = ["/platforms/meta", "/platforms/google"];

/**
 * Routes that accept writes on a phone. Listed explicitly rather than inferred,
 * because the cost of getting this wrong is a false promise in either
 * direction: a read-only claim over a working form, or silence over a form
 * that will refuse.
 */
const WRITE_CAPABLE_PREFIXES = [
  "/settings",
  "/integrations",
  "/team",
  "/reports",
  "/security",
  "/select-business",
  "/overview",
  "/insights",
];

export function mobileWriteCapabilityForPath(
  pathname: string | null,
): MobileWriteCapability {
  if (!pathname) return "writes_allowed";
  if (WRITE_CAPABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return "writes_allowed";
  }
  if (READ_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return "read_only";
  }
  // Unknown routes make no claim. Saying nothing is recoverable; saying
  // "read-only" about a route that writes is not.
  return "writes_allowed";
}

/** True only where a read-only banner would be a true statement. */
export function shouldClaimMobileReadOnly(pathname: string | null): boolean {
  return mobileWriteCapabilityForPath(pathname) === "read_only";
}
