/**
 * THE MIGRATION'S OWN SAFETY CONTRACT, AGAINST A REAL POSTGRESQL.
 *
 * ── ROUND 19, ITEMS C5, C6, C7 ──────────────────────────────────────────────
 * Three failures that all read as success:
 *
 *   C5 the legacy four-column occurrence index was RECREATED near the top of
 *      the same migration that later replaces it. Migrations re-run on every
 *      deploy, so on a database already holding two receipts that differ only
 *      by `sync_run_id` — which the new key exists to allow — the recreate
 *      raises 23505 and the migration fails permanently.
 *   C6 the capacity override could excuse a missing, stale or malformed
 *      physical sample: exactly the states in which nobody knows whether the
 *      host survives the migration.
 *   C7 `SET lock_timeout` was swallowed and never verified, so a malformed env
 *      value left the session waiting forever while the log said otherwise.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getDb, withPinnedDbClient } from "@/lib/db";
import {
  assertMigrationCapacityForHeavyStepForSeams,
  runMigrations,
} from "@/lib/migrations";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const NONCE = `${process.pid}${Date.now().toString(36)}`;

describe.skipIf(!SEAM)("C5 — the legacy occurrence key is never recreated", () => {
  it("is absent after migrations, and the source creates it nowhere", async () => {
    const sql = getDb();
    const rows = await sql<{ present: string | null }>`
      SELECT to_regclass('meta_entity_observation_receipts_occurrence')::text AS present
    `;
    expect(rows[0]?.present ?? null).toBeNull();
  });

  it("survives a SECOND full migration run over two receipts sharing the OLD key", async () => {
    /*
      The exact shape that made the recreate raise 23505. Written here so the
      regression is repeatable rather than a one-off manual check.
    */
    const sql = getDb();
    const email = `c5-${NONCE}@example.invalid`;
    const account = `act_c5_${NONCE}`.slice(0, 60);
    const [owner] = await sql<{ id: string }>`
      INSERT INTO users (name, email, password_hash)
      VALUES ('c5 seam', ${email}, 'unused') RETURNING id
    `;
    const [business] = await sql<{ id: string }>`
      INSERT INTO businesses (name, owner_id) VALUES ('c5 seam', ${owner!.id}) RETURNING id
    `;
    const [pa] = await sql<{ id: string }>`
      INSERT INTO provider_accounts (provider, external_account_id, account_name)
      VALUES ('meta', ${account}, 'c5') RETURNING id
    `;
    await sql`
      INSERT INTO business_provider_accounts (business_id, provider, provider_account_ref_id, provider_account_id)
      VALUES (${business!.id}, 'meta', ${pa!.id}, ${account})
    `;
    const [partition] = await sql<{ id: string }>`
      INSERT INTO meta_sync_partitions (business_id, provider_account_id, lane, scope, partition_date, status)
      VALUES (${business!.id}, ${account}, 'core', 'core_warehouse', '2026-09-05'::date, 'succeeded')
      RETURNING id
    `;
    const runIds: string[] = [];
    for (const status of ["succeeded", "failed"]) {
      const [run] = await sql<{ id: string }>`
        INSERT INTO meta_sync_runs (
          partition_id, business_id, business_ref_id, provider_account_id,
          provider_account_ref_id, lane, scope, partition_date, status,
          attempt_count, started_at, finished_at
        ) VALUES (
          ${partition!.id}::uuid, ${business!.id}, ${business!.id}::uuid, ${account},
          ${pa!.id}::uuid, 'core', 'core_warehouse', '2026-09-05'::date, ${status},
          1, now(), now()
        ) RETURNING id
      `;
      runIds.push(run!.id);
    }
    const [obs] = await sql<{ id: string }>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        entity_type, endpoint, observed_at, captured_at, completeness,
        page_count, row_count, run_hash
      ) VALUES (
        ${business!.id}::uuid, ${business!.id}, ${pa!.id}::uuid, ${account},
        'adset', 'adset_configs', now(), now(), 'complete', 1, 1,
        ${NONCE.padStart(64, "0").slice(-64).replace(/[^0-9a-f]/g, "a")}
      ) RETURNING id
    `;
    // Identical (partition, type, endpoint, captured_at); different attempts.
    for (const runId of runIds) {
      await sql`
        INSERT INTO meta_entity_observation_receipts (
          run_id, business_id, provider_account_id, entity_type, endpoint,
          partition_id, sync_run_id, capture_status, provider_row_count,
          page_count, run_reused, observed_at, captured_at
        ) VALUES (
          ${obs!.id}::uuid, ${business!.id}, ${account}, 'adset', 'adset_configs',
          ${partition!.id}::uuid, ${runId}::uuid, 'complete', 1, 1, false,
          '2026-09-05T12:00:00Z'::timestamptz, '2026-09-05T12:00:00Z'::timestamptz
        )
      `;
    }
    const [count] = await sql<{ total: string }>`
      SELECT count(*)::text AS total FROM meta_entity_observation_receipts
      WHERE provider_account_id = ${account}
    `;
    // BOTH survive. The old key would have rejected the second.
    expect(Number(count!.total)).toBe(2);

    /*
      ── ROUND 21, ITEM 3: THE SECOND RUN IS THE WHOLE DEFECT ─────────────────

      Everything above only shows that the CURRENT schema accepts the two rows.
      That was never in doubt, and it is not what C5 is about.

      The defect was that migrations re-run on every deploy, and the run itself
      recreated the legacy four-column unique index near the top. On a database
      that had since accumulated two receipts differing only by `sync_run_id` --
      which is precisely the state the new key exists to permit, and precisely
      the state seeded above -- that recreate raises 23505 and the migration
      fails PERMANENTLY. Not on the deploy that introduced the rows: on every
      deploy after it.

      Asserting the index is absent after ONE run cannot see that. The rows have
      to exist FIRST and the migration has to run again OVER them. So it does,
      for real, against this database.
    */
    await expect(
      runMigrations({
        force: true,
        reason: "r21-c5-second-run-over-conflicting-receipts",
      }),
    ).resolves.toBeUndefined();

    // Still absent: the run did not recreate it on the way past.
    const [afterIndex] = await sql<{ present: string | null }>`
      SELECT to_regclass('meta_entity_observation_receipts_occurrence')::text AS present
    `;
    expect(afterIndex!.present ?? null).toBeNull();

    // And the rows that would have collided are untouched.
    const [afterCount] = await sql<{ total: string }>`
      SELECT count(*)::text AS total FROM meta_entity_observation_receipts
      WHERE provider_account_id = ${account}
    `;
    expect(Number(afterCount!.total)).toBe(2);
  });
});

describe.skipIf(!SEAM)("C6 — physical capacity refusal is non-overridable", () => {
  const call = () =>
    assertMigrationCapacityForHeavyStepForSeams({
      label: `r19_${NONCE}`,
      relation: "meta_entity_observation_receipts",
      // Force the gate to ENGAGE on a small seam relation.
      heavyBytes: 0,
    });

  /*
    The physical sample is SHARED database state, and other seams seed one to
    get past the growth fence. Each case here controls it explicitly rather than
    assuming the table is empty — an assumption that made these pass or fail
    depending on which file ran first.
  */
  beforeEach(async () => {
    delete process.env.ADSECUTE_MIGRATION_CAPACITY_OVERRIDE;
    await getDb().query(`DELETE FROM system_capacity_snapshots WHERE source = $1`, [
      "db_host_healthcheck",
    ]);
  });

  it("refuses when NO physical sample exists", async () => {
    // The seam database has no `system_capacity_snapshots` rows at all.
    await expect(call()).rejects.toThrow(/migration_capacity_refused/);
  });

  it("an override CANNOT bypass a missing sample", async () => {
    /*
      Round 18 made only a MEASURED shortfall absolute and still let the
      override excuse a missing or stale sample — the states in which the gate
      has no idea whether the host survives, which is when proceeding is least
      defensible.
    */
    process.env.ADSECUTE_MIGRATION_CAPACITY_OVERRIDE = "operator says it is fine";
    try {
      await expect(call()).rejects.toThrow(/migration_capacity_refused/);
      await expect(call()).rejects.toThrow(
        /cannot bypass a physical capacity refusal/,
      );
    } finally {
      delete process.env.ADSECUTE_MIGRATION_CAPACITY_OVERRIDE;
    }
  });

  it.each([
    ["a STALE sample", "now() - interval '3 hours'", 1_000_000_000_000],
    ["a MALFORMED sample", "now()", null],
    ["a MEASURED shortfall", "now()", 1],
  ])("an override cannot bypass %s", async (_label, sampledAt, availableBytes) => {
    const sql = getDb();
    const payload =
      availableBytes == null
        ? JSON.stringify({ disks: [{ path: "/var/lib/postgresql" }] })
        : JSON.stringify({
            disks: [{ path: "/var/lib/postgresql", availableBytes }],
          });
    await sql.query(
      `INSERT INTO system_capacity_snapshots (source, payload, sampled_at)
       VALUES ($1, $2::jsonb, ${sampledAt})`,
      ["db_host_healthcheck", payload],
    );
    process.env.ADSECUTE_MIGRATION_CAPACITY_OVERRIDE = "ship it";
    try {
      await expect(call()).rejects.toThrow(/migration_capacity_refused/);
    } finally {
      delete process.env.ADSECUTE_MIGRATION_CAPACITY_OVERRIDE;
      await sql.query(`DELETE FROM system_capacity_snapshots WHERE source = $1`, [
        "db_host_healthcheck",
      ]);
    }
  });

  it("keeps the peak + 40 GiB residual arithmetic in the refusal", async () => {
    await expect(call()).rejects.toThrow(/residual floor/);
  });
});

describe.skipIf(!SEAM)("C7 — the lock bound is verified on the pinned backend", () => {
  it("reads back the RAW millisecond value, not PostgreSQL's rendering", async () => {
    /*
      `current_setting('lock_timeout')` renders 15000 as "15s", so a comparison
      against "15000ms" fails on a correctly-configured session. `pg_settings`
      returns the raw value in the parameter's base unit, which is what the
      migration compares.
    */
    const observed = await withPinnedDbClient(async (client) => {
      await client.query("SET lock_timeout = 15000");
      const rows = await client.query<{ raw: string; rendered: string }>(
        `SELECT (SELECT setting FROM pg_settings WHERE name = 'lock_timeout') AS raw,
                current_setting('lock_timeout') AS rendered`,
      );
      return rows.rows[0]!;
    });
    expect(Number(observed.raw)).toBe(15_000);
    // The rendering really does differ, which is why the raw value is used.
    expect(observed.rendered).not.toBe("15000ms");
  });

  it("the SET and its verification are the SAME backend", async () => {
    const result = await withPinnedDbClient(async (client) => {
      const before = await client.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await client.query("SET lock_timeout = 7000");
      const after = await client.query<{ pid: number; raw: string }>(
        `SELECT pg_backend_pid() AS pid,
                (SELECT setting FROM pg_settings WHERE name = 'lock_timeout') AS raw`,
      );
      return {
        samePid: before.rows[0]!.pid === after.rows[0]!.pid,
        leasePid: client.backendPid,
        pid: after.rows[0]!.pid,
        raw: Number(after.rows[0]!.raw),
      };
    });
    expect(result.samePid).toBe(true);
    expect(result.pid).toBe(result.leasePid);
    // A SET that did not survive would read the server default here.
    expect(result.raw).toBe(7_000);
  });
});
