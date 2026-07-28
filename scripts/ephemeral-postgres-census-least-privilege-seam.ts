/**
 * P1-P7 — the growth census under a least-privilege role, against real PostgreSQL.
 *
 * Production runs as `adsecute_app`, a NON-superuser — the DR seam asserts
 * exactly that. Nothing in this repository proves it holds `pg_monitor`, and
 * `pg_ls_waldir()` requires `pg_monitor` or superuser.
 *
 * The first version of this census put `pg_database_size()` and
 * `pg_ls_waldir()` in ONE statement with no catch. Under a role without
 * `pg_monitor` that statement raises 42501, the whole call throws, and the
 * process exits before printing the database size or a single relation — so the
 * tool reports NOTHING precisely on the database it was written to measure.
 *
 * A mock cannot show this: whether a function is denied is decided by
 * PostgreSQL's own privilege system. So this seam creates a real unprivileged
 * role, connects as that role, and drives the real query functions.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "census_least_privilege_seam";
const SUPERUSER = "postgres";
/** Deliberately mirrors production's role name. */
const APP_ROLE = "adsecute_app";
const LABEL = "[census-least-privilege-seam]";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`census least-privilege seam FAILED: ${message}`);
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

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-census-least-priv-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let started = false;
  let admin: Client | null = null;

  try {
    run(
      path.join(bin, "initdb"),
      ["-D", dataDir, "-U", SUPERUSER, "--auth=trust", "--no-locale"],
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
      ["-h", "127.0.0.1", "-p", String(port), "-U", SUPERUSER, DB],
      "createdb",
    );

    const superuserUrl = `postgresql://${SUPERUSER}@127.0.0.1:${port}/${DB}`;
    admin = new Client({ connectionString: superuserUrl });
    await admin.connect();

    // A plain LOGIN role: no SUPERUSER, and deliberately NOT granted pg_monitor.
    await admin.query(`CREATE ROLE ${APP_ROLE} LOGIN`);
    await admin.query(`GRANT CONNECT ON DATABASE ${DB} TO ${APP_ROLE}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await admin.query(`CREATE TABLE public.census_probe (id int PRIMARY KEY, payload text)`);
    await admin.query(
      `INSERT INTO public.census_probe SELECT g, repeat('x', 200) FROM generate_series(1, 500) g`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await admin.query(`ANALYZE public.census_probe`);

    // ---- P1: the premise — pg_ls_waldir IS denied to this role -----------
    const denied = new Client({
      connectionString: `postgresql://${APP_ROLE}@127.0.0.1:${port}/${DB}`,
    });
    await denied.connect();
    const walError = await denied
      .query(`SELECT COALESCE(SUM(size), 0) FROM pg_ls_waldir()`)
      .then(() => null, (error: unknown) => (error as { code?: string })?.code ?? "unknown");
    await denied.end();
    assert(
      walError === "42501",
      `P1: expected pg_ls_waldir() to raise 42501 for a non-pg_monitor role, got ${walError}. ` +
        `If this role can read the WAL directory the seam proves nothing.`,
    );
    console.log(`${LABEL} P1 OK — pg_ls_waldir() is denied (42501) to a least-privilege role`);

    // ---- Drive the REAL census functions as that role ---------------------
    process.env.DATABASE_URL = `postgresql://${APP_ROLE}@127.0.0.1:${port}/${DB}`;
    process.env.DB_SSL_MODE = "disable";
    process.env.DB_QUERY_TIMEOUT_MS = "20000";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const {
      readDatabaseSize,
      readWalBytes,
      readRelationCensus,
      readBloatSignals,
      readExactCount,
      parseTop,
      parseExactTable,
    } = await import("@/lib/db-growth-census");

    // ---- P2: database size still works ------------------------------------
    const size = await readDatabaseSize();
    assert(size != null, "P2: the database size query returned nothing");
    assert(
      Number(size.databaseBytes) > 0,
      `P2: database size was ${size.databaseBytes}; a denied WAL probe must not take this down`,
    );
    console.log(`${LABEL} P2 OK — database size readable under least privilege (${size.databaseBytes} B)`);

    // ---- P3: the full relation census still works -------------------------
    const relations = await readRelationCensus(30);
    assert(
      relations.some((row) => row.relation === "census_probe"),
      "P3: the relation census did not include the seeded table",
    );
    const probe = relations.find((row) => row.relation === "census_probe")!;
    assert(
      Number(probe.totalBytes) > 0 && Number(probe.heapBytes) > 0,
      "P3: relation sizes came back zero",
    );
    console.log(
      `${LABEL} P3 OK — full relation census readable under least privilege (${relations.length} relations)`,
    );

    // ---- P4: WAL degrades EXPLICITLY, never to a silent zero --------------
    const wal = await readWalBytes();
    assert(wal.available === false, "P4: WAL reported as available under a role that cannot read it");
    assert(
      wal.reason.includes("42501") && /permission denied/i.test(wal.reason),
      `P4: the unavailability reason does not name the privilege failure: ${wal.reason}`,
    );
    // The specific regression this seam exists to prevent: a denied probe
    // must never be rendered as a measurement of zero.
    assert(
      !("value" in wal),
      "P4: a denied WAL probe carried a value — inventing 0 would be a lie that looks like a measurement",
    );
    console.log(`${LABEL} P4 OK — WAL degrades to explicit unavailable with the 42501 reason`);

    // ---- P5: bloat signals survive (pg_stat_user_tables is unprivileged) --
    const bloat = await readBloatSignals(10);
    assert(bloat.available, `P5: bloat signals unavailable under least privilege: ${bloat.available === false ? bloat.reason : ""}`);
    console.log(`${LABEL} P5 OK — bloat signals readable under least privilege`);

    // ---- P6: --top is bounded and refuses malformed input -----------------
    assert("error" in parseTop("abc"), "P6: --top=abc was accepted");
    assert("error" in parseTop("-5"), "P6: --top=-5 was accepted");
    assert("error" in parseTop("0"), "P6: --top=0 was accepted");
    assert("error" in parseTop("1e9"), "P6: --top=1e9 was accepted");
    assert("error" in parseTop("999999"), "P6: an unbounded --top was accepted");
    assert("error" in parseTop("10; DROP TABLE census_probe"), "P6: an injection-shaped --top was accepted");
    const ok = parseTop("40");
    assert("top" in ok && ok.top === 40, "P6: a valid --top was rejected");
    // The census table is still here, which it would not be if any of the above
    // had reached the server.
    const survived = await admin.query(`SELECT COUNT(*)::int AS count FROM public.census_probe`);
    assert(survived.rows[0].count === 500, "P6: the probe table was mutated by argument parsing");
    console.log(`${LABEL} P6 OK — --top is bounded [1,500], refuses malformed input, mutates nothing`);

    // ---- P7: --table is schema-pinned and refuses unsafe names ------------
    assert("error" in parseExactTable("Census_Probe"), "P7: an upper-case identifier was accepted");
    assert("error" in parseExactTable('census_probe"; DROP TABLE x --'), "P7: an injection-shaped --table was accepted");
    assert("error" in parseExactTable("pg_class; SELECT 1"), "P7: a compound statement was accepted");
    assert("error" in parseExactTable("x".repeat(64)), "P7: an over-length identifier was accepted");

    // A same-named relation in another schema on the search_path must NOT be
    // what gets counted: the census reports `public`, so the count must too.
    await admin.query(`CREATE SCHEMA decoy`);
    await admin.query(`CREATE TABLE decoy.census_probe (id int)`);
    await admin.query(`INSERT INTO decoy.census_probe SELECT generate_series(1, 7)`);
    await admin.query(`GRANT USAGE ON SCHEMA decoy TO ${APP_ROLE}`);
    await admin.query(`GRANT SELECT ON decoy.census_probe TO ${APP_ROLE}`);
    await admin.query(`ALTER ROLE ${APP_ROLE} SET search_path = decoy, public`);

    resetDbClientCache();
    const counted = await readExactCount("census_probe");
    assert(counted.available, `P7: the exact count failed: ${counted.available === false ? counted.reason : ""}`);
    assert(
      counted.value === "500",
      `P7: counted ${counted.value} rows — with 'decoy' first on search_path an unqualified name ` +
        `would return 7, and the census would print a decoy count beside public sizes`,
    );

    const missing = await readExactCount("relation_that_does_not_exist");
    assert(!missing.available, "P7: a nonexistent relation reported a count");
    console.log(`${LABEL} P7 OK — --table refuses unsafe names and is pinned to public, not search_path`);

    console.log(`${LABEL} PASS — P1-P7`);
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
    await admin?.end().catch(() => undefined);
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
