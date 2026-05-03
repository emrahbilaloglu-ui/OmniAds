import { afterEach, describe, expect, it, vi } from "vitest";
import { getDateRangeForQuery } from "@/lib/google-ads-gaql";

describe("getDateRangeForQuery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves rolling Google Ads windows as completed days that exclude today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T12:00:00.000Z"));

    expect(getDateRangeForQuery("7")).toEqual({
      startDate: "2026-04-26",
      endDate: "2026-05-02",
    });
    expect(getDateRangeForQuery("30")).toEqual({
      startDate: "2026-04-03",
      endDate: "2026-05-02",
    });
  });

  it("keeps explicit custom Google Ads windows exact", () => {
    expect(getDateRangeForQuery("custom", "2026-04-01", "2026-04-08")).toEqual({
      startDate: "2026-04-01",
      endDate: "2026-04-08",
    });
  });
});
