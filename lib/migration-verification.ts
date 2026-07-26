import { getDbWithTimeout } from "@/lib/db";

/**
 * Post-migration proof that this change's schema actually landed.
 *
 * Almost every DDL statement in `lib/migrations.ts` ends in `.catch(() => {})`.
 * That is defensible for statements which are genuinely idempotent-or-already-
 * done, and indefensible as the ONLY guarantee: a swallowed failure on a new
 * column, table, foreign key or index leaves the process reporting
 * `migrations_completed` over a schema that cannot support the code that is
 * about to run against it.
 *
 * This verifier closes that gap for the objects THIS change introduces. It runs
 * after the batches and before completion is announced, and it throws. It does
 * not attempt to re-verify the entire historical schema — that would be a
 * different, much larger contract — and it says so rather than implying more
 * coverage than it has.
 */

export interface MigrationVerificationFailure {
  kind: "column" | "table" | "foreign_key" | "index" | "default" | "readback";
  object: string;
  detail: string;
}

export class MigrationVerificationError extends Error {
  readonly failures: MigrationVerificationFailure[];
  constructor(failures: MigrationVerificationFailure[]) {
    super(
      `Post-migration verification failed (${failures.length}):\n` +
        failures.map((f) => `  - [${f.kind}] ${f.object}: ${f.detail}`).join("\n"),
    );
    this.name = "MigrationVerificationError";
    this.failures = failures;
  }
}

interface ColumnSpec {
  table: string;
  column: string;
  dataType: string;
  isNullable: boolean;
  /** information_schema.column_default, or null when no default is required. */
  columnDefault?: string | null;
}

interface ForeignKeySpec {
  table: string;
  column: string;
  referencedTable: string;
  /** pg_constraint.confdeltype: r=RESTRICT, a=NO ACTION, c=CASCADE, n=SET NULL. */
  onDelete: "r" | "a" | "c" | "n";
}

interface IndexSpec {
  name: string;
  table: string;
  unique: boolean;
  definitionMustContain: readonly string[];
}

/** Columns this change adds. */
export const VERIFIED_COLUMNS: readonly ColumnSpec[] = [
  { table: "business_provider_accounts", column: "is_selected", dataType: "boolean", isNullable: false, columnDefault: "false" },
  { table: "meta_raw_snapshots", column: "content_key", dataType: "text", isNullable: true },
  { table: "meta_raw_snapshots", column: "first_observed_at", dataType: "timestamp with time zone", isNullable: true },
  { table: "meta_raw_snapshots", column: "last_observed_at", dataType: "timestamp with time zone", isNullable: true },
  { table: "meta_raw_snapshots", column: "observation_count", dataType: "integer", isNullable: false, columnDefault: "1" },
  { table: "shopify_raw_snapshots", column: "content_key", dataType: "text", isNullable: true },
  { table: "shopify_raw_snapshots", column: "first_observed_at", dataType: "timestamp with time zone", isNullable: true },
  { table: "shopify_raw_snapshots", column: "last_observed_at", dataType: "timestamp with time zone", isNullable: true },
  { table: "shopify_raw_snapshots", column: "observation_count", dataType: "integer", isNullable: false, columnDefault: "1" },
  { table: "provider_sync_jobs", column: "progress_json", dataType: "jsonb", isNullable: false },
];

/** Tables this change adds. */
export const VERIFIED_TABLES: readonly string[] = [
  "meta_raw_snapshot_observations",
  "shopify_raw_snapshot_observations",
];

/**
 * Foreign keys whose ON DELETE action is load-bearing.
 *
 * RESTRICT on the content reference is what stops retention from deleting
 * referenced content; CASCADE on the partition reference is what makes a
 * partition delete remove only its OWN receipts. Getting either backwards is
 * silent data loss, so both are asserted by action and not merely by existence.
 */
export const VERIFIED_FOREIGN_KEYS: readonly ForeignKeySpec[] = [
  { table: "meta_raw_snapshot_observations", column: "snapshot_id", referencedTable: "meta_raw_snapshots", onDelete: "r" },
  { table: "meta_raw_snapshot_observations", column: "partition_id", referencedTable: "meta_sync_partitions", onDelete: "c" },
  { table: "shopify_raw_snapshot_observations", column: "snapshot_id", referencedTable: "shopify_raw_snapshots", onDelete: "r" },
];

/** Indexes this change adds, with the fragments that define them. */
export const VERIFIED_INDEXES: readonly IndexSpec[] = [
  {
    name: "meta_raw_snapshots_content_identity",
    table: "meta_raw_snapshots",
    unique: true,
    definitionMustContain: ["(content_key)", "WHERE (content_key IS NOT NULL)"],
  },
  {
    name: "shopify_raw_snapshots_content_identity",
    table: "shopify_raw_snapshots",
    unique: true,
    definitionMustContain: ["(content_key)", "WHERE (content_key IS NOT NULL)"],
  },
  {
    name: "meta_raw_snapshot_observations_identity",
    table: "meta_raw_snapshot_observations",
    unique: true,
    definitionMustContain: ["snapshot_id", "observed_at", "status"],
  },
  {
    name: "shopify_raw_snapshot_observations_identity",
    table: "shopify_raw_snapshot_observations",
    unique: true,
    definitionMustContain: ["snapshot_id", "status", "observed_at"],
  },
  {
    name: "idx_meta_raw_snapshot_observations_retention",
    table: "meta_raw_snapshot_observations",
    unique: false,
    definitionMustContain: ["observed_at", "id"],
  },
  {
    name: "idx_shopify_raw_snapshot_observations_retention",
    table: "shopify_raw_snapshot_observations",
    unique: false,
    definitionMustContain: ["observed_at", "id"],
  },
  {
    name: "idx_business_provider_accounts_selected",
    table: "business_provider_accounts",
    unique: false,
    definitionMustContain: ["WHERE is_selected"],
  },
  {
    // The growth fence refuses every write it cannot back with a fresh host
    // capacity sample, and it reads that sample with
    // ORDER BY sampled_at DESC, id DESC. Without the id tiebreak two samples
    // written in the same millisecond resolve non-deterministically. Verified
    // rather than hoped for, because the failure is a quietly weaker gate.
    name: "idx_system_capacity_snapshots_source_sampled_id",
    table: "system_capacity_snapshots",
    unique: false,
    definitionMustContain: ["source", "sampled_at DESC", "id DESC"],
  },
];

export async function verifyMigrationSchemaContract(input?: {
  timeoutMs?: number;
}): Promise<{ verified: number }> {
  const sql = getDbWithTimeout(Math.max(1, Math.min(60_000, input?.timeoutMs ?? 30_000)));
  const failures: MigrationVerificationFailure[] = [];

  const columnRows = (await sql.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = current_schema()`,
  )) as Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>;
  const columnIndex = new Map(
    columnRows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );
  for (const spec of VERIFIED_COLUMNS) {
    const key = `${spec.table}.${spec.column}`;
    const found = columnIndex.get(key);
    if (!found) {
      failures.push({ kind: "column", object: key, detail: "missing" });
      continue;
    }
    if (found.data_type !== spec.dataType) {
      failures.push({
        kind: "column",
        object: key,
        detail: `data_type is ${found.data_type}, expected ${spec.dataType}`,
      });
    }
    if ((found.is_nullable === "NO") !== !spec.isNullable) {
      failures.push({
        kind: "column",
        object: key,
        detail: `is_nullable is ${found.is_nullable}, expected ${spec.isNullable ? "YES" : "NO"}`,
      });
    }
    if (spec.columnDefault !== undefined) {
      const actual = found.column_default;
      const matches =
        spec.columnDefault === null
          ? actual === null
          : actual != null && actual.startsWith(spec.columnDefault);
      if (!matches) {
        failures.push({
          kind: "default",
          object: key,
          detail: `column_default is ${String(actual)}, expected ${String(spec.columnDefault)}`,
        });
      }
    }
  }

  const tableRows = (await sql.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [[...VERIFIED_TABLES]],
  )) as Array<{ table_name: string }>;
  const presentTables = new Set(tableRows.map((row) => row.table_name));
  for (const table of VERIFIED_TABLES) {
    if (!presentTables.has(table)) {
      failures.push({ kind: "table", object: table, detail: "missing" });
    }
  }

  const fkRows = (await sql.query(
    `SELECT child.relname AS table_name,
            attribute.attname AS column_name,
            parent.relname AS referenced_table,
            constraint_catalog.confdeltype AS on_delete
     FROM pg_constraint constraint_catalog
     JOIN pg_class child ON child.oid = constraint_catalog.conrelid
     JOIN pg_class parent ON parent.oid = constraint_catalog.confrelid
     JOIN pg_attribute attribute
       ON attribute.attrelid = constraint_catalog.conrelid
      AND attribute.attnum = constraint_catalog.conkey[1]
     WHERE constraint_catalog.contype = 'f'`,
  )) as Array<{
    table_name: string;
    column_name: string;
    referenced_table: string;
    on_delete: string;
  }>;
  for (const spec of VERIFIED_FOREIGN_KEYS) {
    const key = `${spec.table}.${spec.column} -> ${spec.referencedTable}`;
    const found = fkRows.find(
      (row) =>
        row.table_name === spec.table &&
        row.column_name === spec.column &&
        row.referenced_table === spec.referencedTable,
    );
    if (!found) {
      failures.push({ kind: "foreign_key", object: key, detail: "missing" });
      continue;
    }
    if (found.on_delete !== spec.onDelete) {
      failures.push({
        kind: "foreign_key",
        object: key,
        detail: `ON DELETE is '${found.on_delete}', expected '${spec.onDelete}'`,
      });
    }
  }

  const indexRows = (await sql.query(
    `SELECT index_class.relname AS index_name,
            table_class.relname AS table_name,
            index_catalog.indisunique AS is_unique,
            index_catalog.indisvalid AS is_valid,
            index_catalog.indisready AS is_ready,
            index_catalog.indislive AS is_live,
            pg_get_indexdef(index_class.oid) AS definition
     FROM pg_class index_class
     JOIN pg_index index_catalog ON index_catalog.indexrelid = index_class.oid
     JOIN pg_class table_class ON table_class.oid = index_catalog.indrelid
     WHERE index_class.relname = ANY($1::text[])`,
    [VERIFIED_INDEXES.map((spec) => spec.name)],
  )) as Array<{
    index_name: string;
    table_name: string;
    is_unique: boolean;
    is_valid: boolean;
    is_ready: boolean;
    is_live: boolean;
    definition: string;
  }>;
  for (const spec of VERIFIED_INDEXES) {
    const found = indexRows.find((row) => row.index_name === spec.name);
    if (!found) {
      failures.push({ kind: "index", object: spec.name, detail: "missing" });
      continue;
    }
    if (found.table_name !== spec.table) {
      failures.push({
        kind: "index",
        object: spec.name,
        detail: `on ${found.table_name}, expected ${spec.table}`,
      });
    }
    // An interrupted CONCURRENTLY build leaves the index present and unusable.
    if (!found.is_valid || !found.is_ready || !found.is_live) {
      failures.push({
        kind: "index",
        object: spec.name,
        detail: `not usable (valid=${found.is_valid} ready=${found.is_ready} live=${found.is_live})`,
      });
    }
    if (found.is_unique !== spec.unique) {
      failures.push({
        kind: "index",
        object: spec.name,
        detail: `unique=${found.is_unique}, expected ${spec.unique}`,
      });
    }
    for (const fragment of spec.definitionMustContain) {
      if (!found.definition.includes(fragment)) {
        failures.push({
          kind: "index",
          object: spec.name,
          detail: `definition missing '${fragment}': ${found.definition}`,
        });
      }
    }
  }

  // Writer/read compatibility. A schema can satisfy every catalog assertion
  // above and still reject the exact statement shapes the application uses —
  // the ON CONFLICT arbiters in particular, which need the partial unique
  // indexes to be inferable. These run inside a rolled-back transaction so the
  // check writes nothing.
  try {
    await sql.query("BEGIN");
    await sql.query(
      `INSERT INTO meta_raw_snapshots
         (business_id, provider_account_id, endpoint_name, entity_scope,
          start_date, end_date, payload_json, payload_hash, content_key, status)
       VALUES ('__verify__', '__verify__', 'verify', 'verify', CURRENT_DATE,
               CURRENT_DATE, '{}'::jsonb, 'verify', '__verify__', 'fetched')
       ON CONFLICT (content_key) WHERE content_key IS NOT NULL
       DO UPDATE SET observation_count = meta_raw_snapshots.observation_count + 1`,
    );
    await sql.query(
      `INSERT INTO shopify_raw_snapshots
         (business_id, provider_account_id, endpoint_name, entity_scope,
          payload_json, payload_hash, content_key, status)
       VALUES ('__verify__', '__verify__', 'verify', 'verify',
               '{}'::jsonb, 'verify', '__verify__', 'fetched')
       ON CONFLICT (content_key) WHERE content_key IS NOT NULL
       DO UPDATE SET observation_count = shopify_raw_snapshots.observation_count + 1`,
    );
    await sql.query(
      `SELECT 1 FROM business_provider_accounts WHERE is_selected LIMIT 1`,
    );
    // The growth fence's physical-capacity read, in the exact shape it uses.
    // Catalog assertions above prove the table and index exist; this proves the
    // statement the fence actually issues parses and runs, including the
    // clock_timestamp() age arithmetic that decides staleness.
    await sql.query(
      `WITH measured AS (SELECT clock_timestamp() AS at)
       SELECT s.id::text,
              s.sampled_at,
              EXTRACT(EPOCH FROM ((SELECT at FROM measured) - s.sampled_at)) AS age_seconds,
              s.payload
       FROM system_capacity_snapshots s
       WHERE s.source = 'db_host_healthcheck'
       ORDER BY s.sampled_at DESC, s.id DESC
       LIMIT 1`,
    );
  } catch (error) {
    failures.push({
      kind: "readback",
      object: "writer_compatibility",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await sql.query("ROLLBACK").catch(() => undefined);
  }

  if (failures.length > 0) {
    throw new MigrationVerificationError(failures);
  }
  return {
    verified:
      VERIFIED_COLUMNS.length +
      VERIFIED_TABLES.length +
      VERIFIED_FOREIGN_KEYS.length +
      VERIFIED_INDEXES.length,
  };
}
