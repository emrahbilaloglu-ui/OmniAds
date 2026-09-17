import { describe, expect, it } from "vitest";

import { formatOverviewDelta, formatOverviewMetricValue, formatOverviewSparklineValue } from "./metric-format";

describe("canonical Overview metric formatting", () => {
  it("keeps absent values honest and uses a U+2212 minus", () => {
    const metric = {
      id: "revenue",
      title: "Revenue",
      unit: "currency",
    } as const;

    expect(formatOverviewMetricValue(metric, null, "$")).toBe("—");
    expect(formatOverviewMetricValue(metric, -1250, "$")).toBe("−$1,250");
    expect(formatOverviewSparklineValue({ id: "pins-spend", title: "Ad Spend", unit: "currency" }, 3_350, "")).toBe(
      "—"
    );
    expect(formatOverviewDelta(-0.4)).toBe("−0.4%");
  });

  it("uses the canonical compact-card formats", () => {
    expect(
      formatOverviewMetricValue(
        {
          id: "web-session-duration",
          title: "Avg session",
          unit: "duration_seconds",
        },
        161,
        "$"
      )
    ).toBe("2m 41s");
    expect(formatOverviewMetricValue({ id: "ltv-cac", title: "LTV : CAC", unit: "ratio" }, 3.24, "$")).toBe("3.2x");
    expect(formatOverviewMetricValue({ id: "store-aov", title: "AOV", unit: "currency" }, 77.66, "$")).toBe("$77.66");
  });

  it("formats chart values separately from the exact KPI face", () => {
    expect(formatOverviewSparklineValue({ id: "web-sessions", title: "Sessions", unit: "count" }, 8_240, "$")).toBe(
      "8.2k"
    );
    expect(formatOverviewSparklineValue({ id: "pins-spend", title: "Ad Spend", unit: "currency" }, 3_350, "$")).toBe(
      "$3.4k spend"
    );
    expect(
      formatOverviewSparklineValue(
        {
          id: "pins-conversion-rate",
          title: "Conv Rate · GA4",
          unit: "percent",
        },
        2.34,
        "$"
      )
    ).toBe("2.34% CVR");
    expect(formatOverviewSparklineValue({ id: "pins-revenue", title: "Revenue", unit: "currency" }, 17_250, "$")).toBe(
      "$17.3k revenue"
    );
  });

  it("formats provider diagnostics and keeps fractional Google conversions", () => {
    const google = (id: string, unit: "count" | "currency" | "percent") => ({ id, title: id, unit });
    expect(formatOverviewMetricValue(google("google-purchases", "count"), 12.5, "$")).toBe("12.5");
    expect(formatOverviewMetricValue(google("google-purchases", "count"), 4.83, "$")).toBe("4.83");
    expect(formatOverviewMetricValue(google("google-purchases", "count"), 1200, "$")).toBe("1,200");
    // Meta purchases stay whole numbers.
    expect(formatOverviewMetricValue({ id: "meta-purchases", title: "Purchases", unit: "count" }, 12.5, "$")).toBe("13");
    expect(formatOverviewSparklineValue(google("google-purchases", "count"), 1.25, "$")).toBe("1.25");

    expect(formatOverviewSparklineValue({ id: "meta-cpm", title: "CPM", unit: "currency" }, 12.345, "$")).toBe("$12.35");
    expect(formatOverviewSparklineValue({ id: "meta-cpc", title: "All-click CPC", unit: "currency" }, 0.4, "$")).toBe(
      "$0.40",
    );
    expect(formatOverviewSparklineValue(google("google-cpc", "currency"), 0.75, "")).toBe("—");
    expect(formatOverviewSparklineValue({ id: "meta-ctr", title: "All-click CTR", unit: "percent" }, 1.8182, "$")).toBe(
      "1.82%",
    );
    expect(formatOverviewSparklineValue(google("google-conversion-rate", "percent"), 12.5, "$")).toBe("12.50%");
  });

  it("uses each canonical card's formatter at boundary values", () => {
    expect(formatOverviewSparklineValue({ id: "web-sessions", title: "Sessions", unit: "count" }, 900, "$")).toBe(
      "0.9k"
    );
    expect(formatOverviewSparklineValue({ id: "meta-purchases", title: "Purchases", unit: "count" }, 1_200, "$")).toBe(
      "1200"
    );
    expect(
      formatOverviewSparklineValue({ id: "google-revenue", title: "Revenue", unit: "currency" }, 1_200_000, "$")
    ).toBe("$1200.0k");
    expect(
      formatOverviewSparklineValue({ id: "web-engagement-rate", title: "Engagement", unit: "percent" }, 63.44, "$")
    ).toBe("63.4%");
    expect(formatOverviewSparklineValue({ id: "meta-cpa", title: "CPA", unit: "currency" }, 1_200, "$")).toBe(
      "$1200.00"
    );
    expect(
      formatOverviewSparklineValue(
        { id: "web-session-duration", title: "Avg session", unit: "duration_seconds" },
        119.6,
        "$"
      )
    ).toBe("1m 60s");
  });
});
