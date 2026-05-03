import { randomUUID } from "node:crypto";
import { getDb, getDbWithTimeout } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  META_AUTHORITATIVE_HISTORY_DAYS,
  META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
} from "@/lib/meta/contract";
import {
  addDaysToIsoDate,
  META_CREATIVE_MEDIA_RETENTION_DAYS,
  META_CREATIVE_WAREHOUSE_HISTORY_DAYS,
} from "@/lib/meta/history";
import type { MetaWarehouseScope } from "@/lib/meta/warehouse-types";
import {
  acquireSyncRunnerLease,
  releaseSyncRunnerLease,
} from "@/lib/sync/worker-health";
import type {
  MetaProtectedPublishedTruthClassReview,
  MetaProtectedPublishedTruthReview,
} from "@/lib/rebuild-truth-review";

export type MetaRetentionTier =
  | "core_authoritative"
  | "breakdown_authoritative"
  | "creative_warehouse"
  | "creative_media";

type MetaRetentionDateColumn = "date" | "day";
type MetaRetentionDeleteStrategy =
  | "date_id"
  | "day_id"
  | "day_ctid"
  | "orphaned_slice_versions"
  | "orphaned_source_manifests";

export interface MetaRetentionPolicyEntry {
  tier: MetaRetentionTier;
  label: string;
  retentionDays: number;
  tableName: string;
  summaryKey: string;
  dateColumn: MetaRetentionDateColumn;
  deleteStrategy: MetaRetentionDeleteStrategy;
  surfaceFilter?: MetaWarehouseScope[] | null;
}

export interface MetaRetentionDryRunRow {
  tier: MetaRetentionTier;
  label: string;
  tableName: string;
  summaryKey: string;
  retentionDays: number;
  cutoffDate: string;
  executionEnabled: boolean;
  surfaceFilter?: MetaWarehouseScope[] | null;
}

export interface MetaRetentionInspectionRow extends MetaRetentionDryRunRow {
  mode: "dry_run" | "execute";
  observed: boolean;
  eligibleRows: number | null;
  eligibleDistinctDays: number | null;
  oldestEligibleValue: string | null;
  newestEligibleValue: string | null;
  retainedRows: number | null;
  latestRetainedValue: string | null;
  protectedRows: number | null;
  protectedDistinctDays: number | null;
  latestProtectedValue: string | null;
}

export interface MetaRetentionExecutionRow extends MetaRetentionInspectionRow {
  deletedRows: number;
}

export type MetaRetentionExecutionDisposition =
  | "dry_run"
  | "global_execute"
  | "scoped_dry_run"
  | "gated_scoped_execute"
  | "scoped_execute";

export interface MetaRetentionRunScope {
  kind: "all_businesses" | "selected_businesses";
  businessIds: string[] | null;
}

export interface MetaRetentionCanaryRuntimeStatus {
  runtimeAvailable: boolean;
  globalExecutionEnabled: boolean;
  businessId: string;
  executeRequested: boolean;
  executeAllowed: boolean;
  mode: "dry_run" | "execute";
  gateReason: string;
}

export type MetaRetentionDeleteScope =
  | "horizon_outside_residue"
  | "orphaned_stale_artifact";

export interface MetaRetentionRunSummary {
  runId: string | null;
  startedAt: string;
  finishedAt: string;
  executionEnabled: boolean;
  mode: "dry_run" | "execute";
  scope: MetaRetentionRunScope;
  executionDisposition: MetaRetentionExecutionDisposition;
  canary: MetaRetentionCanaryRuntimeStatus | null;
  skippedDueToActiveLease: boolean;
  rows: MetaRetentionExecutionRow[];
  totalDeletedRows: number;
  errorMessage?: string | null;
}

export interface MetaRetentionRunRecord {
  id: string;
  executionMode: "dry_run" | "execute";
  executionEnabled: boolean;
  skippedDueToActiveLease: boolean;
  totalDeletedRows: number;
  summaryJson: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const CORE_SURFACES: MetaWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
  "adset_daily",
  "ad_daily",
];
const BREAKDOWN_SURFACES: MetaWarehouseScope[] = ["breakdown_daily"];
const RETENTION_LEASE_BUSINESS_ID = "__meta_retention__";
const RETENTION_LEASE_PROVIDER_SCOPE = "meta_retention";

function toNullableNumber(value: unknown) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function envNumber(
  name:
    | "META_RETENTION_QUERY_TIMEOUT_MS"
    | "META_RETENTION_BATCH_SIZE"
    | "META_RETENTION_LEASE_MINUTES",
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanFlag(
  name:
    | "META_RETENTION_EXECUTION_ENABLED",
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return fallback;
}

function isMetaRetentionRuntimeAvailable(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.DATABASE_URL?.trim());
}

function normalizeBusinessIds(
  businessIds: readonly (string | null | undefined)[] | null | undefined,
) {
  return Array.from(
    new Set(
      (businessIds ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  );
}

async function execCount(query: Promise<unknown>) {
  const rows = await query;
  const first = Array.isArray(rows) ? rows[0] : null;
  const raw = (first as { count?: number | string } | undefined)?.count ?? 0;
  const count = typeof raw === "string" ? Number(raw) : Number(raw);
  return Number.isFinite(count) ? count : 0;
}

async function deleteBatches(
  deleteBatch: () => Promise<number>,
  batchSize: number,
) {
  let totalDeleted = 0;
  while (true) {
    const deleted = await deleteBatch();
    totalDeleted += deleted;
    if (deleted < batchSize) break;
  }
  return totalDeleted;
}

function buildMetaRetentionUnobservedRows(input: {
  asOfDate: string;
  env?: NodeJS.ProcessEnv;
  mode: "dry_run" | "execute";
}) {
  return buildMetaRetentionDryRun(input.asOfDate, input.env).map((row) => ({
    ...row,
    mode: input.mode,
    observed: false,
    eligibleRows: null,
    eligibleDistinctDays: null,
    oldestEligibleValue: null,
    newestEligibleValue: null,
    retainedRows: null,
    latestRetainedValue: null,
    protectedRows: null,
    protectedDistinctDays: null,
    latestProtectedValue: null,
  }));
}

function emptyRetentionRunSummary(input: {
  asOfDate: string;
  executionEnabled: boolean;
  mode: "dry_run" | "execute";
  businessIds?: string[] | null;
  executionDisposition?: MetaRetentionExecutionDisposition;
  canary?: MetaRetentionCanaryRuntimeStatus | null;
  skippedDueToActiveLease?: boolean;
  errorMessage?: string | null;
}) {
  const startedAt = new Date().toISOString();
  const businessIds = normalizeBusinessIds(input.businessIds);
  return {
    runId: null,
    startedAt,
    finishedAt: startedAt,
    executionEnabled: input.executionEnabled,
    mode: input.mode,
    scope:
      businessIds.length > 0
        ? {
            kind: "selected_businesses" as const,
            businessIds,
          }
        : {
            kind: "all_businesses" as const,
            businessIds: null,
          },
    executionDisposition: input.executionDisposition ?? "dry_run",
    canary: input.canary ?? null,
    skippedDueToActiveLease: input.skippedDueToActiveLease ?? false,
    rows: buildMetaRetentionUnobservedRows({
      asOfDate: input.asOfDate,
      env: {
        ...process.env,
        META_RETENTION_EXECUTION_ENABLED: String(input.executionEnabled),
      },
      mode: input.mode,
    }).map((row) => ({
      ...row,
      deletedRows: 0,
    })),
    totalDeletedRows: 0,
    errorMessage: input.errorMessage ?? null,
  } satisfies MetaRetentionRunSummary;
}

export const META_RETENTION_POLICY: MetaRetentionPolicyEntry[] = [
  {
    tier: "core_authoritative",
    label: "Meta core daily authoritative",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_account_daily",
    summaryKey: "meta_account_daily",
    dateColumn: "date",
    deleteStrategy: "date_id",
  },
  {
    tier: "core_authoritative",
    label: "Meta core daily authoritative",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_campaign_daily",
    summaryKey: "meta_campaign_daily",
    dateColumn: "date",
    deleteStrategy: "date_id",
  },
  {
    tier: "core_authoritative",
    label: "Meta core daily authoritative",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_adset_daily",
    summaryKey: "meta_adset_daily",
    dateColumn: "date",
    deleteStrategy: "date_id",
  },
  {
    tier: "core_authoritative",
    label: "Meta core daily authoritative",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_ad_daily",
    summaryKey: "meta_ad_daily",
    dateColumn: "date",
    deleteStrategy: "date_id",
  },
  {
    tier: "creative_warehouse",
    label: "Meta creative daily warehouse",
    retentionDays: META_CREATIVE_WAREHOUSE_HISTORY_DAYS,
    tableName: "meta_creative_daily",
    summaryKey: "meta_creative_daily",
    dateColumn: "date",
    deleteStrategy: "date_id",
  },
  {
    tier: "creative_media",
    label: "Meta creative media warehouse",
    retentionDays: META_CREATIVE_MEDIA_RETENTION_DAYS,
    tableName: "meta_creative_media",
    summaryKey: "meta_creative_media",
    dateColumn: "date",
    deleteStrategy: "date_id",
  },
  {
    tier: "breakdown_authoritative",
    label: "Meta breakdown authoritative",
    retentionDays: META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_breakdown_daily",
    summaryKey: "meta_breakdown_daily",
    dateColumn: "date",
    deleteStrategy: "date_id",
  },
  {
    tier: "core_authoritative",
    label: "Meta authoritative publication pointers",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_publication_pointers",
    summaryKey: "meta_authoritative_publication_pointers:core",
    dateColumn: "day",
    deleteStrategy: "day_id",
    surfaceFilter: CORE_SURFACES,
  },
  {
    tier: "breakdown_authoritative",
    label: "Meta authoritative publication pointers",
    retentionDays: META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_publication_pointers",
    summaryKey: "meta_authoritative_publication_pointers:breakdown",
    dateColumn: "day",
    deleteStrategy: "day_id",
    surfaceFilter: BREAKDOWN_SURFACES,
  },
  {
    tier: "core_authoritative",
    label: "Meta authoritative slice versions",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_slice_versions",
    summaryKey: "meta_authoritative_slice_versions:core",
    dateColumn: "day",
    deleteStrategy: "orphaned_slice_versions",
    surfaceFilter: CORE_SURFACES,
  },
  {
    tier: "breakdown_authoritative",
    label: "Meta authoritative slice versions",
    retentionDays: META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_slice_versions",
    summaryKey: "meta_authoritative_slice_versions:breakdown",
    dateColumn: "day",
    deleteStrategy: "orphaned_slice_versions",
    surfaceFilter: BREAKDOWN_SURFACES,
  },
  {
    tier: "core_authoritative",
    label: "Meta authoritative source manifests",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_source_manifests",
    summaryKey: "meta_authoritative_source_manifests:core",
    dateColumn: "day",
    deleteStrategy: "orphaned_source_manifests",
    surfaceFilter: CORE_SURFACES,
  },
  {
    tier: "breakdown_authoritative",
    label: "Meta authoritative source manifests",
    retentionDays: META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_source_manifests",
    summaryKey: "meta_authoritative_source_manifests:breakdown",
    dateColumn: "day",
    deleteStrategy: "orphaned_source_manifests",
    surfaceFilter: BREAKDOWN_SURFACES,
  },
  {
    tier: "core_authoritative",
    label: "Meta authoritative reconciliation events",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_reconciliation_events",
    summaryKey: "meta_authoritative_reconciliation_events:core",
    dateColumn: "day",
    deleteStrategy: "day_id",
    surfaceFilter: CORE_SURFACES,
  },
  {
    tier: "breakdown_authoritative",
    label: "Meta authoritative reconciliation events",
    retentionDays: META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_reconciliation_events",
    summaryKey: "meta_authoritative_reconciliation_events:breakdown",
    dateColumn: "day",
    deleteStrategy: "day_id",
    surfaceFilter: BREAKDOWN_SURFACES,
  },
  {
    tier: "core_authoritative",
    label: "Meta authoritative day state",
    retentionDays: META_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_day_state",
    summaryKey: "meta_authoritative_day_state:core",
    dateColumn: "day",
    deleteStrategy: "day_ctid",
    surfaceFilter: CORE_SURFACES,
  },
  {
    tier: "breakdown_authoritative",
    label: "Meta authoritative day state",
    retentionDays: META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
    tableName: "meta_authoritative_day_state",
    summaryKey: "meta_authoritative_day_state:breakdown",
    dateColumn: "day",
    deleteStrategy: "day_ctid",
    surfaceFilter: BREAKDOWN_SURFACES,
  },
];

const META_PROTECTED_PUBLISHED_TRUTH_CLASS_DEFS: Array<{
  key: MetaProtectedPublishedTruthClassReview["key"];
  label: string;
  summaryKeys: string[];
}> = [
  {
    key: "core_daily_rows",
    label: "Protected core daily rows",
    summaryKeys: [
      "meta_account_daily",
      "meta_campaign_daily",
      "meta_adset_daily",
      "meta_ad_daily",
    ],
  },
  {
    key: "breakdown_daily_rows",
    label: "Protected breakdown daily rows",
    summaryKeys: ["meta_breakdown_daily"],
  },
  {
    key: "active_publication_pointers",
    label: "Active publication pointers",
    summaryKeys: [
      "meta_authoritative_publication_pointers:core",
      "meta_authoritative_publication_pointers:breakdown",
    ],
  },
  {
    key: "active_published_slice_versions",
    label: "Active published slice versions",
    summaryKeys: [
      "meta_authoritative_slice_versions:core",
      "meta_authoritative_slice_versions:breakdown",
    ],
  },
  {
    key: "active_source_manifests",
    label: "Active source manifests",
    summaryKeys: [
      "meta_authoritative_source_manifests:core",
      "meta_authoritative_source_manifests:breakdown",
    ],
  },
  {
    key: "published_day_state",
    label: "Published day-state rows",
    summaryKeys: [
      "meta_authoritative_day_state:core",
      "meta_authoritative_day_state:breakdown",
    ],
  },
];

export const META_RETENTION_REQUIRED_TABLES = [
  "meta_account_daily",
  "meta_campaign_daily",
  "meta_adset_daily",
  "meta_ad_daily",
  "meta_creative_daily",
  "meta_creative_media",
  "meta_breakdown_daily",
  "meta_authoritative_publication_pointers",
  "meta_authoritative_slice_versions",
  "meta_authoritative_source_manifests",
  "meta_authoritative_reconciliation_events",
  "meta_authoritative_day_state",
  "meta_retention_runs",
] as const;

export function isMetaRetentionExecutionEnabled(env: NodeJS.ProcessEnv = process.env) {
  return readBooleanFlag("META_RETENTION_EXECUTION_ENABLED", false, env);
}

export function getMetaRetentionRuntimeStatus(env: NodeJS.ProcessEnv = process.env) {
  const executionEnabled = isMetaRetentionExecutionEnabled(env);
  return {
    runtimeAvailable: isMetaRetentionRuntimeAvailable(env),
    executionEnabled,
    mode: executionEnabled ? ("execute" as const) : ("dry_run" as const),
    gateReason: executionEnabled
      ? "Meta retention execution is explicitly enabled."
      : "Meta retention execution is disabled by default. Dry-run remains available.",
  };
}

export function getMetaRetentionDeleteScope(
  row:
    | Pick<MetaRetentionExecutionRow, "summaryKey">
    | Pick<MetaRetentionPolicyEntry, "summaryKey" | "deleteStrategy">,
): MetaRetentionDeleteScope {
  if ("deleteStrategy" in row) {
    return row.deleteStrategy === "orphaned_slice_versions" ||
      row.deleteStrategy === "orphaned_source_manifests"
      ? "orphaned_stale_artifact"
      : "horizon_outside_residue";
  }
  return row.summaryKey.startsWith("meta_authoritative_slice_versions") ||
    row.summaryKey.startsWith("meta_authoritative_source_manifests")
    ? "orphaned_stale_artifact"
    : "horizon_outside_residue";
}

export function getMetaRetentionCanaryRuntimeStatus(input: {
  businessId: string;
  executeRequested?: boolean;
  env?: NodeJS.ProcessEnv;
}): MetaRetentionCanaryRuntimeStatus {
  const env = input.env ?? process.env;
  const runtimeAvailable = isMetaRetentionRuntimeAvailable(env);
  const globalExecutionEnabled = isMetaRetentionExecutionEnabled(env);
  const executeRequested = Boolean(input.executeRequested);
  let gateReason =
    "Scoped Meta retention verification defaults to dry-run until --execute is supplied.";
  let executeAllowed = false;

  if (!runtimeAvailable) {
    gateReason = "Scoped Meta retention verification requires DATABASE_URL.";
  } else if (!executeRequested) {
    gateReason =
      "Scoped Meta retention verification defaults to dry-run until --execute is supplied.";
  } else if (!globalExecutionEnabled) {
    gateReason =
      "META_RETENTION_EXECUTION_ENABLED is disabled. Set it to true to allow globally enabled execute mode.";
  } else {
    executeAllowed = true;
    gateReason =
      "Meta retention execute mode is globally enabled. The scoped command will execute only the requested business slice.";
  }

  return {
    runtimeAvailable,
    globalExecutionEnabled,
    businessId: input.businessId,
    executeRequested,
    executeAllowed,
    mode: executeAllowed ? "execute" : "dry_run",
    gateReason,
  };
}

export function buildMetaRetentionDryRun(
  asOfDate: string,
  env: NodeJS.ProcessEnv = process.env,
): MetaRetentionDryRunRow[] {
  const executionEnabled = isMetaRetentionExecutionEnabled(env);
  return META_RETENTION_POLICY.map((entry) => ({
    tier: entry.tier,
    label: entry.label,
    tableName: entry.tableName,
    summaryKey: entry.summaryKey,
    retentionDays: entry.retentionDays,
    cutoffDate: addDaysToIsoDate(asOfDate, -entry.retentionDays),
    executionEnabled,
    surfaceFilter: entry.surfaceFilter ?? null,
  }));
}

async function recordMetaRetentionRun(
  summary: MetaRetentionRunSummary,
): Promise<MetaRetentionRunSummary> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_retention_runs"],
  }).catch(() => null);
  if (!readiness?.ready || !isMetaRetentionRuntimeAvailable()) {
    return summary;
  }
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_retention_runs (
      execution_mode,
      execution_enabled,
      skipped_due_to_active_lease,
      total_deleted_rows,
      summary_json,
      error_message,
      started_at,
      finished_at,
      updated_at
    )
    VALUES (
      ${summary.mode},
      ${summary.executionEnabled},
      ${summary.skippedDueToActiveLease},
      ${summary.totalDeletedRows},
      ${JSON.stringify({
        scope: summary.scope,
        executionDisposition: summary.executionDisposition,
        canary: summary.canary,
        rows: summary.rows,
      })}::jsonb,
      ${summary.errorMessage ?? null},
      ${summary.startedAt},
      ${summary.finishedAt},
      now()
    )
    RETURNING id
  `) as Array<{ id: string }>;
  return {
    ...summary,
    runId: rows[0]?.id ?? summary.runId,
  };
}

export async function getLatestMetaRetentionRun() {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_retention_runs"],
  }).catch(() => null);
  if (!readiness?.ready || !isMetaRetentionRuntimeAvailable()) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_retention_runs
    ORDER BY finished_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    executionMode: String(row.execution_mode ?? "dry_run") as "dry_run" | "execute",
    executionEnabled: Boolean(row.execution_enabled),
    skippedDueToActiveLease: Boolean(row.skipped_due_to_active_lease),
    totalDeletedRows: Number(row.total_deleted_rows ?? 0),
    summaryJson:
      row.summary_json && typeof row.summary_json === "object"
        ? (row.summary_json as Record<string, unknown>)
        : {},
    errorMessage: row.error_message ? String(row.error_message) : null,
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : new Date().toISOString(),
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
  } satisfies MetaRetentionRunRecord;
}

export async function getLatestMetaRetentionCanaryRun(businessId: string) {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_retention_runs"],
  }).catch(() => null);
  if (!readiness?.ready || !isMetaRetentionRuntimeAvailable()) {
    return null;
  }
  const sql = getDbWithTimeout(30_000);
  const rows = (await sql.query(
    `
      SELECT *
      FROM meta_retention_runs
      WHERE summary_json -> 'canary' ->> 'businessId' = $1
      ORDER BY finished_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    `,
    [businessId],
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    executionMode: String(row.execution_mode ?? "dry_run") as "dry_run" | "execute",
    executionEnabled: Boolean(row.execution_enabled),
    skippedDueToActiveLease: Boolean(row.skipped_due_to_active_lease),
    totalDeletedRows: Number(row.total_deleted_rows ?? 0),
    summaryJson:
      row.summary_json && typeof row.summary_json === "object"
        ? (row.summary_json as Record<string, unknown>)
        : {},
    errorMessage: row.error_message ? String(row.error_message) : null,
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : new Date().toISOString(),
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
    updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
  } satisfies MetaRetentionRunRecord;
}

function surfaceFilterParams(entry: MetaRetentionPolicyEntry) {
  return (entry.surfaceFilter ?? []) as string[];
}

function metaSurfaceForDailyRetentionTable(
  tableName: string,
): MetaWarehouseScope | null {
  switch (tableName) {
    case "meta_account_daily":
      return "account_daily";
    case "meta_campaign_daily":
      return "campaign_daily";
    case "meta_adset_daily":
      return "adset_daily";
    case "meta_ad_daily":
      return "ad_daily";
    case "meta_breakdown_daily":
      return "breakdown_daily";
    default:
      return null;
  }
}

async function inspectMetaRetentionAggregate(input: {
  sql: ReturnType<typeof getDbWithTimeout>;
  query: string;
  params: unknown[];
}) {
  const rows = (await input.sql.query(input.query, input.params)) as Array<
    Record<string, unknown>
  >;
  const row = rows[0] ?? {};
  return {
    observed: true,
    eligibleRows: toNullableNumber(row.eligible_rows),
    eligibleDistinctDays: toNullableNumber(row.eligible_distinct_days),
    oldestEligibleValue: row.oldest_eligible_value
      ? String(row.oldest_eligible_value)
      : null,
    newestEligibleValue: row.newest_eligible_value
      ? String(row.newest_eligible_value)
      : null,
    retainedRows: toNullableNumber(row.retained_rows),
    latestRetainedValue: row.latest_retained_value
      ? String(row.latest_retained_value)
      : null,
    protectedRows: toNullableNumber(row.protected_rows),
    protectedDistinctDays: toNullableNumber(row.protected_distinct_days),
    latestProtectedValue: row.latest_protected_value
      ? String(row.latest_protected_value)
      : null,
  } satisfies Pick<
    MetaRetentionInspectionRow,
    | "observed"
    | "eligibleRows"
    | "eligibleDistinctDays"
    | "oldestEligibleValue"
    | "newestEligibleValue"
    | "retainedRows"
    | "latestRetainedValue"
    | "protectedRows"
    | "protectedDistinctDays"
    | "latestProtectedValue"
  >;
}

async function inspectMetaRetentionEntryWindow(input: {
  sql: ReturnType<typeof getDbWithTimeout>;
  entry: MetaRetentionPolicyEntry;
  cutoffDate: string;
  businessIds?: string[] | null;
}) {
  const surfaceFilter = surfaceFilterParams(input.entry);
  const businessIds = normalizeBusinessIds(input.businessIds);
  const scopedBusinessIds = businessIds.length > 0 ? businessIds : null;
  const dateColumn = input.entry.dateColumn;
  const distinctAccountDaysSql = `COUNT(DISTINCT CONCAT(business_id, ':', provider_account_id, ':', retention_value::text))`;
  const aggregateSql = `
    SELECT
      COUNT(*) FILTER (WHERE retention_value < $1)::int AS eligible_rows,
      ${distinctAccountDaysSql}
        FILTER (WHERE retention_value < $1)::int AS eligible_distinct_days,
      MIN(retention_value) FILTER (WHERE retention_value < $1)::text AS oldest_eligible_value,
      MAX(retention_value) FILTER (WHERE retention_value < $1)::text AS newest_eligible_value,
      COUNT(*) FILTER (WHERE retention_value >= $1)::int AS retained_rows,
      MAX(retention_value) FILTER (WHERE retention_value >= $1)::text AS latest_retained_value,
      COUNT(*) FILTER (WHERE retention_value >= $1 AND protected_active)::int AS protected_rows,
      ${distinctAccountDaysSql}
        FILTER (WHERE retention_value >= $1 AND protected_active)::int AS protected_distinct_days,
      MAX(retention_value) FILTER (WHERE retention_value >= $1 AND protected_active)::text AS latest_protected_value
    FROM inspected
  `;

  const dailySurface = metaSurfaceForDailyRetentionTable(input.entry.tableName);
  if (dailySurface) {
    return inspectMetaRetentionAggregate({
      sql: input.sql,
      query: `
        WITH inspected AS (
          SELECT
            target.business_id,
            target.provider_account_id,
            target.${dateColumn} AS retention_value,
            EXISTS (
              SELECT 1
              FROM meta_authoritative_publication_pointers pointer
              WHERE pointer.business_id = target.business_id
                AND pointer.provider_account_id = target.provider_account_id
                AND pointer.day = target.${dateColumn}
                AND pointer.surface = $2
            ) AS protected_active
          FROM ${input.entry.tableName} target
          WHERE ($3::text[] IS NULL OR target.business_id = ANY($3::text[]))
        )
        ${aggregateSql}
      `,
      params: [input.cutoffDate, dailySurface, scopedBusinessIds],
    });
  }

  switch (input.entry.tableName) {
    case "meta_authoritative_publication_pointers":
      return inspectMetaRetentionAggregate({
        sql: input.sql,
        query: `
          WITH inspected AS (
            SELECT
              target.business_id,
              target.provider_account_id,
              target.${dateColumn} AS retention_value,
              TRUE AS protected_active
            FROM ${input.entry.tableName} target
            WHERE target.surface = ANY($2::text[])
              AND ($3::text[] IS NULL OR target.business_id = ANY($3::text[]))
          )
          ${aggregateSql}
        `,
        params: [input.cutoffDate, surfaceFilter, scopedBusinessIds],
      });
    case "meta_authoritative_slice_versions":
      return inspectMetaRetentionAggregate({
        sql: input.sql,
        query: `
          WITH inspected AS (
            SELECT
              target.business_id,
              target.provider_account_id,
              target.${dateColumn} AS retention_value,
              EXISTS (
                SELECT 1
                FROM meta_authoritative_publication_pointers pointer
                WHERE pointer.active_slice_version_id = target.id
              ) AS protected_active
            FROM ${input.entry.tableName} target
            WHERE target.surface = ANY($2::text[])
              AND ($3::text[] IS NULL OR target.business_id = ANY($3::text[]))
          )
          ${aggregateSql}
        `,
        params: [input.cutoffDate, surfaceFilter, scopedBusinessIds],
      });
    case "meta_authoritative_source_manifests":
      return inspectMetaRetentionAggregate({
        sql: input.sql,
        query: `
          WITH inspected AS (
            SELECT
              target.business_id,
              target.provider_account_id,
              target.${dateColumn} AS retention_value,
              EXISTS (
                SELECT 1
                FROM meta_authoritative_slice_versions slice
                INNER JOIN meta_authoritative_publication_pointers pointer
                  ON pointer.active_slice_version_id = slice.id
                WHERE slice.manifest_id = target.id
              ) AS protected_active
            FROM ${input.entry.tableName} target
            WHERE target.surface = ANY($2::text[])
              AND ($3::text[] IS NULL OR target.business_id = ANY($3::text[]))
          )
          ${aggregateSql}
        `,
        params: [input.cutoffDate, surfaceFilter, scopedBusinessIds],
      });
    case "meta_authoritative_reconciliation_events":
      return inspectMetaRetentionAggregate({
        sql: input.sql,
        query: `
          WITH inspected AS (
            SELECT
              target.business_id,
              target.provider_account_id,
              target.${dateColumn} AS retention_value,
              EXISTS (
                SELECT 1
                FROM meta_authoritative_publication_pointers pointer
                WHERE pointer.business_id = target.business_id
                  AND pointer.provider_account_id = target.provider_account_id
                  AND pointer.day = target.${dateColumn}
                  AND pointer.surface = target.surface
              ) AS protected_active
            FROM ${input.entry.tableName} target
            WHERE target.surface = ANY($2::text[])
              AND ($3::text[] IS NULL OR target.business_id = ANY($3::text[]))
          )
          ${aggregateSql}
        `,
        params: [input.cutoffDate, surfaceFilter, scopedBusinessIds],
      });
    case "meta_authoritative_day_state":
      return inspectMetaRetentionAggregate({
        sql: input.sql,
        query: `
          WITH inspected AS (
            SELECT
              target.business_id,
              target.provider_account_id,
              target.${dateColumn} AS retention_value,
              (
                target.state = 'published'
                AND target.last_publication_pointer_id IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM meta_authoritative_publication_pointers pointer
                  WHERE pointer.id = target.last_publication_pointer_id
                )
              ) AS protected_active
            FROM ${input.entry.tableName} target
            WHERE target.surface = ANY($2::text[])
              AND ($3::text[] IS NULL OR target.business_id = ANY($3::text[]))
          )
          ${aggregateSql}
        `,
        params: [input.cutoffDate, surfaceFilter, scopedBusinessIds],
      });
    default:
      return {
        observed: false,
        eligibleRows: null,
        eligibleDistinctDays: null,
        oldestEligibleValue: null,
        newestEligibleValue: null,
        retainedRows: null,
        latestRetainedValue: null,
        protectedRows: null,
        protectedDistinctDays: null,
        latestProtectedValue: null,
      } satisfies Pick<
        MetaRetentionInspectionRow,
        | "observed"
        | "eligibleRows"
        | "eligibleDistinctDays"
        | "oldestEligibleValue"
        | "newestEligibleValue"
        | "retainedRows"
        | "latestRetainedValue"
        | "protectedRows"
        | "protectedDistinctDays"
        | "latestProtectedValue"
      >;
  }
}

async function executeMetaRetentionEntryDelete(input: {
  sql: ReturnType<typeof getDbWithTimeout>;
  entry: MetaRetentionPolicyEntry;
  cutoffDate: string;
  batchSize: number;
  businessIds?: string[] | null;
}) {
  const surfaceFilter = surfaceFilterParams(input.entry);
  const businessIds = normalizeBusinessIds(input.businessIds);
  const scopedBusinessIds = businessIds.length > 0 ? businessIds : null;
  switch (input.entry.deleteStrategy) {
    case "date_id":
      return deleteBatches(
        () =>
          execCount(
            input.sql.query(
              `
                WITH candidates AS (
                  SELECT id
                  FROM ${input.entry.tableName}
                  WHERE ${input.entry.dateColumn} < $1
                    AND ($2::text[] IS NULL OR business_id = ANY($2::text[]))
                  ORDER BY ${input.entry.dateColumn} ASC, id ASC
                  LIMIT $3
                  FOR UPDATE SKIP LOCKED
                ),
                deleted AS (
                  DELETE FROM ${input.entry.tableName} target
                  USING candidates
                  WHERE target.id = candidates.id
                  RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM deleted
              `,
              [input.cutoffDate, scopedBusinessIds, input.batchSize],
            ),
          ),
        input.batchSize,
      );
    case "day_id":
      return deleteBatches(
        () =>
          execCount(
            input.sql.query(
              `
                WITH candidates AS (
                  SELECT id
                  FROM ${input.entry.tableName}
                  WHERE ${input.entry.dateColumn} < $1
                    AND surface = ANY($2::text[])
                    AND ($3::text[] IS NULL OR business_id = ANY($3::text[]))
                  ORDER BY ${input.entry.dateColumn} ASC, id ASC
                  LIMIT $4
                  FOR UPDATE SKIP LOCKED
                ),
                deleted AS (
                  DELETE FROM ${input.entry.tableName} target
                  USING candidates
                  WHERE target.id = candidates.id
                  RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM deleted
              `,
              [input.cutoffDate, surfaceFilter, scopedBusinessIds, input.batchSize],
            ),
          ),
        input.batchSize,
      );
    case "day_ctid":
      return deleteBatches(
        () =>
          execCount(
            input.sql.query(
              `
                WITH candidates AS (
                  SELECT ctid
                  FROM ${input.entry.tableName}
                  WHERE ${input.entry.dateColumn} < $1
                    AND surface = ANY($2::text[])
                    AND ($3::text[] IS NULL OR business_id = ANY($3::text[]))
                  ORDER BY ${input.entry.dateColumn} ASC
                  LIMIT $4
                ),
                deleted AS (
                  DELETE FROM ${input.entry.tableName} target
                  USING candidates
                  WHERE target.ctid = candidates.ctid
                  RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM deleted
              `,
              [input.cutoffDate, surfaceFilter, scopedBusinessIds, input.batchSize],
            ),
          ),
        input.batchSize,
      );
    case "orphaned_slice_versions":
      return deleteBatches(
        () =>
          execCount(
            input.sql.query(
              `
                WITH candidates AS (
                  SELECT slice.id
                  FROM meta_authoritative_slice_versions slice
                  LEFT JOIN meta_authoritative_publication_pointers pointer
                    ON pointer.active_slice_version_id = slice.id
                  WHERE slice.day < $1
                    AND slice.surface = ANY($2::text[])
                    AND ($3::text[] IS NULL OR slice.business_id = ANY($3::text[]))
                    AND pointer.id IS NULL
                  ORDER BY slice.day ASC, slice.id ASC
                  LIMIT $4
                  FOR UPDATE OF slice SKIP LOCKED
                ),
                deleted AS (
                  DELETE FROM meta_authoritative_slice_versions target
                  USING candidates
                  WHERE target.id = candidates.id
                  RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM deleted
              `,
              [input.cutoffDate, surfaceFilter, scopedBusinessIds, input.batchSize],
            ),
          ),
        input.batchSize,
      );
    case "orphaned_source_manifests":
      return deleteBatches(
        () =>
          execCount(
            input.sql.query(
              `
                WITH candidates AS (
                  SELECT manifest.id
                  FROM meta_authoritative_source_manifests manifest
                  LEFT JOIN meta_authoritative_slice_versions slice
                    ON slice.manifest_id = manifest.id
                  WHERE manifest.day < $1
                    AND manifest.surface = ANY($2::text[])
                    AND ($3::text[] IS NULL OR manifest.business_id = ANY($3::text[]))
                    AND slice.id IS NULL
                  ORDER BY manifest.day ASC, manifest.id ASC
                  LIMIT $4
                  FOR UPDATE OF manifest SKIP LOCKED
                ),
                deleted AS (
                  DELETE FROM meta_authoritative_source_manifests target
                  USING candidates
                  WHERE target.id = candidates.id
                  RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM deleted
              `,
              [input.cutoffDate, surfaceFilter, scopedBusinessIds, input.batchSize],
            ),
          ),
        input.batchSize,
      );
  }
}

export async function executeMetaRetentionPolicy(input: {
  asOfDate: string;
  env?: NodeJS.ProcessEnv;
  forceExecute?: boolean;
  businessIds?: string[] | null;
  executionDisposition?: MetaRetentionExecutionDisposition;
  canary?: MetaRetentionCanaryRuntimeStatus | null;
}) {
  const env = input.env ?? process.env;
  const runtime = getMetaRetentionRuntimeStatus(env);
  const executionEnabled = runtime.executionEnabled;
  const businessIds = normalizeBusinessIds(input.businessIds);
  const mode =
    executionEnabled || input.forceExecute ? ("execute" as const) : ("dry_run" as const);
  const executionDisposition =
    input.executionDisposition ??
    (input.forceExecute
      ? "scoped_execute"
      : executionEnabled
        ? "global_execute"
        : "dry_run");
  const scope =
    businessIds.length > 0
      ? {
          kind: "selected_businesses" as const,
          businessIds,
        }
      : {
          kind: "all_businesses" as const,
          businessIds: null,
        };

  if (!isMetaRetentionRuntimeAvailable(env)) {
    return emptyRetentionRunSummary({
      asOfDate: input.asOfDate,
      executionEnabled,
      mode,
      businessIds,
      executionDisposition,
      canary: input.canary ?? null,
      errorMessage: "DATABASE_URL is not configured.",
    });
  }

  await assertDbSchemaReady({
    tables: [...META_RETENTION_REQUIRED_TABLES],
    context: "meta_retention",
  });
  const sql = getDbWithTimeout(envNumber("META_RETENTION_QUERY_TIMEOUT_MS", 30_000, env));
  const batchSize = envNumber("META_RETENTION_BATCH_SIZE", 250, env);
  const leaseMinutes = envNumber("META_RETENTION_LEASE_MINUTES", 15, env);
  const leaseOwner = `meta-retention:${process.pid}:${randomUUID().slice(0, 8)}`;
  const leaseAcquired = await acquireSyncRunnerLease({
    businessId: RETENTION_LEASE_BUSINESS_ID,
    providerScope: RETENTION_LEASE_PROVIDER_SCOPE,
    leaseOwner,
    leaseMinutes,
  }).catch(() => false);

  if (!leaseAcquired) {
    return recordMetaRetentionRun(
      emptyRetentionRunSummary({
        asOfDate: input.asOfDate,
        executionEnabled,
        mode,
        businessIds,
        executionDisposition,
        canary: input.canary ?? null,
        skippedDueToActiveLease: true,
      }),
    );
  }

  const startedAt = new Date().toISOString();
  try {
    const rows: MetaRetentionExecutionRow[] = [];
    for (const entry of META_RETENTION_POLICY) {
      const cutoffDate = addDaysToIsoDate(input.asOfDate, -entry.retentionDays);
      const inspection = await inspectMetaRetentionEntryWindow({
        sql,
        entry,
        cutoffDate,
        businessIds,
      });
      let deletedRows = 0;
      if (mode === "execute") {
        deletedRows = await executeMetaRetentionEntryDelete({
          sql,
          entry,
          cutoffDate,
          batchSize,
          businessIds,
        });
      }
      rows.push({
        tier: entry.tier,
        label: entry.label,
        tableName: entry.tableName,
        summaryKey: entry.summaryKey,
        retentionDays: entry.retentionDays,
        cutoffDate,
        executionEnabled,
        ...inspection,
        deletedRows,
        mode,
        surfaceFilter: entry.surfaceFilter ?? null,
      });
    }

    const summary = {
      runId: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      executionEnabled,
      mode,
      scope,
      executionDisposition,
      canary: input.canary ?? null,
      skippedDueToActiveLease: false,
      rows,
      totalDeletedRows: rows.reduce((sum, row) => sum + row.deletedRows, 0),
      errorMessage: null,
    } satisfies MetaRetentionRunSummary;
    return await recordMetaRetentionRun(summary);
  } catch (error) {
    const failedSummary = {
      runId: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      executionEnabled,
      mode,
      scope,
      executionDisposition,
      canary: input.canary ?? null,
      skippedDueToActiveLease: false,
      rows: buildMetaRetentionDryRun(input.asOfDate, env).map((row) => ({
        ...row,
        mode,
        observed: false,
        eligibleRows: null,
        eligibleDistinctDays: null,
        oldestEligibleValue: null,
        newestEligibleValue: null,
        retainedRows: null,
        latestRetainedValue: null,
        protectedRows: null,
        protectedDistinctDays: null,
        latestProtectedValue: null,
        deletedRows: 0,
      })),
      totalDeletedRows: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
    } satisfies MetaRetentionRunSummary;
    await recordMetaRetentionRun(failedSummary).catch(() => null);
    throw error;
  } finally {
    await releaseSyncRunnerLease({
      businessId: RETENTION_LEASE_BUSINESS_ID,
      providerScope: RETENTION_LEASE_PROVIDER_SCOPE,
      leaseOwner,
    }).catch(() => null);
  }
}

async function inspectMetaRetentionDryRunRows(input: {
  asOfDate: string;
  env?: NodeJS.ProcessEnv;
  businessIds?: string[] | null;
}) {
  const env = input.env ?? process.env;
  const businessIds = normalizeBusinessIds(input.businessIds);
  if (!isMetaRetentionRuntimeAvailable(env)) {
    return buildMetaRetentionUnobservedRows({
      asOfDate: input.asOfDate,
      env,
      mode: "dry_run",
    });
  }

  await assertDbSchemaReady({
    tables: [...META_RETENTION_REQUIRED_TABLES],
    context: "meta_retention_dry_run",
  });
  const sql = getDbWithTimeout(envNumber("META_RETENTION_QUERY_TIMEOUT_MS", 30_000, env));

  return Promise.all(
    buildMetaRetentionDryRun(input.asOfDate, env).map(async (row) => ({
      ...row,
      mode: "dry_run" as const,
      ...(await inspectMetaRetentionEntryWindow({
        sql,
        entry:
          META_RETENTION_POLICY.find(
            (entry) => entry.summaryKey === row.summaryKey,
          ) ?? META_RETENTION_POLICY[0],
        cutoffDate: row.cutoffDate,
        businessIds,
      })),
    })),
  );
}

export async function executeMetaRetentionPolicyDryRunOnly(input: {
  asOfDate: string;
  env?: NodeJS.ProcessEnv;
  businessIds?: string[] | null;
}) {
  return {
    executionEnabled: isMetaRetentionExecutionEnabled(input.env),
    dryRun: await inspectMetaRetentionDryRunRows(input),
  };
}

function buildUnobservedMetaProtectedPublishedTruthReview(input: {
  asOfDate: string;
  businessIds?: string[] | null;
}): MetaProtectedPublishedTruthReview {
  const businessIds = normalizeBusinessIds(input.businessIds);
  return {
    runtimeAvailable: false,
    asOfDate: input.asOfDate,
    scope:
      businessIds.length > 0
        ? {
            kind: "selected_businesses",
            businessIds,
          }
        : {
            kind: "all_businesses",
            businessIds: null,
          },
    hasNonZeroProtectedPublishedRows: false,
    protectedPublishedRows: 0,
    activePublicationPointerRows: 0,
    protectedTruthClassesPresent: [],
    protectedTruthClassesAbsent: META_PROTECTED_PUBLISHED_TRUTH_CLASS_DEFS.map(
      (entry) => entry.key,
    ),
    classes: META_PROTECTED_PUBLISHED_TRUTH_CLASS_DEFS.map((entry) => ({
      key: entry.key,
      label: entry.label,
      present: false,
      observed: false,
      protectedRows: 0,
      latestProtectedValue: null,
    })),
  };
}

export async function getMetaProtectedPublishedTruthReview(input?: {
  asOfDate?: string | null;
  env?: NodeJS.ProcessEnv;
  businessIds?: string[] | null;
}): Promise<MetaProtectedPublishedTruthReview> {
  const env = input?.env ?? process.env;
  const asOfDate = input?.asOfDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const businessIds = normalizeBusinessIds(input?.businessIds);

  if (!isMetaRetentionRuntimeAvailable(env)) {
    return buildUnobservedMetaProtectedPublishedTruthReview({
      asOfDate,
      businessIds,
    });
  }

  await assertDbSchemaReady({
    tables: [...META_RETENTION_REQUIRED_TABLES],
    context: "meta_protected_published_truth_review",
  });

  const sql = getDbWithTimeout(envNumber("META_RETENTION_QUERY_TIMEOUT_MS", 30_000, env));
  const inspections = await Promise.all(
    META_PROTECTED_PUBLISHED_TRUTH_CLASS_DEFS.map(async (classDef) => {
      const rows = await Promise.all(
        classDef.summaryKeys.map(async (summaryKey) => {
          const policyEntry = META_RETENTION_POLICY.find((entry) => entry.summaryKey === summaryKey);
          if (!policyEntry) {
            return {
              observed: false,
              protectedRows: null,
              latestProtectedValue: null,
            };
          }
          return inspectMetaRetentionEntryWindow({
            sql,
            entry: policyEntry,
            cutoffDate: addDaysToIsoDate(asOfDate, -policyEntry.retentionDays),
            businessIds,
          });
        }),
      );

      const protectedRows = rows.reduce(
        (sum, row) => sum + Math.max(0, Number(row.protectedRows ?? 0)),
        0,
      );
      const latestProtectedValue =
        rows
          .map((row) => row.latestProtectedValue ?? null)
          .filter((value): value is string => Boolean(value))
          .sort((left, right) => right.localeCompare(left))[0] ?? null;
      return {
        key: classDef.key,
        label: classDef.label,
        present: protectedRows > 0,
        observed: rows.every((row) => row.observed),
        protectedRows,
        latestProtectedValue,
      } satisfies MetaProtectedPublishedTruthClassReview;
    }),
  );

  const coreRows =
    inspections.find((row) => row.key === "core_daily_rows")?.protectedRows ?? 0;
  const breakdownRows =
    inspections.find((row) => row.key === "breakdown_daily_rows")?.protectedRows ?? 0;
  const activePublicationPointerRows =
    inspections.find((row) => row.key === "active_publication_pointers")?.protectedRows ?? 0;

  return {
    runtimeAvailable: true,
    asOfDate,
    scope:
      businessIds.length > 0
        ? {
            kind: "selected_businesses",
            businessIds,
          }
        : {
            kind: "all_businesses",
            businessIds: null,
          },
    hasNonZeroProtectedPublishedRows: coreRows + breakdownRows > 0,
    protectedPublishedRows: coreRows + breakdownRows,
    activePublicationPointerRows,
    protectedTruthClassesPresent: inspections
      .filter((row) => row.present)
      .map((row) => row.key),
    protectedTruthClassesAbsent: inspections
      .filter((row) => !row.present)
      .map((row) => row.key),
    classes: inspections,
  };
}

export function getMetaRetentionRunMetadata(
  run:
    | Pick<MetaRetentionRunRecord, "summaryJson" | "executionMode">
    | null
    | undefined,
) {
  const scopeValue =
    run?.summaryJson?.scope && typeof run.summaryJson.scope === "object"
      ? (run.summaryJson.scope as Record<string, unknown>)
      : null;
  const canaryValue =
    run?.summaryJson?.scopedExecution &&
    typeof run.summaryJson.scopedExecution === "object"
      ? (run.summaryJson.scopedExecution as Record<string, unknown>)
      : run?.summaryJson?.canary && typeof run.summaryJson.canary === "object"
        ? (run.summaryJson.canary as Record<string, unknown>)
      : null;
  const scopeKind =
    scopeValue?.kind === "selected_businesses" || scopeValue?.kind === "canary_businesses"
      ? "selected_businesses"
      : "all_businesses";
  const scopeBusinessIds = Array.isArray(scopeValue?.businessIds)
    ? normalizeBusinessIds(scopeValue.businessIds as Array<string>)
    : null;
  const executionDisposition = String(
    run?.summaryJson?.executionDisposition ??
      (run?.executionMode === "execute" ? "global_execute" : "dry_run"),
  ) as MetaRetentionExecutionDisposition;

  return {
    scope: {
      kind: scopeKind,
      businessIds:
        scopeKind === "selected_businesses" ? scopeBusinessIds ?? [] : null,
    } satisfies MetaRetentionRunScope,
    executionDisposition,
    canary: canaryValue
      ? ({
          runtimeAvailable: Boolean(canaryValue.runtimeAvailable),
          globalExecutionEnabled: Boolean(canaryValue.globalExecutionEnabled),
          businessId: String(canaryValue.businessId ?? ""),
          executeRequested: Boolean(canaryValue.executeRequested),
          executeAllowed: Boolean(canaryValue.executeAllowed),
          mode:
            canaryValue.mode === "execute" ? "execute" : "dry_run",
          gateReason: String(canaryValue.gateReason ?? ""),
        } satisfies MetaRetentionCanaryRuntimeStatus)
      : null,
  };
}

export function getMetaRetentionRunRows(
  run: Pick<MetaRetentionRunRecord, "summaryJson"> | null | undefined,
): MetaRetentionExecutionRow[] {
  const rows = Array.isArray(run?.summaryJson?.rows)
    ? (run.summaryJson.rows as Array<Record<string, unknown>>)
    : [];
  return rows.map((row) => {
    const summaryKey = String(row.summaryKey ?? "");
    const policyEntry =
      META_RETENTION_POLICY.find((entry) => entry.summaryKey === summaryKey) ??
      META_RETENTION_POLICY.find((entry) => entry.tableName === row.tableName) ??
      null;
    return {
      tier: String(row.tier ?? policyEntry?.tier ?? "core_authoritative") as MetaRetentionTier,
      label: String(row.label ?? policyEntry?.label ?? ""),
      tableName: String(row.tableName ?? policyEntry?.tableName ?? ""),
      summaryKey: String(row.summaryKey ?? policyEntry?.summaryKey ?? ""),
      retentionDays: Number(row.retentionDays ?? policyEntry?.retentionDays ?? 0),
      cutoffDate: row.cutoffDate ? String(row.cutoffDate) : "",
      executionEnabled: Boolean(row.executionEnabled),
      mode: String(row.mode ?? "dry_run") as MetaRetentionExecutionRow["mode"],
      observed: Boolean(row.observed),
      eligibleRows: toNullableNumber(row.eligibleRows),
      eligibleDistinctDays: toNullableNumber(row.eligibleDistinctDays),
      oldestEligibleValue: row.oldestEligibleValue
        ? String(row.oldestEligibleValue)
        : null,
      newestEligibleValue: row.newestEligibleValue
        ? String(row.newestEligibleValue)
        : null,
      retainedRows: toNullableNumber(row.retainedRows),
      latestRetainedValue: row.latestRetainedValue
        ? String(row.latestRetainedValue)
        : null,
      protectedRows: toNullableNumber(row.protectedRows),
      protectedDistinctDays: toNullableNumber(row.protectedDistinctDays),
      latestProtectedValue: row.latestProtectedValue
        ? String(row.latestProtectedValue)
        : null,
      deletedRows: Number(row.deletedRows ?? 0),
      surfaceFilter: Array.isArray(row.surfaceFilter)
        ? (row.surfaceFilter as MetaWarehouseScope[])
        : (policyEntry?.surfaceFilter ?? null),
    };
  });
}

export function summarizeMetaRetentionRunRows(rows: MetaRetentionExecutionRow[]) {
  return rows.reduce(
    (summary, row) => ({
      observedTables: summary.observedTables + (row.observed ? 1 : 0),
      tablesWithDeletableRows:
        summary.tablesWithDeletableRows +
        ((row.eligibleRows ?? 0) > 0 ? 1 : 0),
      tablesWithProtectedRows:
        summary.tablesWithProtectedRows +
        ((row.protectedRows ?? 0) > 0 ? 1 : 0),
      deletableRows: summary.deletableRows + Math.max(0, row.eligibleRows ?? 0),
      retainedRows: summary.retainedRows + Math.max(0, row.retainedRows ?? 0),
      protectedRows:
        summary.protectedRows + Math.max(0, row.protectedRows ?? 0),
    }),
    {
      observedTables: 0,
      tablesWithDeletableRows: 0,
      tablesWithProtectedRows: 0,
      deletableRows: 0,
      retainedRows: 0,
      protectedRows: 0,
    },
  );
}
