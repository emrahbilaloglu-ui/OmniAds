import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Both Shopify webhook routes persist before they reach the core sync — the
 * delivery record in one, the customer events in the other. A lane guard buried
 * inside syncShopifyCommerceReports is therefore too late: a disabled lane
 * would still have mutated state.
 *
 * The required behaviour is authenticate and validate FIRST, then refuse with a
 * retryable non-success before any persistence. 200/202 would acknowledge a
 * webhook that was never processed, and Shopify would never redeliver it.
 */

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => {
    throw new Error("database must not be touched while the lane is disabled");
  }),
  getDbWithTimeout: vi.fn(() => {
    throw new Error("database must not be touched while the lane is disabled");
  }),
}));

const assertSyncGrowthBoundary = vi.fn();

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/db-growth-fence")>();
  return { ...actual, assertSyncGrowthBoundary };
});

const upsertShopifyWebhookDelivery = vi.fn();
const upsertShopifyRepairIntent = vi.fn();
const upsertShopifyCustomerEvents = vi.fn();
const syncShopifyCommerceReports = vi.fn();

vi.mock("@/lib/shopify/webhook-store", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, upsertShopifyWebhookDelivery, upsertShopifyRepairIntent };
});

vi.mock("@/lib/shopify/warehouse", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, upsertShopifyCustomerEvents };
});

vi.mock("@/lib/sync/shopify-sync", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, syncShopifyCommerceReports };
});

// A genuine, authenticated webhook. Admission must come AFTER this succeeds —
// an unauthenticated request should still be rejected as unauthenticated.
vi.mock("@/lib/shopify/webhook-verification", () => ({
  verifyShopifyWebhook: vi.fn(async () => ({
    valid: true,
    body: JSON.stringify({ id: 1 }),
  })),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({ ready: true, missingTables: [] }),
}));

describe("Shopify webhook admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    assertSyncGrowthBoundary.mockResolvedValue({ allowed: true, reason: "ready" });
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    delete process.env.ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED;
  });

  it("refuses the sync webhook with a retryable status and writes nothing", async () => {
    const { POST } = await import("@/app/api/webhooks/shopify/sync/route");
    const response = await POST(
      new Request("https://example.test/api/webhooks/shopify/sync", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/create",
          "x-shopify-shop-domain": "seam.myshopify.com",
          "x-shopify-webhook-id": "wh-1",
        },
        body: JSON.stringify({ id: 1 }),
      }) as never,
    );

    // Retryable, not acknowledged: Shopify redelivers on 5xx, so nothing is
    // lost. A 200 would drop the event permanently.
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.received).toBe(false);
    expect(body.retryable).toBe(true);
    expect(body.error).toBe("lane_disabled");

    expect(upsertShopifyWebhookDelivery).not.toHaveBeenCalled();
    expect(upsertShopifyRepairIntent).not.toHaveBeenCalled();
    expect(syncShopifyCommerceReports).not.toHaveBeenCalled();
  });

  it("refuses the customer-events webhook with a retryable status and writes nothing", async () => {
    const { POST } = await import(
      "@/app/api/webhooks/shopify/customer-events/route"
    );
    const response = await POST(
      new Request("https://example.test/api/webhooks/shopify/customer-events", {
        method: "POST",
        headers: {
          "x-shopify-topic": "customers/update",
          "x-shopify-shop-domain": "seam.myshopify.com",
        },
        body: JSON.stringify({ id: 1 }),
      }) as never,
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.received).toBe(false);
    expect(body.retryable).toBe(true);
    expect(upsertShopifyCustomerEvents).not.toHaveBeenCalled();
  });

  describe("an unclassified guard failure still refuses", () => {
    /**
     * `describeSyncSafetyRefusal` returns null for anything it does not
     * recognise. Both routes tested only that value, so a timeout, a connection
     * reset, or a bug inside the fence produced "no refusal" and the handler
     * carried on and persisted. The guard permitted on its own failure.
     */
    beforeEach(() => {
      process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
      process.env.ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED = "enabled";
      assertSyncGrowthBoundary.mockRejectedValue(
        new Error("ETIMEDOUT: connection to the database timed out"),
      );
    });

    it("refuses the sync webhook and writes nothing", async () => {
      const { POST } = await import("@/app/api/webhooks/shopify/sync/route");
      const response = await POST(
        new Request("https://example.test/api/webhooks/shopify/sync", {
          method: "POST",
          headers: {
            "x-shopify-topic": "orders/create",
            "x-shopify-shop-domain": "seam.myshopify.com",
            "x-shopify-webhook-id": "wh-2",
          },
          body: JSON.stringify({ id: 1 }),
        }) as never,
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.received).toBe(false);
      expect(body.retryable).toBe(true);
      expect(body.error).toBe("capacity_check_failed");
      expect(upsertShopifyWebhookDelivery).not.toHaveBeenCalled();
      expect(syncShopifyCommerceReports).not.toHaveBeenCalled();
    });

    it("refuses the customer-events webhook and writes nothing", async () => {
      const { POST } = await import(
        "@/app/api/webhooks/shopify/customer-events/route"
      );
      const response = await POST(
        new Request("https://example.test/api/webhooks/shopify/customer-events", {
          method: "POST",
          headers: {
            "x-shopify-topic": "customers/update",
            "x-shopify-shop-domain": "seam.myshopify.com",
          },
          body: JSON.stringify({ id: 1 }),
        }) as never,
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.received).toBe(false);
      expect(body.retryable).toBe(true);
      expect(body.error).toBe("capacity_check_failed");
      expect(upsertShopifyCustomerEvents).not.toHaveBeenCalled();
    });
  });
});
