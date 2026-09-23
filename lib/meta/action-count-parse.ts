/**
 * THE ONE strict guard for a Graph `actions[].value` count.
 *
 * `lib/meta/link-click-parse.ts` established this rule for one action type and
 * recorded why it has to be strict: `Number.parseFloat` accepted `"12.7"` as
 * 13, `"12abc"` as 12, `"-5"` as a negative count, and `"1e21"` as a number
 * past `Number.MAX_SAFE_INTEGER`. The funnel stages in
 * `lib/meta/funnel-stage-parse.ts` read the same array for the same kind of
 * value, so they need the same rule — and they must not carry a SECOND copy of
 * it. Two definitions of "is this a count?" is exactly the divergence the
 * link-click module exists to have ended; `link-click-parse.ts` now delegates
 * here so there is one guard with two named entry points.
 *
 * A count is a non-negative safe integer. Anything else is UNREADABLE, never
 * coerced and never turned into a confident zero.
 */

export type MetaActionCountParseResult =
  | { ok: true; value: number }
  | { ok: false; refusal: "malformed_value" };

/**
 * `/^\d+$/` before any numeric conversion is the whole guard: it rejects
 * fractions, signs, exponent notation, whitespace, and trailing junk that
 * `parseFloat` would silently discard. `Number.isSafeInteger` then rejects a
 * digit string too long to be represented exactly.
 */
export function parseMetaActionCountValue(
  raw: unknown,
): MetaActionCountParseResult {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return { ok: false, refusal: "malformed_value" };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, refusal: "malformed_value" };
  }
  return { ok: true, value: parsed };
}
