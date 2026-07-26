/**
 * S1-S6 — provider account selection races, against a real PostgreSQL.
 *
 * A selection is authorised by two independent pieces of evidence: the
 * credential the accounts were reached with, and the discovery snapshot that
 * listed them. Both can be replaced while a request is in flight, and the write
 * used to be guarded against neither properly:
 *
 *   - the connection generation was captured AFTER validation, so a reconnect
 *     landing during validation was invisible;
 *   - the generation check read the connection row WITHOUT locking it, so a
 *     reconnect could still commit between that read and the write's commit;
 *   - the discovery snapshot was not bound at all, so a refresh under the same
 *     credential could replace the account list and the write committed anyway;
 *   - the wrapper discarded the verified in-transaction readback and re-read
 *     after commit, unlocked, so the response could describe another request's
 *     selection.
 *
 * Nothing about those windows is provable with a mock: they are decided by
 * PostgreSQL row locks, advisory locks, MVCC visibility and transaction
 * rollback. So this seam starts a real server, builds the real schema with the
 * real migration chain, and drives the real writer while SEPARATE `pg` clients
 * reconnect, replace the snapshot and inject a failure underneath it.
 *
 * Every refusal is checked twice over: the selected set must be byte-identical
 * to what it was before, and the partition queue must not have grown. A refusal
 * that mutated nothing but still enqueued work would start syncing accounts
 * nobody selected.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB = "selection_race_seam";
const USER = "postgres";
const LABEL = "[selection-race-seam]";
const PROVIDER = "meta" as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`selection race seam FAILED: ${message}`);
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a promise is still pending after `ms`.
 *
 * This is how the row lock is proven rather than assumed: a writer that did NOT
 * take `FOR UPDATE` would read the pre-reconnect generation and run straight to
 * a commit, so it would have settled long before the reconnect committed.
 */
async function stillPending(promise: Promise<unknown>, ms: number) {
  const pendingMarker = Symbol("pending");
  const settled = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    sleep(ms).then(() => pendingMarker),
  ]);
  return settled === pendingMarker;
}

/** Everything a refusal must leave untouched, as one comparable value. */
interface SelectionFacts {
  bindings: Array<Record<string, unknown>>;
  partitions: number;
  identities: string[];
}

async function readSelectionFacts(
  client: Client,
  businessId: string,
): Promise<SelectionFacts> {
  const bindings = await client.query(
    `SELECT provider_account_id, is_selected, position
     FROM business_provider_accounts
     WHERE business_id = $1 AND provider = $2
     ORDER BY provider_account_id`,
    [businessId, PROVIDER],
  );
  const partitions = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM meta_sync_partitions WHERE business_id = $1`,
    [businessId],
  );
  const identities = await client.query<{ external_account_id: string }>(
    `SELECT external_account_id FROM provider_accounts
     WHERE provider = $1 ORDER BY external_account_id`,
    [PROVIDER],
  );
  return {
    bindings: bindings.rows,
    partitions: Number(partitions.rows[0]!.count),
    identities: identities.rows.map((row) => row.external_account_id),
  };
}

async function readSelected(client: Client, businessId: string) {
  const rows = await client.query<{ provider_account_id: string }>(
    `SELECT provider_account_id FROM business_provider_accounts
     WHERE business_id = $1 AND provider = $2 AND is_selected
     ORDER BY position, id`,
    [businessId, PROVIDER],
  );
  return rows.rows.map((row) => row.provider_account_id);
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-selection-race-"));
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
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED = "enabled";
    // Generous, because two of the proofs below deliberately make the writer
    // WAIT on a row lock. A short timeout would turn the thing being proven
    // into a timeout error.
    process.env.DB_QUERY_TIMEOUT_MS = "20000";

    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "selection_race_seam" });

    const {
      ProviderAccountSelectionError,
      readProviderSelectionAuthority,
      replaceProviderAccountSelection,
      withProviderAccountSelectionLock,
    } = await import("@/lib/provider-account-assignments");

    client = new Client({ connectionString });
    await client.connect();
    // A SECOND connection, because the races this seam is about are between
    // separate database sessions. Running them on one connection would serialise
    // them for free and prove nothing.
    raceClient = new Client({ connectionString });
    await raceClient.connect();

    const owner = await client.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       VALUES ('Selection race', 'selection-race@example.invalid', 'unused')
       RETURNING id::text AS id`,
    );
    const business = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id) VALUES ('Selection race seam', $1::uuid)
       RETURNING id::text AS id`,
      [owner.rows[0]!.id],
    );
    const businessId = business.rows[0]!.id;

    const connection = await client.query<{ id: string }>(
      `INSERT INTO provider_connections (business_id, provider, status, connected_at)
       VALUES ($1, $2, 'connected', now())
       RETURNING id::text AS id`,
      [businessId, PROVIDER],
    );
    await client.query(
      `INSERT INTO integration_credentials (provider_connection_id, access_token, scopes)
       VALUES ($1::uuid, 'seam-access-token', 'ads_read')`,
      [connection.rows[0]!.id],
    );

    /** Write a discovery snapshot revision, exactly as a refresh would. */
    async function writeSnapshot(
      target: Client,
      accounts: string[],
      accountsHash: string,
      fingerprint: string,
    ) {
      const run = await target.query<{ id: string }>(
        `INSERT INTO provider_account_snapshot_runs
           (business_id, provider, fetched_at, accounts_hash, connection_fingerprint)
         VALUES ($1, $2, now(), $3, $4)
         ON CONFLICT (business_id, provider) DO UPDATE SET
           fetched_at = now(),
           accounts_hash = EXCLUDED.accounts_hash,
           connection_fingerprint = EXCLUDED.connection_fingerprint,
           updated_at = now()
         RETURNING id::text AS id`,
        [businessId, PROVIDER, accountsHash, fingerprint],
      );
      const runId = run.rows[0]!.id;
      await target.query(
        `DELETE FROM provider_account_snapshot_items WHERE snapshot_run_id = $1::uuid`,
        [runId],
      );
      for (const [index, accountId] of accounts.entries()) {
        await target.query(
          `INSERT INTO provider_account_snapshot_items
             (snapshot_run_id, provider_account_id, provider_account_name, position)
           VALUES ($1::uuid, $2, $3, $4)`,
          [runId, accountId, `Account ${accountId}`, index],
        );
      }
      return runId;
    }

    await writeSnapshot(
      client,
      ["act_1", "act_2", "act_3"],
      "hash-original",
      "fingerprint-original",
    );

    /**
     * One selection request, in the order the service performs it.
     *
     * Capture the authority, validate the requested ids against the discovery
     * snapshot, write, and only then enqueue. `duringWindow` runs between
     * validation and the write — which is the window every defect here lived in.
     */
    async function attemptSelection(input: {
      accountIds: string[];
      duringWindow?: () => Promise<void>;
    }): Promise<
      | { ok: true; saved: string[]; enqueued: number }
      | { ok: false; code: string; enqueued: 0 }
    > {
      const authority = await readProviderSelectionAuthority(
        businessId,
        PROVIDER,
      );

      // Validation reads the snapshot the authority was captured from, on its
      // own connection, exactly as the request handler does.
      const snapshot = await client!.query<{ provider_account_id: string }>(
        `SELECT item.provider_account_id
         FROM provider_account_snapshot_items item
         JOIN provider_account_snapshot_runs run ON run.id = item.snapshot_run_id
         WHERE run.business_id = $1 AND run.provider = $2`,
        [businessId, PROVIDER],
      );
      const known = new Set(snapshot.rows.map((row) => row.provider_account_id));
      const unknown = input.accountIds.filter((accountId) => !known.has(accountId));
      assert(
        unknown.length === 0,
        `validation should have admitted every requested id, but ${unknown.join(", ")} was not in the snapshot`,
      );

      if (input.duringWindow) await input.duringWindow();

      try {
        const outcome = await replaceProviderAccountSelection({
          businessId,
          provider: PROVIDER,
          accountIds: input.accountIds,
          expectedConnectionGeneration: authority.connectionGeneration,
          expectedSnapshotRevision: authority.snapshotRevision,
        });
        // Enqueue happens ONLY after a durable, verified selection. A refusal
        // must never reach this line.
        for (const accountId of outcome.accountIds) {
          await client!.query(
            `INSERT INTO meta_sync_partitions
               (business_id, provider_account_id, lane, scope, partition_date)
             VALUES ($1, $2, 'core', 'insights', CURRENT_DATE)
             ON CONFLICT DO NOTHING`,
            [businessId, accountId],
          );
        }
        return {
          ok: true,
          saved: outcome.accountIds,
          enqueued: outcome.accountIds.length,
        };
      } catch (error) {
        if (error instanceof ProviderAccountSelectionError) {
          return { ok: false, code: error.code, enqueued: 0 };
        }
        throw error;
      }
    }

    // ── S1: the uncontended path, so the counters below mean something ───────
    const first = await attemptSelection({ accountIds: ["act_1", "act_2"] });
    assert(first.ok, "S1: an uncontended selection was refused.");
    assert(
      JSON.stringify(first.saved) === JSON.stringify(["act_1", "act_2"]),
      `S1: the readback did not match the request: ${JSON.stringify(first.saved)}`,
    );
    const baseline = await readSelectionFacts(client, businessId);
    assert(
      baseline.partitions === 2,
      `S1: expected 2 partitions from the successful enqueue, found ${baseline.partitions}.`,
    );
    console.log(
      `${LABEL} S1 PASS uncontended selection: [${first.saved.join(", ")}] durably selected and ${baseline.partitions} partitions enqueued, so a later count of ${baseline.partitions} proves a refusal enqueued nothing`,
    );

    // ── S2: a reconnect between validation and the write ─────────────────────
    //
    // Written out step by step rather than through `attemptSelection`, because
    // the reconnect is deliberately left UNCOMMITTED while the writer runs: the
    // writer must block on the connection row lock, which means nothing can
    // await it until the reconnect commits.
    //
    // Without `FOR UPDATE` the writer would read the pre-reconnect generation,
    // match it, and commit a selection validated against a credential that was
    // already being replaced.
    const authorityBeforeReconnect = await readProviderSelectionAuthority(
      businessId,
      PROVIDER,
    );
    await raceClient.query("BEGIN");
    await raceClient.query(
      `UPDATE provider_connections
       SET connection_generation = connection_generation + 1, updated_at = now()
       WHERE business_id = $1 AND provider = $2`,
      [businessId, PROVIDER],
    );
    const blockedWriter = replaceProviderAccountSelection({
      businessId,
      provider: PROVIDER,
      accountIds: ["act_1", "act_2", "act_3"],
      expectedConnectionGeneration: authorityBeforeReconnect.connectionGeneration,
      expectedSnapshotRevision: authorityBeforeReconnect.snapshotRevision,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    assert(
      await stillPending(blockedWriter, 750),
      "S2: the writer did not wait for the uncommitted reconnect, so it never took the connection row lock — it read a generation that was already being replaced.",
    );
    await raceClient.query("COMMIT");
    const blockedResult = await blockedWriter;
    assert(
      !blockedResult.ok &&
        blockedResult.error instanceof ProviderAccountSelectionError &&
        blockedResult.error.code === "connection_generation_changed",
      `S2: the writer did not refuse after the reconnect committed: ${JSON.stringify(blockedResult)}`,
    );
    const afterReconnect = await readSelectionFacts(client, businessId);
    assert(
      JSON.stringify(afterReconnect) === JSON.stringify(baseline),
      `S2: the refusal changed durable state.\nbefore=${JSON.stringify(baseline)}\nafter=${JSON.stringify(afterReconnect)}`,
    );
    assert(
      afterReconnect.partitions === baseline.partitions,
      `S2: the refusal enqueued work: ${afterReconnect.partitions} partitions, expected ${baseline.partitions}.`,
    );
    assert(
      !afterReconnect.identities.includes("act_3"),
      "S2: the refusal still created the identity row for the account it refused to select.",
    );
    console.log(
      `${LABEL} S2 PASS reconnect between validation and write: the writer BLOCKED on the connection row lock for the whole time the reconnect was uncommitted, then refused with connection_generation_changed — 0 selection rows changed, 0 identities created, ${afterReconnect.partitions} partitions unchanged`,
    );

    // ── S3: a discovery refresh between validation and the write ─────────────
    //
    // The credential does not move at all here. Same connection, same
    // generation, a new account list — the case the generation check cannot see.
    const snapshotRefusal = await attemptSelection({
      accountIds: ["act_1", "act_2"],
      duringWindow: async () => {
        await writeSnapshot(
          raceClient!,
          ["act_1"],
          "hash-after-revocation",
          "fingerprint-original",
        );
      },
    });
    assert(
      !snapshotRefusal.ok && snapshotRefusal.code === "snapshot_revision_changed",
      `S3: a selection validated against a replaced account list was not refused: ${JSON.stringify(snapshotRefusal)}`,
    );
    const afterSnapshot = await readSelectionFacts(client, businessId);
    assert(
      JSON.stringify(afterSnapshot.bindings) === JSON.stringify(baseline.bindings) &&
        afterSnapshot.partitions === baseline.partitions,
      `S3: the refusal changed durable state.\nbefore=${JSON.stringify(baseline)}\nafter=${JSON.stringify(afterSnapshot)}`,
    );
    console.log(
      `${LABEL} S3 PASS snapshot replaced under an UNCHANGED credential: the generation still matched and the write was refused anyway with snapshot_revision_changed — 0 selection rows changed, ${afterSnapshot.partitions} partitions unchanged`,
    );

    // Put the snapshot back so the concurrency proof below is about the lock and
    // nothing else.
    await writeSnapshot(
      client,
      ["act_1", "act_2", "act_3"],
      "hash-restored",
      "fingerprint-original",
    );

    // ── S4: two concurrent replacements for the same business ────────────────
    //
    // Both are valid at the moment they start. The advisory lock must make them
    // serialise, and each caller's readback — taken inside its own transaction —
    // must describe its own write rather than the other's.
    const authorityForConcurrency = await readProviderSelectionAuthority(
      businessId,
      PROVIDER,
    );
    const setA = ["act_1", "act_3"];
    const setB = ["act_2"];
    const [outcomeA, outcomeB] = await Promise.all([
      replaceProviderAccountSelection({
        businessId,
        provider: PROVIDER,
        accountIds: setA,
        expectedConnectionGeneration: authorityForConcurrency.connectionGeneration,
        expectedSnapshotRevision: authorityForConcurrency.snapshotRevision,
      }),
      replaceProviderAccountSelection({
        businessId,
        provider: PROVIDER,
        accountIds: setB,
        expectedConnectionGeneration: authorityForConcurrency.connectionGeneration,
        expectedSnapshotRevision: authorityForConcurrency.snapshotRevision,
      }),
    ]);
    assert(
      JSON.stringify(outcomeA.accountIds) === JSON.stringify(setA),
      `S4: caller A was told it selected ${JSON.stringify(outcomeA.accountIds)} instead of ${JSON.stringify(setA)} — its readback described the other transaction's write.`,
    );
    assert(
      JSON.stringify(outcomeB.accountIds) === JSON.stringify(setB),
      `S4: caller B was told it selected ${JSON.stringify(outcomeB.accountIds)} instead of ${JSON.stringify(setB)}.`,
    );
    assert(
      JSON.stringify(outcomeA.assignment.account_ids) ===
        JSON.stringify(outcomeA.accountIds) &&
        JSON.stringify(outcomeB.assignment.account_ids) ===
          JSON.stringify(outcomeB.accountIds),
      "S4: the reported assignment row disagreed with the verified readback, which is the second unsynchronised read this replaces.",
    );
    const durableAfterConcurrency = await readSelected(client, businessId);
    const matchesA = JSON.stringify(durableAfterConcurrency) === JSON.stringify(setA);
    const matchesB = JSON.stringify(durableAfterConcurrency) === JSON.stringify(setB);
    assert(
      matchesA !== matchesB,
      `S4: the durable selection is neither caller's set — the two replacements interleaved: ${JSON.stringify(durableAfterConcurrency)}`,
    );
    console.log(
      `${LABEL} S4 PASS two concurrent replacements: both committed, each caller's in-transaction readback described its OWN write, and the durable selection is exactly one of them ([${durableAfterConcurrency.join(", ")}]) rather than a mix`,
    );

    // ── S5: a database failure part-way through the write ────────────────────
    //
    // The identity row and the binding upsert run before the deselect. A failure
    // after them must leave NOTHING — not a new identity, not a half-applied
    // selection — or the next request would see accounts the user never chose.
    const beforeFailure = await readSelectionFacts(client, businessId);
    await client.query(`
      CREATE OR REPLACE FUNCTION seam_fail_selection() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'seam injected failure during selection';
      END
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER seam_fail_selection_trigger
      BEFORE UPDATE ON business_provider_accounts
      FOR EACH ROW EXECUTE FUNCTION seam_fail_selection()
    `);
    const authorityForFailure = await readProviderSelectionAuthority(
      businessId,
      PROVIDER,
    );
    let failureMessage = "";
    try {
      await replaceProviderAccountSelection({
        businessId,
        provider: PROVIDER,
        accountIds: ["act_1", "act_2", "act_new"],
        expectedConnectionGeneration: authorityForFailure.connectionGeneration,
        expectedSnapshotRevision: authorityForFailure.snapshotRevision,
      });
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    }
    await client.query(
      `DROP TRIGGER seam_fail_selection_trigger ON business_provider_accounts`,
    );
    assert(
      failureMessage.includes("seam injected failure"),
      `S5: the injected database failure did not reach the caller: ${failureMessage || "no error at all"}`,
    );
    const afterFailure = await readSelectionFacts(client, businessId);
    assert(
      JSON.stringify(afterFailure) === JSON.stringify(beforeFailure),
      `S5: a failed write left durable changes behind.\nbefore=${JSON.stringify(beforeFailure)}\nafter=${JSON.stringify(afterFailure)}`,
    );
    assert(
      !afterFailure.identities.includes("act_new"),
      "S5: the identity row created before the failure survived the rollback, so a later selection would resolve an account this request never committed.",
    );
    console.log(
      `${LABEL} S5 PASS failure part-way through the write: the error reached the caller and the rollback left no new identity, no changed binding and no partition — durable state byte-identical to before`,
    );

    // ── S6: the exported lock the OAuth post-connect path needs ──────────────
    //
    // Post-connect narrowing reads the previous selection, discovers what the new
    // grant can reach, and writes the intersection. Only its final write was
    // serialised, so a selection the user saved during that discovery was read as
    // "previous" and then overwritten. Holding this lock across the whole
    // sequence makes the concurrent replacement WAIT instead.
    const lockObservations: string[] = [];
    let signalLockTaken: () => void = () => undefined;
    let releaseHolder: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      signalLockTaken = resolve;
    });
    const holderMayFinish = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = withProviderAccountSelectionLock({
      businessId,
      provider: PROVIDER,
      work: async () => {
        signalLockTaken();
        await holderMayFinish;
        lockObservations.push("holder");
      },
    });
    await lockTaken;

    // Started OUTSIDE the holder's callback on purpose: the transaction context
    // is async-local, so a replacement kicked off from INSIDE would join the
    // holder's own transaction and prove nothing about contention.
    const authorityForLock = await readProviderSelectionAuthority(
      businessId,
      PROVIDER,
    );
    const concurrent = replaceProviderAccountSelection({
      businessId,
      provider: PROVIDER,
      accountIds: ["act_2"],
      expectedConnectionGeneration: authorityForLock.connectionGeneration,
      expectedSnapshotRevision: authorityForLock.snapshotRevision,
    }).then(
      () => {
        lockObservations.push("concurrent");
        return "committed" as const;
      },
      (error: unknown) => {
        lockObservations.push("concurrent");
        return error instanceof Error ? error.message : String(error);
      },
    );
    assert(
      await stillPending(concurrent, 500),
      "S6: a concurrent replacement ran straight through the held selection lock.",
    );
    releaseHolder();
    await holder;
    const concurrentResult = await concurrent;
    assert(
      concurrentResult === "committed",
      `S6: the concurrent replacement failed once it got the lock: ${String(concurrentResult)}`,
    );
    assert(
      JSON.stringify(lockObservations) === JSON.stringify(["holder", "concurrent"]),
      `S6: the concurrent replacement did not wait for the lock holder: ${JSON.stringify(lockObservations)}`,
    );
    console.log(
      `${LABEL} S6 PASS exported selection lock: a concurrent replacement blocked for the whole time withProviderAccountSelectionLock held it, so an OAuth post-connect read-decide-write can no longer overwrite a selection saved underneath it`,
    );

    // ── S7: a foreign principal must not inherit the previous one's account ──
    //
    // `provider_account_id` was `COALESCE(EXCLUDED, existing)`, so a caller that
    // named no account kept whatever was there — and the Search Console and GA4
    // callbacks legitimately name none. A reconnect as a different Google user
    // therefore replaced the metadata, clearing `metadata.siteUrl`, and left the
    // PREVIOUS principal's site sitting in `provider_account_id`, which
    // `resolveSearchConsoleContext` falls back to. Every later sync then ran
    // against the old principal's property under the new principal's token.
    //
    // The recorded principal is now cleared on exactly the same evidence the
    // refresh token is: a credential arrived, and nothing proved it belongs to
    // the same principal.
    {
      // Provider secrets are encrypted at rest; the writer refuses without a
      // key rather than storing plaintext, so the seam supplies one.
      process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY =
        process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ??
        "selection-race-seam-encryption-key";
      const { upsertIntegration, getIntegration } = await import(
        "@/lib/integrations"
      );
      const google = await upsertIntegration({
        businessId,
        provider: "google",
        status: "connected",
        providerAccountId: "1234567890",
        providerAccountName: "First principal",
        accessToken: "s7-google-token",
        refreshToken: "s7-google-refresh",
      });
      await upsertIntegration({
        businessId,
        provider: "search_console",
        status: "connected",
        providerAccountId: "sc-domain:first-principal.example",
        providerAccountName: "sc-domain:first-principal.example",
        accessToken: "s7-sc-token",
        refreshToken: "s7-sc-refresh",
        metadata: { siteUrl: "sc-domain:first-principal.example" },
        expectedDerivedAuthority: {
          provider: "google",
          connectionGeneration: `${google.connection_generation ?? 1}:${google.status}`,
        },
      });

      const before = await getIntegration(businessId, "search_console");
      assert(
        before?.provider_account_id === "sc-domain:first-principal.example",
        `S7: fixture did not record the first principal's site (${String(before?.provider_account_id)}).`,
      );

      // The real Search Console connect-time write: a new credential, and no
      // account id at all.
      await upsertIntegration({
        businessId,
        provider: "search_console",
        status: "connected",
        accessToken: "s7-sc-token-second-principal",
        metadata: { connectedAt: new Date(0).toISOString() },
      });

      const after = await getIntegration(businessId, "search_console");
      const resurrectedSite =
        (after?.metadata as Record<string, unknown> | undefined)?.siteUrl ??
        after?.provider_account_id ??
        null;
      assert(
        resurrectedSite === null,
        `S7: a reconnect by a different principal left the previous principal's site reachable as "${String(resurrectedSite)}"; resolveSearchConsoleContext falls back to provider_account_id, so every later sync would run against it.`,
      );
      assert(
        after?.provider_account_name == null,
        `S7: the previous principal's account NAME survived the reconnect (${String(after?.provider_account_name)}).`,
      );

      // ...and a genuine same-principal token refresh must NOT clear it.
      await upsertIntegration({
        businessId,
        provider: "google",
        status: "connected",
        accessToken: "s7-google-token-refreshed",
        refreshToken: "s7-google-refresh",
        samePrincipal: true,
      });
      const googleAfter = await getIntegration(businessId, "google");
      assert(
        googleAfter?.provider_account_id === "1234567890",
        `S7: a declared same-principal token refresh cleared the account id (${String(googleAfter?.provider_account_id)}); routine refreshes would force a reconnect.`,
      );
      console.log(
        `${LABEL} S7 PASS foreign principal: a reconnect that supplies a credential and names no account clears the recorded principal — site and name both gone, with nothing left for the metadata fallback to resurrect — while a declared same-principal refresh keeps it`,
      );
    }

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
    await raceClient?.query("ROLLBACK").catch(() => undefined);
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
