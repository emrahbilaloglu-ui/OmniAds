import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { MetaCreativeApiRow } from "@/app/api/meta/creatives/route";
import { GET } from "@/app/api/meta/copies/route";

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  getDemoMetaCopies: vi.fn(() => ({ status: "ok", rows: [] })),
  getDemoProviderAccounts: vi.fn(() => [{ id: "act_1" }]),
}));

vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativesApiPayload: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: vi.fn() };
});

const businessMode = await import("@/lib/business-mode.server");
const access = await import("@/lib/access");
const creativesApi = await import("@/lib/meta/creatives-api");
const db = await import("@/lib/db");
const demoBusiness = await import("@/lib/demo-business");

/**
 * Stands in for the `MAX(updated_at)` read behind `meta.warehouseObservedAt`.
 * `null` models both "nothing matched" and "the read failed" — both must leave
 * the age unknown rather than substituting a fresh-looking stamp.
 */
function mockWarehouseObservedAt(observedAt: string | null) {
  vi.mocked(db.getDb).mockReturnValue({
    query: vi.fn(async () => (observedAt === null ? [] : [{ observed_at: observedAt }])),
  } as never);
}

function buildCreativeRow(overrides: Partial<MetaCreativeApiRow> = {}): MetaCreativeApiRow {
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
    name: "Winning copy",
    launch_date: "2026-03-01",
    copy_text: "Buy now",
    copy_variants: ["Buy now"],
    headline_variants: ["Headline"],
    description_variants: ["Description"],
    copy_source: "creative.body",
    copy_debug_sources: ["creative.body"],
    unresolved_reason: null,
    preview_url: "https://example.com/preview.jpg",
    preview_source: "image_url",
    thumbnail_url: "https://example.com/thumb.jpg",
    image_url: "https://example.com/image.jpg",
    table_thumbnail_url: "https://example.com/table.jpg",
    card_preview_url: "https://example.com/card.jpg",
    cached_thumbnail_url: null,
    is_catalog: false,
    preview_state: "preview",
    preview: {
      render_mode: "image",
      image_url: "https://example.com/image.jpg",
      video_url: null,
      poster_url: null,
      source: "image_url",
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
    spend: 100,
    purchase_value: 250,
    roas: 2.5,
    cpa: 10,
    cpc_link: 2,
    cpm: 12,
    ctr_all: 1.5,
    purchases: 10,
    impressions: 1000,
    clicks: 75,
    link_clicks: 50,
    landing_page_views: 0,
    add_to_cart: 15,
    initiate_checkout: 0,
    leads: 0,
    messages: 0,
    thumbstop: 12,
    click_to_atc: 20,
    atc_to_purchase: 66,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    ...overrides,
  };
}

describe("GET /api/meta/copies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    mockWarehouseObservedAt(null);
  });

  it("requires an explicit provider account scope", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/copies?businessId=biz"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "missing_provider_account_id",
    });
    expect(creativesApi.getMetaCreativesApiPayload).not.toHaveBeenCalled();
  });

  it("derives copy rows from the shared snapshot/live creatives payload", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow()],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].copy_text).toBe("Buy now");
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        providerAccountId: "act_1",
        mediaMode: "metadata",
        enableCopyRecovery: true,
        enableCreativeDetails: false,
        enableThumbnailBackfill: false,
        enableCardThumbnailBackfill: false,
        enableMediaRecovery: false,
      })
    );
  });

  it("defensively excludes rows from other provider accounts before grouping", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1", account_id: "act_1", spend: 100 }),
        buildCreativeRow({ id: "ad_2", account_id: "act_2", spend: 900 }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.meta.provider_account_id).toBe("act_1");
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({ account_id: "act_1", spend: 100 });
  });

  it("maps real funnel/video metrics from the source rows and never fabricates see_more_rate", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({
          landing_page_views: 40,
          initiate_checkout: 12,
          leads: 3,
          messages: 2,
          video25: 500,
          video50: 300,
          video75: 150,
          video100: 80,
          ctr_all: 1.5,
        }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=adName"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    const row = payload.rows[0];
    expect(row.landing_page_views).toBe(40);
    expect(row.initiate_checkout).toBe(12);
    expect(row.leads).toBe(3);
    expect(row.messages).toBe(2);
    expect(row.video25).toBe(500);
    expect(row.video50).toBe(300);
    expect(row.video75).toBe(150);
    expect(row.video100).toBe(80);
    // The old implementation fabricated see_more_rate = ctr_all * 1.5; the
    // field is now removed from the contract entirely.
    expect("see_more_rate" in row).toBe(false);
  });

  it("sums funnel/video metrics across grouped copy buckets", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({
          id: "ad_1",
          landing_page_views: 40,
          initiate_checkout: 12,
          leads: 3,
          messages: 2,
          video25: 500,
          video100: 80,
        }),
        buildCreativeRow({
          id: "ad_2",
          landing_page_views: 10,
          initiate_checkout: 8,
          leads: 1,
          messages: 0,
          video25: 100,
          video100: 20,
        }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    const row = payload.rows[0];
    expect(row.landing_page_views).toBe(50);
    expect(row.initiate_checkout).toBe(20);
    expect(row.leads).toBe(4);
    expect(row.messages).toBe(2);
    expect(row.video25).toBe(600);
    expect(row.video100).toBe(100);
  });

  it("aggregates thumbstop as an impression-weighted mean, not a plain mean", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        // 9000 impressions at 10% and 1000 at 50%: weighted = 14%, plain = 30%.
        buildCreativeRow({ id: "ad_1", impressions: 9000, thumbstop: 10 }),
        buildCreativeRow({ id: "ad_2", impressions: 1000, thumbstop: 50 }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].thumbstop).toBeCloseTo(14, 5);
    expect(payload.rows[0].first_frame_retention).toBeCloseTo(14, 5);
  });

  it("returns null bucket thumbstop when the bucket had no delivery", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1", impressions: 0, thumbstop: 10 }),
        buildCreativeRow({ id: "ad_2", impressions: 0, thumbstop: 50 }),
      ],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(payload.rows[0].thumbstop).toBeNull();
    expect(payload.rows[0].first_frame_retention).toBeNull();
  });

  // LAW: a read that did not succeed is never an empty success. `no_connection`,
  // `no_access_token` and `no_accounts_assigned` used to fall through the array
  // guards and be re-emitted as `status: "ok", rows: []` with HTTP 200, so the
  // page printed "No copy performance is available for this account and date
  // range." — a definite claim about the account produced by a read that never
  // happened. Each must leave with its own status, a message that names what did
  // not happen, and a non-2xx code so the page's error arm fires.
  it.each([
    ["no_connection", 409],
    ["no_access_token", 409],
    ["no_accounts_assigned", 409],
  ])("refuses to report %s as an empty account", async (status, expectedHttp) => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status,
      rows: [],
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(expectedHttp);
    expect(payload.status).toBe(status);
    expect(payload.status).not.toBe("ok");
    expect(typeof payload.message).toBe("string");
    expect(payload.message.length).toBeGreaterThan(0);
  });

  // LAW: the mirror of the case above. `no_data` is a read that completed and
  // found nothing, so the surface's empty sentence is true and must still be
  // reachable — an over-eager failure arm would replace a real fact with an
  // error, which is the same substitution in the opposite direction.
  it("keeps a completed empty read a 200 empty result", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "no_data",
      rows: [],
      snapshot_source: "live",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ok");
    expect(payload.rows).toEqual([]);
  });

  // LAW: a thrown upstream read is a failure, not an empty window. The creatives
  // payload now throws when the Meta integration row itself cannot be read, and
  // that must not reach the operator as "no copy performance".
  it("reports a thrown upstream read as a failure, not zero rows", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockRejectedValue(
      new Error("The Meta connection for this business could not be read."),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.status).toBe("upstream_read_failed");
    expect(payload.message).toContain("could not be read");
  });

  // LAW: a partial read is not a complete one. The upstream sets `isPartial`
  // with a reason for the current-day live path; erasing it left a half-window
  // indistinguishable from the whole window.
  it("carries an upstream partial read onto the response", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow()],
      snapshot_source: "live",
      isPartial: true,
      notReadyReason: "Meta is still preparing today's data.",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("partial");
    expect(payload.meta.isPartial).toBe(true);
    expect(payload.meta.notReadyReason).toBe("Meta is still preparing today's data.");
    expect(payload.rows).toHaveLength(1);
  });

  // LAW: the surface's as-of must describe the rows, not the request. The page
  // reads `meta.warehouseObservedAt` and nothing else; publishing it only on the
  // demo branch made every real business report an unknown age forever.
  it("publishes the warehouse observation time for a real business", async () => {
    mockWarehouseObservedAt("2026-03-31T10:00:00.000Z");
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow()],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    expect(payload.meta.warehouseObservedAt).toBe("2026-03-31T10:00:00.000Z");
    // The route's own clock is kept, but it is not the answer to "how old".
    expect(payload.meta.warehouseObservedAt).not.toBe(payload.meta.generatedAt);
  });

  it("leaves the age unknown rather than guessing when nothing was observed", async () => {
    mockWarehouseObservedAt(null);
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow()],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    expect(payload.meta.warehouseObservedAt).toBeNull();
  });

  // LAW: the engine already tags a messaging angle for the creative behind each
  // line, and the Assets tab renders it. Dropping it here made the two tabs
  // disagree about data that exists and left the Angle column an em dash.
  it("passes the engine's ai_tags through to each copy row", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow({ ai_tags: { messagingAngle: ["Promotional"] } })],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=adName",
      ),
    );
    const payload = await response.json();

    expect(payload.rows[0].ai_tags).toEqual({ messagingAngle: ["Promotional"] });
  });

  // LAW: an aggregate may only claim what is true of every member. A merged
  // bucket keeps an angle its members agree on and reports none when they
  // disagree, rather than promoting one member's tag to the group.
  it("keeps an agreed angle on a merged bucket and drops a disputed one", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1", ai_tags: { messagingAngle: ["Promotional"] } }),
        buildCreativeRow({ id: "ad_2", ai_tags: { messagingAngle: ["Promotional"] } }),
      ],
      snapshot_source: "persisted",
    } as never);

    const agreed = await (
      await GET(
        new NextRequest(
          "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
        ),
      )
    ).json();

    expect(agreed.rows).toHaveLength(1);
    expect(agreed.rows[0].ai_tags).toEqual({ messagingAngle: ["Promotional"] });

    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1", ai_tags: { messagingAngle: ["Promotional"] } }),
        buildCreativeRow({ id: "ad_2", ai_tags: { messagingAngle: ["Social Proof"] } }),
      ],
      snapshot_source: "persisted",
    } as never);

    const disputed = await (
      await GET(
        new NextRequest(
          "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
        ),
      )
    ).json();

    expect(disputed.rows).toHaveLength(1);
    expect(disputed.rows[0].ai_tags).toEqual({});
  });

  // LAW: an unmeasured rate is unknown, not 0.00%. `Number(x ?? 0)` made a
  // creative with no thumbstop measurement look like a video nobody watched.
  it("leaves an unsupplied thumbstop unknown instead of zero", async () => {
    const row = buildCreativeRow();
    delete (row as Partial<MetaCreativeApiRow>).thumbstop;
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [row],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=adName",
      ),
    );
    const payload = await response.json();

    expect(payload.rows[0].thumbstop).toBeNull();
    expect(payload.rows[0].first_frame_retention).toBeNull();
  });

  // LAW: a row whose rate was never measured is excluded from the bucket
  // average, not counted as a 0% row — a substituted zero drags the group toward
  // a number no ad produced.
  it("excludes an unmeasured row from the weighted thumbstop instead of scoring it zero", async () => {
    const unmeasured = buildCreativeRow({ id: "ad_2", impressions: 1000 });
    delete (unmeasured as Partial<MetaCreativeApiRow>).thumbstop;
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow({ id: "ad_1", impressions: 9000, thumbstop: 10 }), unmeasured],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy",
      ),
    );
    const payload = await response.json();

    // Counting the unmeasured row as 0% would give 9%; only the 9000 measured
    // impressions carry a thumbstop, so the bucket rate is 10%.
    expect(payload.rows[0].thumbstop).toBeCloseTo(10, 5);
  });

  it("stamps meta.generatedAt as an ISO timestamp", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow()],
      snapshot_source: "persisted",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-01&end=2026-03-31&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(typeof payload.meta.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(payload.meta.generatedAt))).toBe(false);
  });

  it("retries with snapshot bypass when source rows have no recoverable copy", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [
          buildCreativeRow({
            copy_text: null,
            copy_variants: [],
            headline_variants: [],
            description_variants: [],
            copy_source: null,
          }),
        ],
        snapshot_source: "live",
      } as never)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [
          buildCreativeRow({
            copy_text: "Recovered copy",
            copy_variants: ["Recovered copy"],
            copy_source: "preview_html",
          }),
        ],
        snapshot_source: "live",
      } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-21&end=2026-04-03&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].copy_text).toBe("Recovered copy");
    expect(payload.meta.recoveryAttempted).toBe(true);
    expect(payload.meta.recoveryRecovered).toBe(true);
    expect(payload.meta.recoveryReason).toBe("copy_empty_source_rows");
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledTimes(2);
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        snapshotBypass: true,
        enableCreativeDetails: true,
        enableCreativeBasicsFallback: true,
        mediaMode: "metadata",
      })
    );
  });

  it("retries once when a persisted snapshot returns zero rows", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [],
        snapshot_source: "persisted",
      } as never)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [],
        snapshot_source: "live",
      } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-21&end=2026-04-03&groupBy=copy"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(0);
    expect(payload.meta.recoveryAttempted).toBe(true);
    expect(payload.meta.recoveryRecovered).toBe(false);
    expect(payload.meta.recoveryReason).toBe("persisted_snapshot_empty");
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledTimes(2);
  });
});

/**
 * The Ads count is a property of the BUCKET, so it has to be established here.
 *
 * `groupBy=copy` merges every ad carrying one copy into a single row and keeps
 * only the sample ad's identity, so nothing downstream can recover how many ads
 * there were. The end-to-end proof that the number reaches the rendered cell
 * lives in `app/(dashboard)/platforms/meta/copies/page-support.test.ts`; these
 * cases pin the endpoint's own contract, including the branches that surface
 * never requests.
 */
describe("GET /api/meta/copies — associated_ads_count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    mockWarehouseObservedAt(null);
  });

  async function read(query: string) {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/copies?businessId=biz&providerAccountId=act_1&start=2026-03-21&end=2026-04-03&${query}`,
      ),
    );
    return { response, payload: await response.json() };
  }

  it("counts distinct ad ids inside each copy bucket", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1", name: "One" }),
        buildCreativeRow({ id: "ad_2", name: "Two" }),
        buildCreativeRow({ id: "ad_3", name: "Three" }),
      ],
    } as never);

    const { payload } = await read("groupBy=copy");

    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].associated_ads_count).toBe(3);
  });

  it("never merges two distinct ads that share a name", async () => {
    // Names repeat; ad ids do not. Counting names would report 1 here.
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1", name: "Evergreen" }),
        buildCreativeRow({ id: "ad_2", name: "Evergreen" }),
      ],
    } as never);

    const { payload } = await read("groupBy=copy");

    expect(payload.rows[0].associated_ads_count).toBe(2);
  });

  it("does not pool ads across accounts or currencies into one count", async () => {
    // The bucket key is account + currency + copy. Two accounts running the
    // same line are two lines, and their spend is not comparable anyway.
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        buildCreativeRow({ id: "ad_1" }),
        buildCreativeRow({ id: "ad_2", currency: "TRY" }),
      ],
    } as never);

    const { payload } = await read("groupBy=copy");

    expect(payload.rows).toHaveLength(2);
    expect(payload.rows.map((row: { associated_ads_count: number | null }) => row.associated_ads_count)).toEqual([1, 1]);
  });

  it("reports one ad per row when nothing is merged", async () => {
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow({ id: "ad_1" }), buildCreativeRow({ id: "ad_2" })],
    } as never);

    const { payload } = await read("groupBy=adName");

    expect(payload.rows).toHaveLength(2);
    expect(payload.rows.every((row: { associated_ads_count: number | null }) => row.associated_ads_count === 1)).toBe(true);
  });

  it("returns null rather than 1 when the bucket carries no ad identity", async () => {
    // An uncountable set is unknown. 1 would be a guess and 0 would be a
    // measurement nobody took; the surface renders an em dash for null.
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeRow({ id: "" })],
    } as never);

    const { payload } = await read("groupBy=copy");

    expect(payload.rows[0].associated_ads_count).toBeNull();
  });

  it("counts the demo branch under the same law, though it merges nothing", async () => {
    // The demo payload serves one row per ad and ignores groupBy, so several
    // rows can carry one copy. The column has to mean the same thing there.
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(true);
    vi.mocked(demoBusiness.getDemoMetaCopies).mockReturnValue({
      status: "ok",
      rows: [
        { id: "copy_1", ad_id: "ad_1", account_id: "act_1", currency: "USD", normalized_copy_key: "same line" },
        { id: "copy_2", ad_id: "ad_2", account_id: "act_1", currency: "USD", normalized_copy_key: "same line" },
        { id: "copy_3", ad_id: "ad_3", account_id: "act_1", currency: "USD", normalized_copy_key: "other line" },
      ],
      meta: {},
    } as never);

    const { payload } = await read("groupBy=copy");

    expect(
      payload.rows.map((row: { id: string; associated_ads_count: number | null }) => [
        row.id,
        row.associated_ads_count,
      ]),
    ).toEqual([
      ["copy_1", 2],
      ["copy_2", 2],
      ["copy_3", 1],
    ]);
  });
});
