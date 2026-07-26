/**
 * D1-D8 — the daily backup, restored into an empty PostgreSQL, against real servers.
 *
 * `deploy/db/adsecute-db-core-backup.sh` used to dump a hand-written 15-table
 * allowlist with `--data-only`. The schema this application migrates creates 202
 * ordinary tables, so 187 of them were absent — including every table that
 * carries Sync and integration AUTHORITY and CONTINUITY. Nothing tested that.
 * The claim "the daily backup permits disaster recovery" rested entirely on
 * reading the script and believing its comment.
 *
 * A unit test cannot close that gap. There is no way to mock `pg_dump` and learn
 * anything: the question is whether the BYTES the real program writes can be
 * turned back into a database the application can boot against, and only a real
 * dump restored into a real empty server answers it.
 *
 * So this seam runs the ACTUAL backup script against a real migrated PostgreSQL
 * holding real linked authority state, restores the artifact into a SECOND,
 * empty PostgreSQL, and proves:
 *
 *   D1  the artifact declares full-database scope and its own completeness check
 *       agrees with the live catalog — 0 tables missing, 0 unexpected
 *   D2  the restored database has the same table set as the source
 *   D3  exact row counts match for EVERY table, and the authority tables are
 *       non-empty, so the comparison is not vacuously true of an empty fixture
 *   D4  every foreign key in the restored database is satisfiable, proven by
 *       re-adding each one NOT VALID and running VALIDATE CONSTRAINT — not by
 *       trusting that pg_restore would have complained
 *   D5  authority continuity is byte-identical: connection generations,
 *       credential digests, selection sets, snapshot revisions, claim
 *       owners/epochs/generations, connection fingerprints, scheduling receipts,
 *       Shopify grants and release-gate evidence
 *   D6  sequence positions survive, so the next id is not a collision
 *   D7  the app is ready: real migrations run against the restored database
 *       succeed, change nothing in the schema, and the schema contract in
 *       `lib/migration-verification.ts` passes
 *   D8  nothing the backup wrote or printed contains a credential
 *
 * Secrets are compared as md5 digests computed inside PostgreSQL. No token value
 * is ever selected into this process, printed, or written to a file.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const SOURCE_DB = "dr_restore_source";
const TARGET_DB = "dr_restore_target";
const USER = "postgres";
const LABEL = "[dr-restore-seam]";

const BACKUP_SCRIPT = "deploy/db/adsecute-db-core-backup.sh";

/**
 * Plaintext secrets the fixture persists.
 *
 * They exist so D8 can prove none of them reached any file the backup wrote or
 * any line it printed. They are never sent to a provider and never leave this
 * process except as an md5 digest computed by PostgreSQL.
 */
const SECRETS = {
  metaAccess: "dr-seam-meta-access-3f0c1d",
  metaRefresh: "dr-seam-meta-refresh-77a2be",
  googleAccess: "dr-seam-google-access-91be04",
  googleRefresh: "dr-seam-google-refresh-2c5f18",
  shopifyAccess: "dr-seam-shopify-access-4ad9e7",
  shopifyGrant: "dr-seam-shopify-install-grant-6b1c30",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`dr restore seam FAILED: ${message}`);
}

function pgBinDir() {
  const need = ["initdb", "pg_ctl", "createdb", "pg_dump", "pg_restore", "psql"];
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

async function freePort(taken: Set<number>) {
  for (let i = 0; i < 20; i += 1) {
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
    if (!FORBIDDEN_PORTS.has(port) && !taken.has(port)) {
      taken.add(port);
      return port;
    }
  }
  throw new Error("no safe port");
}

function run(bin: string, args: string[], label: string) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}). ${result.stderr?.trim() ?? ""}`);
  }
  return result.stdout ?? "";
}

interface Server {
  port: number;
  dataDir: string;
  logFile: string;
  url: (db: string) => string;
}

function startServer(bin: string, root: string, name: string, port: number): Server {
  const dataDir = path.join(root, `${name}-data`);
  const logFile = path.join(root, `${name}.log`);
  run(
    path.join(bin, "initdb"),
    ["-D", dataDir, "-U", USER, "--auth=trust", "--no-locale"],
    `initdb (${name})`,
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
    `pg_ctl start (${name})`,
  );
  return {
    port,
    dataDir,
    logFile,
    url: (db: string) => `postgresql://${USER}@127.0.0.1:${port}/${db}`,
  };
}

/**
 * Run the REAL migration entrypoint in a child process.
 *
 * `runMigrations` latches completion per process, so an in-process second call
 * against the restored database would be a no-op — and a no-op that "succeeds"
 * is exactly the false green this seam exists to avoid.
 */
async function runRealMigrations(databaseUrl: string, label: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-migrations.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LC_ALL: "C",
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      DB_SSL_MODE: "disable",
      ENABLE_RUNTIME_MIGRATIONS: "1",
      ADSECUTE_EPHEMERAL_DB_SEAM: "1",
    },
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) {
    throw new Error(`${label} exited with code ${code}.\n${output.split(/\r?\n/).slice(-30).join("\n")}`);
  }
  return output;
}

// ── Catalog-driven comparisons ───────────────────────────────────────────────

const TABLE_SET_SQL = `
  SELECT n.nspname || '.' || c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p') AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
  ORDER BY 1`;

const ROW_CENSUS_SQL = `
  SELECT n.nspname || '.' || c.relname AS name,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT COUNT(*) AS c FROM %I.%I', n.nspname, c.relname),
                             false, true, '')))[1]::text AS count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','p') AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'
  ORDER BY 1`;

/**
 * A digest of the whole public schema: columns with their types, nullability and
 * defaults; every index definition; every constraint definition; every trigger
 * definition.
 *
 * Used twice — restored-vs-source, and restored-before-vs-after-migrations. A
 * table-name comparison would pass over a restore that lost a column default, an
 * index or a trigger, and every one of those is load-bearing here.
 */
const SCHEMA_FINGERPRINT_SQL = `
  SELECT entry FROM (
    SELECT 'col:' || table_name || '.' || column_name || ':' || data_type || ':' ||
           is_nullable || ':' || coalesce(column_default, '') AS entry
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL
    SELECT 'idx:' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL
    SELECT 'con:' || k.conname || ':' || pg_get_constraintdef(k.oid)
      FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public'
    UNION ALL
    SELECT 'trg:' || t.tgname || ':' || pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname = 'public'
    UNION ALL
    SELECT 'fun:' || p.proname || ':' || md5(pg_get_functiondef(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  ) s ORDER BY entry`;

/**
 * The authority and continuity projections, compared byte for byte.
 *
 * Secrets appear ONLY as md5 digests computed by PostgreSQL: the comparison
 * proves the same bytes were restored without those bytes ever entering this
 * process.
 */
const AUTHORITY_PROJECTIONS: Record<string, string> = {
  provider_connections: `
    SELECT c.business_id, c.provider, c.status,
           c.connection_generation::text AS generation,
           c.provider_account_id,
           md5(cred.access_token) AS access_digest,
           md5(cred.refresh_token) AS refresh_digest,
           md5(cred.metadata::text) AS credential_metadata_digest
    FROM provider_connections c
    LEFT JOIN integration_credentials cred ON cred.provider_connection_id = c.id
    ORDER BY c.business_id, c.provider`,
  business_provider_accounts: `
    SELECT business_id, provider, provider_account_id, is_selected, position::text
    FROM business_provider_accounts ORDER BY 1, 2, 3`,
  provider_accounts: `
    SELECT provider, external_account_id, account_name
    FROM provider_accounts ORDER BY 1, 2`,
  provider_account_snapshot_runs: `
    SELECT business_id, provider, accounts_hash, connection_fingerprint,
           refresh_claim_owner, refresh_claim_epoch::text, refresh_claim_generation,
           refresh_in_progress, refresh_failure_streak::text
    FROM provider_account_snapshot_runs ORDER BY 1, 2`,
  provider_account_snapshot_items: `
    SELECT r.business_id, r.provider, i.provider_account_id, i.provider_account_name, i.position::text
    FROM provider_account_snapshot_items i
    JOIN provider_account_snapshot_runs r ON r.id = i.snapshot_run_id
    ORDER BY 1, 2, 3`,
  meta_sync_partitions: `
    SELECT business_id, provider_account_id, lane, scope, partition_date::text, status,
           scheduling_attempt_id::text
    FROM meta_sync_partitions ORDER BY 1, 2, 3, 4, 5`,
  google_ads_sync_partitions: `
    SELECT business_id, provider_account_id, lane, scope, partition_date::text, status,
           scheduling_attempt_id::text
    FROM google_ads_sync_partitions ORDER BY 1, 2, 3, 4, 5`,
  provider_sync_jobs: `
    SELECT business_id, provider, report_type, date_range_key, status, lock_owner
    FROM provider_sync_jobs ORDER BY 1, 2, 3, 4`,
  shopify_install_contexts: `
    SELECT shop_domain, shop_name, scopes,
           md5(token) AS token_digest, md5(access_token) AS access_digest,
           expires_at::text
    FROM shopify_install_contexts ORDER BY 1`,
  sync_release_gates: `
    SELECT build_id, environment, gate_kind, provider_scope, mode, base_result, verdict,
           decision_fingerprint, coalesced_count::text, md5(evidence_json::text) AS evidence_digest
    FROM sync_release_gates ORDER BY 1, 2, 3, 4`,
  sync_incidents: `
    SELECT build_id, environment, provider_scope, business_id, fault_class, fault_signature,
           status, observation_count::text
    FROM sync_incidents ORDER BY 1, 2, 3, 4, 5, 6`,
  system_capacity_snapshots: `
    SELECT source, hostname, md5(payload::text) AS payload_digest
    FROM system_capacity_snapshots ORDER BY 1, 2, 3`,
  sequences: `
    SELECT schemaname || '.' || sequencename AS name, last_value::text
    FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
};

/** Tables whose emptiness would make D3 and D5 vacuously true. */
const MUST_BE_POPULATED = [
  "public.users",
  "public.businesses",
  "public.provider_connections",
  "public.integration_credentials",
  "public.provider_accounts",
  "public.business_provider_accounts",
  "public.provider_account_snapshot_runs",
  "public.provider_account_snapshot_items",
  "public.provider_sync_jobs",
  "public.meta_sync_partitions",
  "public.google_ads_sync_partitions",
  "public.shopify_install_contexts",
  "public.sync_release_gates",
  "public.sync_incidents",
  "public.system_capacity_snapshots",
] as const;

async function rows(client: Client, sql: string) {
  return (await client.query(sql)).rows as Array<Record<string, unknown>>;
}

async function census(client: Client) {
  const map: Record<string, number> = {};
  for (const row of await rows(client, ROW_CENSUS_SQL)) {
    map[String(row.name)] = Number(row.count);
  }
  return map;
}

async function main() {
  const bin = pgBinDir();
  const taken = new Set<number>();
  const sourcePort = await freePort(taken);
  const targetPort = await freePort(taken);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-dr-restore-"));
  const backupRoot = path.join(tmp, "backups");
  const savedEnv = { ...process.env };
  let source: Server | null = null;
  let target: Server | null = null;
  let sourceClient: Client | null = null;
  let targetClient: Client | null = null;

  try {
    // ── Source: a real migrated database with real linked authority state ────
    source = startServer(bin, tmp, "source", sourcePort);
    run(
      path.join(bin, "createdb"),
      ["-h", "127.0.0.1", "-p", String(sourcePort), "-U", USER, SOURCE_DB],
      "createdb (source)",
    );

    const sourceUrl = source.url(SOURCE_DB);
    process.env.DATABASE_URL = sourceUrl;
    process.env.DATABASE_URL_UNPOOLED = sourceUrl;
    process.env.DB_SSL_MODE = "disable";
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = "dr-restore-seam-encryption-key";
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED = "enabled";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "dr_restore_seam" });

    sourceClient = new Client({ connectionString: sourceUrl });
    await sourceClient.connect();

    const { upsertIntegration } = await import("@/lib/integrations");
    const { writeProviderAccountSnapshot } = await import(
      "@/lib/provider-account-snapshots"
    );
    const {
      readProviderSelectionAuthority,
      replaceProviderAccountSelection,
    } = await import("@/lib/provider-account-assignments");
    const { withSchedulingAttempt } = await import("@/lib/sync/scheduling-attempt");
    const { queueMetaSyncPartition } = await import("@/lib/meta/warehouse");
    const { queueGoogleAdsSyncPartition } = await import("@/lib/google-ads/warehouse");
    const { acquireProviderJobLock } = await import("@/lib/sync/provider-job-lock");
    const { createShopifyInstallContext } = await import("@/lib/shopify/install-context");
    const { upsertSyncGateRecord } = await import("@/lib/sync/release-gates");
    const { upsertSyncIncident } = await import("@/lib/sync/incidents");

    const businesses: Array<{ id: string; label: string }> = [];
    for (const label of ["alpha", "beta"]) {
      const owner = await sourceClient.query<{ id: string }>(
        `INSERT INTO users (name, email, password_hash)
         VALUES ($1, $2, 'unused') RETURNING id::text AS id`,
        [`DR seam ${label}`, `dr-seam-${label}@example.invalid`],
      );
      const business = await sourceClient.query<{ id: string }>(
        `INSERT INTO businesses (name, owner_id) VALUES ($1, $2::uuid)
         RETURNING id::text AS id`,
        [`DR seam ${label}`, owner.rows[0]!.id],
      );
      businesses.push({ id: business.rows[0]!.id, label });
    }

    const attemptIds: string[] = [];
    for (const [index, business] of businesses.entries()) {
      const metaAccounts = [`act_${business.label}_1`, `act_${business.label}_2`];
      const googleAccounts = [`10${index}0000001`, `10${index}0000002`];

      for (const [provider, accounts, access, refresh] of [
        ["meta", metaAccounts, SECRETS.metaAccess, SECRETS.metaRefresh],
        ["google", googleAccounts, SECRETS.googleAccess, SECRETS.googleRefresh],
      ] as const) {
        // The real connection + encrypted credential writer, so the credential
        // in the dump is a real ciphertext and the generation is a real one.
        await upsertIntegration({
          businessId: business.id,
          provider,
          status: "connected",
          providerAccountId: accounts[0],
          providerAccountName: `${provider} ${business.label}`,
          accessToken: `${access}-${business.label}`,
          refreshToken: `${refresh}-${business.label}`,
          tokenExpiresAt: new Date(Date.UTC(2027, 0, 1)),
          scopes: "ads_read",
          metadata: { seam: "dr-restore", business: business.label },
        });
        // A reconnect for one business only, so the restored database has to
        // carry MORE THAN ONE distinct connection generation. A backup that
        // reset every generation to 1 would still match a fixture where every
        // generation was already 1.
        if (business.label === "beta") {
          await upsertIntegration({
            businessId: business.id,
            provider,
            status: "connected",
            providerAccountId: accounts[1],
            providerAccountName: `${provider} ${business.label} reconnected`,
            accessToken: `${access}-${business.label}-regrant`,
            refreshToken: `${refresh}-${business.label}-regrant`,
            tokenExpiresAt: new Date(Date.UTC(2027, 0, 1)),
            scopes: "ads_read",
            metadata: { seam: "dr-restore", regranted: true },
          });
        }

        await writeProviderAccountSnapshot({
          businessId: business.id,
          provider,
          accountsPayload: accounts.map((accountId) => ({
            id: accountId,
            name: `${provider} account ${accountId}`,
            currency: "USD",
            timezone: "UTC",
            isManager: false,
          })),
          refreshFailed: false,
          lastError: null,
          sourceReason: "dr_restore_seam",
          lastSuccessfulRefreshAt: new Date(Date.UTC(2026, 6, 1)),
          refreshFailureStreak: 0,
        });

        // The claim and the fingerprint. `runSnapshotRefresh` stamps these while
        // holding the refresh claim; there is no exported writer that sets them
        // without also calling the provider, so they are written here with the
        // same shapes and asserted for byte-identity after the restore.
        await sourceClient.query(
          `UPDATE provider_account_snapshot_runs
              SET connection_fingerprint = $3,
                  refresh_claim_owner    = $4,
                  refresh_claim_epoch    = $5,
                  refresh_claim_generation = $6
            WHERE business_id = $1 AND provider = $2`,
          [
            business.id,
            provider,
            `fingerprint:${provider}:${business.label}:${index + 3}`,
            `runner-${business.label}-${provider}`,
            String(41 + index),
            `claimgen-${business.label}-${provider}`,
          ],
        );

        const authority = await readProviderSelectionAuthority(business.id, provider);
        const outcome = await replaceProviderAccountSelection({
          businessId: business.id,
          provider,
          // Business alpha selects both accounts, beta only the second: the
          // selection SET has to survive, not just the row count.
          accountIds: business.label === "alpha" ? accounts : [accounts[1]!],
          expectedConnectionGeneration: authority.connectionGeneration,
          expectedSnapshotRevision: authority.snapshotRevision,
        });
        assert(
          outcome.accountIds.length === (business.label === "alpha" ? 2 : 1),
          `fixture: ${provider}/${business.label} selection did not persist (${JSON.stringify(outcome.accountIds)}).`,
        );
      }

      // Scheduling receipts. `scheduling_attempt_id` is the evidence that a
      // specific scheduling operation created this work; a restore that dropped
      // it cannot tell scheduled work from work that was already there.
      const { attemptId } = await withSchedulingAttempt(async () => {
        await queueMetaSyncPartition({
          businessId: business.id,
          providerAccountId: metaAccounts[0]!,
          lane: "core",
          scope: "campaign_daily",
          partitionDate: "2026-07-01",
          status: "queued",
          priority: 100,
          source: "recent",
          attemptCount: 0,
        });
        await queueGoogleAdsSyncPartition({
          businessId: business.id,
          providerAccountId: googleAccounts[0]!,
          lane: "core",
          scope: "campaign_daily",
          partitionDate: "2026-07-01",
          status: "queued",
          priority: 100,
          source: "recent",
          attemptCount: 0,
        });
      });
      attemptIds.push(attemptId);
      // ...and one partition per provider created OUTSIDE any attempt, so the
      // restored database must preserve NULL as well as a value.
      await queueMetaSyncPartition({
        businessId: business.id,
        providerAccountId: metaAccounts[0]!,
        lane: "core",
        scope: "campaign_daily",
        partitionDate: "2026-07-02",
        status: "queued",
        priority: 100,
        source: "recent",
        attemptCount: 0,
      });
      await queueGoogleAdsSyncPartition({
        businessId: business.id,
        providerAccountId: googleAccounts[0]!,
        lane: "core",
        scope: "campaign_daily",
        partitionDate: "2026-07-02",
        status: "queued",
        priority: 100,
        source: "recent",
        attemptCount: 0,
      });

      await acquireProviderJobLock({
        businessId: business.id,
        provider: "meta",
        reportType: "meta_insights",
        dateRangeKey: "2026-07-01:2026-07-07",
        ownerToken: `dr-seam-owner-${business.label}`,
        lockMinutes: 30,
      });

      await upsertSyncIncident({
        buildId: "dr-seam-build",
        environment: "seam",
        providerScope: "meta",
        businessId: business.id,
        resourceScope: `account:${metaAccounts[0]}`,
        faultClass: "provider_outage",
        faultSignature: `dr-seam-${business.label}`,
        status: "detected",
        summary: "DR seam fixture incident",
        evidence: { seam: "dr-restore" },
      });
    }

    // The Shopify install grant: a live shop credential sitting in a claimable
    // table. Losing it loses an install mid-flight.
    await createShopifyInstallContext({
      shopDomain: "dr-seam.myshopify.com",
      shopName: "DR seam shop",
      accessToken: SECRETS.shopifyGrant,
      scopes: "read_orders,read_products",
      metadata: { seam: "dr-restore" },
      preferredBusinessId: businesses[0]!.id,
    });
    await upsertIntegration({
      businessId: businesses[0]!.id,
      provider: "shopify",
      status: "connected",
      providerAccountId: "dr-seam.myshopify.com",
      providerAccountName: "DR seam shop",
      accessToken: SECRETS.shopifyAccess,
      scopes: "read_orders,read_products",
      metadata: { seam: "dr-restore" },
    });

    // Release-gate and admission evidence.
    for (const gateKind of ["deploy_gate", "release_gate"] as const) {
      await upsertSyncGateRecord({
        gateKind,
        gateScope: "release_readiness",
        buildId: "dr-seam-build",
        environment: "seam",
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: `DR seam ${gateKind}`,
        breakGlass: false,
        overrideReason: null,
        evidence: { seam: "dr-restore", provider: "meta" },
        emittedAt: new Date(Date.UTC(2026, 6, 20)).toISOString(),
      });
    }
    // The physical-capacity admission sample the growth fence refuses without.
    await sourceClient.query(
      `INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
       VALUES ('db_host_healthcheck', 'dr-seam-host', now(),
               jsonb_build_object('database', jsonb_build_object('name', $1::text),
                                  'seam', 'dr-restore'))`,
      [SOURCE_DB],
    );

    const sourceCensus = await census(sourceClient);
    for (const table of MUST_BE_POPULATED) {
      assert(
        (sourceCensus[table] ?? 0) > 0,
        `fixture: ${table} is empty, so a restore comparison over it would prove nothing.`,
      );
    }
    const populatedTables = Object.values(sourceCensus).filter((count) => count > 0).length;
    const sourceRowTotal = Object.values(sourceCensus).reduce((a, b) => a + b, 0);
    const generations = await sourceClient.query<{ distinct: string }>(
      `SELECT COUNT(DISTINCT connection_generation)::text AS distinct FROM provider_connections`,
    );
    assert(
      Number(generations.rows[0]!.distinct) > 1,
      `fixture: every provider connection has the same generation, so "generations survived" would be vacuously true.`,
    );

    // Tier-B archives go somewhere separate from the primary artifact, the way
    // production writes them to an independent host.
    const archiveRoot = path.join(tmp, "tier-b-archive");
    fs.mkdirSync(archiveRoot, { recursive: true });

    // Rows in TIER-B tables, so the split is actually exercised. Without these
    // the tier-B path is inert and every assertion below would pass against a
    // backup that never archived anything.
    for (let i = 0; i < 7; i += 1) {
      await sourceClient.query(
        `INSERT INTO meta_config_snapshots
           (business_id, account_id, entity_level, entity_id, payload, snapshot_date, captured_at)
         VALUES ($1, $2, 'campaign', $3, $4::jsonb, DATE '2026-07-01', now())`,
        [businesses[0]!.id, "act_dr_tier_b", `camp_${i}`, JSON.stringify({ objective: "OUTCOME_SALES", i })],
      );
    }
    // Captured BEFORE the backup. Reading them later is wrong: the migration
    // chain backfills config history from meta_config_snapshots the first time
    // it sees an empty table, so a count taken after D7's migration re-run
    // describes a different database than the artifact does.
    const tierBSourceCounts = new Map<string, number>();
    for (const table of [
      "meta_config_snapshots",
      "meta_campaign_config_history",
      "meta_adset_config_history",
      "meta_raw_snapshots",
      "shopify_raw_snapshots",
    ]) {
      const row = await sourceClient.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.${table}`,
      );
      tierBSourceCounts.set(table, Number(row.rows[0]!.n));
    }

    // ── The ACTUAL backup script ─────────────────────────────────────────────
    const backup = spawnSync("bash", [BACKUP_SCRIPT], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        LC_ALL: "C",
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        BACKUP_ROOT: backupRoot,
        DB_NAME: SOURCE_DB,
        BACKUP_DB_HOST: "127.0.0.1",
        BACKUP_DB_PORT: String(sourcePort),
        PGUSER: USER,
        RETENTION_DAYS: "14",
        BACKUP_ARCHIVE_ROOT: archiveRoot,
      },
    });
    const backupOutput = `${backup.stdout ?? ""}${backup.stderr ?? ""}`;
    assert(
      backup.status === 0,
      `D1: ${BACKUP_SCRIPT} exited ${backup.status}.\n${backupOutput.trim()}`,
    );

    const latest = path.join(backupRoot, "latest");
    const manifestText = fs.readFileSync(path.join(latest, "manifest.txt"), "utf8");
    const manifest: Record<string, string> = {};
    for (const line of manifestText.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0) manifest[line.slice(0, eq)] = line.slice(eq + 1);
    }

    // ── D1. The artifact declares, and proves, full-database scope ──────────
    assert(
      manifest.backup_scope === "full_database" && manifest.table_filter === "none",
      `D1: the artifact does not claim full-database scope: scope=${manifest.backup_scope} filter=${manifest.table_filter}`,
    );
    assert(
      manifest.missing_from_dump === "0" && manifest.unexpected_in_dump === "0",
      `D1: the backup's own completeness check did not pass: missing=${manifest.missing_from_dump} unexpected=${manifest.unexpected_in_dump}`,
    );
    // The equality is the real assertion: the live catalog and the dump's own
    // TOC must describe the same set, which is what makes an omission fail.
    //
    // The floor is only a sanity bound against the degenerate case — a backup of
    // a schema-less database would satisfy the equality trivially (0 === 0). It
    // is deliberately NOT the exact table count of any one release: pinning it
    // to that turns every legitimate schema change into a seam failure and
    // teaches the next person to raise the number instead of reading it.
    const SCHEMA_SANITY_FLOOR = 150;
    // Tier-B tables carry their SCHEMA in the primary artifact but their DATA in
    // separate archives, so the primary dump legitimately has fewer TABLE DATA
    // entries than the catalog has tables — by exactly the tier-B count, and by
    // nothing else. Any other difference is an omission.
    const tierBCount = Number(manifest.tier_b_table_count ?? "0");
    assert(
      Number(manifest.catalog_tables) - tierBCount ===
        Number(manifest.dump_table_data_entries) &&
        Number(manifest.catalog_tables) >= SCHEMA_SANITY_FLOOR,
      `D1: catalog tables (${manifest.catalog_tables}) minus tier-B (${tierBCount}) should equal dump TABLE DATA entries (${manifest.dump_table_data_entries}), or the schema is implausibly small (floor ${SCHEMA_SANITY_FLOOR}).`,
    );
    const checksumVerify = spawnSync(
      "bash",
      [
        "-c",
        `cd ${JSON.stringify(latest)} && { command -v sha256sum >/dev/null 2>&1 && sha256sum -c SHA256SUMS || shasum -a 256 -c SHA256SUMS; }`,
      ],
      { encoding: "utf8" },
    );
    assert(
      checksumVerify.status === 0,
      `D1: SHA256SUMS does not verify in place:\n${checksumVerify.stdout ?? ""}${checksumVerify.stderr ?? ""}`,
    );
    console.log(
      `${LABEL} D1 PASS artifact: ${BACKUP_SCRIPT} produced a ${manifest.backup_scope} custom-format dump of ${manifest.catalog_tables} tables ` +
        `(${manifest.dump_bytes} bytes, ${manifest.object_indexes} indexes, ${manifest.object_functions} functions, ${manifest.object_triggers} triggers, ` +
        `${manifest.constraint_foreign_key} foreign keys), its own catalog-vs-TOC completeness check reports 0 missing and 0 unexpected, and SHA256SUMS verifies in place`,
    );

    // ── Restore into a SECOND, empty server ─────────────────────────────────
    target = startServer(bin, tmp, "target", targetPort);
    run(
      path.join(bin, "createdb"),
      ["-h", "127.0.0.1", "-p", String(targetPort), "-U", USER, TARGET_DB],
      "createdb (target)",
    );
    run(
      path.join(bin, "pg_restore"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(targetPort),
        "-U",
        USER,
        "--dbname=" + TARGET_DB,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        path.join(latest, "full-database.dump"),
      ],
      "pg_restore",
    );

    const targetUrl = target.url(TARGET_DB);
    targetClient = new Client({ connectionString: targetUrl });
    await targetClient.connect();

    // ── D2. Same table set ──────────────────────────────────────────────────
    const sourceTables = (await rows(sourceClient, TABLE_SET_SQL)).map((r) => String(r.name));
    const targetTables = (await rows(targetClient, TABLE_SET_SQL)).map((r) => String(r.name));
    const missingTables = sourceTables.filter((t) => !targetTables.includes(t));
    const extraTables = targetTables.filter((t) => !sourceTables.includes(t));
    assert(
      missingTables.length === 0 && extraTables.length === 0,
      `D2: the restored database does not have the source's table set. missing=${JSON.stringify(missingTables)} extra=${JSON.stringify(extraTables)}`,
    );
    console.log(
      `${LABEL} D2 PASS table set: all ${sourceTables.length} tables present in the restored database, 0 missing, 0 unexpected`,
    );

    // ── D3. Exact row counts, every table ───────────────────────────────────
    const targetCensus = await census(targetClient);
    const countMismatches = sourceTables
      .filter((table) => (sourceCensus[table] ?? 0) !== (targetCensus[table] ?? 0))
      .map((table) => `${table}: source=${sourceCensus[table] ?? 0} restored=${targetCensus[table] ?? 0}`);
    assert(
      countMismatches.length === 0,
      `D3: ${countMismatches.length} table(s) restored with a different row count:\n  ${countMismatches.join("\n  ")}`,
    );
    console.log(
      `${LABEL} D3 PASS row counts: exact COUNT(*) matches for all ${sourceTables.length} tables ` +
        `(${populatedTables} of them non-empty, ${sourceRowTotal} rows total), including every table in the ${MUST_BE_POPULATED.length}-table authority set`,
    );

    // ── D4. Every foreign key is satisfiable ────────────────────────────────
    //
    // Re-added NOT VALID and then VALIDATEd, inside a transaction that is rolled
    // back. PostgreSQL scans the child rows against the parent for each one, so
    // this is the database's own referential check over the restored data — not
    // a claim that pg_restore would have complained.
    const foreignKeys = await sourceClient.query<{
      conname: string;
      relname: string;
      def: string;
    }>(
      `SELECT k.conname, c.relname, pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE k.contype = 'f' AND n.nspname = 'public'
       ORDER BY c.relname, k.conname`,
    );
    assert(
      foreignKeys.rows.length > 400,
      `D4: only ${foreignKeys.rows.length} foreign keys found; the catalog query is wrong.`,
    );
    await targetClient.query("BEGIN");
    let validated = 0;
    try {
      for (const fk of foreignKeys.rows) {
        const table = `public."${fk.relname.replace(/"/g, '""')}"`;
        const name = `"${fk.conname.replace(/"/g, '""')}"`;
        await targetClient.query(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
        await targetClient.query(
          `ALTER TABLE ${table} ADD CONSTRAINT ${name} ${fk.def} NOT VALID`,
        );
        await targetClient.query(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
        validated += 1;
      }
    } finally {
      await targetClient.query("ROLLBACK");
    }
    assert(
      validated === foreignKeys.rows.length,
      `D4: only ${validated} of ${foreignKeys.rows.length} foreign keys validated.`,
    );
    console.log(
      `${LABEL} D4 PASS referential integrity: all ${validated} foreign keys re-added NOT VALID and re-VALIDATED against the restored rows by PostgreSQL itself, then rolled back`,
    );

    // ── D5. Authority continuity, byte for byte ─────────────────────────────
    const projectionSummary: string[] = [];
    for (const [name, sql] of Object.entries(AUTHORITY_PROJECTIONS)) {
      const before = await rows(sourceClient, sql);
      const after = await rows(targetClient, sql);
      assert(
        before.length > 0,
        `D5: the ${name} projection is empty in the SOURCE, so comparing it proves nothing.`,
      );
      assert(
        JSON.stringify(before) === JSON.stringify(after),
        `D5: ${name} is not byte-identical after the restore.\nsource=${JSON.stringify(before)}\nrestored=${JSON.stringify(after)}`,
      );
      projectionSummary.push(`${name}(${before.length})`);
    }
    // The receipts specifically: the attempt ids the fixture created must be
    // exactly the ones the restored database carries, and the work created
    // outside an attempt must still be NULL.
    for (const table of ["meta_sync_partitions", "google_ads_sync_partitions"]) {
      const stamped = await targetClient.query<{ id: string; count: string }>(
        `SELECT scheduling_attempt_id::text AS id, COUNT(*)::text AS count
         FROM ${table} WHERE scheduling_attempt_id IS NOT NULL
         GROUP BY 1 ORDER BY 1`,
      );
      assert(
        stamped.rows.length === attemptIds.length &&
          stamped.rows.every((row) => attemptIds.includes(row.id)),
        `D5: ${table} scheduling receipts did not survive: ${JSON.stringify(stamped.rows)} vs ${JSON.stringify(attemptIds)}`,
      );
      const unstamped = await targetClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${table} WHERE scheduling_attempt_id IS NULL`,
      );
      assert(
        Number(unstamped.rows[0]!.count) === businesses.length,
        `D5: ${table} lost the distinction between scheduled and pre-existing work (${unstamped.rows[0]!.count} NULL, expected ${businesses.length}).`,
      );
    }
    console.log(
      `${LABEL} D5 PASS authority continuity: ${projectionSummary.join(", ")} are byte-identical after the restore — ` +
        `${generations.rows[0]!.distinct} distinct connection generations, encrypted credential digests, selection sets, snapshot revisions, ` +
        `claim owners/epochs/generations, connection fingerprints, Shopify grant digests, release-gate fingerprints, ` +
        `and ${attemptIds.length} scheduling attempt ids with pre-existing work still NULL`,
    );

    // ── D6. Sequences ───────────────────────────────────────────────────────
    const sourceSequences = await rows(sourceClient, AUTHORITY_PROJECTIONS.sequences!);
    const targetSequences = await rows(targetClient, AUTHORITY_PROJECTIONS.sequences!);
    assert(
      sourceSequences.length > 0 &&
        JSON.stringify(sourceSequences) === JSON.stringify(targetSequences),
      `D6: sequence positions did not survive.\nsource=${JSON.stringify(sourceSequences)}\nrestored=${JSON.stringify(targetSequences)}`,
    );
    console.log(
      `${LABEL} D6 PASS sequences: ${sourceSequences.length} sequence(s) restored at the same last_value, so the next id is not a collision`,
    );

    // ── D7. The app is ready ────────────────────────────────────────────────
    //
    // Two separate questions, and conflating them would hide a real defect in
    // one of them.
    //
    //   (a) Did the restore reproduce the source's schema EXACTLY? That is the
    //       disaster-recovery property, and it is asserted as an exact set
    //       equality over every column, index, constraint, trigger and function
    //       definition.
    //
    //   (b) Does the application converge on the restored database the same way
    //       it converges on the original? This is NOT "migrations are a no-op":
    //       `lib/migrations.ts` issues
    //       `CREATE INDEX idx_google_ads_raw_snapshots_partition_endpoint` BEFORE
    //       the `ADD COLUMN partition_id/page_index` statements it depends on, and
    //       swallows the resulting failure with `.catch(() => {})`. So a
    //       from-zero database is missing that index until migrations run a
    //       SECOND time — on the original just as much as on a restored copy.
    //       Asserting "no-op" here would fail on a perfectly faithful restore
    //       and would be a bug in this seam, not in the backup. The honest
    //       assertion is that both databases land on the SAME schema.
    const sourceSchema = (await rows(sourceClient, SCHEMA_FINGERPRINT_SQL)).map((r) =>
      String(r.entry),
    );
    const restoredSchema = (await rows(targetClient, SCHEMA_FINGERPRINT_SQL)).map((r) =>
      String(r.entry),
    );
    const schemaOnlyInSource = sourceSchema.filter((e) => !restoredSchema.includes(e));
    const schemaOnlyInRestored = restoredSchema.filter((e) => !sourceSchema.includes(e));
    assert(
      schemaOnlyInSource.length === 0 && schemaOnlyInRestored.length === 0,
      `D7: the restored schema differs from the source.\nmissing=${JSON.stringify(schemaOnlyInSource.slice(0, 10))}\nextra=${JSON.stringify(schemaOnlyInRestored.slice(0, 10))}`,
    );

    await runRealMigrations(targetUrl, "migrations against the restored database");
    await runRealMigrations(sourceUrl, "migrations against the source database");
    const sourceConverged = (await rows(sourceClient, SCHEMA_FINGERPRINT_SQL)).map((r) =>
      String(r.entry),
    );
    const restoredConverged = (await rows(targetClient, SCHEMA_FINGERPRINT_SQL)).map((r) =>
      String(r.entry),
    );
    const convergeOnlyInSource = sourceConverged.filter(
      (e) => !restoredConverged.includes(e),
    );
    const convergeOnlyInRestored = restoredConverged.filter(
      (e) => !sourceConverged.includes(e),
    );
    assert(
      convergeOnlyInSource.length === 0 && convergeOnlyInRestored.length === 0,
      `D7: the restored database and the original converge on DIFFERENT schemas under the same migrations.\nonly_in_source=${JSON.stringify(convergeOnlyInSource.slice(0, 10))}\nonly_in_restored=${JSON.stringify(convergeOnlyInRestored.slice(0, 10))}`,
    );
    const lateObjects = restoredConverged.filter((e) => !restoredSchema.includes(e));

    process.env.DATABASE_URL = targetUrl;
    process.env.DATABASE_URL_UNPOOLED = targetUrl;
    resetDbClientCache();
    const { verifyMigrationSchemaContract } = await import("@/lib/migration-verification");
    const verification = await verifyMigrationSchemaContract();
    assert(
      verification.verified > 0,
      `D7: the schema contract verified 0 objects against the restored database.`,
    );
    console.log(
      `${LABEL} D7 PASS app readiness: the restored schema is set-identical to the source over all ${sourceSchema.length} column/index/constraint/trigger/function definitions; ` +
        `a real \`runMigrations\` against the restored database exits 0 and lands on exactly the same schema as the same run against the original ` +
        `(${lateObjects.length} object(s) added on both${
          lateObjects.length > 0
            ? `: ${lateObjects.map((entry) => entry.split(":")[1]).join(", ")} — created late on the ORIGINAL as well, so it is a migration-ordering defect and not a restore defect`
            : ""
        }); ` +
        `and verifyMigrationSchemaContract passes ${verification.verified} checks against the restored database`,
    );

    // ── D8. No credential was printed or written ────────────────────────────
    const inspectable = fs
      .readdirSync(latest)
      .filter((file) => file !== "full-database.dump");
    const leaked: string[] = [];
    for (const [name, secret] of Object.entries(SECRETS)) {
      if (backupOutput.includes(secret)) leaked.push(`${name} in backup stdout/stderr`);
      for (const file of inspectable) {
        const content = fs.readFileSync(path.join(latest, file), "utf8");
        if (content.includes(secret)) leaked.push(`${name} in ${file}`);
      }
    }
    assert(
      leaked.length === 0,
      `D8: the backup exposed credential material: ${leaked.join(", ")}`,
    );
    console.log(
      `${LABEL} D8 PASS secret hygiene: none of the ${Object.keys(SECRETS).length} fixture credentials appear in the backup's stdout/stderr or in any of the ${inspectable.length} readable artifact files (manifest, census, TOC, checksums, schema)`,
    );

    // ── D9. The tier split, end to end ──────────────────────────────────────
    //
    // The primary artifact carries tier-B SCHEMA but not tier-B ROWS, so a
    // tier-A restore must yield those tables present-and-empty. Then each
    // archive must replay into it and land the exact source count. If the
    // archive silently truncated, this is the assertion that catches it.
    const tierBTables = (manifest.tier_b_tables ?? "").split(",").filter(Boolean);
    assert(
      tierBTables.length > 0 && Number(manifest.tier_b_rows_total) > 0,
      `D9: the backup archived no tier-B rows (tables=${tierBTables.length} rows=${manifest.tier_b_rows_total}); the split is inert and proves nothing.`,
    );

    for (const table of tierBTables) {
      const beforeReplay = await targetClient!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.${table}`,
      );
      assert(
        Number(beforeReplay.rows[0]!.n) === 0,
        `D9: ${table} already holds ${beforeReplay.rows[0]!.n} row(s) in the tier-A restore; tier-B data must not be in the primary artifact.`,
      );
    }

    // The archive manifest is the contract a replay is validated against.
    const archiveManifest = fs
      .readFileSync(path.join(archiveRoot, manifest.tier_b_archive_dir!.split("/").pop()!, "tier-b-manifest.tsv"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split("\t"));
    const archiveByTable = new Map(
      archiveManifest.map((cols) => [cols[0]!, { rows: cols[1]!, bytes: cols[2]!, digest: cols[3]! }]),
    );
    assert(
      archiveByTable.size === tierBTables.length,
      `D9: archive manifest lists ${archiveByTable.size} table(s), the policy declares ${tierBTables.length}.`,
    );
    for (const table of tierBTables) {
      const entry = archiveByTable.get(table);
      assert(entry, `D9: no archive manifest entry for ${table}.`);
      const { rows, bytes, digest } = entry!;
      const file = path.join(archiveRoot, manifest.tier_b_archive_dir!.split("/").pop()!, `${table}.dump`);
      assert(fs.existsSync(file), `D9: archive for ${table} is missing at ${file}.`);
      const actualBytes = fs.statSync(file).size;
      assert(
        String(actualBytes) === bytes,
        `D9: ${table} archive is ${actualBytes}B, the manifest records ${bytes}B — a truncated archive would restore silently short.`,
      );
      const actualDigest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      assert(
        actualDigest === digest,
        `D9: ${table} archive digest ${actualDigest} does not match the manifest ${digest}.`,
      );
      assert(
        Number(rows) === tierBSourceCounts.get(table),
        `D9: ${table} archive records ${rows} rows, the source holds ${tierBSourceCounts.get(table)}.`,
      );

      // Replay it, exactly as the documented restore order says.
      const replay = spawnSync(
        path.join(bin, "pg_restore"),
        ["-h", "127.0.0.1", "-p", String(targetPort), "-U", USER, "--dbname=" + TARGET_DB,
         "--data-only", "--no-owner", "--no-privileges", "--exit-on-error", file],
        { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
      );
      assert(
        replay.status === 0,
        `D9: replaying ${table} failed (${replay.status}): ${(replay.stderr ?? "").slice(0, 400)}`,
      );
      const afterReplay = await targetClient!.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.${table}`,
      );
      assert(
        Number(afterReplay.rows[0]!.n) === tierBSourceCounts.get(table),
        `D9: after replay ${table} holds ${afterReplay.rows[0]!.n}, the source holds ${tierBSourceCounts.get(table)}.`,
      );
    }
    console.log(
      `${LABEL} D9 PASS tier split: ${tierBTables.length} tier-B table(s) carrying ${manifest.tier_b_rows_total} row(s) are SCHEMA-present and ROW-empty after the tier-A restore, every archive matches the manifest on bytes, sha256 and row count, and replaying each one lands the exact source count`,
    );

    console.log(`${LABEL} PASS`);
  } catch (error) {
    for (const server of [source, target]) {
      if (server && fs.existsSync(server.logFile)) {
        console.error(
          `${LABEL} ${path.basename(server.logFile)} tail:\n${fs
            .readFileSync(server.logFile, "utf8")
            .split(/\r?\n/)
            .slice(-25)
            .join("\n")}`,
        );
      }
    }
    throw error;
  } finally {
    await sourceClient?.end().catch(() => undefined);
    await targetClient?.end().catch(() => undefined);
    for (const server of [source, target]) {
      if (!server) continue;
      spawnSync(path.join(bin, "pg_ctl"), ["-D", server.dataDir, "-m", "immediate", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...savedEnv };
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
