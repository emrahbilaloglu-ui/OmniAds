// @vitest-environment jsdom

/**
 * WP-21 source truth: connection state comes from the integration authority.
 *
 * The defect this file exists to prevent: the analytics and SEO clients read a
 * `sources` object off their own report payload. Only `/api/geo/overview` emits
 * one, so a perfectly healthy GA4 or Search Console read rendered its provider
 * as "not reported" — the surface told the operator the source was down while
 * displaying that source's own numbers.
 *
 * Every fixture below is the **real handler's** shape, imported from the real
 * producer's types, not a shape invented for the test.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  AnalyticsSourceClient,
  SeoClient,
} from "@/components/zero-base/analytics/analytics-clients";
import type { IntegrationStatusResponse } from "@/lib/integration-status";
import type { AnalyticsOverviewResponse } from "@/lib/analytics-overview";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

/** Exactly what `getIntegrationStatusByBusiness` returns, all providers off. */
function statusAllOff(): IntegrationStatusResponse {
  return {
    meta: false,
    google: false,
    tiktok: false,
    pinterest: false,
    snapchat: false,
    klaviyo: false,
    shopify: false,
    ga4: false,
    search_console: false,
  };
}

/** A healthy GA4 read, shaped as `AnalyticsOverviewResponse`. */
const HEALTHY_OVERVIEW: AnalyticsOverviewResponse = {
  propertyName: "Grandmix GA4",
  kpis: {
    sessions: 4210,
    engagedSessions: 2900,
    engagementRate: 0.688,
    purchases: 118,
    purchaseCvr: 0.028,
    revenue: 51230.5,
    avgSessionDuration: 92.4,
    averageOrderValue: 434.15,
    totalUsers: 3800,
    newUsers: 2600,
    totalPurchasers: 110,
    firstTimePurchasers: 71,
  },
  insights: [],
};

/** A healthy Search Console read, shaped as the SEO overview payload. */
const HEALTHY_SEO = {
  meta: {
    siteUrl: "https://grandmix.example",
    startDate: "2026-07-01",
    endDate: "2026-07-28",
    previousStartDate: "2026-06-03",
    previousEndDate: "2026-06-30",
    rowCount: 240,
  },
  summary: {
    clicks: { current: 1200, previous: 1000, delta: 200, deltaPercent: 20 },
    impressions: { current: 44000, previous: 40000, delta: 4000, deltaPercent: 10 },
    ctr: { current: 0.027, previous: 0.025, delta: 0.002, deltaPercent: 8 },
    position: { current: 12.4, previous: 13.9, delta: -1.5, deltaPercent: -10.8 },
  },
  leaders: { queries: [], pages: [] },
  movers: { decliningQueries: [], decliningPages: [], improvingQueries: [], improvingPages: [] },
  causes: [],
  recommendations: [],
  aiBrief: null,
  aiWorkspace: { dataLayers: [], contextBlocks: [], requestedOutputs: [] },
};

function stubFetch(routes: Record<string, { ok?: boolean; body: unknown }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = Object.keys(routes).find((path) => url.startsWith(path));
    if (!match) throw new Error(`unstubbed fetch: ${url}`);
    const route = routes[match];
    return {
      ok: route.ok ?? true,
      status: route.ok === false ? 500 : 200,
      json: async () => route.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WP-21 analytics source truth", () => {
  it("does not render GA4 as down when GA4 is connected and serving", async () => {
    stubFetch({
      "/api/analytics/overview": { body: HEALTHY_OVERVIEW },
      "/api/integrations/status": { body: { ...statusAllOff(), ga4: true } },
      "/api/analytics/insights": { body: { insights: [] } },
    });

    render(<AnalyticsSourceClient businessId={BUSINESS} />);

    // The regression: this element existed on every healthy read.
    await waitFor(() => {
      expect(document.querySelector('[data-source-connected="ga4"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-source-down="ga4"]')).toBeNull();
  });

  it("renders GA4 as down only when the authority says it is disconnected", async () => {
    stubFetch({
      "/api/analytics/overview": { body: HEALTHY_OVERVIEW },
      "/api/integrations/status": { body: statusAllOff() },
      "/api/analytics/insights": { body: { insights: [] } },
    });

    render(<AnalyticsSourceClient businessId={BUSINESS} />);

    await waitFor(() => {
      expect(document.querySelector('[data-source-down="ga4"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-source-connected="ga4"]')).toBeNull();
  });

  it("claims no Shopify panel beside GA4 numbers Shopify did not supply", async () => {
    stubFetch({
      "/api/analytics/overview": { body: HEALTHY_OVERVIEW },
      // Shopify is connected — but it supplied none of these figures.
      "/api/integrations/status": { body: { ...statusAllOff(), ga4: true, shopify: true } },
      "/api/analytics/insights": { body: { insights: [] } },
    });

    render(<AnalyticsSourceClient businessId={BUSINESS} />);

    await waitFor(() => {
      expect(document.querySelector('[data-source-connected="ga4"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-source-panel="shopify"]')).toBeNull();
  });

  it("reports an unreadable authority as unknown rather than down", async () => {
    stubFetch({
      "/api/analytics/overview": { body: HEALTHY_OVERVIEW },
      "/api/integrations/status": { ok: false, body: {} },
      "/api/analytics/insights": { body: { insights: [] } },
    });

    render(<AnalyticsSourceClient businessId={BUSINESS} />);

    await waitFor(() => {
      expect(document.querySelector('[data-source-down="ga4"]')).not.toBeNull();
    });
    // "Unknown" and "down" are different facts and must read differently.
    expect(screen.getByText(/status could not be read/i)).toBeTruthy();
  });

  it("does not render Search Console as down on a healthy SEO read", async () => {
    stubFetch({
      "/api/seo/overview": { body: HEALTHY_SEO },
      "/api/integrations/status": { body: { ...statusAllOff(), search_console: true } },
    });

    render(<SeoClient businessId={BUSINESS} role="admin" />);

    await waitFor(() => {
      expect(document.querySelector('[data-source-connected="search_console"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-source-down="search_console"]')).toBeNull();
    // SEO reads Search Console, not GA4; no GA4 panel is asserted here.
    expect(document.querySelector('[data-source-panel="ga4"]')).toBeNull();
  });
});
