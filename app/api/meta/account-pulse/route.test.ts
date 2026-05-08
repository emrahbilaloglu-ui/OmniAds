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
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join(" ");
      if (text.includes("meta_decision_snapshots_daily")) {
        return [{ engine_last_run: "2026-05-07T03:00:00.000Z", engine_version: "v3.6.0-meta-taxonomy" }];
      }
      return [{ tracking_anomaly_score: 0.1 }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);
  });

  it("returns the pulse payload shape", async () => {
    const response = await GET(new NextRequest("http://localhost/api/meta/account-pulse?businessId=biz_1&window=28d"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.businessId).toBe("biz_1");
    expect(payload.pacing.mtdSpend).toBe(1200);
    expect(payload.roas.d28).toBe(3);
    expect(payload.engineVersion).toBe("v3.6.0-meta-taxonomy");
    expect(payload.trackingHealth.status).toBe("healthy");
    expect(typeof payload.lastSyncAt).toBe("string");
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
