import { resolveDestructiveRetentionMode } from "@/lib/sync/global-kill-switch";
import { randomUUID } from "node:crypto";
import { getDb, getDbWithTimeout } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { addDaysToIsoDate } from "@/lib/google-ads/history";
import {
  acquireSyncRunnerLease,
  releaseSyncRunnerLease,
} from "@/lib/sync/worker-health";
import { GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS } from "@/lib/google-ads/google-contract";

export type GoogleAdsRetentionTier =
  | "core_daily"
  | "breakdown_daily"
  | "creative_daily"
  | "raw_search_terms_hot"
  | "top_queries_weekly"
  | "search_cluster_aggregate"
  | "decision_action_outcome_log"
  | "advisor_execution_log";

export type GoogleAdsRetentionDateColumn =
  | "date"
  | "week_start"
  | "occurred_at"
  | "created_at";

export interface GoogleAdsRetentionPolicyEntry {
  tier: GoogleAdsRetentionTier;
  label: string;
  retentionDays: number;
  tableNames: string[];
  grain: "daily" | "weekly" | "event";
  storageTemperature: "hot" | "warm" | "cold";
}

export interface GoogleAdsRetentionDryRunRow {
  tier: GoogleAdsRetentionTier;
  label: string;
  tableName: string;
  retentionDays: number;
  cutoffDate: string;
  executionEnabled: boolean;
  grain: GoogleAdsRetentionPolicyEntry["grain"];
  storageTemperature: GoogleAdsRetentionPolicyEntry["storageTemperature"];
  dateColumn: GoogleAdsRetentionDateColumn;
}

export interface GoogleAdsRetentionInspectionRow extends GoogleAdsRetentionDryRunRow {
  mode: "dry_run" | "execute";
  observed: boolean;
  eligibleRows: number | null;
  oldestEligibleValue: string | null;
  newestEligibleValue: string | null;
  retainedRows: number | null;
  latestRetainedValue: string | null;
}

export interface GoogleAdsRetentionExecutionRow extends GoogleAdsRetentionInspectionRow {
  deletedRows: number;
}

export interface GoogleAdsRetentionRunSummary {
  runId: string | null;
  startedAt: string;
  finishedAt: string;
  executionEnabled: boolean;
  mode: "dry_run" | "execute";
  skippedDueToActiveLease: boolean;
  rows: GoogleAdsRetentionExecutionRow[];
  totalDeletedRows: number;
  errorMessage?: string | null;
}

export interface GoogleAdsRetentionRunRecord {
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

function toNullableNumber(value: unknown) {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const DAYS_PER_MONTH = 30.4375;
const RETENTION_LEASE_BUSINESS_ID = "__google_ads_retention__";
const RETENTION_LEASE_PROVIDER_SCOPE = "google_ads_retention";

function monthsToDays(months: number) {
  return Math.round(months * DAYS_PER_MONTH);
}

function envNumber(
  name:
    | "GOOGLE_ADS_RETENTION_QUERY_TIMEOUT_MS"
    | "GOOGLE_ADS_RETENTION_BATCH_SIZE"
    | "GOOGLE_ADS_RETENTION_LEASE_MINUTES",
  fallback: number,
  env: NodeJS.ProcessEnv = process.env
) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isGoogleAdsRetentionRuntimeAvailable(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.DATABASE_URL?.trim());
}

function retentionDateColumnForTable(tableName: string): GoogleAdsRetentionDateColumn {
  if (tableName === "google_ads_top_query_weekly") return "week_start";
  if (tableName === "google_ads_decision_action_outcome_logs") return "occurred_at";
  if (tableName === "google_ads_advisor_execution_logs") return "created_at";
  return "date";
}

function emptyRetentionRunSummary(input: {
  asOfDate: string;
  executionEnabled: boolean;
  mode: "dry_run" | "execute";
  skippedDueToActiveLease?: boolean;
  errorMessage?: string | null;
}) {
  const startedAt = new Date().toISOString();
  return {
    runId: null,
    startedAt,
    finishedAt: startedAt,
    executionEnabled: input.executionEnabled,
    mode: input.mode,
    skippedDueToActiveLease: input.skippedDueToActiveLease ?? false,
    rows: buildGoogleAdsRetentionDryRun(input.asOfDate, {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      GOOGLE_ADS_RETENTION_EXECUTION_ENABLED: String(input.executionEnabled),
    }).map((row) => ({
      ...row,
      mode: input.mode,
      observed: false,
      eligibleRows: null,
      oldestEligibleValue: null,
      newestEligibleValue: null,
      retainedRows: null,
      latestRetainedValue: null,
      deletedRows: 0,
    })),
    totalDeletedRows: 0,
    errorMessage: input.errorMessage ?? null,
  } satisfies GoogleAdsRetentionRunSummary;
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
  batchSize: number
) {
  let totalDeleted = 0;
  while (true) {
    const deleted = await deleteBatch();
    totalDeleted += deleted;
    if (deleted < batchSize) break;
  }
  return totalDeleted;
}

export const GOOGLE_ADS_RETENTION_POLICY: Record<
  GoogleAdsRetentionTier,
  GoogleAdsRetentionPolicyEntry
> = {
  core_daily: {
    tier: "core_daily",
    label: "Core daily",
    retentionDays: monthsToDays(25),
    tableNames: [
      "google_ads_account_daily",
      "google_ads_campaign_daily",
      "google_ads_keyword_daily",
      "google_ads_product_daily",
    ],
    grain: "daily",
    storageTemperature: "warm",
  },
  breakdown_daily: {
    tier: "breakdown_daily",
    label: "Breakdown daily",
    retentionDays: monthsToDays(13),
    tableNames: [
      "google_ads_geo_daily",
      "google_ads_device_daily",
      "google_ads_audience_daily",
      "google_ads_ad_group_daily",
      "google_ads_asset_group_daily",
    ],
    grain: "daily",
    storageTemperature: "warm",
  },
  creative_daily: {
    tier: "creative_daily",
    label: "Creative daily",
    retentionDays: 180,
    tableNames: ["google_ads_ad_daily", "google_ads_asset_daily"],
    grain: "daily",
    storageTemperature: "hot",
  },
  raw_search_terms_hot: {
    tier: "raw_search_terms_hot",
    label: "Raw search terms daily hot",
    retentionDays: GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS,
    tableNames: [
      "google_ads_search_query_hot_daily",
      "google_ads_search_term_daily",
    ],
    grain: "daily",
    storageTemperature: "hot",
  },
  top_queries_weekly: {
    tier: "top_queries_weekly",
    label: "Top queries weekly",
    retentionDays: 365,
    tableNames: ["google_ads_top_query_weekly"],
    grain: "weekly",
    storageTemperature: "warm",
  },
  search_cluster_aggregate: {
    tier: "search_cluster_aggregate",
    label: "Search cluster/theme aggregate",
    retentionDays: monthsToDays(25),
    tableNames: ["google_ads_search_cluster_daily"],
    grain: "daily",
    storageTemperature: "warm",
  },
  decision_action_outcome_log: {
    tier: "decision_action_outcome_log",
    label: "Decision action/outcome log",
    retentionDays: monthsToDays(25),
    tableNames: ["google_ads_decision_action_outcome_logs"],
    grain: "event",
    storageTemperature: "warm",
  },
  advisor_execution_log: {
    tier: "advisor_execution_log",
    label: "Advisor execution log",
    retentionDays: 30,
    tableNames: ["google_ads_advisor_execution_logs"],
    grain: "event",
    storageTemperature: "hot",
  },
};

export const GOOGLE_ADS_RETENTION_REQUIRED_TABLES = [
  ...Object.values(GOOGLE_ADS_RETENTION_POLICY).flatMap((entry) => entry.tableNames),
  "google_ads_retention_runs",
] as const;

function readBooleanFlag(name: "GOOGLE_ADS_RETENTION_EXECUTION_ENABLED", fallback: boolean, env: NodeJS.ProcessEnv = process.env) {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return fallback;
}

export function isGoogleAdsRetentionExecutionEnabled(env: NodeJS.ProcessEnv = process.env) {
  return readBooleanFlag("GOOGLE_ADS_RETENTION_EXECUTION_ENABLED", false, env);
}

export function getGoogleAdsRetentionRuntimeStatus(env: NodeJS.ProcessEnv = process.env) {
  const executionEnabled = isGoogleAdsRetentionExecutionEnabled(env);
  return {
    runtimeAvailable: isGoogleAdsRetentionRuntimeAvailable(env),
    executionEnabled,
    mode: executionEnabled ? ("execute" as const) : ("dry_run" as const),
    gateReason: executionEnabled
      ? "Google Ads retention execution is explicitly enabled."
      : "Google Ads retention execution is disabled by default. Dry-run remains available.",
  };
}

export function buildGoogleAdsRetentionDryRun(asOfDate: string, env: NodeJS.ProcessEnv = process.env): GoogleAdsRetentionDryRunRow[] {
  const executionEnabled = isGoogleAdsRetentionExecutionEnabled(env);
  return Object.values(GOOGLE_ADS_RETENTION_POLICY).flatMap((entry) =>
    entry.tableNames.map((tableName) => ({
      tier: entry.tier,
      label: entry.label,
      tableName,
      retentionDays: entry.retentionDays,
      cutoffDate: addDaysToIsoDate(asOfDate, -entry.retentionDays),
      executionEnabled,
      grain: entry.grain,
      storageTemperature: entry.storageTemperature,
      dateColumn: retentionDateColumnForTable(tableName),
    }))
  );
}

async function inspectRetentionTableWindow(input: {
  sql: ReturnType<typeof getDbWithTimeout>;
  tableName: string;
  dateColumn: GoogleAdsRetentionDateColumn;
  cutoffDate: string;
}): Promise<Pick<
  GoogleAdsRetentionInspectionRow,
  | "observed"
  | "eligibleRows"
  | "oldestEligibleValue"
  | "newestEligibleValue"
  | "retainedRows"
  | "latestRetainedValue"
>> {
  const rows = (await input.sql.query(
    `
      SELECT
        COUNT(*) FILTER (WHERE ${input.dateColumn} < $1)::int AS eligible_rows,
        MIN(${input.dateColumn}) FILTER (WHERE ${input.dateColumn} < $1)::text AS oldest_eligible_value,
        MAX(${input.dateColumn}) FILTER (WHERE ${input.dateColumn} < $1)::text AS newest_eligible_value,
        COUNT(*) FILTER (WHERE ${input.dateColumn} >= $1)::int AS retained_rows,
        MAX(${input.dateColumn}) FILTER (WHERE ${input.dateColumn} >= $1)::text AS latest_retained_value
      FROM ${input.tableName}
    `,
    [input.cutoffDate]
  )) as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    observed: true,
    eligibleRows: toNullableNumber(row.eligible_rows),
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
  };
}

async function inspectGoogleAdsRetentionDryRunRows(input: {
  asOfDate: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const executionEnabled = isGoogleAdsRetentionExecutionEnabled(env);
  if (!isGoogleAdsRetentionRuntimeAvailable(env)) {
    return buildGoogleAdsRetentionDryRun(input.asOfDate, env).map((row) => ({
      ...row,
      mode: "dry_run" as const,
      observed: false,
      eligibleRows: null,
      oldestEligibleValue: null,
      newestEligibleValue: null,
      retainedRows: null,
      latestRetainedValue: null,
    }));
  }

  await assertDbSchemaReady({
    tables: [...GOOGLE_ADS_RETENTION_REQUIRED_TABLES],
    context: "google_ads_retention_dry_run",
  });
  const sql = getDbWithTimeout(
    envNumber("GOOGLE_ADS_RETENTION_QUERY_TIMEOUT_MS", 30_000, env)
  );

  return Promise.all(
    buildGoogleAdsRetentionDryRun(input.asOfDate, env).map(async (row) => ({
      ...row,
      mode: "dry_run" as const,
      ...(await inspectRetentionTableWindow({
        sql,
        tableName: row.tableName,
        dateColumn: row.dateColumn,
        cutoffDate: row.cutoffDate,
      })),
    }))
  );
}

async function recordGoogleAdsRetentionRun(
  summary: GoogleAdsRetentionRunSummary
): Promise<GoogleAdsRetentionRunSummary> {
  const readiness = await getDbSchemaReadiness({
    tables: ["google_ads_retention_runs"],
  }).catch(() => null);
  if (!readiness?.ready || !isGoogleAdsRetentionRuntimeAvailable()) {
    return summary;
  }

  const sql = getDb();
  const rows = (await sql`
    INSERT INTO google_ads_retention_runs (
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

export async function getLatestGoogleAdsRetentionRun() {
  const readiness = await getDbSchemaReadiness({
    tables: ["google_ads_retention_runs"],
  }).catch(() => null);
  if (!readiness?.ready || !isGoogleAdsRetentionRuntimeAvailable()) {
    return null;
  }
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM google_ads_retention_runs
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
  } satisfies GoogleAdsRetentionRunRecord;
}

export function getGoogleAdsRetentionRunRows(
  run: Pick<GoogleAdsRetentionRunRecord, "summaryJson"> | null | undefined
): GoogleAdsRetentionExecutionRow[] {
  const rows = Array.isArray(run?.summaryJson?.rows)
    ? (run?.summaryJson?.rows as Array<Record<string, unknown>>)
    : [];
  return rows.map((row) => {
    const tableName = String(row.tableName ?? "");
    const policyEntry =
      Object.values(GOOGLE_ADS_RETENTION_POLICY).find((entry) =>
        entry.tableNames.includes(tableName)
      ) ?? null;
    const dateColumn = retentionDateColumnForTable(tableName);
    return {
      tier: String(row.tier ?? policyEntry?.tier ?? "core_daily") as GoogleAdsRetentionTier,
      label: String(row.label ?? policyEntry?.label ?? ""),
      tableName,
      retentionDays: Number(row.retentionDays ?? policyEntry?.retentionDays ?? 0),
      cutoffDate: row.cutoffDate ? String(row.cutoffDate) : "",
      executionEnabled: Boolean(row.executionEnabled),
      grain: String(row.grain ?? policyEntry?.grain ?? "daily") as GoogleAdsRetentionPolicyEntry["grain"],
      storageTemperature: String(
        row.storageTemperature ?? policyEntry?.storageTemperature ?? "warm"
      ) as GoogleAdsRetentionPolicyEntry["storageTemperature"],
      dateColumn,
      mode: String(row.mode ?? "dry_run") as GoogleAdsRetentionExecutionRow["mode"],
      observed: Boolean(row.observed),
      eligibleRows: toNullableNumber(row.eligibleRows),
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
      deletedRows: Number(row.deletedRows ?? 0),
    };
  });
}

export async function executeGoogleAdsRetentionPolicy(input: {
  asOfDate: string;
  env?: NodeJS.ProcessEnv;
  forceExecute?: boolean;
}) {
  const env = input.env ?? process.env;
  const runtime = getGoogleAdsRetentionRuntimeStatus(env);
  const executionEnabled = runtime.executionEnabled;
  // The retention lane is the OUTER admission. GOOGLE_ADS_RETENTION_EXECUTION_
  // ENABLED and forceExecute are both inside it, so neither can delete while
  // the lane says stop.
  const { mode } = resolveDestructiveRetentionMode({
    requestedExecute: executionEnabled || Boolean(input.forceExecute),
    env,
  });

  if (!isGoogleAdsRetentionRuntimeAvailable(env)) {
    return emptyRetentionRunSummary({
      asOfDate: input.asOfDate,
      executionEnabled,
      mode,
      errorMessage: "DATABASE_URL is not configured.",
    });
  }

  await assertDbSchemaReady({
    tables: [...GOOGLE_ADS_RETENTION_REQUIRED_TABLES],
    context: "google_ads_retention",
  });
  const sql = getDbWithTimeout(
    envNumber("GOOGLE_ADS_RETENTION_QUERY_TIMEOUT_MS", 30_000, env)
  );
  const batchSize = envNumber("GOOGLE_ADS_RETENTION_BATCH_SIZE", 250, env);
  const leaseMinutes = envNumber("GOOGLE_ADS_RETENTION_LEASE_MINUTES", 15, env);
  const leaseOwner = `google-ads-retention:${process.pid}:${randomUUID().slice(0, 8)}`;
  const leaseAcquired = await acquireSyncRunnerLease({
    businessId: RETENTION_LEASE_BUSINESS_ID,
    providerScope: RETENTION_LEASE_PROVIDER_SCOPE,
    leaseOwner,
    leaseMinutes,
  }).catch(() => false);

  if (!leaseAcquired) {
    return recordGoogleAdsRetentionRun(
      emptyRetentionRunSummary({
        asOfDate: input.asOfDate,
        executionEnabled,
        mode,
        skippedDueToActiveLease: true,
      })
    );
  }

  const startedAt = new Date().toISOString();
  try {
    const rows: GoogleAdsRetentionExecutionRow[] = [];
    for (const entry of Object.values(GOOGLE_ADS_RETENTION_POLICY)) {
      for (const tableName of entry.tableNames) {
        const cutoffDate = addDaysToIsoDate(input.asOfDate, -entry.retentionDays);
        const dateColumn = retentionDateColumnForTable(tableName);
        const inspection = await inspectRetentionTableWindow({
          sql,
          tableName,
          dateColumn,
          cutoffDate,
        });
        let deletedRows = 0;
        if (mode === "execute") {
          deletedRows = await deleteBatches(
            () =>
              execCount(
                sql.query(
                  `
                    WITH candidates AS (
                      SELECT id
                      FROM ${tableName}
                      WHERE ${dateColumn} < $1
                      ORDER BY ${dateColumn} ASC, id ASC
                      LIMIT $2
                      FOR UPDATE SKIP LOCKED
                    ),
                    deleted AS (
                      DELETE FROM ${tableName} target
                      USING candidates
                      WHERE target.id = candidates.id
                      RETURNING 1
                    )
                    SELECT COUNT(*)::int AS count FROM deleted
                  `,
                  [cutoffDate, batchSize]
                )
              ),
            batchSize
          );
        }
        rows.push({
          tier: entry.tier,
          label: entry.label,
          tableName,
          retentionDays: entry.retentionDays,
          cutoffDate,
          executionEnabled,
          grain: entry.grain,
          storageTemperature: entry.storageTemperature,
          dateColumn,
          deletedRows,
          mode,
          ...inspection,
        });
      }
    }

    const summary = {
      runId: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      executionEnabled,
      mode,
      skippedDueToActiveLease: false,
      rows,
      totalDeletedRows: rows.reduce((sum, row) => sum + row.deletedRows, 0),
      errorMessage: null,
    } satisfies GoogleAdsRetentionRunSummary;

    return await recordGoogleAdsRetentionRun(summary);
  } catch (error) {
    const failedSummary = {
      runId: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      executionEnabled,
      mode,
      skippedDueToActiveLease: false,
      rows: buildGoogleAdsRetentionDryRun(input.asOfDate, env).map((row) => ({
        ...row,
        observed: false,
        eligibleRows: null,
        oldestEligibleValue: null,
        newestEligibleValue: null,
        retainedRows: null,
        latestRetainedValue: null,
        deletedRows: 0,
        mode,
      })),
      totalDeletedRows: 0,
      errorMessage: error instanceof Error ? error.message : String(error),
    } satisfies GoogleAdsRetentionRunSummary;
    await recordGoogleAdsRetentionRun(failedSummary).catch(() => null);
    throw error;
  } finally {
    await releaseSyncRunnerLease({
      businessId: RETENTION_LEASE_BUSINESS_ID,
      providerScope: RETENTION_LEASE_PROVIDER_SCOPE,
      leaseOwner,
    }).catch(() => null);
  }
}

export async function executeGoogleAdsRetentionPolicyDryRunOnly(input: {
  asOfDate: string;
  env?: NodeJS.ProcessEnv;
}) {
  return {
    executionEnabled: isGoogleAdsRetentionExecutionEnabled(input.env),
    dryRun: await inspectGoogleAdsRetentionDryRunRows(input),
  };
}
