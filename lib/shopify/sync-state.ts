import { createHash } from "node:crypto";

import { getDb } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";

function normalizeDate(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
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

function asArchivedObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function buildShopifySyncStateDetailArchiveEntityId(syncTarget: string) {
  return syncTarget;
}

function buildShopifySyncStateDetailArchiveHash(input: {
  businessId: string;
  providerAccountId: string;
  syncTarget: string;
  payloadJson: unknown;
}) {
  return createHash("sha1")
    .update(
      JSON.stringify({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        syncTarget: input.syncTarget,
        payload: input.payloadJson,
      }),
    )
    .digest("hex");
}

async function resolveShopifySyncStateReferenceContext(input: {
  businessId: string;
  providerAccountId: string;
}) {
  const [businessRefIds, providerAccountRefIds] = await Promise.all([
    resolveBusinessReferenceIds([input.businessId]),
    ensureProviderAccountReferenceIds({
      provider: "shopify",
      accounts: [{ externalAccountId: input.providerAccountId }],
    }),
  ]);
  return {
    businessRefId: businessRefIds.get(input.businessId) ?? null,
    providerAccountRefId:
      providerAccountRefIds.get(input.providerAccountId) ?? null,
  };
}

export interface ShopifySyncStateRecord {
  businessId: string;
  providerAccountId: string;
  syncTarget: string;
  historicalTargetStart?: string | null;
  historicalTargetEnd?: string | null;
  readyThroughDate?: string | null;
  cursorTimestamp?: string | null;
  cursorValue?: string | null;
  latestSyncStartedAt?: string | null;
  latestSuccessfulSyncAt?: string | null;
  latestSyncStatus?: string | null;
  latestSyncWindowStart?: string | null;
  latestSyncWindowEnd?: string | null;
  /**
   * The window the LAST SUCCESSFUL pass covered — not the one this attempt is
   * attempting.
   *
   * `latestSyncWindowStart`/`End` are written before any work happens and again
   * on failure, so they describe an ATTEMPT. A reader asking "which days have we
   * actually read" could therefore only trust them while the row's recorded
   * status was itself a success, which withdrew a perfectly good proven window
   * for the whole duration of an ordinary refresh.
   *
   * Through THIS writer, only the success call sites in
   * `lib/sync/shopify-sync.ts` may set these. Everything else leaves them
   * undefined, and the upsert below COALESCE-preserves them, so an unsuccessful
   * attempt cannot erase the proof an earlier pass left.
   *
   * One writer sits outside this function: the migration that adds the two
   * columns also backfills them once, on the rows whose last recorded attempt
   * finished over a window ending on their own `ready_through_date`
   * (`SHOPIFY_SYNC_STATE_RETAINED_WINDOW_BACKFILL_SQL` in `lib/migrations.ts`).
   * Without it every row that existed before the deploy would read as unproven
   * and lose coverage it had the day before.
   *
   * A row that has never had a successful pass still has NULLs here, and so
   * does a pre-deploy row whose last attempt was running or failed. Both are
   * "not proven" and never "covered".
   */
  latestSuccessfulSyncWindowStart?: string | null;
  latestSuccessfulSyncWindowEnd?: string | null;
  lastError?: string | null;
  lastResultSummary?: Record<string, unknown> | null;
}

export async function getShopifySyncState(input: {
  businessId: string;
  providerAccountId: string;
  syncTarget: string;
}) {
  const stateReadiness = await getDbSchemaReadiness({
    tables: ["shopify_sync_state", "shopify_entity_payload_archives"],
  }).catch(() => null);
  if (!stateReadiness?.ready) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT
      shopify_sync_state.*,
      archive.payload_json AS archived_payload_json
    FROM shopify_sync_state
    LEFT JOIN shopify_entity_payload_archives AS archive
      ON archive.business_id = shopify_sync_state.business_id
     AND archive.provider_account_id = shopify_sync_state.provider_account_id
     AND archive.shop_id = shopify_sync_state.provider_account_id
     AND archive.entity_type = 'sync_state_detail'
     AND archive.entity_id = ${buildShopifySyncStateDetailArchiveEntityId(input.syncTarget)}
    WHERE shopify_sync_state.business_id = ${input.businessId}
      AND shopify_sync_state.provider_account_id = ${input.providerAccountId}
      AND shopify_sync_state.sync_target = ${input.syncTarget}
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const archivedPayload = asArchivedObject(row.archived_payload_json);
  return {
    businessId: String(row.business_id),
    providerAccountId: String(row.provider_account_id),
    syncTarget: String(row.sync_target),
    historicalTargetStart: normalizeDate(row.historical_target_start),
    historicalTargetEnd: normalizeDate(row.historical_target_end),
    readyThroughDate: normalizeDate(row.ready_through_date),
    cursorTimestamp: normalizeTimestamp(row.cursor_timestamp),
    cursorValue: row.cursor_value ? String(row.cursor_value) : null,
    latestSyncStartedAt: normalizeTimestamp(row.latest_sync_started_at),
    latestSuccessfulSyncAt: normalizeTimestamp(row.latest_successful_sync_at),
    latestSyncStatus: row.latest_sync_status ? String(row.latest_sync_status) : null,
    latestSyncWindowStart: normalizeDate(row.latest_sync_window_start),
    latestSyncWindowEnd: normalizeDate(row.latest_sync_window_end),
    latestSuccessfulSyncWindowStart: normalizeDate(
      row.latest_successful_sync_window_start,
    ),
    latestSuccessfulSyncWindowEnd: normalizeDate(
      row.latest_successful_sync_window_end,
    ),
    lastError: row.last_error ? String(row.last_error) : null,
    lastResultSummary: asArchivedObject(archivedPayload?.lastResultSummary) ?? null,
  } satisfies ShopifySyncStateRecord;
}

export async function upsertShopifySyncState(input: ShopifySyncStateRecord) {
  await assertDbSchemaReady({
    tables: ["shopify_sync_state", "shopify_entity_payload_archives"],
    context: "shopify_sync_state_upsert",
  });
  const sql = getDb();
  const refs = await resolveShopifySyncStateReferenceContext(input);
  await sql`
    INSERT INTO shopify_sync_state (
      business_id,
      business_ref_id,
      provider_account_id,
      provider_account_ref_id,
      sync_target,
      historical_target_start,
      historical_target_end,
      ready_through_date,
      cursor_timestamp,
      cursor_value,
      latest_sync_started_at,
      latest_successful_sync_at,
      latest_sync_status,
      latest_sync_window_start,
      latest_sync_window_end,
      latest_successful_sync_window_start,
      latest_successful_sync_window_end,
      last_error,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${refs.businessRefId},
      ${input.providerAccountId},
      ${refs.providerAccountRefId},
      ${input.syncTarget},
      ${normalizeDate(input.historicalTargetStart)},
      ${normalizeDate(input.historicalTargetEnd)},
      ${normalizeDate(input.readyThroughDate)},
      ${normalizeTimestamp(input.cursorTimestamp)},
      ${input.cursorValue ?? null},
      ${normalizeTimestamp(input.latestSyncStartedAt)},
      ${normalizeTimestamp(input.latestSuccessfulSyncAt)},
      ${input.latestSyncStatus ?? null},
      ${normalizeDate(input.latestSyncWindowStart)},
      ${normalizeDate(input.latestSyncWindowEnd)},
      ${normalizeDate(input.latestSuccessfulSyncWindowStart)},
      ${normalizeDate(input.latestSuccessfulSyncWindowEnd)},
      ${input.lastError ?? null},
      now()
    )
    ON CONFLICT (business_id, provider_account_id, sync_target) DO UPDATE SET
      business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_sync_state.business_ref_id),
      provider_account_ref_id = COALESCE(
        EXCLUDED.provider_account_ref_id,
        shopify_sync_state.provider_account_ref_id
      ),
      historical_target_start = COALESCE(EXCLUDED.historical_target_start, shopify_sync_state.historical_target_start),
      historical_target_end = COALESCE(EXCLUDED.historical_target_end, shopify_sync_state.historical_target_end),
      ready_through_date = COALESCE(EXCLUDED.ready_through_date, shopify_sync_state.ready_through_date),
      cursor_timestamp = COALESCE(EXCLUDED.cursor_timestamp, shopify_sync_state.cursor_timestamp),
      cursor_value = COALESCE(EXCLUDED.cursor_value, shopify_sync_state.cursor_value),
      latest_sync_started_at = COALESCE(EXCLUDED.latest_sync_started_at, shopify_sync_state.latest_sync_started_at),
      latest_successful_sync_at = COALESCE(EXCLUDED.latest_successful_sync_at, shopify_sync_state.latest_successful_sync_at),
      latest_sync_status = COALESCE(EXCLUDED.latest_sync_status, shopify_sync_state.latest_sync_status),
      latest_sync_window_start = COALESCE(EXCLUDED.latest_sync_window_start, shopify_sync_state.latest_sync_window_start),
      latest_sync_window_end = COALESCE(EXCLUDED.latest_sync_window_end, shopify_sync_state.latest_sync_window_end),
      /*
        Preserved beside ready_through_date and latest_successful_sync_at, and
        for the same reason: these are the receipt of a pass that FINISHED. A
        running or failed attempt sends them as NULL and therefore cannot erase
        the window an earlier success proved.

        They move together as a pair -- a success writes both -- so a retained
        start can never be paired with some other pass's end.
      */
      latest_successful_sync_window_start = COALESCE(
        EXCLUDED.latest_successful_sync_window_start,
        shopify_sync_state.latest_successful_sync_window_start
      ),
      latest_successful_sync_window_end = COALESCE(
        EXCLUDED.latest_successful_sync_window_end,
        shopify_sync_state.latest_successful_sync_window_end
      ),
      last_error = EXCLUDED.last_error,
      updated_at = now()
  `;
  if (input.lastResultSummary && typeof input.lastResultSummary === "object") {
    await sql`
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
      VALUES (
        ${input.businessId},
        ${refs.businessRefId},
        ${input.providerAccountId},
        ${refs.providerAccountRefId},
        ${input.providerAccountId},
        'sync_state_detail',
        ${buildShopifySyncStateDetailArchiveEntityId(input.syncTarget)},
        null,
        ${buildShopifySyncStateDetailArchiveHash({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          syncTarget: input.syncTarget,
          payloadJson: input.lastResultSummary,
        })},
        ${JSON.stringify({ lastResultSummary: input.lastResultSummary })}::jsonb,
        null,
        COALESCE(
          ${normalizeTimestamp(input.latestSuccessfulSyncAt)},
          ${normalizeTimestamp(input.latestSyncStartedAt)},
          now()
        ),
        now()
      )
      ON CONFLICT (business_id, provider_account_id, shop_id, entity_type, entity_id) DO UPDATE SET
        business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_entity_payload_archives.business_ref_id),
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_entity_payload_archives.provider_account_ref_id),
        payload_hash = EXCLUDED.payload_hash,
        payload_json = EXCLUDED.payload_json,
        source_updated_at = GREATEST(
          COALESCE(shopify_entity_payload_archives.source_updated_at, EXCLUDED.source_updated_at),
          EXCLUDED.source_updated_at
        ),
        updated_at = now()
    `;
  }
}
