import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/account-store", () => ({
  updateBusinessSettings: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  // The whole delete is one transaction now: a failure partway through used to
  // leave memberships gone — so nobody could reach the business to retry —
  // while the business, its connections and its bindings survived.
  runDbTransaction: vi.fn(async (run: () => Promise<unknown>) => run()),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/demo-business", () => ({
  isDemoBusinessId: vi.fn(),
}));

vi.mock("@/lib/request-language", () => ({
  resolveRequestLanguage: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

const access = await import("@/lib/access");
const db = await import("@/lib/db");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const demoBusiness = await import("@/lib/demo-business");
const requestLanguage = await import("@/lib/request-language");
const migrations = await import("@/lib/migrations");
const { DELETE } = await import("@/app/api/businesses/[businessId]/route");

describe("DELETE /api/businesses/[businessId]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requestLanguage.resolveRequestLanguage).mockResolvedValue("en");
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(demoBusiness.isDemoBusinessId).mockReturnValue(false);
    // Business deletion is the widest selection mutation there is, so it runs
    // under the assignment lane like every other one.
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED = "enabled";
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    vi.mocked(db.getDb).mockReturnValue(vi.fn().mockResolvedValue([]) as never);
  });

  it("refuses while the assignment lane is disabled, before any delete", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
    const sql = vi.fn().mockResolvedValue([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const request = new NextRequest("http://localhost/api/businesses/biz", {
      method: "DELETE",
    });
    const response = await DELETE(request, {
      params: Promise.resolve({ businessId: "biz" }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error?: string }).error).toBe("lane_disabled");
    expect(sql).not.toHaveBeenCalled();
  });

  it("fails fast when delete tables are not ready", async () => {
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["memberships"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });

    const request = new NextRequest("http://localhost/api/businesses/biz", {
      method: "DELETE",
    });
    const response = await DELETE(request, {
      params: Promise.resolve({ businessId: "biz" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: "schema_not_ready",
      message: "Database schema is not ready for business deletion. Run `npm run db:migrate`.",
      missingTables: ["memberships"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    expect(db.getDb).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("preserves the delete success contract without migrations", async () => {
    const sql = vi.fn().mockResolvedValue([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const request = new NextRequest("http://localhost/api/businesses/biz", {
      method: "DELETE",
    });
    const response = await DELETE(request, {
      params: Promise.resolve({ businessId: "biz" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ status: "ok" });
    // Nine deletes plus the advisory lock that serialises this against ordinary
    // selection mutation.
    expect(sql).toHaveBeenCalledTimes(10);
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });
});
