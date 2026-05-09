import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

const access = await import("@/lib/access");
const campaigns = await import("@/lib/meta/campaigns-source");
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
      return [{ engine_last_run: "2026-05-07T03:00:00.000Z", engine_version: "v3.6.0-meta-taxonomy" }];
    }
    if (text.includes("creative_lifecycle_daily")) {
      return [{ tracking_anomaly_score: input.trackingScore ?? 0.1 }];
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
    mockSql({ targetRoas: 2.4, calibrationP50: 3.1 });
  });

  it("returns the pulse payload shape", async () => {
    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.businessId).toBe("biz_1");
    expect(payload.statusFilter).toBe("active");
    expect(payload.pacing.mtdSpend).toBe(1200);
    expect(payload.roas.d28).toBe(3);
    expect(payload.engineVersion).toBe("v3.6.0-meta-taxonomy");
    expect(payload.trackingHealth.status).toBe("healthy");
    expect(typeof payload.lastSyncAt).toBe("string");
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
});
