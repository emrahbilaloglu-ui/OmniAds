/**
 * F1-F8 — Google Ads day finality, against a real PostgreSQL.
 *
 * Google Ads coverage is `SELECT DISTINCT date` — mere row existence. So a date
 * read once at 01:40 becomes "covered", every later tick that day skips
 * re-queueing it, and the D+1 path then calls
 * markProviderDayRolloverFinalizeCompleted WITHOUT contacting Google. A day
 * freezes at its first intraday read and is reported settled forever.
 *
 * This seam proves the substrate that replaces "a row exists and time passed":
 * a day-grain record whose finality the DATABASE refuses to accept without a
 * closed-day proof. The CHECK constraint is the load-bearing part — it means a
 * caller cannot record finality by mistake even if application logic regresses.
 *
 * None of this is provable with a mocked sql tag: CHECK enforcement, ON CONFLICT
 * arbitration, monotonicity under concurrency and partial-index behaviour are
 * all decided by PostgreSQL.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "google_ads_finality_seam";
const USER = "postgres";
const LABEL = "[google-ads-finality-seam]";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`google ads finality seam FAILED: ${message}`);
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

const BUSINESS = "biz-finality";
const ACCOUNT = "1234567890";
const SCOPE = "campaign_daily";

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-ga-finality-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let started = false;
  let client: Client | null = null;
  let raceClient: Client | null = null;

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
    process.env.DB_QUERY_TIMEOUT_MS = "20000";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "google_ads_finality_seam" });

    const {
      markGoogleAdsDayFinal,
      recordGoogleAdsDayObservation,
      isGoogleAdsDayFinal,
      getGoogleAdsFinalDates,
      resolveAccountDayClosedAt,
    } = await import("@/lib/google-ads/day-finality");

    client = new Client({ connectionString });
    await client.connect();
    raceClient = new Client({ connectionString });
    await raceClient.connect();

    // ---- F1: the table and its partial index exist and are valid ---------
    const index = await client.query<{ indexdef: string; indisvalid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'idx_google_ads_day_finality_provisional'`,
    );
    assert(index.rows.length === 1, "F1: the provisional index was not created");
    assert(index.rows[0]!.indisvalid, "F1: the provisional index is INVALID");
    assert(
      index.rows[0]!.indexdef.includes("finalized_at IS NULL"),
      "F1: the index is not partial, so the provisional scan would carry the settled majority",
    );
    console.log(`${LABEL} F1 OK — day-finality table and partial provisional index present`);

    // ---- F2: absence is a distinct state ----------------------------------
    assert(
      (await isGoogleAdsDayFinal({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        scope: SCOPE,
        date: "2026-07-01",
      })) === false,
      "F2: an untracked date reported as final — absence must never mean trusted",
    );
    console.log(`${LABEL} F2 OK — an untracked date is not final`);

    // ---- F3: observation alone never confers finality ---------------------
    // This is the defect in one assertion: rows existing is not evidence.
    await recordGoogleAdsDayObservation({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      date: "2026-07-02",
      accountTimezone: "Europe/Istanbul",
      fetchCompleted: true,
    });
    assert(
      (await isGoogleAdsDayFinal({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        scope: SCOPE,
        date: "2026-07-02",
      })) === false,
      "F3: an observed date became final without a closed-day proof",
    );
    console.log(`${LABEL} F3 OK — observation records progress but never finality`);

    // ---- F4: the DATABASE refuses finality without a close proof ----------
    // The negative control. Even a direct write cannot claim finality without
    // day_closed_at, so an application regression cannot reintroduce the bug.
    const violation = await client
      .query(
        `INSERT INTO google_ads_day_finality
           (business_id, provider_account_id, scope, date, finalized_at)
         VALUES ($1, $2, $3, '2026-07-03'::date, now())`,
        [BUSINESS, ACCOUNT, SCOPE],
      )
      .then(() => null, (error: unknown) => (error as { code?: string })?.code ?? "unknown");
    assert(
      violation === "23514",
      `F4: finality without day_closed_at returned ${violation}, expected a 23514 check violation`,
    );

    const backwards = await client
      .query(
        `INSERT INTO google_ads_day_finality
           (business_id, provider_account_id, scope, date, day_closed_at, finalized_at)
         VALUES ($1, $2, $3, '2026-07-04'::date, now(), now() - interval '1 hour')`,
        [BUSINESS, ACCOUNT, SCOPE],
      )
      .then(() => null, (error: unknown) => (error as { code?: string })?.code ?? "unknown");
    assert(
      backwards === "23514",
      `F4: finalizing BEFORE the day closed returned ${backwards}, expected 23514`,
    );
    console.log(
      `${LABEL} F4 OK — the database refuses finality with no close proof, and refuses finalizing before close`,
    );

    // ---- F5: a real final fetch after the day closed is accepted ---------
    const closedAt = resolveAccountDayClosedAt({
      date: "2026-07-05",
      timeZone: "Europe/Istanbul",
    });
    assert(closedAt != null, "F5: could not resolve the account day close instant");
    await markGoogleAdsDayFinal({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      date: "2026-07-05",
      accountTimezone: "Europe/Istanbul",
      dayClosedAt: closedAt!,
      source: "seam",
    });
    assert(
      await isGoogleAdsDayFinal({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        scope: SCOPE,
        date: "2026-07-05",
      }),
      "F5: a fetch after the closed day did not record finality",
    );
    console.log(`${LABEL} F5 OK — a fetch taken after the account day closed records finality`);

    // ---- F6: finality is monotonic — replay cannot rewrite history -------
    const first = await client.query<{ finalized_at: string }>(
      `SELECT finalized_at::text FROM google_ads_day_finality
       WHERE business_id = $1 AND provider_account_id = $2 AND scope = $3 AND date = '2026-07-05'::date`,
      [BUSINESS, ACCOUNT, SCOPE],
    );
    await markGoogleAdsDayFinal({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      date: "2026-07-05",
      accountTimezone: "Europe/Istanbul",
      dayClosedAt: closedAt!,
      source: "seam-replay",
    });
    const second = await client.query<{ finalized_at: string; attempt_count: number }>(
      `SELECT finalized_at::text, attempt_count FROM google_ads_day_finality
       WHERE business_id = $1 AND provider_account_id = $2 AND scope = $3 AND date = '2026-07-05'::date`,
      [BUSINESS, ACCOUNT, SCOPE],
    );
    assert(
      first.rows[0]!.finalized_at === second.rows[0]!.finalized_at,
      "F6: a replay moved finalized_at — the first final fetch must be the one that counts",
    );
    assert(
      Number(second.rows[0]!.attempt_count) === 2,
      "F6: the replay was not accounted for",
    );
    console.log(`${LABEL} F6 OK — replay is idempotent and finalized_at is monotonic`);

    // ---- F7: an observation cannot un-finalize a final date --------------
    await recordGoogleAdsDayObservation({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      date: "2026-07-05",
      accountTimezone: "Europe/Istanbul",
      fetchCompleted: true,
    });
    assert(
      await isGoogleAdsDayFinal({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        scope: SCOPE,
        date: "2026-07-05",
      }),
      "F7: a later observation cleared an established finality record",
    );
    console.log(`${LABEL} F7 OK — a later observation cannot un-finalize a settled date`);

    // ---- F8: concurrent writers converge, from separate sessions ---------
    // Two genuinely independent connections, so the arbitration is PostgreSQL's
    // rather than an accident of running on one pooled client.
    const raceClosed = resolveAccountDayClosedAt({
      date: "2026-07-06",
      timeZone: "America/Los_Angeles",
    })!;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        markGoogleAdsDayFinal({
          businessId: BUSINESS,
          providerAccountId: ACCOUNT,
          scope: SCOPE,
          date: "2026-07-06",
          accountTimezone: "America/Los_Angeles",
          dayClosedAt: raceClosed,
          source: "seam-race",
        }),
      ),
    );
    const raceRows = await raceClient.query<{ count: string; attempts: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(MAX(attempt_count), 0)::text AS attempts
       FROM google_ads_day_finality
       WHERE business_id = $1 AND provider_account_id = $2 AND scope = $3 AND date = '2026-07-06'::date`,
      [BUSINESS, ACCOUNT, SCOPE],
    );
    assert(
      Number(raceRows.rows[0]!.count) === 1,
      `F8: 6 concurrent finalizations produced ${raceRows.rows[0]!.count} rows`,
    );
    assert(
      Number(raceRows.rows[0]!.attempts) === 6,
      `F8: attempt accounting lost writes under concurrency (${raceRows.rows[0]!.attempts})`,
    );

    const finalDates = await getGoogleAdsFinalDates({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });
    assert(
      finalDates.includes("2026-07-05") && finalDates.includes("2026-07-06"),
      "F8: the final-date scan did not return the finalized dates",
    );
    assert(
      !finalDates.includes("2026-07-02"),
      "F8: an observed-but-provisional date was reported as final",
    );
    console.log(
      `${LABEL} F8 OK — 6 concurrent finalizations => 1 row, attempts=6, and the scan reports only final dates`,
    );

    console.log(`${LABEL} PASS — F1-F8`);
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
    await raceClient?.end().catch(() => undefined);
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
