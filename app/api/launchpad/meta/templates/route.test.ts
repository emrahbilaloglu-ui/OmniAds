import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-store", () => ({
  createManualMetaLaunchTemplate: vi.fn(),
  listManualMetaLaunchTemplates: vi.fn(),
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
const { GET, POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROVIDER_ACCOUNT_ID = "act_123";

function grantAccess() {
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
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/launchpad/meta/templates", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/launchpad/meta/templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantAccess();
  });

  it("rejects a missing businessId before touching the store", async () => {
    const response = await GET(new NextRequest("http://localhost/api/launchpad/meta/templates"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("missing_business_id");
    expect(store.listManualMetaLaunchTemplates).not.toHaveBeenCalled();
  });

  it("lists templates for the membership business", async () => {
    vi.mocked(store.listManualMetaLaunchTemplates).mockResolvedValue([
      { id: "tpl_1", name: "Template 1" },
    ] as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/templates?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      templates: [{ id: "tpl_1", name: "Template 1" }],
      capability: { status: "ready", canRead: true, canWrite: true },
    });
    expect(store.listManualMetaLaunchTemplates).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
  });

  it("returns an honest empty capability response when account-scoped storage is unavailable", async () => {
    vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockResolvedValue({
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingColumns: ["provider_account_id"],
    });

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/templates?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      templates: [],
      capability: {
        status: "migration_required",
        canRead: false,
        canWrite: false,
        missingColumns: ["provider_account_id"],
      },
    });
    expect(store.listManualMetaLaunchTemplates).not.toHaveBeenCalled();
  });

  it("maps store failures to 500 templates_failed", async () => {
    vi.mocked(store.listManualMetaLaunchTemplates).mockRejectedValue(new Error("db down"));

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/templates?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("templates_failed");
  });
});

describe("POST /api/launchpad/meta/templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantAccess();
  });

  it("returns access errors without creating", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: "Template",
        payload: {},
      }),
    );

    expect(response.status).toBe(403);
    expect(store.createManualMetaLaunchTemplate).not.toHaveBeenCalled();
  });

  it("requires a non-empty template name", async () => {
    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: "",
        payload: {},
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("template_name_required");
  });

  it("requires the payload key to be present", async () => {
    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: "Template",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("template_payload_required");
  });

  it("creates with the membership businessId, trimmed name, and null description default", async () => {
    vi.mocked(store.createManualMetaLaunchTemplate).mockResolvedValue({ id: "tpl_1" } as never);

    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: " Template ",
        payload: { step: 1 },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, template: { id: "tpl_1" } });
    expect(store.createManualMetaLaunchTemplate).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      name: "Template",
      description: null,
      payload: { step: 1 },
      createdBy: "user_1",
    });
  });

  it("blocks writes before the store when the account-scope migration is missing", async () => {
    vi.mocked(storeCapability.getMetaLaunchStoreCapability).mockResolvedValue({
      status: "migration_required",
      canRead: false,
      canWrite: false,
      missingColumns: ["provider_account_id"],
    });

    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: "Template",
        payload: {},
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("launch_template_migration_required");
    expect(store.createManualMetaLaunchTemplate).not.toHaveBeenCalled();
  });

  it("maps store failures to 500 template_create_failed", async () => {
    vi.mocked(store.createManualMetaLaunchTemplate).mockRejectedValue(new Error("db down"));

    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: "Template",
        payload: {},
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("template_create_failed");
  });
});
