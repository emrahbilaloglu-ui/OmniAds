import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompareDrawer, calculateOutliers, type CompareDrawerItem } from "@/components/common/briefing/CompareDrawer";

const items: CompareDrawerItem[] = [
  { id: "a", name: "Aphrodite Hook", brand: "TheSwaf", label: "scale", spend: 4210, roas: 3.42, ctr: 1.84, cpa: 14.2, purchases: 297, frequency: 1.6, sparkline: [2, 3, 3.42] },
  { id: "b", name: "TowelRack Demo", brand: "IwaStore", label: "cut", spend: 9963, roas: 0.62, ctr: 0.71, cpa: 48.1, purchases: 41, frequency: 4.2, sparkline: [1.4, 1, 0.62] },
];

describe("CompareDrawer", () => {
  it("renders the drawer, metrics, default action bar, and close label", () => {
    const html = renderToStaticMarkup(
      <CompareDrawer open items={items} onClose={() => undefined} />,
    );

    expect(html).toContain("Compare 2 creatives");
    expect(html).toContain("Spend (28d)");
    expect(html).toContain("Cut weakest");
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
    expect(html).not.toContain("Cut weakest");
  });

  it("hides when closed and exposes outlier calculation", () => {
    expect(renderToStaticMarkup(<CompareDrawer open={false} items={items} />)).toBe("");
    expect(
      calculateOutliers(items, [{ key: "spend", label: "Spend", getValue: (item) => item.spend ?? 0, format: String }]).spend,
    ).toEqual([true, false]);
  });
});
