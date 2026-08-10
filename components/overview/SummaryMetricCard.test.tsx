import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SummaryMetricCard } from "@/components/overview/SummaryMetricCard";
import type { OverviewMetricCardData } from "@/src/types/models";

/**
 * The percentage this card is allowed to print.
 *
 * Under Compare=None there is no baseline, so `changePct` is null — and the
 * card rendered `0.0%` for it, because the delta resolver did `changePct ?? 0`.
 * Zero percent is a measurement: it says the metric held steady against the
 * previous period. "We are not comparing" says nothing of the kind, and the
 * two were indistinguishable on the most-read cards in the product. The Pins
 * strip beside them showed "No comparison selected for this period" at the
 * same moment, so the same screen made both claims about the same data.
 *
 * These assert the rendered card, not the helper: the helper was reachable
 * only through this component, and the defect lived in how the component
 * called it.
 */
function metric(
  overrides: Partial<OverviewMetricCardData> = {},
): OverviewMetricCardData {
  return {
    id: "spend",
    title: "Total spend",
    value: 4400,
    previousValue: null,
    changePct: null,
    sparklineData: [],
    trendDirection: "neutral",
    trendSentiment: "neutral",
    dataSource: { key: "meta", label: "Meta" },
    status: "available",
    unit: "currency",
    ...overrides,
  } as OverviewMetricCardData;
}

const render = (data: OverviewMetricCardData) =>
  renderToStaticMarkup(<SummaryMetricCard metric={data} currencySymbol="$" />);

describe("a card with no comparison does not print a percentage", () => {
  it("renders an em dash instead of 0.0% when changePct is null", () => {
    const html = render(metric({ changePct: null }));
    expect(
      html.includes("0.0%"),
      "the card printed 0.0% for a comparison that was never made",
    ).toBe(false);
    expect(html).toContain("—");
  });

  it("says why there is no percentage rather than leaving a bare dash", () => {
    const html = render(metric({ changePct: null }));
    expect(html).toMatch(/No comparison selected|no comparison/i);
  });

  it("marks the absence in the DOM so a browser check can see it", () => {
    const html = render(metric({ changePct: null }));
    expect(html).toContain('data-delta-state="unavailable"');
  });

  it("applies no direction and no sentiment colour to a missing comparison", () => {
    // A dash tinted green or red still tells the reader something happened.
    const html = render(metric({ changePct: null }));
    expect(html).not.toContain("text-emerald-600");
    expect(html).not.toContain("text-rose-600");
    expect(html).not.toContain("bg-emerald-500/10");
    expect(html).not.toContain("bg-rose-500/10");
  });

  it("does not render a direction arrow for a comparison that does not exist", () => {
    const html = render(metric({ changePct: null }));
    // The neutral glyph is a minus; up/down arrows imply a measured move.
    expect(html).not.toContain("lucide-arrow-up-right");
    expect(html).not.toContain("lucide-arrow-down-right");
  });
});

describe("a real zero is still a real zero", () => {
  it("prints 0.0% when the metric genuinely did not move", () => {
    // The fix must not erase a measured flat result, which is a different
    // statement from "not compared" and is worth showing.
    const html = render(
      metric({ changePct: 0, previousValue: 4400, trendSentiment: "neutral" }),
    );
    expect(html).toContain("0.0%");
    expect(html).toContain('data-delta-state="measured"');
  });

  it("prints a measured move with its sign", () => {
    const html = render(
      metric({
        changePct: 12.5,
        previousValue: 3900,
        trendDirection: "up",
        trendSentiment: "positive",
      }),
    );
    expect(html).toContain("+12.5%");
    expect(html).toContain('data-delta-state="measured"');
  });

  it("colours a measured move by meaning, not by sign", () => {
    // A rising cost is an up arrow and a negative outcome.
    const html = render(
      metric({
        id: "cpa",
        title: "CPA",
        changePct: 9,
        previousValue: 20,
        trendDirection: "up",
        trendSentiment: "negative",
      }),
    );
    expect(html).toContain("text-rose-600");
    expect(html).not.toContain("text-emerald-600");
  });
});
