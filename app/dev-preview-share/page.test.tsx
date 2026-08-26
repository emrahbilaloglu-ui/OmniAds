import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigationMocks = vi.hoisted(() => ({
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: navigationMocks.notFound,
}));

const { default: DevPreviewSharePage } = await import(
  "@/app/dev-preview-share/page"
);

async function renderPage(searchParams: { audience?: string; state?: string } = {}) {
  const page = await DevPreviewSharePage({
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(page);
}

describe("/dev-preview-share", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    navigationMocks.notFound.mockClear();
  });

  it("is unavailable in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(navigationMocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("defaults invalid audiences to the real creator-safe projection", async () => {
    const html = await renderPage({ audience: "not-an-audience" });

    expect(html).toContain('data-share-audience="creative_team"');
    expect(html).toContain('data-band="Strong"');
    expect(html).not.toContain("$4,820.00");
    expect(html).not.toContain("/dev-preview-share/csv");
    expect(html).not.toContain("dev_preview_internal_business");
    expect(html).not.toContain("act_dev_preview_internal");
    expect(html).not.toContain("private-preview@example.com");
  });

  it("renders buyer-only financials, actions and a working CSV target", async () => {
    const html = await renderPage({ audience: "buyer" });

    expect(html).toContain('data-share-audience="buyer"');
    expect(html).toContain("$4,820.00");
    expect(html).toContain("Paused an underperforming ad");
    expect(html).toContain("/dev-preview-share/csv");
    expect(html).not.toContain("dev_preview_internal_business");
  });

  it("covers catalog-only, empty and unavailable visual states", async () => {
    const catalog = await renderPage({ state: "real" });
    const empty = await renderPage({ state: "empty" });
    const gone = await renderPage({ state: "gone" });

    expect(catalog).toContain("Catalog — bestsellers");
    expect(catalog).not.toContain("Hero video — product in motion");
    expect(empty).toContain('data-public-share="ready"');
    expect(empty).toContain("This share contains no creatives.");
    expect(gone).toContain('data-public-share="unavailable"');
  });
});
