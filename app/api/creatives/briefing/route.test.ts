import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import { readTriageState } from "@/lib/triage-events";
import { DECISION_CENTER_OBSERVABILITY_LOG_MARKER } from "@/lib/creative-decision-center";
import type { EngineV3Flags } from "@/lib/creative-decision-engine";
import { GET } from "./route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(async () => false),
}));

vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativesApiPayload: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine/feature-flags", () => ({
  resolveEngineV3Flags: vi.fn(),
}));

vi.mock("@/lib/meta/campaign-labels", () => ({
  readMetaCampaignLabels: vi.fn(),
}));

vi.mock("@/lib/triage-events", () => ({
  readTriageState: vi.fn(),
}));

const previousDataSourceFlag = process.env.DECISION_ENGINE_V3_DATA_SOURCE;
const previousObservabilityFlag = process.env.DECISION_CENTER_OBSERVABILITY;
const previousObservabilitySalt =
  process.env.DECISION_CENTER_OBSERVABILITY_SALT;

function makeFlags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: "biz_1",
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: true,
      shadowOnly: false,
    },
    ...overrides,
  };
}

function campaignLabel(
  kind: "main" | "test" | "mixed",
  testDimension: "creative" | null = null,
) {
  return {
    businessId: "biz_1",
    campaignId: "mock-campaign-001",
    kind,
    testDimension,
    source: "user" as const,
    providerAccountId: null,
    campaignName: "Mock Campaign",
    labeledBy: "user_1",
    labeledAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DECISION_ENGINE_V3_DATA_SOURCE = "mock";
  delete process.env.DECISION_CENTER_OBSERVABILITY;
  delete process.env.DECISION_CENTER_OBSERVABILITY_SALT;
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1", email: "operator@adsecute.com" } } as never,
    membership: {
      id: "membership_1",
      userId: "user_1",
      businessId: "biz_1",
      role: "guest",
      status: "active",
      joinedAt: "2026-05-07T00:00:00.000Z",
    },
  });
  vi.mocked(resolveEngineV3Flags).mockResolvedValue(makeFlags());
  vi.mocked(readMetaCampaignLabels).mockResolvedValue([campaignLabel("main")]);
  vi.mocked(readTriageState).mockResolvedValue({ rows: [], deferredCount: 0 });
  vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
    status: "ok",
    rows: [
      {
        id: "row_1",
        creative_id: "mock-creative-001",
        effective_status: "ACTIVE",
        real_ad_id: "ad_1",
        associated_ads_count: 1,
        account_id: "act_1",
        account_name: "Meta Account",
        campaign_id: "mock-campaign-001",
        campaign_name: "Mock Campaign",
        adset_id: "adset_1",
        adset_name: "Mock Adset",
        currency: "USD",
        name: "Mock Creative",
        launch_date: "2026-05-01",
        preview_url: "https://example.com/preview.jpg",
        preview_source: null,
        thumbnail_url: "https://example.com/thumb.jpg",
        image_url: "https://example.com/image.jpg",
        table_thumbnail_url: "https://example.com/table.jpg",
        card_preview_url: "https://example.com/card.jpg",
        cached_thumbnail_url: "https://example.com/cache.jpg",
        is_catalog: false,
        preview_state: "preview",
        preview: { render_mode: "image", image_url: "https://example.com/preview-object.jpg", video_url: null, poster_url: "https://example.com/poster.jpg", source: "preview_url", is_catalog: false },
        tags: [],
        ai_tags: {},
        format: "image",
        creative_type: "feed",
        creative_type_label: "Feed",
        creative_delivery_type: "standard",
        creative_visual_format: "video",
        creative_primary_type: "video",
        creative_primary_label: "Video",
        creative_secondary_type: null,
        creative_secondary_label: null,
        taxonomy_version: "v2",
        taxonomy_source: "deterministic",
        taxonomy_reconciled_by_video_evidence: false,
        spend: 500,
        purchase_value: 1500,
        roas: 3,
        cpa: 62.5,
        clicks: 100,
        cpc_link: 1,
        cpm: 10,
        ctr_all: 1.2,
        purchases: 8,
        impressions: 50000,
        link_clicks: 600,
        landing_page_views: 480,
        add_to_cart: 80,
        initiate_checkout: 40,
        thumbstop: 25,
        click_to_atc: 13.33,
        atc_to_purchase: 10,
        leads: 0,
        messages: 0,
        video25: 18,
        video50: 10,
        video75: 6,
        video100: 3,
      },
    ],
    media_mode: "metadata",
    media_hydrated: false,
  });
});

afterEach(() => {
  if (previousDataSourceFlag === undefined) {
    delete process.env.DECISION_ENGINE_V3_DATA_SOURCE;
  } else {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = previousDataSourceFlag;
  }
  if (previousObservabilityFlag === undefined) {
    delete process.env.DECISION_CENTER_OBSERVABILITY;
  } else {
    process.env.DECISION_CENTER_OBSERVABILITY = previousObservabilityFlag;
  }
  if (previousObservabilitySalt === undefined) {
    delete process.env.DECISION_CENTER_OBSERVABILITY_SALT;
  } else {
    process.env.DECISION_CENTER_OBSERVABILITY_SALT =
      previousObservabilitySalt;
  }
});

describe("GET /api/creatives/briefing", () => {
  it("classifies engine v3 decisions into briefing lanes server-side", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(payload.actionNow)).toBe(true);
    expect(Array.isArray(payload.watching)).toBe(true);
    expect(Array.isArray(payload.healthy)).toBe(true);
    const cards = [...payload.actionNow, ...payload.watching, ...payload.healthy];
    expect(cards[0]).toMatchObject({
      impressions: 50000,
      linkClicks: 600,
      addToCart: 80,
      campaignKind: "main",
      campaignLabelStatus: "labeled",
      label: "scale",
      primary: { kind: "scale_budget", label: "Scale budget" },
      mediaPreviewUrl: "https://example.com/card.jpg",
      tableThumbnailUrl: "https://example.com/table.jpg",
      cardPreviewUrl: "https://example.com/card.jpg",
      previewUrl: "https://example.com/preview.jpg",
      imageUrl: "https://example.com/image.jpg",
      cachedThumbnailUrl: "https://example.com/cache.jpg",
      previewState: "preview",
      format: "image",
      creativeVisualFormat: "video",
      creativePrimaryType: "video",
      creativePrimaryLabel: "Video",
      creativeDeliveryType: "standard",
      taxonomySource: expect.any(String),
      taxonomyReconciledByVideoEvidence: expect.anything(),
      engineVersion: expect.any(String),
      sourceAsOf: "2026-05-07",
      sourceDataSource: expect.any(String),
      profileScope: expect.stringContaining(":"),
    });
    expect(payload.pulse.engineVersion).toBeTruthy();
    expect(payload.statusFilter).toBe("active");
    expect(JSON.stringify(payload)).not.toContain("buyerAction");
    expect(JSON.stringify(payload)).not.toContain("brief_variation");
    expect(requireBusinessAccess).toHaveBeenCalledWith({
      request: expect.any(NextRequest),
      businessId: "biz_1",
      minRole: "guest",
    });
  });

  it("hydrates synthetic grouped creative ids with real Meta ad ids", async () => {
    const syntheticCreativeRow = {
      id: "creative_synthetic",
      creative_id: "mock-creative-001",
      effective_status: "ACTIVE",
      real_ad_id: "creative_synthetic",
      associated_ads_count: 1,
      account_id: "act_1",
      account_name: "Meta Account",
      campaign_id: "mock-campaign-001",
      campaign_name: "Mock Campaign",
      adset_id: "adset_1",
      adset_name: "Mock Adset",
      currency: "USD",
      name: "Mock Creative",
      launch_date: "2026-05-01",
      preview_url: "https://example.com/preview.jpg",
      preview_source: null,
      thumbnail_url: "https://example.com/thumb.jpg",
      image_url: "https://example.com/image.jpg",
      table_thumbnail_url: "https://example.com/table.jpg",
      card_preview_url: "https://example.com/card.jpg",
      cached_thumbnail_url: "https://example.com/cache.jpg",
      is_catalog: false,
      preview_state: "preview" as const,
      preview: { render_mode: "image" as const, image_url: "https://example.com/preview-object.jpg", video_url: null, poster_url: "https://example.com/poster.jpg", source: "preview_url" as const, is_catalog: false },
      tags: [],
      ai_tags: {},
      format: "image",
      creative_type: "feed",
      creative_type_label: "Feed",
      creative_delivery_type: "standard",
      creative_visual_format: "image",
      creative_primary_type: "standard",
      creative_primary_label: null,
      creative_secondary_type: null,
      creative_secondary_label: null,
      spend: 500,
      purchase_value: 1500,
      roas: 3,
      cpa: 62.5,
      clicks: 100,
      cpc_link: 1,
      cpm: 10,
      ctr_all: 1.2,
      purchases: 8,
      impressions: 50000,
      link_clicks: 600,
      landing_page_views: 480,
      add_to_cart: 80,
      initiate_checkout: 40,
      thumbstop: 25,
      click_to_atc: 13.33,
      atc_to_purchase: 10,
      leads: 0,
      messages: 0,
      video25: 18,
      video50: 10,
      video75: 6,
      video100: 3,
    };
    vi.mocked(getMetaCreativesApiPayload)
      .mockResolvedValueOnce({
        status: "ok",
        rows: [syntheticCreativeRow as never],
        media_mode: "metadata",
        media_hydrated: false,
      })
      .mockResolvedValueOnce({
        status: "ok",
        rows: [
          {
            ...syntheticCreativeRow,
            id: "120000000000001",
            real_ad_id: "120000000000001",
          } as never,
        ],
        media_mode: "metadata",
        media_hydrated: false,
      });

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07"),
    );
    const payload = await response.json();
    const cards = [...payload.actionNow, ...payload.watching, ...payload.healthy];

    expect(response.status).toBe(200);
    expect(cards[0]).toMatchObject({
      id: "creative_synthetic",
      adId: "120000000000001",
      realAdId: "120000000000001",
    });
    expect(getMetaCreativesApiPayload).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ groupBy: "creative" }),
    );
    expect(getMetaCreativesApiPayload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ groupBy: "ad" }),
    );
  });

  it("maps scale primary actions by campaign kind server-side", async () => {
    vi.mocked(readMetaCampaignLabels).mockResolvedValue([campaignLabel("test", "creative")]);

    const testResponse = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07"),
    );
    const testPayload = await testResponse.json();
    const testCards = [
      ...testPayload.actionNow,
      ...testPayload.watching,
      ...testPayload.healthy,
    ];

    expect(testCards[0]).toMatchObject({
      campaignKind: "test",
      label: "scale",
      primary: { kind: "promote", label: "Promote to main" },
    });

    vi.mocked(readMetaCampaignLabels).mockResolvedValue([campaignLabel("mixed")]);

    const mixedResponse = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07"),
    );
    const mixedPayload = await mixedResponse.json();
    const mixedCards = [
      ...mixedPayload.actionNow,
      ...mixedPayload.watching,
      ...mixedPayload.healthy,
    ];

    expect(mixedCards[0]).toMatchObject({
      campaignKind: "mixed",
      label: "scale",
      primary: {
        kind: "controlled_scale",
        label: "Review structure & scale",
      },
    });
  });

  it("returns empty lanes when engine v3 is disabled", async () => {
    vi.mocked(resolveEngineV3Flags).mockResolvedValue(makeFlags({ enabled: false }));

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("disabled");
    expect(payload.statusFilter).toBe("active");
    expect(payload.actionNow).toEqual([]);
    expect(payload.watching).toEqual([]);
    expect(payload.healthy).toEqual([]);
    // PR7A: disabled path must NOT auto-expose decisionCenter.
    expect(payload).not.toHaveProperty("decisionCenter");
  });

  it("omits decisionCenter from the default response (PR7A)", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).not.toHaveProperty("decisionCenter");
    // Existing legacy assertions still hold.
    expect(payload.statusFilter).toBe("active");
    expect(Array.isArray(payload.actionNow)).toBe(true);
    expect(Array.isArray(payload.watching)).toBe(true);
    expect(Array.isArray(payload.healthy)).toBe(true);
    expect(payload.pulse.engineVersion).toBeTruthy();
    expect(payload.source.dataSource).toBe("mock");
  });

  it("emits a validated bridged decisionCenter snapshot when ?decisionCenter=1 is set (PR7C)", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decisionCenter=1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionCenter).not.toBeNull();
    expect(payload.decisionCenter).toMatchObject({
      contractVersion: "creative-decision-center.v2.1",
      adapterVersion:
        "creative-decision-center.v3-bridge.v1+creative-decision-center.shadow-adapter.v1",
      configVersion: "creative-decision-engine.config.v1",
      generatedAt: "2026-05-07T00:00:00.000Z",
      aggregateDecisions: [],
      todayBrief: [],
      missingDataSummary: {},
      inputCoverageSummary: {},
    });
    expect(payload.decisionCenter.rowDecisions).toHaveLength(1);
    expect(payload.decisionCenter.rowDecisions[0]).toMatchObject({
      scope: "creative",
      creativeId: "mock-creative-001",
      rowId: "row_1",
      identityGrain: "creative",
      familyId: null,
      buyerAction: "scale",
      executionAction: "scale_budget",
      sourceDecision: "v3:scale",
      engine: {
        contractVersion: "creative-decision-os.v2.1",
        primaryDecision: "Scale",
        problemClass: "performance",
        actionability: "review_only",
        queueEligible: false,
        applyEligible: false,
      },
    });
    expect(payload.decisionCenter.dataFreshness.status).toMatch(
      /^(fresh|stale)$/,
    );
    expect(payload.decisionCenter.engineVersion).toBeTruthy();
    expect(payload.decisionCenter.actionBoard.scale).toEqual(["row_1"]);
    expect(Object.keys(payload.decisionCenter.actionBoard)).toEqual([
      "scale",
      "cut",
      "refresh",
      "protect",
      "test_more",
      "watch_launch",
      "fix_delivery",
      "fix_policy",
      "diagnose_data",
    ]);
    expect(payload.decisionCenter.actionBoard.cut).toEqual([]);
    expect(payload.decisionCenter.actionBoard.refresh).toEqual([]);
    expect(payload.decisionCenter.actionBoard.diagnose_data).toEqual([]);
    expect(payload.decisionCenter.aggregateDecisions).toEqual([]);
    for (const row of payload.decisionCenter.rowDecisions) {
      expect(row.buyerAction).not.toBe("brief_variation");
      expect(row.uiBucket).not.toBe("brief_variation");
    }
    // Legacy payload assertions remain intact.
    expect(payload.statusFilter).toBe("active");
    expect(Array.isArray(payload.actionNow)).toBe(true);
    expect(payload.source.dataSource).toBe("mock");
  });

  it("keeps campaign-kind execution actions in the flagged decisionCenter snapshot (PR7C)", async () => {
    vi.mocked(readMetaCampaignLabels).mockResolvedValue([campaignLabel("test", "creative")]);

    const testResponse = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decisionCenter=1",
      ),
    );
    const testPayload = await testResponse.json();
    expect(testPayload.decisionCenter.rowDecisions[0]).toMatchObject({
      buyerAction: "scale",
      executionAction: "promote_to_main",
    });

    vi.mocked(readMetaCampaignLabels).mockResolvedValue([campaignLabel("mixed")]);

    const mixedResponse = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decision_center=true",
      ),
    );
    const mixedPayload = await mixedResponse.json();
    expect(mixedPayload.decisionCenter.rowDecisions[0]).toMatchObject({
      buyerAction: "scale",
      executionAction: "controlled_scale",
    });
  });

  it("keeps unlabeled scale execution blocked in the flagged decisionCenter snapshot (PR7C)", async () => {
    vi.mocked(readMetaCampaignLabels).mockResolvedValue([]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decisionCenter=1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionCenter.rowDecisions[0]).toMatchObject({
      buyerAction: "diagnose_data",
      executionAction: null,
      sourceDecision: "v3:diagnose",
      engine: {
        primaryDecision: "Diagnose",
        actionability: "diagnose",
        queueEligible: false,
        applyEligible: false,
      },
    });
    expect(payload.decisionCenter.actionBoard.diagnose_data).toEqual(["row_1"]);
  });

  it("fails closed to a null decisionCenter when shadow snapshot assembly cannot validate (PR7C)", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=not-a-date&decisionCenter=1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionCenter).toBeNull();
    expect(payload.actionNow).toEqual(expect.any(Array));
    expect(payload.source.dataSource).toBe("mock");
  });

  it("rejects falsy/adversarial decisionCenter values and omits the field (PR7A)", async () => {
    for (const value of ["0", "false", "no", "", " ", "<huge>".repeat(2000)]) {
      const response = await GET(
        new NextRequest(
          `http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decisionCenter=${encodeURIComponent(value)}`,
        ),
      );
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload).not.toHaveProperty("decisionCenter");
    }
  });

  it("emits the empty decisionCenter snapshot on the disabled path only when explicitly requested (PR7A)", async () => {
    vi.mocked(resolveEngineV3Flags).mockResolvedValue(makeFlags({ enabled: false }));

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decision_center=true",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("disabled");
    expect(payload.decisionCenter).toMatchObject({
      contractVersion: "creative-decision-center.v2.1",
      engineVersion: "disabled",
      rowDecisions: [],
      aggregateDecisions: [],
      todayBrief: [],
    });
  });

  it.each([
    {
      name: "default env without flag",
      env: undefined,
      flag: false,
      expectsLogs: false,
    },
    {
      name: "default env with flag",
      env: undefined,
      flag: true,
      expectsLogs: false,
    },
    {
      name: "enabled env without flag",
      env: "1",
      flag: false,
      expectsLogs: false,
    },
    {
      name: "enabled env with flag",
      env: "1",
      flag: true,
      expectsLogs: true,
    },
    {
      name: "false env with flag",
      env: "false",
      flag: true,
      expectsLogs: false,
    },
    {
      name: "blank env with flag",
      env: " ",
      flag: true,
      expectsLogs: false,
    },
  ])(
    "gates Decision Center observability logs with an AND gate: $name (PR13)",
    async ({ env, flag, expectsLogs }) => {
      if (env === undefined) {
        delete process.env.DECISION_CENTER_OBSERVABILITY;
      } else {
        process.env.DECISION_CENTER_OBSERVABILITY = env;
      }
      process.env.DECISION_CENTER_OBSERVABILITY_SALT = "test-salt";
      const infoSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const url = flag
        ? "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decisionCenter=1"
        : "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07";

      const response = await GET(new NextRequest(url));
      const payload = await response.json();

      expect(response.status).toBe(200);
      if (!expectsLogs) {
        expect(infoSpy).not.toHaveBeenCalled();
        infoSpy.mockRestore();
        return;
      }

      expect(payload.decisionCenter).not.toBeNull();
      expect(infoSpy).toHaveBeenCalled();
      for (const call of infoSpy.mock.calls) {
        expect(call[0]).toBe(DECISION_CENTER_OBSERVABILITY_LOG_MARKER);
        expect(typeof call[1]).toBe("string");
        const event = JSON.parse(call[1] as string);
        expect(event).toMatchObject({
          version: "creative-decision-center.observability.v1",
          businessIdHash: expect.stringMatching(/^salted:business:/),
          snapshotId: expect.stringMatching(/^salted:snapshot:/),
          route: "GET /api/creatives/briefing",
          decisionCenterRequested: true,
        });
      }
      const logged = JSON.stringify(infoSpy.mock.calls);
      expect(logged).not.toContain("biz_1");
      expect(logged).not.toContain("act_1");
      expect(logged).not.toContain("mock-creative-001");
      expect(logged).not.toContain("row_1");
      expect(logged).not.toContain("https://example.com");
      expect(logged).not.toContain("Mock Creative");
      expect(logged).toContain("decision_center.snapshot_observed");
      expect(logged).toContain("decision_center.row_distribution");
      infoSpy.mockRestore();
    },
  );

  it("marks observability hashes as unsalted when the salt env is absent (PR13)", async () => {
    process.env.DECISION_CENTER_OBSERVABILITY = "enabled";
    delete process.env.DECISION_CENTER_OBSERVABILITY_SALT;
    const infoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decisionCenter=1",
      ),
    );

    expect(response.status).toBe(200);
    expect(infoSpy).toHaveBeenCalled();
    const firstEvent = JSON.parse(infoSpy.mock.calls[0][1] as string);
    expect(firstEvent.businessIdHash).toMatch(/^unsalted:business:/);
    expect(firstEvent.snapshotId).toMatch(/^unsalted:snapshot:/);
    infoSpy.mockRestore();
  });

  it("keeps the briefing response intact when observability logging throws (PR13)", async () => {
    process.env.DECISION_CENTER_OBSERVABILITY = "true";
    process.env.DECISION_CENTER_OBSERVABILITY_SALT = "test-salt";
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("telemetry failed");
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decisionCenter=1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionCenter).not.toBeNull();
    expect(payload.actionNow).toEqual(expect.any(Array));
    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("surfaces missing campaign label context in cards", async () => {
    vi.mocked(readMetaCampaignLabels).mockResolvedValue([]);

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07"),
    );
    const payload = await response.json();
    const cards = [...payload.actionNow, ...payload.watching, ...payload.healthy];

    expect(response.status).toBe(200);
    expect(cards[0]).toMatchObject({
      campaignLabelStatus: "unlabeled",
      campaignKind: null,
      blockedActionType: "scale",
      primary: { kind: "review", label: "Open evidence" },
    });
  });

  it("returns auth errors unchanged", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "auth_error" }, { status: 401 }),
    });

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1"),
    );

    expect(response.status).toBe(401);
    expect(resolveEngineV3Flags).not.toHaveBeenCalled();
  });

  it("prefers engine input status over stale grouped creative-row status", async () => {
    vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "row_1",
          creative_id: "mock-creative-001",
          effective_status: "PAUSED",
          real_ad_id: "ad_1",
          associated_ads_count: 1,
          account_id: "act_1",
          account_name: "Meta Account",
          campaign_id: "mock-campaign-001",
          campaign_name: "Mock Campaign",
          adset_id: "adset_1",
          adset_name: "Mock Adset",
          currency: "USD",
          name: "Mock Creative",
          launch_date: "2026-05-01",
          preview_url: null,
          preview_source: null,
          thumbnail_url: null,
          image_url: null,
          is_catalog: false,
          preview_state: "unavailable",
          preview: { render_mode: "unavailable", image_url: null, video_url: null, poster_url: null, source: null, is_catalog: false },
          tags: [],
          ai_tags: {},
          format: "image",
          creative_type: "feed",
          creative_type_label: "Feed",
          creative_delivery_type: "standard",
          creative_visual_format: "image",
          creative_primary_type: "standard",
          creative_primary_label: null,
          creative_secondary_type: null,
          creative_secondary_label: null,
          spend: 500,
          purchase_value: 1500,
          roas: 3,
          cpa: 62.5,
          clicks: 100,
          cpc_link: 1,
          cpm: 10,
          ctr_all: 1.2,
          purchases: 8,
          impressions: 50000,
          link_clicks: 600,
          landing_page_views: 480,
          add_to_cart: 80,
          initiate_checkout: 40,
          thumbstop: 25,
          click_to_atc: 13.33,
          atc_to_purchase: 10,
          leads: 0,
          messages: 0,
          video25: 18,
          video50: 10,
          video75: 6,
          video100: 3,
        },
      ],
      media_mode: "metadata",
      media_hydrated: false,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    const cards = [...payload.actionNow, ...payload.watching, ...payload.healthy];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      creativeId: "mock-creative-001",
      status: "ACTIVE",
    });
  });
});
