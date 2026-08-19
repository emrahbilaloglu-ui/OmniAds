import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";

/**
 * WHICH clock describes the copy rows on screen.
 *
 * The defect: `/api/meta/copies` builds its rows from
 * `/api/meta/creatives`, which serves them from the WAREHOUSE on most windows
 * but reads Meta LIVE for the current day and for the fallback path. This route
 * then stamped every response with `MAX(updated_at)` over `meta_ad_daily` and
 * the page rendered that as the table's age — so on a live read the operator was
 * shown a warehouse WRITE time over rows that had never been in the warehouse.
 * The two clocks disagree in both directions: a live table refreshed seconds ago
 * could read "synced 1d ago", and a warehouse that had stopped syncing could be
 * masked by a live read beside it.
 *
 * The chain here is real at every link: the upstream verdict -> the real route's
 * `GET` -> the response body it actually returns -> `resolveCopiesFreshness`,
 * which is the function the surface hands to `useTierZeroFreshness`. Only the
 * upstream creatives read, the session and the database clock are doubled,
 * because those are the network, not the logic.
 */

vi.mock("@/lib/business-mode.server", () => ({ isDemoBusiness: vi.fn() }));
vi.mock("@/lib/access", () => ({ requireBusinessAccess: vi.fn() }));
vi.mock("@/lib/demo-business", () => ({
  getDemoMetaCopies: vi.fn(() => ({ status: "ok", rows: [], meta: {} })),
  getDemoProviderAccounts: vi.fn(() => [{ id: "act_1" }]),
}));
vi.mock("@/lib/meta/creatives-api", () => ({ getMetaCreativesApiPayload: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: vi.fn() };
});

const { GET } = await import("@/app/api/meta/copies/route");
// Not from the route: Next.js rejects any non-verb export on a route module,
// so the pure mapping lives in its own file and both sides import it.
const { resolveCopiesRowsObservedAt } = await import(
  "@/app/api/meta/copies/rows-observed-at"
);
const { resolveCopiesFreshness } = await import(
  "@/app/(dashboard)/platforms/meta/copies/page-support"
);
const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const creativesApi = await import("@/lib/meta/creatives-api");
const db = await import("@/lib/db");

const WAREHOUSE_WRITE_AT = "2026-08-18T04:34:04.744Z";

/** One ad carrying copy, as the upstream creatives read reports it. */
function adRow(): MetaCreativeApiRow {
  return {
    id: "ad_1",
    creative_id: "cr_1",
    associated_ads_count: 1,
    account_id: "act_1",
    account_name: "Main",
    campaign_id: "cmp_1",
    campaign_name: "Campaign 1",
    adset_id: "adset_1",
    adset_name: "Ad Set 1",
    currency: "USD",
    name: "Ad One",
    launch_date: "2026-08-17",
    copy_text: "A line that resolved",
    copy_variants: ["A line that resolved"],
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
    thumbstop: 0,
    click_to_atc: 0,
    atc_to_purchase: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
  } as MetaCreativeApiRow;
}

/** The real route, called the way the page calls it. */
async function readCopiesResponse(upstream: Record<string, unknown>) {
  vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue(upstream as never);
  const response = await GET(
    new NextRequest(
      "http://localhost/api/meta/copies?businessId=biz_1&providerAccountId=act_1" +
        "&start=2026-08-17&end=2026-08-18&groupBy=copy&format=all&sort=spend",
    ),
  );
  return {
    httpStatus: response.status,
    body: (await response.json()) as {
      status?: string;
      rows: unknown[];
      meta?: Record<string, unknown>;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(access.requireBusinessAccess).mockResolvedValue({
    session: {} as never,
    membership: {} as never,
  } as never);
  vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
  // The warehouse genuinely has a write instant for this window. Whether the
  // surface may READ it as the rows' age is the whole question.
  vi.mocked(db.getDb).mockReturnValue({
    query: vi.fn(async () => [{ observed_at: WAREHOUSE_WRITE_AT }]),
  } as never);
});

afterEach(() => vi.clearAllMocks());

describe("Copies freshness: the age belongs to the read that produced the rows", () => {
  it("dates warehouse-served rows from the warehouse write", async () => {
    const { body } = await readCopiesResponse({
      status: "ok",
      rows: [adRow()],
      readSource: "warehouse",
      warehouse_observed_at: WAREHOUSE_WRITE_AT,
    });

    expect(body.rows).toHaveLength(1);
    expect(body.meta).toMatchObject({
      readSource: "warehouse",
      warehouseObservedAt: WAREHOUSE_WRITE_AT,
      rowsObservedAt: WAREHOUSE_WRITE_AT,
      rowsObservedAtSource: "warehouse",
    });

    const freshness = resolveCopiesFreshness(body as never);
    expect(freshness.asOf).toBe(WAREHOUSE_WRITE_AT);
    expect(freshness.partialReason).toBeNull();
  });

  /**
   * WHY: this is the substitution. A current-day live read touches no warehouse
   * row, so `MAX(updated_at)` over `meta_ad_daily` is a fact about a DIFFERENT
   * dataset. The warehouse instant stays published — it is true about the table
   * — but it must not be handed over as the age of these rows, and the reason
   * has to say so out loud, because "age unknown" alone does not tell the
   * operator that a live read is why.
   */
  it("refuses the warehouse instant for live-served rows and says why", async () => {
    const { body } = await readCopiesResponse({
      status: "ok",
      rows: [adRow()],
      readSource: "current_day_live",
      warehouse_observed_at: null,
      isPartial: true,
      notReadyReason: "Current-day live Meta creative data is still being prepared.",
    });

    expect(body.status).toBe("partial");
    expect(body.meta).toMatchObject({
      readSource: "current_day_live",
      // Still published, and still true about the table.
      warehouseObservedAt: WAREHOUSE_WRITE_AT,
      // Not true about these rows.
      rowsObservedAt: null,
      rowsObservedAtSource: "live",
      isPartial: true,
      notReadyReason: "Current-day live Meta creative data is still being prepared.",
    });

    const freshness = resolveCopiesFreshness(body as never);
    expect(freshness.asOf).toBeNull();
    expect(freshness.partialReason).toContain(
      "Current-day live Meta creative data is still being prepared.",
    );
    expect(freshness.partialReason).toContain("read live from Meta");
  });

  /**
   * WHY: the live-fallback path is not the current-day path and is not declared
   * partial, but it is still a live read with no warehouse write behind it. The
   * lineage note must fire on lineage, not on the partial flag.
   */
  it("states the lineage on a live fallback that is not partial", async () => {
    const { body } = await readCopiesResponse({
      status: "ok",
      rows: [adRow()],
      readSource: "live_fallback",
      warehouse_observed_at: null,
    });

    expect(body.status).toBe("ok");
    expect(body.meta).toMatchObject({
      rowsObservedAt: null,
      rowsObservedAtSource: "live",
    });

    const freshness = resolveCopiesFreshness(body as never);
    expect(freshness.asOf).toBeNull();
    expect(freshness.partialReason).toContain("read live from Meta");
  });

  /**
   * WHY: an upstream that names no read source establishes nothing about
   * lineage, and an unstated lineage may not be resolved in the warehouse's
   * favour. Unknown is unknown.
   */
  it("keeps the age unknown when the upstream never says what it read", async () => {
    const { body } = await readCopiesResponse({ status: "ok", rows: [adRow()] });

    expect(body.meta).toMatchObject({
      readSource: null,
      rowsObservedAt: null,
      rowsObservedAtSource: "unknown",
    });
    expect(resolveCopiesFreshness(body as never).asOf).toBeNull();
  });

  /**
   * WHY: a partial upstream that DID come from the warehouse still has a real
   * age. Withholding the instant because the window is incomplete would confuse
   * coverage with age — two separate facts the contract keeps apart.
   */
  it("keeps the warehouse age on a partial warehouse read", async () => {
    const { body } = await readCopiesResponse({
      status: "ok",
      rows: [adRow()],
      readSource: "warehouse",
      warehouse_observed_at: WAREHOUSE_WRITE_AT,
      isPartial: true,
      notReadyReason: "Only part of the window is prepared.",
    });

    const freshness = resolveCopiesFreshness(body as never);
    expect(freshness.asOf).toBe(WAREHOUSE_WRITE_AT);
    expect(freshness.partialReason).toBe("Only part of the window is prepared.");
  });

  /**
   * WHY: the distinct-`ad_id` count is a separate closure that runs in the same
   * response builder. Pinned here so a freshness change cannot quietly cost it:
   * ten ads carrying one copy must still report 10, not the 1 row returned.
   */
  it("still reports the distinct ad count it merged", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      ...adRow(),
      id: `ad_${index + 1}`,
      name: `Ad ${index + 1}`,
    }));

    const { body } = await readCopiesResponse({
      status: "ok",
      rows,
      readSource: "warehouse",
      warehouse_observed_at: WAREHOUSE_WRITE_AT,
    });

    expect(body.rows).toHaveLength(1);
    expect((body.rows[0] as { associated_ads_count?: number }).associated_ads_count).toBe(10);
  });

  it("maps every lineage the upstream can report", () => {
    expect(
      resolveCopiesRowsObservedAt({ readSource: "warehouse", warehouseObservedAt: "x" }),
    ).toEqual({ rowsObservedAt: "x", rowsObservedAtSource: "warehouse" });
    expect(
      resolveCopiesRowsObservedAt({ readSource: "live_fallback", warehouseObservedAt: "x" }),
    ).toEqual({ rowsObservedAt: null, rowsObservedAtSource: "live" });
    expect(
      resolveCopiesRowsObservedAt({ readSource: "current_day_live", warehouseObservedAt: "x" }),
    ).toEqual({ rowsObservedAt: null, rowsObservedAtSource: "live" });
    expect(
      resolveCopiesRowsObservedAt({ readSource: null, warehouseObservedAt: "x" }),
    ).toEqual({ rowsObservedAt: null, rowsObservedAtSource: "unknown" });
  });
});
