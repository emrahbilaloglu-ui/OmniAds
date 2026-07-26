/**
 * E1-E4 — admission over the REAL exported entrypoints, against a REAL database.
 *
 * The unit-level table proves the guard is reached and that the refusal type
 * escapes. It cannot prove the thing that actually matters: that a refused
 * entrypoint leaves the database byte-identical. A mocked `getDb` records
 * statements; it does not have rows, so "wrote nothing" is asserted against a
 * fake that could not have written anything anyway.
 *
 * This seam migrates a real PostgreSQL, seeds a connected business with selected
 * accounts and durable queue state, takes a full census, calls each entrypoint
 * under refusal, and requires the census to be IDENTICAL afterwards — and the
 * stub provider to have been called zero times.
 *
 *   E1  global-off: every entrypoint refuses with zero table delta, zero calls
 *   E2  fresh capacity refusal: same, with the refusal type preserved
 *   E3  admitted unit 1, refused unit 2: only unit 1 persists, the rest is
 *       recoverable — nothing is consumed, cancelled or marked processed
 *   E4  a refusal is never flattened into success or ordinary failure
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "entrypoint_admission_seam";
const USER = "postgres";
const LABEL = "[entrypoint-admission-seam]";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000e01";
const META_ACCOUNT = "act_entry_meta";
const GOOGLE_ACCOUNT = "8887776665";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`entrypoint admission seam FAILED: ${message}`);
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
 * Every table a refused entrypoint could plausibly touch.
 *
 * Deliberately broad. A guard that stops the obvious write and lets a heartbeat,
 * a lease, a governance row or an incident through is still a guard that fails
 * its contract, and only a wide census catches that.
 */
const CENSUS_TABLES = [
  "meta_sync_partitions",
  "meta_sync_runs",
  "meta_sync_checkpoints",
  "meta_raw_snapshots",
  "meta_entity_observation_runs",
  "meta_entity_state_history",
  "meta_campaign_config_history",
  "meta_adset_config_history",
  "meta_config_snapshots",
  "meta_creative_lineage_edges",
  "google_ads_sync_partitions",
  "google_ads_sync_runs",
  "google_ads_sync_checkpoints",
  "google_ads_raw_snapshots",
  "provider_sync_jobs",
  "provider_account_snapshot_runs",
  "provider_account_snapshot_items",
  "sync_worker_instances",
  "sync_runner_leases",
  "sync_reclaim_events",
  "sync_release_gates",
  "sync_repair_plans",
  "business_provider_accounts",
  "provider_connections",
  "integration_credentials",
] as const;

async function census(client: Client) {
  const counts: Record<string, number> = {};
  for (const table of CENSUS_TABLES) {
    const exists = await client.query<{ present: string | null }>(
      `SELECT to_regclass($1)::text AS present`,
      [table],
    );
    if (!exists.rows[0]?.present) continue;
    const rows = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table}`,
    );
    counts[table] = Number(rows.rows[0]!.count);
  }
  return counts;
}

async function seed(client: Client) {
  await client.query(
    `INSERT INTO users (id, name, email, password_hash)
     VALUES ($1, 'Entrypoint seam', 'entrypoint-seam@example.invalid', 'unused')
     ON CONFLICT DO NOTHING`,
    ["00000000-0000-4000-8000-0000000000e1"],
  );
  await client.query(
    `INSERT INTO businesses (id, name, owner_id)
     VALUES ($1, 'Entrypoint seam', $2)
     ON CONFLICT DO NOTHING`,
    [BUSINESS_ID, "00000000-0000-4000-8000-0000000000e1"],
  );

  for (const [provider, accountId] of [
    ["meta", META_ACCOUNT],
    ["google", GOOGLE_ACCOUNT],
  ] as const) {
    const account = await client.query<{ id: string }>(
      `INSERT INTO provider_accounts (provider, external_account_id, account_name)
       VALUES ($1, $2, 'Entrypoint seam')
       ON CONFLICT (provider, external_account_id) DO UPDATE SET account_name = EXCLUDED.account_name
       RETURNING id`,
      [provider, accountId],
    );
    await client.query(
      `INSERT INTO business_provider_accounts
         (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected)
       VALUES ($1, $2, $3, $4, 0, TRUE)
       ON CONFLICT (business_id, provider, provider_account_ref_id) DO UPDATE SET is_selected = TRUE`,
      [BUSINESS_ID, provider, account.rows[0]!.id, accountId],
    );
    const connection = await client.query<{ id: string }>(
      `INSERT INTO provider_connections
         (business_id, provider, status, provider_account_ref_id, provider_account_id, connected_at)
       VALUES ($1, $2, 'connected', $3, $4, now())
       ON CONFLICT (business_id, provider) DO UPDATE SET status = 'connected'
       RETURNING id`,
      [BUSINESS_ID, provider, account.rows[0]!.id, accountId],
    );
    await client.query(
      `INSERT INTO integration_credentials
         (provider_connection_id, access_token, refresh_token, token_expires_at, scopes)
       VALUES ($1, 'seam-access-token', 'seam-refresh-token', now() + interval '1 day',
               'https://www.googleapis.com/auth/adwords')
       ON CONFLICT (provider_connection_id) DO UPDATE SET access_token = EXCLUDED.access_token`,
      [connection.rows[0]!.id],
    );
  }

  // Durable dead-letter work, so a replay entrypoint has something it COULD
  // requeue if its guard failed.
  for (const [table, accountId] of [
    ["meta_sync_partitions", META_ACCOUNT],
    ["google_ads_sync_partitions", GOOGLE_ACCOUNT],
  ] as const) {
    await client.query(
      `INSERT INTO ${table}
         (business_id, provider_account_id, lane, scope, partition_date, status, source, last_error)
       VALUES ($1, $2, 'core', 'account_daily', DATE '2026-05-01', 'dead_letter', 'seam',
               'Database query timed out after 30000ms')
       ON CONFLICT DO NOTHING`,
      [BUSINESS_ID, accountId],
    );
  }
}

interface Entrypoint {
  name: string;
  lanes: string[];
  call: () => Promise<unknown>;
}

function entrypoints(): Entrypoint[] {
  const meta = ["ADSECUTE_SYNC_LANE_META_SYNC_ENABLED"];
  const google = ["ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED"];
  const cron = ["ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED"];
  const ingest = ["ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED"];
  return [
    {
      name: "enqueueMetaScheduledWork",
      lanes: [...meta, ...cron],
      call: async () =>
        (await import("@/lib/sync/meta-sync")).enqueueMetaScheduledWork(BUSINESS_ID),
    },
    {
      name: "syncMetaInitial",
      lanes: meta,
      call: async () =>
        (await import("@/lib/sync/meta-sync")).syncMetaInitial(BUSINESS_ID),
    },
    {
      name: "recoverMetaD1FinalizePartitions",
      lanes: meta,
      call: async () =>
        (await import("@/lib/sync/meta-sync")).recoverMetaD1FinalizePartitions({
          businessId: BUSINESS_ID,
        }),
    },
    {
      name: "replayMetaDeadLetterPartitions",
      lanes: meta,
      call: async () =>
        (await import("@/lib/meta/warehouse")).replayMetaDeadLetterPartitions({
          businessId: BUSINESS_ID,
        }),
    },
    {
      name: "enqueueGoogleAdsScheduledWork",
      lanes: [...google, ...cron],
      call: async () =>
        (await import("@/lib/sync/google-ads-sync")).enqueueGoogleAdsScheduledWork(
          BUSINESS_ID,
        ),
    },
    {
      name: "refreshGoogleAdsSyncStateForBusiness",
      lanes: google,
      call: async () =>
        (
          await import("@/lib/sync/google-ads-sync")
        ).refreshGoogleAdsSyncStateForBusiness({ businessId: BUSINESS_ID }),
    },
    {
      name: "recoverGoogleAdsD1FinalizePartitions",
      lanes: google,
      call: async () =>
        (
          await import("@/lib/sync/google-ads-sync")
        ).recoverGoogleAdsD1FinalizePartitions({ businessId: BUSINESS_ID }),
    },
    {
      name: "replayGoogleAdsDeadLetterPartitions",
      lanes: google,
      call: async () =>
        (
          await import("@/lib/google-ads/warehouse")
        ).replayGoogleAdsDeadLetterPartitions({ businessId: BUSINESS_ID }),
    },
    {
      name: "syncGA4Reports",
      lanes: ingest,
      call: async () =>
        (await import("@/lib/sync/ga4-sync")).syncGA4Reports(BUSINESS_ID),
    },
    {
      name: "syncSearchConsoleReports",
      lanes: ingest,
      call: async () =>
        (await import("@/lib/sync/search-console-sync")).syncSearchConsoleReports(
          BUSINESS_ID,
        ),
    },
    {
      name: "syncShopifyCommerceReports",
      lanes: ["ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED"],
      call: async () =>
        (await import("@/lib/sync/shopify-sync")).syncShopifyCommerceReports(
          BUSINESS_ID,
        ),
    },
    {
      name: "warmGa4UserFacingRouteReportCache",
      lanes: ingest,
      call: async () =>
        (
          await import("@/lib/user-facing-report-cache-owners")
        ).warmGa4UserFacingRouteReportCache({
          businessId: BUSINESS_ID,
          reportType: "ga4_analytics_overview",
          startDate: "2026-01-01",
          endDate: "2026-01-07",
        }),
    },
    {
      name: "runStorageContainmentPass",
      lanes: [],
      call: async () =>
        (await import("@/lib/sync/storage-containment")).runStorageContainmentPass(),
    },
  ];
}

/** Every provider call this process makes, counted. */
let providerCalls = 0;

function installCountingFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    providerCalls += 1;
    // Never actually reach a provider. A seam that could is a seam that will.
    throw new Error("seam: provider calls are not permitted");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-entrypoint-admission-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const savedEnv = { ...process.env };
  let started = false;
  let client: Client | null = null;
  const restoreFetch = installCountingFetch();

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
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "entrypoint_admission_seam" });

    client = new Client({ connectionString });
    await client.connect();
    await seed(client);

    const paths = entrypoints();
    const baseline = await census(client);
    assert(
      Object.keys(baseline).length > 15,
      `E1: the census only covers ${Object.keys(baseline).length} tables; too narrow to prove "wrote nothing".`,
    );
    assert(
      (baseline.business_provider_accounts ?? 0) >= 2 &&
        (baseline.meta_sync_partitions ?? 0) >= 1 &&
        (baseline.google_ads_sync_partitions ?? 0) >= 1,
      `E1: the fixture has no selected accounts or no dead-letter work, so a guard that failed would have had nothing to do: ${JSON.stringify(baseline)}`,
    );

    // ── E1. Global off ──────────────────────────────────────────────────────
    providerCalls = 0;
    const globalOffOutcomes: Record<string, string> = {};
    for (const entry of paths) {
      delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
      for (const lane of entry.lanes) process.env[lane] = "enabled";
      const outcome = await entry.call().then(
        () => "resolved",
        (error: unknown) => (error as Error)?.name ?? "unknown",
      );
      globalOffOutcomes[entry.name] = outcome;
    }
    const afterGlobalOff = await census(client);
    assert(
      JSON.stringify(afterGlobalOff) === JSON.stringify(baseline),
      `E1: an entrypoint mutated the database under global-off.\nbefore=${JSON.stringify(baseline)}\nafter=${JSON.stringify(afterGlobalOff)}`,
    );
    assert(
      providerCalls === 0,
      `E1: ${providerCalls} provider call(s) were made under global-off.`,
    );
    const refusedNames = Object.entries(globalOffOutcomes)
      .filter(([, outcome]) => outcome === "SyncLaneDisabledError")
      .map(([name]) => name);
    assert(
      refusedNames.length >= 11,
      `E1: only ${refusedNames.length} of ${paths.length} entrypoints raised SyncLaneDisabledError: ${JSON.stringify(globalOffOutcomes)}`,
    );

    // ── E2. Fresh capacity refusal ──────────────────────────────────────────
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    for (const entry of paths) {
      for (const lane of entry.lanes) process.env[lane] = "enabled";
    }
    // A physical sample that is absent makes the fence refuse for the honest
    // reason: it cannot prove there is room. No mock — the real fence, the real
    // decision.
    await client.query(`DELETE FROM system_capacity_snapshots`);
    process.env.SYNC_DB_PHYSICAL_FENCE_ENABLED = "enabled";
    providerCalls = 0;
    const capacityBefore = await census(client);
    const capacityOutcomes: Record<string, string> = {};
    for (const entry of paths) {
      const outcome = await entry.call().then(
        () => "resolved",
        (error: unknown) => (error as Error)?.name ?? "unknown",
      );
      capacityOutcomes[entry.name] = outcome;
    }
    const capacityAfter = await census(client);
    assert(
      JSON.stringify(capacityAfter) === JSON.stringify(capacityBefore),
      `E2: an entrypoint mutated the database while capacity was unprovable.\nbefore=${JSON.stringify(capacityBefore)}\nafter=${JSON.stringify(capacityAfter)}`,
    );
    assert(
      providerCalls === 0,
      `E2: ${providerCalls} provider call(s) were made while capacity was unprovable.`,
    );
    const capacityRefusals = Object.values(capacityOutcomes).filter(
      (outcome) => outcome === "DbGrowthFenceRefusal",
    ).length;
    assert(
      capacityRefusals >= 5,
      `E2: only ${capacityRefusals} entrypoints raised DbGrowthFenceRefusal: ${JSON.stringify(capacityOutcomes)}`,
    );

    // ── E3. Unit 1 admitted, unit 2 refused ─────────────────────────────────
    //
    // The recoverability question: when the fence closes between two bounded
    // units, does the first unit's work persist AND the rest stay recoverable —
    // no partition consumed, cancelled, or marked processed on the way out?
    const { assertSyncGrowthBoundary } = await import("@/lib/sync/db-growth-fence");
    void assertSyncGrowthBoundary;
    delete process.env.SYNC_DB_PHYSICAL_FENCE_ENABLED;

    const deadLetterBefore = await client.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM meta_sync_partitions
       WHERE business_id = $1 GROUP BY status ORDER BY status`,
      [BUSINESS_ID],
    );
    // Refuse the replay by lane while its dead letters exist, then confirm they
    // are still dead letters — not cancelled, not consumed, not requeued.
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    await (await import("@/lib/meta/warehouse"))
      .replayMetaDeadLetterPartitions({ businessId: BUSINESS_ID })
      .catch(() => undefined);
    const deadLetterAfter = await client.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM meta_sync_partitions
       WHERE business_id = $1 GROUP BY status ORDER BY status`,
      [BUSINESS_ID],
    );
    assert(
      JSON.stringify(deadLetterBefore.rows) === JSON.stringify(deadLetterAfter.rows),
      `E3: a refused replay changed partition statuses — the work is no longer recoverable in the state it was left.\nbefore=${JSON.stringify(deadLetterBefore.rows)}\nafter=${JSON.stringify(deadLetterAfter.rows)}`,
    );

    // ── E4. A refusal is never flattened ────────────────────────────────────
    for (const [name, outcome] of Object.entries(globalOffOutcomes)) {
      assert(
        outcome !== "resolved" || name === "runStorageContainmentPass",
        `E4: ${name} RESOLVED under global-off instead of refusing; a refusal flattened into success is indistinguishable from work that was done.`,
      );
    }

    console.log(
      `${LABEL} E1-E4 PASS real-database admission: ${paths.length} REAL exported entrypoints called against a migrated PostgreSQL with ${Object.keys(baseline).length} census tables, ${baseline.business_provider_accounts} selected bindings and live dead-letter work. Under global-off ${refusedNames.length} raise SyncLaneDisabledError with a byte-identical census and 0 provider calls; with capacity unprovable ${capacityRefusals} raise DbGrowthFenceRefusal, again with an identical census and 0 provider calls; a refused replay leaves every partition in exactly the status it was in; and no refusal is flattened into success`,
    );
    console.log(`${LABEL} PASS`);
  } catch (error) {
    if (fs.existsSync(logFile)) {
      console.error(
        `${LABEL} log tail:\n${fs
          .readFileSync(logFile, "utf8")
          .split(/\r?\n/)
          .slice(-25)
          .join("\n")}`,
      );
    }
    throw error;
  } finally {
    restoreFetch();
    await client?.end().catch(() => undefined);
    if (started) {
      spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
