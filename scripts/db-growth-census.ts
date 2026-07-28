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
 * file or in lib/db-growth-census.ts, and it takes no locks beyond an ordinary
 * catalog read. It cannot enable retention and it cannot remove anything.
 *
 * IT RUNS UNDER A LEAST-PRIVILEGE ROLE. Production is `adsecute_app`, a
 * non-superuser. Privileged probes — `pg_ls_waldir()` above all — are issued as
 * their OWN statements and degrade to an explicit "unavailable, because …".
 * Sharing a statement with them would let one denied function take down the
 * database size and the entire relation census, which is strictly worse than
 * reporting most of the picture.
 *
 * CHEAP BY DEFAULT. Everything in the default pass comes from the catalog or
 * from statistics estimates. The expensive half — an exact COUNT(*) on a
 * multi-gigabyte relation — is opt-in via --table, because that is a sequential
 * scan competing with live sync.
 *
 * Usage:
 *   node --import tsx scripts/db-growth-census.ts
 *   node --import tsx scripts/db-growth-census.ts --top=40
 *   node --import tsx scripts/db-growth-census.ts --table=meta_config_snapshots
 */
import {
  parseTop,
  readBloatSignals,
  readDatabaseSize,
  readExactCount,
  readRelationCensus,
  readVolumeSample,
  readWalBytes,
} from "@/lib/db-growth-census";

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

async function main() {
  const parsedTop = parseTop(arg("top"));
  if ("error" in parsedTop) {
    console.error(`${LABEL} REFUSED: ${parsedTop.error}`);
    process.exit(2);
  }
  const top = parsedTop.top;
  const exactTable = arg("table");

  // Unprivileged, and first: if anything here fails the run is genuinely
  // broken, rather than merely missing an optional probe.
  const size = await readDatabaseSize();
  console.log(`${LABEL} database`, {
    name: size?.name ?? "unknown",
    databaseBytes: size?.databaseBytes ?? null,
    databasePretty: bytes(size?.databaseBytes ?? null),
  });

  // Privileged, and isolated. Never reported as zero when it could not be read.
  const wal = await readWalBytes();
  console.log(
    `${LABEL} wal`,
    wal.available
      ? { walBytes: wal.value, walPretty: bytes(wal.value) }
      : { walBytes: "unavailable", reason: wal.reason },
  );

  const relations = await readRelationCensus(top);
  const measured = relations.reduce((sum, row) => sum + Number(row.totalBytes), 0);
  console.log(`${LABEL} top ${top} relations:`);
  for (const row of relations) {
    console.log(
      `  ${row.relation.padEnd(44)} total=${bytes(row.totalBytes).padStart(10)}` +
        `  heap=${bytes(row.heapBytes).padStart(10)}` +
        `  index=${bytes(row.indexBytes).padStart(10)}` +
        `  toast=${bytes(row.toastBytes).padStart(10)}` +
        `  ~rows=${row.estimatedRows}`,
    );
  }

  const databaseBytes = Number(size?.databaseBytes ?? 0);
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

  const bloat = await readBloatSignals(15);
  if (!bloat.available) {
    console.log(`${LABEL} bloat signals unavailable`, { reason: bloat.reason });
  } else {
    console.log(`${LABEL} bloat signals (dead tuples are reclaimable WITHOUT deleting rows):`);
    for (const row of bloat.value) {
      console.log(
        `  ${row.relation.padEnd(44)} dead=${row.deadTuples.padStart(12)}` +
          `  live=${row.liveTuples.padStart(12)}  dead%=${row.deadPct.padStart(6)}` +
          `  lastAutovacuum=${row.lastAutovacuum}`,
      );
    }
  }

  const volume = await readVolumeSample();
  if (!volume.available) {
    console.log(`${LABEL} volume sample unavailable`, { reason: volume.reason });
  } else if (volume.value.length === 0) {
    console.log(
      `${LABEL} NO db_host_healthcheck capacity sample is available. The app cannot see the ` +
        `database host's filesystem, so there is NO evidence about free space from here.`,
    );
  } else {
    console.log(`${LABEL} last reported volumes:`);
    for (const row of volume.value) {
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
    const exact = await readExactCount(exactTable);
    console.log(
      `${LABEL} exact rows`,
      exact.available
        ? { table: `public.${exactTable}`, rows: exact.value }
        : { table: exactTable, rows: "unavailable", reason: exact.reason },
    );
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
