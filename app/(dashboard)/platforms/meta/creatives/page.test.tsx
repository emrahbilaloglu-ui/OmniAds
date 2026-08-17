import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import CreativesPage, {
  buildCreativeStudioTabHrefs,
  toCreativeStudioAssetRows,
} from "./legacy-page";

const navigation = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "biz_1",
      businesses: [{ id: "biz_1", name: "Nordventure", currency: "EUR" }],
    }),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "28d",
      customStart: "",
      customEnd: "",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/lib/pricing/usePlan", () => ({
  usePlanState: () => ({ plan: "growth", isLoading: false, isReady: true }),
}));

function renderPage(input: {
  pageProps?: React.ComponentProps<typeof CreativesPage>;
  businessId?: string;
  providerAccounts?: Array<{ id: string; timezone?: string; currency?: string }>;
} = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  if (input.businessId && input.providerAccounts) {
    client.setQueryData(
      ["meta-provider-accounts", input.businessId],
      input.providerAccounts,
    );
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CreativesPage {...input.pageProps} />
    </QueryClientProvider>,
  );
}

function creativeRow(overrides: Partial<MetaCreativeRow> = {}): MetaCreativeRow {
  return {
    id: "creative_1",
    creativeId: "creative_1",
    name: "Served asset",
    creativePrimaryLabel: "Video",
    creativeTypeLabel: "Video",
    creativeVisualFormat: "vertical",
    effectiveStatus: "ACTIVE",
    aiTags: { messagingAngle: ["Problem aware", "Offer-led"] },
    currency: null,
    metricsAvailability: "available",
    spend: 100,
    purchaseValue: 400,
    purchases: 4,
    impressions: 1_000,
    clicks: 50,
    linkClicks: 40,
    addToCart: 8,
    roas: 4,
    cpa: 25,
    cpm: 10,
    linkCtr: 4,
    thumbstop: 32,
    frequency: 2.1,
    clickToAddToCart: 20,
    clickToPurchase: 10,
    video100: 91,
    tableThumbnailUrl: null,
    cachedThumbnailUrl: null,
    thumbnailUrl: null,
    imageUrl: null,
    cardPreviewUrl: null,
    previewUrl: null,
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    format: "video",
    ...overrides,
  } as MetaCreativeRow;
}

afterEach(() => {
  navigation.pathname = "/platforms/meta/creatives";
  navigation.search = "";
});

describe("/platforms/meta/creatives page", () => {
  it("renders the exact Assets surface without the legacy Studio OS controls", () => {
    const html = renderPage();

    expect(html).toContain("data-testid=\"creative-studio-page\"");
    expect(html).toContain("data-creative-studio-exact=\"true\"");
    expect(html).toContain("data-creative-studio-exact-section=\"assets\"");
    expect(html).toContain("Creative Studio");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Share with client");
    expect(html).toContain('data-responsive-studio="true"');
    expect(html).toContain('data-provider-writes="none"');
    expect(html).not.toContain("data-testid=\"creative-studio-os\"");
    expect(html).not.toContain('aria-label="Primary"');
    expect(html).not.toContain("data-studio-nav-rail");
    expect(html).not.toContain("Business STOP");
    expect(html).not.toContain(">More<");
    expect(html).not.toContain(">Winners<");
    expect(html).not.toContain(">Briefs<");
    expect(html).not.toContain(">Shares<");
    expect(html).not.toContain("creatives-briefing-page");
  });

  it("does not let URL/store state override an explicit server scope with no account", () => {
    navigation.search = "providerAccountId=url_account";

    const html = renderPage({
      pageProps: { businessId: "server_biz", providerAccountId: null },
      businessId: "server_biz",
      providerAccounts: [
        { id: "server_account", timezone: "UTC", currency: "USD" },
      ],
    });

    expect(html).toContain(
      "Select one assigned Meta ad account. Assets remain withheld until the provider scope is explicit.",
    );
    expect(html).not.toContain("server_account");
    expect(html).not.toContain("url_account");
  });

  it("keeps an explicit server account authoritative over the URL account", () => {
    navigation.search = "providerAccountId=url_account";

    const html = renderPage({
      pageProps: {
        businessId: "server_biz",
        providerAccountId: "server_account",
      },
      businessId: "server_biz",
      providerAccounts: [
        { id: "server_account", timezone: "UTC", currency: "USD" },
      ],
    });

    expect(html).toContain("providerAccountId=server_account");
    expect(html).not.toContain("providerAccountId=url_account");
  });

  it("does not silently select the first account when the legacy scope has multiple assignments", () => {
    const html = renderPage({
      businessId: "biz_1",
      providerAccounts: [
        { id: "act_1", timezone: "UTC", currency: "USD" },
        { id: "act_2", timezone: "UTC", currency: "USD" },
      ],
    });

    expect(html).toContain(
      "Select one assigned Meta ad account. Assets remain withheld until the provider scope is explicit.",
    );
  });
});

describe("Creative Studio Assets projection", () => {
  it("withholds every number when metrics are unavailable and uses only server-owned labels", () => {
    const [row] = toCreativeStudioAssetRows(
      [
        creativeRow({
          metricsAvailability: "unavailable",
          spend: 999,
          roas: 9,
          effectiveStatus: "WITH_ISSUES",
          aiTags: { messagingAngle: [" Server angle ", "Second angle"] },
          currency: null,
        }),
      ],
      "EUR",
    );

    expect(Object.values(row!.metrics).every((value) => value === null)).toBe(true);
    expect(row).toMatchObject({
      status: "WITH_ISSUES",
      marketingAngle: "Server angle, Second angle",
      currency: "EUR",
    });
  });

  it("never substitutes a video metric for Hold", () => {
    const [row] = toCreativeStudioAssetRows(
      [creativeRow({ video100: 99, thumbstop: 44 })],
      "USD",
    );

    expect(row?.metrics).toMatchObject({
      spend: 100,
      aov: 100,
      ctr: 4,
      thumbstop: 44,
      hold: null,
      atcRate: 20,
      cvr: 10,
    });
  });

  it("keeps tab navigation inside the current route family and scope window", () => {
    const scope = {
      businessId: "biz/1",
      providerAccountId: "act_1",
      start: "2026-07-01",
      end: "2026-07-28",
    };

    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/c/biz%2F1/creative/performance",
      }).copies,
    ).toBe(
      "/c/biz%2F1/creative/copies?providerAccountId=act_1&start=2026-07-01&end=2026-07-28",
    );
    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/app/creative/performance",
      }).inbox,
    ).toBe(
      "/app/creative/inbox?providerAccountId=act_1&start=2026-07-01&end=2026-07-28",
    );
    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/platforms/meta/creatives",
      }).audiences,
    ).toBe(
      "/platforms/meta/audiences?businessId=biz%2F1&providerAccountId=act_1&start=2026-07-01&end=2026-07-28",
    );
  });
});
