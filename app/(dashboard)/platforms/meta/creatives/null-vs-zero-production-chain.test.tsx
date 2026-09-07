// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CreativeStudioPage from "@/app/(dashboard)/platforms/meta/creatives/legacy-page";
import { mapApiRowToUiRow } from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import { buildMetaCreativeApiRow } from "@/lib/meta/creatives-service-support";
import { groupRows } from "@/lib/meta/creatives-row-mappers";
import {
  buildCreativeUsageMap,
  buildFallbackAdRawRow,
  coerceRawCreativeRow,
  hydrateWarehouseCreativeMetrics,
} from "@/lib/meta/creatives-warehouse";
import type {
  MetaCreativeApiRow,
  RawCreativeRow,
} from "@/lib/meta/creatives-types";
import type {
  MetaAdDailyRow,
  MetaCreativeDailyRow,
} from "@/lib/meta/warehouse-types";

/**
 * The null-versus-zero contract, proven along the PRODUCTION chain.
 *
 * Deliberately not a UI fixture. Handing a hand-written `observedMetrics` map to
 * `toCreativeStudioAssetRows` proves only that the renderer can read a map — it
 * cannot detect the defect this file exists for, which is that the information
 * was already destroyed several layers upstream. `normalizeCreativeMetricFields`
 * and `buildMetaCreativeApiRow` coerce every economic field with `?? 0` / `: 0`,
 * so by the time a row is on the wire an unread `add_to_cart` and a measured
 * `add_to_cart: 0` are the identical number, and no reader downstream can
 * separate them. A test that starts after that point can only ever pass.
 *
 * So each case here starts at the RAW NULLABLE SOURCE — a `MetaAdDailyRow`
 * exactly as `getMetaAdDailyRange` returns it, nullable columns and all — and
 * runs the real functions in the real order that
 * `getMetaCreativesWarehousePayload` runs them:
 *
 *   MetaAdDailyRow (null-bearing)
 *     -> coerceRawCreativeRow / buildFallbackAdRawRow   (warehouse mapping)
 *     -> hydrateWarehouseCreativeMetrics                (fact overlay)
 *     -> groupRows                                      (aggregation)
 *     -> buildMetaCreativeApiRow                        (the coercion itself)
 *     -> mapApiRowToUiRow                               (page adapter)
 *     -> the rendered Creative Studio Assets table      (the exact cell)
 *
 * The last leg renders the real page, so the assertions are on cell text a
 * person would actually read, not on an intermediate object.
 */

const navigation = vi.hoisted(() => ({
  pathname: "/platforms/meta/creatives",
  search: "",
}));

const queryState = vi.hoisted(() => ({
  accounts: [
    { id: "act_9", name: "Main", timezone: "UTC", currency: "USD" },
  ] as unknown,
  creatives: undefined as unknown,
  briefing: undefined as unknown,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectedBusinessId: "biz_1", businesses: [] }),
}));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: vi.fn(),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "custom",
      customStart: "2026-07-21",
      customEnd: "2026-08-17",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const useQueryMock = vi.mocked(useQuery);

const PROVIDER_ACCOUNT_ID = "act_9";

/**
 * A `meta_ad_daily` row as the production reader hands it over.
 *
 * The defaults mirror the real column nullability: `spend`, `impressions`,
 * `clicks`, `conversions` and `revenue` are NOT NULL columns, so they arrive as
 * numbers and a zero there is a measurement. Everything typed `| null` here is
 * genuinely nullable at the source — `link_clicks` as a column, the funnel
 * counters as `payload_json` keys that `payloadMetricNumber` resolves to null
 * when the sync never captured them.
 */
function adDailyRow(overrides: Partial<MetaAdDailyRow> = {}): MetaAdDailyRow {
  return {
    businessId: "biz_1",
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date: "2026-08-17",
    campaignId: "c_1",
    adsetId: "as_1",
    adId: "ad_1",
    adNameCurrent: "Chain probe",
    adNameHistorical: null,
    adStatus: "ACTIVE",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    spend: 0,
    impressions: 0,
    clicks: 0,
    reach: 0,
    frequency: null,
    conversions: 0,
    revenue: 0,
    roas: 0,
    cpa: null,
    ctr: null,
    cpc: null,
    linkClicks: null,
    outboundClicks: null,
    landingPageViews: null,
    addToCart: null,
    initiateCheckout: null,
    viewContent: null,
    leads: null,
    postEngagement: null,
    thruplayActions: null,
    videoViews3s: null,
    payloadJson: null,
    ...overrides,
  } as MetaAdDailyRow;
}

/**
 * The exact warehouse sequence from `getMetaCreativesWarehousePayload`.
 *
 * Every step is the production function, imported, in production order. If a
 * future change moves the coercion or drops the sidecar between two of these
 * steps, this collapses rather than quietly still passing.
 */
function buildApiRowsFromWarehouse(input: {
  factRows: MetaAdDailyRow[];
  projectionJson?: unknown;
}): MetaCreativeApiRow[] {
  const rawRows = input.factRows.reduce<RawCreativeRow[]>((acc, factRow) => {
    const projectionRow =
      coerceRawCreativeRow(input.projectionJson) ??
      buildFallbackAdRawRow({
        factRow,
        projectionJson: input.projectionJson,
        creativeId: null,
      });
    acc.push(hydrateWarehouseCreativeMetrics({ row: projectionRow, factRow }));
    return acc;
  }, []);

  const grouped = groupRows(
    rawRows,
    "creative",
    buildCreativeUsageMap(rawRows),
  );
  return grouped.map((row) =>
    buildMetaCreativeApiRow({
      row,
      cachedThumbnailUrl: null,
      cardFallbackThumbnailUrl: null,
      includeDebugFields: false,
    }),
  );
}

function renderStudio(rows: MetaCreativeApiRow[]) {
  queryState.creatives = { status: "ok", rows, warehouse_observed_at: null };
  render(
    <CreativeStudioPage
      businessId="biz_1"
      providerAccountId={PROVIDER_ACCOUNT_ID}
    />,
  );
}

/**
 * One cell of the single rendered creative row, found by its column header.
 *
 * By header rather than by index because the visible column set is chosen by
 * the operator and its ORDER is `METRICS` order, not preset order — an index
 * would silently start asserting a different metric the moment a column is
 * added.
 */
function metricCell(header: string): string {
  const headers = Array.from(document.querySelectorAll("thead th")).map(
    (cell) => cell.textContent?.trim() ?? "",
  );
  // A header carries two glyphs that are not part of its name: the metric's
  // "lower is better" arrow ("CPA ↓") and, on whichever column the table is
  // sorted by, the active sort indicator ("Spend▼"). Strip both and match the
  // label, so adding or moving a sort cannot silently make this helper assert
  // a different column.
  const index = headers.findIndex(
    (text) => text.replace(/[▲▼↑↓]/g, "").trim() === header,
  );
  expect(index, `no "${header}" column is on screen`).toBeGreaterThan(-1);
  const row = document.querySelector("[data-creative-studio-asset-row]");
  expect(row, "the Assets table rendered no creative row").not.toBeNull();
  return (
    Array.from(row!.querySelectorAll("td"))[index]?.textContent?.trim() ?? ""
  );
}

function expectMetricColumnHidden(header: string) {
  const headers = Array.from(document.querySelectorAll("thead th")).map(
    (cell) => (cell.textContent?.trim() ?? "").replace(/[▲▼↑↓]/g, "").trim(),
  );
  expect(
    headers,
    `${header} should be omitted when every row withholds it`,
  ).not.toContain(header);
}

/** Switch the table to a named column set. A real operator click. */
function showColumns(set: "Performance" | "Engagement" | "Funnel") {
  fireEvent.click(screen.getByRole("button", { name: set }));
}

/**
 * Every metric column currently on screen, as header -> cell text.
 *
 * `metricCell` answers about ONE named column, which is the right shape for
 * "did this cell withhold the right number". The permanent-em-dash law asks the
 * opposite question — "is ANY column on screen blank" — and naming the columns
 * it expects would make it blind to the next one added.
 */
function visibleMetricCells(): Map<string, string> {
  const headers = Array.from(document.querySelectorAll("thead th"))
    .map((cell) => (cell.textContent ?? "").replace(/[▲▼]/g, "").trim())
    .slice(4, -1);
  const row = document.querySelector("[data-creative-studio-asset-row]");
  expect(row, "the Assets table rendered no creative row").not.toBeNull();
  const cells = Array.from(row!.querySelectorAll("td"))
    .map((cell) => cell.textContent?.trim() ?? "")
    .slice(4, -1);
  expect(cells).toHaveLength(headers.length);
  return new Map(headers.map((header, index) => [header, cells[index] ?? ""]));
}

/**
 * Opt one catalogue metric into the visible columns, through the picker.
 *
 * Needed because `thumbstop` is no longer in ANY preset: the warehouse producer
 * stamps it unavailable on the grain this table reads, so it may not be a
 * default column. It stays in the catalogue because the live path serves a real
 * rate for it, and an operator who ticks it is choosing it knowingly — which is
 * what this helper reproduces. The em-dash assertions that follow are therefore
 * still about the shipped cell, just no longer about a column the operator was
 * handed.
 */
function showCatalogueMetric(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "+ Edit metrics" }));
  const picker = document.querySelector("[data-creative-studio-metric-picker]");
  expect(picker, "the metric picker did not open").not.toBeNull();
  const option = Array.from(
    picker!.querySelectorAll("button[aria-pressed]"),
  ).find(
    (button) => button.textContent?.replace(/[✓↑↓]/g, "").trim() === label,
  );
  expect(option, `"${label}" is not in the metric picker`).toBeTruthy();
  fireEvent.click(option!);
  fireEvent.click(screen.getByRole("button", { name: "Close metric picker" }));
}

beforeEach(() => {
  navigation.pathname = "/platforms/meta/creatives";
  navigation.search = "";
  queryState.accounts = [
    { id: PROVIDER_ACCOUNT_ID, name: "Main", timezone: "UTC", currency: "USD" },
  ];
  queryState.creatives = undefined;
  queryState.briefing = undefined;
  useQueryMock.mockReset();
  useQueryMock.mockImplementation(
    (options: { queryKey?: readonly unknown[] }) => {
      const key = options.queryKey?.[0];
      const data =
        key === "meta-provider-accounts"
          ? queryState.accounts
          : key === "meta-creative-studio"
            ? queryState.creatives
            : queryState.briefing;
      return {
        data,
        error: null,
        fetchStatus: "idle",
        isError: false,
        isFetching: false,
        isLoading: false,
        refetch: vi.fn(),
        status: data ? "success" : "pending",
      } as unknown as ReturnType<typeof useQuery>;
    },
  );
});

afterEach(() => cleanup());

describe("Creative Studio: null and zero survive the whole producer chain", () => {
  /**
   * WHY: the fix must not become "withhold anything that looks empty". A
   * paused, never-delivered ad genuinely spent nothing and genuinely bought
   * nothing, and those zeros are measurements the operator needs in order to
   * see that the line ran and produced nothing. `meta_ad_daily.spend`,
   * `impressions`, `clicks` and `conversions` are NOT NULL columns, so a row
   * that exists carries them; an em dash over them would hide a fact rather
   * than protect the reader from one.
   */
  it("prints a measured zero as 0, not an em dash", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          linkClicks: 0,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      spend: true,
      impressions: true,
      purchases: true,
      link_clicks: true,
    });
    expect(mapApiRowToUiRow(rows[0]).observedMetrics).toMatchObject({
      spend: 0,
      impressions: 0,
      purchases: 0,
      linkClicks: 0,
    });

    renderStudio(rows);

    expect(metricCell("Spend")).toBe("$0");
    expect(metricCell("Purchases")).toBe("0");
  });

  /**
   * WHY: this is the invented zero the wave is named after. With no stored
   * projection for the ad, `buildFallbackAdRawRow` types `leads: 0`,
   * `messages: 0`, `thumbstop: 0` and the four video quartiles as literals —
   * there is no source behind any of them — and on a live account 99% of
   * `meta_ad_daily` rows also carry no `add_to_cart` / `landing_page_views` /
   * `initiate_checkout` key in `payload_json`, so those became zeros too. A 0%
   * thumbstop on a video that was never measured is not a weak hook; it is no
   * measurement at all, and the operator cannot tell those apart from the
   * number.
   */
  it("withholds a counter the producer manufactured with no source behind it", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 120,
          impressions: 5_000,
          clicks: 90,
          conversions: 3,
          revenue: 480,
          roas: 4,
          linkClicks: 80,
          // The sync never captured these; `payload_json` has no such keys.
          addToCart: null,
          landingPageViews: null,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      thumbstop: false,
      leads: false,
      video25: false,
      add_to_cart: false,
      landing_page_views: false,
    });
    // The legacy numeric fields are untouched — this is an additive sidecar,
    // not a retyping of the wire.
    expect(rows[0].thumbstop).toBe(0);
    expect(rows[0].add_to_cart).toBe(0);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.thumbstop).toBeNull();
    expect(observed?.addToCart).toBeNull();
    expect(observed?.spend).toBe(120);

    renderStudio(rows);
    showCatalogueMetric("Thumbstop");

    expectMetricColumnHidden("Thumbstop");
    // The measured spend beside it is untouched.
    showColumns("Performance");
    expect(metricCell("Spend")).toBe("$120");
  });

  /**
   * WHY: a ratio is only as defined as its denominator. Every ratio in
   * `normalizeCreativeMetricFields` and `buildMetaCreativeApiRow` ends `: 0`, so
   * a creative that spent real money and bought nothing published `cpa: 0` —
   * and CPA is a lower-is-better column, so the heat ramp painted the account's
   * worst waste as its cost-per-acquisition leader. Zero purchases does not make
   * acquisition free. It makes cost per acquisition undefined. The spend beside
   * it is real and must stay.
   */
  it("withholds a ratio whose denominator was measured as zero, keeping the spend", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 33_500,
          impressions: 900_000,
          clicks: 4_000,
          linkClicks: 3_000,
          conversions: 0,
          revenue: 0,
          roas: 0,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      spend: true,
      cpa: false,
      cpm: true,
    });
    expect(rows[0].cpa).toBe(0);
    expect(mapApiRowToUiRow(rows[0]).observedMetrics?.cpa).toBeNull();

    renderStudio(rows);

    expect(metricCell("Spend")).toBe("$33.5k");
    expectMetricColumnHidden("CPA");
  });

  /**
   * WHY: availability is per field. The old row-level flag withheld every number
   * on a row because one unrelated field was missing, so a real measured spend
   * disappeared behind an absent `leads`. One row, both answers, at the same
   * time.
   */
  it("mixes available and unavailable fields on one row", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 200,
          impressions: 10_000,
          clicks: 300,
          conversions: 5,
          revenue: 900,
          roas: 4.5,
          linkClicks: 250,
          frequency: null,
        }),
      ],
    });

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.spend).toBe(200);
    expect(observed?.impressions).toBe(10_000);
    expect(observed?.cpm).toBe(20);
    expect(observed?.frequency).toBeNull();
    expect(observed?.thumbstop).toBeNull();

    renderStudio(rows);
    showColumns("Engagement");

    // Frequency was NULL at the source; CPM had both operands measured.
    expectMetricColumnHidden("Frequency (daily avg)");
    expect(metricCell("CPM")).toBe("$20.0");
  });

  /**
   * WHY: a stored projection is a real source, and the sidecar must not blank
   * the fields it genuinely carried. This projection has a measured
   * `thumbstop: 41` and no `leads` key at all, and the row must say so
   * separately — otherwise the fix trades one lie for another.
   */
  /**
   * WHY (rewritten, and the law restated): this case used to assert that a
   * stored projection's `thumbstop: 41` is BELIEVED. It is not, and the reason
   * is structural rather than a matter of taste.
   *
   * `meta_ad_dimensions` and `meta_creative_dimensions` are keyed
   * `(business_id, provider_account_id, ad_id | creative_id)` and assign
   * `projection_json = EXCLUDED.projection_json`, so each holds exactly ONE
   * projection per entity — whichever day synced last — while the fact tables
   * hold one row per entity per DAY. `hydrateWarehouseCreativeMetrics` attaches
   * that single projection to every day-row of the window, and `groupRows` then
   * SUMS the fields the fact row does not override. So one day's `leads` is
   * multiplied by the number of days in the window, and one day's `thumbstop`
   * is reported as the window's hook rate. Neither is a measurement of the
   * window being read.
   *
   * The law: on a warehouse grain, a field is available only if the DAY's fact
   * row supplied it, or the projection explicitly DECLARED it available. A
   * projection's number is not a declaration — `buildMetaCreativeApiRow` writes
   * every metric key coalesced, so the number is there either way.
   *
   * The numbers are untouched, as always; only the availability changed.
   */
  it("withholds a projection-only field even when the projection carries a number", () => {
    const projection = {
      id: "ad_1",
      creative_id: "cr_1",
      copy_text: "Stored projection",
      name: "Chain probe",
      account_id: PROVIDER_ACCOUNT_ID,
      currency: "USD",
      launch_date: "2026-08-01",
      tags: [],
      ai_tags: {},
      is_catalog: false,
      preview_state: "unavailable",
      associated_ads_count: 1,
      spend: 0,
      purchase_value: 0,
      roas: 0,
      cpa: 0,
      clicks: 0,
      cpc_link: 0,
      cpm: 0,
      ctr_all: 0,
      purchases: 0,
      impressions: 0,
      link_clicks: 0,
      landing_page_views: 0,
      add_to_cart: 0,
      initiate_checkout: 0,
      thumbstop: 41,
      click_to_atc: 0,
      atc_to_purchase: 0,
      // `leads`, `messages` and the video quartiles are absent on purpose.
    };

    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 500,
          impressions: 40_000,
          clicks: 700,
          conversions: 10,
          revenue: 2_000,
          roas: 4,
          linkClicks: 600,
        }),
      ],
      projectionJson: projection,
    });

    expect(rows[0].metric_presence).toMatchObject({
      // Carried from the single stored projection, not measured for this
      // window's days.
      thumbstop: false,
      // Absent from the projection entirely — unavailable for the older reason
      // as well, and it must not become available now.
      leads: false,
      video25: false,
      // The fields the DAY's fact row actually supplied are untouched.
      spend: true,
      impressions: true,
      link_clicks: true,
    });

    // The legacy number is still on the wire: this is an additive sidecar.
    expect(rows[0].thumbstop).toBe(41);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.thumbstop).toBeNull();
    expect(observed?.leads).toBeNull();
    expect(observed?.spend).toBe(500);

    renderStudio(rows);
    showCatalogueMetric("Thumbstop");

    expectMetricColumnHidden("Thumbstop");
  });

  /**
   * WHY: the aggregate is a SUM. Two days where one never reported add-to-cart
   * do not add up to two days of add-to-cart, and publishing the shortfall as a
   * measurement is the same class of lie as the invented zero. Availability
   * across a group is the intersection, never the union — and the fields both
   * days did supply must survive the intersection intact.
   */
  it("makes a summed field unavailable when one day in the group never supplied it", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          date: "2026-08-16",
          spend: 100,
          impressions: 4_000,
          clicks: 60,
          conversions: 2,
          revenue: 300,
          roas: 3,
          linkClicks: 50,
          addToCart: 12,
        }),
        adDailyRow({
          date: "2026-08-17",
          spend: 140,
          impressions: 5_000,
          clicks: 70,
          conversions: 3,
          revenue: 420,
          roas: 3,
          linkClicks: 60,
          addToCart: null,
        }),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].metric_presence).toMatchObject({
      spend: true,
      link_clicks: true,
      add_to_cart: false,
    });
    // The summed number is still published unchanged; only its availability
    // changed.
    expect(rows[0].add_to_cart).toBe(12);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.spend).toBe(240);
    expect(observed?.addToCart).toBeNull();

    renderStudio(rows);
    showColumns("Funnel");

    // The all-clicks counter is no longer a Funnel column: the ladder is
    // denominated in LINK clicks, and two clicks columns side by side is the
    // ambiguity this pass removed. It is still in the catalogue, so opt it in.
    showCatalogueMetric("Clicks (all)");
    expect(metricCell("Clicks (all)")).toBe("130");
    expectMetricColumnHidden("ATC rate (link clicks)");
    expect(metricCell("Purchases")).toBe("5");
  });

  /**
   * WHY: the sidecar is additive. A producer that publishes no `metric_presence`
   * — the live insights path, where an absent `actions` array means a measured
   * zero rather than an unread field — must keep printing exactly what it prints
   * today. A default of "withhold" would blank every live-served row.
   */
  it("leaves a row that publishes no availability map exactly as it was", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 75,
          impressions: 3_000,
          clicks: 40,
          conversions: 1,
          revenue: 150,
          roas: 2,
          linkClicks: 30,
        }),
      ],
    });
    const withoutSidecar = { ...rows[0] };
    delete (withoutSidecar as { metric_presence?: unknown }).metric_presence;

    const observed = mapApiRowToUiRow(withoutSidecar).observedMetrics;
    expect(observed?.spend).toBe(75);
    // Present on the wire as 0 and believed, because nothing said otherwise.
    expect(observed?.thumbstop).toBe(0);
    expect(observed?.cpa).toBe(75);
  });
});

/**
 * `meta_ad_daily.link_clicks`, end to end.
 *
 * A SEPARATE block because this column is not like the funnel counters beside
 * it. Measured against production on 2026-08-19: 315,289 rows, 192,464 of them
 * exactly 0 and 122,825 positive. The column genuinely CARRIES measurements —
 * which is what makes its zeros dangerous rather than merely empty. `reach` on
 * `meta_breakdown_daily` was never fetched at all, so every stored 0 there was
 * fabricated and could be widened without a second thought. Here a 0 may be
 * either thing, and only the writer knows which; once written, no reader can
 * separate them.
 *
 * Three cells on the Assets table divide by this column — CTR, ATC rate and
 * CVR (`toCreativeStudioAssetRows` in `legacy-page.tsx` passes `linkClicks` as
 * the denominator to `ratioWithDenominator` for all three) — so a fabricated
 * zero does not just misreport link clicks, it decides what those three
 * columns say.
 *
 * The four cases the contract needs, and all four run the production chain from
 * a `MetaAdDailyRow` to the rendered cell:
 *   1. a MEASURED zero stays 0 and is published available;
 *   2. an UNSUPPLIED field is published unavailable and renders an em dash;
 *   3. a POSITIVE value survives and its ratios compute;
 *   4. a ratio whose denominator is absent is an em dash — never 0, never
 *      Infinity, and never the total-click count substituted in its place.
 */
describe("Creative Studio: link_clicks separates a measured zero from an unsupplied field", () => {
  /**
   * WHY: this is the case that forbids "withhold anything that looks empty".
   * An ad can deliver impressions and earn no link clicks; that is a fact about
   * the creative and the operator needs to read it as 0. The three ratios built
   * on it are still em dashes — not because the field is unavailable, but
   * because a share of zero clicks is undefined arithmetic. The two reasons
   * produce the same glyph and must not be conflated: `metric_presence` says
   * available, `ratioWithDenominator` says undefined.
   */
  it("prints a measured zero of link clicks as 0 and its ratios as em dashes", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 44,
          impressions: 9_000,
          clicks: 12,
          conversions: 0,
          revenue: 0,
          roas: 0,
          // Supplied by the provider, and it said zero.
          linkClicks: 0,
          addToCart: 0,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      link_clicks: true,
      add_to_cart: true,
      // A ratio over a zero denominator is undefined, so the sidecar withholds
      // it even though both operands are available.
      ctr_all: true,
      cpc_link: false,
      click_to_atc: false,
    });
    expect(rows[0].link_clicks).toBe(0);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.linkClicks).toBe(0);
    expect(observed?.addToCart).toBe(0);

    renderStudio(rows);
    showColumns("Engagement");
    // CTR is denominated in IMPRESSIONS, not in link clicks. 0 link clicks over
    // 9,000 impressions is a measured 0.00% click-through rate and must print
    // as one — withholding it here would be the opposite error, hiding a real
    // finding about a creative nobody clicked.
    expect(metricCell("CTR (link)")).toBe("0.00%");
    showColumns("Funnel");
    // ATC rate and CVR ARE denominated in link clicks, and a share of zero
    // clicks is undefined. Same row, same available field, different answer —
    // because the arithmetic is different, not because the source is.
    expectMetricColumnHidden("ATC rate (link clicks)");
    expectMetricColumnHidden("CVR (link clicks)");
    // The all-clicks counter is no longer a Funnel column: the ladder is
    // denominated in LINK clicks, and two clicks columns side by side is the
    // ambiguity this pass removed. It is still in the catalogue, so opt it in.
    showCatalogueMetric("Clicks (all)");
    expect(metricCell("Clicks (all)")).toBe("12");
  });

  /**
   * WHY: the defect this whole change exists for. Before the widening in
   * `lib/migrations.ts` and the `?? null` bind in `lib/meta/warehouse.ts`, this
   * row could not exist — `upsertMetaAdDailyRows` turned the null into a 0 at
   * write time and the distinction was destroyed before any reader saw it.
   *
   * Note what `buildFallbackAdRawRow` does with the null: it substitutes
   * `factRow.clicks` (90 ALL clicks, not link clicks) so the numeric field
   * stays a number. That substitution is exactly the kind of plausible-looking
   * fabrication the sidecar exists to catch, and this asserts BOTH halves — the
   * legacy number is still 90 on the wire, and the operator is shown nothing.
   */
  it("withholds an unsupplied link_clicks and every ratio divided by it", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 260,
          impressions: 40_000,
          clicks: 90,
          conversions: 4,
          revenue: 780,
          roas: 3,
          // The provider supplied no link-click count for this ad-day.
          linkClicks: null,
          // ...while the funnel counters beside it WERE captured, so the row
          // proves availability is per field rather than per row.
          addToCart: 22,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      link_clicks: false,
      add_to_cart: true,
      spend: true,
      // Everything divided by link clicks goes with it.
      ctr_all: false,
      cpc_link: false,
      click_to_atc: false,
    });
    // Additive: the wire keeps the substituted number, unchanged in shape.
    expect(rows[0].link_clicks).toBe(90);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.linkClicks).toBeNull();
    expect(observed?.ctrAll).toBeNull();
    expect(observed?.clickToAddToCart).toBeNull();
    // The measured evidence on the same row is untouched.
    expect(observed?.spend).toBe(260);
    expect(observed?.addToCart).toBe(22);

    renderStudio(rows);
    showColumns("Engagement");
    expectMetricColumnHidden("CTR (link)");
    showColumns("Funnel");
    expectMetricColumnHidden("ATC rate (link clicks)");
    expectMetricColumnHidden("CVR (link clicks)");
    // Not blanked out wholesale: the clicks the provider DID report are there.
    // The all-clicks counter is no longer a Funnel column: the ladder is
    // denominated in LINK clicks, and two clicks columns side by side is the
    // ambiguity this pass removed. It is still in the catalogue, so opt it in.
    showCatalogueMetric("Clicks (all)");
    expect(metricCell("Clicks (all)")).toBe("90");
    showColumns("Performance");
    expect(metricCell("Spend")).toBe("$260");
  });

  /**
   * WHY: the fix must not cost the operator the numbers that are real. A
   * supplied positive value is published available and all three ratios
   * compute, which is what makes the em dashes above meaningful rather than a
   * blanket.
   */
  it("keeps a supplied positive link_clicks and lets its ratios compute", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 500,
          impressions: 20_000,
          clicks: 700,
          conversions: 25,
          revenue: 2_000,
          roas: 4,
          linkClicks: 400,
          addToCart: 100,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      link_clicks: true,
      ctr_all: true,
      cpc_link: true,
      click_to_atc: true,
    });
    expect(rows[0].link_clicks).toBe(400);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.linkClicks).toBe(400);
    // 400 / 20,000 = 2%; 100 / 400 = 25%; 25 / 400 = 6.25%.
    expect(observed?.ctrAll).toBeCloseTo(2, 5);
    expect(observed?.clickToAddToCart).toBeCloseTo(25, 5);

    renderStudio(rows);
    showColumns("Engagement");
    expect(metricCell("CTR (link)")).toBe("2.00%");
    showColumns("Funnel");
    expect(metricCell("ATC rate (link clicks)")).toBe("25.0%");
    expect(metricCell("CVR (link clicks)")).toBe("6.3%");
  });

  /**
   * WHY: the failure mode a null denominator invites is not an em dash, it is
   * `Infinity` or a silent 0. `calculateCreativeClickToAddToCartRate` divides a
   * REAL, measured `add_to_cart` of 22 by a link-click count that does not
   * exist. Neither answer is acceptable: 0 says the clicks did not convert, and
   * Infinity says they all did. The only true answer is "unknown", and it must
   * survive to the cell as an em dash while the numerator itself keeps showing.
   */
  it("renders a ratio with an absent denominator as an em dash, never 0 and never Infinity", () => {
    const rows = buildApiRowsFromWarehouse({
      factRows: [
        adDailyRow({
          spend: 310,
          impressions: 50_000,
          clicks: 120,
          conversions: 6,
          revenue: 900,
          roas: 2.9,
          linkClicks: null,
          addToCart: 22,
        }),
      ],
    });

    const uiRow = mapApiRowToUiRow(rows[0]);
    const observed = uiRow.observedMetrics;
    expect(observed?.clickToAddToCart).toBeNull();
    expect(observed?.clickToAddToCart).not.toBe(0);
    expect(Number.isFinite(observed?.clickToAddToCart as number)).toBe(false);

    renderStudio(rows);
    showColumns("Funnel");
    expectMetricColumnHidden("ATC rate (link clicks)");
    // The measured numerator is still a fact and still on screen.
    expect(mapApiRowToUiRow(rows[0]).observedMetrics?.addToCart).toBe(22);
  });
});

/**
 * THE DEFAULT PRODUCTION GRAIN.
 *
 * Everything above runs `meta_ad_daily` through `buildFallbackAdRawRow`, which
 * is the `groupBy: "ad" | "adName"` branch. The Assets table an operator
 * actually looks at does not use it: `legacy-page.tsx` calls
 * `fetchMetaCreatives({ ..., groupBy: "creative" })`, and inside
 * `getMetaCreativesWarehousePayload` that sets `useCreativeWarehouse = true`,
 * which reads `meta_creative_daily` and pairs each day-row with the ONE stored
 * projection from `meta_creative_dimensions`. Different fact table, different
 * mapper, no fallback row at all — so a sidecar proven only on the ad branch
 * proves nothing about the surface, which is exactly how a measured zero and an
 * unreadable field stayed indistinguishable there.
 *
 * The two shapes that make this grain different, and that the cases below pin:
 *
 *   1. `meta_creative_dimensions` is keyed `(business_id, provider_account_id,
 *      creative_id)` and assigns `projection_json = EXCLUDED.projection_json`,
 *      so it holds ONE projection per creative — the last day that synced —
 *      while `meta_creative_daily` holds one row per creative per DAY. Fields
 *      the fact row does not carry ride in from that single projection and are
 *      then SUMMED by `groupRows` across every day of the window.
 *   2. `projection_json` is itself `buildMetaCreativeApiRow` output, so it
 *      carries EVERY metric key already coalesced to a number. Availability
 *      read off "the key is a finite number" therefore certifies the coalescing
 *      instead of detecting it. On production this is not hypothetical: all
 *      5,678 rows of `meta_creative_dimensions` carry `add_to_cart` and
 *      `thumbstop`, and 0 of them carry `metric_presence`.
 *
 * The chain below is the production one, in production order, starting from a
 * null-bearing `MetaCreativeDailyRow`:
 *
 *   MetaCreativeDailyRow + projection_json
 *     -> coerceRawCreativeRow            (projection mapping, pre-coalescing)
 *     -> hydrateWarehouseCreativeMetrics (fact overlay — the day's real source)
 *     -> groupRows(..., "creative")      (the creative-grain bucket)
 *     -> buildMetaCreativeApiRow         (the coercion itself)
 *     -> mapApiRowToUiRow                (page adapter)
 *     -> the rendered Assets table       (the exact cell)
 *
 * `normalizeCreativeRows` and `overlayCreativeMedia` sit between steps 2 and 3
 * in production and are omitted here only because they are module-private and
 * touch format filtering and preview URLs — never a metric or its availability.
 */
const CREATIVE_ID = "cre_1";

/**
 * A `meta_creative_daily` row as `getMetaCreativeDailyRange` hands it over.
 *
 * Column nullability mirrored exactly: `spend`, `impressions`, `clicks`,
 * `conversions` and `revenue` are NOT NULL, so a zero there is a measurement.
 * `frequency` and `link_clicks` are nullable columns; `landingPageViews`,
 * `addToCart` and `initiateCheckout` are resolved by `payloadMetricNumber` from
 * `payload_json` and come back null when the sync never wrote the key.
 */
function creativeDailyRow(
  overrides: Partial<MetaCreativeDailyRow> = {},
): MetaCreativeDailyRow {
  return {
    businessId: "biz_1",
    providerAccountId: PROVIDER_ACCOUNT_ID,
    date: "2026-08-17",
    campaignId: "c_1",
    adsetId: "as_1",
    adId: "ad_1",
    creativeId: CREATIVE_ID,
    creativeName: "Creative grain probe",
    headline: null,
    primaryText: null,
    descriptionText: null,
    destinationUrl: null,
    thumbnailUrl: null,
    assetType: null,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    spend: 0,
    impressions: 0,
    clicks: 0,
    reach: 0,
    frequency: null,
    conversions: 0,
    revenue: 0,
    roas: 0,
    cpa: null,
    ctr: null,
    cpc: null,
    linkClicks: null,
    outboundClicks: null,
    landingPageViews: null,
    addToCart: null,
    initiateCheckout: null,
    payloadJson: null,
    ...overrides,
  } as MetaCreativeDailyRow;
}

/**
 * A production-vintage `projection_json`: every metric key present as a
 * coalesced number, and no `metric_presence` — the exact shape all 5,678
 * production rows have.
 */
function storedProjection(overrides: Record<string, unknown> = {}) {
  return {
    id: "ad_1",
    creative_id: CREATIVE_ID,
    copy_text: "Creative grain probe",
    name: "Creative grain probe",
    account_id: PROVIDER_ACCOUNT_ID,
    currency: "USD",
    launch_date: "2026-08-01",
    tags: [],
    ai_tags: {},
    copy_variants: [],
    headline_variants: [],
    description_variants: [],
    is_catalog: false,
    preview_state: "unavailable",
    associated_ads_count: 1,
    format: "video",
    creative_type: "feed",
    spend: 0,
    purchase_value: 0,
    roas: 0,
    cpa: 0,
    clicks: 0,
    cpc_link: 0,
    cpm: 0,
    ctr_all: 0,
    purchases: 0,
    impressions: 0,
    link_clicks: 0,
    landing_page_views: 0,
    add_to_cart: 0,
    initiate_checkout: 0,
    thumbstop: 37,
    click_to_atc: 0,
    atc_to_purchase: 0,
    leads: 4,
    messages: 0,
    video25: 22,
    video50: 11,
    video75: 6,
    video100: 3,
    ...overrides,
  };
}

/** The creative branch of `getMetaCreativesWarehousePayload`, verbatim. */
function buildApiRowsFromCreativeWarehouse(input: {
  factRows: MetaCreativeDailyRow[];
  projectionJson?: unknown;
}): MetaCreativeApiRow[] {
  const projectionJson = input.projectionJson ?? storedProjection();
  const rawRows = input.factRows.reduce<RawCreativeRow[]>((acc, factRow) => {
    // The creative branch has NO fallback row: a creative with no stored
    // projection is dropped, never invented.
    const projectionRow = coerceRawCreativeRow(projectionJson);
    if (!projectionRow) return acc;
    acc.push(hydrateWarehouseCreativeMetrics({ row: projectionRow, factRow }));
    return acc;
  }, []);
  const grouped = groupRows(
    rawRows,
    "creative",
    buildCreativeUsageMap(rawRows),
  );
  return grouped.map((row) =>
    buildMetaCreativeApiRow({
      row,
      cachedThumbnailUrl: null,
      cardFallbackThumbnailUrl: null,
      includeDebugFields: false,
    }),
  );
}

describe("Creative Studio Assets: the sidecar fires on groupBy=creative", () => {
  /**
   * WHY: a measured zero must survive this grain too. `meta_creative_daily`
   * carries `spend`, `impressions`, `clicks` and `conversions` as NOT NULL
   * columns, and a sync that wrote the funnel keys as 0 measured them at zero.
   * A creative that ran and produced nothing is a fact the operator needs; an
   * em dash there would hide it.
   */
  it("prints a measured zero as 0 on the creative grain", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          spend: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          linkClicks: 0,
          landingPageViews: 0,
          addToCart: 0,
          initiateCheckout: 0,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      spend: true,
      impressions: true,
      purchases: true,
      link_clicks: true,
      add_to_cart: true,
      landing_page_views: true,
      initiate_checkout: true,
    });
    expect(mapApiRowToUiRow(rows[0]).observedMetrics).toMatchObject({
      spend: 0,
      impressions: 0,
      purchases: 0,
      addToCart: 0,
    });

    renderStudio(rows);

    expect(metricCell("Spend")).toBe("$0");
    expect(metricCell("Purchases")).toBe("0");
  });

  /*
   * THE AGE COLUMN, PROVEN ALONG THE SAME CHAIN — and pinned to the window's
   * clock rather than to the wall clock.
   *
   * WHY IT IS HERE AND NOT ONLY IN A UNIT TEST. `launch_date` is the ONE date
   * that survives the whole creative-grain chain: `meta_creative_daily` also
   * stores `first_seen_at` and `first_spend_at`, and neither is a field on
   * `MetaCreativeApiRow`, so neither can reach a cell —
   *
   *   grep -rn 'first_seen_at\|first_spend_at' lib/meta/creatives-types.ts \
   *     app/(dashboard)/platforms/meta/creatives/page-support.tsx    -> exit 1
   *
   * — which is exactly why the column says "since created" and not "days live".
   * A unit test on the projector could not see that, because it is handed the
   * row after the chain has already chosen the date.
   *
   * WHAT MAKES 16 THE ONLY PASSING ANSWER. The projection's `launch_date` is
   * 2026-08-01 and this file's mounted page reads the window
   * 2026-07-21..2026-08-17 (the `usePersistentDateRange` mock at the top). An
   * age counted to the window's end is 16 on every day this suite is ever run.
   * An age counted to `Date.now()` is 16 only if the suite happens to be run on
   * 2026-08-17 — so a projector that reaches for the system clock fails here
   * tomorrow and every day after, which is the point of asserting the literal.
   */
  it("counts the age from launch_date to the window's end, not to today", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          spend: 8,
          impressions: 300,
          clicks: 4,
          conversions: 0,
          revenue: 0,
        }),
      ],
    });

    // The date really does survive the warehouse chain to the wire.
    expect(rows[0].launch_date).toBe("2026-08-01");
    expect(mapApiRowToUiRow(rows[0]).launchDate).toBe("2026-08-01");

    renderStudio(rows);

    // 2026-08-01 -> 2026-08-17. Sixteen days, forever.
    expect(metricCell("Age (days since created)")).toBe("16");
    // The evidence base reads as one sentence: eight dollars, three hundred
    // impressions, no purchases, sixteen days. THAT is a judgeable row; the
    // same numbers at "2" would not be.
    expect(metricCell("Spend")).toBe("$8");
    expect(metricCell("Purchases")).toBe("0");
  });

  /*
   * The other half of the same law, on the same chain: a projection that never
   * carried a launch date.
   *
   * THE ABSENCE HAS TWO SHAPES, and the chain is what shows which arrives.
   * `coerceRawCreativeRow` has two branches: a stored `RawCreativeRow`-shaped
   * projection — the one production actually stores, recognised by `copy_text`
   * — is SPREAD through, so a missing `launch_date` stays `undefined` all the
   * way to the wire; only the api-row branch coalesces it with `?? ""`. Either
   * way `mapApiRowToUiRow` runs `safeString` over it and the UI row holds the
   * empty string, which is the value the projector actually has to refuse.
   *
   * Refuse it, not floor it: `Date.parse("")` is NaN, and a `|| 0` anywhere
   * near this path would print 0 — the table then claiming every unread
   * creative was created on the day the window closed, i.e. that the whole
   * account is too new to judge.
   */
  it("prints an em dash, never 0, when the projection carried no launch date", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [creativeDailyRow({ spend: 8, impressions: 300 })],
      projectionJson: storedProjection({ launch_date: undefined }),
    });

    expect(rows[0].launch_date).toBeUndefined();
    // ...and the empty string is what the projector is handed.
    expect(mapApiRowToUiRow(rows[0]).launchDate).toBe("");

    renderStudio(rows);

    expectMetricColumnHidden("Age (days since created)");
    // The measured numbers beside it are untouched: the absent date withholds
    // the age, not the row.
    expect(metricCell("Spend")).toBe("$8");
    expect(metricCell("Impressions")).toBe("300");
  });

  /**
   * WHY: this is the defect the wave is named after, at the grain the surface
   * reads. The fact row's `add_to_cart` / `landing_page_views` come from
   * `payload_json` keys that resolve to null when the sync never captured them,
   * and the stored projection carries `add_to_cart: 0` as a coalesced number.
   * The old reader treated that number as evidence and republished the unread
   * field as available, so an operator saw a measured 0 add-to-carts.
   */
  it("withholds a funnel counter the day's fact row never supplied", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          spend: 33_500,
          impressions: 120_000,
          clicks: 900,
          conversions: 0,
          revenue: 0,
          linkClicks: 800,
          // The sync never wrote these payload keys.
          addToCart: null,
          landingPageViews: null,
          initiateCheckout: 0,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      add_to_cart: false,
      landing_page_views: false,
      // Measured on the very same row — a partial row states both answers.
      initiate_checkout: true,
      spend: true,
      link_clicks: true,
    });
    // Additive: the legacy numbers are untouched beside the map.
    expect(rows[0].add_to_cart).toBe(0);
    expect(rows[0].spend).toBe(33_500);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.addToCart).toBeNull();
    expect(observed?.landingPageViews).toBeNull();
    expect(observed?.initiateCheckout).toBe(0);
    expect(observed?.spend).toBe(33_500);

    renderStudio(rows);

    expect(metricCell("Spend")).toBe("$33.5k");
    showColumns("Funnel");
    expectMetricColumnHidden("ATC rate (link clicks)");
    // The all-clicks counter is no longer a Funnel column: the ladder is
    // denominated in LINK clicks, and two clicks columns side by side is the
    // ambiguity this pass removed. It is still in the catalogue, so opt it in.
    showCatalogueMetric("Clicks (all)");
    expect(metricCell("Clicks (all)")).toBe("900");
  });

  /**
   * WHY: zero purchases does not make acquisition free. CPA is a
   * lower-is-better column, so `cpa: 0` painted this creative — ₺33,500 spent,
   * nothing bought — as the account's cost-per-purchase leader. Cost per
   * acquisition with no acquisitions is undefined, which is an em dash, and the
   * same holds for every ratio whose denominator was measured at zero.
   */
  it("withholds a ratio whose denominator was measured at zero", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          spend: 33_500,
          impressions: 120_000,
          clicks: 900,
          conversions: 0,
          revenue: 0,
          linkClicks: 800,
          addToCart: 0,
          landingPageViews: 0,
          initiateCheckout: 0,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      cpa: false,
      atc_to_purchase: false,
      // The operands themselves are measured, and stay so.
      spend: true,
      purchases: true,
      cpm: true,
      cpc_link: true,
    });
    expect(rows[0].cpa).toBe(0);

    renderStudio(rows);

    expect(metricCell("Spend")).toBe("$33.5k");
    expectMetricColumnHidden("CPA");
  });

  /**
   * WHY: a share of nothing is undefined. `groupRows` and
   * `buildMetaCreativeApiRow` both end the impression-denominated shares with
   * `: 0`, so a creative day with no delivery published `thumbstop: 0` — read
   * on screen as a hook that failed, when nothing was ever served to hook.
   *
   * The same case also pins the projection-only fields. `meta_creative_daily`
   * has no column and no payload key for `thumbstop`, the video quartiles,
   * `leads`, `messages`, `view_content`, `post_engagement` or
   * `thruplay_actions`; their numbers come from the ONE stored projection and
   * are then summed across the window's day-rows. On production 1,998 of 5,678
   * projections carry a positive `post_engagement` and 3,706 a positive
   * `thumbstop`, so a 28-day window really did multiply one day's counters by
   * 28 and report one day's hook rate as the window's.
   */
  it("withholds an impression share and every projection-only counter", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          spend: 400,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          linkClicks: 0,
          addToCart: 0,
          landingPageViews: 0,
          initiateCheckout: 0,
        }),
      ],
    });

    expect(rows[0].metric_presence).toMatchObject({
      thumbstop: false,
      video25: false,
      video50: false,
      video75: false,
      video100: false,
      leads: false,
      messages: false,
      view_content: false,
      post_engagement: false,
      thruplay_actions: false,
      cpm: false,
      ctr_all: false,
      // Impressions themselves were measured at zero and stay a fact.
      impressions: true,
      spend: true,
    });
    // The projection's counters are still on the wire, unchanged — `leads` is
    // the projection's 4 summed over one day-row, and `thumbstop` is the share
    // `groupRows` recomputed as 0 because the denominator was 0. Both are
    // published as numbers exactly as before; the map is the only new thing.
    expect(rows[0].leads).toBe(4);
    expect(rows[0].thumbstop).toBe(0);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.thumbstop).toBeNull();
    expect(observed?.leads).toBeNull();
    expect(observed?.impressions).toBe(0);

    renderStudio(rows);
    showCatalogueMetric("Thumbstop");

    expectMetricColumnHidden("Thumbstop");
    expectMetricColumnHidden("CPM");
  });

  /**
   * WHY: the creative-grain bucket is a SUM over the window's day-rows, and the
   * aggregation rule is the intersection — `intersectCreativeMetricPresence`.
   * Three days of add-to-cart plus one day of nothing is not four days of
   * add-to-cart, so one unavailable member makes the bucket unavailable for
   * that field, while every field both days did supply survives intact.
   */
  it("withholds a summed field when one day of the window never supplied it", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          date: "2026-08-16",
          spend: 100,
          impressions: 4_000,
          clicks: 60,
          conversions: 2,
          revenue: 300,
          roas: 3,
          linkClicks: 50,
          addToCart: 12,
          landingPageViews: 30,
          initiateCheckout: 5,
        }),
        creativeDailyRow({
          date: "2026-08-17",
          spend: 140,
          impressions: 5_000,
          clicks: 70,
          conversions: 3,
          revenue: 420,
          roas: 3,
          linkClicks: 60,
          // This day's payload never carried the key.
          addToCart: null,
          landingPageViews: 40,
          initiateCheckout: 7,
        }),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].metric_presence).toMatchObject({
      add_to_cart: false,
      landing_page_views: true,
      initiate_checkout: true,
      spend: true,
      link_clicks: true,
    });
    // The sum is published unchanged; only its availability changed.
    expect(rows[0].add_to_cart).toBe(12);
    expect(rows[0].landing_page_views).toBe(70);

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.addToCart).toBeNull();
    expect(observed?.landingPageViews).toBe(70);
    expect(observed?.spend).toBe(240);

    renderStudio(rows);
    showColumns("Funnel");

    // The all-clicks counter is no longer a Funnel column: the ladder is
    // denominated in LINK clicks, and two clicks columns side by side is the
    // ambiguity this pass removed. It is still in the catalogue, so opt it in.
    showCatalogueMetric("Clicks (all)");
    expect(metricCell("Clicks (all)")).toBe("130");
    expectMetricColumnHidden("ATC rate (link clicks)");
    expect(metricCell("Purchases")).toBe("5");
  });

  /**
   * WHY: a projection that DECLARES its own availability is believed, which is
   * what lets the sync repair the grain over time. Once a projection written
   * after this contract landed says `add_to_cart: true`, the fallback value it
   * supplies for a fact row that carried no key is a stated measurement rather
   * than a coalesced artifact — and a declared `false` is never upgraded.
   */
  it("believes a projection that declares its own availability", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          spend: 220,
          impressions: 9_000,
          clicks: 110,
          conversions: 4,
          revenue: 900,
          roas: 4,
          linkClicks: 95,
          addToCart: null,
          landingPageViews: null,
        }),
      ],
      projectionJson: storedProjection({
        add_to_cart: 18,
        landing_page_views: 0,
        metric_presence: { add_to_cart: true, landing_page_views: false },
      }),
    });

    expect(rows[0].metric_presence).toMatchObject({
      add_to_cart: true,
      landing_page_views: false,
    });

    const observed = mapApiRowToUiRow(rows[0]).observedMetrics;
    expect(observed?.addToCart).toBe(18);
    expect(observed?.landingPageViews).toBeNull();
  });
});

/**
 * THE LAW THIS WHOLE PASS EXISTS FOR.
 *
 * A DEFAULT column that no account can ever fill is worse than a missing
 * column: it teaches the operator that the table is empty and they stop
 * reading it. Two shipped here at once —
 *
 *   `hold`      the mounted projector assigned it a literal `null`, so it was
 *               an em dash in every row of every account, forever;
 *   `thumbstop` the warehouse producer stamps `thumbstop: false`
 *               unconditionally on this grain, so it was an em dash on the
 *               window this surface defaults to;
 *
 * and between them they were two of the five Engagement columns.
 *
 * The test runs the REAL warehouse chain against a day that measured
 * everything `meta_creative_daily` can measure. Every em dash it finds is
 * therefore the surface's doing rather than the account's, which is the exact
 * definition of a permanently blank column. It fails on the old catalogue in
 * two places at once: Hold (hardcoded null even here) and Thumbstop (stamped
 * unavailable by the producer this chain actually runs).
 */
describe("Creative Studio Assets: no default column is a permanent em dash", () => {
  /** A day that measured every field this grain carries. */
  function fullyMeasuredRows() {
    return buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          spend: 480,
          impressions: 96_000,
          clicks: 1_400,
          reach: 40_000,
          frequency: 2.4,
          conversions: 18,
          revenue: 1_920,
          roas: 4,
          linkClicks: 1_100,
          landingPageViews: 900,
          addToCart: 120,
          initiateCheckout: 60,
        }),
      ],
    });
  }

  it("fills every column of every preset when the producer measured everything", () => {
    renderStudio(fullyMeasuredRows());

    for (const set of ["Performance", "Engagement", "Funnel"] as const) {
      showColumns(set);
      const cells = visibleMetricCells();
      expect(cells.size, `${set} has no metric columns`).toBeGreaterThan(0);
      const blank = [...cells.entries()]
        .filter(([, value]) => value === "—")
        .map(([header]) => header);
      expect(
        blank,
        `${set} columns blank against a fully measured day`,
      ).toEqual([]);
    }
  });

  /**
   * The producer's own refusal, still honoured.
   *
   * `thumbstop` is not in a preset because the warehouse stamps it
   * unavailable — and this proves the stamp is real on this exact chain rather
   * than taken on trust. It is the reason the metric stays in the picker and
   * out of the defaults: an operator who ticks it is choosing it knowingly.
   */
  it("still withholds thumbstop on this grain, which is why it is not a default", () => {
    const rows = fullyMeasuredRows();
    expect(rows[0].metric_presence?.thumbstop).toBe(false);

    renderStudio(rows);
    showCatalogueMetric("Thumbstop");
    expectMetricColumnHidden("Thumbstop");
  });

  /**
   * The Funnel preset draws the whole ladder, so a drop-off is a thing you can
   * SEE rather than a thing you compute in your head from four columns.
   *
   * The old Funnel set was Clicks / ATC rate / CVR / Purchases: it skipped
   * landing page views and checkouts entirely although the producer serves
   * both, and its two rates named no denominator while sitting beside an
   * all-clicks column called simply "Clicks".
   */
  it("draws the whole funnel ladder with each step measured and each rate named", () => {
    renderStudio(fullyMeasuredRows());
    showColumns("Funnel");
    const cells = visibleMetricCells();

    expect(
      [...cells.keys()].map((header) => header.replace(/[↑↓]/g, "").trim()),
    ).toEqual([
      "Impressions",
      "CTR (link)",
      "Link clicks",
      "Landing page views",
      "Adds to cart",
      "ATC rate (link clicks)",
      "Checkouts",
      "Purchases",
      "ATC to purchase",
      "CVR (link clicks)",
    ]);

    // The counts, exactly, because a rate alone cannot say whether 10.9% of a
    // thousand clicks or of eleven is on screen.
    expect(cells.get("Impressions")).toBe("96k");
    expect(cells.get("Link clicks")).toBe("1.1k");
    expect(cells.get("Landing page views")).toBe("900");
    expect(cells.get("Adds to cart")).toBe("120");
    expect(cells.get("Checkouts")).toBe("60");
    expect(cells.get("Purchases")).toBe("18");

    // ...and each drop-off rate, named for the denominator it divides by.
    for (const rate of [
      "CTR (link) ↑",
      "ATC rate (link clicks) ↑",
      "ATC to purchase ↑",
      "CVR (link clicks) ↑",
    ]) {
      expect(cells.get(rate), `${rate} did not render a rate`).toMatch(
        /^\d+(\.\d+)?%$/,
      );
    }
  });

  /**
   * Revenue is the column this table never had, and the reason it needed one:
   * ROAS 4.0 on $30 and ROAS 2.1 on $4,000 are not the same decision, and ROAS
   * alone cannot tell them apart.
   *
   * A measured zero revenue is a finding about the creative, not an absence, so
   * it prints as a zero on the row's own currency.
   */
  it("carries revenue beside spend, and prints a measured zero revenue as money", () => {
    const rows = buildApiRowsFromCreativeWarehouse({
      factRows: [
        creativeDailyRow({
          spend: 33_500,
          impressions: 900_000,
          clicks: 900,
          conversions: 0,
          revenue: 0,
          roas: 0,
          linkClicks: 700,
        }),
      ],
    });
    // The producer's own presence entry: revenue is a NOT NULL column and is
    // available unconditionally on this grain.
    expect(rows[0].metric_presence?.purchase_value).toBe(true);

    renderStudio(rows);
    showColumns("Performance");
    const cells = visibleMetricCells();

    expect(cells.get("Spend")).toBe("$33.5k");
    expect(cells.get("Revenue")).toBe("$0");
    expect(cells.get("Purchases")).toBe("0");
    // Spent everything, earned nothing: ROAS over a measured zero revenue is a
    // measured zero, while CPA over zero purchases is undefined.
    expect(cells.get("ROAS ↑")).toBe("0.0");
    expect(cells.has("CPA ↓")).toBe(false);
    expect(cells.has("AOV ↑")).toBe(false);
  });
});
