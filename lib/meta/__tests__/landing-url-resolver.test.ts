import {
  canonicalizeLandingUrl,
  getMetaLandingUrlDiagnosticSignals,
  resolveMetaLandingUrl,
} from "@/lib/meta/landing-url-resolver";
import { META_LANDING_PAGE_BLOCKED_FIELDS, getMetaLandingPageCreativeFields } from "@/lib/meta/landing-pages-fetchers";
import { resolveMetaStoryLandingUrl } from "@/lib/meta/landing-url-story-fallback";
import type { MetaAdRecord } from "@/lib/meta/creatives-types";

function makeCreative(
  creative: MetaAdRecord["creative"]
): MetaAdRecord["creative"] {
  return creative;
}

describe("resolveMetaLandingUrl", () => {
  it("prefers object_story_spec.link_data.link", () => {
    const result = resolveMetaLandingUrl(
      makeCreative({
        object_story_spec: {
          link_data: {
            link: "https://example.com/offer?utm_source=meta&fbclid=123",
          },
        },
      })
    );

    expect(result.rawUrl).toBe("https://example.com/offer?utm_source=meta&fbclid=123");
    expect(result.canonicalUrl).toBe("https://example.com/offer");
    expect(result.source).toBe("object_story_spec.link_data.link");
    expect(result.confidence).toBe("high");
  });

  it("falls back to video CTA link", () => {
    const result = resolveMetaLandingUrl(
      makeCreative({
        object_story_spec: {
          video_data: {
            call_to_action: {
              value: {
                link: "https://example.com/video",
              },
            },
          },
        },
      })
    );

    expect(result.canonicalUrl).toBe("https://example.com/video");
    expect(result.source).toBe("object_story_spec.video_data.call_to_action.value.link");
  });

  it("falls back to child attachment link", () => {
    const result = resolveMetaLandingUrl(
      makeCreative({
        object_story_spec: {
          link_data: {
            child_attachments: [
              { link: "https://example.com/a" },
              { link: "https://example.com/b" },
            ],
          },
        },
      })
    );

    expect(result.canonicalUrl).toBe("https://example.com/a");
    expect(result.source).toBe("object_story_spec.link_data.child_attachments[].link");
    expect(result.confidence).toBe("medium");
  });

  it("uses asset feed link URLs before low-confidence template discovery", () => {
    const result = resolveMetaLandingUrl(
      makeCreative({
        asset_feed_spec: {
          link_urls: [
            {
              website_url: "https://example.com/feed?utm_medium=paid",
            },
          ],
        },
        object_story_spec: {
          template_data: {
            nested: {
              website_url: "https://example.com/template",
            },
          },
        },
      })
    );

    expect(result.canonicalUrl).toBe("https://example.com/feed");
    expect(result.source).toBe("asset_feed_spec.link_urls[].website_url");
    expect(result.confidence).toBe("high");
  });

  it("falls back to template_data URL discovery", () => {
    const result = resolveMetaLandingUrl(
      makeCreative({
        object_story_spec: {
          template_data: {
            nested: {
              website_url: "https://example.com/template?utm_campaign=test",
            },
          },
        },
      })
    );

    expect(result.canonicalUrl).toBe("https://example.com/template");
    expect(result.source).toBe("object_story_spec.template_data");
    expect(result.confidence).toBe("low");
  });

  it("returns unresolved when no supported URL field exists", () => {
    const result = resolveMetaLandingUrl(
      makeCreative({
        object_story_spec: {
          link_data: {
            message: "No URL here",
          },
        },
      })
    );

    expect(result.rawUrl).toBeNull();
    expect(result.canonicalUrl).toBeNull();
    expect(result.source).toBe("unresolved");
    expect(result.confidence).toBe("unresolved");
  });
});

describe("resolveMetaStoryLandingUrl", () => {
  it("resolves Page-token story CTA links with CTA type", () => {
    const result = resolveMetaStoryLandingUrl({
      id: "123_456",
      call_to_action: {
        type: "SHOP_NOW",
        value: {
          link: "https://example.com/story?fbclid=abc",
        },
      },
    });

    expect(result.canonicalUrl).toBe("https://example.com/story");
    expect(result.source).toBe("story.call_to_action.value.link");
    expect(result.ctaType).toBe("SHOP_NOW");
    expect(result.confidence).toBe("medium");
  });

  it("falls back to story attachment targets", () => {
    const result = resolveMetaStoryLandingUrl({
      id: "123_456",
      attachments: {
        data: [
          {
            target: {
              url: "https://example.com/attachment",
            },
          },
        ],
      },
    });

    expect(result.canonicalUrl).toBe("https://example.com/attachment");
    expect(result.source).toBe("story.attachments[].target.url");
  });
});

describe("canonicalizeLandingUrl", () => {
  it("removes hashes, strips tracking params, and normalizes trailing slash", () => {
    expect(
      canonicalizeLandingUrl("https://Example.com/path/?utm_source=meta&foo=1#section")
    ).toBe("https://example.com/path?foo=1");
  });
});

describe("getMetaLandingUrlDiagnosticSignals", () => {
  it("reports structural availability for unresolved creatives", () => {
    const signals = getMetaLandingUrlDiagnosticSignals(
      makeCreative({
        object_type: "VIDEO",
        object_story_id: "123_456",
        effective_object_story_id: "123_789",
        object_story_spec: {
          link_data: {
            child_attachments: [{ link: "https://example.com/child" }],
          },
          video_data: {},
          template_data: {
            nested: "https://example.com/template",
          },
        },
      })
    );

    expect(signals.objectType).toBe("VIDEO");
    expect(signals.hasObjectStoryId).toBe(true);
    expect(signals.hasEffectiveObjectStoryId).toBe(true);
    expect(signals.hasObjectStorySpec).toBe(true);
    expect(signals.hasLinkData).toBe(true);
    expect(signals.hasVideoData).toBe(true);
    expect(signals.hasPhotoData).toBe(false);
    expect(signals.hasTemplateData).toBe(true);
    expect(signals.hasChildAttachments).toBe(true);
    expect(signals.hasDirectLink).toBe(false);
    expect(signals.hasVideoCtaLink).toBe(false);
  });
});

describe("getMetaLandingPageCreativeFields", () => {
  it("does not include known blocked fields for landing extraction", () => {
    const fieldSet = getMetaLandingPageCreativeFields();
    for (const blockedField of META_LANDING_PAGE_BLOCKED_FIELDS) {
      expect(fieldSet.includes(blockedField)).toBe(false);
    }
  });
});
