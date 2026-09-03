import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightsPanel } from "@/components/common/briefing/InsightsPanel";
import {
  buildAnomaliesWidget,
  buildEngineStatusWidget,
  buildCampaignRoleCoverageWidget,
  buildTargetAnchorWidget,
} from "@/components/common/briefing/InsightsWidgets";

describe("InsightsPanel", () => {
  it("renders nothing when widget list is empty", () => {
    expect(renderToStaticMarkup(<InsightsPanel widgets={[]} />)).toBe("");
  });

  it("renders only the handle when closed", () => {
    const html = renderToStaticMarkup(
      <InsightsPanel
        widgets={[
          {
            key: "demo",
            title: "Demo widget",
            trailingLabel: "ok",
            content: <span>demo body</span>,
          },
        ]}
      />,
    );

    expect(html).toContain('data-testid="insights-panel-handle"');
    expect(html).toContain("Insights");
    expect(html).not.toContain('data-testid="insights-panel"');
    expect(html).not.toContain("demo body");
  });

  it("renders the overlay with widget content when controlled open", () => {
    const html = renderToStaticMarkup(
      <InsightsPanel
        open={true}
        widgets={[
          {
            key: "demo",
            title: "Demo widget",
            trailingLabel: "ok",
            content: <span>demo body</span>,
          },
        ]}
      />,
    );

    expect(html).toContain('role="region"');
    expect(html).toContain("Demo widget");
    expect(html).toContain("demo body");
    expect(html).toContain('aria-label="Close insights"');
  });

  it("shows an attention badge equal to the count of widgets flagged needsAttention", () => {
    const html = renderToStaticMarkup(
      <InsightsPanel
        widgets={[
          { key: "a", title: "A", content: <span /> },
          { key: "b", title: "B", needsAttention: true, content: <span /> },
          { key: "c", title: "C", needsAttention: true, content: <span /> },
        ]}
      />,
    );

    expect(html).toContain(">2<");
    expect(html).toContain("— 2 needs attention");
  });

  it("respects a custom handle label", () => {
    const html = renderToStaticMarkup(
      <InsightsPanel
        handleLabel="Notes"
        panelLabel="Page notes"
        widgets={[{ key: "x", title: "X", content: <span /> }]}
      />,
    );

    expect(html).toContain("Notes");
  });
});

describe("Insights widget builders", () => {
  it("buildCampaignRoleCoverageWidget returns null when no active campaigns", () => {
    expect(
      buildCampaignRoleCoverageWidget({
        activeCampaigns: 0,
        classifiedCampaigns: 0,
        unresolvedCampaigns: 0,
      }),
    ).toBeNull();
  });

  it("buildCampaignRoleCoverageWidget flags attention when roles are unresolved", () => {
    const widget = buildCampaignRoleCoverageWidget({
      activeCampaigns: 24,
      classifiedCampaigns: 21,
      unresolvedCampaigns: 3,
    });

    expect(widget).not.toBeNull();
    expect(widget!.needsAttention).toBe(true);
    expect(widget!.trailingLabel).toBe("88%");
    const body = renderToStaticMarkup(<>{widget!.content}</>);
    expect(body).toContain("Refresh 3 unresolved");
    expect(body).toContain("21/24 active campaigns classified automatically");
  });

  it("buildCampaignRoleCoverageWidget does not flag attention when fully covered", () => {
    const widget = buildCampaignRoleCoverageWidget({
      activeCampaigns: 10,
      classifiedCampaigns: 10,
      unresolvedCampaigns: 0,
    });

    expect(widget).not.toBeNull();
    expect(widget!.needsAttention).toBe(false);
    expect(widget!.trailingLabel).toBe("100%");
  });

  it("buildTargetAnchorWidget flags missing as needsAttention", () => {
    const widget = buildTargetAnchorWidget({
      configured: false,
      targetRoas: null,
      breakEvenRoas: null,
    });

    expect(widget).not.toBeNull();
    expect(widget!.needsAttention).toBe(true);
    expect(widget!.trailingLabel).toBe("missing");
    const body = renderToStaticMarkup(<>{widget!.content}</>);
    expect(body).toContain("Set anchor");
  });

  it("buildTargetAnchorWidget renders breakeven and target when configured", () => {
    const widget = buildTargetAnchorWidget({
      configured: true,
      targetRoas: 2.1,
      breakEvenRoas: 1.45,
      median: 1.92,
    });

    expect(widget!.needsAttention).toBe(false);
    expect(widget!.trailingLabel).toBe("set");
    const body = renderToStaticMarkup(<>{widget!.content}</>);
    expect(body).toContain("2.10");
    expect(body).toContain("1.45");
    expect(body).toContain("1.92");
  });

  it("buildEngineStatusWidget flags non-fresh snapshot as needsAttention", () => {
    const widget = buildEngineStatusWidget({
      version: "v4.2",
      lastRunAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      snapshotStatus: "stale",
    });

    expect(widget!.needsAttention).toBe(true);
    expect(widget!.trailingLabel).toBe("v4.2");
    const body = renderToStaticMarkup(<>{widget!.content}</>);
    expect(body).toContain("1h ago");
    expect(body).toContain("snapshot · stale");
  });

  it("buildAnomaliesWidget flags activeCount > 0", () => {
    const widget = buildAnomaliesWidget({ activeCount: 2 });
    expect(widget!.needsAttention).toBe(true);
    expect(widget!.trailingLabel).toBe("2 active");
  });

  it("buildAnomaliesWidget renders 0 active calmly", () => {
    const widget = buildAnomaliesWidget({ activeCount: 0 });
    expect(widget!.needsAttention).toBe(false);
    expect(widget!.trailingLabel).toBe("0 active");
    const body = renderToStaticMarkup(<>{widget!.content}</>);
    expect(body).toContain("No active");
  });
});
