/**
 * Read-only database growth census.
 *
 * WHY THIS EXISTS. The growth budgets in lib/sync/db-growth-fence.ts are derived
 * from a hand-transcribed measurement taken once, on 2026-07-26. That constant
 * is the only picture of where the bytes are, and it has two known problems:
 *
 *   1. It is not a census. Ten relations carry a measured size; their sum is
 *      ~82% of the recorded database size, so ~18% sits in relations that were
 *      never measured at all. A runaway in that 18% would be invisible.
 *   2. It contains an unresolved contradiction. The recorded database size is
 *      larger than the recorded filesystem usage of the volume it supposedly
 *      sits on. The fence's own comment acknowledges the gap and deliberately
 *      assumes the pessimistic direction rather than explaining it.
 *
 * Guessing from that constant is how a cleanup ends up aimed at the wrong table.
 * This tool replaces the guess with a measurement.
 *
 * IT ONLY READS. There is no DELETE, UPDATE, VACUUM or DDL anywhere in this
 * file, and it takes no locks beyond an ordinary catalog read. It cannot enable
 * retention and it cannot be made to remove anything.
 *
 * CHEAP BY DEFAULT. Everything in the default pass comes from the catalog or
 * from statistics estimates. The expensive half — exact COUNT(*) and duplicate
 * cardinality on multi-gigabyte relations — is opt-in via --exact, because on a
 * large table that is a sequential scan competing with live sync.
 *
 * Usage:
 *   node --import tsx scripts/db-growth-census.ts
 *   node --import tsx scripts/db-growth-census.ts --top=40
 *   node --import tsx scripts/db-growth-census.ts --exact --table=meta_config_snapshots
 */
import { getDb } from "@/lib/db";

const LABEL = "[db-growth-census]";

function arg(name: string): string | null {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function bytes(value: string | number | null): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let scaled = numeric;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/**
 * The whole public schema, ordered by size. Deliberately NOT filtered to a
 * known table list: filtering to names someone already suspected is exactly how
 * the unmeasured remainder stayed unmeasured.
 */
async function relationCensus(top: number) {
  const sql = getDb();
  return (await sql.query(
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
}

async function databaseSize() {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT current_database() AS name,
            pg_database_size(current_database())::text AS database_bytes,
            (SELECT COALESCE(SUM(size), 0)::text FROM pg_ls_waldir()) AS wal_bytes`,
  )) as Array<Record<string, string>>;
  return rows[0] ?? null;
}

/**
 * Dead-tuple and vacuum state. A large dead fraction means a meaningful share
 * of a relation is reclaimable by VACUUM FULL / pg_repack WITHOUT deleting a
 * single row — the cheapest possible win, and one the size numbers alone hide.
 */
async function bloatSignals(top: number) {
  const sql = getDb();
  return (await sql.query(
    `SELECT relname AS relation,
            n_live_tup::text AS live_tuples,
            n_dead_tup::text AS dead_tuples,
            CASE WHEN n_live_tup + n_dead_tup > 0
                 THEN ROUND(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2)::text
                 ELSE '0' END AS dead_pct,
            COALESCE(last_autovacuum::text, 'never') AS last_autovacuum,
            COALESCE(last_autoanalyze::text, 'never') AS last_autoanalyze
     FROM pg_stat_user_tables
     WHERE schemaname = 'public'
     ORDER BY n_dead_tup DESC
     LIMIT $1`,
    [top],
  )) as Array<Record<string, string>>;
}

/**
 * The filesystem the database host last reported, and — critically — which
 * mount point it actually measured.
 *
 * If the path the sampler was asked about is not itself a mount point, `df`
 * reported the PARENT filesystem and never measured the data directory. That
 * single fact reconciles the recorded database-larger-than-volume
 * contradiction, and nothing else in the system can see it.
 */
async function volumeSample() {
  const sql = getDb();
  return (await sql
    .query(
      `SELECT s.captured_at::text AS captured_at,
              EXTRACT(EPOCH FROM (now() - s.captured_at))::bigint::text AS age_seconds,
              d->>'path'            AS path,
              d->>'mountedOn'       AS mounted_on,
              d->>'filesystem'      AS filesystem,
              (d->>'totalBytes')::text     AS total_bytes,
              (d->>'usedBytes')::text      AS used_bytes,
              (d->>'availableBytes')::text AS available_bytes
       FROM system_capacity_snapshots s
       CROSS JOIN LATERAL jsonb_array_elements(s.payload->'disks') AS d
       WHERE s.source = 'db_host_healthcheck'
       ORDER BY s.captured_at DESC
       LIMIT 6`,
    )
    .catch(() => [])) as Array<Record<string, string>>;
}

/** Opt-in and expensive: exact rows for one named relation. */
async function exactCount(table: string) {
  const sql = getDb();
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`refusing an unsafe relation name: ${table}`);
  }
  const rows = (await sql.query(
    `SELECT COUNT(*)::text AS exact_rows FROM ${table}`,
  )) as Array<Record<string, string>>;
  return rows[0]?.exact_rows ?? null;
}

async function main() {
  const top = Number(arg("top") ?? 30);
  const exactTable = arg("table");

  const size = await databaseSize();
  console.log(`${LABEL} database`, {
    name: size?.name ?? "unknown",
    databaseBytes: size?.database_bytes ?? null,
    databasePretty: bytes(size?.database_bytes ?? null),
    walBytes: size?.wal_bytes ?? null,
    walPretty: bytes(size?.wal_bytes ?? null),
  });

  const relations = await relationCensus(top);
  const measured = relations.reduce((sum, row) => sum + Number(row.total_bytes), 0);
  console.log(`${LABEL} top ${top} relations:`);
  for (const row of relations) {
    console.log(
      `  ${row.relation.padEnd(44)} total=${bytes(row.total_bytes).padStart(10)}` +
        `  heap=${bytes(row.heap_bytes).padStart(10)}` +
        `  index=${bytes(row.index_bytes).padStart(10)}` +
        `  toast=${bytes(row.toast_bytes).padStart(10)}` +
        `  ~rows=${row.estimated_rows}`,
    );
  }

  const databaseBytes = Number(size?.database_bytes ?? 0);
  const remainder = databaseBytes - measured;
  console.log(`${LABEL} coverage`, {
    measuredTop: bytes(measured),
    databaseTotal: bytes(databaseBytes),
    unmeasuredRemainder: bytes(remainder),
    // The remainder is catalogs, WAL, free space map and every relation outside
    // the top N. A LARGE remainder means the ranking above is not the whole
    // story and --top should be raised before drawing any conclusion.
    remainderPct:
      databaseBytes > 0 ? `${((remainder / databaseBytes) * 100).toFixed(1)}%` : "unknown",
  });

  console.log(`${LABEL} bloat signals (dead tuples are reclaimable WITHOUT deleting rows):`);
  for (const row of await bloatSignals(15)) {
    console.log(
      `  ${row.relation.padEnd(44)} dead=${row.dead_tuples.padStart(12)}` +
        `  live=${row.live_tuples.padStart(12)}  dead%=${row.dead_pct.padStart(6)}` +
        `  lastAutovacuum=${row.last_autovacuum}`,
    );
  }

  const volume = await volumeSample();
  if (volume.length === 0) {
    console.log(
      `${LABEL} NO db_host_healthcheck capacity sample is available. The app cannot see the ` +
        `database host's filesystem, so there is NO evidence about free space from here.`,
    );
  } else {
    console.log(`${LABEL} last reported volumes:`);
    for (const row of volume) {
      const misreported = row.mounted_on && row.path && row.mounted_on !== row.path;
      console.log(
        `  path=${row.path} mountedOn=${row.mounted_on} fs=${row.filesystem}` +
          ` total=${bytes(row.total_bytes)} used=${bytes(row.used_bytes)}` +
          ` free=${bytes(row.available_bytes)} age=${row.age_seconds}s` +
          (misreported
            ? "   <-- mountedOn != path: df measured the PARENT filesystem, not this directory"
            : ""),
      );
    }
  }

  if (exactTable) {
    console.log(`${LABEL} exact count for ${exactTable} (this is a full scan)...`);
    console.log(`${LABEL} exact rows`, { table: exactTable, rows: await exactCount(exactTable) });
  }

  console.log(
    `${LABEL} NOTE: DELETE returns space to a relation's free space map for reuse. It does NOT ` +
      `return space to the filesystem, and pg_database_size will not fall. Only a rewrite ` +
      `(VACUUM FULL / pg_repack) returns bytes to the volume, and neither exists in this repo.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
