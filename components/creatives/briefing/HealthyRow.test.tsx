import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthyRow } from "@/components/creatives/briefing/HealthyRow";

describe("HealthyRow", () => {
  it("renders the healthy tile with label, ROAS, spend, and a healthy primary chip", () => {
    const html = renderToStaticMarkup(
      <HealthyRow
        selected
        card={{
          id: "cr_h1",
          name: "Aphrodite Studs Set",
          brand: "TheSwaf",
          label: "keep",
          spend: 1200,
          currency: "USD",
          roas: 2.42,
          purchases: 17,
        }}
      />,
    );

    expect(html).toContain("Aphrodite Studs Set");
    expect(html).toContain('data-tile-variant="healthy"');
    expect(html).toContain("ROAS");
    expect(html).toContain("2.42×");
    expect(html).toContain("$1,200");
    expect(html).toContain("Healthy");
    expect(html).toContain('aria-checked="true"');
  });

  it("renders the card account currency instead of inferring USD", () => {
    const html = renderToStaticMarkup(
      <HealthyRow
        card={{
          id: "cr_h2",
          name: "GBP creative",
          label: "keep",
          spend: 1200,
          currency: "GBP",
        }}
      />,
    );

    expect(html).toContain("£1,200");
    expect(html).not.toContain("$1,200");
  });
});
