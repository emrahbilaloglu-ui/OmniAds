import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/creative-share-store", () => ({
  getCreativeShareSnapshot: vi.fn(),
  getCreativeShareLedgerCapability: vi.fn(),
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

const context = { params: Promise.resolve({ token: "share_token" }) };

describe("/api/creatives/share/[token]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "trusted_user", email: "operator@example.com" } } as never,
      membership: { businessId: "trusted_business", role: "collaborator" } as never,
    });
    vi.mocked(shareStore.revokeCreativeShareSnapshot).mockResolvedValue(true);
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
      token: "share_token",
      title: "Creative share",
      dateRange: "Last 7d",
      createdAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-17T00:00:00.000Z",
      metrics: ["ctrAll"],
      includeNotes: false,
      audience: "external",
      creatives: [],
    });

    const response = await GET(
      new NextRequest("http://localhost/api/creatives/share/share_token"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
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
      token: "share_token",
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
      token: "share_token",
      businessId: "trusted_business",
      revokedBy: "trusted_user",
    });
    expect(reviewerGuard.rejectIfReviewerReadOnly).toHaveBeenCalledWith(
      expect.any(Object),
      "creative_share_rotate",
    );
  });
});
