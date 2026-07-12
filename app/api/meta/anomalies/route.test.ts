import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/meta/anomalies/route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/anomalies", () => ({
  readMetaAnomaliesForBusiness: vi.fn(),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

const access = await import("@/lib/access");
const anomalies = await import("@/lib/meta/anomalies");
const fetchers = await import("@/lib/meta/creatives-fetchers");

describe("GET /api/meta/anomalies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
    vi.mocked(anomalies.readMetaAnomaliesForBusiness).mockResolvedValue({
      snapshotDate: "2026-05-06",
      count: 1,
      anomalies: [
        {
          id: "anom_1",
          type: "policy_block",
          scopeType: "adset",
          scopeId: "adset_1",
          scopeLabel: "Adset 1",
          severity: "high",
          kind: "anomaly",
          title: "Policy delivery block",
          detail: "Rejected ad is blocking delivery.",
          diagnostics: ["Ad 1: REJECTED"],
          detectedAt: "2026-05-06T03:00:00.000Z",
        },
      ],
    });
  });

  it("returns active anomalies in the documented shape", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/meta/anomalies?businessId=biz_1&activeOnly=1"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      snapshotDate: "2026-05-06",
      count: 1,
      anomalies: [
        {
          id: "anom_1",
          type: "policy_block",
          scopeType: "adset",
          scopeId: "adset_1",
          scopeLabel: "Adset 1",
          severity: "high",
          kind: "anomaly",
          title: "Policy delivery block",
          detail: "Rejected ad is blocking delivery.",
          diagnostics: ["Ad 1: REJECTED"],
          detectedAt: "2026-05-06T03:00:00.000Z",
        },
      ],
    });
    expect(anomalies.readMetaAnomaliesForBusiness).toHaveBeenCalledWith({
      businessId: "biz_1",
      providerAccountId: "act_1",
      activeOnly: true,
      endDate: null,
      statusFilter: null,
    });
  });

  it("authorizes business access with guest role", async () => {
    const request = new NextRequest("http://localhost/api/meta/anomalies?businessId=biz_1");

    await GET(request);

    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId: "biz_1",
      minRole: "guest",
    });
    expect(anomalies.readMetaAnomaliesForBusiness).toHaveBeenCalledWith({
      businessId: "biz_1",
      providerAccountId: "act_1",
      activeOnly: false,
      endDate: null,
      statusFilter: null,
    });
  });

  it("returns auth errors without reading anomalies", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/anomalies?businessId=biz_1"),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toBe("forbidden");
    expect(anomalies.readMetaAnomaliesForBusiness).not.toHaveBeenCalled();
  });

  it("rejects missing businessId", async () => {
    const response = await GET(new NextRequest("http://localhost/api/meta/anomalies"));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("missing_params");
    expect(anomalies.readMetaAnomaliesForBusiness).not.toHaveBeenCalled();
  });
  it("threads endDate scoping into the anomaly read", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/anomalies?businessId=biz_1&activeOnly=1&endDate=2026-06-15",
      ),
    );
    expect(response.status).toBe(200);
    expect(anomalies.readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz_1", endDate: "2026-06-15" }),
    );
  });

  it("passes null endDate when the param is absent", async () => {
    await GET(new NextRequest("http://localhost/api/meta/anomalies?businessId=biz_1"));
    expect(anomalies.readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ endDate: null }),
    );
  });

  it("threads status_filter into the anomaly read", async () => {
    await GET(
      new NextRequest(
        "http://localhost/api/meta/anomalies?businessId=biz_1&status_filter=active_plus_recent_paused",
      ),
    );
    expect(anomalies.readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ statusFilter: "active_plus_recent_paused" }),
    );
  });

  it("passes null statusFilter when the param is absent (no filtering)", async () => {
    await GET(new NextRequest("http://localhost/api/meta/anomalies?businessId=biz_1"));
    expect(anomalies.readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ statusFilter: null }),
    );
  });

  it("coerces an invalid status_filter to the safe default instead of erroring", async () => {
    await GET(
      new NextRequest("http://localhost/api/meta/anomalies?businessId=biz_1&status_filter=bogus"),
    );
    expect(anomalies.readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ statusFilter: "active" }),
    );
  });

  it("requires an explicit account for a multi-account business", async () => {
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/meta/anomalies?businessId=biz_1"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "provider_account_required",
    });
    expect(anomalies.readMetaAnomaliesForBusiness).not.toHaveBeenCalled();
  });

  it("threads an assigned explicit provider account into the read", async () => {
    vi.mocked(fetchers.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/anomalies?businessId=biz_1&providerAccountId=act_2",
      ),
    );

    expect(response.status).toBe(200);
    expect(anomalies.readMetaAnomaliesForBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_2" }),
    );
  });
});
