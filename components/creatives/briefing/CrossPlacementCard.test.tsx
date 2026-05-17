import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CrossPlacementCard,
  isCrossPlacementRollup,
} from "@/components/creatives/briefing/CrossPlacementCard";
import type { BriefingRollupItem } from "@/components/creatives/briefing/types";

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: (props: { assetFallbacks?: Array<string | null | undefined> }) => (
    <div data-testid="creative-render-surface">
      {(props.assetFallbacks ?? []).filter(Boolean).join("|")}
    </div>
  ),
}));

function rollup(overrides: Partial<BriefingRollupItem> = {}): BriefingRollupItem {
  return {
    id: "rollup_1",
    mixed: true,
    primaryRec: {
      id: "cr_rollup",
      name: "WallArtCatalog",
      brand: "IwaStore",
      label: "scale",
      confidence: 82,
      reason: "Strong family-level ROAS across placements.",
      predictive: "If applied: expected family ROAS 3.10x",
      spend: 7402,
      roas: 2.78,
      ctr: 1.45,
      purchases: 402,
      frequency: 2.1,
      fatigue: false,
      sparkline: [2.4, 2.5, 2.7, 2.78],
      ctrFunnel: { value: 1.45, p50: 1.1 },
      primary: { kind: "promote", label: "Promote best placement" },
      bestPlacement: "Lookalike-1%",
      mediaPreviewUrl: "https://example.com/card.jpg",
      thumbnailUrl: "https://example.com/thumb.jpg",
    },
    placementList: [
      {
        id: "p1",
        campaign: "DPA | Catalog Sales | EU",
        adset: "Lookalike-1%",
        spend: 2940,
        roas: 3.91,
        status: "ACTIVE",
        label: "scale",
        confidence: 86,
      },
      {
        id: "p2",
        campaign: "ABO | Worldwide",
        adset: "Interest stack | Home decor",
        spend: 552,
        roas: 0.74,
        status: "PAUSED",
        label: "cut",
        confidence: 81,
      },
    ],
    ...overrides,
  };
}

describe("CrossPlacementCard", () => {
  it("detects rollup payloads", () => {
    expect(isCrossPlacementRollup(rollup())).toBe(true);
    expect(isCrossPlacementRollup({ id: "cr_1", name: "Single" })).toBe(false);
  });

  it("renders stacked depth, placement strip, mixed badge, and review action", () => {
    const html = renderToStaticMarkup(<CrossPlacementCard rollup={rollup()} />);

    expect(html).toContain("data-rollup=\"cross-placement\"");
    expect(html).toContain("absolute -bottom-1 left-3 right-3");
    expect(html).toContain('aria-label="Open evidence for WallArtCatalog"');
    expect(html).toContain("creative-evidence-trigger--thumb");
    expect(html).toContain("creative-evidence-trigger--inline-name");
    expect(html).toContain("2 placements");
    expect(html).toContain("mixed");
    expect(html).toContain("Review placements");
    expect(html).toContain("https://example.com/thumb.jpg");
    expect(html).toContain("Placements (2)");
    expect(html).toContain("Lookalike-1%");
    expect(html).toContain("Interest stack | Home decor");
    expect(html).toContain("86%");
    expect(html).toContain("81%");
    expect(html).toContain("scale");
    expect(html).toContain("cut");
  });

  it("does not force the mixed badge when placement labels match", () => {
    const html = renderToStaticMarkup(
      <CrossPlacementCard
        rollup={rollup({
          mixed: false,
          placementList: [
            { id: "p1", adset: "A", campaign: "C", label: "scale", status: "ACTIVE" },
            { id: "p2", adset: "B", campaign: "C", label: "scale", status: "ACTIVE" },
          ],
        })}
      />,
    );

    expect(html).not.toContain("mixed");
    expect(html).toContain("Promote best placement");
  });

  it("keeps review placements visually stubbed while rendering deferred state", () => {
    const html = renderToStaticMarkup(<CrossPlacementCard rollup={rollup()} deferred />);

    expect(html).toContain("Review placements");
    expect(html).toContain("opacity-60");
    expect(html).toContain("Reappears tomorrow 9am ·");
  });
});
