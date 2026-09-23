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
import {
  applyMetaExecutionGovernanceToCanonicalDecisions,
  readMetaNativeCanonicalDecisionInventory,
} from "@/lib/meta/decisions-workspace-read-model";
import { readEffectiveMetaWriteGovernance } from "@/lib/meta/automation-control-plane";
import {
  buildMetaDecisionPipelineHealthFromCanonicalInventory,
  readMetaDecisionPipelineOperationalHealth,
} from "@/lib/meta/decision-pipeline-health";
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
  applyMetaExecutionGovernanceToCanonicalDecisions: vi.fn(),
  readMetaNativeCanonicalDecisionInventory: vi.fn(),
}));

vi.mock("@/lib/meta/automation-control-plane", () => ({
  readEffectiveMetaWriteGovernance: vi.fn(),
}));

vi.mock("@/lib/meta/decision-pipeline-health", () => ({
  readMetaDecisionPipelineOperationalHealth: vi.fn(),
  buildMetaDecisionPipelineHealthFromCanonicalInventory: vi.fn(),
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
      executionReadiness: actionEligible
        ? "live_preflight_required"
        : "decision_not_authorized",
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
  vi.mocked(
    applyMetaExecutionGovernanceToCanonicalDecisions,
  ).mockImplementation((input) => structuredClone([...input.decisions]));
  vi.mocked(readEffectiveMetaWriteGovernance).mockResolvedValue({
    verified: true,
    controlsConfigured: true,
    writeBlocked: false,
    blockReason: null,
    killSwitchEngaged: false,
    killSwitchReason: null,
  });
  vi.mocked(readMetaDecisionPipelineOperationalHealth).mockResolvedValue(
    {} as never,
  );
  vi.mocked(
    buildMetaDecisionPipelineHealthFromCanonicalInventory,
  ).mockReturnValue({ overall: "healthy", executionReady: true } as never);
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
    expect(readEffectiveMetaWriteGovernance).toHaveBeenCalledWith({
      businessId: "biz_1",
    });
    expect(
      applyMetaExecutionGovernanceToCanonicalDecisions,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        governance: expect.objectContaining({
          verified: true,
          controlsConfigured: true,
          writeBlocked: false,
        }),
        pipeline: { verified: true, executionReady: true },
        now: expect.any(Date),
      }),
    );
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
      generatedAt: expect.any(String),
    });
  });

  it("scopes rows to start/end but reads the current generation when no decision as-of is stated", async () => {
    // Grandmix 2026-09-23: the metric window ended 09-22 while the only
    // usable generation was computed for 09-23. Pinning the decision read to
    // the window end hid it behind an older-epoch 09-22 run.
    const current = generation([canonicalDecision()]);
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue({
      ...current,
      generation: { ...current.generation, asOfDate: "2026-09-23" },
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&providerAccountId=act_1&start=2026-08-24&end=2026-09-22",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledTimes(1);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith({
      businessId: "biz_1",
      providerAccountId: "act_1",
      asOfDate: undefined,
      generatedAt: expect.any(String),
      // D102: a current read may be shown the retained generation, read-only.
      allowLastSuccessfulGenerationFallback: true,
    });
    expect(getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({ start: "2026-08-24", end: "2026-09-22" }),
    );
    expect(payload.source.asOf).toBe("2026-09-23");
    expect(payload.source.canonicalDecisionInventory.generation.asOfDate).toBe(
      "2026-09-23",
    );
    expect(payload.source.metricWindow).toEqual({
      start: "2026-08-24",
      end: "2026-09-22",
    });
    expect(payload.source.decisionAsOfRequested).toBeNull();
    expect(payload.watching.length + payload.actionNow.length).toBe(1);
  });

  it("honours an explicit historical decision as-of alongside an independent metric window", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&start=2026-08-24&end=2026-09-22&asOf=2026-09-10",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: "2026-09-10" }),
    );
    expect(getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({ start: "2026-08-24", end: "2026-09-22" }),
    );
    expect(payload.source.decisionAsOfRequested).toBe("2026-09-10");
  });

  it("keeps an explicit historical as-of unavailable instead of falling back to the current generation", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_latest_job_engine_mismatch",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&start=2026-08-24&end=2026-09-22&asOf=2026-09-22",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledTimes(1);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: "2026-09-22" }),
    );
    expect(payload.source.canonicalDecisionInventory).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_latest_job_engine_mismatch",
      generation: null,
    });
    expect(payload.source.asOf).toBe("2026-09-22");
    expect(payload.source.decisionAsOfRequested).toBe("2026-09-22");
    expect(payload.actionNow).toEqual([]);
    expect(payload.watching).toEqual([]);
    expect(payload.healthy).toEqual([]);
  });

  it("reports no decision day, not the metric end, when the current generation is unavailable", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_generation_unavailable",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&start=2026-08-24&end=2026-09-22&decisionCenter=1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source.asOf).toBeNull();
    expect(payload.source.decisionAsOfRequested).toBeNull();
    expect(payload.source.metricWindow).toEqual({
      start: "2026-08-24",
      end: "2026-09-22",
    });
    expect(payload.decisionCenter).not.toBeNull();
    expect(payload.decisionCenter.rowDecisions).toEqual([]);
  });

  it("keeps the legacy contract for callers that send no end: asOf is both the metric end and the decision bound", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/briefing?businessId=biz_1&asOf=2026-05-09",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: "2026-05-09" }),
    );
    expect(getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({ start: "2026-04-10", end: "2026-05-09" }),
    );
    expect(payload.source.metricWindow).toEqual({
      start: "2026-04-10",
      end: "2026-05-09",
    });
    expect(payload.source.decisionAsOfRequested).toBe("2026-05-09");
  });

  it("reads the current generation for a caller that states neither date", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: undefined }),
    );
    expect(payload.source.decisionAsOfRequested).toBeNull();
    expect(payload.source.asOf).toBe("2026-05-07");
  });

  it("does not report today's metric end as a decision day when the undated read is unavailable", async () => {
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue({
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_generation_unavailable",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/briefing?businessId=biz_1"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.source.asOf).toBeNull();
    expect(payload.source.decisionAsOfRequested).toBeNull();
    expect(payload.source.canonicalDecisionInventory.status).toBe("unavailable");
  });

  it.each([
    ["asOf=yesterday", "invalid_as_of"],
    ["asOf=", "invalid_as_of"],
    ["asOf=2026-09-10Tjunk", "invalid_as_of"],
    ["asOf=2026-02-30", "invalid_as_of"],
    ["start=2026-08-24&end=", "invalid_end"],
    ["start=2026-08-24&end=2026-09-22Tgarbage", "invalid_end"],
    ["start=2026-08-24&end=2026-09-31", "invalid_end"],
    ["start=2026-08-24&end=last-week", "invalid_end"],
  ])(
    "rejects a malformed stated date (%s) instead of reading today's decisions",
    async (query, error) => {
      const response = await GET(
        new NextRequest(
          `http://localhost/api/creatives/briefing?businessId=biz_1&${query}`,
        ),
      );
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error).toBe(error);
      expect(readMetaNativeCanonicalDecisionInventory).not.toHaveBeenCalled();
      expect(getMetaCreativesApiPayload).not.toHaveBeenCalled();
    },
  );

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
      source: {
        canonicalDecisionInventory: {
          status: "unavailable",
          unavailableReason: "engine_v3_disabled_for_business",
        },
      },
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

/*
 * D102 — the retained generation after a failed latest run, end to end.
 *
 * These tests run the REAL canonical inventory reader over a mocked DB, the
 * REAL request-time governance and the REAL briefing projection; only the
 * rows, the operational health (reported ready, the worst case) and the
 * creative rows are fixtures. The failure lands a few hours after the success
 * on the same as-of day, so the retained Cut is still fresh: freshness cannot
 * be what keeps it out of Action Now.
 */
vi.mock("@/lib/db", async (importOriginal) => {
  const getDb = vi.fn();
  return {
    ...(await importOriginal<typeof import("@/lib/db")>()),
    getDb,
    getDbWithTimeout: vi.fn(() => getDb()),
  };
});

type D102ReadModel = typeof import("@/lib/meta/decisions-workspace-read-model");
type D102SnapshotRow =
  import("@/lib/meta/decisions-workspace-read-model").MetaNativeDecisionSnapshotSourceRow;
type D102GenerationRow =
  import("@/lib/meta/decisions-workspace-read-model").MetaNativeDecisionGenerationSourceRow;

describe("GET /api/creatives/briefing retained generation after a failed latest run (D102)", () => {
  const RETAINED_RUN_ID = "20000000-0000-4000-8000-000000000001";
  const FAILED_RUN_ID = "20000000-0000-4000-8000-000000001902";
  const AS_OF = "2026-07-12";
  const SERVING_INSTANT = "2026-07-12T12:00:00.000Z";
  const AD_IDS = ["120000000000001901", "120000000000001902"];
  const previousResolverVersion =
    process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION;
  let actual: D102ReadModel;
  let nativeEngineVersion: string;
  let resolverVersion: string;
  let manifestHash: (adIds: string[]) => string;
  let mockedGetDb: ReturnType<typeof vi.fn>;

  const configLineage = () => {
    const receipt = (field: string) => ({
      refContractVersion: "meta-config-field-evidence-ref.v1",
      field,
      sourceContractVersion: "meta-config-field-source.v1",
      normalizationVersion: 1,
      tier: "provider_receipt_point_in_day",
      readiness: "review_only",
      sourceClass: "modern",
      pitClass: "as_of_known",
      sourceSnapshotId: "11111111-1111-4111-8111-111111111111",
      observationId: "33333333-3333-4333-8333-333333333333",
      observedAt: "2026-07-12T04:00:00.000Z",
      fieldScopeHash: "a".repeat(64),
      corroboratingSnapshotId: null,
      corroboratingObservationId: null,
      corroboratingObservedAt: null,
    });
    return {
      contractVersion: "engine-v3-canonical-ad-evaluation.v12",
      refs: {
        objective: receipt("objective"),
        optimization_goal: receipt("optimization_goal"),
        custom_event_type: receipt("custom_event_type"),
        custom_conversion_id: {
          ...receipt("custom_conversion_id"),
          normalizationVersion: null,
          tier: "unknown",
          readiness: "none",
          sourceClass: "none",
          pitClass: null,
          sourceSnapshotId: null,
          observationId: null,
          observedAt: null,
          fieldScopeHash: null,
        },
      },
      refRefusals: {},
      lineageSupplied: true,
      receiptManifest: {
        manifestVersion: "meta-config-receipt-window-manifest.v1",
        refContractVersion: "meta-config-field-evidence-ref.v1",
        hash: "c".repeat(64),
        economicDayCount: 3,
        nullObservationIdCount: 0,
        incoherentDayCount: 0,
      },
      currentConfigDay: AS_OF,
      metricContract: {
        funnelStage: "meta-funnel-stage.v1",
        windowRule: "meta-metric-window.complete-or-null.v1",
        adDayLinkClick: "meta-ad-day-link-click.v1",
      },
    };
  };
  // An exact-Ad Cut the producer AUTHORIZED, with verified config receipts.
  const nativeRow = (adId: string): D102SnapshotRow => ({
    snapshot_id: `00000000-0000-4000-8000-${adId.slice(-12)}`,
    evaluation_id: `10000000-0000-4000-8000-${adId.slice(-12)}`,
    job_run_id: RETAINED_RUN_ID,
    provider_account_ref_id: "30000000-0000-4000-8000-000000000001",
    provider_account_id: "act_1",
    ad_id: adId,
    creative_id: "creative_shared",
    as_of_date: AS_OF,
    engine_version: nativeEngineVersion,
    scope_type: "account",
    scope_id: "act_1",
    label: "cut",
    pre_authority_label: null,
    authority_blocker: null,
    raw_label: "cut",
    confidence: 88,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 0.5,
    badges: [],
    reason: "Exact Ad evidence is below the account target.",
    spend: 120,
    purchases: 1,
    roas: 1,
    recent7d_roas: 0.9,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: "cut",
    input_hash: "a".repeat(64),
    decision_hash: "b".repeat(64),
    computed_at: "2026-07-12T05:00:00.000Z",
    episode_started_at: AS_OF,
    lineage_valid: true,
    creative_name: "Shared creative",
    campaign_id: "cmp_1",
    campaign_name: "Main Sales",
    adset_id: "adset_1",
    adset_name: "Broad",
    ad_name: `Ad ${adId}`,
    campaign_status: "ACTIVE",
    adset_status: "ACTIVE",
    ad_status: "ACTIVE",
    currency: "USD",
    thumbnail_url: "https://cdn.example/shared.jpg",
    media_source_present: true,
    media_available: true,
    media_source: "meta_creative_media",
    source_updated_at: "2026-07-12T04:00:00.000Z",
    config_authority_verified: true,
    config_evidence_lineage: configLineage(),
  });
  const generationRow = (
    overrides: Partial<D102GenerationRow> = {},
  ): D102GenerationRow => ({
    selection: "latest",
    job_status: "success",
    job_run_id: RETAINED_RUN_ID,
    as_of_date: AS_OF,
    engine_version: nativeEngineVersion,
    provider_account_ref_id: "30000000-0000-4000-8000-000000000001",
    provider_account_id: "act_1",
    expected_ad_count: AD_IDS.length,
    expected_manifest_hash: manifestHash(AD_IDS),
    hydrated_ad_count: AD_IDS.length,
    hydrated_manifest_hash: manifestHash(AD_IDS),
    authoritative_for_prune: true,
    ...overrides,
  });
  // A failed run writes no receipt: every receipt column is NULL.
  const failedLatest = (
    overrides: Partial<D102GenerationRow> = {},
  ): D102GenerationRow => ({
    selection: "latest",
    job_status: "failed",
    job_run_id: FAILED_RUN_ID,
    as_of_date: AS_OF,
    engine_version: nativeEngineVersion,
    provider_account_ref_id: null,
    provider_account_id: null,
    expected_ad_count: null,
    expected_manifest_hash: null,
    hydrated_ad_count: null,
    hydrated_manifest_hash: null,
    authoritative_for_prune: null,
    ...overrides,
  });
  const retained = () => generationRow({ selection: "last_success" });
  const mockNativeDb = (generationRows: D102GenerationRow[]) => {
    const rows = AD_IDS.map(nativeRow);
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("WITH candidate_runs AS")) return generationRows;
      if (sql.includes("FROM engine_v3_ad_decision_snapshots_daily snapshot")) {
        return rows;
      }
      if (sql.includes("FROM engine_v3_campaign_context_daily")) {
        return [
          {
            campaign_id: "cmp_1",
            inferred_kind: "main",
            confidence_class: "high",
            confidence_score: 0.92,
            signal_scores_json: null,
            evidence_json: null,
            conflict_reasons_json: null,
            context_updated_at: "2026-07-11T10:00:00.000Z",
            context_as_of_date: "2026-07-11",
            resolver_version: resolverVersion,
            kind_source: "system_inferred",
          },
        ];
      }
      return [];
    });
    mockedGetDb.mockReturnValue({ query } as never);
  };
  const briefing = async (query = "") => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/creatives/briefing?businessId=biz_1&providerAccountId=act_1&decisionCenter=1${query}`,
      ),
    );
    return { response, payload: await response.json() };
  };
  const allCards = (payload: {
    actionNow: BriefingCreativeCard[];
    watching: BriefingCreativeCard[];
    healthy: BriefingCreativeCard[];
  }) => [...payload.actionNow, ...payload.watching, ...payload.healthy];

  beforeEach(async () => {
    actual = await vi.importActual<D102ReadModel>(
      "@/lib/meta/decisions-workspace-read-model",
    );
    mockedGetDb = vi.mocked((await import("@/lib/db")).getDb) as never;
    nativeEngineVersion = (
      await vi.importActual<
        typeof import("@/lib/creative-decision-engine/types")
      >("@/lib/creative-decision-engine/types")
    ).NATIVE_AD_ENGINE_VERSION;
    resolverVersion = (
      await vi.importActual<
        typeof import("@/lib/creative-decision-engine/campaign-context/resolver")
      >("@/lib/creative-decision-engine/campaign-context/resolver")
    ).CAMPAIGN_CONTEXT_RESOLVER_VERSION;
    const { hashAdDecisionIdentityManifest } = await vi.importActual<
      typeof import("@/lib/creative-decision-engine/data-source")
    >("@/lib/creative-decision-engine/data-source");
    manifestHash = (adIds) =>
      hashAdDecisionIdentityManifest({
        businessId: "biz_1",
        providerAccountId: "act_1",
        asOfDate: AS_OF,
        adIds,
      });
    // The campaign role must be trusted, or every retained Cut would already
    // be review-only for an unrelated reason and prove nothing.
    process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION = resolverVersion;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(SERVING_INSTANT));
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockImplementation(
      actual.readMetaNativeCanonicalDecisionInventory,
    );
    vi.mocked(
      applyMetaExecutionGovernanceToCanonicalDecisions,
    ).mockImplementation(
      actual.applyMetaExecutionGovernanceToCanonicalDecisions,
    );
    vi.mocked(getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: AD_IDS.map((adId) => creativeRow(adId, "creative_shared")),
      media_mode: "metadata",
      media_hydrated: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousResolverVersion === undefined) {
      delete process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION;
    } else {
      process.env.CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION =
        previousResolverVersion;
    }
  });

  it("CONTROL: the same authorized Cuts from a successful latest run are Action Now", async () => {
    mockNativeDb([generationRow()]);

    const { response, payload } = await briefing();

    expect(response.status).toBe(200);
    expect(payload.source.canonicalDecisionInventory).toMatchObject({
      status: "available",
      unavailableReason: null,
    });
    expect(
      payload.source.canonicalDecisionInventory.degradation,
    ).toBeUndefined();
    expect(payload.actionNow).toHaveLength(2);
    expect(() =>
      buildBriefingDecisionOriginAdActionRequest({
        businessId: "biz_1",
        card: payload.actionNow[0],
        action: "pause",
      }),
    ).not.toThrow();
  });

  it("serves the retained generation as degraded and read-only, with nothing in Action Now", async () => {
    mockNativeDb([failedLatest(), retained()]);

    const { response, payload } = await briefing();

    expect(response.status).toBe(200);
    expect(readMetaNativeCanonicalDecisionInventory).toHaveBeenCalledWith(
      expect.objectContaining({
        asOfDate: undefined,
        allowLastSuccessfulGenerationFallback: true,
      }),
    );
    // Operations reported ready; a retained generation never asks it.
    expect(
      buildMetaDecisionPipelineHealthFromCanonicalInventory,
    ).not.toHaveBeenCalled();
    expect(payload.source.asOf).toBe(AS_OF);
    expect(payload.source.canonicalDecisionInventory).toEqual({
      contractVersion: "briefing-canonical-native-ad.v1",
      status: "degraded",
      unavailableReason: "native_latest_job_failed",
      generation: {
        jobRunId: RETAINED_RUN_ID,
        asOfDate: AS_OF,
        providerAccountRefId: "30000000-0000-4000-8000-000000000001",
        manifestHash: manifestHash(AD_IDS),
        expectedAdCount: 2,
        authorityStatus: "native_exact",
      },
      itemCount: 2,
      degradation: {
        reason: "native_latest_job_failed_serving_last_successful_generation",
        servedGeneration: { jobRunId: RETAINED_RUN_ID, asOfDate: AS_OF },
        latestTerminalRun: {
          jobRunId: FAILED_RUN_ID,
          status: "failed",
          asOfDate: AS_OF,
        },
      },
    });
    expect(payload.actionNow).toEqual([]);
    const cards = allCards(payload);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toMatchObject({
        label: "cut",
        confidence: 65,
        sourceDecisionActionEligible: false,
        sourceDecisionAuthorizedAction: null,
        sourceDecisionJobRunId: RETAINED_RUN_ID,
      });
      expect(card.canonicalDecision?.sourceAuthority).toMatchObject({
        actionEligible: false,
        authorizedAction: null,
        reviewOnlyReason:
          "native_latest_job_failed_last_successful_generation_is_not_current",
        executionReadiness: "decision_not_authorized",
        decisionFreshness: expect.objectContaining({ status: "fresh" }),
      });
      expect(card.decisionCenterRow?.engine.actionability).not.toBe("direct");
      expect(() =>
        buildBriefingDecisionOriginAdActionRequest({
          businessId: "biz_1",
          card,
          action: "pause",
        }),
      ).toThrow("native_exact_eligible_authorized_cut_required");
    }
    expect(payload.trackingBlocked).toBe(true);
    expect(payload.trackingAnomalyActive).toBe(false);
    expect(payload.trackingDetail).toBe(
      "The latest native decision run (as of 2026-07-12) failed. Showing the last successful generation (as of 2026-07-12) read-only; none of these decisions can be executed.",
    );
    expect(payload.pulse.trackingDetail).toBe(payload.trackingDetail);
    expect(payload.source.measurementReconciliation.notes).toEqual([
      "native_latest_job_failed_serving_last_successful_generation",
      "native_latest_job_failed",
      "request_time_profile_and_data_health_not_serving_authority",
    ]);
    expect(
      payload.source.measurementReconciliation.snapshotLatest,
    ).toMatchObject({ asOfDate: AS_OF, rowCount: 2, staleRows: 2 });
    expect(payload.decisionCenter).not.toBeNull();
    expect(payload.decisionCenter.dataFreshness.status).toBe("stale");
  });

  it("refuses a retained generation whose authority reached the route unstripped", async () => {
    // Stand-in for reader drift: the retained generation arrives marked
    // degraded but still carrying the producer's authorized Cut.
    const rows = AD_IDS.map(nativeRow);
    const unstripped = actual.buildNativeMetaCanonicalDecisionInventory({
      businessId: "biz_1",
      providerAccountId: "act_1",
      generation: {
        jobRunId: RETAINED_RUN_ID,
        asOfDate: AS_OF,
        providerAccountRefId: "30000000-0000-4000-8000-000000000001",
        manifestHash: manifestHash(AD_IDS),
        expectedAdCount: 2,
      },
      snapshotRows: rows,
      campaignContextRows: [
        {
          campaignId: "cmp_1",
          kind: "main",
          source: "system_inferred",
          confidenceClass: "high",
          sourceUpdatedAt: "2026-07-11T10:00:00.000Z",
          resolverVersion,
        },
      ],
      generatedAt: SERVING_INSTANT,
    });
    expect(unstripped.status).toBe("available");
    if (unstripped.status !== "available") return;
    expect(unstripped.items[0]?.sourceAuthority?.actionEligible).toBe(true);
    vi.mocked(readMetaNativeCanonicalDecisionInventory).mockResolvedValue({
      ...unstripped,
      sourceDegradation: {
        reason: "native_latest_job_failed_serving_last_successful_generation",
        servedGeneration: { jobRunId: RETAINED_RUN_ID, asOfDate: AS_OF },
        latestTerminalRun: {
          jobRunId: FAILED_RUN_ID,
          status: "failed",
          asOfDate: AS_OF,
        },
      },
    });

    const { payload } = await briefing();

    expect(payload.source.canonicalDecisionInventory).toMatchObject({
      status: "unavailable",
      unavailableReason: "native_retained_generation_not_read_only",
      generation: null,
    });
    expect(allCards(payload)).toEqual([]);
  });

  it("keeps an explicit historical asOf failing closed without the opt-in", async () => {
    mockNativeDb([failedLatest(), retained()]);

    const { payload } = await briefing(`&asOf=${AS_OF}`);

    const [call] = vi.mocked(readMetaNativeCanonicalDecisionInventory).mock
      .calls[0]!;
    expect(call).toMatchObject({ asOfDate: AS_OF });
    expect(call).not.toHaveProperty("allowLastSuccessfulGenerationFallback");
    expect(payload.source.canonicalDecisionInventory).toEqual({
      contractVersion: "briefing-canonical-native-ad.v1",
      status: "unavailable",
      unavailableReason: "native_latest_job_failed",
      generation: null,
      itemCount: 0,
    });
    expect(allCards(payload)).toEqual([]);
  });

  it.each([
    [
      "a lock-skip whose overlapping holder has not finished",
      () => failedLatest({ job_status: "skipped" }),
      "native_latest_job_skipped",
    ],
    [
      "a foreign-epoch latest success",
      () =>
        generationRow({
          job_run_id: FAILED_RUN_ID,
          engine_version: "v3-ad-foreign-epoch-shadow",
        }),
      "native_latest_job_engine_mismatch",
    ],
  ] as const)(
    "stays unavailable behind %s",
    async (_case, latest, unavailableReason) => {
      mockNativeDb([latest(), retained()]);

      const { payload } = await briefing();

      expect(payload.source.canonicalDecisionInventory).toMatchObject({
        status: "unavailable",
        unavailableReason,
        generation: null,
      });
      expect(
        payload.source.canonicalDecisionInventory.degradation,
      ).toBeUndefined();
      expect(allCards(payload)).toEqual([]);
    },
  );
});
