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
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { appendObservationCaptureReceipt, META_OBSERVATION_RECEIPT_CONTRACT } from "@/lib/meta/entity-state-history";
import { META_OBSERVATION_RECEIPT_AUTHORITY_SQL } from "@/lib/meta/observation-receipt-schema";

import { getDb, withPinnedDbClient } from "@/lib/db";
import {
  assertMigrationCapacityForHeavyStepForSeams,
  runMigrations,
} from "@/lib/migrations";

const SEAM = process.env.ADSECUTE_EPHEMERAL_DB_SEAM === "1";
const NONCE = `${process.pid}${Date.now().toString(36)}`;

describe.skipIf(!SEAM)("C5 — deployed writer and attempt-scoped writer remain compatible", () => {
  it("retains the deployed four-column arbiter on the legacy table", async () => {
    const sql = getDb();
    const rows = await sql<{ present: string | null }>`
      SELECT to_regclass('meta_entity_observation_receipts_occurrence')::text AS present
    `;
    expect(rows[0]?.present).toBe("meta_entity_observation_receipts_occurrence");
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
    // Execute the deployed source itself, not a retyped approximation of its
    // ON CONFLICT clause. Its migration and writer must survive image rollback.
    const deployedRef = "a2eb1b1b1dae9e69ffe470c39ada19731a570224";
    const deployedSource = execFileSync("git", ["show", `${deployedRef}:lib/meta/entity-state-history.ts`], { encoding: "utf8" });
    const tree = ts.createSourceFile("deployed.ts", deployedSource, ts.ScriptTarget.Latest, true);
    const declaration = tree.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "appendObservationCaptureReceipt");
    expect(declaration).toBeDefined();
    const compiled = ts.transpileModule(`export ${declaration!.getText(tree)}`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, unknown> = {};
    new Function("exports", "UUID_PATTERN", "META_OBSERVATION_RECEIPT_CONTRACT", compiled)(
      exports, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      META_OBSERVATION_RECEIPT_CONTRACT,
    );
    const oldWriter = exports.appendObservationCaptureReceipt as typeof appendObservationCaptureReceipt;
    const oldMigrations = execFileSync("git", ["show", `${deployedRef}:lib/migrations.ts`], { encoding: "utf8" });
    const oldDdl = oldMigrations.match(/sql`(CREATE UNIQUE INDEX IF NOT EXISTS meta_entity_observation_receipts_occurrence[^`]+)`/)?.[1];
    expect(oldDdl).toBeDefined();
    await sql.query(oldDdl!);
    const input = {
      runId: obs!.id, businessId: business!.id, providerAccountId: account,
      entityType: "adset" as const, endpoint: "adset_configs", partitionId: partition!.id,
      sourceSnapshotId: null, sourceSnapshotRefId: null, syncRunId: null,
      captureStatus: "complete" as const, providerRowCount: 1, pageCount: 1,
      runReused: false, observedAt: "2026-09-05T12:00:00Z", capturedAt: "2026-09-05T12:00:00Z", error: null,
    };
    const counts = async () => (await sql.query<{ legacy: number; attempts: number; authority: number }>(`
      SELECT (SELECT count(*)::int FROM meta_entity_observation_receipts WHERE provider_account_id=$1) AS legacy,
             (SELECT count(*)::int FROM meta_entity_observation_receipts_v2 WHERE provider_account_id=$1) AS attempts,
             (SELECT count(*)::int FROM (${META_OBSERVATION_RECEIPT_AUTHORITY_SQL}) rc WHERE provider_account_id=$1) AS authority
    `, [account]))[0];
    await oldWriter(sql, input);
    await oldWriter(sql, input);
    await appendObservationCaptureReceipt(sql, input);
    expect(await counts()).toEqual({ legacy: 1, attempts: 0, authority: 1 });
    for (const syncRunId of runIds) {
      await appendObservationCaptureReceipt(sql, { ...input, syncRunId });
      await appendObservationCaptureReceipt(sql, { ...input, syncRunId });
    }
    expect(await counts()).toEqual({ legacy: 1, attempts: 2, authority: 3 });
    await expect(sql.query(`CREATE UNIQUE INDEX c5_impossible_old_key_${NONCE.toLowerCase()} ON meta_entity_observation_receipts_v2 (partition_id, entity_type, endpoint, captured_at)`)).rejects.toMatchObject({ code: "23505" });
    // The unmodified old migration still converges AFTER v2 has colliding keys.
    await sql.query(oldDdl!);
    const later = { ...input, observedAt: "2026-09-05T12:01:00Z", capturedAt: "2026-09-05T12:01:00Z" };
    await oldWriter(sql, later);
    await appendObservationCaptureReceipt(sql, later);
    await expect(appendObservationCaptureReceipt(sql, { ...later, providerRowCount: 2 })).rejects.toThrow("DIFFERENT occurrence");
    expect(await counts()).toEqual({ legacy: 2, attempts: 2, authority: 4 });
    // New first occurrence mirrors one UUID; new exact retries stay one row.
    const newest = { ...input, syncRunId: runIds[0]!, observedAt: "2026-09-05T12:02:00Z", capturedAt: "2026-09-05T12:02:00Z" };
    await appendObservationCaptureReceipt(sql, newest);
    await appendObservationCaptureReceipt(sql, newest);
    expect(await counts()).toEqual({ legacy: 3, attempts: 3, authority: 5 });
    const retained = await sql.query(`SELECT id::text, run_id::text, sync_run_id::text, captured_at::text FROM (${META_OBSERVATION_RECEIPT_AUTHORITY_SQL}) rc WHERE provider_account_id=$1 ORDER BY captured_at, id`, [account]);
    await expect(runMigrations({ force: true, reason: "additive-receipts-old-image-forward-replay" })).resolves.toBeUndefined();
    await sql.query(oldDdl!);
    expect(await sql.query(`SELECT id::text, run_id::text, sync_run_id::text, captured_at::text FROM (${META_OBSERVATION_RECEIPT_AUTHORITY_SQL}) rc WHERE provider_account_id=$1 ORDER BY captured_at, id`, [account])).toEqual(retained);
    expect(await counts()).toEqual({ legacy: 3, attempts: 3, authority: 5 });

  });
  it("retries JSONB errors losslessly in both receipt tables and refuses changed facts", async () => {
    const sql = getDb();
    const account = `act_jsonb_${NONCE}`.slice(0, 60);
    const [owner] = await sql<{ id: string }>`
      INSERT INTO users (name, email, password_hash)
      VALUES ('JSONB receipt seam', ${`jsonb-${NONCE}@example.invalid`}, 'unused') RETURNING id
    `;
    const [business] = await sql<{ id: string }>`
      INSERT INTO businesses (name, owner_id)
      VALUES ('JSONB receipt seam', ${owner!.id}) RETURNING id
    `;
    const [providerAccount] = await sql<{ id: string }>`
      INSERT INTO provider_accounts (provider, external_account_id, account_name)
      VALUES ('meta', ${account}, 'JSONB receipt seam') RETURNING id
    `;
    await sql`
      INSERT INTO business_provider_accounts (business_id, provider, provider_account_ref_id, provider_account_id)
      VALUES (${business!.id}, 'meta', ${providerAccount!.id}, ${account})
    `;
    const [partition] = await sql<{ id: string }>`
      INSERT INTO meta_sync_partitions (business_id, provider_account_id, lane, scope, partition_date, status)
      VALUES (${business!.id}, ${account}, 'core', 'core_warehouse', '2026-09-05'::date, 'failed') RETURNING id
    `;
    const error = {
      pagination: {
        complete: false,
        pageCount: 0,
        termination: "failed",
        failure: { kind: "graph", httpStatus: 400, errorCode: 100, isTransient: false },
        attemptedPages: [1, 2],
      },
      invalidRowCount: 0,
    };
    const [observation] = await sql<{ id: string }>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        entity_type, endpoint, observed_at, captured_at, completeness, page_count, row_count, run_hash, error_json
      ) VALUES (
        ${business!.id}::uuid, ${business!.id}, ${providerAccount!.id}::uuid, ${account},
        'campaign', 'campaign_configs', '2026-09-05T12:00:00Z'::timestamptz,
        '2026-09-05T12:00:00Z'::timestamptz, 'failed', 0, 0,
        ${`b${NONCE}`.padStart(64, '0').slice(-64).replace(/[^0-9a-f]/g, 'a')}, ${JSON.stringify(error)}::jsonb
      ) RETURNING id
    `;
    const input = {
      runId: observation!.id, businessId: business!.id, providerAccountId: account,
      entityType: "campaign" as const, endpoint: "campaign_configs", partitionId: partition!.id,
      sourceSnapshotId: null, sourceSnapshotRefId: null, syncRunId: null,
      captureStatus: "failed" as const, providerRowCount: 0, pageCount: 0, runReused: false,
      observedAt: "2026-09-05T12:00:00Z", capturedAt: "2026-09-05T12:00:00Z", error,
    };
    await appendObservationCaptureReceipt(sql, input);
    const stored = await sql.query<{ error_json: unknown }>(
      `SELECT error_json FROM meta_entity_observation_receipts_v2 WHERE provider_account_id = $1`, [account],
    );
    // This really crosses PostgreSQL's JSONB boundary; the former serialized
    // comparison rejects these identical facts solely because keys moved.
    expect(stored[0]!.error_json).toEqual(error);
    expect(JSON.stringify(stored[0]!.error_json)).not.toBe(JSON.stringify(error));
    await sql.query(`
      INSERT INTO meta_entity_observation_receipts (
        receipt_contract, run_id, business_id, provider_account_id, entity_type, endpoint,
        partition_id, capture_status, provider_row_count, page_count, run_reused,
        observed_at, captured_at, error_json
      ) SELECT receipt_contract, run_id, business_id, provider_account_id, entity_type, endpoint,
               partition_id, capture_status, provider_row_count, page_count, run_reused,
               observed_at, '2026-09-05T12:01:00Z'::timestamptz, error_json
          FROM meta_entity_observation_receipts_v2 WHERE provider_account_id = $1
    `, [account]);
    for (const capturedAt of [input.capturedAt, "2026-09-05T12:01:00Z"]) {
      await expect(appendObservationCaptureReceipt(sql, { ...input, capturedAt })).resolves.toBeUndefined();
      await expect(appendObservationCaptureReceipt(sql, {
        ...input, capturedAt,
        error: {
          invalidRowCount: 0,
          pagination: { attemptedPages: [1, 2], failure: { isTransient: false, errorCode: 100, httpStatus: 400, kind: "graph" }, termination: "failed", pageCount: 0, complete: false },
        },
      })).resolves.toBeUndefined();
      for (const changedError of [
        { ...error, pagination: { ...error.pagination, failure: { ...error.pagination.failure, errorCode: 190 } } },
        { ...error, pagination: { ...error.pagination, attemptedPages: [2, 1] } },
      ]) {
        await expect(appendObservationCaptureReceipt(sql, { ...input, capturedAt, error: changedError }))
          .rejects.toThrow("error_json");
      }
    }
    expect(await sql.query(`
      SELECT (SELECT count(*)::int FROM meta_entity_observation_receipts_v2 WHERE provider_account_id = $1) AS attempts,
             (SELECT count(*)::int FROM meta_entity_observation_receipts WHERE provider_account_id = $1) AS legacy,
             (SELECT count(*)::int FROM (${META_OBSERVATION_RECEIPT_AUTHORITY_SQL}) receipt WHERE provider_account_id = $1) AS authority
    `, [account])).toEqual([{ attempts: 1, legacy: 2, authority: 2 }]);
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
