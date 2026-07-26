import { createHash } from "node:crypto";

import { getDb, runDbTransaction } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";
import type {
  ShopifyOrderTransactionWarehouseRow,
  ShopifyCustomerEventWarehouseRow,
  ShopifyOrderLineWarehouseRow,
  ShopifyOrderWarehouseRow,
  ShopifyRawSnapshotRecord,
  ShopifyRefundWarehouseRow,
  ShopifyRepairIntentRecord,
  ShopifyReconciliationRunRecord,
  ShopifyReturnWarehouseRow,
  ShopifySalesEventWarehouseRow,
  ShopifyServingStateRecord,
  ShopifyServingStateHistoryRecord,
  ShopifyServingOverrideRecord,
  ShopifyWebhookDeliveryRecord,
} from "@/lib/shopify/warehouse-types";

const SHOPIFY_WAREHOUSE_TABLES = [
  "shopify_raw_snapshots",
  "shopify_entity_payload_archives",
  "shopify_shop_dimensions",
  "shopify_customer_dimensions",
  "shopify_product_dimensions",
  "shopify_variant_dimensions",
  "shopify_orders",
  "shopify_order_lines",
  "shopify_refunds",
  "shopify_order_transactions",
  "shopify_returns",
  "shopify_sales_events",
  "shopify_serving_overrides",
  "shopify_webhook_deliveries",
  "shopify_repair_intents",
  "shopify_reconciliation_runs",
  "shopify_customer_events",
  "shopify_serving_state",
  "shopify_serving_state_history",
] as const;

async function assertShopifyWarehouseTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: [...SHOPIFY_WAREHOUSE_TABLES],
    context,
  });
}

type ShopifyCanonicalReferenceContext = Awaited<
  ReturnType<typeof resolveShopifyCanonicalReferenceContext>
>;
type ShopifySql = ReturnType<typeof getDb>;

interface ShopifyShopDimensionUpsertRow {
  business_id: string;
  business_ref_id: string | null;
  provider_account_id: string;
  provider_account_ref_id: string | null;
  shop_id: string;
  shop_domain: string | null;
  shop_currency_code: string | null;
  default_order_currency_code: string | null;
  projection_json: Record<string, unknown>;
  first_seen_at: string | null;
  last_seen_at: string | null;
  source_updated_at: string | null;
}

interface ShopifyCustomerDimensionUpsertRow {
  business_id: string;
  business_ref_id: string | null;
  provider_account_id: string;
  provider_account_ref_id: string | null;
  shop_id: string;
  customer_id: string;
  last_order_id: string | null;
  projection_json: Record<string, unknown>;
  first_seen_at: string | null;
  last_seen_at: string | null;
  source_updated_at: string | null;
}

interface ShopifyProductDimensionUpsertRow {
  business_id: string;
  business_ref_id: string | null;
  provider_account_id: string;
  provider_account_ref_id: string | null;
  shop_id: string;
  product_id: string;
  product_title: string | null;
  projection_json: Record<string, unknown>;
  first_seen_at: string | null;
  last_seen_at: string | null;
  source_updated_at: string | null;
}

interface ShopifyVariantDimensionUpsertRow {
  business_id: string;
  business_ref_id: string | null;
  provider_account_id: string;
  provider_account_ref_id: string | null;
  shop_id: string;
  product_id: string | null;
  variant_id: string;
  sku: string | null;
  product_title: string | null;
  variant_title: string | null;
  projection_json: Record<string, unknown>;
  first_seen_at: string | null;
  last_seen_at: string | null;
  source_updated_at: string | null;
}

type ShopifyPayloadArchiveEntityType =
  | "order"
  | "order_line"
  | "refund"
  | "transaction"
  | "return"
  | "sales_event"
  | "customer_event"
  | "webhook_delivery"
  | "repair_intent_state"
  | "sync_state_detail";

interface ShopifyPayloadArchiveUpsertRow {
  business_id: string;
  business_ref_id: string | null;
  provider_account_id: string;
  provider_account_ref_id: string | null;
  shop_id: string;
  entity_type: ShopifyPayloadArchiveEntityType;
  entity_id: string;
  parent_entity_id: string | null;
  payload_hash: string;
  payload_json: unknown;
  source_snapshot_id: string | null;
  source_updated_at: string | null;
}

function normalizeDate(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return text.slice(0, 10);
}

function normalizeTimestamp(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return text;
}

function normalizeText(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function stripNullFields(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value != null),
  );
}

function hasMeaningfulJsonPayload(value: unknown) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function buildShopifyPayloadArchiveHash(input: {
  businessId: string;
  providerAccountId: string;
  shopId: string;
  entityType: ShopifyPayloadArchiveEntityType;
  entityId: string;
  payloadJson: unknown;
}) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        shopId: input.shopId,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.payloadJson,
      }),
    )
    .digest("hex");
}

function buildShopifyWebhookDeliveryArchiveEntityId(input: {
  shopDomain: string;
  topic: string;
  payloadHash: string;
}) {
  return `${input.shopDomain}::${input.topic}::${input.payloadHash}`;
}

function buildShopifyRepairIntentStateArchiveEntityId(input: {
  repairIntentId: string;
}) {
  return input.repairIntentId;
}

function buildShopifySyncStateDetailArchiveEntityId(input: {
  syncTarget: string;
}) {
  return input.syncTarget;
}

function asArchivedObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickEarlierTimestamp(current: string | null, candidate: string | null) {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate < current ? candidate : current;
}

function pickLaterTimestamp(current: string | null, candidate: string | null) {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate > current ? candidate : current;
}

function shouldReplaceDimensionSnapshot(current: string | null, candidate: string | null) {
  if (!candidate) return false;
  if (!current) return true;
  return candidate >= current;
}

function normalizeServingProductionMode(value: unknown) {
  if (
    value === "disabled" ||
    value === "auto" ||
    value === "force_live" ||
    value === "force_warehouse"
  ) {
    return value;
  }
  return null;
}

function normalizeServingTrustState(value: unknown) {
  if (
    value === "trusted" ||
    value === "live_fallback" ||
    value === "pending_repair" ||
    value === "disabled" ||
    value === "no_data"
  ) {
    return value;
  }
  return null;
}

function normalizeServingCoverageStatus(value: unknown) {
  if (
    value === "recent_ready" ||
    value === "recent_only" ||
    value === "historical_incomplete" ||
    value === "unknown"
  ) {
    return value;
  }
  return null;
}

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chunkRows<T>(rows: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function dedupeRowsByKey<T>(rows: T[], buildKey: (row: T) => string) {
  const deduped = new Map<string, T>();
  for (const row of rows) {
    deduped.set(buildKey(row), row);
  }
  return Array.from(deduped.values());
}

async function resolveShopifyCanonicalReferenceContext(
  rows: Array<{
    businessId: string;
    providerAccountId: string;
    shopId?: string | null;
  }>,
) {
  return {
    businessRefIds: await resolveBusinessReferenceIds(rows.map((row) => row.businessId)),
    providerAccountRefIds: await ensureProviderAccountReferenceIds({
      provider: "shopify",
      accounts: rows.map((row) => ({
        externalAccountId: row.providerAccountId,
        accountName: row.shopId ?? null,
      })),
    }),
  };
}

async function resolveSingleShopifyCanonicalReferenceContext(input: {
  businessId: string;
  providerAccountId: string;
  shopId?: string | null;
}) {
  const context = await resolveShopifyCanonicalReferenceContext([input]);
  return {
    businessRefId: context.businessRefIds.get(input.businessId) ?? null,
    providerAccountRefId:
      context.providerAccountRefIds.get(input.providerAccountId) ?? null,
  };
}

async function resolveOptionalShopifyCanonicalReferenceContext(input: {
  businessId?: string | null;
  providerAccountId?: string | null;
  shopId?: string | null;
}) {
  const businessId = input.businessId ?? null;
  const providerAccountId = input.providerAccountId ?? null;
  const [businessRefIds, providerAccountRefIds] = await Promise.all([
    businessId ? resolveBusinessReferenceIds([businessId]) : Promise.resolve(new Map<string, string>()),
    providerAccountId
      ? ensureProviderAccountReferenceIds({
          provider: "shopify",
          accounts: [
            {
              externalAccountId: providerAccountId,
              accountName: input.shopId ?? null,
            },
          ],
        })
      : Promise.resolve(new Map<string, string>()),
  ]);
  return {
    businessRefId: businessId ? (businessRefIds.get(businessId) ?? null) : null,
    providerAccountRefId: providerAccountId
      ? (providerAccountRefIds.get(providerAccountId) ?? null)
      : null,
  };
}

function sanitizeRuntimeValidationSqlCommentValue(value: unknown, fallback = "na") {
  const text = String(value ?? "").trim();
  const cleaned = text.replace(/[^a-zA-Z0-9:_-]+/g, "_").slice(0, 80);
  return cleaned || fallback;
}

export function buildShopifyRawSnapshotHash(input: {
  businessId: string;
  providerAccountId: string;
  endpointName: string;
  startDate?: string | null;
  endDate?: string | null;
  payload: unknown;
}) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        endpointName: input.endpointName,
        startDate: normalizeDate(input.startDate),
        endDate: normalizeDate(input.endDate),
        payload: input.payload,
      })
    )
    .digest("hex");
}

/**
 * The canonical CONTENT identity of a Shopify raw snapshot.
 *
 * Deliberately the same construction as the Meta side: every scope field that
 * would otherwise collide, and nothing that describes the observation. Shopify
 * snapshots carry no partition/run/checkpoint, so what is excluded here is
 * status and the instant — both of which live on the receipt.
 */
export function buildShopifyRawSnapshotContentKey(input: {
  businessId: string;
  providerAccountId: string;
  endpointName: string;
  entityScope: string;
  startDate?: string | null;
  endDate?: string | null;
  payloadHash: string;
}): string {
  return [
    input.businessId,
    input.providerAccountId,
    input.endpointName,
    input.entityScope,
    normalizeDate(input.startDate) ?? "",
    normalizeDate(input.endDate) ?? "",
    input.payloadHash,
    // Unit separator: a byte that cannot occur in any of the joined fields, so
    // adjacent components can never be re-partitioned into a different tuple
    // that produces the same key.
  ].join(String.fromCharCode(0x1f));
}

/**
 * Two-layer write: one immutable canonical content row plus one append-only
 * observation receipt, in a single transaction.
 *
 * The canonical content id is what is returned, because every existing typed
 * `source_snapshot_id` FK points at `shopify_raw_snapshots(id)` and must keep
 * resolving unchanged.
 */
export async function insertShopifyRawSnapshot(input: ShopifyRawSnapshotRecord) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:insert_raw_snapshot");
  const refs = await resolveSingleShopifyCanonicalReferenceContext({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  });
  const contentKey = buildShopifyRawSnapshotContentKey({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    endpointName: input.endpointName,
    entityScope: input.entityScope,
    startDate: input.startDate,
    endDate: input.endDate,
    payloadHash: input.payloadHash,
  });
  const observedAt = normalizeTimestamp(input.fetchedAt);

  return runDbTransaction(async () => {
    const sql = getDb();
    const rows = (await sql`
      INSERT INTO shopify_raw_snapshots (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        endpoint_name,
        entity_scope,
        start_date,
        end_date,
        payload_json,
        payload_hash,
        content_key,
        request_context,
        response_headers,
        provider_http_status,
        status,
        fetched_at,
        first_observed_at,
        last_observed_at
      )
      VALUES (
        ${input.businessId},
        ${refs.businessRefId},
        ${input.providerAccountId},
        ${refs.providerAccountRefId},
        ${input.endpointName},
        ${input.entityScope},
        ${normalizeDate(input.startDate)},
        ${normalizeDate(input.endDate)},
        ${JSON.stringify(input.payloadJson ?? {})}::jsonb,
        ${input.payloadHash},
        ${contentKey},
        ${JSON.stringify(input.requestContext ?? {})}::jsonb,
        ${JSON.stringify(input.responseHeaders ?? {})}::jsonb,
        ${input.providerHttpStatus ?? null},
        -- First-observation mirror only. Lifecycle authority is the receipt.
        ${input.status},
        COALESCE(${observedAt}, now()),
        COALESCE(${observedAt}, now()),
        COALESCE(${observedAt}, now())
      )
      ON CONFLICT (content_key) WHERE content_key IS NOT NULL
      DO UPDATE SET
        -- Content is immutable: fetched_at, first_observed_at and payload_json
        -- are never touched, so the first-observation time survives.
        last_observed_at = GREATEST(
          shopify_raw_snapshots.last_observed_at,
          COALESCE(${observedAt}::timestamptz, now())
        ),
        observation_count = shopify_raw_snapshots.observation_count + 1,
        updated_at = now()
      RETURNING id
    `) as Array<{ id: string }>;
    const snapshotId = rows[0]?.id ?? null;
    if (!snapshotId) return null;

    await sql`
      INSERT INTO shopify_raw_snapshot_observations (
        snapshot_id,
        business_id,
        provider_account_id,
        endpoint_name,
        entity_scope,
        status,
        provider_http_status,
        request_context,
        response_headers,
        observed_at,
        first_observed_at,
        last_observed_at
      )
      VALUES (
        ${snapshotId}::uuid,
        ${input.businessId},
        ${input.providerAccountId},
        ${input.endpointName},
        ${input.entityScope},
        ${input.status},
        ${input.providerHttpStatus ?? null},
        ${JSON.stringify(input.requestContext ?? {})}::jsonb,
        ${JSON.stringify(input.responseHeaders ?? {})}::jsonb,
        COALESCE(${observedAt}, now()),
        COALESCE(${observedAt}, now()),
        COALESCE(${observedAt}, now())
      )
      ON CONFLICT (snapshot_id, status, observed_at)
      DO UPDATE SET
        last_observed_at = GREATEST(
          shopify_raw_snapshot_observations.last_observed_at,
          COALESCE(${observedAt}::timestamptz, now())
        ),
        observation_count = shopify_raw_snapshot_observations.observation_count + 1,
        updated_at = now()
    `;

    return snapshotId;
  });
}

async function upsertShopifyShopDimensions(
  rows: ShopifyOrderWarehouseRow[],
  referenceContext: ShopifyCanonicalReferenceContext,
  sql: ShopifySql,
) {
  const dimensionRows = new Map<string, ShopifyShopDimensionUpsertRow>();

  for (const row of rows) {
    const businessId = normalizeText(row.businessId);
    const providerAccountId = normalizeText(row.providerAccountId);
    const shopId = normalizeText(row.shopId);
    if (!businessId || !providerAccountId || !shopId) continue;

    const firstSeenAt = normalizeTimestamp(row.orderCreatedAt ?? row.orderUpdatedAt);
    const sourceUpdatedAt = normalizeTimestamp(row.orderUpdatedAt ?? row.orderCreatedAt);
    const key = `${businessId}::${providerAccountId}::${shopId}`;
    const nextRow: ShopifyShopDimensionUpsertRow = {
      business_id: businessId,
      business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
      provider_account_id: providerAccountId,
      provider_account_ref_id:
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
      shop_id: shopId,
      shop_domain: providerAccountId,
      shop_currency_code: normalizeText(row.shopCurrencyCode),
      default_order_currency_code: normalizeText(row.currencyCode),
      projection_json: {},
      first_seen_at: firstSeenAt,
      last_seen_at: sourceUpdatedAt,
      source_updated_at: sourceUpdatedAt,
    };
    const current = dimensionRows.get(key);
    if (!current) {
      dimensionRows.set(key, nextRow);
      continue;
    }

    current.business_ref_id ??= nextRow.business_ref_id;
    current.provider_account_ref_id ??= nextRow.provider_account_ref_id;
    current.first_seen_at = pickEarlierTimestamp(current.first_seen_at, nextRow.first_seen_at);
    current.last_seen_at = pickLaterTimestamp(current.last_seen_at, nextRow.last_seen_at);
    if (shouldReplaceDimensionSnapshot(current.source_updated_at, nextRow.source_updated_at)) {
      current.shop_domain = nextRow.shop_domain;
      current.shop_currency_code = nextRow.shop_currency_code;
      current.default_order_currency_code = nextRow.default_order_currency_code;
      current.projection_json = nextRow.projection_json;
      current.source_updated_at = nextRow.source_updated_at;
    } else {
      current.source_updated_at = pickLaterTimestamp(
        current.source_updated_at,
        nextRow.source_updated_at,
      );
    }
  }

  if (dimensionRows.size <= 0) return;

  await sql.query(
    `
      WITH input_rows AS (
        SELECT
          NULLIF(TRIM(record.business_id), '') AS business_id,
          record.business_ref_id AS business_ref_id,
          NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
          record.provider_account_ref_id AS provider_account_ref_id,
          NULLIF(TRIM(record.shop_id), '') AS shop_id,
          NULLIF(TRIM(record.shop_domain), '') AS shop_domain,
          NULLIF(TRIM(record.shop_currency_code), '') AS shop_currency_code,
          NULLIF(TRIM(record.default_order_currency_code), '') AS default_order_currency_code,
          COALESCE(record.projection_json, '{}'::jsonb) AS projection_json,
          record.first_seen_at AS first_seen_at,
          record.last_seen_at AS last_seen_at,
          record.source_updated_at AS source_updated_at
        FROM jsonb_to_recordset($1::jsonb) AS record(
          business_id text,
          business_ref_id uuid,
          provider_account_id text,
          provider_account_ref_id uuid,
          shop_id text,
          shop_domain text,
          shop_currency_code text,
          default_order_currency_code text,
          projection_json jsonb,
          first_seen_at timestamptz,
          last_seen_at timestamptz,
          source_updated_at timestamptz
        )
      )
      INSERT INTO shopify_shop_dimensions (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        shop_domain,
        shop_currency_code,
        default_order_currency_code,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        updated_at
      )
      SELECT
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        shop_domain,
        shop_currency_code,
        default_order_currency_code,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        now()
      FROM input_rows
      WHERE business_id IS NOT NULL
        AND provider_account_id IS NOT NULL
        AND shop_id IS NOT NULL
      ON CONFLICT (business_id, provider_account_id, shop_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_shop_dimensions.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_shop_dimensions.provider_account_ref_id),
        shop_domain = COALESCE(EXCLUDED.shop_domain, shopify_shop_dimensions.shop_domain),
        shop_currency_code = COALESCE(EXCLUDED.shop_currency_code, shopify_shop_dimensions.shop_currency_code),
        default_order_currency_code = COALESCE(EXCLUDED.default_order_currency_code, shopify_shop_dimensions.default_order_currency_code),
        projection_json = CASE
          WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_shop_dimensions.projection_json
          ELSE EXCLUDED.projection_json
        END,
        first_seen_at = COALESCE(shopify_shop_dimensions.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(COALESCE(shopify_shop_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
        source_updated_at = GREATEST(COALESCE(shopify_shop_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
        updated_at = now()
    `,
    [JSON.stringify(Array.from(dimensionRows.values()))],
  );
}

async function upsertShopifyCustomerDimensions(
  rows: ShopifyOrderWarehouseRow[],
  referenceContext: ShopifyCanonicalReferenceContext,
  sql: ShopifySql,
) {
  const dimensionRows = new Map<string, ShopifyCustomerDimensionUpsertRow>();

  for (const row of rows) {
    const businessId = normalizeText(row.businessId);
    const providerAccountId = normalizeText(row.providerAccountId);
    const shopId = normalizeText(row.shopId);
    const customerId = normalizeText(row.customerId);
    if (!businessId || !providerAccountId || !shopId || !customerId) continue;

    const firstSeenAt = normalizeTimestamp(row.orderCreatedAt ?? row.orderUpdatedAt);
    const sourceUpdatedAt = normalizeTimestamp(row.orderUpdatedAt ?? row.orderCreatedAt);
    const key = `${businessId}::${providerAccountId}::${shopId}::${customerId}`;
    const nextRow: ShopifyCustomerDimensionUpsertRow = {
      business_id: businessId,
      business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
      provider_account_id: providerAccountId,
      provider_account_ref_id:
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
      shop_id: shopId,
      customer_id: customerId,
      last_order_id: normalizeText(row.orderId),
      projection_json: {},
      first_seen_at: firstSeenAt,
      last_seen_at: sourceUpdatedAt,
      source_updated_at: sourceUpdatedAt,
    };
    const current = dimensionRows.get(key);
    if (!current) {
      dimensionRows.set(key, nextRow);
      continue;
    }

    current.business_ref_id ??= nextRow.business_ref_id;
    current.provider_account_ref_id ??= nextRow.provider_account_ref_id;
    current.first_seen_at = pickEarlierTimestamp(current.first_seen_at, nextRow.first_seen_at);
    current.last_seen_at = pickLaterTimestamp(current.last_seen_at, nextRow.last_seen_at);
    if (shouldReplaceDimensionSnapshot(current.source_updated_at, nextRow.source_updated_at)) {
      current.last_order_id = nextRow.last_order_id;
      current.projection_json = nextRow.projection_json;
      current.source_updated_at = nextRow.source_updated_at;
    } else {
      current.source_updated_at = pickLaterTimestamp(
        current.source_updated_at,
        nextRow.source_updated_at,
      );
    }
  }

  if (dimensionRows.size <= 0) return;

  await sql.query(
    `
      WITH input_rows AS (
        SELECT
          NULLIF(TRIM(record.business_id), '') AS business_id,
          record.business_ref_id AS business_ref_id,
          NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
          record.provider_account_ref_id AS provider_account_ref_id,
          NULLIF(TRIM(record.shop_id), '') AS shop_id,
          NULLIF(TRIM(record.customer_id), '') AS customer_id,
          NULLIF(TRIM(record.last_order_id), '') AS last_order_id,
          COALESCE(record.projection_json, '{}'::jsonb) AS projection_json,
          record.first_seen_at AS first_seen_at,
          record.last_seen_at AS last_seen_at,
          record.source_updated_at AS source_updated_at
        FROM jsonb_to_recordset($1::jsonb) AS record(
          business_id text,
          business_ref_id uuid,
          provider_account_id text,
          provider_account_ref_id uuid,
          shop_id text,
          customer_id text,
          last_order_id text,
          projection_json jsonb,
          first_seen_at timestamptz,
          last_seen_at timestamptz,
          source_updated_at timestamptz
        )
      )
      INSERT INTO shopify_customer_dimensions (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        customer_id,
        last_order_id,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        updated_at
      )
      SELECT
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        customer_id,
        last_order_id,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        now()
      FROM input_rows
      WHERE business_id IS NOT NULL
        AND provider_account_id IS NOT NULL
        AND shop_id IS NOT NULL
        AND customer_id IS NOT NULL
      ON CONFLICT (business_id, provider_account_id, shop_id, customer_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_customer_dimensions.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_customer_dimensions.provider_account_ref_id),
        last_order_id = COALESCE(EXCLUDED.last_order_id, shopify_customer_dimensions.last_order_id),
        projection_json = CASE
          WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_customer_dimensions.projection_json
          ELSE EXCLUDED.projection_json
        END,
        first_seen_at = COALESCE(shopify_customer_dimensions.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(COALESCE(shopify_customer_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
        source_updated_at = GREATEST(COALESCE(shopify_customer_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
        updated_at = now()
    `,
    [JSON.stringify(Array.from(dimensionRows.values()))],
  );
}

async function upsertShopifyProductDimensions(
  rows: ShopifyOrderLineWarehouseRow[],
  referenceContext: ShopifyCanonicalReferenceContext,
  sql: ShopifySql,
) {
  const dimensionRows = new Map<string, ShopifyProductDimensionUpsertRow>();

  for (const row of rows) {
    const businessId = normalizeText(row.businessId);
    const providerAccountId = normalizeText(row.providerAccountId);
    const shopId = normalizeText(row.shopId);
    const productId = normalizeText(row.productId);
    if (!businessId || !providerAccountId || !shopId || !productId) continue;

    const sourceUpdatedAt = normalizeTimestamp(row.observedAt);
    const key = `${businessId}::${providerAccountId}::${shopId}::${productId}`;
    const nextRow: ShopifyProductDimensionUpsertRow = {
      business_id: businessId,
      business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
      provider_account_id: providerAccountId,
      provider_account_ref_id:
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
      shop_id: shopId,
      product_id: productId,
      product_title: normalizeText(row.title),
      projection_json: stripNullFields({
        sku: normalizeText(row.sku) ?? undefined,
        lastVariantTitle: normalizeText(row.variantTitle) ?? undefined,
      }),
      first_seen_at: sourceUpdatedAt,
      last_seen_at: sourceUpdatedAt,
      source_updated_at: sourceUpdatedAt,
    };
    const current = dimensionRows.get(key);
    if (!current) {
      dimensionRows.set(key, nextRow);
      continue;
    }

    current.business_ref_id ??= nextRow.business_ref_id;
    current.provider_account_ref_id ??= nextRow.provider_account_ref_id;
    current.first_seen_at = pickEarlierTimestamp(current.first_seen_at, nextRow.first_seen_at);
    current.last_seen_at = pickLaterTimestamp(current.last_seen_at, nextRow.last_seen_at);
    if (shouldReplaceDimensionSnapshot(current.source_updated_at, nextRow.source_updated_at)) {
      current.product_title = nextRow.product_title;
      current.projection_json = nextRow.projection_json;
      current.source_updated_at = nextRow.source_updated_at;
    } else {
      current.source_updated_at = pickLaterTimestamp(
        current.source_updated_at,
        nextRow.source_updated_at,
      );
    }
  }

  if (dimensionRows.size <= 0) return;

  await sql.query(
    `
      WITH input_rows AS (
        SELECT
          NULLIF(TRIM(record.business_id), '') AS business_id,
          record.business_ref_id AS business_ref_id,
          NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
          record.provider_account_ref_id AS provider_account_ref_id,
          NULLIF(TRIM(record.shop_id), '') AS shop_id,
          NULLIF(TRIM(record.product_id), '') AS product_id,
          NULLIF(TRIM(record.product_title), '') AS product_title,
          COALESCE(record.projection_json, '{}'::jsonb) AS projection_json,
          record.first_seen_at AS first_seen_at,
          record.last_seen_at AS last_seen_at,
          record.source_updated_at AS source_updated_at
        FROM jsonb_to_recordset($1::jsonb) AS record(
          business_id text,
          business_ref_id uuid,
          provider_account_id text,
          provider_account_ref_id uuid,
          shop_id text,
          product_id text,
          product_title text,
          projection_json jsonb,
          first_seen_at timestamptz,
          last_seen_at timestamptz,
          source_updated_at timestamptz
        )
      )
      INSERT INTO shopify_product_dimensions (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        product_id,
        product_title,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        updated_at
      )
      SELECT
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        product_id,
        product_title,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        now()
      FROM input_rows
      WHERE business_id IS NOT NULL
        AND provider_account_id IS NOT NULL
        AND shop_id IS NOT NULL
        AND product_id IS NOT NULL
      ON CONFLICT (business_id, provider_account_id, shop_id, product_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_product_dimensions.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_product_dimensions.provider_account_ref_id),
        product_title = COALESCE(EXCLUDED.product_title, shopify_product_dimensions.product_title),
        projection_json = CASE
          WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_product_dimensions.projection_json
          ELSE EXCLUDED.projection_json
        END,
        first_seen_at = COALESCE(shopify_product_dimensions.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(COALESCE(shopify_product_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
        source_updated_at = GREATEST(COALESCE(shopify_product_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
        updated_at = now()
    `,
    [JSON.stringify(Array.from(dimensionRows.values()))],
  );
}

async function upsertShopifyVariantDimensions(
  rows: ShopifyOrderLineWarehouseRow[],
  referenceContext: ShopifyCanonicalReferenceContext,
  sql: ShopifySql,
) {
  const dimensionRows = new Map<string, ShopifyVariantDimensionUpsertRow>();

  for (const row of rows) {
    const businessId = normalizeText(row.businessId);
    const providerAccountId = normalizeText(row.providerAccountId);
    const shopId = normalizeText(row.shopId);
    const variantId = normalizeText(row.variantId);
    if (!businessId || !providerAccountId || !shopId || !variantId) continue;

    const sourceUpdatedAt = normalizeTimestamp(row.observedAt);
    const key = `${businessId}::${providerAccountId}::${shopId}::${variantId}`;
    const nextRow: ShopifyVariantDimensionUpsertRow = {
      business_id: businessId,
      business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
      provider_account_id: providerAccountId,
      provider_account_ref_id:
        referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
      shop_id: shopId,
      product_id: normalizeText(row.productId),
      variant_id: variantId,
      sku: normalizeText(row.sku),
      product_title: normalizeText(row.title),
      variant_title: normalizeText(row.variantTitle),
      projection_json: {},
      first_seen_at: sourceUpdatedAt,
      last_seen_at: sourceUpdatedAt,
      source_updated_at: sourceUpdatedAt,
    };
    const current = dimensionRows.get(key);
    if (!current) {
      dimensionRows.set(key, nextRow);
      continue;
    }

    current.business_ref_id ??= nextRow.business_ref_id;
    current.provider_account_ref_id ??= nextRow.provider_account_ref_id;
    current.first_seen_at = pickEarlierTimestamp(current.first_seen_at, nextRow.first_seen_at);
    current.last_seen_at = pickLaterTimestamp(current.last_seen_at, nextRow.last_seen_at);
    if (shouldReplaceDimensionSnapshot(current.source_updated_at, nextRow.source_updated_at)) {
      current.product_id = nextRow.product_id;
      current.sku = nextRow.sku;
      current.product_title = nextRow.product_title;
      current.variant_title = nextRow.variant_title;
      current.projection_json = nextRow.projection_json;
      current.source_updated_at = nextRow.source_updated_at;
    } else {
      current.source_updated_at = pickLaterTimestamp(
        current.source_updated_at,
        nextRow.source_updated_at,
      );
    }
  }

  if (dimensionRows.size <= 0) return;

  await sql.query(
    `
      WITH input_rows AS (
        SELECT
          NULLIF(TRIM(record.business_id), '') AS business_id,
          record.business_ref_id AS business_ref_id,
          NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
          record.provider_account_ref_id AS provider_account_ref_id,
          NULLIF(TRIM(record.shop_id), '') AS shop_id,
          NULLIF(TRIM(record.product_id), '') AS product_id,
          NULLIF(TRIM(record.variant_id), '') AS variant_id,
          NULLIF(TRIM(record.sku), '') AS sku,
          NULLIF(TRIM(record.product_title), '') AS product_title,
          NULLIF(TRIM(record.variant_title), '') AS variant_title,
          COALESCE(record.projection_json, '{}'::jsonb) AS projection_json,
          record.first_seen_at AS first_seen_at,
          record.last_seen_at AS last_seen_at,
          record.source_updated_at AS source_updated_at
        FROM jsonb_to_recordset($1::jsonb) AS record(
          business_id text,
          business_ref_id uuid,
          provider_account_id text,
          provider_account_ref_id uuid,
          shop_id text,
          product_id text,
          variant_id text,
          sku text,
          product_title text,
          variant_title text,
          projection_json jsonb,
          first_seen_at timestamptz,
          last_seen_at timestamptz,
          source_updated_at timestamptz
        )
      )
      INSERT INTO shopify_variant_dimensions (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        product_id,
        variant_id,
        sku,
        product_title,
        variant_title,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        updated_at
      )
      SELECT
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        product_id,
        variant_id,
        sku,
        product_title,
        variant_title,
        projection_json,
        first_seen_at,
        last_seen_at,
        source_updated_at,
        now()
      FROM input_rows
      WHERE business_id IS NOT NULL
        AND provider_account_id IS NOT NULL
        AND shop_id IS NOT NULL
        AND variant_id IS NOT NULL
      ON CONFLICT (business_id, provider_account_id, shop_id, variant_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_variant_dimensions.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_variant_dimensions.provider_account_ref_id),
        product_id = COALESCE(EXCLUDED.product_id, shopify_variant_dimensions.product_id),
        sku = COALESCE(EXCLUDED.sku, shopify_variant_dimensions.sku),
        product_title = COALESCE(EXCLUDED.product_title, shopify_variant_dimensions.product_title),
        variant_title = COALESCE(EXCLUDED.variant_title, shopify_variant_dimensions.variant_title),
        projection_json = CASE
          WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_variant_dimensions.projection_json
          ELSE EXCLUDED.projection_json
        END,
        first_seen_at = COALESCE(shopify_variant_dimensions.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_at = GREATEST(COALESCE(shopify_variant_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
        source_updated_at = GREATEST(COALESCE(shopify_variant_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
        updated_at = now()
    `,
    [JSON.stringify(Array.from(dimensionRows.values()))],
  );
}

async function upsertShopifyPayloadArchives(
  rows: ShopifyPayloadArchiveUpsertRow[],
  sql: ShopifySql,
) {
  if (rows.length <= 0) return;

  await sql.query(
    `
      WITH input_rows AS (
        SELECT
          NULLIF(TRIM(record.business_id), '') AS business_id,
          record.business_ref_id AS business_ref_id,
          NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
          record.provider_account_ref_id AS provider_account_ref_id,
          NULLIF(TRIM(record.shop_id), '') AS shop_id,
          NULLIF(TRIM(record.entity_type), '') AS entity_type,
          NULLIF(TRIM(record.entity_id), '') AS entity_id,
          NULLIF(TRIM(record.parent_entity_id), '') AS parent_entity_id,
          NULLIF(TRIM(record.payload_hash), '') AS payload_hash,
          COALESCE(record.payload_json, '{}'::jsonb) AS payload_json,
          record.source_snapshot_id AS source_snapshot_id,
          record.source_updated_at AS source_updated_at
        FROM jsonb_to_recordset($1::jsonb) AS record(
          business_id text,
          business_ref_id uuid,
          provider_account_id text,
          provider_account_ref_id uuid,
          shop_id text,
          entity_type text,
          entity_id text,
          parent_entity_id text,
          payload_hash text,
          payload_json jsonb,
          source_snapshot_id uuid,
          source_updated_at timestamptz
        )
      )
      INSERT INTO shopify_entity_payload_archives (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        entity_type,
        entity_id,
        parent_entity_id,
        payload_hash,
        payload_json,
        source_snapshot_id,
        source_updated_at,
        updated_at
      )
      SELECT
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        entity_type,
        entity_id,
        parent_entity_id,
        payload_hash,
        payload_json,
        source_snapshot_id,
        source_updated_at,
        now()
      FROM input_rows
      WHERE business_id IS NOT NULL
        AND provider_account_id IS NOT NULL
        AND shop_id IS NOT NULL
        AND entity_type IS NOT NULL
        AND entity_id IS NOT NULL
        AND payload_hash IS NOT NULL
      ON CONFLICT (business_id, provider_account_id, shop_id, entity_type, entity_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_entity_payload_archives.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_entity_payload_archives.provider_account_ref_id),
        parent_entity_id = COALESCE(EXCLUDED.parent_entity_id, shopify_entity_payload_archives.parent_entity_id),
        payload_hash = EXCLUDED.payload_hash,
        payload_json = EXCLUDED.payload_json,
        source_snapshot_id = COALESCE(EXCLUDED.source_snapshot_id, shopify_entity_payload_archives.source_snapshot_id),
        source_updated_at = GREATEST(COALESCE(shopify_entity_payload_archives.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
        updated_at = now()
    `,
    [JSON.stringify(rows)],
  );
}

async function listShopifyPayloadArchivesByEntityIds(input: {
  businessId: string;
  providerAccountId: string;
  shopId: string;
  entityType: ShopifyPayloadArchiveEntityType;
  entityIds: string[];
  sql?: ShopifySql;
}) {
  if (input.entityIds.length <= 0) {
    return new Map<string, Record<string, unknown>>();
  }
  const sql = input.sql ?? getDb();
  const rows = (await sql`
    SELECT entity_id, payload_json
    FROM shopify_entity_payload_archives
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND shop_id = ${input.shopId}
      AND entity_type = ${input.entityType}
      AND entity_id = ANY(${input.entityIds}::text[])
  `) as Array<Record<string, unknown>>;
  return new Map(
    rows
      .map((row) => {
        const entityId = normalizeText(row.entity_id);
        const payload = asArchivedObject(row.payload_json);
        return entityId && payload ? ([entityId, payload] as const) : null;
      })
      .filter((row): row is readonly [string, Record<string, unknown>] => row !== null),
  );
}

export async function upsertShopifyOrders(rows: ShopifyOrderWarehouseRow[]) {
  if (rows.length <= 0) return 0;
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_orders");
  const sql = getDb();
  let written = 0;
  const uniqueRows = dedupeRowsByKey(
    rows,
    (row) => `${row.businessId}::${row.providerAccountId}::${row.shopId}::${row.orderId}`,
  );

  for (const chunk of chunkRows(uniqueRows)) {
    const referenceContext = await resolveShopifyCanonicalReferenceContext(
      chunk.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        shopId: row.shopId,
      })),
    );
    await sql.query(
      `
        WITH input_rows AS (
          SELECT
            NULLIF(TRIM(record.business_id), '') AS business_id,
            record.business_ref_id AS business_ref_id,
            NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
            record.provider_account_ref_id AS provider_account_ref_id,
            NULLIF(TRIM(record.shop_id), '') AS shop_id,
            NULLIF(TRIM(record.order_id), '') AS order_id,
            NULLIF(TRIM(record.order_name), '') AS order_name,
            NULLIF(TRIM(record.customer_id), '') AS customer_id,
            NULLIF(TRIM(record.currency_code), '') AS currency_code,
            NULLIF(TRIM(record.shop_currency_code), '') AS shop_currency_code,
            record.order_created_at AS order_created_at,
            record.order_created_date_local AS order_created_date_local,
            record.order_updated_at AS order_updated_at,
            record.order_updated_date_local AS order_updated_date_local,
            record.order_processed_at AS order_processed_at,
            record.order_cancelled_at AS order_cancelled_at,
            record.order_closed_at AS order_closed_at,
            NULLIF(TRIM(record.financial_status), '') AS financial_status,
            NULLIF(TRIM(record.fulfillment_status), '') AS fulfillment_status,
            COALESCE(record.customer_journey_summary, '{}'::jsonb) AS customer_journey_summary,
            COALESCE(record.subtotal_price, 0) AS subtotal_price,
            COALESCE(record.total_discounts, 0) AS total_discounts,
            COALESCE(record.total_shipping, 0) AS total_shipping,
            COALESCE(record.total_tax, 0) AS total_tax,
            COALESCE(record.total_refunded, 0) AS total_refunded,
            COALESCE(record.total_price, 0) AS total_price,
            COALESCE(record.original_total_price, 0) AS original_total_price,
            COALESCE(record.current_total_price, 0) AS current_total_price,
            record.source_snapshot_id AS source_snapshot_id
          FROM jsonb_to_recordset($1::jsonb) AS record(
            business_id text,
            business_ref_id uuid,
            provider_account_id text,
            provider_account_ref_id uuid,
            shop_id text,
            order_id text,
            order_name text,
            customer_id text,
            currency_code text,
            shop_currency_code text,
            order_created_at timestamptz,
            order_created_date_local date,
            order_updated_at timestamptz,
            order_updated_date_local date,
            order_processed_at timestamptz,
            order_cancelled_at timestamptz,
            order_closed_at timestamptz,
            financial_status text,
            fulfillment_status text,
            customer_journey_summary jsonb,
            subtotal_price numeric,
            total_discounts numeric,
            total_shipping numeric,
            total_tax numeric,
            total_refunded numeric,
            total_price numeric,
            original_total_price numeric,
            current_total_price numeric,
            source_snapshot_id uuid
          )
        )
        INSERT INTO shopify_orders (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          order_id,
          order_name,
          customer_id,
          currency_code,
          shop_currency_code,
          order_created_at,
          order_created_date_local,
          order_updated_at,
          order_updated_date_local,
          order_processed_at,
          order_cancelled_at,
          order_closed_at,
          financial_status,
          fulfillment_status,
          customer_journey_summary,
          subtotal_price,
          total_discounts,
          total_shipping,
          total_tax,
          total_refunded,
          total_price,
          original_total_price,
          current_total_price,
          source_snapshot_id,
          updated_at
        )
        SELECT
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          order_id,
          order_name,
          customer_id,
          currency_code,
          shop_currency_code,
          order_created_at,
          order_created_date_local,
          order_updated_at,
          order_updated_date_local,
          order_processed_at,
          order_cancelled_at,
          order_closed_at,
          financial_status,
          fulfillment_status,
          customer_journey_summary,
          subtotal_price,
          total_discounts,
          total_shipping,
          total_tax,
          total_refunded,
          total_price,
          original_total_price,
          current_total_price,
          source_snapshot_id,
          now()
        FROM input_rows
        WHERE business_id IS NOT NULL
          AND provider_account_id IS NOT NULL
          AND shop_id IS NOT NULL
          AND order_id IS NOT NULL
        ON CONFLICT (business_id, provider_account_id, shop_id, order_id)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_orders.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_orders.provider_account_ref_id),
          order_name = EXCLUDED.order_name,
          customer_id = EXCLUDED.customer_id,
          currency_code = EXCLUDED.currency_code,
          shop_currency_code = EXCLUDED.shop_currency_code,
          order_created_at = EXCLUDED.order_created_at,
          order_created_date_local = EXCLUDED.order_created_date_local,
          order_updated_at = EXCLUDED.order_updated_at,
          order_updated_date_local = EXCLUDED.order_updated_date_local,
          order_processed_at = EXCLUDED.order_processed_at,
          order_cancelled_at = EXCLUDED.order_cancelled_at,
          order_closed_at = EXCLUDED.order_closed_at,
          financial_status = EXCLUDED.financial_status,
          fulfillment_status = EXCLUDED.fulfillment_status,
          customer_journey_summary = EXCLUDED.customer_journey_summary,
          subtotal_price = EXCLUDED.subtotal_price,
          total_discounts = EXCLUDED.total_discounts,
          total_shipping = EXCLUDED.total_shipping,
          total_tax = EXCLUDED.total_tax,
          total_refunded = EXCLUDED.total_refunded,
          total_price = EXCLUDED.total_price,
          original_total_price = EXCLUDED.original_total_price,
          current_total_price = EXCLUDED.current_total_price,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()
      `,
      [
        JSON.stringify(
          chunk.map((row) => ({
            business_id: row.businessId,
            business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
            provider_account_id: row.providerAccountId,
            provider_account_ref_id:
              referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
            shop_id: row.shopId,
            order_id: row.orderId,
            order_name: row.orderName ?? null,
            customer_id: row.customerId ?? null,
            currency_code: row.currencyCode ?? null,
            shop_currency_code: row.shopCurrencyCode ?? null,
            order_created_at: normalizeTimestamp(row.orderCreatedAt),
            order_created_date_local: normalizeDate(row.orderCreatedDateLocal),
            order_updated_at: normalizeTimestamp(row.orderUpdatedAt),
            order_updated_date_local: normalizeDate(row.orderUpdatedDateLocal),
            order_processed_at: normalizeTimestamp(row.orderProcessedAt),
            order_cancelled_at: normalizeTimestamp(row.orderCancelledAt),
            order_closed_at: normalizeTimestamp(row.orderClosedAt),
            financial_status: row.financialStatus ?? null,
            fulfillment_status: row.fulfillmentStatus ?? null,
            customer_journey_summary: row.customerJourneySummary ?? {},
            subtotal_price: toNumber(row.subtotalPrice),
            total_discounts: toNumber(row.totalDiscounts),
            total_shipping: toNumber(row.totalShipping),
            total_tax: toNumber(row.totalTax),
            total_refunded: toNumber(row.totalRefunded),
            total_price: toNumber(row.totalPrice),
            original_total_price: toNumber(row.originalTotalPrice),
            current_total_price: toNumber(row.currentTotalPrice),
            source_snapshot_id: row.sourceSnapshotId ?? null,
          })),
        ),
      ],
    );
    written += chunk.length;
    await upsertShopifyPayloadArchives(
      chunk.flatMap((row) => {
        if (!hasMeaningfulJsonPayload(row.payloadJson)) return [];
        return [
          {
            business_id: row.businessId,
            business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
            provider_account_id: row.providerAccountId,
            provider_account_ref_id:
              referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
            shop_id: row.shopId,
            entity_type: "order" as const,
            entity_id: row.orderId,
            parent_entity_id: null,
            payload_hash: buildShopifyPayloadArchiveHash({
              businessId: row.businessId,
              providerAccountId: row.providerAccountId,
              shopId: row.shopId,
              entityType: "order",
              entityId: row.orderId,
              payloadJson: row.payloadJson,
            }),
            payload_json: row.payloadJson ?? {},
            source_snapshot_id: row.sourceSnapshotId ?? null,
            source_updated_at: normalizeTimestamp(row.orderUpdatedAt ?? row.orderCreatedAt),
          },
        ];
      }),
      sql,
    );
    await upsertShopifyShopDimensions(chunk, referenceContext, sql);
    await upsertShopifyCustomerDimensions(chunk, referenceContext, sql);
  }

  return written;
}

export async function upsertShopifyOrderLines(rows: ShopifyOrderLineWarehouseRow[]) {
  if (rows.length <= 0) return 0;
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_order_lines");
  const sql = getDb();
  let written = 0;
  const uniqueRows = dedupeRowsByKey(
    rows,
    (row) =>
      `${row.businessId}::${row.providerAccountId}::${row.shopId}::${row.orderId}::${row.lineItemId}`,
  );

  for (const chunk of chunkRows(uniqueRows)) {
    const referenceContext = await resolveShopifyCanonicalReferenceContext(
      chunk.map((row) => ({
        businessId: row.businessId,
        providerAccountId: row.providerAccountId,
        shopId: row.shopId,
      })),
    );
    await sql.query(
      `
        WITH input_rows AS (
          SELECT
            NULLIF(TRIM(record.business_id), '') AS business_id,
            record.business_ref_id AS business_ref_id,
            NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
            record.provider_account_ref_id AS provider_account_ref_id,
            NULLIF(TRIM(record.shop_id), '') AS shop_id,
            NULLIF(TRIM(record.order_id), '') AS order_id,
            NULLIF(TRIM(record.line_item_id), '') AS line_item_id,
            NULLIF(TRIM(record.product_id), '') AS product_id,
            NULLIF(TRIM(record.variant_id), '') AS variant_id,
            NULLIF(TRIM(record.sku), '') AS sku,
            NULLIF(TRIM(record.title), '') AS title,
            NULLIF(TRIM(record.variant_title), '') AS variant_title,
            COALESCE(record.quantity, 0) AS quantity,
            COALESCE(record.discounted_total, 0) AS discounted_total,
            COALESCE(record.original_total, 0) AS original_total,
            COALESCE(record.tax_total, 0) AS tax_total,
            record.source_snapshot_id AS source_snapshot_id
          FROM jsonb_to_recordset($1::jsonb) AS record(
            business_id text,
            business_ref_id uuid,
            provider_account_id text,
            provider_account_ref_id uuid,
            shop_id text,
            order_id text,
            line_item_id text,
            product_id text,
            variant_id text,
            sku text,
            title text,
            variant_title text,
            quantity integer,
            discounted_total numeric,
            original_total numeric,
            tax_total numeric,
            source_snapshot_id uuid
          )
        )
        INSERT INTO shopify_order_lines (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          order_id,
          line_item_id,
          product_id,
          variant_id,
          sku,
          title,
          variant_title,
          quantity,
          discounted_total,
          original_total,
          tax_total,
          source_snapshot_id,
          updated_at
        )
        SELECT
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          order_id,
          line_item_id,
          product_id,
          variant_id,
          sku,
          title,
          variant_title,
          quantity,
          discounted_total,
          original_total,
          tax_total,
          source_snapshot_id,
          now()
        FROM input_rows
        WHERE business_id IS NOT NULL
          AND provider_account_id IS NOT NULL
          AND shop_id IS NOT NULL
          AND order_id IS NOT NULL
          AND line_item_id IS NOT NULL
        ON CONFLICT (business_id, provider_account_id, shop_id, order_id, line_item_id)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_order_lines.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_order_lines.provider_account_ref_id),
          product_id = EXCLUDED.product_id,
          variant_id = EXCLUDED.variant_id,
          sku = EXCLUDED.sku,
          title = EXCLUDED.title,
          variant_title = EXCLUDED.variant_title,
          quantity = EXCLUDED.quantity,
          discounted_total = EXCLUDED.discounted_total,
          original_total = EXCLUDED.original_total,
          tax_total = EXCLUDED.tax_total,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()
      `,
      [
        JSON.stringify(
          chunk.map((row) => ({
            business_id: row.businessId,
            business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
            provider_account_id: row.providerAccountId,
            provider_account_ref_id:
              referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
            shop_id: row.shopId,
            order_id: row.orderId,
            line_item_id: row.lineItemId,
            product_id: row.productId ?? null,
            variant_id: row.variantId ?? null,
            sku: row.sku ?? null,
            title: row.title ?? null,
            variant_title: row.variantTitle ?? null,
            quantity: Math.max(0, Math.trunc(row.quantity ?? 0)),
            discounted_total: toNumber(row.discountedTotal),
            original_total: toNumber(row.originalTotal),
            tax_total: toNumber(row.taxTotal),
            source_snapshot_id: row.sourceSnapshotId ?? null,
          })),
        ),
      ],
    );
    written += chunk.length;
    await upsertShopifyPayloadArchives(
      chunk.flatMap((row) => {
        if (!hasMeaningfulJsonPayload(row.payloadJson)) return [];
        return [
          {
            business_id: row.businessId,
            business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
            provider_account_id: row.providerAccountId,
            provider_account_ref_id:
              referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
            shop_id: row.shopId,
            entity_type: "order_line" as const,
            entity_id: row.lineItemId,
            parent_entity_id: row.orderId,
            payload_hash: buildShopifyPayloadArchiveHash({
              businessId: row.businessId,
              providerAccountId: row.providerAccountId,
              shopId: row.shopId,
              entityType: "order_line",
              entityId: row.lineItemId,
              payloadJson: row.payloadJson,
            }),
            payload_json: row.payloadJson ?? {},
            source_snapshot_id: row.sourceSnapshotId ?? null,
            source_updated_at: normalizeTimestamp(row.observedAt),
          },
        ];
      }),
      sql,
    );
    await upsertShopifyProductDimensions(chunk, referenceContext, sql);
    await upsertShopifyVariantDimensions(chunk, referenceContext, sql);
  }

  return written;
}

export async function upsertShopifyRefunds(rows: ShopifyRefundWarehouseRow[]) {
  if (rows.length <= 0) return 0;
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_refunds");
  const sql = getDb();
  const uniqueRows = dedupeRowsByKey(
    rows,
    (row) => `${row.businessId}::${row.providerAccountId}::${row.shopId}::${row.refundId}`,
  );
  const referenceContext = await resolveShopifyCanonicalReferenceContext(
    uniqueRows.map((row) => ({
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      shopId: row.shopId,
    })),
  );

  await sql.query(
    `
      WITH input_rows AS (
        SELECT
          NULLIF(TRIM(record.business_id), '') AS business_id,
          record.business_ref_id AS business_ref_id,
          NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
          record.provider_account_ref_id AS provider_account_ref_id,
          NULLIF(TRIM(record.shop_id), '') AS shop_id,
          NULLIF(TRIM(record.order_id), '') AS order_id,
          NULLIF(TRIM(record.refund_id), '') AS refund_id,
          record.refunded_at AS refunded_at,
          record.refunded_date_local AS refunded_date_local,
          COALESCE(record.refunded_sales, 0) AS refunded_sales,
          COALESCE(record.refunded_shipping, 0) AS refunded_shipping,
          COALESCE(record.refunded_taxes, 0) AS refunded_taxes,
          COALESCE(record.total_refunded, 0) AS total_refunded,
          record.source_snapshot_id AS source_snapshot_id
        FROM jsonb_to_recordset($1::jsonb) AS record(
          business_id text,
          business_ref_id uuid,
          provider_account_id text,
          provider_account_ref_id uuid,
          shop_id text,
          order_id text,
          refund_id text,
          refunded_at timestamptz,
          refunded_date_local date,
          refunded_sales numeric,
          refunded_shipping numeric,
          refunded_taxes numeric,
          total_refunded numeric,
          source_snapshot_id uuid
        )
      )
      INSERT INTO shopify_refunds (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        order_id,
        refund_id,
        refunded_at,
        refunded_date_local,
        refunded_sales,
        refunded_shipping,
        refunded_taxes,
        total_refunded,
        source_snapshot_id,
        updated_at
      )
      SELECT
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        order_id,
        refund_id,
        refunded_at,
        refunded_date_local,
        refunded_sales,
        refunded_shipping,
        refunded_taxes,
        total_refunded,
        source_snapshot_id,
        now()
      FROM input_rows
      WHERE business_id IS NOT NULL
        AND provider_account_id IS NOT NULL
        AND shop_id IS NOT NULL
        AND refund_id IS NOT NULL
      ON CONFLICT (business_id, provider_account_id, shop_id, refund_id)
      DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_refunds.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_refunds.provider_account_ref_id),
        order_id = EXCLUDED.order_id,
        refunded_at = EXCLUDED.refunded_at,
        refunded_date_local = EXCLUDED.refunded_date_local,
        refunded_sales = EXCLUDED.refunded_sales,
        refunded_shipping = EXCLUDED.refunded_shipping,
        refunded_taxes = EXCLUDED.refunded_taxes,
        total_refunded = EXCLUDED.total_refunded,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        updated_at = now()
    `,
    [
      JSON.stringify(
        uniqueRows.map((row) => ({
          business_id: row.businessId,
          business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
          provider_account_id: row.providerAccountId,
          provider_account_ref_id:
            referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          shop_id: row.shopId,
          order_id: row.orderId,
          refund_id: row.refundId,
          refunded_at: normalizeTimestamp(row.refundedAt),
          refunded_date_local: normalizeDate(row.refundedDateLocal),
          refunded_sales: toNumber(row.refundedSales),
          refunded_shipping: toNumber(row.refundedShipping),
          refunded_taxes: toNumber(row.refundedTaxes),
          total_refunded: toNumber(row.totalRefunded),
          source_snapshot_id: row.sourceSnapshotId ?? null,
        })),
      ),
    ],
  );

  await upsertShopifyPayloadArchives(
    uniqueRows.flatMap((row) => {
      if (!hasMeaningfulJsonPayload(row.payloadJson)) return [];
      return [
        {
          business_id: row.businessId,
          business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
          provider_account_id: row.providerAccountId,
          provider_account_ref_id:
            referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          shop_id: row.shopId,
          entity_type: "refund" as const,
          entity_id: row.refundId,
          parent_entity_id: row.orderId,
          payload_hash: buildShopifyPayloadArchiveHash({
            businessId: row.businessId,
            providerAccountId: row.providerAccountId,
            shopId: row.shopId,
            entityType: "refund",
            entityId: row.refundId,
            payloadJson: row.payloadJson,
          }),
          payload_json: row.payloadJson ?? {},
          source_snapshot_id: row.sourceSnapshotId ?? null,
          source_updated_at: normalizeTimestamp(row.refundedAt),
        },
      ];
    }),
    sql,
  );

  return uniqueRows.length;
}

export async function upsertShopifyOrderTransactions(
  rows: ShopifyOrderTransactionWarehouseRow[],
  input?: {
    runtimeValidation?: {
      runId: string;
      pageCount?: number;
      log?: (phase: string, summary?: Record<string, unknown>) => void;
    };
  }
) {
  if (rows.length <= 0) return 0;
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_order_transactions");
  const sql = getDb();
  const uniqueRows = dedupeRowsByKey(
    rows,
    (row) =>
      `${row.businessId}::${row.providerAccountId}::${row.shopId}::${row.transactionId}`,
  );
  let written = 0;
  const referenceContext = await resolveShopifyCanonicalReferenceContext(
    uniqueRows.map((row) => ({
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      shopId: row.shopId,
    })),
  );

  if (!input?.runtimeValidation) {
    await sql.query(
      `
        WITH input_rows AS (
          SELECT
            NULLIF(TRIM(record.business_id), '') AS business_id,
            record.business_ref_id AS business_ref_id,
            NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
            record.provider_account_ref_id AS provider_account_ref_id,
            NULLIF(TRIM(record.shop_id), '') AS shop_id,
            NULLIF(TRIM(record.order_id), '') AS order_id,
            NULLIF(TRIM(record.transaction_id), '') AS transaction_id,
            NULLIF(TRIM(record.kind), '') AS kind,
            NULLIF(TRIM(record.status), '') AS status,
            NULLIF(TRIM(record.gateway), '') AS gateway,
            record.processed_at AS processed_at,
            COALESCE(record.amount, 0) AS amount,
            NULLIF(TRIM(record.currency_code), '') AS currency_code,
            record.source_snapshot_id AS source_snapshot_id
          FROM jsonb_to_recordset($1::jsonb) AS record(
            business_id text,
            business_ref_id uuid,
            provider_account_id text,
            provider_account_ref_id uuid,
            shop_id text,
            order_id text,
            transaction_id text,
            kind text,
            status text,
            gateway text,
            processed_at timestamptz,
            amount numeric,
            currency_code text,
            source_snapshot_id uuid
          )
        )
        INSERT INTO shopify_order_transactions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          order_id,
          transaction_id,
          kind,
          status,
          gateway,
          processed_at,
          amount,
          currency_code,
          source_snapshot_id,
          updated_at
        )
        SELECT
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          order_id,
          transaction_id,
          kind,
          status,
          gateway,
          processed_at,
          amount,
          currency_code,
          source_snapshot_id,
          now()
        FROM input_rows
        WHERE business_id IS NOT NULL
          AND provider_account_id IS NOT NULL
          AND shop_id IS NOT NULL
          AND transaction_id IS NOT NULL
        ON CONFLICT (business_id, provider_account_id, shop_id, transaction_id)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_order_transactions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_order_transactions.provider_account_ref_id),
          order_id = EXCLUDED.order_id,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          gateway = EXCLUDED.gateway,
          processed_at = EXCLUDED.processed_at,
          amount = EXCLUDED.amount,
          currency_code = EXCLUDED.currency_code,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()
      `,
      [
        JSON.stringify(
          uniqueRows.map((row) => ({
            business_id: row.businessId,
            business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
            provider_account_id: row.providerAccountId,
            provider_account_ref_id:
              referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
            shop_id: row.shopId,
            order_id: row.orderId,
            transaction_id: row.transactionId,
            kind: row.kind ?? null,
            status: row.status ?? null,
            gateway: row.gateway ?? null,
            processed_at: normalizeTimestamp(row.processedAt),
            amount: toNumber(row.amount),
            currency_code: row.currencyCode ?? null,
            source_snapshot_id: row.sourceSnapshotId ?? null,
          })),
        ),
      ],
    );
    written = uniqueRows.length;
  }

  for (const [index, row] of input?.runtimeValidation ? uniqueRows.entries() : []) {
    const businessRefId =
      referenceContext.businessRefIds.get(row.businessId) ?? null;
    const providerAccountRefId =
      referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null;
    const summary = {
      pageCount: input?.runtimeValidation?.pageCount ?? null,
      rowIndex: index + 1,
      totalBatchSize: rows.length,
      transactionId: row.transactionId,
      orderId: row.orderId,
      kind: row.kind ?? null,
      status: row.status ?? null,
    } satisfies Record<string, unknown>;
    input?.runtimeValidation?.log?.("recent_orders_transactions_row_upsert_started", summary);

    const runtimeValidationComment = input?.runtimeValidation
      ? `/* shopify_rtval_transactions run_id=${sanitizeRuntimeValidationSqlCommentValue(
          input.runtimeValidation.runId,
        )} page=${sanitizeRuntimeValidationSqlCommentValue(
          input.runtimeValidation.pageCount ?? null,
        )} row=${sanitizeRuntimeValidationSqlCommentValue(
          index + 1,
        )} total=${sanitizeRuntimeValidationSqlCommentValue(rows.length)} transaction_id=${sanitizeRuntimeValidationSqlCommentValue(
          row.transactionId,
        )} order_id=${sanitizeRuntimeValidationSqlCommentValue(
          row.orderId,
        )} kind=${sanitizeRuntimeValidationSqlCommentValue(
          row.kind ?? null,
        )} status=${sanitizeRuntimeValidationSqlCommentValue(row.status ?? null)} */`
      : null;

    if (runtimeValidationComment) {
      await sql.query(
        `${runtimeValidationComment}
        INSERT INTO shopify_order_transactions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          order_id,
          transaction_id,
          kind,
          status,
          gateway,
          processed_at,
          amount,
          currency_code,
          source_snapshot_id,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, now()
        )
        ON CONFLICT (business_id, provider_account_id, shop_id, transaction_id)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_order_transactions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_order_transactions.provider_account_ref_id),
          order_id = EXCLUDED.order_id,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          gateway = EXCLUDED.gateway,
          processed_at = EXCLUDED.processed_at,
          amount = EXCLUDED.amount,
          currency_code = EXCLUDED.currency_code,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()`,
        [
          row.businessId,
          businessRefId,
          row.providerAccountId,
          providerAccountRefId,
          row.shopId,
          row.orderId,
          row.transactionId,
          row.kind ?? null,
          row.status ?? null,
          row.gateway ?? null,
          normalizeTimestamp(row.processedAt),
          toNumber(row.amount),
          row.currencyCode ?? null,
          row.sourceSnapshotId ?? null,
        ]
      );
    } else {
      await sql`
        INSERT INTO shopify_order_transactions (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          order_id,
          transaction_id,
          kind,
          status,
          gateway,
          processed_at,
          amount,
          currency_code,
          source_snapshot_id,
          updated_at
        )
        VALUES (
          ${row.businessId},
          ${businessRefId},
          ${row.providerAccountId},
          ${providerAccountRefId},
          ${row.shopId},
          ${row.orderId},
          ${row.transactionId},
          ${row.kind ?? null},
          ${row.status ?? null},
          ${row.gateway ?? null},
          ${normalizeTimestamp(row.processedAt)},
          ${toNumber(row.amount)},
          ${row.currencyCode ?? null},
          ${row.sourceSnapshotId ?? null},
          now()
        )
        ON CONFLICT (business_id, provider_account_id, shop_id, transaction_id)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_order_transactions.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_order_transactions.provider_account_ref_id),
          order_id = EXCLUDED.order_id,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          gateway = EXCLUDED.gateway,
          processed_at = EXCLUDED.processed_at,
          amount = EXCLUDED.amount,
          currency_code = EXCLUDED.currency_code,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()
      `;
    }
    input?.runtimeValidation?.log?.("recent_orders_transactions_row_upsert_succeeded", summary);
    written += 1;
  }

  await upsertShopifyPayloadArchives(
    uniqueRows.flatMap((row) => {
      if (!hasMeaningfulJsonPayload(row.payloadJson)) return [];
      return [
        {
          business_id: row.businessId,
          business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
          provider_account_id: row.providerAccountId,
          provider_account_ref_id:
            referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          shop_id: row.shopId,
          entity_type: "transaction" as const,
          entity_id: row.transactionId,
          parent_entity_id: row.orderId,
          payload_hash: buildShopifyPayloadArchiveHash({
            businessId: row.businessId,
            providerAccountId: row.providerAccountId,
            shopId: row.shopId,
            entityType: "transaction",
            entityId: row.transactionId,
            payloadJson: row.payloadJson,
          }),
          payload_json: row.payloadJson ?? {},
          source_snapshot_id: row.sourceSnapshotId ?? null,
          source_updated_at: normalizeTimestamp(row.processedAt),
        },
      ];
    }),
    sql,
  );

  return written;
}

export async function upsertShopifyReturns(rows: ShopifyReturnWarehouseRow[]) {
  if (rows.length <= 0) return 0;
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_returns");
  const sql = getDb();
  const uniqueRows = dedupeRowsByKey(
    rows,
    (row) => `${row.businessId}::${row.providerAccountId}::${row.shopId}::${row.returnId}`,
  );
  const referenceContext = await resolveShopifyCanonicalReferenceContext(
    uniqueRows.map((row) => ({
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      shopId: row.shopId,
    })),
  );

  await sql.query(
    `
      WITH input_rows AS (
        SELECT
          NULLIF(TRIM(record.business_id), '') AS business_id,
          record.business_ref_id AS business_ref_id,
          NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
          record.provider_account_ref_id AS provider_account_ref_id,
          NULLIF(TRIM(record.shop_id), '') AS shop_id,
          NULLIF(TRIM(record.order_id), '') AS order_id,
          NULLIF(TRIM(record.return_id), '') AS return_id,
          NULLIF(TRIM(record.status), '') AS status,
          record.created_at_provider AS created_at_provider,
          record.created_date_local AS created_date_local,
          record.updated_at_provider AS updated_at_provider,
          record.updated_date_local AS updated_date_local,
          record.source_snapshot_id AS source_snapshot_id
        FROM jsonb_to_recordset($1::jsonb) AS record(
          business_id text,
          business_ref_id uuid,
          provider_account_id text,
          provider_account_ref_id uuid,
          shop_id text,
          order_id text,
          return_id text,
          status text,
          created_at_provider timestamptz,
          created_date_local date,
          updated_at_provider timestamptz,
          updated_date_local date,
          source_snapshot_id uuid
        )
      )
      INSERT INTO shopify_returns (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        order_id,
        return_id,
        status,
        created_at_provider,
        created_date_local,
        updated_at_provider,
        updated_date_local,
        source_snapshot_id,
        updated_at
      )
      SELECT
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        order_id,
        return_id,
        status,
        created_at_provider,
        created_date_local,
        updated_at_provider,
        updated_date_local,
        source_snapshot_id,
        now()
      FROM input_rows
      WHERE business_id IS NOT NULL
        AND provider_account_id IS NOT NULL
        AND shop_id IS NOT NULL
        AND return_id IS NOT NULL
      ON CONFLICT (business_id, provider_account_id, shop_id, return_id)
      DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_returns.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_returns.provider_account_ref_id),
        order_id = EXCLUDED.order_id,
        status = EXCLUDED.status,
        created_at_provider = EXCLUDED.created_at_provider,
        created_date_local = EXCLUDED.created_date_local,
        updated_at_provider = EXCLUDED.updated_at_provider,
        updated_date_local = EXCLUDED.updated_date_local,
        source_snapshot_id = EXCLUDED.source_snapshot_id,
        updated_at = now()
    `,
    [
      JSON.stringify(
        uniqueRows.map((row) => ({
          business_id: row.businessId,
          business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
          provider_account_id: row.providerAccountId,
          provider_account_ref_id:
            referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          shop_id: row.shopId,
          order_id: row.orderId ?? null,
          return_id: row.returnId,
          status: row.status ?? null,
          created_at_provider: normalizeTimestamp(row.createdAt),
          created_date_local: normalizeDate(row.createdDateLocal),
          updated_at_provider: normalizeTimestamp(row.updatedAt),
          updated_date_local: normalizeDate(row.updatedDateLocal),
          source_snapshot_id: row.sourceSnapshotId ?? null,
        })),
      ),
    ],
  );

  await upsertShopifyPayloadArchives(
    uniqueRows.flatMap((row) => {
      if (!hasMeaningfulJsonPayload(row.payloadJson)) return [];
      return [
        {
          business_id: row.businessId,
          business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
          provider_account_id: row.providerAccountId,
          provider_account_ref_id:
            referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          shop_id: row.shopId,
          entity_type: "return" as const,
          entity_id: row.returnId,
          parent_entity_id: row.orderId ?? null,
          payload_hash: buildShopifyPayloadArchiveHash({
            businessId: row.businessId,
            providerAccountId: row.providerAccountId,
            shopId: row.shopId,
            entityType: "return",
            entityId: row.returnId,
            payloadJson: row.payloadJson,
          }),
          payload_json: row.payloadJson ?? {},
          source_snapshot_id: row.sourceSnapshotId ?? null,
          source_updated_at: normalizeTimestamp(row.updatedAt ?? row.createdAt),
        },
      ];
    }),
    sql,
  );

  return uniqueRows.length;
}

export async function upsertShopifySalesEvents(
  rows: ShopifySalesEventWarehouseRow[],
  input?: {
    runtimeValidation?: {
      runId: string;
      pageCount?: number;
      log?: (phase: string, summary?: Record<string, unknown>) => void;
    };
  }
) {
  if (rows.length <= 0) return 0;
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_sales_events");
  const sql = getDb();
  const uniqueRows = dedupeRowsByKey(
    rows,
    (row) => `${row.businessId}::${row.providerAccountId}::${row.shopId}::${row.eventId}`,
  );
  const referenceContext = await resolveShopifyCanonicalReferenceContext(
    uniqueRows.map((row) => ({
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      shopId: row.shopId,
    })),
  );
  let written = 0;

  if (!input?.runtimeValidation) {
    await sql.query(
      `
        WITH input_rows AS (
          SELECT
            NULLIF(TRIM(record.business_id), '') AS business_id,
            record.business_ref_id AS business_ref_id,
            NULLIF(TRIM(record.provider_account_id), '') AS provider_account_id,
            record.provider_account_ref_id AS provider_account_ref_id,
            NULLIF(TRIM(record.shop_id), '') AS shop_id,
            NULLIF(TRIM(record.event_id), '') AS event_id,
            NULLIF(TRIM(record.source_kind), '') AS source_kind,
            NULLIF(TRIM(record.source_id), '') AS source_id,
            NULLIF(TRIM(record.order_id), '') AS order_id,
            record.occurred_at AS occurred_at,
            record.occurred_date_local AS occurred_date_local,
            COALESCE(record.gross_sales, 0) AS gross_sales,
            COALESCE(record.refunded_sales, 0) AS refunded_sales,
            COALESCE(record.refunded_shipping, 0) AS refunded_shipping,
            COALESCE(record.refunded_taxes, 0) AS refunded_taxes,
            COALESCE(record.net_revenue, 0) AS net_revenue,
            NULLIF(TRIM(record.currency_code), '') AS currency_code,
            record.source_snapshot_id AS source_snapshot_id
          FROM jsonb_to_recordset($1::jsonb) AS record(
            business_id text,
            business_ref_id uuid,
            provider_account_id text,
            provider_account_ref_id uuid,
            shop_id text,
            event_id text,
            source_kind text,
            source_id text,
            order_id text,
            occurred_at timestamptz,
            occurred_date_local date,
            gross_sales numeric,
            refunded_sales numeric,
            refunded_shipping numeric,
            refunded_taxes numeric,
            net_revenue numeric,
            currency_code text,
            source_snapshot_id uuid
          )
        )
        INSERT INTO shopify_sales_events (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          event_id,
          source_kind,
          source_id,
          order_id,
          occurred_at,
          occurred_date_local,
          gross_sales,
          refunded_sales,
          refunded_shipping,
          refunded_taxes,
          net_revenue,
          currency_code,
          source_snapshot_id,
          updated_at
        )
        SELECT
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          event_id,
          source_kind,
          source_id,
          order_id,
          occurred_at,
          occurred_date_local,
          gross_sales,
          refunded_sales,
          refunded_shipping,
          refunded_taxes,
          net_revenue,
          currency_code,
          source_snapshot_id,
          now()
        FROM input_rows
        WHERE business_id IS NOT NULL
          AND provider_account_id IS NOT NULL
          AND shop_id IS NOT NULL
          AND event_id IS NOT NULL
        ON CONFLICT (business_id, provider_account_id, shop_id, event_id)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_sales_events.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_sales_events.provider_account_ref_id),
          source_kind = EXCLUDED.source_kind,
          source_id = EXCLUDED.source_id,
          order_id = EXCLUDED.order_id,
          occurred_at = EXCLUDED.occurred_at,
          occurred_date_local = EXCLUDED.occurred_date_local,
          gross_sales = EXCLUDED.gross_sales,
          refunded_sales = EXCLUDED.refunded_sales,
          refunded_shipping = EXCLUDED.refunded_shipping,
          refunded_taxes = EXCLUDED.refunded_taxes,
          net_revenue = EXCLUDED.net_revenue,
          currency_code = EXCLUDED.currency_code,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()
      `,
      [
        JSON.stringify(
          uniqueRows.map((row) => ({
            business_id: row.businessId,
            business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
            provider_account_id: row.providerAccountId,
            provider_account_ref_id:
              referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
            shop_id: row.shopId,
            event_id: row.eventId,
            source_kind: row.sourceKind,
            source_id: row.sourceId,
            order_id: row.orderId ?? null,
            occurred_at: normalizeTimestamp(row.occurredAt),
            occurred_date_local: normalizeDate(row.occurredDateLocal),
            gross_sales: toNumber(row.grossSales),
            refunded_sales: toNumber(row.refundedSales),
            refunded_shipping: toNumber(row.refundedShipping),
            refunded_taxes: toNumber(row.refundedTaxes),
            net_revenue: toNumber(row.netRevenue),
            currency_code: row.currencyCode ?? null,
            source_snapshot_id: row.sourceSnapshotId ?? null,
          })),
        ),
      ],
    );
    written = uniqueRows.length;
  }

  for (const [index, row] of input?.runtimeValidation ? uniqueRows.entries() : []) {
    const businessRefId =
      referenceContext.businessRefIds.get(row.businessId) ?? null;
    const providerAccountRefId =
      referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null;
    const summary = {
      pageCount: input?.runtimeValidation?.pageCount ?? null,
      rowIndex: index + 1,
      totalBatchSize: rows.length,
      eventId: row.eventId,
      sourceId: row.sourceId,
      sourceKind: row.sourceKind,
    } satisfies Record<string, unknown>;
    input?.runtimeValidation?.log?.("recent_orders_sales_events_row_upsert_started", summary);
    const runtimeValidationComment = input?.runtimeValidation
      ? `/* shopify_rtval_sales_events run_id=${sanitizeRuntimeValidationSqlCommentValue(
          input.runtimeValidation.runId,
        )} page=${sanitizeRuntimeValidationSqlCommentValue(
          input.runtimeValidation.pageCount ?? null,
        )} row=${sanitizeRuntimeValidationSqlCommentValue(
          index + 1,
        )} total=${sanitizeRuntimeValidationSqlCommentValue(rows.length)} event_id=${sanitizeRuntimeValidationSqlCommentValue(
          row.eventId,
        )} source_id=${sanitizeRuntimeValidationSqlCommentValue(
          row.sourceId,
        )} source_kind=${sanitizeRuntimeValidationSqlCommentValue(row.sourceKind)} */`
      : null;

    if (runtimeValidationComment) {
      await sql.query(
        `${runtimeValidationComment}
        INSERT INTO shopify_sales_events (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          event_id,
          source_kind,
          source_id,
          order_id,
          occurred_at,
          occurred_date_local,
          gross_sales,
          refunded_sales,
          refunded_shipping,
          refunded_taxes,
          net_revenue,
          currency_code,
          source_snapshot_id,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, now()
        )
        ON CONFLICT (business_id, provider_account_id, shop_id, event_id)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_sales_events.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_sales_events.provider_account_ref_id),
          source_kind = EXCLUDED.source_kind,
          source_id = EXCLUDED.source_id,
          order_id = EXCLUDED.order_id,
          occurred_at = EXCLUDED.occurred_at,
          occurred_date_local = EXCLUDED.occurred_date_local,
          gross_sales = EXCLUDED.gross_sales,
          refunded_sales = EXCLUDED.refunded_sales,
          refunded_shipping = EXCLUDED.refunded_shipping,
          refunded_taxes = EXCLUDED.refunded_taxes,
          net_revenue = EXCLUDED.net_revenue,
          currency_code = EXCLUDED.currency_code,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()`,
        [
          row.businessId,
          businessRefId,
          row.providerAccountId,
          providerAccountRefId,
          row.shopId,
          row.eventId,
          row.sourceKind,
          row.sourceId,
          row.orderId ?? null,
          normalizeTimestamp(row.occurredAt),
          normalizeDate(row.occurredDateLocal),
          toNumber(row.grossSales),
          toNumber(row.refundedSales),
          toNumber(row.refundedShipping),
          toNumber(row.refundedTaxes),
          toNumber(row.netRevenue),
          row.currencyCode ?? null,
          row.sourceSnapshotId ?? null,
        ]
      );
    } else {
      await sql`
        INSERT INTO shopify_sales_events (
          business_id,
          business_ref_id,
          provider_account_id,
          provider_account_ref_id,
          shop_id,
          event_id,
          source_kind,
          source_id,
          order_id,
          occurred_at,
          occurred_date_local,
          gross_sales,
          refunded_sales,
          refunded_shipping,
          refunded_taxes,
          net_revenue,
          currency_code,
          source_snapshot_id,
          updated_at
        )
        VALUES (
          ${row.businessId},
          ${businessRefId},
          ${row.providerAccountId},
          ${providerAccountRefId},
          ${row.shopId},
          ${row.eventId},
          ${row.sourceKind},
          ${row.sourceId},
          ${row.orderId ?? null},
          ${normalizeTimestamp(row.occurredAt)},
          ${normalizeDate(row.occurredDateLocal)},
          ${toNumber(row.grossSales)},
          ${toNumber(row.refundedSales)},
          ${toNumber(row.refundedShipping)},
          ${toNumber(row.refundedTaxes)},
          ${toNumber(row.netRevenue)},
          ${row.currencyCode ?? null},
          ${row.sourceSnapshotId ?? null},
          now()
        )
        ON CONFLICT (business_id, provider_account_id, shop_id, event_id)
        DO UPDATE SET
          business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_sales_events.business_ref_id),
          provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_sales_events.provider_account_ref_id),
          source_kind = EXCLUDED.source_kind,
          source_id = EXCLUDED.source_id,
          order_id = EXCLUDED.order_id,
          occurred_at = EXCLUDED.occurred_at,
          occurred_date_local = EXCLUDED.occurred_date_local,
          gross_sales = EXCLUDED.gross_sales,
          refunded_sales = EXCLUDED.refunded_sales,
          refunded_shipping = EXCLUDED.refunded_shipping,
          refunded_taxes = EXCLUDED.refunded_taxes,
          net_revenue = EXCLUDED.net_revenue,
          currency_code = EXCLUDED.currency_code,
          source_snapshot_id = EXCLUDED.source_snapshot_id,
          updated_at = now()
      `;
    }
    input?.runtimeValidation?.log?.("recent_orders_sales_events_row_upsert_succeeded", summary);
    written += 1;
  }

  await upsertShopifyPayloadArchives(
    uniqueRows.flatMap((row) => {
      if (!hasMeaningfulJsonPayload(row.payloadJson)) return [];
      return [
        {
          business_id: row.businessId,
          business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
          provider_account_id: row.providerAccountId,
          provider_account_ref_id:
            referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          shop_id: row.shopId,
          entity_type: "sales_event" as const,
          entity_id: row.eventId,
          parent_entity_id: row.orderId ?? row.sourceId,
          payload_hash: buildShopifyPayloadArchiveHash({
            businessId: row.businessId,
            providerAccountId: row.providerAccountId,
            shopId: row.shopId,
            entityType: "sales_event",
            entityId: row.eventId,
            payloadJson: row.payloadJson,
          }),
          payload_json: row.payloadJson ?? {},
          source_snapshot_id: row.sourceSnapshotId ?? null,
          source_updated_at: normalizeTimestamp(row.occurredAt),
        },
      ];
    }),
    sql,
  );

  return written;
}

export async function getShopifyServingOverride(input: {
  businessId: string;
  providerAccountId: string;
  overrideKey: string;
}) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:get_serving_override");
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM shopify_serving_overrides
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND override_key = ${input.overrideKey}
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    overrideKey: String(row.override_key),
    startDate: normalizeDate(row.start_date),
    endDate: normalizeDate(row.end_date),
    mode: String(row.mode) as ShopifyServingOverrideRecord["mode"],
    reason: row.reason ? String(row.reason) : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    updatedAt: normalizeTimestamp(row.updated_at),
  } satisfies ShopifyServingOverrideRecord;
}

export async function upsertShopifyServingOverride(input: ShopifyServingOverrideRecord) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_serving_override");
  const sql = getDb();
  const refs = await resolveSingleShopifyCanonicalReferenceContext(input);
  await sql`
    INSERT INTO shopify_serving_overrides (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      override_key,
      start_date,
      end_date,
      mode,
      reason,
      updated_by,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${input.overrideKey},
      ${normalizeDate(input.startDate)},
      ${normalizeDate(input.endDate)},
      ${input.mode},
      ${input.reason ?? null},
      ${input.updatedBy ?? null},
      now()
    )
    ON CONFLICT (business_id, provider_account_id, override_key)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_serving_overrides.business_ref_id),
      provider_account_ref_id = COALESCE(
        EXCLUDED.provider_account_ref_id,
        shopify_serving_overrides.provider_account_ref_id
      ),
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      mode = EXCLUDED.mode,
      reason = EXCLUDED.reason,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `;
}

export async function upsertShopifyWebhookDelivery(input: ShopifyWebhookDeliveryRecord) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_webhook_delivery");
  const sql = getDb();
  const refs = await resolveOptionalShopifyCanonicalReferenceContext(input);
  const rows = (await sql`
    INSERT INTO shopify_webhook_deliveries (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      topic,
      shop_domain,
      webhook_id,
      payload_hash,
      received_at,
      processed_at,
      processing_state,
      error_message,
      updated_at
    )
    VALUES (
      ${input.businessId ?? null},
      ${refs.businessRefId},
      ${input.providerAccountId ?? null},
      ${refs.providerAccountRefId},
      ${input.topic},
      ${input.shopDomain},
      ${input.webhookId ?? null},
      ${String(input.payloadHash)},
      COALESCE(${normalizeTimestamp(input.receivedAt)}, now()),
      ${normalizeTimestamp(input.processedAt)},
      ${input.processingState},
      ${input.errorMessage ?? null},
      now()
    )
    ON CONFLICT (shop_domain, topic, payload_hash)
    DO UPDATE SET
      business_id = COALESCE(EXCLUDED.business_id, shopify_webhook_deliveries.business_id),
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_webhook_deliveries.business_ref_id),
      provider_account_id = COALESCE(EXCLUDED.provider_account_id, shopify_webhook_deliveries.provider_account_id),
      provider_account_ref_id = COALESCE(
        EXCLUDED.provider_account_ref_id,
        shopify_webhook_deliveries.provider_account_ref_id
      ),
      webhook_id = COALESCE(EXCLUDED.webhook_id, shopify_webhook_deliveries.webhook_id),
      processed_at = COALESCE(EXCLUDED.processed_at, shopify_webhook_deliveries.processed_at),
      processing_state = EXCLUDED.processing_state,
      error_message = EXCLUDED.error_message,
      updated_at = now()
    RETURNING business_id, provider_account_id, shop_domain, topic, payload_hash, webhook_id
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  const archivedPayload = stripNullFields({
    payload: hasMeaningfulJsonPayload(input.payloadJson) ? input.payloadJson : null,
    resultSummary:
      input.resultSummary && typeof input.resultSummary === "object"
        ? input.resultSummary
        : null,
  });
  if (
    row?.business_id &&
    row?.provider_account_id &&
    Object.keys(archivedPayload).length > 0
  ) {
    await upsertShopifyPayloadArchives(
      [
        {
          business_id: String(row.business_id),
          business_ref_id: refs.businessRefId,
          provider_account_id: String(row.provider_account_id),
          provider_account_ref_id: refs.providerAccountRefId,
          shop_id: String(row.provider_account_id),
          entity_type: "webhook_delivery",
          entity_id: buildShopifyWebhookDeliveryArchiveEntityId({
            shopDomain: String(row.shop_domain),
            topic: String(row.topic),
            payloadHash: String(row.payload_hash),
          }),
          parent_entity_id: row.webhook_id ? String(row.webhook_id) : null,
          payload_hash: String(input.payloadHash),
          payload_json: archivedPayload,
          source_snapshot_id: null,
          source_updated_at:
            normalizeTimestamp(input.processedAt) ??
            normalizeTimestamp(input.receivedAt),
        },
      ],
      sql,
    );
  }
}

export async function upsertShopifyRepairIntent(input: ShopifyRepairIntentRecord) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_repair_intent");
  const sql = getDb();
  const refs = await resolveSingleShopifyCanonicalReferenceContext(input);
  const rows = (await sql`
    INSERT INTO shopify_repair_intents (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      entity_type,
      entity_id,
      topic,
      payload_hash,
      event_timestamp,
      event_age_days,
      escalation_level,
      status,
      attempt_count,
      last_error,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${input.entityType},
      ${input.entityId},
      ${input.topic},
      ${input.payloadHash},
      ${normalizeTimestamp(input.eventTimestamp)},
      ${input.eventAgeDays ?? null},
      ${Math.max(0, Math.trunc(input.escalationLevel ?? 0))},
      ${input.status},
      ${Math.max(0, Math.trunc(input.attemptCount ?? 0))},
      ${input.lastError ?? null},
      now()
    )
    ON CONFLICT (business_id, provider_account_id, entity_type, entity_id, topic, payload_hash)
    DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_repair_intents.business_ref_id),
      provider_account_ref_id = COALESCE(
        EXCLUDED.provider_account_ref_id,
        shopify_repair_intents.provider_account_ref_id
      ),
      event_timestamp = COALESCE(EXCLUDED.event_timestamp, shopify_repair_intents.event_timestamp),
      event_age_days = COALESCE(EXCLUDED.event_age_days, shopify_repair_intents.event_age_days),
      escalation_level = GREATEST(shopify_repair_intents.escalation_level, EXCLUDED.escalation_level),
      status = EXCLUDED.status,
      attempt_count = EXCLUDED.attempt_count,
      last_error = EXCLUDED.last_error,
      updated_at = now()
    RETURNING *
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (
    row?.id &&
    input.lastSyncResult &&
    typeof input.lastSyncResult === "object"
  ) {
    await upsertShopifyPayloadArchives(
      [
        {
          business_id: String(row.business_id),
          business_ref_id: refs.businessRefId,
          provider_account_id: String(row.provider_account_id),
          provider_account_ref_id: refs.providerAccountRefId,
          shop_id: String(row.provider_account_id),
          entity_type: "repair_intent_state",
          entity_id: buildShopifyRepairIntentStateArchiveEntityId({
            repairIntentId: String(row.id),
          }),
          parent_entity_id: String(row.entity_id),
          payload_hash: String(row.payload_hash),
          payload_json: {
            lastSyncResult: input.lastSyncResult,
          },
          source_snapshot_id: null,
          source_updated_at: normalizeTimestamp(row.updated_at),
        },
      ],
      sql,
    );
  }
  return row
    ? ({
        id: String(row.id),
        businessId: String(row.business_id),
        providerAccountId: String(row.provider_account_id),
        entityType: row.entity_type as ShopifyRepairIntentRecord["entityType"],
        entityId: String(row.entity_id),
        topic: String(row.topic),
        payloadHash: String(row.payload_hash),
        eventTimestamp: normalizeTimestamp(row.event_timestamp),
        eventAgeDays: row.event_age_days == null ? null : Number(row.event_age_days),
        escalationLevel: Number(row.escalation_level ?? 0),
        status: row.status as ShopifyRepairIntentRecord["status"],
        attemptCount: Number(row.attempt_count ?? 0),
        lastError: row.last_error ? String(row.last_error) : null,
        lastSyncResult:
          input.lastSyncResult && typeof input.lastSyncResult === "object"
            ? input.lastSyncResult
            : null,
        createdAt: normalizeTimestamp(row.created_at),
        updatedAt: normalizeTimestamp(row.updated_at),
      } satisfies ShopifyRepairIntentRecord)
    : null;
}

export async function listShopifyRepairIntents(input: {
  businessId: string;
  providerAccountId: string;
  limit?: number;
}) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:list_repair_intents");
  const sql = getDb();
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 10)));
  const rows = (await sql`
    SELECT *
    FROM shopify_repair_intents
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  const archivePayloads = await listShopifyPayloadArchivesByEntityIds({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    shopId: input.providerAccountId,
    entityType: "repair_intent_state",
    entityIds: rows.map((row) => String(row.id)),
    sql,
  });
  return rows.map((row) => ({
    id: String(row.id),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    entityType: row.entity_type as ShopifyRepairIntentRecord["entityType"],
    entityId: String(row.entity_id),
    topic: String(row.topic),
    payloadHash: String(row.payload_hash),
    eventTimestamp: normalizeTimestamp(row.event_timestamp),
    eventAgeDays: row.event_age_days == null ? null : Number(row.event_age_days),
    escalationLevel: Number(row.escalation_level ?? 0),
    status: row.status as ShopifyRepairIntentRecord["status"],
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: row.last_error ? String(row.last_error) : null,
    lastSyncResult:
      asArchivedObject(
        archivePayloads.get(
          buildShopifyRepairIntentStateArchiveEntityId({
            repairIntentId: String(row.id),
          }),
        )?.lastSyncResult,
      ) ?? null,
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
  })) satisfies ShopifyRepairIntentRecord[];
}

export async function getShopifyWebhookDelivery(input: {
  shopDomain: string;
  topic: string;
  payloadHash: string;
}) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:get_webhook_delivery");
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM shopify_webhook_deliveries
    WHERE shop_domain = ${input.shopDomain}
      AND topic = ${input.topic}
      AND payload_hash = ${input.payloadHash}
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const archivePayloads =
    row.business_id && row.provider_account_id
      ? await listShopifyPayloadArchivesByEntityIds({
          businessId: String(row.business_id),
          providerAccountId: String(row.provider_account_id),
          shopId: String(row.provider_account_id),
          entityType: "webhook_delivery",
          entityIds: [
            buildShopifyWebhookDeliveryArchiveEntityId({
              shopDomain: String(row.shop_domain),
              topic: String(row.topic),
              payloadHash: String(row.payload_hash),
            }),
          ],
          sql,
        })
      : new Map<string, Record<string, unknown>>();
  const archivedPayload = archivePayloads.get(
    buildShopifyWebhookDeliveryArchiveEntityId({
      shopDomain: String(row.shop_domain),
      topic: String(row.topic),
      payloadHash: String(row.payload_hash),
    }),
  );
  return {
    businessId: row.business_id ? String(row.business_id) : null,
    providerAccountId: row.provider_account_id ? String(row.provider_account_id) : null,
    topic: String(row.topic),
    shopDomain: String(row.shop_domain),
    webhookId: row.webhook_id ? String(row.webhook_id) : null,
    payloadHash: String(row.payload_hash),
    payloadJson:
      archivedPayload?.payload && typeof archivedPayload.payload === "object"
        ? archivedPayload.payload
        : {},
    receivedAt: normalizeTimestamp(row.received_at),
    processedAt: normalizeTimestamp(row.processed_at),
    processingState: String(row.processing_state) as ShopifyWebhookDeliveryRecord["processingState"],
    resultSummary:
      archivedPayload?.resultSummary && typeof archivedPayload.resultSummary === "object"
        ? (archivedPayload.resultSummary as Record<string, unknown>)
        : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  } satisfies ShopifyWebhookDeliveryRecord;
}

export async function listShopifyWebhookDeliveries(input: {
  businessId: string;
  providerAccountId?: string | null;
  limit?: number;
}) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:list_webhook_deliveries");
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM shopify_webhook_deliveries
    WHERE business_id = ${input.businessId}
      AND (${input.providerAccountId ?? null}::text IS NULL OR provider_account_id = ${input.providerAccountId ?? null})
    ORDER BY COALESCE(processed_at, received_at) DESC
    LIMIT ${Math.max(1, Math.min(input.limit ?? 10, 50))}
  `) as Array<Record<string, unknown>>;
  const archivePayloads = new Map<string, Record<string, unknown>>();
  const entityIdsByProvider = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.business_id || !row.provider_account_id) continue;
    const providerAccountId = String(row.provider_account_id);
    const entityId = buildShopifyWebhookDeliveryArchiveEntityId({
      shopDomain: String(row.shop_domain),
      topic: String(row.topic),
      payloadHash: String(row.payload_hash),
    });
    const existing = entityIdsByProvider.get(providerAccountId) ?? [];
    existing.push(entityId);
    entityIdsByProvider.set(providerAccountId, existing);
  }
  for (const [providerAccountId, entityIds] of entityIdsByProvider.entries()) {
    const providerArchives = await listShopifyPayloadArchivesByEntityIds({
      businessId: input.businessId,
      providerAccountId,
      shopId: providerAccountId,
      entityType: "webhook_delivery",
      entityIds,
      sql,
    });
    for (const [entityId, payload] of providerArchives.entries()) {
      archivePayloads.set(`${providerAccountId}::${entityId}`, payload);
    }
  }

  return rows.map((row) => ({
    businessId: row.business_id ? String(row.business_id) : null,
    providerAccountId: row.provider_account_id ? String(row.provider_account_id) : null,
    topic: String(row.topic),
    shopDomain: String(row.shop_domain),
    webhookId: row.webhook_id ? String(row.webhook_id) : null,
    payloadHash: String(row.payload_hash),
    payloadJson:
      archivePayloads.get(
        `${row.provider_account_id ? String(row.provider_account_id) : ""}::${buildShopifyWebhookDeliveryArchiveEntityId({
          shopDomain: String(row.shop_domain),
          topic: String(row.topic),
          payloadHash: String(row.payload_hash),
        })}`,
      )?.payload ??
      null,
    receivedAt: normalizeTimestamp(row.received_at),
    processedAt: normalizeTimestamp(row.processed_at),
    processingState: String(row.processing_state) as ShopifyWebhookDeliveryRecord["processingState"],
    resultSummary:
      asArchivedObject(
        archivePayloads.get(
          `${row.provider_account_id ? String(row.provider_account_id) : ""}::${buildShopifyWebhookDeliveryArchiveEntityId({
            shopDomain: String(row.shop_domain),
            topic: String(row.topic),
            payloadHash: String(row.payload_hash),
          })}`,
        )?.resultSummary,
      ) ?? null,
    errorMessage: row.error_message ? String(row.error_message) : null,
  })) satisfies ShopifyWebhookDeliveryRecord[];
}

export async function listShopifyReconciliationRuns(input: {
  businessId: string;
  providerAccountId: string;
  reconciliationKey?: string;
  startDate?: string | null;
  endDate?: string | null;
  limit?: number;
}) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:list_reconciliation_runs");
  const sql = getDb();
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 10)));
  const rows = (await sql`
    SELECT *
    FROM shopify_reconciliation_runs
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND (${input.reconciliationKey ?? null}::text IS NULL OR reconciliation_key = ${input.reconciliationKey ?? null})
      AND (${normalizeDate(input.startDate) ?? null}::date IS NULL OR start_date = ${normalizeDate(input.startDate) ?? null})
      AND (${normalizeDate(input.endDate) ?? null}::date IS NULL OR end_date = ${normalizeDate(input.endDate) ?? null})
    ORDER BY recorded_at DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    reconciliationKey: String(row.reconciliation_key),
    startDate: normalizeDate(row.start_date),
    endDate: normalizeDate(row.end_date),
    preferredSource: row.preferred_source ? String(row.preferred_source) : null,
    canServeWarehouse: Boolean(row.can_serve_warehouse),
    selectedRevenueTruthBasis: row.selected_revenue_truth_basis
      ? String(row.selected_revenue_truth_basis)
      : null,
    basisSelectionReason: row.basis_selection_reason ? String(row.basis_selection_reason) : null,
    transactionCoverageOrderRate:
      row.transaction_coverage_order_rate == null ? null : Number(row.transaction_coverage_order_rate),
    transactionCoverageAmountRate:
      row.transaction_coverage_amount_rate == null ? null : Number(row.transaction_coverage_amount_rate),
    orderRevenueTruthDelta:
      row.order_revenue_truth_delta == null ? null : Number(row.order_revenue_truth_delta),
    transactionRevenueDelta:
      row.transaction_revenue_delta == null ? null : Number(row.transaction_revenue_delta),
    explainedAdjustmentRevenue:
      row.explained_adjustment_revenue == null ? null : Number(row.explained_adjustment_revenue),
    unexplainedAdjustmentRevenue:
      row.unexplained_adjustment_revenue == null ? null : Number(row.unexplained_adjustment_revenue),
    divergence:
      row.divergence && typeof row.divergence === "object"
        ? (row.divergence as Record<string, unknown>)
        : null,
    warehouseAggregate:
      row.warehouse_aggregate && typeof row.warehouse_aggregate === "object"
        ? (row.warehouse_aggregate as Record<string, unknown>)
        : null,
    ledgerAggregate:
      row.ledger_aggregate && typeof row.ledger_aggregate === "object"
        ? (row.ledger_aggregate as Record<string, unknown>)
        : null,
    liveAggregate:
      row.live_aggregate && typeof row.live_aggregate === "object"
        ? (row.live_aggregate as Record<string, unknown>)
        : null,
    recordedAt: normalizeTimestamp(row.recorded_at),
    createdAt: normalizeTimestamp(row.created_at),
  })) satisfies ShopifyReconciliationRunRecord[];
}

export async function upsertShopifyCustomerEvents(rows: ShopifyCustomerEventWarehouseRow[]) {
  if (rows.length <= 0) return 0;
  await assertShopifyWarehouseTablesReady("shopify_warehouse:upsert_customer_events");
  const sql = getDb();
  const referenceContext = await resolveShopifyCanonicalReferenceContext(
    rows.map((row) => ({
      businessId: row.businessId,
      providerAccountId: row.providerAccountId,
      shopId: row.shopId,
    })),
  );
  let written = 0;

  for (const row of rows) {
    const businessRefId =
      referenceContext.businessRefIds.get(row.businessId) ?? null;
    const providerAccountRefId =
      referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null;
    await sql`
      INSERT INTO shopify_customer_events (
        business_id,
        business_ref_id,
        provider_account_id,
        provider_account_ref_id,
        shop_id,
        event_id,
        event_type,
        occurred_at,
        customer_id,
        session_id,
        page_type,
        page_url,
        consent_state,
        updated_at
      )
      VALUES (
        ${row.businessId},
        ${businessRefId},
        ${row.providerAccountId},
        ${providerAccountRefId},
        ${row.shopId},
        ${row.eventId},
        ${row.eventType},
        ${normalizeTimestamp(row.occurredAt)},
        ${row.customerId ?? null},
        ${row.sessionId ?? null},
        ${row.pageType ?? null},
        ${row.pageUrl ?? null},
        ${row.consentState ?? null},
        now()
      )
      ON CONFLICT (business_id, provider_account_id, shop_id, event_id)
      DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_customer_events.business_ref_id),
        provider_account_ref_id = COALESCE(
          EXCLUDED.provider_account_ref_id,
          shopify_customer_events.provider_account_ref_id
        ),
        event_type = EXCLUDED.event_type,
        occurred_at = EXCLUDED.occurred_at,
        customer_id = EXCLUDED.customer_id,
        session_id = EXCLUDED.session_id,
        page_type = EXCLUDED.page_type,
        page_url = EXCLUDED.page_url,
        consent_state = EXCLUDED.consent_state,
        updated_at = now()
    `;
    written += 1;
  }

  await upsertShopifyPayloadArchives(
    rows.flatMap((row) => {
      if (!hasMeaningfulJsonPayload(row.payloadJson)) return [];
      return [
        {
          business_id: row.businessId,
          business_ref_id: referenceContext.businessRefIds.get(row.businessId) ?? null,
          provider_account_id: row.providerAccountId,
          provider_account_ref_id:
            referenceContext.providerAccountRefIds.get(row.providerAccountId) ?? null,
          shop_id: row.shopId,
          entity_type: "customer_event" as const,
          entity_id: row.eventId,
          parent_entity_id: row.customerId ?? null,
          payload_hash: buildShopifyPayloadArchiveHash({
            businessId: row.businessId,
            providerAccountId: row.providerAccountId,
            shopId: row.shopId,
            entityType: "customer_event",
            entityId: row.eventId,
            payloadJson: row.payloadJson,
          }),
          payload_json: row.payloadJson ?? {},
          source_snapshot_id: null,
          source_updated_at: normalizeTimestamp(row.occurredAt),
        },
      ];
    }),
    sql,
  );

  return written;
}

export async function getShopifyServingState(input: {
  businessId: string;
  providerAccountId: string;
  canaryKey: string;
}) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:get_serving_state");
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM shopify_serving_state
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND canary_key = ${input.canaryKey}
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    canaryKey: String(row.canary_key),
    startDate: normalizeDate(row.start_date),
    endDate: normalizeDate(row.end_date),
    timeZoneBasis: row.time_zone_basis ? String(row.time_zone_basis) : null,
    assessedAt: normalizeTimestamp(row.assessed_at),
    statusState: row.status_state ? String(row.status_state) : null,
    preferredSource: row.preferred_source ? String(row.preferred_source) : null,
    productionMode: normalizeServingProductionMode(row.production_mode),
    trustState: normalizeServingTrustState(row.trust_state),
    fallbackReason: row.fallback_reason ? String(row.fallback_reason) : null,
    coverageStatus: normalizeServingCoverageStatus(row.coverage_status),
    pendingRepair: Boolean(row.pending_repair),
    pendingRepairStartedAt: normalizeTimestamp(row.pending_repair_started_at),
    pendingRepairLastTopic: row.pending_repair_last_topic
      ? String(row.pending_repair_last_topic)
      : null,
    pendingRepairLastReceivedAt: normalizeTimestamp(row.pending_repair_last_received_at),
    consecutiveCleanValidations: Number(row.consecutive_clean_validations ?? 0) || 0,
    ordersRecentSyncedAt: normalizeTimestamp(row.orders_recent_synced_at),
    ordersRecentCursorTimestamp: normalizeTimestamp(row.orders_recent_cursor_timestamp),
    ordersRecentCursorValue: row.orders_recent_cursor_value ? String(row.orders_recent_cursor_value) : null,
    returnsRecentSyncedAt: normalizeTimestamp(row.returns_recent_synced_at),
    returnsRecentCursorTimestamp: normalizeTimestamp(row.returns_recent_cursor_timestamp),
    returnsRecentCursorValue: row.returns_recent_cursor_value ? String(row.returns_recent_cursor_value) : null,
    ordersHistoricalSyncedAt: normalizeTimestamp(row.orders_historical_synced_at),
    ordersHistoricalReadyThroughDate: normalizeDate(row.orders_historical_ready_through_date),
    ordersHistoricalTargetEnd: normalizeDate(row.orders_historical_target_end),
    returnsHistoricalSyncedAt: normalizeTimestamp(row.returns_historical_synced_at),
    returnsHistoricalReadyThroughDate: normalizeDate(row.returns_historical_ready_through_date),
    returnsHistoricalTargetEnd: normalizeDate(row.returns_historical_target_end),
    canServeWarehouse: Boolean(row.can_serve_warehouse),
    canaryEnabled: Boolean(row.canary_enabled),
    decisionReasons: Array.isArray(row.decision_reasons)
      ? row.decision_reasons.map((value) => String(value))
      : [],
    divergence:
      row.divergence && typeof row.divergence === "object"
        ? (row.divergence as Record<string, unknown>)
        : null,
  } satisfies ShopifyServingStateRecord;
}

export async function listShopifyServingStateHistory(input: {
  businessId: string;
  providerAccountId: string;
  canaryKey?: string;
  startDate?: string | null;
  endDate?: string | null;
  limit?: number;
}) {
  await assertShopifyWarehouseTablesReady("shopify_warehouse:list_serving_state_history");
  const sql = getDb();
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 10)));
  const rows = (await sql`
    SELECT *
    FROM shopify_serving_state_history
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND (${input.canaryKey ?? null}::text IS NULL OR canary_key = ${input.canaryKey ?? null})
      AND (${normalizeDate(input.startDate) ?? null}::date IS NULL OR start_date = ${normalizeDate(input.startDate) ?? null})
      AND (${normalizeDate(input.endDate) ?? null}::date IS NULL OR end_date = ${normalizeDate(input.endDate) ?? null})
    ORDER BY assessed_at DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    canaryKey: String(row.canary_key),
    startDate: normalizeDate(row.start_date),
    endDate: normalizeDate(row.end_date),
    timeZoneBasis: row.time_zone_basis ? String(row.time_zone_basis) : null,
    assessedAt: normalizeTimestamp(row.assessed_at),
    statusState: row.status_state ? String(row.status_state) : null,
    preferredSource: row.preferred_source ? String(row.preferred_source) : null,
    productionMode: normalizeServingProductionMode(row.production_mode),
    trustState: normalizeServingTrustState(row.trust_state),
    fallbackReason: row.fallback_reason ? String(row.fallback_reason) : null,
    coverageStatus: normalizeServingCoverageStatus(row.coverage_status),
    pendingRepair: Boolean(row.pending_repair),
    pendingRepairStartedAt: normalizeTimestamp(row.pending_repair_started_at),
    pendingRepairLastTopic: row.pending_repair_last_topic
      ? String(row.pending_repair_last_topic)
      : null,
    pendingRepairLastReceivedAt: normalizeTimestamp(row.pending_repair_last_received_at),
    consecutiveCleanValidations: Number(row.consecutive_clean_validations ?? 0) || 0,
    ordersRecentSyncedAt: normalizeTimestamp(row.orders_recent_synced_at),
    ordersRecentCursorTimestamp: normalizeTimestamp(row.orders_recent_cursor_timestamp),
    ordersRecentCursorValue: row.orders_recent_cursor_value ? String(row.orders_recent_cursor_value) : null,
    returnsRecentSyncedAt: normalizeTimestamp(row.returns_recent_synced_at),
    returnsRecentCursorTimestamp: normalizeTimestamp(row.returns_recent_cursor_timestamp),
    returnsRecentCursorValue: row.returns_recent_cursor_value ? String(row.returns_recent_cursor_value) : null,
    ordersHistoricalSyncedAt: normalizeTimestamp(row.orders_historical_synced_at),
    ordersHistoricalReadyThroughDate: normalizeDate(row.orders_historical_ready_through_date),
    ordersHistoricalTargetEnd: normalizeDate(row.orders_historical_target_end),
    returnsHistoricalSyncedAt: normalizeTimestamp(row.returns_historical_synced_at),
    returnsHistoricalReadyThroughDate: normalizeDate(row.returns_historical_ready_through_date),
    returnsHistoricalTargetEnd: normalizeDate(row.returns_historical_target_end),
    canServeWarehouse: Boolean(row.can_serve_warehouse),
    canaryEnabled: Boolean(row.canary_enabled),
    decisionReasons: Array.isArray(row.decision_reasons)
      ? row.decision_reasons.map((value) => String(value))
      : [],
    divergence:
      row.divergence && typeof row.divergence === "object"
        ? (row.divergence as Record<string, unknown>)
        : null,
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
  })) satisfies ShopifyServingStateHistoryRecord[];
}
