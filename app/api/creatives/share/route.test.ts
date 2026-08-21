import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUYER_ACKNOWLEDGEMENT_VALUE } from "@/lib/zero-base/creative/share-acknowledgement";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/creative-share-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creative-share-store")>(
    "@/lib/creative-share-store",
  );
  return {
    ...actual,
    createCreativeShareSnapshot: vi.fn(),
    listCreativeShareSnapshots: vi.fn(),
    getCreativeShareLedgerCapability: vi.fn(),
  };
});

vi.mock("@/lib/creatives/client-action-feed", () => ({
  buildBuyerClientActions: vi.fn(),
}));

vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: vi.fn(() => null),
}));

vi.mock("@/lib/meta/creatives-fetchers", () => ({
  fetchAssignedAccountIds: vi.fn(),
}));

const access = await import("@/lib/access");
const shareStore = await import("@/lib/creative-share-store");
const clientActionFeed = await import("@/lib/creatives/client-action-feed");
const reviewerGuard = await import("@/lib/meta/reviewer-write-guard");
const creativeFetchers = await import("@/lib/meta/creatives-fetchers");
const { GET, POST } = await import("@/app/api/creatives/share/route");
const TOKEN = "a".repeat(32);

const baseBody = {
  title: "Creative share",
  dateRange: "Last 7d",
  expiresAt: "2099-01-01T00:00:00.000Z",
  businessId: "request_business",
  providerAccountId: "act_1",
  metrics: ["ctrAll"],
  includeNotes: false,
  audience: "external",
  creatives: [
    {
      id: "creative_1",
      name: "Hero",
      format: "image",
      launchDate: "2026-08-01",
      preview: {
        render_mode: "unavailable",
        image_url: null,
        video_url: null,
        poster_url: null,
        source: null,
        is_catalog: false,
      },
    },
  ],
};

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/creatives/share", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/creatives/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "trusted_user", email: "operator@example.com" } } as never,
      membership: { businessId: "trusted_business", role: "collaborator" } as never,
    });
    vi.mocked(shareStore.createCreativeShareSnapshot).mockResolvedValue({
      token: TOKEN,
      payload: {} as never,
    });
    vi.mocked(shareStore.listCreativeShareSnapshots).mockResolvedValue([]);
    vi.mocked(shareStore.getCreativeShareLedgerCapability).mockResolvedValue({
      status: "ready",
      canReadLedger: true,
      canWrite: true,
      missingColumns: [],
    });
    vi.mocked(clientActionFeed.buildBuyerClientActions).mockResolvedValue([]);
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(null);
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue(["act_1"]);
  });

  it("requires collaborator access and mints with server-trusted attribution", async () => {
    const response = await POST(postRequest(baseBody));
    const responseBody = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "request_business",
        minRole: "collaborator",
      }),
    );
    expect(shareStore.createCreativeShareSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "trusted_business",
        providerAccountId: "act_1",
        audience: "external",
        clientActions: undefined,
      }),
      {
        businessId: "trusted_business",
        providerAccountId: "act_1",
        createdBy: "trusted_user",
      },
    );
    expect(responseBody).toEqual({
      token: TOKEN,
      path: `/share/creative/${TOKEN}`,
      url: `/share/creative/${TOKEN}`,
    });
  });

  it("lists grants using the trusted business and assigned account scope", async () => {
    vi.mocked(shareStore.listCreativeShareSnapshots).mockResolvedValue([
      { token: "share_1" } as never,
    ]);
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/share?businessId=request_business&providerAccountId=act_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.grants).toHaveLength(1);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "request_business", minRole: "guest" }),
    );
    expect(shareStore.listCreativeShareSnapshots).toHaveBeenCalledWith({
      businessId: "trusted_business",
      providerAccountId: "act_1",
    });
  });

  it("reports migration-required capability without running an unscoped legacy ledger query", async () => {
    vi.mocked(shareStore.getCreativeShareLedgerCapability).mockResolvedValue({
      status: "migration_required",
      canReadLedger: false,
      canWrite: false,
      missingColumns: ["business_id", "provider_account_id"],
    });
    const response = await GET(
      new NextRequest(
        "http://localhost/api/creatives/share?businessId=request_business&providerAccountId=act_1",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.capability.status).toBe("migration_required");
    expect(payload.grants).toEqual([]);
    expect(shareStore.listCreativeShareSnapshots).not.toHaveBeenCalled();
  });

  it("preserves missing-audience compatibility as buyer and sources actions server-side", async () => {
    vi.mocked(clientActionFeed.buildBuyerClientActions).mockResolvedValue([
      {
        id: "action_1",
        what: "Paused ad",
        why: "Below target",
        date: "2026-07-10",
        outcome: null,
        outcomeTone: "neutral",
      },
    ]);
    // A caller that omits `audience` still resolves to buyer — the
    // compatibility this test protects. Buyer now also requires the financial
    // acknowledgement, which is precisely the hole this closes: a legacy
    // caller could otherwise ship money outside the workspace with no warning.
    const response = await POST(
      postRequest({
        ...baseBody,
        audience: undefined,
        acknowledgement: BUYER_ACKNOWLEDGEMENT_VALUE,
      }),
    );

    expect(response.status).toBe(200);
    expect(clientActionFeed.buildBuyerClientActions).toHaveBeenCalledWith({
      businessId: "trusted_business",
      providerAccountId: "act_1",
    });
    expect(shareStore.createCreativeShareSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: "buyer",
        clientActions: [expect.objectContaining({ id: "action_1" })],
      }),
      expect.any(Object),
    );
  });

  it("requires an explicit account when more than one Meta account is assigned", async () => {
    vi.mocked(creativeFetchers.fetchAssignedAccountIds).mockResolvedValue([
      "act_1",
      "act_2",
    ]);

    const response = await POST(
      postRequest({ ...baseBody, providerAccountId: undefined }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("provider_account_required");
    expect(shareStore.createCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a provider account that is not assigned to the business", async () => {
    const response = await POST(
      postRequest({ ...baseBody, providerAccountId: "act_other" }),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe("account_not_assigned");
    expect(shareStore.createCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("rejects malformed audiences before access or persistence", async () => {
    const response = await POST(postRequest({ ...baseBody, audience: "client" }));

    expect(response.status).toBe(400);
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(shareStore.createCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("rejects malformed creative rows before storage can throw", async () => {
    const response = await POST(
      postRequest({ ...baseBody, creatives: [{ id: "creative_1" }] }),
    );

    expect(response.status).toBe(400);
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(shareStore.createCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("does not mint when collaborator access is denied", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "auth_error" }, { status: 403 }),
    });

    const response = await POST(postRequest(baseBody));

    expect(response.status).toBe(403);
    expect(shareStore.createCreativeShareSnapshot).not.toHaveBeenCalled();
  });

  it("honors the reviewer read-only write guard", async () => {
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(
      NextResponse.json({ error: "reviewer_read_only" }, { status: 403 }),
    );

    const response = await POST(postRequest(baseBody));

    expect(response.status).toBe(403);
    expect(reviewerGuard.rejectIfReviewerReadOnly).toHaveBeenCalledWith(
      expect.any(Object),
      "creative_share_create",
    );
    expect(shareStore.createCreativeShareSnapshot).not.toHaveBeenCalled();
  });
});
