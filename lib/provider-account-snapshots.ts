import { createHash } from "crypto";
import { getDb, runDbTransaction } from "@/lib/db";
import { getIntegration, type IntegrationProviderType } from "@/lib/integrations";
import { resolveBusinessReferenceIds } from "@/lib/provider-account-reference-store";
import { computeProviderConnectionFingerprint } from "@/lib/provider-connection-fingerprint";

export interface ProviderAccountSnapshotItem {
  id: string;
  name: string;
  currency?: string;
  timezone?: string;
  isManager?: boolean;
}

interface ProviderAccountSnapshotRow {
  business_id: string;
  provider: string;
  accounts_payload: ProviderAccountSnapshotItem[];
  fetched_at: string;
  refresh_failed: boolean;
  last_error: string | null;
  refresh_requested_at: string | null;
  last_refresh_attempt_at: string | null;
  next_refresh_after: string | null;
  refresh_in_progress: boolean;
  accounts_hash: string | null;
  source_reason: string | null;
  last_successful_refresh_at: string | null;
  refresh_failure_streak: number;
  /**
   * Which provider connection generation produced this snapshot.
   *
   * A snapshot is evidence about the credential it was fetched with and about
   * nothing else. Without this, a list captured under one user's token stays
   * "fresh" for its whole window across a disconnect, a reconnect by someone
   * else, or a rotation — and would authorise selection under credentials that
   * never saw those accounts.
   */
  connection_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export const PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES = [
  "provider_account_snapshot_runs",
  "provider_account_snapshot_items",
] as const;

interface NormalizedProviderAccountSnapshotRunRow {
  id: string;
  business_id: string;
  provider: string;
  fetched_at: string;
  refresh_failed: boolean;
  last_error: string | null;
  refresh_requested_at: string | null;
  last_refresh_attempt_at: string | null;
  next_refresh_after: string | null;
  refresh_in_progress: boolean;
  accounts_hash: string | null;
  source_reason: string | null;
  last_successful_refresh_at: string | null;
  refresh_failure_streak: number;
  connection_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

interface NormalizedProviderAccountSnapshotItemRow {
  snapshot_run_id: string;
  provider_account_ref_id: string | null;
  provider_account_id: string;
  provider_account_name: string;
  currency: string | null;
  timezone: string | null;
  is_manager: boolean | null;
  position: number;
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type ProviderAccountTrustLevel = "safe" | "risky" | "blocking";

export interface ProviderAccountSnapshotMeta {
  source: "live" | "snapshot";
  sourceHealth: "fresh" | "healthy_cached" | "stale_cached" | "degraded_blocking";
  fetchedAt: string | null;
  stale: boolean;
  refreshFailed: boolean;
  failureClass: ProviderSnapshotFailureClass;
  lastError: string | null;
  lastKnownGoodAvailable: boolean;
  refreshRequestedAt: string | null;
  lastRefreshAttemptAt: string | null;
  nextRefreshAfter: string | null;
  retryAfterAt: string | null;
  refreshInProgress: boolean;
  sourceReason: string | null;
  trustLevel?: ProviderAccountTrustLevel;
  trustScore?: number;
  snapshotAgeHours?: number | null;
  lastSuccessfulRefreshAgeHours?: number | null;
  refreshFailureStreak?: number;
  /** Provider connection generation this snapshot was captured under. */
  connectionFingerprint?: string | null;
}

export interface ProviderAccountSnapshotResult {
  accounts: ProviderAccountSnapshotItem[];
  meta: ProviderAccountSnapshotMeta;
}

interface ResolveProviderAccountSnapshotInput {
  businessId: string;
  provider: string;
  liveLoader: () => Promise<ProviderAccountSnapshotItem[]>;
  freshnessMs?: number;
  reason?: string;
  bypassCooldown?: boolean;
  /**
   * The connection generation the caller read the access token under, from
   * `readProviderConnectionGenerationToken`.
   *
   * The caller reads the token before calling here, so a reconnect between that
   * read and the start of the refresh is invisible from inside this module: a
   * generation captured at claim time would already be the NEW one, and the
   * result of an old-token call would be stamped with it. Supplying the
   * caller's generation makes that window a refusal instead.
   */
  expectedConnectionGeneration?: string | null;
}

const DEFAULT_FRESHNESS_MS = 6 * 60 * 60_000;
const FIRST_FAILURE_COOLDOWN_MS = 30 * 60_000;
const SECOND_FAILURE_COOLDOWN_MS = 2 * 60 * 60_000;
const MAX_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000;

export type ProviderSnapshotFailureClass =
  | "quota"
  | "auth"
  | "scope"
  | "permission"
  | "unknown"
  | null;

export class ProviderAccountSnapshotRefreshError extends Error {
  readonly provider: string;
  readonly businessId: string;
  readonly retryAfterMs: number;
  readonly dueToRecentFailure: boolean;

  constructor(input: {
    provider: string;
    businessId: string;
    message: string;
    retryAfterMs?: number;
    dueToRecentFailure?: boolean;
  }) {
    super(input.message);
    this.name = "ProviderAccountSnapshotRefreshError";
    this.provider = input.provider;
    this.businessId = input.businessId;
    this.retryAfterMs = input.retryAfterMs ?? 0;
    this.dueToRecentFailure = input.dueToRecentFailure ?? false;
  }
}

function getRefreshLocks() {
  const globalStore = globalThis as typeof globalThis & {
    __omniadsProviderAccountRefreshes?: Map<string, Promise<void>>;
  };
  if (!globalStore.__omniadsProviderAccountRefreshes) {
    globalStore.__omniadsProviderAccountRefreshes = new Map<string, Promise<void>>();
  }
  return globalStore.__omniadsProviderAccountRefreshes;
}

function getSnapshotKey(businessId: string, provider: string) {
  return `${businessId}:${provider}`;
}

function toIso(value: Date | string | null) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(value);
}

function isFresh(row: ProviderAccountSnapshotRow, freshnessMs: number) {
  const fetchedAtMs = new Date(row.fetched_at).getTime();
  return Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs <= freshnessMs;
}

function computeAccountsHash(accounts: ProviderAccountSnapshotItem[]) {
  return createHash("sha1").update(JSON.stringify(accounts)).digest("hex");
}

function mapSnapshotItemFromRow(row: NormalizedProviderAccountSnapshotItemRow): ProviderAccountSnapshotItem {
  return {
    id: row.provider_account_id,
    name: row.provider_account_name,
    currency: row.currency ?? undefined,
    timezone: row.timezone ?? undefined,
    isManager: row.is_manager ?? undefined,
  };
}

function buildLegacySnapshotRow(input: {
  businessId: string;
  provider: string;
  accounts: ProviderAccountSnapshotItem[];
  fetchedAt: string;
  refreshFailed: boolean;
  lastError: string | null;
  refreshRequestedAt: string | null;
  lastRefreshAttemptAt: string | null;
  nextRefreshAfter: string | null;
  refreshInProgress: boolean;
  accountsHash: string | null;
  sourceReason: string | null;
  lastSuccessfulRefreshAt: string | null;
  refreshFailureStreak: number;
  connectionFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}): ProviderAccountSnapshotRow {
  return {
    business_id: input.businessId,
    provider: input.provider,
    accounts_payload: input.accounts,
    fetched_at: input.fetchedAt,
    refresh_failed: input.refreshFailed,
    last_error: input.lastError,
    refresh_requested_at: input.refreshRequestedAt,
    last_refresh_attempt_at: input.lastRefreshAttemptAt,
    next_refresh_after: input.nextRefreshAfter,
    refresh_in_progress: input.refreshInProgress,
    accounts_hash: input.accountsHash,
    source_reason: input.sourceReason,
    last_successful_refresh_at: input.lastSuccessfulRefreshAt,
    refresh_failure_streak: input.refreshFailureStreak,
    connection_fingerprint: input.connectionFingerprint,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
}

function getRetryAfterMs(row: ProviderAccountSnapshotRow | null) {
  if (!row?.next_refresh_after) return 0;
  const retryAfterMs = new Date(row.next_refresh_after).getTime() - Date.now();
  return Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
}

function classifySnapshotSourceHealth(input: {
  source: "live" | "snapshot";
  stale: boolean;
  refreshFailed: boolean;
  lastKnownGoodAvailable: boolean;
}): ProviderAccountSnapshotMeta["sourceHealth"] {
  if (input.source === "live" && !input.refreshFailed) return "fresh";
  if (input.lastKnownGoodAvailable && !input.stale) return "healthy_cached";
  if (input.lastKnownGoodAvailable) return "stale_cached";
  return "degraded_blocking";
}

function computeAgeHours(value: string | null) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round((Math.max(0, Date.now() - ms) / 36_000)) / 100;
}

function computeSnapshotTrust(input: {
  sourceHealth: ProviderAccountSnapshotMeta["sourceHealth"];
  stale: boolean;
  refreshFailed: boolean;
  failureClass: ProviderSnapshotFailureClass;
  lastKnownGoodAvailable: boolean;
  refreshFailureStreak: number;
}) {
  if (input.sourceHealth === "degraded_blocking" || !input.lastKnownGoodAvailable) {
    return { trustLevel: "blocking" as const, trustScore: 0 };
  }
  if (input.sourceHealth === "fresh") {
    return { trustLevel: "safe" as const, trustScore: 100 };
  }
  if (!input.stale && !input.refreshFailed) {
    return { trustLevel: "safe" as const, trustScore: 88 };
  }
  if (
    input.failureClass === "quota" &&
    input.refreshFailureStreak <= 2 &&
    input.lastKnownGoodAvailable
  ) {
    return { trustLevel: "safe" as const, trustScore: 74 };
  }
  return { trustLevel: "risky" as const, trustScore: 42 };
}

export function classifyProviderSnapshotFailure(
  lastError: string | null | undefined
): ProviderSnapshotFailureClass {
  const normalized = (lastError ?? "").toLowerCase();
  if (!normalized) return null;
  if (
    normalized.includes("http 429") ||
    normalized.includes("quota") ||
    normalized.includes("resource_exhausted")
  ) {
    return "quota";
  }
  if (
    normalized.includes("missing the google ads scope") ||
    normalized.includes("scope")
  ) {
    return "scope";
  }
  if (
    normalized.includes("permission denied") ||
    normalized.includes("does not have permission") ||
    normalized.includes("denied access")
  ) {
    return "permission";
  }
  if (
    normalized.includes("oauth") ||
    normalized.includes("access token") ||
    normalized.includes("authentication_error") ||
    normalized.includes("token has expired") ||
    normalized.includes("cannot access the app") ||
    normalized.includes("log in to www.facebook.com") ||
    normalized.includes("checkpoint") ||
    normalized.includes("401")
  ) {
    return "auth";
  }
  return "unknown";
}

function computeFailureCooldownMs(row: ProviderAccountSnapshotRow | null) {
  if (!row?.refresh_failed) return FIRST_FAILURE_COOLDOWN_MS;
  if (!row.last_refresh_attempt_at || !row.next_refresh_after) {
    return SECOND_FAILURE_COOLDOWN_MS;
  }

  const previousCooldownMs =
    new Date(row.next_refresh_after).getTime() -
    new Date(row.last_refresh_attempt_at).getTime();

  if (!Number.isFinite(previousCooldownMs) || previousCooldownMs <= FIRST_FAILURE_COOLDOWN_MS) {
    return SECOND_FAILURE_COOLDOWN_MS;
  }
  if (previousCooldownMs < SECOND_FAILURE_COOLDOWN_MS) {
    return SECOND_FAILURE_COOLDOWN_MS;
  }
  return MAX_FAILURE_COOLDOWN_MS;
}

/**
 * Read the run and its items in ONE statement.
 *
 * These were two separate SELECTs. `persistSnapshotState` replaces a run's items
 * by DELETE-then-INSERT, so a reader that landed between the two statements got
 * run N with zero items, and a reader that landed between the run upsert and the
 * item replacement got run N+1's metadata with run N's accounts. Selection
 * authority reads exactly this shape: "these accounts, fetched under this
 * credential, at this time". Half of one revision and half of another is not a
 * snapshot of anything.
 *
 * A single statement sees one MVCC snapshot, so the run and its items are always
 * the same revision. The items come back as an aggregate keyed on the immutable
 * `snapshot_run_id`, which is also what makes the pairing checkable.
 */
async function getSnapshotRow(
  businessId: string,
  provider: string
): Promise<ProviderAccountSnapshotRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      run.id,
      run.business_id,
      run.provider,
      run.fetched_at,
      run.refresh_failed,
      run.last_error,
      run.refresh_requested_at,
      run.last_refresh_attempt_at,
      run.next_refresh_after,
      run.refresh_in_progress,
      run.accounts_hash,
      run.source_reason,
      run.last_successful_refresh_at,
      run.refresh_failure_streak,
      run.connection_fingerprint,
      run.created_at,
      run.updated_at,
      COALESCE(items.rows, '[]'::jsonb) AS items
    FROM provider_account_snapshot_runs run
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
               jsonb_build_object(
                 'provider_account_id', item.provider_account_id,
                 'provider_account_name', item.provider_account_name,
                 'currency', item.currency,
                 'timezone', item.timezone,
                 'is_manager', item.is_manager
               )
               ORDER BY item.position ASC, item.created_at ASC
             ) AS rows
      FROM provider_account_snapshot_items item
      WHERE item.snapshot_run_id = run.id
    ) AS items ON TRUE
    WHERE run.business_id = ${businessId}
      AND run.provider = ${provider}
    LIMIT 1
  `) as Array<
    NormalizedProviderAccountSnapshotRunRow & {
      items: Array<Record<string, unknown>>;
    }
  >;

  const run = rows[0];
  if (!run) {
    return null;
  }

  const items = (run.items ?? []) as unknown as NormalizedProviderAccountSnapshotItemRow[];

  return buildLegacySnapshotRow({
    businessId: run.business_id,
    provider: run.provider,
    accounts: items.map(mapSnapshotItemFromRow),
    fetchedAt: run.fetched_at,
    refreshFailed: run.refresh_failed,
    lastError: run.last_error,
    refreshRequestedAt: run.refresh_requested_at,
    lastRefreshAttemptAt: run.last_refresh_attempt_at,
    nextRefreshAfter: run.next_refresh_after,
    refreshInProgress: run.refresh_in_progress,
    accountsHash: run.accounts_hash,
    sourceReason: run.source_reason,
    lastSuccessfulRefreshAt: run.last_successful_refresh_at,
    refreshFailureStreak: run.refresh_failure_streak,
    connectionFingerprint: run.connection_fingerprint,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  });
}

/**
 * Write a run and its items as ONE revision.
 *
 * The run upsert, the item DELETE and the item INSERT were three separate
 * implicit transactions when this ran outside one. Wrapping them means a reader
 * never observes the intermediate states — no items at all, or the previous
 * revision's items under the new revision's metadata — and a failure part-way
 * through leaves the previous revision whole instead of an empty account list
 * that reads as "this credential can see nothing".
 *
 * `runDbTransaction` joins an outer transaction when one is already open, so
 * callers that need a wider atomic unit still get one.
 */
async function persistSnapshotState(input: {
  businessId: string;
  provider: string;
  accounts: ProviderAccountSnapshotItem[];
  fetchedAt?: Date | string | null;
  refreshRequestedAt?: Date | null;
  lastRefreshAttemptAt?: Date | null;
  nextRefreshAfter?: Date | null;
  refreshInProgress?: boolean;
  refreshFailed?: boolean;
  lastError?: string | null;
  sourceReason?: string | null;
  lastSuccessfulRefreshAt?: Date | null;
  refreshFailureStreak?: number;
}) {
  return runDbTransaction(() => persistSnapshotStateInTransaction(input));
}

async function persistSnapshotStateInTransaction(input: {
  businessId: string;
  provider: string;
  accounts: ProviderAccountSnapshotItem[];
  fetchedAt?: Date | string | null;
  refreshRequestedAt?: Date | null;
  lastRefreshAttemptAt?: Date | null;
  nextRefreshAfter?: Date | null;
  refreshInProgress?: boolean;
  refreshFailed?: boolean;
  lastError?: string | null;
  sourceReason?: string | null;
  lastSuccessfulRefreshAt?: Date | null;
  refreshFailureStreak?: number;
}) {
  const sql = getDb();
  const accountsHash = computeAccountsHash(input.accounts);
  const now = new Date().toISOString();
  const fetchedAt = toIso(input.fetchedAt ?? null) ?? now;
  const businessRefIds = await resolveBusinessReferenceIds([input.businessId]);
  const businessRefId = businessRefIds.get(input.businessId) ?? null;
  // Stamp the connection generation this list was fetched under. A snapshot
  // that outlives its credential must not keep authorising selection.
  const connectionIntegration = await getIntegration(
    input.businessId,
    input.provider as IntegrationProviderType,
  ).catch(() => null);
  const connectionFingerprint = connectionIntegration
    ? computeProviderConnectionFingerprint(connectionIntegration)
    : null;
  const runRows = (await sql`
    INSERT INTO provider_account_snapshot_runs (
      business_id,
      business_ref_id,
      provider,
      fetched_at,
      refresh_failed,
      last_error,
      refresh_requested_at,
      last_refresh_attempt_at,
      next_refresh_after,
      refresh_in_progress,
      accounts_hash,
      source_reason,
      last_successful_refresh_at,
      refresh_failure_streak,
      connection_fingerprint,
      created_at,
      updated_at
    )
    VALUES (
      ${input.businessId},
      ${businessRefId},
      ${input.provider},
      ${fetchedAt},
      ${input.refreshFailed ?? false},
      ${input.lastError ?? null},
      ${toIso(input.refreshRequestedAt ?? null)},
      ${toIso(input.lastRefreshAttemptAt ?? null)},
      ${toIso(input.nextRefreshAfter ?? null)},
      ${input.refreshInProgress ?? false},
      ${accountsHash},
      ${input.sourceReason ?? null},
      ${toIso(input.lastSuccessfulRefreshAt ?? null)},
      ${input.refreshFailureStreak ?? 0},
      ${connectionFingerprint},
      ${now},
      ${now}
    )
    ON CONFLICT (business_id, provider) DO UPDATE SET
      business_ref_id = COALESCE(
        provider_account_snapshot_runs.business_ref_id,
        EXCLUDED.business_ref_id
      ),
      fetched_at = EXCLUDED.fetched_at,
      refresh_failed = EXCLUDED.refresh_failed,
      last_error = EXCLUDED.last_error,
      refresh_requested_at = COALESCE(EXCLUDED.refresh_requested_at, provider_account_snapshot_runs.refresh_requested_at),
      last_refresh_attempt_at = COALESCE(EXCLUDED.last_refresh_attempt_at, provider_account_snapshot_runs.last_refresh_attempt_at),
      next_refresh_after = EXCLUDED.next_refresh_after,
      refresh_in_progress = EXCLUDED.refresh_in_progress,
      accounts_hash = EXCLUDED.accounts_hash,
      source_reason = EXCLUDED.source_reason,
      last_successful_refresh_at = COALESCE(EXCLUDED.last_successful_refresh_at, provider_account_snapshot_runs.last_successful_refresh_at),
      refresh_failure_streak = EXCLUDED.refresh_failure_streak,
      connection_fingerprint = EXCLUDED.connection_fingerprint,
      updated_at = EXCLUDED.updated_at
    RETURNING id
  `) as Array<{ id: string }>;
  const runId = runRows[0]?.id ?? null;
  if (!runId) {
    throw new Error("Failed to persist provider account snapshot run.");
  }

  await sql`
    DELETE FROM provider_account_snapshot_items
    WHERE snapshot_run_id = ${runId}
  `;

  if (input.accounts.length > 0) {
    await sql`
      INSERT INTO provider_accounts (
        provider,
        external_account_id,
        account_name,
        currency,
        timezone,
        is_manager,
        metadata,
        created_at,
        updated_at
      )
      SELECT
        ${input.provider},
        NULLIF(item.item->>'id', ''),
        COALESCE(NULLIF(item.item->>'name', ''), NULLIF(item.item->>'id', '')),
        NULLIF(item.item->>'currency', ''),
        NULLIF(item.item->>'timezone', ''),
        CASE
          WHEN item.item ? 'isManager' THEN (item.item->>'isManager')::BOOLEAN
          ELSE NULL
        END,
        item.item,
        ${now},
        ${now}
      FROM jsonb_array_elements(${JSON.stringify(input.accounts)}::jsonb) WITH ORDINALITY AS item(item, ordinality)
      WHERE NULLIF(item.item->>'id', '') IS NOT NULL
      ON CONFLICT (provider, external_account_id) DO UPDATE SET
        account_name = COALESCE(EXCLUDED.account_name, provider_accounts.account_name),
        currency = COALESCE(EXCLUDED.currency, provider_accounts.currency),
        timezone = COALESCE(EXCLUDED.timezone, provider_accounts.timezone),
        is_manager = COALESCE(EXCLUDED.is_manager, provider_accounts.is_manager),
        metadata = CASE
          WHEN EXCLUDED.metadata = '{}'::jsonb THEN provider_accounts.metadata
          ELSE provider_accounts.metadata || EXCLUDED.metadata
        END,
        updated_at = EXCLUDED.updated_at
    `;

    await sql`
      INSERT INTO provider_account_snapshot_items (
        snapshot_run_id,
        provider_account_ref_id,
        provider_account_id,
        provider_account_name,
        currency,
        timezone,
        is_manager,
        position,
        raw_payload,
        created_at,
        updated_at
      )
      SELECT
        ${runId},
        pa.id,
        NULLIF(item.item->>'id', ''),
        COALESCE(NULLIF(item.item->>'name', ''), NULLIF(item.item->>'id', '')),
        NULLIF(item.item->>'currency', ''),
        NULLIF(item.item->>'timezone', ''),
        CASE
          WHEN item.item ? 'isManager' THEN (item.item->>'isManager')::BOOLEAN
          ELSE NULL
        END,
        item.ordinality - 1,
        item.item,
        ${now},
        ${now}
      FROM jsonb_array_elements(${JSON.stringify(input.accounts)}::jsonb) WITH ORDINALITY AS item(item, ordinality)
      LEFT JOIN provider_accounts pa
        ON pa.provider = ${input.provider}
       AND pa.external_account_id = NULLIF(item.item->>'id', '')
      WHERE NULLIF(item.item->>'id', '') IS NOT NULL
      ON CONFLICT (snapshot_run_id, provider_account_id) DO UPDATE SET
        provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, provider_account_snapshot_items.provider_account_ref_id),
        provider_account_name = COALESCE(EXCLUDED.provider_account_name, provider_account_snapshot_items.provider_account_name),
        currency = COALESCE(EXCLUDED.currency, provider_account_snapshot_items.currency),
        timezone = COALESCE(EXCLUDED.timezone, provider_account_snapshot_items.timezone),
        is_manager = COALESCE(EXCLUDED.is_manager, provider_account_snapshot_items.is_manager),
        position = EXCLUDED.position,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = EXCLUDED.updated_at
    `;
  }
}

async function upsertSnapshotRow(input: {
  businessId: string;
  provider: string;
  accounts: ProviderAccountSnapshotItem[];
  refreshFailed: boolean;
  lastError: string | null;
  refreshRequestedAt?: Date | null;
  lastRefreshAttemptAt?: Date | null;
  nextRefreshAfter?: Date | null;
  refreshInProgress?: boolean;
  sourceReason?: string | null;
  lastSuccessfulRefreshAt?: Date | null;
  refreshFailureStreak?: number;
}) {
  await persistSnapshotState(input);
}

export async function writeProviderAccountSnapshot(input: {
  businessId: string;
  provider: string;
  accountsPayload: ProviderAccountSnapshotItem[];
  refreshFailed: boolean;
  lastError: string | null;
  refreshRequestedAt?: Date | null;
  lastRefreshAttemptAt?: Date | null;
  nextRefreshAfter?: Date | null;
  refreshInProgress?: boolean;
  sourceReason?: string | null;
  lastSuccessfulRefreshAt?: Date | null;
  refreshFailureStreak?: number;
}) {
  await upsertSnapshotRow({
    businessId: input.businessId,
    provider: input.provider,
    accounts: input.accountsPayload,
    refreshFailed: input.refreshFailed,
    lastError: input.lastError,
    refreshRequestedAt: input.refreshRequestedAt,
    lastRefreshAttemptAt: input.lastRefreshAttemptAt,
    nextRefreshAfter: input.nextRefreshAfter,
    refreshInProgress: input.refreshInProgress,
    sourceReason: input.sourceReason,
    lastSuccessfulRefreshAt: input.lastSuccessfulRefreshAt,
    refreshFailureStreak: input.refreshFailureStreak,
  });
}

async function updateSnapshotLifecycle(input: {
  businessId: string;
  provider: string;
  accounts?: ProviderAccountSnapshotItem[];
  fetchedAt?: Date | string | null;
  refreshRequestedAt?: Date | null;
  lastRefreshAttemptAt?: Date | null;
  nextRefreshAfter?: Date | null;
  refreshInProgress?: boolean;
  refreshFailed?: boolean;
  lastError?: string | null;
  sourceReason?: string | null;
  lastSuccessfulRefreshAt?: Date | null;
  refreshFailureStreak?: number;
}) {
  await persistSnapshotState({
    ...input,
    accounts: input.accounts ?? [],
    fetchedAt: input.fetchedAt ?? null,
  });
}

function toSnapshotMeta(input: {
  snapshot: ProviderAccountSnapshotRow;
  freshnessMs: number;
}): ProviderAccountSnapshotMeta {
  const failureClass = input.snapshot.refresh_failed
    ? classifyProviderSnapshotFailure(input.snapshot.last_error)
    : null;
  const stale = !isFresh(input.snapshot, input.freshnessMs);
  const lastKnownGoodAvailable = (input.snapshot.accounts_payload ?? []).length > 0;
  const sourceHealth = classifySnapshotSourceHealth({
    source: "snapshot",
    stale,
    refreshFailed: input.snapshot.refresh_failed,
    lastKnownGoodAvailable,
  });
  const trust = computeSnapshotTrust({
    sourceHealth,
    stale,
    refreshFailed: input.snapshot.refresh_failed,
    failureClass,
    lastKnownGoodAvailable,
    refreshFailureStreak: Number(input.snapshot.refresh_failure_streak ?? 0),
  });
  return {
    source: "snapshot",
    sourceHealth,
    fetchedAt: input.snapshot.fetched_at,
    stale,
    refreshFailed: input.snapshot.refresh_failed,
    failureClass,
    lastError: input.snapshot.last_error,
    lastKnownGoodAvailable,
    refreshRequestedAt: input.snapshot.refresh_requested_at,
    lastRefreshAttemptAt: input.snapshot.last_refresh_attempt_at,
    nextRefreshAfter: input.snapshot.next_refresh_after,
    retryAfterAt: input.snapshot.next_refresh_after,
    refreshInProgress: input.snapshot.refresh_in_progress,
    sourceReason: input.snapshot.source_reason,
    trustLevel: trust.trustLevel,
    trustScore: trust.trustScore,
    snapshotAgeHours: computeAgeHours(input.snapshot.fetched_at),
    lastSuccessfulRefreshAgeHours: computeAgeHours(input.snapshot.last_successful_refresh_at),
    refreshFailureStreak: Number(input.snapshot.refresh_failure_streak ?? 0),
    connectionFingerprint: input.snapshot.connection_fingerprint ?? null,
  };
}

/**
 * The connection generation, read without touching secrets.
 *
 * Returns null when there is no connection at all, which is itself a change
 * worth failing a refresh on.
 */
async function readProviderConnectionGeneration(
  businessId: string,
  provider: string,
): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT connection_generation::text AS generation, status
    FROM provider_connections
    WHERE business_id = ${businessId} AND provider = ${provider}
    LIMIT 1
  `) as Array<{ generation: string; status: string }>;
  const row = rows[0];
  return row ? `${row.generation}:${row.status}` : null;
}

/**
 * The generation token a caller must capture at the same moment it reads the
 * access token, and hand back as `expectedConnectionGeneration`.
 *
 * Exported because the binding has to be made by whoever reads the credential —
 * doing it inside the refresh is exactly one reconnect too late.
 */
export async function readProviderConnectionGenerationToken(
  businessId: string,
  provider: string,
): Promise<string | null> {
  return readProviderConnectionGeneration(businessId, provider);
}

export async function readProviderAccountSnapshot(input: {
  businessId: string;
  provider: string;
  freshnessMs?: number;
}): Promise<ProviderAccountSnapshotResult | null> {
  const freshnessMs = input.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const snapshot = await getSnapshotRow(input.businessId, input.provider);
  if (!snapshot) return null;

  return {
    accounts: snapshot.accounts_payload ?? [],
    meta: toSnapshotMeta({
      snapshot,
      freshnessMs,
    }),
  };
}

/**
 * Advisory-lock namespace for discovery refresh.
 *
 * The in-process map below coalesces concurrent refreshes WITHIN one process.
 * It says nothing about the web container and the worker container refreshing
 * the same business at the same moment, which is the case that actually
 * happens — so the database lock is the real serialisation and the map is only
 * a cheap local short-circuit.
 */
const SNAPSHOT_REFRESH_LOCK_NAMESPACE = 0x53524643;

/**
 * How long a claimed refresh may run before another process may take it over.
 *
 * The claim is durable state, not a lock held on a connection, so it needs an
 * expiry: a container that dies mid-refresh must not leave the business unable
 * to refresh forever.
 */
const SNAPSHOT_REFRESH_CLAIM_TIMEOUT_MS = 10 * 60_000;

/**
 * Refresh in three bounded phases, each its own transaction.
 *
 * The whole refresh used to run inside ONE transaction that ended by throwing.
 * The failure bookkeeping — `refresh_failed`, `last_error`, the cooldown and the
 * failure streak — was written and then rolled back by the very throw that
 * reported it. A provider outage therefore left no cooldown at all, so the next
 * caller called the provider again immediately, and the "exponential backoff"
 * never advanced past its first step.
 *
 * It also held a pooled connection open across a network call to the provider.
 *
 * So:
 *   1. CLAIM   — advisory lock, cooldown check, durable in-progress claim, and
 *                the credential generation this refresh is bound to. Committed.
 *   2. FETCH   — the provider call, outside any transaction, under the exact
 *                credential generation captured in phase 1.
 *   3. COMMIT  — success: re-read the generation, CAS, and write run+items
 *                atomically. Failure: write failure/cooldown for that same
 *                generation in its OWN transaction, commit it, and only then
 *                throw the structured error.
 */
async function runSnapshotRefresh(input: ResolveProviderAccountSnapshotInput) {
  const key = getSnapshotKey(input.businessId, input.provider);
  const locks = getRefreshLocks();
  const existingRequest = locks.get(key);
  if (existingRequest) {
    // Local coalescing only. It is a cheap short-circuit for two callers in the
    // SAME process; the durable claim below is what serialises the web container
    // against the worker container. A rejected in-flight refresh must not
    // poison later callers, so its rejection is absorbed here.
    await existingRequest.catch(() => undefined);
    return;
  }

  const refreshPromise = (async () => {
    const now = new Date();
    const reason = input.reason ?? "manual_refresh";

    // ── Phase 1: claim ────────────────────────────────────────────────────
    const claim = await runDbTransaction(async () => {
      const sql = getDb();
      // Serialises the check-and-claim itself, including the case where no run
      // row exists yet and two processes would both INSERT one.
      await sql`
        SELECT pg_advisory_xact_lock(
          ${SNAPSHOT_REFRESH_LOCK_NAMESPACE}::int,
          hashtext(${`provider_account_snapshot_refresh:${input.provider}:${input.businessId}`})
        )
      `;
      const existingSnapshot = await getSnapshotRow(input.businessId, input.provider);
      const retryAfterMs = getRetryAfterMs(existingSnapshot);
      const failureClass = classifyProviderSnapshotFailure(existingSnapshot?.last_error);
      if (retryAfterMs > 0 && (!input.bypassCooldown || failureClass === "quota")) {
        throw new ProviderAccountSnapshotRefreshError({
          provider: input.provider,
          businessId: input.businessId,
          message:
            existingSnapshot?.last_error ??
            "Provider account refresh is temporarily cooling down.",
          retryAfterMs,
          dueToRecentFailure: true,
        });
      }

      // A claim held by ANOTHER process. Durable, so it survives the phase
      // boundary that a transaction-scoped advisory lock cannot.
      if (existingSnapshot?.refresh_in_progress) {
        const claimedAtMs = existingSnapshot.last_refresh_attempt_at
          ? new Date(existingSnapshot.last_refresh_attempt_at).getTime()
          : 0;
        const claimAgeMs = Date.now() - claimedAtMs;
        if (Number.isFinite(claimAgeMs) && claimAgeMs < SNAPSHOT_REFRESH_CLAIM_TIMEOUT_MS) {
          throw new ProviderAccountSnapshotRefreshError({
            provider: input.provider,
            businessId: input.businessId,
            message:
              "A provider account refresh for this business is already in progress.",
            retryAfterMs: SNAPSHOT_REFRESH_CLAIM_TIMEOUT_MS - claimAgeMs,
            dueToRecentFailure: false,
          });
        }
      }

      await updateSnapshotLifecycle({
        businessId: input.businessId,
        provider: input.provider,
        accounts: existingSnapshot?.accounts_payload ?? [],
        fetchedAt: existingSnapshot?.fetched_at ?? null,
        refreshRequestedAt: now,
        lastRefreshAttemptAt: now,
        nextRefreshAfter: null,
        refreshInProgress: true,
        sourceReason: reason,
      });

      // The credential generation this refresh is bound to. Captured here, and
      // ALSO accepted from the caller: the caller read the access token before
      // it ever got here, so a reconnect between the caller's token read and
      // this claim is invisible from inside this function. When the caller
      // supplies the generation it captured, that one wins.
      const claimedGeneration = await readProviderConnectionGeneration(
        input.businessId,
        input.provider,
      );
      const expected = input.expectedConnectionGeneration ?? null;
      if (expected != null && expected !== claimedGeneration) {
        throw new ProviderAccountSnapshotRefreshError({
          provider: input.provider,
          businessId: input.businessId,
          message:
            "The provider connection changed between reading its credential and starting the refresh. The credential this refresh would use is no longer current.",
          retryAfterMs: 0,
          dueToRecentFailure: false,
        });
      }
      return { generation: expected ?? claimedGeneration };
    });

    // ── Phase 2: the provider call, outside any transaction ───────────────
    let accounts: ProviderAccountSnapshotItem[];
    try {
      accounts = await input.liveLoader();
    } catch (error: unknown) {
      await commitSnapshotRefreshFailure({
        businessId: input.businessId,
        provider: input.provider,
        reason,
        now,
        message: error instanceof Error ? error.message : String(error),
      });
      throw new ProviderAccountSnapshotRefreshError({
        provider: input.provider,
        businessId: input.businessId,
        message: error instanceof Error ? error.message : String(error),
        retryAfterMs: await readSnapshotRetryAfterMs(input.businessId, input.provider),
        dueToRecentFailure: false,
      });
    }

    // ── Phase 3: commit, under a second generation CAS ────────────────────
    try {
      await runDbTransaction(async () => {
        const generationAfterCall = await readProviderConnectionGeneration(
          input.businessId,
          input.provider,
        );
        if (generationAfterCall !== claim.generation) {
          throw new ProviderAccountSnapshotRefreshError({
            provider: input.provider,
            businessId: input.businessId,
            message:
              "The provider connection changed while its account list was being fetched. The result describes a credential that is no longer current.",
            retryAfterMs: 0,
            dueToRecentFailure: false,
          });
        }
        await persistSnapshotStateInTransaction({
          businessId: input.businessId,
          provider: input.provider,
          accounts,
          refreshFailed: false,
          lastError: null,
          refreshRequestedAt: now,
          lastRefreshAttemptAt: now,
          nextRefreshAfter: null,
          refreshInProgress: false,
          sourceReason: reason,
          lastSuccessfulRefreshAt: now,
          refreshFailureStreak: 0,
        });
      });
    } catch (error: unknown) {
      await commitSnapshotRefreshFailure({
        businessId: input.businessId,
        provider: input.provider,
        reason,
        now,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof ProviderAccountSnapshotRefreshError) throw error;
      throw new ProviderAccountSnapshotRefreshError({
        provider: input.provider,
        businessId: input.businessId,
        message: error instanceof Error ? error.message : String(error),
        retryAfterMs: await readSnapshotRetryAfterMs(input.businessId, input.provider),
        dueToRecentFailure: false,
      });
    }
  })().finally(() => {
    // Always released, including on the cooldown and claim-conflict paths. The
    // previous version deleted the key only inside the provider-call try/finally,
    // so a cooldown rejection left a rejected promise in the map and every later
    // refresh in that process awaited and rethrew it — forever.
    locks.delete(key);
  });

  locks.set(key, refreshPromise);
  await refreshPromise;
}

/**
 * Commit failure bookkeeping in its OWN transaction, so it survives the throw
 * that reports the failure.
 */
async function commitSnapshotRefreshFailure(input: {
  businessId: string;
  provider: string;
  reason: string;
  now: Date;
  message: string;
}) {
  await runDbTransaction(async () => {
    const currentSnapshot = await getSnapshotRow(input.businessId, input.provider);
    const cooldownMs = computeFailureCooldownMs(currentSnapshot);
    const nextRefreshAfter = new Date(Date.now() + cooldownMs);
    if (currentSnapshot) {
      await persistSnapshotStateInTransaction({
        businessId: input.businessId,
        provider: input.provider,
        // The previous accounts are kept: a failed refresh does not mean the
        // credential can suddenly see nothing.
        accounts: currentSnapshot.accounts_payload ?? [],
        fetchedAt: currentSnapshot.fetched_at,
        refreshFailed: true,
        lastError: input.message,
        refreshRequestedAt: currentSnapshot.refresh_requested_at
          ? new Date(currentSnapshot.refresh_requested_at)
          : input.now,
        lastRefreshAttemptAt: input.now,
        nextRefreshAfter,
        refreshInProgress: false,
        sourceReason: input.reason,
        lastSuccessfulRefreshAt: currentSnapshot.last_successful_refresh_at
          ? new Date(currentSnapshot.last_successful_refresh_at)
          : null,
        refreshFailureStreak: Number(currentSnapshot.refresh_failure_streak ?? 0) + 1,
      });
    } else {
      await persistSnapshotStateInTransaction({
        businessId: input.businessId,
        provider: input.provider,
        accounts: [],
        refreshRequestedAt: input.now,
        lastRefreshAttemptAt: input.now,
        nextRefreshAfter,
        refreshInProgress: false,
        refreshFailed: true,
        lastError: input.message,
        sourceReason: input.reason,
        refreshFailureStreak: 1,
      });
    }
  });
}

async function readSnapshotRetryAfterMs(businessId: string, provider: string) {
  return getRetryAfterMs(await getSnapshotRow(businessId, provider));
}

export async function scheduleProviderAccountSnapshotRefresh(
  input: ResolveProviderAccountSnapshotInput & {
    skipIfFresh?: boolean;
  }
): Promise<ProviderAccountSnapshotResult | null> {
  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: input.provider,
    freshnessMs: input.freshnessMs,
  });

  if (input.skipIfFresh !== false && snapshot && !snapshot.meta.stale) {
    return snapshot;
  }

  const existingRow = await getSnapshotRow(input.businessId, input.provider);
  const retryAfterMs = getRetryAfterMs(existingRow);
  if (retryAfterMs > 0 || existingRow?.refresh_in_progress) {
    return snapshot;
  }

  void runSnapshotRefresh({
    ...input,
    reason: input.reason ?? "background_refresh",
  }).catch(() => undefined);

  return snapshot;
}

export async function requestProviderAccountSnapshotRefresh(
  input: ResolveProviderAccountSnapshotInput
): Promise<ProviderAccountSnapshotResult | null> {
  return scheduleProviderAccountSnapshotRefresh({
    ...input,
    skipIfFresh: true,
    reason: input.reason ?? "background_refresh",
  });
}

export async function forceProviderAccountSnapshotRefresh(
  input: ResolveProviderAccountSnapshotInput
): Promise<ProviderAccountSnapshotResult> {
  await runSnapshotRefresh({
    ...input,
    reason: input.reason ?? "manual_refresh",
    bypassCooldown: true,
  });

  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: input.provider,
    freshnessMs: input.freshnessMs,
  });

  if (!snapshot) {
    throw new ProviderAccountSnapshotRefreshError({
      provider: input.provider,
      businessId: input.businessId,
      message: "Provider account snapshot could not be loaded after refresh.",
    });
  }

  return {
    accounts: snapshot.accounts,
    meta: {
      ...snapshot.meta,
      source: "live",
      sourceHealth: "fresh",
      stale: false,
      refreshFailed: false,
      failureClass: null,
      lastError: null,
      refreshInProgress: false,
      retryAfterAt: null,
      trustLevel: "safe",
      trustScore: 100,
      snapshotAgeHours: 0,
      lastSuccessfulRefreshAgeHours: 0,
      refreshFailureStreak: 0,
    },
  };
}

export async function resolveProviderAccountSnapshot(
  input: ResolveProviderAccountSnapshotInput
): Promise<ProviderAccountSnapshotResult> {
  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: input.provider,
    freshnessMs: input.freshnessMs,
  });

  if (snapshot) {
    if (snapshot.meta.stale && !snapshot.meta.refreshInProgress) {
      void scheduleProviderAccountSnapshotRefresh({
        ...input,
        skipIfFresh: true,
        reason: input.reason ?? "stale_snapshot_refresh",
      }).catch(() => undefined);
    }
    return snapshot;
  }

  const existingRow = await getSnapshotRow(input.businessId, input.provider);
  const retryAfterMs = getRetryAfterMs(existingRow);
  if (retryAfterMs > 0) {
    throw new ProviderAccountSnapshotRefreshError({
      provider: input.provider,
      businessId: input.businessId,
      message:
        existingRow?.last_error ??
        "Provider account refresh is temporarily cooling down.",
      retryAfterMs,
      dueToRecentFailure: true,
    });
  }

  await runSnapshotRefresh({
    ...input,
    reason: input.reason ?? "initial_snapshot_refresh",
  });

  const refreshedSnapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: input.provider,
    freshnessMs: input.freshnessMs,
  });
  if (!refreshedSnapshot) {
    throw new ProviderAccountSnapshotRefreshError({
      provider: input.provider,
      businessId: input.businessId,
      message: "Provider account snapshot is unavailable.",
    });
  }
  return {
    accounts: refreshedSnapshot.accounts,
    meta: {
      ...refreshedSnapshot.meta,
      source: "live",
      sourceHealth: "fresh",
      stale: false,
      refreshFailed: false,
      lastError: null,
      refreshInProgress: false,
      trustLevel: "safe",
      trustScore: 100,
      snapshotAgeHours: 0,
      lastSuccessfulRefreshAgeHours: 0,
      refreshFailureStreak: 0,
    },
  };
}

export async function clearProviderAccountSnapshot(
  businessId: string,
  provider: string,
): Promise<void> {
  const sql = getDb();
  await sql`
    DELETE FROM provider_account_snapshot_runs
    WHERE business_id = ${businessId}
      AND provider = ${provider}
  `;
}

export async function clearAllProviderAccountSnapshotsForProvider(
  provider: string,
): Promise<void> {
  const sql = getDb();
  await sql`
    DELETE FROM provider_account_snapshot_runs
    WHERE provider = ${provider}
  `;
}
