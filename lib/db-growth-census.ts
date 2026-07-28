import { getDb } from "@/lib/db";

/**
 * Read-only growth census queries.
 *
 * Extracted from the script so they can be driven directly by a
 * least-privilege seam. Every function here reads; none writes, locks beyond an
 * ordinary catalog read, or issues DDL.
 *
 * THE PRIVILEGE CONSTRAINT THAT SHAPES THIS FILE. Production runs as
 * `adsecute_app`, a non-superuser role (see the DR seam, which asserts exactly
 * that). Nothing in this repository proves it holds `pg_monitor`. Several
 * useful system functions — `pg_ls_waldir()` above all — require `pg_monitor`
 * or superuser and raise `42501 permission denied` otherwise. So no privileged
 * probe may share a statement with an unprivileged one: one denied function
 * would take the whole statement down and the census would report nothing at
 * all, which is strictly worse than reporting most of it.
 */

/** The privilege error PostgreSQL raises for a denied system function. */
const INSUFFICIENT_PRIVILEGE = "42501";
/** Raised when the function itself is absent (older/newer server). */
const UNDEFINED_FUNCTION = "42883";

export type Unavailable = { available: false; reason: string };
export type Available<T> = { available: true; value: T };
export type Probe<T> = Available<T> | Unavailable;

function describeUnavailable(error: unknown): Unavailable {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === INSUFFICIENT_PRIVILEGE) {
    return {
      available: false,
      reason: `permission denied (${code}) — this role lacks pg_monitor/superuser: ${message}`,
    };
  }
  if (code === UNDEFINED_FUNCTION) {
    return { available: false, reason: `function unavailable (${code}): ${message}` };
  }
  return { available: false, reason: code ? `${code}: ${message}` : message };
}

export interface DatabaseSize {
  name: string;
  databaseBytes: string;
}

/**
 * Database name and size. Deliberately contains NOTHING privileged, so it
 * cannot be taken down by a denied probe.
 */
export async function readDatabaseSize(): Promise<DatabaseSize | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT current_database() AS name,
            pg_database_size(current_database())::text AS database_bytes`,
  )) as Array<Record<string, string>>;
  const row = rows[0];
  return row ? { name: row.name, databaseBytes: row.database_bytes } : null;
}

/**
 * Total WAL bytes — SEPARATE statement, because `pg_ls_waldir()` requires
 * pg_monitor. Returns an explicit unavailability with the reason rather than
 * zero: a WAL total of 0 is a claim about the server, and inventing it would be
 * a lie that looks like a measurement.
 */
export async function readWalBytes(): Promise<Probe<string>> {
  const sql = getDb();
  try {
    const rows = (await sql.query(
      `SELECT COALESCE(SUM(size), 0)::text AS wal_bytes FROM pg_ls_waldir()`,
    )) as Array<Record<string, string>>;
    const value = rows[0]?.wal_bytes;
    return value == null
      ? { available: false, reason: "pg_ls_waldir() returned no rows" }
      : { available: true, value };
  } catch (error) {
    return describeUnavailable(error);
  }
}

export interface RelationSize {
  relation: string;
  totalBytes: string;
  heapBytes: string;
  indexBytes: string;
  toastBytes: string;
  estimatedRows: string;
}

/**
 * The whole public schema, ordered by size. Not filtered to a suspected list:
 * filtering to names someone already suspected is exactly how an unmeasured
 * remainder stays unmeasured.
 *
 * `pg_total_relation_size` on a relation the role cannot read still works — it
 * reads the catalog, not the rows — so this survives a least-privilege role.
 */
export async function readRelationCensus(top: number): Promise<RelationSize[]> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT c.relname AS relation,
            pg_total_relation_size(c.oid)::text                        AS total_bytes,
            pg_relation_size(c.oid)::text                              AS heap_bytes,
            pg_indexes_size(c.oid)::text                               AS index_bytes,
            COALESCE(pg_total_relation_size(c.reltoastrelid), 0)::text AS toast_bytes,
            c.reltuples::bigint::text                                  AS estimated_rows
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','m')
     ORDER BY pg_total_relation_size(c.oid) DESC
     LIMIT $1`,
    [top],
  )) as Array<Record<string, string>>;
  return rows.map((row) => ({
    relation: row.relation,
    totalBytes: row.total_bytes,
    heapBytes: row.heap_bytes,
    indexBytes: row.index_bytes,
    toastBytes: row.toast_bytes,
    estimatedRows: row.estimated_rows,
  }));
}

export interface BloatSignal {
  relation: string;
  liveTuples: string;
  deadTuples: string;
  deadPct: string;
  lastAutovacuum: string;
}

/**
 * Dead-tuple and vacuum state. A large dead fraction means a meaningful share
 * of a relation is reclaimable by a rewrite WITHOUT deleting a single row — the
 * cheapest available win, and one the size numbers alone hide.
 *
 * `pg_stat_user_tables` is readable by any role, but the counters are reset by
 * a stats reset and are estimates, so this is a signal rather than a fact.
 */
export async function readBloatSignals(top: number): Promise<Probe<BloatSignal[]>> {
  const sql = getDb();
  try {
    const rows = (await sql.query(
      `SELECT relname AS relation,
              n_live_tup::text AS live_tuples,
              n_dead_tup::text AS dead_tuples,
              CASE WHEN n_live_tup + n_dead_tup > 0
                   THEN ROUND(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2)::text
                   ELSE '0' END AS dead_pct,
              COALESCE(last_autovacuum::text, 'never') AS last_autovacuum
       FROM pg_stat_user_tables
       WHERE schemaname = 'public'
       ORDER BY n_dead_tup DESC
       LIMIT $1`,
      [top],
    )) as Array<Record<string, string>>;
    return {
      available: true,
      value: rows.map((row) => ({
        relation: row.relation,
        liveTuples: row.live_tuples,
        deadTuples: row.dead_tuples,
        deadPct: row.dead_pct,
        lastAutovacuum: row.last_autovacuum,
      })),
    };
  } catch (error) {
    return describeUnavailable(error);
  }
}

/**
 * The last filesystem sample the database host reported, and — critically —
 * which mount point it actually measured.
 *
 * If the path the sampler was asked about is not itself a mount point, `df`
 * reported the PARENT filesystem and never measured the data directory. That
 * one fact can reconcile a recorded database larger than the volume it
 * supposedly occupies, and nothing else in the system can see it.
 */
export async function readVolumeSample(): Promise<Probe<Array<Record<string, string>>>> {
  const sql = getDb();
  try {
    const rows = (await sql.query(
      `SELECT s.captured_at::text AS captured_at,
              EXTRACT(EPOCH FROM (now() - s.captured_at))::bigint::text AS age_seconds,
              d->>'path'                   AS path,
              d->>'mountedOn'              AS mounted_on,
              d->>'filesystem'             AS filesystem,
              (d->>'totalBytes')::text     AS total_bytes,
              (d->>'usedBytes')::text      AS used_bytes,
              (d->>'availableBytes')::text AS available_bytes
       FROM system_capacity_snapshots s
       CROSS JOIN LATERAL jsonb_array_elements(s.payload->'disks') AS d
       WHERE s.source = 'db_host_healthcheck'
       ORDER BY s.captured_at DESC
       LIMIT 6`,
    )) as Array<Record<string, string>>;
    return { available: true, value: rows };
  } catch (error) {
    return describeUnavailable(error);
  }
}

/** Bounds for --top. A LIMIT must always be a real, positive, bounded integer. */
export const MIN_TOP = 1;
export const MAX_TOP = 500;
export const DEFAULT_TOP = 30;

/**
 * Parse --top into a bounded LIMIT.
 *
 * Returns an error rather than silently substituting a default: `--top=abc`
 * quietly becoming 30 is how someone believes they censused 400 relations when
 * they censused 30. A malformed bound must stop the run, not reshape it.
 */
export function parseTop(raw: string | null | undefined): { top: number } | { error: string } {
  if (raw == null || raw === "") return { top: DEFAULT_TOP };
  if (!/^\d+$/.test(raw.trim())) {
    return {
      error: `--top must be a positive integer, got '${raw}'. Refusing rather than guessing a bound.`,
    };
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TOP) {
    return { error: `--top must be at least ${MIN_TOP}, got '${raw}'.` };
  }
  if (parsed > MAX_TOP) {
    return { error: `--top must be at most ${MAX_TOP}, got '${raw}'.` };
  }
  return { top: parsed };
}

/**
 * Validate a relation name for the opt-in exact count.
 *
 * Two separate concerns, and both matter:
 *   - Injection: the name is interpolated into the statement because a relation
 *     cannot be a bind parameter, so the character set must be closed.
 *   - HONESTY: the census reports `public` only. An unqualified name resolves
 *     through `search_path`, so a same-named relation in another schema would
 *     be counted and printed beside `public` numbers as though it were the same
 *     object. The count is therefore always taken from `public` explicitly.
 */
export function parseExactTable(
  raw: string | null | undefined,
): { table: string } | { error: string } {
  if (raw == null || raw === "") return { error: "--table requires a relation name" };
  const value = raw.trim();
  if (value.length > 63) {
    // PostgreSQL truncates identifiers at NAMEDATALEN-1; a longer name would
    // silently address a different relation than the operator typed.
    return { error: `--table is longer than 63 characters, which PostgreSQL would truncate` };
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    return {
      error: `--table must be a lower-case unquoted identifier, got '${raw}'. Refusing an unsafe relation name.`,
    };
  }
  return { table: value };
}

/**
 * Opt-in and expensive: an exact count for one named relation, always in
 * `public`, and only if the relation actually exists there.
 */
export async function readExactCount(table: string): Promise<Probe<string>> {
  const parsed = parseExactTable(table);
  if ("error" in parsed) return { available: false, reason: parsed.error };
  const sql = getDb();
  try {
    const exists = (await sql.query(
      `SELECT to_regclass('public.' || $1) IS NOT NULL AS present`,
      [parsed.table],
    )) as Array<Record<string, boolean>>;
    if (!exists[0]?.present) {
      return { available: false, reason: `public.${parsed.table} does not exist` };
    }
    const rows = (await sql.query(
      `SELECT COUNT(*)::text AS exact_rows FROM public.${parsed.table}`,
    )) as Array<Record<string, string>>;
    const value = rows[0]?.exact_rows;
    return value == null
      ? { available: false, reason: "count returned no rows" }
      : { available: true, value };
  } catch (error) {
    return describeUnavailable(error);
  }
}
