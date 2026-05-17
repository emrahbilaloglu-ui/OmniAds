import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PhonePreview } from "@/components/common/briefing/PhonePreview";

describe("PhonePreview", () => {
  it("renders a portrait mock with a play button for video", () => {
    const html = renderToStaticMarkup(
      <PhonePreview
        shape="portrait"
        format="VID"
        name="UGC-Sarah-V2"
        meta="BFCM-Test-A · Adset 04"
        placement="reels"
      />,
    );

    expect(html).toContain("UGC-Sarah-V2");
    expect(html).toContain("BFCM-Test-A");
    expect(html).toContain("VID · 9:16");
    expect(html).toContain(">Reels<");
    expect(html).toContain('data-active="true"');
  });

  it("renders a square mock for static IMG without a play button", () => {
    const html = renderToStaticMarkup(
      <PhonePreview
        shape="square"
        format="IMG"
        name="Static-Offer-A"
      />,
    );

    expect(html).toContain("Static-Offer-A");
    expect(html).toContain("IMG · 1:1");
    expect(html).not.toContain("lucide-play");
  });

  it("falls back to a placeholder background when imageUrl is missing", () => {
    const html = renderToStaticMarkup(
      <PhonePreview shape="portrait" format="CAR" name="Carousel" />,
    );

    expect(html).toContain("linear-gradient");
  });

  it("uses an image element when imageUrl is provided", () => {
    const html = renderToStaticMarkup(
      <PhonePreview
        shape="portrait"
        format="VID"
        name="UGC"
        imageUrl="https://example.com/preview.jpg"
      />,
    );

    expect(html).toContain('src="https://example.com/preview.jpg"');
  });
});
