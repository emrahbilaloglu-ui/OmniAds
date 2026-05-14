import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetaDrillDrawer } from "@/components/meta/redesign/MetaDrillDrawer";
import { metaAnomaly, metaRec } from "@/components/meta/redesign/test-fixtures";

describe("MetaDrillDrawer", () => {
  it("renders decision drilldown with evidence", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer
        item={{ mode: "decision", rec: metaRec() }}
        window="28d"
        onWindowChange={vi.fn()}
        onClose={vi.fn()}
        onLaunch={vi.fn()}
      />,
    );
    expect(html).toContain("Engine reasoning");
    expect(html).toContain("Launchpad bridge");
  });

  it("hides the Launchpad bridge when no launch handler is available", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer item={{ mode: "decision", rec: metaRec() }} window="28d" onWindowChange={vi.fn()} onClose={vi.fn()} />,
    );
    expect(html).toContain("Engine reasoning");
    expect(html).not.toContain("Launchpad bridge");
  });

  it("renders anomaly diagnostics", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer item={{ mode: "anomaly", anomaly: metaAnomaly() }} window="28d" onWindowChange={vi.fn()} onClose={vi.fn()} />,
    );
    expect(html).toContain("Diagnostic");
    expect(html).toContain("Ad 1: REJECTED");
  });

  it("renders informational upper-funnel KPIs without decision panels", () => {
    const rec = metaRec({
      id: "rec_upper",
      level: "adset",
      adsetName: "ThruPlay Broad",
      cohort: "upper_funnel",
      targetValue: {
        spend: 84,
        impressions: 1000,
        thruplayActions: 42,
        videoViews3s: 100,
        frequency: 1.7,
      },
    });

    const html = renderToStaticMarkup(
      <MetaDrillDrawer item={{ mode: "informational", rec }} window="28d" onWindowChange={vi.fn()} onClose={vi.fn()} />,
    );

    expect(html).toContain("Brand KPIs");
    expect(html).toContain("Cost / ThruPlay");
    expect(html).toContain("ThruPlay rate");
    expect(html).toContain("Hook rate (3s)");
    expect(html).not.toContain("Engine reasoning");
    expect(html).not.toContain("Launchpad bridge");
    expect(html).not.toContain("data-meta-drill-kpis");
  });
});
