/**
 * F1-F11 — Google Ads date freshness, against a real PostgreSQL.
 *
 * Coverage is `SELECT DISTINCT date` — mere row existence. A date read once at
 * 01:40 becomes "covered", every later tick skips it, and the D+1 path then
 * writes a rollover completion receipt WITHOUT calling Google.
 *
 * The replacement must not overcorrect into a second lie. Google publishes no
 * instant at which a date stops changing: ~1h for clicks/cost, ~3h last-click
 * and ~15h other attribution models, revisions "one or more days" later for
 * invalid traffic and late conversions, and conversion windows of 1-90 days
 * (default 30) during which a conversion still lands on its original click
 * date. So this seam proves a model with NO terminal state, and proves the
 * database refuses fabricated settlement.
 *
 * None of this is provable with a mocked sql tag: CHECK enforcement, ON CONFLICT
 * arbitration, monotonicity under real concurrency, the due-scan against
 * generate_series, and the old-schema upgrade are all decided by PostgreSQL.
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
const TZ = "Europe/Istanbul";

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

    // ---- F1: OLD-SCHEMA UPGRADE ------------------------------------------
    // Stage the previous shape of this table — the one that asserted permanent
    // finality — BEFORE migrations run, and prove the migration converts it.
    const preClient = new Client({ connectionString });
    await preClient.connect();
    await preClient.query(`
      CREATE TABLE google_ads_day_finality (
        business_id             TEXT NOT NULL,
        provider_account_id     TEXT NOT NULL,
        scope                   TEXT NOT NULL,
        date                    DATE NOT NULL,
        account_timezone        TEXT NOT NULL DEFAULT 'UTC',
        day_closed_at           TIMESTAMPTZ,
        finalized_at            TIMESTAMPTZ,
        finality_source         TEXT,
        last_fetch_completed_at TIMESTAMPTZ,
        attempt_count           INTEGER NOT NULL DEFAULT 0,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (business_id, provider_account_id, scope, date),
        CONSTRAINT google_ads_day_finality_close_proof_check CHECK (
          finalized_at IS NULL
          OR (day_closed_at IS NOT NULL AND finalized_at >= day_closed_at)
        )
      )`);
    await preClient.query(
      `INSERT INTO google_ads_day_finality
         (business_id, provider_account_id, scope, date, day_closed_at, finalized_at)
       VALUES ($1, $2, $3, '2026-06-01'::date, now() - interval '2 days', now() - interval '1 day')`,
      [BUSINESS, ACCOUNT, SCOPE],
    );
    await preClient.end();

    process.env.DATABASE_URL = connectionString;
    process.env.DB_SSL_MODE = "disable";
    process.env.DB_QUERY_TIMEOUT_MS = "20000";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "google_ads_finality_seam" });

    client = new Client({ connectionString });
    await client.connect();
    raceClient = new Client({ connectionString });
    await raceClient.connect();

    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'google_ads_day_finality'`,
    );
    const columnNames = columns.rows.map((row) => row.column_name);
    for (const gone of ["finalized_at", "finality_source", "attempt_count"]) {
      assert(
        !columnNames.includes(gone),
        `F1: the immutability column '${gone}' survived the upgrade`,
      );
    }
    for (const added of [
      "last_observed_at",
      "metrics_settled_at",
      "lookback_exhausted_at",
      "next_refresh_due_at",
      "freshness_tier",
    ]) {
      assert(columnNames.includes(added), `F1: the upgrade did not add '${added}'`);
    }
    const survivor = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM google_ads_day_finality WHERE date = '2026-06-01'::date`,
    );
    assert(
      Number(survivor.rows[0]!.count) === 1,
      "F1: the pre-existing row was destroyed by the upgrade",
    );
    console.log(
      `${LABEL} F1 OK — old finality shape upgraded in place; immutability columns dropped, row preserved`,
    );

    const {
      recordGoogleAdsDayObservation,
      hasPostCloseObservation,
      getGoogleAdsPostCloseObservedDates,
      getGoogleAdsDatesDueForRefresh,
      resolveAccountDayClosedAt,
      resolveGoogleAdsFreshnessTier,
      GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS,
    } = await import("@/lib/google-ads/day-finality");

    // ---- F2: absence is a distinct state ----------------------------------
    assert(
      (await hasPostCloseObservation({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        scope: SCOPE,
        date: "2026-07-01",
      })) === false,
      "F2: an untracked date reported a post-close observation",
    );
    console.log(`${LABEL} F2 OK — an untracked date claims nothing`);

    // ---- F3: an INTRADAY observation is not a post-close observation ------
    // This is the freeze, in one assertion: looking at an open day does not
    // settle it, however many rows the fetch wrote.
    const openDay = "2026-07-20";
    const openClosedAt = resolveAccountDayClosedAt({ date: openDay, timeZone: TZ })!;
    await recordGoogleAdsDayObservation({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      date: openDay,
      accountTimezone: TZ,
      dayClosedAt: openClosedAt,
      tier: "open",
      // 01:40 local on the day itself — before it closed.
      observedAt: new Date("2026-07-19T22:40:00Z"),
    });
    assert(
      (await hasPostCloseObservation({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        scope: SCOPE,
        date: openDay,
      })) === false,
      "F3: an intraday observation was accepted as a post-close observation — this IS the freeze",
    );
    console.log(`${LABEL} F3 OK — an intraday read never counts as observing a closed day`);

    // ---- F4: a POST-CLOSE fetch does count -------------------------------
    await recordGoogleAdsDayObservation({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      date: openDay,
      accountTimezone: TZ,
      dayClosedAt: openClosedAt,
      tier: "settling",
      observedAt: new Date(openClosedAt.getTime() + 3_600_000),
    });
    assert(
      await hasPostCloseObservation({
        businessId: BUSINESS,
        providerAccountId: ACCOUNT,
        scope: SCOPE,
        date: openDay,
      }),
      "F4: a fetch taken after the day closed was not recorded as one",
    );
    console.log(`${LABEL} F4 OK — a post-close fetch is recorded as observing the closed day`);

    // ---- F5: the observation clock is MONOTONIC --------------------------
    // An out-of-order replay must never rewind what we know we observed.
    const before = await client.query<{ last_observed_at: string }>(
      `SELECT last_observed_at::text FROM google_ads_day_finality
       WHERE business_id = $1 AND provider_account_id = $2 AND scope = $3 AND date = $4::date`,
      [BUSINESS, ACCOUNT, SCOPE, openDay],
    );
    await recordGoogleAdsDayObservation({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      date: openDay,
      accountTimezone: TZ,
      dayClosedAt: openClosedAt,
      tier: "settling",
      observedAt: new Date(openClosedAt.getTime() - 10 * 3_600_000),
    });
    const after = await client.query<{ last_observed_at: string; observation_count: number }>(
      `SELECT last_observed_at::text, observation_count FROM google_ads_day_finality
       WHERE business_id = $1 AND provider_account_id = $2 AND scope = $3 AND date = $4::date`,
      [BUSINESS, ACCOUNT, SCOPE, openDay],
    );
    assert(
      after.rows[0]!.last_observed_at === before.rows[0]!.last_observed_at,
      "F5: a stale replay rewound last_observed_at",
    );
    assert(
      Number(after.rows[0]!.observation_count) === 3,
      "F5: the replay was not accounted for",
    );
    console.log(`${LABEL} F5 OK — replay is idempotent and the observation clock never rewinds`);

    // ---- F6: NO TERMINAL STATE, even past the conversion window ----------
    // Google attributes conversions back to a click date for up to the whole
    // conversion window (1-90d, default 30) and revises reports days later. So
    // an aged date must still carry a next-refresh, never a "done" flag.
    const agedDay = "2026-01-05";
    const agedClosedAt = resolveAccountDayClosedAt({ date: agedDay, timeZone: TZ })!;
    const wellPast = new Date(
      agedClosedAt.getTime() + (GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS * 24 + 48) * 3_600_000,
    );
    const agedTier = resolveGoogleAdsFreshnessTier({
      date: agedDay,
      accountToday: "2026-07-28",
      dayClosedAt: agedClosedAt,
      now: wellPast,
    });
    assert(agedTier === "aged", `F6: expected an aged tier, got ${agedTier}`);
    await recordGoogleAdsDayObservation({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      date: agedDay,
      accountTimezone: TZ,
      dayClosedAt: agedClosedAt,
      tier: agedTier,
      observedAt: wellPast,
    });
    const agedRow = await client.query<{ next_refresh_due_at: string | null }>(
      `SELECT next_refresh_due_at::text FROM google_ads_day_finality
       WHERE business_id = $1 AND provider_account_id = $2 AND scope = $3 AND date = $4::date`,
      [BUSINESS, ACCOUNT, SCOPE, agedDay],
    );
    assert(
      agedRow.rows[0]!.next_refresh_due_at != null,
      "F6: an aged date was left with no next refresh — that asserts immutability Google does not offer",
    );
    console.log(
      `${LABEL} F6 OK — a date past the conversion window still carries a next refresh; no terminal state exists`,
    );

    // ---- F7: the database refuses FABRICATED settlement ------------------
    // Negative control. Settlement claims require a real day-close proof.
    const fabricated = await client
      .query(
        `INSERT INTO google_ads_day_finality
           (business_id, provider_account_id, scope, date, metrics_settled_at)
         VALUES ($1, $2, $3, '2026-07-03'::date, now())`,
        [BUSINESS, ACCOUNT, SCOPE],
      )
      .then(() => null, (error: unknown) => (error as { code?: string })?.code ?? "unknown");
    assert(
      fabricated === "23514",
      `F7: settlement without a day-close proof returned ${fabricated}, expected 23514`,
    );
    const scheduleWithoutObservation = await client
      .query(
        `INSERT INTO google_ads_day_finality
           (business_id, provider_account_id, scope, date, next_refresh_due_at)
         VALUES ($1, $2, $3, '2026-07-04'::date, now())`,
        [BUSINESS, ACCOUNT, SCOPE],
      )
      .then(() => null, (error: unknown) => (error as { code?: string })?.code ?? "unknown");
    assert(
      scheduleWithoutObservation === "23514",
      `F7: scheduling a refresh without ever observing returned ${scheduleWithoutObservation}, expected 23514`,
    );
    console.log(
      `${LABEL} F7 OK — the database refuses fabricated settlement and refuses a schedule with no observation`,
    );

    // ---- F8: the due-scan is BOUNDED and newest-first --------------------
    // The ~1/min planner must not be able to enqueue the whole window.
    const due = await getGoogleAdsDatesDueForRefresh({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      startDate: "2026-07-01",
      endDate: "2026-07-28",
      limit: 3,
      now: new Date("2026-07-28T12:00:00Z"),
    });
    assert(due.length === 3, `F8: the due-scan returned ${due.length} dates, expected a cap of 3`);
    assert(due[0]! > due[1]! && due[1]! > due[2]!, "F8: the due-scan is not newest-first");
    const unbounded = await getGoogleAdsDatesDueForRefresh({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      startDate: "2026-07-01",
      endDate: "2026-07-28",
      limit: 0,
      now: new Date("2026-07-28T12:00:00Z"),
    });
    assert(unbounded.length === 0, "F8: a zero limit still returned work");
    console.log(`${LABEL} F8 OK — the due-scan is hard-capped and newest-first`);

    // ---- F9: an observed date is NOT due again until its tier says so ----
    const notYetDue = await getGoogleAdsDatesDueForRefresh({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      startDate: openDay,
      endDate: openDay,
      limit: 10,
      // Immediately after the observation: its next refresh has not arrived.
      now: new Date(openClosedAt.getTime() + 2 * 3_600_000),
    });
    assert(
      notYetDue.length === 0,
      "F9: a just-observed date was immediately due again — the planner would re-enqueue every pass",
    );
    const dueLater = await getGoogleAdsDatesDueForRefresh({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      startDate: openDay,
      endDate: openDay,
      limit: 10,
      now: new Date(openClosedAt.getTime() + 30 * 24 * 3_600_000),
    });
    assert(
      dueLater.includes(openDay),
      "F9: a long-stale date never became due again — that is the freeze, reintroduced",
    );
    console.log(
      `${LABEL} F9 OK — a fresh date is not re-enqueued; a stale one becomes due again`,
    );

    // ---- F10: concurrent workers converge, from separate sessions --------
    const raceDay = "2026-07-15";
    const raceClosedAt = resolveAccountDayClosedAt({
      date: raceDay,
      timeZone: "America/Los_Angeles",
    })!;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        recordGoogleAdsDayObservation({
          businessId: BUSINESS,
          providerAccountId: ACCOUNT,
          scope: SCOPE,
          date: raceDay,
          accountTimezone: "America/Los_Angeles",
          dayClosedAt: raceClosedAt,
          tier: "converging",
          observedAt: new Date(raceClosedAt.getTime() + 20 * 3_600_000),
        }),
      ),
    );
    const raceRows = await raceClient.query<{ count: string; observations: string }>(
      `SELECT COUNT(*)::text AS count, COALESCE(MAX(observation_count), 0)::text AS observations
       FROM google_ads_day_finality
       WHERE business_id = $1 AND provider_account_id = $2 AND scope = $3 AND date = $4::date`,
      [BUSINESS, ACCOUNT, SCOPE, raceDay],
    );
    assert(
      Number(raceRows.rows[0]!.count) === 1,
      `F10: 6 concurrent observations produced ${raceRows.rows[0]!.count} rows`,
    );
    assert(
      Number(raceRows.rows[0]!.observations) === 6,
      `F10: observation accounting lost writes under concurrency (${raceRows.rows[0]!.observations})`,
    );
    console.log(
      `${LABEL} F10 OK — 6 concurrent observations from separate sessions => 1 row, count=6`,
    );

    // ---- F11: an unusable timezone yields NO close proof -----------------
    // Silently defaulting to UTC would settle a Los Angeles day 7 hours early.
    assert(
      resolveAccountDayClosedAt({ date: "2026-07-27", timeZone: "Not/AZone" }) === null,
      "F11: an invalid timezone produced a day-close instant",
    );
    const observed = await getGoogleAdsPostCloseObservedDates({
      businessId: BUSINESS,
      providerAccountId: ACCOUNT,
      scope: SCOPE,
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });
    assert(observed.includes(openDay), "F11: the observed-date scan lost a post-close observation");
    assert(
      !observed.includes("2026-07-03"),
      "F11: a date with no observation was reported as observed",
    );
    console.log(
      `${LABEL} F11 OK — an invalid timezone yields no close proof, and the scan reports only real observations`,
    );

    console.log(`${LABEL} PASS — F1-F11`);
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
