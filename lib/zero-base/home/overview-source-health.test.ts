/**
 * Source readiness and the trend series, for the mounted Overview.
 *
 * The panel exists to answer one question before the operator reads any
 * conclusion: are the sources behind these numbers serving? Three states have
 * to stay apart to answer it, and collapsing any two is the defect:
 *
 * - **not connected** — the source was never wired up;
 * - **connected but behind** — the numbers are real and incomplete, which is
 *   the state that produces a page that looks finished and is not;
 * - **not read** — we do not know, and saying "not connected" here would be
 *   advice given without evidence.
 */
import { describe, expect, it } from "vitest";

import {
  OVERVIEW_SOURCE_STALE_AFTER_MS,
  buildOverviewSourceHealth,
  overviewTrendPoints,
} from "./overview-source-health";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const CONNECTED = {
  meta: true,
  google: true,
  shopify: true,
  ga4: false,
  search_console: false,
};

describe("source readiness", () => {
  it("reports a connected source with a recent sync as serving", () => {
    const rows = buildOverviewSourceHealth({
      integrations: CONNECTED,
      latestSync: { meta: "2026-08-26T06:00:00.000Z" },
      now: NOW,
    });

    const meta = rows.find((row) => row.key === "meta")!;
    expect(meta.state).toBe("ok");
    expect(meta.freshness).toBe("fresh");
    expect(meta.reason).toBeNull();
    expect(meta.lastUpdatedAt).toBe("2026-08-26T06:00:00.000Z");
  });

  it("reports a connected source whose sync is behind as partial, not ok", () => {
    const rows = buildOverviewSourceHealth({
      integrations: CONNECTED,
      latestSync: {
        meta: new Date(NOW - OVERVIEW_SOURCE_STALE_AFTER_MS - 1_000).toISOString(),
      },
      now: NOW,
    });

    const meta = rows.find((row) => row.key === "meta")!;
    // Real numbers, and behind. Neither "serving" nor "unavailable" says that.
    expect(meta.state).toBe("partial");
    expect(meta.freshness).toBe("stale");
    expect(meta.reason).toContain("more than a day old");
    expect(meta.remedy).toBe("reconnect");
  });

  it("never claims freshness without a timestamp to claim it from", () => {
    const rows = buildOverviewSourceHealth({
      integrations: CONNECTED,
      latestSync: {},
      now: NOW,
    });

    // Connected, and nothing is known about when it last ran.
    const shopify = rows.find((row) => row.key === "shopify")!;
    expect(shopify.state).toBe("ok");
    expect(shopify.freshness).toBe("unknown");
    expect(shopify.lastUpdatedAt).toBeNull();
  });

  it("says not connected, with a way to connect", () => {
    const rows = buildOverviewSourceHealth({
      integrations: CONNECTED,
      latestSync: {},
      now: NOW,
    });

    const ga4 = rows.find((row) => row.key === "ga4")!;
    expect(ga4.state).toBe("unavailable");
    expect(ga4.reason).toBe("Not connected for this business.");
    expect(ga4.remedy).toBe("connect");
  });

  it("distinguishes an unread status from a disconnected source", () => {
    const rows = buildOverviewSourceHealth({
      integrations: null,
      latestSync: {},
      now: NOW,
    });

    for (const row of rows) {
      expect(row.state).toBe("unavailable");
      // The READ failed. "Not connected" would be advice given without
      // knowing whether the source is already connected.
      expect(row.reason).toContain("did not complete");
      expect(row.remedy).toBe("details");
    }
  });

  it("keeps the five sources this page's numbers are built from, in order", () => {
    expect(
      buildOverviewSourceHealth({ integrations: CONNECTED, now: NOW }).map(
        (row) => row.key,
      ),
    ).toEqual(["meta", "google", "shopify", "ga4", "search_console"]);
  });
});

describe("the trend series", () => {
  it("derives daily ROAS from the served revenue and spend", () => {
    expect(
      overviewTrendPoints([
        { date: "2026-08-24", spend: 100, revenue: 250 },
        { date: "2026-08-25", spend: 200, revenue: 300 },
      ]),
    ).toEqual([
      { date: "2026-08-24", spend: 100, roas: 2.5 },
      { date: "2026-08-25", spend: 200, roas: 1.5 },
    ]);
  });

  it("leaves a day with no spend without a ROAS", () => {
    const [point] = overviewTrendPoints([
      { date: "2026-08-24", spend: 0, revenue: 40 },
    ]);
    /*
     * The ratio is undefined, not bad. A line that dives to the axis on a day
     * nobody spent is a claim about performance that was never measured — and
     * Infinity would be worse.
     */
    expect(point!.roas).toBeNull();
    expect(point!.spend).toBe(0);
  });

  it("passes a non-finite figure through as absent rather than as zero", () => {
    const [point] = overviewTrendPoints([
      { date: "2026-08-24", spend: Number.NaN, revenue: 40 },
    ]);
    expect(point!.spend).toBeNull();
    expect(point!.roas).toBeNull();
  });
});
