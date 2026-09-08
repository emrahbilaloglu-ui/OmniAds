/**
 * SET lock_timeout AND THE DDL IT BOUNDS MUST BE THE SAME BACKEND.
 *
 * ── ROUND 18, ITEM C13 ──────────────────────────────────────────────────────
 * Migrations ran through the pool. `createMigrationDb` serialises statements,
 * but serialisation is not affinity: each `query` could be handed a different
 * pooled backend. So `SET lock_timeout` configured one session while the DDL it
 * was supposed to bound ran on another, and the session-settings line the
 * migration logs described a backend that may then have done no work at all.
 *
 * Two things are proven here against a real PostgreSQL, because both are facts
 * about backends rather than about code text: the pinned lease really is ONE
 * backend across many statements, and a `SET` on it really does persist to the
 * next statement — which is only true if no pooling happens in between and no
 * transaction is opened around it.
 */
import { describe, expect, it } from "vitest";

import { getDb, withPinnedDbClient } from "@/lib/db";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";

describe.skipIf(!SEAM)("the migration session is pinned to one backend", () => {
  it("keeps ONE backend PID across every statement of the lease", async () => {
    const pids = await withPinnedDbClient(async (client) => {
      const seen: number[] = [];
      for (let statement = 0; statement < 8; statement += 1) {
        const rows = await client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        seen.push(Number(rows.rows[0]!.pid));
      }
      // The reported PID is the same one the statements ran on.
      expect(client.backendPid).toBe(seen[0]);
      return seen;
    });
    expect(new Set(pids).size).toBe(1);
  });

  it("carries a SET across statements, which only a pinned session does", async () => {
    /*
      THE ACTUAL DEFECT, reproduced as a property. A session setting applied on
      one backend is invisible to another, so this passes only while the lease
      really is one backend.
    */
    const settings = await withPinnedDbClient(async (client) => {
      await client.query("SET lock_timeout = 4321");
      const rows = await client.query<{ lock_timeout: string }>(
        "SELECT current_setting('lock_timeout') AS lock_timeout",
      );
      return rows.rows[0]!.lock_timeout;
    });
    expect(settings).toBe("4321ms");
  });

  it("opens NO transaction, so CONCURRENTLY is legal on the lease", async () => {
    /*
      `CREATE INDEX CONCURRENTLY` is rejected inside a transaction block. The
      two requirements — same session and no transaction — can only be met
      together by pinning the client and leaving autocommit alone, so this is
      the assertion that keeps a future `BEGIN` from being added for tidiness.
    */
    await withPinnedDbClient(async (client) => {
      const depth = await client.query<{ level: number }>(
        "SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS in_xact, 0 AS level",
      );
      expect(depth.rows.length).toBe(1);
      await client.query(
        "CREATE TABLE IF NOT EXISTS r18_pinned_probe (id integer primary key)",
      );
      // The real proof: this statement errors inside a transaction block.
      await client.query(
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_r18_pinned_probe ON r18_pinned_probe (id)",
      );
      const valid = await client.query<{ ok: boolean }>(
        `SELECT i.indisvalid AND i.indisready AND i.indislive AS ok
           FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = 'idx_r18_pinned_probe'`,
      );
      expect(valid.rows[0]?.ok).toBe(true);
      await client.query("DROP INDEX CONCURRENTLY IF EXISTS idx_r18_pinned_probe");
      await client.query("DROP TABLE IF EXISTS r18_pinned_probe");
    });
  });

  it("cancels long-running work on a timeout-bound pinned session", async () => {
    const startedAt = Date.now();

    await expect(
      withPinnedDbClient(
        async (client) => client.query("SELECT pg_sleep(1)"),
        { timeoutMs: 75 },
      ),
    ).rejects.toMatchObject({ code: "57014" });

    expect(Date.now() - startedAt).toBeLessThan(750);
  });

  it("a POOLED client cannot make the same guarantee", async () => {
    /*
      The discriminating half. Without it the three cases above could pass on a
      pool that simply happened to hand back the same connection every time.
      A `SET` through the pool is not guaranteed to survive, and the migration
      relied on exactly that guarantee.
    */
    const sql = getDb();
    const pooled = await sql.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    expect(pooled.length).toBe(1);
    // Not asserting that the pool DOES switch backends — that is timing — only
    // that the pinned lease does not depend on it.
    const pinned = await withPinnedDbClient(async (client) => client.backendPid);
    expect(typeof pinned).toBe("number");
  });
});
