import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";

export interface ProviderJobLockKey {
  businessId: string;
  provider: string;
  reportType: string;
  dateRangeKey: string;
}

export interface ProviderJobLockState {
  id: string;
  status: string;
  lockOwner: string | null;
  lockExpiresAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  isExpired: boolean;
}

const DEFAULT_LOCK_MINUTES = 10;

async function assertProviderJobLockTablesReady(context: string) {
  await assertDbSchemaReady({
    tables: ["provider_sync_jobs"],
    context,
  });
}

function getLockMinutes(input?: number) {
  if (!Number.isFinite(input) || !input || input <= 0) {
    return DEFAULT_LOCK_MINUTES;
  }
  return Math.max(1, Math.floor(input));
}

async function resolveProviderSyncJobBusinessRefId(businessId: string) {
  const businessRefIds = await resolveBusinessReferenceIds([businessId]);
  return businessRefIds.get(businessId) ?? null;
}

function mapProviderJobLockState(
  row: {
    id: string;
    status: string;
    lock_owner: string | null;
    lock_expires_at: string | Date | null;
    started_at: string | Date | null;
    completed_at: string | Date | null;
    error_message: string | null;
    is_expired: boolean;
  } | null | undefined,
): ProviderJobLockState | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    lockOwner: row.lock_owner,
    lockExpiresAt: row.lock_expires_at ? new Date(row.lock_expires_at).toISOString() : null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    errorMessage: row.error_message,
    isExpired: row.is_expired,
  };
}

export async function acquireProviderJobLock(input: ProviderJobLockKey & {
  ownerToken: string;
  lockMinutes?: number;
}) {
  await assertProviderJobLockTablesReady("provider_sync_jobs:acquire_lock");
  const sql = getDb();
  const lockMinutes = getLockMinutes(input.lockMinutes);
  const businessRefId = await resolveProviderSyncJobBusinessRefId(input.businessId);
  const rows = await sql`
    WITH active AS (
      SELECT id
      FROM provider_sync_jobs
      WHERE business_id = ${input.businessId}
        AND provider = ${input.provider}
        AND report_type = ${input.reportType}
        AND date_range_key = ${input.dateRangeKey}
        AND status = 'running'
        AND COALESCE(lock_expires_at, started_at + (${lockMinutes} || ' minutes')::interval) > now()
      LIMIT 1
    ),
    upserted AS (
      INSERT INTO provider_sync_jobs (
        business_id,
        business_ref_id,
        provider,
        report_type,
        date_range_key,
        status,
        triggered_at,
        started_at,
        lock_owner,
        lock_expires_at,
        completed_at,
        error_message
      )
      VALUES (
        ${input.businessId},
        ${businessRefId},
        ${input.provider},
        ${input.reportType},
        ${input.dateRangeKey},
        'running',
        now(),
        now(),
        ${input.ownerToken},
        now() + (${lockMinutes} || ' minutes')::interval,
        NULL,
        NULL
      )
      ON CONFLICT (business_id, provider, report_type, date_range_key)
      DO UPDATE SET
        business_ref_id = COALESCE(provider_sync_jobs.business_ref_id, EXCLUDED.business_ref_id),
        status = 'running',
        triggered_at = now(),
        started_at = now(),
        lock_owner = ${input.ownerToken},
        lock_expires_at = now() + (${lockMinutes} || ' minutes')::interval,
        completed_at = NULL,
        error_message = NULL
      WHERE provider_sync_jobs.status <> 'running'
        OR COALESCE(provider_sync_jobs.lock_expires_at, provider_sync_jobs.started_at + (${lockMinutes} || ' minutes')::interval) <= now()
      RETURNING id
    )
    SELECT
      EXISTS(SELECT 1 FROM active) AS already_running,
      EXISTS(SELECT 1 FROM upserted) AS acquired
  ` as Array<{ already_running: boolean; acquired: boolean }>;
  return {
    acquired: Boolean(rows[0]?.acquired),
    alreadyRunning: Boolean(rows[0]?.already_running),
  };
}

export async function renewProviderJobLock(input: ProviderJobLockKey & {
  ownerToken: string;
  lockMinutes?: number;
}) {
  await assertProviderJobLockTablesReady("provider_sync_jobs:renew_lock");
  const sql = getDb();
  const lockMinutes = getLockMinutes(input.lockMinutes);
  const businessRefId = await resolveProviderSyncJobBusinessRefId(input.businessId);
  const rows = await sql`
    UPDATE provider_sync_jobs
    SET
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      lock_expires_at = now() + (${lockMinutes} || ' minutes')::interval
    WHERE business_id = ${input.businessId}
      AND provider = ${input.provider}
      AND report_type = ${input.reportType}
      AND date_range_key = ${input.dateRangeKey}
      AND status = 'running'
      AND lock_owner = ${input.ownerToken}
    RETURNING id
  ` as Array<{ id: string }>;
  return rows.length > 0;
}

export async function releaseProviderJobLock(input: ProviderJobLockKey & {
  ownerToken: string;
  status: "done" | "failed";
  errorMessage?: string | null;
}) {
  await assertProviderJobLockTablesReady("provider_sync_jobs:release_lock");
  const sql = getDb();
  const businessRefId = await resolveProviderSyncJobBusinessRefId(input.businessId);
  await sql`
    UPDATE provider_sync_jobs
    SET
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      status = ${input.status},
      completed_at = now(),
      lock_expires_at = now(),
      error_message = ${input.errorMessage ?? null}
    WHERE business_id = ${input.businessId}
      AND provider = ${input.provider}
      AND report_type = ${input.reportType}
      AND date_range_key = ${input.dateRangeKey}
      AND lock_owner = ${input.ownerToken}
  `;
}

export async function getProviderJobLockState(input: ProviderJobLockKey) {
  await assertProviderJobLockTablesReady("provider_sync_jobs:get_lock_state");
  const sql = getDb();
  const rows = await sql`
    SELECT
      id,
      status,
      lock_owner,
      lock_expires_at,
      started_at,
      completed_at,
      error_message,
      COALESCE(lock_expires_at, started_at + (${DEFAULT_LOCK_MINUTES} || ' minutes')::interval) <= now() AS is_expired
    FROM provider_sync_jobs
    WHERE business_id = ${input.businessId}
      AND provider = ${input.provider}
      AND report_type = ${input.reportType}
      AND date_range_key = ${input.dateRangeKey}
    LIMIT 1
  ` as Array<{
    id: string;
    status: string;
    lock_owner: string | null;
    lock_expires_at: string | Date | null;
    started_at: string | Date | null;
    completed_at: string | Date | null;
    error_message: string | null;
    is_expired: boolean;
  }>;
  return mapProviderJobLockState(rows[0]);
}

export async function releaseExpiredProviderJobLock(input: ProviderJobLockKey & {
  errorMessage?: string | null;
}) {
  await assertProviderJobLockTablesReady("provider_sync_jobs:release_expired_lock");
  const sql = getDb();
  const businessRefId = await resolveProviderSyncJobBusinessRefId(input.businessId);
  const rows = await sql`
    UPDATE provider_sync_jobs
    SET
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      status = 'failed',
      completed_at = now(),
      lock_expires_at = now(),
      error_message = COALESCE(${input.errorMessage ?? null}, error_message, 'stale provider job lock expired')
    WHERE business_id = ${input.businessId}
      AND provider = ${input.provider}
      AND report_type = ${input.reportType}
      AND date_range_key = ${input.dateRangeKey}
      AND status = 'running'
      AND COALESCE(lock_expires_at, started_at + (${DEFAULT_LOCK_MINUTES} || ' minutes')::interval) <= now()
    RETURNING
      id,
      status,
      lock_owner,
      lock_expires_at,
      started_at,
      completed_at,
      error_message,
      false AS is_expired
  ` as Array<{
    id: string;
    status: string;
    lock_owner: string | null;
    lock_expires_at: string | Date | null;
    started_at: string | Date | null;
    completed_at: string | Date | null;
    error_message: string | null;
    is_expired: boolean;
  }>;
  return {
    released: rows.length > 0,
    state: mapProviderJobLockState(rows[0]),
  };
}
