import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("@/lib/business-deletion", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/business-deletion")>(),
  deleteBusinessWithData: vi.fn(),
}));

vi.mock("@/lib/business-deletion-jobs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/business-deletion-jobs")>(),
  enqueueBusinessDeletion: vi.fn(),
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
const accountStore = await import("@/lib/account-store");
const deletion = await import("@/lib/business-deletion");
const jobs = await import("@/lib/business-deletion-jobs");
const { DELETE, PATCH } = await import("@/app/api/businesses/[businessId]/route");

/**
 * The workspace rename and currency change.
 *
 * Dashboard v2 draws no field for either, so `/select-business` is the only
 * surface that calls this — which makes the route's own refusals the last line
 * rather than a redundancy behind a form.
 */
describe("PATCH /api/businesses/[businessId]", () => {
  function patchRequest(body: unknown) {
    return new NextRequest("http://localhost/api/businesses/biz", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(requestLanguage.resolveRequestLanguage).mockResolvedValue("en");
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(demoBusiness.isDemoBusinessId).mockReturnValue(false);
    vi.mocked(accountStore.updateBusinessSettings).mockResolvedValue({
      id: "biz",
      name: "Grandmix",
      timezone: null,
      timezoneSource: null,
      currency: "EUR",
    } as never);
  });

  it("still requires admin on the business being renamed", async () => {
    await PATCH(patchRequest({ name: "Grandmix", currency: "EUR" }), {
      params: Promise.resolve({ businessId: "biz" }),
    });
    expect(vi.mocked(access.requireBusinessAccess).mock.calls[0]![0]).toMatchObject({
      businessId: "biz",
      minRole: "admin",
    });
  });

  it("writes the new name and currency through the account store", async () => {
    const response = await PATCH(patchRequest({ name: "Grandmix", currency: "eur" }), {
      params: Promise.resolve({ businessId: "biz" }),
    });

    expect(response.status).toBe(200);
    expect(accountStore.updateBusinessSettings).toHaveBeenCalledWith({
      businessId: "biz",
      name: "Grandmix",
      currency: "EUR",
    });
  });

  it("refuses a currency that is not an ISO 4217 code, before any write", async () => {
    for (const currency of ["US", "EURO", "12", "€"]) {
      const response = await PATCH(patchRequest({ name: "Grandmix", currency }), {
        params: Promise.resolve({ businessId: "biz" }),
      });
      expect(response.status, currency).toBe(400);
      expect(((await response.json()) as { error?: string }).error).toBe("invalid_currency");
    }
    expect(accountStore.updateBusinessSettings).not.toHaveBeenCalled();
  });

  it("refuses the demo business outright", async () => {
    vi.mocked(demoBusiness.isDemoBusinessId).mockReturnValue(true);
    const response = await PATCH(patchRequest({ name: "Grandmix", currency: "EUR" }), {
      params: Promise.resolve({ businessId: "demo" }),
    });
    expect(response.status).toBe(403);
    expect(accountStore.updateBusinessSettings).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/businesses/[businessId]", () => {
  afterEach(()=>vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY","fixture-server-master-key");
    vi.resetAllMocks();
    vi.mocked(requestLanguage.resolveRequestLanguage).mockResolvedValue("en");
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { sessionId: "test-session" } as never,
      membership: {} as never,
    });
    vi.mocked(jobs.enqueueBusinessDeletion).mockResolvedValue({ status: "queued" } as never);
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

  it("does not enqueue unmonitorable work when the server signing master is missing",async()=>{
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY","");
    const response=await DELETE(new NextRequest("http://localhost/api/businesses/biz",{method:"DELETE",headers:{Cookie:"omniads_session=test-session-cookie"}}),{params:Promise.resolve({businessId:"biz"})});
    expect(response.status).toBe(503);expect(jobs.enqueueBusinessDeletion).not.toHaveBeenCalled();
  });

  it("refuses while the assignment lane is disabled, before any delete", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED;
    const sql = vi.fn().mockResolvedValue([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const request = new NextRequest("http://localhost/api/businesses/biz", {
      method: "DELETE", headers: { Cookie: "omniads_session=test-session-cookie" },
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
      method: "DELETE", headers: { Cookie: "omniads_session=test-session-cookie" },
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

  it("acknowledges a durable job without claiming completed deletion or executing erasure in HTTP", async () => {
    const sql = vi.fn().mockResolvedValue([]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const request = new NextRequest("http://localhost/api/businesses/biz", {
      method: "DELETE", headers: { Cookie: "omniads_session=test-session-cookie" },
    });
    const response = await DELETE(request, {
      params: Promise.resolve({ businessId: "biz" }),
    });
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({ status: "queued", monitorTicket: expect.any(String) });
    expect(jobs.enqueueBusinessDeletion).toHaveBeenCalledWith("biz");
    expect(deletion.deleteBusinessWithData).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("returns a useful conflict for protected history and preserves the schema", async () => {
    vi.mocked(jobs.enqueueBusinessDeletion).mockRejectedValue(new deletion.BusinessDeletionError("protected_history"));
    const response = await DELETE(new NextRequest("http://localhost/api/businesses/biz", { method: "DELETE", headers: { Cookie: "omniads_session=test-session-cookie" } }), {
      params: Promise.resolve({ businessId: "biz" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "protected_history", message: expect.stringContaining("database records were preserved") });
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });
  it.each([
    ["sync_worker_heartbeats","running worker seen within the last 5 minutes"],
    ["sync_runtime_instances","current runtime configuration"],
  ])("explains the specific live control reference in %s",async(table,message)=>{
    vi.mocked(jobs.enqueueBusinessDeletion).mockRejectedValue(new deletion.BusinessDeletionError("control_reference_in_use",[table]));
    const response=await DELETE(new NextRequest("http://localhost/api/businesses/biz",{method:"DELETE",headers:{Cookie:"omniads_session=test-session-cookie"}}),{params:Promise.resolve({businessId:"biz"})});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error:"control_reference_in_use",message:expect.stringContaining(message)});
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });
});
