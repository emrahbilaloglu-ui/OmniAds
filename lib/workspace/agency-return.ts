/**
 * The one-tap Agency return link.
 *
 * Entering a client from the Agency Desk attaches a `returnTo` so the return
 * lands on the same row the actor left. That value is attacker-controllable, so
 * it is never used as a redirect target directly: it is parsed against an
 * allowlist of two paths and three parameters, and anything else is refused.
 *
 * Refusal is not an error — it falls back to `/a/desk`, so a tampered link
 * degrades to a safe destination instead of a broken page.
 */

/** The only paths an Agency return may point at. */
const ALLOWED_PATHS = ["/a/desk", "/a/desk/clients"] as const;

/** The only parameters allowed to survive the round trip. */
const ALLOWED_PARAMS = ["q", "cursor", "row"] as const;

const MAX_PARAM_LENGTH = 256;

export const AGENCY_RETURN_PARAM = "returnTo";
export const AGENCY_RETURN_FALLBACK = "/a/desk";

export type AgencyReturnPath = (typeof ALLOWED_PATHS)[number];

export interface AgencyReturnTarget {
  path: AgencyReturnPath;
  q: string | null;
  cursor: string | null;
  /** Row anchor to restore focus to. */
  row: string | null;
}

export function buildAgencyReturn(input: {
  path: AgencyReturnPath;
  q?: string | null;
  cursor?: string | null;
  row?: string | null;
}): string {
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.row) params.set("row", input.row);
  const query = params.toString();
  return `${input.path}${query ? `?${query}` : ""}`;
}

/**
 * Returns null for anything not on the allowlist: absolute URLs, protocol
 * relative `//evil.example`, backslash tricks, other app paths, unknown
 * parameters, or over-long values.
 */
export function parseAgencyReturn(raw: string | null | undefined): AgencyReturnTarget | null {
  if (!raw) return null;

  // Reject anything that could resolve to another origin before parsing.
  if (raw.includes("\\") || raw.includes("\0")) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;

  let url: URL;
  try {
    // A base is required for relative parsing; it is never used as a target.
    url = new URL(raw, "https://agency.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://agency.invalid") return null;

  const path = ALLOWED_PATHS.find((allowed) => allowed === url.pathname);
  if (!path) return null;

  for (const key of url.searchParams.keys()) {
    if (!(ALLOWED_PARAMS as readonly string[]).includes(key)) return null;
  }

  const read = (key: (typeof ALLOWED_PARAMS)[number]) => {
    const value = url.searchParams.get(key);
    if (value === null || value === "") return null;
    if (value.length > MAX_PARAM_LENGTH) return null;
    return value;
  };

  const q = read("q");
  const cursor = read("cursor");
  const row = read("row");

  // An allowlisted key carrying an over-long value is tampering, not a partial
  // match; refuse the whole target rather than silently truncating it.
  if (url.searchParams.has("q") && url.searchParams.get("q") !== "" && q === null) return null;
  if (url.searchParams.has("cursor") && url.searchParams.get("cursor") !== "" && cursor === null) {
    return null;
  }
  if (url.searchParams.has("row") && url.searchParams.get("row") !== "" && row === null) return null;

  return { path, q, cursor, row };
}

/** Safe href for the return control: the parsed target, or the desk. */
export function resolveAgencyReturnHref(raw: string | null | undefined): string {
  const target = parseAgencyReturn(raw);
  if (!target) return AGENCY_RETURN_FALLBACK;
  return buildAgencyReturn(target);
}
