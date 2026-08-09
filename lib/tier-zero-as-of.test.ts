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
