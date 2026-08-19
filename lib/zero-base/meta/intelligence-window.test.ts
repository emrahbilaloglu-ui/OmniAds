// @vitest-environment jsdom
/**
 * ITEM 13 — THE INTELLIGENCE WINDOW.
 *
 * Account Intelligence used to resolve its own window: 28 days ending on the
 * workspace's *today*. Two things were wrong with that and both are pinned here.
 *
 * - Today is a partial day. Counting it as a whole one understates every rate
 *   and inflates every per-day divisor, which is the budget-utilisation
 *   invariant in its other form. The rest of the app moved to completed days
 *   ending yesterday; this surface had not, so one click on the shell's picker
 *   named two different weeks.
 * - `?window=7d` was not read at all, so the preset key the shell itself writes
 *   produced 28 days ending today.
 *
 * WHAT CHANGED IN THIS FILE, AND WHY THE OLD FIRST BLOCK IS GONE.
 *
 * The previous version of this test opened with an equality block: it asserted
 * that this surface's PRIVATE expander (`expandWindowPreset`) produced the same
 * dates as the shared one, and that its private timezone reader
 * (`todayIsoInTimeZone`) produced the same day as `getTodayIsoForTimeZone`. That
 * block was the right test for a duplication that could not be removed —
 * `resolveDateWindowFromParams` reached a `"use client"` export and threw when
 * called from a Server Component, so this surface had to carry its own copy and
 * the copy had to be nailed to the original.
 *
 * The duplication is removable now and has been removed:
 * `lib/dashboard/date-window-presets.ts` owns the expansion with no client
 * boundary, so the shared resolver runs on a server. There is one expander, one
 * day-count table and one clock reader in the tree, so there is nothing left to
 * pin together — an equality test between a function and itself proves nothing.
 * What survives are assertions about BEHAVIOUR the surface promises, written as
 * concrete dates on a fixed clock so they fail if the shared expansion ever
 * changes meaning underneath them.
 */
import { describe, expect, it } from "vitest";

import {
  getPresetDatesForReferenceDate,
  getTodayIsoForTimeZone,
} from "@/lib/dashboard/date-window-presets";
import {
  DATE_WINDOW_INCLUDES_CURRENT_DAY,
  readDateWindowFromParams,
  resolveDateWindowFromParams,
  type DateWindowSelection,
} from "@/lib/dashboard/date-window-url";
import { DASHBOARD_V2_DEFAULT_DATE_RANGE } from "@/hooks/use-persistent-date-range";
import {
  INTELLIGENCE_DEFAULT_WINDOW_PRESET,
  resolveIntelligenceWindow,
} from "@/lib/zero-base/meta/intelligence-window";

/** TheSwaf's workspace clock — the live business this surface is scoped against. */
const REFERENCE_DATE = "2026-08-18";

/** The four keys `applyDateWindowToParams` can write, and the only ones that can
 *  arrive without dates. */
const SHARED_PRESETS = ["7d", "14d", "28d", "90d"] as const;

function params(query: string) {
  return new URLSearchParams(query);
}

/** The shared resolver's answer for the same URL, with the same default. */
function sharedAnswer(query: string) {
  const fallback: DateWindowSelection = {
    rangePreset: INTELLIGENCE_DEFAULT_WINDOW_PRESET,
    customStart: "",
    customEnd: "",
  };
  return resolveDateWindowFromParams(params(query), REFERENCE_DATE, fallback);
}

describe("there is one expansion in the tree, and this surface uses it", () => {
  it("ends every rolling preset on yesterday, because today is a part-day", () => {
    // The invariant, stated on the shared switch and then on the dates it
    // produces. If `DATE_WINDOW_INCLUDES_CURRENT_DAY` is ever flipped, the
    // second assertion fails rather than this surface quietly measuring a
    // part-day as a whole one.
    expect(DATE_WINDOW_INCLUDES_CURRENT_DAY).toBe(false);
    expect(
      resolveIntelligenceWindow({
        searchParams: params("window=7d"),
        referenceDate: REFERENCE_DATE,
      }),
    ).toEqual({ startDate: "2026-08-11", endDate: "2026-08-17", preset: "7d" });
  });

  it("expands every shared preset to exactly what the picker's own expander says", () => {
    // Not a self-comparison: the left side is the surface's public answer for a
    // URL, the right side is the vocabulary module the picker renders from.
    for (const preset of SHARED_PRESETS) {
      const shared = getPresetDatesForReferenceDate(
        preset,
        REFERENCE_DATE,
        undefined,
        undefined,
        { includeCurrentDay: DATE_WINDOW_INCLUDES_CURRENT_DAY },
      );
      expect(
        resolveIntelligenceWindow({
          searchParams: params(`window=${preset}`),
          referenceDate: REFERENCE_DATE,
        }),
      ).toEqual({ startDate: shared.start, endDate: shared.end, preset });
    }
  });

  it("no longer exports a private expander, day-count table or clock reader", async () => {
    // The duplication is deleted, not merely unused. An exported copy is an
    // invitation for the next caller to import it and drift, which is how this
    // surface came to measure a different week than the chip above it.
    const module = await import("@/lib/zero-base/meta/intelligence-window");
    expect(Object.keys(module).sort()).toEqual([
      "INTELLIGENCE_DEFAULT_WINDOW_PRESET",
      "resolveIntelligenceWindow",
    ]);
  });

  it("reads today on the workspace clock, exactly as the topbar does", () => {
    // The page now calls `getTodayIsoForTimeZone` itself — the very function
    // `components/layout/v2/app-topbar.tsx` calls — so "today" cannot differ
    // between the chip and the body. 22:30 UTC on the 11th is still the 11th in
    // New York and already the 12th in Istanbul; a UTC-only reading moved this
    // surface's window a day away from the chip above it.
    const at = new Date("2026-08-11T22:30:00.000Z");
    const asOf = (timeZone: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(at);
    expect(asOf("America/New_York")).toBe("2026-08-11");
    expect(asOf("Europe/Istanbul")).toBe("2026-08-12");
    // And the shared reader is the one that answers, for a real zone and for an
    // unusable one — a bad `businesses.timezone` row must not take the page down.
    expect(getTodayIsoForTimeZone("America/New_York")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(getTodayIsoForTimeZone("Not/AZone")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("defaults to the shell's own default preset, not a private one", () => {
    expect(INTELLIGENCE_DEFAULT_WINDOW_PRESET).toBe(
      DASHBOARD_V2_DEFAULT_DATE_RANGE.rangePreset,
    );
  });
});

describe("the window this surface reads is the window the URL states", () => {
  it("supports `?window=7d` alone — the preset key with no dates", () => {
    // The private resolver looked only for startDate/endDate, so this URL
    // silently produced 28 days ending today.
    expect(
      resolveIntelligenceWindow({
        searchParams: params("window=7d"),
        referenceDate: REFERENCE_DATE,
      }),
    ).toEqual({ startDate: "2026-08-11", endDate: "2026-08-17", preset: "7d" });
  });

  it("agrees with the shared resolver on every shared preset key", () => {
    for (const preset of SHARED_PRESETS) {
      const shared = sharedAnswer(`window=${preset}`);
      const mine = resolveIntelligenceWindow({
        searchParams: params(`window=${preset}`),
        referenceDate: REFERENCE_DATE,
      });
      expect({ start: mine.startDate, end: mine.endDate, preset: mine.preset }).toEqual({
        start: shared!.start,
        end: shared!.end,
        preset: shared!.preset,
      });
    }
  });

  it("takes a stated pair verbatim and never re-expands it", () => {
    // A window nobody could name is still the window: the dates are the fact,
    // the preset name is only a label for them.
    const mine = resolveIntelligenceWindow({
      searchParams: params("startDate=2026-03-02&endDate=2026-03-09"),
      referenceDate: REFERENCE_DATE,
    });
    expect(mine.startDate).toBe("2026-03-02");
    expect(mine.endDate).toBe("2026-03-09");
    expect(mine.preset).toBe("custom");
    const shared = sharedAnswer("startDate=2026-03-02&endDate=2026-03-09");
    expect([mine.startDate, mine.endDate]).toEqual([shared!.start, shared!.end]);
  });

  it("keeps the label when the stated dates are exactly what the stated key means", () => {
    const query = "window=7d&startDate=2026-08-11&endDate=2026-08-17";
    const mine = resolveIntelligenceWindow({
      searchParams: params(query),
      referenceDate: REFERENCE_DATE,
    });
    const shared = sharedAnswer(query);
    expect(mine).toEqual({
      startDate: shared!.start,
      endDate: shared!.end,
      preset: shared!.preset,
    });
    expect(mine.preset).toBe("7d");
  });

  it("names a self-contradicting URL by its DATES, not by the key that disagrees", () => {
    // RESTATED LAW, and the one assertion in this file that moved.
    //
    // `?window=7d` over a 14-day pair is a URL that contradicts itself. The
    // dates win — they are the stated fact — and the key is dropped. What the
    // label becomes is where this changed: the private `recoverPreset` could
    // only ever try the URL's own key, so it fell to "custom" and the surface
    // reported a nameable window as unnameable. The shared reader scans the
    // picker's full preset vocabulary, so these two days are recognised as what
    // they are — "Last 14 days" on this clock, the same name the picker itself
    // would recover for them. THE DATES ARE UNCHANGED AND STILL VERBATIM; only
    // the name got more accurate, and it is now the picker's own answer rather
    // than a second opinion about it.
    const query = "window=7d&startDate=2026-08-04&endDate=2026-08-17";
    const mine = resolveIntelligenceWindow({
      searchParams: params(query),
      referenceDate: REFERENCE_DATE,
    });
    expect(mine).toEqual({
      startDate: "2026-08-04",
      endDate: "2026-08-17",
      preset: "14d",
    });
    // The name the picker recovers for the very same URL. Same function, so the
    // topbar and the server cannot put two names on one window.
    expect(
      readDateWindowFromParams(params(query), { referenceDate: REFERENCE_DATE })
        ?.rangePreset,
    ).toBe("14d");
    // And it is not the key that was written, which is the half that matters:
    // the contradicting key must not survive as the label.
    expect(mine.preset).not.toBe("7d");
  });
});

describe("a malformed or half-stated window falls back — it is never repaired", () => {
  const canonical = { startDate: "2026-07-21", endDate: "2026-08-17", preset: "28d" };

  it("resolves the canonical default for an unusable pair, matching the shared resolver", () => {
    // STATED, because ITEM 13 asks which of the two it is: this surface
    // FALLS BACK TO THE CANONICAL DEFAULT and does not fail closed. The reason
    // is in the module header — the resolved dates are printed verbatim on the
    // surface, so a fallback is visible, whereas a blank page would be no more
    // honest and would make Intelligence the one surface that stops reading
    // where every client surface keeps going.
    for (const query of [
      "startDate=2026-08-01&endDate=nope",
      "startDate=2026-08-01",
      "endDate=2026-08-17",
      "startDate=2026-08-20&endDate=2026-08-01",
      "startDate=&endDate=",
      "window=fortnight",
      "",
    ]) {
      const mine = resolveIntelligenceWindow({
        searchParams: params(query),
        referenceDate: REFERENCE_DATE,
      });
      expect({ query, ...mine }).toEqual({ query, ...canonical });
      const shared = sharedAnswer(query);
      expect({ query, start: mine.startDate, end: mine.endDate }).toEqual({
        query,
        start: shared!.start,
        end: shared!.end,
      });
    }
  });

  it("never turns half a pair into a window shaped like the one that was typed", () => {
    // The repair that must not happen: `startDate=2026-08-01` becoming
    // 08-01..08-01, or 08-01..today, or 08-01 + 28 days. Any of those is a
    // window nobody asked for wearing the shape of the one they did, and no
    // reader can tell it apart from a correct answer.
    const mine = resolveIntelligenceWindow({
      searchParams: params("startDate=2026-08-01"),
      referenceDate: REFERENCE_DATE,
    });
    expect(mine.startDate).not.toBe("2026-08-01");
    expect(mine.endDate).not.toBe(REFERENCE_DATE);
  });

  it("still honours a usable `window` key when the dates beside it are unusable", () => {
    // This is what keeps the topbar and the server together in the one case the
    // server cannot otherwise close: the shell writes the key beside the dates,
    // so a truncated or mangled pair still leaves the length stated.
    expect(
      resolveIntelligenceWindow({
        searchParams: params("window=90d&startDate=2026-08-01&endDate=nope"),
        referenceDate: REFERENCE_DATE,
      }),
    ).toEqual({ startDate: "2026-05-20", endDate: "2026-08-17", preset: "90d" });
  });

  it("still resolves a window when the workspace timezone is unusable", () => {
    // THE LAW, stated where it is actually enforced. A bad `businesses.timezone`
    // row must not take this page down — but the guarantee does NOT live in this
    // module. `getPresetDatesForReferenceDate` parses its reference date and
    // throws `RangeError: Invalid time value` on anything that is not an ISO
    // day, which is correct: a rolling preset cannot be expanded without a
    // clock, and inventing one is how two surfaces came to hold two clocks.
    //
    // The guarantee is upstream, in the one clock reader both the topbar and
    // this page now call: `getTodayIsoForTimeZone` falls back to UTC for a zone
    // `Intl` cannot resolve and therefore always answers with an ISO day. So the
    // composition the page actually performs is total, and this asserts the
    // composition rather than a property this module does not have.
    const referenceDate = getTodayIsoForTimeZone("Not/AZone");
    expect(referenceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const mine = resolveIntelligenceWindow({ searchParams: params(""), referenceDate });
    expect(mine.preset).toBe("28d");
    expect(mine.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mine.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 28 completed days ending yesterday, on whatever day the runner is on.
    expect(mine.endDate < referenceDate).toBe(true);
  });
});
