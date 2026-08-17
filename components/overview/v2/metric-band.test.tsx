import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { OverviewMetricCardData } from "@/src/types/models";
import { DeltaChip, HeroTile, StatTile } from "./metric-band";

function metric(overrides: Partial<OverviewMetricCardData> = {}): OverviewMetricCardData {
  return {
    id: "spend",
    title: "Ad Spend",
    subtitle: "Paid media investment",
    value: 118_220,
    previousValue: 109_360,
    changePct: 8.1,
    sparklineData: [
      { date: "2026-08-01", value: 3_350 },
      { date: "2026-08-02", value: 3_600 },
    ],
    previousSparklineData: [
      { date: "2026-07-01", value: 3_100 },
      { date: "2026-07-02", value: 3_200 },
    ],
    trendDirection: "up",
    trendSentiment: "positive",
    dataSource: { key: "meta", label: "Meta" },
    status: "available",
    unit: "currency",
    ...overrides,
  };
}

describe("canonical Overview metric band", () => {
  it("uses all four literal canonical hero-tile paths", () => {
    const paths = [
      "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z M8 7h8 M8 11h8 M8 15h5",
      "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
      "M8 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M19 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12",
      "M19 5L5 19 M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
    ];

    paths.forEach((path, index) => {
      const html = renderToStaticMarkup(<HeroTile metric={metric()} currencySymbol="$" index={index} />);
      expect(html).toContain(`d="${path}"`);
    });
  });

  it("keeps a missing hero comparison in the translucent hero chip", () => {
    const html = renderToStaticMarkup(
      <DeltaChip metric={metric({ changePct: null, previousValue: null })} tone="hero" />
    );

    expect(html).toContain("rgba(255,255,255,0.16)");
    expect(html).toContain("—");
    expect(html).not.toContain("adv-chip");
  });

  it("uses the design's info delta and exact geometry on the spend tile", () => {
    const html = renderToStaticMarkup(<HeroTile metric={metric()} currencySymbol="$" index={0} />);

    expect(html).toContain("background:#EAF0FF;color:#2F6BFF");
    expect(html).toContain("gap-[3px]");
    expect(html).toContain("text-[11.5px]");
    expect(html).toContain('style="margin-top:12px"');
    expect(html).not.toContain('class="mt-3"');
    expect(html).toContain(
      'd="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z M8 7h8 M8 11h8 M8 15h5"'
    );
    expect(html).not.toMatch(/\stitle=/);
  });

  it("uses the Percent icon and U+2212 delta on the fourth tile", () => {
    const html = renderToStaticMarkup(
      <HeroTile
        metric={metric({
          id: "conversion_rate",
          title: "Conv Rate · GA4",
          value: 2.34,
          changePct: -0.4,
          trendDirection: "down",
          trendSentiment: "negative",
          unit: "percent",
        })}
        currencySymbol="$"
        index={3}
      />
    );

    expect(html).toContain(
      'd="M19 5L5 19 M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"'
    );
    expect(html).toContain("−0.4%");
    expect(html).toContain("background:#B45309");
  });

  it("uses parent-supplied card colours and no compact number tracking", () => {
    const html = renderToStaticMarkup(
      <StatTile
        metric={metric({
          id: "web-session-duration",
          title: "Avg session",
          value: 161,
          unit: "duration_seconds",
        })}
        currencySymbol="$"
        line="#B45309"
        fill="rgba(180,83,9,0.07)"
      />
    );

    expect(html).toContain("2m 41s");
    expect(html).toContain("text-[9px]");
    expect(html).toContain("letter-spacing:normal");
    expect(html).not.toContain("adv-num");
    expect(html).toContain('stroke="#B45309"');
    expect(html).toContain('fill="rgba(180,83,9,0.07)"');
    expect(html).not.toMatch(/\stitle=/);
  });
});
