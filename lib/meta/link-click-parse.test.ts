/**
 * CODEX B16 — forward ingestion and repair share ONE strict parser.
 *
 * Forward ingestion took `Number.parseFloat` + `Math.round` after selecting the
 * entry with `.find`. Every case below was ADMITTED by that path and REFUSED by
 * the repair path, so the same provider payload produced a stored value or a
 * malformed verdict depending on which code ran — which makes "is this column
 * measured?" unanswerable.
 */
import { describe, expect, it } from "vitest";

import {
  buildAdDayAuthoritativeLinkClicksSql,
  buildAdDayLinkClicksMissingSql,
  META_AD_DAY_LINK_CLICK_CONTRACT_VERSION,
  parseMetaLinkClickValue,
  parseMetaLinkClicksFromActions,
  resolveAdDayAuthoritativeLinkClicks,
} from "@/lib/meta/link-click-parse";
import { readMetaLinkClicksFromInsight } from "@/lib/api/meta";

const link = (value: unknown) => [{ action_type: "link_click", value }];

describe("the strict link-click parser", () => {
  it("accepts a plain non-negative integer string", () => {
    expect(parseMetaLinkClickValue("0")).toEqual({ ok: true, value: 0 });
    expect(parseMetaLinkClickValue("41")).toEqual({ ok: true, value: 41 });
  });

  /*
    The five shapes `parseFloat` accepted. Each is named because each produced a
    DIFFERENT wrong stored value, not merely a rejection:
      "12.7"  -> 13   (a rounded fraction stored as a count)
      "12abc" -> 12   (parseFloat stops at the first bad character)
      "-5"    -> -5   (a negative click count)
      "1e21"  -> 1e21 (past MAX_SAFE_INTEGER, where integers stop being exact)
      " 7 "   -> 7    (whitespace silently tolerated)
  */
  it.each([["12.7"], ["12abc"], ["-5"], ["1e21"], [" 7 "], [""], ["NaN"]])(
    "refuses %j instead of coercing it",
    (raw) => {
      expect(parseMetaLinkClickValue(raw)).toEqual({
        ok: false,
        refusal: "malformed_value",
      });
    },
  );

  it("refuses a digit string too long to be exact", () => {
    expect(parseMetaLinkClickValue("9".repeat(20)).ok).toBe(false);
  });

  it("refuses duplicate link_click entries rather than picking one", () => {
    expect(
      parseMetaLinkClicksFromActions([
        { action_type: "link_click", value: "3" },
        { action_type: "link_click", value: "9" },
      ]),
    ).toEqual({ ok: false, refusal: "duplicate_link_click_entries" });
  });

  it("reports an absent entry separately from a malformed one", () => {
    expect(parseMetaLinkClicksFromActions([{ action_type: "purchase", value: "1" }]))
      .toEqual({ ok: false, refusal: "no_link_click_entry" });
  });

  it("reports an absent actions array separately from an array without an entry", () => {
    // NEGATIVE: no array observed nothing; it must never read as Meta's
    // measured-zero encoding.
    expect(parseMetaLinkClicksFromActions(undefined))
      .toEqual({ ok: false, refusal: "actions_absent" });
    expect(parseMetaLinkClicksFromActions(null))
      .toEqual({ ok: false, refusal: "actions_absent" });
    // POSITIVE: an array with no entry is the measured-zero encoding.
    expect(parseMetaLinkClicksFromActions([]))
      .toEqual({ ok: false, refusal: "no_link_click_entry" });
  });
});

describe("the ad-day authority rule (D095) is one rule in both languages", () => {
  const cases: Array<{
    name: string;
    stored: unknown;
    payload: unknown;
    expected: number | null;
  }> = [
    { name: "positive stored value", stored: 7, payload: {}, expected: 7 },
    {
      name: "stored zero proven by an actions array with no entry",
      stored: 0,
      payload: { actions: [{ action_type: "purchase", value: "1" }] },
      expected: 0,
    },
    {
      name: "stored zero proven by one all-zero string entry",
      stored: 0,
      payload: { actions: [{ action_type: "link_click", value: "0" }] },
      expected: 0,
    },
    { name: "stored zero with no actions array", stored: 0, payload: {}, expected: null },
    {
      name: "stored zero contradicted by a positive entry",
      stored: 0,
      payload: { actions: [{ action_type: "link_click", value: "4" }] },
      expected: null,
    },
    {
      name: "stored zero beside duplicate entries",
      stored: 0,
      payload: {
        actions: [
          { action_type: "link_click", value: "0" },
          { action_type: "link_click", value: "0" },
        ],
      },
      expected: null,
    },
    {
      name: "stored zero beside a JSON-number entry",
      stored: 0,
      payload: { actions: [{ action_type: "link_click", value: 0 }] },
      expected: null,
    },
    { name: "NULL column", stored: null, payload: { actions: [] }, expected: null },
    { name: "negative column", stored: -1, payload: { actions: [] }, expected: null },
    { name: "fractional positive column", stored: 1.5, payload: { actions: [] }, expected: null },
    { name: "fractional positive string", stored: "1.5", payload: { actions: [] }, expected: null },
    { name: "scientific positive string", stored: "1e3", payload: { actions: [] }, expected: null },
    {
      name: "unsafe positive integer",
      stored: Number.MAX_SAFE_INTEGER + 1,
      payload: { actions: [] },
      expected: null,
    },
  ];

  it.each(cases)("$name", ({ stored, payload, expected }) => {
    expect(
      resolveAdDayAuthoritativeLinkClicks({ storedLinkClicks: stored, payloadJson: payload }),
    ).toBe(expected);
  });

  it("emits the historical unqualified SQL byte-for-byte", () => {
    // data-source.ts still exports this text for the operational readback
    // verifier; a qualified builder must not change what those readers run.
    const sql = buildAdDayAuthoritativeLinkClicksSql();
    expect(sql).toContain("WHEN link_clicks > 0 THEN link_clicks");
    expect(sql).toContain("jsonb_typeof(payload_json->'actions') = 'array'");
    expect(sql).not.toContain(".link_clicks");
  });

  it("qualifies every column reference when asked, so a joined query cannot bind the wrong table", () => {
    const sql = buildAdDayAuthoritativeLinkClicksSql({ qualifier: "d" });
    expect(sql).toContain("WHEN d.link_clicks > 0 THEN d.link_clicks");
    expect(sql).toContain("jsonb_typeof(d.payload_json->'actions') = 'array'");
    expect(sql).not.toMatch(/[^.]\blink_clicks > 0/);
    expect(sql.match(/payload_json/g)?.length).toBe(
      sql.match(/d\.payload_json/g)?.length,
    );
  });

  it("refuses a qualifier it did not generate", () => {
    expect(() => buildAdDayAuthoritativeLinkClicksSql({ qualifier: "d; DROP" })).toThrow(
      "ad_day_link_clicks_sql_qualifier_invalid",
    );
  });

  it("gives the window rule a never-NULL missing predicate", () => {
    expect(buildAdDayLinkClicksMissingSql({ qualifier: "d" })).toMatch(/IS NULL\)$/);
  });

  it("names the rule so a stored figure can cite it", () => {
    expect(META_AD_DAY_LINK_CLICK_CONTRACT_VERSION).toBe("meta-ad-day-link-click.v1");
  });
});

describe("forward ingestion now applies exactly that parser", () => {
  it("keeps the census-backed inference for an actions array with no entry", () => {
    // Unchanged and deliberate: no link_click entry means zero link clicks.
    expect(readMetaLinkClicksFromInsight({ actions: [] })).toBe(0);
  });

  it("reads a well-formed value", () => {
    expect(readMetaLinkClicksFromInsight({ actions: link("41") as never })).toBe(41);
  });

  it.each([["12.7"], ["12abc"], ["-5"], ["1e21"]])(
    "stores nothing for %j, where it used to store a number",
    (raw) => {
      // The pre-fix answers were 13, 12, -5 and 1e21 respectively.
      expect(readMetaLinkClicksFromInsight({ actions: link(raw) as never })).toBeNull();
    },
  );

  it("stores nothing when the payload carries duplicate entries", () => {
    expect(
      readMetaLinkClicksFromInsight({
        actions: [
          { action_type: "link_click", value: "3" },
          { action_type: "link_click", value: "9" },
        ] as never,
      }),
    ).toBeNull();
  });

  it("still reports an absent actions array as unknown, not zero", () => {
    expect(readMetaLinkClicksFromInsight({})).toBeNull();
  });
});
