import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const FORBIDDEN_DB_PORTS = new Set([15432, 5432]);
const DB_NAME = "adsecute_full_ui_redesign_smoke";
const DB_USER = "postgres";

function log(message: string) {
  console.log(`[full-ui-smoke] ${message}`);
}

function resolvePgBinDir(): string {
  const required = ["initdb", "pg_ctl", "createdb"];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of candidates) {
    if (required.every((binary) => fs.existsSync(path.join(dir, binary)))) {
      return dir;
    }
  }
  throw new Error(
    `PostgreSQL binaries (${required.join(", ")}) not found. Install postgresql@16 or set EPHEMERAL_PG_BIN_DIR.`,
  );
}

async function findFreePort(forbidden = new Set<number>()): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === "object") {
            resolve(address.port);
            return;
          }
          reject(new Error("Could not determine a free port."));
        });
      });
    });

    if (!forbidden.has(port) && port >= 1024 && port <= 65535) {
      return port;
    }
  }
  throw new Error("Could not find a free safe port.");
}

function runSync(command: string, args: string[], label: string, env = process.env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...env, LC_ALL: "C" },
  });
  if (result.error) {
    throw new Error(`${label} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited with code ${result.status}.` +
        `${result.stdout?.trim() ? `\nstdout: ${result.stdout.trim()}` : ""}` +
        `${result.stderr?.trim() ? `\nstderr: ${result.stderr.trim()}` : ""}`,
    );
  }
}

function prepareSmokeWorktree(repoRoot: string, worktreeDir: string) {
  fs.mkdirSync(worktreeDir, { recursive: true });
  const result = spawnSync(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude",
      ".git",
      "--exclude",
      ".next",
      "--exclude",
      "node_modules",
      "--exclude",
      "playwright-report",
      "--exclude",
      "test-results",
      `${repoRoot}/`,
      `${worktreeDir}/`,
    ],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw new Error(`rsync failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `rsync exited with code ${result.status}.` +
        `${result.stdout?.trim() ? `\nstdout: ${result.stdout.trim()}` : ""}` +
        `${result.stderr?.trim() ? `\nstderr: ${result.stderr.trim()}` : ""}`,
    );
  }

  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(worktreeDir, "node_modules"), "dir");
}

async function runChild(
  command: string,
  args: string[],
  label: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
) {
  log(label);
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`${label} exited with code ${exitCode}.`);
  }
}

async function main() {
  const repoRoot = process.cwd();
  if (!fs.existsSync(path.join(repoRoot, "playwright.full-ui-redesign.config.ts"))) {
    throw new Error("Run from repo root after adding the full UI smoke Playwright config.");
  }

  const pgBinDir = resolvePgBinDir();
  const dbPort = await findFreePort(FORBIDDEN_DB_PORTS);
  if (FORBIDDEN_DB_PORTS.has(dbPort)) {
    throw new Error(`Refusing to use forbidden database port ${dbPort}.`);
  }
  const webPort = await findFreePort(new Set([3000, 15432, 5432, dbPort]));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-full-ui-smoke-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const worktreeDir = path.join(tempDir, "worktree");
  const artifactSet = process.env.FULL_UI_SMOKE_ARTIFACT_SET?.trim();
  const artifactDir = path.join(
    repoRoot,
    "docs",
    "full-ui-redesign",
    "playwright-smoke-artifacts",
    ...(artifactSet ? [artifactSet] : []),
  );
  const databaseUrl = `postgresql://${DB_USER}@127.0.0.1:${dbPort}/${DB_NAME}`;
  const baseUrl = `http://127.0.0.1:${webPort}`;

  log(`ephemeral database port: ${dbPort}`);
  log(`playwright base URL: ${baseUrl}`);
  log(`smoke worktree: ${worktreeDir}`);
  fs.rmSync(artifactDir, { recursive: true, force: true });
  fs.mkdirSync(artifactDir, { recursive: true });

  let serverStarted = false;
  try {
    prepareSmokeWorktree(repoRoot, worktreeDir);

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
        `-p ${dbPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off`,
        "start",
      ],
      "pg_ctl start",
    );
    serverStarted = true;

    runSync(
      path.join(pgBinDir, "createdb"),
      ["-h", "127.0.0.1", "-p", String(dbPort), "-U", DB_USER, DB_NAME],
      "createdb",
    );

    const env = {
      ...process.env,
      ALLOW_INSECURE_LOCAL_AUTH_COOKIE: "1",
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      ENABLE_RUNTIME_MIGRATIONS: "1",
      NEXT_PUBLIC_APP_URL: baseUrl,
      PGDATABASE: DB_NAME,
      PGHOST: "127.0.0.1",
      PGUSER: DB_USER,
      PLAYWRIGHT_BASE_URL: baseUrl,
      PLAYWRIGHT_OUTPUT_DIR: path.join(artifactDir, "test-results"),
      PLAYWRIGHT_REPORT_DIR: path.join(artifactDir, "html-report"),
      PLAYWRIGHT_REUSE_EXISTING_SERVER: "0",
      PLAYWRIGHT_USE_WEBSERVER: "1",
      PORT: String(webPort),
    };

    await runChild(
      process.execPath,
      ["--import", "tsx", "scripts/run-migrations.ts"],
      "running migrations into ephemeral smoke database",
      env,
      worktreeDir,
    );
    await runChild(
      process.execPath,
      ["--import", "tsx", "scripts/run-migrations.ts"],
      "rerunning migrations for smoke idempotency",
      env,
      worktreeDir,
    );
    await runChild(
      "npx",
      ["playwright", "test", "-c", "playwright.full-ui-redesign.config.ts"],
      "running full UI redesign Playwright route and visual smoke",
      env,
      worktreeDir,
    );
  } catch (error) {
    if (fs.existsSync(logFile)) {
      const tail = fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-40).join("\n");
      console.error(`[full-ui-smoke] postgres log tail:\n${tail}`);
    }
    throw error;
  } finally {
    if (serverStarted) {
      const stop = spawnSync(
        path.join(pgBinDir, "pg_ctl"),
        ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
        { encoding: "utf8" },
      );
      if (stop.status !== 0) {
        console.error(`[full-ui-smoke] warning: pg_ctl stop failed: ${stop.stderr?.trim() ?? ""}`);
      } else {
        log("ephemeral database stopped");
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    log(`removed ${tempDir}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
