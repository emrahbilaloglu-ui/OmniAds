import { describe, expect, it } from "vitest";

import { resolvePublicRouteRedirect } from "@/lib/zero-base/public-routes";

describe("public workspace URL cutover", () => {
  it.each([
    ["/overview", "/app/home"],
    ["/platforms/meta", "/app/meta/decisions"],
    ["/platforms/meta/creatives", "/app/creative/performance"],
    ["/platforms/google/keywords", "/app/google/search"],
    ["/insights/seo", "/app/analytics/seo"],
    ["/reports/r_1/edit", "/app/reports/r_1/edit"],
    ["/integrations", "/app/manage/integrations"],
  ])("moves %s to %s", (legacy, expected) => {
    expect(resolvePublicRouteRedirect(legacy)).toEqual({
      destination: expected,
      businessId: null,
    });
  });

  it("removes the business UUID while preserving the surface", () => {
    expect(resolvePublicRouteRedirect("/c/biz_123/creative/cr_9")).toEqual({
      destination: "/app/creative/cr_9",
      businessId: "biz_123",
    });
  });

  it("does not rewrite public application routes again", () => {
    expect(resolvePublicRouteRedirect("/app/meta/decisions")).toBeNull();
  });
});
