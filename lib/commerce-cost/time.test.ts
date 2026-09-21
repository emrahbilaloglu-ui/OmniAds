import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  InvalidCostInstantError,
  parseAsOfInstant,
  parseInstant,
  periodFractionForRange,
  startOfUtcDay,
} from "./time";

/**
 * One clock for the slice.
 *
 * Every case here exists because the alternative silently moved money: an
 * unreadable date read as the epoch made a cost effective for all of history,
 * and an offset-less timestamp made the same window charge different amounts
 * on hosts in different timezones.
 */

describe("parseInstant", () => {
  it("reads an offset-less timestamp as UTC", () => {
    expect(parseInstant("2026-09-16T00:00:00")).toBe(Date.parse("2026-09-16T00:00:00.000Z"));
    expect(parseInstant("2026-09-16 12:30:00")).toBe(Date.parse("2026-09-16T12:30:00.000Z"));
    // An explicit offset is honoured as written.
    expect(parseInstant("2026-09-16T00:00:00+03:00")).toBe(
      Date.parse("2026-09-15T21:00:00.000Z"),
    );
  });

  it("reads a date-only value as the first instant of that UTC day", () => {
    expect(parseInstant("2026-09-16")).toBe(Date.parse("2026-09-16T00:00:00.000Z"));
  });

  it("returns null rather than an epoch for anything it cannot read", () => {
    for (const value of ["", "   ", "2026-13-01", "15/01/2026", "oops", null, undefined]) {
      expect(parseInstant(value as string | null | undefined)).toBeNull();
    }
    expect(parseInstant(42 as unknown as string)).toBeNull();
  });
});

describe("startOfUtcDay", () => {
  it("pins a plain day to UTC midnight and still accepts a full instant", () => {
    expect(startOfUtcDay("2026-09-01")).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
    expect(startOfUtcDay("2026-09-01T09:30:00Z")).toBe(Date.parse("2026-09-01T09:30:00.000Z"));
    expect(startOfUtcDay("nope")).toBeNull();
  });
});

describe("parseAsOfInstant", () => {
  it("treats absence as a live read and refuses an unreadable replay", () => {
    expect(parseAsOfInstant(null)).toBeNull();
    expect(parseAsOfInstant(undefined)).toBeNull();
    expect(parseAsOfInstant("2026-09-01T00:00:00Z")).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
    // Guessing either way was worse: one file answered "nothing was known",
    // the other answered as if it were live.
    expect(() => parseAsOfInstant("oops")).toThrow(InvalidCostInstantError);
  });
});

describe("periodFractionForRange", () => {
  const range = (start: string, endExclusive: string) =>
    [Date.parse(start), Date.parse(endExclusive)] as const;

  it("charges a whole calendar month exactly once, in every month", () => {
    for (const [start, end] of [
      ["2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"],
      ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"],
      ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"],
      ["2028-02-01T00:00:00Z", "2028-03-01T00:00:00Z"],
    ] as const) {
      expect(periodFractionForRange("month", ...range(start, end))).toBeCloseTo(1, 10);
    }
  });

  it("splits a part-month by that month's own length", () => {
    // 15 of September's 30 days.
    expect(
      periodFractionForRange("month", ...range("2026-09-16T00:00:00Z", "2026-10-01T00:00:00Z")),
    ).toBeCloseTo(0.5, 10);
    // 14 of February's 28 plus 14 of March's 31.
    expect(
      periodFractionForRange("month", ...range("2026-02-15T00:00:00Z", "2026-03-15T00:00:00Z")),
    ).toBeCloseTo(14 / 28 + 14 / 31, 10);
  });

  it("charges a whole calendar year once, including a leap year", () => {
    expect(
      periodFractionForRange("year", ...range("2028-01-01T00:00:00Z", "2029-01-01T00:00:00Z")),
    ).toBeCloseTo(1, 10);
  });

  it("uses fixed lengths for days and weeks", () => {
    expect(periodFractionForRange("day", 0, DAY_MS)).toBe(1);
    expect(periodFractionForRange("week", 0, 7 * DAY_MS)).toBe(1);
    expect(periodFractionForRange("week", 0, DAY_MS)).toBeCloseTo(1 / 7, 10);
  });

  it("charges nothing for an empty or inverted range, and refuses a non-finite one", () => {
    expect(periodFractionForRange("month", DAY_MS, DAY_MS)).toBe(0);
    expect(periodFractionForRange("month", 2 * DAY_MS, DAY_MS)).toBe(0);
    expect(periodFractionForRange("month", Number.NaN, DAY_MS)).toBeNull();
  });
});
