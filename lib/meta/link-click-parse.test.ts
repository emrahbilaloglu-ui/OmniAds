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
  parseMetaLinkClickValue,
  parseMetaLinkClicksFromActions,
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
