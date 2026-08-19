import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  getPresetDatesForReferenceDate,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import { buildCreativeStudioTabHrefs as sharedTabHrefBuilder } from "@/lib/meta/creative-studio-tab-hrefs";
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

/**
 * Mirrors the page's own window resolution (dashboard preset "28d" resolves to
 * a custom window on the account's reference day) so a seeded creatives query
 * lands on the exact key the page reads.
 */
function studioWindow(timeZone: string) {
  return getPresetDatesForReferenceDate(
    "28d",
    getTodayIsoForTimeZone(timeZone),
    "",
    "",
  );
}

function headerButtonMarkup(html: string, label: string): string {
  return html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? "";
}

function renderPage(input: {
  pageProps?: React.ComponentProps<typeof CreativesPage>;
  businessId?: string;
  providerAccounts?: Array<{ id: string; timezone?: string; currency?: string }>;
  creativeApiRows?: Array<Record<string, unknown>>;
  /** Envelope fields beside `rows` — status, isPartial, observed-at. */
  creativeEnvelope?: Record<string, unknown>;
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
  if (input.businessId && input.providerAccounts?.length === 1 && input.creativeApiRows) {
    const account = input.providerAccounts[0]!;
    const { start, end } = studioWindow(account.timezone || "UTC");
    client.setQueryData(
      ["meta-creative-studio", input.businessId, account.id, start, end, "creative"],
      { ...(input.creativeEnvelope ?? {}), rows: input.creativeApiRows },
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

  it("keeps Export CSV disabled until the Assets tab has rows the export can write", () => {
    const whileLoading = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
    });

    expect(whileLoading).toContain("Loading creative assets.");
    expect(headerButtonMarkup(whileLoading, "Export CSV")).toContain("disabled");

    const withoutRows = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
      creativeApiRows: [],
    });

    expect(withoutRows).toContain("No creative assets were served for this window.");
    expect(headerButtonMarkup(withoutRows, "Export CSV")).toContain("disabled");

    const withRows = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
      creativeApiRows: [
        {
          id: "creative_1",
          creative_id: "creative_1",
          account_id: "act_1",
          name: "Served asset",
          spend: 100,
        },
      ],
    });

    expect(withRows).toContain("Served asset");
    expect(headerButtonMarkup(withRows, "Export CSV")).not.toContain("disabled");
  });
});

describe("Creative Studio Assets: a 200 with no rows is not automatically empty", () => {
  /**
   * WHY: `/api/meta/creatives` answers HTTP 200 with `rows: []` for
   * `no_connection`, `no_access_token` and `no_accounts_assigned` — verdicts
   * that mean no read was attempted at all (lib/meta/creatives-api.ts returns
   * them before the provider is ever called, and
   * `accountScopeHttpStatus` leaves them at 200). This surface counted rows and
   * nothing else, so all three printed "No creative assets were served for this
   * window.": a definite statement about the operator's Meta account, produced
   * by a read that never happened. An operator can cut a creative on that.
   */
  it.each([
    [
      "no_connection",
      "This business has no connected Meta account, so no creative data was read.",
    ],
    [
      "no_access_token",
      "The Meta connection has no usable access token, so no creative data was read.",
    ],
    [
      "no_accounts_assigned",
      "No Meta ad account is assigned to this business, so no creative data was read.",
    ],
  ])("reports %s as unavailable rather than an empty window", (status, message) => {
    const html = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
      creativeApiRows: [],
      creativeEnvelope: { status },
    });

    expect(html).toContain(`data-assets-state="unavailable"`);
    expect(html).toContain(`data-assets-source-status="${status}"`);
    expect(html).toContain(message);
    expect(html).not.toContain("No creative assets were served for this window.");
    // A count is only a count when a read produced one.
    expect(html).toContain("— synced · Meta");
  });

  /**
   * WHY: the distinction only means something if the true-empty case still
   * reads as empty. `status: "ok"` with no rows is the account genuinely
   * serving nothing, and must keep saying so.
   */
  it("still calls a served-but-empty window empty", () => {
    const html = renderPage({
      businessId: "biz_1",
      providerAccounts: [{ id: "act_1", timezone: "UTC", currency: "USD" }],
      creativeApiRows: [],
      creativeEnvelope: { status: "ok" },
    });

    expect(html).toContain(`data-assets-state="empty"`);
    expect(html).toContain("No creative assets were served for this window.");
    expect(html).toContain("0 synced · Meta");
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

  /**
   * WHY: availability used to be all-or-nothing for the whole row, so one
   * absent field withheld every number the payload did carry — a real measured
   * spend disappeared because, say, `frequency` never arrived. Availability is
   * per metric now, and a served 0 is a measurement that must survive: a
   * paused, never-delivered creative really did spend nothing.
   */
  it("withholds only the metrics the producer did not serve", () => {
    const [row] = toCreativeStudioAssetRows(
      [
        creativeRow({
          observedMetrics: {
            spend: 0,
            impressions: 0,
            clicks: 0,
            purchases: 0,
            purchaseValue: 0,
            // Never served by this payload.
            thumbstop: null,
            frequency: null,
          },
        }),
      ],
      "TRY",
    );

    expect(row?.metrics).toMatchObject({
      spend: 0,
      impressions: 0,
      clicks: 0,
      purchases: 0,
      thumbstop: null,
      frequency: null,
    });
  });

  /**
   * WHY: `normalizeCreativeMetricFields` (lib/meta/creatives-service-support.ts)
   * ends every ratio with `: 0`, so a creative that spent ₺33,500 and bought
   * nothing published `cpa: 0`. CPA is a lower-is-better column, so the heat
   * ramp painted that row as the account's cost-per-purchase *leader* — 63 of
   * 107 rows on a live account did exactly this. Zero purchases does not make
   * acquisition free; it makes cost per acquisition undefined, which is an em
   * dash. The spend beside it is real and must stay.
   */
  it("withholds a ratio whose denominator was measured as zero", () => {
    const [row] = toCreativeStudioAssetRows(
      [
        creativeRow({
          spend: 33_500,
          purchases: 0,
          purchaseValue: 0,
          impressions: 0,
          clicks: 0,
          linkClicks: 0,
          addToCart: 0,
          roas: 0,
          cpa: 0,
          cpm: 0,
          linkCtr: 0,
          thumbstop: 0,
          clickToAddToCart: 0,
          clickToPurchase: 0,
        }),
      ],
      "TRY",
    );

    expect(row?.metrics).toMatchObject({
      spend: 33_500,
      purchases: 0,
      impressions: 0,
      cpa: null,
      aov: null,
      cpm: null,
      ctr: null,
      thumbstop: null,
      atcRate: null,
      cvr: null,
      roas: 0,
    });
  });

  /**
   * ITEM 17 — this page mints its tab links with the SHARED builder, and the
   * link now states the window in both live spellings.
   *
   * The assertion moved rather than being deleted: `buildCreativeStudioTabHrefs`
   * lives in `lib/meta/creative-studio-tab-hrefs.ts` and is exhaustively pinned
   * by `lib/meta/creative-studio-tab-hrefs.test.ts` (route family, business
   * placement, all five tabs, both spellings, `window=custom`, and the half /
   * malformed pair that carries no window at all). What this test keeps is the
   * fact that matters HERE: Assets re-exports and uses that one builder, so it
   * cannot drift back into a private link format while Landers and Audiences
   * use another.
   *
   * `?startDate`/`?endDate` is the shell's spelling and `?start`/`?end` is the
   * Studio's older one; both are written from one resolved pair, and `window` is
   * `custom` because the exact dates ARE the window — naming a rolling preset
   * would let the destination re-expand it against its own clock and measure
   * different days from the surface the operator just left.
   */
  it("mints tab links with the shared builder, carrying scope and window", () => {
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
      "/c/biz%2F1/creative/copies?providerAccountId=act_1&window=custom" +
        "&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/app/creative/performance",
      }).inbox,
    ).toBe(
      "/app/creative/inbox?providerAccountId=act_1&window=custom" +
        "&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
    expect(
      buildCreativeStudioTabHrefs({
        ...scope,
        pathname: "/platforms/meta/creatives",
      }).audiences,
    ).toBe(
      "/platforms/meta/audiences?businessId=biz%2F1&providerAccountId=act_1" +
        "&window=custom&startDate=2026-07-01&endDate=2026-07-28" +
        "&start=2026-07-01&end=2026-07-28",
    );
    // The page's export and the shared module are the same function, not two
    // copies that happen to agree today.
    expect(buildCreativeStudioTabHrefs).toBe(sharedTabHrefBuilder);
  });
});
