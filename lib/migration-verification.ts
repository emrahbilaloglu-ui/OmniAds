import { getDb, getDbWithTimeout, runDbTransaction } from "@/lib/db";

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
  kind:
    | "column"
    | "table"
    | "foreign_key"
    | "index"
    | "default"
    | "readback"
    | "trigger"
    | "secret_at_rest";
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
  definitionMustContain?: readonly string[];
  /**
   * The exact ordered key expressions, rendered the way `pg_get_indexdef`
   * renders them (including `DESC`, quoting and casts).
   *
   * Substring matching is not verification. An index named
   * `sync_repair_plans_scope_mode_identity` on `(build_id)` alone contains the
   * fragment "build_id", passes a `definitionMustContain` check, and then makes
   * every `ON CONFLICT (build_id, environment, provider_scope, plan_mode)`
   * write fail with 42P10 at runtime. Order matters as much as membership: an
   * index on `(gate_kind, emitted_at DESC, provider_scope)` has the same
   * columns as the one the keyed read needs and cannot serve it.
   */
  keyExpressions?: readonly string[];
  /**
   * The exact partial predicate as rendered after `WHERE `, or `null` to
   * require that the index has NO predicate. Omitted means "not asserted".
   *
   * A partial index is a different object from a total one with the same name:
   * it can be inferred by a matching `ON CONFLICT ... WHERE` and not by a plain
   * one, and it silently excludes rows from uniqueness.
   */
  predicate?: string | null;
  /** Default btree. A hash index has the same name and cannot serve ORDER BY. */
  accessMethod?: string;
}

interface ParsedIndexDefinition {
  accessMethod: string | null;
  keyExpressions: string[];
  predicate: string | null;
}

/**
 * Split `pg_get_indexdef` output into the parts a contract can assert on.
 *
 * Written by hand rather than by regex because both the key list and the
 * predicate contain parentheses, commas and quoted literals —
 * `(COALESCE(provider_scope, 'meta'::text))` is one key expression, not two —
 * so top-level commas have to be found with a real depth and quote scan.
 */
export function parseIndexDefinition(definition: string): ParsedIndexDefinition {
  const usingMatch = /\sUSING\s+(\w+)\s*\(/.exec(definition);
  if (!usingMatch) {
    return { accessMethod: null, keyExpressions: [], predicate: null };
  }
  const accessMethod = usingMatch[1] ?? null;
  const open = usingMatch.index + usingMatch[0].length - 1;

  let depth = 0;
  let inQuote: '"' | "'" | null = null;
  let close = -1;
  for (let i = open; i < definition.length; i += 1) {
    const char = definition[i]!;
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      inQuote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) {
    return { accessMethod, keyExpressions: [], predicate: null };
  }

  const inner = definition.slice(open + 1, close);
  const keyExpressions: string[] = [];
  let current = "";
  depth = 0;
  inQuote = null;
  for (const char of inner) {
    if (inQuote) {
      current += char;
      if (char === inQuote) inQuote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      inQuote = char;
      current += char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      keyExpressions.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) keyExpressions.push(current.trim());

  const tail = definition.slice(close + 1);
  const whereMatch = /\sWHERE\s+([\s\S]+)$/.exec(tail);
  return {
    accessMethod,
    keyExpressions,
    predicate: whereMatch ? whereMatch[1]!.trim() : null,
  };
}

/**
 * Sentinel that turns a successful probe into a ROLLBACK.
 *
 * `runDbTransaction` commits when its callback resolves. The probe must never
 * commit, and "never" has to be structural rather than a `ROLLBACK` statement
 * issued afterwards — which is exactly what failed before, because the
 * statement went to a different pooled connection than the `BEGIN` had.
 */
const PROBE_ROLLBACK = Symbol("migration_probe_rollback");

interface ProbeClient {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
}

/**
 * Run the writer-compatibility probes on ONE pinned connection and roll back.
 *
 * Returns the failures rather than throwing them, so a probe error is reported
 * alongside the catalog failures instead of replacing them.
 */
async function runProbeAndRollback(
  probe: (tx: ProbeClient) => Promise<void>,
): Promise<MigrationVerificationFailure[]> {
  const failures: MigrationVerificationFailure[] = [];
  try {
    await runDbTransaction(async () => {
      // Inside `runDbTransaction`, `getDb()` returns the PINNED client for this
      // transaction — the whole point of the AsyncLocalStorage the helper sets
      // up. Every probe statement therefore lands on the same backend as the
      // implicit BEGIN, and the rollback below undoes all of them.
      const tx = getDb() as unknown as ProbeClient;
      try {
        await probe(tx);
      } catch (error) {
        failures.push({
          kind: "readback",
          object: "writer_compatibility",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      throw PROBE_ROLLBACK;
    });
  } catch (error) {
    if (error !== PROBE_ROLLBACK) {
      failures.push({
        kind: "readback",
        object: "writer_compatibility_transaction",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
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
  // Selection authority refuses when a snapshot is not bound to the current
  // credential generation, so an absent column would make every selection fail
  // rather than degrade quietly — verified so it fails at migration time
  // instead.
  { table: "provider_account_snapshot_runs", column: "connection_fingerprint", dataType: "text", isNullable: true },
  // Refresh claim ownership. Without these a timed-out claimant can still commit
  // its result over the new owner's, including stamping the OLD account list
  // with the NEW credential's authority.
  // The immutable scheduling attempt a partition was created by. Without it,
  // "did this request schedule work?" is answered by a clock window that a
  // concurrent enqueue can satisfy and clock skew can break.
  { table: "meta_sync_partitions", column: "scheduling_attempt_id", dataType: "uuid", isNullable: true },
  { table: "google_ads_sync_partitions", column: "scheduling_attempt_id", dataType: "uuid", isNullable: true },
  { table: "provider_account_snapshot_runs", column: "refresh_claim_owner", dataType: "text", isNullable: true },
  { table: "provider_account_snapshot_runs", column: "refresh_claim_epoch", dataType: "bigint", isNullable: false, columnDefault: "0" },
  { table: "provider_account_snapshot_runs", column: "refresh_claim_generation", dataType: "text", isNullable: true },
  // The release-gate anti-runaway contract. Every keyed read and the coalescing
  // writer depend on these; without them the table returns to a row per
  // evaluation and a scan per read.
  // Backfilled and NOT NULL. While it was nullable every read had to say
  // COALESCE(provider_scope, 'meta'), which relabelled legacy Google rows as
  // Meta and made global deploy gates unreachable from a Google reader.
  { table: "sync_release_gates", column: "provider_scope", dataType: "text", isNullable: false, columnDefault: "'unknown'" },
  { table: "sync_release_gates", column: "decision_fingerprint", dataType: "text", isNullable: true },
  { table: "sync_release_gates", column: "last_seen_at", dataType: "timestamp with time zone", isNullable: false },
  { table: "sync_release_gates", column: "coalesced_count", dataType: "integer", isNullable: false, columnDefault: "1" },
  // The Meta observation semantic heartbeat. Without these the writer falls back
  // to appending a full state set per observation, which is the growth this
  // change removes.
  { table: "meta_entity_observation_runs", column: "semantic_hash", dataType: "text", isNullable: true },
  { table: "meta_entity_observation_runs", column: "last_seen_at", dataType: "timestamp with time zone", isNullable: true },
  { table: "meta_entity_observation_runs", column: "repeat_count", dataType: "integer", isNullable: false, columnDefault: "1" },
  { table: "meta_entity_observation_runs", column: "last_checkpoint_at", dataType: "timestamp with time zone", isNullable: true },
  // Stable logical identity for lineage edges.
  { table: "meta_creative_lineage_edges", column: "logical_lineage_key", dataType: "text", isNullable: true },
  // The real observation clocks of a relationship recorded on a COALESCED run.
  // The edge's own observed_at/captured_at are pinned to the run's by a
  // composite foreign key, so without these an as-of read at the kept run's
  // instant returns an edge that had not been observed yet.
  { table: "meta_creative_lineage_edges", column: "relationship_observed_at", dataType: "timestamp with time zone", isNullable: true },
  { table: "meta_creative_lineage_edges", column: "relationship_captured_at", dataType: "timestamp with time zone", isNullable: true },
  { table: "provider_connections", column: "connection_generation", dataType: "bigint", isNullable: false, columnDefault: "1" },
  // The Automation activity tuple and guardrail policy. Every one of these is
  // read by a statement that is wrapped in a swallow-all guard, so a silently
  // skipped ALTER would present as "this business has no ROAS floor and its
  // ledger has no actors" — indistinguishable from the truthful answer.
  { table: "meta_automation_activity_ledger", column: "actor_kind", dataType: "text", isNullable: true },
  { table: "meta_automation_activity_ledger", column: "entity_type", dataType: "text", isNullable: true },
  { table: "meta_automation_activity_ledger", column: "entity_id", dataType: "text", isNullable: true },
  { table: "meta_automation_activity_ledger", column: "result_status", dataType: "text", isNullable: true },
  { table: "meta_automation_activity_ledger", column: "result_receipt_id", dataType: "text", isNullable: true },
  { table: "meta_automation_business_controls", column: "min_roas_floor", dataType: "numeric", isNullable: true },
  { table: "meta_automation_business_controls", column: "quiet_hours_start", dataType: "time without time zone", isNullable: true },
  { table: "meta_automation_business_controls", column: "quiet_hours_end", dataType: "time without time zone", isNullable: true },
  { table: "meta_automation_business_controls", column: "quiet_hours_timezone", dataType: "text", isNullable: true },
  { table: "meta_automation_decision_type_modes", column: "clean_approval_threshold", dataType: "integer", isNullable: true },
  // D6 lineage. Nullable on purpose: legacy rows and account-level rows for a
  // multi-account business cannot prove a physical account, and an
  // account-scoped read withholds them rather than showing them everywhere.
  { table: "meta_decision_snapshots_daily", column: "provider_account_id", dataType: "text", isNullable: true },
];

/**
 * Triggers that must NOT exist.
 *
 * Each was a BEFORE INSERT read-then-insert with no per-entity serialisation, so
 * concurrent or out-of-order observations of one entity could lose a genuine
 * A -> B -> A transition. The decision moved into a serialized application
 * writer; a surviving trigger would silently discard rows that writer kept.
 */
export const FORBIDDEN_TRIGGERS: readonly string[] = [
  "trg_skip_unchanged_meta_campaign_config_history",
  "trg_skip_unchanged_meta_adset_config_history",
];

/** Tables this change adds. */
export const VERIFIED_TABLES: readonly string[] = [
  "meta_raw_snapshot_observations",
  "shopify_raw_snapshot_observations",
];

interface EncryptedSecretColumnSpec {
  table: string;
  column: string;
  /** Why a plaintext value in this column is a live credential. */
  why: string;
}

/**
 * Columns that must never hold a secret in the clear.
 *
 * Every other assertion in this file is about SHAPE — a column exists, an index
 * is inferable. This one is about CONTENT, and it is the only kind of assertion
 * that can prove the migration's data conversion actually finished: a schema
 * where `shopify_install_contexts.access_token` is a TEXT column is exactly the
 * schema whether the tokens in it are encrypted or not.
 *
 * The predicate is the one `lib/migrations.ts` converts against and the one
 * `isEncryptedIntegrationSecret` implements, so a row this check accepts is a
 * row the reader will decrypt. It counts rows rather than reading them: a
 * verification step that pulled credentials into the migration log to inspect
 * them would be its own disclosure.
 */
export const VERIFIED_ENCRYPTED_SECRET_COLUMNS: readonly EncryptedSecretColumnSpec[] =
  [
    {
      table: "shopify_install_contexts",
      column: "access_token",
      why: "a Shopify Admin API token, usable against the live store by anyone who can read this table, a backup or a replica",
    },
    {
      table: "integration_credentials",
      column: "access_token",
      why: "a live provider access token for the connection this row belongs to",
    },
    {
      table: "integration_credentials",
      column: "refresh_token",
      why: "a provider REFRESH token, which mints new access tokens indefinitely — production held two of these in plaintext, unrewritten since the day they were granted, because a refresh token is only re-persisted when the principal reconnects",
    },
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
    // Asserted key-for-key. "contains WHERE is_selected" was satisfied by a
    // drifted `(id) WHERE is_selected`, which is a valid partial index that
    // cannot serve the ordered current-selection read at all — the exact drift
    // the negative controls now exercise.
    name: "idx_business_provider_accounts_selected",
    table: "business_provider_accounts",
    unique: false,
    accessMethod: "btree",
    keyExpressions: ["business_id", "provider", '"position"', "id"],
    predicate: "is_selected",
  },
  {
    // The ON CONFLICT arbiter for repair-plan writes. It used to be provided
    // only by the table's inline UNIQUE, whose auto-generated name is 67
    // characters and is truncated to 63 — so the DROP that named the untruncated
    // form matched nothing and the arbiter survived by accident.
    //
    // Name plus fragments was not enough: a same-name UNIQUE index on a SUBSET
    // of the four columns contains every asserted fragment and still makes every
    // production write fail with 42P10. Keys are asserted exactly, in order, with
    // no predicate — a partial arbiter cannot be inferred by the unqualified
    // `ON CONFLICT` the writer issues.
    name: "sync_repair_plans_scope_mode_identity",
    table: "sync_repair_plans",
    unique: true,
    accessMethod: "btree",
    keyExpressions: ["build_id", "environment", "provider_scope", "plan_mode"],
    predicate: null,
  },
  {
    name: "idx_meta_entity_observation_runs_semantic_latest",
    table: "meta_entity_observation_runs",
    unique: false,
    definitionMustContain: ["business_id", "provider_account_id", "entity_type", "endpoint", "observed_at DESC", "id DESC"],
  },
  {
    // Partial, so legacy rows with a NULL logical key stay outside the arbiter
    // instead of colliding with it.
    name: "meta_creative_lineage_logical_identity",
    table: "meta_creative_lineage_edges",
    unique: true,
    definitionMustContain: ["logical_lineage_key", "WHERE (logical_lineage_key IS NOT NULL)"],
  },
  {
    // The keyed latest read for gate evaluation and /build-info. Without it both
    // fall back to ordering a multi-gigabyte relation to return one row.
    //
    // Keyed on the plain `provider_scope` column, not on
    // `COALESCE(provider_scope, 'meta')`. The COALESCE form silently relabelled
    // every legacy NULL row — including Google ones — as Meta; the column is now
    // backfilled and NOT NULL, so the honest predicate is equality and the index
    // matches it exactly.
    name: "idx_sync_release_gates_key_latest",
    table: "sync_release_gates",
    unique: false,
    accessMethod: "btree",
    keyExpressions: [
      "build_id",
      "environment",
      "gate_kind",
      "provider_scope",
      "emitted_at DESC",
      "id DESC",
    ],
    predicate: null,
  },
  {
    // `environment` is a key column, not a filter. Without it the diagnostic
    // read walks the kind's whole history in emitted_at order discarding rows
    // from other environments, which is unbounded work for a one-row question.
    name: "idx_sync_release_gates_kind_latest",
    table: "sync_release_gates",
    unique: false,
    accessMethod: "btree",
    keyExpressions: [
      "gate_kind",
      "provider_scope",
      "environment",
      "emitted_at DESC",
      "id DESC",
    ],
    predicate: null,
  },
  {
    // Retention's candidate scan. It walks the oldest rows in `(emitted_at, id)`
    // order with a LIMIT, so the work it does is bounded by the batch size and
    // not by how much history exists. The previous `DISTINCT ON` over the whole
    // relation bounded only the DELETE.
    name: "idx_sync_release_gates_retention_scan",
    table: "sync_release_gates",
    unique: false,
    accessMethod: "btree",
    keyExpressions: ["emitted_at", "id"],
    predicate: null,
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

  // Secrets at rest. `to_regclass` first, because a table that does not exist
  // cannot be queried at all — and its absence is a DIFFERENT failure from
  // "present with plaintext in it", so the two are reported separately rather
  // than collapsed into one confusing message.
  for (const spec of VERIFIED_ENCRYPTED_SECRET_COLUMNS) {
    const key = `${spec.table}.${spec.column}`;
    const presence = (await sql.query(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`${spec.table}`],
    )) as Array<{ present: boolean }>;
    if (!presence[0]?.present) {
      failures.push({
        kind: "secret_at_rest",
        object: key,
        detail: `table is absent, so the encryption invariant cannot be verified (${spec.why})`,
      });
      continue;
    }
    const plaintext = (await sql.query(
      `SELECT COUNT(*)::text AS count FROM ${spec.table}
       WHERE ${spec.column} IS NOT NULL AND ${spec.column} NOT LIKE 'enc:v1:%'`,
    )) as Array<{ count: string }>;
    const plaintextCount = Number(plaintext[0]?.count ?? "0");
    if (plaintextCount > 0) {
      failures.push({
        kind: "secret_at_rest",
        object: key,
        detail: `${plaintextCount} row(s) hold a value without the 'enc:v1' prefix — ${spec.why}`,
      });
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

  // Trigger contract.
  //
  // The config-history triggers were created by a swallowed `CREATE OR REPLACE`
  // whose presence nothing checked, and their contract — read the latest
  // fingerprint, skip if unchanged — was a read-then-insert with no per-entity
  // serialisation. `appendMetaCurrentConfigHistory` now owns that decision under
  // an advisory lock, so the triggers must be ABSENT: a surviving one silently
  // discards rows the serialized writer already decided to keep, and no test of
  // the writer would ever see it.
  const triggerRows = (await sql.query(
    `SELECT trigger_class.tgname AS trigger_name
     FROM pg_trigger trigger_class
     JOIN pg_class table_class ON table_class.oid = trigger_class.tgrelid
     JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
     WHERE NOT trigger_class.tgisinternal
       AND table_namespace.nspname = current_schema()
       AND trigger_class.tgname = ANY($1::text[])`,
    [[...FORBIDDEN_TRIGGERS]],
  )) as Array<{ trigger_name: string }>;
  for (const row of triggerRows) {
    failures.push({
      kind: "trigger",
      object: row.trigger_name,
      detail:
        "present, but the serialized application writer owns this decision; a surviving trigger silently drops rows it already decided to keep",
    });
  }

  const indexRows = (await sql.query(
    `SELECT index_class.relname AS index_name,
            table_class.relname AS table_name,
            table_namespace.nspname AS schema_name,
            index_catalog.indisunique AS is_unique,
            index_catalog.indisvalid AS is_valid,
            index_catalog.indisready AS is_ready,
            index_catalog.indislive AS is_live,
            index_catalog.indnkeyatts AS key_attribute_count,
            pg_get_indexdef(index_class.oid) AS definition
     FROM pg_class index_class
     JOIN pg_index index_catalog ON index_catalog.indexrelid = index_class.oid
     JOIN pg_class table_class ON table_class.oid = index_catalog.indrelid
     JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
     WHERE index_class.relname = ANY($1::text[])
       AND table_namespace.nspname = current_schema()`,
    [VERIFIED_INDEXES.map((spec) => spec.name)],
  )) as Array<{
    index_name: string;
    table_name: string;
    schema_name: string;
    is_unique: boolean;
    is_valid: boolean;
    is_ready: boolean;
    is_live: boolean;
    key_attribute_count: number;
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
    for (const fragment of spec.definitionMustContain ?? []) {
      if (!found.definition.includes(fragment)) {
        failures.push({
          kind: "index",
          object: spec.name,
          detail: `definition missing '${fragment}': ${found.definition}`,
        });
      }
    }

    const parsed = parseIndexDefinition(found.definition);
    if (spec.accessMethod != null && parsed.accessMethod !== spec.accessMethod) {
      failures.push({
        kind: "index",
        object: spec.name,
        detail: `access method is ${String(parsed.accessMethod)}, expected ${spec.accessMethod}: ${found.definition}`,
      });
    }
    if (spec.keyExpressions != null) {
      const actual = parsed.keyExpressions.join(", ");
      const expected = spec.keyExpressions.join(", ");
      if (actual !== expected) {
        failures.push({
          kind: "index",
          object: spec.name,
          detail: `key expressions are (${actual}), expected exactly (${expected}): ${found.definition}`,
        });
      }
      // INCLUDE columns are not key columns and cannot serve an arbiter or an
      // ORDER BY, so a definition whose key count disagrees with the parsed key
      // list is a different index from the one asserted.
      if (Number(found.key_attribute_count) !== spec.keyExpressions.length) {
        failures.push({
          kind: "index",
          object: spec.name,
          detail: `indnkeyatts is ${found.key_attribute_count}, expected ${spec.keyExpressions.length}: ${found.definition}`,
        });
      }
    }
    if (spec.predicate !== undefined && parsed.predicate !== spec.predicate) {
      failures.push({
        kind: "index",
        object: spec.name,
        detail: `predicate is ${parsed.predicate == null ? "absent" : `'${parsed.predicate}'`}, expected ${
          spec.predicate == null ? "absent" : `'${spec.predicate}'`
        }: ${found.definition}`,
      });
    }
  }

  // Writer/read compatibility. A schema can satisfy every catalog assertion
  // above and still reject the exact statement shapes the application uses —
  // the ON CONFLICT arbiters in particular, which need the partial unique
  // indexes to be inferable.
  //
  // These MUST run on one pinned connection. `getDbWithTimeout` hands back a
  // POOLED executor: every `query` may land on a different backend. Issuing
  // `BEGIN`, then the probe INSERTs, then `ROLLBACK` through it meant the BEGIN
  // opened a transaction on one connection and left it there, the INSERTs ran
  // on other connections in autocommit — and COMMITTED — and the ROLLBACK
  // rolled back a connection that had done nothing. The check that promised to
  // write nothing wrote `__verify__` rows into three production tables and
  // leaked an idle-in-transaction backend on every run.
  //
  // `runDbTransaction` pins one client for the whole callback. Rollback is
  // requested by throwing a sentinel, which is the only way to get a
  // guaranteed ROLLBACK out of a helper whose success path commits.
  const probeFailures = await runProbeAndRollback(async (tx) => {
    await tx.query(
      `INSERT INTO meta_raw_snapshots
         (business_id, provider_account_id, endpoint_name, entity_scope,
          start_date, end_date, payload_json, payload_hash, content_key, status)
       VALUES ('__verify__', '__verify__', 'verify', 'verify', CURRENT_DATE,
               CURRENT_DATE, '{}'::jsonb, 'verify', '__verify__', 'fetched')
       ON CONFLICT (content_key) WHERE content_key IS NOT NULL
       DO UPDATE SET observation_count = meta_raw_snapshots.observation_count + 1`,
    );
    await tx.query(
      `INSERT INTO shopify_raw_snapshots
         (business_id, provider_account_id, endpoint_name, entity_scope,
          payload_json, payload_hash, content_key, status)
       VALUES ('__verify__', '__verify__', 'verify', 'verify',
               '{}'::jsonb, 'verify', '__verify__', 'fetched')
       ON CONFLICT (content_key) WHERE content_key IS NOT NULL
       DO UPDATE SET observation_count = shopify_raw_snapshots.observation_count + 1`,
    );
    await tx.query(
      `SELECT 1 FROM business_provider_accounts WHERE is_selected LIMIT 1`,
    );
    // The repair-plan arbiter, in the exact unqualified shape `persistRepairPlan`
    // issues. Catalog assertions prove an index with those four keys exists;
    // only this proves PostgreSQL will INFER it for this statement. A partial or
    // subset index passes every catalog check and raises 42P10 here.
    await tx.query(
      `INSERT INTO sync_repair_plans
         (build_id, environment, provider_scope, plan_mode, eligible, summary, payload_json)
       VALUES ('__verify__', '__verify__', '__verify__', 'dry_run', FALSE, 'verify', '{}'::jsonb)
       ON CONFLICT (build_id, environment, provider_scope, plan_mode)
       DO UPDATE SET summary = EXCLUDED.summary`,
    );
    // The release-gate keyed read and the retention candidate, in their exact
    // production shapes. `provider_scope = $n` only parses once the column is
    // NOT NULL-backfilled; the retention candidate only parses with the
    // row-comparison the bounded plan depends on.
    await tx.query(
      `SELECT id FROM sync_release_gates
       WHERE build_id = '__verify__' AND environment = '__verify__'
         AND gate_kind = 'deploy_gate' AND provider_scope = 'global'
       ORDER BY emitted_at DESC, id DESC LIMIT 1`,
    );
    await tx.query(
      `WITH aged AS (
         SELECT id, build_id, environment, gate_kind, provider_scope, emitted_at
         FROM sync_release_gates
         WHERE emitted_at < now() - make_interval(days => 3650)
         ORDER BY emitted_at ASC, id ASC
         LIMIT 1
       )
       SELECT aged.id FROM aged
       WHERE EXISTS (
         SELECT 1 FROM sync_release_gates newer
         WHERE newer.build_id = aged.build_id
           AND newer.environment = aged.environment
           AND newer.gate_kind = aged.gate_kind
           AND newer.provider_scope = aged.provider_scope
           AND (newer.emitted_at, newer.id) > (aged.emitted_at, aged.id)
       )`,
    );
    // The growth fence's physical-capacity read, in the exact shape it uses.
    // Catalog assertions above prove the table and index exist; this proves the
    // statement the fence actually issues parses and runs, including the
    // clock_timestamp() age arithmetic that decides staleness.
    await tx.query(
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
  });
  failures.push(...probeFailures);

  if (failures.length > 0) {
    throw new MigrationVerificationError(failures);
  }
  return {
    verified:
      VERIFIED_COLUMNS.length +
      VERIFIED_TABLES.length +
      VERIFIED_FOREIGN_KEYS.length +
      VERIFIED_INDEXES.length +
      VERIFIED_ENCRYPTED_SECRET_COLUMNS.length,
  };
}
