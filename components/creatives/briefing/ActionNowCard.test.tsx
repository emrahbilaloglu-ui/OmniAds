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
  it("renders the tile shell with name, primary action, metrics, confidence pill, and select control", () => {
    const html = renderToStaticMarkup(<ActionNowCard card={card()} selected />);

    expect(html).toContain("Aphrodite Necklace Hook v3");
    expect(html).toContain("Promote to main");
    expect(html).toContain('data-tile-variant="action"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-action="defer"');
    expect(html).toContain('data-action="evidence"');
    expect(html).toContain("ROAS");
    expect(html).toContain("3.42×");
    expect(html).toContain(">88%<");
  });

  it("uses a portrait thumb shape when the best placement is Reels", () => {
    const portrait = renderToStaticMarkup(
      <ActionNowCard card={card({ bestPlacement: "instagram_reels" })} />,
    );
    const square = renderToStaticMarkup(
      <ActionNowCard card={card({ bestPlacement: "facebook_feed" })} />,
    );

    expect(portrait).toContain("width:90px");
    expect(portrait).toContain("9:16");
    expect(square).toContain("width:140px");
    expect(square).toContain("1:1");
  });

  it("renders deferred chip and cut-removing classes", () => {
    const deferredHtml = renderToStaticMarkup(<ActionNowCard card={card()} deferred />);
    const cuttingHtml = renderToStaticMarkup(<ActionNowCard card={card()} cutting />);

    expect(deferredHtml).toContain("opacity-60");
    expect(deferredHtml).toContain("Reappears tomorrow 9am ·");
    expect(deferredHtml).toContain('data-action="undefer"');
    expect(cuttingHtml).toContain("opacity-0 -translate-x-4 pointer-events-none");
  });

  it("renders campaign kind context when provided by the server", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard card={card({ campaignKind: "main", campaignLabelStatus: "labeled" })} />,
    );

    expect(html).toContain(">Main<");
  });

  it("renders non-promote scale actions from the server without relabeling them", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          campaignKind: "main",
          campaignLabelStatus: "labeled",
          primary: { kind: "scale_budget", label: "Scale budget" },
        })}
      />,
    );

    expect(html).toContain("Scale budget");
    expect(html).toContain('data-kind="scale_budget"');
    expect(html).not.toContain("Promote to main");
  });

  it("colors the ROAS metric warn when the decision is cut", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard card={card({ label: "cut", primary: { kind: "cut", label: "Cut" } })} />,
    );

    expect(html).toContain("text-rose-700");
  });
});
