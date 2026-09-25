import { describe, expect, it } from "vitest";
import {
  aggregateOverviewProviderRow,
  aggregateVerifiedOverviewProviderRow,
  buildAttributionRows,
  buildPlatformSections,
} from "@/lib/overview-summary-support";

type Row = {
  platform: string;
  spend: number;
  revenue: number;
  purchases: number;
  roas: number;
  cpa: number;
  impressions?: number;
  clicks?: number;
};

type TrendPoint = {
  date: string;
  spend: number;
  revenue: number;
  purchases: number;
  impressions: number | null;
  clicks: number | null;
};

type Sources = { meta: string | null; google: string | null };

function overview(
  rows: Row[],
  providerTrends: { meta?: TrendPoint[]; google?: TrendPoint[] } = {},
  sources: { scalar?: Sources; trend?: Sources } = {},
) {
  return {
    platformEfficiency: rows,
    providerTrends: { meta: [], google: [], ...providerTrends },
    providerSources: sources.scalar ?? { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" },
    providerTrendSources: sources.trend ?? { meta: "warehouse_published_account_daily", google: "warehouse_account_daily" },
  } as never;
}

function row(platform: string, values: Partial<Row>): Row {
  return { platform, spend: 0, revenue: 0, purchases: 0, roas: 0, cpa: 0, ...values };
}

function metricsFor(sections: ReturnType<typeof buildPlatformSections>, provider: "meta" | "google") {
  const section = sections.find((candidate) => candidate.provider === provider);
  if (!section) throw new Error(`missing ${provider} section`);
  return Object.fromEntries(section.metrics.map((metric) => [metric.id, metric]));
}

describe("Dashboard v2 Overview provider contracts", () => {
  it("shows source-backed provider metrics for a partial window without inventing a full-period comparison", () => {
    const current = Object.assign(
      overview([row("meta", { spend: 150, revenue: 300, purchases: 3 })]),
      { providerScalarRanges: { meta: { startDate: "2026-09-18", endDate: "2026-09-23" }, google: null } },
    ) as Parameters<typeof buildPlatformSections>[0];
    const previous = overview([row("meta", { spend: 100, revenue: 200, purchases: 2 })]);
    const sections = buildPlatformSections(current, previous, "previous_period", {
      startDate: "2026-09-18", endDate: "2026-09-24",
    });

    expect(sections.find((section) => section.provider === "meta")?.coverageNote).toBe(
      "Available source range: 2026-09-18–2026-09-23; selected range: 2026-09-18–2026-09-24. Totals do not cover the full selection.",
    );
    expect(metricsFor(sections, "meta")["meta-spend"]).toEqual(
      expect.objectContaining({ value: 150, previousValue: null, changePct: null }),
    );
  });

  it("aggregates account-grain rows into one provider total", () => {
    const source = overview([
      {
        platform: "meta",
        spend: 60,
        revenue: 180,
        purchases: 6,
        roas: 3,
        cpa: 10,
      },
      {
        platform: "meta",
        spend: 40,
        revenue: 80,
        purchases: 2,
        roas: 2,
        cpa: 20,
      },
    ]);

    expect(aggregateOverviewProviderRow(source, "meta")).toEqual({
      platform: "meta",
      spend: 100,
      revenue: 260,
      purchases: 8,
      roas: 2.6,
      cpa: 12.5,
      // Neither row reported delivery counts: unknown, not zero.
      impressions: null,
      clicks: null,
    });
  });

  it("withholds provider rows whose scalar source is unknown", () => {
    const source = overview(
      [row("meta", { spend: 100, revenue: 260, purchases: 8 })],
      {},
      { scalar: { meta: null, google: "warehouse_account_aggregate" } },
    );

    expect(aggregateOverviewProviderRow(source, "meta")?.spend).toBe(100);
    expect(aggregateVerifiedOverviewProviderRow(source, "meta")).toBeNull();
    expect(metricsFor(buildPlatformSections(source, null, "none"), "meta")["meta-spend"]).toEqual(
      expect.objectContaining({ value: null, status: "unavailable" }),
    );
    expect(buildAttributionRows(source, { revenue: null, conversions: null })[0]).toEqual(
      expect.objectContaining({ spend: null, revenue: null, roas: null }),
    );
  });

  it("returns only the four canonical channels and derives share from spend", () => {
    const rows = buildAttributionRows(
      overview([
        {
          platform: "meta",
          spend: 60,
          revenue: 180,
          purchases: 6,
          roas: 3,
          cpa: 10,
        },
        {
          platform: "google_ads",
          spend: 40,
          revenue: 80,
          purchases: 2,
          roas: 2,
          cpa: 20,
        },
        {
          platform: "tiktok",
          spend: 900,
          revenue: 9_000,
          purchases: 100,
          roas: 10,
          cpa: 9,
        },
      ]),
      { revenue: null, conversions: null }
    );

    expect(rows.map((row) => row.channel)).toEqual(["Meta Ads", "Google Ads", "Klaviyo", "Organic · GA4"]);
    expect(rows.map((row) => row.spendShare)).toEqual([60, 40, null, null]);
    expect(rows[2]).toEqual(
      expect.objectContaining({
        spend: null,
        revenue: null,
        conversions: null,
      })
    );
  });

  it("keeps two provider-specific eight-stat shells when provider data is absent", () => {
    const sections = buildPlatformSections(overview([]), null, "none");

    expect(sections.map((section) => section.provider)).toEqual(["meta", "google"]);
    expect(sections.map((section) => section.metrics.map((metric) => metric.id))).toEqual([
      ["meta-spend", "meta-revenue", "meta-roas", "meta-purchases", "meta-cpa", "meta-cpm", "meta-ctr", "meta-cpc"],
      [
        "google-spend",
        "google-revenue",
        "google-roas",
        "google-purchases",
        "google-cpa",
        "google-ctr",
        "google-cpc",
        "google-conversion-rate",
      ],
    ]);
    expect(sections.map((section) => section.metrics.map((metric) => metric.title))).toEqual([
      ["Spend", "Revenue", "ROAS", "Purchases", "CPA", "CPM", "All-click CTR", "All-click CPC"],
      ["Spend", "Conversion value", "ROAS", "Conversions", "Cost / conv.", "CTR", "CPC", "Conversion rate"],
    ]);
    expect(
      sections
        .flatMap((section) => section.metrics)
        .every(
          (metric) =>
            metric.value === null &&
            metric.status === "unavailable" &&
            metric.helperText === "No synced provider data for this window",
        ),
    ).toBe(true);
  });

  it("derives every rate from summed provider primitives, not averaged account rates", () => {
    const sections = buildPlatformSections(
      overview([
        // Account A: CTR 10%, CPM 50. Account B: CTR 1%, CPM 5.
        row("meta", { spend: 50, revenue: 150, purchases: 5, impressions: 1_000, clicks: 100 }),
        row("meta", { spend: 50, revenue: 50, purchases: 5, impressions: 10_000, clicks: 100 }),
        row("google_ads", { spend: 40, revenue: 120, purchases: 2.5, impressions: 2_000, clicks: 80 }),
      ]),
      null,
      "none",
    );
    const meta = metricsFor(sections, "meta");
    const google = metricsFor(sections, "google");

    expect(meta["meta-spend"]?.value).toBe(100);
    expect(meta["meta-revenue"]?.value).toBe(200);
    expect(meta["meta-roas"]?.value).toBe(2);
    expect(meta["meta-purchases"]?.value).toBe(10);
    expect(meta["meta-cpa"]?.value).toBe(10);
    // 100 / 11,000 × 1000 = 9.0909, not the 27.5 average of the account CPMs.
    expect(meta["meta-cpm"]?.value).toBe(9.0909);
    // 200 / 11,000 × 100 = 1.8182%, not the 5.5% average of the account CTRs.
    expect(meta["meta-ctr"]?.value).toBe(1.8182);
    expect(meta["meta-cpc"]?.value).toBe(0.5);

    expect(google["google-revenue"]?.value).toBe(120);
    expect(google["google-purchases"]?.value).toBe(2.5);
    expect(google["google-cpa"]?.value).toBe(16);
    expect(google["google-ctr"]?.value).toBe(4);
    expect(google["google-cpc"]?.value).toBe(0.5);
    // 2.5 conversions / 80 clicks × 100.
    expect(google["google-conversion-rate"]?.value).toBe(3.125);
    // Google has no CPM card and Meta has no conversion-rate card.
    expect(google["google-cpm"]).toBeUndefined();
    expect(meta["meta-conversion-rate"]).toBeUndefined();
  });

  it("keeps fractional Google conversions to two decimals", () => {
    const sections = buildPlatformSections(
      overview([row("google", { spend: 10, revenue: 20, purchases: 4.8267, impressions: 100, clicks: 10 })]),
      null,
      "none",
    );
    const google = metricsFor(sections, "google");

    expect(google["google-purchases"]?.value).toBe(4.83);
    expect(google["google-conversion-rate"]?.value).toBe(48.267);
  });

  it("returns null with a reason for zero or unreported denominators instead of fabricating zero", () => {
    const sections = buildPlatformSections(
      overview([
        row("meta", { spend: 0, revenue: 0, purchases: 0, impressions: 0, clicks: 0 }),
        // Google reported no delivery counts at all.
        row("google", { spend: 25, revenue: 0, purchases: 0 }),
      ]),
      null,
      "none",
    );
    const meta = metricsFor(sections, "meta");
    const google = metricsFor(sections, "google");

    for (const id of ["meta-roas", "meta-cpa", "meta-cpm", "meta-ctr", "meta-cpc"]) {
      expect(meta[id]?.value, id).toBeNull();
      expect(meta[id]?.status, id).toBe("unavailable");
    }
    expect(meta["meta-roas"]?.helperText).toBe("No spend in this window");
    expect(meta["meta-cpa"]?.helperText).toBe("No purchases in this window");
    expect(meta["meta-cpm"]?.helperText).toBe("No impressions in this window");
    expect(meta["meta-cpc"]?.helperText).toBe("No clicks in this window");
    // Measured zeros stay real values.
    expect(meta["meta-spend"]).toEqual(expect.objectContaining({ value: 0, status: "available" }));

    expect(google["google-roas"]?.value).toBe(0);
    expect(google["google-cpa"]).toEqual(
      expect.objectContaining({ value: null, helperText: "No conversions in this window" }),
    );
    expect(google["google-ctr"]).toEqual(
      expect.objectContaining({ value: null, helperText: "Impressions were not reported for this window" }),
    );
    expect(google["google-conversion-rate"]).toEqual(
      expect.objectContaining({ value: null, helperText: "Clicks were not reported for this window" }),
    );
  });

  it("compares each metric with the same derivation from the previous window and signs sentiment by metric", () => {
    const current = overview([
      row("meta", { spend: 110, revenue: 330, purchases: 10, impressions: 10_000, clicks: 250 }),
      row("google", { spend: 50, revenue: 100, purchases: 5, impressions: 1_000, clicks: 40 }),
    ]);
    const previous = overview([
      row("meta", { spend: 100, revenue: 400, purchases: 10, impressions: 12_500, clicks: 200 }),
      row("google", { spend: 50, revenue: 100, purchases: 4, impressions: 1_000, clicks: 50 }),
    ]);
    const sections = buildPlatformSections(current, previous, "previous_period");
    const meta = metricsFor(sections, "meta");
    const google = metricsFor(sections, "google");

    // CPM 8 → 11: previous derived from the previous window's primitives.
    expect(meta["meta-cpm"]).toEqual(
      expect.objectContaining({ value: 11, previousValue: 8, changePct: 37.5, trendSentiment: "negative" }),
    );
    // CTR 1.6% → 2.5%: higher is better. (0.9 / 1.6 is 56.2499… in floating
    // point, which the one-decimal change rounds to 56.2.)
    expect(meta["meta-ctr"]).toEqual(
      expect.objectContaining({ value: 2.5, previousValue: 1.6, changePct: 56.2, trendSentiment: "positive" }),
    );
    // CPC 0.5 → 0.44: lower is better.
    expect(meta["meta-cpc"]).toEqual(
      expect.objectContaining({ value: 0.44, previousValue: 0.5, changePct: -12, trendSentiment: "positive" }),
    );
    expect(meta["meta-roas"]).toEqual(expect.objectContaining({ changePct: -25, trendSentiment: "negative" }));
    // Spend is deliberately neutral whichever way it moves.
    expect(meta["meta-spend"]).toEqual(expect.objectContaining({ changePct: 10, trendSentiment: "neutral" }));

    expect(google["google-purchases"]).toEqual(expect.objectContaining({ changePct: 25, trendSentiment: "positive" }));
    expect(google["google-cpa"]).toEqual(
      expect.objectContaining({ value: 10, previousValue: 12.5, changePct: -20, trendSentiment: "positive" }),
    );
    expect(google["google-conversion-rate"]).toEqual(
      expect.objectContaining({ value: 12.5, previousValue: 8, changePct: 56.3, trendSentiment: "positive" }),
    );
  });

  it("leaves the delta off when comparison is off or the previous window has no provider row", () => {
    const current = overview([row("meta", { spend: 10, revenue: 20, purchases: 1, impressions: 100, clicks: 5 })]);
    const off = metricsFor(buildPlatformSections(current, current, "none"), "meta");
    const noPrevious = metricsFor(buildPlatformSections(current, overview([]), "previous_period"), "meta");

    expect(Object.values(off).every((metric) => metric.changePct === null)).toBe(true);
    expect(Object.values(noPrevious).every((metric) => metric.previousValue === null && metric.changePct === null)).toBe(
      true,
    );
  });

  it("builds daily series from provider primitives and omits undefined-denominator days", () => {
    const sections = buildPlatformSections(
      overview([row("meta", { spend: 30, revenue: 60, purchases: 3, impressions: 3_000, clicks: 60 })], {
        meta: [
          { date: "2026-03-01", spend: 10, revenue: 30, purchases: 1, impressions: 1_000, clicks: 20 },
          { date: "2026-03-02", spend: 0, revenue: 0, purchases: 0, impressions: 0, clicks: 0 },
          { date: "2026-03-03", spend: 20, revenue: 30, purchases: 2, impressions: null, clicks: null },
        ],
      }),
      null,
      "none",
    );
    const meta = metricsFor(sections, "meta");

    expect(meta["meta-spend"]?.sparklineData.map((point) => point.value)).toEqual([10, 0, 20]);
    expect(meta["meta-roas"]?.sparklineData).toEqual([
      { date: "2026-03-01", value: 3 },
      { date: "2026-03-03", value: 1.5 },
    ]);
    expect(meta["meta-cpm"]?.sparklineData).toEqual([{ date: "2026-03-01", value: 10 }]);
    expect(meta["meta-ctr"]?.sparklineData).toEqual([{ date: "2026-03-01", value: 2 }]);
    expect(meta["meta-cpc"]?.sparklineData).toEqual([{ date: "2026-03-01", value: 0.5 }]);
  });
  it.each([
    [
      "a Meta current-day live scalar with a warehouse trend",
      { meta: "current_day_live", google: "warehouse_account_aggregate" },
      { meta: "warehouse_published_account_daily", google: "warehouse_account_daily" },
      "meta",
      true,
    ],
    [
      "a Meta live historical fallback scalar with a warehouse trend",
      { meta: "live_historical_fallback", google: "warehouse_account_aggregate" },
      { meta: "warehouse_published_account_daily", google: "warehouse_account_daily" },
      "meta",
      true,
    ],
    [
      "a Google current-day live overlay with a warehouse daily trend",
      { meta: "warehouse_published_account_daily", google: "live_overlay_current_day" },
      { meta: "warehouse_published_account_daily", google: "warehouse_account_daily" },
      "google",
      true,
    ],
    [
      "a Google campaign-fallback scalar with an account daily trend",
      { meta: "warehouse_published_account_daily", google: "warehouse_campaign_aggregate_fallback" },
      { meta: "warehouse_published_account_daily", google: "warehouse_account_daily" },
      "google",
      true,
    ],
    [
      "a Google projection-fallback trend",
      { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" },
      { meta: "warehouse_published_account_daily", google: "projection_fallback" },
      "google",
      true,
    ],
    [
      "unknown trend sources",
      { meta: "warehouse_published_account_daily", google: "warehouse_account_aggregate" },
      { meta: null, google: null },
      "meta",
      false,
    ],
  ] as const)("attaches no provider series for %s", (_case, scalar, trend, provider, otherHasSeries) => {
    const point = { date: "2026-03-01", spend: 10, revenue: 20, purchases: 2, impressions: 1_000, clicks: 50 };
    const sections = buildPlatformSections(
      overview(
        [
          row("meta", { spend: 10, revenue: 20, purchases: 2, impressions: 1_000, clicks: 50 }),
          row("google", { spend: 10, revenue: 20, purchases: 2, impressions: 1_000, clicks: 50 }),
        ],
        { meta: [point, { ...point, date: "2026-03-02" }], google: [point, { ...point, date: "2026-03-02" }] },
        { scalar, trend },
      ),
      null,
      "none",
    );
    const blocked = metricsFor(sections, provider);
    const other = metricsFor(sections, provider === "meta" ? "google" : "meta");

    // The scalar values are unaffected; only the contradicting trend is withheld.
    expect(blocked[`${provider}-spend`]?.value).toBe(10);
    expect(Object.values(blocked).every((metric) => metric.sparklineData.length === 0)).toBe(true);
    // The other provider is judged on its own sources.
    const otherProvider = provider === "meta" ? "google" : "meta";
    expect(other[`${otherProvider}-spend`]?.sparklineData).toHaveLength(otherHasSeries ? 2 : 0);
  });

  it("attaches the Google campaign daily trend to a campaign-fallback scalar", () => {
    const point = { date: "2026-03-01", spend: 10, revenue: 20, purchases: 2, impressions: 1_000, clicks: 50 };
    const sections = buildPlatformSections(
      overview([row("google", { spend: 10, revenue: 20, purchases: 2, impressions: 1_000, clicks: 50 })], {
        google: [point, { ...point, date: "2026-03-02", clicks: 40 }],
      }, {
        scalar: { meta: null, google: "warehouse_campaign_aggregate_fallback" },
        trend: { meta: null, google: "warehouse_campaign_daily_fallback" },
      }),
      null,
      "none",
    );

    expect(metricsFor(sections, "google")["google-ctr"]?.sparklineData).toEqual([
      { date: "2026-03-01", value: 5 },
      { date: "2026-03-02", value: 4 },
    ]);
  });
  describe("previous-period comparability", () => {
    const currentRow = row("google", { spend: 50, revenue: 100, purchases: 5, impressions: 1_000, clicks: 40 });
    const previousRow = row("google", { spend: 40, revenue: 100, purchases: 4, impressions: 1_000, clicks: 50 });
    const metaCurrentRow = row("meta", { spend: 110, revenue: 330, purchases: 10, impressions: 10_000, clicks: 250 });
    const metaPreviousRow = row("meta", { spend: 100, revenue: 400, purchases: 10, impressions: 12_500, clicks: 200 });

    function windowWith(sources: Sources, rows: Row[]) {
      return overview(rows, {}, { scalar: sources, trend: { meta: null, google: null } });
    }

    it.each([
      [
        "Google account aggregate vs account aggregate",
        { meta: null, google: "warehouse_account_aggregate" },
        { meta: null, google: "warehouse_account_aggregate" },
        "google",
      ],
      [
        "Google campaign fallback vs campaign fallback",
        { meta: null, google: "warehouse_campaign_aggregate_fallback" },
        { meta: null, google: "warehouse_campaign_aggregate_fallback" },
        "google",
      ],
      [
        "Meta campaign grain vs campaign grain",
        { meta: "warehouse_published_campaign_daily", google: null },
        { meta: "warehouse_published_campaign_daily", google: null },
        "meta",
      ],
      [
        "Meta live historical fallback vs the same live read",
        { meta: "live_historical_fallback", google: null },
        { meta: "live_historical_fallback", google: null },
        "meta",
      ],
    ] as const)("keeps the delta for %s", (_case, currentSources, previousSources, provider) => {
      const sections = buildPlatformSections(
        windowWith(currentSources, provider === "google" ? [currentRow] : [metaCurrentRow]),
        windowWith(previousSources, provider === "google" ? [previousRow] : [metaPreviousRow]),
        "previous_period",
      );
      const metrics = metricsFor(sections, provider);

      expect(metrics[`${provider}-spend`]).toEqual(
        expect.objectContaining({ previousValue: provider === "google" ? 40 : 100 }),
      );
      expect(metrics[`${provider}-spend`]?.changePct).not.toBeNull();
      expect(metrics[`${provider}-ctr`]?.changePct).not.toBeNull();
    });

    it.each([
      [
        "Google account aggregate vs campaign fallback",
        { meta: null, google: "warehouse_account_aggregate" },
        { meta: null, google: "warehouse_campaign_aggregate_fallback" },
        "google",
      ],
      [
        "Google campaign fallback vs account aggregate",
        { meta: null, google: "warehouse_campaign_aggregate_fallback" },
        { meta: null, google: "warehouse_account_aggregate" },
        "google",
      ],
      [
        "Google live overlay vs warehouse account aggregate",
        { meta: null, google: "live_overlay_current_day" },
        { meta: null, google: "warehouse_account_aggregate" },
        "google",
      ],
      [
        "Meta campaign grain vs account grain",
        { meta: "warehouse_published_campaign_daily", google: null },
        { meta: "warehouse_published_account_daily", google: null },
        "meta",
      ],
      [
        "Meta live historical fallback vs published warehouse",
        { meta: "live_historical_fallback", google: null },
        { meta: "warehouse_published_account_daily", google: null },
        "meta",
      ],
      [
        "Meta current-day live vs published warehouse",
        { meta: "current_day_live", google: null },
        { meta: "warehouse_published_account_daily", google: null },
        "meta",
      ],
      [
        "an unknown previous source",
        { meta: null, google: "warehouse_account_aggregate" },
        { meta: null, google: null },
        "google",
      ],
    ] as const)("drops the previous value and delta for %s", (_case, currentSources, previousSources, provider) => {
      const sections = buildPlatformSections(
        windowWith(currentSources, provider === "google" ? [currentRow] : [metaCurrentRow]),
        windowWith(previousSources, provider === "google" ? [previousRow] : [metaPreviousRow]),
        "previous_period",
      );
      const metrics = Object.values(metricsFor(sections, provider));

      // Current values stay; nothing compares rows read from a different source.
      expect(metrics.find((metric) => metric.id === `${provider}-spend`)?.value).toBe(
        provider === "google" ? 50 : 110,
      );
      expect(metrics.every((metric) => metric.previousValue === null && metric.changePct === null)).toBe(true);
    });
  });
});
