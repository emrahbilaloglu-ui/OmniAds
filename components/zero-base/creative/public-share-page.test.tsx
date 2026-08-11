// @vitest-environment jsdom

/**
 * The PRODUCTION public share composition, rendered from real SharePayload
 * fixtures.
 *
 * A test of ShareMedia in isolation proved nothing about what a visitor sees —
 * that is exactly how the unmounted composition survived acceptance. These
 * render the component the route actually mounts, through the same
 * `toPublicShare` the route uses.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  PublicSharePage,
  PublicShareUnavailable,
} from "@/components/zero-base/creative/public-share-page";
import { findLeakedIdentity, toPublicShare } from "@/lib/zero-base/creative/public-share";
import type { SharePayload } from "@/components/creatives/shareCreativeTypes";

afterEach(cleanup);

const BUSINESS_ID = "biz-internal-9f2c";
const ACCOUNT = "act_internal_7781";
const BUSINESS_NAME = "Acme Internal Workspace";
const CLIENT_EMAIL = "finance@acme-internal.example";

function creative(overrides: Record<string, unknown> = {}) {
  return {
    id: "cr-internal-1",
    name: "Hero video",
    format: "video",
    previewState: "preview",
    isCatalog: false,
    previewUrl: null,
    imageUrl: null,
    thumbnailUrl: null,
    preview: {
      render_mode: "video",
      image_url: null,
      video_url: "https://cdn.example/hero.mp4",
      poster_url: "https://cdn.example/hero.jpg",
      source: "preview_url",
      is_catalog: false,
    },
    launchDate: "2026-07-01",
    tags: [],
    spend: 100,
    purchaseValue: 300,
    roas: 3,
    cpa: 10,
    ctrAll: 1.2,
    purchases: 10,
    ...overrides,
  };
}

/** A payload shaped exactly as the store returns one. */
function payload(overrides: Record<string, unknown> = {}): SharePayload {
  return {
    token: "tok-abc",
    title: "Q3 creatives",
    dateRange: "2026-07-01..2026-07-31",
    createdAt: "2026-08-01",
    expiresAt: "2026-09-01",
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT,
    businessName: BUSINESS_NAME,
    clientEmail: CLIENT_EMAIL,
    metrics: [],
    includeNotes: false,
    audience: "buyer",
    creatives: [creative()],
    ...overrides,
  } as unknown as SharePayload;
}

function mount(raw: SharePayload = payload()) {
  render(<PublicSharePage share={toPublicShare(raw)} />);
}

const SECRETS = [BUSINESS_ID, ACCOUNT, BUSINESS_NAME, CLIENT_EMAIL, "cr-internal-1"];

/* --------------------------------------------------------- sanitization */

describe("no workspace identity reaches the public page", () => {
  it("leaks none of it into the rendered DOM", () => {
    mount();
    const html = document.body.innerHTML;
    for (const secret of SECRETS) {
      expect(html, secret).not.toContain(secret);
    }
  });

  it("leaks none of it through alt text", () => {
    mount();
    const alt = screen.getByRole("article").querySelector("[data-share-media]")?.getAttribute("alt");
    expect(alt ?? "").not.toContain(ACCOUNT);
    expect(alt ?? "").not.toContain(BUSINESS_NAME);
  });

  it("drops the fields from the object itself, not just from the render", () => {
    // Not rendering a field is one edit away from rendering it.
    expect(findLeakedIdentity(toPublicShare(payload()), SECRETS)).toEqual([]);
  });

  it("publishes an opaque row key rather than the internal creative id", () => {
    mount();
    expect(document.querySelector('[data-share-creative="c1"]')).not.toBeNull();
    expect(document.querySelector('[data-share-creative="cr-internal-1"]')).toBeNull();
  });

  it("leaks nothing through a media-missing reason", () => {
    mount(payload({ creatives: [creative({ preview: { render_mode: "video", video_url: null, image_url: null, poster_url: null, source: null, is_catalog: false } })] }));
    const reason = document.querySelector("[data-share-media]")!.textContent ?? "";
    for (const secret of SECRETS) expect(reason).not.toContain(secret);
  });
});

/* ------------------------------------------------------------- audience */

describe("audience behaviour is preserved", () => {
  it("shows the financial limitation on a buyer share", () => {
    mount();
    expect(document.querySelector('[data-share-audience="buyer"]')).not.toBeNull();
    expect(document.querySelector("[data-share-financial-warning]")!.textContent).toMatch(
      /attribution-window dependent/,
    );
  });

  it("shows no financial warning on a creator share", () => {
    mount(payload({ audience: "creator" }));
    expect(document.querySelector('[data-share-audience="creator"]')).not.toBeNull();
    expect(document.querySelector("[data-share-financial-warning]")).toBeNull();
  });
});

/* ---------------------------------------------------------------- media */

describe("media comes from the served payload", () => {
  it("mounts a keyboard-operable video with native controls", () => {
    mount();
    const video = document.querySelector('[data-share-media="video"]') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.querySelector("source")!.getAttribute("src")).toBe("https://cdn.example/hero.mp4");
  });

  it("mounts NO captions track, because the payload contract serves none", () => {
    mount();
    // Inventing one would promise an accessibility affordance that does nothing.
    expect(document.querySelector("track")).toBeNull();
    expect(toPublicShare(payload()).captionsSupported).toBe(false);
    expect(document.body.textContent).not.toMatch(/captions/i);
  });

  it("renders an image creative from the served image url", () => {
    mount(
      payload({
        creatives: [
          creative({
            format: "image",
            preview: {
              render_mode: "image",
              image_url: "https://cdn.example/a.jpg",
              video_url: null,
              poster_url: null,
              source: "image_url",
              is_catalog: false,
            },
          }),
        ],
      }),
    );
    expect(document.querySelector('[data-share-media="image"]')!.getAttribute("src")).toBe(
      "https://cdn.example/a.jpg",
    );
  });

  it("says a video has no playable source rather than showing its poster", () => {
    mount(
      payload({
        creatives: [
          creative({
            preview: {
              render_mode: "video",
              image_url: null,
              video_url: null,
              poster_url: "https://cdn.example/hero.jpg",
              source: null,
              is_catalog: false,
            },
          }),
        ],
      }),
    );
    // A still frame the viewer cannot play is worse than saying so.
    expect(document.querySelector('[data-share-media="missing"]')!.textContent).toMatch(
      /no playable source/,
    );
  });

  it("names a creative with no media at all", () => {
    mount(
      payload({
        creatives: [
          creative({
            format: "image",
            preview: { render_mode: "unavailable", image_url: null, video_url: null, poster_url: null, source: null, is_catalog: false },
          }),
        ],
      }),
    );
    expect(document.querySelector('[data-share-media="missing"]')!.textContent).toMatch(
      /No preview was captured/,
    );
  });

  it("shows an error state and a retry that re-attempts the load", async () => {
    mount(
      payload({
        creatives: [
          creative({
            format: "image",
            preview: { render_mode: "image", image_url: "https://cdn.example/broken.jpg", video_url: null, poster_url: null, source: "image_url", is_catalog: false },
          }),
        ],
      }),
    );
    document.querySelector('[data-share-media="image"]')!.dispatchEvent(new Event("error"));
    await waitFor(() => expect(document.querySelector('[data-share-media="error"]')).not.toBeNull());

    await userEvent.setup().click(document.querySelector("[data-share-media-retry]") as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-share-media="image"]')).not.toBeNull());
  });

  it("says a share carried no creatives rather than rendering an empty page", () => {
    mount(payload({ creatives: [] }));
    expect(document.querySelector('[data-share-creatives="empty"]')).not.toBeNull();
  });
});

/* ---------------------------------------------------------- unavailable */

describe("every dead token looks the same", () => {
  it("renders one composition with no cause named", () => {
    render(<PublicShareUnavailable />);
    const text = document.querySelector('[data-public-share="unavailable"]')!.textContent ?? "";
    expect(text).toMatch(/expired, been withdrawn, or never existed/);
    // Naming the cause tells a stranger the link was once real.
    expect(text).not.toMatch(/revoked by|rotated|this business|workspace/i);
  });

  it("carries no workspace identity", () => {
    render(<PublicShareUnavailable />);
    for (const secret of SECRETS) expect(document.body.innerHTML).not.toContain(secret);
  });
});

/* ----------------------------------------------- the route mounts this one */

describe("the production route composition", () => {
  it("is what app/share/creative/[token]/page.tsx imports", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("app/share/creative/[token]/page.tsx", "utf8"),
    );
    expect(source).toContain("@/components/zero-base/creative/public-share-page");
    expect(source).toContain("toPublicShare");
    // The legacy composition must not remain an alternate production path.
    expect(source).not.toContain("PublicCreativeSharePage");
    expect(source).not.toContain("MOCK_SHARE_PAYLOAD");
  });

  it("keeps page metadata constant, so it cannot differ by token", () => {
    const source = require("node:fs").readFileSync("app/share/creative/[token]/page.tsx", "utf8");
    expect(source).toMatch(/title: "Shared creatives"/);
    expect(source).not.toMatch(/title:\s*payload|title:\s*share\./);
  });
});
