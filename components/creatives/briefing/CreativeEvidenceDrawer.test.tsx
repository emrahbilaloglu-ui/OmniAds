import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreativeEvidenceDrawer } from "@/components/creatives/briefing/CreativeEvidenceDrawer";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "ad_4421",
    adId: "ad_4421",
    realAdId: "90021",
    creativeId: "creative_4421",
    name: "UGC Sarah V2",
    brand: "brand.co",
    campaignName: "Spring Test",
    adsetName: "Reels Prospecting",
    label: "scale",
    campaignKind: "test",
    campaignLabelStatus: "labeled",
    confidence: 91,
    reason: "ROAS sustained above account target in test campaign.",
    spend: 1240,
    roas: 2.74,
    cpa: 31,
    purchases: 11,
    ctr: 1.84,
    addToCart: 42,
    frequency: 2.1,
    fatigue: false,
    bestPlacement: "Reels",
    sourceDataSource: "briefing",
    primary: { kind: "promote", label: "Promote to main" },
    mediaPreviewUrl: "https://example.com/creative.jpg",
    creativeVisualFormat: "video",
    creativePrimaryType: "video",
    creativePrimaryLabel: "Video",
    preview: {
      render_mode: "image",
      image_url: "https://example.com/creative.jpg",
      video_url: null,
      poster_url: "https://example.com/poster.jpg",
      source: "fixture",
      is_catalog: false,
    },
    ...overrides,
  };
}

const noopProps = {
  onClose: () => undefined,
  onCut: () => undefined,
  onDefer: () => undefined,
  onUndefer: () => undefined,
  onLaunchpad: () => undefined,
};

function renderDrawer(
  element: React.ReactElement,
  queryData?: Record<string, unknown>,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (queryData) {
    client.setQueryData(
      [
        "creative-evidence-ad-preview",
        "biz_1",
        "creative_4421",
        "90021",
        "feed",
      ],
      queryData,
    );
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
}

describe("CreativeEvidenceDrawer", () => {
  it("renders the product drawer pattern with a chrome-free placement preview and evidence actions", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer open card={card()} {...noopProps} />,
    );

    expect(html).toContain("creative-evidence-drawer-shell");
    expect(html).toContain("creative-evidence-stage");
    expect(html).toContain("creative-evidence-preview-slot");
    expect(html).not.toContain("creative-evidence-phone");
    expect(html).not.toContain("creative-evidence-notch");
    expect(html).toContain("creative-evidence-drawer");
    expect(html).toContain("Promote to main");
    expect(html).toContain("Evidence");
    expect(html).toContain("Automation readiness");
    expect(html).toContain("Operator history");
    expect(html).toContain("Add to existing");
    expect(html).toContain("Fresh test");
    expect(html).toContain("data-media-shape=\"portrait\"");
    expect(html).toContain("Meta ad preview unavailable");
    expect(html).not.toContain("creative-evidence-phone-surface");
    expect(html).not.toContain("creative-evidence-preview-overlay");
    expect(html).not.toContain("adsecute.app");
    expect(html).not.toContain("browser-bar");
  });

  it("renders Meta preview html in an iframe instead of the static thumbnail chain", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer open businessId="biz_1" card={card()} {...noopProps} />,
      {
        html: "<div data-meta-preview>Real Meta ad preview</div>",
        adFormat: "MOBILE_FEED_STANDARD",
        source: "meta_creative_previews",
        targetType: "ad",
      },
    );

    expect(html).toContain("creative-evidence-live-frame");
    expect(html).toContain("creative-evidence-preview-frame-shell");
    expect(html).toContain("data-preview-placement=\"feed\"");
    expect(html).toContain("--preview-aspect:4 / 5");
    expect(html).toContain("--preview-native-width:540px");
    expect(html).toContain("--preview-native-height:675px");
    expect(html).not.toContain("--preview-scaled-width");
    expect(html).not.toContain("--preview-scaled-height");
    expect(html).toContain("adsecute-meta-preview-fit");
    expect(html).toContain("adsecute-meta-preview-content");
    expect(html).toContain("body &gt; iframe");
    expect(html).toContain("fitNestedPreviewFrames");
    expect(html).toContain("fitContentLayer");
    expect(html).toContain("readContentDimension");
    expect(html).toContain("adsecuteNativeWidth");
    expect(html).toContain("fitScaleFor");
    expect(html).toContain("FIT_MODE === &quot;cover&quot;");
    expect(html).toContain("Math.min(ratioWidth, ratioHeight)");
    expect(html).toContain("wrapper.querySelectorAll(&quot;iframe&quot;)");
    expect(html).toContain("setAttribute(&quot;scrolling&quot;, &quot;no&quot;)");
    expect(html).toContain("setProperty(&quot;overflow&quot;, &quot;hidden&quot;, &quot;important&quot;)");
    expect(html).toContain("setProperty(&quot;scrollbar-width&quot;, &quot;none&quot;, &quot;important&quot;)");
    expect(html).toContain("Real Meta ad preview");
    expect(html).toContain("Meta preview - mobile feed standard");
    expect(html).not.toContain("creative-evidence-phone-surface");
    expect(html).not.toContain("creative-evidence-preview-overlay");
  });

  it("opens with an unavailable evidence state when card evidence is missing", () => {
    const html = renderDrawer(
      <CreativeEvidenceDrawer
        open
        card={card({
          reason: null,
          spend: null,
          roas: null,
          cpa: null,
          purchases: null,
          ctr: null,
          addToCart: null,
          frequency: null,
          fatigue: null,
          bestPlacement: null,
          placementList: null,
        })}
        {...noopProps}
      />,
    );

    expect(html).toContain("Evidence unavailable");
    expect(html).toContain("missing evidence fields");
    expect(html).toContain("creative-evidence-preview-slot");
    expect(html).not.toContain("creative-evidence-phone");
  });

  it("hides when closed", () => {
    expect(
      renderDrawer(
        <CreativeEvidenceDrawer open={false} card={card()} {...noopProps} />,
      ),
    ).toBe("");
  });
});
