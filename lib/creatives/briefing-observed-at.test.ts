import { describe, expect, it } from "vitest";

import { latestCanonicalComputedAt } from "@/lib/creatives/briefing-observed-at";

/**
 * Tier-0 as-of behaviour for the canonical briefing.
 *
 * The generation's `asOfDate` is a calendar label. If a surface ever derived an
 * instant from it, every row would claim to be measured at midnight and the
 * age shown to a buyer would be fiction. These cases pin the real contract.
 */
function item(computedAt: string | null) {
  return { sourceDecision: { computedAt } };
}

describe("briefing Tier-0 observedAt", () => {
  it("publishes the LATEST canonical computation timestamp, not the first or the calendar date", () => {
    const asOfDate = "2026-07-19";
    const observedAt = latestCanonicalComputedAt([
      item("2026-07-19T04:10:00.000Z"),
      item("2026-07-19T09:45:00.000Z"),
      item("2026-07-19T06:30:00.000Z"),
    ]);

    expect(observedAt).toBe("2026-07-19T09:45:00.000Z");
    // Never the calendar label, and never midnight derived from it.
    expect(observedAt).not.toBe(asOfDate);
    expect(observedAt).not.toBe(`${asOfDate}T00:00:00.000Z`);
  });

  it("ignores rows without a computation timestamp instead of ranking null", () => {
    expect(
      latestCanonicalComputedAt([
        item(null),
        item("2026-07-19T02:00:00.000Z"),
        item(null),
      ]),
    ).toBe("2026-07-19T02:00:00.000Z");
  });

  it("is unavailable when no canonical computation timestamp exists", () => {
    expect(latestCanonicalComputedAt([])).toBeNull();
    expect(latestCanonicalComputedAt([item(null), item(null)])).toBeNull();
  });

  it("does not fabricate an age from a generation that only has a calendar date", () => {
    // A generation can carry asOfDate while every item is still uncomputed.
    // The surface must report "age unknown", not the day boundary.
    expect(latestCanonicalComputedAt([item(null)])).toBeNull();
  });
});
