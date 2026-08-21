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

  it("preserves a creative-team audience and shows no financial warning", () => {
    mount(payload({ audience: "creative_team" }));
    expect(document.querySelector('[data-share-audience="creative_team"]')).not.toBeNull();
    expect(document.querySelector("[data-share-financial-warning]")).toBeNull();
  });

  it("shows buyer-safe persisted actions without publishing ledger ids", () => {
    mount(
      payload({
        clientActions: [
          {
            id: "internal_action_log_123",
            what: "Paused an underperforming ad",
            why: "It was not delivering efficient results.",
            date: "2026-08-18",
            outcome: "Done",
            outcomeTone: "positive",
          },
        ],
      }),
    );

    expect(screen.getByText("What changed and why")).toBeTruthy();
    expect(screen.getByText("Paused an underperforming ad")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("internal_action_log_123");
  });

  it("withholds buyer action history from non-buyer audiences", () => {
    mount(
      payload({
        audience: "external",
        clientActions: [
          {
            what: "Paused an ad",
            why: "Below target",
            date: "2026-08-18",
          },
        ],
      }),
    );
    expect(document.querySelector("[data-public-share-actions]")).toBeNull();
  });

  it("renders every selected, measured metric and omits unselected values", () => {
    mount(
      payload({
        metrics: ["spend", "purchaseValue", "roas", "ctrAll", "video100"],
        creatives: [
          creative({
            currency: "EUR",
            spend: 100,
            purchaseValue: 300,
            roas: 3,
            ctrAll: 1.2,
            video100: 31,
            purchases: 10,
          }),
        ],
      }),
    );

    // The same frozen values appear twice by design — once on the card, once
    // in the buyer's side-by-side comparison table — so this checks presence
    // rather than a single unique match.
    expect(screen.getAllByText("€100.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("€300.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3x").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1.2%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("31%").length).toBeGreaterThan(0);
    expect(document.querySelector('[data-public-metric="purchases"]')).toBeNull();
  });

  it("offers CSV only when the sanitized buyer share permits it", () => {
    const share = toPublicShare(payload({ allowCsv: true }));
    render(<PublicSharePage share={share} csvHref="/share/creative/token/csv" />);
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeTruthy();
    // A sanitized share that drops allowCsv must not offer CSV even if the
    // route still hands the composition an href.
    cleanup();

    render(
      <PublicSharePage
        share={toPublicShare(payload({ audience: "external", allowCsv: true }))}
        csvHref="/share/creative/token/csv"
      />,
    );
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });

  it("says CSV was not enabled when a buyer share withholds it", () => {
    mount(payload({ allowCsv: false }));
    expect(screen.getByText("CSV export was not enabled for this link.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });

  it("does not invent generic commentary that was never stored in the snapshot", () => {
    mount();
    expect(document.body.textContent).not.toContain("Commentary");
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
    expect(video.getAttribute("poster")).toBe("https://cdn.example/hero.jpg");
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

/* --------------------------------------------------------------- csv */

describe("the CSV download button", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches the export, triggers a save and reports success", async () => {
    const blob = new Blob(["csv"], { type: "text/csv" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => blob }));
    // Patch only the two statics; replacing URL itself breaks `new URL(...)`.
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:mock"),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
      writable: true,
    });
    const downloads: string[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = realCreate(tag) as HTMLElement;
      if (tag === "a") {
        element.addEventListener("click", (event) => {
          event.preventDefault();
          downloads.push((element as HTMLAnchorElement).download);
        });
      }
      return element;
    });

    render(
      <PublicSharePage
        share={toPublicShare(payload({ allowCsv: true }))}
        csvHref="/share/creative/token/csv"
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Download CSV" }));

    await waitFor(() => expect(screen.getByText("snapshot-creatives.csv saved")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("/share/creative/token/csv");
    expect(downloads).toEqual(["snapshot-creatives.csv"]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });

  it("reports a failed export without implying the metrics are affected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    render(
      <PublicSharePage
        share={toPublicShare(payload({ allowCsv: true }))}
        csvHref="/share/creative/token/csv"
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Download CSV" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
    expect(
      screen.getByText(/CSV couldn.t be generated\. Metrics on this page are unaffected\./),
    ).toBeTruthy();
  });
});

/* ------------------------------------------------------------- notes */

describe("the live notes thread", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders messages already on the frozen snapshot", () => {
    mount(
      payload({
        messages: [
          { id: "m1", who: "sender", name: "Emrah B.", text: "Two of these are wearing out.", postedAt: "2026-08-13" },
          { id: "m2", who: "viewer", name: "Maya", text: "Which one specifically?", postedAt: "2026-08-14" },
        ],
      }),
    );
    expect(screen.getByText("Two of these are wearing out.")).toBeTruthy();
    expect(screen.getByText("Which one specifically?")).toBeTruthy();
    expect(screen.getByText("SENDER")).toBeTruthy();
  });

  it("posts a new note to messagesHref and renders the server's own list back", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          { id: "m1", who: "viewer", name: "You", text: "Is this still running?", postedAt: "2026-08-15" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <PublicSharePage share={toPublicShare(payload())} messagesHref="/share/creative/token/messages" />,
    );
    await userEvent.setup().type(screen.getByLabelText("Write a note"), "Is this still running?");
    await userEvent.setup().click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("Is this still running?")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/share/creative/token/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders no composer when the route gave no messagesHref", () => {
    mount();
    expect(screen.queryByLabelText("Write a note")).toBeNull();
  });
});

/* ----------------------------------------------------- attention story */

describe("the creative-team attention story", () => {
  it("renders a plain-language verdict banded against a real account benchmark", () => {
    mount(
      payload({
        audience: "creative_team",
        benchmarks: { ctrAll: 1.0 },
        creatives: [creative({ ctrAll: 2.0, thumbstop: null, video25: null, video50: null, video75: null, video100: null })],
      }),
    );
    expect(document.querySelector('[data-band="Strong"]')).not.toBeNull();
    expect(document.body.textContent).toContain("CTR 2.00%");
  });

  it("shows the raw number with no fabricated band when no benchmark was served", () => {
    mount(
      payload({
        audience: "creative_team",
        creatives: [creative({ ctrAll: 2.0, thumbstop: null, video25: null, video50: null, video75: null, video100: null })],
      }),
    );
    // The fill bar always carries a data-band for its own fallback color;
    // only "Strong"/"Typical"/"Weak" is a real, benchmark-backed claim.
    for (const band of ["Strong", "Typical", "Weak"]) {
      expect(document.querySelector(`[data-band="${band}"]`)).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/typical:/);
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
