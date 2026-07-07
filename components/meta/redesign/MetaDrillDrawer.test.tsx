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

describe("MetaDrillDrawer push inspector", () => {
  it("renders in-flow (no fixed overlay backdrop) in push variant", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer
        variant="push"
        item={{ mode: "decision", rec: metaRec() }}
        window="28d"
        onWindowChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain('data-inspector-variant="push"');
    expect(html).not.toContain("fixed inset-0");
    expect(html).toContain("Engine reasoning");
  });

  it("renders decision sections in spec order", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer item={{ mode: "decision", rec: metaRec() }} window="28d" onWindowChange={vi.fn()} onClose={vi.fn()} />,
    );
    const contract = html.indexOf("Decision contract");
    const why = html.indexOf("Engine reasoning");
    const money = html.indexOf("data-meta-drill-kpis");
    const provenance = html.indexOf("Provenance");
    expect(contract).toBeGreaterThan(-1);
    expect(contract).toBeLessThan(why);
    expect(why).toBeLessThan(money);
    expect(money).toBeLessThan(provenance);
  });

  it("draws a gradient ROAS trend spark when a real series exists", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer
        targetRoas={2}
        item={{
          mode: "decision",
          rec: metaRec({
            metrics: { spend: 400, roas: 0.6 },
            evidenceTrail: {
              roas_history: [1.6, 1.2, 0.9, 0.7, 0.6],
              peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 0.6 },
              regime_stability: 0.8,
              age_days: 20,
              recent_changes: [],
            },
          }),
        }}
        window="28d"
        onWindowChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(html).toContain("<polyline");
    expect(html).toContain("linearGradient");
    expect(html).toContain("ROAS trend");
  });
});

describe("drill KPIs prefer structured metrics", () => {
  it("renders server metrics with account currency, not evidence strings", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer
        moneyCurrency="TRY"
        item={{
          mode: "decision",
          rec: metaRec({
            metrics: { spend: 900, roas: 2.75, cpa: 30 },
            evidence: [
              { label: "Spend", value: "$123,456 STALE", tone: "neutral" },
              { label: "Core ROAS", value: "0.10x STALE", tone: "warning" },
            ],
          }),
        }}
        window="28d"
        onWindowChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    // Scope to the KPI header: evidence sections legitimately display raw
    // evidence strings as content; the KPI numbers must not derive from them.
    const kpiStart = html.indexOf("data-meta-drill-kpis");
    const kpiSection = html.slice(kpiStart, html.indexOf("</section>", kpiStart));
    expect(kpiSection).toContain("2.75x");
    expect(kpiSection).toContain("TRY");
    expect(kpiSection).not.toContain("STALE");
  });

  it("falls back to evidence strings only when metrics are absent (explicit contract)", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer
        item={{
          mode: "decision",
          rec: metaRec({
            metrics: null,
            evidence: [{ label: "Core ROAS", value: "1.90x", tone: "neutral" }],
          }),
        }}
        window="28d"
        onWindowChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain("1.90x");
  });
});
