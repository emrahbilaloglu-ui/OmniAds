import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompareDrawer, calculateOutliers, type CompareDrawerItem } from "@/components/common/briefing/CompareDrawer";

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: (props: { assetFallbacks?: Array<string | null | undefined> }) => (
    <div data-testid="creative-render-surface">
      {(props.assetFallbacks ?? []).filter(Boolean).join("|")}
    </div>
  ),
}));

const items: CompareDrawerItem[] = [
  { id: "a", name: "Aphrodite Hook", brand: "TheSwaf", label: "scale", spend: 4210, roas: 3.42, ctr: 1.84, cpa: 14.2, purchases: 297, frequency: 1.6, sparkline: [2, 3, 3.42] },
  { id: "b", name: "TowelRack Demo", brand: "IwaStore", label: "cut", spend: 9963, roas: 0.62, ctr: 0.71, cpa: 48.1, purchases: 41, frequency: 4.2, sparkline: [1.4, 1, 0.62] },
];

describe("CompareDrawer", () => {
  it("renders a product-native drawer without the HTML mock browser chrome", () => {
    const html = renderToStaticMarkup(
      <CompareDrawer open items={items} onClose={() => undefined} />,
    );

    expect(html).toContain("compare-drawer-panel");
    expect(html).toContain("2 creatives");
    expect(html).not.toContain("adsecute.app");
    expect(html).not.toContain("compare-target-browser-bar");
    expect(html).not.toContain("/platforms/meta/creatives");
    expect(html).toContain("Spend");
    expect(html).toContain("ROAS");
    expect(html).toContain("Freq");
    expect(html).toContain("Scale");
    expect(html).toContain("Cut");
    expect(html).toContain("aria-label=\"Close compare drawer\"");
  });

  it("uses a custom metric list and bottom action bar slot", () => {
    const html = renderToStaticMarkup(
      <CompareDrawer
        open
        items={items}
        metrics={[{ key: "roas", label: "ROAS", getValue: (item) => item.roas ?? 0, format: (value) => value.toFixed(1) }]}
        actionBar={<button type="button">Custom action</button>}
      />,
    );

    expect(html).toContain("ROAS");
    expect(html).toContain("Custom action");
    expect(html).not.toContain("Spend");
  });

  it("renders real media thumbnails when compare items carry preview sources", () => {
    const html = renderToStaticMarkup(
      <CompareDrawer
        open
        items={[
          {
            ...items[0],
            format: "image",
            creativeVisualFormat: "video",
            creativePrimaryType: "video",
            creativePrimaryLabel: "Video",
            mediaPreviewUrl: "https://example.com/media.jpg",
            tableThumbnailUrl: "https://example.com/table.jpg",
          },
          items[1],
        ]}
      />,
    );

    expect(html).toContain("https://example.com/media.jpg");
    expect(html).toContain("compare-drawer-ratio");
    expect(html).toContain("data-media-shape=\"portrait\"");
    expect(html).toContain(">VID<");
    expect(html).toContain(">9:16<");
  });

  it("limits the visible comparison to four items and surfaces the hidden count", () => {
    const html = renderToStaticMarkup(
      <CompareDrawer open items={[...items, ...items.map((item) => ({ ...item, id: `${item.id}-copy` })), { ...items[0], id: "fifth" }]} />,
    );

    expect(html).toContain("4 creatives");
    expect(html).toContain("showing first 4 of 5");
    expect(html).toContain("1 more not shown");
  });

  it("hides when closed and exposes outlier calculation", () => {
    expect(renderToStaticMarkup(<CompareDrawer open={false} items={items} />)).toBe("");
    expect(
      calculateOutliers(items, [{ key: "spend", label: "Spend", getValue: (item) => item.spend ?? 0, format: String }]).spend,
    ).toEqual([true, false]);
  });
});
