/**
 * A1-A6 — the release-gate anti-runaway contract, against a real PostgreSQL
 * holding real volume.
 *
 * `sync_release_gates` reached ~1.35 GB because two mistakes reinforced each
 * other: every evaluation appended a row, and every read scanned the whole
 * build's history to answer a one-row question. Each made the other worse.
 *
 * A unit test cannot show either. Coalescing looks correct on three rows; a
 * scan looks fast on three rows. So this seam seeds real volume, pins
 * `work_mem` low enough that any sort or hash spills to disk, and sets
 * `temp_file_limit = 0` so a spill is an ERROR rather than a slow query. Under
 * those settings the production statements either use the intended indexes or
 * they fail loudly.
 *
 *   A1  seeded volume, and the production queries plan on the intended indexes
 *   A2  no temp files under work_mem=64kB / temp_file_limit=0
 *   A3  deterministic ties and exact provider-scope separation
 *   A4  concurrent identical evaluations coalesce to one row
 *   A5  a genuine transition appends; retention never deletes current evidence
 *   A6  negative control: drop or drift each contract object, prove refusal
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "release_gate_plan_seam";
const USER = "postgres";
const LABEL = "[release-gate-plan-seam]";

/**
 * Enough rows that a sequential scan or a sort is unmistakable, and enough
 * distinct builds that the seeded shape resembles a real deployment history
 * rather than one pathological key.
 */
const SEED_ROWS = 500_000;
const SEED_BUILDS = 2_000;
const TARGET_BUILD = "build-under-test";
const TARGET_ENV = "production";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`release-gate plan seam FAILED: ${message}`);
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

/** The exact statement `readLatestSyncGateRow` issues for an exact key. */
const EXACT_READ_SQL = `
  SELECT id, build_id, environment, gate_kind, gate_scope, provider_scope,
         mode, base_result, verdict, blocker_class, summary, break_glass,
         override_reason, evidence_json, emitted_at, last_seen_at, coalesced_count
  FROM sync_release_gates
  WHERE build_id = $1
    AND environment = $2
    AND gate_kind = $3
    AND COALESCE(provider_scope, 'meta') = $4
  ORDER BY emitted_at DESC, id DESC
  LIMIT 1
`;

/** The build-scoped fallback read. */
const FALLBACK_READ_SQL = `
  SELECT id, build_id, environment, gate_kind, emitted_at
  FROM sync_release_gates
  WHERE build_id = $1
    AND gate_kind = $2
    AND COALESCE(provider_scope, 'meta') = $3
  ORDER BY emitted_at DESC, id DESC
  LIMIT 1
`;

/** The unkeyed-by-build diagnostic read used by /build-info. */
const KIND_READ_SQL = `
  SELECT id, build_id, environment, gate_kind, emitted_at
  FROM sync_release_gates
  WHERE gate_kind = $1
    AND COALESCE(provider_scope, 'meta') = $2
  ORDER BY emitted_at DESC, id DESC
  LIMIT 1
`;

async function seedVolume(client: Client) {
  // generate_series in one statement: 500k round-trips would dominate runtime
  // and prove nothing extra.
  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict, blocker_class,
       summary, break_glass, override_reason, evidence_json,
       emitted_at, last_seen_at, coalesced_count
     )
     SELECT
       'seed-build-' || (series % $2),
       CASE WHEN series % 3 = 0 THEN 'production' ELSE 'staging' END,
       CASE WHEN series % 2 = 0 THEN 'deploy_gate' ELSE 'release_gate' END,
       'release_readiness',
       CASE WHEN series % 5 = 0 THEN 'google_ads' ELSE 'meta' END,
       md5(series::text),
       'measure_only', 'pass', 'pass', NULL,
       'seeded', FALSE, NULL, '{}'::jsonb,
       now() - make_interval(secs => series),
       now() - make_interval(secs => series),
       1
     FROM generate_series(1, $1) AS series`,
    [SEED_ROWS, SEED_BUILDS],
  );
  await client.query(`ANALYZE sync_release_gates`);
}

async function explain(client: Client, sql: string, values: unknown[]) {
  const rows = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
    values,
  );
  return rows.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

// ── A1 + A2. Plans and temp files under real volume ────────────────────────

async function verifyPlans(client: Client) {
  const seeded = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM sync_release_gates`,
  );
  assert(
    Number(seeded.rows[0]!.count) >= SEED_ROWS,
    `A1: expected at least ${SEED_ROWS} seeded rows, found ${seeded.rows[0]!.count}.`,
  );

  // 64kB is below the smallest sort PostgreSQL will do in memory for this row
  // width, and temp_file_limit=0 turns any spill into an ERROR. Together they
  // convert "this query is slow" into "this query fails", which is the only
  // form a test can assert on reliably.
  await client.query(`SET work_mem = '64kB'`);
  await client.query(`SET temp_file_limit = 0`);

  const cases: Array<{ label: string; sql: string; values: unknown[]; index: string }> = [
    {
      label: "exact key",
      sql: EXACT_READ_SQL,
      values: [TARGET_BUILD, TARGET_ENV, "release_gate", "meta"],
      index: "idx_sync_release_gates_key_latest",
    },
    {
      label: "build fallback",
      sql: FALLBACK_READ_SQL,
      values: [TARGET_BUILD, "release_gate", "meta"],
      index: "idx_sync_release_gates_key_latest",
    },
    {
      label: "kind diagnostic",
      sql: KIND_READ_SQL,
      values: ["release_gate", "google_ads"],
      index: "idx_sync_release_gates_kind_latest",
    },
  ];

  for (const testCase of cases) {
    const plan = await explain(client, testCase.sql, testCase.values);
    assert(
      plan.includes(testCase.index),
      `A1: the ${testCase.label} read did not use ${testCase.index}:\n${plan}`,
    );
    assert(
      !/Seq Scan on sync_release_gates/.test(plan),
      `A1: the ${testCase.label} read fell back to a sequential scan:\n${plan}`,
    );
    // A sort here would mean the index ordering is not being used, which is the
    // difference between reading one row and ordering the whole matching set.
    assert(
      !/Sort Method: external/.test(plan),
      `A2: the ${testCase.label} read spilled a sort to disk:\n${plan}`,
    );
    assert(
      !/temp read=|temp written=/.test(plan),
      `A2: the ${testCase.label} read wrote temp files under temp_file_limit=0:\n${plan}`,
    );
  }

  // The two shapes that were removed, each shown to be wrong for a different
  // reason. Neither is about raw speed.
  //
  // (1) The exact read had NO LIMIT, so it returned every row for the key and
  //     picked the first in JavaScript. Its cost is the size of the history,
  //     which is precisely what the runaway was growing.
  const unbounded = await client.query(
    `SELECT id FROM sync_release_gates
     WHERE build_id = $1 AND environment = $2
     ORDER BY emitted_at DESC`,
    ["seed-build-1", "staging"],
  );
  assert(
    unbounded.rowCount != null && unbounded.rowCount > 50,
    `A2: the seeded history for one key is only ${unbounded.rowCount} rows, too small to demonstrate that the removed unbounded read grew with history.`,
  );

  // (2) The unkeyed `ORDER BY emitted_at DESC LIMIT 100` could not answer the
  //     question at all. It returns the 100 globally-newest rows and then looks
  //     for a matching gate kind and scope among them — so a key whose newest
  //     row is older than 100 other rows is simply invisible. Here the target
  //     build's row exists and the keyed read finds it; the old shape does not.
  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict, summary,
       evidence_json, emitted_at, last_seen_at, coalesced_count
     ) VALUES ($1, $2, 'release_gate', 'release_readiness', 'meta',
               'buried', 'block', 'fail', 'blocked', 'buried-but-current',
               '{}'::jsonb, now() - interval '10 days', now() - interval '10 days', 1)`,
    [TARGET_BUILD, TARGET_ENV],
  );
  const oldStyle = await client.query<{ build_id: string; gate_kind: string }>(
    `SELECT build_id, gate_kind FROM sync_release_gates
     ORDER BY emitted_at DESC
     LIMIT 100`,
  );
  const foundByOldStyle = oldStyle.rows.some(
    (row) => row.build_id === TARGET_BUILD && row.gate_kind === "release_gate",
  );
  assert(
    !foundByOldStyle,
    "A2: the seeded data does not bury the target row deep enough for the LIMIT 100 shape to miss it, so this control proves nothing.",
  );
  const keyed = await client.query<{ summary: string }>(EXACT_READ_SQL, [
    TARGET_BUILD,
    TARGET_ENV,
    "release_gate",
    "meta",
  ]);
  assert(
    keyed.rows[0]?.summary === "buried-but-current",
    `A2: the keyed read did not find the current row the LIMIT 100 shape missed: ${JSON.stringify(keyed.rows[0])}`,
  );

  await client.query(`RESET temp_file_limit`);
  await client.query(`RESET work_mem`);
  console.log(
    `${LABEL} A1-A2 PASS plans: ${SEED_ROWS} seeded rows across ${SEED_BUILDS} builds; all 3 production reads use their intended index with no sort and no temp file under work_mem=64kB and temp_file_limit=0. The removed shapes are shown wrong on their own terms: the unbounded exact read returns ${unbounded.rowCount} rows to answer a one-row question, and the unkeyed LIMIT 100 read cannot see a current row the keyed read returns immediately`,
  );
}

// ── A3. Deterministic ties and exact provider scope ────────────────────────

async function verifyDeterminismAndScope(client: Client) {
  const { getLatestSyncGateRecords } = await import("@/lib/sync/release-gates");
  // Its own build, so nothing seeded or inserted by an earlier case can be the
  // newest row for these keys and change what "latest" means here.
  const TIE_BUILD = "tie-build";

  // Two rows at the SAME instant. Without the id tie-break the planner may
  // return either, so two readers can disagree about the current verdict.
  const sameInstant = "2026-07-01T00:00:00.000Z";
  const ids: string[] = [];
  for (const verdict of ["pass", "blocked"]) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO sync_release_gates (
         build_id, environment, gate_kind, gate_scope, provider_scope,
         decision_fingerprint, mode, base_result, verdict, summary,
         evidence_json, emitted_at, last_seen_at, coalesced_count
       ) VALUES ($1, $2, 'release_gate', 'release_readiness', 'meta',
                 $3, 'block', $4, $5, 'tie', '{}'::jsonb, $6, $6, 1)
       RETURNING id::text AS id`,
      [
        TIE_BUILD,
        TARGET_ENV,
        `tie-${verdict}`,
        verdict === "pass" ? "pass" : "fail",
        verdict,
        sameInstant,
      ],
    );
    ids.push(row.rows[0]!.id);
  }
  const expected = [...ids].sort().reverse()[0];

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const latest = await getLatestSyncGateRecords({
      buildId: TIE_BUILD,
      environment: TARGET_ENV,
      providerScope: "meta",
    });
    assert(
      latest.releaseGate?.id === expected,
      `A3: a same-instant tie resolved to ${latest.releaseGate?.id} on attempt ${attempt}, expected the highest id ${expected}.`,
    );
  }

  // Provider scopes must not bleed. A google_ads verdict must never answer a
  // meta question, and legacy rows with NULL provider_scope must still read as
  // meta — which is what the old evidence-JSON semantics meant.
  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict, summary,
       evidence_json, emitted_at, last_seen_at, coalesced_count
     ) VALUES ($1, $2, 'release_gate', 'release_readiness', 'google_ads',
               'scope-google', 'block', 'fail', 'blocked', 'google',
               '{"providerScope":"google_ads"}'::jsonb, $3, $3, 1)`,
    [TIE_BUILD, TARGET_ENV, "2026-07-02T00:00:00.000Z"],
  );
  const googleLatest = await getLatestSyncGateRecords({
    buildId: TIE_BUILD,
    environment: TARGET_ENV,
    providerScope: "google_ads",
  });
  assert(
    googleLatest.releaseGate?.summary === "google",
    `A3: the google_ads scope did not return its own row: ${JSON.stringify(googleLatest.releaseGate)}`,
  );
  const metaLatest = await getLatestSyncGateRecords({
    buildId: TIE_BUILD,
    environment: TARGET_ENV,
    providerScope: "meta",
  });
  assert(
    metaLatest.releaseGate?.summary !== "google",
    "A3: a google_ads row answered a meta question.",
  );

  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict, summary,
       evidence_json, emitted_at, last_seen_at, coalesced_count
     ) VALUES ($1, $2, 'deploy_gate', 'runtime_contract', NULL,
               'legacy-null', 'block', 'pass', 'pass', 'legacy-null-scope',
               '{}'::jsonb, $3, $3, 1)`,
    [TIE_BUILD, TARGET_ENV, "2026-07-03T00:00:00.000Z"],
  );
  const legacyLatest = await getLatestSyncGateRecords({
    buildId: TIE_BUILD,
    environment: TARGET_ENV,
    providerScope: "meta",
  });
  assert(
    legacyLatest.deployGate?.summary === "legacy-null-scope",
    `A3: a legacy NULL provider_scope row was not readable as meta: ${JSON.stringify(legacyLatest.deployGate)}`,
  );

  console.log(
    `${LABEL} A3 PASS determinism: a same-instant tie resolves to the same row on 5 consecutive reads, google_ads and meta scopes stay separate, and a legacy NULL scope still reads as meta`,
  );
}

// ── A4 + A5. Coalescing, transitions and retention ─────────────────────────

async function verifyCoalescingAndRetention(client: Client) {
  const { upsertSyncGateRecord, pruneSyncGateRecords } = await import(
    "@/lib/sync/release-gates"
  );

  const buildId = "coalesce-build";
  const base = {
    gateKind: "release_gate" as const,
    gateScope: "release_readiness" as const,
    buildId,
    environment: TARGET_ENV,
    mode: "block" as const,
    baseResult: "pass" as const,
    verdict: "pass" as const,
    blockerClass: null,
    summary: "first",
    breakGlass: false,
    overrideReason: null,
    evidence: { providerScope: "meta", queueDepth: 1 },
  };

  const countRows = async () =>
    Number(
      (
        await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM sync_release_gates WHERE build_id = $1`,
          [buildId],
        )
      ).rows[0]!.count,
    );

  await upsertSyncGateRecord({ ...base, emittedAt: "2026-07-10T00:00:00.000Z" });
  assert((await countRows()) === 1, "A4: the first evaluation did not create a row.");

  // Twenty more identical decisions, with moving evidence, exactly as cron and
  // the deploy pipeline produce them. This is the shape that grew the table.
  for (let i = 1; i <= 20; i += 1) {
    await upsertSyncGateRecord({
      ...base,
      summary: `repeat-${i}`,
      evidence: { providerScope: "meta", queueDepth: i },
      emittedAt: new Date(Date.UTC(2026, 6, 10, 0, i)).toISOString(),
    });
  }
  assert(
    (await countRows()) === 1,
    `A4: 21 identical decisions produced ${await countRows()} rows; they must coalesce into one.`,
  );
  const coalesced = await client.query<{
    coalesced_count: number;
    last_seen_at: string;
    summary: string;
    evidence_json: Record<string, unknown>;
  }>(
    `SELECT coalesced_count, last_seen_at, summary, evidence_json
     FROM sync_release_gates WHERE build_id = $1`,
    [buildId],
  );
  assert(
    Number(coalesced.rows[0]!.coalesced_count) === 21,
    `A4: coalesced_count is ${coalesced.rows[0]!.coalesced_count}, expected 21.`,
  );
  assert(
    coalesced.rows[0]!.summary === "repeat-20" &&
      Number(coalesced.rows[0]!.evidence_json.queueDepth) === 20,
    "A4: the coalesced row did not keep the newest summary and evidence, so freshness was lost.",
  );

  // Concurrency: N identical evaluations racing. Without the advisory lock each
  // reads "no matching current row" or "differs" and inserts.
  const concurrentBuild = "coalesce-concurrent";
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      upsertSyncGateRecord({
        ...base,
        buildId: concurrentBuild,
        summary: `concurrent-${index}`,
        emittedAt: new Date(Date.UTC(2026, 6, 11, 0, index)).toISOString(),
      }),
    ),
  );
  const concurrentRows = Number(
    (
      await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sync_release_gates WHERE build_id = $1`,
        [concurrentBuild],
      )
    ).rows[0]!.count,
  );
  assert(
    concurrentRows === 1,
    `A4: 12 concurrent identical evaluations produced ${concurrentRows} rows; the coalescing lock did not serialize them.`,
  );

  // A genuine transition must append, or the history a rollback decision reads
  // would be a single mutable row.
  await upsertSyncGateRecord({
    ...base,
    baseResult: "fail",
    verdict: "blocked",
    blockerClass: "not_release_ready",
    summary: "transitioned",
    emittedAt: "2026-07-12T00:00:00.000Z",
  });
  assert(
    (await countRows()) === 2,
    `A5: a genuine pass -> blocked transition did not append; row count is ${await countRows()}.`,
  );
  // ...and back again. A -> B -> A must be three rows, not two: the return to A
  // is itself a transition an operator needs to see.
  await upsertSyncGateRecord({ ...base, summary: "recovered", emittedAt: "2026-07-13T00:00:00.000Z" });
  assert(
    (await countRows()) === 3,
    `A5: a blocked -> pass recovery did not append; row count is ${await countRows()}.`,
  );

  // Retention: dry-run while the lane is off, and it must never propose the
  // newest row for any key.
  const savedRetentionLane = process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
  delete process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
  const before = Number(
    (
      await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sync_release_gates`,
      )
    ).rows[0]!.count,
  );
  const dryRun = await pruneSyncGateRecords({ maxAgeDays: 1, forceExecute: true });
  const afterDryRun = Number(
    (
      await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sync_release_gates`,
      )
    ).rows[0]!.count,
  );
  assert(
    dryRun.mode === "dry_run" && dryRun.deleted === 0 && afterDryRun === before,
    `A5: retention deleted with the lane off: ${JSON.stringify(dryRun)}`,
  );

  process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = "enabled";
  const currentIds = (
    await client.query<{ id: string }>(
      `SELECT DISTINCT ON (build_id, environment, gate_kind, COALESCE(provider_scope, 'meta')) id::text AS id
       FROM sync_release_gates
       ORDER BY build_id, environment, gate_kind, COALESCE(provider_scope, 'meta'),
                emitted_at DESC, id DESC`,
    )
  ).rows.map((row) => row.id);
  const executed = await pruneSyncGateRecords({ maxAgeDays: 1, forceExecute: true, limit: 10_000 });
  assert(
    executed.mode === "execute" && executed.deleted > 0,
    `A5: retention deleted nothing with the lane on, so the guard below proves nothing: ${JSON.stringify(executed)}`,
  );
  const survivors = (
    await client.query<{ id: string }>(
      `SELECT id::text AS id FROM sync_release_gates WHERE id = ANY($1::uuid[])`,
      [currentIds],
    )
  ).rows.map((row) => row.id);
  assert(
    survivors.length === currentIds.length,
    `A5: retention deleted current evidence — ${currentIds.length - survivors.length} of ${currentIds.length} latest rows are gone.`,
  );
  if (savedRetentionLane == null) {
    delete process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
  } else {
    process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = savedRetentionLane;
  }

  console.log(
    `${LABEL} A4-A5 PASS coalescing: 21 sequential and 12 concurrent identical evaluations each collapse to ONE row with coalesced_count and the newest evidence intact; pass->blocked->pass appends 3 rows; retention is dry-run with the lane off, deleted ${executed.deleted} aged rows with it on, and left all ${currentIds.length} current-evidence rows untouched`,
  );
}

// ── A6. Negative control ───────────────────────────────────────────────────

async function verifyNegativeControls(client: Client) {
  const { verifyMigrationSchemaContract } = await import("@/lib/migration-verification");

  const contractObjects: Array<{ label: string; break: string; restore: string }> = [
    {
      label: "drop the keyed latest index",
      break: `DROP INDEX idx_sync_release_gates_key_latest`,
      restore: `CREATE INDEX idx_sync_release_gates_key_latest
        ON sync_release_gates (build_id, environment, gate_kind,
          (COALESCE(provider_scope, 'meta')), emitted_at DESC, id DESC)`,
    },
    {
      label: "drop the kind diagnostic index",
      break: `DROP INDEX idx_sync_release_gates_kind_latest`,
      restore: `CREATE INDEX idx_sync_release_gates_kind_latest
        ON sync_release_gates (gate_kind, (COALESCE(provider_scope, 'meta')),
          emitted_at DESC, id DESC)`,
    },
    {
      label: "drift the keyed index to drop the id tie-break",
      break: `DROP INDEX idx_sync_release_gates_key_latest;
        CREATE INDEX idx_sync_release_gates_key_latest
          ON sync_release_gates (build_id, environment, gate_kind,
            (COALESCE(provider_scope, 'meta')), emitted_at DESC)`,
      restore: `DROP INDEX idx_sync_release_gates_key_latest;
        CREATE INDEX idx_sync_release_gates_key_latest
          ON sync_release_gates (build_id, environment, gate_kind,
            (COALESCE(provider_scope, 'meta')), emitted_at DESC, id DESC)`,
    },
    {
      label: "drop the coalescing counter column",
      break: `ALTER TABLE sync_release_gates DROP COLUMN coalesced_count`,
      restore: `ALTER TABLE sync_release_gates
        ADD COLUMN coalesced_count INTEGER NOT NULL DEFAULT 1`,
    },
    {
      // Dropping this column CASCADES to both indexes, because both key on
      // COALESCE(provider_scope, 'meta'). That is the honest shape of the
      // failure — losing the column loses the whole keyed-read contract — so
      // the restore has to rebuild all three objects.
      label: "drop the provider scope column",
      break: `ALTER TABLE sync_release_gates DROP COLUMN provider_scope CASCADE`,
      restore: `ALTER TABLE sync_release_gates ADD COLUMN provider_scope TEXT;
        CREATE INDEX idx_sync_release_gates_key_latest
          ON sync_release_gates (build_id, environment, gate_kind,
            (COALESCE(provider_scope, 'meta')), emitted_at DESC, id DESC);
        CREATE INDEX idx_sync_release_gates_kind_latest
          ON sync_release_gates (gate_kind, (COALESCE(provider_scope, 'meta')),
            emitted_at DESC, id DESC)`,
    },
    {
      label: "drop the decision fingerprint column",
      break: `ALTER TABLE sync_release_gates DROP COLUMN decision_fingerprint`,
      restore: `ALTER TABLE sync_release_gates ADD COLUMN decision_fingerprint TEXT`,
    },
  ];

  const rowsBefore = Number(
    (
      await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sync_release_gates`,
      )
    ).rows[0]!.count,
  );

  for (const object of contractObjects) {
    await client.query(object.break);
    const refused = await verifyMigrationSchemaContract().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    assert(
      refused != null,
      `A6: the schema contract accepted a catalog with "${object.label}" applied.`,
    );
    const rowsDuring = Number(
      (
        await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM sync_release_gates`,
        )
      ).rows[0]!.count,
    );
    assert(
      rowsDuring === rowsBefore,
      `A6: verification mutated rows while refusing "${object.label}" (${rowsBefore} -> ${rowsDuring}).`,
    );
    await client.query(object.restore);
  }

  // ...and the restored catalog passes again, so the refusals above were about
  // the broken object and not about something else being permanently wrong.
  await verifyMigrationSchemaContract();

  console.log(
    `${LABEL} A6 PASS negative control: all ${contractObjects.length} contract objects (2 indexes, 1 index drift, 3 columns) each cause verification to refuse before any mutation, and the restored catalog verifies clean`,
  );
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-release-gate-plan-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let started = false;
  let client: Client | null = null;

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
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");

    // FRESH catalog: migrations from zero must produce the contract.
    await runMigrations({ force: true, reason: "release_gate_plan_seam_fresh" });

    client = new Client({ connectionString });
    await client.connect();

    // UPGRADED catalog: drop the new objects to reproduce a pre-change
    // deployment, then re-run migrations and prove they are restored. A
    // contract that only holds on a fresh database says nothing about the
    // upgrade this change actually performs.
    await client.query(`DROP INDEX IF EXISTS idx_sync_release_gates_key_latest`);
    await client.query(`DROP INDEX IF EXISTS idx_sync_release_gates_kind_latest`);
    await client.query(
      `ALTER TABLE sync_release_gates
         DROP COLUMN IF EXISTS provider_scope,
         DROP COLUMN IF EXISTS decision_fingerprint,
         DROP COLUMN IF EXISTS last_seen_at,
         DROP COLUMN IF EXISTS coalesced_count`,
    );
    const { resetMigrationLatchForSeams } = await import("@/lib/migrations");
    resetMigrationLatchForSeams();
    await runMigrations({ force: true, reason: "release_gate_plan_seam_upgrade" });
    const { verifyMigrationSchemaContract } = await import("@/lib/migration-verification");
    await verifyMigrationSchemaContract();
    console.log(
      `${LABEL} A0 PASS catalogs: the contract holds on a fresh migration AND after an upgrade from a catalog that had none of the new columns or indexes`,
    );

    await seedVolume(client);
    await verifyPlans(client);
    await verifyDeterminismAndScope(client);
    await verifyCoalescingAndRetention(client);
    await verifyNegativeControls(client);

    console.log(`${LABEL} PASS`);
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
