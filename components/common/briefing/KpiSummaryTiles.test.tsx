import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KpiSummaryTiles } from "@/components/common/briefing/KpiSummaryTiles";

describe("KpiSummaryTiles", () => {
  it("renders one tile per entry with value, unit, scope and micro line", () => {
    const html = renderToStaticMarkup(
      <KpiSummaryTiles
        tiles={[
          {
            key: "spend",
            title: "Total spend",
            scope: "· 38 creatives",
            value: "$12,400",
            micro: <span>Window · 14d</span>,
          },
          {
            key: "roas",
            title: "Median ROAS",
            value: "2.10",
            unit: "×",
            highlight: "good",
          },
        ]}
      />,
    );

    expect(html).toContain("Total spend");
    expect(html).toContain("$12,400");
    expect(html).toContain("· 38 creatives");
    expect(html).toContain("Window · 14d");
    expect(html).toContain("Median ROAS");
    expect(html).toContain("2.10");
    expect(html).toContain(">×<");
    expect(html).toContain("--adc-pos-bd");
  });

  it("renders nothing when tile list is empty", () => {
    expect(renderToStaticMarkup(<KpiSummaryTiles tiles={[]} />)).toBe("");
  });

  it("applies a warn highlight when requested", () => {
    const html = renderToStaticMarkup(
      <KpiSummaryTiles
        tiles={[{ key: "x", title: "X", value: "1.0", highlight: "warn" }]}
      />,
    );

    expect(html).toContain("--adc-caution-bd");
  });
});
