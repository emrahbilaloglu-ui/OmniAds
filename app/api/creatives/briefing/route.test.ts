import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import { resolveEngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import {
  DEMO_BUSINESS_ID,
  getDemoMetaCreatives,
} from "@/lib/demo-business";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import { readMetaNativeCanonicalDecisionInventory } from "@/lib/meta/decisions-workspace-read-model";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { readTriageState } from "@/lib/triage-events";
import {
  buildBriefingDecisionOriginAdActionRequest,
  hasNativeDecisionOriginLineage,
} from "@/components/creatives/briefing/action-handlers";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
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

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(async () => ["act_1"]),
}));

vi.mock("@/lib/creative-decision-engine/feature-flags", () => ({
  resolveEngineV3Flags: vi.fn(),
}));

vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  readMetaNativeCanonicalDecisionInventory: vi.fn(),
}));

vi.mock("@/lib/triage-events", () => ({
  readTriageState: vi.fn(),
}));

const previousDataSourceFlag = process.env.DECISION_ENGINE_V3_DATA_SOURCE;
const previousDecisionCenterDefaultDisabled =
  process.env.DECISION_CENTER_DEFAULT_DISABLED;

const INPUT_HASH = "1".repeat(64);
const DECISION_HASH = "2".repeat(64);

function canonicalDecision(
  input: {
    adId?: string;
    creativeId?: string | null;
    campaignId?: string;
    label?: string;
    buyerAction?: "scale" | "cut" | "refresh" | null;
    authorizedAction?: "scale" | "cut" | "refresh" | null;
    actionEligible?: boolean;
    decisionState?: "act" | "monitor" | "blocked" | "not_applicable";
    executionAction?:
      "promote_to_main" | "scale_budget" | "controlled_scale" | null;
    lifecycleRole?: "main" | "test" | "mixed" | "label_needed";
    inputHash?: string;
    decisionHash?: string;
  } = {},
): MetaCanonicalDecision {
  const adId = input.adId ?? "ad_1";
  const creativeId =
    input.creativeId === undefined ? "mock-creative-001" : input.creativeId;
  const label = input.label ?? "scale";
  const buyerAction =
    input.buyerAction === undefined ? "scale" : input.buyerAction;
  const authorizedAction =
    input.authorizedAction === undefined ? buyerAction : input.authorizedAction;
  const actionEligible = input.actionEligible ?? buyerAction !== null;
  const lifecycleRole = input.lifecycleRole ?? "main";
  return {
    decisionId: `decision_${adId}`,
    episodeId: `episode_${adId}`,
    episodeStartedAt: "2026-05-07T03:00:00.000Z",
    providerAccountId: "act_1",
    identityGrain: "ad",
    sourceSnapshotId: `snapshot_${adId}`,
    sourceAuthority: {
      status: "native_exact",
      actionEligible,
      reviewOnlyReason: actionEligible ? null : "review_only_fixture",
      snapshotId: `snapshot_${adId}`,
      evaluationId: `evaluation_${adId}`,
      inputHash: input.inputHash ?? INPUT_HASH,
      decisionHash: input.decisionHash ?? DECISION_HASH,
      providerAccountRefId: "provider-ref-1",
      engineVersion: "native-ad-engine.v1",
      realAdId: adId,
      authorizedAction,
      jobRunId: "job-run-1",
    },
    sourceDecision: {
      label,
      preAuthorityLabel: label,
      authorityBlocker: null,
      rawLabel: label,
      reason: `Persisted ${label} verdict for ${adId}`,
      confidence: 91,
      confidenceBand: "high",
      truthSource: "commercial_truth",
      engineVersion: "native-ad-engine.v1",
      snapshotAsOf: "2026-05-07",
      computedAt: "2026-05-07T03:05:00.000Z",
      badges: [],
    },
    parentChain: {
      campaign: {
        id: input.campaignId ?? "mock-campaign-001",
        name: "Mock Campaign",
      },
      adset: { id: "adset_1", name: "Mock Adset" },
      ad: { id: adId, name: `Ad ${adId}` },
      creative: creativeId ? { id: creativeId, name: "Shared Creative" } : null,
    },
    identityResolution: {
      basis: "native_ad_exact",
      candidateAdCount: 1,
      metricsEquivalent: true,
      adActionEligible: true,
    },
    media: {
      state: "available",
      thumbnail: { url: `https://example.com/${adId}.jpg` },
    },
    deliveryScope: {
      state: "active",
      campaignStatus: "ACTIVE",
      adsetStatus: "ACTIVE",
      adStatus: "ACTIVE",
    },
    classification: {
      lifecycleRole: { value: lifecycleRole },
      decisionState:
        input.decisionState ?? (actionEligible ? "act" : "blocked"),
      heldAction: actionEligible ? null : buyerAction,
      buyerAction,
      buyerLabel: buyerAction ? `Buyer ${buyerAction}` : "Review evidence",
      executionAction:
        input.executionAction === undefined
          ? "scale_budget"
          : input.executionAction,
      resolution: actionEligible
        ? null
        : {
            code: "review_only_fixture",
            category: "system",
            nextStep: "Review canonical evidence",
          },
      blockers: actionEligible
        ? []
        : [{ code: "review_only_fixture", label: "Review only" }],
    },
    metrics: {
      spend: 500,
      purchases: 8,
      roas: 3,
      recent7dRoas: 2.8,
      effectiveTargetRoas: 2.2,
      ratioToTarget: 1.36,
      currency: "USD",
    },
  } as unknown as MetaCanonicalDecision;
}

function generation(items: MetaCanonicalDecision[]) {
  return {
    status: "available" as const,
    generation: {
      jobRunId: "job-run-1",
      asOfDate: "2026-05-07",
      providerAccountRefId: "provider-ref-1",
      manifestHash: "a".repeat(64),
      expectedAdCount: items.length,
    },
    items,
    unavailableReason: null,
  };
}

function creativeRow(adId = "ad_1", creativeId = "mock-creative-001") {
  return {
    id: adId,
    creative_id: creativeId,
    real_ad_id: adId,
    effective_status: "ACTIVE",
    associated_ads_count: 1,
    account_id: "act_1",
    account_name: "Meta Account",
    campaign_id: "mock-campaign-001",
    campaign_name: "Mock Campaign",
    adset_id: "adset_1",
    adset_name: "Mock Adset",
    currency: "USD",
    name: `Ad ${adId}`,
    launch_date: "2026-05-01",
    preview_url: `https://example.com/${adId}-preview.jpg`,
    preview_source: null,
    thumbnail_url: `https://example.com/${adId}-thumb.jpg`,
    image_url: `https://example.com/${adId}-image.jpg`,
    table_thumbnail_url: `https://example.com/${adId}-table.jpg`,
    card_preview_url: `https://example.com/${adId}-card.jpg`,
    cached_thumbnail_url: `https://example.com/${adId}-cache.jpg`,
    is_catalog: false,
    preview_state: "preview" as const,
    preview: {
      render_mode: "image" as const,
      image_url: `https://example.com/${adId}.jpg`,
      video_url: null,
      poster_url: null,
      source: "preview_url" as const,
      is_catalog: false,
    },
    tags: [],
    ai_tags: {},
    format: "image" as const,
    creative_type: "feed" as const,
    creative_type_label: "Feed",
    creative_delivery_type: "standard" as const,
    creative_visual_format: "image" as const,
    creative_primary_type: "standard" as const,
    creative_primary_label: "Standard",
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
    impressions: 50_000,
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
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDemoBusiness).mockResolvedValue(false);
  process.env.DECISION_ENGINE_V3_DATA_SOURCE = "mock";
  delete process.env.DECISION_CENTER_DEFAULT_DISABLED;
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: {
      user: { id: "user_1", email: "operator@adsecute.com" },
    } as never,
    membership: {
      id: "membership_1",
      userId: "user_1",
      businessId: "biz_1",
      role: "guest",
      status: "active",
      joinedAt: "2026-05-07T00:00:00.000Z",
    },
  });
  vi.mocked(resolveEngineV3Flags).mockResolvedValue({
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
  });
  vi.mocked(readTriageState).mockResolvedValue({ rows: [], deferredCount: 0 });
  vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
    status: "ok",
    rows: [creativeRow()],
    media_mode: "metadata",
    media_hydrated: false,
  });
  vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
    generation([canonicalDecision()]),
  );
});

afterEach(() => {
  if (previousDataSourceFlag === undefined) {
    delete process.env.DECISION_ENGINE_V3_DATA_SOURCE;
  } else {
    process.env.DECISION_ENGINE_V3_DATA_SOURCE = previousDataSourceFlag;
  }
  if (previousDecisionCenterDefaultDisabled === undefined) {
    delete process.env.DECISION_CENTER_DEFAULT_DISABLED;
  } else {
    process.env.DECISION_CENTER_DEFAULT_DISABLED =
      previousDecisionCenterDefaultDisabled;
  }
});

describe("GET /api/creatives/briefing canonical native-ad authority", () => {
  it("serves an exact native card with the complete producer-to-handler lineage", async () => {
    const exactAdId = "100000000000001";
    vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [creativeRow(exactAdId)],
      media_mode: "metadata",
      media_hydrated: false,
    });
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      generation([
        canonicalDecision({
          adId: exactAdId,
          label: "cut",
          buyerAction: "cut",
          authorizedAction: "cut",
          executionAction: null,
        }),
      ]),
    );
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();
    const card = payload.actionNow[0] as BriefingCreativeCard;

    expect(response.status).toBe(200);
    expect(card).toMatchObject({
      id: exactAdId,
      adId: exactAdId,
      realAdId: exactAdId,
      creativeId: "mock-creative-001",
      label: "cut",
      primary: { kind: "cut", label: "Cut" },
      sourceDecisionSnapshotId: `snapshot_${exactAdId}`,
      sourceDecisionEvaluationId: `evaluation_${exactAdId}`,
      sourceDecisionInputHash: INPUT_HASH,
      sourceDecisionHash: DECISION_HASH,
      sourceDecisionProviderAccountRefId: "provider-ref-1",
      sourceDecisionJobRunId: "job-run-1",
      sourceDecisionAuthorizedAction: "cut",
      sourceDecisionActionEligible: true,
      sourceDecisionSnapshotMatch: "matched",
      canonicalDecision: {
        contractVersion: "briefing-canonical-native-ad.v1",
        identityGrain: "ad",
        adId: exactAdId,
        classification: { buyerAction: "cut" },
      },
    });
    expect(hasNativeDecisionOriginLineage(card)).toBe(true);
    expect(
      buildBriefingDecisionOriginAdActionRequest({
        businessId: "biz_1",
        card,
        action: "pause",
      }),
    ).toMatchObject({
      businessId: "biz_1",
      providerAccountId: "act_1",
      adId: exactAdId,
      snapshotId: `snapshot_${exactAdId}`,
      evaluationId: `evaluation_${exactAdId}`,
      engineVersion: "native-ad-engine.v1",
      decisionHash: DECISION_HASH,
      action: "pause",
    });
    expect(payload.source).toMatchObject({
      dataSource: "native_ad_generation",
      canonicalDecisionInventory: {
        status: "available",
        itemCount: 1,
        generation: { jobRunId: "job-run-1", expectedAdCount: 1 },
      },
    });
    expect(payload.decisionCenter.rowDecisions[0]).toMatchObject({
      rowId: exactAdId,
      identityGrain: "ad",
      buyerAction: "cut",
      sourceDecision: "native:cut",
    });
    expect(payload.decisionCenter.actionBoard.cut).toEqual([exactAdId]);
    expect(getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: "ad" }),
    );
  });

  it("serves Cut and Main Scale together without turning monitor-only Scale into authority", async () => {
    const mainScale = canonicalDecision({
      adId: "ad_main_scale",
      label: "scale",
      buyerAction: "scale",
      authorizedAction: null,
      actionEligible: false,
      decisionState: "monitor",
      lifecycleRole: "main",
      executionAction: "scale_budget",
    });
    mainScale.sourceAuthority!.reviewOnlyReason =
      "served_decision_is_not_actionable";
    mainScale.classification.heldAction = null;
    mainScale.classification.resolution = null;
    mainScale.classification.blockers = [];
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      generation([
        canonicalDecision({
          adId: "ad_cut",
          label: "cut",
          buyerAction: "cut",
          authorizedAction: "cut",
          executionAction: null,
        }),
        mainScale,
      ]),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source.canonicalDecisionInventory).toMatchObject({
      status: "available",
      itemCount: 2,
    });
    expect(payload.actionNow).toEqual([
      expect.objectContaining({
        id: "ad_cut",
        sourceDecisionAuthorizedAction: "cut",
        sourceDecisionActionEligible: true,
      }),
    ]);
    expect(payload.watching).toEqual([
      expect.objectContaining({
        id: "ad_main_scale",
        campaignKind: "main",
        sourceDecisionAuthorizedAction: null,
        sourceDecisionActionEligible: false,
        canonicalDecision: expect.objectContaining({
          classification: expect.objectContaining({
            decisionState: "monitor",
            buyerAction: "scale",
          }),
        }),
      }),
    ]);
  });

  it("keeps an exact Ad with missing creative identity review-only", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      generation([
        canonicalDecision({
          creativeId: null,
          label: "cut",
          buyerAction: "cut",
          authorizedAction: "cut",
          executionAction: null,
        }),
      ]),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();
    const card = payload.watching[0] as BriefingCreativeCard;

    expect(response.status).toBe(200);
    expect(payload.actionNow).toHaveLength(0);
    expect(card).toMatchObject({
      id: "ad_1",
      creativeId: null,
      sourceDecisionActionEligible: false,
      sourceDecisionAuthorizedAction: null,
      canonicalDecision: {
        creativeId: null,
        identityResolution: { adActionEligible: false },
        sourceAuthority: {
          actionEligible: false,
          authorizedAction: null,
          reviewOnlyReason: "current_creative_identity_is_missing",
        },
      },
    });
    expect(hasNativeDecisionOriginLineage(card)).toBe(false);
  });

  it("preserves two exact ads that share one creative without cross-target lineage", async () => {
    const decisions = [
      canonicalDecision({ adId: "ad_1" }),
      canonicalDecision({
        adId: "ad_2",
        label: "cut",
        buyerAction: "cut",
        authorizedAction: "cut",
        executionAction: null,
      }),
    ];
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      generation(decisions),
    );
    vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [creativeRow("ad_1"), creativeRow("ad_2")],
      media_mode: "metadata",
      media_hydrated: false,
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();
    const cards = [
      ...payload.actionNow,
      ...payload.watching,
      ...payload.healthy,
    ];

    expect(cards).toHaveLength(2);
    expect(cards.map((card: BriefingCreativeCard) => card.id).sort()).toEqual([
      "ad_1",
      "ad_2",
    ]);
    expect(
      cards.map((card: BriefingCreativeCard) => ({
        adId: card.realAdId,
        snapshotId: card.sourceDecisionSnapshotId,
        evaluationId: card.sourceDecisionEvaluationId,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          adId: "ad_1",
          snapshotId: "snapshot_ad_1",
          evaluationId: "evaluation_ad_1",
        },
        {
          adId: "ad_2",
          snapshotId: "snapshot_ad_2",
          evaluationId: "evaluation_ad_2",
        },
      ]),
    );
    expect(payload.decisionCenter.rowDecisions).toHaveLength(2);
  });

  it("applies creative-scoped defer state to every exact ad sharing that creative", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      generation([
        canonicalDecision({ adId: "ad_1", creativeId: "creative_1" }),
        canonicalDecision({ adId: "ad_2", creativeId: "creative_1" }),
      ]),
    );
    vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [creativeRow("ad_1"), creativeRow("ad_2")],
      media_mode: "metadata",
      media_hydrated: false,
    });
    vi.mocked(readTriageState).mockResolvedValue({
      rows: [
        {
          businessId: "biz_1",
          scopeType: "creative",
          scopeId: "creative_1",
          action: "deferred",
          timestamp: "2026-05-07T04:00:00.000Z",
          reappearAt: null,
        },
      ],
      deferredCount: 1,
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.actionNow).toEqual([]);
    expect(
      payload.watching
        .map((card: BriefingCreativeCard) => card.realAdId)
        .sort(),
    ).toEqual(["ad_1", "ad_2"]);
    expect(payload.deferredCount).toBe(2);
    expect(payload.source.laneSummary).toMatchObject({
      actionNow: 0,
      deferred: 2,
    });
  });

  it("reports the persisted generation date instead of restating the requested date", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-09",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source.asOf).toBe("2026-05-07");
    expect(payload.source.canonicalDecisionInventory.generation.asOfDate).toBe(
      "2026-05-07",
    );
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith({
      businessId: "biz_1",
      providerAccountId: "act_1",
      asOfDate: "2026-05-09",
    });
  });

  it("represents nullable canonical buyerAction without inventing a legacy row action", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      generation([
        canonicalDecision({
          label: "diagnose",
          buyerAction: null,
          authorizedAction: null,
          actionEligible: false,
          decisionState: "blocked",
          executionAction: null,
        }),
      ]),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();
    const card = payload.watching[0] as BriefingCreativeCard;

    expect(payload.actionNow).toEqual([]);
    expect(card.primary).toEqual({
      kind: "review",
      label: "Open canonical evidence",
    });
    expect(card.canonicalDecision?.classification.buyerAction).toBeNull();
    expect(card.decisionCenterRow).toBeUndefined();
    expect(payload.decisionCenter.rowDecisions).toEqual([]);
  });

  it("fails closed to an empty unavailable surface when the native bundle is unavailable", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_generation_manifest_mismatch",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();

    expect(payload.actionNow).toEqual([]);
    expect(payload.watching).toEqual([]);
    expect(payload.healthy).toEqual([]);
    expect(payload.trackingBlocked).toBe(true);
    expect(payload.source.canonicalDecisionInventory).toEqual({
      contractVersion: "briefing-canonical-native-ad.v1",
      status: "unavailable",
      unavailableReason: "native_generation_manifest_mismatch",
      generation: null,
      itemCount: 0,
    });
    expect(payload.decisionCenter.rowDecisions).toEqual([]);
  });

  it("fails the whole surface closed when one exact-ad lineage projection is invalid", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue(
      generation([
        canonicalDecision(),
        canonicalDecision({ adId: "ad_2", inputHash: "not-a-sha256" }),
      ]),
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();

    expect(payload.actionNow).toEqual([]);
    expect(payload.watching).toEqual([]);
    expect(payload.healthy).toEqual([]);
    expect(payload.source.canonicalDecisionInventory).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_canonical_briefing_projection_incomplete",
    });
  });

  it.each(["0", "false", "off", "no"])(
    "omits the additive Decision Center snapshot when decisionCenter=%s",
    async (value) => {
      const response = await GET(
        new NextRequest(
          `http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07&decisionCenter=${value}`,
        ),
      );
      const payload = await response.json();

      expect(payload).not.toHaveProperty("decisionCenter");
      expect(payload.actionNow).toEqual([]);
      expect(payload.watching[0]).toMatchObject({
        id: "ad_1",
        decisionCenterRow: null,
        canonicalDecision: {
          contractVersion: "briefing-canonical-native-ad.v1",
        },
      });
    },
  );

  it("serves the committed demo engine fixture as synthetic review-only and never reads live inventory", async () => {
    vi.mocked(isDemoBusiness).mockResolvedValue(true);
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      session: {
        user: { id: "user_1", email: "operator@adsecute.com" },
      } as never,
      membership: {
        id: "membership_demo",
        userId: "user_1",
        businessId: DEMO_BUSINESS_ID,
        role: "guest",
        status: "active",
        joinedAt: "2026-05-07T00:00:00.000Z",
      },
    });
    vi.mocked(resolveEngineV3Flags).mockResolvedValue({
      businessId: DEMO_BUSINESS_ID,
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
    });
    vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: getDemoMetaCreatives().rows,
      media_mode: "metadata",
      media_hydrated: false,
    } as Awaited<ReturnType<typeof getMetaCreativesApiPayload>>);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/creatives/briefing?businessId=${DEMO_BUSINESS_ID}&providerAccountId=act_210009998877&asOf=2026-04-12&status_filter=all`,
      ),
    );
    const payload = await response.json();
    const cards = [
      ...payload.actionNow,
      ...payload.watching,
      ...payload.healthy,
    ] as BriefingCreativeCard[];
    const cut = cards.find((card) => card.label === "cut");

    expect(response.status).toBe(200);
    expect(cards).toHaveLength(8);
    expect(cut).toMatchObject({
      primary: { kind: "review" },
      sourceDecisionAuthorityStatus: "demo_synthetic_review_only",
      sourceDecisionActionEligible: false,
      sourceDecisionAuthorizedAction: null,
    });
    expect(hasNativeDecisionOriginLineage(cut!)).toBe(false);
    expect(payload.source.canonicalDecisionInventory).toMatchObject({
      status: "available",
      generation: {
        authorityStatus: "demo_synthetic_review_only",
        expectedAdCount: 8,
      },
      itemCount: 8,
    });
    expect(readMetaNativeCanonicalDecisionInventory).not.toHaveBeenCalled();
  });

  it("returns empty lanes when the engine is disabled without reading inventory", async () => {
    vi.mocked(resolveEngineV3Flags).mockResolvedValue({
      businessId: "biz_1",
      enabled: false,
      surfaceVisible: false,
      shadowOnly: false,
      presetOverride: null,
      source: {
        enabled: "env",
        surfaceVisible: "env",
        shadowOnly: "env",
        presetOverride: null,
      },
      envDefaults: {
        enabled: false,
        surfaceVisible: false,
        shadowOnly: false,
      },
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-07",
      ),
    );
    const payload = await response.json();

    expect(payload).toMatchObject({
      status: "disabled",
      actionNow: [],
      watching: [],
      healthy: [],
    });
    expect(readMetaNativeCanonicalDecisionInventory).not.toHaveBeenCalled();
  });

  it("returns access errors unchanged", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValueOnce({
      error: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1",
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(readMetaNativeCanonicalDecisionInventory).not.toHaveBeenCalled();
  });
});
