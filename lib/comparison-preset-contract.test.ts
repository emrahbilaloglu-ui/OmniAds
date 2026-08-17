import { describe, expect, it } from "vitest";

import {
  COMPARISON_PRESET_TO_COMPARE_MODE,
  compareModeForPreset,
  customComparisonIsComplete,
} from "@/lib/comparison-preset-contract";
import { COMPARISON_PRESET_VALUES } from "@/components/date-range/DateRangePicker";
import { getComparisonWindow } from "@/lib/google-ads/reporting-support";

/**
 * The picker and the server have to mean the same thing by a comparison.
 *
 * They did not. The picker offered eight comparisons and the dashboard turned
 * every non-"none" choice into `previous_period`, so an operator who picked
 * "Previous year" got a previous-*period* delta presented as the one they
 * asked for. Not a missing feature — a wrong number with no way to tell.
 *
 * Four of those eight had no server implementation at all. They are gone from
 * the picker rather than quietly aliased: offering a choice that silently
 * resolves to a different one is worse than not offering it.
 */
describe("every offered preset resolves to a comparison the server computes", () => {
  it("offers exactly the presets the contract maps", () => {
    expect([...COMPARISON_PRESET_VALUES].sort()).toEqual(
      Object.keys(COMPARISON_PRESET_TO_COMPARE_MODE).sort(),
    );
  });

  for (const preset of COMPARISON_PRESET_VALUES) {
    it(`${preset} produces a real comparison window`, () => {
      const mode = compareModeForPreset(preset);
      const window = getComparisonWindow({
        compareMode: mode,
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        compareStart: "2026-01-01",
        compareEnd: "2026-01-31",
      });

      if (preset === "none") {
        expect(window).toBeNull();
        return;
      }
      // A preset that reached here with no window would be one the picker
      // offers and the server silently ignores.
      expect(window, `${preset} produced no comparison window`).not.toBeNull();
      expect(window!.mode).toBe(mode);
    });
  }

  it("computes a distinct window per preset, so the choice actually changes the baseline", () => {
    const args = { startDate: "2026-03-01", endDate: "2026-03-31" };
    const previousPeriod = getComparisonWindow({
      ...args,
      compareMode: compareModeForPreset("previousPeriod"),
    });
    const previousYear = getComparisonWindow({
      ...args,
      compareMode: compareModeForPreset("previousYear"),
    });
    // This is the assertion the old code could not have passed: it collapsed
    // both to the same window.
    expect(previousYear!.startDate).not.toBe(previousPeriod!.startDate);
    expect(previousYear!.startDate).toBe("2025-03-01");
    expect(previousPeriod!.startDate).toBe("2026-01-29");
  });
});

describe("an unknown preset shows no comparison rather than a confident one", () => {
  it("resolves a retired preset to none, not to previous_period", () => {
    // A stored saved view or a hand-edited URL can still carry previousWeek.
    // Falling back to previous_period would show a delta against a baseline
    // the operator never chose — exactly the original defect.
    expect(compareModeForPreset("previousWeek")).toBe("none");
    expect(compareModeForPreset("previousQuarter")).toBe("none");
    expect(compareModeForPreset("previousYearMatch")).toBe("none");
    expect(compareModeForPreset("nonsense")).toBe("none");
    expect(compareModeForPreset(null)).toBe("none");
    expect(compareModeForPreset(undefined)).toBe("none");
  });
});

describe("a custom comparison needs both ends", () => {
  it("is incomplete without either date", () => {
    expect(customComparisonIsComplete({ comparisonStart: "2026-01-01", comparisonEnd: null })).toBe(false);
    expect(customComparisonIsComplete({ comparisonStart: null, comparisonEnd: "2026-01-31" })).toBe(false);
    expect(customComparisonIsComplete({})).toBe(false);
  });

  it("is complete with both", () => {
    expect(
      customComparisonIsComplete({
        comparisonStart: "2026-01-01",
        comparisonEnd: "2026-01-31",
      }),
    ).toBe(true);
  });

  it("the server refuses an incomplete custom window rather than substituting one", () => {
    expect(
      getComparisonWindow({
        compareMode: "custom",
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        compareStart: null,
        compareEnd: null,
      }),
    ).toBeNull();
  });
});

describe("the dashboard sends what the operator picked", () => {
  it("no longer collapses every choice to previous_period", async () => {
    const { readFileSync } = await import("node:fs");
    const dashboard = readFileSync(
      "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
      "utf8",
    );
    expect(dashboard).toContain("compareModeForPreset(dateRange.comparisonPreset)");
    expect(dashboard).not.toContain(
      'comparisonPreset === "none" ? "none" : "previous_period"',
    );
    // An incomplete custom window falls back to showing no comparison, not to
    // a guessed one.
    expect(dashboard).toContain("customComparisonIsComplete");
    expect(dashboard).toContain("effectiveCompareMode");
  });
});

describe("no surface offers a comparison it does not read", () => {
  const read = async (file: string) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(file, "utf8");
  };

  it("Overview offers only the pair its route can carry", async () => {
    // lib/overview-summary-support.ts types CompareMode as
    // "none" | "previous_period". Offering previousYear here would have put a
    // year-over-year label on a previous-period delta.
    const page = await read("app/(dashboard)/overview/legacy-page.tsx");
    // Dashboard v2 moved the range control out of the page and into the shell,
    // so the narrowing is asserted where the control now lives. The rule is
    // unchanged: Overview must not offer a comparison its route cannot read.
    const topbar = await read("components/layout/v2/app-topbar.tsx");
    const picker = await read("components/date-range/DateRangePicker.tsx");
    const persistentRange = await read("hooks/use-persistent-date-range.ts");
    expect(topbar).toContain('variant="v2"');
    expect(picker).toContain("togglePreviousPeriodComparison(value)");
    expect(picker).toContain(
      'value.comparisonPreset === "none" ? "previousPeriod" : "none"',
    );
    expect(persistentRange).toContain("normalizeDashboardV2DateRange");
    expect(persistentRange).toContain(
      'value.comparisonPreset === "none" ? "none" : "previousPeriod"',
    );
    expect(page).not.toContain(
      'dateRange.comparisonPreset === "none" ? "none" : "previous_period"',
    );
    const support = await read("lib/overview-summary-support.ts");
    expect(support).toContain('export type CompareMode = "none" | "previous_period";');
  });

  for (const file of [
    "app/(dashboard)/insights/analytics/legacy-page.tsx",
    "app/(dashboard)/insights/seo/legacy-page.tsx",
    "app/(dashboard)/insights/ai-visibility/legacy-page.tsx",
    "app/(dashboard)/platforms/meta/landing-pages/legacy-page.tsx",
  ]) {
    it(`${file.split("/").slice(-2)[0]} hides the comparison it never reads`, async () => {
      const page = await read(file);
      // These surfaces rendered an active-looking Compare chip and read
      // nothing from it: the operator could pick "Previous year", watch the
      // chip light up and print year-ago dates, and change nothing at all.
      if (file.includes("platforms/meta/landing-pages")) {
        // Dashboard v2 removed the page-local date/comparison control from
        // Creative Studio entirely. The shell owns the date window, while
        // Landing Pages still consumes no comparison baseline.
        expect(page).toContain("<CreativeStudioExact");
        expect(page).not.toContain("<DateRangePicker");
        expect(page).not.toContain("<CreativesTopSection");
        expect(page).not.toContain("showComparisonTrigger");
      } else {
        expect(page).toContain("showComparisonTrigger={false}");
      }
      expect(page).not.toMatch(/compareMode|comparisonMode/);
    });
  }
});
