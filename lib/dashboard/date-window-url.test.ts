import { describe, expect, it } from "vitest";

import {
  applyDateWindowToParams,
  canonicalDateWindowParams,
  carryDateWindowParams,
  hasDateWindowParams,
  readDateWindowFromParams,
} from "@/lib/dashboard/date-window-url";

/**
 * The wire format is the contract between surfaces that cannot see each other:
 * a client body reading a store, a server page reading a query string, and a
 * Decision Center with its own parser. These are the rules that keep one
 * picked window from becoming three different requests.
 */
describe("the dashboard date window on the URL", () => {
  const reference = "2026-08-17";

  it("states the absolute window, not just a preset name", () => {
    const params = applyDateWindowToParams(
      new URLSearchParams(),
      { rangePreset: "7d", customStart: "", customEnd: "" },
      reference,
    );
    expect(params.get("startDate")).toBe("2026-08-10");
    expect(params.get("endDate")).toBe("2026-08-16");
    expect(params.get("window")).toBe("7d");
  });

  it("keeps every other parameter, including the ones scope depends on", () => {
    const params = applyDateWindowToParams(
      new URLSearchParams(
        "businessId=biz_1&providerAccountId=act_1&lane=action&cursor=abc",
      ),
      { rangePreset: "28d", customStart: "", customEnd: "" },
      reference,
    );
    expect(params.get("businessId")).toBe("biz_1");
    expect(params.get("providerAccountId")).toBe("act_1");
    expect(params.get("lane")).toBe("action");
    expect(params.get("cursor")).toBe("abc");
  });

  /**
   * `components/meta/redesign/MetaPlatformPage.tsx` parses `?window` as one of
   * 7d/14d/28d/90d/custom and silently falls back to 28d for anything else. A
   * preset it cannot name must therefore travel as exact dates, or the
   * Decision Center answers for a window the operator did not pick.
   */
  it("never writes a window key the Decision Center would misread", () => {
    for (const preset of ["today", "yesterday", "3d", "30d", "365d", "thisMonth", "lastMonth"] as const) {
      const params = applyDateWindowToParams(
        new URLSearchParams(),
        { rangePreset: preset, customStart: "", customEnd: "" },
        reference,
      );
      expect(params.get("window")).toBe("custom");
      expect(params.get("startDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(params.get("endDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("reads back exactly the window it wrote", () => {
    const params = applyDateWindowToParams(
      new URLSearchParams(),
      { rangePreset: "custom", customStart: "2026-06-01", customEnd: "2026-06-09" },
      reference,
    );
    expect(readDateWindowFromParams(params)).toEqual({
      rangePreset: "custom",
      customStart: "2026-06-01",
      customEnd: "2026-06-09",
    });
  });

  it("recovers the preset name only when it resolves to those very dates", () => {
    const params = new URLSearchParams({
      window: "custom",
      startDate: "2026-08-16",
      endDate: "2026-08-16",
    });
    expect(
      readDateWindowFromParams(params, { referenceDate: reference }),
    ).toEqual({
      rangePreset: "yesterday",
      customStart: "2026-08-16",
      customEnd: "2026-08-16",
    });

    // One day off the preset is not that preset, and must not be labelled as
    // one: the label would then name a window nobody is requesting.
    const shifted = new URLSearchParams({
      window: "28d",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
    });
    expect(
      readDateWindowFromParams(shifted, { referenceDate: reference }),
    ).toEqual({
      rangePreset: "custom",
      customStart: "2026-07-21",
      customEnd: "2026-08-17",
    });
  });

  it("uses the stated dates verbatim when no clock is supplied", () => {
    const params = new URLSearchParams({
      window: "28d",
      startDate: "2026-07-20",
      endDate: "2026-08-16",
    });
    expect(readDateWindowFromParams(params)).toEqual({
      rangePreset: "custom",
      customStart: "2026-07-20",
      customEnd: "2026-08-16",
    });
  });

  /**
   * A malformed window is not repaired into a plausible one. It states
   * nothing, so the caller falls back to what it can actually name.
   */
  it("ignores a window that is not a window", () => {
    expect(
      readDateWindowFromParams(
        new URLSearchParams({ startDate: "yesterday", endDate: "2026-08-16" }),
      ),
    ).toBeNull();
    expect(
      readDateWindowFromParams(
        new URLSearchParams({ startDate: "2026-08-16", endDate: "2026-08-01" }),
      ),
    ).toBeNull();
    expect(
      readDateWindowFromParams(new URLSearchParams({ window: "fortnight" })),
    ).toBeNull();
    expect(hasDateWindowParams(new URLSearchParams())).toBe(false);
  });

  it("carries a stated window onto a link, and never overwrites one the link states", () => {
    const current = new URLSearchParams({
      window: "7d",
      startDate: "2026-08-10",
      endDate: "2026-08-16",
      businessId: "biz_1",
    });
    expect(
      carryDateWindowParams("/c/biz_1/meta/intelligence", current),
    ).toBe(
      "/c/biz_1/meta/intelligence?window=7d&startDate=2026-08-10&endDate=2026-08-16",
    );
    expect(
      carryDateWindowParams(
        "/c/biz_1/meta/intelligence?startDate=2026-01-01&endDate=2026-01-31",
        current,
      ),
    ).toBe("/c/biz_1/meta/intelligence?startDate=2026-01-01&endDate=2026-01-31");
    // Nothing stated, nothing carried: a link must not gain a window the
    // operator never picked.
    expect(
      carryDateWindowParams("/c/biz_1/meta/intelligence", new URLSearchParams()),
    ).toBe("/c/biz_1/meta/intelligence");
  });
});

/**
 * ITEM 10 — one authority, established before the first read.
 *
 * A URL with no window on it is not "no opinion". Every body below the shell
 * already has a private answer for it — `parseMetaWindow(null)` is 28 days,
 * the Intelligence route's own default is 28 days — while the shell's picker
 * had a fourth answer in localStorage that neither of them could see. These
 * pin the rule that removes the second authority instead of ordering it: the
 * stored selection is a SEED, written into the URL before anything reads it,
 * and a URL that already states a window is never restated.
 */
describe("canonicalizing the date window onto the URL", () => {
  const reference = "2026-08-17";
  const stored = {
    rangePreset: "90d" as const,
    customStart: "",
    customEnd: "",
  };

  it("states the persisted selection when the URL states no window", () => {
    const params = canonicalDateWindowParams(
      new URLSearchParams("businessId=biz_1&providerAccountId=act_1"),
      stored,
      reference,
    );
    expect(params?.get("window")).toBe("90d");
    expect(params?.get("startDate")).toBe("2026-05-19");
    expect(params?.get("endDate")).toBe("2026-08-16");
    // Canonicalizing the window is not a licence to edit the scope beside it.
    expect(params?.get("businessId")).toBe("biz_1");
    expect(params?.get("providerAccountId")).toBe("act_1");
  });

  it("leaves a URL that already states an exact window completely alone", () => {
    expect(
      canonicalDateWindowParams(
        new URLSearchParams("startDate=2026-07-01&endDate=2026-07-14"),
        stored,
        reference,
      ),
    ).toBeNull();
    // Even when the preset key disagrees with the dates: the dates are the
    // window, the key is a label, and restating would only be a chance to
    // disagree with what was already stated.
    expect(
      canonicalDateWindowParams(
        new URLSearchParams("window=7d&startDate=2026-07-01&endDate=2026-07-14"),
        stored,
        reference,
      ),
    ).toBeNull();
  });

  it("expands the preset the LINK names, never the one this browser stored", () => {
    const params = canonicalDateWindowParams(
      new URLSearchParams("window=7d"),
      stored,
      reference,
    );
    // A pasted `?window=7d` that opened on a stored 90 days would not
    // reproduce the window it names, which is the whole point of a link.
    expect(params?.get("window")).toBe("7d");
    expect(params?.get("startDate")).toBe("2026-08-10");
    expect(params?.get("endDate")).toBe("2026-08-16");
  });

  it("adopts the Creative Studio's legacy start/end pair instead of overruling it", () => {
    const params = canonicalDateWindowParams(
      new URLSearchParams("start=2026-06-01&end=2026-06-30"),
      stored,
      reference,
    );
    expect(params?.get("startDate")).toBe("2026-06-01");
    expect(params?.get("endDate")).toBe("2026-06-30");
    expect(params?.get("window")).toBe("custom");
    // The Studio body still reads its own spelling; both now name one window.
    expect(params?.get("start")).toBe("2026-06-01");
    expect(params?.get("end")).toBe("2026-06-30");
  });

  it("does not repair half a pair, an inverted pair, or a malformed one", () => {
    for (const query of [
      "startDate=2026-07-01",
      "endDate=2026-07-14",
      "startDate=2026-07-14&endDate=2026-07-01",
      "startDate=last-week&endDate=2026-07-14",
      "start=2026-07-01",
      "start=nonsense&end=2026-07-14",
    ]) {
      const params = canonicalDateWindowParams(
        new URLSearchParams(query),
        stored,
        reference,
      );
      // None of these is a window, so none of them becomes one. The stored
      // selection is stated over them rather than a plausible-looking window
      // being reconstructed out of the readable half.
      expect(params?.get("window")).toBe("90d");
      expect(params?.get("startDate")).toBe("2026-05-19");
      expect(params?.get("endDate")).toBe("2026-08-16");
    }
  });

  it("states nothing at all without a usable clock", () => {
    // A rolling preset cannot be expanded without a reference date, and
    // borrowing one is exactly how two surfaces came to hold two clocks.
    expect(
      canonicalDateWindowParams(new URLSearchParams(), stored, ""),
    ).toBeNull();
    expect(
      canonicalDateWindowParams(new URLSearchParams(), stored, "not-a-date"),
    ).toBeNull();
  });

  it("ends on yesterday, so no window counts a day that is still arriving", () => {
    const params = canonicalDateWindowParams(
      new URLSearchParams(),
      { rangePreset: "7d", customStart: "", customEnd: "" },
      reference,
    );
    expect(params?.get("endDate")).toBe("2026-08-16");
    expect(params?.get("endDate")).not.toBe(reference);
  });
});
