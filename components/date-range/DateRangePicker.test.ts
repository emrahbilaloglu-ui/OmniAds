import {
  DATE_RANGE_PICKER_INTERNALS,
  DEFAULT_DATE_RANGE,
  DateRangePicker,
  DatePicker,
  dateWindowToRangeValue,
  getDerivedComparisonRange,
  getPresetDates,
  getPresetDatesForReferenceDate,
  getPickerKeyboardAction,
  getTodayIsoForTimeZone,
  rangeValueToDateWindow,
  resolveRangeCalendarDateClick,
  resolveRangePresetSelection,
  togglePreviousPeriodComparison,
  COMPARISON_PRESET_VALUES,
} from "@/components/date-range/DateRangePicker";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, vi } from "vitest";

const RealDateTimeFormat = Intl.DateTimeFormat;
const TEST_RANGE_PRESETS = [
  { value: "today", label: "Today", hint: "Only the current day", group: "Quick Select" },
  { value: "30d", label: "Last 30 days", hint: "Balanced operating view", group: "Rolling Windows" },
  { value: "custom", label: "Custom range", hint: "Pick exact dates", group: "Custom" },
] as const;
const TEST_COMPARISON_PRESETS = [
  { value: "none", label: "None", hint: "Keep the view focused on one period", group: "Compare" },
  { value: "custom", label: "Custom range", hint: "Pick exact comparison dates", group: "Compare" },
  { value: "previousPeriod", label: "Previous period", hint: "Same length immediately before", group: "Compare" },
] as const;

describe("DateRangePicker quick-apply behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Intl.DateTimeFormat = RealDateTimeFormat;
  });

  it("updates draft on first quick preset click without applying", () => {
    const result = resolveRangePresetSelection(
      {
        ...DEFAULT_DATE_RANGE,
        rangePreset: "30d",
        customStart: "2026-03-01",
        customEnd: "2026-03-30",
      },
      "today",
      "2026-03-30"
    );

    expect(result.shouldApply).toBe(false);
    expect(result.nextDraft.rangePreset).toBe("today");
    expect(result.nextDraft.customStart).toBe("2026-03-30");
    expect(result.nextDraft.customEnd).toBe("2026-03-30");
  });

  it("applies on second quick preset click for non-custom presets", () => {
    const result = resolveRangePresetSelection(
      {
        ...DEFAULT_DATE_RANGE,
        rangePreset: "today",
        customStart: "2026-03-30",
        customEnd: "2026-03-30",
      },
      "today",
      "2026-03-30"
    );

    expect(result.shouldApply).toBe(true);
  });

  it("does not auto-apply the custom preset on repeat click", () => {
    const result = resolveRangePresetSelection(
      {
        ...DEFAULT_DATE_RANGE,
        rangePreset: "custom",
        customStart: "2026-03-03",
        customEnd: "2026-03-03",
      },
      "custom",
      "2026-03-30"
    );

    expect(result.shouldApply).toBe(false);
  });

  it("applies when the same custom date is clicked twice", () => {
    const result = resolveRangeCalendarDateClick(
      {
        ...DEFAULT_DATE_RANGE,
        rangePreset: "custom",
        customStart: "2026-03-03",
        customEnd: "2026-03-03",
      },
      "end",
      "2026-03-03"
    );

    expect(result.shouldApply).toBe(true);
    expect(result.nextPickStep).toBe("start");
    expect(result.nextDraft.customStart).toBe("2026-03-03");
    expect(result.nextDraft.customEnd).toBe("2026-03-03");
  });

  it("keeps manual apply flow for multi-day custom selections", () => {
    const result = resolveRangeCalendarDateClick(
      {
        ...DEFAULT_DATE_RANGE,
        rangePreset: "custom",
        customStart: "2026-03-03",
        customEnd: "2026-03-03",
      },
      "end",
      "2026-03-05"
    );

    expect(result.shouldApply).toBe(false);
    expect(result.nextPickStep).toBe("start");
    expect(result.nextDraft.customStart).toBe("2026-03-03");
    expect(result.nextDraft.customEnd).toBe("2026-03-05");
  });

  it("maps Enter/Escape to apply and cancel", () => {
    expect(getPickerKeyboardAction("Enter")).toBe("apply");
    expect(getPickerKeyboardAction("Escape")).toBe("cancel");
    expect(getPickerKeyboardAction("Tab")).toBeNull();
  });

  it("resolves today using the browser timezone instead of UTC serialization", () => {
    vi.setSystemTime(new Date("2026-03-31T21:30:00.000Z"));
    Intl.DateTimeFormat = function (...args: ConstructorParameters<typeof RealDateTimeFormat>) {
      if (args.length === 0) {
        return {
          resolvedOptions: () => ({ timeZone: "Europe/Istanbul" }),
        } as Intl.DateTimeFormat;
      }
      return new RealDateTimeFormat(...args);
    } as typeof Intl.DateTimeFormat;

    const result = getPresetDates("today");

    expect(result).toEqual({ start: "2026-04-01", end: "2026-04-01" });
  });

  it("resolves rolling presets as completed windows that exclude today", () => {
    expect(getPresetDatesForReferenceDate("7d", "2026-05-03")).toEqual({
      start: "2026-04-26",
      end: "2026-05-02",
    });
    expect(getPresetDatesForReferenceDate("30d", "2026-05-03")).toEqual({
      start: "2026-04-03",
      end: "2026-05-02",
    });
  });

  it("supports Meta 28-day and month-to-date windows through the selected account day", () => {
    expect(
      getPresetDatesForReferenceDate("28d", "2026-07-12", "", "", {
        includeCurrentDay: true,
      })
    ).toEqual({ start: "2026-06-15", end: "2026-07-12" });
    expect(getPresetDatesForReferenceDate("thisMonth", "2026-07-12")).toEqual({
      start: "2026-07-01",
      end: "2026-07-12",
    });
  });

  it("falls back to UTC instead of crashing on an invalid persisted timezone", () => {
    vi.setSystemTime(new Date("2026-07-12T23:30:00.000Z"));
    expect(getTodayIsoForTimeZone("Invalid/Persisted_Zone")).toBe("2026-07-12");
  });

  it("round-trips legacy window values through the canonical picker contract", () => {
    const standard = dateWindowToRangeValue({
      window: "last_month",
      start: "2026-06-01",
      end: "2026-06-30",
    });
    expect(standard.rangePreset).toBe("lastMonth");
    expect(
      rangeValueToDateWindow(standard, "2026-07-12", {
        includeCurrentDay: true,
      })
    ).toEqual({ window: "last_month", start: "2026-06-01", end: "2026-06-30" });
  });
});

describe("Dashboard v2 comparison toggle", () => {
  it("switches only between none and previous period", () => {
    expect(
      togglePreviousPeriodComparison({
        ...DEFAULT_DATE_RANGE,
        comparisonPreset: "none",
      }).comparisonPreset,
    ).toBe("previousPeriod");
    expect(
      togglePreviousPeriodComparison({
        ...DEFAULT_DATE_RANGE,
        comparisonPreset: "previousPeriod",
      }).comparisonPreset,
    ).toBe("none");
    expect(
      togglePreviousPeriodComparison({
        ...DEFAULT_DATE_RANGE,
        comparisonPreset: "previousYear",
      }).comparisonPreset,
    ).toBe("none");
  });

  it("keeps the canonical span keyboard-operable without changing its tag", () => {
    const markup = renderToStaticMarkup(
      createElement(DateRangePicker, {
        variant: "v2",
        value: {
          ...DEFAULT_DATE_RANGE,
          rangePreset: "28d",
          comparisonPreset: "previousPeriod",
        },
        onChange: () => undefined,
        testId: "shell-range",
        label: "Date range",
        referenceDate: "2026-08-17",
      }),
    );

    expect(markup).toContain(
      'title="Toggle comparison with the previous period"',
    );
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('tabindex="0"');
  });
});

describe("DateRangePicker calendar comparison math", () => {
  it("shifts a year with end-of-month clamping instead of subtracting 365 days", () => {
    // A leap-day range must not resolve to an invalid 29 February.
    expect(
      getDerivedComparisonRange(
        "2024-02-01",
        "2024-02-29",
        "previousYear",
        "",
        ""
      )
    ).toEqual({ start: "2023-02-01", end: "2023-02-28" });
  });

  it("puts the previous period immediately before the range, same length", () => {
    expect(
      getDerivedComparisonRange(
        "2026-07-06",
        "2026-07-12",
        "previousPeriod",
        "",
        ""
      )
    ).toEqual({ start: "2026-06-29", end: "2026-07-05" });
  });

  it("no longer derives windows for comparisons the server cannot compute", () => {
    // previousWeek / previousMonth / previousQuarter / previousYearMatch were
    // derived here and then discarded: every one was collapsed to
    // previous-period before the request went out, so this preview disagreed
    // with the numbers that came back. They are gone from the type, so this is
    // asserted at the picker's own list rather than by calling them.
    expect(COMPARISON_PRESET_VALUES).toEqual([
      "none",
      "custom",
      "previousPeriod",
      "previousYear",
    ]);
  });
});

describe("DateRangePicker advanced layout", () => {
  it("renders the primary custom picker with two desktop months and compact chrome", () => {
    const markup = renderToStaticMarkup(
      createElement(DATE_RANGE_PICKER_INTERNALS.RangePanel, {
        draft: {
          ...DEFAULT_DATE_RANGE,
          rangePreset: "custom",
          customStart: "2026-03-01",
          customEnd: "2026-03-31",
        },
        onDraftChange: () => undefined,
        onApply: () => undefined,
        onCancel: () => undefined,
        rangePresets: TEST_RANGE_PRESETS,
        referenceDate: "2026-03-31",
        timeZoneLabel: "Europe/Istanbul",
      })
    );

    expect(markup).toContain("Date Range");
    expect(markup).toContain("Quick Select");
    expect(markup).toContain("Europe/Istanbul");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Apply");
    expect(markup).toContain('aria-label="February 2026 calendar"');
    expect(markup).toContain('aria-label="March 2026 calendar"');
    expect(markup).not.toContain("Selection Summary");
    expect(markup).not.toContain(">Start<");
    expect(markup).not.toContain(">End<");
    expect(markup).not.toContain(">Window<");
  });

  it("renders the comparison custom picker with two desktop months and compact footer", () => {
    const markup = renderToStaticMarkup(
      createElement(DATE_RANGE_PICKER_INTERNALS.ComparisonPanel, {
        draft: {
          ...DEFAULT_DATE_RANGE,
          rangePreset: "custom",
          customStart: "2026-03-01",
          customEnd: "2026-03-31",
          comparisonPreset: "custom",
          comparisonStart: "2026-02-01",
          comparisonEnd: "2026-02-28",
        },
        onDraftChange: () => undefined,
        onApply: () => undefined,
        onCancel: () => undefined,
        comparisonPresets: TEST_COMPARISON_PRESETS,
        referenceDate: "2026-03-31",
      })
    );

    expect(markup).toContain("Compare To");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Apply");
    expect(markup).toContain('aria-label="January 2026 calendar"');
    expect(markup).toContain('aria-label="February 2026 calendar"');
    expect(markup).not.toContain("Selected Comparison");
    expect(markup).not.toContain(">Start<");
    expect(markup).not.toContain(">End<");
  });

  it("renders the shared single-date trigger without a native date input", () => {
    const markup = renderToStaticMarkup(
      createElement(DatePicker, {
        value: "2026-07-12",
        onChange: () => undefined,
        label: "Snapshot date",
        referenceDate: "2026-07-12",
        maxDate: "2026-07-12",
      })
    );

    expect(markup).toContain("Snapshot date");
    expect(markup).toContain("July 12, 2026");
    expect(markup).not.toContain('type="date"');
  });
});
