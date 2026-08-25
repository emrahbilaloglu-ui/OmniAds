/**
 * Runtime evidence, against the real mounted routes.
 *
 * Every claim this branch makes about a Meta surface has so far been made by a
 * unit test against a component, or by a design harness against a body no route
 * mounts. The plan's D14 is explicit that this is not readiness: *"Gerçek
 * mounted route, authenticated scope, gerçek payload … birlikte kanıtlanmadan
 * READY denemez."*
 *
 * This boots the whole thing:
 *
 *   1. a throwaway PostgreSQL cluster — never 15432 (production tunnel) and
 *      never 5432 (local volume);
 *   2. the repo's real deploy migrations, run against it;
 *   3. the D6 zero / one / many account fixture, plus a second tenant the
 *      operator is not a member of;
 *   4. the production standalone server, with `DATABASE_URL` force-set so a
 *      `.env.local` pointing at production cannot win — `@next/env` never
 *      overrides a value already in `process.env`;
 *   5. Playwright, driving the canonical routes as a signed-in operator.
 *
 * No provider call is made and no production system is touched. What this
 * proves is the application's own behaviour on a real request against a real
 * database; what it cannot prove is anything about provider responses, which
 * needs a sandbox account and is recorded as blocked rather than simulated.
 *
 * Usage:  npm run meta:runtime-evidence
 *         npm run meta:runtime-evidence -- --keep   (leave the server running)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findFreeSafePort, startEphemeralCluster } from "@/scripts/meta/runtime-evidence/cluster";
import { seedRuntimeEvidence, type RuntimeSeed } from "@/scripts/meta/runtime-evidence/seed";

const ROOT = process.cwd();
const DB_NAME = "adsecute_runtime_evidence";
const HANDLE_DIR = path.join(ROOT, "playwright", ".runtime");
const HANDLE_FILE = path.join(HANDLE_DIR, "meta-runtime.json");

function log(message: string): void {
  console.log(`[runtime-evidence] ${message}`);
}

function runMigrations(databaseUrl: string): void {
  log("migrations: running the real deploy entry point");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "scripts", "run-migrations.ts")],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        // Force-set, so `.env.local` cannot reach production through this.
        DATABASE_URL: databaseUrl,
        DATABASE_URL_UNPOOLED: databaseUrl,
        POSTGRES_URL: databaseUrl,
        POSTGRES_URL_NON_POOLING: databaseUrl,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`migrations failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/healthz`, { cache: "no-store" });
      if (response.status < 500) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms: ${lastError}`);
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");

  if (!existsSync(path.join(ROOT, ".next", "standalone", "server.js"))) {
    throw new Error(
      "No standalone build found. Run `npm run build` first — this harness serves the\n" +
        "production build deliberately, because a dev server does not exercise the same\n" +
        "rendering path the operator gets.",
    );
  }

  const cluster = await startEphemeralCluster(DB_NAME);
  log(`postgres: 127.0.0.1:${cluster.port} (never 15432 / 5432)`);

  const servers: ReturnType<typeof spawn>[] = [];
  const shutdown = () => {
    for (const child of servers) if (!child.killed) child.kill("SIGTERM");
    cluster.stop();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });

  let seed: RuntimeSeed;
  try {
    runMigrations(cluster.databaseUrl);
    log("seed: D6 zero / one / many, plus a second tenant");
    seed = await seedRuntimeEvidence(cluster.databaseUrl);

    /**
     * Two servers, one database, differing only in release-gate environment.
     *
     * A gate has two halves and they cannot both be observed in one process.
     * With the gates at their SHIPPED values every refusal is provable and
     * nothing behind them is; open them for the whole run and the refusals
     * stop existing. Running both means the same code, the same fixture and
     * the same session can be asked what it does in each posture, and the
     * difference between the two answers IS the gate.
     *
     * Only the two gates whose capability contacts no provider are opened on
     * the second server: the Meta Stop (a row in our own control plane), the
     * decision workflow (our own overlay), the share mint (our own ledger) and
     * the account picker (a URL scope). `META_LAUNCHPAD_EXECUTION` and
     * `META_AUTOMATION_LIVE_WRITES` are NOT opened anywhere in this harness —
     * their next step is a call to Meta, and no local evidence may be produced
     * by making one.
     *
     * The session cookie is issued for 127.0.0.1 and cookies ignore the port,
     * so one sign-in reaches both.
     */
    const startServer = async (
      label: string,
      gates: Record<string, string>,
    ): Promise<string> => {
      const port = await findFreeSafePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      log(`server(${label}): starting the standalone production build on ${baseUrl}`);

      const child = spawn(
        process.execPath,
        [path.join(ROOT, "scripts", "start-local-smoke-server.mjs")],
        {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            NODE_ENV: "production",
            PORT: String(port),
            HOSTNAME: "127.0.0.1",
            NEXT_PUBLIC_APP_URL: baseUrl,
            // The login cookie is `Secure` in production and this server is plain
            // http on loopback. The same allowance the repo's other local smokes use.
            ALLOW_INSECURE_LOCAL_AUTH_COOKIE: "1",
            DATABASE_URL: cluster.databaseUrl,
            DATABASE_URL_UNPOOLED: cluster.databaseUrl,
            POSTGRES_URL: cluster.databaseUrl,
            POSTGRES_URL_NON_POOLING: cluster.databaseUrl,
            CRON_SECRET: "runtime-evidence-not-a-secret",
            ...gates,
          },
        },
      );
      servers.push(child);
      const serverLog: string[] = [];
      child.stdout?.on("data", (chunk: Buffer) => serverLog.push(chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => serverLog.push(chunk.toString()));

      try {
        await waitForServer(baseUrl, 90_000);
      } catch (error) {
        console.error(serverLog.join(""));
        throw error;
      }
      log(`server(${label}): ready`);
      return baseUrl;
    };

    // Every gate at its shipped value. Nothing is set, because "not set" is the
    // posture under test and writing `=false` would prove a different one.
    const baseUrl = await startServer("shipped-gates", {});
    const gatesOpenBaseUrl = await startServer("gates-open", {
      META_AUTOMATION_STOP_UI: "true",
      META_DECISION_WORKFLOW_UI: "true",
      META_PUBLIC_SHARE_MINT: "true",
      META_ACCOUNT_PICKER: "true",
    });

    mkdirSync(HANDLE_DIR, { recursive: true });
    writeFileSync(
      HANDLE_FILE,
      `${JSON.stringify(
        { baseUrl, gatesOpenBaseUrl, databaseUrl: cluster.databaseUrl, ...seed },
        null,
        2,
      )}\n`,
      "utf8",
    );

    if (keep) {
      log(`handle written to ${path.relative(ROOT, HANDLE_FILE)} — press Ctrl-C to tear down`);
      await new Promise(() => {});
      return;
    }

    /*
     * The authenticated role matrix, which has never been run.
     *
     * `route-role-matrix.ts` and its seeder were written for exactly this and
     * need only two things the repo could not previously supply together: a
     * database it may write to, and a server it can sign into. Both are up.
     *
     * It runs before the browser specs because it seeds two more tenants and
     * five more principals; the specs read nothing it writes, and a failure
     * here is about authorization rather than about a surface.
     */
    log("role matrix: seeding principals and driving every leaf");
    const roleSeed = spawnSync(process.execPath, [path.join(ROOT, "scripts", "zero-base", "seed-role-matrix.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: cluster.databaseUrl,
        DATABASE_URL_UNPOOLED: cluster.databaseUrl,
        POSTGRES_URL: cluster.databaseUrl,
        POSTGRES_URL_NON_POOLING: cluster.databaseUrl,
      },
    });
    if (roleSeed.status !== 0) {
      throw new Error(`role-matrix seed failed (${roleSeed.status}):\n${roleSeed.stderr}`);
    }
    const roleMatrix = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "scripts", "zero-base", "route-role-matrix.ts")],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          ZERO_BASE_SMOKE_URL: baseUrl,
          ZERO_BASE_ROLE_SEED: roleSeed.stdout.trim(),
          DATABASE_URL: cluster.databaseUrl,
          DATABASE_URL_UNPOOLED: cluster.databaseUrl,
        },
      },
    );
    if (roleMatrix.status !== 0) {
      throw new Error(`role matrix FAILED (exit ${roleMatrix.status})`);
    }

    log("playwright: driving the canonical routes");
    const test = spawnSync(
      "npx",
      ["playwright", "test", "--project=meta-runtime-chromium", "--reporter=list"],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          PLAYWRIGHT_USE_WEBSERVER: "0",
          PLAYWRIGHT_BASE_URL: baseUrl,
          META_RUNTIME_HANDLE: HANDLE_FILE,
          META_RUNTIME_DATABASE_URL: cluster.databaseUrl,
        },
      },
    );
    if (test.status !== 0) {
      throw new Error(`runtime evidence FAILED (playwright exit ${test.status})`);
    }
    log("PASS: every runtime check held against the mounted routes.");
  } finally {
    if (!keep) shutdown();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
