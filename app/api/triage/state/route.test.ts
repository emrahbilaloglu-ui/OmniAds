import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { readTriageState } from "@/lib/triage-events";
import { GET } from "./route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/triage-events", () => ({
  readTriageState: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireBusinessAccess).mockResolvedValue({
    session: { user: { id: "user_1", email: "operator@adsecute.com" } } as never,
    membership: {
      id: "membership_1",
      userId: "user_1",
      businessId: "biz_1",
      role: "guest",
      status: "active",
      joinedAt: "2026-05-07T00:00:00.000Z",
    },
  });
  vi.mocked(readTriageState).mockResolvedValue({
    rows: [
      {
        businessId: "biz_1",
        scopeType: "creative",
        scopeId: "cr_1",
        action: "deferred",
        timestamp: "2026-05-07T00:00:00.000Z",
        reappearAt: "2026-05-08T00:00:00.000Z",
      },
    ],
    deferredCount: 1,
  });
});

describe("GET /api/triage/state", () => {
  it("returns scoped triage state", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/triage/state?businessId=biz_1&scopeType=creative"),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.deferredCount).toBe(1);
    expect(readTriageState).toHaveBeenCalledWith({
      businessId: "biz_1",
      scopeType: "creative",
    });
  });

  it("returns auth errors unchanged", async () => {
    vi.mocked(requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "auth_error" }, { status: 403 }),
    });

    const response = await GET(
      new NextRequest("http://localhost/api/triage/state?businessId=biz_1"),
    );

    expect(response.status).toBe(403);
    expect(readTriageState).not.toHaveBeenCalled();
  });
});
