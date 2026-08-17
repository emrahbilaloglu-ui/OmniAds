import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/google-ads-gaql", () => ({
  executeGaqlQuery: vi.fn(),
}));

vi.mock("@/lib/google-ads/merchant-center-warehouse", () => ({
  MERCHANT_CENTER_STATE_REFRESH_INTERVAL_MS: 6 * 60 * 60 * 1000,
  readMerchantCenterLastObservedAt: vi.fn(),
  upsertMerchantCenterItemStates: vi.fn(),
}));

const gaql = await import("@/lib/google-ads-gaql");
const warehouse = await import("@/lib/google-ads/merchant-center-warehouse");
const { refreshMerchantCenterItemState } = await import(
  "@/lib/google-ads/merchant-center-sync"
);

const LANE_ON = {
  ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
  ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED: "enabled",
};

function enableLane() {
  for (const [key, value] of Object.entries(LANE_ON)) {
    vi.stubEnv(key, value);
  }
}

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    shoppingProduct: {
      merchantCenterId: "512233",
      itemId: "AT-104",
      title: "Aurora Tote — Sand",
      status: "ELIGIBLE",
      issues: [],
      ...overrides,
    },
  };
}

describe("refreshMerchantCenterItemState", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(warehouse.readMerchantCenterLastObservedAt).mockResolvedValue(null);
    vi.mocked(warehouse.upsertMerchantCenterItemStates).mockResolvedValue({
      written: 0,
    } as never);
  });

  describe("the guard", () => {
    it("refuses to run when the global kill switch is off", async () => {
      vi.stubEnv("ADSECUTE_SYNC_GLOBAL_ENABLED", "");
      vi.stubEnv("ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED", "enabled");

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
      });

      expect(result.outcome).toBe("lane_disabled");
      expect(gaql.executeGaqlQuery).not.toHaveBeenCalled();
      expect(warehouse.upsertMerchantCenterItemStates).not.toHaveBeenCalled();
    });

    it("refuses to run when the google_sync lane alone is off", async () => {
      vi.stubEnv("ADSECUTE_SYNC_GLOBAL_ENABLED", "enabled");
      vi.stubEnv("ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED", "off");

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
      });

      expect(result.outcome).toBe("lane_disabled");
      expect(gaql.executeGaqlQuery).not.toHaveBeenCalled();
      expect(warehouse.upsertMerchantCenterItemStates).not.toHaveBeenCalled();
    });

    it("refuses to run when the lane switch is merely unset", async () => {
      vi.stubEnv("ADSECUTE_SYNC_GLOBAL_ENABLED", "enabled");

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
      });

      expect(result.outcome).toBe("lane_disabled");
      expect(gaql.executeGaqlQuery).not.toHaveBeenCalled();
    });
  });

  describe("the provider call", () => {
    it("is a single read-only GAQL SELECT against shopping_product", async () => {
      enableLane();
      vi.mocked(gaql.executeGaqlQuery).mockResolvedValue({
        results: [providerRow()],
      } as never);

      await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
      });

      expect(gaql.executeGaqlQuery).toHaveBeenCalledTimes(1);
      const call = vi.mocked(gaql.executeGaqlQuery).mock.calls[0]![0]!;
      expect(call.query.startsWith("SELECT ")).toBe(true);
      expect(call.query).toContain("FROM shopping_product");
      // No mutate verb can reach the provider from this module.
      expect(call.query).not.toMatch(/\b(INSERT|UPDATE|DELETE|MUTATE)\b/i);
      // Item state is current state; a date segment would multiply it by window.
      expect(call.query).not.toContain("segments.date");
    });

    it("skips the provider entirely while the stored read is still fresh", async () => {
      enableLane();
      const now = new Date("2026-08-17T12:00:00.000Z");
      vi.mocked(warehouse.readMerchantCenterLastObservedAt).mockResolvedValue(
        new Date("2026-08-17T09:00:00.000Z") as never,
      );

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
        now,
      });

      expect(result.outcome).toBe("skipped_fresh");
      expect(gaql.executeGaqlQuery).not.toHaveBeenCalled();
    });

    it("reads again once the stored read has aged past the interval", async () => {
      enableLane();
      vi.mocked(warehouse.readMerchantCenterLastObservedAt).mockResolvedValue(
        new Date("2026-08-16T12:00:00.000Z") as never,
      );
      vi.mocked(gaql.executeGaqlQuery).mockResolvedValue({
        results: [providerRow()],
      } as never);

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
        now: new Date("2026-08-17T12:00:00.000Z"),
      });

      expect(result.outcome).toBe("refreshed");
      expect(gaql.executeGaqlQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe("what a failure is allowed to mean", () => {
    it("writes nothing when the provider rejects the query", async () => {
      enableLane();
      vi.mocked(gaql.executeGaqlQuery).mockRejectedValue(
        new Error("Unrecognized field in the query: shopping_product.issues"),
      );

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
      });

      expect(result.outcome).toBe("unavailable");
      expect(result.itemCount).toBe(0);
      expect(result.reason).toContain("Unrecognized field");
      expect(warehouse.upsertMerchantCenterItemStates).not.toHaveBeenCalled();
    });

    it("writes nothing when the account returns no Merchant Center products", async () => {
      enableLane();
      vi.mocked(gaql.executeGaqlQuery).mockResolvedValue({ results: [] } as never);

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
      });

      expect(result.outcome).toBe("unavailable");
      expect(result.reason).toContain("no Merchant Center products");
      expect(warehouse.upsertMerchantCenterItemStates).not.toHaveBeenCalled();
    });
  });

  describe("what it persists", () => {
    it("stores the derived state and the linkage the provider returned", async () => {
      enableLane();
      vi.mocked(gaql.executeGaqlQuery).mockResolvedValue({
        results: [
          providerRow(),
          providerRow({
            itemId: "CW-310",
            status: "ELIGIBLE_LIMITED",
            issues: [
              {
                errorCode: "missing_gtin",
                adsSeverity: "DEMOTED",
                attributeName: "gtin",
                description: "Missing GTIN",
              },
            ],
          }),
        ],
      } as never);

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
      });

      expect(result.outcome).toBe("refreshed");
      expect(result.itemCount).toBe(2);
      expect(result.merchantCenterIds).toEqual(["512233"]);
      const written = vi.mocked(warehouse.upsertMerchantCenterItemStates).mock
        .calls[0]![0]!;
      expect(written.items.map((entry) => [entry.itemId, entry.state])).toEqual([
        ["AT-104", "serving"],
        ["CW-310", "limited"],
      ]);
    });

    it("keeps one row per item id when the feed repeats an item", async () => {
      enableLane();
      vi.mocked(gaql.executeGaqlQuery).mockResolvedValue({
        results: [providerRow(), providerRow({ title: "Aurora Tote — Sand (EN)" })],
      } as never);

      const result = await refreshMerchantCenterItemState({
        businessId: "biz_1",
        providerAccountId: "4931182201",
      });

      expect(result.itemCount).toBe(1);
    });
  });
});
