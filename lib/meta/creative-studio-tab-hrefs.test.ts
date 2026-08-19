/**
 * ITEM 17 — the ONE Creative Studio tab href builder.
 *
 * The defect this pins: two of the five Studio tabs (Landers, Audiences) built
 * their links through `dashboardHrefForRouteFamily(buildMetaScopedHref(...))`,
 * which emits the business and the account and NO window at all — so a sideways
 * step out of either one silently reset the operator's range to whatever the
 * destination had stored. Every assertion below is about a fact surviving one
 * click: the route family, the business, the account, and the window in both
 * spellings that are live in links today.
 */
import { describe, expect, it } from "vitest";

import { buildCreativeStudioTabHrefs } from "@/lib/meta/creative-studio-tab-hrefs";

const WINDOW = { start: "2026-07-01", end: "2026-07-28" };
const TABS = ["assets", "copies", "landing-pages", "inbox", "audiences"] as const;

describe("buildCreativeStudioTabHrefs", () => {
  it("keeps every tab inside the route family it was clicked from", () => {
    const scope = { businessId: "biz/1", providerAccountId: "act_1", ...WINDOW };

    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/c/biz%2F1/creative/performance",
      }).copies,
    ).toBe(
      "/c/biz%2F1/creative/copies?providerAccountId=act_1&window=custom" +
        "&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/app/creative/performance",
      }).inbox,
    ).toBe(
      "/app/creative/inbox?providerAccountId=act_1&window=custom" +
        "&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/platforms/meta/creatives",
      }).audiences,
    ).toBe(
      "/platforms/meta/audiences?businessId=biz%2F1&providerAccountId=act_1" +
        "&window=custom&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
  });

  /**
   * The business travels in the query only where the PATH does not already
   * state it. `/c/:id/...` and `/app/...` resolve the business from the route
   * and the session; restating it in the query would add a second,
   * contradictable answer to a question the route already answers.
   */
  it("states the business in the query only on the unscoped legacy family", () => {
    const scoped = buildCreativeStudioTabHrefs({
      pathname: "/c/biz_1/creative/audiences",
      businessId: "biz_1",
      providerAccountId: "act_1",
      ...WINDOW,
    });
    const legacy = buildCreativeStudioTabHrefs({
      pathname: "/platforms/meta/audiences",
      businessId: "biz_1",
      providerAccountId: "act_1",
      ...WINDOW,
    });

    expect(scoped.assets).not.toContain("businessId=");
    expect(legacy.assets).toContain("businessId=biz_1");
  });

  /**
   * All five tabs, not four. The bug was never "no tab carries the window" —
   * it was that SOME did, which is what made a walk look like it worked.
   */
  it("carries the account and the window on all five tabs", () => {
    const hrefs = buildCreativeStudioTabHrefs({
      pathname: "/platforms/meta/audiences",
      businessId: "biz_1",
      providerAccountId: "act_1",
      ...WINDOW,
    });

    for (const tab of TABS) {
      expect(hrefs[tab]).toContain("providerAccountId=act_1");
      expect(hrefs[tab]).toContain("startDate=2026-07-01");
      expect(hrefs[tab]).toContain("endDate=2026-07-28");
      expect(hrefs[tab]).toContain("start=2026-07-01");
      expect(hrefs[tab]).toContain("end=2026-07-28");
    }
  });

  /**
   * Both spellings, from ONE resolved pair.
   *
   * `startDate`/`endDate` is what the shell's date control writes and what
   * `usePersistentDateRange` and `windowFromSearchParams` read first;
   * `start`/`end` is the Studio's older pair, still read by
   * `scopeFromSearchParams` on the shares/briefs/detail routes. Emitting only
   * one of them would un-window half the readers that exist, and emitting them
   * from two separate resolutions is how a link comes to name two windows.
   */
  it("writes both live spellings of the same two days", () => {
    const href = buildCreativeStudioTabHrefs({
      pathname: "/platforms/meta/audiences",
      businessId: "biz_1",
      providerAccountId: "act_1",
      ...WINDOW,
    }).copies;
    const params = new URLSearchParams(href.split("?", 2)[1]);

    expect(params.get("startDate")).toBe(params.get("start"));
    expect(params.get("endDate")).toBe(params.get("end"));
    expect(params.get("startDate")).toBe(WINDOW.start);
    expect(params.get("endDate")).toBe(WINDOW.end);
  });

  /**
   * `window=custom` is the law, not a shortcut.
   *
   * The exact dates ARE the window (rule 1 of `lib/dashboard/date-window-url.ts`).
   * Naming a rolling preset would invite the destination to re-expand "7d"
   * against ITS clock and measure two different days from the surface the
   * operator just left; `custom` is precisely the key that means "honour these
   * dates verbatim". The picker still displays "Last 7 days", because the label
   * is recovered from the dates rather than carried as authority.
   */
  it("states the window as custom so the destination cannot re-expand a preset", () => {
    const href = buildCreativeStudioTabHrefs({
      pathname: "/platforms/meta/audiences",
      businessId: "biz_1",
      providerAccountId: "act_1",
      // Exactly seven completed days — a "Last 7 days" selection.
      start: "2026-08-11",
      end: "2026-08-17",
    }).assets;

    expect(new URLSearchParams(href.split("?", 2)[1]).get("window")).toBe("custom");
  });

  /**
   * A half or malformed window is NOT a window.
   *
   * Repairing it would let a mistyped URL become the measured range. Carrying
   * nothing lets the destination keep the operator's own range, which is the
   * honest fallback — and is what the Inbox relies on, since it passes empty
   * bounds whenever the request named no window.
   */
  it("carries no window at all when the pair is half, inverted or malformed", () => {
    const base = {
      pathname: "/platforms/meta/audiences",
      businessId: "biz_1",
      providerAccountId: "act_1",
    };

    for (const pair of [
      { start: "2026-07-01", end: "" },
      { start: "", end: "2026-07-28" },
      { start: "", end: "" },
      { start: "2026-07-28", end: "2026-07-01" },
      { start: "2026-02-30", end: "2026-03-14" },
      { start: "yesterday", end: "2026-03-14" },
    ]) {
      const href = buildCreativeStudioTabHrefs({ ...base, ...pair }).assets;
      expect(href).toBe(
        "/platforms/meta/creatives?businessId=biz_1&providerAccountId=act_1",
      );
    }
  });

  /** No account resolved yet is not a reason to invent one on the link. */
  it("omits the account rather than inventing one", () => {
    const href = buildCreativeStudioTabHrefs({
      pathname: "/platforms/meta/audiences",
      businessId: "biz_1",
      providerAccountId: "",
      ...WINDOW,
    }).assets;

    expect(href).not.toContain("providerAccountId");
    expect(href).toContain("startDate=2026-07-01");
  });
});
