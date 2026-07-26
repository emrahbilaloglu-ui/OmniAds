import { getDbWithTimeout } from "@/lib/db";
import {
  SYNC_RETENTION_EXECUTION_COLUMN_SPECS,
  SYNC_RETENTION_EXECUTION_INDEX_SPECS,
} from "@/lib/sync/retention-schema-contract";

export interface SyncRetentionExecutionReadiness {
  ready: boolean;
  missingOrInvalidIndexes: string[];
  missingColumns: string[];
  unexpectedGoogleRunReferenceColumns: string[];
  checkedAt: string;
}

export class SyncRetentionExecutionNotReadyError extends Error {
  readonly code = "SYNC_RETENTION_EXECUTION_NOT_READY";
  readonly readiness: SyncRetentionExecutionReadiness;

  constructor(readiness: SyncRetentionExecutionReadiness) {
    const issues = [
      ...readiness.missingOrInvalidIndexes.map((name) => `index:${name}`),
      ...readiness.missingColumns.map((name) => `column:${name}`),
      ...readiness.unexpectedGoogleRunReferenceColumns.map(
        (name) => `unguarded_google_run_reference:${name}`,
      ),
    ];
    super(
      `sync retention execution schema is not ready (${issues.join(", ")})`,
    );
    this.name = "SyncRetentionExecutionNotReadyError";
    this.readiness = readiness;
  }
}

interface IndexReadinessRow {
  index_name?: string;
  expected_table?: string;
  actual_table?: string | null;
  access_method?: string | null;
  key_count?: number | null;
  key_definitions?: string[] | null;
  is_unique?: boolean | null;
  predicate?: string | null;
  is_valid?: boolean | null;
  is_ready?: boolean | null;
}

interface ColumnReadinessRow {
  table_name?: string;
  column_name?: string;
  is_ready?: boolean;
}

interface RunReferenceColumnRow {
  table_name?: string;
  column_name?: string;
}

export async function getSyncRetentionExecutionReadiness(input?: {
  timeoutMs?: number;
}): Promise<SyncRetentionExecutionReadiness> {
  const timeoutMs = Math.max(1, Math.min(10_000, input?.timeoutMs ?? 5_000));
  const sql = getDbWithTimeout(timeoutMs);
  const indexRows = await sql.query<IndexReadinessRow>(
    `
      WITH requested(index_name, expected_table) AS (
        SELECT *
        FROM UNNEST($1::text[], $2::text[])
      )
      SELECT
        requested.index_name,
        requested.expected_table,
        available.actual_table,
        available.access_method,
        available.key_count,
        available.key_definitions,
        available.is_unique,
        available.predicate,
        available.is_valid,
        available.is_ready
      FROM requested
      LEFT JOIN (
        SELECT
          index_relation.relname AS index_name,
          table_relation.relname AS actual_table,
          access_method.amname AS access_method,
          index_catalog.indnkeyatts::integer AS key_count,
          ARRAY(
            SELECT
              pg_get_indexdef(
                index_catalog.indexrelid,
                key_position + 1,
                true
              ) ||
              CASE
                WHEN access_method.amname = 'btree' THEN
                  CASE
                    WHEN (
                      index_catalog.indoption[key_position] & 1
                    ) = 1
                    THEN ' DESC'
                    ELSE ' ASC'
                  END ||
                  CASE
                    WHEN (
                      index_catalog.indoption[key_position] & 2
                    ) = 2
                    THEN ' NULLS FIRST'
                    ELSE ' NULLS LAST'
                  END
                ELSE ''
              END
            FROM generate_series(
              0,
              index_catalog.indnkeyatts - 1
            ) AS key_position
            ORDER BY key_position
          ) AS key_definitions,
          index_catalog.indisunique AS is_unique,
          pg_get_expr(
            index_catalog.indpred,
            index_catalog.indrelid,
            true
          ) AS predicate,
          index_catalog.indisvalid AS is_valid,
          index_catalog.indisready AS is_ready
        FROM pg_class index_relation
        INNER JOIN pg_namespace index_namespace
          ON index_namespace.oid = index_relation.relnamespace
          AND index_namespace.nspname = current_schema()
        INNER JOIN pg_index index_catalog
          ON index_catalog.indexrelid = index_relation.oid
        INNER JOIN pg_class table_relation
          ON table_relation.oid = index_catalog.indrelid
        INNER JOIN pg_namespace table_namespace
          ON table_namespace.oid = table_relation.relnamespace
          AND table_namespace.nspname = current_schema()
        INNER JOIN pg_am access_method
          ON access_method.oid = index_relation.relam
      ) available
        ON available.index_name = requested.index_name
      ORDER BY requested.index_name
    `,
    [
      SYNC_RETENTION_EXECUTION_INDEX_SPECS.map((spec) => spec.name),
      SYNC_RETENTION_EXECUTION_INDEX_SPECS.map((spec) => spec.table),
    ],
  );
  const columnRows = await sql.query<ColumnReadinessRow>(
    `
      WITH requested(table_name, column_name) AS (
        SELECT *
        FROM UNNEST($1::text[], $2::text[])
      )
      SELECT
        requested.table_name,
        requested.column_name,
        EXISTS (
          SELECT 1
          FROM information_schema.columns column_catalog
          WHERE column_catalog.table_schema = current_schema()
            AND column_catalog.table_name = requested.table_name
            AND column_catalog.column_name = requested.column_name
        ) AS is_ready
      FROM requested
      ORDER BY requested.table_name, requested.column_name
    `,
    [
      SYNC_RETENTION_EXECUTION_COLUMN_SPECS.map((spec) => spec.table),
      SYNC_RETENTION_EXECUTION_COLUMN_SPECS.map((spec) => spec.column),
    ],
  );
  const googleRunReferenceRows = await sql.query<RunReferenceColumnRow>(
    `
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name LIKE 'google_ads_%'
          AND column_name = ANY(
            ARRAY[
              'run_id',
              'source_run_id',
              'last_run_id',
              'published_by_run_id'
            ]::text[]
          )
        ORDER BY table_name, column_name
      `,
  );

  const indexSpecsByName = new Map(
    SYNC_RETENTION_EXECUTION_INDEX_SPECS.map((spec) => [spec.name, spec]),
  );
  const missingOrInvalidIndexes = indexRows
    .filter((row) => {
      const spec = indexSpecsByName.get(String(row.index_name ?? ""));
      return (
        !spec ||
        row.actual_table !== spec.table ||
        row.actual_table !== row.expected_table ||
        row.access_method !== spec.accessMethod ||
        row.key_count !== spec.keyDefinitions.length ||
        !equalStringArrays(row.key_definitions, spec.keyDefinitions) ||
        row.is_unique !== spec.unique ||
        row.predicate !== spec.predicate ||
        row.is_valid !== true ||
        row.is_ready !== true
      );
    })
    .map((row) => String(row.index_name ?? "unknown"))
    .sort((left, right) => left.localeCompare(right));
  const missingColumns = columnRows
    .filter((row) => row.is_ready !== true)
    .map(
      (row) =>
        `${String(row.table_name ?? "unknown")}.${String(row.column_name ?? "unknown")}`,
    )
    .sort((left, right) => left.localeCompare(right));
  const unexpectedGoogleRunReferenceColumns = googleRunReferenceRows
    .map(
      (row) =>
        `${String(row.table_name ?? "unknown")}.${String(row.column_name ?? "unknown")}`,
    )
    .sort((left, right) => left.localeCompare(right));
  const readiness = {
    ready:
      missingOrInvalidIndexes.length === 0 &&
      missingColumns.length === 0 &&
      unexpectedGoogleRunReferenceColumns.length === 0,
    missingOrInvalidIndexes,
    missingColumns,
    unexpectedGoogleRunReferenceColumns,
    checkedAt: new Date().toISOString(),
  };
  return readiness;
}

function equalStringArrays(
  actual: readonly string[] | null | undefined,
  expected: readonly string[],
) {
  return (
    actual != null &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

/**
 * Every declared spec must name a relation that actually exists.
 *
 * A spec for a table this deployment does not have can never be satisfied, so
 * the readiness gate would refuse forever. That is not fail-closed — it is
 * never-open, and it hides genuine drift behind a permanent failure. This turns
 * that mistake into a loud, specific error at the schema boundary instead of an
 * indefinitely refused sweep.
 */
export async function assertSyncRetentionExecutionSpecsAreResolvable(input?: {
  timeoutMs?: number;
}) {
  const timeoutMs = Math.max(1, Math.min(10_000, input?.timeoutMs ?? 5_000));
  const sql = getDbWithTimeout(timeoutMs);
  const tables = [
    ...new Set(SYNC_RETENTION_EXECUTION_INDEX_SPECS.map((spec) => spec.table)),
  ];
  const rows = await sql.query<{ table_name: string }>(
    `SELECT requested.table_name
     FROM UNNEST($1::text[]) AS requested(table_name)
     WHERE to_regclass('public.' || requested.table_name) IS NULL`,
    [tables],
  );
  const unresolvable = (Array.isArray(rows) ? rows : [])
    .map((row) => row.table_name)
    .filter((name): name is string => typeof name === "string");
  if (unresolvable.length > 0) {
    throw new Error(
      `sync retention execution contract declares indexes on relations that do not exist: ${unresolvable
        .sort()
        .join(", ")}`,
    );
  }
  return tables.length;
}

export async function assertSyncRetentionExecutionReady(input?: {
  timeoutMs?: number;
}) {
  const readiness = await getSyncRetentionExecutionReadiness(input);
  if (!readiness.ready) {
    throw new SyncRetentionExecutionNotReadyError(readiness);
  }
  return readiness;
}
