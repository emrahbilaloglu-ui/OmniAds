import { beforeEach, describe, expect, it, vi } from "vitest";
import { META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION, type RawCreativeRow } from "@/lib/meta/creatives-types";

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => ({
  getMetaAdDailyCoverage: vi.fn(),
  getMetaCreativeMediaPreviewCoverage: vi.fn(),
  getMetaCreativeMediaRange: vi.fn(),
  getMetaAdDailyRange: vi.fn(),
  getMetaCreativeDailyRange: vi.fn(),
  upsertMetaAdDailyRows: vi.fn(),
  upsertMetaCreativeDailyRows: vi.fn(),
  upsertMetaCreativeMediaRows: vi.fn(),
}));

vi.mock("@/lib/meta/request-model-store", () => ({
  readMetaAdDimensions: vi.fn(),
  readMetaCreativeDimensions: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-service", () => ({
  buildCreativesResponse: vi.fn(),
}));

vi.mock("@/lib/meta/creative-day-config-proof", () => ({
  certifyCreativeDayConfigFromReceipts: vi.fn(),
}));

vi.mock("@/lib/meta/cleanup", () => ({
  pruneMetaCreativeMediaOutsideRetention: vi.fn(),
}));

/**
 * Stands in for the `MAX(updated_at)` read behind `warehouse_observed_at`.
 *
 * Mocked rather than left to fail by accident: without it the reader's own
 * catch would swallow a connection error and every assertion below would pass
 * against a null nobody had to produce.
 */
const dbQuery = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: dbQuery }),
}));

const creativeFetchers = await import("@/lib/meta/creatives-fetchers");
const creativesService = await import("@/lib/meta/creatives-service");
const configProof = await import("@/lib/meta/creative-day-config-proof");
const cleanup = await import("@/lib/meta/cleanup");
const requestModelStore = await import("@/lib/meta/request-model-store");
const warehouse = await import("@/lib/meta/warehouse");
const {
  getMetaCreativesWarehousePayload,
  hydrateWarehouseCreativeMetrics,
  assessCreativeDayWriterIdentityProof,
  findCreativeDayMembershipGapDays,
  readAdCreativeIdsForDays,
  readMetaCreativesWarehouseObservedAt,
  resolveMetaCreativesAccountScope,
  syncMetaCreativesWarehouseDay,
} = await import("@/lib/meta/creatives-warehouse");

function buildProjectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ad-1",
    creative_id: "crt-1",
    object_story_id: null,
    effective_object_story_id: null,
    post_id: null,
    associated_ads_count: 1,
    account_id: "act_1",
    account_name: "Account 1",
    campaign_id: "cmp-1",
    campaign_name: "Campaign 1",
    adset_id: "adset-1",
    adset_name: "Adset 1",
    currency: "USD",
    name: "Projected Creative",
    launch_date: "2026-04-03",
    copy_text: "Projected Copy",
    copy_variants: ["Projected Copy"],
    headline_variants: ["Projected Headline"],
    description_variants: [],
    copy_source: null,
    copy_debug_sources: [],
    unresolved_reason: null,
    preview_url: "https://example.com/preview.jpg",
    preview_source: "snapshot",
    thumbnail_url: "https://example.com/thumb.jpg",
    image_url: "https://example.com/image.jpg",
    table_thumbnail_url: null,
    card_preview_url: null,
    is_catalog: false,
    preview_state: "preview",
    preview: {
      render_mode: "image",
      image_url: "https://example.com/image.jpg",
      video_url: null,
      poster_url: "https://example.com/thumb.jpg",
      source: "image_url",
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
    thumbstop: 0,
    click_to_atc: 0,
    atc_to_purchase: 0,
    leads: 0,
    messages: 0,
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    ...overrides,
  };
}

function verifiedCreativeDayPayload(creativeId = "crt-1") {
  return {
    source_identity_version: META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION,
    source_ad_ids: ["member-ad-1"],
    source_ad_ids_complete: true,
    source_creative_ids: [creativeId],
    associated_ads_count: 1,
  };
}

function buildCreativeFactRow(overrides: Record<string, unknown> = {}) {
  return {
    businessId: "biz-1",
    providerAccountId: "act_1",
    date: "2026-04-03",
    campaignId: "cmp-1",
    adsetId: "adset-1",
    adId: "ad-1",
    creativeId: "crt-1",
    creativeName: "Creative 1",
    headline: null,
    primaryText: null,
    destinationUrl: null,
    thumbnailUrl: null,
    assetType: "image",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    spend: 25,
    impressions: 100,
    clicks: 4,
    conversions: 2,
    revenue: 50,
    roas: 2,
    ctr: 4,
    cpc: 6.25,
    linkClicks: 3,
    landingPageViews: 3,
    addToCart: 2,
    initiateCheckout: 1,
    sourceSnapshotId: null,
    payloadJson: verifiedCreativeDayPayload(
      typeof overrides.creativeId === "string" ? overrides.creativeId : "crt-1",
    ),
    ...overrides,
  };
}

function buildAdFactRow(overrides: Record<string, unknown> = {}) {
  return {
    businessId: "biz-1",
    providerAccountId: "act_1",
    date: "2026-04-03",
    campaignId: "cmp-1",
    adsetId: "adset-1",
    adId: "ad-1",
    adNameCurrent: "Ad 1",
    adNameHistorical: "Ad 1",
    adStatus: "ACTIVE",
    accountTimezone: "UTC",
    accountCurrency: "USD",
    spend: 12,
    impressions: 80,
    clicks: 3,
    reach: 80,
    frequency: null,
    conversions: 1,
    revenue: 24,
    roas: 2,
    cpa: 12,
    ctr: 3.75,
    cpc: 4,
    linkClicks: 2,
    outboundClicks: 2,
    landingPageViews: 2,
    addToCart: 1,
    initiateCheckout: 1,
    sourceSnapshotId: null,
    truthState: "finalized",
    truthVersion: 1,
    payloadJson: verifiedCreativeDayPayload(),
    createdAt: "2026-04-04T01:00:00.000Z",
    updatedAt: "2026-04-04T02:00:00.000Z",
    ...overrides,
  };
}

function buildCertifiedAdFactRow(overrides: Record<string, unknown> = {}) {
  return buildAdFactRow({ sourceSnapshotId: "snapshot-1", sourceRunId: "run-1",
    finalizedAt: "2026-04-04T03:00:00.000Z", validationStatus: "passed",
    ...overrides });
}

describe("meta creatives warehouse", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(new Map());
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(new Map());
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([] as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([] as never);
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([] as never);
    vi.mocked(configProof.certifyCreativeDayConfigFromReceipts).mockResolvedValue({
      verified: 0, unverified: 0,
    });
    vi.mocked(cleanup.pruneMetaCreativeMediaOutsideRetention).mockResolvedValue(undefined as never);
  });

  it("auto-resolves only a single assigned account", () => {
    expect(
      resolveMetaCreativesAccountScope({ assignedAccountIds: ["act_1"] }),
    ).toMatchObject({
      ok: true,
      providerAccountId: "act_1",
      assignedAccountIds: ["act_1"],
      resolution: "single_assigned_account",
    });
    expect(
      resolveMetaCreativesAccountScope({
        assignedAccountIds: ["act_1", "act_2"],
      }),
    ).toMatchObject({
      ok: false,
      status: "provider_account_required",
      assignedAccountCount: 2,
    });
  });

  it("fails closed for an unassigned explicit warehouse account", async () => {
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      providerAccountId: "act_other",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload).toMatchObject({
      status: "account_not_assigned",
      rows: [],
      providerAccountId: "act_other",
    });
    expect(warehouse.getMetaCreativeDailyRange).not.toHaveBeenCalled();
    expect(warehouse.getMetaAdDailyRange).not.toHaveBeenCalled();
  });

  it("passes one structured account filter to warehouse reads and drops foreign rows", async () => {
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      buildCreativeFactRow({
        providerAccountId: "act_2",
        adId: "ad-2",
        creativeId: "crt-2",
      }),
      buildCreativeFactRow({
        providerAccountId: "act_1",
        adId: "foreign-ad",
        creativeId: "foreign-crt",
      }),
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-2",
          {
            projectionJson: buildProjectionRow({
              id: "ad-2",
              creative_id: "crt-2",
              account_id: "act_2",
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      providerAccountId: "act_2",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(warehouse.getMetaCreativeDailyRange).toHaveBeenCalledWith({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      providerAccountIds: ["act_2"],
    });
    expect(payload).toMatchObject({
      status: "ok",
      providerAccountId: "act_2",
      account_scope: {
        status: "resolved",
        resolution: "explicit",
        assigned_account_count: 2,
      },
    });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      account_id: "act_2",
      creative_id: "crt-2",
    });
  });

  it("withholds unversioned creative-grain totals as partial instead of a verified zero or stale amount", async () => {
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      buildCreativeFactRow({
        payloadJson: { real_ad_id: "ad-1", associated_ads_count: 1 },
      }),
    ] as never);
    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });
    if (payload.status !== "ok") throw new Error("expected scoped warehouse payload");
    expect(payload).toMatchObject({ status: "ok", rows: [], isPartial: true });
    expect(payload.notReadyReason).toContain("unverified provider membership");
  });

  it("fails closed before creative financial rows are written without currency", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [buildProjectionRow({ currency: null })],
    } as never);

    await expect(
      syncMetaCreativesWarehouseDay({
        businessId: "biz-1",
        day: "2026-04-03",
        accessToken: "token",
        assignedAccountIds: ["act_1"],
      })
    ).rejects.toThrow("meta_currency_unavailable:creative_warehouse:act_1");

    expect(warehouse.upsertMetaAdDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCreativeDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCreativeMediaRows).not.toHaveBeenCalled();
  });

  it("rejects a paid Ad without provider creative identity before certifying any creative-day group", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [
        buildProjectionRow({ id: "ad-known", creative_id: "crt-1" }),
        buildProjectionRow({
          id: "ad-unresolved",
          creative_id: "unresolved_ad:ad-unresolved",
          spend: 12,
          impressions: 40,
        }),
      ],
    } as never);

    await expect(syncMetaCreativesWarehouseDay({
      businessId: "biz-1",
      day: "2026-04-03",
      accessToken: "token",
      assignedAccountIds: ["act_1"],
    })).rejects.toThrow("meta_creative_day_provider_identity_incomplete");
    expect(creativesService.buildCreativesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ strictSourceCompleteness: true }),
      expect.anything(),
    );
    expect(warehouse.upsertMetaCreativeDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCreativeMediaRows).not.toHaveBeenCalled();
  });

  it("leaves certified historical rows untouched when current Ad detail switched creatives", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [buildProjectionRow({ creative_id: "creative-current", currency: "USD" })],
    } as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildCertifiedAdFactRow({ accountTimezone: "America/Chicago" }),
    ] as never);
    dbQuery.mockResolvedValue([{ date: "2026-04-03", ad_id: "ad-1",
      creative_id: "creative-on-report-day" }]);

    for (let retry = 0; retry < 2; retry += 1) {
      await syncMetaCreativesWarehouseDay({ businessId: "biz-1", day: "2026-04-03",
        accessToken: "token", assignedAccountIds: ["act_1"], mediaMode: "full" });
    }
    expect(warehouse.upsertMetaCreativeDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCreativeMediaRows).not.toHaveBeenCalled();
    expect(configProof.certifyCreativeDayConfigFromReceipts).not.toHaveBeenCalled();
  });

  it("invalidates old creative-day authority only when both complete provider and Ad-day scopes are empty", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({ rows: [] } as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([] as never);
    dbQuery.mockResolvedValue([]);
    await syncMetaCreativesWarehouseDay({ businessId: "biz-1", day: "2026-04-03",
      accessToken: "token", assignedAccountIds: ["act_1"] });
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE meta_creative_daily"),
      ["biz-1", "act_1", "2026-04-03", META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION],
    );
    expect(String(dbQuery.mock.calls[0]?.[0])).toContain(
      "historical_config_authority_changed_at",
    );
    expect(String(dbQuery.mock.calls[0]?.[0])).toContain(
      "payload_json->>'source_economics_provenance' = 'provisional_meta_ad_daily'",
    );
    expect(warehouse.upsertMetaCreativeDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCreativeMediaRows).not.toHaveBeenCalled();

    dbQuery.mockClear();
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildCertifiedAdFactRow({ spend: 12 }),
    ] as never);
    await syncMetaCreativesWarehouseDay({ businessId: "biz-1", day: "2026-04-03",
      accessToken: "token", assignedAccountIds: ["act_1"] });
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("requires every Ad and real account-local timezone before certifying a whole day", () => {
    const row = buildProjectionRow({ id: "ad-1", creative_id: "crt-1",
      currency: "USD" }) as RawCreativeRow;
    const facts = [buildCertifiedAdFactRow({
      accountTimezone: "America/Chicago" })] as never;
    const proof = new Map([[JSON.stringify(["act_1", "2026-04-03", "ad-1"]), "crt-1"]]);
    expect(assessCreativeDayWriterIdentityProof({ providerAccountId: "act_1",
      day: "2026-04-03", rows: [row], adFacts: facts,
      provenCreativeByAdDay: proof })).toEqual({ canWrite: true,
      accountTimezone: "America/Chicago", accountCurrency: "USD" });
    expect(assessCreativeDayWriterIdentityProof({ providerAccountId: "act_1",
      day: "2026-04-03", rows: [row, { ...row, id: "ad-2", real_ad_id: "ad-2" }],
      adFacts: facts, provenCreativeByAdDay: proof })).toMatchObject({
      canWrite: false, reason: "finalized_ad_day_fact_missing" });
    expect(assessCreativeDayWriterIdentityProof({ providerAccountId: "act_1",
      day: "2026-04-03", rows: [row, row], adFacts: facts,
      provenCreativeByAdDay: proof })).toMatchObject({
      canWrite: false, reason: "provider_ad_identity_duplicate" });
    expect(assessCreativeDayWriterIdentityProof({ providerAccountId: "act_1",
      day: "2026-04-03", rows: [row], adFacts: [
        buildCertifiedAdFactRow(), buildCertifiedAdFactRow({ adId: "ad-2" }),
      ] as never, provenCreativeByAdDay: proof })).toMatchObject({
      canWrite: false, reason: "finalized_ad_day_missing_from_provider_scope", adId: "ad-2" });
    expect(assessCreativeDayWriterIdentityProof({ providerAccountId: "act_1",
      day: "2026-04-03", rows: [row],
      adFacts: [buildCertifiedAdFactRow({ accountTimezone: "" })] as never,
      provenCreativeByAdDay: proof })).toMatchObject({
      canWrite: false, reason: "account_context_missing_or_mixed" });
  });

  it("keeps current account-day provisional creative metrics presentational and out of decision admission", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-04T02:00:00.000Z")); // Chicago: April 3
      vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
        rows: [buildProjectionRow({ creative_id: "crt-1", currency: "USD" })],
      } as never);
      vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
        buildCertifiedAdFactRow({ accountTimezone: "America/Chicago",
          truthState: "provisional", validationStatus: "pending", finalizedAt: null,
          spend: 12, impressions: 80 }),
      ] as never);

      await syncMetaCreativesWarehouseDay({ businessId: "biz-1", day: "2026-04-03",
        accessToken: "token", assignedAccountIds: ["act_1"], mediaMode: "full" });

      expect(warehouse.upsertMetaCreativeDailyRows).toHaveBeenCalledOnce();
      const [rows] = vi.mocked(warehouse.upsertMetaCreativeDailyRows).mock.calls[0]!;
      expect(rows[0]).toMatchObject({ spend: 12, impressions: 80,
        payloadJson: { source_economics_provenance: "provisional_meta_ad_daily",
          source_membership_scope: "current_provider_ad_days_provisional",
          source_ad_ids: ["ad-1"], source_ad_ids_complete: false,
          source_parent_grain_complete: false } });
      expect((rows[0]!.payloadJson as Record<string, unknown>).source_identity_version).toBeUndefined();
      expect(warehouse.upsertMetaCreativeMediaRows).toHaveBeenCalledOnce();
      expect(configProof.certifyCreativeDayConfigFromReceipts).not.toHaveBeenCalled();
      expect(dbQuery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn a stale provisional Ad day into creative presentation", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-05T02:00:00.000Z")); // Chicago: April 4
      vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
        rows: [buildProjectionRow({ creative_id: "crt-1", currency: "USD" })],
      } as never);
      vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
        buildCertifiedAdFactRow({ accountTimezone: "America/Chicago",
          truthState: "provisional", validationStatus: "pending", finalizedAt: null }),
      ] as never);
      await syncMetaCreativesWarehouseDay({ businessId: "biz-1", day: "2026-04-03",
        accessToken: "token", assignedAccountIds: ["act_1"] });
      expect(warehouse.upsertMetaCreativeDailyRows).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds each receipt, state, change and tombstone insertion to the replay cutoff", async () => {
    dbQuery.mockResolvedValue([]);
    const recovered = await readAdCreativeIdsForDays({
      businessId: "biz-1", providerAccountId: "act_1",
      start: "2026-04-03", end: "2026-04-03",
      knowledgeCutoffAt: "2026-04-04T10:00:00.000Z",
    });
    expect(recovered.size).toBe(0);
    const query = String(dbQuery.mock.calls[0]?.[0]);
    for (const alias of ["authoritative", "h", "change", "gone"]) {
      expect(query).toContain(`${alias}.observed_at < $6::timestamptz`);
      expect(query).toContain(`${alias}.captured_at < $6::timestamptz`);
      expect(query).toContain(`${alias}.created_at < $6::timestamptz`);
    }
  });

  it("shows provisional creative rows only on the current local day and never in historical reads", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-04T02:00:00.000Z")); // Chicago: April 3
      vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
        buildCreativeFactRow({ accountTimezone: "America/Chicago", spend: 12,
          payloadJson: { source_ad_ids: ["ad-1"], source_ad_ids_complete: false,
            source_creative_ids: ["crt-1"], associated_ads_count: 1,
            source_membership_scope: "current_provider_ad_days_provisional",
            source_economics_provenance: "provisional_meta_ad_daily" } }),
      ] as never);
      vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
        new Map([["crt-1", { projectionJson: buildProjectionRow() }]]) as never,
      );
      dbQuery.mockResolvedValue([{ observed_at: "2026-04-04T02:00:00.000Z" }]);
      const input = { businessId: "biz-1", providerAccountId: "act_1",
        start: "2026-04-03", end: "2026-04-03", groupBy: "creative" as const,
        format: "all" as const, sort: "spend" as const,
        mediaMode: "metadata" as const };
      const current = await getMetaCreativesWarehousePayload(input);
      expect(current.rows).toHaveLength(1);
      expect(current.rows[0]).toMatchObject({ creative_id: "crt-1", spend: 12 });
      expect(current).toMatchObject({ isPartial: true });
      if (current.status !== "ok") throw new Error("expected scoped warehouse payload");
      expect(current.notReadyReason).toContain("provisional");

      const historical = await getMetaCreativesWarehousePayload({ ...input,
        knowledgeCutoffAt: "2026-04-04T01:00:00.000Z" });
      expect(historical.rows).toHaveLength(0);

      vi.setSystemTime(new Date("2026-04-05T02:00:00.000Z")); // Chicago: April 4
      const expired = await getMetaCreativesWarehousePayload(input);
      expect(expired.rows).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats legacy, missing, and duplicate creative memberships as a recent coverage gap", () => {
    const adFacts = [buildCertifiedAdFactRow(),
      buildCertifiedAdFactRow({ adId: "ad-zero", spend: 0, impressions: 0,
        clicks: 0, conversions: 0, revenue: 0 })] as never;
    const certified = buildCreativeFactRow({ payloadJson: {
      source_identity_version: META_CREATIVE_DAY_SOURCE_IDENTITY_VERSION,
      source_ad_ids: ["ad-1"], source_ad_ids_complete: true,
      source_creative_ids: ["crt-1"], associated_ads_count: 1,
    } });
    expect(findCreativeDayMembershipGapDays({ adFacts,
      creativeFacts: [buildCreativeFactRow()] as never })).toEqual(new Set(["2026-04-03"]));
    expect(findCreativeDayMembershipGapDays({ adFacts,
      creativeFacts: [certified] as never })).toEqual(new Set());
    expect(findCreativeDayMembershipGapDays({ adFacts,
      creativeFacts: [certified, { ...certified, creativeId: "crt-2" }] as never }))
      .toEqual(new Set(["2026-04-03"]));
  });

  it("preserves genuine creative account currency in warehouse rows", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [buildProjectionRow({ currency: "TRY" })],
    } as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildCertifiedAdFactRow({ accountCurrency: "TRY", accountTimezone: "America/Chicago" }),
    ] as never);
    dbQuery.mockResolvedValue([{ date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-1" }]);

    await syncMetaCreativesWarehouseDay({
      businessId: "biz-1",
      day: "2026-04-03",
      accessToken: "token",
      assignedAccountIds: ["act_1"],
    });

    // D066: creatives sync owns creative storage and writes zero Ad-days.
    expect(warehouse.upsertMetaAdDailyRows).not.toHaveBeenCalled();
    expect(warehouse.upsertMetaCreativeDailyRows).toHaveBeenCalledWith([
      expect.objectContaining({ accountCurrency: "TRY", accountTimezone: "America/Chicago" }),
    ]);
    expect(configProof.certifyCreativeDayConfigFromReceipts).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-1", providerAccountId: "act_1", day: "2026-04-03" }),
    );
  });

  it("uses finalized Ad-day economics despite a later provider restatement and does not invent purchase zero", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [buildProjectionRow({ effective_status: "PAUSED", spend: 99, impressions: 999,
        clicks: 51, purchases: 0, purchase_value: 0 })],
    } as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildCertifiedAdFactRow({ spend: 12, impressions: 80, clicks: 3,
        conversions: 0, revenue: 0, payloadJson: {} }),
    ] as never);
    dbQuery.mockResolvedValue([{ date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-1" }]);

    await syncMetaCreativesWarehouseDay({ businessId: "biz-1", day: "2026-04-03",
      accessToken: "token", assignedAccountIds: ["act_1"] });

    const written = vi.mocked(warehouse.upsertMetaCreativeDailyRows).mock.calls[0]?.[0]?.[0];
    expect(written).toMatchObject({ spend: 12, impressions: 80, clicks: 3,
      accountTimezone: "UTC", effectiveStatus: null, objective: null,
      optimizationGoal: null });
    const payload = written?.payloadJson as Record<string, unknown>;
    expect(payload).toMatchObject({ spend: 12, impressions: 80, clicks: 3,
      source_economics_provenance: "finalized_meta_ad_daily",
      metric_presence: { purchases: false, purchase_value: false, roas: false } });
    expect(payload.historical_config_proof).toBeUndefined();
  });

  it("propagates a receipt-certification failure after writing v2 membership", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [buildProjectionRow()],
    } as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildCertifiedAdFactRow(),
    ] as never);
    dbQuery.mockResolvedValue([{ date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-1" }]);
    const failure = new Error("receipt_read_failed");
    vi.mocked(configProof.certifyCreativeDayConfigFromReceipts).mockRejectedValue(failure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(syncMetaCreativesWarehouseDay({ businessId: "biz-1",
        day: "2026-04-03", accessToken: "token", assignedAccountIds: ["act_1"] }))
        .rejects.toBe(failure);
      expect(warehouse.upsertMetaCreativeDailyRows).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        "[meta-creatives] creative-day config proof failed",
        expect.objectContaining({ reason: "receipt_read_failed" }),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps a valid v2 day unverified when receipts are simply absent", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [buildProjectionRow()],
    } as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildCertifiedAdFactRow(),
    ] as never);
    dbQuery.mockResolvedValue([{ date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-1" }]);
    vi.mocked(configProof.certifyCreativeDayConfigFromReceipts).mockResolvedValue({
      verified: 0, unverified: 1,
    });

    await expect(syncMetaCreativesWarehouseDay({ businessId: "biz-1",
      day: "2026-04-03", accessToken: "token", assignedAccountIds: ["act_1"] }))
      .resolves.toBeUndefined();
    expect(warehouse.upsertMetaCreativeDailyRows).toHaveBeenCalledTimes(1);
  });

  it("persists full creative media at ad grain when a creative is reused", async () => {
    vi.mocked(creativesService.buildCreativesResponse).mockResolvedValue({
      rows: [
        buildProjectionRow({
          id: "ad-1",
          creative_id: "shared-creative",
          object_story_id: "123_456",
          effective_object_story_id: "123_789",
          destination_url: "https://iwastore.com/products/lp",
          destination_url_raw: "https://iwastore.com/products/lp?utm_source=meta",
          destination_url_source: "creative_link_data",
          destination_url_confidence: "high",
          cta_type: "SHOP_NOW",
          preview_url: "https://example.com/ad-1-preview.jpg",
          thumbnail_url: "https://example.com/ad-1-thumb.jpg",
        }),
        buildProjectionRow({
          id: "ad-2",
          creative_id: "shared-creative",
          campaign_id: "cmp-2",
          campaign_name: "Campaign 2",
          adset_id: "adset-2",
          adset_name: "Adset 2",
          preview_url: "https://example.com/ad-2-preview.jpg",
          thumbnail_url: "https://example.com/ad-2-thumb.jpg",
        }),
      ],
    } as never);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildCertifiedAdFactRow({ adId: "ad-1" }),
      buildCertifiedAdFactRow({ adId: "ad-2", campaignId: "cmp-2", adsetId: "adset-2" }),
    ] as never);
    dbQuery.mockResolvedValue([
      { date: "2026-04-03", ad_id: "ad-1", creative_id: "shared-creative" },
      { date: "2026-04-03", ad_id: "ad-2", creative_id: "shared-creative" },
    ]);

    await syncMetaCreativesWarehouseDay({
      businessId: "biz-1",
      day: "2026-04-03",
      accessToken: "token",
      assignedAccountIds: ["act_1"],
      mediaMode: "full",
      sourceRunId: "run-1",
    });

    const mediaRows = vi.mocked(warehouse.upsertMetaCreativeMediaRows).mock.calls[0]?.[0] ?? [];

    expect(mediaRows).toHaveLength(2);
    expect(mediaRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adId: "ad-1",
          creativeId: "shared-creative",
          previewUrl: "https://example.com/ad-1-preview.jpg",
          sourceRunId: "run-1",
        }),
        expect.objectContaining({
          adId: "ad-2",
          creativeId: "shared-creative",
          previewUrl: "https://example.com/ad-2-preview.jpg",
          sourceRunId: "run-1",
        }),
      ]),
    );
    // D066: this path is not a decision-fact writer. Ad-grain presentation
    // data lives in the media rows asserted above; meta_ad_daily belongs to
    // authoritative insights sync alone.
    expect(warehouse.upsertMetaAdDailyRows).not.toHaveBeenCalled();
    const creativeRows =
      vi.mocked(warehouse.upsertMetaCreativeDailyRows).mock.calls[0]?.[0] ?? [];
    expect(creativeRows).toHaveLength(1);
    expect(creativeRows[0]).toEqual(
      expect.objectContaining({
        creativeId: "shared-creative",
        destinationUrl: "https://iwastore.com/products/lp",
        destinationUrlRaw: "https://iwastore.com/products/lp?utm_source=meta",
        destinationUrlSource: "creative_link_data",
        destinationUrlConfidence: "high",
        ctaType: "SHOP_NOW",
        objectStoryId: "123_456",
        effectiveObjectStoryId: "123_789",
      }),
    );
  });

  it("builds creative-group payloads from creative dimensions instead of daily payloadJson", async () => {
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Wrong Daily Creative",
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 25,
        impressions: 100,
        clicks: 4,
        conversions: 2,
        revenue: 50,
        roas: 2,
        ctr: 4,
        cpc: 6.25,
        linkClicks: 3,
        landingPageViews: 3,
        addToCart: 2,
        initiateCheckout: 1,
        sourceSnapshotId: null,
        payloadJson: { ...buildProjectionRow({
          name: "Ignored Daily Payload",
          copy_text: "Ignored Daily Copy",
          landing_page_views: 999,
          add_to_cart: 999,
          initiate_checkout: 999,
        }), ...verifiedCreativeDayPayload() },
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-1",
          {
            projectionJson: buildProjectionRow({
              name: "Dimension Creative",
              copy_text: "Dimension Copy",
              spend: 999,
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload.status).toBe("ok");
    expect(payload.rows[0]).toMatchObject({
      creative_id: "crt-1",
      name: "Dimension Creative",
      copy_text: "Dimension Copy",
      spend: 25,
      purchase_value: 50,
      landing_page_views: 3,
      add_to_cart: 2,
      initiate_checkout: 1,
      click_to_atc: 66.67,
      atc_to_purchase: 100,
    });
  });

  it("keeps metadata warehouse reads working when retained dimensions omit nested preview", async () => {
    const projectionWithoutPreview = buildProjectionRow({
      name: "Dimension Creative",
      preview_url: null,
      thumbnail_url: null,
      image_url: null,
      table_thumbnail_url: null,
      card_preview_url: null,
    });
    delete (projectionWithoutPreview as Record<string, unknown>).preview;
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Creative 1",
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 25,
        impressions: 100,
        clicks: 4,
        conversions: 2,
        revenue: 50,
        roas: 2,
        ctr: 4,
        cpc: 6.25,
        linkClicks: 3,
        sourceSnapshotId: null,
        payloadJson: verifiedCreativeDayPayload(),
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-1",
          {
            projectionJson: projectionWithoutPreview,
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload.status).toBe("ok");
    expect(payload.rows[0]).toMatchObject({
      creative_id: "crt-1",
      name: "Dimension Creative",
      preview_status: "missing",
      spend: 25,
      purchase_value: 50,
    });
    expect(payload.rows[0]?.preview).toMatchObject({
      render_mode: "unavailable",
      image_url: null,
      video_url: null,
      poster_url: null,
    });
  });

  it("infers preview mode from retained top-level media URLs when nested preview is absent", async () => {
    const projectionWithoutPreview = buildProjectionRow({
      name: "Dimension Creative",
      preview_url: "https://example.com/preview.jpg",
      thumbnail_url: "https://example.com/thumb.jpg",
      image_url: "https://example.com/image.jpg",
      table_thumbnail_url: null,
      card_preview_url: null,
    });
    delete (projectionWithoutPreview as Record<string, unknown>).preview;
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Creative 1",
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 25,
        impressions: 100,
        clicks: 4,
        conversions: 2,
        revenue: 50,
        roas: 2,
        ctr: 4,
        cpc: 6.25,
        linkClicks: 3,
        sourceSnapshotId: null,
        payloadJson: verifiedCreativeDayPayload(),
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-1",
          {
            projectionJson: projectionWithoutPreview,
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload.rows[0]).toMatchObject({
      creative_id: "crt-1",
      preview_status: "ready",
      preview_url: "https://example.com/image.jpg",
      image_url: "https://example.com/image.jpg",
    });
    expect(payload.rows[0]?.preview).toMatchObject({
      render_mode: "image",
      image_url: "https://example.com/image.jpg",
      poster_url: "https://example.com/thumb.jpg",
    });
  });

  it("hydrates creative-group warehouse rows from the richest retained media row", async () => {
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Creative 1",
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 25,
        impressions: 100,
        clicks: 4,
        conversions: 2,
        revenue: 50,
        roas: 2,
        ctr: 4,
        cpc: 6.25,
        linkClicks: 3,
        sourceSnapshotId: null,
        payloadJson: verifiedCreativeDayPayload(),
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaCreativeDimensions).mockResolvedValue(
      new Map([
        [
          "crt-1",
          {
            projectionJson: buildProjectionRow({
              preview_url: null,
              thumbnail_url: null,
              image_url: null,
              table_thumbnail_url: null,
              card_preview_url: null,
              preview: {
                render_mode: "missing",
                image_url: null,
                video_url: null,
                poster_url: null,
                source: null,
                is_catalog: false,
              },
            }),
          },
        ],
      ]) as never,
    );
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        previewUrl: null,
        thumbnailUrl: null,
        imageUrl: null,
        payloadJson: verifiedCreativeDayPayload(),
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-2",
        adId: "ad-2",
        creativeId: "crt-1",
        previewUrl: "https://example.com/rich-preview.jpg",
        thumbnailUrl: "https://example.com/rich-thumb.jpg",
        imageUrl: "https://example.com/rich-image.jpg",
        posterUrl: "https://example.com/rich-poster.jpg",
        payloadJson: verifiedCreativeDayPayload(),
      },
    ] as never);

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "creative",
      format: "all",
      sort: "spend",
      mediaMode: "full",
    });

    expect(payload.rows[0]).toMatchObject({
      creative_id: "crt-1",
      preview_url: "https://example.com/rich-poster.jpg",
      image_url: "https://example.com/rich-image.jpg",
      preview_status: "ready",
    });
  });

  it("filters exact ad-group creative usage before retained media hydration", async () => {
    dbQuery.mockResolvedValue([{ date: "2026-04-03", ad_id: "ad-selected", creative_id: "crt-target" }]);
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildAdFactRow({
        providerAccountId: "act_1",
        adId: "ad-foreign",
        adNameCurrent: "Foreign Ad",
      }),
      buildAdFactRow({
        providerAccountId: "act_2",
        adId: "ad-selected",
        adNameCurrent: "Selected Ad",
      }),
      buildAdFactRow({
        providerAccountId: "act_2",
        adId: "ad-other",
        adNameCurrent: "Other Ad",
      }),
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        [
          "ad-foreign",
          {
            creativeId: "crt-target",
            projectionJson: buildProjectionRow({
              id: "ad-foreign",
              creative_id: "crt-target",
              account_id: "act_1",
            }),
          },
        ],
        [
          "ad-selected",
          {
            creativeId: "crt-target",
            projectionJson: buildProjectionRow({
              id: "ad-selected",
              creative_id: "crt-target",
              account_id: "act_2",
            }),
          },
        ],
        [
          "ad-other",
          {
            creativeId: "crt-other",
            projectionJson: buildProjectionRow({
              id: "ad-other",
              creative_id: "crt-other",
              account_id: "act_2",
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      providerAccountId: "act_2",
      creativeId: "crt-target",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "ad",
      format: "all",
      sort: "spend",
      mediaMode: "full",
    });

    expect(warehouse.getMetaAdDailyRange).toHaveBeenCalledWith({
      businessId: "biz-1",
      startDate: "2026-04-03",
      endDate: "2026-04-03",
      providerAccountIds: ["act_2"],
    });
    expect(requestModelStore.readMetaAdDimensions).toHaveBeenCalledWith({
      businessId: "biz-1",
      adIds: ["ad-selected"],
    });
    expect(warehouse.getMetaCreativeMediaRange).toHaveBeenCalledWith(
      expect.objectContaining({
        providerAccountIds: ["act_2"],
        creativeIds: null,
        adIds: ["ad-selected"],
      }),
    );
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      id: "ad-selected",
      account_id: "act_2",
      creative_id: "crt-target",
      name: "Selected Ad",
    });
  });

  it("builds ad-group payloads from ad dimensions instead of daily payloadJson", async () => {
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Wrong Daily Ad",
        adNameHistorical: "Wrong Daily Ad",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        reach: 80,
        frequency: null,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 3.75,
        cpc: 4,
        linkClicks: 2,
        outboundClicks: 2,
        landingPageViews: 2,
        addToCart: 1,
        initiateCheckout: 1,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        payloadJson: buildProjectionRow({
          name: "Ignored Ad Payload",
          copy_text: "Ignored Ad Copy",
          landing_page_views: 999,
          add_to_cart: 999,
          initiate_checkout: 999,
        }),
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        [
          "ad-1",
          {
            projectionJson: buildProjectionRow({
              name: "Dimension Ad",
              copy_text: "Dimension Ad Copy",
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "adName",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload.status).toBe("ok");
    expect(payload.rows[0]).toMatchObject({
      id: "ad-1",
      name: "Dimension Ad",
      copy_text: "Dimension Ad Copy",
      spend: 12,
      purchase_value: 24,
      outbound_clicks: 2,
      landing_page_views: 2,
      add_to_cart: 1,
      initiate_checkout: 1,
      click_to_atc: 50,
      atc_to_purchase: 100,
    });
  });

  it.each([0, 18])("keeps missing ad-day funnel unmeasured despite a unique creative display value of %s", async (creativeLinkClicks) => {
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        reach: 80,
        frequency: null,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 0,
        cpc: 0,
        linkClicks: null,
        landingPageViews: null,
        addToCart: null,
        initiateCheckout: null,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
        payloadJson: verifiedCreativeDayPayload(),
      },
    ] as never);
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        creativeName: "Creative 1",
        headline: null,
        primaryText: null,
        destinationUrl: null,
        thumbnailUrl: null,
        assetType: "image",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 3.75,
        cpc: 4,
        linkClicks: creativeLinkClicks,
        landingPageViews: 10,
        addToCart: 2,
        initiateCheckout: 1,
        sourceSnapshotId: null,
        payloadJson: verifiedCreativeDayPayload(),
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        [
          "ad-1",
          {
            creativeId: "crt-1",
            projectionJson: buildProjectionRow({
              id: "ad-1",
              creative_id: "crt-1",
              name: "Dimension Ad",
              metric_presence: {
                link_clicks: true, landing_page_views: true,
                add_to_cart: true, initiate_checkout: true,
              },
            }),
          },
        ],
      ]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "adName",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
    });

    expect(payload.rows[0]).toMatchObject({
      id: "ad-1",
      link_clicks: 0,
      landing_page_views: 0,
      add_to_cart: 0,
      initiate_checkout: 0,
      metric_presence: {
        link_clicks: false, landing_page_views: false,
        add_to_cart: false, initiate_checkout: false,
      },
    });
    expect(warehouse.getMetaCreativeDailyRange).not.toHaveBeenCalled();
  });

  it("keeps measured ad-day zeros even when a creative-day fallback is positive", async () => {
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      buildAdFactRow({
        linkClicks: 0, outboundClicks: 0, landingPageViews: 0,
        addToCart: 0, initiateCheckout: 0,
      }),
    ] as never);
    vi.mocked(warehouse.getMetaCreativeDailyRange).mockResolvedValue([
      buildCreativeFactRow({
        linkClicks: 18, outboundClicks: 8, landingPageViews: 10,
        addToCart: 2, initiateCheckout: 1,
      }),
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([["ad-1", { creativeId: "crt-1", projectionJson: buildProjectionRow() }]]) as never,
    );

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1", start: "2026-04-03", end: "2026-04-03",
      groupBy: "adName", format: "all", sort: "spend", mediaMode: "metadata",
    });

    expect(payload.rows[0]).toMatchObject({
      link_clicks: 0,
      outbound_clicks: 0,
      landing_page_views: 0,
      add_to_cart: 0,
      initiate_checkout: 0,
      metric_presence: {
        link_clicks: true, landing_page_views: true,
        add_to_cart: true, initiate_checkout: true,
      },
    });
    expect(warehouse.getMetaCreativeDailyRange).not.toHaveBeenCalled();
  });

  it("hydrates ad-name warehouse rows from retained creative media", async () => {
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        adNameCurrent: "Ad 1",
        adNameHistorical: "Ad 1",
        adStatus: "ACTIVE",
        accountTimezone: "UTC",
        accountCurrency: "USD",
        spend: 12,
        impressions: 80,
        clicks: 3,
        reach: 80,
        frequency: null,
        conversions: 1,
        revenue: 24,
        roas: 2,
        cpa: 12,
        ctr: 3.75,
        cpc: 4,
        linkClicks: 2,
        sourceSnapshotId: null,
        truthState: "finalized",
        truthVersion: 1,
      },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        [
          "ad-1",
          {
            projectionJson: buildProjectionRow({
              preview_url: null,
              thumbnail_url: null,
              image_url: null,
              table_thumbnail_url: null,
              card_preview_url: null,
              preview: {
                render_mode: "missing",
                image_url: null,
                video_url: null,
                poster_url: null,
                source: null,
                is_catalog: false,
              },
            }),
          },
        ],
      ]) as never,
    );
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        previewUrl: "https://example.com/media-preview.jpg",
        thumbnailUrl: "https://example.com/media-thumb.jpg",
        imageUrl: "https://example.com/media-image.jpg",
        tableThumbnailUrl: "https://example.com/media-table.jpg",
        cardPreviewUrl: "https://example.com/media-card.jpg",
        videoUrl: null,
        posterUrl: "https://example.com/media-poster.jpg",
        payloadJson: verifiedCreativeDayPayload(),
      },
      {
        businessId: "biz-1",
        providerAccountId: "act_1",
        date: "2026-04-03",
        campaignId: "cmp-1",
        adsetId: "adset-1",
        adId: "ad-1",
        creativeId: "crt-1",
        previewUrl: null,
        thumbnailUrl: null,
        imageUrl: null,
        payloadJson: verifiedCreativeDayPayload(),
      },
    ] as never);

    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "adName",
      format: "all",
      sort: "spend",
      mediaMode: "full",
    });

    expect(warehouse.getMetaCreativeMediaRange).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeIds: null,
        adIds: ["ad-1"],
      }),
    );
    expect(payload.rows[0]).toMatchObject({
      id: "ad-1",
      preview_url: "https://example.com/media-preview.jpg",
      thumbnail_url: "https://example.com/media-table.jpg",
      image_url: "https://example.com/media-image.jpg",
      preview_status: "ready",
    });
    if (payload.status !== "ok") throw new Error("expected scoped warehouse payload");
    expect(payload.media_hydrated).toBe(true);
  });
});

describe("ad-grain creative identity recovery", () => {
  const cutoff = "2026-04-05T00:00:00.000Z";
  const adDay = () =>
    buildAdFactRow({
      spend: 22.83,
      impressions: 1325,
      linkClicks: 22,
      landingPageViews: 14,
      addToCart: 2,
      conversions: 0,
      revenue: 0,
      createdAt: "2026-04-04T01:00:00.000Z",
      updatedAt: "2026-04-04T02:00:00.000Z",
    });
  async function readRecovered(overrides: {
    adDay?: ReturnType<typeof adDay>;
    identityRows?: { date: string; ad_id: string; creative_id: string }[];
    adDimensionCreativeId?: string | null;
  } = {}) {
    dbQuery.mockResolvedValue(
      overrides.identityRows ?? [{ date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-1" }],
    );
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      overrides.adDay ?? adDay(),
    ] as never);
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(
      new Map([
        ["ad-1", {
          creativeId: overrides.adDimensionCreativeId ?? null,
          projectionJson: null,
        }],
      ]) as never,
    );
    return getMetaCreativesWarehousePayload({
      businessId: "biz-1",
      providerAccountId: "act_1",
      creativeId: "crt-1",
      start: "2026-04-03",
      end: "2026-04-03",
      groupBy: "ad",
      format: "all",
      sort: "spend",
      mediaMode: "metadata",
      knowledgeCutoffAt: cutoff,
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    dbQuery.mockResolvedValue([{ observed_at: new Date("2026-04-04T02:00:00Z") }]);
  });

  it("recovers TheSwaf-style null ad dimension from one exact source ad-day without borrowing creative-day metrics", async () => {
    const payload = await readRecovered();
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      id: "ad-1",
      creative_id: "crt-1",
      campaign_id: "cmp-1",
      adset_id: "adset-1",
      spend: 22.83,
      impressions: 1325,
      link_clicks: 22,
      landing_page_views: 14,
      add_to_cart: 2,
      purchases: 0,
      metric_presence: {
        link_clicks: true,
        landing_page_views: true,
        add_to_cart: true,
      },
    });
    expect(warehouse.getMetaCreativeDailyRange).not.toHaveBeenCalled();
  });

  it("refuses an unproven day even when the current ad dimension names the requested creative", async () => {
    const payload = await readRecovered({
      identityRows: [],
      adDimensionCreativeId: "crt-1",
    });
    expect(payload.rows).toHaveLength(0);
    if (payload.status !== "ok") throw new Error("expected scoped warehouse payload");
    expect(payload).toMatchObject({ status: "ok", isPartial: true });
    expect(payload.notReadyReason).toContain("unverified historical creative identity");
  });

  it("keeps a proven Ad for another creative out of a filtered read without claiming partial coverage", async () => {
    const payload = await readRecovered({
      identityRows: [{ date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-other" }],
    });
    expect(payload).toMatchObject({ status: "ok", rows: [], isPartial: false,
      notReadyReason: null });
  });

  it("serves proven members while marking an active unproved Ad-day as partial", async () => {
    dbQuery.mockResolvedValue([
      { date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-1" },
    ]);
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      adDay(),
      { ...adDay(), adId: "ad-2", spend: 5, impressions: 40 },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(new Map());
    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1", providerAccountId: "act_1", creativeId: "crt-1",
      start: "2026-04-03", end: "2026-04-03", groupBy: "ad",
      format: "all", sort: "spend", mediaMode: "metadata",
      knowledgeCutoffAt: cutoff,
    });
    expect(payload.rows).toHaveLength(1);
    if (payload.status !== "ok") throw new Error("expected scoped warehouse payload");
    expect(payload).toMatchObject({ status: "ok", isPartial: true });
    expect(payload.notReadyReason).toContain("1 active Ad-day rows");
  });

  it("preserves a verified empty filtered read when there are no source Ad-days", async () => {
    dbQuery.mockResolvedValue([]);
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([] as never);
    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1", providerAccountId: "act_1", creativeId: "crt-1",
      start: "2026-04-03", end: "2026-04-03", groupBy: "ad",
      format: "all", sort: "spend", mediaMode: "metadata",
      knowledgeCutoffAt: cutoff,
    });
    expect(payload).toMatchObject({ status: "ok", rows: [], isPartial: false,
      notReadyReason: null });
  });

  it("uses day-proven creative identity and matching dated media for an unfiltered Ad card", async () => {
    dbQuery.mockResolvedValue([
      { date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-1" },
    ]);
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([adDay()] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(new Map([
      ["ad-1", { creativeId: "crt-current", projectionJson:
        buildProjectionRow({ creative_id: "crt-current",
          thumbnail_url: "https://example.com/current.jpg" }) }],
    ]) as never);
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([
      { providerAccountId: "act_1", date: "2026-04-03", adId: "ad-1",
        creativeId: "crt-current", thumbnailUrl: "https://example.com/wrong.jpg",
        payloadJson: {} },
      { providerAccountId: "act_1", date: "2026-04-03", adId: "ad-1",
        creativeId: "crt-1", thumbnailUrl: "https://example.com/proven.jpg",
        payloadJson: {} },
    ] as never);
    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1", providerAccountId: "act_1",
      start: "2026-04-03", end: "2026-04-03", groupBy: "ad",
      format: "all", sort: "spend", mediaMode: "full",
      knowledgeCutoffAt: cutoff,
    });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({ id: "ad-1", creative_id: "crt-1",
      thumbnail_url: "https://example.com/proven.jpg" });
  });

  it("leaves an unproved unfiltered Ad identity unresolved and does not use current or mismatched media", async () => {
    dbQuery.mockResolvedValue([]);
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([adDay()] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(new Map([
      ["ad-1", { creativeId: "crt-current", projectionJson:
        buildProjectionRow({ creative_id: "crt-current",
          thumbnail_url: "https://example.com/current.jpg" }) }],
    ]) as never);
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([
      { providerAccountId: "act_1", date: "2026-04-03", adId: "ad-1",
        creativeId: "crt-current", thumbnailUrl: "https://example.com/wrong.jpg",
        payloadJson: {} },
    ] as never);
    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1", providerAccountId: "act_1",
      start: "2026-04-03", end: "2026-04-03", groupBy: "ad",
      format: "all", sort: "spend", mediaMode: "full",
      knowledgeCutoffAt: cutoff,
    });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({ id: "ad-1",
      creative_id: "unresolved_ad:ad-1", thumbnail_url: null });
  });

  it("retains multi-day Ad economics but withholds a single creative image when its proved identity changed", async () => {
    dbQuery.mockResolvedValue([
      { date: "2026-04-03", ad_id: "ad-1", creative_id: "crt-1" },
      { date: "2026-04-04", ad_id: "ad-1", creative_id: "crt-2" },
    ]);
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(warehouse.getMetaAdDailyRange).mockResolvedValue([
      adDay(),
      { ...adDay(), date: "2026-04-04", spend: 10,
        updatedAt: "2026-04-05T02:00:00.000Z" },
    ] as never);
    vi.mocked(requestModelStore.readMetaAdDimensions).mockResolvedValue(new Map());
    vi.mocked(warehouse.getMetaCreativeMediaRange).mockResolvedValue([
      { providerAccountId: "act_1", date: "2026-04-03", adId: "ad-1",
        creativeId: "crt-1", thumbnailUrl: "https://example.com/first.jpg",
        payloadJson: {} },
      { providerAccountId: "act_1", date: "2026-04-04", adId: "ad-1",
        creativeId: "crt-2", thumbnailUrl: "https://example.com/second.jpg",
        payloadJson: {} },
    ] as never);
    const payload = await getMetaCreativesWarehousePayload({
      businessId: "biz-1", providerAccountId: "act_1",
      start: "2026-04-03", end: "2026-04-04", groupBy: "ad",
      format: "all", sort: "spend", mediaMode: "full",
      knowledgeCutoffAt: "2026-04-07T00:00:00.000Z",
    });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({ id: "ad-1", spend: 32.83,
      creative_id: "unresolved_ad:ad-1", thumbnail_url: null,
      source_creative_ids: ["crt-1", "crt-2"] });
  });

  it("uses the historical identity when the current ad dimension names a different creative", async () => {
    const payload = await readRecovered({ adDimensionCreativeId: "crt-other" });
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      creative_id: "crt-1",
      landing_page_views: 14,
      add_to_cart: 2,
    });
  });

  it("rejects a report fact first persisted or updated after the knowledge cutoff", async () => {
    const payload = await readRecovered({
      adDay: { ...adDay(), updatedAt: cutoff },
    });
    expect(payload.rows).toHaveLength(0);
  });

  it("requires a complete account receipt bracketing the local Ad-day and rejects late conflicting states", async () => {
    await readAdCreativeIdsForDays({
      businessId: "biz-1",
      providerAccountId: "act_1",
      requestedCreativeId: "crt-1",
      start: "2026-04-03",
      end: "2026-04-03",
      knowledgeCutoffAt: cutoff,
    });
    const query = String(dbQuery.mock.calls.at(-1)?.[0]);
    expect(query).toContain("WITH ad_days AS MATERIALIZED");
    expect(query).toContain("FROM (SELECT DISTINCT date, day_end FROM ad_days) bounds");
    expect(query).not.toContain("candidate_ads");
    expect(query).toContain("d.date::timestamp AT TIME ZONE d.account_timezone");
    expect(query).toContain("change.observed_at <= bracket.bracket_observed_at");
    expect(query).toContain("gone.observed_at <= bracket.bracket_observed_at");
    expect(query).toContain("authoritative.capture_status = 'complete'");
    expect(query).toContain("manifestContract' = 'd075.complete-scope-manifest.v1'");
    expect(query).toContain("authoritative.captured_at < $6::timestamptz");
    expect(query).toContain("d.updated_at < $6::timestamptz");
  });

  it("does not mark legacy folded creative-day membership complete", () => {
    const legacy = hydrateWarehouseCreativeMetrics({
      row: buildProjectionRow() as unknown as RawCreativeRow,
      factRow: buildCreativeFactRow({
        adId: "creative_group_handle",
        payloadJson: { real_ad_id: "ad-1", associated_ads_count: 1 },
      }) as never,
    });
    expect(legacy.source_ad_ids).toEqual(["ad-1"]);
    expect(legacy.source_ad_ids_complete).toBe(false);
    const versioned = hydrateWarehouseCreativeMetrics({
      row: buildProjectionRow() as unknown as RawCreativeRow,
      factRow: buildCreativeFactRow({
        adId: "creative_group_handle",
        payloadJson: {
          source_identity_version: "meta-creative-membership.v2",
          source_ad_ids: ["ad-1", "ad-2"],
          source_ad_ids_complete: true,
          source_creative_ids: ["crt-1"],
        },
      }) as never,
    });
    expect(versioned.source_ad_ids).toEqual(["ad-1", "ad-2"]);
    expect(versioned.source_ad_ids_complete).toBe(true);
  });

  it("publishes creative frequency only for verified single-Ad provider reach", () => {
    const projection = buildProjectionRow({ frequency: 9, metric_presence: { frequency: true } }) as RawCreativeRow;
    const single = hydrateWarehouseCreativeMetrics({
      row: projection,
      factRow: buildCreativeFactRow({ adId: "creative_group_handle", reach: 100, frequency: 1.5,
        payloadJson: { ...verifiedCreativeDayPayload(), reach_aggregation: "single_ad_provider_reach" } }) as never,
    });
    expect(single).toMatchObject({ frequency: 1.5, reach_aggregation: "single_ad_provider_reach",
      metric_presence: { frequency: true } });

    const multi = hydrateWarehouseCreativeMetrics({
      row: projection,
      factRow: buildCreativeFactRow({ adId: "creative_group_handle", reach: 200, frequency: 2,
        payloadJson: { ...verifiedCreativeDayPayload(), source_ad_ids: ["ad-1", "ad-2"],
          associated_ads_count: 2, reach_aggregation: "sum_of_ad_reach_not_deduplicated" } }) as never,
    });
    expect(multi).toMatchObject({ frequency: null,
      reach_aggregation: "sum_of_ad_reach_not_deduplicated", metric_presence: { frequency: false } });

    const legacy = hydrateWarehouseCreativeMetrics({
      row: projection,
      factRow: buildCreativeFactRow({ adId: "creative_group_handle", reach: 100, frequency: 2,
        payloadJson: verifiedCreativeDayPayload() }) as never,
    });
    expect(legacy).toMatchObject({ frequency: null, reach_aggregation: "unknown",
      metric_presence: { frequency: false } });
  });

  it("keeps finalized Ad frequency separate from creative reach aggregation", () => {
    const row = hydrateWarehouseCreativeMetrics({
      row: buildProjectionRow({ frequency: 9 }) as RawCreativeRow,
      factRow: buildAdFactRow({ reach: 80, frequency: 1.25 }) as never,
    });
    expect(row).toMatchObject({ frequency: 1.25, reach_aggregation: "single_ad_provider_reach",
      metric_presence: { frequency: true } });
  });
});

describe("readMetaCreativesWarehouseObservedAt", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /**
   * WHY: the age of a table is a property of the write that produced it, not of
   * the request that read it. The Assets bar used to be dated from the briefing
   * snapshot's `observedAt` — when a decision computation ran — and on a live
   * account the two were a day apart, so the chip aged the rows by a day they
   * had not aged. This reads `MAX(updated_at)` over the exact rows the payload
   * was built from and nothing else.
   */
  it("dates creative groupings from meta_creative_daily", async () => {
    dbQuery.mockResolvedValue([{ observed_at: "2026-08-18T04:34:04.744Z" }]);

    const observedAt = await readMetaCreativesWarehouseObservedAt({
      businessId: "biz_1",
      providerAccountId: "act_1",
      start: "2026-07-21",
      end: "2026-08-17",
      groupBy: "creative",
    });

    expect(observedAt).toBe("2026-08-18T04:34:04.744Z");
    const [text, params] = dbQuery.mock.calls[0]!;
    expect(text).toContain("FROM meta_creative_daily");
    expect(params).toEqual(["biz_1", "act_1", "2026-07-21", "2026-08-17"]);
  });

  /**
   * WHY: `getMetaCreativesWarehousePayload` builds ad and adName groupings from
   * `meta_ad_daily` and creative/adSet groupings from `meta_creative_daily`.
   * Reading the other table would date the rows from a sync that did not
   * produce them — the Landing Pages surface reads `groupBy=ad`.
   */
  it("dates ad groupings from meta_ad_daily", async () => {
    dbQuery.mockResolvedValue([{ observed_at: new Date("2026-08-18T04:59:40.635Z") }]);

    const observedAt = await readMetaCreativesWarehouseObservedAt({
      businessId: "biz_1",
      providerAccountId: "act_1",
      start: "2026-07-21",
      end: "2026-08-17",
      groupBy: "ad",
    });

    expect(observedAt).toBe("2026-08-18T04:59:40.635Z");
    expect(dbQuery.mock.calls[0]![0]).toContain("FROM meta_ad_daily");
  });

  /**
   * WHY: an unreadable timestamp is an unknown age, never a fresh one. Both an
   * empty window and a failed read must produce null so the surface says "age
   * unknown" instead of implying a currency it cannot support.
   */
  it.each([
    ["no rows in the window", async () => dbQuery.mockResolvedValue([{ observed_at: null }])],
    ["a failed read", async () => dbQuery.mockRejectedValue(new Error("connection reset"))],
  ])("returns null for %s", async (_label, arrange) => {
    await arrange();

    await expect(
      readMetaCreativesWarehouseObservedAt({
        businessId: "biz_1",
        providerAccountId: "act_1",
        start: "2026-07-21",
        end: "2026-08-17",
        groupBy: "creative",
      }),
    ).resolves.toBeNull();
  });
});
