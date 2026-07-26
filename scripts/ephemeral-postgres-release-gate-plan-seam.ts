/**
 * A0-A8 — the release-gate anti-runaway contract, against a real PostgreSQL
 * holding real volume, seeded on the keys the production queries actually ask
 * for.
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
 * It also seeds the TARGET key heavily. An EXPLAIN over a key with no matching
 * rows proves nothing: the planner reaches the first index entry, finds no
 * match and stops, so any index shape "passes". Every query measured below has
 * thousands of candidate rows behind its key.
 *
 *   A0  fresh migration and upgrade-from-old-catalog both produce the contract
 *   A1  legacy scope backfill is truthful: global / recorded / unknown
 *   A2  seeded volume; every production read uses its index, bounded buffers,
 *       no Sort node, no temp I/O
 *   A3  retention's candidate plan is bounded independently of total history
 *   A4  deterministic ties, exact provider separation, GLOBAL deploy resolution
 *   A5  cross-environment refusal: staging never answers production
 *   A6  concurrent identical evaluations coalesce to one row
 *   A7  a genuine transition appends; retention never deletes current evidence
 *   A8  negative control: drop or drift each contract object, prove refusal
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
/** Rows on the EXACT key every measured read asks for. */
const TARGET_ROWS = 20_000;
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
    AND provider_scope = $4
  ORDER BY emitted_at DESC, id DESC
  LIMIT 1
`;

/**
 * The environment-less fallback. Note it is STILL an equality read: the only
 * environment it will accept is the literal 'unknown'.
 */
const FALLBACK_READ_SQL = EXACT_READ_SQL;

/** The build-agnostic diagnostic read used by /build-info's `latest` tier. */
const KIND_READ_SQL = `
  SELECT id, build_id, environment, gate_kind, emitted_at
  FROM sync_release_gates
  WHERE gate_kind = $1
    AND provider_scope = $2
    AND environment = $3
  ORDER BY emitted_at DESC, id DESC
  LIMIT 1
`;

/** The exact retention candidate, in the shape `pruneSyncGateRecords` issues. */
const RETENTION_CANDIDATE_SQL = `
  WITH aged AS (
    SELECT id, build_id, environment, gate_kind, provider_scope, emitted_at
    FROM sync_release_gates
    WHERE emitted_at < now() - make_interval(days => $1)
    ORDER BY emitted_at ASC, id ASC
    LIMIT $2
  )
  SELECT aged.id
  FROM aged
  WHERE EXISTS (
    SELECT 1
    FROM sync_release_gates newer
    WHERE newer.build_id = aged.build_id
      AND newer.environment = aged.environment
      AND newer.gate_kind = aged.gate_kind
      AND newer.provider_scope = aged.provider_scope
      AND (newer.emitted_at, newer.id) > (aged.emitted_at, aged.id)
  )
`;

/** The removed retention shape, kept only to be shown unbounded. */
const OLD_RETENTION_CANDIDATE_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (build_id, environment, gate_kind, COALESCE(provider_scope, 'meta'))
           id
    FROM sync_release_gates
    ORDER BY build_id, environment, gate_kind,
             COALESCE(provider_scope, 'meta'), emitted_at DESC, id DESC
  )
  SELECT id FROM sync_release_gates
  WHERE emitted_at < now() - make_interval(days => $1)
    AND id NOT IN (SELECT id FROM latest)
  ORDER BY emitted_at ASC, id ASC
  LIMIT $2
`;

async function seedVolume(client: Client, rows: number, offsetSeconds: number) {
  // generate_series in one statement: hundreds of thousands of round-trips would
  // dominate runtime and prove nothing extra.
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
       CASE
         WHEN series % 2 = 0 THEN 'global'
         WHEN series % 5 = 0 THEN 'google_ads'
         ELSE 'meta'
       END,
       md5(series::text),
       'measure_only', 'pass', 'pass', NULL,
       'seeded', FALSE, NULL, '{}'::jsonb,
       now() - make_interval(secs => series + $3),
       now() - make_interval(secs => series + $3),
       1
     FROM generate_series(1, $1) AS series`,
    [rows, SEED_BUILDS, offsetSeconds],
  );
}

/**
 * Volume on the EXACT keys the measured reads use.
 *
 * Without this every EXPLAIN below runs against an empty match set, where the
 * planner touches one index page, finds nothing and stops — so a wrong index, a
 * missing tie-break and a full sort all "pass". Each measured key gets
 * TARGET_ROWS candidates behind it, so the difference between reading one row
 * and ordering the matching set is visible in the buffer counts.
 */
async function seedTargetKeys(client: Client) {
  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict,
       summary, evidence_json, emitted_at, last_seen_at, coalesced_count
     )
     SELECT
       $2,
       shape.environment,
       shape.gate_kind,
       'release_readiness',
       shape.provider_scope,
       md5(series::text || shape.gate_kind || shape.provider_scope || shape.environment),
       'block', 'pass', 'pass',
       'target-history', '{}'::jsonb,
       TIMESTAMPTZ '2026-01-01 00:00:00+00' + make_interval(secs => series),
       TIMESTAMPTZ '2026-01-01 00:00:00+00' + make_interval(secs => series),
       1
     FROM generate_series(1, $1) AS series
     CROSS JOIN (VALUES
       ('deploy_gate', 'global',     $3),
       ('release_gate', 'meta',       $3),
       ('release_gate', 'google_ads', $3),
       ('deploy_gate', 'global',     'unknown'),
       ('release_gate', 'meta',       'unknown'),
       ('deploy_gate', 'global',     'staging'),
       ('release_gate', 'meta',       'staging')
     ) AS shape(gate_kind, provider_scope, environment)`,
    [TARGET_ROWS, TARGET_BUILD, TARGET_ENV],
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

/**
 * Total buffers touched, read off the TOP node's cumulative `Buffers:` line.
 *
 * This is the number that separates "read one row through an index" from
 * "walked the matching set"; wall-clock on a warm ephemeral instance does not.
 */
function planBuffers(plan: string) {
  const line = /Buffers: ([^\n]+)/.exec(plan);
  if (!line) return null;
  let total = 0;
  for (const match of line[1]!.matchAll(/(hit|read|dirtied|written)=(\d+)/g)) {
    if (match[1] === "hit" || match[1] === "read") total += Number(match[2]);
  }
  return total;
}

function planActualRows(plan: string) {
  const match = /actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/.exec(plan);
  return match ? Number(match[1]) : null;
}

// ── A1. Legacy scope backfill ──────────────────────────────────────────────

/**
 * `COALESCE(provider_scope, 'meta')` asserted a fact about rows that never
 * carried one. This reproduces a pre-change catalog holding exactly the three
 * legacy shapes, runs the real migration over it, and reads back what each row
 * became.
 */
async function verifyLegacyBackfill(client: Client, rerunMigrations: () => Promise<void>) {
  await client.query(
    `ALTER TABLE sync_release_gates DROP COLUMN IF EXISTS provider_scope CASCADE`,
  );

  const legacy: Array<{ label: string; kind: string; evidence: string; expect: string }> = [
    // A deploy gate is global by construction. It never carried a provider and
    // labelling it 'meta' is what hid it from the Google control plane.
    { label: "legacy-deploy", kind: "deploy_gate", evidence: "{}", expect: "global" },
    // A release gate that DID record its provider keeps it.
    {
      label: "legacy-release-google",
      kind: "release_gate",
      evidence: '{"providerScope":"google_ads"}',
      expect: "google_ads",
    },
    // A release gate that did NOT record one is unknown — not Meta.
    { label: "legacy-release-bare", kind: "release_gate", evidence: "{}", expect: "unknown" },
  ];

  for (const row of legacy) {
    await client.query(
      `INSERT INTO sync_release_gates (
         build_id, environment, gate_kind, gate_scope, mode, base_result,
         verdict, summary, evidence_json, emitted_at, last_seen_at, coalesced_count
       ) VALUES ('legacy-build', $1, $2, 'release_readiness', 'block', 'pass',
                 'pass', $3, $4::jsonb, '2025-01-01T00:00:00Z',
                 '2025-01-01T00:00:00Z', 1)`,
      [TARGET_ENV, row.kind, row.label, row.evidence],
    );
  }

  await rerunMigrations();

  for (const row of legacy) {
    const actual = await client.query<{ provider_scope: string }>(
      `SELECT provider_scope FROM sync_release_gates WHERE summary = $1`,
      [row.label],
    );
    assert(
      actual.rows[0]?.provider_scope === row.expect,
      `A1: ${row.label} backfilled to ${JSON.stringify(actual.rows[0]?.provider_scope)}, expected ${row.expect}.`,
    );
  }

  const nulls = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM sync_release_gates WHERE provider_scope IS NULL`,
  );
  assert(
    Number(nulls.rows[0]!.count) === 0,
    `A1: ${nulls.rows[0]!.count} rows still have a NULL provider_scope after the backfill.`,
  );

  const notNull = await client.query<{ is_nullable: string; column_default: string | null }>(
    `SELECT is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'sync_release_gates' AND column_name = 'provider_scope'`,
  );
  assert(
    notNull.rows[0]?.is_nullable === "NO",
    `A1: provider_scope is still nullable, so a future writer can reintroduce the ambiguity: ${JSON.stringify(notNull.rows[0])}`,
  );

  // The reader consequence, which is the point of the backfill.
  const { getLatestSyncGateRecords } = await import("@/lib/sync/release-gates");
  const asMeta = await getLatestSyncGateRecords({
    buildId: "legacy-build",
    environment: TARGET_ENV,
    providerScope: "meta",
  });
  assert(
    asMeta.releaseGate == null,
    `A1: a legacy release gate with NO recorded provider answered a META question: ${JSON.stringify(asMeta.releaseGate)}`,
  );
  const asGoogle = await getLatestSyncGateRecords({
    buildId: "legacy-build",
    environment: TARGET_ENV,
    providerScope: "google_ads",
  });
  assert(
    asGoogle.releaseGate?.summary === "legacy-release-google",
    `A1: the legacy google_ads release gate was not readable as google_ads: ${JSON.stringify(asGoogle.releaseGate)}`,
  );
  // And the global deploy gate resolves for BOTH providers.
  assert(
    asMeta.deployGate?.summary === "legacy-deploy" &&
      asGoogle.deployGate?.summary === "legacy-deploy",
    `A1: the global deploy gate did not resolve for both providers: meta=${JSON.stringify(asMeta.deployGate?.summary)} google=${JSON.stringify(asGoogle.deployGate?.summary)}`,
  );

  await client.query(`DELETE FROM sync_release_gates WHERE build_id = 'legacy-build'`);
  console.log(
    `${LABEL} A1 PASS legacy backfill: a legacy deploy gate becomes 'global' and resolves for meta AND google_ads; a legacy release gate that recorded google_ads keeps it; a legacy release gate that recorded nothing becomes 'unknown' and no longer answers Meta questions; 0 rows left NULL and the column is NOT NULL`,
  );
}

// ── A2. Plans, buffers and temp files under real volume ────────────────────

async function verifyPlans(client: Client) {
  const seeded = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM sync_release_gates`,
  );
  assert(
    Number(seeded.rows[0]!.count) >= SEED_ROWS,
    `A2: expected at least ${SEED_ROWS} seeded rows, found ${seeded.rows[0]!.count}.`,
  );

  // 64kB is below the smallest sort PostgreSQL will do in memory for this row
  // width, and temp_file_limit=0 turns any spill into an ERROR. Together they
  // convert "this query is slow" into "this query fails", which is the only
  // form a test can assert on reliably.
  await client.query(`SET work_mem = '64kB'`);
  await client.query(`SET temp_file_limit = 0`);

  const cases: Array<{
    label: string;
    sql: string;
    values: unknown[];
    index: string;
    candidates: number;
  }> = [
    {
      label: "exact key (release/meta)",
      sql: EXACT_READ_SQL,
      values: [TARGET_BUILD, TARGET_ENV, "release_gate", "meta"],
      index: "idx_sync_release_gates_key_latest",
      candidates: TARGET_ROWS,
    },
    {
      label: "exact key (deploy/global)",
      sql: EXACT_READ_SQL,
      values: [TARGET_BUILD, TARGET_ENV, "deploy_gate", "global"],
      index: "idx_sync_release_gates_key_latest",
      candidates: TARGET_ROWS,
    },
    {
      label: "environment-less fallback",
      sql: FALLBACK_READ_SQL,
      values: [TARGET_BUILD, "unknown", "release_gate", "meta"],
      index: "idx_sync_release_gates_key_latest",
      candidates: TARGET_ROWS,
    },
    {
      label: "kind diagnostic (google)",
      sql: KIND_READ_SQL,
      values: ["release_gate", "google_ads", TARGET_ENV],
      index: "idx_sync_release_gates_kind_latest",
      candidates: TARGET_ROWS,
    },
  ];

  const buffersByCase: Record<string, number> = {};
  for (const testCase of cases) {
    // Prove the key is HOT before measuring it. An EXPLAIN over an empty match
    // set is satisfied by any index shape.
    const candidateCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sync_release_gates
       WHERE ${
         testCase.sql === KIND_READ_SQL
           ? "gate_kind = $1 AND provider_scope = $2 AND environment = $3"
           : "build_id = $1 AND environment = $2 AND gate_kind = $3 AND provider_scope = $4"
       }`,
      testCase.values,
    );
    assert(
      Number(candidateCount.rows[0]!.count) >= testCase.candidates,
      `A2: the ${testCase.label} key has only ${candidateCount.rows[0]!.count} candidate rows, so its plan proves nothing.`,
    );

    const plan = await explain(client, testCase.sql, testCase.values);
    assert(
      plan.includes(testCase.index),
      `A2: the ${testCase.label} read did not use ${testCase.index}:\n${plan}`,
    );
    assert(
      !/Seq Scan on sync_release_gates/.test(plan),
      `A2: the ${testCase.label} read fell back to a sequential scan:\n${plan}`,
    );
    // No Sort NODE at all, not merely no EXTERNAL sort. An in-memory sort of the
    // matching set is exactly the cost that grew with the runaway; asserting
    // only "Sort Method: external" would accept it.
    assert(
      !/\bSort\b/.test(plan),
      `A2: the ${testCase.label} read contains a Sort node, so the index ordering is not being used:\n${plan}`,
    );
    assert(
      !/temp read=|temp written=/.test(plan),
      `A2: the ${testCase.label} read wrote temp files under temp_file_limit=0:\n${plan}`,
    );

    const rows = planActualRows(plan);
    assert(
      rows === 1,
      `A2: the ${testCase.label} read returned ${rows} rows for a LIMIT 1 question:\n${plan}`,
    );
    const buffers = planBuffers(plan);
    assert(
      buffers != null && buffers <= 64,
      `A2: the ${testCase.label} read touched ${buffers} buffers to return one row from a ${testCase.candidates}-row key; a keyed descent is a handful of pages:\n${plan}`,
    );
    buffersByCase[testCase.label] = buffers;
  }

  // The two shapes that were removed, each shown wrong for a different reason.
  //
  // (1) The exact read had NO LIMIT, so it returned every row for the key and
  //     picked the first in JavaScript. Its cost is the size of the history —
  //     precisely what the runaway was growing. Under the SAME settings the
  //     keyed reads pass cleanly on, it cannot even execute: it needs a sort of
  //     the whole matching set and that sort spills.
  const UNBOUNDED_SQL = `SELECT id FROM sync_release_gates
     WHERE build_id = $1 AND environment = $2 AND gate_kind = $3 AND provider_scope = $4
     ORDER BY emitted_at DESC`;
  const unboundedValues = [TARGET_BUILD, TARGET_ENV, "release_gate", "meta"];
  const spillError = await explain(client, UNBOUNDED_SQL, unboundedValues).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  assert(
    spillError != null && /temp_file_limit/.test(spillError),
    `A2: the removed unbounded read did NOT spill under work_mem=64kB / temp_file_limit=0, so its cost is not demonstrably proportional to history: ${String(spillError)}`,
  );

  // The connection is poisoned by the aborted EXPLAIN's transaction state on
  // some paths; reset the guards and measure the same shape honestly.
  await client.query(`RESET temp_file_limit`);
  await client.query(`RESET work_mem`);
  const unboundedPlan = await explain(client, UNBOUNDED_SQL, unboundedValues);
  const unboundedRows = planActualRows(unboundedPlan);
  const unboundedBuffers = planBuffers(unboundedPlan);
  assert(
    unboundedRows != null && unboundedRows >= TARGET_ROWS,
    `A2: the unbounded read returned only ${unboundedRows} rows, too few to show it grows with history.`,
  );
  assert(
    unboundedBuffers != null &&
      unboundedBuffers > (buffersByCase["exact key (release/meta)"] ?? 0) * 20,
    `A2: the unbounded read touched ${unboundedBuffers} buffers vs ${buffersByCase["exact key (release/meta)"]} for the keyed read; the gap is too small for this control to mean anything.`,
  );

  // (2) The unkeyed `ORDER BY emitted_at DESC LIMIT 100` could not answer the
  //     question at all. It returns the 100 globally-newest rows and then looks
  //     for a matching gate kind and scope among them — so a key whose newest
  //     row is older than 100 other rows is simply invisible.
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

  console.log(
    `${LABEL} A2 PASS plans: ${SEED_ROWS} seeded rows plus ${TARGET_ROWS} rows behind EACH measured key; all 4 production reads use their intended index, return exactly 1 row, touch <=64 buffers (${JSON.stringify(buffersByCase)}), contain NO Sort node and write no temp file under work_mem=64kB / temp_file_limit=0. The removed shapes are shown wrong on their own terms: the unbounded read FAILS outright under those same settings (spilled sort), and unguarded returns ${unboundedRows} rows touching ${unboundedBuffers} buffers to answer the same one-row question; the unkeyed LIMIT 100 read cannot see a current row the keyed read returns immediately`,
  );
}

// ── A3. Retention plan is bounded by batch size, not by history ────────────

async function verifyRetentionPlan(client: Client, addMoreRows: () => Promise<number>) {
  const measure = async () => {
    const plan = await explain(client, RETENTION_CANDIDATE_SQL, [1, 500]);
    return { plan, buffers: planBuffers(plan) ?? Number.MAX_SAFE_INTEGER };
  };

  const before = await measure();
  assert(
    before.plan.includes("idx_sync_release_gates_retention_scan"),
    `A3: the retention candidate did not use the ascending keyset index:\n${before.plan}`,
  );
  assert(
    before.plan.includes("idx_sync_release_gates_key_latest"),
    `A3: the "is there a newer row for this key" probe did not use the keyed index, so it is a scan per candidate:\n${before.plan}`,
  );
  assert(
    !/Seq Scan on sync_release_gates/.test(before.plan),
    `A3: the retention candidate sequentially scanned the relation:\n${before.plan}`,
  );
  // No Sort node of any kind — including an Incremental Sort, which is what a
  // DESC-only `emitted_at` index forces when the ascending `(emitted_at, id)`
  // keyset is missing.
  assert(
    !/\bSort\b/.test(before.plan),
    `A3: the retention candidate contains a Sort node, so the keyset ordering is not coming from the index:\n${before.plan}`,
  );
  // The EXISTS probe is the part that could silently become a scan per
  // candidate. An Index Only Scan proves it is one keyed descent.
  assert(
    /Index Only Scan using idx_sync_release_gates_key_latest/.test(before.plan),
    `A3: the "newer row exists" probe is not an index-only descent:\n${before.plan}`,
  );

  const totalBefore = Number(
    (
      await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sync_release_gates`,
      )
    ).rows[0]!.count,
  );
  const added = await addMoreRows();
  const after = await measure();
  const totalAfter = Number(
    (
      await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sync_release_gates`,
      )
    ).rows[0]!.count,
  );

  // The claim is not "fast". It is: growing the table by ~40% does not grow the
  // work retention does per tick, because the batch bounds the scan.
  assert(
    after.buffers <= before.buffers * 1.5 + 200,
    `A3: growing the relation from ${totalBefore} to ${totalAfter} rows changed the retention candidate's buffer count from ${before.buffers} to ${after.buffers}; the work is not bounded by the batch.`,
  );

  // The removed shape, on the same data, for contrast.
  const oldPlan = await explain(client, OLD_RETENTION_CANDIDATE_SQL, [1, 500]);
  const oldBuffers = planBuffers(oldPlan) ?? 0;
  assert(
    /Seq Scan on sync_release_gates/.test(oldPlan) || oldBuffers > after.buffers * 20,
    `A3: the removed DISTINCT ON shape was expected to read the whole relation; it touched ${oldBuffers} buffers vs ${after.buffers}:\n${oldPlan}`,
  );

  console.log(
    `${LABEL} A3 PASS retention plan: the candidate uses the ascending (emitted_at, id) keyset for its bounded scan and the keyed index for its "newer row exists" probe; growing the relation from ${totalBefore} to ${totalAfter} rows (+${added}) moved its buffer count only ${before.buffers} -> ${after.buffers}, while the removed DISTINCT ON shape reads ${oldBuffers} buffers on the same data`,
  );
}

// ── A4 + A5. Determinism, scope separation, environment refusal ────────────

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
      `A4: a same-instant tie resolved to ${latest.releaseGate?.id} on attempt ${attempt}, expected the highest id ${expected}.`,
    );
  }

  // Provider scopes must not bleed: a google_ads verdict must never answer a
  // meta question.
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
    `A4: the google_ads scope did not return its own row: ${JSON.stringify(googleLatest.releaseGate)}`,
  );
  const metaLatest = await getLatestSyncGateRecords({
    buildId: TIE_BUILD,
    environment: TARGET_ENV,
    providerScope: "meta",
  });
  assert(
    metaLatest.releaseGate?.summary !== "google",
    "A4: a google_ads row answered a meta question.",
  );

  // GLOBAL deploy identity: one row, resolved by every provider.
  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict, summary,
       evidence_json, emitted_at, last_seen_at, coalesced_count
     ) VALUES ($1, $2, 'deploy_gate', 'runtime_contract', 'global',
               'global-deploy', 'block', 'fail', 'blocked', 'global-deploy-gate',
               '{}'::jsonb, $3, $3, 1)`,
    [TIE_BUILD, TARGET_ENV, "2026-07-03T00:00:00.000Z"],
  );
  for (const scope of ["meta", "google_ads", "shopify"]) {
    const seen = await getLatestSyncGateRecords({
      buildId: TIE_BUILD,
      environment: TARGET_ENV,
      providerScope: scope,
    });
    assert(
      seen.deployGate?.summary === "global-deploy-gate",
      `A4: the global deploy gate was not resolved by a ${scope} reader: ${JSON.stringify(seen.deployGate)}`,
    );
    assert(
      seen.deployGate?.verdict === "blocked",
      `A4: the ${scope} reader saw verdict ${JSON.stringify(seen.deployGate?.verdict)}, not the blocked global verdict.`,
    );
  }

  // A5 — cross-environment refusal. A staging evaluation of the SAME build must
  // not answer a production question, and a production reader must not silently
  // fall back to it.
  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict, summary,
       evidence_json, emitted_at, last_seen_at, coalesced_count
     ) VALUES ($1, 'staging', 'deploy_gate', 'runtime_contract', 'global',
               'staging-deploy', 'block', 'pass', 'pass', 'STAGING-PASS',
               '{}'::jsonb, $2, $2, 1)`,
    // NEWER than the production row above, so a merge that preferred recency
    // over environment would return it.
    [TIE_BUILD, "2026-07-09T00:00:00.000Z"],
  );
  const productionView = await getLatestSyncGateRecords({
    buildId: TIE_BUILD,
    environment: TARGET_ENV,
    providerScope: "meta",
  });
  assert(
    productionView.deployGate?.summary === "global-deploy-gate",
    `A5: a NEWER staging deploy gate answered a production query: ${JSON.stringify(productionView.deployGate)}`,
  );

  // ...and when production has NO row at all, the staging row still must not be
  // used — absence is the correct answer.
  const EMPTY_BUILD = "prod-empty-build";
  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict, summary,
       evidence_json, emitted_at, last_seen_at, coalesced_count
     ) VALUES ($1, 'staging', 'deploy_gate', 'runtime_contract', 'global',
               'only-staging', 'block', 'pass', 'pass', 'ONLY-STAGING',
               '{}'::jsonb, $2, $2, 1)`,
    [EMPTY_BUILD, "2026-07-10T00:00:00.000Z"],
  );
  const emptyView = await getLatestSyncGateRecords({
    buildId: EMPTY_BUILD,
    environment: TARGET_ENV,
    providerScope: "meta",
  });
  assert(
    emptyView.deployGate == null && emptyView.releaseGate == null,
    `A5: with only a staging row present, a production read returned ${JSON.stringify(emptyView)} instead of nothing.`,
  );

  // The 'unknown' environment fallback still works — that is the one legitimate
  // cross-environment case and it is an equality read, not a wildcard.
  await client.query(
    `INSERT INTO sync_release_gates (
       build_id, environment, gate_kind, gate_scope, provider_scope,
       decision_fingerprint, mode, base_result, verdict, summary,
       evidence_json, emitted_at, last_seen_at, coalesced_count
     ) VALUES ($1, 'unknown', 'release_gate', 'release_readiness', 'meta',
               'unknown-env', 'block', 'pass', 'pass', 'UNKNOWN-ENV',
               '{}'::jsonb, $2, $2, 1)`,
    [EMPTY_BUILD, "2026-07-04T00:00:00.000Z"],
  );
  const fallbackView = await getLatestSyncGateRecords({
    buildId: EMPTY_BUILD,
    environment: TARGET_ENV,
    providerScope: "meta",
  });
  assert(
    fallbackView.releaseGate?.summary === "UNKNOWN-ENV",
    `A5: the environment-less fallback did not resolve: ${JSON.stringify(fallbackView.releaseGate)}`,
  );

  console.log(
    `${LABEL} A4-A5 PASS identity: a same-instant tie resolves to the same row on 5 consecutive reads; google_ads and meta stay separate; ONE global deploy gate resolves identically for meta, google_ads and shopify readers; a NEWER staging row never answers a production query and a production read with only staging rows present returns nothing; the 'unknown' environment fallback still resolves`,
  );
}

// ── A6 + A7. Coalescing, transitions and retention ─────────────────────────

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
  assert((await countRows()) === 1, "A6: the first evaluation did not create a row.");

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
    `A6: 21 identical decisions produced ${await countRows()} rows; they must coalesce into one.`,
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
    `A6: coalesced_count is ${coalesced.rows[0]!.coalesced_count}, expected 21.`,
  );
  assert(
    coalesced.rows[0]!.summary === "repeat-20" &&
      Number(coalesced.rows[0]!.evidence_json.queueDepth) === 20,
    "A6: the coalesced row did not keep the newest summary and evidence, so freshness was lost.",
  );

  // A deploy gate written by the writer must land under the GLOBAL scope, not
  // under 'meta' — otherwise every Google read is a miss.
  await upsertSyncGateRecord({
    ...base,
    gateKind: "deploy_gate",
    gateScope: "service_liveness",
    summary: "deploy",
    evidence: {},
    emittedAt: "2026-07-10T01:00:00.000Z",
  });
  const deployScope = await client.query<{ provider_scope: string }>(
    `SELECT provider_scope FROM sync_release_gates
     WHERE build_id = $1 AND gate_kind = 'deploy_gate'`,
    [buildId],
  );
  assert(
    deployScope.rows[0]?.provider_scope === "global",
    `A6: the writer filed a deploy gate under ${JSON.stringify(deployScope.rows[0]?.provider_scope)}, expected 'global'.`,
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
    `A6: 12 concurrent identical evaluations produced ${concurrentRows} rows; the coalescing lock did not serialize them.`,
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
    (await countRows()) === 3,
    `A7: a genuine pass -> blocked transition did not append; row count is ${await countRows()}.`,
  );
  // ...and back again. A -> B -> A must append again: the return to A is itself
  // a transition an operator needs to see.
  await upsertSyncGateRecord({ ...base, summary: "recovered", emittedAt: "2026-07-13T00:00:00.000Z" });
  assert(
    (await countRows()) === 4,
    `A7: a blocked -> pass recovery did not append; row count is ${await countRows()}.`,
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
    `A7: retention deleted with the lane off: ${JSON.stringify(dryRun)}`,
  );

  process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = "enabled";
  // Latest-per-key computed with the SAME grouping the reads use — including
  // provider_scope as a plain column, so meta and google_ads are distinct
  // retention groups rather than one COALESCEd bucket.
  const currentIds = (
    await client.query<{ id: string }>(
      `SELECT DISTINCT ON (build_id, environment, gate_kind, provider_scope) id::text AS id
       FROM sync_release_gates
       ORDER BY build_id, environment, gate_kind, provider_scope,
                emitted_at DESC, id DESC`,
    )
  ).rows.map((row) => row.id);
  const executed = await pruneSyncGateRecords({ maxAgeDays: 1, forceExecute: true, limit: 10_000 });
  assert(
    executed.mode === "execute" && executed.deleted > 0,
    `A7: retention deleted nothing with the lane on, so the guard below proves nothing: ${JSON.stringify(executed)}`,
  );
  const survivors = (
    await client.query<{ id: string }>(
      `SELECT id::text AS id FROM sync_release_gates WHERE id = ANY($1::uuid[])`,
      [currentIds],
    )
  ).rows.map((row) => row.id);
  assert(
    survivors.length === currentIds.length,
    `A7: retention deleted current evidence — ${currentIds.length - survivors.length} of ${currentIds.length} latest rows are gone.`,
  );
  // The delete is bounded per call, so a first run over a huge backlog cannot
  // become an unbounded statement.
  const bounded = await pruneSyncGateRecords({ maxAgeDays: 1, forceExecute: true, limit: 7 });
  assert(
    bounded.candidates <= 7 && bounded.deleted <= 7,
    `A7: a limit of 7 produced ${bounded.candidates} candidates and ${bounded.deleted} deletes.`,
  );
  if (savedRetentionLane == null) {
    delete process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED;
  } else {
    process.env.ADSECUTE_SYNC_LANE_RETENTION_ENABLED = savedRetentionLane;
  }

  console.log(
    `${LABEL} A6-A7 PASS coalescing: 21 sequential and 12 concurrent identical evaluations each collapse to ONE row with coalesced_count and the newest evidence intact; the writer files deploy gates under 'global'; pass->blocked->pass appends; retention is dry-run with the lane off, deleted ${executed.deleted} aged rows with it on, left all ${currentIds.length} current-evidence rows untouched, and honoured a limit of 7`,
  );
}

// ── A8. Negative control ───────────────────────────────────────────────────

async function verifyNegativeControls(client: Client) {
  const { verifyMigrationSchemaContract } = await import("@/lib/migration-verification");

  const KEY_INDEX = `CREATE INDEX idx_sync_release_gates_key_latest
    ON sync_release_gates (build_id, environment, gate_kind, provider_scope,
      emitted_at DESC, id DESC)`;
  const KIND_INDEX = `CREATE INDEX idx_sync_release_gates_kind_latest
    ON sync_release_gates (gate_kind, provider_scope, environment,
      emitted_at DESC, id DESC)`;
  const RETENTION_INDEX = `CREATE INDEX idx_sync_release_gates_retention_scan
    ON sync_release_gates (emitted_at, id)`;

  const contractObjects: Array<{ label: string; break: string; restore: string }> = [
    {
      label: "drop the keyed latest index",
      break: `DROP INDEX idx_sync_release_gates_key_latest`,
      restore: KEY_INDEX,
    },
    {
      label: "drop the kind diagnostic index",
      break: `DROP INDEX idx_sync_release_gates_kind_latest`,
      restore: KIND_INDEX,
    },
    {
      label: "drop the retention keyset index",
      break: `DROP INDEX idx_sync_release_gates_retention_scan`,
      restore: RETENTION_INDEX,
    },
    {
      label: "drift the keyed index to drop the id tie-break",
      break: `DROP INDEX idx_sync_release_gates_key_latest;
        CREATE INDEX idx_sync_release_gates_key_latest
          ON sync_release_gates (build_id, environment, gate_kind,
            provider_scope, emitted_at DESC)`,
      restore: `DROP INDEX idx_sync_release_gates_key_latest; ${KEY_INDEX}`,
    },
    {
      // The drift that motivated exact key assertions: reverting to the
      // COALESCE expression key. Same name, same table, same column count —
      // and it cannot serve `provider_scope = $4` as an index condition.
      label: "drift the keyed index back to the COALESCE expression",
      break: `DROP INDEX idx_sync_release_gates_key_latest;
        CREATE INDEX idx_sync_release_gates_key_latest
          ON sync_release_gates (build_id, environment, gate_kind,
            (COALESCE(provider_scope, 'meta')), emitted_at DESC, id DESC)`,
      restore: `DROP INDEX idx_sync_release_gates_key_latest; ${KEY_INDEX}`,
    },
    {
      label: "drift the kind index to drop environment",
      break: `DROP INDEX idx_sync_release_gates_kind_latest;
        CREATE INDEX idx_sync_release_gates_kind_latest
          ON sync_release_gates (gate_kind, provider_scope, emitted_at DESC, id DESC)`,
      restore: `DROP INDEX idx_sync_release_gates_kind_latest; ${KIND_INDEX}`,
    },
    {
      label: "drift the retention index to descending order",
      break: `DROP INDEX idx_sync_release_gates_retention_scan;
        CREATE INDEX idx_sync_release_gates_retention_scan
          ON sync_release_gates (emitted_at DESC, id DESC)`,
      restore: `DROP INDEX idx_sync_release_gates_retention_scan; ${RETENTION_INDEX}`,
    },
    {
      label: "make provider_scope nullable again",
      break: `ALTER TABLE sync_release_gates ALTER COLUMN provider_scope DROP NOT NULL`,
      restore: `ALTER TABLE sync_release_gates ALTER COLUMN provider_scope SET NOT NULL`,
    },
    {
      label: "drop the coalescing counter column",
      break: `ALTER TABLE sync_release_gates DROP COLUMN coalesced_count`,
      restore: `ALTER TABLE sync_release_gates
        ADD COLUMN coalesced_count INTEGER NOT NULL DEFAULT 1`,
    },
    {
      // Dropping this column CASCADES to all three indexes that key on it. That
      // is the honest shape of the failure — losing the column loses the whole
      // keyed-read contract — so the restore rebuilds every object.
      label: "drop the provider scope column",
      break: `ALTER TABLE sync_release_gates DROP COLUMN provider_scope CASCADE`,
      restore: `ALTER TABLE sync_release_gates
          ADD COLUMN provider_scope TEXT NOT NULL DEFAULT 'unknown';
        ${KEY_INDEX};
        ${KIND_INDEX}`,
    },
    {
      label: "drop the decision fingerprint column",
      break: `ALTER TABLE sync_release_gates DROP COLUMN decision_fingerprint`,
      restore: `ALTER TABLE sync_release_gates ADD COLUMN decision_fingerprint TEXT`,
    },
    {
      // B4 in this seam: a same-name arbiter over a SUBSET of the columns. It is
      // a real unique index, it is valid, and every production repair-plan write
      // against it fails 42P10.
      label: "shrink the repair-plan arbiter to a subset of its columns",
      break: `DROP INDEX sync_repair_plans_scope_mode_identity;
        CREATE UNIQUE INDEX sync_repair_plans_scope_mode_identity
          ON sync_repair_plans (build_id, environment)`,
      restore: `DROP INDEX sync_repair_plans_scope_mode_identity;
        CREATE UNIQUE INDEX sync_repair_plans_scope_mode_identity
          ON sync_repair_plans (build_id, environment, provider_scope, plan_mode)`,
    },
    {
      // ...and a PARTIAL arbiter, which an unqualified ON CONFLICT cannot infer.
      label: "make the repair-plan arbiter partial",
      break: `DROP INDEX sync_repair_plans_scope_mode_identity;
        CREATE UNIQUE INDEX sync_repair_plans_scope_mode_identity
          ON sync_repair_plans (build_id, environment, provider_scope, plan_mode)
          WHERE eligible`,
      restore: `DROP INDEX sync_repair_plans_scope_mode_identity;
        CREATE UNIQUE INDEX sync_repair_plans_scope_mode_identity
          ON sync_repair_plans (build_id, environment, provider_scope, plan_mode)`,
    },
    {
      // B5: the `(id) WHERE is_selected` drift the predicate-only check accepted.
      label: "drift the is_selected index to (id) WHERE is_selected",
      break: `DROP INDEX idx_business_provider_accounts_selected;
        CREATE INDEX idx_business_provider_accounts_selected
          ON business_provider_accounts (id) WHERE is_selected`,
      restore: `DROP INDEX idx_business_provider_accounts_selected;
        CREATE INDEX idx_business_provider_accounts_selected
          ON business_provider_accounts (business_id, provider, position, id)
          WHERE is_selected`,
    },
    {
      label: "drop the is_selected predicate",
      break: `DROP INDEX idx_business_provider_accounts_selected;
        CREATE INDEX idx_business_provider_accounts_selected
          ON business_provider_accounts (business_id, provider, position, id)`,
      restore: `DROP INDEX idx_business_provider_accounts_selected;
        CREATE INDEX idx_business_provider_accounts_selected
          ON business_provider_accounts (business_id, provider, position, id)
          WHERE is_selected`,
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
      `A8: the schema contract accepted a catalog with "${object.label}" applied.`,
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
      `A8: verification mutated rows while refusing "${object.label}" (${rowsBefore} -> ${rowsDuring}).`,
    );
    await client.query(object.restore);
  }

  // ...and the restored catalog passes again, so the refusals above were about
  // the broken object and not about something else being permanently wrong.
  await verifyMigrationSchemaContract();

  console.log(
    `${LABEL} A8 PASS negative control: all ${contractObjects.length} contract objects — index drops, an id tie-break drift, a COALESCE-expression regression, a dropped environment key, a reversed retention ordering, a nullable provider_scope, three dropped columns, a SUBSET repair-plan arbiter, a PARTIAL repair-plan arbiter and both is_selected drifts — each cause verification to refuse before any mutation, and the restored catalog verifies clean`,
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
    const { runMigrations, resetMigrationLatchForSeams } = await import("@/lib/migrations");
    const rerunMigrations = async () => {
      resetMigrationLatchForSeams();
      await runMigrations({ force: true, reason: "release_gate_plan_seam_rerun" });
    };

    // FRESH catalog: migrations from zero must produce the contract.
    await runMigrations({ force: true, reason: "release_gate_plan_seam_fresh" });

    client = new Client({ connectionString });
    await client.connect();

    // UPGRADED catalog: drop the new objects to reproduce a pre-change
    // deployment, then re-run migrations and prove they are restored. A
    // contract that only holds on a fresh database says nothing about the
    // upgrade this change actually performs.
    await client.query(`DROP INDEX IF EXISTS idx_sync_release_gates_retention_scan`);
    await client.query(
      `ALTER TABLE sync_release_gates
         DROP COLUMN IF EXISTS provider_scope CASCADE,
         DROP COLUMN IF EXISTS decision_fingerprint,
         DROP COLUMN IF EXISTS last_seen_at,
         DROP COLUMN IF EXISTS coalesced_count`,
    );
    await rerunMigrations();
    const { verifyMigrationSchemaContract } = await import("@/lib/migration-verification");
    await verifyMigrationSchemaContract();
    console.log(
      `${LABEL} A0 PASS catalogs: the contract holds on a fresh migration AND after an upgrade from a catalog that had none of the new columns or indexes`,
    );

    await verifyLegacyBackfill(client, rerunMigrations);

    await seedVolume(client, SEED_ROWS, 0);
    await seedTargetKeys(client);
    await verifyPlans(client);
    await verifyRetentionPlan(client, async () => {
      const extra = 200_000;
      await seedVolume(client!, extra, SEED_ROWS + 1_000);
      await client!.query(`ANALYZE sync_release_gates`);
      return extra;
    });
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
