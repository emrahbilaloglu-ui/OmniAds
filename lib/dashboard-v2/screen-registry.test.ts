import { describe, expect, it } from "vitest";

import {
  DASHBOARD_REFERENCE_SCREENS,
  DASHBOARD_SCREEN_IDS,
  dashboardHrefForRouteFamily,
  dashboardReferenceRouteEntries,
  dashboardScreenForPath,
  normalizeDashboardPath,
} from "@/lib/dashboard-v2/screen-registry";

describe("Dashboard v2 screen registry", () => {
  it("locks the eighteen reference-defined primary screens", () => {
    expect(DASHBOARD_SCREEN_IDS).toHaveLength(18);
    expect(Object.keys(DASHBOARD_REFERENCE_SCREENS)).toEqual([
      ...DASHBOARD_SCREEN_IDS,
    ]);
  });

  it("maps legacy, readable and business-scoped canonical paths to one screen", () => {
    expect(dashboardScreenForPath("/overview")?.screen).toBe("overview");
    expect(dashboardScreenForPath("/app/home")?.screen).toBe("overview");
    expect(dashboardScreenForPath("/c/biz_1/home")?.screen).toBe("overview");
    expect(dashboardScreenForPath("/platforms/google/assets")?.screen).toBe(
      "google-assets",
    );
    expect(
      dashboardScreenForPath("/c/biz_1/google/assets-audiences")?.screen,
    ).toBe("google-assets");
  });

  it("keeps creative and insights route state explicit", () => {
    expect(dashboardScreenForPath("/platforms/meta/copies")?.state).toBe(
      "copies",
    );
    expect(dashboardScreenForPath("/app/creative/inbox")?.state).toBe("inbox");
    expect(dashboardScreenForPath("/insights/seo")?.state).toBe("seo");
    expect(dashboardScreenForPath("/app/analytics/geo")?.state).toBe(
      "ai-visibility",
    );
    expect(dashboardScreenForPath("/app/creative/audiences")?.state).toBe(
      "audiences",
    );
    expect(dashboardScreenForPath("/c/biz_1/klaviyo")?.screen).toBe("klaviyo");
  });

  it("does not invent a reference mapping for detail and editor routes", () => {
    expect(dashboardScreenForPath("/reports/new")).toBeNull();
    expect(dashboardScreenForPath("/app/reports/report_1/edit")).toBeNull();
    expect(dashboardScreenForPath("/app/creative/creative_1")).toBeNull();
  });

  it("normalizes query, trailing slash and scoped business ids", () => {
    expect(
      normalizeDashboardPath("/c/5dbc7147/google/plan/?tab=activity#top"),
    ).toBe("/app/google/plan");
  });

  it("keeps navigation inside the active route family", () => {
    expect(dashboardHrefForRouteFamily("/platforms/meta", "/overview")).toBe(
      "/platforms/meta",
    );
    expect(dashboardHrefForRouteFamily("/platforms/meta", "/app/home")).toBe(
      "/app/meta/decisions",
    );
    expect(
      dashboardHrefForRouteFamily(
        "/platforms/google/assets?tab=audiences#top",
        "/c/biz_1/home",
      ),
    ).toBe("/c/biz_1/google/assets-audiences?tab=audiences#top");
    expect(
      dashboardHrefForRouteFamily(
        "/insights/ai-visibility",
        "/app/analytics/seo",
      ),
    ).toBe("/app/analytics/geo");
    expect(
      dashboardHrefForRouteFamily("/platforms/klaviyo", "/c/biz_1/home"),
    ).toBe("/c/biz_1/klaviyo");
    expect(
      dashboardHrefForRouteFamily(
        "/reports/report_1/edit?from=list",
        "/app/reports",
      ),
    ).toBe("/app/reports/report_1/edit?from=list");
    expect(
      dashboardHrefForRouteFamily("/reports/report_1", "/c/biz_1/reports"),
    ).toBe("/c/biz_1/reports/report_1");
    expect(
      dashboardHrefForRouteFamily("/login?next=/reports", "/c/biz_1/reports"),
    ).toBe("/login?next=/reports");
  });

  it("has no route aliases pointing outside the locked screen vocabulary", () => {
    const allowed = new Set(DASHBOARD_SCREEN_IDS);
    for (const [, value] of dashboardReferenceRouteEntries()) {
      expect(allowed.has(value.screen)).toBe(true);
    }
  });
});
