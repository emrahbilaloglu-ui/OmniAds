import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-store", () => ({
  deleteMetaLaunchDraft: vi.fn(),
}));

const access = await import("@/lib/access");
const store = await import("@/lib/launchpad/meta-store");
const { DELETE } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";

function request(id: string) {
  return {
    request: new NextRequest(
      `http://localhost/api/launchpad/meta/drafts/${id}?businessId=${BUSINESS_ID}`,
      { method: "DELETE" },
    ),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("DELETE /api/launchpad/meta/drafts/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } },
      membership: { businessId: BUSINESS_ID },
    } as never);
  });

  it("returns access errors without deleting", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const { request: req, context } = request("draft_1");
    const response = await DELETE(req, context);

    expect(response.status).toBe(403);
    expect(store.deleteMetaLaunchDraft).not.toHaveBeenCalled();
  });

  it("rejects a blank draft id", async () => {
    const { request: req, context } = request("%20");
    const response = await DELETE(req, {
      params: Promise.resolve({ id: "  " }),
    });
    void context;
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("draft_id_required");
  });

  it("deletes within the membership business scope", async () => {
    vi.mocked(store.deleteMetaLaunchDraft).mockResolvedValue(true as never);

    const { request: req, context } = request("draft_1");
    const response = await DELETE(req, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(store.deleteMetaLaunchDraft).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      id: "draft_1",
    });
  });

  it("returns 404 when the draft is not found", async () => {
    vi.mocked(store.deleteMetaLaunchDraft).mockResolvedValue(false as never);

    const { request: req, context } = request("missing");
    const response = await DELETE(req, context);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("draft_not_found");
  });

  it("maps store failures to 500 draft_delete_failed", async () => {
    vi.mocked(store.deleteMetaLaunchDraft).mockRejectedValue(new Error("db down"));

    const { request: req, context } = request("draft_1");
    const response = await DELETE(req, context);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("draft_delete_failed");
  });
});
