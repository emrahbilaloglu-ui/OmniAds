/**
 * A throwaway PostgreSQL cluster, for evidence that needs a real database.
 *
 * The repo already boots one of these in `scripts/ephemeral-postgres-*.ts`, but
 * every one of those owns its cluster privately and exits with it. The runtime
 * evidence harness needs a cluster that outlives a single script — the app
 * server, the migrations and the browser all talk to the same database — so the
 * boot sequence is lifted here unchanged rather than copied a forty-first time.
 *
 * The safety rules are the originals and are not negotiable:
 *
 * - 15432 is the live production tunnel and 5432 is the local volume Postgres.
 *   Both are refused outright, so a harness can never write into either by
 *   mistake — including through a `.env.local` that points at production.
 * - The data directory is a temp directory and is removed on teardown.
 * - `DATABASE_URL` is returned, never read from the environment: the caller
 *   force-sets it on every child, and `@next/env` does not override values that
 *   are already present in `process.env`.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Never these two, whatever the caller asks for. */
const FORBIDDEN_PORTS = new Set([15432, 5432]);

const DB_USER = "postgres";

export interface EphemeralCluster {
  /** `postgresql://…` for the created database. */
  databaseUrl: string;
  port: number;
  dataDir: string;
  logFile: string;
  /** Stop the server and delete the data directory. Safe to call twice. */
  stop(): void;
}

function resolvePgBinDir(): string {
  const required = ["initdb", "pg_ctl", "postgres", "createdb"];
  const linuxVersionedDirs = fs.existsSync("/usr/lib/postgresql")
    ? fs
        .readdirSync("/usr/lib/postgresql", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
        .map((version) => path.join("/usr/lib/postgresql", version, "bin"))
    : [];
  const candidates = Array.from(
    new Set(
      [
        process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
        "/opt/homebrew/opt/postgresql@16/bin",
        "/opt/homebrew/bin",
        ...linuxVersionedDirs,
        ...(process.env.PATH ?? "").split(path.delimiter),
      ].filter((dir): dir is string => Boolean(dir)),
    ),
  );
  for (const dir of candidates) {
    if (required.every((binary) => fs.existsSync(path.join(dir, binary)))) return dir;
  }
  throw new Error(
    `PostgreSQL binaries (${required.join(", ")}) not found in any of: ${candidates.join(", ")}. ` +
      "Install PostgreSQL or set EPHEMERAL_PG_BIN_DIR.",
  );
}

function assertSafePort(port: number): void {
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(
      `Refusing port ${port}: 15432 is the live prod tunnel and 5432 is the local volume Postgres.`,
    );
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid ephemeral Postgres port: ${port}`);
  }
}

export async function findFreeSafePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          const found = address.port;
          server.close(() => resolve(found));
        } else {
          server.close(() => reject(new Error("no port")));
        }
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("Could not find a free port that is not 15432 or 5432.");
}

/**
 * A locale the postmaster will start under.
 *
 * Without it, PostgreSQL 16 on macOS 15+ dies at startup with "postmaster
 * became multithreaded during startup" — the system locale lookup pulls in a
 * threaded Core Foundation path before the postmaster forks, and the server
 * refuses rather than run in an unsupported state. The failure is a `pg_ctl:
 * could not start server` with the reason only in the cluster log, which is why
 * that log is quoted on failure below rather than left behind.
 */
const CLUSTER_LOCALE = { LC_ALL: "C", LANG: "C" } as const;

function runSync(
  command: string,
  args: string[],
  label: string,
  onFailure?: () => string | null,
): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...CLUSTER_LOCALE },
  });
  if (result.status !== 0) {
    const extra = onFailure?.() ?? null;
    throw new Error(
      `${label} failed (${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}` +
        (extra ? `\n--- cluster log ---\n${extra}` : ""),
    );
  }
}

export async function startEphemeralCluster(databaseName: string): Promise<EphemeralCluster> {
  const pgBinDir = resolvePgBinDir();
  const port = await findFreeSafePort();
  assertSafePort(port);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-runtime-pg-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const databaseUrl = `postgresql://${DB_USER}@127.0.0.1:${port}/${databaseName}`;

  let started = false;
  const stop = () => {
    if (started) {
      spawnSync(path.join(pgBinDir, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
        encoding: "utf8",
        env: { ...process.env, ...CLUSTER_LOCALE },
      });
      started = false;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    runSync(
      path.join(pgBinDir, "initdb"),
      ["-D", dataDir, "-U", DB_USER, "--auth=trust", "--encoding=UTF8", "--no-locale"],
      "initdb",
    );
    runSync(
      path.join(pgBinDir, "pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-w",
        "-t",
        "60",
        "-o",
        // Loopback TCP only; unix sockets off because a temp path can exceed
        // the socket path limit on macOS. fsync off: the data is throwaway.
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off`,
        "start",
      ],
      "pg_ctl start",
      () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : null),
    );
    started = true;
    runSync(
      path.join(pgBinDir, "createdb"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", DB_USER, databaseName],
      "createdb",
    );
  } catch (error) {
    stop();
    throw error;
  }

  return { databaseUrl, port, dataDir, logFile, stop };
}
