/**
 * The one strict guard, tested directly.
 *
 * Both `link-click-parse.ts` and `funnel-stage-parse.ts` delegate here, so a
 * change to this function moves every funnel stage and the link-click column at
 * once. Transitive coverage through those two modules would not say which rule
 * broke, and each of these cases is a value the old `parseFloat` path admitted.
 */
import { describe, expect, it } from "vitest";

import { parseMetaActionCountValue } from "@/lib/meta/action-count-parse";

const refused = (raw: unknown) =>
  expect(parseMetaActionCountValue(raw)).toEqual({
    ok: false,
    refusal: "malformed_value",
  });

describe("parseMetaActionCountValue", () => {
  it("accepts a non-negative integer string, including zero", () => {
    expect(parseMetaActionCountValue("0")).toEqual({ ok: true, value: 0 });
    expect(parseMetaActionCountValue("227")).toEqual({ ok: true, value: 227 });
    // Leading zeros are a digit string, and Meta does send them.
    expect(parseMetaActionCountValue("007")).toEqual({ ok: true, value: 7 });
  });

  it("refuses every value parseFloat used to admit", () => {
    refused("12.7"); // became a rounded 13 — a fraction stored as a count
    refused("12abc"); // became 12, from the valid prefix
    refused("-5"); // became a negative click count
    refused("1e21"); // became 1e21, past MAX_SAFE_INTEGER
    refused(" 12"); // whitespace was skipped
    refused("12 ");
    refused("+12");
  });

  it("refuses a digit string too long to represent exactly", () => {
    refused("9".repeat(17));
    expect(parseMetaActionCountValue(String(Number.MAX_SAFE_INTEGER))).toEqual({
      ok: true,
      value: Number.MAX_SAFE_INTEGER,
    });
  });

  it("refuses a non-string, including a number Graph never sends", () => {
    for (const raw of [12, 0, null, undefined, {}, [], true, NaN]) refused(raw);
  });

  it("never returns a confident zero for an unreadable value", () => {
    // The fabrication this whole area exists to undo: a refusal must stay a
    // refusal, so a caller cannot mistake it for a measured zero.
    for (const raw of ["", "abc", "-0", "0.0", null]) {
      const result = parseMetaActionCountValue(raw);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("value");
    }
  });
});
