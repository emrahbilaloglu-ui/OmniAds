/**
 * What may be used as a Tier-0 as-of, and what may not.
 *
 * The freshness bar answers one question: how old is what I am looking at. Six
 * surfaces were answering a different question and presenting it as that one:
 *
 * - a fetch time (`dataUpdatedAt`) restates the age of the *request*. It is
 *   fresh by construction, so a surface reading a warehouse that stopped
 *   syncing a week ago still says "as of just now" after every refetch.
 * - a wall-clock date (today, in the account's timezone) is derived from a
 *   clock and not from any read, so the reading drifts with the time of day and
 *   can never say "stale".
 * - an echoed request parameter (an `asOf` the client sent and the server sent
 *   back) measures nothing at all.
 * - a content timestamp (when a human last edited a report; when an account was
 *   opened) is a property of the thing, not of the read.
 *
 * Each substitutes something known-and-wrong for something unknown, which is
 * exactly the failure the contract exists to remove. `null` is a real answer:
 * the chip renders "age unknown", and that is strictly better than a number
 * nobody should trust.
 */

/** A timestamp measured when data was produced or observed, or null. */
export type TierZeroAsOf = string | null;

/**
 * The newest observation across scopes, or null when no evidence was readable.
 *
 * Deliberately max rather than min: this answers "how recently did we see
 * anything", and completeness across scopes is reported separately as a partial
 * state. Reporting the oldest here would conflate age with coverage.
 */
export function newestObservation(
  observations: Array<string | null | undefined>,
): TierZeroAsOf {
  let newest: number | null = null;
  let newestIso: string | null = null;
  for (const value of observations) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (newest === null || parsed > newest) {
      newest = parsed;
      newestIso = new Date(parsed).toISOString();
    }
  }
  return newestIso;
}

/**
 * Reject a date-only value as an as-of.
 *
 * `2026-08-09` parses as UTC midnight, so on a UTC+3 account at 01:10 local it
 * is 110 minutes in the *future*, and on a UTC-7 account at 07:00 UTC it is 31
 * hours old. Same data, same moment, three different readings. A calendar date
 * is a range label, never an observation time.
 */
export function isMeasuredInstant(value: string | null | undefined): boolean {
  if (!value) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  return Number.isFinite(Date.parse(value));
}

/** Passes through a measured instant, and refuses anything else. */
export function measuredAsOf(value: string | null | undefined): TierZeroAsOf {
  return isMeasuredInstant(value) ? new Date(Date.parse(value as string)).toISOString() : null;
}
