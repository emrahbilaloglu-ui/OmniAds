import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
  mergeIntegrationMetadata: vi.fn(),
}));

vi.mock("@/lib/shopify/admin", () => ({
  SHOPIFY_ADMIN_API_VERSION: "2026-04",
  hasShopifyScope: vi.fn((scopes: string | null | undefined, scope: string) =>
    (scopes ?? "").split(/[,\s]+/).includes(scope)
  ),
  validateShopifyAdminCredentials: vi.fn(),
}));

vi.mock("@/lib/shopify/status", () => ({
  getShopifyStatus: vi.fn(),
  isShopifyDefaultCutoverEvidenceReady: vi.fn(
    (reconciliation) => reconciliation?.defaultCutoverEligible === true,
  ),
}));

vi.mock("@/lib/shopify/warehouse-overview", () => ({
  getShopifyWarehouseOverviewAggregate: vi.fn(),
}));

vi.mock("@/lib/shopify/revenue-ledger", () => ({
  getShopifyRevenueLedgerAggregate: vi.fn(),
}));

vi.mock("@/lib/shopify/customer-events-analytics", () => ({
  getShopifyCustomerEventsAggregate: vi.fn(),
}));

vi.mock("@/lib/shopify/warehouse", () => ({
  listShopifyReconciliationRuns: vi.fn(),
  listShopifyRepairIntents: vi.fn(),
  listShopifyWebhookDeliveries: vi.fn(),
  getShopifyServingOverride: vi.fn(),
  getShopifyServingState: vi.fn(),
  listShopifyServingStateHistory: vi.fn(),
  upsertShopifyServingOverride: vi.fn(),
}));

vi.mock("@/lib/sync/shopify-sync", () => ({
  ensureShopifyProviderReady: vi.fn(),
  syncShopifyCommerceReports: vi.fn(),
}));

vi.mock("@/lib/shopify/webhooks", () => ({
  registerShopifySyncWebhooks: vi.fn(),
  verifyShopifySyncWebhooks: vi.fn(),
}));

const adminAuth = await import("@/lib/admin-auth");
const integrations = await import("@/lib/integrations");
const shopifyAdmin = await import("@/lib/shopify/admin");
const shopifyStatus = await import("@/lib/shopify/status");
const shopifyWarehouse = await import("@/lib/shopify/warehouse");
const warehouseOverview = await import("@/lib/shopify/warehouse-overview");
const revenueLedger = await import("@/lib/shopify/revenue-ledger");
const customerEventsAnalytics = await import("@/lib/shopify/customer-events-analytics");
const shopifySync = await import("@/lib/sync/shopify-sync");
const shopifyWebhooks = await import("@/lib/shopify/webhooks");
const { GET, PATCH } = await import("@/app/api/admin/integrations/health/shopify/route");

describe("GET /api/admin/integrations/health/shopify", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      session: { user: { id: "admin_1", role: "admin" } },
    } as never);
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      provider_account_id: "test-shop.myshopify.com",
      access_token: "token",
      scopes: "read_orders,read_returns",
      metadata: { shopifyProductionServingMode: "auto" },
      status: "connected",
    } as never);
    vi.mocked(shopifyAdmin.validateShopifyAdminCredentials).mockResolvedValue({
      valid: true,
      error: null,
    } as never);
    vi.mocked(shopifyWarehouse.getShopifyServingOverride).mockResolvedValue(null as never);
    vi.mocked(shopifyWarehouse.listShopifyReconciliationRuns).mockResolvedValue([] as never);
    vi.mocked(shopifyWarehouse.listShopifyRepairIntents).mockResolvedValue([] as never);
    vi.mocked(shopifyWarehouse.listShopifyWebhookDeliveries).mockResolvedValue([] as never);
    vi.mocked(shopifyWebhooks.verifyShopifySyncWebhooks).mockResolvedValue({
      desiredTopics: ["ORDERS_CREATE"],
      existingTopics: ["ORDERS_CREATE"],
      missingTopics: [],
      extraTopics: [],
      callbackUrl: "https://app.example.com/api/webhooks/shopify/sync",
    } as never);
    vi.mocked(warehouseOverview.getShopifyWarehouseOverviewAggregate).mockResolvedValue(null as never);
    vi.mocked(revenueLedger.getShopifyRevenueLedgerAggregate).mockResolvedValue(null as never);
    vi.mocked(customerEventsAnalytics.getShopifyCustomerEventsAggregate).mockResolvedValue(null as never);
  });

  it("returns a range-aware Shopify canary inspection payload", async () => {
    vi.mocked(shopifyStatus.getShopifyStatus).mockResolvedValue({
      state: "partial",
      connected: true,
      shopId: "test-shop.myshopify.com",
      warehouse: null,
      sync: null,
      serving: null,
      reconciliation: null,
      issues: ["Shopify warehouse canary is blocked by trust checks."],
    } as never);
    vi.mocked(shopifyWarehouse.getShopifyServingState).mockResolvedValue({
      canaryKey: "overview_shopify:2026-03-01:2026-03-31:shop_local",
      canServeWarehouse: false,
      decisionReasons: ["divergence_above_threshold"],
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      timeZoneBasis: "shop_local",
    } as never);
    vi.mocked(shopifyWarehouse.listShopifyServingStateHistory).mockResolvedValue([
      {
        canaryKey: "overview_shopify:2026-03-01:2026-03-31:shop_local",
        canServeWarehouse: false,
        decisionReasons: ["divergence_above_threshold"],
        assessedAt: "2026-04-02T10:00:00.000Z",
      },
    ] as never);

    const request = new NextRequest(
      "http://localhost:3000/api/admin/integrations/health/shopify?businessId=biz_1&startDate=2026-03-01&endDate=2026-03-31"
    );

    const response = await GET(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(shopifyStatus.getShopifyStatus).toHaveBeenCalledWith({
      businessId: "biz_1",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    expect(payload.canaryKey).toBe("overview_shopify:2026-03-01:2026-03-31:shop_local");
    expect(payload.auth).toEqual(
      expect.objectContaining({
        apiVersion: "2026-04",
        shopDomain: "test-shop.myshopify.com",
        tokenPresent: true,
        tokenValid: true,
        missingScopes: expect.arrayContaining(["read_all_orders"]),
        missingRequiredScopes: expect.arrayContaining(["read_all_orders"]),
        missingOptionalScopes: [],
        productionMode: "auto",
      })
    );
    expect(payload.serving?.decisionReasons).toEqual(["divergence_above_threshold"]);
    expect(payload.webhookCoverage).toEqual(
      expect.objectContaining({
        missingTopics: [],
      })
    );
    expect(payload.history).toHaveLength(1);
    expect(payload.reconciliationHistory).toEqual([]);
    expect(payload.ledgerConsistency).toBeNull();
    expect(payload.customerEventsAggregate).toBeNull();
    expect(payload.webhookDeliveries).toEqual([]);
    expect(payload.rollout).toEqual(
      expect.objectContaining({
        previewCanaryReady: false,
        broaderLocalServingReady: false,
        defaultCutoverReady: false,
        lastDecisionReasons: ["divergence_above_threshold"],
        stableWarehouseRunCount: 0,
        stableLedgerRunCount: 0,
        hasRecentWebhookFailures: false,
        recentWebhookFailures: [],
        cutoverExplanation: expect.objectContaining({
          statusState: "partial",
          ledgerConsistencyWithinThreshold: null,
        }),
      })
    );
    expect(payload.auth.returnsRepairBlockedByMissingReadReturns).toBe(false);
  });

  it("updates a Shopify serving override", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/admin/integrations/health/shopify",
      {
        method: "PATCH",
        body: JSON.stringify({
          businessId: "biz_1",
          providerAccountId: "test-shop.myshopify.com",
          startDate: "2026-03-01",
          endDate: "2026-03-31",
          mode: "force_live",
          reason: "manual_validation",
        }),
      }
    );

    const response = await PATCH(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(shopifyWarehouse.upsertShopifyServingOverride).toHaveBeenCalled();
  });

  it("updates shop-scoped production mode", async () => {
    const request = new NextRequest("http://localhost:3000/api/admin/integrations/health/shopify", {
      method: "PATCH",
      body: JSON.stringify({
        businessId: "biz_1",
        productionMode: "auto",
        reason: "enable_shop",
      }),
    });

    const response = await PATCH(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.productionMode).toBe("auto");
    expect(integrations.mergeIntegrationMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        provider: "shopify",
      })
    );
  });

  it("runs a manual readiness action", async () => {
    vi.mocked(shopifySync.ensureShopifyProviderReady).mockResolvedValue({
      success: true,
    } as never);
    const request = new NextRequest("http://localhost:3000/api/admin/integrations/health/shopify", {
      method: "PATCH",
      body: JSON.stringify({
        businessId: "biz_1",
        action: "run_recent_bootstrap",
      }),
    });

    const response = await PATCH(request as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.action).toBe("run_recent_bootstrap");
    expect(shopifySync.ensureShopifyProviderReady).toHaveBeenCalled();
  });

  it("refuses a webhook action when the Shopify grant moved during the request", async () => {
    // An operator opens the panel, a reconnect lands, and the action registers
    // webhooks under a credential nobody looked at — pointing a different shop's
    // order events at this business.
    const connected = (over: Record<string, unknown>) => ({
      provider_account_id: "test-shop.myshopify.com",
      access_token: "token",
      scopes: "read_orders,read_returns",
      metadata: {},
      status: "connected",
      connection_generation: 3,
      ...over,
    });
    vi.mocked(integrations.getIntegration)
      .mockResolvedValueOnce(connected({}) as never)
      .mockResolvedValue(
        connected({
          provider_account_id: "someone-else.myshopify.com",
          access_token: "other_token",
          connection_generation: 8,
        }) as never,
      );

    const request = new NextRequest(
      "http://localhost:3000/api/admin/integrations/health/shopify",
      {
        method: "PATCH",
        body: JSON.stringify({ businessId: "biz_1", action: "register_webhooks" }),
      },
    );

    const response = await PATCH(request as never);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toBe("shopify_connection_changed");
    expect(shopifyWebhooks.registerShopifySyncWebhooks).not.toHaveBeenCalled();
  });

  it("treats an unreadable connection as retryable, not as unchanged", async () => {
    vi.mocked(integrations.getIntegration).mockRejectedValue(new Error("db down"));

    const request = new NextRequest(
      "http://localhost:3000/api/admin/integrations/health/shopify",
      {
        method: "PATCH",
        body: JSON.stringify({ businessId: "biz_1", action: "register_webhooks" }),
      },
    );

    const response = await PATCH(request as never);

    expect(shopifyWebhooks.registerShopifySyncWebhooks).not.toHaveBeenCalled();
    expect([400, 503]).toContain(response.status);
  });
});
