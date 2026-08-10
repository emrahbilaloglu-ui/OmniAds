import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isMeasuredInstant,
  measuredAsOf,
  newestObservation,
} from "@/lib/tier-zero-as-of";

/**
 * What a Tier-0 surface is allowed to call an as-of.
 *
 * Six surfaces answered "how old is this data" with something else and
 * presented it as that answer: a fetch time, today's calendar date, an echoed
 * request parameter, a content edit timestamp, an account signup date. Each is
 * a known value standing in for an unknown one, which is the failure the whole
 * freshness contract exists to remove — so it needs a test, not just a fix.
 */
const SURFACES: Array<{ label: string; file: string }> = [
  { label: "Overview", file: "app/(dashboard)/overview/page.tsx" },
  { label: "Integrations", file: "app/(dashboard)/integrations/page.tsx" },
  { label: "Settings", file: "app/(dashboard)/settings/page.tsx" },
  { label: "Reports", file: "app/(dashboard)/reports/page.tsx" },
  {
    label: "Creative Studio",
    file: "app/(dashboard)/platforms/meta/creatives/page.tsx",
  },
  {
    label: "Google Ads",
    file: "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  },
  { label: "Decisions", file: "components/meta/os/DecisionsOsView.tsx" },
  {
    label: "History",
    file: "app/(dashboard)/platforms/meta/history/history-view.tsx",
  },
];

/** The `asOf:` expression inside a surface's useTierZeroFreshness call. */
function asOfExpression(source: string): string | null {
  const call = source.indexOf("useTierZeroFreshness({");
  if (call < 0) return null;
  const body = source.slice(call, call + 2000);
  const match = /\n\s*asOf:\s*([^\n]*(?:\n(?!\s*\w+:)[^\n]*)*)/.exec(body);
  return match ? match[1] : null;
}

describe("no surface dates itself from something that is not a measurement", () => {
  for (const surface of SURFACES) {
    it(`${surface.label} does not present the fetch time as the data's age`, () => {
      const asOf = asOfExpression(readFileSync(surface.file, "utf8"));
      expect(asOf, `${surface.file} has no asOf`).not.toBeNull();
      // dataUpdatedAt is when the response landed. It resets on every refetch,
      // so a surface using it is fresh by construction and can never go stale.
      expect(
        asOf!.includes("dataUpdatedAt"),
        `${surface.file} reports the age of the request as the age of the data`,
      ).toBe(false);
    });
  }

  it("Google does not use the account's calendar date", () => {
    const source = readFileSync(
      "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
      "utf8",
    );
    const asOf = asOfExpression(source)!;
    // currentDateInTimezone is what day it is, not when anything was read.
    expect(asOf).not.toContain("ReferenceDate");
    expect(asOf).toContain("latestObservationAt");
  });

  it("Creative Studio does not echo back the as-of it asked for", () => {
    const asOf = asOfExpression(
      readFileSync("app/(dashboard)/platforms/meta/creatives/page.tsx", "utf8"),
    )!;
    // source.asOf is the client's own request parameter returned by the route.
    expect(asOf).not.toContain("source?.asOf");
    expect(asOf).not.toContain("source.asOf");
  });

  it("Settings does not use the account creation date", () => {
    const asOf = asOfExpression(
      readFileSync("app/(dashboard)/settings/page.tsx", "utf8"),
    )!;
    expect(asOf).not.toContain("accountCreatedAt");
    expect(asOf).toContain("settingsReadAt");
  });

  it("Reports does not use the newest report's edit time", () => {
    const asOf = asOfExpression(
      readFileSync("app/(dashboard)/reports/page.tsx", "utf8"),
    )!;
    expect(asOf).not.toContain("[0]?.updatedAt");
    expect(asOf).toContain("generatedAt");
  });
});

describe("a calendar date is never an observation time", () => {
  it("rejects a bare date", () => {
    // 2026-08-09 parses as UTC midnight. On a UTC+3 account at 01:10 local that
    // is 110 minutes in the future; on a UTC-7 account at 07:00 UTC it is 31
    // hours old. Same data, same moment, three different ages.
    expect(isMeasuredInstant("2026-08-09")).toBe(false);
    expect(measuredAsOf("2026-08-09")).toBeNull();
  });

  it("accepts a real instant", () => {
    expect(isMeasuredInstant("2026-08-09T06:00:00.000Z")).toBe(true);
    expect(measuredAsOf("2026-08-09T06:00:00.000Z")).toBe(
      "2026-08-09T06:00:00.000Z",
    );
  });

  it("treats nothing and nonsense as unknown rather than guessing", () => {
    expect(measuredAsOf(null)).toBeNull();
    expect(measuredAsOf(undefined)).toBeNull();
    expect(measuredAsOf("not a date")).toBeNull();
    expect(measuredAsOf("")).toBeNull();
  });
});

describe("the newest observation across scopes", () => {
  it("takes the most recent, because the question is how recently we saw anything", () => {
    expect(
      newestObservation([
        "2026-08-01T00:00:00.000Z",
        "2026-08-09T00:00:00.000Z",
        "2026-08-05T00:00:00.000Z",
      ]),
    ).toBe("2026-08-09T00:00:00.000Z");
  });

  it("is null when nothing was observed, rather than falling back to now", () => {
    expect(newestObservation([])).toBeNull();
    expect(newestObservation([null, undefined, ""])).toBeNull();
  });

  it("ignores values it cannot parse instead of counting them as recent", () => {
    expect(newestObservation(["nonsense", "2026-08-01T00:00:00.000Z"])).toBe(
      "2026-08-01T00:00:00.000Z",
    );
    expect(newestObservation(["nonsense"])).toBeNull();
  });
});

describe("a reading never settles before the read that determines it", () => {
  /**
   * The reading has to cover the query that supplies its own as-of.
   *
   * Google's as-of and partial reason both come from the status query, but only
   * the campaigns query fed `isLoading`. So while the status read was in
   * flight the surface reported "ready, age unknown", then flipped to "partial"
   * when it landed. The six-width evidence made it obvious: four widths
   * reported partial and two reported ready in a single run over identical
   * data, purely by when the DOM was sampled.
   *
   * A reading that means different things depending on when you look is not a
   * reading. If a query provides the as-of, its load state has to be part of
   * the state.
   */
  const dashboard = readFileSync(
    "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
    "utf8",
  );

  it("Google waits for the status read that carries its as-of", () => {
    const call = dashboard.slice(
      dashboard.indexOf("useTierZeroFreshness({"),
      dashboard.indexOf("useTierZeroFreshness({") + 1400,
    );
    // The as-of and the partial reason both come from syncStatus.freshness.
    expect(call).toContain("syncStatus?.freshness");
    // So the status read's own load and error state must be part of the state.
    expect(call).toContain("isSyncStatusLoading");
    expect(call).toContain("isSyncStatusError");
  });
});

describe("no Tier-0 surface settles for \"age unknown\" by default", () => {
  /**
   * "Age unknown" is an honest answer to an unanswerable question, not a
   * resting place. Four surfaces were reporting it because their routes
   * published only date-range labels — which was true, and was also a reason to
   * change the routes rather than to leave the operator without an age. Each
   * now publishes a measured instant:
   *
   * - the briefing route: MAX(computed_at) over the snapshot rows
   * - the copies route: MAX(updated_at) over the warehouse rows in the window
   * - the GA4 route: the retrieval time, stamped at the live fetch and carried
   *   by the cache so a cache hit does not restamp itself as fresh
   *
   * A surface hardcoding `asOf: null` now fails here, so the next one has to
   * either find a real timestamp or argue the case in this list.
   */
  const HARDCODED_NULL_ALLOWED = new Set<string>([
    // Launchpad composes from live reads that publish no observation time. It
    // is a wizard, not a data view, and shows no historical figures.
    "app/(dashboard)/platforms/meta/launchpad/page.tsx",
  ]);

  const DATA_SURFACES = [
    "app/(dashboard)/platforms/meta/creatives/page.tsx",
    "app/(dashboard)/platforms/meta/copies/page.tsx",
    "app/(dashboard)/platforms/meta/creative-inbox/page.tsx",
    "app/(dashboard)/platforms/meta/landing-pages/page.tsx",
  ];

  for (const file of DATA_SURFACES) {
    it(`${file.split("/").slice(-2)[0]} reports a measured instant`, () => {
      const asOf = asOfExpression(readFileSync(file, "utf8"));
      expect(asOf, `${file} has no asOf`).not.toBeNull();
      expect(
        /^\s*null\s*,?\s*$/.test(asOf!),
        `${file} hardcodes asOf: null; publish a measured timestamp instead`,
      ).toBe(HARDCODED_NULL_ALLOWED.has(file));
      expect(asOf).toContain("measuredAsOf(");
    });
  }

  it("the routes publish the timestamps those surfaces read", () => {
    // The surface and the route have to agree, or the surface silently falls
    // back to "age unknown" and looks like a deliberate choice again.
    expect(
      readFileSync("app/api/creatives/briefing/route.ts", "utf8"),
    ).toContain("MAX(latest_snapshots.computed_at) AS observed_at");
    expect(readFileSync("app/api/meta/copies/route.ts", "utf8")).toContain(
      "MAX(updated_at) AS observed_at",
    );
    expect(
      readFileSync(
        "app/api/analytics/landing-page-performance/route.ts",
        "utf8",
      ),
    ).toContain("retrievedAt: new Date().toISOString()");
  });

  it("does not restamp a cached GA4 response as freshly retrieved", () => {
    const route = readFileSync(
      "app/api/analytics/landing-page-performance/route.ts",
      "utf8",
    );
    const cacheHit = route.slice(
      route.indexOf("if (cached)"),
      route.indexOf("if (cached)") + 120,
    );
    expect(cacheHit).not.toContain("retrievedAt");
  });
});
