import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/meta/recommendations/respond/route";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/meta/decision-responses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/decision-responses")>();
  return {
    ...actual,
    recordMetaDecisionResponse: vi.fn(),
    emitMetaDecisionResponseTelemetry: vi.fn(),
  };
});

const access = await import("@/lib/access");
const responses = await import("@/lib/meta/decision-responses");

describe("POST /api/meta/recommendations/respond", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } } as never,
      membership: { businessId: "biz_1" } as never,
    });
    vi.mocked(responses.recordMetaDecisionResponse).mockResolvedValue({
      recId: "rec_1",
      businessId: "biz_1",
      action: "deferred",
      actionSubtype: "let_cook_24h",
      timestamp: "2026-05-06T10:00:00.000Z",
      reappearAt: "2026-05-07T10:00:00.000Z",
    });
    vi.mocked(responses.emitMetaDecisionResponseTelemetry).mockReturnValue({
      contractVersion: "operator-decision-telemetry-event.v1",
    } as never);
  });

  it("validates required fields and action values", async () => {
    const missing = await POST(
      new NextRequest("http://localhost/api/meta/recommendations/respond", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1", action: "deferred" }),
      }),
    );
    expect(missing.status).toBe(400);

    const invalid = await POST(
      new NextRequest("http://localhost/api/meta/recommendations/respond", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1", recId: "rec_1", action: "dismissed" }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(responses.recordMetaDecisionResponse).not.toHaveBeenCalled();
  });

  it("requires collaborator access, persists the response, and emits telemetry", async () => {
    const request = new NextRequest("http://localhost/api/meta/recommendations/respond", {
      method: "POST",
      body: JSON.stringify({
        businessId: "biz_1",
        recId: "rec_1",
        action: "deferred",
        actionSubtype: "let_cook_24h",
        reappearAt: "2026-05-07T10:00:00.000Z",
      }),
    });

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId: "biz_1",
      minRole: "collaborator",
    });
    expect(responses.recordMetaDecisionResponse).toHaveBeenCalledWith({
      recId: "rec_1",
      businessId: "biz_1",
      action: "deferred",
      actionSubtype: "let_cook_24h",
      reappearAt: "2026-05-07T10:00:00.000Z",
    });
    expect(responses.emitMetaDecisionResponseTelemetry).toHaveBeenCalledWith({
      recId: "rec_1",
      businessId: "biz_1",
      action: "deferred",
      actionSubtype: "let_cook_24h",
    });
  });

  it("returns auth errors without persistence", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/meta/recommendations/respond", {
        method: "POST",
        body: JSON.stringify({ businessId: "biz_1", recId: "rec_1", action: "ignored" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(responses.recordMetaDecisionResponse).not.toHaveBeenCalled();
    expect(responses.emitMetaDecisionResponseTelemetry).not.toHaveBeenCalled();
  });
});
