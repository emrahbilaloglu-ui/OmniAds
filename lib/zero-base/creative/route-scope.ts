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
