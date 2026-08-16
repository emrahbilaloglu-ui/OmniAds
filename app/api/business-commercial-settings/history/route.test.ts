import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
  listBusinessTargetPackHistory: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: mocks.requireBusinessAccess,
}));
vi.mock("@/lib/business-commercial", () => ({
  listBusinessTargetPackHistory: mocks.listBusinessTargetPackHistory,
}));

import { GET } from "@/app/api/business-commercial-settings/history/route";

describe("GET /api/business-commercial-settings/history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBusinessAccess.mockResolvedValue({
      membership: { role: "guest" },
      session: { user: { id: "user_1" } },
    });
  });

  it("returns the persisted target-pack revisions with field-level labels", async () => {
    mocks.listBusinessTargetPackHistory.mockResolvedValue([
      {
        id: "new",
        operation: "upsert",
        effectiveAt: "2026-08-16T10:00:00.000Z",
        recordedAt: "2026-08-16T10:00:00.000Z",
        sourceLabel: "manual save",
        updatedByUserId: "user_1",
        targetPack: { targetRoas: 4, targetCpa: 20 },
      },
      {
        id: "old",
        operation: "upsert",
        effectiveAt: "2026-08-15T10:00:00.000Z",
        recordedAt: "2026-08-15T10:00:00.000Z",
        sourceLabel: "manual save",
        updatedByUserId: "user_1",
        targetPack: { targetRoas: 3.5, targetCpa: 20 },
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/business-commercial-settings/history?businessId=biz_1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      entries: [
        { id: "new", changes: ["Target ROAS updated"] },
        { id: "old", changes: ["Target pack created"] },
      ],
    });
    expect(mocks.listBusinessTargetPackHistory).toHaveBeenCalledWith({
      businessId: "biz_1",
      limit: 20,
    });
  });

  it("rejects a request without business scope", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/business-commercial-settings/history"),
    );
    expect(response.status).toBe(400);
    expect(mocks.listBusinessTargetPackHistory).not.toHaveBeenCalled();
  });
});
