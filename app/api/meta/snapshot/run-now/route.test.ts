import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/snapshot-refresh", () => ({
  requestMetaSnapshotRefreshForBusiness: vi.fn(),
}));

const access = await import("@/lib/access");
const snapshotRefresh = await import("@/lib/meta/snapshot-refresh");
const { POST } = await import("@/app/api/meta/snapshot/run-now/route");

describe("POST /api/meta/snapshot/run-now", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).mockResolvedValue({
      ok: true,
      status: "ran",
      businessId: "biz_1",
      snapshotDate: "2026-05-16",
      reason: "manual",
      cooldownUntil: "2026-05-16T00:05:00.000Z",
      message: "Meta recommendation snapshot refreshed.",
    });
  });

  it("runs a manual snapshot refresh behind collaborator access", async () => {
    const request = new NextRequest("http://localhost/api/meta/snapshot/run-now", {
      method: "POST",
      body: JSON.stringify({ businessId: "biz_1" }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId: "biz_1",
      minRole: "collaborator",
    });
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).toHaveBeenCalledWith({
      businessId: "biz_1",
      reason: "manual",
    });
    expect(payload.status).toBe("ran");
  });

  it("requires businessId", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/meta/snapshot/run-now", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("missing_business_id");
    expect(snapshotRefresh.requestMetaSnapshotRefreshForBusiness).not.toHaveBeenCalled();
  });
});
