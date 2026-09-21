import { randomUUID } from "node:crypto";

import { getDb, runDbTransaction } from "@/lib/db";
import { getDbSchemaReadiness, isMissingRelationError } from "@/lib/db-schema-readiness";
import { getIntegration } from "@/lib/integrations";
import { hasShopifyScope, shopifyAdminGraphql } from "@/lib/shopify/admin";
import {
  assertShopifyGrantUnchanged,
  readShopifyGrantAuthority,
} from "@/lib/shopify/install-context";

export const SHOPIFY_UNIT_COST_TABLES = ["shopify_variant_unit_costs"] as const;
export const SHOPIFY_UNIT_COST_WRITE_TABLES = [
  ...SHOPIFY_UNIT_COST_TABLES,
  "shopify_variant_unit_cost_history",
] as const;

const SHOPIFY_UNIT_COST_PAGE_SIZE = 250;
const SHOPIFY_UNIT_COST_MAX_PAGES = 100;
const SHOPIFY_UNIT_COST_LOCK_NAMESPACE = 0x53435543; // "SCUC"

export const SHOPIFY_UNIT_COSTS_QUERY = `
  query AdsecuteShopifyUnitCosts($cursor: String, $pageSize: Int!) {
    productVariants(first: $pageSize, after: $cursor, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        sku
        updatedAt
        product { id title }
        inventoryItem {
          id
          updatedAt
          unitCost { amount currencyCode }
        }
      }
    }
  }
`;

interface ShopifyUnitCostPayload {
  productVariants?: {
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
    nodes?: Array<{
      id?: string | null;
      title?: string | null;
      sku?: string | null;
      updatedAt?: string | null;
      product?: { id?: string | null; title?: string | null } | null;
      inventoryItem?: {
        id?: string | null;
        updatedAt?: string | null;
        unitCost?: { amount?: string | null; currencyCode?: string | null } | null;
      } | null;
    } | null> | null;
  } | null;
}

export interface ShopifyUnitCostRow {
  productId: string;
  variantId: string;
  inventoryItemId: string;
  sku: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  unitCost: string | null;
  currencyCode: string | null;
  sourceUpdatedAt: string | null;
  observedAt: string;
}

export interface ShopifyUnitCostCatalog {
  storage: { ready: boolean; missingTables: string[] };
  summary: {
    totalVariants: number;
    costedVariants: number;
    missingCostVariants: number;
    coveragePercent: number | null;
    currencyCounts: Array<{ currencyCode: string; count: number }>;
    lastSyncedAt: string | null;
  };
  rows: ShopifyUnitCostRow[];
  matchedVariants: number;
  limit: number;
  offset: number;
}

export class ShopifyUnitCostStorageUnavailableError extends Error {
  readonly code = "SHOPIFY_UNIT_COST_STORAGE_UNAVAILABLE";

  constructor(readonly missingTables: readonly string[]) {
    super(`Shopify unit-cost storage is unavailable (${missingTables.join(", ")}).`);
    this.name = "ShopifyUnitCostStorageUnavailableError";
  }
}

export class ShopifyUnitCostSyncError extends Error {
  constructor(
    readonly code:
      | "not_connected"
      | "missing_scopes"
      | "connection_changed"
      | "invalid_provider_response"
      | "page_limit_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "ShopifyUnitCostSyncError";
  }
}

function normalizeText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMoney(value: unknown) {
  const text = normalizeText(value);
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric >= 0 ? text : null;
}

function normalizeCurrency(value: unknown) {
  const code = normalizeText(value)?.toUpperCase() ?? null;
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

function emptyCatalog(missingTables: readonly string[]): ShopifyUnitCostCatalog {
  return {
    storage: { ready: false, missingTables: [...missingTables] },
    summary: {
      totalVariants: 0,
      costedVariants: 0,
      missingCostVariants: 0,
      coveragePercent: null,
      currencyCounts: [],
      lastSyncedAt: null,
    },
    rows: [],
    matchedVariants: 0,
    limit: 50,
    offset: 0,
  };
}

function asStorageUnavailable(error: unknown, tables: readonly string[]): never {
  if (isMissingRelationError(error, [...tables])) {
    throw new ShopifyUnitCostStorageUnavailableError(tables);
  }
  throw error;
}

async function requireStorage(tables: readonly string[]) {
  const readiness = await getDbSchemaReadiness({ tables: [...tables] });
  if (!readiness.ready) {
    throw new ShopifyUnitCostStorageUnavailableError(readiness.missingTables);
  }
}

export async function getShopifyUnitCostCatalog(input: {
  businessId: string;
  search?: string | null;
  limit?: number;
  offset?: number;
}): Promise<ShopifyUnitCostCatalog> {
  const readiness = await getDbSchemaReadiness({ tables: [...SHOPIFY_UNIT_COST_TABLES] });
  if (!readiness.ready) return emptyCatalog(readiness.missingTables);

  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const search = normalizeText(input.search);
  const sql = getDb();

  try {
    const [summaryRows, currencyRows, rows, matchedRows] = await Promise.all([
      sql.query(
        `SELECT COUNT(*)::integer AS total_variants,
                COUNT(unit_cost)::integer AS costed_variants,
                (COUNT(*) - COUNT(unit_cost))::integer AS missing_cost_variants,
                MAX(observed_at) AS last_synced_at
         FROM shopify_variant_unit_costs
         WHERE business_id = $1::uuid AND active = true`,
        [input.businessId],
      ) as Promise<Array<Record<string, unknown>>>,
      sql.query(
        `SELECT currency_code, COUNT(*)::integer AS count
         FROM shopify_variant_unit_costs
         WHERE business_id = $1::uuid AND active = true AND unit_cost IS NOT NULL
         GROUP BY currency_code
         ORDER BY count DESC, currency_code ASC`,
        [input.businessId],
      ) as Promise<Array<Record<string, unknown>>>,
      sql.query(
        `SELECT product_id, variant_id, inventory_item_id, sku, product_title,
                variant_title, unit_cost::text AS unit_cost, currency_code,
                source_updated_at, observed_at
         FROM shopify_variant_unit_costs
         WHERE business_id = $1::uuid
           AND active = true
           AND ($2::text IS NULL OR COALESCE(sku, '') ILIKE '%' || $2 || '%'
                OR COALESCE(product_title, '') ILIKE '%' || $2 || '%'
                OR COALESCE(variant_title, '') ILIKE '%' || $2 || '%')
         ORDER BY (unit_cost IS NULL) DESC, product_title ASC NULLS LAST,
                  variant_title ASC NULLS LAST, variant_id ASC
         LIMIT $3 OFFSET $4`,
        [input.businessId, search, limit, offset],
      ) as Promise<Array<Record<string, unknown>>>,
      sql.query(
        `SELECT COUNT(*)::integer AS count
         FROM shopify_variant_unit_costs
         WHERE business_id = $1::uuid
           AND active = true
           AND ($2::text IS NULL OR COALESCE(sku, '') ILIKE '%' || $2 || '%'
                OR COALESCE(product_title, '') ILIKE '%' || $2 || '%'
                OR COALESCE(variant_title, '') ILIKE '%' || $2 || '%')`,
        [input.businessId, search],
      ) as Promise<Array<Record<string, unknown>>>,
    ]);

    const summary = summaryRows[0] ?? {};
    const totalVariants = Number(summary.total_variants ?? 0);
    const costedVariants = Number(summary.costed_variants ?? 0);
    return {
      storage: { ready: true, missingTables: [] },
      summary: {
        totalVariants,
        costedVariants,
        missingCostVariants: Number(summary.missing_cost_variants ?? 0),
        coveragePercent:
          totalVariants > 0 ? Math.round((costedVariants / totalVariants) * 10_000) / 100 : null,
        currencyCounts: currencyRows.map((row) => ({
          currencyCode: String(row.currency_code ?? "UNKNOWN"),
          count: Number(row.count ?? 0),
        })),
        lastSyncedAt: summary.last_synced_at ? String(summary.last_synced_at) : null,
      },
      rows: rows.map((row) => ({
        productId: String(row.product_id),
        variantId: String(row.variant_id),
        inventoryItemId: String(row.inventory_item_id),
        sku: row.sku ? String(row.sku) : null,
        productTitle: row.product_title ? String(row.product_title) : null,
        variantTitle: row.variant_title ? String(row.variant_title) : null,
        unitCost: row.unit_cost == null ? null : String(row.unit_cost),
        currencyCode: row.currency_code ? String(row.currency_code) : null,
        sourceUpdatedAt: row.source_updated_at ? String(row.source_updated_at) : null,
        observedAt: String(row.observed_at),
      })),
      matchedVariants: Number(matchedRows[0]?.count ?? 0),
      limit,
      offset,
    };
  } catch (error) {
    return asStorageUnavailable(error, SHOPIFY_UNIT_COST_TABLES);
  }
}

function mapNode(
  node: NonNullable<NonNullable<ShopifyUnitCostPayload["productVariants"]>["nodes"]>[number],
  observedAt: string,
): ShopifyUnitCostRow | null {
  if (!node?.id || !node.inventoryItem?.id || !node.product?.id) return null;
  const unitCost = normalizeMoney(node.inventoryItem.unitCost?.amount);
  const currencyCode = unitCost
    ? normalizeCurrency(node.inventoryItem.unitCost?.currencyCode)
    : null;
  if (unitCost && !currencyCode) return null;
  return {
    productId: node.product.id,
    variantId: node.id,
    inventoryItemId: node.inventoryItem.id,
    sku: normalizeText(node.sku),
    productTitle: normalizeText(node.product.title),
    variantTitle: normalizeText(node.title),
    unitCost,
    currencyCode,
    sourceUpdatedAt: normalizeText(node.inventoryItem.updatedAt) ?? normalizeText(node.updatedAt),
    observedAt,
  };
}

async function persistSnapshot(input: {
  businessId: string;
  shopDomain: string;
  rows: ShopifyUnitCostRow[];
  observedAt: string;
}) {
  await requireStorage(SHOPIFY_UNIT_COST_WRITE_TABLES);
  const syncToken = randomUUID();
  const records = input.rows.map((row) => ({
    business_id: input.businessId,
    provider_account_id: input.shopDomain,
    ...row,
    product_id: row.productId,
    variant_id: row.variantId,
    inventory_item_id: row.inventoryItemId,
    product_title: row.productTitle,
    variant_title: row.variantTitle,
    unit_cost: row.unitCost,
    currency_code: row.currencyCode,
    source_updated_at: row.sourceUpdatedAt,
    observed_at: row.observedAt,
    sync_token: syncToken,
  }));

  await runDbTransaction(async () => {
    // getDb must be resolved inside the AsyncLocalStorage transaction scope;
    // a client captured before runDbTransaction would execute every statement
    // on the shared pool and make the advisory lock plus snapshot writes non-atomic.
    const sql = getDb();
    await sql.query(
      "SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))",
      [SHOPIFY_UNIT_COST_LOCK_NAMESPACE, input.businessId],
    );

    await sql.query(
      `WITH input_rows AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS record(
           business_id uuid, provider_account_id text, product_id text,
           variant_id text, inventory_item_id text, sku text,
           product_title text, variant_title text, unit_cost text,
           currency_code text, source_updated_at timestamptz,
           observed_at timestamptz, sync_token uuid
         )
       )
       INSERT INTO shopify_variant_unit_cost_history (
         business_id, provider_account_id, product_id, variant_id,
         inventory_item_id, sku, product_title, variant_title, unit_cost,
         currency_code, source_updated_at, observed_at, active, change_kind
       )
       SELECT i.business_id, i.provider_account_id, i.product_id, i.variant_id,
              i.inventory_item_id, i.sku, i.product_title, i.variant_title,
              i.unit_cost::numeric, i.currency_code, i.source_updated_at,
              i.observed_at, true, 'observed'
       FROM input_rows i
       LEFT JOIN shopify_variant_unit_costs c
         ON c.business_id = i.business_id
        AND c.provider_account_id = i.provider_account_id
        AND c.variant_id = i.variant_id
       WHERE c.id IS NULL
          OR c.inventory_item_id IS DISTINCT FROM i.inventory_item_id
          OR c.unit_cost IS DISTINCT FROM i.unit_cost::numeric
          OR c.currency_code IS DISTINCT FROM i.currency_code
          OR c.active IS DISTINCT FROM true`,
      [JSON.stringify(records)],
    );

    await sql.query(
      `WITH input_rows AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS record(
           business_id uuid, provider_account_id text, product_id text,
           variant_id text, inventory_item_id text, sku text,
           product_title text, variant_title text, unit_cost text,
           currency_code text, source_updated_at timestamptz,
           observed_at timestamptz, sync_token uuid
         )
       )
       INSERT INTO shopify_variant_unit_costs (
         business_id, provider_account_id, product_id, variant_id,
         inventory_item_id, sku, product_title, variant_title, unit_cost,
         currency_code, source_updated_at, observed_at, sync_token, active,
         updated_at
       )
       SELECT business_id, provider_account_id, product_id, variant_id,
              inventory_item_id, sku, product_title, variant_title,
              unit_cost::numeric, currency_code, source_updated_at,
              observed_at, sync_token, true, now()
       FROM input_rows
       ON CONFLICT (business_id, provider_account_id, variant_id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         inventory_item_id = EXCLUDED.inventory_item_id,
         sku = EXCLUDED.sku,
         product_title = EXCLUDED.product_title,
         variant_title = EXCLUDED.variant_title,
         unit_cost = EXCLUDED.unit_cost,
         currency_code = EXCLUDED.currency_code,
         source_updated_at = EXCLUDED.source_updated_at,
         observed_at = EXCLUDED.observed_at,
         sync_token = EXCLUDED.sync_token,
         active = true,
         updated_at = now()`,
      [JSON.stringify(records)],
    );

    await sql.query(
      `INSERT INTO shopify_variant_unit_cost_history (
         business_id, provider_account_id, product_id, variant_id,
         inventory_item_id, sku, product_title, variant_title, unit_cost,
         currency_code, source_updated_at, observed_at, active, change_kind
       )
       SELECT business_id, provider_account_id, product_id, variant_id,
              inventory_item_id, sku, product_title, variant_title, unit_cost,
              currency_code, source_updated_at, $2::timestamptz, false, 'removed'
       FROM shopify_variant_unit_costs
       WHERE business_id = $1::uuid AND active = true AND sync_token <> $3::uuid`,
      [input.businessId, input.observedAt, syncToken],
    );

    await sql.query(
      `UPDATE shopify_variant_unit_costs
       SET active = false, observed_at = $2::timestamptz, updated_at = now()
       WHERE business_id = $1::uuid AND active = true AND sync_token <> $3::uuid`,
      [input.businessId, input.observedAt, syncToken],
    );
  });
}

export async function syncShopifyUnitCosts(businessId: string) {
  const integration = await getIntegration(businessId, "shopify").catch(() => null);
  const authority = integration ? readShopifyGrantAuthority(integration) : null;
  if (!integration || integration.status !== "connected" || !authority) {
    throw new ShopifyUnitCostSyncError("not_connected", "Shopify is not connected.");
  }
  const missingScopes = ["read_products", "read_inventory"].filter(
    (scope) => !hasShopifyScope(integration.scopes, scope),
  );
  if (missingScopes.length > 0) {
    throw new ShopifyUnitCostSyncError(
      "missing_scopes",
      `Shopify connection is missing ${missingScopes.join(", ")}.`,
    );
  }

  const observedAt = new Date().toISOString();
  const rows: ShopifyUnitCostRow[] = [];
  const identities = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let hasNextPage = false;

  while (pages < SHOPIFY_UNIT_COST_MAX_PAGES) {
    pages += 1;
    const payload: ShopifyUnitCostPayload = await shopifyAdminGraphql<ShopifyUnitCostPayload>({
      shopId: authority.shopDomain,
      accessToken: authority.accessToken,
      query: SHOPIFY_UNIT_COSTS_QUERY,
      variables: { cursor, pageSize: SHOPIFY_UNIT_COST_PAGE_SIZE },
    });
    const connection = payload.productVariants;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new ShopifyUnitCostSyncError(
        "invalid_provider_response",
        "Shopify returned an incomplete product-variant page.",
      );
    }
    for (const node of connection.nodes) {
      const row = mapNode(node, observedAt);
      if (!row) {
        throw new ShopifyUnitCostSyncError(
          "invalid_provider_response",
          "Shopify returned a variant without a usable product or inventory-item identity.",
        );
      }
      if (identities.has(row.variantId)) {
        throw new ShopifyUnitCostSyncError(
          "invalid_provider_response",
          `Shopify returned variant ${row.variantId} more than once.`,
        );
      }
      identities.add(row.variantId);
      rows.push(row);
    }

    hasNextPage = connection.pageInfo.hasNextPage === true;
    if (!hasNextPage) break;
    const nextCursor = normalizeText(connection.pageInfo.endCursor);
    if (!nextCursor || nextCursor === cursor) {
      throw new ShopifyUnitCostSyncError(
        "invalid_provider_response",
        "Shopify pagination did not provide a new cursor.",
      );
    }
    cursor = nextCursor;
  }

  if (pages === SHOPIFY_UNIT_COST_MAX_PAGES && hasNextPage) {
    throw new ShopifyUnitCostSyncError(
      "page_limit_exceeded",
      "Shopify product catalog exceeded the safe 25,000-variant sync limit; nothing was stored.",
    );
  }

  const stillAuthorized = await assertShopifyGrantUnchanged({ businessId, authority });
  if (!stillAuthorized.ok) {
    throw new ShopifyUnitCostSyncError("connection_changed", stillAuthorized.detail);
  }

  try {
    await persistSnapshot({
      businessId,
      shopDomain: authority.shopDomain,
      rows,
      observedAt,
    });
  } catch (error) {
    return asStorageUnavailable(error, SHOPIFY_UNIT_COST_WRITE_TABLES);
  }

  const costedVariants = rows.filter((row) => row.unitCost !== null).length;
  return {
    shopDomain: authority.shopDomain,
    pages,
    totalVariants: rows.length,
    costedVariants,
    missingCostVariants: rows.length - costedVariants,
    observedAt,
  };
}
