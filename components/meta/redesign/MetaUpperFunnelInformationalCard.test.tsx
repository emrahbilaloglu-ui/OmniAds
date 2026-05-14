import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MetaUpperFunnelInformationalCard } from "@/components/meta/redesign/MetaUpperFunnelInformationalCard";
import { metaRec } from "@/components/meta/redesign/test-fixtures";

function upperRec(overrides = {}) {
  return metaRec({
    id: "rec_upper",
    level: "adset",
    campaignId: "cmp_upper",
    campaignName: "Video Views",
    adsetId: "adset_upper",
    adsetName: "ThruPlay Broad",
    cohort: "upper_funnel",
    targetValue: {
      spend: 84,
      impressions: 1000,
      thruplayActions: 42,
      videoViews3s: 100,
      frequency: 1.7,
      ...overrides,
    },
  });
}

describe("MetaUpperFunnelInformationalCard", () => {
  it("renders the upper-funnel card with all brand KPI tiles populated", () => {
    const html = renderToStaticMarkup(
      <MetaUpperFunnelInformationalCard rec={upperRec()} onOpenDrill={vi.fn()} />,
    );

    expect(html).toContain('data-card="meta-upper-funnel-informational"');
    expect(html).toContain("ThruPlay Broad");
    expect(html).toContain("Cost / ThruPlay");
    expect(html).toContain("$2.00");
    expect(html).toContain("ThruPlay rate");
    expect(html).toContain("4.2%");
    expect(html).toContain("Hook rate (3s)");
    expect(html).toContain("10.0%");
    expect(html).toContain("Frequency");
    expect(html).toContain("1.7");
  });

  it("returns null for purchase recs", () => {
    const html = renderToStaticMarkup(
      <MetaUpperFunnelInformationalCard rec={metaRec({ cohort: "purchase" })} />,
    );

    expect(html).toBe("");
  });

  it("returns null for mid-funnel recs", () => {
    const html = renderToStaticMarkup(
      <MetaUpperFunnelInformationalCard rec={metaRec({ cohort: "mid_funnel" })} />,
    );

    expect(html).toBe("");
  });

  it("renders a dash for Cost / ThruPlay when thruplay actions are zero", () => {
    const html = renderToStaticMarkup(
      <MetaUpperFunnelInformationalCard rec={upperRec({ thruplayActions: 0 })} />,
    );

    expect(html).toContain("Cost / ThruPlay");
    expect(html).toContain(">—</div>");
  });

  it("renders cohort p50 when available and omits it when absent", () => {
    const withP50 = renderToStaticMarkup(
      <MetaUpperFunnelInformationalCard rec={upperRec({ costPerThruplayP50: 1.5 })} />,
    );
    const withoutP50 = renderToStaticMarkup(<MetaUpperFunnelInformationalCard rec={upperRec()} />);

    expect(withP50).toContain("vs cohort p50 $1.50");
    expect(withoutP50).not.toContain("vs cohort p50");
  });

  it("does not render decision drilldown copy or action controls", () => {
    const html = renderToStaticMarkup(<MetaUpperFunnelInformationalCard rec={upperRec()} />);

    expect(html).not.toContain("Open drilldown");
    expect(html).not.toContain("Drilldown");
    expect(html).not.toContain("Evidence");
    expect(html).not.toContain("Let cook");
  });

  it("renders the Informational badge", () => {
    const html = renderToStaticMarkup(<MetaUpperFunnelInformationalCard rec={upperRec()} />);

    expect(html).toContain("Informational");
  });
});
