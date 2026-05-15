import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import { readTriageState } from "@/lib/triage-events";
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DECISION_ENGINE_V3_DATA_SOURCE = "mock";
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
  vi.mocked(readMetaCampaignLabels).mockResolvedValue([
    {
      businessId: "biz_1",
      campaignId: "mock-campaign-001",
      kind: "main",
      testDimension: null,
      source: "user",
      providerAccountId: null,
      campaignName: "Mock Campaign",
      labeledBy: "user_1",
      labeledAt: "2026-05-07T00:00:00.000Z",
      updatedAt: "2026-05-07T00:00:00.000Z",
    },
  ]);
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
});

afterEach(() => {
  if (previousDataSourceFlag === undefined) {
    delete process.env.DECISION_ENGINE_V3_DATA_SOURCE;
  } else {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = previousDataSourceFlag;
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

  it("filters paused creatives out of briefing lanes by default", async () => {
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
    expect(payload.actionNow).toEqual([]);
    expect(payload.watching).toEqual([]);
    expect(payload.healthy).toEqual([]);
  });
});
