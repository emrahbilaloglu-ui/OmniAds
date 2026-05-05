import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-commercial", () => ({
  getBusinessCommercialTruthSnapshot: vi.fn(),
}));

vi.mock("@/lib/business-operating-mode", () => ({
  buildAccountOperatingMode: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-api", () => ({
  getMetaCreativesApiPayload: vi.fn(),
}));

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/adsets-source", () => ({
  getMetaAdSetsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/breakdowns-source", () => ({
  getMetaBreakdownsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/operator-decision-source", () => ({
  getMetaDecisionWindowContext: vi.fn(),
  getMetaDecisionSourceSnapshot: vi.fn(),
}));

vi.mock("@/lib/creative-decision-os-config", () => ({
  isCreativeDecisionCenterV21EnabledForBusiness: vi.fn(),
  isCreativeDecisionCenterV21LiveRowsEnabledForBusiness: vi.fn(),
  isCreativeDecisionOsV1EnabledForBusiness: vi.fn(),
}));

vi.mock("@/lib/creative-decision-os-snapshots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/creative-decision-os-snapshots")>();
  return {
    ...actual,
    getLatestCreativeDecisionOsSnapshot: vi.fn(),
    saveCreativeDecisionOsSnapshot: vi.fn(),
  };
});

vi.mock("@/lib/creative-decision-os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/creative-decision-os")>();
  return {
    ...actual,
    buildCreativeDecisionOs: vi.fn(),
  };
});

const access = await import("@/lib/access");
const commercial = await import("@/lib/business-commercial");
const operatingMode = await import("@/lib/business-operating-mode");
const creativesApi = await import("@/lib/meta/creatives-api");
const campaignsSource = await import("@/lib/meta/campaigns-source");
const adsetsSource = await import("@/lib/meta/adsets-source");
const breakdownsSource = await import("@/lib/meta/breakdowns-source");
const decisionWindowSource = await import("@/lib/meta/operator-decision-source");
const config = await import("@/lib/creative-decision-os-config");
const snapshotStore = await import("@/lib/creative-decision-os-snapshots");
const decisionOs = await import("@/lib/creative-decision-os");
const route = await import("@/app/api/creatives/decision-os/route");
const GET = route.GET as (request: NextRequest) => Promise<Response>;
const POST = route.POST as (request: NextRequest) => Promise<Response>;

function buildCreativeApiRow() {
  return {
    id: "ad_1",
    creative_id: "cr_1",
    object_story_id: "story_1",
    effective_object_story_id: "story_1",
    post_id: "post_1",
    associated_ads_count: 1,
    account_id: "act_1",
    account_name: "Main",
    campaign_id: "cmp_1",
    campaign_name: "Campaign 1",
    adset_id: "adset_1",
    adset_name: "Ad Set 1",
    currency: "USD",
    name: "Creative name",
    launch_date: "2026-03-01",
    copy_text: "Buy now",
    copy_variants: ["Buy now"],
    headline_variants: ["Headline"],
    description_variants: ["Description"],
    copy_source: null,
    copy_debug_sources: [],
    unresolved_reason: null,
    preview_url: "https://example.com/preview.jpg",
    preview_source: "image_url",
    thumbnail_url: "https://example.com/thumb.jpg",
    image_url: "https://example.com/image.jpg",
    table_thumbnail_url: "https://example.com/table.jpg",
    card_preview_url: "https://example.com/card.jpg",
    preview_manifest: null,
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
    ai_tags: {
      messagingAngle: ["utility"],
      hookTactic: ["travel_pack"],
    },
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
    taxonomy_version: "v2",
    taxonomy_source: "deterministic",
    taxonomy_reconciled_by_video_evidence: false,
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
  };
}

describe("GET /api/creatives/decision-os", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(config.isCreativeDecisionOsV1EnabledForBusiness).mockReturnValue(true);
    vi.mocked(config.isCreativeDecisionCenterV21EnabledForBusiness).mockReturnValue(false);
    vi.mocked(config.isCreativeDecisionCenterV21LiveRowsEnabledForBusiness).mockReturnValue(false);
    vi.mocked(snapshotStore.getLatestCreativeDecisionOsSnapshot).mockResolvedValue(null);
    vi.mocked(snapshotStore.saveCreativeDecisionOsSnapshot).mockImplementation(
      async (input) =>
        ({
          snapshotId: "snap_1",
          surface: "creative",
          businessId: input.businessId,
          scope: snapshotStore.resolveCreativeDecisionOsSnapshotScope(input.benchmarkScope),
          decisionAsOf: input.payload.decisionAsOf,
          generatedAt: "2026-04-10T01:00:00.000Z",
          generatedBy: input.generatedBy ?? null,
          sourceWindow: {
            analyticsStartDate: input.analyticsStartDate ?? input.payload.analyticsWindow.startDate,
            analyticsEndDate: input.analyticsEndDate ?? input.payload.analyticsWindow.endDate,
            reportingStartDate: input.reportingStartDate ?? input.payload.startDate,
            reportingEndDate: input.reportingEndDate ?? input.payload.endDate,
            decisionWindowStartDate: input.payload.decisionWindows.primary30d.startDate,
            decisionWindowEndDate: input.payload.decisionWindows.primary30d.endDate,
            decisionWindowLabel: input.payload.decisionWindows.primary30d.label,
          },
          versions: {
            operatorDecisionVersion: input.payload.engineVersion,
            policyVersion: null,
            instructionVersion: null,
          },
          inputHash: "input_hash",
          evidenceHash: "evidence_hash",
          summaryCounts: {},
          status: "ready",
          error: null,
          payload: input.payload,
        }) as never,
    );
    vi.mocked(decisionWindowSource.getMetaDecisionWindowContext).mockImplementation(
      async (input: {
        businessId: string;
        startDate: string;
        endDate: string;
        decisionAsOf?: string | null;
      }) => {
      const decisionAsOf = input.decisionAsOf ?? "2026-04-10";
      return {
        analyticsWindow: {
          startDate: input.startDate,
          endDate: input.endDate,
          role: "analysis_only",
        },
        decisionWindows: {
          recent7d: {
            key: "recent7d",
            label: "recent 7d",
            startDate: "2026-04-04",
            endDate: decisionAsOf,
            days: 7,
            role: "recent_watch",
          },
          primary30d: {
            key: "primary30d",
            label: "primary 30d",
            startDate: "2026-03-12",
            endDate: decisionAsOf,
            days: 30,
            role: "decision_authority",
          },
          baseline90d: {
            key: "baseline90d",
            label: "baseline 90d",
            startDate: "2026-01-11",
            endDate: decisionAsOf,
            days: 90,
            role: "historical_memory",
          },
        },
        historicalMemory: {
          available: true,
          source: "rolling_baseline",
          baselineWindowKey: "baseline90d",
          startDate: "2026-01-11",
          endDate: decisionAsOf,
          lookbackDays: 90,
          note: "Decisions use live rolling windows with baseline memory instead of the selected period.",
        },
        decisionAsOf,
      } as never;
      },
    );
    vi.mocked(commercial.getBusinessCommercialTruthSnapshot).mockResolvedValue({
      businessId: "biz",
      targetPack: null,
      countryEconomics: [],
      promoCalendar: [],
      operatingConstraints: null,
      costModelContext: null,
      sectionMeta: {
        targetPack: { configured: false, itemCount: 0, sourceLabel: null, updatedAt: null, updatedByUserId: null },
        countryEconomics: { configured: false, itemCount: 0, sourceLabel: null, updatedAt: null, updatedByUserId: null },
        promoCalendar: { configured: false, itemCount: 0, sourceLabel: null, updatedAt: null, updatedByUserId: null },
        operatingConstraints: { configured: false, itemCount: 0, sourceLabel: null, updatedAt: null, updatedByUserId: null },
      },
    } as never);
    vi.mocked(operatingMode.buildAccountOperatingMode).mockReturnValue({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      analyticsWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        role: "analysis_only",
      },
      decisionWindows: {
        recent7d: {
          key: "recent7d",
          label: "recent 7d",
          startDate: "2026-04-04",
          endDate: "2026-04-10",
          days: 7,
          role: "recent_watch",
        },
        primary30d: {
          key: "primary30d",
          label: "primary 30d",
          startDate: "2026-03-12",
          endDate: "2026-04-10",
          days: 30,
          role: "decision_authority",
        },
        baseline90d: {
          key: "baseline90d",
          label: "baseline 90d",
          startDate: "2026-01-11",
          endDate: "2026-04-10",
          days: 90,
          role: "historical_memory",
        },
      },
      historicalMemory: {
        available: true,
        source: "rolling_baseline",
        baselineWindowKey: "baseline90d",
        startDate: "2026-01-11",
        endDate: "2026-04-10",
        lookbackDays: 90,
        note: "Decisions use live rolling windows with baseline memory instead of the selected period.",
      },
      decisionAsOf: "2026-04-10",
      currentMode: "Exploit",
      recommendedMode: "Exploit",
      confidence: 0.82,
      why: ["Strong targets."],
      guardrails: ["Scale in steps."],
      changeTriggers: ["Performance slips."],
      activeCommercialInputs: [],
      platformInputs: [],
      missingInputs: [],
    } as never);
    vi.mocked(creativesApi.getMetaCreativesApiPayload).mockResolvedValue({
      status: "ok",
      rows: [buildCreativeApiRow()],
    } as never);
    vi.mocked(campaignsSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [{ id: "cmp_1", name: "Campaign 1", status: "ACTIVE", spend: 300, revenue: 900, purchases: 25, roas: 3, cpa: 12, optimizationGoal: "Purchase", objective: "OUTCOME_SALES" } as never],
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [{ id: "adset_1", name: "Ad Set 1", campaignId: "cmp_1", status: "ACTIVE", spend: 100, revenue: 250, purchases: 10, cpa: 10, ctr: 1.5, impressions: 1000, clicks: 50, dailyBudget: 100, lifetimeBudget: null, optimizationGoal: "Purchase", bidStrategyType: null, bidStrategyLabel: null, manualBidAmount: null, bidValue: null, bidValueFormat: null, isBudgetMixed: false, isConfigMixed: false } as never],
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });
    vi.mocked(breakdownsSource.getMetaBreakdownsForRange).mockResolvedValue({
      status: "ok",
      age: [],
      location: [{ key: "US", label: "US", spend: 100, revenue: 250, purchases: 10, clicks: 50, impressions: 1000 }],
      placement: [],
      budget: { campaign: [], adset: [] },
      audience: { available: false },
      products: { available: false },
      isPartial: false,
      notReadyReason: null,
    });
    vi.mocked(decisionWindowSource.getMetaDecisionSourceSnapshot).mockResolvedValue({
      campaigns: {
        status: "ok",
        rows: [{ id: "cmp_1", name: "Campaign 1", status: "ACTIVE", spend: 300, revenue: 900, purchases: 25, roas: 3, cpa: 12, optimizationGoal: "Purchase", objective: "OUTCOME_SALES" } as never],
        isPartial: false,
        notReadyReason: null,
      },
      adSets: {
        status: "ok",
        rows: [{ id: "adset_1", name: "Ad Set 1", campaignId: "cmp_1", status: "ACTIVE", spend: 100, revenue: 250, purchases: 10, cpa: 10, ctr: 1.5, impressions: 1000, clicks: 50, dailyBudget: 100, lifetimeBudget: null, optimizationGoal: "Purchase", bidStrategyType: null, bidStrategyLabel: null, manualBidAmount: null, bidValue: null, bidValueFormat: null, isBudgetMixed: false, isConfigMixed: false } as never],
        isPartial: false,
        notReadyReason: null,
      },
      breakdowns: {
        status: "ok",
        age: [],
        location: [{ key: "US", label: "US", spend: 100, revenue: 250, purchases: 10, clicks: 50, impressions: 1000 }],
        placement: [],
        budget: { campaign: [], adset: [] },
        audience: { available: false },
        products: { available: false },
        isPartial: false,
        notReadyReason: null,
      },
    } as never);
    vi.mocked(decisionOs.buildCreativeDecisionOs).mockReturnValue({
      contractVersion: "creative-decision-os.v1",
      engineVersion: "2026-04-10-phase-04-v1",
      generatedAt: "2026-04-10T00:00:00.000Z",
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      analyticsWindow: {
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        role: "analysis_only",
      },
      decisionWindows: {
        recent7d: {
          key: "recent7d",
          label: "recent 7d",
          startDate: "2026-04-04",
          endDate: "2026-04-10",
          days: 7,
          role: "recent_watch",
        },
        primary30d: {
          key: "primary30d",
          label: "primary 30d",
          startDate: "2026-03-12",
          endDate: "2026-04-10",
          days: 30,
          role: "decision_authority",
        },
        baseline90d: {
          key: "baseline90d",
          label: "baseline 90d",
          startDate: "2026-01-11",
          endDate: "2026-04-10",
          days: 90,
          role: "historical_memory",
        },
      },
      historicalMemory: {
        available: true,
        source: "rolling_baseline",
        baselineWindowKey: "baseline90d",
        startDate: "2026-01-11",
        endDate: "2026-04-10",
        lookbackDays: 90,
        note: "Decisions use live rolling windows with baseline memory instead of the selected period.",
      },
      decisionAsOf: "2026-04-10",
      summary: {
        totalCreatives: 1,
        scaleReadyCount: 1,
        keepTestingCount: 0,
        fatiguedCount: 0,
        blockedCount: 0,
        comebackCount: 0,
        protectedWinnerCount: 0,
        supplyPlanCount: 0,
        message: "Decision OS highlights which creatives to scale, keep in test, refresh, block, or retest.",
        operatingMode: "Exploit",
        surfaceSummary: {
          actionCoreCount: 1,
          watchlistCount: 0,
          archiveCount: 0,
          degradedCount: 0,
        },
      },
      creatives: [],
      families: [],
      patterns: [],
      protectedWinners: [],
      supplyPlan: [],
      lifecycleBoard: [],
      operatorQueues: [],
      commercialTruthCoverage: {
        operatingMode: "Exploit",
        confidence: 0.82,
        missingInputs: [],
        activeInputs: [],
        guardrails: [],
        configuredSections: {
          targetPack: false,
          countryEconomics: false,
          promoCalendar: false,
          operatingConstraints: false,
        },
      },
      historicalAnalysis: {
        summary:
          "Selected-period historical analysis is attached separately and does not change deterministic Decision Signals.",
        selectedWindow: {
          startDate: "2026-04-01",
          endDate: "2026-04-10",
          rowCount: 0,
          materialRowCount: 0,
          note: "Analysis only. Live decisions continue to use the primary decision window.",
        },
        winningFormats: [],
        hookTrends: [],
        angleTrends: [],
        familyPerformance: [],
      },
    } as never);
  });

  it("loads latest snapshots without computing Creative Decision OS", async () => {
    vi.mocked(snapshotStore.getLatestCreativeDecisionOsSnapshot).mockResolvedValue({
      snapshotId: "snap_ready",
      surface: "creative",
      businessId: "biz",
      scope: snapshotStore.resolveCreativeDecisionOsSnapshotScope(null),
      decisionAsOf: "2026-04-10",
      generatedAt: "2026-04-10T01:00:00.000Z",
      generatedBy: "user_1",
      sourceWindow: {
        analyticsStartDate: "2026-04-01",
        analyticsEndDate: "2026-04-10",
        reportingStartDate: "2026-04-01",
        reportingEndDate: "2026-04-10",
        decisionWindowStartDate: "2026-03-12",
        decisionWindowEndDate: "2026-04-10",
        decisionWindowLabel: "primary 30d",
      },
      versions: {
        operatorDecisionVersion: "2026-04-10-phase-04-v1",
        policyVersion: null,
        instructionVersion: null,
      },
      inputHash: "input_hash",
      evidenceHash: "evidence_hash",
      summaryCounts: {},
      status: "ready",
      error: null,
      payload: {
        contractVersion: "creative-decision-os.v1",
        creatives: [],
      } as never,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/decision-os?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.contractVersion).toBe("creative-decision-os-snapshot.v1");
    expect(payload.status).toBe("ready");
    expect(payload.snapshot.snapshotId).toBe("snap_ready");
    expect(payload.decisionOs.contractVersion).toBe("creative-decision-os.v1");
    expect(payload.decisionCenter).toBeNull();
    expect(decisionWindowSource.getMetaDecisionWindowContext).not.toHaveBeenCalled();
    expect(decisionOs.buildCreativeDecisionOs).not.toHaveBeenCalled();
  });

  it("adds a validated empty decisionCenter behind the V2.1 feature flag", async () => {
    vi.mocked(config.isCreativeDecisionCenterV21EnabledForBusiness).mockReturnValue(true);
    vi.mocked(snapshotStore.getLatestCreativeDecisionOsSnapshot).mockResolvedValue({
      snapshotId: "snap_ready",
      surface: "creative",
      businessId: "biz",
      scope: snapshotStore.resolveCreativeDecisionOsSnapshotScope(null),
      decisionAsOf: "2026-04-10",
      generatedAt: "2026-04-10T01:00:00.000Z",
      generatedBy: "user_1",
      sourceWindow: {
        analyticsStartDate: "2026-04-01",
        analyticsEndDate: "2026-04-10",
        reportingStartDate: "2026-04-01",
        reportingEndDate: "2026-04-10",
        decisionWindowStartDate: "2026-03-12",
        decisionWindowEndDate: "2026-04-10",
        decisionWindowLabel: "primary 30d",
      },
      versions: {
        operatorDecisionVersion: "2026-04-10-phase-04-v1",
        policyVersion: null,
        instructionVersion: null,
      },
      inputHash: "input_hash",
      evidenceHash: "evidence_hash",
      summaryCounts: {},
      status: "ready",
      error: null,
      payload: {
        contractVersion: "creative-decision-os.v1",
        engineVersion: "creative-decision-os.v1",
        creatives: [{ creativeId: "creative_1" }],
      } as never,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/decision-os?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.contractVersion).toBe("creative-decision-os-snapshot.v1");
    expect(payload.decisionOs.contractVersion).toBe("creative-decision-os.v1");
    expect(payload.legacyDecisionOs).toBeUndefined();
    expect(payload.decisionCenter.contractVersion).toBe("creative-decision-center.v2.1");
    expect(payload.decisionCenter.rowDecisions).toEqual([]);
    expect(payload.decisionCenter.aggregateDecisions).toEqual([]);
    expect(payload.decisionCenter.actionBoard.diagnose_data).toEqual([]);
  });

  it("adds validated row decisions only when the live-row flag is enabled", async () => {
    vi.mocked(config.isCreativeDecisionCenterV21EnabledForBusiness).mockReturnValue(true);
    vi.mocked(config.isCreativeDecisionCenterV21LiveRowsEnabledForBusiness).mockReturnValue(true);
    vi.mocked(snapshotStore.getLatestCreativeDecisionOsSnapshot).mockResolvedValue({
      snapshotId: "snap_ready",
      surface: "creative",
      businessId: "biz",
      scope: snapshotStore.resolveCreativeDecisionOsSnapshotScope(null),
      decisionAsOf: "2026-04-10",
      generatedAt: new Date().toISOString(),
      generatedBy: "user_1",
      sourceWindow: {
        analyticsStartDate: "2026-04-01",
        analyticsEndDate: "2026-04-10",
        reportingStartDate: "2026-04-01",
        reportingEndDate: "2026-04-10",
        decisionWindowStartDate: "2026-03-12",
        decisionWindowEndDate: "2026-04-10",
        decisionWindowLabel: "primary 30d",
      },
      versions: {
        operatorDecisionVersion: "2026-04-10-phase-04-v1",
        policyVersion: null,
        instructionVersion: null,
      },
      inputHash: "input_hash",
      evidenceHash: "evidence_hash",
      summaryCounts: {},
      status: "ready",
      error: null,
      payload: {
        contractVersion: "creative-decision-os.v1",
        engineVersion: "creative-decision-os.v1",
        commercialTruthCoverage: {
          missingInputs: [],
          configuredSections: { targetPack: true },
        },
        summary: { totalCreatives: 1 },
        creatives: [
          {
            creativeId: "creative_1",
            familyId: "family_1",
            creativeAgeDays: 20,
            spend: 1600,
            purchases: 8,
            impressions: 20000,
            roas: 1.6,
            cpa: 30,
            ctr: 1.2,
            primaryAction: "promote_to_scaling",
            decisionSignals: [],
            benchmarkReliability: "medium",
            relativeBaseline: { medianSpend: 500, weightedRoas: 1, weightedCpa: 50 },
            benchmark: { metrics: { roas: { benchmark: 1 }, cpa: { benchmark: 50 } } },
            economics: { targetRoas: 1, targetCpa: 50 },
            fatigue: { status: "none" },
            deliveryContext: {
              activeDelivery: true,
              pausedDelivery: false,
              campaignStatus: "ACTIVE",
              adSetStatus: "ACTIVE",
            },
            trust: {},
          },
        ],
        families: [],
        supplyPlan: [],
      } as never,
    });

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/decision-os?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionCenter.contractVersion).toBe("creative-decision-center.v2.1");
    expect(payload.decisionCenter.rowDecisions).toHaveLength(1);
    expect(payload.decisionCenter.rowDecisions[0].buyerAction).toBe("scale");
    expect(payload.decisionCenter.actionBoard.scale).toEqual(["creative_1"]);
    expect(payload.decisionOs.contractVersion).toBe("creative-decision-os.v1");
  });

  it("returns not-run from GET when no matching snapshot exists", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/creatives/decision-os?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.contractVersion).toBe("creative-decision-os-snapshot.v1");
    expect(payload.status).toBe("not_run");
    expect(payload.snapshot).toBeNull();
    expect(payload.decisionOs).toBeNull();
    expect(payload.decisionCenter).toBeNull();
    expect(decisionWindowSource.getMetaDecisionWindowContext).not.toHaveBeenCalled();
    expect(decisionOs.buildCreativeDecisionOs).not.toHaveBeenCalled();
  });

  it("runs and saves the typed creative decision os payload on POST", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/creatives/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&analyticsStartDate=2026-03-01&analyticsEndDate=2026-03-31&decisionAsOf=2026-04-10",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.contractVersion).toBe("creative-decision-os-snapshot.v1");
    expect(payload.status).toBe("ready");
    expect(payload.snapshot.snapshotId).toBe("snap_1");
    expect(payload.decisionOs.contractVersion).toBe("creative-decision-os.v1");
    expect(payload.decisionCenter).toBeNull();
    expect(payload.decisionOs.historicalAnalysis.selectedWindow.startDate).toBe("2026-04-01");
    expect(decisionWindowSource.getMetaDecisionWindowContext).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      decisionAsOf: "2026-04-10",
    });
    expect(decisionOs.buildCreativeDecisionOs).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        analyticsWindow: {
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          role: "analysis_only",
        },
        decisionAsOf: "2026-04-10",
        rows: expect.arrayContaining([
          expect.objectContaining({
            creativeId: "ad_1",
            copyText: "Buy now",
            objectStoryId: "story_1",
          }),
        ]),
      }),
    );
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        start: "2026-04-01",
        end: "2026-04-10",
      }),
    );
    expect(creativesApi.getMetaCreativesApiPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        start: "2026-03-12",
        end: "2026-04-10",
      }),
    );
    expect(snapshotStore.saveCreativeDecisionOsSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        analyticsStartDate: "2026-03-01",
        analyticsEndDate: "2026-03-31",
        reportingStartDate: "2026-04-01",
        reportingEndDate: "2026-04-10",
      }),
    );
  });

  it("adds decisionCenter to POST responses only when the V2.1 feature flag is enabled", async () => {
    vi.mocked(config.isCreativeDecisionCenterV21EnabledForBusiness).mockReturnValue(true);

    const response = await POST(
      new NextRequest(
        "http://localhost/api/creatives/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&analyticsStartDate=2026-03-01&analyticsEndDate=2026-03-31&decisionAsOf=2026-04-10",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionOs.contractVersion).toBe("creative-decision-os.v1");
    expect(payload.legacyDecisionOs).toBeUndefined();
    expect(payload.decisionCenter.contractVersion).toBe("creative-decision-center.v2.1");
    expect(payload.decisionCenter.rowDecisions).toEqual([]);
  });

  it("lets provider decision timing resolve decisionAsOf when the request omits it", async () => {
    const responseA = await POST(
      new NextRequest(
        "http://localhost/api/creatives/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&analyticsStartDate=2026-02-01&analyticsEndDate=2026-02-28",
      ),
    );

    expect(responseA.status).toBe(200);
    expect(decisionWindowSource.getMetaDecisionWindowContext).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      decisionAsOf: null,
    });
    expect(decisionOs.buildCreativeDecisionOs).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionAsOf: "2026-04-10",
        analyticsWindow: {
          startDate: "2026-02-01",
          endDate: "2026-02-28",
          role: "analysis_only",
        },
      }),
    );

    vi.mocked(decisionWindowSource.getMetaDecisionWindowContext).mockClear();
    vi.mocked(decisionOs.buildCreativeDecisionOs).mockClear();

    const responseB = await POST(
      new NextRequest(
        "http://localhost/api/creatives/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&analyticsStartDate=2026-03-01&analyticsEndDate=2026-03-31",
      ),
    );

    expect(responseB.status).toBe(200);
    expect(decisionWindowSource.getMetaDecisionWindowContext).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      decisionAsOf: null,
    });
    expect(decisionOs.buildCreativeDecisionOs).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionAsOf: "2026-04-10",
      }),
    );

    vi.mocked(decisionWindowSource.getMetaDecisionWindowContext).mockClear();

    const responseC = await POST(
      new NextRequest(
        "http://localhost/api/creatives/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&analyticsStartDate=2026-03-01&analyticsEndDate=2026-03-31&decisionAsOf=%20%20%20",
      ),
    );

    expect(responseC.status).toBe(200);
    expect(decisionWindowSource.getMetaDecisionWindowContext).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      decisionAsOf: null,
    });
  });

  it("falls back to reporting dates when analytics dates are blank", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/creatives/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&analyticsStartDate=&analyticsEndDate=",
      ),
    );

    expect(response.status).toBe(200);
    expect(decisionWindowSource.getMetaDecisionWindowContext).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      decisionAsOf: null,
    });
    expect(decisionOs.buildCreativeDecisionOs).toHaveBeenCalledWith(
      expect.objectContaining({
        analyticsWindow: {
          startDate: "2026-04-01",
          endDate: "2026-04-10",
          role: "analysis_only",
        },
      }),
    );
  });

  it("forwards explicit benchmark scope metadata into the creative decision build", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/creatives/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&benchmarkScope=campaign&benchmarkScopeId=cmp_1&benchmarkScopeLabel=Campaign%201",
      ),
    );

    expect(response.status).toBe(200);
    expect(decisionOs.buildCreativeDecisionOs).toHaveBeenCalledWith(
      expect.objectContaining({
        benchmarkScope: {
          scope: "campaign",
          scopeId: "cmp_1",
          scopeLabel: "Campaign 1",
        },
      }),
    );
  });

  it("does not silently create campaign benchmark scope from unrelated filters", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/creatives/decision-os?businessId=biz&startDate=2026-04-01&endDate=2026-04-10&campaignId=cmp_1",
      ),
    );

    expect(response.status).toBe(200);
    expect(decisionOs.buildCreativeDecisionOs).toHaveBeenCalledWith(
      expect.not.objectContaining({
        benchmarkScope: expect.anything(),
      }),
    );
  });

  it("returns 404 when the feature gate is disabled", async () => {
    vi.mocked(config.isCreativeDecisionOsV1EnabledForBusiness).mockReturnValue(false);

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/decision-os?businessId=biz"),
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toBe("creative_decision_os_disabled");
  });
});
