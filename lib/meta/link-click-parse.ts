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

import { parseMetaActionCountValue } from "@/lib/meta/action-count-parse";

/**
 * Names the ad-day link-click semantics below: the strict value guard, the
 * measured-zero encoding (an `actions` array with no `link_click` entry), and
 * D095's column-versus-payload authority rule. Carried in the native ad
 * evaluation envelope (`metricContract`) so a stored link-click figure can be
 * attributed to the rule that produced it.
 */
export const META_AD_DAY_LINK_CLICK_CONTRACT_VERSION = "meta-ad-day-link-click.v1";

/**
 * Why a payload produced no usable count.
 *
 * `actions_absent` and `no_link_click_entry` used to be ONE code, which made the
 * most important distinction in this area caller-dependent: a row with no
 * `actions` array observed nothing (unmeasurable), while an array with no
 * `link_click` entry is Meta's measured-zero encoding (D095). Every caller had
 * to re-check `Array.isArray` itself to tell them apart. They are now separate.
 */
export type MetaLinkClickParseRefusal =
  | "actions_absent"
  | "no_link_click_entry"
  | "duplicate_link_click_entries"
  | "malformed_value";

export type MetaLinkClickParseResult =
  | { ok: true; value: number }
  | { ok: false; refusal: MetaLinkClickParseRefusal };

/**
 * Parses ONE raw `value` string.
 *
 * The guard itself lives in `lib/meta/action-count-parse.ts`, because the
 * funnel stages in `lib/meta/funnel-stage-parse.ts` read the same kind of value
 * out of the same array and a second copy of the rule would be the very
 * divergence this module was written to end. This function is the link-click
 * NAME for that one guard; its behaviour is unchanged.
 */
export function parseMetaLinkClickValue(raw: unknown): MetaLinkClickParseResult {
  return parseMetaActionCountValue(raw);
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
    return { ok: false, refusal: "actions_absent" };
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

/* ────────────────────────────────────────────────────────────────────────────
 * THE AD-DAY AUTHORITY RULE (D095), in both languages.
 *
 * `meta_ad_daily.link_clicks` used to be `NOT NULL DEFAULT 0`, and the old
 * writer supplied a literal zero when Meta supplied no actions breakdown. The
 * nullable migration deliberately preserved those historical zeros, so the
 * column alone cannot prove that a stored zero was measured. The verbatim
 * provider payload can:
 *
 *   stored > 0                                   -> the stored value
 *   stored = 0 and actions has no link_click     -> 0 (Meta's measured zero)
 *   stored = 0 and exactly one all-zero string   -> 0
 *   anything else (no actions, malformed,
 *     duplicate, contradicting entry, NULL)      -> unknown
 *
 * It lived as one unqualified SQL constant inside data-source.ts, so every
 * reader that joined another daily table either could not use it (the names
 * `link_clicks` and `payload_json` became ambiguous) or read the raw column
 * instead. That is how one ad-day came to be classified three ways. The builder
 * takes the relation qualifier, and the TypeScript twin gives an in-memory
 * reader the same answer.
 * ──────────────────────────────────────────────────────────────────────────── */

const SQL_QUALIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The per-row authoritative link-click value. With no qualifier the output is
 * byte-identical to the historical `AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL`,
 * which is still exported from data-source.ts for its existing readers.
 */
export function buildAdDayAuthoritativeLinkClicksSql(
  options: { qualifier?: string } = {},
): string {
  const qualifier = options.qualifier ?? "";
  if (qualifier !== "" && !SQL_QUALIFIER.test(qualifier)) {
    throw new Error(`ad_day_link_clicks_sql_qualifier_invalid:${qualifier}`);
  }
  const q = qualifier === "" ? "" : `${qualifier}.`;
  return `(CASE
      WHEN ${q}link_clicks > 0 THEN ${q}link_clicks
      WHEN ${q}link_clicks = 0
        AND jsonb_typeof(${q}payload_json->'actions') = 'array'
        AND (
          SELECT CASE
            WHEN COUNT(*) = 0 THEN TRUE
            WHEN COUNT(*) = 1
              THEN COALESCE(
                BOOL_AND(
                  jsonb_typeof(action->'value') = 'string'
                  AND COALESCE(action->>'value', '') ~ '^0+$'
                ),
                FALSE
              )
            ELSE FALSE
          END
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(${q}payload_json->'actions') = 'array'
                THEN ${q}payload_json->'actions'
              ELSE '[]'::jsonb
            END
          ) AS action
          WHERE action->>'action_type' = 'link_click'
        )
      THEN 0
      ELSE NULL
    END)`;
}

/**
 * TRUE when the row did NOT yield an authoritative link-click value. Never
 * NULL, so it can feed `buildMetaCompleteWindowSql` directly.
 */
export function buildAdDayLinkClicksMissingSql(
  options: { qualifier?: string } = {},
): string {
  return `(${buildAdDayAuthoritativeLinkClicksSql(options)} IS NULL)`;
}

/**
 * The TypeScript twin of `buildAdDayAuthoritativeLinkClicksSql`, for readers
 * that already hold the stored row in memory. Same ladder, same answer.
 */
export function resolveAdDayAuthoritativeLinkClicks(input: {
  storedLinkClicks: unknown;
  payloadJson: unknown;
}): number | null {
  const stored =
    typeof input.storedLinkClicks === "number"
      ? input.storedLinkClicks
      : typeof input.storedLinkClicks === "string" && /^[0-9]+$/.test(input.storedLinkClicks)
        ? Number(input.storedLinkClicks)
        : null;
  /*
   * The SQL twin reads an integer count column. In-memory callers can hand us
   * strings or untyped fixture data, so accept only the same domain here:
   * non-negative safe integers. Fractional, scientific, negative and unsafe
   * values are malformed evidence, never an authoritative count.
   */
  if (stored === null || !Number.isSafeInteger(stored) || stored < 0) return null;
  if (stored > 0) return stored;
  const actions =
    typeof input.payloadJson === "object" && input.payloadJson !== null
      ? (input.payloadJson as { actions?: unknown }).actions
      : undefined;
  if (!Array.isArray(actions)) return null;
  const entries = actions.filter(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      (action as { action_type?: unknown }).action_type === "link_click",
  ) as { value?: unknown }[];
  if (entries.length === 0) return 0;
  if (entries.length > 1) return null;
  const value = entries[0]?.value;
  return typeof value === "string" && /^0+$/.test(value) ? 0 : null;
}
