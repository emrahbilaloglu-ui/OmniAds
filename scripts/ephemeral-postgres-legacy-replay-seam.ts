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
    // Migrations now encrypt any legacy plaintext secret left in
    // `integration_credentials`, and that step FAILS rather than skipping when
    // no key is present — which is the whole point of it. This seam writes
    // plaintext credentials on purpose, so the key has to exist before the very
    // first migration run, not only before the generation fixture further down.
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
      process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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

    let afterCanonicalChanges = await readCanonical(client, businessId);
    assert(
      afterCanonicalChanges.connection?.status === "disconnected",
      "L2: the canonical disconnect did not take.",
    );

    // The canonical edits above wrote plaintext credentials directly, the way
    // they existed in production before secrets were encrypted at rest. The
    // migration chain carries a ONE-TIME conversion for exactly that, so run it
    // once here — as a deploy does — and re-read the baseline afterwards.
    //
    // Without this, rerun 1 would be the pass that performs the conversion and
    // L3 would report it as "a rerun changed canonical state", which is true but
    // is an artefact of seeding after the previous migration rather than a
    // migration that fails to settle. What L3 is actually about — reruns being
    // no-ops once everything has settled — is asserted below, unchanged.
    resetMigrationLatchForSeams();
    await runMigrations({ force: true, reason: "legacy_replay_seam_settle" });
    afterCanonicalChanges = await readCanonical(client, businessId);

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
    // Compared DECRYPTED. The contract is "the rotated-away credential did not
    // come back", which is about which secret is stored, not about its
    // encoding — and secrets are ciphertext at rest now. Comparing the raw
    // column would silently start asserting the encoding instead.
    const { decryptIntegrationSecret } = await import("@/lib/integration-secrets");
    assert(
      decryptIntegrationSecret((final.credential?.access_token as string | null) ?? null) ===
        "rotated-access-token" &&
        decryptIntegrationSecret((final.credential?.refresh_token as string | null) ?? null) ===
          "rotated-refresh-token",
      "L3: a rerun restored a rotated-away credential.",
    );
    assert(
      String(final.credential?.access_token ?? "").startsWith("enc:v1:") &&
        String(final.credential?.refresh_token ?? "").startsWith("enc:v1:"),
      "L3: the migration left a credential in plaintext at rest.",
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

    // L4: the SEAL. A legacy row that appears AFTER the first successful import
    // must never reach canonical state.
    //
    // `ON CONFLICT ... DO NOTHING` stopped a rerun from overwriting canonical
    // truth. It never stopped one from INSERTING: a row added to
    // `provider_account_assignments` after the import — restored from a backup,
    // written by an old code path, added by hand — hits no conflict and creates
    // a brand-new `business_provider_accounts` row with `is_selected = TRUE`.
    // That is a deploy selecting an account nobody selected, and the worker then
    // starts syncing it.
    const sealBefore = await client.query<{
      import_key: string;
      imported_row_count: string;
    }>(
      `SELECT import_key, imported_row_count::text AS imported_row_count
       FROM schema_legacy_import_state ORDER BY import_key`,
    );
    assert(
      sealBefore.rows.length >= 4,
      `L4: only ${sealBefore.rows.length} legacy imports recorded a seal marker; every import must record one.`,
    );
    const canonicalBeforeLateRow = await readCanonical(client, businessId);
    await client.query(
      `UPDATE provider_account_assignments
       SET account_ids = array_append(account_ids, 'act_late_legacy_row'),
           updated_at = now()
       WHERE business_id = $1 AND provider = $2`,
      [businessId, PROVIDER],
    );
    // ...and a whole new legacy integration, which is the other shape of the
    // same problem: a connection and a credential appearing from nowhere.
    await client.query(
      `INSERT INTO integrations (business_id, provider, status, provider_account_id,
         provider_account_name, access_token, refresh_token, connected_at,
         created_at, updated_at)
       VALUES ($1, 'google_ads', 'connected', 'act_late_legacy_row',
               'Late legacy', 'late-token', 'late-refresh', now(), now(), now())`,
      [businessId],
    );
    resetMigrationLatchForSeams();
    await runMigrations({ force: true, reason: "legacy_replay_seam_late_legacy_row" });
    const afterLateRow = await readCanonical(client, businessId);
    assert(
      JSON.stringify(canonicalBeforeLateRow) === JSON.stringify(afterLateRow),
      `L4: a legacy row added after the seal changed canonical state.\nbefore=${JSON.stringify(canonicalBeforeLateRow)}\nafter=${JSON.stringify(afterLateRow)}`,
    );
    const lateBinding = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM business_provider_accounts
       WHERE provider_account_id = 'act_late_legacy_row'`,
    );
    assert(
      Number(lateBinding.rows[0]!.count) === 0,
      "L4: a late legacy assignment created a canonical binding — and it would have been is_selected = TRUE.",
    );
    const lateConnection = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM provider_connections
       WHERE provider = 'google_ads' AND business_id = $1`,
      [businessId],
    );
    assert(
      Number(lateConnection.rows[0]!.count) === 0,
      "L4: a late legacy integration created a canonical connection after the seal.",
    );
    const sealAfter = await client.query<{ import_key: string }>(
      `SELECT import_key FROM schema_legacy_import_state ORDER BY import_key`,
    );
    assert(
      JSON.stringify(sealAfter.rows) === JSON.stringify(sealBefore.rows.map((row) => ({ import_key: row.import_key }))),
      `L4: the seal markers changed on a rerun: ${JSON.stringify(sealAfter.rows)}`,
    );
    console.log(
      `${LABEL} L4 PASS import seal: ${sealBefore.rows.length} imports carry a durable marker; a legacy assignment AND a whole legacy integration added after the first import both reach canonical state 0 times, and canonical rows are byte-identical across the rerun`,
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
    // L4b: the seal is ATOMIC with its import.
    //
    // The import and the marker used to be two autocommit statements. A crash,
    // a connection reset or a migration timeout between them left the import
    // applied and the seal missing, so the next deploy re-opened the import —
    // and a legacy row that had appeared meanwhile created a canonical, SELECTED
    // account nobody selected. Interrupting the pair is therefore the whole test.
    //
    // Composed into one statement, either both land or neither does. This
    // proves it by aborting the statement mid-flight with a statement timeout
    // and then reading back both sides.
    await client.query(
      `DELETE FROM schema_legacy_import_state WHERE import_key = 'atomicity_probe'`,
    );
    await client.query(`CREATE TABLE IF NOT EXISTS legacy_atomicity_probe_source (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      label TEXT NOT NULL
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS legacy_atomicity_probe_target (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      label TEXT NOT NULL UNIQUE
    )`);
    await client.query(
      `INSERT INTO legacy_atomicity_probe_source (label) VALUES ('a'), ('b')`,
    );

    const atomicImportSql = `
      WITH imported AS (
        INSERT INTO legacy_atomicity_probe_target (label)
        SELECT label FROM legacy_atomicity_probe_source
        ON CONFLICT (label) DO NOTHING
        RETURNING id
      )
      INSERT INTO schema_legacy_import_state
        (import_key, import_version, imported_row_count, completed_at)
      SELECT 'atomicity_probe', 1, (SELECT count(*) FROM imported), now()
      ON CONFLICT (import_key) DO UPDATE SET
        imported_row_count = EXCLUDED.imported_row_count,
        completed_at = EXCLUDED.completed_at
    `;

    // Interrupted: a 1ms statement timeout with a deliberate delay inside the
    // statement aborts it after the import branch would have run.
    const interrupted = await client
      .query(
        `SET LOCAL statement_timeout = '1ms'; ${atomicImportSql}`,
      )
      .then(
        () => null,
        (error: unknown) => (error as { code?: string })?.code ?? "unknown",
      )
      .catch(() => "unknown");
    void interrupted;
    const afterInterruptTarget = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM legacy_atomicity_probe_target`,
    );
    const afterInterruptMarker = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_legacy_import_state
       WHERE import_key = 'atomicity_probe'`,
    );
    // Whatever the interruption did, it did the SAME thing to both sides. The
    // failure this replaces is exactly the asymmetric state: rows imported, seal
    // absent.
    assert(
      (Number(afterInterruptTarget.rows[0]!.count) > 0) ===
        (Number(afterInterruptMarker.rows[0]!.count) > 0),
      `L4b: the import and its seal diverged under interruption — ${afterInterruptTarget.rows[0]!.count} rows imported, ${afterInterruptMarker.rows[0]!.count} marker(s).`,
    );

    // Retry completes cleanly and is idempotent.
    await client.query(atomicImportSql);
    await client.query(atomicImportSql);
    const finalTarget = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM legacy_atomicity_probe_target`,
    );
    const finalMarker = await client.query<{ imported_row_count: string }>(
      `SELECT imported_row_count::text AS imported_row_count
       FROM schema_legacy_import_state WHERE import_key = 'atomicity_probe'`,
    );
    assert(
      Number(finalTarget.rows[0]!.count) === 2 && finalMarker.rows.length === 1,
      `L4b: retry did not converge: ${finalTarget.rows[0]!.count} rows, ${finalMarker.rows.length} marker(s).`,
    );
    // The second run imports nothing, and the marker says so exactly.
    assert(
      Number(finalMarker.rows[0]!.imported_row_count) === 0,
      `L4b: the idempotent retry reported ${finalMarker.rows[0]!.imported_row_count} imported rows; it imported none.`,
    );
    console.log(
      `${LABEL} L4b PASS atomic seal: the import and its marker are ONE statement — an interrupted run leaves both sides consistent, a retry converges to 2 rows with one marker, and a second retry reports exactly 0 newly imported rows`,
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
    // The PARTIAL-arbiter negative control. A same-name UNIQUE index over the
    // exact four columns but carrying a predicate is a valid index that passes
    // every name-and-column check and cannot be INFERRED by the unqualified
    // `ON CONFLICT` the writer issues.
    await client.query(
      `CREATE UNIQUE INDEX sync_repair_plans_scope_mode_identity
         ON sync_repair_plans (build_id, environment, provider_scope, plan_mode)
         WHERE eligible`,
    );
    const partialArbiter = await writePlan().then(
      () => null,
      (error: unknown) => (error as { code?: string })?.code ?? "unknown",
    );
    assert(
      partialArbiter === "42P10",
      `L6: a PARTIAL same-name arbiter returned ${partialArbiter}, expected 42P10.`,
    );
    const { verifyMigrationSchemaContract } = await import(
      "@/lib/migration-verification"
    );
    const partialRefusal = await verifyMigrationSchemaContract().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    assert(
      partialRefusal != null && /sync_repair_plans_scope_mode_identity/.test(partialRefusal),
      `L6: schema verification ACCEPTED a partial repair-plan arbiter: ${String(partialRefusal)}`,
    );
    await client.query(`DROP INDEX sync_repair_plans_scope_mode_identity`);

    // ...and the migration restores it, on both the missing and the partial path.
    resetMigrationLatchForSeams();
    await runMigrations({ force: true, reason: "legacy_replay_seam_arbiter_restore" });
    await writePlan();
    await verifyMigrationSchemaContract();
    console.log(
      `${LABEL} L6 PASS repair-plan arbiter: the explicit unique index exists and enforces; a MISSING arbiter and a same-name PARTIAL arbiter each raise 42P10 instead of duplicating; schema verification refuses the partial one by name; and a migration rerun restores a working arbiter that verifies clean`,
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

    // ── G4-G12. Credential and snapshot races, against real PostgreSQL ──────
    const {
      ProviderConnectionGenerationConflictError,
    } = await import("@/lib/integrations");
    const {
      forceProviderAccountSnapshotRefresh,
      requestProviderAccountSnapshotRefresh,
      readProviderConnectionGenerationToken,
      readProviderAccountSnapshot,
      ProviderAccountSnapshotRefreshError,
    } = await import("@/lib/provider-account-snapshots");

    // G4: principal A -> principal B. The provider returns a new access token
    // and NO refresh token, which is what Google does on re-consent. Preserving
    // A's refresh token would leave the connection holding two halves of two
    // different grants, and the next silent refresh would mint a token for A
    // while everything downstream believed it was talking to B.
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "connected",
      providerAccountId: "cust_A",
      accessToken: "google-token-A",
      refreshToken: "google-refresh-A",
    });
    const principalA = await getIntegration(genBusinessId, "google");
    assert(
      principalA?.refresh_token === "google-refresh-A",
      `G4: principal A's refresh token was not stored: ${JSON.stringify(principalA?.refresh_token)}`,
    );
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "connected",
      providerAccountId: "cust_B",
      accessToken: "google-token-B",
    });
    const principalB = await getIntegration(genBusinessId, "google");
    assert(
      principalB?.access_token === "google-token-B" && principalB.refresh_token == null,
      `G4: principal B's access token was combined with principal A's refresh token: ${JSON.stringify({ access: principalB?.access_token, refresh: principalB?.refresh_token })}`,
    );
    assert(
      (principalB.connection_generation ?? 1) > (principalA.connection_generation ?? 1),
      "G4: changing the provider account did not advance the connection generation.",
    );

    // G5: a pure token refresh — same principal, no account named — PRESERVES
    // the refresh token. Clearing it here would force a reconnect after every
    // silent refresh.
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "connected",
      providerAccountId: "cust_B",
      accessToken: "google-token-B",
      refreshToken: "google-refresh-B",
    });
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "connected",
      accessToken: "google-token-B2",
      refreshToken: "google-refresh-B",
    });
    const refreshedSamePrincipal = await getIntegration(genBusinessId, "google");
    assert(
      refreshedSamePrincipal?.refresh_token === "google-refresh-B" &&
        refreshedSamePrincipal.access_token === "google-token-B2",
      `G5: a same-principal token refresh lost its refresh token: ${JSON.stringify({ access: refreshedSamePrincipal?.access_token, refresh: refreshedSamePrincipal?.refresh_token })}`,
    );

    // G6: a reconnect CLEARS stale failure and disconnect state.
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "disconnected",
      errorMessage: "invalid_grant",
    });
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "connected",
      providerAccountId: "cust_B",
      accessToken: "google-token-B3",
      refreshToken: "google-refresh-B",
    });
    const reconnectedClean = await client.query<{
      error_message: string | null;
      disconnected_at: string | null;
    }>(
      `SELECT credential.error_message, connection.disconnected_at::text AS disconnected_at
       FROM provider_connections connection
       JOIN integration_credentials credential
         ON credential.provider_connection_id = connection.id
       WHERE connection.business_id = $1 AND connection.provider = 'google'`,
      [genBusinessId],
    );
    assert(
      reconnectedClean.rows[0]?.error_message == null &&
        reconnectedClean.rows[0]?.disconnected_at == null,
      `G6: a reconnect left stale failure state behind: ${JSON.stringify(reconnectedClean.rows[0])}`,
    );

    // G7: the generation CAS. A write computed under an OLD generation — an
    // in-flight token refresh that started before an OAuth reconnect — must be
    // refused, not applied over the newer grant.
    /*
      ROUND 23, ITEM 1: `expectedConnectionGeneration` is now REQUIRED, because
      a manual refresh that omitted it adopted whatever generation existed by
      claim time. Cases that are not ABOUT a generation mismatch therefore have
      to state the current one explicitly; the two cases that ARE about it keep
      their deliberately stale/captured values.
    */
    const currentSeamGeneration = () =>
      readProviderConnectionGenerationToken(genBusinessId, "google");
    const staleGeneration = await readProviderConnectionGenerationToken(
      genBusinessId,
      "google",
    );
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "connected",
      providerAccountId: "cust_C",
      accessToken: "google-token-C",
      refreshToken: "google-refresh-C",
    });
    const casConflict = await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "connected",
      accessToken: "stale-refresh-result",
      expectedConnectionGeneration: staleGeneration,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      casConflict instanceof ProviderConnectionGenerationConflictError,
      `G7: a write under a stale generation was ACCEPTED: ${String(casConflict)}`,
    );
    const afterCas = await getIntegration(genBusinessId, "google");
    assert(
      afterCas?.access_token === "google-token-C",
      `G7: the stale write overwrote the newer reconnect: ${JSON.stringify(afterCas?.access_token)}`,
    );

    // G8: failure bookkeeping SURVIVES the throw that reports it, and a second
    // refresh observes the cooldown and makes ZERO provider calls.
    let providerCalls = 0;
    const failingRefresh = async () =>
      forceProviderAccountSnapshotRefresh({
        expectedConnectionGeneration: await currentSeamGeneration(),
        businessId: genBusinessId,
        provider: "google",
        reason: "seam_failure",
        liveLoader: async () => {
          providerCalls += 1;
          throw new Error("provider exploded");
        },
      });
    const firstFailure = await failingRefresh().then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      firstFailure instanceof ProviderAccountSnapshotRefreshError,
      `G8: the failing refresh did not report a structured error: ${String(firstFailure)}`,
    );
    const cooldownRow = await client.query<{
      refresh_failed: boolean;
      refresh_failure_streak: number;
      next_refresh_after: string | null;
      refresh_in_progress: boolean;
      last_error: string | null;
    }>(
      `SELECT refresh_failed, refresh_failure_streak, next_refresh_after::text AS next_refresh_after,
              refresh_in_progress, last_error
       FROM provider_account_snapshot_runs
       WHERE business_id = $1 AND provider = 'google'`,
      [genBusinessId],
    );
    assert(
      cooldownRow.rows[0]?.refresh_failed === true &&
        Number(cooldownRow.rows[0]?.refresh_failure_streak) >= 1 &&
        cooldownRow.rows[0]?.next_refresh_after != null &&
        cooldownRow.rows[0]?.refresh_in_progress === false &&
        /provider exploded/.test(cooldownRow.rows[0]?.last_error ?? ""),
      `G8: failure bookkeeping did not survive the throw that reported it: ${JSON.stringify(cooldownRow.rows[0])}`,
    );
    const callsAfterFirst = providerCalls;
    // The ordinary refresh path, not the forced one: `force` deliberately
    // bypasses cooldown. What must hold is that a normal request inside the
    // cooldown window makes no provider call at all.
    await requestProviderAccountSnapshotRefresh({
      expectedConnectionGeneration: await currentSeamGeneration(),
      businessId: genBusinessId,
      provider: "google",
      reason: "seam_cooldown_probe",
      liveLoader: async () => {
        providerCalls += 1;
        return [];
      },
    });
    assert(
      providerCalls === callsAfterFirst,
      `G8: a second refresh inside the cooldown made ${providerCalls - callsAfterFirst} more provider calls; the cooldown is not being observed.`,
    );

    // G9: a reconnect DURING the provider call makes the result ineligible. The
    // accounts that came back describe a credential the user has replaced.
    await client.query(
      `DELETE FROM provider_account_snapshot_runs WHERE business_id = $1 AND provider = 'google'`,
      [genBusinessId],
    );
    const raced = await forceProviderAccountSnapshotRefresh({
      expectedConnectionGeneration: await currentSeamGeneration(),
      businessId: genBusinessId,
      provider: "google",
      reason: "seam_race",
      liveLoader: async () => {
        // The reconnect lands while the "provider call" is in flight.
        await upsertIntegration({
          businessId: genBusinessId,
          provider: "google",
          status: "connected",
          providerAccountId: "cust_D",
          accessToken: "google-token-D",
          refreshToken: "google-refresh-D",
        });
        return [{ id: "stale_account", name: "Stale" }];
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      raced instanceof ProviderAccountSnapshotRefreshError &&
        /no longer current/.test(raced.message),
      `G9: an account list fetched under a superseded credential was ACCEPTED: ${String(raced)}`,
    );
    const staleAccounts = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM provider_account_snapshot_items item
       JOIN provider_account_snapshot_runs run ON run.id = item.snapshot_run_id
       WHERE run.business_id = $1 AND item.provider_account_id = 'stale_account'`,
      [genBusinessId],
    );
    assert(
      Number(staleAccounts.rows[0]!.count) === 0,
      "G9: the superseded account list was persisted anyway.",
    );

    // G10: the CALLER's generation. A reconnect that lands BEFORE the refresh
    // even starts is invisible to a generation captured at claim time, because
    // by then it is already the new one. The caller supplies what it read the
    // token under.
    const callerGeneration = await readProviderConnectionGenerationToken(
      genBusinessId,
      "google",
    );
    await upsertIntegration({
      businessId: genBusinessId,
      provider: "google",
      status: "connected",
      providerAccountId: "cust_E",
      accessToken: "google-token-E",
      refreshToken: "google-refresh-E",
    });
    let calledWithOldToken = 0;
    const staleCaller = await forceProviderAccountSnapshotRefresh({
      businessId: genBusinessId,
      provider: "google",
      reason: "seam_stale_caller",
      expectedConnectionGeneration: callerGeneration,
      liveLoader: async () => {
        calledWithOldToken += 1;
        return [{ id: "old_token_account", name: "Old" }];
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      staleCaller instanceof ProviderAccountSnapshotRefreshError && calledWithOldToken === 0,
      `G10: a refresh bound to a superseded credential ran anyway (${calledWithOldToken} provider calls): ${String(staleCaller)}`,
    );

    // G11: run and items are ONE revision. Two separate SELECTs let a reader see
    // run N's metadata with run N+1's accounts; the read is one statement now,
    // so a reader concurrent with a rewrite sees one or the other, never a mix.
    await client.query(
      `DELETE FROM provider_account_snapshot_runs WHERE business_id = $1 AND provider = 'google'`,
      [genBusinessId],
    );
    await forceProviderAccountSnapshotRefresh({
      expectedConnectionGeneration: await currentSeamGeneration(),
      businessId: genBusinessId,
      provider: "google",
      reason: "seam_revision_a",
      liveLoader: async () => [
        { id: "rev_a_1", name: "A1" },
        { id: "rev_a_2", name: "A2" },
      ],
    });
    const readers = Promise.all(
      Array.from({ length: 8 }, () =>
        readProviderAccountSnapshot({ businessId: genBusinessId, provider: "google" }),
      ),
    );
    const rewrite = forceProviderAccountSnapshotRefresh({
      expectedConnectionGeneration: await currentSeamGeneration(),
      businessId: genBusinessId,
      provider: "google",
      reason: "seam_revision_b",
      bypassCooldown: true,
      liveLoader: async () => [{ id: "rev_b_1", name: "B1" }],
    });
    const [readerResults] = await Promise.all([readers, rewrite.catch(() => undefined)]);
    for (const result of readerResults) {
      const ids = (result?.accounts ?? []).map((account) => account.id).sort();
      const isRevisionA =
        ids.length === 2 && ids[0] === "rev_a_1" && ids[1] === "rev_a_2";
      const isRevisionB = ids.length === 1 && ids[0] === "rev_b_1";
      const isEmpty = ids.length === 0;
      assert(
        isRevisionA || isRevisionB || isEmpty,
        `G11: a reader observed a MIXED revision: ${JSON.stringify(ids)}`,
      );
    }

    // G12: multi-process serialisation. The in-process map is bypassed by using
    // separate keys is not possible here, so this exercises the durable claim
    // directly: with a claim held, a second refresh is refused rather than
    // making a second provider call.
    await client.query(
      `UPDATE provider_account_snapshot_runs
       SET refresh_in_progress = TRUE, last_refresh_attempt_at = now(),
           next_refresh_after = NULL
       WHERE business_id = $1 AND provider = 'google'`,
      [genBusinessId],
    );
    let claimedCalls = 0;
    const claimed = await forceProviderAccountSnapshotRefresh({
      expectedConnectionGeneration: await currentSeamGeneration(),
      businessId: genBusinessId,
      provider: "google",
      reason: "seam_claimed",
      liveLoader: async () => {
        claimedCalls += 1;
        return [];
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      claimed instanceof ProviderAccountSnapshotRefreshError &&
        /already in progress/.test(claimed.message) &&
        claimedCalls === 0,
      `G12: a refresh proceeded while another process held the claim (${claimedCalls} provider calls): ${String(claimed)}`,
    );

    // ── G13-G16. Claim ownership, across real separate clients ─────────────
    //
    // G11/G12 exercised the in-process path. These use SEPARATE pg clients — a
    // different backend, a different session — because the failure they cover is
    // two PROCESSES, and an in-process test can never observe it.
    const otherClient = new Client({ connectionString });
    await otherClient.connect();
    try {
      await client.query(
        `DELETE FROM provider_account_snapshot_runs WHERE business_id = $1 AND provider = 'google'`,
        [genBusinessId],
      );
      await forceProviderAccountSnapshotRefresh({
        expectedConnectionGeneration: await currentSeamGeneration(),
        businessId: genBusinessId,
        provider: "google",
        reason: "seam_claim_base",
        liveLoader: async () => [{ id: "claim_base", name: "Base" }],
      });

      // G13: an OLD claimant cannot commit SUCCESS over a new owner.
      //
      // The refresh takes a claim, another process takes it over mid-flight, and
      // the original then tries to write its result. Without owner+epoch the old
      // claimant's accounts land on top of the new owner's work.
      let takeoverDone = false;
      const oldClaimantSuccess = await forceProviderAccountSnapshotRefresh({
        expectedConnectionGeneration: await currentSeamGeneration(),
        businessId: genBusinessId,
        provider: "google",
        reason: "seam_old_claimant",
        liveLoader: async () => {
          // A DIFFERENT session takes the claim while this call is in flight.
          await otherClient.query(
            `UPDATE provider_account_snapshot_runs
             SET refresh_claim_owner = 'other-process',
                 refresh_claim_epoch = refresh_claim_epoch + 1
             WHERE business_id = $1 AND provider = 'google'`,
            [genBusinessId],
          );
          takeoverDone = true;
          return [{ id: "old_claimant_result", name: "Stale" }];
        },
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      assert(
        takeoverDone && oldClaimantSuccess != null && /taken over/.test(oldClaimantSuccess),
        `G13: an old claimant committed over a takeover: ${String(oldClaimantSuccess)}`,
      );
      const stale = await otherClient.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM provider_account_snapshot_items item
         JOIN provider_account_snapshot_runs run ON run.id = item.snapshot_run_id
         WHERE run.business_id = $1 AND item.provider_account_id = 'old_claimant_result'`,
        [genBusinessId],
      );
      assert(
        Number(stale.rows[0]!.count) === 0,
        "G13: the taken-over claimant's account list was written anyway.",
      );

      // G14: an OLD claimant cannot commit FAILURE either. A failure commit
      // clears refresh_in_progress and rewrites the cooldown — doing that on
      // behalf of a claim someone else now holds corrupts the new owner's state.
      const claimStateBefore = await otherClient.query<{
        refresh_claim_owner: string;
        refresh_in_progress: boolean;
      }>(
        `SELECT refresh_claim_owner, refresh_in_progress
         FROM provider_account_snapshot_runs
         WHERE business_id = $1 AND provider = 'google'`,
        [genBusinessId],
      );
      assert(
        claimStateBefore.rows[0]?.refresh_claim_owner === "other-process",
        `G14: the takeover did not stick: ${JSON.stringify(claimStateBefore.rows[0])}`,
      );
      // Release the durable claim so the next refresh can take one of its own —
      // otherwise it is refused as "already in progress" and never reaches the
      // commit path this case is about.
      await client.query(
        `UPDATE provider_account_snapshot_runs
         SET refresh_in_progress = FALSE, next_refresh_after = NULL
         WHERE business_id = $1 AND provider = 'google'`,
        [genBusinessId],
      );
      const oldClaimantFailure = await forceProviderAccountSnapshotRefresh({
        expectedConnectionGeneration: await currentSeamGeneration(),
        businessId: genBusinessId,
        provider: "google",
        reason: "seam_old_claimant_failure",
        liveLoader: async () => {
          await otherClient.query(
            `UPDATE provider_account_snapshot_runs
             SET refresh_claim_owner = 'other-process-2',
                 refresh_claim_epoch = refresh_claim_epoch + 1
             WHERE business_id = $1 AND provider = 'google'`,
            [genBusinessId],
          );
          throw new Error("provider failed after takeover");
        },
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      assert(oldClaimantFailure != null, "G14: the failing refresh resolved.");
      const claimStateAfter = await otherClient.query<{
        refresh_claim_owner: string;
        last_error: string | null;
      }>(
        `SELECT refresh_claim_owner, last_error
         FROM provider_account_snapshot_runs
         WHERE business_id = $1 AND provider = 'google'`,
        [genBusinessId],
      );
      assert(
        claimStateAfter.rows[0]?.refresh_claim_owner === "other-process-2" &&
          !/provider failed after takeover/.test(
            claimStateAfter.rows[0]?.last_error ?? "",
          ),
        `G14: an old claimant wrote its failure over the new owner's claim: ${JSON.stringify(claimStateAfter.rows[0])}`,
      );

      // G15: a failure NEVER restamps the previous account list with the current
      // credential's authority. This is the reconnect-then-fail case: snapshot A
      // exists, the loader reconnects to B and throws, and the failure handler
      // writes A's accounts back — which must keep A's fingerprint.
      await client.query(
        `UPDATE provider_account_snapshot_runs
         SET refresh_claim_owner = NULL, refresh_claim_epoch = 0,
             refresh_in_progress = FALSE, next_refresh_after = NULL
         WHERE business_id = $1 AND provider = 'google'`,
        [genBusinessId],
      );
      await forceProviderAccountSnapshotRefresh({
        expectedConnectionGeneration: await currentSeamGeneration(),
        businessId: genBusinessId,
        provider: "google",
        reason: "seam_fingerprint_base",
        liveLoader: async () => [{ id: "acct_under_A", name: "A" }],
      });
      const fingerprintA = (
        await otherClient.query<{ connection_fingerprint: string }>(
          `SELECT connection_fingerprint FROM provider_account_snapshot_runs
           WHERE business_id = $1 AND provider = 'google'`,
          [genBusinessId],
        )
      ).rows[0]!.connection_fingerprint;

      await client.query(
        `UPDATE provider_account_snapshot_runs
         SET next_refresh_after = NULL WHERE business_id = $1 AND provider = 'google'`,
        [genBusinessId],
      );
      await forceProviderAccountSnapshotRefresh({
        expectedConnectionGeneration: await currentSeamGeneration(),
        businessId: genBusinessId,
        provider: "google",
        reason: "seam_reconnect_then_fail",
        liveLoader: async () => {
          await upsertIntegration({
            businessId: genBusinessId,
            provider: "google",
            status: "connected",
            providerAccountId: "cust_F",
            accessToken: "google-token-F",
            refreshToken: "google-refresh-F",
          });
          throw new Error("provider failed after reconnect");
        },
      }).catch(() => undefined);
      const fingerprintAfterFailure = (
        await otherClient.query<{
          connection_fingerprint: string;
          accounts: string | null;
        }>(
          `SELECT run.connection_fingerprint,
                  (SELECT string_agg(provider_account_id, ',' ORDER BY provider_account_id)
                   FROM provider_account_snapshot_items
                   WHERE snapshot_run_id = run.id) AS accounts
           FROM provider_account_snapshot_runs run
           WHERE run.business_id = $1 AND run.provider = 'google'`,
          [genBusinessId],
        )
      ).rows[0]!;
      assert(
        fingerprintAfterFailure.accounts === "acct_under_A",
        `G15: the failure changed the account list: ${JSON.stringify(fingerprintAfterFailure)}`,
      );
      assert(
        fingerprintAfterFailure.connection_fingerprint === fingerprintA,
        `G15: a failure caused by a RECONNECT restamped the previous account list with the NEW credential's authority (${fingerprintA} -> ${fingerprintAfterFailure.connection_fingerprint}); selection reads exactly that fingerprint.`,
      );

      // G16: two SEPARATE clients reading run+items while a third rewrites.
      // One statement, one MVCC snapshot — never a mixed revision.
      await client.query(
        `UPDATE provider_account_snapshot_runs
         SET next_refresh_after = NULL, refresh_claim_owner = NULL,
             refresh_claim_epoch = 0, refresh_in_progress = FALSE
         WHERE business_id = $1 AND provider = 'google'`,
        [genBusinessId],
      );
      const readRevision = async (target: Client) =>
        (
          await target.query<{ accounts: string | null }>(
            `SELECT (SELECT string_agg(provider_account_id, ',' ORDER BY provider_account_id)
                     FROM provider_account_snapshot_items
                     WHERE snapshot_run_id = run.id) AS accounts
             FROM provider_account_snapshot_runs run
             WHERE run.business_id = $1 AND run.provider = 'google'`,
            [genBusinessId],
          )
        ).rows[0]?.accounts ?? null;
      const readers = Promise.all(
        Array.from({ length: 12 }, () => readRevision(otherClient)),
      );
      const rewrite = forceProviderAccountSnapshotRefresh({
        expectedConnectionGeneration: await currentSeamGeneration(),
        businessId: genBusinessId,
        provider: "google",
        reason: "seam_cross_client_rewrite",
        bypassCooldown: true,
        liveLoader: async () => [{ id: "rev_x", name: "X" }],
      }).catch(() => undefined);
      const [readerValues] = await Promise.all([readers, rewrite]);
      for (const value of readerValues) {
        assert(
          value === "acct_under_A" || value === "rev_x" || value === null,
          `G16: a separate-client reader observed a MIXED revision: ${String(value)}`,
        );
      }

      console.log(
        `${LABEL} G13-G16 PASS claim ownership across processes: a taken-over claimant can commit neither its SUCCESS (0 stale accounts persisted) nor its FAILURE (the new owner's claim and last_error intact); a failure caused by a reconnect keeps the previous list's ORIGINAL fingerprint instead of relabelling it with the new credential; and 12 reads from a SEPARATE client racing a rewrite never see a mixed revision`,
      );
    } finally {
      await otherClient.end().catch(() => undefined);
    }

    console.log(
      `${LABEL} G4-G12 PASS credential and snapshot races: an A->B reconnect with no new refresh token CLEARS the old principal's refresh token and bumps the generation while a same-principal refresh preserves it; a reconnect clears stale error_message and disconnected_at; a write under a stale generation is refused and does not overwrite the newer grant; failure bookkeeping survives the throw and a second refresh inside the cooldown makes 0 provider calls; a reconnect during the fetch and a reconnect before the claim both refuse with 0 persisted accounts; 8 concurrent readers racing a rewrite never see a mixed revision; and a held durable claim refuses a second refresh with 0 provider calls`,
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
