import { describe, expect, it } from "vitest";

import {
  INSIGHTS_SECTIONS,
  buildInsightsShellExactModel,
  buildInsightsSectionTabs,
  buildInsightsSourceChip,
  resolveInsightsRouteBase,
} from "./insights-shell-exact-adapter";

const CONNECTED = { isConnected: true, status: "connected" };
const OFF = { isConnected: false, status: "not_connected" };

describe("insights shell adapter", () => {
  it("orders the outer sections Analytics / SEO Intelligence / AI Visibility", () => {
    expect(INSIGHTS_SECTIONS.map((section) => section.label)).toEqual([
      "Analytics",
      "SEO Intelligence",
      "AI Visibility",
    ]);
  });

  it("resolves the canonical business-scoped base", () => {
    expect(resolveInsightsRouteBase("/c/biz_1/analytics/ga4-shopify")).toEqual({
      base: "/c/biz_1/analytics",
      kind: "canonical",
    });
    expect(resolveInsightsRouteBase("/app/analytics/seo")).toEqual({
      base: "/app/analytics",
      kind: "canonical",
    });
    expect(resolveInsightsRouteBase("/insights/ai-visibility")).toEqual({
      base: "/insights",
      kind: "legacy",
    });
  });

  it("points the legacy family at the preserved leaves", () => {
    const tabs = buildInsightsSectionTabs("/insights/analytics");
    expect(tabs.map((tab) => tab.href)).toEqual([
      "/insights/analytics",
      "/insights/seo",
      "/insights/ai-visibility",
    ]);
    expect(tabs.map((tab) => tab.active)).toEqual([true, false, false]);
  });

  it("points the canonical family at its own leaves", () => {
    const tabs = buildInsightsSectionTabs("/c/biz_1/analytics/geo");
    expect(tabs.map((tab) => tab.href)).toEqual([
      "/c/biz_1/analytics/ga4-shopify",
      "/c/biz_1/analytics/seo",
      "/c/biz_1/analytics/geo",
    ]);
    expect(tabs.find((tab) => tab.id === "geo")?.active).toBe(true);
  });

  it("keeps the Analytics pill lit on the landing-pages leaf", () => {
    const tabs = buildInsightsSectionTabs("/c/biz_1/analytics/landing-pages");
    expect(tabs.find((tab) => tab.id === "analytics")?.active).toBe(true);
  });

  it("reads the connection state from the provider, never hardcoding it", () => {
    expect(buildInsightsSourceChip("ga4", CONNECTED)).toEqual({
      id: "ga4",
      label: "GA4",
      iconSrc: "/platform-logos/GA4.svg",
      stateLabel: "connected",
      tone: "positive",
    });
    expect(buildInsightsSourceChip("search_console", OFF).stateLabel).toBe(
      "not connected",
    );
    expect(
      buildInsightsSourceChip("search_console", {
        isConnected: false,
        status: "action_required",
      }),
    ).toMatchObject({ stateLabel: "action required", tone: "warning" });
  });

  it("builds the head the design defines and nothing more", () => {
    const model = buildInsightsShellExactModel({
      pathname: "/insights/analytics",
      ga4: CONNECTED,
      searchConsole: OFF,
    });
    expect(model.eyebrow).toBe("Growth · GA4 + Search Console");
    expect(model.title).toBe("Insights");
    expect(model.sources.map((source) => source.label)).toEqual([
      "GA4",
      "Search Console",
    ]);
    expect(Object.keys(model)).toEqual(["eyebrow", "title", "tabs", "sources"]);
  });
});
