import { describe, expect, it } from "vitest";
import { getCreativeFormatPresentation } from "@/components/creatives/briefing/creative-format";

describe("getCreativeFormatPresentation", () => {
  it("prefers canonical video taxonomy over legacy image format", () => {
    expect(
      getCreativeFormatPresentation({
        format: "image",
        creativeVisualFormat: "video",
        creativePrimaryType: "video",
        creativePrimaryLabel: "Video",
        preview: {
          render_mode: "image",
          video_url: null,
        },
      }),
    ).toMatchObject({
      tag: "VID",
      detailLabel: "Video",
      shape: "portrait",
      ratio: "9:16",
      isVideo: true,
    });
  });

  it("surfaces carousel and catalog taxonomy without name heuristics", () => {
    expect(
      getCreativeFormatPresentation({
        format: "image",
        creativeVisualFormat: "carousel",
        creativePrimaryType: "carousel",
      }),
    ).toMatchObject({
      tag: "CAR",
      shape: "square",
      ratio: "1:1",
      isCarousel: true,
    });

    expect(
      getCreativeFormatPresentation({
        format: "catalog",
        creativeDeliveryType: "catalog",
        creativePrimaryType: "catalog",
        creativePrimaryLabel: "Catalog",
        isCatalog: true,
      }),
    ).toMatchObject({
      tag: "CAT",
      detailLabel: "Catalog",
      shape: "feed",
      ratio: "4:5",
      isCatalog: true,
    });
  });
});
