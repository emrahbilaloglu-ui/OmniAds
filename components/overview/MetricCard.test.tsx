import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/overview/MiniTrendAreaChart", () => ({
  MiniTrendAreaChart: () => null,
}));
vi.mock("@/components/overview/MetricSourceLogos", () => ({
  MetricSourceLogos: () => null,
}));

import { MetricCard } from "@/components/overview/MetricCard";

function render(props: Partial<React.ComponentProps<typeof MetricCard>> = {}) {
  return renderToStaticMarkup(
    <MetricCard
      title="Spend"
      value={1234}
      changePercent={null}
      trendData={[]}
      dataSource="Meta"
      metricKey="spend"
      unit="currency"
      currencySymbol="$"
      {...props}
    />,
  );
}

describe("MetricCard delta rendering", () => {
  it("shows no fabricated delta when the comparison mode is none", () => {
    const html = render({ metricKey: "spend", changePercent: null, comparisonMode: "none" });
    expect(html).not.toContain("0.0%");
    expect(html).toContain("No comparison");
  });

  it("shows no fabricated delta when a change is simply absent", () => {
    const html = render({ metricKey: "revenue", changePercent: null });
    expect(html).not.toContain("+0.0%");
  });

  it("paints a rising cost metric as a worse outcome, not a win", () => {
    const html = render({
      metricKey: "cpa",
      title: "CPA",
      changePercent: 22,
      comparisonMode: "previous_period",
    });
    expect(html).toContain("+22.0%");
    expect(html).toContain("rose-500/10");
    expect(html).not.toContain("emerald-500/10");
  });

  it("paints a rising revenue metric as a win", () => {
    const html = render({
      metricKey: "revenue",
      title: "Revenue",
      changePercent: 22,
      comparisonMode: "previous_period",
    });
    expect(html).toContain("emerald-500/10");
    expect(html).not.toContain("rose-500/10");
  });

  it("leaves a spend change uncoloured because spend has no inherent direction", () => {
    const html = render({
      metricKey: "spend",
      changePercent: 30,
      comparisonMode: "previous_period",
    });
    expect(html).not.toContain("emerald-500/10");
    expect(html).not.toContain("rose-500/10");
  });

  it("names the comparison basis next to every real delta", () => {
    const html = render({
      metricKey: "revenue",
      changePercent: 12,
      comparisonMode: "previous_period",
    });
    expect(html).toContain("vs previous period");
  });

  it("renders a real zero change as a measured flat result", () => {
    const html = render({
      metricKey: "revenue",
      changePercent: 0,
      comparisonMode: "previous_period",
    });
    expect(html).toContain("0.0%");
    expect(html).toContain("vs previous period");
  });
});
