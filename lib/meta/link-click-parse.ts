/**
 * THE ONE PARSER for a Graph `actions[].link_click` value.
 *
 * Two existed, and they disagreed about what a measurement is.
 *
 * Forward ingestion (`lib/api/meta.ts`) took `Number.parseFloat(entry.value)`
 * and `Math.round`ed the result, having selected the entry with `.find`. That
 * accepts a great deal it should not:
 *
 *   - `"12.7"` became 13 — a rounded fraction stored as an integer count;
 *   - `"12abc"` became 12, because `parseFloat` stops at the first bad
 *     character and reports success on the prefix;
 *   - `"-5"` became -5, a negative click count;
 *   - `"1e21"` became 1e21, past `Number.MAX_SAFE_INTEGER`, where integer
 *     arithmetic silently stops being exact;
 *   - two `link_click` entries meant the first one won, silently.
 *
 * The repair path already refused all of that. So the same provider payload
 * could be admitted by one path and rejected by the other, and a row written
 * by forward ingestion could hold a value the repair would have called
 * malformed — which makes "is this column measured?" unanswerable, because the
 * answer depends on which code wrote it.
 *
 * This module is that single definition. It is deliberately strict: a
 * link-click count is a non-negative integer, and anything that is not exactly
 * that is UNREADABLE rather than coerced. An unreadable value is never turned
 * into a confident zero — that is the fabrication this whole area exists to
 * undo.
 */

/** Why a payload produced no usable count. */
export type MetaLinkClickParseRefusal =
  | "no_link_click_entry"
  | "duplicate_link_click_entries"
  | "malformed_value";

export type MetaLinkClickParseResult =
  | { ok: true; value: number }
  | { ok: false; refusal: MetaLinkClickParseRefusal };

/**
 * Parses ONE raw `value` string.
 *
 * `/^\d+$/` before any numeric conversion is the whole guard: it rejects
 * fractions, signs, exponent notation, whitespace, and any trailing junk that
 * `parseFloat` would have silently discarded. `Number.isSafeInteger` then
 * rejects a digit string too long to be represented exactly.
 */
export function parseMetaLinkClickValue(raw: unknown): MetaLinkClickParseResult {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return { ok: false, refusal: "malformed_value" };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, refusal: "malformed_value" };
  }
  return { ok: true, value: parsed };
}

/**
 * Selects and parses the `link_click` entry of an `actions` array.
 *
 * Duplicates are REFUSED rather than resolved. Two entries for one action type
 * is a payload shape neither path has observed, and picking one would be
 * inventing a rule for a case the provider has not actually shown us.
 */
export function parseMetaLinkClicksFromActions(
  actions: readonly { action_type?: unknown; value?: unknown }[] | null | undefined,
): MetaLinkClickParseResult {
  if (!Array.isArray(actions)) {
    return { ok: false, refusal: "no_link_click_entry" };
  }
  const entries = actions.filter((action) => action?.action_type === "link_click");
  if (entries.length === 0) {
    return { ok: false, refusal: "no_link_click_entry" };
  }
  if (entries.length > 1) {
    return { ok: false, refusal: "duplicate_link_click_entries" };
  }
  return parseMetaLinkClickValue(entries[0]?.value);
}
