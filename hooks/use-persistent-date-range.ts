"use client";

import { useCallback } from "react";
import { usePreferencesStore } from "@/store/preferences-store";
import {
  DEFAULT_DATE_RANGE,
  type DateRangeValue,
} from "@/components/date-range/DateRangePicker";
import {
  DEFAULT_CREATIVE_DATE_RANGE,
  type CreativeDateRangeValue,
} from "@/components/creatives/CreativesTopSection";
import { usePersistentPreferenceValue } from "@/hooks/persistent-date-range-support";

export const DASHBOARD_V2_DEFAULT_DATE_RANGE: DateRangeValue = {
  ...DEFAULT_DATE_RANGE,
  rangePreset: "28d",
  comparisonPreset: "previousPeriod",
};

/**
 * Dashboard v2 exposes one binary comparison state. Old persisted custom/year
 * presets remain "on", but are narrowed to the only comparison the shell can
 * truthfully name and request.
 */
export function normalizeDashboardV2DateRange(
  value: DateRangeValue,
): DateRangeValue {
  const comparisonPreset =
    value.comparisonPreset === "none" ? "none" : "previousPeriod";
  return {
    ...value,
    comparisonPreset,
    comparisonStart: "",
    comparisonEnd: "",
  };
}

/**
 * Persists the standard DateRangePicker value across page navigations.
 * Used by Overview, Analytics, Geo, Meta, and similar platform pages.
 */
export function usePersistentDateRange(): [
  DateRangeValue,
  (value: DateRangeValue) => void,
] {
  const stored = usePreferencesStore((s) => s.dashboardDateRange);
  const set = usePreferencesStore((s) => s.setDashboardDateRange);
  const [value, setValue] = usePersistentPreferenceValue(
    stored,
    set,
    DASHBOARD_V2_DEFAULT_DATE_RANGE,
  );
  const setNormalizedValue = useCallback(
    (next: DateRangeValue) => setValue(normalizeDashboardV2DateRange(next)),
    [setValue],
  );
  return [normalizeDashboardV2DateRange(value), setNormalizedValue];
}

/**
 * Dashboard v2 has one shell-owned date/comparison state. Meta and the command
 * center use that state rather than retaining private comparison presets that
 * can disagree with the fixed "vs previous period" control.
 */
export function usePersistentMetaDateRange(): [
  DateRangeValue,
  (value: DateRangeValue) => void,
] {
  return usePersistentDateRange();
}

export function usePersistentCommandCenterDateRange(): [
  DateRangeValue,
  (value: DateRangeValue) => void,
] {
  return usePersistentDateRange();
}

/**
 * Persists the Motion (Creatives / Copies) date range value across navigations.
 */
export function usePersistentCreativeDateRange(): [
  CreativeDateRangeValue,
  (value: CreativeDateRangeValue) => void,
] {
  const stored = usePreferencesStore((s) => s.creativeDateRange);
  const set = usePreferencesStore((s) => s.setCreativeDateRange);
  return usePersistentPreferenceValue(stored, set, DEFAULT_CREATIVE_DATE_RANGE);
}
