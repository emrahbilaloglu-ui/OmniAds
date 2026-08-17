import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireBusinessAccess: vi.fn(),
  listBusinessTargetPackHistory: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: mocks.requireBusinessAccess,
}));
vi.mock("@/lib/business-commercial", () => ({
  listBusinessTargetPackHistory: mocks.listBusinessTargetPackHistory,
}));
vi.mock("@/lib/account-store", () => ({
  getUserById: mocks.getUserById,
}));

import { GET } from "@/app/api/business-commercial-settings/history/route";

describe("GET /api/business-commercial-settings/history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireBusinessAccess.mockResolvedValue({
      membership: { role: "guest" },
      session: { user: { id: "user_1" } },
    });
    mocks.getUserById.mockResolvedValue(null);
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

  it("names the acting user so the change log is not a row of em dashes", async () => {
    mocks.getUserById.mockResolvedValue({ id: "user_1", name: "Emrah B.", email: "e@x.co" });
    mocks.listBusinessTargetPackHistory.mockResolvedValue([
      {
        id: "new",
        operation: "upsert",
        effectiveAt: "2026-08-16T10:00:00.000Z",
        recordedAt: "2026-08-16T10:00:00.000Z",
        sourceLabel: "manual save",
        updatedByUserId: "user_1",
        targetPack: { targetRoas: 4 },
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/business-commercial-settings/history?businessId=biz_1"),
    );
    const payload = (await response.json()) as { entries: Array<{ actor: string | null }> };
    expect(payload.entries[0].actor).toBe("Emrah B.");
    // Resolved once per distinct id, not once per revision.
    expect(mocks.getUserById).toHaveBeenCalledTimes(1);
  });

  it("leaves the actor null when the user cannot be read", async () => {
    mocks.getUserById.mockRejectedValue(new Error("schema not ready"));
    mocks.listBusinessTargetPackHistory.mockResolvedValue([
      {
        id: "new",
        operation: "upsert",
        effectiveAt: "2026-08-16T10:00:00.000Z",
        recordedAt: "2026-08-16T10:00:00.000Z",
        sourceLabel: "manual save",
        updatedByUserId: "user_1",
        targetPack: { targetRoas: 4 },
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/business-commercial-settings/history?businessId=biz_1"),
    );
    const payload = (await response.json()) as { entries: Array<{ actor: string | null }> };
    expect(payload.entries[0].actor).toBeNull();
  });

  it("rejects a request without business scope", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/business-commercial-settings/history"),
    );
    expect(response.status).toBe(400);
    expect(mocks.listBusinessTargetPackHistory).not.toHaveBeenCalled();
  });
});
