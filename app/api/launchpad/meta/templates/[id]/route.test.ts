import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-store", () => ({
  deleteManualMetaLaunchTemplate: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn(() => 400),
  resolveAssignedMetaLaunchAccount: vi.fn(),
}));
vi.mock("@/lib/launchpad/meta-store-capability", () => ({
  getMetaLaunchStoreCapability: vi.fn(),
}));

const access = await import("@/lib/access");
const store = await import("@/lib/launchpad/meta-store");
const validation = await import("@/lib/launchpad/meta-validation");
const storeCapability = await import("@/lib/launchpad/meta-store-capability");
const { DELETE } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROVIDER_ACCOUNT_ID = "act_123";

function request(id: string) {
  return {
    request: new NextRequest(
      `http://localhost/api/launchpad/meta/templates/${id}?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      { method: "DELETE" },
    ),
    context: { params: Promise.resolve({ id }) },
  };
}

describe("DELETE /api/launchpad/meta/templates/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: "user_1" } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: true,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
    vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockResolvedValue({
      status: "ready",
      canRead: true,
      canWrite: true,
      missingColumns: [],
    });
  });

  it("returns access errors without deleting", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const { request: req, context } = request("tpl_1");
    const response = await DELETE(req, context);

    expect(response.status).toBe(403);
    expect(store.deleteManualMetaLaunchTemplate).not.toHaveBeenCalled();
  });

  it("rejects a blank template id", async () => {
    const { request: req } = request("tpl_1");
    const response = await DELETE(req, { params: Promise.resolve({ id: "  " }) });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("template_id_required");
  });

  it("deletes within the membership business scope", async () => {
    vi.mocked(store.deleteManualMetaLaunchTemplate).mockResolvedValue(true as never);

    const { request: req, context } = request("tpl_1");
    const response = await DELETE(req, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(store.deleteManualMetaLaunchTemplate).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      id: "tpl_1",
    });
  });

  it("blocks delete before the store when the account-scope migration is missing", async () => {
    vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockResolvedValue({
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingColumns: ["provider_account_id"],
    });

    const { request: req, context } = request("tpl_1");
    const response = await DELETE(req, context);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("launch_template_migration_required");
    expect(store.deleteManualMetaLaunchTemplate).not.toHaveBeenCalled();
  });

  it("returns 404 when the template is not found", async () => {
    vi.mocked(store.deleteManualMetaLaunchTemplate).mockResolvedValue(false as never);

    const { request: req, context } = request("missing");
    const response = await DELETE(req, context);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("template_not_found");
  });

  it("maps store failures to 500 template_delete_failed", async () => {
    vi.mocked(store.deleteManualMetaLaunchTemplate).mockRejectedValue(new Error("db down"));

    const { request: req, context } = request("tpl_1");
    const response = await DELETE(req, context);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("template_delete_failed");
  });
});
