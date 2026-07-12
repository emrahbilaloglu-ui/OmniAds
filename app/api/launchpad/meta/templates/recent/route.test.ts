import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-store", () => ({
  listRecentMetaLaunchTemplates: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn(() => 400),
  resolveAssignedMetaLaunchAccount: vi.fn(),
}));

const access = await import("@/lib/access");
const store = await import("@/lib/launchpad/meta-store");
const validation = await import("@/lib/launchpad/meta-validation");
const { GET } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const PROVIDER_ACCOUNT_ID = "act_123";

describe("GET /api/launchpad/meta/templates/recent", () => {
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
  });

  it("rejects a missing businessId before touching the store", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/launchpad/meta/templates/recent"),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("missing_business_id");
    expect(store.listRecentMetaLaunchTemplates).not.toHaveBeenCalled();
  });

  it("returns access errors verbatim", async () => {
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/templates/recent?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );

    expect(response.status).toBe(403);
    expect(store.listRecentMetaLaunchTemplates).not.toHaveBeenCalled();
  });

  it("lists recent templates for the membership business", async () => {
    vi.mocked(store.listRecentMetaLaunchTemplates).mockResolvedValue([
      { id: "tpl_recent" },
    ] as never);

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/templates/recent?businessId=${BUSINESS_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, templates: [{ id: "tpl_recent" }] });
    expect(store.listRecentMetaLaunchTemplates).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      providerAccountId: PROVIDER_ACCOUNT_ID,
    });
  });

  it("maps store failures to 500 recent_templates_failed", async () => {
    vi.mocked(store.listRecentMetaLaunchTemplates).mockRejectedValue(new Error("db down"));

    const response = await GET(
      new NextRequest(
        `http://localhost/api/launchpad/meta/templates/recent?businessId=${BUSINESS_ID}&providerAccountId=${PROVIDER_ACCOUNT_ID}`,
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("recent_templates_failed");
  });
});
