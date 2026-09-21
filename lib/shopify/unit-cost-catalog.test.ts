import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDbSchemaReadiness: vi.fn(),
  getIntegration: vi.fn(),
  shopifyAdminGraphql: vi.fn(),
  assertShopifyGrantUnchanged: vi.fn(),
  query: vi.fn(),
  getDbContexts: [] as boolean[],
  transactionDepth: 0,
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: mocks.getDbSchemaReadiness,
  isMissingRelationError: vi.fn(() => false),
}));
vi.mock("@/lib/db", () => ({
  getDb: () => {
    mocks.getDbContexts.push(mocks.transactionDepth > 0);
    return { query: mocks.query };
  },
  runDbTransaction: async (fn: () => Promise<unknown>) => {
    mocks.transactionDepth += 1;
    try {
      return await fn();
    } finally {
      mocks.transactionDepth -= 1;
    }
  },
}));
vi.mock("@/lib/integrations", () => ({ getIntegration: mocks.getIntegration }));
vi.mock("@/lib/shopify/admin", () => ({
  hasShopifyScope: (scopes: string | null | undefined, scope: string) =>
    String(scopes ?? "").split(/[,\s]+/).includes(scope),
  shopifyAdminGraphql: mocks.shopifyAdminGraphql,
}));
vi.mock("@/lib/shopify/install-context", () => ({
  readShopifyGrantAuthority: (integration: Record<string, unknown>) => ({
    connectionGeneration: `${integration.connection_generation}:connected`,
    shopDomain: integration.provider_account_id,
    accessToken: integration.access_token,
  }),
  assertShopifyGrantUnchanged: mocks.assertShopifyGrantUnchanged,
}));

const {
  getShopifyUnitCostCatalog,
  ShopifyUnitCostSyncError,
  syncShopifyUnitCosts,
} = await import("@/lib/shopify/unit-cost-catalog");

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

function variant(input: {
  id: string;
  amount?: string | null;
  currencyCode?: string | null;
}) {
  return {
    id: `gid://shopify/ProductVariant/${input.id}`,
    title: `Variant ${input.id}`,
    sku: `SKU-${input.id}`,
    updatedAt: "2026-09-18T05:00:00Z",
    product: { id: `gid://shopify/Product/${input.id}`, title: `Product ${input.id}` },
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${input.id}`,
      updatedAt: "2026-09-18T06:00:00Z",
      unitCost:
        input.amount == null
          ? null
          : { amount: input.amount, currencyCode: input.currencyCode ?? "USD" },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDbContexts.length = 0;
  mocks.transactionDepth = 0;
  mocks.getDbSchemaReadiness.mockResolvedValue({ ready: true, missingTables: [] });
  mocks.getIntegration.mockResolvedValue({
    status: "connected",
    provider_account_id: "store.myshopify.com",
    access_token: "token",
    scopes: "read_products,read_inventory",
    connection_generation: 4,
  });
  mocks.assertShopifyGrantUnchanged.mockResolvedValue({ ok: true });
  mocks.query.mockResolvedValue([]);
});

describe("syncShopifyUnitCosts", () => {
  it("fetches every page, retains missing cost as missing, and writes only after a full snapshot", async () => {
    mocks.shopifyAdminGraphql
      .mockResolvedValueOnce({
        productVariants: {
          nodes: [variant({ id: "1", amount: "12.340000", currencyCode: "USD" })],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
      })
      .mockResolvedValueOnce({
        productVariants: {
          nodes: [variant({ id: "2", amount: null })],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });

    const result = await syncShopifyUnitCosts(BUSINESS_ID);

    expect(result).toMatchObject({
      pages: 2,
      totalVariants: 2,
      costedVariants: 1,
      missingCostVariants: 1,
    });
    expect(mocks.shopifyAdminGraphql).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ variables: { cursor: "next", pageSize: 250 } }),
    );
    expect(mocks.assertShopifyGrantUnchanged).toHaveBeenCalledTimes(1);
    expect(mocks.getDbContexts).toEqual([true]);
    const writePayload = JSON.parse(String(mocks.query.mock.calls[1]?.[1]?.[0])) as Array<{
      unit_cost: string | null;
      currency_code: string | null;
    }>;
    expect(writePayload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit_cost: "12.340000", currency_code: "USD" }),
        expect.objectContaining({ unit_cost: null, currency_code: null }),
      ]),
    );
  });

  it("does not store a snapshot when the Shopify grant changes during pagination", async () => {
    mocks.shopifyAdminGraphql.mockResolvedValue({
      productVariants: {
        nodes: [variant({ id: "1", amount: "8" })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    mocks.assertShopifyGrantUnchanged.mockResolvedValue({
      ok: false,
      code: "shopify_connection_changed",
      detail: "connection moved",
    });

    await expect(syncShopifyUnitCosts(BUSINESS_ID)).rejects.toMatchObject({
      code: "connection_changed",
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("requires both Shopify product and inventory scopes", async () => {
    mocks.getIntegration.mockResolvedValue({
      status: "connected",
      provider_account_id: "store.myshopify.com",
      access_token: "token",
      scopes: "read_products",
      connection_generation: 4,
    });

    await expect(syncShopifyUnitCosts(BUSINESS_ID)).rejects.toBeInstanceOf(
      ShopifyUnitCostSyncError,
    );
    await expect(syncShopifyUnitCosts(BUSINESS_ID)).rejects.toMatchObject({
      code: "missing_scopes",
    });
    expect(mocks.shopifyAdminGraphql).not.toHaveBeenCalled();
  });
});

describe("getShopifyUnitCostCatalog", () => {
  it("reports coverage from all active variants and keeps filtered pagination separate", async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("COUNT(*)::integer AS total_variants")) {
        return [{
          total_variants: 10,
          costed_variants: 7,
          missing_cost_variants: 3,
          last_synced_at: "2026-09-18T06:00:00Z",
        }];
      }
      if (statement.includes("GROUP BY currency_code")) {
        return [{ currency_code: "USD", count: 7 }];
      }
      if (statement.includes("COUNT(*)::integer AS count")) return [{ count: 2 }];
      if (statement.includes("SELECT product_id")) {
        return [{
          product_id: "product-1",
          variant_id: "variant-1",
          inventory_item_id: "inventory-1",
          sku: "SKU-1",
          product_title: "Product 1",
          variant_title: "Default",
          unit_cost: null,
          currency_code: null,
          source_updated_at: "2026-09-18T05:00:00Z",
          observed_at: "2026-09-18T06:00:00Z",
        }];
      }
      return [];
    });

    const catalog = await getShopifyUnitCostCatalog({
      businessId: BUSINESS_ID,
      search: "SKU",
      limit: 25,
      offset: 0,
    });

    expect(catalog.summary).toMatchObject({
      totalVariants: 10,
      costedVariants: 7,
      missingCostVariants: 3,
      coveragePercent: 70,
    });
    expect(catalog.matchedVariants).toBe(2);
    expect(catalog.rows[0]).toMatchObject({ unitCost: null, currencyCode: null });
  });

  it("returns an explicit unavailable state instead of treating missing tables as an empty catalog", async () => {
    mocks.getDbSchemaReadiness.mockResolvedValue({
      ready: false,
      missingTables: ["shopify_variant_unit_costs"],
    });

    const catalog = await getShopifyUnitCostCatalog({ businessId: BUSINESS_ID });

    expect(catalog.storage).toEqual({
      ready: false,
      missingTables: ["shopify_variant_unit_costs"],
    });
    expect(catalog.summary.lastSyncedAt).toBeNull();
  });
});
