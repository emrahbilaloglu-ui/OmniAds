import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine/campaign-context/source", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/creative-decision-engine/campaign-context/source")
  >("@/lib/creative-decision-engine/campaign-context/source");
  return { ...actual, readCampaignContextMap: vi.fn() };
});

vi.mock("@/lib/meta/canonical-overview", () => ({
  getMetaCanonicalOverviewTrends: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const access = await import("@/lib/access");
const campaigns = await import("@/lib/meta/campaigns-source");
const campaignContext = await import(
  "@/lib/creative-decision-engine/campaign-context/source"
);
const canonicalOverview = await import("@/lib/meta/canonical-overview");
const db = await import("@/lib/db");
const { META_RECOMMENDATION_ENGINE_VERSION } = await import("@/lib/meta/recommendations");
const { GET } = await import("@/app/api/meta/account-pulse/route");

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    name: "ASC",
    status: "ACTIVE",
    spend: 1200,
    revenue: 3600,
    purchases: 50,
    roas: 3,
    cpa: 24,
    ...overrides,
  };
}

function mockSql(input: {
  targetRoas?: number | null;
  targetUpdatedAt?: string | null;
  calibrationP50?: number | null;
  trackingScore?: number | null;
  lastSyncAt?: string | null;
} = {}) {
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    if (text.includes("FROM business_target_packs")) {
      return input.targetRoas == null
        ? []
        : [
            {
              target_roas: input.targetRoas,
              updated_at:
                input.targetUpdatedAt ?? new Date().toISOString(),
            },
          ];
    }
    if (text.includes("FROM meta_decision_calibration_daily")) {
      return input.calibrationP50 == null ? [] : [{ p50: input.calibrationP50 }];
    }
    if (text.includes("meta_decision_snapshots_daily")) {
      return [{
        latest_snapshot_date: "2026-05-07",
        engine_last_run: new Date().toISOString(),
        engine_version: META_RECOMMENDATION_ENGINE_VERSION,
      }];
    }
    if (text.includes("engine_v3_creative_lifecycle_daily")) {
      return [{ row_count: 1, tracking_anomaly_score: input.trackingScore ?? 0.1 }];
    }
    return [];
  });
  // The route's freshness read uses the .query(text, params) interface.
  (sql as unknown as { query: unknown }).query = vi.fn(async (text: string) => {
    if (text.includes("MAX(updated_at)")) {
      return input.lastSyncAt === undefined
        ? []
        : [{ last_sync_at: input.lastSyncAt }];
    }
    return [];
  });
  vi.mocked(db.getDb).mockReturnValue(sql as never);
  return sql;
}

describe("GET /api/meta/account-pulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [campaign()] as never,
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });
    vi.mocked(campaignContext.readCampaignContextMap).mockResolvedValue(
      new Map([
        [
          "cmp_1",
          {
            kind: "main",
            testDimension: null,
            contextTrust: "high",
            provenance: {
              mode: "automatic",
              source: "system_inferred",
              campaignId: "cmp_1",
              kind: "main",
              testDimension: null,
              contextTrust: "high",
              sourceRecordType: "engine_v3_campaign_context_daily",
              sourceRecordId: "context_1",
              sourceAsOfDate: "2026-05-07",
              sourceUpdatedAt: "2026-05-07T10:00:00.000Z",
              sourceHash: "a".repeat(64),
            },
          },
        ],
      ]),
    );
    vi.mocked(canonicalOverview.getMetaCanonicalOverviewTrends).mockResolvedValue({
      points: [
        { date: "2026-05-05", spend: 100, revenue: 250, conversions: 2, roas: 2.5, cpa: 50, ctr: 1, cpc: 1, impressions: 1000, clicks: 10 },
        { date: "2026-05-06", spend: 200, revenue: 700, conversions: 4, roas: 3.5, cpa: 50, ctr: 1, cpc: 1, impressions: 2000, clicks: 20 },
      ],
      freshness: {} as never,
      isPartial: false,
      notReadyReason: null,
      readSource: "warehouse_published",
    });
    mockSql({ targetRoas: 2.4, calibrationP50: 3.1 });
  });

  it("does not sum an unobserved day to zero", async () => {
    /**
     * D8. `totals()` reduces an empty row set to `spend: 0, purchases: 0`, and
     * the Decision Center printed that as "Spend · today ₺0 — 0 conversions ·
     * 7d avg 0" on an account with no warehouse rows at all — on the same
     * screen that said the warehouse was still being prepared. Measured on the
     * mounted route.
     *
     * Null, not zero: the client already renders null as an em-dash.
     */
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [] as never,
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pacing.spendToday).toBeNull();
    expect(payload.pacing.conversionsToday).toBeNull();
    expect(payload.pacing.avg7dSpend).toBeNull();
    expect(payload.pacing.avg7dConversions).toBeNull();
  });

  it("still reports an observed day that genuinely spent nothing", async () => {
    // The other half, and the reason this is counted rather than inferred from
    // the sum: a day that WAS observed and spent nothing is a measurement, and
    // must read as zero rather than as an em-dash.
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [campaign({ spend: 0, revenue: 0, purchases: 0, roas: 0, cpa: null })] as never,
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });

    const response = await GET(
      new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"),
    );
    const payload = await response.json();

    expect(payload.pacing.spendToday).toBe(0);
    expect(payload.pacing.conversionsToday).toBe(0);
    expect(payload.pacing.avg7dSpend).toBe(0);
  });

  it("returns the pulse payload shape", async () => {
    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.businessId).toBe("biz_1");
    expect(payload.statusFilter).toBe("active");
    expect(payload.pacing.mtdSpend).toBe(1200);
    expect(payload.pacing.spendToday).toBe(1200);
    expect(payload.pacing.avg7dSpend).toBeCloseTo(1200 / 7);
    expect(payload.pacing.conversionsToday).toBe(50);
    expect(payload.pacing.avg7dConversions).toBeCloseTo(50 / 7);
    expect(payload.roas.selected).toBe(3);
    expect(payload.roas.d28).toBe(3);
    expect(payload.roasHistory).toEqual([2.5, 3.5]);
    expect(payload.engineVersion).toBe(META_RECOMMENDATION_ENGINE_VERSION);
    expect(payload.snapshotHealth.status).toBe("fresh");
    expect(payload.campaignRoleCoverage).toMatchObject({
      activeCampaigns: 1,
      classifiedCampaigns: 1,
      unresolvedCampaigns: 0,
    });
    expect(payload).not.toHaveProperty("labelCoverage");
    expect(payload.targetAnchor.configured).toBe(true);
    expect(payload.trackingHealth.status).toBe("healthy");
    // Freshness is never fabricated: with no warehouse ingest metadata the
    // payload says unknown (null) instead of "now".
    expect(payload.lastSyncAt).toBeNull();
    expect(payload.currency).toBeNull();
    expect(payload.dataReadiness).toEqual({
      status: "ok",
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });
  });

  it("keeps campaign-role coverage unavailable when the context read fails", async () => {
    vi.mocked(campaignContext.readCampaignContextMap).mockRejectedValueOnce(
      new Error("campaign context unavailable"),
    );

    const response = await GET(
      new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.campaignRoleCoverage).toBeNull();
  });

  it("returns today spend and 7 day daily average for the pulse comparison tile", async () => {
    vi.mocked(campaigns.getMetaCampaignsForRange).mockImplementation(async (input) => {
      if (input.startDate === "2026-05-17" && input.endDate === "2026-05-17") {
        return {
          status: "ok",
          rows: [campaign({ id: "today_cmp", spend: 401, revenue: 1000, purchases: 1 })] as never,
          isPartial: false,
          notReadyReason: null,
          evidenceSource: "live",
        };
      }
      if (input.startDate === "2026-05-11" && input.endDate === "2026-05-17") {
        return {
          status: "ok",
          rows: [campaign({ id: "d7_cmp", spend: 2800, revenue: 7000, purchases: 14 })] as never,
          isPartial: false,
          notReadyReason: null,
          evidenceSource: "live",
        };
      }
      return {
        status: "ok",
        rows: [campaign({ id: "current_cmp", spend: 1700, revenue: 5100, purchases: 21 })] as never,
        isPartial: false,
        notReadyReason: null,
        evidenceSource: "live",
      };
    });

    const response = await GET(
      new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d&endDate=2026-05-17"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.pacing.spendToday).toBe(401);
    expect(payload.pacing.avg7dSpend).toBe(400);
    expect(payload.pacing.conversionsToday).toBe(1);
    expect(payload.pacing.avg7dConversions).toBe(2);
    expect(payload.pacing.dailyTarget).toBeCloseTo(payload.pacing.mtdTarget / 30);
  });

  it("uses Commercial Truth target ROAS as the target provenance", async () => {
    mockSql({ targetRoas: 1.8, calibrationP50: 4.55 });

    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.roas.target).toBe(1.8);
    expect(payload.roas.median).toBe(4.55);
    expect(payload.roas.target_source).toBe("commercial_truth");
    expect(payload.roas.targetFreshness).toBe("fresh");
  });

  it("keeps an old target visible as review-due without changing engine authority", async () => {
    mockSql({
      targetRoas: 1.8,
      calibrationP50: 4.55,
      targetUpdatedAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d",
      ),
    );
    const payload = await response.json();

    expect(payload.roas.target).toBe(1.8);
    expect(payload.roas.target_source).toBe("commercial_truth_stale");
    expect(payload.roas.targetFreshness).toBe("stale");
    expect(payload.targetAnchor).toMatchObject({
      configured: true,
      freshness: "stale",
    });
  });

  it("falls back to account-history median without pretending it is a target", async () => {
    mockSql({ targetRoas: null, calibrationP50: 4.55 });

    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.roas.target).toBeNull();
    expect(payload.roas.median).toBe(4.55);
    expect(payload.roas.target_source).toBe("account_median");
  });

  it("reports no benchmark when neither Commercial Truth nor calibration exists", async () => {
    mockSql({ targetRoas: null, calibrationP50: null });

    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.roas.target).toBeNull();
    expect(payload.roas.median).toBeNull();
    expect(payload.roas.target_source).toBe("none");
  });

  it("excludes closed campaigns from Pulse KPIs by default", async () => {
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        campaign({ id: "active_cmp", status: "ACTIVE", spend: 300, revenue: 900, purchases: 5 }),
        campaign({ id: "paused_cmp", status: "PAUSED", spend: 900, revenue: 1800, purchases: 9 }),
      ] as never,
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.pacing.mtdSpend).toBe(300);
    expect(payload.revenue.current).toBe(900);
    expect(payload.matureCampaigns).toBe(1);
  });

  it("includes closed campaigns when status_filter=all is requested", async () => {
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        campaign({ id: "active_cmp", status: "ACTIVE", spend: 100, revenue: 300, purchases: 3 }),
        campaign({ id: "archived_cmp", status: "ARCHIVED", spend: 900, revenue: 1800, purchases: 9 }),
      ] as never,
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "live",
    });

    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d&status_filter=all"));
    const payload = await response.json();

    expect(payload.statusFilter).toBe("all");
    expect(payload.pacing.mtdSpend).toBe(1000);
    expect(payload.revenue.current).toBe(2100);
  });

  it("uses one account-scoped warehouse series for the Decisions workspace fast path", async () => {
    const sql = mockSql({ targetRoas: 2.4, calibrationP50: 3.1 });
    (sql as unknown as { query: ReturnType<typeof vi.fn> }).query = vi.fn(
      async (text: string, params: unknown[]) => {
        if (text.includes("GROUP BY date")) {
          expect(params.slice(0, 2)).toEqual(["biz_1", "act_1"]);
          return [
            { date: "2026-07-04", spend: 70, revenue: 140, purchases: 2 },
            { date: "2026-07-10", spend: 100, revenue: 300, purchases: 3 },
          ];
        }
        if (text.includes("WITH selected AS")) {
          expect(params).toEqual(["biz_1", "act_1", "2026-07-04", "2026-07-10"]);
          return [
            {
              id: "cmp_iwa",
              status: "ACTIVE",
              bid_strategy_type: "cost_cap",
              account_currency: "USD",
              spend: 170,
              revenue: 440,
              purchases: 5,
            },
          ];
        }
        if (text.includes("ORDER BY date DESC, updated_at DESC")) {
          return [{ last_sync_at: "2026-07-10T23:00:00.000Z" }];
        }
        return [];
      },
    );

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/account-pulse?businessId=biz_1&providerAccountId=act_1&window=7d&status_filter=all&endDate=2026-07-10&decision_workspace=1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(campaigns.getMetaCampaignsForRange).not.toHaveBeenCalled();
    expect(payload.pacing.windowSpend).toBe(170);
    expect(payload.roas.selected).toBeCloseTo(440 / 170);
    expect(payload.currency).toBe("USD");
    expect(payload.dataReadiness.evidenceSource).toBe("warehouse");
    expect(payload.lastSyncAt).toBe("2026-07-10T23:00:00.000Z");
  });


  it("returns the real warehouse ingest timestamp and account currency", async () => {
    mockSql({ targetRoas: 2.4, lastSyncAt: "2026-07-06 09:12:00" });
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [campaign({ currency: "TRY" })] as never,
      isPartial: false,
      notReadyReason: null,
      evidenceSource: "snapshot",
    });
    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1"));
    const payload = await response.json();
    expect(payload.lastSyncAt).toBe("2026-07-06 09:12:00");
    expect(payload.currency).toBe("TRY");
  });

  it("computes true month-to-date pacing instead of relabeling the selected window", async () => {
    vi.mocked(campaigns.getMetaCampaignsForRange).mockImplementation(async (input) => {
      const monthStart = `${String(input.endDate).slice(0, 8)}01`;
      if (input.startDate === monthStart) {
        return {
          status: "ok" as const,
          rows: [campaign({ spend: 5000 })] as never,
          isPartial: false,
          notReadyReason: null,
          evidenceSource: "snapshot" as const,
        };
      }
      return {
        status: "ok" as const,
        rows: [campaign({ spend: 1200 })] as never,
        isPartial: false,
        notReadyReason: null,
        evidenceSource: "snapshot" as const,
      };
    });
    const response = await GET(
      new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=7d&endDate=2026-07-15"),
    );
    const payload = await response.json();
    expect(payload.pacing.mtdSpend).toBe(5000);
    expect(payload.pacing.windowSpend).toBe(1200);
    // day 15 of month: extrapolated target = 5000/15*30 = 10000
    expect(payload.pacing.mtdTarget).toBeCloseTo(10000, 5);
  });

  it("surfaces not-ready data instead of silently reporting zeros", async () => {
    vi.mocked(campaigns.getMetaCampaignsForRange).mockResolvedValue({
      status: "no_accounts_assigned",
      rows: [] as never,
      isPartial: false,
      notReadyReason: "No Meta ad account is assigned to this workspace.",
      evidenceSource: "unknown",
    });
    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1"));
    const payload = await response.json();
    expect(payload.dataReadiness.status).toBe("no_accounts_assigned");
    expect(payload.dataReadiness.notReadyReason).toContain("assigned");
    expect(payload.lastSyncAt).toBeNull();
  });

  it("authorizes guest access", async () => {
    const request = new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1");
    await GET(request);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId: "biz_1",
      minRole: "guest",
    });
  });

  it("reports unknown tracking health when recent lifecycle rows are absent", async () => {
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      if (text.includes("FROM business_target_packs")) return [{ target_roas: 2.4 }];
      if (text.includes("FROM meta_decision_calibration_daily")) return [{ p50: 3.1 }];
      if (text.includes("meta_decision_snapshots_daily")) {
        return [{ latest_snapshot_date: "2026-05-07", engine_last_run: new Date().toISOString(), engine_version: "v1.0.0" }];
      }
      if (text.includes("engine_v3_creative_lifecycle_daily")) {
        return [{ row_count: 0, tracking_anomaly_score: null }];
      }
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(payload.trackingHealth).toMatchObject({
      status: "unknown",
      detail: "Recent creative lifecycle tracking data is unavailable.",
    });
  });
});
