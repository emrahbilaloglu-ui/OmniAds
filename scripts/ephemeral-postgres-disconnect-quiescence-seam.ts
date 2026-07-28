/**
 * D1-D6 — integration disconnect teardown, against a real PostgreSQL.
 *
 * `disconnectIntegration` used to run three statements that each committed on
 * their own: mark the connection disconnected, then null the credentials. Every
 * property that made that dangerous is decided by the database, not by the
 * code, so a mocked `sql` tag proved none of it — and the one existing test
 * mocks `getDb` to return `[]` for every statement, under which a disconnect
 * that does nothing at all still passes.
 *
 * What is proven here against a real server:
 *
 *   D1 the teardown is ATOMIC — a failure after the credential wipe must leave
 *      the connection still 'connected' WITH its token, never 'disconnected'
 *      with a live token behind it, which no retry path could ever reach;
 *   D2 the generation is BUMPED, so an in-flight writer holding the old token
 *      is refused by compare-and-set rather than by inference from the status
 *      suffix;
 *   D3 the credentials are actually gone;
 *   D4 selection is cleared, so a reconnect as a different principal cannot
 *      inherit the previous principal's still-selected account ids;
 *   D5 a running sync job is failed closed in the same commit, so it cannot
 *      renew its lease and keep ingesting rows after the user was told the
 *      integration was disconnected;
 *   D6 a second disconnect is harmless.
 *
 * D1 in particular is unmockable: it is a transaction rollback.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "disconnect_quiescence_seam";
const USER = "postgres";
const LABEL = "[disconnect-quiescence-seam]";
const PROVIDER = "meta" as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`disconnect quiescence seam FAILED: ${message}`);
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

interface ConnectionFacts {
  status: string;
  generation: string;
  accessToken: string | null;
  refreshToken: string | null;
  selectedAccounts: string[];
  runningJobs: number;
}

async function readFacts(client: Client, businessId: string): Promise<ConnectionFacts> {
  const connection = await client.query<{
    status: string;
    connection_generation: string;
  }>(
    `SELECT status, connection_generation::text AS connection_generation
     FROM provider_connections WHERE business_id = $1 AND provider = $2`,
    [businessId, PROVIDER],
  );
  const credentials = await client.query<{
    access_token: string | null;
    refresh_token: string | null;
  }>(
    `SELECT ic.access_token, ic.refresh_token
     FROM integration_credentials ic
     JOIN provider_connections pc ON pc.id = ic.provider_connection_id
     WHERE pc.business_id = $1 AND pc.provider = $2`,
    [businessId, PROVIDER],
  );
  const selected = await client.query<{ provider_account_id: string }>(
    `SELECT provider_account_id FROM business_provider_accounts
     WHERE business_id = $1 AND provider = $2 AND is_selected
     ORDER BY provider_account_id`,
    [businessId, PROVIDER],
  );
  const running = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM provider_sync_jobs
     WHERE business_id = $1 AND provider = $2 AND status = 'running'`,
    [businessId, PROVIDER],
  );
  return {
    status: connection.rows[0]!.status,
    generation: connection.rows[0]!.connection_generation,
    accessToken: credentials.rows[0]?.access_token ?? null,
    refreshToken: credentials.rows[0]?.refresh_token ?? null,
    selectedAccounts: selected.rows.map((row) => row.provider_account_id),
    runningJobs: Number(running.rows[0]!.count),
  };
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-disconnect-quiescence-"));
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
    process.env.DB_QUERY_TIMEOUT_MS = "20000";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "disconnect_quiescence_seam" });

    const { disconnectIntegration } = await import("@/lib/integrations");

    client = new Client({ connectionString });
    await client.connect();

    async function seed(label: string) {
      const owner = await client!.query<{ id: string }>(
        `INSERT INTO users (name, email, password_hash)
         VALUES ('Disconnect seam', $1, 'unused') RETURNING id::text AS id`,
        [`disconnect-${label}@example.invalid`],
      );
      const business = await client!.query<{ id: string }>(
        `INSERT INTO businesses (name, owner_id) VALUES ($1, $2::uuid)
         RETURNING id::text AS id`,
        [`Disconnect seam ${label}`, owner.rows[0]!.id],
      );
      const businessId = business.rows[0]!.id;
      const connection = await client!.query<{ id: string }>(
        `INSERT INTO provider_connections (business_id, provider, status, connected_at)
         VALUES ($1, $2, 'connected', now()) RETURNING id::text AS id`,
        [businessId, PROVIDER],
      );
      const connectionId = connection.rows[0]!.id;
      await client!.query(
        `INSERT INTO integration_credentials (provider_connection_id, access_token, refresh_token)
         VALUES ($1::uuid, 'live-access-token', 'live-refresh-token')`,
        [connectionId],
      );
      const account = await client!.query<{ id: string }>(
        `INSERT INTO provider_accounts (provider, external_account_id, account_name)
         VALUES ($1, $2, 'Disconnect seam')
         ON CONFLICT (provider, external_account_id) DO UPDATE SET account_name = EXCLUDED.account_name
         RETURNING id::text AS id`,
        [PROVIDER, `act_${label}`],
      );
      await client!.query(
        `INSERT INTO business_provider_accounts
           (business_id, provider, provider_account_ref_id, provider_account_id, is_selected, position)
         VALUES ($1, $2, $3::uuid, $4, TRUE, 0)`,
        [businessId, PROVIDER, account.rows[0]!.id, `act_${label}`],
      );
      await client!.query(
        `INSERT INTO provider_sync_jobs
           (business_id, provider, report_type, date_range_key, status, lock_owner, lock_expires_at)
         VALUES ($1, $2, 'insights', 'last_30d', 'running', 'worker-1', now() + interval '10 minutes')`,
        [businessId, PROVIDER],
      );
      return businessId;
    }

    // ---- D1: atomicity ---------------------------------------------------
    // A trigger makes the LAST statement of the teardown fail. If the teardown
    // is one transaction the whole thing rolls back; if it is three autocommits
    // the earlier ones have already landed and the row is left 'disconnected'
    // with a live token.
    const atomicBusiness = await seed("atomic");
    await client.query(`
      CREATE FUNCTION fail_sync_job_update() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`
      CREATE TRIGGER fail_disconnect_quiescence
      BEFORE UPDATE ON provider_sync_jobs
      FOR EACH ROW EXECUTE FUNCTION fail_sync_job_update();
    `);

    let threw = false;
    try {
      await disconnectIntegration(atomicBusiness, PROVIDER);
    } catch {
      threw = true;
    }
    assert(threw, "D1: the injected failure did not surface to the caller");

    const afterFailure = await readFacts(client, atomicBusiness);
    assert(
      afterFailure.status === "connected",
      `D1: teardown was not atomic — status is '${afterFailure.status}' after a failed disconnect`,
    );
    assert(
      afterFailure.accessToken === "live-access-token",
      "D1: teardown was not atomic — credentials were wiped by a transaction that failed",
    );
    console.log(`${LABEL} D1 OK — a failed disconnect rolls back completely`);

    await client.query(`DROP TRIGGER fail_disconnect_quiescence ON provider_sync_jobs`);
    await client.query(`DROP FUNCTION fail_sync_job_update()`);

    // ---- D2-D5: the successful teardown ----------------------------------
    const businessId = await seed("happy");
    const before = await readFacts(client, businessId);
    assert(before.status === "connected", "seed did not start connected");
    assert(before.runningJobs === 1, "seed did not start with a running job");

    await disconnectIntegration(businessId, PROVIDER);
    const after = await readFacts(client, businessId);

    assert(after.status === "disconnected", "D2: status was not set to disconnected");
    assert(
      Number(after.generation) === Number(before.generation) + 1,
      `D2: connection_generation was not bumped (${before.generation} -> ${after.generation}); ` +
        "an in-flight writer would then have to infer revocation from the status suffix alone",
    );
    console.log(`${LABEL} D2 OK — generation bumped ${before.generation} -> ${after.generation}`);

    assert(after.accessToken === null, "D3: access_token survived the disconnect");
    assert(after.refreshToken === null, "D3: refresh_token survived the disconnect");
    console.log(`${LABEL} D3 OK — credentials cleared`);

    assert(
      after.selectedAccounts.length === 0,
      `D4: selection survived (${after.selectedAccounts.join(", ")}); a reconnect as a ` +
        "different principal would inherit the previous principal's selected accounts",
    );
    console.log(`${LABEL} D4 OK — selection cleared`);

    assert(
      after.runningJobs === 0,
      "D5: a running sync job survived, so it could renew its lease and keep ingesting " +
        "rows for a provider the user has disconnected",
    );
    console.log(`${LABEL} D5 OK — in-flight sync job failed closed`);

    // ---- D6: idempotency -------------------------------------------------
    await disconnectIntegration(businessId, PROVIDER);
    const afterSecond = await readFacts(client, businessId);
    assert(afterSecond.status === "disconnected", "D6: second disconnect changed the status");
    assert(afterSecond.accessToken === null, "D6: second disconnect resurrected a credential");
    console.log(`${LABEL} D6 OK — repeated disconnect is harmless`);

    console.log(`${LABEL} PASS — D1-D6`);
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
