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
  it("renders selected creative analyses in the exported share link", () => {
    const html = renderToStaticMarkup(
      <PublicCreativeSharePage payload={MOCK_SHARE_PAYLOAD} />,
    );

    expect(html).toContain("Creative action plan");
    expect(html).toContain("Scale review: UGC Reel - Morning routine hook");
    expect(html).toContain("Amount: No safe amount calculated");
    expect(html).toContain("Send this to the media buyer for a controlled scale review.");
    expect(html).toContain("Do not scale from ROAS alone without buyer confirmation.");
    expect(html).toContain("Leave the creative active and monitor weekly movement.");
  });

  it("honors creative-team share controls without leaking decision language or unrelated columns", () => {
    const payload: SharePayload = {
      ...MOCK_SHARE_PAYLOAD,
      audience: "creative_team" as const,
      presetLabel: "Creative teams",
      includeCampaignNames: false,
      includeDecisionLanguage: false,
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
      <PublicCreativeSharePage payload={payload} />,
    );

    expect(html).toContain("Preset: Creative teams");
    expect(html).toContain("Offer gap");
    expect(html).toContain(">Hook<");
    expect(html).toContain(">CTA<");
    expect(html).toContain(">Offer<");
    expect(html).toContain(">Click<");
    expect(html).toContain(">Watch<");
    expect(html).toContain("88/100");
    expect(html).toContain(">44<");
    expect(html).toContain(">93<");
    expect(html).not.toContain("Creative action plan");
    expect(html).not.toContain("Scale review: UGC Reel");
    expect(html).not.toContain("Purchase value</th>");
    expect(html).not.toContain("Cost per purchase");
  });
});
