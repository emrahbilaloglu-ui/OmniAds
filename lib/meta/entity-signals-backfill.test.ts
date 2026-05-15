import { describe, expect, it } from "vitest";
import {
  computeMonthlyPacing,
  computeCtrDecayPct7dVs14d,
  computeFrequencyP80,
  computeTrackingQualityStatus,
  findLastSignificantEditAt,
  inferLearningState,
} from "@/lib/meta/entity-signals-backfill";

function daily(overrides: Partial<{
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  reach: number;
  frequency: number | null;
  conversions: number;
}> = {}) {
  return {
    date: "2026-05-08",
    spend: 100,
    impressions: 1_000,
    clicks: 20,
    reach: 500,
    frequency: 2,
    conversions: 4,
    ...overrides,
  };
}

describe("Meta entity signal backfill computations", () => {
  it("computes impression-weighted frequency p80 when sample is dense enough", () => {
    const value = computeFrequencyP80([
      daily({ frequency: 1.5, impressions: 500 }),
      daily({ frequency: 2.5, impressions: 500 }),
      daily({ frequency: 3.5, impressions: 1_000 }),
    ]);
    expect(value).toBe(3.5);
  });

  it("returns null frequency p80 when impression sample is too thin", () => {
    expect(computeFrequencyP80([daily({ impressions: 999, frequency: 4 })])).toBeNull();
  });

  it("computes CTR decay only when spend is stable across both weeks", () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, index) =>
        daily({
          date: `2026-04-${25 + index}`,
          spend: 100,
          impressions: 1_000,
          clicks: 30,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        daily({
          date: `2026-05-0${2 + index}`,
          spend: 100,
          impressions: 1_000,
          clicks: 10,
        }),
      ),
    ];
    expect(computeCtrDecayPct7dVs14d({ rows, asOfDate: "2026-05-08" })).toBeLessThan(-15);
  });

  it("returns null CTR decay when week-over-week spend is volatile", () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, index) =>
        daily({
          date: `2026-04-${25 + index}`,
          spend: 10,
          impressions: 1_000,
          clicks: 30,
        }),
      ),
      ...Array.from({ length: 7 }, (_, index) =>
        daily({
          date: `2026-05-0${2 + index}`,
          spend: 100,
          impressions: 1_000,
          clicks: 10,
        }),
      ),
    ];
    expect(computeCtrDecayPct7dVs14d({ rows, asOfDate: "2026-05-08" })).toBeNull();
  });

  it("detects significant edit only when budget change exceeds 20 percent", () => {
    const latest = findLastSignificantEditAt(
      [
        {
          entity_id: "cmp_1",
          captured_at: "2026-05-01T00:00:00.000Z",
          daily_budget: 100,
          lifetime_budget: null,
          bid_strategy_type: "lowest_cost",
          optimization_goal: "PURCHASE",
          custom_event_type: null,
        },
        {
          entity_id: "cmp_1",
          captured_at: "2026-05-03T00:00:00.000Z",
          daily_budget: 115,
          lifetime_budget: null,
          bid_strategy_type: "lowest_cost",
          optimization_goal: "PURCHASE",
          custom_event_type: null,
        },
        {
          entity_id: "cmp_1",
          captured_at: "2026-05-05T00:00:00.000Z",
          daily_budget: 150,
          lifetime_budget: null,
          bid_strategy_type: "lowest_cost",
          optimization_goal: "PURCHASE",
          custom_event_type: null,
        },
      ],
      "2026-05-08",
    );
    expect(latest).toBe("2026-05-05T00:00:00.000Z");
  });

  it("infers learning state from conversion density and age", () => {
    expect(inferLearningState({ ageDays: 3, purchases7d: 2 })).toBe("LEARNING");
    expect(inferLearningState({ ageDays: 20, purchases7d: 2 })).toBe("LEARNING_LIMITED");
    expect(inferLearningState({ ageDays: 20, purchases7d: 50 })).toBe("OPTIMAL_LEARNING_DONE");
  });

  it("flags click-to-LPV tracking quality only with a dense click sample", () => {
    expect(computeTrackingQualityStatus({ linkClicks: 499, landingPageViews: 0 }).status).toBe(
      "insufficient_click_sample",
    );
    expect(computeTrackingQualityStatus({ linkClicks: 500, landingPageViews: 100 }).status).toBe(
      "lpv_drop_suspected",
    );
    expect(computeTrackingQualityStatus({ linkClicks: 500, landingPageViews: 250 }).status).toBe(
      "click_to_lpv_observed",
    );
  });

  it("computes monthly budget pacing from MTD spend and daily budget", () => {
    const rows = Array.from({ length: 15 }, (_, index) =>
      daily({
        date: `2026-05-${String(index + 1).padStart(2, "0")}`,
        spend: 100,
      }),
    );
    const pacing = computeMonthlyPacing({
      rows,
      asOfDate: "2026-05-15",
      dailyBudget: 100,
      lifetimeBudget: null,
    });

    expect(pacing.status).toBe("on_track");
    expect(pacing.monthly_budget).toBe(3100);
    expect(pacing.mtd_spend).toBe(1500);
  });

  it("marks monthly pacing as overpaced when spend materially exceeds elapsed budget", () => {
    const rows = Array.from({ length: 15 }, (_, index) =>
      daily({
        date: `2026-05-${String(index + 1).padStart(2, "0")}`,
        spend: 200,
      }),
    );

    expect(
      computeMonthlyPacing({
        rows,
        asOfDate: "2026-05-15",
        dailyBudget: 100,
        lifetimeBudget: null,
      }).status,
    ).toBe("overpaced");
  });
});
