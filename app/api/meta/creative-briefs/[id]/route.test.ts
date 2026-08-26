import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
    readMetaCreativeBrief: vi.fn(),
    patchMetaCreativeBrief: vi.fn(),
  };
});

const access = await import("@/lib/access");
const assignments = await import("@/lib/provider-account-assignments");
const reviewerGuard = await import("@/lib/meta/reviewer-write-guard");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const store = await import("@/lib/meta/creative-brief-store");
const route = await import("@/app/api/meta/creative-briefs/[id]/route");

const businessId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000010";
const briefId = "018f3f55-630d-7f9f-8c19-bbd7d45db002";

const brief = {
  contractVersion: "meta-creative-brief.v1" as const,
  id: briefId,
  businessId,
  providerAccountId: "act_1",
  sourceDecision: {
    decisionId: "mdd_1234567890abcdef12345678",
    snapshotId: "018f3f55-630d-7f9f-8c19-bbd7d45db001",
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
  content: { keep: "Keep proof", change: "Change hook", next: "Make variants" },
  status: "draft" as const,
  version: 2,
  createdBy: userId,
  updatedBy: userId,
  reviewedBy: null,
  createdAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-10T10:05:00.000Z",
  reviewedAt: null,
};

function context(id = briefId) {
  return { params: Promise.resolve({ id }) };
}

function request(method = "GET", body?: unknown) {
  return new NextRequest(
    `http://localhost/api/meta/creative-briefs/${briefId}?businessId=${businessId}&providerAccountId=act_1`,
    {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

describe("/api/meta/creative-briefs/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {
        user: { id: userId, email: "operator@example.com" },
      } as never,
      membership: { businessId, role: "collaborator" } as never,
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
    vi.mocked(store.readMetaCreativeBrief).mockResolvedValue(brief);
    vi.mocked(store.patchMetaCreativeBrief).mockResolvedValue(brief);
  });

  it("reads a brief only inside its business and account scope", async () => {
    const apiRequest = request();
    const response = await route.GET(apiRequest, context());

    expect(response.status).toBe(200);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request: apiRequest,
      businessId,
      minRole: "guest",
    });
    expect(store.readMetaCreativeBrief).toHaveBeenCalledWith({
      businessId,
      providerAccountId: "act_1",
      id: briefId,
    });
  });

  it("updates editable content with an expected version and trusted actor", async () => {
    const apiRequest = request("PATCH", {
      expectedVersion: 1,
      content: { change: "Use a clearer hook" },
    });
    const response = await route.PATCH(apiRequest, context());

    expect(response.status).toBe(200);
    expect(access.requireBusinessAccess).toHaveBeenCalledWith({
      request: apiRequest,
      businessId,
      minRole: "collaborator",
    });
    expect(store.patchMetaCreativeBrief).toHaveBeenCalledWith({
      businessId,
      providerAccountId: "act_1",
      id: briefId,
      patch: {
        expectedVersion: 1,
        content: { change: "Use a clearer hook" },
        status: undefined,
      },
      updatedBy: userId,
    });
  });

  it("returns the current version on an optimistic concurrency conflict", async () => {
    vi.mocked(store.patchMetaCreativeBrief).mockRejectedValue(
      new store.MetaCreativeBriefVersionConflictError(1, 3),
    );

    const response = await route.PATCH(
      request("PATCH", { expectedVersion: 1, status: "reviewed" }),
      context(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "version_conflict",
        expectedVersion: 1,
        currentVersion: 3,
      },
    });
  });

  it("withholds writes when Creative Brief storage still needs migration", async () => {
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["meta_creative_briefs"],
      checkedAt: "2026-07-11T00:00:00.000Z",
    });

    const response = await route.PATCH(
      request("PATCH", { expectedVersion: 1, content: { keep: "Keep proof" } }),
      context(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: "creative_brief_migration_required",
        capability: { status: "migration_required", canWrite: false },
      },
    });
    expect(store.patchMetaCreativeBrief).not.toHaveBeenCalled();
  });

  it("rejects source-linkage mutation before access or persistence", async () => {
    const response = await route.PATCH(
      request("PATCH", {
        expectedVersion: 1,
        sourceDecision: { snapshotId: brief.sourceDecision.snapshotId },
        content: { keep: "Different" },
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "source_decision_immutable" },
    });
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(store.patchMetaCreativeBrief).not.toHaveBeenCalled();
  });

  it("rejects invalid route ids without querying the store", async () => {
    const response = await route.GET(request(), context("brief_1"));

    expect(response.status).toBe(400);
    expect(store.readMetaCreativeBrief).not.toHaveBeenCalled();
  });

  it("does not expose delete or provider-write handlers", () => {
    expect("DELETE" in route).toBe(false);
    expect("POST" in route).toBe(false);
  });
});
