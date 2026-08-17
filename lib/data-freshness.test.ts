import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_FRESHNESS, readFreshness } from "@/lib/data-freshness";

const now = new Date("2026-08-08T12:00:00.000Z");

describe("age is stated, never implied", () => {
  it("reports recent data as fresh with its age", () => {
    const reading = readFreshness("2026-08-08T11:40:00.000Z", now);
    expect(reading.level).toBe("fresh");
    expect(reading.ageLabel).toBe("20m ago");
  });

  it("warns once data is old enough to matter", () => {
    expect(readFreshness("2026-08-08T09:00:00.000Z", now).level).toBe("aging");
  });

  it("calls day-old data stale", () => {
    const reading = readFreshness("2026-08-07T06:00:00.000Z", now);
    expect(reading.level).toBe("stale");
    expect(reading.description).toContain("may no longer reflect");
  });

  it("says it does not know rather than implying data is current", () => {
    for (const value of [null, undefined, "", "not-a-date"]) {
      const reading = readFreshness(value as string | null, now);
      expect(reading.level).toBe("unknown");
      expect(reading.ageLabel).toBeNull();
      expect(reading.description).toContain("cannot say");
    }
  });

  it("treats a future timestamp as untrustworthy, not as fresh", () => {
    const reading = readFreshness("2026-08-08T18:00:00.000Z", now);
    expect(reading.level).toBe("unknown");
    expect(reading.description).toContain("in the future");
  });

  it("tolerates small clock skew without calling it unknown", () => {
    expect(readFreshness("2026-08-08T12:00:30.000Z", now).level).toBe("fresh");
  });

  it("scales the label from minutes to days", () => {
    expect(readFreshness("2026-08-08T11:59:50.000Z", now).ageLabel).toBe("just now");
    expect(readFreshness("2026-08-08T09:00:00.000Z", now).ageLabel).toBe("3h ago");
    expect(readFreshness("2026-08-05T12:00:00.000Z", now).ageLabel).toBe("3d ago");
  });

  it("uses thresholds a daily operator would recognise", () => {
    expect(DEFAULT_FRESHNESS.agingAfterMinutes).toBeLessThanOrEqual(120);
    expect(DEFAULT_FRESHNESS.staleAfterMinutes).toBeLessThanOrEqual(48 * 60);
  });
});

describe("the Overview surface discloses its own age through the exact shell", () => {
  const page = readFileSync("app/(dashboard)/overview/legacy-page.tsx", "utf8");
  const signals = readFileSync(
    "components/layout/v2/use-shell-signals.ts",
    "utf8",
  );
  const topbar = readFileSync("components/layout/v2/app-topbar.tsx", "utf8");

  it("publishes the surface reading into the single shell chip", () => {
    expect(page).toContain("useTierZeroFreshness({");
    expect(page).toContain('surface: "overview"');
    expect(page).toContain("asOf: dataAsOf");
    expect(signals).toContain("activeSurfaceForBusiness");
    expect(signals).toContain("minutesSince(activeSurfaceForBusiness.asOf, now)");
    expect(topbar).toContain('data-freshness-state={sync.freshnessState}');
  });

  it("dates itself from the data, not from when the request came back", () => {
    // This assertion used to require `query.dataUpdatedAt`, which is React
    // Query's record of when the *response landed*. That is fresh by
    // construction -- it resets on every refetch no matter how far behind the
    // sync is -- so the surface could report "as of just now" over a warehouse
    // that stopped updating a week ago. The payload's own sync timestamp is the
    // only thing that answers how old the figures are.
    expect(page).toContain("shopifyServing?.lastSyncedAt");
    expect(page).toContain("measuredAsOf(");
    expect(
      page.includes("dataAsOf={query.dataUpdatedAt"),
      "the fetch time is being presented as the data's age",
    ).toBe(false);
  });

  it("registers a bounded retry that refetches its reads rather than reloading", () => {
    expect(page).toContain("onRetry: () => {");
    expect(page).toContain("void query.refetch();");
    expect(page).not.toMatch(/window\.location\.(?:reload|assign|replace)/);
  });
});
