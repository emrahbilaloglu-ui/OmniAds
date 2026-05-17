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
  it("renders the watching tile with name, defer button, and fresh-test primary on test_more", () => {
    const html = renderToStaticMarkup(<WatchingCard card={card()} selected />);

    expect(html).toContain("Catalog DPA Spring 2026");
    expect(html).toContain('aria-label="Open evidence for Catalog DPA Spring 2026"');
    expect(html).toContain("creative-evidence-trigger--watch-thumb");
    expect(html).toContain("creative-evidence-trigger--inline-name");
    expect(html).toContain("opacity-90");
    expect(html).toContain("Defer 24h");
    expect(html).toContain("What does Defer 24h do?");
    expect(html).toContain("Fresh test");
    expect(html).toContain('aria-checked="true"');
  });

  it("falls back to Open evidence for non-test-more labels", () => {
    const html = renderToStaticMarkup(
      <WatchingCard card={card({ label: "refresh" })} />,
    );

    expect(html).not.toContain("Fresh test");
    expect(html).toContain('data-action="evidence"');
  });

  it("renders deferred chip when deferred", () => {
    const html = renderToStaticMarkup(<WatchingCard card={card()} deferred />);

    expect(html).toContain("opacity-60");
    expect(html).toContain("Reappears tomorrow 9am ·");
    expect(html).toContain('data-action="undefer"');
  });

  it("renders unlabeled campaign context without creating a structural action", () => {
    const html = renderToStaticMarkup(
      <WatchingCard
        card={card({
          campaignLabelStatus: "unlabeled",
          blockedActionType: "scale",
          badges: ["unlabeled_campaign_context"],
        })}
      />,
    );

    expect(html).toContain(">Unlabeled<");
    expect(html).toContain("campaign label");
    expect(html).not.toContain('data-kind="scale"');
  });
});
