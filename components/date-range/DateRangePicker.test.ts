import {
  DATE_RANGE_PICKER_INTERNALS,
  DEFAULT_DATE_RANGE,
  getPresetDates,
  getPresetDatesForReferenceDate,
  getPickerKeyboardAction,
  resolveRangeCalendarDateClick,
  resolveRangePresetSelection,
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
});

describe("DateRangePicker compact layout", () => {
  it("renders the primary custom picker with a single month and compact chrome", () => {
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
    expect(markup.match(/aria-label=\"March 2026 calendar\"/g)?.length ?? 0).toBe(1);
    expect(markup).not.toContain("Selection Summary");
    expect(markup).not.toContain(">Start<");
    expect(markup).not.toContain(">End<");
    expect(markup).not.toContain(">Window<");
  });

  it("renders the comparison custom picker with a single month and compact footer", () => {
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
    expect(markup.match(/aria-label=\"February 2026 calendar\"/g)?.length ?? 0).toBe(1);
    expect(markup).not.toContain("Selected Comparison");
    expect(markup).not.toContain(">Start<");
    expect(markup).not.toContain(">End<");
  });
});
