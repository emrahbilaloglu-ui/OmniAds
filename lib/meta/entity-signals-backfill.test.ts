import { describe, expect, it } from "vitest";
import {
  computeMonthlyPacing,
  computeCtrDecayPct7dVs14d,
  computeFrequencyP80,
  computeTrackingQualityStatus,
  findLastSignificantEditAt,
  inferLearningState,
  trackingQualityFromAdRows,
} from "@/lib/meta/entity-signals-backfill";
import type { MetaAdDailyRow } from "@/lib/meta/warehouse-types";

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

/*
  ── ROUND 11 ITEM 1: THE RECENT-EDIT VETO IS PROVIDER-LOCAL ──────────────────

  `readConfigHistory` bounded a `timestamptz` column with
  `($3::date - INTERVAL '60 days')` and `($3::date + INTERVAL '1 day')`, and
  PostgreSQL resolves a bare `date` against `timestamptz` using the SESSION's
  `TimeZone`. It also filtered on `business_id` alone, while both config-history
  tables carry `provider_account_id`.

  Both defects land on the SAME number: `daysSinceSignificantEdit`, which
  `blocksPurchaseHardAction` compares against 7 to decide whether a
  purchase-budget hard action is still vetoed. A day-boundary that moves with
  the connection, or an edit borrowed from another account, moves that veto.
*/
describe("the recent-edit veto is measured in the advertiser's calendar", () => {
  const LA = "America/Los_Angeles";
  const AS_OF = "2026-09-05";

  /** Two rows whose difference IS a significant config change. */
  const editAt = (capturedAt: string) => [
    {
      entity_id: "adset_1",
      captured_at: "2026-08-01T00:00:00.000Z",
      daily_budget: 100,
      lifetime_budget: null,
      bid_strategy_type: "lowest_cost",
      optimization_goal: "OFFSITE_CONVERSIONS",
      custom_event_type: "PURCHASE",
      promoted_object_json: null,
    },
    {
      entity_id: "adset_1",
      captured_at: capturedAt,
      daily_budget: 400,
      lifetime_budget: null,
      bid_strategy_type: "lowest_cost",
      optimization_goal: "OFFSITE_CONVERSIONS",
      custom_event_type: "PURCHASE",
      promoted_object_json: null,
    },
  ] as never[];

  it("INCLUDES an edit at 23:30 local on the as-of day", () => {
    // 2026-09-05 23:30 in Los Angeles is 2026-09-06T06:30Z — the NEXT UTC day.
    // The old UTC filter dropped it, which reported the account as un-edited
    // and lifted the veto.
    expect(
      findLastSignificantEditAt(editAt("2026-09-06T06:30:00.000Z"), AS_OF, LA),
    ).toBe("2026-09-06T06:30:00.000Z");
  });

  it("EXCLUDES an edit at 00:01 on the next local day", () => {
    // 2026-09-06 00:01 local is 2026-09-06T07:01Z. It belongs to the day after
    // the one being reconstructed and must not enter it.
    expect(
      findLastSignificantEditAt(editAt("2026-09-06T07:01:00.000Z"), AS_OF, LA),
    ).toBeNull();
  });

  it("places the boundary differently from the UTC reading, which is the defect", () => {
    /*
      The control. If the advertiser boundary coincided with the UTC one, the
      original `::date` filter would have been harmless.
    */
    const lateLocalEdit = editAt("2026-09-06T06:30:00.000Z");
    expect(findLastSignificantEditAt(lateLocalEdit, AS_OF, LA)).not.toBeNull();
    // Without a zone the same row falls on 2026-09-06 UTC and is excluded.
    expect(findLastSignificantEditAt(lateLocalEdit, AS_OF)).toBeNull();
  });

  it("lands the boundary correctly across a DST transition", () => {
    /*
      2026-11-01 is the US fall-back day: 25 hours long, and the offset at its
      end (UTC-8) differs from the offset at its start (UTC-7). 23:30 local on
      that day is 07:30Z on the 2nd.
    */
    expect(
      findLastSignificantEditAt(
        editAt("2026-11-02T07:30:00.000Z"),
        "2026-11-01",
        LA,
      ),
    ).toBe("2026-11-02T07:30:00.000Z");
    // One minute past the local midnight that follows it is out.
    expect(
      findLastSignificantEditAt(
        editAt("2026-11-02T08:01:00.000Z"),
        "2026-11-01",
        LA,
      ),
    ).toBeNull();
  });

  it("is invariant to this process's own timezone", () => {
    /*
      The DB-session analogue at the layer this code owns: the calendar is
      derived from an explicit `timeZone`, so nothing reads the ambient zone.
      Changing `process.env.TZ` must not move the answer.
    */
    const original = process.env.TZ;
    const readings: Array<string | null> = [];
    for (const tz of ["UTC", "Asia/Tokyo", "America/New_York"]) {
      process.env.TZ = tz;
      readings.push(
        findLastSignificantEditAt(editAt("2026-09-06T06:30:00.000Z"), AS_OF, LA),
      );
    }
    process.env.TZ = original;
    expect(new Set(readings).size).toBe(1);
    expect(readings[0]).toBe("2026-09-06T06:30:00.000Z");
  });

  it("reads Istanbul's day end at 21:00Z, three hours before UTC midnight", () => {
    const IST = "Europe/Istanbul";
    // 2026-09-05 23:30 Istanbul is 20:30Z the SAME day.
    expect(
      findLastSignificantEditAt(editAt("2026-09-05T20:30:00.000Z"), AS_OF, IST),
    ).toBe("2026-09-05T20:30:00.000Z");
    // 2026-09-06 00:30 Istanbul is 21:30Z on the 5th — still the 5th in UTC,
    // so the old UTC filter INCLUDED it. It is the next advertiser day.
    expect(
      findLastSignificantEditAt(editAt("2026-09-05T21:30:00.000Z"), AS_OF, IST),
    ).toBeNull();
  });
});

/*
  A CONTRADICTION NEEDS TWO OBSERVATIONS THAT DISAGREE (D091).

  `lpv_drop_suspected` claims the pixel or the landing page is losing visitors
  between the click and the page view, and it holds every performance scenario
  for the entity. Both of its inputs used to arrive through `n()`, which maps
  null to 0: an unmeasured landing-page-view window beside 500+ measured link
  clicks read as a 0% capture rate — the strongest "tracking drop" there is,
  manufactured from an absence.
*/
function adDay(
  overrides: Partial<MetaAdDailyRow> & Pick<MetaAdDailyRow, "date">,
): MetaAdDailyRow {
  return {
    businessId: "biz_1",
    providerAccountId: "act_1",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    sourceSnapshotId: null,
    campaignId: "cmp_1",
    adsetId: "adset_1",
    adId: "ad_1",
    adNameCurrent: null,
    adNameHistorical: null,
    adStatus: "ACTIVE",
    spend: 100,
    impressions: 5_000,
    clicks: 700,
    reach: 4_000,
    frequency: 1.25,
    conversions: 3,
    revenue: 300,
    roas: 3,
    cpa: 33,
    ctr: 14,
    cpc: 0.14,
    linkClicks: null,
    landingPageViews: null,
    addToCart: null,
    initiateCheckout: null,
    ...overrides,
  };
}

const INERT_DAY = {
  spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  revenue: 0,
};

describe("click-to-LPV tracking quality never raises an anomaly from an absence", () => {
  it("reports unmeasured, not lpv_drop_suspected, when landing-page views were never measured", () => {
    const result = computeTrackingQualityStatus({ linkClicks: 600, landingPageViews: null });
    expect(result.status).toBe("click_to_lpv_unmeasured");
    expect(result.landing_page_views).toBeNull();
    expect(result.landing_page_view_rate).toBeNull();
    expect(result.link_clicks).toBe(600);
  });

  it("reports unmeasured when link clicks were never measured", () => {
    const result = computeTrackingQualityStatus({ linkClicks: null, landingPageViews: 40 });
    expect(result.status).toBe("click_to_lpv_unmeasured");
    expect(result.link_clicks).toBeNull();
  });

  it("treats a malformed count as unmeasured, never as a zero", () => {
    for (const malformed of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(
        computeTrackingQualityStatus({ linkClicks: 600, landingPageViews: malformed }).status,
      ).toBe("click_to_lpv_unmeasured");
    }
  });

  it("still flags a MEASURED zero against a dense click sample: that is two observations disagreeing", () => {
    // The control: without it, "never flags" would pass for the wrong reason.
    expect(computeTrackingQualityStatus({ linkClicks: 600, landingPageViews: 0 }).status).toBe(
      "lpv_drop_suspected",
    );
  });
});

describe("trackingQualityFromAdRows sums every window complete-or-null", () => {
  const window = (rows: MetaAdDailyRow[]) =>
    trackingQualityFromAdRows(rows, "2026-05-01", "2026-05-28");

  it("does not fabricate an LPV drop from a delivered day whose LPVs were not measured", () => {
    // The old reduce read this as 5 LPVs over 610 clicks: lpv_drop_suspected.
    const result = window([
      adDay({ date: "2026-05-10", linkClicks: 600, landingPageViews: null }),
      adDay({ date: "2026-05-11", linkClicks: 10, landingPageViews: 5 }),
    ]);
    expect(result.status).toBe("click_to_lpv_unmeasured");
    expect(result.landing_page_views).toBeNull();
    expect(result.link_clicks).toBe(610);
  });

  it("zero + missing is null, zero + zero is 0", () => {
    const missing = window([
      adDay({ date: "2026-05-10", linkClicks: 600, landingPageViews: 0, addToCart: 0 }),
      adDay({ date: "2026-05-11", linkClicks: 0, landingPageViews: null, addToCart: null }),
    ]);
    expect(missing.landing_page_views).toBeNull();
    expect(missing.add_to_cart).toBeNull();

    const measured = window([
      adDay({ date: "2026-05-10", linkClicks: 600, landingPageViews: 0, addToCart: 0 }),
      adDay({ date: "2026-05-11", linkClicks: 0, landingPageViews: 0, addToCart: 0 }),
    ]);
    expect(measured.landing_page_views).toBe(0);
    expect(measured.add_to_cart).toBe(0);
    expect(measured.status).toBe("lpv_drop_suspected");
  });

  it("a partial link-click window is null, never the sum of the measured days", () => {
    const result = window([
      adDay({ date: "2026-05-10", linkClicks: 600, landingPageViews: 300 }),
      adDay({ date: "2026-05-11", linkClicks: null, landingPageViews: 20 }),
    ]);
    expect(result.link_clicks).toBeNull();
    expect(result.status).toBe("click_to_lpv_unmeasured");
  });

  it("an ad-day that did nothing at all is not a gap", () => {
    // The over-correction guard: an inert day has no events to have missed.
    const result = window([
      adDay({ date: "2026-05-10", linkClicks: 600, landingPageViews: 300 }),
      adDay({ date: "2026-05-11", ...INERT_DAY, linkClicks: null, landingPageViews: null }),
    ]);
    expect(result.link_clicks).toBe(600);
    expect(result.landing_page_views).toBe(300);
    expect(result.status).toBe("click_to_lpv_observed");
  });

  it("an entity with no measured ad-day is unmeasured rather than an empty zero sample", () => {
    expect(window([]).status).toBe("click_to_lpv_unmeasured");
    expect(window([]).link_clicks).toBeNull();
  });

  it("keeps purchases on plain summation: they come from a NOT NULL column", () => {
    const result = window([
      adDay({ date: "2026-05-10", conversions: 2 }),
      adDay({ date: "2026-05-11", conversions: 3 }),
    ]);
    expect(result.purchases).toBe(5);
  });
});
