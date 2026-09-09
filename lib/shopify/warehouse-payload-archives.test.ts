import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = Object.assign(vi.fn(), {
  query: vi.fn(),
});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  /*
    ROUND 22, ITEM 1: the bindings view of the same store. `refIds` is what the
    id-only helper returns; `timezones` is what the binding actually holds
    afterwards, which writers now stamp their rows from. Mocked here as the
    identity of what was passed, because these suites are not about the binding
    rule -- lib/provider-account-timezone-authority.db.test.ts proves that
    against a real PostgreSQL.
  */
  ensureProviderAccountReferenceBindings: vi.fn(
    async ({
      accounts,
    }: {
      accounts: Array<{ externalAccountId: string; timezone?: string | null }>;
    }) => ({
      refIds: new Map(
        accounts.map(
          (account) =>
            [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const,
        ),
      ),
      timezones: new Map(
        accounts
          .filter((account) => (account.timezone ?? "").trim().length > 0)
          .map((account) => [account.externalAccountId, String(account.timezone)] as const),
      ),
    }),
  ),
  ensureProviderAccountReferenceIds: vi.fn(
    async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) =>
      new Map(
        accounts.map((account) => [
          account.externalAccountId,
          `${account.externalAccountId}-ref`,
        ] as const),
      ),
  ),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const),
    );
  }),
}));

const warehouse = await import("@/lib/shopify/warehouse");

describe("shopify warehouse payload archives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([]);
    sql.query.mockResolvedValue([]);
  });

  it("writes order payloads to shopify_entity_payload_archives", async () => {
    await warehouse.upsertShopifyOrders([
      {
        businessId: "biz-1",
        providerAccountId: "shop-1.myshopify.com",
        shopId: "shop-1",
        orderId: "order-1",
        orderCreatedAt: "2026-04-19T00:00:00.000Z",
        orderUpdatedAt: "2026-04-19T01:00:00.000Z",
        payloadJson: { id: "gid://shopify/Order/1" },
      },
    ]);

    const orderInsertSql = sql.query.mock.calls
      .map(([statement]) => String(statement))
      .find((statement) => statement.includes("INSERT INTO shopify_orders"));
    const archiveSql = sql.query.mock.calls
      .map(([statement]) => String(statement))
      .find((statement) => statement.includes("INSERT INTO shopify_entity_payload_archives"));

    expect(orderInsertSql).toBeTruthy();
    expect(orderInsertSql).not.toContain("payload_json");
    expect(archiveSql).toContain("shopify_entity_payload_archives");
    expect(archiveSql).toContain("payload_json");
    expect(archiveSql).toContain("payload_hash");
  });

  it("writes transaction and sales-event payloads to shopify_entity_payload_archives", async () => {
    await warehouse.upsertShopifyOrderTransactions([
      {
        businessId: "biz-1",
        providerAccountId: "shop-1.myshopify.com",
        shopId: "shop-1",
        orderId: "order-1",
        transactionId: "txn-1",
        payloadJson: { id: "gid://shopify/OrderTransaction/1" },
      },
    ]);

    await warehouse.upsertShopifySalesEvents([
      {
        businessId: "biz-1",
        providerAccountId: "shop-1.myshopify.com",
        shopId: "shop-1",
        eventId: "event-1",
        sourceKind: "order",
        sourceId: "order-1",
        orderId: "order-1",
        occurredAt: "2026-04-19T01:00:00.000Z",
        payloadJson: { kind: "order" },
      },
    ]);

    const querySql = sql.query.mock.calls
      .map(([statement]) => String(statement))
      .join("\n");

    expect(querySql).toContain("shopify_entity_payload_archives");
    expect(querySql).toContain("INSERT INTO shopify_sales_events");
    expect(querySql).not.toContain("payload_json,\n          source_snapshot_id");
  });

  it("moves webhook payloads and repair sync results into the archive lane", async () => {
    sql
      .mockResolvedValueOnce([
        {
          business_id: "biz-1",
          provider_account_id: "shop-1.myshopify.com",
          shop_domain: "shop-1.myshopify.com",
          topic: "orders/create",
          payload_hash: "hash-1",
          webhook_id: "webhook-1",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "repair-1",
          business_id: "biz-1",
          provider_account_id: "shop-1.myshopify.com",
          entity_type: "order",
          entity_id: "order-1",
          topic: "orders/create",
          payload_hash: "hash-1",
          event_timestamp: null,
          event_age_days: null,
          escalation_level: 0,
          status: "processed",
          attempt_count: 1,
          last_error: null,
          created_at: "2026-04-19T00:00:00.000Z",
          updated_at: "2026-04-19T00:00:00.000Z",
        },
      ]);

    await warehouse.upsertShopifyWebhookDelivery({
      businessId: "biz-1",
      providerAccountId: "shop-1.myshopify.com",
      topic: "orders/create",
      shopDomain: "shop-1.myshopify.com",
      webhookId: "webhook-1",
      payloadHash: "hash-1",
      payloadJson: { id: "gid://shopify/Order/1" },
      processingState: "processed",
      resultSummary: { ok: true },
    });

    await warehouse.upsertShopifyRepairIntent({
      businessId: "biz-1",
      providerAccountId: "shop-1.myshopify.com",
      entityType: "order",
      entityId: "order-1",
      topic: "orders/create",
      payloadHash: "hash-1",
      status: "processed",
      lastSyncResult: { ok: true },
    });

    const templateSql = sql.mock.calls
      .map(([strings]) => String((strings as TemplateStringsArray).join(" ")))
      .join("\n");
    const archiveSql = sql.query.mock.calls
      .map(([statement]) => String(statement))
      .join("\n");
    const archivePayloadRows = sql.query.mock.calls
      .flatMap(([, params]) => (Array.isArray(params) ? params : []))
      .map((value) => String(value))
      .join("\n");

    expect(templateSql).toContain("INSERT INTO shopify_webhook_deliveries");
    expect(templateSql).not.toContain("INSERT INTO shopify_webhook_deliveries (\n      business_id,\n      business_ref_id,\n      provider_account_id,\n      provider_account_ref_id,\n      topic,\n      shop_domain,\n      webhook_id,\n      payload_hash,\n      payload_json");
    expect(templateSql).not.toContain("result_summary");
    expect(templateSql).toContain("INSERT INTO shopify_repair_intents");
    expect(templateSql).not.toContain("last_sync_result");
    expect(archiveSql).toContain("shopify_entity_payload_archives");
    expect(archivePayloadRows).toContain("webhook_delivery");
    expect(archivePayloadRows).toContain("repair_intent_state");
  });

  it("hydrates webhook and repair debug fields from archived payloads", async () => {
    sql
      .mockResolvedValueOnce([
        {
          business_id: "biz-1",
          provider_account_id: "shop-1.myshopify.com",
          topic: "orders/create",
          shop_domain: "shop-1.myshopify.com",
          webhook_id: "webhook-1",
          payload_hash: "hash-1",
          received_at: "2026-04-19T00:00:00.000Z",
          processed_at: "2026-04-19T00:01:00.000Z",
          processing_state: "processed",
          error_message: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          entity_id: "shop-1.myshopify.com::orders/create::hash-1",
          payload_json: {
            payload: { id: "gid://shopify/Order/1" },
            resultSummary: { ok: true },
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "repair-1",
          business_id: "biz-1",
          provider_account_id: "shop-1.myshopify.com",
          entity_type: "order",
          entity_id: "order-1",
          topic: "orders/create",
          payload_hash: "hash-1",
          event_timestamp: null,
          event_age_days: null,
          escalation_level: 0,
          status: "processed",
          attempt_count: 1,
          last_error: null,
          created_at: "2026-04-19T00:00:00.000Z",
          updated_at: "2026-04-19T00:01:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          entity_id: "repair-1",
          payload_json: {
            lastSyncResult: { ok: true, repairs: 1 },
          },
        },
      ]);

    const delivery = await warehouse.getShopifyWebhookDelivery({
      shopDomain: "shop-1.myshopify.com",
      topic: "orders/create",
      payloadHash: "hash-1",
    });
    const repairIntents = await warehouse.listShopifyRepairIntents({
      businessId: "biz-1",
      providerAccountId: "shop-1.myshopify.com",
      limit: 5,
    });

    expect(delivery?.payloadJson).toEqual({ id: "gid://shopify/Order/1" });
    expect(delivery?.resultSummary).toEqual({ ok: true });
    expect(repairIntents[0]?.lastSyncResult).toEqual({ ok: true, repairs: 1 });
  });

  it("returns null debug detail when archive rows are absent", async () => {
    sql
      .mockResolvedValueOnce([
        {
          business_id: "biz-1",
          provider_account_id: "shop-1.myshopify.com",
          topic: "orders/create",
          shop_domain: "shop-1.myshopify.com",
          webhook_id: "webhook-1",
          payload_hash: "hash-1",
          received_at: "2026-04-19T00:00:00.000Z",
          processed_at: "2026-04-19T00:01:00.000Z",
          processing_state: "processed",
          error_message: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "repair-1",
          business_id: "biz-1",
          provider_account_id: "shop-1.myshopify.com",
          entity_type: "order",
          entity_id: "order-1",
          topic: "orders/create",
          payload_hash: "hash-1",
          event_timestamp: null,
          event_age_days: null,
          escalation_level: 0,
          status: "processed",
          attempt_count: 1,
          last_error: null,
          created_at: "2026-04-19T00:00:00.000Z",
          updated_at: "2026-04-19T00:01:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    const delivery = await warehouse.getShopifyWebhookDelivery({
      shopDomain: "shop-1.myshopify.com",
      topic: "orders/create",
      payloadHash: "hash-1",
    });
    const repairIntents = await warehouse.listShopifyRepairIntents({
      businessId: "biz-1",
      providerAccountId: "shop-1.myshopify.com",
      limit: 5,
    });

    expect(delivery?.payloadJson).toEqual({});
    expect(delivery?.resultSummary).toBeNull();
    expect(repairIntents[0]?.lastSyncResult).toBeNull();
  });
});
