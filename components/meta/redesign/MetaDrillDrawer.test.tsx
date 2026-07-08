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
    expect(html).toContain("WHY");
    expect(html).toContain("Launchpad bridge");
  });

  it("hides the Launchpad bridge when no launch handler is available", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer item={{ mode: "decision", rec: metaRec() }} window="28d" onWindowChange={vi.fn()} onClose={vi.fn()} />,
    );
    expect(html).toContain("WHY");
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
    expect(html).not.toContain("WHY");
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
    expect(html).toContain("WHY");
  });

  it("renders the reference inspector sections in spec order", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer item={{ mode: "decision", rec: metaRec() }} window="28d" onWindowChange={vi.fn()} onClose={vi.fn()} />,
    );
    const sections = [
      "decision-contract",
      "why",
      "money-impact",
      "precedent",
      "confidence",
      "automation-readiness",
      "blockers",
      "maturity",
      "adset-depth",
      "creative-evidence",
      "timeline",
      "notes-protection",
      "provenance",
      "raw-json",
    ];
    const positions = sections.map((section) => html.indexOf(`data-inspector-section="${section}"`));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(html).toContain("1 ·");
    expect(html).toContain("14 ·");
  });

  it("does not fabricate a numeric confidence percent when only the band is served", () => {
    const rec = { ...metaRec({ confidence: "high" }), confidenceScore: undefined };
    const html = renderToStaticMarkup(
      <MetaDrillDrawer item={{ mode: "decision", rec }} window="28d" onWindowChange={vi.fn()} onClose={vi.fn()} />,
    );
    const confidenceStart = html.indexOf('data-inspector-section="confidence"');
    const confidenceHtml = html.slice(confidenceStart, html.indexOf('data-inspector-section="automation-readiness"'));
    expect(confidenceHtml).toContain("High band");
    expect(confidenceHtml).toContain("Numeric confidence score not served.");
    expect(confidenceHtml).not.toContain("80%");
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

describe("MetaDrillDrawer precedent + timeline", () => {
  function precedentHtml(rec: ReturnType<typeof metaRec>) {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer item={{ mode: "decision", rec }} window="28d" onWindowChange={vi.fn()} onClose={vi.fn()} />,
    );
    const start = html.indexOf('data-inspector-section="precedent"');
    return html.slice(start, html.indexOf('data-inspector-section="confidence"'));
  }

  it("renders readable precedent labels from a persisted empirical summary", () => {
    const rec = metaRec({
      empiricalOutcomeSummary: {
        contractVersion: "meta-empirical-outcome-summary.v1",
        sampleSize: 20,
        judgedSampleSize: 12,
        positiveCount: 8,
        negativeCount: 3,
        neutralCount: 1,
        unknownCount: 8,
        precision: 0.72,
        negativeRate: 0.18,
        confidenceBand: "medium",
        minSampleSize: 10,
        autoEligible: true,
      },
    });
    const section = precedentHtml(rec);
    expect(section).toContain("precision");
    expect(section).toContain("72%");
    expect(section).toContain("negative rate");
    expect(section).toContain("18%");
    expect(section).toContain("12 judged / 20 total");
    expect(section).toContain("confidence band");
    expect(section).toContain("medium");
    expect(section).toContain("8 positive");
    expect(section).toContain("auto eligible");
    expect(section).toContain("yes");
    // Never dumps raw JSON of the summary.
    expect(section).not.toContain("contractVersion");
  });

  it("collapses null precision/negativeRate to em dash without fabricating", () => {
    const rec = metaRec({
      empiricalOutcomeSummary: {
        contractVersion: "meta-empirical-outcome-summary.v1",
        sampleSize: 3,
        judgedSampleSize: 0,
        positiveCount: 0,
        negativeCount: 0,
        neutralCount: 0,
        unknownCount: 3,
        precision: null,
        negativeRate: null,
        confidenceBand: "insufficient_sample",
        minSampleSize: 10,
        autoEligible: false,
      },
    });
    const section = precedentHtml(rec);
    expect(section).toContain("insufficient_sample");
    expect(section).toContain("—");
    expect(section).toContain("no");
  });

  it("keeps the precedent MissingState when no empirical summary is served", () => {
    const rec = metaRec();
    expect(rec.empiricalOutcomeSummary).toBeUndefined();
    const section = precedentHtml(rec);
    expect(section).toContain("No judged precedent window is persisted for this recommendation.");
  });

  it("renders a peer distribution row from evidenceTrail percentiles", () => {
    const section = precedentHtml(metaRec());
    // Default fixture peer_comparison: p10 1, p50 2, p90 4, this_value 3.2
    expect(section).toContain("peer distribution");
    expect(section).toContain("3.20x vs p10 1.00 / p50 2.00 / p90 4.00");
  });

  it("formats known recent-change payload keys instead of dumping JSON", () => {
    const html = renderToStaticMarkup(
      <MetaDrillDrawer
        item={{
          mode: "decision",
          rec: metaRec({
            evidenceTrail: {
              roas_history: [2.2, 2.8, 3.2],
              peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
              regime_stability: 0.8,
              age_days: 42,
              recent_changes: [
                { type: "bid_change", applied_at: "2026-07-01T10:00:00Z", value: { bid_amount: 1500 } },
                { type: "status_change", applied_at: "2026-07-02T10:00:00Z", value: { status: "PAUSED" } },
              ],
            },
          }),
        }}
        window="28d"
        onWindowChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const start = html.indexOf('data-inspector-section="timeline"');
    const section = html.slice(start, html.indexOf('data-inspector-section="notes-protection"'));
    expect(section).toContain("bid amount 1,500");
    expect(section).toContain("status PAUSED");
    expect(section).not.toContain('{"bid_amount"');
    expect(section).not.toContain('{"status"');
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
