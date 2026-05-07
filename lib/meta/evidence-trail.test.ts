import { describe, expect, it } from "vitest";
import { buildEvidenceTrail } from "@/lib/meta/evidence-trail";

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

describe("meta evidence trail", () => {
  it("slices ROAS history to the latest 28 days", () => {
    const trail = buildEvidenceTrail({
      scope: { type: "campaign", id: "cmp_1" },
      history: Array.from({ length: 35 }, (_, index) => ({
        date: addDays("2026-04-01", index),
        roas: index + 1,
        regime: "lowest_cost",
      })),
      peers: [1, 2, 3],
      recentChanges: [],
      asOfDate: "2026-05-05",
    });

    expect(trail.roas_history).toHaveLength(28);
    expect(trail.roas_history[0]).toBe(8);
    expect(trail.roas_history[27]).toBe(35);
  });

  it("computes peer comparison percentiles", () => {
    const trail = buildEvidenceTrail({
      scope: { type: "adset", id: "adset_1", thisValue: 3.5 },
      history: [{ date: "2026-05-06", roas: 3.5 }],
      peers: [1, 2, 3, 4, 5],
      recentChanges: [],
      asOfDate: "2026-05-06",
    });

    expect(trail.peer_comparison).toEqual({
      p10: 1.4,
      p50: 3,
      p90: 4.6,
      this_value: 3.5,
    });
  });

  it("filters recent changes to the last 14 days", () => {
    const trail = buildEvidenceTrail({
      scope: { type: "campaign", id: "cmp_1" },
      history: [
        { date: "2026-05-06", roas: 2, regime: "lowest_cost" },
        { date: "2026-05-05", roas: 2.1, regime: "cost_cap" },
      ],
      peers: [2],
      recentChanges: [
        { type: "pause", applied_at: "2026-05-02T10:00:00.000Z", value: { status: "PAUSED" } },
        { type: "duplicate", applied_at: "2026-04-10T10:00:00.000Z", value: { id: "old" } },
      ],
      asOfDate: "2026-05-06",
    });

    expect(trail.recent_changes).toEqual([
      { type: "pause", applied_at: "2026-05-02T10:00:00.000Z", value: { status: "PAUSED" } },
    ]);
    expect(trail.regime_stability).toBe(0.5);
  });
});
