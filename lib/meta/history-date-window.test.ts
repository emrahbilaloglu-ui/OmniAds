// @vitest-environment jsdom
/**
 * ITEM 12 — the window Meta History reads, at the unit that resolves it.
 *
 * The route test (`app/c/[businessId]/meta/history/page.test.tsx`) proves the
 * resolved window reaches the journal read and the client boundary. This file
 * proves the resolution itself, including the cases a route test cannot make
 * legible: every malformed URL shape, and the identity of the default.
 *
 * THE ONE THING THIS FILE MUST NOT BECOME is a second statement of the
 * expansion rule. Every date below is asserted against
 * `getPresetDatesForReferenceDate` — the single expander every surface reads —
 * or is a verbatim echo of what the URL already stated. If the shared expansion
 * changes meaning, these fail rather than pinning History to a stale copy of it.
 */
import { describe, expect, it } from "vitest";

import { getPresetDatesForReferenceDate } from "@/lib/dashboard/date-window-presets";
import { DATE_WINDOW_INCLUDES_CURRENT_DAY } from "@/lib/dashboard/date-window-url";
import { DASHBOARD_V2_DEFAULT_DATE_RANGE } from "@/hooks/use-persistent-date-range";
import {
  HISTORY_DEFAULT_WINDOW_PRESET,
  resolveHistoryDateWindow,
} from "@/lib/meta/history-date-window";

/** TheSwaf's clock, on a fixed day, so nothing here expires overnight. */
const REFERENCE_DATE = "2026-08-18";

function resolve(query: string) {
  return resolveHistoryDateWindow({
    searchParams: new URLSearchParams(query),
    referenceDate: REFERENCE_DATE,
  });
}

/** The shared expansion, asked directly. */
function shared(preset: "7d" | "14d" | "28d" | "90d") {
  return getPresetDatesForReferenceDate(preset, REFERENCE_DATE, undefined, undefined, {
    includeCurrentDay: DATE_WINDOW_INCLUDES_CURRENT_DAY,
  });
}

describe("the default is the shell's default, not a private one", () => {
  it("names the same preset the shell falls back to", () => {
    // If these two ever differ, the chip and the table state different lengths
    // for the same unstated URL — which is the ITEM 12 defect in its other half.
    expect(HISTORY_DEFAULT_WINDOW_PRESET).toBe(
      DASHBOARD_V2_DEFAULT_DATE_RANGE.rangePreset,
    );
  });

  it("expands that default through the shared expander, ending on yesterday", () => {
    expect(DATE_WINDOW_INCLUDES_CURRENT_DAY).toBe(false);
    const expected = shared("28d");
    expect(resolve("")).toEqual({
      start: expected.start,
      end: expected.end,
      preset: "28d",
      source: "default",
    });
    // Stated concretely as well, so a change in the shared rule is visible here
    // and not merely mirrored.
    expect(resolve("")).toMatchObject({
      start: "2026-07-21",
      end: "2026-08-17",
    });
  });
});

describe("a window the URL states is the window History reads", () => {
  it("takes an exact pair verbatim and never re-expands it", () => {
    expect(resolve("startDate=2026-03-02&endDate=2026-03-09")).toEqual({
      start: "2026-03-02",
      end: "2026-03-09",
      preset: "custom",
      source: "url",
    });
  });

  it("expands a bare preset key exactly once, to completed days", () => {
    for (const preset of ["7d", "14d", "28d", "90d"] as const) {
      const expected = shared(preset);
      expect(resolve(`window=${preset}`)).toEqual({
        start: expected.start,
        end: expected.end,
        preset,
        source: "url",
      });
    }
  });

  it("lets the dates win over a key that contradicts them, and names them honestly", () => {
    // `?window=7d` over a 14-day pair. The dates are the stated fact; the label
    // is recovered from the picker's own vocabulary, so it names what these two
    // days actually mean rather than repeating a key that does not fit them.
    expect(resolve("window=7d&startDate=2026-08-04&endDate=2026-08-17")).toEqual({
      start: "2026-08-04",
      end: "2026-08-17",
      preset: "14d",
      source: "url",
    });
  });

  it("still honours a usable key when the dates beside it are unusable", () => {
    // The shell writes the key beside the dates, so a truncated or mangled pair
    // still leaves the length stated — and a stated length is not a default.
    const expected = shared("90d");
    expect(resolve("window=90d&startDate=2026-08-01&endDate=nope")).toEqual({
      start: expected.start,
      end: expected.end,
      preset: "90d",
      source: "url",
    });
  });
});

describe("an unusable window falls back — it is never repaired", () => {
  const defaulted = {
    start: "2026-07-21",
    end: "2026-08-17",
    preset: "28d",
    source: "default",
  };

  it("resolves the canonical default for every unusable shape, and marks it as one", () => {
    for (const query of [
      "startDate=2026-08-01&endDate=nope",
      "startDate=2026-08-01",
      "endDate=2026-08-17",
      "startDate=2026-08-20&endDate=2026-08-01",
      "startDate=&endDate=",
      "window=fortnight",
      "",
    ]) {
      expect({ query, ...resolve(query) }).toEqual({ query, ...defaulted });
    }
  });

  it("never turns half a pair into a window shaped like the one that was typed", () => {
    // The three repairs that must not happen for `?startDate=2026-08-01`:
    // 08-01..08-01, 08-01..today, and 08-01 + 28 days. Each is a window nobody
    // asked for wearing the shape of the one they did, and no reader can tell it
    // apart from a correct answer.
    const resolved = resolve("startDate=2026-08-01");
    expect(resolved.start).not.toBe("2026-08-01");
    expect(resolved.end).not.toBe(REFERENCE_DATE);
    expect(resolved.end).not.toBe("2026-08-01");
  });

  it("does not un-invert an inverted pair", () => {
    // Swapping the two would be a repair, and a plausible-looking one. The pair
    // is discarded whole.
    const resolved = resolve("startDate=2026-08-17&endDate=2026-08-11");
    expect(resolved).toEqual(defaulted);
    expect(resolved.start).not.toBe("2026-08-11");
  });

  it("distinguishes a fallback from a stated window, which is the whole point of `source`", () => {
    // The two can resolve to the very same days — `?window=28d` on this clock is
    // exactly the default's dates. Only `source` separates "the link asked for
    // this" from "the link asked for nothing", and only that difference tells
    // the surface whether it owes the operator a sentence about the exclusion.
    const stated = resolve("window=28d");
    const fell = resolve("");
    expect([stated.start, stated.end]).toEqual([fell.start, fell.end]);
    expect(stated.source).toBe("url");
    expect(fell.source).toBe("default");
  });
});
