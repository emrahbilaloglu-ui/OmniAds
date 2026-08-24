// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { NextRequest } from "next/server";
import { useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";

/**
 * The Ads column, end to end.
 *
 * This file used to hand `withCopyAdCounts` three synthetic PER-AD rows and
 * assert the helper grouped them — which proved nothing about the surface,
 * because the surface never receives per-ad rows. `/api/meta/copies?groupBy=copy`
 * MERGES every ad carrying one copy into a single row and keeps only the sample
 * ad's identity, so the client-side helper the old test exercised could only
 * ever see one row per copy and answer 1. A copy running on ten ads rendered
 * "Ads = 1" while the helper's own unit test stayed green. That is the exact
 * shape of failure the test has to be able to see.
 *
 * So the chain here is real at every link: raw per-ad creative rows -> the real
 * route's `GET` with `groupBy=copy` -> the response body it actually returns ->
 * the real page (mapper + studio adapter + table) -> the rendered "Ads" cell.
 * Only the upstream creatives read, the session and the database clock are
 * doubled, because those are the network, not the logic.
 */

vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness: vi.fn() }));
vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/demo-business", () => ({
  getDemoMetaCopies: vi.fn(() => ({ status: "ok", rows: [] })),
  getDemoProviderAccounts: vi.fn(() => [{ id: "act_1" }]),
}));
vi.mock("@/lib/meta/creatives-api", () => ({ getMetaCreativesApiPayload: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: vi.fn() };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/platforms/meta/copies",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: { selectedBusinessId: string | null }) => unknown) =>
    selector({ selectedBusinessId: null }),
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
      customStart: "2026-07-01",
      customEnd: "2026-07-28",
      comparisonPreset: "previousPeriod",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));
vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({ children }: { children: React.ReactNode }) => children,
}));

const { GET } = await import("@/app/api/meta/copies/route");
const CopiesPage = (await import("@/app/(dashboard)/platforms/meta/copies/legacy-page"))
  .default;
const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const creativesApi = await import("@/lib/meta/creatives-api");
const db = await import("@/lib/db");

const useQueryMock = vi.mocked(useQuery);

/** One ad, as the upstream creatives read reports it (`groupBy: "adName"`). */
function buildAdRow(overrides: Partial<MetaCreativeApiRow> = {}): MetaCreativeApiRow {
  return {
    id: "ad_1",
    creative_id: "cr_1",
    object_story_id: null,
    effective_object_story_id: null,
    post_id: null,
    associated_ads_count: 1,
    account_id: "act_1",
    account_name: "Main",
    campaign_id: "cmp_1",
    campaign_name: "Campaign 1",
    adset_id: "adset_1",
    adset_name: "Ad Set 1",
    currency: "USD",
    name: "Ad One",
    launch_date: "2026-07-01",
    copy_text: "Shared winning line",
    copy_variants: ["Shared winning line"],
    headline_variants: [],
    description_variants: [],
    copy_source: "creative.body",
    copy_debug_sources: ["creative.body"],
    unresolved_reason: null,
    preview_url: null,
    preview_source: null,
    thumbnail_url: null,
    image_url: null,
    table_thumbnail_url: null,
    card_preview_url: null,
    cached_thumbnail_url: null,
    is_catalog: false,
    preview_state: "unavailable",
    preview: {
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
      source: null,
      is_catalog: false,
    },
    preview_status: "ready",
    preview_origin: "snapshot",
    tags: [],
    ai_tags: {},
    format: "image",
    creative_type: "feed",
    creative_type_label: "Feed",
    creative_delivery_type: "standard",
    creative_visual_format: "image",
    creative_primary_type: "standard",
    creative_primary_label: "Standard",
    creative_secondary_type: null,
    creative_secondary_label: null,
    classification_signals: null,
    spend: 10,
    purchase_value: 25,
    roas: 2.5,
    cpa: 5,
    cpc_link: 1,
    cpm: 10,
    ctr_all: 1.5,
    purchases: 5,
    impressions: 1_000,
    clicks: 40,
    link_clicks: 40,
    landing_page_views: 0,
    add_to_cart: 8,
    initiate_checkout: 0,
    leads: 0,
    messages: 0,
    thumbstop: null,
    click_to_atc: 0,
    atc_to_purchase: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    ...overrides,
  } as MetaCreativeApiRow;
}

/** The real route, called the way the page calls it. */
async function readCopiesResponse(rows: MetaCreativeApiRow[]) {
  vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
    status: "ok",
    rows,
  } as never);
  const response = await GET(
    new NextRequest(
      "http://localhost/api/meta/copies?businessId=biz_1&providerAccountId=act_1" +
        "&start=2026-07-01&end=2026-07-28&groupBy=copy&format=all&sort=spend",
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    rows: Array<Record<string, unknown>>;
  };
}

/** The real page, fed exactly the body the route produced. */
function renderCopiesWith(payload: unknown) {
  useQueryMock.mockImplementation((options: { queryKey?: readonly unknown[] }) => {
    const isCopies = options.queryKey?.[0] === "copies-creatives";
    return {
      data: isCopies ? payload : undefined,
      error: null,
      fetchStatus: "idle",
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: vi.fn(),
      status: isCopies ? "success" : "pending",
    } as unknown as ReturnType<typeof useQuery>;
  });
  return render(<CopiesPage businessId="biz_1" providerAccountId="act_1" />);
}

/** The rendered "Ads" cell of a copy row — column index 2 of the exact table. */
function renderedAdsCells(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-copy-row]")).map((row) =>
    Array.from(row.querySelectorAll("td"))[2]?.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: {} as never,
    membership: {} as never,
  } as never);
  vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
  vi.mocked(db.getDb).mockReturnValue({ query: vi.fn(async () => []) } as never);
  useQueryMock.mockReset();
});

afterEach(() => cleanup());

describe("the Ads column survives the copy aggregation", () => {
  it("renders the number of distinct ads the route merged, not the number of rows it returned", async () => {
    // Ten ads, one copy. The route returns ONE row for them; the count has to
    // come off that row, because nine ad identities no longer exist by then.
    const ads = Array.from({ length: 10 }, (_, index) =>
      buildAdRow({ id: `ad_${index + 1}`, name: `Ad ${index + 1}` }),
    );

    const payload = await readCopiesResponse(ads);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]?.associated_ads_count).toBe(10);

    const { container } = renderCopiesWith(payload);
    expect(renderedAdsCells(container)).toEqual(["10"]);
  });

  it("counts ad identities, so two different ads that share a name stay two", async () => {
    // Ad names repeat constantly — duplicated ads, renamed ads, the same name
    // in two ad sets. Counting names would silently fold these two real ads
    // into one and under-report the copy's reach.
    const payload = await readCopiesResponse([
      buildAdRow({ id: "ad_1", name: "Evergreen" }),
      buildAdRow({ id: "ad_2", name: "Evergreen" }),
    ]);

    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]?.associated_ads_count).toBe(2);

    const { container } = renderCopiesWith(payload);
    expect(renderedAdsCells(container)).toEqual(["2"]);
  });

  it("keeps separate copies in separate buckets with their own counts", async () => {
    const payload = await readCopiesResponse([
      buildAdRow({ id: "ad_1", copy_text: "Line A", copy_variants: ["Line A"] }),
      buildAdRow({ id: "ad_2", copy_text: "Line A", copy_variants: ["Line A"] }),
      buildAdRow({
        id: "ad_3",
        copy_text: "Line B",
        copy_variants: ["Line B"],
        spend: 1,
      }),
    ]);

    expect(payload.rows).toHaveLength(2);
    const { container } = renderCopiesWith(payload);
    // Sorted by spend: the two-ad bucket outspends the single ad.
    expect(renderedAdsCells(container)).toEqual(["2", "1"]);
  });

  it("renders an em dash, never a 1, when the served rows carry no ad identity", async () => {
    // A row whose ads could not be identified is an UNCOUNTED set. Printing 1
    // would be a guess, and printing 0 would be a measurement nobody took.
    const payload = await readCopiesResponse([buildAdRow({ id: "" })]);
    expect(payload.rows[0]?.associated_ads_count).toBeNull();

    const { container } = renderCopiesWith(payload);
    expect(renderedAdsCells(container)).toEqual(["—"]);
  });

  it("refuses to invent a count the server did not send", () => {
    // A response missing the field entirely — a cached body from before the
    // route published it — must not fall back to the row count. The page reads
    // the served number or renders nothing.
    const { container } = renderCopiesWith({
      rows: [
        {
          id: "copy_legacy",
          ad_id: "ad_1",
          account_id: "act_1",
          name: "Legacy row",
          currency: "USD",
          copy_text: "Legacy line",
          copy_variants: ["Legacy line"],
          headline_variants: [],
          description_variants: [],
          normalized_copy_key: "legacy line",
          spend: 10,
          purchase_value: 20,
          roas: 2,
          impressions: 100,
          link_clicks: 10,
          purchases: 1,
        },
      ],
      meta: {},
    });
    expect(renderedAdsCells(container)).toEqual(["—"]);
  });
});
