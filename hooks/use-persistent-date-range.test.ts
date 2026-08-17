import { describe, expect, it } from "vitest";

import { DEFAULT_DATE_RANGE } from "@/components/date-range/DateRangePicker";
import {
  DASHBOARD_V2_DEFAULT_DATE_RANGE,
  normalizeDashboardV2DateRange,
} from "@/hooks/use-persistent-date-range";

describe("Dashboard v2 shell date contract", () => {
  it("keeps the generic picker default neutral for non-shell consumers", () => {
    expect(DEFAULT_DATE_RANGE).toMatchObject({
      rangePreset: "30d",
      comparisonPreset: "none",
    });
  });

  it("starts a fresh Dashboard v2 workspace at 28 days with comparison on", () => {
    expect(DASHBOARD_V2_DEFAULT_DATE_RANGE).toMatchObject({
      rangePreset: "28d",
      comparisonPreset: "previousPeriod",
    });
  });

  it("narrows every persisted on-state to previous period", () => {
    expect(
      normalizeDashboardV2DateRange({
        ...DEFAULT_DATE_RANGE,
        comparisonPreset: "previousYear",
      }),
    ).toMatchObject({
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    });

    expect(
      normalizeDashboardV2DateRange({
        ...DEFAULT_DATE_RANGE,
        comparisonPreset: "custom",
        comparisonStart: "2026-01-01",
        comparisonEnd: "2026-01-31",
      }),
    ).toMatchObject({
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    });
  });

  it("preserves an operator's persisted off-state", () => {
    expect(normalizeDashboardV2DateRange(DEFAULT_DATE_RANGE)).toEqual(
      DEFAULT_DATE_RANGE,
    );
  });
});
