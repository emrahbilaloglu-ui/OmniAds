import { describe, expect, it } from "vitest";

import { resolvePublicRouteRedirect } from "@/lib/zero-base/public-routes";

describe("public workspace URL cutover", () => {
  it("removes the business UUID while preserving the surface", () => {
    expect(resolvePublicRouteRedirect("/c/biz_123/creative/cr_9")).toEqual({
      destination: "/app/creative/cr_9",
      businessId: "biz_123",
    });
  });

  it("does not rewrite public application routes again", () => {
    expect(resolvePublicRouteRedirect("/app/meta/decisions")).toBeNull();
  });

  /**
   * These used to redirect to an `/app/**` twin from inside the proxy, ahead of
   * every page and reading no configuration. That is why `ZERO_BASE_UI_MODE=off`
   * could not roll the UI back: the pages and the API routes honoured it, but a
   * browser never reached them. Each of these paths has a page of its own, so
   * the proxy now leaves them alone and the page decides what to render.
   */
  it.each([
    "/overview",
    "/team",
    "/commercial-truth",
    "/settings",
    "/integrations",
    "/integrations/callback/shopify",
    "/reports",
    "/reports/r_1/edit",
    "/platforms/meta",
    "/platforms/meta/creatives",
    "/platforms/google/keywords",
    "/platforms/klaviyo",
    "/insights/seo",
  ])("leaves %s for its own page to answer", (pathname) => {
    expect(resolvePublicRouteRedirect(pathname)).toBeNull();
  });
});
