import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `pruneMetaCreativeMediaOutsideRetention` runs as the FIRST statement of every
 * creative sync. It issued an unbounded DELETE against meta_creative_media with
 * no lane gate at all, so with the retention lane deliberately OFF in production
 * — which is how production is configured — ordinary syncing still deleted rows
 * on every tick, and the call site's `.catch(() => null)` meant nothing said so.
 *
 * The lane's own contract calls retention "The only path that deletes."
 * These tests hold that to be true by executing the function and asserting on
 * whether a DELETE was issued, not by reading the source.
 */

const execCount = vi.fn();
const sqlTag = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => sqlTag,
  getDbRuntimeDiagnostics: () => ({}),
}));
vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({ ready: true }),
}));

describe("meta creative media prune admission", () => {
  beforeEach(() => {
    vi.resetModules();
    execCount.mockReset();
    sqlTag.mockReset();
    // Any statement the function issues resolves to "0 rows".
    sqlTag.mockResolvedValue([{ count: 0 }]);
    delete process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
  });

  it("issues NO statements when the retention lane is off — production's configuration", async () => {
    const { pruneMetaCreativeMediaOutsideRetention } = await import("./cleanup");

    const summary = await pruneMetaCreativeMediaOutsideRetention({
      businessId: "biz-1",
      keepFromDate: "2026-01-01",
    });

    expect(
      sqlTag,
      "the prune reached the database while the retention lane was disabled",
    ).not.toHaveBeenCalled();
    expect(summary.metaCreativeMediaDeleted).toBe(0);
    expect(summary.metaAdDailyUpdated).toBe(0);
    expect(summary.metaCreativeDailyUpdated).toBe(0);
    expect(summary.skippedReason).toBeTruthy();
  });

  it("also refuses when the GLOBAL switch is off, even if the lane is set", async () => {
    process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = "enabled";
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    const { pruneMetaCreativeMediaOutsideRetention } = await import("./cleanup");

    await pruneMetaCreativeMediaOutsideRetention({
      businessId: "biz-1",
      keepFromDate: "2026-01-01",
    });

    expect(sqlTag).not.toHaveBeenCalled();
  });

  it("proceeds only when the lane genuinely admits it", async () => {
    process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    const { pruneMetaCreativeMediaOutsideRetention } = await import("./cleanup");

    await pruneMetaCreativeMediaOutsideRetention({
      businessId: "biz-1",
      keepFromDate: "2026-01-01",
    });

    expect(
      sqlTag,
      "with retention explicitly enabled the prune must still work",
    ).toHaveBeenCalled();
  });
});
