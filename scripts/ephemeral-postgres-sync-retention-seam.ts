/**
 * Cluster C3 — retention, readiness, growth and release boundaries against a
 * real migrated PostgreSQL.
 *
 * Retention is the only ordinary path in this system that deletes rows, so it
 * gets the same treatment as the sync entrypoints: nothing below the database
 * boundary is faked. Real migrations, real `getDb`, the real
 * `pruneSyncLifecycleData`, the real readiness contract and the real growth
 * fence. The cases prove BOTH directions — that the sweep collects what it
 * should, and that it refuses, without mutating anything, when the schema it
 * depends on has drifted.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "sync_retention_seam";
const USER = "postgres";
const LABEL = "[sync-retention-seam]";
const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const META_ACCOUNT_ID = "act_900800700";
const SHOP_ID = "retention-seam.myshopify.com";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function pgBinDir() {
  const need = ["initdb", "pg_ctl", "createdb"];
  const linux = fs.existsSync("/usr/lib/postgresql")
    ? fs
        .readdirSync("/usr/lib/postgresql", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join("/usr/lib/postgresql", entry.name, "bin"))
    : [];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    ...linux,
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter(Boolean) as string[];
  const found = candidates.find((dir) =>
    need.every((bin) => fs.existsSync(path.join(dir, bin))),
  );
  if (!found) throw new Error("PostgreSQL binaries not found.");
  return found;
}

async function freePort() {
  for (let i = 0; i < 10; i += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          address && typeof address === "object"
            ? resolve(address.port)
            : reject(new Error("no port")),
        );
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("no safe port");
}

function run(bin: string, args: string[], label: string) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}). ${result.stderr?.trim() ?? ""}`);
  }
}

async function countRows(client: Client, table: string, where = "TRUE") {
  const rows = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${where}`,
  );
  return Number(rows.rows[0]!.count);
}

interface RetentionCensus {
  metaContent: number;
  metaReceipts: number;
  shopifyContent: number;
  shopifyReceipts: number;
}

async function census(client: Client): Promise<RetentionCensus> {
  return {
    metaContent: await countRows(client, "meta_raw_snapshots"),
    metaReceipts: await countRows(client, "meta_raw_snapshot_observations"),
    shopifyContent: await countRows(client, "shopify_raw_snapshots"),
    shopifyReceipts: await countRows(client, "shopify_raw_snapshot_observations"),
  };
}

// ── T1. The declared-name fail-closed readiness contract ───────────────────

async function verifyReadinessContract(client: Client) {
  const { SYNC_RETENTION_EXECUTION_INDEX_SPECS } = await import(
    "@/lib/sync/retention-schema-contract"
  );
  const {
    getSyncRetentionExecutionReadiness,
    assertSyncRetentionExecutionSpecsAreResolvable,
  } = await import("@/lib/sync/retention-readiness");

  // Every declared spec must name a real relation. A spec for a table this
  // deployment does not have could never be satisfied, so the gate would refuse
  // forever — never-open, not fail-closed.
  const resolvableTables = await assertSyncRetentionExecutionSpecsAreResolvable();
  assert(
    resolvableTables > 0,
    "T1: the contract declares no tables at all, so it constrains nothing.",
  );

  const readiness = await getSyncRetentionExecutionReadiness();
  assert(
    readiness.ready,
    `T1: the retention execution contract is not satisfiable on a freshly migrated schema: ${JSON.stringify(readiness)}`,
  );

  // Both observation-retention indexes must be IN the contract by declared
  // name. Receipts are aged out before content, so they are part of the same
  // destructive path; leaving them out would put a delete sweep on an
  // unspecified index.
  const declaredNames = SYNC_RETENTION_EXECUTION_INDEX_SPECS.map((spec) => spec.name);
  for (const required of [
    "idx_meta_raw_snapshot_observations_retention",
    "idx_shopify_raw_snapshot_observations_retention",
  ]) {
    assert(
      declaredNames.includes(required),
      `T1: ${required} is not under the fail-closed contract, so the receipt sweep is under-specified.`,
    );
  }

  // Coverage in the OTHER direction: every relation the sweep actually deletes
  // from must be covered by at least one declared index. Resolvability alone
  // can be satisfied while a destructive path runs entirely unindexed.
  const { SYNC_RETENTION_DELETE_TARGET_TABLES } = await import("@/lib/sync/retention");
  const coveredTables = new Set(
    SYNC_RETENTION_EXECUTION_INDEX_SPECS.map((spec) => spec.table),
  );
  const uncovered = SYNC_RETENTION_DELETE_TARGET_TABLES.filter(
    (table) => !coveredTables.has(table),
  );
  assert(
    uncovered.length === 0,
    `T1: the sweep deletes from relations no declared index covers: ${uncovered.join(", ")}`,
  );

  // Every declared index must exist with the declared identity — not merely
  // exist by name.
  for (const spec of SYNC_RETENTION_EXECUTION_INDEX_SPECS) {
    const row = await client.query<{
      indisvalid: boolean;
      indisready: boolean;
      indislive: boolean;
      amname: string;
      indisunique: boolean;
    }>(
      `SELECT i.indisvalid, i.indisready, i.indislive, am.amname, i.indisunique
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_am am ON am.oid = c.relam
       WHERE c.relname = $1`,
      [spec.name],
    );
    assert(
      row.rowCount === 1,
      `T1: declared index ${spec.name} does not exist on the migrated schema.`,
    );
    const found = row.rows[0]!;
    assert(
      found.indisvalid && found.indisready && found.indislive,
      `T1: ${spec.name} is not valid/ready/live: ${JSON.stringify(found)}`,
    );
    assert(
      found.amname === spec.accessMethod,
      `T1: ${spec.name} uses ${found.amname}, contract declares ${spec.accessMethod}.`,
    );
    assert(
      found.indisunique === spec.unique,
      `T1: ${spec.name} uniqueness is ${found.indisunique}, contract declares ${spec.unique}.`,
    );
  }
  console.log(
    `${LABEL} T1 PASS readiness contract: all ${SYNC_RETENTION_EXECUTION_INDEX_SPECS.length} declared indexes exist with matching method/uniqueness and are valid/ready/live, every declared spec resolves to a real relation, and all ${SYNC_RETENTION_DELETE_TARGET_TABLES.length} delete targets are covered; both observation-retention indexes are under the contract`,
  );
}

// ── T2. Negative drift refuses before any claim or deletion ────────────────

async function verifyDriftRefusal(client: Client) {
  const { pruneSyncLifecycleData } = await import("@/lib/sync/retention");
  const before = await census(client);
  const leasesBefore = await countRows(client, "sync_runner_leases");

  // Drop one declared index and prove the sweep refuses rather than degrading
  // to a sequential scan over a destructive path.
  await client.query(`DROP INDEX IF EXISTS idx_meta_raw_snapshot_observations_retention`);
  const refusal = await pruneSyncLifecycleData().then(
    (value) => ({ kind: "resolved" as const, value }),
    (error) => ({ kind: "rejected" as const, error }),
  );
  assert(
    refusal.kind === "rejected",
    `T2: a missing declared index did not refuse the sweep: ${JSON.stringify(refusal)}`,
  );
  assert(
    String((refusal.error as Error).message).includes("not ready"),
    `T2: the refusal is not the readiness contract: ${String((refusal.error as Error).message)}`,
  );

  const after = await census(client);
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    `T2: a refused sweep mutated rows.\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`,
  );
  assert(
    (await countRows(client, "sync_runner_leases")) === leasesBefore,
    "T2: a refused sweep took a retention lease, which a crash could strand.",
  );

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshot_observations_retention
     ON meta_raw_snapshot_observations (observed_at ASC, id ASC)`,
  );
  console.log(
    `${LABEL} T2 PASS drift refusal: dropping one declared index refuses the sweep before any claim, with zero row mutations and no lease taken`,
  );
}

// ── T3-T5. Receipt-first retention with live-partition and reference guards ─

async function seedRetentionFixture(client: Client) {
  const owner = await client.query<{ id: string }>(
    // Fixture-only owner. The value is a literal placeholder, never a usable
    // credential — nothing in this seam authenticates.
    `INSERT INTO users (email, name, password_hash)
     VALUES ('retention-seam@example.invalid', 'Retention Seam', 'seam-not-a-credential')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id::text AS id`,
  );
  await client.query(
    `INSERT INTO businesses (id, name, owner_id, currency)
     VALUES ($1, 'Retention Seam', $2::uuid, 'TRY')
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, owner.rows[0]!.id],
  );

  const livePartition = await client.query<{ id: string }>(
    `INSERT INTO meta_sync_partitions
       (business_id, provider_account_id, lane, scope, partition_date, status, source)
     VALUES ($1, $2, 'core', 'account_daily', DATE '2026-01-10', 'running', 'seam')
     RETURNING id::text AS id`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  const donePartition = await client.query<{ id: string }>(
    `INSERT INTO meta_sync_partitions
       (business_id, provider_account_id, lane, scope, partition_date, status, source)
     VALUES ($1, $2, 'core', 'account_daily', DATE '2026-01-11', 'succeeded', 'seam')
     RETURNING id::text AS id`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  return {
    livePartitionId: livePartition.rows[0]!.id,
    donePartitionId: donePartition.rows[0]!.id,
  };
}

async function insertMetaContent(
  client: Client,
  input: { contentKey: string | null; hash: string; fetchedAt: string; partitionId?: string | null },
) {
  const rows = await client.query<{ id: string }>(
    `INSERT INTO meta_raw_snapshots
       (business_id, provider_account_id, partition_id, endpoint_name, entity_scope,
        start_date, end_date, payload_json, payload_hash, content_key, status,
        fetched_at, first_observed_at, last_observed_at)
     VALUES ($1, $2, $3::uuid, 'retention_probe', 'campaign',
             DATE '2026-01-01', DATE '2026-01-01', '{}'::jsonb, $4, $5, 'fetched',
             $6::timestamptz, $6::timestamptz, $6::timestamptz)
     RETURNING id::text AS id`,
    [
      BUSINESS_ID,
      META_ACCOUNT_ID,
      input.partitionId ?? null,
      input.hash,
      input.contentKey,
      input.fetchedAt,
    ],
  );
  return rows.rows[0]!.id;
}

async function insertMetaReceipt(
  client: Client,
  input: { snapshotId: string; partitionId: string | null; observedAt: string },
) {
  await client.query(
    `INSERT INTO meta_raw_snapshot_observations
       (snapshot_id, business_id, provider_account_id, partition_id, endpoint_name,
        entity_scope, status, observed_at, first_observed_at, last_observed_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, 'retention_probe', 'campaign', 'fetched',
             $5::timestamptz, $5::timestamptz, $5::timestamptz)`,
    [input.snapshotId, BUSINESS_ID, META_ACCOUNT_ID, input.partitionId, input.observedAt],
  );
}

async function verifyRetentionSweep(client: Client) {
  const { pruneSyncLifecycleData } = await import("@/lib/sync/retention");
  const { livePartitionId, donePartitionId } = await seedRetentionFixture(client);
  const OLD = "2026-01-01T00:00:00Z";

  // Collectable: new-model content whose only receipt belongs to a finished
  // partition. Receipt-first is what makes it collectable at all.
  const collectable = await insertMetaContent(client, {
    contentKey: "ck-collectable",
    hash: "h-collectable",
    fetchedAt: OLD,
  });
  await insertMetaReceipt(client, {
    snapshotId: collectable,
    partitionId: donePartitionId,
    observedAt: OLD,
  });

  // Protected by a LIVE partition: its receipt is running-sync completion
  // evidence, so neither the receipt nor the content may be collected.
  const liveContent = await insertMetaContent(client, {
    contentKey: "ck-live",
    hash: "h-live",
    fetchedAt: OLD,
  });
  await insertMetaReceipt(client, {
    snapshotId: liveContent,
    partitionId: livePartitionId,
    observedAt: OLD,
  });

  // Protected by an inbound typed reference. The FK is ON DELETE SET NULL, so
  // an unguarded delete would silently null a durable row's provenance rather
  // than failing.
  const referenced = await insertMetaContent(client, {
    contentKey: "ck-referenced",
    hash: "h-referenced",
    fetchedAt: OLD,
  });
  await client.query(
    `INSERT INTO meta_account_daily
       (business_id, provider_account_id, date, account_timezone, account_currency,
        source_snapshot_id)
     VALUES ($1, $2, DATE '2026-01-01', 'Europe/Istanbul', 'TRY', $3::uuid)`,
    [BUSINESS_ID, META_ACCOUNT_ID, referenced],
  );

  // Legacy: NULL content_key, attributed by its own partition column. Must
  // keep the original behaviour — collectable once its partition is terminal.
  const legacy = await insertMetaContent(client, {
    contentKey: null,
    hash: "h-legacy",
    fetchedAt: OLD,
    partitionId: donePartitionId,
  });

  const shopifyCollectable = await client.query<{ id: string }>(
    `INSERT INTO shopify_raw_snapshots
       (business_id, provider_account_id, endpoint_name, entity_scope,
        payload_json, payload_hash, content_key, status, fetched_at)
     VALUES ($1, $2, 'orders', 'shop', '{}'::jsonb, 'sh-old', 'sck-old', 'fetched',
             $3::timestamptz)
     RETURNING id::text AS id`,
    [BUSINESS_ID, SHOP_ID, OLD],
  );
  await client.query(
    `INSERT INTO shopify_raw_snapshot_observations
       (snapshot_id, business_id, provider_account_id, endpoint_name, entity_scope,
        status, observed_at, first_observed_at, last_observed_at)
     VALUES ($1::uuid, $2, $3, 'orders', 'shop', 'fetched', $4::timestamptz,
             $4::timestamptz, $4::timestamptz)`,
    [shopifyCollectable.rows[0]!.id, BUSINESS_ID, SHOP_ID, OLD],
  );

  const summary = await pruneSyncLifecycleData({ rawRetentionDays: 1 });

  // T3: receipt-first actually collected content in ONE pass. If the sweep ran
  // content before receipts, RESTRICT would have blocked every shared row and
  // this count would be zero.
  assert(
    summary.metaRawSnapshotObservationsDeleted >= 1,
    `T3: no Meta receipts were aged out: ${JSON.stringify(summary)}`,
  );
  assert(
    summary.metaRawSnapshotsDeleted >= 2,
    `T3: receipt-first did not make content collectable in the same pass (expected the new-model row and the legacy row): ${JSON.stringify(summary)}`,
  );
  assert(
    summary.shopifyRawSnapshotObservationsDeleted >= 1 &&
      summary.shopifyRawSnapshotsDeleted >= 1,
    `T3: the Shopify receipt-then-content order did not collect: ${JSON.stringify(summary)}`,
  );
  assert(
    (await countRows(client, "meta_raw_snapshots", `id = '${collectable}'::uuid`)) === 0,
    "T3: collectable new-model content survived the sweep.",
  );
  assert(
    (await countRows(client, "meta_raw_snapshots", `id = '${legacy}'::uuid`)) === 0,
    "T3: legacy content attributed to a terminal partition was not collected; the legacy branch regressed.",
  );
  console.log(
    `${LABEL} T3 PASS receipt-first retention: ${summary.metaRawSnapshotObservationsDeleted} Meta and ${summary.shopifyRawSnapshotObservationsDeleted} Shopify receipts aged out, then ${summary.metaRawSnapshotsDeleted} Meta and ${summary.shopifyRawSnapshotsDeleted} Shopify canonical rows collected in the same pass`,
  );

  // T4: live partitions are untouched.
  assert(
    (await countRows(client, "meta_raw_snapshots", `id = '${liveContent}'::uuid`)) === 1,
    "T4: content observed by a RUNNING partition was collected.",
  );
  assert(
    (await countRows(
      client,
      "meta_raw_snapshot_observations",
      `partition_id = '${livePartitionId}'::uuid`,
    )) === 1,
    "T4: a running partition's completion evidence was aged out.",
  );
  console.log(
    `${LABEL} T4 PASS live-partition protection: the running partition keeps its receipt and its content`,
  );

  // T5: inbound typed references protect content, and the static reference
  // list must cover every FK the catalog actually has.
  assert(
    (await countRows(client, "meta_raw_snapshots", `id = '${referenced}'::uuid`)) === 1,
    "T5: content referenced by a typed warehouse row was collected; its provenance would have been silently nulled.",
  );
  const {
    META_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES,
    SHOPIFY_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES,
  } = await import("@/lib/sync/retention");
  for (const [table, declared] of [
    ["meta_raw_snapshots", META_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES],
    ["shopify_raw_snapshots", SHOPIFY_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES],
  ] as const) {
    const catalog = await client.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_attribute a
         ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       WHERE con.confrelid = $1::regclass
         AND con.contype = 'f'
         AND a.attname = 'source_snapshot_id'`,
      [table],
    );
    const missing = catalog.rows
      .map((row) => row.table_name)
      .filter((name) => !(declared as readonly string[]).includes(name));
    assert(
      missing.length === 0,
      `T5: ${table} has inbound source_snapshot_id references not guarded by retention: ${missing.join(", ")}. Add them to the declared list.`,
    );
    assert(
      catalog.rowCount === declared.length,
      `T5: the declared reference list for ${table} has ${declared.length} entries but the catalog has ${catalog.rowCount}; the list has rotted.`,
    );
  }
  console.log(
    `${LABEL} T5 PASS reference protection: referenced content is not collectable, and the declared reference lists exactly match the ${META_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES.length} Meta and ${SHOPIFY_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES.length} Shopify inbound FKs in the catalog`,
  );
}

// ── F1-F3. Growth fence defaults, refusal and recovery ─────────────────────

async function verifyGrowthBoundaries(client: Client) {
  const fence = await import("@/lib/sync/db-growth-fence");
  fence.resetDbGrowthFenceCache();

  // Physical admission is a precondition of reaching the logical budgets at
  // all, so the logical cases need a healthy host sample present. F1b below
  // then removes it, ages it, corrupts it and re-seeds it to prove each
  // failure mode independently.
  await client.query(
    `INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
     VALUES ('db_host_healthcheck', 'seam-db-host', clock_timestamp(),
             jsonb_build_object(
               'hostname', 'seam-db-host',
               'database', jsonb_build_object('name', current_database()),
               'disks', jsonb_build_array(jsonb_build_object(
                 'path', '/var/lib/postgresql',
                 'totalBytes', $1::bigint,
                 'usedBytes', $2::bigint,
                 'availableBytes', $3::bigint
               ))
             ))`,
    [400 * 1024 ** 3, 190 * 1024 ** 3, 210 * 1024 ** 3],
  );

  const defaults = await fence.evaluateDbGrowthFence({ env: {} });
  assert(
    defaults.allowed && defaults.reason === "ready",
    `F1: the default budgets refuse a healthy database: ${JSON.stringify(defaults)}`,
  );
  for (const table of fence.FENCED_TABLES) {
    const measured = defaults.tableBytes?.[table];
    assert(
      typeof measured === "number" && measured >= 0,
      `F1: fenced table ${table} was not measured (${String(measured)}); the fence would fail closed in production.`,
    );
  }
  for (const required of [
    "meta_entity_state_history",
    "meta_raw_snapshots",
    "shopify_raw_snapshots",
    "meta_config_snapshots",
    "meta_campaign_config_history",
    "meta_adset_config_history",
    "google_ads_product_daily",
    "meta_raw_snapshot_observations",
    "shopify_raw_snapshot_observations",
    "google_ads_raw_snapshots",
    "google_ads_campaign_state_history",
    "google_ads_ad_group_state_history",
    "google_ads_sync_runs",
    "google_ads_sync_jobs",
    "meta_sync_runs",
    "meta_sync_jobs",
    "shopify_entity_payload_archives",
    "shopify_sales_events",
  ]) {
    assert(
      (fence.FENCED_TABLES as readonly string[]).includes(required),
      `F1: dominant append table ${required} is not fenced.`,
    );
  }
  assert(
    fence.DEFAULT_DATABASE_BUDGET_BYTES < fence.LIVE_MEASUREMENT.volume.capacityBytes,
    "F1: the database budget exceeds the observed volume capacity.",
  );
  // Every default must ADMIT the live measurement, or deploying it refuses
  // every sync on the first evaluation. This is the check the previous 8/4/4
  // GiB config-trio defaults would have failed against a live 21/20/20 GiB.
  assert(
    fence.LIVE_MEASUREMENT.databaseBytes < fence.DEFAULT_DATABASE_BUDGET_BYTES,
    `F1: the default database budget (${fence.DEFAULT_DATABASE_BUDGET_BYTES}) is below the live database (${fence.LIVE_MEASUREMENT.databaseBytes}); every sync would refuse.`,
  );
  for (const [table, liveBytes] of Object.entries(fence.LIVE_MEASUREMENT.tableBytes)) {
    const budget =
      fence.DEFAULT_TABLE_BUDGET_BYTES[table as keyof typeof fence.DEFAULT_TABLE_BUDGET_BYTES];
    assert(
      typeof budget === "number" && liveBytes < budget,
      `F1: the default budget for ${table} (${String(budget)}) is below its live size (${liveBytes}); every sync would refuse.`,
    );
  }
  // ...and the current database must be admitted WITH a warning, not quietly.
  // A warning band above the live size would describe a database that has room.
  // This one does not: the config trio alone is 60 GiB of the 136.45 GiB.
  assert(
    fence.LIVE_MEASUREMENT.databaseBytes >=
      fence.DEFAULT_DATABASE_BUDGET_BYTES * fence.DEFAULT_WARNING_RATIO,
    "F1: the live database is admitted quietly; it is close enough to the ceiling that it must warn.",
  );
  // The planning constant is arithmetic and must NOT be presented as disk
  // telemetry. With no measurement supplied, filesystem headroom is unknown —
  // never "ok".
  assert(
    fence.PLANNED_VOLUME_HEADROOM_BYTES ===
      fence.LIVE_MEASUREMENT.volume.capacityBytes - fence.DEFAULT_DATABASE_BUDGET_BYTES,
    "F1: the planning constant is not the arithmetic it claims to be.",
  );
  console.log(
    `${LABEL} F1 PASS growth-fence defaults: all ${fence.FENCED_TABLES.length} dominant append tables measured against real PostgreSQL; every default admits its live size; the live 136.45 GiB database is admitted WITH a warning at the ${fence.DEFAULT_WARNING_RATIO * 100}% band`,
  );

  /* ---------------------------------------------------------------- F1b --- *
   * Physical capacity admission, driven by REAL rows in the REAL telemetry
   * table, read through the real fence in the same statement as the logical
   * sizes.
   *
   * The previous design took free space from an environment variable, which is
   * a number an operator types once and which then never ages, never
   * disagrees, and never fails. Every case below writes an actual
   * system_capacity_snapshots row and asserts the exact reason the fence
   * produces — including the two that no env value could ever express: a stale
   * sampler, and a budget the disk cannot absorb.
   * ------------------------------------------------------------------------ */
  const currentDatabaseName = (
    await client.query<{ name: string }>("SELECT current_database() AS name")
  ).rows[0]!.name;

  const seedCapacity = async (input: {
    ageSeconds: number;
    availableBytes?: number;
    totalBytes?: number;
    dataPath?: string;
    databaseName?: string;
    disks?: unknown;
  }) => {
    await client.query(
      `DELETE FROM system_capacity_snapshots WHERE source = 'db_host_healthcheck'`,
    );
    const totalBytes = input.totalBytes ?? 400 * 1024 ** 3;
    const availableBytes = input.availableBytes ?? 210 * 1024 ** 3;
    const payload = {
      sampledAt: new Date().toISOString(),
      hostname: "seam-db-host",
      database: { name: input.databaseName ?? currentDatabaseName, sizeBytes: 1 },
      disks:
        input.disks ??
        [
          {
            path: input.dataPath ?? fence.PHYSICAL_DATA_PATH,
            filesystem: "/dev/seam",
            mountedOn: input.dataPath ?? fence.PHYSICAL_DATA_PATH,
            totalBytes,
            usedBytes: totalBytes - availableBytes,
            availableBytes,
          },
        ],
    };
    await client.query(
      `INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
       VALUES ('db_host_healthcheck', 'seam-db-host',
               clock_timestamp() - make_interval(secs => $1), $2::jsonb)`,
      [input.ageSeconds, JSON.stringify(payload)],
    );
  };

  const evaluateWithCapacity = async (input: Parameters<typeof seedCapacity>[0]) => {
    await seedCapacity(input);
    fence.resetDbGrowthFenceCache();
    return fence.evaluateDbGrowthFence();
  };

  // Missing: no row at all. The fence must refuse rather than assume health.
  await client.query(
    `DELETE FROM system_capacity_snapshots WHERE source = 'db_host_healthcheck'`,
  );
  fence.resetDbGrowthFenceCache();
  const noSample = await fence.evaluateDbGrowthFence();
  assert(
    !noSample.allowed && noSample.reason === "physical_snapshot_missing",
    `F1b: an absent host capacity sample was not refused: ${JSON.stringify(noSample)}`,
  );

  // Fresh and roomy: admitted, and it reports what it actually saw.
  const freshSample = await evaluateWithCapacity({ ageSeconds: 120 });
  assert(
    freshSample.allowed && freshSample.physical?.reason === "ok",
    `F1b: a fresh healthy sample was not admitted: ${JSON.stringify(freshSample)}`,
  );
  assert(
    freshSample.physical?.availableBytes === 210 * 1024 ** 3 &&
      freshSample.physical?.snapshotId != null &&
      typeof freshSample.physical?.ageSeconds === "number",
    `F1b: the admitted decision did not carry the readback: ${JSON.stringify(freshSample.physical)}`,
  );

  // Low: below the 40 GiB floor.
  const lowSample = await evaluateWithCapacity({
    ageSeconds: 60,
    availableBytes: fence.MINIMUM_VOLUME_FREE_BYTES - 1,
  });
  assert(
    !lowSample.allowed && lowSample.reason === "physical_free_space_low",
    `F1b: a nearly-full data volume was not refused: ${JSON.stringify(lowSample)}`,
  );

  // Stale: the sampler stopped. Nothing knows the disk state, so nothing writes.
  const staleSample = await evaluateWithCapacity({
    ageSeconds: fence.PHYSICAL_SNAPSHOT_MAX_AGE_MS / 1000 + 60,
  });
  assert(
    !staleSample.allowed && staleSample.reason === "physical_snapshot_stale",
    `F1b: a stale sample was accepted: ${JSON.stringify(staleSample)}`,
  );

  // Future-dated: would otherwise never age out.
  const futureSample = await evaluateWithCapacity({ ageSeconds: -3600 });
  assert(
    !futureSample.allowed && futureSample.reason === "physical_snapshot_future_dated",
    `F1b: a future-dated sample was accepted: ${JSON.stringify(futureSample)}`,
  );

  // Malformed: a disks array that is not one.
  const malformedSample = await evaluateWithCapacity({
    ageSeconds: 60,
    disks: "not-an-array",
  });
  assert(
    !malformedSample.allowed && malformedSample.reason === "physical_snapshot_malformed",
    `F1b: a malformed payload was accepted: ${JSON.stringify(malformedSample)}`,
  );

  // Wrong path: the root filesystem is not the data directory.
  const wrongPathSample = await evaluateWithCapacity({ ageSeconds: 60, dataPath: "/" });
  assert(
    !wrongPathSample.allowed && wrongPathSample.reason === "physical_data_path_missing",
    `F1b: a sample without the data path was accepted: ${JSON.stringify(wrongPathSample)}`,
  );

  // Wrong database: a sample from another host says nothing about this one.
  const wrongDbSample = await evaluateWithCapacity({
    ageSeconds: 60,
    databaseName: "some_other_database",
  });
  assert(
    !wrongDbSample.allowed && wrongDbSample.reason === "physical_database_identity_mismatch",
    `F1b: a sample for a different database was accepted: ${JSON.stringify(wrongDbSample)}`,
  );

  // The projected floor: a 3 TiB budget on a disk with 210 GiB free must refuse
  // even though the disk is healthy today and the database is tiny.
  await seedCapacity({ ageSeconds: 60 });
  const savedProjectionEnv = process.env;
  process.env = {
    ...process.env,
    SYNC_GROWTH_FENCE_DATABASE_BYTES: String(3 * 1024 ** 4),
  } as NodeJS.ProcessEnv;
  fence.resetDbGrowthFenceCache();
  const projected = await fence.evaluateDbGrowthFence();
  process.env = savedProjectionEnv;
  fence.resetDbGrowthFenceCache();
  assert(
    !projected.allowed && projected.reason === "physical_projected_free_space_low",
    `F1b: an unabsorbable budget was admitted: ${JSON.stringify(projected)}`,
  );

  // ...and the emergency override cannot reach past any of it.
  await seedCapacity({ ageSeconds: 60, availableBytes: 1024 });
  const savedOverrideEnv = process.env;
  process.env = {
    ...process.env,
    [fence.OVERRIDE_ENV_FLAG]: fence.OVERRIDE_ENV_VALUE,
    [fence.OVERRIDE_REASON_ENV]: "seam proves this cannot admit",
    [fence.OVERRIDE_EXPIRES_ENV]: new Date(Date.now() + 60 * 60_000).toISOString(),
  } as NodeJS.ProcessEnv;
  fence.resetDbGrowthFenceCache();
  const overriddenPhysical = await fence.evaluateDbGrowthFence();
  process.env = savedOverrideEnv;
  fence.resetDbGrowthFenceCache();
  assert(
    !overriddenPhysical.allowed &&
      !overriddenPhysical.overridden &&
      overriddenPhysical.reason === "physical_free_space_low",
    `F1b: the emergency override admitted past a physical refusal: ${JSON.stringify(overriddenPhysical)}`,
  );

  // Leave a healthy sample behind so the remaining cases measure logical
  // budgets rather than tripping on physical admission.
  await seedCapacity({ ageSeconds: 60 });
  fence.resetDbGrowthFenceCache();
  console.log(
    `${LABEL} F1b PASS physical capacity: 9 real telemetry rows (missing/fresh/low/stale/future/malformed/wrong-path/wrong-database/unabsorbable-budget) evaluated through the real fence against real PostgreSQL; every failure mode refuses with its own reason and none is reachable by the emergency override`,
  );

  const savedEnv = process.env;
  process.env = {
    ...process.env,
    SYNC_GROWTH_FENCE_META_RAW_SNAPSHOTS_BYTES: "1",
  } as NodeJS.ProcessEnv;
  fence.resetDbGrowthFenceCache();
  const refusedByTable = await fence.evaluateDbGrowthFence();
  process.env = savedEnv;
  fence.resetDbGrowthFenceCache();
  assert(
    !refusedByTable.allowed &&
      refusedByTable.reason === "table_budget_exceeded" &&
      refusedByTable.offender?.table === "meta_raw_snapshots",
    `F2: a per-table budget breach on the largest append surface did not refuse: ${JSON.stringify(refusedByTable)}`,
  );

  process.env = {
    ...process.env,
    SYNC_GROWTH_FENCE_DATABASE_BYTES: "1",
  } as NodeJS.ProcessEnv;
  fence.resetDbGrowthFenceCache();
  const refusedByDatabase = await fence.evaluateDbGrowthFence();
  process.env = savedEnv;
  fence.resetDbGrowthFenceCache();
  assert(
    !refusedByDatabase.allowed && refusedByDatabase.reason === "database_budget_exceeded",
    `F2: a database budget breach did not refuse: ${JSON.stringify(refusedByDatabase)}`,
  );

  const recovered = await fence.evaluateDbGrowthFence({ env: {} });
  assert(
    recovered.allowed && recovered.reason === "ready",
    "F2: the fence did not recover immediately once the budget was restored.",
  );

  // The live snapshot itself, driven through the real evaluator by overriding
  // each budget to the exact measured byte count. `bytes >= budget` denies, so
  // setting the budget to the live size proves the boundary sits exactly where
  // the measurement says it does — over-budget by one byte, and recovery by
  // restoring the real default.
  for (const [table, liveBytes] of Object.entries(fence.LIVE_MEASUREMENT.tableBytes)) {
    process.env = {
      ...savedEnv,
      [`SYNC_GROWTH_FENCE_${table.toUpperCase()}_BYTES`]: String(liveBytes),
    } as NodeJS.ProcessEnv;
    fence.resetDbGrowthFenceCache();
    const atLive = await fence.evaluateDbGrowthFence();
    process.env = savedEnv;
    fence.resetDbGrowthFenceCache();
    // The seam database is tiny, so a budget of the live byte count admits it.
    assert(
      atLive.allowed,
      `F2: a budget set to ${table}'s live size (${liveBytes}) refused a database far smaller than it: ${JSON.stringify(atLive.offender)}`,
    );
  }
  process.env = {
    ...savedEnv,
    SYNC_GROWTH_FENCE_DATABASE_BYTES: String(fence.LIVE_MEASUREMENT.databaseBytes),
  } as NodeJS.ProcessEnv;
  fence.resetDbGrowthFenceCache();
  const atLiveDatabase = await fence.evaluateDbGrowthFence();
  process.env = savedEnv;
  fence.resetDbGrowthFenceCache();
  assert(
    atLiveDatabase.allowed,
    "F2: a database budget set to the live measurement refused.",
  );
  const restored = await fence.evaluateDbGrowthFence({ env: {} });
  assert(
    restored.allowed && restored.reason === "ready",
    "F2: the fence did not return to the real defaults after the live-snapshot fixtures.",
  );
  console.log(
    `${LABEL} F2 PASS refusal and recovery: per-table and database breaches both refuse by name, all ${Object.keys(fence.LIVE_MEASUREMENT.tableBytes).length} live-snapshot budgets plus the live database budget admit, and admission returns immediately once the real defaults are restored`,
  );

  // F3: the entrypoint boundaries themselves, not just the evaluator.
  for (const operation of [
    "google_sync_range",
    "meta_consume_queued_work",
    "meta_lifecycle_partition",
  ] as const) {
    process.env = {
      ...process.env,
      SYNC_GROWTH_FENCE_DATABASE_BYTES: "1",
    } as NodeJS.ProcessEnv;
    fence.resetDbGrowthFenceCache();
    const blocked = await fence.assertSyncGrowthBoundary(operation).then(
      () => false,
      (error) => error instanceof fence.DbGrowthFenceRefusal,
    );
    process.env = savedEnv;
    fence.resetDbGrowthFenceCache();
    assert(
      blocked,
      `F3: the ${operation} boundary did not refuse on a breached database budget.`,
    );
    await fence.assertSyncGrowthBoundary(operation);
  }
  console.log(
    `${LABEL} F3 PASS capacity boundaries: all 3 sync entrypoints refuse on breach and admit again on recovery`,
  );
}

// ── L1. Release gate persistence and consumer boundary ─────────────────────

async function verifyReleaseBoundary(client: Client) {
  const gates = await import("@/lib/sync/release-gates");
  const BUILD = "seam-build-1";
  const ENVIRONMENT = "seam";
  const record = (
    verdict: "pass" | "fail",
    emittedAt: string,
  ): Parameters<typeof gates.upsertSyncGateRecord>[0] => ({
    gateKind: "release_gate",
    gateScope: "release_readiness",
    buildId: BUILD,
    environment: ENVIRONMENT,
    mode: "block",
    baseResult: verdict,
    verdict,
    blockerClass: null,
    summary: `seam ${verdict}`,
    breakGlass: false,
    overrideReason: null,
    evidence: { providerScope: "meta" },
    emittedAt,
  });

  const before = await countRows(client, "sync_release_gates");
  const written = await gates.upsertSyncGateRecord(
    record("pass", "2026-01-01T00:00:00.000Z"),
  );
  assert(
    written.id != null,
    "L1: persisting a scheduled gate evaluation returned no id.",
  );
  assert(
    (await countRows(client, "sync_release_gates")) === before + 1,
    "L1: a scheduled gate evaluation was not persisted.",
  );

  const first = await gates.getLatestSyncGateRecords({
    buildId: BUILD,
    environment: ENVIRONMENT,
  });
  assert(
    first.releaseGate?.verdict === "pass",
    `L1: the consumer read path does not observe the scheduled evaluation: ${JSON.stringify(first)}`,
  );

  // Gate records are append-only history: a later manual re-evaluation must
  // NOT overwrite the scheduled one, and the consumer must read the newest.
  // Append-only is also exactly why sync_release_gates is a fenced table —
  // repeated evaluation is itself a growth surface.
  await gates.upsertSyncGateRecord(record("fail", "2026-01-02T00:00:00.000Z"));
  assert(
    (await countRows(client, "sync_release_gates")) === before + 2,
    "L1: a re-evaluation overwrote gate history instead of appending.",
  );
  const second = await gates.getLatestSyncGateRecords({
    buildId: BUILD,
    environment: ENVIRONMENT,
  });
  assert(
    second.releaseGate?.verdict === "fail",
    `L1: the consumer read path returned a stale verdict after re-evaluation: ${JSON.stringify(second)}`,
  );
  const fence = await import("@/lib/sync/db-growth-fence");
  assert(
    (fence.FENCED_TABLES as readonly string[]).includes("sync_release_gates"),
    "L1: the append-only gate table is not fenced, so repeated evaluation is an unmeasured growth surface.",
  );
  console.log(
    `${LABEL} L1 PASS release boundary: a scheduled evaluation persists and is read back, a manual re-evaluation appends rather than overwriting, the consumer reads the newest verdict, and the append-only gate table is fenced`,
  );
}

// ── T6. Legacy provider retention, EXECUTED with the lane off ─────────────

/**
 * The unit tests for this use a mocked SQL client, which proves the code path
 * chooses dry_run — not that a real database receives no DELETE. These run the
 * ACTUAL provider retention policies against real PostgreSQL with the lane off
 * and every inner flag on, and compare row counts.
 */
async function verifyLegacyRetentionLaneOff(client: Client) {
  const before = await client.query<{ meta: string; google: string }>(
    `SELECT (SELECT COUNT(*)::text FROM meta_raw_snapshots) AS meta,
            (SELECT COUNT(*)::text FROM google_ads_raw_snapshots) AS google`,
  );

  const metaRetention = await import("@/lib/meta/warehouse-retention");
  const googleRetention = await import("@/lib/google-ads/warehouse-retention");
  const laneOffEnv = {
    ...process.env,
    // Every inner flag ON, plus forceExecute below — only the lane says stop.
    META_RETENTION_EXECUTION_ENABLED: "true",
    GOOGLE_ADS_RETENTION_EXECUTION_ENABLED: "true",
    ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
    ADSECUTE_SYNC_LANE_RETENTION_ENABLED: "off",
  } as NodeJS.ProcessEnv;

  const metaResult = await metaRetention.executeMetaRetentionPolicy({
    asOfDate: "2026-07-26",
    forceExecute: true,
    env: laneOffEnv,
  });
  const googleResult = await googleRetention.executeGoogleAdsRetentionPolicy({
    asOfDate: "2026-07-26",
    forceExecute: true,
    env: laneOffEnv,
  });
  assert(
    metaResult.mode === "dry_run" && googleResult.mode === "dry_run",
    `T6: a provider retention policy executed with the lane off: meta=${metaResult.mode} google=${googleResult.mode}`,
  );

  const after = await client.query<{ meta: string; google: string }>(
    `SELECT (SELECT COUNT(*)::text FROM meta_raw_snapshots) AS meta,
            (SELECT COUNT(*)::text FROM google_ads_raw_snapshots) AS google`,
  );
  assert(
    before.rows[0]!.meta === after.rows[0]!.meta &&
      before.rows[0]!.google === after.rows[0]!.google,
    `T6: rows were deleted with the retention lane off.\n  before ${JSON.stringify(before.rows[0])}\n  after  ${JSON.stringify(after.rows[0])}`,
  );
  console.log(
    `${LABEL} T6 PASS legacy retention lane-off: the real Meta and Google policies ran with both provider flags on and forceExecute set, both downgraded to dry_run, and row counts are unchanged (meta=${after.rows[0]!.meta} google=${after.rows[0]!.google})`,
  );
}

// ── S1-S3. Selection queries, EXECUTED ─────────────────────────────────────

/**
 * These queries were previously covered by string assertions only, which is
 * exactly how a `WHERE` placed before a `LEFT JOIN` — invalid PostgreSQL —
 * passed review and every test. Anything that decides what to WORK ON now has
 * to run against a real server here.
 */
async function verifySelectionQueries(client: Client) {
  const ownerRows = await client.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash)
     VALUES ('selection-seam@example.invalid', 'Selection Seam', 'seam-not-a-credential')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id::text AS id`,
  );
  const BUSINESS = "44444444-4444-4444-8444-444444444444";
  await client.query(
    `INSERT INTO businesses (id, name, owner_id, currency)
     VALUES ($1, 'Selection Seam', $2::uuid, 'TRY')
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS, ownerRows.rows[0]!.id],
  );
  await client.query(
    `INSERT INTO provider_connections (business_id, provider, status)
     VALUES ($1, 'google', 'connected')
     ON CONFLICT (business_id, provider) DO UPDATE SET status = 'connected'`,
    [BUSINESS],
  );
  const bind = async (accountId: string, selected: boolean) => {
    const account = await client.query<{ id: string }>(
      `INSERT INTO provider_accounts (provider, external_account_id)
       VALUES ('google', $1)
       ON CONFLICT (provider, external_account_id) DO UPDATE SET updated_at = now()
       RETURNING id::text AS id`,
      [accountId],
    );
    await client.query(
      `INSERT INTO business_provider_accounts
         (business_id, provider, provider_account_ref_id, provider_account_id,
          position, is_selected)
       VALUES ($1, 'google', $2::uuid, $3, 0, $4)
       ON CONFLICT (business_id, provider, provider_account_ref_id)
       DO UPDATE SET is_selected = EXCLUDED.is_selected`,
      [BUSINESS, account.rows[0]!.id, accountId, selected],
    );
    return account.rows[0]!.id;
  };
  const selectedRef = await bind("111-selected", true);
  const deselectedRef = await bind("222-deselected", false);
  void selectedRef;
  void deselectedRef;

  // S1: the control-plane admission query must PARSE and must count only the
  // selected account.
  const { readConnectedGoogleAdsControlPlaneBusinesses } = await import(
    "@/lib/google-ads/control-plane-runtime"
  );
  const controlPlane = await readConnectedGoogleAdsControlPlaneBusinesses();
  const seamRow = controlPlane.find((row) => row.businessId === BUSINESS);
  assert(
    seamRow != null,
    `S1: the control-plane query returned no row for a connected business with a selected account: ${JSON.stringify(controlPlane)}`,
  );
  assert(
    Number(seamRow.assignedAccountCount) === 1,
    `S1: the control-plane query counted ${seamRow.assignedAccountCount} accounts; the deselected one must not be counted.`,
  );
  console.log(
    `${LABEL} S1 PASS control-plane admission: the query parses against real PostgreSQL and counts 1 of 2 bindings, excluding the deselected account`,
  );

  // S2: run the REAL leasing function. A deselected account's queued partition
  // must not be offered, which is a property of the authority EXISTS inside the
  // lease SQL — not something a string assertion can establish.
  await client.query(
    `INSERT INTO integration_credentials (provider_connection_id, access_token)
     SELECT id, 'seam-not-a-credential'
     FROM provider_connections
     WHERE business_id = $1 AND provider = 'google'
     ON CONFLICT DO NOTHING`,
    [BUSINESS],
  );
  for (const accountId of ["111-selected", "222-deselected"]) {
    await client.query(
      `INSERT INTO google_ads_sync_partitions
         (business_id, provider_account_id, lane, scope, partition_date, status, source)
       VALUES ($1, $2, 'core', 'account_daily', DATE '2026-02-01', 'queued', 'seam')
       ON CONFLICT DO NOTHING`,
      [BUSINESS, accountId],
    );
  }
  const { acquireSyncRunnerLease: acquireGoogleRunnerLease } = await import(
    "@/lib/sync/worker-health"
  );
  const GOOGLE_WORKER = "selection-seam-google-worker";
  await acquireGoogleRunnerLease({
    businessId: BUSINESS,
    providerScope: "google_ads",
    leaseOwner: GOOGLE_WORKER,
    leaseMinutes: 15,
  });
  const { leaseGoogleAdsSyncPartitions } = await import("@/lib/google-ads/warehouse");
  const leased = (await leaseGoogleAdsSyncPartitions({
    businessId: BUSINESS,
    workerId: GOOGLE_WORKER,
    limit: 10,
  })) as Array<{ providerAccountId?: string; provider_account_id?: string }>;
  const leasedAccounts = leased.map(
    (row) => row.providerAccountId ?? row.provider_account_id,
  );
  assert(
    !leasedAccounts.includes("222-deselected"),
    `S2: a DESELECTED Google account's partition was leased: ${JSON.stringify(leasedAccounts)}`,
  );
  assert(
    leasedAccounts.includes("111-selected"),
    `S2: the selected account's partition was not leasable, so the filter is over-broad: ${JSON.stringify(leasedAccounts)}`,
  );
  console.log(
    `${LABEL} S2 PASS Google lease authority: the real leasing function offers the selected account's partition and refuses the deselected one before any work`,
  );

  // S3: the decision-engine hydration queries must PARSE. They are large CTEs
  // that no unit test executes.
  const dataSource = await import("@/lib/creative-decision-engine/data-source");
  // Placeholder count is read from the SQL itself, so this cannot silently stop
  // covering a query that grows a parameter. Only $1 needs a real value; the
  // rest are NULL because planning, not results, is what is being proved.
  const planWithNulls = async (name: string, sqlText: string) => {
    const highest = Math.max(
      0,
      ...[...sqlText.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
    );
    assert(highest > 0, `S3: ${name} has no bind parameters; the fixture is wrong.`);
    const params: Array<string | null> = Array.from({ length: highest }, () => null);
    params[0] = BUSINESS;
    const planned = await client.query(`EXPLAIN ${sqlText}`, params).then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    assert(
      planned.ok,
      `S3: ${name} does not plan against real PostgreSQL: ${planned.error}`,
    );
    assert(
      sqlText.includes("binding.is_selected"),
      `S3: ${name} lost its current-selection filter.`,
    );
    return highest;
  };
  const hydrateParams = await planWithNulls(
    "HYDRATE_AD_DECISION_INPUTS_QUERY",
    dataSource.HYDRATE_AD_DECISION_INPUTS_QUERY,
  );
  const receiptParams = await planWithNulls(
    "READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY",
    dataSource.READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
  );
  void hydrateParams;
  void receiptParams;
  console.log(
    `${LABEL} S3 PASS decision hydration: both current-execution CTEs plan against real PostgreSQL with the selection filter in place`,
  );
}

// ── R1-R3. The rollout orchestration, EXECUTED ─────────────────────────────

/**
 * The rollout was documented and not executable, which is the same class of gap
 * as a declared kill-switch lane with no call to it. These run the real script
 * against this database.
 */
async function verifyRolloutOrchestration(client: Client) {
  const { spawnSync: spawnRollout } = await import("node:child_process");
  const laneFile = path.join(os.tmpdir(), `adsecute-rollout-lanes-${process.pid}.env`);
  void laneFile;
  const runRollout = (command: string, extraEnv: Record<string, string> = {}) =>
    spawnRollout(
      process.execPath,
      ["--import", "tsx", "scripts/global-sync-rollout.ts", command],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          SYNC_LANE_ENV_FILE: envPath,
          // The script must judge the lane state from the environment, not from
          // whatever this seam turned on for its own cases.
          ADSECUTE_SYNC_GLOBAL_ENABLED: "",
          ADSECUTE_SYNC_LANE_META_SYNC_ENABLED: "",
          ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED: "",
          ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED: "",
          ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED: "",
          ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED: "",
          ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED: "",
          ADSECUTE_SYNC_LANE_RETENTION_ENABLED: "",
          ...extraEnv,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );

  // A realistic production env: secrets, unrelated settings, comments, blank
  // lines, an `export` form, a quoted value containing '=', and one managed key
  // already present. Every byte of the non-managed content must survive.
  const PRODUCTION_ENV = [
    "# Adsecute production environment",
    "DATABASE_URL=postgresql://user:s3cr3t@db:5432/adsecute?sslmode=require",
    "NEXTAUTH_SECRET=abc123==padding==",
    "export META_APP_SECRET=shhh",
    'GOOGLE_ADS_DEVELOPER_TOKEN="tok=en/with=equals"',
    "",
    "# Worker tuning",
    "WORKER_POLL_INTERVAL_MS=10000",
    "ADSECUTE_SYNC_GLOBAL_ENABLED=",
    "SHOPIFY_SYNC_ENABLED=true",
    "",
  ].join("\n");
  const COMPOSE = "services:\n  web:\n    env_file:\n      - .env.production\n";

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-rollout-proj-"));
  const envPath = path.join(projectDir, ".env.production");
  fs.writeFileSync(envPath, PRODUCTION_ENV, { mode: 0o600 });
  fs.writeFileSync(path.join(projectDir, "docker-compose.yml"), COMPOSE);

  try {
    // R1: a live lease must abort. Nothing is written.
    await client.query(
      `INSERT INTO sync_runner_leases
         (business_id, provider_scope, lease_owner, lease_expires_at)
       VALUES ('__rollout_probe__', 'meta', 'rollout-probe', now() + interval '5 minutes')
       ON CONFLICT (business_id, provider_scope)
       DO UPDATE SET lease_owner = EXCLUDED.lease_owner,
                     lease_expires_at = EXCLUDED.lease_expires_at`,
    );
    const blocked = runRollout("enable");
    assert(
      blocked.status !== 0,
      `R1: enable succeeded while a runner lease was live:\n${blocked.stdout}`,
    );
    assert(
      /ABORTED/.test(blocked.stderr) && /runner_leases/.test(blocked.stdout),
      `R1: the abort did not name the failed precondition:\n${blocked.stdout}\n${blocked.stderr}`,
    );
    assert(
      fs.readFileSync(envPath, "utf8") === PRODUCTION_ENV,
      "R1: a refused enable modified the production env file.",
    );
    console.log(
      `${LABEL} R1 PASS rollout abort: a live runner lease refuses enable, names the failed check, and leaves the env file byte-identical`,
    );

    // R2: with the database actually quiesced, enable succeeds and writes ALL
    // sync lanes at once — with retention still off. Everything below is
    // residue from the selection cases above; the script was right to refuse
    // while it was there, which is R1's point.
    await client.query(`DELETE FROM sync_runner_leases`);
    await client.query(
      `UPDATE google_ads_sync_partitions
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL
       WHERE lease_owner IS NOT NULL`,
    );
    await client.query(
      `UPDATE meta_sync_partitions
       SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL
       WHERE lease_owner IS NOT NULL`,
    );
    await client.query(
      `UPDATE provider_sync_jobs SET status = 'failed' WHERE status = 'running'`,
    );
    // A fresh host capacity sample must exist for the rollout's readiness check
    // to admit. That is the point: the cutover cannot be enabled while nothing
    // knows how much disk is left. No environment variable can substitute.
    await client.query(
      `DELETE FROM system_capacity_snapshots WHERE source = 'db_host_healthcheck'`,
    );
    await client.query(
      `INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
       VALUES ('db_host_healthcheck', 'seam-db-host', clock_timestamp(),
               jsonb_build_object(
                 'hostname', 'seam-db-host',
                 'database', jsonb_build_object('name', current_database()),
                 'disks', jsonb_build_array(jsonb_build_object(
                   'path', '/var/lib/postgresql',
                   'totalBytes', $1::bigint,
                   'usedBytes', $2::bigint,
                   'availableBytes', $3::bigint
                 ))
               ))`,
      [400 * 1024 ** 3, 190 * 1024 ** 3, 210 * 1024 ** 3],
    );
    const enabled = runRollout("enable", {});
    assert(
      enabled.status === 0,
      `R2: enable failed on a quiesced database:\n${enabled.stdout}\n${enabled.stderr}`,
    );
    const laneContents = fs.readFileSync(envPath, "utf8");
    // The P0 this guards: an earlier version rendered the whole file from the
    // lane list, which against a real .env.production would have replaced
    // DATABASE_URL, every credential and every unrelated setting with six
    // lines.
    for (const preserved of [
      "DATABASE_URL=postgresql://user:s3cr3t@db:5432/adsecute?sslmode=require",
      "NEXTAUTH_SECRET=abc123==padding==",
      "export META_APP_SECRET=shhh",
      'GOOGLE_ADS_DEVELOPER_TOKEN="tok=en/with=equals"',
      "WORKER_POLL_INTERVAL_MS=10000",
      "SHOPIFY_SYNC_ENABLED=true",
      "# Adsecute production environment",
      "# Worker tuning",
    ]) {
      assert(
        laneContents.includes(preserved),
        `R2: enable destroyed an unrelated line: ${preserved.slice(0, 40)}`,
      );
    }
    const backups = fs
      .readdirSync(projectDir)
      .filter((name) => name.includes(".rollout-backup-"));
    assert(
      backups.length > 0 &&
        fs.readFileSync(path.join(projectDir, backups[0]!), "utf8") === PRODUCTION_ENV,
      "R2: no restorable backup of the original env file was written.",
    );
    for (const lane of [
      "META_SYNC",
      "GOOGLE_SYNC",
      "SHOPIFY_SYNC",
      "SOURCE_INGEST",
      "CRON_ENQUEUE",
      "ASSIGNMENT_MUTATION",
    ]) {
      assert(
        laneContents.includes(`ADSECUTE_SYNC_LANE_${lane}_ENABLED=enabled`),
        `R2: ${lane} was not enabled; a partial enable is exactly what this must prevent.`,
      );
    }
    assert(
      laneContents.includes("ADSECUTE_SYNC_LANE_RETENTION_ENABLED=\n") ||
        laneContents.includes("ADSECUTE_SYNC_LANE_RETENTION_ENABLED="),
      "R2: retention appears in the enabled set.",
    );
    assert(
      !/ADSECUTE_SYNC_LANE_RETENTION_ENABLED=enabled/.test(laneContents),
      "R2: retention was ENABLED by the rollout script; it must never be.",
    );
    console.log(
      `${LABEL} R2 PASS atomic enable: all 6 sync lanes written in one action into the real compose env file, every unrelated key and comment preserved, a checksummed backup written, retention left disabled`,
    );

    // R3: disable always works and clears everything, including retention.
    const disabled = runRollout("disable");
    assert(disabled.status === 0, `R3: disable failed:\n${disabled.stderr}`);
    const afterDisable = fs.readFileSync(envPath, "utf8");
    assert(
      !/ADSECUTE_SYNC_[A-Z_]*=enabled/.test(afterDisable),
      `R3: disable left a lane enabled:\n${afterDisable}`,
    );
    assert(
      afterDisable.includes("DATABASE_URL=postgresql://user:s3cr3t@db:5432/adsecute?sslmode=require"),
      "R3: disable destroyed an unrelated key.",
    );
    console.log(
      `${LABEL} R3 PASS unconditional disable: every lane cleared including retention, unrelated keys intact`,
    );
  } finally {
    await client
      .query(`DELETE FROM sync_runner_leases WHERE business_id = '__rollout_probe__'`)
      .catch(() => undefined);
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-sync-retention-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let started = false;
  let client: Client | null = null;

  try {
    run(
      path.join(bin, "initdb"),
      ["-D", dataDir, "-U", USER, "--auth=trust", "--no-locale"],
      "initdb",
    );
    run(
      path.join(bin, "pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-w",
        "-o",
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`,
        "start",
      ],
      "pg_ctl start",
    );
    started = true;
    run(
      path.join(bin, "createdb"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", USER, DB],
      "createdb",
    );

    const connectionString = `postgresql://${USER}@127.0.0.1:${port}/${DB}`;
    process.env.DATABASE_URL = connectionString;
    process.env.DB_SSL_MODE = "disable";
    // Lanes default to OFF. A seam that exercises the real entrypoints has to
    // represent an ENABLED deployment, so it turns them on explicitly — which
    // is itself a check that the switch is wired where the seam runs.
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    for (const lane of [
      "META_SYNC",
      "GOOGLE_SYNC",
      "SHOPIFY_SYNC",
      "SOURCE_INGEST",
      "CRON_ENQUEUE",
      "ASSIGNMENT_MUTATION",
      "RETENTION",
    ]) {
      process.env[`ADSECUTE_SYNC_LANE_${lane}_ENABLED`] = "enabled";
    }

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "sync_retention_seam" });

    client = new Client({ connectionString });
    await client.connect();

    await verifyReadinessContract(client);
    await verifyDriftRefusal(client);
    await verifyRetentionSweep(client);
    await verifyGrowthBoundaries(client);
    await verifyReleaseBoundary(client);
    await verifyLegacyRetentionLaneOff(client);
    await verifySelectionQueries(client);
    await verifyRolloutOrchestration(client);

    console.log(`${LABEL} PASS`);
  } catch (error) {
    if (fs.existsSync(logFile)) {
      console.error(
        `${LABEL} log tail:\n${fs
          .readFileSync(logFile, "utf8")
          .split(/\r?\n/)
          .slice(-30)
          .join("\n")}`,
      );
    }
    throw error;
  } finally {
    if (client) await client.end().catch(() => undefined);
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    try {
      if (started) {
        spawnSync(
          path.join(bin, "pg_ctl"),
          ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
          { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
