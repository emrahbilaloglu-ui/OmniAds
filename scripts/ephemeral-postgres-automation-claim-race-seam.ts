/**
 * The Automation execution claim, proven against a real PostgreSQL.
 *
 * Three things are checked here, in one throwaway cluster:
 *
 * 1. **Migration from zero.** An empty database, migrated by the repo's real
 *    deploy entry point, must end up with the claim columns, the widened status
 *    vocabulary, the unique claim token and the OPEN-slot partial index — and
 *    without the pending-only slot index the open one replaces.
 * 2. **Upgrade from the old schema.** The same migration, run over a database
 *    that already holds the pre-claim table and a live `pending` row, must be
 *    additive: the legacy row survives byte-for-byte, and afterwards it can be
 *    claimed. A migration that only works from zero is not a migration.
 * 3. **The concurrency claim itself**, by handing the migrated database to
 *    `lib/meta/automation-proposal-claim-race.db.test.ts`, which drives the
 *    REAL route handler with a FAKE provider and counts dispatches.
 * 4. **The reconcile slot and the post-dispatch settle exception**, by handing
 *    a THIRD database to `lib/meta/automation-proposal-reconcile-slot.db.test.ts`:
 *    a row whose provider outcome is unknown must keep holding its entity's
 *    action slot against every producer, and a settle that throws AFTER the
 *    provider answered must leave a durable receipt, refuse to report success,
 *    and refuse a second dispatch.
 * 5. **The deploy gate, observed REFUSING.** The claim schema is built out of
 *    statements that swallow their own errors, so the post-migration verifier is
 *    the only thing that can turn a failed step into a failed release. A gate
 *    nobody has watched refuse is not a gate, so a genuinely unrepairable schema
 *    state is reproduced on a FOURTH database and the migration is required to
 *    exit non-zero over it.
 *
 * Safety, restated because this file creates and drops schema:
 * - Ports 5432 (local volume Postgres) and 15432 (the live production tunnel)
 *   are refused outright.
 * - `DATABASE_URL` is force-set on every child's env; `@next/env` never
 *   overrides a pre-existing value, so `.env.local`'s production tunnel cannot
 *   leak into a migration run.
 * - The cluster and its temp directory are torn down in `finally`, on success
 *   and on failure alike.
 * - No Meta client is imported anywhere in this seam. The provider is mocked
 *   inside the vitest child; real provider writes performed: zero.
 *
 * Usage: npm run test:automation-claim-race-seam
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const USER = "postgres";
const FROM_ZERO_DB = "automation_claim_race_seam";
const UPGRADE_DB = "automation_claim_upgrade_seam";
const RECONCILE_DB = "automation_reconcile_slot_seam";
const GATE_DB = "automation_claim_gate_seam";
const LABEL = "[automation-claim-race-seam]";
const RACE_TEST = "lib/meta/automation-proposal-claim-race.db.test.ts";
const RECONCILE_TEST = "lib/meta/automation-proposal-reconcile-slot.db.test.ts";
const PRODUCER_SLOT_TEST = "lib/meta/proposal-producer-open-slot.db.test.ts";

function log(message: string) {
  console.log(`${LABEL} ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`automation claim seam FAILED: ${message}`);
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
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
    throw new Error(
      `${label} failed (${result.status}). ${result.stderr?.trim() ?? ""}`,
    );
  }
}

async function runChild(
  command: string,
  args: string[],
  databaseUrl: string,
  label: string,
  extraEnv: Record<string, string> = {},
) {
  log(`running ${label}...`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      // Pre-set so `@next/env`'s loadEnvConfig cannot substitute the
      // production tunnel from .env.local: it skips keys already in env.
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      DB_SSL_MODE: "disable",
      ENABLE_RUNTIME_MIGRATIONS: "1",
      ADSECUTE_EPHEMERAL_DB_SEAM: "1",
      ...extraEnv,
    },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${label} exited with code ${code}.`);
  log(`${label} exited clean.`);
}

/**
 * Run a child that MUST fail, and fail the seam when it succeeds.
 *
 * The negative control needs its own runner because a passing migration is the
 * defect here: a gate that cannot be observed refusing has not been observed at
 * all.
 */
async function runChildExpectingFailure(
  command: string,
  args: string[],
  databaseUrl: string,
  label: string,
) {
  log(`running ${label} (expecting a NON-ZERO exit)...`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      DB_SSL_MODE: "disable",
      ENABLE_RUNTIME_MIGRATIONS: "1",
      ADSECUTE_EPHEMERAL_DB_SEAM: "1",
    },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  assert(
    code !== 0,
    `${label}: the migration reported SUCCESS over a schema that cannot support the code about to run on it`,
  );
  log(`${label} refused the release with exit code ${code}, as required.`);
}

const migrate = (databaseUrl: string, label: string) =>
  runChild(
    process.execPath,
    ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
    databaseUrl,
    label,
  );

async function withClient<T>(
  connectionString: string,
  body: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end();
  }
}

async function columnExists(client: Client, column: string) {
  const rows = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'meta_automation_proposals'
         AND column_name = $1
     ) AS exists`,
    [column],
  );
  return rows.rows[0]!.exists;
}

async function indexDefinition(client: Client, indexName: string) {
  const rows = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = current_schema() AND indexname = $1`,
    [indexName],
  );
  return rows.rows[0]?.indexdef ?? null;
}

async function statusConstraintDefinition(client: Client) {
  const rows = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = current_schema()
       AND t.relname = 'meta_automation_proposals'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%dismissed%'`,
  );
  return rows.rows.map((row) => row.def);
}

/** Everything the claim depends on, asserted against the real catalog. */
async function assertClaimSchema(connectionString: string, label: string) {
  await withClient(connectionString, async (client) => {
    for (const column of [
      "claim_token",
      "claimed_by",
      "claimed_at",
      "dispatch_started_at",
    ]) {
      assert(
        await columnExists(client, column),
        `${label}: meta_automation_proposals.${column} is missing`,
      );
    }

    const statusDefs = await statusConstraintDefinition(client);
    assert(
      statusDefs.length > 0,
      `${label}: the proposal status CHECK constraint is missing entirely`,
    );
    assert(
      statusDefs.every(
        (def) => def.includes("'claimed'") && def.includes("'reconcile'"),
      ),
      `${label}: a status CHECK still refuses 'claimed'/'reconcile': ${statusDefs.join(" | ")}`,
    );

    const openSlot = await indexDefinition(
      client,
      "uq_meta_automation_proposals_open_slot",
    );
    assert(openSlot, `${label}: the open-slot unique index is missing`);
    // `reconcile` is asserted alongside pending and claimed because leaving it
    // out is the whole defect: a stale claim whose dispatch had started is
    // swept into `reconcile`, and a pending+claimed predicate then reads that
    // entity's action slot as FREE. The next projection or rule firing could
    // queue a second pause for an entity that may already be paused at Meta.
    assert(
      openSlot!.includes("UNIQUE") &&
        openSlot!.includes("'pending'") &&
        openSlot!.includes("'claimed'") &&
        openSlot!.includes("'reconcile'"),
      `${label}: the open-slot index does not cover pending AND claimed AND reconcile: ${openSlot}`,
    );

    const legacySlot = await indexDefinition(
      client,
      "uq_meta_automation_proposals_pending_slot",
    );
    assert(
      legacySlot === null,
      `${label}: the pending-only slot index survived the upgrade that supersedes it`,
    );

    const claimToken = await indexDefinition(
      client,
      "uq_meta_automation_proposals_claim_token",
    );
    assert(
      claimToken && claimToken.includes("UNIQUE"),
      `${label}: the claim token is not unique, so a receipt key would not identify one attempt`,
    );

    // The durable reconciliation outbox: where a receipt goes when the write
    // that had to record the provider's answer failed. Without it, that path
    // has nowhere to put the one piece of evidence an operator needs.
    const outbox = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('meta_automation_reconciliation_receipts') IS NOT NULL AS exists`,
    );
    assert(
      outbox.rows[0]?.exists,
      `${label}: meta_automation_reconciliation_receipts is missing`,
    );
    const outboxKey = await indexDefinition(
      client,
      "uq_meta_automation_reconciliation_claim_token",
    );
    assert(
      outboxKey && outboxKey.includes("UNIQUE"),
      `${label}: one attempt could hold two reconciliation receipts`,
    );
    const appendOnly = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema()
           AND c.relname = 'meta_automation_reconciliation_receipts'
           AND t.tgname = 'trg_meta_automation_reconciliation_append_only'
       ) AS exists`,
    );
    assert(
      appendOnly.rows[0]?.exists,
      `${label}: the reconciliation receipt is rewritable, so an attempt's recorded facts are not evidence`,
    );
  });
}

/**
 * Rewind the proposals table to its pre-claim shape, with a live row in it.
 *
 * This is how the upgrade is tested honestly: the old schema is REAL — the same
 * column list, the same status CHECK, the same pending-only slot index the
 * previous release shipped — and it holds a row an operator was already
 * waiting on.
 */
async function seedPreClaimSchema(connectionString: string) {
  return withClient(connectionString, async (client) => {
    await client.query(`DROP INDEX IF EXISTS uq_meta_automation_proposals_open_slot`);
    await client.query(
      `DROP INDEX IF EXISTS uq_meta_automation_proposals_claim_token`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_automation_proposals_pending_slot
       ON meta_automation_proposals (business_id, provider_account_id, decision_key, proposed_action)
       WHERE status = 'pending'`,
    );
    await client.query(
      `ALTER TABLE meta_automation_proposals
         DROP COLUMN IF EXISTS claim_token,
         DROP COLUMN IF EXISTS claimed_by,
         DROP COLUMN IF EXISTS claimed_at,
         DROP COLUMN IF EXISTS dispatch_started_at`,
    );
    await client.query(`
      DO $$
      DECLARE
        widened TEXT;
      BEGIN
        SELECT c.conname INTO widened
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'meta_automation_proposals'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%claimed%'
        LIMIT 1;
        IF widened IS NOT NULL THEN
          EXECUTE format('ALTER TABLE meta_automation_proposals DROP CONSTRAINT %I', widened);
        END IF;
        ALTER TABLE meta_automation_proposals
          ADD CONSTRAINT meta_automation_proposals_status_check
          CHECK (status IN ('pending', 'approved', 'failed', 'modified', 'dismissed', 'expired'));
      END $$;
    `);

    const user = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Upgrade seam', 'claim-upgrade@example.invalid', 'x')
       RETURNING id::text AS id`,
    );
    const business = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Claim upgrade business', $1::uuid) RETURNING id::text AS id`,
      [user.rows[0]!.id],
    );
    const proposal = await client.query<{ id: string; updated_at: string }>(
      `INSERT INTO meta_automation_proposals (
         business_id, provider_account_id, origin, decision_key, scope_type,
         scope_id, rec_id, rec_type, snapshot_date, engine_version,
         decision_label, proposed_action, action_label, primary_caption,
         entity_label, reason, evidence_label, evidence_ref, expires_at, status
       ) VALUES (
         $1::uuid, 'act_upgrade', 'engine_decision', 'adset:legacy_1', 'adset',
         'legacy_1', 'rec_legacy', 'scenario_legacy_cut', CURRENT_DATE, 'meta-v3',
         'cut', 'pause', 'Pause ad set', 'Approve & apply',
         'Legacy ad set', 'ROAS below breakeven.', NULL,
         '{}'::jsonb, NOW() + INTERVAL '6 hours', 'pending'
       )
       RETURNING id::text AS id, updated_at::text AS updated_at`,
      [business.rows[0]!.id],
    );
    return {
      businessId: business.rows[0]!.id,
      userId: user.rows[0]!.id,
      proposalId: proposal.rows[0]!.id,
      updatedAt: proposal.rows[0]!.updated_at,
    };
  });
}

/**
 * Put the database into the state a swallowed widening leaves behind.
 *
 * The narrow pending+claimed slot index is restored, and two rows are inserted
 * that it permits while the widened pending+claimed+reconcile index does not:
 * one `pending` and one `reconcile` for the SAME entity and action. That pair is
 * precisely the duplicate the widened index exists to forbid — and precisely
 * what makes the widening unable to succeed, so the swallowed failure is real
 * rather than simulated.
 */
async function seedNarrowSlotConflict(connectionString: string) {
  return withClient(connectionString, async (client) => {
    await client.query(
      `DROP INDEX IF EXISTS uq_meta_automation_proposals_open_slot`,
    );
    await client.query(
      `CREATE UNIQUE INDEX uq_meta_automation_proposals_open_slot
       ON meta_automation_proposals (business_id, provider_account_id, decision_key, proposed_action)
       WHERE status IN ('pending', 'claimed')`,
    );

    const user = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Gate seam', 'claim-gate@example.invalid', 'x')
       RETURNING id::text AS id`,
    );
    const business = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ('Claim gate business', $1::uuid) RETURNING id::text AS id`,
      [user.rows[0]!.id],
    );
    const businessId = business.rows[0]!.id;

    for (const [status, recType] of [
      ["pending", "scenario_gate_pending"],
      ["reconcile", "scenario_gate_reconcile"],
    ] as const) {
      await client.query(
        `INSERT INTO meta_automation_proposals (
           business_id, provider_account_id, origin, decision_key, scope_type,
           scope_id, rec_id, rec_type, snapshot_date, engine_version,
           decision_label, proposed_action, action_label, primary_caption,
           reason, evidence_ref, expires_at, status, claim_token,
           dispatch_started_at
         ) VALUES (
           $1::uuid, 'act_gate', 'engine_decision', 'adset:gate_1', 'adset',
           'gate_1', 'rec_gate', $2, CURRENT_DATE, 'meta-v3',
           'cut', 'pause', 'Pause ad set', 'Approve & apply',
           'ROAS below breakeven.', '{}'::jsonb, NOW() + INTERVAL '6 hours', $3,
           CASE WHEN $3 = 'reconcile' THEN gen_random_uuid() ELSE NULL END,
           CASE WHEN $3 = 'reconcile' THEN NOW() ELSE NULL END
         )`,
        [businessId, recType, status],
      );
    }
    return { businessId };
  });
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  assert(!FORBIDDEN_PORTS.has(port), `refusing port ${port}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-claim-race-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  let started = false;

  log(`pg binaries: ${bin}`);
  log(`port:        ${port} (never 5432 / 15432)`);

  try {
    run(
      path.join(bin, "initdb"),
      ["-D", dataDir, "-U", USER, "--auth=trust", "--encoding=UTF8", "--no-locale"],
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
        "-t",
        "60",
        "-o",
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off`,
        "start",
      ],
      "pg_ctl start",
    );
    started = true;

    for (const db of [FROM_ZERO_DB, UPGRADE_DB, RECONCILE_DB, GATE_DB]) {
      run(
        path.join(bin, "createdb"),
        ["-h", "127.0.0.1", "-p", String(port), "-U", USER, db],
        `createdb ${db}`,
      );
    }

    const fromZeroUrl = `postgresql://${USER}@127.0.0.1:${port}/${FROM_ZERO_DB}`;
    const upgradeUrl = `postgresql://${USER}@127.0.0.1:${port}/${UPGRADE_DB}`;
    const reconcileUrl = `postgresql://${USER}@127.0.0.1:${port}/${RECONCILE_DB}`;
    const gateUrl = `postgresql://${USER}@127.0.0.1:${port}/${GATE_DB}`;

    // ── 1. migration from zero ────────────────────────────────────────────
    await migrate(fromZeroUrl, "migrations from zero");
    await assertClaimSchema(fromZeroUrl, "from zero");
    await migrate(reconcileUrl, "migrations (reconcile slot base)");
    await assertClaimSchema(reconcileUrl, "reconcile slot base");
    log("PASS: migration from zero builds the claim schema.");

    // ── 2. upgrade from the old schema ────────────────────────────────────
    await migrate(upgradeUrl, "migrations (upgrade base)");
    const legacy = await seedPreClaimSchema(upgradeUrl);
    await withClient(upgradeUrl, async (client) => {
      assert(
        !(await columnExists(client, "claim_token")),
        "upgrade base was not actually rewound to the pre-claim shape",
      );
    });

    // An unmigrated database must REFUSE to claim rather than fall back to an
    // unclaimed dispatch. This is the one state where the old both-requests-
    // reach-the-provider race could come back, so it is proven against a real
    // pre-claim schema rather than asserted from a mock.
    process.env.DATABASE_URL = upgradeUrl;
    process.env.DATABASE_URL_UNPOOLED = upgradeUrl;
    process.env.DB_SSL_MODE = "disable";
    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { claimMetaAutomationProposal } = await import(
      "@/lib/meta/automation-proposals"
    );
    const refused = await claimMetaAutomationProposal({
      businessId: legacy.businessId,
      providerAccountId: "act_upgrade",
      proposalId: legacy.proposalId,
      claimedBy: legacy.userId,
    });
    assert(
      refused.status === "migration_required",
      `pre-claim schema: expected migration_required, got ${refused.status}`,
    );
    await withClient(upgradeUrl, async (client) => {
      const row = await client.query<{ status: string }>(
        `SELECT status FROM meta_automation_proposals WHERE id = $1::uuid`,
        [legacy.proposalId],
      );
      assert(
        row.rows[0]?.status === "pending",
        "pre-claim schema: the refused claim still moved the row",
      );
    });
    resetDbClientCache();
    log("PASS: an unmigrated database refuses to claim instead of dispatching.");
    // A separate child process, because lib/migrations.ts keeps module-level
    // "already completed" state: an in-process re-run would be a no-op and
    // would prove nothing about upgrading.
    await migrate(upgradeUrl, "migrations over the pre-claim schema");
    await assertClaimSchema(upgradeUrl, "upgrade");

    await withClient(upgradeUrl, async (client) => {
      const row = await client.query<{
        status: string;
        reason: string;
        claim_token: string | null;
        updated_at: string;
      }>(
        `SELECT status, reason, claim_token::text AS claim_token, updated_at::text AS updated_at
         FROM meta_automation_proposals WHERE id = $1::uuid`,
        [legacy.proposalId],
      );
      const legacyRow = row.rows[0];
      assert(legacyRow, "upgrade: the legacy pending row did not survive");
      assert(
        legacyRow!.status === "pending",
        `upgrade: the legacy row's status changed to ${legacyRow!.status}`,
      );
      assert(
        legacyRow!.reason === "ROAS below breakeven.",
        "upgrade: the legacy row's content was rewritten",
      );
      assert(
        legacyRow!.claim_token === null,
        "upgrade: a legacy row was given a claim it never took",
      );
      assert(
        legacyRow!.updated_at === legacy.updatedAt,
        "upgrade: the legacy row was touched by a migration that claims to be additive",
      );

      // And the upgraded row is claimable, which is the point of the upgrade.
      const claimed = await client.query<{ id: string }>(
        `UPDATE meta_automation_proposals
         SET status = 'claimed', claim_token = gen_random_uuid(),
             claimed_by = $2::uuid, claimed_at = NOW()
         WHERE id = $1::uuid AND status = 'pending'
         RETURNING id`,
        [legacy.proposalId, legacy.userId],
      );
      assert(
        claimed.rowCount === 1,
        "upgrade: the legacy row could not be claimed after the migration",
      );
    });
    log("PASS: the claim migration is additive over the pre-claim schema.");

    // ── 3. the concurrency proof ──────────────────────────────────────────
    await runChild(
      "npx",
      ["vitest", "run", RACE_TEST],
      fromZeroUrl,
      "claim race (real Postgres, fake provider)",
      {
        // The write guard short-circuits under vitest unless this is set; the
        // race must clear the REAL guard, against the REAL control row.
        META_AUTOMATION_WRITE_GUARD_TEST_READS: "1",
        /*
          And the environment capability that guard now reads.

          This release gives Meta ONE write capability
          (`getMetaWriteBlockState` -> `release_capability_closed`), and the
          real guard refuses every approval while it is shut. With the guard
          short-circuited that was invisible; with `..._TEST_READS` on, all
          eight racing approvals came back
          `{"code":"release_capability_closed"}`, no dispatch happened, and the
          two provider-call assertions failed while the five that only inspect
          the claim still passed — which is exactly what this seam is for.

          Declaring it here is the same thing every other provider-writing seam
          in this delivery does (the duplicate-ad and activation-identity
          children set it for themselves). It states the environment the seam
          needs; it does not weaken the guard, which is precisely what refused.
        */
        META_AUTOMATION_LIVE_WRITES: "true",
      },
    );

    log("PASS: two concurrent approvals reach the provider exactly once.");

    // ── 4. the reconcile slot, and the post-dispatch settle exception ─────
    //
    // A separate database because both suites assert on COUNTS of rows for one
    // business and one account, and sharing a database with the race suite
    // would make each one's fixtures the other's noise.
    await runChild(
      "npx",
      ["vitest", "run", RECONCILE_TEST],
      reconcileUrl,
      "reconcile slot + settle fault injection (real Postgres, fake provider)",
      {
        META_AUTOMATION_WRITE_GUARD_TEST_READS: "1",
        // Same real guard, same capability. See the race child above.
        META_AUTOMATION_LIVE_WRITES: "true",
      },
    );

    log(
      "PASS: a reconcile row holds the slot, and a post-dispatch settle failure " +
        "is held for reconciliation with the receipt durable and re-dispatch refused.",
    );

    await runChild(
      "npx",
      ["vitest", "run", PRODUCER_SLOT_TEST],
      reconcileUrl,
      "budget + bid producer open-slot arbitration (real Postgres)",
    );
    log(
      "PASS: budget and bid projection inserts preserve one open slot under " +
        "pending, claimed, reconcile, idempotent refresh, and concurrent contention.",
    );

    // ── 5. the deploy gate, observed REFUSING ────────────────────────────
    //
    // Every statement that builds the claim schema ends in `.catch(() => {})`,
    // so a failed step is invisible to the migration itself. The verifier is
    // what turns that into a failed release — and a gate nobody has watched
    // refuse is not a gate, so this reproduces a genuinely unrepairable state
    // and requires the migration to exit NON-ZERO over it.
    //
    // The state is real, not synthetic sabotage of the verifier: the narrow
    // pending+claimed slot index is restored, and two rows are inserted that it
    // permits and the widened one does not. The migration's widening step then
    // raises inside its DO block, its own `.catch` swallows the error, the DROP
    // it attempted rolls back with it — and the schema is left with a slot
    // guard that does NOT hold `reconcile`. Exactly the shape of the defect.
    await migrate(gateUrl, "migrations (deploy gate base)");
    const gateFixture = await seedNarrowSlotConflict(gateUrl);
    await withClient(gateUrl, async (client) => {
      const predicate = await indexDefinition(
        client,
        "uq_meta_automation_proposals_open_slot",
      );
      assert(
        predicate && !predicate.includes("'reconcile'"),
        "deploy gate: the fixture did not actually restore the narrow slot index",
      );
    });

    await runChildExpectingFailure(
      process.execPath,
      ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
      gateUrl,
      "deploy gate (migration over an unwidenable slot index)",
    );

    await withClient(gateUrl, async (client) => {
      // The refusal must not have destroyed the guard it was checking: the
      // narrow index still stands, so the database is not left with NO slot
      // uniqueness at all while the release is blocked.
      const predicate = await indexDefinition(
        client,
        "uq_meta_automation_proposals_open_slot",
      );
      assert(
        predicate && !predicate.includes("'reconcile'"),
        "deploy gate: the failed widening left the table without its previous slot index",
      );
      const rows = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM meta_automation_proposals
         WHERE business_id = $1::uuid`,
        [gateFixture.businessId],
      );
      assert(
        rows.rows[0]?.count === "2",
        "deploy gate: the refused migration changed live rows",
      );
    });

    log(
      "PASS: a SWALLOWED claim-schema migration failure fails the release " +
        "instead of announcing migrations_completed over it.",
    );
  } catch (error) {
    if (fs.existsSync(logFile)) {
      console.error(
        `${LABEL} postgres log tail:\n${fs
          .readFileSync(logFile, "utf8")
          .split(/\r?\n/)
          .slice(-40)
          .join("\n")}`,
      );
    }
    throw error;
  } finally {
    if (started) {
      const stop = spawnSync(
        path.join(bin, "pg_ctl"),
        ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
        { encoding: "utf8" },
      );
      if (stop.status !== 0) {
        console.error(
          `${LABEL} warning: pg_ctl stop exited with ${stop.status}: ${stop.stderr?.trim() ?? ""}`,
        );
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    log(`temp dir removed: ${tmp}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
