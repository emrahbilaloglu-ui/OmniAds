import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicCreativeSharePage } from "@/components/creatives/PublicCreativeSharePage";
import { MOCK_SHARE_PAYLOAD } from "@/components/creatives/shareCreativeMock";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";

vi.mock("@/components/creatives/CreativeRenderSurface", () => ({
  CreativeRenderSurface: () =>
    React.createElement("div", { "data-testid": "creative-render-surface-stub" }),
}));

describe("PublicCreativeSharePage", () => {
  it("renders a client-safe read-only panel without leaking operator decision jargon", () => {
    const html = renderToStaticMarkup(
      <PublicCreativeSharePage payload={MOCK_SHARE_PAYLOAD} language="en" />,
    );

    expect(html).toContain("Client view · read-only");
    expect(html).toContain("What we did and why");
    expect(html).toContain("Creative highlights");
    expect(html).toContain("Paused an underperforming ad set");
    expect(html).toContain("7 days later: account return improved to 2.1x");
    expect(html).toContain("missing data renders as");
    expect(html).not.toContain("Creative action plan");
    expect(html).not.toContain("Scale review: UGC Reel");
    expect(html).not.toContain("Amount: No safe amount calculated");
    expect(html).not.toContain("Do not scale from ROAS alone without buyer confirmation.");
    expect(html).not.toContain("Confidence:");
    expect(html).not.toContain("Evidence:");
  });

  it("honors creative-team share controls by suppressing decision observations", () => {
    const payload: SharePayload = {
      ...MOCK_SHARE_PAYLOAD,
      audience: "creative_team" as const,
      presetLabel: "Creative teams",
      includeCampaignNames: false,
      includeDecisionLanguage: false,
      clientActions: undefined,
      metrics: ["spend", "hookScore", "ctaScore", "offerScore", "clickScore", "watchScore"],
      creatives: MOCK_SHARE_PAYLOAD.creatives.slice(0, 1).map((creative) => ({
        ...creative,
        hookScore: 88,
        ctaScore: 72,
        offerScore: 61,
        clickScore: 44,
        watchScore: 93,
        creativeScoreGap: { label: "Offer gap", severity: "watch" as const },
      })),
    };

    const html = renderToStaticMarkup(
      <PublicCreativeSharePage payload={payload} language="en" />,
    );

    expect(html).toContain("Client view · read-only");
    expect(html).toContain("This share does not include a client-safe action history");
    expect(html).toContain("UGC Reel - Morning routine hook");
    expect(html).not.toContain("Paused an underperforming ad set");
    expect(html).not.toContain("Scale review: UGC Reel");
    expect(html).not.toContain("Confidence:");
    expect(html).not.toContain("Do not");
  });

  it("does not fabricate a client action feed from internal analysis labels", () => {
    const payload: SharePayload = {
      ...MOCK_SHARE_PAYLOAD,
      clientActions: undefined,
    };

    const html = renderToStaticMarkup(
      <PublicCreativeSharePage payload={payload} language="en" />,
    );

    expect(html).toContain("This share does not include a client-safe action history");
    expect(html).not.toContain("A high-performing creative was reviewed");
    expect(html).not.toContain("A stable creative was monitored");
    expect(html).not.toContain("Scale review: UGC Reel");
  });

  it("does not fabricate USD or zero KPIs when currency or metric data is missing", () => {
    const payload: SharePayload = {
      ...MOCK_SHARE_PAYLOAD,
      currency: null,
      creatives: [],
    };

    const html = renderToStaticMarkup(
      <PublicCreativeSharePage payload={payload} language="en" />,
    );

    expect(html).toContain("currency missing from snapshot");
    expect(html).toContain("missing data renders as");
    expect(html).not.toContain("$0");
    expect(html).not.toContain("US$");
  });
});
