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
    expect(html).toContain("ccard-tile");
    expect(html).toContain("tile-thumb");
    expect(html).toContain('aria-label="Open evidence for Aphrodite Necklace Hook v3"');
    expect(html).toContain("creative-evidence-trigger--media");
    expect(html).toContain("creative-evidence-trigger--name");
    expect(html).toContain("data-media-shape=\"feed\"");
    expect(html).toContain(">4:5<");
    expect(html).toContain("tile-metrics");
    expect(html).toContain("Promote to main");
    expect(html).toContain("What does Defer 24h do?");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain("ring-2 ring-blue-500 ring-offset-1");
  });

  it("renders cut actions as destructive primary controls", () => {
    const cutHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          label: "cut",
          primary: { kind: "cut", label: "Cut" },
        })}
      />,
    );

    expect(cutHtml).toContain("btn--danger");
    expect(cutHtml).toContain('data-kind="cut"');
    expect(cutHtml).toContain("Cut");
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
    expect(html).toContain("tile-chips");
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

  it("keeps video and carousel cards in their native media frames", () => {
    const videoHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          name: "Founder Story",
          format: "image",
          creativeVisualFormat: "video",
          creativePrimaryType: "video",
          creativePrimaryLabel: "Video",
          preview: {
            render_mode: "image",
            image_url: "https://example.com/poster.jpg",
            video_url: null,
            poster_url: "https://example.com/poster.jpg",
            source: "thumbnail_url",
            is_catalog: false,
          },
        })}
      />,
    );
    const carouselHtml = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          name: "Product Set",
          creativeVisualFormat: "carousel",
          creativePrimaryType: "carousel",
          creativePrimaryLabel: "Carousel",
        })}
      />,
    );

    expect(videoHtml).toContain("data-media-shape=\"portrait\"");
    expect(videoHtml).toContain(">VID<");
    expect(videoHtml).toContain(">9:16<");
    expect(carouselHtml).toContain("data-media-shape=\"square\"");
    expect(carouselHtml).toContain(">CAR<");
    expect(carouselHtml).toContain(">1:1<");
  });
});

describe("execution action CTA", () => {
  const dcRow = (executionAction: string | null) =>
    ({
      scope: "creative",
      creativeId: "cr_1",
      identityGrain: "creative",
      buyerAction: "scale",
      buyerLabel: "Scale",
      uiBucket: "scale",
      executionAction,
      confidenceBand: "high",
      priority: "high",
      oneLine: "",
      reasons: [],
      nextStep: "",
      missingData: [],
    }) as never;

  it("renders the server-supplied execution action as the footer CTA", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          primary: { kind: "scale", label: "Legacy scale label" },
          decisionCenterRow: dcRow("scale_budget"),
        })}
      />,
    );
    expect(html).toContain("Review scale budget");
    expect(html).not.toContain("Legacy scale label");
  });

  it("never lets the execution CTA override a cut decision", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard
        card={card({
          label: "cut",
          primary: { kind: "cut", label: "Cut" },
          decisionCenterRow: dcRow("promote_to_main"),
        })}
      />,
    );
    expect(html).not.toContain("Promote to main");
    expect(html).toContain("Cut");
  });

  it("falls back to the legacy primary label without a decision-center row", () => {
    const html = renderToStaticMarkup(
      <ActionNowCard card={card({ decisionCenterRow: null })} />,
    );
    expect(html).toContain("Promote to main");
  });
});
