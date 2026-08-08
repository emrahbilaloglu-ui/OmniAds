import { describe, expect, it } from "vitest";
import {
  NARROW_VIEWPORT_BREAKPOINT,
  TIER_0_METRIC_PRIORITY,
  isNarrowViewport,
  resolveCreativeColumnPriority,
  type PrioritizableColumn,
} from "@/lib/creative-column-priority";

/** A representative slice of the real creative table's column widths. */
const columns: PrioritizableColumn[] = [
  { key: "spend", preferredWidth: 130, minWidth: 120 },
  { key: "purchaseValue", preferredWidth: 140, minWidth: 128 },
  { key: "roas", preferredWidth: 92, minWidth: 88 },
  { key: "cpa", preferredWidth: 112, minWidth: 106 },
  { key: "purchases", preferredWidth: 84, minWidth: 76 },
  { key: "video75Rate", preferredWidth: 165, minWidth: 145 },
  { key: "purchasesPer1000Imp", preferredWidth: 230, minWidth: 200 },
];

const PHONE_WIDTH = 390;

describe("the economics are visible on a phone", () => {
  it("keeps spend and ROAS on screen at 390px", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: PHONE_WIDTH,
      identityWidth: 150,
      columns,
      chromeWidth: 24,
    });
    expect(result.visibleKeys).toContain("spend");
    expect(result.visibleKeys).toContain("roas");
  });

  it("fits without horizontal scrolling", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: PHONE_WIDTH,
      identityWidth: 150,
      columns,
      chromeWidth: 24,
    });
    expect(result.fits).toBe(true);
    expect(result.totalWidth).toBeLessThanOrEqual(PHONE_WIDTH - 24);
  });

  it("shows identity first, always", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: 200,
      identityWidth: 150,
      columns,
    });
    expect(result.visibleKeys[0]).toBe("creativeName");
  });

  it("drops low-priority metrics rather than overflowing", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: PHONE_WIDTH,
      identityWidth: 150,
      columns,
      chromeWidth: 24,
    });
    expect(result.droppedKeys).toContain("purchasesPer1000Imp");
    expect(result.droppedKeys).toContain("video75Rate");
  });

  it("reports what it withheld instead of hiding it silently", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: PHONE_WIDTH,
      identityWidth: 150,
      columns,
      chromeWidth: 24,
    });
    const accounted = new Set([...result.visibleKeys.filter((k) => k !== "creativeName"), ...result.droppedKeys]);
    expect(accounted.size).toBe(columns.length);
  });
});

describe("priority order", () => {
  it("prefers spend over any non-economic column", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: 330,
      identityWidth: 150,
      columns,
    });
    expect(result.visibleKeys).toContain("spend");
    expect(result.visibleKeys).not.toContain("purchasesPer1000Imp");
  });

  it("adds economic columns in the order a buyer reads them", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: 1000,
      identityWidth: 150,
      columns,
    });
    const economics = result.visibleKeys.filter((key) =>
      (TIER_0_METRIC_PRIORITY as readonly string[]).includes(key),
    );
    expect(economics[0]).toBe("spend");
    expect(economics[1]).toBe("roas");
  });

  it("shows everything when the viewport is wide enough", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: 2000,
      identityWidth: 240,
      columns,
    });
    expect(result.droppedKeys).toEqual([]);
    expect(result.fits).toBe(true);
  });
});

describe("degenerate widths", () => {
  it("returns identity alone rather than an overflowing set", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: 160,
      identityWidth: 150,
      columns,
    });
    expect(result.visibleKeys).toEqual(["creativeName"]);
    expect(result.droppedKeys).toHaveLength(columns.length);
  });

  it("ignores a priority key the table does not have", () => {
    const result = resolveCreativeColumnPriority({
      viewportWidth: 800,
      identityWidth: 150,
      columns,
      priority: ["not_a_column", "spend"],
    });
    expect(result.visibleKeys).toContain("spend");
    expect(result.visibleKeys).not.toContain("not_a_column");
  });
});

describe("breakpoint", () => {
  it("treats phone and small tablet widths as narrow", () => {
    expect(isNarrowViewport(390)).toBe(true);
    expect(isNarrowViewport(767)).toBe(true);
    expect(isNarrowViewport(NARROW_VIEWPORT_BREAKPOINT)).toBe(false);
    expect(isNarrowViewport(1440)).toBe(false);
  });

  it("does not treat an unknown width as narrow", () => {
    expect(isNarrowViewport(Number.NaN)).toBe(false);
  });
});
