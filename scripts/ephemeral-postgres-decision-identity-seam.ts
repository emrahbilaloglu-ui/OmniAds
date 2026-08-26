/**
 * D-M011 / D-M012 — decision row identity, against a real PostgreSQL.
 *
 * The claims this seam exists for cannot be made by a mock, because every one
 * of them is a claim about what PostgreSQL does:
 *
 *   - a unique index with `NULLS NOT DISTINCT` lets two accounts hold a row of
 *     the same type on the same day while two legacy NULL-lineage rows still
 *     collide exactly as the old four-column key made them collide;
 *   - `provider_account_id IS NOT DISTINCT FROM $a` deletes one account's rows
 *     and leaves its sibling's;
 *   - the upgrade path preserves rows that were written before the column
 *     existed;
 *   - the response predicates separate two accounts that legitimately share a
 *     rec id.
 *
 * A stubbed `sql` returns whatever the test author wrote, so it can prove none
 * of that. This starts a real server, builds the real schema with the real
 * migration chain, rewinds it to the genuine pre-change shape, runs the REAL
 * migration entrypoint over rows that already exist, and then drives the
 * SHIPPED writers and predicates.
 *
 * Read-only against the outside world: no provider is contacted, no production
 * database is opened, and the server is torn down in `finally`.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "decision_identity_seam";
const USER = "postgres";
const LABEL = "[decision-identity-seam]";
const ACCOUNT_A = "act_1000000000001";
const ACCOUNT_B = "act_2000000000002";
const UNASSIGNED = "act_9000000000009";
const DATE = "2026-08-26";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`decision identity seam FAILED: ${message}`);
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

/**
 * Run the REAL migration entrypoint in a child process.
 *
 * `runMigrations` latches per process, so a second in-process call is a no-op —
 * and a no-op would make the upgrade half of this seam vacuous.
 */
async function runRealMigrations(databaseUrl: string, label: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/run-migrations.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DB_SSL_MODE: "disable",
      ENABLE_RUNTIME_MIGRATIONS: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number>((resolve) => child.on("close", resolve));
  assert(code === 0, `${label}: migrations exited ${code}. ${stderr.slice(-2000)}`);
}

/** One snapshot recommendation row, written the way the engine writes them. */
async function seedRecommendation(
  client: Client,
  input: {
    businessId: string;
    account: string | null;
    recId: string;
    recType: string;
    scopeType?: string;
    scopeId?: string;
    date?: string;
  },
) {
  await client.query(
    `INSERT INTO meta_decision_snapshots_daily
       (scope_type, scope_id, business_id, provider_account_id, snapshot_date,
        rec_id, rec_type, level, decision_state, confidence_score,
        recommended_action, reasoning, engine_version, kind)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7,
        'account', 'act', 0.9, 'Hold spend.', 'Seeded by the identity seam.',
        'identity-seam', 'recommendation')`,
    [
      input.scopeType ?? "account",
      input.scopeId ?? input.businessId,
      input.businessId,
      input.account,
      input.date ?? DATE,
      input.recId,
      input.recType,
    ],
  );
}

async function countRows(client: Client, businessId: string) {
  const rows = await client.query<{ provider_account_id: string | null; count: string }>(
    `SELECT provider_account_id, COUNT(*)::text AS count
     FROM meta_decision_snapshots_daily
     WHERE business_id = $1
     GROUP BY provider_account_id
     ORDER BY provider_account_id NULLS FIRST`,
    [businessId],
  );
  return rows.rows;
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-decision-identity-"));
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
    process.env.ENABLE_RUNTIME_MIGRATIONS = "true";
    process.env.DB_QUERY_TIMEOUT_MS = "30000";

    // ------------------------------------------------------- I1: from zero
    await runRealMigrations(connectionString, "I1");
    client = new Client({ connectionString });
    await client.connect();

    const identity = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'uq_meta_decision_snapshots_daily_identity'`,
    );
    assert(
      identity.rows.length === 1,
      "I1: uq_meta_decision_snapshots_daily_identity was not created from zero.",
    );
    const indexdef = identity.rows[0]!.indexdef;
    for (const column of [
      "scope_type",
      "scope_id",
      "snapshot_date",
      "rec_type",
      "provider_account_id",
    ]) {
      assert(indexdef.includes(column), `I1: the identity index omits ${column}: ${indexdef}`);
    }
    assert(
      /NULLS NOT DISTINCT/i.test(indexdef),
      `I1: the identity index is not NULLS NOT DISTINCT, so legacy NULL-lineage rows would stop colliding and would silently duplicate: ${indexdef}`,
    );
    const pk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'meta_decision_snapshots_daily'::regclass AND contype = 'p'`,
    );
    assert(
      pk.rows.length === 0,
      `I1: the four-column primary key survived (${pk.rows[0]?.conname}); it would keep two accounts from holding a row of the same type on the same day.`,
    );
    const responseAccount = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'meta_decision_responses' AND column_name = 'provider_account_id'`,
    );
    assert(
      responseAccount.rows[0]?.is_nullable === "YES",
      "I1: meta_decision_responses.provider_account_id is missing or NOT NULL; legacy rows and triage's synthetic ids cannot prove an account.",
    );
    console.log(
      `${LABEL} I1 PASS from zero: the five-column NULLS NOT DISTINCT identity index exists, the four-column primary key is gone, and the response lineage column is nullable`,
    );

    // ------------------------------------------ I2: collisions, for real
    const owner = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Identity seam', 'identity-seam@example.invalid', 'unused')
       RETURNING id::text AS id`,
    );
    const business = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id) VALUES ('Identity seam', $1::uuid)
       RETURNING id::text AS id`,
      [owner.rows[0]!.id],
    );
    const businessId = business.rows[0]!.id;

    // The SAME rec type, the SAME day, the SAME account-level scope — which is
    // the business id, because scopeForRecommendation puts it there. Under the
    // old key this second row could not exist, so one account's recommendation
    // had to answer for both.
    await seedRecommendation(client, {
      businessId,
      account: ACCOUNT_A,
      recId: "rec_shared",
      recType: "account_budget",
    });
    await seedRecommendation(client, {
      businessId,
      account: ACCOUNT_B,
      recId: "rec_shared",
      recType: "account_budget",
    });
    const both = await countRows(client, businessId);
    assert(
      both.length === 2 && both.every((row) => row.count === "1"),
      `I2: two accounts could not hold the same rec type on the same day: ${JSON.stringify(both)}`,
    );

    // ...and the legacy collision is preserved. Two NULL-lineage rows of the
    // same identity must still be one row, exactly as the old key made them.
    await seedRecommendation(client, {
      businessId,
      account: null,
      recId: "rec_legacy",
      recType: "legacy_type",
    });
    let duplicated = false;
    try {
      await seedRecommendation(client, {
        businessId,
        account: null,
        recId: "rec_legacy_2",
        recType: "legacy_type",
      });
      duplicated = true;
    } catch {
      duplicated = false;
    }
    assert(
      !duplicated,
      "I2: two NULL-lineage rows of one identity were both stored; NULLS NOT DISTINCT is not in force and legacy rows would silently duplicate.",
    );
    console.log(
      `${LABEL} I2 PASS collisions: two assigned accounts hold the same rec type on the same day, while two legacy NULL-lineage rows still collide`,
    );

    // ------------------------------- I3: refreshing one account spares another
    const accountRef = await client.query<{ id: string }>(
      `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone, updated_at)
       VALUES ('meta', $1, 'Seam A', 'USD', 'UTC', now())
       RETURNING id::text AS id`,
      [ACCOUNT_A],
    );
    const accountRefB = await client.query<{ id: string }>(
      `INSERT INTO provider_accounts (provider, external_account_id, account_name, currency, timezone, updated_at)
       VALUES ('meta', $1, 'Seam B', 'USD', 'UTC', now())
       RETURNING id::text AS id`,
      [ACCOUNT_B],
    );
    for (const [ref, position] of [
      [accountRef.rows[0]!.id, 0],
      [accountRefB.rows[0]!.id, 1],
    ] as const) {
      await client.query(
        `INSERT INTO business_provider_accounts
           (business_id, provider, provider_account_ref_id, provider_account_id, position, is_selected, updated_at)
         VALUES ($1, 'meta', $2::uuid, $3, $4, TRUE, now())`,
        [
          businessId,
          ref,
          ref === accountRef.rows[0]!.id ? ACCOUNT_A : ACCOUNT_B,
          position,
        ],
      );
    }

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMetaSnapshotForBusiness } = await import("@/lib/meta/snapshot");

    // Account A's refresh. It must clear A's rows and the unattributed ones,
    // and must not touch B — a business with two accounts refreshing one of
    // them would otherwise blank the other's whole day.
    await runMetaSnapshotForBusiness(businessId, DATE, ACCOUNT_A);
    const afterRefresh = await countRows(client, businessId);
    const byAccount = new Map(
      afterRefresh.map((row) => [row.provider_account_id, Number(row.count)]),
    );
    // A's own row IS gone — which is what proves the scoped DELETE fired at
    // all. Without this the case would pass just as well if the refresh had
    // deleted nothing.
    assert(
      (byAccount.get(ACCOUNT_A) ?? 0) === 0,
      `I3: account A's own row survived its own refresh, so the scoped DELETE never ran and the rest of this case proves nothing: ${JSON.stringify(afterRefresh)}`,
    );
    assert(
      (byAccount.get(ACCOUNT_B) ?? 0) === 1,
      `I3: refreshing account A destroyed account B's rows: ${JSON.stringify(afterRefresh)}`,
    );
    assert(
      !byAccount.has(null),
      `I3: the unattributed legacy row survived a refresh; it is invisible to an account-scoped read and visible to every business-scoped one: ${JSON.stringify(afterRefresh)}`,
    );
    console.log(
      `${LABEL} I3 PASS isolation: refreshing one account cleared its own rows and the unattributed ones, and left the sibling account's day intact`,
    );

    // ------------------------------- I4: an unassigned account is not computed
    const refused = await runMetaSnapshotForBusiness(businessId, DATE, UNASSIGNED);
    assert(
      refused.skippedReason === "provider_account_not_assigned",
      `I4: an account this workspace does not hold was computed anyway (skippedReason=${String(refused.skippedReason)}).`,
    );
    assert(
      refused.recommendationsWritten === 0,
      `I4: the refusal still wrote ${refused.recommendationsWritten} rows.`,
    );
    const afterRefusal = await countRows(client, businessId);
    assert(
      (new Map(afterRefusal.map((r) => [r.provider_account_id, Number(r.count)])).get(
        ACCOUNT_B,
      ) ?? 0) === 1,
      `I4: a refused run still mutated another account's rows: ${JSON.stringify(afterRefusal)}`,
    );
    console.log(
      `${LABEL} I4 PASS unassigned: a revoked selection is refused rather than computed, and nothing else is disturbed`,
    );

    // --------------------------- I5: two accounts, one rec id, four responses
    await seedRecommendation(client, {
      businessId,
      account: ACCOUNT_A,
      recId: "rec_collide",
      recType: "collide_type",
      scopeType: "campaign",
      scopeId: "camp_1",
    });
    await seedRecommendation(client, {
      businessId,
      account: ACCOUNT_B,
      recId: "rec_collide",
      recType: "collide_type",
      scopeType: "campaign",
      scopeId: "camp_1",
    });

    const { recordMetaDecisionResponseIfAuthorized } = await import(
      "@/lib/meta/decision-responses"
    );
    const { readServedMetaRecommendation } = await import(
      "@/lib/meta/served-recommendation"
    );

    const deferredUnderA = await recordMetaDecisionResponseIfAuthorized({
      recId: "rec_collide",
      businessId,
      providerAccountId: ACCOUNT_A,
      action: "deferred",
      reappearAt: "2099-01-01T00:00:00.000Z",
    });
    assert(deferredUnderA !== null, "I5: a deferral under an assigned account was refused.");

    // THE DEFECT. Under the old predicate this succeeded: the deferral was
    // matched on business + rec id, and account B's operator lifted account A's.
    const undeferFromB = await recordMetaDecisionResponseIfAuthorized({
      recId: "rec_collide",
      businessId,
      providerAccountId: ACCOUNT_B,
      action: "undeferred",
    });
    assert(
      undeferFromB === null,
      "I5: account B lifted account A's deferral; the undefer predicate is not account-scoped.",
    );
    const undeferFromA = await recordMetaDecisionResponseIfAuthorized({
      recId: "rec_collide",
      businessId,
      providerAccountId: ACCOUNT_A,
      action: "undeferred",
    });
    assert(
      undeferFromA !== null,
      "I5: the account that took the deferral could not lift it.",
    );
    const nullAccount = await recordMetaDecisionResponseIfAuthorized({
      recId: "rec_collide",
      businessId,
      providerAccountId: null,
      action: "acted",
    });
    assert(
      nullAccount === null,
      "I5: a response naming no physical account was accepted.",
    );
    console.log(
      `${LABEL} I5 PASS response identity: one rec id under two accounts stays separated — B cannot lift A's deferral, A can, and a response with no account is refused`,
    );

    // ------------------- I6: an account that is no longer selected is refused
    await client.query(
      `UPDATE business_provider_accounts SET is_selected = FALSE, updated_at = now()
       WHERE business_id = $1 AND provider = 'meta' AND provider_account_id = $2`,
      [businessId, ACCOUNT_B],
    );
    const revoked = await recordMetaDecisionResponseIfAuthorized({
      recId: "rec_collide",
      businessId,
      providerAccountId: ACCOUNT_B,
      action: "acted",
    });
    assert(
      revoked === null,
      "I6: an account whose selection was revoked could still record a decision from its leftover snapshot rows.",
    );
    const revokedVerdict = await readServedMetaRecommendation({
      businessId,
      recId: "rec_collide",
      action: "acted",
      providerAccountId: ACCOUNT_B,
    });
    assert(
      revokedVerdict.status === "not_served",
      `I6: the read-only predicate disagreed with the write predicate about a revoked account (${revokedVerdict.status}); the route would state the wrong refusal.`,
    );
    console.log(
      `${LABEL} I6 PASS revocation: an old snapshot row is not authority once the account is no longer selected, and both predicates agree`,
    );

    // ------------------------------------------- I7: the upgrade seam, for real
    //
    // The pre-change shape, rebuilt by hand: the lineage columns removed and the
    // four-column primary key restored. Then rows that predate the column, and
    // then the REAL migration entrypoint over them.
    await client.query(
      `DELETE FROM meta_decision_responses WHERE business_id = $1`,
      [businessId],
    );
    await client.query(
      `DELETE FROM meta_decision_snapshots_daily WHERE business_id = $1`,
      [businessId],
    );
    await client.query(
      `DROP INDEX IF EXISTS uq_meta_decision_snapshots_daily_identity`,
    );
    await client.query(
      `DROP INDEX IF EXISTS idx_meta_decision_snapshots_daily_business_account_date`,
    );
    await client.query(
      `DROP INDEX IF EXISTS idx_meta_decision_responses_business_account_rec`,
    );
    await client.query(
      `ALTER TABLE meta_decision_snapshots_daily DROP COLUMN IF EXISTS provider_account_id`,
    );
    await client.query(
      `ALTER TABLE meta_decision_responses DROP COLUMN IF EXISTS provider_account_id`,
    );
    await client.query(
      `ALTER TABLE meta_decision_snapshots_daily
         ADD CONSTRAINT meta_decision_snapshots_daily_pkey
         PRIMARY KEY (scope_type, scope_id, snapshot_date, rec_type)`,
    );
    const rewound = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'meta_decision_snapshots_daily' AND column_name = 'provider_account_id'`,
    );
    assert(
      rewound.rows.length === 0,
      "I7: the rewind did not remove the lineage column, so the upgrade proof would be vacuous.",
    );

    // A row written by the shipped-today engine, with no lineage to give it.
    await client.query(
      `INSERT INTO meta_decision_snapshots_daily
         (scope_type, scope_id, business_id, snapshot_date, rec_id, rec_type,
          level, decision_state, confidence_score, recommended_action,
          reasoning, engine_version, kind)
       VALUES ('account', $1, $1, $2::date, 'rec_pre_change', 'pre_change_type',
          'account', 'act', 0.9, 'Hold spend.', 'Written before the column existed.',
          'pre-change', 'recommendation')`,
      [businessId, DATE],
    );
    await client.query(
      `INSERT INTO meta_decision_responses (rec_id, business_id, action)
       VALUES ('rec_pre_change', $1, 'acted')`,
      [businessId],
    );

    await runRealMigrations(connectionString, "I7");

    const survivor = await client.query<{
      rec_id: string;
      provider_account_id: string | null;
      reasoning: string;
    }>(
      `SELECT rec_id, provider_account_id, reasoning
       FROM meta_decision_snapshots_daily WHERE business_id = $1`,
      [businessId],
    );
    assert(
      survivor.rows.length === 1 && survivor.rows[0]!.rec_id === "rec_pre_change",
      `I7: the pre-change snapshot row did not survive the upgrade: ${JSON.stringify(survivor.rows)}`,
    );
    assert(
      survivor.rows[0]!.provider_account_id === null,
      `I7: the upgrade invented a lineage for a row that has none (${String(survivor.rows[0]!.provider_account_id)}); a guessed account is worse than an absent one.`,
    );
    assert(
      survivor.rows[0]!.reasoning === "Written before the column existed.",
      "I7: the upgrade rewrote the pre-change row's content.",
    );
    const survivingResponse = await client.query<{ provider_account_id: string | null }>(
      `SELECT provider_account_id FROM meta_decision_responses WHERE business_id = $1`,
      [businessId],
    );
    assert(
      survivingResponse.rows.length === 1 &&
        survivingResponse.rows[0]!.provider_account_id === null,
      `I7: the pre-change response row did not survive with a null lineage: ${JSON.stringify(survivingResponse.rows)}`,
    );
    const upgradedIndex = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND indexname = 'uq_meta_decision_snapshots_daily_identity'`,
    );
    assert(
      upgradedIndex.rows.length === 1 &&
        /NULLS NOT DISTINCT/i.test(upgradedIndex.rows[0]!.indexdef),
      "I7: the upgrade did not build the identity index over existing rows.",
    );
    const upgradedPk = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'meta_decision_snapshots_daily'::regclass AND contype = 'p'`,
    );
    assert(
      upgradedPk.rows.length === 0,
      `I7: the upgrade left the old primary key in place (${upgradedPk.rows[0]?.conname}).`,
    );
    console.log(
      `${LABEL} I7 PASS upgrade: a real pre-change schema carrying rows written without the column was migrated in place — rows preserved, lineage left null rather than guessed, identity index built, old key dropped`,
    );

    // ------------------- I8: a legacy NULL-lineage row is not answerable at all
    const legacyVerdict = await readServedMetaRecommendation({
      businessId,
      recId: "rec_pre_change",
      action: "acted",
      providerAccountId: ACCOUNT_A,
    });
    assert(
      legacyVerdict.status === "not_served",
      `I8: a NULL-lineage row was actionable from account A (${legacyVerdict.status}); a row that might belong to another account must not be answerable from this one.`,
    );
    console.log(
      `${LABEL} I8 PASS legacy withheld: a row whose lineage cannot be proven is not actionable from any account`,
    );

    /*
     * ----------------------------------------------------------------- I9-I12
     *
     * Everything above proved the WRITE boundary. These prove the two readers
     * that consume what it wrote — History and outcome accrual — which is where
     * an account-ambiguous correlation actually reaches an operator.
     *
     * The schema is currently at the pre-change shape's upgrade, so a fresh
     * fixture is built here rather than reusing I2-I6's rows.
     */
    await client.query(`DELETE FROM meta_decision_responses WHERE business_id = $1`, [
      businessId,
    ]);
    await client.query(
      `DELETE FROM meta_decision_snapshots_daily WHERE business_id = $1`,
      [businessId],
    );
    await client.query(
      `DELETE FROM meta_decision_action_outcome_logs WHERE business_id = $1`,
      [businessId],
    );
    // B was deselected by I6; both accounts are assigned again for the reader
    // cases, because History is only ever read for an assigned account.
    await client.query(
      `UPDATE business_provider_accounts SET is_selected = TRUE, updated_at = now()
       WHERE business_id = $1 AND provider = 'meta'`,
      [businessId],
    );

    const HISTORY_DATE = "2026-08-20";
    const COLLIDING_REC = "rec_history_collide";
    // The same CAMPAIGN id under two accounts is impossible at Meta, so each
    // account gets its own campaign — but the same REC ID and rec type, which
    // is the collision the readers have to survive.
    const CAMPAIGN_A = "camp_hist_a";
    const CAMPAIGN_B = "camp_hist_b";

    for (const [account, campaign, hour] of [
      [ACCOUNT_A, CAMPAIGN_A, 1],
      [ACCOUNT_B, CAMPAIGN_B, 2],
    ] as const) {
      await client.query(
        `INSERT INTO meta_campaign_dimensions
           (business_id, provider_account_id, campaign_id, campaign_name_current, campaign_status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')
         ON CONFLICT DO NOTHING`,
        [businessId, account, campaign, `Campaign ${campaign}`],
      );
      await client.query(
        `INSERT INTO meta_decision_snapshots_daily
           (scope_type, scope_id, business_id, provider_account_id, snapshot_date,
            rec_id, rec_type, level, decision_state, confidence_score,
            recommended_action, reasoning, engine_version, kind)
         VALUES ('campaign', $3, $1, $2, $5::date, $4, 'collide_type',
            'campaign', 'act', 0.9, $6, 'Seeded by the identity seam.',
            'identity-seam', 'recommendation')`,
        [
          businessId,
          account,
          campaign,
          COLLIDING_REC,
          HISTORY_DATE,
          `Act on ${account}`,
        ],
      );
      /*
       * Distinct instants, because the primary key is
       * (rec_id, action, timestamp) and D-M012 deliberately did NOT add the
       * account to it: two operators answering are two moments, so the key
       * already separates them. Seeding one instant would collide, which is a
       * property of the fixture rather than of the accounts.
       */
      await client.query(
        `INSERT INTO meta_decision_responses
           (rec_id, business_id, provider_account_id, action, timestamp)
         VALUES ($1, $2, $3, 'acted', ($4::date + ($5::int * interval '1 hour')))`,
        [COLLIDING_REC, businessId, account, HISTORY_DATE, hour],
      );
      await client.query(
        `INSERT INTO meta_decision_action_outcome_logs
           (business_id, provider_account_id, recommendation_fingerprint, rec_id,
            rec_type, action_type, outcome_status, summary, occurred_at)
         VALUES ($1, $2, $3, $4, 'collide_type', 'outcome', 'improved',
            $5, ($6::date + ($7::int * interval '1 hour') + interval '3 hours'))`,
        [
          businessId,
          account,
          `meta_v1|${businessId}|campaign|${account === ACCOUNT_A ? CAMPAIGN_A : CAMPAIGN_B}|collide_type|${HISTORY_DATE}|${account}`,
          COLLIDING_REC,
          `outcome for ${account}`,
          HISTORY_DATE,
          hour,
        ],
      );
    }

    // A legacy row: no lineage anywhere, about account A's campaign. It must
    // be preserved and attributable to A by exact unique-entity inference, and
    // must never appear under B.
    const LEGACY_REC = "rec_history_legacy";
    await client.query(
      `INSERT INTO meta_decision_snapshots_daily
         (scope_type, scope_id, business_id, provider_account_id, snapshot_date,
          rec_id, rec_type, level, decision_state, confidence_score,
          recommended_action, reasoning, engine_version, kind)
       VALUES ('campaign', $2, $1, NULL, $4::date, $3, 'legacy_type',
          'campaign', 'act', 0.9, 'Legacy act.', 'Written before lineage existed.',
          'identity-seam', 'recommendation')`,
      [businessId, CAMPAIGN_A, LEGACY_REC, HISTORY_DATE],
    );

    const { readMetaHistoryJournal } = await import("@/lib/meta/history-read-model");

    async function historyFor(account: string) {
      return readMetaHistoryJournal({
        query: {
          businessId,
          providerAccountId: account,
          kind: null,
          entity: null,
          label: null,
          outcome: null,
          from: null,
          to: null,
          q: null,
          cursor: null,
          limit: 100,
        },
        account: { id: account, name: null, currency: "USD", timezone: "UTC" },
      });
    }

    const historyA = await historyFor(ACCOUNT_A);
    const historyB = await historyFor(ACCOUNT_B);

    const textA = JSON.stringify(historyA.entries);
    const textB = JSON.stringify(historyB.entries);
    assert(
      textA.includes(CAMPAIGN_A) && !textA.includes(CAMPAIGN_B),
      `I9: account A's history exposed account B's entity. A=${textA.slice(0, 1200)}`,
    );
    assert(
      textB.includes(CAMPAIGN_B) && !textB.includes(CAMPAIGN_A),
      `I9: account B's history exposed account A's entity. B=${textB.slice(0, 1200)}`,
    );
    assert(
      textA.includes(`outcome for ${ACCOUNT_A}`) &&
        !textA.includes(`outcome for ${ACCOUNT_B}`),
      "I9: account A's history carried account B's outcome row.",
    );
    assert(
      textB.includes(`outcome for ${ACCOUNT_B}`) &&
        !textB.includes(`outcome for ${ACCOUNT_A}`),
      "I9: account B's history carried account A's outcome row.",
    );
    // The colliding rec id appears in BOTH, once each — not twice in one and
    // none in the other, and not collapsed into a single shared entry.
    for (const [label, history] of [
      ["A", historyA],
      ["B", historyB],
    ] as const) {
      const responses = history.entries.filter(
        (entry) => entry.provenance.source === "meta_decision_responses",
      );
      assert(
        responses.length === 1,
        `I9: account ${label} saw ${responses.length} operator responses for one colliding rec id; each account has exactly one.`,
      );
    }
    // ...and the two accounts' snapshot entries have DIFFERENT ids, which the
    // four-column persisted_id could not express.
    const idsA = new Set(historyA.entries.map((entry) => entry.id));
    const collision = historyB.entries.filter((entry) => idsA.has(entry.id));
    assert(
      collision.length === 0,
      `I9: ${collision.length} journal entries carried the SAME id in both accounts (${collision
        .map((entry) => entry.id)
        .join(", ")}); the identity omits the physical account.`,
    );
    console.log(
      `${LABEL} I9 PASS History isolation: neither account's journal shows the other's snapshot, response or outcome, and one colliding rec id yields one entry per account with distinct ids`,
    );

    // ------------------------------------------ I10: legacy, preserved not stolen
    const legacyInA = historyA.entries.filter((entry) =>
      JSON.stringify(entry).includes(LEGACY_REC),
    );
    const legacyInB = historyB.entries.filter((entry) =>
      JSON.stringify(entry).includes(LEGACY_REC),
    );
    assert(
      legacyInA.length === 1,
      `I10: the legacy row was lost from the account its entity provably belongs to (${legacyInA.length} entries).`,
    );
    assert(
      legacyInA[0]!.provenance.accountScopeBasis === "unique_entity_key",
      `I10: the legacy row was reported as directly attributed (${legacyInA[0]!.provenance.accountScopeBasis}); an inference must say it is one.`,
    );
    assert(
      legacyInB.length === 0,
      "I10: a row with no lineage appeared under an account its entity does not belong to.",
    );
    console.log(
      `${LABEL} I10 PASS legacy lineage: an unattributed row is preserved under the account its entity uniquely proves, is labelled as an inference, and is absent from the other`,
    );

    // -------------------------- I11: KPI windows and accrued outcomes per account
    //
    // The SAME campaign id under both accounts, which is what makes a KPI map
    // keyed by scope id alone pool two accounts' spend into one row.
    const ACCRUAL_DATE = "2026-08-01";
    const SHARED_CAMPAIGN = "camp_shared_id";
    const ACCRUAL_REC = "rec_accrual_collide";
    await client.query(
      `DELETE FROM meta_decision_snapshots_daily WHERE business_id = $1`,
      [businessId],
    );
    await client.query(
      `DELETE FROM meta_decision_action_outcome_logs WHERE business_id = $1`,
      [businessId],
    );
    const { META_RECOMMENDATION_ENGINE_VERSION } = await import(
      "@/lib/meta/recommendations"
    );
    for (const [account, revenueAfter] of [
      [ACCOUNT_A, 4000],
      [ACCOUNT_B, 200],
    ] as const) {
      await client.query(
        `INSERT INTO meta_decision_snapshots_daily
           (scope_type, scope_id, business_id, provider_account_id, snapshot_date,
            rec_id, rec_type, level, decision_state, confidence_score,
            recommended_action, reasoning, engine_version, kind)
         VALUES ('campaign', $3, $1, $2, $4::date, $5, 'accrual_type',
            'campaign', 'act', 0.9, 'Act.', 'Seeded by the identity seam.',
            $6, 'recommendation')`,
        [
          businessId,
          account,
          SHARED_CAMPAIGN,
          ACCRUAL_DATE,
          ACCRUAL_REC,
          META_RECOMMENDATION_ENGINE_VERSION,
        ],
      );
      // Before: 1000 spend / 1000 revenue (ROAS 1.0). After: 1000 spend and
      // an account-specific revenue, so A improves and B regresses. A pooled
      // read would give BOTH accounts the same middling answer.
      for (let day = -6; day <= 7; day += 1) {
        const isBefore = day <= 0;
        await client.query(
          `INSERT INTO meta_campaign_daily
             (business_id, provider_account_id, campaign_id, date, account_timezone,
              account_currency, spend, revenue)
           VALUES ($1, $2, $3, ($4::date + ($5::int)), 'UTC', 'USD', $6, $7)
           ON CONFLICT DO NOTHING`,
          [
            businessId,
            account,
            SHARED_CAMPAIGN,
            ACCRUAL_DATE,
            day,
            1000 / 7,
            isBefore ? 1000 / 7 : revenueAfter / 7,
          ],
        );
      }
    }

    const { runMetaOutcomeAccrualForBusiness } = await import(
      "@/lib/meta/outcome-accrual"
    );
    // The accrual runs for `now - 8 days`, so `now` is chosen to make
    // ACCRUAL_DATE the candidate date.
    const accrualNow = new Date("2026-08-09T05:00:00.000Z");
    const firstRun = await runMetaOutcomeAccrualForBusiness(businessId, accrualNow);
    assert(
      firstRun.candidates === 2 && firstRun.written === 2,
      `I11: expected one candidate and one outcome PER ACCOUNT, got ${firstRun.candidates}/${firstRun.written}. A business-wide fingerprint collapses them to one.`,
    );

    const accrued = await client.query<{
      provider_account_id: string | null;
      outcome_status: string;
      recommendation_fingerprint: string;
    }>(
      `SELECT provider_account_id, outcome_status, recommendation_fingerprint
       FROM meta_decision_action_outcome_logs
       WHERE business_id = $1 AND action_type = 'outcome'
       ORDER BY provider_account_id`,
      [businessId],
    );
    assert(
      accrued.rows.length === 2,
      `I11: ${accrued.rows.length} outcome rows for two accounts.`,
    );
    // Attributed at all, before anything is asserted about the numbers. Under
    // the business-wide accrual both rows landed with a null account, and every
    // check below would then fail for the wrong stated reason.
    assert(
      accrued.rows.every((row) => row.provider_account_id !== null),
      `I11: an accrued outcome carries no physical account: ${JSON.stringify(accrued.rows.map((row) => row.provider_account_id))}. It cannot be told apart from the sibling account's.`,
    );
    const accruedByAccount = new Map(
      accrued.rows.map((row) => [row.provider_account_id, row]),
    );
    assert(
      accruedByAccount.get(ACCOUNT_A)?.outcome_status === "improved",
      `I11: account A's outcome was ${accruedByAccount.get(ACCOUNT_A)?.outcome_status}, not improved — its KPI window was pooled with the sibling account's.`,
    );
    assert(
      accruedByAccount.get(ACCOUNT_B)?.outcome_status === "regressed",
      `I11: account B's outcome was ${accruedByAccount.get(ACCOUNT_B)?.outcome_status}, not regressed — its KPI window was pooled with the sibling account's.`,
    );
    assert(
      accruedByAccount.get(ACCOUNT_A)!.recommendation_fingerprint !==
        accruedByAccount.get(ACCOUNT_B)!.recommendation_fingerprint,
      "I11: both accounts were written under ONE fingerprint; the second would have been suppressed as a duplicate.",
    );
    console.log(
      `${LABEL} I11 PASS KPI isolation: one campaign id under two accounts accrues two outcomes with opposite verdicts (improved / regressed) and two distinct fingerprints`,
    );

    // ------------------------------- I12: idempotency is per account, not per business
    const secondRun = await runMetaOutcomeAccrualForBusiness(businessId, accrualNow);
    assert(
      secondRun.candidates === 0 && secondRun.written === 0,
      `I12: a rerun wrote ${secondRun.written} more outcomes; accrual is not idempotent.`,
    );
    const afterRerun = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM meta_decision_action_outcome_logs
       WHERE business_id = $1 AND action_type = 'outcome'`,
      [businessId],
    );
    assert(
      afterRerun.rows[0]!.count === "2",
      `I12: ${afterRerun.rows[0]!.count} outcome rows after a rerun; expected the same two.`,
    );

    // ...and deleting ONE account's outcome re-opens exactly that account.
    await client.query(
      `DELETE FROM meta_decision_action_outcome_logs
       WHERE business_id = $1 AND provider_account_id = $2`,
      [businessId, ACCOUNT_B],
    );
    const reopened = await runMetaOutcomeAccrualForBusiness(businessId, accrualNow);
    assert(
      reopened.candidates === 1 && reopened.written === 1,
      `I12: after removing only account B's outcome, ${reopened.candidates} candidates re-opened; account A's surviving row must not answer for B, and B's absence must not re-open A.`,
    );
    const reopenedRow = await client.query<{ provider_account_id: string | null }>(
      `SELECT provider_account_id FROM meta_decision_action_outcome_logs
       WHERE business_id = $1 AND action_type = 'outcome'
       ORDER BY occurred_at DESC LIMIT 1`,
      [businessId],
    );
    assert(
      reopenedRow.rows[0]!.provider_account_id === ACCOUNT_B,
      `I12: the re-opened candidate wrote for ${String(reopenedRow.rows[0]!.provider_account_id)} rather than account B.`,
    );
    console.log(
      `${LABEL} I12 PASS idempotency: one outcome per ACCOUNT — a rerun writes nothing, and removing one account's outcome re-opens that account alone`,
    );

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
