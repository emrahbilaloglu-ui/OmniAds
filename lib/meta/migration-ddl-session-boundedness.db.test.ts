/**
 * NO MIGRATION DDL ESCAPES THE PINNED LEASE.
 *
 * ── ROUND 20, ITEM 3 ────────────────────────────────────────────────────────
 * Round 18 leased ONE backend for the migration run and proved a `lock_timeout`
 * on it. Round 19 made that proof fail-closed. Neither closed the actual hole:
 * `runNativeAdSchemaMigrations` opened `runDbTransaction`, which leases its OWN
 * client from the pool, so the entire native-ad schema group -- tables, ALTERs,
 * constraints, unique indexes -- ran on a SECOND backend that had never seen
 * the SET. The log said "lock_timeout verified on backend N" while the DDL that
 * can take an ACCESS EXCLUSIVE lock ran on backend M under the server default,
 * which is commonly 0: wait forever.
 *
 * `lib/meta/migration-pinned-session.db.test.ts` proves the LEASE HELPER keeps
 * one backend. It cannot see this defect at all, because the escape happened
 * inside `runMigrations`, downstream of the helper. So this file drives the
 * REAL `runMigrations` against a real PostgreSQL and asks the database itself
 * which backends executed DDL -- via an event trigger, which fires inside the
 * executing backend and therefore cannot be fooled by anything the application
 * believes about its own connections.
 *
 * Every case here is a NEGATIVE CONTROL as well as an assertion:
 *   - the trace case proves the probe DETECTS a second backend, by routing one
 *     deliberate DDL statement through the pool afterwards;
 *   - the three abort cases prove the migration stops BEFORE any DDL, by
 *     reading zero rows from the same probe.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

const NONCE = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const TRACE_DB = `r20_ddl_trace_${NONCE}`;
const ABORT_DB = `r20_ddl_abort_${NONCE}`;
const POOL1_DB = `r21_pool_one_${NONCE}`;
const VERIFY_DB = `r21_verify_gate_${NONCE}`;

const ADMIN_URL = process.env.DATABASE_URL ?? "";
const ORIGINAL_URL = ADMIN_URL;
const ORIGINAL_UNPOOLED = process.env.DATABASE_URL_UNPOOLED;
const ORIGINAL_LOCK_TIMEOUT = process.env.MIGRATION_LOCK_TIMEOUT_MS;
const ORIGINAL_POOL_MAX = process.env.DB_POOL_MAX;

/** Point the scratch database name at the same cluster as DATABASE_URL. */
function urlFor(database: string) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function adminQuery(text: string) {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await client.query(text);
  } finally {
    await client.end();
  }
}

/**
 * A DDL PROBE THE APPLICATION CANNOT INFLUENCE.
 *
 * `ddl_command_end` fires in the backend that ran the command, so
 * `pg_backend_pid()` here IS the executing session -- not what the pool, the
 * lease, or the migration logger believes it is.
 */
const INSTALL_PROBE_SQL = `
  CREATE TABLE r20_ddl_session_probe (
    id              bigserial PRIMARY KEY,
    backend_pid     integer NOT NULL,
    command_tag     text    NOT NULL,
    object_identity text,
    observed_at     timestamptz NOT NULL DEFAULT now()
  );
  CREATE OR REPLACE FUNCTION r20_record_ddl_session()
  RETURNS event_trigger LANGUAGE plpgsql AS $probe$
  DECLARE
    command record;
  BEGIN
    -- The object identity, not just the tag: the defect was specific to the
    -- native-ad schema group, so the proof has to be able to name it.
    FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
      INSERT INTO r20_ddl_session_probe (backend_pid, command_tag, object_identity)
      VALUES (pg_backend_pid(), tg_tag, command.object_identity);
    END LOOP;
    IF NOT FOUND THEN
      INSERT INTO r20_ddl_session_probe (backend_pid, command_tag, object_identity)
      VALUES (pg_backend_pid(), tg_tag, NULL);
    END IF;
  END
  $probe$;
  CREATE EVENT TRIGGER r20_ddl_session_probe_trigger
    ON ddl_command_end EXECUTE FUNCTION r20_record_ddl_session();
`;

async function createProbedDatabase(name: string) {
  await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE ${name}`);
  const client = new Client({ connectionString: urlFor(name) });
  await client.connect();
  try {
    await client.query(INSTALL_PROBE_SQL);
    /*
      The probe's own DDL is recorded by nothing -- the trigger does not exist
      until its own CREATE completes -- but the table is emptied anyway so a
      future edit to the installer cannot leave a stray row behind and make an
      abort case look like it ran DDL.
    */
    await client.query("DELETE FROM r20_ddl_session_probe");
  } finally {
    await client.end();
  }
}

async function probeRows(database: string) {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    const { rows } = await client.query<{
      backend_pid: number;
      command_tag: string;
      object_identity: string | null;
    }>(
      `SELECT backend_pid, command_tag, object_identity
         FROM r20_ddl_session_probe ORDER BY id`,
    );
    return rows.map((row) => ({
      pid: Number(row.backend_pid),
      tag: String(row.command_tag),
      identity: row.object_identity ?? "",
    }));
  } finally {
    await client.end();
  }
}

async function truncateProbe(database: string) {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    await client.query("DELETE FROM r20_ddl_session_probe");
  } finally {
    await client.end();
  }
}

/** Point the application's pool at `database` and hand back a fresh module. */
async function freshMigrationsFor(database: string) {
  process.env.DATABASE_URL = urlFor(database);
  process.env.DATABASE_URL_UNPOOLED = urlFor(database);
  process.env.ENABLE_RUNTIME_MIGRATIONS = "1";
  vi.resetModules();
  const db = await import("@/lib/db");
  db.resetDbClientCache();
  return { db, migrations: await import("@/lib/migrations") };
}

describe.skipIf(!SEAM)("migration DDL is bounded to one session", () => {
  beforeAll(async () => {
    await createProbedDatabase(TRACE_DB);
    await createProbedDatabase(ABORT_DB);
    await createProbedDatabase(POOL1_DB);
    await createProbedDatabase(VERIFY_DB);
  }, 120_000);

  afterAll(async () => {
    if (!SEAM) return;
    if (ORIGINAL_URL) process.env.DATABASE_URL = ORIGINAL_URL;
    if (ORIGINAL_UNPOOLED) process.env.DATABASE_URL_UNPOOLED = ORIGINAL_UNPOOLED;
    if (ORIGINAL_LOCK_TIMEOUT == null) delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
    else process.env.MIGRATION_LOCK_TIMEOUT_MS = ORIGINAL_LOCK_TIMEOUT;
    if (ORIGINAL_POOL_MAX == null) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = ORIGINAL_POOL_MAX;
    vi.resetModules();
    const db = await import("@/lib/db");
    db.resetDbClientCache();
    await adminQuery(`DROP DATABASE IF EXISTS ${TRACE_DB} WITH (FORCE)`).catch(
      () => undefined,
    );
    await adminQuery(`DROP DATABASE IF EXISTS ${ABORT_DB} WITH (FORCE)`).catch(
      () => undefined,
    );
    await adminQuery(`DROP DATABASE IF EXISTS ${POOL1_DB} WITH (FORCE)`).catch(
      () => undefined,
    );
    await adminQuery(`DROP DATABASE IF EXISTS ${VERIFY_DB} WITH (FORCE)`).catch(
      () => undefined,
    );
  }, 120_000);

  it("ABORTS on a malformed MIGRATION_LOCK_TIMEOUT_MS, before any DDL", async () => {
    await truncateProbe(ABORT_DB);
    process.env.MIGRATION_LOCK_TIMEOUT_MS = "not-a-number";
    const { migrations } = await freshMigrationsFor(ABORT_DB);
    await expect(
      migrations.runMigrations({ force: true, reason: "r20-malformed-lock" }),
    ).rejects.toThrow(/migration_lock_timeout_invalid/);
    /*
      The half that matters. A migration that throws AFTER creating tables has
      still taken unbounded locks; the contract is that it never reaches DDL.
    */
    expect(await probeRows(ABORT_DB)).toEqual([]);
  }, 180_000);

  it("ABORTS when the lock-timeout SET itself fails, before any DDL", async () => {
    await truncateProbe(ABORT_DB);
    delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
    process.env.DATABASE_URL = urlFor(ABORT_DB);
    process.env.DATABASE_URL_UNPOOLED = urlFor(ABORT_DB);
    process.env.ENABLE_RUNTIME_MIGRATIONS = "1";
    vi.resetModules();
    /*
      A REAL pinned lease against the real database, with exactly one statement
      interposed on: the `SET lock_timeout` the whole bound rests on. Everything
      else -- the pool, the backend, the migration -- is genuine, so what this
      proves is what `runMigrations` does when the SET is refused, which the
      swallowed `.catch()` this contract replaced would have ignored.
    */
    vi.doMock("@/lib/db", async () => {
      const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
      return {
        ...actual,
        withPinnedDbClient: (async (fn: (client: unknown) => Promise<unknown>, options?: unknown) =>
          actual.withPinnedDbClient(async (client) => {
            const guarded = async (text: string, params?: unknown[]) => {
              if (/^\s*SET\s+lock_timeout\b/i.test(text)) {
                throw new Error("simulated_set_lock_timeout_failure");
              }
              return (client.query as (t: string, p?: unknown[]) => Promise<unknown>)(
                text,
                params,
              );
            };
            return fn({ ...client, query: guarded });
          }, options as never)) as typeof actual.withPinnedDbClient,
      };
    });
    const dbModule = await import("@/lib/db");
    dbModule.resetDbClientCache();
    const migrations = await import("@/lib/migrations");
    await expect(
      migrations.runMigrations({ force: true, reason: "r20-set-failure" }),
    ).rejects.toThrow(/simulated_set_lock_timeout_failure/);
    expect(await probeRows(ABORT_DB)).toEqual([]);
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  }, 180_000);

  it("ABORTS when the lock-timeout READ-BACK disagrees, before any DDL", async () => {
    await truncateProbe(ABORT_DB);
    delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
    process.env.DATABASE_URL = urlFor(ABORT_DB);
    process.env.DATABASE_URL_UNPOOLED = urlFor(ABORT_DB);
    process.env.ENABLE_RUNTIME_MIGRATIONS = "1";
    vi.resetModules();
    // The SET succeeds; the session read-back reports a DIFFERENT bound. That
    // is the shape a pooling regression takes, and it must stop the run.
    vi.doMock("@/lib/db", async () => {
      const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
      return {
        ...actual,
        withPinnedDbClient: (async (fn: (client: unknown) => Promise<unknown>, options?: unknown) =>
          actual.withPinnedDbClient(async (client) => {
            const guarded = async (text: string, params?: unknown[]) => {
              const result = await (
                client.query as (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }>
              )(text, params);
              if (/lock_timeout_ms/.test(text)) {
                const row = (result.rows[0] ?? {}) as Record<string, unknown>;
                return { ...result, rows: [{ ...row, lock_timeout_ms: "999" }] };
              }
              return result;
            };
            return fn({ ...client, query: guarded });
          }, options as never)) as typeof actual.withPinnedDbClient,
      };
    });
    const dbModule = await import("@/lib/db");
    dbModule.resetDbClientCache();
    const migrations = await import("@/lib/migrations");
    await expect(
      migrations.runMigrations({ force: true, reason: "r20-readback-mismatch" }),
    ).rejects.toThrow(/migration_lock_timeout_unverified/);
    expect(await probeRows(ABORT_DB)).toEqual([]);
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  }, 180_000);

  it("COMPLETES with DB_POOL_MAX=1, which the run used to starve itself on", async () => {
    /*
      ── ROUND 21, ITEM 2 ──────────────────────────────────────────────────────

      `DB_POOL_MAX=1` is a supported configuration. It was also fatal.

      `verifyMigrationSchemaContract` does not run on the migration's client: it
      calls `getDbWithTimeout` (a POOL wrapper) and `runDbTransaction` (which
      leases a client of its own), and both of those used to happen while the
      pinned lease still held the only connection the pool was allowed to open.
      The run therefore waited for a connection that could not be released until
      the run finished -- a deadlock against itself, surfaced as a connection
      timeout or a migration timeout, never as the self-starvation it was.

      The lease is now released before that verifier runs. This drives the REAL
      `runMigrations` from zero, with a real one-connection pool, against a real
      PostgreSQL.
    */
    delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
    const recorded: Array<{ event: string; details: Record<string, unknown> }> = [];
    vi.resetModules();
    vi.doMock("@/lib/startup-diagnostics", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/startup-diagnostics")>(
          "@/lib/startup-diagnostics",
        );
      return {
        ...actual,
        logStartupEvent: (event: string, details: Record<string, unknown>) => {
          recorded.push({ event, details });
        },
      };
    });
    process.env.DB_POOL_MAX = "1";
    const { migrations } = await freshMigrationsFor(POOL1_DB);

    await expect(
      migrations.runMigrations({ force: true, reason: "r21-pool-max-one" }),
    ).resolves.toBeUndefined();

    /*
      NON-VACUITY, IN BOTH DIRECTIONS.

      First: the pool really was limited to one connection. Without this the
      case passes on the default pool of ten and proves nothing at all -- it
      would be the ordinary migration test with a misleading name.
    */
    const poolEvents = recorded.filter(
      (entry) => entry.event === "db_client_initialized",
    );
    expect(poolEvents.length).toBeGreaterThan(0);
    for (const entry of poolEvents) {
      expect(entry.details.poolMax).toBe(1);
    }
    // Second: the run did real work rather than short-circuiting.
    const observed = await probeRows(POOL1_DB);
    expect(observed.length).toBeGreaterThan(1_500);
    // Third: the phase that needs its OWN connection actually ran, and
    // completion was announced after it.
    const verifiedAt = recorded.findIndex(
      (entry) => entry.event === "migrations_schema_verified",
    );
    const completedAt = recorded.findIndex(
      (entry) => entry.event === "migrations_completed",
    );
    expect(verifiedAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThan(verifiedAt);

    vi.doUnmock("@/lib/startup-diagnostics");
    delete process.env.DB_POOL_MAX;
    vi.resetModules();
  }, 900_000);

  it("does NOT announce completion when post-migration verification fails", async () => {
    /*
      The verifier moved out of the pinned lease; it must not have moved out of
      the completion gate with it. If a swallowed DDL failure can still be
      reported as `migrations_completed`, the whole reason the verifier exists
      is gone.

      The failure is INJECTED at the verifier rather than manufactured by
      corrupting the schema: the migration would simply rebuild anything this
      test tore down, so a torn-down object proves nothing about the gate. What
      is real here is everything else -- a real database, a real from-zero run
      that really does the DDL, and the real completion path.
    */
    delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
    const recorded: Array<{ event: string; details: Record<string, unknown> }> = [];
    vi.resetModules();
    vi.doMock("@/lib/startup-diagnostics", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/startup-diagnostics")>(
          "@/lib/startup-diagnostics",
        );
      return {
        ...actual,
        logStartupEvent: (event: string, details: Record<string, unknown>) => {
          recorded.push({ event, details });
        },
        logStartupError: () => undefined,
      };
    });
    vi.doMock("@/lib/migration-verification", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/migration-verification")>(
          "@/lib/migration-verification",
        );
      return {
        ...actual,
        verifyMigrationSchemaContract: async () => {
          throw new actual.MigrationVerificationError([
            {
              kind: "column" as const,
              object: "r21_injected.column",
              detail: "injected post-migration verification failure",
            },
          ]);
        },
      };
    });
    process.env.DATABASE_URL = urlFor(VERIFY_DB);
    process.env.DATABASE_URL_UNPOOLED = urlFor(VERIFY_DB);
    process.env.ENABLE_RUNTIME_MIGRATIONS = "1";
    const dbModule = await import("@/lib/db");
    dbModule.resetDbClientCache();
    const migrations = await import("@/lib/migrations");

    await expect(
      migrations.runMigrations({ force: true, reason: "r21-verification-fails" }),
    ).rejects.toThrow(/verification failed/i);

    // The DDL really ran, so this is the GATE refusing to announce a run that
    // happened -- not a run that never started.
    expect((await probeRows(VERIFY_DB)).length).toBeGreaterThan(1_500);
    // And completion was never announced, in either of its two forms.
    expect(
      recorded.map((entry) => entry.event).filter((event) =>
        event.startsWith("migrations_completed"),
      ),
    ).toEqual([]);
    /*
      The flag stayed false too, which is what a later caller actually reads: a
      second call re-enters the run rather than returning early on a completion
      that never happened.
    */
    await expect(
      migrations.runMigrations({ force: true, reason: "r21-verification-fails-again" }),
    ).rejects.toThrow(/verification failed/i);

    vi.doUnmock("@/lib/migration-verification");
    vi.doUnmock("@/lib/startup-diagnostics");
    vi.resetModules();
  }, 900_000);

  it("runs EVERY migration DDL statement on the single pinned backend", async () => {
    delete process.env.MIGRATION_LOCK_TIMEOUT_MS;
    const recorded: Array<{ event: string; details: Record<string, unknown> }> = [];
    vi.resetModules();
    vi.doMock("@/lib/startup-diagnostics", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/startup-diagnostics")>(
          "@/lib/startup-diagnostics",
        );
      return {
        ...actual,
        logStartupEvent: (event: string, details: Record<string, unknown>) => {
          recorded.push({ event, details });
        },
      };
    });
    const { migrations } = await freshMigrationsFor(TRACE_DB);

    await migrations.runMigrations({
      force: true,
      reason: "r20-ddl-session-boundedness",
    });

    const observed = await probeRows(TRACE_DB);
    /*
      NON-VACUITY FIRST. A migration that executed no DDL would satisfy "one
      distinct backend" trivially, so the volume is asserted before the
      distinctness is.
    */
    // Measured: 2395 DDL events on a from-zero migration. The floor is set
    // well below that and well above anything a truncated run could produce.
    expect(observed.length).toBeGreaterThan(1_500);
    expect(observed.some((row) => row.tag === "CREATE TABLE")).toBe(true);
    expect(observed.some((row) => row.tag === "CREATE INDEX")).toBe(true);

    const distinctPids = new Set(observed.map((row) => row.pid));
    expect([...distinctPids]).toHaveLength(1);

    /*
      AND IT IS THE PINNED ONE. Distinctness alone would pass if every statement
      had escaped to the same second backend, so the observed PID is compared to
      the lease the migration logged -- the backend it proved the lock bound on.
    */
    const preflight = recorded.find((entry) => entry.event === "migrations_preflight");
    expect(preflight).toBeDefined();
    expect(distinctPids.has(Number(preflight?.details.backendPid))).toBe(true);

    /*
      AND THE NATIVE-AD GROUP IS THE POINT. This is the group that used to open
      its own `runDbTransaction` and therefore its own backend, so its objects
      are named explicitly rather than left to a total count -- a future
      regression that moved only this group back off the lease would still
      satisfy every count-shaped assertion above.
    */
    const nativeObjects = observed.filter((row) =>
      row.identity.startsWith("public.engine_v3_ad_"),
    );
    expect(nativeObjects.length).toBeGreaterThan(0);
    expect(
      nativeObjects.some(
        (row) => row.identity === "public.engine_v3_ad_decision_snapshots_daily",
      ),
    ).toBe(true);
    for (const row of nativeObjects) {
      expect(row.pid).toBe(Number(preflight?.details.backendPid));
    }

    /*
      THE PROBE IS SENSITIVE. Everything above would also pass against an
      instrument that cannot see a second backend at all.

      A SEPARATE connection is used rather than the application pool: the pool
      had just released the lease, so it legitimately hands the same backend
      straight back, and a control whose outcome depends on that timing proves
      nothing either way. A distinct connection is a distinct PID by
      construction, which is exactly the property under test -- that DDL run
      somewhere other than the lease SHOWS UP here.
    */
    const escapeClient = new Client({ connectionString: urlFor(TRACE_DB) });
    await escapeClient.connect();
    try {
      const { rows: escapePid } = await escapeClient.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      expect(Number(escapePid[0]!.pid)).not.toBe(
        Number(preflight?.details.backendPid),
      );
      await escapeClient.query(
        "CREATE TABLE r20_escaped_ddl_probe (id integer PRIMARY KEY)",
      );
    } finally {
      await escapeClient.end();
    }
    const afterEscape = await probeRows(TRACE_DB);
    expect(new Set(afterEscape.map((row) => row.pid)).size).toBe(2);
    expect(
      afterEscape.some((row) => row.identity === "public.r20_escaped_ddl_probe"),
    ).toBe(true);

    vi.doUnmock("@/lib/startup-diagnostics");
  }, 900_000);
});
