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

function collectSqlText() {
  const templateSql = sql.mock.calls
    .map(([strings]) => String((strings as TemplateStringsArray).join(" ")))
    .join("\n");
  const querySql = sql.query.mock.calls
    .map(([statement]) => String(statement))
    .join("\n");
  return `${templateSql}\n${querySql}`;
}

describe("shopify warehouse dimensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([]);
    sql.query.mockResolvedValue([]);
  });

  it("upserts shop and customer dimensions from order writes", async () => {
    await warehouse.upsertShopifyOrders([
      {
        businessId: "biz-1",
        providerAccountId: "shop-1.myshopify.com",
        shopId: "shop-1",
        orderId: "order-1",
        customerId: "customer-1",
        orderCreatedAt: "2026-04-19T00:00:00.000Z",
        orderUpdatedAt: "2026-04-19T01:00:00.000Z",
        currencyCode: "USD",
        shopCurrencyCode: "USD",
      },
    ]);

    const joined = collectSqlText();
    expect(joined).toContain("shopify_shop_dimensions");
    expect(joined).toContain("shopify_customer_dimensions");
    expect(joined).toContain("business_ref_id");
    expect(joined).toContain("provider_account_ref_id");
    expect(joined).toContain("jsonb_to_recordset");
  });

  it("upserts product and variant dimensions from order line writes", async () => {
    await warehouse.upsertShopifyOrderLines([
      {
        businessId: "biz-1",
        providerAccountId: "shop-1.myshopify.com",
        shopId: "shop-1",
        orderId: "order-1",
        lineItemId: "line-1",
        productId: "product-1",
        variantId: "variant-1",
        sku: "SKU-1",
        title: "Product One",
        variantTitle: "Blue / Large",
        quantity: 1,
        observedAt: "2026-04-19T01:00:00.000Z",
      },
    ]);

    const joined = collectSqlText();
    expect(joined).toContain("shopify_product_dimensions");
    expect(joined).toContain("shopify_variant_dimensions");
    expect(joined).toContain("source_updated_at");
    expect(joined).toContain("business_ref_id");
    expect(joined).toContain("provider_account_ref_id");
  });
});
