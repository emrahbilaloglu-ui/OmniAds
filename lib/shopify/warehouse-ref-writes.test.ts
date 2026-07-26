import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = Object.assign(vi.fn(), {
  query: vi.fn(),
});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
  // The raw-snapshot writer is two-layer: canonical content and its receipt
  // must land together or not at all, so it runs inside a transaction.
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  ensureProviderAccountReferenceIds: vi.fn(async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) => {
    return new Map(
      accounts.map((account) => [account.externalAccountId, `${account.externalAccountId}-ref`] as const),
    );
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const),
    );
  }),
}));

const warehouse = await import("@/lib/shopify/warehouse");

describe("shopify warehouse canonical refs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([]);
    sql.query.mockResolvedValue([]);
  });

  it("writes canonical refs for raw snapshots and event tables", async () => {
    await warehouse.insertShopifyRawSnapshot({
      businessId: "biz-1",
      providerAccountId: "shop-1",
      endpointName: "orders",
      entityScope: "shop",
      payloadJson: { rows: [] },
      payloadHash: "hash-1",
      status: "fetched",
    });

    await warehouse.upsertShopifySalesEvents([
      {
        businessId: "biz-1",
        providerAccountId: "shop-1",
        shopId: "shop-1",
        eventId: "event-1",
        sourceKind: "order",
        sourceId: "order-1",
        occurredAt: "2026-04-17T00:00:00.000Z",
      },
    ]);

    await warehouse.upsertShopifyCustomerEvents([
      {
        businessId: "biz-1",
        providerAccountId: "shop-1",
        shopId: "shop-1",
        eventId: "cust-1",
        eventType: "page_view",
        occurredAt: "2026-04-17T00:00:00.000Z",
      },
    ]);

    const joined = [
      ...sql.mock.calls.map(([strings]) =>
        String((strings as TemplateStringsArray).join(" ")),
      ),
      ...sql.query.mock.calls.map(([statement]) => String(statement)),
    ].join("\n");
    expect(joined).toContain("shopify_raw_snapshots");
    expect(joined).toContain("shopify_sales_events");
    expect(joined).toContain("shopify_customer_events");
    expect(joined).toContain("business_ref_id");
    expect(joined).toContain("provider_account_ref_id");
  });

  it("writes canonical refs for overrides, webhooks, and repair intents", async () => {
    sql.mockResolvedValue([{ id: "repair-1" }]);

    await warehouse.upsertShopifyServingOverride({
      businessId: "biz-1",
      providerAccountId: "shop-1",
      overrideKey: "default",
      mode: "auto",
    });

    await warehouse.upsertShopifyWebhookDelivery({
      businessId: "biz-1",
      providerAccountId: "shop-1",
      topic: "orders/create",
      shopDomain: "shop-1.myshopify.com",
      payloadHash: "hash-1",
      payloadJson: {},
      processingState: "received",
    });

    await warehouse.upsertShopifyRepairIntent({
      businessId: "biz-1",
      providerAccountId: "shop-1",
      entityType: "order",
      entityId: "order-1",
      topic: "orders/create",
      payloadHash: "hash-1",
      status: "pending",
    });

    const joined = sql.mock.calls
      .map(([strings]) => String((strings as TemplateStringsArray).join(" ")))
      .join("\n");
    expect(joined).toContain("shopify_serving_overrides");
    expect(joined).toContain("shopify_webhook_deliveries");
    expect(joined).toContain("shopify_repair_intents");
    expect(joined).toContain("business_ref_id");
    expect(joined).toContain("provider_account_ref_id");
  });
});
