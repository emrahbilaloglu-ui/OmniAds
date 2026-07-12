import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DateRangePicker,
  computeRangeFromPreset,
  type DateRangeValue,
} from "@/components/common/briefing/DateRangePicker";

function value(overrides: Partial<DateRangeValue> = {}): DateRangeValue {
  return {
    preset: "14d",
    startDate: "2026-05-03",
    endDate: "2026-05-16",
    ...overrides,
  };
}

describe("DateRangePicker", () => {
  it("renders a closed trigger with the date range label", () => {
    const html = renderToStaticMarkup(
      <DateRangePicker value={value()} onChange={() => undefined} />,
    );

    expect(html).toContain("May 3");
    expect(html).toContain("May 16");
    expect(html).toContain("Last 14 days");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it("renders preset chips and custom range label inside the popover trigger context", () => {
    const html = renderToStaticMarkup(
      <DateRangePicker
        value={value({ preset: "custom" })}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain("May 3 - May 16");
    expect(html).toContain("14 days");
  });
});

describe("computeRangeFromPreset", () => {
  const reference = new Date(2026, 4, 16);

  it("computes a 14d window relative to today", () => {
    const range = computeRangeFromPreset("14d", reference);
    expect(range.endDate).toBe("2026-05-16");
    expect(range.startDate).toBe("2026-05-03");
  });

  it("computes a 90d window relative to today", () => {
    const range = computeRangeFromPreset("90d", reference);
    expect(range.endDate).toBe("2026-05-16");
    expect(range.startDate).toBe("2026-02-16");
  });

  it("returns today/yesterday singletons", () => {
    expect(computeRangeFromPreset("today", reference)).toEqual({
      startDate: "2026-05-16",
      endDate: "2026-05-16",
    });
    expect(computeRangeFromPreset("yesterday", reference)).toEqual({
      startDate: "2026-05-15",
      endDate: "2026-05-15",
    });
  });

  it("returns this_month and last_month ranges", () => {
    expect(computeRangeFromPreset("this_month", reference)).toEqual({
      startDate: "2026-05-01",
      endDate: "2026-05-16",
    });
    expect(computeRangeFromPreset("last_month", reference)).toEqual({
      startDate: "2026-04-01",
      endDate: "2026-04-30",
    });
  });
});
