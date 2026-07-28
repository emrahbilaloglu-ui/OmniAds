import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sync cron used to do:
 *
 *   const businesses = await getActiveBusinesses().catch(() => []);
 *   if (businesses.length === 0) return json({ ok: true, synced: 0 });
 *
 * so "the database is unreachable" and "there are no businesses" produced a
 * byte-identical 200 / ok:true receipt. Worse, `getActiveBusinesses` swallows a
 * failed readiness probe to [] WITHOUT throwing, so that path did not even log.
 *
 * These tests pin the distinction at the source: a read that failed must be
 * reported as failed, and a genuine zero must stay a success.
 */

const getDbSchemaReadiness = vi.fn();
const sqlTag = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: () => sqlTag }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: (...args: unknown[]) => getDbSchemaReadiness(...args),
}));

beforeEach(() => {
  vi.resetModules();
  getDbSchemaReadiness.mockReset().mockResolvedValue({ ready: true, missingTables: [] });
  sqlTag.mockReset().mockResolvedValue([]);
});

describe("readActiveBusinesses", () => {
  it("reports a genuine empty list as a SUCCESSFUL read", async () => {
    const { readActiveBusinesses } = await import("./active-businesses");
    const result = await readActiveBusinesses();

    expect(result.ok).toBe(true);
    expect(result.ok && result.businesses).toEqual([]);
  });

  it("reports an unreadable schema as a FAILED read, not as zero businesses", async () => {
    getDbSchemaReadiness.mockResolvedValue({ ready: false, missingTables: ["businesses"] });
    const { readActiveBusinesses } = await import("./active-businesses");
    const result = await readActiveBusinesses();

    expect(result.ok, "a not-ready schema is not the same as having no businesses").toBe(false);
    expect(result.ok === false && result.reason).toBe("schema_not_ready");
  });

  it("reports a thrown readiness probe as a FAILED read", async () => {
    getDbSchemaReadiness.mockRejectedValue(new Error("connection refused"));
    const { readActiveBusinesses } = await import("./active-businesses");
    const result = await readActiveBusinesses();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("readiness_probe_failed");
    expect(result.ok === false && result.message).toContain("connection refused");
  });

  it("reports a thrown query as a FAILED read", async () => {
    sqlTag.mockRejectedValue(new Error("terminating connection due to administrator command"));
    const { readActiveBusinesses } = await import("./active-businesses");
    const result = await readActiveBusinesses();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("query_failed");
  });

  it("returns the rows it read when everything works", async () => {
    sqlTag.mockResolvedValue([{ id: "biz_1", name: "Biz 1" }]);
    const { readActiveBusinesses } = await import("./active-businesses");
    const result = await readActiveBusinesses();

    expect(result.ok && result.businesses).toEqual([{ id: "biz_1", name: "Biz 1" }]);
  });

  it("leaves the legacy getActiveBusinesses contract exactly as it was", async () => {
    // Eight other callers depend on this lossy behaviour; changing it here
    // would be a silent behaviour change for all of them.
    getDbSchemaReadiness.mockResolvedValue({ ready: false, missingTables: ["businesses"] });
    const { getActiveBusinesses } = await import("./active-businesses");
    await expect(getActiveBusinesses()).resolves.toEqual([]);

    getDbSchemaReadiness.mockResolvedValue({ ready: true, missingTables: [] });
    sqlTag.mockRejectedValue(new Error("boom"));
    await expect(getActiveBusinesses()).rejects.toThrow("boom");
  });
});
