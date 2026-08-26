import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/meta/reviewer-write-guard", () => ({
  rejectIfReviewerReadOnly: vi.fn(() => null),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

/*
 * The fail-closed demo authority's DB read, stubbed.
 *
 * The GUARD is the code under test — its statuses, its codes and its position
 * in the precedence — so only the read it delegates to is replaced. `getDb()`
 * throws with no DATABASE_URL under vitest, which is why the read has to be
 * mocked rather than the guard.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));

vi.mock("@/lib/meta/creative-brief-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/meta/creative-brief-store")
  >("@/lib/meta/creative-brief-store");
  return {
    ...actual,
    createMetaCreativeBrief: vi.fn(),
    listMetaCreativeBriefs: vi.fn(),
  };
});

const access = await import("@/lib/access");
const assignments = await import("@/lib/provider-account-assignments");
const reviewerGuard = await import("@/lib/meta/reviewer-write-guard");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const store = await import("@/lib/meta/creative-brief-store");
const demoAuthority = await import("@/app/api/launchpad/meta/demo-write-authority");
const route = await import("@/app/api/meta/creative-briefs/route");

const businessId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000010";
const snapshotId = "018f3f55-630d-7f9f-8c19-bbd7d45db001";

const brief = {
  contractVersion: "meta-creative-brief.v1" as const,
  id: "018f3f55-630d-7f9f-8c19-bbd7d45db002",
  businessId,
  providerAccountId: "act_1",
  sourceDecision: {
    decisionId: "mdd_1234567890abcdef12345678",
    snapshotId,
    creativeId: "creative_1",
    engineVersion: "v3-test",
    snapshotAsOf: "2026-07-10",
    scopeType: "account",
    scopeId: "*",
    publishedLabel: "refresh",
    rawLabel: "refresh",
    reason: "Fatigue composite",
    badges: [],
    trigger: "Fatigued former winner",
  },
  content: {
    keep: "Keep product proof",
    change: "Change hook",
    next: "Produce variants",
  },
  status: "draft" as const,
  version: 1,
  createdBy: userId,
  updatedBy: userId,
  reviewedBy: null,
  createdAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-10T10:00:00.000Z",
  reviewedAt: null,
};

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    businessId,
    providerAccountId: "act_1",
    idempotencyKey: "brief-create-1",
    sourceDecision: {
      snapshotId,
      trigger: "Fatigued former winner",
    },
    content: {
      keep: "Keep product proof",
      change: "Change hook",
      next: "Produce variants",
    },
    ...overrides,
  };
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/meta/creative-briefs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("/api/meta/creative-briefs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {
        user: { id: userId, email: "operator@example.com" },
      } as never,
      membership: {
        businessId,
        role: "collaborator",
      } as never,
    });
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      id: "assignment_1",
      business_id: businessId,
      provider: "meta",
      account_ids: ["act_1"],
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z",
    });
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(null);
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-07-11T00:00:00.000Z",
    });
    vi.mocked(store.listMetaCreativeBriefs).mockResolvedValue([brief]);
    vi.mocked(store.createMetaCreativeBrief).mockResolvedValue({
      brief,
      created: true,
    });
  });

  it("lists only the explicitly assigned account with guest read access", async () => {
    const request = new NextRequest(
      `http://localhost/api/meta/creative-briefs?businessId=${businessId}&providerAccountId=act_1&status=draft`,
    );
    const response = await route.GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId,
      minRole: "guest",
    });
    expect(store.listMetaCreativeBriefs).toHaveBeenCalledWith({
      businessId,
      providerAccountId: "act_1",
      status: "draft",
    });
  });

  it("creates with trusted membership attribution and explicit account scope", async () => {
    const request = postRequest(createBody());
    const response = await route.POST(request);
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.idempotentReplay).toBe(false);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request,
      businessId,
      minRole: "collaborator",
    });
    expect(store.createMetaCreativeBrief).toHaveBeenCalledWith({
      request: expect.objectContaining({
        businessId,
        providerAccountId: "act_1",
        idempotencyKey: "brief-create-1",
      }),
      createdBy: userId,
    });
    expect(reviewerGuard.rejectIfReviewerReadOnly).toHaveBeenCalledWith(
      expect.any(Object),
      "meta_creative_brief_create",
    );
  });

  it("reports the pending storage migration without hiding the analysis surface", async () => {
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["meta_creative_briefs"],
      checkedAt: "2026-07-11T00:00:00.000Z",
    });
    const request = new NextRequest(
      `http://localhost/api/meta/creative-briefs?businessId=${businessId}&providerAccountId=act_1`,
    );

    const response = await route.GET(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capability: {
        status: "migration_required",
        canRead: false,
        canWrite: false,
        missingTables: ["meta_creative_briefs"],
      },
      briefs: [],
    });
    expect(store.listMetaCreativeBriefs).not.toHaveBeenCalled();
  });

  it("returns 200 for a duplicate-safe idempotent replay", async () => {
    vi.mocked(store.createMetaCreativeBrief).mockResolvedValue({
      brief,
      created: false,
    });

    const response = await route.POST(postRequest(createBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idempotentReplay: true });
  });

  it("rejects unassigned provider accounts before persistence", async () => {
    const response = await route.POST(
      postRequest(createBody({ providerAccountId: "act_other" })),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "provider_account_not_assigned" },
    });
    expect(store.createMetaCreativeBrief).not.toHaveBeenCalled();
  });

  it("maps idempotency payload mismatches to a conflict", async () => {
    vi.mocked(store.createMetaCreativeBrief).mockRejectedValue(
      new store.MetaCreativeBriefIdempotencyConflictError(),
    );

    const response = await route.POST(postRequest(createBody()));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "idempotency_key_conflict" },
    });
  });

  it("rejects malformed snapshot references before access or persistence", async () => {
    const response = await route.POST(
      postRequest(
        createBody({
          sourceDecision: { snapshotId: "snapshot_1", trigger: "Fatigue" },
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(store.createMetaCreativeBrief).not.toHaveBeenCalled();
  });

  it("honors reviewer read-only access", async () => {
    vi.mocked(reviewerGuard.rejectIfReviewerReadOnly).mockReturnValue(
      NextResponse.json({ error: "reviewer_read_only" }, { status: 403 }),
    );

    const response = await route.POST(postRequest(createBody()));

    expect(response.status).toBe(403);
    expect(store.createMetaCreativeBrief).not.toHaveBeenCalled();
  });

  /*
   * LAW: a brief is a durable local artifact carrying a verified source
   * decision — the record that a decision authorized creative work. INVARIANTS
   * gives a demo workspace null authorized action, so minting one is the thing
   * it forbids; reaching no provider is not the test.
   */
  for (const [authority, status, code] of [
    ["demo", 403, "demo_business_read_only"],
    ["unverified", 503, "demo_status_unverified"],
    ["not_established", 503, "demo_status_unverified"],
  ] as const) {
    it(`refuses ${authority} with no brief written`, async () => {
      vi.mocked(demoAuthority.readLaunchpadWriteAuthority).mockResolvedValue(authority);

      const response = await route.POST(postRequest(createBody()));

      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
      expect(store.createMetaCreativeBrief).not.toHaveBeenCalled();
    });
  }

});
