import { describe, expect, it } from "vitest";

import {
  KPI_GRID_TRACKS,
  addMetricKey,
  kpiRowSizes,
  kpiRowSpans,
  moveMetricKeyTo,
  removeMetricKey,
  sameMetricKeyOrder,
  uniqueMetricKeys,
} from "./kpi-grid";

describe("kpiRowSizes", () => {
  it("fills full rows and never leaves a single stretched card beside rows of three or more", () => {
    expect(kpiRowSizes(0, 4)).toEqual([]);
    expect(kpiRowSizes(1, 4)).toEqual([1]);
    expect(kpiRowSizes(3, 4)).toEqual([3]);
    expect(kpiRowSizes(4, 4)).toEqual([4]);
    expect(kpiRowSizes(5, 4)).toEqual([3, 2]);
    expect(kpiRowSizes(6, 4)).toEqual([4, 2]);
    expect(kpiRowSizes(9, 4)).toEqual([4, 3, 2]);
    expect(kpiRowSizes(4, 3)).toEqual([2, 2]);
    expect(kpiRowSizes(7, 3)).toEqual([3, 2, 2]);
    // Two-up rows keep the lone last card: half a phone screen is not a hero.
    expect(kpiRowSizes(3, 2)).toEqual([2, 1]);
    expect(kpiRowSizes(3, 1)).toEqual([1, 1, 1]);
  });

  it("clamps cards per row to 1–4 so every row divides the grid exactly", () => {
    expect(kpiRowSizes(6, 6)).toEqual([4, 2]);
    expect(kpiRowSizes(2, 0)).toEqual([1, 1]);
  });
});

describe("kpiRowSpans", () => {
  it("sums every visual row to the full grid for 1–12 cards at every tier", () => {
    for (const perRow of [1, 2, 3, 4]) {
      for (let count = 1; count <= 12; count += 1) {
        const spans = kpiRowSpans(count, perRow);
        expect(spans).toHaveLength(count);
        let used = 0;
        for (const span of spans) {
          expect(Number.isInteger(span)).toBe(true);
          used += span;
          if (used === KPI_GRID_TRACKS) used = 0;
          expect(used).toBeLessThan(KPI_GRID_TRACKS);
        }
        expect(used).toBe(0);
      }
    }
  });

  it("gives the default five KPIs a 3 + 2 layout on laptops", () => {
    expect(kpiRowSpans(5, 4)).toEqual([4, 4, 4, 6, 6]);
  });
});

describe("metric key drafts", () => {
  it("dedupes and edits keys without mutating the input", () => {
    const keys = Object.freeze(["revenue", "spend", "orders"]);
    expect(uniqueMetricKeys(["revenue", "", "spend", "revenue"])).toEqual(["revenue", "spend"]);
    expect(addMetricKey(keys, "aov")).toEqual(["revenue", "spend", "orders", "aov"]);
    expect(addMetricKey(keys, "spend")).toEqual(["revenue", "spend", "orders"]);
    expect(removeMetricKey(keys, "spend")).toEqual(["revenue", "orders"]);
    expect(moveMetricKeyTo(keys, "orders", 0)).toEqual(["orders", "revenue", "spend"]);
    expect(moveMetricKeyTo(keys, "revenue", 99)).toEqual(["spend", "orders", "revenue"]);
    expect(moveMetricKeyTo(keys, "missing", 0)).toEqual(["revenue", "spend", "orders"]);
    expect(sameMetricKeyOrder(keys, ["revenue", "spend", "orders"])).toBe(true);
    expect(sameMetricKeyOrder(keys, ["spend", "revenue", "orders"])).toBe(false);
  });
});
