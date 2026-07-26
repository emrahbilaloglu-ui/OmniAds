import { beforeEach, describe, expect, it, vi } from "vitest";

const assertSyncGrowthBoundary = vi.fn();

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/db-growth-fence")>();
  return { ...actual, assertSyncGrowthBoundary };
});

/**
 * Everything Shopify sync would touch AFTER admission. If any of these is
 * called while the lane is off, admission happened too late — the point of the
 * gate is that no credential is resolved, no row is read or written, and no
 * provider request is made.
 */
vi.mock("@/lib/shopify/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shopify/admin")>();
  return {
    ...actual,
    resolveShopifyAdminCredentials: vi.fn(async () => ({
      shopDomain: "seam.myshopify.com",
      accessToken: "token",
      scopes: [] as string[],
    })),
  };
});

const credentials = await import("@/lib/shopify/admin");
const shopify = await import("@/lib/sync/shopify-sync");

const LANE_ON = {
  ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
  ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED: "enabled",
};

function withEnv(patch: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved = { ...process.env };
  Object.assign(process.env, patch);
  return run().finally(() => {
    process.env = saved;
  });
}

describe("Shopify lane admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertSyncGrowthBoundary.mockResolvedValue({
      allowed: true,
      reason: "ready",
      warning: false,
    });
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    delete process.env.ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED;
  });

  it.each([
    ["nothing set", {}],
    ["master on, lane unset", { ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled" }],
    [
      "master on, lane explicitly off",
      {
        ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
        ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED: "off",
      },
    ],
    [
      "lane on, master off",
      { ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED: "enabled" },
    ],
  ])("refuses syncShopifyCommerceReports with %s and touches nothing", async (_label, env) =>
    withEnv(env, async () => {
      await expect(shopify.syncShopifyCommerceReports("biz-1")).rejects.toThrow(
        /shopify_sync/,
      );
      // Nothing downstream ran: no credentials, and the capacity fence was not
      // even consulted because the lane refused first.
      expect(credentials.resolveShopifyAdminCredentials).not.toHaveBeenCalled();
      expect(assertSyncGrowthBoundary).not.toHaveBeenCalled();
    }),
  );

  it("refuses ensureShopifyProviderReady with the lane off and touches nothing", async () =>
    withEnv({}, async () => {
      await expect(
        shopify.ensureShopifyProviderReady({ businessId: "biz-1" }),
      ).rejects.toThrow(/shopify_sync/);
      expect(credentials.resolveShopifyAdminCredentials).not.toHaveBeenCalled();
      expect(assertSyncGrowthBoundary).not.toHaveBeenCalled();
    }));

  it("admits an enabled lane and then consults the capacity fence", async () =>
    withEnv(LANE_ON, async () => {
      // The sync will fail later for unrelated fixture reasons; what matters is
      // that it got PAST admission and reached the growth boundary.
      await shopify.syncShopifyCommerceReports("biz-1").catch(() => undefined);
      expect(assertSyncGrowthBoundary).toHaveBeenCalledWith(
        "shopify_commerce_sync",
        expect.objectContaining({ fresh: true }),
      );
    }));

  it("refuses on capacity even when the lane is enabled", async () =>
    withEnv(LANE_ON, async () => {
      const { DbGrowthFenceRefusal } = await import("@/lib/sync/db-growth-fence");
      assertSyncGrowthBoundary.mockRejectedValue(
        new DbGrowthFenceRefusal(
          {
            allowed: false,
            reason: "table_budget_exceeded",
            warning: false,
            databaseBytes: 2,
            databaseBudgetBytes: 1,
            tableBytes: {},
            offender: { table: "shopify_raw_snapshots", bytes: 2, budget: 1 },
            evaluatedAt: "2026-07-26T00:00:00.000Z",
            errorMessage: null,
            overridden: false,
          },
          "shopify_commerce_sync",
        ),
      );
      await expect(shopify.syncShopifyCommerceReports("biz-1")).rejects.toThrow(
        /shopify_raw_snapshots/,
      );
      // shopify_raw_snapshots is 13.9 GB — the second-largest append surface —
      // and this path previously bypassed every budget.
      expect(credentials.resolveShopifyAdminCredentials).not.toHaveBeenCalled();
    }));
});
