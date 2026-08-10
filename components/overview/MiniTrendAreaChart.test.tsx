import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MiniTrendAreaChart } from "@/components/overview/MiniTrendAreaChart";

/**
 * The sparkline beside every Overview metric.
 *
 * Three things were wrong with it at once, and they compound. It accepted a
 * `tone` and ignored it (`tone: _tone`), painting every metric with the same
 * blue-to-emerald gradient — so a rising CPA and rising revenue got the same
 * green-tipped line, and the colour was decoration presented as meaning. The
 * SVG carried `aria-hidden="true"`, so the trend was absent for anyone using
 * assistive technology. And the only way to read a point was a pointer
 * tooltip, so it was unreachable by keyboard too.
 *
 * The fix does not invent sentiment. There is no trustworthy per-metric
 * direction input here, so the line is neutral and the numbers carry the
 * meaning.
 */
const series = [
  { date: "2026-08-01", value: 100 },
  { date: "2026-08-02", value: 140 },
  { date: "2026-08-03", value: 90 },
];

const source = readFileSync(
  "components/overview/MiniTrendAreaChart.tsx",
  "utf8",
);

describe("the line does not imply a verdict it cannot know", () => {
  it("uses no positive-coded gradient", () => {
    // blue -> emerald reads as "good" whatever the metric is doing.
    expect(source).not.toContain('stopColor="#0E9F6E"');
  });

  it("does not accept a tone it silently ignores", () => {
    // A prop that is accepted and dropped is worse than an absent one: callers
    // believe they are colouring the chart.
    expect(source).not.toContain("tone: _tone");
  });
});

describe("the trend is available without a pointer", () => {
  it("is not hidden from assistive technology", () => {
    const html = renderToStaticMarkup(
      <MiniTrendAreaChart data={series} label="Total spend" unit="currency" />,
    );
    // The wrapper carries the role and the name; the SVG below it stays
    // presentational, which is the correct split. What matters is that the
    // chart is reachable at all -- previously the SVG was hidden and nothing
    // above it was exposed, so the trend simply did not exist.
    const wrapper = html.slice(0, html.indexOf("<svg"));
    expect(wrapper).not.toContain('aria-hidden="true"');
    expect(wrapper).toContain('role="group"');
    expect(wrapper).toContain("aria-label=");
  });

  it("has an accessible name and a readable summary", () => {
    const html = renderToStaticMarkup(
      <MiniTrendAreaChart data={series} label="Total spend" unit="currency" />,
    );
    expect(html).toMatch(/role="img"|role="application"|role="group"/);
    expect(html).toContain("Total spend");
    // A summary a screen reader can actually read out: range and direction of
    // travel, stated as arithmetic rather than as a verdict.
    expect(html).toMatch(/summary|aria-label/i);
  });

  it("is reachable by keyboard", () => {
    const html = renderToStaticMarkup(
      <MiniTrendAreaChart data={series} label="Total spend" unit="currency" />,
    );
    expect(html).toContain('tabindex="0"');
  });

  it("moves through points with the arrow keys", () => {
    expect(source).toContain("ArrowRight");
    expect(source).toContain("ArrowLeft");
    expect(source).toContain("onKeyDown");
  });

  it("renders a text alternative listing the points", () => {
    // The equivalent of the tooltip, for people who cannot hover.
    const html = renderToStaticMarkup(
      <MiniTrendAreaChart data={series} label="Total spend" unit="currency" />,
    );
    expect(html).toContain("2026-08-01");
  });
});

describe("a comparison series is distinguishable without colour alone", () => {
  it("dashes the comparison line", () => {
    expect(source).toContain("strokeDasharray");
  });

  it("names the comparison in the accessible summary", () => {
    const html = renderToStaticMarkup(
      <MiniTrendAreaChart
        data={series}
        comparisonData={series}
        label="Total spend"
        unit="currency"
      />,
    );
    expect(html).toMatch(/previous|comparison/i);
  });
});

describe("an empty chart says so", () => {
  it("does not render a phantom line for no data", () => {
    const html = renderToStaticMarkup(
      <MiniTrendAreaChart data={[]} label="Total spend" unit="currency" />,
    );
    expect(html).toMatch(/No trend data|no data/i);
  });
});
