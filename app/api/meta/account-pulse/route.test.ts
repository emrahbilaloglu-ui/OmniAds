import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/campaign-labels", () => ({
  readMetaCampaignLabels: vi.fn(),
}));

vi.mock("@/lib/meta/canonical-overview", () => ({
  getMetaCanonicalOverviewTrends: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const access = await import("@/lib/access");
const campaigns = await import("@/lib/meta/campaigns-source");
const campaignLabels = await import("@/lib/meta/campaign-labels");
const canonicalOverview = await import("@/lib/meta/canonical-overview");
const db = await import("@/lib/db");
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
  calibrationP50?: number | null;
  trackingScore?: number | null;
} = {}) {
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    if (text.includes("FROM business_target_packs")) {
      return input.targetRoas == null ? [] : [{ target_roas: input.targetRoas }];
    }
    if (text.includes("FROM meta_decision_calibration_daily")) {
      return input.calibrationP50 == null ? [] : [{ p50: input.calibrationP50 }];
    }
    if (text.includes("meta_decision_snapshots_daily")) {
      return [{ latest_snapshot_date: "2026-05-07", engine_last_run: new Date().toISOString(), engine_version: "v1.0.0" }];
    }
    if (text.includes("engine_v3_creative_lifecycle_daily")) {
      return [{ row_count: 1, tracking_anomaly_score: input.trackingScore ?? 0.1 }];
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
    vi.mocked(campaignLabels.readMetaCampaignLabels).mockResolvedValue([
      {
        businessId: "biz_1",
        campaignId: "cmp_1",
        kind: "main",
        testDimension: null,
        source: "user",
        providerAccountId: "act_1",
        campaignName: "ASC",
        labeledBy: "user_1",
        labeledAt: "2026-05-15T10:00:00.000Z",
        updatedAt: "2026-05-15T10:00:00.000Z",
      },
    ]);
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
    expect(payload.engineVersion).toBe("v1.0.0");
    expect(payload.snapshotHealth.status).toBe("fresh");
    expect(payload.labelCoverage).toMatchObject({
      activeCampaigns: 1,
      labeledCampaigns: 1,
      unlabeledCampaigns: 0,
    });
    expect(payload.targetAnchor.configured).toBe(true);
    expect(payload.trackingHealth.status).toBe("healthy");
    expect(typeof payload.lastSyncAt).toBe("string");
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
