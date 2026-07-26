/**
 * L1-L5 — legacy import replay safety, against a real PostgreSQL.
 *
 * Migrations rerun on every deploy. The legacy import steps used `ON CONFLICT
 * ... DO UPDATE`, so every rerun replayed whatever the legacy tables still held
 * over whatever canonical truth had happened since:
 *
 *   - a disconnect was undone, because `status = EXCLUDED.status`;
 *   - a rotated credential was put back, because the token columns were
 *     COALESCEd from the legacy row;
 *   - a refreshed snapshot's health was overwritten with the stale one;
 *   - and a DESELECTED account came back, because
 *     `is_selected = existing OR EXCLUDED.is_selected` can only ever turn
 *     selection ON.
 *
 * Production does not currently have these legacy tables, so none of this is a
 * live incident — but the durability contract is what a future upgrade relies
 * on, and it was false. This seam creates the legacy tables, performs a first
 * import, then makes canonical changes that CONTRADICT the legacy rows, reruns
 * the full migration chain repeatedly, and proves every canonical row and every
 * secret is byte-identical afterwards.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "legacy_replay_seam";
const USER = "postgres";
const LABEL = "[legacy-replay-seam]";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`legacy replay seam FAILED: ${message}`);
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

const BUSINESS_NAME = "Legacy replay seam";
const PROVIDER = "meta";
const KEPT_ACCOUNT = "act_kept";
const DESELECTED_ACCOUNT = "act_deselected";

/**
 * The legacy tables, in the shape the import statements read.
 *
 * Created AFTER the first migration run so the canonical schema exists, then
 * populated before the reruns — which is exactly the order an upgrading
 * deployment would present them in.
 */
async function createLegacyTables(client: Client, businessId: string) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS integrations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_account_id TEXT,
      provider_account_name TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TIMESTAMPTZ,
      scopes TEXT,
      error_message TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      connected_at TIMESTAMPTZ,
      disconnected_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, provider)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_account_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, provider)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS provider_account_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      accounts_payload JSONB NOT NULL DEFAULT '[]'::jsonb,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      refresh_failed BOOLEAN NOT NULL DEFAULT FALSE,
      last_error TEXT,
      refresh_requested_at TIMESTAMPTZ,
      last_refresh_attempt_at TIMESTAMPTZ,
      next_refresh_after TIMESTAMPTZ,
      refresh_in_progress BOOLEAN NOT NULL DEFAULT FALSE,
      accounts_hash TEXT,
      source_reason TEXT,
      last_successful_refresh_at TIMESTAMPTZ,
      refresh_failure_streak INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, provider)
    )
  `);

  await client.query(
    `INSERT INTO integrations (business_id, provider, status, provider_account_id,
       provider_account_name, access_token, refresh_token, scopes, metadata, connected_at)
     VALUES ($1, $2, 'connected', $3, 'Kept account', 'legacy-access-token',
             'legacy-refresh-token', 'ads_read', '{"legacy":true}'::jsonb, now())
     ON CONFLICT (business_id, provider) DO NOTHING`,
    [businessId, PROVIDER, KEPT_ACCOUNT],
  );
  await client.query(
    `INSERT INTO provider_account_assignments (business_id, provider, account_ids)
     VALUES ($1, $2, ARRAY[$3, $4]::TEXT[])
     ON CONFLICT (business_id, provider) DO NOTHING`,
    [businessId, PROVIDER, KEPT_ACCOUNT, DESELECTED_ACCOUNT],
  );
  await client.query(
    `INSERT INTO provider_account_snapshots (business_id, provider, accounts_payload,
       refresh_failed, last_error, refresh_failure_streak, accounts_hash, source_reason)
     VALUES ($1, $2, $3::jsonb, FALSE, NULL, 0, 'legacy-hash', 'legacy_seed')
     ON CONFLICT (business_id, provider) DO NOTHING`,
    [
      businessId,
      PROVIDER,
      JSON.stringify([
        { id: KEPT_ACCOUNT, name: "Kept account" },
        { id: DESELECTED_ACCOUNT, name: "Deselected account" },
      ]),
    ],
  );
}

interface CanonicalFingerprint {
  connection: Record<string, unknown> | undefined;
  credential: Record<string, unknown> | undefined;
  bindings: Array<Record<string, unknown>>;
  snapshotRun: Record<string, unknown> | undefined;
}

async function readCanonical(
  client: Client,
  businessId: string,
): Promise<CanonicalFingerprint> {
  const connection = await client.query(
    `SELECT status, provider_account_id, connected_at::text, disconnected_at::text,
            updated_at::text
     FROM provider_connections WHERE business_id = $1 AND provider = $2`,
    [businessId, PROVIDER],
  );
  const credential = await client.query(
    `SELECT c.access_token, c.refresh_token, c.scopes, c.updated_at::text
     FROM integration_credentials c
     JOIN provider_connections pc ON pc.id = c.provider_connection_id
     WHERE pc.business_id = $1 AND pc.provider = $2`,
    [businessId, PROVIDER],
  );
  const bindings = await client.query(
    `SELECT provider_account_id, is_selected, position, updated_at::text
     FROM business_provider_accounts
     WHERE business_id = $1 AND provider = $2
     ORDER BY provider_account_id`,
    [businessId, PROVIDER],
  );
  const snapshotRun = await client.query(
    `SELECT refresh_failed, last_error, refresh_failure_streak, accounts_hash,
            source_reason, fetched_at::text, updated_at::text
     FROM provider_account_snapshot_runs WHERE business_id = $1 AND provider = $2`,
    [businessId, PROVIDER],
  );
  return {
    connection: connection.rows[0],
    credential: credential.rows[0],
    bindings: bindings.rows,
    snapshotRun: snapshotRun.rows[0],
  };
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-legacy-replay-"));
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
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED = "enabled";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations, resetMigrationLatchForSeams } = await import(
      "@/lib/migrations"
    );
    await runMigrations({ force: true, reason: "legacy_replay_seam_initial" });

    client = new Client({ connectionString });
    await client.connect();

    const owner = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Legacy replay', 'legacy-replay@example.invalid', 'unused')
       RETURNING id::text AS id`,
    );
    const business = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id) VALUES ($1, $2::uuid)
       RETURNING id::text AS id`,
      [BUSINESS_NAME, owner.rows[0]!.id],
    );
    const businessId = business.rows[0]!.id;

    // L1: legacy tables exist and are imported once.
    await createLegacyTables(client, businessId);
    resetMigrationLatchForSeams();
    await runMigrations({ force: true, reason: "legacy_replay_seam_import" });

    const imported = await readCanonical(client, businessId);
    assert(
      imported.connection != null && imported.credential != null,
      `L1: the legacy import produced no canonical connection or credential: ${JSON.stringify(imported)}`,
    );
    assert(
      imported.bindings.length === 2 &&
        imported.bindings.every((row) => row.is_selected === true),
      `L1: the legacy import did not select both assigned accounts: ${JSON.stringify(imported.bindings)}`,
    );
    console.log(
      `${LABEL} L1 PASS first import: ${imported.bindings.length} bindings, a connection and a credential seeded from the legacy tables`,
    );

    // L2: make canonical changes that CONTRADICT the legacy rows. Each of these
    // is a real user action a rerun must not undo.
    await client.query(
      `UPDATE provider_connections
       SET status = 'disconnected', disconnected_at = now(), updated_at = now()
       WHERE business_id = $1 AND provider = $2`,
      [businessId, PROVIDER],
    );
    await client.query(
      `UPDATE integration_credentials c
       SET access_token = 'rotated-access-token',
           refresh_token = 'rotated-refresh-token',
           scopes = 'ads_read,ads_management',
           updated_at = now()
       FROM provider_connections pc
       WHERE pc.id = c.provider_connection_id
         AND pc.business_id = $1 AND pc.provider = $2`,
      [businessId, PROVIDER],
    );
    await client.query(
      `UPDATE business_provider_accounts
       SET is_selected = FALSE, updated_at = now()
       WHERE business_id = $1 AND provider = $2 AND provider_account_id = $3`,
      [businessId, PROVIDER, DESELECTED_ACCOUNT],
    );
    await client.query(
      `UPDATE provider_account_snapshot_runs
       SET refresh_failed = TRUE, last_error = 'provider auth revoked',
           refresh_failure_streak = 3, accounts_hash = 'refreshed-hash',
           source_reason = 'canonical_refresh', updated_at = now()
       WHERE business_id = $1 AND provider = $2`,
      [businessId, PROVIDER],
    );

    const afterCanonicalChanges = await readCanonical(client, businessId);
    assert(
      afterCanonicalChanges.connection?.status === "disconnected",
      "L2: the canonical disconnect did not take.",
    );

    // L3: rerun the FULL migration chain repeatedly. The legacy tables still say
    // connected, still list the deselected account, still hold the old token and
    // the healthy snapshot.
    for (let rerun = 1; rerun <= 3; rerun += 1) {
      resetMigrationLatchForSeams();
      await runMigrations({ force: true, reason: `legacy_replay_seam_rerun_${rerun}` });
      const after = await readCanonical(client, businessId);
      assert(
        JSON.stringify(after) === JSON.stringify(afterCanonicalChanges),
        `L3: migration rerun ${rerun} changed canonical state.\nbefore=${JSON.stringify(afterCanonicalChanges)}\nafter=${JSON.stringify(after)}`,
      );
    }

    // Spelled out individually, so a future regression names the exact contract
    // it broke rather than only "the JSON differs".
    const final = await readCanonical(client, businessId);
    assert(
      final.connection?.status === "disconnected",
      "L3: a rerun reconnected a canonically disconnected integration.",
    );
    assert(
      final.credential?.access_token === "rotated-access-token" &&
        final.credential?.refresh_token === "rotated-refresh-token",
      "L3: a rerun restored a rotated-away credential.",
    );
    const deselected = final.bindings.find(
      (row) => row.provider_account_id === DESELECTED_ACCOUNT,
    );
    assert(
      deselected?.is_selected === false,
      "L3: a rerun reselected a canonically deselected account — the OR TRUE reselection class.",
    );
    const kept = final.bindings.find(
      (row) => row.provider_account_id === KEPT_ACCOUNT,
    );
    assert(kept?.is_selected === true, "L3: a rerun deselected a kept account.");
    assert(
      final.snapshotRun?.refresh_failed === true &&
        final.snapshotRun?.accounts_hash === "refreshed-hash",
      "L3: a rerun replayed stale snapshot health over a canonical refresh.",
    );
    console.log(
      `${LABEL} L2-L3 PASS replay safety: after a disconnect, a credential rotation, a deselection and a snapshot refresh, 3 full migration reruns left every canonical row and both secrets byte-identical`,
    );

    // L4: a legacy row for an account canonical state has never seen is still
    // imported, because the contract is insert-missing-only rather than
    // do-nothing-ever.
    await client.query(
      `UPDATE provider_account_assignments
       SET account_ids = array_append(account_ids, 'act_new_from_legacy'),
           updated_at = now()
       WHERE business_id = $1 AND provider = $2`,
      [businessId, PROVIDER],
    );
    resetMigrationLatchForSeams();
    await runMigrations({ force: true, reason: "legacy_replay_seam_new_account" });
    const withNew = await readCanonical(client, businessId);
    const added = withNew.bindings.find(
      (row) => row.provider_account_id === "act_new_from_legacy",
    );
    assert(
      added != null,
      `L4: a genuinely new legacy account was not imported, so the import is not insert-missing-only: ${JSON.stringify(withNew.bindings)}`,
    );
    assert(
      withNew.bindings.find((row) => row.provider_account_id === DESELECTED_ACCOUNT)
        ?.is_selected === false,
      "L4: importing a new account reselected the deselected one.",
    );
    console.log(
      `${LABEL} L4 PASS insert-missing-only: a genuinely new legacy account is still imported, and importing it does not disturb existing canonical selection`,
    );

    // L5: with the legacy tables gone — which is production's actual state —
    // reruns remain no-ops.
    await client.query(`DROP TABLE integrations`);
    await client.query(`DROP TABLE provider_account_assignments`);
    await client.query(`DROP TABLE provider_account_snapshots`);
    const beforeDropRerun = await readCanonical(client, businessId);
    resetMigrationLatchForSeams();
    await runMigrations({ force: true, reason: "legacy_replay_seam_no_legacy" });
    const afterDropRerun = await readCanonical(client, businessId);
    assert(
      JSON.stringify(beforeDropRerun) === JSON.stringify(afterDropRerun),
      "L5: a rerun without the legacy tables still changed canonical state.",
    );
    console.log(
      `${LABEL} L5 PASS absent legacy tables: with all three dropped — production's actual state — a full rerun changes nothing`,
    );

    // L6: the repair-plan ON CONFLICT arbiter, and the 42P10 it causes when it
    // is missing. `persistSyncRepairPlan` writes with ON CONFLICT over
    // (build_id, environment, provider_scope, plan_mode); the only thing that
    // used to provide it was an inline UNIQUE whose auto-generated name is
    // truncated, so a DROP naming the untruncated form matched nothing and the
    // arbiter survived by accident.
    const arbiter = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_class WHERE relname = 'sync_repair_plans_scope_mode_identity'`,
    );
    assert(
      Number(arbiter.rows[0]!.count) === 1,
      "L6: the explicit repair-plan arbiter index does not exist.",
    );
    const planClient = client;
    const writePlan = async () =>
      planClient.query(
        `INSERT INTO sync_repair_plans (build_id, environment, provider_scope,
           plan_mode, eligible, summary, payload_json, emitted_at, updated_at)
         VALUES ('b','production','meta','dry_run', TRUE, 's', '{}'::jsonb, now(), now())
         ON CONFLICT (build_id, environment, provider_scope, plan_mode)
         DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()`,
      );
    await writePlan();
    await writePlan();
    const planCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sync_repair_plans WHERE build_id = 'b'`,
    );
    assert(
      Number(planCount.rows[0]!.count) === 1,
      `L6: two writes with the same key produced ${planCount.rows[0]!.count} rows; the arbiter is not enforcing.`,
    );

    // Negative control: with the arbiter gone the write must fail loudly with
    // 42P10 rather than silently inserting duplicates.
    await client.query(`DROP INDEX sync_repair_plans_scope_mode_identity`);
    const missingArbiter = await writePlan().then(
      () => null,
      (error: unknown) => (error as { code?: string })?.code ?? "unknown",
    );
    assert(
      missingArbiter === "42P10",
      `L6: with the arbiter dropped the write returned ${missingArbiter}, expected 42P10.`,
    );
    // ...and the migration restores it.
    resetMigrationLatchForSeams();
    await runMigrations({ force: true, reason: "legacy_replay_seam_arbiter_restore" });
    await writePlan();
    console.log(
      `${LABEL} L6 PASS repair-plan arbiter: the explicit unique index exists and enforces, a missing arbiter raises 42P10 instead of duplicating, and a migration rerun restores it`,
    );

    // G1-G3: connection generation. A reconnect used to be invisible —
    // connected_at is COALESCEd to the ORIGINAL value and an OAuth re-grant
    // often returns the same token bytes — so a discovery snapshot captured
    // under the old credential kept validating across a disconnect and a
    // reconnect by a different user.
    const { upsertIntegration, getIntegration } = await import("@/lib/integrations");
    const { computeProviderConnectionFingerprint } = await import(
      "@/lib/provider-connection-fingerprint"
    );
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const genBusiness = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id) VALUES ('Generation seam', $1::uuid)
       RETURNING id::text AS id`,
      [owner.rows[0]!.id],
    );
    const genBusinessId = genBusiness.rows[0]!.id;

    await upsertIntegration({
      businessId: genBusinessId,
      provider: "meta",
      status: "connected",
      providerAccountId: "act_gen",
      providerAccountName: "Generation",
      accessToken: "token-A",
    });
    const first = await getIntegration(genBusinessId, "meta");
    assert(first != null, "G1: no integration after the first connect.");
    const firstFingerprint = computeProviderConnectionFingerprint(first);

    // Disconnect, then reconnect with the SAME token bytes. This is the exact
    // case the fingerprint used to miss.
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "meta",
      status: "disconnected",
    });
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "meta",
      status: "connected",
      providerAccountId: "act_gen",
      providerAccountName: "Generation",
      accessToken: "token-A",
    });
    const reconnected = await getIntegration(genBusinessId, "meta");
    assert(reconnected != null, "G1: no integration after reconnect.");
    assert(
      (reconnected.connection_generation ?? 1) >
        (first.connection_generation ?? 1),
      `G1: a reconnect did not advance the connection generation (${first.connection_generation} -> ${reconnected.connection_generation}).`,
    );
    assert(
      computeProviderConnectionFingerprint(reconnected) !== firstFingerprint,
      "G1: a disconnect-reconnect cycle with unchanged token bytes produced an identical fingerprint, so evidence from the old connection would still validate.",
    );

    // G2: a rotation with different bytes also advances it.
    const beforeRotation = reconnected.connection_generation ?? 1;
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "meta",
      status: "connected",
      providerAccountId: "act_gen",
      accessToken: "token-B",
    });
    const rotated = await getIntegration(genBusinessId, "meta");
    assert(
      (rotated?.connection_generation ?? 1) > beforeRotation,
      "G2: a credential rotation did not advance the connection generation.",
    );

    // G3: no mixed generation is observable. The connection and its credential
    // commit together, so the account and the token always belong to the same
    // generation.
    const mixed = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM provider_connections pc
       LEFT JOIN integration_credentials ic ON ic.provider_connection_id = pc.id
       WHERE pc.business_id = $1 AND ic.provider_connection_id IS NULL`,
      [genBusinessId],
    );
    assert(
      Number(mixed.rows[0]!.count) === 0,
      "G3: a connection exists with no credential row, so the two did not commit together.",
    );
    console.log(
      `${LABEL} G1-G3 PASS connection generation: a disconnect-reconnect with UNCHANGED token bytes advances the generation and changes the fingerprint, a rotation advances it again, and no connection exists without its credential`,
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
    await client?.end().catch(() => undefined);
    if (started) {
      spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (previousDatabaseUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
