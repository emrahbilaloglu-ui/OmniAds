import { beforeEach, describe, expect, it, vi } from "vitest";

const assertSyncGrowthBoundary = vi.fn();

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/db-growth-fence")>();
  return { ...actual, assertSyncGrowthBoundary };
});

/**
 * The first thing each ingest path touches after admission. If either is called
 * while the lane is off, admission happened too late — no connection is
 * resolved, no job state is written, and no provider request is made.
 */
vi.mock("@/lib/google-analytics-reporting", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveGa4AnalyticsContext: vi.fn() };
});

vi.mock("@/lib/search-console", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveSearchConsoleContext: vi.fn() };
});

const ga4Module = await import("@/lib/google-analytics-reporting");
const scModule = await import("@/lib/search-console");
const ga4Sync = await import("@/lib/sync/ga4-sync");
const scSync = await import("@/lib/sync/search-console-sync");

const LANE_ON = {
  ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
  ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED: "enabled",
};

function withEnv(patch: Record<string, string>, run: () => Promise<void>) {
  const saved = { ...process.env };
  Object.assign(process.env, patch);
  return run().finally(() => {
    process.env = saved;
  });
}

describe("source-ingest lane admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertSyncGrowthBoundary.mockResolvedValue({ allowed: true, reason: "ready" });
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    delete process.env.ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED;
  });

  it.each([
    ["nothing set", {}],
    ["master on, lane unset", { ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled" }],
    [
      "master on, lane off",
      {
        ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
        ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED: "off",
      },
    ],
  ])("stops GA4 with %s before any connection or database activity", (_label, env) =>
    withEnv(env, async () => {
      await expect(ga4Sync.syncGA4Reports("biz-1")).rejects.toThrow(/source_ingest/);
      expect(ga4Module.resolveGa4AnalyticsContext).not.toHaveBeenCalled();
      expect(assertSyncGrowthBoundary).not.toHaveBeenCalled();
    }),
  );

  it.each([
    ["nothing set", {}],
    ["master on, lane unset", { ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled" }],
  ])(
    "stops Search Console with %s before any connection or database activity",
    (_label, env) =>
      withEnv(env, async () => {
        await expect(
          scSync.syncSearchConsoleReports("biz-1"),
        ).rejects.toThrow(/source_ingest/);
        expect(scModule.resolveSearchConsoleContext).not.toHaveBeenCalled();
        expect(assertSyncGrowthBoundary).not.toHaveBeenCalled();
      }),
  );

  it("crosses the growth fence when the lane is enabled", () =>
    withEnv(LANE_ON, async () => {
      vi.mocked(ga4Module.resolveGa4AnalyticsContext).mockRejectedValue(
        new Error("no fixture context"),
      );
      vi.mocked(scModule.resolveSearchConsoleContext).mockRejectedValue(
        new Error("no fixture context"),
      );
      await ga4Sync.syncGA4Reports("biz-1").catch(() => undefined);
      await scSync.syncSearchConsoleReports("biz-1").catch(() => undefined);
      // Both got past admission and were measured against the budget. GA4 and
      // Search Console previously bypassed the fence entirely.
      expect(assertSyncGrowthBoundary).toHaveBeenCalledWith(
        "ga4_reports_sync",
        expect.objectContaining({ fresh: true }),
      );
      expect(assertSyncGrowthBoundary).toHaveBeenCalledWith(
        "search_console_reports_sync",
        expect.objectContaining({ fresh: true }),
      );
    }));
});
