import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/sync/global-kill-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/global-kill-switch")>();
  return {
    ...actual,
    // Lanes default to OFF. The refusal path has its own suite; these cases are
    // about what the route does once admitted.
    evaluateLaneAdmission: vi.fn(() => ({
      lane: "shopify_sync" as const,
      enabled: true,
      reason: "enabled" as const,
    })),
  };
});

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/db-growth-fence")>();
  return {
    ...actual,
    assertSyncGrowthBoundary: vi.fn(async () => ({
      allowed: true as const,
      reason: "ready" as const,
      warning: false,
      databaseBytes: 1,
      databaseBudgetBytes: 2,
      tableBytes: {},
      offender: null,
      evaluatedAt: "2026-07-26T00:00:00.000Z",
      errorMessage: null,
      overridden: false,
    })),
  };
});
vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

vi.mock("@/lib/shopify/warehouse", () => ({
  upsertShopifyCustomerEvents: vi.fn(),
}));

const db = await import("@/lib/db");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const migrations = await import("@/lib/migrations");
const warehouse = await import("@/lib/shopify/warehouse");
const { POST } = await import("@/app/api/webhooks/shopify/customer-events/route");

describe("POST /api/webhooks/shopify/customer-events", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.SHOPIFY_CUSTOMER_EVENTS_SECRET;
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
  });

  it("fails closed when schema is not ready", async () => {
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["shopify_customer_events"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });

    const request = new NextRequest("http://localhost:3000/api/webhooks/shopify/customer-events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-shop-domain": "test-shop.myshopify.com",
      },
      body: JSON.stringify({
        eventId: "evt_schema",
        eventType: "page_viewed",
      }),
    });

    const response = await POST(request as never);
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toEqual({
      error: "schema_not_ready",
      received: false,
      missingTables: ["shopify_customer_events"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    expect(warehouse.upsertShopifyCustomerEvents).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("stores Shopify customer events for a connected shop", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      vi.fn().mockResolvedValue([
        {
          business_id: "biz_1",
          provider_account_id: "test-shop.myshopify.com",
        },
      ]) as never
    );
    vi.mocked(warehouse.upsertShopifyCustomerEvents).mockResolvedValue(1);

    const request = new NextRequest("http://localhost:3000/api/webhooks/shopify/customer-events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-shop-domain": "test-shop.myshopify.com",
      },
      body: JSON.stringify({
        eventId: "evt_1",
        eventType: "page_viewed",
        occurredAt: "2026-04-02T10:00:00.000Z",
        sessionId: "sess_1",
        pageUrl: "https://store.example/products/1",
      }),
    });

    const response = await POST(request as never);
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.received).toBe(true);
    expect(payload.written).toBe(1);
    expect(warehouse.upsertShopifyCustomerEvents).toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });
});
