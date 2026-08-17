import { describe, expect, it } from "vitest";

import {
  INSIGHTS_SECTIONS,
  buildInsightsShellExactModel,
  buildInsightsSectionTabs,
  buildInsightsSourceChip,
  resolveInsightsRouteBase,
} from "./insights-shell-exact-adapter";

const CONNECTED = { canRead: true, block: null } as const;
const OFF = { canRead: false, block: "not_connected" } as const;

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
        canRead: false,
        block: "connection_fault",
      }),
    ).toMatchObject({ stateLabel: "action required", tone: "warning" });
  });

  it("names the setup step instead of claiming connected or not connected", () => {
    // E5: a source that is connected but cannot serve a read gets neither the
    // green claim nor the "not connected" one — both would misdirect. Every
    // blocked state names the operator's actual next move.
    expect(
      buildInsightsSourceChip("search_console", {
        canRead: false,
        block: "google_reconnect_required",
      }),
    ).toMatchObject({ stateLabel: "reconnect Google", tone: "warning" });
    expect(
      buildInsightsSourceChip("ga4", {
        canRead: false,
        block: "property_not_selected",
      }),
    ).toMatchObject({ stateLabel: "select property", tone: "warning" });
    expect(
      buildInsightsSourceChip("search_console", {
        canRead: false,
        block: "site_not_selected",
      }),
    ).toMatchObject({ stateLabel: "select site", tone: "warning" });
  });

  it("says the status is unread rather than claiming the source is down", () => {
    // WP-21: before the integration manifest is read, the store holds defaults
    // that would derive as "disconnected" for every provider. Unknown and down
    // are different facts and must read differently.
    expect(buildInsightsSourceChip("ga4", OFF, false)).toMatchObject({
      stateLabel: "reading status",
      tone: "neutral",
    });
    expect(buildInsightsSourceChip("ga4", CONNECTED, false).stateLabel).toBe(
      "reading status",
    );
    expect(
      buildInsightsShellExactModel({
        pathname: "/insights/analytics",
        ga4: CONNECTED,
        searchConsole: OFF,
        authorityRead: false,
      }).sources.map((source) => source.stateLabel),
    ).toEqual(["reading status", "reading status"]);
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
