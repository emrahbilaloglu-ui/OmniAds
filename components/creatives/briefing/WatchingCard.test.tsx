import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WatchingCard } from "@/components/creatives/briefing/WatchingCard";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "cr_w1",
    name: "Catalog DPA Spring 2026",
    brand: "TheSwaf",
    campaign: "DPA | Catalog Sales | Worldwide",
    adset: "AdSet | Broad | 18-65",
    label: "test_more",
    confidence: 42,
    reason: "Thin sample, signal still building.",
    spend: 182,
    roas: 1.84,
    ctr: 1.21,
    frequency: 1.1,
    sparkline: [0, 1.2, 1.84],
    ...overrides,
  };
}

describe("WatchingCard", () => {
  it("renders the low-confidence watching card with read-only actions", () => {
    const html = renderToStaticMarkup(<WatchingCard card={card()} selected />);

    expect(html).toContain("Catalog DPA Spring 2026");
    expect(html).toContain("opacity-90");
    expect(html).toContain("Let cook");
    expect(html).toContain("What does Defer 24h do?");
    expect(html).toContain("Evidence");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("Fresh test");
    expect(html).toContain("checked=\"\"");
  });

  it("hides fresh-test action for non-test-more labels and keeps mid confidence weight", () => {
    const html = renderToStaticMarkup(
      <WatchingCard card={card({ label: "refresh", confidence: 56 })} />,
    );

    expect(html).toContain("width:72px;height:72px;font-size:18px");
    expect(html).not.toContain("Fresh test");
  });

  it("renders deferred chip and opacity for Let cook state", () => {
    const html = renderToStaticMarkup(<WatchingCard card={card()} deferred />);

    expect(html).toContain("opacity-60");
    expect(html).toContain("Reappears tomorrow 9am ·");
    expect(html).toContain("data-action=\"undefer\"");
  });
});
