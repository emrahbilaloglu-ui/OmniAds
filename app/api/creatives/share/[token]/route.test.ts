import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/creative-share-store", () => ({
  getCreativeShareSnapshot: vi.fn(),
  getCreativeShareLedgerCapability: vi.fn(),
  deleteCreativeShareSnapshot: vi.fn(),
  revokeCreativeShareSnapshot: vi.fn(),
  rotateCreativeShareSnapshot: vi.fn(),
}));

vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: vi.fn(() => null),
}));

const access = await import("@/lib/access");
const shareStore = await import("@/lib/creative-share-store");
const reviewerGuard = await import("@/lib/meta/reviewer-write-guard");
const { DELETE, GET, POST } = await import("@/app/api/creatives/share/[token]/route");

const TOKEN = "a".repeat(32);
const context = { params: Promise.resolve({ token: TOKEN }) };

describe("/api/creatives/share/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "trusted_user", email: "operator@example.com" } } as never,
      membership: { businessId: "trusted_business", role: "collaborator" } as never,
    });
    vi.mocked(shareStore.revokeCreativeShareSnapshot).mockResolvedValue(true);
    vi.mocked(shareStore.deleteCreativeShareSnapshot).mockResolvedValue(true);
    vi.mocked(shareStore.rotateCreativeShareSnapshot).mockResolvedValue({
      token: "share_rotated",
      url: "/share/creative/share_rotated",
    });
    vi.mocked(shareStore.getCreativeShareLedgerCapability).mockResolvedValue({
      status: "ready",
      canReadLedger: true,
      canWrite: true,
      missingColumns: [],
    });
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(null);
  });

  it("serves public reads with no-store headers", async () => {
    vi.mocked(shareStore.getCreativeShareSnapshot).mockResolvedValue({
      token: TOKEN,
      title: "Creative share",
      dateRange: "Last 7d",
      createdAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-17T00:00:00.000Z",
      businessId: "private_business",
      providerAccountId: "private_account",
      metrics: ["ctrAll"],
      includeNotes: false,
      audience: "buyer",
      clientActions: [
        {
          id: "private_action_log_id",
          what: "Paused an ad",
          why: "It was inefficient.",
          date: "2026-07-10",
        },
      ],
      creatives: [],
    });

    const response = await GET(
      new NextRequest(`http://localhost/api/creatives/share/${TOKEN}`),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    const body = await response.json();
    expect(body.payload).not.toHaveProperty("businessId");
    expect(body.payload).not.toHaveProperty("providerAccountId");
    expect(body.payload.actions).toEqual([
      expect.objectContaining({ what: "Paused an ad" }),
    ]);
    expect(JSON.stringify(body)).not.toContain("private_action_log_id");
  });

  it("returns the same no-store 404 for missing, expired, or revoked tokens", async () => {
    vi.mocked(shareStore.getCreativeShareSnapshot).mockResolvedValue(null);

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/share/share_token"),
      context,
    );
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(payload.message).toContain("revoked");
  });

  it("requires collaborator access and revokes with trusted business/user attribution", async () => {
    const response = await DELETE(
      new NextRequest(
        "http://localhost/api/creatives/share/share_token?businessId=request_business",
        { method: "DELETE" },
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "request_business",
        minRole: "collaborator",
      }),
    );
    expect(shareStore.revokeCreativeShareSnapshot).toHaveBeenCalledWith({
      token: TOKEN,
      businessId: "trusted_business",
      revokedBy: "trusted_user",
    });
  });

  it("rejects revoke requests without a business scope", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/creatives/share/share_token", {
        method: "DELETE",
      }),
      context,
    );

    expect(response.status).toBe(400);
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(shareStore.revokeCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("returns a non-disclosing 404 when the scoped revoke finds no row", async () => {
    vi.mocked(shareStore.revokeCreativeShareSnapshot).mockResolvedValue(false);

    const response = await DELETE(
      new NextRequest(
        "http://localhost/api/creatives/share/share_token?businessId=request_business",
        { method: "DELETE" },
      ),
      context,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
  });

  it("honors the reviewer read-only write guard", async () => {
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(
      NextResponse.json({ error: "reviewer_read_only" }, { status: 403 }),
    );

    const response = await DELETE(
      new NextRequest(
        "http://localhost/api/creatives/share/share_token?businessId=request_business",
        { method: "DELETE" },
      ),
      context,
    );

    expect(response.status).toBe(403);
    expect(shareStore.revokeCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("rotates through a collaborator-scoped atomic store operation", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/creatives/share/share_token", {
        method: "POST",
        body: JSON.stringify({ businessId: "request_business", action: "rotate" }),
      }),
      context,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.token).toBe("share_rotated");
    expect(shareStore.rotateCreativeShareSnapshot).toHaveBeenCalledWith({
      token: TOKEN,
      businessId: "trusted_business",
      revokedBy: "trusted_user",
    });
    expect(reviewerGuard.rejectIfReviewerReadOnly).toHaveBeenCalledWith(
      expect.any(Object),
      "creative_share_rotate",
    );
  });

  it("hard-deletes a link through a collaborator-scoped store operation", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/creatives/share/share_token", {
        method: "POST",
        body: JSON.stringify({ businessId: "request_business", action: "delete" }),
      }),
      context,
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ deleted: true, token: TOKEN });
    expect(shareStore.deleteCreativeShareSnapshot).toHaveBeenCalledWith({
      token: TOKEN,
      businessId: "trusted_business",
      revokedBy: "trusted_user",
    });
    expect(shareStore.rotateCreativeShareSnapshot).not.toHaveBeenCalled();
    expect(reviewerGuard.rejectIfReviewerReadOnly).toHaveBeenCalledWith(
      expect.any(Object),
      "creative_share_delete",
    );
  });

  it("rejects a POST whose action is neither rotate nor delete", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/creatives/share/share_token", {
        method: "POST",
        body: JSON.stringify({ businessId: "request_business", action: "archive" }),
      }),
      context,
    );

    expect(response.status).toBe(400);
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(shareStore.deleteCreativeShareSnapshot).not.toHaveBeenCalled();
    expect(shareStore.rotateCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("returns a non-disclosing 404 when the scoped delete finds no row", async () => {
    vi.mocked(shareStore.deleteCreativeShareSnapshot).mockResolvedValue(false);

    const response = await POST(
      new NextRequest("http://localhost/api/creatives/share/share_token", {
        method: "POST",
        body: JSON.stringify({ businessId: "request_business", action: "delete" }),
      }),
      context,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
  });
});
