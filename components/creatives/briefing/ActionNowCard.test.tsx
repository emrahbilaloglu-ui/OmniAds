import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionNowCard } from "@/components/creatives/briefing/ActionNowCard";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "cr_1",
    name: "Aphrodite Necklace Hook v3",
    brand: "TheSwaf",
    campaign: "ASC | Worldwide | Sales",
    adset: "AdSet | Worldwide | 25-44 | Advantage+",
    label: "scale",
    confidence: 88,
    reason: "ROAS above target with stable frequency.",
    predictive: "If applied: expected 28d ROAS drift 3.10x - 3.25x",
    spend: 4210,
    roas: 3.42,
    ctr: 1.84,
    cpa: 14.2,
    purchases: 297,
    frequency: 1.6,
    fatigue: false,
    sparkline: [2.1, 2.4, 2.9, 3.2, 3.42],
    ctrFunnel: { value: 1.84, p50: 1.1 },
    primary: { kind: "promote", label: "Promote to main" },
    status: "ACTIVE",
    ageDays: 34,
    ...overrides,
  };
}

describe("ActionNowCard", () => {
  it("renders the default high-confidence action card", () => {
    const html = renderToStaticMarkup(<ActionNowCard card={card()} selected />);

    expect(html).toContain("Aphrodite Necklace Hook v3");
    expect(html).toContain("border-2 border-slate-300");
    expect(html).toContain("width:88px;height:88px;font-size:22px");
    expect(html).toContain("Promote to main");
    expect(html).toContain("What does Defer 24h do?");
    expect(html).toContain("More evidence");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("ring-2 ring-blue-500 ring-offset-1");
  });

  it("applies mid and low confidence visual weight", () => {
    const midHtml = renderToStaticMarkup(
      <ActionNowCard card={card({ confidence: 58, primary: { kind: "cut", label: "Cut" } })} />,
    );
    const lowHtml = renderToStaticMarkup(
      <ActionNowCard card={card({ confidence: 42, primary: { kind: "cut", label: "Cut" } })} />,
    );

    expect(midHtml).toContain("width:72px;height:72px;font-size:18px");
    expect(midHtml).toContain("bg-rose-600 text-white border-rose-600");
    expect(lowHtml).toContain("opacity-90");
    expect(lowHtml).toContain("width:64px;height:64px;font-size:15px");
    expect(lowHtml).toContain("border-rose-300 text-rose-700 hover:bg-rose-50");
  });

  it("renders deferred chip and cut animation classes", () => {
    const deferredHtml = renderToStaticMarkup(<ActionNowCard card={card()} deferred />);
    const cuttingHtml = renderToStaticMarkup(<ActionNowCard card={card()} cutting />);

    expect(deferredHtml).toContain("opacity-60");
    expect(deferredHtml).toContain("Reappears tomorrow 9am ·");
    expect(deferredHtml).toContain("data-action=\"undefer\"");
    expect(cuttingHtml).toContain("opacity-0 -translate-x-4 pointer-events-none");
  });
});
