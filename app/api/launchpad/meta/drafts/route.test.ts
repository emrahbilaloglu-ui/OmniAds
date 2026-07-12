import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-store", () => ({
  listMetaLaunchDrafts: vi.fn(),
  upsertMetaLaunchDraft: vi.fn(),
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

function postRequest(body: unknown, url = "http://localhost/api/launchpad/meta/drafts") {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/launchpad/meta/drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantAccess();
  });

  it("rejects a missing businessId before touching the store", async () => {
    const response = await GET(new NextRequest("http://localhost/api/launchpad/meta/drafts"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("missing_business_id");
    expect(store.listMetaLaunchDrafts).not.toHaveBeenCalled();
  });

  it("returns access errors verbatim", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/drafts?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );

    expect(response.status).toBe(403);
    expect(store.listMetaLaunchDrafts).not.toHaveBeenCalled();
  });

  it("lists drafts for the membership business", async () => {
    vi.mocked(store.listMetaLaunchDrafts).mockResolvedValue([
      { id: "draft_1", name: "Draft 1" },
    ] as never);

    const response = await GET(
      new NextRequest(`http://localhost/api/launchpad/meta/drafts?businessId=${BUSINESS_ID}`),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      drafts: [{ id: "draft_1", name: "Draft 1" }],
      capability: { status: "ready", canRead: true, canWrite: true },
    });
    expect(store.listMetaLaunchDrafts).toHaveBeenCalledWith({
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
        `http://localhost/api/launchpad/meta/drafts?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      drafts: [],
      capability: {
        status: "migration_required",
        canRead: false,
        canWrite: false,
        missingColumns: ["provider_account_id"],
      },
    });
    expect(store.listMetaLaunchDrafts).not.toHaveBeenCalled();
  });

  it("maps store failures to 500 drafts_failed with a sanitized message", async () => {
    vi.mocked(store.listMetaLaunchDrafts).mockRejectedValue(
      new Error("boom access_token=secret123"),
    );

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/drafts?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("drafts_failed");
    expect(body.error.message).toContain("access_token=[redacted]");
    expect(body.error.message).not.toContain("secret123");
  });
});

describe("POST /api/launchpad/meta/drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantAccess();
  });

  it("requires a non-empty draft name", async () => {
    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: "   ",
        payload: {},
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("draft_name_required");
    expect(store.upsertMetaLaunchDraft).not.toHaveBeenCalled();
  });

  it("requires the payload key to be present", async () => {
    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: "Draft",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("draft_payload_required");
    expect(store.upsertMetaLaunchDraft).not.toHaveBeenCalled();
  });

  it("upserts with the membership businessId and session user, not raw body values", async () => {
    vi.mocked(store.upsertMetaLaunchDraft).mockResolvedValue({ id: "draft_1" } as never);

    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        id: "draft_1",
        name: " Draft ",
        payload: { step: 1 },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, draft: { id: "draft_1" } });
    expect(store.upsertMetaLaunchDraft).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
      id: "draft_1",
      name: "Draft",
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
        name: "Draft",
        payload: {},
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("launch_draft_migration_required");
    expect(store.upsertMetaLaunchDraft).not.toHaveBeenCalled();
  });

  it("falls back to the query businessId when the body omits it", async () => {
    vi.mocked(store.upsertMetaLaunchDraft).mockResolvedValue({ id: "draft_2" } as never);

    const response = await POST(
      postRequest(
        { name: "Draft", payload: null, providerAccountId: PROVIDER_ACCOUNT_ID },
        `http://localhost/api/launchpad/meta/drafts?businessId=${BUSINESS_ID}`,
      ),
    );

    expect(response.status).toBe(200);
    // Contract: an explicit null payload is a valid (empty) draft.
    expect(store.upsertMetaLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        payload: null,
        id: null,
      }),
    );
  });

  it("maps store failures to 500 draft_save_failed", async () => {
    vi.mocked(store.upsertMetaLaunchDraft).mockRejectedValue(new Error("db down"));

    const response = await POST(
      postRequest({
        businessId: BUSINESS_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        name: "Draft",
        payload: {},
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("draft_save_failed");
  });
});
