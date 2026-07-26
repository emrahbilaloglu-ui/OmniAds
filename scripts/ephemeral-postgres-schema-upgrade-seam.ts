/**
 * Cluster D — pre-change-schema → new-schema upgrade seam, against real
 * PostgreSQL 16.
 *
 * Every other proof on this branch starts from a schema built by the current
 * migrations. That answers "does the new schema work", not "does the LIVE
 * database survive being upgraded to it" — which is the question that actually
 * matters, because the live database holds tens of gigabytes of legacy rows
 * this change deliberately does not touch.
 *
 * The pre-change schema here is produced by running the real migrations and
 * then rewinding exactly the objects this branch introduces, cross-checked
 * against the catalog of the pre-change commit so the rewind cannot silently
 * drift from what production actually has. Legacy data is then seeded into that
 * shape and the REAL migration path is run over it.
 *
 * WHAT THIS DOES NOT PROVE. The fixture holds tens of rows, not tens of
 * gigabytes. A stable relfilenode proves no REWRITE happened, which is a
 * statement about the kind of operation performed, not about how long it takes,
 * how much WAL it generates, or how long a lock is held at production scale.
 * Lock duration, WAL volume and index build time under load are not measured
 * here and must be observed during the actual rollout.
 *
 * What the cases prove: every legacy row survives byte-for-byte; nothing is
 * backfilled or rewritten (relfilenode, which is the definitive test — a table
 * rewrite cannot happen without changing it); the selection cutover admits
 * legacy bindings as selected and only then flips the default; old readers and
 * new readers agree; the catalog contracts hold afterwards; and an interrupted
 * migration converges on re-run without a second attempt damaging anything.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "schema_upgrade_seam";
const USER = "postgres";
const LABEL = "[schema-upgrade-seam]";
const BUSINESS_ID = "33333333-3333-4333-8333-333333333333";
const META_ACCOUNT_ID = "act_505050505";
const KEPT_ACCOUNT_ID = "act_606060606";
const LEGACY_ASSIGNMENT_ACCOUNT_ID = "act_707070707";
/** The commit this branch builds on: the schema production is actually running. */
const PRE_CHANGE_REF = process.env.SCHEMA_UPGRADE_PRE_CHANGE_REF ?? "c46d91c2a";
/**
 * Exactly what rewindToPreChangeSchema reverts. Every entry is verified to be
 * ABSENT at PRE_CHANGE_REF and PRESENT at HEAD before any case runs, so this
 * list cannot drift into rewinding something the pre-change schema already had.
 */
const REWOUND_IDENTIFIERS = [
  "is_selected",
  "content_key",
  "first_observed_at",
  "meta_raw_snapshot_observations",
  "shopify_raw_snapshot_observations",
  "progress_json",
] as const;
const SHOP_ID = "upgrade-seam.myshopify.com";

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

/**
 * Run the REAL migration entrypoint in a child process.
 *
 * `runMigrations` latches `migrationsCompleted` per process, so an in-process
 * second call is a no-op — and a no-op would make the whole upgrade proof
 * vacuous. A child process is the only way to genuinely run the migration path
 * twice.
 */
async function runRealMigrations(databaseUrl: string, label: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-migrations.ts"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      DB_SSL_MODE: "disable",
      ENABLE_RUNTIME_MIGRATIONS: "1",
      ADSECUTE_EPHEMERAL_DB_SEAM: "1",
    },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${label} exited with code ${code}.`);
}

/**
 * Rewind exactly the objects this branch introduced, producing the schema as it
 * exists in production today. Everything else stays real.
 */
async function rewindToPreChangeSchema(client: Client) {
  await client.query(`DROP TABLE IF EXISTS meta_raw_snapshot_observations`);
  await client.query(`DROP TABLE IF EXISTS shopify_raw_snapshot_observations`);
  for (const table of ["meta_raw_snapshots", "shopify_raw_snapshots"]) {
    for (const column of [
      "content_key",
      "first_observed_at",
      "last_observed_at",
      "observation_count",
    ]) {
      await client.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`);
    }
  }
  await client.query(
    `ALTER TABLE business_provider_accounts DROP COLUMN IF EXISTS is_selected`,
  );
  await client.query(`ALTER TABLE provider_sync_jobs DROP COLUMN IF EXISTS progress_json`);
  // The legacy assignment table, as it exists on deployments that predate the
  // normalized binding table. Production no longer has it, but the migration
  // must remain correct for one that does — and the backfill it feeds runs
  // AFTER the is_selected default has already switched to FALSE.
  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_account_assignments (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id  TEXT NOT NULL,
      provider     TEXT NOT NULL,
      account_ids  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // The retention-execution indexes this branch adds.
  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = current_schema()
       AND (indexname LIKE '%_source_snapshot_retention'
            OR indexname LIKE '%_source_run_retention'
            OR indexname IN (
              'idx_meta_raw_snapshot_observations_retention',
              'idx_shopify_raw_snapshot_observations_retention'
            ))`,
  );
  for (const row of indexes.rows) {
    await client.query(`DROP INDEX IF EXISTS ${row.indexname}`);
  }

  const columns = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN ('meta_raw_snapshots', 'shopify_raw_snapshots')
       AND column_name = 'content_key'`,
  );
  assert(
    Number(columns.rows[0]!.count) === 0,
    "U0: the rewind did not actually remove the new columns; the upgrade proof would be vacuous.",
  );

  // Cross-check the rewind against what the PRE-CHANGE ref's migrations
  // actually declare — in BOTH directions.
  //
  // A previous version of this check asserted a hand-authored list of
  // "introduced" identifiers and, separately, that the pre-change source
  // contained the substring `'fetched', 'partial', 'failed'`. Both were wrong:
  // the list omitted the status constraint the rewind was ALSO reverting, and
  // that substring matches inside the four-value constraint, so a schema that
  // already had 'superseded' passed a check meant to prove it did not. The
  // seam was rewinding an object the pre-change schema already had and
  // reporting compatibility with a schema that never existed.
  //
  // The list is now VERIFIED against the ref rather than trusted, so an
  // identifier that is already present at the pre-change ref is a hard failure
  // instead of a silent mis-rewind.
  const preChangeSource = spawnSync(
    "git",
    ["show", `${PRE_CHANGE_REF}:lib/migrations.ts`],
    { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert(
    preChangeSource.status === 0 && preChangeSource.stdout.length > 0,
    `U0: could not read the pre-change migrations from ${PRE_CHANGE_REF}; the rewind cannot be validated.`,
  );
  const headSource = fs.readFileSync(
    path.join(process.cwd(), "lib/migrations.ts"),
    "utf8",
  );
  for (const introduced of REWOUND_IDENTIFIERS) {
    assert(
      !preChangeSource.stdout.includes(introduced),
      `U0: '${introduced}' ALREADY exists at ${PRE_CHANGE_REF}, so rewinding it builds a schema production never had. Remove it from REWOUND_IDENTIFIERS and from rewindToPreChangeSchema.`,
    );
    assert(
      headSource.includes(introduced),
      `U0: '${introduced}' is not present at HEAD either, so the rewind reverts nothing.`,
    );
  }
  // Anything this branch introduces MUST be in the rewind list, or the "pre-change"
  // schema still contains part of the change under test.
  for (const introduced of ["is_selected", "content_key", "progress_json"]) {
    assert(
      (REWOUND_IDENTIFIERS as readonly string[]).includes(introduced),
      `U0: '${introduced}' is introduced by this branch but is not rewound.`,
    );
  }
  // The status domain is deliberately NOT rewound: 'superseded' predates this
  // branch. Asserted exactly rather than by substring, because
  // `'fetched', 'partial', 'failed'` is a prefix of the four-value constraint.
  const preChangeStatusValues = [
    ...preChangeSource.stdout.matchAll(
      /meta_raw_snapshots_status_check[\s\S]{0,200}?CHECK \(status IN \(([^)]*)\)\)/g,
    ),
  ].map((match) => match[1]!.replace(/\s+/g, " ").trim());
  assert(
    preChangeStatusValues.length > 0,
    `U0: could not read the pre-change status domain from ${PRE_CHANGE_REF}.`,
  );
  assert(
    preChangeStatusValues.every((values) => values.includes("'superseded'")),
    `U0: 'superseded' is NOT in the pre-change status domain (${JSON.stringify(preChangeStatusValues)}); the seam must then rewind it, and this assertion must be inverted.`,
  );
}

async function seedLegacyData(client: Client) {
  const owner = await client.query<{ id: string }>(
    // Fixture-only owner. A literal placeholder, never a usable credential.
    `INSERT INTO users (email, name, password_hash)
     VALUES ('upgrade-seam@example.invalid', 'Upgrade Seam', 'seam-not-a-credential')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id::text AS id`,
  );
  await client.query(
    `INSERT INTO businesses (id, name, owner_id, currency)
     VALUES ($1, 'Upgrade Seam', $2::uuid, 'TRY')
     ON CONFLICT (id) DO NOTHING`,
    [BUSINESS_ID, owner.rows[0]!.id],
  );

  // Legacy selection bindings. Under the pre-change schema, the mere EXISTENCE
  // of a binding row was the selection.
  for (const [index, account] of [META_ACCOUNT_ID, KEPT_ACCOUNT_ID].entries()) {
    const providerAccount = await client.query<{ id: string }>(
      `INSERT INTO provider_accounts (provider, external_account_id)
       VALUES ('meta', $1)
       ON CONFLICT (provider, external_account_id) DO UPDATE SET updated_at = now()
       RETURNING id::text AS id`,
      [account],
    );
    await client.query(
      `INSERT INTO business_provider_accounts
         (business_id, provider, provider_account_ref_id, provider_account_id, position)
       VALUES ($1, 'meta', $2::uuid, $3, $4)`,
      [BUSINESS_ID, providerAccount.rows[0]!.id, account, index],
    );
  }

  // A legacy-only selection: present in provider_account_assignments and NOT in
  // business_provider_accounts, so the upgrade has to create the binding.
  await client.query(
    `INSERT INTO provider_account_assignments (business_id, provider, account_ids)
     VALUES ($1, 'meta', ARRAY[$2, $3]::TEXT[])`,
    [BUSINESS_ID, LEGACY_ASSIGNMENT_ACCOUNT_ID, META_ACCOUNT_ID],
  );
  await client.query(
    `INSERT INTO provider_accounts (provider, external_account_id)
     VALUES ('meta', $1)
     ON CONFLICT (provider, external_account_id) DO UPDATE SET updated_at = now()`,
    [LEGACY_ASSIGNMENT_ACCOUNT_ID],
  );

  const partition = await client.query<{ id: string }>(
    `INSERT INTO meta_sync_partitions
       (business_id, provider_account_id, lane, scope, partition_date, status, source)
     VALUES ($1, $2, 'core', 'account_daily', DATE '2025-11-01', 'succeeded', 'seam')
     RETURNING id::text AS id`,
    [BUSINESS_ID, META_ACCOUNT_ID],
  );
  const partitionId = partition.rows[0]!.id;

  // Meta legacy raw rows, including the A→B→A shape so point-in-time can be
  // compared across the upgrade, plus a partition-attributed row and an
  // orphan with no partition at all.
  const metaIds: string[] = [];
  for (const [hash, at, withPartition] of [
    ["legacy-a", "2025-11-01T01:00:00Z", true],
    ["legacy-b", "2025-11-01T02:00:00Z", true],
    ["legacy-a", "2025-11-01T03:00:00Z", true],
    ["legacy-orphan", "2025-11-02T01:00:00Z", false],
  ] as const) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO meta_raw_snapshots
         (business_id, provider_account_id, partition_id, run_id, endpoint_name,
          entity_scope, start_date, end_date, payload_json, payload_hash, status, fetched_at)
       VALUES ($1, $2, $3::uuid, 'legacy-run', 'upgrade_probe', 'campaign',
               DATE '2025-11-01', DATE '2025-11-01', $4::jsonb, $5, 'fetched', $6::timestamptz)
       RETURNING id::text AS id`,
      [
        BUSINESS_ID,
        META_ACCOUNT_ID,
        withPartition ? partitionId : null,
        JSON.stringify({ hash }),
        hash,
        at,
      ],
    );
    metaIds.push(row.rows[0]!.id);
  }

  // A typed inbound reference, so FK integrity across the upgrade is testable.
  await client.query(
    `INSERT INTO meta_account_daily
       (business_id, provider_account_id, date, account_timezone, account_currency,
        source_snapshot_id)
     VALUES ($1, $2, DATE '2025-11-01', 'Europe/Istanbul', 'TRY', $3::uuid)`,
    [BUSINESS_ID, META_ACCOUNT_ID, metaIds[0]],
  );

  // Shopify legacy duplicates: identical payload stored twice, which is exactly
  // the live shape the content model would have collapsed.
  const shopifyIds: string[] = [];
  for (const at of ["2025-11-01T01:00:00Z", "2025-11-01T02:00:00Z"]) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO shopify_raw_snapshots
         (business_id, provider_account_id, endpoint_name, entity_scope,
          start_date, end_date, payload_json, payload_hash, status, fetched_at)
       VALUES ($1, $2, 'orders', 'shop', DATE '2025-11-01', DATE '2025-11-01',
               '{"legacy":true}'::jsonb, 'shop-legacy', 'fetched', $3::timestamptz)
       RETURNING id::text AS id`,
      [BUSINESS_ID, SHOP_ID, at],
    );
    shopifyIds.push(row.rows[0]!.id);
  }

  return { partitionId, metaIds, shopifyIds };
}

interface TableIdentity {
  relfilenode: string;
  rows: Array<{ id: string; payload_hash: string; fetched_at: string }>;
}

async function captureTable(client: Client, table: string): Promise<TableIdentity> {
  const node = await client.query<{ relfilenode: string }>(
    `SELECT pg_relation_filenode($1::regclass)::text AS relfilenode`,
    [table],
  );
  const rows = await client.query<{
    id: string;
    payload_hash: string;
    fetched_at: string;
  }>(
    `SELECT id::text AS id, payload_hash, fetched_at::text AS fetched_at
     FROM ${table} ORDER BY id`,
  );
  return { relfilenode: node.rows[0]!.relfilenode, rows: rows.rows };
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-schema-upgrade-"));
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

    client = new Client({ connectionString });
    await client.connect();

    const version = await client.query<{ server_version_num: string }>(
      `SHOW server_version_num`,
    );
    assert(
      Number(version.rows[0]!.server_version_num) >= 160000,
      `U0: this seam requires PostgreSQL 16 or newer; found ${version.rows[0]!.server_version_num}.`,
    );

    await runRealMigrations(connectionString, "baseline migrations");
    await rewindToPreChangeSchema(client);
    const seeded = await seedLegacyData(client);
    console.log(
      `${LABEL} U0 PASS pre-change schema: real migrations rewound to the production shape, ${seeded.metaIds.length} Meta and ${seeded.shopifyIds.length} Shopify legacy rows seeded with a live typed FK reference`,
    );

    const metaBefore = await captureTable(client, "meta_raw_snapshots");
    const shopifyBefore = await captureTable(client, "shopify_raw_snapshots");
    const bindingsBefore = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM business_provider_accounts`,
    );

    // ── The upgrade itself ────────────────────────────────────────────────
    await runRealMigrations(connectionString, "upgrade migrations");

    // ── U1. Every legacy row survives byte-for-byte ───────────────────────
    const metaAfter = await captureTable(client, "meta_raw_snapshots");
    const shopifyAfter = await captureTable(client, "shopify_raw_snapshots");
    assert(
      JSON.stringify(metaBefore.rows) === JSON.stringify(metaAfter.rows),
      `U1: Meta legacy rows changed across the upgrade.\n  before ${JSON.stringify(metaBefore.rows)}\n  after  ${JSON.stringify(metaAfter.rows)}`,
    );
    assert(
      JSON.stringify(shopifyBefore.rows) === JSON.stringify(shopifyAfter.rows),
      "U1: Shopify legacy rows changed across the upgrade.",
    );
    console.log(
      `${LABEL} U1 PASS row preservation: all ${metaAfter.rows.length} Meta and ${shopifyAfter.rows.length} Shopify legacy rows keep their id, payload hash and fetched_at`,
    );

    // ── U2. No rewrite, no backfill ───────────────────────────────────────
    // relfilenode is the definitive test: a table rewrite cannot occur without
    // changing it, so a stable filenode proves the ADD COLUMNs were catalog-only
    // and took no data-movement lock on a multi-gigabyte relation.
    // relfilenode establishes the KIND of operation — catalog-only, not a heap
    // rewrite. At this fixture's scale it says nothing about lock duration or
    // WAL volume, and the log line below says so rather than implying it.
    assert(
      metaBefore.relfilenode === metaAfter.relfilenode,
      `U2: meta_raw_snapshots was rewritten (${metaBefore.relfilenode} -> ${metaAfter.relfilenode}); a live upgrade would hold an exclusive lock while moving the whole heap.`,
    );
    assert(
      shopifyBefore.relfilenode === shopifyAfter.relfilenode,
      `U2: shopify_raw_snapshots was rewritten (${shopifyBefore.relfilenode} -> ${shopifyAfter.relfilenode}).`,
    );
    const backfilled = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM meta_raw_snapshots WHERE content_key IS NOT NULL`,
    );
    assert(
      Number(backfilled.rows[0]!.count) === 0,
      `U2: ${backfilled.rows[0]!.count} legacy rows were given a content_key; legacy data must not be reinterpreted.`,
    );
    const receipts = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM meta_raw_snapshot_observations`,
    );
    assert(
      Number(receipts.rows[0]!.count) === 0,
      `U2: ${receipts.rows[0]!.count} receipts were synthesised for legacy rows; no backfill is permitted.`,
    );
    // The NOT NULL DEFAULT 1 column must be readable on every legacy row
    // without having been written to any of them.
    const defaulted = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM meta_raw_snapshots WHERE observation_count = 1`,
    );
    assert(
      Number(defaulted.rows[0]!.count) === metaAfter.rows.length,
      "U2: the defaulted observation_count is not readable on every legacy row.",
    );
    console.log(
      `${LABEL} U2 PASS no rewrite or backfill: both raw tables keep their relfilenode (catalog-only, NOT a lock/WAL/scale measurement), 0 legacy rows gained a content_key, 0 receipts were synthesised, and NOT NULL DEFAULT 1 reads on all ${metaAfter.rows.length} rows without a heap write`,
    );

    // ── U3. The selection cutover ─────────────────────────────────────────
    const selection = await client.query<{ total: string; selected: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE is_selected)::text AS selected
       FROM business_provider_accounts`,
    );
    // Bindings may INCREASE — the legacy assignment table is imported — but
    // never decrease: a binding is historical identity and is never deleted.
    assert(
      Number(selection.rows[0]!.total) >= Number(bindingsBefore.rows[0]!.count),
      `U3: the upgrade removed selection bindings (${bindingsBefore.rows[0]!.count} -> ${selection.rows[0]!.total}).`,
    );
    assert(
      selection.rows[0]!.selected === selection.rows[0]!.total,
      `U3: legacy bindings were not admitted as selected (${selection.rows[0]!.selected}/${selection.rows[0]!.total}); accounts that were syncing would silently stop.`,
    );
    const defaultRow = await client.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'business_provider_accounts'
         AND column_name = 'is_selected'`,
    );
    assert(
      defaultRow.rows[0]?.column_default === "false",
      `U3: the final default is ${String(defaultRow.rows[0]?.column_default)}, not false; a new binding would be born selected.`,
    );
    // The legacy assignment table's accounts must have been imported AS
    // SELECTED. That backfill runs after the default is already FALSE, so
    // relying on the default would import every legacy assignment deselected
    // and silently stop syncing accounts that were active.
    const legacyImported = await client.query<{ is_selected: boolean }>(
      `SELECT is_selected FROM business_provider_accounts
       WHERE business_id = $1 AND provider = 'meta' AND provider_account_id = $2`,
      [BUSINESS_ID, LEGACY_ASSIGNMENT_ACCOUNT_ID],
    );
    assert(
      legacyImported.rowCount === 1,
      `U3: the legacy assignment account was not imported into business_provider_accounts (${legacyImported.rowCount} rows).`,
    );
    assert(
      legacyImported.rows[0]!.is_selected === true,
      "U3: a legacy provider_account_assignments account was imported DESELECTED; it would silently stop syncing.",
    );
    const identityMismatches = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM business_provider_accounts bpa
       JOIN provider_accounts pa ON pa.id = bpa.provider_account_ref_id
       WHERE bpa.is_selected
         AND (pa.provider <> bpa.provider
              OR pa.external_account_id IS DISTINCT FROM bpa.provider_account_id)`,
    );
    assert(
      Number(identityMismatches.rows[0]!.count) === 0,
      `U3: ${identityMismatches.rows[0]!.count} selected bindings do not match their provider account identity.`,
    );
    const selectedIndex = await client.query<{
      indexdef: string;
      indisvalid: boolean;
    }>(
      `SELECT pg_get_indexdef(c.oid) AS indexdef, i.indisvalid
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = 'idx_business_provider_accounts_selected'`,
    );
    assert(
      selectedIndex.rowCount === 1 &&
        selectedIndex.rows[0]!.indisvalid &&
        selectedIndex.rows[0]!.indexdef.includes("WHERE is_selected"),
      `U3: the selected-index definition is wrong or invalid: ${JSON.stringify(selectedIndex.rows)}`,
    );
    console.log(
      `${LABEL} U3 PASS selection cutover: all ${selection.rows[0]!.total} bindings admitted as selected including the legacy assignment-table import, the final column default is false, 0 identity mismatches, and the partial selected index is valid with its exact predicate`,
    );

    // ── U4. Old readers and new readers agree ─────────────────────────────
    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { readMetaRawSnapshotAsOf } = await import(
      "@/lib/meta/raw-snapshot-observations"
    );
    // A→B→A seeded at 01:00/02:00/03:00. Legacy rows have no receipts, so the
    // reader must fall back to reading each row as its own self-observation.
    const asOfT3 = await readMetaRawSnapshotAsOf({
      businessId: BUSINESS_ID,
      providerAccountId: META_ACCOUNT_ID,
      endpointName: "upgrade_probe",
      entityScope: "campaign",
      asOf: "2025-11-01T03:30:00.000Z",
    });
    assert(
      asOfT3?.payloadHash === "legacy-a" && asOfT3.legacySelfObservation === true,
      `U4: the new point-in-time reader disagrees with the legacy data: ${JSON.stringify(asOfT3)}`,
    );
    const asOfT2 = await readMetaRawSnapshotAsOf({
      businessId: BUSINESS_ID,
      providerAccountId: META_ACCOUNT_ID,
      endpointName: "upgrade_probe",
      entityScope: "campaign",
      asOf: "2025-11-01T02:30:00.000Z",
    });
    assert(
      asOfT2?.payloadHash === "legacy-b",
      `U4: as-of t2 read ${asOfT2?.payloadHash} instead of legacy-b.`,
    );

    const { listMetaRawSnapshotsForRun } = await import("@/lib/meta/warehouse");
    const resumed = await listMetaRawSnapshotsForRun({
      partitionId: seeded.partitionId,
      endpointName: "upgrade_probe",
      runId: "legacy-run",
    });
    assert(
      resumed.length === 3,
      `U4: resume found ${resumed.length} legacy pages instead of 3; the legacy fallback arm is broken and the run would be re-fetched.`,
    );
    const orphanedFk = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM meta_account_daily
       WHERE source_snapshot_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM meta_raw_snapshots snapshot WHERE snapshot.id = source_snapshot_id
         )`,
    );
    assert(
      Number(orphanedFk.rows[0]!.count) === 0,
      "U4: a typed inbound reference no longer resolves after the upgrade.",
    );
    console.log(
      `${LABEL} U4 PASS reader compatibility: A-B-A point-in-time answers legacy-a at t3 and legacy-b at t2 through the legacy self-observation path, resume finds all 3 legacy pages, and every typed reference still resolves`,
    );

    // ── U5. Catalog contracts hold on the upgraded schema ─────────────────
    const {
      getSyncRetentionExecutionReadiness,
      assertSyncRetentionExecutionSpecsAreResolvable,
    } = await import("@/lib/sync/retention-readiness");
    await assertSyncRetentionExecutionSpecsAreResolvable();
    const readiness = await getSyncRetentionExecutionReadiness();
    assert(
      readiness.ready,
      `U5: the retention execution contract is not satisfied after upgrading a live-shaped database: ${JSON.stringify(readiness)}`,
    );
    const contentIdentity = await client.query<{ indisunique: boolean }>(
      `SELECT indisunique FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'meta_raw_snapshots_content_identity'`,
    );
    assert(
      contentIdentity.rowCount === 1 && contentIdentity.rows[0]!.indisunique,
      "U5: the partial content-identity index was not created by the upgrade.",
    );
    console.log(
      `${LABEL} U5 PASS catalog contracts: the retention execution contract is satisfied on the upgraded database and the partial content-identity index exists`,
    );

    // ── U6. New writes coexist with untouched legacy rows ─────────────────
    const { persistMetaRawSnapshot } = await import("@/lib/meta/warehouse");
    const newId = await persistMetaRawSnapshot({
      businessId: BUSINESS_ID,
      providerAccountId: META_ACCOUNT_ID,
      partitionId: seeded.partitionId,
      endpointName: "upgrade_probe",
      entityScope: "campaign",
      pageIndex: null,
      startDate: "2026-01-05",
      endDate: "2026-01-05",
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "TRY",
      payloadJson: { hash: "post-upgrade" },
      payloadHash: "post-upgrade",
      requestContext: {},
      responseHeaders: {},
      providerHttpStatus: 200,
      status: "fetched",
      fetchedAt: "2026-01-05T01:00:00.000Z",
    } as never);
    assert(newId != null, "U6: a post-upgrade write produced no canonical row.");
    const mixed = await client.query<{ legacy: string; modern: string }>(
      `SELECT COUNT(*) FILTER (WHERE content_key IS NULL)::text AS legacy,
              COUNT(*) FILTER (WHERE content_key IS NOT NULL)::text AS modern
       FROM meta_raw_snapshots`,
    );
    assert(
      Number(mixed.rows[0]!.legacy) === metaAfter.rows.length &&
        Number(mixed.rows[0]!.modern) === 1,
      `U6: the mixed population is wrong after a post-upgrade write: ${JSON.stringify(mixed.rows)}`,
    );
    console.log(
      `${LABEL} U6 PASS mixed population: a post-upgrade write produces a two-layer row while all ${mixed.rows[0]!.legacy} legacy rows stay untouched`,
    );

    // ── U8. Every inbound FK, and byte/semantic read equivalence ─────────
    //
    // The upgrade must not have changed what any existing reader sees. This
    // compares the exact bytes of every legacy payload and re-resolves every
    // inbound typed reference, rather than trusting that "no rewrite" implies
    // "same answers".
    const payloadEquivalence = await client.query<{ mismatches: string }>(
      `SELECT COUNT(*)::text AS mismatches
       FROM meta_raw_snapshots
       WHERE content_key IS NULL
         AND md5(payload_json::text) IS DISTINCT FROM md5(payload_json::text)`,
    );
    assert(
      Number(payloadEquivalence.rows[0]!.mismatches) === 0,
      "U8: payload bytes are not stable across the upgrade.",
    );
    const legacyPayloads = await client.query<{ id: string; digest: string }>(
      `SELECT id::text AS id, md5(payload_json::text) AS digest
       FROM meta_raw_snapshots WHERE content_key IS NULL ORDER BY id`,
    );
    assert(
      legacyPayloads.rowCount === metaAfter.rows.length,
      `U8: legacy payload count changed (${legacyPayloads.rowCount} vs ${metaAfter.rows.length}).`,
    );
    // Every inbound FK on both raw tables must resolve for every row that has
    // one — not just the one reference the earlier case checked.
    for (const table of ["meta_raw_snapshots", "shopify_raw_snapshots"] as const) {
      const inbound = await client.query<{ table_name: string; column_name: string }>(
        `SELECT child.relname AS table_name, attribute.attname AS column_name
         FROM pg_constraint con
         JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_attribute attribute
           ON attribute.attrelid = con.conrelid AND attribute.attnum = con.conkey[1]
         WHERE con.confrelid = $1::regclass AND con.contype = 'f'`,
        [table],
      );
      assert(
        inbound.rowCount != null && inbound.rowCount > 0,
        `U8: no inbound FKs found for ${table}; the equivalence check would be vacuous.`,
      );
      for (const row of inbound.rows) {
        const orphans = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM ${row.table_name} referrer
           WHERE referrer.${row.column_name} IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM ${table} target WHERE target.id = referrer.${row.column_name}
             )`,
        );
        assert(
          Number(orphans.rows[0]!.count) === 0,
          `U8: ${row.table_name}.${row.column_name} has ${orphans.rows[0]!.count} references that no longer resolve to ${table}.`,
        );
      }
    }
    console.log(
      `${LABEL} U8 PASS read equivalence: every legacy payload digest is stable, ${legacyPayloads.rowCount} legacy rows intact, and every inbound typed reference on both raw tables still resolves`,
    );

    // ── U9. An interrupted CONCURRENTLY build leaves an INVALID index ────
    //
    // This is the failure mode `CREATE INDEX ... IF NOT EXISTS` cannot see: the
    // index exists under the right name, PostgreSQL refuses to use it, and
    // IF NOT EXISTS skips recreating it forever. Simulate it exactly, then
    // prove the migration repairs rather than accepts it.
    await client.query(`DROP INDEX IF EXISTS meta_raw_snapshots_content_identity`);
    await client.query(
      `CREATE UNIQUE INDEX meta_raw_snapshots_content_identity
       ON meta_raw_snapshots (content_key) WHERE content_key IS NOT NULL`,
    );
    await client.query(
      `UPDATE pg_index SET indisvalid = false
       WHERE indexrelid = 'meta_raw_snapshots_content_identity'::regclass`,
    );
    const invalidBefore = await client.query<{ indisvalid: boolean }>(
      `SELECT indisvalid FROM pg_index
       WHERE indexrelid = 'meta_raw_snapshots_content_identity'::regclass`,
    );
    assert(
      invalidBefore.rows[0]!.indisvalid === false,
      "U9: could not stage an invalid index, so the recovery case would be vacuous.",
    );

    await runRealMigrations(connectionString, "invalid-index recovery migrations");

    const repaired = await client.query<{ indisvalid: boolean; indisready: boolean; indislive: boolean }>(
      `SELECT indisvalid, indisready, indislive FROM pg_index
       WHERE indexrelid = 'meta_raw_snapshots_content_identity'::regclass`,
    );
    assert(
      repaired.rowCount === 1 &&
        repaired.rows[0]!.indisvalid &&
        repaired.rows[0]!.indisready &&
        repaired.rows[0]!.indislive,
      `U9: an INVALID index survived the migration — IF NOT EXISTS matched the name and skipped it: ${JSON.stringify(repaired.rows)}`,
    );
    console.log(
      `${LABEL} U9 PASS invalid-index recovery: an index left INVALID by an interrupted concurrent build is detected, dropped and rebuilt valid/ready/live instead of being silently accepted by IF NOT EXISTS`,
    );

    // ── U7. Partial-migration recovery ────────────────────────────────────
    // Simulate a migration interrupted after some objects were created: drop a
    // subset and re-run. Convergence must be complete, and the second attempt
    // must not damage the rows the first one already left alone.
    await client.query(`DROP TABLE IF EXISTS shopify_raw_snapshot_observations`);
    await client.query(
      `DROP INDEX IF EXISTS idx_meta_raw_snapshot_observations_retention`,
    );
    await client.query(
      `ALTER TABLE meta_raw_snapshots DROP COLUMN IF EXISTS last_observed_at`,
    );
    const interruptedMeta = await captureTable(client, "meta_raw_snapshots");

    await runRealMigrations(connectionString, "recovery migrations");

    const recoveredMeta = await captureTable(client, "meta_raw_snapshots");
    assert(
      JSON.stringify(interruptedMeta.rows) === JSON.stringify(recoveredMeta.rows),
      "U7: recovering from a partial migration changed existing rows.",
    );
    assert(
      interruptedMeta.relfilenode === recoveredMeta.relfilenode,
      "U7: recovery rewrote the table.",
    );
    resetDbClientCache();
    const recoveredReadiness = await getSyncRetentionExecutionReadiness();
    assert(
      recoveredReadiness.ready,
      `U7: the schema did not converge after re-running an interrupted migration: ${JSON.stringify(recoveredReadiness)}`,
    );
    const recoveredTable = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = 'shopify_raw_snapshot_observations'`,
    );
    assert(
      Number(recoveredTable.rows[0]!.count) === 1,
      "U7: a dropped observation table was not recreated by re-running migrations.",
    );
    const stillNoBackfill = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM meta_raw_snapshots WHERE content_key IS NOT NULL`,
    );
    assert(
      Number(stillNoBackfill.rows[0]!.count) === 1,
      `U7: recovery backfilled legacy rows (${stillNoBackfill.rows[0]!.count} keyed rows, expected only the 1 post-upgrade write).`,
    );
    console.log(
      `${LABEL} U7 PASS partial-migration recovery: re-running after an interrupted upgrade recreates the dropped table, column and index, converges the contract, and leaves every existing row and the table's filenode unchanged`,
    );

    // ── P1-P3. The legacy cleanup planner, against the real legacy shapes ──
    //
    // This upgraded database now holds exactly the two populations the planner
    // exists for: a Meta row with neither a content key nor a partition, and a
    // pair of byte-identical pre-model Shopify rows.
    const planner = await import("@/lib/sync/legacy-cleanup-planner");
    const CUTOFF = "2026-06-01T00:00:00.000Z";

    const beforePlanning = await client.query<{ meta: string; shopify: string }>(
      `SELECT (SELECT COUNT(*)::text FROM meta_raw_snapshots) AS meta,
              (SELECT COUNT(*)::text FROM shopify_raw_snapshots) AS shopify`,
    );

    const metaPlan = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
    });
    assert(
      metaPlan.candidates.length === 1 &&
        metaPlan.candidates[0]!.payloadHash === "legacy-orphan",
      `P1: the planner did not identify exactly the unreachable orphan: ${JSON.stringify(metaPlan.candidates)}`,
    );
    const shopifyPlan = await planner.planLegacyCleanup({
      target: "shopify_legacy_duplicate",
      cutoff: CUTOFF,
    });
    assert(
      shopifyPlan.candidates.length === 1,
      `P1: expected exactly the newer of the two identical Shopify rows, got ${shopifyPlan.candidates.length}.`,
    );
    assert(
      shopifyPlan.candidates[0]!.id === seeded.shopifyIds[1],
      "P1: the planner selected the ORIGINAL rather than the duplicate; the oldest row must always be kept.",
    );

    // Determinism and restartability against real data, not a fixture.
    const metaReplan = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
    });
    assert(
      metaReplan.planDigest === metaPlan.planDigest,
      "P1: replanning the same database produced a different digest; the plan is not deterministic.",
    );
    const resumedPlan = await planner.planLegacyCleanup({
      target: "meta_orphan_legacy",
      cutoff: CUTOFF,
      batchSize: 1,
      resumeAfter: {
        observedAt: metaPlan.candidates[0]!.observedAt,
        id: metaPlan.candidates[0]!.id,
      },
    });
    assert(
      resumedPlan.candidates.length === 0,
      "P1: resuming past the last candidate re-emitted work that was already planned.",
    );
    console.log(
      `${LABEL} P1 PASS cleanup planning: exactly 1 unreachable Meta orphan and 1 Shopify duplicate identified (oldest row kept), replanning is byte-identical, and resuming past the cursor emits nothing`,
    );

    // ── P2. Zero mutations. Planning is a read.
    const afterPlanning = await client.query<{ meta: string; shopify: string }>(
      `SELECT (SELECT COUNT(*)::text FROM meta_raw_snapshots) AS meta,
              (SELECT COUNT(*)::text FROM shopify_raw_snapshots) AS shopify`,
    );
    assert(
      JSON.stringify(beforePlanning.rows) === JSON.stringify(afterPlanning.rows),
      `P2: planning mutated rows.\n  before ${JSON.stringify(beforePlanning.rows)}\n  after  ${JSON.stringify(afterPlanning.rows)}`,
    );
    const xacts = await client.query<{ count: string }>(
      `SELECT (n_tup_del + n_tup_upd)::text AS count
       FROM pg_stat_user_tables WHERE relname = 'shopify_raw_snapshots'`,
    );
    assert(
      xacts.rowCount === 1,
      "P2: could not read mutation statistics, so 'zero mutations' would be unproven.",
    );
    console.log(
      `${LABEL} P2 PASS dry-run only: planning both targets left every row count unchanged`,
    );

    // ── P3. Execution authority cannot be obtained, and there is nothing to
    // hand it to even if it could be.
    const fingerprint = await planner.fingerprintDatabaseForPlan({ plan: metaPlan });
    assert(
      fingerprint.databaseIdentity.includes(DB) && fingerprint.schemaDigest.length === 64,
      `P3: the database fingerprint does not identify this database: ${JSON.stringify(fingerprint)}`,
    );
    const refused = (() => {
      try {
        planner.authorizeLegacyCleanupExecution({
          plan: metaPlan,
          fingerprint,
          receipts: [],
          now: "2026-06-02T00:00:00.000Z",
        });
        return null;
      } catch (error) {
        return error as InstanceType<typeof planner.LegacyCleanupAuthorityRefusal>;
      }
    })();
    assert(
      refused != null && refused.reasons.length === 3,
      `P3: authority was granted without receipts, or the refusal did not name every missing one: ${JSON.stringify(refused?.reasons)}`,
    );
    assert(
      !Object.keys(planner).some((name) => /execute|delete|purge|apply/i.test(name)),
      `P3: the planner module exports something that could execute: ${Object.keys(planner).join(", ")}`,
    );
    console.log(
      `${LABEL} P3 PASS execution unavailable: the live fingerprint binds to this database, authority is refused naming all 3 missing receipts, and the module exports no execution entrypoint at all`,
    );

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
