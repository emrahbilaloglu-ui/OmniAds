/**
 * Shared URL scope for the canonical creative routes.
 *
 * The account and the window live in the URL so a pasted link renders the same
 * surface for whoever opens it — and, for the detail route, so the account the
 * creative must belong to is explicit rather than inferred from a session.
 */
export interface CreativeRouteScope {
  providerAccountId: string | null;
  start: string;
  end: string;
}

/** The 28-day window every creative surface defaults to. */
export function defaultCreativeWindow(now: Date): { start: string; end: string } {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 27);
  return { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
}

function first(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A bound is only a date if the calendar agrees: `2026-02-31` is not one. */
function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** The window a request names, when it names one. */
export interface CreativeRouteWindow {
  start: string;
  end: string;
}

/**
 * The two URL spellings of one window, in precedence order.
 *
 * `startDate`/`endDate` is the shell's: the dashboard date control states its
 * window there (`lib/dashboard/date-window-url.ts`, which also writes
 * `?window`) and every surface that reads the URL reads that pair. `start`/
 * `end` is the Creative Studio's own, minted by `buildCreativeStudioTabHrefs`
 * and read by the audiences, shares, briefs and detail routes. Both are live in
 * links today, so a route that understood only one would render the wrong
 * window for half the links that exist.
 *
 * The shell's spelling wins when both are present: it is the one the operator's
 * own control writes, so a stale Studio pair left further along the query
 * cannot outrank the range they just chose.
 *
 * The names are literal here on purpose. `lib/dashboard/date-window-url.ts`
 * owns them but reaches a `"use client"` module, and this file is imported by
 * server routes; `route-window.test.ts` pins the two definitions together so
 * they cannot drift apart in silence.
 */
const WINDOW_PARAM_SPELLINGS = [
  { start: "startDate", end: "endDate" },
  { start: "start", end: "end" },
] as const;

/** Exposed so a test can pin these against the module that owns the spelling. */
export const CREATIVE_WINDOW_PARAM_SPELLINGS = WINDOW_PARAM_SPELLINGS;

function readWindow(
  params: Record<string, string | string[] | undefined>,
  spelling: { start: string; end: string },
): CreativeRouteWindow | null {
  const start = first(params[spelling.start]);
  const end = first(params[spelling.end]);
  if (!start || !end) return null;
  if (!isRealIsoDate(start) || !isRealIsoDate(end)) return null;
  if (start > end) return null;
  return { start, end };
}

/**
 * The window this request explicitly asked for, or `null` when it asked for
 * none.
 *
 * `scopeFromSearchParams` always answers with a window because its callers
 * (shares, briefs, the creative detail) run a read that needs concrete bounds,
 * so absence there has to become the 28-day default. The Studio surfaces are
 * the opposite case: their window is owned by the shell's date control, so
 * substituting a hard-coded 28 UTC days whenever the URL is silent would
 * overwrite the operator's own range with a constant nobody asked for — and it
 * would disagree with the shell by up to a day, because the shell resolves
 * "today" in the account's timezone and this helper cannot. Absence is
 * therefore reported as absence, and the body keeps the window it already had.
 *
 * A window counts only when BOTH bounds are present, are real calendar dates,
 * and do not run backwards. A half or malformed window is not a window: it is
 * reported absent rather than repaired into a range the link never named, so a
 * mistyped URL can never become authority for what a surface read. A malformed
 * pair in one spelling does not poison the other — the next spelling is tried,
 * and only a request that names no readable window at all answers null.
 */
export function windowFromSearchParams(
  raw: Record<string, string | string[] | undefined> | undefined,
): CreativeRouteWindow | null {
  const params = raw ?? {};
  for (const spelling of WINDOW_PARAM_SPELLINGS) {
    const window = readWindow(params, spelling);
    if (window) return window;
  }
  return null;
}

/**
 * The provider account this request asks for — a request, not an answer.
 * `resolveProviderAccountId` still has to decide whether the business is
 * actually assigned it; a URL cannot grant scope.
 */
export function requestedProviderAccountFromSearchParams(
  raw: Record<string, string | string[] | undefined> | undefined,
): string | null {
  return first((raw ?? {}).providerAccountId);
}

export function scopeFromSearchParams(
  raw: Record<string, string | string[] | undefined> | undefined,
  fallback: { start: string; end: string },
): CreativeRouteScope {
  const params = raw ?? {};
  const start = first(params.start);
  const end = first(params.end);
  return {
    providerAccountId: first(params.providerAccountId),
    // A malformed date falls back rather than being passed to a read model
    // that would interpret it as an empty window.
    start: start && ISO_DATE.test(start) ? start : fallback.start,
    end: end && ISO_DATE.test(end) ? end : fallback.end,
  };
}
